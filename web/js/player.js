// StreamPlayer: owns one <video>, one hls.js instance and one server proxy
// session. Used by the single-player view and by every multiview tile.
//
// Lifecycle:  start() -> POST /api/play -> attach hls.js to /proxy/<sid>/master.m3u8
//             -> (errors) recover: startLoad / recoverMediaError / fresh session
//             -> stop()/destroy() -> DELETE /api/play/<sid>
import { api, ApiError, supportedCodecs } from './api.js';
import { sleep } from './ui.js';

const Hls = window.Hls;
const all = new Set();
window.addEventListener('pagehide', () => all.forEach((p) => p.releaseSession()));

const levelUri = (l) => l.uri || (Array.isArray(l.url) ? l.url[l.urlId || 0] : l.url) || '';
export function levelKey(level) {
  try { return new URL(levelUri(level), location.href).searchParams.get('n') || ''; } catch { return ''; }
}

/**
 * Policies decide which hls.js level is used:
 *  {type:'chosen'}            the rendition the server picked (best match for the requested quality)
 *  {type:'cap', height}       best rendition at or below `height` (unfocused tiles)
 *  {type:'lock', key}         a specific rendition chosen by the user
 *  {type:'audio'}             audio-only rendition
 *  {type:'auto'}              hls.js adaptive bitrate
 */
export function levelIndexFor(levels, policy, meta) {
  const quality = meta?.quality;
  const byKey = new Map((quality?.variants ?? []).map((v) => [v.key, v]));
  const info = levels.map((l, index) => {
    const key = levelKey(l);
    const v = byKey.get(key);
    return { index, key, height: l.height || v?.height || 0, bitrate: l.bitrate || v?.bandwidth || 0, audio: v ? v.audioOnly : !l.height };
  });
  const video = info.filter((l) => !l.audio);
  const top = (list) => list.reduce((a, b) => (b.bitrate > (a?.bitrate ?? -1) ? b : a), null);

  switch (policy?.type) {
    case 'auto': return -1;
    case 'audio': return info.find((l) => l.audio)?.index ?? -1;
    case 'lock': return info.find((l) => l.key === policy.key)?.index ?? top(video)?.index ?? -1;
    case 'cap': {
      const under = video.filter((l) => l.height && l.height <= policy.height);
      if (under.length) return top(under).index;
      return video.reduce((a, b) => (!a || b.bitrate < a.bitrate ? b : a), null)?.index ?? -1;
    }
    case 'chosen':
    default:
      return (quality ? info.find((l) => l.key === quality.key) : null)?.index ?? top(video)?.index ?? -1;
  }
}

export class StreamPlayer extends EventTarget {
  /**
   * @param {HTMLElement} host element the <video> is prepended to
   * @param {{mode?: 'single'|'tile', getSettings?: () => object}} o
   */
  constructor(host, { mode = 'single', getSettings = () => ({}) } = {}) {
    super();
    this.host = host;
    this.mode = mode;
    this.getSettings = getSettings;
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.setAttribute('aria-label', 'Stream player');
    host.prepend(this.video);

    this.state = 'idle';
    this.error = '';
    this.meta = null;
    this.input = null;
    this.opts = {};
    this.policy = { type: 'chosen' };
    this.events = [];
    this.gen = 0;
    this.hls = null;
    this.es = null;
    this.sessionId = null;
    this.netRetries = 0;
    this.mediaRetries = 0;
    this.recoveries = [];
    this.active = true;
    this.paused = false;

    const v = this.video;
    v.addEventListener('waiting', () => this._buffering(true));
    v.addEventListener('playing', () => { this._buffering(false); this._setState('playing'); });
    v.addEventListener('canplay', () => this._buffering(false));
    v.addEventListener('pause', () => this._emit('stats', this.stats()));
    v.addEventListener('volumechange', () => this._emit('volume', { muted: v.muted, volume: v.volume }));
    v.addEventListener('ended', () => this._onEnded());
    v.addEventListener('error', () => { if (this.meta?.type === 'mp4' && v.error) this._fail(new Error('Could not play this clip')); });
    this.timer = setInterval(() => { if (this.state === 'playing' || this.state === 'buffering') this._emit('stats', this.stats()); }, 1000);
    all.add(this);
  }

  _emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  _setState(state) {
    if (state === this.state) return;
    this.state = state;
    this._emit('state', state);
  }
  _buffering(on) {
    if (on && this.state === 'playing') this._setState('buffering');
    else if (!on && this.state === 'buffering') this._setState('playing');
  }

  // ---- public API ------------------------------------------------------
  async start(input, opts = {}, isRecovery = false) {
    this._teardown();
    this.input = input;
    this.opts = { ...this.opts, ...opts };
    this.error = '';
    const gen = ++this.gen;
    if (!isRecovery) { this.recoveries = []; this.events = []; }
    this.netRetries = this.mediaRetries = 0;
    this._setState('loading');

    const s = this.getSettings();
    const o = this.opts;
    let meta;
    try {
      meta = await api('/api/play', {
        method: 'POST',
        body: {
          input,
          quality: o.quality ?? s.quality ?? null,
          adblock: o.adblock ?? s.adblock,
          audioOnly: o.audioOnly ?? s.audioOnly ?? false,
          lowLatency: o.lowLatency ?? s.lowLatency ?? false,
          codecs: supportedCodecs(),
        },
      });
    } catch (e) {
      if (gen === this.gen) this._fail(e);
      return;
    }
    if (gen !== this.gen) { // superseded while the request was in flight
      if (meta.sessionId) this._deleteSession(meta.sessionId);
      return;
    }
    this.meta = meta;
    if (meta.status === 'offline') { this._setState('offline'); this._emit('meta', meta); return; }

    this.sessionId = meta.sessionId;
    this._emit('meta', meta);
    if (meta.sessionId) this._openEvents(meta.sessionId);
    this._attach(meta);
  }

  stop() {
    this.gen++;
    this._teardown();
    this.meta = null;
    this._setState('idle');
  }

  destroy() {
    this.stop();
    clearInterval(this.timer);
    all.delete(this);
    this.video.remove();
  }

  reload() { return this.input ? this.start(this.input, this.opts) : undefined; }

  setPolicy(policy) {
    this.policy = policy;
    this._applyPolicy(false);
    this._emit('stats', this.stats());
  }

  setMuted(m) { this.video.muted = !!m; }
  setVolume(v) { this.video.volume = Math.min(1, Math.max(0, v)); if (v > 0) this.video.muted = false; }

  pause() { this.paused = true; this.video.pause(); }
  play() { this.paused = false; return this.video.play().catch(() => {}); }
  togglePause() { return this.video.paused ? this.play() : this.pause(); }

  jumpToLive() {
    const v = this.video;
    this.setDvr(false);
    if (this.hls?.liveSyncPosition) v.currentTime = this.hls.liveSyncPosition;
    else if (v.seekable.length) v.currentTime = v.seekable.end(v.seekable.length - 1) - 0.5;
    else if (v.buffered.length) v.currentTime = v.buffered.end(v.buffered.length - 1) - 0.5;
    if (!this.paused) v.play().catch(() => {});
  }

  /**
   * While the viewer is rewound in a live stream, stop hls.js from snapping
   * back to the live edge or speeding playback up to catch up.
   */
  setDvr(on) {
    const hls = this.hls;
    if (!hls || !this._dvrBase) return;
    hls.config.liveMaxLatencyDurationCount = on ? Infinity : this._dvrBase.maxLat;
    hls.config.maxLiveSyncPlaybackRate = on ? 1 : this._dvrBase.rate;
    if (on) this.video.playbackRate = 1;
  }

  /** Stop/resume network activity (offscreen tiles). */
  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    if (!this.hls) return;
    if (active) { this.hls.startLoad(-1); if (!this.paused) this.video.play().catch(() => {}); } else this.hls.stopLoad();
  }

  /** Renditions the user can pick, best first. */
  levels() {
    if (!this.hls) return [];
    const byKey = new Map((this.meta?.quality?.variants ?? []).map((v) => [v.key, v]));
    return this.hls.levels.map((l, index) => {
      const key = levelKey(l);
      const v = byKey.get(key);
      const audioOnly = v ? v.audioOnly : !l.height;
      const label = v ? (audioOnly ? 'Audio only' : `${v.label} · ${v.family}`) : `${l.height || '?'}p`;
      return { index, key, label, height: l.height || v?.height || 0, bitrate: l.bitrate || 0, audioOnly };
    }).sort((a, b) => (a.audioOnly - b.audioOnly) || (b.height - a.height) || (b.bitrate - a.bitrate));
  }

  currentLevelInfo() {
    if (!this.hls) return null;
    const idx = this.hls.currentLevel >= 0 ? this.hls.currentLevel : this.hls.loadLevel;
    return this.levels().find((l) => l.index === idx) ?? null;
  }

  stats() {
    const v = this.video;
    let latency = null;
    if (this.hls) {
      latency = Number.isFinite(this.hls.latency) && this.hls.latency > 0 ? this.hls.latency
        : (this.hls.liveSyncPosition ? this.hls.liveSyncPosition - v.currentTime : null);
    }
    return {
      latency: latency !== null && Number.isFinite(latency) ? Math.max(0, latency) : null,
      buffering: this.state === 'buffering',
      paused: v.paused,
      level: this.currentLevelInfo(),
    };
  }

  // ---- internals -------------------------------------------------------
  _attach(meta) {
    const v = this.video;
    const url = meta.playbackUrl;
    const o = this.opts;
    const s = this.getSettings();

    if (meta.type === 'mp4') {
      v.src = url;
      this._play();
      return;
    }

    if (Hls?.isSupported()) {
      const low = !!(o.lowLatency ?? s.lowLatency);
      const hls = new Hls({
        lowLatencyMode: low,
        enableWorker: true,
        capLevelToPlayerSize: this.mode === 'tile' && this.policy.type === 'auto',
        maxBufferLength: s.cache ? (s.bufferSeconds || 30) : (low ? 8 : 20),
        // Keep played data so the user can rewind (live DVR) without refetching.
        backBufferLength: this.mode === 'tile' ? 30 : (meta.kind === 'live' ? 300 : 60),
        liveSyncDurationCount: low ? 2 : 3,
        liveMaxLatencyDurationCount: low ? 5 : 10,
        maxLiveSyncPlaybackRate: low ? 1.15 : 1,
        autoStartLoad: this.active,
      });
      this.hls = hls;
      this._dvrBase = { maxLat: hls.config.liveMaxLatencyDurationCount, rate: hls.config.maxLiveSyncPlaybackRate };
      hls.on(Hls.Events.MANIFEST_PARSED, () => { this._applyPolicy(true); this._emit('levels', this.levels()); });
      hls.on(Hls.Events.LEVEL_SWITCHED, () => this._emit('stats', this.stats()));
      hls.on(Hls.Events.FRAG_LOADED, () => { this.netRetries = 0; this.mediaRetries = 0; });
      hls.on(Hls.Events.ERROR, (_e, d) => this._onHlsError(d));
      hls.loadSource(url);
      hls.attachMedia(v);
      this._play();
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url; // Safari: native HLS
      this._play();
    } else {
      this._fail(new Error('This browser cannot play HLS streams'));
    }
  }

  _play() {
    if (!this.active) return;
    this.video.play().catch(() => {
      // Autoplay with sound was blocked: fall back to muted playback.
      this.video.muted = true;
      this._emit('volume', { muted: true, volume: this.video.volume, blocked: true });
      this.video.play().catch(() => {});
    });
  }

  _applyPolicy(initial) {
    const hls = this.hls;
    if (!hls || !hls.levels?.length) return;
    const idx = levelIndexFor(hls.levels, this.policy, this.meta);
    try {
      if (this.policy.type === 'auto' || idx < 0) { hls.nextLevel = -1; hls.autoLevelCapping = -1; return; }
      if (initial) { hls.startLevel = idx; hls.currentLevel = idx; } else { hls.nextLevel = idx; }
    } catch { /* level switching is best-effort */ }
  }

  _onHlsError(d) {
    if (!d.fatal) return;
    const hls = this.hls;
    if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (++this.netRetries <= 3 && hls) { hls.startLoad(); return; }
      this._recover('network error');
    } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (++this.mediaRetries <= 2 && hls) { hls.recoverMediaError(); return; }
      this._recover('media error');
    } else {
      this._recover(d.details || 'fatal error');
    }
  }

  _onEnded() {
    if (this.meta?.kind === 'live') this._recover('stream ended');
    else this._emit('ended');
  }

  /** Check whether the channel is offline; otherwise rebuild with a fresh proxy session. */
  async _recover(reason) {
    const now = Date.now();
    this.recoveries = this.recoveries.filter((t) => now - t < 60_000);
    this.recoveries.push(now);
    const gen = this.gen;
    const meta = this.meta;
    if (this.recoveries.length > 3) { this._fail(new Error(`Playback keeps failing (${reason}).`)); return; }

    if (meta?.kind === 'live' && meta.channel) {
      try {
        const info = await api(`/api/stream/${encodeURIComponent(meta.channel)}/info`);
        if (gen !== this.gen) return;
        if (!info.online) {
          this._teardown();
          this.meta = { status: 'offline', channel: info.login, displayName: info.displayName, userId: info.userId, kind: 'live' };
          this._setState('offline');
          this._emit('meta', this.meta);
          return;
        }
      } catch { /* if the check itself fails, just retry */ }
    }
    this._setState('loading');
    await sleep(800);
    if (gen !== this.gen) return;
    await this.start(this.input, this.opts, true);
  }

  _fail(e) {
    this._teardown();
    this.error = e instanceof ApiError || e instanceof Error ? e.message : String(e);
    this.errorCode = e?.code;
    this._setState('error');
    this._emit('error', e);
  }

  _openEvents(sid) {
    const es = new EventSource(`/api/play/${sid}/events`);
    es.addEventListener('session', (e) => {
      try {
        const ev = JSON.parse(e.data);
        this.events.push(ev);
        if (this.events.length > 100) this.events.shift();
        this._emit('session', ev);
      } catch { /* ignore */ }
    });
    this.es = es;
  }

  _deleteSession(sid) {
    fetch(`/api/play/${sid}`, { method: 'DELETE', keepalive: true }).catch(() => {});
  }

  releaseSession() {
    if (this.sessionId) { this._deleteSession(this.sessionId); this.sessionId = null; }
  }

  _teardown() {
    if (this.hls) { try { this.hls.destroy(); } catch { /* ignore */ } this.hls = null; }
    if (this.es) { this.es.close(); this.es = null; }
    this.releaseSession();
    const v = this.video;
    v.pause();
    v.removeAttribute('src');
    v.load();
  }
}

// Proxy sessions: one per playing stream (tile). Holds the proxy instance,
// an event log (streamed to the UI via SSE) and idle bookkeeping.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { codecFamily, describeVariants, isAudioOnlyVariant, parseMasterMedia, parseMasterVariants, renderMaster, rewritePlaylist, selectVariant, variantKey, variantLabel } from './hlsLogic.js';
import { log } from './log.js';

export const LIVE_IDLE_MS = 60_000;
export const VOD_IDLE_MS = 15 * 60_000;
const MAX_SESSIONS = 16;

export class Session extends EventEmitter {
  constructor({ kind, channel, proxy, idleMs, segmentMode, meta }) {
    super();
    this.id = crypto.randomBytes(16).toString('hex');
    this.kind = kind; // 'live' | 'vod'
    this.channel = channel;
    this.proxy = proxy;
    this.idleMs = idleMs;
    this.segmentMode = segmentMode; // 'proxy' | 'direct'
    this.meta = meta;
    this.createdAt = Date.now();
    this.lastSeen = Date.now();
    this.events = [];
    this.streams = 0; // open SSE connections
  }

  touch() { this.lastSeen = Date.now(); }

  emitEvent(level, message) {
    const ev = { ts: Date.now(), level, message };
    this.events.push(ev);
    if (this.events.length > 100) this.events.shift();
    log.debug(`[session ${this.id.slice(0, 6)}] ${message}`);
    this.emit('event', ev);
  }

  /** URL wrapper for upstream URIs found in playlists. */
  wrap() {
    return this.segmentMode === 'proxy' ? (abs) => `segment?u=${encodeURIComponent(abs)}` : (abs) => abs;
  }
}

/**
 * Master handling for VOD and non-adblock live: no token rotation, but we
 * still apply quality selection and rewrite URIs so the browser can fetch them.
 */
export class PassthroughProxy {
  constructor({ twitch, masterUrl, quality, allowedCodecs, onEvent, wrap }) {
    this.twitch = twitch;
    this.masterUrl = masterUrl;
    this.quality = quality;
    this.allowedCodecs = allowedCodecs;
    this.onEvent = onEvent;
    this.wrap = wrap;
    this.info = null;
  }

  async buildMaster() {
    const text = await this.twitch.fetchText(this.masterUrl);
    if (!text) return { code: 502, body: 'could not fetch master playlist' };

    let variants = parseMasterVariants(text);
    if (this.allowedCodecs) {
      variants = variants.filter((v) => isAudioOnlyVariant(v) || ['?', ...this.allowedCodecs].includes(codecFamily(v)));
    }
    if (!variants.length) return { code: 200, body: rewritePlaylist(text, this.masterUrl, this.wrap) };

    const chosen = selectVariant(variants, this.quality, (m) => this.onEvent('warn', m));
    if (!chosen) return { code: 502, body: 'requested quality is not available' };

    const abs = (u) => new URL(u, this.masterUrl).toString();
    const media = parseMasterMedia(text).map((l) => rewritePlaylist(l, this.masterUrl, this.wrap));
    const ordered = [chosen, ...variants.filter((v) => v !== chosen && v.bandwidth <= chosen.bandwidth)];
    const label = variantLabel(chosen);
    this.info = { chosenKey: variantKey(chosen), chosenLabel: label, family: codecFamily(chosen), flavor: null, variants: describeVariants(ordered) };
    this.onEvent('info', `Serving '${label}' (no ad filtering)`);
    return { code: 200, body: renderMaster(variants, media, chosen, (v) => this.wrap(abs(v.uri))) };
  }

  stop() {}
}

export class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweep(), 10_000);
    this.timer.unref();
  }

  create(opts) {
    if (this.sessions.size >= MAX_SESSIONS) this.sweep(true);
    const s = new Session(opts);
    this.sessions.set(s.id, s);
    return s;
  }

  get(id) { return this.sessions.get(id) ?? null; }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    try { s.proxy?.stop(); } catch { /* ignore */ }
    s.emit('closed');
    return true;
  }

  /** Drop idle sessions (those with no requests and no open event stream). */
  sweep(evictOldest = false) {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (s.streams === 0 && now - s.lastSeen > s.idleMs) {
        log.debug(`session ${s.id.slice(0, 6)} idle; removing`);
        this.remove(s.id);
      }
    }
    if (evictOldest && this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      if (oldest) this.remove(oldest.id);
    }
  }

  stopAll() {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) this.remove(id);
  }
}

// Controls: play/pause, seek bar, volume, time and "go live" for a StreamPlayer.
// Used by the watch view and by every multiview tile.
//
// Seeking:
//  - VOD / clip: 0 .. duration
//  - Live: the player's seekable window (DVR). Dragging back enters "DVR mode"
//    (hls.js is told not to snap back to the live edge); LIVE jumps back.
import { h, icon, store } from './ui.js';

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60), m = Math.floor((sec / 60) % 60), hr = Math.floor(sec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return hr ? `${hr}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Swap a button's icon only when it changes (replacing it mid-click can swallow the click). */
function setIcon(btn, name) {
  if (btn.dataset.ic === name) return;
  btn.dataset.ic = name;
  btn.replaceChildren(icon(name));
}

const fill = (input) => {
  const min = Number(input.min), max = Number(input.max), v = Number(input.value);
  input.style.setProperty('--fill', `${max > min ? ((v - min) / (max - min)) * 100 : 0}%`);
};

export function savedVolume() {
  const v = store.get('volume', 1);
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : 1;
}

export class Controls {
  /**
   * @param {object} o
   * @param {(player)=>void} [o.onToggleMute] override default mute behaviour
   * @param {(v:number, player)=>void} [o.onVolume] override default volume behaviour
   * @param {boolean} [o.compact]
   * @param {HTMLElement[]} [o.extras] extra buttons placed at the right of the row
   */
  constructor({ onToggleMute, onVolume, compact = false, extras = [] } = {}) {
    this.onToggleMute = onToggleMute;
    this.onVolume = onVolume;
    this.player = null;
    this.dragging = false;
    this.dvr = false;
    this.cleanups = [];

    this.playBtn = h('button', { class: 'icon-btn', 'aria-label': 'Play / pause', title: 'Play / pause (Space)', onclick: () => this.player?.togglePause() });
    this.muteBtn = h('button', { class: 'icon-btn', 'aria-label': 'Mute / unmute', title: 'Mute / unmute (M)', onclick: () => this.toggleMute() });
    this.vol = h('input', { class: 'vol', type: 'range', min: '0', max: '1', step: '0.02', value: String(savedVolume()), 'aria-label': 'Volume' });
    this.seek = h('input', { class: 'seek', type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Seek', disabled: true });
    this.time = h('span', { class: 'time', 'aria-live': 'off' }, '0:00');
    this.liveBtn = h('button', { class: 'live-btn', title: 'Jump to live edge', hidden: true, onclick: () => this.goLive() }, 'LIVE');
    this.extrasEl = h('span', { class: 'pc-extras' }, extras);
    this.el = h('div', { class: 'pc' },
      h('div', { class: 'pc-row' }, this.seek),
      h('div', { class: 'pc-row' }, this.playBtn, this.muteBtn, this.vol, this.time, h('span', { class: 'spacer' }), this.liveBtn, this.extrasEl));
    if (compact) this.el.classList.add('compact');

    this.vol.addEventListener('input', () => {
      const v = Number(this.vol.value);
      fill(this.vol);
      if (this.onVolume) this.onVolume(v, this.player);
      else if (this.player) { this.player.video.volume = v; this.player.video.muted = v === 0; }
      store.set('volume', v);
    });
    this.seek.addEventListener('pointerdown', () => { this.dragging = true; });
    this.seek.addEventListener('input', () => { this.dragging = true; this.previewTime(); fill(this.seek); });
    this.seek.addEventListener('change', () => { this.commitSeek(); this.dragging = false; });
    this.seek.addEventListener('pointerup', () => { if (this.dragging) { this.commitSeek(); this.dragging = false; } });
    this.seek.addEventListener('keydown', (e) => e.stopPropagation()); // arrow keys on the slider handle themselves
    this.render();
  }

  // ---- binding ---------------------------------------------------------
  bind(player) {
    this.unbind();
    this.player = player;
    const v = player.video;
    const on = (t, ev, fn) => { t.addEventListener(ev, fn); this.cleanups.push(() => t.removeEventListener(ev, fn)); };
    for (const ev of ['timeupdate', 'durationchange', 'progress', 'seeked', 'loadedmetadata', 'play', 'pause', 'emptied']) on(v, ev, () => this.render());
    on(v, 'volumechange', () => this.syncVolume());
    on(player, 'state', () => this.render());
    on(player, 'meta', () => this.render());
    this.timer = setInterval(() => this.render(), 500);
    this.cleanups.push(() => clearInterval(this.timer));
    this.dvr = false;
    // Apply the remembered volume to a fresh video element.
    if (this.onVolume === undefined) v.volume = Number(this.vol.value);
    this.syncVolume();
    this.render();
  }

  unbind() {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.player = null;
  }

  // ---- range model -----------------------------------------------------
  isLive() { return this.player?.meta?.kind === 'live'; }

  range() {
    const v = this.player?.video;
    if (!v) return null;
    if (this.isLive() || !Number.isFinite(v.duration)) {
      const s = v.seekable;
      if (!s || !s.length) return null;
      return { start: s.start(0), end: s.end(s.length - 1) };
    }
    return v.duration > 0 ? { start: 0, end: v.duration } : null;
  }

  previewTime() {
    const r = this.range();
    if (!r) return;
    const t = r.start + (Number(this.seek.value) / 1000) * (r.end - r.start);
    this.time.textContent = this.isLive() ? `-${fmtTime(r.end - t)}` : `${fmtTime(t)} / ${fmtTime(r.end)}`;
  }

  commitSeek() {
    const r = this.range();
    if (!r || !this.player) return;
    const t = r.start + (Number(this.seek.value) / 1000) * (r.end - r.start);
    this.seekTo(t);
  }

  seekTo(t) {
    const p = this.player;
    if (!p) return;
    const r = this.range();
    if (r) t = Math.min(Math.max(t, r.start), r.end);
    p.video.currentTime = t;
    if (this.isLive()) {
      const behind = r ? r.end - t : 0;
      this.dvr = behind > 5;
      p.setDvr?.(this.dvr);
    }
  }

  /** Relative seek by seconds (keyboard). */
  skip(delta) {
    if (!this.player) return;
    this.seekTo(this.player.video.currentTime + delta);
    this.render();
  }

  goLive() {
    this.dvr = false;
    this.player?.setDvr?.(false);
    this.player?.jumpToLive();
    this.render();
  }

  // ---- volume ----------------------------------------------------------
  toggleMute() {
    if (this.onToggleMute) return this.onToggleMute(this.player);
    const v = this.player?.video;
    if (!v) return undefined;
    if (v.muted || v.volume === 0) { if (v.volume === 0) v.volume = 0.5; v.muted = false; } else v.muted = true;
    return undefined;
  }

  syncVolume() {
    const v = this.player?.video;
    if (!v) return;
    const muted = v.muted || v.volume === 0;
    setIcon(this.muteBtn, muted ? 'mute' : 'volume');
    this.muteBtn.setAttribute('aria-pressed', String(muted));
    if (document.activeElement !== this.vol) { this.vol.value = String(v.muted ? 0 : v.volume); fill(this.vol); }
  }

  // ---- painting --------------------------------------------------------
  render() {
    const p = this.player;
    const v = p?.video;
    setIcon(this.playBtn, v && !v.paused ? 'pause' : 'play');
    const live = this.isLive();
    const r = this.range();
    this.seek.disabled = !r || !p || p.state === 'loading' || p.state === 'error' || p.state === 'offline';
    this.liveBtn.hidden = !live;
    if (!r || !v) { this.time.textContent = live ? '' : '0:00'; this.seek.value = '0'; fill(this.seek); return; }

    const behind = Math.max(0, r.end - v.currentTime);
    if (live) {
      const atLive = behind < 6 && !this.dvr;
      this.liveBtn.classList.toggle('at-live', atLive);
      this.liveBtn.textContent = atLive ? 'LIVE' : 'GO LIVE';
      this.liveBtn.disabled = atLive;
      if (behind < 3 && this.dvr) { this.dvr = false; p.setDvr?.(false); }
    }
    if (this.dragging) return; // keep the user's drag position
    const frac = r.end > r.start ? (v.currentTime - r.start) / (r.end - r.start) : 0;
    this.seek.value = String(Math.round(Math.min(1, Math.max(0, frac)) * 1000));
    fill(this.seek);
    this.time.textContent = live ? (behind < 6 ? '' : `-${fmtTime(behind)}`) : `${fmtTime(v.currentTime)} / ${fmtTime(r.end)}`;
  }

  destroy() { this.unbind(); this.el.remove(); }
}

// Miniplayer: keeps the current watch session (player + <video>) alive when the
// user navigates away from /watch, docking it in a small draggable window.
// Navigating back to the same stream re-adopts the same box without a reload.
import { h, icon, store } from './ui.js';

let session = null; // { raw, player, box, controls, title, destroy() }
let dock = null;
let navigateFn = () => {};
const MIN_W = 240;
const maxW = () => Math.max(MIN_W, Math.min(960, innerWidth - 24));
const savedWidth = () => { const w = store.get('miniW', 360); return typeof w === 'number' ? Math.min(maxW(), Math.max(MIN_W, w)) : 360; };

export const getSession = () => session;
export const setSession = (s) => { session = s; };
export const miniActive = () => !!(session && dock && !dock.el.hidden);
export function initMini({ navigate }) { navigateFn = navigate; }

// Moving a <video> between parents can pause it; resume if it was playing.
function move(box, parent) {
  const v = box.querySelector('video');
  const wasPlaying = v && !v.paused;
  parent.append(box);
  if (wasPlaying) setTimeout(() => { if (v.paused && session && !session.player.paused) v.play().catch(() => {}); }, 30);
}

function clamp(x, y) {
  const r = dock.el.getBoundingClientRect();
  return [Math.min(Math.max(0, x), Math.max(0, innerWidth - r.width)), Math.min(Math.max(0, y), Math.max(0, innerHeight - r.height))];
}

function place(x, y) {
  [x, y] = clamp(x, y);
  Object.assign(dock.el.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
}

function ensureDock() {
  if (dock) return dock;
  const body = h('div', { class: 'mini-body' });
  const grip = h('div', { class: 'mini-resize', title: 'Drag to resize (double-click to reset)', 'aria-hidden': 'true' });
  const el = h('div', { class: 'mini-dock', hidden: true, role: 'region', 'aria-label': 'Miniplayer' }, body, grip);
  el.style.width = `${savedWidth()}px`;
  document.body.append(el);
  dock = { el, body };

  // Drag by the title strip on the box (delegated, since the box moves in and out).
  let drag = null;
  let lastGripDown = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = el.getBoundingClientRect();
    if (e.target.closest('.mini-resize')) {
      // Double-click detection done by hand: pointer capture retargets dblclick away from the grip.
      const now = performance.now();
      if (now - lastGripDown < 400) {
        lastGripDown = 0;
        el.style.width = '360px'; store.set('miniW', 360);
        place(r.right - 360, r.bottom - el.getBoundingClientRect().height);
        const nr = el.getBoundingClientRect();
        store.set('miniPos', { x: nr.left, y: nr.top });
        e.preventDefault();
        return;
      }
      lastGripDown = now;
      // Resize from the top-left corner, keeping the bottom-right corner fixed.
      drag = { resize: true, right: r.right, bottom: r.bottom };
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      e.preventDefault();
      return;
    }
    if (!e.target.closest('.mini-title')) return;
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (drag.resize) {
      const w = Math.min(maxW(), Math.max(MIN_W, drag.right - e.clientX, (drag.bottom - e.clientY) * 16 / 9), drag.right);
      el.style.width = `${w}px`;
      place(drag.right - w, drag.bottom - el.getBoundingClientRect().height);
    } else place(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  const end = () => {
    if (!drag) return;
    drag = null; el.classList.remove('dragging');
    const r = el.getBoundingClientRect();
    store.set('miniPos', { x: r.left, y: r.top });
    store.set('miniW', Math.round(r.width));
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  addEventListener('resize', () => { el.style.width = `${Math.min(parseFloat(el.style.width) || 360, maxW())}px`; if (!el.hidden && el.style.left) { const r = el.getBoundingClientRect(); place(r.left, r.top); } });
  return dock;
}

/** Build the mini-only chrome that lives inside a session's box. */
export function buildMiniBar(sess) {
  const playBtn = h('button', { class: 'icon-btn', 'aria-label': 'Play / pause', onclick: () => sess.player.togglePause() }, icon('pause'));
  const muteBtn = h('button', { class: 'icon-btn', 'aria-label': 'Mute / unmute', onclick: () => sess.controls.toggleMute() }, icon('volume'));
  const titleEl = h('div', { class: 'mini-title', title: 'Drag to move' }, '');
  const bar = h('div', { class: 'mini-bar' },
    h('div', { class: 'mini-top' }, titleEl,
      h('button', { class: 'icon-btn', 'aria-label': 'Back to stream', title: 'Back to stream', onclick: () => expandMini() }, icon('expand')),
      h('button', { class: 'icon-btn', 'aria-label': 'Close miniplayer', title: 'Close', onclick: () => closeMini() }, icon('close'))),
    h('div', { class: 'mini-bottom' }, playBtn, muteBtn));
  const v = sess.player.video;
  const sync = () => {
    const paused = v.paused;
    if (playBtn.dataset.p !== String(paused)) { playBtn.dataset.p = String(paused); playBtn.replaceChildren(icon(paused ? 'play' : 'pause')); }
    const muted = v.muted || v.volume === 0;
    if (muteBtn.dataset.m !== String(muted)) { muteBtn.dataset.m = String(muted); muteBtn.replaceChildren(icon(muted ? 'mute' : 'volume')); }
  };
  for (const ev of ['play', 'pause', 'volumechange']) v.addEventListener(ev, sync);
  sync();
  return { bar, setTitle: (t) => { titleEl.textContent = t || ''; } };
}

/** Dock the current session (called when leaving /watch). */
export function park() {
  if (!session) return;
  const st = session.player.state;
  if (st === 'idle' || st === 'error' || st === 'offline' || st === 'ended') { closeMini(); return; }
  ensureDock();
  session.box.classList.add('mini');
  session.box.classList.remove('idle');
  move(session.box, dock.body);
  dock.el.hidden = false;
  dock.el.style.width = `${savedWidth()}px`;
  const pos = store.get('miniPos', null);
  if (pos && typeof pos.x === 'number') place(pos.x, pos.y);
}

/** Take the session's box out of the dock and into `container` (the watch page). */
export function adopt(container) {
  if (!session) return;
  session.box.classList.remove('mini');
  move(session.box, container);
  if (dock) dock.el.hidden = true;
}

export function expandMini() {
  if (session) navigateFn(`/watch?q=${encodeURIComponent(session.raw)}`);
}

export function closeMini() {
  const s = session;
  session = null;
  if (dock) dock.el.hidden = true;
  s?.destroy();
}

// Multiview: 2 / 4 / 6 simultaneous streams.
//
// Tile lifecycle: empty -> (add channel) -> StreamPlayer.start() -> POST /api/play
//   creates a server proxy session -> hls.js plays /proxy/<sid>/master.m3u8.
//   remove/replace/reload destroys the player, which DELETEs the session.
// Tiles are never rebuilt on layout/reorder changes (DOM nodes are just moved)
// so playback keeps running while you rearrange.
import { api, ApiError } from './api.js';
import { createChatPanel } from './chat.js';
import { StreamPlayer } from './player.js';
import { Controls, savedVolume } from './controls.js';
import { clear, confirmDialog, copyText, debounce, formatUptime, formatViewers, getRecent, h, icon, modal, pushRecent, sleep, store, toast } from './ui.js';
import { ctx, openLogin } from './views.js';

export const LAYOUT_COUNT = { '2h': 2, '2v': 2, '2x2': 4, '1+3': 4, '3x2': 6, '1+5': 6 };
const ALT = { '2h': '2v', '2v': '2h', '2x2': '1+3', '1+3': '2x2', '3x2': '1+5', '1+5': '3x2' };
const CYCLE = ['2h', '2v', '2x2', '1+3', '3x2', '1+5'];
const FEATURED = new Set(['1+3', '1+5']);
const MAX = 6;

let active = null; // the mounted Multiview, if any
export const multiviewActive = () => active;

/** Add a channel to the persisted wall (works when the multiview page is not open). */
export function addToStoredWall(login) {
  if (active) return active.addChannel(login);
  const wall = store.get('mvWall', { layout: ctx.settings.mvLayout || '2x2', slots: [] });
  const count = LAYOUT_COUNT[wall.layout] ?? 4;
  const slots = Array.from({ length: MAX }, (_, i) => wall.slots[i] ?? null);
  if (slots.slice(0, count).includes(login)) return 'exists';
  let i = slots.slice(0, count).findIndex((s) => !s);
  if (i < 0) {
    const bigger = CYCLE.find((l) => LAYOUT_COUNT[l] > count && slots.slice(0, LAYOUT_COUNT[l]).some((s) => !s));
    if (!bigger) return 'full';
    wall.layout = bigger;
    i = slots.findIndex((s, k) => !s && k < LAYOUT_COUNT[bigger]);
  }
  slots[i] = login;
  store.set('mvWall', { layout: wall.layout, slots });
  return 'added';
}

const capHeight = (v) => { const m = /^(\d+)p?$/.exec(String(v || '')); return m ? Number(m[1]) : 0; };

class Tile {
  constructor(mv) {
    this.mv = mv;
    this.channel = null;
    this.player = null;
    this.override = null; // user-chosen policy for this tile
    this.adblock = null; // per-tile override (null = global setting)
    this.state = 'empty';
    this.badEvents = [];
    this.el = h('div', { class: 'mv-tile', tabindex: '0' });
    this.build();
  }

  build() {
    const t = this;
    t.nameEl = h('span', { class: 'name' });
    t.titleEl = h('span', { class: 'title' });
    t.badge = h('span', { class: 'chip', title: 'Current rendition' });
    t.stat = h('span', { class: 'chip', title: 'Buffering / distance from live edge' });
    t.viewersEl = h('span', { class: 'chip' });
    t.grip = h('span', { class: 'mv-grip icon-btn', draggable: true, title: 'Drag to swap tiles', 'aria-label': 'Drag to reorder' }, icon('grip'));
    t.top = h('div', { class: 'mv-top' }, t.grip, t.nameEl, t.titleEl, t.viewersEl, t.badge, t.stat);

    t.qualitySel = h('select', { 'aria-label': 'Quality' });
    t.abBtn = h('button', { class: 'icon-btn', 'aria-label': 'Toggle ad-block', title: 'Ad-block on/off', 'aria-pressed': 'true' }, icon('shield'));
    t.controls = new Controls({
      compact: true,
      onToggleMute: () => t.mv.toggleMute(t),
      onVolume: (v) => {
        const vid = t.player?.video;
        if (!vid) return;
        vid.volume = v;
        if (v > 0 && (vid.muted || t.mv.audio !== t)) t.mv.setAudio(t); // touching the slider moves audio here
      },
      extras: [
        t.qualitySel, t.abBtn,
        h('button', { class: 'icon-btn', 'aria-label': 'Reload stream', title: 'Reload', onclick: () => t.reload() }, icon('refresh')),
        h('button', { class: 'icon-btn', 'aria-label': 'Fullscreen tile', title: 'Fullscreen tile (F)', onclick: () => t.fullscreen() }, icon('fullscreen')),
        h('button', { class: 'icon-btn', 'aria-label': 'Remove stream', title: 'Remove', onclick: () => mvRemove(t) }, icon('close')),
      ],
    });
    t.bottom = h('div', { class: 'mv-bottom' }, t.controls.el);
    t.status = h('div', { class: 'mv-status' });
    t.overlay = h('div', { class: 'overlay', hidden: true });
    t.emptyEl = h('div', { class: 'mv-empty' });
    t.el.append(t.top, t.status, t.bottom, t.overlay, t.emptyEl);

    // composedPath() is fixed at dispatch time, so it still names the control bars even when a
    // handler re-rendered a button (detaching e.target) before the event reached the tile.
    t.el.addEventListener('click', (e) => {
      const path = e.composedPath();
      if (path.includes(t.top) || path.includes(t.bottom) || path.includes(t.overlay) || path.includes(t.emptyEl)) return;
      if (t.channel) t.mv.focusTile(t);
    });
    t.qualitySel.addEventListener('change', () => {
      const v = t.qualitySel.value;
      t.override = v === '' ? null : v === 'auto' ? { type: 'auto' } : v === 'audio_only' ? { type: 'audio' } : { type: 'lock', key: v };
      t.applyPolicy();
    });
    t.abBtn.addEventListener('click', () => { t.adblock = !(t.adblock ?? ctx.settings.adblock !== false); t.reload(); });

    // drag & drop swap
    t.grip.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-mv-tile', String(t.mv.tiles.indexOf(t))); e.dataTransfer.effectAllowed = 'move'; });
    t.el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-mv-tile')) { e.preventDefault(); t.el.classList.add('drag-over'); } });
    t.el.addEventListener('dragleave', () => t.el.classList.remove('drag-over'));
    t.el.addEventListener('drop', (e) => {
      t.el.classList.remove('drag-over');
      const from = Number(e.dataTransfer.getData('text/x-mv-tile'));
      if (Number.isInteger(from)) { e.preventDefault(); t.mv.swap(from, t.mv.tiles.indexOf(t)); }
    });
    t.renderEmpty();
    t.paint();
  }

  // ---- empty slot UI ----
  renderEmpty() {
    const t = this;
    const input = h('input', { type: 'text', placeholder: 'channel or twitch.tv URL', 'aria-label': 'Add stream', autocomplete: 'off', spellcheck: 'false' });
    const chips = h('div', { class: 'chips' });
    const add = (v) => { const s = String(v || '').trim(); if (s) t.mv.setChannel(t, s); };
    const used = new Set(t.mv.tiles.map((x) => x.channel));
    const recent = getRecent().filter((c) => !used.has(c)).slice(0, 8);
    chips.append(...recent.map((c) => h('button', { class: 'chip', onclick: () => add(c) }, c)));
    clear(t.emptyEl).append(
      h('div', { class: 'icon', style: { width: '32px', height: '32px', color: 'var(--fg-3)' } }, icon('plus', 32)),
      h('strong', {}, 'Add stream'),
      h('form', { onsubmit: (e) => { e.preventDefault(); add(input.value); } }, input, h('button', { class: 'btn primary sm', type: 'submit' }, 'Add')),
      recent.length ? h('div', { class: 'muted' }, 'Recent') : null, chips);
    if (ctx.auth.loggedIn) {
      const fol = h('div', { class: 'chips' });
      t.emptyEl.append(h('div', { class: 'muted' }, 'Followed & live'), fol);
      t.mv.followed().then((list) => {
        const names = list.filter((s) => !used.has(s.login)).slice(0, 8);
        fol.append(...names.map((s) => h('button', { class: 'chip', title: `${formatViewers(s.viewers)} viewers`, onclick: () => add(s.login) }, s.name)));
        if (!names.length) fol.append(h('span', { class: 'muted' }, 'none live'));
      }).catch(() => fol.append(h('span', { class: 'muted' }, 'unavailable')));
    }
    t.inputEl = input;
  }

  focusInput() { this.inputEl?.focus(); }

  // ---- state painting ----
  paint() {
    const t = this;
    const empty = !t.channel;
    t.emptyEl.hidden = !empty;
    t.top.hidden = t.bottom.hidden = empty;
    t.status.hidden = empty;
    const st = t.state;
    t.overlay.hidden = empty || st === 'playing' || st === 'buffering';
    clear(t.overlay);
    if (st === 'loading') t.overlay.append(h('div', { class: 'stack' }, h('div', { class: 'spinner' }), h('div', {}, `Connecting to ${t.channel}…`)));
    if (st === 'error') t.overlay.append(h('div', { class: 'stack' }, h('strong', {}, 'Playback failed'), h('div', {}, t.player?.error || ''),
      h('div', { class: 'row' }, h('button', { class: 'btn primary sm', onclick: () => t.reload() }, 'Retry'), h('button', { class: 'btn sm', onclick: () => mvRemove(t) }, 'Remove'))));
    if (st === 'offline') {
      t.overlay.append(h('div', { class: 'stack' }, h('strong', {}, `${t.channel} — offline`),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary sm', onclick: () => t.reload() }, 'Retry'),
          h('button', { class: 'btn sm', onclick: () => t.mv.replace(t) }, 'Replace'),
          h('button', { class: 'btn sm', onclick: () => t.latestVod() }, 'Latest VOD'))));
    }
    t.el.classList.toggle('focused', t.mv.focus === t && !empty);
  }

  // ---- stream control ----
  async start(delay = 0) {
    const t = this;
    if (!t.channel) return;
    if (!t.player) {
      t.player = new StreamPlayer(t.el, { mode: 'tile', getSettings: () => ctx.settings });
      t.el.prepend(t.player.video);
      t.player.video.addEventListener('dblclick', () => t.fullscreen());
      t.player.video.volume = savedVolume();
      t.controls.bind(t.player);
      t.player.addEventListener('state', (e) => { t.state = e.detail; t.paint(); });
      t.player.addEventListener('meta', (e) => t.onMeta(e.detail));
      t.player.addEventListener('levels', () => { t.fillQualities(); t.applyPolicy(true); });
      t.player.addEventListener('stats', (e) => t.onStats(e.detail));
      t.player.addEventListener('session', (e) => t.onSessionEvent(e.detail));
      t.player.addEventListener('volume', (e) => { t.updateMute(); if (e.detail.blocked) toast('Browser blocked autoplay with sound; the tile was muted.', 'warn'); });
      t.player.addEventListener('error', (e) => { if (e.detail instanceof ApiError && e.detail.needsLogin) openLogin(); });
      // Entries can be batched (first one may predate the tile being attached); the last is the truth.
      t.io = new IntersectionObserver((entries) => t.player?.setActive(entries[entries.length - 1].isIntersecting), { threshold: 0.01 });
      t.io.observe(t.el);
    }
    t.state = 'loading';
    t.paint();
    if (delay) await sleep(delay);
    if (!t.channel || !t.player) return;
    t.player.video.muted = t.mv.audio !== t;
    t.updateMute();
    t.player.start(t.channel, { quality: ctx.settings.quality || null, adblock: t.adblock ?? undefined });
  }

  reload() { if (this.player) { this.state = 'loading'; this.paint(); this.player.start(this.channel, { quality: ctx.settings.quality || null, adblock: this.adblock ?? undefined }); } else this.start(); }

  release() {
    this.io?.disconnect(); this.io = null;
    this.controls.unbind();
    this.player?.destroy(); this.player = null;
    this.state = 'empty';
    this.badEvents = []; clear(this.status);
    this.override = null; this.adblock = null;
    clear(this.qualitySel);
  }

  setChannel(channel) {
    this.release();
    this.channel = channel || null;
    this.nameEl.textContent = channel || '';
    this.titleEl.textContent = this.viewersEl.textContent = this.badge.textContent = this.stat.textContent = '';
    if (channel) this.state = 'loading';
    else this.renderEmpty();
    this.paint();
  }

  onMeta(m) {
    if (m.status === 'offline') return;
    if (m.channel) { this.channel = m.channel; this.nameEl.textContent = m.displayName || m.channel; pushRecent(m.channel); this.mv.persist(); }
    this.titleEl.textContent = m.title || '';
    this.viewersEl.textContent = m.viewers != null ? `${formatViewers(m.viewers)} 👁` : '';
    this.meta = m;
    this.abBtn.setAttribute('aria-pressed', String(!!m.adblock));
    this.mv.refreshChat();
  }

  fillQualities() {
    clear(this.qualitySel);
    this.qualitySel.append(h('option', { value: '' }, 'Auto (tile default)'));
    for (const l of this.player.levels()) this.qualitySel.append(h('option', { value: l.audioOnly ? 'audio_only' : l.key }, l.label));
    this.qualitySel.append(h('option', { value: 'auto' }, 'Adaptive'));
  }

  policy() {
    if (this.override) return this.override;
    if (this.mv.focus === this || this.mv.tiles.filter((x) => x.channel).length <= 1) return { type: 'chosen' };
    const h2 = capHeight(ctx.settings.mvCapQuality);
    return h2 ? { type: 'cap', height: h2 } : { type: 'chosen' };
  }

  applyPolicy(initial) { if (this.player?.hls) { this.player.policy = this.policy(); this.player._applyPolicy(!!initial); } }

  onStats({ latency, level, buffering }) {
    this.badge.textContent = level ? level.label : '';
    const up = this.meta?.startedAt ? formatUptime(this.meta.startedAt) : '';
    this.stat.textContent = buffering ? 'buffering…' : [latency != null ? `${latency.toFixed(1)}s` : '', up].filter(Boolean).join(' · ');
  }

  onSessionEvent(ev) {
    // Show ad-block events as short-lived chips ("switched token", "ads passed through").
    const short = /switched to '(\w+)'/.exec(ev.message) ? `token → ${/switched to '(\w+)'/.exec(ev.message)[1]}`
      : /Mid-roll ads detected/.test(ev.message) ? 'ads passed through' : null;
    if (!short) return;
    const chip = h('span', { class: `chip ${ev.level === 'warn' ? 'warn' : 'info'}` }, short);
    this.status.append(chip);
    setTimeout(() => chip.remove(), 8000);
  }

  updateMute() { this.controls.syncVolume(); }

  fullscreen() {
    if (document.fullscreenElement === this.el) document.exitFullscreen();
    else this.el.requestFullscreen?.().catch(() => {});
  }

  async latestVod() {
    if (!ctx.auth.loggedIn) return openLogin('Listing VODs needs a Twitch login.');
    try {
      const r = await api(`/api/channels/${encodeURIComponent(this.channel)}/latest-vod`);
      this.player.start(`https://www.twitch.tv/videos/${r.vod.id}`, { quality: ctx.settings.quality || null });
    } catch (e) { toast(e.message, 'err'); }
    return undefined;
  }
}

function mvRemove(tile) { tile.mv.remove(tile); }

class Multiview {
  constructor(root, params, onCleanup) {
    this.root = root;
    this.tiles = [];
    this.focus = null;
    this.audio = null;
    this.layout = '2x2';
    this.chatOn = false;
    this._followed = null;
    this.keyHandler = (e) => this.onKey(e);
    this.fsHandler = () => this.syncFs();
    document.addEventListener('keydown', this.keyHandler);
    document.addEventListener('fullscreenchange', this.fsHandler);
    onCleanup(() => this.destroy());

    this.buildUi();
    this.init(params);
  }

  // ---- init & persistence ----
  init(params) {
    const saved = store.get('mvWall', null);
    const qLayout = params.get('layout');
    const qChannels = params.get('c');
    let layout = ctx.settings.mvLayout || '2x2';
    let slots = [];
    if (qChannels !== null) {
      slots = qChannels.split(',').map((s) => s.trim().toLowerCase() || null).slice(0, MAX);
      layout = qLayout in LAYOUT_COUNT ? qLayout : (CYCLE.find((l) => LAYOUT_COUNT[l] >= slots.length) ?? '3x2');
    } else if (saved?.slots?.some(Boolean)) {
      layout = saved.layout in LAYOUT_COUNT ? saved.layout : layout;
      slots = saved.slots;
    } else if (qLayout in LAYOUT_COUNT) layout = qLayout;

    this.layout = layout;
    this.ensureTiles(LAYOUT_COUNT[layout]);
    slots.slice(0, this.tiles.length).forEach((c, i) => { if (c) this.tiles[i].setChannel(c); });
    this.applyLayout();

    const firstLive = this.tiles.find((t) => t.channel);
    this.focus = firstLive ?? null;
    this.audio = ctx.settings.mvAudioFocus === 'muted' ? null : firstLive ?? null;
    const stagger = ctx.settings.mvStaggerMs ?? 250;
    this.tiles.filter((t) => t.channel).forEach((t, i) => t.start(i * stagger));
    this.tiles.forEach((t) => t.paint());
    this.persist();
  }

  persist() {
    const slots = this.tiles.map((t) => t.channel);
    store.set('mvWall', { layout: this.layout, slots });
    const c = slots.map((s) => s || '').join(',');
    const url = slots.some(Boolean) ? `/multiview?c=${encodeURIComponent(c).replace(/%2C/g, ',')}&layout=${encodeURIComponent(this.layout)}` : `/multiview?layout=${encodeURIComponent(this.layout)}`;
    history.replaceState(null, '', url);
  }

  async followed() {
    if (!this._followed) this._followed = api('/api/followed?first=20').then((r) => r.items).catch((e) => { this._followed = null; throw e; });
    return this._followed;
  }

  // ---- UI ----
  buildUi() {
    const mk = (count, label, ic) => {
      const b = h('button', { class: 'icon-btn', 'aria-label': `${count} streams`, title: `${count} streams — click again for the alternate layout`, onclick: () => this.pickCount(count) }, icon(ic), h('span', { style: { fontSize: '11px', marginLeft: '2px' } }, label));
      b.dataset.count = count;
      return b;
    };
    this.countBtns = [mk(2, '2', 'cols2'), mk(4, '4', 'grid'), mk(6, '6', 'layers')];
    this.chatBtn = h('button', { class: 'icon-btn', 'aria-label': 'Toggle chat', 'aria-pressed': 'false', title: 'Chat for focused tile', onclick: () => this.toggleChat() }, icon('chat'));
    this.toolbar = h('div', { class: 'mv-toolbar', role: 'toolbar', 'aria-label': 'Multiview controls' },
      h('div', { class: 'group' }, this.countBtns),
      h('button', { class: 'btn sm', onclick: () => this.cycleLayout(), title: 'Cycle layout (L)' }, icon('layers'), 'Layout'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm', onclick: () => this.muteAll() }, icon('mute'), 'Mute all'),
      h('button', { class: 'btn sm', onclick: () => this.pauseAll() }, icon('pause'), 'Pause all'),
      h('button', { class: 'btn sm', onclick: () => this.liveAll() }, icon('live'), 'Live edge'),
      h('button', { class: 'btn sm', onclick: () => this.openPresets() }, icon('save'), 'Presets'),
      h('button', { class: 'btn sm', onclick: async () => toast((await copyText(`${location.origin}${location.pathname}${location.search}`)) ? 'Share link copied' : 'Copy failed', 'info') }, icon('link'), 'Share'),
      this.chatBtn,
      h('button', { class: 'icon-btn', 'aria-label': 'Add stream', title: 'Add stream (A)', onclick: () => this.addPrompt() }, icon('plus')),
      h('button', { class: 'icon-btn', 'aria-label': 'Fullscreen wall', title: 'Fullscreen (Shift+F)', onclick: () => this.toggleFs() }, icon('fullscreen')),
      h('button', { class: 'icon-btn', 'aria-label': 'Keyboard shortcuts', title: 'Shortcuts (?)', onclick: () => showShortcuts() }, icon('help')));
    this.wall = h('div', { class: 'mv-wall' });
    this.chatPane = h('div', { class: 'mv-chat', hidden: true });
    this.mvEl = h('div', { class: 'mv' }, this.toolbar, h('div', { class: 'mv-body' }, this.wall, this.chatPane));
    this.root.append(this.mvEl);
  }

  ensureTiles(n) {
    while (this.tiles.length < n) { const t = new Tile(this); this.tiles.push(t); }
    while (this.tiles.length > n) { const t = this.tiles.pop(); t.release(); t.el.remove(); if (this.focus === t) this.focus = null; if (this.audio === t) this.audio = null; }
  }

  applyLayout() {
    this.wall.className = `mv-wall layout-${this.layout}`;
    this.tiles.forEach((t, i) => { t.el.style.gridArea = `a${i}`; this.wall.append(t.el); });
    this.countBtns.forEach((b) => b.setAttribute('aria-pressed', String(LAYOUT_COUNT[this.layout] === Number(b.dataset.count))));
    this.tiles.forEach((t) => { t.applyPolicy(); t.paint(); });
  }

  setLayout(layout) {
    const n = LAYOUT_COUNT[layout];
    if (n < this.tiles.length) {
      // Shrinking: keep existing streams in order by compacting them to the front.
      const live = this.tiles.filter((t) => t.channel);
      const rest = this.tiles.filter((t) => !t.channel);
      this.tiles = [...live, ...rest];
    }
    this.layout = layout;
    this.ensureTiles(n);
    if (!this.focus || !this.tiles.includes(this.focus)) this.focus = this.tiles.find((t) => t.channel) ?? null;
    if (this.audio && !this.tiles.includes(this.audio)) this.audio = this.focus;
    this.applyLayout();
    this.persist();
    this.refreshChat();
  }

  pickCount(n) {
    const cur = LAYOUT_COUNT[this.layout];
    if (cur === n) return this.setLayout(ALT[this.layout]);
    return this.setLayout({ 2: '2h', 4: '2x2', 6: '3x2' }[n]);
  }

  cycleLayout() { this.setLayout(CYCLE[(CYCLE.indexOf(this.layout) + 1) % CYCLE.length]); }

  // ---- slot ops ----
  setChannel(tile, input) {
    const parsed = input.trim();
    let channel = parsed.toLowerCase().replace(/^@/, '');
    const m = /twitch\.tv\/([a-z0-9_]+)/i.exec(parsed);
    if (m) channel = m[1].toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(channel)) { toast('Enter a channel name or twitch.tv channel URL', 'warn'); return; }
    if (this.tiles.some((t) => t !== tile && t.channel === channel)) { toast(`${channel} is already on the wall`, 'info'); return; }
    tile.setChannel(channel);
    if (!this.focus) this.focus = tile;
    if (!this.audio && ctx.settings.mvAudioFocus !== 'muted') this.audio = tile;
    tile.start();
    this.persist();
    this.tiles.forEach((t) => { if (!t.channel) t.renderEmpty(); });
  }

  addChannel(login) {
    if (this.tiles.some((t) => t.channel === login)) return 'exists';
    let slot = this.tiles.find((t) => !t.channel);
    if (!slot) {
      const bigger = CYCLE.find((l) => LAYOUT_COUNT[l] > this.tiles.length);
      if (!bigger) return 'full';
      this.setLayout(bigger);
      slot = this.tiles.find((t) => !t.channel);
    }
    this.setChannel(slot, login);
    return 'added';
  }

  addPrompt() {
    const t = this.tiles.find((x) => !x.channel);
    if (t) { t.el.scrollIntoView({ block: 'nearest' }); t.focusInput(); return; }
    toast('All slots are used. Switch to a bigger layout or remove a stream.', 'info');
  }

  remove(tile) {
    const wasAudio = this.audio === tile, wasFocus = this.focus === tile;
    tile.setChannel(null);
    if (wasFocus) this.focus = this.tiles.find((t) => t.channel) ?? null;
    if (wasAudio) this.audio = ctx.settings.mvAudioFocus === 'muted' ? null : this.focus;
    this.applyAudio();
    this.tiles.forEach((t) => { t.applyPolicy(); t.paint(); if (!t.channel) t.renderEmpty(); });
    this.persist();
    this.refreshChat();
  }

  replace(tile) { this.remove(tile); tile.focusInput(); }

  swap(a, b) {
    if (a === b || !this.tiles[a] || !this.tiles[b]) return;
    [this.tiles[a], this.tiles[b]] = [this.tiles[b], this.tiles[a]];
    this.applyLayout();
    this.persist();
  }

  focusTile(tile) {
    if (!tile.channel) return;
    let t = tile;
    if (FEATURED.has(this.layout)) {
      const i = this.tiles.indexOf(tile);
      if (i > 0) this.swap(0, i);
      t = tile;
    }
    this.focus = t;
    this.setAudio(t);
    this.tiles.forEach((x) => { x.applyPolicy(); x.paint(); });
    this.refreshChat();
  }

  // ---- audio ----
  setAudio(tile) { this.audio = tile; this.applyAudio(); }

  applyAudio() {
    this.tiles.forEach((t) => { if (t.player) { t.player.video.muted = this.audio !== t; t.updateMute(); } });
  }

  toggleMute(tile) {
    const muted = !tile.player || tile.player.video.muted;
    if (muted) this.setAudio(tile);
    else { this.audio = null; this.applyAudio(); }
  }

  muteAll() { this.audio = null; this.applyAudio(); }
  pauseAll() {
    const anyPlaying = this.tiles.some((t) => t.player && !t.player.video.paused);
    this.tiles.forEach((t) => { if (!t.player) return; if (anyPlaying) t.player.pause(); else t.player.play(); });
  }
  liveAll() { this.tiles.forEach((t) => t.player?.jumpToLive()); }

  // ---- chat (focused tile only) ----
  toggleChat() { this.chatOn = !this.chatOn; this.chatBtn.setAttribute('aria-pressed', String(this.chatOn)); this.refreshChat(); }
  destroyChat() {
    this._chat?.destroy?.();
    this._chat = null;
    this._chatFor = null;
  }
  refreshChat() {
    const ch = this.chatOn && this.focus?.channel;
    this.chatPane.hidden = !this.chatOn;
    if (!this.chatOn) { this.destroyChat(); clear(this.chatPane); return; }
    if (this._chatFor === ch) return;
    this.destroyChat();
    clear(this.chatPane);
    this._chatFor = ch;
    if (!ch) { this.chatPane.append(h('div', { class: 'empty' }, 'Focus a stream to see its chat.')); return; }
    // Native chat panel (same module as the watch view), rebuilt on focus change.
    this._chat = createChatPanel({
      login: ch,
      displayName: this.focus?.player?.meta?.displayName || ch,
      auth: () => ctx.auth,
      requestLogin: () => openLogin(),
      embedSrc: `https://www.twitch.tv/embed/${encodeURIComponent(ch)}/chat?parent=${location.hostname}&darkpopout`,
    });
    this.chatPane.append(this._chat.el);
  }

  // ---- presets ----
  async openPresets() {
    const list = h('div', { style: { display: 'grid', gap: '8px' } });
    const name = h('input', { type: 'text', placeholder: 'Preset name, e.g. Friday FGC night', 'aria-label': 'Preset name' });
    let m;
    const render = async () => {
      let presets = [];
      try { presets = (await api('/api/multiview/presets')).presets; } catch (e) { toast(e.message, 'err'); }
      clear(list);
      if (!presets.length) list.append(h('p', { class: 'muted' }, 'No saved presets yet.'));
      for (const p of presets) {
        list.append(h('div', { class: 'row card-panel' },
          h('div', { style: { flex: 1 } }, h('strong', {}, p.name), h('div', { class: 'muted' }, `${p.layout} · ${p.channels.filter(Boolean).join(', ') || 'empty'}`)),
          h('button', { class: 'btn primary sm', onclick: () => { this.loadPreset(p); m.close(); } }, 'Load'),
          h('button', { class: 'btn danger sm', onclick: async () => { if (await confirmDialog('Delete preset?', p.name, 'Delete')) { await api(`/api/multiview/presets/${encodeURIComponent(p.name)}`, { method: 'DELETE' }); render(); } } }, 'Delete')));
      }
    };
    m = modal({
      title: 'Multiview presets',
      body: [list, h('div', { class: 'row' }, name, h('button', { class: 'btn primary', onclick: async () => {
        const n = name.value.trim();
        if (!n) return;
        try {
          await api('/api/multiview/presets', { method: 'POST', body: { name: n, channels: this.tiles.map((t) => t.channel), layout: this.layout, audioIndex: Math.max(0, this.tiles.indexOf(this.audio ?? this.focus)) } });
          name.value = ''; toast('Preset saved', 'ok'); render();
        } catch (e) { toast(e.message, 'err'); }
      } }, icon('save'), 'Save current wall'))],
    });
    render();
  }

  loadPreset(p) {
    this.tiles.forEach((t) => t.setChannel(null));
    this.layout = p.layout in LAYOUT_COUNT ? p.layout : '2x2';
    this.ensureTiles(LAYOUT_COUNT[this.layout]);
    p.channels.slice(0, this.tiles.length).forEach((c, i) => { if (c) this.tiles[i].setChannel(c); });
    const target = this.tiles[p.audioIndex] ?? this.tiles.find((t) => t.channel) ?? null;
    this.focus = target?.channel ? target : this.tiles.find((t) => t.channel) ?? null;
    this.audio = ctx.settings.mvAudioFocus === 'muted' ? null : this.focus;
    this.applyLayout();
    const stagger = ctx.settings.mvStaggerMs ?? 250;
    this.tiles.filter((t) => t.channel).forEach((t, i) => t.start(i * stagger));
    this.tiles.forEach((t) => { if (!t.channel) t.renderEmpty(); t.paint(); });
    this.persist();
    this.refreshChat();
  }

  // ---- fullscreen & keyboard ----
  toggleFs() { if (document.fullscreenElement === this.mvEl) document.exitFullscreen(); else this.mvEl.requestFullscreen?.().catch(() => {}); }
  syncFs() { this.mvEl.classList.toggle('is-fs', document.fullscreenElement === this.mvEl); }

  onKey(e) {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey || document.getElementById('modalRoot').children.length) return;
    const k = e.key;
    if (/^[1-6]$/.test(k)) { const t = this.tiles[Number(k) - 1]; if (t) { e.preventDefault(); if (t.channel) this.focusTile(t); else t.focusInput(); } return; }
    switch (k) {
      case 'm': if (this.focus) { e.preventDefault(); this.toggleMute(this.focus); } break;
      case 'M': e.preventDefault(); this.muteAll(); break;
      case 'f': if (this.focus) { e.preventDefault(); this.focus.fullscreen(); } break;
      case 'F': e.preventDefault(); this.toggleFs(); break;
      case 'l': case 'L': e.preventDefault(); this.cycleLayout(); break;
      case 'a': case 'A': e.preventDefault(); this.addPrompt(); break;
      case '?': e.preventDefault(); showShortcuts(); break;
      case 'Escape': if (document.fullscreenElement) document.exitFullscreen(); break;
      default:
    }
  }

  destroy() {
    document.removeEventListener('keydown', this.keyHandler);
    document.removeEventListener('fullscreenchange', this.fsHandler);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.destroyChat();
    this.tiles.forEach((t) => t.release());
    if (active === this) active = null;
  }
}

export function showShortcuts() {
  const rows = [['1 – 6', 'Focus tile (or add to an empty slot)'], ['M', 'Mute / unmute focused tile'], ['Shift+M', 'Mute all'], ['F', 'Fullscreen focused tile'], ['Shift+F', 'Fullscreen the wall'],
    ['L', 'Cycle layout'], ['A', 'Add a stream'], ['Esc', 'Exit fullscreen'], ['?', 'Show this help'], ['/', 'Focus the play box']];
  modal({ title: 'Keyboard shortcuts', body: h('div', { class: 'kbd-list' }, rows.flatMap(([k, d]) => [h('span', {}, k.split('+').map((x, i) => [i ? ' + ' : '', h('kbd', {}, x)])), h('span', {}, d)])) });
}

export function multiviewView(params, onCleanup) {
  const root = h('div', { style: { height: '100%' } });
  active = new Multiview(root, params, onCleanup);
  return root;
}

// Page views (everything except multiview): home, followed, browse, search,
// VODs, watch, diagnostics, settings, plus the login modal.
import { api, ApiError } from './api.js';
import { createChatPanel } from './chat.js';
import { StreamPlayer } from './player.js';
import { Controls } from './controls.js';
import { adopt, buildMiniBar, closeMini, expandMini, getSession, park, setSession } from './mini.js';
import {
  clear, copyText, confirmDialog, debounce, formatDate, formatUptime, formatViewers, getRecent, h, icon, modal, pushRecent, store, toast,
} from './ui.js';

export const ctx = {
  settings: {}, meta: {}, auth: { state: 'logged-out', loggedIn: false },
  navigate: () => {}, refreshAuth: async () => {}, saveSettings: async () => {}, addToMultiview: () => {},
};

// ---- shared bits ---------------------------------------------------------------
const needsLogin = (e) => e instanceof ApiError && e.needsLogin;

function skeletons(n = 8) {
  return h('div', { class: 'grid', 'aria-busy': 'true', 'aria-label': 'Loading' }, Array.from({ length: n }, () => h('div', { class: 'skeleton' })));
}

function emptyState(title, text, action) {
  return h('div', { class: 'empty' }, h('h3', {}, title), h('div', {}, text), action);
}

function errorBox(e, retry) {
  if (needsLogin(e)) {
    return emptyState('Login required', 'Log in with Twitch to see this page.', h('button', { class: 'btn primary', onclick: () => openLogin() }, 'Log in'));
  }
  const extra = e.extra?.retryAfter ? ` (retry in ${e.extra.retryAfter}s)` : '';
  return h('div', { class: 'error-box', role: 'alert' }, h('span', { class: 'spacer' }, `${e.message || 'Something went wrong'}${extra}`),
    retry ? h('button', { class: 'btn', onclick: retry }, icon('refresh'), 'Retry') : null);
}

function thumb(src, login, onclick, { live, viewers, duration, uptime } = {}) {
  const img = h('img', { src, alt: '', loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } });
  return h('button', { class: 'thumb', onclick, 'aria-label': `Play ${login}` }, img,
    live ? h('span', { class: 'tl chip live' }, 'LIVE') : null,
    viewers !== undefined ? h('span', { class: 'tr chip' }, `${formatViewers(viewers)} viewers`) : null,
    uptime ? h('span', { class: 'br' }, uptime) : null,
    duration ? h('span', { class: 'br' }, duration) : null);
}

export function streamCard(s) {
  return h('article', { class: 'card' },
    thumb(s.thumbnail, s.login, () => ctx.navigate(`/watch?c=${encodeURIComponent(s.login)}`), { live: true, viewers: s.viewers, uptime: formatUptime(s.startedAt) }),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-title', title: s.title }, s.title || s.name),
      h('div', { class: 'card-meta' }, s.name, s.game ? ` · ${s.game}` : '')),
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn primary sm', onclick: () => ctx.navigate(`/watch?c=${encodeURIComponent(s.login)}`) }, icon('play'), 'Play'),
      h('button', { class: 'btn sm', onclick: () => ctx.addToMultiview(s.login), title: 'Add to multiview' }, icon('grid'), 'Multiview'),
      h('button', { class: 'btn sm', onclick: () => ctx.navigate(`/vods?c=${encodeURIComponent(s.login)}`), 'aria-label': `VODs for ${s.name}`, title: 'VODs' }, icon('film'))));
}

function channelCard(c) {
  return h('article', { class: 'card' },
    thumb(c.thumbnail, c.login, () => ctx.navigate(`/watch?c=${encodeURIComponent(c.login)}`), { live: c.live, uptime: c.live ? formatUptime(c.startedAt) : '' }),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-title' }, c.name, ' ', h('span', { class: `chip ${c.live ? 'ok' : ''}` }, c.live ? 'live' : 'offline')),
      h('div', { class: 'card-meta', title: c.title }, c.live ? [c.game, c.title].filter(Boolean).join(' · ') : (c.title || c.game || ''))),
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn primary sm', onclick: () => ctx.navigate(`/watch?c=${encodeURIComponent(c.login)}`) }, icon('play'), c.live ? 'Play' : 'Open'),
      h('button', { class: 'btn sm', onclick: () => ctx.addToMultiview(c.login), title: 'Add to multiview' }, icon('grid'), 'Multiview'),
      h('button', { class: 'btn sm', onclick: () => ctx.navigate(`/vods?c=${encodeURIComponent(c.login)}`), title: 'VODs', 'aria-label': `VODs for ${c.name}` }, icon('film'))));
}

function vodCard(v) {
  return h('article', { class: 'card' },
    thumb(v.thumbnail, v.login, () => ctx.navigate(`/watch?v=${encodeURIComponent(v.id)}`), { duration: v.duration }),
    h('div', { class: 'card-body' },
      h('div', { class: 'card-title', title: v.title }, v.title),
      h('div', { class: 'card-meta' }, `${formatDate(v.createdAt)} · ${formatViewers(v.views)} views`)),
    h('div', { class: 'card-actions' },
      h('button', { class: 'btn primary sm', onclick: () => ctx.navigate(`/watch?v=${encodeURIComponent(v.id)}`) }, icon('play'), 'Play VOD')));
}

/**
 * Generic paginated list. fetchPage(cursor) -> {items, cursor}. "Load more" uses Helix cursors.
 */
function pagedGrid(fetchPage, renderItem, { empty = 'Nothing here yet.', gridClass = '' } = {}) {
  const wrap = h('div', {});
  const grid = h('div', { class: gridClass ? `grid ${gridClass}` : 'grid' });
  const more = h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '18px' } });
  const status = h('div', {});
  let cursor = null, loading = false, any = false;

  async function load(first) {
    if (loading) return;
    loading = true;
    clear(status);
    if (first) { clear(grid); wrap.replaceChildren(skeletons(), more); }
    more.replaceChildren(h('div', { class: 'spinner', 'aria-label': 'Loading' }));
    try {
      const r = await fetchPage(first ? null : cursor);
      if (first) wrap.replaceChildren(status, grid, more);
      r.items.forEach((it) => grid.append(renderItem(it)));
      any = any || r.items.length > 0;
      cursor = r.cursor;
      more.replaceChildren(cursor ? h('button', { class: 'btn', onclick: () => load(false) }, 'Load more') : '');
      if (!any) wrap.replaceChildren(emptyState('Nothing found', empty));
    } catch (e) {
      if (first) wrap.replaceChildren(errorBox(e, () => load(true)));
      else { status.replaceChildren(errorBox(e, () => load(false))); more.replaceChildren(); }
    } finally { loading = false; }
  }
  load(true);
  return wrap;
}

// ---- Login modal -------------------------------------------------------------------
export async function openLogin(message) {
  const input = h('input', { type: 'text', placeholder: 'http://localhost/#access_token=…  (or a raw token)', 'aria-label': 'Redirect URL or token', autocomplete: 'off', spellcheck: 'false' });
  const err = h('div', { class: 'chip err', hidden: true, role: 'alert' });
  const qrBox = h('div', { class: 'qr', 'aria-label': 'QR code' });
  const urlBox = h('input', { type: 'text', readonly: true, 'aria-label': 'Authorize URL' });
  let m;
  const submit = async () => {
    err.hidden = true;
    const val = input.value.trim();
    if (!val) return false;
    try {
      await api('/api/auth/login', { method: 'POST', body: /access_token=/.test(val) || val.includes('://') ? { redirectUrl: val } : { token: val } });
      await ctx.refreshAuth();
      toast('Logged in', 'ok');
      return true;
    } catch (e) { err.textContent = e.message; err.hidden = false; return false; }
  };
  m = modal({
    title: 'Log in with Twitch',
    body: [
      message ? h('p', { class: 'muted' }, message) : null,
      h('p', {}, '1. Open the authorize link (or scan the QR code on your phone) and approve.', h('br'),
        '2. Twitch redirects to a page that will not load — copy that full address and paste it below.'),
      h('div', { class: 'row' }, qrBox, h('div', { style: { flex: 1, minWidth: '220px', display: 'grid', gap: '8px' } }, urlBox,
        h('div', { class: 'row' },
          h('a', { class: 'btn primary', id: 'authLink', target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Open authorize page'),
          h('button', { class: 'btn', onclick: async () => toast((await copyText(urlBox.value)) ? 'Copied' : 'Copy failed', 'info', { timeout: 1500 }) }, icon('copy'), 'Copy')))),
      input, err,
    ],
    actions: [{ label: 'Log in', primary: true, keepOpen: true, onClick: async () => { if (await submit()) m.close(); return false; } }],
  });
  input.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { e.preventDefault(); if (await submit()) m.close(); } });
  try {
    const info = await api('/api/auth/login-info');
    qrBox.innerHTML = info.qrSvg; // server-generated SVG from our own URL
    urlBox.value = info.authUrl;
    m.el.querySelector('#authLink').href = info.authUrl;
  } catch (e) { err.textContent = e.message; err.hidden = false; }
  return m;
}

export async function doLogout() {
  if (!(await confirmDialog('Log out?', 'This removes the stored Twitch token from this computer.', 'Log out'))) return;
  await api('/api/auth/logout', { method: 'POST' });
  await ctx.refreshAuth();
  toast('Logged out', 'info');
}

export function openUserMenu() {
  const a = ctx.auth;
  const body = a.loggedIn
    ? [h('p', {}, 'Signed in as ', h('strong', {}, a.user || 'unknown'), a.state === 'unknown' ? ' (not yet verified)' : ''), h('p', { class: 'muted' }, `Token source: ${a.tokenSource || 'unknown'}`)]
    : [h('p', {}, a.state === 'expired' ? 'Your login expired. Log in again to use followed streams and browsing.' : 'Not logged in. Playback works anonymously; browsing and followed streams need a login.')];
  const m = modal({
    title: 'Account', body,
    actions: a.loggedIn
      ? [{ label: 'Log out', danger: true, onClick: () => { setTimeout(doLogout, 0); } }]
      : [{ label: 'Log in', primary: true, onClick: () => { setTimeout(() => openLogin(), 0); } }],
  });
  return m;
}

// ---- Home ------------------------------------------------------------------------------
export function homeView() {
  const input = h('input', { type: 'text', placeholder: 'channel name or twitch.tv URL', 'aria-label': 'Channel or URL', autocomplete: 'off', spellcheck: 'false' });
  const go = (value) => { const v = value.trim(); if (v) ctx.navigate(`/watch?q=${encodeURIComponent(v)}`); };
  const recent = getRecent();
  return h('div', {},
    h('h1', {}, 'Play'),
    h('p', { class: 'sub' }, 'Ad-filtered Twitch playback in your browser. Paste a channel, VOD or clip.'),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); go(input.value); } }, input, h('button', { class: 'btn primary', type: 'submit' }, icon('play'), 'Play')),
    recent.length ? [h('h2', {}, 'Recent'), h('div', { class: 'row' }, recent.map((c) => h('button', { class: 'chip', style: { cursor: 'pointer', border: 0 }, onclick: () => go(c) }, c)))] : null,
    ctx.auth.loggedIn ? null : h('div', { class: 'card-panel', style: { marginTop: '24px' } }, h('strong', {}, 'Log in for more'), h('p', { class: 'muted' }, 'Followed live channels, browsing by category, channel search and VOD lists need a Twitch login.'),
      h('button', { class: 'btn primary', onclick: () => openLogin() }, 'Log in')),
    h('h2', {}, 'Quick links'),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: '/multiview', 'data-link': '' }, icon('grid'), 'Multiview'),
      h('a', { class: 'btn', href: '/browse', 'data-link': '' }, icon('compass'), 'Browse'),
      h('a', { class: 'btn', href: '/diagnostics', 'data-link': '' }, icon('activity'), 'Diagnostics')));
}

// ---- Followed --------------------------------------------------------------------------------
export function followedView() {
  return h('div', {}, h('h1', {}, 'Followed — live now'), h('p', { class: 'sub' }, 'Channels you follow that are streaming right now.'),
    pagedGrid((after) => api(`/api/followed${after ? `?after=${encodeURIComponent(after)}` : ''}`), streamCard, { empty: 'None of the channels you follow are live.' }));
}

// ---- Browse -------------------------------------------------------------------------------------
export function browseView(params) {
  const gameId = params.get('game');
  const gameName = params.get('name');
  const root = h('div', {});
  if (gameId) {
    root.append(
      h('div', { class: 'row' }, h('a', { class: 'btn sm', href: '/browse', 'data-link': '' }, '← Categories'), h('h1', { style: { margin: 0 } }, gameName || 'Category')),
      h('p', { class: 'sub' }, 'Live streams, most viewers first.'),
      pagedGrid((after) => api(`/api/games/${encodeURIComponent(gameId)}/streams${after ? `?after=${encodeURIComponent(after)}` : ''}`), streamCard, { empty: 'Nobody is live in this category.' }));
    return root;
  }
  const input = h('input', { type: 'search', placeholder: 'Search categories…', 'aria-label': 'Search categories' });
  const results = h('div', {});
  const gameCard = (g) => h('article', { class: 'card' },
    h('button', { class: 'thumb', style: { aspectRatio: '3/4' }, onclick: () => ctx.navigate(`/browse?game=${encodeURIComponent(g.id)}&name=${encodeURIComponent(g.name)}`), 'aria-label': g.name },
      h('img', { src: g.boxArt, alt: '', loading: 'lazy', onerror: (e) => { e.target.style.visibility = 'hidden'; } })),
    h('div', { class: 'card-body' }, h('div', { class: 'card-title' }, g.name)));
  const showTop = () => results.replaceChildren(pagedGrid((after) => api(`/api/games/top${after ? `?after=${encodeURIComponent(after)}` : ''}`), gameCard, { gridClass: 'cats' }));
  const search = debounce(async () => {
    const q = input.value.trim();
    if (!q) return showTop();
    results.replaceChildren(skeletons(4));
    try {
      const r = await api(`/api/games/search?q=${encodeURIComponent(q)}`);
      results.replaceChildren(r.games.length ? h('div', { class: 'grid cats' }, r.games.map(gameCard)) : emptyState('No categories found', `Nothing matched “${q}”.`));
    } catch (e) { results.replaceChildren(errorBox(e, search)); }
  }, 350);
  input.addEventListener('input', search);
  root.append(h('h1', {}, 'Browse'), h('p', { class: 'sub' }, 'Pick a category to see who is live.'), input, h('div', { style: { height: '16px' } }), results);
  showTop();
  return root;
}

// ---- Search ------------------------------------------------------------------------------------------
export function searchView(params) {
  const input = h('input', { type: 'search', value: params.get('q') || '', placeholder: 'Search channels…', 'aria-label': 'Search channels' });
  const results = h('div', {});
  const run = () => {
    const q = input.value.trim();
    history.replaceState(null, '', q ? `/search?q=${encodeURIComponent(q)}` : '/search');
    if (!q) return results.replaceChildren(emptyState('Search channels', 'Find live and offline channels by name.'));
    return results.replaceChildren(pagedGrid((after) => api(`/api/channels/search?q=${encodeURIComponent(q)}${after ? `&after=${encodeURIComponent(after)}` : ''}`), channelCard, { empty: `No channels matched “${q}”.` }));
  };
  const debounced = debounce(run, 400);
  input.addEventListener('input', debounced);
  const root = h('div', {}, h('h1', {}, 'Search'), h('p', { class: 'sub' }, 'Live and offline channels.'), input, h('div', { style: { height: '16px' } }), results);
  run();
  return root;
}

// ---- VODs ----------------------------------------------------------------------------------------------
export function vodsView(params) {
  const login = (params.get('c') || '').trim();
  const input = h('input', { type: 'text', value: login, placeholder: 'channel name', 'aria-label': 'Channel' });
  const results = h('div', {});
  const load = () => {
    const c = input.value.trim().toLowerCase();
    if (!c) return results.replaceChildren(emptyState('Channel VODs', 'Enter a channel to list its past broadcasts.'));
    history.replaceState(null, '', `/vods?c=${encodeURIComponent(c)}`);
    return results.replaceChildren(pagedGrid((after) => api(`/api/channels/${encodeURIComponent(c)}/vods${after ? `?after=${encodeURIComponent(after)}` : ''}`), vodCard, { empty: `${c} has no recent VODs.` }));
  };
  const root = h('div', {}, h('h1', {}, 'VODs'), h('p', { class: 'sub' }, 'Past broadcasts for a channel.'),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load(); } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Show VODs')),
    h('div', { style: { height: '16px' } }), results);
  load();
  return root;
}

// ---- Watch ---------------------------------------------------------------------------------------------------
// The player lives in a "session" that outlives the page: leaving /watch docks it
// in the miniplayer (see mini.js); coming back to the same stream re-adopts it.
const normInput = (s) => String(s || '').trim().toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').replace(/\/+$/, '');
function sameStream(sess, raw) {
  const a = normInput(raw);
  if (a === normInput(sess.raw)) return true;
  const m = sess.player.meta;
  return !!(m && m.kind === 'live' && m.channel && a === m.channel.toLowerCase());
}

async function playLatestVod(channel) {
  if (!channel) return;
  if (!ctx.auth.loggedIn) { openLogin('Listing VODs needs a Twitch login.'); return; }
  try {
    const r = await api(`/api/channels/${encodeURIComponent(channel)}/latest-vod`);
    ctx.navigate(`/watch?v=${encodeURIComponent(r.vod.id)}`);
  } catch (e) { if (needsLogin(e)) openLogin(); else toast(e.message, 'err'); }
}

function offlinePanel(player) {
  const meta = player.meta;
  const name = meta?.displayName || meta?.channel || 'This channel';
  return h('div', { class: 'stack' }, h('strong', {}, `${name} is offline`), h('div', { class: 'muted' }, 'Play the latest VOD instead?'),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => playLatestVod(meta?.channel) }, icon('film'), 'Play latest VOD'),
      h('button', { class: 'btn', onclick: () => player.reload() }, icon('refresh'), 'Check again'),
      h('button', { class: 'btn', onclick: () => ctx.navigate(`/vods?c=${encodeURIComponent(meta?.channel || '')}`) }, 'All VODs')));
}

function createWatchSession(raw) {
  const box = h('div', { class: 'player-box' });
  const overlay = h('div', { class: 'overlay' });
  box.append(overlay);
  const player = new StreamPlayer(box, { mode: 'single', getSettings: () => ctx.settings });
  const state = { channel: null, adblock: ctx.settings.adblock !== false, audioOnly: !!ctx.settings.audioOnly, lowLatency: !!ctx.settings.lowLatency, quality: ctx.settings.quality || null };
  const sess = { raw, box, player, state, controls: null, idleTimer: null, cleanups: [] };
  const listen = (t, ev, fn) => { t.addEventListener(ev, fn); sess.cleanups.push(() => t.removeEventListener(ev, fn)); };

  // ---- controls: play, seek (VOD + live DVR), volume, live, fullscreen ----
  const toggleFs = () => { if (document.fullscreenElement === box) document.exitFullscreen(); else box.requestFullscreen?.().catch(() => {}); };
  sess.toggleFs = toggleFs;
  const fsBtn = h('button', { class: 'icon-btn', 'aria-label': 'Fullscreen', title: 'Fullscreen (F)', onclick: toggleFs }, icon('fullscreen'));
  const controls = new Controls({ extras: [fsBtn] });
  controls.bind(player);
  sess.controls = controls;
  box.append(h('div', { class: 'pc-bar' }, controls.el));
  const mini = buildMiniBar(sess);
  box.append(mini.bar);
  listen(player.video, 'click', () => { if (box.classList.contains('mini')) expandMini(); else player.togglePause(); });
  listen(player.video, 'dblclick', () => { if (!box.classList.contains('mini')) toggleFs(); });

  // Auto-hide the control bar while playing and the mouse is still.
  const wake = () => {
    box.classList.remove('idle');
    clearTimeout(sess.idleTimer);
    sess.idleTimer = setTimeout(() => {
      // Stay visible while paused or while the pointer rests on the control bar.
      // (No :focus-within check: clicking the fullscreen button leaves focus inside
      // the box, which kept the bar on screen forever in fullscreen.)
      if (player.video.paused || box.querySelector('.pc-bar:hover') || box.classList.contains('mini')) return;
      box.classList.add('idle');
    }, 2800);
  };
  sess.wake = wake;
  listen(box, 'mousemove', wake);
  listen(box, 'mouseleave', () => { if (!player.video.paused && !box.classList.contains('mini')) box.classList.add('idle'); });
  listen(box, 'focusin', wake);
  listen(box, 'keydown', wake);
  listen(player.video, 'pause', () => { clearTimeout(sess.idleTimer); box.classList.remove('idle'); });
  listen(player.video, 'play', wake);
  // Entering/leaving fullscreen: show the bar, then let the timer hide it.
  listen(document, 'fullscreenchange', wake);

  const paint = (name) => {
    clear(overlay);
    overlay.hidden = name === 'playing' || name === 'buffering';
    if (name === 'loading') overlay.append(h('div', { class: 'stack' }, h('div', { class: 'spinner' }), h('div', {}, 'Connecting…')));
    if (name === 'error') overlay.append(h('div', { class: 'stack' }, h('strong', {}, 'Playback failed'), h('div', {}, player.error),
      h('div', { class: 'row' }, ['auth_required', 'token_expired'].includes(player.errorCode) ? h('button', { class: 'btn primary', onclick: () => openLogin() }, 'Log in') : null, h('button', { class: 'btn primary', onclick: () => player.reload() }, icon('refresh'), 'Retry'))));
    if (name === 'offline') overlay.append(offlinePanel(player));
    if (name === 'buffering') { overlay.hidden = false; overlay.style.background = 'transparent'; overlay.style.pointerEvents = 'none'; overlay.append(h('div', { class: 'spinner' })); } else { overlay.style.background = ''; overlay.style.pointerEvents = ''; }
  };
  paint('loading');

  listen(player, 'state', (e) => paint(e.detail));
  listen(player, 'error', (e) => { if (needsLogin(e.detail)) openLogin(e.detail.message); });
  listen(player, 'ended', () => paint('idle'));
  listen(player, 'meta', (e) => {
    const m = e.detail;
    mini.setTitle(m.displayName || m.channel || m.title || '');
    if (m.status === 'offline') return;
    state.channel = m.channel || state.channel;
    if (m.kind === 'live' && m.channel) pushRecent(m.channel);
  });
  listen(player, 'session', (e) => { if (e.detail.level === 'warn') toast(e.detail.message, 'warn'); });

  sess.start = () => player.start(raw, { quality: state.quality, adblock: state.adblock, audioOnly: state.audioOnly, lowLatency: state.lowLatency });
  sess.destroy = () => {
    sess.cleanups.forEach((fn) => fn());
    clearTimeout(sess.idleTimer);
    controls.destroy();
    player.destroy();
    box.remove();
  };
  return sess;
}

export function watchView(params, onCleanup) {
  const raw = params.get('q') || params.get('c') || (params.get('v') ? `https://www.twitch.tv/videos/${params.get('v')}` : '');
  const root = h('div', { class: 'watch' });
  if (!raw) { root.append(emptyState('Nothing to play', 'Enter a channel or URL in the bar above.')); return root; }

  const slot = h('div', { class: 'player-slot' });
  let sess = getSession();
  const resumed = !!(sess && sameStream(sess, raw));
  if (resumed) adopt(slot);
  else {
    closeMini();
    sess = createWatchSession(raw);
    setSession(sess);
    slot.append(sess.box);
  }
  const { player, state, box, controls } = sess;

  const titleEl = h('h1', { style: { margin: 0, fontSize: '18px' } }, '');
  const subEl = h('div', { class: 'muted' }, '');
  const chips = h('div', { class: 'row' });
  const qualitySel = h('select', { 'aria-label': 'Quality' });
  const audioBtn = h('button', { class: 'icon-btn', 'aria-label': 'Audio only', 'aria-pressed': String(!!state.audioOnly), title: 'Audio only' }, icon('volume'));
  const llBtn = h('button', { class: 'btn sm', 'aria-pressed': String(!!state.lowLatency), title: 'Low latency mode' }, 'Low latency');
  const abBtn = h('button', { class: 'btn sm', 'aria-pressed': String(state.adblock !== false), title: 'Toggle ad-block for this stream' }, icon('shield'), 'Ad-block');
  const statusChip = h('span', { class: 'chip' }, '');
  const logBtn = h('button', { class: 'btn sm' }, 'Events');
  const chatBtn = h('button', { class: 'icon-btn', 'aria-label': 'Toggle chat', 'aria-pressed': 'false', title: 'Chat' }, icon('chat'));
  const chatBox = h('div', { class: 'chat-col', hidden: true });
  const eventLog = h('div', { class: 'card-panel mono', hidden: true, style: { maxHeight: '180px', overflow: 'auto' } });

  const cleanups = [];
  const listen = (t, ev, fn) => { t.addEventListener(ev, fn); cleanups.push(() => t.removeEventListener(ev, fn)); };

  // Keep the chat column exactly as tall as the visible page area and pin it
  // while the page scrolls (see .watch.with-chat .chat-col in app.css), so the
  // composer is always on screen and the message list scrolls inside the panel.
  const viewEl = document.getElementById('view');
  function fitChat() {
    if (chatBox.hidden || window.innerWidth <= 900) { chatBox.style.height = ''; return; }
    chatBox.style.height = `${Math.max(320, viewEl.clientHeight - 60)}px`; // 60 = #view top+bottom padding
  }
  const chatRO = new ResizeObserver(fitChat);
  chatRO.observe(viewEl);
  listen(window, 'resize', fitChat); // covers breakpoint switches RO may miss
  cleanups.push(() => chatRO.disconnect());

  // Theater mode = let the player use more of the screen.
  const theaterBtn = h('button', { class: 'btn sm', 'aria-pressed': 'false', title: 'Bigger player (T)' }, 'Theater');
  const setTheater = (on) => { root.classList.toggle('theater', on); theaterBtn.setAttribute('aria-pressed', String(on)); store.set('theater', on); };
  theaterBtn.addEventListener('click', () => setTheater(!root.classList.contains('theater')));

  const onKey = (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey || document.getElementById('modalRoot').children.length) return;
    const vol = (d) => { const v = player.video; v.muted = false; v.volume = Math.min(1, Math.max(0, v.volume + d)); store.set('volume', v.volume); };
    switch (e.key) {
      case ' ': case 'k': e.preventDefault(); player.togglePause(); break;
      case 'ArrowLeft': e.preventDefault(); controls.skip(-5); break;
      case 'ArrowRight': e.preventDefault(); controls.skip(5); break;
      case 'j': controls.skip(-10); break;
      case 'l': controls.skip(10); break;
      case 'ArrowUp': e.preventDefault(); vol(0.05); break;
      case 'ArrowDown': e.preventDefault(); vol(-0.05); break;
      case 'm': controls.toggleMute(); break;
      case 'f': sess.toggleFs(); break;
      case 't': setTheater(!root.classList.contains('theater')); break;
      case 'End': controls.goLive(); break;
      default: return;
    }
    sess.wake();
  };
  listen(document, 'keydown', onKey);
  // Leaving the page docks the player in the miniplayer instead of stopping it.
  onCleanup(() => { cleanups.forEach((fn) => fn()); park(); });

  const paintMeta = (m) => {
    if (m.status === 'offline') { titleEl.textContent = m.displayName || m.channel; subEl.textContent = 'Offline'; return; }
    titleEl.textContent = m.title || m.displayName || 'Twitch';
    subEl.textContent = [m.displayName, m.game, m.kind === 'vod' ? `${m.duration || ''} · ${formatDate(m.createdAt)}` : null].filter(Boolean).join(' · ');
    clear(chips);
    if (m.kind === 'live') chips.append(h('span', { class: 'chip live' }, 'LIVE'), h('span', { class: 'chip' }, `${formatViewers(m.viewers)} viewers`), m.startedAt ? h('span', { class: 'chip' }, `up ${formatUptime(m.startedAt)}`) : null);
    abBtn.setAttribute('aria-pressed', String(!!m.adblock));
    abBtn.disabled = m.kind !== 'live';
    if (m.kind === 'clip') qualitySel.disabled = true;
    // Chat only makes sense on live streams.
    chatBtn.hidden = m.kind !== 'live';
    if (m.kind !== 'live' && chatBtn.getAttribute('aria-pressed') === 'true') showChat(false);
    else if (chatBtn.getAttribute('aria-pressed') === 'true') showChat(true);
  };
  const policyValue = () => {
    const p = player.policy;
    return p.type === 'audio' ? 'audio_only' : p.type === 'auto' ? 'auto' : p.type === 'lock' ? p.key : '';
  };
  const fillLevels = () => {
    clear(qualitySel);
    qualitySel.append(h('option', { value: '' }, 'Best (source)'));
    for (const l of player.levels()) qualitySel.append(h('option', { value: l.audioOnly ? 'audio_only' : (l.key || String(l.index)) }, l.label));
    qualitySel.append(h('option', { value: 'auto' }, 'Auto (adaptive)'));
    qualitySel.value = resumed ? policyValue() : (state.audioOnly ? 'audio_only' : '');
  };
  const paintStats = (s) => {
    const { latency, level } = s;
    statusChip.textContent = [level ? `${level.label}` : '', latency ? `${latency.toFixed(1)}s behind live` : ''].filter(Boolean).join(' · ');
  };
  const logLine = (ev) => { eventLog.append(h('div', {}, `${new Date(ev.ts).toLocaleTimeString()}  ${ev.message}`)); eventLog.scrollTop = eventLog.scrollHeight; };

  listen(player, 'meta', (e) => paintMeta(e.detail));
  listen(player, 'levels', fillLevels);
  listen(player, 'stats', (e) => paintStats(e.detail));
  listen(player, 'session', (e) => logLine(e.detail));

  qualitySel.addEventListener('change', () => {
    const v = qualitySel.value;
    if (v === '') player.setPolicy({ type: 'chosen' });
    else if (v === 'auto') player.setPolicy({ type: 'auto' });
    else if (v === 'audio_only') player.setPolicy({ type: 'audio' });
    else player.setPolicy({ type: 'lock', key: v });
  });
  audioBtn.addEventListener('click', () => {
    state.audioOnly = !state.audioOnly;
    audioBtn.setAttribute('aria-pressed', String(state.audioOnly));
    player.setPolicy(state.audioOnly ? { type: 'audio' } : { type: 'chosen' });
    qualitySel.value = state.audioOnly ? 'audio_only' : '';
  });
  llBtn.addEventListener('click', () => { state.lowLatency = !state.lowLatency; llBtn.setAttribute('aria-pressed', String(state.lowLatency)); sess.start(); });
  abBtn.addEventListener('click', () => { state.adblock = !state.adblock; sess.start(); });
  logBtn.addEventListener('click', () => { eventLog.hidden = !eventLog.hidden; });

  let chatPanel = null;
  function showChat(on) {
    chatBtn.setAttribute('aria-pressed', String(on));
    root.classList.toggle('with-chat', on);
    chatBox.hidden = !on;
    if (!on) {
      chatPanel?.destroy();
      chatPanel = null;
      clear(chatBox);
      return;
    }
    fitChat();
    // Native chat via the server's IRC bridge (web/js/chat.js). Rebuild only
    // when the channel actually changed, so repaints keep the scrollback.
    if (!state.channel || chatPanel?.channel === state.channel) return;
    chatPanel?.destroy();
    clear(chatBox);
    chatPanel = createChatPanel({
      login: state.channel,
      displayName: player.meta?.displayName || state.channel,
      auth: () => ctx.auth,
      requestLogin: () => openLogin(),
      embedSrc: `https://www.twitch.tv/embed/${encodeURIComponent(state.channel)}/chat?parent=${location.hostname}&darkpopout`,
    });
    chatBox.append(chatPanel.el);
  }
  chatBtn.addEventListener('click', () => showChat(chatBtn.getAttribute('aria-pressed') !== 'true'));
  cleanups.push(() => { chatPanel?.destroy(); chatPanel = null; });

  const actions = h('div', { class: 'row' },
    h('button', { class: 'btn sm', onclick: () => player.reload() }, icon('refresh'), 'Reload'),
    qualitySel, audioBtn, llBtn, abBtn, theaterBtn, statusChip, h('span', { class: 'spacer' }),
    logBtn,
    h('button', { class: 'btn sm', onclick: async () => { const sid = player.sessionId; if (!sid) return; toast((await copyText(`${location.origin}/proxy/${sid}/master.m3u8`)) ? 'Proxy URL copied (valid while this tab is open)' : 'Copy failed', 'info'); } }, icon('link'), 'Copy proxy URL'),
    h('button', { class: 'btn sm', onclick: async () => {
      if (!player.sessionId) return;
      try { const r = await api('/api/external-player', { method: 'POST', body: { sessionId: player.sessionId } }); toast(`Opened in ${r.player}`, 'ok'); } catch (e) { toast(e.message, 'err'); }
    }, hidden: !ctx.meta.canSpawn }, icon('external'), 'External player'),
    h('button', { class: 'btn sm', onclick: () => state.channel && ctx.addToMultiview(state.channel), title: 'Add to multiview' }, icon('grid'), 'Add to multiview'),
    h('button', { class: 'btn sm', onclick: () => { if (state.channel) ctx.navigate(`/diagnostics?c=${encodeURIComponent(state.channel)}`); else toast('Diagnostics: channel not loaded yet', 'info'); }, title: 'Token flavors and renditions for this channel' }, icon('activity'), 'Diagnostics'),
    chatBtn);

  const main = h('div', { class: 'watch-main' }, slot, h('div', {}, titleEl, subEl), chips, actions, eventLog);
  root.append(main, chatBox);
  setTheater(store.get('theater', false));

  if (resumed) {
    // Re-populate the page chrome from the already-running session.
    if (player.meta) paintMeta(player.meta);
    if (player.hls?.levels?.length) fillLevels();
    paintStats(player.stats());
    player.events.forEach(logLine);
    sess.wake();
  } else {
    sess.start();
  }
  return root;
}

// ---- Diagnostics --------------------------------------------------------------------------------------------
const FLAVOR_STATUS = { 'no-token': 'no token issued', 'usher-error': 'usher error', empty: 'empty playlist' };
const fmtBw = (b) => (!b ? '-' : b >= 1e6 ? `${(b / 1e6).toFixed(2)} Mbps` : `${Math.round(b / 1000)} kbps`);

export function diagnosticsView(params) {
  const input = h('input', { type: 'text', value: params.get('c') || '', placeholder: 'live channel name', 'aria-label': 'Channel' });
  const out = h('div', {});
  async function run() {
    const c = input.value.trim().toLowerCase().split('/').pop();
    if (!c) return;
    history.replaceState(null, '', `/diagnostics?c=${encodeURIComponent(c)}`);
    out.replaceChildren(skeletons(2));
    try {
      const [dRes, iRes] = await Promise.allSettled([
        api(`/api/diagnostics/${encodeURIComponent(c)}`),
        api(`/api/stream/${encodeURIComponent(c)}/info`),
      ]);
      if (dRes.status === 'rejected') throw dRes.reason;
      const d = dRes.value;
      const info = iRes.status === 'fulfilled' ? iRes.value : null;
      const notFound = iRes.status === 'rejected' && iRes.reason?.status === 404;
      const kids = [
        h('h2', {}, 'Channel status'),
        h('div', { class: 'row' },
          info
            ? info.online
              ? [h('span', { class: 'chip live' }, 'LIVE'),
                info.viewers != null ? h('span', { class: 'chip' }, `${formatViewers(info.viewers)} viewers`) : null,
                info.startedAt ? h('span', { class: 'chip' }, `up ${formatUptime(info.startedAt)}`) : null]
              : h('span', { class: 'chip warn' }, 'OFFLINE')
            : h('span', { class: `chip ${notFound ? 'err' : ''}` }, notFound ? 'Channel not found' : 'status unavailable')),
        h('h2', {}, 'Token status'),
        h('div', { class: 'row' },
          h('span', { class: `chip ${d.auth.loggedIn ? 'ok' : 'warn'}` }, d.auth.loggedIn ? `logged in as ${d.auth.user || '?'}` : 'not logged in'),
          h('span', { class: `chip ${d.webTokenSet ? 'ok' : ''}` }, d.webTokenSet ? 'TWITCH_WEB_AUTH_TOKEN set' : 'TWITCH_WEB_AUTH_TOKEN not set'),
          h('span', { class: 'chip info' }, `last token mode: ${d.lastTokenMode || '—'}`)),
        Object.keys(d.tokenFailures).length ? h('div', {},
          h('p', { class: 'muted' }, 'Recent token-mode failures (server-wide; includes playback attempts):'),
          h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, h('th', {}, 'Mode'), h('th', {}, 'Failure reason'))),
          h('tbody', {}, Object.entries(d.tokenFailures).map(([m, r]) => h('tr', {}, h('td', {}, m), h('td', { class: 'mono' }, r))))))) : h('p', { class: 'muted' }, 'No token mode failures recorded.'),
        // replaceChildren() does not flatten arrays — wrap the flavor list.
        h('div', {}, d.flavors.map((f) => h('div', {},
          h('h2', {}, f.flavor, ' ', h('span', { class: `chip ${f.status === 'ok' ? 'ok' : 'err'}` }, f.status === 'ok' ? `token: ${f.tokenMode}` : (f.error || FLAVOR_STATUS[f.status] || f.status))),
          f.variants.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
            h('thead', {}, h('tr', {}, ['VIDEO id', 'Name', 'Resolution', 'FPS', 'Bitrate', 'Codecs'].map((x) => h('th', {}, x)))),
            h('tbody', {}, f.variants.map((v) => h('tr', {}, h('td', {}, v.video), h('td', {}, v.name), h('td', {}, v.resolution), h('td', {}, v.fps ?? '-'), h('td', {}, fmtBw(v.bandwidth)), h('td', { class: 'mono' }, `${v.family} · ${v.codecs}`)))))) : null))),
      ];
      if (notFound) kids.splice(2, 0, h('p', { class: 'muted' }, 'No such Twitch channel — the flavor tables below cannot return anything useful.'));
      else if (info && !info.online) kids.splice(2, 0, h('div', { class: 'card-panel' },
        h('strong', {}, 'Twitch issues no playback tokens for offline channels'),
        h('p', { class: 'muted' }, 'Every flavor below will read “no token issued” — that is expected, not an app failure. Inspect a channel that is live right now for rendition tables; the auth chips and failure history are still valid.')));
      out.replaceChildren(...kids);
    } catch (e) { out.replaceChildren(errorBox(e, run)); }
  }
  const root = h('div', {}, h('h1', {}, 'Diagnostics'),
    h('p', { class: 'sub' }, 'What every token flavor offers for a live channel. Pick a channel streaming right now — offline channels get no playback tokens at all.'),
    h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); run(); } }, input, h('button', { class: 'btn primary', type: 'submit' }, 'Inspect')), out);
  if (input.value) run();
  return root;
}

// ---- Settings ----------------------------------------------------------------------------------------------------
export function settingsView() {
  const s = { ...ctx.settings };
  const dirty = {};
  const set = (k, v) => { dirty[k] = v; saveBtn.disabled = false; };
  const check = (k) => h('input', { type: 'checkbox', checked: !!s[k], onchange: (e) => set(k, e.target.checked) });
  const text = (k, ph = '') => h('input', { type: 'text', value: s[k] ?? '', placeholder: ph, onchange: (e) => set(k, e.target.value.trim() || null) });
  const num = (k, min, max) => h('input', { type: 'number', value: s[k], min, max, onchange: (e) => set(k, Number(e.target.value)) });
  const sel = (k, opts) => h('select', { onchange: (e) => set(k, e.target.value) }, opts.map(([v, l]) => h('option', { value: v, selected: s[k] === v }, l)));
  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', {}, label, hint ? h('small', {}, hint) : null), control);
  const saveBtn = h('button', { class: 'btn primary', disabled: true, onclick: async () => {
    try { await ctx.saveSettings(dirty); Object.keys(dirty).forEach((k) => delete dirty[k]); saveBtn.disabled = true; toast('Settings saved', 'ok'); } catch (e) { toast(e.message, 'err'); }
  } }, icon('save'), 'Save settings');

  const webTok = h('input', { type: 'password', placeholder: ctx.auth.webTokenSet ? '•••••••• (set)' : 'auth-token cookie value', autocomplete: 'off' });
  const quality = h('input', { type: 'text', value: s.quality ?? '', placeholder: 'blank = source/best, e.g. 720p60, 480p, audio_only', onchange: (e) => set('quality', e.target.value.trim() || null) });
  const players = ctx.meta.players ?? [];

  return h('div', {}, h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Stored in ~/.config/twitch-webui/config.json'),
    h('div', { class: 'form-grid' },
      h('h2', {}, 'Playback'),
      field('Default quality', quality, 'Used for single streams and focused multiview tiles'),
      field('Ad-block proxy', check('adblock'), 'Filter mid-roll ads by rotating token flavors'),
      field('Audio only', check('audioOnly')),
      field('Low latency', check('lowLatency')),
      field('Larger buffer', check('cache'), 'Trades latency for fewer stalls'),
      field('Buffer length (s)', num('bufferSeconds', 5, 300)),
      field('Proxy segments through server', check('proxySegments'), 'Avoids CORS problems; off = browser fetches segments directly'),
      h('h2', {}, 'Interface'),
      field('Theme', sel('theme', [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']])),
      field('List page size', num('pageSize', 5, 50)),
      field('Debug logging', check('debug'), 'Shows a log drawer; tokens are always redacted'),
      field('Log file', text('logFile', '~/.cache/twitch-webui.log')),
      field('Use keyring', check('useKeyring'), 'Requires the optional “keytar” package'),
      h('h2', {}, 'Multiview'),
      field('Default layout', sel('mvLayout', [['2h', '2 · side by side'], ['2v', '2 · stacked'], ['2x2', '4 · grid'], ['1+3', '4 · 1 large + 3'], ['3x2', '6 · grid'], ['1+5', '6 · 1 large + 5']])),
      field('Audio focus', sel('mvAudioFocus', [['follow', 'One tile unmuted (follows focus)'], ['muted', 'All muted on start']])),
      field('Unfocused tile cap', sel('mvCapQuality', [['none', 'No cap'], ['360p', '360p'], ['480p', '480p'], ['720p', '720p']]), 'Saves bandwidth and CPU'),
      field('Start stagger (ms)', num('mvStaggerMs', 0, 5000), 'Delay between tile starts to avoid rate limits'),
      h('h2', {}, 'External player'),
      ctx.meta.canSpawn ? [
        field('Player', sel('externalPlayer', players.map((p) => [p.name, `${p.name}${p.installed ? '' : ' (not installed)'}`]))),
        field('Custom command', text('customPlayer', 'mpv --force-window {url}'), '{url} is replaced with the proxy URL'),
      ] : h('p', { class: 'muted' }, 'Disabled: the server is exposed to the network without ACCESS_PIN.'),
      h('div', {}, saveBtn),
      h('h2', {}, 'Web auth token (optional)'),
      h('p', { class: 'muted' }, 'The twitch.tv “auth-token” cookie. Enables the web-login playback mode, which can unlock subscriber/turbo ad-free playback.'),
      h('div', { class: 'row' }, webTok,
        h('button', { class: 'btn', onclick: async () => { if (!webTok.value.trim()) return; try { await api('/api/auth/web-token', { method: 'PUT', body: { token: webTok.value } }); webTok.value = ''; await ctx.refreshAuth(); toast('Web token saved', 'ok'); } catch (e) { toast(e.message, 'err'); } } }, 'Save'),
        ctx.auth.webTokenSet ? h('button', { class: 'btn danger', onclick: async () => { await api('/api/auth/web-token', { method: 'PUT', body: { token: null } }); await ctx.refreshAuth(); toast('Web token removed', 'info'); ctx.navigate('/settings'); } }, 'Remove') : null),
      h('h2', {}, 'Account'),
      h('div', { class: 'row' }, ctx.auth.loggedIn ? h('button', { class: 'btn danger', onclick: doLogout }, 'Log out') : h('button', { class: 'btn primary', onclick: () => openLogin() }, 'Log in'),
        h('span', { class: 'muted' }, ctx.auth.loggedIn ? `Logged in as ${ctx.auth.user || 'unknown'}` : 'Not logged in'))));
}

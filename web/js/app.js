// App shell: router, navigation, auth state, settings, theme, global events.
import { api, subscribeServerEvents } from './api.js';
import { clear, h, icon, rateLimitToast, store, toast } from './ui.js';
import {
  browseView, ctx, diagnosticsView, followedView, homeView, openLogin, openUserMenu, searchView, settingsView, vodsView, watchView,
} from './views.js';
import { closeMini, initMini } from './mini.js';
import { addToStoredWall, multiviewActive, multiviewView, showShortcuts } from './multiview.js';

const ROUTES = {
  '/': { title: 'Play', icon: 'home', view: homeView },
  '/watch': { title: 'Watch', view: watchView, hidden: true },
  '/followed': { title: 'Followed', icon: 'heart', view: followedView },
  '/browse': { title: 'Browse', icon: 'compass', view: browseView },
  '/search': { title: 'Search', icon: 'search', view: searchView },
  '/vods': { title: 'VODs', icon: 'film', view: vodsView },
  '/multiview': { title: 'Multiview', icon: 'grid', view: multiviewView, flush: true, sep: true },
  '/diagnostics': { title: 'Diagnostics', icon: 'activity', view: diagnosticsView },
  '/settings': { title: 'Settings', icon: 'settings', view: settingsView },
};

const $ = (id) => document.getElementById(id);
let cleanups = [];
let navToken = 0;

// ---- theme ------------------------------------------------------------------------
const mq = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const t = ctx.settings.theme || 'dark';
  document.documentElement.dataset.theme = t === 'system' ? (mq.matches ? 'dark' : 'light') : t;
}
mq.addEventListener?.('change', applyTheme);

// ---- router -----------------------------------------------------------------------------
export function navigate(url, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  render();
}
ctx.navigate = navigate;
initMini({ navigate });

function runCleanups() {
  const fns = cleanups; cleanups = [];
  for (const fn of fns) { try { fn(); } catch (e) { console.error(e); } }
}

function render() {
  runCleanups();
  const url = new URL(location.href);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const route = ROUTES[path] ?? ROUTES['/'];
  const view = $('view');
  const token = ++navToken;
  if (path === '/multiview') closeMini(); // multiview runs its own players
  view.classList.toggle('flush', !!route.flush);
  document.title = `${route.title} · Twitch WebUI`;
  closeMobileNav();
  paintNav(path);
  clear(view);
  try {
    const el = route.view(url.searchParams, (fn) => cleanups.push(fn));
    if (token === navToken) view.append(el);
  } catch (e) {
    console.error(e);
    view.append(h('div', { class: 'error-box', role: 'alert' }, `This page failed to load: ${e.message}`));
  }
  if (!route.flush) view.scrollTop = 0;
}

function paintNav(current) {
  const nav = $('nav');
  clear(nav);
  for (const [path, r] of Object.entries(ROUTES)) {
    if (r.hidden) continue;
    if (r.sep) nav.append(h('div', { class: 'sep' }));
    nav.append(h('a', { href: path, 'data-link': '', 'aria-current': current === path ? 'page' : null }, icon(r.icon), r.title));
  }
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
window.addEventListener('popstate', render);

// ---- omnibox ---------------------------------------------------------------------------------
$('omniIcon').append(icon('search'));
$('menuBtn').append(icon('menu'));
$('debugBtn').append(icon('bug'));

// ---- menu button: collapses the sidebar on desktop, slides it over the page on mobile ----
const narrow = window.matchMedia('(max-width: 900px)');
const scrim = h('div', { class: 'scrim', hidden: true, onclick: () => closeMobileNav() });
document.body.append(scrim);
let navCollapsed = store.get('navCollapsed', false) === true;

function paintMenu() {
  const open = narrow.matches ? $('sidebar').classList.contains('open') : !navCollapsed;
  document.body.classList.toggle('nav-collapsed', !narrow.matches && navCollapsed);
  scrim.hidden = !(narrow.matches && open);
  $('menuBtn').setAttribute('aria-expanded', String(open));
  $('menuBtn').setAttribute('aria-label', open ? 'Hide navigation' : 'Show navigation');
}
function closeMobileNav() { $('sidebar').classList.remove('open'); paintMenu(); }
$('menuBtn').addEventListener('click', () => {
  if (narrow.matches) $('sidebar').classList.toggle('open');
  else { navCollapsed = !navCollapsed; store.set('navCollapsed', navCollapsed); }
  paintMenu();
});
narrow.addEventListener?.('change', () => { $('sidebar').classList.remove('open'); paintMenu(); });
paintMenu();
$('omnibox').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('omniInput');
  const value = input.value.trim();
  if (!value) return;
  try {
    const r = await api('/api/resolve', { method: 'POST', body: { input: value } });
    input.value = '';
    input.blur();
    navigate(`/watch?q=${encodeURIComponent(r.canonical)}`);
  } catch (err) { toast(err.message, 'warn'); }
});

document.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); $('omniInput').focus(); }
  else if (e.key === '?' && !multiviewActive()) { e.preventDefault(); showShortcuts(); }
});

// ---- auth state ------------------------------------------------------------------------------
let lanBannerDismissed = store.get('lanBannerDismissed', false) === true;
function paintUser() {
  const a = ctx.auth;
  const btn = $('userBtn');
  clear(btn);
  const label = a.loggedIn ? (a.user || 'Account') : 'Log in';
  btn.append(h('span', { class: `avatar ${a.loggedIn ? '' : 'off'}` }, a.loggedIn ? (a.user || '?')[0].toUpperCase() : icon('user', 14)), h('span', {}, label));
  btn.setAttribute('aria-label', a.loggedIn ? `Account: ${label}` : 'Log in');
  const banner = $('banner');
  clear(banner);
  if (a.state === 'expired') {
    banner.append(h('div', { class: 'banner warn' }, h('span', {}, 'Your Twitch login expired.'), h('button', { class: 'btn sm', onclick: () => openLogin() }, 'Log in again')));
  }
  if (ctx.meta.lan && !lanBannerDismissed) {
    banner.append(h('div', { class: 'banner warn' }, h('span', { class: 'banner-text' }, 'This server is reachable from your network.'),
      h('button', { class: 'icon-btn banner-close', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => { lanBannerDismissed = true; store.set('lanBannerDismissed', true); paintUser(); } }, icon('close', 14))));
  }
}

ctx.refreshAuth = async () => {
  try { ctx.auth = await api('/api/auth/status'); } catch { /* keep last known */ }
  paintUser();
};
$('userBtn').addEventListener('click', () => { if (ctx.auth.loggedIn) openUserMenu(); else openLogin(); });

// ---- settings / debug -------------------------------------------------------------------------------
ctx.saveSettings = async (partial) => {
  const r = await api('/api/config', { method: 'PUT', body: partial });
  ctx.settings = r.settings;
  applyTheme();
  paintDebug();
  return r.settings;
};

let debugEs = null;
function paintDebug() {
  $('debugBtn').hidden = !ctx.settings.debug;
  if (!ctx.settings.debug) { debugEs?.close(); debugEs = null; $('debugDrawer').hidden = true; }
}
$('debugBtn').addEventListener('click', () => {
  const drawer = $('debugDrawer');
  if (!drawer.hidden) { drawer.hidden = true; debugEs?.close(); debugEs = null; return; }
  clear(drawer);
  const log = h('div', { class: 'log mono' });
  drawer.append(h('header', {}, h('strong', {}, 'Server log'), h('button', { class: 'btn sm', onclick: () => clear(log) }, 'Clear'),
    h('button', { class: 'icon-btn', 'aria-label': 'Close log', onclick: () => { drawer.hidden = true; debugEs?.close(); debugEs = null; } }, icon('close'))), log);
  drawer.hidden = false;
  debugEs = new EventSource('/api/debug/stream');
  debugEs.addEventListener('log', (e) => {
    const l = JSON.parse(e.data);
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
    log.append(h('div', { class: `log-line ${l.level}` }, `${new Date(l.ts).toLocaleTimeString()} ${l.message}`));
    while (log.childElementCount > 500) log.firstChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
  });
});

// ---- add to multiview --------------------------------------------------------------------------------------------
ctx.addToMultiview = (login) => {
  const r = addToStoredWall(String(login).toLowerCase());
  if (r === 'full') toast('Multiview is full (6 streams).', 'warn');
  else if (r === 'exists') toast(`${login} is already in multiview`, 'info');
  else if (multiviewActive()) toast(`Added ${login}`, 'ok', { timeout: 2000 });
  else toast(`Added ${login} to multiview`, 'ok', { actions: [{ label: 'Open', onClick: () => navigate('/multiview') }] });
};

// ---- boot ---------------------------------------------------------------------------------------------------------------
async function boot() {
  try {
    const cfg = await api('/api/config');
    ctx.settings = cfg.settings;
    ctx.meta = cfg.meta;
  } catch (e) {
    $('view').append(h('div', { class: 'error-box' }, `Cannot load configuration: ${e.message}`));
  }
  applyTheme();
  paintDebug();
  await ctx.refreshAuth();
  subscribeServerEvents({
    toast: (t) => { toast(t.message, t.level === 'warn' ? 'warn' : 'info', { timeout: 8000, actions: t.code === 'token_expired' ? [{ label: 'Log in', onClick: () => openLogin() }] : [] }); ctx.refreshAuth(); },
    'rate-limit': (r) => rateLimitToast(r.seconds),
  });
  render();
}
boot();

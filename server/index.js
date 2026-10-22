// Twitch WebUI server: REST API + HLS proxy routes + static frontend.
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import QRCode from 'qrcode';

import {
  AD_FREE_PARAM_SETS, ANDROID_USER_AGENT, AVAILABLE_PLAYERS, CONFIG_ENV_VAR, HLS_MIME, VERSION, buildAuthUrl,
} from './constants.js';
import { ConfigStore, LAYOUTS } from './config.js';
import { TokenStorage } from './tokenStorage.js';
import { TwitchClient, buildUsherUrl } from './twitch.js';
import { HLSAdBlockProxy } from './proxy.js';
import { ChatManager } from './chat.js';
import { EmoteService } from './emotes.js';
import { LIVE_IDLE_MS, PassthroughProxy, SessionManager, VOD_IDLE_MS } from './sessions.js';
import { codecFamily, isAllowedUpstream, parseMasterVariants, rewritePlaylist } from './hlsLogic.js';
import { channelDto, gameDto, streamDto, thumbnail, vodDto } from './dto.js';
import { getPlayerArgs, launchPlayer, listPlayers, resolvePlayer, stopAllPlayers } from './players.js';
import { ApiError, canonicalInput, formatDuration, parseInput } from './util.js';
import { appEvents, configureLogging, getLogRing, isDebug, log, logBus, redact } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');

const PORT = Number(process.env.PORT) || 3010;
const HOST = process.env.HOST || '127.0.0.1';
const ACCESS_PIN = process.env.ACCESS_PIN || '';
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);
// Spawning processes (external players) is only allowed if nobody else on the
// network can reach this server, or they must know the PIN.
const CAN_SPAWN = LOOPBACK || !!ACCESS_PIN;

const CONFIG_DIR = path.join(os.homedir(), '.config', 'twitch-webui');
const configFile = process.env[CONFIG_ENV_VAR] ? path.resolve(process.env[CONFIG_ENV_VAR].replace(/^~/, os.homedir())) : path.join(CONFIG_DIR, 'config.json');

// ---- bootstrap -----------------------------------------------------------
const config = await new ConfigStore(configFile).load();
configureLogging({ debug: config.get().debug, logFile: config.get().logFile });
const storage = new TokenStorage({
  dir: CONFIG_DIR,
  useKeyring: config.get().useKeyring,
  legacyFile: path.join(os.homedir(), '.config', 'twitch-cli', 'token'),
});
const twitch = new TwitchClient({ storage });
await twitch.init();
const sessions = new SessionManager();
const chat = new ChatManager({ twitch });
const emotes = new EmoteService();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- access control ------------------------------------------------------
const pinCookie = ACCESS_PIN ? crypto.createHmac('sha256', ACCESS_PIN).update('twitch-webui').digest('hex') : '';
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const hasPinCookie = (req) => {
  const m = /(?:^|;\s*)webui_pin=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!m && safeEq(m[1], pinCookie);
};

if (ACCESS_PIN) {
  app.post('/api/pin', (req, res) => {
    if (!safeEq(req.body?.pin ?? '', ACCESS_PIN)) return res.status(401).json({ error: { code: 'bad_pin', message: 'Wrong PIN' } });
    res.setHeader('Set-Cookie', `webui_pin=${pinCookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`);
    res.json({ ok: true });
  });
  app.use((req, res, next) => {
    if (hasPinCookie(req)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/proxy/')) return res.status(401).json({ error: { code: 'pin_required', message: 'PIN required' } });
    res.status(401).type('html').send(PIN_PAGE);
  });
}

// Basic CSRF guard: cross-site pages must not be able to drive the API.
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* invalid */ }
    if (host !== req.headers.host) return res.status(403).json({ error: { code: 'forbidden_origin', message: 'Cross-origin request blocked' } });
  }
  next();
});

// ---- SSE helper ----------------------------------------------------------
function openSse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write(': ok\n\n');
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
  const close = (fn) => req.on('close', () => { clearInterval(hb); fn?.(); });
  return { send, close };
}

const pageSize = (req) => {
  const n = parseInt(req.query.first, 10);
  return Number.isInteger(n) ? Math.min(Math.max(n, 1), 50) : config.get().pageSize;
};

// ---- auth ----------------------------------------------------------------
app.get('/api/auth/status', ah(async (req, res) => {
  const status = await twitch.refreshAuth();
  res.json({ ...status, keyring: { enabled: config.get().useKeyring, available: await storage.keyringAvailable() } });
}));

app.get('/api/auth/login-info', ah(async (req, res) => {
  const authUrl = buildAuthUrl();
  const qrSvg = await QRCode.toString(authUrl, { type: 'svg', margin: 1, width: 180 });
  res.json({ authUrl, qrSvg });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const { redirectUrl, token } = req.body ?? {};
  let value = null;
  if (typeof redirectUrl === 'string' && redirectUrl.trim()) {
    const m = /access_token=([^&\s]+)/.exec(redirectUrl);
    value = m ? decodeURIComponent(m[1]) : null;
    // Also accept a pasted raw token in the same field.
    if (!value && /^[a-z0-9]{20,64}$/i.test(redirectUrl.trim())) value = redirectUrl.trim();
  } else if (typeof token === 'string') {
    value = token.trim().replace(/^OAuth\s+/i, '');
  }
  if (!value) throw new ApiError(400, 'no_token', 'Could not extract an access token from that input');
  const status = await twitch.login(value);
  chat.reset(); // the IRC connection must re-auth with the new token
  res.json(status);
}));

app.post('/api/auth/logout', ah(async (req, res) => {
  await twitch.logout();
  chat.reset();
  res.json(twitch.authStatus());
}));

app.put('/api/auth/web-token', ah(async (req, res) => {
  await twitch.setWebToken(req.body?.token || null);
  res.json(twitch.authStatus());
}));

// ---- config & presets ------------------------------------------------------
app.get('/api/config', (req, res) => res.json({
  settings: config.get(),
  meta: { version: VERSION, canSpawn: CAN_SPAWN, lan: !LOOPBACK, players: listPlayers(), layouts: LAYOUTS },
}));

app.put('/api/config', ah(async (req, res) => {
  const body = req.body ?? {};
  if (body.customPlayer && !CAN_SPAWN) throw new ApiError(403, 'forbidden', 'Custom player commands are disabled when the server is exposed without ACCESS_PIN');
  const settings = await config.update(body);
  configureLogging({ debug: settings.debug, logFile: settings.logFile });
  storage.setKeyring(settings.useKeyring);
  res.json({ settings });
}));

app.get('/api/multiview/presets', (req, res) => res.json({ presets: config.listPresets() }));
app.post('/api/multiview/presets', ah(async (req, res) => res.json({ preset: await config.savePreset(req.body) })));
app.delete('/api/multiview/presets/:name', ah(async (req, res) => {
  if (!(await config.deletePreset(req.params.name))) throw new ApiError(404, 'not_found', 'No such preset');
  res.json({ ok: true });
}));

// ---- resolve / info ----------------------------------------------------------
app.post('/api/resolve', (req, res) => {
  const parsed = parseInput(req.body?.input);
  if (!parsed) throw new ApiError(400, 'invalid_input', 'Not a Twitch channel name or URL');
  res.json({ ...parsed, canonical: canonicalInput(parsed) });
});

const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const validLogin = (s) => {
  const l = String(s).toLowerCase();
  if (!LOGIN_RE.test(l)) throw new ApiError(400, 'invalid_input', 'Invalid channel name');
  return l;
};

app.get('/api/stream/:login/info', ah(async (req, res) => {
  const info = await twitch.getStreamInfo(validLogin(req.params.login));
  if (!info) throw new ApiError(404, 'channel_not_found', 'Channel not found');
  res.json({ ...info, thumbnail: thumbnail(info.login) });
}));

// ---- play sessions -------------------------------------------------------------
const FAMILIES = new Set(['H.264', 'HEVC', 'AV1']);

function sessionMeta(s) {
  const info = s.proxy?.info ?? null;
  return {
    sessionId: s.id,
    kind: s.kind,
    type: 'hls',
    playbackUrl: `/proxy/${s.id}/master.m3u8`,
    adblock: s.proxy instanceof HLSAdBlockProxy,
    quality: info ? { key: info.chosenKey, label: info.chosenLabel, family: info.family, flavor: info.flavor, variants: info.variants } : null,
    ...s.meta,
  };
}

app.post('/api/play', ah(async (req, res) => {
  const body = req.body ?? {};
  const parsed = parseInput(body.input);
  if (!parsed) throw new ApiError(400, 'invalid_input', 'Not a Twitch channel name or URL');

  const cfg = config.get();
  const useAdblock = typeof body.adblock === 'boolean' ? body.adblock : cfg.adblock;
  const quality = body.audioOnly ? 'audio_only' : (body.quality ?? cfg.quality ?? null);
  const allowedCodecs = Array.isArray(body.codecs) ? new Set(body.codecs.filter((c) => FAMILIES.has(c))) : null;
  const segmentMode = cfg.proxySegments ? 'proxy' : 'direct';

  if (parsed.type === 'clip') {
    const clip = await twitch.getClipInfo(parsed.id);
    if (!clip?.url) throw new ApiError(404, 'clip_not_found', 'Clip not found or has no playable source');
    return res.json({ sessionId: null, kind: 'clip', type: 'mp4', playbackUrl: clip.url, title: clip.title, adblock: false });
  }

  if (parsed.type === 'vod') {
    const [vod, url] = await Promise.all([twitch.getVodInfo(parsed.id), twitch.getVodUrl(parsed.id)]);
    if (!vod || !url) throw new ApiError(404, 'vod_not_found', 'VOD not found or not playable');
    const session = sessions.create({
      kind: 'vod', channel: vod.owner?.login ?? '', idleMs: VOD_IDLE_MS, segmentMode,
      meta: {
        title: vod.title ?? 'VOD', channel: vod.owner?.login ?? '', displayName: vod.owner?.displayName ?? '',
        duration: formatDuration(vod.duration), views: vod.viewCount ?? 0, createdAt: vod.createdAt ?? null,
        thumbnail: thumbnail(vod.owner?.login ?? ''),
      },
    });
    session.proxy = new PassthroughProxy({ twitch, masterUrl: url, quality, allowedCodecs, onEvent: (l, m) => session.emitEvent(l, m), wrap: session.wrap() });
    return res.json(sessionMeta(session));
  }

  // live channel
  const channel = parsed.id;
  const info = await twitch.getStreamInfo(channel);
  if (!info) throw new ApiError(404, 'channel_not_found', `Channel not found: ${channel}`);
  if (!info.online) {
    return res.json({ status: 'offline', channel: info.login, displayName: info.displayName, userId: info.userId });
  }

  const session = sessions.create({
    kind: 'live', channel, idleMs: LIVE_IDLE_MS, segmentMode,
    meta: {
      status: 'online', channel: info.login, displayName: info.displayName, title: info.title, game: info.game,
      viewers: info.viewers, startedAt: info.startedAt, thumbnail: thumbnail(info.login),
    },
  });
  const onEvent = (l, m) => session.emitEvent(l, m);

  if (useAdblock) {
    session.proxy = new HLSAdBlockProxy({ twitch, channel, quality, allowedCodecs, onEvent });
  } else {
    const url = await twitch.getStreamUrl(channel);
    if (!url) { sessions.remove(session.id); throw new ApiError(502, 'no_token', 'Could not get a playback token'); }
    session.proxy = new PassthroughProxy({ twitch, masterUrl: url, quality, allowedCodecs, onEvent, wrap: session.wrap() });
  }
  res.json(sessionMeta(session));
}));

app.get('/api/play/:sid', (req, res) => {
  const s = sessions.get(req.params.sid);
  if (!s) throw new ApiError(404, 'no_session', 'Session not found');
  res.json(sessionMeta(s));
});

app.delete('/api/play/:sid', (req, res) => res.json({ ok: sessions.remove(req.params.sid) }));

app.get('/api/play/:sid/events', (req, res) => {
  const s = sessions.get(req.params.sid);
  if (!s) return res.status(404).json({ error: { code: 'no_session', message: 'Session not found' } });
  const { send, close } = openSse(req, res);
  s.streams++;
  s.touch();
  const onEvent = (ev) => { s.touch(); send('session', ev); };
  const onClosed = () => { send('closed', {}); res.end(); };
  for (const ev of s.events) send('session', ev);
  s.on('event', onEvent);
  s.once('closed', onClosed);
  const touchTimer = setInterval(() => s.touch(), 15_000);
  close(() => {
    clearInterval(touchTimer);
    s.off('event', onEvent);
    s.off('closed', onClosed);
    s.streams = Math.max(0, s.streams - 1);
    s.touch();
  });
});

// ---- chat (IRC bridge; see server/chat.js) ---------------------------------------------------
app.get('/api/chat/:login/events', ah(async (req, res) => {
  const login = validLogin(req.params.login);
  await twitch.refreshAuth();
  if (!twitch.token) return res.status(401).json({ error: { code: 'auth_required', message: 'Log in with Twitch to use chat' } });
  const { send, close } = openSse(req, res);
  const unsub = await chat.subscribe(login, { send });
  close(() => unsub());
}));

app.post('/api/chat/:login/message', ah(async (req, res) => {
  if (!twitch.token) throw new ApiError(401, 'auth_required', 'Log in with Twitch to chat');
  const login = validLogin(req.params.login);
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  res.json(await chat.send(login, text));
}));

// Third-party emotes (BTTV / 7TV) for the chat panel; see server/emotes.js.
app.get('/api/chat/:login/emotes', ah(async (req, res) => {
  const login = validLogin(req.params.login);
  if (!twitch.token) throw new ApiError(401, 'auth_required', 'Log in with Twitch to use chat');
  // Provider APIs are keyed by Twitch user id; resolve it via Helix on cache miss.
  res.json(await emotes.forChannel(login, {
    getUserId: async () => (await twitch.getUserByLogin(login))?.id ?? null,
  }));
}));

// ---- proxy routes -----------------------------------------------------------------
app.use('/proxy/:sid', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function sendPlaylist(res, code, body) {
  res.status(code).set({ 'Content-Type': code === 200 ? HLS_MIME : 'text/plain', 'Cache-Control': 'no-store' }).send(body);
}

app.get('/proxy/:sid/master.m3u8', ah(async (req, res) => {
  const s = sessions.get(req.params.sid);
  if (!s) return res.status(404).send('no such session');
  s.touch();
  const { code, body } = await s.proxy.buildMaster();
  sendPlaylist(res, code, body);
}));

app.get('/proxy/:sid/variant', ah(async (req, res) => {
  const s = sessions.get(req.params.sid);
  if (!s || !(s.proxy instanceof HLSAdBlockProxy)) return res.status(404).send('no such session');
  s.touch();
  const upstream = String(req.query.u ?? '');
  if (!upstream || !isAllowedUpstream(upstream)) return res.status(400).send('bad request');
  const minBw = parseInt(req.query.bw, 10) || 0;
  const r = await s.proxy.handleVariant(upstream, String(req.query.n ?? ''), minBw);
  if (r.code !== 200) return sendPlaylist(res, r.code, r.text);
  sendPlaylist(res, 200, rewritePlaylist(r.text, r.url, s.wrap()));
}));

app.get('/proxy/:sid/segment', ah(async (req, res) => {
  const s = sessions.get(req.params.sid);
  if (!s) return res.status(404).send('no such session');
  s.touch();
  const u = String(req.query.u ?? '');
  if (!isAllowedUpstream(u)) return res.status(400).send('upstream not allowed');

  const headers = { 'User-Agent': ANDROID_USER_AGENT, Referer: 'https://www.twitch.tv/' };
  if (req.headers.range) headers.Range = req.headers.range;
  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let up;
  try {
    up = await fetch(u, { headers, signal: ac.signal });
  } catch (e) {
    if (res.destroyed) return undefined;
    log.debug('segment fetch failed:', e.message);
    return res.status(502).send('upstream fetch failed');
  }

  const ctype = up.headers.get('content-type') || '';
  const isPlaylist = /mpegurl/i.test(ctype) || /\.m3u8$/i.test(new URL(u).pathname);
  if (isPlaylist) {
    const text = await up.text();
    return sendPlaylist(res, up.status, up.status === 200 ? rewritePlaylist(text, u, s.wrap()) : text);
  }

  res.status(up.status);
  res.setHeader('Content-Type', ctype || 'application/octet-stream');
  for (const h of ['content-range', 'accept-ranges']) if (up.headers.get(h)) res.setHeader(h, up.headers.get(h));
  if (up.headers.get('content-length') && !up.headers.get('content-encoding')) res.setHeader('Content-Length', up.headers.get('content-length'));
  res.setHeader('Cache-Control', 'private, max-age=30');
  if (!up.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(up.body), res);
  } catch { /* client went away */ }
  return undefined;
}));

// ---- browsing ---------------------------------------------------------------------------
const paged = (items, cursor, map) => ({ items: items.map(map), cursor });

app.get('/api/followed', ah(async (req, res) => {
  const userId = await twitch.getUserId();
  if (!userId) throw new ApiError(401, 'auth_required', 'Could not resolve user ID from OAuth token');
  const r = await twitch.getFollowedLive(userId, pageSize(req), req.query.after);
  res.json(paged(r.items, r.cursor, streamDto));
}));

app.get('/api/games/top', ah(async (req, res) => {
  const r = await twitch.getTopGames(pageSize(req), req.query.after);
  res.json(paged(r.items, r.cursor, gameDto));
}));

app.get('/api/games/search', ah(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) throw new ApiError(400, 'invalid_input', 'Missing query');
  res.json({ games: (await twitch.searchGames(q)).map(gameDto) });
}));

app.get('/api/games/:id/streams', ah(async (req, res) => {
  const r = await twitch.getStreamsByGame(req.params.id, pageSize(req), req.query.after);
  res.json(paged(r.items, r.cursor, streamDto));
}));

app.get('/api/channels/search', ah(async (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) throw new ApiError(400, 'invalid_input', 'Missing query');
  const r = await twitch.searchChannels(q, pageSize(req), req.query.after);
  res.json(paged(r.items, r.cursor, channelDto));
}));

app.get('/api/channels/:login/vods', ah(async (req, res) => {
  const user = await twitch.getUserByLogin(validLogin(req.params.login));
  if (!user) throw new ApiError(404, 'channel_not_found', 'Channel not found');
  const r = await twitch.getVideos(String(user.id), pageSize(req), req.query.after);
  res.json({ ...paged(r.items, r.cursor, vodDto), channel: { login: user.login, name: user.display_name } });
}));

app.get('/api/channels/:login/latest-vod', ah(async (req, res) => {
  const user = await twitch.getUserByLogin(validLogin(req.params.login));
  if (!user) throw new ApiError(404, 'channel_not_found', 'Channel not found');
  const r = await twitch.getVideos(String(user.id), 1);
  if (!r.items.length) throw new ApiError(404, 'no_vod', 'No recent VOD found');
  res.json({ vod: vodDto(r.items[0]) });
}));

// ---- diagnostics -------------------------------------------------------------------------------
app.get('/api/diagnostics/:login', ah(async (req, res) => {
  const channel = validLogin(req.params.login);
  const flavors = await Promise.all(AD_FREE_PARAM_SETS.map(async (params) => {
    const entry = { flavor: `${params.platform}/${params.playerType}`, status: 'ok', tokenMode: null, error: null, variants: [] };
    const tok = await twitch.getStreamPlaybackToken(channel, params);
    if (!tok) return { ...entry, status: 'no-token' };
    entry.tokenMode = tok.mode;
    const r = await twitch.fetchTextDetailed(buildUsherUrl(channel, tok.value, tok.signature));
    if (r.status !== 200) return { ...entry, status: 'usher-error', error: r.status ? `usher HTTP ${r.status}` : r.error };
    const variants = parseMasterVariants(r.text);
    if (!variants.length) return { ...entry, status: 'empty', error: 'playlist had no renditions' };
    entry.variants = variants.map((v) => ({
      video: v.video, name: v.name, resolution: v.height ? `${v.width}x${v.height}` : '-',
      fps: v.fps || null, bandwidth: v.bandwidth, codecs: v.codecs, family: codecFamily(v),
    }));
    return entry;
  }));
  res.json({
    channel,
    flavors,
    auth: twitch.authStatus(),
    webTokenSet: !!twitch.webToken,
    lastTokenMode: twitch.lastTokenMode,
    tokenFailures: twitch.tokenFailures,
  });
}));

// ---- external player ------------------------------------------------------------------------------
app.post('/api/external-player', ah(async (req, res) => {
  if (!CAN_SPAWN) throw new ApiError(403, 'forbidden', 'External players are disabled when the server is exposed without ACCESS_PIN');
  const s = sessions.get(String(req.body?.sessionId ?? ''));
  if (!s) throw new ApiError(404, 'no_session', 'Session not found');
  const cfg = config.get();
  const requested = req.body?.player && req.body.player in AVAILABLE_PLAYERS ? req.body.player : cfg.externalPlayer;
  const player = resolvePlayer(requested);
  const url = `http://127.0.0.1:${server.address().port}/proxy/${s.id}/master.m3u8`;
  const title = [s.meta.title, s.meta.displayName].filter(Boolean).join(' - ') || null;
  const spec = getPlayerArgs(player, url, title, {
    customPlayer: cfg.customPlayer, audioOnly: cfg.audioOnly, lowLatency: cfg.lowLatency, cache: cfg.cache, quality: cfg.quality,
  }, true);
  try {
    const pid = await launchPlayer(spec);
    res.json({ ok: true, player, pid });
  } catch (e) {
    throw new ApiError(500, 'player_failed', `Could not start ${player}: ${e.message}`);
  }
}));

// ---- global events / debug ----------------------------------------------------------------------------------
app.get('/api/events', (req, res) => {
  const { send, close } = openSse(req, res);
  const onToast = (t) => send('toast', t);
  const onRate = (r) => send('rate-limit', r);
  appEvents.on('toast', onToast);
  appEvents.on('rate-limit', onRate);
  close(() => { appEvents.off('toast', onToast); appEvents.off('rate-limit', onRate); });
});

app.get('/api/debug/stream', (req, res) => {
  if (!isDebug()) return res.status(403).json({ error: { code: 'debug_off', message: 'Enable debug in Settings' } });
  const { send, close } = openSse(req, res);
  for (const e of getLogRing()) send('log', e);
  const onLog = (e) => send('log', e);
  logBus.on('log', onLog);
  close(() => logBus.off('log', onLog));
  return undefined;
});

// ---- static frontend --------------------------------------------------------------------------------------------
app.get('/vendor/hls.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js')));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(WEB_DIR, 'favicon.png')));
app.use(express.static(WEB_DIR, { index: false }));
app.get(/^\/(?!api\/|proxy\/|vendor\/).*/, (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

// ---- errors -------------------------------------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    if (err.extra?.retryAfter) res.setHeader('Retry-After', String(err.extra.retryAfter));
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'bad_json', message: 'Invalid JSON body' } });
  log.error('Unhandled error:', err);
  return res.status(500).json({ error: { code: 'internal', message: redact(err?.message ?? 'Internal error') } });
});

process.on('unhandledRejection', (e) => log.error('Unhandled rejection:', e));

// ---- listen / shutdown ---------------------------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  log.info(`Twitch WebUI ${VERSION} listening on http://${HOST}:${server.address().port}`);
  if (!LOOPBACK) {
    log.warn(`HOST=${HOST} exposes this server to your network.`);
    if (!ACCESS_PIN) log.warn('No ACCESS_PIN set: anyone who can reach this port can use your Twitch login. External players and custom commands are disabled.');
    else log.info('ACCESS_PIN is required to use the UI.');
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') log.error(`Port ${PORT} is already in use — another twitch-webui (or the old build) is probably running. Start with e.g. PORT=3011, or stop the other instance.`);
  else log.error(`Could not listen on ${HOST}:${PORT}: ${e.message}`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${sig} received; shutting down`);
  chat.destroy();
  sessions.stopAll();
  stopAllPlayers();
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const PIN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PIN required</title>
<style>body{font:16px system-ui;background:#0e0e12;color:#eee;display:grid;place-items:center;height:100vh;margin:0}form{display:grid;gap:12px;width:260px}
input,button{padding:12px;border-radius:8px;border:1px solid #444;background:#1b1b22;color:#eee;font:inherit}button{background:#9146ff;border:0;cursor:pointer}</style>
<form onsubmit="event.preventDefault();fetch('/api/pin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:this.pin.value})}).then(r=>r.ok?location.reload():(this.pin.value='',this.pin.placeholder='Wrong PIN'))">
<strong>Twitch WebUI</strong><input name="pin" type="password" placeholder="Access PIN" autofocus autocomplete="current-password"><button>Unlock</button></form>`;

// Native Twitch chat: IRC over TLS (irc.chat.twitch.tv:6697) bridged to the
// browser via SSE. One shared IRC connection per server process; per-channel
// "rooms" refcount SSE subscribers. The OAuth token comes from the same login
// flow the app already uses (scopes: chat:read chat:edit).
//
// Pure parsing helpers are exported for unit tests; ChatManager accepts an
// injectable socketFactory so tests can drive it with a fake socket.
import tls from 'node:tls';
import { ApiError } from './util.js';
import { log } from './log.js';

export const IRC_HOST = 'irc.chat.twitch.tv';
export const IRC_PORT = 6697;
export const IRC_CAPS = 'twitch.tv/tags twitch.tv/commands';
// Regular users may send 20 messages / 30s; stay under it.
export const CHAT_SEND_LIMIT = { windowMs: 30_000, max: 18 };
export const MAX_ROOMS = 50;
const MAX_HISTORY = 40;
const RECONNECT_MAX_MS = 15_000;

const defaultSocketFactory = ({ host, port }) => tls.connect({ host, port, servername: host });
const PART_GRACE_MS = 30_000; // keep a channel joined briefly after the last viewer leaves

// ---- IRC wire parsing (pure) -------------------------------------------------

/** Un-escape an IRCv3 tag value: \s space, \: semicolon, \\ backslash, \r \n. */
export function unescapeTagValue(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== '\\') { out += c; continue; }
    const n = value[++i];
    if (n === undefined) { out += c; break; } // dangling backslash
    if (n === 's') out += ' ';
    else if (n === ':') out += ';';
    else if (n === 'r') out += '\r';
    else if (n === 'n') out += '\n';
    else if (n === '\\') out += '\\';
    else out += n;
  }
  return out;
}

export function parseTags(raw) {
  const tags = {};
  if (!raw) return tags;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) { tags[part] = true; continue; }
    tags[part.slice(0, eq)] = unescapeTagValue(part.slice(eq + 1));
  }
  return tags;
}

/**
 * Parse one IRC line into { tags, nick, cmd, params, trail } or null.
 * Handles "@tags :nick!user@host CMD p1 p2 :trailing".
 */
export function parseIrcLine(line) {
  if (!line || !line.trim()) return null;
  let rest = line.replace(/\r?\n$/, '');
  let tags = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    tags = parseTags(rest.slice(1, sp));
    rest = rest.slice(sp + 1);
  }
  let prefix = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp < 0) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trail = null;
  const t = rest.indexOf(' :');
  if (t >= 0) { trail = rest.slice(t + 2); rest = rest.slice(0, t); }
  const parts = rest.split(' ').filter(Boolean);
  if (!parts.length) return null;
  return { tags, prefix, nick: prefix ? prefix.split('!')[0] : null, cmd: parts[0].toUpperCase(), params: parts.slice(1), trail };
}

/** "25:0-4,6-10/1902:12-16" -> [{ id, start, end }] sorted by start (inclusive code-point ranges). */
export function parseEmoteRanges(tag) {
  const out = [];
  if (!tag) return out;
  for (const part of tag.split('/')) {
    const sep = part.indexOf(':');
    if (sep < 0) continue;
    const id = part.slice(0, sep);
    if (!/^\d+$/.test(id)) continue;
    for (const pos of part.slice(sep + 1).split(',')) {
      const [a, b] = pos.split('-').map(Number);
      if (Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= a) out.push({ id, start: a, end: b });
    }
  }
  return out.sort((x, y) => x.start - y.start || x.end - y.end);
}

/**
 * Split message text into text/emote segments. Twitch emote positions are
 * inclusive indices into the message counted in Unicode code points, so the
 * text is iterated via Array.from (not UTF-16 indexes).
 */
export function segmentEmotes(text, emotesTag) {
  const cps = Array.from(text ?? '');
  if (!cps.length) return [];
  const ranges = parseEmoteRanges(emotesTag);
  if (!ranges.length) return [{ type: 'text', text: text }];
  const segs = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor || r.end >= cps.length) continue; // overlapping / out of range: ignore
    if (r.start > cursor) segs.push({ type: 'text', text: cps.slice(cursor, r.start).join('') });
    segs.push({ type: 'emote', id: r.id, text: cps.slice(r.start, r.end + 1).join('') });
    cursor = r.end + 1;
  }
  if (cursor < cps.length) segs.push({ type: 'text', text: cps.slice(cursor).join('') });
  return segs;
}

/**
 * True when the text mentions @login with a word boundary (case-insensitive).
 * Twitch logins are [A-Za-z0-9_], so a negative lookahead serves as boundary.
 */
export function textMentions(text, login) {
  const name = String(login ?? '').trim();
  if (!name || !text) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`@${esc}(?![A-Za-z0-9_])`, 'i').test(String(text));
}

/** Build the chat message DTO sent to browsers from a parsed PRIVMSG line. */
export function privmsgToChat(parsed, { selfLogin = null } = {}) {
  const t = parsed.tags;
  const raw = parsed.trail ?? '';
  const action = raw.startsWith('\u0001ACTION ') && raw.endsWith('\u0001');
  const text = action ? raw.slice(8, -1) : raw;
  const badges = typeof t.badges === 'string' && t.badges
    ? t.badges.split(',').map((b) => {
        const sep = b.indexOf('/');
        return sep < 0 ? { id: b, version: '1' } : { id: b.slice(0, sep), version: b.slice(sep + 1) };
      }).filter((b) => b.id)
    : [];
  const login = String(t.login || parsed.nick || '').toLowerCase();
  const sub = /^subscriber\/(\d+)$/.exec(String(t['badge-info'] ?? ''));
  return {
    type: 'message',
    id: t.id || null,
    login,
    display: t['display-name'] || login,
    color: /^#[0-9a-fA-F]{6}$/.test(t.color ?? '') ? t.color : null,
    badges,
    subMonths: sub ? Number(sub[1]) : null,
    mod: t.mod === '1' || badges.some((b) => b.id === 'moderator'),
    text,
    action,
    emotes: segmentEmotes(text, t.emotes),
    ts: Number(t['tmi-sent-ts']) || Date.now(),
    self: !!selfLogin && login === selfLogin.toLowerCase(),
    mention: !!selfLogin && textMentions(text, selfLogin),
  };
}

/** Sliding-window rate limiter (pure, injectable clock for tests). */
export class RateLimiter {
  constructor({ windowMs = CHAT_SEND_LIMIT.windowMs, max = CHAT_SEND_LIMIT.max, now = Date.now } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.now = now;
    this.hits = [];
  }

  tryAcquire() {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.max) {
      return { ok: false, retryAfterMs: Math.max(1, this.windowMs - (t - this.hits[0])) };
    }
    this.hits.push(t);
    return { ok: true };
  }
}

/** Sanitise outgoing text: strip CRLF, handle /me and Twitch command escaping. */
export function prepareOutgoingText(text) {
  let out = String(text ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!out) return null;
  if (out.length > 500) out = out.slice(0, 500);
  const me = /^\/me\s+(.*)$/s.exec(out);
  if (me) return { action: true, text: me[1].trim().slice(0, 500) || null };
  // Messages starting with . or / would be run as IRC commands; escape them.
  if (out.startsWith('/') || out.startsWith('.')) out = ` ${out}`;
  return { action: false, text: out };
}

// ---- manager -----------------------------------------------------------------

function roomKey(login) { return String(login).toLowerCase(); }

export class ChatManager {
  /**
   * @param {object} opts
   * @param {object} opts.twitch  TwitchClient (uses token, authUser, refreshAuth)
   * @param {Function} [opts.socketFactory] ({host, port}) -> duplex socket
   */
  constructor({ twitch, socketFactory = defaultSocketFactory, limiter, partGraceMs = PART_GRACE_MS } = {}) {
    this.twitch = twitch;
    this.socketFactory = socketFactory;
    this.limiter = limiter ?? new RateLimiter();
    this.partGraceMs = partGraceMs;
    this.rooms = new Map(); // login -> { login, ref, clients:Set, history:[], joined, partTimer }
    this.socket = null;
    this.buffer = '';
    this.state = 'offline'; // offline | connecting | connected | error
    this.errorMessage = null;
    this.destroyed = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.reconnecting = false;
  }

  status() { return { state: this.state, message: this.errorMessage, rooms: this.rooms.size }; }

  room(login) {
    const key = roomKey(login);
    let room = this.rooms.get(key);
    if (!room) {
      room = { login: key, ref: 0, clients: new Set(), history: [], joined: false, partTimer: null };
      this.rooms.set(key, room);
    }
    return room;
  }

  /**
   * Attach an SSE client to a channel's chat. Returns an unsubscribe fn.
   * Sends `init` (history + status) immediately, then `message`/`status`/...
   */
  async subscribe(login, { send }) {
    await this.twitch.refreshAuth(); // resolves user login for NICK (no throw on network issues)
    if (!this.twitch.token) throw new ApiError(401, 'auth_required', 'Log in with Twitch to use chat');
    if (this.rooms.size >= MAX_ROOMS && !this.rooms.has(roomKey(login))) {
      throw new ApiError(429, 'chat_full', 'Too many chat channels open');
    }
    const room = this.room(login);
    room.ref++;
    room.clients.add(send);
    clearTimeout(room.partTimer);
    room.partTimer = null;
    // `init` first, so the connection's own `connecting` status event lands after it.
    send('init', { login: room.login, status: this.status(), history: room.history });
    this._ensureConnection();
    if (this.state === 'connected') this._sendRaw(`JOIN #${room.login}`); // otherwise 001 re-joins every room
    return () => this._unsubscribe(room.login, send);
  }

  _unsubscribe(login, send) {
    const key = roomKey(login);
    const room = this.rooms.get(key);
    if (!room) return;
    if (!room.clients.delete(send)) return; // idempotent for double-unsubscribes
    room.ref--;
    if (room.clients.size > 0) return;
    // Last viewer left: PART after a short grace period so quick navigations
    // don't churn joins/parts.
    room.partTimer = setTimeout(() => {
      if (room.clients.size > 0) return;
      this._sendRaw(`PART #${key}`);
      this.rooms.delete(key);
    }, this.partGraceMs);
    room.partTimer.unref?.();
  }

  /** Send a chat message as the logged-in user. */
  async send(login, text) {
    const key = roomKey(login);
    await this.twitch.refreshAuth();
    if (!this.twitch.token) throw new ApiError(401, 'auth_required', 'Log in with Twitch to chat');
    if (this.state === 'error') throw new ApiError(502, 'chat_auth', this.errorMessage || 'Twitch rejected the chat login');
    if (this.state !== 'connected') throw new ApiError(503, 'chat_connecting', 'Chat is still connecting — try again in a moment');
    const prepared = prepareOutgoingText(text);
    if (!prepared) throw new ApiError(400, 'empty_message', 'Message is empty');
    const slot = this.limiter.tryAcquire();
    if (!slot.ok) {
      throw new ApiError(429, 'rate_limited', 'You are sending messages too quickly', {
        retryAfter: Math.ceil(slot.retryAfterMs / 1000),
      });
    }
    this._sendRaw(prepared.action ? `PRIVMSG #${key} :\u0001ACTION ${prepared.text}\u0001` : `PRIVMSG #${key} :${prepared.text}`);
    return { ok: true };
  }

  /** Drop the IRC connection (e.g. token changed). Reconnects on demand. */
  reset() {
    this.reconnectAttempts = 0;
    this.reconnecting = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._setState('offline', null); // tell current viewers the stream dropped
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      this.buffer = '';
      try { sock.destroy(); } catch { /* already gone */ }
    }
    for (const room of this.rooms.values()) room.joined = false;
  }

  destroy() {
    this.destroyed = true;
    this.reset();
    this.rooms.clear();
  }

  // ---- IRC connection ----------------------------------------------------

  _ensureConnection() {
    if (this.socket || this.destroyed) return;
    if (!this.twitch.token) return;
    this._setState('connecting');
    let sock;
    try {
      sock = this.socketFactory({ host: IRC_HOST, port: IRC_PORT });
    } catch (e) {
      log.warn('chat: could not open IRC socket:', e.message);
      this._scheduleReconnect();
      return;
    }
    this.socket = sock;
    this.buffer = '';
    sock.on('secureConnect', () => {
      if (this.socket !== sock) return;
      log.debug('chat: connected to IRC');
      // Order: PASS first, then NICK, then capabilities.
      this._write(`PASS oauth:${this.twitch.token}`);
      this._write(`NICK ${this.twitch.authUser || 'justinfan12345'}`);
      this._write(`CAP REQ :${IRC_CAPS}`);
    });
    sock.on('data', (chunk) => {
      if (this.socket !== sock) return;
      this.buffer += chunk.toString('utf8');
      let idx;
      while ((idx = this.buffer.indexOf('\r\n')) >= 0) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        if (line) this._handleLine(line);
      }
      if (this.buffer.length > 64 * 1024) { this.buffer = ''; } // run-away guard
    });
    sock.on('error', (e) => {
      if (this.socket !== sock) return;
      log.debug('chat: IRC error:', e.message);
    });
    sock.on('close', () => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.buffer = '';
      for (const room of this.rooms.values()) room.joined = false;
      if (this.destroyed) return;
      if (this.rooms.size > 0 || this.reconnecting) this._scheduleReconnect();
      else this._setState('offline');
    });
  }

  _scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return;
    this.reconnecting = true;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this._setState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._ensureConnection();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  _setState(state, message = null) {
    if (this.state === state && this.errorMessage === message) return;
    this.state = state;
    this.errorMessage = message;
    this._broadcastAll('status', this.status());
  }

  _write(line) {
    if (!this.socket) return false;
    try { this.socket.write(`${line}\r\n`); return true; } catch { return false; }
  }

  _sendRaw(line) {
    // JOIN/PART/PRIVMSG go through here; they are queued until the socket
    // exists, and JOINs are re-issued after a successful welcome (001).
    this._write(line);
  }

  _handleLine(line) {
    const parsed = parseIrcLine(line);
    if (!parsed) return;
    const { cmd, tags, params, trail, nick } = parsed;

    if (cmd === 'PING') { this._write('PONG :tmi.twitch.tv'); return; }

    if (cmd === 'RECONNECT') { log.debug('chat: server asked to reconnect'); this.reset(); this._scheduleReconnect(); return; }

    if (cmd === '001') {
      log.info('chat: IRC ready');
      this.reconnectAttempts = 0;
      this.reconnecting = false;
      this._setState('connected');
      // (Re)join every room that still has viewers.
      for (const room of this.rooms.values()) {
        room.joined = false;
        this._write(`JOIN #${room.login}`);
      }
      return;
    }

    if (cmd === 'PRIVMSG') {
      const key = (params[0] || '').replace(/^#/, '').toLowerCase();
      const room = this.rooms.get(key);
      if (!room) return;
      const msg = privmsgToChat(parsed, { selfLogin: this.twitch.authUser });
      room.history.push(msg);
      if (room.history.length > MAX_HISTORY) room.history.splice(0, room.history.length - MAX_HISTORY);
      this._broadcast(room, 'message', msg);
      return;
    }

    if (cmd === 'USERNOTICE') {
      const key = (params[0] || '').replace(/^#/, '').toLowerCase();
      const room = this.rooms.get(key);
      const sys = tags['system-msg'];
      if (!room || !sys) return;
      this._broadcast(room, 'notice', { msgId: tags['msg-id'] || null, text: sys, login: tags.login || null, ts: Number(tags['tmi-sent-ts']) || Date.now() });
      return;
    }

    if (cmd === 'NOTICE') {
      const key = (params[0] || '').replace(/^#/, '').toLowerCase();
      const room = key ? this.rooms.get(key) : null;
      if (!room) {
        // Connection-level NOTICE (e.g. "Login authentication failed").
        if (/authentication|login|improperly/i.test(trail ?? '')) {
          const msg = `Twitch rejected the chat login: ${(trail || '').trim()}`;
          this.reset(); // tear down without scheduling retries...
          this._setState('error', msg); // ...then surface the reason
        }
        return;
      }
      this._broadcast(room, 'notice', { msgId: tags['msg-id'] || null, text: trail, level: 'warn', ts: Date.now() });
      return;
    }

    if (cmd === 'CLEARCHAT') {
      const key = (params[0] || '').replace(/^#/, '').toLowerCase();
      const room = this.rooms.get(key);
      if (!room) return;
      this._broadcast(room, 'clear', { userId: tags['target-user-id'] || null, banDuration: tags['ban-duration'] || null, ts: Date.now() });
      return;
    }

    if (cmd === 'CLEARMSG') {
      const key = (params[0] || '').replace(/^#/, '').toLowerCase();
      const room = this.rooms.get(key);
      if (!room) return;
      this._broadcast(room, 'delete', { msgId: tags['target-msg-id'] || null, login: tags.login || null });
      return;
    }

    if (cmd === 'JOIN' && nick === (this.twitch.authUser || '').toLowerCase()) {
      const key = (params[0] || '').replace(/^#/, '').toLowerCase();
      const room = this.rooms.get(key);
      if (room) room.joined = true;
      return;
    }
  }

  _broadcast(room, event, data) {
    for (const send of [...room.clients]) {
      try { send(event, data); } catch { room.clients.delete(send); room.ref = Math.max(0, room.ref - 1); }
    }
  }

  _broadcastAll(event, data) {
    for (const room of this.rooms.values()) this._broadcast(room, event, data);
  }
}

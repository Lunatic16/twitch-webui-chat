// Third-party chat emote providers: BetterTTV (BTTV) and 7TV.
//
// The chat panel asks the server for one merged emote list per channel; the
// server fetches the provider APIs (global + channel sets) and caches them in
// memory so many chat panels share a handful of upstream requests. Nothing
// here touches the Twitch OAuth token except the optional user-id lookup
// passed in by the route, and every failure degrades to "no emotes" instead
// of breaking chat.
//
// Pure helpers are exported for unit tests; EmoteService accepts an
// injectable fetchImpl so tests can fake the network.

export const BTTV_API = 'https://api.betterttv.net/3';
export const SEVENTV_API = 'https://7tv.io/v3';

export const GLOBAL_TTL_MS = 6 * 60 * 60 * 1000;  // global sets change rarely
export const CHANNEL_TTL_MS = 60 * 60 * 1000;     // channel emotes: refresh hourly
export const NEG_TTL_MS = 5 * 60 * 1000;          // failed fetch: back off briefly
const FETCH_TIMEOUT_MS = 8_000;
const MAX_EMOTES = 10_000;                        // sanity cap on the merged list

// ---- normalizers (pure) ------------------------------------------------------

/** {id, code, ...} -> our DTO entry, or null for junk rows. */
export function normalizeBttvEmote(e) {
  if (!e || typeof e.id !== 'string' || !e.id || typeof e.code !== 'string') return null;
  const code = e.code.trim();
  if (!code || /\s/.test(code)) return null;
  return { provider: 'bttv', id: e.id, code };
}

/**
 * 7TV v3 emote entries are {id, name, flags, data:{...}}. flags bit 0
 * (value 1) marks zero-width emotes that overlay the emote before them.
 */
export function normalize7tvEmote(e) {
  if (!e || typeof e.id !== 'string' || !e.id) return null;
  const code = String(e.name ?? e.data?.name ?? '').trim();
  if (!code || /\s/.test(code)) return null;
  const flags = Number(e.flags ?? e.data?.flags ?? 0);
  const entry = { provider: '7tv', id: e.id, code };
  if (Number.isFinite(flags) && (flags & 1) === 1) entry.zero = true;
  return entry;
}

function mapSet(list, normalize) {
  const out = [];
  for (const e of Array.isArray(list) ? list : []) {
    const n = normalize(e);
    if (n) out.push(n);
  }
  return out;
}

/** Body -> emote entries for each provider endpoint shape. */
const BTTV_ROWS = (body) => mapSet(body, normalizeBttvEmote);
const SEVEN_SET_ROWS = (body) => mapSet(body?.emotes, normalize7tvEmote);

// ---- service -----------------------------------------------------------------

export class EmoteService {
  /**
   * @param {object} opts
   * @param {Function} [opts.fetchImpl]  (url) => Promise<Response-like>
   * @param {Function} [opts.now]        injectable clock
   */
  constructor({ fetchImpl = fetch, now = Date.now } = {}) {
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.inflight = new Map();   // url -> Promise<entry[] | null> (request coalescing)
    this.globals = new Map();    // provider -> { at, emotes }
    this.channels = new Map();   // login -> { at, payload, bad }
  }

  status() {
    return { globals: this.globals.size, channels: this.channels.size };
  }

  /**
   * Fetch one provider URL and normalize its body into emote entries via
   * `toRows(body)`. Returns [] for a legitimately empty set (HTTP 404 means
   * "channel not linked with this provider"), null on transient failures
   * (network, JSON, unexpected status) so callers can tell the two apart.
   */
  async _fetchSet(url, toRows) {
    try {
      const res = await this.fetchImpl(url);
      if (!res) return null;
      if (res.status === 404) return [];
      if (res.status !== 200) return null;
      const body = await res.json();
      const rows = toRows(body);
      return Array.isArray(rows) ? rows : [];
    } catch {
      return null;
    }
  }

  /** Cached global set for one provider; failures are retried after NEG_TTL_MS. */
  async _globals(provider) {
    const hit = this.globals.get(provider);
    const ttl = hit && hit.ok ? GLOBAL_TTL_MS : NEG_TTL_MS;
    if (hit && this.now() - hit.at < ttl) return hit.emotes;
    const pending = this.inflight.get(`g:${provider}`);
    if (pending) return pending;
    const url = provider === 'bttv' ? `${BTTV_API}/cached/emotes/global` : `${SEVENTV_API}/emote-sets/global`;
    const p = this._fetchSet(url, provider === 'bttv' ? BTTV_ROWS : SEVEN_SET_ROWS)
      .then((emotes) => {
        // null (fetch failure) is cached with ok:false so it retries after NEG_TTL
        this.globals.set(provider, { at: this.now(), emotes: emotes ?? [], ok: Array.isArray(emotes) });
        return emotes; // null propagates so forChannel can count the failure
      })
      .finally(() => this.inflight.delete(`g:${provider}`));
    this.inflight.set(`g:${provider}`, p);
    return p;
  }

  /**
   * Merged emote list for a channel: BTTV global + channel/shared, 7TV global
   * + emote set. Later entries win on code collisions, so channel sets are
   * appended after globals. `getUserId()` resolves the Twitch user id for the
   * channel (provider APIs are keyed by it, not by login).
   *
   * @returns {Promise<{login, userId, emotes, counts, errors, cached}>}
   */
  async forChannel(login, { getUserId } = {}) {
    const key = String(login || '').toLowerCase();
    const hit = this.channels.get(key);
    if (hit && !hit.bad && this.now() - hit.at < CHANNEL_TTL_MS) {
      return { ...hit.payload, cached: true };
    }
    if (hit && hit.bad && this.now() - hit.at < NEG_TTL_MS) {
      return { ...hit.payload, cached: true };
    }

    const errors = [];
    const [bttvGlobal, sevenTVGlobal, userId] = await Promise.all([
      this._globals('bttv'),
      this._globals('7tv'),
      this._resolveUser(getUserId, errors),
    ]);

    let failures = 0;
    if (bttvGlobal === null) { failures++; errors.push('bttv_global_fetch'); }
    if (sevenTVGlobal === null) { failures++; errors.push('7tv_global_fetch'); }
    const [bttvChannel, sevenTVChannel] = await Promise.all([
      userId
        ? this._fetchSet(`${BTTV_API}/cached/users/twitch/${encodeURIComponent(userId)}`, (u) =>
            // {channelEmotes: [...], sharedEmotes: [...]}
            mapSet([...(u?.channelEmotes ?? []), ...(u?.sharedEmotes ?? [])], normalizeBttvEmote))
        : Promise.resolve([]),
      userId
        ? this._fetchSet(`${SEVENTV_API}/users/twitch/${encodeURIComponent(userId)}`, (u) =>
            mapSet(u?.emote_set?.emotes, normalize7tvEmote))
        : Promise.resolve([]),
    ]);
    if (!userId) errors.push('user_id_unresolved');
    if (bttvChannel === null) { failures++; errors.push('bttv_channel_fetch'); }
    if (sevenTVChannel === null) { failures++; errors.push('7tv_channel_fetch'); }

    const emotes = [
      ...(bttvGlobal ?? []), ...(bttvChannel ?? []),
      ...(sevenTVGlobal ?? []), ...(sevenTVChannel ?? []),
    ].slice(0, MAX_EMOTES);
    const payload = {
      login: key,
      userId: userId ?? null,
      emotes,
      counts: {
        bttv: (bttvGlobal?.length ?? 0) + (bttvChannel?.length ?? 0),
        '7tv': (sevenTVGlobal?.length ?? 0) + (sevenTVChannel?.length ?? 0),
      },
      errors: [...new Set(errors)],
      updated: this.now(),
    };
    // Anything went wrong (transient fetch failure, unresolved user id) ->
    // short negative cache so it gets another chance quickly instead of being
    // locked out for a full TTL. Legitimate empties (404s) cache normally.
    const bad = failures > 0 || errors.length > 0;
    this.channels.set(key, { at: this.now(), payload, bad });
    return { ...payload, cached: false };
  }

  async _resolveUser(getUserId, errors) {
    if (typeof getUserId !== 'function') return null;
    try {
      const id = await getUserId();
      return id ? String(id) : null;
    } catch (e) {
      errors.push(`user_id: ${e?.message || 'failed'}`);
      return null;
    }
  }
}

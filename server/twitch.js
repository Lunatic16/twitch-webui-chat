// Twitch API client: GQL playback tokens, Helix, OAuth validation.
// Port of the Python TwitchPlayer class (without the CLI prompts).
import {
  AD_FREE_PARAM_SETS, ANDROID_USER_AGENT, GQL_HEADERS, GQL_URL, MAX_RETRIES, OAUTH_CLIENT_ID,
  REQUEST_TIMEOUT_MS, RETRYABLE_STATUS, TOKEN_ENV_VAR, WEB_TOKEN_ENV_VAR,
} from './constants.js';
import { ApiError, closestMatch, sleep } from './util.js';
import { appEvents, forgetSecret, log, registerSecret } from './log.js';

const FAIL_TTL_MS = 10 * 60 * 1000; // a failed token mode is skipped for 10 min
const VALIDATE_TTL_MS = 5 * 60 * 1000;

export function buildUsherUrl(channel, token, signature) {
  return (
    `https://usher.ttvnw.net/api/channel/hls/${channel}.m3u8` +
    `?token=${encodeURIComponent(token)}` +
    `&sig=${encodeURIComponent(signature)}` +
    '&player=twitchweb&allow_audio_only=true&allow_source=true' +
    '&playlist_include_framerate=true&supported_codecs=av1,h265,h264&type=any'
  );
}

export function buildVodUsherUrl(id, token, signature) {
  return (
    `https://usher.ttvnw.net/vod/${id}.m3u8?player=twitchweb` +
    `&token=${encodeURIComponent(token)}&sig=${encodeURIComponent(signature)}` +
    '&allow_audio_only=true&allow_source=true&playlist_include_framerate=true&type=any'
  );
}

export class TwitchClient {
  constructor({ storage, env = process.env }) {
    this.storage = storage;
    this.env = env;
    this.token = null;
    this.tokenSource = null; // 'env' | 'file' | 'login'
    this.webToken = null;
    this.webTokenSource = null;
    this.authUser = null;
    this.authUserId = null;
    this.authScopes = null; // scopes of the current token (from /validate)
    this.authState = 'logged-out'; // logged-out | unknown | logged-in | expired
    this.lastValidated = 0;
    this.lastTokenMode = null;
    this.tokenFailures = {}; // mode -> reason (shown in Diagnostics)
    this.failedModes = new Map(); // mode -> timestamp
  }

  // ---- token state -----------------------------------------------------
  async init() {
    const envToken = this.env[TOKEN_ENV_VAR];
    if (envToken) this._setToken(envToken.trim(), 'env');
    else {
      const stored = await this.storage.get('token');
      if (stored) this._setToken(stored, 'file');
    }
    const envWeb = this.env[WEB_TOKEN_ENV_VAR];
    if (envWeb) this._setWebToken(envWeb.trim(), 'env');
    else {
      const stored = await this.storage.get('web');
      if (stored) this._setWebToken(stored, 'file');
    }
    if (this.token) this.validateToken().catch(() => {});
  }

  _setToken(token, source) {
    if (this.token) forgetSecret(this.token);
    this.token = token;
    this.tokenSource = source;
    this.authState = token ? 'unknown' : 'logged-out';
    this.authUser = this.authUserId = null;
    this.authScopes = null;
    this.failedModes.clear();
    this.tokenFailures = {};
    registerSecret(token);
  }

  _setWebToken(token, source) {
    if (this.webToken) forgetSecret(this.webToken);
    this.webToken = token || null;
    this.webTokenSource = token ? source : null;
    this.failedModes.clear();
    this.tokenFailures = {};
    if (token) registerSecret(token);
  }

  async setWebToken(token) {
    if (!token) {
      this._setWebToken(null);
      await this.storage.delete('web');
      return;
    }
    const clean = String(token).trim().replace(/^OAuth\s+/i, '');
    if (!/^[A-Za-z0-9_\-]{10,200}$/.test(clean)) throw new ApiError(400, 'invalid_token', 'That does not look like an auth-token cookie value');
    this._setWebToken(clean, 'file');
    await this.storage.save('web', clean);
  }

  /** True when the stored token should be able to use Twitch chat (IRC). */
  chatAllowed() {
    if (!this.token) return false;
    // Scopes unknown until the first validation succeeds; give it the benefit
    // of the doubt (the IRC bridge surfaces a clear error if Twitch refuses).
    if (!this.authScopes) return true;
    return this.authScopes.includes('chat:read') && this.authScopes.includes('chat:edit');
  }

  authStatus() {
    return {
      state: this.authState,
      loggedIn: this.authState === 'logged-in' || this.authState === 'unknown',
      user: this.authUser,
      userId: this.authUserId,
      scopes: this.authScopes,
      canChat: this.chatAllowed(),
      tokenSource: this.tokenSource,
      webTokenSet: !!this.webToken,
      webTokenSource: this.webTokenSource,
    };
  }

  /** Validate (cached) so the UI can show an accurate state. */
  async refreshAuth(force = false) {
    if (!this.token) return this.authStatus();
    if (force || this.authState === 'unknown' || Date.now() - this.lastValidated > VALIDATE_TTL_MS) {
      await this.validateToken().catch(() => {});
    }
    return this.authStatus();
  }

  async validateToken(token = this.token) {
    if (!token) return null;
    let res;
    try {
      res = await this.request('GET', 'https://id.twitch.tv/oauth2/validate', {
        retries: 1, headers: { Authorization: `OAuth ${token}` },
      });
    } catch (e) {
      log.debug('token validation request failed:', e.message);
      return null; // network problem: keep state as-is
    }
    if (res.status !== 200) {
      await res.body?.cancel?.().catch(() => {});
      if (token === this.token && (res.status === 401 || res.status === 400)) await this.invalidateToken('validation failed');
      return null;
    }
    const data = await res.json().catch(() => null);
    if (!data) return null;
    if (token === this.token) {
      this.authUser = data.login || data.user_name || null;
      this.authUserId = data.user_id || null;
      this.authScopes = Array.isArray(data.scopes) ? data.scopes : null;
      this.authState = 'logged-in';
      this.lastValidated = Date.now();
    }
    return data;
  }

  /** Clear an invalid/expired token (memory + storage) and tell the UI. */
  async invalidateToken(reason = 'expired') {
    log.warn(`OAuth token invalid (${reason}); clearing`);
    if (this.token) forgetSecret(this.token);
    this.token = null;
    this.authState = 'expired';
    this.authUser = this.authUserId = null;
    this.authScopes = null;
    await this.storage.delete('token').catch(() => {});
    appEvents.emit('toast', { level: 'warn', code: 'token_expired', message: 'Your Twitch login expired. Please log in again.' });
  }

  async login(token) {
    const data = await this.validateToken(token);
    if (!data) throw new ApiError(401, 'invalid_token', 'Twitch rejected that token');
    this._setToken(token, 'login');
    this.authUser = data.login || data.user_name || null;
    this.authUserId = data.user_id || null;
    this.authScopes = Array.isArray(data.scopes) ? data.scopes : null;
    this.authState = 'logged-in';
    this.lastValidated = Date.now();
    await this.storage.save('token', token);
    return this.authStatus();
  }

  async logout() {
    if (this.token) forgetSecret(this.token);
    this.token = null;
    this.authState = 'logged-out';
    this.authUser = this.authUserId = null;
    this.authScopes = null;
    this.failedModes.clear();
    await this.storage.delete('token');
  }

  // ---- low-level HTTP --------------------------------------------------
  /** fetch with timeout, Retry-After handling and exponential backoff. */
  async request(method, url, { retries = MAX_RETRIES, headers, json, timeout = REQUEST_TIMEOUT_MS } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: json !== undefined ? JSON.stringify(json) : undefined,
          signal: AbortSignal.timeout(timeout),
        });
        log.debug(`HTTP ${method} ${url} -> ${res.status}`);
        if (res.status === 429 && attempt < retries) {
          const ra = parseInt(res.headers.get('retry-after') ?? '2', 10);
          const delay = Math.min(Number.isFinite(ra) ? ra : 2, 30);
          appEvents.emit('rate-limit', { seconds: delay });
          log.warn(`Rate limited. Retrying in ${delay}s.`);
          await res.body?.cancel?.().catch(() => {});
          await sleep(delay * 1000);
          continue;
        }
        if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
          const delay = 2 ** attempt;
          log.warn(`HTTP ${res.status}. Retrying in ${delay}s.`);
          await res.body?.cancel?.().catch(() => {});
          await sleep(delay * 1000);
          continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          const delay = 2 ** attempt;
          log.warn(`Network error (${e.message}). Retrying in ${delay}s.`);
          await sleep(delay * 1000);
          continue;
        }
        throw e;
      }
    }
    throw lastErr ?? new Error('Request failed');
  }

  /** @returns {Promise<{data: any, error: string}>} never throws */
  async gql(query, variables, headers = {}) {
    let res;
    try {
      res = await this.request('POST', GQL_URL, { headers: { ...GQL_HEADERS, ...headers }, json: { query, variables } });
    } catch (e) {
      return { data: null, error: `request failed: ${e.message}`, network: true };
    }
    if (res.status !== 200) {
      const text = (await res.text().catch(() => '')).slice(0, 120).trim();
      return { data: null, error: `HTTP ${res.status}: ${text}`, status: res.status };
    }
    let body;
    try { body = await res.json(); } catch { return { data: null, error: 'invalid JSON from GQL' }; }
    const error = body?.errors ? JSON.stringify(body.errors).slice(0, 160) : '';
    if (error) log.debug('GQL errors:', error);
    return { data: body?.data ?? null, error };
  }

  async helix(endpoint, params = {}) {
    if (!this.token) throw new ApiError(401, 'auth_required', 'Login required');
    const url = new URL(`https://api.twitch.tv/helix/${endpoint}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let res;
    try {
      res = await this.request('GET', url, {
        headers: { Authorization: `Bearer ${this.token}`, 'Client-ID': OAUTH_CLIENT_ID },
      });
    } catch (e) {
      throw new ApiError(502, 'network', `Helix request failed: ${e.message}`);
    }
    if (res.status === 401) {
      await this.invalidateToken('helix 401');
      throw new ApiError(401, 'token_expired', 'OAuth token is invalid or expired.');
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('ratelimit-reset') ?? '5', 10);
      throw new ApiError(429, 'rate_limited', 'Rate limited by Twitch', { retryAfter: Number.isFinite(retryAfter) ? Math.min(retryAfter, 60) : 5 });
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 180);
      throw new ApiError(res.status === 404 ? 404 : 502, 'helix_error', `Helix error ${res.status}: ${text}`);
    }
    return res.json();
  }

  /** Playlist fetch used by the proxies. Returns text or null. */
  async fetchText(url) {
    const r = await this.fetchTextDetailed(url);
    return r.status === 200 ? r.text : null;
  }

  async fetchTextDetailed(url) {
    try {
      const res = await this.request('GET', url, {
        retries: 1,
        headers: { 'User-Agent': ANDROID_USER_AGENT, Referer: 'https://www.twitch.tv/' },
      });
      if (res.status === 200) return { status: 200, text: await res.text() };
      await res.body?.cancel?.().catch(() => {});
      log.debug(`playlist HTTP ${res.status} for ${url}`);
      return { status: res.status, text: null };
    } catch (e) {
      log.debug('playlist fetch failed:', e.message);
      return { status: 0, text: null, error: e.message };
    }
  }

  // ---- stream / channel info -------------------------------------------
  async getStreamInfo(login) {
    const query = `query ChannelInfo($channelName: String!) {
      user(login: $channelName) {
        id login displayName
        stream { id title viewersCount createdAt game { name } }
      }
    }`;
    const { data, error, network } = await this.gql(query, { channelName: login });
    if (!data && error) throw new ApiError(network ? 502 : 502, 'gql_error', error);
    const user = data?.user;
    if (!user) return null;
    const stream = user.stream;
    return {
      online: !!stream,
      userId: user.id,
      login: user.login ?? login,
      displayName: user.displayName ?? login,
      title: stream?.title ?? null,
      game: stream?.game?.name ?? null,
      viewers: stream?.viewersCount ?? null,
      startedAt: stream?.createdAt ?? null,
    };
  }

  /**
   * Tries token modes in order, skipping ones that recently failed (except
   * anonymous). Resolves {value, signature, mode} or null.
   */
  async getStreamPlaybackToken(channel, params = AD_FREE_PARAM_SETS[0]) {
    const query = `query PlaybackAccessToken_Template($channelName: String!, $params: PlaybackAccessTokenParams!) {
      streamPlaybackAccessToken(channelName: $channelName, params: $params) { value signature __typename }
    }`;
    const variables = { channelName: channel, params };

    const attempts = [];
    if (this.webToken) attempts.push(['web-login', { Authorization: `OAuth ${this.webToken}` }]);
    if (this.token) {
      // An OAuth token only works with the client id it was issued to.
      attempts.push(['login', { Authorization: `OAuth ${this.token}`, 'Client-ID': OAUTH_CLIENT_ID }]);
      attempts.push(['login-web', { Authorization: `OAuth ${this.token}` }]);
    }
    attempts.push(['anonymous', {}]);

    const now = Date.now();
    for (const [mode, headers] of attempts) {
      const failedAt = this.failedModes.get(mode);
      if (mode !== 'anonymous' && failedAt && now - failedAt < FAIL_TTL_MS) continue;

      const { data, error } = await this.gql(query, variables, headers);
      const t = data?.streamPlaybackAccessToken;
      if (t?.value && t?.signature) {
        this.lastTokenMode = mode;
        return { value: t.value, signature: t.signature, mode };
      }
      log.debug(`playback token via '${mode}' failed`);
      if (!this.tokenFailures[mode]) this.tokenFailures[mode] = error || 'no token returned';
      this.failedModes.set(mode, now);
    }
    return null;
  }

  async getStreamUrl(channel) {
    const t = await this.getStreamPlaybackToken(channel);
    return t ? buildUsherUrl(channel, t.value, t.signature) : null;
  }

  // ---- VODs ------------------------------------------------------------
  async getVodUrl(id) {
    const query = `query PlaybackAccessToken_Template($id: ID!, $params: PlaybackAccessTokenParams!) {
      videoPlaybackAccessToken(id: $id, params: $params) { value signature __typename }
    }`;
    const { data } = await this.gql(query, { id, params: AD_FREE_PARAM_SETS[0] });
    const t = data?.videoPlaybackAccessToken;
    return t?.value && t?.signature ? buildVodUsherUrl(id, t.value, t.signature) : null;
  }

  async getVodInfo(id) {
    const query = `query VideoInfo($id: ID!) {
      video(id: $id) { id title createdAt duration viewCount owner { displayName login } }
    }`;
    const { data } = await this.gql(query, { id });
    return data?.video ?? null;
  }

  async getClipInfo(slug) {
    const query = `query ClipInfo($slug: String!) {
      clip(slug: $slug) { title url videoQualities { quality sourceURL frameRate } }
    }`;
    const { data } = await this.gql(query, { slug });
    const clip = data?.clip;
    if (!clip) return null;
    const qualities = [...(clip.videoQualities || [])].sort((a, b) => (Number(b.frameRate) || 0) - (Number(a.frameRate) || 0));
    const source = qualities.find((q) => q.sourceURL)?.sourceURL ?? null;
    return { title: clip.title || 'Twitch Clip', url: source };
  }

  // ---- Helix -----------------------------------------------------------
  async getUserId() {
    if (this.authUserId) return this.authUserId;
    const data = await this.helix('users');
    return data?.data?.[0]?.id ? String(data.data[0].id) : null;
  }

  async getUserByLogin(login) {
    const data = await this.helix('users', { login });
    return data?.data?.[0] ?? null;
  }

  async getVideos(userId, first = 20, after) {
    const data = await this.helix('videos', { user_id: userId, first, type: 'archive', sort: 'time', after });
    return { items: data.data ?? [], cursor: data.pagination?.cursor ?? null };
  }

  async getTopGames(first = 100, after) {
    const data = await this.helix('games/top', { first, after });
    return { items: data.data ?? [], cursor: data.pagination?.cursor ?? null };
  }

  /** Category search; falls back to fuzzy matching against the top 100. */
  async searchGames(query, first = 8) {
    const data = await this.helix('search/categories', { query, first });
    if (data.data?.length) return data.data;
    const top = await this.getTopGames(100);
    const match = closestMatch(query, top.items.map((g) => g.name), 0.6);
    return match ? top.items.filter((g) => g.name === match).slice(0, 1) : [];
  }

  async getFollowedLive(userId, first = 20, after) {
    const data = await this.helix('streams/followed', { user_id: userId, first, after });
    return { items: data.data ?? [], cursor: data.pagination?.cursor ?? null };
  }

  async getStreamsByGame(gameId, first = 20, after) {
    const data = await this.helix('streams', { game_id: gameId, first, type: 'live', after });
    return { items: data.data ?? [], cursor: data.pagination?.cursor ?? null };
  }

  async searchChannels(query, first = 20, after) {
    const data = await this.helix('search/channels', { query, first, after });
    return { items: data.data ?? [], cursor: data.pagination?.cursor ?? null };
  }
}

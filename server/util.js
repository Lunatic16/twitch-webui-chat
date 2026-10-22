// Small pure helpers: errors, URL/input parsing.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const TWITCH_HOST = /(^|\.)twitch\.tv$/;
const RESERVED_PATHS = new Set(['directory', 'downloads', 'jobs', 'p', 'settings', 'subscriptions', 'turbo', 'wallet', 'friends', 'inventory', 'drops']);

/** Port of parse_twitch_url(). Returns {type, id} or null. */
export function parseTwitchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);

  if (host === 'clips.twitch.tv') {
    return parts.length ? { type: 'clip', id: parts[0] } : null;
  }
  if (!TWITCH_HOST.test(host)) return null;
  if (!parts.length) return null;

  if (parts[0] === 'videos' && parts.length >= 2) return { type: 'vod', id: parts[1] };
  if (parts.length >= 3 && parts[1] === 'clip') return { type: 'clip', id: parts[2] };
  if (parts[0] !== 'videos' && !RESERVED_PATHS.has(parts[0].toLowerCase())) {
    return { type: 'channel', id: parts[0].toLowerCase() };
  }
  return null;
}

/**
 * Accepts a bare channel name, "twitch.tv/<channel>" (scheme optional) or any
 * full Twitch URL. Returns {type: 'channel'|'vod'|'clip', id} or null.
 */
export function parseInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) return parseTwitchUrl(raw);

  const first = raw.split('/')[0].toLowerCase();
  if (/^([a-z0-9-]+\.)*twitch\.tv$/.test(first)) return parseTwitchUrl(`https://${raw}`);

  const name = raw.replace(/\/+$/, '').split('/').pop().toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9_]{1,25}$/.test(name)) return null;
  return { type: 'channel', id: name };
}

export function canonicalInput(parsed) {
  if (parsed.type === 'vod') return `https://www.twitch.tv/videos/${parsed.id}`;
  if (parsed.type === 'clip') return `https://clips.twitch.tv/${parsed.id}`;
  return parsed.id;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalise GQL (seconds) / Helix ("3h2m1s") durations to "3h2m1s". */
export function formatDuration(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = Math.floor(value % 60);
    return `${h ? h + 'h' : ''}${h || m ? m + 'm' : ''}${s}s`;
  }
  return String(value ?? '');
}

/** difflib.SequenceMatcher.ratio() equivalent (Ratcliff/Obershelp). */
export function similarity(a, b) {
  const total = a.length + b.length;
  if (!total) return 1;
  return (2 * matchingChars(a, b)) / total;
}

function matchingChars(a, b) {
  if (!a.length || !b.length) return 0;
  let best = 0, ai = 0, bi = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) { best = cur[j]; ai = i - best; bi = j - best; }
      }
    }
    prev = cur;
  }
  if (!best) return 0;
  return best + matchingChars(a.slice(0, ai), b.slice(0, bi)) + matchingChars(a.slice(ai + best), b.slice(bi + best));
}

/** difflib.get_close_matches(n=1) equivalent; case-insensitive. */
export function closestMatch(query, names, cutoff = 0.6) {
  const q = query.toLowerCase();
  let best = null, bestScore = cutoff;
  for (const name of names) {
    const score = similarity(q, name.toLowerCase());
    if (score >= bestScore && (best === null || score > bestScore)) { best = name; bestScore = score; }
  }
  return best;
}

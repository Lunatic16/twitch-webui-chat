// Pure HLS logic (no I/O): master parsing, quality selection, master rendering,
// playlist rewriting. Direct port of the helpers in proxy-twitch-cli.py.
import { AD_MARKERS, MIN_BW_RATIO } from './constants.js';

export const playlistHasAds = (text) => AD_MARKERS.some((m) => text.includes(m));

/** Read NAME="value" from an attribute list line. */
export function attr(line, name) {
  const m = new RegExp(`(?:^|[:,])${name}="([^"]*)"`).exec(line);
  return m ? m[1] : '';
}

export function parseMasterVariants(master) {
  const lines = master.split(/\r?\n/).map((l) => l.trim());

  // Twitch puts the friendly name ("1440p60 (source)") on the matching
  // #EXT-X-MEDIA line (same GROUP-ID as the stream's VIDEO attribute).
  const mediaNames = {};
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const gid = attr(line, 'GROUP-ID');
      const nm = attr(line, 'NAME');
      if (gid && nm) mediaNames[gid] = nm;
    }
  }

  const variants = [];
  let pending = '';
  for (const line of lines) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pending = line;
    } else if (line && !line.startsWith('#') && pending) {
      const bw = /BANDWIDTH=(\d+)/.exec(pending);
      const res = /RESOLUTION=(\d+)x(\d+)/.exec(pending);
      const fps = /FRAME-RATE=([\d.]+)/.exec(pending);
      const video = attr(pending, 'VIDEO');
      variants.push({
        attrs: pending,
        uri: line,
        bandwidth: bw ? parseInt(bw[1], 10) : 0,
        video,
        name: attr(pending, 'NAME') || mediaNames[video] || '',
        height: res ? parseInt(res[2], 10) : 0,
        width: res ? parseInt(res[1], 10) : 0,
        fps: fps ? parseFloat(fps[1]) : 0,
        codecs: attr(pending, 'CODECS'),
      });
      pending = '';
    }
  }
  return variants;
}

export const parseMasterMedia = (master) =>
  master.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('#EXT-X-MEDIA:'));

export function isAudioOnlyVariant(v) {
  return v.video.toLowerCase() === 'audio_only' || v.name.toLowerCase().includes('audio only');
}

export function codecFamily(v) {
  const c = v.codecs.toLowerCase();
  if (c.includes('av01')) return 'AV1';
  if (c.includes('hvc1') || c.includes('hev1')) return 'HEVC';
  if (c.includes('avc1')) return 'H.264';
  return isAudioOnlyVariant(v) ? 'audio' : '?';
}

/** Stable id for a rendition; the same VIDEO id can exist per codec. */
export const variantKey = (v) => `${v.video || v.name}|${codecFamily(v)}`;

/** First element with the maximum key (Python max() semantics on ties). */
function maxBy(list, keyFn) {
  let best = null, bestKey = null;
  for (const item of list) {
    const k = keyFn(item);
    if (best === null || cmpTuple(k, bestKey) > 0) { best = item; bestKey = k; }
  }
  return best;
}

function cmpTuple(a, b) {
  const x = Array.isArray(a) ? a : [a];
  const y = Array.isArray(b) ? b : [b];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1;
  }
  return 0;
}

/** Highest (height, fps, bandwidth); audio-only only if nothing else exists. */
export function bestVariant(variants) {
  const video = variants.filter((v) => !isAudioOnlyVariant(v));
  const pool = video.length ? video : variants;
  return maxBy(pool, (v) => [v.height, v.fps, v.bandwidth]);
}

/**
 * quality: source|max|best|chunked|'' -> best; audio_only; "720p60" / "1080" / "480p".
 * fps must be within ±1 when both sides know it. Unavailable -> best (+ onWarn).
 */
export function selectVariant(variants, quality, onWarn) {
  const q = String(quality ?? '').trim().toLowerCase();

  if (['audio', 'audio_only', 'audioonly'].includes(q)) {
    return variants.find(isAudioOnlyVariant) ?? null;
  }
  if (['', 'source', 'max', 'best', 'chunked'].includes(q)) return bestVariant(variants);

  const m = /^(\d+)p?(\d+)?$/.exec(q);
  if (m) {
    const height = m[1];
    const fps = m[2];
    const exact = fps ? `${height}p${fps}` : null;
    const matches = [];
    for (const v of variants) {
      const vid = v.video.toLowerCase();
      const nm = v.name.toLowerCase();
      if (exact && (vid === exact || nm.startsWith(exact))) {
        matches.push(v);
      } else if (vid === `${height}p` || vid.startsWith(`${height}p`) || nm.startsWith(`${height}p`) || String(v.height) === height) {
        if (fps && v.fps && Math.abs(v.fps - Number(fps)) > 1) continue;
        matches.push(v);
      }
    }
    if (matches.length) return maxBy(matches, (v) => v.bandwidth);
    onWarn?.(`Quality '${quality}' not offered by this stream; using best available`);
  }
  return bestVariant(variants);
}

/**
 * Pick the flavor whose chosen rendition scores best on (height, fps, -preset).
 * results: [{preset, master, variants}]. Ties go to the earliest preset.
 */
export function pickBestMaster(results, quality) {
  let best = null;
  for (const r of results) {
    const chosen = selectVariant(r.variants, quality);
    if (!chosen) continue;
    const score = [chosen.height, chosen.fps, -r.preset];
    if (best === null || cmpTuple(score, best.score) > 0) best = { ...r, chosen, score };
  }
  return best;
}

/**
 * Chosen rendition first, then every other variant at or below its bitrate.
 * uriFor(variant) decides how each variant URI is rewritten.
 */
export function renderMaster(variants, mediaLines, chosen, uriFor) {
  const lines = ['#EXTM3U', ...mediaLines];
  const ordered = [chosen, ...variants.filter((v) => v !== chosen && v.bandwidth <= chosen.bandwidth)];
  for (const v of ordered) lines.push(v.attrs, uriFor(v));
  return lines.join('\n') + '\n';
}

/**
 * Find the same quality key in another flavor's master, requiring at least
 * MIN_BW_RATIO of the originally requested bandwidth (never degrade quality).
 */
export function variantFromMaster(variants, videoId, minBw, ratio = MIN_BW_RATIO) {
  const vid = (videoId || '').toLowerCase();
  let candidates = variants.filter((v) => variantKey(v).toLowerCase() === vid);
  if (!candidates.length && !vid) candidates = variants.filter((v) => !isAudioOnlyVariant(v));
  if (minBw) {
    const floor = minBw * ratio;
    candidates = candidates.filter((v) => v.bandwidth >= floor);
  }
  return candidates.length ? maxBy(candidates, (v) => v.bandwidth) : null;
}

export const variantLabel = (v) => (v.name || v.video || '').replace(/\s*\(source\)/i, '');

/** Compact description of renditions for the UI (quality picker, badge). */
export function describeVariants(variants) {
  return variants.map((v) => ({
    key: variantKey(v),
    label: variantLabel(v),
    height: v.height,
    fps: v.fps,
    family: codecFamily(v),
    bandwidth: v.bandwidth,
    audioOnly: isAudioOnlyVariant(v),
  }));
}

/**
 * Rewrite every URI in a media playlist (segments, EXT-X-MAP, EXT-X-KEY, ...)
 * to absolute upstream URLs and pass them through wrap(absoluteUrl).
 */
export function rewritePlaylist(text, baseUrl, wrap) {
  const resolve = (u) => {
    try { return new URL(u, baseUrl).toString(); } catch { return u; }
  };
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (!line.trim()) return line;
      if (line.startsWith('#')) {
        return line.replace(/([:,])URI="([^"]*)"/g, (m, sep, u) => (u ? `${sep}URI="${wrap(resolve(u))}"` : m));
      }
      return wrap(resolve(line.trim()));
    })
    .join('\n');
}

const ALLOWED_UPSTREAM = /(^|\.)(ttvnw\.net|twitch\.tv|jtvnw\.net|twitchcdn\.net|cloudfront\.net|akamaized\.net|live-video\.net)$/;

/** Guards /segment against becoming an open proxy (SSRF). */
export function isAllowedUpstream(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'https:' && ALLOWED_UPSTREAM.test(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

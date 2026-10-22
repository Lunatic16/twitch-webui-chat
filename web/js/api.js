// Thin fetch wrapper with structured errors + global server events (SSE).
export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
  get needsLogin() { return this.code === 'auth_required' || this.code === 'token_expired'; }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', 'Cannot reach the server. Is it still running?');
  }
  if (res.ok) return res.status === 204 ? null : res.json();
  let err = {};
  try { err = (await res.json()).error ?? {}; } catch { /* non-JSON error */ }
  if (err.code === 'pin_required') { location.reload(); }
  throw new ApiError(res.status, err.code ?? `http_${res.status}`, err.message ?? res.statusText, err);
}

/** Subscribe to /api/events (toasts, rate limits). Auto-reconnects via EventSource. */
export function subscribeServerEvents(handlers) {
  const es = new EventSource('/api/events');
  for (const [name, fn] of Object.entries(handlers)) {
    es.addEventListener(name, (e) => { try { fn(JSON.parse(e.data)); } catch { /* ignore */ } });
  }
  return es;
}

/** Codec families this browser can decode, so the server can hide the rest. */
export function supportedCodecs() {
  const out = ['H.264'];
  const ms = window.MediaSource;
  if (ms?.isTypeSupported) {
    if (ms.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"') || ms.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"')) out.push('HEVC');
    if (ms.isTypeSupported('video/mp4; codecs="av01.0.08M.08"')) out.push('AV1');
  } else {
    // Safari's native HLS: H.264 + (usually) HEVC
    out.push('HEVC');
  }
  return out;
}

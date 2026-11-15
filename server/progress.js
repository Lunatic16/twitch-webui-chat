// VOD resume positions. The app keeps its own record (this file) and merges it
// with Twitch's own `viewingHistory` when a web token is available, preferring
// whichever was updated most recently.
//
// A position that is too close to the start or the end is stored as a
// "tombstone" (position 0) instead of being deleted: it records that the viewer
// started over or finished, so an older position still sitting in Twitch's
// history does not bring the resume prompt back.
import fs from 'node:fs/promises';
import path from 'node:path';

export const MIN_RESUME_S = 15; // don't resume from the first few seconds
export const END_MARGIN_S = 30; // ...or from the very end
const MAX_ENTRIES = 300;
const FLUSH_MS = 2000;

export const isVodId = (id) => /^\d{1,15}$/.test(String(id));

/** Positions worth resuming from (not near the start, not near the end). */
export function resumable(position, duration = 0) {
  if (!Number.isFinite(position) || position < MIN_RESUME_S) return false;
  return !(duration > 0 && position > duration - END_MARGIN_S);
}

/**
 * Pick the position to resume from.
 * @param {{position:number, updatedAt:number}|null} local   this app's record
 * @param {{position:number, updatedAt:number}|null} remote  Twitch viewingHistory
 * @returns {{position:number, source:'local'|'twitch', updatedAt:number}|null}
 */
export function pickResume(local, remote, duration = 0) {
  const cands = [];
  if (local) cands.push({ ...local, source: 'local' });
  if (remote) cands.push({ ...remote, source: 'twitch' });
  if (!cands.length) return null;
  cands.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const best = cands[0];
  if (!resumable(best.position, duration)) return null;
  return { position: Math.floor(best.position), source: best.source, updatedAt: best.updatedAt || 0 };
}

export class VodProgress {
  constructor(file, { now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.map = new Map(); // id -> { position, duration, updatedAt }
    this.timer = null;
    this.saving = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      for (const [id, e] of Object.entries(raw?.entries ?? {})) {
        if (isVodId(id) && Number.isFinite(e?.position) && Number.isFinite(e?.updatedAt)) {
          this.map.set(id, { position: e.position, duration: Number(e.duration) || 0, updatedAt: e.updatedAt });
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`Warning: could not load ${this.file}: ${e.message}`);
    }
    return this;
  }

  get(id) { return this.map.get(String(id)) ?? null; }

  /** id -> {position, duration} for every VOD that can be resumed (for list badges). */
  resumable() {
    const out = {};
    for (const [id, e] of this.map) if (resumable(e.position, e.duration)) out[id] = { position: e.position, duration: e.duration };
    return out;
  }

  /** Record a position. Too early / too late collapses to a tombstone (position 0). */
  set(id, position, duration = 0) {
    const key = String(id);
    const pos = Number(position);
    const dur = Number.isFinite(Number(duration)) && Number(duration) > 0 ? Math.floor(Number(duration)) : 0;
    if (!Number.isFinite(pos) || pos < 0) return null;
    const entry = { position: resumable(pos, dur) ? Math.floor(pos) : 0, duration: dur, updatedAt: this.now() };
    this.map.delete(key); // re-insert so Map order == recency
    this.map.set(key, entry);
    while (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
    this._schedule();
    return entry;
  }

  /** "Start over" / finished: keep a tombstone so Twitch's older position is ignored. */
  clear(id) { return this.set(id, 0, this.get(id)?.duration ?? 0); }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, FLUSH_MS);
    this.timer.unref?.();
  }

  /** Write to disk now (also called on shutdown). Writes are serialised. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const entries = Object.fromEntries(this.map);
    this.saving = this.saving.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ entries }), { mode: 0o600 });
      await fs.rename(tmp, this.file);
    });
    return this.saving;
  }
}

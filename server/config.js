// JSON config store with validation. Saved atomically (tmp + rename).
import fs from 'node:fs/promises';
import path from 'node:path';
import { AVAILABLE_PLAYERS } from './constants.js';
import { ApiError } from './util.js';

export const LAYOUTS = {
  '2h': 2, '2v': 2, '2x2': 4, '1+3': 4, '3x2': 6, '1+5': 6,
};

export const DEFAULT_CONFIG = Object.freeze({
  // Ported from the Python config
  audioOnly: false,
  lowLatency: false,
  cache: false,
  bufferSeconds: 30, // hls.js buffer target when `cache` is on
  quality: null, // null = source/best
  useKeyring: false,
  pageSize: 20,
  debug: false,
  logFile: null,
  adblock: true,
  // New
  proxySegments: true,
  theme: 'dark',
  mvLayout: '2x2',
  mvAudioFocus: 'follow', // 'follow' = one tile unmuted, 'muted' = all muted on start
  mvCapQuality: '480p', // cap for unfocused tiles; 'none' disables
  mvStaggerMs: 250,
  externalPlayer: 'mpv',
  customPlayer: null,
});

const SCHEMA = {
  audioOnly: { t: 'bool' },
  lowLatency: { t: 'bool' },
  cache: { t: 'bool' },
  bufferSeconds: { t: 'int', min: 5, max: 300 },
  quality: { t: 'str?' },
  useKeyring: { t: 'bool' },
  pageSize: { t: 'int', min: 5, max: 50 },
  debug: { t: 'bool' },
  logFile: { t: 'str?' },
  adblock: { t: 'bool' },
  proxySegments: { t: 'bool' },
  theme: { t: 'enum', values: ['dark', 'light', 'system'] },
  mvLayout: { t: 'enum', values: Object.keys(LAYOUTS) },
  mvAudioFocus: { t: 'enum', values: ['follow', 'muted'] },
  mvCapQuality: { t: 'str' },
  mvStaggerMs: { t: 'int', min: 0, max: 5000 },
  externalPlayer: { t: 'enum', values: Object.keys(AVAILABLE_PLAYERS) },
  customPlayer: { t: 'str?' },
};

/** Validate a partial settings object; throws ApiError(400) on bad input. */
export function validateSettings(partial) {
  const out = {};
  for (const [key, value] of Object.entries(partial || {})) {
    const s = SCHEMA[key];
    if (!s) continue; // unknown keys are ignored (presets are managed separately)
    const bad = () => new ApiError(400, 'invalid_setting', `Invalid value for ${key}`);
    switch (s.t) {
      case 'bool':
        if (typeof value !== 'boolean') throw bad();
        out[key] = value;
        break;
      case 'int': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < s.min || n > s.max) throw bad();
        out[key] = n;
        break;
      }
      case 'str':
        if (typeof value !== 'string' || value.length > 200) throw bad();
        out[key] = value.trim();
        break;
      case 'str?':
        if (value === null || value === '') out[key] = null;
        else if (typeof value === 'string' && value.length <= 500) out[key] = value.trim();
        else throw bad();
        break;
      case 'enum':
        if (!s.values.includes(value)) throw bad();
        out[key] = value;
        break;
    }
  }
  return out;
}

export class ConfigStore {
  constructor(file) {
    this.file = file;
    this.settings = { ...DEFAULT_CONFIG };
    this.presets = [];
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        try { Object.assign(this.settings, validateSettings(raw)); } catch { /* keep defaults on bad values */ }
        if (Array.isArray(raw.presets)) this.presets = raw.presets.filter((p) => p && typeof p.name === 'string');
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`Warning: could not load config ${this.file}: ${e.message}`);
    }
    return this;
  }

  get() {
    return { ...this.settings };
  }

  async update(partial) {
    Object.assign(this.settings, validateSettings(partial));
    await this.save();
    return this.get();
  }

  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ ...this.settings, presets: this.presets }, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  listPresets() {
    return this.presets.slice();
  }

  async savePreset(preset) {
    const name = String(preset?.name ?? '').trim().slice(0, 60);
    if (!name) throw new ApiError(400, 'invalid_preset', 'Preset needs a name');
    const channels = (Array.isArray(preset.channels) ? preset.channels : [])
      .map((c) => (c ? String(c).slice(0, 100) : null)).slice(0, 6);
    const layout = preset.layout in LAYOUTS ? preset.layout : '2x2';
    const audioIndex = Number.isInteger(preset.audioIndex) ? preset.audioIndex : 0;
    const entry = { name, channels, layout, audioIndex };
    const i = this.presets.findIndex((p) => p.name === name);
    if (i >= 0) this.presets[i] = entry; else this.presets.push(entry);
    await this.save();
    return entry;
  }

  async deletePreset(name) {
    const before = this.presets.length;
    this.presets = this.presets.filter((p) => p.name !== name);
    if (this.presets.length !== before) await this.save();
    return before !== this.presets.length;
  }
}

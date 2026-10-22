// Token persistence: file (chmod 600) with optional keytar keyring.
import fs from 'node:fs/promises';
import path from 'node:path';
import { KEYRING_SERVICE } from './constants.js';
import { log } from './log.js';

const KINDS = {
  token: { file: 'token', account: 'oauth_token' },
  web: { file: 'web_token', account: 'web_auth_token' },
};

export class TokenStorage {
  /** @param {{dir: string, useKeyring?: boolean, legacyFile?: string}} o */
  constructor({ dir, useKeyring = false, legacyFile = null }) {
    this.dir = dir;
    this.useKeyring = useKeyring;
    this.legacyFile = legacyFile; // read-only fallback (the Python CLI's token)
    this._kt = undefined;
  }

  setKeyring(enabled) {
    this.useKeyring = !!enabled;
  }

  async keytar(quiet = false) {
    if (!this.useKeyring) return null;
    if (this._kt === undefined) {
      try {
        const mod = await import('keytar');
        this._kt = mod.default ?? mod;
      } catch {
        this._kt = null;
        (quiet ? log.debug : log.warn)('Keyring requested but "keytar" is not installed; using token files');
      }
    }
    return this._kt;
  }

  async keyringAvailable() {
    const prev = this.useKeyring;
    this.useKeyring = true;
    const kt = await this.keytar(true);
    this.useKeyring = prev;
    return !!kt;
  }

  async _readFile(p) {
    try {
      return (await fs.readFile(p, 'utf8')).trim() || null;
    } catch {
      return null;
    }
  }

  async get(kind = 'token') {
    const k = KINDS[kind];
    const kt = await this.keytar();
    if (kt) {
      try {
        const v = await kt.getPassword(KEYRING_SERVICE, k.account);
        if (v) return v;
      } catch (e) {
        log.debug('keyring get failed:', e.message);
      }
    }
    const v = await this._readFile(path.join(this.dir, k.file));
    if (v) return v;
    if (kind === 'token' && this.legacyFile) return this._readFile(this.legacyFile);
    return null;
  }

  async save(kind, value) {
    const k = KINDS[kind];
    const kt = await this.keytar();
    if (kt) {
      try {
        await kt.setPassword(KEYRING_SERVICE, k.account, value);
        return;
      } catch (e) {
        log.debug('keyring save failed, falling back to file:', e.message);
      }
    }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const p = path.join(this.dir, k.file);
    await fs.writeFile(p, value, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(p, 0o600).catch(() => {});
  }

  async delete(kind = 'token') {
    const k = KINDS[kind];
    const kt = await this.keytar();
    if (kt) {
      try { await kt.deletePassword(KEYRING_SERVICE, k.account); } catch (e) { log.debug('keyring delete failed:', e.message); }
    }
    await fs.rm(path.join(this.dir, k.file), { force: true }).catch(() => {});
    if (kind === 'token' && this.legacyFile) await fs.rm(this.legacyFile, { force: true }).catch(() => {});
  }
}

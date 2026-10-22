// HLSAdBlockProxy: per-stream proxy logic (ported from the Python class).
// It is transport-agnostic: Express routes call buildMaster()/handleVariant()
// and decide how to serialise the result. Network access is injectable so the
// rotation rules can be unit-tested with a mocked fetch.
import { AD_FREE_PARAM_SETS, MIN_BW_RATIO, ROTATE_COOLDOWN_MS } from './constants.js';
import { buildUsherUrl } from './twitch.js';
import {
  codecFamily, describeVariants, isAudioOnlyVariant, parseMasterMedia, parseMasterVariants,
  pickBestMaster, playlistHasAds, renderMaster, selectVariant, variantFromMaster, variantKey, variantLabel,
} from './hlsLogic.js';
import { log } from './log.js';

export class HLSAdBlockProxy {
  /**
   * @param {object} o
   * @param {{getStreamPlaybackToken: Function, fetchText: Function}} o.twitch
   * @param {string} o.channel
   * @param {string|null} o.quality
   * @param {Set<string>|null} [o.allowedCodecs] families the client can decode (null = all)
   * @param {(level:string, message:string)=>void} [o.onEvent]
   * @param {(url:string)=>Promise<string|null>} [o.fetchText]
   * @param {()=>number} [o.now]
   */
  constructor({ twitch, channel, quality = null, allowedCodecs = null, onEvent = () => {}, fetchText, now = () => Date.now() }) {
    this.twitch = twitch;
    this.channel = channel;
    this.quality = quality;
    this.allowedCodecs = allowedCodecs;
    this.onEvent = onEvent;
    this.fetchText = fetchText ?? ((u) => twitch.fetchText(u));
    this.now = now;

    this.tokens = new Map(); // preset -> {value, signature}
    this.preset = 0; // flavor currently considered "active"
    this.preferred = new Map(); // variant key -> known-clean upstream URL
    this.lastRotate = -Infinity;
    this.lastFlavor = null;
    this.notedQuality = null;
    this.masterPreset = null; // known-good preset after the first success
    this.adWarned = false;
    this.info = null; // exposed to the UI via session meta
    this.lastActivity = now();
  }

  // ---- master ----------------------------------------------------------
  async _masterUrl(preset) {
    let cached = this.tokens.get(preset);
    if (!cached) {
      const t = await this.twitch.getStreamPlaybackToken(this.channel, AD_FREE_PARAM_SETS[preset]);
      if (!t) return null;
      cached = { value: t.value, signature: t.signature };
      this.tokens.set(preset, cached);
    }
    return buildUsherUrl(this.channel, cached.value, cached.signature);
  }

  async _fetchMaster(preset) {
    // A cached token may have expired; drop it and retry once with a fresh one.
    for (let attempt = 0; attempt < 2; attempt++) {
      const hadCache = this.tokens.has(preset);
      const url = await this._masterUrl(preset);
      if (!url) return null;
      const master = await this.fetchText(url);
      if (master && master.includes('#EXT-X-STREAM-INF')) return master;
      this.tokens.delete(preset);
      if (!hadCache) break;
    }
    return null;
  }

  _filterCodecs(variants) {
    if (!this.allowedCodecs) return variants;
    return variants.filter((v) => {
      if (isAudioOnlyVariant(v)) return true;
      const fam = codecFamily(v);
      return fam === '?' || this.allowedCodecs.has(fam);
    });
  }

  async _loadVariants(preset) {
    const master = await this._fetchMaster(preset);
    if (!master) return null;
    const variants = this._filterCodecs(parseMasterVariants(master));
    if (!variants.length) return null;
    log.debug(
      `adblock: flavor '${AD_FREE_PARAM_SETS[preset].playerType}' offers:`,
      variants.map((v) => `${v.name || v.video} [${v.width}x${v.height}@${v.fps} ${codecFamily(v)}]`).join(', '),
    );
    return { preset, master, variants };
  }

  async _gatherMasters(presets) {
    const found = await Promise.all(presets.map((p) => this._loadVariants(p).catch(() => null)));
    return found.filter(Boolean);
  }

  /**
   * Different player types are offered different renditions (the android
   * token often lacks 1440p60 and HEVC/AV1), so ask every flavor at once and
   * keep the master with the best match. Ties go to the earliest flavor.
   * @returns {Promise<{code:number, body:string}>}
   */
  async buildMaster() {
    this.lastActivity = this.now();
    const all = AD_FREE_PARAM_SETS.map((_, i) => i);
    const known = this.masterPreset;
    let results = await this._gatherMasters(known !== null ? [known] : all);
    if (!results.length && known !== null) results = await this._gatherMasters(all);

    const best = pickBestMaster(results, this.quality);
    if (!best) return { code: 502, body: 'could not fetch master playlist' };

    if (this.notedQuality === null) selectVariant(best.variants, this.quality, (m) => this.onEvent('warn', m));
    this.masterPreset = best.preset;
    this.preset = best.preset;

    const label = variantLabel(best.chosen);
    if (this.notedQuality !== label) {
      this.notedQuality = label;
      this.onEvent('info', `Ad-block: serving '${label}'`);
    }

    const ordered = [best.chosen, ...best.variants.filter((v) => v !== best.chosen && v.bandwidth <= best.chosen.bandwidth)];
    this.info = {
      chosenKey: variantKey(best.chosen),
      chosenLabel: label,
      family: codecFamily(best.chosen),
      flavor: AD_FREE_PARAM_SETS[best.preset].playerType,
      variants: describeVariants(ordered),
    };

    // Variant URIs are relative to /proxy/:sid/master.m3u8 -> /proxy/:sid/variant
    const body = renderMaster(best.variants, parseMasterMedia(best.master), best.chosen, (v) =>
      `variant?u=${encodeURIComponent(v.uri)}&n=${encodeURIComponent(variantKey(v))}&bw=${v.bandwidth}`);
    return { code: 200, body };
  }

  // ---- variants --------------------------------------------------------
  /**
   * Returns {code, text, url} where url is the upstream playlist the text came
   * from (needed by the caller to resolve relative segment URIs).
   */
  async handleVariant(upstream, videoId, minBw) {
    this.lastActivity = this.now();
    const preferred = this.preferred.get(videoId);

    if (preferred && preferred !== upstream) {
      const text = await this.fetchText(preferred);
      if (text !== null && !playlistHasAds(text)) return { code: 200, text, url: preferred };
      this.preferred.delete(videoId);
    }

    const text = await this.fetchText(upstream);
    if (text === null) {
      // Upstream URL may have expired; re-derive it from a fresh master.
      const refreshed = await this._refreshVariant(videoId, minBw);
      if (refreshed) return { code: 200, ...refreshed };
      return { code: 502, text: 'upstream fetch failed', url: upstream };
    }

    if (!playlistHasAds(text)) {
      this.preferred.set(videoId, upstream);
      return { code: 200, text, url: upstream };
    }

    const clean = await this._rotateForClean(videoId, minBw);
    if (clean) return { code: 200, ...clean };

    // Nothing clean at the same quality: pass the ads through rather than
    // silently dropping to a lower rendition.
    if (!this.adWarned) {
      this.adWarned = true;
      this.onEvent('warn', 'Mid-roll ads detected; no same-quality ad-free flavor, passing through');
    }
    return { code: 200, text, url: upstream };
  }

  /**
   * Rotation rules:
   *  - at most one rotation per ROTATE_COOLDOWN_MS (cooldown starts when attempted)
   *  - try flavors starting AFTER the current preset, wrapping around, ending with the current one
   *  - a flavor qualifies only if it has the same quality key at >= MIN_BW_RATIO of the requested bandwidth
   *  - the candidate playlist must itself be ad-free
   */
  async _rotateForClean(videoId, minBw) {
    const t = this.now();
    if (t - this.lastRotate < ROTATE_COOLDOWN_MS) return null;
    this.lastRotate = t;

    const n = AD_FREE_PARAM_SETS.length;
    for (let offset = 1; offset <= n; offset++) {
      const preset = (this.preset + offset) % n;
      const master = await this._fetchMaster(preset);
      if (!master) continue;

      const variant = variantFromMaster(this._filterCodecs(parseMasterVariants(master)), videoId, minBw, MIN_BW_RATIO);
      if (!variant) {
        log.debug(`adblock: flavor '${AD_FREE_PARAM_SETS[preset].playerType}' lacks matching quality`);
        continue;
      }

      const text = await this.fetchText(variant.uri);
      if (text !== null && !playlistHasAds(text)) {
        this.preset = preset;
        this.preferred.set(videoId, variant.uri);
        const flavor = AD_FREE_PARAM_SETS[preset].playerType;
        if (this.lastFlavor !== flavor) {
          this.lastFlavor = flavor;
          this.onEvent('info', `Ad-block: switched to '${flavor}' token at same quality`);
        }
        return { text, url: variant.uri };
      }
    }
    return null;
  }

  async _refreshVariant(videoId, minBw) {
    const n = AD_FREE_PARAM_SETS.length;
    for (let offset = 0; offset < n; offset++) {
      const preset = (this.preset + offset) % n;
      const master = await this._fetchMaster(preset);
      if (!master) continue;
      const variant = variantFromMaster(this._filterCodecs(parseMasterVariants(master)), videoId, minBw, MIN_BW_RATIO);
      if (!variant) continue;
      const text = await this.fetchText(variant.uri);
      if (text !== null) {
        this.preferred.set(videoId, variant.uri);
        return { text, url: variant.uri };
      }
    }
    return null;
  }

  stop() {
    this.tokens.clear();
    this.preferred.clear();
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseInput, parseTwitchUrl, closestMatch, similarity } from '../server/util.js';
import {
  playlistHasAds, parseMasterVariants, parseMasterMedia, selectVariant, bestVariant, codecFamily, variantKey,
  renderMaster, variantFromMaster, pickBestMaster, rewritePlaylist, isAllowedUpstream,
} from '../server/hlsLogic.js';
import { HLSAdBlockProxy } from '../server/proxy.js';
import { AD_FREE_PARAM_SETS } from '../server/constants.js';
import { redact, registerSecret } from '../server/log.js';

// ---------------------------------------------------------------- fixtures
function master({ prefix, extra = '' }) {
  return `#EXTM3U
#EXT-X-TWITCH-INFO:NODE="video-edge"
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://v.ttvnw.net/${prefix}/chunked.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3400000,RESOLUTION=1280x720,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="720p60",FRAME-RATE=60.000
https://v.ttvnw.net/${prefix}/720p60.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="480p30",NAME="480p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=852x480,CODECS="avc1.4D401F,mp4a.40.2",VIDEO="480p30",FRAME-RATE=30.000
https://v.ttvnw.net/${prefix}/480p30.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",VIDEO="audio_only"
https://v.ttvnw.net/${prefix}/audio_only.m3u8
${extra}`;
}

const HEVC_EXTRA = `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="1440p60",NAME="1440p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=12000000,RESOLUTION=2560x1440,CODECS="hvc1.1.6.L153.B0,mp4a.40.2",VIDEO="1440p60",FRAME-RATE=60.000
https://v.ttvnw.net/hevc/1440p60.m3u8
`;

const variants = () => parseMasterVariants(master({ prefix: 'a' }));

// ---------------------------------------------------------------- URL parsing
test('parseTwitchUrl handles channels, vods and clips', () => {
  assert.deepEqual(parseTwitchUrl('https://www.twitch.tv/Shroud'), { type: 'channel', id: 'shroud' });
  assert.deepEqual(parseTwitchUrl('https://www.twitch.tv/videos/12345'), { type: 'vod', id: '12345' });
  assert.deepEqual(parseTwitchUrl('https://clips.twitch.tv/FunnySlug'), { type: 'clip', id: 'FunnySlug' });
  assert.deepEqual(parseTwitchUrl('https://www.twitch.tv/somechan/clip/SlugX'), { type: 'clip', id: 'SlugX' });
  assert.equal(parseTwitchUrl('https://example.com/shroud'), null);
  assert.equal(parseTwitchUrl('https://eviltwitch.tv/shroud'), null);
  assert.equal(parseTwitchUrl('https://www.twitch.tv/videos'), null);
  assert.equal(parseTwitchUrl('https://www.twitch.tv/'), null);
});

test('parseInput accepts names, schemeless urls and full urls', () => {
  assert.deepEqual(parseInput('  Ninja '), { type: 'channel', id: 'ninja' });
  assert.deepEqual(parseInput('twitch.tv/ninja'), { type: 'channel', id: 'ninja' });
  assert.deepEqual(parseInput('www.twitch.tv/videos/99'), { type: 'vod', id: '99' });
  assert.deepEqual(parseInput('https://clips.twitch.tv/abc'), { type: 'clip', id: 'abc' });
  assert.equal(parseInput(''), null);
  assert.equal(parseInput('not a channel!'), null);
});

test('fuzzy game matching mirrors difflib cutoff 0.6', () => {
  assert.equal(closestMatch('valorant', ['Just Chatting', 'VALORANT', 'Fortnite']), 'VALORANT');
  assert.equal(closestMatch('zzzzzz', ['Just Chatting', 'Fortnite']), null);
  assert.ok(similarity('abcd', 'abcd') === 1);
});

// ---------------------------------------------------------------- ads / parsing
test('playlistHasAds detects every marker', () => {
  for (const m of ['twitch-stitched-ad', 'stitched-ad', 'EXT-X-SCTE35', 'stitchedad']) {
    assert.equal(playlistHasAds(`#EXTM3U\n#X:${m}\n`), true, m);
  }
  assert.equal(playlistHasAds('#EXTM3U\n#EXTINF:2.0,live\nseg.ts\n'), false);
});

test('parseMasterVariants reads names from EXT-X-MEDIA, resolution, fps, codecs', () => {
  const v = variants();
  assert.equal(v.length, 4);
  assert.equal(v[0].name, '1080p60 (source)');
  assert.equal(v[0].height, 1080);
  assert.equal(v[0].fps, 60);
  assert.equal(v[0].bandwidth, 8000000);
  assert.equal(v[1].video, '720p60');
  assert.equal(parseMasterMedia(master({ prefix: 'a' })).length, 4);
});

test('codec family detection and variant keys', () => {
  const all = parseMasterVariants(master({ prefix: 'a', extra: HEVC_EXTRA }));
  assert.equal(codecFamily(all[0]), 'H.264');
  assert.equal(codecFamily(all[4]), 'HEVC');
  assert.equal(codecFamily(all[3]), 'audio');
  assert.equal(variantKey(all[0]), 'chunked|H.264');
  assert.equal(variantKey(all[4]), '1440p60|HEVC');
  assert.equal(codecFamily({ codecs: 'av01.0.12M.08', video: 'x', name: '' }), 'AV1');
});

// ---------------------------------------------------------------- selection
test('source/best prefers highest resolution, not just "chunked"', () => {
  const all = parseMasterVariants(master({ prefix: 'a', extra: HEVC_EXTRA }));
  assert.equal(selectVariant(all, 'source').video, '1440p60');
  assert.equal(selectVariant(all, null).video, '1440p60');
  assert.equal(bestVariant(variants()).video, 'chunked');
});

test('audio_only selection, and audio is excluded from best unless alone', () => {
  const v = variants();
  assert.equal(selectVariant(v, 'audio_only').video, 'audio_only');
  assert.equal(selectVariant(v.slice(0, 3), 'audio_only'), null);
  assert.equal(bestVariant([v[3]]).video, 'audio_only');
});

test('quality matching: height+fps, height only, fps tolerance, fallback with warning', () => {
  const v = variants();
  assert.equal(selectVariant(v, '720p60').video, '720p60');
  assert.equal(selectVariant(v, '480').video, '480p30');
  assert.equal(selectVariant(v, '1080').video, 'chunked');
  assert.equal(selectVariant(v, '480p30').video, '480p30');
  // 720p30 does not exist: the 720p60 rendition is outside the ±1 fps tolerance on the
  // height-only branch, so we fall back to best and warn.
  let warned = '';
  const picked = selectVariant(v, '720p30', (m) => { warned = m; });
  assert.equal(picked.video, 'chunked');
  assert.match(warned, /not offered/);
  warned = '';
  assert.equal(selectVariant(v, '144p', (m) => { warned = m; }).video, 'chunked');
  assert.ok(warned);
});

test('pickBestMaster scores (height, fps, -preset); ties go to the earliest flavor', () => {
  const low = parseMasterVariants(master({ prefix: 'm' }));
  const high = parseMasterVariants(master({ prefix: 'w', extra: HEVC_EXTRA }));
  const tieA = { preset: 0, master: 'm0', variants: low };
  const tieB = { preset: 2, master: 'm2', variants: parseMasterVariants(master({ prefix: 'e' })) };
  assert.equal(pickBestMaster([tieB, tieA], 'source').preset, 0);
  assert.equal(pickBestMaster([tieA, { preset: 1, master: 'm1', variants: high }], 'source').preset, 1);
  // requesting 720p60: everyone ties -> earliest
  assert.equal(pickBestMaster([{ preset: 3, variants: high }, { preset: 1, variants: low }], '720p60').preset, 1);
  assert.equal(pickBestMaster([], 'source'), null);
});

// ---------------------------------------------------------------- rendering
test('renderMaster: chosen first, only variants at/below its bitrate, rewritten URIs', () => {
  const v = variants();
  const out = renderMaster(v, ['#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked"'], v[1], (x) => `variant?n=${x.video}`);
  const lines = out.trim().split('\n');
  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[1], '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked"');
  const uris = lines.filter((l) => l.startsWith('variant?'));
  assert.deepEqual(uris, ['variant?n=720p60', 'variant?n=480p30', 'variant?n=audio_only']);
  assert.ok(!out.includes('chunked.m3u8'));
});

test('variantFromMaster requires the same key and >= 70% of the requested bandwidth', () => {
  const v = variants();
  assert.equal(variantFromMaster(v, 'chunked|H.264', 8000000).video, 'chunked');
  assert.equal(variantFromMaster(v, 'chunked|H.264', 12000000), null); // 8M < 0.7 * 12M
  assert.equal(variantFromMaster(v, 'chunked|H.264', 10000000).video, 'chunked'); // 8M >= 7M
  assert.equal(variantFromMaster(v, 'nope|H.264', 0), null);
  assert.equal(variantFromMaster(v, '', 0).video, 'chunked'); // empty key -> best non-audio
});

test('rewritePlaylist rewrites segments, maps and keys against the playlist URL', () => {
  const text = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="https://k.ttvnw.net/key"\n#EXTINF:2.0,\nseg1.ts\nhttps://cdn.ttvnw.net/seg2.ts\n';
  const out = rewritePlaylist(text, 'https://v.ttvnw.net/a/b/index.m3u8', (u) => `S(${u})`);
  assert.match(out, /URI="S\(https:\/\/v\.ttvnw\.net\/a\/b\/init\.mp4\)"/);
  assert.match(out, /URI="S\(https:\/\/k\.ttvnw\.net\/key\)"/);
  assert.match(out, /^S\(https:\/\/v\.ttvnw\.net\/a\/b\/seg1\.ts\)$/m);
  assert.match(out, /^S\(https:\/\/cdn\.ttvnw\.net\/seg2\.ts\)$/m);
});

test('segment passthrough only allows Twitch-ish https hosts', () => {
  assert.equal(isAllowedUpstream('https://video-weaver.fra02.hls.ttvnw.net/v1/segment/x.ts'), true);
  assert.equal(isAllowedUpstream('https://d1.cloudfront.net/vod/x.ts'), true);
  assert.equal(isAllowedUpstream('http://v.ttvnw.net/x.ts'), false);
  assert.equal(isAllowedUpstream('https://evil.example.com/x.ts'), false);
  assert.equal(isAllowedUpstream('https://ttvnw.net.evil.com/x.ts'), false);
  assert.equal(isAllowedUpstream('file:///etc/passwd'), false);
});

test('redact hides secrets and token/sig query values', () => {
  registerSecret('supersecrettokenvalue');
  const out = redact('Authorization: OAuth abc123def https://u/x.m3u8?token=XYZ&sig=QQQ&a=1 supersecrettokenvalue');
  assert.ok(!out.includes('abc123def') && !out.includes('XYZ') && !out.includes('QQQ') && !out.includes('supersecrettokenvalue'));
  assert.ok(out.includes('a=1'));
});

// ---------------------------------------------------------------- rotation (mocked fetch)
/**
 * Fake Twitch: each flavor index has its own master (urls contain the flavor's
 * playerType) and a per-URL playlist table the test controls.
 */
function harness({ masters = {}, playlists = {}, quality = null, startTime = 1_000_000 } = {}) {
  let clock = startTime;
  const events = [];
  const fetched = [];
  const twitch = {
    async getStreamPlaybackToken(_ch, params) {
      return { value: `tok-${params.playerType}`, signature: 'sig', mode: 'anonymous' };
    },
  };
  const fetchText = async (url) => {
    fetched.push(url);
    const u = new URL(url);
    if (u.hostname === 'usher.ttvnw.net') {
      const type = /tok-(\w+)/.exec(decodeURIComponent(u.searchParams.get('token')))[1];
      return masters[type] ?? null;
    }
    return url in playlists ? playlists[url] : null;
  };
  const proxy = new HLSAdBlockProxy({
    twitch, channel: 'chan', quality, fetchText, now: () => clock, onEvent: (l, m) => events.push([l, m]),
  });
  return { proxy, events, fetched, advance: (ms) => { clock += ms; }, setPlaylist: (u, t) => { playlists[u] = t; } };
}

const CLEAN = '#EXTM3U\n#EXTINF:2.0,live\nseg.ts\n';
const ADS = '#EXTM3U\n#EXT-X-DATERANGE:ID="x",CLASS="twitch-stitched-ad"\n#EXTINF:2.0,ad\nad.ts\n';
const flavorTypes = AD_FREE_PARAM_SETS.map((p) => p.playerType);
const masterFor = Object.fromEntries(flavorTypes.map((t) => [t, master({ prefix: t })]));

test('buildMaster serves the chosen quality first and emits a "serving" event', async () => {
  const h = harness({ masters: masterFor, quality: '720p60' });
  const { code, body } = await h.proxy.buildMaster();
  assert.equal(code, 200);
  const uris = body.split('\n').filter((l) => l.startsWith('variant?'));
  assert.equal(uris.length, 3); // 720p60, 480p30, audio_only
  assert.match(decodeURIComponent(uris[0]), /720p60\.m3u8/);
  assert.match(uris[0], /&n=720p60%7CH\.264&bw=3400000$/);
  assert.deepEqual(h.events[0], ['info', "Ad-block: serving '720p60'"]);
  assert.equal(h.proxy.info.chosenKey, '720p60|H.264');
});

test('buildMaster returns 502 when no flavor yields a master', async () => {
  const h = harness({ masters: {} });
  assert.equal((await h.proxy.buildMaster()).code, 502);
});

test('clean variant is cached as preferred and returned untouched', async () => {
  const url = 'https://v.ttvnw.net/mobile/chunked.m3u8';
  const h = harness({ masters: masterFor, playlists: { [url]: CLEAN } });
  const r = await h.proxy.handleVariant(url, 'chunked|H.264', 8000000);
  assert.equal(r.code, 200);
  assert.equal(r.text, CLEAN);
  assert.equal(h.proxy.preferred.get('chunked|H.264'), url);
  assert.equal(h.events.length, 0);
});

test('ads trigger rotation to the next flavor at the same quality', async () => {
  const mobile = 'https://v.ttvnw.net/mobile/chunked.m3u8';
  const frontpage = 'https://v.ttvnw.net/frontpage/chunked.m3u8';
  const h = harness({ masters: masterFor, playlists: { [mobile]: ADS, [frontpage]: CLEAN } });
  const r = await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(r.text, CLEAN);
  assert.equal(r.url, frontpage);
  assert.equal(h.proxy.preset, 1);
  assert.equal(h.proxy.preferred.get('chunked|H.264'), frontpage);
  assert.deepEqual(h.events, [['info', "Ad-block: switched to 'frontpage' token at same quality"]]);
});

test('rotation skips flavors whose ad-free rendition is too low-bitrate (never degrade)', async () => {
  const mobile = 'https://v.ttvnw.net/mobile/chunked.m3u8';
  // frontpage's "chunked" is only 4 Mbps (< 70% of 8 Mbps) so it must be ignored; embed is fine.
  const lowMaster = master({ prefix: 'frontpage' }).replace('BANDWIDTH=8000000', 'BANDWIDTH=4000000');
  const h = harness({
    masters: { ...masterFor, frontpage: lowMaster },
    playlists: {
      [mobile]: ADS,
      'https://v.ttvnw.net/frontpage/chunked.m3u8': CLEAN,
      'https://v.ttvnw.net/embed/chunked.m3u8': CLEAN,
    },
  });
  const r = await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(r.url, 'https://v.ttvnw.net/embed/chunked.m3u8');
  assert.equal(h.proxy.preset, 2);
});

test('rotation candidates that also carry ads are skipped', async () => {
  const mobile = 'https://v.ttvnw.net/mobile/chunked.m3u8';
  const h = harness({
    masters: masterFor,
    playlists: {
      [mobile]: ADS,
      'https://v.ttvnw.net/frontpage/chunked.m3u8': ADS,
      'https://v.ttvnw.net/embed/chunked.m3u8': ADS,
      'https://v.ttvnw.net/ios/chunked.m3u8': CLEAN,
    },
  });
  const r = await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(r.url, 'https://v.ttvnw.net/ios/chunked.m3u8');
  assert.equal(h.proxy.preset, 3);
});

test('when nothing is clean, ads pass through unchanged with a one-time warning', async () => {
  const mobile = 'https://v.ttvnw.net/mobile/chunked.m3u8';
  const playlists = { [mobile]: ADS };
  for (const t of flavorTypes) playlists[`https://v.ttvnw.net/${t}/chunked.m3u8`] = ADS;
  const h = harness({ masters: masterFor, playlists });
  const r1 = await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(r1.text, ADS);
  assert.equal(r1.code, 200);
  h.advance(10_000);
  await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(h.events.filter(([, m]) => /Mid-roll ads detected/.test(m)).length, 1);
});

test('rotation cooldown: no second rotation within 4s, allowed afterwards', async () => {
  const mobile = 'https://v.ttvnw.net/mobile/chunked.m3u8';
  const frontpage = 'https://v.ttvnw.net/frontpage/chunked.m3u8';
  const playlists = { [mobile]: ADS };
  for (const t of flavorTypes) playlists[`https://v.ttvnw.net/${t}/chunked.m3u8`] = ADS;
  const h = harness({ masters: masterFor, playlists });

  await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000); // rotation attempted, all ads
  const fetchesAfterFirst = h.fetched.length;

  h.setPlaylist(frontpage, CLEAN); // a clean flavor appears...
  h.advance(1000); // ...but we're inside the cooldown
  const early = await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(early.text, ADS);
  assert.equal(h.fetched.length, fetchesAfterFirst + 1); // only the upstream fetch, no master refetches

  h.advance(4000); // cooldown elapsed
  const later = await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(later.text, CLEAN);
});

test('preferred clean URL is tried first and dropped when it starts serving ads', async () => {
  const mobile = 'https://v.ttvnw.net/mobile/chunked.m3u8';
  const frontpage = 'https://v.ttvnw.net/frontpage/chunked.m3u8';
  const h = harness({ masters: masterFor, playlists: { [mobile]: ADS, [frontpage]: CLEAN } });
  await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000); // rotates, prefers frontpage
  const again = await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(again.url, frontpage);

  h.setPlaylist(frontpage, ADS); // preferred goes bad
  h.advance(10_000);
  h.setPlaylist(mobile, CLEAN); // original recovers
  const r = await h.proxy.handleVariant(mobile, 'chunked|H.264', 8000000);
  assert.equal(r.url, mobile);
  assert.equal(h.proxy.preferred.get('chunked|H.264'), mobile);
});

test('expired upstream URL is re-derived from a fresh master', async () => {
  const stale = 'https://v.ttvnw.net/mobile/expired.m3u8'; // not in playlists -> fetch returns null
  const fresh = 'https://v.ttvnw.net/mobile/chunked.m3u8';
  const h = harness({ masters: masterFor, playlists: { [fresh]: CLEAN } });
  const r = await h.proxy.handleVariant(stale, 'chunked|H.264', 8000000);
  assert.equal(r.code, 200);
  assert.equal(r.url, fresh);
  const dead = harness({ masters: {}, playlists: {} });
  assert.equal((await dead.proxy.handleVariant(stale, 'chunked|H.264', 8000000)).code, 502);
});

test('allowedCodecs hides renditions the browser cannot decode', async () => {
  const withHevc = Object.fromEntries(flavorTypes.map((t) => [t, master({ prefix: t, extra: HEVC_EXTRA })]));
  const all = harness({ masters: withHevc });
  assert.equal((await all.proxy.buildMaster()).code, 200);
  assert.equal(all.proxy.info.chosenKey, '1440p60|HEVC');

  const h264 = harness({ masters: withHevc });
  h264.proxy.allowedCodecs = new Set(['H.264']);
  await h264.proxy.buildMaster();
  assert.equal(h264.proxy.info.chosenKey, 'chunked|H.264');
});

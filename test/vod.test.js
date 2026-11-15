// VOD resume, VOD chat replay and web-token VOD sources (pure logic, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { END_MARGIN_S, MIN_RESUME_S, VodProgress, pickResume, resumable } from '../server/progress.js';
import { commentToChat, parseComments } from '../server/vodChat.js';
import { TwitchClient, buildVodUsherUrl } from '../server/twitch.js';
import { PassthroughProxy } from '../server/sessions.js';
import { createReplayDriver } from '../web/js/replay.js';

// ---------------------------------------------------------------- resume rules
test('resumable ignores the first seconds and the very end', () => {
  assert.equal(resumable(MIN_RESUME_S - 1, 3600), false);
  assert.equal(resumable(MIN_RESUME_S, 3600), true);
  assert.equal(resumable(3600 - END_MARGIN_S, 3600), true);
  assert.equal(resumable(3600 - END_MARGIN_S + 1, 3600), false);
  assert.equal(resumable(120, 0), true); // unknown duration: only the start rule applies
  assert.equal(resumable(NaN), false);
});

test('pickResume prefers the most recently updated record', () => {
  const local = { position: 500, updatedAt: 2000 };
  const remote = { position: 900, updatedAt: 1000 };
  assert.deepEqual(pickResume(local, remote, 3600), { position: 500, source: 'local', updatedAt: 2000 });
  assert.deepEqual(pickResume({ ...local, updatedAt: 500 }, remote, 3600), { position: 900, source: 'twitch', updatedAt: 1000 });
  assert.equal(pickResume(null, null, 3600), null);
  assert.deepEqual(pickResume(null, remote, 3600)?.source, 'twitch');
});

test('a newer "start over" marker hides an older Twitch position', () => {
  const tombstone = { position: 0, updatedAt: 5000 };
  assert.equal(pickResume(tombstone, { position: 900, updatedAt: 1000 }, 3600), null);
  // ...but watching again on twitch.tv afterwards wins again
  assert.equal(pickResume(tombstone, { position: 900, updatedAt: 9000 }, 3600)?.position, 900);
});

test('pickResume drops positions near the end of the VOD', () => {
  assert.equal(pickResume(null, { position: 3590, updatedAt: 1 }, 3600), null);
});

// ---------------------------------------------------------------- progress store
test('VodProgress stores, tombstones, caps and persists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vodprog-'));
  const file = path.join(dir, 'p.json');
  let t = 1000;
  const store = new VodProgress(file, { now: () => t++ });

  assert.equal(store.set('123', 600.7, 3600).position, 600);
  assert.deepEqual(store.resumable(), { 123: { position: 600, duration: 3600 } });

  store.set('123', 3, 3600); // too early -> tombstone, not deleted
  assert.equal(store.get('123').position, 0);
  assert.deepEqual(store.resumable(), {});

  store.set('456', 100, 3600);
  store.clear('456');
  assert.equal(store.get('456').position, 0);
  assert.ok(store.get('456').updatedAt > 1000);

  assert.equal(store.set('9', -5), null);
  assert.equal(store.set('9', 'abc'), null);

  store.set('777', 200, 3600);
  await store.flush();
  const again = await new VodProgress(file).load();
  assert.equal(again.get('777').position, 200);
  assert.equal(again.get('456').position, 0);

  for (let i = 0; i < 320; i++) store.set(String(1000 + i), 100, 3600);
  assert.ok(store.map.size <= 300);
  assert.equal(store.get('1319').position, 100); // newest kept
  assert.equal(store.get('777'), null);          // oldest evicted
  clearTimeout(store.timer);
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- VOD chat mapping
const node = (over = {}) => ({
  id: 'c1', contentOffsetSeconds: 12.5, createdAt: '2026-01-01T00:00:12Z',
  commenter: { id: '7', login: 'Viewer', displayName: 'Viewer' },
  message: {
    fragments: [{ text: 'hi ', emote: null }, { text: 'Kappa', emote: { emoteID: '25' } }, { text: ' @Me nice', emote: null }],
    userBadges: [{ setID: 'subscriber', version: '12' }, { setID: 'moderator', version: '1' }],
    userColor: '#FF4500',
  },
  ...over,
});

test('commentToChat produces the live-chat message shape', () => {
  const m = commentToChat(node(), { selfLogin: 'me' });
  assert.equal(m.login, 'viewer');
  assert.equal(m.display, 'Viewer');
  assert.equal(m.color, '#FF4500');
  assert.equal(m.offset, 12.5);
  assert.equal(m.text, 'hi Kappa @Me nice');
  assert.deepEqual(m.emotes, [
    { type: 'text', text: 'hi ' }, { type: 'emote', id: '25', text: 'Kappa' }, { type: 'text', text: ' @Me nice' },
  ]);
  assert.deepEqual(m.badges, [{ id: 'subscriber', version: '12' }, { id: 'moderator', version: '1' }]);
  assert.equal(m.mod, true);
  assert.equal(m.mention, true);
  assert.equal(m.action, false);
});

test('commentToChat merges adjacent text fragments and tolerates bad input', () => {
  const m = commentToChat(node({ message: { fragments: [{ text: 'a' }, { text: 'b' }], userBadges: null, userColor: 'red' } }));
  assert.deepEqual(m.emotes, [{ type: 'text', text: 'ab' }]);
  assert.equal(m.color, null);
  assert.deepEqual(m.badges, []);
  assert.equal(commentToChat(null), null);
  assert.equal(commentToChat(node({ message: null })), null);
  assert.equal(commentToChat(node({ message: { fragments: [] } })), null);
  assert.equal(commentToChat(node({ commenter: null })).login, ''); // deleted account
});

test('parseComments returns the cursor and paging state', () => {
  const data = { video: { comments: { edges: [{ cursor: 'a', node: node({ id: '1' }) }, { cursor: 'b', node: node({ id: '2' }) }], pageInfo: { hasNextPage: true } } } };
  const p = parseComments(data);
  assert.equal(p.messages.length, 2);
  assert.equal(p.cursor, 'b');
  assert.equal(p.hasNext, true);
  assert.equal(p.found, true);
  assert.deepEqual(parseComments({ video: { comments: { edges: [], pageInfo: { hasNextPage: true } } } }).hasNext, false); // no cursor to continue with
  assert.equal(parseComments({ video: null }).found, false);
  assert.equal(parseComments(null).messages.length, 0);
});

// ---------------------------------------------------------------- VOD sources (web token)
function clientWith(gqlImpl, { web = null } = {}) {
  const c = new TwitchClient({ storage: { get: async () => null, save: async () => {}, delete: async () => {} }, env: {} });
  c.webToken = web;
  c.gql = gqlImpl;
  return c;
}
const tokenReply = (v) => ({ data: { videoPlaybackAccessToken: { value: v, signature: `sig-${v}` } }, error: '' });

test('getVodSources: web token first (with codecs), anonymous as fallback', async () => {
  const seen = [];
  const c = clientWith(async (_q, vars, headers) => {
    seen.push({ platform: vars.params.platform, auth: headers.Authorization });
    return tokenReply(headers.Authorization ? 'web' : 'anon');
  }, { web: 'webtokenvalue123' });
  const sources = await c.getVodSources('42');
  assert.deepEqual(sources.map((s) => s.mode), ['web-login', 'anonymous']);
  assert.match(sources[0].url, /supported_codecs=av1,h265,h264/);
  assert.doesNotMatch(sources[1].url, /supported_codecs/);
  assert.ok(seen.some((s) => s.platform === 'web' && s.auth === 'OAuth webtokenvalue123'));
});

test('getVodSources without a web token is anonymous only', async () => {
  const c = clientWith(async () => tokenReply('anon'));
  assert.deepEqual((await c.getVodSources('42')).map((s) => s.mode), ['anonymous']);
  assert.equal(buildVodUsherUrl('1', 't', 's').includes('supported_codecs'), false);
});

test('getVodSources survives a rejected web token and skips it for a while', async () => {
  let calls = 0;
  const c = clientWith(async (_q, _v, headers) => {
    calls++;
    return headers.Authorization ? { data: null, error: 'unauthorized' } : tokenReply('anon');
  }, { web: 'webtokenvalue123' });
  assert.deepEqual((await c.getVodSources('42')).map((s) => s.mode), ['anonymous']);
  assert.match(c.tokenFailures['vod-web-login'], /unauthorized/);
  calls = 0;
  await c.getVodSources('43');
  assert.equal(calls, 1); // web mode is skipped during the failure TTL
});

test('getVodResume reads viewingHistory, and is null without credentials or history', async () => {
  assert.equal(await clientWith(async () => { throw new Error('should not be called'); }).getVodResume('1'), null);
  const hit = clientWith(async () => ({ data: { video: { self: { viewingHistory: { position: 321, updatedAt: '2026-02-03T04:05:06Z' } } } }, error: '' }), { web: 'webtokenvalue123' });
  assert.deepEqual(await hit.getVodResume('1'), { position: 321, updatedAt: Date.parse('2026-02-03T04:05:06Z') });
  const none = clientWith(async () => ({ data: { video: { self: { viewingHistory: null } } }, error: '' }), { web: 'webtokenvalue123' });
  assert.equal(await none.getVodResume('1'), null);
  const broken = clientWith(async () => ({ data: null, error: 'schema changed' }), { web: 'webtokenvalue123' });
  assert.equal(await broken.getVodResume('1'), null); // best-effort, never throws
});

test('getVodComments uses the persisted query, then falls back to plain text', async () => {
  const page = { data: { video: { comments: { edges: [{ cursor: 'z', node: node() }], pageInfo: { hasNextPage: true } } } }, error: '' };
  const c = new TwitchClient({ storage: {}, env: {} });
  const bodies = [];
  c.gqlBody = async (body) => { bodies.push(body); return page; };
  const r = await c.getVodComments('42', { offset: 99.9 });
  assert.equal(bodies[0].variables.contentOffsetSeconds, 99);
  assert.equal(bodies[0].extensions.persistedQuery.sha256Hash.length, 64);
  assert.equal(r.messages.length, 1);
  assert.equal(r.cursor, 'z');
  await c.getVodComments('42', { cursor: 'z' });
  assert.equal(bodies[1].variables.cursor, 'z');
  assert.equal('contentOffsetSeconds' in bodies[1].variables, false);

  const c2 = new TwitchClient({ storage: {}, env: {} });
  c2.gqlBody = async () => ({ data: null, error: '[{"message":"PersistedQueryNotFound"}]' });
  let plain = null;
  c2.gql = async (q, vars) => { plain = { q, vars }; return page; };
  assert.equal((await c2.getVodComments('42', { offset: 5 })).messages.length, 1);
  assert.match(plain.q, /comments\(contentOffsetSeconds/);
  assert.deepEqual(plain.vars, { id: '42', offset: 5 });

  const c3 = new TwitchClient({ storage: {}, env: {} });
  c3.gqlBody = async () => ({ data: { video: null }, error: '' });
  await assert.rejects(() => c3.getVodComments('42', { offset: 0 }), { code: 'vod_not_found' });
});

// ---------------------------------------------------------------- passthrough fallback
test('PassthroughProxy falls back to the next source when the first master is rejected', async () => {
  const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.64002A,mp4a.40.2",VIDEO="chunked",FRAME-RATE=60.000
https://v.ttvnw.net/x/chunked.m3u8
`;
  const events = [];
  const twitch = { fetchText: async (url) => (url.includes('web') ? null : MASTER) };
  const p = new PassthroughProxy({
    twitch, sources: [{ url: 'https://usher.ttvnw.net/web', mode: 'web-login' }, { url: 'https://usher.ttvnw.net/anon', mode: 'anonymous' }],
    quality: null, allowedCodecs: null, onEvent: (l, m) => events.push([l, m]), wrap: (u) => u,
  });
  const r = await p.buildMaster();
  assert.equal(r.code, 200);
  assert.equal(p.mode, 'anonymous');
  assert.ok(events.some(([l, m]) => l === 'warn' && /web-login/.test(m)));

  const dead = new PassthroughProxy({ twitch: { fetchText: async () => null }, sources: [{ url: 'a', mode: 'x' }], onEvent() {}, wrap: (u) => u });
  assert.equal((await dead.buildMaster()).code, 502);
});

// ---------------------------------------------------------------- replay driver
const msg = (offset, id = `m${offset}`) => ({ id, offset, login: 'u', text: `t${offset}` });

function harness({ pages, start = 0, ...opts } = {}) {
  let time = start;
  const out = { shown: [], resets: 0, statuses: [], calls: [] };
  const driver = createReplayDriver({
    getTime: () => time,
    fetchPage: async (q) => { out.calls.push(q); return pages(q); },
    onReset: () => { out.resets++; out.shown = []; },
    onMessages: (l) => out.shown.push(...l),
    onStatus: (s) => out.statuses.push(s),
    setTimer: () => 1, clearTimer: () => {},
    ...opts,
  });
  return { driver, out, setTime: (t) => { time = t; } };
}

test('replay releases messages as playback reaches them', async () => {
  const all = [msg(1), msg(2), msg(5), msg(9)];
  const { driver, out, setTime } = harness({ pages: () => ({ messages: all, cursor: 'c', hasNext: false }) });
  driver.tick(); await driver.idle();
  assert.deepEqual(out.shown.map((m) => m.offset), []);
  setTime(2.5); driver.tick();
  assert.deepEqual(out.shown.map((m) => m.offset), [1, 2]);
  setTime(6); driver.tick();
  assert.deepEqual(out.shown.map((m) => m.offset), [1, 2, 5]);
  setTime(10); driver.tick();
  assert.deepEqual(out.shown.map((m) => m.offset), [1, 2, 5, 9]);
  assert.equal(out.statuses.includes('ready'), true);
});

test('replay starts a little before the position after a seek, and shows a capped backlog', async () => {
  const many = Array.from({ length: 100 }, (_, i) => msg(80 + i * 0.2)); // 80..99.8
  const { driver, out, setTime } = harness({ start: 0, maxBacklog: 10, pages: ({ offset }) => ({ messages: offset === 80 ? many : [], cursor: 'c', hasNext: false }) });
  driver.tick(); await driver.idle();
  setTime(100); driver.tick(); await driver.idle(); // jump forward = seek
  setTime(100.1); driver.tick();
  assert.equal(out.resets, 2);                      // initial + seek
  assert.deepEqual(out.calls.at(-1), { offset: 80 }); // 100 - 20 s backlog
  assert.equal(out.shown.length, 10);               // capped, newest kept
  assert.equal(out.shown.at(-1).offset, many.at(-1).offset);
});

test('replay pages with the cursor until enough is buffered ahead', async () => {
  const pages = { first: { messages: [msg(1), msg(2)], cursor: 'p1', hasNext: true }, p1: { messages: [msg(20), msg(40)], cursor: 'p2', hasNext: true }, p2: { messages: [msg(60)], cursor: 'p3', hasNext: false } };
  const { driver, out } = harness({ pages: (q) => (q.cursor ? pages[q.cursor] : pages.first) });
  driver.tick(); await driver.idle();
  assert.deepEqual(out.calls, [{ offset: 0 }, { cursor: 'p1' }]); // lead of 30 s reached after the second page
});

test('replay seeking backwards resets and refetches; stale responses are discarded', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let n = 0;
  const { driver, out, setTime } = harness({ start: 50, pages: async (q) => { n++; if (n === 1) { await gate; return { messages: [msg(49, 'old')], cursor: 'c', hasNext: false }; } return { messages: [msg(10, 'new')], cursor: 'c', hasNext: false }; } });
  driver.tick();            // first fetch (offset 30) is in flight
  setTime(10); driver.tick(); // user seeks back before it returns
  release(); await driver.idle();
  setTime(11); driver.tick();
  assert.deepEqual(out.shown.map((m) => m.id), ['new']);
});

test('replay dedupes by id and retries after an error', async () => {
  let fail = true;
  let clock = 0;
  const { driver, out, setTime } = harness({
    now: () => clock, retryMs: 1000,
    pages: () => { if (fail) throw new Error('boom'); return { messages: [msg(1), msg(1)], cursor: 'c', hasNext: false }; },
  });
  driver.tick(); await driver.idle();
  assert.ok(out.statuses.includes('error'));
  fail = false;
  setTime(0.25); driver.tick(); await driver.idle(); // still inside the retry delay
  assert.equal(out.calls.length, 1);
  clock = 2000;
  setTime(0.5); driver.tick(); await driver.idle();
  setTime(2); driver.tick();
  assert.equal(out.calls.length, 2);
  assert.equal(out.shown.length, 1); // duplicate dropped
});

test('replay does not advance while paused and stops after destroy', async () => {
  const { driver, out, setTime } = harness({ pages: () => ({ messages: [msg(5)], cursor: 'c', hasNext: false }) });
  setTime(4); driver.tick(); await driver.idle();
  driver.tick(); driver.tick();
  assert.equal(out.shown.length, 0);
  driver.destroy();
  setTime(6); driver.tick();
  assert.equal(out.shown.length, 0);
});

test('replay keeps polling after the known chat ends (VOD of a live stream)', async () => {
  let clock = 0;
  let known = [msg(1)];
  const { driver, out, setTime } = harness({ now: () => clock, pollMs: 1000, pages: ({ offset }) => ({ messages: known.filter((m) => m.offset >= (offset ?? 0)), cursor: 'c', hasNext: false }) });
  driver.tick(); await driver.idle();
  setTime(2); driver.tick();
  assert.deepEqual(out.shown.map((m) => m.offset), [1]);
  known = [msg(1), msg(5), msg(8)]; // chat grew
  clock = 500; setTime(2.5); driver.tick(); await driver.idle();
  assert.equal(out.calls.length, 1); // not before pollMs
  clock = 1500; setTime(3); driver.tick(); await driver.idle();
  assert.deepEqual(out.calls.at(-1), { offset: 1 });
  setTime(4); driver.tick();
  setTime(6); driver.tick();
  assert.ok(out.shown.some((m) => m.offset === 5)); // the newly grown chat is released as playback reaches it
});

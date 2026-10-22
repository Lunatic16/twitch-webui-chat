import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BTTV_API, CHANNEL_TTL_MS, GLOBAL_TTL_MS, NEG_TTL_MS, SEVENTV_API,
  EmoteService, normalizeBttvEmote, normalize7tvEmote,
} from '../server/emotes.js';

const BTTV_GLOBAL_URL = `${BTTV_API}/cached/emotes/global`;
const SEVEN_GLOBAL_URL = `${SEVENTV_API}/emote-sets/global`;
const bttvChannelUrl = (id) => `${BTTV_API}/cached/users/twitch/${id}`;
const sevenChannelUrl = (id) => `${SEVENTV_API}/users/twitch/${id}`;

/** Fake fetch: routes map URL -> body object | status number | thrown Error. */
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = routes[url];
    if (hit instanceof Error) throw hit;
    if (typeof hit === 'number') return { status: hit, json: async () => ({}) };
    return { status: 200, json: async () => structuredClone(hit ?? {}) };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- normalizers
test('normalizeBttvEmote keeps valid rows and drops junk', () => {
  assert.deepEqual(normalizeBttvEmote({ id: 'abc123', code: 'PogChamp' }), { provider: 'bttv', id: 'abc123', code: 'PogChamp' });
  assert.equal(normalizeBttvEmote({ id: '', code: 'x' }), null);
  assert.equal(normalizeBttvEmote({ id: 'abc' }), null);
  assert.equal(normalizeBttvEmote({ id: 'abc', code: 'two words' }), null); // codes have no spaces
  assert.equal(normalizeBttvEmote(null), null);
  assert.equal(normalizeBttvEmote('junk'), null);
});

test('normalize7tvEmote maps names and the zero-width flag', () => {
  assert.deepEqual(normalize7tvEmote({ id: '01EM', name: 'KEKW', flags: 0 }), { provider: '7tv', id: '01EM', code: 'KEKW' });
  const zw = normalize7tvEmote({ id: '01ZW', name: 'Zaaap', flags: 1 });
  assert.equal(zw.zero, true); // flags bit 0 = zero-width
  // flags may also live on data.flags; name may fall back to data.name
  assert.deepEqual(normalize7tvEmote({ id: '01X', data: { name: 'Fallback', flags: 1 } }), { provider: '7tv', id: '01X', code: 'Fallback', zero: true });
  assert.equal(normalize7tvEmote({ id: '01Y' }), null); // no name anywhere
  assert.equal(normalize7tvEmote({ id: '01Z', name: 'sp ace' }), null);
  assert.equal(normalize7tvEmote(null), null);
});

// ---------------------------------------------------------------- forChannel
test('forChannel merges global + channel sets with channel sets last', async () => {
  const fetch = fakeFetch({
    [BTTV_GLOBAL_URL]: [{ id: 'b1', code: 'KappaPride' }],
    [SEVEN_GLOBAL_URL]: { emotes: [{ id: 's1', name: 'reckH', flags: 0 }] },
    [bttvChannelUrl('42')]: {
      channelEmotes: [{ id: 'b2', code: 'KappaPride' }], // same code as global: channel wins
      sharedEmotes: [{ id: 'b3', code: 'SharedEmote' }],
    },
    [sevenChannelUrl('42')]: { emote_set: { emotes: [{ id: 's2', name: 'SUSSY', flags: 0 }] } },
  });
  const svc = new EmoteService({ fetchImpl: fetch });
  const out = await svc.forChannel('ChannelX', { getUserId: async () => '42' });

  assert.equal(out.login, 'channelx');
  assert.equal(out.userId, '42');
  assert.equal(out.cached, false);
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.counts, { bttv: 3, '7tv': 2 });
  // order: bttv global, bttv channel(+shared), 7tv global, 7tv channel
  assert.deepEqual(out.emotes.map((e) => e.id), ['b1', 'b2', 'b3', 's1', 's2']);
  // the client's "later wins" rule resolves the collision in favour of the channel
  const map = new Map(out.emotes.map((e) => [e.code, e]));
  assert.equal(map.get('KappaPride').id, 'b2');

  // second call is served from cache without any new fetch
  const before = fetch.calls.length;
  const again = await svc.forChannel('channelx', { getUserId: async () => '42' });
  assert.equal(again.cached, true);
  assert.equal(again.emotes.length, out.emotes.length);
  assert.equal(fetch.calls.length, before);
});

test('forChannel skips channel sets when the user id cannot be resolved', async () => {
  const fetch = fakeFetch({
    [BTTV_GLOBAL_URL]: [{ id: 'b1', code: 'BttvGlobal' }],
    [SEVEN_GLOBAL_URL]: { emotes: [{ id: 's1', name: 'SevenGlobal', flags: 0 }] },
  });
  const svc = new EmoteService({ fetchImpl: fetch });
  const out = await svc.forChannel('chan', { getUserId: async () => null });

  assert.equal(out.userId, null);
  assert.deepEqual(out.errors, ['user_id_unresolved']);
  assert.deepEqual(out.emotes.map((e) => e.id), ['b1', 's1']);
  assert.equal(fetch.calls.some((u) => u.includes('/cached/users/twitch/')), false);
  assert.equal(fetch.calls.some((u) => u.includes('/users/twitch/')), false);
});

test('404s are legitimate empties, not failures', async () => {
  const fetch = fakeFetch({
    [BTTV_GLOBAL_URL]: [{ id: 'b1', code: 'BttvGlobal' }],
    [SEVEN_GLOBAL_URL]: { emotes: [{ id: 's1', name: 'SevenGlobal', flags: 0 }] },
    [bttvChannelUrl('7')]: 404, // channel has no BTTV account
    [sevenChannelUrl('7')]: 404, // and no 7TV set
  });
  const svc = new EmoteService({ fetchImpl: fetch });
  const out = await svc.forChannel('lonely', { getUserId: async () => '7' });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.counts, { bttv: 1, '7tv': 1 });
  assert.equal(out.cached, false);
  // successful fetch -> cached for the full channel TTL
  const before = fetch.calls.length;
  const again = await svc.forChannel('lonely', { getUserId: async () => '7' });
  assert.equal(again.cached, true);
  assert.equal(fetch.calls.length, before);
});

test('transient failures negative-cache briefly and are retried', async () => {
  let now = 1_000_000;
  const routes = {
    [BTTV_GLOBAL_URL]: new Error('dns fail'),
    [SEVEN_GLOBAL_URL]: 500,
    [bttvChannelUrl('42')]: 500,
    [sevenChannelUrl('42')]: new Error('reset'),
  };
  const fetch = fakeFetch(routes);
  const svc = new EmoteService({ fetchImpl: fetch, now: () => now });

  const out = await svc.forChannel('chan', { getUserId: async () => '42' });
  assert.deepEqual(out.emotes, []);
  assert.ok(out.errors.includes('bttv_global_fetch'));
  assert.ok(out.errors.includes('bttv_channel_fetch'));
  assert.equal(out.cached, false);

  // within NEG_TTL: served from the negative cache, no refetch
  now += NEG_TTL_MS - 1;
  const before = fetch.calls.length;
  const cached = await svc.forChannel('chan', { getUserId: async () => '42' });
  assert.equal(cached.cached, true);
  assert.equal(fetch.calls.length, before);

  // after NEG_TTL: retried, now succeeding
  routes[BTTV_GLOBAL_URL] = [{ id: 'b1', code: 'BttvGlobal' }];
  routes[SEVEN_GLOBAL_URL] = { emotes: [] };
  routes[bttvChannelUrl('42')] = 404;
  routes[sevenChannelUrl('42')] = 404;
  now += 1;
  const ok = await svc.forChannel('chan', { getUserId: async () => '42' });
  assert.equal(ok.cached, false);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.counts, { bttv: 1, '7tv': 0 });
});

test('global sets are cached across channels and refreshed independently', async () => {
  let now = 1_000_000;
  const fetch = fakeFetch({
    [BTTV_GLOBAL_URL]: [{ id: 'b1', code: 'BttvGlobal' }],
    [SEVEN_GLOBAL_URL]: { emotes: [{ id: 's1', name: 'SevenGlobal', flags: 0 }] },
  });
  const svc = new EmoteService({ fetchImpl: fetch, now: () => now });

  await svc.forChannel('a', { getUserId: async () => null });
  await svc.forChannel('b', { getUserId: async () => null });
  // second channel reused the cached globals: no extra global fetches
  assert.equal(fetch.calls.filter((u) => u === BTTV_GLOBAL_URL).length, 1);
  assert.equal(fetch.calls.filter((u) => u === SEVEN_GLOBAL_URL).length, 1);

  // after the global TTL the next channel refresh refetches them
  now += GLOBAL_TTL_MS + 1;
  await svc.forChannel('c', { getUserId: async () => null });
  assert.equal(fetch.calls.filter((u) => u === BTTV_GLOBAL_URL).length, 2);

  // channel TTL is independent (and shorter than the global TTL)
  assert.ok(CHANNEL_TTL_MS < GLOBAL_TTL_MS);
});

test('in-flight global fetches are coalesced, malformed JSON is a failure', async () => {
  let resolveGlobal;
  const fetch = fakeFetch({
    [SEVEN_GLOBAL_URL]: { emotes: [] },
    [bttvChannelUrl('1')]: 404,
    [sevenChannelUrl('1')]: 404,
  });
  const original = fetch;
  const svc = new EmoteService({
    fetchImpl: async (url) => {
      if (url === BTTV_GLOBAL_URL) {
        // hang until both channels asked for it, then answer garbage JSON
        await new Promise((r) => { resolveGlobal = r; });
        return { status: 200, json: async () => { throw new Error('not json'); } };
      }
      return original(url);
    },
    now: () => 1_000_000,
  });

  const p1 = svc.forChannel('one', { getUserId: async () => '1' });
  const p2 = svc.forChannel('two', { getUserId: async () => '1' });
  await new Promise((r) => setTimeout(r, 10)); // let both call _globals('bttv')
  resolveGlobal();
  const [r1, r2] = await Promise.all([p1, p2]);
  // both channels saw the same coalesced (failed) fetch: exactly one upstream call
  assert.equal(r1.errors.includes('bttv_channel_fetch') || r1.counts.bttv === 0, true);
  assert.deepEqual(r1.counts.bttv, r2.counts.bttv);
  assert.ok(r1.errors.length > 0); // malformed JSON -> transient failure, not silent empty
});

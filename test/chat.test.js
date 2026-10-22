import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  ChatManager, RateLimiter, parseEmoteRanges, parseIrcLine, parseTags, prepareOutgoingText,
  privmsgToChat, segmentEmotes, textMentions, unescapeTagValue,
} from '../server/chat.js';

// ---------------------------------------------------------------- IRC parsing
test('unescapeTagValue handles the documented escapes', () => {
  assert.equal(unescapeTagValue('a\\sb'), 'a b');
  assert.equal(unescapeTagValue('a\\:b'), 'a;b');
  assert.equal(unescapeTagValue('a\\\\b'), 'a\\b');
  assert.equal(unescapeTagValue('x\\r\\ny'), 'x\r\ny');
  assert.equal(unescapeTagValue('trailing\\'), 'trailing\\');
  assert.equal(unescapeTagValue('plain'), 'plain');
});

test('parseTags splits pairs and unescapes values', () => {
  const t = parseTags('color=#1E90FF;display-name=Co\\sOl;badges=');
  assert.equal(t.color, '#1E90FF');
  assert.equal(t['display-name'], 'Co Ol');
  assert.equal(t.badges, '');
});

test('parseIrcLine parses tags, prefix, command, params and trail', () => {
  const line = '@badge-info=;badges=broadcaster/1;color=#0000FF;display-name=Foo;emotes=25:0-4;user-id=42 '
    + ':foo!foo@foo.tmi.twitch.tv PRIVMSG #bar :Kappa hello world';
  const p = parseIrcLine(line);
  assert.equal(p.cmd, 'PRIVMSG');
  assert.equal(p.nick, 'foo');
  assert.deepEqual(p.params, ['#bar']);
  assert.equal(p.trail, 'Kappa hello world');
  assert.equal(p.tags['display-name'], 'Foo');
  assert.equal(p.tags.emotes, '25:0-4');
});

test('parseIrcLine handles PING, lines without tags and junk', () => {
  assert.equal(parseIrcLine('PING :tmi.twitch.tv').cmd, 'PING');
  assert.equal(parseIrcLine(':tmi.twitch.tv 001 justinfan :Welcome, GLHF!').trail, 'Welcome, GLHF!');
  assert.equal(parseIrcLine(''), null);
  assert.equal(parseIrcLine(null), null);
  assert.equal(parseIrcLine('@onlytags'), null);
});

// ---------------------------------------------------------------- emotes
test('parseEmoteRanges sorts and skips malformed entries', () => {
  const r = parseEmoteRanges('25:0-4,6-10/1902:12-16/bad/x:9-3');
  assert.deepEqual(r, [
    { id: '25', start: 0, end: 4 },
    { id: '25', start: 6, end: 10 },
    { id: '1902', start: 12, end: 16 },
  ]);
  assert.deepEqual(parseEmoteRanges(''), []);
  assert.deepEqual(parseEmoteRanges(null), []);
});

test('segmentEmotes splits text around code-point ranges', () => {
  // 'Kappa nice Kappa' -> emote at code points 0-4 and 11-15
  const segs = segmentEmotes('Kappa nice Kappa', '25:0-4,11-15');
  assert.deepEqual(segs.map((s) => s.type), ['emote', 'text', 'emote']);
  assert.equal(segs[0].id, '25');
  assert.equal(segs[0].text, 'Kappa');
  assert.equal(segs[1].text, ' nice ');
  assert.equal(segs[2].text, 'Kappa');
  assert.deepEqual(segmentEmotes('no emotes', null), [{ type: 'text', text: 'no emotes' }]);
});

test('segmentEmotes counts emoji as one code point (not UTF-16 units)', () => {
  // '🎉' is 2 UTF-16 units but 1 code point. Emote at code points 2..6.
  const text = '🎉 Kappa end';
  const segs = segmentEmotes(text, '25:2-6');
  assert.equal(segs[0].text, '🎉 ');
  assert.equal(segs[1].type, 'emote');
  assert.equal(segs[1].text, 'Kappa');
  assert.equal(segs[2].text, ' end');
});

// ---------------------------------------------------------------- PRIVMSG DTO
test('privmsgToChat builds the browser DTO with badges and colors', () => {
  const parsed = parseIrcLine(
    '@badge-info=subscriber/12;badges=broadcaster/1,subscriber/12;color=#FF0000;display-name=Foo\\sBar;emotes=;id=abc;mod=0;'
    + 'subscriber=1;tmi-sent-ts=1700000000000;user-id=1;login=foo :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hello there',
  );
  const m = privmsgToChat(parsed, { selfLogin: 'someoneelse' });
  assert.equal(m.type, 'message');
  assert.equal(m.id, 'abc');
  assert.equal(m.login, 'foo');
  assert.equal(m.display, 'Foo Bar');
  assert.equal(m.color, '#FF0000');
  assert.deepEqual(m.badges, [{ id: 'broadcaster', version: '1' }, { id: 'subscriber', version: '12' }]);
  assert.equal(m.subMonths, 12);
  assert.equal(m.mod, false);
  assert.equal(m.text, 'hello there');
  assert.equal(m.ts, 1700000000000);
  assert.equal(m.self, false);
});

test('privmsgToChat detects /me actions and self messages', () => {
  const line = '@color=;display-name=A;login=a;emotes= :a!a@a.tmi.twitch.tv PRIVMSG #chan :\u0001ACTION waves\u0001';
  const m = privmsgToChat(parseIrcLine(line), { selfLogin: 'A' });
  assert.equal(m.action, true);
  assert.equal(m.text, 'waves');
  assert.equal(m.self, true); // login comparison is case-insensitive
  assert.equal(m.color, null); // invalid/empty color -> null (client hashes)
});

// ---------------------------------------------------------------- mentions
test('textMentions matches @login with word boundaries, case-insensitively', () => {
  assert.equal(textMentions('hey @Me check this', 'me'), true);
  assert.equal(textMentions('@me!', 'me'), true);           // trailing punctuation
  assert.equal(textMentions('(@me)', 'me'), true);          // wrapped in punctuation
  assert.equal(textMentions('@me at the start', 'me'), true);
  assert.equal(textMentions('no mention of @mebuddy here', 'me'), false); // longer name
  assert.equal(textMentions('just me, no at sign', 'me'), false);
  assert.equal(textMentions('@', 'me'), false);
  assert.equal(textMentions('', 'me'), false);
  assert.equal(textMentions('hi @someone', ''), false);     // no own login
  assert.equal(textMentions('@user_name2 ok', 'User_Name2'), true); // underscore + digits + case
});

test('privmsgToChat flags messages that mention the logged-in user', () => {
  const mk = (text) => parseIrcLine(
    `@display-name=A;login=a;emotes= :a!a@a.tmi.twitch.tv PRIVMSG #chan :${text}`,
  );
  assert.equal(privmsgToChat(mk('hello @me!'), { selfLogin: 'me' }).mention, true);
  assert.equal(privmsgToChat(mk('nothing here'), { selfLogin: 'me' }).mention, false);
  assert.equal(privmsgToChat(mk('@metoo hi'), { selfLogin: 'me' }).mention, false);
  assert.equal(privmsgToChat(mk('hello'), {}).mention, false); // no selfLogin -> never a mention
});

// ---------------------------------------------------------------- outgoing text
test('prepareOutgoingText trims, clamps, handles /me and command escaping', () => {
  assert.equal(prepareOutgoingText('  hi there  ').text, 'hi there');
  assert.deepEqual(prepareOutgoingText('/me waves'), { action: true, text: 'waves' });
  assert.equal(prepareOutgoingText('/help me').text, ' /help me'); // escaped with leading space
  assert.equal(prepareOutgoingText('.mods').text, ' .mods');
  const long = 'x'.repeat(600);
  assert.equal(prepareOutgoingText(long).text.length, 500);
  assert.equal(prepareOutgoingText('line1\r\nline2').text, 'line1 line2');
  assert.equal(prepareOutgoingText('   '), null);
});

// ---------------------------------------------------------------- rate limiter
test('RateLimiter allows max per window then blocks with retry hint', () => {
  let now = 0;
  const rl = new RateLimiter({ windowMs: 30_000, max: 3, now: () => now });
  assert.equal(rl.tryAcquire().ok, true);
  assert.equal(rl.tryAcquire().ok, true);
  assert.equal(rl.tryAcquire().ok, true);
  const blocked = rl.tryAcquire();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterMs, 30_000);
  now = 29_999;
  assert.equal(rl.tryAcquire().ok, false);
  now = 30_000;
  assert.equal(rl.tryAcquire().ok, true); // oldest hit expired
});

// ---------------------------------------------------------------- manager
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
  }

  write(s) { this.writes.push(s); return true; }
  destroy() { this.destroyed = true; }
  end() { this.destroyed = true; }
  feed(...lines) { this.emit('data', Buffer.from(lines.map((l) => `${l}\r\n`).join(''), 'utf8')); }
  secure() { this.emit('secureConnect'); }
  drop() { this.emit('close'); }
}

function makeManager({ token = 'oauth-token', user = 'me' } = {}) {
  const sockets = [];
  const twitch = { token, authUser: user, authUserId: '1', refreshAuth: async () => ({ loggedIn: !!token }) };
  const mgr = new ChatManager({
    twitch,
    socketFactory: () => { const s = new FakeSocket(); sockets.push(s); return s; },
  });
  return { mgr, sockets, twitch };
}

test('subscribe connects, authenticates, joins and streams messages', async () => {
  const { mgr, sockets } = makeManager();
  const events = [];
  const unsub = await mgr.subscribe('ChannelX', { send: (ev, data) => events.push([ev, data]) });
  assert.equal(sockets.length, 1);
  sockets[0].secure();
  sockets[0].feed(':tmi.twitch.tv 001 me :Welcome, GLHF!');
  // PASS/NICK/CAP were written on secureConnect
  assert.ok(sockets[0].writes.some((w) => w === 'PASS oauth:oauth-token\r\n'));
  assert.ok(sockets[0].writes.some((w) => w === 'NICK me\r\n'));
  assert.ok(sockets[0].writes.some((w) => w.includes('CAP REQ :twitch.tv/tags twitch.tv/commands')));
  assert.ok(sockets[0].writes.some((w) => w === 'JOIN #channelx\r\n'));
  // initial SSE event carries history (empty) + status
  assert.equal(events[0][0], 'init');
  assert.equal(events[0][1].login, 'channelx');

  sockets[0].feed(
    '@display-name=Fo;login=foo;color=#123456;emotes=;id=m1;tmi-sent-ts=1700000000000'
    + ' :foo!foo@foo.tmi.twitch.tv PRIVMSG #channelx :hello world',
  );
  const msg = events.find(([ev]) => ev === 'message')?.[1];
  assert.ok(msg);
  assert.equal(msg.display, 'Fo');
  assert.equal(msg.text, 'hello world');

  // PING must be answered with PONG
  sockets[0].feed('PING :tmi.twitch.tv');
  assert.ok(sockets[0].writes.includes('PONG :tmi.twitch.tv\r\n'));

  // history is hydrated for the next subscriber
  const events2 = [];
  await mgr.subscribe('channelx', { send: (ev, data) => events2.push([ev, data]) });
  assert.equal(events2[0][0], 'init');
  assert.equal(events2[0][1].history.length, 1);
  assert.equal(events2[0][1].history[0].text, 'hello world');

  unsub();
  unsub();
  mgr.destroy();
});

test('send requires connection, rate-limits and writes PRIVMSG', async () => {
  const { mgr, sockets } = makeManager();
  await mgr.subscribe('chan', { send: () => {} });
  sockets[0].secure();
  sockets[0].feed(':tmi.twitch.tv 001 me :Welcome, GLHF!');

  await mgr.send('chan', 'hello');
  assert.ok(sockets[0].writes.includes('PRIVMSG #chan :hello\r\n'));

  await mgr.send('chan', '/me waves');
  assert.ok(sockets[0].writes.includes(`PRIVMSG #chan :\u0001ACTION waves\u0001\r\n`));

  await mgr.send('chan', '/help'); // escaped so Twitch does not run it
  assert.ok(sockets[0].writes.includes('PRIVMSG #chan : /help\r\n'));

  await assert.rejects(() => mgr.send('chan', ''), /empty/i);

  // not connected -> 503
  const { mgr: mgr2, sockets: s2 } = makeManager();
  await assert.rejects(() => mgr2.send('chan', 'hi'), (e) => e.code === 'chat_connecting');
  assert.equal(s2.length, 0); // no connection is opened just for sending
  mgr2.destroy();
  mgr.destroy();
});

test('send honours the rate limiter', async () => {
  let now = 0;
  const { mgr, sockets } = makeManager();
  mgr.limiter = new RateLimiter({ windowMs: 30_000, max: 1, now: () => now });
  await mgr.subscribe('chan', { send: () => {} });
  sockets[0].secure();
  sockets[0].feed(':tmi.twitch.tv 001 me :Welcome, GLHF!');
  await mgr.send('chan', 'one');
  await assert.rejects(() => mgr.send('chan', 'two'), (e) => e.code === 'rate_limited');
  mgr.destroy();
});

test('auth failure surfaces an error state instead of retrying forever', async () => {
  const { mgr, sockets } = makeManager();
  const events = [];
  await mgr.subscribe('chan', { send: (ev, data) => events.push([ev, data]) });
  sockets[0].secure();
  sockets[0].feed(':tmi.twitch.tv NOTICE * :Login authentication failed');
  assert.equal(mgr.state, 'error');
  assert.ok(mgr.errorMessage.includes('authentication'));
  // the room was told about it
  assert.ok(events.some(([ev, d]) => ev === 'status' && d.state === 'error'));
  // and no reconnect timer is pending (no endless loop against a dead token)
  assert.equal(mgr.reconnectTimer, null);
  mgr.destroy();
});

test('unsubscribe PARTs the channel after the grace period', async () => {
  const { mgr, sockets } = makeManager();
  mgr.partGraceMs = 15;
  const unsub = await mgr.subscribe('chan', { send: () => {} });
  sockets[0].secure();
  sockets[0].feed(':tmi.twitch.tv 001 me :Welcome, GLHF!');
  assert.ok(sockets[0].writes.includes('JOIN #chan\r\n'));
  unsub();
  assert.equal(mgr.rooms.has('chan'), true); // still within grace
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(mgr.rooms.has('chan'), false); // swept
  assert.ok(sockets[0].writes.includes('PART #chan\r\n'));
  mgr.destroy();
});

test('reconnects after a dropped socket and rejoins active rooms', async () => {
  const { mgr, sockets } = makeManager();
  const events = [];
  await mgr.subscribe('chan', { send: (ev, data) => events.push([ev, data]) });
  sockets[0].secure();
  sockets[0].feed(':tmi.twitch.tv 001 me :Welcome, GLHF!');
  sockets[0].drop(); // simulate a disconnect
  assert.equal(mgr.state, 'reconnecting');
  assert.ok(mgr.reconnectTimer); // retry scheduled
  clearTimeout(mgr.reconnectTimer);
  mgr.reconnectTimer = null;
  mgr.destroy();
});

test('subscribe without a token is rejected as auth_required', async () => {
  const { mgr, sockets } = makeManager({ token: null });
  await assert.rejects(() => mgr.subscribe('chan', { send: () => {} }), (e) => e.code === 'auth_required');
  assert.equal(sockets.length, 0);
  mgr.destroy();
});

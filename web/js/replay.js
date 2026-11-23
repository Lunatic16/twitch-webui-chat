// VOD chat replay driver: keeps a look-ahead buffer of the VOD's chat messages
// and releases each one when the video's playback position reaches its offset.
// DOM-free on purpose (unit-tested under node:test); chat.js wires it to the panel.
//
//   getTime()                 -> current playback position in seconds
//   fetchPage({offset|cursor}) -> { messages:[{offset,...}], cursor, hasNext }
//   onReset()                 -> clear the panel (seek / restart)
//   onMessages(list)          -> append messages that are now due
//   onStatus(state, message)  -> 'loading' | 'ready' | 'error'
//
// A jump in playback position (a seek, or the video restarting) is detected by
// comparing successive ticks, so no <video> events are needed.

export function createReplayDriver({
  fetchPage, getTime, onReset = () => {}, onMessages = () => {}, onStatus = () => {},
  intervalMs = 250,
  leadSeconds = 30,      // keep at least this much chat buffered ahead of playback
  backlogSeconds = 20,   // after a seek, start this far back so the panel isn't empty
  maxBacklog = 40,       // ...but show at most this many of those older lines
  maxJump = 5,           // forward jump (s) between ticks that counts as a seek
  maxPagesPerFill = 6,
  retryMs = 5000,
  pollMs = 5000,         // when the end of the known chat is reached, look again this often (VODs of live streams keep growing)
  now = Date.now,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let epoch = 0;
  let buffer = [];
  let seen = new Set();
  let cursor = null;
  let hasNext = true;
  let fromOffset = 0;
  let lastT = null;
  let filling = null;
  let retryAt = 0;
  let pollAt = 0;
  let lastSeenOffset = 0;
  let justReset = false;
  let destroyed = false;
  let timer = null;

  const keyOf = (m) => m.id || `${m.offset}|${m.login}|${m.text}`;

  function reset(t) {
    epoch++;
    buffer = [];
    seen = new Set();
    cursor = null;
    hasNext = true;
    filling = null;
    retryAt = 0;
    pollAt = 0;
    lastSeenOffset = 0;
    lastT = t;
    fromOffset = Math.max(0, t - backlogSeconds);
    justReset = true;
    onReset();
    onStatus('loading');
  }

  function fill() {
    if (filling || destroyed || now() < retryAt) return filling;
    if (now() < pollAt) return filling;
    const mine = epoch;
    const run = (async () => {
      try {
        for (let i = 0; i < maxPagesPerFill; i++) {
          const ahead = buffer.length ? buffer[buffer.length - 1].offset - lastT : -1;
          if (ahead >= leadSeconds) break;
          // Follow the cursor while there is one; otherwise re-ask from just past the newest offset seen.
          const page = await fetchPage(cursor ? { cursor } : { offset: Math.max(fromOffset, lastSeenOffset) });
          if (mine !== epoch || destroyed) return;
          let added = 0;
          for (const m of page.messages ?? []) {
            const k = keyOf(m);
            if (!seen.has(k)) { seen.add(k); buffer.push(m); added++; }
            lastSeenOffset = Math.max(lastSeenOffset, m.offset);
          }
          buffer.sort((a, b) => a.offset - b.offset);
          onStatus('ready');
          if (page.hasNext && page.cursor) { cursor = page.cursor; continue; }
          // No cursor to follow. If this page still brought new chat, immediately re-ask from the
          // newest offset seen (so a missing/odd hasNextPage can't throttle us to one page per
          // poll); only when it brought nothing new are we at the end of the known chat: poll.
          cursor = null;
          if (!added) { pollAt = now() + pollMs; break; }
        }
      } catch (e) {
        if (mine === epoch && !destroyed) { retryAt = now() + retryMs; onStatus('error', e?.message || 'Chat replay failed'); }
      }
    })();
    // Clear the in-flight marker only after it has been assigned. When the buffer is
    // already full the async body finishes synchronously, so clearing it from inside
    // (a `finally` there) ran *before* the assignment and left `filling` stuck on a
    // settled promise forever, which froze the replay once the first buffer drained.
    filling = run;
    run.finally(() => { if (filling === run) filling = null; });
    return run;
  }

  function tick() {
    if (destroyed) return;
    const t = Number(getTime());
    if (!Number.isFinite(t)) return;
    if (lastT === null || t < lastT - 1 || t > lastT + maxJump) reset(t);
    else lastT = t;

    const due = [];
    while (buffer.length && buffer[0].offset <= t) due.push(buffer.shift());
    if (due.length) {
      const backlog = justReset;
      justReset = false;
      onMessages(backlog && due.length > maxBacklog ? due.slice(-maxBacklog) : due, { backlog });
    }
    fill();
  }

  return {
    start() { if (!timer && !destroyed) { timer = setTimer(tick, intervalMs); tick(); } },
    tick,
    /** Resolves when any in-flight page fetch has settled (for tests). */
    idle: async () => { while (filling) await filling; },
    destroy() { destroyed = true; epoch++; if (timer) clearTimer(timer); timer = null; buffer = []; },
  };
}

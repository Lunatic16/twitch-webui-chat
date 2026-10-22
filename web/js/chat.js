// Native Twitch chat panel. Streams messages from the server's IRC bridge via
// SSE (/api/chat/:login/events) and sends through POST /api/chat/:login/message.
// All text is rendered as DOM text nodes via h() (XSS-safe by construction).
import { api } from './api.js';
import { h, icon } from './ui.js';

const EMOTE_CDN = (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(id)}/default/dark/2.0`;
// Third-party providers (see server/emotes.js). Later map entries win, so
// channel emotes override globals and same-code collisions resolve sensibly.
const PROVIDER_CDN = {
  bttv: (id) => `https://cdn.betterttv.net/emote/${encodeURIComponent(id)}/2x`,
  '7tv': (id) => `https://cdn.7tv.app/emote/${encodeURIComponent(id)}/2x.webp`,
};
const MAX_LINES = 400;

// Twitch's default name palette (used when a viewer never picked a color).
const NAME_COLORS = [
  '#FF0000', '#0000FF', '#00FF00', '#B22222', '#FF7F50', '#9ACD32', '#FF4500',
  '#2E8B57', '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2',
  '#00FF7F', '#FF0000',
];

function hashColor(login) {
  let x = 0;
  for (const ch of String(login || '?')) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return NAME_COLORS[x % NAME_COLORS.length];
}

// Inline badge glyphs keyed by Twitch badge id (subset everyone sees often).
const BADGE_GLYPHS = {
  broadcaster: { label: 'Broadcaster', color: '#e0182d', svg: '<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/>' },
  moderator: { label: 'Moderator', color: '#00ad03', svg: '<path d="M12 2l8 3v6.2c0 4.9-3.4 8.4-8 10.8-4.6-2.4-8-5.9-8-10.8V5z"/>' },
  vip: { label: 'VIP', color: '#e005b9', svg: '<path d="M6 3h12l4 6.2L12 21.5 2 9.2z"/>' },
  subscriber: { label: 'Subscriber', color: '#9146ff', svg: '<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/>' },
  founder: { label: 'Founder', color: '#b08b2e', svg: '<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/>' },
  premium: { label: 'Prime', color: '#0d6ef5', svg: '<path d="M3 8l5 4.2L12 5l4 7.2L21 8l-2.2 12H5.2z"/>' },
  partner: { label: 'Partner', color: '#d92c6b', svg: '<path d="M4.5 12.6l5 5L19.5 7.6 16.6 4.7 9.5 11.8l-2.1-2.1z"/>' },
  staff: { label: 'Twitch Staff', color: '#0084cb', svg: '<path d="M12 2l8 3v6.2c0 4.9-3.4 8.4-8 10.8-4.6-2.4-8-5.9-8-10.8V5z"/>' },
  admin: { label: 'Twitch Admin', color: '#0084cb', svg: '<path d="M12 2l8 3v6.2c0 4.9-3.4 8.4-8 10.8-4.6-2.4-8-5.9-8-10.8V5z"/>' },
  global_mod: { label: 'Global Moderator', color: '#0084cb', svg: '<path d="M12 2l8 3v6.2c0 4.9-3.4 8.4-8 10.8-4.6-2.4-8-5.9-8-10.8V5z"/>' },
  artist: { label: 'Artist Badge', color: '#0f7bbc', svg: '<path d="M12 3a9 9 0 0 0 0 18c1.4 0 2-1 1.6-2.1-.5-1.4.3-2.9 2.4-2.9H18a4 4 0 0 0 3-4c0-5-4-9-9-9zm-4.5 9a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-4a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm5 1a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>' },
};

function badgeEl(b, subMonths) {
  const def = BADGE_GLYPHS[b.id];
  if (!def) return null;
  const title = b.id === 'subscriber' && subMonths ? `${def.label} (${subMonths} mo)` : def.label;
  const span = h('span', { class: `cbadge cbadge-${b.id}`, title });
  span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${def.svg}</svg>`;
  return span;
}

function emoteEl(seg) {
  const img = h('img', {
    class: 'chat-emote', src: EMOTE_CDN(seg.id), alt: seg.text, title: seg.text, loading: 'lazy',
    onerror: (e) => { e.target.replaceWith(document.createTextNode(seg.text)); },
  });
  return img;
}

const STATUS_LABELS = {
  connecting: ['Connecting…', 'warn'],
  connected: ['', 'ok'],
  reconnecting: ['Reconnecting…', 'warn'],
  error: ['Chat login failed', 'err'],
  offline: ['Offline', 'warn'],
};

/**
 * Build a self-contained chat panel for one channel.
 * @param {object} o
 * @param {string} o.login           channel login
 * @param {string} [o.displayName]   pretty channel name for the header
 * @param {Function} o.auth          () => ctx.auth (fresh read)
 * @param {Function} o.requestLogin  open the login modal; resolves when it closes
 * @param {string} [o.embedSrc]      official Twitch embed URL (read-only fallback)
 */
export function createChatPanel({ login, displayName, auth, requestLogin, embedSrc }) {
  const channel = String(login || '').toLowerCase();

  // ---- skeleton ----
  const dot = h('span', { class: 'chat-dot pulse' });
  const statusText = h('span', { class: 'chat-status muted' }, 'Connecting…');
  const head = h('div', { class: 'chat-head' }, dot, h('strong', {}, displayName || `#${channel}`), statusText, h('span', { class: 'spacer' }));
  const msgs = h('div', { class: 'chat-msgs', role: 'log', 'aria-live': 'polite', 'aria-label': `Chat for ${displayName || channel}` });
  const newPill = h('button', { class: 'chat-newmsgs', hidden: true, onclick: () => { scrollToBottom(true); } });
  const input = h('input', {
    type: 'text', class: 'chat-input-field', maxlength: '500', placeholder: 'Send a message', 'aria-label': 'Send a message',
    autocomplete: 'off', spellcheck: 'true', disabled: true,
  });
  const sendBtn = h('button', { class: 'icon-btn chat-send', 'aria-label': 'Send message', title: 'Send (Enter)', disabled: true }, icon('send'));
  const limitEl = h('span', { class: 'chat-limit muted', hidden: true });
  const inputRow = h('div', { class: 'chat-input' }, input, limitEl, sendBtn);
  const root = h('div', { class: 'chat-panel' }, head, msgs, newPill, inputRow);

  // ---- state ----
  let es = null;
  let status = 'connecting';
  let pendingNew = 0;
  let destroyed = false;
  let loginPoll = null;
  let embedMode = false;
  let closedRetries = 0;
  let retryTimer = null;
  const nameById = new Map(); // login -> display name (for moderation lines)

  // ---- third-party emotes + mentions -------------------------------------
  let emoteMap = new Map();   // code -> { provider, id, code, zero? }
  let rendered = [];          // [{ m, el }] so lines can re-render once emotes load

  async function loadEmotes() {
    try {
      const data = await api(`/api/chat/${encodeURIComponent(channel)}/emotes`);
      const map = new Map();
      for (const e of data?.emotes ?? []) {
        if (!e || typeof e.code !== 'string' || typeof e.id !== 'string') continue;
        if (!PROVIDER_CDN[e.provider]) continue;
        map.set(e.code, e); // later entries win: channel sets land after globals
      }
      emoteMap = map;
      // Re-render lines that were already painted without provider emotes.
      if (map.size) for (const { m, el } of rendered) el.replaceChildren(...lineContent(m));
    } catch { /* emotes are cosmetic — chat works without them */ }
  }

  function mentionsMe(text) {
    const me = auth()?.user;
    if (!me || !text) return false;
    const esc = String(me).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`@${esc}(?![A-Za-z0-9_])`, 'i').test(String(text));
  }

  /** "@name" chip that fills the input like clicking a sender name. */
  function mentionChip(name) {
    const mine = auth()?.user && String(auth().user).toLowerCase() === name.toLowerCase();
    return h('button', {
      class: `mtoken${mine ? ' mine' : ''}`, type: 'button', title: `Reply to @${name}`,
      onclick: () => { if (!input.disabled) { input.value = `@${name} ${input.value}`; input.focus(); } },
    }, `@${name}`);
  }

  /**
   * Return the .emote-wrap hosting `baseImg`, creating (and splicing into
   * `out`) one if needed. Works on detached trees because lines are assembled
   * before being appended to the DOM — replaceWith() alone would no-op there.
   */
  function emoteWrapFor(baseImg, out) {
    const p = baseImg.parentElement;
    if (p && p.classList?.contains('emote-wrap')) return p;
    const wrap = h('span', { class: 'emote-wrap' });
    wrap.append(baseImg);
    const i = out.indexOf(baseImg);
    if (i >= 0) out[i] = wrap;
    return wrap;
  }

  /**
   * Render one text segment: whole words matching a BTTV/7TV code become
   * emotes (7TV zero-width ones stack onto the emote before them), "@login"
   * tokens become reply chips, everything else stays plain text. `st` carries
   * the last emote image across token/segment edges; any non-emote token ends
   * the emote run so overlays can only attach to a directly preceding emote.
   */
  function pushRichText(text, out, st) {
    for (const part of String(text).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { out.push(document.createTextNode(part)); continue; }
      const entry = emoteMap.get(part);
      if (entry) {
        if (entry.zero && st.lastEmote && st.emoteRun) {
          // Zero-width: stack onto the previous emote (adjacent or space-separated).
          emoteWrapFor(st.lastEmote, out).append(h('img', {
            class: 'chat-emote zero', src: PROVIDER_CDN[entry.provider](entry.id),
            alt: part, title: part, loading: 'lazy',
            onerror: (e) => e.target.remove(),
          }));
          continue;
        }
        const img = h('img', {
          class: 'chat-emote', src: PROVIDER_CDN[entry.provider](entry.id),
          alt: part, title: part, loading: 'lazy',
          onerror: (e) => { e.target.replaceWith(document.createTextNode(part)); },
        });
        out.push(img);
        st.lastEmote = img;
        st.emoteRun = true;
        continue;
      }
      // "@name" anywhere in the token (trailing/leading punctuation kept as text)
      const mm = /@([A-Za-z0-9_]{2,25})(?![A-Za-z0-9_])/.exec(part);
      if (mm) {
        if (mm.index > 0) out.push(document.createTextNode(part.slice(0, mm.index)));
        out.push(mentionChip(mm[1]));
        const after = part.slice(mm.index + mm[0].length);
        if (after) out.push(document.createTextNode(after));
      } else {
        out.push(document.createTextNode(part));
      }
      st.lastEmote = null;
      st.emoteRun = false;
    }
  }

  /** Message body -> DOM nodes: Twitch emotes, provider emotes, mention chips. */
  function segmentsToNodes(segs) {
    const out = [];
    const st = { lastEmote: null, emoteRun: false };
    for (const s of segs || []) {
      if (s.type === 'emote') {
        const img = emoteEl(s);
        out.push(img);
        st.lastEmote = img;
        st.emoteRun = true;
      } else if (s.text) {
        pushRichText(s.text, out, st);
      }
    }
    return out;
  }

  // ---- helpers ----
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 48;
  let pinned = true;
  function onScroll() {
    pinned = nearBottom();
    if (pinned) { pendingNew = 0; newPill.hidden = true; }
  }
  function scrollToBottom(force) {
    pinned = true;
    pendingNew = 0;
    newPill.hidden = true;
    msgs.scrollTop = msgs.scrollHeight;
    if (force) msgs.scrollTop = msgs.scrollHeight;
  }
  msgs.addEventListener('scroll', onScroll);

  function append(el) {
    msgs.append(el);
    while (msgs.childElementCount > MAX_LINES) msgs.firstChild.remove();
    if (pinned) msgs.scrollTop = msgs.scrollHeight;
    else {
      pendingNew++;
      newPill.textContent = `${pendingNew} new message${pendingNew === 1 ? '' : 's'} — jump to latest`;
      newPill.hidden = false;
    }
  }

  function sysLine(text, level = '') {
    append(h('div', { class: `chat-sys ${level}` }, text));
  }

  function setStatus(next) {
    status = next;
    const [label, cls] = STATUS_LABELS[next] ?? [next, 'warn'];
    dot.className = `chat-dot ${cls} ${next === 'connecting' || next === 'reconnecting' ? 'pulse' : ''}`;
    statusText.textContent = label || '';
    const ready = next === 'connected' && (auth()?.loggedIn ?? false);
    input.disabled = !ready;
    sendBtn.disabled = !ready;
    input.placeholder = next === 'connected'
      ? ((auth()?.canChat === false) ? 'Chat needs re-login (chat:read/edit)' : `Chat as ${auth()?.user || '…'}`)
      : (next === 'connecting' || next === 'reconnecting' ? 'Connecting…' : 'Chat unavailable');
  }

  function lineContent(m) {
    const color = m.color || hashColor(m.login);
    const badges = (m.badges ?? []).map((b) => badgeEl(b, m.subMonths)).filter(Boolean);
    const name = h('button', {
      class: 'cname', style: { color }, type: 'button',
      onclick: () => { if (!input.disabled) { input.value = `@${m.display || m.login} ${input.value}`; input.focus(); } },
    }, m.display || m.login);
    return [...badges, name, ...(m.action ? [' '] : [': ']), ...segmentsToNodes(m.emotes)];
  }

  function messageLine(m, { self = false } = {}) {
    const line = h('div', {
      class: `chat-line${self ? ' self' : ''}${m.action ? ' action' : ''}${m.mention && !self ? ' mention' : ''}`,
      dataset: { msgId: m.id || '', userId: m.login || '' },
      title: new Date(m.ts || Date.now()).toLocaleTimeString(),
    }, ...lineContent(m));
    if (m.action) line.style.color = m.color || hashColor(m.login); // classic /me behaviour
    if (m.login) nameById.set(m.login, m.display || m.login);
    return line;
  }

  function addMessage(m, opts) {
    const el = messageLine(m, opts);
    rendered.push({ m, el });
    if (rendered.length > MAX_LINES) rendered.shift();
    append(el);
  }

  function selfMessage(text) {
    const me = auth()?.user || '';
    const action = /^\/me\s+/i.test(text);
    const body = action ? text.replace(/^\/me\s+/i, '') : text;
    addMessage({
      id: null, login: me, display: me || 'you', color: null, badges: [], text: body, action,
      emotes: [{ type: 'text', text: body }], ts: Date.now(), mention: mentionsMe(body),
    }, { self: true });
  }

  // ---- moderation / events ----
  function onClear(d) {
    if (d.userId) {
      const who = nameById.get(d.userId) || 'A user';
      msgs.querySelectorAll(`[data-user-id="${CSS.escape(d.userId)}"]`).forEach((el) => el.remove());
      sysLine(`${who}'s messages were ${d.banDuration ? `timed out (${d.banDuration}s)` : 'removed'}.`, '');
    } else {
      msgs.replaceChildren();
      rendered = [];
      sysLine('Chat was cleared by a moderator.', '');
    }
  }

  function onDelete(d) {
    if (!d.msgId) return;
    msgs.querySelectorAll(`[data-msg-id="${CSS.escape(d.msgId)}"]`).forEach((el) => {
      el.classList.add('deleted');
      el.title = `${el.title} — message deleted`;
    });
  }

  // ---- login gate / embed fallback ----
  let gate = null;
  function showGate(reasonText) {
    if (gate || embedMode || destroyed) return;
    const a = auth() || {};
    if (a.loggedIn && a.canChat !== false) return; // looks fine — no gate
    clearInterval(loginPoll);
    const loginBtn = h('button', { class: 'btn primary', onclick: () => requestLogin?.() }, 'Log in with Twitch');
    const embedBtn = embedSrc
      ? h('button', { class: 'btn', onclick: () => showEmbed() }, 'Use read-only Twitch chat')
      : null;
    const title = !a.loggedIn
      ? 'Log in to use chat'
      : (a.canChat === false ? 'This token cannot chat' : 'Chat unavailable');
    const text = !a.loggedIn
      ? 'Sign in with Twitch to read and send messages here.'
      : (a.canChat === false
        ? 'The stored token is missing chat:read / chat:edit permissions. Log in again to chat.'
        : (reasonText || 'Chat could not be connected.'));
    gate = h('div', { class: 'chat-gate' },
      h('strong', {}, title), h('div', { class: 'muted' }, text),
      h('div', { class: 'row', style: { justifyContent: 'center', flexWrap: 'wrap' } }, loginBtn, embedBtn));
    root.append(gate);
    // After a successful login, re-check and reconnect.
    const started = Date.now();
    loginPoll = setInterval(() => {
      if (destroyed) { clearInterval(loginPoll); return; }
      if (Date.now() - started > 180_000) { clearInterval(loginPoll); return; }
      if (auth()?.loggedIn) {
        clearInterval(loginPoll);
        removeGate();
        reconnect();
      }
    }, 900);
  }

  function removeGate() {
    gate?.remove();
    gate = null;
  }

  function showEmbed() {
    embedMode = true;
    destroyStream();
    clearTimeout(retryTimer);
    clearInterval(loginPoll);
    removeGate();
    msgs.replaceChildren(h('iframe', {
      class: 'chat-embed', title: `Twitch chat for ${displayName || channel}`, src: embedSrc, allow: 'fullscreen',
    }));
    inputRow.hidden = true;
    dot.className = 'chat-dot';
    statusText.textContent = 'Read-only embed';
  }

  // ---- SSE ----
  function handle(ev) {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    switch (ev.type) {
      case 'init':
        closedRetries = 0;
        setStatus(d.status?.state || 'connecting');
        for (const m of d.history ?? []) addMessage(m);
        scrollToBottom();
        if (d.status?.state === 'error') showGate();
        break;
      case 'message': addMessage(d); break;
      case 'status': {
        const wasConnected = status === 'connected';
        setStatus(d.state);
        if (d.state === 'connected' && !wasConnected) sysLine('Connected to chat.', 'ok');
        if (d.state === 'error' && d.message) { sysLine(d.message, 'err'); showGate(); }
        if (d.state === 'reconnecting') sysLine('Connection lost — reconnecting…', 'warn');
        break;
      }
      case 'notice': sysLine(d.text ?? '', d.level === 'warn' ? 'warn' : 'event'); break;
      case 'clear': onClear(d); break;
      case 'delete': onDelete(d); break;
      case 'chat-error': sysLine(d.message ?? 'Chat error', 'err'); break;
      default: break;
    }
  }

  function connect() {
    if (destroyed) return;
    destroyStream();
    loadEmotes(); // provider emotes for this channel (server-cached, cosmetic)
    setStatus('connecting');
    try {
      es = new EventSource(`/api/chat/${encodeURIComponent(channel)}/events`);
    } catch {
      setStatus('offline');
      return;
    }
    for (const name of ['init', 'message', 'status', 'notice', 'clear', 'delete', 'chat-error']) {
      es.addEventListener(name, handle);
    }
    es.onerror = () => {
      if (destroyed || embedMode) return;
      // readyState CLOSED = the server refused the stream (401/404/…):
      // EventSource will not retry on its own in that case.
      if (es && es.readyState === EventSource.CLOSED) {
        destroyStream();
        closedRetries++;
        if (auth()?.loggedIn) {
          if (closedRetries <= 5) {
            setStatus('reconnecting');
            retryTimer = setTimeout(connect, Math.min(2000 * closedRetries, 10_000));
            retryTimer.unref?.();
          } else setStatus('offline');
        } else {
          setStatus('offline');
          showGate();
        }
        return;
      }
      // Plain network hiccup: EventSource keeps retrying by itself.
      if (status === 'connected') setStatus('reconnecting');
    };
  }

  function reconnect() {
    if (embedMode) return;
    msgs.replaceChildren();
    rendered = [];
    nameById.clear();
    pinned = true;
    connect();
  }

  function destroyStream() {
    if (es) { es.close(); es = null; }
  }

  // ---- sending ----
  async function send() {
    if (input.disabled) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    limitEl.hidden = true;
    input.disabled = sendBtn.disabled = true;
    try {
      await api(`/api/chat/${encodeURIComponent(channel)}/message`, { method: 'POST', body: { text } });
      selfMessage(text);
    } catch (e) {
      input.value = text; // let the user retry
      sysLine(e.code === 'rate_limited' && e.extra?.retryAfter
        ? `Sending too fast — wait ${e.extra.retryAfter}s.`
        : `Could not send: ${e.message}`, 'err');
      if (e.code === 'auth_required' || e.code === 'token_expired') showGate();
    } finally {
      const ready = status === 'connected' && (auth()?.loggedIn ?? false);
      input.disabled = sendBtn.disabled = !ready;
      input.focus();
    }
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === 'Escape') input.blur();
  });
  input.addEventListener('input', () => {
    const left = 500 - input.value.length;
    limitEl.hidden = left >= 60;
    limitEl.textContent = left >= 0 ? `${left}` : '0';
  });

  // ---- boot ----
  if ((auth()?.loggedIn ?? false) && (auth()?.canChat ?? true) !== false) connect();
  else showGate();

  return {
    el: root,
    channel,
    destroy() {
      destroyed = true;
      clearInterval(loginPoll);
      clearTimeout(retryTimer);
      destroyStream();
      root.remove();
    },
  };
}

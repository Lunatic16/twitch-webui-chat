// VOD chat replay: map Twitch's video-comment GQL nodes onto the same message
// shape the live chat panel renders (see privmsgToChat in chat.js), so the
// panel can draw replayed and live messages with one code path.
import { textMentions } from './chat.js';

// Persisted query the twitch.tv player itself uses to page through a VOD's chat.
export const COMMENTS_OPERATION = 'VideoCommentsByOffsetOrCursor';
export const COMMENTS_HASH = 'b70a3591ff0f4e0313d126c6a1502d79a1c02baebb288227c582044aa76adf6a';

// Plain-query fallback, used if Twitch stops recognising the persisted hash.
export const COMMENTS_QUERY = `query VideoComments($id: ID!, $offset: Int, $cursor: Cursor) {
  video(id: $id) {
    comments(contentOffsetSeconds: $offset, after: $cursor) {
      edges {
        cursor
        node {
          id
          contentOffsetSeconds
          createdAt
          commenter { id login displayName }
          message {
            fragments { text emote { emoteID } }
            userBadges { setID version }
            userColor
          }
        }
      }
      pageInfo { hasNextPage }
    }
  }
}`;

/** One comment node -> chat DTO (null when the node is unusable, e.g. deleted user). */
export function commentToChat(node, { selfLogin = null } = {}) {
  if (!node || typeof node !== 'object') return null;
  const msg = node.message;
  if (!msg) return null;
  const fragments = Array.isArray(msg.fragments) ? msg.fragments : [];
  const emotes = [];
  let text = '';
  for (const f of fragments) {
    const t = String(f?.text ?? '');
    if (!t) continue;
    text += t;
    const id = f?.emote?.emoteID;
    if (id) emotes.push({ type: 'emote', id: String(id), text: t });
    else if (emotes.length && emotes[emotes.length - 1].type === 'text') emotes[emotes.length - 1].text += t;
    else emotes.push({ type: 'text', text: t });
  }
  if (!text) return null;
  const c = node.commenter;
  const login = String(c?.login ?? '').toLowerCase();
  const badges = (Array.isArray(msg.userBadges) ? msg.userBadges : [])
    .filter((b) => b?.setID)
    .map((b) => ({ id: String(b.setID), version: String(b.version ?? '1') }));
  return {
    type: 'message',
    id: node.id ? String(node.id) : null,
    login,
    display: c?.displayName || login || 'unknown',
    color: /^#[0-9a-fA-F]{6}$/.test(msg.userColor ?? '') ? msg.userColor : null,
    badges,
    subMonths: null,
    mod: badges.some((b) => b.id === 'moderator'),
    text,
    action: false,
    emotes,
    offset: Number(node.contentOffsetSeconds) || 0, // seconds from the start of the VOD
    ts: Date.parse(node.createdAt) || 0,
    self: !!selfLogin && login === selfLogin.toLowerCase(),
    mention: !!selfLogin && textMentions(text, selfLogin),
  };
}

/** GQL response data -> { messages, cursor, hasNext }; tolerant of missing pieces. */
export function parseComments(data, opts = {}) {
  const conn = data?.video?.comments;
  const edges = Array.isArray(conn?.edges) ? conn.edges : [];
  const messages = edges.map((e) => commentToChat(e?.node, opts)).filter(Boolean);
  const cursor = edges.length ? (edges[edges.length - 1]?.cursor ?? null) : null;
  return { messages, cursor, hasNext: !!conn?.pageInfo?.hasNextPage && !!cursor, found: !!data?.video };
}

// Shape Helix/GQL objects into the compact JSON the frontend consumes.
import { formatDuration } from './util.js';

export const thumbnail = (login) => `https://static-cdn.jtvnw.net/previews-ttv/live_user_${String(login).toLowerCase()}-440x248.jpg`;

export const streamDto = (s) => ({
  userId: String(s.user_id ?? ''),
  login: String(s.user_login ?? ''),
  name: String(s.user_name ?? s.user_login ?? 'Unknown'),
  game: String(s.game_name ?? ''),
  viewers: Number(s.viewer_count ?? 0),
  startedAt: s.started_at ?? null,
  title: String(s.title ?? ''),
  thumbnail: thumbnail(s.user_login ?? ''),
});

export const vodDto = (v) => ({
  id: String(v.id ?? ''),
  title: String(v.title ?? 'VOD'),
  login: String(v.user_login ?? ''),
  name: String(v.user_name ?? ''),
  duration: formatDuration(v.duration),
  views: Number(v.view_count ?? 0),
  createdAt: v.created_at ?? null,
  thumbnail: String(v.thumbnail_url ?? '').replace('%{width}', '440').replace('%{height}', '248').replace('{width}', '440').replace('{height}', '248'),
});

export const channelDto = (c) => ({
  login: String(c.broadcaster_login ?? ''),
  name: String(c.display_name ?? c.broadcaster_login ?? 'Unknown'),
  live: !!c.is_live,
  game: String(c.game_name ?? ''),
  title: String(c.title ?? ''),
  startedAt: c.started_at || null,
  thumbnail: thumbnail(c.broadcaster_login ?? ''),
});

export const gameDto = (g) => ({
  id: String(g.id ?? ''),
  name: String(g.name ?? 'Unknown'),
  boxArt: String(g.box_art_url ?? '').replace('{width}', '188').replace('{height}', '250'),
});

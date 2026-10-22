// Constants reproduced from proxy-twitch-cli.py v3.1.0. Do not change casually:
// Twitch is picky about client ids, user agents and token parameter sets.

export const VERSION = '1.0.0';

export const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
export const OAUTH_CLIENT_ID = 'l2wx7tow5m77hvmg883p3a985618os';
export const OAUTH_SCOPES = 'chat:read chat:edit user:read:follows';
export const REDIRECT_URI = 'http://localhost';

export const GQL_URL = 'https://gql.twitch.tv/gql';
export const GQL_HEADERS = Object.freeze({
  'Client-ID': GQL_CLIENT_ID,
  'Content-Type': 'application/json',
  Referer: 'https://www.twitch.tv/',
});

export const ANDROID_USER_AGENT = 'Twitch/14.9.1 (Linux; U; Android 13; en) ExoPlayer';

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RETRIES = 3;
export const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export const TOKEN_ENV_VAR = 'TWITCH_TOKEN';
export const WEB_TOKEN_ENV_VAR = 'TWITCH_WEB_AUTH_TOKEN';
export const CONFIG_ENV_VAR = 'TWITCH_WEBUI_CONFIG';

export const KEYRING_SERVICE = 'twitch-webui';

export const HLS_MIME = 'application/vnd.apple.mpegurl';

// Token flavors tried when the current one serves ads. Order matters.
export const AD_FREE_PARAM_SETS = Object.freeze([
  Object.freeze({ platform: 'android', playerBackend: 'mediaplayer', playerType: 'mobile' }),
  Object.freeze({ platform: 'web', playerBackend: 'mediaplayer', playerType: 'frontpage' }),
  Object.freeze({ platform: 'web', playerBackend: 'mediaplayer', playerType: 'embed' }),
  Object.freeze({ platform: 'ios', playerBackend: 'mediaplayer', playerType: 'ios' }),
  Object.freeze({ platform: 'web', playerBackend: 'mediaplayer', playerType: 'site' }),
]);

export const AD_MARKERS = Object.freeze([
  'twitch-stitched-ad',
  'stitched-ad',
  'EXT-X-SCTE35',
  'stitchedad',
]);

export const ROTATE_COOLDOWN_MS = 4000;
export const MIN_BW_RATIO = 0.7;

export const AVAILABLE_PLAYERS = Object.freeze({
  mpv: 'Lightweight media player',
  vlc: 'Cross-platform media player',
  'flatpak-vlc': 'VLC via Flatpak',
  ffplay: 'FFplay-based player',
});

export function buildAuthUrl() {
  return (
    'https://id.twitch.tv/oauth2/authorize' +
    `?client_id=${OAUTH_CLIENT_ID}` +
    `&redirect_uri=${REDIRECT_URI}` +
    '&response_type=token' +
    `&scope=${OAUTH_SCOPES.replace(/ /g, '+')}`
  );
}

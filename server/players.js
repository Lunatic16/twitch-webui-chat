// External player support (port of get_player_args / resolve_player).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ANDROID_USER_AGENT, AVAILABLE_PLAYERS } from './constants.js';
import { log } from './log.js';

export function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return path.join(dir, cmd);
    } catch { /* keep looking */ }
  }
  return null;
}

export const playerInstalled = (name) => !!which(name === 'flatpak-vlc' ? 'flatpak' : name);

export function resolvePlayer(requested) {
  if (!(requested in AVAILABLE_PLAYERS)) return requested;
  if (playerInstalled(requested)) return requested;
  for (const name of Object.keys(AVAILABLE_PLAYERS)) if (playerInstalled(name)) return name;
  return requested;
}

export function listPlayers() {
  return Object.entries(AVAILABLE_PLAYERS).map(([name, description]) => ({ name, description, installed: playerInstalled(name) }));
}

export function mpvBitrateFromQuality(quality) {
  if (!quality) return null;
  let q = String(quality).toLowerCase().trim();
  if (['max', 'min', 'source'].includes(q)) return q === 'min' ? 'min' : 'max';
  q = q.replace(/p+$/, '');
  return /^\d+$/.test(q) ? String(parseInt(q, 10) * 1000) : null;
}

/** @returns {{args: string[]|string, shell: boolean}} */
export function getPlayerArgs(player, url, title, o, proxied = false) {
  if (o.customPlayer) return { args: o.customPlayer.replaceAll('{url}', url), shell: true };

  if (player === 'mpv') {
    const args = ['mpv', '--vo=gpu', '--hwdec=auto', `--user-agent=${ANDROID_USER_AGENT}`, '--referrer=https://www.twitch.tv/'];
    if (o.audioOnly) args.push('--no-video');
    if (o.lowLatency) args.push('--profile=low-latency', '--cache=no');
    else if (o.cache) args.push('--cache=yes');
    // Behind the proxy the master is already capped to the chosen quality.
    const bitrate = proxied ? null : mpvBitrateFromQuality(o.quality);
    if (bitrate) args.push(`--hls-bitrate=${bitrate}`);
    if (title) args.push(`--force-media-title=${title}`);
    args.push(url);
    return { args, shell: false };
  }

  if (player === 'vlc' || player === 'flatpak-vlc') {
    const args = player === 'vlc' ? ['vlc'] : ['flatpak', 'run', 'org.videolan.VLC'];
    args.push('--intf=rc', `--http-user-agent=${ANDROID_USER_AGENT}`);
    if (o.audioOnly) args.push('--no-video');
    if (o.lowLatency) args.push('--network-caching=300');
    else if (o.cache) args.push('--network-caching=1000');
    if (title) args.push('--meta-title', title);
    args.push(url);
    return { args, shell: false };
  }

  if (player === 'ffplay') {
    const args = ['ffplay', '-autoexit', '-headers', `User-Agent: ${ANDROID_USER_AGENT}\r\nReferer: https://www.twitch.tv/\r\n`];
    if (o.audioOnly) args.push('-nodisp');
    if (o.lowLatency) args.push('-fflags', 'nobuffer');
    if (title) args.push('-window_title', title);
    args.push(url);
    return { args, shell: false };
  }

  return { args: ['mpv', '--vo=gpu', '--hwdec=auto', `--user-agent=${ANDROID_USER_AGENT}`, url], shell: false };
}

const children = new Set();

export function launchPlayer({ args, shell }) {
  const child = shell
    ? spawn(args, { shell: true, stdio: 'ignore' })
    : spawn(args[0], args.slice(1), { stdio: 'ignore' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return new Promise((resolve, reject) => {
    child.once('error', (e) => { children.delete(child); reject(e); });
    child.once('spawn', () => resolve(child.pid));
  });
}

export function stopAllPlayers() {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch (e) { log.debug('kill failed:', e.message); }
  }
  children.clear();
}

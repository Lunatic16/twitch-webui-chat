// Logging with token redaction, an in-memory ring buffer (for the debug
// drawer) and optional file output. Also hosts the app-wide event bus used
// for toasts (rate limits, auth expiry).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export const logBus = new EventEmitter();
export const appEvents = new EventEmitter();
logBus.setMaxListeners(50);
appEvents.setMaxListeners(100);

const secrets = new Set();
const ring = [];
let debugEnabled = false;
let fileStream = null;

export function registerSecret(value) {
  if (value && String(value).length >= 8) secrets.add(String(value));
}
export function forgetSecret(value) {
  secrets.delete(String(value));
}

export function redact(input) {
  let s = String(input);
  for (const sec of secrets) s = s.split(sec).join('«redacted»');
  return s
    .replace(/\b(OAuth|Bearer)\s+[A-Za-z0-9_.\-]+/gi, '$1 «redacted»')
    .replace(/([?&](?:token|sig|access_token|oauth_token)=)[^&\s"']+/gi, '$1«redacted»');
}

export function configureLogging({ debug, logFile }) {
  debugEnabled = !!debug;
  if (fileStream) { fileStream.end(); fileStream = null; }
  if (logFile) {
    try {
      const p = logFile.startsWith('~') ? path.join(process.env.HOME || '', logFile.slice(1)) : logFile;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fileStream = fs.createWriteStream(p, { flags: 'a', mode: 0o600 });
      fileStream.on('error', () => { fileStream = null; });
    } catch (e) {
      console.warn(`Could not open log file ${logFile}: ${e.message}`);
    }
  }
}

export const isDebug = () => debugEnabled;
export const getLogRing = () => ring.slice();

function fmt(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  try { return JSON.stringify(arg); } catch { return String(arg); }
}

function emit(level, args) {
  if (level === 'debug' && !debugEnabled) return;
  const message = redact(args.map(fmt).join(' '));
  const entry = { ts: Date.now(), level, message };
  ring.push(entry);
  if (ring.length > 500) ring.shift();
  logBus.emit('log', entry);
  const line = `${new Date(entry.ts).toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  if (fileStream) fileStream.write(line + '\n');
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

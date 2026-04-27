/**
 * @file Tiny structured logger writing to stdout and a daily log file.
 *
 * The logger intentionally has zero hard runtime dependencies for the
 * file-write path so it remains usable inside `process.on('exit')`
 * handlers where async I/O is unsafe. Terminal output is colourised
 * via {@link https://github.com/chalk/chalk chalk}; if chalk fails to
 * load we transparently fall back to plain ASCII.
 *
 * Windows note: Chalk auto-detects support via `supports-color`, which
 * sometimes returns `level=0` inside Windows PowerShell or VS Code's
 * integrated terminal. To keep colours working there we instantiate a
 * `new Chalk({ level })` with our own resolution that prefers (in
 * order): explicit `NK_LOG_COLOR`, `FORCE_COLOR`, `supports-color`'s
 * detection, and finally a `level=1` Windows TTY fallback.
 */

import fs from 'node:fs';
import path from 'node:path';

import { config } from '../config/index.js';

/**
 * Supported log levels. The numeric ordering controls filtering.
 *
 * @type {Readonly<Record<'debug' | 'info' | 'warn' | 'error', number>>}
 */
const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

/** @type {keyof typeof LEVELS} */
const ACTIVE_LEVEL =
  /** @type {keyof typeof LEVELS} */ (process.env.NK_LOG_LEVEL ?? 'info');

/**
 * Resolved chalk colour level (`0`–`3`). Determined once at startup so
 * the rest of the logger can branch cheaply.
 *
 * `0` means "no colour"; `1` is 16-colour ANSI (universally supported),
 * `2` is 256-colour, `3` is truecolor.
 *
 * @type {number}
 */
const COLOR_LEVEL = (() => {
  const explicit = (process.env.NK_LOG_COLOR ?? '').trim().toLowerCase();
  if (explicit === '0' || explicit === 'false' || explicit === 'no' || explicit === 'off') {
    return 0;
  }
  if (explicit === 'auto' || explicit === '') {
    /* fall through to auto-detect */
  } else if (['1', '2', '3'].includes(explicit)) {
    return Number(explicit);
  } else if (['true', 'yes', 'on'].includes(explicit)) {
    return 1;
  }

  // Honour FORCE_COLOR if the user already exported it.
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '') {
    const num = Number.parseInt(force, 10);
    if (Number.isFinite(num)) return Math.max(0, Math.min(3, num));
    if (['true', 'yes', 'on'].includes(force.toLowerCase())) return 1;
    if (['false', 'no', 'off'].includes(force.toLowerCase())) return 0;
  }

  if (!process.stdout.isTTY) return 0;

  // Windows 10+ console hosts (incl. PowerShell + Windows Terminal +
  // VS Code) support ANSI 16-colour out of the box, but Chalk's
  // built-in detection misfires on some hosts and returns 0. Force
  // level 1 so the colours show up reliably.
  if (process.platform === 'win32') return 1;

  // POSIX TTYs default to truecolor when COLORTERM declares it.
  if (/^(?:truecolor|24bit)$/i.test(process.env.COLORTERM ?? '')) return 3;
  return 1;
})();

/**
 * Lazily-resolved chalk instance, configured with our explicit colour
 * level. Loaded asynchronously the first time a record is emitted; until
 * then we render plain text.
 *
 * @type {import('chalk').ChalkInstance | null}
 */
let chalk = null;

/* eslint-disable promise/catch-or-return */
import('chalk')
  .then((mod) => {
    if (COLOR_LEVEL > 0 && typeof mod.Chalk === 'function') {
      chalk = new mod.Chalk({ level: /** @type {0|1|2|3} */ (COLOR_LEVEL) });
    } else {
      chalk = mod.default;
    }
  })
  .catch(() => {
    /* chalk is optional; plain text fallback is fine */
  });
/* eslint-enable promise/catch-or-return */

/**
 * True when terminal output should include ANSI colour codes.
 *
 * @type {boolean}
 */
const COLOR_ENABLED = COLOR_LEVEL > 0;

/**
 * Lazily-created append stream for the active log file.
 *
 * @type {fs.WriteStream | null}
 */
let logStream = null;

/**
 * Build (and cache) the file write stream that mirrors all log lines.
 *
 * @returns {fs.WriteStream} Append-mode stream pointing at today's log file.
 */
function getLogStream() {
  if (logStream) return logStream;
  fs.mkdirSync(config.paths.logs, { recursive: true });
  const now = new Date();
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const logFile = path.join(config.paths.logs, `nk-cli-${date}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  return logStream;
}

/**
 * Zero-pad a small integer to two digits.
 *
 * @param {number} value Value in 0–99 range.
 * @returns {string} Two-character zero-padded string.
 */
function pad2(value) {
  return value < 10 ? `0${value}` : `${value}`;
}

/**
 * Zero-pad an integer to three digits.
 *
 * @param {number} value Value in 0–999 range.
 * @returns {string} Three-character zero-padded string.
 */
function pad3(value) {
  if (value < 10) return `00${value}`;
  if (value < 100) return `0${value}`;
  return `${value}`;
}

/**
 * Format the current wall-clock time in the local timezone as
 * `YYYY-MM-DD HH:mm:ss.SSS`. Chosen over `toISOString()` because the
 * user runs the scraper interactively and wants timestamps that match
 * their local clock.
 *
 * @returns {string} Local timestamp.
 */
function formatTimestamp() {
  const now = new Date();
  return (
    `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.` +
    `${pad3(now.getMilliseconds())}`
  );
}

/**
 * Apply a chalk style to a string, returning the original unchanged
 * when colour is disabled or chalk is not yet loaded.
 *
 * @param {(value: string) => string} style Chalk style function.
 * @param {string} value Raw text to colourise.
 * @returns {string} Possibly-coloured text.
 */
function paint(style, value) {
  if (!COLOR_ENABLED || !chalk) return value;
  try {
    return style(value);
  } catch {
    return value;
  }
}

/**
 * Render the level tag (`[INFO]`, `[ERROR]`, …) with an appropriate colour.
 *
 * @param {keyof typeof LEVELS} level Severity of the record.
 * @returns {string} Painted level tag including brackets.
 */
function paintLevel(level) {
  const tag = `[${level.toUpperCase()}]`;
  if (!COLOR_ENABLED || !chalk) return tag;
  switch (level) {
    case 'debug':
      return chalk.gray(tag);
    case 'info':
      return chalk.cyan(tag);
    case 'warn':
      return chalk.yellow(tag);
    case 'error':
      return chalk.red.bold(tag);
    default:
      return tag;
  }
}

/**
 * Build the metadata suffix for a log record (`{...json...}`), or an
 * empty string when no metadata was supplied.
 *
 * @param {Record<string, unknown> | undefined} meta Optional metadata.
 * @returns {{ painted: string, plain: string }} Painted and plain renderings.
 */
function renderMeta(meta) {
  if (!meta || Object.keys(meta).length === 0) {
    return { painted: '', plain: '' };
  }
  const json = JSON.stringify(meta);
  return {
    painted: ` ${paint((s) => chalk.gray(s), json)}`,
    plain: ` ${json}`,
  };
}

/**
 * Format a single log record for terminal output (with colour) and for
 * the on-disk log file (plain text).
 *
 * @param {keyof typeof LEVELS} level Severity of the record.
 * @param {string} message Human-readable message body.
 * @param {Record<string, unknown>} [meta] Optional structured metadata.
 * @returns {{ tty: string, file: string }} Newline-terminated lines.
 */
function formatLine(level, message, meta) {
  const timestamp = formatTimestamp();
  const { painted, plain } = renderMeta(meta);
  const file = `${timestamp} [${level.toUpperCase()}] ${message}${plain}\n`;
  const tty =
    `${paint((s) => chalk.dim(s), timestamp)} ` +
    `${paintLevel(level)} ${message}${painted}\n`;
  return { tty, file };
}

/**
 * Emit a log record if its level passes the active threshold.
 *
 * @param {keyof typeof LEVELS} level Severity of the record.
 * @param {string} message Human-readable message body.
 * @param {Record<string, unknown>} [meta] Optional structured metadata.
 * @returns {void}
 */
function log(level, message, meta) {
  if (LEVELS[level] < LEVELS[ACTIVE_LEVEL]) return;
  const { tty, file } = formatLine(level, message, meta);
  const target = level === 'error' ? process.stderr : process.stdout;
  target.write(tty);
  try {
    getLogStream().write(file);
  } catch {
    // Logging must never throw; swallow filesystem errors.
  }
}

/**
 * Logger facade with one method per supported severity.
 *
 * @type {Readonly<Record<keyof typeof LEVELS, (msg: string, meta?: Record<string, unknown>) => void>>}
 */
export const logger = Object.freeze({
  debug: (msg, meta) => log('debug', msg, meta),
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
});

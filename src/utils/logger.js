/**
 * @file Tiny structured logger writing to stdout and a daily log file.
 *
 * The logger intentionally has zero runtime dependencies so it remains
 * usable inside `process.on('exit')` handlers where async I/O is unsafe.
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
  const date = new Date().toISOString().slice(0, 10);
  const logFile = path.join(config.paths.logs, `nk-cli-${date}.log`);
  logStream = fs.createWriteStream(logFile, { flags: 'a' });
  return logStream;
}

/**
 * Format a single log record as a one-line string.
 *
 * @param {keyof typeof LEVELS} level Severity of the record.
 * @param {string} message Human-readable message body.
 * @param {Record<string, unknown>} [meta] Optional structured metadata.
 * @returns {string} Newline-terminated log line.
 */
function formatLine(level, message, meta) {
  const timestamp = new Date().toISOString();
  const metaPart = meta && Object.keys(meta).length
    ? ` ${JSON.stringify(meta)}`
    : '';
  return `${timestamp} [${level.toUpperCase()}] ${message}${metaPart}\n`;
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
  const line = formatLine(level, message, meta);
  const target = level === 'error' ? process.stderr : process.stdout;
  target.write(line);
  try {
    getLogStream().write(line);
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

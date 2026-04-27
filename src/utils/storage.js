/**
 * @file Atomic JSON read/write helpers used for resume-friendly checkpoints.
 *
 * Every write goes through a `*.tmp` file followed by `fs.rename` so that
 * a crash (or SIGINT) cannot leave the checkpoint half-written.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { logger } from './logger.js';

/**
 * Ensure the directory portion of `filePath` exists.
 *
 * @param {string} filePath Path whose parent directory should be created.
 * @returns {Promise<void>} Resolves once `mkdir -p` completes.
 */
async function ensureDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Read a JSON file from disk, returning `fallback` if it does not exist.
 *
 * @template T
 * @param {string} filePath Absolute path to the JSON file.
 * @param {T} fallback Value returned when the file is missing.
 * @returns {Promise<T>} Parsed JSON or `fallback`.
 */
export async function readJson(filePath, fallback) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return /** @type {T} */ (JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
    ) {
      return fallback;
    }
    logger.warn('Failed to read JSON, returning fallback', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

/**
 * Atomically write a JSON value to disk with stable 2-space formatting.
 *
 * @param {string} filePath Absolute target path for the JSON file.
 * @param {unknown} value Serialisable value to persist.
 * @returns {Promise<void>} Resolves once the rename has completed.
 */
export async function writeJson(filePath, value) {
  await ensureDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fsp.writeFile(tmpPath, payload, 'utf8');
  await fsp.rename(tmpPath, filePath);
}

/**
 * Synchronous JSON writer used inside graceful shutdown hooks where
 * async I/O is not safe (e.g. `beforeExit`/`uncaughtException`).
 *
 * @param {string} filePath Absolute target path for the JSON file.
 * @param {unknown} value Serialisable value to persist.
 * @returns {void}
 */
export function writeJsonSync(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(tmpPath, payload, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

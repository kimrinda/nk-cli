/**
 * @file Cookie store for HTTP-mode scraping.
 *
 * Reads and writes the Cookie-Editor JSON export format (an array of
 * cookie records, each with a `name` and `value`) and exposes helpers
 * for serialising the cookies into a single `Cookie:` request header
 * string.
 *
 * The default on-disk path is `<projectRoot>/nk-cookies.json` which is
 * what the developer-supplied reference script consumes. The path can
 * be overridden via the `NK_COOKIE_FILE` environment variable.
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/**
 * Default location of the Cookie-Editor JSON export.
 *
 * @type {string}
 */
export const DEFAULT_COOKIE_FILE = path.join(
  config.paths.root,
  'nk-cookies.json',
);

/**
 * Resolve the configured cookie-file path, honouring `NK_COOKIE_FILE`.
 *
 * @returns {string} Absolute path to the cookie JSON file.
 */
export function getCookieFilePath() {
  const override = process.env.NK_COOKIE_FILE;
  if (override && override.trim()) {
    return path.isAbsolute(override)
      ? override
      : path.resolve(config.paths.root, override);
  }
  return DEFAULT_COOKIE_FILE;
}

/**
 * Cookie-Editor cookie record (subset we actually use).
 *
 * @typedef {object} CookieRecord
 * @property {string} name Cookie name.
 * @property {string} value Cookie value.
 * @property {string} [domain] Domain attribute (informational only).
 * @property {string} [path] Path attribute (informational only).
 */

/**
 * Read the cookie-editor JSON export from disk.
 *
 * @param {string} [filePath] Absolute path. Defaults to the resolved
 *   {@link getCookieFilePath} value.
 * @returns {Promise<CookieRecord[]>} Parsed cookie records, or an empty
 *   array if the file is missing.
 */
export async function readCookies(filePath = getCookieFilePath()) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn('Cookie file did not contain an array; ignoring', {
        filePath,
      });
      return [];
    }
    return /** @type {CookieRecord[]} */ (parsed);
  } catch (error) {
    if (
      error instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
    ) {
      return [];
    }
    logger.warn('Failed to read cookie file; treating as empty', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Write the supplied cookie records back to disk in Cookie-Editor JSON
 * format. Atomic via tmp-file + rename so a partial write cannot leave
 * a corrupt file behind.
 *
 * @param {CookieRecord[]} cookies Records to persist.
 * @param {string} [filePath] Optional override for the destination
 *   path. Defaults to the resolved {@link getCookieFilePath} value.
 * @returns {Promise<void>} Resolves once the rename has completed.
 */
export async function writeCookies(cookies, filePath = getCookieFilePath()) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(cookies, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Serialise a list of cookie records into a single `Cookie:` header
 * value (the format axios expects).
 *
 * Empty names and undefined values are filtered out so a malformed
 * export does not produce invalid headers.
 *
 * @param {CookieRecord[]} cookies Cookie records (Cookie-Editor format).
 * @returns {string} `name=value; …` header string. Empty when no
 *   usable cookies were supplied.
 */
export function cookiesToHeader(cookies) {
  return cookies
    .filter((cookie) => cookie && typeof cookie.name === 'string' && cookie.name)
    .map(
      (cookie) => `${cookie.name}=${cookie.value !== undefined ? cookie.value : ''}`,
    )
    .join('; ');
}

/**
 * Parse a raw paste blob into an array of cookie records.
 *
 * Accepts either:
 *   * A Cookie-Editor JSON array (`[ { name, value, ... }, ... ]`).
 *   * A `Cookie:` header string (`name=value; name2=value2`).
 *
 * @param {string} raw Raw text supplied by the user.
 * @returns {CookieRecord[] | null} Parsed records, or `null` when the
 *   input could not be interpreted.
 */
export function parsePastedCookies(raw) {
  const text = (raw || '').trim();
  if (!text) return null;

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return /** @type {CookieRecord[]} */ (parsed).filter(
          (cookie) => cookie && typeof cookie.name === 'string',
        );
      }
    } catch {
      return null;
    }
    return null;
  }

  // Fallback: treat as a `Cookie:` header value.
  const stripped = text.replace(/^cookie\s*:\s*/i, '');
  const records = stripped
    .split(/;\s*/)
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx < 0) return null;
      return {
        name: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
      };
    })
    .filter(
      /** @type {(c: CookieRecord | null) => c is CookieRecord} */
      ((cookie) => cookie !== null && cookie.name.length > 0),
    );
  return records.length ? records : null;
}

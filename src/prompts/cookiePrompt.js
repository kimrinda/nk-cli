/**
 * @file Inquirer prompt that asks the user to paste a fresh
 * Cookie-Editor JSON export when the existing cookies appear expired
 * or rejected by the upstream WAF.
 *
 * Honours `NK_AUTO_COOKIE_REFRESH=no` for non-interactive runs (skip
 * the prompt and let the caller raise the original error). When stdin
 * is not a TTY the prompt is also skipped.
 */

import { logger } from '../utils/logger.js';
import { parsePastedCookies, writeCookies } from '../http/cookieStore.js';

/**
 * @typedef {import('../http/cookieStore.js').CookieRecord} CookieRecord
 */

/**
 * Lazy-load `@inquirer/prompts.editor`. Returns `null` when the module
 * is unavailable so callers can fall back gracefully.
 *
 * @returns {Promise<((q: object) => Promise<string>) | null>} Loaded
 *   `editor` function or `null`.
 */
async function loadEditor() {
  try {
    const mod = await import('@inquirer/prompts');
    return /** @type {any} */ (mod).editor ?? null;
  } catch (error) {
    logger.warn('Inquirer unavailable; cookie refresh prompt will be skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Whether the cookie-refresh prompt should be skipped entirely
 * (non-interactive shells, or `NK_AUTO_COOKIE_REFRESH=no`).
 *
 * @returns {boolean} True when the prompt must be bypassed.
 */
function shouldSkipPrompt() {
  const override = (process.env.NK_AUTO_COOKIE_REFRESH ?? '')
    .trim()
    .toLowerCase();
  if (['no', 'false', '0', 'off'].includes(override)) return true;
  if (!process.stdin.isTTY) return true;
  return false;
}

/**
 * Ask the user to paste a fresh cookie JSON export and persist it to
 * disk via {@link writeCookies}. The returned record array is the
 * parsed value the caller should immediately use for the retry.
 *
 * @param {object} options Prompt options.
 * @param {string} options.cookieFilePath Absolute path of the cookie
 *   file the new payload will be written to.
 * @param {string} [options.reason] Optional human-readable reason for
 *   the prompt (e.g. "Received HTTP 468 from nekopoi.care").
 * @returns {Promise<CookieRecord[] | null>} Parsed cookies on success,
 *   or `null` when the user aborted, the prompt was skipped, or the
 *   pasted payload could not be parsed.
 */
export async function promptForFreshCookies(options) {
  const { cookieFilePath, reason } = options;

  if (shouldSkipPrompt()) {
    logger.warn(
      'Cookie refresh prompt skipped (non-interactive or NK_AUTO_COOKIE_REFRESH=no).',
      { reason: reason ?? 'unspecified' },
    );
    return null;
  }

  const editor = await loadEditor();
  if (!editor) return null;

  const banner = [
    'Cookie/session appears expired or invalid.',
    reason ? `Reason: ${reason}` : null,
    `Please paste a fresh cookie JSON export (Cookie-Editor format).`,
    `It will be saved to: ${cookieFilePath}`,
    '',
    'Tips:',
    '  * Open the target site in your browser, log in, then export the',
    '    cookies via the Cookie-Editor extension ("Export → JSON").',
    '  * Save and close the editor when done. Leave it empty to abort.',
  ]
    .filter(Boolean)
    .join('\n');

  /** @type {string} */
  const raw = await editor({
    message: banner,
    default: '[]',
    waitForUseInput: false,
  });

  const parsed = parsePastedCookies(raw);
  if (!parsed || parsed.length === 0) {
    logger.warn(
      'No valid cookies parsed from user input — keeping existing file.',
    );
    return null;
  }

  await writeCookies(parsed, cookieFilePath);
  logger.info('Saved fresh cookies to disk', {
    cookieFilePath,
    count: parsed.length,
  });
  return parsed;
}

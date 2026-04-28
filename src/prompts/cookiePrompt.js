/**
 * @file Inquirer-driven prompt that asks the user to paste a fresh
 * Cookie-Editor JSON export directly into the terminal when the
 * existing cookies appear expired or rejected by the upstream WAF.
 *
 * The flow is intentionally a single-line paste:
 *
 *   Paste your cookie here: <user pastes JSON> <Enter>
 *
 * No external editor is launched. The pasted value is parsed via
 * {@link parsePastedCookies} (accepts the Cookie-Editor JSON array
 * format or a raw `Cookie:` header line) and persisted atomically to
 * `nk-cookies.json` before the caller retries the failing request.
 *
 * Honours `NK_AUTO_COOKIE_REFRESH=no` for non-interactive runs (skip
 * the prompt and let the caller raise the original error). When stdin
 * is not a TTY the prompt is also skipped.
 */

import chalk from 'chalk';

import { logger } from '../utils/logger.js';
import { parsePastedCookies, writeCookies } from '../http/cookieStore.js';

/**
 * @typedef {import('../http/cookieStore.js').CookieRecord} CookieRecord
 */

/**
 * Lazy-load `@inquirer/prompts.input`. Returns `null` when the module
 * is unavailable so callers can fall back gracefully.
 *
 * @returns {Promise<((q: object) => Promise<string>) | null>} Loaded
 *   `input` function or `null`.
 */
async function loadInput() {
  try {
    const mod = await import('@inquirer/prompts');
    return /** @type {any} */ (mod).input ?? null;
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
 * Print a coloured, multi-line WAF warning banner directly to stderr
 * so it is visible immediately above the inquirer prompt regardless of
 * the active log level. Yellow + red call out the failure, cyan
 * surfaces the actionable tips.
 *
 * @param {string} cookieFilePath Absolute path the new payload will be
 *   written to.
 * @param {string} [reason] Optional human-readable reason for the
 *   prompt (e.g. "Received HTTP 468 from nekopoi.care").
 * @returns {void}
 */
function printWafBanner(cookieFilePath, reason) {
  const lines = [
    '',
    chalk.bold.red('!! WAF / cookie session rejected !!'),
    chalk.yellow('Cookie/session appears expired or invalid.'),
    reason ? chalk.yellow(`Reason: ${reason}`) : null,
    chalk.yellow(
      'Please paste a fresh Cookie-Editor JSON export to continue.',
    ),
    chalk.yellow(`It will be saved to: ${cookieFilePath}`),
    '',
    chalk.cyan('Tips:'),
    chalk.cyan(
      '  * Open the target site in your browser, log in, then click the',
    ),
    chalk.cyan(
      '    Cookie-Editor extension and choose "Export" -> "JSON".',
    ),
    chalk.cyan(
      '  * Copy the resulting JSON array and paste it on the next line.',
    ),
    chalk.cyan(
      '  * A raw `Cookie:` header value (e.g. "name=value; ...") works too.',
    ),
    chalk.cyan('  * Press Enter on an empty line to abort.'),
    '',
  ];
  for (const line of lines) {
    if (line === null) continue;
    process.stderr.write(`${line}\n`);
  }
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

  const input = await loadInput();
  if (!input) return null;

  printWafBanner(cookieFilePath, reason);

  /** @type {string} */
  const raw = await input({
    message: chalk.bold.cyan('Paste your cookie here:'),
    default: '',
    validate: (value) => {
      const text = (value || '').trim();
      if (!text) return true; // empty == abort
      const parsed = parsePastedCookies(text);
      if (!parsed || parsed.length === 0) {
        return (
          'Could not parse pasted value as Cookie-Editor JSON or a Cookie header. ' +
          'Paste the full JSON array, or a "name=value; name2=value2" header.'
        );
      }
      return true;
    },
  });

  const trimmed = (raw || '').trim();
  if (!trimmed) {
    process.stderr.write(
      `${chalk.yellow(
        'Cookie refresh aborted by user — keeping existing cookie file.',
      )}\n`,
    );
    return null;
  }

  const parsed = parsePastedCookies(trimmed);
  if (!parsed || parsed.length === 0) {
    process.stderr.write(
      `${chalk.red(
        'No valid cookies parsed from pasted input — keeping existing file.',
      )}\n`,
    );
    return null;
  }

  await writeCookies(parsed, cookieFilePath);
  process.stderr.write(
    `${chalk.green(
      `Saved ${parsed.length} cookie${parsed.length === 1 ? '' : 's'} to ${cookieFilePath}. Retrying request...`,
    )}\n`,
  );
  logger.info('Saved fresh cookies to disk', {
    cookieFilePath,
    count: parsed.length,
  });
  return parsed;
}

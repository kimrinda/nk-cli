/**
 * @file Cookie-refresh flow that pauses the running scrape, opens the
 * `nk-cookies.json` file in the user's default editor (via the
 * cross-platform [`open`](https://www.npmjs.com/package/open)
 * package) and waits for the user to press Enter once they have
 * saved a fresh Cookie-Editor JSON export.
 *
 * Why no in-terminal paste? Windows PowerShell cannot reliably paste
 * a multi-line JSON blob into a single-line prompt — the terminal
 * splits the paste at every newline. Delegating to the OS's default
 * text editor sidesteps that entirely and keeps the same UX on Linux,
 * macOS and Windows.
 *
 * Honours `NK_AUTO_COOKIE_REFRESH=no` for non-interactive runs (skip
 * the prompt and let the caller raise the original error). When stdin
 * is not a TTY the prompt is also skipped.
 */

import fs from 'node:fs/promises';

import chalk from 'chalk';
import open from 'open';

import { logger } from '../utils/logger.js';
import { readCookies, writeCookies } from '../http/cookieStore.js';

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
 * so it is visible immediately above the inquirer prompt regardless
 * of the active log level. Yellow + red call out the failure, cyan
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
      `The scraper is paused. Cookie file: ${cookieFilePath}`,
    ),
    '',
    chalk.cyan('Tips:'),
    chalk.cyan(
      '  * Open the target site in your browser, log in, then click the',
    ),
    chalk.cyan(
      '    Cookie-Editor extension and choose "Export" -> "JSON".',
    ),
    chalk.cyan(
      '  * Paste the exported JSON into the editor that just opened,',
    ),
    chalk.cyan('    overwriting the existing contents, then save and close.'),
    chalk.cyan(
      '  * The scraper will reload the file and retry the failed request.',
    ),
    '',
  ];
  for (const line of lines) {
    if (line === null) continue;
    process.stderr.write(`${line}\n`);
  }
}

/**
 * Make sure the cookie file exists on disk so `open()` has something
 * to launch. Creates an empty array file when the path is missing.
 *
 * @param {string} cookieFilePath Absolute path to the cookie file.
 * @returns {Promise<void>} Resolves once the file is guaranteed to
 *   exist.
 */
async function ensureCookieFileExists(cookieFilePath) {
  try {
    await fs.access(cookieFilePath);
  } catch (error) {
    if (
      error instanceof Error &&
      /** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT'
    ) {
      await writeCookies([], cookieFilePath);
      logger.info(
        'Created empty cookie file so editor has something to open',
        { cookieFilePath },
      );
      return;
    }
    throw error;
  }
}

/**
 * Launch the OS default editor on the cookie file. Failures are
 * logged but not fatal — the user can still edit the file manually
 * before pressing Enter.
 *
 * @param {string} cookieFilePath Absolute path to the cookie file.
 * @returns {Promise<void>} Resolves once the spawn has been attempted.
 */
async function launchEditor(cookieFilePath) {
  try {
    await open(cookieFilePath, { wait: false });
    process.stderr.write(
      `${chalk.cyan(
        `Opened ${cookieFilePath} in your default editor.`,
      )}\n`,
    );
  } catch (error) {
    logger.warn(
      'Failed to auto-open cookie file — please open it manually',
      {
        cookieFilePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    process.stderr.write(
      `${chalk.yellow(
        `Could not auto-open the editor. Please open ${cookieFilePath} manually.`,
      )}\n`,
    );
  }
}

/**
 * Pause the running scrape, open the `nk-cookies.json` file in the
 * user's default editor, and wait for the user to press Enter when
 * they are done editing. The freshly-saved cookies are then re-read
 * from disk and returned to the caller for the retry.
 *
 * @param {object} options Prompt options.
 * @param {string} options.cookieFilePath Absolute path of the cookie
 *   file the user will edit.
 * @param {string} [options.reason] Optional human-readable reason for
 *   the prompt (e.g. "Received HTTP 468 from nekopoi.care").
 * @returns {Promise<CookieRecord[] | null>} Reloaded cookies on
 *   success, or `null` when the user aborted, the prompt was skipped,
 *   or the file is empty/unparseable.
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
  await ensureCookieFileExists(cookieFilePath);
  await launchEditor(cookieFilePath);

  /** @type {string} */
  const answer = await input({
    message: chalk.bold.cyan(
      'Press Enter once you have saved the fresh cookies (or type "abort"):',
    ),
    default: '',
    validate: (value) => {
      const text = (value || '').trim().toLowerCase();
      if (text === '' || text === 'abort' || text === 'cancel') return true;
      return 'Press Enter to continue, or type "abort" to cancel.';
    },
  });
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === 'abort' || trimmed === 'cancel') {
    process.stderr.write(
      `${chalk.yellow(
        'Cookie refresh aborted by user — keeping existing cookie file.',
      )}\n`,
    );
    return null;
  }

  const reloaded = await readCookies(cookieFilePath);
  if (!reloaded.length) {
    process.stderr.write(
      `${chalk.red(
        `${cookieFilePath} is empty after the edit — keeping the failed-request error.`,
      )}\n`,
    );
    return null;
  }

  process.stderr.write(
    `${chalk.green(
      `Reloaded ${reloaded.length} cookie${
        reloaded.length === 1 ? '' : 's'
      } from ${cookieFilePath}. Retrying request...`,
    )}\n`,
  );
  logger.info('Reloaded fresh cookies from disk', {
    cookieFilePath,
    count: reloaded.length,
  });
  return reloaded;
}

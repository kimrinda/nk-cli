/**
 * @file Cookie-aware HTTP session manager.
 *
 * Wraps {@link getHtml} with WAF/session-expired detection: when a
 * request is rejected by the upstream WAF (HTTP 468, 403/419/429, or a
 * challenge-shaped HTML body) the user is prompted to paste a fresh
 * cookie JSON export, the cookies are persisted, the axios client is
 * rebuilt, and the original request is automatically retried.
 *
 * The retry happens at most {@link DEFAULT_MAX_REFRESH_ATTEMPTS} times.
 * Each retry is gated on the user actually supplying a new cookie set;
 * if they bail or the prompt is non-interactive the original error is
 * surfaced to the caller.
 */

import { logger } from '../utils/logger.js';
import { promptForFreshCookies } from '../prompts/cookiePrompt.js';
import {
  createHttpClient,
  getHtml,
  isSessionExpiredBody,
  isSessionExpiredStatus,
} from './client.js';
import {
  getCookieFilePath,
  readCookies,
} from './cookieStore.js';

/**
 * @typedef {import('axios').AxiosInstance} AxiosInstance
 * @typedef {import('axios').AxiosResponse} AxiosResponse
 * @typedef {import('./cookieStore.js').CookieRecord} CookieRecord
 */

/**
 * Maximum number of cookie-refresh attempts per request before giving
 * up and surfacing the failure to the caller.
 */
const DEFAULT_MAX_REFRESH_ATTEMPTS = 2;

/**
 * Live HTTP session backed by a cookie file and an axios instance.
 *
 * Methods on this class are safe to call concurrently against the same
 * underlying cookie file because cookie refreshes serialise on a
 * single in-flight prompt promise (the user only ever sees one
 * refresh prompt at a time, even if multiple requests fail in
 * parallel).
 */
export class HttpSession {
  /**
   * Construct a session backed by the supplied cookie file.
   *
   * @param {object} [options] Constructor options.
   * @param {string} [options.cookieFilePath] Override for the cookie
   *   file path. Defaults to the resolved {@link getCookieFilePath}.
   * @param {number} [options.maxRefreshAttempts] How many times the
   *   user can be re-prompted for a single failing request.
   */
  constructor(options = {}) {
    /** @type {string} */
    this.cookieFilePath = options.cookieFilePath ?? getCookieFilePath();
    /** @type {number} */
    this.maxRefreshAttempts =
      options.maxRefreshAttempts ?? DEFAULT_MAX_REFRESH_ATTEMPTS;
    /** @type {CookieRecord[]} */
    this.cookies = [];
    /** @type {AxiosInstance | null} */
    this.client = null;
    /** @type {Promise<CookieRecord[] | null> | null} */
    this.refreshInFlight = null;
  }

  /**
   * Lazy-initialise the cookie jar + axios client from disk.
   *
   * @returns {Promise<void>} Resolves once the session is usable.
   */
  async init() {
    if (this.client) return;
    this.cookies = await readCookies(this.cookieFilePath);
    this.client = createHttpClient(this.cookies);
    logger.info('HTTP session initialised', {
      cookieFilePath: this.cookieFilePath,
      cookieCount: this.cookies.length,
    });
    if (this.cookies.length === 0) {
      logger.warn(
        'No cookies loaded — first request will probably fail. Run again ' +
          'and paste a Cookie-Editor JSON export when prompted, or pre-create ' +
          `${this.cookieFilePath}.`,
      );
    }
  }

  /**
   * Replace the current cookie set in-memory and rebuild the axios
   * instance so subsequent requests pick up the new `Cookie:` header.
   *
   * @param {CookieRecord[]} cookies Fresh cookie records.
   * @returns {void}
   */
  applyCookies(cookies) {
    this.cookies = cookies;
    this.client = createHttpClient(cookies);
  }

  /**
   * Retrieve the (possibly cached) axios client. Forces lazy init so
   * callers do not need to remember to await {@link init}.
   *
   * @returns {Promise<AxiosInstance>} Active axios instance.
   */
  async getClient() {
    if (!this.client) await this.init();
    return /** @type {AxiosInstance} */ (this.client);
  }

  /**
   * Prompt the user (de-duplicated across concurrent callers) for a
   * fresh cookie export and apply it.
   *
   * @param {string} reason Human-readable reason surfaced in the prompt.
   * @returns {Promise<boolean>} True when fresh cookies were supplied
   *   and applied; false when the user aborted or the prompt was
   *   non-interactive.
   */
  async refreshCookies(reason) {
    if (!this.refreshInFlight) {
      this.refreshInFlight = promptForFreshCookies({
        cookieFilePath: this.cookieFilePath,
        reason,
      }).finally(() => {
        this.refreshInFlight = null;
      });
    }
    const next = await this.refreshInFlight;
    if (!next) return false;
    this.applyCookies(next);
    return true;
  }

  /**
   * Fetch an HTML document, automatically prompting the user to paste
   * fresh cookies and retrying on WAF/session-expired responses.
   *
   * @param {string} url Absolute URL to GET.
   * @returns {Promise<string>} Response body on success.
   * @throws {Error} When the request keeps failing after the
   *   {@link maxRefreshAttempts} budget is exhausted, or when the
   *   user declines to refresh cookies in an interactive shell.
   */
  async fetchHtml(url) {
    let attempt = 0;
    let lastReason = '';
    /* eslint-disable no-await-in-loop */
    while (attempt <= this.maxRefreshAttempts) {
      const client = await this.getClient();
      let response;
      try {
        response = await getHtml(client, url);
      } catch (error) {
        const status =
          /** @type {{response?: {status?: number}}} */ (error)?.response
            ?.status ?? 0;
        const message =
          error instanceof Error ? error.message : String(error);
        const code = /** @type {any} */ (error)?.code ?? '';
        if (status && isSessionExpiredStatus(status)) {
          lastReason = `Network error (HTTP ${status}) on ${url}: ${message}`;
        } else {
          // Re-throw with a descriptive message so retry logs are never empty.
          const detail = [
            message || '(no message)',
            code ? `code=${code}` : '',
            `url=${url}`,
          ].filter(Boolean).join(' | ');
          const wrapped = new Error(detail);
          wrapped.cause = error;
          // Preserve axios-specific properties for upstream introspection.
          if (/** @type {any} */ (error)?.response) {
            /** @type {any} */ (wrapped).response = /** @type {any} */ (error).response;
          }
          if (code) /** @type {any} */ (wrapped).code = code;
          if (/** @type {any} */ (error)?.config) {
            /** @type {any} */ (wrapped).config = /** @type {any} */ (error).config;
          }
          throw wrapped;
        }
        const refreshed = await this.refreshCookies(lastReason);
        if (!refreshed) {
          throw new Error(
            `HTTP fetch for ${url} failed and no fresh cookies were supplied: ${message}`,
          );
        }
        attempt += 1;
        continue;
      }

      if (
        isSessionExpiredStatus(response.status) ||
        (response.status >= 200 &&
          response.status < 300 &&
          isSessionExpiredBody(response.data))
      ) {
        lastReason = `Received HTTP ${response.status} from ${url} (WAF/cookie expired)`;
        logger.warn('Detected expired/blocked session, prompting for fresh cookies', {
          url,
          status: response.status,
        });
        const refreshed = await this.refreshCookies(lastReason);
        if (!refreshed) {
          throw new Error(
            `HTTP fetch for ${url} blocked by WAF (status ${response.status}) ` +
              'and no fresh cookies were supplied.',
          );
        }
        attempt += 1;
        continue;
      }

      if (response.status >= 200 && response.status < 300) {
        return /** @type {string} */ (response.data);
      }

      throw new Error(
        `HTTP fetch for ${url} failed with status ${response.status}`,
      );
    }
    /* eslint-enable no-await-in-loop */

    throw new Error(
      `HTTP fetch for ${url} kept failing after ${this.maxRefreshAttempts} ` +
        `cookie refresh attempts. Last reason: ${lastReason || 'unknown'}`,
    );
  }
}

/**
 * Convenience factory that returns an *initialised* {@link HttpSession}.
 *
 * @param {ConstructorParameters<typeof HttpSession>[0]} [options] See
 *   {@link HttpSession.constructor}.
 * @returns {Promise<HttpSession>} Initialised session.
 */
export async function createSession(options) {
  const session = new HttpSession(options);
  await session.init();
  return session;
}

/**
 * @file Axios HTTP client factory used by the CLI scraping mode.
 *
 * Builds an axios instance with the realistic browser headers and
 * cookie string the developer's reference script uses, and exposes
 * a small wrapper that handles WAF/cookie-expired retries by
 * delegating to the shared session manager.
 */

import axios from 'axios';

import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { cookiesToHeader } from './cookieStore.js';

/**
 * @typedef {import('axios').AxiosInstance} AxiosInstance
 * @typedef {import('axios').AxiosRequestConfig} AxiosRequestConfig
 * @typedef {import('axios').AxiosResponse} AxiosResponse
 * @typedef {import('./cookieStore.js').CookieRecord} CookieRecord
 */

/**
 * User-Agent used by the HTTP client. Matches the developer-supplied
 * reference snippet so the WAF treats the request as a regular Chrome
 * desktop session.
 */
const DEFAULT_HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

/**
 * Default Accept-Language used for requests (English first, Indonesian
 * second — matches the reference snippet).
 */
const DEFAULT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9,id;q=0.8';

/**
 * Headers that always accompany every HTTP-mode request.
 *
 * @param {string} cookieHeader Pre-serialised `Cookie:` header value.
 * @returns {Record<string, string>} Canonical header bundle.
 */
export function buildDefaultHeaders(cookieHeader) {
  /** @type {Record<string, string>} */
  const headers = {
    'User-Agent': process.env.NK_HTTP_USER_AGENT || DEFAULT_HTTP_USER_AGENT,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,' +
      'image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':
      process.env.NK_HTTP_ACCEPT_LANGUAGE || DEFAULT_ACCEPT_LANGUAGE,
    Referer: config.homeUrl,
    Connection: 'keep-alive',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
}

/**
 * Construct a fresh axios instance configured with the supplied
 * cookies. Callers should rebuild the instance whenever the cookie
 * jar is refreshed (cheap — just header rebinding).
 *
 * @param {CookieRecord[]} cookies Cookie records loaded from disk.
 * @returns {AxiosInstance} Configured axios instance.
 */
export function createHttpClient(cookies) {
  const cookieHeader = cookiesToHeader(cookies);
  const instance = axios.create({
    baseURL: config.baseUrl,
    timeout: 30_000,
    headers: buildDefaultHeaders(cookieHeader),
    // Treat all 2xx-4xx as resolved promises — WAF detection lives at
    // the call site so we can decide between "retry with new cookies"
    // vs "abort".
    validateStatus: () => true,
    maxRedirects: 5,
    decompress: true,
  });
  return instance;
}

/**
 * Whether the supplied response status looks like a WAF / session
 * rejection that warrants a cookie-refresh prompt and retry.
 *
 * Includes the well-documented HTTP 468 SafeLine response, the more
 * common 401/403/419 trio, and 429 (rate limit — usually fixed by a
 * fresh session token).
 *
 * @param {number} status HTTP status code.
 * @returns {boolean} True when the response is "session-expired-shaped".
 */
export function isSessionExpiredStatus(status) {
  return [401, 403, 419, 429, 468].includes(status);
}

/**
 * Inspect the response body for the common "challenge" markers used by
 * SafeLine and similar WAFs (Cloudflare's `cf-mitigated`, captcha,
 * `Just a moment...`, etc.).
 *
 * @param {string | undefined} body Response body (string only — binary
 *   responses are treated as non-WAF).
 * @returns {boolean} True when WAF markers are detected.
 */
export function isSessionExpiredBody(body) {
  if (typeof body !== 'string' || !body) return false;
  const haystack = body.slice(0, 4096).toLowerCase();
  return (
    haystack.includes('cf-mitigated') ||
    haystack.includes('just a moment') ||
    haystack.includes('attention required') ||
    haystack.includes('safeline') ||
    haystack.includes('chk_jschl') ||
    haystack.includes('captcha')
  );
}

/**
 * Issue a single GET request via the supplied axios instance, logging
 * its outcome at the appropriate level.
 *
 * Callers are expected to wrap this in {@link withSession} (defined in
 * `./session.js`) to handle WAF/session-expired retries. This helper
 * is exported for tests and for low-level scenarios that opt out of
 * the cookie-refresh flow.
 *
 * @param {AxiosInstance} client Configured axios instance.
 * @param {string} url Absolute URL to fetch.
 * @param {AxiosRequestConfig} [options] Optional request override.
 * @returns {Promise<AxiosResponse<string>>} Raw axios response with a
 *   string body (`responseType: 'text'`).
 */
export async function getHtml(client, url, options = {}) {
  logger.debug('HTTP GET', { url });
  const response = await client.get(url, {
    responseType: 'text',
    transformResponse: [(data) => (typeof data === 'string' ? data : String(data ?? ''))],
    ...options,
  });
  logger.debug('HTTP response', {
    url,
    status: response.status,
    bytes: typeof response.data === 'string' ? response.data.length : 0,
  });
  return /** @type {AxiosResponse<string>} */ (response);
}

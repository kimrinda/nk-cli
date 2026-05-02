/**
 * @file Generic exponential-backoff retry helper used across the scraper.
 *
 * Designed for idempotent operations such as page navigations and DOM
 * extractions where a transient WAF challenge might require a second try.
 */

import { logger } from './logger.js';

/**
 * Pause execution for `ms` milliseconds.
 *
 * @param {number} ms Number of milliseconds to sleep.
 * @returns {Promise<void>} Resolves after the timeout fires.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` with exponential backoff, returning the first successful result.
 *
 * @template T
 * @param {() => Promise<T>} fn The operation to execute.
 * @param {object} options Retry configuration.
 * @param {number} options.attempts Maximum number of attempts (>= 1).
 * @param {number} options.baseDelayMs Base delay; doubled each retry.
 * @param {string} [options.label] Human-readable label for log messages.
 * @returns {Promise<T>} The first successful return value of `fn`.
 * @throws {Error} The last error if all attempts fail.
 */
export async function withRetry(fn, options) {
  const { attempts, baseDelayMs, label = 'operation' } = options;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const code = /** @type {any} */ (error)?.code ?? '';
      const status = /** @type {any} */ (error)?.response?.status ?? '';
      const url = /** @type {any} */ (error)?.config?.url ?? '';
      const detail = [
        message || '(no message)',
        code ? `code=${code}` : '',
        status ? `status=${status}` : '',
        url ? `url=${url}` : '',
      ].filter(Boolean).join(' | ');
      logger.warn(`${label} failed (attempt ${attempt}/${attempts})`, {
        error: detail,
      });
      if (attempt < attempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await sleep(delay);
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after ${attempts} attempts`);
}

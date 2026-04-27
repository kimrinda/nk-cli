/**
 * @file Process-level graceful shutdown manager.
 *
 * The manager is the single chokepoint that fields every signal or
 * fatal error capable of terminating the scraper. When triggered it:
 *
 *   1. Flips a global abort flag so long-running loops stop creating
 *      new work (see {@link getAbortSignal}, {@link isShutdownInProgress}).
 *   2. Runs every registered synchronous handler (atomic JSON flushes,
 *      progress checkpoint writes) so partial results survive even an
 *      ungraceful exit.
 *   3. Awaits asynchronous cleanup handlers (e.g. closing the Puppeteer
 *      browser, persisting the progress meta file) up to a generous
 *      timeout so the process never hangs.
 *   4. Exits with a deterministic exit code derived from the originating
 *      signal.
 *
 * Re-entrancy is guarded so a handler that fails (or a second SIGINT)
 * cannot cause cleanup to run twice. A second forced signal — e.g. the
 * user mashing CTRL+C — short-circuits to an immediate `process.exit`
 * so the scraper can never become un-killable.
 */

import { logger } from './logger.js';

/**
 * Maximum total time, in milliseconds, the manager will spend running
 * async cleanup handlers before forcing exit. Keeps the process from
 * hanging on a stuck Puppeteer `browser.close()`.
 *
 * @type {number}
 */
const ASYNC_HANDLER_TIMEOUT_MS = 15_000;

/** @type {Array<() => void>} Synchronous "save now" callbacks. */
const syncHandlers = [];

/** @type {Array<(reason: string) => Promise<void> | void>} Async cleanup callbacks. */
const asyncHandlers = [];

/** @type {AbortController} Controller backing {@link getAbortSignal}. */
const abortController = new AbortController();

/** @type {boolean} Guards against double execution of the cleanup pipeline. */
let shuttingDown = false;

/** @type {boolean} Guards against duplicate listener installation. */
let installed = false;

/**
 * Register a synchronous shutdown handler.
 *
 * Synchronous handlers run first and must be allocation-light — they
 * are the only thing guaranteed to run before `process.exit()` even
 * inside `uncaughtException`.
 *
 * @param {() => void} handler Callback invoked once during shutdown.
 * @returns {void}
 */
export function onShutdown(handler) {
  syncHandlers.push(handler);
}

/**
 * Register an asynchronous shutdown handler.
 *
 * Async handlers run after every sync handler and may perform I/O
 * (closing browsers/pages, flushing meta-progress files atomically, …).
 * They share a single time budget defined by
 * {@link ASYNC_HANDLER_TIMEOUT_MS}; once exceeded the manager forces
 * exit regardless of in-flight cleanup.
 *
 * @param {(reason: string) => Promise<void> | void} handler
 *   Async callback. Receives the originating signal name.
 * @returns {void}
 */
export function onShutdownAsync(handler) {
  asyncHandlers.push(handler);
}

/**
 * Abort signal flipped the moment a shutdown begins.
 *
 * Long-running loops should poll `signal.aborted` between iterations to
 * stop creating new scraping tasks once a shutdown has been requested.
 *
 * @returns {AbortSignal} Signal that aborts on the first shutdown.
 */
export function getAbortSignal() {
  return abortController.signal;
}

/**
 * @returns {boolean} True once the shutdown pipeline has started.
 */
export function isShutdownInProgress() {
  return shuttingDown;
}

/**
 * Run every registered synchronous handler, swallowing individual errors.
 *
 * @returns {void}
 */
function flushSync() {
  for (const handler of syncHandlers) {
    try {
      handler();
    } catch (error) {
      logger.error('Sync shutdown handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Run every async handler concurrently, capped by a global timeout.
 *
 * @param {string} reason Originating signal name (forwarded to handlers).
 * @returns {Promise<void>} Resolves when handlers finish or the
 *   timeout fires (whichever comes first).
 */
async function flushAsync(reason) {
  if (asyncHandlers.length === 0) return;
  const settled = Promise.allSettled(
    asyncHandlers.map((handler) =>
      Promise.resolve()
        .then(() => handler(reason))
        .catch((error) => {
          logger.error('Async shutdown handler failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }),
    ),
  );
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      logger.warn('Async shutdown handlers timed out — forcing exit', {
        timeoutMs: ASYNC_HANDLER_TIMEOUT_MS,
      });
      resolve(undefined);
    }, ASYNC_HANDLER_TIMEOUT_MS);
    timer.unref?.();
  });
  await Promise.race([settled, timeout]);
  clearTimeout(timer);
}

/**
 * Run the full cleanup pipeline once and then exit.
 *
 * @param {string} reason Signal/error label used in logs.
 * @param {number} exitCode Final exit code.
 * @returns {Promise<void>} Resolves immediately before `process.exit`.
 */
async function performShutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;

  try {
    abortController.abort(new Error(`shutdown:${reason}`));
  } catch {
    /* AbortController.abort can throw on very old runtimes; ignore. */
  }

  logger.warn('Graceful shutdown starting', { reason, exitCode });

  flushSync();
  await flushAsync(reason);

  logger.info('Graceful shutdown complete — exiting', { reason, exitCode });
  process.exit(exitCode);
}

/**
 * Trigger a graceful shutdown from outside the signal/error path
 * (e.g. when the user picks "Cancel" at a confirmation prompt).
 *
 * @param {string} reason Human-readable cause used in logs.
 * @param {number} [exitCode] Exit code to use; defaults to `0` for
 *   user-initiated cancels.
 * @returns {Promise<void>} Resolves once cleanup finishes (the process
 *   will exit before this resolves in normal use).
 */
export async function requestShutdown(reason, exitCode = 0) {
  await performShutdown(reason, exitCode);
}

/**
 * Install signal listeners and global safety nets.
 *
 * Idempotent: subsequent calls are no-ops.
 *
 * @returns {void}
 */
export function installShutdownHooks() {
  if (installed) return;
  installed = true;

  /**
   * @typedef {object} SignalSpec
   * @property {NodeJS.Signals} name Signal name.
   * @property {number} exitCode Exit code mapped to that signal.
   */

  /** @type {SignalSpec[]} */
  const signals = [
    { name: 'SIGINT', exitCode: 130 },
    { name: 'SIGTERM', exitCode: 143 },
    { name: 'SIGHUP', exitCode: 129 },
    // Windows-only synthetic signal raised on CTRL+BREAK.
    { name: /** @type {NodeJS.Signals} */ ('SIGBREAK'), exitCode: 149 },
  ];

  for (const { name, exitCode } of signals) {
    process.on(name, () => {
      if (shuttingDown) {
        // Second forced signal: short-circuit to an immediate exit so
        // the user can always kill a stuck process.
        logger.warn(`Received ${name} during shutdown — forcing exit`, {
          exitCode,
        });
        process.exit(exitCode);
      }
      void performShutdown(name, exitCode);
    });
  }

  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (shuttingDown) {
      process.exit(1);
    }
    void performShutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
    if (shuttingDown) {
      process.exit(1);
    }
    void performShutdown('unhandledRejection', 1);
  });
}

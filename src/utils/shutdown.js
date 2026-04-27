/**
 * @file Process-level graceful shutdown registry.
 *
 * Modules register synchronous "save now" callbacks; on SIGINT/SIGTERM
 * or an uncaught exception every callback runs in registration order so
 * progress files are flushed before the process exits.
 */

import { logger } from './logger.js';

/** @type {Array<() => void>} */
const handlers = [];

/** @type {boolean} Guards against double execution. */
let installed = false;

/**
 * Register a synchronous shutdown handler.
 *
 * Handlers must be synchronous so they can run during fatal signals.
 *
 * @param {() => void} handler Callback invoked once during shutdown.
 * @returns {void}
 */
export function onShutdown(handler) {
  handlers.push(handler);
}

/**
 * Run every registered handler, swallowing individual errors.
 *
 * @returns {void}
 */
function flush() {
  for (const handler of handlers) {
    try {
      handler();
    } catch (error) {
      logger.error('Shutdown handler failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Install signal listeners that flush handlers before exiting.
 *
 * Idempotent: subsequent calls are no-ops.
 *
 * @returns {void}
 */
export function installShutdownHooks() {
  if (installed) return;
  installed = true;

  /**
   * @param {NodeJS.Signals | 'uncaughtException' | 'unhandledRejection'} signal
   *   The signal or error type that triggered shutdown.
   * @param {number} exitCode Process exit code to use after flushing.
   * @returns {void}
   */
  const finalize = (signal, exitCode) => {
    logger.warn(`Received ${signal} — flushing progress before exit`);
    flush();
    process.exit(exitCode);
  };

  process.once('SIGINT', () => finalize('SIGINT', 130));
  process.once('SIGTERM', () => finalize('SIGTERM', 143));
  process.once('uncaughtException', (error) => {
    logger.error('Uncaught exception', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    finalize('uncaughtException', 1);
  });
  process.once('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
    finalize('unhandledRejection', 1);
  });
}

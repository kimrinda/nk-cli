/**
 * @file Unit tests for the graceful shutdown manager.
 *
 * The manager normally calls `process.exit`, so we only exercise the
 * pieces that *don't* depend on installing real signal handlers:
 *
 *   * `onShutdown` / `onShutdownAsync` register handlers correctly.
 *   * `getAbortSignal()` returns a single-shot AbortSignal.
 *   * `isShutdownInProgress()` flips when `requestShutdown` is in flight.
 *
 * To avoid actually exiting the test process we monkey-patch
 * `process.exit` while a single test is running, then restore it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getAbortSignal,
  isShutdownInProgress,
  onShutdown,
  onShutdownAsync,
  requestShutdown,
} from '../src/utils/shutdown.js';

test('shutdown manager — handlers fire and signal flips on requestShutdown', async () => {
  const calls = [];
  onShutdown(() => calls.push('sync-1'));
  onShutdown(() => calls.push('sync-2'));
  onShutdownAsync(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    calls.push('async-1');
  });
  onShutdownAsync(() => calls.push('async-2'));

  const signal = getAbortSignal();
  assert.equal(signal.aborted, false);

  const realExit = process.exit;
  let exitCode = null;
  /** @type {(code?: number) => never} */
  process.exit = /** @type {any} */ ((code) => {
    exitCode = code ?? 0;
    return /** @type {never} */ (undefined);
  });

  try {
    await requestShutdown('test-cancel', 0);
  } finally {
    process.exit = realExit;
  }

  assert.equal(exitCode, 0);
  assert.equal(signal.aborted, true);
  assert.equal(isShutdownInProgress(), true);
  assert.deepEqual(calls.slice(0, 2), ['sync-1', 'sync-2']);
  assert.ok(calls.includes('async-1'), 'async-1 handler should run');
  assert.ok(calls.includes('async-2'), 'async-2 handler should run');
});

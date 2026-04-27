/**
 * @file Reusable resume/progress manager.
 *
 * Each scraper command (listing / detail / az-index) owns a tiny
 * progress-meta JSON file that captures _where_ the run was at when it
 * last touched disk:
 *
 * ```json
 * {
 *   "command": "scrape:hanime:detail",
 *   "status": "interrupted",
 *   "lastCompletedIndex": 123,
 *   "totalItems": 500,
 *   "outputFile": "/abs/path/output/hanimeDetails.json",
 *   "updatedAt": "2026-04-27T10:03:00.000Z"
 * }
 * ```
 *
 * The file is updated _after_ every successful loop iteration via the
 * atomic write helpers in `storage.js`, and a synchronous flush is
 * registered with the shutdown manager so a SIGINT/crash mid-iteration
 * still leaves a self-describing checkpoint on disk.
 *
 * The manager is intentionally agnostic about what is being scraped —
 * it just stores a monotonically-increasing `lastCompletedIndex` and
 * the originating command identifier so that `negotiateResume` can
 * validate the previous run matches the current one before offering to
 * continue.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { logger } from './logger.js';
import { onShutdown } from './shutdown.js';
import { readJson, writeJson, writeJsonSync } from './storage.js';

/**
 * Status values persisted in the progress meta file.
 *
 * @typedef {'running'|'completed'|'interrupted'|'failed'} ProgressStatus
 */

/**
 * Shape of the progress-meta JSON file.
 *
 * @typedef {object} ProgressMeta
 * @property {string} command Stable identifier of the scraping command.
 * @property {ProgressStatus} status Current status of the run.
 * @property {number} lastCompletedIndex Zero-based index of the last
 *   successfully processed loop entry; `-1` when nothing has finished yet.
 * @property {number} totalItems Total items planned for this run; `0`
 *   when the total is not yet known.
 * @property {string} outputFile Absolute path of the canonical output
 *   file the command writes to.
 * @property {string} updatedAt ISO 8601 timestamp of the last update.
 * @property {string} [error] Optional last-error message recorded by
 *   {@link ProgressManager.markFailed}.
 */

/**
 * Default progress-meta filename suffix.
 *
 * @type {string}
 */
const META_SUFFIX = '.progress.meta.json';

/**
 * Compute the standard meta-file path for a given output file.
 *
 * Example: `/abs/output/hanimeDetails.json` →
 * `/abs/output/hanimeDetails.progress.meta.json`.
 *
 * @param {string} outputFile Absolute output file path.
 * @returns {string} Absolute meta-file path.
 */
export function deriveProgressMetaPath(outputFile) {
  const ext = path.extname(outputFile);
  const stem = ext ? outputFile.slice(0, -ext.length) : outputFile;
  return `${stem}${META_SUFFIX}`;
}

/**
 * Read a progress-meta file, returning `null` when missing/unreadable.
 *
 * @param {string} metaPath Absolute meta-file path.
 * @returns {Promise<ProgressMeta | null>} Parsed meta or `null`.
 */
export async function readProgressMeta(metaPath) {
  /** @type {ProgressMeta | null} */
  const meta = await readJson(metaPath, /** @type {ProgressMeta | null} */ (null));
  return meta;
}

/**
 * Move (or, when not possible, copy + truncate) the progress meta and
 * the canonical output file into a timestamped `*.archive-<ts>.json`
 * sibling so the user can inspect previous runs.
 *
 * @param {string} filePath Absolute path of the file to archive.
 * @returns {Promise<string | null>} Path of the archive on disk, or
 *   `null` when the source did not exist.
 */
async function archiveFile(filePath) {
  try {
    await fsp.access(filePath);
  } catch {
    return null;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = path.extname(filePath);
  const stem = ext ? filePath.slice(0, -ext.length) : filePath;
  const target = `${stem}.archive-${ts}${ext || '.json'}`;
  try {
    await fsp.rename(filePath, target);
  } catch {
    // Cross-device rename failures fall back to copy+unlink.
    await fsp.copyFile(filePath, target);
    await fsp.unlink(filePath).catch(() => undefined);
  }
  logger.info('Archived previous file', { from: filePath, to: target });
  return target;
}

/**
 * Stateful helper that owns one progress-meta file for the lifetime of
 * a single scrape command. Instances are cheap; create one per scrape.
 */
export class ProgressManager {
  /**
   * @param {object} options
   * @param {string} options.command Stable identifier for the run
   *   (e.g. `scrape:hanime:detail`).
   * @param {string} options.outputFile Absolute path of the canonical
   *   output file the scrape writes to.
   * @param {string} [options.metaFile] Absolute path of the progress
   *   meta file; defaults to {@link deriveProgressMetaPath}.
   * @param {number} [options.totalItems] Optional total item count.
   */
  constructor({ command, outputFile, metaFile, totalItems = 0 }) {
    /** @type {string} */
    this.command = command;
    /** @type {string} */
    this.outputFile = outputFile;
    /** @type {string} */
    this.metaFile = metaFile ?? deriveProgressMetaPath(outputFile);
    /** @type {ProgressMeta} */
    this.state = {
      command,
      status: 'running',
      lastCompletedIndex: -1,
      totalItems,
      outputFile,
      updatedAt: new Date().toISOString(),
    };
    /** @type {boolean} */
    this.shutdownHookRegistered = false;
  }

  /**
   * Register the synchronous flush hook with the global shutdown
   * manager exactly once. Idempotent.
   *
   * @returns {void}
   */
  registerShutdownHook() {
    if (this.shutdownHookRegistered) return;
    this.shutdownHookRegistered = true;
    onShutdown(() => this.markInterruptedSync('shutdown'));
  }

  /**
   * Initialise (or reset) the meta file to a clean `running` state and
   * persist it atomically so the resume flow has something to match
   * against on a future run.
   *
   * @param {object} [overrides]
   * @param {number} [overrides.totalItems] Total item count if known.
   * @param {number} [overrides.lastCompletedIndex] Starting index
   *   (defaults to `-1`).
   * @returns {Promise<void>} Resolves once the meta is on disk.
   */
  async init(overrides = {}) {
    this.state = {
      command: this.command,
      status: 'running',
      lastCompletedIndex: overrides.lastCompletedIndex ?? -1,
      totalItems: overrides.totalItems ?? this.state.totalItems ?? 0,
      outputFile: this.outputFile,
      updatedAt: new Date().toISOString(),
    };
    this.registerShutdownHook();
    await writeJson(this.metaFile, this.state);
  }

  /**
   * Adopt a previously-loaded meta as our current state (used when the
   * user accepts the resume prompt).
   *
   * @param {ProgressMeta} meta Meta loaded from disk.
   * @returns {Promise<void>} Resolves once the running status has been
   *   re-persisted to mark the run as live again.
   */
  async adopt(meta) {
    this.state = {
      ...meta,
      command: this.command,
      outputFile: this.outputFile,
      status: 'running',
      updatedAt: new Date().toISOString(),
    };
    this.registerShutdownHook();
    await writeJson(this.metaFile, this.state);
  }

  /**
   * Persist a new `lastCompletedIndex` and (optionally) `totalItems`.
   *
   * Call this after every successful loop iteration so a sudden exit
   * leaves the meta pointing at the most recent completed item.
   *
   * @param {object} args
   * @param {number} args.lastCompletedIndex Zero-based index just finished.
   * @param {number} [args.totalItems] Total items if it became known.
   * @returns {Promise<void>} Resolves once the meta has been flushed.
   */
  async update({ lastCompletedIndex, totalItems }) {
    this.state = {
      ...this.state,
      status: 'running',
      lastCompletedIndex,
      totalItems: totalItems ?? this.state.totalItems,
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.metaFile, this.state);
  }

  /**
   * Mark the run as completed and flush atomically.
   *
   * @returns {Promise<void>} Resolves once the meta has been written.
   */
  async markCompleted() {
    this.state = {
      ...this.state,
      status: 'completed',
      updatedAt: new Date().toISOString(),
    };
    await writeJson(this.metaFile, this.state);
  }

  /**
   * Mark the run as failed (an error tore it down outside the normal
   * shutdown path) and persist atomically.
   *
   * @param {unknown} error Error encountered.
   * @returns {Promise<void>} Resolves once the meta has been written.
   */
  async markFailed(error) {
    this.state = {
      ...this.state,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString(),
    };
    try {
      await writeJson(this.metaFile, this.state);
    } catch (writeErr) {
      logger.error('Failed to flush failed progress meta', {
        error:
          writeErr instanceof Error ? writeErr.message : String(writeErr),
      });
      // Fall back to a sync write so the meta still reflects reality.
      this.markInterruptedSync('failed');
    }
  }

  /**
   * Mark the run as interrupted using a synchronous atomic write.
   *
   * Designed to run inside the shutdown manager's sync handler queue,
   * so it must avoid `await`/Promises and never throw.
   *
   * @param {string} reason Why we are interrupted (signal name, …).
   * @returns {void}
   */
  markInterruptedSync(reason) {
    try {
      this.state = {
        ...this.state,
        // Preserve a "completed" terminal status; only escalate
        // `running` → `interrupted`.
        status:
          this.state.status === 'completed' ? 'completed' : 'interrupted',
        updatedAt: new Date().toISOString(),
        error: this.state.error ?? `interrupted:${reason}`,
      };
      writeJsonSync(this.metaFile, this.state);
    } catch (error) {
      // Best-effort: there is nothing else to do this late.
      logger.error('Failed to flush progress meta during shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Delete the meta file from disk. Used after a successful clean run
   * if the caller does not want to keep a `completed` checkpoint.
   *
   * @returns {Promise<void>} Resolves once the meta is gone.
   */
  async clear() {
    try {
      await fsp.unlink(this.metaFile);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== 'ENOENT') {
        logger.warn('Failed to clear progress meta', {
          metaFile: this.metaFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Synchronous {@link clear}. Safe inside shutdown hooks.
   *
   * @returns {void}
   */
  clearSync() {
    try {
      fs.unlinkSync(this.metaFile);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== 'ENOENT') {
        logger.warn('Failed to clear progress meta (sync)', {
          metaFile: this.metaFile,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/**
 * Decision returned by {@link negotiateResume}.
 *
 * @typedef {object} ResumeDecision
 * @property {'fresh'|'resume'|'cancel'} action Resolved action.
 * @property {number} startIndex Index the loop should start from
 *   (`lastCompletedIndex + 1` when resuming, otherwise `0`).
 * @property {ProgressMeta | null} previous Previous meta on disk, when any.
 */

/**
 * Determine how a scrape should start, based on any previous progress
 * meta and the user's answers to the resume / overwrite prompts.
 *
 * Behaviour:
 *
 *   * No meta on disk, or status `completed`: returns `fresh`.
 *   * Meta whose `command` does not match the current command: prompts
 *     the user with the `confirmOverwrite` flow (only `No`/`Cancel` make
 *     sense here — `Yes` would trash a previous run's checkpoint without
 *     warning).
 *   * Meta whose `command` matches and status is unfinished: prompts
 *     with `confirmResume`. `Yes` → `resume`, `No` (after a confirmed
 *     overwrite warning) → `fresh`, `Cancel` → `cancel`.
 *
 * The two prompt callbacks default to no-ops in non-interactive
 * environments so the function is also unit-test friendly.
 *
 * @param {object} options
 * @param {string} options.command Current scrape command identifier.
 * @param {string} options.outputFile Canonical output file (for archive
 *   when the user opts to overwrite).
 * @param {string} [options.metaFile] Override meta path; defaults to
 *   {@link deriveProgressMetaPath}.
 * @param {() => Promise<'yes'|'no'|'cancel'>} options.confirmResume
 *   Tri-state Yes/No/Cancel prompt for the primary resume question.
 * @param {() => Promise<'yes'|'no'|'cancel'>} options.confirmOverwrite
 *   Tri-state Yes/No/Cancel prompt for the destructive "overwrite old
 *   data?" follow-up.
 * @returns {Promise<ResumeDecision>} Resolved decision.
 */
export async function negotiateResume(options) {
  const {
    command,
    outputFile,
    metaFile = deriveProgressMetaPath(outputFile),
    confirmResume,
    confirmOverwrite,
  } = options;

  const previous = await readProgressMeta(metaFile);

  if (!previous || previous.status === 'completed') {
    return { action: 'fresh', startIndex: 0, previous };
  }

  if (previous.command !== command) {
    logger.warn(
      'Found unfinished progress for a different command — prompting before overwrite',
      { previous: previous.command, current: command, metaFile },
    );
    const overwrite = await confirmOverwrite();
    if (overwrite === 'yes') {
      await archiveFile(metaFile);
      await archiveFile(outputFile);
      return { action: 'fresh', startIndex: 0, previous };
    }
    return { action: 'cancel', startIndex: 0, previous };
  }

  const resume = await confirmResume();
  if (resume === 'yes') {
    return {
      action: 'resume',
      startIndex: Math.max(0, (previous.lastCompletedIndex ?? -1) + 1),
      previous,
    };
  }
  if (resume === 'cancel') {
    return { action: 'cancel', startIndex: 0, previous };
  }
  // resume === 'no' — confirm destructive overwrite before starting fresh.
  const overwrite = await confirmOverwrite();
  if (overwrite === 'yes') {
    await archiveFile(metaFile);
    await archiveFile(outputFile);
    return { action: 'fresh', startIndex: 0, previous };
  }
  return { action: 'cancel', startIndex: 0, previous };
}

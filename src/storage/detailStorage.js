/**
 * @file Reusable per-prefix detail storage.
 *
 * The original detail scraper persisted every record into a single
 * monolithic JSON file (e.g. `output/hanimeDetails.json`). Past a few
 * hundred items the file grew to tens of thousands of lines and became
 * impractical to diff, edit or sync.
 *
 * This module replaces the monolith with a directory of small per-prefix
 * JSON files plus an index manifest:
 *
 * ```
 * output/details/<category>/
 *   <filenamePrefix>_A.json
 *   <filenamePrefix>_B.json
 *   <filenamePrefix>_0-9.json
 *   <filenamePrefix>_symbol-bracket-open.json
 *   <filenamePrefix>.manifest.json
 * ```
 *
 * Every write goes through `writeJson` (atomic temp+rename) so a SIGINT
 * mid-write never leaves a half-written file. The manifest is rewritten
 * after every successful upsert so the on-disk snapshot is
 * self-describing for the next resume.
 *
 * The bucket key is derived from the first code point of `record.listing.title`
 * via {@link bucketKeyForTitle}. ASCII letters bucket to their uppercase
 * counterpart; digits bucket to `0-9`; punctuation maps through a stable
 * Windows-safe alias; everything else (non-ASCII, emoji, …) falls into
 * `symbol-other`. Empty titles bucket to `symbol-empty`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../utils/logger.js';
import {
  readJson,
  writeJson,
  writeJsonSync,
} from '../utils/storage.js';

/**
 * @typedef {import('../services/detailScraper.js').DetailRecord} DetailRecord
 * @typedef {import('../config/categories.js').ResolvedCategory} ResolvedCategory
 */

/**
 * Manifest entry for a single bucket file.
 *
 * @typedef {object} ManifestGroup
 * @property {string} file Filename (no directory) of the bucket JSON.
 * @property {number} count Number of records currently in the bucket.
 */

/**
 * Index/manifest persisted alongside the per-prefix bucket files.
 *
 * @typedef {object} DetailManifest
 * @property {string} target Category key (e.g. `hanime`).
 * @property {string} filenamePrefix Common filename prefix (e.g. `hanimeDetails`).
 * @property {number} totalItems Sum of counts across every bucket.
 * @property {Record<string, ManifestGroup>} groups Bucket key → file/count.
 * @property {string} updatedAt ISO 8601 timestamp of the last write.
 */

/**
 * Map of single-character punctuation/symbol → safe filename alias.
 *
 * Aliases follow the `symbol-<noun>` convention so the resulting
 * filenames remain readable (`hanimeDetails_symbol-bracket-open.json`).
 * Every entry is verified to be safe on Windows (no reserved characters,
 * no trailing dot/space, not a reserved name like `CON`/`PRN`/`NUL`).
 *
 * @type {Readonly<Record<string, string>>}
 */
export const SYMBOL_ALIASES = Object.freeze({
  '[': 'symbol-bracket-open',
  ']': 'symbol-bracket-close',
  '(': 'symbol-paren-open',
  ')': 'symbol-paren-close',
  '{': 'symbol-brace-open',
  '}': 'symbol-brace-close',
  '<': 'symbol-angle-open',
  '>': 'symbol-angle-close',
  '#': 'symbol-hash',
  '@': 'symbol-at',
  '&': 'symbol-amp',
  '%': 'symbol-percent',
  $: 'symbol-dollar',
  '!': 'symbol-bang',
  '?': 'symbol-question',
  '*': 'symbol-asterisk',
  '+': 'symbol-plus',
  '-': 'symbol-dash',
  _: 'symbol-underscore',
  '.': 'symbol-dot',
  ',': 'symbol-comma',
  '~': 'symbol-tilde',
  '^': 'symbol-caret',
  '=': 'symbol-equal',
  ':': 'symbol-colon',
  ';': 'symbol-semicolon',
  '/': 'symbol-slash',
  '\\': 'symbol-backslash',
  '|': 'symbol-pipe',
  '"': 'symbol-quote',
  "'": 'symbol-apos',
  '`': 'symbol-backtick',
  ' ': 'symbol-space',
});

/**
 * Bucket key reserved for empty / whitespace-only titles.
 *
 * @type {string}
 */
export const BUCKET_EMPTY = 'symbol-empty';

/**
 * Bucket key reserved for first characters that fall outside ASCII /
 * the {@link SYMBOL_ALIASES} table (e.g. Japanese, Cyrillic, emoji).
 *
 * @type {string}
 */
export const BUCKET_OTHER = 'symbol-other';

/**
 * Bucket key shared by every digit `0`–`9`.
 *
 * @type {string}
 */
export const BUCKET_DIGITS = '0-9';

/**
 * Compute the bucket key for a record title.
 *
 * The bucket key doubles as the filename suffix and as the manifest
 * group key, so it is intentionally always filesystem-safe:
 *
 *   * `'A'`–`'Z'`: uppercase ASCII letter (lowercase letters are folded).
 *   * `'0-9'`: any ASCII digit.
 *   * `'symbol-…'`: punctuation / whitespace / non-printable mapped via
 *     {@link SYMBOL_ALIASES}.
 *   * `'symbol-other'`: any other character (non-ASCII, emoji, …).
 *   * `'symbol-empty'`: empty / whitespace-only title.
 *
 * Uses `codePointAt(0)` so titles starting with a surrogate-pair emoji
 * still produce a valid bucket key.
 *
 * @param {string | undefined | null} title Title to inspect.
 * @returns {string} Bucket key.
 */
export function bucketKeyForTitle(title) {
  if (typeof title !== 'string') return BUCKET_EMPTY;
  const trimmed = title.trim();
  if (!trimmed) return BUCKET_EMPTY;

  const cp = trimmed.codePointAt(0);
  if (cp === undefined) return BUCKET_EMPTY;

  // ASCII uppercase letter.
  if (cp >= 0x41 && cp <= 0x5a) return String.fromCodePoint(cp);
  // ASCII lowercase letter — fold to uppercase so 'a' and 'A' share a bucket.
  if (cp >= 0x61 && cp <= 0x7a) return String.fromCodePoint(cp - 32);
  // ASCII digit.
  if (cp >= 0x30 && cp <= 0x39) return BUCKET_DIGITS;

  const ch = String.fromCodePoint(cp);
  if (Object.prototype.hasOwnProperty.call(SYMBOL_ALIASES, ch)) {
    return SYMBOL_ALIASES[ch];
  }
  return BUCKET_OTHER;
}

/**
 * Compute the bucket key for a {@link DetailRecord}.
 *
 * Falls back to `record.slug` (capitalised) when no listing title is
 * present so single-slug scrapes still group sensibly.
 *
 * @param {DetailRecord} record Record to inspect.
 * @returns {string} Bucket key.
 */
export function bucketKeyForRecord(record) {
  const title = record?.listing?.title ?? record?.content?.title ?? '';
  if (title) return bucketKeyForTitle(title);
  // Best-effort fallback for callers that didn't populate listing.title.
  return bucketKeyForTitle(record?.slug ?? '');
}

/**
 * Build the bucket filename for a given prefix + bucket key.
 *
 * @param {string} filenamePrefix Common prefix (e.g. `hanimeDetails`).
 * @param {string} bucket Bucket key returned by {@link bucketKeyForTitle}.
 * @returns {string} Bare filename (no directory) ending in `.json`.
 */
export function bucketFileName(filenamePrefix, bucket) {
  return `${filenamePrefix}_${bucket}.json`;
}

/**
 * Resolve the manifest filename for a given prefix.
 *
 * @param {string} filenamePrefix Common prefix (e.g. `hanimeDetails`).
 * @returns {string} Bare filename (no directory) ending in `.manifest.json`.
 */
export function manifestFileName(filenamePrefix) {
  return `${filenamePrefix}.manifest.json`;
}

/**
 * In-memory mirror of the on-disk per-prefix detail store.
 *
 * Loads every bucket file lazily on {@link DetailStore.load}, exposes
 * dedup-aware lookup, and writes back the affected bucket + manifest
 * after every {@link DetailStore.upsert}.
 */
export class DetailStore {
  /**
   * @param {object} options
   * @param {string} options.category Category key (e.g. `hanime`).
   * @param {string} options.baseDir Absolute directory holding the
   *   per-prefix bucket files (e.g. `/abs/output/details/hanime`).
   * @param {string} options.filenamePrefix Common filename prefix
   *   (e.g. `hanimeDetails`).
   */
  constructor({ category, baseDir, filenamePrefix }) {
    /** @type {string} */
    this.category = category;
    /** @type {string} */
    this.baseDir = baseDir;
    /** @type {string} */
    this.filenamePrefix = filenamePrefix;
    /** @type {Map<string, Map<string, DetailRecord>>} bucket → slug → record */
    this.buckets = new Map();
    /** @type {Map<string, string>} slug → bucket */
    this.slugIndex = new Map();
    /** @type {boolean} */
    this.loaded = false;
  }

  /**
   * Absolute path of the manifest file for this store.
   *
   * @returns {string} Manifest path.
   */
  manifestPath() {
    return path.join(this.baseDir, manifestFileName(this.filenamePrefix));
  }

  /**
   * Absolute path of the bucket file for the supplied bucket key.
   *
   * @param {string} bucket Bucket key.
   * @returns {string} Bucket file path.
   */
  bucketPath(bucket) {
    return path.join(this.baseDir, bucketFileName(this.filenamePrefix, bucket));
  }

  /**
   * Discover every existing bucket file under {@link DetailStore.baseDir}
   * and return their bucket keys. Used during {@link DetailStore.load}
   * so a manifest mismatch (or absent manifest) can still rebuild
   * in-memory state directly from the bucket JSON files.
   *
   * @returns {Promise<string[]>} Array of bucket keys present on disk.
   */
  async discoverBuckets() {
    let entries;
    try {
      entries = await fsp.readdir(this.baseDir);
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === 'ENOENT') return [];
      throw error;
    }
    const prefix = `${this.filenamePrefix}_`;
    const suffix = '.json';
    /** @type {string[]} */
    const out = [];
    for (const name of entries) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      if (name === manifestFileName(this.filenamePrefix)) continue;
      const bucket = name.slice(prefix.length, name.length - suffix.length);
      if (!bucket) continue;
      out.push(bucket);
    }
    return out;
  }

  /**
   * Load every bucket file from disk into memory. Must be called before
   * any of the lookup / upsert APIs.
   *
   * If a legacy monolithic detail file is supplied via `legacyFile`,
   * its records are migrated into the new bucket layout and the legacy
   * file is renamed to `*.legacy-<ISO>.json` so subsequent runs do not
   * re-import it.
   *
   * @param {object} [options]
   * @param {string} [options.legacyFile] Absolute path of a legacy
   *   single-file dump to migrate (e.g. `output/hanimeDetails.json`).
   * @returns {Promise<void>} Resolves once the in-memory state is ready.
   */
  async load(options = {}) {
    await fsp.mkdir(this.baseDir, { recursive: true });
    this.buckets.clear();
    this.slugIndex.clear();

    const buckets = await this.discoverBuckets();
    for (const bucket of buckets) {
      // eslint-disable-next-line no-await-in-loop
      const records = /** @type {DetailRecord[]} */ (
        await readJson(this.bucketPath(bucket), [])
      );
      const map = new Map();
      for (const record of records) {
        if (!record?.slug) continue;
        map.set(record.slug, record);
        this.slugIndex.set(record.slug, bucket);
      }
      this.buckets.set(bucket, map);
    }

    if (options.legacyFile) {
      await this.absorbLegacyFile(options.legacyFile);
    }

    this.loaded = true;
    logger.info('Detail store loaded', {
      category: this.category,
      buckets: this.buckets.size,
      records: this.slugIndex.size,
      baseDir: this.baseDir,
    });
  }

  /**
   * Migrate a legacy monolithic detail JSON into the bucket layout.
   *
   * Reads `legacyFile`, runs every record through
   * {@link DetailStore.upsert}, then renames the source to
   * `*.legacy-<ISO>.json` so later runs don't re-import it.
   *
   * @param {string} legacyFile Absolute path of the legacy file.
   * @returns {Promise<void>} Resolves once migration completes.
   */
  async absorbLegacyFile(legacyFile) {
    /** @type {DetailRecord[] | null} */
    const legacy = await readJson(legacyFile, /** @type {any} */ (null));
    if (!Array.isArray(legacy) || legacy.length === 0) return;
    logger.warn('Migrating legacy single-file detail dump into split layout', {
      legacyFile,
      records: legacy.length,
    });
    for (const record of legacy) {
      // eslint-disable-next-line no-await-in-loop
      await this.upsert(record, { skipManifest: true });
    }
    await this.flushManifest();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const archived = `${legacyFile}.legacy-${ts}`;
    try {
      await fsp.rename(legacyFile, archived);
    } catch (error) {
      logger.warn('Failed to rename legacy detail file after migration', {
        legacyFile,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Whether a record for `slug` is already in the store.
   *
   * @param {string} slug Slug to look up.
   * @returns {boolean} True when the slug is present.
   */
  has(slug) {
    return this.slugIndex.has(slug);
  }

  /**
   * Look up a record by slug.
   *
   * @param {string} slug Slug to look up.
   * @returns {DetailRecord | undefined} Stored record or `undefined`.
   */
  get(slug) {
    const bucket = this.slugIndex.get(slug);
    if (!bucket) return undefined;
    return this.buckets.get(bucket)?.get(slug);
  }

  /**
   * Total number of records held by the store.
   *
   * @returns {number} Total record count.
   */
  size() {
    return this.slugIndex.size;
  }

  /**
   * Number of records held by a single bucket.
   *
   * @param {string} bucket Bucket key.
   * @returns {number} Bucket size.
   */
  bucketSize(bucket) {
    return this.buckets.get(bucket)?.size ?? 0;
  }

  /**
   * List every bucket key currently held by the store.
   *
   * @returns {string[]} Array of bucket keys.
   */
  bucketKeys() {
    return [...this.buckets.keys()];
  }

  /**
   * Insert (or replace) a record. Atomically rewrites the affected
   * bucket file and (unless `skipManifest` is true) the manifest so the
   * next read sees a consistent snapshot.
   *
   * If the record's bucket key changed since a previous upsert (e.g.
   * the listing title was corrected), the stale bucket is rewritten
   * too.
   *
   * @param {DetailRecord} record Record to upsert.
   * @param {object} [options]
   * @param {boolean} [options.skipManifest] When true, the manifest is
   *   not flushed (caller is expected to call {@link DetailStore.flushManifest}
   *   later — useful for batch migrations).
   * @returns {Promise<{ bucket: string, previousBucket?: string }>}
   *   Bucket the record now lives in (and the previous one when moved).
   */
  async upsert(record, options = {}) {
    if (!record?.slug) {
      throw new Error('DetailStore.upsert: record.slug is required');
    }
    const bucket = bucketKeyForRecord(record);
    const previousBucket = this.slugIndex.get(record.slug);

    if (previousBucket && previousBucket !== bucket) {
      const prev = this.buckets.get(previousBucket);
      prev?.delete(record.slug);
      if (prev && prev.size === 0) {
        this.buckets.delete(previousBucket);
      }
    }

    let target = this.buckets.get(bucket);
    if (!target) {
      target = new Map();
      this.buckets.set(bucket, target);
    }
    target.set(record.slug, record);
    this.slugIndex.set(record.slug, bucket);

    await this.flushBucket(bucket);
    if (previousBucket && previousBucket !== bucket) {
      await this.flushBucket(previousBucket);
    }
    if (!options.skipManifest) {
      await this.flushManifest();
    }
    return previousBucket && previousBucket !== bucket
      ? { bucket, previousBucket }
      : { bucket };
  }

  /**
   * Synchronous emergency flush. Designed for the shutdown manager's
   * sync handler queue — never throws, always best-effort.
   *
   * Writes every dirty bucket and the manifest in lockstep using the
   * sync atomic helpers.
   *
   * @returns {void}
   */
  flushAllSync() {
    if (!this.loaded) return;
    try {
      for (const bucket of this.buckets.keys()) {
        const records = [...(this.buckets.get(bucket)?.values() ?? [])];
        writeJsonSync(this.bucketPath(bucket), records);
      }
      writeJsonSync(this.manifestPath(), this.buildManifest());
    } catch (error) {
      logger.error('DetailStore.flushAllSync failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Atomically write a single bucket file from in-memory state.
   *
   * @param {string} bucket Bucket key to flush.
   * @returns {Promise<void>} Resolves once the rename completes.
   */
  async flushBucket(bucket) {
    const map = this.buckets.get(bucket);
    if (!map || map.size === 0) {
      // Bucket was emptied by a move — remove the file so manifests
      // never list a stale bucket.
      try {
        await fsp.unlink(this.bucketPath(bucket));
      } catch (error) {
        const code = /** @type {NodeJS.ErrnoException} */ (error).code;
        if (code !== 'ENOENT') {
          logger.warn('Failed to drop empty bucket file', {
            bucket,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.buckets.delete(bucket);
      return;
    }
    await writeJson(this.bucketPath(bucket), [...map.values()]);
  }

  /**
   * Atomically rewrite the manifest from in-memory state.
   *
   * @returns {Promise<void>} Resolves once the rename completes.
   */
  async flushManifest() {
    await writeJson(this.manifestPath(), this.buildManifest());
  }

  /**
   * Build the manifest payload from in-memory state.
   *
   * @returns {DetailManifest} Fresh manifest snapshot.
   */
  buildManifest() {
    /** @type {Record<string, ManifestGroup>} */
    const groups = {};
    let totalItems = 0;
    const sortedBuckets = [...this.buckets.keys()].sort();
    for (const bucket of sortedBuckets) {
      const map = this.buckets.get(bucket);
      const count = map?.size ?? 0;
      if (count === 0) continue;
      groups[bucket] = {
        file: bucketFileName(this.filenamePrefix, bucket),
        count,
      };
      totalItems += count;
    }
    return {
      target: this.category,
      filenamePrefix: this.filenamePrefix,
      totalItems,
      groups,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Flatten every bucket into a single array. Order is bucket-key
   * sorted, then insertion order within each bucket.
   *
   * @returns {DetailRecord[]} Combined records across all buckets.
   */
  flattenAll() {
    /** @type {DetailRecord[]} */
    const out = [];
    const sortedBuckets = [...this.buckets.keys()].sort();
    for (const bucket of sortedBuckets) {
      const map = this.buckets.get(bucket);
      if (!map) continue;
      for (const record of map.values()) out.push(record);
    }
    return out;
  }
}

/**
 * Construct a {@link DetailStore} for the supplied category, applying
 * the standard `<output>/details/<category>/` layout convention and
 * the category's `detailFilenamePrefix` (or a sensible default).
 *
 * @param {ResolvedCategory} category Resolved category descriptor.
 * @returns {DetailStore} Newly-constructed store (still needs `.load()`).
 */
export function createDetailStoreForCategory(category) {
  if (!category.detailDir || !category.detailFilenamePrefix) {
    throw new Error(
      `Category "${category.key}" has no detail-storage config; ` +
        'add detailDir + detailFilenamePrefix in src/config/categories.js.',
    );
  }
  return new DetailStore({
    category: category.key,
    baseDir: category.detailDir,
    filenamePrefix: category.detailFilenamePrefix,
  });
}

/**
 * Read every record currently saved on disk for the given category by
 * walking the manifest (or, when missing, the bucket files directly).
 *
 * Useful for downstream consumers (UI generators, tests, exports) that
 * need a single flat view of the split storage.
 *
 * @param {ResolvedCategory} category Resolved category descriptor.
 * @returns {Promise<DetailRecord[]>} Combined records (possibly empty).
 */
export async function loadAllDetailsForCategory(category) {
  const store = createDetailStoreForCategory(category);
  await store.load();
  return store.flattenAll();
}

/**
 * Best-effort sync variant of {@link loadAllDetailsForCategory}. Reads
 * the manifest synchronously and concatenates each referenced bucket.
 * Intended for diagnostic tooling — production code paths should
 * prefer the async variant.
 *
 * @param {ResolvedCategory} category Resolved category descriptor.
 * @returns {DetailRecord[]} Combined records (empty when nothing on disk).
 */
export function loadAllDetailsForCategorySync(category) {
  if (!category.detailDir || !category.detailFilenamePrefix) return [];
  const manifestPath = path.join(
    category.detailDir,
    manifestFileName(category.detailFilenamePrefix),
  );
  /** @type {DetailManifest | null} */
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return [];
  }
  /** @type {DetailRecord[]} */
  const out = [];
  for (const bucket of Object.keys(manifest?.groups ?? {})) {
    const file = path.join(
      category.detailDir,
      manifest.groups[bucket]?.file ?? '',
    );
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
    } catch {
      // Skip unreadable buckets — best-effort diagnostic helper.
    }
  }
  return out;
}

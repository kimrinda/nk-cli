/**
 * @file Unit tests for the per-prefix detail storage manager.
 *
 * Exercises {@link bucketKeyForTitle}, {@link DetailStore} CRUD,
 * legacy-file migration, manifest contents, and the sync emergency
 * flush path used by the shutdown manager.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BUCKET_DIGITS,
  BUCKET_EMPTY,
  BUCKET_OTHER,
  DetailStore,
  SYMBOL_ALIASES,
  bucketFileName,
  bucketKeyForRecord,
  bucketKeyForTitle,
  manifestFileName,
} from '../src/storage/detailStorage.js';

/**
 * Allocate a fresh temp directory that is wiped at end of test.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @returns {Promise<string>} Absolute directory path.
 */
async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nk-cli-detailstore-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Build a minimal {@link DetailRecord}-shaped object for a slug+title.
 *
 * @param {string} slug Record slug.
 * @param {string} title Listing title (drives bucket).
 * @returns {object} Record fixture.
 */
function fixture(slug, title) {
  return {
    slug,
    url: `https://example.test/${slug}`,
    category: 'hanime',
    listing: { slug, title, thumbnail: '', url: '' },
    content: { title, genre: [], synopsis: '' },
    player: { servers: [] },
    downloads: [],
    scrapedAt: '2026-04-27T00:00:00.000Z',
  };
}

test('bucketKeyForTitle — letters fold to uppercase', () => {
  assert.equal(bucketKeyForTitle('Akiba Kei Kanojo'), 'A');
  assert.equal(bucketKeyForTitle('bible black'), 'B');
  assert.equal(bucketKeyForTitle('  zigzag'), 'Z');
});

test('bucketKeyForTitle — digits collapse into the 0-9 bucket', () => {
  assert.equal(bucketKeyForTitle('3D Animation Example'), BUCKET_DIGITS);
  assert.equal(bucketKeyForTitle('007 Special'), BUCKET_DIGITS);
  assert.equal(bucketKeyForTitle('9 Lives'), BUCKET_DIGITS);
});

test('bucketKeyForTitle — punctuation maps to symbol- aliases', () => {
  assert.equal(bucketKeyForTitle('[UNCENSORED] Foo'), 'symbol-bracket-open');
  assert.equal(bucketKeyForTitle('#Hashtag Show'), 'symbol-hash');
  assert.equal(bucketKeyForTitle('(Limited) Bar'), 'symbol-paren-open');
  assert.equal(bucketKeyForTitle('!Bang'), 'symbol-bang');
  assert.equal(bucketKeyForTitle('?Mystery'), 'symbol-question');
});

test('bucketKeyForTitle — empty / whitespace-only titles', () => {
  assert.equal(bucketKeyForTitle(''), BUCKET_EMPTY);
  assert.equal(bucketKeyForTitle('   '), BUCKET_EMPTY);
  assert.equal(bucketKeyForTitle(undefined), BUCKET_EMPTY);
  assert.equal(bucketKeyForTitle(null), BUCKET_EMPTY);
});

test('bucketKeyForTitle — non-ASCII falls into symbol-other', () => {
  assert.equal(bucketKeyForTitle('日本語タイトル'), BUCKET_OTHER);
  assert.equal(bucketKeyForTitle('Привет мир'), BUCKET_OTHER);
  // Surrogate-pair emoji must not blow up.
  assert.equal(bucketKeyForTitle('🍣 Sushi Time'), BUCKET_OTHER);
});

test('SYMBOL_ALIASES are all Windows-safe filename fragments', () => {
  // Reserved Windows filename characters: \ / : * ? " < > |
  // Aliases must contain none of them and must not be reserved names.
  const reservedChars = /[\\/:*?"<>|\u0000-\u001f]/;
  const reservedBaseNames = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ]);
  for (const alias of Object.values(SYMBOL_ALIASES)) {
    assert.doesNotMatch(alias, reservedChars, `alias ${alias} has a reserved char`);
    assert.notEqual(alias.at(-1), ' ', `alias ${alias} ends in a space`);
    assert.notEqual(alias.at(-1), '.', `alias ${alias} ends in a dot`);
    assert.equal(
      reservedBaseNames.has(alias.toUpperCase()),
      false,
      `alias ${alias} collides with a reserved Windows name`,
    );
  }
});

test('bucketFileName / manifestFileName produce expected names', () => {
  assert.equal(bucketFileName('hanimeDetails', 'A'), 'hanimeDetails_A.json');
  assert.equal(
    bucketFileName('hanimeDetails', 'symbol-bracket-open'),
    'hanimeDetails_symbol-bracket-open.json',
  );
  assert.equal(
    manifestFileName('hanimeDetails'),
    'hanimeDetails.manifest.json',
  );
});

test('DetailStore — upsert writes bucket file + manifest', async (t) => {
  const dir = await tempDir(t);
  const store = new DetailStore({
    category: 'hanime',
    baseDir: dir,
    filenamePrefix: 'hanimeDetails',
  });
  await store.load();

  await store.upsert(fixture('akari', 'Akari Adventure'));
  await store.upsert(fixture('beta', 'Beta Chronicles'));
  await store.upsert(fixture('three-d', '3D Wonder'));
  await store.upsert(fixture('uncensored', '[UNCENSORED] Wild'));

  const manifestRaw = await readFile(
    path.join(dir, 'hanimeDetails.manifest.json'),
    'utf8',
  );
  const manifest = JSON.parse(manifestRaw);
  assert.equal(manifest.target, 'hanime');
  assert.equal(manifest.filenamePrefix, 'hanimeDetails');
  assert.equal(manifest.totalItems, 4);
  assert.deepEqual(Object.keys(manifest.groups).sort(), [
    '0-9',
    'A',
    'B',
    'symbol-bracket-open',
  ]);
  assert.equal(manifest.groups.A.count, 1);
  assert.equal(manifest.groups['0-9'].file, 'hanimeDetails_0-9.json');
  assert.equal(
    manifest.groups['symbol-bracket-open'].file,
    'hanimeDetails_symbol-bracket-open.json',
  );

  const aBucket = JSON.parse(
    await readFile(path.join(dir, 'hanimeDetails_A.json'), 'utf8'),
  );
  assert.equal(aBucket.length, 1);
  assert.equal(aBucket[0].slug, 'akari');
});

test('DetailStore — second load picks every bucket back up', async (t) => {
  const dir = await tempDir(t);
  const store1 = new DetailStore({
    category: 'hanime',
    baseDir: dir,
    filenamePrefix: 'hanimeDetails',
  });
  await store1.load();
  await store1.upsert(fixture('alpha', 'Alpha'));
  await store1.upsert(fixture('beta', 'Beta'));

  const store2 = new DetailStore({
    category: 'hanime',
    baseDir: dir,
    filenamePrefix: 'hanimeDetails',
  });
  await store2.load();
  assert.equal(store2.size(), 2);
  assert.equal(store2.has('alpha'), true);
  assert.equal(store2.has('beta'), true);
  assert.equal(store2.get('alpha').listing.title, 'Alpha');
});

test('DetailStore — re-upserting the same slug does not duplicate', async (t) => {
  const dir = await tempDir(t);
  const store = new DetailStore({
    category: 'hanime',
    baseDir: dir,
    filenamePrefix: 'hanimeDetails',
  });
  await store.load();
  await store.upsert(fixture('alpha', 'Alpha'));
  await store.upsert(fixture('alpha', 'Alpha'));
  await store.upsert(fixture('alpha', 'Alpha v2'));

  assert.equal(store.size(), 1);
  // Title changed but stayed in 'A' — no bucket move expected.
  const aBucket = JSON.parse(
    await readFile(path.join(dir, 'hanimeDetails_A.json'), 'utf8'),
  );
  assert.equal(aBucket.length, 1);
  assert.equal(aBucket[0].listing.title, 'Alpha v2');
});

test('DetailStore — bucket move rewrites both files', async (t) => {
  const dir = await tempDir(t);
  const store = new DetailStore({
    category: 'hanime',
    baseDir: dir,
    filenamePrefix: 'hanimeDetails',
  });
  await store.load();
  await store.upsert(fixture('alpha', 'Alpha'));
  await store.upsert(fixture('alpha', 'Beta-renamed Alpha'));

  // Bucket A should no longer exist on disk.
  await assert.rejects(
    readFile(path.join(dir, 'hanimeDetails_A.json'), 'utf8'),
  );
  const bBucket = JSON.parse(
    await readFile(path.join(dir, 'hanimeDetails_B.json'), 'utf8'),
  );
  assert.equal(bBucket.length, 1);
  assert.equal(bBucket[0].slug, 'alpha');

  const manifest = JSON.parse(
    await readFile(path.join(dir, 'hanimeDetails.manifest.json'), 'utf8'),
  );
  assert.equal(manifest.groups.A, undefined);
  assert.equal(manifest.groups.B.count, 1);
});

test('DetailStore — flushAllSync writes everything and survives twice', async (t) => {
  const dir = await tempDir(t);
  const store = new DetailStore({
    category: 'hanime',
    baseDir: dir,
    filenamePrefix: 'hanimeDetails',
  });
  await store.load();
  await store.upsert(fixture('alpha', 'Alpha'));
  await store.upsert(fixture('beta', 'Beta'));

  // Sanity: another flush from the same in-memory state should be a no-op
  // (idempotent atomic writes).
  store.flushAllSync();
  store.flushAllSync();

  const aBucket = JSON.parse(
    await readFile(path.join(dir, 'hanimeDetails_A.json'), 'utf8'),
  );
  const bBucket = JSON.parse(
    await readFile(path.join(dir, 'hanimeDetails_B.json'), 'utf8'),
  );
  assert.equal(aBucket.length, 1);
  assert.equal(bBucket.length, 1);
});

test(
  'DetailStore — absorbLegacyFile migrates old monolith and renames it',
  async (t) => {
    const dir = await tempDir(t);
    const legacyFile = path.join(dir, '..', 'hanimeDetails.legacy-input.json');
    await writeFile(
      legacyFile,
      JSON.stringify([
        fixture('alpha', 'Alpha'),
        fixture('beta', 'Beta'),
        fixture('three', '3D Wonder'),
      ]),
      'utf8',
    );

    const store = new DetailStore({
      category: 'hanime',
      baseDir: dir,
      filenamePrefix: 'hanimeDetails',
    });
    await store.load({ legacyFile });

    assert.equal(store.size(), 3);
    // Original file should have been renamed away.
    await assert.rejects(readFile(legacyFile, 'utf8'));
  },
);

test('bucketKeyForRecord — falls back to slug when listing.title is empty', () => {
  const record = fixture('AlphaSlug', '');
  assert.equal(bucketKeyForRecord(record), 'A');
});

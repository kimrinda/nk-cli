/**
 * @file Unit tests for the resume/progress manager.
 *
 * Exercises {@link ProgressManager} and {@link negotiateResume} against
 * a temp-dir output file so the real `output/` is never touched.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ProgressManager,
  deriveProgressMetaPath,
  negotiateResume,
  readProgressMeta,
} from '../src/utils/progressManager.js';

/**
 * Create a temp directory whose contents are wiped at the end of the test.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @returns {Promise<string>} Absolute path of the directory.
 */
async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nk-cli-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('deriveProgressMetaPath replaces the JSON suffix', () => {
  assert.equal(
    deriveProgressMetaPath('/abs/output/hanimeDetails.json'),
    '/abs/output/hanimeDetails.progress.meta.json',
  );
  assert.equal(
    deriveProgressMetaPath('/abs/output/no-extension'),
    '/abs/output/no-extension.progress.meta.json',
  );
});

test('ProgressManager — init / update / completed roundtrip', async (t) => {
  const dir = await tempDir(t);
  const outputFile = path.join(dir, 'detail.json');
  const pm = new ProgressManager({
    command: 'scrape:hanime:detail',
    outputFile,
    totalItems: 10,
  });

  await pm.init({ totalItems: 10 });
  let meta = JSON.parse(await readFile(pm.metaFile, 'utf8'));
  assert.equal(meta.status, 'running');
  assert.equal(meta.lastCompletedIndex, -1);
  assert.equal(meta.totalItems, 10);
  assert.equal(meta.command, 'scrape:hanime:detail');
  assert.equal(meta.outputFile, outputFile);

  await pm.update({ lastCompletedIndex: 3, totalItems: 10 });
  meta = JSON.parse(await readFile(pm.metaFile, 'utf8'));
  assert.equal(meta.lastCompletedIndex, 3);
  assert.equal(meta.status, 'running');

  await pm.markCompleted();
  meta = JSON.parse(await readFile(pm.metaFile, 'utf8'));
  assert.equal(meta.status, 'completed');
});

test('ProgressManager — markInterruptedSync survives crashy state', async (t) => {
  const dir = await tempDir(t);
  const outputFile = path.join(dir, 'detail.json');
  const pm = new ProgressManager({
    command: 'scrape:hanime:detail',
    outputFile,
  });
  await pm.init();
  await pm.update({ lastCompletedIndex: 7 });
  pm.markInterruptedSync('SIGINT');

  const meta = JSON.parse(await readFile(pm.metaFile, 'utf8'));
  assert.equal(meta.status, 'interrupted');
  assert.equal(meta.lastCompletedIndex, 7);
  assert.match(meta.error, /SIGINT/);
});

test('ProgressManager — clear removes the meta file', async (t) => {
  const dir = await tempDir(t);
  const outputFile = path.join(dir, 'detail.json');
  const pm = new ProgressManager({
    command: 'scrape:hanime:detail',
    outputFile,
  });
  await pm.init();
  await stat(pm.metaFile);
  await pm.clear();
  await assert.rejects(stat(pm.metaFile));
});

test('negotiateResume — fresh when no meta exists', async (t) => {
  const dir = await tempDir(t);
  const outputFile = path.join(dir, 'detail.json');

  const decision = await negotiateResume({
    command: 'scrape:hanime:detail',
    outputFile,
    confirmResume: async () => 'yes',
    confirmOverwrite: async () => 'yes',
  });
  assert.equal(decision.action, 'fresh');
  assert.equal(decision.startIndex, 0);
  assert.equal(decision.previous, null);
});

test(
  'negotiateResume — resume returns lastCompletedIndex + 1 on Yes',
  async (t) => {
    const dir = await tempDir(t);
    const outputFile = path.join(dir, 'detail.json');
    const pm = new ProgressManager({
      command: 'scrape:hanime:detail',
      outputFile,
    });
    await pm.init();
    await pm.update({ lastCompletedIndex: 123, totalItems: 500 });
    pm.markInterruptedSync('SIGINT');

    const decision = await negotiateResume({
      command: 'scrape:hanime:detail',
      outputFile,
      confirmResume: async () => 'yes',
      confirmOverwrite: async () => {
        throw new Error('overwrite must not be asked when resuming');
      },
    });

    assert.equal(decision.action, 'resume');
    assert.equal(decision.startIndex, 124);
    assert.equal(decision.previous?.lastCompletedIndex, 123);
  },
);

test(
  'negotiateResume — No + confirmed overwrite archives previous data',
  async (t) => {
    const dir = await tempDir(t);
    const outputFile = path.join(dir, 'detail.json');
    const pm = new ProgressManager({
      command: 'scrape:hanime:detail',
      outputFile,
    });
    await pm.init();
    await pm.update({ lastCompletedIndex: 50, totalItems: 100 });
    pm.markInterruptedSync('SIGINT');
    // Drop a fake output file so the archive path is exercised too.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outputFile, '[]');

    const decision = await negotiateResume({
      command: 'scrape:hanime:detail',
      outputFile,
      confirmResume: async () => 'no',
      confirmOverwrite: async () => 'yes',
    });

    assert.equal(decision.action, 'fresh');
    assert.equal(decision.startIndex, 0);
    // The original meta + output should have been moved to .archive-*.
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    const archived = entries.filter((name) => name.includes('.archive-'));
    assert.ok(archived.length >= 2, 'expected at least two archived files');
  },
);

test(
  'negotiateResume — Cancel preserves files and signals cancel',
  async (t) => {
    const dir = await tempDir(t);
    const outputFile = path.join(dir, 'detail.json');
    const pm = new ProgressManager({
      command: 'scrape:hanime:detail',
      outputFile,
    });
    await pm.init();
    await pm.update({ lastCompletedIndex: 9, totalItems: 50 });
    pm.markInterruptedSync('SIGINT');

    const decision = await negotiateResume({
      command: 'scrape:hanime:detail',
      outputFile,
      confirmResume: async () => 'cancel',
      confirmOverwrite: async () => {
        throw new Error('overwrite must not be asked on cancel');
      },
    });

    assert.equal(decision.action, 'cancel');
    const meta = await readProgressMeta(pm.metaFile);
    assert.equal(meta?.lastCompletedIndex, 9);
    assert.equal(meta?.status, 'interrupted');
  },
);

test(
  'negotiateResume — mismatching command prompts overwrite, not resume',
  async (t) => {
    const dir = await tempDir(t);
    const outputFile = path.join(dir, 'detail.json');
    const pm = new ProgressManager({
      command: 'scrape:other:detail',
      outputFile,
    });
    await pm.init();
    await pm.update({ lastCompletedIndex: 1 });
    pm.markInterruptedSync('SIGINT');

    let resumeAsked = false;
    const decision = await negotiateResume({
      command: 'scrape:hanime:detail',
      outputFile,
      confirmResume: async () => {
        resumeAsked = true;
        return 'yes';
      },
      confirmOverwrite: async () => 'no',
    });

    assert.equal(decision.action, 'cancel');
    assert.equal(resumeAsked, false, 'resume prompt should be skipped');
  },
);

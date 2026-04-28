/**
 * @file Tests for the argparse-based CLI parser.
 *
 * Exercises the new flag-style entry points (`--scrape`, `--method`,
 * `--slug`, `--page`, `--category`) and asserts that they produce the
 * correct {@link CliAction} object.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../src/cli/parser.js';

/**
 * Build a fake argv array for parser exercise.
 *
 * @param {string[]} flags Flags + positional values to append after node/main.
 * @returns {string[]} Full argv-shaped array.
 */
function argv(flags) {
  return ['node', 'main.js', ...flags];
}

test('cli parser — listing target with explicit method', async () => {
  const action = await parseArgs(
    argv(['--scrape', 'hanime', '--method', 'cli']),
  );
  assert.deepEqual(action, {
    type: 'listing',
    categoryKey: 'hanime',
    method: 'cli',
  });
});

test('cli parser — defaults --method to "browser"', async () => {
  const action = await parseArgs(argv(['--scrape', '2d-animation']));
  assert.equal(action.type, 'listing');
  assert.equal(action.method, 'browser');
});

test('cli parser — azIndex target', async () => {
  const action = await parseArgs(
    argv(['--scrape', 'hanimeindex', '--method', 'browser']),
  );
  assert.deepEqual(action, {
    type: 'azIndex',
    categoryKey: 'hanimeindex',
    method: 'browser',
  });
});

test('cli parser — detailBySlug via <key>info', async () => {
  const action = await parseArgs(
    argv([
      '--scrape',
      'hanimeinfo',
      '--slug',
      'my-slug',
      '--method',
      'cli',
    ]),
  );
  assert.deepEqual(action, {
    type: 'detailBySlug',
    categoryKey: 'hanime',
    slug: 'my-slug',
    method: 'cli',
  });
});

test('cli parser — detailByPage via generic info + --page', async () => {
  const action = await parseArgs(
    argv([
      '--scrape',
      'info',
      '--page',
      'hanime',
      '--method',
      'cli',
    ]),
  );
  assert.deepEqual(action, {
    type: 'detailByPage',
    categoryKey: 'hanime',
    method: 'cli',
  });
});

test('cli parser — detailBySlug via generic info + --category + --slug', async () => {
  const action = await parseArgs(
    argv([
      '--scrape',
      'info',
      '--category',
      '2d-animation',
      '--slug',
      'foo-bar',
      '--method',
      'browser',
    ]),
  );
  assert.deepEqual(action, {
    type: 'detailBySlug',
    categoryKey: '2d-animation',
    slug: 'foo-bar',
    method: 'browser',
  });
});

test('cli parser — rejects --slug + --page combination', async () => {
  await assert.rejects(
    () =>
      parseArgs(
        argv([
          '--scrape',
          'hanimeinfo',
          '--slug',
          's',
          '--page',
          'hanime',
        ]),
      ),
    /mutually exclusive/i,
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main, parseArgs } from '../src/cli.js';

/**
 * Exit codes, because they are an interface: a release job runs
 * `octoform --help` as a smoke test, and anything that shells out checks them.
 * A wrong one is invisible until something downstream refuses to continue —
 * which is exactly how the `--help` case below was found, in a release.
 *
 * Every case here returns before the CLI loads a configuration or builds an
 * API client, so none of them touch the disk or the network.
 */
async function exitCode(argv: string[]): Promise<number> {
  const log = console.log;
  console.log = () => {};
  try {
    return await main(argv);
  } finally {
    console.log = log;
  }
}

test('asking for help succeeds', async () => {
  assert.equal(await exitCode(['--help']), 0);
  assert.equal(await exitCode(['-h']), 0);
});

test('asking for help about a command also succeeds', async () => {
  assert.equal(await exitCode(['plan', '--help']), 0);
});

test('no command at all is a usage error, even though it prints the same text', async () => {
  assert.equal(await exitCode([]), 2);
});

test('an unknown option is a usage error', async () => {
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(await exitCode(['--nonsense']), 2);
  } finally {
    console.error = error;
  }
});

test('an option that needs a value and does not get one is rejected', () => {
  assert.throws(() => parseArgs(['plan', '--config']), /--config needs a value/);
});

test('the first bare word is the command and the second is its subcommand', () => {
  const args = parseArgs(['properties', 'sync']);
  assert.equal(args.command, 'properties');
  assert.equal(args.subcommand, 'sync');
});

test('a third bare word has nowhere to go and is rejected', () => {
  assert.throws(() => parseArgs(['properties', 'sync', 'extra']), /Unexpected argument/);
});

test('--strict is accepted and defaults to off', () => {
  assert.equal(parseArgs(['plan']).strict, false);
  assert.equal(parseArgs(['plan', '--strict']).strict, true);
});

test('--owner is repeatable and defaults to an empty selection', () => {
  assert.deepEqual(parseArgs(['plan']).owners, []);
  assert.deepEqual(parseArgs(['plan', '--owner', 'a', '--owner', 'b']).owners, ['a', 'b']);
});

test('--write is accepted and defaults to off', () => {
  assert.equal(parseArgs(['config', 'migrate']).write, false);
  assert.equal(parseArgs(['config', 'migrate', '--write']).write, true);
});

test('config validate needs a subcommand', async () => {
  const error = console.error;
  console.error = () => {};
  try {
    assert.equal(await exitCode(['config']), 2);
    assert.equal(await exitCode(['config', 'nonsense']), 2);
  } finally {
    console.error = error;
  }
});

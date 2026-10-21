// The removal prompt shared by `aperas ingest` and `aperas track`: with --no-prompt it answers no and never reads
// stdin; without it, a closed stdin counts as no and a piped `yes` counts as yes. Both CLI entry points are wired
// to the helper and to the flag, checked on their source and help text since their `main` needs the service.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmRemoval } from '../../removalPrompt.ts';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString(); });
  return { input, output, written: () => written };
}

describe('removal prompt', () => {
  test('--no-prompt answers no without reading stdin, even when a yes is waiting on it', async () => {
    const { input, output, written } = streams();
    input.write('yes\n');
    const answer = await confirmRemoval({ noPrompt: true, input, output });
    assert.equal(answer, false);
    assert.equal(input.readableFlowing, null, 'nothing started reading the input');
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.listenerCount('readable'), 0);
    assert.equal(input.readableLength, 4, 'the waiting bytes are still unread');
    assert.equal(written(), '', 'no question was asked');
    input.destroy();
  });

  test('without the flag, a closed stdin counts as no', async () => {
    const { input, output, written } = streams();
    input.end();
    const answer = await confirmRemoval({ input, output });
    assert.equal(answer, false);
    assert.match(written(), /Are you sure you want to remove these\? \[yes\/NO\]/);
  });

  test('without the flag, a piped yes counts as yes and anything else as no', async () => {
    for (const [line, expected] of [['yes\n', true], ['y\n', true], ['YES\n', true], ['no\n', false], ['\n', false], ['maybe\n', false]] as const) {
      const { input, output } = streams();
      input.end(line);
      assert.equal(await confirmRemoval({ input, output }), expected, JSON.stringify(line));
    }
  });

  test('ingest and track both take --no-prompt: parsed, kept out of the paths, passed to the helper, and in the help', () => {
    for (const file of ['kgIngest.ts', 'kgTrack.ts']) {
      const source = readFileSync(join(srcDir, file), 'utf-8');
      assert.match(source, /rawArgs\.includes\('--no-prompt'\)/, `${file} reads the flag`);
      assert.match(source, /p !== '--no-prompt'/, `${file} keeps the flag out of the paths`);
      assert.match(source, /confirmRemoval\(\{ noPrompt/, `${file} passes the flag to the helper`);
      assert.match(source, /name: '--no-prompt'/, `${file} documents the flag in its help`);
      assert.doesNotMatch(source, /createInterface/, `${file} no longer opens readline itself`);
    }
  });

  test('project keeps its own prompt', () => {
    for (const file of ['kgProject.ts']) {
      assert.doesNotMatch(readFileSync(join(srcDir, file), 'utf-8'), /--no-prompt/, `${file} is unchanged`);
    }
  });
});

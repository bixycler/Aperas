// A request that arrives in more than one chunk is decoded whole by the service (`service.ts#handleConnection`): a character of 2 or 3 bytes that falls on the boundary between two chunks
// is stored as itself, not as U+FFFD for each half. The request is raw UTF-8 (`encodeMessage` is a plain `JSON.stringify`), so the text of an `update` is written to the graph as the service
// decoded it. The service is the real scratch service of `support/serviceHarness.ts` (the working service is never named). A socket reads in chunks of 65,536 bytes (Node's default read buffer, which
// the client sends faster than the service reads), so the text is placed to put byte 65,536 of the request line inside a character, after its first byte and after its second.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixtureStore, type FixtureStore } from '../support/fixture.ts';
import { buildCorpus, type Corpus } from '../support/commandsCorpus.ts';
import { dumpMirror, isolateService, startService, stopService, leftoverProcesses, type ServiceIsolation } from '../support/serviceHarness.ts';
import { encodeMessage, type ServiceRequest } from '../../service/serviceProtocol';
import { request } from '../../service/serviceClient';

const CHUNK = 65_536;

describe('a character split between two chunks of a request is stored whole', () => {
  let fx: FixtureStore;
  let iso: ServiceIsolation;
  let c: Corpus;

  before(async () => {
    fx = makeFixtureStore('cmd_demo');
    c = buildCorpus(fx);
    dumpMirror(fx);
    iso = await isolateService(fx);
    await startService(iso);
  });
  after(async () => {
    try { await stopService(iso); } finally {
      try { assert.deepEqual(leftoverProcesses(iso), [], 'no process of the test service is left'); } finally { fx.cleanup(); }
    }
  });

  /** An `update` of the text of `itemOne` in which the `inside`-th byte (1 or 2) of `ch` is the last one of the first chunk, and the text it was asked to write. */
  function updateWithBoundaryInside(ch: string, inside: number): { req: ServiceRequest; text: string } {
    const bytes = Buffer.byteLength(ch, 'utf-8');
    const build = (pad: number): { req: ServiceRequest; text: string } => {
      const text = 'x'.repeat(pad) + ch + 'y'.repeat(2_000);
      return { req: { op: 'update', path: c.itemOne, markdown: text, textOnly: true, flush: false, reload: false } as ServiceRequest, text };
    };
    // the bytes of the line before the character, with no pad; the pad of ASCII bytes puts `inside` bytes of `ch` before byte CHUNK
    const before = Buffer.from(encodeMessage(build(0).req), 'utf-8').indexOf(Buffer.from(ch, 'utf-8'));
    const pad = CHUNK - inside - before;
    assert.ok(pad > 0 && inside < bytes);
    const made = build(pad);
    const line = Buffer.from(encodeMessage(made.req), 'utf-8');
    const at = line.indexOf(Buffer.from(ch, 'utf-8'));
    assert.equal(at + inside, CHUNK, 'the boundary of the first chunk is inside the character');
    return made;
  }

  for (const [ch, inside] of [['—', 1], ['—', 2], ['é', 1], ['😀', 3]] as const) {
    test(`'${ch}' cut after its byte ${inside}: the text written reads back as it was sent`, async () => {
      const { req, text } = updateWithBoundaryInside(ch, inside);
      await request(req);
      const doc = await request<{ text?: string }>({ op: 'show', pathArg: c.itemOne, reload: false });
      assert.equal(doc.text?.includes('�'), false, 'no U+FFFD in the stored text');
      assert.equal(doc.text, text);
    });
  }
});

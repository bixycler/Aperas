// A response that arrives in more than one chunk is decoded whole: a character of 2, 3 or 4 bytes that falls on the boundary between two chunks is printed as itself, not as U+FFFD for each half
// (`serviceClient.ts#sendRaw`). The service is a scratch server on a socket of its own under a scratch run directory (`XDG_RUNTIME_DIR`), which writes the response in pieces cut inside a character;
// the working service is never named.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from '../../service/serviceClient';
import { getSocketPath } from '../../service/serviceLock';
import type { ServiceRequest } from '../../service/serviceProtocol';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('a character split between two chunks of a response is decoded whole', () => {
  let dir: string;
  let server: Server;
  const saved = process.env.XDG_RUNTIME_DIR;
  /** The cut points the scratch server uses for the next response, as offsets in the bytes of the line. */
  let cuts: (line: Buffer) => number[] = () => [];
  const sockets = new Set<Socket>();

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ap-split-'));
    process.env.XDG_RUNTIME_DIR = dir;
    mkdirSync(join(dir, 'aperas'), { recursive: true });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { /* the client ended */ });
      let asked = '';
      socket.on('data', (d) => {
        asked += d.toString('utf-8');
        if (!asked.includes('\n')) return;
        const req = JSON.parse(asked) as ServiceRequest & { text?: string };
        const line = Buffer.from(JSON.stringify({ ok: true, result: req.text }) + '\n', 'utf-8');
        const points = [0, ...cuts(line), line.length];
        void (async () => {
          for (let i = 0; i + 1 < points.length; i++) {
            socket.write(line.subarray(points[i]!, points[i + 1]!));
            await sleep(40); // each write arrives as a chunk of its own
          }
        })();
      });
    });
    await new Promise<void>((res) => server.listen(getSocketPath(), res));
  });
  after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Sends `text` and has the server cut the response in the middle of each occurrence of `ch` (every byte boundary inside it when `all`). */
  async function roundTrip(text: string, ch: string, all = false): Promise<string> {
    cuts = (line) => {
      const out: number[] = [];
      const bytes = Buffer.from(ch, 'utf-8');
      for (let at = line.indexOf(bytes); at !== -1; at = line.indexOf(bytes, at + bytes.length)) {
        for (let k = 1; k < bytes.length; k++) { out.push(at + k); if (!all) break; }
      }
      return out;
    };
    return await request<string>({ op: 'echo', text } as unknown as ServiceRequest);
  }

  test('a character of 3 bytes cut after its first byte, and after its second', async () => {
    const text = 'a — b │ c';
    assert.equal(await roundTrip(text, '—', true), text);
    assert.equal(await roundTrip(text, '│', true), text);
  });

  test('a character of 2 bytes and one of 4 bytes cut inside', async () => {
    assert.equal(await roundTrip('é and é', 'é', true), 'é and é');
    assert.equal(await roundTrip('x 😀 y', '😀', true), 'x 😀 y');
  });

  test('a response of more than one chunk of about 64 KiB, with a multi-byte character on the boundary', async () => {
    const text = ('abcdefg │ — é\n').repeat(10_000); // about 170 KB
    const dash = Buffer.from('—', 'utf-8');
    cuts = (line) => [65_536, 131_072].map((from) => line.indexOf(dash, from) + 1); // a cut after the first byte of the first '—' past each 64 KiB
    const got = await request<string>({ op: 'echo', text } as unknown as ServiceRequest);
    assert.equal(got, text);
    assert.equal(got.includes('�'), false);
  });
});

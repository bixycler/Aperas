/**
 * ApeironNgn shared service wire protocol (Aperas-apeironngn-design.md §4 rollout step 5) —
 * newline-delimited JSON, one request per connection. `JSON.stringify` always escapes an embedded
 * `\n`, so splitting received bytes on `\n` is safe framing with no parser beyond a string split.
 */

export type ServiceRequest =
  | { op: 'ping' }
  | { op: 'track'; paths: string[]; flush: boolean }
  | { op: 'ingest'; flush: boolean }
  | { op: 'unfold'; ref: string; flush: boolean }
  | { op: 'fold'; ref: string; flush: boolean }
  | { op: 'resolve'; paths: string[]; base?: string; createHolder: boolean; titles?: string[]; flush: boolean }
  | { op: 'titleCandidates'; pathArg: string; recursive: boolean }
  | { op: 'setBlockTitle'; blockId: string; title: string; flush: boolean }
  | { op: 'linkCandidates'; pathArg: string; recursive: boolean; all: boolean }
  | { op: 'addBlockLink'; blockId: string; targetRef: string; flush: boolean }
  | { op: 'project'; path: string }
  | { op: 'tree'; pathArg: string; maxDepth?: number; noHolders: boolean; unfoldedMode: boolean }
  | { op: 'path'; idArg: string };

export type ServiceResponse = { ok: true; result: unknown } | { ok: false; error: string };

export function encodeMessage(msg: unknown): string {
  return JSON.stringify(msg) + '\n';
}

export function decodeMessage<T>(line: string): T {
  return JSON.parse(line) as T;
}

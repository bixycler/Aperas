/**
 * Migration diff harness (Aperas-apeironngn-design.md §4 rollout step 2: "diffed against its
 * existing TerminusDB-backed output before being considered migrated"). Runs a TerminusDB-backed
 * `kgCli.ts` command and its ApeironNgn equivalent with the same args, strips the TerminusDB
 * connection banner (the one expected, structural difference — ApeironNgn has no server to
 * connect to), and diffs the rest byte-for-byte.
 *
 * Usage: npx tsx src/lib/apeironNgn/compareMigration.ts <tdbCommand> <ngnScript> [-- args...]
 * Example:
 *   npx tsx src/lib/apeironNgn/compareMigration.ts tree kgTreeNgn.ts -- Aperas-design.md --depth 2
 *
 * Kept for reuse across every future migration in the rollout, not written once for `kg:tree` and
 * thrown away — the same "keep the benchmark script for later use" precedent as
 * `bench-tree-fetch-strategies.ts`.
 */

import { spawnSync } from 'node:child_process';

// Leading infra-wiring noise that's structurally TDB-only — present under every `kgCli.ts`
// command regardless of which one runs, absent under ApeironNgn by construction (no server to
// connect to, no GraphQL round trip): `client.ts`'s startup banner (connect, then apply schema)
// and `graphql.ts`'s per-query "Executing query against ..." line (any command reading through
// `getArtifactTreeViaGraphQL`/`getFolderTreeViaGraphQL`, e.g. `kg:project`, emits one of these per
// query/truncation-refetch, still before any of the command's own output). Stripped as a leading
// run rather than a fixed line count, robust to the class count or query count changing.
function stripKnownBanner(output: string): string {
  const lines = output.split('\n');
  let i = 0;
  while (i < lines.length && /^\[Aperas (Substrate|GraphQL)\]/.test(lines[i])) i++;
  return lines.slice(i).join('\n');
}

// Every migrated script's diagnostic lines are deliberately prefixed with its own identifying tag
// (`[Aperas KG CLI]` vs `[ApeironNgn kg:tree]`, etc. — kgTreeNgn.ts/kgPathNgn.ts's own convention),
// so the tags are *expected* to differ; only the rest of the line should be compared. Only matches
// a bracketed tag at the very start of a line — safe against a content line whose own `[kind]`
// label happens to appear later in the line (e.g. `kg:tree`'s `id  [type]  content` — the id
// always leads, so the bracket is never at position 0 there).
function stripLeadingTag(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, '');
}

function run(cmd: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('npx', ['tsx', cmd, ...args], { encoding: 'utf-8', cwd: process.cwd() });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

export interface CompareResult {
  identical: boolean;
  tdbOutput: string;
  ngnOutput: string;
  diffPreview?: string;
}

/** Line-by-line diff preview between two already-cleaned strings, capped at 20 differing lines.
 *  Compares each line with its own identifying tag stripped (see `stripLeadingTag`) — only lines
 *  that still differ after that are reported, and reported with the *original* (tag-included)
 *  text, so a genuine difference is never hidden by the normalization. */
function diffPreview(label: string, tdbClean: string, ngnClean: string): string[] {
  const tdbLines = tdbClean.split('\n');
  const ngnLines = ngnClean.split('\n');
  const maxLines = Math.max(tdbLines.length, ngnLines.length);
  const preview: string[] = [];
  for (let i = 0; i < maxLines && preview.length < 20; i++) {
    const tdbLine = tdbLines[i];
    const ngnLine = ngnLines[i];
    if (tdbLine === ngnLine) continue;
    if (tdbLine !== undefined && ngnLine !== undefined && stripLeadingTag(tdbLine) === stripLeadingTag(ngnLine)) continue;
    preview.push(`    line ${i + 1}:`);
    preview.push(`      tdb: ${tdbLine ?? '<missing>'}`);
    preview.push(`      ngn: ${ngnLine ?? '<missing>'}`);
  }
  return preview.length > 0 ? [`  [${label}]`, ...preview] : [];
}

/** Runs both scripts with the same `args`, diffs the (banner-stripped) stdout, stderr, *and* exit
 *  status — a migration that only matches stdout can still disagree on whether/how it fails
 *  (`kg:path`'s "no walkable parent chain" case goes to stderr with a non-zero exit, which a
 *  stdout-only compare would silently miss). `tdbCommand` is a `kgCli.ts` subcommand name (e.g.
 *  `"tree"`); `ngnScript` is a path relative to `src/lib/` (e.g. `"kgTreeNgn.ts"`). */
export function compareMigration(tdbCommand: string, ngnScript: string, args: string[]): CompareResult {
  const tdb = run('src/lib/kgCli.ts', [tdbCommand, ...args]);
  const ngn = run(`src/lib/${ngnScript}`, args);

  const tdbStdout = stripKnownBanner(tdb.stdout).trimEnd();
  const ngnStdout = ngn.stdout.trimEnd();
  const tdbStderr = stripKnownBanner(tdb.stderr).trimEnd();
  const ngnStderr = ngn.stderr.trimEnd();

  const preview = [
    ...diffPreview('stdout', tdbStdout, ngnStdout),
    ...diffPreview('stderr', tdbStderr, ngnStderr),
    ...(tdb.status !== ngn.status ? [`  [exit status] tdb: ${tdb.status}  ngn: ${ngn.status}`] : []),
  ];

  const tdbOutput = [tdbStdout, tdbStderr].filter(Boolean).join('\n');
  const ngnOutput = [ngnStdout, ngnStderr].filter(Boolean).join('\n');

  if (preview.length === 0) return { identical: true, tdbOutput, ngnOutput };
  return { identical: false, tdbOutput, ngnOutput, diffPreview: preview.join('\n') };
}

function main(): void {
  const [tdbCommand, ngnScript, ...rest] = process.argv.slice(2);
  if (!tdbCommand || !ngnScript) {
    console.error('Usage: compareMigration.ts <tdbCommand> <ngnScript> [-- args...]');
    process.exit(1);
  }
  const dashIdx = rest.indexOf('--');
  const args = dashIdx === -1 ? rest : rest.slice(dashIdx + 1);

  const result = compareMigration(tdbCommand, ngnScript, args);
  if (result.identical) {
    console.log(`[compareMigration] IDENTICAL (${result.tdbOutput.split('\n').length} lines) — kg:${tdbCommand} vs ${ngnScript}, args: ${args.join(' ') || '(none)'}`);
  } else {
    console.error(`[compareMigration] DIFFERS — kg:${tdbCommand} vs ${ngnScript}, args: ${args.join(' ') || '(none)'}`);
    console.error(result.diffPreview);
    process.exit(1);
  }
}

if (typeof process !== 'undefined' && process.argv[1]?.includes('compareMigration')) {
  main();
}

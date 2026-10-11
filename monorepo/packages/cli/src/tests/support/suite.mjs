// Helper for a suite script (`suites/<name>.suite.mjs`): `export default defineSuite(import.meta.url, [...members], budgetSeconds?)`.
// Members are test files and other suites, by path relative to the suite file. The suite imports no member.
// The optional budget is the wall time in seconds the suite promises to finish within: the runner hands it to
// the reporter, which warns past it. A suite without a budget (`demand`) never warns.
// Imported by the runner, it only hands back the list; run directly (`node suites/commit.suite.mjs`), it hands
// itself to the runner, which runs each member in its own process.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function defineSuite(metaUrl, members, budgetSeconds) {
  if (budgetSeconds !== undefined && !(Number.isFinite(budgetSeconds) && budgetSeconds > 0)) throw new Error(`a suite budget is a positive number of seconds, got ${budgetSeconds}`);
  const file = fileURLToPath(metaUrl);
  if (process.argv[1] && resolve(process.argv[1]) === file) {
    const runner = join(dirname(fileURLToPath(import.meta.url)), '..', 'run.mjs');
    const r = spawnSync(process.execPath, [runner, '--suite', file, ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }
  return Object.assign([...members], { budgetSeconds });
}

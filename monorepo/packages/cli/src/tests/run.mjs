#!/usr/bin/env node
// The test runner behind `npm run verify` (plain Node; only the test files themselves go through tsx).
//
//   npm run verify -- [--suite <name|path>] [--group <dir[,dir]>] [--case <name>] [--list]
//                     [--concurrency N] [--timeout MS] [--help]
//
// `--help` (or `-h`) prints the usage, the suites found in `suites/` and the groups, and exits 0. Every other
// run except `--list` prints a header line first (suite or group, budget, file count, concurrency, timeout);
// the final SUMMARY line carries the suite's name.
//
// The per-file timeout defaults to 900 s for a suite that declares no budget (`demand`) and to 120 s for one
// that does (`essential`, `commit`, and a `--group` run without a suite, which uses the `commit` suite);
// `--timeout` overrides. The suite's budget goes to the reporter, which warns once a case ends past it.
//
// A suite is a small script, `suites/<name>.suite.mjs`, whose default export lists its members (test
// files and other suites) by path relative to the suite. The runner resolves the members from the
// suite without importing any member, then starts `node --import tsx --test` on the resolved files:
// one process per file. Exit codes: 0 all passed, 1 a failed case, a crashed or timed-out file, or
// a `--case` that matched nothing, 2 a bad invocation or a broken suite (missing member, cycle).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const SUITE_SUFFIX = '.suite.mjs';
const TEST_SUFFIX = '.test.ts';
const NOT_GROUPS = new Set(['suites', 'support', 'legacy']);
const USAGE = 'usage: run.mjs [--suite <name|path>] [--group <dir[,dir]>] [--case <name>] [--list] [--concurrency N] [--timeout MS] [--help]';
const DEFAULT_SUITE = 'commit';
const DEFAULT_CONCURRENCY = 2;
const TIMEOUT_BUDGETED_MS = 120000;
const TIMEOUT_UNBUDGETED_MS = 900000;

class RunnerError extends Error {}
const fail = (message) => { throw new RunnerError(message); };

function parseArgs(argv) {
  const opts = { suite: undefined, group: undefined, case: undefined, list: false, help: false, concurrency: DEFAULT_CONCURRENCY, timeout: undefined, testsDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => (i + 1 < argv.length ? argv[++i] : fail(`${a} needs a value\n${USAGE}`));
    if (a === '--suite') opts.suite = value();
    else if (a === '--group') opts.group = value().split(',').filter(Boolean);
    else if (a === '--case') opts.case = value();
    else if (a === '--list') opts.list = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--concurrency') opts.concurrency = Number(value());
    else if (a === '--timeout') opts.timeout = Number(value());
    else if (a === '--tests-dir') opts.testsDir = resolve(value()); // for the runner's own tests
    else fail(`unknown argument ${a}\n${USAGE}`);
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) fail(`--concurrency needs a positive integer\n${USAGE}`);
  if (opts.timeout !== undefined && (!Number.isFinite(opts.timeout) || opts.timeout < 0)) fail(`--timeout needs a number of milliseconds\n${USAGE}`);
  return opts;
}

/** The suite file for `--suite <name|path>`. */
function suiteFile(testsDir, spec) {
  if (spec.endsWith(SUITE_SUFFIX) || spec.includes('/')) return isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  return join(testsDir, 'suites', spec + SUITE_SUFFIX);
}

/** The test files a suite resolves to, in order, nested suites expanded, each file once. */
async function resolveSuite(file, stack = []) {
  if (stack.includes(file)) fail(`suite cycle: ${[...stack, file].map((f) => basename(f)).join(' -> ')}`);
  if (!existsSync(file)) fail(`no such suite: ${file}`);
  let members;
  try {
    members = (await import(pathToFileURL(file).href)).default;
  } catch (e) {
    fail(`suite ${file} did not load: ${e.message}`);
  }
  if (!Array.isArray(members) || !members.every((m) => typeof m === 'string')) fail(`suite ${file} must export default an array of relative paths`);
  const out = [];
  for (const m of members) {
    const path = resolve(dirname(file), m);
    if (!existsSync(path)) fail(`suite ${basename(file)} names a missing member: ${m}`);
    if (m.endsWith(SUITE_SUFFIX)) out.push(...(await resolveSuite(path, [...stack, file])));
    else if (m.endsWith(TEST_SUFFIX)) out.push(path);
    else fail(`suite ${basename(file)} member ${m} is neither a ${TEST_SUFFIX} file nor a ${SUITE_SUFFIX} suite`);
  }
  return [...new Set(out)];
}

/** The wall-time budget in seconds a suite declares with `defineSuite`, or undefined when it declares none. */
async function suiteBudget(file) {
  let members;
  try {
    members = (await import(pathToFileURL(file).href)).default;
  } catch (e) {
    fail(`suite ${file} did not load: ${e.message}`);
  }
  const b = members?.budgetSeconds;
  if (b === undefined) return undefined;
  if (!(Number.isFinite(b) && b > 0)) fail(`suite ${basename(file)} declares a bad budget: ${b}`);
  return b;
}

function walkTests(dir) {
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkTests(p) : n.endsWith(TEST_SUFFIX) ? [p] : [];
  });
}

/** Every test file on disk outside `legacy/`, `support/` and `suites/`. */
function testsOnDisk(testsDir) {
  return readdirSync(testsDir).sort().flatMap((n) => {
    const p = join(testsDir, n);
    return statSync(p).isDirectory() && !NOT_GROUPS.has(n) ? walkTests(p) : [];
  });
}

const DESCRIPTION_MAX = 110;

/** The description of a suite for `--help`: the leading `//` comment lines of its file joined with single spaces,
 * cut at the first sentence end (a period followed by a space, or the end of the comment), and shortened to
 * DESCRIPTION_MAX characters with an ellipsis only if still longer. '' when the file has no leading comment. */
function suiteDescription(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((l) => l.startsWith('//'));
  if (start < 0) return '';
  const comment = [];
  for (const l of lines.slice(start)) {
    if (!l.startsWith('//')) break;
    comment.push(l.replace(/^\/\/\s?/, '').trim());
  }
  const text = comment.filter(Boolean).join(' ');
  const end = text.search(/\.(\s|$)/);
  const sentence = end < 0 ? text : text.slice(0, end + 1);
  return sentence.length > DESCRIPTION_MAX ? sentence.slice(0, DESCRIPTION_MAX - 3).trimEnd() + '...' : sentence;
}

/** The usage text printed by `--help`: options with defaults, the suites in `suites/`, the groups, examples. */
async function helpText(testsDir) {
  const out = [
    USAGE,
    '',
    'options:',
    `  --suite <name|path>   the suite to run: a name in suites/ or a path to a .suite.mjs file (default ${DEFAULT_SUITE})`,
    '  --group <dir[,dir]>   run the test files of these groups (with --suite: only those the suite lists); alone, uses the commit suite\'s budget',
    '  --case <name>         run only the cases whose name matches (exit 1 when none does)',
    '  --list                print the files the selection resolves to and run nothing',
    `  --concurrency N       files run at once (default ${DEFAULT_CONCURRENCY})`,
    `  --timeout MS          per-file timeout, 0 for none (default ${TIMEOUT_BUDGETED_MS / 1000} s for a suite with a budget, ${TIMEOUT_UNBUDGETED_MS / 1000} s for one without)`,
    '  --help, -h            print this text and exit 0',
    '',
    'suites (name, budget, files, description):',
  ];
  const suitesDir = join(testsDir, 'suites');
  const names = existsSync(suitesDir) ? readdirSync(suitesDir).sort().filter((n) => n.endsWith(SUITE_SUFFIX)) : [];
  for (const n of names) {
    const file = join(suitesDir, n);
    const budget = await suiteBudget(file);
    const count = (await resolveSuite(file)).length;
    out.push(`  ${n.slice(0, -SUITE_SUFFIX.length).padEnd(10)} ${(budget === undefined ? 'no budget' : `${budget} s`).padEnd(10)} ${String(count).padStart(3)} ${count === 1 ? 'file ' : 'files'}  ${suiteDescription(file)}`);
  }
  if (names.length === 0) out.push('  (none found)');
  out.push('', 'groups (subdirectories of src/tests/ that hold test files):');
  const groups = readdirSync(testsDir).sort().filter((n) => !NOT_GROUPS.has(n) && statSync(join(testsDir, n)).isDirectory())
    .map((n) => [n, walkTests(join(testsDir, n)).length]).filter(([, c]) => c > 0);
  for (const [n, c] of groups) out.push(`  ${n.padEnd(10)} ${String(c).padStart(3)} ${c === 1 ? 'file ' : 'files'}`);
  if (groups.length === 0) out.push('  (none found)');
  out.push('',
    'examples:',
    '  npm run verify                          the commit suite',
    '  npm run verify -- --suite essential     the few-seconds suite',
    '  npm run verify -- --group links         one group');
  return out.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const here = dirname(fileURLToPath(import.meta.url));
  const testsDir = opts.testsDir ?? here;
  if (!existsSync(testsDir)) fail(`no such tests directory: ${testsDir}`);
  if (opts.help) {
    console.log(await helpText(testsDir));
    return 0;
  }

  // The suite whose budget and timeout apply: the named one, else `commit` (a `--group` run alone uses its budget).
  const budgetSuite = suiteFile(testsDir, opts.suite ?? DEFAULT_SUITE);
  const budget = existsSync(budgetSuite) ? await suiteBudget(budgetSuite) : undefined; // a missing suite is refused below
  const timeoutMs = opts.timeout ?? (budget === undefined ? TIMEOUT_UNBUDGETED_MS : TIMEOUT_BUDGETED_MS);

  let files;
  if (opts.group) {
    files = opts.group.flatMap((g) => {
      const dir = join(testsDir, g);
      if (NOT_GROUPS.has(g) || !existsSync(dir) || !statSync(dir).isDirectory()) fail(`no such group: ${g}`);
      const found = walkTests(dir);
      if (found.length === 0) fail(`group ${g} holds no ${TEST_SUFFIX} files`);
      return found;
    });
    if (opts.suite !== undefined) {
      const inSuite = new Set(await resolveSuite(suiteFile(testsDir, opts.suite)));
      files = files.filter((f) => inSuite.has(f));
    }
  } else {
    files = await resolveSuite(suiteFile(testsDir, opts.suite ?? DEFAULT_SUITE));
  }
  files = [...new Set(files)];
  if (files.length === 0) fail('the selection holds no test files');

  // A test file that no suite lists never runs by default: say so (a warning, not a failure).
  const suitesDir = join(testsDir, 'suites');
  if (existsSync(suitesDir)) {
    const listed = new Set();
    for (const n of readdirSync(suitesDir).sort()) {
      if (n.endsWith(SUITE_SUFFIX)) for (const f of await resolveSuite(join(suitesDir, n))) listed.add(f);
    }
    const unlisted = testsOnDisk(testsDir).filter((f) => !listed.has(f));
    if (unlisted.length > 0) console.error(`warning: ${unlisted.length} test file(s) in no suite: ${unlisted.map((f) => relative(testsDir, f)).join(', ')}`);
  }

  if (opts.list) {
    for (const f of files) console.log(relative(testsDir, f).split(sep).join('/'));
    return 0;
  }

  // The suite's name for the header and the summary: the named suite (a path gives its file's name), else a bare group run.
  const suiteName = opts.suite !== undefined ? basename(budgetSuite).replace(SUITE_SUFFIX, '') : undefined;
  const budgetText = budget === undefined ? 'no budget' : `budget ${budget} s`;
  const groupText = opts.group ? `group ${opts.group.join(',')}` : undefined;
  const head = groupText && suiteName === undefined
    ? `${groupText} (${DEFAULT_SUITE}'s ${budget === undefined ? 'no budget' : `budget ${budget} s`})`
    : `suite ${suiteName ?? DEFAULT_SUITE} (${budgetText})${groupText ? ` ${groupText}` : ''}`;
  const timeoutText = timeoutMs > 0 ? `timeout ${timeoutMs / 1000} s a file` : 'no timeout';
  console.log(`${head} - ${files.length} files, concurrency ${opts.concurrency}, ${timeoutText}${opts.case !== undefined ? `, case ${JSON.stringify(opts.case)}` : ''}`);

  const args = [
    '--import', import.meta.resolve('tsx'),
    '--test', `--test-concurrency=${opts.concurrency}`,
    ...(timeoutMs > 0 ? [`--test-timeout=${timeoutMs}`] : []),
    `--test-reporter=${join(here, 'support', 'reporter.mjs')}`,
    ...(opts.case !== undefined ? [`--test-name-pattern=${opts.case}`] : []),
    ...files,
  ];
  return await new Promise((done) => {
    const env = { ...process.env };
    delete env.NT_BUDGET_S;
    env.NT_SUITE = suiteName ?? (groupText ?? DEFAULT_SUITE).replace(/^group /, 'group:');
    if (budget !== undefined) env.NT_BUDGET_S = String(budget);
    const child = spawn(process.execPath, args, { stdio: ['inherit', 'pipe', 'inherit'], cwd: testsDir, env });
    let tail = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + chunk).slice(-4096);
    });
    child.on('exit', (code, signal) => {
      let status = code ?? (signal ? 1 : 0);
      const ran = /^SUMMARY suite=\S+ ran=(\d+)/m.exec(tail);
      if (opts.case !== undefined && status === 0 && ran && Number(ran[1]) === 0) {
        console.error(`error: --case ${JSON.stringify(opts.case)} matched no case in ${files.length} file(s)`);
        status = 1;
      }
      done(status);
    });
  });
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof RunnerError) { console.error(`error: ${e.message}`); process.exit(2); }
    throw e;
  },
);

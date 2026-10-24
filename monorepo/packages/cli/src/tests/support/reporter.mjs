// Reporter for `npm run verify`: one line per case, one per file with the time the file itself measured
// (its own run, load of the module included, not the 150 to 250 ms the process and tsx take to start), a file's own output
// only when it failed, and a final SUMMARY line that names the suite (NT_SUITE, set by the runner). Once the whole run is past the budget of the running suite
// (NT_BUDGET_S, in seconds, set by the runner from the suite's declared budget), each case that ends prints one
// extra WARN line with the elapsed time and the case; nothing else changes. A suite without a budget sets no
// NT_BUDGET_S, and the reporter then prints no WARN line.
const BUDGET_S = process.env.NT_BUDGET_S === undefined ? undefined : Number(process.env.NT_BUDGET_S);
const WARN_AFTER_MS = BUDGET_S === undefined || !Number.isFinite(BUDGET_S) ? Infinity : BUDGET_S * 1000;

const SUITE_NAME = process.env.NT_SUITE || 'unknown';

// A short message is shown whole up to 6 lines. A long one (a failed assertion that carries the output of a process, such as a Python `unittest` run, whose
// assertion text and traceback come last) shows its first 3 lines, a marker with the number of lines left out, and its last 40 lines.
const errorText = (err) => {
  const lines = String(err?.cause?.message ?? err?.message ?? err ?? '').split('\n');
  const shown = lines.length <= 6 ? lines : lines.length <= 43 ? lines : [...lines.slice(0, 3), `... (${lines.length - 43} lines left out)`, ...lines.slice(-40)];
  return shown.join('\n      ');
};

export default async function* reporter(source) {
  const t0 = Date.now();
  const rel = (f) => (f ?? '').replace(process.cwd() + '/', '');
  const isFile = (d) => d.nesting === 0 && (d.name === d.file || d.name === rel(d.file));
  const output = new Map();   // file -> buffered child output
  const failedFiles = new Set();
  let ran = 0, passed = 0, failed = 0;
  for await (const e of source) {
    const d = e.data;
    switch (e.type) {
      case 'test:stdout': case 'test:stderr':
        output.set(d.file, (output.get(d.file) ?? '') + d.message);
        break;
      case 'test:pass': case 'test:fail': {
        if (isFile(d)) { // a file's own node: reported at its summary, unless the file itself failed (a crash, a syntax error, a timeout)
          if (e.type === 'test:fail') {
            ran++; failed++; failedFiles.add(d.file);
            yield `FAIL ${d.details.duration_ms.toFixed(0).padStart(6)} ms  ${rel(d.file)} :: the file itself failed\n      ${errorText(d.details.error)}\n`;
            yield `--- output of ${rel(d.file)} ---\n${output.get(d.file) ?? ''}--- end ---\n`;
            output.delete(d.file);
          }
          break;
        }
        const ok = e.type === 'test:pass';
        const isSuite = d.details?.type === 'suite';
        if (isSuite && (ok || failedFiles.has(d.file))) break; // a `describe` group is only worth a line when a hook failed it
        if (!isSuite) { ran++; if (ok) passed++; else failed++; }
        if (!ok) failedFiles.add(d.file);
        yield `${ok ? 'ok  ' : 'FAIL'} ${d.details.duration_ms.toFixed(0).padStart(6)} ms  ${rel(d.file)} :: ${d.name}\n`;
        if (!ok) yield `      ${errorText(d.details.error)}\n`;
        const elapsed = Date.now() - t0;
        if (elapsed > WARN_AFTER_MS) yield `WARN the run is over ${WARN_AFTER_MS / 1000} s (${(elapsed / 1000).toFixed(0)} s so far) at ${rel(d.file)} :: ${d.name}\n`;
        break;
      }
      case 'test:summary':
        if (d.file) { // the last event of a file, after its cases: its wall time, and its output if it failed
          const ms = Math.round(d.duration_ms ?? Date.now() - t0);
          const bad = d.success === false || failedFiles.has(d.file);
          yield `file ${String(ms).padStart(6)} ms  ${rel(d.file)}${bad ? '  (FAILED)' : ''}\n`;
          if (bad) yield `--- output of ${rel(d.file)} ---\n${output.get(d.file) ?? ''}--- end ---\n`;
          output.delete(d.file);
        } else yield `SUMMARY suite=${SUITE_NAME} ran=${ran} passed=${passed} failed=${failed} cancelled=${d.counts.cancelled} skipped=${d.counts.skipped}; ${Date.now() - t0} ms\n`;
        break;
    }
  }
}

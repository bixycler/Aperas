/**
 * Shared `--help`/`-h` handling for every `kg:` CLI script. Checked at the very top of `main()`,
 * before `ensureServiceRunning()` — `--help` should never need the ApeironNgn service running, and
 * every script's own required-arg check (its `Usage: ...` message on `console.error` + exit 1)
 * would otherwise just treat `--help` as a missing/bogus argument instead of answering it.
 */

export interface HelpEntry {
  name: string;
  description: string;
}

export interface HelpSpec {
  description: string;
  usage: string | string[];
  args?: HelpEntry[];
  flags?: HelpEntry[];
}

export function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function printEntries(title: string, entries: HelpEntry[]): void {
  console.log();
  console.log(`${title}:`);
  const width = Math.max(...entries.map((e) => e.name.length));
  for (const { name, description } of entries) {
    console.log(`  ${name.padEnd(width)}  ${description}`);
  }
}

export function printHelp(spec: HelpSpec): void {
  console.log(spec.description);
  console.log();
  console.log('Usage:');
  for (const line of Array.isArray(spec.usage) ? spec.usage : [spec.usage]) {
    console.log(`  ${line}`);
  }
  if (spec.args?.length) printEntries('Arguments', spec.args);
  if (spec.flags?.length) printEntries('Flags', spec.flags);
}

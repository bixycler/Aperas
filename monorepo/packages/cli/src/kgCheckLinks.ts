/**
 * `kg:check-links` — standing link integrity checking sweep (`issues/linking.md` Shared Fix Direction)
 * Compares live block text against stored `.links` in Oxigraph Store.
 */

import { ensureServiceRunning, request } from './apeironNgn/serviceClient';
import { wantsHelp, printHelp } from './kgHelp';
import type { LinkIntegrityReport, RepairLinkIntegrityResult } from '@aperas/core/apeironNgn/linkIntegrity';

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (wantsHelp(rawArgs)) {
    printHelp({
      description: 'Run a drift-style link integrity check comparing live block text against stored .links quads in Oxigraph Store.',
      usage: 'aperas check-links [--repair|--fix] [--verbose] [--json] [--reload]',
      flags: [
        { name: '--repair, --fix', description: 'Automatically re-resolve and flush missing links for affected artifacts.' },
        { name: '--verbose', description: 'Print full discrepancy details per node.' },
        { name: '--json', description: 'Output result as JSON.' },
        { name: '--reload', description: 'Reload the store from disk first before running the check.' },
      ],
    });
    return;
  }

  const repair = rawArgs.includes('--repair') || rawArgs.includes('--fix');
  const verbose = rawArgs.includes('--verbose');
  const asJson = rawArgs.includes('--json');
  const reload = rawArgs.includes('--reload');

  await ensureServiceRunning();

  if (repair) {
    // Flushes unconditionally, not gated behind its own flag: the help text above already promises
    // "re-resolve and flush" — before this, `flush` wasn't even part of the request shape, so a
    // repair only ever marked the store dirty and left persisting it to the 10s timer (or whatever
    // op happened to flush next), the same "can't stage immediately" trap the skill's own discipline
    // warns about elsewhere. A one-shot corrective sweep should be flushable in the same call.
    const result = await request<RepairLinkIntegrityResult>({ op: 'checkLinks', repair: true, reload, flush: true });
    if (asJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`[ApeironNgn check-links] Repair sweep completed.`);
    console.log(`  Discrepancies before: ${result.reportBefore.discrepancies.length}`);
    console.log(`  Repaired artifacts: ${result.repairedArtifacts.length}`);
    console.log(`  Discrepancies after: ${result.reportAfter.discrepancies.length}`);
    return;
  }

  const report = await request<LinkIntegrityReport>({ op: 'checkLinks', repair: false, reload, flush: false });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`[ApeironNgn check-links] Scanned ${report.totalLiveBlocks} live blocks (${report.blocksWithLinkText} with internal link text).`);

  if (report.discrepancies.length === 0) {
    console.log(`[ApeironNgn check-links] Clean pass: 0 link integrity discrepancies found.`);
    return;
  }

  console.warn(`[ApeironNgn check-links] WARNING: Found ${report.discrepancies.length} link integrity discrepancies:`);
  for (const disc of report.discrepancies) {
    console.warn(`  • Node ${disc.blockId} (${disc.artifactPath ?? 'unknown'}): ${disc.missingCodes.length} missing link(s)`);
    console.warn(`    Title: ${disc.blockTitle}`);
    console.warn(`    Missing codes: ${disc.missingCodes.join(', ')}`);
    if (verbose) {
      console.warn(`    Text snippet: ${disc.blockText}`);
      console.warn(`    Actual links: ${JSON.stringify(disc.resolvedLinks)}`);
    }
  }
}

if (process.argv[1]?.endsWith('kgCheckLinks.ts')) {
  main().catch((err) => {
    console.error('[ApeironNgn check-links] Failed:', err.message || err);
    process.exit(1);
  });
}

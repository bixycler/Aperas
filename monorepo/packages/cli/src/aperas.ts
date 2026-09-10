/**
 * `aperas` — the single dispatcher binary (AperasKG/artifacts/design/packaging.md's Architecture):
 * argv-dispatches to a subcommand per verb, reusing each `kgX.ts`'s own exported `main()` instead
 * of duplicating its argv-parsing/help-printing glue in a second place.
 *
 * Every `kgX.ts` still works unchanged as a direct `tsx kgX.ts` entrypoint (the `if (process.argv[1]
 * ?.endsWith('kgX.ts')) main()...` guard at the bottom of each file) — this is a second caller of
 * the same exported `main()`, not a replacement for the first. Because that guard checks
 * `process.argv[1]` (this file's own path, never a `kgX.ts` one), invoking a command's `main()`
 * from here can never also trigger that file's own direct-invocation guard.
 *
 * `main()` in every `kgX.ts` reads its own args from `process.argv.slice(2)`, not a parameter — so
 * before calling the target's `main()`, this file rewrites `process.argv` to drop the verb, putting
 * the remaining args back at index 2 exactly where `tsx kgX.ts <args...>` would have put them.
 *
 * The verb table below is static, not filesystem auto-discovery: ~18 fixed commands, so a typo'd
 * verb gets a clean listed error rather than "whatever happens to be on disk." Each entry's
 * `description` is the same one-liner that command's own `--help` already leads with (kept here
 * too so `aperas` with no verb / `--help` can list every command without having to invoke each one
 * just to ask).
 */

interface CommandSpec {
  description: string;
  load: () => Promise<{ main: () => Promise<void> }>;
}

const COMMANDS: Record<string, CommandSpec> = {
  track: { description: 'Register/refresh ArtifactNodes for tracked files.', load: () => import('./kgTrack') },
  ingest: { description: "AST-parse and commit changed tracked artifacts' fractal trees, then rebuild the FolderNode structural tree.", load: () => import('./kgIngest') },
  project: { description: "Serialize a tracked ArtifactNode/FolderNode's tree back to Markdown.", load: () => import('./kgProject') },
  tree: { description: 'Render the fractal tree from a resolved node.', load: () => import('./kgTree') },
  unfold: { description: "Add one TreeNode/Link ref to a TreeView's unfolds set — only that one ref; the view's own rendering decides what becomes visible as a result.", load: () => import('./kgUnfold') },
  fold: { description: "Remove one TreeNode/Link ref's own unfolds entry from a TreeView, cascading to anything reached from it that's also separately unfolded.", load: () => import('./kgFold') },
  link: { description: 'Interactively prompt for cross-links on BlockNodes in scope.', load: () => import('./kgLink') },
  unlink: { description: 'Remove a manually-added kg:link between two nodes.', load: () => import('./kgUnlink') },
  path: { description: 'Resolve a node to its walkable path.', load: () => import('./kgPath') },
  backlinks: { description: "List every Link that targets a given node — the reverse of unfold's forward view.", load: () => import('./kgBacklinks') },
  resolve: { description: 'Resolve one or more deep paths to node ids.', load: () => import('./kgResolve') },
  insert: { description: 'Position, promote, or (with piped markdown) create a Block node.', load: () => import('./kgInsert') },
  update: { description: "Replace an existing node's text/children (and, for a heading target, its title) from piped markdown.", load: () => import('./kgUpdate') },
  remove: { description: 'Recursively (soft) tombstone an arbitrary node.', load: () => import('./kgRemove') },
  profile: { description: 'Create/list/remove a Profile and the TreeViews it owns.', load: () => import('./kgProfile') },
  service: { description: 'Direct control over the shared ApeironNgn service process.', load: () => import('./kgService') },
  flush: { description: 'Force an immediate sync of the ApeironNgn store out to the AperasKG/Apeiron/ mirror on disk.', load: () => import('./kgFlush') },
  reload: { description: 'Discard the in-memory ApeironNgn store and rehydrate it from the AperasKG/Apeiron/ mirror on disk.', load: () => import('./kgReload') },
  identity: { description: "Show or set this machine's identity.json (currently just machineNumber).", load: () => import('./kgIdentity') },
};

function printTopLevelHelp(): void {
  const verbs = Object.keys(COMMANDS).sort();
  const width = Math.max(...verbs.map((v) => v.length));
  console.log('Usage: aperas <verb> [args...]');
  console.log('       aperas <verb> --help   (per-command usage/flags)');
  console.log();
  console.log('Verbs:');
  for (const verb of verbs) {
    console.log(`  ${verb.padEnd(width)}  ${COMMANDS[verb].description}`);
  }
}

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);

  // Hidden verb, never listed: `serviceClient.ts#spawnService` re-invokes *this same running
  // script* (this file under `tsx` in dev, or the single bundled `aperas.js` once built — see its
  // own doc comment) with this flag to become the long-lived service process itself, instead of
  // spawning a separate `service.ts` file that doesn't exist as its own file once bundled. A
  // dynamic import here is what makes `esbuild` actually include `service.ts`'s code in the single
  // output bundle at all — nothing else reachable from this file ever imports it.
  if (verb === '--__service') {
    const { main: startService } = await import('./apeironNgn/service');
    startService();
    return;
  }

  if (!verb || verb === '--help' || verb === '-h') {
    printTopLevelHelp();
    return;
  }
  const command = COMMANDS[verb];
  if (!command) {
    console.error(`[aperas] Unknown command '${verb}'.`);
    printTopLevelHelp();
    process.exit(1);
  }
  // Drop the verb so the target's own `main()` (reading `process.argv.slice(2)`) sees exactly what
  // `tsx kgX.ts <rest...>` would have given it.
  process.argv = [process.argv[0], process.argv[1], ...rest];
  const { main: runCommand } = await command.load();
  await runCommand();
}

main().catch((err) => {
  console.error('[aperas] Failed:', err.message || err);
  process.exit(1);
});

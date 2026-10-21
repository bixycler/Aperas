// The old engine's store for the tests of the frozen files (`store/storeAccess.test.ts`, `store/roundtrip.test.ts`; Batch 12 deletes them with the files). The shell no
// longer produces a raw Oxigraph `Store`, so the test builds its data through the shell as every test does, on the handle of the fixture, and this helper hands the
// frozen code the same data in its own form: the handle is dumped to the scratch mirror (the dump of the engine writes the files the old rehydrate reads) and
// rehydrated by the old reader.
import { dumpMirror } from '@aperas/core/shell/mirrorDump';
import { rehydrateStore } from '@aperas/core/shell/store';
import type { Store } from 'oxigraph';
import type { FixtureStore } from './fixture.ts';

/** The content of the fixture's handle, as the old reader makes a `Store` of it. The mirror is written to the fixture's scratch roots. */
export function oldStoreOf(fx: FixtureStore): Store {
  dumpMirror(fx.store.engine, fx.root, fx.store.mapping);
  return rehydrateStore(fx.apeironRoot).store;
}

// Run when the engine, the lookups, the mirror or the write layer changes: the seeded model files, each over about a second in its file.
// A model file under about a second stays in `commit`. It has a budget of 30 s wall at concurrency 2, declared below.
import { defineSuite } from '../support/suite.mjs';

export default defineSuite(import.meta.url, [
  '../engine/graphs.model.test.ts',
  '../engine/tombstone.model.test.ts',
  '../engine/containment.model.test.ts',
  '../engine/relations.model.test.ts',
  '../engine/literals.model.test.ts',
  '../mirror/roundtrip.model.test.ts',
  '../lookups/lookups.model.test.ts',
  '../shell/writeLayer.model.test.ts',
], 30);

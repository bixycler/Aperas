/**
 * Concrete per-type classes (Aperas-apeironngn-design.md §3 "Schema = class") — mere schema for
 * now (§3's "deliberately scoped out for now" bullet, §4 rollout step 3 folds behavior in later).
 * Each carries only its own `static SHAPE`; `node.ts`'s `wrap()` is what turns an instance into a
 * usable `a.b.c` proxy.
 */

import type { Store } from 'oxigraph';
import { nodeKindFromId } from './vocab';
import { BLOCK_NODE_SHAPE, ARTIFACT_NODE_SHAPE, FOLDER_NODE_SHAPE, LINK_SHAPE, PROP_SHAPE, type ClassShape } from './shape';

export class ApeironInstance {
  static SHAPE: ClassShape = {};
  readonly store: Store;
  readonly id: string;
  constructor(store: Store, id: string) {
    this.store = store;
    this.id = id;
  }
}

export class BlockNode extends ApeironInstance {
  static SHAPE = BLOCK_NODE_SHAPE;
}
export class ArtifactNode extends ApeironInstance {
  static SHAPE = ARTIFACT_NODE_SHAPE;
}
export class FolderNode extends ApeironInstance {
  static SHAPE = FOLDER_NODE_SHAPE;
}
export class Link extends ApeironInstance {
  static SHAPE = LINK_SHAPE;
}
export class StringProp extends ApeironInstance {
  static SHAPE = PROP_SHAPE;
}

export const CLASS_BY_KIND: Record<string, typeof ApeironInstance> = {
  BlockNode,
  ArtifactNode,
  FolderNode,
  Link,
  StringProp,
};

export function classForId(id: string): typeof ApeironInstance {
  const kind = nodeKindFromId(id);
  const Cls = CLASS_BY_KIND[kind];
  if (!Cls) throw new Error(`ApeironNgn: no class registered for node kind '${kind}' (id '${id}').`);
  return Cls;
}

// The engine's meta-model (design/core.md, "The meta-model"): the types a schema is written in, and the
// construction that closes one. The engine is generic and names no kind or field of the Aperas schema; the
// shell hands it a `SchemaSpec` and gets back a `Schema`, a frozen copy that nothing can change.

/** `literal` (a plain value), `reference` (the id of another node, not owned) or `embed` (a node the field owns). */
export type StorageKind = 'literal' | 'reference' | 'embed';

/** `one` (exactly one value), `optional` (at most one), `set` (any number, unordered) or `ordered` (a set with an order). */
export type Cardinality = 'one' | 'optional' | 'set' | 'ordered';

/** The value of a literal field. The schema declares no type for it, and the JavaScript type is kept. */
export type LiteralValue = string | number | boolean;

/** A field of a kind as the shell writes it. */
export interface FieldSpec {
  readonly name: string;
  readonly storage: StorageKind;
  readonly cardinality: Cardinality;
  /** An embed field names the kind it embeds. Required for `embed`, refused for the others. */
  readonly embeds?: string;
  /** The name of the reverse side of a reference or embed field, given only where the engine must expose that side as a field. */
  readonly reverse?: string;
  /** The partitioning mark: the engine ensures it. Refused on a literal field, which has no reverse side. */
  readonly partitioning?: boolean;
}

/**
 * The place, in the field order of a kind, of the reverse side of a field. `name` is the reverse name some field
 * declares. The engine reads it from the reverse side and stores no pair for it.
 */
export interface DerivedSpec {
  readonly name: string;
  readonly storage: 'derived';
}

export interface KindSpec {
  readonly name: string;
  /** The kind whose fields this kind inherits. */
  readonly extends?: string;
  /** The kind's own fields, in order. The inherited ones come first in the order a record is read out in, unless `order` says otherwise. */
  readonly fields: readonly (FieldSpec | DerivedSpec)[];
  /**
   * The explicit order of all the fields of the kind, own and inherited, a derived entry included. It names each field
   * once and none else. A kind that lists it is read out in that order; the one that does not has the inherited fields
   * first, then its own. For a kind whose Format needs an order that inheritance does not give.
   */
  readonly order?: readonly string[];
}

/** The roles a schema assigns. Each is optional, a schema may hold none. */
export interface RolesSpec {
  /** The containment field: reference, ordered and partitioning wherever it is declared. */
  readonly containment?: string;
  /** The tombstone marker: an optional literal field wherever it is declared. */
  readonly tombstone?: string;
  /** The reference fields whose value is dropped when its target is removed. */
  readonly dropWithTarget?: readonly string[];
  /** The sweep: the kinds it starts from, and the reference or embed fields it follows. */
  readonly sweep?: { readonly roots: readonly string[]; readonly follow: readonly string[] };
}

export interface SchemaSpec {
  readonly kinds: readonly KindSpec[];
  readonly roles?: RolesSpec;
}

/** A field of a closed kind. */
export interface FieldDef {
  readonly name: string;
  readonly storage: StorageKind;
  readonly cardinality: Cardinality;
  readonly embeds?: string;
  readonly reverse?: string;
  readonly partitioning: boolean;
  /** True for the place of a reverse side in the field order: optional, a reference, stored as no pair. */
  readonly derived: boolean;
  /** The kind that declared the field (the ancestor, for an inherited one). */
  readonly origin: string;
}

export interface KindDef {
  readonly name: string;
  readonly parent?: string;
  /** Every field of the kind in the order a record is read out in: the inherited ones first, then its own. */
  readonly fields: readonly FieldDef[];
}

export interface RolesDef {
  readonly containment?: string;
  readonly tombstone?: string;
  readonly dropWithTarget: readonly string[];
  readonly sweep?: { readonly roots: readonly string[]; readonly follow: readonly string[] };
}

/** A closed schema: a frozen copy, fixed for the engine's life. */
export interface Schema {
  /** The kinds in the order the spec declares them. */
  readonly kinds: readonly KindDef[];
  readonly roles: RolesDef;
}

/** `closeSchema` refuses a schema that is inconsistent. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(`invalid schema: ${message}`);
    this.name = 'SchemaError';
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STORAGES: readonly string[] = ['literal', 'reference', 'embed'];
const CARDINALITIES: readonly string[] = ['one', 'optional', 'set', 'ordered'];

const refuse = (message: string): never => { throw new SchemaError(message); };
const checkName = (what: string, name: unknown): string => (typeof name === 'string' && NAME.test(name) ? name : refuse(`${what} ${JSON.stringify(name)} is not a name`));

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

const isDerived = (f: FieldSpec | DerivedSpec): f is DerivedSpec => f.storage === 'derived';

/** Close a schema: check it, and return a frozen copy that shares nothing with the spec. */
export function closeSchema(spec: SchemaSpec): Schema {
  // Kinds: unique names, and a parent that exists.
  const specs = new Map<string, KindSpec>();
  for (const k of spec.kinds) {
    checkName('kind', k.name);
    if (specs.has(k.name)) refuse(`kind ${k.name} is declared twice`);
    specs.set(k.name, k);
  }
  for (const k of spec.kinds) {
    if (k.extends !== undefined && !specs.has(k.extends)) refuse(`kind ${k.name} extends ${k.extends}, which is not a kind`);
  }
  // Inheritance has no cycle.
  for (const k of spec.kinds) {
    const seen = new Set<string>([k.name]);
    for (let p = k.extends; p !== undefined; p = specs.get(p)!.extends) {
      if (seen.has(p)) refuse(`kind ${k.name} closes an inheritance cycle through ${p}`);
      seen.add(p);
    }
  }

  // The reverse names of the whole schema: each belongs to one field name, and is no field's name.
  const reverseOwner = new Map<string, string>();
  const fieldNames = new Set<string>();
  for (const k of spec.kinds) {
    for (const f of k.fields) {
      if (isDerived(f)) continue;
      fieldNames.add(f.name);
    }
  }
  for (const k of spec.kinds) {
    for (const f of k.fields) {
      if (isDerived(f) || f.reverse === undefined) continue;
      checkName(`the reverse name of ${k.name}.${f.name}`, f.reverse);
      if (f.storage === 'literal') refuse(`${k.name}.${f.name} is a literal field and has no reverse side`);
      if (fieldNames.has(f.reverse)) refuse(`the reverse name ${f.reverse} of ${k.name}.${f.name} is also the name of a field`);
      const owner = reverseOwner.get(f.reverse);
      if (owner !== undefined && owner !== f.name) refuse(`the fields ${owner} and ${f.name} have the same reverse name ${f.reverse}`);
      reverseOwner.set(f.reverse, f.name);
    }
  }

  // Flatten each kind: the inherited fields first, then its own, or the explicit order it declares.
  const flat = new Map<string, FieldDef[]>();
  const flatten = (name: string): FieldDef[] => {
    const done = flat.get(name);
    if (done) return done;
    const k = specs.get(name)!;
    const out: FieldDef[] = k.extends === undefined ? [] : flatten(k.extends).map((f) => ({ ...f }));
    const own = new Set<string>();
    for (const f of k.fields) {
      checkName(`a field of ${k.name}`, f.name);
      if (own.has(f.name)) refuse(`${k.name} declares ${f.name} twice`);
      own.add(f.name);
      const at = out.findIndex((g) => g.name === f.name);
      if (isDerived(f)) {
        if (!reverseOwner.has(f.name)) refuse(`${k.name} lists ${f.name} as a derived entry, which is the reverse name of no field`);
        if (at >= 0) refuse(`${k.name} redeclares ${f.name} in a descendant`);
        out.push({ name: f.name, storage: 'reference', cardinality: 'optional', partitioning: false, derived: true, origin: k.name });
        continue;
      }
      if (!STORAGES.includes(f.storage)) refuse(`${k.name}.${f.name} has the storage kind ${JSON.stringify(f.storage)}`);
      if (!CARDINALITIES.includes(f.cardinality)) refuse(`${k.name}.${f.name} has the cardinality ${JSON.stringify(f.cardinality)}`);
      if (f.storage === 'embed') {
        if (f.embeds === undefined || !specs.has(f.embeds)) refuse(`${k.name}.${f.name} is an embed field and names no known embedded kind`);
      } else if (f.embeds !== undefined) refuse(`${k.name}.${f.name} is not an embed field and names an embedded kind`);
      if (f.partitioning && f.storage === 'literal') refuse(`${k.name}.${f.name} is a literal field and cannot be partitioning`);
      if (at >= 0) refuse(`${k.name}.${f.name} is redeclared from ${out[at]!.origin}`);
      out.push({ name: f.name, storage: f.storage, cardinality: f.cardinality, ...(f.embeds !== undefined ? { embeds: f.embeds } : {}), ...(f.reverse !== undefined ? { reverse: f.reverse } : {}), partitioning: f.partitioning === true, derived: false, origin: k.name });
    }
    if (k.order !== undefined) {
      const placed = new Set<string>();
      for (const n of k.order) {
        if (placed.has(n)) refuse(`${k.name} orders ${n} twice`);
        if (!out.some((g) => g.name === n)) refuse(`${k.name} orders ${n}, which is not one of its fields`);
        placed.add(n);
      }
      const left = out.find((g) => !placed.has(g.name));
      if (left !== undefined) refuse(`${k.name} leaves ${left.name} out of its order`);
      const byName = new Map(out.map((g) => [g.name, g]));
      out.splice(0, out.length, ...k.order.map((n) => byName.get(n)!));
    }
    flat.set(name, out);
    return out;
  };
  for (const k of spec.kinds) flatten(k.name);

  // Every declaration of a field name, in every kind that has it, for the roles.
  const declarations = (field: string): FieldDef[] => spec.kinds.flatMap((k) => flat.get(k.name)!.filter((f) => f.name === field && !f.derived));
  const declared = (role: string, field: string): FieldDef[] => {
    const found = declarations(field);
    if (found.length === 0) refuse(`${role} names the field ${field}, which no kind declares`);
    return found;
  };
  const noDuplicates = (role: string, names: readonly string[]): void => {
    if (new Set(names).size !== names.length) refuse(`${role} names the same entry twice`);
  };

  const r = spec.roles ?? {};
  if (r.containment !== undefined) {
    for (const f of declared('the containment role', r.containment)) {
      if (f.storage !== 'reference' || f.cardinality !== 'ordered' || !f.partitioning) refuse(`the containment field ${r.containment} must be an ordered, partitioning reference field wherever it is declared (${f.origin})`);
    }
  }
  if (r.tombstone !== undefined) {
    for (const f of declared('the tombstone role', r.tombstone)) {
      if (f.storage !== 'literal' || f.cardinality !== 'optional') refuse(`the tombstone marker ${r.tombstone} must be an optional literal field wherever it is declared (${f.origin})`);
    }
  }
  const dropWithTarget = [...(r.dropWithTarget ?? [])];
  noDuplicates('the dropped-with-target role', dropWithTarget);
  for (const name of dropWithTarget) {
    for (const f of declared('the dropped-with-target role', name)) {
      if (f.storage !== 'reference') refuse(`the field ${name}, dropped with its target, must be a reference field wherever it is declared (${f.origin})`);
    }
  }
  let sweep: RolesDef['sweep'];
  if (r.sweep !== undefined) {
    const roots = [...r.sweep.roots];
    const follow = [...r.sweep.follow];
    noDuplicates('the sweep roots', roots);
    noDuplicates('the sweep fields', follow);
    for (const root of roots) if (!specs.has(root)) refuse(`the sweep root ${root} is not a kind`);
    for (const name of follow) {
      for (const f of declared('the sweep', name)) {
        if (f.storage === 'literal') refuse(`the sweep follows ${name}, a literal field (${f.origin})`);
      }
    }
    sweep = { roots, follow };
  }

  const kinds: KindDef[] = spec.kinds.map((k) => ({ name: k.name, ...(k.extends !== undefined ? { parent: k.extends } : {}), fields: flat.get(k.name)!.map((f) => ({ ...f })) }));
  const roles: RolesDef = { ...(r.containment !== undefined ? { containment: r.containment } : {}), ...(r.tombstone !== undefined ? { tombstone: r.tombstone } : {}), dropWithTarget, ...(sweep ? { sweep } : {}) };
  return deepFreeze({ kinds, roles });
}

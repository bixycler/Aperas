// The grammar of an id (design/core.md, "Ids"):
//   id := Kind ":" snowflake | id ":" field ":" Kind ":" snowflake
// `snowflake` is 13 characters of the Crockford alphabet, and `Kind` and `field` follow the schema's name rule. The
// grammar is schema-free: `Foo:snowflake` is an id by its shape, whatever the schema holds. The shell imports this
// file (Batch 11) so that the shell and the engine read ids one way.
import type { Id } from './interface.ts';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SNOWFLAKE = /^[0-9A-HJKMNP-TV-Z]{13}$/;

/** Whether a string is an id: a valid snowflake follows `Kind:` at every level. */
export function isId(value: unknown): value is Id {
  return kindOfId(value) !== undefined;
}

/** The kind of an id, read from its last `field:Kind:` segment or from its prefix when it has none; `undefined` for a string that is no id. */
export function kindOfId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.split(':');
  // `Kind:snowflake`, then `field:Kind:snowflake` for each level of nesting.
  if (parts.length < 2 || parts.length % 3 !== 2) return undefined;
  if (!NAME.test(parts[0]!) || !SNOWFLAKE.test(parts[1]!)) return undefined;
  for (let i = 2; i < parts.length; i += 3) {
    if (!NAME.test(parts[i]!) || !NAME.test(parts[i + 1]!) || !SNOWFLAKE.test(parts[i + 2]!)) return undefined;
  }
  return parts[parts.length - 2]!;
}

/**
 * The owner of an embedded id: the id without its last `:field:Kind:snowflake` segment. `undefined` for a top-level id and for a
 * string that is no id. It reads no store: the owner is in the id (design/core.md, "Ids").
 */
export function ownerOfId(value: unknown): Id | undefined {
  if (kindOfId(value) === undefined) return undefined;
  const parts = (value as string).split(':');
  return parts.length === 2 ? undefined : parts.slice(0, -3).join(':');
}

/** The field of the owner that holds an embedded id, read from its last segment; `undefined` for a top-level id and for a string that is no id. */
export function fieldOfId(value: unknown): string | undefined {
  if (kindOfId(value) === undefined) return undefined;
  const parts = (value as string).split(':');
  return parts.length === 2 ? undefined : parts[parts.length - 3];
}

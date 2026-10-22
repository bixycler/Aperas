// The orders of the engine (design/core.md, "Ordering"). `compareIds` is the only comparison that orders ids. The
// engine names no `position`: the key of a sort is the caller's, and a tie is broken by id. The shell uses the keyed
// comparison for the links of a block in Batch 11, and `compareIds` alone for every other set.
import { Refused } from './errors.ts';
import type { Id } from './interface.ts';

/**
 * Compare two ids by plain code point, never `localeCompare`. An id is ASCII by its grammar, and for ASCII the
 * comparison of two strings with `<` is the code-point order (one UTF-16 code unit is one code point), so digits come
 * before upper case, upper case before lower case, and a prefix before the longer string.
 */
export function compareIds(a: Id, b: Id): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The key of an item in a keyed sort: a number or a string. An absent key is `undefined`. */
export type SortKey = number | string;

/**
 * A comparison of ids by a key the caller passes, a tie broken by `compareIds`: numbers compare as numbers and strings
 * by code point. An id with no key sorts after those with one (design/core.md, "The order of links without a position"),
 * several without one by `compareIds`, so a list in which every key is absent comes out in the order of `compareIds`. A
 * pair of a number and a string is `Refused`: one sort has one sort of key.
 */
export function compareByKey(key: (id: Id) => SortKey | undefined): (a: Id, b: Id) => number {
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka === undefined && kb === undefined) return compareIds(a, b);
    if (ka === undefined) return 1;
    if (kb === undefined) return -1;
    if (typeof ka !== typeof kb) throw new Refused(`the keys ${JSON.stringify(ka)} and ${JSON.stringify(kb)} are of two sorts`);
    const c = typeof ka === 'number' ? ka - (kb as number) : ka < (kb as string) ? -1 : ka > (kb as string) ? 1 : 0;
    return c !== 0 && !Number.isNaN(c) ? Math.sign(c) : compareIds(a, b);
  };
}

// The grammar of a graph's name (design/core.md, "Graphs in memory"): the host of a URL authority, the hostname rule of RFC 1123 in
// lowercase. Labels are joined by dots; a label is letters (a to z), digits and hyphens, 1 to 63 characters, with no hyphen at either end
// (it may start with a digit); a name is at most 253 characters, with no dot at either end and no empty label. The name `id` is the
// one authority that `aperas://id/` gives a fixed meaning, so it is refused. No other name has a special case. The shell imports this
// file so that the shell and the engine read names one way.
import type { GraphName } from './interface.ts';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The name that `aperas://id/` reserves. */
export const RESERVED_GRAPH_NAME = 'id';

/** Whether a string is a graph's name. */
export function isGraphName(value: unknown): value is GraphName {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253 || value === RESERVED_GRAPH_NAME) return false;
  return value.split('.').every((label) => LABEL.test(label));
}

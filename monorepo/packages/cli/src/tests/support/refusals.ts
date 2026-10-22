// The checks of a refusal, for a test that runs the engine and the oracle on one write: the class is `Refused` in both. A write to a subject
// that has no record is refused with a message that begins "refused: no node", which tells it from the other refusals (a field outside the
// shape, a value of the wrong sort, a second value in a field that holds one, a rule of ids).
import { Refused } from '@aperas/core/apeironNgn/engine';
import { Refused as OracleRefused } from './oracle.ts';

/** A refusal, of the engine or of the oracle. */
export const refused = (err: unknown): boolean => err instanceof Refused || err instanceof OracleRefused;

/** The refusal of a write whose subject has no record. */
export const noNode = (err: unknown): boolean => refused(err) && (err as Error).message.startsWith('refused: no node ');

/** A refusal that is not that of a write to a subject with no record: the shape of the schema, or a rule of ids. */
export const refusedInShape = (err: unknown): boolean => refused(err) && !noNode(err);

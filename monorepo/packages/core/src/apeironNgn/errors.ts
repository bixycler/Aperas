// The errors of the engine besides `NotBuiltError` (`engine.ts`). `Refused` is read by the shell and the tests by class.

/**
 * A request the design states a rule against: an id that fails the grammar, an id taken, a kind that is not one, a write whose
 * subject has no record, a field the kind does not declare, a value of the wrong sort, a second value in a field that holds one.
 */
export class Refused extends Error {
  constructor(message: string) {
    super(`refused: ${message}`);
    this.name = 'Refused';
  }
}

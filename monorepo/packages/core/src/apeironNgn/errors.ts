// The errors of the engine besides `NotBuiltError` (`engine.ts`). Both are read by the shell and the tests by class.

/**
 * A meaning the design leaves open (design/core.md, "Open points"). The engine puts each one in a single function,
 * which throws this error with the name of the open point until the point is decided.
 */
export class Undecided extends Error {
  readonly point: string;
  constructor(point: string) {
    super(`undecided: ${point}`);
    this.name = 'Undecided';
    this.point = point;
  }
}

/** A request the design states a rule against: an id that fails the grammar, an id taken, a kind that is not one. */
export class Refused extends Error {
  constructor(message: string) {
    super(`refused: ${message}`);
    this.name = 'Refused';
  }
}

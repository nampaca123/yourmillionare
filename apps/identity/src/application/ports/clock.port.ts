// Port: clock abstraction for testable timestamp generation.

export interface Clock {
  now(): Date;
}

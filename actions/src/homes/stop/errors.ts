// The stop home's refusal (T-590): a reading, a message or a word it cannot read. Its message names a fault or an
// argument, never a value: no number, address, name or person's words (K-08 v1 "never the raw number or words").

export class StopHomeError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length === 0 ? message : `${message}: ${problems.join("; ")}`);
    this.name = "StopHomeError";
    this.problems = problems;
  }
}

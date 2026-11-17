// The change home's refusal (T-594): a reading, a request or a point it cannot read. Its message names a fault or an
// argument, never a value: no id, number, name, price or person's words (K-08 v1 "never the raw number or words").

export class ChangeHomeError extends Error {
  readonly problems: readonly string[];

  constructor(message: string, problems: readonly string[] = []) {
    super(problems.length === 0 ? message : `${message}: ${problems.join("; ")}`);
    this.name = "ChangeHomeError";
    this.problems = problems;
  }
}

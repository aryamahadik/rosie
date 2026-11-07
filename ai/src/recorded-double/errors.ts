// The two ways the recorded-model double fails, both loud (T-004).

/** A request the double has no recording for. It never answers with a fallback. */
export class NoRecordingError extends Error {
  readonly kind: string;
  readonly key: string;

  constructor(kind: string, key: string) {
    super(
      `recorded-model double: no recording for this ${kind} request (key ${key}); record it, or seed it from a K-02 fixture, in ai/recordings`,
    );
    this.name = "NoRecordingError";
    this.kind = kind;
    this.key = key;
  }
}

/** A recordings file the double refuses to load: one line per problem, each naming its recording. */
export class RecordingRefusedError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `recorded-model double: ${String(problems.length)} problem(s) in the recordings, none loaded:\n${problems.map((line) => `  - ${line}`).join("\n")}`,
    );
    this.name = "RecordingRefusedError";
    this.problems = problems;
  }
}

// What the context builder throws. Each is a fault in the context code hands it (the frontier builder, C-075) or in the
// call, found before any model call: it is loud and nothing is sent. A message names ids, keys, steps and counts only,
// never a person's words or a fact's value, so it may be logged (K-08 README: never the raw number or words).

/**
 * A context that cannot become a prompt: more than 60 choices or none, one choice or fact given twice differently, a
 * turn with no text, a time that is not one, a seed that is not a 32-bit count.
 */
export class ContextRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextRefusedError";
  }
}

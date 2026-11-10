// What decide's one read throws. A failed model call or a bad answer is never one of these: they are the typed
// `modelsDown` and `refused` answers. These are for a read that cannot be asked at all, a fault in the calling code,
// found before any model call: loud, and nothing is sent. A message names the request, never a person's words.

/**
 * A read asked for a purpose that is not decide's (decideFirst, decideCheck or reread), or of a model not haiku or sonnet;
 * or two reads compared that are not both K-02 reads, or on stakes K-02 does not have (T-369's agreeReads).
 */
export class DecideRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecideRequestError";
  }
}

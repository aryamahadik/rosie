// What decide's reads throw (one read, two reads, the one re-read). A failed model call or a bad answer is never one of
// these: they are the typed `modelsDown` and `refused` answers. These are for a read that cannot be asked at all, a
// fault in the calling code, found before any model call: loud, and nothing is sent. A message names the request, never
// a person's words.

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

/**
 * A second request for the turn's one Sonnet re-read (arch 02 line 119 and arch 06 line 289: once per turn; Q-41): the
 * result already holds the re-read, or this decider has already run the turn's re-read since the turn's last decide.
 * Refused before any call, so nothing is sent (T-370).
 */
export class RereadRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RereadRefusedError";
  }
}

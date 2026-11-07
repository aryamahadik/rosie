// What the prompt layout throws. Each is a fault in the code or the bundle, found before any model call: it is loud and
// nothing is sent.

/**
 * A prompt that cannot be laid out: a bundle whose texts are not the ones it was published with, a turn of another
 * bundle, a card that is not the bundle's own, an empty part.
 */
export class CacheLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheLayoutError";
  }
}

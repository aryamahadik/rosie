// What the gateway throws. A failed model call is never one of these: it is the typed `modelsDown` result. These are
// for a call that cannot be made at all, which is a fault in the code or the setup, so it is loud and makes no call.

/** The gateway was set up with something it refuses: a model id outside the two, a trace of another bundle. */
export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

/** The key's environment variable is not set. The message names the variable, never a value. */
export class MissingKeyError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`${variable} is not set in the environment`);
    this.name = "MissingKeyError";
    this.variable = variable;
  }
}

/** A request the gateway does not carry: the safety read has its own path (2 s per model, arch 04 line 231). */
export class NotForTheGatewayError extends Error {
  constructor(purpose: string) {
    super(`a ${purpose} call does not go through the AI gateway`);
    this.name = "NotForTheGatewayError";
  }
}

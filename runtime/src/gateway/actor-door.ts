// The gateway's door to the handle's Durable Object (T-243; C-044). The namespace is the HANDLE_ACTOR binding of
// wrangler.jsonc (T-276; not edited here, NQ-RT-5); the class behind it and its ordered inbox are T-244's. The door
// asks the namespace for the object named by the handle (`idFromName`), so every event of one handle reaches one
// actor and two handles reach two, and calls the object's `accept` with the sealed hand-off. For an event the actor
// already holds, the door can ask it which trace the event first arrived under (`firstTraceOf`, T-1108).

import type { SealedHandoff, StoreAnswer, ActorStub } from "./types";

/** The methods the gateway calls on the handle's actor (T-244 writes `accept`: the seen-event-id check and the write in one step). */
export interface HandleActorRpc {
  accept(handoff: SealedHandoff): Promise<StoreAnswer>;
  /** The trace id a stored event first arrived under, or null when the actor holds no such event (T-1108). */
  firstTraceOf?(eventId: string): Promise<string | null>;
}

/** The slice of a Durable Object namespace the door uses. */
export interface ActorNamespace<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): HandleActorRpc;
}

/**
 * The actor door over a Durable Object namespace. Anything but "written" or "duplicate" from the actor (a throw, a
 * rejected call, a malformed answer) is a failed write: it throws, and the gateway answers 503. `firstTrace` answers
 * null for an actor that has no such call, or whose answer is not a trace id.
 */
export function durableObjectActor<Id>(namespace: ActorNamespace<Id>): ActorStub {
  return {
    async accept(handoff) {
      const stub = namespace.get(namespace.idFromName(handoff.actorName));
      const answer: unknown = await stub.accept(handoff);
      if (answer !== "written" && answer !== "duplicate") throw new Error("the handle actor gave no answer");
      return answer;
    },
    async firstTrace(handoff) {
      const stub = namespace.get(namespace.idFromName(handoff.actorName));
      if (stub.firstTraceOf === undefined) return null;
      const answer: unknown = await stub.firstTraceOf(handoff.event.eventId);
      return typeof answer === "string" && answer !== "" ? answer : null;
    },
  };
}

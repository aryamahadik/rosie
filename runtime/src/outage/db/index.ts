// PostgreSQL down (T-270; C-175): turns queue in order in each handle's actor, a text waiting 20 s gets the outage line
// once, STOP and START are taken by the actor from its copies, a running safety timer fires from its copy, and on return
// the write-on-return queue replays danger, then stops, then the rest, before any queued turn. The handle actor runs it
// (runtime/src/actor/handle-actor.ts); D-017 joins its ports with `setDbOutageDeps`.

export {
  createOutageTables,
  DbOutage,
  OUTAGE_WAIT_MS,
  PROBE_MS,
  SCHEDULE_DB_OUTAGE,
  SEND_RETRY_MS,
  setDbOutageDeps,
  STOP_OR_START_CALL,
  TIMER_RETRY_MS,
  type DbOutageHost,
} from "./outage";
export * from "./types";

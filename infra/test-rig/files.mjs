// The Workers test rig's named files (T-1253; ADR-014 section 4, "The Workers test pool, local runs and CI"; the D-017
// path audit's P0, ops/reviews/D-017-path-audit/order_d017.txt line 28; critic_collisions B3). Every Workers test file
// that gets a PostgreSQL database of its own is named here, up front, so no later part edits the rig's globalSetup, this
// list or vitest.config.ts: a later part only writes its test file, and its seed module when it needs rows.
//
// Each entry:
//   key   upper-case letters, digits and _: the file's pool bindings are HYPERDRIVE_JOB_<key> and HYPERDRIVE_APP_<key>,
//         and its database is rosie_rig_<run>_<key in lower case>. The test file holds the same key as a constant.
//   test  the Workers test file, from the repository root. While it does not exist it gets no database, and its two
//         bindings name rosie_rig_none, which is never made, so a connect through them fails.
//   seed  its seed module, from the repository root: `export async function seed(sql)` (or `export const seed`), called
//         once with a postgres.js client on the file's database, as the connecting login (a superuser on every server
//         the rig runs on), after the migrations and bundle v0. It may call db/seeds' sets (core.ts, skeleton.ts) or
//         write rows of its own. While it does not exist the database is migrated, holds bundle v0, and nothing more.
//         It runs in Node, but Vitest loads it through the Workers project's module runner, which resolves a package
//         with workerd's conditions: it uses the client it is handed and imports no package whose workerd build needs
//         the Workers runtime (postgres.js's does: rig.mjs loads postgres.js's Node build for itself).
//
// The names after the rig's own file are the audit's parts, at the paths order_d017.txt lines 29 to 49 give
// (runtime/src/wiring/staging/<name>.ts and its test), copied exactly; each comment names the part and its card.
export const RIG_FILES = Object.freeze([
  // The rig's own first tests (T-1253; ADR-014 "The rig's first tests (piece 5)").
  {
    key: "RIG",
    test: "runtime/test/rig/rig.worker.test.ts",
    seed: "runtime/test/rig/rig.seed.ts",
  },
  // P1a (T-1254): the Worker's database handle and its guard. The only file with the wrong logins (WRONG_LOGINS below).
  {
    key: "DB",
    test: "runtime/src/wiring/staging/db.worker.test.ts",
    seed: "runtime/src/wiring/staging/db.seed.ts",
  },
  // P1c: the release flags over readFlag.
  {
    key: "FLAGS",
    test: "runtime/src/wiring/staging/flags.worker.test.ts",
    seed: "runtime/src/wiring/staging/flags.seed.ts",
  },
  // P2a: handleKey, chatOpenCall.
  {
    key: "K05_RECEIPT",
    test: "runtime/src/wiring/staging/k05-receipt.worker.test.ts",
    seed: "runtime/src/wiring/staging/k05-receipt.seed.ts",
  },
  // P2b: bundleReads, handleTargets, frontierScope, turnRows.
  {
    key: "K05_TURN",
    test: "runtime/src/wiring/staging/k05-turn.worker.test.ts",
    seed: "runtime/src/wiring/staging/k05-turn.seed.ts",
  },
  // P3a: safetyReaders, composers and deciders.
  {
    key: "MODELS",
    test: "runtime/src/wiring/staging/models.worker.test.ts",
    seed: "runtime/src/wiring/staging/models.seed.ts",
  },
  // P3b: the bundle-backed BundleSafety.
  {
    key: "BUNDLE_SAFETY",
    test: "runtime/src/wiring/staging/bundle-safety.worker.test.ts",
    seed: "runtime/src/wiring/staging/bundle-safety.seed.ts",
  },
  // P4a: gateReads and SafetyDeps.words.
  {
    key: "TOOL_API_GATE",
    test: "runtime/src/wiring/staging/tool-api-gate.worker.test.ts",
    seed: "runtime/src/wiring/staging/tool-api-gate.seed.ts",
  },
  // P4b: composeReads, finalizeData and the dataAccess rows.
  {
    key: "TOOL_API_ROWS",
    test: "runtime/src/wiring/staging/tool-api-rows.worker.test.ts",
    seed: "runtime/src/wiring/staging/tool-api-rows.seed.ts",
  },
  // SR: stateReads bound on staging.
  {
    key: "STATE_READS",
    test: "runtime/src/wiring/staging/state-reads.worker.test.ts",
    seed: "runtime/src/wiring/staging/state-reads.seed.ts",
  },
  // P6b (T-1305): RootOptions.testPhone.
  {
    key: "TEST_PHONE",
    test: "runtime/src/wiring/staging/test-phone.worker.test.ts",
    seed: "runtime/src/wiring/staging/test-phone.seed.ts",
  },
  // P5: outboxCalls, sendStateCall, linqSendCall and armingCalls.
  {
    key: "SEND",
    test: "runtime/src/wiring/staging/send.worker.test.ts",
    seed: "runtime/src/wiring/staging/send.seed.ts",
  },
]);

// ADR-014 section 2's wrong logins, for T-1254's file only (the guard's refusals, piece 6), each behind a pool binding
// named up front: HYPERDRIVE_<WRONG_LOGINS.key>_<case>, on that file's database (rosie_rig_none while it has none).
// Every login here is right in every way but its case: LOGIN and none of SUPERUSER, CREATEDB, CREATEROLE, REPLICATION
// and BYPASSRLS, granted rosie_job WITH INHERIT TRUE, SET FALSE (the runtime side's shape), plus what its case adds. Each
// is named rosie_rig_..., so the guard's first check (session_user and current_user are rosie_worker_job) refuses it
// too; its own case is what the guard's other reads show. Made only when missing, on a local or CI server only, with its
// own name as its local password; they are cluster-wide, so two runs share them and none is ever dropped.
//   superuser          the connecting login itself (rosie on the local and CI servers), with its own password.
//   both_roles         also granted rosie_app WITH INHERIT TRUE, SET FALSE: it inherits both roles.
//   other_role         also a member of rosie_app WITH INHERIT FALSE, SET FALSE: a member of the other role.
//   owner              owns businesses in the file's database (made per run there; the drop takes it away).
//   second_membership  also granted pg_read_all_data WITH INHERIT TRUE, SET FALSE: a second membership.
//   login_schema       a schema named after it in the file's database, which it may use, so its current_schema() is
//                      that schema, not public (the server's search_path starts with "$user").
export const WRONG_LOGINS = Object.freeze({
  key: "DB",
  cases: Object.freeze([
    { binding: "SUPERUSER", login: null },
    { binding: "BOTH_ROLES", login: "rosie_rig_both_roles" },
    { binding: "OTHER_ROLE", login: "rosie_rig_other_role" },
    { binding: "OWNER", login: "rosie_rig_owner" },
    { binding: "SECOND_MEMBERSHIP", login: "rosie_rig_second_membership" },
    { binding: "LOGIN_SCHEMA", login: "rosie_rig_login_schema" },
  ]),
});

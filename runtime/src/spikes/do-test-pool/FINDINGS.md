# T-1128 findings: a Durable Object, an alarm, a queue message and a cron handler under the Workers test plugin

For the runtime engineer (T-244 handle actor, T-254 clocks, T-256 retries). Run with `npm run test:workers` (Vitest 5.1, `@cloudflare/vitest-plugin` 1.6, project "workers" on wrangler.jsonc's `staging` environment). Nothing in `vitest.config.ts`, `wrangler.jsonc` or `runtime/src/index.ts` was changed.

## Answers

| #   | Question                                                  | Answer                                                                                               | The test that shows it                                                       |
| --- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | A Durable Object with its own storage per test?           | Yes, with `afterEach(reset)`. The plugin does not isolate storage by itself.                         | `storage.worker.test.ts` (isolation), `no-auto-isolation.worker.test.ts`     |
| 2   | Fire an alarm on demand (a 10-minute alarm, no waiting)?  | Yes: `runDurableObjectAlarm(stub)` runs `alarm()` now and clears it.                                 | `alarm.worker.test.ts`, first test (set for 10 minutes, fires in about 1 ms) |
| 3   | Deliver a queue message to a consumer?                    | Yes, by calling the consumer's `queue()` with `createMessageBatch()` and reading `getQueueResult()`. | `queue.worker.test.ts`                                                       |
| 4   | Run a cron handler?                                       | Yes, by calling `scheduled()` with `createScheduledController()` and `waitOnExecutionContext()`.     | `cron.worker.test.ts`                                                        |

The 17 spike tests pass under `npm run test:workers` and `npm test` on the config as it stands (22 tests in the workers project with the 5 health tests).

## How each is done

### 0. Getting a Durable Object into the test (the part that needs care)

- The plugin runs one Worker, the `main` of wrangler.jsonc (`runtime/src/index.ts`). It builds a Durable Object by looking its class up in that module's exports, then wrapping it. So a class defined in a test file or in the spike folder cannot be bound by itself, and `index.ts` exports no `HandleActor` before T-244. Without the export, calling the stub throws `runtime/src/index.ts does not export a HandleActor Durable Object`.
- The namespace exists under `exports` from `cloudflare:workers` (`exports.HandleActor`), not under `env`. It is there because wrangler.jsonc's top-level `migrations` entry (`new_sqlite_classes: ["HandleActor"]`, T-276) declares the class. With that line removed, `exports.HandleActor` is `undefined` (tried, then restored). So T-276's migration is what the test plugin reads.
- `env.HANDLE_ACTOR` does not exist in the pool: the pool uses `env.staging`, and `env.staging` has no `durable_objects` (nor `queues`, nor `kv_namespaces`) until T-566. `Object.keys(env)` is only `ENVIRONMENT`, `BASE_PATH`, `DB_SCHEMA`, `GIT_SHA` and the plugin's own `__VITEST_POOL_WORKERS_*` keys. Use `exports.HandleActor` until T-566, then `env.HANDLE_ACTOR`.
- The spike has no real `HandleActor`, so `spike-actor.ts` defines `SpikeActor`, and `publishSpikeActorAsHandleActor()` sets it as the `HandleActor` export of the loaded `main` module for one test file (`beforeAll`) and puts it back (`afterAll`). This works because Vite's module object is plain and its properties are configurable; the plugin and the test import the same module instance. It is a workaround for the spike only. When T-244 exports the real class, drop the call and use `exports.HandleActor` the same way; the rest of each test is unchanged.
- Each test file runs in its own isolate, so this change did not leak into `index.worker.test.ts` (the existing health tests pass beside the spike).
- The Durable Object is SQLite-backed (migration `new_sqlite_classes`): `ctx.storage.sql` works in the test as well as `put`, `get` and `list`.

### 1. Storage per test

- `storage.worker.test.ts`: test 1 writes `draft`, test 2 (same actor name) finds it gone. Different names are different actors with separate storage.
- Isolation is not automatic. `no-auto-isolation.worker.test.ts` shows it: with no `reset()`, test 2 still reads what test 1 wrote, in the same file (the plugin README's "isolated per-test storage" does not hold for Durable Objects here). Use one of:
  - `afterEach(async () => { await reset(); })` from `cloudflare:test`: deletes all data of all bindings and Durable Objects, alarms included;
  - or a name no other test uses (`idFromName(crypto.randomUUID())`).
- After `reset()`, take a new stub: a stub from before it throws `Application called deleteAllDurableObjects()`.
- `evictDurableObject(stub)` clears the instance's memory (fields) and keeps its storage and alarm: use it to test "the actor recovers from storage" (arch-01-04 'actor-local copies').
- `runInDurableObject(stub, (instance, state) => ...)` runs a callback inside the actor, for seeding and reading storage or calling methods without a public RPC.
- Not available now: `listDurableObjectIds(...)` throws "Expected to find bound name for namespace" because the namespace is not an `env` binding (waits for T-566).

### 2. Alarm on demand

- `await actor.scheduleIn(600_000)` (a `setAlarm(Date.now() + 10 min)`), then `await runDurableObjectAlarm(actor)`: returns `true`, the actor's `alarm()` has run once, `getAlarm()` is `null` afterwards, a second call returns `false`. The real clock does not move and no fake timers are needed; the 10 minutes are never waited out.
- An alarm set again replaces the first (one alarm per actor, as architecture section 10 wants: the earliest clock row).
- An alarm survives `evictDurableObject` and still fires. `reset()` removes it.
- `runDurableObjectAlarm` runs the alarm whatever its time: a test of "not yet due" must test the row choice in `alarm()` itself with a clock the test controls (pass the clock in; do not rely on the alarm time).

### 3. Queue message to a consumer

- A consumer is an exported handler `queue(batch, env, ctx)`. In the test: `createMessageBatch(queueName, messages)`, `createExecutionContext()`, call the handler, then `await getQueueResult(batch, ctx)`. The result has `explicitAcks` (message ids), `retryMessages` (message ids), `ackAll`, `retryBatch` and `outcome`.
- Effects of the consumer on a Durable Object are checked through its stub (the consumer wrote `queued:<id>` into the handle's actor).
- Limits: the plugin runs no real queue. `env.RETRY_QUEUE` is absent until T-566, so a producer's `send()` cannot be tested yet; test the producer with a fake binding object until then. The `delaySeconds` of `message.retry()` is not reported in `retryMessages` (only `msgId`), so a test cannot check the delay. `attempts` is whatever the test passes; the hop to `rosie-retry-dlq` after 5 tries is queue-service behaviour and is not simulated: T-256 must test its own "attempt > max_retries" branch by passing a high `attempts` and checking the code's effect.
- The default export of `index.ts` has no `queue()` today; T-256 adds it, and the test can then call it the same way as `worker.fetch` in `index.worker.test.ts`.

### 4. Cron handler

- `createScheduledController({ scheduledTime, cron: "* * * * *" })`, `createExecutionContext()`, call `handler.scheduled(controller, env, ctx)`, then `await waitOnExecutionContext(ctx)` so `ctx.waitUntil()` work has finished before asserting.
- The plugin never fires wrangler.jsonc's `triggers.crons` by itself; the test picks the cron string and time. The trigger declaration is checked by `infra/ci/wrangler-config.test.mjs`, not here.
- A minute sweep (T-254) can be tested end to end: `scheduled()` finds due rows and calls `setAlarm` on the actor, then `runDurableObjectAlarm(stub)` fires it (the second test of `cron.worker.test.ts`).

## What the handle actor and clocks tests should copy

1. `beforeAll`: nothing special once T-244 exports `HandleActor` (until then, `publishSpikeActorAsHandleActor`).
2. `afterEach(reset)`; take stubs inside each test.
3. Actor: `exports.HandleActor` (`env.HANDLE_ACTOR` after T-566), `idFromName(handle)`.
4. Alarms: `runDurableObjectAlarm`; recovery: `evictDurableObject`; seeding or peeking: `runInDurableObject`.
5. Queue: `createMessageBatch` + `getQueueResult`; cron: `createScheduledController` + `waitOnExecutionContext`.

## Needs that are not this card's (for the lead)

- T-566 (env.staging copies of `durable_objects`, `queues`, `kv_namespaces`) is needed before tests can use `env.HANDLE_ACTOR`, `env.RETRY_QUEUE`, `env.BUNDLES` or `listDurableObjectIds`. The spike worked around it with `exports.HandleActor`; it could not check a producer `send()` or `env.HANDLE_ACTOR`. That `env.HANDLE_ACTOR` works once T-566 lands is expected, not shown.
- Each worker run prints wrangler's warning about `durable_objects`, `kv_namespaces` and `queues` missing on `env.staging` (also before this spike); it clears with T-566.
- Candidates for deletion when T-244 and T-254 have their own tests: this whole folder (no product file imports it); `no-auto-isolation.worker.test.ts` can go first.

## Time

About 6 minutes of working time (02:15 to 02:21 on the local clock), against the 2 hours allowed.

# actions (`@rosie/actions`)

**Owner:** the action-layer engineer (build prompt section 4). **Checked by:** QA and security.

The Tool API and the frontier; the gate and limits 1 to 6; the one commit per turn; the claim check (limit 7) and the message checks; the domain services; the effects runner; the Agent API (MCP and REST); reconciliation (architecture sections 02, 03, 05, 06, 07 and 10).

Code lives in `src/`, with unit tests beside it (`src/**/*.test.ts`, Vitest project `unit`). It runs inside the Worker, typed with the Workers and Node types of the root `tsconfig.json` (the Worker runs with `nodejs_compat`).

## `src/tool-api/`: the Tool API base (T-290; C-074, C-038)

Every call of K-09 v1 (`contracts/tool-api`, `$defs/callName`: 29 calls) is registered with a handler; each call's own logic is T-291 onward, and until then every handler is a stub that answers `notBuilt`. One call runs in this order (`tool-api.ts`):

1. Its K-08 v1.1 span opens on the caller's trace context (`runtime/src/trace`): the trace's id and bundle id, the trace's handle id (never a number), the call and the caller's kind as labels, and in the end what was answered and the error code. Nothing else of the request reaches it, so never a phone number or a person's words (K-08 v1 "Never the raw number or words"); the trace refuses a span that breaks K-08 before it is logged.
2. The name must be a call of K-09 v1, else `unknownCall`.
3. The request must pass `$defs/<call>.request` and name the trace the call runs in (`caller.traceId`), else `invalidRequest` with one problem line each (a path and what the schema wants, never a value).
4. The request must name a business (`caller.businessId`), else `noBusinessScope`: row-level security scopes every Tool API call by its business (arch 10 line 546; K-04 v1 rule 4), so no call runs unscoped.
5. The handler runs inside one transaction scoped to that business (`scope.ts`): the scope is set before the handler gets its repo, so nothing is read before it.
6. The handler's answer must pass `$defs/<call>.response` or `$defs/<call>.errors`. An error answer comes back as it is and rolls the transaction back (K-09: each error is "Refused, nothing written"); an answer that passes neither is the handler's fault, rolled back and thrown (`ToolApiContractError`), never passed on.

Steps 2 to 4 answer before anything is read or written.

| File              | What it holds                                                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `calls.ts`        | The call list, each call's request, response and errors as the generated `@rosie/contracts` types name them (`npm run contracts:types`, type imports only), and each call's span hop |
| `validator.ts`    | The one Ajv 2020-12 validator in strict mode (02-contracts section 2 item 8): K-09 v1.5, K-08 v1.1 and every schema their `$ref`s reach, from `contracts/`; prebuilt for the Worker  |
| `scope.ts`        | The business-scope seam (`withBusiness`), and its adapter over the database client's scoped transaction (`db/repo/client.ts`, on the primary)                                        |
| `errors.ts`       | The base's own refusals and errors                                                                                                                                                   |
| `tool-api.ts`     | `createToolApi`, the handler and context types, `notBuiltHandlers`                                                                                                                   |
| `test-support.ts` | The recording repo fake (no database), the test trace and K-09's fixtures, for the tests only                                                                                        |

### Defaults used (for `ops/QUESTIONS.md`)

1. **The base's refusals.** K-09 v1 has no error for a request its schema refuses, for a request with no business, or for a call not built yet, so the base answers `{"error": "invalidRequest", "call", "problems"}`, `{"error": "noBusinessScope", "call"}`, `{"error": "unknownCall"}` and `{"error": "notBuilt", "call"}`, in the contract's error shape (02-contracts section 2 item 2: a JSON object with its own `error` code). A K-09 minor version may adopt them.
2. **No call runs without a business.** K-09 v1 lets `caller.businessId` be null "where no business exists yet, or for a call that covers every business (a STOP: RULES 7.2)"; the base refuses such a call before any read, as T-290's card asks. Two accepted fixtures are refused this way: `stop-recorded.json` and `start-recorded.json` (a STOP and a START for every business). The task that builds `recordStopOrStart` and the core-only turn decides their every-business path with the database engineer (K-04 v1 rule 4's unscoped runtime side) and the security reviewer. `plannerVerbs` has no caller (it rides inside `gateAndCommit`), so it is refused alone the same way.
3. **The hop of each call's span** (K-08 v1 hop table; K-09 `caller.traceId` names the hops): a page's call is `pageRequest` and an agent's `agentApiRequest`, whatever the call; otherwise `buildFrontier` is `frontier`, `closestEntries` `search`, `gateAndCommit` and `plannerVerbs` `gate` (limits 1 to 6 logged as `notChecked` until a handler logs them), `matchKinds`, `lookupListing` and `readSetup` `frontier` (the frontier builder's reads), `composeInput` and `finalizeMessage` `fillAndChecks` (K-08 v1 requires a model call on the `compose` hop, and `composeInput` makes none), and every other call `commit`.
4. **A span's outcome:** `ok` for a response; `failed` for `transient` and `bookingPaused` (the database could not run the call), an answer outside the contract or a throw; `refused` for every other error and refusal.

### Open points

- **Ajv in the Worker** (closed by T-1144, T-1150 and T-1165): inside the Worker the Tool API's checks (K-09 v1.5's definitions of K-09 v1's calls, K-08 v1.1's span), the frontier's (K-02 v1.1) and compose input's K-03 check (`src/compose-input/check.ts`, K-03 v1's and v1.1's composeInput, its own module) run as Ajv's standalone code, which `npm run build:validators` builds ahead of time for the same definitions and options and holds to Ajv's compiler on the contracts' fixtures (`infra/build/tool-api-validators.mjs`; `validator.worker.test.ts`, `src/frontier/assemble/check.worker.test.ts`, `src/compose-input/check.worker.test.ts`), so no code is made at run time; Node keeps Ajv's compiler. Since T-1174 the validator checks composeInput by K-09 v1.6's definitions in Node; the prebuilt code holds v1.5's alone until the build compiles v1.6's composeInput (T-1174's NEED).
- **The scope seam** is the database client's scoped transaction for now; lead card T-1083 (a lost-connection-safe scoped transaction for every repo call) replaces the adapter in `scope.ts` only.

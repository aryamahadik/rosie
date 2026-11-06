# runtime (`@rosie/runtime`)

**Owner:** the runtime engineer (build prompt section 4). **Checked by:** QA.

The Cloudflare Worker: the gateway, the handle actor (safety read on arrival, batch, turn lease), the guard, clocks and queues, the outbox dispatcher and limit 8, and the safety and STOP lines sent from the actor (architecture sections 02, 04, 10 and 11). `src/index.ts` is the Worker's entry point (`main` in `wrangler.jsonc`).

## D-000: the health endpoint, the only runtime code so far

- `GET {BASE_PATH}/health` answers 200 with JSON `{ ok: true, environment, version, trace_id }` and the header `x-trace-id`. Every other path answers 404 with JSON `{ ok: false, error: "not_found", trace_id }` and the same header.
- The trace id is the incoming `x-trace-id` when it is a valid id (a UUID, in any case, returned in lower case), else a new `crypto.randomUUID()`. Each request writes one JSON log line, `{ level, msg, trace_id, environment, version }`, read in Workers Logs.
- `version` is the `GIT_SHA` var that each deploy sets (`--var GIT_SHA:<sha>`). `ENVIRONMENT`, `BASE_PATH` (`/test` on staging) and `DB_SCHEMA` (a preview's `preview_<slug>`) come from `wrangler.jsonc`.
- Bindings are typed by declaration merging on `Cloudflare.Env` (in `src/index.ts`). The Worker requires no secrets yet (`secrets.required` is empty in `wrangler.jsonc`), so no key from `.dev.vars` reaches local runs or tests.

## Tests

- `src/**/*.worker.test.ts` run inside the Workers runtime (Vitest project `workers`, through `@cloudflare/vitest-plugin`), with `wrangler.jsonc`'s staging environment: `npm run test:workers`.
- Other `src/**/*.test.ts` files run under Node (project `unit`): `npm run test:unit`.

## Running it

- Locally: `npm run cf -- dev --env staging` (wrangler always runs through `infra/scripts/cf.sh`).
- A branch preview: `npm run deploy:preview -- <branch>`. Staging: `npm run deploy:staging` (CI, from `main`), back only with `npm run rollback:staging`. No production deploy exists in D-000.

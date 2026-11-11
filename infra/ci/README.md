# infra/ci

The CI scripts: the guards `ci.yml` and `merge-check.yml` run (`test-guard.mjs`, `migration-guard.mjs`, `contract-freeze-guard.mjs`), the tests of the guards, the PreToolUse hook, the `infra/scripts` shell scripts and the validators' build in `infra/build` (`npm run test:ci-scripts`), and the local merge-check below. Owner: the release engineer.

`put-staging-secrets.test.mjs` tests `infra/scripts/put-staging-secrets.sh` (`npm run secrets:staging`, T-568) in a throwaway checkout with a made-up `.dev.vars`, the real `cf.sh` and a stand-in for wrangler: each value reaches wrangler on standard input only, the output holds names with `set` or `missing` and never a value, any `--env` but staging is refused before a value is read, and the script's names are the ones the runtime reads.

`make-staging-secrets.test.mjs` tests `infra/scripts/make-staging-secrets.sh` (`npm run secrets:staging:make`, T-1236), which makes staging's own two secrets in place, in a throwaway checkout with the real `cf.sh`, a stand-in for wrangler that keeps a made-up list of the names staging holds, and a recorder in front of node: a name staging does not hold and `.dev.vars` has no value for gets a fresh value of its form on standard input only (32 random bytes as base64, with `whsec_` in front for the webhook secret), different on each run; a name `secret list` shows is left alone, and a name with a value in `.dev.vars` is left to `secrets:staging`; any `--env` but staging, any name off the list, a list that fails or is not wrangler's JSON list, and a generator that gives another form are refused before anything is made or put; and no command the script starts holds a value in its environment or its arguments, whatever the caller's shell holds.

## The local merge-check (T-1111, DL-190)

GitHub Actions refuses to start jobs on this account (DL-165, DL-186), so the merge-check runs on the build Mac instead, with the same checks. The lead runs it once per branch before a merge (DL-063, DL-065), one run at a time and not beside heavy builder runs (DL-164):

```sh
git fetch origin
npm run merge-check:local -- task/T-xxx
npm run merge-check:local -- task/T-xxx --ai-change   # the branch changes what the AI does
```

`--verbose` also prints every step's output (it always goes to the log). A full run on a quiet Mac takes a few minutes; the parity shards add more when a parity input changed.

### What it runs

It reads `.github/workflows/merge-check.yml` at `origin/main` (the file `gh workflow run merge-check.yml` runs, from the default branch) with a small YAML reader for that file's shape, and runs its steps in the file's order. The step list is never written down a second time, so the two cannot drift: a new or changed run step runs as written, and anything the runner cannot mirror (an action other than checkout and setup-node, an unknown key, an expression outside the `inputs`, `matrix`, `job`, `needs` and `steps` contexts) fails the run before any step starts. The runner then needs a change, in the same pull request as the workflow's.

1. The merge-check job, from its postgres service on:
   - The service: a throwaway database of the run's own (below).
   - The branch-name check, as written (the same regex).
   - `actions/checkout`: a fresh `git clone` of this repository's git store by path (no network, no token), with `origin/main` and the branch set to what this repository holds, then `git checkout --force -B <branch> origin/<branch>` as checkout does. The clone's push URL is a dead end, so nothing can be pushed from it.
   - The rebase onto `origin/main`, as written: a conflict fails the run (the lead hands the branch back as a rebase step).
   - `actions/setup-node`: `node --version` must match `.nvmrc` (22 matches any 22.x). The Mac's Node is used; nothing is installed.
   - Every run step, as written: `npm ci`, `contracts:types`, `contracts:check`, `format:check`, `lint`, `typecheck`, `npm test`, the CI script tests, the three guards, `migrate`, `test:scripts`, `test:integration`, `test:scenario`, `test:e2e`, then the eval smoke slice line with `--ai-change`, and the job summary (which runs after a failure too, as `if: always()` says).
2. The parity-inputs job: its rule (`git diff --name-only origin/main...HEAD` over the parity inputs), in the same clone.
3. The parity-shard job, only when that rule found a changed input: shards 1/3, 2/3 and 3/3, one after another. As the matrix's `fail-fast: false` says, every shard runs even when one fails.

Each run step runs as Actions runs a bash step: `bash --noprofile --norc -eo pipefail <script>`, with `CI=true`, the job's and the step's `env`, `${{ }}` filled in, and `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` as local files. Each job's `timeout-minutes` holds. The first failing step stops the run, and the run fails.

Where it differs from GitHub's runners, and why the bar is the same:

- All jobs share one clone. The leading steps a later job shares with an earlier one (the branch check, the checkout, the rebase, the Node check, `npm ci`) are done once and shown as `reused`; a step that differs runs again in the clone (parity-inputs' shorter rebase step does: on a rebased branch it is a no-op).
- Jobs run one after another, and a failure in the merge-check job skips the parity jobs (on GitHub they would still run beside it). The run fails either way.
- Steps get this shell's environment without git, GitHub, Cloudflare, npm, database or key variables, and git reads none of the user's own configuration. No secret, `.env` or `.dev.vars` is read.

### origin/main and the branch

- `origin/main` is this repository's remote-tracking ref (`refs/remotes/origin/main`) as last fetched, so run `git fetch origin` before each run. The local `main` branch is never used.
- The branch is the local branch `refs/heads/task/T-xxx`, else `refs/remotes/origin/task/T-xxx`. The result file names the ref used and its head; the lead checks that it is the pull request's head.

### The database

The merge-check job's service (`postgis/postgis:17-3.5`) is a database of the run's own in the local rosie-pg container (`npm run db:up`): `mc_<UTC time>_<6 hex>` on `127.0.0.1:54329`, with the local, non-secret `rosie` credentials of factory spec section 4. It is made from `template_postgis`, as the service image makes its database, and the run first checks that the local server runs the image's PostgreSQL and PostGIS versions (17 and 3.5). `DATABASE_URL` points at it for the merge-check job's steps, as the workflow's job `env` does; the parity jobs get no `DATABASE_URL`, as on GitHub. After the run, pass or fail (Ctrl-C included), it is dropped with `drop database ... with (force)`. The runner never drops any other database, and the dev database `rosie` is never touched.

`MERGE_CHECK_PG_URL` can name another PostgreSQL server on this Mac (its maintenance database; local hosts only); the tests use it.

### The result

Each run writes `scratch/ci/<branch, "/" as "-">-<short branch head>/` (git-ignored; a rerun of the same head replaces it):

- `merge-check.log`: every step's command and full output.
- `result.json`: `branch`, `branch_ref`, `branch_head`, `origin_main`, `rebased_commit` (the commit checked: the branch rebased onto `origin/main`, never pushed), `ai_change`, `result` (`success` or `failure`), `failed_step`, the times, the database, `jobs`, and `steps` (each step's job, name, command, status (`success`, `failure`, `skipped` or `reused`) and seconds).
- `summary.md`: the job summary the workflow's own steps write.

Exit codes: 0 only when every step passed; 1 when a step failed; 2 on a usage error; 130 when interrupted.

### Clean-up

A run that is killed outright (SIGKILL, a power cut) cannot drop its database or remove its clone. Databases: `npm run db:psql`, then `\l mc_*`, then `drop database "mc_..." with (force);` for each. Clones: `rosie-merge-check-*` folders in the system temp folder.

### Tests

`npm run test:ci-scripts` runs `local-merge-check.test.mjs` with the other CI script tests (`node --test infra/ci/local-merge-check.test.mjs` runs it alone). Its run tests need the local PostgreSQL (`npm run db:up`), or `DATABASE_URL`'s server inside a merge-check run: each run makes and drops a database of its own.

## The Workers pool's messages (T-1207, DL-420)

The `workers` and `e2e-workers` projects run their tests inside workerd: `@cloudflare/vitest-plugin`'s pool sends each test file's runner its modules over one WebSocket, and workerd closes that socket on a message over 33,554,432 bytes (32 MiB; close code 1009, which Vitest reports as "Worker exited unexpectedly"). With Vitest's module cache on disk (`fsModuleCache`, on by default), a new runner got every already-transformed module of its graph in one message: 33,125,602 bytes for hop9 on 5d69f31, and over the limit (a crashed runner) once test-phone's graph grew by gateway/pages' test support. So both projects set `fsModuleCache: false` in `vitest.config.ts`: each module goes in its own message, and the largest is the largest single module (the Tool API's generated validators, 13,213,756 bytes). The other projects keep the cache.

`workers-pool-messages.test.mjs` guards it: it checks the socket's limit in workerd at `wrangler.jsonc`'s compatibility date, then runs test-phone's and root.worker's Workers tests (the largest graphs) in one Vitest process with one worker and every pool message measured (`workers-pool-messages.run.mjs`), and fails when either project caches modules on disk, when one message carries several modules, or when a message passes 25,165,824 bytes (24 MiB, 75% of the limit), naming the module. It needs the generated validators (`npm run build:validators`, which `npm test` runs first). A module that nears the budget is split; the other way out, measured but not taken, is workerd's `increase_websocket_message_size` compatibility flag in the pool's `miniflare` options, which raises the limit to 134,217,728 bytes (128 MiB) but keeps one message per graph, growing with every join.

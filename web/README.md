# web (`@rosie/web`)

**Owner:** the frontend engineer (build prompt section 4). **Checked by:** QA and security.

The secure pages, the booking page, the owner and team consoles, and the staging test tools (build prompt 9.4).

- Code lives in `src/`, with unit tests beside it (`src/**/*.test.ts`, Vitest project `unit`).
- Pages are HTML made on the Worker in TypeScript, with no client framework (the plan's default for the web rendering approach). Page tests are Vitest tests over the rendered HTML until Playwright is added.
- The root type check has the Workers and Node types but no browser (DOM) types. When code that runs in the browser arrives, the release engineer adds a TypeScript project for it.
- The K-21 types come from `contracts/generated/` (`npm run contracts:types`), which is git-ignored: run it before `npm run typecheck` and `npm run lint`, as CI does.

## The page frame and the privacy notice (T-1171)

- `src/shell/frame.ts`: the page frame every page renders through. It sets the language, a skip link and the main landmark, and adds a footer linking to the privacy notice at BASE_PATH + `/privacy` (RULES 4.3; Q-30: every page carries the privacy link).
- `src/shell/serve.ts`: `servePage(request, basePath)` answers GET and HEAD at a static page's path under BASE_PATH, and gives null for any other path. Its pages carry no cookie, script, form or outside resource, and their content security policy loads nothing but the frame's inline style.
- `src/pages/privacy/`: the privacy notice at rosfield.com/test/privacy on staging (rosfield.com/privacy in production), the address on the last line of Rosie's first text. Its words are Q-30's default stand-in, shown as a draft and waiting for Jay's words before production.

The Worker (`runtime/src/index.ts`) calls `servePage` last before its 404 (T-1192), so the privacy notice is served on rosfield.com/test.

## The web app shell (T-511)

- `src/shell/shell.ts`: `createWebShell(deps)` answers every page request under BASE_PATH. It serves the static pages and every feature folder's routes. Each answer carries the request's trace id in `x-trace-id` (a valid incoming one is kept, else a new one), and one JSON log line is written for it: `{ level, msg: "page", trace_id, route, status }`, where `route` is the route's fixed label. Nothing of the request and nothing a handler threw is ever logged. `fetch` answers every request; `serve` gives null for an address no route takes, so a Worker with routes of its own keeps its own 404.
- `src/shell/error-pages.ts`: the 404, 405 and 500 pages, each inside the frame and each showing the trace id as a reference.
- `src/shell/worker.ts`: `createWebWorker(deps)`, the Worker entry. `fetch(request, env)` reads the config from the Worker's vars and answers through the shell. Vars it cannot run on give a plain 500.
- `src/shell/config.ts`: the config, all from the Worker's vars: `ENVIRONMENT`, `BASE_PATH` and `LINK_HOST`. A link is always the host plus a short code, under BASE_PATH (`linkUrl`). A missing var is refused, never guessed.
- `src/shell/trace.ts`: the trace id rule, the same as the Worker's.
- `src/shell/route.ts`: what a route is, and the table that finds the route at an address.
- `src/client/`: the typed K-21 client. `calls.ts` holds K-21 v1's calls and their types, read off the generated contract types. `client.ts` holds the client and its transport to the page entry (POST BASE_PATH + `/page-api/<call>`). `test-support.ts` holds the transport over the Tool API mock (`contracts/mock`), for tests only.
- `src/routes.ts`: `PAGE_ROUTES` (the static pages) and `ROUTE_MODULES` (every feature folder's route module).

### Adding a page

Each feature folder has a `routes.ts` that exports `ROUTES`, and `src/routes.ts` already lists it. A page task adds its routes to its own folder's `ROUTES` and changes nothing outside the folder:

```ts
export const ROUTES: readonly ShellRoute[] = [
  {
    label: "auth.signIn", // fixed letters, the log line's name for the route
    path: "/sign-in", // under BASE_PATH; a segment written :name takes any one segment
    methods: ["GET", "POST"], // GET also answers HEAD
    handle: (context) => context.page({ title: "Sign in", main: "<h1>Sign in</h1>", forms: true }),
  },
];
```

- The handler gets the request, the config, the trace id, the values of the path's `:name` segments and a K-21 client that carries the trace id. `context.envelope(...)` builds a call's envelope under that trace id.
- `context.page(...)` renders through the frame with the shell's headers. A page that holds a form says `forms: true`, and the content security policy then lets it post to this site only. A handler may also return a `Response` of its own.
- An exact path always wins over a `:name` path. Two routes with one label, or two paths that take the same addresses, are refused when the shell is made.
- Staging's test tools (`staging/test-phone/send`, `console/team/fire-now`, `console/team/text-hours`) are marked staging only in `src/routes.ts`: the shell serves none of their routes unless ENVIRONMENT is exactly `staging`.
- A page test runs on `testShell()` (`src/shell/test-support.ts`): the shell over the Tool API mock. A request no fixture holds fails the test with the mock's own error.

### Not wired yet

- The Worker still calls `servePage`, not the shell, so feature routes are not served on rosfield.com/test yet, and the privacy notice's answer has no `x-trace-id`. Switching `runtime/src/index.ts` to the shell is a runtime task.
- `wrangler.jsonc` sets no `LINK_HOST` yet. Adding it is the release engineer's.

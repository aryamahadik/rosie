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

The Worker (`runtime/src/index.ts`) serves the privacy notice through the shell (T-1192, T-1234), at rosfield.com/test/privacy on staging.

## The web app shell (T-511)

- `src/shell/shell.ts`: `createWebShell(deps)` answers every page request under BASE_PATH. It serves the static pages and every feature folder's routes. Each answer carries the request's trace id in `x-trace-id` (a valid incoming one is kept, else a new one), and one JSON log line is written for it: `{ level, msg: "page", trace_id, route, status }`, where `route` is the route's fixed label. Nothing of the request and nothing a handler threw is ever logged. `fetch` answers every request; `serve` gives null for an address no route takes, so a Worker with routes of its own keeps its own 404.
- `src/shell/error-pages.ts`: the 403, 404, 405, 413 and 500 pages, each inside the frame and each showing the trace id as a reference.
- `src/shell/post-guard.ts`: the guards every POST passes before its handler runs (see "The POST guards" below).
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

### How the Worker serves it

- `runtime/src/index.ts` answers its own addresses first (GET BASE_PATH + `/health`, the webhooks, and the page entry's POST BASE_PATH + `/page-api/<call>`), then hands every other request to the shell's `serve` (T-1234). An address no route takes gets the Worker's own JSON 404. So every route `src/routes.ts` lists is served on rosfield.com/test.
- `wrangler.jsonc` sets `LINK_HOST` to rosfield.com for staging and production (T-1235). Staging also answers on its workers.dev address (`workers_dev` is on, and the deploy check reads that address); the host rule below keeps forms off it.

## Sign-in (T-520)

`src/auth/`: sign-in by code for owners, admins, staff, Rosie's team and staging's testers (FS section 8; K-21 v1 `signInStart`, `signInCheck` and `signOut`). There is no password anywhere, and no page runs a script: a page holds a form posted to this site, or a link, and the answer is the next page.

| Route (under BASE_PATH) | GET                                                                                       | POST                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/sign-in`              | The form that starts a sign-in: the portal's, or with `?link=<code>` a signed link's own. | `signInStart`. The page names the way the code went (email or text) as the answer gives it, never whether an account matched.                                                |
| `/sign-in/check`        | A 303 to `/sign-in`.                                                                      | `signInCheck`, with the code typed back (email) or asking whether the text came (text). A right code sets the session cookie and shows the consoles the person's roles open. |
| `/sign-out`             | The sign-out button.                                                                      | `signOut`, and the session cookie is cleared.                                                                                                                                |

- A code works for 10 minutes. After five wrong codes the page shows the 15-minute pause, holds no form that checks a code, and sends no check of that attempt until the pause ends. The server holds the real pause.
- The cookies (`src/auth/cookies.ts`), each HttpOnly, Secure, SameSite=Lax, with Path BASE_PATH (`/` in production) and named per BASE_PATH (`-test` on staging, so staging never reads production's): `__Secure-rosie-session` holds the opaque session token alone, until K-21's `sessionExpiresAt`; `__Secure-rosie-device` holds 256 random bits for 400 days; `__Secure-rosie-sign-in-pause` holds a pause's end and its attempt, until that end. No cookie holds a role, a person, a phone or an email.
- After a right code the page links the consoles the roles open (`src/auth/consoles.ts`): `/console/owner`, `/console/team`, and on staging only `/staging/test-phone`. Each console's task serves its own routes there.
- Every POST here passes the shell's POST guards first.

## The POST guards (T-520, T-1237)

The shell (`src/shell/shell.ts`, `src/shell/post-guard.ts`) runs these checks in this order for every request, and the first that refuses answers. A form task inherits them, and no handler can leave them out.

1. **The address.** No route at it: the 404 page (`serve` gives null, so the Worker sends its own 404). Outside staging a staging tool's route is not in the table at all, so its address is an unknown address for every method, whatever the request carries (T-520 round 2): never a 403, 405 or 413, and none of the body is read.
2. **The method.** One the route does not take: the 405 page, with Allow. HEAD rides with GET.
3. **The host rule** (POST only; T-1237). The host of the request's URL must be exactly LINK_HOST, else the 403 page. Without it, a page served on the workers.dev address could post its own form there, since the browser's `Sec-Fetch-Site` in check 4 is relative to the host it reached. The comparison folds and trims nothing: another host or subdomain, a port or a trailing dot is refused (the URL standard lowers a host's capitals and drops the scheme's own port as it parses the address, so those two arrive as LINK_HOST itself). The request's host is only compared, never used to build a link or an origin. GET and HEAD never meet the rule, so every page reads on every host as before.
4. **The Origin rule** (POST only). An `Origin` that names an origin must be exactly `https://` + LINK_HOST, taken from the config and never from the request. Every page is served with `referrer-policy: no-referrer`, under which a browser sends `Origin: null` on a form's POST even to its own site, so when `Origin` is `null` or missing the browser's own `Sec-Fetch-Site: same-origin` must be there (a page cannot set it). Anything else is the 403 page: a browser that sends `Origin: null` without `Sec-Fetch-Site`, such as Safari before 16.4, cannot post a form here.
5. **The body cap** (POST only): 16 KiB (`POST_BODY_MAX_BYTES`). A declared length over it is refused before any of the body is read; else reading stops at the first byte past the cap and the rest is cancelled. Either way, the 413 page. The handler gets only the bytes that were read.
6. **The handler.** A throw, or an answer that is no `Response`, gives the 500 page.

Each refusal from checks 2 to 5 is the shell's own page, inside the frame and showing the trace id, with one log line holding the route's label and the status, and nothing of the request.

### Posting a form from a local `wrangler dev` session

The host rule is the same code everywhere, with no branch for a local session. A local session's form is taken when the host in the URL its Worker receives is the session's LINK_HOST:

- With no local upstream host (the top level of `wrangler.jsonc` has no route and no `dev.host`), wrangler hands the Worker the address the browser asked for, `http://localhost:8787` by default, and every form's POST gets the 403 page. LINK_HOST is a plain var, so the session names its own host with `--var`, for that session alone, and `wrangler.jsonc` does not change:

  ```sh
  npm run cf -- dev --var LINK_HOST:localhost:8787
  ```

  Name the host as the browser's address bar shows it, with its port: lower case, no scheme and no path (`src/shell/config.ts` refuses anything else). The session's links then start with `https://localhost:8787`. The Origin rule needs nothing more: a browser posts a local form with `Origin: null` and, to localhost, `Sec-Fetch-Site: same-origin`.

- With a local upstream host (`--local-upstream`, else `dev.host`, else the host of the environment's first route), wrangler rewrites each request's URL to that host before the Worker sees it. Under `--env staging` that is rosfield.com, staging's own LINK_HOST, so a local staging session posts its forms as they are, and naming another LINK_HOST there would refuse them.

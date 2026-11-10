# web (`@rosie/web`)

**Owner:** the frontend engineer (build prompt section 4). **Checked by:** QA and security.

The secure pages, the booking page, the owner and team consoles, and the staging test tools (build prompt 9.4).

- Code lives in `src/`, with unit tests beside it (`src/**/*.test.ts`, Vitest project `unit`).
- The root type check has the Workers and Node types but no browser (DOM) types. When code that runs in the browser arrives, the release engineer adds a TypeScript project for it.

## What is here (T-1171)

- `src/shell/frame.ts`: the page frame every page renders through. It sets the language, a skip link and the main landmark, and adds a footer linking to the privacy notice at BASE_PATH + `/privacy` (RULES 4.3; Q-30: every page carries the privacy link).
- `src/shell/serve.ts`: `servePage(request, basePath)` answers GET and HEAD at a page's path under BASE_PATH, and gives null for any other path. Pages carry no cookie, script, form or outside resource, and their content security policy loads nothing but the frame's inline style.
- `src/routes.ts`: web's pages, each at its path under BASE_PATH.
- `src/pages/privacy/`: the privacy notice at rosfield.com/test/privacy on staging (rosfield.com/privacy in production), the address on the last line of Rosie's first text. Its words are Q-30's default stand-in, shown as a draft and waiting for Jay's words before production.

The Worker (`runtime/src/index.ts`) does not call `servePage` yet. Until a runtime task routes page paths to it, the page is built and tested here but is not served on rosfield.com/test.

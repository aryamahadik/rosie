# web (`@rosie/web`)

**Owner:** the frontend engineer (build prompt section 4). **Checked by:** QA and security.

The secure pages, the booking page, the owner and team consoles, and the staging test tools (build prompt 9.4).

- Code lives in `src/`, with unit tests beside it (`src/**/*.test.ts`, Vitest project `unit`).
- The root type check has the Workers and Node types but no browser (DOM) types. When code that runs in the browser arrives, the release engineer adds a TypeScript project for it.

D-000 holds only this file and `package.json`.

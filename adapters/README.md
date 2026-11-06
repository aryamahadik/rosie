# adapters (`@rosie/adapters`)

**Owner:** the integrations engineer (build prompt section 4). **Checked by:** security.

One adapter per port (plan 3.2), each with its test double first. Staging uses test doubles or test modes for every paid or outside service until Jay approves the real one (build prompt 5.3).

- Code lives in `src/`, with unit tests beside it (`src/**/*.test.ts`, Vitest project `unit`), against the doubles.
- An adapter that needs a key names it in `wrangler.jsonc`'s `secrets.required` (through the release engineer). Keys are never committed, printed or put in a test.

D-000 holds only this file and `package.json`.

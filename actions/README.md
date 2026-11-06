# actions (`@rosie/actions`)

**Owner:** the action-layer engineer (build prompt section 4). **Checked by:** QA and security.

The Tool API and the frontier; the gate and limits 1 to 6; the one commit per turn; the claim check (limit 7) and the message checks; the domain services; the effects runner; the Agent API (MCP and REST); reconciliation (architecture sections 02, 03, 05, 06, 07 and 10).

Code lives in `src/`, with unit tests beside it (`src/**/*.test.ts`, Vitest project `unit`). It runs inside the Worker, typed with the Workers and Node types of the root `tsconfig.json` (the Worker runs with `nodejs_compat`).

D-000 holds only this file and `package.json`.

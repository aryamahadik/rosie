---
name: contract-change
description: Checklist for changing a Rosie contract, additive (minor version) or breaking (major version) - the new version, its reason, every consumer, fixtures, contract tests, the CTO's OK and the 7-day rule. Use for any change under contracts/.
---

# Contract change

Only the architect changes a contract (build prompt 6.4). A contract is JSON Schema 2020-12 with fixtures in `contracts/<name>/v<N>/`; its TypeScript types are generated in CI into a git-ignored folder and never committed (ADR-005, 3.5 (c)).

## Which kind

- **Additive**: a new optional field, endpoint or fixture. A minor version, such as v1 → v1.1. Old consumers keep working and nobody pauses; a consumer adopts it only in a task that needs it.
- **Breaking**: a rename, a removal, or a changed meaning or type. A major version, only with the CTO's OK: if your card does not carry it, report NEED (lead).
- **Not allowed**: changing a contract mid-task to make a task easier, yours or anyone's (6.4).

## Every change has

1. A new version; the old version stays as it is.
2. Its reason: the source line, decision or stuck report that asked for it.
3. Every consumer listed: role, component, and the tasks building on it.
4. Updated fixtures (sample payloads), valid against the new schema; the old version's fixtures stay valid against it.
5. Updated contract tests: QA writes them in `tests/contract/` as their own task. Name them in your handoff; the lead creates the task.

## A breaking change also

- One migration task per consumer, created at once: list them in your handoff; the lead writes the cards.
- The old version keeps working until the last consumer has moved; then it is removed in its own task. QA records each contract test that removal drops in `tests/QUARANTINE.md`, with that task's id (5.2).
- A second breaking change to the same contract within 7 days goes to the CTO as a design problem: stop and report NEED.

## Work in flight

- Tasks already building finish on the version they started with; only tasks not yet started wait (6.4).
- A contract is frozen at v1 before the first task that builds against it starts (3.3). A gap is never filled by a guess: report it with its default, for `QUESTIONS.md` (3.3).
- When Jay decides against a default the team built on, list what was built on it (contracts, tasks, files); the lead turns the rework into tasks, and nothing in flight stops (6.4).

## Checklist

1. Read the contract's current version, its consumers, and the request (card, stuck report or decision).
2. Additive or breaking? Breaking without the CTO's OK on your card: NEED.
3. Write the new version under `contracts/<name>/` (schema and fixtures, as ADR-005 lays out) and check every fixture against its schema.
4. Self-check: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`; the old version's contract tests still pass.
5. Handoff: the version, the kind, the reason, the consumers, the contract tests QA must add or update, and for a breaking change the migration task per consumer.

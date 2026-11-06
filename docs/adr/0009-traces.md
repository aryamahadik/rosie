# ADR-009: Traces

- Status: proposed, default in use (D-000)
- Date: 2026-11-05
- Owner: architect. Decides: the CTO.

## Context

- One trace id from webhook to delivery receipt, and the bundle id on every turn, open question and trace (build prompt 5.5; architecture 10, "Observability"). Each step adds what it got, what it decided and how long it took, so any answer can be replayed (tour, "Traces · evals · alerts").
- A trace id is evidence: a done card links one (rule 5); a deployment works end to end on staging with a trace id (section 8); rollbacks alert with trace ids (5.4); D-000's first check needs the trace visible (5.9).
- The event and trace format is a contract, frozen together with the outbox and effect rows (3.3).
- Private data is sealed under a per-person key, and sealed traces live in R2 (architecture 10, "Privacy"; architecture 02, data layer).

## Decision

- **One trace id per inbound request or event,** carried in the `x-trace-id` header and written on every log line and, from M2, on the rows a turn writes (the trace contract names which). A valid incoming `x-trace-id` is kept; otherwise a new one is made with `crypto.randomUUID()`.
- **Logs:** one object per event, passed to `console.log` (`console.warn` and `console.error` by level), with at least `level`, `msg`, `trace_id`, `environment` and `version` (the deploy's `GIT_SHA`). Log lines carry ids and outcomes, never message text or other personal data in clear.
- **Workers Logs** (`observability.enabled: true`, every request logged) is the trace view for D-000 and staging.
- The full trace format (fields per hop, the bundle id, timings) is a contract in `contracts/`, frozen in M1 (3.3). This record fixes only the id, the header and the log line.

## Consequences

- Workers Logs extracts and indexes the fields of a logged object, so a trace can be filtered by `trace_id`.
- Workers Logs keeps 7 days on Workers Paid, with 20 million events a month included, then $0.60 per million; from 2026-12-01 it moves to Cloudflare Observability pricing. Replay and evals need the longer-lived R2 store later. Spend past the budget is Jay's call (rule 6), so the release engineer checks the new pricing before December 1.
- Preview (version URL) requests do not reach Workers Logs (ADR-008); their trace id comes back only in the response.
- A head sampling rate below 1 would drop traces, so logs stay at 1 unless a cost decision says otherwise.

## Alternatives not chosen

- **W3C `traceparent` as the id:** the tracing standard, but nothing here speaks OpenTelemetry yet, and the providers' webhooks do not send it. The trace contract (M1) may adopt it.
- **An outside tracing or log service:** a new account and spend (rule 6), with no need in D-000.
- **Logpush to R2 now:** the warehouse and the sealed traces come later (architecture 10, "Warehouse and ETL").

## Sources

- Build prompt 2 (rule 5), 3.3, 5.4, 5.5, 5.9 (check 1), 8 ("Deployment").
- Architecture 02 (data layer: R2 holds sealed traces; control plane: observability); architecture 10 ("Observability", "Privacy", "Warehouse and ETL").
- Tour, "Traces · evals · alerts".
- D-000 spec, section 6.
- Checked 2026-11-05: Cloudflare, "Workers Logs" (retention, pricing, field indexing) and "Workers best practices" (structured logs with `console.log`; `head_sampling_rate`).

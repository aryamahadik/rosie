# T-360 findings: structured outputs for K-02 and K-03 on Haiku 5.5 and Sonnet 5.5

**Status: live results are in** (the "Live results" table below; the lead's run, 16 of the 20 calls). The sections before it come from offline work: the docs, the candidate schemas, and the probe's dry run and tests. `probe.mjs` reads only `CI` and `ANTHROPIC_API_KEY`, calls only `https://api.anthropic.com/v1/messages`, writes no header and scrubs the key from every line. The other 4 calls are for the frozen-schema check (T-1066, "Frozen schemas" below), which is pending the lead's one live run (NQ-R2).

Card: T-360 (C-121, M1, deployment ai-spikes). Question (`ops/plan/02-contracts.md` section 2 item 7): do the model-facing shapes (K-02's decide, safety read and planner outputs, and K-03's message plan) work as structured outputs on `claude-haiku-5-5` and `claude-sonnet-5-5`?

## The schemas are spike candidates, not the contracts

K-02 (`contracts/model/`, T-011) and K-03 (`contracts/message-plan/`, T-012) do not exist yet. The four files in `schemas/` are spike-local candidates. They come from 02-contracts K-02 and K-03 and from architecture sections 03 ("The model's contract"), 06 (outcomes, tense, the planner's five verbs) and 07 (shape, formats, the composer prompt). They use the constructs the contracts will need: nested objects, enums, `const`, arrays of objects, `anyOf` over verb shapes, `$defs` and `$ref`, `additionalProperties: false`, `required` lists, and relative `$ref`s to `contracts/common/formats.v1.schema.json`. They have no number, string-length or array limits (contracts/README.md convention 7). This spike changes no contract. Any change the findings call for is the architect's, through the contract-change skill.

| Candidate                                    | Shape                                                                                                                      | Optional props | Union params | Bytes sent |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------ | ---------- |
| `schemas/decide.candidate.schema.json`       | `parts[]`: quote plus `anyOf` over the 8 verbs (choose, enter, ask, none_fits, pass_on, hand_off, redact, no_op)           | 0              | 1            | 3,869      |
| `schemas/safety-read.candidate.schema.json`  | `labels[]`: 8 outcomes or unsure, 5 tenses, evidence words, at risk, writer                                                | 0              | 0            | 1,814      |
| `schemas/planner.candidate.schema.json`      | `action`: `anyOf` over the 5 planner verbs (no booking or money verb exists)                                               | 0              | 1            | 1,970      |
| `schemas/message-plan.candidate.schema.json` | format enum, first line, fact lines, action line, link, slots (37-value enum), optional question, page type, thread target | 3              | 0            | 3,136      |

What stays in code, not in the model's schema: which models read, whether the reads agreed, and whether the re-read ran (code wraps the reads); the safety read's 4 s timeout marker; the "at most four fact lines" and "at most one question" rules (C-092); and "the option was offered" (K-02's `refuse-option-not-offered` is a consumer check).

## What Anthropic's documentation says (read 2026-11-07)

Sources:

- The `claude-api` skill bundled with Claude Code 2.1.319: `shared/tool-use-concepts.md`, "Structured Outputs"; its model table is cached 2026-10-06.
- Anthropic, "Structured outputs", `https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md`, fetched 2026-11-07. The page shows no last-updated date. The fetch read about 100,000 of its 106,000 characters; the unread tail is its feature-compatibility list.

1. **Request field.** JSON outputs use `output_config: {"format": {"type": "json_schema", "schema": {...}}}` on `POST /v1/messages`. No beta header is needed. The older `output_format` field is deprecated: it needs the `structured-outputs-2025-11-13` beta header and returns a 400 without it. The docs' examples send `anthropic-version: 2026-10-21`, and that version refuses `temperature`, `top_p` and `top_k`, so the probe sends none of them.
2. **Models.** Both `claude-haiku-5-5` and `claude-sonnet-5-5` are on the supported list.
3. **Subset.** The docs support all basic types, `enum` (scalars only), `const`, `anyOf`, `allOf` (but not `allOf` with `$ref`), local `$ref`/`$defs`, `default`, `required`, `additionalProperties: false` (required on objects), the string formats `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `uri`, `ipv4`, `ipv6` and `uuid`, simple `pattern` regexes, and `minItems` of 0 or 1. They do not support recursive schemas, numeric limits, string-length limits, array limits beyond `minItems` 0 or 1, complex enum values, external `$ref`, or `additionalProperties` other than `false`. This confirms 02-contracts section 2 item 7 and adds four points it does not state:
   - **External `$ref` is refused.** A contract file that points at `formats.v1` with a relative `$ref` (convention 2) has to be bundled before it is sent, with the formats copied into its own `$defs`. The probe's `bundleForModel()` in `lib.mjs` shows one way to do it. Call 16 sends the decide candidate unbundled to record the refusal text.
   - **Per-request limits** apply across every structured schema and strict tool in one request: 24 optional properties, 16 parameters with union types (`anyOf` or a type array such as `["string", "null"]`), and 20 strict tools. A schema too complex to compile gets a 400 with "Schema is too complex for compilation." (compilation timeout 180 s). Nullable fields written as type arrays count toward the 16, so required fields with empty values, or optional properties, cost less.
   - **Compiling is cached.** A new schema pays a one-time compile on its first request, and the compiled grammar is cached for 24 hours. A schema built per turn, such as an enum of that turn's option ids, would compile on every turn. Keep the schemas static and check option ids in code.
   - **Simple `pattern` works; a complex one may get a 400.** `formats.v1` uses `pattern` (`"."` for ids, and `{n}` quantifiers for currency, utc and zone). Every candidate uses the `id` format, so a live call tests `"."`.
4. **Refusals and truncation.** A safety refusal returns HTTP 200 with `stop_reason: "refusal"` (and `stop_details`), and its output may not match the schema. A `stop_reason` of `max_tokens` means the output may be incomplete. The AI gateway must check `stop_reason` before parsing. For Claude Haiku 5.5, the skill says refusals have no server-side fallback; the gateway's "other model once" rule (architecture 06) covers it.
5. **Incompatible** with citations (400) and assistant prefill. Compatible with Batches, streaming, token counting and thinking.

## The probe

- `lib.mjs` holds the candidates' bundling, the subset check (`checkSubset`, which also counts optional properties and union parameters against the limits), Ajv 2020 strict compilation (convention 8), the prompts, and the call plan. It makes no network calls and reads no key.
- `probe.mjs --dry-run` builds every request, compiles every candidate with Ajv, and runs the subset check on each request's schema. It needs no network and no key.
- `probe.mjs --live` is the lead's one run, and it follows these rules:
  - It reads only `ANTHROPIC_API_KEY`, and only from `process.env`. The key is workspace-scoped (DL-027), so it needs no `anthropic-workspace-id`.
  - It refuses to start when `CI` is set or the key is missing, naming the variable.
  - It calls only `https://api.anthropic.com/v1/messages`.
  - It stops at 20 calls in total, counting lines already in `results.jsonl`, so running it again cannot go past 20.
  - Per call, it appends one line to `results.jsonl`: schema, model, accepted or refused, `stop_reason`, the refusal or error text, whether the output validates against the candidate, input and output tokens, and elapsed time. It saves the request body and the response body under `samples/` (bodies only, no headers, prettier-formatted, any echo of the key replaced) for T-004's recorded-model double.
  - On a 429, 5xx or network error it waits and tries once more (build prompt 7.8). The retry counts toward the 20.
  - Each model's control call (a one-field schema) goes first. If the control is refused, the rest of that model's calls are skipped, so a request-shape mistake costs one call, not eight.
- Prompts use only made-up values, fixture set v1's demo shop "Flooring installer" (`fixtures/v1/test-kit/shops/flooring.json`: Elena, the $35 floor consult, the $20 fee, 123 Demo St, Anytown), and the architecture's own example lines (hard rule 9).
- Every request uses `max_tokens` 4096 and `output_config.effort` `"low"`, with no `thinking` field (both models run adaptive by default).

Offline proof, run 2026-11-07:

- `node ai/spikes/structured-outputs/probe.mjs --dry-run`: 16 calls planned (limit 20). All four candidates compile in Ajv strict mode, the bundled candidates show no subset problems, and each negative control shows the problem it was built to have. Result: "dry run: passed".
- `node --test ai/spikes/structured-outputs/probe.test.mjs`: 9 of 9 pass. The tests cover:
  - the candidates compile and, once bundled, stay inside the subset;
  - bundling is transitive (`money` brings `currency`);
  - the subset check flags limits, open objects, external refs and recursion;
  - each candidate accepts a valid sample and refuses an invalid one (an unknown verb, an unknown tense, a planner "charge", the `hold` slot);
  - the plan stays at 20 calls or fewer and covers both models and every candidate;
  - the dry run never calls the network;
  - live mode refuses in CI and without the key;
  - live mode, against a fake API, stops at 20 counting earlier lines and never writes the key or a header;
  - live mode retries a 529 once and skips a model whose control call is refused.

## Call plan (16 of the 20 allowed)

| #    | Call                               | Model  | Expect  | What it shows                                                 |
| ---- | ---------------------------------- | ------ | ------- | ------------------------------------------------------------- |
| 1    | control-haiku-5-5                  | Haiku  | accept  | the request shape works                                       |
| 2    | decide                             | Haiku  | refused | the candidate, bundled; refused as too complex (live table)   |
| 3-5  | safety-read, planner, message-plan | Haiku  | accept  | each candidate, bundled                                       |
| 6    | decide-header-haiku-5-5            | Haiku  | unknown | whether `$schema` and `$id` may stay in a sent schema         |
| 7    | control-sonnet-5-5                 | Sonnet | accept  | the request shape works                                       |
| 8    | decide                             | Sonnet | refused | the candidate, bundled; refused as too complex (live table)   |
| 9-11 | safety-read, planner, message-plan | Sonnet | accept  | each candidate, bundled                                       |
| 12   | decide-header-sonnet-5-5           | Sonnet | unknown | as 6                                                          |
| 13   | neg-string-length                  | Haiku  | refuse  | refusal text for `maxLength`                                  |
| 14   | neg-number-limit                   | Haiku  | refuse  | refusal text for `minimum`/`maximum`                          |
| 15   | neg-open-object                    | Haiku  | refuse  | refusal text for `additionalProperties: true`                 |
| 16   | neg-external-ref                   | Haiku  | refuse  | refusal text for a contract-style relative `$ref` (unbundled) |

Calls 17 to 20 were left for retries after outside failures; none was needed, and they are now the frozen-schema check (T-1066, below). Expected cost at the listed prices (Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10 per million input/output tokens) is well under $0.10.

## Live results (the lead's run, ended 2026-11-07 13:00Z by results.jsonl's time)

The lead ran `node --env-file=.dev.vars .claude/worktrees/wf_18e223d2-05c-1/ai/spikes/structured-outputs/probe.mjs --live` once from the code folder, on the build Mac, with `CI` unset, at the user's instruction in an interactive session (NQ-R2; DL-081). Node loaded the key; nothing printed it.

| Schema                      | claude-haiku-5-5         | claude-sonnet-5-5        | Refusal or error text                                                                                                                            | Output valid | Tokens in/out (Haiku; Sonnet) |
| --------------------------- | ------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ | ----------------------------- |
| control (no schema limits)  | accepted (200, end_turn) | accepted (200, end_turn) | none                                                                                                                                             | n/a          | 224/9; 224/9                  |
| decide                      | refused (400)            | refused (400)            | "Schema is too complex."                                                                                                                         | n/a          | none                          |
| safety-read                 | accepted (200, end_turn) | accepted (200, end_turn) | none                                                                                                                                             | yes; yes     | 1091/80; 1091/84              |
| planner                     | accepted (200, end_turn) | accepted (200, end_turn) | none                                                                                                                                             | yes; yes     | 1345/70; 1345/75              |
| message-plan                | accepted (200, end_turn) | accepted (200, end_turn) | none                                                                                                                                             | yes; yes     | 1950/150; 1950/153            |
| decide with `$schema`/`$id` | refused (400)            | refused (400)            | "Schema is too complex." (so this run does not show whether `$schema` and `$id` may stay in)                                                     | n/a          | none                          |
| 13 neg-string-length        | accepted (200, end_turn) | n/a                      | none: a `maxLength` was accepted, though the documentation lists string-length limits as unsupported                                             | n/a          | 1355/80                       |
| 14 neg-number-limit         | refused (400)            | n/a                      | "output_config.format.schema: For 'integer' type, properties maximum, minimum are not supported"                                                 | n/a          | none                          |
| 15 neg-open-object          | refused (400)            | n/a                      | "output_config.format.schema: For 'object' type, 'additionalProperties: true' is not supported. Please set 'additionalProperties' to false"      | n/a          | none                          |
| 16 neg-external-ref         | refused (400)            | n/a                      | "output_config.format.schema: External schema references are not supported (got: ../../../../contracts/common/formats.v1.schema.json#/$defs/id)" | n/a          | none                          |

Calls made: 16 of the 20 allowed (results.jsonl has one line per call). Total tokens: 10,575 in and 710 out. Key in any file or log: none; after the run the lead searched results.jsonl and samples/ for the key prefix and for an api-key header (0 files).

### What the live run shows

1. **The decide schema is refused as too complex on both models.** The candidate is small (about 3.9 KB as sent: 11 objects, 25 properties, no optional property) but holds one `anyOf` of 8 object branches, one per verb. The three other candidates, with no `anyOf` of objects, are accepted and their outputs validate.
2. **The frozen K-02 decide read is larger still.** Measured offline after T-011 merged: contracts/model/model.v1.schema.json `$defs/decideRead` with the 21 definitions it reaches is about 10.4 KB, 12 objects, 37 properties and 2 `anyOf` groups with 13 branches. It is very likely refused the same way. The frozen safety read (about 2.4 KB, no `anyOf`), planner output (about 4.7 KB, one `anyOf` of 5) and K-03 plan (about 6.5 KB, 3 `anyOf` with 6 branches) are closer to the accepted candidates. A live call on each frozen schema settles it (a follow-up of this spike).
3. External `$ref`, number limits and open objects are refused with the texts above, as the documentation says. A `maxLength` was accepted in one call; keep length limits as code checks (02-contracts section 2 item 7) either way.

## Frozen schemas (T-1066)

Question: are the frozen K-02 decide read, safety read and planner output, and the K-03 plan, accepted as structured outputs, each sent bundled the way the AI gateway will send it? T-360 measured candidates; this measures the contracts themselves (`contracts/model/model.v1.schema.json`, `contracts/message-plan/message-plan.v1.schema.json`, both frozen). The contracts are not changed here.

**Status: done. The lead ran `node --env-file=.dev.vars .claude/worktrees/wf_270839c4-5be-1/ai/spikes/structured-outputs/probe.mjs --frozen --live` once from the code folder, at the user's instruction in an interactive session (NQ-R2, DL-081); it ended at 13:16Z by results.jsonl's time. 4 calls, 20 of 20 used. No key in results.jsonl, samples/ or this file (searched for the key prefix and an api-key header: 0 files).**

How it works:

- `node ai/spikes/structured-outputs/probe.mjs --frozen --dry-run` builds the 4 requests and checks them offline (no network, no key). `--frozen --live` is the lead's run, with `ANTHROPIC_API_KEY` in the environment as for T-360.
- Exactly 4 calls, all on `claude-haiku-5-5` (both models were measured on the candidates), one per schema. Each schema is `bundleSchema()` from `contracts/scripts/structured-subset-lint.mjs`: every `$ref` resolved into the schema's own `$defs`, `$schema` and `$id` left out. The three K-02 schemas are `MODEL_FACING`'s entries; K-03's is `{ schema: "message-plan/message-plan.v1.schema.json", def: "plan" }`.
- The cap is read from `results.jsonl`: `--frozen --live` refuses unless at least 4 of the 20 calls are left (16 are used, so exactly 4 are), and it refuses to run a second time. An outside failure (429, 5xx) is retried once as in T-360, and a retry takes one of the 4 slots, so then the last schema is not measured.
- Prompts are short and built from the frozen fixtures, so every name and value is the fixtures' own: decide from `model/fixtures/context-s1-02.json` (Sam's "Barbershop, plumbing, electrical" with S1-02's choices), safety read from `safety-over-gas-leak.json`'s evidence words, planner from `planner-answer.json`'s stored fact, plan from `message-plan/fixtures/input-s1-02.json`.
- Each output is validated with Ajv 2020 (strict) against the frozen def, compiled from the contract files with the shared formats and bundle schemas. A call is logged as call 17 to 20 (`17-frozen-decide-read-haiku-5-5` and so on) in `results.jsonl`, with the request and response bodies under `samples/`.

Offline measurements (`--frozen --dry-run`, 2026-11-07): all 4 bundled schemas pass this probe's subset check and the contracts' own lint, and each fixture output validates against its compiled def.

| Schema (frozen def)  | Bundled bytes | Optional props | Union params | Expected                       |
| -------------------- | ------------- | -------------- | ------------ | ------------------------------ |
| K-02 `decideRead`    | 10,553        | 0              | 2            | likely refused (T-360 finding) |
| K-02 `safetyRead`    | 2,472         | 0              | 0            | accepted                       |
| K-02 `plannerOutput` | 4,849         | 0              | 1            | accepted                       |
| K-03 `plan`          | 6,605         | 0              | 3            | accepted                       |

Live results (call numbers 17 to 20, `claude-haiku-5-5`):

| Call | Schema               | Accepted or refused      | Refusal or error text                                                                                                                                                        | Output valid against the frozen def | Tokens in/out |
| ---- | -------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------- |
| 17   | K-02 `decideRead`    | refused                  | attempt 1: no answer within the probe's 120 s timeout ("TimeoutError: The operation was aborted due to timeout"); attempt 2, after 40.8 s: HTTP 400 "Schema is too complex." | n/a                                 | none          |
| 18   | K-02 `safetyRead`    | accepted (200, end_turn) | none                                                                                                                                                                         | yes                                 | 1386/53       |
| 19   | K-02 `plannerOutput` | accepted (200, end_turn) | none                                                                                                                                                                         | yes                                 | 2542/61       |
| 20   | K-03 `plan`          | not measured             | the decide read's retry used this call; the 20-call limit is reached                                                                                                         | n/a                                 | none          |

What it shows: the frozen K-02 decide read, sent bundled as the gateway would send it, is refused as too complex on claude-haiku-5-5, as the spike's smaller candidate was on both models. So K-02 v1's decide read cannot go to the model as one structured-output schema. Before C-115 is built, the architect and the AI engineer choose how decide is sent (for example one strict tool per verb, mapped by code into K-02's decide read; or a simpler wire envelope; or a K-02 change under the contract-change skill). The frozen safety read and planner output are accepted and their outputs validate. The K-03 plan stays unmeasured live (its candidate was accepted on both models in T-360); a later smoke-size call settles it.

If `decideRead` is refused, changing K-02 or the gateway's wire format is not this task's: the architect decides under the contract-change skill, with the options listed under "For others".

## For others

- **Architect (T-011, T-012), through the lead:** the model-facing contracts need a bundling step before they are sent, because external `$ref` is refused. They also need to stay within 24 optional properties and 16 union parameters per request, and to keep their schemas static. Call 6/12 answers whether `$schema` and `$id` may stay in.
- **T-004 (recorded-model double):** `samples/NN-<call>.request.json` and `.response.json` are real request and response bodies, saved once the lead's run is done.
- **Architect and AI engineer (K-02, C-115):** decide as one structured output is refused as too complex on both models, so the gateway cannot send K-02's decide read as one schema as it stands. Options to weigh before C-115 is built: one strict tool per verb (up to 20 strict tools per request), or a simpler wire envelope that code maps into K-02's shape, or a K-02 change under the contract-change skill. A live check of the frozen schemas comes first.
- **AI gateway (C-121 onward):** check `stop_reason` (`refusal`, `max_tokens`) before parsing, and validate every output with Ajv anyway, since a refusal's output may not match the schema.

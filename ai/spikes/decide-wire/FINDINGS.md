# T-1068 findings: how decide reaches the model (CQ-25)

**Status: round 1 is live and decided for Haiku: choose (c), the two-step form. The Sonnet cell of (c) waits on the lead's round 2 (`--live --round two-step-sonnet`, 3 calls; NQ-R2).** The "Live results" section is filled from `results.jsonl` for round 1. The sections before it come from the documentation, the probe's dry run and its tests against a fake API (no network, no key).

Card: T-1068 (C-121, C-115; M1; deployment ai-spikes). Question (QUESTIONS.md CQ-25; DL-083): K-02 v1's `decideRead`, sent bundled as one structured output, is refused as "Schema is too complex." on claude-haiku-5-5 (T-1066), and T-360's smaller candidate on both models. Which wire form does the AI gateway (C-121) use for decide, so that the model's answer maps by code into K-02 v1's `decideRead` unchanged?

K-02 is not changed here. Every candidate below maps into the frozen `decideRead`; a K-02 change is proposed only if none works (the architect's, under the contract-change skill).

## What Anthropic's documentation says (read 2026-11-07)

Sources:

- [S1] Anthropic, "Structured outputs", `https://platform.claude.com/docs/en/build-with-claude/structured-outputs.md`, fetched 2026-11-07 (all of it, in two reads).
- [S2] Anthropic, "Strict tool use", `https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use.md`, fetched 2026-11-07.
- [S3] The `claude-api` skill bundled with Claude Code 2.1.319: `shared/tool-use-concepts.md` ("Structured Outputs"; "Forced tool use"); its model table is cached 2026-10-06.

The limits this spike relies on:

1. **Explicit per-request limits** [S1, "Explicit limits"], for every request with `output_config.format` or `strict: true`, summed across all strict schemas in the request: at most **20 strict tools**; at most **24 optional parameters** (every property not in `required`); at most **16 parameters with union types** (`anyOf` or a type array), "especially expensive because they create exponential compilation cost".
2. **Internal limits** [S1]: "schema complexity doesn't reduce to a single dimension: features such as optional parameters, union types, nested objects, and number of tools interact". Past those limits the API returns 400 "Schema is too complex for compilation." even when every explicit limit holds, and a **compilation timeout of 180 s** is the last stop. This is what refused `decideRead`, which has 2 union parameters and 0 optional properties, well inside the explicit limits. Its unions are of objects: 8 verb objects, and `fieldValue`'s 5 branches, two of them objects.
3. **The documentation's advice** [S1, in this order]: mark only critical tools strict; reduce optional parameters; **simplify nested structures** ("flatten structures where possible"); **split into multiple requests**. Candidates (b), (a') and (c) below follow the last two.
4. **Strict tools** [S2]: `strict: true` on a tool guarantees "Tool `input` strictly follows the `input_schema`" and "Tool `name` is always valid". Same JSON Schema subset and grammar pipeline as structured outputs. JSON outputs and strict tools may be combined in one request [S1, "Combined usage"]; the `output_config.format` grammar does not apply to tool calls [S1, "Grammar scope"].
5. **Forced tool use** [S3]: `tool_choice` `any` or `tool` returns a 400 on claude-sonnet-5-5 ("tool_choice: type "tool" and "any" are not supported for this model."). `auto` and `disable_parallel_tool_use` still work. Because `auto` does not guarantee a call, the caller must check that one was made. The probe sends `auto` on both models, so the gateway has one shape.
6. **Caching** [S1]: compiled grammars are cached for 24 hours from last use. A change to the schema structure, or with tools a change to the set of tools, invalidates the cache; a change to `name` or `description` alone does not. Every wire schema here is static.

## The candidates

All of them are in `lib.mjs` and built from the frozen contract where possible. `bundleSchema()` (`contracts/scripts/structured-subset-lint.mjs`) cuts the tool and stage-2 schemas from `contracts/model/model.v1.schema.json`, so they cannot drift from K-02. Each tool's description is K-02's own description of that verb.

| Candidate         | Wire form                                                                                                                                                                                   | Calls per read                     | Strict tools | Unions | Optional | Schema bytes per request |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------ | ------ | -------- | ------------------------ |
| (a) `tools`       | 8 strict tools, one per verb, input = K-02's part less `verb`, plus `language`; the model calls one tool per part, in the text's order; `tool_choice` auto                                  | 1                                  | 8            | 2      | 0        | 19,265                   |
| (a') `tools-flat` | as (a), with K-02's `field` replaced by a typed-text field `{name, type, value, words}`: no union left                                                                                      | 1                                  | 8            | 0      | 0        | 15,119                   |
| (b) `envelope`    | one structured output: `{language, parts[]}`, each part flat with every verb's fields, the verb an enum, `about` with a `none`, fields as typed text; code keeps what the part's verb holds | 1                                  | 0            | 0      | 0        | 3,251                    |
| (c) `two-step`    | stage 1: one structured output `{language, parts[{quote, verb}]}`; stage 2: per part (not `no_op`), one structured output with the verb's own K-02 schema less `verb` and `quote`           | 1 + one per part (3 for two parts) | 0            | 0; 1   | 0        | 1,323; 4,208 per part    |

Typed text is the field form of the envelope and the flat tools. `type` is one of K-02's `fieldValue` branches: `text`, `integer`, `boolean`, `money` or `time` (answerField's `zone`, `id` and `choice` travel as text). `value` is text:

- an integer as digits;
- a boolean as `true` or `false`;
- money as whole cents and the currency code (`1200 USD`);
- a time as the UTC instant and the IANA zone (`2026-11-12T19:00:00Z America/New_York`).

`decodeValue()` turns the text back into K-02's value. A text that does not parse is a mapping error, never a guess (code re-parses every value from its words anyway, arch 03 line 185).

Mapping into `decideRead` (all in `lib.mjs`, pure functions):

- (a) and (a'): each `tool_use` block is one part, in the blocks' order, and the tool's name is the verb. `language` must be the same in every call, or it is a mapping error. No tool call is also a mapping error.
- (b): each part keeps only what its verb holds in K-02 (`ENVELOPE_KEYS`); a `hand_off` with `about: "none"` is a mapping error.
- (c): stage 1 gives each part's quote and verb; stage 2's object is spread into it; a missing stage 2 is a mapping error.
- The result is validated with Ajv 2020 (strict) against the frozen `decideRead`, compiled from the contract files themselves (`compileDecideRead()`). It is then compared with the case's expected read on what two reads must agree on: each part's verb, choice and field values (arch 02 line 119; `agreementKey()`).

What stays in code whichever form wins (as before):

- Option ids are checked against the context (`optionOffered`), and quotes and words against the texts (`quoteInText`).
- Which models read, whether they agreed and whether the re-read ran belong to `decideResult`, assembled around the reads.

## The probe

`probe.mjs` copies T-360's design and keeps its safety properties. `ai/spikes/structured-outputs/` is not changed.

- It reads only `CI` and `ANTHROPIC_API_KEY`, and only from `process.env`. It refuses to start when `CI` is set or the key is missing, naming the variable.
- It calls only `https://api.anthropic.com/v1/messages`, with `anthropic-version: 2026-10-21`.
- It sends no `temperature`, `top_p` or `top_k`, because that version refuses them. Every request uses `max_tokens` 4096 and `output_config.effort` `"low"`, with no `thinking` field.
- It stops at **12 calls in total**, counting every line already in this folder's `results.jsonl`, so running it again cannot pass 12. A 401 or 403 stops the run at once.
- Per call it appends one line to `results.jsonl` with:
  - the candidate, stage, model and case;
  - accepted or refused, the `stop_reason`, and the refusal or error text;
  - the number of tool calls;
  - whether the answer is valid on the wire, whether the mapped read is valid against `decideRead`, and the mapping errors;
  - whether the read agrees with the fixture;
  - tokens and time.
- It saves the request and response bodies under `samples/`: bodies only, no headers, prettier-formatted, with any echo of the key replaced.
- On a 429, 5xx or network error it waits and tries once more (build prompt 7.8); the retry counts toward the 12. The request timeout is 200 s, past the 180 s compile timeout [S1].
- Prompts are built from the frozen K-02 fixtures only, the contract fixtures' made-up cast (hard rule 9):
  - `context-two-requests.json`: Sam's "block thursday afternoon and also tile is $12 a foot from now on", with two parts and a money field; expected read `decide-two-requests.json`.
  - `context-s1-02.json`: S1-02's "Barbershop, plumbing, electrical"; expected read `decide-s1-02-choose.json`.

### Call plan (10 of the 12; 2 left for retries)

| #    | Call                                  | Model  | Case         | What it shows                                                                   |
| ---- | ------------------------------------- | ------ | ------------ | ------------------------------------------------------------------------------- |
| 1    | `tools`                               | Haiku  | two-requests | (a) accepted? the tool calls valid, mapped valid, same as the fixture           |
| 2    | `tools-flat`                          | Haiku  | two-requests | (a') the same                                                                   |
| 3    | `envelope`                            | Haiku  | two-requests | (b) the same                                                                    |
| 4    | `two-step` stage 1                    | Haiku  | two-requests | (c) the parts and verbs                                                         |
| 5-6  | `two-step` stage 2, one per part      | Haiku  | two-requests | (c) each part's fields; the last line carries the mapped read (at most 3 calls) |
| 7-8  | the two strongest one-call candidates | Sonnet | two-requests | the same on claude-sonnet-5-5                                                   |
| 9-10 | the same two                          | Haiku  | s1-02        | a second case, one part with a text field                                       |

The probe picks the "strongest" from calls 1 to 3 (`chooseStrongest()`): first those accepted with a valid mapped read, then those accepted, in the order `tools`, `tools-flat`, `envelope`, at most two. A form Haiku refuses is not sent to Sonnet: T-360 saw the same refusal on both models, because compiling is per schema. The two-step candidate is not in this plan's Sonnet calls (it costs 3 calls a read); it is sent on Sonnet by round two below, or at the end of a full run when no one-call form was accepted. Expected cost at the listed prices (Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10 per million input/output tokens) is under $0.05.

### Round two for (c): `--live --round two-step-sonnet`

Added after round 1 found only (c) accepted. It sends the two-step candidate on claude-sonnet-5-5 with the two-requests case: stage 1, then stage 2 for each part (3 calls). Every safety property above holds: it refuses when `CI` is set or the key is missing, reads the key only from the environment, calls only the Messages API, saves bodies only, scrubs the key, and counts toward the same cap of 12 (6 logged after round 1, so 3 are left for retries after round 2's 3). It appends to the same `results.jsonl` and `samples/` with new ids: `two-step-1-two-requests-sonnet-5-5`, `two-step-2-p1-two-requests-sonnet-5-5`, `two-step-2-p2-two-requests-sonnet-5-5`. It refuses to run when `results.jsonl` already holds the first of those ids, so it cannot be spent twice. A full `--live` run does the same at its end when no one-call form was accepted. `--dry-run` plans it (3 calls) and lints its requests.

### Offline proof (run 2026-11-07)

`node ai/spikes/decide-wire/probe.mjs --dry-run` ends "dry run: passed":

- 10 calls are planned, with 2 left for retries.
- All 25 wire schemas compile in Ajv strict mode and pass the contracts' subset lint, with no `$schema`, `$id` or relative `$ref`.
- Each request's totals are within 20 strict tools, 24 optional properties and 16 unions.
- Each candidate maps 28 of 28 reads there and back to the same `decideRead`, valid against the frozen schema. The 28 are the 27 reads of the 14 accepted K-02 decide fixtures (`decide-s1-02-choose`, `decide-two-requests`, `decide-hand-off`, `decide-hand-off-owner-or-staff`, `decide-redact` and the rest) plus one made-up `enter` read.
- Every candidate refuses both invalid `decideRead` fixtures (`refuse-unknown-verb`, `refuse-value-without-words`), in the encoder, the wire schema or `decideRead`.

`node --test ai/spikes/decide-wire/probe.test.mjs`: 19 of 19 pass. They cover:

- the wire schemas, and the tools cut from K-02;
- the per-request counts;
- the round trip of every sample through every candidate, covering all 8 verbs and all 5 value types;
- the invalid reads;
- typed text both ways, and the texts it refuses;
- the mapping errors: no tool call, two languages, `about: "none"`, a money text that does not parse, a missing stage 2;
- the plan and its free retry slot, and the choice of the second round;
- the dry run, with no network and no writes;
- live refusing in CI, without a key and with 12 calls spent;
- live against a fake API: 10 calls, every answer valid on the wire, mapped valid and the same as the fixture, with no key or header in any file written;
- a "too complex" refusal saved with its text and kept from Sonnet, with the cap counting earlier lines;
- one retry after a 529, and a stop after a 401;
- round two: its plan and ids, 3 Sonnet calls appended after 6 logged lines (mapped valid and the same as the fixture, no key or header written), its refusals (CI, no key, cap spent, already run), its stop at the cap and one retry after a 529, the full run that sends (c) on Sonnet when only (c) is accepted, and the flag forms.

**Fixture gap (for the architect):** no K-02 fixture holds an `enter` part, or an integer, boolean or time value. The probe adds one made-up `enter` read (`MADE_UP_READS` in `probe.mjs`) so every verb and every `fieldValue` branch goes through each wire form offline. A K-02 fixture with an `enter` would be a minor, additive change.

## Live results

**Round 1 done** (the lead, once, from the code folder, at the user's instruction in an interactive session: NQ-R2, DL-081, DL-087; it ended 16:07Z by results.jsonl's time): 6 of the 12 calls. No key in results.jsonl or samples/ (searched for the key prefix and an api-key header: 0 files).

| Candidate    | claude-haiku-5-5 (two-requests)                                       | claude-sonnet-5-5 (two-requests) | Haiku (s1-02) | Refusal or error text                                                                                                                       | Valid on the wire | Mapped valid against decideRead | Same as the fixture | Tokens in/out                |
| ------------ | --------------------------------------------------------------------- | -------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------- | ------------------- | ---------------------------- |
| (a) tools    | refused (400)                                                         | not sent (refused on Haiku)      | not sent      | "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." | n/a               | n/a                             | n/a                 | none                         |
| (a') flat    | refused (400)                                                         | not sent (refused on Haiku)      | not sent      | the same text as (a)                                                                                                                        | n/a               | n/a                             | n/a                 | none                         |
| (b) envelope | refused (400, after 13.3 s)                                           | not sent (refused on Haiku)      | not sent      | "Schema is too complex."                                                                                                                    | n/a               | n/a                             | n/a                 | none                         |
| (c) two-step | accepted (200, end_turn): stage 1 and stage 2 for each of the 2 parts | pending (round 2)                | not sent      | none                                                                                                                                        | yes (all 3 calls) | yes                             | yes                 | 1834/238; 2762/273; 2768/390 |

Round 2 (the plan's Sonnet calls) did not run as planned: no one-call candidate was accepted, so the probe sent nothing to Sonnet. Because only (c) works on Haiku, the Sonnet check of (c) is added as round 2 (the lead's follow-up in this task).

What it shows: every one-call form is refused, including the flat envelope with no union and no optional property (3.3 KB), which the documentation's advice suggested; the strict-tool forms hit a different limit ("compiled grammar is too large"). Splitting decide into two calls (the documentation's last advice, "split into multiple requests") is the only form accepted, its outputs are valid on the wire, and the mapped read is valid against K-02 v1's decideRead and equal to the fixture.

## Recommendation for CQ-25

**Choose (c), the two-step form, for claude-haiku-5-5.** Decide reaches the model as stage 1 (one structured output: the language and each part's quote and verb) and then one structured output per part that is not `no_op` (the verb's own K-02 schema less `verb` and `quote`), mapped by code into K-02 v1's `decideRead` unchanged. No K-02 change is proposed. The Sonnet cell of (c) is pending the lead's round 2 (`--live --round two-step-sonnet`); until it is filled, the choice is settled for Haiku and open for Sonnet. If Sonnet refuses a stage, the architect and the lead decide whether the Sonnet re-read uses another form; this spike does not guess.

### The decision rule applied

The rule written before the run (below, rule 4): "Only (c) works: choose (c), and size its cost (1 + parts calls a read) against the decide budget before C-115 starts." Round 1 gave exactly that case: (a) and (a') refused ("The compiled grammar is too large..."), (b) refused ("Schema is too complex."), (c) accepted with every output valid on the wire, mapped valid against `decideRead` and the same as the fixture. So rules 1 to 3 do not apply and rule 5 (a K-02 change) is not needed.

### Cost of (c), from results.jsonl (Haiku, the two-requests case: 2 parts, 3 calls)

| Call                   | Input tokens | Output tokens | Elapsed                                                                                                         |
| ---------------------- | ------------ | ------------- | --------------------------------------------------------------------------------------------------------------- |
| stage 1                | 1,834        | 238           | 6.3 s                                                                                                           |
| stage 2, part 1        | 2,762        | 273           | 3.8 s                                                                                                           |
| stage 2, part 2        | 2,768        | 390           | 2.6 s                                                                                                           |
| **one read (3 calls)** | **7,364**    | **901**       | 12.7 s one after another; about 10.1 s if the stage-2 calls run side by side (stage 1, then the slower stage 2) |

- **Calls.** A read is 1 + parts calls (3 for two parts; at most 1 + the parts a turn holds). Decide runs at least two reads a turn (arch 02 line 119), so a two-part turn is at least 6 model calls, and a re-read by Sonnet when the two reads disagree or a part is unmapped adds 3 more. The two reads are independent, so they can run side by side.
- **Tokens.** At the listed Haiku prices ($0.10 in and $0.50 out per million tokens), one two-part read costs about $0.0012 (7,364 x 0.10/1e6 + 901 x 0.50/1e6 = $0.00074 + $0.00045), so two reads about $0.0024. The input is the larger part: every stage-2 call carries the whole context again (about 2.7K tokens against stage 1's 1.8K). A one-part read would be 2 calls and about 4.6K input tokens. These are single measurements from one run, not an average.
- **Time.** About 10 to 13 s for a read on Haiku with `effort` low, one case, one run: a measurement, not a distribution; C-115 checks it against its own time budget. Two reads side by side cost the slower of the two, not the sum. The one-call forms were refused, so there is no faster accepted form to compare with.
- **Sonnet.** Not measured yet. If Sonnet's tokens match Haiku's (they will not exactly), one read at $2 and $10 per million tokens would be about $0.024. The round 2 lines replace this guess.
- **Levers for C-115 (not measured here):** run stage 2 for all parts side by side; cache the shared context so the stage-2 calls do not pay for it in full each time (the documentation's prompt caching; the compiled grammar is already cached for 24 hours [S1], and each stage-2 schema is static); skip stage 2 for `no_op` (already done).
- **What the form gives up.** The model's verb choice is made before its fields, in a separate call, so the fields of part k cannot change part k's verb. That is what the documentation's "split into multiple requests" advice trades for acceptance; a part whose stage 2 fails to map becomes an unmapped part, which already sends the turn to the one Sonnet re-read (arch 02 line 119; Q-41).

### What was written before the run (kept for the record)

Before round 1 the offline work favoured (b), the flat envelope, if it had been accepted on both models. It was refused, so this is history, not the recommendation. The reasons given then:

- It is one structured output, the same gateway path as the safety read and the planner, both accepted live in T-1066. It needs no tool loop and does not depend on the model choosing to call a tool (`auto` is the only choice on claude-sonnet-5-5 [S3]).
- It is the smallest and simplest schema: 3.3 KB, with no union and no optional property. Its only objects are the envelope, the part and the field. That is what the documentation advises when a schema is too complex ("simplify nested structures" [S1]), and it is far from every explicit limit.
- It is the cheapest per read. Decide runs at least two reads a turn (arch 02 line 119), and the eight tools add about 15 to 19 KB of tool schema to every request (cacheable, but sent and counted).
- Its cost is code. The grammar does not enforce each verb's own fields (a `choose` carries a question and a choice, a `hand_off` an `about`); `mapEnvelope()` checks them, then Ajv against `decideRead`. A part that fails becomes "an unmapped part", which already sends the turn to the one Sonnet re-read (arch 02 line 119; Q-41), so no new path is needed.

The rule written for when the table was filled (rule 4 is the one that applied):

1. (b) accepted on both models and mapped valid: choose (b).
2. (b) refused or its mapping fails, and (a') accepted and mapped valid: choose (a'), the eight strict tools with typed-text fields. Strict mode guarantees each part's own fields, and the gateway must treat "no tool call" as an unmapped part.
3. Only (a) works: choose (a), with K-02's fields unchanged on the wire.
4. Only (c) works: choose (c), and size its cost (1 + parts calls a read) against the decide budget before C-115 starts.
5. None works: the architect proposes a K-02 change under the contract-change skill, with this spike's refusal texts.

If one case reads differently from its fixture ("same as the fixture" is false), that is a model-quality signal, not a wire-form failure. It goes to the eval set (C-115's evals), not to this choice.

## For others

- **Architect (K-02), through the lead:** no K-02 change is needed if any candidate works, because each maps into the frozen `decideRead` unchanged. The fixture gap above (no `enter` read; no integer, boolean or time value) is worth a minor version with a fixture.
- **AI gateway (C-121):** check `stop_reason` before parsing: `refusal`, `max_tokens`, and for (a) `tool_use` with at least one tool call. Validate every mapped read with Ajv against `decideRead`; a mapping error is an unmapped part.
- **C-115 (decide):** the agreement of two reads is computed on the mapped `decideRead`, so it does not depend on the wire form. `agreementKey()` shows the fields compared.

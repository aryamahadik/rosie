# T-1121 findings: Linq on the real line, outbound side

Spike T-1121 (M2 Foundations; deployment linq-real, D-040), for the CTO and for the integrations engineer's T-414 and T-415. Two phases (the lead note DL-841 on the card): **phase 1** built the probe, its dry run against a local stand-in and its test, with no call to Linq; **phase 2** ran live on the build Mac on Nov 17 with the user present (DL-919, DL-920), and round 2 committed the masked samples (`samples/`) and filled in the answers below.

The two live runs were the lead's, each to the user's own phone alone (the one number on `STAGING_LINQ_ALLOWLIST`):

- **Run 2026-11-17T00-27-34Z-ddc156a1** (`capability` and `send`): both capability checks, then one text.
- **Run 2026-11-17T00-37-18Z-7ccff4e6** (`stopped` and `stopped-override`), after the user texted STOP to Rosie's line: one text without `override_optout`, then one with it. The user texted START afterwards.

Each answer names its sample. What the phone showed is the user's report to the lead (DL-919, DL-920); what Linq's documents say is the lead's reading of them on Nov 17 (DL-918 to DL-920). The inbound half is not answerable without the webhook move, and Android and landline were not checked: no roster Android or landline phone.

Sources: K-11 v1 (`contracts/port-linq/README.md`: spike rows 1, 6, 10, 13, 14 and 15, "Outcomes of a send", open gap 1; its `vendor-samples/`); the Linq double (`adapters/src/linq/double/`, T-411); QUESTIONS Q-03, Q-37, Q-44 and "Settled on Nov 5"; architecture section 10 "Phone number" and section 11 "An unregistered mobile texts"; DECISIONS DL-012, DL-013, DL-034, DL-839 to DL-841 and DL-918 to DL-920; Linq's documents (docs.linqapp.com): the API reference (`/api/`), the create-chat page (`/api/resources/chats/methods/create/`) and the webhook events page.

## For the CTO: Q-37 in one line

**Android: not checked: no roster Android or landline phone (Q-37 stays open); if the user adds one to `STAGING_LINQ_ALLOWLIST`, a live `--step capability` with `LINQ_PROBE_TO` naming it records what Linq's capability check says for it.**

## The samples (`samples/`)

Each sample is one file of a live run, named after its run folder and then its own name in that folder (a `run.json`'s `file` gives the name in the folder). The JSON is what the probe wrote, in the repository's prettier layout (a short list on one line), with no value changed. Every number shows its last 2 digits alone (`***NN`) and the one name field shows `[name]`; no sample holds a key, an Authorization header or an email address. They keep Linq's own ids (the chat's, the handles' and the messages') and its trace ids: none is a key, a number or a name.

- `live-2026-11-17T00-27-34Z-01-capability-check_imessage.json`: step `capability`, `POST /v3/capability/check_imessage`: 200, `available` true; read as `capabilityCheck` `checked`, available, `service` null.
- `live-2026-11-17T00-27-34Z-02-capability-check_rcs.json`: step `capability`, `POST /v3/capability/check_rcs`: 200, `available` true; the probe's RCS reading beside K-11's: `checked`, available, `service` null.
- `live-2026-11-17T00-27-34Z-03-send-send.json`: step `send`, `POST /v3/chats`: 201, the chat with the message in it (`delivery_status` pending); read as `sendPart` `accepted`, `service` null.
- `live-2026-11-17T00-27-34Z-run.json`: that run's summary.
- `live-2026-11-17T00-37-18Z-01-stopped-send.json`: step `stopped`, `POST /v3/chats`: 403, code 2024; read as `failed`, `optedOut`.
- `live-2026-11-17T00-37-18Z-02-stopped-override-send.json`: step `stopped-override`, `POST /v3/chats` with `override_optout` true: 201, the chat with the message in it; read as `accepted`, `service` null.
- `live-2026-11-17T00-37-18Z-run.json`: that run's summary.

## The questions and their answers

1. **What contacts/add returns.** Nothing: Linq's v3 API has no such call. Its API reference has no contacts resource and no contacts/add; the closest are `POST /v3/chats/{chatId}/participants`, `POST /v3/chats` and the contact card. A send by number needed no add first: `POST /v3/chats` was accepted (201) and the text reached the user's phone (`live-2026-11-17T00-27-34Z-03-send-send.json`). So the contact step never ran live, `CONTACT_ADD_PATH` stays a placeholder in `wire.mjs`, and Q-03's default (contacts/add when a mobile is saved, before any chat link) has no v3 call to run. **For the architect: K-11's open gap 1 stays open, and T-415's contacts/add (C-208; K-07's `linq_contact_add` effect) needs a ruling before it builds.**
2. **How soon a new contact's text is accepted.** Not answered. There is no contacts/add to time from (answer 1). The one roster phone was not new to the line: the send's answer is a chat whose two handles joined on 2026-10-22, and both runs got that same chat (one id), so Linq answered the send by number with the chat it already had. A new phone's own text to the line is inbound: not answerable without the webhook move (J-08, T-417).
3. **The capability check for a roster iPhone.** iMessage available and RCS available: `check_imessage` answered 200 with `available` true (`live-2026-11-17T00-27-34Z-01-capability-check_imessage.json`), and `check_rcs` answered 200 with `available` true (`live-2026-11-17T00-27-34Z-02-capability-check_rcs.json`). Each answer held `address` and `available` alone, with no `reason` and no `selected_service` (K-11 spike row 13 names both), so the port reading's `service` is null. The text that followed went by iMessage: in its answer the chat's `service` and both handles' read `iMessage`, and the user saw a blue iMessage bubble.
4. **The capability check for an Android number (Q-37).** Not checked: no roster Android or landline phone. Q-37 stays open for the CTO.
5. **The capability check for a landline.** Not checked: no roster Android or landline phone.
6. **A send to a number that texted STOP.** 403 with code 2024, read as K-11's `optedOut` (`live-2026-11-17T00-37-18Z-01-stopped-send.json`): `success` false, `error` with `code` 2024, `status` 403, `message` "Recipient asked you to stop messaging them" and `doc_url`, and `trace_id`, the shape of K-11's `vendor-samples/error-2024.json` (whose `doc_url` the live answer gives under `/channel/imessage/error/codes/2xxx/2024/`). Nothing from that send reached the phone (the user's report).
7. **What `override_optout` changes.** It lets that one send through the block. The same send with `override_optout` true, 193 ms later and before the user's START, was accepted (201, `live-2026-11-17T00-37-18Z-02-stopped-override-send.json`) and arrived as a blue iMessage bubble with the same words (the user's report). The chat in that answer still reads `health_status.status` `OPTED_OUT` (updated 00:36:41Z, after the user's STOP), where the first run's read `HEALTHY`. **For the architect:** K-11 records the opposite. Its spike row 15 says `override_optout` does not lift 2024's block, and its paragraph "A send with `overrideOptout` that still gets 2024" builds on that; the live run shows the block lifted for the one send, which is what arch 10 line 524 and the STOP chain rely on. A change to K-11 goes through the contract-change skill (not on this card). The dry run's stand-in (`stub.mjs`) still answers the override step 403, as row 15 says: round 2 changes no code path.
8. **Whether Linq itself answers STOP or HELP.** STOP: no answer reached the phone. After the user texted STOP, the only text that arrived was the override send's (the user's report), so neither Linq nor the old demo, which still receives the line's webhooks, answered it. HELP was not tried: not checked.
9. **Whether an inbound handle can be an email address, from Linq's documents.** Not said. Linq's webhook events page gives `message.received`'s sender as `data.sender_handle.handle` (`data.from` in 2025-01-01 payloads), every example in E.164, and says nowhere that a handle can be an email address. No webhook event on that page tells of a STOP or an opt-out; an outbound answer does, in the chat's `health_status` (answer 7). A live capture is inbound: not answerable without the webhook move (J-08, T-417).

## Vendor facts for the architect, T-414 and T-415

1. Linq's v3 API has no contacts/add (answer 1): K-11's open gap 1; T-415's contacts/add needs a ruling.
2. `override_optout` lifts 2024's block for its one send (answer 7), against K-11 spike row 15 and its paragraph "A send with `overrideOptout` that still gets 2024".
3. When a check says available, the capability answer is `address` and `available` alone (answer 3): no `selected_service` to read the service from, and no `reason`.
4. A send by number (`POST /v3/chats`) answers 201 with the chat: `chat.id`, `chat.handles`, `chat.service`, `chat.health_status` and `chat.message`, not a top-level `message` as a send into a chat answers (`vendor-samples/send-message-response.json`). At that moment the message's own `service` and `sent_at` are null and its `delivery_status` is pending. The probe's port reading looks for a top-level `message`, so its `service` null comes from no field here; `chat.message.service` is null as well, so the reading stands.
5. To a number the line already has a chat with, `POST /v3/chats` answers with that chat (the same id in both runs; its handles joined 2026-10-22).
6. After STOP, the chat's `health_status.status` reads `OPTED_OUT` (its `doc_url` ends `chat-health#opted-out`), even in the answer to a send `override_optout` let through; before, it read `HEALTHY`. 2024's body is `vendor-samples/error-2024.json`'s shape, with its `doc_url` under `/channel/imessage/error/codes/2xxx/2024/`.

## The probe (phase 1)

`bash adapters/spikes/linq-live/probe.sh --dry-run|--live [--step <step>]... [--out <folder>]`

- `probe.sh` reads the values by name, each from the environment, else, in a live run alone, from the git-ignored `.dev.vars` at the checkout's root through `infra/scripts/lib.sh`'s `load_dev_var`, as `seed-staging.sh` does: `LINQ_API_TOKEN` (Linq's key), `ROSIE_NUMBER` (Rosie's sending line; `LINQ_FROM` when `ROSIE_NUMBER` is not set), `STAGING_LINQ_ALLOWLIST` (E.164 numbers joined by commas with no space) and `LINQ_PROBE_TO` (the one destination, needed only when the list holds more than one number). Each goes into a variable of the script's own, never exported, and its name leaves the environment before any command is started; the Node probe gets them on its standard input alone, written by `printf`, a builtin, so no command's arguments or environment ever hold them. No value is printed.
- `lib.mjs` refuses, before any request: no list, an empty one, an entry that is not E.164 (named by its place alone), a destination off the list (shown as `***02`), Rosie's own line as the destination, no key or one that cannot be a key (named by the variable alone), no sending line. A dry run also refuses any number outside the fiction range (555-0100 to 555-0199).
- The steps, in this order: `capability` (two reads), `contact` (no message), `send`, `stopped` and `stopped-override` (one message each at most, never retried, in words that say plainly it is a Rosie staging test). A dry run's default is every step; a live run's is `capability` and `send`, and a live run takes the stopped steps alone.
- The key goes in the Authorization header of each request and nowhere else. A live run's requests go to `https://api.linqapp.com/api/partner/v3` alone, a dry run's to 127.0.0.1 alone, and no request follows a redirect.
- Each request's record is one JSON file in the output folder (`<nn>-<step>-<call>.json`: the request's path and body, the answer's status, a few of its headers and its body, the answer read in K-11's terms, and the time it took), with `run.json` for the whole run. Every number in them, and in every line printed, shows its last 2 digits alone (`***01`); an email address shows as `[email]` and a name field as `[name]`.
- `stub.mjs` is the dry run's stand-in for Linq (127.0.0.1 only), answering the shapes K-11 records; `--stub-url http://127.0.0.1:<port>` points a dry run at another one, such as the test's.
- `probe.test.mjs` (`node --test adapters/spikes/linq-live/probe.test.mjs`) proves the refusals, the masking, that the key reaches only the Authorization header (never a command's arguments or environment, a line of output or a file), one message a step and its words, and that no file under `samples/` holds a key-shaped value or an unmasked number. It never runs `--live`.

## How the lead runs phase 2

Done on Nov 17 (DL-918 to DL-920): steps 1 to 3, then step 5 with the user's yes, then step 6 (round 2). Step 4 did not run: Linq's v3 API has no contacts/add (answer 1). The steps stay for a later run, such as an Android phone added to the list.

1. **Before the run.** The user adds `STAGING_LINQ_ALLOWLIST` to `.dev.vars` by hand, holding the user's own phone alone (DL-604, DL-841); `LINQ_API_TOKEN` and `ROSIE_NUMBER` are already there (DL-034). Read Linq's send documents and correct `CHAT_CREATE_PATH` and `chatCreateBody` in `wire.mjs` if they differ (a send by number opens a chat, with `from`, `to` and the message); on Nov 17 they matched (DL-918). For the contact step, set `CONTACT_ADD_PATH` and `contactAddBody` from Linq's documents or support.
2. **A dry run first**, with fiction values alone: `LINQ_API_TOKEN=dry-run-not-a-key ROSIE_NUMBER=+15555550199 STAGING_LINQ_ALLOWLIST=+15555550101 bash adapters/spikes/linq-live/probe.sh --dry-run`.
3. **The live run, with the user present:** `bash adapters/spikes/linq-live/probe.sh --live` from the checkout's root (the two capability checks and one text to the user's phone). If the classifier refuses the lead's run, the user runs `! bash adapters/spikes/linq-live/probe.sh --live`. The user says whether the text arrived, and whether as iMessage.
4. **The contact step**, once its path is confirmed: `bash adapters/spikes/linq-live/probe.sh --live --step contact`.
5. **The stopped-number steps, only if the user says yes:** the user texts STOP to Rosie's line, then `bash adapters/spikes/linq-live/probe.sh --live --step stopped --step stopped-override`; the user says what the phone showed after STOP (question 8), then texts START (Linq lifts the block on any later text that is not a stop word: K-11 README spike row 15). The old demo receives both texts.
6. **Round 2.** Each live run writes to `scratch/linq-live/live-<time>/` (git-ignored). Copy the files T-414 and T-415 replay into `samples/`, run `node --test adapters/spikes/linq-live/probe.test.mjs` (its fixture check reads `samples/`), and fill in the answers above, each with its sample's name.

## Defaults used (phase 1)

1. `LINQ_PROBE_TO`, a fourth name, so that a destination off the list can exist and be refused; when it is not set, the destination is the list's one number, and a longer list needs it.
2. The values reach the Node probe on its standard input, not in its environment (the lead note says "handed only to the probe's own command line"): the stricter reading of "never an argument or the environment of a child".
3. A dry run reads the environment alone, never `.dev.vars`, and takes fiction numbers alone, so no real number can enter a dry run's output.
4. A masked number is written `***` and its last 2 digits; a live run's default output folder is `scratch/linq-live/live-<time>/`, outside git, until round 2 picks the samples.
5. The three message steps send by number (`CHAT_CREATE_PATH`), since the probe holds no chat id; Rosie's product only sends into an existing chat (arch 07 line 369).
6. A live run's default steps are `capability` and `send`; `contact` waits for its path, and the stopped steps for the user's yes.

## Defaults used (round 2)

1. Every file of both runs is a sample, the two `run.json` summaries included, since T-414 and T-415 may replay any of them; each is named after its run folder and then its own name.
2. The samples are in the repository's prettier layout (`npm run format:check` reads every JSON file): only whitespace differs from the run folders' files.
3. `stub.mjs` and `probe.test.mjs` still answer the override step 403, as K-11 spike row 15 says: round 2 changes no code path, and matching the stand-in to the live answer waits on the architect's ruling on row 15.

Time: phase 1, 59 minutes (18:31Z to 19:30Z, Nov 15); round 2, 66 minutes (00:39Z to 01:45Z, Nov 17), about 20 of them on the samples, the comments and these answers, the rest waiting on the repository-wide checks under load: 2 hours 5 minutes together, 5 minutes over the 2-hour estimate.

# T-1121 findings: Linq on the real line, outbound side

Spike T-1121 (M2 Foundations; deployment linq-real, D-040), for the CTO and for the integrations engineer's T-414 and T-415. Two phases (the lead note DL-841 on the card): **phase 1**, this folder, built the probe, its dry run against a local stand-in and its test, with no call to Linq; **phase 2**, once phase 1 passes, is one live run by the lead on the build Mac with the user present, then a short round 2 that commits the masked samples and fills in the answers below.

So every answer here is **pending the live run**, except the ones the card fixes: the inbound half is "not answerable without the webhook move", and Android and landline are "not checked: no roster Android or landline phone".

Sources: K-11 v1 (`contracts/port-linq/README.md`: spike rows 1, 6, 10, 13, 14 and 15, "Outcomes of a send", open gap 1; its `vendor-samples/`); the Linq double (`adapters/src/linq/double/`, T-411); QUESTIONS Q-03, Q-37, Q-44 and "Settled on Nov 5"; architecture section 10 "Phone number" and section 11 "An unregistered mobile texts"; DECISIONS DL-012, DL-013, DL-034, DL-839 to DL-841.

## For the CTO: Q-37 in one line

**Android: not checked, since no roster phone is an Android (Q-37 stays open); if the user adds one to `STAGING_LINQ_ALLOWLIST`, a live `--step capability` with `LINQ_PROBE_TO` naming it records what Linq's capability check says for it.**

## The questions and their answers

Each live answer comes with its recorded request and response (`scratch/linq-live/live-<time>/`, then `samples/` in round 2), with no key in it and every number masked to its last 2 digits (`***01`).

1. **What contacts/add returns.** Pending the live run. Its path and body are not in the repository: K-11's open gap 1 found no documented Linq call that adds a contact to the line. `wire.mjs` holds them as named constants marked TODO for phase 2 (`CONTACT_ADD_PATH`, `/contacts` on the v3 base, and `contactAddBody`, `{phone_number}`); a live run takes the contact step only when it is named (`--step contact`), once they are confirmed.
2. **How soon a new contact's text is accepted.** Not answerable in this spike. A new contact's own text to Rosie's line is inbound, and Linq's webhook still points at the old demo: not answerable without the webhook move (J-08, T-417). The outbound half (a send right after the add) needs a phone that is not yet a contact, and the one roster phone may already be one of the line's 2 contacts in use (QUESTIONS, "Settled on Nov 5", texting row). A live `--step contact --step send` records both calls with their times, which answers it for a new phone if one is ever used.
3. **The capability check for a roster iPhone.** Pending the live run (`--step capability`, in a live run's default steps): Linq's `check_imessage` and `check_rcs` for the user's phone, read in K-11's terms as `checked`, with what each check says and the service a message would go by, or `failed`.
4. **The capability check for an Android number (Q-37).** Not checked: no roster Android or landline phone (the lead note, item 4). Q-37 stays open for the CTO.
5. **The capability check for a landline.** Not checked: no roster Android or landline phone.
6. **A send to a number that texted STOP.** Pending the live run, and only if the user says yes at it (`--step stopped`). K-11 expects 403 with code 2024, read as `optedOut`.
7. **What `override_optout` changes.** Pending the live run, on the same yes (`--step stopped-override`). The repository's record of Linq's 2024 page says `override_optout` does not lift that block (K-11 README spike row 15); the dry run's stand-in answers so.
8. **Whether Linq itself answers STOP or HELP.** Pending the live run, and partly not answerable here: what the phone shows after it texts STOP is seen on the phone, but an answer may come from Linq or from the old demo, which still receives the line's webhooks. Telling the two apart needs the webhook move (T-417) or the old demo's own log. HELP is texted only if the user agrees.
9. **Whether an inbound handle can be an email address, from Linq's documents.** Not answered in phase 1, which reads no outside document. The repository's record of Linq's documents (K-11 README spike row 6, read Nov 7) gives `message.received`'s `sender_handle.handle` as E.164 and records no email form. In phase 2 the lead reads Linq's webhook events page (docs.linqapp.com, `/channel/imessage/guides/webhooks/events/`); a live capture is inbound, so it is not answerable without the webhook move.

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

1. **Before the run.** The user adds `STAGING_LINQ_ALLOWLIST` to `.dev.vars` by hand, holding the user's own phone alone (DL-604, DL-841); `LINQ_API_TOKEN` and `ROSIE_NUMBER` are already there (DL-034). Read Linq's send documents and correct `CHAT_CREATE_PATH` and `chatCreateBody` in `wire.mjs` if they differ (a send by number opens a chat, with `from`, `to` and the message). For the contact step, set `CONTACT_ADD_PATH` and `contactAddBody` from Linq's documents or support.
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

Time: phase 1, 59 minutes (18:31Z to 19:30Z, Nov 15), within the 2-hour estimate.

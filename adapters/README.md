# adapters (`@rosie/adapters`)

**Owner:** the integrations engineer (build prompt section 4). **Checked by:** security.

One adapter per port (plan 3.2), each with its test double first. Staging uses test doubles or test modes for every paid or outside service until Jay approves the real one (build prompt 5.3).

- Code lives in `src/`, with unit tests beside it (`src/**/*.test.ts`, Vitest project `unit`), against the doubles.
- An adapter that needs a key names it in `wrangler.jsonc`'s `secrets.required` (through the release engineer). Keys are never committed, printed or put in a test.

## Layout

One folder per port under `src/`, each holding that port's adapter, its test double and its recorded vendor samples (`src/<port>/samples/`). The vendor's wire format stays inside the port's folder (02-contracts section 5).

| Folder     | Port                        | K-08 providers                          |
| ---------- | --------------------------- | --------------------------------------- |
| `linq`     | Linq (K-11)                 | `linq`                                  |
| `email`    | Email through Resend (K-12) | `resend`                                |
| `stripe`   | Stripe Connect (K-14)       | `stripe`                                |
| `calendar` | Google and Microsoft (K-16) | `google_calendar`, `microsoft_calendar` |
| `places`   | Google Places (K-15)        | `google_places`                         |
| `files`    | R2 files (K-13)             | `r2`                                    |
| `geo`      | Geocoding (K-17)            | `geo`                                   |

Each folder is created by the task that builds its double and adapter (T-411 onward); `src/shared/ports.ts` lists them. **There is no `sms` folder and no SMS export**: SMS is archived (DL-012), and a test asserts it.

## `src/shared` (T-410)

What every adapter takes from the base, through `@rosie/adapters/shared` (the sample loader is for tests and is imported from `src/shared/samples` directly, since it reads files):

- `hmac.ts`: HMAC-SHA256 with Web Crypto. `signHmacSha256`, `verifyHmacSha256` (constant-time, false for a changed byte or a bad hex string) and `verifyWebhookSignature` (the signed string `id.timestamp.raw` and a 300 s window, K-11). The secret is passed in by the caller from the environment; this code holds and returns none.
- `spans.ts`: `buildOutsideCallSpan` makes a K-08 v1 span for an outside call (`portCall`, `effectRun`, `dispatch`) with `provider`, `call` and `attempt`, the bundle id and a handle reference; `spanLogLine` writes it as one JSON line (ADR-009) and refuses a line that still holds an E.164 number, an email address or a key. A phone number, message text, address or key is replaced by `redacted`; an input that cannot make a valid span is refused with an error that never holds the value.
- `redact.ts`: the patterns behind both (phone, email, key shapes) and `redactFreeText` for a message that must be logged.
- `samples.ts`: `loadRecordedSample`, `loadRecordedSampleText` (the exact bytes, for a webhook's signature), `listRecordedSamples` and `samplesDir(port)`. A sample with a key-shaped value, a phone number outside the fictional `+1 xxx 555 01xx` block or an email outside the reserved example domains is refused (build prompt rules 7 and 9).
- `ports.ts`: the port folders, the K-08 provider list and the outside-call hops.

D-000 held only this file and `package.json`.

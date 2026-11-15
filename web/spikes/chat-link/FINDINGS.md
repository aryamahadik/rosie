# Chat-link device check: findings (T-1043)

For the frontend engineer and the CTO. Written under DL-794 from the records only. Nothing was run on a device for this note, and nothing here is invented (DL-082). The repository is public, so Rosie's real line is not written here: where the text says "Rosie's line", it is the config value (Q-51). The fixtures and T-1120's page use a made-up number in the 555-01xx range.

## What the user reported

- Time: about 2026-11-07T07:20Z (time corrected from the ops commits, DL-066), said in the build chat.
- The user's words, as given: "qr sacn work jsut og ahead of those".
- Read as: scanning the test page's QR codes on the user's phone works, and the build goes on.
- DL-794 closed the check on that report. On Nov 15 the user said not to be asked anything and to finish the build. T-513 and T-524 do not wait on more device answers.

## The forms T-1120's test page offers

Read from `web/spikes/chat-link/build.mjs` (the page is `index.html`). Each form has a link and an inline QR code that encodes exactly that link, so the QR text is the link text. Fixture line `+15555550123`, ready text `Hi Rosie, I would like to book. Code ZX7Q4K`, encoded with `encodeURIComponent`.

| Form id                 | Targets         | Link and QR text                                    |
| ----------------------- | --------------- | --------------------------------------------------- |
| ios-ampersand           | iOS             | `sms:<line>&body=<encoded text>`                    |
| android-question        | Android         | `sms:<line>?body=<encoded text>`                    |
| both-question-ampersand | iOS and Android | `sms:<line>?&body=<encoded text>`                   |
| ios-double-slash        | iOS             | `sms://<line>&body=<encoded text>`                  |
| android-double-slash    | Android         | `sms://<line>?body=<encoded text>`                  |
| number-only             | iOS and Android | `sms:<line>` (no body; the customer types the code) |

## Device results

| Device and OS version                  | Form scanned | Messages opened to Rosie's line | Ready text and short code intact |
| -------------------------------------- | ------------ | ------------------------------- | -------------------------------- |
| The user's phone                       | not reported | not reported                    | not reported                     |
| Each other roster iPhone (iOS version) | not reported | not reported                    | not reported                     |
| An Android phone                       | not reported | not reported                    | not reported                     |
| A Mac                                  | not reported | not reported                    | not reported                     |

Only the user's one report above is known: "qr sacn work". The phone, its iOS version, which of the 6 forms was scanned, whether Messages showed Rosie's line with the ready text and short code intact, an Android phone and the Mac are all not reported. No screenshot exists or is referenced.

The rest of the table (each roster iPhone's iOS version, an Android phone, the Mac) is filled in at D-018's real-iPhone run, where the user is present anyway (T-1031).

## Recommended link form

`sms:<Rosie's line>&body=<the ready text, RFC 3986-encoded>`

This is the form K-09's fixtures already define: `chat-link-after-contact-add.json` has `link` and `qrText` of `sms:+15555550188&body=Hey%2C%20send%20me%20further%20updates%20about%20my%20booking%20BEN21X`, and `staff-join-link.json` has `sms:+15555550188&body=Join%20Lee%27s%20Barbershop%20on%20Rosie%20JOIN7R`. In both, `link` and `qrText` are the same string.

T-1120's code `ios-ampersand` encodes this form, so the QR code for `ios-ampersand` is the one that matches. The other five forms differ (`?body=`, `?&body=`, `sms://`, or no body).

Notes for T-513 and T-325:

- The fixtures encode the apostrophe in "Lee's" as `%27` (RFC 3986). `encodeURIComponent`, used by T-1120's page, leaves `'` as is. The T-1120 fixture text has no apostrophe, so what was scanned does not test that case. Encode the apostrophe as `%27` as the fixtures do, and check it at the real-iPhone run.
- The recommendation rests on the contract's fixtures and the user's "QR scan works" report, not on a per-device result. It stands until the real-iPhone run (T-1031) says otherwise.

## Fallback in plain words

For a phone where the link does not open Messages filled in, show this text beside the QR code and the link:

"Open Messages and text Rosie's line, the number shown on this page, with exactly these words: <the ready text, with its short code>."

For example, a booking's ready text is: `Hey, send me further updates about my booking BEN21X`. A staff invite's is: `Join Lee's Barbershop on Rosie JOIN7R`. The customer types the words exactly, including the short code, and sends them. The page shows the number and the words as plain text a person can read and copy, not only inside the link. The `number-only` form (`sms:<line>`) is a second fallback that opens Messages to the right number so the customer types the words.

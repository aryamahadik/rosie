# Fixture set v1: known stale lines and known gaps

Fixture set v1 is regenerated as the master's scripts write it (Q-36). Nothing here is fixed by hand. Where a line below disagrees with the corrections, **C9 wins in tests** (Master Corrections section 3, C9: no SMS provider, Rosie never writes first, a code is never texted to a mobile that has not texted Rosie).

## Stale under C9 (Q-36)

Both lines come from `engine/work/phase4/tools/test-kit.js` in the master (the same line numbers in the unpatched script and in the fresh copy). They are copied into `test-kit/SCENARIOS.md` as the script writes them.

| Source line | Text starts | Why stale | Where it lands | What a test uses instead |
|---|---|---|---|---|
| `test-kit.js` line 179 | `- **First contact** (D103): ... Expect: one SMS (booking confirmed, one link that opens Messages ...` | C9: no SMS is sent. The chat link, with a QR code, reaches the person on the booking page and in the confirmation email; sending the ready text opens the chat | `test-kit/SCENARIOS.md` line 531 | C9 and RULES 4.1b: no SMS; link and QR on the page and in the email; the sent ready text opens the chat |
| `test-kit.js` line 176 | `- **Change where updates go** (D75): ... a code goes there; ...` | C9: a code is never texted to a mobile that has not texted Rosie. For a new number, Rosie asks the person to text from it; for a booking with an email the code may go by email | `test-kit/SCENARIOS.md` line 528 | C9: the new mobile texts in first, or the code goes by email |

`test-kit/SCENARIOS.md` line 529 (Lost phone, D100) is not listed in the card but reads the same way for a new number; C9 wins there too.

## Known gaps in the demo shops (T-001 architect ruling, Q-36 addition)

Master Corrections section 5 names three fixes (G1, G2, G3). They are applied. A fourth fix is not made (default: no; R3 keeps each `pf.*` block whole as text for the AI; nothing waits on it, DL-063). So these shops keep an empty field in `test-kit/shops/<id>.json`, and a test must not expect it filled:

| Shops | Empty field | Cause |
|---|---|---|
| florist | `safety_stop` | its trade file names the key `danger words`, which the `KEYS` table in `frontend-map.js` does not map |
| architect, art-appraiser, hunting-guide, pet-cremation | `messages_never` | their `pf.messages` is plain text, not a list the script reads |
| laundry, shoe-repair, tailor, upholstery | `safety_stop` | empty in the trade file (`"stop_words": []`): a correct copy, not a gap |

## Other results of the rebuild

- `frontend-map.js --check` fails one line: "no banned wording in either file", on the word "share" inside "shared-number". Every other check passes (243 professions, 28 of 28 money combos in both flows).
- 46 of 56 money combos are used by a profession. The other 10 are covered by `test-kit/shops/test-mixed-A.json` and `test-mixed-B.json`.
- The phone numbers `800-222-1222` and `800-569-4287` in some forms are public hotline numbers written in the trade files (Poison Control and a HUD housing counselor line), not customer data.

# common: shared formats and meta-schemas

**Owner:** the architect. **Consumers:** every contract (through `$ref`), and through them every role that builds against one. **Status:** draft, not frozen. The shared formats are frozen with the first contract that refers to them (F1, the bundle format and the model's contract), once its consumers have reviewed them.

## What it defines

- `formats.v1.schema.json`, the shared formats, under `$defs`:
  - `id`: an opaque id, a non-empty string that code never parses;
  - `turnId`: a turn's id, a hash of the event ids of the texts it joins;
  - `bundleId`: a bundle's id, `{ "hash": <content hash of the compiled files>, "build": <build number> }`; the hash's algorithm and spelling belong to the bundle contract (K-01);
  - `currency`, `money`: `{ "cents": <integer>, "currency": "USD" }`, whole cents with a three-letter currency code, never a decimal;
  - `utc`, `zone`, `time`: `{ "utc": "2026-11-07T15:30:00Z", "zone": "America/New_York" }`, an instant in UTC with its IANA zone.

  They keep to the model API's structured-outputs subset (no number, length or count limits), so a model-facing schema may refer to them. Whether an amount may be zero or negative, whether a date exists, and whether a zone is in the IANA database are code checks.

- `fixtures-index.meta.schema.json`: the shape of every `fixtures/index.json`.
- `frozen.meta.schema.json`: the shape of every `frozen.json`.

## Sources

- `ops/QUESTIONS.md` CQ-09 (ids, money and times; the CTO decides; this is its default in use), citing architecture 01 lines 59 and 87, tour line 658 and S13-03.
- `ops/plan/02-contracts.md` section 2 items 5, 7, 10 and 11.

## Freeze record

Not frozen.

## Change log

- v1 (T-006): first draft, from CQ-09's default.

## Open gaps

- CQ-09 is open with the CTO: the bundle id, other ids, money and times. If he rules otherwise, the architect lists what was built on these formats (6.4).

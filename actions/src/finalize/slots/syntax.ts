// Slots as a text writes them (K-03 v1 `slottedText`; SPEC-master 5h; overlay-core.js SLOT_RE line 1284):
// `{{name}}`, `{{name:example words}}` or `{{name:example|other words}}`. A text splits into its plain words, its slots
// and any `{{` that opens no slot, which is kept as written so the Values check still finds it (arch 07 line 409).

/** One `{{...}}` written in a text. */
export interface SlotRef {
  /** The whole `{{...}}` as written. */
  readonly raw: string;
  readonly name: string;
  /** The words after ':', the master's example (illustrations, MC C6), or null. */
  readonly example: string | null;
  /** The words after '|', or null. */
  readonly other: string | null;
}

/** A piece of a text: plain words, a slot, or a `{{` that opens no slot. */
export type Piece =
  | { readonly kind: "words"; readonly text: string }
  | { readonly kind: "slot"; readonly ref: SlotRef }
  | { readonly kind: "broken"; readonly text: string };

// A name, then the example after ':' and the other words after '|' (overlay-core.js SLOT_RE line 1284, as the
// compiler's slots/vocabulary.ts reads it). Sticky: it is tried at each `{{`.
const SLOT_AT = /\{\{\s*([a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)?)\s*(?::([^{}|]*))?(?:\|([^{}]*))?\}\}/y;

/** Splits a text into its pieces, in order; joining their texts gives the text back. */
export function pieces(text: string): Piece[] {
  const out: Piece[] = [];
  let from = 0;
  let open = text.indexOf("{{");
  while (open >= 0) {
    if (open > from) out.push({ kind: "words", text: text.slice(from, open) });
    SLOT_AT.lastIndex = open;
    const match = SLOT_AT.exec(text);
    if (match === null) {
      // Not a slot: its first brace is kept as written and the scan goes on from the next one, so `{{{day}}` still
      // finds {{day}} and the stray brace is reported.
      out.push({ kind: "broken", text: "{" });
      from = open + 1;
    } else {
      const [raw, name = "", example, other] = match;
      out.push({ kind: "slot", ref: { raw, name, example: example ?? null, other: other ?? null } });
      from = open + raw.length;
    }
    open = text.indexOf("{{", from);
  }
  if (from < text.length) out.push({ kind: "words", text: text.slice(from) });
  return out;
}

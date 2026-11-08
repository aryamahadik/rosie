// SCRATCH (deleted before commit): the master's strings the new reading flags, and the probe lines.
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { moneyClaims } from "./index";
import { sources } from "./test-support";

const OUT =
  "/private/tmp/claude-501/-Users-aryamahadik-Downloads-Rosfield-Main-rosie/d9982744-6798-4bc7-ad8e-3fc2a5092574/scratchpad/flagged.txt";

const PROBES = [
  "Your card will be held for $40 until the visit.",
  "Your saved card is held for {{deposit}} until Sat 11:00am.",
  "If you don’t reply by Fri 11am, we’ll charge the $20 fee to your card.",
  "If you haven't answered within 24 hours, the late-cancel fee is charged to the saved card.",
  "If you haven’t answered within 24 hours, the late-cancel fee is charged to the saved card.",
  "If we don't get a reply by 7pm, we'll charge your card.",
  "If we don’t get a reply by 7pm, we’ll charge your card.",
  "$40 is held on your card until the visit.",
  "On your saved card, we'll hold {{deposit}} until Sat 11:00am.",
  "We'll put a {{deposit}} hold on the card you saved.",
  "Your card is authorised for $40 before the visit.",
  "{{deposit}} is reserved on your card.",
  "We block $40 on your card until the visit.",
  "Your saved card will be frozen for {{deposit}}.",
  "The deposit is held until the visit.",
  "We'll charge your card if you don't reply by 7pm.",
  "No reply means we charge.",
  "If there's no response by 7pm, we debit your card.",
  "We take payment if we don't hear back by Fri 11am.",
  "Silence means we bill your saved card.",
  "No reply by 7pm? We'll charge the saved card.",
  "The $20 fee is charged to your card unless you reply by 7pm.",
  "If you stay silent, the deposit is kept.",
  "If you don't reply by 7 p.m. we'll charge your card.",
  "--- denied / not money ---",
  "We never hold your card.",
  "Nothing is held on your card.",
  "No $40 hold is ever placed on your card.",
  "If you don't reply, we won't charge your card.",
  "If you don’t reply, we won’t charge your card.",
  "No charge without your yes.",
  "If you haven't answered within 24 hours, nothing is charged to the saved card.",
  "If we don't get a reply by 7pm, there's no charge.",
  "Your spot is held for 15 minutes.",
  "Pay the $40 deposit to hold your time.",
  "The page holds your time until {{ask.by}}.",
  "Hold on to this text: your $40 deposit is paid.",
  "If you don't reply, the bill comes after the visit.",
  "You were charged $55.",
  "You paid $55.",
  "Free to cancel until Fri 11am. After that, a $20 fee may be kept from what you paid",
  "The $40 you paid goes back to the card it was paid with.",
];

it("dumps", async () => {
  const src = await sources();
  const seen = new Map<string, string>();
  const walk = (value: unknown, at: string): void => {
    if (typeof value === "string") {
      if (!seen.has(value)) seen.set(value, at);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, `${at}[${String(index)}]`);
      });
      return;
    }
    if (typeof value === "object" && value !== null)
      for (const [key, item] of Object.entries(value)) walk(item, `${at}.${key}`);
  };
  walk(src.flows.A, "A");
  walk(src.flows.B, "B");
  const lines: string[] = [`strings: ${String(seen.size)}`];
  const flagged = (claims: readonly string[]): string[] =>
    claims.filter((claim) => claim === "cardHold" || claim === "chargeOnSilence" || claim === "youPaid");
  const shown = new Set<string>();
  for (const [text, at] of seen) {
    if (flagged(moneyClaims(text)).length === 0) continue;
    const pieces = text.split(/(?<=[.!?…])\s+|\n+/);
    const hits = pieces.filter((piece, index) => {
      const two = `${piece} ${pieces[index + 1] ?? ""}`;
      return (
        flagged(moneyClaims(piece)).length > 0 || (/\?$/.test(piece) && flagged(moneyClaims(two)).length > 0)
      );
    });
    for (const hit of hits.length > 0 ? hits : [text]) {
      const key = hit.slice(0, 300);
      if (shown.has(key)) continue;
      shown.add(key);
      lines.push(`${at} | ${flagged(moneyClaims(hit)).join(",")} | ${key}`);
    }
  }
  lines.push("=== probes ===");
  for (const text of PROBES) lines.push(`${moneyClaims(text).join(",")} | ${text}`);
  writeFileSync(OUT, lines.join("\n"));
});

// L1, record words in a variant (T-153; lib.js lintSteps lines 1914-1922; recordKeyParts and timingKeyParts, lines
// 1743-1757).
//
// The booking record (T-137) holds, once, what a booking took, how the customer is reached and who said yes; a step
// says it through a record slot ({{pay.took}}, {{reach.way}} ...). A step variant keyed on a record value says it a
// second time, and can drift from the record. So:
//
//   - in the zone (after the money step, or sections 11 and 12; the money step's own steps aside), a vary key naming a
//     record value is an error: use a record slot and drop the variant;
//   - in sections 3 to 12 before it (early), the same key is a warning: prefer a slot;
//   - a key naming a job sent now, a live line or a business-added booking (booking:sentnow, booking:line,
//     booking:shop) is a warning in sections 3 to 12, unless the key is already an error: the record's rows can say it;
//   - in the zone, a branch that reads the money choice made before the money step (`when.before`) is a warning: read
//     what was taken (`rec`) instead, so a booking with several services lights the right branch (L1b).
//
// A key's record parts: a money choice (price:, before:, after:), the old credit switch (pf:credit), or a booking value
// of one of the record's groups (paidby, taken, reach, privacy, approval, and the record's own charge, contact, payer).
// Which group a value is in is the vendored overlay-core.js's table (GROUP_OF and the record's EVENT_GROUPS), never a
// copy. The lint reads a flow with its record, so the record's groups are booking groups, as overlay-core.js makes them
// while a record is loaded (eventTables): lib.js's fallback for an event value with no group does not arise.
import { loadPathScripts } from "../path/core";
import { isRecord, type LintContext, type LintHit, type LintRule } from "./runner";

/** The record's booking groups (lib.js REC_GROUPS, line 1744). */
const RECORD_GROUPS: readonly string[] = [
  "paidby",
  "taken",
  "reach",
  "privacy",
  "approval",
  "charge",
  "contact",
  "payer",
];

const MONEY_PART = /^(price|before|after):/;
const BOOKING_PART = /^booking:([a-z]+)$/;
const TIMING_PART = /^booking:(sentnow|line|shop)$/;

interface GroupTables {
  GROUP_OF: Record<string, string>;
  EVENT_GROUPS?: unknown;
}

let groups: ReadonlyMap<string, string> | null = null;

/**
 * The booking group of a value, the record's own groups included: overlay-core.js GROUP_OF, and EVENT_GROUPS (charge,
 * contact, payer), which GROUP_OF holds only while a record is loaded. Read once: neither table depends on a flow.
 */
function groupOf(value: string): string | undefined {
  if (groups === null) {
    const core = loadPathScripts().core as unknown as GroupTables;
    if (!isRecord(core.EVENT_GROUPS))
      throw new Error("overlay-core.js does not export EVENT_GROUPS (the record's booking groups)");
    const made = new Map<string, string>();
    for (const [group, entry] of Object.entries(core.EVENT_GROUPS)) {
      const values = isRecord(entry) && Array.isArray(entry.values) ? (entry.values as unknown[]) : [];
      for (const pair of values)
        if (Array.isArray(pair) && typeof pair[0] === "string") made.set(pair[0], group);
    }
    for (const [name, group] of Object.entries(core.GROUP_OF)) made.set(name, group);
    groups = made;
  }
  return groups.get(value);
}

function parts(key: string): string[] {
  return key.split("+").map((part) => part.trim());
}

/** The parts of a vary key that name the record: `price:visit+booking:callsonly` gives both (lib.js recordKeyParts). */
export function recordKeyParts(key: string): string[] {
  return parts(key).filter((part) => {
    if (MONEY_PART.test(part) || part === "pf:credit") return true;
    const value = BOOKING_PART.exec(part)?.[1];
    if (value === undefined) return false;
    const group = groupOf(value);
    return group !== undefined && RECORD_GROUPS.includes(group);
  });
}

/** The parts of a vary key that name a job sent now, a live line or a business-added booking (lib.js timingKeyParts). */
export function timingKeyParts(key: string): string[] {
  return parts(key).filter((part) => TIMING_PART.test(part));
}

/** L1: a variant that says the record's words. */
export const l1: LintRule = {
  id: "L1",
  name: "record variant",
  source: "lib.js lintSteps lines 1914-1922, recordKeyParts lines 1743-1757",
  run(ctx: LintContext): LintHit[] {
    const hits: LintHit[] = [];
    for (const step of ctx.pageOrder) {
      const place = ctx.place(step);
      const keys = isRecord(step.vary) ? Object.keys(step.vary) : [];
      for (const key of keys) {
        const record = recordKeyParts(key);
        const at = { rule: "L1", step: step.id, field: `vary '${key}'`, text: key };
        const error = record.length > 0 && place.zone;
        if (error)
          hits.push({
            ...at,
            level: "error",
            fix: `the record carries these words (${record.join(", ")}): use a record slot ({{pay.took}}, {{pay.late}}, {{reach.way}} ...) and drop the variant`,
          });
        else if (record.length > 0 && place.early)
          hits.push({
            ...at,
            level: "warning",
            fix: `prefer a slot: the record gives these words (${record.join(", ")})`,
          });
        const timing = timingKeyParts(key);
        if (timing.length > 0 && place.section >= 3 && place.section <= 12 && !error)
          hits.push({
            ...at,
            level: "warning",
            fix: `prefer a slot: ${timing.join(", ")} words can come from the record's rows`,
          });
      }
      if (!place.zone) continue;
      for (const branch of step.branches ?? []) {
        // (a gate's `before` is a list of money choices: the loaders refuse anything else)
        const before = isRecord(branch.when) ? branch.when.before : undefined;
        if (!Array.isArray(before)) continue;
        hits.push({
          rule: "L1",
          level: "warning",
          step: step.id,
          field: `branch '${branch.label}' when`,
          text: `before: ${(before as unknown[]).join(", ")}`,
          fix: "use rec: (what was taken: paid, card, nothing ...), so mixes light right",
        });
      }
    }
    return hits;
  },
};

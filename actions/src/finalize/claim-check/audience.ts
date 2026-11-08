// Who may see a field (limit 7, the claim check: arch 06 line 311; arch 01 line 91: "Audience | Per field: who may see
// it in a message, only on the secure page, or never"; RULES 4.5). Two frozen contracts give audiences, and the claim
// check reads both:
//   - the table lists of K-04 v1 and the domain parts give each column's audience (02-contracts section 2 item 3;
//     contracts/db-schema/tables.meta.schema.json $defs/audience): one or more readers, "secure-page-only" or "never";
//   - K-03 v1 gives each slot's audience (contracts/message-plan/fixtures/slots.json; $defs/audienceKind): the readers
//     the master sends it to, or securePageOnly or never, each alone (K-03 `slot.audience`: "That a slot is
//     securePageOnly or never alone is a code check (C-091)").
// Taken together the narrowest wins, and an audience that cannot be read is never shown (fail closed).

import type { Role } from "../../domain/identity-access";

/** Who reads a message (K-03 v1 `readerRole`; the readers of tables.meta `audience`). */
export type Reader = "customer" | "staff" | "owner";

export const READERS: readonly Reader[] = ["customer", "staff", "owner"];

/** Who may see a field, in the table lists' form: readers in a message, the secure page only, or never. */
export type FieldAudience = readonly Reader[] | "secure-page-only" | "never";

function isReader(value: unknown): value is Reader {
  return value === "customer" || value === "staff" || value === "owner";
}

/** One or more readers, each once; null for anything else. */
function readerList(raw: unknown): readonly Reader[] | null {
  if (!Array.isArray(raw)) return null;
  const items: readonly unknown[] = raw;
  if (items.length === 0 || !items.every(isReader)) return null;
  return new Set(items).size === items.length ? items : null;
}

/** A column's audience as a table list writes it (tables.meta $defs/audience), or null when it is not one. */
export function tableAudience(raw: unknown): FieldAudience | null {
  if (raw === "secure-page-only" || raw === "never") return raw;
  return readerList(raw);
}

/**
 * A slot's audience as K-03 v1 writes it (slots.json `audience`, audienceKind items), or null when it is not one: a
 * list that mixes securePageOnly or never with anything else is not read (K-03: "securePageOnly or never alone").
 */
export function slotAudience(raw: unknown): FieldAudience | null {
  if (!Array.isArray(raw)) return null;
  const items: readonly unknown[] = raw;
  if (items.length === 1 && items[0] === "securePageOnly") return "secure-page-only";
  if (items.length === 1 && items[0] === "never") return "never";
  return readerList(items);
}

/** What every audience covering one slot allows together: the narrowest of them. */
export type Reach =
  /** An audience could not be read: the slot is never shown (fail closed). */
  | { readonly kind: "unknown" }
  | { readonly kind: "never" }
  /** The readers every list names; securePageOnly when one of the audiences keeps the field on the secure page. */
  | { readonly kind: "readers"; readonly readers: ReadonlySet<Reader>; readonly securePageOnly: boolean };

/** The narrowest of a slot's audiences: unknown over never, never over the rest; the readers every list names. */
export function narrowest(audiences: readonly (FieldAudience | null)[]): Reach {
  if (audiences.length === 0 || audiences.includes(null)) return { kind: "unknown" };
  if (audiences.includes("never")) return { kind: "never" };
  let readers = new Set<Reader>(READERS);
  let securePageOnly = false;
  for (const audience of audiences) {
    if (audience === null || audience === "never") continue;
    if (audience === "secure-page-only") {
      securePageOnly = true;
      continue;
    }
    readers = new Set(audience.filter((reader) => readers.has(reader)));
  }
  return { kind: "readers", readers, securePageOnly };
}

/** Each K-04 v1 role and the reader it reads as (typed by Role, so a role K-04 adds must be given one). */
const READER_OF: Readonly<Record<Role, Reader | null>> = {
  owner: "owner",
  admin: "owner",
  staff: "staff",
  own_business: null,
  customer: "customer",
};

/**
 * The reader a recipient's live role at this business reads as (identity and access, T-308: `rolesOf`, K-04 v1
 * person_roles), or null for a role no message is written for:
 *   - owner and admin read as the owner: K-03 v1 `readerRole` "owner (the owner or office manager)"; S13-31 lets an
 *     admin decide with the owner;
 *   - staff and customer read as themselves;
 *   - own_business reads as no one (default): a person who runs their own business beside this one shares nothing with
 *     it (FS line 743; QUESTIONS.md M4.8: "nothing is shared"), so no field of this business passes for them;
 *   - a role K-04 does not name reads as no one (fail closed).
 * The role is the one the message is for, taken for one person (S13-31: "The role comes from what the message is about,
 * never the phone alone"), never a shared handle's merged roles (T-308's security note b).
 */
export function readerOf(role: Role): Reader | null {
  const byRole: Readonly<Partial<Record<string, Reader | null>>> = READER_OF;
  return byRole[role] ?? null;
}

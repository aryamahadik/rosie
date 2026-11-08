// The demo shops of fixture set v1 and the K-04 core rows the core seed makes for each (C-155; T-200). Pure: no file
// or database access; the bytes come from fixture-set.ts, already checked against the manifest.
//
// A demo shop is one file of test-kit/shops/: the 243 demo shops (one per profession, each with its owner form in
// forms/) plus test-mixed-A and test-mixed-B. For each, the core rows (K-04 v1: seed-business-head.json and
// seed-person-roles.json show their shape):
//   businesses      biz-demo-<shop>           name and display name: the shop's own `name` (forms B02 "starts as B01");
//                                             time zone America/New_York (Q-54); status and text hours: the defaults
//   persons         person-demo-<shop>-owner  name and language left null: the shop files name no owner (Sam in their
//                                             stories is the master's sample owner, an illustration: MC C6)
//   person_roles    role-demo-<shop>-owner    the owner role at that business
//   handles         handle-demo-<shop>-owner  kind phone, the owner's fictional mobile
//   person_handles  the owner writes from that handle
//   phones          the mobile's one row: chat closed, not stopped (the defaults)
// Ids come from the shop's id, which is its file name, so a row's id names its fixture file and a second run makes the
// same ids. The mobile numbers are fictional: NANP keeps 555-0100 to 555-0199 for fiction in every area code, so the
// shops, in code-point order of id, take +1 212 555-0100 to 0199, then +1 312 555-01xx, then +1 415 555-01xx. No phone
// number or address is ever taken from a fixture (rule 9).
import type { VerifiedFile } from "./fixture-set";

/** The demo shops' folder inside the fixture set. */
export const SHOPS_DIR = "test-kit/shops/";
/** The two shops that cover the money combos no profession uses (fixture set v1 README). */
export const TEST_MIXED_SHOPS = ["test-mixed-A", "test-mixed-B"] as const;
/** QUESTIONS.md Q-54's default: seeded test shops are in America/New_York. */
export const DEMO_TIME_ZONE = "America/New_York";
/** Area codes for the fictional mobiles, 100 numbers each (555-0100 to 555-0199). */
export const FICTIONAL_AREA_CODES = ["212", "312", "415"] as const;
/** A number in the fiction range 555-0100 to 555-0199, in E.164. */
export const FICTIONAL_MOBILE = /^\+1[2-9][0-9]{2}55501[0-9]{2}$/;

// A shop id becomes part of every row id: letters, digits and dashes only.
const SHOP_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/;
// An email address, or seven or more digits (a phone number), in a value the seed would load.
const LOOKS_LIKE_CONTACT = /@|[0-9](?:[\s().-]*[0-9]){6}/;

/** One demo shop: what the seed loads from its file, and where it came from. */
export interface DemoShop {
  /** The shop's id, which is also its file's name. */
  readonly id: string;
  readonly name: string;
  /** Its file, relative to the fixture set. */
  readonly source: string;
  /** The file's sha256, as checked against the manifest. */
  readonly sha256: string;
}

export interface BusinessSeedRow {
  readonly id: string;
  readonly name: string;
  readonly display_name: string;
  readonly time_zone: string;
}

export interface PersonSeedRow {
  readonly id: string;
}

export interface PersonRoleSeedRow {
  readonly id: string;
  readonly person_id: string;
  readonly business_id: string;
  readonly role: "owner";
}

export interface HandleSeedRow {
  readonly id: string;
  readonly kind: "phone";
  readonly address: string;
}

export interface PersonHandleSeedRow {
  readonly person_id: string;
  readonly handle_id: string;
}

export interface PhoneSeedRow {
  readonly number: string;
  readonly handle_id: string;
}

/** The rows of every shop, table by table, in shop order. */
export interface CoreSeedRows {
  readonly businesses: readonly BusinessSeedRow[];
  readonly persons: readonly PersonSeedRow[];
  readonly person_roles: readonly PersonRoleSeedRow[];
  readonly handles: readonly HandleSeedRow[];
  readonly person_handles: readonly PersonHandleSeedRow[];
  readonly phones: readonly PhoneSeedRow[];
}

/** Where each shop's rows came from: one entry per shop, naming its fixture file and every key the seed wrote. */
export interface SeededShop {
  readonly shopId: string;
  readonly source: string;
  readonly sha256: string;
  readonly businessId: string;
  readonly personId: string;
  readonly roleId: string;
  readonly handleId: string;
  readonly phoneNumber: string;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Reads the demo shops from their verified files (each `test-kit/shops/<id>.json`), in code-point order of id. A file
 * whose `id` is not its file name, an id that is not letters, digits and dashes, a missing name, or a name that looks
 * like a phone number or an email address is refused, naming the file: nothing is loaded from it.
 */
export function readDemoShops(files: readonly VerifiedFile[]): DemoShop[] {
  const shops = files.map((file): DemoShop => {
    const fileName = file.path.startsWith(SHOPS_DIR) ? file.path.slice(SHOPS_DIR.length) : "";
    if (!fileName.endsWith(".json") || fileName.includes("/")) {
      throw new Error(`${file.path}: not a demo shop file (${SHOPS_DIR}<id>.json)`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(file.bytes));
    } catch (error) {
      throw new Error(`${file.path}: not JSON in UTF-8`, { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file.path}: not a JSON object`);
    }
    const { id, name } = parsed as { id?: unknown; name?: unknown };
    if (typeof id !== "string" || id !== fileName.slice(0, -".json".length)) {
      throw new Error(`${file.path}: its id ${JSON.stringify(id)} is not its file name`);
    }
    if (!SHOP_ID.test(id)) {
      throw new Error(`${file.path}: its id is not letters, digits and dashes`);
    }
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`${file.path}: it has no name`);
    }
    if (LOOKS_LIKE_CONTACT.test(name)) {
      throw new Error(
        `${file.path}: its name looks like a phone number or an email address; stopping (rule 9)`,
      );
    }
    return { id, name, source: file.path, sha256: file.sha256 };
  });
  return shops.sort((a, b) => byCodePoint(a.id, b.id));
}

/** The fictional mobile of the shop at `index` (0-based, in code-point order of id). 300 numbers in all. */
export function fictionalMobile(index: number): string {
  const areaCode =
    Number.isSafeInteger(index) && index >= 0 ? FICTIONAL_AREA_CODES[Math.floor(index / 100)] : undefined;
  if (areaCode === undefined) {
    throw new RangeError(
      `no fictional mobile for shop ${String(index)}: ${String(FICTIONAL_AREA_CODES.length * 100)} numbers in all`,
    );
  }
  return `+1${areaCode}55501${String(index % 100).padStart(2, "0")}`;
}

/** The core rows of each shop, and where each came from. Shops are taken in code-point order of id; ids must differ. */
export function coreRowsOf(shops: readonly DemoShop[]): { rows: CoreSeedRows; seeded: SeededShop[] } {
  const ordered = [...shops].sort((a, b) => byCodePoint(a.id, b.id));
  const pairs = ordered.map((shop, index) => {
    if (index > 0 && ordered[index - 1]?.id === shop.id) {
      throw new Error(`two demo shops have the id ${shop.id} (${shop.source})`);
    }
    const seeded: SeededShop = {
      shopId: shop.id,
      source: shop.source,
      sha256: shop.sha256,
      businessId: `biz-demo-${shop.id}`,
      personId: `person-demo-${shop.id}-owner`,
      roleId: `role-demo-${shop.id}-owner`,
      handleId: `handle-demo-${shop.id}-owner`,
      phoneNumber: fictionalMobile(index),
    };
    return { shop, seeded };
  });
  return {
    rows: {
      businesses: pairs.map(({ shop, seeded }) => ({
        id: seeded.businessId,
        name: shop.name,
        display_name: shop.name,
        time_zone: DEMO_TIME_ZONE,
      })),
      persons: pairs.map(({ seeded }) => ({ id: seeded.personId })),
      person_roles: pairs.map(({ seeded }) => ({
        id: seeded.roleId,
        person_id: seeded.personId,
        business_id: seeded.businessId,
        role: "owner" as const,
      })),
      handles: pairs.map(({ seeded }) => ({
        id: seeded.handleId,
        kind: "phone" as const,
        address: seeded.phoneNumber,
      })),
      person_handles: pairs.map(({ seeded }) => ({ person_id: seeded.personId, handle_id: seeded.handleId })),
      phones: pairs.map(({ seeded }) => ({ number: seeded.phoneNumber, handle_id: seeded.handleId })),
    },
    seeded: pairs.map(({ seeded }) => seeded),
  };
}

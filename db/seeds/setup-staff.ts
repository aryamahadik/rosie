// T-727: the staff seed (C-155; K-22 v1 people and access, frozen: contracts/db-schema/people-access, its table list,
// README and seed fixtures seed-staff-joined.json and seed-on-call.json, built by migration 0020; build prompt 3.5's
// table: journey 6's flow B also needs journey 2's team (B6-16); QUESTIONS.md NQ-M5-4: the M5 lane seeds the demo
// shops' staff and on-call rows from fixture set v1, and M4 seeds none; Master Corrections R3 and C6; build prompt
// rule 9). From fixture set v1's 245 demo shops, each shop's team beside the owner the setup seed made, joined and
// bookable, with the work each person takes, and who takes jobs sent now, so named-person times, the times card and
// B6-16's on-call pro run on seeded rows. It runs after the core seed (core.ts, T-200), the setup seed
// (setup-business.ts, T-213) and the kinds seed (kinds.ts, T-212), and takes its shops, owners and dates from the setup
// seed's plan (setupPlanOf). Per shop, with ids made from the shop's id (its file's name), the flow and the place in the
// team, as K-22's seed-staff-joined.json makes Jordan and Casey:
//   persons, handles,         person-demo-<shop>-<flow>-<n>, handle-demo-<shop>-<flow>-<n> and the mobile's phone row:
//   person_handles, phones    DEMO_TEAM_PER_FLOW people for each flow whose shop file names staff
//                             (flows.<A|B>.staff), each writing from a fictional mobile of their own
//   person_roles              role-demo-<shop>-<flow>-<n>: the staff role at the shop's business (K-04; FS row T01)
//   staff                     staff-demo-<shop>-<flow>-<n>: added on the owner's tick that they agreed to a text
//                             (Q-08), joined from their own mobile, and bookable on the owner's yes (S2-22), all dated
//                             when fixture set v1 was made, as the setup seed dates the owner's row
//   staff_skills              skill-demo-<shop>-<flow>-<n>-<kind> and skill-demo-<shop>-owner-<kind>: each team member
//                             and the owner take the shop's kind of work as a whole (skill null: every service of it)
//   on_call                   oncall-demo-<shop>-open-hours: in a flow B shop whose kind takes jobs sent now, the one
//                             person who takes them (B6-16), in open hours on every day
//
//   const result = await seedSetupStaff(sql);   // result.tables.staff: { rows: n, inserted: n, kept: 0 }
//
// What is read, and from where (rule 9; MC R3: code reads a trade's pf.facts, pf.switches and pf.settings by name, and
// every other pf.* value is free text for the AI, never parsed):
//   - from each test-kit/shops/<id>.json, through lib/fixture-set.ts and the setup seed's plan: whether each of its
//     flows names staff (flows.<flow>.staff: text names a team; null, or no such field, names none). The text itself is
//     the trade file's sample cast (test-kit.js line 75: cast.staff), such as "Marcus and Dre (plumbers)", which MC C6
//     makes an illustration, never a live value, and whose wording differs from file to file: no name, role or head
//     count is read out of it, and none of it is stored.
//   - the shop's facts, as the setup seed reads them by name: the fact sentnow, the plug-in's word that the work takes
//     jobs sent now (S2-30: "The plug-in says which services. Work that's never sent now sets nobody on call").
//   - the shop's kind of work: its id for the 243 professions (the setup seed's company kind, the kinds seed's pick),
//     and the services seed's TEST_MIXED_KINDS for test-mixed-A and -B, which have no profession (T-214 default 8).
//   - when fixture set v1 was made (test-kit/COVERAGE.md line 3, Eastern time), which dates every staff row, as the
//     setup seed dates the owner's, so a second run writes the same times.
//   No phone number, email address or name is taken from a fixture: each person's name and language stay null ("null
//   until known", K-04 persons), as the core seed leaves the owners', and each mobile is fictional (default 2). pf.staff
//   (the shop file's staff_skills) is free text, so no named skill is read out of it (default 3).
//
// Defaults where the files give nothing (each named in the constants below and in the card's report):
//   1. A team of DEMO_TEAM_PER_FLOW for each flow that names staff: the size of the test kit's usual cast, two people
//      ("Kenny and Ray (plumbers at the counter)" and "Marcus and Dre (plumbers)" in plumber.json), and of the master's
//      own team per business (S2-02: Jordan and Casey at Lee Home Services; Riley and Avery at Lee's Barbershop). The
//      flow A team works at the business and the flow B team at the customer's place (the services seed's
//      PLACE_OF_FLOW); flow A's and flow B's people differ, as the casts do. A flow that names none, and test-mixed-A
//      and -B, which have no cast, keep the owner working alone ("just me", FS row T01).
//   2. Mobiles in the fiction range 555-0100 to 555-0199 (NANP keeps it for fiction in every area code) in
//      STAFF_AREA_CODES, which the owners' mobiles do not use (lib/demo-shops.ts), taken in order: shops in code-point
//      order of id, flow A before B, then place in the team. Each phone row keeps K-04's defaults (chat not open, not
//      stopped), as the owners' do.
//   3. Skills: each team member, and the owner, takes the shop's kind of work as a whole (skill null), so the times card
//      can offer them for every service of it (FS row T04: only people with the skill are offered); the owner takes
//      bookings at their own business too (S2-21's table: "Sam Lee ... Takes bookings: Yes").
//   4. Prices: none by person. FS row T06's default is "the same price whoever goes" (S2-15's safe default: "one price
//      for everyone"), so the services seed's price rules (K-25) hold for each person.
//   5. Places: K-22 v1 holds no place per person (S2-21's "Where" is the business's flows and locations, K-23 and
//      K-25; a worker's own place and hours are K-27's, on a K-04 worker resource): each person works at their shop's
//      business, and the result records which flow's team each one is in.
//   6. On call: only a shop with flow B whose facts list sentnow (S2-30; B4-91 and B6-16 run "when booking sentnow")
//      has one, and it has exactly one person on call: the first of its flow B team, or the owner where its flow B
//      names no staff (S1-21's tap list: "Jobs sent now: who takes them (a solo owner: Sam, in open hours)"). One row,
//      for open hours (S2-27: "In open hours, it goes to whoever Sam names") on every day (ON_CALL_DAYS), with no times
//      (all of those hours) and no holidays. No file names anyone on call while the business is closed, so nobody is
//      (S2-27: "Hours with nobody on call: jobs sent now aren't offered then"; B4-91: "Nobody on call right now: the
//      soonest times show first").
//   7. Each staff row's other fields keep K-22's defaults: no languages, the default day-list time (null), no video
//      link, the pro does not call the customer's mobile, no supervisor; no team power, emergency contact, account or
//      ID upload is made, so no field K-22 rule 6 seals is written.
//
// Checked before anything is written: every flow's staff field is text or null; every mobile is in the fiction range
// and in none of the owners' area codes; every id is made once. Inside the transaction: each shop's business and owner
// (core), the owner's staff row at the business, joined and bookable (setup), and every kind of work written, in
// K-24's catalog (kinds).
//
// In order, stopping at the first failure: opens and checks fixture set v1 against its manifest as the core seed does
// (lib/fixture-set.ts), so only bytes that were hashed are parsed; reads every shop and refuses, naming the file, any
// value it does not know how to read rather than guess; then, in one transaction as the job role rosie_job with no
// business scope (T-191), checks that the core, setup and kinds seeds' rows are there, and writes the rows through
// K-22's tables and the core people rows its staff rows need. Idempotent, as the other seeds: a row is inserted only
// when its primary key is free (ON CONFLICT DO NOTHING), nothing is updated or deleted, so a second run writes nothing
// and leaves every row as it was, version included; a row that went missing is written again as the first run wrote
// it. A clash on any other key (a mobile another handle holds, a second skill row for the same kind) is an error, and
// the transaction rolls back. Nothing is printed, and no error names a value of a row.
import { SCOPE_SETTING, type Sql, type Tx } from "../repo/scope";
import { type CoreSeedTableCount, SEED_ROLE } from "./core";
import { FICTIONAL_AREA_CODES, FICTIONAL_MOBILE, SHOPS_DIR } from "./lib/demo-shops";
import {
  filesUnder,
  type FixtureSet,
  openFixtureSet,
  type VerifiedFile,
  type VerifiedFixtureSet,
  verifyFixtureSet,
} from "./lib/fixture-set";
import { type Flow, setupPlanOf, type StaffSeedRow } from "./setup-business";
import { PLACE_OF_FLOW, TEST_MIXED_KINDS } from "./setup-services-rules";

/** Default 1: the team each flow gets whose shop file names staff (the test kit's usual cast, two people). */
export const DEMO_TEAM_PER_FLOW = 2;
/**
 * Default 2: the area codes of the team's fictional mobiles, 100 numbers each (555-0100 to 555-0199), none of them the
 * owners' (lib/demo-shops.ts FICTIONAL_AREA_CODES). 1,000 numbers in all.
 */
export const STAFF_AREA_CODES = [
  "202",
  "305",
  "404",
  "503",
  "602",
  "617",
  "646",
  "713",
  "718",
  "720",
] as const;
/** The role each team member holds at the business (K-04 person_roles; FS row T01). */
export const STAFF_ROLE = "staff";
/** The fact that says a kind's work takes jobs sent now (S2-30; B4-91 and B6-16 run when the booking is sentnow). */
export const SENT_NOW_FACT = "sentnow";
/** Default 6: who takes jobs sent now is set for the business's open hours (S2-27; S1-21). */
export const ON_CALL_HOURS = "open";
/** Default 6: the days the on-call row covers, ISO 1 (Monday) to 7 (Sunday): every day the business is open. */
export const ON_CALL_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

export interface StaffPersonSeedRow {
  readonly id: string;
}

export interface StaffRoleSeedRow {
  readonly id: string;
  readonly person_id: string;
  readonly business_id: string;
  readonly role: typeof STAFF_ROLE;
}

export interface StaffHandleSeedRow {
  readonly id: string;
  readonly kind: "phone";
  readonly address: string;
}

export interface StaffPersonHandleSeedRow {
  readonly person_id: string;
  readonly handle_id: string;
}

export interface StaffPhoneSeedRow {
  readonly number: string;
  readonly handle_id: string;
}

export interface StaffSkillSeedRow {
  readonly id: string;
  readonly staff_id: string;
  readonly business_id: string;
  readonly kind_id: string;
  readonly skill: null;
}

export interface OnCallSeedRow {
  readonly id: string;
  readonly business_id: string;
  readonly kind_id: string;
  readonly staff_id: string;
  readonly hours: typeof ON_CALL_HOURS;
  readonly days: readonly number[];
  readonly holidays: false;
  readonly from_time: null;
  readonly until_time: null;
}

/** The rows of every shop, table by table, in the order they are written. */
export interface StaffSeedRows {
  readonly persons: readonly StaffPersonSeedRow[];
  readonly handles: readonly StaffHandleSeedRow[];
  readonly person_handles: readonly StaffPersonHandleSeedRow[];
  readonly phones: readonly StaffPhoneSeedRow[];
  readonly person_roles: readonly StaffRoleSeedRow[];
  readonly staff: readonly StaffSeedRow[];
  readonly staff_skills: readonly StaffSkillSeedRow[];
  readonly on_call: readonly OnCallSeedRow[];
}

export type StaffSeedTable = keyof StaffSeedRows;

/** One team member, as seeded: every key written for them. */
export interface SeededTeamMember {
  /** Their place in the team, from 1. */
  readonly position: number;
  readonly personId: string;
  readonly roleId: string;
  readonly handleId: string;
  readonly phoneNumber: string;
  readonly staffId: string;
  readonly skillId: string;
}

/** The team made for one flow whose shop file names staff. */
export interface SeededTeam {
  readonly flow: Flow;
  /** Where the shop file names the flow's staff: flows.<flow>.staff (its words are not read, MC C6). */
  readonly at: string;
  /** Where this team's work happens (default 1): flow A at the business, flow B at the customer's place. */
  readonly place: "business" | "customer";
  readonly members: readonly SeededTeamMember[];
}

/** A shop's one person on call for jobs sent now (default 6). */
export interface SeededOnCall {
  readonly id: string;
  readonly kindId: string;
  readonly staffId: string;
  readonly personId: string;
  /** "team": the first of the flow B team; "owner": the owner, where the shop's flow B names no staff. */
  readonly who: "team" | "owner";
  /** The fact of the shop's file that puts someone on call. */
  readonly fact: typeof SENT_NOW_FACT;
}

/** One entry per shop: its fixture file, its owner and kind, and every key the seed wrote. */
export interface SeededStaffShop {
  readonly shopId: string;
  readonly source: string;
  readonly sha256: string;
  readonly businessId: string;
  readonly ownerPersonId: string;
  /** The owner's staff row, which the setup seed wrote (staff-demo-<shop>-owner). */
  readonly ownerStaffId: string;
  /** The kind of work every skill row of the shop names. */
  readonly kindId: string;
  /** "pick": the shop's own profession (its id); "default": TEST_MIXED_KINDS (no profession). */
  readonly kindFrom: "pick" | "default";
  /** The owner's skill row. */
  readonly ownerSkillId: string;
  /** The flows the shop file has. */
  readonly flows: readonly Flow[];
  /** One entry per flow whose shop file names staff, in flow order. */
  readonly teams: readonly SeededTeam[];
  /** Null unless the shop has flow B and its facts list sentnow. */
  readonly onCall: SeededOnCall | null;
}

export interface StaffSeedPlan {
  readonly rows: StaffSeedRows;
  /** One entry per shop, in code-point order of id. */
  readonly shops: readonly SeededStaffShop[];
  /** When the staff rows are dated (when fixture set v1 was made), and the file that says so. */
  readonly seededAt: { readonly at: Date; readonly source: string };
}

export interface StaffSeedResult {
  /** The database role that wrote the rows (current_user inside the seed's transaction). */
  readonly ranAs: string;
  /** The fixture set that was checked: its folder, its manifest's sha256 and how many files the manifest lists. */
  readonly fixtureSet: {
    readonly dir: string;
    readonly manifestSha256: string;
    readonly filesChecked: number;
  };
  readonly seededAt: { readonly at: Date; readonly source: string };
  readonly tables: Readonly<Record<StaffSeedTable, CoreSeedTableCount>>;
  readonly shops: readonly SeededStaffShop[];
}

export interface StaffSeedOptions {
  /** Fixture set v1's folder. Default fixtures/v1. Anything outside the repository's fixtures/ folder is refused. */
  fixturesDir?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseShopFile(file: VerifiedFile): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(file.bytes));
  } catch (error) {
    throw new Error(`${file.path}: not JSON in UTF-8`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${file.path}: not a JSON object`);
  }
  return parsed;
}

/**
 * Whether one flow of a shop file names staff: its staff field is text (a team), or null or missing (none). Anything
 * else is refused, naming the file. The words themselves are the sample cast (MC C6) and are not read.
 */
export function namesStaff(source: string, flow: Flow, block: unknown): boolean {
  if (!isRecord(block)) {
    throw new Error(`${source}: flows.${flow} is not an object`);
  }
  const staff = block.staff;
  if (staff === undefined || staff === null) {
    return false;
  }
  if (typeof staff === "string" && staff.trim() !== "") {
    return true;
  }
  throw new Error(`${source}: flows.${flow}.staff is neither text nor null`);
}

/** The fictional mobile of the team member at `index` (0-based, in the seed's order). 1,000 numbers in all. */
export function staffMobile(index: number): string {
  const areaCode =
    Number.isSafeInteger(index) && index >= 0 ? STAFF_AREA_CODES[Math.floor(index / 100)] : undefined;
  if (areaCode === undefined) {
    throw new RangeError(
      `no fictional mobile for team member ${String(index)}: ${String(STAFF_AREA_CODES.length * 100)} numbers in all`,
    );
  }
  return `+1${areaCode}55501${String(index % 100).padStart(2, "0")}`;
}

/** Refuses a plan that would write one id twice in a table, which ON CONFLICT DO NOTHING would otherwise drop. */
function requireUnique(table: string, keys: readonly string[]): void {
  if (new Set(keys).size !== keys.length) {
    throw new Error(`the staff seed would write two ${table} rows with one key; stopping`);
  }
}

/**
 * Plans every row of the staff seed from a verified fixture set (pure: no database). Shops are taken in the setup
 * seed's order (code-point order of id), with the keys its plan makes, so each row names the business, owner and owner's
 * staff row the core and setup seeds wrote.
 */
export function staffPlanOf(verified: VerifiedFixtureSet): StaffSeedPlan {
  const ownerCodes: readonly string[] = FICTIONAL_AREA_CODES;
  if (STAFF_AREA_CODES.some((code) => ownerCodes.includes(code))) {
    throw new Error("the team's area codes must differ from the owners' (lib/demo-shops.ts)");
  }
  const setup = setupPlanOf(verified);
  const fileOf = new Map(filesUnder(verified, SHOPS_DIR).map((file) => [file.path, file]));
  const factsOf = new Map(setup.rows.company_kinds.map((row) => [row.business_id, row.pf_facts]));
  const at = setup.seededAt.at;

  const rows = {
    persons: [] as StaffPersonSeedRow[],
    handles: [] as StaffHandleSeedRow[],
    person_handles: [] as StaffPersonHandleSeedRow[],
    phones: [] as StaffPhoneSeedRow[],
    person_roles: [] as StaffRoleSeedRow[],
    staff: [] as StaffSeedRow[],
    staff_skills: [] as StaffSkillSeedRow[],
    on_call: [] as OnCallSeedRow[],
  };
  const shops: SeededStaffShop[] = [];
  let mobiles = 0;

  for (const shop of setup.seeded) {
    const file = fileOf.get(shop.source);
    if (file === undefined) {
      throw new Error(`${shop.source}: not among the verified files`);
    }
    const kindId = shop.kindId ?? TEST_MIXED_KINDS[shop.shopId];
    if (kindId === undefined) {
      throw new Error(`${shop.source}: it has no kind of work, and no default names one`);
    }
    const flowBlocks = parseShopFile(file).flows;
    if (!isRecord(flowBlocks)) {
      throw new Error(`${shop.source}: its flows are not an object`);
    }
    const owner = shop.ownerPersonId;
    const business = shop.businessId;

    const ownerSkillId = `skill-demo-${shop.shopId}-owner-${kindId}`;
    rows.staff_skills.push({
      id: ownerSkillId,
      staff_id: shop.staffId,
      business_id: business,
      kind_id: kindId,
      skill: null,
    });

    const teams: SeededTeam[] = [];
    for (const flow of shop.flows) {
      if (!namesStaff(shop.source, flow, flowBlocks[flow])) {
        continue;
      }
      const members: SeededTeamMember[] = [];
      for (let position = 1; position <= DEMO_TEAM_PER_FLOW; position += 1) {
        const key = `${shop.shopId}-${flow.toLowerCase()}-${String(position)}`;
        const member: SeededTeamMember = {
          position,
          personId: `person-demo-${key}`,
          roleId: `role-demo-${key}`,
          handleId: `handle-demo-${key}`,
          phoneNumber: staffMobile(mobiles),
          staffId: `staff-demo-${key}`,
          skillId: `skill-demo-${key}-${kindId}`,
        };
        mobiles += 1;
        rows.persons.push({ id: member.personId });
        rows.handles.push({ id: member.handleId, kind: "phone", address: member.phoneNumber });
        rows.person_handles.push({ person_id: member.personId, handle_id: member.handleId });
        rows.phones.push({ number: member.phoneNumber, handle_id: member.handleId });
        rows.person_roles.push({
          id: member.roleId,
          person_id: member.personId,
          business_id: business,
          role: STAFF_ROLE,
        });
        rows.staff.push({
          id: member.staffId,
          business_id: business,
          person_id: member.personId,
          mobile: member.phoneNumber,
          agreed_to_text_ticked_at: at,
          agreed_ticked_by_person_id: owner,
          status: "joined",
          added_at: at,
          joined_at: at,
          joined_from_number: member.phoneNumber,
          bookable_at: at,
          bookable_by_person_id: owner,
        });
        rows.staff_skills.push({
          id: member.skillId,
          staff_id: member.staffId,
          business_id: business,
          kind_id: kindId,
          skill: null,
        });
        members.push(member);
      }
      teams.push({ flow, at: `flows.${flow}.staff`, place: PLACE_OF_FLOW[flow], members });
    }

    let onCall: SeededOnCall | null = null;
    if (shop.flows.includes("B") && (factsOf.get(business) ?? []).includes(SENT_NOW_FACT)) {
      const first = teams.find((team) => team.flow === "B")?.members[0];
      onCall = {
        id: `oncall-demo-${shop.shopId}-open-hours`,
        kindId,
        staffId: first?.staffId ?? shop.staffId,
        personId: first?.personId ?? owner,
        who: first === undefined ? "owner" : "team",
        fact: SENT_NOW_FACT,
      };
      rows.on_call.push({
        id: onCall.id,
        business_id: business,
        kind_id: kindId,
        staff_id: onCall.staffId,
        hours: ON_CALL_HOURS,
        days: ON_CALL_DAYS,
        holidays: false,
        from_time: null,
        until_time: null,
      });
    }

    shops.push({
      shopId: shop.shopId,
      source: shop.source,
      sha256: shop.sha256,
      businessId: business,
      ownerPersonId: owner,
      ownerStaffId: shop.staffId,
      kindId,
      kindFrom: shop.kindId === null ? "default" : "pick",
      ownerSkillId,
      flows: shop.flows,
      teams,
      onCall,
    });
  }

  const notFictional = rows.phones.filter((phone) => !FICTIONAL_MOBILE.test(phone.number));
  if (notFictional.length > 0) {
    throw new Error(
      `refusing to write ${String(notFictional.length)} mobile(s) outside the fiction range 555-0100 to 555-0199`,
    );
  }
  requireUnique(
    "persons",
    rows.persons.map((row) => row.id),
  );
  requireUnique(
    "handles",
    rows.handles.map((row) => row.id),
  );
  requireUnique(
    "phones",
    rows.phones.map((row) => row.number),
  );
  requireUnique(
    "person_roles",
    rows.person_roles.map((row) => row.id),
  );
  requireUnique(
    "staff",
    rows.staff.map((row) => row.id),
  );
  requireUnique(
    "staff_skills",
    rows.staff_skills.map((row) => row.id),
  );
  requireUnique(
    "on_call",
    rows.on_call.map((row) => row.id),
  );
  return { rows, shops, seededAt: setup.seededAt };
}

/** Seeds the demo shops' staff, skills and on-call rows from fixture set v1 (see the top of this file). */
export async function seedSetupStaff(sql: Sql, options: StaffSeedOptions = {}): Promise<StaffSeedResult> {
  return seedSetupStaffFrom(sql, openFixtureSet(options.fixturesDir));
}

/** The entry every seed set exports under one name, so a runner finds a set by its file name (T-201). */
export const seed = seedSetupStaff;

const missingMessage = (what: string, missing: number, of: number, unit: string, run: string): string =>
  `${what} are missing for ${String(missing)} of ${String(of)} ${unit}: run ${run} first (nothing was written)`;

/**
 * Refuses to write before the seeds this one builds on: each shop's business and owner (core), the owner's staff row at
 * that business, joined and bookable, which the owner's skill and a solo owner's on-call row name (setup), and every
 * kind of work the skill and on-call rows name, in K-24's catalog (kinds).
 */
async function requirePriorRows(tx: Tx, plan: StaffSeedPlan): Promise<void> {
  const { shops } = plan;
  const businesses = await tx<{ id: string }[]>`
    select id from businesses where id = any(${shops.map((shop) => shop.businessId)}::text[])
  `;
  const persons = await tx<{ id: string }[]>`
    select id from persons where id = any(${shops.map((shop) => shop.ownerPersonId)}::text[])
  `;
  const haveBusiness = new Set(businesses.map((row) => row.id));
  const havePerson = new Set(persons.map((row) => row.id));
  const noCore = shops.filter(
    (shop) => !haveBusiness.has(shop.businessId) || !havePerson.has(shop.ownerPersonId),
  );
  if (noCore.length > 0) {
    throw new Error(
      missingMessage("the core seed's rows", noCore.length, shops.length, "shops", "db/seeds/core.ts"),
    );
  }

  const owners = await tx<{ id: string; business_id: string; person_id: string; ready: boolean }[]>`
    select id, business_id, person_id, (status = 'joined' and bookable_at is not null) as ready
    from staff where id = any(${shops.map((shop) => shop.ownerStaffId)}::text[])
  `;
  const ownerOf = new Map(owners.map((row) => [row.id, row]));
  const noSetup = shops.filter((shop) => {
    const row = ownerOf.get(shop.ownerStaffId);
    return row?.business_id !== shop.businessId || row.person_id !== shop.ownerPersonId || !row.ready;
  });
  if (noSetup.length > 0) {
    throw new Error(
      missingMessage(
        "the setup seed's owner staff rows (joined and bookable)",
        noSetup.length,
        shops.length,
        "shops",
        "db/seeds/setup-business.ts",
      ),
    );
  }

  const kindIds = [...new Set(shops.map((shop) => shop.kindId))];
  const kinds = await tx<{ id: string }[]>`select id from kinds where id = any(${kindIds}::text[])`;
  const haveKind = new Set(kinds.map((row) => row.id));
  const noKind = kindIds.filter((kindId) => !haveKind.has(kindId));
  if (noKind.length > 0) {
    throw new Error(
      missingMessage(
        "the kinds seed's kinds",
        noKind.length,
        kindIds.length,
        "kinds of work",
        "db/seeds/kinds.ts",
      ),
    );
  }
}

/** seedSetupStaff, from a fixture set already opened (tests open a temporary copy of the set inside its own jail). */
export async function seedSetupStaffFrom(sql: Sql, set: FixtureSet): Promise<StaffSeedResult> {
  const verified = verifyFixtureSet(set);
  const plan = staffPlanOf(verified);
  const { rows } = plan;

  const written = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${SEED_ROLE}`);
    // The runtime side runs with no business scope (K-05 "Scope"); '' reads as none, as an unset scope does.
    await tx`select set_config(${SCOPE_SETTING}, '', true)`;
    const [who] = await tx<{ role: string }[]>`select current_user as role`;
    await requirePriorRows(tx, plan);

    const none = { count: 0 };
    const persons =
      rows.persons.length === 0
        ? none
        : await tx`insert into persons ${tx(rows.persons, "id")} on conflict (id) do nothing`;
    const handles =
      rows.handles.length === 0
        ? none
        : await tx`
            insert into handles ${tx(rows.handles, "id", "kind", "address")}
            on conflict (id) do nothing
          `;
    const personHandles =
      rows.person_handles.length === 0
        ? none
        : await tx`
            insert into person_handles ${tx(rows.person_handles, "person_id", "handle_id")}
            on conflict (person_id, handle_id) do nothing
          `;
    const phones =
      rows.phones.length === 0
        ? none
        : await tx`
            insert into phones ${tx(rows.phones, "number", "handle_id")}
            on conflict (number) do nothing
          `;
    const personRoles =
      rows.person_roles.length === 0
        ? none
        : await tx`
            insert into person_roles ${tx(rows.person_roles, "id", "person_id", "business_id", "role")}
            on conflict (id) do nothing
          `;
    const staff =
      rows.staff.length === 0
        ? none
        : await tx`
            insert into staff ${tx(
              rows.staff,
              "id",
              "business_id",
              "person_id",
              "mobile",
              "agreed_to_text_ticked_at",
              "agreed_ticked_by_person_id",
              "status",
              "added_at",
              "joined_at",
              "joined_from_number",
              "bookable_at",
              "bookable_by_person_id",
            )}
            on conflict (id) do nothing
          `;
    const staffSkills =
      rows.staff_skills.length === 0
        ? none
        : await tx`
            insert into staff_skills ${tx(rows.staff_skills, "id", "staff_id", "business_id", "kind_id", "skill")}
            on conflict (id) do nothing
          `;
    const onCall =
      rows.on_call.length === 0
        ? none
        : await tx`
            insert into on_call ${tx(
              rows.on_call,
              "id",
              "business_id",
              "kind_id",
              "staff_id",
              "hours",
              "days",
              "holidays",
              "from_time",
              "until_time",
            )}
            on conflict (id) do nothing
          `;
    return {
      ranAs: who?.role ?? "",
      inserted: {
        persons: persons.count,
        handles: handles.count,
        person_handles: personHandles.count,
        phones: phones.count,
        person_roles: personRoles.count,
        staff: staff.count,
        staff_skills: staffSkills.count,
        on_call: onCall.count,
      },
    };
  });

  const count = (table: StaffSeedTable): CoreSeedTableCount => {
    const total = rows[table].length;
    const inserted = written.inserted[table];
    return { rows: total, inserted, kept: total - inserted };
  };
  return {
    ranAs: written.ranAs,
    fixtureSet: {
      dir: verified.dir,
      manifestSha256: verified.manifestSha256,
      filesChecked: verified.filesChecked,
    },
    seededAt: plan.seededAt,
    tables: {
      persons: count("persons"),
      handles: count("handles"),
      person_handles: count("person_handles"),
      phones: count("phones"),
      person_roles: count("person_roles"),
      staff: count("staff"),
      staff_skills: count("staff_skills"),
      on_call: count("on_call"),
    },
    shops: plan.shops,
  };
}

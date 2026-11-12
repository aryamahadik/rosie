// T-1302: staging's test-phone roster, its one list (C-202 for C-205; K-05 v1.12 default 106 and item 54; the D-017 path
// audit's D3 and ruling R5: "the roster read from the same source the seed writes"). Which roster id (K-21 v1
// test-roster.json `testPhoneId`) is which K-04 handle, and the fiction-range number the seeds fall back to. Read by:
//   db/seeds/skeleton.ts       test owner 1's roster id, handle id and number (TEST_OWNER_1; T-1148)
//   db/seeds/staging-core.ts   every roster id, handle id and fake number, test owner 1's left out (TEST_PHONES; T-202)
//   the test-phone page        a roster id's handle id alone, which its binding (T-1305) hands K-05 v1.12's
//                              readRosterPhone (item 54): the number the page shows is read from the database the seeds
//                              wrote, whether staging-core took STAGING_TEST_PHONES or these fake numbers (NQ-DB-2)
// So the page's roster and the seeded rows cannot drift: both take their ids from here.
//
// Constants only, with no import and no file, network or environment access, so the Worker can import it as it is
// (default 106). It holds no real number and no email (rule 9): each number is +1 555 555 and the roster phone's last four
// digits, in the fiction range 555-0100 to 555-0199, the only numbers the Linq double signs as (T-565, T-1186).
//
// Where it meets K-21 v1's frozen test-roster.json it follows that file: the roster ids in its order, and each number
// from the phone's `last4` there (lib/roster.test.ts reads the file and checks both). The handle ids are the seeds' own,
// as default 106 names them, since K-21's file names none: tp-01 `handle-sam`, test owner 1's (K-04 seed-person-roles.json
// and T-1148's skeleton seed); tp-02 to tp-05 `handle-<roster id>`, as T-202's staging-core seed writes them. The
// businesses, roles and people K-21's file shows for tp-02 to tp-05 are not this list's (K-05 open gap 66; CQ-206).

/** One phone of staging's test-phone roster. */
export interface RosterPhone {
  /** Its roster id (K-21 v1 test-roster.json `testPhoneId`): what the test-phone page names, never a number. */
  readonly testPhoneId: string;
  /** The K-04 handle id the seeds write for it, which the page's binding asks K-05's readRosterPhone for. */
  readonly handleId: string;
  /** The number the seeds fall back to and the test-phone page sends as: +1 555 555 and its last four digits. */
  readonly fakeNumber: string;
}

/** Test owner 1, tp-01: the skeleton seed's phone (T-1148), which staging-core never seeds (DL-341). */
export const TEST_OWNER_1_PHONE = Object.freeze({
  testPhoneId: "tp-01",
  handleId: "handle-sam",
  fakeNumber: "+15555550100",
} as const);

/**
 * The roster, in K-21 v1 test-roster.json's order: tp-01 test owner 1, tp-02 test staff 1, tp-03 and tp-04 the two test
 * customers, tp-05 the one phone named for STOP tests.
 */
export const ROSTER: readonly RosterPhone[] = Object.freeze([
  TEST_OWNER_1_PHONE,
  Object.freeze({ testPhoneId: "tp-02", handleId: "handle-tp-02", fakeNumber: "+15555550102" }),
  Object.freeze({ testPhoneId: "tp-03", handleId: "handle-tp-03", fakeNumber: "+15555550101" }),
  Object.freeze({ testPhoneId: "tp-04", handleId: "handle-tp-04", fakeNumber: "+15555550104" }),
  Object.freeze({ testPhoneId: "tp-05", handleId: "handle-tp-05", fakeNumber: "+15555550105" }),
]);

/** The roster phone with that roster id, compared exactly (never trimmed or folded), or null for one not on the roster. */
export function rosterPhone(testPhoneId: string): RosterPhone | null {
  return ROSTER.find((phone) => phone.testPhoneId === testPhoneId) ?? null;
}

// Data-access v1.24: staging's test businesses (K-05 v1.24 item 89, defaults 226 and 232; T-1561, the ruling T-1543's
// card A10, ops/reviews/signup-remainder/rule-rest.json; DL-1228). Its one reader is card E10's binding of K-21 v1.4's
// testReviewItems on staging (the ruling's R28 and R33): it passes the numbers staging lets Rosie text
// (STAGING_LINQ_ALLOWLIST and the roster's test phones, read by name at run time), then reads item 88 once per kind for
// each business answered. Production's binding never calls it.
//
//   readStagingTestBusinesses  a list of numbers (E.164, each once, at least one) gives, in id order and each once, the
//                              business_id of every K-23 companies row whose business_id is set and whose
//                              owner_person_id is the person_id of a K-22 accounts row whose mobile is one of the numbers
//                              (default 232: the owner is the company's, as item 52 reads it, proven or not); none is an
//                              empty list. A company with no business yet names none.
//
// Never a role: no person_roles row is read, live or ended (no sign-up step writes the owner's role, and a staging test
// business holds no live owner role: open gaps 58 and 95; CQ-367). Neither businesses nor phones is read
// (companies_business_fk and accounts_mobile_fk hold each id and number to its row). Ids alone are answered: no number,
// person, name, role or count.
//
// Role and side (default 226): the runtime side, as rosie_job (pass the runtime side's client: the role is the
// connection's), unscoped: inRuntimeTransaction sets rosie.business_id empty for the transaction, and this read confirms
// it empty (targets.ts assertRuntimeSide, a statement that reads no table) before its one statement, so companies_runtime
// (0019) shows it every company. Its own read-only transaction at repeatable read on its own connection on the primary,
// uncached, beside a Tool API call's transaction and never on it, 1 connection, released before it answers. rosie_job
// selects companies (0019 line 323) and accounts (0020 line 516); rosie_app holds no grant on accounts, so the Tool API's
// role is refused by PostgreSQL's privilege check (42501, thrown scrubbed as DataAccessDatabaseError).
//
// What it reads: companies' business_id and owner_person_id; accounts' person_id and mobile. The numbers are bound as
// parameters, never written into a statement's text, and never logged or put in an error.
//
// Errors (K-05 README: every call may answer transient). A serialization failure, a deadlock or a lost connection answers
// transient, with its SQLSTATE alone; any other database error is thrown scrubbed (clocks.ts transientOrScrubbed). A
// request of the wrong shape throws a TypeError before any statement, naming the field, never a value: an empty list
// among them (refuse-staging-test-businesses-no-numbers: a binding whose allow-list failed to load fails closed before
// the read, never reads the whole table).
import type * as K05 from "../../contracts/generated/data-access/data-access.v1.24";
import { transientOrScrubbed } from "./clocks";
import type { Sql } from "./scope";
import { assertRequestShape, assertRuntimeSide, inRuntimeTransaction } from "./targets";

/** K-05 v1.24 readStagingTestBusinesses.request: the numbers staging lets Rosie text, at least one. */
export type ReadStagingTestBusinessesRequest = K05.ReadStagingTestBusinessesRequest;
/** K-05 v1.24 readStagingTestBusinesses.response: the test businesses' ids alone, in id order. */
export type ReadStagingTestBusinessesResponse = K05.ReadStagingTestBusinessesResponse;
/** K-05 v1.24 readStagingTestBusinesses.errors: transient alone. */
export type ReadStagingTestBusinessesError = K05.ReadStagingTestBusinessesErrors;
export type ReadStagingTestBusinessesOutcome =
  ReadStagingTestBusinessesResponse | ReadStagingTestBusinessesError;

const CALL = "readStagingTestBusinesses";
/** K-05 v1 phoneNumber (K-04 phones_number_form): E.164. */
const E164 = /^\+[1-9][0-9]{6,14}$/;

/** The numbers: a list of at least one, each in E.164 form and each once (the schema's minItems and uniqueItems). */
function numbersOf(request: unknown): string[] {
  assertRequestShape(request, CALL, ["numbers"]);
  const { numbers } = request as Record<string, unknown>;
  if (!Array.isArray(numbers) || numbers.length === 0) {
    throw new TypeError(`${CALL}: numbers is a list of at least one number`);
  }
  const list: string[] = [];
  for (const number of numbers as unknown[]) {
    if (typeof number !== "string" || !E164.test(number)) {
      throw new TypeError(`${CALL}: each of numbers is a phone number in E.164 form`);
    }
    list.push(number);
  }
  if (new Set(list).size !== list.length) {
    throw new TypeError(`${CALL}: numbers names each number once`);
  }
  return list;
}

/** The businesses inside the read's own transaction: the scope confirmed empty, then one statement. */
async function businessesIn(tx: Sql, numbers: string[]): Promise<ReadStagingTestBusinessesResponse> {
  await assertRuntimeSide(tx, CALL);
  const rows = await tx<{ business_id: string }[]>`
    select c.business_id from companies c
    join accounts a on a.person_id = c.owner_person_id
    where a.mobile in ${tx(numbers)} and c.business_id is not null
    group by c.business_id
    order by c.business_id collate "C"
  `;
  return { result: "testBusinesses", businessIds: rows.map((row) => row.business_id) };
}

/**
 * Staging's test businesses (K-05 v1.24 item 89): the business of every K-23 company whose owner's K-22 account mobile is
 * one of the numbers, in id order, each once; ids alone. One statement over companies joined to accounts, never
 * person_roles, in one read-only transaction at repeatable read on the primary, unscoped, uncached, writing nothing. Pass
 * the runtime side's client (rosie_job): the Tool API's role meets 42501. transient on a serialization failure, a deadlock
 * or a lost connection. Throws a TypeError for a request of the wrong shape (an empty list among them) before any
 * statement, and any other database error scrubbed (DataAccessDatabaseError). The numbers are never logged.
 */
export async function readStagingTestBusinesses(
  sql: Sql,
  request: ReadStagingTestBusinessesRequest,
): Promise<ReadStagingTestBusinessesOutcome> {
  const numbers = numbersOf(request);
  try {
    return await inRuntimeTransaction(sql, { readOnly: true }, (tx) => businessesIn(tx, numbers));
  } catch (error) {
    return transientOrScrubbed(CALL, error);
  }
}

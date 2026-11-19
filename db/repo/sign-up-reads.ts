// Default 14's read of a sign-up's link and control, on the call's transaction, as the Tool API's role may read it
// (T-1463; the architect's N2 on T-1459; DL-961, DL-964). Limit 1's default 14 (actions/src/gate/limit-1/allowed.ts,
// T-1459) passes a sign-up's own answer only when, beside its question (b), (c) the sender's person is linked to the
// turn's handle (K-04 v1 person_handles) and (d) the business's control is not proven (K-23 v1
// business_setup.control_proven_at). This file reads (c) and (d) of the call's business, each from its stored row.
//
// Why here (T-1459's builder's handoff 1; the architect's N2): staging's gate runs as rosie_app (ADR-014; DL-950), and
// T-1459 read both through K-05 v1.2's readTurnState (setup/turn-state.ts readTurnStateIn), whose first statement reads
// handles (turn-state.ts line 792) and whose link read joins person_handles and persons (its lines 818 to 824). 0012
// grants those tables to rosie_job alone (its lines 98 to 103), so as rosie_app the read failed with 42501. A grant would
// show the Tool API every business's links (DL-950 note a), so:
//   (d) business_setup's row of the call's business, read under the call's scope: rosie_app already selects it there,
//       behind business_setup_tool_api (0019's lines 48 to 58), as rosie_job does behind business_setup_runtime;
//   (c) the link, chosen by privilege as targets.ts's liveOpenQuestionsOfHandle chooses (T-1457): a first statement,
//       which reads no table, asks whether the transaction's role may select from person_handles:
//         - it may (rosie_job, the tables' owner): person_handles read directly by its key, the link K-05 v1.2 item 26
//           reads (turn-state.ts lines 818 to 824; persons adds nothing there, since person_handles_person_fk keeps every
//           link's person: 0004's line 30);
//         - it may not (rosie_app, or any role that holds neither side's rights, which is then refused EXECUTE: closed):
//           person_handles_linked (0038), a security-definer function that answers true only when the person is linked
//           to the handle and the handle has a live open question of the caller's scope's business.
//       Default 14 asks (c) only once (b), limit 3's question read, has found a live question of the call's business on
//       the handle, asked of the sender; there both sides answer the same. Elsewhere rosie_app's answer is false, by
//       0038's bound, where the runtime side's is the link as K-04 holds it.
// Both facts are read in one statement, so they are one moment's even at read committed. No statement here reads
// handles, persons, phones or person_handles as rosie_app. (b) stays limit 3's (targets.ts liveOpenQuestionsOfHandle,
// through 0037 as rosie_app; mapped by limit 3's askedQuestionOf): not here.
//
// Side and scope (K-04 v1 rule 4; scope.ts): inside the call's own transaction, under the request's business scope,
// checked with requireBusinessScope before the first read, as readTurnStateIn checks it. A transaction with no scope, or
// another business's, is refused with BusinessScopeError before anything is read, so rosie_job with no scope (which
// reads every business's rows) never reads here. A request of the wrong shape throws a TypeError, naming a field and
// never a value. Every other error is thrown as postgres.js throws it (a refused statement, a lost connection), as
// readTurnStateIn throws them: limit 1 then answers its part as if the fact were missing. Nothing here logs: ids of
// people and handles are personal data.
import { assertBusinessId, BusinessScopeError, requireBusinessScope, type Sql, type Tx } from "./scope";
import { assertId, assertRequestShape, utcOrNull } from "./targets";

type Db = Sql | Tx;

/** What default 14 asks: of the call's business, the turn's handle and the person whose link to it is read. */
export interface SignUpFactsRequest {
  readonly businessId: string;
  readonly handleId: string;
  /** The person whose link to the handle is read; null reads no link (linked answers false). */
  readonly personId: string | null;
}

/** K-23 v1 business_setup's control of the business, as its row holds it. */
export interface BusinessSetupControl {
  /** control_proven_at in UTC, ending in Z, or null: "not yet, so the business stays offline" (K-23 v1; S1-75). */
  readonly controlProvenAt: string | null;
  /** The row's version (K-04 v1 rule 2). */
  readonly version: number;
}

/** Default 14's facts (c) and (d), as one statement read them. */
export interface SignUpFactsRead {
  /** (d) The business's business_setup row's control and version; null when the business has no such row. */
  readonly setup: BusinessSetupControl | null;
  /**
   * (c) Whether K-04 links the person to the handle: on the runtime side person_handles as it is; as rosie_app 0038's
   * answer, which is false too when the handle has no live open question of the business. False when no person is asked.
   */
  readonly linked: boolean;
}

const REQUEST_FIELDS = ["businessId", "handleId", "personId"] as const;

/** Refuses a request that is not SignUpFactsRequest's shape, naming the field, never a value. */
function checkRequest(request: unknown): asserts request is SignUpFactsRequest {
  assertRequestShape(request, "readSignUpFacts", REQUEST_FIELDS);
  const fields = request as Record<string, unknown>;
  for (const field of REQUEST_FIELDS) {
    if (!Object.hasOwn(fields, field)) {
      throw new TypeError(`readSignUpFacts: the request needs ${field}`);
    }
  }
  assertId(fields.businessId, "businessId");
  assertBusinessId(fields.businessId);
  assertId(fields.handleId, "handleId");
  if (fields.personId !== null) {
    assertId(fields.personId, "personId");
  }
}

interface FactsRow {
  control_proven_at: Date | null;
  /** business_setup.version is not null, so null here means the business has no business_setup row. */
  version: number | null;
  /** exists(), false or 0038's answer: a boolean, never null; anything but true answers no link. */
  linked: boolean | null;
}

/**
 * Default 14's facts (c) and (d) inside the call's transaction `db`, which must run under the request's business scope
 * (checked first): the business's business_setup row's control_proven_at and version, or none, and whether the person
 * writes from the handle, the link read as the transaction's role may read it (see the top of this file). Three
 * statements: the scope, the role's side (no table) and the one read.
 */
export async function readSignUpFactsIn(db: Db, request: SignUpFactsRequest): Promise<SignUpFactsRead> {
  checkRequest(request);
  const { businessId, handleId, personId } = request;
  if ((await requireBusinessScope(db)) !== businessId) {
    throw new BusinessScopeError("readSignUpFacts runs under the request's own business scope");
  }
  const [side] = await db<{ reads_links: boolean }[]>`
    select has_table_privilege('person_handles', 'SELECT') as reads_links
  `;
  const link =
    personId === null
      ? db`false`
      : side?.reads_links === true
        ? db`exists (select 1 from person_handles ph where ph.person_id = ${personId} and ph.handle_id = ${handleId})`
        : db`person_handles_linked(${personId}, ${handleId})`;
  const [row] = await db<FactsRow[]>`
    select s.control_proven_at, s.version, ${link} as linked
    from (select 1) as one
      left join business_setup s on s.business_id = ${businessId}
  `;
  if (row === undefined) {
    throw new Error("readSignUpFacts: the read answered no row");
  }
  return {
    setup:
      row.version === null
        ? null
        : { controlProvenAt: utcOrNull(row.control_proven_at), version: row.version },
    linked: row.linked === true,
  };
}

// The context's frame (T-291): the parts of K-02 v1's context around the choices, from the request, the stored state
// read for the turn and the pinned bundle: the flow and its always-on prefix, who wrote, and the business's language.
//
// Defaults where no frozen source gives a value (ops/QUESTIONS.md, through the report):
//   - the flow: no table holds a business's flow (K-04 v1 businesses; K-23 v1 keeps defaults per business and flow),
//     so it is the flow an open question's own step carries (an A or B step), else the first flow the pinned bundle
//     lists, A before B; the shared S steps are the same in both flows (K-01 README default 4);
//   - the business's language: no frozen table holds one, so it is English, the language of the bundle's fixed lines
//     (K-01 v1 fixedLines);
//   - a person whose name was not read (no role in the guard's targets and not the caller) has the name "" (K-02 v1
//     allows any string), and a stored language that is not a two-letter code reads as none.

import { flowOfStep } from "./bundle";
import type {
  BuildFrontierRequest,
  Context,
  FlowLetter,
  OpenQuestionRow,
  Person,
  ReadTurnStateRequest,
  TurnState,
} from "./types";

/** The business's language when no table holds one (see above). */
export const DEFAULT_BUSINESS_LANGUAGE = "en";

/** K-05 v1.2 factRef: a fact named by its key and its one home (table, row, column). */
type FactRef = ReadTurnStateRequest["facts"][number];

/**
 * A table of K-04 v1 as K-05 v1.2's factTable names it. The generated type is wider than the schema there (it cannot say
 * "a table name, never sealing_keys"), so the two names this file reads are cast; K-05's own schema check holds them.
 */
function factTable(name: "businesses" | "persons"): FactRef["table"] {
  return name as unknown as FactRef["table"];
}

/** K-04 v1 person_roles.role, as K-02 v1 person.roles names it (FS line 723). */
const ROLE_NAMES = {
  owner: "owner",
  admin: "admin",
  staff: "staff",
  own_business: "ownBusiness",
  customer: "customer",
} as const satisfies Record<string, Person["roles"][number]["role"]>;

/** The facts the frame and the labels read through readTurnState: the business's name and zone, each person's name. */
export function frameFacts(businessId: string, personIds: readonly string[]): FactRef[] {
  return [
    { key: "biz.name", table: factTable("businesses"), rowId: businessId, column: "name" },
    { key: "biz.zone", table: factTable("businesses"), rowId: businessId, column: "time_zone" },
    ...personIds.map((personId) => ({
      key: `person.name/${personId}`,
      table: factTable("persons"),
      rowId: personId,
      column: "name",
    })),
  ];
}

/** The persons whose names the frontier reads: the caller and everyone the guard listed a role for, each once. */
export function namedPersons(request: BuildFrontierRequest): string[] {
  const ids = [request.caller.personId, ...request.targets.roles.map((role) => role.personId)];
  return ids.filter((id, index): id is string => typeof id === "string" && ids.indexOf(id) === index);
}

/** The context's flow (see above): an open question's own A or B step's, else the pinned bundle's first. */
export function contextFlowOf(
  rows: readonly OpenQuestionRow[],
  listed: readonly FlowLetter[],
): FlowLetter | null {
  for (const row of rows) {
    const own = flowOfStep(row.step);
    if (own !== null && listed.includes(own)) return own;
  }
  return listed[0] ?? null;
}

/** A stored language (K-04 v1 persons.language, a BCP 47 tag) as K-02 v1's two-letter code, or null. */
export function languageOf(tag: string | null): string | null {
  if (tag === null) return null;
  const primary = /^([A-Za-z]{2})(?:[-_][A-Za-z0-9_-]*)?$/u.exec(tag)?.[1];
  return primary === undefined ? null : primary.toLowerCase();
}

/** Who wrote (K-02 v1 context.writer): the handle's address and its people, with their roles and languages. */
export function writerOf(
  request: BuildFrontierRequest,
  state: TurnState,
  names: ReadonlyMap<string, string>,
): Context["writer"] | null {
  const ids = state.persons.map((person) => person.personId);
  const languages = new Map(state.persons.map((person) => [person.personId, person.language]));
  if (ids.length === 0 && typeof request.caller.personId === "string") ids.push(request.caller.personId);
  const people: Person[] = ids.map((personId) => ({
    personId,
    name: names.get(personId) ?? "",
    roles: request.targets.roles
      .filter((role) => role.personId === personId)
      .map((role) => ({ role: ROLE_NAMES[role.role], businessId: role.businessId })),
    language: languageOf(languages.get(personId) ?? null),
  }));
  const [first, ...rest] = people;
  if (first === undefined || state.handle.address === "") return null;
  return { handle: state.handle.address, people: [first, ...rest] };
}

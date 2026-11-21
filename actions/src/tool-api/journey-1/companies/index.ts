// Journey 1's companies (T-630; K-09 v1 README "Journeys 1 and 2: the setup calls"): saveSetupStep's S1-04 variant, which
// kinds share one company (gives companies). Its handler still answers notBuilt and writes nothing (journey 1's registry,
// ../index.ts, and its tests hold it so) until the card that binds the setup calls.
//
// T-1492 (K-09 README default 199 item (4); DL-1033 ruling 7, DL-1049) builds the one-kind path for the walk: S1-04 is
// walked, not asked, when the owner has exactly one kept kind. createOneKind (one-kind.ts) gives `wrap`, the wrapper
// around T-633's S1-02 writer that places the one pick on its own insert, and `settler`, S1-04's buttons settler (T-1491's
// WalkDeps.buttonsSettlers port), with `buttonsSettlers` binding it at S1-04 alone. The turn face binds them (T-1493,
// H1a): S1-02 as plugIns.kinds(oneKind.wrap(kindsWriters["S1-02"])), and WalkDeps.buttonsSettlers as
// oneKind.buttonsSettlers, both from one createOneKind instance per binding, with the reads (reads.ts) handed in. The
// helpers T-1481's S1-04 writer reuses are exported here too: turnCompanyOf, companyKindOnFile, companyKindInsert and
// draftedDefaults.
//
// T-1481 (T-634 part 2a; K-09 README defaults 182 to 184 and 190; card 12 of the S1-04 design ruling) builds S1-04's
// read-only step writer for an answered S1-04 (default 181's walk): companiesWriter (writer.ts), a StepWriter that places
// the caller's person's kept picks in the groups "Some share one", "All share one" or "Each is its own" gives, reading
// through the same CompaniesReads port (reads.ts, with kindNames added for default 190's matching) and reusing the
// helpers above (and one-kind.ts's personOf, pickPlacement and gainedBusinessRows). The binding card (T-1484, H1b) binds
// it at S1-04 by step id, with `partyRuleLive` left off until the party rule is live (default 184). This entry and the
// registry stay as they are.

import { NotBuiltError } from "../../errors";
import type { SetupFolder } from "../index";

export {
  CompaniesReadError,
  CompaniesRefusedError,
  type CompaniesFault,
  type CompaniesReadFault,
  type CompaniesReadName,
} from "./errors";
export {
  COMPANIES,
  S1_02,
  S1_04,
  companyKindInsert,
  createOneKind,
  gainedBusinessRows,
  personOf,
  pickPlacement,
  type OneKind,
  type OneKindDeps,
} from "./one-kind";
export {
  PROTECTIVE_FACTS,
  companiesReadsOf,
  companyKindOnFile,
  draftedDefaults,
  pgCompaniesK05Reads,
  turnCompanyOf,
  type CompaniesK05Reads,
  type CompaniesReads,
  type KindDefaults,
  type KindDefaultsRequest,
  type KindNamesRequest,
} from "./reads";
export {
  ALL_SHARE_ONE,
  COMPANY_NAME,
  EACH_IS_ITS_OWN,
  SHARED_KINDS,
  SOME_SHARE_ONE,
  companiesWriter,
  type CompaniesWriterDeps,
} from "./writer";

/** This folder's entries, as journey 1's lane registers them (../index.ts JOURNEY_1_LANE). */
export const FOLDER: SetupFolder<unknown> = {
  folder: "companies",
  entries: [
    {
      call: "saveSetupStep",
      step: "S1-04",
      handler: () => Promise.reject(new NotBuiltError("saveSetupStep")),
    },
  ],
};

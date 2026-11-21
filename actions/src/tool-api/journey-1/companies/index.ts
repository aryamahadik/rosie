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
} from "./reads";

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

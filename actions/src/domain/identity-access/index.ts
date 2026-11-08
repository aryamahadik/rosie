// The identity-and-access service base (T-308; C-094): who a sender is for a business, the booker, the person served and
// the payer kept apart, and who decides a visit, a fee, a refund, the team or a setting (S13-31). A Tool API handler
// makes one per call: createIdentityAccess({ businessId: context.businessId, reader: identityReaderOf(context.repo) }).

export {
  ADMIN_POWERS,
  NOTHING_ON_FILE,
  NO_ADMIN_POWERS,
  identityReaderOf,
  type AdminPower,
  type AdminPowers,
  type AgeBand,
  type IdentityReader,
  type ServedFacts,
  type ServedFactsReader,
} from "./facts";
export {
  BUSINESS_MATTERS,
  OWNER_ONLY_MATTERS,
  ROLES,
  createIdentityAccess,
  partsOf,
  type BusinessMatter,
  type Decider,
  type DecidesAs,
  type IdentityAccess,
  type IdentityAccessOptions,
  type Matter,
  type NoDecider,
  type OwnerOnlyMatter,
  type Part,
  type Parties,
  type Role,
  type Sender,
  type SenderPerson,
  type WhoDecides,
} from "./identity-access";

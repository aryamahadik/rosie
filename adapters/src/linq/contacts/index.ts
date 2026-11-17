// The Linq contacts registrar (T-415; C-208; K-11 v1 contactAdd): a stub that makes no network call and answers K-11's
// failed result, since Linq's v3 API has no contacts/add (K-11 open gap 1; CQ-354, for the architect).
export {
  ENVIRONMENT,
  NO_PHONE,
  REASONS,
  createLinqContactRegistrar,
  type LinqContactRegistrar,
  type LinqContactRegistrarOptions,
  type LinqContactsEnv,
} from "./contacts";
export type { ContactAddAdded, ContactAddFailed, ContactAddOutcome, ContactAddRequest } from "./types";

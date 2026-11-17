// The staging roster allow-list in front of the real Linq line (T-416; C-210; Q-44's default): on staging, T-414's send,
// T-415's contact add and T-415's capability check reach Linq only for a number on STAGING_LINQ_ALLOWLIST that is not
// Rosie's own line (ROSIE_NUMBER); off staging they pass unchanged.
export {
  REASONS,
  ROSIE_NUMBER,
  STAGING_LINQ_ALLOWLIST,
  guardLinqCapabilityChecker,
  guardLinqContactRegistrar,
  guardLinqSender,
  type LinqRosterEnv,
  type LinqRosterOptions,
  type RosterRefusal,
} from "./roster";

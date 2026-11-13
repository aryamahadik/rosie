// The compose-input call (C-090, T-309, T-1174; K-09 v1.6 composeInput): one committed outbox row turned into K-03
// v1.1's composer input, with only what limit 7 lets its recipient see, its step card's term facts and code's situation
// tag, never the frontier. See handler.ts.
// Wiring (D-017): `{ ...handlers, composeInput: createComposeInputHandler({ ports, bundles }) }`, with the row reader as
// `ports` once it is built; until then notBuiltComposeInputPorts() keeps the call failing closed (notBuilt).

export { MAX_CONVERSATION, addressedAs, buildComposeInput, slotsIn } from "./build";
export {
  COMPOSE_INPUT_SCHEMA_FILES,
  COMPOSE_INPUT_SCHEMA_IDS,
  MESSAGE_PLAN_SCHEMA_ID,
  MESSAGE_PLAN_V1_1_SCHEMA_ID,
  admitInput,
  createComposeInputChecker,
  defaultComposeInputChecker,
  loadComposeInputSchemas,
  type ComposeInputChecker,
  type ComposeInputSchemaId,
} from "./check";
export {
  ComposeInputNotBuiltError,
  ComposeInputRefusedError,
  type ComposeInputFault,
  type ComposeInputSeam,
} from "./errors";
export {
  CLOSED_STATES,
  COMPOSABLE_STATES,
  composeInputHandlers,
  createComposeInputHandler,
  notBuiltComposeInputPorts,
  type ComposeInputDeps,
} from "./handler";
export {
  READER_LANES,
  ROSIE_LANE,
  optOutLinesOf,
  readMasterLine,
  withoutOptOutLine,
  type MasterLine,
  type MasterLineRead,
} from "./master-line";
export {
  MONEY_SLOTS,
  NO_DANGER,
  SIGNAL_TAGS,
  SITUATIONS,
  sensitiveOn,
  signalsOf,
  situationOf,
  type Signal,
} from "./situation";
export {
  S1_02_SOURCES,
  genericSource,
  sourceOf,
  termFactsOf,
  type CardPlace,
  type KnownSource,
} from "./term-facts";
export type {
  Audience,
  BundleId,
  Channel,
  ComposeBundles,
  ComposeInput,
  ComposeInputAnswer,
  ComposeInputError,
  ComposeInputPorts,
  ComposeInputRequest,
  ComposeInputResponse,
  ComposeRow,
  ComposeRowRead,
  Concern,
  ConversationMessage,
  Fact,
  FixedLineRow,
  FlowLetter,
  Format,
  Inbound,
  InboundText,
  LinkSlot,
  MasterLineMissing,
  Missing,
  NotFound,
  OpenQuestion,
  Option,
  Reach,
  RowState,
  Situation,
  SituationFacts,
  SlotFact,
  TermFact,
  Transient,
} from "./types";

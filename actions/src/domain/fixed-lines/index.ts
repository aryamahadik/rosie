// The fixed lines (T-1414; K-09 v1 sendFixedLine): a fixed line sent word for word as one outbox row in the turn's one
// commit, the guard's HELP reply in a keyword turn, built through T-307's outboxRows and read through the wiring's
// flags port; made alone it answers notBuilt (CQ-44's default). See fixed-lines.ts.

export {
  FixedLineRefusedError,
  HELP_REPLY,
  HELP_STEP,
  TURN_LINES,
  fixedLineKey,
  fixedLineRowId,
  planSendFixedLine,
  sendFixedLineAlone,
  sendFixedLineCore,
  sendFixedLineHandler,
  sendsInTurn,
  sentEarlierInTurn,
  turnLineOf,
  type FixedLineAction,
  type FixedLineCall,
  type FixedLineDeps,
  type FixedLineFault,
  type FixedLinePlan,
  type FixedLinePorts,
  type SendFixedLineAnswer,
  type SendFixedLineError,
  type SendFixedLineRequest,
  type SendFixedLineResponse,
  type TurnLine,
} from "./fixed-lines";

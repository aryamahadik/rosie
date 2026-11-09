// The eval harness's accuracy statistics (T-480, C-140): right out of total, the point estimate, the two-sided 95%
// Wilson interval (CQ-10) and the status, met, notYetProven or miss, against a target's direction and its bar's sized
// volume (BP 8 "Eval gate"; K-10 v1). The graders count (T-481, T-482), the report writes K-10 v1's measures from
// score() (T-484), and the sizing reads the interval (T-477).
export { Z_ONE_SIDED_95, Z_TWO_SIDED_95, wilsonInterval, type Interval } from "./interval";
export { score, statusOf, type Direction, type MeasureInput, type MeasureResult, type Status } from "./score";

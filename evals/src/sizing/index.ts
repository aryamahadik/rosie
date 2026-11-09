// The gold-set volume sizing (T-477, C-140): for every row of section 08's table, the smallest volume at which its 95%
// interval clears its target, two-sided by default with the one-sided figure beside it, for Jay to approve under J-19
// (evals/SIZING.md). Built on T-480's interval library (evals/src/stats); the accuracy report reads a measure's volume
// from volumeOf (T-484), and the gold-set tasks size their counts by it (T-492 to T-496).
export {
  MAX_VOLUME,
  SECTION_08,
  oneFailureFrom,
  sizeBar,
  sizingTable,
  smallestVolume,
  volumeOf,
  type Bar,
  type Bound,
  type MeasureName,
  type Sides,
  type Sizing,
} from "./sizing";

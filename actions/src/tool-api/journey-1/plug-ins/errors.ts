// What S1-11's step writer throws (T-634 part 1). Each message names a fault and labels: the step id and, for a trade
// overlay, the trade id the pinned bundle keys it by (K-01 v1 tradeId: a catalog id such as barber, never an owner's
// words; a pick's kind id is only named once it has K-24's form and is no drafted kind). Never a block's text, a pick's
// id or words, a person, a business or the turn's chat id (K-08 v1 README line 75). A throw inside gateAndCommit's handler
// rolls the call's transaction back (the Tool API base; commit/walk/errors.ts), so nothing is written (fail closed).

/**
 * Why S1-11's writer refused the part (refused, never guessed):
 *   - notS1_11: the writer was called for a step other than S1-11 (a binding by the wrong step id);
 *   - noPicks: S1-11 was walked with no picks kept from S1-02's writer in the same walk (its writer was not bound
 *     through `kinds`), so there is nothing to tell which kinds to load;
 *   - pickNotWellFormed: a picked_kinds insert S1-02's writer gave is not K-24 v1's shape (its id, outcome, kind and
 *     business), or a listed pick names no trade-file kind;
 *   - pickOtherBusiness: a pick is of another business than the call's (a pick has the call's business, or none yet);
 *   - kindNotInBundle: the turn's pinned bundle holds no trade overlay for a listed pick's kind;
 *   - overlayNotWellFormed: the overlay read is not K-01 v1's tradeOverlay of that kind (its contract, its trade, the
 *     11 plug-in text blocks each JSON text, its facts and each flow's settings).
 */
export type PlugInFault =
  | "notS1_11"
  | "noPicks"
  | "pickNotWellFormed"
  | "pickOtherBusiness"
  | "kindNotInBundle"
  | "overlayNotWellFormed";

/** S1-11's writer refused the part: the whole turn is refused and nothing is written. */
export class PlugInRefusedError extends Error {
  override name = "PlugInRefusedError";
  readonly fault: PlugInFault;
  /** The step and, for an overlay, the trade id, as labels. */
  readonly ids: readonly string[];

  constructor(fault: PlugInFault, ids: readonly string[] = ["S1-11"]) {
    super(
      `gateAndCommit: S1-11's plug-in writer refused the part (${fault}: ${ids.join(", ")}); nothing was written`,
    );
    this.fault = fault;
    this.ids = [...ids];
  }
}

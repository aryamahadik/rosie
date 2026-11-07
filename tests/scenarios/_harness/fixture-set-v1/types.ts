// Typed shapes of fixture set v1's scenario inputs (T-007; C-028, C-147). The shapes follow the files that
// fixtures/v1/test-kit/ holds; nothing here is a copy of the data. Field names stay as the demo shop files spell them.

/** A flow: A = the customer comes to the business, B = the business goes to the customer. */
export type FlowId = "A" | "B";

/** One service of a demo shop with its money way (the `combo` is "<price kind>|<before>|<after>"). */
export interface DemoService {
  combo: string;
  price_kind: string;
  before: string;
  after: string;
  name: string;
  price: string | null;
  deposit: string | null;
  rest: string | null;
  paid_now: string | null;
  fee: string | null;
  story: string | null;
  due_now_at_booking: number;
  money_flags: string[];
  /** Only on test-mixed-A and test-mixed-B: the combo no profession uses. */
  uncovered_by_professions?: boolean;
}

/** `arrive` and `cutoff` are one text, or one text per flow (an object), or absent. */
export type PerFlowText = string | Record<string, string> | null;

export interface DemoFlow {
  flow: string;
  business: string;
  staff?: string | null;
  customer?: string | null;
  arrive?: PerFlowText;
  cutoff?: PerFlowText;
  main?: string | null;
  services: DemoService[];
}

/** One file of test-kit/shops/. Trade shops carry every field; the two test-mixed shops carry `purpose` and `mixed_booking`. */
export interface DemoShop {
  id: string;
  name: string;
  booking_type: string;
  pattern: string;
  built_from?: string | null;
  google_prefill?: Record<string, string>;
  flows: Partial<Record<FlowId, DemoFlow>>;
  services_shape?: string;
  questions_before_times?: string | string[];
  /** The stop words (G1 applied): texts that mean "stop and send the person to emergency help". */
  safety_stop?: string[];
  first_steps?: string[];
  facts?: string[];
  switches?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  license?: string;
  staff_skills?: string;
  messages_never?: string;
  images?: Record<string, string>;
  demo_note?: string;
  purpose?: string;
  mixed_booking?: { services: string[]; expect: string };
}

/** "trade" = one of the 243 profession shops; "mixed" = test-mixed-A or test-mixed-B (money combos no profession uses). */
export type ShopKind = "trade" | "mixed";

export interface DemoShopRecord {
  id: string;
  kind: ShopKind;
  /** The file's path inside fixtures/v1. */
  file: string;
  shop: DemoShop;
  /** The shop's stop words; empty when it has none. */
  stopWords: readonly string[];
  hasStopWords: boolean;
}

/** A gap that KNOWN-STALE.md names: these shops keep this field empty and no test expects it filled. */
export interface KnownGap {
  shops: readonly string[];
  field: string;
  cause: string;
}

/**
 * A scenario line that KNOWN-STALE.md marks stale. C9 wins in tests (Q-36): no test asserts a flagged line.
 * `listed` = a row of the stale table (two of them: test-kit.js lines 176 and 179); `noted` = a line the file
 * mentions in its text without a row (SCENARIOS.md line 529, Lost phone, D100).
 */
export interface StaleNote {
  kind: "listed" | "noted";
  /** The line in the master's test-kit.js that writes it; null for a `noted` line. */
  testKitJsLine: number | null;
  /** The line in test-kit/SCENARIOS.md. */
  scenariosLine: number;
  title: string;
  why: string;
  useInstead: string;
}

/** One line of expected result under a scenario. */
export interface ScenarioLine {
  /** The line in test-kit/SCENARIOS.md. */
  line: number;
  text: string;
}

/** One of the 56 "Per money combo" scenarios: run it on the named demo shop's service. */
export interface MoneyComboScenario {
  type: "money-combo";
  /** "<flow>:<combo>", for example "A:list|none|none". */
  id: string;
  flow: FlowId;
  combo: string;
  shopId: string;
  serviceName: string;
  /** The heading's line in test-kit/SCENARIOS.md. */
  line: number;
  expectations: readonly ScenarioLine[];
  /** Always null: a money-combo scenario is never stale. Kept so every scenario can be asked the same way. */
  stale: null;
}

/** One of the "Cross-cutting cases" of test-kit/SCENARIOS.md. */
export interface CrossCuttingScenario {
  type: "cross-cutting";
  /** "cross:<title>". */
  id: string;
  /** The line in test-kit/SCENARIOS.md. */
  line: number;
  title: string;
  /** The reference in brackets after the title, for example "D75" or "test-mixed-A"; null when there is none. */
  ref: string | null;
  text: string;
  /** Set when KNOWN-STALE.md marks this line stale: no test asserts it. */
  stale: StaleNote | null;
}

export type Scenario = MoneyComboScenario | CrossCuttingScenario;

/** test-kit/coverage.json: which shops use which money combo, and what no profession uses. */
export interface Coverage {
  used: Record<string, string[]>;
  missing: string[];
  types: Record<string, string[]>;
  switches: Record<string, string[]>;
  facts: Record<string, string[]>;
  mixed: string[];
  flagged: string[];
}

export interface FixtureSetV1 {
  /** The fixtures/v1 folder that was read (absolute). */
  root: string;
  /** What `verify.mjs` printed when it passed. */
  verifyOutput: string;
  /** All 245 shops, in the order of their file names (the two test-mixed shops fall in place by name). */
  shops: readonly DemoShopRecord[];
  tradeShops: readonly DemoShopRecord[];
  mixedShops: readonly DemoShopRecord[];
  /** The shop with this id; throws when there is none. */
  shop(id: string): DemoShopRecord;
  moneyComboScenarios: readonly MoneyComboScenario[];
  crossCuttingScenarios: readonly CrossCuttingScenario[];
  /** Every scenario, stale ones included, in the order of SCENARIOS.md. */
  scenarios: readonly Scenario[];
  /** The scenarios a test may assert: every scenario that is not flagged stale. */
  assertableScenarios: readonly Scenario[];
  /** The scenarios KNOWN-STALE.md flags. A test never asserts these. */
  staleScenarios: readonly CrossCuttingScenario[];
  staleNotes: readonly StaleNote[];
  knownGaps: readonly KnownGap[];
  coverage: Coverage;
  /** Every file the loader read, as a path inside root (posix). */
  reads: readonly string[];
}

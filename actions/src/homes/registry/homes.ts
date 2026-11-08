// The ten homes and the one module that implements each (T-586; C-074; S13-30).
//
// A home is the one step that holds each kind of fact (K-01 v1 `homes`: master-A.json and master-B.json record.homes:
// money S13-55, contact S13-19, proof S13-45, stop S13-32, clock S13-35, who S13-31, safety S13-10, change S13-56,
// record S13-57, two A9-21). The home steps are read from the bundle, never written here; what is written here is which
// module holds each home's code, from the tasks that build them (ops/plan/03-tasks.md T-587 to T-596, each module's
// "May touch"; 01-inventory.md "Section 13 homes and section 12 shared steps the journeys call": "the homes ship as code
// in M3b"). The clock home's code is the runtime's: its module constrains the due rule every clock row is armed by
// (T-591 "the clock home's module in the runtime ... which the due rule and the journeys' reminders call"; T-255).

/** The ten homes, in K-01 `homes` order (master record.homes; compiler/src/record/compile.ts HOME_NAMES). */
export const HOME_NAMES = [
  "money",
  "contact",
  "proof",
  "stop",
  "clock",
  "who",
  "safety",
  "change",
  "record",
  "two",
] as const;

export type HomeName = (typeof HOME_NAMES)[number];

export function isHomeName(value: unknown): value is HomeName {
  return typeof value === "string" && (HOME_NAMES as readonly string[]).includes(value);
}

/** Where a home's code lives and which task builds it. */
export interface HomeModuleRef {
  /** The layer that runs it: the action layer's Tool API, or the runtime (the clock home). */
  readonly layer: "actions" | "runtime";
  /** The folder of the one module that implements the home: its task's "May touch". */
  readonly module: string;
  /** The task that builds the module (03-tasks.md). */
  readonly task: string;
  /** homeModule: the home's own module; dueRule: the runtime's due rule, which the clock home's module constrains. */
  readonly via: "homeModule" | "dueRule";
}

/** The one module of each home (03-tasks.md T-587 to T-596). */
export const HOME_MODULES: Readonly<Record<HomeName, HomeModuleRef>> = {
  money: { layer: "actions", module: "actions/src/homes/money", task: "T-593", via: "homeModule" },
  contact: { layer: "actions", module: "actions/src/homes/contact", task: "T-588", via: "homeModule" },
  proof: { layer: "actions", module: "actions/src/homes/proof", task: "T-592", via: "homeModule" },
  stop: { layer: "actions", module: "actions/src/homes/stop", task: "T-590", via: "homeModule" },
  clock: { layer: "runtime", module: "runtime/src/clocks/home", task: "T-591", via: "dueRule" },
  who: { layer: "actions", module: "actions/src/homes/who", task: "T-589", via: "homeModule" },
  safety: { layer: "actions", module: "actions/src/homes/safety", task: "T-587", via: "homeModule" },
  change: { layer: "actions", module: "actions/src/homes/change", task: "T-594", via: "homeModule" },
  record: { layer: "actions", module: "actions/src/homes/record", task: "T-595", via: "homeModule" },
  two: { layer: "actions", module: "actions/src/homes/two", task: "T-596", via: "homeModule" },
};

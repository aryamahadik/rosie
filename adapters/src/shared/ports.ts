// The adapters' ports (T-410; plan 3.2; 02-contracts section 5). One folder under adapters/src/ per port, each holding
// its adapter, its test double and its recorded vendor samples (the vendor's wire format stays inside the adapter).
//
// There is no sms port: SMS is archived (DL-012), so no adapters/src/sms folder and no SMS export exists, and a test
// asserts it. When SMS is wanted later it comes through Linq.

/** The K-08 v1 provider list: the outside services a span may name (event-trace.v1 $defs/provider). */
export const PROVIDERS = [
  "linq",
  "resend",
  "stripe",
  "google_calendar",
  "microsoft_calendar",
  "google_places",
  "geo",
  "r2",
  "anthropic",
] as const;

export type Provider = (typeof PROVIDERS)[number];

/** The port folders of adapters/src/, each with the K-08 providers its adapter talks to. */
export const PORT_PROVIDERS = {
  linq: ["linq"],
  email: ["resend"],
  stripe: ["stripe"],
  calendar: ["google_calendar", "microsoft_calendar"],
  places: ["google_places"],
  files: ["r2"],
  geo: ["geo"],
} as const satisfies Record<string, readonly Provider[]>;

export type PortFolder = keyof typeof PORT_PROVIDERS;

/** The port folder names, in the order the plan lists them. */
export const PORT_FOLDERS = Object.keys(PORT_PROVIDERS) as readonly PortFolder[];

/** The adapters' outside-call hops: the K-08 hops that must name a provider, a call and an attempt. */
export const OUTSIDE_CALL_HOPS = ["portCall", "effectRun", "dispatch"] as const;

export type OutsideCallHop = (typeof OUTSIDE_CALL_HOPS)[number];

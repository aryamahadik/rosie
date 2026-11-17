// The capability check's types (T-415; C-209; K-11 v1 capabilityCheck). They mirror the capabilityCheck definitions of
// contracts/port-linq/port-linq.v1.schema.json by hand, field for field as the Linq double's types do
// (adapters/src/linq/double/types.ts), because the generated contract types are git-ignored (ADR-005). This folder's
// tests check every outcome against the schema itself.

/** A Linq chat's service, as K-11 names it ($defs/service): imessage, rcs or sms. */
export type LinqService = "imessage" | "rcs" | "sms";

/** K-11 `capabilityCheck.request`: what a number supports now, when no text from it says (arch 07 line 365). */
export interface CapabilityCheckRequest {
  phone: string;
}

/** K-11 `capabilityCheck.response`: the answer, which the caller caches for 10 minutes (arch 07 line 365). */
export interface CapabilityCheckChecked {
  result: "checked";
  phone: string;
  imessage: boolean;
  service: LinqService | null;
  checkedAt: string;
  cacheSeconds: 600;
}

/** K-11 `capabilityCheck.errors`: the check failed, so the reply goes as text alone (arch 07 line 365, DD). */
export interface CapabilityCheckFailed {
  result: "failed";
  phone: string;
  code: string | null;
  reason: string;
}

export type CapabilityCheckOutcome = CapabilityCheckChecked | CapabilityCheckFailed;

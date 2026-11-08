// A Stripe effect row's K-14 v1 request (C-109, T-326). K-14 README 'Effects': "A call that runs from an effect row takes
// {effect, amount?, port}: effect is the row's effect id and its one idempotency key, amount its amount, and port is
// exactly what the row holds as its portRequest. So no fact the effect row holds is stored twice. The effects runner
// (C-109) builds the request from the row".
//
// So nothing here makes a charge, a price or an amount: every value sent is the claimed row's, which the turn's commit
// wrote (arch 10 line 508; BP section 0, no charge without a clear yes). A row that does not hold exactly what its call
// takes is refused before any call: its portRequest is held to K-14's `<call>.portRequest` field by field, so a field v1
// does not have, a hold's captureMethod included, is never sent (RULES 3.2: "Nothing is ever held on a card"; D65;
// refuse-card-hold.json), and a money kind with no amount is never given one.
//
// The checks are K-14 v1's schema written as code, as the Stripe double's are (the Worker cannot run Ajv:
// runtime/src/trace/validate.ts); request.test.ts holds them to the schema itself. A fault names a field, never a value
// (no card data, key, amount or name in any message).
//
// Defaults used (for ops/QUESTIONS.md):
//   1. The kind and the purpose agree: rosfield_monthly_charge only with purpose rosfieldMonthlyBill, and stripe_charge
//      never with it (K-14 README 'Rosfield's own billing': "The monthly charge (S11-67): charge with purpose
//      rosfieldMonthlyBill ... run as K-07's rosfield_monthly_charge effect"), so a customer's charge kind never bills
//      Rosfield's account and the bill kind never charges a customer.
//   2. A card save's and dispute evidence's row holds no amount (K-14 README 'Effects' table: K-07 amount null): one that
//      does is refused, since what it means is unclear.

import { isLabel } from "../../../../runtime/src/trace";
import type { EffectRow } from "../kinds";
import {
  CALL_OF,
  isStripeKind,
  type ChargeRequest,
  type DisputeEvidenceRequest,
  type PayLinkRequest,
  type RefundRequest,
  type SaveCardRequest,
  type StripeEffectCall,
} from "./port";

/** One built request with its call. */
export type StripeCallRequest =
  | { readonly call: "saveCard"; readonly request: SaveCardRequest }
  | { readonly call: "charge"; readonly request: ChargeRequest }
  | { readonly call: "payLink"; readonly request: PayLinkRequest }
  | { readonly call: "refund"; readonly request: RefundRequest }
  | { readonly call: "disputeEvidence"; readonly request: DisputeEvidenceRequest };

/** The request, or the fields at fault (paths such as port.captureMethod; never a value). */
export type BuildResult =
  | { readonly ok: true; readonly built: StripeCallRequest }
  | { readonly ok: false; readonly faults: readonly string[] };

type Obj = Record<string, unknown>;

/** JSON Schema's "pattern": "." (common formats id; K-14 stripeId and effectId), with Ajv's unicode flag. */
const ANY_CHAR = /./u;
/** "pattern": "\\S" (K-14 description, words). */
const NOT_SPACE = /\S/u;
/** Thirteen or more digits in a row read as a card number (K-14 stripeId's `not`). */
const CARD_NUMBER = /[0-9]([ -]?[0-9]){12,}/u;
const CURRENCY = /^[A-Z]{3}$/u;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
/** A field name a fault may carry: a plain name that cannot hold a card number, an address or words. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/** K-14 v1 purpose. */
export const PURPOSES = [
  "deposit",
  "fullPrice",
  "rest",
  "extra",
  "fee",
  "tip",
  "pack",
  "planCharge",
  "rosfieldMonthlyBill",
] as const;

/** The calls that move money and carry the row's amount (K-14 README 'Effects' table). */
const AMOUNT_CALLS: readonly StripeEffectCall[] = ["charge", "payLink", "refund"];

const PORT_FIELDS: Readonly<Record<StripeEffectCall, readonly string[]>> = {
  saveCard: ["account", "customerId"],
  charge: ["account", "purpose", "customerId", "paymentMethodId", "customerPresent", "description"],
  payLink: ["account", "purpose", "customerId", "saveCardForLater", "description"],
  refund: ["account", "paymentId", "reason"],
  disputeEvidence: [
    "account",
    "disputeId",
    "ownerYes",
    "serviceDate",
    "serviceDescription",
    "customerName",
    "recordFileId",
  ],
};

const OWNER_YES_FIELDS = ["kind", "person_id", "role", "open_question_id", "option_id", "event_id"];

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A string's length as JSON Schema counts it: in code points. */
const lengthOf = (value: string): number => Array.from(value).length;

/** K-14 v1 stripeId: Stripe's opaque id, never a card number. */
export function isStripeId(value: unknown): value is string {
  return typeof value === "string" && ANY_CHAR.test(value) && !CARD_NUMBER.test(value);
}

/** K-14 v1 effectId: at most 500 characters, the most a metadata value takes. */
export function isStripeEffectId(value: unknown): value is string {
  return typeof value === "string" && ANY_CHAR.test(value) && lengthOf(value) <= 500;
}

/** K-14 v1 idempotencyKey: 1 to 255 characters, the most Stripe takes. */
export function isStripeKey(value: unknown): value is string {
  return typeof value === "string" && lengthOf(value) >= 1 && lengthOf(value) <= 255;
}

/** K-14 v1 amount: whole cents, at least one, with a three-letter currency, and nothing else. */
export function isStripeAmount(value: unknown): value is { cents: number; currency: string } {
  return (
    isObject(value) &&
    Object.keys(value).length === 2 &&
    Number.isInteger(value.cents) &&
    (value.cents as number) >= 1 &&
    typeof value.currency === "string" &&
    CURRENCY.test(value.currency)
  );
}

/** A field's name as a fault may carry it. */
const nameOf = (field: string): string =>
  FIELD_NAME.test(field) && !CARD_NUMBER.test(field) ? field : "unnamed";

/** Faults for an object that must hold exactly `fields`: each one missing, and each one v1 does not have. */
function exactFields(path: string, value: Obj, fields: readonly string[], faults: string[]): void {
  for (const field of fields) if (!Object.hasOwn(value, field)) faults.push(`${path}.${field}`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) faults.push(`${path}.${nameOf(field)}`);
}

function stripeId(path: string, value: unknown, faults: string[]): void {
  if (!isStripeId(value)) faults.push(path);
}

function stripeIdOrNull(path: string, value: unknown, faults: string[]): void {
  if (value !== null) stripeId(path, value, faults);
}

function words(path: string, value: unknown, faults: string[], max = Infinity): void {
  if (typeof value !== "string" || !NOT_SPACE.test(value) || lengthOf(value) > max) faults.push(path);
}

function oneOf(path: string, value: unknown, allowed: readonly string[], faults: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) faults.push(path);
}

/** K-14 v1 account; `only` narrows it to businessAccount or rosfieldAccount. */
function account(path: string, value: unknown, faults: string[], only?: "business" | "rosfield"): void {
  if (!isObject(value)) {
    faults.push(path);
    return;
  }
  if (value.kind === "business" && only !== "rosfield") {
    exactFields(path, value, ["kind", "accountId"], faults);
    if (Object.hasOwn(value, "accountId")) stripeId(`${path}.accountId`, value.accountId, faults);
  } else if (value.kind === "rosfield" && only !== "business") {
    exactFields(path, value, ["kind"], faults);
  } else faults.push(`${path}.kind`);
}

/** K-08 v1 approvalOwnerYes: the owner's yes the record goes on (A10-16: "Never: send the record without Sam"). */
function ownerYes(path: string, value: unknown, faults: string[]): void {
  if (!isObject(value)) {
    faults.push(path);
    return;
  }
  exactFields(path, value, OWNER_YES_FIELDS, faults);
  if (value.kind !== "ownerYes") faults.push(`${path}.kind`);
  oneOf(`${path}.role`, value.role, ["owner", "admin"], faults);
  for (const field of ["person_id", "open_question_id", "event_id"])
    if (!isLabel(value[field])) faults.push(`${path}.${field}`);
  if (value.option_id !== null && !isLabel(value.option_id)) faults.push(`${path}.option_id`);
}

/** The faults of a row's portRequest against K-14 v1's `<call>.portRequest`. */
function portFaults(call: StripeEffectCall, port: unknown): string[] {
  if (!isObject(port)) return ["port"];
  const faults: string[] = [];
  exactFields("port", port, PORT_FIELDS[call], faults);
  const bill = port.purpose === "rosfieldMonthlyBill";
  switch (call) {
    case "saveCard":
      account("port.account", port.account, faults);
      stripeIdOrNull("port.customerId", port.customerId, faults);
      break;
    case "charge":
      // Rosfield's monthly bill goes on the bill card on Rosfield's own account, without the owner on a page; a
      // customer's money lands in the business's own account (K-14 charge.portRequest if/then; RULES 3.1; S11-67).
      account("port.account", port.account, faults, bill ? "rosfield" : "business");
      oneOf("port.purpose", port.purpose, PURPOSES, faults);
      stripeId("port.customerId", port.customerId, faults);
      stripeId("port.paymentMethodId", port.paymentMethodId, faults);
      if (typeof port.customerPresent !== "boolean" || (bill && port.customerPresent))
        faults.push("port.customerPresent");
      words("port.description", port.description, faults, 500);
      break;
    case "payLink":
      account("port.account", port.account, faults, bill ? "rosfield" : "business");
      oneOf("port.purpose", port.purpose, PURPOSES, faults);
      if (typeof port.saveCardForLater !== "boolean") faults.push("port.saveCardForLater");
      // A card is saved to a customer, so saving it needs one (K-14 payLink.portRequest dependentSchemas).
      if (port.saveCardForLater === true) stripeId("port.customerId", port.customerId, faults);
      else stripeIdOrNull("port.customerId", port.customerId, faults);
      words("port.description", port.description, faults, 500);
      break;
    case "refund":
      account("port.account", port.account, faults);
      stripeId("port.paymentId", port.paymentId, faults);
      oneOf("port.reason", port.reason, ["duplicate", "requestedByCustomer"], faults);
      break;
    case "disputeEvidence":
      account("port.account", port.account, faults, "business");
      stripeId("port.disputeId", port.disputeId, faults);
      ownerYes("port.ownerYes", port.ownerYes, faults);
      if (typeof port.serviceDate !== "string" || !DATE.test(port.serviceDate))
        faults.push("port.serviceDate");
      words("port.serviceDescription", port.serviceDescription, faults, 500);
      words("port.customerName", port.customerName, faults);
      if (typeof port.recordFileId !== "string" || !ANY_CHAR.test(port.recordFileId))
        faults.push("port.recordFileId");
      break;
  }
  return faults;
}

/**
 * The faults of a row's portRequest against K-14 v1's `<call>.portRequest` (exported for its schema parity test).
 * Empty when the schema takes it.
 */
export function portRequestFaults(call: StripeEffectCall, port: unknown): readonly string[] {
  return [...new Set(portFaults(call, port))];
}

/** The K-14 v1 request a claimed Stripe effect row runs as, built from the row alone, or the fields at fault. */
export function buildStripeRequest(effect: EffectRow): BuildResult {
  const kind: unknown = effect.kind;
  if (!isStripeKind(kind) || effect.port !== "stripe") return { ok: false, faults: ["kind"] };
  const call = CALL_OF[kind];
  const faults: string[] = [];
  // A turn's commit or a job wrote it, never both or neither (K-07 v1 effectRow: K-04 event_log_turn_or_job).
  if ((effect.turnId === null) === (effect.jobId === null)) faults.push("turnId");
  if (!isStripeEffectId(effect.effectId)) faults.push("effect.effectId");
  if (!isStripeKey(effect.idempotencyKey)) faults.push("effect.idempotencyKey");
  const amount: unknown = effect.amount;
  if (AMOUNT_CALLS.includes(call) ? !isStripeAmount(amount) : amount !== null) faults.push("amount");
  const portRequest: unknown = effect.portRequest;
  faults.push(...portFaults(call, portRequest));
  const purpose = isObject(portRequest) ? portRequest.purpose : undefined;
  if (call === "charge" && (kind === "rosfield_monthly_charge") !== (purpose === "rosfieldMonthlyBill"))
    faults.push("port.purpose");
  if (faults.length > 0) return { ok: false, faults: [...new Set(faults)] };

  // Every value is a copy of the row's: the effect id and its one key, its amount, and its portRequest as it stands.
  const ref = { effectId: effect.effectId, idempotencyKey: effect.idempotencyKey };
  const port: unknown = structuredClone(effect.portRequest);
  const money = isStripeAmount(amount) ? { cents: amount.cents, currency: amount.currency } : null;
  switch (call) {
    case "saveCard":
      return { ok: true, built: { call, request: { effect: ref, port: port as SaveCardRequest["port"] } } };
    case "disputeEvidence":
      return {
        ok: true,
        built: { call, request: { effect: ref, port: port as DisputeEvidenceRequest["port"] } },
      };
    case "charge":
    case "payLink":
    case "refund":
      if (money === null) return { ok: false, faults: ["amount"] };
      if (call === "charge")
        return {
          ok: true,
          built: { call, request: { effect: ref, amount: money, port: port as ChargeRequest["port"] } },
        };
      if (call === "payLink")
        return {
          ok: true,
          built: { call, request: { effect: ref, amount: money, port: port as PayLinkRequest["port"] } },
        };
      return {
        ok: true,
        built: { call, request: { effect: ref, amount: money, port: port as RefundRequest["port"] } },
      };
  }
}

/** The error code a refused request is recorded with: a label naming its first field at fault. */
export function refusedCode(faults: readonly string[]): string {
  const first = faults[0];
  const code = first === undefined ? "request_invalid" : `request_invalid:${first}`;
  return isLabel(code) ? code : "request_invalid";
}

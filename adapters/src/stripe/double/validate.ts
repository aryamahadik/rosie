// What the Stripe double refuses (T-422; K-14 v1): a request the contract has no shape for. The checks are the schema's,
// written by hand: the exact field set (so a field v1 does not have, such as a hold's captureMethod, is refused), each
// field's form, and the account and purpose rules. A problem line names the field, never its value (no card data, key or
// name in any message).

type Obj = Record<string, unknown>;

const UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]+)?Z$/;
const CARD_NUMBER = /[0-9]([ -]?[0-9]){12,}/;

const PURPOSES = [
  "deposit",
  "fullPrice",
  "rest",
  "extra",
  "fee",
  "tip",
  "pack",
  "planCharge",
  "rosfieldMonthlyBill",
];

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(path: string, value: Obj, fields: readonly string[], problems: string[]): void {
  for (const field of fields) if (!(field in value)) problems.push(`${path}.${field} is missing`);
  for (const field of Object.keys(value))
    if (!fields.includes(field)) problems.push(`${path}.${field} is not a field of v1`);
}

export function isStripeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !CARD_NUMBER.test(value);
}
export const isUtc = (value: unknown): value is string =>
  typeof value === "string" && UTC.test(value) && !Number.isNaN(Date.parse(value));

function stripeId(path: string, value: unknown, problems: string[]): void {
  if (!isStripeId(value)) problems.push(`${path} is not a Stripe id`);
}
function stripeIdOrNull(path: string, value: unknown, problems: string[]): void {
  if (value !== null) stripeId(path, value, problems);
}
function utc(path: string, value: unknown, problems: string[]): void {
  if (!isUtc(value)) problems.push(`${path} is not a UTC time`);
}
function bool(path: string, value: unknown, problems: string[]): void {
  if (typeof value !== "boolean") problems.push(`${path} is not true or false`);
}
function words(path: string, value: unknown, problems: string[], max = Infinity): void {
  if (typeof value !== "string" || !/\S/.test(value) || value.length > max)
    problems.push(`${path} is not words`);
}
function httpsUrl(path: string, value: unknown, problems: string[]): void {
  if (typeof value !== "string" || !/^https:\/\/\S+$/.test(value))
    problems.push(`${path} is not an https link`);
}
function oneOf(path: string, value: unknown, allowed: readonly string[], problems: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) problems.push(`${path} is not a known value`);
}

export function isEffectId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 500;
}
export function isAmount(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.keys(value).length === 2 &&
    Number.isInteger(value.cents) &&
    (value.cents as number) >= 1 &&
    typeof value.currency === "string" &&
    /^[A-Z]{3}$/.test(value.currency)
  );
}
function amount(path: string, value: unknown, problems: string[]): void {
  if (!isAmount(value)) problems.push(`${path} is not whole cents with a currency`);
}
function effectId(path: string, value: unknown, problems: string[]): void {
  if (!isEffectId(value)) problems.push(`${path} is not an effect id`);
}
function key(path: string, value: unknown, problems: string[]): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 255)
    problems.push(`${path} is not an idempotency key`);
}

function effect(path: string, value: unknown, problems: string[]): void {
  if (!isObject(value)) return void problems.push(`${path} is not an object`);
  exactFields(path, value, ["effectId", "idempotencyKey"], problems);
  effectId(`${path}.effectId`, value.effectId, problems);
  key(`${path}.idempotencyKey`, value.idempotencyKey, problems);
}

function account(path: string, value: unknown, problems: string[]): void {
  if (!isObject(value)) return void problems.push(`${path} is not an object`);
  if (value.kind === "business") {
    exactFields(path, value, ["kind", "accountId"], problems);
    stripeId(`${path}.accountId`, value.accountId, problems);
  } else if (value.kind === "rosfield") {
    exactFields(path, value, ["kind"], problems);
  } else problems.push(`${path}.kind is not business or rosfield`);
}

/** The account rule for a purpose: Rosfield's bill on Rosfield's account, every other purpose on a business's. */
function purposeAccount(path: string, purpose: unknown, acct: unknown, problems: string[]): void {
  if (!isObject(acct)) return;
  if (purpose === "rosfieldMonthlyBill" && acct.kind !== "rosfield")
    problems.push(`${path}: the monthly bill goes only on Rosfield's own account`);
  if (typeof purpose === "string" && purpose !== "rosfieldMonthlyBill" && acct.kind !== "business")
    problems.push(`${path}: a customer's money goes only on a business's account`);
}

type Check = (request: unknown) => string[];

function shaped(fields: readonly string[], body: (request: Obj, problems: string[]) => void): Check {
  return (request) => {
    if (!isObject(request)) return ["the request is not an object"];
    const problems: string[] = [];
    exactFields("request", request, fields, problems);
    if (problems.length > 0) return problems;
    body(request, problems);
    return problems;
  };
}

/** A request with an effect, an optional amount and a port: the exact outer fields, then the port's own. */
function effectCall(
  amountToo: boolean,
  portFields: readonly string[],
  portBody: (port: Obj, problems: string[], request: Obj) => void,
): Check {
  return shaped(amountToo ? ["effect", "amount", "port"] : ["effect", "port"], (request, problems) => {
    effect("request.effect", request.effect, problems);
    if (amountToo) amount("request.amount", request.amount, problems);
    const port = request.port;
    if (!isObject(port)) return void problems.push("request.port is not an object");
    exactFields("request.port", port, portFields, problems);
    if (problems.length > 0) return;
    portBody(port, problems, request);
  });
}

export const onboardingLinkProblems = shaped(
  ["accountId", "businessName", "returnUrl", "refreshUrl", "idempotencyKey"],
  (r, p) => {
    stripeIdOrNull("request.accountId", r.accountId, p);
    words("request.businessName", r.businessName, p);
    httpsUrl("request.returnUrl", r.returnUrl, p);
    httpsUrl("request.refreshUrl", r.refreshUrl, p);
    key("request.idempotencyKey", r.idempotencyKey, p);
  },
);

export const accountStatusProblems = shaped(["accountId"], (r, p) => {
  stripeId("request.accountId", r.accountId, p);
});

export const saveCardProblems = effectCall(false, ["account", "customerId"], (port, p) => {
  account("request.port.account", port.account, p);
  stripeIdOrNull("request.port.customerId", port.customerId, p);
});

export const removeCardProblems = shaped(["account", "customerId", "paymentMethodId"], (r, p) => {
  account("request.account", r.account, p);
  stripeId("request.customerId", r.customerId, p);
  stripeId("request.paymentMethodId", r.paymentMethodId, p);
});

export const chargeProblems = effectCall(
  true,
  ["account", "purpose", "customerId", "paymentMethodId", "customerPresent", "description"],
  (port, p) => {
    account("request.port.account", port.account, p);
    oneOf("request.port.purpose", port.purpose, PURPOSES, p);
    stripeId("request.port.customerId", port.customerId, p);
    stripeId("request.port.paymentMethodId", port.paymentMethodId, p);
    bool("request.port.customerPresent", port.customerPresent, p);
    words("request.port.description", port.description, p, 500);
    purposeAccount("request.port", port.purpose, port.account, p);
    if (port.purpose === "rosfieldMonthlyBill" && port.customerPresent !== false)
      p.push("request.port: the monthly bill is charged without the owner on a page");
  },
);

export const payLinkProblems = effectCall(
  true,
  ["account", "purpose", "customerId", "saveCardForLater", "description"],
  (port, p) => {
    account("request.port.account", port.account, p);
    oneOf("request.port.purpose", port.purpose, PURPOSES, p);
    stripeIdOrNull("request.port.customerId", port.customerId, p);
    bool("request.port.saveCardForLater", port.saveCardForLater, p);
    words("request.port.description", port.description, p, 500);
    purposeAccount("request.port", port.purpose, port.account, p);
    if (port.saveCardForLater === true && port.customerId === null)
      p.push("request.port.customerId: saving a card needs a customer");
  },
);

export const closePayLinkProblems = shaped(["account", "paymentId"], (r, p) => {
  account("request.account", r.account, p);
  stripeId("request.paymentId", r.paymentId, p);
});

export const pageIntentProblems: Check = (request) => {
  if (!isObject(request)) return ["the request is not an object"];
  const problems: string[] = [];
  const idField = "setupId" in request ? "setupId" : "paymentId";
  if ("setupId" in request && "paymentId" in request) return ["request names both a setup and a payment"];
  exactFields("request", request, ["account", idField], problems);
  if (problems.length > 0) return problems;
  account("request.account", request.account, problems);
  stripeId(`request.${idField}`, request[idField], problems);
  return problems;
};

export const savedCardProblems = removeCardProblems;

export const refundProblems = effectCall(true, ["account", "paymentId", "reason"], (port, p) => {
  account("request.port.account", port.account, p);
  stripeId("request.port.paymentId", port.paymentId, p);
  oneOf("request.port.reason", port.reason, ["duplicate", "requestedByCustomer"], p);
});

const OWNER_YES = ["kind", "person_id", "role", "open_question_id", "option_id", "event_id"];

export const disputeEvidenceProblems = effectCall(
  false,
  ["account", "disputeId", "ownerYes", "serviceDate", "serviceDescription", "customerName", "recordFileId"],
  (port, p) => {
    const acct = port.account;
    if (!isObject(acct) || acct.kind !== "business")
      p.push("request.port.account is not a business's account");
    else account("request.port.account", acct, p);
    stripeId("request.port.disputeId", port.disputeId, p);
    const yes = port.ownerYes;
    if (!isObject(yes) || yes.kind !== "ownerYes") p.push("request.port.ownerYes is not the owner's yes");
    else {
      exactFields("request.port.ownerYes", yes, OWNER_YES, p);
      oneOf("request.port.ownerYes.role", yes.role, ["owner", "admin"], p);
      for (const field of ["person_id", "open_question_id", "event_id"])
        if (typeof yes[field] !== "string" || yes[field] === "")
          p.push(`request.port.ownerYes.${field} is not an id`);
      if (yes.option_id !== null && (typeof yes.option_id !== "string" || yes.option_id === ""))
        p.push("request.port.ownerYes.option_id is not an id or null");
    }
    if (typeof port.serviceDate !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(port.serviceDate))
      p.push("request.port.serviceDate is not a date");
    words("request.port.serviceDescription", port.serviceDescription, p, 500);
    words("request.port.customerName", port.customerName, p);
    if (typeof port.recordFileId !== "string" || port.recordFileId === "")
      p.push("request.port.recordFileId is not an id");
  },
);

export const listMoneyProblems: Check = (request) => {
  if (!isObject(request)) return ["the request is not an object"];
  const problems: string[] = [];
  for (const field of ["account", "from", "to"])
    if (!(field in request)) problems.push(`request.${field} is missing`);
  for (const field of Object.keys(request))
    if (!["account", "from", "to", "effectId"].includes(field))
      problems.push(`request.${field} is not a field of v1`);
  if (problems.length > 0) return problems;
  account("request.account", request.account, problems);
  utc("request.from", request.from, problems);
  utc("request.to", request.to, problems);
  if ("effectId" in request) effectId("request.effectId", request.effectId, problems);
  if (isUtc(request.from) && isUtc(request.to) && Date.parse(request.from) >= Date.parse(request.to))
    problems.push("request.from is not before request.to");
  return problems;
};

export const doublePlantProblems = shaped(["account", "plant", "amount", "createdAt", "effectId"], (r, p) => {
  account("request.account", r.account, p);
  oneOf("request.plant", r.plant, ["chargeWithoutEffectId", "secondCharge"], p);
  amount("request.amount", r.amount, p);
  utc("request.createdAt", r.createdAt, p);
  if (r.plant === "secondCharge") effectId("request.effectId", r.effectId, p);
  else if (r.effectId !== null) p.push("request.effectId is not null");
});

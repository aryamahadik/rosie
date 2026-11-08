// The Stripe double (T-422; C-214 Stripe Connect, C-215 Stripe platform billing; K-14 v1; build prompt 3.2 and 9.4).
// Test code only: it makes no network call, reads no key, and logs nothing, so no card detail, client secret or name
// leaves it. It implements every call of the K-14 port, for a business's connected account and for Rosfield's own, in
// Stripe's test-card terms (README 'The double'):
//
//   charge, payLink, saveCard, refund, disputeEvidence   run from an effect row: refused without the effect id or the
//                   key (and with anything K-14 has no field for, a hold included); a repeat on one key within 24 hours
//                   gets the first answer back, a decline or a saved 500 included, and a repeat with other parameters
//                   is refused, as Stripe does (README spike row 7); after 24 hours Stripe may let the key go and the
//                   same key makes a new request, which is how a late run charges twice unless it looks its effect id
//                   up first (listMoney with effectId)
//   onboardingLink, accountStatus, removeCard, closePayLink, pageIntent, savedCard   port calls and reads
//   listMoney       every charge and refund the double made (or planted) between two times, each with its effect id,
//                   amount, state and Stripe id; with effectId, only that effect's (the effects runner's look-up)
//   doublePlant     the reconciliation hooks: a charge with no effect id, a second charge under one effect id
//   events()        the webhook events its own work would send, in the port's terms; webhooks.ts signs them
//
// What the test chooses: a test card's behavior (`seedCard`), a scripted failure for the next call (`failNext`), the
// page's actions (`payOnPage`, `completeSetup`, `completeAuthentication`), and the world's own changes (a card the
// network replaced, a dispute, a failed payout, an account's change). Its ids are placeholders ("...-double-0001").

import type {
  Account,
  AccountState,
  AccountStatusOutcome,
  CallFailure,
  CardBehavior,
  CardSeed,
  CardShown,
  ChargeFailure,
  ChargeOutcome,
  ChargeRequest,
  ClosePayLinkOutcome,
  ClosePayLinkRequest,
  DisputeEvidenceOutcome,
  DisputeEvidenceRequest,
  DoublePlantOutcome,
  DoublePlantRequest,
  EventKind,
  IntentState,
  ListItem,
  ListMoneyOutcome,
  ListMoneyRequest,
  Money,
  OnboardingLinkOutcome,
  OnboardingLinkRequest,
  PageIntentOutcome,
  PageIntentRequest,
  PayLinkOutcome,
  PayLinkRequest,
  RefundOutcome,
  RefundRequest,
  RemoveCardOutcome,
  RemoveCardRequest,
  SaveCardOutcome,
  SaveCardRequest,
  SavedCardOutcome,
  SavedCardRequest,
  ScriptedCall,
  ScriptedFailure,
  WebhookEvent,
} from "./types";
import {
  accountStatusProblems,
  chargeProblems,
  closePayLinkProblems,
  disputeEvidenceProblems,
  doublePlantProblems,
  listMoneyProblems,
  onboardingLinkProblems,
  pageIntentProblems,
  payLinkProblems,
  refundProblems,
  removeCardProblems,
  saveCardProblems,
  savedCardProblems,
} from "./validate";

/** Stripe keeps an idempotency key for at least 24 hours (README spike row 7); the double lets it go at exactly that. */
export const KEY_LIFE_MS = 24 * 60 * 60 * 1000;

/** Stripe's published test payment methods, as the double reads them (README 'The double'; spike row 16). */
export const PUBLISHED_TEST_CARDS: Readonly<Record<string, CardBehavior>> = {
  pm_card_visa: "visa",
  pm_card_visa_chargeDeclined: "chargeDeclined",
  pm_card_visa_chargeDeclinedInsufficientFunds: "insufficientFunds",
  pm_card_chargeDeclinedExpiredCard: "expiredCard",
  pm_card_authenticationRequired: "authenticationRequired",
  pm_card_createDispute: "createDispute",
  pm_card_refundFail: "refundFail",
};

export interface StripeDoubleOptions {
  /** The clock, an RFC 3339 UTC time ending in Z. Default: the real clock, whole seconds. */
  readonly now?: () => string;
}

export interface ScriptOptions {
  /** Only a call on this account takes it. Default: any account. */
  readonly account?: Account;
  /** How many calls take it. Default: 1. */
  readonly times?: number;
}

export interface SeedPayment {
  paymentId: string;
  account: Account;
  amount: Money;
  state: IntentState;
  clientSecret?: string;
  effectId?: string | null;
  customerId?: string | null;
  saveCardForLater?: boolean;
  paymentMethodId?: string | null;
  chargeId?: string;
  createdAt?: string;
}

export interface SeedSetup {
  setupId: string;
  account: Account;
  customerId: string;
  state: IntentState;
  clientSecret?: string;
  effectId?: string | null;
  paymentMethodId?: string | null;
}

export interface SeedDispute {
  disputeId: string;
  account: Account;
  chargeId: string;
  paymentId: string | null;
  amount: Money;
  dueBy: string;
}

export interface PageResult {
  result: "paid" | "declined" | "needsAuthentication";
  paymentMethodId: string;
  events: WebhookEvent[];
}

type Charged = Extract<ChargeOutcome, { result: "charged" }>;

interface Card {
  id: string;
  accountKey: string;
  customerId: string | null;
  card: CardShown;
  behavior: CardBehavior;
  removed: boolean;
}

interface Setup {
  id: string;
  account: Account;
  customerId: string;
  state: IntentState;
  clientSecret: string;
  effectId: string | null;
  paymentMethodId: string | null;
}

interface Payment {
  id: string;
  account: Account;
  amount: Money;
  state: IntentState;
  clientSecret: string;
  effectId: string | null;
  customerId: string | null;
  saveCardForLater: boolean;
  paymentMethodId: string | null;
  chargeId: string | null;
  paidAt: string | null;
}

interface Dispute {
  id: string;
  account: Account;
  chargeId: string;
  paymentId: string | null;
  amount: Money;
  dueBy: string;
  state: "needsResponse" | "submitted" | "closed";
}

interface Listed {
  item: ListItem;
  accountKey: string;
  serial: number;
}

interface Script {
  readonly call: ScriptedCall;
  readonly failure: ScriptedFailure;
  readonly accountKey: string | null;
  remaining: number;
}

interface Stored {
  readonly fingerprint: string;
  readonly outcome: unknown;
  readonly storedAt: number;
}

interface Scope {
  account: Account | null;
  key: string | null;
}

const defaultNow = (): string => new Date().toISOString().replace(/[.][0-9]+Z$/, "Z");

const accountKeyOf = (account: Account): string =>
  account.kind === "rosfield" ? "rosfield" : `business:${account.accountId}`;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, item]) => `${JSON.stringify(name)}:${stable(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function failure(
  kind: "transient" | "refused",
  httpStatus: number | null,
  code: string | null,
  reason: string,
): CallFailure {
  return { result: "failed", kind, httpStatus, code, reason };
}

function chargeFailure(
  kind: "declined" | "transient" | "refused",
  httpStatus: number | null,
  code: string | null,
  declineCode: string | null,
  reason: string,
  paymentId: string | null,
): ChargeFailure {
  return { result: "failed", kind, httpStatus, code, declineCode, reason, paymentId };
}

const DECLINES: Readonly<Record<string, { code: string; declineCode: string }>> = {
  chargeDeclined: { code: "card_declined", declineCode: "generic_decline" },
  insufficientFunds: { code: "card_declined", declineCode: "insufficient_funds" },
  expiredCard: { code: "expired_card", declineCode: "expired_card" },
  authenticationRequired: { code: "authentication_required", declineCode: "authentication_required" },
};

const DEFAULT_ACCOUNT_STATE: AccountState = {
  onboardingFinished: true,
  canTakeCharges: true,
  canPayOut: true,
  infoDue: false,
  infoDueBy: null,
};

/** A decline by a card's behavior or a script; null when the card goes through. */
function declineFor(behavior: CardBehavior): { code: string; declineCode: string } | null {
  return DECLINES[behavior] ?? null;
}

export class StripeDouble {
  readonly #now: () => string;
  #serial = new Map<string, number>();
  #listSerial = 0;
  #requests: { call: ScriptedCall; request: unknown }[] = [];
  #rejected: { call: ScriptedCall; request: unknown; problems: string[] }[] = [];
  #events: WebhookEvent[] = [];
  #keys = new Map<string, Stored>();
  #script: Script[] = [];
  #accounts = new Map<string, AccountState>();
  #disconnected = new Set<string>();
  #cards = new Map<string, Card>();
  #setups = new Map<string, Setup>();
  #payments = new Map<string, Payment>();
  #disputes = new Map<string, Dispute>();
  #listed: Listed[] = [];

  constructor(options: StripeDoubleOptions = {}) {
    this.#now = options.now ?? defaultNow;
  }

  // ---- what the test chooses ----

  /** The next call of this kind (on `account`, if given) fails this way, `times` times. */
  failNext(call: ScriptedCall, choice: ScriptedFailure, options: ScriptOptions = {}): void {
    this.#script.push({
      call,
      failure: choice,
      accountKey: options.account === undefined ? null : accountKeyOf(options.account),
      remaining: options.times ?? 1,
    });
  }

  /** A saved card on a customer, with the test card's behavior (default visa, 4242). */
  seedCard(seed: CardSeed): void {
    const known = PUBLISHED_TEST_CARDS[seed.paymentMethodId];
    this.#cards.set(seed.paymentMethodId, {
      id: seed.paymentMethodId,
      accountKey: accountKeyOf(seed.account),
      customerId: seed.customerId,
      card: seed.card ?? { brand: "visa", last4: "4242" },
      behavior: seed.behavior ?? known ?? "visa",
      removed: false,
    });
  }

  /** A card save in a given state, under the ids a fixture names. */
  seedSetup(seed: SeedSetup): void {
    this.#setups.set(seed.setupId, {
      id: seed.setupId,
      account: seed.account,
      customerId: seed.customerId,
      state: seed.state,
      clientSecret: seed.clientSecret ?? `demo-client-secret-${seed.setupId}`,
      effectId: seed.effectId ?? null,
      paymentMethodId: seed.paymentMethodId ?? null,
    });
  }

  /** A payment in a given state; a succeeded one also lists its charge. */
  seedPayment(seed: SeedPayment): void {
    const payment: Payment = {
      id: seed.paymentId,
      account: seed.account,
      amount: seed.amount,
      state: seed.state,
      clientSecret: seed.clientSecret ?? `demo-client-secret-${seed.paymentId}`,
      effectId: seed.effectId ?? null,
      customerId: seed.customerId ?? null,
      saveCardForLater: seed.saveCardForLater ?? false,
      paymentMethodId: seed.paymentMethodId ?? null,
      chargeId: null,
      paidAt: null,
    };
    this.#payments.set(payment.id, payment);
    if (seed.state === "succeeded") {
      const at = seed.createdAt ?? this.#now();
      payment.chargeId = this.#listCharge(payment, "succeeded", at, seed.chargeId);
      payment.paidAt = at;
    }
  }

  /** A charge or refund exactly as listMoney gives it (a recorded listing's rows). */
  seedListItem(account: Account, item: ListItem): void {
    this.#addListed(structuredClone(item), account);
  }

  /** A dispute waiting for the owner's record. */
  seedDispute(seed: SeedDispute): void {
    this.#disputes.set(seed.disputeId, {
      id: seed.disputeId,
      account: seed.account,
      chargeId: seed.chargeId,
      paymentId: seed.paymentId,
      amount: seed.amount,
      dueBy: seed.dueBy,
      state: "needsResponse",
    });
  }

  /** Sets what an account's status reads (an accountUpdated event follows). */
  setAccountState(accountId: string, state: Partial<AccountState>): void {
    const next = { ...(this.#accounts.get(accountId) ?? DEFAULT_ACCOUNT_STATE), ...state };
    this.#accounts.set(accountId, next);
    this.#emit("accountUpdated", "account.updated", { kind: "business", accountId }, null, { state: next });
  }

  /** The owner disconnects Rosie from their Stripe: later calls on the account are refused (an event follows). */
  disconnectAccount(accountId: string): void {
    this.#disconnected.add(accountId);
    this.#emit(
      "accountDisconnected",
      "account.application.deauthorized",
      { kind: "business", accountId },
      null,
      {},
    );
  }

  /** A payout to the business's bank fails (S11-64). */
  failPayout(accountId: string, amount: Money, failureCode: string | null = "account_closed"): WebhookEvent {
    return this.#emit("payoutFailed", "payout.failed", { kind: "business", accountId }, null, {
      payoutId: this.#id("payout", "stripe-payout-double"),
      amount,
      failureCode,
    });
  }

  /** The card network replaces a saved card in place, under the same id (cardReplaced; README default 17). */
  networkReplaceCard(paymentMethodId: string, card: CardShown): WebhookEvent {
    const saved = this.#cards.get(paymentMethodId);
    if (saved === undefined || saved.customerId === null)
      throw new Error("networkReplaceCard: no saved card has that id");
    saved.card = { ...card };
    return this.#emit(
      "cardReplaced",
      "payment_method.automatically_updated",
      this.#accountOf(saved.accountKey),
      null,
      { paymentMethodId, customerId: saved.customerId, card: { ...card } },
    );
  }

  /** The customer's bank opens a dispute about a charge the double made (Stripe's pm_card_createDispute does it at once). */
  openDispute(chargeId: string): string {
    const found = [...this.#payments.values()].find((payment) => payment.chargeId === chargeId);
    if (found === undefined) throw new Error("openDispute: no charge has that id");
    const dueBy = new Date(Date.parse(this.#now()) + 7 * 24 * 3600 * 1000)
      .toISOString()
      .replace(/[.][0-9]+Z$/, "Z");
    const id = this.#id("dispute", "stripe-dispute-double");
    this.#disputes.set(id, {
      id,
      account: found.account,
      chargeId,
      paymentId: found.id,
      amount: found.amount,
      dueBy,
      state: "needsResponse",
    });
    this.#emit("disputeOpened", "charge.dispute.created", found.account, null, {
      disputeId: id,
      chargeId,
      paymentId: found.id,
      amount: found.amount,
      evidenceDueBy: dueBy,
    });
    return id;
  }

  /** The bank decides a dispute (disputeClosed). */
  closeDispute(disputeId: string, outcome: "businessWon" | "customerWon" | "inquiryClosed"): WebhookEvent {
    const dispute = this.#disputes.get(disputeId);
    if (dispute === undefined) throw new Error("closeDispute: no dispute has that id");
    dispute.state = "closed";
    return this.#emit("disputeClosed", "charge.dispute.closed", dispute.account, null, {
      disputeId,
      chargeId: dispute.chargeId,
      outcome,
    });
  }

  /** The person types a card into the card save's page and Stripe saves it, or refuses it (cardSaved, cardDetails). */
  completeSetup(
    setupId: string,
    options: {
      paymentMethodId?: string;
      card?: CardShown;
      behavior?: CardBehavior;
      refuse?: { code: string; declineCode: string | null };
    } = {},
  ): WebhookEvent[] {
    const setup = this.#setups.get(setupId);
    if (setup === undefined || (setup.state !== "needsCard" && setup.state !== "needsAuthentication"))
      throw new Error("completeSetup: no open card save has that id");
    const before = this.#events.length;
    if (options.refuse !== undefined) {
      this.#emit("cardSaveFailed", "setup_intent.setup_failed", setup.account, setup.effectId, {
        setupId,
        code: options.refuse.code,
        declineCode: options.refuse.declineCode,
      });
      return structuredClone(this.#events.slice(before));
    }
    const id = options.paymentMethodId ?? this.#id("card", "stripe-card-double");
    const behavior = options.behavior ?? "visa";
    this.#cards.set(id, {
      id,
      accountKey: accountKeyOf(setup.account),
      customerId: setup.customerId,
      card: options.card ?? { brand: "visa", last4: "4242" },
      behavior,
      removed: false,
    });
    setup.state = "succeeded";
    setup.paymentMethodId = id;
    this.#emit("cardSaved", "setup_intent.succeeded", setup.account, setup.effectId, {
      setupId,
      customerId: setup.customerId,
      paymentMethodId: id,
    });
    this.#emitCardAttached(id);
    return structuredClone(this.#events.slice(before));
  }

  /**
   * The person pays a pay link on the pay page with a card. With no paymentMethodId a new test card is typed (visa,
   * 4242, or `behavior`'s). A payment that saves its card for later attaches it to the payer's customer (cardDetails).
   */
  payOnPage(
    paymentId: string,
    options: { paymentMethodId?: string; card?: CardShown; behavior?: CardBehavior } = {},
  ): PageResult {
    const payment = this.#payments.get(paymentId);
    if (payment === undefined || (payment.state !== "needsCard" && payment.state !== "needsAuthentication"))
      throw new Error("payOnPage: no open payment has that id");
    const before = this.#events.length;
    let id = options.paymentMethodId;
    if (id === undefined) {
      id = this.#id("card", "stripe-card-double");
      this.#cards.set(id, {
        id,
        accountKey: accountKeyOf(payment.account),
        customerId: null,
        card: options.card ?? { brand: "visa", last4: "4242" },
        behavior: options.behavior ?? "visa",
        removed: false,
      });
    } else if (!this.#cards.has(id)) throw new Error("payOnPage: no card has that id");
    const result = this.#settle(payment, id);
    return { result, paymentMethodId: id, events: structuredClone(this.#events.slice(before)) };
  }

  /** The person confirms a payment with their bank (a charge that answered needsAuthentication), or fails to. */
  completeAuthentication(paymentId: string, succeeds: boolean): WebhookEvent[] {
    const payment = this.#payments.get(paymentId);
    if (payment?.state !== "needsAuthentication" || payment.paymentMethodId === null)
      throw new Error("completeAuthentication: no payment waits for its bank's check under that id");
    const before = this.#events.length;
    if (succeeds) this.#pay(payment, payment.paymentMethodId);
    else
      this.#decline(payment, payment.paymentMethodId, {
        code: "card_declined",
        declineCode: "generic_decline",
      });
    return structuredClone(this.#events.slice(before));
  }

  /** Back to a new double: no record, no script, no card, no key. */
  reset(): void {
    this.#serial.clear();
    this.#listSerial = 0;
    this.#requests = [];
    this.#rejected = [];
    this.#events = [];
    this.#keys.clear();
    this.#script = [];
    this.#accounts.clear();
    this.#disconnected.clear();
    this.#cards.clear();
    this.#setups.clear();
    this.#payments.clear();
    this.#disputes.clear();
    this.#listed = [];
  }

  // ---- what the test reads ----

  /** Every request the double took (one that has a shape in the contract), in order, a repeat on a key included. */
  requests(call?: ScriptedCall): readonly { call: ScriptedCall; request: unknown }[] {
    return structuredClone(
      call === undefined ? this.#requests : this.#requests.filter((r) => r.call === call),
    );
  }

  /** Requests K-14 refuses, in order, with the fields at fault (never their values). */
  rejectedRequests(): readonly { call: ScriptedCall; request: unknown; problems: string[] }[] {
    return structuredClone(this.#rejected);
  }

  /** The webhook events its work sent, in order, in the port's terms. */
  events(): readonly WebhookEvent[] {
    return structuredClone(this.#events);
  }

  // ---- the port's calls ----

  onboardingLink(request: unknown): OnboardingLinkOutcome {
    return this.#run<OnboardingLinkOutcome>(
      "onboardingLink",
      request,
      onboardingLinkProblems,
      (r) => ({ account: null, key: (r as OnboardingLinkRequest).idempotencyKey }),
      (r) => {
        const q = r as OnboardingLinkRequest;
        const created = q.accountId === null;
        const accountId = q.accountId ?? this.#id("account", "stripe-acct-double");
        if (this.#disconnected.has(accountId))
          return failure("refused", 403, "account_invalid", "The account no longer connects to Rosie.");
        const n = this.#id("link", "");
        return {
          result: "link",
          accountId,
          accountCreated: created,
          url: `https://connect.example.com/setup/double-${n}`,
          expiresAt: this.#after(300),
        };
      },
    );
  }

  accountStatus(request: unknown): AccountStatusOutcome {
    return this.#run<AccountStatusOutcome>(
      "accountStatus",
      request,
      accountStatusProblems,
      () => ({ account: null, key: null }),
      (r) => {
        const { accountId } = r as { accountId: string };
        const checkedAt = this.#now();
        if (this.#disconnected.has(accountId)) return { result: "disconnected", accountId, checkedAt };
        return {
          result: "status",
          accountId,
          checkedAt,
          state: { ...(this.#accounts.get(accountId) ?? DEFAULT_ACCOUNT_STATE) },
        };
      },
    );
  }

  saveCard(request: unknown): SaveCardOutcome {
    return this.#run<SaveCardOutcome>(
      "saveCard",
      request,
      saveCardProblems,
      (r) => ({
        account: (r as SaveCardRequest).port.account,
        key: (r as SaveCardRequest).effect.idempotencyKey,
      }),
      (r) => {
        const q = r as SaveCardRequest;
        const customerId = q.port.customerId ?? this.#id("customer", "stripe-customer-double");
        const setupId = this.#id("setup", "stripe-setup-double");
        const clientSecret = `demo-client-secret-setup-${this.#id("secret", "")}`;
        this.#setups.set(setupId, {
          id: setupId,
          account: q.port.account,
          customerId,
          state: "needsCard",
          clientSecret,
          effectId: q.effect.effectId,
          paymentMethodId: null,
        });
        return { result: "ready", setupId, customerId, clientSecret };
      },
    );
  }

  removeCard(request: unknown): RemoveCardOutcome {
    return this.#run<RemoveCardOutcome>(
      "removeCard",
      request,
      removeCardProblems,
      (r) => ({ account: (r as RemoveCardRequest).account, key: null }),
      (r) => {
        const q = r as RemoveCardRequest;
        const saved = this.#cardOf(q.account, q.customerId, q.paymentMethodId);
        if (saved === undefined) return this.#noSuch("PaymentMethod");
        if (saved.removed) return { result: "alreadyRemoved", paymentMethodId: q.paymentMethodId };
        saved.removed = true;
        return { result: "removed", paymentMethodId: q.paymentMethodId };
      },
    );
  }

  charge(request: unknown): ChargeOutcome {
    return this.#run<ChargeOutcome>(
      "charge",
      request,
      chargeProblems,
      (r) => ({
        account: (r as ChargeRequest).port.account,
        key: (r as ChargeRequest).effect.idempotencyKey,
      }),
      (r, forced) => this.#doCharge(r as ChargeRequest, forced),
    );
  }

  payLink(request: unknown): PayLinkOutcome {
    return this.#run<PayLinkOutcome>(
      "payLink",
      request,
      payLinkProblems,
      (r) => ({
        account: (r as PayLinkRequest).port.account,
        key: (r as PayLinkRequest).effect.idempotencyKey,
      }),
      (r) => {
        const q = r as PayLinkRequest;
        const payment = this.#newPayment(q.port.account, q.amount, q.effect.effectId);
        payment.customerId = q.port.customerId;
        payment.saveCardForLater = q.port.saveCardForLater;
        return {
          result: "created",
          paymentId: payment.id,
          clientSecret: payment.clientSecret,
          createdAt: this.#now(),
        };
      },
    );
  }

  closePayLink(request: unknown): ClosePayLinkOutcome {
    return this.#run<ClosePayLinkOutcome>(
      "closePayLink",
      request,
      closePayLinkProblems,
      (r) => ({ account: (r as ClosePayLinkRequest).account, key: null }),
      (r) => {
        const q = r as ClosePayLinkRequest;
        const payment = this.#paymentOf(q.account, q.paymentId);
        if (payment === undefined) return this.#noSuch("PaymentIntent");
        if (payment.state === "succeeded")
          return { result: "alreadyPaid", paymentId: payment.id, paidAt: payment.paidAt };
        if (payment.state === "canceled")
          return { result: "alreadyClosed", paymentId: payment.id, paidAt: null };
        payment.state = "canceled";
        this.#emit("paymentCanceled", "payment_intent.canceled", payment.account, payment.effectId, {
          paymentId: payment.id,
        });
        return { result: "closed", paymentId: payment.id, paidAt: null };
      },
    );
  }

  pageIntent(request: unknown): PageIntentOutcome {
    return this.#run<PageIntentOutcome>(
      "pageIntent",
      request,
      pageIntentProblems,
      (r) => ({ account: (r as PageIntentRequest).account, key: null }),
      (r) => {
        const q = r as PageIntentRequest;
        if ("setupId" in q) {
          const setup = this.#setups.get(q.setupId);
          if (setup === undefined || accountKeyOf(setup.account) !== accountKeyOf(q.account))
            return this.#noSuch("SetupIntent");
          return {
            result: "intent",
            setupId: setup.id,
            state: setup.state,
            clientSecret: this.#secretFor(setup.state, setup.clientSecret),
            card: setup.state === "succeeded" ? this.#shown(setup.paymentMethodId) : null,
          };
        }
        const payment = this.#paymentOf(q.account, q.paymentId);
        if (payment === undefined) return this.#noSuch("PaymentIntent");
        return {
          result: "intent",
          paymentId: payment.id,
          state: payment.state,
          clientSecret: this.#secretFor(payment.state, payment.clientSecret),
          amount: { ...payment.amount },
          card: payment.state === "succeeded" ? this.#shown(payment.paymentMethodId) : null,
        };
      },
    );
  }

  savedCard(request: unknown): SavedCardOutcome {
    return this.#run<SavedCardOutcome>(
      "savedCard",
      request,
      savedCardProblems,
      (r) => ({ account: (r as SavedCardRequest).account, key: null }),
      (r) => {
        const q = r as SavedCardRequest;
        const known = this.#cards.get(q.paymentMethodId);
        if (known?.accountKey !== accountKeyOf(q.account)) return this.#noSuch("PaymentMethod");
        if (known.removed || known.customerId !== q.customerId)
          return { result: "removed", paymentMethodId: q.paymentMethodId };
        return { result: "card", paymentMethodId: q.paymentMethodId, card: { ...known.card } };
      },
    );
  }

  refund(request: unknown): RefundOutcome {
    return this.#run<RefundOutcome>(
      "refund",
      request,
      refundProblems,
      (r) => ({
        account: (r as RefundRequest).port.account,
        key: (r as RefundRequest).effect.idempotencyKey,
      }),
      (r) => this.#doRefund(r as RefundRequest),
    );
  }

  disputeEvidence(request: unknown): DisputeEvidenceOutcome {
    return this.#run<DisputeEvidenceOutcome>(
      "disputeEvidence",
      request,
      disputeEvidenceProblems,
      (r) => ({
        account: (r as DisputeEvidenceRequest).port.account,
        key: (r as DisputeEvidenceRequest).effect.idempotencyKey,
      }),
      (r) => {
        const q = r as DisputeEvidenceRequest;
        const dispute = this.#disputes.get(q.port.disputeId);
        if (dispute === undefined || accountKeyOf(dispute.account) !== accountKeyOf(q.port.account))
          return this.#noSuch("Dispute");
        if (dispute.state !== "needsResponse")
          return failure(
            "refused",
            400,
            "dispute_evidence_already_submitted",
            "The dispute has its evidence.",
          );
        if (Date.parse(this.#now()) > Date.parse(dispute.dueBy))
          return failure("refused", 400, "dispute_evidence_past_due", "The dispute is past its deadline.");
        dispute.state = "submitted";
        return {
          result: "submitted",
          disputeId: dispute.id,
          submittedAt: this.#now(),
          dueBy: dispute.dueBy,
        };
      },
    );
  }

  listMoney(request: unknown): ListMoneyOutcome {
    return this.#run<ListMoneyOutcome>(
      "listMoney",
      request,
      listMoneyProblems,
      (r) => ({ account: (r as ListMoneyRequest).account, key: null }),
      (r) => {
        const q = r as ListMoneyRequest;
        const accountKey = accountKeyOf(q.account);
        const from = Date.parse(q.from);
        const to = Date.parse(q.to);
        const items = this.#listed
          .filter((entry) => entry.accountKey === accountKey)
          .filter((entry) => {
            const at = Date.parse(entry.item.createdAt);
            return at >= from && at < to;
          })
          .filter((entry) => q.effectId === undefined || entry.item.effectId === q.effectId)
          .sort((a, b) => Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt) || a.serial - b.serial)
          .map((entry) => structuredClone(entry.item));
        return { result: "listed", from: q.from, to: q.to, items };
      },
    );
  }

  /** Plants a charge with no effect id, or a second charge under an effect id that has one (reconciliation's hooks). */
  doublePlant(request: unknown): DoublePlantOutcome {
    return this.#run<DoublePlantOutcome>(
      "doublePlant",
      request,
      doublePlantProblems,
      (r) => ({ account: (r as DoublePlantRequest).account, key: null }),
      (r) => {
        const q = r as DoublePlantRequest;
        const payment = this.#newPayment(q.account, q.amount, q.effectId);
        payment.state = "succeeded";
        payment.paidAt = q.createdAt;
        payment.paymentMethodId = null;
        payment.chargeId = this.#listCharge(payment, "succeeded", q.createdAt);
        const planted = this.#listed.find((entry) => entry.item.stripeId === payment.chargeId);
        if (planted === undefined) return failure("refused", 500, null, "The plant was lost.");
        return { result: "planted", item: structuredClone(planted.item) };
      },
    );
  }

  // ---- inside: the common run of a call ----

  #run<O extends { result: string }>(
    call: ScriptedCall,
    request: unknown,
    check: (request: unknown) => string[],
    scope: (request: unknown) => Scope,
    perform: (request: unknown, forced?: { code: string; declineCode: string }) => O,
  ): O {
    const fail = (
      kind: "transient" | "refused",
      httpStatus: number | null,
      code: string | null,
      reason: string,
    ): O => this.#failure(call, kind, httpStatus, code, reason) as unknown as O;
    const problems = check(request);
    if (problems.length > 0) {
      this.#rejected.push({ call, request: structuredClone(request), problems });
      return fail("refused", 400, "parameter_invalid", "The request has no shape in the contract.");
    }
    const req = structuredClone(request);
    this.#requests.push({ call, request: structuredClone(req) });
    const { account, key } = scope(req);
    const scoped = key === null ? null : `${account === null ? "platform" : accountKeyOf(account)}|${key}`;
    const fingerprint = `${call}:${stable(req)}`;

    // A repeat on one key within 24 hours: the first answer, whatever it was; other parameters are refused.
    if (scoped !== null) {
      const stored = this.#keys.get(scoped);
      if (stored !== undefined) {
        if (Date.parse(this.#now()) - stored.storedAt < KEY_LIFE_MS) {
          if (stored.fingerprint !== fingerprint)
            return fail("refused", 400, "idempotency_error", "The key was used with other parameters.");
          return structuredClone(stored.outcome) as O;
        }
        this.#keys.delete(scoped);
      }
    }

    if (account?.kind === "business" && this.#disconnected.has(account.accountId))
      return fail("refused", 403, "account_invalid", "The account no longer connects to Rosie.");

    const keep = (outcome: unknown): void => {
      if (scoped !== null)
        this.#keys.set(scoped, {
          fingerprint,
          outcome: structuredClone(outcome),
          storedAt: Date.parse(this.#now()),
        });
    };

    const scripted = this.#takeScript(call, account);
    if (scripted !== undefined) {
      if (scripted.kind === "declined") {
        const outcome = perform(req, {
          code: scripted.code ?? "card_declined",
          declineCode: scripted.declineCode ?? "generic_decline",
        });
        keep(outcome);
        return structuredClone(outcome);
      }
      if (scripted.kind === "refused") {
        return fail(
          "refused",
          scripted.httpStatus ?? 400,
          scripted.code === undefined ? "invalid_request_error" : scripted.code,
          "The request was refused.",
        );
      }
      const httpStatus = scripted.httpStatus === undefined ? null : scripted.httpStatus;
      const lost = fail(
        "transient",
        httpStatus,
        scripted.code === undefined ? null : scripted.code,
        "A server or network error.",
      );
      if (scripted.answerLost === true) keep(perform(req));
      // Stripe saves a 500 under the key and replays it; a 409, a 429 or no answer at all it does not.
      else if (httpStatus !== null && httpStatus >= 500) keep(lost);
      return lost;
    }

    const outcome = perform(req);
    const saved =
      outcome.result !== "failed" ||
      (outcome as unknown as ChargeFailure).kind === "declined" ||
      ((outcome as unknown as CallFailure).kind === "transient" &&
        ((outcome as unknown as CallFailure).httpStatus ?? 0) >= 500);
    if (saved) keep(outcome);
    return structuredClone(outcome);
  }

  #takeScript(call: ScriptedCall, account: Account | null): ScriptedFailure | undefined {
    const accountKey = account === null ? null : accountKeyOf(account);
    const index = this.#script.findIndex(
      (entry) => entry.call === call && (entry.accountKey === null || entry.accountKey === accountKey),
    );
    const entry = this.#script[index];
    if (entry === undefined) return undefined;
    entry.remaining -= 1;
    if (entry.remaining <= 0) this.#script.splice(index, 1);
    return entry.failure;
  }

  /** A failure in the shape of its call: a charge's carries a decline code and a payment id too. */
  #failure(
    call: ScriptedCall,
    kind: "transient" | "refused",
    httpStatus: number | null,
    code: string | null,
    reason: string,
  ): CallFailure | ChargeFailure {
    return call === "charge"
      ? chargeFailure(kind, httpStatus, code, null, reason, null)
      : failure(kind, httpStatus, code, reason);
  }

  #noSuch(what: string): CallFailure {
    return failure("refused", 404, "resource_missing", `No such ${what}.`);
  }

  // ---- inside: charge, refund and the page ----

  #doCharge(q: ChargeRequest, forced?: { code: string; declineCode: string }): ChargeOutcome {
    const saved = this.#cardOf(q.port.account, q.port.customerId, q.port.paymentMethodId);
    const missing = saved === undefined || saved.removed;
    if (missing && forced === undefined)
      return chargeFailure("refused", 400, "resource_missing", null, "No such PaymentMethod.", null);
    const payment = this.#newPayment(q.port.account, q.amount, q.effect.effectId);
    payment.customerId = q.port.customerId;
    payment.paymentMethodId = q.port.paymentMethodId;
    if (forced !== undefined) return this.#decline(payment, q.port.paymentMethodId, forced);
    if (saved === undefined)
      return chargeFailure("refused", 400, "resource_missing", null, "No such PaymentMethod.", null);
    if (saved.behavior === "authenticationRequired" && q.port.customerPresent) {
      // With the person present, the bank's ask is a check on the page; nothing is charged until it is done.
      payment.state = "needsAuthentication";
      return { result: "needsAuthentication", paymentId: payment.id, clientSecret: payment.clientSecret };
    }
    const decline = declineFor(saved.behavior);
    if (decline !== null) return this.#decline(payment, saved.id, decline);
    return this.#pay(payment, saved.id);
  }

  /** The try failed at the card: a failed charge is listed, the intent waits for another card, and nothing is retried. */
  #decline(
    payment: Payment,
    paymentMethodId: string,
    why: { code: string; declineCode: string },
  ): ChargeFailure {
    payment.state = "needsCard";
    payment.paymentMethodId = paymentMethodId;
    const chargeId = this.#listCharge(payment, "failed", this.#now());
    this.#emit("paymentFailed", "payment_intent.payment_failed", payment.account, payment.effectId, {
      paymentId: payment.id,
      chargeId,
      code: why.code,
      declineCode: why.declineCode,
    });
    return chargeFailure("declined", 402, why.code, why.declineCode, "Your card was declined.", payment.id);
  }

  /** The charge is made: listed, the intent succeeded, and the events a real payment sends. */
  #pay(payment: Payment, paymentMethodId: string): Charged {
    const at = this.#now();
    payment.state = "succeeded";
    payment.paymentMethodId = paymentMethodId;
    payment.paidAt = at;
    payment.chargeId = this.#listCharge(payment, "succeeded", at);
    this.#emit("paymentSucceeded", "payment_intent.succeeded", payment.account, payment.effectId, {
      paymentId: payment.id,
      chargeId: payment.chargeId,
      amount: { ...payment.amount },
      paymentMethodId,
    });
    const saved = this.#cards.get(paymentMethodId);
    if (saved?.behavior === "createDispute") this.openDispute(payment.chargeId);
    return {
      result: "charged",
      paymentId: payment.id,
      chargeId: payment.chargeId,
      card: saved === undefined ? null : { ...saved.card },
      chargedAt: at,
    };
  }

  /** A payer's card on the pay page, by what the card does. */
  #settle(payment: Payment, paymentMethodId: string): "paid" | "declined" | "needsAuthentication" {
    const saved = this.#cards.get(paymentMethodId);
    const behavior = saved?.behavior ?? "visa";
    if (behavior === "authenticationRequired" && payment.state !== "needsAuthentication") {
      payment.state = "needsAuthentication";
      payment.paymentMethodId = paymentMethodId;
      return "needsAuthentication";
    }
    const decline = behavior === "authenticationRequired" ? null : declineFor(behavior);
    if (decline !== null) {
      this.#decline(payment, paymentMethodId, decline);
      return "declined";
    }
    this.#pay(payment, paymentMethodId);
    // A pay link that saves its card: Stripe attaches the paying card to the payer's customer (README spike row 19).
    if (payment.saveCardForLater && payment.customerId !== null && saved !== undefined) {
      saved.customerId = payment.customerId;
      this.#emitCardAttached(paymentMethodId);
    }
    return "paid";
  }

  #doRefund(q: RefundRequest): RefundOutcome {
    const payment = this.#paymentOf(q.port.account, q.port.paymentId);
    if (payment?.state !== "succeeded" || payment.chargeId === null) return this.#noSuch("PaymentIntent");
    if (q.amount.currency !== payment.amount.currency)
      return failure("refused", 400, "parameter_invalid", "The refund's currency is not the payment's.");
    if ([...this.#disputes.values()].some((d) => d.paymentId === payment.id && d.state === "needsResponse"))
      return failure("refused", 400, "charge_disputed", "The payment is under dispute.");
    const chargeId = payment.chargeId;
    const refunded = this.#listed
      .filter(
        (entry) =>
          entry.item.kind === "refund" &&
          entry.item.refundOf === chargeId &&
          entry.item.state !== "failed" &&
          entry.item.state !== "canceled",
      )
      .reduce((sum, entry) => sum + entry.item.amount.cents, 0);
    if (q.amount.cents > payment.amount.cents - refunded)
      return failure(
        "refused",
        400,
        refunded === 0 ? "amount_too_large" : "charge_already_refunded",
        "The refund is more than what is left of the payment.",
      );
    const at = this.#now();
    const refundId = this.#id("refund", "stripe-refund-double");
    const saved = payment.paymentMethodId === null ? undefined : this.#cards.get(payment.paymentMethodId);
    const entry = this.#addListed(
      {
        kind: "refund",
        stripeId: refundId,
        paymentId: payment.id,
        refundOf: chargeId,
        effectId: q.effect.effectId,
        amount: { ...q.amount },
        state: "succeeded",
        createdAt: at,
      },
      q.port.account,
    );
    this.#emit("refundChanged", "refund.created", payment.account, q.effect.effectId, {
      refundId,
      paymentId: payment.id,
      amount: { ...q.amount },
      state: "succeeded",
    });
    if (saved?.behavior === "refundFail") {
      // Stripe's pm_card_refundFail: the refund succeeds, then fails.
      entry.item.state = "failed";
      this.#emit("refundChanged", "refund.failed", payment.account, q.effect.effectId, {
        refundId,
        paymentId: payment.id,
        amount: { ...q.amount },
        state: "failed",
      });
    }
    return { result: "refunded", refundId, paymentId: payment.id, state: "succeeded", refundedAt: at };
  }

  #secretFor(state: IntentState, secret: string): string | null {
    return state === "needsCard" || state === "needsAuthentication" ? secret : null;
  }

  #shown(paymentMethodId: string | null): CardShown | null {
    const saved = paymentMethodId === null ? undefined : this.#cards.get(paymentMethodId);
    return saved === undefined ? null : { ...saved.card };
  }

  // ---- inside: records ----

  #id(kind: string, prefix: string): string {
    const next = (this.#serial.get(kind) ?? 0) + 1;
    this.#serial.set(kind, next);
    const n = String(next).padStart(4, "0");
    return prefix === "" ? n : `${prefix}-${n}`;
  }

  #after(seconds: number): string {
    return new Date(Date.parse(this.#now()) + seconds * 1000).toISOString().replace(/[.][0-9]+Z$/, "Z");
  }

  #accountOf(accountKey: string): Account {
    return accountKey === "rosfield"
      ? { kind: "rosfield" }
      : { kind: "business", accountId: accountKey.slice("business:".length) };
  }

  #cardOf(account: Account, customerId: string, paymentMethodId: string): Card | undefined {
    const saved = this.#cards.get(paymentMethodId);
    if (saved === undefined) return undefined;
    if (saved.accountKey !== accountKeyOf(account) || saved.customerId !== customerId) return undefined;
    return saved;
  }

  #paymentOf(account: Account, paymentId: string): Payment | undefined {
    const payment = this.#payments.get(paymentId);
    return payment !== undefined && accountKeyOf(payment.account) === accountKeyOf(account)
      ? payment
      : undefined;
  }

  #newPayment(account: Account, amount: Money, effectId: string | null): Payment {
    const payment: Payment = {
      id: this.#id("payment", "stripe-payment-double"),
      account,
      amount: { ...amount },
      state: "needsCard",
      clientSecret: `demo-client-secret-pay-${this.#id("secret", "")}`,
      effectId,
      customerId: null,
      saveCardForLater: false,
      paymentMethodId: null,
      chargeId: null,
      paidAt: null,
    };
    this.#payments.set(payment.id, payment);
    return payment;
  }

  #addListed(item: ListItem, account: Account): Listed {
    this.#listSerial += 1;
    const entry: Listed = { item, accountKey: accountKeyOf(account), serial: this.#listSerial };
    this.#listed.push(entry);
    return entry;
  }

  #listCharge(payment: Payment, state: "succeeded" | "failed", createdAt: string, chargeId?: string): string {
    const id = chargeId ?? this.#id("charge", "stripe-charge-double");
    this.#addListed(
      {
        kind: "charge",
        stripeId: id,
        paymentId: payment.id,
        refundOf: null,
        effectId: payment.effectId,
        amount: { ...payment.amount },
        state,
        createdAt,
      },
      payment.account,
    );
    return id;
  }

  /** A saved card's brand and last four, as payment_method.attached carries them (no effect id). */
  #emitCardAttached(paymentMethodId: string): void {
    const saved = this.#cards.get(paymentMethodId);
    if (saved === undefined || saved.customerId === null) return;
    this.#emit("cardDetails", "payment_method.attached", this.#accountOf(saved.accountKey), null, {
      paymentMethodId,
      customerId: saved.customerId,
      card: { ...saved.card },
    });
  }

  #emit(
    kind: EventKind,
    stripeType: string,
    account: Account,
    effectId: string | null,
    payload: Record<string, unknown>,
  ): WebhookEvent {
    const event: WebhookEvent = {
      eventId: this.#id("event", "stripe-evt-double"),
      kind,
      stripeType,
      account,
      testMode: true,
      occurredAt: this.#now(),
      effectId,
      payload,
    };
    this.#events.push(structuredClone(event));
    return structuredClone(event);
  }
}

/** A new Stripe double. */
export function createStripeDouble(options: StripeDoubleOptions = {}): StripeDouble {
  return new StripeDouble(options);
}

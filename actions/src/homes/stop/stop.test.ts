// The stop home (T-590; S13-32 with Master Corrections C1; RULES 7.1 to 7.5), on the frozen K-04 and K-29 seeds as
// T-317's doubles read them, with yeses recorded through T-307's own yes() and STOP and START through T-317's own
// planStopOrStart, and on both flows as the merged bundle emitter compiles them. The card's proofs:
//   - a number given by someone else has no yes;
//   - a team join gives one;
//   - hard invariant: after STOP for business A, the module answers 'no texts' for business B too, until START;
//   - a stop word on a booking never returns a cancel.
// Then the fresh yes on a new booking (C1), the opt-out line on the very first text only (Q-30), the registry's S13-32
// home, and readings the home cannot read, with nothing logged.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { isLabel } from "../../../../runtime/src/trace";
import { ConsentRefusedError, SEND_CLASSES, stateWriteOf } from "../../domain/messages-consent";
import { phoneOf } from "../../domain/messages-consent/test-support";
import { createHomeRegistry, type HomeLogLine, type StepClaim } from "../registry";
import { emittedFlows, objAt, type EmittedFlows } from "../registry/test-support";
import {
  STOP_ANSWERS,
  STOP_POINTS,
  StopHomeError,
  WHOSE_WORDS,
  YES_WAYS,
  mayText,
  numberStop,
  optOutLine,
  readStop,
  stopHome,
  stopRule,
  stopWordEffect,
  textsYes,
  yesCounts,
  type StopHomeContext,
  type StopMessage,
  type StopReading,
  type StopWord,
  type TextDecision,
  type TurnRef,
  type YesGiven,
} from "./index";
import {
  BARBERSHOP,
  MOVERS,
  NUMBERS,
  S13_32_RULES,
  YOGA_STUDIO,
  applied,
  readsOn,
  recordYes,
  seedWorld,
  textWord,
  textYes,
  withPhones,
  type World,
} from "./test-support";

const FLOWS = ["A", "B"] as const;

let flows: EmittedFlows;

// The bundle emitter compiles both master flows here. 120 s is a resource guard for a loaded build Mac
// (vitest.config.ts: a hook's own longer limit wins), not part of any test's claim.
beforeAll(async () => {
  flows = await emittedFlows();
}, 120_000);

let warn: MockInstance;
let log: MockInstance;
let error: MockInstance;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  // Nothing the stop home does writes a log line (K-08: never the raw number or words).
  expect(warn).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

/** A routine message about no booking, sent in no turn of theirs, unless said otherwise. */
function message(over: Partial<StopMessage> = {}): StopMessage {
  return { sendClass: "routine", bookingId: null, turn: null, ...over };
}

/** One person's contact at one business, read through T-307's and T-317's doubles under the scope (null: runtime). */
function readingOf(
  world: World,
  scope: string | null,
  personId: string,
  businessId: string | null,
  handleId: string,
): Promise<StopReading> {
  return readStop(readsOn(world, scope), { personId, businessId, handleId });
}

const TEXTS: TextDecision = { ruling: "texts", why: "yes" };
const STOPPED: TextDecision = { ruling: "noTexts", why: "stopped" };
const NO_YES: TextDecision = { ruling: "noTexts", why: "noYes" };

/** Alex's own turn (K-04 seed handle-alex) and Sam's, the barbershop owner's. */
const ALEX_TURN: TurnRef = { id: "turn-alex-later", handleId: "handle-alex" };
const SAM_TURN: TurnRef = { id: "turn-sam-later", handleId: "handle-sam" };

/**
 * The seeds with Alex's own yes to texts at both businesses he is a customer of (K-04 seed-booking-head: his haircut at
 * the barbershop, his workshop at the yoga studio), each sent by text from his own mobile in his own turn: T-307's yes().
 */
async function alexWithYeses(): Promise<World> {
  const world = seedWorld();
  await recordYes(
    world,
    BARBERSHOP,
    textYes({
      id: "consent-alex-texts-haircut",
      personId: "person-alex",
      handleId: "handle-alex",
      bookingId: "booking-alex-haircut",
      turnId: "turn-alex-haircut-yes",
      at: "2026-10-12T16:20:00Z",
    }),
  );
  await recordYes(
    world,
    YOGA_STUDIO,
    textYes({
      id: "consent-alex-texts-workshop",
      personId: "person-alex",
      handleId: "handle-alex",
      bookingId: "booking-alex-workshop",
      turnId: "turn-alex-workshop-yes",
      at: "2026-10-14T10:00:00Z",
    }),
  );
  return world;
}

/** Alex texts STOP in a barbershop thread on Oct 24 (T-317), after his yeses. */
async function alexStopped(): Promise<World> {
  const world = await alexWithYeses();
  await textWord(world, {
    kind: "stop",
    personId: "person-alex",
    handleId: "handle-alex",
    number: NUMBERS.alex,
    turnId: "turn-alex-stop",
    now: "2026-10-24T09:00:00Z",
    businessId: BARBERSHOP,
  });
  return world;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

describe("the compiled S13-32 holds the lines this home rules by", () => {
  it("both flows' S13-32 hold them word for word (with C1), and the record's stop home is S13-32", () => {
    for (const flow of FLOWS) {
      const lines = stringList(objAt(flows[flow], ["steps", "S13-32"]).more);
      for (const line of S13_32_RULES) expect(lines, `${flow}: ${line}`).toContain(line);
      expect(objAt(flows[flow], ["record", "homes"]).stop).toBe("S13-32");
    }
  });
});

describe("a number given by someone else has no yes (S13-32; RULES 7.1)", () => {
  it("whose word: a brother's or a parent's, a payer's, the person a job is about's, the booker's or an AI's never gives one", () => {
    const someoneElse = WHOSE_WORDS.filter((whose) => whose !== "self" && whose !== "business");
    expect(someoneElse).toEqual(["booker", "family", "payer", "jobSubject", "agent"]);
    for (const whose of someoneElse)
      for (const way of YES_WAYS)
        for (const gaveBusinessTheirNumber of [false, true])
          expect(yesCounts({ way, whose, gaveBusinessTheirNumber }), `${whose} ${way}`).toEqual({
            yes: false,
            why: "someoneElse",
          });
    // Their own word gives one, by each of S13-32's three ways.
    for (const way of YES_WAYS)
      expect(yesCounts({ way, whose: "self", gaveBusinessTheirNumber: false }), way).toEqual({
        yes: true,
        why: "ownWord",
      });
  });

  it("the business's word counts only for someone who gave the business their number for this booking (RULES 2.5)", () => {
    expect(yesCounts({ way: "numberForBooking", whose: "business", gaveBusinessTheirNumber: true })).toEqual({
      yes: true,
      why: "businessForThem",
    });
    expect(yesCounts({ way: "numberForBooking", whose: "business", gaveBusinessTheirNumber: false })).toEqual(
      { yes: false, why: "businessNotForThem" },
    );
    for (const way of ["teamJoin", "forwardedLink"] as const)
      for (const gaveBusinessTheirNumber of [false, true])
        expect(yesCounts({ way, whose: "business", gaveBusinessTheirNumber }), way).toEqual({
          yes: false,
          why: "businessNotThisWay",
        });
  });

  it("Pat's number, which Sam entered for her invite (K-29 seed-chat-link, never answered): no yes, no texts", async () => {
    const world = seedWorld();
    const pat = await readingOf(world, null, "person-pat", BARBERSHOP, "handle-pat");
    expect(pat).toMatchObject({ kind: "phone", own: true, texts: [] });
    expect(textsYes(pat, message())).toEqual({ yes: false, why: "none", consentId: null });
    for (const sendClass of SEND_CLASSES.filter((each) => each !== "safety"))
      expect(mayText(pat, message({ sendClass, turn: SAM_TURN })), sendClass).toEqual(NO_YES);

    // Sam's word for her number is refused where a yes is written (T-307: notFromThem), so none is ever read.
    await expect(
      recordYes(
        world,
        BARBERSHOP,
        textYes({
          id: "consent-pat-on-sams-word",
          personId: "person-pat",
          handleId: "handle-pat",
          bookingId: null,
          turnId: "turn-sam-later",
          at: "2026-10-19T14:41:00Z",
          fromHandleId: "handle-sam",
        }),
      ),
    ).rejects.toMatchObject({ name: "ConsentRefusedError", fault: "notFromThem" });
    const after = await readingOf(world, BARBERSHOP, "person-pat", BARBERSHOP, "handle-pat");
    expect(mayText(after, message())).toEqual(NO_YES);
  });

  it("Maya's number, given by Alex when he books for her: no yes until her own word from her mobile", async () => {
    const world = seedWorld();
    // Alex's word for her number is refused (T-307: notFromThem): it is never a yes of hers.
    await expect(
      recordYes(
        world,
        BARBERSHOP,
        textYes({
          id: "consent-maya-on-alexs-word",
          personId: "person-maya",
          handleId: "handle-maya",
          bookingId: "booking-maya-haircut",
          turnId: "turn-alex-book-maya",
          at: "2026-10-22T10:00:00Z",
          fromHandleId: "handle-alex",
        }),
      ),
    ).rejects.toBeInstanceOf(ConsentRefusedError);
    const maya = await readingOf(world, null, "person-maya", BARBERSHOP, "handle-maya");
    expect(textsYes(maya, message())).toEqual({ yes: false, why: "none", consentId: null });
    expect(mayText(maya, message({ bookingId: "booking-maya-haircut", turn: ALEX_TURN }))).toEqual(NO_YES);

    // Her own text from her mobile, in her own turn, is her own number given (S13-19: the channel they're using) ...
    const mayaTurn: TurnRef = { id: "turn-maya-asks", handleId: "handle-maya" };
    expect(mayText(maya, message({ sendClass: "quick_reply", turn: mayaTurn }))).toEqual({
      ruling: "texts",
      why: "textingIn",
    });
    // ... and the ready text of the link Alex forwarded her, sent from her mobile, is a yes on a forwarded link.
    await recordYes(
      world,
      BARBERSHOP,
      textYes({
        id: "consent-maya-forwarded-link",
        personId: "person-maya",
        handleId: "handle-maya",
        bookingId: "booking-maya-haircut",
        turnId: "turn-maya-ready-text",
        at: "2026-10-22T10:05:00Z",
        chatLinkId: "chatlink-maya-haircut",
      }),
    );
    const own = await readingOf(world, BARBERSHOP, "person-maya", BARBERSHOP, "handle-maya");
    expect(textsYes(own, message())).toEqual({
      yes: true,
      why: "standingYes",
      consentId: "consent-maya-forwarded-link",
    });
    expect(mayText(own, message({ bookingId: "booking-maya-haircut" }))).toEqual(TEXTS);
  });
});

describe("a team join gives one (S13-32; S2-05 under MC C9)", () => {
  it("Avery's invite, answered from her mobile (K-29 seed-chat-link): a yes and texts at the barbershop", async () => {
    const world = seedWorld();
    for (const scope of [null, BARBERSHOP]) {
      const avery = await readingOf(world, scope, "person-avery", BARBERSHOP, "handle-avery");
      expect(textsYes(avery, message()), String(scope)).toEqual({
        yes: true,
        why: "standingYes",
        consentId: "consent-avery-texts-yes",
      });
      for (const sendClass of SEND_CLASSES)
        expect(mayText(avery, message({ sendClass })), `${String(scope)} ${sendClass}`).toMatchObject({
          ruling: "texts",
        });
    }
    // She joined the barbershop's team, not the yoga studio's: no yes there.
    const elsewhere = await readingOf(world, null, "person-avery", YOGA_STUDIO, "handle-avery");
    expect(mayText(elsewhere, message())).toEqual(NO_YES);
  });

  it("Pat's own ready text from her mobile on her invite gives one; the owner's tick alone never does (Q-08)", async () => {
    const world = seedWorld();
    await recordYes(
      world,
      BARBERSHOP,
      textYes({
        id: "consent-pat-joined",
        personId: "person-pat",
        handleId: "handle-pat",
        bookingId: null,
        turnId: "turn-pat-ready-text",
        at: "2026-10-21T15:00:00Z",
        chatLinkId: "chatlink-pat-invite",
      }),
    );
    const pat = await readingOf(world, BARBERSHOP, "person-pat", BARBERSHOP, "handle-pat");
    expect(textsYes(pat, message())).toEqual({
      yes: true,
      why: "standingYes",
      consentId: "consent-pat-joined",
    });
    expect(mayText(pat, message())).toEqual(TEXTS);
    expect(yesCounts({ way: "teamJoin", whose: "self", gaveBusinessTheirNumber: false })).toEqual({
      yes: true,
      why: "ownWord",
    });
    expect(yesCounts({ way: "teamJoin", whose: "business", gaveBusinessTheirNumber: true })).toEqual({
      yes: false,
      why: "businessNotThisWay",
    });
  });
});

describe("Hard invariant: after STOP for business A, the module answers 'no texts' for business B too, until START (MC C1)", () => {
  const BUSINESSES = [BARBERSHOP, YOGA_STUDIO, MOVERS, null] as const;
  const BOOKINGS = [null, "booking-alex-haircut", "booking-alex-workshop"] as const;
  const TURNS = [null, ALEX_TURN, SAM_TURN] as const;

  it("before his STOP, Alex's yes stands at both businesses he gave it to", async () => {
    const world = await alexWithYeses();
    for (const business of [BARBERSHOP, YOGA_STUDIO])
      for (const scope of [null, business]) {
        const alex = await readingOf(world, scope, "person-alex", business, "handle-alex");
        expect(numberStop(alex), business).toEqual({ stopped: false, since: null });
        expect(mayText(alex, message()), `${business} ${String(scope)}`).toEqual(TEXTS);
      }
    const movers = await readingOf(world, null, "person-alex", MOVERS, "handle-alex");
    expect(mayText(movers, message())).toEqual(NO_YES);
  });

  it("his STOP in the barbershop's thread is one row for every business and one flag; no texts anywhere, any class, booking, turn or side", async () => {
    const world = await alexWithYeses();
    const before = world.record.consents.length;
    await textWord(world, {
      kind: "stop",
      personId: "person-alex",
      handleId: "handle-alex",
      number: NUMBERS.alex,
      turnId: "turn-alex-stop",
      now: "2026-10-24T09:00:00Z",
      businessId: BARBERSHOP,
    });
    // One K-29 row with no business, never a row per business (DL-864), and the number's one phones row stopped.
    expect(
      world.record.consents
        .slice(before)
        .map(({ businessId, revoked, handleId, kind }) => ({ businessId, revoked, handleId, kind })),
    ).toEqual([{ businessId: null, revoked: true, handleId: "handle-alex", kind: "texts" }]);
    expect(phoneOf(world.record, "handle-alex")).toMatchObject({ stopped: true, chatOpen: false });

    let count = 0;
    for (const business of BUSINESSES)
      for (const scope of [null, business]) {
        const alex = await readingOf(world, scope, "person-alex", business, "handle-alex");
        expect(numberStop(alex), `${String(business)} ${String(scope)}`).toEqual({
          stopped: true,
          since: new Date("2026-10-24T09:00:00Z"),
        });
        for (const sendClass of SEND_CLASSES.filter((each) => each !== "safety"))
          for (const bookingId of BOOKINGS)
            for (const turn of TURNS) {
              count += 1;
              const at = `${String(business)} ${String(scope)} ${sendClass} ${String(bookingId)} ${turn?.id ?? "none"}`;
              expect(mayText(alex, message({ sendClass, bookingId, turn })), at).toEqual(STOPPED);
              // A safety line and the stop's one reply are never bound by a stop (RULES 4.12, 7.3).
              expect(mayText(alex, message({ sendClass: "safety", bookingId, turn })), at).toEqual({
                ruling: "texts",
                why: "pastStop",
              });
              expect(mayText(alex, message({ sendClass, bookingId, turn, stopReply: true })), at).toEqual({
                ruling: "texts",
                why: "pastStop",
              });
            }
      }
    // 4 businesses (and Rosie's own) x 2 sides x 3 classes x 3 bookings x 3 turns.
    expect(count).toBe(216);
  });

  it("until START: his START turns texts back on where he gave a yes, and makes none where he gave none", async () => {
    const world = await alexStopped();
    await textWord(world, {
      kind: "start",
      personId: "person-alex",
      handleId: "handle-alex",
      number: NUMBERS.alex,
      turnId: "turn-alex-start",
      now: "2026-10-26T09:00:00Z",
      businessId: null,
    });
    expect(phoneOf(world.record, "handle-alex")).toMatchObject({ stopped: false, chatOpen: true });
    for (const business of [BARBERSHOP, YOGA_STUDIO])
      for (const scope of [null, business]) {
        const alex = await readingOf(world, scope, "person-alex", business, "handle-alex");
        expect(numberStop(alex), business).toEqual({ stopped: false, since: null });
        for (const bookingId of BOOKINGS)
          expect(mayText(alex, message({ bookingId })), `${business} ${String(scope)}`).toEqual(TEXTS);
      }
    // The movers never had his yes: START is not one (default 2), though his own text there is answered.
    const movers = await readingOf(world, null, "person-alex", MOVERS, "handle-alex");
    expect(mayText(movers, message())).toEqual(NO_YES);
    expect(mayText(movers, message({ sendClass: "quick_reply", turn: ALEX_TURN }))).toEqual({
      ruling: "texts",
      why: "textingIn",
    });
  });

  it("either the stopped flag or the K-29 STOP row alone reads as stopped (Ben: K-04 seed-phone-stopped, K-29 seed-consent-stop-row)", async () => {
    const world = seedWorld({ benStop: true });
    const since = new Date("2026-10-20T13:00:00Z");
    // The runtime side reads both; a business scope reads the flag alone (K-29 rule 4), and his yes there still shows.
    for (const scope of [null, BARBERSHOP]) {
      const ben = await readingOf(world, scope, "person-ben", BARBERSHOP, "handle-ben");
      expect(numberStop(ben), String(scope)).toEqual({ stopped: true, since });
      expect(mayText(ben, message({ bookingId: "booking-ben-haircut" }))).toEqual(STOPPED);
    }
    const scoped = await readingOf(world, BARBERSHOP, "person-ben", BARBERSHOP, "handle-ben");
    expect(textsYes(scoped, message())).toEqual({
      yes: true,
      why: "standingYes",
      consentId: "consent-ben-texts-yes",
    });
    // The STOP row alone, with the flag clear, still stops every business (default 1: fail closed).
    const ben = phoneOf(world.record, "handle-ben");
    const rowOnly: World = { record: withPhones(world.record, [{ ...ben, stopped: false }]) };
    for (const business of [BARBERSHOP, YOGA_STUDIO, null]) {
      const reading = await readingOf(rowOnly, null, "person-ben", business, "handle-ben");
      expect(numberStop(reading), String(business)).toEqual({ stopped: true, since });
      expect(mayText(reading, message()), String(business)).toEqual(STOPPED);
    }
  });

  it("a fresh yes on a new booking, sent from that number in its own turn, turns on that booking's texts only", async () => {
    const world = await alexStopped();
    const turn: TurnRef = { id: "turn-alex-fresh", handleId: "handle-alex" };
    const fresh = await recordYes(
      world,
      YOGA_STUDIO,
      textYes({
        id: "consent-alex-fresh-yes",
        personId: "person-alex",
        handleId: "handle-alex",
        bookingId: "booking-alex-yoga-new",
        turnId: turn.id,
        at: "2026-10-25T09:00:00Z",
      }),
      { commit: false },
    );
    const yoga = await readStop(readsOn(world, YOGA_STUDIO), {
      personId: "person-alex",
      businessId: YOGA_STUDIO,
      handleId: "handle-alex",
      written: [fresh],
    });
    expect(mayText(yoga, message({ bookingId: "booking-alex-yoga-new", turn }))).toEqual({
      ruling: "texts",
      why: "freshYes",
    });
    // Another booking, no booking, no turn or another turn: still stopped.
    expect(mayText(yoga, message({ bookingId: "booking-alex-workshop", turn }))).toEqual(STOPPED);
    expect(mayText(yoga, message({ bookingId: null, turn }))).toEqual(STOPPED);
    expect(mayText(yoga, message({ bookingId: "booking-alex-yoga-new" }))).toEqual(STOPPED);
    expect(mayText(yoga, message({ bookingId: "booking-alex-yoga-new", turn: ALEX_TURN }))).toEqual(STOPPED);
    // Another business: the yes is the yoga studio's alone.
    const barber = await readStop(readsOn(world, null), {
      personId: "person-alex",
      businessId: BARBERSHOP,
      handleId: "handle-alex",
      written: [fresh],
    });
    expect(mayText(barber, message({ bookingId: "booking-alex-yoga-new", turn }))).toEqual(STOPPED);
    // Once written, a later turn's text about it waits for START (default 3; T-317 default 1).
    world.record = applied(world.record, [stateWriteOf(fresh)]);
    const later = await readingOf(world, null, "person-alex", YOGA_STUDIO, "handle-alex");
    expect(mayText(later, message({ bookingId: "booking-alex-yoga-new", turn: ALEX_TURN }))).toEqual(STOPPED);
    // From that stopped number, a yes on no booking is refused where it is written (T-307: stoppedNumber).
    await expect(
      recordYes(
        world,
        YOGA_STUDIO,
        textYes({
          id: "consent-alex-yes-no-booking",
          personId: "person-alex",
          handleId: "handle-alex",
          bookingId: null,
          turnId: "turn-alex-no-booking",
          at: "2026-10-25T10:00:00Z",
        }),
      ),
    ).rejects.toMatchObject({ name: "ConsentRefusedError", fault: "stoppedNumber" });
  });
});

describe("A stop word on a booking never returns a cancel (RULES 7.3, 7.4; S13-32)", () => {
  it("every stop word: texts stop, the visit is kept (a bare Cancel flags it), a charge for work given stands", () => {
    let count = 0;
    for (const bareCancel of [false, true])
      for (const answers of STOP_ANSWERS)
        for (const inLegalCancelPeriod of [false, true]) {
          count += 1;
          const effect = stopWordEffect({ bareCancel, answers, inLegalCancelPeriod });
          const at = `${String(bareCancel)} ${answers} ${String(inLegalCancelPeriod)}`;
          expect(effect.texts, at).toBe("stop");
          expect(effect.visit, at).toBe(bareCancel ? "flag" : "keep");
          expect(effect.visit, at).not.toBe("cancel");
          expect(effect.chargeForWorkGiven, at).toBe("keep");
        }
    expect(count).toBe(16);
  });

  it("the one case: only the sold work it answers inside its legal cancel period is cancelled, never the visit", () => {
    for (const bareCancel of [false, true])
      for (const answers of STOP_ANSWERS)
        for (const inLegalCancelPeriod of [false, true]) {
          const effect = stopWordEffect({ bareCancel, answers, inLegalCancelPeriod });
          const oneCase =
            inLegalCancelPeriod && (answers === "soldWorkCancelNotice" || answers === "soldWorkText");
          expect(effect, `${String(bareCancel)} ${answers} ${String(inLegalCancelPeriod)}`).toEqual({
            texts: "stop",
            visit: bareCancel ? "flag" : "keep",
            chargeForWorkGiven: "keep",
            soldWork: oneCase ? "cancel" : "keep",
          });
        }
  });

  it("Alex's CANCEL through T-317 flags his booked visits and changes no booking", async () => {
    const world = await alexWithYeses();
    const plan = await textWord(world, {
      kind: "stop",
      personId: "person-alex",
      handleId: "handle-alex",
      number: NUMBERS.alex,
      turnId: "turn-alex-cancel",
      now: "2026-10-24T09:00:00Z",
      businessId: BARBERSHOP,
      alsoCancelVisit: true,
    });
    expect(plan.answer).toMatchObject({
      flaggedBookingIds: ["booking-alex-haircut", "booking-alex-workshop"],
    });
    // The visits are flagged by entries in the event log (booking.flagged); no state write touches a booking.
    expect(new Set(plan.writes.state.map((write) => write.table))).toEqual(new Set(["consents", "phones"]));
    expect(
      plan.writes.stateEvents.filter((entry) => entry.kind === "booking.flagged").map((entry) => entry.rowId),
    ).toEqual(["booking-alex-haircut", "booking-alex-workshop"]);
    expect(world.record.bookings.length).toBeGreaterThan(0);
    for (const head of world.record.bookings) expect(head.stage, head.id).toBe("booked");
    expect(stopWordEffect({ bareCancel: true, answers: "visitText", inLegalCancelPeriod: false }).visit).toBe(
      "flag",
    );
  });
});

describe("the opt-out line goes only in the very first text Rosie ever sends a number (S13-32; Q-30)", () => {
  it("Pat's mobile never got it: carry; Alex's and Ben's did: omit; an email address: omit", async () => {
    const world = seedWorld({ benStop: true });
    expect(optOutLine(await readingOf(world, null, "person-pat", BARBERSHOP, "handle-pat"))).toBe("carry");
    expect(optOutLine(await readingOf(world, null, "person-alex", BARBERSHOP, "handle-alex"))).toBe("omit");
    expect(optOutLine(await readingOf(world, null, "person-ben", BARBERSHOP, "handle-ben"))).toBe("omit");
    expect(optOutLine(await readingOf(world, null, "person-alex", BARBERSHOP, "handle-alex-email"))).toBe(
      "omit",
    );
  });
});

describe("the stop home registers with the home registry as the S13-32 home", () => {
  function registryOn(): {
    lines: HomeLogLine[];
    registry: ReturnType<typeof createHomeRegistry<StopHomeContext>>;
  } {
    const lines: HomeLogLine[] = [];
    const registry = createHomeRegistry<StopHomeContext>({
      flows,
      modules: [stopHome()],
      log: (line) => {
        lines.push(line);
      },
    });
    return { lines, registry };
  }

  it("its entry is S13-32's, built, in actions/src/homes/stop (T-590); S1-02 follows it", () => {
    const { registry } = registryOn();
    expect(registry.entry("stop")).toEqual({
      home: "stop",
      step: "S13-32",
      layer: "actions",
      module: "actions/src/homes/stop",
      task: "T-590",
      via: "homeModule",
      built: true,
    });
    for (const flow of FLOWS) expect(registry.follows(flow, "S1-02")).toContain("stop");
    expect(stopHome().points).toEqual(STOP_POINTS);
  });

  it("S1-02 to Sam, who already got the opt-out line: the step's 'carry' and a stop's 'cancel' get the home's values", async () => {
    const { lines, registry } = registryOn();
    const world = seedWorld();
    const sam = await readingOf(world, null, "person-sam", null, "handle-sam");
    const context: StopHomeContext = {
      stop: {
        reading: sam,
        message: message({ sendClass: "quick_reply", turn: { id: "turn-sam-join", handleId: "handle-sam" } }),
        word: { bareCancel: false, answers: "visitText", inLegalCancelPeriod: false },
      },
    };
    const claims: StepClaim[] = [
      { home: "stop", point: "optOutLine", value: "carry" },
      { home: "stop", point: "stopVisit", value: "cancel" },
    ];
    expect(registry.settle({ flow: "A", step: "S1-02", claims, context })).toEqual({
      run: true,
      flow: "A",
      step: "S1-02",
      rulings: {
        textsYes: "yes",
        mayText: "texts",
        optOutLine: "omit",
        stopVisit: "keep",
        stopSoldWork: "keep",
      },
      differences: [
        {
          flow: "A",
          step: "S1-02",
          home: "stop",
          homeStep: "S13-32",
          point: "optOutLine",
          stepSaid: "carry",
          homeSaid: "omit",
        },
        {
          flow: "A",
          step: "S1-02",
          home: "stop",
          homeStep: "S13-32",
          point: "stopVisit",
          stepSaid: "cancel",
          homeSaid: "keep",
        },
      ],
      own: [],
    });
    expect(lines).toHaveLength(2);
    for (const line of lines)
      for (const value of Object.values(line)) expect(isLabel(value), String(value)).toBe(true);
  });

  it("a step that says it texts a stopped number gets 'noTexts', in both flows", async () => {
    const { registry } = registryOn();
    const world = seedWorld({ benStop: true });
    const ben = await readingOf(world, null, "person-ben", BARBERSHOP, "handle-ben");
    const context: StopHomeContext = {
      stop: { reading: ben, message: message({ bookingId: "booking-ben-haircut" }), word: null },
    };
    const claims: StepClaim[] = [{ home: "stop", point: "mayText", value: "texts" }];
    for (const flow of FLOWS)
      expect(registry.settle({ flow, step: "S1-02", claims, context }), flow).toMatchObject({
        run: true,
        rulings: { mayText: "noTexts", stopVisit: "keep" },
        differences: [{ point: "mayText", stepSaid: "texts", homeSaid: "noTexts" }],
      });
  });

  it("its rule refuses a point that is not its own and a context with no stop reading", async () => {
    const world = seedWorld();
    const reading = await readingOf(world, null, "person-alex", BARBERSHOP, "handle-alex");
    const context: StopHomeContext = { stop: { reading, message: message(), word: null } };
    expect(() => stopRule("reachWay", context)).toThrow(StopHomeError);
    expect(() => stopRule("mayText", {} as StopHomeContext)).toThrow("no stop reading");
  });
});

describe("a contact or a reading the home cannot text or read fails closed, naming no value", () => {
  it("an email address, a contact that is not theirs and a handle not on file get no texts", async () => {
    const world = seedWorld();
    const email = await readingOf(world, null, "person-alex", BARBERSHOP, "handle-alex-email");
    expect(email).toMatchObject({ kind: "email", own: true, phone: null });
    expect(mayText(email, message({ sendClass: "safety" }))).toEqual({
      ruling: "noTexts",
      why: "notAMobile",
    });
    const notHis = await readingOf(world, null, "person-alex", BARBERSHOP, "handle-sam");
    expect(mayText(notHis, message({ turn: SAM_TURN }))).toEqual({ ruling: "noTexts", why: "notTheirs" });
    const unknown = await readingOf(world, null, "person-alex", BARBERSHOP, "handle-nobody");
    expect(mayText(unknown, message())).toEqual({ ruling: "noTexts", why: "notAMobile" });
  });

  it("a malformed reading, message, word or yes is refused with StopHomeError", async () => {
    const world = seedWorld();
    const alex = await readingOf(world, null, "person-alex", BARBERSHOP, "handle-alex");
    const samPhone = phoneOf(world.record, "handle-sam");
    const undatedRow = {
      id: "consent-alex-undated",
      personId: "person-alex",
      businessId: BARBERSHOP,
      kind: "texts",
      revoked: false,
      handleId: "handle-alex",
      bookingId: null,
      at: "2026-10-12",
      channel: "text",
      turnId: null,
    };
    const otherPhone = { ...alex, phone: { ...samPhone } } as unknown as StopReading;
    const bad = [
      { ...alex, personId: "" },
      otherPhone,
      { ...alex, texts: [undatedRow] },
      { ...alex, kind: "fax" },
    ] as unknown as StopReading[];
    for (const reading of bad) expect(() => mayText(reading, message())).toThrow(StopHomeError);
    const badMessage = { ...message(), sendClass: "marketing" } as unknown as StopMessage;
    expect(() => mayText(alex, badMessage)).toThrow(StopHomeError);
    const badWord = {
      bareCancel: false,
      answers: "refund",
      inLegalCancelPeriod: false,
    } as unknown as StopWord;
    expect(() => stopWordEffect(badWord)).toThrow(StopHomeError);
    const badYes = {
      way: "teamJoin",
      whose: "neighbour",
      gaveBusinessTheirNumber: false,
    } as unknown as YesGiven;
    expect(() => yesCounts(badYes)).toThrow(StopHomeError);
    await expect(
      readStop(readsOn(world, null), { personId: "", businessId: BARBERSHOP, handleId: "handle-alex" }),
    ).rejects.toBeInstanceOf(StopHomeError);

    // The error names the fault, never the phones row's number.
    const thrown = ((): unknown => {
      try {
        return mayText(otherPhone, message());
      } catch (caught) {
        return caught;
      }
    })();
    expect(thrown).toBeInstanceOf(StopHomeError);
    expect((thrown as StopHomeError).message).toBe("the phones row read is not the contact's");
    expect((thrown as StopHomeError).message).not.toContain(NUMBERS.sam);
  });
});

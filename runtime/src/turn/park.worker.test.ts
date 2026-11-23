// The park's request and its line (T-1552; T-1529's ruling cards 6 and 7; K-05 v1.23 item 84 and defaults 216 to 224;
// K-09 v1.13 default 218), run inside the Workers runtime against fixture fakes (./test-support.ts): ./park.ts builds
// K-05 v1.23's parkTurn.lineRequest for a turn parked at once on a final answer (park-turn-sam-refused-at-once.json) and
// for one parked after a third crash (park-turn-maya-crash-with-line.json), sends it through the turn's K-05 face (the
// double holds it to item 84's checks, as db/repo/park.ts does) and wakes the dispatcher once for its row. Test values
// only: the master's sample cast and the fixtures' ids, phones in the fictional 555-01xx range (rule 9).
import { beforeAll, describe, expect, it } from "vitest";

import fixedLines from "../../../contracts/bundle/fixtures/fixed-lines.json";
import parkTurnMayaCrash from "../../../contracts/data-access/fixtures/park-turn-maya-crash-with-line.json";
import parkTurnSamRefused from "../../../contracts/data-access/fixtures/park-turn-sam-refused-at-once.json";
import parkTurn from "../../../contracts/data-access/fixtures/park-turn.json";
import commitRefused from "../../../contracts/tool-api/fixtures/commit-s1-02-refused-step-not-in-bundle.json";
import type { ParkingTurn } from "../actor";
import { WHOLE_A } from "../bundle/test-support";
import type { HandleRef, SealingKeyStore } from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { openTrace, spanProblems, type BundleId, type Span } from "../trace";
import {
  PASSED_ON,
  PASSED_ON_LINE,
  keepKeywords,
  parkAtOnce,
  parkedEventId,
  parkedRowId,
  parkRequestOf,
  parkThroughRows,
  PARK_SENDS,
  unwordedRequestOf,
} from "./park";
import {
  MAYA,
  SAM,
  checkedManifest,
  checkParkRequest,
  fakeDecide,
  fakeFacts,
  fakeReply,
  fakeTurnFace,
  storedText,
  turnDeps,
  type FakeReply,
} from "./test-support";
import type {
  ParkReason,
  ParkTurnLineRequest,
  ParkTurnRequest,
  ParkTurnV1Request,
  TurnDeps,
  TurnParty,
} from "./types";

const keys = fakeKeyStore();

const SAM_FIXTURE = parkTurnSamRefused.request;
const MAYA_FIXTURE = parkTurnMayaCrash.request;
/** The bundle both K-05 v1.23 fixtures' turns are pinned to. */
const BUNDLE: BundleId = SAM_FIXTURE.turn.bundleId;
/** The refusal K-09 v1.13's commit-s1-02-refused-step-not-in-bundle.json answers: walk, stepNotInBundle, S1-04. */
const REFUSED: ParkReason = {
  from: commitRefused.outcome.from,
  fault: commitRefused.outcome.fault,
  ids: [...commitRefused.outcome.ids],
};

/**
 * The fixtures' bundle's keyword list, kept as a run of a turn pinned to it keeps it (./turn.ts `keepPinnedKeywords`), so
 * the crash park reads these turns' texts for a stop word as the guard reads them (K-09 v1.13 default 218).
 */
beforeAll(async () => {
  keepKeywords(BUNDLE, await checkedManifest(WHOLE_A, BUNDLE));
});

interface Parking {
  readonly turn: ParkingTurn;
  readonly spans: Span[];
}

/**
 * A turn as the park is handed it: the fixture's ids, its texts sealed as the inbox keeps them (one of test words unless
 * `bodies` names them, the first under `eventId`), pinned to `bundleId` (the fixtures' bundle unless named), a trace of its
 * own.
 */
async function parking(spec: {
  turnId: string;
  eventId: string;
  traceId: string;
  tries: number;
  handle: HandleRef;
  bodies?: readonly string[];
  bundleId?: BundleId;
}): Promise<Parking> {
  const bundleId = spec.bundleId ?? BUNDLE;
  const spans: Span[] = [];
  let clock = Date.parse("2026-11-22T15:00:00Z");
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId,
    sink: (span) => spans.push(span),
    now: () => (clock += 7),
  });
  trace.setTurn(spec.turnId);
  const bodies = spec.bodies ?? ["Test words: Barbershop, plumbing, electrical"];
  const entries = await Promise.all(
    bodies.map((body, index) =>
      storedText(
        {
          eventId: index === 0 ? spec.eventId : `${spec.eventId}-${String(index + 1)}`,
          body,
          sentAt: "2026-11-22T15:00:00Z",
          traceId: spec.traceId,
        },
        spec.handle,
        keys,
        bundleId,
        index + 1,
      ),
    ),
  );
  return {
    turn: {
      turnId: spec.turnId,
      eventIds: entries.map((entry) => entry.event.eventId),
      entries,
      traceId: spec.traceId,
      joinedTraceIds: [],
      tries: spec.tries,
      bundleId,
      trace,
    },
    spans,
  };
}

/** Sam's turn of park-turn-sam-refused-at-once.json, on the given try. */
const samParking = (tries = SAM_FIXTURE.turn.tries): Promise<Parking> =>
  parking({
    turnId: SAM_FIXTURE.turn.id,
    eventId: SAM_FIXTURE.turn.eventIds[0] ?? "evt-sam-0009",
    traceId: SAM_FIXTURE.turn.traceId,
    tries,
    handle: SAM.handle,
  });

/** Maya's turn of park-turn-maya-crash-with-line.json, on the given try (its texts `bodies`, or one of test words). */
const mayaParking = (
  tries = MAYA_FIXTURE.turn.tries,
  more: { bodies?: readonly string[]; bundleId?: BundleId } = {},
): Promise<Parking> =>
  parking({
    turnId: MAYA_FIXTURE.turn.id,
    eventId: MAYA_FIXTURE.turn.eventIds[0] ?? "evt-maya-0005",
    traceId: MAYA_FIXTURE.turn.traceId,
    tries,
    handle: MAYA.handle,
    ...more,
  });

/**
 * The turn's ports over the doubles: the directory answers `party`, the clock the fixture's park time, and the key store
 * the texts were sealed with (or `opener`, another one).
 */
function depsOf(
  party: TurnParty | null,
  parkedAt: string,
  opener: SealingKeyStore = keys,
): { set: TurnDeps; reply: FakeReply } {
  const face = fakeTurnFace();
  const reply = fakeReply(face.log);
  return { set: turnDeps(fakeFacts(party, [parkedAt]), face, fakeDecide(face.log), opener, reply), reply };
}

/** The request K-05 was sent, in v1.23's form (the runtime sends no other). */
const lineRequest = (request: ParkTurnRequest | undefined): ParkTurnLineRequest => {
  if (request === undefined) throw new Error("no park was sent");
  return request as ParkTurnLineRequest;
};

describe("the park's request: K-05 v1.23's parkTurn.lineRequest, field for field", () => {
  it("a final answer on try 1 gives park-turn-sam-refused-at-once.json's request: the reason's labels, the passedOn line's row to the turn's own handle, one turn.parked entry whose why holds the same labels", async () => {
    const { turn } = await samParking();

    const request = parkRequestOf(turn, SAM.party, SAM.handle, SAM_FIXTURE.parkedAt, REFUSED);

    expect(request).toEqual(SAM_FIXTURE);
    expect(request.reason).toEqual(SAM_FIXTURE.reason);
    expect(request.events[0]?.why).toEqual({ refused: REFUSED });
    expect(() => {
      checkParkRequest(request);
    }).not.toThrow();
  });

  it("a crash after the third try gives park-turn-maya-crash-with-line.json's request: tries 3, no reason, v1's outage why, the same line", async () => {
    const { turn } = await mayaParking();

    const request = parkRequestOf(turn, MAYA.party, MAYA.handle, MAYA_FIXTURE.parkedAt, null);

    expect(request).toEqual(MAYA_FIXTURE);
    expect("reason" in request).toBe(false);
    expect(request.events[0]?.why).toEqual({ outage: "third crash before the commit" });
    expect(() => {
      checkParkRequest(request);
    }).not.toThrow();
  });

  it("the row's words are K-01's passedOn fixed line, word for word, and only the row's id and channel vary: an email handle's row goes by email to that handle", async () => {
    const passedOn = fixedLines.lines.find((line) => line.id === PASSED_ON);
    expect(passedOn?.text).toBe(PASSED_ON_LINE);
    expect(SAM_FIXTURE.outboxRows[0]?.finalParts.sends[0]?.text).toBe(PASSED_ON_LINE);

    const email: HandleRef = { kind: "email", address: "sam@rosfield.invalid" };
    const { turn } = await samParking(1);
    const request = parkRequestOf(turn, SAM.party, email, SAM_FIXTURE.parkedAt, REFUSED);
    const row = request.outboxRows[0];

    const fixtureRow = SAM_FIXTURE.outboxRows[0];
    expect(row).toEqual({
      ...fixtureRow,
      channel: "email",
      plan: { ...fixtureRow?.plan, channel: "email" },
      finalParts: { ...fixtureRow?.finalParts, channel: "email" },
    });
    expect(row.recipientHandleId).toBe(request.turn.handleId);
    // Never the address, never the turn's words: the line alone.
    expect(JSON.stringify(request)).not.toContain(email.address);
    expect(JSON.stringify(request)).not.toContain("Barbershop, plumbing");
  });
});

describe("the park at once (K-09 v1.13 default 218) and the crash park (card 7)", () => {
  it("parks on the try the lease counted, 1, 2 or 3, with one request to the turn's own handle, wakes the dispatcher once for its row, and its lease span holds labels only", async () => {
    for (const tries of [1, 2, 3]) {
      const { turn, spans } = await samParking(tries);
      const { set, reply } = depsOf(SAM.party, SAM_FIXTURE.parkedAt);

      const answer = await parkAtOnce(set, turn, REFUSED);

      expect(answer, String(tries)).toEqual({
        result: "parked",
        parkedAt: SAM_FIXTURE.parkedAt,
        repeated: false,
      });
      const request = lineRequest(reply.rows.parks[0]);
      expect(reply.rows.parks, String(tries)).toHaveLength(1);
      expect(request, String(tries)).toEqual({
        ...SAM_FIXTURE,
        turn: { ...SAM_FIXTURE.turn, tries },
        events: SAM_FIXTURE.events.map((entry) => ({ ...entry, newValues: { state: "parked", tries } })),
      });
      expect(reply.dispatcher.wakes, String(tries)).toEqual([
        {
          turnId: SAM_FIXTURE.turn.id,
          handleId: SAM.party.handleId,
          outboxRowIds: [parkedRowId(SAM_FIXTURE.turn.id)],
        },
      ]);

      expect(
        spans.map((span) => span.hop),
        String(tries),
      ).toEqual(["lease"]);
      const [span] = spans;
      expect(spanProblems(span), String(tries)).toEqual([]);
      expect(span?.outcome).toBe("ok");
      expect(span?.got).toEqual({ texts: 1, tries });
      expect(span?.decided).toEqual({
        parked: true,
        atOnce: true,
        from: "walk",
        fault: "stepNotInBundle",
        ids: ["S1-04"],
        repeated: false,
        woken: true,
        sends: 1,
      });
      expect(span?.rows).toEqual([
        { table: "turns", id: SAM_FIXTURE.turn.id },
        { table: "outbox_rows", id: parkedRowId(SAM_FIXTURE.turn.id) },
      ]);
      // Never the line's words, the turn's words or the number in a span.
      const logged = JSON.stringify(spans);
      for (const words of [PASSED_ON_LINE, "passed this on", "Barbershop, plumbing", SAM.handle.address]) {
        expect(logged).not.toContain(words);
      }
    }
  });

  it("the lease's crash park parks on try 3 alone, with no reason, v1's outage why and the same line; a final answer's park refuses a try outside 1 to 3; neither sends anything then", async () => {
    const crashed = await mayaParking(3);
    const crash = depsOf(MAYA.party, MAYA_FIXTURE.parkedAt);
    expect(await parkThroughRows(crash.set, crashed.turn)).toEqual({
      result: "parked",
      parkedAt: MAYA_FIXTURE.parkedAt,
      repeated: false,
    });
    expect(crash.reply.rows.parks).toEqual([MAYA_FIXTURE]);
    expect(crashed.spans[0]?.decided).toMatchObject({ parked: true, atOnce: false });
    expect(crashed.spans[0]?.decided).not.toHaveProperty("from");

    const early = await mayaParking(2);
    const notYet = depsOf(MAYA.party, MAYA_FIXTURE.parkedAt);
    expect(await parkThroughRows(notYet.set, early.turn)).toEqual({ error: "notThirdTry" });
    expect(notYet.reply.rows.parks).toEqual([]);

    const fourth = await samParking(4);
    const beyond = depsOf(SAM.party, SAM_FIXTURE.parkedAt);
    expect(await parkAtOnce(beyond.set, fourth.turn, REFUSED)).toEqual({ error: "badTry" });
    expect(beyond.reply.rows.parks).toEqual([]);
    expect(beyond.reply.dispatcher.wakes).toEqual([]);
  });

  it("a park sent again (a rerun meeting the same final answer) is K-05's repeat: the same request, nothing written twice, the dispatcher woken again for the one row", async () => {
    const { turn } = await samParking();
    const { set, reply } = depsOf(SAM.party, SAM_FIXTURE.parkedAt);

    const first = await parkAtOnce(set, turn, REFUSED);
    const again = await parkAtOnce(set, turn, REFUSED);

    expect(first).toMatchObject({ result: "parked", repeated: false });
    expect(again).toMatchObject({ result: "parked", repeated: true });
    expect(reply.rows.parks).toHaveLength(2);
    expect(reply.rows.parks[1]).toEqual(reply.rows.parks[0]);
    const row = parkedRowId(SAM_FIXTURE.turn.id);
    expect(reply.dispatcher.wakes.map((wake) => wake.outboxRowIds)).toEqual([[row], [row]]);
    expect(parkedEventId(SAM_FIXTURE.turn.id)).toBe(SAM_FIXTURE.events[0]?.id);
  });

  it("K-05 answering transient, or an answer lost, is sent once more as the same request; still not done, the park says why and wakes no one", async () => {
    const { turn } = await samParking();
    const { set, reply } = depsOf(SAM.party, SAM_FIXTURE.parkedAt);
    reply.rows.park = () => ({ error: "transient", sqlstate: "40001" });

    expect(await parkAtOnce(set, turn, REFUSED)).toEqual({ error: "transient" });
    expect(reply.rows.parks).toHaveLength(PARK_SENDS);
    expect(reply.rows.parks[1]).toEqual(reply.rows.parks[0]);
    expect(reply.dispatcher.wakes).toEqual([]);

    const lost = depsOf(SAM.party, SAM_FIXTURE.parkedAt);
    lost.reply.rows.park = () => {
      throw new Error("the answer was lost");
    };
    expect(await parkAtOnce(lost.set, (await samParking()).turn, REFUSED)).toEqual({ error: "noAnswer" });
    expect(lost.reply.rows.parks).toHaveLength(PARK_SENDS);
  });

  it("no ports, or a handle the directory does not know, parks nothing", async () => {
    const { turn } = await samParking();
    expect(await parkAtOnce(null, turn, REFUSED)).toEqual({ error: "unwired" });
    const unknown = depsOf(null, SAM_FIXTURE.parkedAt);
    expect(await parkAtOnce(unknown.set, turn, REFUSED)).toEqual({ error: "unknownHandle" });
    expect(unknown.reply.rows.parks).toEqual([]);
  });
});

describe("the crash park never writes the passedOn line to a number whose STOP is in the turn (K-09 v1.13 default 218: card 7 keeps the rule for a turn whose STOP never committed; DL-1211)", () => {
  /** A row with its plan and final parts left out: v1's outboxRowNew (park-turn.json's row). */
  const withoutWords = (row: object): Record<string, unknown> =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== "plan" && key !== "finalParts"));

  /**
   * park-turn-maya-crash-with-line.json's request in v1's form (K-05 item 12, park-turn.json's, which v1.23's item 84 still
   * takes byte for byte) for this parking turn: tries 3, no reason, its one row to Maya's own handle with no plan and no
   * final parts, its entry's why v1's outage path.
   */
  function unwordedFor(turn: ParkingTurn): ParkTurnV1Request {
    const [row] = MAYA_FIXTURE.outboxRows;
    return {
      turn: {
        ...MAYA_FIXTURE.turn,
        eventIds: [...turn.eventIds],
        bundleId: { hash: turn.bundleId.hash, build: turn.bundleId.build },
      },
      parkedAt: MAYA_FIXTURE.parkedAt,
      outboxRows: [withoutWords(row ?? {}) as never],
      events: structuredClone(MAYA_FIXTURE.events) as never,
    };
  }

  /** Parks the turn as the lease's crash park does, and checks it went in v1's form, with no words anywhere. */
  async function parkedUnworded(
    parked: Parking,
    opener: SealingKeyStore = keys,
  ): Promise<{ request: ParkTurnRequest; reply: FakeReply }> {
    const { set, reply } = depsOf(MAYA.party, MAYA_FIXTURE.parkedAt, opener);
    const answer = await parkThroughRows(set, parked.turn);
    expect(answer).toEqual({ result: "parked", parkedAt: MAYA_FIXTURE.parkedAt, repeated: false });
    expect(reply.rows.parks).toHaveLength(1);
    const [request] = reply.rows.parks;
    if (request === undefined) throw new Error("no park was sent");
    expect(request).toEqual(unwordedFor(parked.turn));
    // v1's form, as park-turn.json writes it: no reason, and the row's fields v1's alone.
    expect("reason" in request).toBe(false);
    expect(Object.keys(request.outboxRows[0] ?? {}).sort()).toEqual(
      Object.keys(parkTurn.request.outboxRows[0] ?? {}).sort(),
    );
    expect(() => {
      checkParkRequest(request);
    }).not.toThrow();
    // No line: neither the passedOn line nor any word is in the request.
    const sent = JSON.stringify(request);
    for (const words of [PASSED_ON_LINE, "passed this on", PASSED_ON, "STOP", "Stop"]) {
      expect(sent).not.toContain(words);
    }
    // The dispatcher is woken for the parked row, as v1's park woke it: K-05's claim passes an unworded row (default 183).
    expect(reply.dispatcher.wakes).toEqual([
      {
        turnId: MAYA_FIXTURE.turn.id,
        handleId: MAYA.party.handleId,
        outboxRowIds: [parkedRowId(MAYA_FIXTURE.turn.id)],
      },
    ]);
    const [span] = parked.spans;
    expect(spanProblems(span)).toEqual([]);
    expect(span?.decided).toEqual({
      parked: true,
      atOnce: false,
      line: false,
      repeated: false,
      woken: true,
      sends: 1,
    });
    return { request, reply };
  }

  it("a crash park on try 3 of a turn holding STOP writes no line: v1's unworded form, no reason, v1's outage why, its row to the turn's own handle with no words; a stop word beside other texts, in another case or another opt-out word, is the same", async () => {
    const turns = [
      ["STOP"],
      ["Test words: can I move to the 6pm class?", "Stop!"],
      ["Test words: can I move to the 6pm class?", " para "],
      ["opt  out", "Test words: and can my friend come too?"],
    ];
    for (const bodies of turns) {
      const parked = await mayaParking(3, { bodies });
      const { request } = await parkedUnworded(parked);
      expect(request.turn.eventIds, bodies.join("|")).toHaveLength(bodies.length);
      // Never the turn's words in a span.
      const logged = JSON.stringify(parked.spans);
      for (const body of bodies) expect(logged, body).not.toContain(body.trim());
    }
  });

  it("a crash park on try 3 of a turn that may hold a stop word (unsure counts as a stop: RULES 7.2) writes no line either: no keyword list kept for the bundle the turn was pinned to, a box that does not open with the handle's key, or a text of the turn missing from its entries", async () => {
    // No list kept in this isolate for the turn's bundle (no run of it was pinned here).
    const unknownBundle: BundleId = { hash: "0".repeat(64), build: 7 };
    await parkedUnworded(await mayaParking(3, { bundleId: unknownBundle }));

    // The box does not open: the key store answers another key for the handle.
    await parkedUnworded(await mayaParking(3), fakeKeyStore());

    // A text of the turn is not among the entries the lease read back.
    const missing = await mayaParking(3);
    await parkedUnworded({
      ...missing,
      turn: { ...missing.turn, eventIds: [...missing.turn.eventIds, "evt-maya-0006"] },
    });
  });

  it("a crash park on try 3 of a turn whose texts were read and hold no stop word still gets the passedOn row (park-turn-maya-crash-with-line.json), and its span says the row carries the line; unwordedRequestOf is that request with its row's words left out", async () => {
    const parked = await mayaParking(3, {
      bodies: ["Test words: can I move to the 6pm class?", "HELP", "START", "Test words: stopping by at 6"],
    });
    const { set, reply } = depsOf(MAYA.party, MAYA_FIXTURE.parkedAt);

    expect(await parkThroughRows(set, parked.turn)).toEqual({
      result: "parked",
      parkedAt: MAYA_FIXTURE.parkedAt,
      repeated: false,
    });

    const request = lineRequest(reply.rows.parks[0]);
    expect(request).toEqual({
      ...MAYA_FIXTURE,
      turn: { ...MAYA_FIXTURE.turn, eventIds: parked.turn.eventIds },
    });
    expect(request.outboxRows[0].finalParts.sends).toEqual([
      { kind: "words", text: PASSED_ON_LINE, calendarFile: "none", options: [], link: null },
    ]);
    expect(parked.spans[0]?.decided).toMatchObject({ parked: true, atOnce: false, line: true });

    const { turn } = await mayaParking(3);
    expect(unwordedRequestOf(turn, MAYA.party, MAYA.handle, MAYA_FIXTURE.parkedAt)).toEqual(
      unwordedFor(turn),
    );
  });

  it("a final answer's park at once is unchanged: its caller parks only a turn holding no stop word, so it carries the line without reading the texts", async () => {
    const { turn } = await samParking(1);
    const { set, reply } = depsOf(SAM.party, SAM_FIXTURE.parkedAt, fakeKeyStore());

    expect(await parkAtOnce(set, turn, REFUSED)).toMatchObject({ result: "parked" });
    expect(reply.rows.parks).toEqual([SAM_FIXTURE]);
  });
});

describe("the K-05 double holds a v1.23 request to item 84's checks, as db/repo/park.ts does", () => {
  const sam = (): ParkTurnLineRequest => structuredClone(SAM_FIXTURE) as unknown as ParkTurnLineRequest;

  it("refuses a park before the third try with no reason, a reason that is no label, an id twice, a row to another handle, and a reworded line", () => {
    const noReason = sam();
    delete noReason.reason;
    const numberId = sam();
    numberId.reason = { ...REFUSED, ids: ["+15555550100"] };
    const twice = sam();
    twice.reason = { ...REFUSED, ids: ["S1-04", "S1-04"] };
    const otherHandle = sam();
    otherHandle.outboxRows[0].recipientHandleId = "handle-maya";
    const reworded = sam();
    reworded.outboxRows[0].finalParts = {
      ...reworded.outboxRows[0].finalParts,
      sends: [
        {
          kind: "words",
          text: "Test words: nothing changed.",
          calendarFile: "none",
          options: [],
          link: null,
        },
      ],
    };
    for (const request of [noReason, numberId, twice, otherHandle, reworded]) {
      expect(() => {
        checkParkRequest(request);
      }).toThrow(TypeError);
    }
    expect(() => {
      checkParkRequest(sam());
    }).not.toThrow();
  });
});

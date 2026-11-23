// The park's request and its line (T-1552; T-1529's ruling cards 6 and 7; K-05 v1.23 item 84 and defaults 216 to 224;
// K-09 v1.13 default 218), run inside the Workers runtime against fixture fakes (./test-support.ts): ./park.ts builds
// K-05 v1.23's parkTurn.lineRequest for a turn parked at once on a final answer (park-turn-sam-refused-at-once.json) and
// for one parked after a third crash (park-turn-maya-crash-with-line.json), sends it through the turn's K-05 face (the
// double holds it to item 84's checks, as db/repo/park.ts does) and wakes the dispatcher once for its row. Test values
// only: the master's sample cast and the fixtures' ids, phones in the fictional 555-01xx range (rule 9).
import { describe, expect, it } from "vitest";

import fixedLines from "../../../contracts/bundle/fixtures/fixed-lines.json";
import parkTurnMayaCrash from "../../../contracts/data-access/fixtures/park-turn-maya-crash-with-line.json";
import parkTurnSamRefused from "../../../contracts/data-access/fixtures/park-turn-sam-refused-at-once.json";
import commitRefused from "../../../contracts/tool-api/fixtures/commit-s1-02-refused-step-not-in-bundle.json";
import type { ParkingTurn } from "../actor";
import type { HandleRef } from "../gateway";
import { fakeKeyStore } from "../gateway/test-support";
import { openTrace, spanProblems, type BundleId, type Span } from "../trace";
import {
  PASSED_ON,
  PASSED_ON_LINE,
  parkAtOnce,
  parkedEventId,
  parkedRowId,
  parkRequestOf,
  parkThroughRows,
  PARK_SENDS,
} from "./park";
import {
  MAYA,
  SAM,
  checkParkRequest,
  fakeDecide,
  fakeFacts,
  fakeReply,
  fakeTurnFace,
  storedText,
  turnDeps,
  type FakeReply,
} from "./test-support";
import type { ParkReason, ParkTurnLineRequest, ParkTurnRequest, TurnDeps, TurnParty } from "./types";

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

interface Parking {
  readonly turn: ParkingTurn;
  readonly spans: Span[];
}

/** A turn as the park is handed it: the fixture's ids, its one text sealed as the inbox keeps it, a trace of its own. */
async function parking(spec: {
  turnId: string;
  eventId: string;
  traceId: string;
  tries: number;
  handle: HandleRef;
}): Promise<Parking> {
  const spans: Span[] = [];
  let clock = Date.parse("2026-11-22T15:00:00Z");
  const trace = openTrace({
    openedBy: "textWebhook",
    bundleId: BUNDLE,
    sink: (span) => spans.push(span),
    now: () => (clock += 7),
  });
  trace.setTurn(spec.turnId);
  const entry = await storedText(
    {
      eventId: spec.eventId,
      body: "Test words: Barbershop, plumbing, electrical",
      sentAt: "2026-11-22T15:00:00Z",
      traceId: spec.traceId,
    },
    spec.handle,
    keys,
    BUNDLE,
    1,
  );
  return {
    turn: {
      turnId: spec.turnId,
      eventIds: [spec.eventId],
      entries: [entry],
      traceId: spec.traceId,
      joinedTraceIds: [],
      tries: spec.tries,
      bundleId: BUNDLE,
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

/** Maya's turn of park-turn-maya-crash-with-line.json, on the given try. */
const mayaParking = (tries = MAYA_FIXTURE.turn.tries): Promise<Parking> =>
  parking({
    turnId: MAYA_FIXTURE.turn.id,
    eventId: MAYA_FIXTURE.turn.eventIds[0] ?? "evt-maya-0005",
    traceId: MAYA_FIXTURE.turn.traceId,
    tries,
    handle: MAYA.handle,
  });

/** The turn's ports over the doubles: the directory answers `party`, the clock the fixture's park time. */
function depsOf(party: TurnParty | null, parkedAt: string): { set: TurnDeps; reply: FakeReply } {
  const face = fakeTurnFace();
  const reply = fakeReply(face.log);
  return { set: turnDeps(fakeFacts(party, [parkedAt]), face, fakeDecide(face.log), keys, reply), reply };
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

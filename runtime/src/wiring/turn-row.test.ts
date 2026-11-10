// The turn-row port (T-555; C-048, C-049): K-05's commitTurn (T-195) and parkTurn (T-197), the two calls that write a
// turn's one row (K-04 turns), under Node (Vitest project "unit"). It is joined real for the test environment and staging
// and closed in production (./picks.ts), fed by the K-05 double (./test-support.ts fakeTurnRows, answering as
// commit-first.json, commit-repeat-same-turn.json and park-turn.json under the running turn's id). Checked here: what K-05
// is sent and what comes back; that a turn id which is not T-248's hash of the turn's own event ids never reaches K-05
// (CQ-09; ADR-013), so one batch is one turn row; that with no database bound every call fails closed; and the root's
// binding in each environment. Test values only (rule 9): the frozen fixtures' ids.
import commitFirst from "@rosie/contracts/data-access/fixtures/commit-first.json";
import commitRepeat from "@rosie/contracts/data-access/fixtures/commit-repeat-same-turn.json";
import parkTurn from "@rosie/contracts/data-access/fixtures/park-turn.json";
import type { CommitTurnRequest } from "@rosie/db/repo/commit-turn";
import { describe, expect, it } from "vitest";

import { turnIdOf, type CommitTurnRef } from "../actor/lease";
import type { GateAndCommitRequest, ParkTurnRequest } from "../turn/types";
import { composeRoot, NoDatabaseError, NotJoinedError, realTurnRow, TurnIdError, workerRoot } from "./index";
import { commitFirstFor, fakeTurnRows, gateThroughCommit, skeletonFakes } from "./test-support";

const VARS = { ENVIRONMENT: "staging", GIT_SHA: "test-sha" };

/** commit-first.json's turn. */
const FIRST = commitFirst.request.turn;

/** commit-first.json's turn under the turn id the lease hashes from these event ids (CQ-09), on this try. */
async function leaseTurn(eventIds: string[] = [...FIRST.eventIds], tries = 1): Promise<CommitTurnRef> {
  return { ...structuredClone(FIRST), id: await turnIdOf(eventIds), eventIds: [...eventIds], tries };
}

/** park-turn.json's request under the turn id the lease hashes from its event ids, as a lapsed turn's park sends it. */
async function leasePark(): Promise<ParkTurnRequest> {
  const request = structuredClone(parkTurn.request) as unknown as ParkTurnRequest;
  return { ...request, turn: { ...request.turn, id: await turnIdOf(request.turn.eventIds) } };
}

/** A Worker's env as wrangler.jsonc's vars give it, for one environment. */
function workerEnv(environment: string): Cloudflare.Env {
  return { ENVIRONMENT: environment, BASE_PATH: "", DB_SCHEMA: "" };
}

describe("the turn-row port sends K-05 the turn the lease hashed, and K-05's answer comes back as it is", () => {
  it("commits once per turn id: commit-first.json's outcome under that id, then commit-repeat-same-turn.json's, and one turns row", async () => {
    const rows = fakeTurnRows();
    const port = realTurnRow({ calls: rows.calls });
    const turn = await leaseTurn();
    const request = commitFirstFor(turn);

    const first = await port.commitTurn(request);
    const again = await port.commitTurn(request);

    expect(first).toEqual({ ...commitFirst.outcome, turnId: turn.id });
    expect(again).toEqual({ ...commitRepeat.outcome, turnId: turn.id });
    // The request is commit-first.json's, but for its turn: the lease's.
    expect({ ...request, turn: commitFirst.request.turn }).toEqual(commitFirst.request);
    expect(rows.commits).toEqual([request, request]);
    expect([...rows.turns.values()]).toEqual([
      {
        id: turn.id,
        handleId: FIRST.handleId,
        eventIds: FIRST.eventIds,
        state: "committed",
        bundleId: FIRST.bundleId,
        traceId: FIRST.traceId,
        joinedTraceIds: [],
        tries: 1,
        at: commitFirst.outcome.committedAt,
      },
    ]);
  });

  it("parks once per turn id: park-turn.json's outcome under that id, then repeated; a commit of a parked id answers turnParked, a park of a committed id alreadyCommitted", async () => {
    const rows = fakeTurnRows();
    const port = realTurnRow({ calls: rows.calls });
    const park = await leasePark();

    const parked = await port.parkTurn(park);
    const again = await port.parkTurn(park);
    const late = await port.commitTurn(commitFirstFor(park.turn));

    expect(parked).toEqual({ ...parkTurn.outcome, turnId: park.turn.id });
    expect(again).toEqual({ ...parkTurn.outcome, turnId: park.turn.id, repeated: true });
    expect(late).toEqual({ error: "turnParked", turnId: park.turn.id, parkedAt: park.parkedAt });
    expect([...rows.turns.values()]).toMatchObject([
      { id: park.turn.id, state: "parked", tries: 3, at: park.parkedAt },
    ]);

    const committed = await leaseTurn();
    await port.commitTurn(commitFirstFor(committed));
    expect(await port.parkTurn({ ...park, turn: { ...committed, tries: 3 } })).toEqual({
      error: "alreadyCommitted",
      turnId: committed.id,
      committedAt: commitFirst.outcome.committedAt,
    });
    expect([...rows.turns.keys()]).toEqual([park.turn.id, committed.id]);
  });

  it("refuses a turn id that is not T-248's hash of its own event ids, before K-05 is reached", async () => {
    const rows = fakeTurnRows();
    const port = realTurnRow({ calls: rows.calls });
    const other = await leaseTurn(["evt-alex-0013"]);

    // The fixtures' own readable turn ids are no lease's.
    await expect(
      port.commitTurn(structuredClone(commitFirst.request) as unknown as CommitTurnRequest),
    ).rejects.toThrow(new TurnIdError("commitTurn"));
    await expect(
      port.parkTurn(structuredClone(parkTurn.request) as unknown as ParkTurnRequest),
    ).rejects.toThrow(new TurnIdError("parkTurn"));
    // Another batch's id over these texts, and a turn with no text.
    await expect(
      port.commitTurn(commitFirstFor({ ...other, eventIds: [...FIRST.eventIds] })),
    ).rejects.toThrow(new TurnIdError("commitTurn"));
    await expect(port.commitTurn(commitFirstFor({ ...other, eventIds: [] }))).rejects.toThrow(
      new TurnIdError("commitTurn"),
    );
    expect(rows.commits).toEqual([]);
    expect(rows.parks).toEqual([]);
    expect(rows.turns.size).toBe(0);
  });

  it("with no database bound (the Worker until T-567), every commit and park fails closed, naming the call only", async () => {
    const port = realTurnRow({ calls: null });

    await expect(port.commitTurn(commitFirstFor(await leaseTurn()))).rejects.toThrow(
      new NoDatabaseError("commitTurn"),
    );
    await expect(port.parkTurn(await leasePark())).rejects.toThrow(new NoDatabaseError("parkTurn"));
  });
});

describe("the root binds the turn-row port: real for test and staging, closed in production", () => {
  it("under test: the turn's park writes its row through it, and the gate's stand-in commits through it, K-05's answer as K-09's", async () => {
    const fakes = skeletonFakes();
    const root = composeRoot({
      environment: "test",
      sets: { fake: fakes.ports },
      actors: null,
      vars: VARS,
      turnRows: fakes.turnRows.calls,
    });
    const park = await leasePark();
    const turn = await leaseTurn(["evt-sam-0001"]);
    const gate = gateThroughCommit((request) => root.ports.turnRow.commitTurn(request));
    const gateRequest = {
      caller: {
        kind: "turn",
        turnId: turn.id,
        requestId: turn.id,
        businessId: null,
        personId: null,
        traceId: turn.traceId,
      },
      turn,
      input: { kind: "coreOnly" },
      core: [],
      now: "2026-11-07T15:06:29Z",
    } satisfies GateAndCommitRequest;

    expect(await root.turn.rows.parkTurn(park)).toEqual({ ...parkTurn.outcome, turnId: park.turn.id });
    expect(await gate(gateRequest)).toMatchObject({
      result: "committed",
      turnId: turn.id,
      committedAt: commitFirst.outcome.committedAt,
      repeated: false,
    });
    expect(await gate(gateRequest)).toMatchObject({ result: "committed", turnId: turn.id, repeated: true });
    fakes.turnRows.failCommitsWith = { error: "transient" };
    expect(await gate(gateRequest)).toEqual({ error: "transient" });

    expect(fakes.turnRows.parks.map((request) => request.turn.id)).toEqual([park.turn.id]);
    expect(fakes.turnRows.commits.map((request) => request.turn.id)).toEqual([turn.id, turn.id, turn.id]);
    expect([...fakes.turnRows.turns.values()].map((row) => [row.id, row.state])).toEqual([
      [park.turn.id, "parked"],
      [turn.id, "committed"],
    ]);
  });

  it("on the Worker's staging no database is bound until T-567: every commit and park fails closed, the turn's park too", async () => {
    const root = workerRoot(workerEnv("staging"));

    await expect(root.ports.turnRow.commitTurn(commitFirstFor(await leaseTurn()))).rejects.toThrow(
      new NoDatabaseError("commitTurn"),
    );
    await expect(root.turn.rows.parkTurn(await leasePark())).rejects.toThrow(new NoDatabaseError("parkTurn"));
  });

  it("in production the port is closed: every commit and park fails, naming the port", async () => {
    const root = workerRoot(workerEnv("production"));

    await expect(root.ports.turnRow.commitTurn(commitFirstFor(await leaseTurn()))).rejects.toThrow(
      new NotJoinedError("turnRow"),
    );
    await expect(root.turn.rows.parkTurn(await leasePark())).rejects.toThrow(new NotJoinedError("turnRow"));
  });
});

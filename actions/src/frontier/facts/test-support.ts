// Doubles for the facts' and the cap's tests (T-295). Never imported by the Worker. Built on T-291's
// (assemble/test-support.ts): the fake repo answers K-05 v1.2 readTurnState from seeded rows and holds each request and
// answer to K-05 v1.2's frozen schema; the bundles are K-01 v1's sample bundles; one buildFrontier call runs through the
// Tool API base, here with the facts' options. Values come only from the contracts' fixtures, the master's sample cast
// (Sam Lee, Alex M., Ben T., Dee, Maya, Tomás, Avery; Lee's Barbershop) and fixture set v1's barber shop (the $35
// haircut): rule 9.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { traceFor } from "../../tool-api/test-support";
import { createToolApi } from "../../tool-api/tool-api";
import { frontierHandlers } from "../assemble/handler";
import {
  bundleIdOf,
  captureLog,
  checks,
  fakeBundles,
  fakeRepo,
  frontierScope,
  openQuestionRow,
  s102Exchange,
  samSeed,
  sampleBundle,
  type Called,
  type CallOptions,
  type FakeRepo,
  type SeedRow,
  type TurnSeed,
} from "../assemble/test-support";
import type { Context, OpenQuestionRow, Time } from "../assemble/types";
import type { Fact, FactSource, FlaggedStep, FrontierFactsOptions, StepRead } from "./facts";
import { factHomes, type FactHome } from "./homes";
import type { FactRef } from "./read";

type Json = Record<string, unknown>;

const FIXTURES_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** K-01 v1's bundle-mini-a.json, which holds A6-02 ("Texts Sam the request") with its card. */
export const MINI_A = sampleBundle("bundle-mini-a.json");
export const MINI_A_ID = bundleIdOf(MINI_A);

export interface FactsCallOptions extends CallOptions {
  facts?: FrontierFactsOptions;
}

/** One buildFrontier call through the Tool API base, as T-291's callBuildFrontier, with the facts' options. */
export async function callFrontier(request: unknown, options: FactsCallOptions = {}): Promise<Called> {
  const repo = options.repo ?? fakeRepo(options.seed ?? samSeed());
  const scope = frontierScope(repo);
  const log = captureLog();
  const bundles = options.bundles ?? fakeBundles(sampleBundle("bundle-v0-skeleton.json"));
  const handlers = frontierHandlers<FakeRepo>({
    bundles,
    log: log.sink,
    checker: checks().checker,
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    ...(options.facts === undefined ? {} : { facts: options.facts }),
  });
  const api = createToolApi({ validator: checks().validator, scope, handlers });
  const { trace, spans } = traceFor(request);
  const answer = await api.call("buildFrontier", structuredClone(request), trace).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return { answer, repo, scope, log, spans, bundles };
}

/** The answer of a call that gave a response: its context, flagged steps and collapsed bookings. */
export function responseOf(called: Called): {
  context: Context;
  flagged: FlaggedStep[];
  collapsedBookingIds: string[];
} {
  if (!called.answer.ok) throw new Error("the call threw");
  const value = called.answer.value as unknown as Json;
  if (!("context" in value)) throw new Error(`no context: ${JSON.stringify(value)}`);
  return value as unknown as { context: Context; flagged: FlaggedStep[]; collapsedBookingIds: string[] };
}

/** A source naming fixed places steps read keys from. */
export function placesSource(reads: readonly StepRead[]): FactSource {
  return { name: "fixturePlaces", reads: () => reads.map((read) => ({ ...read })) };
}

/** Sam's text answering a request, as build-frontier-s1-02.json's request pinned to another bundle. */
export function samRequest(openQuestionIds: string[], bookingIds: string[], bundleId = MINI_A_ID): Json {
  const base = s102Exchange().request;
  return {
    ...base,
    turn: { ...base.turn, bundleId },
    texts: [
      {
        eventId: "evt-sam-0001",
        kind: "text",
        words: "Accept Alex",
        sentAt: { utc: "2026-10-22T17:00:00Z", zone: "America/New_York" },
        attachments: [],
        poll: null,
        tapback: null,
      },
    ],
    targets: {
      roles: [{ businessId: "biz-lees-barbershop", personId: "person-sam", role: "owner" }],
      openQuestionIds,
      bookingIds,
      noTarget: false,
    },
  };
}

/** A step asked of Sam about one booking request (A6-02 by default), under bundle-mini-a. */
export function a602(id: string, bookingId: string, sentAt: string, step = "A6-02"): OpenQuestionRow {
  return openQuestionRow({
    id,
    step,
    bookingId,
    turnId: `turn-${bookingId}-request`,
    sentAt,
    bundleId: MINI_A_ID,
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The fixture two-homes-one-key.json (K-09 v1 buildFrontier's rule: a second value for one key)

export interface TwoHomesFixture {
  note: string;
  homes: FactHome[];
  places: StepRead[];
  openQuestion: { id: string; step: string; bookingId: string; sentAt: string };
  visits: Record<string, Time>;
  rows: Record<string, Record<string, SeedRow>>;
  outcome: { read: FactRef[]; facts: Fact[]; flagged: FlaggedStep[] };
}

/** facts/fixtures/two-homes-one-key.json, freshly parsed. */
export function twoHomesFixture(): TwoHomesFixture {
  const file = `${FIXTURES_DIR}two-homes-one-key.json`;
  return JSON.parse(readFileSync(file, "utf8")) as TwoHomesFixture;
}

/** Sam's stored state for the fixture: his seed, the fixture's open question, its visit and its rows. */
export function twoHomesSeed(fixture: TwoHomesFixture): TurnSeed {
  const seed = samSeed();
  const { id, step, bookingId, sentAt } = fixture.openQuestion;
  return {
    ...seed,
    openQuestions: [a602(id, bookingId, sentAt, step)],
    visits: fixture.visits,
    rows: { ...seed.rows, ...fixture.rows },
  };
}

/** The fixture's call: Sam's turn on Alex's request, with the fixture's homes and places. */
export async function callTwoHomes(fixture: TwoHomesFixture, more: FactsCallOptions = {}): Promise<Called> {
  return callFrontier(samRequest([fixture.openQuestion.id], [fixture.openQuestion.bookingId]), {
    seed: twoHomesSeed(fixture),
    bundles: fakeBundles(MINI_A),
    facts: { homes: factHomes(fixture.homes), sources: [placesSource(fixture.places)] },
    ...more,
  });
}

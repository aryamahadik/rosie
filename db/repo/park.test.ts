// T-1542: what db/repo's parkTurn checks before any statement in K-05 v1.23's form (README item 84, defaults 216 to 219;
// T-1529's ruling card 4), and default 220's error summary. No database: every park here is sent through a client that
// throws the moment a statement is sent or the client is touched, so a request the call refuses is shown refused before
// any statement (a TypeError, named by its field and never by its value), and a request it accepts is shown to reach the
// client (the client's own error, never a TypeError). What the accepted parks write is db/repo/park.int.test.ts's.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PARKED_ERROR_SUMMARY,
  PASSED_ON_LINE,
  parkedErrorSummary,
  parkTurn,
  type ParkTurnLineRequest,
  type ParkTurnRequest,
} from "./park";
import type { Sql } from "./scope";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type JsonRecord = Record<string, Json>;

const FIXTURES = new URL("../../contracts/data-access/fixtures/", import.meta.url);
const SENT = "a statement was sent";

interface IndexEntry {
  file: string;
  def?: string;
  expect?: string;
}

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, "utf8"));
const requestOf = (file: string): JsonRecord =>
  (readJson(new URL(file, FIXTURES)) as { request: JsonRecord }).request;
const INDEX = (readJson(new URL("index.json", FIXTURES)) as { fixtures: IndexEntry[] }).fixtures;
const LINE = INDEX.filter((entry) => entry.def === "parkTurn.lineExchange");
const SAM = "park-turn-sam-refused-at-once.json";

/** A client no statement may reach: sending one, or reading anything of it, throws an Error that is no TypeError. */
const untouched = new Proxy(() => undefined, {
  apply() {
    throw new Error(SENT);
  },
  get() {
    throw new Error(SENT);
  },
}) as unknown as Sql;

const record = (value: Json | undefined): JsonRecord => (value ?? {}) as JsonRecord;
const rowOf = (request: JsonRecord): JsonRecord => record((request.outboxRows as Json[] | undefined)?.[0]);
const planOf = (row: JsonRecord): JsonRecord => record(row.plan);
const partsOf = (row: JsonRecord): JsonRecord => record(row.finalParts);
const sendOf = (row: JsonRecord): JsonRecord => record((partsOf(row).sends as Json[] | undefined)?.[0]);

/** A fresh copy of Sam's v1.23 request (park-turn-sam-refused-at-once.json). */
const sam = (): ParkTurnLineRequest => structuredClone(requestOf(SAM)) as unknown as ParkTurnLineRequest;

/** Sam's request changed by `change`, as a plain object, so a test may break it any way. */
function samWith(change: (request: JsonRecord, row: JsonRecord) => void): ParkTurnRequest {
  const request = structuredClone(requestOf(SAM));
  change(request, rowOf(request));
  return request as unknown as ParkTurnRequest;
}

/** Sam's request with its one row changed by `change`. */
const samRowWith = (change: (row: JsonRecord) => void): ParkTurnRequest =>
  samWith((_request, row) => {
    change(row);
  });

/** The TypeError the call throws before any statement; the test reads its message. */
async function refusal(request: ParkTurnRequest): Promise<TypeError> {
  const failure = await parkTurn(untouched, request).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(TypeError);
  return failure as TypeError;
}

/** Each case's request is refused with a message naming `names`, holding none of `never`. */
async function expectRefused(
  cases: readonly (readonly [string, ParkTurnRequest, string])[],
  never: readonly string[],
): Promise<void> {
  for (const [name, request, names] of cases) {
    const error = await refusal(request);
    expect(error.message, name).toContain(names);
    for (const value of never) {
      expect(error.message, name).not.toContain(value);
    }
  }
}

describe("parkTurn in K-05 v1.23's form: the requests it takes reach the database (T-1542)", () => {
  it("each accepted v1.23 fixture's request passes every check and reaches the client", async () => {
    const accepted = LINE.filter((entry) => entry.expect === "accept").map((entry) => entry.file);
    expect(accepted).toEqual(
      expect.arrayContaining([
        SAM,
        "park-turn-sam-refused-repeat.json",
        "park-turn-maya-crash-with-line.json",
      ]),
    );
    for (const file of accepted) {
      await expect(parkTurn(untouched, requestOf(file) as unknown as ParkTurnRequest), file).rejects.toThrow(
        SENT,
      );
    }
  });

  it("v1's park-turn.json reaches the client in v1's form, as before", async () => {
    await expect(
      parkTurn(untouched, requestOf("park-turn.json") as unknown as ParkTurnRequest),
    ).rejects.toThrow(SENT);
  });

  it("a final refusal named on the third try, a reason with no ids and an email handle's row are taken", async () => {
    const third = sam();
    third.turn.tries = 3;
    await expect(parkTurn(untouched, third)).rejects.toThrow(SENT);
    const noIds = sam();
    noIds.reason = { from: "commit", fault: "secondCompany", ids: [] };
    await expect(parkTurn(untouched, noIds)).rejects.toThrow(SENT);
    const email = samRowWith((row) => {
      row.channel = "email";
      planOf(row).channel = "email";
      partsOf(row).channel = "email";
    });
    await expect(parkTurn(untouched, email)).rejects.toThrow(SENT);
  });
});

describe("parkTurn in K-05 v1.23's form: what it refuses before any statement, named by field, never by value", () => {
  it("each refused v1.23 fixture throws a TypeError naming its one fault, never the refused words", async () => {
    const refused = LINE.filter((entry) => entry.expect === "refuse").map((entry) => entry.file);
    const faults: Record<string, string> = {
      "invalid/refuse-park-turn-sam-refused-no-reason.json": "reason is missing",
      "invalid/refuse-park-turn-sam-refused-line-reworded.json": "sends[0].text",
      "invalid/refuse-park-turn-sam-refused-reason-words.json": "reason.fault",
    };
    expect(refused).toEqual(expect.arrayContaining(Object.keys(faults)));
    for (const file of refused) {
      const request = requestOf(file);
      const error = await refusal(request as unknown as ParkTurnRequest);
      const names = faults[file];
      if (names !== undefined) {
        expect(error.message, file).toContain(names);
      }
      // No value of the request is in the message: the reason's words, the row's words, its id and handle, the name.
      const row = rowOf(request);
      for (const value of [
        record(request.reason).fault,
        sendOf(row).text,
        row.id,
        row.recipientHandleId,
        "Sam",
      ]) {
        if (typeof value === "string") {
          expect(error.message, file).not.toContain(value);
        }
      }
    }
  });

  it("a park before the third try names its reason (default 218), and a fourth try is no try", async () => {
    await expectRefused(
      [
        [
          "try 2 with no reason",
          samWith((request) => {
            record(request.turn).tries = 2;
            delete request.reason;
          }),
          "reason is missing before the third try",
        ],
        [
          "try 4",
          samWith((request) => {
            record(request.turn).tries = 4;
          }),
          "turn.tries",
        ],
      ],
      [],
    );
  });

  it("a reason is three labels, its ids each once, nothing else (default 217)", async () => {
    await expectRefused(
      [
        [
          "a from that reads as a number",
          samWith((request) => {
            record(request.reason).from = "1234567";
          }),
          "reason.from",
        ],
        [
          "an id in words",
          samWith((request) => {
            record(request.reason).ids = ["S1-04", "the owner's words"];
          }),
          "reason.ids[1]",
        ],
        [
          "an id twice",
          samWith((request) => {
            record(request.reason).ids = ["S1-04", "S1-04"];
          }),
          "reason.ids names one id more than once",
        ],
        [
          "a field beside the three",
          samWith((request) => {
            record(request.reason).words = "stepNotInBundle";
          }),
          "reason takes from, fault and ids alone",
        ],
        [
          "ids that are not a list",
          samWith((request) => {
            record(request.reason).ids = "S1-04";
          }),
          "reason.ids is not a list",
        ],
      ],
      ["1234567", "the owner's words"],
    );
  });

  it("the one row goes to the turn's own handle, a quick reply about nothing, decided on no versions (default 219)", async () => {
    await expectRefused(
      [
        [
          "another handle",
          samRowWith((row) => {
            row.recipientHandleId = "handle-maya";
          }),
          "recipientHandleId is not the turn's handleId",
        ],
        [
          "a booking",
          samRowWith((row) => {
            row.bookingId = "booking-1";
          }),
          "bookingId",
        ],
        [
          "a question",
          samRowWith((row) => {
            row.openQuestionId = "oq-1";
          }),
          "openQuestionId",
        ],
        [
          "an email copy",
          samRowWith((row) => {
            row.copyOfRowId = "out-1";
          }),
          "copyOfRowId",
        ],
        [
          "another send class",
          samRowWith((row) => {
            row.sendClass = "routine";
          }),
          "sendClass",
        ],
        [
          "versions read",
          samRowWith((row) => {
            row.versionsRead = [{ table: "handles", rowId: "handle-sam", version: 1 }];
          }),
          "versionsRead",
        ],
        [
          "a channel K-05 does not name",
          samRowWith((row) => {
            row.channel = "whatsapp";
          }),
          "channel",
        ],
        [
          "a field beside parkedRowNew's",
          samRowWith((row) => {
            row.step = "S1-04";
          }),
          "parkedRowNew's fields",
        ],
        [
          "no final parts",
          samRowWith((row) => {
            delete row.finalParts;
          }),
          "parkedRowNew's fields",
        ],
        [
          "no plan",
          samRowWith((row) => {
            delete row.plan;
          }),
          "parkedRowNew's fields",
        ],
        [
          "an empty id",
          samRowWith((row) => {
            row.id = "";
          }),
          "outboxRows[0].id",
        ],
      ],
      ["handle-maya", "booking-1", "oq-1", "out-1", "whatsapp"],
    );
  });

  it("exactly one row: none, or two, is refused", async () => {
    await expectRefused(
      [
        [
          "no row",
          samWith((request) => {
            request.outboxRows = [];
          }),
          "outboxRows is not exactly one row",
        ],
        [
          "two rows",
          samWith((request, row) => {
            request.outboxRows = [row, { ...row, id: "out-turn-sam-refused-1-parked-2" }];
          }),
          "outboxRows is not exactly one row",
        ],
      ],
      ["out-turn-sam-refused-1-parked-2"],
    );
  });

  it("the plan and the final parts name the row and its channel, and the words are passedOn alone (default 216)", async () => {
    await expectRefused(
      [
        [
          "the plan of another row",
          samRowWith((row) => {
            planOf(row).row = "out-other";
          }),
          "plan.row is not the row's id",
        ],
        [
          "the plan on another channel",
          samRowWith((row) => {
            planOf(row).channel = "email";
          }),
          "plan.channel is not the row's channel",
        ],
        [
          "final parts of another row",
          samRowWith((row) => {
            partsOf(row).row = "out-other";
          }),
          "finalParts.row is not the row's id",
        ],
        [
          "final parts on another channel",
          samRowWith((row) => {
            partsOf(row).channel = "email";
          }),
          "finalParts.channel is not the row's channel",
        ],
        [
          "straight apostrophes",
          samRowWith((row) => {
            sendOf(row).text = PASSED_ON_LINE.replaceAll("’", "'");
          }),
          "sends[0].text is not K-01's passedOn line",
        ],
        [
          "words of its own",
          samRowWith((row) => {
            sendOf(row).text = "Sorry Sam, I could not find that step.";
          }),
          "sends[0].text is not K-01's passedOn line",
        ],
        [
          "another fixed line beside it",
          samRowWith((row) => {
            partsOf(row).fixedLines = ["passedOn", "opener"];
          }),
          "is not parkedLineParts",
        ],
        [
          "no fixed line",
          samRowWith((row) => {
            partsOf(row).fixedLines = [];
          }),
          "is not parkedLineParts",
        ],
        [
          "a slot value",
          samRowWith((row) => {
            partsOf(row).slotValues = [{ slot: "step", value: "S1-04" }];
          }),
          "is not parkedLineParts",
        ],
        [
          "an option",
          samRowWith((row) => {
            sendOf(row).options = ["Yes"];
          }),
          "is not parkedLineParts",
        ],
        [
          "a link",
          samRowWith((row) => {
            sendOf(row).link = "https://rosfield.invalid/p";
          }),
          "is not parkedLineParts",
        ],
        [
          "a calendar file",
          samRowWith((row) => {
            sendOf(row).calendarFile = "ics";
          }),
          "is not parkedLineParts",
        ],
        [
          "a poll",
          samRowWith((row) => {
            sendOf(row).kind = "poll";
          }),
          "is not parkedLineParts",
        ],
        [
          "two sends",
          samRowWith((row) => {
            partsOf(row).sends = [sendOf(row), sendOf(row)];
          }),
          "is not parkedLineParts",
        ],
        [
          "a thread",
          samRowWith((row) => {
            partsOf(row).threadReplyTo = "msg-1";
          }),
          "is not parkedLineParts",
        ],
        [
          "plan lines",
          samRowWith((row) => {
            record(planOf(row).plan).lines = [{ say: "x" }];
          }),
          "is not parkedLinePlan",
        ],
        [
          "a plan question",
          samRowWith((row) => {
            record(planOf(row).plan).question = { id: "q" };
          }),
          "is not parkedLinePlan",
        ],
        [
          "a plan copy",
          samRowWith((row) => {
            planOf(row).copyOf = "out-other";
          }),
          "is not parkedLinePlan",
        ],
        [
          "another format",
          samRowWith((row) => {
            record(planOf(row).plan).formats = ["text", "poll"];
          }),
          "is not parkedLinePlan",
        ],
      ],
      ["out-other", "Sorry Sam", "I've passed", "rosfield.invalid", "msg-1"],
    );
  });

  it("a v1.23 request takes only its own fields, each present", async () => {
    await expectRefused(
      [
        [
          "a field beside them",
          samWith((request) => {
            request.words = "the step Sam asked for";
          }),
          "the request takes only",
        ],
        [
          "no entries",
          samWith((request) => {
            delete request.events;
          }),
          "the request needs events",
        ],
      ],
      ["the step Sam asked for"],
    );
  });
});

describe("parkTurn: the error summary for Rosie's team (K-05 v1.23 default 220)", () => {
  it("a refusal's summary is built from its labels and the try alone; a crash keeps the fixed text", () => {
    expect(parkedErrorSummary({ from: "walk", fault: "stepNotInBundle", ids: ["S1-04"] }, 1)).toBe(
      "Refused as final (walk: stepNotInBundle; S1-04) on try 1 of 3; nothing was committed",
    );
    expect(parkedErrorSummary({ from: "commit", fault: "secondCompany", ids: ["S1-04", "A"] }, 3)).toBe(
      "Refused as final (commit: secondCompany; S1-04, A) on try 3 of 3; nothing was committed",
    );
    expect(parkedErrorSummary({ from: "tool-api", fault: "notBuilt", ids: [] }, 2)).toBe(
      "Refused as final (tool-api: notBuilt) on try 2 of 3; nothing was committed",
    );
    expect(parkedErrorSummary(null, 3)).toBe(PARKED_ERROR_SUMMARY);
  });

  it("the passedOn line is K-01's, word for word, its apostrophes typographic", () => {
    expect(sendOf(rowOf(requestOf(SAM))).text).toBe(PASSED_ON_LINE);
    expect(PASSED_ON_LINE).toBe("I’ve passed this on. Rosie’s team will reply within 1 business day.");
    // Two typographic apostrophes (U+2019), no straight one.
    expect(PASSED_ON_LINE.split("’")).toHaveLength(3);
    expect(PASSED_ON_LINE).not.toContain("'");
  });
});

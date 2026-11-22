// T-1533's unit proofs of S1-10's writer and the secure link's minting (the card's "Proves it with"; K-09 README defaults
// 210 and 211, with the lead's rulings DL-1167). `npm run test:unit -- actions/src/tool-api/journey-1/mobile-id`.
//
// Under test, as they are: S1-10's writer (writer.ts) and its reads' checks (reads.ts), the minting (link.ts), and
// mobileIdSteps, which builds them over one walk's readings with T-635a's S1-09 settler and S1-09 and S1-76 writers, so
// the claim comes from S1-09's own reading of the same turn object. On bundle v3 the commit's walk (T-1461, T-1532's
// wait) calls them for real. Doubles, for ports only: the K-05 reads (items 79 and 26) as db/repo answers them
// (test-support.ts, listing/test-support.ts), T-434's Places double, the stop home's reads over the frozen seeds, T-319's
// paging world and S1-09's question read. The turn is commit-s1-02.json's second turn with S1-09's answer in its one part
// (listing/test-support.ts s1_09Turn; on bundle v3, commit/walk/test-support.ts turnS1_09OnV3).
//
// The card's cases: an owner's claim on a chat with a number writes the accounts row, one page_links row (the sha256 of a
// 32-hex code; setup_id_check; S1-10; 7 days) and S1-10's line 2 row, the plain link going only to the face's stage; a
// helper's claim writes only the helper's accounts row; no claim is refused claimUnknown; an email handle noNumberInChat;
// never id_checked; and no code, link or number in any log or error. Around them: noPhoneRow, the four accounts states
// the lead rules (none on file, mobile null, the chat's number unproven or proven, another number: mobileOnFile), the stop
// home's noTexts, the ports left out, and the reads' checks. The replay, a conflict's second run, the commit's
// accounts_mobile_key refusal and finalize's link are the face's (link-hold.test.ts) and PostgreSQL's
// (mobile-id.int.test.ts).

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { createPlacesDouble } from "../../../../../adapters/src/places/double";
import type { PassedPart, StateWrite } from "../../../commit";
import { WalkRefusedError, createWritesOf, type StepRows } from "../../../commit/walk";
import {
  NOTHING_OPEN,
  S1_09_QUESTION,
  SAM,
  bundleV3Bundles,
  questionsOver,
  s1_09QuestionRow,
  turnS1_09OnV3,
  type WalkTestRepo,
} from "../../../commit/walk/test-support";
import { pagingWorld, readerOn } from "../../../domain/paging/test-support";
import { readsOn, seedWorld, type World } from "../../../homes/stop/test-support";
import { NotBuiltError } from "../../errors";
import { stoppedWorld } from "../kinds/test-support";
import { HELPS_RUN_IT, NO_MATCH, OWNER_MATCHES, listingReadsOf } from "../listing";
import {
  MADE_UP_WORDS,
  RULING_WORDS,
  SAM_BUSINESS,
  fakeListingK05,
  s1_09Step,
  s1_09Turn,
  s1_76Step,
  settlerCall,
  writerCall,
  type S1_09Turn,
} from "../listing/test-support";
import {
  LINK_CODE_BYTES,
  LINK_CODE_FORM,
  LINK_LIFE_MS,
  MobileIdNotBuiltError,
  MobileIdReadError,
  MobileIdRefusedError,
  codeSha256,
  isLinkPlace,
  linkLifeOf,
  mintCode,
  mobileIdReadsOf,
  mobileIdSteps,
  secureLinkOf,
  type AccountOnFile,
  type MobileIdStepsDeps,
  type SecureLinkDeps,
} from "./index";
import {
  BASE_PATH,
  COUNTING_CODE,
  COUNTING_FILL,
  EXPIRES_AT,
  ISSUED_AT,
  LAST_TEXT_AT,
  LINK_HOST,
  OTHER_NUMBER,
  SAM_HANDLE,
  SAM_NUMBER,
  SAM_PERSON,
  fakeMobileIdK05,
  linkDeps,
  recordingStage,
  s1_10Step,
  type FakeMobileId,
  type MobileIdGiven,
  type RecordingStage,
} from "./test-support";

const nodeSha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** What a test hands the four steps, and what each double saw. */
interface Harness {
  readonly deps: MobileIdStepsDeps<WalkTestRepo>;
  readonly k05: FakeMobileId;
  readonly stage: RecordingStage;
}

interface HarnessOptions {
  readonly given?: MobileIdGiven;
  /** The stop home's world (default the seeds'); null: no stop reads bound. */
  readonly stop?: World | null;
  /** The secure link's port (default staging's place over the recording stage); null: none bound. */
  readonly link?: ((stage: RecordingStage) => SecureLinkDeps) | null;
}

function harness(options: HarnessOptions = {}): Harness {
  const k05 = fakeMobileIdK05(options.given);
  const stage = recordingStage();
  const paging = pagingWorld();
  paging.rows.set(`businesses/${SAM_BUSINESS}`, { version: 3, businessId: SAM_BUSINESS });
  const reader = readerOn(paging);
  const link = options.link === undefined ? linkDeps(stage) : options.link?.(stage);
  const deps: MobileIdStepsDeps<WalkTestRepo> = {
    places: createPlacesDouble({ now: () => "2026-10-19T14:08:04Z" }),
    reads: listingReadsOf(fakeListingK05().k05),
    ...(options.stop === null ? {} : { stop: readsOn(options.stop ?? seedWorld(), null) }),
    paging: { reader: () => reader },
    mobileId: { reads: mobileIdReadsOf(k05.k05), ...(link === undefined ? {} : { link }) },
  };
  return { deps, k05, stage };
}

/**
 * What the walk does on S1-09's answer, as far as S1-10: S1-09's settler once, S1-09's writer, S1-76's on "No match,
 * or already listed", then S1-10's writer, all on one turn context. `settled` false skips the settler (no reading held).
 */
async function walked(turn: S1_09Turn, deps: MobileIdStepsDeps<WalkTestRepo>, settled = true) {
  const steps = mobileIdSteps(deps);
  const branch = settled ? await steps.settlers["S1-09"](settlerCall(turn)) : OWNER_MATCHES;
  if (settled) await steps.writers["S1-09"](writerCall(turn, s1_09Step(), branch));
  if (branch === NO_MATCH) await steps.writers["S1-76"](writerCall(turn, s1_76Step(), branch));
  return steps.writers["S1-10"](writerCall(turn, s1_10Step(), branch));
}

/** The thrown error of a promise that must fail. */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => "answered",
    (error: unknown) => error,
  );
}

function expectRefused(error: unknown, fault: string): void {
  expect(error).toBeInstanceOf(MobileIdRefusedError);
  expect(error).toMatchObject({ fault, ids: ["S1-10"] });
}

/** The accounts insert for Sam's own sign-in: the chat's number, proven at the turn's last text. */
const SAM_ACCOUNT_INSERT: StateWrite = {
  op: "insert",
  table: "accounts",
  values: { person_id: SAM_PERSON, mobile: SAM_NUMBER, mobile_proven_at: LAST_TEXT_AT },
};

/** S1-10's line 2 row to Sam under Lee's Barbershop on iMessage, with no question and no plan. */
const S1_10_ROW = {
  id: "outbox-s1-10-sam-1",
  recipientHandleId: SAM_HANDLE,
  recipientPersonId: SAM_PERSON,
  businessId: SAM_BUSINESS,
  bookingId: null,
  channel: "imessage",
  sendClass: "quick_reply",
  openQuestionId: null,
  copyOfRowId: null,
  versionsRead: [],
  step: "S1-10",
  lineNo: 2,
};

/** The page_links insert of the rows, or a throw. */
function pageLinkOf(rows: StepRows): Record<string, unknown> {
  const insert = rows.state.find((write) => write.op === "insert" && write.table === "page_links");
  if (insert?.op !== "insert") throw new Error("S1-10's writer gives a page_links row");
  return insert.values;
}

/** The code at the end of a staged link (its last path segment). */
function codeOf(link: string): string {
  return link.slice(link.lastIndexOf("/") + 1);
}

const consoleNames = ["log", "info", "warn", "error", "debug"] as const;
let spies: MockInstance[] = [];

beforeEach(() => {
  spies = consoleNames.map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
});

afterEach(() => {
  // Nothing logs a code, a link, a number or the owner's words: nothing logs at all.
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  for (const spy of spies) spy.mockRestore();
});

describe("default 211: the code, the link and the row's hash", () => {
  it("a code is 16 bytes from the secure generator as 32 lowercase hex, never '_', inside K-21's linkCode pattern", () => {
    const codes = Array.from({ length: 64 }, () => mintCode());
    for (const code of codes) {
      expect(code).toMatch(LINK_CODE_FORM);
      expect(code).toMatch(/^[A-Za-z0-9-]{3,64}$/);
      expect(code).not.toContain("_");
    }
    expect(new Set(codes).size).toBe(codes.length);
    expect(LINK_CODE_BYTES).toBe(16);
    expect(mintCode(COUNTING_FILL)).toBe(COUNTING_CODE);
  });

  it("the link is https://<LINK_HOST><BASE_PATH>/<code>; a code not in its made form is refused, naming no code", () => {
    const place = { host: LINK_HOST, basePath: BASE_PATH };
    expect(secureLinkOf(place, COUNTING_CODE)).toBe(`https://rosfield.com/test/${COUNTING_CODE}`);
    expect(secureLinkOf({ host: LINK_HOST, basePath: "" }, COUNTING_CODE)).toBe(
      `https://rosfield.com/${COUNTING_CODE}`,
    );
    for (const bad of ["s01", COUNTING_CODE.toUpperCase(), `${COUNTING_CODE}0`, "a_b".padEnd(32, "0")]) {
      expect(() => secureLinkOf(place, bad)).toThrow(/no link code made/);
      try {
        secureLinkOf(place, bad);
      } catch (error) {
        expect(String(error)).not.toContain(bad);
      }
    }
  });

  it("a host or base path that is not a link's is no link place", () => {
    expect(isLinkPlace({ host: LINK_HOST, basePath: BASE_PATH })).toBe(true);
    expect(isLinkPlace({ host: "localhost:8787", basePath: "" })).toBe(true);
    for (const place of [
      { host: "", basePath: BASE_PATH },
      { host: "Rosfield.com", basePath: BASE_PATH },
      { host: "rosfield.com/test", basePath: "" },
      { host: "https://rosfield.com", basePath: "" },
      { host: LINK_HOST, basePath: "test" },
      { host: LINK_HOST, basePath: "/test/" },
    ]) {
      expect(isLinkPlace(place)).toBe(false);
    }
  });

  it("the row keeps the code's sha256 in UTF-8 as 64 lowercase hex, and the link lives 7 days from its issue, to the second", async () => {
    const hash = await codeSha256(COUNTING_CODE);
    expect(hash).toBe(nodeSha256(COUNTING_CODE));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(LINK_LIFE_MS).toBe(604_800_000);
    expect(linkLifeOf(new Date("2026-10-19T14:05:06.789Z"))).toEqual({
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
    });
  });
});

describe("default 210: an owner's claim on a chat that carries the number", () => {
  it("writes the accounts row, one page_links row and S1-10's line 2 row; gives mobile alone; the link goes only to the stage", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    const rows = await walked(turn, run.deps);
    expect(rows.gives).toEqual(["mobile"]);
    expect(rows.gives).not.toContain("id_checked");
    expect(rows.stateEvents).toEqual([]);
    expect(rows.asks).toEqual([]);
    expect(rows.messages).toEqual([S1_10_ROW]);
    expect(rows.state.map((write) => [write.op, write.table])).toEqual([
      ["insert", "accounts"],
      ["insert", "page_links"],
    ]);
    expect(rows.state[0]).toEqual(SAM_ACCOUNT_INSERT);

    // The plain link went to the stage alone, by the turn and the row that carries it.
    expect(run.stage.staged).toHaveLength(1);
    const [staged] = run.stage.staged;
    expect(staged).toMatchObject({ turnId: turn.context.turn.id, outboxRowId: "outbox-s1-10-sam-1" });
    const code = codeOf(staged?.link ?? "");
    expect(code).toMatch(LINK_CODE_FORM);
    expect(staged?.link).toBe(`https://rosfield.com/test/${code}`);
    expect(pageLinkOf(rows)).toEqual({
      id: "link-s1-10-sam-1",
      business_id: SAM_BUSINESS,
      person_id: SAM_PERSON,
      purpose: "setup_id_check",
      step_id: "S1-10",
      code_sha256: nodeSha256(code),
      sent_to_handle_id: SAM_HANDLE,
      issued_at: ISSUED_AT,
      expires_at: EXPIRES_AT,
    });
    // The rows hold the code nowhere: only its hash, and never the link or the sample link.
    const written = JSON.stringify(rows);
    expect(written).not.toContain(code);
    expect(written).not.toContain("rosfield.com");
  });

  it("reads item 79, then item 26's handle with no fact, then item 26's accounts row of Sam, each handed the call's repo", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    await walked(turn, run.deps);
    expect(run.k05.asked).toEqual([
      { read: "readPickedKinds", businessId: SAM_BUSINESS, personId: SAM_PERSON },
      {
        read: "readTurnState",
        repo: turn.context.repo,
        request: { handleId: SAM_HANDLE, businessId: SAM_BUSINESS, bookingIds: [], facts: [] },
      },
      {
        read: "readTurnState",
        repo: turn.context.repo,
        request: {
          handleId: SAM_HANDLE,
          businessId: SAM_BUSINESS,
          bookingIds: [],
          facts: ["mobile", "mobile_proven_at", "version"].map((column) => ({
            key: `account.${column}`,
            table: "accounts",
            rowId: SAM_PERSON,
            column,
          })),
        },
      },
    ]);
  });

  it("the owner's claim with no match (S1-76 first) writes the same: the claim is the reading's, never the branch", async () => {
    const run = harness();
    const rows = await walked(s1_09Turn(OWNER_MATCHES, MADE_UP_WORDS), run.deps);
    expect(rows.state.map((write) => write.table)).toEqual(["accounts", "page_links"]);
    expect(rows.messages).toEqual([S1_10_ROW]);
    expect(run.stage.staged).toHaveLength(1);
  });

  it("the code comes from the bound generator: a made-up draw gives its own code, link and hash", async () => {
    const run = harness({ link: (stage) => linkDeps(stage, COUNTING_FILL) });
    const rows = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(run.stage.staged.map((each) => each.link)).toEqual([`https://rosfield.com/test/${COUNTING_CODE}`]);
    expect(pageLinkOf(rows).code_sha256).toBe(nodeSha256(COUNTING_CODE));
  });

  it("each run mints its own code: the same part twice stages two links at the same row id, and writes two hashes", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    const first = await walked(turn, run.deps);
    const second = await walked(turn, run.deps);
    const [one, two] = run.stage.staged;
    expect(one?.outboxRowId).toBe("outbox-s1-10-sam-1");
    expect(two?.outboxRowId).toBe("outbox-s1-10-sam-1");
    expect(one?.link).not.toBe(two?.link);
    expect(pageLinkOf(first).code_sha256).not.toBe(pageLinkOf(second).code_sha256);
  });

  it("the stop home's noTexts writes the accounts row alone: no link, no row, nothing staged", async () => {
    const run = harness({ stop: stoppedWorld("2026-10-19T14:00:00Z") });
    const rows = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(rows.state).toEqual([SAM_ACCOUNT_INSERT]);
    expect(rows.messages).toEqual([]);
    expect(rows.gives).toEqual(["mobile"]);
    expect(run.stage.staged).toEqual([]);
  });
});

describe("default 210: the caller's accounts row, as the lead rules it (DL-1167 (2))", () => {
  const account = (mobile: string | null, mobileProvenAt: string | null): AccountOnFile => ({
    mobile,
    mobileProvenAt,
    version: 4,
  });

  it("on file with mobile null: mobile and mobile_proven_at set at the version read", async () => {
    const run = harness({ given: { account: account(null, null) } });
    const rows = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(rows.state[0]).toEqual({
      op: "update",
      table: "accounts",
      key: { person_id: SAM_PERSON },
      expectVersion: 4,
      set: { mobile: SAM_NUMBER, mobile_proven_at: LAST_TEXT_AT },
    });
    expect(rows.state.map((write) => write.table)).toEqual(["accounts", "page_links"]);
  });

  it("on file holding the chat's number unproven: mobile_proven_at set at the version read", async () => {
    const run = harness({ given: { account: account(SAM_NUMBER, null) } });
    const rows = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(rows.state[0]).toEqual({
      op: "update",
      table: "accounts",
      key: { person_id: SAM_PERSON },
      expectVersion: 4,
      set: { mobile_proven_at: LAST_TEXT_AT },
    });
  });

  it("on file holding the chat's number proven: nothing written to accounts; the link and the row still are; mobile given", async () => {
    const run = harness({ given: { account: account(SAM_NUMBER, "2026-10-01T10:00:00Z") } });
    const rows = await walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps);
    expect(rows.state.map((write) => write.table)).toEqual(["page_links"]);
    expect(rows.messages).toEqual([S1_10_ROW]);
    expect(rows.gives).toEqual(["mobile"]);
  });

  it("on file holding another number: refused mobileOnFile, nothing staged, the error naming no number", async () => {
    const run = harness({ given: { account: account(OTHER_NUMBER, "2026-10-01T10:00:00Z") } });
    const error = await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps));
    expectRefused(error, "mobileOnFile");
    expect(run.stage.staged).toEqual([]);
    expect(JSON.stringify(error)).not.toContain("555");
    expect(String(error)).not.toContain("555");
  });
});

describe("default 210: a helper's claim sets only the helper's own sign-in", () => {
  it.each([
    ["with the listing (the helper's branch)", RULING_WORDS],
    ["with no match (S1-76 first)", MADE_UP_WORDS],
  ])(
    "%s: the helper's accounts row alone; no link, no row, nothing staged; mobile given",
    async (_, words) => {
      const run = harness();
      const rows = await walked(s1_09Turn(HELPS_RUN_IT, words), run.deps);
      expect(rows).toEqual({
        state: [SAM_ACCOUNT_INSERT],
        stateEvents: [],
        gives: ["mobile"],
        asks: [],
        messages: [],
      });
      expect(run.stage.staged).toEqual([]);
    },
  );

  it("needs neither the stop reads nor the link port, which only the owner's ID text reads", async () => {
    const run = harness({ stop: null, link: null });
    const rows = await walked(s1_09Turn(HELPS_RUN_IT, RULING_WORDS), run.deps);
    expect(rows.state).toEqual([SAM_ACCOUNT_INSERT]);
  });
});

describe("default 210: refused, nothing written", () => {
  it("no S1-09 reading held for the walk and part: claimUnknown, before anything is read", async () => {
    const run = harness();
    const error = await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps, false));
    expectRefused(error, "claimUnknown");
    expect(run.k05.asked).toEqual([]);
  });

  it("a reading that answered 'ask' (no details) is no claim either: claimUnknown", async () => {
    const run = harness();
    const steps = mobileIdSteps(run.deps);
    const turn = s1_09Turn(OWNER_MATCHES, null);
    await expect(steps.settlers["S1-09"](settlerCall(turn))).rejects.toMatchObject({
      fault: "listingNeedsDetails",
    });
    const error = await refusal(steps.writers["S1-10"](writerCall(turn, s1_10Step(), OWNER_MATCHES)));
    expectRefused(error, "claimUnknown");
  });

  it("another walk's reading is never read: a writer handed another turn object finds none", async () => {
    const run = harness();
    const steps = mobileIdSteps(run.deps);
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    await steps.settlers["S1-09"](settlerCall(turn));
    const other = { ...turn, context: { ...turn.context } };
    const error = await refusal(steps.writers["S1-10"](writerCall(other, s1_10Step(), OWNER_MATCHES)));
    expectRefused(error, "claimUnknown");
  });

  it("an email turn: noNumberInChat, before anything is read", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    (turn.request.turn as unknown as Record<string, unknown>).service = "email";
    expectRefused(await refusal(walked(turn, run.deps)), "noNumberInChat");
    expect(run.k05.asked).toEqual([]);
  });

  it("a chat on an email handle (Apple Messages, which doesn't share the number): noNumberInChat", async () => {
    const run = harness({ given: { handleKind: "email", phoneNumber: null } });
    expectRefused(await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps)), "noNumberInChat");
    expect(run.stage.staged).toEqual([]);
  });

  it("a phone handle with no phones row on file: noPhoneRow", async () => {
    const run = harness({ given: { phoneNumber: null } });
    expectRefused(await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps)), "noPhoneRow");
  });

  it("a turn with no person: noPerson; a handle that is not the person's own: noPerson", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    const steps = mobileIdSteps(run.deps);
    await steps.settlers["S1-09"](settlerCall(turn));
    const call = writerCall(turn, s1_10Step(), OWNER_MATCHES);
    const caller = { ...turn.context.request.caller, personId: null };
    const nobody = { ...call, writer: { ...call.writer } };
    Object.assign(nobody.writer.turn.request, { caller });
    expectRefused(await refusal(steps.writers["S1-10"](nobody)), "noPerson");

    const notTheirs = harness({ given: { people: ["person-alex"] } });
    expectRefused(await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), notTheirs.deps)), "noPerson");
  });

  it("the caller's person owns no company the turn runs under: noCompany, before the handle is read", async () => {
    const run = harness({ given: { companies: [] } });
    expectRefused(await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps)), "noCompany");
    expect(run.k05.asked.map((asked) => asked.read)).toEqual(["readPickedKinds"]);
  });

  it("a call at another step: wrongStep", async () => {
    const run = harness();
    const steps = mobileIdSteps(run.deps);
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    const error = await refusal(steps.writers["S1-10"](writerCall(turn, s1_09Step(), OWNER_MATCHES)));
    expect(error).toBeInstanceOf(MobileIdRefusedError);
    expect(error).toMatchObject({ fault: "wrongStep", ids: ["S1-10", "S1-09"] });
  });

  it("a turn with no service or chat id: the walk's own noServiceOrChatId", async () => {
    const run = harness();
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    Reflect.deleteProperty(turn.request.turn as object, "service");
    const error = await refusal(walked(turn, run.deps));
    expect(error).toBeInstanceOf(WalkRefusedError);
    expect(error).toMatchObject({ fault: "noServiceOrChatId" });
  });
});

describe("default 210: the owner's ports, and the reads' checks (fail closed)", () => {
  it("with no stop reads bound the owner's claim answers notBuilt (stopNotWired) before anything is read", async () => {
    const run = harness({ stop: null });
    // S1-09's settler alone, then S1-10's writer (S1-09's own read-back would answer stopNotWired first).
    const steps = mobileIdSteps(run.deps);
    const turn = s1_09Turn(OWNER_MATCHES, RULING_WORDS);
    await steps.settlers["S1-09"](settlerCall(turn));
    const error = await refusal(steps.writers["S1-10"](writerCall(turn, s1_10Step(), OWNER_MATCHES)));
    expect(error).toBeInstanceOf(MobileIdNotBuiltError);
    expect(error).toBeInstanceOf(NotBuiltError);
    expect(error).toMatchObject({ seam: "stopNotWired" });
    expect(run.k05.asked).toEqual([]);
  });

  it("with no link port, or one whose host or base path is not a link's, it answers notBuilt (linkNotWired)", async () => {
    for (const link of [
      null,
      (stage: RecordingStage) => ({ ...linkDeps(stage), host: "" }),
      (stage: RecordingStage) => ({ ...linkDeps(stage), basePath: "test" }),
    ]) {
      const run = harness({ link });
      const error = await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), run.deps));
      expect(error).toBeInstanceOf(MobileIdNotBuiltError);
      expect(error).toMatchObject({ seam: "linkNotWired" });
      expect(run.k05.asked).toEqual([]);
      expect(run.stage.staged).toEqual([]);
    }
  });

  it("K-05's error answers fail closed as MobileIdReadError, never read as none", async () => {
    const transient = harness({ given: { turnState: { error: "transient", sqlstate: "40001" } } });
    const error = await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), transient.deps));
    expect(error).toBeInstanceOf(MobileIdReadError);
    expect(error).toMatchObject({ read: "readTurnState", fault: "transient" });

    const handleGone = harness({
      given: { turnState: { error: "notFound", table: "handles", rowId: SAM_HANDLE } },
    });
    const gone = await refusal(walked(s1_09Turn(OWNER_MATCHES, RULING_WORDS), handleGone.deps));
    expect(gone).toMatchObject({ read: "readTurnState", fault: "notFound" });
  });

  it("an answer for another handle or business, or an accounts fact that does not read as one row, is notWellFormed", async () => {
    const asked = { handleId: SAM_HANDLE, businessId: SAM_BUSINESS, personId: SAM_PERSON };
    const repo: WalkTestRepo = s1_09Turn(OWNER_MATCHES, RULING_WORDS).context.repo;
    const badMobile = { mobile: 5, mobileProvenAt: null, version: 1 } as unknown as AccountOnFile;
    const reads = mobileIdReadsOf(fakeMobileIdK05({ account: badMobile }).k05);
    await expect(reads.account(repo, asked)).rejects.toMatchObject({ fault: "notWellFormed" });

    const base = fakeMobileIdK05({ account: { mobile: null, mobileProvenAt: null, version: 1 } }).k05;
    for (const change of [{ handleId: "handle-alex" }, { businessId: "biz-lee-home-services" }]) {
      const wrong = mobileIdReadsOf<WalkTestRepo>({
        readPickedKinds: (request) => base.readPickedKinds(request),
        readTurnState: async (on, request) => {
          const answer = await base.readTurnState(on, request);
          return "error" in answer ? answer : { ...answer, ...change };
        },
      });
      await expect(wrong.turnHandle(repo, asked)).rejects.toMatchObject({ fault: "notWellFormed" });
      await expect(wrong.account(repo, asked)).rejects.toMatchObject({ fault: "notWellFormed" });
    }
  });

  it("a notFound naming another row than the caller's accounts row is no 'none on file'", async () => {
    const reads = mobileIdReadsOf(
      fakeMobileIdK05({ turnState: { error: "notFound", table: "accounts", rowId: "person-alex" } }).k05,
    );
    await expect(
      reads.account(undefined as never, {
        handleId: SAM_HANDLE,
        businessId: SAM_BUSINESS,
        personId: SAM_PERSON,
      }),
    ).rejects.toMatchObject({ fault: "notFound" });
  });
});

describe("the commit's walk on bundle v3 with the real writers (T-1532's wait; never id_checked)", () => {
  /** The S1-09 turn on bundle v3 naming `branch`, its part carrying the `business` field's words. */
  function v3Answer(branch: string, words: string) {
    const turn = turnS1_09OnV3(branch);
    const verbPart = { ...turn.part.part, fields: [{ name: "business", value: words, words }] };
    const part = { ...turn.part, part: verbPart } as PassedPart;
    return { part, context: turn.context };
  }

  function v3Walk(run: Harness) {
    const steps = mobileIdSteps(run.deps);
    return createWritesOf<WalkTestRepo>({
      bundles: bundleV3Bundles().bundles,
      turnKey: () => SAM,
      questions: questionsOver([s1_09QuestionRow()]).questions,
      settlers: (stepId) => (stepId === "S1-09" ? steps.settlers["S1-09"] : null),
      writers: (stepId) =>
        stepId === "S1-09" || stepId === "S1-76" || stepId === "S1-10" ? steps.writers[stepId] : null,
    });
  }

  it("the owner's answer: S1-09's question closed, S1-09's rows, then S1-10's; gives business and mobile, never id_checked", async () => {
    const run = harness();
    const { part, context } = v3Answer(OWNER_MATCHES, RULING_WORDS);
    const writes = await v3Walk(run)(part, context, NOTHING_OPEN);
    expect(writes.closes.map((close) => close.id)).toEqual([S1_09_QUESTION]);
    expect(writes.asks).toEqual([]);
    expect(writes.gives).toEqual(["business", "mobile"]);
    expect(writes.state.map((write) => [write.op, write.table])).toEqual([
      ["update", "businesses"],
      ["insert", "business_setup"],
      ["insert", "accounts"],
      ["insert", "page_links"],
    ]);
    expect(writes.messages.map((row) => [row.id, row.step, row.lineNo, row.openQuestionId])).toEqual([
      ["outbox-s1-09-sam-1", "S1-09", 1, null],
      ["outbox-s1-10-sam-1", "S1-10", 2, null],
    ]);
    expect(run.stage.staged.map((each) => [each.turnId, each.outboxRowId])).toEqual([
      [context.turn.id, "outbox-s1-10-sam-1"],
    ]);
    expect(pageLinkOf(writes).id).toBe("link-s1-10-sam-1");
  });

  it("a helper with no match: S1-09's rows, S1-76's, then the helper's own accounts row alone", async () => {
    const run = harness();
    const { part, context } = v3Answer(HELPS_RUN_IT, MADE_UP_WORDS);
    const writes = await v3Walk(run)(part, context, NOTHING_OPEN);
    expect(writes.gives).toEqual(["business", "mobile"]);
    expect(writes.state.filter((write) => ["accounts", "page_links"].includes(write.table))).toEqual([
      SAM_ACCOUNT_INSERT,
    ]);
    expect(writes.messages.map((row) => row.step)).toEqual(["S1-76"]);
    expect(run.stage.staged).toEqual([]);
  });
});

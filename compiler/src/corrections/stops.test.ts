// T-141, the stop-first lines per Q-30 (SPEC-master 5j; RULES 4.1b, 4.3, 1.11; S13-01, S13-02, S13-32; MC C9).
// Proofs of the card that belong to stops.ts:
//   - the master has 53 stop: "first" markers in flow A and 54 in flow B;
//   - on every money path of the corrected flows (barber, the master's words, both flows), the opt-out line renders
//     only on Rosie's first reply in a chat the person opened: `true` where it is that on every walk, "first" where it
//     depends on the walk, and never on a text to a chat nobody opened or on a later reply;
//   - every number that opens its chat on a path gets the line on Rosie's first reply there, the reply S13-01's opener
//     rides (S13-01 says so after C9), and the rendered text carries the opt-out line word for word;
//   - settleStops() moves the line by the walk's record, whether or not the master marked the message.
// Round 3 (DL-211): a chat belongs to a person, not a role word. These proofs say who each message goes to on their
// own, from the master's words, and never read the walk's records (walk.texts):
//   - on the helper path (S1-09 "Helps run it; not an owner"), S1-77's text to the real owner (the message the master
//     writes unnamed, after the owner's ready text) carries the opt-out line and the privacy link, and the helper's chat
//     (the signup chat, with S1-77's messages named for the helper) carries the line exactly once;
//   - S1-10's first reply in the chat the person's mobile opens (their text from that mobile) carries it;
//   - over the swept trades (every money path of 17 trades, and every path of barber), both flows, each person's chat
//     carries the line exactly once, on Rosie's first reply in it, on every walk: the test walks the flow itself, every
//     walk with no cap, and names each message's person by its own rule. The same sweep over all 243 trades (every money
//     path, both flows) is parity.shard-9.test.ts, in the parity project (T-1116; T-1067), outside `npm test`.
// T-1116: the lint's walk (lint/runner.ts) places the line with walkStops, a branch's `sets` followed, not with the
// master's applyStops.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FlowLetter, Message } from "../graph/types.ts";
import { lintContext, tradeInput } from "../lint/runner";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { plainText } from "../msgtext";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import { tradePaths, walkPath, type TradePath } from "../path";
import { FIRST_REPLY_LINES, FROM_MOBILE } from "./c9";
import { applyCorrections, type CorrectedTrade } from "./framework";
import { placedStops, settleStops, stopFor, walkStops, type ChatText, type StopWalk } from "./stops";

vi.setConfig({ testTimeout: 300_000 });

const master = loadMaster();
const FLOWS: readonly FlowLetter[] = ["A", "B"];

const fixedLines = JSON.parse(
  readFileSync(new URL("../../../contracts/bundle/fixtures/fixed-lines.json", import.meta.url), "utf8"),
) as { lines: { id: string; text: string | null }[] };
const OPT_OUT = fixedLines.lines.find((line) => line.id === "optOutLine")?.text ?? "";

type Line = readonly unknown[];

function rec(fields: Partial<ChatText>): ChatText {
  return { to: "staff", unopened: false, first: false, later: false, stop: null, ...fields };
}

describe("settleStops: the line by the walk's record", () => {
  const step = {
    id: "S9-01",
    say: [
      ["san", "staff", "first writer", { stop: "first", as: "Kim" }],
      ["staff", "san", "hello", { as: "Kim" }],
      ["san", "staff", "first reply", { as: "Kim" }],
      ["san", "staff", "later reply", { stop: true, as: "Kim" }],
      ["san", "staff", "first on some walks"],
    ],
  } as unknown as AppliedStep;

  it("puts the line on the first reply, takes it off a first writer and a later reply, and keeps 'first' where it depends", () => {
    const settled = settleStops(step, {
      0: rec({ unopened: true, stop: "first" }),
      2: rec({ first: true }),
      3: rec({ later: true, stop: true }),
      4: rec({ first: true, later: true }),
    });
    const marks = (settled.say ?? []).map(
      (message) => (message as Line)[3] as { stop?: unknown } | undefined,
    );
    expect(marks.map((elements) => elements?.stop)).toStrictEqual([
      undefined,
      undefined,
      true,
      undefined,
      "first",
    ]);
    expect((settled.say?.[0] as Line)[3]).toStrictEqual({ as: "Kim" });
    expect(step.say?.[0]).toStrictEqual(["san", "staff", "first writer", { stop: "first", as: "Kim" }]);
  });

  it("gives a text no line when it is never a first reply, and the step as it is when nothing changes", () => {
    expect(stopFor(undefined)).toBeUndefined();
    expect(stopFor(rec({ unopened: true }))).toBeUndefined();
    expect(stopFor(rec({ first: true }))).toBe(true);
    expect(stopFor(rec({ first: true, unopened: true }))).toBe("first");
    const plain = { id: "S9-02", say: [["san", "owner", "hi"]] } as unknown as AppliedStep;
    expect(settleStops(plain, undefined)).toBe(plain);
  });
});

describe('the stop: "first" markers per Q-30', () => {
  it("counts 53 markers in flow A and 54 in flow B", () => {
    const counts = FLOWS.map((flow) => {
      let n = 0;
      for (const step of Object.values(master[flow].steps)) {
        const lists: Line[][] = [step.say ?? []];
        for (const patch of Object.values(step.vary ?? {})) {
          const words = patch as { say?: Line[]; addSay?: Line[] };
          lists.push(words.say ?? [], words.addSay ?? []);
        }
        for (const list of lists)
          for (const message of list)
            if ((message[3] as { stop?: unknown } | undefined)?.stop === "first") n += 1;
      }
      return n;
    });
    expect(counts).toStrictEqual([53, 54]);
  });

  it("renders the line only on Rosie's first reply in an opened chat, on every money path of both corrected flows", () => {
    const trade = loadTrade("barber");
    for (const flow of FLOWS) {
      const done = applyCorrections(applyTrade(master[flow], trade));
      const paths = tradePaths(done, trade, { booking: false, fixtures: false });
      expect(paths.length).toBeGreaterThan(0);
      let rendered = 0;
      for (const path of paths) {
        const walk = walkStops(done, path);
        const where = `${flow} ${path.price}|${path.before}|${path.after}`;
        const placed = placedStops(walk);
        for (const mark of placed) {
          const text = walk.texts[mark.step]?.[mark.index];
          expect(text?.first, `${where} ${mark.step} say[${String(mark.index)}]`).toBe(true);
          if (mark.stop === true) {
            expect(text?.later, `${where} ${mark.step}: a later reply`).toBe(false);
            expect(text?.unopened, `${where} ${mark.step}: a chat nobody opened`).toBe(false);
          }
        }
        // Every number with a first reply on the path gets the line there, and nothing else carries it.
        const firsts = new Set<string>();
        for (const [id, byIndex] of Object.entries(walk.texts))
          for (const [index, text] of Object.entries(byIndex)) if (text.first) firsts.add(`${id} ${index}`);
        expect(new Set(placed.map((mark) => `${mark.step} ${String(mark.index)}`))).toStrictEqual(firsts);
        // The rendered words carry the opt-out line word for word.
        for (const mark of placed.filter((one) => one.stop === true)) {
          const message = walk.steps.find((entry) => entry.id === mark.step)?.words.say?.[mark.index];
          expect(plainText(message as unknown as Message), where).toContain(OPT_OUT);
          rendered += 1;
        }
      }
      expect(rendered, `${flow}: the line renders somewhere`).toBeGreaterThan(0);
    }
  });

  it("puts the line on staff's first reply after their ready text, not on an invite (S2-05, S2-06)", () => {
    const trade = loadTrade("barber");
    for (const flow of FLOWS) {
      const done = applyCorrections(applyTrade(master[flow], trade));
      const path = tradePaths(done, trade, { booking: false, fixtures: false })[0];
      if (path === undefined) throw new Error(`${flow}: no path`);
      const placed = placedStops(walkStops(done, path));
      expect(placed.some((mark) => mark.step === "S2-05")).toBe(false);
      expect(placed.some((mark) => mark.step === "S2-06" && mark.to.startsWith("staff"))).toBe(true);
    }
  });

  it("says in S13-01 that the opener, the opt-out line and the privacy link ride that first reply", () => {
    for (const flow of FLOWS) {
      const done = applyCorrections(applyTrade(master[flow], loadTrade("barber")));
      const more = done.flow.steps.find((step) => step.id === "S13-01")?.more ?? [];
      for (const line of FIRST_REPLY_LINES) expect(more).toContain(line);
    }
  });
});

// ---- Round 3 (DL-211): who each message goes to, stated by this file, never read from walk.texts. ----

/** The trades of the card's other proofs: barber has the master's words; aba and deck rename the business. */
const TRADES = ["barber", "aba", "deck"] as const;

/** S1-09's branch whose person is a helper, not an owner (master-A.json:635-725). */
const HELPER_BRANCH = "Helps run it; not an owner";
/** S1-09's other branches, where the person texting is an owner (master-A.json:630-634, :726-759). */
const OWNER_BRANCHES: readonly string[] = ["An owner; the listing matches", "No match, or already listed"];
/** The name the master gives the helper in S1-77 (`as`, master-A.json:679 and :688). */
const HELPER = "Pat";

const memo = new Map<string, CorrectedTrade>();
function corrected(id: string, flow: FlowLetter): CorrectedTrade {
  const key = `${id} ${flow}`;
  let done = memo.get(key);
  if (done === undefined) {
    done = applyCorrections(applyTrade(master[flow], loadTrade(id)));
    memo.set(key, done);
  }
  return done;
}

function elementsOf(message: Line | undefined): { as?: unknown; stop?: unknown; card?: unknown } | undefined {
  const elements = message?.[3];
  return typeof elements === "object" && elements !== null && !Array.isArray(elements) ? elements : undefined;
}

/** The name a message gives its person (`as`), or undefined when it gives none. */
function nameIn(message: Line | undefined): string | undefined {
  const as = elementsOf(message)?.as;
  return typeof as === "string" && as !== "" ? as : undefined;
}

/** The step's words on the walked path, the opt-out line settled. */
function sayOn(walk: StopWalk, id: string): readonly Line[] {
  return walk.steps.find((entry) => entry.id === id)?.words.say ?? [];
}

function marked(message: Line | undefined): boolean {
  const stop = elementsOf(message)?.stop;
  return stop === true || stop === "first";
}

function rendered(message: Line | undefined): string {
  return plainText(message as unknown as Message);
}

describe("a chat belongs to a person, not a role word (DL-211)", () => {
  it("on the helper path, gives S1-77's text to the real owner the opt-out line and the privacy link, and the helper's chat the line once", () => {
    for (const id of TRADES)
      for (const flow of FLOWS) {
        const done = corrected(id, flow);
        const paths = tradePaths(done, loadTrade(id), { booking: false, fixtures: false });
        expect(paths.length).toBeGreaterThan(0);
        // The opener and the privacy link are fixed lines the run time puts on the message the line renders on (C-089).
        expect(done.flow.steps.find((step) => step.id === "S13-01")?.more ?? []).toContain(
          "That reply carries the opener, the opt-out line and the privacy link.",
        );
        for (const path of paths) {
          const walk = walkStops(done, path);
          const where = `${id} ${flow} ${path.price}|${path.before}|${path.after}`;
          // S1-77, from the master's words: what it says to and from the owner lane named Pat is the helper's; what
          // it says unnamed is the real owner's, whose ready text opens their chat before Rosie's text to them.
          const s177 = sayOn(walk, "S1-77");
          const ready = s177.findIndex(
            (message) => message[0] === "owner" && message[1] === "san" && nameIn(message) === undefined,
          );
          const toOwner = s177.findIndex(
            (message, k) =>
              k > ready && message[0] === "san" && message[1] === "owner" && nameIn(message) === undefined,
          );
          expect(ready, `${where}: the real owner's ready text`).toBeGreaterThanOrEqual(0);
          expect(toOwner, `${where}: Rosie's text to the real owner`).toBeGreaterThan(ready);
          const first = s177[toOwner];
          expect(String(first?.[2]), where).toContain("named you as the owner");
          expect(elementsOf(first)?.stop, `${where}: the line on the real owner's first reply`).toBe(true);
          expect(rendered(first), where).toContain(OPT_OUT);
          // The helper's chat on this path: Rosie's unnamed texts to the owner lane in each step the path lights up
          // to S1-10 and off S1-09's owner branches (the person S1-09 asks "are you an owner?" is the helper here),
          // S1-77's texts named Pat, and S1-10's texts before the person texts from their mobile.
          const chat: { at: string; message: Line }[] = [];
          for (const entry of walk.steps) {
            if (entry.trail.some((label) => OWNER_BRANCHES.includes(label))) continue;
            const say = (entry.words.say ?? []) as Line[];
            const mobile = entry.id === "S1-10" ? say.findIndex((message) => message[2] === FROM_MOBILE) : -1;
            say.forEach((message, k) => {
              if (message[0] !== "san" || message[1] !== "owner") return;
              if (mobile >= 0 && k > mobile) return;
              if (entry.id === "S1-77" ? nameIn(message) !== HELPER : nameIn(message) !== undefined) return;
              chat.push({ at: `${entry.id} say[${String(k)}]`, message });
            });
            if (entry.id === "S1-10") break;
          }
          expect(
            chat.some((text) => text.at.startsWith("S1-77 ")),
            `${where}: S1-77 texts the helper`,
          ).toBe(true);
          const lines = chat.filter((text) => marked(text.message));
          expect(
            lines.map((text) => text.at),
            `${where}: the helper's chat has the line once, on Rosie's first reply`,
          ).toStrictEqual([chat[0]?.at]);
          expect(elementsOf(lines[0]?.message)?.stop, where).toBe(true);
          expect(rendered(lines[0]?.message), where).toContain(OPT_OUT);
        }
      }
  });

  it("gives S1-10's first reply in the chat the person's mobile opens the line, and no other S1-10 text", () => {
    for (const id of TRADES)
      for (const flow of FLOWS) {
        const done = corrected(id, flow);
        for (const path of tradePaths(done, loadTrade(id), { booking: false, fixtures: false })) {
          const where = `${id} ${flow} ${path.price}|${path.before}|${path.after}`;
          // S1-10, from its words: the person names the one mobile only they use, Rosie asks them to text from it,
          // their text from it opens that mobile's chat, and Rosie's next text, the secure ID check, is her first reply
          // there. Every text before it is in the chat they were texting in, which had Rosie's first reply already.
          const s110 = sayOn(walkStops(done, path), "S1-10");
          const from = s110.findIndex(
            (message) => message[0] === "owner" && message[1] === "san" && message[2] === FROM_MOBILE,
          );
          const reply = s110.findIndex(
            (message, k) => k > from && message[0] === "san" && message[1] === "owner",
          );
          expect(from, `${where}: the text from that mobile`).toBeGreaterThanOrEqual(0);
          expect(reply, `${where}: Rosie's first reply in the mobile's chat`).toBeGreaterThan(from);
          expect(elementsOf(s110[reply])?.card, `${where}: the secure ID check`).toBeTypeOf("object");
          expect(elementsOf(s110[reply])?.stop, where).toBe(true);
          expect(rendered(s110[reply]), where).toContain(OPT_OUT);
          expect(
            s110.filter((message, k) => k !== reply && marked(message)),
            `${where}: no other text of S1-10 has the line`,
          ).toStrictEqual([]);
        }
      }
  });
});

// The sweep's own statement of who each message goes to, and its own walk.
//
// A message is a text when its step texts (via msg, auto or portal; a rule node is never walked) and it goes between
// Rosie and a lane with a number (cust, owner, staff, other), except to the booking customer on a booking that takes no
// texts (reach callsonly, email or notsafe). Its person is its lane with the name it gives (`as`; for the step's
// customer or staff, the step's `as`), and the lane alone for the lane's own person (the flow's names). On S1-09's
// helper branch the person who has been texting as the owner is the helper S1-77 names, so from there on the owner
// lane's unnamed messages are the helper's, except S1-77's own, which are the real owner's. A person who texts Rosie
// from their mobile at S1-10 is in that mobile's chat from then on. A walk goes through the lit steps in page order,
// takes one lit branch of each split, and ends where that branch ends. On each walk, each chat has the line on Rosie's
// first reply in it (stop true, or "first", which renders on a first reply) and on no later text, and no text to a chat
// nobody opened has it ("first" renders only on a first reply, so it renders once).

const LANES: readonly string[] = ["cust", "owner", "staff", "other"];
const TEXT_WAYS: readonly string[] = ["msg", "auto", "portal"];
const NO_TEXTS: readonly string[] = ["callsonly", "email", "notsafe"];

/**
 * The trades the sweep walks: the three above, and every 16th trade of the sorted list. It walks every money path of
 * each, and every booking and fixture path of barber too. All of them, on all 243 trades, take minutes: that sweep is
 * parity.shard-9.test.ts, in the parity project, outside `npm test` (T-1067, T-1116).
 */
const SWEPT: readonly string[] = [...new Set([...TRADES, ...listTradeIds().filter((_, k) => k % 16 === 0)])];
/** The trades whose booking and fixture paths the sweep walks as well. */
const EVERY_PATH: readonly string[] = ["barber"];

interface Seen {
  opened: ReadonlySet<string>;
  replied: ReadonlySet<string>;
  /** The helper's name on S1-09's helper branch, null elsewhere. */
  helper: string | null;
  /** The people who have texted Rosie from their mobile. */
  mobile: ReadonlySet<string>;
}

function seenKey(seen: Seen): string {
  const list = (tag: string, set: ReadonlySet<string>) => [...set].sort().map((one) => `${tag} ${one}`);
  return [
    `h ${seen.helper ?? ""}`,
    ...list("o", seen.opened),
    ...list("r", seen.replied),
    ...list("m", seen.mobile),
  ].join("|");
}

function distinct(walks: readonly Seen[]): Seen[] {
  const out = new Map<string, Seen>();
  for (const seen of walks) out.set(seenKey(seen), seen);
  return [...out.values()];
}

function findStep(steps: readonly AppliedStep[], id: string): AppliedStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    for (const branch of step.branches ?? []) {
      const hit = findStep(branch.steps, id);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** On S1-09's helper branch: the person who has texted as the owner so far is the helper, so their chats are the helper's. */
function helperWalk(seen: Seen, helper: string): Seen {
  const theirs = (set: ReadonlySet<string>) =>
    new Set(
      [...set].map((chat) =>
        chat === "owner" ? `owner:${helper}` : chat === "owner@mobile" ? `owner:${helper}@mobile` : chat,
      ),
    );
  return { opened: theirs(seen.opened), replied: theirs(seen.replied), helper, mobile: theirs(seen.mobile) };
}

function personIn(
  step: AppliedStep,
  lane: string,
  message: Line,
  names: Readonly<Record<string, string>>,
  seen: Seen,
): string {
  const ofStep =
    typeof step.as === "string" &&
    step.as !== "" &&
    (lane === "cust" || lane === "staff") &&
    (lane === step.to || lane === step.who)
      ? step.as
      : undefined;
  const name = nameIn(message) ?? ofStep;
  if (name === undefined)
    return lane === "owner" && seen.helper !== null && step.id !== "S1-77" ? `owner:${seen.helper}` : lane;
  return name === names[lane] ? lane : `${lane}:${name}`;
}

/** The sweep on one path: what breaks "the line once per chat, on Rosie's first reply", and how many first replies. */
function chatLines(done: CorrectedTrade, path: TradePath): { problems: string[]; firsts: number } {
  const walk = walkStops(done, path);
  const lit = new Map(walk.steps.map((entry) => [entry.id, entry]));
  const names = done.flow.names;
  const helper =
    (findStep(done.flow.steps, "S1-77")?.say ?? [])
      .map((message) => nameIn(message as Line))
      .find((name) => name !== undefined && name !== names.owner) ?? null;
  const problems: string[] = [];
  const firstOn = new Map<string, { first: boolean; other: boolean }>();
  let firsts = 0;
  const visit = (list: readonly AppliedStep[], walks: Seen[]): Seen[] => {
    let current = walks;
    for (const step of list) {
      const entry = lit.get(step.id);
      if (entry === undefined || step.kind === "rule") continue;
      const say = (entry.words.say ?? []) as Line[];
      const texts = TEXT_WAYS.includes(step.via);
      current = distinct(
        current.map((seen) => {
          const opened = new Set(seen.opened);
          const replied = new Set(seen.replied);
          const mobile = new Set(seen.mobile);
          say.forEach((message, k) => {
            const at = `${step.id} say[${String(k)}]`;
            const stop = elementsOf(message)?.stop;
            if (texts && message[1] === "san" && LANES.includes(String(message[0]))) {
              const person = personIn(step, String(message[0]), message, names, seen);
              if (step.id === "S1-10" && message[2] === FROM_MOBILE) mobile.add(person);
              opened.add(mobile.has(person) ? `${person}@mobile` : person);
              return;
            }
            const person =
              texts && message[0] === "san" && LANES.includes(String(message[1]))
                ? personIn(step, String(message[1]), message, names, seen)
                : null;
            if (person === null || (person === "cust" && NO_TEXTS.includes(path.booking?.reach ?? "")))
              return;
            const chat = mobile.has(person) ? `${person}@mobile` : person;
            const on = firstOn.get(at) ?? { first: false, other: false };
            firstOn.set(at, on);
            if (!opened.has(chat)) {
              on.other = true;
              if (stop === true)
                problems.push(`${at}: the line on a text to ${chat}, whose chat nobody opened`);
            } else if (replied.has(chat)) {
              on.other = true;
              if (stop === true) problems.push(`${at}: a second line in ${chat}'s chat`);
            } else {
              on.first = true;
              firsts += 1;
              replied.add(chat);
              if (stop !== true && stop !== "first")
                problems.push(`${at}: Rosie's first reply in ${chat}'s chat has no line`);
            }
          });
          return { opened, replied, helper: seen.helper, mobile };
        }),
      );
      if (step.type !== "split") continue;
      let merged: Seen[] = [];
      (step.branches ?? []).forEach((branch, b) => {
        if (entry.branches[b]?.lit !== true) return;
        const into =
          step.id === "S1-09" && branch.label === HELPER_BRANCH && helper !== null
            ? current.map((seen) => helperWalk(seen, helper))
            : current;
        const after = visit(branch.steps, into);
        if ((branch.end ?? "merge") !== "end") merged = merged.concat(after);
      });
      if (merged.length === 0) return [];
      current = distinct(merged);
    }
    return current;
  };
  visit(done.flow.steps, [{ opened: new Set(), replied: new Set(), helper: null, mobile: new Set() }]);
  // No line anywhere else: every marked message is Rosie's first reply in a chat on some walk, and "first" only where
  // that depends on the walk (where it is a first reply on every walk, the line is sure: true).
  for (const entry of walk.steps)
    ((entry.words.say ?? []) as Line[]).forEach((message, k) => {
      if (!marked(message)) return;
      const at = `${entry.id} say[${String(k)}]`;
      const on = firstOn.get(at);
      if (on?.first !== true) problems.push(`${at}: a line on a text that is never a first reply`);
      else if (elementsOf(message)?.stop === "first" && !on.other)
        problems.push(`${at}: "first" where it is a first reply on every walk`);
    });
  return { problems, firsts };
}

describe(`the line once per person's chat, over the paths of ${String(SWEPT.length)} swept trades (DL-211)`, () => {
  for (const id of SWEPT) {
    const every = EVERY_PATH.includes(id);
    it(`${id}: each person's chat has the line exactly once, on Rosie's first reply in it, on every walk of every ${every ? "" : "money "}path`, () => {
      const trade = loadTrade(id);
      for (const flow of FLOWS) {
        const done = applyCorrections(applyTrade(master[flow], trade));
        const paths = tradePaths(done, trade, every ? {} : { booking: false, fixtures: false });
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          const { problems, firsts } = chatLines(done, path);
          const where = `${id} ${flow} ${path.kind} ${path.price}|${path.before}|${path.after} ${JSON.stringify(path.booking ?? {})} ${path.fixture ?? ""}`;
          expect([...new Set(problems)], where).toStrictEqual([]);
          expect(firsts, `${where}: first replies`).toBeGreaterThan(0);
        }
      }
    });
  }
});

describe("the lint walks with walkStops (T-1116)", () => {
  it("a trade's lint walk is walkStops' with a branch's sets followed: staff's first reply in S2-06 has the line, where the master's applyStops leaves it none", () => {
    const trade = loadTrade("barber");
    for (const flow of FLOWS) {
      const done = corrected("barber", flow);
      const ctx = lintContext(tradeInput(done, trade));
      const money = ctx.paths().filter((path) => path.kind === "money");
      expect(money.length).toBeGreaterThan(0);
      for (const path of money) {
        const where = `${flow} ${path.price}|${path.before}|${path.after}`;
        const linted = ctx.walk(path).steps;
        // The steps the lint reads are walkPath's, a branch's `sets` followed (one entry per reading), ...
        expect(
          linted.map((entry) => entry.id),
          where,
        ).toStrictEqual(walkPath(done, path).steps.map((entry) => entry.id));
        // ... with the words walkStops settles on them.
        expect(
          linted.map((entry) => entry.words),
          where,
        ).toStrictEqual(walkStops(done, path, { sets: true }).steps.map((entry) => entry.words));
        // S2-06, from its words: the staff member's text opens their chat, and Rosie's next text to them is her first
        // reply there. The lint's walk gives it the line; the master's applyStops (walkPath) gives it none, since C9 took
        // the marked invite that was the first text away.
        const s206 = linted.find((entry) => entry.id === "S2-06")?.words.say ?? [];
        const opened = s206.findIndex((message) => message[0] === "staff" && message[1] === "san");
        const reply = s206.findIndex(
          (message, k) =>
            k > opened &&
            message[0] === "san" &&
            message[1] === "staff" &&
            nameIn(message) === nameIn(s206[opened]),
        );
        expect(opened, where).toBeGreaterThanOrEqual(0);
        expect(reply, where).toBeGreaterThan(opened);
        expect(elementsOf(s206[reply])?.stop, `${where}: the lint's walk`).toBe(true);
        expect(rendered(s206[reply]), where).toContain(OPT_OUT);
        const master = walkPath(done, path).steps.find((entry) => entry.id === "S2-06")?.words.say ?? [];
        expect(elementsOf(master[reply])?.stop, `${where}: the master's applyStops`).toBeUndefined();
      }
    }
  });
});

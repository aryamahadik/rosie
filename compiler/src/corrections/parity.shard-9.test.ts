// T-1116: the opt-out line once in each person's chat, on Rosie's first reply in it, over all 243 trades x both flows x
// every money path (Q-30; Master Corrections C9; DL-211, DL-226). Not a ninth slice of parity.ts's sweep: its own file,
// in T-1067's parity project (the glob compiler/src/**/parity.shard-*.test.ts), outside `npm test`.
//
// stops.test.ts runs the same sweep on 17 trades inside `npm test` (barber, aba, deck and every 16th trade); this file
// runs it on every trade. Its statement of who each message goes to, its walk and its checks are stops.test.ts's,
// copied (a test file cannot import another without running its tests, and the statement must stay apart from
// stops.ts: it never reads walk.texts), with one change of cost and none of answer: a walk's state is copied only when
// a text changes it, and a step that texts nobody (it does not text, or no message goes between Rosie and a person) is
// passed over, where stops.test.ts copies every state at every step to the same result. The two statements change
// together.
//
// The statement. A message is a text when its step texts (via msg, auto or portal; a rule node is never walked) and it
// goes between Rosie and a lane with a number (cust, owner, staff, other), except to the booking customer on a booking
// that takes no texts (reach callsonly, email or notsafe). Its person is its lane with the name it gives (`as`; for the
// step's customer or staff, the step's `as`), and the lane alone for the lane's own person (the flow's names). On S1-09's
// helper branch the person who has been texting as the owner is the helper S1-77 names, so from there on the owner
// lane's unnamed messages are the helper's, except S1-77's own, which are the real owner's. A person who texts Rosie
// from their mobile at S1-10 is in that mobile's chat from then on. A walk goes through the lit steps in page order,
// takes one lit branch of each split, and ends where that branch ends. On each walk, each chat has the line on Rosie's
// first reply in it (stop true, or "first", which renders on a first reply) and on no later text, and no text to a chat
// nobody opened has it ("first" renders only on a first reply, so it renders once).
//
// One trade is about a second on the build Mac (applyTrade and the corrections for both flows, then each money path
// walked twice: by walkStops and by this file's own walk), so the whole sweep takes about 5 minutes: each trade is its
// own test.
import { describe, expect, it } from "vitest";
import type { FlowLetter } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { listTradeIds, loadTrade } from "../load/trade";
import { applyTrade, type AppliedStep } from "../overlay/apply";
import { tradePaths, type TradePath } from "../path";
import { FROM_MOBILE } from "./c9";
import { applyCorrections, type CorrectedTrade } from "./framework";
import { walkStops } from "./stops";

const FLOWS: readonly FlowLetter[] = ["A", "B"];
const LANES: readonly string[] = ["cust", "owner", "staff", "other"];
const TEXT_WAYS: readonly string[] = ["msg", "auto", "portal"];
const NO_TEXTS: readonly string[] = ["callsonly", "email", "notsafe"];
/** S1-09's branch whose person is a helper, not an owner (master-A.json:635-725). */
const HELPER_BRANCH = "Helps run it; not an owner";

type Line = readonly unknown[];

function elementsOf(message: Line | undefined): { as?: unknown; stop?: unknown } | undefined {
  const elements = message?.[3];
  return typeof elements === "object" && elements !== null && !Array.isArray(elements) ? elements : undefined;
}

/** The name a message gives its person (`as`), or undefined when it gives none. */
function nameIn(message: Line | undefined): string | undefined {
  const as = elementsOf(message)?.as;
  return typeof as === "string" && as !== "" ? as : undefined;
}

function marked(message: Line | undefined): boolean {
  const stop = elementsOf(message)?.stop;
  return stop === true || stop === "first";
}

interface Seen {
  opened: ReadonlySet<string>;
  replied: ReadonlySet<string>;
  /** The helper's name on S1-09's helper branch, null elsewhere. */
  helper: string | null;
  /** The people who have texted Rosie from their mobile. */
  mobile: ReadonlySet<string>;
  /** The walk's state as one text (seenKey), made once with the state. */
  key: string;
}

function seenKey(seen: Omit<Seen, "key">): string {
  const list = (tag: string, set: ReadonlySet<string>) => [...set].sort().map((one) => `${tag} ${one}`);
  return [
    `h ${seen.helper ?? ""}`,
    ...list("o", seen.opened),
    ...list("r", seen.replied),
    ...list("m", seen.mobile),
  ].join("|");
}

function made(seen: Omit<Seen, "key">): Seen {
  return { ...seen, key: seenKey(seen) };
}

function distinct(walks: readonly Seen[]): Seen[] {
  const out = new Map<string, Seen>();
  for (const seen of walks) out.set(seen.key, seen);
  return [...out.values()];
}

/** The set with `item` in it: the same set when it is there already, else a new one. */
function withItem(set: ReadonlySet<string>, item: string): ReadonlySet<string> {
  return set.has(item) ? set : new Set([...set, item]);
}

/** A message between Rosie and a lane with a number: in a step that texts, the only kind that opens or answers a chat. */
function chatMessage(message: Line): boolean {
  return (
    (message[1] === "san" && LANES.includes(String(message[0]))) ||
    (message[0] === "san" && LANES.includes(String(message[1])))
  );
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
  return made({
    opened: theirs(seen.opened),
    replied: theirs(seen.replied),
    helper,
    mobile: theirs(seen.mobile),
  });
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
      // A step that texts nobody (it does not text, or no message goes between Rosie and a person) leaves every walk
      // as it is: it is passed over. A walk's state is copied only when one of the step's texts changes it.
      if (TEXT_WAYS.includes(step.via) && say.some(chatMessage))
        current = distinct(
          current.map((seen) => {
            let opened = seen.opened;
            let replied = seen.replied;
            let mobile = seen.mobile;
            say.forEach((message, k) => {
              const at = `${step.id} say[${String(k)}]`;
              const stop = elementsOf(message)?.stop;
              if (message[1] === "san" && LANES.includes(String(message[0]))) {
                const person = personIn(step, String(message[0]), message, names, seen);
                if (step.id === "S1-10" && message[2] === FROM_MOBILE) mobile = withItem(mobile, person);
                opened = withItem(opened, mobile.has(person) ? `${person}@mobile` : person);
                return;
              }
              const person =
                message[0] === "san" && LANES.includes(String(message[1]))
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
                replied = withItem(replied, chat);
                if (stop !== true && stop !== "first")
                  problems.push(`${at}: Rosie's first reply in ${chat}'s chat has no line`);
              }
            });
            return opened === seen.opened && replied === seen.replied && mobile === seen.mobile
              ? seen
              : made({ opened, replied, helper: seen.helper, mobile });
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
  visit(done.flow.steps, [made({ opened: new Set(), replied: new Set(), helper: null, mobile: new Set() })]);
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

const master = loadMaster();
const ALL = listTradeIds();

describe(`the line once per person's chat: all ${String(ALL.length)} trades x both flows x every money path (T-1116)`, () => {
  it("has 243 trades", () => {
    expect(ALL).toHaveLength(243);
  });

  for (const id of ALL) {
    it(`${id}: each person's chat has the line exactly once, on Rosie's first reply in it, on every walk of every money path`, () => {
      const trade = loadTrade(id);
      for (const flow of FLOWS) {
        const done = applyCorrections(applyTrade(master[flow], trade));
        const paths = tradePaths(done, trade, { booking: false, fixtures: false });
        expect(paths.length, `${id} ${flow}: money paths`).toBeGreaterThan(0);
        for (const path of paths) {
          const { problems, firsts } = chatLines(done, path);
          const where = `${id} ${flow} ${path.price}|${path.before}|${path.after}`;
          expect([...new Set(problems)], where).toStrictEqual([]);
          expect(firsts, `${where}: first replies`).toBeGreaterThan(0);
        }
      }
    }, 300_000);
  }
});

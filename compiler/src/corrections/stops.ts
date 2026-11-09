// Where the opt-out line goes now (T-141; QUESTIONS Q-30's default; SPEC-master 5j; RULES 4.1b, 4.3, 1.11; S13-01,
// S13-02, S13-32; Master Corrections C9).
//
// The master marks a message `"stop": "first"` where it may be the first text a number gets, and its applyStops()
// (overlay-core.js, wrapped by path/words.ts) keeps S13-02's line ("Reply STOP to opt out. Msg & data rates may apply.
// Reply HELP for help.") where the message is the first text that number gets on every walk to it. C9 changes what a
// first text is: Rosie never writes first (RULES 4.1b), so the first text a number gets is Rosie's first reply in a
// chat the person opened by texting Rosie. Q-30's default puts the opt-out line there, together with S13-01's
// automated-assistant opener and the privacy link, and says the same rule renders the flows' stop: "first" markers.
//
//   chatTexts(applied, path)   walks one path as overlay-core.js firstTexts() does, and records for each text Rosie
//                              sends a person whether that person had opened the chat (texted Rosie in it) before it
//                              on the walk, and whether it is Rosie's first reply in that chat.
//   settleStops(step, rec)     the override of applyStops() for a walked path: the line (`stop: true`) on Rosie's first
//                              reply in an opened chat when it is that on every walk, "first" where it depends on the
//                              walk, and no marker on any other message: never on a text to a chat nobody opened.
//   walkStops(applied, path)   walkPath() with each lit step's words settled by settleStops() over chatTexts(). The
//                              emitted bundle (emit/stop-marks.ts) and the lint's walk (lint/runner.ts) place the
//                              line with it (T-1116).
//
// A chat belongs to a person, not to a role word (DL-211). The person is the lane with the name the message gives
// (`as`), as overlay-core.js textTo reads it, with two readings of the master's words on top:
//   - The helper. On S1-09's branch "Helps run it; not an owner", the person who has texted Rosie as the owner since
//     signup began is a helper, and S1-77 names them (`as`: "Pat" in the master). From S1-77 on, that walk's chat so
//     far is the helper's, and the owner lane's unnamed messages are the helper's. S1-77's own unnamed messages are the
//     real owner's: their chat opens with their ready text there (C9). S1-10 says so too: "On the helper path it sets
//     only the helper's own sign-in. The owner's comes from S1-77's link." A message that names the owner (`as` the
//     owner's name) is the real owner's on every walk.
//   - The mobile. S1-10 asks for the one mobile only the person uses and "texts the secure ID check to it", so that
//     card goes to the chat of that mobile. After C9 the person first texts Rosie from it (FROM_MOBILE), which opens
//     that chat, and Rosie answers them there from then on; before C9 the card is Rosie writing first.
//
// The opener and the privacy link are fixed lines the action layer adds at run time (C-089, not here): the compiled
// words say only which message carries them, the one the line renders on.
import type { AppliedStep, AppliedTrade } from "../overlay/apply";
import { syncFlow, toCorePath, walkPath, type LitStep, type TradePath } from "../path";
import { loadPathScripts } from "../path/core";
import { FROM_MOBILE } from "./c9";

/** The lanes with a number Rosie can text (overlay-core.js textTo: NUMBER). */
export const NUMBER_LANES: readonly string[] = ["cust", "owner", "staff", "other"];

/** The ways a step texts (overlay-core.js textTo: TEXT_VIA): a text, Rosie on her own, a portal action that texts. */
export const TEXT_VIA: readonly string[] = ["msg", "auto", "portal"];

/** Booking reach values on which the booking customer gets no texts at all (overlay-core.js textTo). */
const NOT_TEXTED: readonly string[] = ["callsonly", "email", "notsafe"];

/** The step on S1-09's helper branch that names the helper (`as`) and writes the real owner unnamed. */
export const HELPER_STEP = "S1-77";

/** The step that asks for the one mobile only the person uses and texts the secure ID check to it. */
export const MOBILE_STEP = "S1-10";

/** What a chat's key adds for the chat a person's mobile opened (S1-10): `owner@mobile`. */
export const MOBILE_CHAT = "@mobile";

/** One text Rosie sends a person on a walked path. */
export interface ChatText {
  /**
   * The chat, on the first walk that reaches the text: the person (the lane, with `:<as>` for a named person on a
   * shared lane, as overlay-core.js textTo reads it; the helper on S1-09's helper branch), with `@mobile` for the chat
   * their mobile opened at S1-10.
   */
  to: string;
  /** On some walk to it, the person had not texted Rosie in that chat yet, so Rosie would write first (C9 forbids it). */
  unopened: boolean;
  /** On some walk to it, it is Rosie's first reply in a chat the person opened. */
  first: boolean;
  /** On some walk to it, Rosie had already replied in that chat. */
  later: boolean;
  /** The message's own marker as written: true, "first", false, or null with none. */
  stop: boolean | "first" | null;
}

/** By step id, by index of the message in the step's `say` (as resolveVary picks it for the path). */
export type ChatTexts = Record<string, Record<number, ChatText>>;

type Obj = Record<string, unknown>;
type Line = readonly unknown[];

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function elementsOf(message: Line): Obj | undefined {
  const elements = message[3];
  return isObj(elements) ? elements : undefined;
}

function isTextStep(step: Readonly<AppliedStep>): boolean {
  return TEXT_VIA.includes(step.via) && step.kind !== "rule";
}

/** The name a message gives the person on `lane`: its own `as`, else the step's `as` for its customer or staff (textTo). */
function nameOf(step: Readonly<AppliedStep>, lane: string, message: Line): string {
  const own = elementsOf(message)?.as;
  if (typeof own === "string" && own !== "") return own;
  if (
    typeof step.as === "string" &&
    (lane === step.to || lane === step.who) &&
    (lane === "cust" || lane === "staff")
  )
    return step.as;
  return "";
}

/** The person a message names on `lane`: the lane, with `:<as>` for a named person who is not the lane's own (textTo). */
function personOf(
  step: Readonly<AppliedStep>,
  lane: string,
  message: Line,
  names: Readonly<Record<string, string>>,
): string {
  const as = nameOf(step, lane, message);
  return as === "" || names[lane] === as ? lane : `${lane}:${as}`;
}

/** The number a message from Rosie texts on the path, or null when it texts nobody (overlay-core.js textTo). */
export function textedNumber(
  step: Readonly<AppliedStep>,
  message: Line,
  path: TradePath,
  names: Readonly<Record<string, string>>,
): string | null {
  const to = message[1];
  if (!isTextStep(step) || message[0] !== "san" || typeof to !== "string" || !NUMBER_LANES.includes(to))
    return null;
  const number = personOf(step, to, message, names);
  if (number === "cust" && NOT_TEXTED.includes(path.booking?.reach ?? "")) return null;
  return number;
}

/** The number a message to Rosie comes from: the person texting in, which opens their chat (RULES 4.1b). */
export function senderNumber(
  step: Readonly<AppliedStep>,
  message: Line,
  names: Readonly<Record<string, string>>,
): string | null {
  const from = message[0];
  if (!isTextStep(step) || message[1] !== "san" || typeof from !== "string" || !NUMBER_LANES.includes(from))
    return null;
  return personOf(step, from, message, names);
}

/** Where a chat stands on a walk: nobody has texted Rosie in it, a person has and Rosie has not replied, Rosie has. */
type Status = "unopened" | "opened" | "replied";

const UNOPENED: ReadonlySet<Status> = new Set<Status>(["unopened"]);

/**
 * The walks so far that read the people alike (the same signer, the same people texting from their mobile), with the
 * statuses each chat has on them. A chat's status changes only with the texts in that chat, so the statuses it has on
 * those walks, step by step and joined where branches rejoin, are exactly the ones some walk gives it: no walk is
 * dropped and nothing is capped.
 */
interface Reading {
  /** Whom the owner lane's unnamed messages name: the owner, or the helper once S1-77 names them. */
  signer: string;
  /** The people who have texted Rosie from their mobile (S1-10): Rosie answers them in that chat. */
  mobile: ReadonlySet<string>;
  /** Each chat's statuses on these walks; a chat that is not here is unopened on all of them. */
  chats: ReadonlyMap<string, ReadonlySet<Status>>;
}

function readingKey(reading: Reading): string {
  return [reading.signer, ...[...reading.mobile].sort()].join("|");
}

/** The readings of rejoined branches, those that read the people alike joined into one, each chat's statuses joined. */
function join(readings: readonly Reading[]): Reading[] {
  const out = new Map<
    string,
    { signer: string; mobile: ReadonlySet<string>; chats: Map<string, ReadonlySet<Status>> }
  >();
  for (const reading of readings) {
    const key = readingKey(reading);
    const hit = out.get(key);
    if (hit === undefined) {
      out.set(key, { signer: reading.signer, mobile: reading.mobile, chats: new Map(reading.chats) });
      continue;
    }
    for (const chat of new Set([...hit.chats.keys(), ...reading.chats.keys()]))
      hit.chats.set(
        chat,
        new Set([...(hit.chats.get(chat) ?? UNOPENED), ...(reading.chats.get(chat) ?? UNOPENED)]),
      );
  }
  return [...out.values()];
}

/** The helper S1-77 names: the person of its first message on the owner lane that names someone other than the owner. */
function helperOf(
  step: Readonly<AppliedStep>,
  say: readonly unknown[],
  names: Readonly<Record<string, string>>,
): string | null {
  for (const raw of say) {
    const message = raw as Line;
    const lane = message[0] === "san" ? message[1] : message[1] === "san" ? message[0] : undefined;
    if (lane !== "owner") continue;
    const person = personOf(step, lane, message, names);
    if (person !== lane) return person;
  }
  return null;
}

/**
 * The reading with the signer's chats (and the chat of their mobile) handed to `helper`, who is now the signer: the
 * person who texted as the owner so far is the helper. The owner's own chat is then one nobody has opened.
 */
function handOver(reading: Reading, helper: string): Reading {
  const from = reading.signer;
  const moved = (chat: string): string =>
    chat === from ? helper : chat === `${from}${MOBILE_CHAT}` ? `${helper}${MOBILE_CHAT}` : chat;
  const chats = new Map<string, ReadonlySet<Status>>();
  for (const [chat, statuses] of reading.chats) {
    const to = moved(chat);
    const there = chats.get(to);
    chats.set(to, there === undefined ? statuses : new Set([...there, ...statuses]));
  }
  return { signer: helper, mobile: new Set([...reading.mobile].map(moved)), chats };
}

/**
 * The person a message to or from `person` reaches on these walks: the owner lane's unnamed messages name the signer
 * (the helper once S1-77 named them), except in S1-77 itself, whose unnamed messages are the real owner's.
 */
function onWalk(step: Readonly<AppliedStep>, message: Line, person: string, signer: string): string {
  if (person !== "owner" || step.id === HELPER_STEP) return person;
  const own = elementsOf(message)?.as;
  return typeof own === "string" && own !== "" ? person : signer;
}

/** Each status after a text in the chat: a person's text opens it; Rosie's reply in an opened chat makes it replied. */
function after(statuses: ReadonlySet<Status>, fromPerson: boolean): ReadonlySet<Status> {
  return new Set(
    [...statuses].map((status): Status => {
      if (fromPerson) return status === "unopened" ? "opened" : status;
      return status === "opened" ? "replied" : status;
    }),
  );
}

/**
 * Walks one path over the applied flow as overlay-core.js firstTexts() does (a rule node is never walked; a step that is
 * off or whose `when` does not fit is skipped; every lit branch is walked from the walks before the split, and the
 * branches that rejoin carry their walks on), keeping for the walks so far which chats a person has texted Rosie in and
 * which have had Rosie's first reply, each chat keyed by the person on that walk (the helper, the mobile: see the
 * header). Unlike firstTexts() it keeps every walk (see Reading). Returns, for each text Rosie sends a person, what it
 * is on the walks that reach it.
 */
export function chatTexts(applied: AppliedTrade, path: TradePath): ChatTexts {
  const names = applied.flow.names;
  // The vendored tables read this flow once, and one core path serves every step, as walkPath() reads a path
  // (path/words.ts): the lit() and resolveVary() wrappers would sync the tables and copy the path again at each step.
  const { core } = loadPathScripts();
  syncFlow(applied.flow);
  const onPath = toCorePath(path);
  const out: ChatTexts = {};
  const recordOf = (id: string, index: number, to: string, message: Line): ChatText => {
    const byIndex = (out[id] ??= {});
    const mark = elementsOf(message)?.stop;
    return (byIndex[index] ??= {
      to,
      unopened: false,
      first: false,
      later: false,
      stop: mark === true || mark === false || mark === "first" ? mark : null,
    });
  };
  const go = (list: readonly AppliedStep[], readings: readonly Reading[]): Reading[] => {
    let current = [...readings];
    for (const step of list) {
      if (step.off !== undefined || step.kind === "rule") continue;
      if (step.when !== undefined && !core.lit(step.when, onPath)) continue;
      const say = isTextStep(step) ? core.resolveVary(step, onPath).step.say : undefined;
      if (Array.isArray(say)) {
        const helper = step.id === HELPER_STEP ? helperOf(step, say, names) : null;
        current = join(
          current.map((walked) => {
            const reading = helper !== null && walked.signer !== helper ? handOver(walked, helper) : walked;
            let mobile = reading.mobile;
            const chats = new Map(reading.chats);
            const chatOf = (person: string, toMobile: boolean): string =>
              toMobile || mobile.has(person) ? `${person}${MOBILE_CHAT}` : person;
            say.forEach((raw, index) => {
              const message = raw as Line;
              const sender = senderNumber(step, message, names);
              if (sender !== null) {
                const from = onWalk(step, message, sender, reading.signer);
                const fromMobile = step.id === MOBILE_STEP && message[2] === FROM_MOBILE;
                if (fromMobile && !mobile.has(from)) mobile = new Set([...mobile, from]);
                const chat = chatOf(from, fromMobile);
                chats.set(chat, after(chats.get(chat) ?? UNOPENED, true));
                return;
              }
              const person = textedNumber(step, message, path, names);
              if (person === null) return;
              const card = step.id === MOBILE_STEP && isObj(elementsOf(message)?.card);
              const to = chatOf(onWalk(step, message, person, reading.signer), card);
              const rec = recordOf(step.id, index, to, message);
              const now = chats.get(to) ?? UNOPENED;
              if (now.has("unopened")) rec.unopened = true;
              if (now.has("opened")) rec.first = true;
              if (now.has("replied")) rec.later = true;
              chats.set(to, after(now, false));
            });
            return { signer: reading.signer, mobile, chats };
          }),
        );
      }
      if (step.type !== "split") continue;
      let merged: Reading[] = [];
      for (const branch of step.branches ?? []) {
        if (branch.off !== undefined || !core.lit(branch.when, onPath)) continue;
        const walked = go(branch.steps, current);
        if ((branch.end ?? "merge") !== "end") merged = merged.concat(walked);
      }
      if (merged.length === 0) return [];
      current = join(merged);
    }
    return current;
  };
  go(applied.flow.steps, [{ signer: "owner", mobile: new Set(), chats: new Map() }]);
  return out;
}

/** The marker a text gets on the walked path: the line, the line on some walks only, or none. */
export function stopFor(rec: ChatText | undefined): true | "first" | undefined {
  if (rec?.first !== true) return undefined;
  return rec.later || rec.unopened ? "first" : true;
}

/**
 * The override of applyStops() for a walked path (Q-30): each message gets the marker stopFor() gives it from `rec`
 * (`chatTexts(applied, path)[step.id]`), whether or not the master marked it, and every other message loses its marker.
 * With no `rec` the step has no text on the path, and no message carries the line.
 */
export function settleStops(
  step: AppliedStep,
  rec: Readonly<Record<number, ChatText>> | undefined,
): AppliedStep {
  const say = step.say;
  if (!Array.isArray(say)) return step;
  const settled = say.map((raw, index) => {
    const message = raw as Line;
    const want = stopFor(rec?.[index]);
    const elements = elementsOf(message);
    const has = elements !== undefined && "stop" in elements;
    if ((!has && want === undefined) || (has && elements.stop === want)) return raw;
    const next: Obj = { ...elements };
    if (want === undefined) delete next.stop;
    else next.stop = want;
    const copy = [...message];
    if (Object.keys(next).length === 0) copy.length = 3;
    else copy[3] = next;
    return copy as unknown as typeof raw;
  });
  return settled.some((message, k) => message !== say[k]) ? { ...step, say: settled } : step;
}

/** One path's lit steps with their words settled by the Q-30 rule, and the texts that settled them. */
export interface StopWalk {
  path: TradePath;
  texts: ChatTexts;
  /**
   * As walkPath() gives them, words settled: with `{ sets: false }` by default (each step once, read with the walked
   * path), or following a branch's `sets` with `{ sets: true }` (a step after such a split once per reading).
   */
  steps: LitStep[];
}

/**
 * walkPath() of the path, each lit step's opt-out line placed by settleStops() over chatTexts() (Q-30), in place of the
 * master's applyStops (T-1116: path/words.ts walkPath's `settle`). The texts are those of the walked path, as
 * firstTexts() reads it for applyStops, also where a step reads the path after a branch's `sets`.
 */
export function walkStops(
  applied: AppliedTrade,
  path: TradePath,
  options: { sets?: boolean } = {},
): StopWalk {
  const texts = chatTexts(applied, path);
  const walk = walkPath(applied, path, {
    sets: options.sets ?? false,
    settle: (words, id) => settleStops(words, texts[id]),
  });
  return { path, texts, steps: walk.steps };
}

/** Every message a settled walk gives the opt-out line (`stop: true`) or the line on some walks (`"first"`). */
export function placedStops(
  walk: StopWalk,
): { step: string; index: number; to: string; stop: true | "first" }[] {
  const out: { step: string; index: number; to: string; stop: true | "first" }[] = [];
  for (const entry of walk.steps) {
    (entry.words.say ?? []).forEach((raw, index) => {
      const mark = elementsOf(raw as Line)?.stop;
      if (mark !== true && mark !== "first") return;
      out.push({ step: entry.id, index, to: walk.texts[entry.id]?.[index]?.to ?? "", stop: mark });
    });
  }
  return out;
}

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
//                              sends a number whether that number had opened its chat (texted Rosie) before it on the
//                              walk, and whether it is Rosie's first reply in that chat.
//   settleStops(step, rec)     the override of applyStops() for a walked path: the line (`stop: true`) on Rosie's first
//                              reply in an opened chat when it is that on every walk, "first" where it depends on the
//                              walk, and no marker on any other message: never on a text to a chat nobody opened.
//   walkStops(applied, path)   walkPath() with each lit step's words settled by settleStops() over chatTexts().
//
// The opener and the privacy link are fixed lines the action layer adds at run time (C-089, not here): the compiled
// words say only which message carries them, the one the line renders on.
import type { AppliedStep, AppliedTrade } from "../overlay/apply";
import { lit, resolveVary, walkPath, type LitStep, type TradePath } from "../path";

/** The lanes with a number Rosie can text (overlay-core.js textTo: NUMBER). */
export const NUMBER_LANES: readonly string[] = ["cust", "owner", "staff", "other"];

/** The ways a step texts (overlay-core.js textTo: TEXT_VIA): a text, Rosie on her own, a portal action that texts. */
export const TEXT_VIA: readonly string[] = ["msg", "auto", "portal"];

/** Booking reach values on which the booking customer gets no texts at all (overlay-core.js textTo). */
const NOT_TEXTED: readonly string[] = ["callsonly", "email", "notsafe"];

/** How many walk states are kept at once (overlay-core.js firstTexts: CAP). */
const CAP = 48;

/** One text Rosie sends a number on a walked path. */
export interface ChatText {
  /** The number: the lane, with `:<as>` for a named person on a shared lane (overlay-core.js textTo). */
  to: string;
  /** On some walk to it, the number had not texted Rosie yet, so Rosie would write first (C9 forbids it). */
  unopened: boolean;
  /** On some walk to it, it is Rosie's first reply in a chat the number opened. */
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

/** The person a message names on `lane`: its own `as`, else the step's `as` for its customer or staff (textTo). */
function personOf(
  step: Readonly<AppliedStep>,
  lane: string,
  message: Line,
  names: Readonly<Record<string, string>>,
): string {
  const own = elementsOf(message)?.as;
  let as = "";
  if (typeof own === "string" && own !== "") as = own;
  else if (
    typeof step.as === "string" &&
    (lane === step.to || lane === step.who) &&
    (lane === "cust" || lane === "staff")
  )
    as = step.as;
  if (as !== "" && names[lane] === as) as = "";
  return as === "" ? lane : `${lane}:${as}`;
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

interface ChatState {
  /** The numbers that have texted Rosie on this walk. */
  opened: ReadonlySet<string>;
  /** The numbers Rosie has replied to in their opened chat on this walk. */
  replied: ReadonlySet<string>;
}

function keyOf(state: ChatState): string {
  const opened = [...state.opened].sort().map((number) => `o ${number}`);
  const replied = [...state.replied].sort().map((number) => `r ${number}`);
  return [...opened, ...replied].join("|");
}

function dedupe(states: readonly ChatState[]): ChatState[] {
  const seen = new Set<string>();
  const out: ChatState[] = [];
  for (const state of states) {
    const key = keyOf(state);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(state);
  }
  return out.slice(0, CAP);
}

/**
 * Walks one path over the applied flow as overlay-core.js firstTexts() does (a rule node is never walked; a step that is
 * off or whose `when` does not fit is skipped; every lit branch is walked from the states before the split, and the
 * branches that rejoin carry their states on), keeping per walk which numbers have texted Rosie and which have had
 * Rosie's first reply. Returns, for each text Rosie sends a number, what it is on the walks that reach it.
 */
export function chatTexts(applied: AppliedTrade, path: TradePath): ChatTexts {
  const names = applied.flow.names;
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
  const go = (list: readonly AppliedStep[], states: readonly ChatState[]): ChatState[] => {
    let current = [...states];
    for (const step of list) {
      if (step.off !== undefined || step.kind === "rule") continue;
      if (step.when !== undefined && !lit(applied, step.when, path)) continue;
      const say = isTextStep(step) ? resolveVary(applied, step, path).step.say : undefined;
      if (Array.isArray(say)) {
        current = dedupe(
          current.map((state) => {
            let opened = state.opened;
            let replied = state.replied;
            say.forEach((raw, index) => {
              const message = raw as Line;
              const from = senderNumber(step, message, names);
              if (from !== null) {
                if (!opened.has(from)) opened = new Set([...opened, from]);
                return;
              }
              const to = textedNumber(step, message, path, names);
              if (to === null) return;
              const rec = recordOf(step.id, index, to, message);
              if (!opened.has(to)) rec.unopened = true;
              else if (replied.has(to)) rec.later = true;
              else {
                rec.first = true;
                replied = new Set([...replied, to]);
              }
            });
            return { opened, replied };
          }),
        );
      }
      if (step.type !== "split") continue;
      let merged: ChatState[] = [];
      for (const branch of step.branches ?? []) {
        if (branch.off !== undefined || !lit(applied, branch.when, path)) continue;
        const after = go(branch.steps, current);
        if ((branch.end ?? "merge") !== "end") merged = merged.concat(after);
      }
      if (merged.length === 0) return [];
      current = dedupe(merged);
    }
    return current;
  };
  go(applied.flow.steps, [{ opened: new Set(), replied: new Set() }]);
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
  /** As walkPath() with `{ sets: false }` gives them (each step once, read with the walked path), words settled. */
  steps: LitStep[];
}

/** walkPath() of the path, each lit step's opt-out line placed by settleStops() over chatTexts() (Q-30). */
export function walkStops(applied: AppliedTrade, path: TradePath): StopWalk {
  const texts = chatTexts(applied, path);
  const steps = walkPath(applied, path, { sets: false }).steps.map((entry) => ({
    ...entry,
    words: settleStops(resolveVary(applied, entry.step, path).step, texts[entry.id]),
  }));
  return { path, texts, steps };
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

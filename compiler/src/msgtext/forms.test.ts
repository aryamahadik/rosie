// T-134: the plain-text forms of messages, msgtext.js smsText() wrapped. Proofs of the card:
//   - for every message in both flows (each step's say, each variant's say and addSay, branch steps included), the
//     plain-text form equals msgtext.js smsText() on the vendored copy;
//   - flow A's steps carry, in their own messages (`say`), card 123, buttons 114, times 14, list 8, code 7, form 7,
//     photos 7 and pay 4 elements (the variants' say and addSay carry more: card 49, buttons 28 and list 24, checked
//     with the rest);
//   - each message as the bundle writes it, with its plain-text form, validates against K-01 v1's message with Ajv.
//
// The reference side never uses the module under test: the messages are walked from the raw JSON of master-A.json and
// master-B.json, and smsText() is msgtext.js as the master's step.js reaches it, lib.js's MSG (lib.js line 70; step.js
// prints each message as L.MSG.smsText(m)), loaded through a loader of its own.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import type { FlowLetter, Message, MessageElements } from "../graph/types.ts";
import { loadMaster } from "../load/flow";
import { makeCjsLoader } from "../overlay/cjs-load";
import { BUILD_DIR } from "../overlay/core";
import {
  TEXT_FORM_KINDS,
  bareLinks,
  bundleMessage,
  elementKeys,
  elementTexts,
  flowMessages,
  plainText,
  typedOptions,
  type FlowMessage,
} from "./index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORK = `${ROOT}fixtures/master/engine/work/`;
const FLOWS: readonly FlowLetter[] = ["A", "B"];

type Obj = Record<string, unknown>;

interface ReferenceMsg {
  smsText(message: readonly unknown[]): string;
  uiProblems(elements: unknown): string[];
}

/** msgtext.js as step.js reaches it: lib.js's MSG, from a loader of the test's own. */
const MSG = (makeCjsLoader()(`${BUILD_DIR}lib.js`) as { MSG: ReferenceMsg }).MSG;

const master = loadMaster();

/** One message of a raw flow file, with where it is. */
interface RawMessage {
  at: string;
  list: "say" | "vary.say" | "vary.addSay";
  message: unknown[];
}

/** Every message of a raw flow file: each step's say, each variant's say and addSay, branch steps too. */
function rawMessages(flow: FlowLetter): RawMessage[] {
  const data = JSON.parse(readFileSync(`${WORK}master/master-${flow}.json`, "utf8")) as Obj;
  const out: RawMessage[] = [];
  const take = (list: unknown, at: string, kind: RawMessage["list"]): void => {
    if (!Array.isArray(list)) return;
    (list as unknown[][]).forEach((message, k) => {
      out.push({ at: `${at} ${String(k)}`, list: kind, message });
    });
  };
  const walk = (steps: unknown): void => {
    if (!Array.isArray(steps)) return;
    for (const step of steps as Obj[]) {
      const id = String(step.id);
      take(step.say, `${flow} ${id} say`, "say");
      for (const [key, patch] of Object.entries((step.vary ?? {}) as Obj)) {
        take((patch as Obj).say, `${flow} ${id} vary ${key} say`, "vary.say");
        take((patch as Obj).addSay, `${flow} ${id} vary ${key} addSay`, "vary.addSay");
      }
      for (const branch of (step.branches ?? []) as Obj[]) walk(branch.steps);
    }
  };
  walk(data.steps);
  return out;
}

/** Where a module-walked message is, spelled as rawMessages() spells it. */
function atOf(m: FlowMessage): string {
  const list = m.list === "say" ? "say" : `vary ${m.vary ?? ""} ${m.list === "vary.say" ? "say" : "addSay"}`;
  return `${m.flow} ${m.step} ${list} ${String(m.index)}`;
}

const raw: Record<FlowLetter, RawMessage[]> = { A: rawMessages("A"), B: rawMessages("B") };
const walked: Record<FlowLetter, FlowMessage[]> = {
  A: flowMessages(master.A),
  B: flowMessages(master.B),
};
const allWalked: FlowMessage[] = [...walked.A, ...walked.B];

/** The first message of a loaded step's own `say` whose elements `pick` accepts. */
function sayOf(flow: FlowLetter, id: string, pick: (elements: MessageElements) => boolean): Message {
  const message = master[flow].steps[id]?.say?.find((m) => m[3] !== undefined && pick(m[3]));
  if (message === undefined) throw new Error(`${flow} ${id} has no such message`);
  return message;
}

const S1_02 = sayOf("A", "S1-02", (u) => u.stop !== undefined);
const S1_03 = sayOf("A", "S1-03", (u) => u.card !== undefined);
const S1_04 = sayOf("A", "S1-04", (u) => u.buttons !== undefined);
const S1_10 = sayOf("A", "S1-10", (u) => u.form !== undefined);
const S1_77 = sayOf("A", "S1-77", (u) => u.buttons !== undefined);
const A8_14 = sayOf("A", "A8-14", (u) => (u.buttons ?? []).some((button) => Array.isArray(button)));
const A9_05 = sayOf("A", "A9-05", (u) => u.pay !== undefined);
const A10_01 = sayOf("A", "A10-01", (u) => u.stars === true);

/** How many messages carry each element key. */
function countElements(messages: readonly (readonly unknown[])[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    const elements = message[3];
    if (typeof elements !== "object" || elements === null) continue;
    for (const key of Object.keys(elements)) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** The card's eight element kinds, with how many messages carry each. */
function cardKinds(counts: Record<string, number>): Record<string, number> {
  const kinds = ["card", "buttons", "times", "list", "code", "form", "photos", "pay"];
  return Object.fromEntries(kinds.map((kind) => [kind, counts[kind] ?? 0]));
}

describe("the plain-text form of every message in both flows", () => {
  for (const flow of FLOWS) {
    it(`walks every message of flow ${flow} the raw file holds, as written`, () => {
      expect(walked[flow].map(atOf)).toEqual(raw[flow].map((entry) => entry.at));
      walked[flow].forEach((entry, k) => {
        expect(entry.message, atOf(entry)).toEqual(raw[flow][k]?.message);
      });
      expect(walked[flow].length).toBe(flow === "A" ? 717 : 755);
    });

    it(`gives each message of flow ${flow} the text msgtext.js smsText() gives it`, () => {
      const reference = new Map(raw[flow].map((entry) => [entry.at, MSG.smsText(entry.message)]));
      const differ: string[] = [];
      for (const entry of walked[flow]) {
        const want = reference.get(atOf(entry));
        if (want === undefined || plainText(entry.message) !== want) differ.push(atOf(entry));
      }
      expect(differ).toEqual([]);
      expect(reference.size).toBe(walked[flow].length);
    });
  }

  it("counts, in flow A's steps' own messages, card 123, buttons 114, times 14, list 8, code 7, form 7, photos 7 and pay 4 elements", () => {
    const want = { card: 123, buttons: 114, times: 14, list: 8, code: 7, form: 7, photos: 7, pay: 4 };
    const own = walked.A.filter((entry) => entry.list === "say").map((entry) => entry.message);
    expect(cardKinds(countElements(own))).toEqual(want);
    const rawOwn = raw.A.filter((entry) => entry.list === "say").map((entry) => entry.message);
    expect(cardKinds(countElements(rawOwn))).toEqual(want);
  });

  it("counts the same elements in each flow as its raw file holds, with more cards once the variants count", () => {
    for (const flow of FLOWS) {
      const mine = countElements(walked[flow].map((entry) => entry.message));
      expect(mine).toEqual(countElements(raw[flow].map((entry) => entry.message)));
      const own = countElements(walked[flow].filter((e) => e.list === "say").map((e) => e.message));
      expect(cardKinds(mine).card, flow).toBeGreaterThan(cardKinds(own).card ?? 0);
    }
  });

  it("meets only element keys msgtext.js knows (KEYS), so every element of both flows has its text form", () => {
    const keys = elementKeys();
    const unknown = new Set<string>();
    const refused: string[] = [];
    for (const entry of allWalked) {
      const elements = entry.message[3];
      if (elements === undefined) continue;
      for (const key of Object.keys(elements)) if (!keys.includes(key)) unknown.add(key);
      if (MSG.uiProblems(elements).some((problem) => problem.startsWith("unknown message element")))
        refused.push(atOf(entry));
    }
    expect([...unknown]).toEqual([]);
    expect(refused).toEqual([]);
    for (const kind of TEXT_FORM_KINDS) expect(keys).toContain(kind);
  });
});

describe("each element's own plain-text form", () => {
  it("is what smsText() adds for the element: the words and the forms, one per line, are the plain text, for every message", () => {
    const differ: string[] = [];
    for (const entry of allWalked) {
      const [, , text, elements] = entry.message;
      const forms = elementTexts(entry.message);
      const lines = [...(text === "" ? [] : [text]), ...forms.map((form) => form.text)];
      if (lines.join("\n") !== MSG.smsText(entry.message)) differ.push(atOf(entry));
      const present = TEXT_FORM_KINDS.filter((kind) => Boolean(elements?.[kind]));
      expect(
        forms.map((form) => form.kind),
        atOf(entry),
      ).toEqual(present);
    }
    expect(differ).toEqual([]);
  });

  it("reads alone as in its message, with no words and no other element, except the stop line and stars", () => {
    const differ: string[] = [];
    for (const entry of allWalked) {
      const [from, to, , elements] = entry.message;
      if (elements === undefined) continue;
      const modifiers: Obj = {};
      for (const [key, value] of Object.entries(elements))
        if (!(TEXT_FORM_KINDS as readonly string[]).includes(key)) modifiers[key] = value;
      for (const form of elementTexts(entry.message)) {
        if (form.kind === "stop" || form.kind === "stars") continue;
        const alone = MSG.smsText([from, to, "", { ...modifiers, [form.kind]: elements[form.kind] }]);
        if (alone !== form.text) differ.push(`${atOf(entry)} ${form.kind}`);
      }
    }
    expect(differ).toEqual([]);
  });

  it("types the options as msgtext.js does: numbered, lettered, or by each button's own key", () => {
    expect(typedOptions(S1_04)).toBe("Reply 1 Some share one, 2 All share one, 3 Each is its own.");
    expect(typedOptions(A8_14)).toBe("Reply 3 I'm here.");
    expect(typedOptions(["san", "cust", "Which one?", { buttons: ["Yes", "No"], letters: true }])).toBe(
      "Reply A Yes, B No.",
    );
    expect(typedOptions(["san", "cust", "¿Le sirve?", { buttons: ["Sí", "No"], lang: "es" }])).toBe(
      "Responda 1 Sí, 2 No.",
    );
    // the form stands after the words and the other elements, as the last part before the stop line
    expect(S1_77[3]?.stop).toBe("first");
    expect(plainText(S1_77).split("\n").at(-2)).toBe(typedOptions(S1_77));
    expect(typedOptions(S1_03)).toBeNull();
    expect(typedOptions(["cust", "san", "Yes"])).toBeNull();
  });

  it("gives a card's link alone, and a pay card's", () => {
    expect(bareLinks(S1_10)).toEqual(["rosfield.com/v/s01"]);
    expect(elementTexts(S1_10).find((form) => form.kind === "card")?.text).toMatch(
      /\nOpen secure page: rosfield\.com\/v\/s01$/,
    );
    expect(bareLinks(A9_05)).toEqual(["rosfield.com/p/a2"]);
    expect(bareLinks(S1_03)).toEqual([]);
    expect(bareLinks(["cust", "san", "Yes"])).toEqual([]);
    // every card link of both flows is given, and only those
    for (const entry of allWalked) {
      const elements: MessageElements | undefined = entry.message[3];
      const want = [elements?.card?.link, elements?.pay?.link].filter((link) => Boolean(link));
      expect(bareLinks(entry.message), atOf(entry)).toEqual(want);
    }
  });

  it("reads stars after a card with a link as a tap on the page, and alone as a reply", () => {
    const forms = elementTexts(A10_01);
    expect(forms.map((form) => form.kind)).toEqual(["card", "stars"]);
    expect(forms[1]?.text).toBe("Tap a star on the page, 1 to 5.");
    expect(elementTexts(["san", "cust", "How was it?", { stars: true }])).toEqual([
      { kind: "stars", text: "Reply with a number, 1 to 5." },
    ]);
    expect(elementTexts(["san", "cust", "How was it?", { stars: false }])).toEqual([]);
  });

  it("leaves out of the stop line what the words already say", () => {
    const full = "Reply STOP to opt out. Msg & data rates may apply. Reply HELP for help.";
    expect(elementTexts(S1_02).at(-1)).toEqual({ kind: "stop", text: full });
    expect(elementTexts(["san", "cust", "Hi.", { stop: "first" }])).toEqual([{ kind: "stop", text: full }]);
    expect(elementTexts(["san", "cust", "Msg & data rates may apply.", { stop: true }])).toEqual([
      { kind: "stop", text: "Reply STOP to opt out. Reply HELP for help." },
    ]);
    expect(elementTexts(["san", "cust", "Reply HELP for help.", { stop: true }])).toEqual([
      { kind: "stop", text: "Reply STOP to opt out. Msg & data rates may apply." },
    ]);
  });

  it("gives no form to a message without elements, or with only who it is for and its language", () => {
    expect(elementTexts(["cust", "san", "Yes"])).toEqual([]);
    expect(plainText(["cust", "san", "Yes"])).toBe("Yes");
    const quiet = allWalked.filter((entry) => {
      const elements = entry.message[3];
      return (
        elements !== undefined && Object.keys(elements).every((key) => ["as", "lang", "en"].includes(key))
      );
    });
    expect(quiet.length).toBeGreaterThan(0);
    for (const entry of quiet) {
      expect(elementTexts(entry.message), atOf(entry)).toEqual([]);
      expect(plainText(entry.message), atOf(entry)).toBe(entry.message[2]);
    }
  });
});

describe("the bundle's message (K-01 v1 message)", () => {
  const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
  ajv.addSchema(JSON.parse(readFileSync(`${ROOT}contracts/common/formats.v1.schema.json`, "utf8")) as Obj);
  ajv.addSchema(JSON.parse(readFileSync(`${ROOT}contracts/bundle/bundle.v1.schema.json`, "utf8")) as Obj);
  const validate = ajv.getSchema(
    "https://rosie.invalid/contracts/bundle/bundle.v1.schema.json#/$defs/message",
  );
  if (validate === undefined) throw new Error("bundle.v1.schema.json has no $defs/message");

  it("validates every message of both flows, with its plain-text form, against $defs/message with Ajv", () => {
    const refused: string[] = [];
    for (const entry of allWalked) {
      if (!validate(bundleMessage(entry.message)))
        refused.push(`${atOf(entry)}: ${JSON.stringify(validate.errors)}`);
    }
    expect(refused).toEqual([]);
    expect(allWalked).toHaveLength(717 + 755);
  });

  it("is not a vacuous check: a message without its plain-text form, with an unknown element or lane, is refused", () => {
    const made = bundleMessage(S1_04);
    expect(validate(made)).toBe(true);
    expect(validate({ from: made.from, to: made.to, text: made.text, elements: made.elements })).toBe(false);
    expect(validate({ ...made, elements: { ...made.elements, sparkle: true } })).toBe(false);
    expect(validate({ ...made, to: "everyone" })).toBe(false);
    expect(validate({ ...made, plainText: 7 })).toBe(false);
  });

  it("keeps the words and elements as written, adds the plain-text form, and shares nothing with the message", () => {
    const message = S1_10;
    const made = bundleMessage(message);
    expect(made).toEqual({
      from: message[0],
      to: message[1],
      text: message[2],
      elements: message[3],
      plainText: MSG.smsText(message),
    });
    expect(made.elements).not.toBe(message[3]);
    made.elements?.form?.push("changed");
    expect(message[3]?.form).not.toContain("changed");
    expect(bundleMessage(["cust", "san", "Yes"])).toEqual({
      from: "cust",
      to: "san",
      text: "Yes",
      plainText: "Yes",
    });
  });
});

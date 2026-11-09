// Test support for the rewrite's tests (T-374): A7-17's row, whose check results K-03's fixtures hold (check-two-questions
// and check-optout-only-option for the composed plan, check-fallback for the one rewrite, check-passed-on for the
// fallback text), written as a K-03 v1 composeInput from the values those fixtures show (the master's sample cast:
// Alex, Riley, Avery, Sat Oct 24, 11:00am, 7pm; rule 9) and the fallback text check-passed-on.json checks, slots put back;
// the plans the fixtures' checked words come from; and fake Messages APIs that answer by the call's user message or never
// answer at all. No network, no key, no live call (J-02; DL-027: CI makes none). Never imported by the Worker.
//
// The recorded-model double (T-004) holds compose plans keyed by their input, and no rewrite: a rewrite's answer is served
// here as a K-03 plan, as T-373's tests serve a plan the double does not hold (ai/recordings is outside T-374's card).

import { fakeCachingApi, type FakeCachingApi, type FakeCall } from "../../cache/test-support";
import type { FetchLike } from "../../gateway";
import type { ComposeInput, MessagePlan } from "../prompt";

/** A7-17's text to Alex: Riley can't be in on Sat Oct 24, Avery can do the visit. */
export const A7_17_INPUT: ComposeInput = {
  row: "outbox-a7-17-alex-text",
  turn: "turn-a7-17-riley-out",
  conversation: [],
  masterText: {
    step: "A7-17",
    text: "Sorry, {{pro.name}} can't be in on {{day}}. {{name.staff}} can come in early to do your visit, same time and price. Please reply by {{ask.by}}.",
  },
  facts: [
    { slot: "pro.name", value: "Riley" },
    { slot: "name.staff", value: "Avery" },
    { slot: "day", value: "Sat Oct 24" },
    { slot: "visit.time", value: "11:00am" },
    { slot: "ask.by", value: "7pm" },
  ],
  audience: { role: "customer", name: "Alex", way: "texts", handlingLine: null },
  language: "en",
  channel: "imessage",
  situation: "problem",
  allowedFormats: ["text", "poll"],
  allowedLinks: [],
  options: [
    { id: "c-01", label: "Avery instead" },
    { id: "c-02", label: "Cancel visit" },
  ],
  pageTypes: [],
  openQuestions: [],
  inbound: null,
};

/** The composed plan check-two-questions.json checked: once filled, its words are that fixture's, two questions in one text. */
export const TWO_QUESTIONS_PLAN: MessagePlan = {
  formats: ["text"],
  lines: [{ role: "first", text: "Your visit is {{day}} at {{visit.time}}. Does that still work?" }],
  question: { text: "Or should we find another time?", optionIds: [] },
  pageType: null,
  threadReplyTo: null,
};

/** The one rewrite's plan: A7-17's line kept in meaning and order, one question, the step's two options as a poll. */
export const ONE_QUESTION_PLAN: MessagePlan = {
  formats: ["text", "poll"],
  lines: [
    {
      role: "first",
      text: "Sorry, {{pro.name}} can't be in on {{day}}. {{name.staff}} can do your {{visit.time}} visit instead, same time and price.",
    },
  ],
  question: { text: "Is {{name.staff}} all right? Please reply by {{ask.by}}", optionIds: ["c-01", "c-02"] },
  pageType: null,
  threadReplyTo: null,
};

/** The rewrite check-fallback.json checked, as a model would type it: 10:30am is a time no fact holds. */
export const TYPED_TIME_PLAN: MessagePlan = {
  formats: ["text"],
  lines: [
    {
      role: "first",
      text: "{{pro.name}} can't be in on {{day}}. {{name.staff}} can do your visit at 10:30am instead.",
    },
  ],
  question: null,
  pageType: null,
  threadReplyTo: null,
};

/** The user message a call sent: the per-turn part (T-364's layout). */
export function userOf(call: FakeCall | undefined): string {
  const messages = call?.body.messages as { content: string }[] | undefined;
  return messages?.[0]?.content ?? "";
}

/**
 * A fake Messages API with Anthropic's prompt cache (T-364's), answering each call with what `answer` gives for its user
 * message; `fail` fails a call with an HTTP status instead (n counts every call from 0).
 */
export function fakeTurnApi(
  answer: (turn: string, n: number) => unknown,
  fail?: (n: number) => number | null,
): FakeCachingApi {
  return fakeCachingApi({
    answer: (body, n) => {
      const messages = body.messages as { content: string }[];
      return answer(messages[0]?.content ?? "", n);
    },
    ...(fail !== undefined && { fail: (_body: Record<string, unknown>, n: number) => fail(n) }),
  });
}

/** A Messages API that never answers: each request settles only when the gateway aborts it, as a real fetch does. */
export function hangingApi(): { fetch: FetchLike; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const fetchHang: FetchLike = (_url, init) => {
    sent.push(JSON.parse(typeof init.body === "string" ? init.body : "{}") as Record<string, unknown>);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    });
  };
  return { fetch: fetchHang, sent };
}

// How a composer input reads to the model, and how a plan reads in a worked example (T-372, C-119).
//
// The input is K-03's tagged inputs (arch 07 line 397: "Each input has its own tag, long ones first"), in this order:
//
//   <conversation> <master_text> <facts> <audience> <language> <channel> <situation> <allowed_formats>
//   <allowed_links> <options> <page_types> <open_questions>, then <inbound>, only in a reply to its sender
//
// Every value sits inside a tag the code writes, escaped with the context bundle's tagged data (T-367, context/tags.ts),
// so nothing inside data opens or closes a tag: their words are data, never instructions (S13-54 rule 67).
// What the model is not shown: the row and turn ids, the master line's step id (a step id is never in a message: arch
// 07 line 415) and the send times (the composer states no time but a slot: arch 07 line 409).
//
// The worked examples in the system prompt show their inputs with composeInputText, so an example reads exactly as a
// real row does; the composer (C-118) sends composeInputText(input) as each call's per-turn part (T-364's layout).

import { dataElement, parentElement } from "../../context/tags";
import type { ComposeInput, MessagePlan, PlanLine } from "./types";

/** The input tags, in the order the model reads them; inbound comes only in a reply to its sender. */
export const INPUT_TAGS = [
  "conversation",
  "master_text",
  "facts",
  "audience",
  "language",
  "channel",
  "situation",
  "allowed_formats",
  "allowed_links",
  "options",
  "page_types",
  "open_questions",
  "inbound",
] as const;
export type InputTag = (typeof INPUT_TAGS)[number];

/** A list of plain values: one child element per value. */
function listElement(name: InputTag, item: string, values: readonly string[]): string {
  return parentElement(
    name,
    {},
    values.map((value) => dataElement(item, {}, value)),
  );
}

/** The row's input as tagged parts, every value escaped as data. */
export function composeInputText(input: ComposeInput): string {
  const { audience } = input;
  const parts = [
    parentElement(
      "conversation",
      {},
      input.conversation.map((message) => dataElement("message", { from: message.from }, message.text)),
    ),
    dataElement("master_text", {}, input.masterText.text),
    parentElement(
      "facts",
      {},
      input.facts.map((fact) => dataElement("fact", { slot: fact.slot }, fact.value)),
    ),
    parentElement("audience", { role: audience.role, way: audience.way }, [
      ...(audience.name === null ? [] : [dataElement("name", {}, audience.name)]),
      ...(audience.handlingLine === null ? [] : [dataElement("handling_line", {}, audience.handlingLine)]),
    ]),
    dataElement("language", {}, input.language),
    dataElement("channel", {}, input.channel),
    dataElement("situation", {}, input.situation),
    listElement("allowed_formats", "format", input.allowedFormats),
    listElement("allowed_links", "link", input.allowedLinks),
    parentElement(
      "options",
      {},
      input.options.map((option) => dataElement("option", { id: option.id }, option.label)),
    ),
    listElement("page_types", "page_type", input.pageTypes),
    parentElement(
      "open_questions",
      {},
      input.openQuestions.map((question) => dataElement("open_question", { id: question.id }, question.text)),
    ),
  ];
  if (input.inbound !== null) parts.push(dataElement("inbound", {}, input.inbound.text));
  return parts.join("\n");
}

const json = (value: unknown): string => JSON.stringify(value);
const jsonList = (values: readonly string[]): string => `[${values.map(json).join(", ")}]`;
const lineJson = (line: PlanLine): string => `{"role": ${json(line.role)}, "text": ${json(line.text)}}`;

/**
 * A plan as a worked example shows it: valid JSON, its fields in K-03's order, one line per field and per plan line.
 * JSON.parse of the result gives the plan back.
 */
export function planText(plan: MessagePlan): string {
  const lines =
    plan.lines.length === 0
      ? "[]"
      : `[\n${plan.lines.map((line) => `    ${lineJson(line)}`).join(",\n")}\n  ]`;
  const question =
    plan.question === null
      ? "null"
      : `{"text": ${json(plan.question.text)}, "optionIds": ${jsonList(plan.question.optionIds)}}`;
  return [
    "{",
    `  "formats": ${jsonList(plan.formats)},`,
    `  "lines": ${lines},`,
    `  "question": ${question},`,
    `  "pageType": ${json(plan.pageType)},`,
    `  "threadReplyTo": ${json(plan.threadReplyTo)}`,
    "}",
  ].join("\n");
}

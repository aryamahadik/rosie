// The dry run's stand-in for Anthropic's Messages endpoint (T-362): an HTTP server on 127.0.0.1 alone, on a port the
// system picks, answering POST /v1/messages after a set delay per kind of call with an answer the production checks
// accept (the contracts' own fixtures), so a dry run walks every unit end to end with no key and no network.
//
// It refuses (HTTP 401) any request whose x-api-key is not the dry run's placeholder, so a real key never reaches it,
// and (HTTP 400) a body it cannot name. It keeps no body: only the count of calls by kind.

import { createServer } from "node:http";

import { readJson } from "./units.mjs";

/** The only key a dry run sends: a placeholder, never a real key's form. */
export const DRY_KEY = "DRY-RUN-PLACEHOLDER-NOT-A-KEY-T362";

/** Each kind's delay in a dry run, in ms (the test sets its own). */
export const DRY_DELAYS = Object.freeze({ safety: 30, step1: 40, step2: 30, compose: 50, rewrite: 60 });

const USAGE = Object.freeze({
  input_tokens: 420,
  output_tokens: 64,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/**
 * The fixture answers, by kind: K-02's "No" safety read (safety-no.json), S1-02's decide read split in the two-step wire
 * form (decide-s1-02-choose.json: step 1 its parts' quotes and verbs, step 2 each part less its verb and quote), K-03's
 * S1-02 plan for the compose call (plan-s1-02.json) and the rewrite tests' one-question plan for the rewrite.
 */
export function fixtureAnswers(production, cases) {
  const read = readJson("contracts/model/fixtures/decide-s1-02-choose.json").reads[0].output;
  const turnOf = {
    compose: production.composer.composeInputText(cases.composeInput),
    rewrite: production.composer.rewriteTurnText(
      cases.rewriteRequest.input,
      cases.rewriteRequest.plan,
      cases.rewriteRequest.told,
    ),
  };
  const step2 = Object.fromEntries(
    read.parts.map((part) => {
      const rest = { ...part };
      delete rest.verb;
      delete rest.quote;
      return [part.verb, rest];
    }),
  );
  return {
    safety: readJson("contracts/model/fixtures/safety-no.json").read,
    step1: { language: read.language, parts: read.parts.map(({ quote, verb }) => ({ quote, verb })) },
    step2,
    compose: readJson("contracts/message-plan/fixtures/plan-s1-02.json"),
    rewrite: production.rewriteCase.ONE_QUESTION_PLAN,
    turnOf,
  };
}

/** The kind of a call and the answer it gets, or null: by its schema's kind (`classify`), and for a plan by its turn. */
export function answerFor(body, classify, answers) {
  const kind = classify(body);
  if (kind === "safety" || kind === "step1") return { kind, output: answers[kind] };
  if (kind?.startsWith("step2:") === true) {
    const output = answers.step2[kind.slice("step2:".length)];
    return output === undefined ? null : { kind: "step2", output };
  }
  if (kind === "plan") {
    const turn = JSON.parse(body).messages?.[0]?.content;
    if (turn === answers.turnOf.compose) return { kind: "compose", output: answers.compose };
    if (turn === answers.turnOf.rewrite) return { kind: "rewrite", output: answers.rewrite };
  }
  return null;
}

/** Starts the stub; resolves with its URL, the calls it answered by kind, and close(). */
export async function startStub({ classify, answers, delays = DRY_DELAYS }) {
  const answered = {};
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const reply = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method !== "POST" || request.url !== "/v1/messages")
        return reply(404, { type: "error", error: { type: "not_found_error" } });
      if (request.headers["x-api-key"] !== DRY_KEY)
        return reply(401, { type: "error", error: { type: "authentication_error" } });
      const body = Buffer.concat(chunks).toString("utf8");
      const found = answerFor(body, classify, answers);
      if (found === null) return reply(400, { type: "error", error: { type: "invalid_request_error" } });
      answered[found.kind] = (answered[found.kind] ?? 0) + 1;
      const model = JSON.parse(body).model;
      setTimeout(() => {
        reply(200, {
          id: "msg_dry_run",
          type: "message",
          role: "assistant",
          model,
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(found.output) }],
          usage: USAGE,
        });
      }, delays[found.kind] ?? 0);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${String(port)}/v1/messages`,
    answered: () => ({ ...answered }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

#!/usr/bin/env node
// The Linq live check for staging (T-417; C-206 to C-209; K-11 v1; D-018: the human test from a real iPhone once J-08
// gives staging a Linq line). ES module, so strict mode is on.
//
//   node adapters/src/linq/live-check/run.mjs
//
// Who runs it, and where (the card's lead note item 5; NQ-R2): only T-1031, the lead on the build Mac in an interactive
// session with the user present, from the code folder, once Linq's webhook points at staging (T-572). Never headless and
// never in CI: with CI set it refuses. It takes no argument.
//
// One run, in this order; each step runs only when every step before it passed, and nothing goes to Linq before step 5:
//   1. The values, read by name (below) and checked, before anything else; any problem refuses the run.
//   2. The K-06 signature check: T-413's verifier (adapters/src/linq/webhook), under LINQ_WEBHOOK_SECRET, turns Linq's
//      recorded message.received (contracts/port-linq/vendor-samples/webhook-message-received.json), signed under that
//      secret here, into a K-06 text event, and refuses it with one byte changed. Nothing leaves this machine.
//   3. The roster guard (T-416): a send to a number off STAGING_LINQ_ALLOWLIST (a fiction number, 555-01xx, made here),
//      through the very sender step 5 uses, is refused before any call to Linq.
//   4. Staging's logs open (logs.mjs: wrangler tail through cf.sh), before the send, so the reply cannot be missed.
//   5. One text to the roster phone, into its chat with Rosie's line, through T-414's sender (adapters/src/linq/send)
//      wrapped by T-416's guard (adapters/src/linq/roster): guardLinqSender(createLinqSender({env}), {env}). The phone has
//      texted Rosie already, so the chat exists, and Rosie only ever sends into a chat that exists (arch 07 line 369):
//      LINQ_LIVE_CHAT_ID names it. Linq's message id is printed.
//   6. The reply: the person answers the text from the phone, Linq signs a message.received webhook, and staging's gateway
//      checks it (T-413's verifier, with the Worker's LINQ_WEBHOOK_SECRET) and writes it to its actor. Its receive span in
//      staging's logs must say the signature held, a K-06 text (or photo) event, written to its actor, and every span of
//      that event must carry one trace id, which is printed: npm run staging:trace -- <trace id> reads what it wrote.
//
// The values (rule 7; the card's lead note item 4), each read by name: from the environment when it is set there, else
// from its own line of the git-ignored .dev.vars in the folder this runs from (T-419's readDevVar, as infra/scripts/lib.sh's
// load_dev_var reads one name; T-1121's probe reads the same names the same way):
//   LINQ_API_TOKEN          Linq's key (K-11 README default 1)
//   LINQ_WEBHOOK_SECRET     the secret Linq signs webhooks with (K-11's name): whsec_ and base64
//   ROSIE_NUMBER            Rosie's own line, E.164; never a destination
//   STAGING_LINQ_ALLOWLIST  the roster: E.164 numbers joined by commas with no space (T-416; Q-44, Q-53)
//   LINQ_PROBE_TO           the roster phone, needed only when the roster holds more than one number (the probe's name)
//   LINQ_LIVE_CHAT_ID       Linq's id of that phone's chat with Rosie's line
// The key goes to T-414's sender alone, the secret to T-413's verifier alone; neither is printed, and every line printed
// shows each number as its last 2 digits (the probe's maskText, adapters/spikes/linq-live/lib.mjs). The tail's process
// gets this environment without every one of those names (and without LINQ_FROM, the probe's other name for the line).
//
// A request the check does not make never leaves this machine: the sender's HTTP call passes on one request alone, a POST
// to that chat's messages, once; any other (the guarded send of step 3 if the guard let it through, a second send) is
// stopped there, before the network.
//
// What it prints, and its exit code:
//   linq-live-check: PASS: <step>                 (each step; 0 when all six pass)
//   linq-live-check: FAIL: <why>                  1
//   linq-live-check: refused: <why>               1, or 2 for an argument (then "nothing was sent")
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NAMES as PROBE_NAMES, isE164, maskText, masked } from "../../../spikes/linq-live/lib.mjs";
import { readDevVar } from "../../email/resend-send/live-check.mjs";
import { TAIL_DESCRIPTION, openStagingTail, tailEnv } from "./logs.mjs";

/** The names the values are read by. */
export const NAMES = Object.freeze({
  key: PROBE_NAMES.key,
  secret: "LINQ_WEBHOOK_SECRET",
  line: PROBE_NAMES.line,
  roster: PROBE_NAMES.allowList,
  to: PROBE_NAMES.to,
  chat: "LINQ_LIVE_CHAT_ID",
});

/** The git-ignored variables file of the folder this runs from. */
export const VARS_FILE = ".dev.vars";

/** The checkout this file is in: cf.sh and the recorded samples are read from it. */
export const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** Linq's recorded message.received, which step 2 signs and verifies. */
export const RECEIVED_SAMPLE = "webhook-message-received.json";

/** The path, under the base path, that Linq's webhook is pointed at (runtime/src/gateway/index.ts LINQ_WEBHOOK_PATH). */
export const LINQ_WEBHOOK_PATH = "/webhooks/linq";

/** The one text's words: plainly a Rosie staging test, no link, and asking for a reply that is no stop word. */
export const WORDS =
  "Rosie staging live check (T-1031): a test text from Rosie's line. Please reply OK to finish the check.";

/** How long the check waits: for the tail to connect, for the reply after the send, and for the reply's other spans. */
export const WAITS = Object.freeze({ settleMs: 5_000, replyMs: 300_000, traceMs: 10_000 });

/** How far before the send a span's time may be and still count as after it (the Mac's clock against Cloudflare's). */
const CLOCK_SKEW_MS = 5_000;

/** A chat id that names no chat, for step 3's guarded send: should the guard let it through, the HTTP call stops it. */
const NO_SUCH_CHAT = "live-check-no-such-chat";

/** A Linq id as T-414 sends one in a path: visible characters, at most 256, never "." or "..". */
const LINQ_ID = /^[\x21-\x7e]{1,256}$/;
/** A key a header can carry: visible ASCII, at least 8 characters. */
const KEY_FORM = /^[\x21-\x7e]{8,}$/;
/** Linq's webhook secret: whsec_ and base64 (adapters/src/shared/hmac.ts). */
const SECRET_FORM = /^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** An id or label printed as it is: letters, digits and _ . : -, never a run that reads as a number. */
const PRINTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LOOKS_LIKE_NUMBER = /^[0-9().+ -]{7,}$/;

/** The first part of each fiction number step 3 may use: +1, area code 555, then 555-01, then two digits. */
const FICTION_LINE = ["+1", "555", "555", "01"].join("");

/** The values once they are read, so a stray error's text is printed without them. */
const loaded = { secrets: [], numbers: [] };

/** `text` as it may be printed: each secret as [key], each number as its last 2 digits (the probe's maskText). */
function maskWith(text, secrets, numbers) {
  let out = String(text);
  for (const secret of secrets) out = maskText(out, { key: secret, numbers });
  return secrets.length === 0 ? maskText(out, { key: "", numbers }) : out;
}

/** An id as printed: itself when it is a plain id, else "[hidden]". */
function printable(value) {
  return typeof value === "string" && PRINTABLE_ID.test(value) && !LOOKS_LIKE_NUMBER.test(value)
    ? value
    : "[hidden]";
}

/** An error as printed: its name and its message, masked; never its other fields. */
function describeError(error, secrets, numbers) {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : String(error);
  return maskWith(`${name}: ${message}`, secrets, numbers);
}

/** The first fiction number (area code 555, then 555-0100 to 555-0199) on neither the roster nor Rosie's line, or null. */
export function offRosterNumber(roster, line) {
  for (let n = 0; n < 100; n += 1) {
    const number = `${FICTION_LINE}${String(n).padStart(2, "0")}`;
    if (!roster.includes(number) && number !== line) return number;
  }
  return null;
}

/** A value by name: the environment's when it holds one, else the variables file's line for it, else "". */
function valueOf(env, cwd, name) {
  const given = env[name];
  if (typeof given === "string" && given.trim() !== "") return given;
  return readDevVar(path.join(cwd, VARS_FILE), name) ?? "";
}

/**
 * The values checked before anything else. Gives {problems, values}: each problem names its variable (a number at most
 * as its last 2 digits) and never holds a value; values is null unless there is none.
 */
export function checkValues(raw) {
  const problems = [];
  const where = `in the environment or in ${VARS_FILE} in the folder this runs from`;

  if (raw.key === "")
    problems.push(`${NAMES.key} is not set, ${where}: Linq's key, read by name, is needed for the send`);
  else if (!KEY_FORM.test(raw.key))
    problems.push(
      `${NAMES.key} is not a usable key (fewer than 8 characters, or a space or a character a header cannot carry); no part of it is shown`,
    );

  if (raw.secret === "")
    problems.push(
      `${NAMES.secret} is not set, ${where}: the webhook secret, read by name, is needed for the K-06 signature check`,
    );
  else if (raw.secret.length <= "whsec_".length || !SECRET_FORM.test(raw.secret))
    problems.push(
      `${NAMES.secret} is not in the form Linq's webhook secrets take (whsec_, then base64), so T-413's verifier cannot use it; no part of it is shown`,
    );

  const line = isE164(raw.line) ? raw.line : null;
  if (line === null)
    problems.push(
      `${NAMES.line} is not set, or is not an E.164 number: Rosie's own line is never a destination, so it must be known; no part of it is shown`,
    );

  let roster = null;
  if (raw.roster.trim() === "") {
    problems.push(
      `${NAMES.roster} is not set, or is empty: the check sends to no number off that list, so it sends nothing at all (E.164 numbers joined by commas, no space)`,
    );
  } else {
    const entries = raw.roster.split(",");
    const bad = entries.flatMap((entry, i) => (isE164(entry) ? [] : [i + 1]));
    if (bad.length > 0)
      problems.push(
        `${NAMES.roster}: entry ${bad.join(", ")} of ${String(entries.length)} is not an E.164 number (+, then 7 to 15 digits, joined by commas with no space); no part of it is shown`,
      );
    else roster = [...new Set(entries)];
  }

  let destination = null;
  if (raw.to !== "") {
    if (!isE164(raw.to)) problems.push(`${NAMES.to} is not an E.164 number; no part of it is shown`);
    else if (roster !== null && !roster.includes(raw.to))
      problems.push(
        `${NAMES.to} (${masked(raw.to)}) is not on ${NAMES.roster}: the check sends to no number off that list`,
      );
    else destination = raw.to;
  } else if (roster !== null && roster.length > 1) {
    problems.push(
      `${NAMES.roster} holds ${String(roster.length)} numbers and ${NAMES.to} names none: name the roster phone with ${NAMES.to}`,
    );
  } else if (roster !== null) destination = roster[0];
  if (destination !== null && line !== null && destination === line)
    problems.push(
      `the destination is Rosie's own line (${NAMES.line}): the check never texts the line itself`,
    );

  if (raw.chat === "")
    problems.push(
      `${NAMES.chat} is not set, ${where}: Linq's id of the roster phone's chat with Rosie's line (the phone has texted Rosie, so it exists), which the text goes into`,
    );
  else if (!LINQ_ID.test(raw.chat) || raw.chat === "." || raw.chat === "..")
    problems.push(
      `${NAMES.chat} is not a Linq id (visible characters, at most 256, not . or ..); it is not shown`,
    );

  const offRoster = roster !== null && line !== null ? offRosterNumber(roster, line) : null;
  if (roster !== null && line !== null && offRoster === null)
    problems.push(
      `${NAMES.roster} holds every fiction number (555-0100 to 555-0199), so step 3 has no number off it to try`,
    );

  if (problems.length > 0 || roster === null || line === null || destination === null || offRoster === null)
    return { problems, values: null };
  return {
    problems,
    values: {
      key: raw.key,
      secret: raw.secret,
      line,
      roster,
      rosterText: raw.roster,
      destination,
      chat: raw.chat,
      offRoster,
    },
  };
}

/** One K-11 v1 sendPart request: words, into `chatId`, to `to`, under its K-07 key. */
export function wordsRequest(to, chatId, idempotencyKey) {
  return {
    idempotencyKey,
    to,
    chatId,
    service: "imessage",
    kind: "words",
    text: WORDS,
    calendarFile: null,
    options: [],
    link: null,
    photo: null,
    tapback: null,
    threadedReplyTo: null,
    typing: null,
    overrideOptout: false,
  };
}

/** The adapters the check runs: the code staging runs (T-413, T-414, T-416) and the shared helpers. */
async function loadAdapters() {
  const [send, roster, webhook, hmac, samples] = await Promise.all([
    import("../send/index.ts"),
    import("../roster/index.ts"),
    import("../webhook/index.ts"),
    import("../../shared/hmac.ts"),
    import("../../shared/samples.ts"),
  ]);
  return { send, roster, webhook, hmac, samples };
}

/**
 * The HTTP call T-414's sender is given: it passes on one request alone, a POST to `allowedUrl`, once, to `liveFetch`,
 * and stops any other before it leaves this machine (it throws, which the sender reads as no answer).
 */
function gatedFetch(liveFetch, allowedUrl) {
  const gate = { passed: 0, stopped: 0 };
  gate.fetch = (request) => {
    if (request.method !== "POST" || request.url !== allowedUrl || gate.passed > 0) {
      gate.stopped += 1;
      return Promise.reject(
        new Error("a request the live check does not make: stopped before it left this machine"),
      );
    }
    gate.passed += 1;
    return liveFetch(request);
  };
  return gate;
}

/** Whether a span is a gateway's receive span of a webhook to Linq's path. */
function isLinqReceive(record) {
  const { span, path: where } = record;
  return (
    span.hop === "receive" &&
    span.provider === "linq" &&
    typeof where === "string" &&
    where.endsWith(LINQ_WEBHOOK_PATH)
  );
}

/** Whether a receive span says a signed K-06 text or photo event, written to its actor, with an event id and a trace id. */
function isSignedEventWritten(span) {
  const decided = typeof span.decided === "object" && span.decided !== null ? span.decided : {};
  const got = typeof span.got === "object" && span.got !== null ? span.got : {};
  return (
    span.outcome === "ok" &&
    decided.signatureValid === true &&
    decided.sealedToActor === true &&
    (got.kind === "text" || got.kind === "photo") &&
    typeof span.event_id === "string" &&
    span.event_id !== "" &&
    typeof span.trace_id === "string" &&
    span.trace_id !== ""
  );
}

/** Whether a span's time is at or after `fromMs` (less the clock skew). */
function isAfter(span, fromMs) {
  const at = typeof span.at === "string" ? Date.parse(span.at) : Number.NaN;
  return !Number.isNaN(at) && at >= fromMs - CLOCK_SKEW_MS;
}

const wholeSecondsStamp = (ms) =>
  new Date(ms)
    .toISOString()
    .replace(/[.][0-9]+Z$/, "Z")
    .replace(/[-:]/g, "");

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The live check, with what it reads and writes handed in: `env` and `cwd` (where the values are read), `fetch` (the
 * network, given to T-414's sender behind the gate), `spawnProcess` (for the tail; logs.mjs), `now` and `sleep`, `waits`
 * (WAITS by default), and `out` and `err` for lines. Returns the exit code.
 */
export async function runLiveCheck(io) {
  const { argv = [], env, cwd, out, err } = io;
  const root = io.root ?? ROOT;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? sleepFor;
  const waits = { ...WAITS, ...io.waits };
  const liveFetch = io.fetch ?? ((request) => fetch(request));
  let secrets = [];
  let numbers = [];
  const say = (write, line) => write(maskWith(`linq-live-check: ${line}`, secrets, numbers));
  let tail = null;
  try {
    const adapters = await loadAdapters();
    if (argv.length > 0) {
      say(err, "refused: it takes no argument (arguments are never echoed); nothing was sent");
      return 2;
    }
    if (typeof env.CI === "string" && env.CI !== "") {
      say(
        err,
        "refused: CI is set, and the live check runs only in an interactive session with the user present (NQ-R2); nothing was sent",
      );
      return 1;
    }

    // 1. The values, by name, before anything else.
    const raw = {
      key: valueOf(env, cwd, NAMES.key),
      secret: valueOf(env, cwd, NAMES.secret),
      line: valueOf(env, cwd, NAMES.line),
      roster: valueOf(env, cwd, NAMES.roster),
      to: valueOf(env, cwd, NAMES.to),
      chat: valueOf(env, cwd, NAMES.chat),
    };
    secrets = [raw.key, raw.secret].filter((value) => value !== "");
    numbers = [raw.line, raw.to, ...raw.roster.split(",")].filter((value) => isE164(value));
    loaded.secrets = secrets;
    loaded.numbers = numbers;
    const { problems, values } = checkValues(raw);
    if (values === null) {
      for (const problem of problems) say(err, `refused: ${problem}`);
      say(err, "nothing was sent");
      return 1;
    }

    // 2. The K-06 signature check, here: T-413's verifier under the secret, on Linq's recorded message.received.
    const sampleDir = path.join(root, "contracts", "port-linq", "vendor-samples");
    const received = adapters.samples.loadRecordedSampleText(sampleDir, RECEIVED_SAMPLE);
    const sample = JSON.parse(received);
    const verifier = adapters.webhook.createLinqWebhookVerifier({ secret: () => values.secret });
    const signedAt = now();
    const timestamp = String(Math.floor(signedAt / 1000));
    const checkTrace = randomUUID();
    const signedRequest = {
      webhookId: sample.event_id,
      timestamp,
      signature: await adapters.hmac.signLinqWebhook(values.secret, sample.event_id, timestamp, received),
      raw: received,
      receivedAt: new Date(signedAt).toISOString(),
      traceId: checkTrace,
    };
    // One byte changed: the r of its event type, message.received, made R.
    const at = received.indexOf("received");
    const changed = `${received.slice(0, at)}R${received.slice(at + 1)}`;
    const good = await verifier.verifyWebhook(signedRequest);
    const forged = at < 0 ? good : await verifier.verifyWebhook({ ...signedRequest, raw: changed });
    const verified =
      good.result === "event" &&
      good.event.provider === "linq" &&
      good.event.kind === "text" &&
      good.event.traceId === checkTrace &&
      forged.result === "rejected" &&
      forged.reason === "badSignature";
    if (!verified) {
      say(
        err,
        `FAIL: the K-06 signature check: T-413's verifier under ${NAMES.secret} answered ${good.result} for Linq's recorded message.received signed under it, and ${forged.result} for it with one byte changed; nothing was sent`,
      );
      return 1;
    }
    say(
      out,
      `PASS: the K-06 signature check: T-413's verifier, under ${NAMES.secret}, turned Linq's recorded message.received, signed under it, into a K-06 text event, and refused it with one byte changed (badSignature)`,
    );

    // 3. The roster guard, through the sender step 5 uses: a number off the roster is refused before any call to Linq.
    const allowedUrl = new URL(
      `${adapters.send.LINQ_API_BASE}/chats/${encodeURIComponent(values.chat)}/messages`,
    ).href;
    const gate = gatedFetch(liveFetch, allowedUrl);
    const linqEnv = {
      ENVIRONMENT: "staging",
      [NAMES.key]: values.key,
      [NAMES.roster]: values.rosterText,
      [NAMES.line]: values.line,
    };
    const guardLines = [];
    const sender = adapters.roster.guardLinqSender(
      adapters.send.createLinqSender({ env: linqEnv, fetch: gate.fetch }),
      { env: linqEnv, log: (line) => guardLines.push(line) },
    );
    const runKey = `live-check-t1031-${wholeSecondsStamp(now())}-${randomUUID().slice(0, 8)}`;
    const offRoster = await sender.sendPart(
      wordsRequest(values.offRoster, NO_SUCH_CHAT, `${runKey}-off-roster/1/1`),
    );
    let guardWhy = null;
    try {
      guardWhy = guardLines.length === 1 ? JSON.parse(guardLines[0]).why : null;
    } catch {
      guardWhy = null;
    }
    const guarded =
      offRoster.result === "failed" &&
      offRoster.kind === "refused" &&
      offRoster.httpStatus === null &&
      offRoster.reason === adapters.roster.REASONS.offRoster &&
      guardWhy === "offRoster" &&
      gate.passed === 0 &&
      gate.stopped === 0;
    if (!guarded) {
      say(
        err,
        `FAIL: the roster guard did not refuse a send to ${masked(values.offRoster)}, a number off ${NAMES.roster}, before the HTTP call (requests stopped there: ${String(gate.stopped)}); nothing left this machine and nothing was sent`,
      );
      return 1;
    }
    say(
      out,
      `PASS: the roster guard refused a send to ${masked(values.offRoster)}, a number off ${NAMES.roster}, before any call to Linq`,
    );

    // 4. Staging's logs, open before the send.
    tail = openStagingTail({
      root,
      env: tailEnv(env, [...Object.values(NAMES), PROBE_NAMES.lineElse]),
      ...(io.spawnProcess === undefined ? {} : { spawnProcess: io.spawnProcess }),
    });
    say(out, `reading staging's logs through ${TAIL_DESCRIPTION}, from before the send`);
    await sleep(waits.settleMs);
    for (;;) {
      const early = await tail.read(0);
      if (early.kind === "timeout") break;
      if (early.kind === "ended") {
        say(
          err,
          `FAIL: staging's logs could not be read: the tail ended (exit ${String(early.code ?? "none")}) before the send; run npm run cf -- tail --env staging by hand to see why; nothing was sent`,
        );
        return 1;
      }
    }

    // 5. The one text, into the roster phone's chat.
    const sentAt = now();
    const sent = await sender.sendPart(wordsRequest(values.destination, values.chat, `${runKey}/1/1`));
    if (sent.result !== "accepted") {
      say(
        err,
        `FAIL: Linq answered ${sent.kind} (HTTP ${String(sent.httpStatus ?? "none")}, ${sent.code ?? "no code"}) to the text to ${masked(values.destination)}: ${sent.reason}`,
      );
      return 1;
    }
    if (typeof sent.providerMessageId !== "string" || sent.providerMessageId === "" || gate.passed !== 1) {
      say(err, "FAIL: Linq accepted the text, but its answer named no message id");
      return 1;
    }
    say(
      out,
      `PASS: Linq accepted the text to ${masked(values.destination)}: message id ${printable(sent.providerMessageId)}`,
    );
    say(
      out,
      `waiting up to ${String(Math.round(waits.replyMs / 1000))} s for the reply in staging's logs: reply OK to the text on the phone ${masked(values.destination)}`,
    );

    // 6. The reply: a signed K-06 event in staging's logs, with one trace id.
    const deadline = sentAt + waits.replyMs;
    let reply = null;
    let notWritten = null;
    for (;;) {
      const left = deadline - now();
      if (left <= 0) break;
      const got = await tail.read(left);
      if (got.kind === "timeout") break;
      if (got.kind === "ended") {
        say(
          err,
          `FAIL: staging's logs ended (exit ${String(got.code ?? "none")}) before the reply came; run npm run cf -- tail --env staging by hand to see why`,
        );
        return 1;
      }
      if (!isLinqReceive(got.record) || !isAfter(got.record.span, sentAt)) continue;
      const span = got.record.span;
      const decided = typeof span.decided === "object" && span.decided !== null ? span.decided : {};
      if (decided.signatureValid === false) {
        say(
          err,
          `FAIL: a Linq webhook reached staging after the send, but its signature did not hold (${printable(span.error_code)}): staging's ${NAMES.secret} is not the secret Linq signs with (trace id ${printable(span.trace_id)})`,
        );
        return 1;
      }
      if (isSignedEventWritten(span)) {
        reply = span;
        break;
      }
      notWritten ??= span;
    }
    if (reply === null) {
      const seen =
        notWritten === null
          ? "no Linq webhook reached staging"
          : `a Linq webhook reached staging but was not written as a K-06 text (outcome ${printable(notWritten.outcome)}, ${printable(notWritten.error_code)}, trace id ${printable(notWritten.trace_id)})`;
      say(
        err,
        `FAIL: no signed reply in staging's logs within ${String(Math.round(waits.replyMs / 1000))} s of the send: ${seen}`,
      );
      return 1;
    }

    // Every span of the reply's event carries one trace id: its receive span's, and the scrub span that follows it.
    const traceIds = new Set([reply.trace_id]);
    let scrub = null;
    const until = now() + waits.traceMs;
    for (;;) {
      const left = until - now();
      if (scrub !== null || left <= 0) break;
      const got = await tail.read(left);
      if (got.kind !== "record") break;
      const span = got.record.span;
      if (span.event_id !== reply.event_id) continue;
      traceIds.add(span.trace_id);
      if (span.hop === "scrub") scrub = span;
    }
    if (traceIds.size !== 1) {
      say(
        err,
        `FAIL: the reply's spans in staging's logs carry ${String(traceIds.size)} trace ids, not one (receive under ${printable(reply.trace_id)})`,
      );
      return 1;
    }
    if (scrub === null) {
      say(
        err,
        `FAIL: the reply's receive span came (trace id ${printable(reply.trace_id)}), but no scrub span of its event within ${String(Math.round(waits.traceMs / 1000))} s, so its trace is not shown whole`,
      );
      return 1;
    }
    say(
      out,
      `PASS: the reply arrived in staging's logs as a signed K-06 ${printable(reply.got.kind)} event, written to its actor, with one trace id: ${printable(reply.trace_id)} (receive and scrub; npm run staging:trace -- ${printable(reply.trace_id)} reads what it wrote)`,
    );
    return 0;
  } catch (error) {
    say(err, `failed: ${describeError(error, secrets, numbers)}`);
    return 1;
  } finally {
    await tail?.close();
  }
}

function runAsScript() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runAsScript()) {
  // An error no catch takes is printed as its name and message, masked, never with its fields.
  for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.on(event, (error) => {
      console.error(`linq-live-check: failed: ${describeError(error, loaded.secrets, loaded.numbers)}`);
      process.exit(1);
    });
  }
  // The adapters import each other without an extension, as the bundler resolves them; Node completes a relative import
  // from a .ts file with .ts or /index.ts here, as db/seeds/run.mjs, infra/flags/flags.mjs and T-419's live check do.
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parent = context.parentURL ?? "";
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
        for (const suffix of [".ts", "/index.ts"]) {
          try {
            return nextResolve(`${specifier}${suffix}`, context);
          } catch {
            // not this form: try the next one
          }
        }
        throw error;
      }
    },
  });
  process.exitCode = await runLiveCheck({
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}

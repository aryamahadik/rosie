// The spike's one way out (T-362): the fetch every model call of the run goes through, handed to the AI gateway, the
// safety read, decide and the composer as their `fetch` seam (FetchLike), exactly as the Worker hands them its own.
//
//   - Only the Messages endpoint the gateway names (API_URL) is accepted; the request goes on, unchanged, to the run's
//     one transport address: Anthropic's endpoint itself (live), or the local stub on 127.0.0.1 (dry). Nothing else.
//   - A cap: at most `limit` calls go out in all, counting `already` (the live calls earlier runs counted on disk), so a
//     second run can never pass the card's 40. Past the cap a call is answered here (HTTP 599) and never sent.
//   - Counted before it is sent: `count(record)` is handed each call's record (its number in all, the unit, the kind,
//     the call, the model and the time: labels alone) before the call goes out; a live run puts it on disk there, one
//     line in runs/sent.jsonl (run.mjs). If `count` throws, the call is not sent, so a run stopped at any point has
//     counted every call it sent, the one going out included.
//   - A fallback on purpose: while a unit names a model in `inject`, a call to that model is answered here with
//     Anthropic's overloaded status (HTTP 529) and never sent, so the production path's own fallback (the safety read's
//     Sonnet try, the gateway's other model) runs for real. Such a call costs nothing and is never counted or timed.
//   - Each call that goes out is timed to its last byte (wireMs), and its abort signal is not passed on: the stage's own
//     timer still gives up on time (the gateway and the safety read race their timer, so a fetch that ignores the signal
//     times out on time), but the call itself runs to its end, so a call the stage cut off still shows its real time.
//     A call that has not answered in WIRE_LIMIT_MS is stopped here, whatever the stage.
//   - A record holds labels and counts alone: the model, the unit, the HTTP status, the stop reason, the token counts and
//     the times. Never a header (the key rides x-api-key alone, as the gateway set it), a prompt or an answer's words.

/** The Messages endpoint the AI gateway calls (ai/src/gateway/gateway.ts API_URL); run.mjs checks the two are one. */
export const API_URL = "https://api.anthropic.com/v1/messages";

/** HTTP status of a call answered here: a fallback on purpose (Anthropic's "overloaded"), and one past the cap. */
export const INJECTED_STATUS = 529;
export const CAPPED_STATUS = 599;

/** The longest a call that went out may take before the spike stops it (far above every stage's timeout). */
export const WIRE_LIMIT_MS = 60_000;

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}\/v1\/messages$/u;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/** The transport address a mode may use, or an error naming why not (never the address itself). */
export function transportProblem(mode, transportUrl) {
  if (mode === "live") return transportUrl === API_URL ? null : "a live run calls Anthropic's endpoint alone";
  if (mode === "dry")
    return LOOPBACK.test(transportUrl) ? null : "a dry run calls the local stub on 127.0.0.1 alone";
  return "the mode is live or dry";
}

/** The model a request body names, or null. */
function modelOf(body) {
  try {
    const parsed = JSON.parse(body);
    return isRecord(parsed) && typeof parsed.model === "string" ? parsed.model : null;
  } catch {
    return null;
  }
}

/** The labels and counts of an answer's body: its stop reason and token counts, never its words. */
export function answerFacts(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { stop: null, tokens: null };
  }
  if (!isRecord(parsed)) return { stop: null, tokens: null };
  const stop = typeof parsed.stop_reason === "string" ? parsed.stop_reason : null;
  const usage = isRecord(parsed.usage) ? parsed.usage : null;
  const tokens =
    usage === null
      ? null
      : {
          input: count(usage.input_tokens),
          cachedRead: count(usage.cache_read_input_tokens),
          cacheWrite: count(usage.cache_creation_input_tokens),
          output: count(usage.output_tokens),
        };
  return { stop, tokens };
}

/**
 * Builds the run's fetch. `transport` is the real fetch (globalThis.fetch); `classify(body)` names a call's kind for its
 * record (a label, or null); `count(record)` is told of each call before it goes out (a throw sends nothing); `now`
 * gives milliseconds for timing (performance.now).
 */
export function createWire({
  mode,
  transport,
  transportUrl,
  limit,
  already = 0,
  classify = () => null,
  count = () => undefined,
  now = () => performance.now(),
  clock = () => Date.now(),
}) {
  const problem = transportProblem(mode, transportUrl);
  if (problem !== null) throw new Error(`refused: ${problem}`);
  if (!Number.isInteger(limit) || limit < 0) throw new Error("refused: the call limit is a whole number");
  if (!Number.isInteger(already) || already < 0)
    throw new Error("refused: the calls already made is a whole number");

  const records = [];
  const pending = new Set();
  let sent = 0;
  let unit = { unit: null, kind: null, inject: [] };

  /** One call that goes out: counted first, timed to its last byte, never handed the caller's abort signal. */
  const goOut = (init, label) => {
    const record = {
      n: already + sent + 1,
      ...label,
      status: null,
      wireMs: null,
      at: new Date(clock()).toISOString(),
    };
    // On disk before it is sent (a live run); a throw here leaves the call unsent and uncounted in memory too.
    count({ ...record });
    sent += 1;
    records.push(record);
    const started = now();
    const exchange = (async () => {
      try {
        const response = await transport(transportUrl, {
          method: "POST",
          headers: init.headers,
          body: init.body,
          redirect: "manual",
          signal: AbortSignal.timeout(WIRE_LIMIT_MS),
        });
        const text = await response.text();
        record.wireMs = Math.round(now() - started);
        record.status = response.status;
        Object.assign(record, answerFacts(text));
        return { status: response.status, text };
      } catch (error) {
        record.wireMs = Math.round(now() - started);
        record.status = 0;
        record.error = error?.name === "TimeoutError" ? "wireLimit" : "network";
        // The gateway and the safety read take any throw as a network failure, a label; the cause is never logged.
        throw new Error("the call had no answer", { cause: error });
      }
    })();
    pending.add(exchange);
    exchange.then(
      () => pending.delete(exchange),
      () => pending.delete(exchange),
    );
    return exchange;
  };

  /** The FetchLike the production code is handed. */
  const fetchLike = async (url, init) => {
    if (url !== API_URL) throw new Error("refused: the spike sends to the Messages endpoint alone");
    const body = typeof init?.body === "string" ? init.body : "";
    const model = modelOf(body);
    const label = { unit: unit.unit, kind: unit.kind, call: classify(body), model };
    if (model !== null && unit.inject.includes(model)) {
      records.push({ ...label, local: "injected", status: INJECTED_STATUS });
      return new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error" } }), {
        status: INJECTED_STATUS,
        headers: { "content-type": "application/json" },
      });
    }
    if (already + sent >= limit) {
      records.push({ ...label, local: "capped", status: CAPPED_STATUS });
      return new Response(JSON.stringify({ type: "error", error: { type: "spike_call_limit" } }), {
        status: CAPPED_STATUS,
        headers: { "content-type": "application/json" },
      });
    }
    const answer = await goOut(init, label);
    return new Response(answer.text, {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  };

  return {
    fetch: fetchLike,
    /** The unit the next calls belong to, and the models whose calls are answered here as a fallback on purpose. */
    setUnit(next) {
      unit = { unit: next.unit ?? null, kind: next.kind ?? null, inject: [...(next.inject ?? [])] };
    },
    /** Calls that went out in this run. */
    sent: () => sent,
    /** Calls still allowed in all (the cap less every call already made, this run's included). */
    left: () => Math.max(0, limit - already - sent),
    /** Every record so far: the calls that went out, then (marked `local`) the ones answered here. */
    records: () => records.map((record) => ({ ...record })),
    /** Waits (at most `ms`) for every call that went out to end, so a call its stage gave up on still gets its time. */
    async settle(ms = WIRE_LIMIT_MS) {
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      try {
        await Promise.race([Promise.allSettled([...pending]), late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

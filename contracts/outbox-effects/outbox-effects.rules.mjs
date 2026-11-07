// K-07's named rule (T-016): what one JSON Schema cannot state about an outbox row's or an effect row's life.
// `npm run contracts:check` runs the rule a fixtures/index.json entry names ("rule") on a fixture that has already
// passed the schema (contracts/scripts/check-fixtures.mjs). The schema lists the allowed moves one by one; this rule
// checks that the moves of one record chain together, in time, under the retry rules. README "Named rule".
//
// A rule takes one record and returns its problems, one line each; an empty list passes.
// Rules are only ever added: a later minor version adds a rule under a new name and never changes this one.

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** After a 4001 or 4006 a new key waits for a receipt this long (arch 01 line 65). */
export const RECEIPT_WAIT_MS = 1 * MINUTE;
/** The second send waits for the first's receipt, at most this long after Linq accepts it (arch 07 line 367). */
export const SECOND_SEND_WAIT_MS = 10 * SECOND;
/** A failed safety line retries every 10 s (arch 02 line 125). */
export const SAFETY_RETRY_MS = 10 * SECOND;
/** Sends still failing after 15 minutes of tries take the next way (arch 02 line 125). */
export const GIVE_UP_AFTER_MS = 15 * MINUTE;
/** Effects: 5 tries in 10 minutes on one key, then the outage row (arch 10 line 542; README default 3). */
export const EFFECT_TRIES = 5;
export const EFFECT_WINDOW_MS = 10 * MINUTE;

/** The error codes that may still deliver (arch 01 line 65). */
const MAY_STILL_DELIVER = new Set(["4001", "4006"]);

const time = (utc) => Date.parse(utc);

/** Checks that `moves` (one subject's, in order) start at null, chain from each `to` to the next `from`, and end in `state`. */
function checkChain(moves, state, label, problems) {
  if (moves.length === 0) {
    problems.push(`${label}: has no moves`);
    return;
  }
  if (moves[0].from !== null) problems.push(`${label}: its first move must start from null (it is written)`);
  for (let k = 1; k < moves.length; k += 1) {
    if (moves[k].from !== moves[k - 1].to) {
      problems.push(
        `${label}: move ${k + 1} starts from ${moves[k].from}, but the one before ended in ${moves[k - 1].to}`,
      );
    }
  }
  const last = moves[moves.length - 1].to;
  if (last !== state) problems.push(`${label}: its moves end in ${last}, but its state is ${state}`);
}

/** Checks that `moves` are in time order. */
function checkTimeOrder(moves, problems) {
  for (let k = 1; k < moves.length; k += 1) {
    if (time(moves[k].at) < time(moves[k - 1].at)) {
      problems.push(
        `moves: move ${k + 1} (${moves[k].at}) is earlier than the one before (${moves[k - 1].at})`,
      );
    }
  }
}

function outboxLifeProblems(life) {
  const problems = [];
  const { row, parts, claim, moves, followUps } = life;
  checkTimeOrder(moves, problems);

  const rowMoves = moves.filter((move) => move.subject === "row");
  checkChain(rowMoves, row.state, `row ${row.id}`, problems);

  // Parts: each belongs to the row and carries the key (row, part, try) (arch 01 line 65).
  const byKey = new Map();
  for (const part of parts) {
    const label = `part ${part.idempotencyKey}`;
    if (part.outboxRowId !== row.id) problems.push(`${label}: belongs to ${part.outboxRowId}, not ${row.id}`);
    const key = `${row.id}/${part.partNo}/${part.tryNo}`;
    if (part.idempotencyKey !== key) problems.push(`${label}: its key must be ${key}`);
    if (byKey.has(part.idempotencyKey)) problems.push(`${label}: listed twice`);
    byKey.set(part.idempotencyKey, part);
  }
  const partMoves = new Map();
  for (const move of moves) {
    if (move.subject !== "part") continue;
    if (!byKey.has(move.key)) {
      problems.push(`moves: a move of ${move.key}, which is not among the parts`);
      continue;
    }
    if (!partMoves.has(move.key)) partMoves.set(move.key, []);
    partMoves.get(move.key).push(move);
  }
  for (const [key, part] of byKey) {
    checkChain(partMoves.get(key) ?? [], part.state, `part ${key}`, problems);
  }

  const firstAt = (key, to) => (partMoves.get(key) ?? []).find((move) => move.to === to)?.at;

  // A new key only after a reported failure; after a 4001 or 4006 only when no receipt came within 1 minute
  // (arch 01 line 65); a failed safety line retries every 10 s (arch 02 line 125).
  for (const part of parts) {
    if (part.tryNo === 1) continue;
    const label = `part ${part.idempotencyKey}`;
    const earlierKey = `${row.id}/${part.partNo}/${part.tryNo - 1}`;
    const earlierFailedAt = firstAt(earlierKey, "failed");
    const writtenAt = (partMoves.get(part.idempotencyKey) ?? [])[0]?.at;
    if (!byKey.has(earlierKey) || earlierFailedAt === undefined || writtenAt === undefined) {
      problems.push(`${label}: a new key comes only after a reported failure of ${earlierKey}`);
      continue;
    }
    if (time(writtenAt) < time(earlierFailedAt)) {
      problems.push(`${label}: written before ${earlierKey} reported its failure`);
    }
    const failure = (partMoves.get(earlierKey) ?? []).find((move) => move.to === "failed");
    if (MAY_STILL_DELIVER.has(failure.errorCode)) {
      if (time(writtenAt) - time(earlierFailedAt) < RECEIPT_WAIT_MS) {
        problems.push(
          `${label}: after a ${failure.errorCode} a new key waits 1 minute for a delivery receipt (arch 01 line 65)`,
        );
      }
      const deliveredAt = firstAt(earlierKey, "delivered");
      if (deliveredAt !== undefined && time(deliveredAt) <= time(writtenAt)) {
        problems.push(
          `${label}: ${earlierKey} delivered after its ${failure.errorCode}, so no new key is made`,
        );
      }
    }
    if (row.sendClass === "safety" && time(writtenAt) - time(earlierFailedAt) < SAFETY_RETRY_MS) {
      problems.push(`${label}: a failed safety line retries every 10 s (arch 02 line 125)`);
    }
  }

  // The second send waits for the words' delivery receipt, at most 10 s after Linq accepts them (arch 07 line 367).
  for (const part of parts) {
    if (part.partNo !== 2) continue;
    const sentAt = firstAt(part.idempotencyKey, "sent");
    if (sentAt === undefined) continue;
    const words = parts.filter((other) => other.partNo === 1);
    const ready = words.some((other) => {
      const wordsSent = firstAt(other.idempotencyKey, "sent");
      const wordsDelivered = firstAt(other.idempotencyKey, "delivered");
      return (
        (wordsDelivered !== undefined && time(wordsDelivered) <= time(sentAt)) ||
        (wordsSent !== undefined && time(sentAt) - time(wordsSent) >= SECOND_SEND_WAIT_MS)
      );
    });
    if (!ready) {
      problems.push(
        `part ${part.idempotencyKey}: the second send waits for the words' receipt, or 10 s after they were accepted (arch 07 line 367)`,
      );
    }
  }

  // The claim's firstTryAt: when the first part went to the provider, kept across re-claims (arch 02 line 125). It
  // falls between the first part move and the first part outcome (sent, failed or delivered), and is set once a part
  // has had one.
  const allPartMoves = moves.filter((move) => move.subject === "part");
  const firstOutcome = allPartMoves.find((move) => ["sent", "failed", "delivered"].includes(move.to));
  if (claim !== null) {
    if (claim.firstTryAt === null) {
      if (firstOutcome !== undefined)
        problems.push(
          `claim: firstTryAt is null, but a part reached ${firstOutcome.to} at ${firstOutcome.at}`,
        );
    } else if (allPartMoves.length === 0 || time(claim.firstTryAt) < time(allPartMoves[0].at)) {
      problems.push("claim: firstTryAt comes before any part was written");
    } else if (firstOutcome !== undefined && time(claim.firstTryAt) > time(firstOutcome.at)) {
      problems.push(`claim: firstTryAt is after the first part outcome (${firstOutcome.at})`);
    }
  }

  // A row fails only after 15 minutes of tries, counted from the claim's firstTryAt (arch 02 line 125).
  const failedMove = rowMoves.find((move) => move.to === "failed");
  if (failedMove !== undefined) {
    const firstTryAt = claim?.firstTryAt ?? null;
    if (firstTryAt === null || time(failedMove.at) - time(firstTryAt) < GIVE_UP_AFTER_MS) {
      problems.push(
        `row ${row.id}: fails only after 15 minutes of tries from the claim's firstTryAt (arch 02 line 125)`,
      );
    }
  }

  // The claim's nextTryNotBefore (the provider's Retry-After: arch 10 line 540) is set only while a next try waits:
  // the row is sending, a part is pending, and that part has not moved since it was set (the try clears it).
  if (claim !== null && claim.nextTryNotBefore !== null) {
    const waiting = parts.filter((part) => part.state === "pending");
    const lastMoveAt = (key) => {
      const own = partMoves.get(key) ?? [];
      return own.length > 0 ? own[own.length - 1].at : undefined;
    };
    if (row.state !== "sending" || waiting.length === 0) {
      problems.push("claim: nextTryNotBefore is set only while the row is sending with a part pending");
    } else if (
      !waiting.some((part) => {
        const at = lastMoveAt(part.idempotencyKey);
        return at !== undefined && time(at) < time(claim.nextTryNotBefore);
      })
    ) {
      problems.push(
        "claim: nextTryNotBefore must come after the pending part's latest move (a try clears it)",
      );
    }
  }

  // The claim: a sending row has one; its number counts the claims (README "How a claim lapses").
  const claims = rowMoves.filter((move) => move.to === "sending").length;
  if (row.state === "sending" && claim === null) problems.push(`row ${row.id}: a sending row has its claim`);
  if (claim !== null) {
    if (claims === 0) problems.push(`row ${row.id}: has a claim but was never claimed`);
    else if (claim.claimNo !== claims)
      problems.push(`claim: claimNo is ${claim.claimNo}, but the row was claimed ${claims} times`);
    if (time(claim.lapsesAt) <= time(claim.claimedAt))
      problems.push("claim: lapses_at must be after claimed_at");
  }

  // What followed: the next way or the owner's number only after a failure; other ways at once only for safety.
  for (const followUp of followUps) {
    if ((followUp.why === "nextWay" || followUp.why === "ownerGetsNumber") && row.state !== "failed") {
      problems.push(`followUps: ${followUp.why} follows only a failed row (arch 02 line 125)`);
    }
    if (followUp.why === "safetyOtherWay" && row.sendClass !== "safety") {
      problems.push("followUps: safetyOtherWay follows only a safety line (arch 02 line 125)");
    }
    if (followUp.why === "chatOpenAnswer" && row.state !== "superseded") {
      problems.push("followUps: chatOpenAnswer follows only a superseded row (arch 06 line 313)");
    }
  }
  // A superseded row gave way to exactly one message, written in the same commit (arch 06 line 313: 'then one
  // message gives each booking as it stands'; RULES 4.1b).
  if (row.state === "superseded") {
    const answers = followUps.filter((followUp) => followUp.why === "chatOpenAnswer");
    const superseded = rowMoves.find((move) => move.to === "superseded");
    if (answers.length !== 1) {
      problems.push(`row ${row.id}: a superseded row names the one message it gave way to (chatOpenAnswer)`);
    } else if (superseded !== undefined && answers[0].at !== superseded.at) {
      problems.push(`row ${row.id}: the one message is written in the commit that supersedes the row`);
    } else if (answers[0].recipientHandleId !== row.recipientHandleId) {
      problems.push(`row ${row.id}: the one message goes to the same mobile that texted in`);
    }
  }
  return problems;
}

function effectLifeProblems(life) {
  const problems = [];
  const { effect, moves } = life;
  checkTimeOrder(moves, problems);
  checkChain(moves, effect.state, `effect ${effect.effectId}`, problems);

  // Runs: a run starts at each claim from pending and each run after an outage (arch 11 line 582).
  // A run's first try goes when the run starts; each move with a tryOutcome records one try's outcome.
  const runs = [];
  for (const move of moves) {
    if (move.to === "running" && (move.from === "pending" || move.from === "outage")) {
      runs.push({ startedAt: move.at, tries: [] });
    }
    if (move.tryOutcome !== null) {
      if (runs.length === 0) problems.push(`effect ${effect.effectId}: a try outside a run`);
      else runs[runs.length - 1].tries.push(move);
    }
  }
  if (runs.length > 0 && effect.runs !== runs.length) {
    problems.push(`effect ${effect.effectId}: runs is ${effect.runs}, but its moves show ${runs.length}`);
  }
  runs.forEach(({ startedAt, tries }, k) => {
    const label = `effect ${effect.effectId} run ${k + 1}`;
    if (tries.length > EFFECT_TRIES)
      problems.push(`${label}: more than ${EFFECT_TRIES} tries (arch 10 line 542)`);
    if (tries.length > 0 && time(tries[tries.length - 1].at) - time(startedAt) > EFFECT_WINDOW_MS) {
      problems.push(`${label}: its tries span more than 10 minutes (arch 10 line 542)`);
    }
    tries.forEach((attempt, n) => {
      if (attempt.to === "outage" && n !== EFFECT_TRIES - 1) {
        problems.push(
          `${label}: takes the outage row only after its ${EFFECT_TRIES}th try (arch 10 line 542)`,
        );
      }
    });
  });
  const current = runs[runs.length - 1];
  const currentTries = current?.tries.length ?? 0;
  if (effect.tries !== currentTries) {
    problems.push(
      `effect ${effect.effectId}: tries is ${effect.tries}, but its last run shows ${currentTries}`,
    );
  }
  const startedAt = current?.startedAt ?? null;
  if (effect.firstTryAt !== startedAt) {
    problems.push(
      `effect ${effect.effectId}: firstTryAt is ${effect.firstTryAt}, but its last run's first try went at ${startedAt}`,
    );
  }
  return problems;
}

/**
 * lifeChain: one record's moves chain together under the retry rules. Sources: 02-contracts K-07 ("every state move
 * in the fixtures is allowed and no other"; the retry rules); arch 01 line 65; arch 02 line 125; arch 06 line 313;
 * arch 07 line 367; arch 10 lines 540, 542; arch 11 lines 576, 582. A provider event has no moves and always passes.
 */
export function lifeChain(record) {
  if (record.record === "outboxRow") return outboxLifeProblems(record);
  if (record.record === "effect") return effectLifeProblems(record);
  return [];
}

/** The named rules fixtures/index.json may name. */
export const rules = Object.freeze({ lifeChain });

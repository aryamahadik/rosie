// The keyword turn's commit (T-251; C-052's path through C-046): the guard's fixed replies (T-267, ../guard/replies)
// commit a turn's STOP, START and HELP through `ReplyCore.commitCore`, which their types say is "served by the Tool API
// (C-074) through the turn loop (T-251), beside each text's recordSafetyOutcome, which the turn loop adds" (K-09 README
// defaults 5, 10 and 35). `turnReplyCore` is that core: D-017 hands it to `setReplyDeps`, and while a turn runs its
// keyword texts through `replyToKeywords`, each commitCore call made under that turn's id goes to the turn's own commit
// (its one gateAndCommit, through the lease), never straight to the Tool API.
//
// A call for a turn id no turn is running answers `notInTurn` and writes nothing, so the replies record nothing and ask
// for the turn to run again (fails closed). Nothing here logs.

import type { CoreCommitAnswer, CoreCommitRequest, ReplyCore } from "../guard";

/** How one running turn commits its keyword texts' core actions. */
export interface KeywordCommitter {
  commit(request: CoreCommitRequest): Promise<CoreCommitAnswer>;
}

/** The turns running their keyword texts now, in this isolate, by turn id. */
const running = new Map<string, KeywordCommitter>();

/** The shared core the guard's replies reach, routed to the turn that runs them (set as `setReplyDeps`'s `core` at D-017). */
export const turnReplyCore: ReplyCore = {
  commitCore(request) {
    const committer = running.get(request.caller.turnId);
    if (committer === undefined) return Promise.resolve({ error: "notInTurn" });
    return committer.commit(request);
  },
};

/**
 * Runs `work` with the turn's committer in place for its turn id, and takes it away after, whatever `work` does. A run of
 * the same turn that started later (a lapsed turn's rerun) keeps its own committer: only this one's is taken away.
 */
export async function withKeywordCommit<T>(
  turnId: string,
  committer: KeywordCommitter,
  work: () => Promise<T>,
): Promise<T> {
  running.set(turnId, committer);
  try {
    return await work();
  } finally {
    if (running.get(turnId) === committer) running.delete(turnId);
  }
}

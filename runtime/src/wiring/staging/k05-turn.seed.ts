// The seed of ./k05-turn.worker.test.ts's database (T-1395; infra/test-rig/files.mjs, key K05_TURN): test owner 1 as
// db/seeds/skeleton.ts writes him for D-017's first text (T-1148): Lee's Barbershop's business head, Sam, his handle at
// tp-01's fictional number and the link between them, with no role, no open question, no booking and no phone row, so the
// guard's read finds a first text (K-05 v1.2 targets-first-text.json) and the frontier offers the sign-up door. The rig's
// globalSetup runs it once, in Node, after the migrations and bundle v0, with a client of the connecting login, which the
// skeleton seed uses as it is handed it (in one transaction as rosie_job, with no business scope). This module imports no
// package: the skeleton seed and what it loads are the repository's own files and Node's. Test values only (rule 9): the
// master's sample cast and the fiction range's number, as that seed holds them.
import type { Sql } from "../../../../db/repo/scope";
import { seedSkeleton } from "../../../../db/seeds/skeleton";

/** Seeds this file's database with test owner 1's rows (see the top of this file). */
export async function seed(sql: Sql): Promise<void> {
  await seedSkeleton(sql);
}

// The database the turn face's integration tests run on (T-315). Never imported by the Worker.
//
// One fresh schema per test file, migrated with every migration of db/migrations/ and dropped when the file ends (T-306's
// openCommitDatabase over db/repo/test-db.ts; the public schema is never touched), with three clients: the owner's, which
// loads the seeds; the runtime side's, as rosie_job, which the frontier's scope runs on (K-05 v1.2 item 26); and the
// Tool API's, as rosie_app.
//
// The stored state turn 1, Sam's first text, is read from (DL-346 ruling 3; ADR-013 sections 1 and 4):
//   1. build-frontier-s1-01.json's given seeds: K-04 seed-business-head.json, the business heads of Lee's Barbershop,
//      the yoga studio and the movers, loaded as the owner;
//   2. T-1148's seed for D-017 (db/seeds/skeleton.ts seedSkeleton, imported read-only and run as it is: one transaction
//      as rosie_job): test owner 1, Sam, his handle at tp-01's number and the link between them, with no role, no open
//      question, no booking and no phone row, so JOIN is a first text (K-05 v1.2 targets-first-text.json). It keeps the
//      business head step 1 wrote (the same row, value for value) and refuses, writing nothing, if JOIN would not be a
//      first text.
// So each business's call has its own business head, and only Lee's Barbershop's is turn 1's. Values come only from the
// contracts' fixtures and the master's sample cast (rule 9).

import { seedSkeleton, TEST_OWNER_1, type SkeletonSeedResult } from "../../../../../db/seeds/skeleton";
import { openCommitDatabase, seed, type CommitDatabase } from "../../../commit/pg/test-support";
import { s101Exchange } from "../test-support";

export const BARBERSHOP = TEST_OWNER_1.businessId;
export const YOGA = "biz-yoga-studio";
export const SAM_HANDLE = TEST_OWNER_1.handleId;
export const SAM = TEST_OWNER_1.personId;

/** The K-04 core seeds build-frontier-s1-01.json's `given` names, by their file names under core/fixtures/. */
export function givenSeeds(): string[] {
  return s101Exchange().given.seeds.map((file) => {
    if (!file.startsWith("core/")) throw new Error(`${file} is not a K-04 core seed`);
    return file.slice("core/".length);
  });
}

export interface TurnFaceDatabase {
  readonly cdb: CommitDatabase;
  /** What T-1148's seed reported: the role it ran as, and each table's rows written and kept. */
  readonly seeded: SkeletonSeedResult;
}

/**
 * This file's schema and clients (connections per client: `max`), with the fixture's given seeds and then T-1148's seed
 * loaded (see the top). The caller closes it.
 */
export async function openTurnFaceDatabase(max: number): Promise<TurnFaceDatabase> {
  const cdb = await openCommitDatabase("turn_face", max);
  try {
    await seed(cdb, givenSeeds());
    const seeded = await seedSkeleton(cdb.db.sql);
    return { cdb, seeded };
  } catch (error) {
    await cdb.close();
    throw error;
  }
}

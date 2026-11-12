-- T-1278: outbox_rows_job_idx (K-04 v1.1 core, frozen: contracts/db-schema/core, core.v1.1.tables.json; ADR-016
-- section 1 and section 7's card M1; DL-545). A repeat of work with no turn finds its rows by job id: a repeated sign-in
-- send for one attempt writes nothing and answers the first (ADR-016 section 1). Partial, so the rows a turn's commit
-- writes, which carry no job id, take no entry.
-- Expand only: one index on an existing table, built concurrently so writes go on while it is built. It is the file's
-- only statement: PostgreSQL refuses CREATE INDEX CONCURRENTLY inside a transaction, and the runner runs a file of only
-- such statements outside one (infra/scripts/migrate.mjs; the migration guard needs no marker for it, DL-061). IF NOT
-- EXISTS lets a rerun after a failed build skip it, once the runner has dropped the invalid index that build left.
-- It needs 0032's job_id, so it runs after 0032.
create index concurrently if not exists outbox_rows_job_idx on outbox_rows (job_id) where job_id is not null;

-- T-205: the kinds of work part (K-24 v1, frozen: contracts/db-schema/kinds-of-work, its table list and its README's
-- rules 1 to 7): the catalog of kinds of work (the 243 trade files and each kind drafted as new work) with each
-- trade-file kind's defaults per flow, the kinds an owner picked, each picked kind's 11 plug-in text blocks, and the
-- new-work drafts with their checklist answers (arch 09 line 461: 6 tables; MC R3, C5; FS line 746; S1-02, S1-03,
-- S1-04, S1-11, S1-74, S11-58).
-- Expand only: six new tables with their indexes; the version trigger (enforce_version_raise() from 0002, T-181) on all
-- six; grants to the two roles 0012 made (never created or altered here); row-level security switched on with 0012's
-- two policies on the four business-scoped tables. Nothing is dropped, renamed or retyped, and no row is written or
-- removed; no K-04 or K-23 table is altered. Not here: the catalog seed, one kinds row and two kind_flows rows per
-- trade file from the compiled bundle (C-155; README rule 7); the kind matcher's index, which waits for Q-42's spike
-- (C-130; README "The kinds"); the foreign key from K-23's company_kinds.kind_id to kinds.id, a K-23 v1.1 change
-- (README open gaps); the writes themselves (K-09's setup calls through the one commit) and the migration-side
-- contract test (QA's tests/contract/db-schema.kinds-of-work.v1.test.ts, T-101).
--
-- The six tables live beside K-04's and K-23's tables (rule 1), and their foreign keys name them by their keys
-- (persons.id, businesses.id, companies (id, business_id), company_kinds (company_id, kind_id)), with no schema prefix,
-- all on delete restrict. Nothing here refers to K-37: K-37's review item names new_work_drafts by name and id. Ids
-- are text (rule 4): kinds.id is the trade file's id or new- and an id code makes (kinds_new_work_id); the other ids
-- are opaque strings code makes and never parses (CQ-09). Arrays are text[] (rule 5): kinds.facts may be null, and
-- combos, switches_on and facts_on are not null. A plug-in text block is text checked with the SQL/JSON predicate
-- `is json` (rule 6; PostgreSQL 16 and later, and Q-21's local PostgreSQL is 17), never jsonb, so it keeps the trade
-- file's text byte for byte (K-01 pluginText: JSON.stringify of the value as parsed); no code reads a sub-key of it.
--
-- Versions (rule 3): every table here is updated, so each carries a version that every update raises by exactly one
-- (K-04 rule 2; the trigger refuses any other update, 23514), compared and set by a commit. The versioned tables with a
-- one-column key, which a commit can name in versions_read, are kinds, picked_kinds and new_work_drafts (id);
-- kind_flows (kind_id, flow), picked_kind_texts (picked_kind_id, pf_key) and new_work_draft_blocks (draft_id, block)
-- have two-column keys.
--
-- Picks and their business (README "Picks, text blocks and drafts"): S1-02 gives kinds and S1-11 loads their text
-- blocks before S1-04 gives companies and S1-09 the business, so a pick's company_id and business_id, and the
-- business_id of its text blocks, its draft and the draft's blocks, are null until S1-04 places the pick; code sets them
-- in the same commit. picked_kinds_id_business_key and new_work_drafts_id_business_key are the keys the composite
-- foreign keys name, so a text block's or draft's business_id, copied for row-level security, is always its pick's, and
-- a draft block's always its draft's (MATCH SIMPLE: with business_id null only the one-column key holds the row). A
-- placed pick is a K-23 company kind (picked_kinds_company_kind_fk) of a company whose business it carries
-- (picked_kinds_company_business_fk, on companies_id_business_key), one pick per company kind
-- (picked_kinds_one_per_company_kind, a partial unique index, as the table list's unique rule with its where), so each
-- business kind holds one set of text blocks. Rules across rows are kept by code: that a draft's pick is a new_work
-- pick; which facts a draft ends with, and its protective facts (README open gaps); which fact and switch names exist
-- (K-26's closed registry, arch 09 line 480; here names are only checked for form).
--
-- Row-level security (arch 10 line 546; K-04 v1 rule 4; README rule 2):
--   picked_kinds, picked_kind_texts, new_work_drafts, new_work_draft_blocks: scoped by business, on business_id, with
--     0012's two policies: <table>_tool_api lets rosie_app see and write only rows whose business_id equals its scope
--     (the setting rosie.business_id), and none with no scope; <table>_runtime lets rosie_job see every row with no
--     scope, else only its scope's. A row whose business is null is seen by no business scope: sign-up's turns read and
--     write it on the runtime side (K-23 rule 5).
--   kinds, kind_flows: the shared catalog every business picks from (scope none), so row-level security stays off, as
--     on K-04's tables that span businesses; what keeps the Tool API from writing it is privilege (README rule 2:
--     refused 42501). None is forced: the tables' owner (the migrations' role) is not bound.
--
-- Grants (DL-149: each to a named reader). No DELETE (no row here is removed by any named call), TRUNCATE, REFERENCES
-- or TRIGGER, and nothing to PUBLIC. Neither role owns a table.
--   rosie_job, the runtime side:
--     kinds, kind_flows: SELECT, INSERT, UPDATE. README rule 2 ("the catalog seed job and the runtime side (S1-03's
--       drafted kinds) write them"): S1-03's drafted kind gets its row in its turn's one commit (K-05 commitTurn per
--       write, whose state writes admit every domain table), and K-24's refused fixture refuse-main-path-not-listed
--       names the runtime side updating a flow, refused by its CHECK (23514), never by privilege; the catalog seed
--       (C-155, rule 7) writes one kinds row and two kind_flows rows per trade file; readTurnState (item 26) and a
--       commit's compare (FOR SHARE or FOR UPDATE, which take UPDATE as well as SELECT) read them.
--     picked_kinds, picked_kind_texts, new_work_drafts, new_work_draft_blocks: SELECT, INSERT, UPDATE. K-05
--       commitTurn per write (item 1) writes K-09 saveSetupStep's step writes inside gateAndCommit in a turn (the
--       tool-api README's journey 1 table: SetupS1_02 writes picked_kinds, SetupS1_03 new_work_drafts and
--       new_work_draft_blocks, SetupS1_11 picked_kind_texts; S1-04 places each pick and sets the business on its blocks
--       and draft in the same commit; S11-58's NEW), before the business exists included; readTurnState with no
--       business (item 26) reads them; K-09 decideReviewItem from the team console (K-21: the runtime side) writes
--       new_work_drafts.state approved or kept_offline (the tool-api README, S1-03's row; README "Who owns what").
--   rosie_app, the Tool API, under one business's scope:
--     kinds, kind_flows: SELECT only. README rule 2 ("the Tool API roles may select them and never insert, update or
--       delete", refused 42501): K-09 matchKinds matches the owner's words to the closest of the 243 kinds (S1-02;
--       C-130, which reads the catalog as data, Q-42), and the catalog and pricing calls (C-096) and registration screen
--       3's kinds of work with the money paths shown per flow (C-187, through K-21) read it.
--     picked_kinds, picked_kind_texts, new_work_drafts, new_work_draft_blocks: SELECT, INSERT, UPDATE, behind the
--       business policies: K-09 saveSetupStep made alone, a page's or the console's call under its business (SetupS1_02,
--       SetupS1_03 and SetupS1_11 write these rows; K-24's freeze record names the owner commands, S11-58's NEW among
--       them) and K-09 readSetup (each key given or missing); K-05 readTurnState (item 26) and the planner's context
--       (C-114: the business's plug-in text blocks) read them; and K-24's refused fixtures name the Tool API side
--       inserting a text block, a pick and a draft block, each refused by its own rule (23514, 23503), never by
--       privilege, and reading another business's text blocks (0 rows).

-- The catalog (row K-24; FS row B09, section 3; SPEC-prof 3; MC R3, C5): the 243 trade files, one row each, and each
-- kind drafted as new work for one owner (S1-03), which gets its row when drafted so the business's kinds can name it
-- at once. The kind matcher reads the trade-file rows as data (Q-42: no model or index is chosen here).
create table kinds (
  id text primary key,
  name text not null,
  style text,
  pattern text not null,
  facts text[],
  source text not null,
  version integer not null default 1,
  constraint kinds_id_form check (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint kinds_new_work_id check ((source = 'new_work') = (id like 'new-%')),
  constraint kinds_source_known check (source in ('trade_file', 'new_work')),
  constraint kinds_pattern_known check (
    pattern in ('fix', 'urgent', 'project', 'service', 'dropoff', 'chair', 'clinic', 'class', 'event', 'consult', 'table')
  ),
  constraint kinds_name_given check (length(btrim(name)) > 0),
  constraint kinds_trade_file_has_style check (source = 'new_work' or style is not null),
  constraint kinds_drafted_facts_on_draft check (source = 'trade_file' or facts is null),
  constraint kinds_facts_form check (facts is null or array_to_string(facts, ',') ~ '^([a-z0-9]+(,[a-z0-9]+)*)?$')
);

create trigger kinds_version_raised
  before update on kinds
  for each row execute function enforce_version_raise();

-- A trade-file kind's defaults in one flow (A: the customer comes to the business; B: the business goes to the
-- customer), as the compiled bundle has them (K-01 tradeFlow): the main money path and the paths it uses, the plug-in
-- switches on, and the sign-up settings with MC C5's start values (no pf.settings: window, and an empty cutoff, null).
create table kind_flows (
  kind_id text not null,
  flow text not null,
  main_combo text not null,
  combos text[] not null,
  switches_on text[] not null default '{}',
  arrive text not null,
  arrive_window_hours integer,
  cutoff text,
  version integer not null default 1,
  primary key (kind_id, flow),
  constraint kind_flows_kind_fk foreign key (kind_id) references kinds (id) on delete restrict,
  constraint kind_flows_flow_known check (flow in ('A', 'B')),
  constraint kind_flows_combos_form check (
    array_to_string(combos, ',') ~ '^(list|photos|visit)\|(none|card|deposit|full)\|(none|counter|bill|card|own)(,(list|photos|visit)\|(none|card|deposit|full)\|(none|counter|bill|card|own))*$'
  ),
  constraint kind_flows_main_listed check (main_combo = any(combos)),
  constraint kind_flows_after_by_flow check (
    (flow = 'A' and array_to_string(combos, ',') !~ '\|own') or (flow = 'B' and array_to_string(combos, ',') !~ '\|counter')
  ),
  constraint kind_flows_switches_form check (array_to_string(switches_on, ',') ~ '^([a-z0-9]+(,[a-z0-9]+)*)?$'),
  constraint kind_flows_arrive_known check (arrive in ('setstart', 'window')),
  constraint kind_flows_window_hours check (
    arrive_window_hours is null or (arrive = 'window' and arrive_window_hours >= 1)
  ),
  constraint kind_flows_cutoff_given check (cutoff is null or length(btrim(cutoff)) > 0)
);

create trigger kind_flows_version_raised
  before update on kind_flows
  for each row execute function enforce_version_raise();

-- The kinds of work an owner named (S1-02 gives kinds; S11-58's NEW), in the order named, with the owner's own words
-- and what each became: a listed kind, a kind drafted as new work (S1-03), or work Rosie does not book (S1-74), kept so
-- Rosie's team sees it. Once S1-04 places it, the pick is its company's kind (K-23 company_kinds).
create table picked_kinds (
  id text primary key,
  owner_person_id text not null,
  position integer not null,
  words text not null,
  outcome text not null,
  kind_id text,
  company_id text,
  business_id text,
  picked_at timestamptz not null,
  version integer not null default 1,
  constraint picked_kinds_owner_fk foreign key (owner_person_id) references persons (id) on delete restrict,
  constraint picked_kinds_kind_fk foreign key (kind_id) references kinds (id) on delete restrict,
  constraint picked_kinds_company_kind_fk foreign key (company_id, kind_id)
    references company_kinds (company_id, kind_id) on delete restrict,
  constraint picked_kinds_company_business_fk foreign key (company_id, business_id)
    references companies (id, business_id) on delete restrict,
  constraint picked_kinds_business_fk foreign key (business_id) references businesses (id) on delete restrict,
  constraint picked_kinds_id_business_key unique (id, business_id),
  constraint picked_kinds_outcome_known check (outcome in ('listed', 'new_work', 'not_booked')),
  constraint picked_kinds_kind_unless_not_booked check ((outcome = 'not_booked') = (kind_id is null)),
  constraint picked_kinds_outcome_matches_kind check (
    kind_id is null or (outcome = 'new_work') = (kind_id like 'new-%')
  ),
  constraint picked_kinds_not_booked_unplaced check (outcome <> 'not_booked' or company_id is null),
  constraint picked_kinds_position_positive check (position >= 1),
  constraint picked_kinds_words_given check (length(btrim(words)) > 0)
);

-- One pick, so one set of text blocks, per company kind (S1-04; K-23 company_kinds' primary key): a partial unique
-- index, as the table list's unique rule with its where.
create unique index picked_kinds_one_per_company_kind on picked_kinds (company_id, kind_id)
  where company_id is not null;
-- An owner's kinds during sign-up, before any company or business exists (S1-02, S1-11, S1-04), in the order named.
create index picked_kinds_owner_idx on picked_kinds (owner_person_id, picked_at);
-- A business's kinds of work with their text blocks (the planner's context; S11-58).
create index picked_kinds_business_idx on picked_kinds (business_id);

create trigger picked_kinds_version_raised
  before update on picked_kinds
  for each row execute function enforce_version_raise();

-- Each business kind's plug-in text blocks (S1-11 gives pf.license to pf.edges): the 11 free-text pf keys, one row
-- each, stored whole as JSON text for the AI (MC R3; Q-39; FS line 746's business extras, held per pick). The typed
-- keys (pf.facts, pf.switches, pf.settings) never come here (picked_kind_texts_key_known).
create table picked_kind_texts (
  picked_kind_id text not null,
  pf_key text not null,
  business_id text,
  block text not null,
  version integer not null default 1,
  primary key (picked_kind_id, pf_key),
  constraint picked_kind_texts_pick_fk foreign key (picked_kind_id) references picked_kinds (id) on delete restrict,
  constraint picked_kind_texts_pick_business_fk foreign key (picked_kind_id, business_id)
    references picked_kinds (id, business_id) on delete restrict,
  constraint picked_kind_texts_key_known check (
    pf_key in (
      'pf.license', 'pf.services', 'pf.questions', 'pf.safety', 'pf.first_steps', 'pf.visit', 'pf.money', 'pf.messages',
      'pf.staff', 'pf.rules', 'pf.edges'
    )
  ),
  constraint picked_kind_texts_block_is_json check (block is json)
);

-- A business's plug-in text blocks for the planner's context (C-114).
create index picked_kind_texts_business_idx on picked_kind_texts (business_id);

create trigger picked_kind_texts_version_raised
  before update on picked_kind_texts
  for each row execute function enforce_version_raise();

-- A plug-in drafted for new work (S1-03), one per new_work pick: drafting, in review, approved or kept offline, and
-- offline until approved. The review itself is K-37's review_items row of kind new_work whose subject is this row.
create table new_work_drafts (
  id text primary key,
  picked_kind_id text not null,
  business_id text,
  state text not null default 'drafting',
  drafted_at timestamptz not null,
  version integer not null default 1,
  constraint new_work_drafts_pick_fk foreign key (picked_kind_id) references picked_kinds (id) on delete restrict,
  constraint new_work_drafts_pick_business_fk foreign key (picked_kind_id, business_id)
    references picked_kinds (id, business_id) on delete restrict,
  constraint new_work_drafts_one_per_pick unique (picked_kind_id),
  constraint new_work_drafts_id_business_key unique (id, business_id),
  constraint new_work_drafts_state_known check (state in ('drafting', 'in_review', 'approved', 'kept_offline'))
);

-- A business's drafts and whether a kind is still offline (S1-35 go-live, S11-58).
create index new_work_drafts_business_idx on new_work_drafts (business_id) where business_id is not null;

create trigger new_work_drafts_version_raised
  before update on new_work_drafts
  for each row execute function enforce_version_raise();

-- The owner's answer to one block of S1-03's checklist of 15, or a clear no, with the facts and switches it set. A
-- block with no row is still at its safe default; a no skips the block and sets nothing.
create table new_work_draft_blocks (
  draft_id text not null,
  block integer not null,
  business_id text,
  outcome text not null,
  answer text not null,
  facts_on text[] not null default '{}',
  switches_on text[] not null default '{}',
  answered_at timestamptz not null,
  version integer not null default 1,
  primary key (draft_id, block),
  constraint new_work_draft_blocks_draft_fk foreign key (draft_id) references new_work_drafts (id) on delete restrict,
  constraint new_work_draft_blocks_draft_business_fk foreign key (draft_id, business_id)
    references new_work_drafts (id, business_id) on delete restrict,
  constraint new_work_draft_blocks_block_range check (block between 1 and 15),
  constraint new_work_draft_blocks_outcome_known check (outcome in ('answered', 'no')),
  constraint new_work_draft_blocks_no_sets_nothing check (
    outcome <> 'no' or (cardinality(facts_on) = 0 and cardinality(switches_on) = 0)
  ),
  constraint new_work_draft_blocks_answer_given check (length(btrim(answer)) > 0),
  constraint new_work_draft_blocks_names_form check (
    array_to_string(facts_on || switches_on, ',') ~ '^([a-z0-9]+(,[a-z0-9]+)*)?$'
  )
);

create trigger new_work_draft_blocks_version_raised
  before update on new_work_draft_blocks
  for each row execute function enforce_version_raise();

-- Grants (the readers each serves are named in this file's header).
-- The catalog (scope none): the runtime side writes it; the Tool API only reads it (README rule 2).
grant select, insert, update on kinds, kind_flows to rosie_job;
grant select on kinds, kind_flows to rosie_app;
-- Business-scoped, versioned: both roles, behind the policies below.
grant select, insert, update on picked_kinds, picked_kind_texts, new_work_drafts, new_work_draft_blocks
to rosie_app, rosie_job;

-- Row-level security on the four business-scoped tables: rosie_app sees only its scope; rosie_job sees everything with
-- no scope, else only its scope.
alter table picked_kinds enable row level security;
create policy picked_kinds_tool_api on picked_kinds for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy picked_kinds_runtime on picked_kinds for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table picked_kind_texts enable row level security;
create policy picked_kind_texts_tool_api on picked_kind_texts for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy picked_kind_texts_runtime on picked_kind_texts for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table new_work_drafts enable row level security;
create policy new_work_drafts_tool_api on new_work_drafts for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy new_work_drafts_runtime on new_work_drafts for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

alter table new_work_draft_blocks enable row level security;
create policy new_work_draft_blocks_tool_api on new_work_draft_blocks for all to rosie_app
  using (business_id = nullif(current_setting('rosie.business_id', true), ''))
  with check (business_id = nullif(current_setting('rosie.business_id', true), ''));
create policy new_work_draft_blocks_runtime on new_work_draft_blocks for all to rosie_job
  using (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  )
  with check (
    nullif(current_setting('rosie.business_id', true), '') is null
    or business_id = nullif(current_setting('rosie.business_id', true), '')
  );

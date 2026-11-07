# test-sample: not a contract

The sample the contract tools are proven on (T-006). Nothing builds against it and it is never frozen; it gets no generated types.

- `test-sample.v1.schema.json`: a made-up price quote that refers to the shared formats in `common/`.
- `fixtures/`: one fixture the schema must accept and one it must refuse (a price written with a decimal), listed in `fixtures/index.json`.
- `test-sample.v1.tables.json`: a made-up table list that uses every entry of `db-schema/tables.meta.schema.json`: columns, keys, EXCLUDE and CHECK constraints, indexes, row-level security scope, version and effective-date flags, a sealed field and field audiences.

`npm run contracts:check` checks it with everything else, and `scripts/contract-tools.test.mjs` uses copies of it to show that the check fails when the refused fixture is accepted, and that the frozen-contract guard fails an edit to it once its v1 is frozen.

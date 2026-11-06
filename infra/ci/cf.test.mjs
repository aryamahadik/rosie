// Tests for infra/scripts/cf.sh (factory spec 2 and 6; DL-024), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. Each case runs a copy of cf.sh and lib.sh in a throwaway checkout whose
// node_modules/.bin/wrangler is a fake that only records its arguments; another fake wrangler is first on PATH,
// so a call that went to PATH would show. HOME is a temp folder, so nothing reads this Mac's Rosfield sign-in
// (script-harness.mjs). A refused case must exit non-zero with a reason on stderr and never start wrangler.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  REPO,
  ROSFIELD_ACCOUNT_ID,
  cleanEnv,
  copyScript,
  fakeTools,
  readLog,
  tempDir,
  write,
} from "./script-harness.mjs";

const WRANGLER_JSONC = readFileSync(path.join(REPO, "wrangler.jsonc"), "utf8");
const OTHER_ACCOUNT = "0123456789abcdef0123456789abcdef";

/** wrangler.jsonc with one text replaced (the replaced text must be there). */
function configWith(from, to) {
  assert.ok(WRANGLER_JSONC.includes(from), `wrangler.jsonc no longer contains ${from}`);
  return WRANGLER_JSONC.replace(from, to);
}

/** A throwaway checkout: cf.sh, lib.sh, a wrangler.jsonc (the repository's unless given) and extra files. */
function checkout(t, { config = WRANGLER_JSONC, files = {} } = {}) {
  const dir = tempDir(t, "cf");
  const root = path.join(dir, "rosie");
  const cf = copyScript("cf.sh", root);
  copyScript("lib.sh", root);
  write(path.join(root, "wrangler.jsonc"), config);
  for (const [name, content] of Object.entries(files)) write(path.join(root, name), content);
  const fake = fakeTools(dir);
  fake(path.join(root, "node_modules", ".bin", "wrangler"), "wrangler");
  fake(path.join(dir, "bin", "wrangler"), "wrangler-on-path");
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const log = path.join(dir, "calls.ndjson");
  const run = (args, env = {}) =>
    spawnSync("bash", [cf, ...args], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv(home, { PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, FAKE_LOG: log, ...env }),
    });
  return { dir, root, home, run, calls: () => readLog(log) };
}

const STAGING = ["--env", "staging"];
const UUID = "0d3b0f6e-8c1a-4a63-9b2e-3c4d5e6f7a8b";

// [title, wrangler arguments, extra environment, checkout options]
const REFUSED = [
  // Another Worker name: --name in every form (wrangler deploy, versions, rollback, secret, deployments).
  ["deploy --name <worker>", ["deploy", ...STAGING, "--name", "rosie"]],
  ["deploy --name=<worker>", ["deploy", ...STAGING, "--name=rosie"]],
  ["versions upload --name <worker>", ["versions", "upload", ...STAGING, "--name", "rosie"]],
  ["versions deploy --name=<worker>", ["versions", "deploy", ...STAGING, "--name=rosie"]],
  ["rollback --name <worker>", ["rollback", UUID, ...STAGING, "--name", "rosie"]],
  ["secret put --name <worker>", ["secret", "put", "KEY", ...STAGING, "--name", "rosie"]],
  ["a read-only command with --name", ["deployments", "status", "--name", "rosie"]],
  ["--name after --", ["deploy", ...STAGING, "--", "--name", "rosie"]],
  ["--no-name", ["deploy", ...STAGING, "--no-name"]],
  ["preview --worker-name <worker>", ["preview", ...STAGING, "--worker-name", "rosie"]],
  ["preview --workerName=<worker> (camel case)", ["preview", ...STAGING, "--workerName=rosie"]],

  // Another config file or folder: --config / -c in every form, --cwd, the experimental TypeScript config.
  ["--config <file>", ["deploy", ...STAGING, "--config", "other.jsonc"]],
  ["--config=<file>", ["deploy", ...STAGING, "--config=other.jsonc"]],
  ["-c <file>", ["deploy", ...STAGING, "-c", "other.jsonc"]],
  ["-c=<file>", ["deploy", ...STAGING, "-c=other.jsonc"]],
  ["-c<file>", ["deploy", ...STAGING, "-cother.jsonc"]],
  ["-c./<file>", ["versions", "upload", ...STAGING, "-c./other.jsonc"]],
  ["-c inside combined short options", ["deploy", ...STAGING, "-yc", "other.jsonc"]],
  ["--config before the command", ["--config", "other.jsonc", "deploy", ...STAGING]],
  ["--cwd <folder>", ["deploy", ...STAGING, "--cwd", "/tmp"]],
  ["--cwd=<folder>", ["deploy", ...STAGING, "--cwd=/tmp"]],
  ["--experimental-new-config", ["deploy", ...STAGING, "--experimental-new-config"]],
  ["--x-new-config", ["deploy", ...STAGING, "--x-new-config"]],
  ["--xNewConfig (camel case)", ["deploy", ...STAGING, "--xNewConfig"]],

  // A variables file wrangler would load into its own environment (it can set WRANGLER_CI_OVERRIDE_NAME).
  ["--env-file <file>", ["deploy", ...STAGING, "--env-file", "override.env"]],
  ["--env-file=<file>", ["deploy", ...STAGING, "--env-file=override.env"]],
  ["--envFile <file> (camel case)", ["deploy", ...STAGING, "--envFile", "override.env"]],

  // Routes and custom domains only come from wrangler.jsonc (staging must not take a production hostname).
  ["--route <pattern>", ["deploy", ...STAGING, "--route", "rosfield.com/*"]],
  ["--routes=<pattern>", ["deploy", ...STAGING, "--routes=rosfield.com/*"]],
  ["--domain <host>", ["deploy", ...STAGING, "--domain", "rosfield.com"]],
  ["--domains=<host>", ["deploy", ...STAGING, "--domains=rosfield.com"]],

  // Any environment other than staging, in every spelling, and --env twice or without a value.
  ["--env production", ["deploy", "--env", "production"]],
  ["--env=production", ["deploy", "--env=production"]],
  ["-e production", ["deploy", "-e", "production"]],
  ["-e=production", ["deploy", "-e=production"]],
  ['--env "" (the top level, production)', ["deploy", "--env", ""]],
  ["--env= (the top level, production)", ["deploy", "--env="]],
  ["--env <another environment>", ["versions", "upload", "--env", "preview"]],
  ["a read-only command with --env production", ["tail", "--env", "production"]],
  ["--env twice", ["deploy", ...STAGING, "--env", "production"]],
  ["--env without a value", ["deploy", "--env"]],
  ["-e inside combined short options", ["deploy", "-ye", "production"]],

  // delete, in any command.
  ["delete", ["delete"]],
  ["delete --env staging", ["delete", ...STAGING]],
  ["a resource delete", ["kv", "namespace", "delete", "--namespace-id", "abc", ...STAGING]],

  // A command that changes a Worker, without --env staging.
  ["deploy", ["deploy"]],
  ["versions upload", ["versions", "upload", "--preview-alias", "p"]],
  ["versions deploy", ["versions", "deploy", `${UUID}@100`]],
  ["rollback", ["rollback", UUID, "--message", "back", "--yes"]],
  ["secret put", ["secret", "put", "KEY"]],
  ["secret list", ["secret", "list"]],
  ["versions secret put", ["versions", "secret", "put", "KEY"]],
  ["triggers deploy", ["triggers", "deploy"]],
  ["preview", ["preview"]],
  ["CLOUDFLARE_ENV=staging is not --env staging", ["deploy"], { CLOUDFLARE_ENV: "staging" }],

  // Variables: Wrangler's Worker-name override (even empty), another environment, another account.
  ["WRANGLER_CI_OVERRIDE_NAME set", ["deploy", ...STAGING], { WRANGLER_CI_OVERRIDE_NAME: "rosie" }],
  ["WRANGLER_CI_OVERRIDE_NAME set but empty", ["deploy", ...STAGING], { WRANGLER_CI_OVERRIDE_NAME: "" }],
  ["WRANGLER_CI_OVERRIDE_NAME with any command", ["whoami"], { WRANGLER_CI_OVERRIDE_NAME: "rosie" }],
  ["any other WRANGLER_*_NAME override", ["deploy", ...STAGING], { WRANGLER_CI_FUTURE_NAME: "rosie" }],
  ["CLOUDFLARE_ENV=production", ["deployments", "status"], { CLOUDFLARE_ENV: "production" }],
  ["CLOUDFLARE_ACCOUNT_ID of another account", ["whoami"], { CLOUDFLARE_ACCOUNT_ID: OTHER_ACCOUNT }],

  // The .env files wrangler loads into its own environment from the folder it runs in.
  [".env", ["deploy", ...STAGING], {}, { files: { ".env": "WRANGLER_CI_OVERRIDE_NAME=rosie\n" } }],
  [".env.local", ["whoami"], {}, { files: { ".env.local": "WRANGLER_CI_OVERRIDE_NAME=rosie\n" } }],
  [
    ".env.staging",
    ["deploy", ...STAGING],
    {},
    { files: { ".env.staging": "WRANGLER_CI_OVERRIDE_NAME=rosie\n" } },
  ],
  [
    ".env.staging.local",
    ["deploy", ...STAGING],
    {},
    { files: { ".env.staging.local": "WRANGLER_CI_OVERRIDE_NAME=rosie\n" } },
  ],

  // The effective config: env.staging.name must be rosie-staging and every account_id the Rosfield account.
  [
    "env.staging.name is the production Worker",
    ["deploy", ...STAGING],
    {},
    { config: configWith('"name": "rosie-staging"', '"name": "rosie"') },
  ],
  [
    "env.staging.name is missing",
    ["deploy", ...STAGING],
    {},
    { config: configWith('"name": "rosie-staging",', "") },
  ],
  [
    "env.staging.name has a trailing space",
    ["deploy", ...STAGING],
    {},
    { config: configWith('"name": "rosie-staging"', '"name": "rosie-staging "') },
  ],
  [
    "a comment that names rosie-staging does not count",
    ["deploy", ...STAGING],
    {},
    { config: configWith('"name": "rosie-staging"', '// "name": "rosie-staging"\n      "name": "rosie"') },
  ],
  [
    "env.staging is missing",
    ["deploy", ...STAGING],
    {},
    { config: configWith('"staging": {', '"other": {') },
  ],
  [
    "the top-level account_id is another account",
    ["deploy", ...STAGING],
    {},
    { config: configWith(`"account_id": "${ROSFIELD_ACCOUNT_ID}"`, `"account_id": "${OTHER_ACCOUNT}"`) },
  ],
  [
    "env.staging overrides account_id",
    ["deploy", ...STAGING],
    {},
    {
      config: configWith(
        '"name": "rosie-staging",',
        `"name": "rosie-staging",\n      "account_id": "${OTHER_ACCOUNT}",`,
      ),
    },
  ],
  [
    "a block comment that names the account does not count",
    ["whoami"],
    {},
    {
      config: configWith(
        `"account_id": "${ROSFIELD_ACCOUNT_ID}"`,
        `/* "account_id": "${ROSFIELD_ACCOUNT_ID}" */ "account_id": "${OTHER_ACCOUNT}"`,
      ),
    },
  ],
  ["wrangler.jsonc that does not parse", ["deploy", ...STAGING], {}, { config: '{ "name": "rosie", ' }],
];

// [title, wrangler arguments, extra environment]: run as given, after --config <checkout>/wrangler.jsonc.
const ALLOWED = [
  ["deploy-staging.sh's deploy", ["deploy", ...STAGING, "--var", "GIT_SHA:abc123"]],
  [
    "deploy-preview.sh's upload",
    ["versions", "upload", ...STAGING, "--preview-alias", "task-t-1", "--var", "DB_SCHEMA:preview_task_t_1"],
  ],
  ["deployments status", ["deployments", "status", ...STAGING, "--json"]],
  ["deployments list", ["deployments", "list", ...STAGING, "--json"]],
  ["versions view", ["versions", "view", UUID, ...STAGING, "--json"]],
  [
    "rollback-staging.sh's rollback, with a message",
    ["rollback", UUID, ...STAGING, "--message", "staging deploy of abc123 failed", "--yes"],
  ],
  ["secret list --env staging", ["secret", "list", ...STAGING]],
  ["-e staging before the command", ["-e", "staging", "deploy"]],
  ["--env=staging", ["--env=staging", "versions", "deploy", `${UUID}@100`]],
  ["-e=staging", ["versions", "upload", "-e=staging"]],
  ["whoami", ["whoami"]],
  ["tail of staging", ["tail", ...STAGING]],
  ["CLOUDFLARE_ENV=staging with --env staging", ["deploy", ...STAGING], { CLOUDFLARE_ENV: "staging" }],
  [
    "CLOUDFLARE_ACCOUNT_ID of the Rosfield account",
    ["whoami"],
    { CLOUDFLARE_ACCOUNT_ID: ROSFIELD_ACCOUNT_ID },
  ],
];

describe("cf.sh refuses, before wrangler starts", () => {
  for (const [title, args, env = {}, options = {}] of REFUSED) {
    it(title, (t) => {
      const repo = checkout(t, options);
      const result = repo.run(args, env);
      assert.notEqual(
        result.status,
        0,
        `expected a refusal; stdout=${result.stdout} stderr=${result.stderr}`,
      );
      assert.match(result.stderr, /cf\.sh: \S/, "expected the reason on stderr");
      assert.deepEqual(repo.calls(), [], "wrangler must not start");
    });
  }
});

describe("cf.sh runs this checkout's wrangler with the Rosfield sign-in and the checked config", () => {
  for (const [title, args, env = {}] of ALLOWED) {
    it(title, (t) => {
      const repo = checkout(t);
      const result = repo.run(args, env);
      assert.equal(result.status, 0, `stderr=${result.stderr}`);
      assert.deepEqual(repo.calls(), [
        {
          tool: "wrangler",
          args: ["--config", path.join(repo.root, "wrangler.jsonc"), ...args],
          cwd: repo.root,
          env: {
            XDG_CONFIG_HOME: path.join(repo.home, ".config", "rosfield"),
            CLOUDFLARE_ACCOUNT_ID: ROSFIELD_ACCOUNT_ID,
          },
        },
      ]);
    });
  }

  it("uses the Rosfield sign-in when CI is set too (DL-024: no CI token path)", (t) => {
    const repo = checkout(t);
    const result = repo.run(["whoami"], { CI: "true" });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(repo.calls()[0]?.env.XDG_CONFIG_HOME, path.join(repo.home, ".config", "rosfield"));
  });

  it("accepts files that wrangler does not load, such as .env.example", (t) => {
    const repo = checkout(t, { files: { ".env.example": "# names only\n" } });
    const result = repo.run(["deploy", ...STAGING]);
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.equal(repo.calls().length, 1);
  });
});

describe("cf.sh with CF_BUILD_DIR (deploy-preview.sh: a branch's worktree)", () => {
  function withTree(t, treeOptions = {}) {
    const repo = checkout(t);
    const tree = path.join(repo.dir, "tree");
    write(path.join(tree, "wrangler.jsonc"), treeOptions.config ?? WRANGLER_JSONC);
    for (const [name, content] of Object.entries(treeOptions.files ?? {}))
      write(path.join(tree, name), content);
    fakeTools(path.join(repo.dir, "tree-fake"))(
      path.join(tree, "node_modules", ".bin", "wrangler"),
      "tree-wrangler",
    );
    return { repo, tree };
  }
  const UPLOAD = ["versions", "upload", ...STAGING, "--preview-alias", "task-t-1"];

  it("uploads from the tree with this checkout's wrangler and the tree's checked wrangler.jsonc", (t) => {
    const { repo, tree } = withTree(t);
    const result = repo.run(UPLOAD, { CF_BUILD_DIR: tree });
    assert.equal(result.status, 0, `stderr=${result.stderr}`);
    assert.deepEqual(repo.calls(), [
      {
        tool: "wrangler",
        args: ["--config", path.join(tree, "wrangler.jsonc"), ...UPLOAD],
        cwd: tree,
        env: {
          XDG_CONFIG_HOME: path.join(repo.home, ".config", "rosfield"),
          CLOUDFLARE_ACCOUNT_ID: ROSFIELD_ACCOUNT_ID,
        },
      },
    ]);
  });

  const refusals = [
    [
      "the tree's env.staging.name is the production Worker",
      UPLOAD,
      { config: configWith('"name": "rosie-staging"', '"name": "rosie"') },
    ],
    [
      "the tree has a .env.staging",
      UPLOAD,
      { files: { ".env.staging": "WRANGLER_CI_OVERRIDE_NAME=rosie\n" } },
    ],
    ["a deploy (CF_BUILD_DIR is only for versions upload)", ["deploy", ...STAGING], {}],
    ["a rollback (CF_BUILD_DIR is only for versions upload)", ["rollback", UUID, ...STAGING], {}],
  ];
  for (const [title, args, treeOptions] of refusals) {
    it(`refuses: ${title}`, (t) => {
      const { repo, tree } = withTree(t, treeOptions);
      const result = repo.run(args, { CF_BUILD_DIR: tree });
      assert.notEqual(result.status, 0, `expected a refusal; stderr=${result.stderr}`);
      assert.match(result.stderr, /cf\.sh: \S/);
      assert.deepEqual(repo.calls(), [], "wrangler must not start");
    });
  }

  it("refuses a CF_BUILD_DIR that is not a folder", (t) => {
    const repo = checkout(t);
    const result = repo.run(UPLOAD, { CF_BUILD_DIR: path.join(repo.dir, "missing") });
    assert.notEqual(result.status, 0);
    assert.deepEqual(repo.calls(), []);
  });
});

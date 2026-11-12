// Tests for infra/scripts/cf.sh (factory spec 2 and 6; DL-024), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. Each case runs a copy of cf.sh and lib.sh in a throwaway checkout whose
// node_modules/.bin/wrangler is a fake that only records its arguments; another fake wrangler is first on PATH,
// so a call that went to PATH would show. HOME is a temp folder, so nothing reads this Mac's Rosfield sign-in
// (script-harness.mjs). A refused case must exit non-zero with a reason on stderr and never start wrangler.
// The last block (T-1261) runs cf.sh under the caller set-ups of T-1236's tests (its working names exported, allexport,
// keyword, POSIX mode, tracing) with recorders in front of wrangler and node.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  REPO,
  ROSFIELD_ACCOUNT_ID,
  SCRIPTS,
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

describe("cf.sh hands no variable of its own on to what it starts, whatever the caller's shell asked for (T-1261)", () => {
  // The names cf.sh keeps a variable of its own under, and lib.sh's two it gets by sourcing lib.sh (the checkout's
  // folder and cf.sh's own path): paths, the arguments and their words, counts, and the fixed texts in capitals.
  const OWN_NAMES = [
    "CF",
    "ROOT",
    "ROSFIELD_ACCOUNT_ID",
    "STAGING_WORKER",
    "arg",
    "changes_worker",
    "command_words",
    "config",
    "dir",
    "ended",
    "env_count",
    "env_name",
    "expect",
    "file",
    "key",
    "variable",
    "why",
    "word",
    "words",
    "wrangler",
  ];
  // Made-up texts, none a key of anything: the caller's text under each of those names, a value on its way to a
  // secret put on standard input, and the commit of a deploy's --var.
  const CALLER_TEXT = "t1261 made-up caller text";
  const CALLER = Object.fromEntries(OWN_NAMES.map((name) => [name, `${CALLER_TEXT}, ${name}`]));
  const VALUE = `t1261-made-up-value-${"5c0e93a7".repeat(4)}`;
  const SHA = "t1261madeupcommit0a1b2c3";
  const WATCHED = [CALLER_TEXT, VALUE, SHA];
  const PUT = ["secret", "put", "T1261_MADE_UP_NAME", ...STAGING];
  const DEPLOY = ["deploy", ...STAGING, "--var", `GIT_SHA:${SHA}`];

  const code = (file) =>
    readFileSync(path.join(SCRIPTS, file), "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line) && line.trim() !== "");

  /**
   * The same names, read from the two files: every name, in small letters or capitals, that cf.sh assigns, adds to,
   * loops over or declares local, and every name lib.sh assigns outside its functions (at the start of a line).
   */
  function ownNames() {
    const text = code("cf.sh").join("\n");
    const names = new Set();
    // name=... or name+=..., first on its line or after ;, &&, ||, a case pattern's ) or a !.
    for (const [, name] of text.matchAll(/(?:^|;|&&|\|\||\)|!)[ \t]*([A-Za-z_][A-Za-z0-9_]*)\+?=/gm)) {
      names.add(name);
    }
    // for name in ...
    for (const [, name] of text.matchAll(/\bfor[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+in\b/g)) names.add(name);
    // local name="..." other: each word of the declaration, up to its =.
    for (const [, words] of text.matchAll(/^[ \t]*local[ \t]+(.+)$/gm)) {
      for (const word of words.split(/[ \t]+/)) names.add(word.replace(/=.*$/, ""));
    }
    for (const line of code("lib.sh")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      if (match) names.add(match[1]);
    }
    return [...names].sort();
  }

  // What both recorders start with (CommonJS): the names of the command's environment, the ones whose value holds a
  // text $FAKE_WATCH lists, and how many of its arguments hold one.
  const WATCH = String.raw`"use strict";
const fs = require("node:fs");
const watched = JSON.parse(fs.readFileSync(process.env.FAKE_WATCH, "utf8"));
const envNames = Object.keys(process.env);
const held = (args) => ({
  envNames,
  envHoldingValue: envNames.filter((key) => watched.some((text) => process.env[key].includes(text))),
  argsHoldingValue: args.filter((arg) => watched.some((text) => arg.includes(text))).length,
});
`;
  // The stand-in for wrangler: one JSON line in $FAKE_LOG with its arguments, all of its standard input, its folder,
  // what WATCH gives and the two settings cf.sh makes.
  const FAKE_WRANGLER = `${WATCH}${String.raw`
const args = process.argv.slice(2);
let stdin = "";
try {
  stdin = fs.readFileSync(0, "utf8");
} catch {
  stdin = "";
}
const env = {};
for (const key of ["XDG_CONFIG_HOME", "CLOUDFLARE_ACCOUNT_ID"]) {
  if (key in process.env) env[key] = process.env[key];
}
const entry = { tool: "wrangler", args, stdin, cwd: process.cwd(), ...held(args), env };
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
`}`;
  // The stand-in for node, first on PATH: the real node with this module loaded first (--require), so cf.sh's config
  // check runs as it is. It records what WATCH gives (its options, the program after -e among its arguments) and reads
  // nothing from standard input.
  const FAKE_NODE = `${WATCH}${String.raw`
const args = [...process.execArgv, ...process.argv.slice(1)];
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: "node", ...held(args) }) + "\n");
`}`;

  /**
   * A throwaway checkout with both recorders. A run gets none of this shell's environment, only PATH, HOME, TMPDIR and
   * the recorders' files: under keyword a cf.sh that did not switch it off would run its `export NAME=value` lines as
   * bare exports, printing every exported variable. So a failure names the fault and the size of the output, never
   * the output.
   */
  function rig(t) {
    const dir = tempDir(t, "cf-own");
    const root = path.join(dir, "rosie");
    const cf = copyScript("cf.sh", root);
    copyScript("lib.sh", root);
    write(path.join(root, "wrangler.jsonc"), WRANGLER_JSONC);
    const stub = (file, ...words) => {
      const command = [process.execPath, ...words].map((word) => `"${word}"`).join(" ");
      write(file, `#!/usr/bin/env bash\nexec ${command} "$@"\n`, 0o755);
    };
    const wrangler = path.join(dir, "fake", "wrangler.cjs");
    write(wrangler, FAKE_WRANGLER);
    stub(path.join(root, "node_modules", ".bin", "wrangler"), wrangler);
    const node = path.join(dir, "fake", "node.cjs");
    write(node, FAKE_NODE);
    const bin = path.join(dir, "bin");
    stub(path.join(bin, "node"), "--require", node);
    const home = path.join(dir, "home");
    mkdirSync(home);
    const tmp = path.join(dir, "tmp");
    mkdirSync(tmp);
    const log = path.join(dir, "calls.ndjson");
    const watch = path.join(dir, "watched.json");
    write(watch, JSON.stringify(WATCHED));
    const run = (args, { stdin = "", extra = {}, bash = [] } = {}) =>
      spawnSync("bash", [...bash, cf, ...args], {
        cwd: root,
        encoding: "utf8",
        input: stdin,
        env: {
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          HOME: home,
          TMPDIR: tmp,
          FAKE_LOG: log,
          FAKE_WATCH: watch,
          ...extra,
        },
      });
    return { root, home, run, started: () => readLog(log) };
  }

  /** "<n> characters, not repeated here": the size of a stream a failure names in its place. */
  const size = (text) => `${String(text.length)} characters, not repeated here`;

  /**
   * Fails unless one run passed wrangler the arguments and standard input it was given, with the Rosfield sign-in and
   * account, said nothing, and no command it started (cf.sh's node, then wrangler) has a variable of cf.sh's own or a
   * watched text in its environment, or a watched text in node's arguments.
   */
  function assertNothingHandedOn(box, result, args, stdin, what) {
    assert.ok(
      result.status === 0,
      `${what}: exit ${String(result.status)} (the output is not repeated here)`,
    );
    assert.ok(result.stdout === "", `${what}: standard output is not empty (${size(result.stdout)})`);
    assert.ok(result.stderr === "", `${what}: standard error is not empty (${size(result.stderr)})`);
    const started = box.started();
    assert.deepEqual(
      started.map((entry) => entry.tool),
      ["node", "wrangler"],
      `${what}: the commands started`,
    );
    const [node, wrangler] = started;
    assert.deepEqual(wrangler.args, ["--config", path.join(box.root, "wrangler.jsonc"), ...args], what);
    assert.ok(wrangler.stdin === stdin, `${what}: wrangler's standard input is not what cf.sh was given`);
    assert.equal(wrangler.cwd, box.root, what);
    assert.deepEqual(
      wrangler.env,
      {
        XDG_CONFIG_HOME: path.join(box.home, ".config", "rosfield"),
        CLOUDFLARE_ACCOUNT_ID: ROSFIELD_ACCOUNT_ID,
      },
      `${what}: the Rosfield sign-in and account`,
    );
    assert.equal(node.argsHoldingValue, 0, `${what}: an argument of node holds a watched text`);
    for (const entry of started) {
      const which = `${what}, ${entry.tool}`;
      assert.deepEqual(
        OWN_NAMES.filter((name) => entry.envNames.includes(name)),
        [],
        `${which}: its environment has a variable of cf.sh's own`,
      );
      assert.deepEqual(
        entry.envHoldingValue,
        [],
        `${which}: a variable of its environment holds a watched text`,
      );
    }
  }

  // [title, the caller's environment, options for bash itself]: T-1236's caller set-ups, and mixes of them. POSIX mode
  // and SHELLOPTS are kept apart: with both, bash itself prints "SHELLOPTS: readonly variable" on standard error
  // (bash 3.2), before any line of a script runs, which is not cf.sh's to change.
  const SETUPS = [
    ["the caller's working names, exported with values", CALLER, []],
    ["bash -a", {}, ["-a"]],
    ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, []],
    ["bash --posix -a", {}, ["--posix", "-a"]],
    ["bash -k", {}, ["-k"]],
    ["SHELLOPTS=keyword", { SHELLOPTS: "keyword" }, []],
    ["SHELLOPTS=allexport:keyword", { SHELLOPTS: "allexport:keyword" }, []],
    [
      "a mix: the working names exported and SHELLOPTS=allexport:keyword",
      { ...CALLER, SHELLOPTS: "allexport:keyword" },
      [],
    ],
    ["a mix: the working names exported and bash --posix -a -k", CALLER, ["--posix", "-a", "-k"]],
  ];

  it("every variable cf.sh works with is dropped before anything is sourced, read or started", () => {
    assert.deepEqual(
      ownNames(),
      OWN_NAMES,
      "cf.sh or lib.sh works with another variable: add its name to cf.sh's unset lines and to OWN_NAMES",
    );
    const lines = code("cf.sh");
    // Tracing, allexport and keyword off first, then the unset lines, then lib.sh: nothing is assigned, read or
    // started before them.
    assert.deepEqual(
      lines.slice(0, 4),
      ["set +x", "set +a", "set +k", "set -euo pipefail"],
      "the first commands",
    );
    const unsets = [];
    let at = 4;
    for (; /^unset -v [A-Za-z_][A-Za-z0-9_ ]*$/.test(lines[at]); at += 1) {
      unsets.push(...lines[at].slice("unset -v ".length).split(" "));
    }
    assert.deepEqual([...unsets].sort(), OWN_NAMES, "the names on the unset lines");
    assert.equal(new Set(unsets).size, unsets.length, "a name is on the unset lines twice");
    assert.equal(lines[at], 'source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"', "what follows the unset lines");
  });

  for (const [title, extra, bash] of SETUPS) {
    it(`${title}: a secret put's value reaches wrangler on standard input alone, and a deploy's --var as an argument alone`, (t) => {
      for (const [args, stdin] of [
        [PUT, VALUE],
        [DEPLOY, ""],
      ]) {
        const box = rig(t);
        const what = `${title}, ${args.slice(0, 2).join(" ")}`;
        assertNothingHandedOn(box, box.run(args, { stdin, extra, bash }), args, stdin, what);
      }
    });
  }

  it("tracing from the caller (bash -x, or handed down in SHELLOPTS): nothing after the switch-off is traced", (t) => {
    for (const [what, extra, bash] of [
      ["bash -x", {}, ["-x"]],
      ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, []],
      [
        "the working names exported, SHELLOPTS=xtrace:allexport:keyword and bash -x -a -k",
        { ...CALLER, SHELLOPTS: "xtrace:allexport:keyword" },
        ["-x", "-a", "-k"],
      ],
    ]) {
      const box = rig(t);
      const result = box.run(PUT, { stdin: VALUE, extra, bash });
      assert.ok(
        result.status === 0,
        `${what}: exit ${String(result.status)} (the output is not repeated here)`,
      );
      assert.ok(result.stdout === "", `${what}: standard output is not empty (${size(result.stdout)})`);
      assert.ok(
        result.stderr === "+ set +x\n",
        `${what}: standard error is not the trace of set +x alone (${size(result.stderr)})`,
      );
      assert.equal(box.started().length, 2, `${what}: node and wrangler ran`);
    }
  });
});

// Tests for infra/scripts/put-staging-secrets.sh, `npm run secrets:staging` (T-568; C-022; build prompt rule 7: keys are
// named, never shown), run by `node --test "infra/ci/*.test.mjs"`. The script runs in a throwaway checkout: copies of
// it, lib.sh and the real cf.sh, this repository's wrangler.jsonc, a made-up .dev.vars, and a stand-in for wrangler at
// node_modules/.bin/wrangler that records what cf.sh hands it (its arguments, its standard input, the names of its
// environment's variables) and never reaches Cloudflare. So cf.sh's own checks run as they are, and a value is seen
// exactly where wrangler would get it. HOME and TMPDIR are folders of the test's own, and no run gets this shell's
// values of the names (script-harness.mjs). Every value is made up, and built at run time, so no key-shaped text sits
// in this file: none is a key of anything.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  REPO,
  ROSFIELD_ACCOUNT_ID,
  SCRIPTS,
  cleanEnv,
  copyScript,
  readLog,
  tempDir,
  write,
} from "./script-harness.mjs";

// The names the script puts, in its order.
const NAMES = ["ANTHROPIC_API_KEY", "SEALING_WRAP_KEY", "LINQ_WEBHOOK_SECRET"];
// The values of the checkout's .dev.vars: a model key, 32 bytes as base64 and a whsec_ secret, in the forms the code
// reads them in (db/repo/sealing.ts WrappingKeys.resolve; runtime/src/wiring/real.ts LinqVerifyInputs). The 32 bytes
// are picked so their base64 holds every sign base64 has: forty "+", then "//8=".
const VALUES = {
  ANTHROPIC_API_KEY: `t568-made-up-model-key-${"0f3c9a71".repeat(3)}`,
  SEALING_WRAP_KEY: Buffer.concat([
    Buffer.alloc(30, Buffer.from([0xfb, 0xef, 0xbe])),
    Buffer.from([0xff, 0xff]),
  ]).toString("base64"),
  LINQ_WEBHOOK_SECRET: `whsec_${Buffer.from("t568 made-up webhook signing bytes 0001").toString("base64")}`,
};
// Other made-up values under the same names, as the caller's shell might hold them: never the ones put.
const SHELL_VALUES = {
  ANTHROPIC_API_KEY: `t568-made-up-key-of-another-tool-${"7d1e44b2".repeat(3)}`,
  SEALING_WRAP_KEY: Buffer.alloc(32, 0x33).toString("base64"),
  LINQ_WEBHOOK_SECRET: `whsec_${Buffer.from("t568 another made-up signing secret 0002").toString("base64")}`,
};
// Lines of other names in the same .dev.vars: the script reads none of them.
const OTHER_VALUES = ["t568-made-up-email-key-55aa90c3", "t568-made-up-other-value-91c2e07d"];
const EVERY_VALUE = [...Object.values(VALUES), ...Object.values(SHELL_VALUES), ...OTHER_VALUES];

/** A .dev.vars in the build Mac's forms: plain, double-quoted, and exported with single quotes, among other lines. */
const devVars = (values = VALUES) =>
  [
    "# made-up values for T-568's test",
    `RESEND_API_KEY=${OTHER_VALUES[0]}`,
    ...("ANTHROPIC_API_KEY" in values ? [`ANTHROPIC_API_KEY=${values.ANTHROPIC_API_KEY}`] : []),
    ...("SEALING_WRAP_KEY" in values ? [`SEALING_WRAP_KEY="${values.SEALING_WRAP_KEY}"`] : []),
    ...("LINQ_WEBHOOK_SECRET" in values
      ? [`  export LINQ_WEBHOOK_SECRET='${values.LINQ_WEBHOOK_SECRET}'`]
      : []),
    `OTHER_NAME="${OTHER_VALUES[1]}"`,
    "",
  ].join("\n");

// The stand-in for wrangler (CommonJS). argv: wrangler's arguments, as cf.sh hands them on. It records one JSON line in
// $FAKE_LOG: its arguments, all of its standard input, its folder, the names (never the values) of its environment's
// variables, the names of those whose value holds what came on standard input, and three settings cf.sh and the script
// make. Then it repeats its standard input on both streams, as a wrangler that showed a secret would, and fails for the
// name FAKE_FAIL_AT gives.
const FAKE_WRANGLER = String.raw`"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
let stdin = "";
try {
  stdin = fs.readFileSync(0, "utf8");
} catch {
  stdin = "";
}
const env = {};
for (const key of ["XDG_CONFIG_HOME", "CLOUDFLARE_ACCOUNT_ID", "WRANGLER_LOG_SANITIZE"]) {
  if (key in process.env) env[key] = process.env[key];
}
const envNames = Object.keys(process.env);
const envHoldingStdin = stdin === "" ? [] : envNames.filter((key) => process.env[key].includes(stdin));
const entry = { tool: "wrangler", args, stdin, cwd: process.cwd(), envNames, envHoldingStdin, env };
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\n");
process.stdout.write("fake wrangler: was given " + stdin + "\n");
process.stderr.write("fake wrangler: was given " + stdin + "\n");
const name = args[args.indexOf("put") + 1];
if (process.env.FAKE_FAIL_AT === name) {
  process.stderr.write("fake wrangler: secret put " + name + " failed\n");
  process.exit(1);
}
process.stdout.write("Success! Uploaded secret " + name + "\n");
`;

/**
 * A throwaway checkout (see the top of this file). devVars: the text of its .dev.vars (left out: it has none); mode:
 * that file's mode; files: other files of the checkout.
 */
function checkout(t, { devVars: text, mode, files = {} } = {}) {
  const dir = tempDir(t, "secrets");
  const root = path.join(dir, "rosie");
  const script = copyScript("put-staging-secrets.sh", root);
  copyScript("lib.sh", root);
  copyScript("cf.sh", root);
  copyFileSync(path.join(REPO, "wrangler.jsonc"), path.join(root, "wrangler.jsonc"));
  const devVarsFile = path.join(root, ".dev.vars");
  if (text !== undefined) write(devVarsFile, text, mode);
  for (const [name, content] of Object.entries(files)) write(path.join(root, name), content);
  const program = path.join(dir, "fake", "wrangler.cjs");
  write(program, FAKE_WRANGLER);
  write(
    path.join(root, "node_modules", ".bin", "wrangler"),
    `#!/usr/bin/env bash\nexec "${process.execPath}" "${program}" "$@"\n`,
    0o755,
  );
  const home = path.join(dir, "home");
  write(path.join(home, ".keep"), "");
  const tmp = path.join(dir, "tmp");
  mkdirSync(tmp);
  const log = path.join(dir, "calls.ndjson");
  /** Runs the script; `bash` holds options for bash itself (-x). This shell's values of the names never reach it. */
  const run = (args = [], extra = {}, { bash = [] } = {}) => {
    const unset = Object.fromEntries(NAMES.map((name) => [name, undefined]));
    const result = spawnSync("bash", [...bash, script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: cleanEnv(home, { FAKE_LOG: log, TMPDIR: tmp, ...unset, ...extra }),
    });
    return { ...result, output: `${result.stdout}${result.stderr}` };
  };
  return { dir, root, home, log, devVarsFile, run, calls: () => readLog(log) };
}

/** The wrangler arguments of one put, as cf.sh hands them on. */
const putArgs = (rig, name) => [
  "--config",
  path.join(rig.root, "wrangler.jsonc"),
  "secret",
  "put",
  name,
  "--env",
  "staging",
];

/** Fails when a run's standard output or standard error holds any made-up value. */
function assertNoValueShown(result, what) {
  for (const stream of ["stdout", "stderr"]) {
    const held = EVERY_VALUE.filter((value) => result[stream].includes(value));
    assert.deepEqual(held, [], `${what}: ${stream} holds a value`);
  }
}

/** Fails when a recorded call holds a made-up value anywhere but its standard input, or has a name in its environment. */
function assertOnlyOnStdin(call, what) {
  const { stdin, ...rest } = call;
  const held = EVERY_VALUE.filter((value) => JSON.stringify(rest).includes(value));
  assert.deepEqual(
    held,
    [],
    `${what}: a value outside standard input (${String(stdin.length)} characters there)`,
  );
  assert.deepEqual(call.envHoldingStdin, [], `${what}: a variable of wrangler's environment holds the value`);
  const named = NAMES.filter((name) => call.envNames.includes(name));
  assert.deepEqual(named, [], `${what}: wrangler's environment has a variable of a secret's name`);
}

/** The files under dir, other than `except`, that hold any of the values. */
function filesHolding(dir, values, except) {
  const held = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) held.push(...filesHolding(file, values, except));
    else if (entry.isFile() && !except.includes(file)) {
      const text = readFileSync(file, "utf8");
      if (values.some((value) => text.includes(value))) held.push(file);
    }
  }
  return held;
}

const ALL_SET = NAMES.map((name) => `${name} set\n`).join("");

describe("put-staging-secrets.sh (npm run secrets:staging) puts each named value through cf.sh", () => {
  it("each value reaches wrangler on standard input only, and the output is only the names with set", (t) => {
    const rig = checkout(t, { devVars: devVars() });
    const result = rig.run();
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stdout, ALL_SET);
    assert.equal(result.stderr, "");
    const calls = rig.calls();
    assert.deepEqual(
      calls.map((call) => call.args),
      NAMES.map((name) => putArgs(rig, name)),
    );
    for (const [index, name] of NAMES.entries()) {
      const call = calls[index];
      assert.equal(call.stdin, VALUES[name], `${name}: standard input is its value, byte for byte`);
      assert.equal(call.cwd, rig.root);
      assertOnlyOnStdin(call, name);
      // cf.sh ran: the Rosfield sign-in and account. The script's own setting keeps request bodies out of wrangler's log.
      assert.deepEqual(call.env, {
        XDG_CONFIG_HOME: path.join(rig.home, ".config", "rosfield"),
        CLOUDFLARE_ACCOUNT_ID: ROSFIELD_ACCOUNT_ID,
        WRANGLER_LOG_SANITIZE: "true",
      });
    }
    // No file holds a value but the .dev.vars it came from and the stand-in's own record of its standard input.
    assert.deepEqual(filesHolding(rig.dir, EVERY_VALUE, [rig.devVarsFile, rig.log]), []);
  });

  it("--env staging, in either spelling, is the default", (t) => {
    for (const args of [["--env", "staging"], ["--env=staging"]]) {
      const rig = checkout(t, { devVars: devVars() });
      const result = rig.run(args);
      assert.equal(result.status, 0, `${JSON.stringify(args)}: ${result.output}`);
      assert.equal(result.stdout, ALL_SET);
      assert.equal(result.stderr, "");
      assert.deepEqual(
        rig.calls().map((call) => call.stdin),
        NAMES.map((name) => VALUES[name]),
      );
    }
  });

  it("the value put is the .dev.vars one, never a variable of the same name in the caller's shell", (t) => {
    const rig = checkout(t, { devVars: devVars() });
    const result = rig.run([], { ...SHELL_VALUES, WRANGLER_LOG_SANITIZE: "false" });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.stdout, ALL_SET);
    assert.equal(result.stderr, "");
    const calls = rig.calls();
    assert.deepEqual(
      calls.map((call) => call.stdin),
      NAMES.map((name) => VALUES[name]),
    );
    for (const [index, name] of NAMES.entries()) {
      assertOnlyOnStdin(calls[index], name);
      assert.equal(calls[index].env.WRANGLER_LOG_SANITIZE, "true", name);
    }
  });

  it("a name with no value is reported missing and nothing is put for it, never an empty secret (exit 3)", (t) => {
    const value = VALUES.SEALING_WRAP_KEY;
    const lines = [
      null,
      "SEALING_WRAP_KEY=",
      'SEALING_WRAP_KEY=""',
      "SEALING_WRAP_KEY=''",
      "SEALING_WRAP_KEY=   ",
      `# SEALING_WRAP_KEY=${value}`,
      `SEALING_WRAP_KEY_OLD=${value}`,
    ];
    const others = {
      ANTHROPIC_API_KEY: VALUES.ANTHROPIC_API_KEY,
      LINQ_WEBHOOK_SECRET: VALUES.LINQ_WEBHOOK_SECRET,
    };
    for (const line of lines) {
      const what = line === null ? "no line" : line.replace(value, "<value>");
      const rig = checkout(t, { devVars: `${devVars(others)}${line ?? ""}\n` });
      // A value of that name in the caller's shell does not stand in for the missing one.
      const result = rig.run([], { SEALING_WRAP_KEY: SHELL_VALUES.SEALING_WRAP_KEY });
      assert.equal(result.status, 3, `${what}: ${result.output}`);
      assert.equal(
        result.stdout,
        "ANTHROPIC_API_KEY set\nSEALING_WRAP_KEY missing\nLINQ_WEBHOOK_SECRET set\n",
        what,
      );
      assert.equal(
        result.stderr,
        "put-staging-secrets.sh: no value in .dev.vars for 1 of the 3 names, each printed as missing: nothing was put for a missing name. Add each as NAME=value, then run it again.\n",
        what,
      );
      const calls = rig.calls();
      assert.deepEqual(
        calls.map((call) => call.args),
        [putArgs(rig, "ANTHROPIC_API_KEY"), putArgs(rig, "LINQ_WEBHOOK_SECRET")],
        what,
      );
      assert.deepEqual(
        calls.map((call) => call.stdin),
        [VALUES.ANTHROPIC_API_KEY, VALUES.LINQ_WEBHOOK_SECRET],
        what,
      );
      for (const call of calls) assertOnlyOnStdin(call, what);
      assertNoValueShown(result, what);
    }
  });

  it("with no .dev.vars every name is missing and wrangler never starts, whatever the caller's shell holds", (t) => {
    const rig = checkout(t);
    const result = rig.run([], SHELL_VALUES);
    assert.equal(result.status, 3, result.output);
    assert.equal(result.stdout, NAMES.map((name) => `${name} missing\n`).join(""));
    assert.match(result.stderr, /^put-staging-secrets\.sh: no value in \.dev\.vars for 3 of the 3 names, /);
    assert.deepEqual(rig.calls(), []);
    assertNoValueShown(result, "no .dev.vars");
  });
});

describe("put-staging-secrets.sh refuses", () => {
  // [title, arguments, extra environment, the reason]
  const NOT_STAGING = [
    ["--env production", ["--env", "production"], {}, /--env production is never run from here/],
    ["--env=production", ["--env=production"], {}, /--env production is never run from here/],
    ["--env preview", ["--env", "preview"], {}, /--env names an environment other than staging/],
    ["--env=preview", ["--env=preview"], {}, /--env names an environment other than staging/],
    ["--env local", ["--env", "local"], {}, /--env names an environment other than staging/],
    [
      '--env "" (the top level, production)',
      ["--env", ""],
      {},
      /--env names an environment other than staging/,
    ],
    ["--env= (the top level, production)", ["--env="], {}, /--env names an environment other than staging/],
    ["--env without a value", ["--env"], {}, /--env names an environment other than staging/],
    ["--env staging twice", ["--env", "staging", "--env", "staging"], {}, /--env is given more than once/],
    [
      "a second --env, production",
      ["--env", "staging", "--env", "production"],
      {},
      /--env production is never/,
    ],
    ["a second --env, staging", ["--env=preview", "--env=staging"], {}, /--env is given more than once/],
    [
      "CLOUDFLARE_ENV=production",
      [],
      { CLOUDFLARE_ENV: "production" },
      /CLOUDFLARE_ENV names an environment/,
    ],
    [
      "CLOUDFLARE_ENV=production with --env staging",
      ["--env", "staging"],
      { CLOUDFLARE_ENV: "production" },
      /CLOUDFLARE_ENV names an environment/,
    ],
  ];

  it("any environment but staging, and a second --env, before any value is read", (t) => {
    // The same refusal on a .dev.vars that holds the values and on one that cannot be read at all: a script that read
    // it first would stop on the second with another message (the next test shows that it does, once it reads).
    const readable = checkout(t, { devVars: devVars() });
    const unreadable = checkout(t, { devVars: devVars(), mode: 0o000 });
    for (const [title, args, extra, reason] of NOT_STAGING) {
      for (const [kind, rig] of [
        ["a .dev.vars with the values", readable],
        ["a .dev.vars that cannot be read", unreadable],
      ]) {
        const what = `${title}, ${kind}`;
        const result = rig.run(args, extra);
        assert.equal(result.status, 1, `${what}: ${result.output}`);
        assert.match(
          result.stderr,
          /^put-staging-secrets\.sh: refused: [^\n]*; nothing was read or put\n$/,
          what,
        );
        assert.match(result.stderr, reason, what);
        assert.equal(result.stdout, "", what);
        assert.deepEqual(rig.calls(), [], `${what}: wrangler must not start`);
        assertNoValueShown(result, what);
      }
    }
  });

  it("a .dev.vars that cannot be read, once it comes to reading it: nothing is put", (t) => {
    const rig = checkout(t, { devVars: devVars(), mode: 0o000 });
    for (const args of [[], ["--env", "staging"]]) {
      const result = rig.run(args);
      assert.equal(result.status, 1, result.output);
      assert.equal(
        result.stderr,
        "put-staging-secrets.sh: refused: this checkout's .dev.vars cannot be read; nothing was put\n",
      );
      assert.equal(result.stdout, "");
      assert.deepEqual(rig.calls(), []);
    }
  });

  it("an argument it does not take (exit 2), never echoed, before anything is read", (t) => {
    const rig = checkout(t, { devVars: devVars(), mode: 0o000 });
    const pasted = SHELL_VALUES.ANTHROPIC_API_KEY;
    for (const args of [
      ["production"],
      ["--bogus"],
      ["-e", "production"],
      ["--env", "staging", "extra"],
      [pasted],
      [`--key=${pasted}`],
    ]) {
      const what = JSON.stringify(args).replace(pasted, "<a pasted value>");
      const result = rig.run(args);
      assert.equal(result.status, 2, `${what}: ${result.output}`);
      assert.equal(
        result.stderr,
        "put-staging-secrets.sh: an argument it does not take (arguments are never echoed)\n" +
          "usage: put-staging-secrets.sh [--env staging]\n",
        what,
      );
      assert.equal(result.stdout, "", what);
      assert.deepEqual(rig.calls(), [], what);
    }
  });

  it("a value that holds a space, a quote or a #, before any put: its name is given, never the value", (t) => {
    const key = VALUES.SEALING_WRAP_KEY;
    const secret = VALUES.LINQ_WEBHOOK_SECRET;
    // [the lines of the two names, the names refused]
    const cases = [
      [[`SEALING_WRAP_KEY="${key}" # staging's key`, `LINQ_WEBHOOK_SECRET=${secret}`], "SEALING_WRAP_KEY"],
      [[`SEALING_WRAP_KEY=${key} # staging's key`, `LINQ_WEBHOOK_SECRET=${secret}`], "SEALING_WRAP_KEY"],
      [[`SEALING_WRAP_KEY="${key}`, `LINQ_WEBHOOK_SECRET=${secret}`], "SEALING_WRAP_KEY"],
      [
        [`SEALING_WRAP_KEY=${key}`, `LINQ_WEBHOOK_SECRET=${secret.slice(0, 12)} ${secret.slice(12)}`],
        "LINQ_WEBHOOK_SECRET",
      ],
      [
        [`SEALING_WRAP_KEY='${key}' # a comment`, `LINQ_WEBHOOK_SECRET=${secret}#1`],
        "SEALING_WRAP_KEY, LINQ_WEBHOOK_SECRET",
      ],
    ];
    for (const [lines, names] of cases) {
      const what = `${names}: ${lines.join(" | ").replace(key, "<key>").replace(secret, "<secret>")}`;
      const text = `ANTHROPIC_API_KEY=${VALUES.ANTHROPIC_API_KEY}\n${lines.join("\n")}\n`;
      const rig = checkout(t, { devVars: text });
      const result = rig.run();
      assert.equal(result.status, 1, `${what}: ${result.output}`);
      assert.equal(
        result.stderr,
        `put-staging-secrets.sh: refused: in .dev.vars the value of ${names} holds a space, a quote or a #, which no key does: write its line as NAME=value, with nothing after the value; nothing was put\n`,
        what,
      );
      assert.equal(result.stdout, "", what);
      assert.deepEqual(rig.calls(), [], `${what}: wrangler must not start`);
      assertNoValueShown(result, what);
      assert.equal(result.output.includes(secret.slice(12)), false, `${what}: a part of the value`);
    }
  });
});

describe("put-staging-secrets.sh when a put fails", () => {
  it("stops there: the names before it stay set, the ones after it are not put, and the value is taken out of wrangler's words", (t) => {
    const rig = checkout(t, { devVars: devVars() });
    const result = rig.run([], { FAKE_FAIL_AT: "SEALING_WRAP_KEY" });
    assert.equal(result.status, 1, result.output);
    assert.equal(result.stdout, "ANTHROPIC_API_KEY set\n");
    // Both streams of wrangler, each with the value it repeated taken out, then the script's own line.
    assert.match(result.stderr, /^fake wrangler: was given \[value not shown\]$/m);
    assert.match(result.stderr, /^fake wrangler: secret put SEALING_WRAP_KEY failed$/m);
    assert.match(
      result.stderr,
      /^put-staging-secrets\.sh: wrangler secret put SEALING_WRAP_KEY --env staging failed \(exit 1, for the reason above\): SEALING_WRAP_KEY was not put, and no name after it was tried; the names printed as set stay set\. Once the cause is fixed, run it again\.$/m,
    );
    assert.deepEqual(
      rig.calls().map((call) => call.args),
      [putArgs(rig, "ANTHROPIC_API_KEY"), putArgs(rig, "SEALING_WRAP_KEY")],
    );
    assertNoValueShown(result, "a failed put");
  });

  it("a refusal of cf.sh itself arrives the same way, and wrangler never starts", (t) => {
    // cf.sh refuses a checkout with a .env file (wrangler would load it past cf.sh's checks).
    const rig = checkout(t, { devVars: devVars(), files: { ".env": "# names only\n" } });
    const result = rig.run();
    assert.equal(result.status, 1, result.output);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^cf\.sh: refused: \S+\/\.env exists: /m);
    assert.match(
      result.stderr,
      /^put-staging-secrets\.sh: wrangler secret put ANTHROPIC_API_KEY --env staging failed \(exit 1, /m,
    );
    assert.deepEqual(rig.calls(), []);
    assertNoValueShown(result, "cf.sh's refusal");
  });
});

describe("put-staging-secrets.sh never traces and writes no file", () => {
  it("under bash -x, and with xtrace handed down in SHELLOPTS, no command after the switch-off is traced", (t) => {
    for (const [what, extra, options] of [
      ["bash -x", {}, { bash: ["-x"] }],
      ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, {}],
    ]) {
      const rig = checkout(t, { devVars: devVars() });
      const result = rig.run([], extra, options);
      assert.equal(result.status, 0, `${what}: ${result.output}`);
      assert.equal(result.stdout, ALL_SET, what);
      assert.match(result.stderr, /set \+x/, `${what}: the run was traced until the script switched it off`);
      assert.doesNotMatch(result.stderr, /pipefail|printf|secret put|value/, what);
      assertNoValueShown(result, what);
      assert.deepEqual(
        rig.calls().map((call) => call.stdin),
        NAMES.map((name) => VALUES[name]),
        what,
      );
    }
  });

  it("the script switches tracing off first, and has no here-document, here-string, file redirection or export of a value", () => {
    const lines = readFileSync(path.join(SCRIPTS, "put-staging-secrets.sh"), "utf8").split("\n");
    const code = lines.filter((line) => !/^\s*#/.test(line));
    assert.equal(
      code.find((line) => line.trim() !== ""),
      "set +x",
      "the first command",
    );
    const text = code.join("\n");
    assert.doesNotMatch(text, /set\s+-[A-Za-z]*x|xtrace/, "tracing is never switched on");
    // bash 3.2 writes a here-document or here-string to a temporary file: no < at all.
    assert.doesNotMatch(text, /</, "no here-document, here-string or input redirection");
    assert.doesNotMatch(text.replaceAll("2>&1", "").replaceAll(">&2", ""), />/, "no redirection into a file");
    assert.doesNotMatch(text, /\b(mktemp|tee)\b/);
    assert.deepEqual(text.match(/^[ \t]*(export|declare -x)\b.*$/gm), ["export WRANGLER_LOG_SANITIZE=true"]);
  });
});

describe("put-staging-secrets.sh hands no variable of its own on to what it starts", () => {
  // The names the script, and lib.sh's load_dev_var that reads .dev.vars for it, keep variables of their own under.
  // value, line and said hold a value, a line of .dev.vars and wrangler's words; the others hold names, counts, a path
  // and the --env argument.
  const OWN_NAMES = [
    "bad",
    "env_count",
    "env_name",
    "file",
    "line",
    "missing",
    "name",
    "said",
    "status",
    "value",
  ];

  /**
   * The same names, read from the two files: every name in small letters that the script or load_dev_var assigns,
   * loops over or declares local. (The names in capitals are the script's fixed texts and paths.)
   */
  function ownNames() {
    const code = (file) =>
      readFileSync(path.join(SCRIPTS, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
    const loader = /^load_dev_var\(\) \{\n([\s\S]*?)\n\}$/m.exec(code("lib.sh"));
    assert.ok(loader, "lib.sh no longer holds: load_dev_var() { ... }");
    const text = `${code("put-staging-secrets.sh")}\n${loader[1]}`;
    const names = new Set();
    // name=..., first on its line or after ;, && or ||.
    for (const [, name] of text.matchAll(/(?:^|;|&&|\|\|)[ \t]*([a-z_][a-z0-9_]*)=/gm)) names.add(name);
    // for name in ...
    for (const [, name] of text.matchAll(/\bfor[ \t]+([a-z_][a-z0-9_]*)[ \t]+in\b/g)) names.add(name);
    // local name="..." other: each word of the declaration, up to its =.
    for (const [, words] of text.matchAll(/^[ \t]*local[ \t]+(.+)$/gm)) {
      for (const word of words.split(/[ \t]+/)) names.add(word.replace(/=.*$/, ""));
    }
    return [...names].sort();
  }

  /**
   * Fails unless a run put every value, on standard input alone, and for every put wrangler's environment holds no
   * value and no variable under any of `names`, whatever its text.
   */
  function assertNothingHandedOn(rig, result, names, what) {
    assert.equal(result.status, 0, `${what}: ${result.output}`);
    assert.equal(result.stdout, ALL_SET, what);
    assert.equal(result.stderr, "", what);
    const calls = rig.calls();
    assert.deepEqual(
      calls.map((call) => call.stdin),
      NAMES.map((name) => VALUES[name]),
      what,
    );
    for (const [index, name] of NAMES.entries()) {
      const call = calls[index];
      assertOnlyOnStdin(call, `${what}, ${name}`);
      assert.deepEqual(
        names.filter((own) => call.envNames.includes(own)),
        [],
        `${what}, ${name}: wrangler's environment has a variable of the script's own`,
      );
    }
  }

  it("a caller's environment that already holds value, said, line and every other name the script works with", (t) => {
    assert.deepEqual(
      ownNames(),
      OWN_NAMES,
      "put-staging-secrets.sh or lib.sh's load_dev_var works with another variable: add its name to the script's unset line and to OWN_NAMES",
    );
    // BASH_REMATCH too: bash leaves there what load_dev_var's match took from a line of .dev.vars.
    const names = [...OWN_NAMES, "BASH_REMATCH"];
    // bash marks every variable it inherits for export, so each of these would go on to cf.sh and wrangler with
    // whatever the script next kept in it.
    const caller = Object.fromEntries(names.map((name) => [name, `t568 made-up caller text, ${name}`]));
    const rig = checkout(t, { devVars: devVars() });
    assertNothingHandedOn(rig, rig.run([], caller), names, "the caller's variables");
  });

  it("allexport from the caller (bash -a, or handed down in SHELLOPTS), which marks every variable as it is set", (t) => {
    for (const [what, extra, options] of [
      ["bash -a", {}, { bash: ["-a"] }],
      ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, {}],
    ]) {
      const rig = checkout(t, { devVars: devVars() });
      assertNothingHandedOn(rig, rig.run([], extra, options), OWN_NAMES, what);
    }
  });
});

describe("put-staging-secrets.sh's names are the ones the runtime reads", () => {
  const source = (file) => readFileSync(path.join(REPO, file), "utf8");
  /** The value of `export const <constant> = "<NAME>";` in a source file. */
  const nameIn = (file, constant) => {
    const match = new RegExp(`^export const ${constant} = "([A-Z][A-Z0-9_]*)";$`, "m").exec(source(file));
    assert.ok(match, `${file} no longer holds: export const ${constant} = "<NAME>";`);
    return match[1];
  };

  /** The script's names, from a run: with no .dev.vars it names each as missing, in its order. */
  function namesOfTheScript(t) {
    const result = checkout(t).run();
    assert.equal(result.status, 3, result.output);
    return Array.from(result.stdout.matchAll(/^(\S+) missing$/gm), ([, name]) => name);
  }

  it("the model key the AI gateway reads, the wrapping key the seal call reads and the Linq webhook secret", (t) => {
    const read = [
      // T-361: the AI gateway's key, which the safety read reads by the same constant.
      nameIn("ai/src/gateway/gateway.ts", "KEY_VARIABLE"),
      // T-182 and T-553: the environment key that wraps each person's sealing key.
      nameIn("db/repo/sealing.ts", "DEFAULT_WRAPPING_KEY_NAME"),
      nameIn("runtime/src/wiring/real.ts", "SEALING_WRAP_KEY"),
      // T-552 and T-412: the secret the Linq verify reads, which the test-phone page's Linq double signs with.
      nameIn("runtime/src/wiring/real.ts", "LINQ_WEBHOOK_SECRET"),
    ];
    const names = namesOfTheScript(t);
    assert.deepEqual(names, NAMES);
    assert.deepEqual([...names].sort(), [...new Set(read)].sort());
  });

  it("every secret the Worker's root declares (WorkerSecrets) is in the script's list", (t) => {
    const block = /^export interface WorkerSecrets \{\n([\s\S]*?)\n\}$/m.exec(
      source("runtime/src/wiring/root.ts"),
    );
    assert.ok(block, "runtime/src/wiring/root.ts no longer holds: export interface WorkerSecrets { ... }");
    const declared = Array.from(
      block[1].matchAll(/^\s*readonly ([A-Z][A-Z0-9_]*)\??:/gm),
      ([, name]) => name,
    );
    assert.ok(declared.includes("LINQ_WEBHOOK_SECRET"), `WorkerSecrets declares ${declared.join(", ")}`);
    const names = namesOfTheScript(t);
    assert.deepEqual(
      declared.filter((name) => !names.includes(name)),
      [],
      "a secret the Worker reads that put-staging-secrets.sh does not put: add its name to SECRETS",
    );
  });
});

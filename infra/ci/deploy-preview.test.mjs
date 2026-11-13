// Tests for infra/scripts/deploy-preview.sh (factory spec 6; DL-024), run in ci.yml by
// `node --test "infra/ci/*.test.mjs"`. They build a throwaway origin (a bare repository in the system temp
// folder, never the real one) with a main branch and task branches, clone it as the lead's checkout, and run
// the checkout's deploy-preview.sh with fake npm and wrangler commands that only record their calls
// (script-harness.mjs), and a fake validators' build in main's infra/build/ that records its run the same way
// (FAKE_BUILD). No STAGING_DATABASE_URL is set, so no migration runs. The checkout's fake wrangler also keeps a
// copy of the config cf.sh hands it, so a test reads exactly what an upload received (T-1256: a preview never
// gets a Hyperdrive binding). The last describe (T-1310) sets a made-up one, with a fake migrate.mjs in main and a
// recorder in front of every command, and shows the URL reaches migrate.mjs alone.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";

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

// The contract the fake build reads.
const CONTRACT = "contracts/tool-api/tool-api.v1.5.schema.json";

// main's infra/build/tool-api-validators.mjs in the throwaway origin, in place of the real build (T-1144), which
// needs Ajv and the contracts. It records its run as the fake tools record theirs, one JSON line in $FAKE_LOG:
// the script node ran, its arguments, its folder and the folder it writes, actions/src/tool-api/generated/
// beside the script's own checkout, as the real build's. Like the real build, it fails (exit 1, nothing
// written) when a contract it reads does not parse.
const FAKE_BUILD = String.raw`import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..", "..");
const out = path.join(root, "actions", "src", "tool-api", "generated");
const call = { tool: "tool-api-validators", args: process.argv.slice(2), cwd: process.cwd(), script, out };
appendFileSync(process.env.FAKE_LOG, JSON.stringify(call) + "\n");
try {
  JSON.parse(readFileSync(path.join(root, ${JSON.stringify(CONTRACT)}), "utf8"));
} catch (error) {
  console.log("FAIL tool-api validators: " + error.message);
  process.exit(1);
}
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, "validators.js"), "export const definitions = {};\n");
console.log("tool-api validators: written to " + path.relative(process.cwd(), out));
`;

/** A symbolic link at file to target, in place of any file there, as a branch can commit one. */
function link(target, file) {
  mkdirSync(path.dirname(file), { recursive: true });
  rmSync(file, { force: true });
  symlinkSync(target, file);
}

// Letters outside ASCII, built from their code points so that this file stays ASCII and none of them hides
// behind the letter it looks like: U+017F (long s) and U+212A (Kelvin sign), which this Mac's volume folds to s
// and k (DL-456), and U+00E9 (e with an acute accent).
const LONG_S = String.fromCodePoint(0x17f);
const KELVIN_SIGN = String.fromCodePoint(0x212a);
const E_ACUTE = String.fromCodePoint(0xe9);

// The branches of the throwaway origin and what each changes from main (a { link } is a symbolic link).
const BRANCHES = {
  "task/T-1-code": { "runtime/src/index.ts": "export default { fetch: () => new Response('T-1') };\n" },
  "task/T-2-wrangler": {
    "wrangler.jsonc": WRANGLER_JSONC.replace('"name": "rosie-staging"', '"name": "rosie"'),
  },
  "task/T-3-infra": {
    // A branch cf.sh without any guard: deploy-preview.sh must never run it.
    "infra/scripts/cf.sh": '#!/usr/bin/env bash\necho "the branch cf.sh ran" >"$BRANCH_CF_MARKER"\n',
  },
  "task/T-4-package": { "package.json": '{ "name": "rosie", "private": true, "scripts": { "x": "y" } }\n' },
  "task/T-5-lockfile": {
    "package-lock.json": '{ "name": "rosie", "lockfileVersion": 3, "packages": { "": {} } }\n',
  },
  "task/T-6-github": { ".github/workflows/ci.yml": "name: ci\non: push\n" },
  "task/T-7-workspace-package": {
    "runtime/package.json": '{ "name": "@rosie/runtime", "version": "0.0.1" }\n',
  },
  "task/T-8-npmrc": { ".npmrc": "registry=https://registry.example.invalid/\n" },
  "task/T-10-shrinkwrap": {
    "npm-shrinkwrap.json": '{ "name": "rosie", "lockfileVersion": 3, "packages": {} }\n',
  },
  // A contract that does not parse (contracts/ is not guarded): the validators' build fails in the worktree.
  "task/T-11-contract": { [CONTRACT]: '{ "title": \n' },
  // A branch build script: deploy-preview.sh must never run it unreviewed.
  "task/T-12-build-script": {
    "infra/build/tool-api-validators.mjs": 'console.log("the branch build script ran");\n',
  },
  // Ajv's run-time helper in a node_modules the branch adds, where the generated code's import would find it.
  "task/T-13-node-modules": {
    "actions/src/tool-api/generated/node_modules/ajv/dist/runtime/equal.js": "module.exports = () => true;\n",
  },
  // A link named node_modules, to a folder of the branch's own.
  "task/T-14-node-modules-link": { "actions/src/tool-api/node_modules": { link: "../../../runtime/src" } },
  // The same names in other letter case, which this Mac's volume ignores (DL-453): to node and npm they are a
  // node_modules folder, a package.json (whose name and exports point the generated code's ajv imports at the
  // branch's files) and an .npmrc. None of them is a name main has, so each is a new file on any volume.
  "task/T-15-node-modules-case": {
    "actions/src/tool-api/generated/Node_Modules/ajv/dist/runtime/equal.js": "module.exports = () => true;\n",
  },
  "task/T-16-package-json-case": {
    "actions/src/tool-api/generated/PACKAGE.JSON":
      '{ "name": "ajv", "exports": { "./dist/runtime/*": "./runtime/*" } }\n',
  },
  "task/T-17-npmrc-case": { ".NPMRC": "registry=https://registry.example.invalid/\n" },
  // A link where the build writes its files, to a folder outside the checkout (DL-453).
  "task/T-18-generated-link": { "actions/src/tool-api/generated": { link: "../../../../outside" } },
  // One of main's files made a link.
  "task/T-19-file-to-link": { "runtime/src/index.ts": { link: "../../../outside/index.ts" } },
  // Paths with characters outside printable ASCII (DL-456). git's icase folds ASCII letters only, but this Mac's
  // volume also folds U+017F (long s) to s and U+212A (Kelvin sign) to k: to node and npm these are a
  // node_modules folder and a package.json (as in T-15 and T-16) that no guarded entry matches.
  "task/T-20-node-modules-long-s": {
    [`actions/src/tool-api/generated/node_module${LONG_S}/ajv/dist/runtime/equal.js`]:
      "module.exports = () => true;\n",
  },
  "task/T-21-package-json-kelvin": {
    [`actions/src/tool-api/generated/pac${KELVIN_SIGN}age.json`]:
      '{ "name": "ajv", "exports": { "./dist/runtime/*": "./runtime/*" } }\n',
  },
  // Other paths outside printable ASCII: an accented letter; a tab and a newline in one name, which the
  // NUL-separated read keeps whole; and an accented letter in a guarded path.
  "task/T-22-accented": { [`runtime/src/caf${E_ACUTE}.ts`]: "export {};\n" },
  "task/T-23-control-characters": { "runtime/src/a\tb\nc.ts": "export {};\n" },
  "task/T-24-guarded-accented": { [`infra/scripts/caf${E_ACUTE}.sh`]: "#!/usr/bin/env bash\n" },
  // A space (0x20) and a tilde (0x7E), the two ends of printable ASCII: nothing to refuse. DEL (0x7F), just past
  // the end: refused.
  "task/T-25-space-tilde": { "runtime/src/a b~.ts": "export {};\n" },
  "task/T-27-delete-character": { "runtime/src/del\u007f.ts": "export {};\n" },
};

// T-1256 (ADR-014 new task a): a preview's upload never carries a Hyperdrive binding.

/** A wrangler.jsonc's value, read as wrangler reads it: comments and trailing commas outside strings dropped. */
function parseJsonc(text) {
  let json = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      json += c;
      if (c === "\\") json += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      json += c;
    } else if (text.startsWith("//", i)) {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      assert.ok(end > 0, "a /* comment is not closed");
      i = end + 1;
    } else if (c === "}" || c === "]") {
      json = json.replace(/,\s*$/, "") + c;
    } else {
      json += c;
    }
  }
  return JSON.parse(json);
}

// Made-up bindings in the shape T-567 gives env.staging (ADR-014 sections 3 and 4): made-up ids, and local strings
// with a made-up login and password, so no real id, login, password or host is here.
const ID_JOB = "0123456789abcdef0123456789abcdef";
const ID_APP = "fedcba9876543210fedcba9876543210";
const ID_OTHER = "00112233445566778899aabbccddeeff";
const MADE_UP_PASSWORD = "t1256-made-up-password";
const madeUpBinding = (binding, id) => ({
  binding,
  id,
  localConnectionString: `postgres://t1256_login:${MADE_UP_PASSWORD}@127.0.0.1:54329/t1256_made_up`,
});

/** The repository's wrangler.jsonc after change(config), as JSONC: a comment first and a trailing comma last. */
function wranglerJsonc(change) {
  const config = parseJsonc(WRANGLER_JSONC);
  change(config);
  const json = JSON.stringify(config, null, 2).replace(/\n}$/, ",\n}");
  return `// deploy-preview.test.mjs (T-1256): the repository's wrangler.jsonc, changed.\n${json}\n`;
}

/** main's wrangler.jsonc once env.staging binds HYPERDRIVE_JOB and HYPERDRIVE_APP (as T-567 will), then change. */
const withBindings = (change) =>
  wranglerJsonc((config) => {
    config.env.staging.hyperdrive = [
      madeUpBinding("HYPERDRIVE_JOB", ID_JOB),
      madeUpBinding("HYPERDRIVE_APP", ID_APP),
    ];
    change?.(config);
  });
const WITH_BINDINGS = withBindings();

// Configs that still name a Hyperdrive binding once env.staging's list is left out, each with the paths the
// refusal names: an unsafe binding and unsafe metadata (wrangler 4.158.0 sends both as they are), a required
// secret named as a binding left out (wrangler sends it as an inherit binding, which would take the deployed
// version's binding of that name), and a list at the top level (wrangler does not hand it down to env.staging,
// and it stops the preview all the same).
const STILL_NAMED = [
  [
    "task/T-30-unsafe-binding",
    (config) => {
      config.env.staging.unsafe = { bindings: [{ name: "EXTRA", type: "hyperdrive", id: ID_OTHER }] };
    },
    ["env.staging.unsafe.bindings[0].type"],
  ],
  [
    "task/T-31-unsafe-metadata",
    (config) => {
      config.env.staging.unsafe = { metadata: { keep_bindings: ["hyperdrive"] } };
    },
    ["env.staging.unsafe.metadata.keep_bindings[0]"],
  ],
  [
    "task/T-32-required-secret",
    (config) => {
      config.env.staging.hyperdrive.push(madeUpBinding("REPORTS", ID_OTHER));
      config.env.staging.secrets = { required: ["REPORTS"] };
    },
    ["env.staging.secrets.required[0]"],
  ],
  [
    "task/T-33-top-level",
    (config) => {
      config.hyperdrive = [{ binding: "PRODUCTION_DB", id: ID_OTHER }];
    },
    ["hyperdrive"],
  ],
];

// The branches that leave main once it binds the two (each wrangler.jsonc in them is a change from main's, so
// those are previewed only with PREVIEW_ALLOW_INFRA=1).
const AFTER_BINDINGS = {
  "task/T-28-code": { "runtime/src/index.ts": "export default { fetch: () => new Response('T-28') };\n" },
  // A third binding, whose name does not hold "hyperdrive": whatever the list holds is left out.
  "task/T-29-third-binding": {
    "wrangler.jsonc": withBindings((config) => {
      config.env.staging.hyperdrive.push(madeUpBinding("REPORTS", ID_OTHER));
    }),
  },
  ...Object.fromEntries(
    STILL_NAMED.map(([branch, change]) => [branch, { "wrangler.jsonc": withBindings(change) }]),
  ),
};

describe("deploy-preview.sh", () => {
  let fixture;

  before(() => {
    const cleanups = [];
    const t = { after: (fn) => cleanups.push(fn) };
    const dir = tempDir(t, "preview");
    const home = path.join(dir, "home");
    write(path.join(home, ".keep"), "");
    const env = cleanEnv(home);
    const git = (cwd, ...args) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();

    // origin: main plus one branch per entry of BRANCHES.
    const origin = path.join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(dir, "seed");
    git(dir, "init", "-q", "-b", "main", seed);
    for (const script of ["deploy-preview.sh", "lib.sh", "cf.sh"]) copyScript(script, seed);
    write(path.join(seed, "infra", "build", "tool-api-validators.mjs"), FAKE_BUILD);
    write(path.join(seed, CONTRACT), '{ "title": "K-09 v1.5, as the fixture holds it" }\n');
    write(path.join(seed, "wrangler.jsonc"), WRANGLER_JSONC);
    write(path.join(seed, "package.json"), '{ "name": "rosie", "private": true }\n');
    write(
      path.join(seed, "package-lock.json"),
      '{ "name": "rosie", "lockfileVersion": 3, "packages": {} }\n',
    );
    write(path.join(seed, "runtime", "package.json"), '{ "name": "@rosie/runtime" }\n');
    write(path.join(seed, "runtime", "src", "index.ts"), "export default {};\n");
    write(path.join(seed, ".github", "workflows", "ci.yml"), "name: ci\n");
    write(path.join(seed, ".gitignore"), "node_modules/\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "main");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");
    const shas = {};
    for (const [branch, changes] of Object.entries(BRANCHES)) {
      git(seed, "switch", "-q", "-c", branch, "main");
      for (const [file, content] of Object.entries(changes)) {
        if (typeof content === "string") write(path.join(seed, file), content);
        else link(content.link, path.join(seed, file));
      }
      // --force: .gitignore ignores node_modules/ here, as in the repository, and a branch can still commit one.
      git(seed, "add", "-A", "--force");
      git(seed, "commit", "-q", "-m", branch);
      git(seed, "push", "-q", "origin", branch);
      shas[branch] = git(seed, "rev-parse", "HEAD");
      git(seed, "switch", "-q", "main");
    }
    // main moves on after the branches left it: the branches are now behind it in package-lock.json and .github/.
    write(
      path.join(seed, "package-lock.json"),
      '{ "name": "rosie", "lockfileVersion": 3, "packages": { "": {} } }\n',
    );
    write(path.join(seed, ".github", "workflows", "ci.yml"), "name: ci\non: [push, pull_request]\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "main moves on");
    git(seed, "push", "-q", "origin", "main");
    // A branch with no history in common with main.
    git(seed, "switch", "-q", "--orphan", "task/T-9-orphan");
    write(path.join(seed, "runtime", "src", "index.ts"), "export default {};\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "orphan");
    git(seed, "push", "-q", "origin", "task/T-9-orphan");
    git(seed, "switch", "-q", "-f", "main");
    // A path outside printable ASCII that main had when a branch left it and that the branch removes, so it is
    // on the base side of the branch's diff only. main then removes it too: its tip, like the repository's main
    // (DL-456), holds no such path.
    const resume = path.join(seed, "runtime", "src", `r${E_ACUTE}sum${E_ACUTE}.ts`);
    write(resume, "export {};\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "main gains a path outside printable ASCII");
    git(seed, "switch", "-q", "-c", "task/T-26-removes-accented", "main");
    rmSync(resume);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "task/T-26-removes-accented");
    git(seed, "push", "-q", "origin", "task/T-26-removes-accented");
    shas["task/T-26-removes-accented"] = git(seed, "rev-parse", "HEAD");
    git(seed, "switch", "-q", "main");
    rmSync(resume);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "main removes it again");
    git(seed, "push", "-q", "origin", "main");
    // T-1256: main binds HYPERDRIVE_JOB and HYPERDRIVE_APP in env.staging, as T-567 will, and the branches of
    // AFTER_BINDINGS leave it there.
    write(path.join(seed, "wrangler.jsonc"), WITH_BINDINGS);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "main binds two Hyperdrive configurations in env.staging");
    git(seed, "push", "-q", "origin", "main");
    for (const [branch, changes] of Object.entries(AFTER_BINDINGS)) {
      git(seed, "switch", "-q", "-c", branch, "main");
      for (const [file, content] of Object.entries(changes)) write(path.join(seed, file), content);
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", branch);
      git(seed, "push", "-q", "origin", branch);
      shas[branch] = git(seed, "rev-parse", "HEAD");
      git(seed, "switch", "-q", "main");
    }

    // The lead's checkout, with its own (fake) wrangler; fake npm and wrangler first on PATH. The checkout's
    // wrangler records its call as the others do, after it keeps a copy of the config it is given (cf.sh's
    // --config <file>, its first two arguments) beside the run's call log (T-1256).
    const main = path.join(dir, "rosie");
    git(dir, "clone", "-q", origin, main);
    const fake = fakeTools(dir);
    const recordUpload = path.join(dir, "fake", "main-wrangler");
    fake(recordUpload, "main-wrangler");
    write(
      path.join(main, "node_modules", ".bin", "wrangler"),
      [
        "#!/usr/bin/env bash",
        'if [[ "${1:-}" == "--config" && -f "${2:-}" ]]; then cp "$2" "$FAKE_LOG.config"; fi',
        `exec "${recordUpload}" "$@"`,
        "",
      ].join("\n"),
      0o755,
    );
    fake(path.join(dir, "bin", "npm"), "npm");
    fake(path.join(dir, "bin", "wrangler"), "wrangler-on-path");

    let runs = 0;
    const run = (branch, extra = {}) => {
      runs += 1;
      const log = path.join(dir, `calls-${runs}.ndjson`);
      const marker = path.join(dir, `branch-cf-${runs}.txt`);
      const result = spawnSync("bash", [path.join(main, "infra", "scripts", "deploy-preview.sh"), branch], {
        cwd: main,
        encoding: "utf8",
        env: cleanEnv(home, {
          PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
          FAKE_LOG: log,
          BRANCH_CF_MARKER: marker,
          ...extra,
        }),
      });
      const upload = `${log}.config`;
      return {
        ...result,
        calls: readLog(log),
        branchCfRan: existsSync(marker),
        // The config the checkout's wrangler was given, as it was then (the worktree is gone by now), or null.
        upload: existsSync(upload) ? readFileSync(upload, "utf8") : null,
      };
    };
    fixture = { dir, home, main, git, shas, run, cleanup: () => cleanups.forEach((fn) => fn()) };
  });

  after(() => fixture?.cleanup());

  function assertPreviewed(result, branch, slug) {
    assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const npm = result.calls.filter((call) => call.tool === "npm");
    const wrangler = result.calls.filter((call) => call.tool.includes("wrangler"));
    assert.equal(npm.length, 1, "npm ci runs once, in the temporary worktree");
    const tree = npm[0].cwd;
    assert.notEqual(tree, fixture.main, "npm ci never runs in the lead's checkout");
    assert.equal(npm[0].args[0], "ci");
    assert.ok(
      npm[0].args.includes("--ignore-scripts"),
      `npm ci without --ignore-scripts: ${npm[0].args.join(" ")}`,
    );
    assert.deepEqual(
      wrangler.map(({ tool, args, cwd }) => ({ tool, args, cwd })),
      [
        {
          tool: "main-wrangler",
          args: [
            "--config",
            path.join(tree, "wrangler.jsonc"),
            "versions",
            "upload",
            "--env",
            "staging",
            "--preview-alias",
            slug,
            "--var",
            `DB_SCHEMA:preview_${slug.replaceAll("-", "_")}`,
            "--var",
            `GIT_SHA:${fixture.shas[branch]}`,
          ],
          cwd: tree,
        },
      ],
      "one upload, by the lead's checkout's wrangler (through its cf.sh), from the worktree",
    );
    assert.equal(wrangler[0].env.XDG_CONFIG_HOME, path.join(fixture.home, ".config", "rosfield"));
    assert.equal(wrangler[0].env.CLOUDFLARE_ACCOUNT_ID, ROSFIELD_ACCOUNT_ID);
    assert.equal(result.branchCfRan, false, "the branch's cf.sh must never run");
    assert.match(
      result.stdout,
      new RegExp(`Preview URL: https://${slug}-rosie-staging\\.example\\.workers\\.dev`),
    );
    assert.equal(existsSync(tree), false, "the temporary worktree is removed");
    const worktrees = fixture.git(fixture.main, "worktree", "list", "--porcelain").match(/^worktree /gm);
    assert.equal(worktrees?.length, 1, "only the lead's checkout is left as a worktree");
  }

  it("previews a branch that changes only code: npm ci --ignore-scripts, then the checkout's own cf.sh", () => {
    assertPreviewed(fixture.run("task/T-1-code"), "task/T-1-code", "task-t-1-code");
  });

  it("judges a branch by its own changes, not by what main changed after it left (as in a pull request)", () => {
    const behind = fixture.git(
      fixture.main,
      "diff",
      "--name-only",
      "origin/main",
      fixture.shas["task/T-1-code"],
    );
    assert.match(
      behind,
      /package-lock\.json/,
      "the fixture's main changed package-lock.json after T-1 left it",
    );
    assertPreviewed(fixture.run("task/T-1-code"), "task/T-1-code", "task-t-1-code");
  });

  it("refuses a branch with no history in common with origin/main", () => {
    const result = fixture.run("task/T-9-orphan");
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /no history in common/);
    assert.deepEqual(result.calls, []);
  });

  const guarded = [
    ["task/T-2-wrangler", "wrangler.jsonc"],
    ["task/T-3-infra", "infra/scripts/cf.sh"],
    ["task/T-4-package", "package.json"],
    ["task/T-5-lockfile", "package-lock.json"],
    ["task/T-6-github", ".github/workflows/ci.yml"],
    ["task/T-7-workspace-package", "runtime/package.json"],
    ["task/T-8-npmrc", ".npmrc"],
    ["task/T-10-shrinkwrap", "npm-shrinkwrap.json"],
    ["task/T-12-build-script", "infra/build/tool-api-validators.mjs"],
    ["task/T-13-node-modules", "actions/src/tool-api/generated/node_modules/ajv/dist/runtime/equal.js"],
    ["task/T-14-node-modules-link", "actions/src/tool-api/node_modules"],
    ["task/T-15-node-modules-case", "actions/src/tool-api/generated/Node_Modules/ajv/dist/runtime/equal.js"],
    ["task/T-16-package-json-case", "actions/src/tool-api/generated/PACKAGE.JSON"],
    ["task/T-17-npmrc-case", ".NPMRC"],
  ];
  for (const [branch, file] of guarded) {
    it(`refuses ${branch}, whose diff against origin/main touches ${file}, without PREVIEW_ALLOW_INFRA=1`, () => {
      const result = fixture.run(branch);
      assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
      assert.ok(result.stderr.includes(file), `the refusal names ${file}: ${result.stderr}`);
      assert.match(result.stderr, /PREVIEW_ALLOW_INFRA=1/);
      assert.deepEqual(result.calls, [], "nothing is installed or uploaded");
      assert.equal(result.branchCfRan, false);
    });
  }

  // A symbolic link in the branch's diff is refused wherever it is (mode 120000 in git diff --raw, DL-453).
  const LINKS_HEADER = "symbolic links, which could point the build at folders outside its worktree:\n";
  const links = [
    ["task/T-18-generated-link", "actions/src/tool-api/generated"],
    ["task/T-19-file-to-link", "runtime/src/index.ts"],
  ];
  for (const [branch, file] of links) {
    it(`refuses ${branch}, whose diff against origin/main makes ${file} a symbolic link, without PREVIEW_ALLOW_INFRA=1`, () => {
      const result = fixture.run(branch);
      assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
      assert.ok(
        result.stderr.includes(`${LINKS_HEADER}  ${file}\n`),
        `the refusal names ${file} as a link: ${result.stderr}`,
      );
      assert.doesNotMatch(
        result.stderr,
        /touch files that control/,
        "no guarded file changed: the link alone refuses it",
      );
      assert.match(result.stderr, /PREVIEW_ALLOW_INFRA=1/);
      assert.deepEqual(result.calls, [], "nothing is installed, built or uploaded");
      assert.equal(result.branchCfRan, false);
    });
  }

  it("names a link called node_modules both as a guarded file and as a link", () => {
    const result = fixture.run("task/T-14-node-modules-link");
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.ok(
      result.stderr.includes(
        "with the Rosfield sign-in before review:\n  actions/src/tool-api/node_modules\n" +
          `and they add, change or remove ${LINKS_HEADER}  actions/src/tool-api/node_modules\n`,
      ),
      result.stderr,
    );
    assert.deepEqual(result.calls, []);
  });

  it("with PREVIEW_ALLOW_INFRA=1 previews a reviewed link, listing it once", () => {
    const result = fixture.run("task/T-14-node-modules-link", { PREVIEW_ALLOW_INFRA: "1" });
    assertPreviewed(result, "task/T-14-node-modules-link", "task-t-14-node-modules-link");
    assert.match(
      result.stdout,
      /used as reviewed:\n {2}actions\/src\/tool-api\/node_modules\n\[/,
      "the link is listed once, though both checks name it",
    );
  });

  it("with PREVIEW_ALLOW_INFRA=1 previews a reviewed infra change, still with the checkout's cf.sh", () => {
    const result = fixture.run("task/T-3-infra", { PREVIEW_ALLOW_INFRA: "1" });
    assertPreviewed(result, "task/T-3-infra", "task-t-3-infra");
    assert.match(result.stdout + result.stderr, /infra\/scripts\/cf\.sh/, "it lists the reviewed files");
  });

  it("with PREVIEW_ALLOW_INFRA=1, the checkout's cf.sh still refuses a wrangler.jsonc aimed at production", () => {
    const result = fixture.run("task/T-2-wrangler", { PREVIEW_ALLOW_INFRA: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rosie-staging/);
    assert.deepEqual(
      result.calls.filter((call) => call.tool.includes("wrangler")),
      [],
      "wrangler must not start",
    );
  });

  it("refuses PREVIEW_ALLOW_INFRA values other than 1", () => {
    const result = fixture.run("task/T-4-package", { PREVIEW_ALLOW_INFRA: "yes" });
    assert.equal(result.status, 1);
    assert.deepEqual(result.calls, []);
  });

  it("cleans up after itself even when the upload is refused", () => {
    const result = fixture.run("task/T-2-wrangler", { PREVIEW_ALLOW_INFRA: "1" });
    assert.notEqual(result.status, 0);
    const npm = result.calls.find((call) => call.tool === "npm");
    assert.ok(npm, "npm ci ran in a worktree");
    assert.equal(existsSync(npm.cwd), false, "the temporary worktree is removed");
  });

  it("builds the Tool API's validators after npm ci and before the upload, with node and the worktree's guarded build script", () => {
    const result = fixture.run("task/T-1-code");
    assertPreviewed(result, "task/T-1-code", "task-t-1-code");
    assert.deepEqual(
      result.calls.map(({ tool }) => tool),
      ["npm", "tool-api-validators", "main-wrangler"],
      "npm ci, then the build, then the upload; npm runs once, so no npm script ran the build",
    );
    const [install, build, upload] = result.calls;
    const tree = install.cwd;
    assert.equal(build.cwd, tree, "the build runs in the temporary worktree");
    assert.equal(
      build.script,
      path.join(tree, "infra", "build", "tool-api-validators.mjs"),
      "node runs the worktree's infra/ copy (held to origin/main's by the guard), not the lead's checkout's",
    );
    assert.deepEqual(build.args, [], "no --out: the build's own output folder");
    assert.equal(
      build.out,
      path.join(tree, "actions", "src", "tool-api", "generated"),
      "the generated folder beside the worktree's validator.ts",
    );
    assert.equal(upload.cwd, tree, "the upload bundles the same worktree, after the build wrote into it");
    assert.match(result.stdout, /tool-api validators: written to actions\/src\/tool-api\/generated\n/);
  });

  it("stops when the validators' build fails: nothing is migrated or uploaded, and the worktree is removed", () => {
    const result = fixture.run("task/T-11-contract");
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.deepEqual(
      result.calls.map(({ tool }) => tool),
      ["npm", "tool-api-validators"],
      "no upload after the failed build",
    );
    assert.match(result.stdout, /FAIL tool-api validators: /, "the build's own failure is shown");
    assert.ok(
      result.stderr.includes(
        `the Tool API's validators did not build for task/T-11-contract (${fixture.shas["task/T-11-contract"]}):` +
          " nothing was migrated or uploaded",
      ),
      result.stderr,
    );
    assert.doesNotMatch(
      result.stdout,
      /no preview schema was migrated/,
      "it stops before the migration step",
    );
    assert.doesNotMatch(result.stdout, /Preview URL/);
    assert.equal(existsSync(result.calls[0].cwd), false, "the temporary worktree is removed");
    const worktrees = fixture.git(fixture.main, "worktree", "list", "--porcelain").match(/^worktree /gm);
    assert.equal(worktrees?.length, 1, "only the lead's checkout is left as a worktree");
  });

  // A path holding a byte outside printable ASCII (0x20 to 0x7E), on either side of the branch's diff, is refused
  // wherever it is (DL-456). The diff is read NUL-separated, and each path is named whole, quoted as git quotes it.
  const NONASCII_HEADER =
    "paths with characters outside printable ASCII, which this Mac could take for files that control the" +
    " install, the build or the deploy (each quoted as git quotes it):\n";
  const nonascii = [
    [
      "task/T-20-node-modules-long-s",
      String.raw`"actions/src/tool-api/generated/node_module\305\277/ajv/dist/runtime/equal.js"`,
    ],
    ["task/T-21-package-json-kelvin", String.raw`"actions/src/tool-api/generated/pac\342\204\252age.json"`],
    ["task/T-22-accented", String.raw`"runtime/src/caf\303\251.ts"`],
    ["task/T-23-control-characters", String.raw`"runtime/src/a\tb\nc.ts"`],
    ["task/T-26-removes-accented", String.raw`"runtime/src/r\303\251sum\303\251.ts"`],
    ["task/T-27-delete-character", String.raw`"runtime/src/del\177.ts"`],
  ];
  for (const [branch, quoted] of nonascii) {
    it(`refuses ${branch}, whose diff against origin/main touches ${quoted}, without PREVIEW_ALLOW_INFRA=1`, () => {
      assert.equal(
        fixture.git(fixture.main, "diff", "--name-only", `origin/main...${fixture.shas[branch]}`),
        quoted,
        "the branch changes that one path, which git itself shows quoted so",
      );
      const result = fixture.run(branch);
      assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
      assert.ok(
        result.stderr.includes(` add, change or remove ${NONASCII_HEADER}  ${quoted}\nReview them`),
        `the refusal names ${quoted}, whole and quoted, and nothing else: ${result.stderr}`,
      );
      assert.doesNotMatch(
        result.stderr,
        /touch files that control|symbolic links/,
        "no guarded name and no link: the path alone refuses it",
      );
      assert.match(result.stderr, /PREVIEW_ALLOW_INFRA=1/);
      assert.deepEqual(result.calls, [], "nothing is installed, built or uploaded");
      assert.equal(result.branchCfRan, false);
    });
  }

  it("names a guarded path outside printable ASCII in both lists, quoted alike", () => {
    const quoted = String.raw`"infra/scripts/caf\303\251.sh"`;
    const result = fixture.run("task/T-24-guarded-accented");
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.ok(
      result.stderr.includes(
        `with the Rosfield sign-in before review:\n  ${quoted}\n` +
          `and they add, change or remove ${NONASCII_HEADER}  ${quoted}\nReview them`,
      ),
      result.stderr,
    );
    assert.deepEqual(result.calls, []);
  });

  it("with PREVIEW_ALLOW_INFRA=1 previews a reviewed path outside printable ASCII, listing it once, quoted", () => {
    const result = fixture.run("task/T-24-guarded-accented", { PREVIEW_ALLOW_INFRA: "1" });
    assertPreviewed(result, "task/T-24-guarded-accented", "task-t-24-guarded-accented");
    assert.ok(
      result.stdout.includes(`used as reviewed:\n  ${String.raw`"infra/scripts/caf\303\251.sh"`}\n[`),
      `the path is listed once, though both checks name it: ${result.stdout}`,
    );
  });

  it("previews a branch whose new path holds a space and a tilde, the two ends of printable ASCII", () => {
    assertPreviewed(fixture.run("task/T-25-space-tilde"), "task/T-25-space-tilde", "task-t-25-space-tilde");
  });

  it("names such a path quoted even when the lead's git config turns git's own quoting off (core.quotePath)", () => {
    const branch = "task/T-20-node-modules-long-s";
    const quotePathOff = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.quotePath",
      GIT_CONFIG_VALUE_0: "false",
    };
    const shown = execFileSync("git", ["diff", "--name-only", `origin/main...${fixture.shas[branch]}`], {
      cwd: fixture.main,
      env: cleanEnv(fixture.home, quotePathOff),
      encoding: "utf8",
    });
    assert.equal(
      shown,
      `actions/src/tool-api/generated/node_module${LONG_S}/ajv/dist/runtime/equal.js\n`,
      "with that setting, git itself prints the name's bytes as they are",
    );
    const result = fixture.run(branch, quotePathOff);
    assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.ok(
      result.stderr.includes(
        `${NONASCII_HEADER}  ${String.raw`"actions/src/tool-api/generated/node_module\305\277/ajv/dist/runtime/equal.js"`}\n`,
      ),
      result.stderr,
    );
    assert.ok(
      !(result.stdout + result.stderr).includes(LONG_S),
      "no byte of the name reaches the terminal as it is",
    );
    assert.deepEqual(result.calls, [], "nothing is installed, built or uploaded");
  });

  // T-1256 (ADR-014 new task a): the branch's code runs unreviewed on the preview, so the upload's config is the
  // worktree's wrangler.jsonc without env.staging's hyperdrive list, and a config that still names a Hyperdrive
  // binding stops the preview before anything is migrated or uploaded.

  /** The config an upload received, with what it should be: original less env.staging's hyperdrive list. */
  function uploadedConfig(result, original) {
    assert.ok(result.upload, "the checkout's wrangler kept the config it was given");
    const received = parseJsonc(result.upload);
    const expected = structuredClone(original);
    delete expected.env.staging.hyperdrive;
    return { received, expected };
  }

  /** Neither a binding's id nor its local string's password reaches the output. */
  function assertNoValuePrinted(result) {
    for (const value of [ID_JOB, ID_APP, ID_OTHER, MADE_UP_PASSWORD]) {
      assert.equal((result.stdout + result.stderr).includes(value), false, `the output holds ${value}`);
    }
  }

  it("uploads the repository's own wrangler.jsonc without env.staging's hyperdrive list, the rest unchanged", () => {
    // T-1's commit holds the repository's wrangler.jsonc, comments and trailing commas included. Today its
    // env.staging lists no hyperdrive binding; once T-567 binds two there, they are left out as in the next test.
    const result = fixture.run("task/T-1-code");
    assertPreviewed(result, "task/T-1-code", "task-t-1-code");
    const { received, expected } = uploadedConfig(result, parseJsonc(WRANGLER_JSONC));
    assert.equal(
      Object.hasOwn(received.env.staging, "hyperdrive"),
      false,
      "env.staging holds no hyperdrive entry",
    );
    assert.deepEqual(
      received.env.staging,
      expected.env.staging,
      "env.staging, compared whole, less that key",
    );
    assert.deepEqual(received, expected, "and the rest of the file as it was");
  });

  it("with main's env.staging binding HYPERDRIVE_JOB and HYPERDRIVE_APP, a branch that changes only code is uploaded with neither, the rest unchanged", () => {
    const branch = "task/T-28-code";
    assert.equal(
      fixture.git(fixture.main, "show", `${fixture.shas[branch]}:wrangler.jsonc`),
      WITH_BINDINGS.trim(),
      "the branch's commit holds main's wrangler.jsonc",
    );
    const original = parseJsonc(WITH_BINDINGS);
    assert.deepEqual(
      original.env.staging.hyperdrive.map(({ binding }) => binding),
      ["HYPERDRIVE_JOB", "HYPERDRIVE_APP"],
      "main's env.staging binds the two",
    );
    const result = fixture.run(branch);
    assertPreviewed(result, branch, "task-t-28-code");
    const { received, expected } = uploadedConfig(result, original);
    assert.deepEqual(
      received.env.staging,
      expected.env.staging,
      "env.staging, compared whole, less that key",
    );
    assert.deepEqual(received, expected, "and the rest of the file as it was");
    const { env, ...top } = received;
    assert.doesNotMatch(
      JSON.stringify([top, env.staging]),
      /hyperdrive/i,
      "no hyperdrive entry is left at the top level or in env.staging",
    );
    assert.match(
      result.stdout,
      /\] preview: the upload leaves out the hyperdrive list of env\.staging \("HYPERDRIVE_JOB", "HYPERDRIVE_APP"\)\n/,
    );
    assertNoValuePrinted(result);
  });

  it("with PREVIEW_ALLOW_INFRA=1, a reviewed wrangler.jsonc that lists a third binding is uploaded with none of the three", () => {
    const branch = "task/T-29-third-binding";
    const result = fixture.run(branch, { PREVIEW_ALLOW_INFRA: "1" });
    assertPreviewed(result, branch, "task-t-29-third-binding");
    const original = parseJsonc(AFTER_BINDINGS[branch]["wrangler.jsonc"]);
    assert.equal(original.env.staging.hyperdrive.length, 3);
    const { received, expected } = uploadedConfig(result, original);
    assert.deepEqual(received, expected, "the file less env.staging's hyperdrive list");
    assert.match(
      result.stdout,
      /\] preview: the upload leaves out the hyperdrive list of env\.staging \("HYPERDRIVE_JOB", "HYPERDRIVE_APP", "REPORTS"\)\n/,
    );
    assertNoValuePrinted(result);
  });

  for (const [branch, , paths] of STILL_NAMED) {
    it(`stops ${branch} before anything is migrated or uploaded: its wrangler.jsonc still names a Hyperdrive binding at ${paths.join(", ")}`, () => {
      const result = fixture.run(branch, { PREVIEW_ALLOW_INFRA: "1" });
      assert.equal(result.status, 1, `stdout=${result.stdout}\nstderr=${result.stderr}`);
      assert.ok(
        result.stderr.includes(
          `deploy-preview.sh: refusing to upload ${branch} (${fixture.shas[branch]}): its wrangler.jsonc still` +
            " names a Hyperdrive binding once the hyperdrive list of env.staging is left out, at" +
            ` ${paths.join(", ")}. A preview never gets a Hyperdrive binding (ADR-014): nothing was migrated or` +
            " uploaded\n",
        ),
        `the refusal names ${paths.join(", ")} and nothing else: ${result.stderr}`,
      );
      assert.deepEqual(
        result.calls.map(({ tool }) => tool),
        ["npm", "tool-api-validators"],
        "it stops after the build: wrangler never starts",
      );
      assert.equal(result.upload, null, "no config reached wrangler");
      assert.doesNotMatch(
        result.stdout,
        /no preview schema was migrated/,
        "it stops before the migration step",
      );
      assert.doesNotMatch(result.stdout, /Preview URL/);
      assert.equal(existsSync(result.calls[0].cwd), false, "the temporary worktree is removed");
      const worktrees = fixture.git(fixture.main, "worktree", "list", "--porcelain").match(/^worktree /gm);
      assert.equal(worktrees?.length, 1, "only the lead's checkout is left as a worktree");
      assertNoValuePrinted(result);
    });
  }
});

// T-1310 (T-1261's new task b): the staging database's URL reaches migrate.mjs alone, as DATABASE_URL, and no other
// command the preview starts: not git, npm, the build, cf.sh, wrangler or any other. Read as create-staging-hyperdrive.sh
// reads it: one variable, never marked for export, handed to that one process and then dropped. main holds a fake
// migrate.mjs that records its run (never its URL), and a recorder stands in front of every command deploy-preview.sh,
// lib.sh and cf.sh start by name, the checkout's wrangler and npm among them; PATH holds nothing else, so none starts
// unseen. Each recorder keeps a copy of its environment and arguments in a spy folder of the run's own, then runs the
// real command (npm and wrangler: the recorder of script-harness.mjs). Every URL is made up: a .invalid host never
// resolves (RFC 6761), and no such login, password or database exists.
describe("deploy-preview.sh hands the staging database's URL to migrate.mjs alone (T-1310)", () => {
  const STAGING_URL =
    "postgres://t1310_preview_login:t1310-made-up-staging-password@db-t1310-staging.example.invalid:5432/t1310_staging";
  const STAGING_PARTS = [
    "t1310_preview_login",
    "t1310-made-up-staging-password",
    "db-t1310-staging.example.invalid",
    "t1310_staging",
  ];
  const OTHER_URL =
    "postgres://t1310_other_login:t1310-made-up-other-password@db-t1310-other.example.invalid:5432/t1310_other";
  const OTHER_PARTS = [
    "t1310_other_login",
    "t1310-made-up-other-password",
    "db-t1310-other.example.invalid",
    "t1310_other",
  ];
  const CALLER_TEXT = "t1310 made-up caller text";
  const BRANCH = "task/T-1310-code";
  const SLUG = "task-t-1310-code";
  const SCHEMA = "preview_task_t_1310_code";
  // Every command deploy-preview.sh, lib.sh and cf.sh start by name.
  const COMMANDS = ["awk", "basename", "bash", "date", "dirname", "git", "mktemp", "rm", "sed", "tr"];
  // main's infra/scripts/migrate.mjs in the throwaway origin: records its run, its folder and its schema, never a URL.
  const FAKE_MIGRATE = String.raw`import { appendFileSync } from "node:fs";

appendFileSync(
  process.env.FAKE_LOG,
  JSON.stringify({ tool: "migrate", cwd: process.cwd(), schema: process.env.DB_SCHEMA ?? null }) + "\n",
);
console.log("migrate: up to date (the fake migrate.mjs of deploy-preview.test.mjs)");
`;

  let fixture;

  const shellQuoted = (text) => `'${text.replaceAll("'", `'\\''`)}'`;

  /** The real program of that name: the first on this shell's PATH. */
  function program(command) {
    const file = (process.env.PATH ?? "")
      .split(path.delimiter)
      .map((folder) => path.join(folder, command))
      .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    assert.ok(file, `${command} is not on PATH`);
    return file;
  }

  /** A recorder: keeps its environment and its arguments in spy/<name>.<pid>.*, then becomes `command`. */
  function recorder(spy, name, command) {
    const record = `${shellQuoted(path.join(spy, name))}.$$`;
    return [
      "#!/bin/sh",
      `/usr/bin/env >>${record}.env`,
      `printf '%s\\n' \${1+"$@"} >>${record}.argv`,
      `exec ${command.map(shellQuoted).join(" ")} \${1+"$@"}`,
      "",
    ].join("\n");
  }

  before(() => {
    const cleanups = [];
    const t = { after: (fn) => cleanups.push(fn) };
    const dir = tempDir(t, "preview-url");
    const home = path.join(dir, "home");
    write(path.join(home, ".keep"), "");
    const env = cleanEnv(home);
    const git = (cwd, ...args) =>
      execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();

    // origin: main, with the fake build and the fake migrate.mjs, and one branch that changes code alone.
    const origin = path.join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    const seed = path.join(dir, "seed");
    git(dir, "init", "-q", "-b", "main", seed);
    for (const script of ["deploy-preview.sh", "lib.sh", "cf.sh"]) copyScript(script, seed);
    write(path.join(seed, "infra", "scripts", "migrate.mjs"), FAKE_MIGRATE);
    write(path.join(seed, "infra", "build", "tool-api-validators.mjs"), FAKE_BUILD);
    write(path.join(seed, CONTRACT), '{ "title": "K-09 v1.5, as the fixture holds it" }\n');
    write(path.join(seed, "wrangler.jsonc"), WRANGLER_JSONC);
    write(path.join(seed, "package.json"), '{ "name": "rosie", "private": true }\n');
    write(
      path.join(seed, "package-lock.json"),
      '{ "name": "rosie", "lockfileVersion": 3, "packages": {} }\n',
    );
    write(path.join(seed, "runtime", "src", "index.ts"), "export default {};\n");
    write(path.join(seed, ".gitignore"), "node_modules/\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "main");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");
    git(seed, "switch", "-q", "-c", BRANCH);
    write(
      path.join(seed, "runtime", "src", "index.ts"),
      "export default { fetch: () => new Response('T-1310') };\n",
    );
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", BRANCH);
    git(seed, "push", "-q", "origin", BRANCH);
    const sha = git(seed, "rev-parse", "HEAD");

    // The lead's checkout, whose wrangler is a recorder in front of script-harness.mjs's; npm is one too.
    const main = path.join(dir, "rosie");
    git(dir, "clone", "-q", origin, main);
    fakeTools(dir);
    const recordJs = path.join(dir, "fake", "record.cjs");
    let runs = 0;

    /**
     * Runs the checkout's deploy-preview.sh on the branch with the variables given (none of this shell's database or
     * Cloudflare ones), `bash` holding options for bash itself, and `devVars` the checkout's .dev.vars (left out: none).
     * The script's own bash is the real one, named by its path; everything it starts goes through the recorders.
     */
    const run = ({ extra = {}, bash = [], devVars } = {}) => {
      runs += 1;
      const at = (...parts) => path.join(dir, `run-${String(runs)}`, ...parts);
      for (const folder of ["spy", "bin", "tmp"]) mkdirSync(at(folder), { recursive: true });
      write(at("bin", "node"), recorder(at("spy"), "node", [process.execPath]), 0o755);
      write(at("bin", "npm"), recorder(at("spy"), "npm", [process.execPath, recordJs, "npm"]), 0o755);
      for (const command of COMMANDS)
        write(at("bin", command), recorder(at("spy"), command, [program(command)]), 0o755);
      write(
        path.join(main, "node_modules", ".bin", "wrangler"),
        recorder(at("spy"), "wrangler", [process.execPath, recordJs, "main-wrangler"]),
        0o755,
      );
      const dotDevVars = path.join(main, ".dev.vars");
      rmSync(dotDevVars, { force: true });
      if (devVars !== undefined) write(dotDevVars, devVars);
      const log = at("calls.ndjson");
      const result = spawnSync(
        program("bash"),
        [...bash, path.join(main, "infra", "scripts", "deploy-preview.sh"), BRANCH],
        {
          cwd: main,
          encoding: "utf8",
          env: cleanEnv(home, { PATH: at("bin"), TMPDIR: at("tmp"), FAKE_LOG: log, ...extra }),
        },
      );
      const children = readdirSync(at("spy"))
        .filter((file) => file.endsWith(".env"))
        .map((file) => {
          const record = file.slice(0, -".env".length);
          return {
            name: record.split(".")[0],
            argv: readFileSync(at("spy", `${record}.argv`), "utf8"),
            env: readFileSync(at("spy", file), "utf8"),
          };
        });
      return { ...result, output: `${result.stdout}${result.stderr}`, calls: readLog(log), children };
    };
    fixture = { main, git, sha, run, cleanup: () => cleanups.forEach((fn) => fn()) };
  });

  after(() => fixture?.cleanup());

  /** The names of an environment's variables whose value holds one of the texts. */
  function holders(env, texts) {
    const names = new Set();
    let name = "(no variable)";
    for (const line of env.split("\n")) {
      name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] ?? name;
      if (texts.some((text) => line.includes(text))) names.add(name);
    }
    return [...names].sort();
  }

  const isMigrate = (child) =>
    child.name === "node" && child.argv.split("\n")[0] === "infra/scripts/migrate.mjs";

  /**
   * Fails unless the run previewed the branch, migrate.mjs ran once in the worktree with DATABASE_URL the staging URL
   * and the branch's schema, no other command holds any part of a URL (or of `others`) or a variable of a database
   * URL's name, no command's arguments hold any part of either (T-1343), and the output holds no part of either URL.
   */
  function assertUrlToMigrateAlone(result, what, others = []) {
    for (const child of result.children) {
      assert.equal(
        [...STAGING_PARTS, ...OTHER_PARTS, ...others].some((text) => child.argv.includes(text)),
        false,
        `${what}, ${child.name}: an argument holds a part of a URL`,
      );
    }
    assert.equal(result.status, 0, `${what}: exit ${String(result.status)}`);
    assert.deepEqual(
      result.calls.map(({ tool }) => tool),
      ["npm", "tool-api-validators", "migrate", "main-wrangler"],
      `${what}: npm ci, the build, the migration, then the upload`,
    );
    const [install, , migration] = result.calls;
    assert.deepEqual(
      migration,
      { tool: "migrate", cwd: install.cwd, schema: SCHEMA },
      `${what}: the migration`,
    );
    const migrations = result.children.filter(isMigrate);
    assert.equal(migrations.length, 1, `${what}: migrate.mjs was recorded once`);
    const lines = migrations[0].env.split("\n");
    assert.deepEqual(
      holders(migrations[0].env, [...STAGING_PARTS, ...OTHER_PARTS, ...others]),
      ["DATABASE_URL"],
      `${what}: migrate.mjs holds the URL in DATABASE_URL alone`,
    );
    assert.ok(
      lines.includes(`DATABASE_URL=${STAGING_URL}`),
      `${what}: migrate.mjs's DATABASE_URL is not the URL`,
    );
    assert.ok(lines.includes(`DB_SCHEMA=${SCHEMA}`), `${what}: migrate.mjs's schema`);
    assert.equal(
      lines.some((line) => line.startsWith("STAGING_DATABASE_URL=")),
      false,
      `${what}: migrate.mjs has STAGING_DATABASE_URL`,
    );
    const rest = result.children.filter((child) => !isMigrate(child));
    for (const child of rest) {
      const which = `${what}, ${child.name}`;
      assert.deepEqual(
        holders(child.env, [...STAGING_PARTS, ...OTHER_PARTS, ...others]),
        [],
        `${which}: a variable of its environment holds a part of a URL`,
      );
      assert.deepEqual(
        ["STAGING_DATABASE_URL", "DATABASE_URL"].filter((name) =>
          child.env.split("\n").some((line) => line.startsWith(`${name}=`)),
        ),
        [],
        `${which}: a database URL's name is in its environment`,
      );
    }
    const seen = new Set(rest.map((child) => child.name));
    for (const name of [
      "git",
      "npm",
      "node",
      "bash",
      "wrangler",
      "date",
      "dirname",
      "mktemp",
      "rm",
      "sed",
      "tr",
    ]) {
      assert.ok(seen.has(name), `${what}: no ${name} was recorded`);
    }
    for (const part of [...STAGING_PARTS, ...OTHER_PARTS, ...others]) {
      assert.equal(result.output.includes(part), false, `${what}: the output holds a part of a URL`);
    }
    assert.match(
      result.stdout,
      new RegExp(`Preview URL: https://${SLUG}-rosie-staging\\.example\\.workers\\.dev`),
    );
  }

  it("from the caller's environment, beside a DATABASE_URL of the caller's naming another database: migrate.mjs alone gets the staging one", () => {
    const result = fixture.run({ extra: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_URL: OTHER_URL } });
    assertUrlToMigrateAlone(result, "from the environment");
    assert.match(result.stdout, new RegExp(`\\] preview: migrate schema ${SCHEMA}\\n`));
  });

  it("from the checkout's .dev.vars, read by name at step 4: migrate.mjs alone gets it", () => {
    for (const line of [
      `STAGING_DATABASE_URL=${STAGING_URL}`,
      `  export STAGING_DATABASE_URL="${STAGING_URL}"`,
    ]) {
      const result = fixture.run({ devVars: `# made up\n${line}\n` });
      assertUrlToMigrateAlone(result, `.dev.vars line ${line.replace(STAGING_URL, "<url>")}`);
    }
  });

  it("allexport and keyword from the caller, and a caller's variable of the script's own name: still migrate.mjs alone", () => {
    for (const [what, extra, bash] of [
      ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, []],
      ["bash -a -k", {}, ["-a", "-k"]],
      ["SHELLOPTS=allexport:keyword", { SHELLOPTS: "allexport:keyword" }, []],
      ["the caller's database_url", { database_url: CALLER_TEXT }, []],
      [
        "the caller's database_url under allexport",
        { database_url: CALLER_TEXT, SHELLOPTS: "allexport" },
        [],
      ],
    ]) {
      const result = fixture.run({ extra: { STAGING_DATABASE_URL: STAGING_URL, ...extra }, bash });
      assertUrlToMigrateAlone(result, what, [CALLER_TEXT]);
    }
    const fromFile = fixture.run({
      extra: { SHELLOPTS: "allexport" },
      devVars: `STAGING_DATABASE_URL=${STAGING_URL}\n`,
    });
    assertUrlToMigrateAlone(fromFile, "SHELLOPTS=allexport, the URL from .dev.vars");
  });

  it("tracing from the caller (bash -x, or handed down in SHELLOPTS) prints no part of the URL: the script switches it off first", () => {
    for (const [what, extra, bash] of [
      ["bash -x", {}, ["-x"]],
      ["SHELLOPTS=xtrace", { SHELLOPTS: "xtrace" }, []],
    ]) {
      const result = fixture.run({ extra: { STAGING_DATABASE_URL: STAGING_URL, ...extra }, bash });
      assertUrlToMigrateAlone(result, what);
      assert.ok(
        result.stderr.startsWith("+ set +x\n"),
        `${what}: the trace does not begin at the script's set +x`,
      );
      assert.equal(result.stderr, "+ set +x\n", `${what}: the trace went on after set +x`);
    }
  });

  it("with no staging URL, a DATABASE_URL of the caller's reaches no command, and nothing is migrated", () => {
    const result = fixture.run({ extra: { DATABASE_URL: OTHER_URL } });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(
      result.calls.map(({ tool }) => tool),
      ["npm", "tool-api-validators", "main-wrangler"],
    );
    assert.match(
      result.stdout,
      /preview: NOTICE: STAGING_DATABASE_URL is not set, so no preview schema was migrated/,
    );
    assert.equal(result.children.filter(isMigrate).length, 0);
    for (const child of result.children) {
      assert.deepEqual(
        holders(child.env, OTHER_PARTS),
        [],
        `${child.name}: a variable holds a part of the URL`,
      );
      assert.equal(
        OTHER_PARTS.some((part) => child.argv.includes(part)),
        false,
        `${child.name}: an argument holds a part of the URL (T-1343)`,
      );
      assert.equal(
        child.env.split("\n").some((line) => line.startsWith("DATABASE_URL=")),
        false,
        `${child.name}: DATABASE_URL is in its environment`,
      );
    }
    for (const part of OTHER_PARTS) assert.equal(result.output.includes(part), false);
  });

  it("the recorders see what a command is given: the migration's DATABASE_URL is recorded (the control for the checks above)", () => {
    const result = fixture.run({ extra: { STAGING_DATABASE_URL: STAGING_URL } });
    assert.equal(result.status, 0, result.output);
    const recorded = result.children.filter((child) => holders(child.env, STAGING_PARTS).length > 0);
    assert.deepEqual(
      recorded.map((child) => child.name),
      ["node"],
      "one command holds the URL: migrate.mjs's node",
    );
  });

  // T-1349 (T-1343's security review, new task b): a DATABASE_REPLICA_URL in the caller's environment (db/repo/client.ts
  // reads it) leaves the script's environment before anything is started, as STAGING_DATABASE_URL and DATABASE_URL do:
  // no command the preview starts gets it, migrate.mjs and the branch's install and build included. Made up, as the
  // other URLs.
  const REPLICA_URL =
    "postgres://t1349_replica_login:t1349-made-up-replica-password@db-t1349-replica.example.invalid:5432/t1349_replica";
  const REPLICA_PARTS = [
    "t1349_replica_login",
    "t1349-made-up-replica-password",
    "db-t1349-replica.example.invalid",
    "t1349_replica",
  ];

  it("a DATABASE_REPLICA_URL of the caller's reaches no command, in its environment or its arguments, under allexport, bash -a -k or bash -x (T-1349)", () => {
    for (const [what, extra, bash] of [
      ["no option", {}, []],
      ["SHELLOPTS=allexport", { SHELLOPTS: "allexport" }, []],
      ["bash -a -k", {}, ["-a", "-k"]],
      ["bash -x", {}, ["-x"]],
    ]) {
      const result = fixture.run({
        extra: { STAGING_DATABASE_URL: STAGING_URL, DATABASE_REPLICA_URL: REPLICA_URL, ...extra },
        bash,
      });
      assertUrlToMigrateAlone(result, what, REPLICA_PARTS);
      for (const child of result.children) {
        assert.equal(
          child.env.split("\n").some((line) => line.startsWith("DATABASE_REPLICA_URL=")),
          false,
          `${what}, ${child.name}: DATABASE_REPLICA_URL is in its environment`,
        );
      }
      if (bash.includes("-x")) {
        assert.equal(result.stderr, "+ set +x\n", `${what}: the trace went on after set +x`);
      }
    }
  });

  it("a recorder keeps a DATABASE_REPLICA_URL in a command's environment or arguments, and the checks find it (the control for T-1349's checks)", (t) => {
    const dir = tempDir(t, "preview-replica-control");
    const spy = path.join(dir, "spy");
    mkdirSync(spy);
    write(path.join(dir, "bin", "date"), recorder(spy, "date", [program("date")]), 0o755);
    spawnSync(path.join(dir, "bin", "date"), ["-u", `/made-up/${REPLICA_URL}`], {
      env: { PATH: path.join(dir, "bin"), DATABASE_REPLICA_URL: REPLICA_URL },
      encoding: "utf8",
    });
    const [record] = readdirSync(spy)
      .filter((file) => file.endsWith(".env"))
      .map((file) => file.slice(0, -".env".length));
    const env = readFileSync(path.join(spy, `${record}.env`), "utf8");
    const argv = readFileSync(path.join(spy, `${record}.argv`), "utf8");
    assert.deepEqual(holders(env, REPLICA_PARTS), ["DATABASE_REPLICA_URL"]);
    assert.ok(
      env.split("\n").some((line) => line.startsWith("DATABASE_REPLICA_URL=")),
      "the name is recorded",
    );
    assert.equal(
      REPLICA_PARTS.some((part) => argv.includes(part)),
      true,
      "an argument holding the URL is recorded",
    );
  });
});

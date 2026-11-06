// Tests for the D-000 PreToolUse guard hook (factory spec section 9).
// Run with:  node --test infra/ci/guard.test.mjs
//
// The hook is located through GUARD_PATH, defaulting to the installed hook at
// <repo>/.claude/hooks/guard.mjs (this file lives at infra/ci/). Before the lead
// copies the hook into .claude/, run the suite against the scratch copy:
//   GUARD_PATH=.../scratch/factory/claude/hooks/guard.mjs \
//     node --test .../scratch/factory/infra/ci/guard.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const GUARD = process.env.GUARD_PATH || path.join(repoRoot, ".claude", "hooks", "guard.mjs");

assert.ok(fs.existsSync(GUARD), `guard hook not found at ${GUARD} (set GUARD_PATH)`);

const HANDOVER = "/Users/aryamahadik/Downloads/Rosfield_Main/Rosfield Main Handover";

function run(payload, extraEnv = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const res = spawnSync(process.execPath, [GUARD], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    timeout: 10000,
  });
  return res;
}

const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

// Each row: [name, payload, env?]
const BLOCKED = [
  // rule 4: production deploys
  ["wrangler deploy (raw)", bash("npx wrangler deploy")],
  ["wrangler deploy (bare bin)", bash("wrangler deploy")],
  ["wrangler deploy --env production", bash("npx wrangler deploy --env production")],
  ["wrangler deploy --env=production", bash("wrangler deploy --env=production")],
  ["wrangler versions deploy", bash("npx wrangler versions deploy")],
  ["wrangler rollback (no env)", bash("npx wrangler rollback")],
  ["wrangler secret put", bash("npx wrangler secret put API_KEY")],
  ["wrangler secret bulk", bash("npx wrangler secret bulk secrets.json")],
  ["wrangler via CLOUDFLARE_ENV=production", bash("CLOUDFLARE_ENV=production npx wrangler deploy")],
  ["cf.sh deploy --env production", bash("infra/scripts/cf.sh deploy --env production")],
  ["npm run deploy:production", bash("npm run deploy:production")],
  ["compound deploy", bash("cd runtime && npx wrangler deploy")],
  ["gh workflow run staging.yml", bash("gh workflow run staging.yml")],
  ["gh workflow run ci.yml with field", bash("gh workflow run ci.yml -f x=y")],
  ["gh workflow run production", bash("gh workflow run production-deploy.yml")],
  ["gh workflow run rollback.yml (DL-024: merge-check.yml only)", bash("gh workflow run rollback.yml")],
  [
    "gh workflow run rollback.yml with fields",
    bash("gh workflow run rollback.yml -f version_id=x -f reason=y"),
  ],

  // rule 4: the cf.sh wrapper is read exactly like wrangler (npm run cf, infra/scripts/cf.sh, bash cf.sh)
  ["npm run cf -- --name (the production Worker)", bash("npm run cf -- deploy --env staging --name rosie")],
  ["npm run cf -- --name=", bash("npm run cf -- deploy --env staging --name=rosie")],
  ["npm run cf -- --config", bash("npm run cf -- versions upload --env staging --config other.jsonc")],
  ["npm run cf -- --config=", bash("npm run cf -- deploy --env staging --config=other.jsonc")],
  ["npm run cf -- -c", bash("npm run cf -- deploy --env staging -c other.jsonc")],
  ["npm run cf -- -c=", bash("npm run cf -- deploy --env staging -c=other.jsonc")],
  ["npm run cf -- -c in combined short options", bash("npm run cf -- deploy --env staging -yc other.jsonc")],
  ["npm run cf -- --cwd", bash("npm run cf -- deploy --env staging --cwd ../other")],
  ["npm run cf -- --env-file", bash("npm run cf -- deploy --env staging --env-file override.env")],
  ["npm run cf -- --x-new-config", bash("npm run cf -- deploy --env staging --x-new-config")],
  ["npm run cf -- --route", bash("npm run cf -- deploy --env staging --route 'rosfield.com/*'")],
  ["npm run cf -- --worker-name", bash("npm run cf -- preview --env staging --worker-name rosie")],
  ["npm run cf -- --env production", bash("npm run cf -- deploy --env production")],
  ["npm run cf -- --env other than staging", bash("npm run cf -- tail --env preview")],
  ["npm run cf -- -e= other than staging", bash("npm run cf -- deployments status -e=prod")],
  ["npm run cf -- --env= (the top level)", bash("npm run cf -- deploy --env=")],
  ["npm run cf -- delete", bash("npm run cf -- delete")],
  ["npm run cf -- delete --env staging", bash("npm run cf -- delete --env staging")],
  ["npm run cf -- deploy (no env)", bash("npm run cf -- deploy")],
  ["npm run cf -- versions upload (no env)", bash("npm run cf -- versions upload --preview-alias p")],
  ["npm run cf -- versions deploy (no env)", bash("npm run cf -- versions deploy")],
  ["npm run cf -- rollback (no env)", bash("npm run cf -- rollback 0d3b0f6e --yes")],
  ["npm run cf -- secret put (no env)", bash("npm run cf -- secret put KEY")],
  ["npm run cf -- preview (no env)", bash("npm run cf -- preview")],
  ["npm run cf without --", bash("npm run cf deploy")],
  ["npm run cf without -- with --name", bash("npm run cf deploy --env staging --name rosie")],
  ["npm run -s cf (an npm flag first)", bash("npm run -s cf -- deploy")],
  ["infra/scripts/cf.sh --name", bash("infra/scripts/cf.sh deploy --env staging --name rosie")],
  ["./infra/scripts/cf.sh rollback (no env)", bash("./infra/scripts/cf.sh rollback 0d3b0f6e")],
  ["bash infra/scripts/cf.sh --name", bash("bash infra/scripts/cf.sh deploy --env staging --name rosie")],
  ["bash infra/scripts/cf.sh deploy (no env)", bash("bash infra/scripts/cf.sh deploy")],
  ["bash infra/scripts/cf.sh -c", bash("bash infra/scripts/cf.sh versions upload --env staging -c x.jsonc")],
  ["npm run cf after cd &&", bash("cd /Users/x/rosie && npm run cf -- deploy --env staging --name rosie")],
  ["npm run cf inside bash -c", bash("bash -c 'npm run cf -- deploy --env staging --name rosie'")],
  ["wrangler inside sh -c", bash('sh -c "npx wrangler deploy"')],

  // rule 4: wrangler itself gets the same checks
  ["wrangler --name", bash("npx wrangler deploy --env staging --name rosie")],
  ["wrangler --config", bash("npx wrangler versions upload --env staging --config other.jsonc")],
  ["wrangler -c", bash("npx wrangler deploy --env staging -c other.jsonc")],
  ["wrangler delete", bash("npx wrangler delete --env staging")],
  ["wrangler versions upload (no env)", bash("npx wrangler versions upload")],
  ["wrangler secret list (no env)", bash("npx wrangler secret list")],
  ["wrangler --env other than staging", bash("npx wrangler tail --env prod")],
  ["node_modules/.bin/wrangler deploy", bash("./node_modules/.bin/wrangler deploy")],
  ["npx wrangler@4 deploy", bash("npx wrangler@4 deploy")],

  // rule 4: WRANGLER_CI_OVERRIDE_NAME (Wrangler's Worker-name override), however it is set
  [
    "WRANGLER_CI_OVERRIDE_NAME= npm run cf",
    bash("WRANGLER_CI_OVERRIDE_NAME=rosie npm run cf -- deploy --env staging"),
  ],
  [
    "export WRANGLER_CI_OVERRIDE_NAME then deploy",
    bash("export WRANGLER_CI_OVERRIDE_NAME=rosie && npm run deploy:staging"),
  ],
  [
    "env WRANGLER_CI_OVERRIDE_NAME= npm run deploy:preview",
    bash("env WRANGLER_CI_OVERRIDE_NAME=rosie npm run deploy:preview -- task/T-1"),
  ],
  [
    "WRANGLER_CI_OVERRIDE_NAME= wrangler",
    bash("WRANGLER_CI_OVERRIDE_NAME=rosie npx wrangler deploy --env staging"),
  ],
  [
    "WRANGLER_CI_OVERRIDE_NAME written into a shell profile",
    bash("echo 'export WRANGLER_CI_OVERRIDE_NAME=rosie' >> ~/.zshrc"),
  ],
  ["CLOUDFLARE_ENV=production npm run cf", bash("CLOUDFLARE_ENV=production npm run cf -- tail")],
  ["another WRANGLER_*_NAME override", bash("WRANGLER_CI_FUTURE_NAME=rosie npm run deploy:staging")],

  // rule 3: push to main / master
  ["push origin main", bash("git push origin main")],
  ["push origin master", bash("git push origin master")],
  ["push HEAD:main", bash("git push origin HEAD:main")],
  ["push +main (forced refspec)", bash("git push origin +main")],
  ["push main:refs/heads/main", bash("git push origin main:refs/heads/main")],
  ["push --all", bash("git push --all")],
  ["push --mirror", bash("git push --mirror origin")],
  ["force push main", bash("git push -f origin main")],
  ["force-with-lease main", bash("git push --force-with-lease origin main")],
  ["force push non-task branch", bash("git push --force origin feature/x")],
  ["compound push main", bash("cd /tmp && git push origin main")],
  ["bare push while on main", bash("git push"), { GUARD_CURRENT_BRANCH: "main" }],
  ["push HEAD while on main", bash("git push origin HEAD"), { GUARD_CURRENT_BRANCH: "main" }],
  ["git -C with push main", bash("git -C . push origin main")],

  // rule 2: secret/key files and environment dumps
  ["read .dev.vars (tool)", { tool_name: "Read", tool_input: { file_path: "/Users/x/rosie/.dev.vars" } }],
  ["cat .dev.vars", bash("cat .dev.vars")],
  ["cat quoted .dev.vars", bash('cat ".dev.vars"')],
  ["grep .env", bash("grep x .env")],
  [
    "read .env.staging (tool)",
    { tool_name: "Read", tool_input: { file_path: "/Users/x/rosie/.env.staging" } },
  ],
  [
    "edit .env (tool)",
    { tool_name: "Edit", tool_input: { file_path: "/Users/x/rosie/.env", old_string: "a", new_string: "b" } },
  ],
  ["cat ssh key", bash("cat ~/.ssh/id_rsa")],
  ["read .pem (tool)", { tool_name: "Read", tool_input: { file_path: "/Users/x/certs/server.pem" } }],
  ["read config/rosfield", bash('cat "/Users/x/.config/rosfield/config"')],
  ["printenv", bash("printenv")],
  ["bare env", bash("env")],
  ["bare set", bash("set")],
  ["export -p", bash("export -p")],
  ["cat /proc/self/environ", bash("cat /proc/self/environ")],

  // rule 1: writes into the handover folder
  [
    "write handover (tool)",
    { tool_name: "Write", tool_input: { file_path: `${HANDOVER}/x.md`, content: "y" } },
  ],
  [
    "edit handover (tool)",
    {
      tool_name: "Edit",
      tool_input: {
        file_path: `${HANDOVER}/3 Build Plan Prompt for Claude.md`,
        old_string: "a",
        new_string: "b",
      },
    },
  ],
  [
    "notebookedit handover (tool)",
    { tool_name: "NotebookEdit", tool_input: { notebook_path: `${HANDOVER}/n.ipynb` } },
  ],
  ["rm handover with spaces", bash(`rm "${HANDOVER}/note.md"`)],
  ["redirect into handover", bash(`echo hi > "${HANDOVER}/note.md"`)],
  ["cp into handover", bash(`cp a.txt "${HANDOVER}/b.txt"`)],
  ["tee into handover", bash(`echo hi | tee "${HANDOVER}/note.md"`)],
  ["sed -i handover", bash(`sed -i '' s/a/b/ "${HANDOVER}/x.md"`)],
  ["mv out of handover", bash(`mv "${HANDOVER}/0 START HERE.md" /tmp/x`)],
  ["mv into handover", bash(`mv notes.md "${HANDOVER}/notes.md"`)],
  ["mv within handover", bash(`mv -f "${HANDOVER}/a.md" "${HANDOVER}/b.md"`)],
  [
    "rsync --remove-source-files from handover",
    bash(`rsync -a --remove-source-files "${HANDOVER}/" scratch/x/`),
  ],
  [
    "rsync abbreviated --remove-source from handover",
    bash(`rsync -a --remove-source "${HANDOVER}/" scratch/x/`),
  ],
  ["rsync --remove-sent-files from handover", bash(`rsync -a --remove-sent-files "${HANDOVER}/x.md" /tmp/`)],
  ["rsync into handover", bash(`rsync -a src/ "${HANDOVER}/"`)],
  ["ln into handover", bash(`ln -s /tmp/x "${HANDOVER}/link"`)],

  // rule 5: fork
  ["Agent fork", { tool_name: "Agent", tool_input: { subagent_type: "fork", prompt: "p" } }],
  ["Task fork", { tool_name: "Task", tool_input: { subagent_type: "fork", prompt: "p" } }],
];

const ALLOWED = [
  // deploys that the hook permits (npm scripts, staging)
  ["npm run deploy:staging", bash("npm run deploy:staging")],
  ["npm run deploy:preview", bash("npm run deploy:preview task/T-1")],
  ["wrangler deploy --env staging", bash("npx wrangler deploy --env staging")],
  ["wrangler versions deploy --env staging", bash("npx wrangler versions deploy --env staging")],
  [
    "wrangler versions upload staging",
    bash("npx wrangler versions upload --env staging --preview-alias p --var GIT_SHA:abc"),
  ],
  ["wrangler secret put --env staging", bash("npx wrangler secret put X --env staging")],
  ["wrangler tail --env staging", bash("npx wrangler tail --env staging")],
  ["gh workflow run merge-check.yml", bash("gh workflow run merge-check.yml -f branch=task/T-1")],
  ["npm run rollback:staging", bash("npm run rollback:staging")],
  ["npm run preview:cleanup", bash("npm run preview:cleanup -- task/T-1")],
  ["npm run check:staging", bash("npm run check:staging -- https://rosie-staging.example.workers.dev/test")],
  [
    "PREVIEW_ALLOW_INFRA=1 npm run deploy:preview (the lead, after review)",
    bash("PREVIEW_ALLOW_INFRA=1 npm run deploy:preview -- task/T-1"),
  ],
  ["wrangler dev --env staging", bash("npx wrangler dev --env staging")],

  // the cf.sh wrapper, as the scripts and the lead use it
  ["npm run cf -- deploy --env staging", bash("npm run cf -- deploy --env staging --var GIT_SHA:abc")],
  [
    "npm run cf -- versions upload --env staging (a preview)",
    bash(
      "npm run cf -- versions upload --env staging --preview-alias task-t-1 --var DB_SCHEMA:preview_task_t_1",
    ),
  ],
  ["npm run cf -- deployments status", bash("npm run cf -- deployments status --env staging --json")],
  [
    "npm run cf -- rollback --env staging with a message",
    bash("npm run cf -- rollback 0d3b0f6e --env staging --message 'staging deploy of abc failed' --yes"),
  ],
  ["npm run cf -- whoami", bash("npm run cf -- whoami")],
  ["npm run cf -- tail --env staging", bash("npm run cf -- tail --env staging")],
  ["npm run cf -- -e staging before the command", bash("npm run cf -- -e staging deploy")],
  [
    "bash infra/scripts/cf.sh versions view",
    bash("bash infra/scripts/cf.sh versions view 0d3b0f6e --env staging --json"),
  ],
  ["infra/scripts/cf.sh secret list --env staging", bash("infra/scripts/cf.sh secret list --env staging")],
  ["bash -lc with a staging deploy", bash('bash -lc "npm run cf -- deploy --env staging"')],
  ["reading cf.sh", bash("cat infra/scripts/cf.sh")],
  ["syntax-checking cf.sh", bash("bash -n infra/scripts/cf.sh")],
  [
    "grep for the override variable (no assignment)",
    bash("grep -rn WRANGLER_CI_OVERRIDE_NAME infra/scripts"),
  ],
  [
    "commit message naming the override and --name",
    bash('git commit -m "cf.sh refuses WRANGLER_CI_OVERRIDE_NAME and --name"'),
  ],
  ["commit message naming wrangler deploy", bash('git commit -m "npx wrangler deploy needs --env staging"')],

  // pushes the hook permits
  ["push origin task branch", bash("git push origin task/T-001")],
  ["push HEAD:task branch", bash("git push origin HEAD:task/T-1")],
  ["push origin train branch", bash("git push origin train/2026-11-05-w1")],
  ["push -u task branch", bash("git push -u origin task/T-9")],
  ["force push task branch", bash("git push --force origin task/T-2")],
  ["force-with-lease task branch (rebase step)", bash("git push --force-with-lease origin task/T-2")],
  ["bare push while on task branch", bash("git push"), { GUARD_CURRENT_BRANCH: "task/T-1" }],

  // normal git / tools
  ["git status", bash("git status")],
  ["git commit", bash('git commit -m "done"')],
  ["git commit mentioning push main", bash('git commit -m "push to main later"')],
  ["git switch", bash("git switch task/T-1")],

  // reads / normal writes
  ["read README (tool)", { tool_name: "Read", tool_input: { file_path: "/Users/x/rosie/README.md" } }],
  ["cat README", bash("cat README.md")],
  ["grep -r in src", bash("grep -r foo src")],
  [
    "write a normal repo file",
    { tool_name: "Write", tool_input: { file_path: "/Users/x/rosie/runtime/src/index.ts", content: "x" } },
  ],
  [
    "read handover file (tool)",
    { tool_name: "Read", tool_input: { file_path: `${HANDOVER}/0 START HERE.md` } },
  ],
  ["cat handover file (read)", bash(`cat "${HANDOVER}/0 START HERE.md"`)],
  ["cp FROM handover to scratch", bash(`cp -R "${HANDOVER}/1 Business Rules" scratch/master-copy/`)],
  [
    "rsync FROM handover to scratch (plain)",
    bash(`rsync -a "${HANDOVER}/1 Business Rules/" scratch/master-copy/`),
  ],
  ["ln -s FROM handover", bash(`ln -s "${HANDOVER}/0 START HERE.md" scratch/start-here.md`)],
  ["cat handover with stderr redirect", bash(`cat "${HANDOVER}/0 START HERE.md" 2>/dev/null`)],
  ["mv outside handover", bash("mv scratch/a.txt scratch/b.txt")],
  [
    "rsync --remove-source-files outside handover",
    bash("rsync -a --remove-source-files scratch/in/ scratch/out/"),
  ],

  // false-positive guards
  ["env with assignment", bash("env FOO=bar npm run build")],
  ["set with flags", bash("set -euo pipefail")],
  ["grep -e production", bash("grep -e production notes.txt")],
  ["echo production word", bash("echo deploying to production environment soon")],
  ["sed -i outside handover", bash("sed -i '' s/a/b/ runtime/src/x.ts")],
  ["node on master copy script", bash("node scratch/master-copy/engine/work/build/step.js")],
  ["docker compose up", bash("docker compose -f infra/docker-compose.yml up -d")],
  ["npm test", bash("npm test")],
  ["date", bash("date -u +%s")],

  // non-fork subagents
  [
    "Agent general-purpose",
    { tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "p" } },
  ],
  ["Agent architect", { tool_name: "Agent", tool_input: { subagent_type: "architect", prompt: "p" } }],
  [
    "Agent forklift (not fork)",
    { tool_name: "Agent", tool_input: { subagent_type: "forklift", prompt: "p" } },
  ],
];

const FAIL_OPEN = [
  ["empty stdin", ""],
  ["invalid json", "this is not json"],
  ["json array not object", "[]"],
];

test("blocked calls exit 2 with a stderr reason", async (t) => {
  for (const [name, payload, env] of BLOCKED) {
    await t.test(name, () => {
      const res = run(payload, env);
      assert.equal(res.status, 2, `expected exit 2, got ${res.status}; stderr=${res.stderr}`);
      assert.ok(res.stderr && res.stderr.trim().length > 0, "expected a one-line reason on stderr");
      assert.equal(res.stdout, "", "the guard must never write to stdout");
    });
  }
});

test("allowed calls exit 0 with no output", async (t) => {
  for (const [name, payload, env] of ALLOWED) {
    await t.test(name, () => {
      const res = run(payload, env);
      assert.equal(res.status, 0, `expected exit 0, got ${res.status}; stderr=${res.stderr}`);
      assert.equal(res.stdout, "", "the guard must never write to stdout");
    });
  }
});

test("unparseable input fails open (exit 0 with a stderr note)", async (t) => {
  for (const [name, payload] of FAIL_OPEN) {
    await t.test(name, () => {
      const res = run(payload);
      assert.equal(res.status, 0, `expected exit 0 (fail open), got ${res.status}`);
      assert.equal(res.stdout, "", "the guard must never write to stdout");
    });
  }
});

test("the five D-000 check-2 attempts are each blocked (spec 5.9#2)", async (t) => {
  const five = {
    "production deploy": bash("npx wrangler deploy"),
    "push to main": bash("git push origin main"),
    "read .dev.vars": { tool_name: "Read", tool_input: { file_path: "/Users/x/rosie/.dev.vars" } },
    "write into the handover folder": {
      tool_name: "Write",
      tool_input: { file_path: `${HANDOVER}/x.md`, content: "y" },
    },
    "start a fork": { tool_name: "Agent", tool_input: { subagent_type: "fork", prompt: "p" } },
  };
  for (const [name, payload] of Object.entries(five)) {
    await t.test(name, () => {
      assert.equal(run(payload).status, 2);
    });
  }
});

test("coverage: at least 40 blocked-or-allowed cases", () => {
  assert.ok(BLOCKED.length + ALLOWED.length >= 40, `only ${BLOCKED.length + ALLOWED.length} cases`);
});

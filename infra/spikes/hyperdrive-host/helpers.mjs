// Spike T-1124: the small pieces run.sh needs from node, each a function that probe.test.mjs checks.
//   node helpers.mjs row <name>        stdin: the text of `wrangler hyperdrive list`; prints "<id><tab><caching>" for
//                                      the configuration of that name, or nothing; exit 2 unreadable, 3 two of a name
//   node helpers.mjs host-kind         PROBE_URL in the environment; prints "pooled" or "direct"; exit 2 when it is
//                                      not a postgres:// URL. Never prints the URL.
//   node helpers.mjs config <file> <main> <account> <local|remote> <id> <local url>   writes the spike's wrangler config
//   node helpers.mjs token             prints a random token for one run
//   node helpers.mjs verdict <file>    exit 0 when the probe's result says ok and its schema is dropped
//   node helpers.mjs live-version      stdin: the text of `wrangler deployments status --json`; prints the id of the
//                                      version that serves the most traffic, or nothing
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";

// The `hyperdrive list` parser moved to infra/scripts/hyperdrive-list.mjs (ADR-014; T-1252): one parser for the spike,
// the create script and T-1093's check. `row` below still prints only the id and the caching cell.
import { hyperdriveRow } from "../../scripts/hyperdrive-list.mjs";

/** "pooled" when the URL's host is a pooled one (Neon marks it "-pooler"), else "direct". Throws on any other text. */
export function hostKind(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("not a URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("not a postgres:// URL");
  }
  return parsed.hostname.includes("-pooler.") ? "pooled" : "direct";
}

/**
 * The spike's own wrangler config. Its top-level name is no Worker that exists (every call names --env staging);
 * env.staging.name is the one cf.sh requires. It binds nothing but Hyperdrive, so the Worker gets no other resource.
 */
export function spikeConfig({ main, account, mode, id, localUrl }) {
  const binding = { binding: "HYPERDRIVE", id };
  if (mode === "local") {
    binding.localConnectionString = localUrl;
  } else if (mode !== "remote") {
    throw new Error("mode must be local or remote");
  }
  return {
    name: "rosie-spike-t1124-never-deployed",
    account_id: account,
    main,
    compatibility_date: "2026-11-01",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: true,
    env: { staging: { name: "rosie-staging", hyperdrive: [binding] } },
  };
}

/**
 * The id of the version that serves the most traffic, from the text of `wrangler deployments status --json` (read as
 * infra/scripts/deploy-staging.sh reads it), or "" when the text does not say.
 */
export function liveVersion(statusText) {
  const text = String(statusText);
  try {
    const status = JSON.parse(text.slice(text.search(/^\{/m), text.lastIndexOf("}") + 1));
    const top = [...(status.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0];
    const id = top?.version_id ?? "";
    return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? id : "";
  } catch {
    return "";
  }
}

/** True when the probe's result (its JSON text) says every step passed and the schema is gone. */
export function passed(resultText) {
  try {
    const result = JSON.parse(resultText);
    return result.ok === true && result.cleanup?.schema_dropped === true;
  } catch {
    return false;
  }
}

function main([command, ...args]) {
  if (command === "row") {
    try {
      const row = hyperdriveRow(readFileSync(0, "utf8"), args[0] ?? "");
      if (row !== null) {
        console.log(`${row.id}\t${row.caching}`);
      }
      return 0;
    } catch (error) {
      return error.exitCode ?? 2;
    }
  }
  if (command === "host-kind") {
    try {
      console.log(hostKind(process.env.PROBE_URL ?? ""));
      return 0;
    } catch {
      return 2;
    }
  }
  if (command === "config") {
    const [file, main, account, mode, id, localUrl] = args;
    writeFileSync(file, `${JSON.stringify(spikeConfig({ main, account, mode, id, localUrl }), null, 2)}\n`);
    return 0;
  }
  if (command === "token") {
    process.stdout.write(randomBytes(24).toString("hex"));
    return 0;
  }
  if (command === "verdict") {
    return passed(readFileSync(args[0], "utf8")) ? 0 : 1;
  }
  if (command === "live-version") {
    process.stdout.write(liveVersion(readFileSync(0, "utf8")));
    return 0;
  }
  console.error("helpers.mjs: unknown command");
  return 64;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename) {
  process.exitCode = main(process.argv.slice(2));
}

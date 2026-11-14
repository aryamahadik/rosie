// T-1255: a stand-in for wrangler, for run.test.mjs only (the spike T-1124's pattern). It never reaches Cloudflare or a
// database: it answers the three commands run.mjs sends through cf.sh from a plan the test writes, and keeps its state
// in that folder.
//   node standin-wrangler.mjs <state folder> --config <file> <wrangler's words and options>
// <state folder>/plan.json:
//   list      "ok" (default) or "fail": `hyperdrive list` fails
//   configs   [{ name, id, user, host, database, caching }]: the rows `hyperdrive list` prints, in wrangler 4.158.0's
//             columns; none prints no table
//   versions  [the serving version each `deployments status` call reports; "" for a call that fails]
//   dev       "serve" (default) or "exit": `dev` prints its token and a made-up host to its log, then ends at once
//   bindings  what /ready reports for each binding (default: true for each one the config names)
//   probe     the JSON /probe answers, with probeStatus (default 200)
// `dev` keeps what it was given in <state folder>/dev.json: its arguments, the config it read, and the files beside it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";

const [folder, , configFile, ...args] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(join(folder, "plan.json"), "utf8"));
const command = args[0] === "dev" ? "dev" : `${args[0]} ${args[1]}`;
const banner = " ⛅️ wrangler 4.158.0";

if (command === "hyperdrive list") {
  if (plan.list === "fail") {
    console.error(`${banner}\n✘ [ERROR] A request to the Cloudflare API failed.`);
    process.exit(1);
  }
  // The shape wrangler 4.158.0 prints: a table with each origin's user, host and database, or no table at all.
  console.log(`${banner}\n📋 Listing Hyperdrive configs`);
  const configs = plan.configs ?? [];
  if (configs.length > 0) {
    const line = (cells) => `│ ${cells.join(" │ ")} │`;
    const head = [
      "id",
      "name",
      "user",
      "host",
      "port",
      "scheme",
      "database",
      "caching",
      "mtls",
      "origin_connection_limit",
    ];
    const rows = configs.map((config) => [
      config.id,
      config.name,
      config.user,
      config.host,
      "5432",
      "PostgreSQL",
      config.database,
      config.caching,
      "{}",
      "",
    ]);
    console.log(["┌────┬────┐", line(head), "├────┼────┤", ...rows.map(line), "└────┴────┘"].join("\n"));
  }
} else if (command === "deployments status") {
  const countFile = join(folder, "status-calls");
  const calls = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
  writeFileSync(countFile, String(calls + 1));
  const version = plan.versions?.[calls] ?? "";
  if (version === "") {
    console.error(`${banner}\n✘ [ERROR] A request to the Cloudflare API failed.`);
    process.exit(1);
  }
  console.log(
    `${banner}\n${JSON.stringify({ versions: [{ version_id: version, percentage: 100 }] }, null, 2)}`,
  );
} else if (command === "dev") {
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  writeFileSync(
    join(folder, "dev.json"),
    JSON.stringify({ args, config, beside: readdirSync(dirname(configFile)).sort() }),
  );
  const port = Number((args.find((arg) => arg.startsWith("--port=")) ?? "").slice("--port=".length));
  const variable = args[args.indexOf("--var") + 1] ?? "";
  const token = variable.startsWith("PROBE_TOKEN:") ? variable.slice("PROBE_TOKEN:".length) : "";
  if (plan.dev === "exit") {
    // The worst a wrangler could print: the token and an origin's host.
    console.log(
      `${banner}\n✘ [ERROR] could not start: token ${token}, origin ${String(plan.configs?.[0]?.host)}`,
    );
    process.exit(1);
  }
  const bound = Object.fromEntries(
    (config.env?.staging?.hyperdrive ?? []).map((binding) => [binding.binding, true]),
  );
  const answers = {
    "/ready": [200, { ready: true, probe: "T-1255 hyperdrive-roles", bindings: plan.bindings ?? bound }],
    "/probe": [plan.probeStatus ?? 200, plan.probe ?? { ok: false }],
  };
  console.log(`${banner}\n⎔ Starting a remote preview (the stand-in)`);
  createServer((request, response) => {
    const answer = answers[new URL(request.url ?? "/", "http://127.0.0.1").pathname];
    const [status, body] =
      request.headers["x-probe-token"] !== token
        ? [403, { ok: false, refused: "the probe token is missing or wrong" }]
        : (answer ?? [404, { ok: false }]);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(`${JSON.stringify(body, null, 2)}\n`);
  }).listen(port, "127.0.0.1");
} else {
  console.error(`stand-in wrangler: no answer for: ${args.join(" ")}`);
  process.exit(64);
}

// Spike T-1124: a stand-in for wrangler, for run.test.mjs only. It never reaches Cloudflare or a database: it answers
// the four commands run.sh sends through cf.sh, from a plan the test writes, and keeps its state in that folder.
//   node standin-wrangler.mjs <state folder> --config <file> <wrangler's words and options>
// <state folder>/plan.json: { id, create: "ok" | "fail", versions: [the serving version each status call reports;
// "" for a call that fails], author: a made-up address the status output carries }.
// <state folder>/created.json: the one Hyperdrive configuration, once it exists (the test may write it first).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [folder, , , ...args] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(join(folder, "plan.json"), "utf8"));
const createdFile = join(folder, "created.json");
const command = args[0] === "dev" ? "dev" : `${args[0]} ${args[1]}`;
const banner = " ⛅️ wrangler 4.158.0";

if (command === "hyperdrive list") {
  // The shape wrangler 4.158.0 prints: a table with each origin's user, host and database, or no table at all.
  console.log(`${banner}\n📋 Listing Hyperdrive configs`);
  if (existsSync(createdFile)) {
    const made = JSON.parse(readFileSync(createdFile, "utf8"));
    const line = (cells) => `│ ${cells.join(" │ ")} │`;
    const head = ["id", "name", "user", "host", "port", "scheme", "database", "caching", "mtls"];
    const row = [
      plan.id,
      made.name,
      made.user,
      made.host,
      "5432",
      "PostgreSQL",
      made.database,
      "disabled",
      "{}",
    ];
    console.log(["┌────┬────┐", line(head), "├────┼────┤", line(row), "└────┴────┘"].join("\n"));
  }
} else if (command === "hyperdrive create") {
  // The worst a wrangler could do with the connection string: repeat it, and its password alone, in what it prints.
  const text = (args.find((arg) => arg.startsWith("--connection-string=")) ?? "").replace(/^[^=]*=/, "");
  const origin = new URL(text);
  const password = decodeURIComponent(origin.password);
  if (plan.create === "fail") {
    console.error(
      `${banner}\n✘ [ERROR] could not reach ${text} (user ${origin.username}, password ${password})`,
    );
    process.exit(1);
  }
  writeFileSync(
    createdFile,
    JSON.stringify({
      name: args[2],
      user: origin.username,
      host: origin.hostname,
      database: origin.pathname.slice(1),
    }),
  );
  console.log(`${banner}\n🚧 Creating '${args[2]}' from ${text} (password ${password})`);
  console.log(`✅ Created new Hyperdrive PostgreSQL config: ${plan.id}`);
} else if (command === "deployments status") {
  const countFile = join(folder, "status-calls");
  const calls = existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0;
  writeFileSync(countFile, String(calls + 1));
  const version = plan.versions?.[calls] ?? "";
  if (version === "") {
    console.error(`${banner}\n✘ [ERROR] A request to the Cloudflare API failed.`);
    process.exit(1);
  }
  const status = { author_email: plan.author, versions: [{ version_id: version, percentage: 100 }] };
  console.log(`${banner}\n${JSON.stringify(status, null, 2)}`);
} else if (command === "dev") {
  // The probe's Worker, as far as run.sh can tell: it answers /ready, /probe and /cleanup until it is stopped.
  const port = Number((args.find((arg) => arg.startsWith("--port=")) ?? "").slice("--port=".length));
  const answers = {
    "/ready": { ready: true, probe: "T-1124 hyperdrive-host", hyperdrive_bound: true },
    "/probe": { ok: true, via: "the stand-in", cleanup: { schema_dropped: true } },
    "/cleanup": { present_before: false, schema_dropped: true },
  };
  createServer((request, response) => {
    const answer = answers[new URL(request.url ?? "/", "http://127.0.0.1").pathname];
    response.writeHead(answer === undefined ? 404 : 200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(answer ?? { ok: false }, null, 2)}\n`);
  }).listen(port, "127.0.0.1");
} else {
  console.error(`stand-in wrangler: no answer for: ${args.join(" ")}`);
  process.exit(64);
}

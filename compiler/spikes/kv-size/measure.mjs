// Spike T-151 (Q-34): a compiled bundle's KV values against Cloudflare KV's value size limit, and its KV keys
// against the key size limit.
//
//   node compiler/spikes/kv-size/measure.mjs <bundle dir>
//
// <bundle dir> is a folder `npm run cli -w @rosie/compiler -- build --out <dir>` wrote (T-149): manifest.json,
// flow/A.json, flow/B.json and trade/<id>.json, one file per KV value of K-01 v1, each the value as stored (UTF-8
// JSON, compiler/src/emit/emit.ts). The script prints each value's bytes and its share of the limit (the trade
// overlays largest first), where the bytes sit in the manifest, the flow graphs and the largest overlay, the
// headroom, any value over the limit with the split it needs, and each key of the manifest's storage against the
// key limit. It writes nothing and makes no network call.
//
// The limits are Cloudflare's documented ones (SOURCE). The script also reads the limits miniflare, the local
// Workers simulator, enforces (KVLimits in its KV worker, in node_modules) and prints the file and line of each.
//
// Exit code: 0 every value and key fits; 1 one does not, or the folder does not match its manifest; 2 misuse.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIB = 1024 * 1024;
/** Cloudflare KV's documented limits, in bytes: one value (Free and Paid plans) and one key. */
const LIMIT = { value: 25 * MIB, key: 512 };
const SOURCE =
  'Cloudflare, "Workers KV · Limits", https://developers.cloudflare.com/kv/platform/limits/ (as contracts/bundle/README.md records it, read 2026-11-07)';
/** The widest build number a key can carry: K-01's build is an integer, which String() writes in plain digits up to here. */
const WIDEST_BUILD = String(Number.MAX_SAFE_INTEGER);
/** How many of the largest trade overlays the summary names. */
const LARGEST = 10;
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const size = (count) => `${count.toLocaleString("en-US")} B`;
const share = (count, of = LIMIT.value) => `${((100 * count) / of).toFixed(2)}%`;
const utf8 = (text) => Buffer.byteLength(text, "utf8");
const lines = (numbers) => `line${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}`;
/** Whether a size fits the value limit, and by how much. */
const fits = (count) =>
  count > LIMIT.value
    ? `does not fit: over by ${size(count - LIMIT.value)}`
    : `fits, with ${size(LIMIT.value - count)} to spare`;

/** Every file under `dir` but hidden ones, as "/"-separated paths relative to it, sorted. */
function filesUnder(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(prefix === "" ? dir : join(dir, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(dir, path));
    else out.push(path);
  }
  return out.sort();
}

/** The value a file holds, named by its key's part after bundle/<hash>/<build>/, or null for a file that holds none. */
function partOf(path) {
  const match = /^(manifest|flow\/[AB]|trade\/[a-z0-9][a-z0-9-]*)\.json$/.exec(path);
  return match === null ? null : match[1];
}

/** A stored object's top-level fields, each with the bytes of its value as stored, largest first. */
function fieldsOf(text) {
  const value = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value)
    .map(([field, inner]) => ({ field, bytes: utf8(JSON.stringify(inner)) }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** The largest top-level fields of a stored object, in words. */
function describeFields(text, total, count = 6) {
  return fieldsOf(text)
    .slice(0, count)
    .map((entry) => `${entry.field} ${size(entry.bytes)} (${share(entry.bytes, total)})`)
    .join(", ");
}

/** The KV limits miniflare enforces (KVLimits in its KV worker): each one's value and the lines defining and using it. */
function miniflareLimits() {
  let pkgFile;
  try {
    pkgFile = createRequire(import.meta.url).resolve("miniflare/package.json");
  } catch {
    return null;
  }
  const version = String(JSON.parse(readFileSync(pkgFile, "utf8")).version);
  const file = join(dirname(pkgFile), "dist", "src", "workers", "kv", "namespace.worker.js");
  if (!existsSync(file)) return { version, file: relative(ROOT, file), limits: null };
  const text = readFileSync(file, "utf8").split("\n");
  const limit = (name) => {
    const definition = new RegExp(`^\\s*${name}:\\s*([0-9.e]+(?:\\s*\\*\\s*[0-9.e]+)*)\\s*,?\\s*$`);
    const at = text.findIndex((line) => definition.test(line));
    const match = at < 0 ? null : definition.exec(text[at]);
    if (match === null) return null;
    const expression = match[1].replace(/\s+/g, " ");
    const value = expression.split("*").reduce((product, factor) => product * Number(factor), 1);
    const used = [];
    text.forEach((line, index) => {
      if (line.includes(`KVLimits.${name}`)) used.push(index + 1);
    });
    return { name, expression, value, line: at + 1, used };
  };
  return {
    version,
    file: relative(ROOT, file),
    limits: {
      value: limit("MAX_VALUE_SIZE_BYTES"),
      key: limit("MAX_KEY_SIZE_BYTES"),
      bulk: limit("MAX_BULK_SIZE_BYTES"),
      test: limit("MAX_VALUE_SIZE_TEST_BYTES"),
    },
  };
}

/** One miniflare limit, against Cloudflare's documented one when there is one, in words. */
function describeMiniflare(found, documented) {
  if (found === null) return "not found in the file";
  const value =
    found.expression === String(found.value)
      ? size(found.value)
      : `${found.expression} = ${size(found.value)}`;
  const used = found.used.length === 0 ? "used nowhere" : `used at ${lines(found.used)}`;
  const against =
    documented === undefined
      ? ""
      : found.value === documented
        ? " (the same)"
        : ` (DIFFERS from Cloudflare's ${size(documented)})`;
  return `${found.name} ${value} at line ${String(found.line)}, ${used}${against}`;
}

function main(args) {
  if (args.length !== 1 || (args[0] ?? "").startsWith("-")) {
    console.error("usage: node compiler/spikes/kv-size/measure.mjs <bundle dir>");
    return 2;
  }
  const dir = resolve(args[0]);
  if (!existsSync(join(dir, "manifest.json"))) {
    console.error(`${args[0]}: no manifest.json there; give a folder \`compiler build --out <dir>\` wrote`);
    return 2;
  }

  const problems = [];
  const parts = [];
  for (const path of filesUnder(dir)) {
    const part = partOf(path);
    if (part === null) problems.push(`${path}: not a value of K-01 v1's layout`);
    else parts.push({ part, path, bytes: statSync(join(dir, path)).size });
  }
  const textOf = (part) => readFileSync(join(dir, part.path), "utf8");
  const manifestPart = parts.find((part) => part.part === "manifest");
  const flows = parts.filter((part) => part.part.startsWith("flow/"));
  const trades = parts.filter((part) => part.part.startsWith("trade/")).sort((a, b) => b.bytes - a.bytes);
  let manifest;
  try {
    manifest = JSON.parse(textOf(manifestPart));
  } catch (error) {
    console.error(
      `${args[0]}: manifest.json is not JSON (${error instanceof Error ? error.message : String(error)})`,
    );
    return 2;
  }
  const storage = manifest.storage ?? {};
  const stored = Array.isArray(storage.values) ? storage.values : [];

  const id = manifest.bundleId ?? {};
  const standIn = id.hash === "0".repeat(64) ? " (the stand-in id, 64 zeros, until T-150)" : "";
  console.log(
    `Bundle ${dir}: bundle/${String(id.hash)}/${String(id.build)}${standIn}, ${String(parts.length)} values`,
  );

  console.log(`Limit: a KV value at most ${size(LIMIT.value)} (25 MiB), a key at most ${size(LIMIT.key)}.`);
  console.log(`  Source: ${SOURCE}.`);
  const mf = miniflareLimits();
  if (mf === null) console.log("  miniflare: not installed here, so not compared.");
  else if (mf.limits === null)
    console.log(`  miniflare ${mf.version}: ${mf.file} is not there, so not compared.`);
  else {
    console.log(`  miniflare ${mf.version} enforces, in ${mf.file}:`);
    console.log(`    ${describeMiniflare(mf.limits.value, LIMIT.value)}`);
    console.log(`    ${describeMiniflare(mf.limits.key, LIMIT.key)}`);
    console.log(`    ${describeMiniflare(mf.limits.bulk)} (all the values one bulk get returns)`);
    console.log(
      `    ${describeMiniflare(mf.limits.test)} (in place of the two limits above while the object is beingTested)`,
    );
  }

  const width = Math.max(...parts.map((part) => part.part.length));
  console.log("");
  console.log("Each value as stored (bytes; share of the 25 MiB limit), trade overlays largest first:");
  for (const part of [manifestPart, ...flows, ...trades])
    console.log(
      `  ${part.part.padEnd(width)}  ${size(part.bytes).padStart(13)}  ${share(part.bytes).padStart(6)}`,
    );

  console.log("");
  if (trades.length > 0) {
    const total = trades.reduce((sum, part) => sum + part.bytes, 0);
    const median = trades[Math.floor(trades.length / 2)];
    const smallest = trades[trades.length - 1];
    console.log(
      `Trade overlays: ${String(trades.length)}, ${size(total)} in all; the largest ${trades[0].part} ${size(trades[0].bytes)}, the median ${size(median.bytes)}, the smallest ${smallest.part} ${size(smallest.bytes)}.`,
    );
    console.log(
      `The ${String(Math.min(LARGEST, trades.length))} largest: ${trades
        .slice(0, LARGEST)
        .map((part) => `${part.part} ${size(part.bytes)} (${share(part.bytes)})`)
        .join(", ")}.`,
    );
  }

  console.log("Where the bytes sit (top-level fields, as stored; share of the value):");
  for (const part of [manifestPart, ...flows, ...trades.slice(0, 1)])
    console.log(`  ${part.part}: ${describeFields(textOf(part), part.bytes)}`);

  const largest = [...parts].sort((a, b) => b.bytes - a.bytes)[0];
  const times = (part) => (LIMIT.value / part.bytes).toFixed(1);
  console.log(
    `Headroom: the largest value, ${largest.part}, is ${size(largest.bytes)}, ${share(largest.bytes)} of the limit: it can grow ${times(largest)} times before it reaches it.`,
  );
  if (trades.length > 0)
    console.log(
      `  The largest trade overlay, ${trades[0].part}, is ${share(trades[0].bytes)} of the limit (${times(trades[0])} times); the manifest ${share(manifestPart.bytes)} (${times(manifestPart)} times).`,
    );
  const failures = Array.isArray(manifest.lint?.failures) ? manifest.lint.failures : [];
  if (failures.length > 0) {
    const lintBytes = utf8(JSON.stringify(manifest.lint));
    const each = lintBytes / failures.length;
    const inTrades = failures.filter((failure) => typeof failure?.trade === "string").length;
    const atLimit = Math.floor((LIMIT.value - (manifestPart.bytes - lintBytes)) / each);
    console.log(
      `  The manifest's lint lists ${failures.length.toLocaleString("en-US")} failures (${inTrades.toLocaleString("en-US")} of them a trade's), about ${each.toFixed(0)} B each: at that rate the manifest reaches the limit at about ${atLimit.toLocaleString("en-US")} failures.`,
    );
  }

  const over = parts.filter((part) => part.bytes > LIMIT.value);
  if (over.length === 0)
    console.log("Over the limit: none, so K-01 v1's layout (one KV value per part) needs no split.");
  for (const part of over)
    console.log(
      `Over the limit: ${part.part}, ${size(part.bytes)}, by ${size(part.bytes - LIMIT.value)}: it needs at least ${String(Math.ceil(part.bytes / LIMIT.value))} values; its largest fields: ${describeFields(textOf(part), part.bytes, 3)}`,
    );

  const biggestFlow = flows.reduce(
    (best, part) => (best === null || part.bytes > best.bytes ? part : best),
    null,
  );
  const read = [manifestPart, biggestFlow, trades[0]].filter((part) => part !== null && part !== undefined);
  const turn = read.reduce((sum, part) => sum + part.bytes, 0);
  console.log(
    `A turn reads 3 values (the manifest, a flow graph, a trade overlay): at most ${size(turn)} together (${read.map((part) => part.part).join(" + ")}), ${share(turn)} of the limit.`,
  );
  const allTrades = trades.reduce((sum, part) => sum + part.bytes, 0);
  const whole = parts.reduce((sum, part) => sum + part.bytes, 0);
  console.log(
    `Other layouts (their values' bytes summed, before any wrapping): every trade overlay in one value ${size(allTrades)}, ${share(allTrades)}, ${fits(allTrades)}; the whole bundle in one value ${size(whole)}, ${share(whole)}, ${fits(whole)}.`,
  );

  const keys = [storage.manifestKey, ...stored.map((value) => value.key)].filter(
    (key) => typeof key === "string",
  );
  const longest = keys.reduce((best, key) => (utf8(key) > utf8(best) ? key : best), "");
  const widest = longest.replace(/^(bundle\/[0-9a-f]{64}\/)[0-9]+\//, `$1${WIDEST_BUILD}/`);
  const tradeIdRoom = LIMIT.key - utf8(`bundle/${"0".repeat(64)}/${WIDEST_BUILD}/trade/`);
  const tradeIds = keys
    .map((key) => /\/trade\/([^/]+)$/.exec(key)?.[1])
    .filter((tradeId) => tradeId !== undefined);
  const longestTrade = Math.max(0, ...tradeIds.map((tradeId) => tradeId.length));
  const count = (pattern) => keys.filter((key) => pattern.test(key)).length;
  const overKeys = keys.filter((key) => utf8(key) > LIMIT.key);
  console.log("");
  console.log(
    `KV keys (K-01 v1, the manifest's storage): ${String(keys.length)} (${String(count(/\/manifest$/))} manifest, ${String(count(/\/flow\/[^/]+$/))} flow graphs, ${String(tradeIds.length)} trade overlays), each to fit in ${size(LIMIT.key)}:`,
  );
  console.log(
    `  the longest, ${longest}, is ${size(utf8(longest))} (${share(utf8(longest), LIMIT.key)} of the key limit);`,
  );
  console.log(
    `  with the widest build number, ${WIDEST_BUILD} (Number.MAX_SAFE_INTEGER), it is ${size(utf8(widest))}; a trade id may then have up to ${String(tradeIdRoom)} characters (the longest today has ${String(longestTrade)});`,
  );
  console.log(`  over the key limit: ${overKeys.length === 0 ? "none" : overKeys.join(", ")}.`);

  const listed = new Map(stored.map((value) => [String(value.key).split("/").slice(3).join("/"), value]));
  for (const part of parts) {
    if (part.part === "manifest") continue;
    const entry = listed.get(part.part);
    if (entry === undefined) problems.push(`${part.path}: not in the manifest's storage.values`);
    else if (entry.bytes !== part.bytes)
      problems.push(`${part.path}: ${size(part.bytes)} here, ${size(entry.bytes)} in the manifest`);
  }
  for (const part of listed.keys())
    if (!parts.some((found) => found.part === part))
      problems.push(`${part}.json: in the manifest, not in the folder`);
  if (problems.length === 0)
    console.log(
      `The folder against its manifest: each of the ${String(parts.length - 1)} values besides the manifest is in storage.values with the same bytes.`,
    );
  else {
    console.log("The folder against its manifest:");
    for (const problem of problems) console.log(`  ${problem}`);
  }

  const failed = over.length > 0 || overKeys.length > 0 || problems.length > 0;
  console.log(
    failed ? "Verdict: NOT every value and key fits (above)." : "Verdict: every value and key fits.",
  );
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));

// `compiler publish`: publishes a bundle directory (T-152; C-072; K-01 v1 storage; K-05 v1 item 7, NQ-PB-5's default).
//
//   npm run cli --workspace compiler -- publish <bundle dir> [--kv <file>]
//
//   <bundle dir>  a bundle `compiler build --build <n>` wrote: its id, the content hash of its stored values with its
//                 build number (T-150), is the id it is published under. A relative path is read from the folder npm
//                 was run in (INIT_CWD).
//   --kv          the KV bulk file to write: one { key, value } entry per part, every key under the bundle id, the form
//                 `wrangler kv bulk put` reads (default: <bundle dir>.kv.json, beside the folder, which holds the
//                 bundle's files only). A file holding other entries is never overwritten.
//
// It writes PostgreSQL's copy through K-05's publishBundleCopy (db/repo/bundles.ts, T-185), reads every part back by its
// key (readBundleValue, the actor's read on a KV miss) and compares it byte for byte, then writes the KV bulk file. The
// same bundle again writes nothing new. It never switches the active bundle id and never uploads to KV: the deploy
// script uploads the file, then switches the id (its step 3: BP 5.4; C-020). The database is DATABASE_URL's, else the
// local one when CI is unset, in the schema DB_SCHEMA names (db/repo/client.ts); no connection string is printed.
// The client is built inside the publish's try (T-1179), where postgres.js parses each URL it reads: a URL that does
// not parse is thrown as a DatabaseUrlError, which holds no part of it, never as Node's ERR_INVALID_URL, whose `input`
// holds the whole string and is printed by Node when a caller that runs publish.run directly does not catch it.
//
// Exit: 0 published, or already published with the same bytes; 1 refused or failed; 2 misuse. A database URL that
// does not parse is thrown, and the CLI prints its message (exit 1).
//
// As `compiler build` does (build.ts), the compiler's and the database's modules are loaded only when the command runs,
// after a resolve hook that completes a relative import from a compiler .ts file with `.ts` or `/index.ts`.
import { registerHooks } from "node:module";
import { isAbsolute, resolve } from "node:path";
import type * as Client from "../../../../db/repo/client";
import type * as Publish from "../../publish/index";
import type { CliIo, Command } from "../index.ts";

let hooked = false;

/** Lets Node complete extensionless relative imports (`./core` is `./core.ts`, `../path` `../path/index.ts`). */
function completeImports(): void {
  if (hooked) return;
  hooked = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const parent = context.parentURL ?? "";
        const relative = specifier.startsWith("./") || specifier.startsWith("../");
        if (!relative || !parent.startsWith("file:") || !parent.endsWith(".ts")) throw error;
        for (const suffix of [".ts", "/index.ts"]) {
          try {
            return nextResolve(`${specifier}${suffix}`, context);
          } catch {
            // not this form: try the next one
          }
        }
        throw error;
      }
    },
  });
}

/** The publisher, loaded once the resolve hook is in place. */
async function loadPublisher(): Promise<typeof Publish> {
  completeImports();
  return (await import(new URL("../../publish/index.ts", import.meta.url).href)) as typeof Publish;
}

/** The database client (db/repo/client.ts), loaded the same way. */
async function loadClient(): Promise<typeof Client> {
  completeImports();
  return (await import(new URL("../../../../db/repo/client.ts", import.meta.url).href)) as typeof Client;
}

/** A command line this command does not take. */
class UsageError extends Error {
  override name = "UsageError";
}

/** A database URL that does not parse (T-1179): a fixed message, and no `input`, cause or other part of the URL. */
class DatabaseUrlError extends Error {
  override name = "DatabaseUrlError";
}

/** An error of reading a URL: Node's ERR_INVALID_URL, or the URIError of a bad % escape that postgres.js decodes. */
function isUrlError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === "ERR_INVALID_URL" || name === "URIError";
}

/** The error for a URL the client could not build from, naming the settings it reads (db/repo/client.ts). */
function urlRefusal(): DatabaseUrlError {
  const replica = process.env.DATABASE_REPLICA_URL;
  const names =
    replica === undefined || replica === "" ? "DATABASE_URL" : "DATABASE_URL or DATABASE_REPLICA_URL";
  return new DatabaseUrlError(`refused: ${names} does not parse as a URL; nothing was read or written`);
}

const USAGE = "usage: publish <bundle dir> [--kv <file>]";

interface Given {
  dir: string;
  kv?: string;
}

function parse(args: readonly string[]): Given {
  let dir: string | undefined;
  let kv: string | undefined;
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] ?? "";
    if (arg === "--kv") {
      const value = args[k + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError("--kv needs a value");
      if (kv !== undefined) throw new UsageError("--kv is given twice");
      kv = value;
      k += 1;
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown argument "${arg}"`);
    } else if (dir === undefined) {
      dir = arg;
    } else {
      throw new UsageError(`one bundle directory only: "${arg}" is a second`);
    }
  }
  if (dir === undefined) throw new UsageError("<bundle dir> is required");
  return kv === undefined ? { dir } : { dir, kv };
}

/** A path from the command line: relative paths are read from the folder npm was run in. */
function fromCaller(path: string): string {
  return isAbsolute(path) ? path : resolve(process.env.INIT_CWD ?? process.cwd(), path);
}

/** The lines of a publish K-05 refused or that failed its read back (exit 1). */
function refusal(outcome: Exclude<Publish.PublishOutcome, { result: "published" }>, id: string): string[] {
  if (outcome.error === "valueMismatch")
    return [
      `refused: ${outcome.key} already holds other bytes in PostgreSQL's copy (K-05 publishBundleCopy: valueMismatch), so bundle id ${id} was published before with other bytes; a bundle with other bytes is built with another build number (compiler build --build <n>)`,
      "nothing was written: no value, and no KV bulk file",
    ];
  if (outcome.error === "transient")
    return [
      `PostgreSQL could not answer now (K-05: transient, SQLSTATE ${outcome.sqlstate}): nothing was written; run the publish again`,
    ];
  return [
    `PostgreSQL's copy read back by bundle id is not the bundle's: ${outcome.problems.slice(0, 5).join("; ")}`,
    "no KV bulk file was written",
  ];
}

async function run(args: string[], io: CliIo): Promise<number> {
  let given: Given;
  try {
    given = parse(args);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(error.message);
    io.err(USAGE);
    return 2;
  }
  const publisher = await loadPublisher();
  const dir = fromCaller(given.dir);
  const kvFile = given.kv === undefined ? publisher.defaultKvFile(dir) : fromCaller(given.kv);
  let bundle: Publish.PublishableBundle;
  try {
    bundle = publisher.readPublishable(dir);
    // The KV bulk file's place, checked before the database is opened (publishBundle checks it again).
    publisher.checkKvFile(kvFile, publisher.kvBulkText(bundle), dir);
  } catch (error) {
    if (!(error instanceof publisher.PublishError)) throw error;
    io.err(`refused: ${error.message}`);
    io.err("nothing was written");
    return 1;
  }

  const client = await loadClient();
  let db: Client.DbClient | undefined;
  let outcome: Publish.PublishOutcome;
  try {
    db = client.createClient({ max: 2 });
    outcome = await publisher.publishBundle(db.primary, bundle, kvFile);
  } catch (error) {
    // No client was built: its error goes to the caller as before, except that a URL error becomes one holding no part
    // of the URL.
    if (db === undefined) throw isUrlError(error) ? urlRefusal() : error;
    if (error instanceof publisher.PublishError) {
      io.err(`refused: ${error.message}`);
      io.err("nothing was written");
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.err(`the publish failed: ${client.redact(message, [client.resolvePrimaryUrl()])}`);
    return 1;
  } finally {
    await db?.close();
  }

  const id = `${bundle.bundleId.hash}/${String(bundle.bundleId.build)}`;
  if (!("result" in outcome)) {
    for (const line of refusal(outcome, id)) io.err(line);
    return 1;
  }
  const parts = bundle.parts.length;
  const flows = bundle.parts.filter((part) => part.kind === "flow").length;
  const trades = bundle.parts.filter((part) => part.kind === "trade").length;
  const bytes = bundle.parts.reduce((sum, part) => sum + part.bytes, 0);
  io.out(
    `bundle ${id}: ${String(parts)} parts (the manifest, ${String(flows)} flow graphs, ${String(trades)} trade overlays), ${String(bytes)} bytes, read from ${given.dir} and checked: K-01 v1, each file the value its manifest lists, the id the content hash of its stored values`,
  );
  io.out(
    outcome.repeated
      ? `PostgreSQL's copy: already published at ${outcome.publishedAt} with these bytes, so nothing new was written (K-05 publishBundleCopy: repeated)`
      : `PostgreSQL's copy: published at ${outcome.publishedAt}, ${String(outcome.values)} values written (K-05 publishBundleCopy)`,
  );
  io.out(
    `read back by bundle id (K-05 readBundleValue, the actor's read on a KV miss): ${String(parts)} of ${String(parts)} parts byte-identical`,
  );
  io.out(
    `KV bulk file ${kvFile}: ${String(parts)} entries, one per part, every key under bundle/${id}/ (${outcome.kvFileWritten ? "written" : "unchanged: it held these entries already"})`,
  );
  io.out(
    outcome.activeBefore === outcome.activeAfter
      ? `active bundle id: ${outcome.activeAfter}, unchanged: publishing never switches it (the deploy script's step 3 does, after the KV upload: BP 5.4)`
      : `active bundle id: ${outcome.activeBefore} before, ${outcome.activeAfter} after: switched during the publish by another caller, never by the publish`,
  );
  return 0;
}

export const command: Command = {
  name: "publish",
  summary:
    "Publish a bundle directory: the KV bulk file keyed by bundle id and PostgreSQL's copy; the active id stays",
  run,
};

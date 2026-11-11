// The database URL of the release scripts, checked and scrubbed (T-569; the security reviews of its rounds 1 and 2,
// DL-356 and DL-363; T-1210). migrate.mjs (deploy step 1), publish-bundle.sh (step 3), infra/flags/flags.mjs (step 4)
// and db/seeds/run.mjs check their URL here before any client is built, and print a failure only through
// describeError, so no line they print holds any part of the URL. Left to itself, postgres.js throws a URL error whose
// `input` property holds the whole string, password included (Node prints that property for an error no catch takes);
// reads a password holding a #, / or ? after digits as a URL whose host is the user; takes its hosts from after the
// first @ (Node's host follows the last), decoded and split at each comma into hosts it tries in turn, so
// postgres://u:p@<remote>,x@127.0.0.1/db names 127.0.0.1 to Node and connects to <remote> first (T-201's security
// review, note a); and its errors name the host of a database that does not answer.
//
//   checkDatabaseUrl(raw)            the URL, checked: one postgres:// URL that Node and postgres.js read alike, so a
//                                    client connects only where it names: one host, after at most one @ (an @ or a
//                                    comma in the user or password is written %40 or %2C). Returns its parts, what no
//                                    printed line may hold: the whole URL (as given and as Node writes it), its user,
//                                    password and database name (each as written and decoded), its host (with and
//                                    without the port, an IPv6 address with and without brackets) and its port.
//                                    Throws DatabaseUrlFault, whose message names the fault and holds no part of it.
//   scrub(text, parts, error)        the text with each part taken out. With an error, the address, host name and port
//                                    its own fields name are taken out too: a host name can show resolved to an address.
//   describeError(error, parts)      a failed call as printed: " (<code>): <message>", both scrubbed, and no other field
//                                    of the error (never `input`).
//   printStrayErrors(prefix, parts)  an error no catch takes (a stray rejection) is printed as describeError does, after
//                                    "<prefix>: failed", and the program exits 1; parts() gives the parts known then.

const REDACTED = "[redacted]";

/** A database URL refused before any client is built: the message names the fault and holds no part of the URL. */
export class DatabaseUrlFault extends Error {}

/** The database URL, checked (see the top of this file). Returns its parts, longest first. */
export function checkDatabaseUrl(raw) {
  if (typeof raw !== "string" || raw === "") throw new DatabaseUrlFault("it is empty");
  if (/[\s"'`]/.test(raw))
    throw new DatabaseUrlFault(
      "it holds a quote or a space (a .dev.vars value is the URL alone, with no comment after it)",
    );
  if (raw.includes("#"))
    throw new DatabaseUrlFault(
      "it holds a # (a # in the password is written %23, and a .dev.vars value has no comment after the URL)",
    );
  // The authority (user, password, host and port) runs from the scheme's // to the first / or ? for Node and
  // postgres.js alike (a # is refused above). Node's host follows its last @; postgres.js takes its hosts from after the
  // first @, decoded and split at each comma, and tries them in turn (src/index.js parseUrl). So a second @, a comma or
  // a %2C in the host can give postgres.js a host Node never read (see the top of this file), and a deploy names one
  // host (CQ-192). Checked before Node reads the URL, so a list of hosts with ports, which Node does not read, is
  // refused by name.
  const afterScheme = raw.slice(raw.indexOf("//") + 2);
  const authorityEnd = afterScheme.search(/[/?]|$/);
  const authority = afterScheme.slice(0, authorityEnd);
  if (authority.indexOf("@") !== authority.lastIndexOf("@"))
    throw new DatabaseUrlFault(
      "it holds a second @ in its user, password or host (an @ in the user or password is written %40)",
    );
  if (authority.includes(",") || /%2C/i.test(authority.slice(authority.indexOf("@") + 1)))
    throw new DatabaseUrlFault(
      "it names more than one host, or holds a comma in its user or password (a comma there is written %2C)",
    );
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseUrlFault("it is not a URL (a / or ? in the user or password is written %2F or %3F)");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new DatabaseUrlFault("it is not a postgres:// or postgresql:// URL");
  if (url.hostname === "") throw new DatabaseUrlFault("it names no host");
  // An @ after the host means the user or password held a / or ?, so the URL read here names another host.
  if (afterScheme.slice(authorityEnd).includes("@"))
    throw new DatabaseUrlFault(
      "it holds an @ after its host (a / or ? in the user or password is written %2F or %3F)",
    );
  const parts = [raw, url.href, url.host, url.hostname, url.hostname.replace(/^\[|\]$/g, ""), url.port];
  for (const part of [url.username, url.password, url.pathname.slice(1)]) {
    try {
      parts.push(part, decodeURIComponent(part));
    } catch {
      throw new DatabaseUrlFault(
        "a % in its user, password or database name starts no escape (a % is written %25)",
      );
    }
  }
  return ordered(parts);
}

/** `text` with each part taken out (see the top of this file). */
export function scrub(text, parts, error) {
  let out = String(text);
  for (const part of ordered([...parts, ...ownParts(error)])) {
    // A part of digits alone (a port) goes only where it stands as a whole number, so a port such as 1 leaves the
    // other digits of the line alone.
    out = /^[0-9]+$/.test(part)
      ? out.replace(new RegExp(`(?<![0-9])${part}(?![0-9])`, "g"), REDACTED)
      : out.split(part).join(REDACTED);
  }
  return out;
}

/** A failed call as printed: its code (a SQLSTATE, or a code such as ECONNREFUSED) and its message, never its fields. */
export function describeError(error, parts) {
  const code =
    typeof error?.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(error.code)
      ? ` (${scrub(error.code, parts, error)})`
      : "";
  return `${code}: ${scrub(error instanceof Error ? error.message : String(error), parts, error)}`;
}

/** Prints an error no catch takes as describeError does, then exits 1: Node would print every field of it. */
export function printStrayErrors(prefix, parts) {
  process.on("uncaughtException", (error) => {
    console.error(`${prefix}: failed${describeError(error, parts())}`);
    process.exit(1);
  });
}

/** Parts that are text, with no empty one and no repeat, longest first, so a part goes before any part inside it. */
function ordered(parts) {
  const texts = parts.filter((part) => typeof part === "string" && part !== "");
  return [...new Set(texts)].sort((a, b) => b.length - a.length);
}

/** The address, host name and port an error's own fields name (Node's and postgres.js's connection errors). */
function ownParts(error) {
  if (typeof error !== "object" || error === null) return [];
  return [error.address, error.hostname, error.port]
    .flat()
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String);
}

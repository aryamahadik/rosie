// One helper builds every local string of the Workers test rig (T-1253; ADR-014 section 4, "From one DATABASE_URL to two
// logins"): the pool's Hyperdrive strings (rig.mjs, for vitest.config.ts) and the login checks of the logins step that
// the rig and `npm run db:logins` share use it, and nothing else does.
//
// From one database URL, with Node's URL class: its scheme, host, port and query are kept; its user is set to the login,
// its password to the login's local password, and its path to the database. It never prints a string, and an error it
// throws holds no part of the URL (db-url.mjs checks it first: one postgres:// URL that Node and postgres.js read alike,
// else a DatabaseUrlFault, whose message names the fault alone).
import { checkDatabaseUrl } from "../scripts/db-url.mjs";

/**
 * The local password of a login the rig makes: the login's own name, as rosie's is rosie (ADR-014 section 3). Fixed,
 * public and no secret, and set on a local or CI server only.
 */
export function localPassword(login) {
  return login;
}

// A database the rig names: a plain lower-case SQL name, so the path holds nothing but the name.
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The string for `login` with `password` on `database`, on the server `databaseUrl` names (see the top of this file).
 * An empty password leaves the string with none (a server that asks for none). Throws, naming no part of either, when
 * the URL is not one database URL, the database is not a plain lower-case SQL name, or the login is empty.
 */
export function localString(databaseUrl, { login, password, database }) {
  checkDatabaseUrl(databaseUrl);
  if (typeof login !== "string" || login === "") throw new Error("a local string needs a login");
  if (typeof password !== "string") throw new Error("a local string's password is text");
  if (typeof database !== "string" || !DATABASE_NAME.test(database)) {
    throw new Error("a local string's database is a plain lower-case SQL name");
  }
  const url = new URL(databaseUrl);
  // Escaped whole: the setters alone leave a % as it is, and a client decodes the user and password, so a % written
  // bare would start a broken escape.
  url.username = encodeURIComponent(login);
  url.password = encodeURIComponent(password);
  url.pathname = `/${database}`;
  return url.href;
}

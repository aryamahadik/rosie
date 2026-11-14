#!/usr/bin/env node
// `npm run db:logins` (T-1253; ADR-014 section 4's piece 5): the Worker's two logins and their local passwords, for plain
// `wrangler dev` (`npm run cf -- dev --env staging`), whose env.staging bindings log in to the local database as
// rosie_worker_job and rosie_worker_app with their local passwords (wrangler.jsonc's localConnectionString).
//
// On the server DATABASE_URL names, else the local database of infra/docker-compose.yml when CI is unset, connecting as
// that URL's login, it runs the same two steps as the Workers test rig (rig.mjs makeWorkerLogins):
// infra/scripts/worker-logins.sql (T-1252), then each login's local password, its own name, set only when the login
// cannot already log in with it, so a second run changes nothing. First, the same refusals: a URL whose host is not a
// loopback name (127.0.0.1, ::1 or localhost) before any connection, and a login that is not a superuser before
// anything is made. So it never runs on staging. The file needs rosie_job and rosie_app, which migration 0012 makes:
// on a server never migrated, run `npm run migrate` first.
//
// It prints each login's shape as worker-logins.sql reads it (its attributes, its memberships by member, how many rows
// of pg_shdepend name it) and whether its password was kept or set; never a connection string or a part of one.
// Exit: 0 done; 1 refused or failed.
import { describeError } from "../scripts/db-url.mjs";
import {
  RigRefusal,
  adminOf,
  checkLocalUrl,
  makeWorkerLogins,
  refuseUnlessSuperuser,
  serverUrl,
} from "./rig.mjs";

const ATTRIBUTES = [
  ["login", "LOGIN"],
  ["superuser", "SUPERUSER"],
  ["createdb", "CREATEDB"],
  ["createrole", "CREATEROLE"],
  ["replication", "REPLICATION"],
  ["bypassrls", "BYPASSRLS"],
];

/** A login's shape in one line: its attributes, its memberships by member, and what names it. */
function described(shape) {
  if (shape === null) return "missing";
  const attributes = ATTRIBUTES.map(([key, name]) => `${name} ${shape[key] ? "yes" : "no"}`).join(", ");
  return `${attributes}; memberships ${shape.memberships}; named by ${String(shape.named_by)} row(s) of pg_shdepend`;
}

let parts = [];
try {
  const url = serverUrl();
  parts = checkLocalUrl(url);
  const admin = adminOf(url);
  try {
    await refuseUnlessSuperuser(admin);
    for (const { login, password, shape } of await makeWorkerLogins(admin, url, parts)) {
      console.log(`db:logins: ${login}: ${described(shape)}; local password ${password}`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  console.log("db:logins: done");
} catch (error) {
  // The script's own errors name no part of the URL; a database's or a socket's (they carry a code) goes as its code
  // and message, scrubbed, and no other field.
  const own = error instanceof RigRefusal || (error instanceof Error && error.code === undefined);
  console.error(`db:logins: ${own ? error.message : `failed${describeError(error, parts)}`}`);
  process.exitCode = 1;
}

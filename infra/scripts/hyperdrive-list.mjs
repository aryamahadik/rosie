// The `hyperdrive list` parser (ADR-014 section 3 and "The `hyperdrive list` parser"; T-1252). It moved here from the
// spike T-1124's infra/spikes/hyperdrive-host/helpers.mjs, which now imports it, so there is one parser. Its users:
// create-staging-hyperdrive.mjs (piece 2) and T-1093's deploy-time check (piece 4); the spike's run.sh, through
// helpers.mjs.
//
// It reads the text `wrangler hyperdrive list` prints through cf.sh. Wrangler 4.158.0 prints the account's
// configurations as a table (cells between "│") with the columns id, name, user, host, port, scheme, database, caching,
// mtls and origin_connection_limit (its src/hyperdrive/list.ts), and no table at all when there are none. Only a row's
// id, user and caching cells leave this module: the host and the database cells never do.

/** A terminal's colour codes (escape, "[", digits and ";", "m"), which wrangler puts around a table on a terminal. */
const COLOUR_CODES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * The row of `wrangler hyperdrive list` for the configuration named `name`: { id, user, caching }, or null when the
 * list has none.
 *  - id: the configuration's id, 32 hex characters (anything else is refused).
 *  - user: the user its origin stores, the cell as wrangler prints it (trimmed), "" for an empty cell, and null when
 *    the table has no user column. It is for comparing with a login's name; whoever prints it decides whether to.
 *  - caching: the caching cell as wrangler prints it ("disabled", "enabled", "max_age: ..."), without any sign outside
 *    [A-Za-z0-9_:,. -]; "?" when the table has no caching column or the cell is empty.
 * Throws an error with exitCode 2 when the text cannot be read (the name outside a table, a table with no id or name
 * column, an id that is not 32 hex characters), and 3 when two configurations have the name. No message holds a cell.
 */
export function hyperdriveRow(listing, name) {
  const fail = (exitCode, message) => Object.assign(new Error(message), { exitCode });
  const text = String(listing).replace(COLOUR_CODES, "");
  const rows = text
    .split("\n")
    .filter((line) => line.startsWith("│"))
    .map((line) =>
      line
        .split("│")
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  if (rows.length === 0) {
    if (text.includes(name)) {
      throw fail(2, "the list names the configuration, but not in a table");
    }
    return null;
  }
  const [head, ...data] = rows;
  const idAt = head.indexOf("id");
  const nameAt = head.indexOf("name");
  const userAt = head.indexOf("user");
  const cachingAt = head.indexOf("caching");
  if (idAt < 0 || nameAt < 0) {
    throw fail(2, "the list's table has no id or name column");
  }
  const found = data.filter((row) => row[nameAt] === name);
  if (found.length > 1) {
    throw fail(3, "more than one configuration has the name");
  }
  if (found.length === 0) {
    return null;
  }
  const [row] = found;
  const id = row[idAt] ?? "";
  if (!/^[0-9a-f]{32}$/.test(id)) {
    throw fail(2, "the configuration's id is not 32 hex characters");
  }
  const user = userAt < 0 ? null : (row[userAt] ?? "");
  const caching = cachingAt < 0 ? "?" : (row[cachingAt] ?? "").replace(/[^A-Za-z0-9_:,. -]/g, "");
  return { id, user, caching: caching === "" ? "?" : caching };
}

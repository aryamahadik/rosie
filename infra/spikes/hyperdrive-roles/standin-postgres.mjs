// T-1255: a stand-in for the postgres.js clients worker.mjs opens through HYPERDRIVE_JOB and HYPERDRIVE_APP, for the
// tests only (probe.test.mjs, and run.test.mjs, which makes the stand-in session's /probe answer with it). It reaches no
// database: it answers probe.mjs's guard query as the login each binding stores, as PostgreSQL would for a login made
// as ADR-014 section 1 says (one membership, its role, inherit true, set false, admin false), reading which roles the
// query asks about from its text. Every value is made up.
//
//   const { open, clients } = standinOpen({ start, logins, change })
//   start   the postmaster start every read gives, as PostgreSQL prints it in UTC
//   logins  { HYPERDRIVE_JOB: login, HYPERDRIVE_APP: login }: the login behind each binding (default: its own)
//   change  ({ binding, read, inTransaction, row }) => row: a test's change to one read's row; it may throw instead.
//           `read` counts that binding's reads from 1.
// clients: each client opened, in order: { binding, options, reads, mostAtOnce, transactions: [{ mode, reads }],
// ended }. Outside a transaction the pid is the client's slot (one backend per read in flight); inside one, one pid.
import { parseStart } from "./probe.mjs";

const ROLE_OF = { rosie_worker_job: "rosie_job", rosie_worker_app: "rosie_app" };

/** The row PostgreSQL would give for the guard query asked as `login`. */
export function rowFor({ login, query, pid, start }) {
  const own = /pg_has_role\(current_user, '([a-z_]+)', 'USAGE'\)/.exec(query)?.[1];
  const other = /pg_has_role\(current_user, '([a-z_]+)', 'MEMBER'\)/.exec(query)?.[1];
  const role = ROLE_OF[login];
  return {
    session_user_name: login,
    current_user_name: login,
    memberships:
      role === undefined ? null : JSON.stringify([{ role, inherit: true, set: false, admin: false }]),
    own_usage: own !== undefined && own === role,
    other_member: other !== undefined && other === role,
    row_security: true,
    schema_name: "public",
    pid,
    postmaster_start: start,
    postmaster_start_us: String(parseStart(start)),
  };
}

export function standinOpen({
  start = "2026-01-02 03:04:05.123456+00",
  logins = { HYPERDRIVE_JOB: "rosie_worker_job", HYPERDRIVE_APP: "rosie_worker_app" },
  change = ({ row }) => row,
} = {}) {
  const clients = [];
  const readsOf = new Map();
  const open = (binding, options) => {
    const index = clients.length;
    const client = { binding, options, reads: 0, inFlight: 0, mostAtOnce: 0, transactions: [], ended: false };
    clients.push(client);
    const answer = async (query, pid, inTransaction) => {
      if (client.ended) throw new Error("the stand-in client has ended");
      client.reads += 1;
      const read = (readsOf.get(binding) ?? 0) + 1;
      readsOf.set(binding, read);
      // Let the other reads of a round start before this one answers, as a pool would.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      const row = rowFor({ login: logins[binding], query, pid, start });
      return [change({ binding, read, inTransaction, row })];
    };
    return {
      unsafe(query) {
        const pid = 4000 + index * 10 + client.inFlight;
        client.inFlight += 1;
        client.mostAtOnce = Math.max(client.mostAtOnce, client.inFlight);
        return answer(query, pid, false).finally(() => {
          client.inFlight -= 1;
        });
      },
      async begin(mode, fn) {
        const transaction = { mode, reads: 0 };
        client.transactions.push(transaction);
        const pid = 5000 + index;
        return fn({
          unsafe(query) {
            transaction.reads += 1;
            return answer(query, pid, true);
          },
        });
      },
      end() {
        client.ended = true;
        return Promise.resolve();
      },
    };
  };
  return { open, clients };
}

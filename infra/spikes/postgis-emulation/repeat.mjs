// Spike T-1125: run bench.mjs N times in a row (default 10); print each line, medians and the number of differing digests.
import { spawnSync } from 'node:child_process';

const n = Number(process.argv[2] ?? 10);
const runs = [];
for (let i = 0; i < n; i++) {
  const r = spawnSync('node', ['infra/spikes/postgis-emulation/bench.mjs'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(`run ${i + 1} failed: ${r.stderr.trim().slice(0, 300)}`);
    continue;
  }
  const o = JSON.parse(r.stdout);
  runs.push(o);
  console.log(JSON.stringify(o));
}
const median = (k) => {
  const v = runs.map((o) => o[k]).sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
const digests = new Set(runs.map((o) => o.result_digest));
console.log(
  JSON.stringify({
    runs: runs.length,
    failed: n - runs.length,
    differences: digests.size - 1,
    median_migrate_ms: median('migrate_ms'),
    median_exclude_2000_inserts_ms: median('exclude_2000_inserts_ms'),
    median_exclude_refusal_ms: median('exclude_refusal_ms'),
    median_distance_25_queries_ms: median('distance_25_queries_ms'),
  }),
);

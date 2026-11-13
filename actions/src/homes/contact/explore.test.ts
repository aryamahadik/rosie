// TEMPORARY exploration (never committed): writes what the emitted flows hold for S13-19 to the scratchpad.
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { emittedFlows, objAt } from "../registry/test-support";

const OUT =
  "/private/tmp/claude-501/-Users-aryamahadik-Downloads-Rosfield-Main-rosie/d9982744-6798-4bc7-ad8e-3fc2a5092574/scratchpad/explore.txt";

it("explore", async () => {
  const flows = await emittedFlows();
  const out: string[] = [];
  const log = (...parts: unknown[]): void => {
    out.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
  };
  for (const flow of ["A", "B"] as const) {
    const graph = flows[flow];
    const step = objAt(graph, ["steps", "S13-19"]);
    log(flow, "S13-19 keys", Object.keys(step));
    log(flow, "S13-19", JSON.stringify(step, null, 1).slice(0, 9000));
    log(flow, "slots reach.way", objAt(graph, ["record", "slots", "reach.way"]));
    log(flow, "slots reach.to", objAt(graph, ["record", "slots", "reach.to"]));
    const steps = objAt(graph, ["steps"]);
    const follows: string[] = [];
    for (const [id, raw] of Object.entries(steps)) {
      const s = raw as Record<string, unknown>;
      const reads = Array.isArray(s.reads) ? (s.reads as string[]) : [];
      if (reads.includes("contact")) follows.push(id);
      const words = JSON.stringify(s);
      for (const needle of [
        "Private booking",
        "reach them only",
        "{{reach.",
        "Texts only:",
        "Email only:",
        "Calls only:",
      ]) {
        const at = words.indexOf(needle);
        if (at >= 0) log(flow, id, "has", needle, words.slice(Math.max(0, at - 300), at + 300));
      }
    }
    log(flow, "follows contact", follows.length, follows.join(" "));
    log(flow, "record keys", Object.keys(objAt(graph, ["record"])));
    log(flow, "graph keys", Object.keys(graph));
  }
  writeFileSync(OUT, out.join("\n"));
});

// A sample double for the loader's own tests (T-003). "sample" is not a real port: the exports below invent no
// port's interface. They only give the loader a module with known exports to find.

export const SAMPLE_PORT = "sample";

/** A double that records what it is given. */
export function createSampleDouble(): { readonly calls: string[]; call(input: string): string } {
  const calls: string[] = [];
  return {
    calls,
    call(input: string): string {
      calls.push(input);
      return `sample:${input}`;
    },
  };
}

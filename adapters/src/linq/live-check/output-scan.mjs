// The number scan the live check's test reads every line of run.mjs's output with (T-417; the card's lead note item 4:
// "a test scans run.mjs's output for any key shape or any whole number"): the repository's own phone scan
// (infra/ci/phone-scan.mjs, T-1317, which CI reads every tracked file with), finding a phone number written in any form,
// fiction or not. For the test alone, so the scan is never the code under test: run.mjs and logs.mjs never import it.
export { phoneNumbersIn } from "../../../../infra/ci/phone-scan.mjs";

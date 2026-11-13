// The phone scan's named exceptions (T-1317; phone-scan.mjs, run by phone-scan.test.mjs). Each entry is a
// deliberate input a tracked file holds outside the fiction ranges, with its file, its kind and why it is no real
// number. A listed number passes only at its own file. A number that could be someone's is never listed here: it
// is a finding for its file's owner, who swaps it for a fiction-range one.
//
// A number is written as the scan reads it, in E.164 order, with an underscore after the country code and between
// its groups, so this file holds nothing the scan reads as a number (the scan reads this file too). The kinds,
// which phone-scan.test.mjs checks against the digits:
//   - "impossible code": +1, then an area code or an exchange that starts with 0 or 1, which the plan never gives;
//   - "555 exchange": +1, area code 555, then exchange 555 with a line outside the fiction block. Area code 555
//     serves no area at all, so no one's line is under it. In a real area code such a line may be a person's: since
//     NANPA's 2016 change, a 555 line there outside the fiction block can be assigned (T-1344's security note a), so
//     the kind takes area code 555 only (T-1359). Never the directory-assistance line or the one national-use line
//     NANPA kept (DL-632, T-1344);
//   - "wrong length": +1 and the first 6, 8 or 9 digits of a fiction-block number, such as the block's first digits
//     written before a template's last ones, so only a fiction number, or one under area code 555, begins with them,
//     never a real number's first digits (DL-636's reason, T-1359): area code 555 and exchange 555; or an area code
//     the fiction range takes (not a toll-free one), exchange 555 and the line's 01, with one more digit or none.
//     Never seven, a local number's length (DL-636), and never ten or more (T-1344);
//   - "not a phone number": digits that are no number in their file (an integer, a digest, a coordinate, a count),
//     each named in its why;
//   - "public line" (DL-616): one of PUBLIC_LINES below, a published public service line, never a person's number,
//     which the master's own trade text gives a customer. The master is never edited, so each is listed only at the
//     files that hold it: the master's trade files, the forms built from them, and the two files that quote them.

const MASTER_PROF = "fixtures/master/engine/work/prof/";
const FORMS = "fixtures/v1/forms/";

/** The public service lines the master's trade text names (DL-616): each line, its operator and its number. */
export const PUBLIC_LINES = {
  poisonHelp: {
    name: 'Poison Help (the master\'s "Poison Control")',
    operator: "America's Poison Centers, funded by the U.S. Health Resources and Services Administration",
    number: "+1_800_222_1222",
  },
  domesticViolence: {
    name: "the National Domestic Violence Hotline",
    operator:
      "the National Domestic Violence Hotline, funded by the U.S. Department of Health and Human Services",
    number: "+1_800_799_7233",
  },
  elderFraud: {
    name: "the National Elder Fraud Hotline",
    operator: "the U.S. Department of Justice's Office for Victims of Crime",
    number: "+1_833_372_8311",
  },
  housingCounseling: {
    name: "HUD's housing counseling line",
    operator: "the U.S. Department of Housing and Urban Development",
    number: "+1_800_569_4287",
  },
};

const FICTION_PREFIX =
  "the fiction block's first digits (+1, area code 555, exchange 555, and the line's 01 when shown) before a " +
  "template's or a sentence's last digits: too short for any +1 number";
const BASIS_DIGEST =
  "a master fixture's own text: a ten-character hex digest in the trade's basis (basis > A or B, by line id) whose " +
  "characters happen to be all decimal digits";
const MODULUS_2_31 = "2^31, the modulus of the test's seeded random generator: an integer";
const DIVISOR_2_32 = "2^32, the divisor that turns a mulberry32 random generator's output into a fraction";

/** The first digits of the fiction block before a template's or a sentence's last digits, in one file. */
const prefix = (file, ...numbers) => ({ file, kind: "wrong length", numbers, why: FICTION_PREFIX });

/** A master trade file's basis digests that read as numbers. */
const digests = (trade, ...numbers) => ({
  file: `${MASTER_PROF}${trade}.json`,
  kind: "not a phone number",
  numbers,
  why: BASIS_DIGEST,
});

/** A public line at one file, whose text is `source` (the master's own, or taken from it). */
const publicLine = (file, line, source) => ({
  file,
  kind: "public line",
  numbers: [line.number],
  why: `${line.name}, operated by ${line.operator}: ${source}; a public service line, not a person's number`,
});

/** A public line in master trade files and in the forms built from them, by trade. */
const trades = (line, ...names) =>
  names.flatMap((trade) => [
    publicLine(`${MASTER_PROF}${trade}.json`, line, "the master's own trade text"),
    publicLine(`${FORMS}${trade}.json`, line, "a form built from the master's own trade text"),
  ]);

export const EXCEPTIONS = [
  // Test values a check must refuse, and placeholders the plan never gives.
  {
    file: "adapters/src/linq/double-webhooks/webhooks.test.ts",
    kind: "555 exchange",
    numbers: ["+1_555_555_1234"],
    why: "the webhook double's refusal tests: a line outside the fiction block under area code 555 (no area), so the double answers notFictionalPhone",
  },
  {
    file: "adapters/src/linq/double-webhooks/webhooks.test.ts",
    kind: "impossible code",
    numbers: ["+1_123_555_0100"],
    why: "NO_SUCH_LINE, the webhook double's refused handle: area code 123",
  },
  {
    file: "adapters/src/linq/double/double.ts",
    kind: "impossible code",
    numbers: ["+1_000_000_0000"],
    why: "the Linq double's all-zero placeholder phone: area code and exchange 000",
  },
  {
    file: "adapters/src/shared/samples.test.ts",
    kind: "555 exchange",
    numbers: ["+1_555_555_9999", "+1_555_555_9998"],
    why: "the sample loader's refusal tests: lines outside the fiction block under area code 555 (no area), refused unless the caller allows them",
  },
  {
    file: "db/repo/phones.int.test.ts",
    kind: "555 exchange",
    numbers: [
      "+1_555_555_0000",
      "+1_555_555_8001",
      "+1_555_555_8002",
      "+1_555_555_8999",
      "+1_555_555_9001",
      "+1_555_555_9002",
      "+1_555_555_9003",
      "+1_555_555_9004",
      "+1_555_555_9005",
    ],
    why: "handle, phone and stop test addresses under area code 555 (no area) and exchange 555",
  },
  {
    file: "db/repo/reservations.int.test.ts",
    kind: "555 exchange",
    numbers: ["+1_555_555_9999"],
    why: "a refused for_phone_number test value under area code 555 (no area) and exchange 555",
  },
  {
    file: "db/repo/threads.int.test.ts",
    kind: "555 exchange",
    numbers: ["+1_555_555_9101"],
    why: "a chat test handle's address under area code 555 (no area) and exchange 555",
  },
  {
    file: "tests/contract/data-access.v1.test.ts",
    kind: "555 exchange",
    numbers: ["+1_555_555_0200", "+1_555_555_1234"],
    why: "the cast check's refusal tests: lines outside the fiction block under area code 555 (no area), which the check must name",
  },
  {
    file: "tests/contract/db-schema.core.v1.test.ts",
    kind: "555 exchange",
    numbers: ["+1_555_555_0200"],
    why: "the cast check's refusal test: a line outside the fiction block, which the check must name",
  },
  {
    file: "infra/ci/wrangler-env.test.mjs",
    kind: "impossible code",
    numbers: ["+1_055_555_0142", "+1_155_555_0142"],
    why: "T-1304's planted inputs: area codes 055 and 155",
  },
  {
    file: "infra/ci/phone-scan.test.mjs",
    kind: "impossible code",
    numbers: ["+1_055_555_0142"],
    why: "this scan's own planted input: area code 055",
  },
  {
    file: "infra/ci/phone-scan.test.mjs",
    kind: "555 exchange",
    numbers: ["+1_555_555_0200"],
    why: "this scan's own planted input in the separated shapes: area code 555 (no area), line 0200",
  },

  // The fiction block's first digits, before the line a template or a sentence adds.
  prefix("actions/src/domain/reservations/reservations.test.ts", "+1_555555"),
  prefix("actions/src/frontier/facts/facts.test.ts", "+1_555555"),
  prefix("actions/src/gate/flags/flags.test.ts", "+1_555555"),
  prefix("actions/src/page-calls/staging/test-phone/test-support.ts", "+1_555555"),
  prefix("actions/src/page-calls/staging/test-state/test-state.worker.test.ts", "+1_555555"),
  prefix("actions/src/page-calls/staging/test-state/test-support.ts", "+1_555555"),
  prefix("contracts/port-linq/README.md", "+1_55555501"),
  prefix("db/repo/outbox.int.test.ts", "+1_555555"),
  prefix("db/repo/phones.int.test.ts", "+1_555555"),
  prefix("db/repo/turn-face-reads.int.test.ts", "+1_555555", "+1_55555501"),
  prefix("db/seeds/lib/roster.int.test.ts", "+1_555555"),
  prefix("db/seeds/lib/roster.test.ts", "+1_555555"),
  prefix("db/seeds/lib/roster.ts", "+1_555555"),
  prefix("db/seeds/staging-core.int.test.ts", "+1_555555"),
  prefix("db/seeds/staging-core.ts", "+1_555555"),
  prefix("infra/ci/deploy-staging.test.mjs", "+1_55555501"),
  prefix("runtime/src/gateway/chat-open.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop4.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop5.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop6.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop7.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop8.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop9.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop10.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop11.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop12.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/hop13.worker.test.ts", "+1_555555"),
  prefix("runtime/src/wiring/kept-results.worker.test.ts", "+1_55555501"),
  prefix("runtime/src/wiring/test-phone/line.cap.worker.test.ts", "+1_55555501"),
  {
    file: "db/seeds/lib/demo-shops.ts",
    kind: "wrong length",
    numbers: ["+1_31255501", "+1_41555501"],
    why: "two demo shops' fiction blocks (area codes 312 and 415, exchange 555, line 01xx) written without their last two digits",
  },

  // Digits that are no number at all in their file.
  {
    file: "COMMIT_HISTORY.md",
    kind: "not a phone number",
    numbers: ["+1_229721"],
    why: "a count of lines added, in one commit's file summary",
  },
  {
    file: "ai/src/cache/layout.test.ts",
    kind: "not a phone number",
    numbers: ["+1_214_748_3648"],
    why: MODULUS_2_31,
  },
  {
    file: "ai/src/context/context.test.ts",
    kind: "not a phone number",
    numbers: ["+1_214_748_3648"],
    why: MODULUS_2_31,
  },
  {
    file: "ai/src/context/seed.ts",
    kind: "not a phone number",
    numbers: ["+1_429_496_7296"],
    why: DIVISOR_2_32,
  },
  {
    file: "runtime/src/dispatch/limit8/limit8.worker.test.ts",
    kind: "not a phone number",
    numbers: ["+1_429_496_7296"],
    why: DIVISOR_2_32,
  },
  {
    file: "runtime/src/dispatch/limit8/texts-yes.worker.test.ts",
    kind: "not a phone number",
    numbers: ["+1_429_496_7296"],
    why: DIVISOR_2_32,
  },
  {
    file: "runtime/src/guard/replies/replies.worker.test.ts",
    kind: "not a phone number",
    numbers: ["+1_429_496_7296"],
    why: DIVISOR_2_32,
  },
  {
    file: "runtime/src/scrub/scrub.test.ts",
    kind: "not a phone number",
    numbers: ["+1_429_496_7296"],
    why: DIVISOR_2_32,
  },
  ...["_", "_privacy", "_terms"].map((name) => ({
    file: `infra/rosfield-test-backup/assets/${name}`,
    kind: "not a phone number",
    numbers: ["+1_239_630_2446"],
    why: 'the fraction digits of one coordinate in the saved page\'s inline SVG path (d="M...")',
  })),
  digests("advisor", "+1_755_629_0726", "+1_915_796_2406"),
  digests("baker", "+1_307_624_2203"),
  digests("boarding", "+1_307_624_2203"),
  digests("dance", "+1_307_624_2203"),
  digests("daycare", "+1_307_624_2203"),
  digests("driving-school", "+1_307_624_2203"),
  digests("fertility", "+1_434_503_6419"),
  digests("flight-school", "+1_434_503_6419"),
  digests("funeral", "+1_915_796_2406"),
  digests("golf-instructor", "+1_434_503_6419"),
  digests("horse-riding", "+1_434_503_6419"),
  digests("hypnotherapist", "+1_434_503_6419"),
  digests("lab", "+1_434_503_6419"),
  digests("naturopath", "+1_949_779_5524"),
  digests("notary", "+1_307_624_2203"),
  digests("obgyn", "+1_434_503_6419"),
  digests("property-manager", "+1_755_629_0726", "+1_427_756_2337", "+1_307_624_2203"),
  digests("realtor", "+1_427_756_2337", "+1_949_779_5524", "+1_307_624_2203"),
  digests("recording-studio", "+1_434_503_6419"),
  digests("reiki", "+1_434_503_6419"),
  digests("restoration", "+1_427_756_2337", "+1_949_779_5524"),
  digests("senior-living", "+1_427_756_2337", "+1_949_779_5524", "+1_307_624_2203"),
  digests("shooting", "+1_434_503_6419"),
  digests("sitter", "+1_307_624_2203"),
  digests("ski-instructor", "+1_434_503_6419"),
  digests("sleep-clinic", "+1_434_503_6419"),
  digests("snow", "+1_307_624_2203"),
  digests("sports-coach", "+1_434_503_6419"),
  digests("spray-tan", "+1_434_503_6419"),
  digests("tax", "+1_434_503_6419", "+1_307_624_2203"),
  digests("teeth-whitening", "+1_434_503_6419"),
  digests("towing", "+1_307_624_2203"),
  digests("tutor", "+1_434_503_6419"),
  digests("weight-loss", "+1_949_779_5524"),
  digests("wellness-studio", "+1_434_503_6419"),

  // Public service lines the master's trade text names (DL-616), and the two files that quote that text.
  ...trades(
    PUBLIC_LINES.poisonHelp,
    "allergist",
    "cardiologist",
    "credit-counselor",
    "dentist",
    "dermatologist",
    "doula",
    "endocrinologist",
    "ent",
    "gastroenterologist",
    "hair-restoration",
    "iv-hydration",
    "lactation",
    "lawn",
    "midwife",
    "neurologist",
    "ophthalmologist",
    "optometrist",
    "oral-surgeon",
    "orthodontist",
    "orthopedist",
    "painter",
    "pediatrician",
    "pest",
    "pharmacist",
    "plastic-surgeon",
    "pool",
    "pressure",
    "primary-care",
    "psychic",
    "senior-living",
    "urgent-care",
    "urologist",
  ),
  ...trades(
    PUBLIC_LINES.domesticViolence,
    "immigration-services",
    "lawyer",
    "mediator",
    "movers",
    "private-investigator",
  ),
  ...trades(PUBLIC_LINES.elderFraud, "advisor", "insurance"),
  ...trades(PUBLIC_LINES.housingCounseling, "mortgage"),
  ...[PUBLIC_LINES.poisonHelp, PUBLIC_LINES.housingCounseling].map((line) =>
    publicLine("fixtures/v1/KNOWN-STALE.md", line, "a note quoting the master's own trade text"),
  ),
  ...[PUBLIC_LINES.domesticViolence, PUBLIC_LINES.elderFraud].map((line) =>
    publicLine(
      "compiler/src/slots/slots.test.ts",
      line,
      "the master's own trade text, quoted as a line the slot fill must leave alone",
    ),
  ),
];

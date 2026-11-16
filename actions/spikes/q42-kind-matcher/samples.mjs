// The sample words the spike measures (T-631's lead note: sample words only from S1-02, A4-03, B4-04 and the master's
// cast; fiction, never a real name or number, rule 9). Each sample names its step and what the step's words make its
// right answer, the kinds it should fit by K-24 id:
//   one kind   listed, that kind
//   two kinds  "which?" first, both (A4-03's and B4-04's rule: "if the words fit two kinds of work, the AI asks which
//              one first")
//   none       no kind: S1-02's "Not a service we book" (RULES 1.4), which K-09 answers new_work or not_booked
//
// Steps are printed from the read-only master copy (`node scratch/master-copy/engine/work/build/step.js <flow> <step>`,
// with `--prof <trade>` for a trade's own words); the cast's words are master-A.json's and master-B.json's own.

/** The kinds a sample's words should fit, and where they come from. */
export const SAMPLES = [
  // S1-02, flow A: "Sam types the kinds of work in any words"; K-24 v1's seed-business-kinds.json picks these three.
  {
    group: "S1-02",
    words: "Barbershop",
    fits: ["barber"],
    source: "S1-02 (owner → san); K-24 seed-business-kinds",
  },
  {
    group: "S1-02",
    words: "plumbing",
    fits: ["plumber"],
    source: "S1-02 (owner → san); K-24 seed-business-kinds",
  },
  {
    group: "S1-02",
    words: "electrical",
    fits: ["electrician"],
    source: "S1-02 (owner → san); K-24 seed-business-kinds",
  },
  // S1-02's "Means 'Not a service we book'" and "Gift cards are never set up either" (RULES 1.4).
  { group: "S1-02", words: "Gift cards", fits: [], source: "S1-02 'Gift cards are never set up'" },
  { group: "S1-02", words: "goods with no visit", fits: [], source: "S1-02 'Not a service we book'" },
  { group: "S1-02", words: "delivery only", fits: [], source: "S1-02 'Not a service we book'" },
  { group: "S1-02", words: "renting a thing alone", fits: [], source: "S1-02 'Not a service we book'" },

  // S1-02's answer as nine trade files word it (`step.js A S1-02 --prof <trade>`: the owner's line renamed), each part
  // that names one kind; parts that name no kind clearly ("parties", "lifeguards", "event lighting") are left out.
  { group: "S1-02 trades", words: "Overnight camp", fits: ["camp"], source: "S1-02 --prof camp" },
  { group: "S1-02 trades", words: "backyard camps", fits: ["camp"], source: "S1-02 --prof camp" },
  {
    group: "S1-02 trades",
    words: "Golf academy",
    fits: ["golf-instructor"],
    source: "S1-02 --prof golf-instructor",
  },
  {
    group: "S1-02 trades",
    words: "golf lessons",
    fits: ["golf-instructor"],
    source: "S1-02 --prof golf-instructor",
  },
  {
    group: "S1-02 trades",
    words: "course coaching",
    fits: ["golf-instructor"],
    source: "S1-02 --prof golf-instructor",
  },
  { group: "S1-02 trades", words: "party rentals", fits: ["rentals"], source: "S1-02 --prof rentals" },
  {
    group: "S1-02 trades",
    words: "Ski school",
    fits: ["ski-instructor"],
    source: "S1-02 --prof ski-instructor",
  },
  {
    group: "S1-02 trades",
    words: "ski lessons",
    fits: ["ski-instructor"],
    source: "S1-02 --prof ski-instructor",
  },
  {
    group: "S1-02 trades",
    words: "snowboard lessons",
    fits: ["ski-instructor"],
    source: "S1-02 --prof ski-instructor",
  },
  {
    group: "S1-02 trades",
    words: "private coaching",
    fits: ["sports-coach"],
    source: "S1-02 --prof sports-coach",
  },
  { group: "S1-02 trades", words: "Surf school", fits: ["surf-school"], source: "S1-02 --prof surf-school" },
  { group: "S1-02 trades", words: "Swim school", fits: ["swim"], source: "S1-02 --prof swim" },
  { group: "S1-02 trades", words: "Training studio", fits: ["trainer"], source: "S1-02 --prof trainer" },
  { group: "S1-02 trades", words: "personal training", fits: ["trainer"], source: "S1-02 --prof trainer" },
  { group: "S1-02 trades", words: "massage", fits: ["massage"], source: "S1-02 --prof trainer" },

  // A4-03, flow A: the master's own words, and the barbershop's (`step.js A A4-03 --prof barber`).
  { group: "A4-03", words: "haircut", fits: ["hair", "barber"], source: "A4-03 'a salon or a barbershop'" },
  {
    group: "A4-03",
    words: "facial",
    fits: ["barber", "esthetician"],
    source: "A4-03 --prof barber 'a barbershop or a skin care studio'",
  },

  // B4-04, flow B: the plumbing plug-in's questions, and the plumber's own words (`step.js B B4-04 --prof plumber`).
  { group: "B4-04", words: "clog", fits: ["plumber"], source: "B4-04 'where the clog or leak is'" },
  { group: "B4-04", words: "leak", fits: ["plumber"], source: "B4-04 'where the clog or leak is'" },
  {
    group: "B4-04",
    words: "water heater",
    fits: ["plumber", "hvac"],
    source: "B4-04 --prof plumber 'a plumber or a heating tech'",
  },

  // The master's cast, flow A (Lee's Barbershop; Riley and Avery, barbers): the customer's and their AI's requests.
  {
    group: "cast",
    words: "Book me a haircut at Lee's Barbershop on Saturday.",
    fits: ["barber"],
    source: "A3-02",
  },
  { group: "cast", words: "Walk-in for a haircut", fits: ["hair", "barber"], source: "A3-20 (A4-03's rule)" },
  {
    group: "cast",
    words: "Can Lee's Barbershop do a haircut on Saturday morning? What does it cost?",
    fits: ["barber"],
    source: "A3-27",
  },
  // ...and the sample story's services (master-A.json amounts), all Lee's Barbershop's. A cut, a color or a style a
  // salon gives too fits two kinds by A4-03's rule; a shave and the groom's package are the barbershop's alone.
  { group: "cast", words: "Groom's package", fits: ["barber"], source: "master-A amounts" },
  { group: "cast", words: "Signature cut and hot towel shave", fits: ["barber"], source: "master-A amounts" },
  {
    group: "cast",
    words: "Style consult",
    fits: ["hair", "barber"],
    source: "master-A amounts (A4-03's rule)",
  },
  {
    group: "cast",
    words: "Color and cut",
    fits: ["hair", "barber"],
    source: "master-A amounts (A4-03's rule)",
  },
  {
    group: "cast",
    words: "Color touch-up",
    fits: ["hair", "barber"],
    source: "master-A amounts (A4-03's rule)",
  },
  {
    group: "cast",
    words: "Color correction",
    fits: ["hair", "barber"],
    source: "master-A amounts (A4-03's rule)",
  },

  // The master's cast, flow B (Lee Home Services; Jordan and Casey, plumbers): the customer's and their AI's requests.
  {
    group: "cast",
    words: "My kitchen drain is clogged. Can a plumber come Thursday morning? I'm in Springfield.",
    fits: ["plumber"],
    source: "B3-02",
  },
  {
    group: "cast",
    words: "Hi, it's about a leaking pipe under my sink. A text back is fine.",
    fits: ["plumber"],
    source: "B3-42",
  },
  {
    group: "cast",
    words: "Can a plumber clear a yard drain this Thursday? What does it cost?",
    fits: ["plumber"],
    source: "B3-05",
  },
  {
    group: "cast",
    words: "Can you flush my water heater every year, too?",
    fits: ["plumber", "hvac"],
    source: "B4-44 (B4-04's rule)",
  },
  { group: "cast", words: "Can Jordan also look at a dripping faucet?", fits: ["plumber"], source: "B4-48" },
  // ...and the sample story's services (master-B.json amounts), all Lee Home Services'. A water heater fits two kinds
  // by B4-04's rule as the plumber words it.
  { group: "cast", words: "Kitchen drain clearing", fits: ["plumber"], source: "master-B amounts" },
  {
    group: "cast",
    words: "Water heater flush",
    fits: ["plumber", "hvac"],
    source: "master-B amounts (B4-04's rule)",
  },
  { group: "cast", words: "Water pressure check", fits: ["plumber"], source: "master-B amounts" },
  {
    group: "cast",
    words: "Water heater replacement",
    fits: ["plumber", "hvac"],
    source: "master-B amounts (B4-04's rule)",
  },
  {
    group: "cast",
    words: "Water heater fix",
    fits: ["plumber", "hvac"],
    source: "master-B amounts (B4-04's rule)",
  },
  { group: "cast", words: "Leak repair", fits: ["plumber"], source: "master-B amounts" },
];

/** The groups in report order; "two kinds" is every sample whose words fit two kinds, from any group. */
export const GROUPS = ["S1-02", "S1-02 trades", "A4-03", "B4-04", "cast"];

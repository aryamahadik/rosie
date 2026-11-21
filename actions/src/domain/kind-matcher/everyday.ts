// The everyday words table of the kind matcher (T-1518; DL-1042): the words owners use for a kind of work that the
// catalog's own words do not reach, each to the kind (or the two kinds, one "which?") an owner means. Run on all 243
// kinds (ops/reviews/kinds-guide/), the matcher read these words as the wrong kind ("mechanic" boat repair, "tow truck"
// food truck), as a "which?" between kinds that do not both fit ("salon", "gym", "haircuts") or as new work ("vet",
// "attorney", "cafe"), because K-24 v1's kinds rows hold no aliases (id, name, style, pattern, facts, source; 0021): so
// the table is kept beside the matcher, in code, and every entry names its catalog id.
//
// How the matcher reads it (matcher.ts): a part whose words are exactly an entry's words, compared by wordKey (words.ts:
// case, plurals, function words and punctuation do not matter, so "Vets", "We do haircuts" and "OBGYN" are read), lists
// the entry's one kind, or asks one "which?" between its two, closest first. A part with any other word is read as
// before (method A), so "auto mechanic", "vet clinic" and "upholstery cleaning" keep their outcomes, and every input the
// texting guide ran keeps its outcome but the words T-1518 names (kinds-guide.test.ts). Work Rosie never books is read
// first and stays not_booked, and a kind's own name is read before the table. An entry lists only kinds the catalog handed
// in offers; with neither of its kinds offered it reads nothing, and the part is read by method A.
//
// Each entry's why cites the catalog's own row (K-24 v1 kinds.name and style, db/seeds/kinds.ts catalogPlanOf) for the
// kind chosen, and for the kinds the word met before. A word that truly fits two kinds stays one "which?" between those two
// only ("eye doctor"). "spa" and "cleaning" are no entries: method A already asks one "which?" between two kinds that both
// fit them (Med spa or Day spa; Commercial and office cleaning or House cleaner).

/** One everyday word (or words) and the kinds it lists. */
export interface EverydayWord {
  /** The owner's words, as the texting guide typed them; read by wordKey, so their plural and case do not matter. */
  readonly words: string;
  /** K-24 v1 kinds.id of the 243 trade-file kinds: one (listed) or two (one "which?", closest first). */
  readonly kinds: readonly [string] | readonly [string, string];
  /** Why this kind, from the catalog's own rows. */
  readonly why: string;
}

/** The everyday words table (T-1518 Gives 2 and 3), in the card's order. */
export const EVERYDAY_WORDS: readonly EverydayWord[] = [
  // T-1518 Gives 2: words that listed the wrong kind.
  {
    words: "mechanic",
    kinds: ["auto-repair"],
    why: "Auto repair (Drop-off) is the trade a mechanic, said alone, works in; Boat repair and marine mechanic holds the word only as a marine mechanic",
  },
  {
    words: "car repair",
    kinds: ["auto-repair"],
    why: "Auto repair repairs cars; Car detailing (Set service) met only 'car', and it cleans cars, it does not repair them",
  },
  {
    words: "tow truck",
    kinds: ["towing"],
    why: "Towing & roadside (Urgent) is the tow truck's work; Food truck for events met only 'truck'",
  },
  {
    words: "heart doctor",
    kinds: ["cardiologist"],
    why: "Cardiologist (Clinic) is the heart doctor; Primary care doctor met only 'doctor'",
  },
  {
    words: "eye doctor",
    kinds: ["optometrist", "ophthalmologist"],
    why: "Optometrist and Ophthalmologist (both Clinic) are both eye doctors, so one 'which?' between those two only; Primary care doctor met only 'doctor'",
  },
  {
    words: "dental",
    kinds: ["dentist"],
    why: "Dentist (Clinic) is the dental office; Teeth whitening (non-dental studio) met 'dental' only inside 'non-dental'",
  },
  {
    words: "upholstery",
    kinds: ["upholstery"],
    why: "Furniture reupholstery and repair (Drop-off) is the upholstery trade; Carpet & upholstery cleaner cleans upholstery, and 'upholstery cleaning' still lists it",
  },
  {
    words: "house inspection",
    kinds: ["inspector"],
    why: "Home inspector (Set service) inspects houses; House cleaner met only 'house'",
  },
  {
    words: "home inspection",
    kinds: ["inspector"],
    why: "Home inspector does the home inspection; Home engineer (structural inspections) is the structural engineer's narrower inspection",
  },
  {
    words: "moving company",
    kinds: ["movers"],
    why: "Movers (Project) is the moving company; Estate sale company and auctioneer met only 'company'",
  },
  {
    words: "moving",
    kinds: ["movers"],
    why: "Movers is the moving trade; Senior move manager (Project) is the narrower one, and no catalog word met 'moving'",
  },
  {
    words: "vet",
    kinds: ["vet"],
    why: "Veterinarian (Clinic), whose id is vet; no catalog word met 'vet'",
  },
  {
    words: "attorney",
    kinds: ["lawyer"],
    why: "Lawyer (Consult): an attorney is a lawyer; no catalog word met 'attorney'",
  },
  {
    words: "karate",
    kinds: ["martial-arts"],
    why: "Martial arts school (Class) teaches karate; no catalog word met 'karate'",
  },
  {
    words: "roofing",
    kinds: ["roofer"],
    why: "Roofer (Project) does the roofing; no catalog word met 'roofing'",
  },
  {
    words: "fencing",
    kinds: ["fence"],
    why: "Fence installer (Project) does the fencing; the catalog holds no fencing-sport kind, and no catalog word met 'fencing'",
  },
  {
    words: "OBGYN",
    kinds: ["obgyn"],
    why: "OB-GYN (Clinic), whose id is obgyn; typed as one word, it met neither of the name's two words",
  },
  {
    words: "cafe",
    kinds: ["restaurant"],
    why: "Restaurant (Table) is the catalog's one kind that seats guests to eat and drink; Food truck for events and Caterer serve events; no catalog word met 'cafe'",
  },

  // T-1518 Gives 3: common words read as a "which?" between kinds that do not both fit.
  {
    words: "haircuts",
    kinds: ["hair"],
    why: "Hair salon (Chair), whose name word 'hair' starts 'haircut', as the card rules; Hair restoration clinic (Clinic) restores hair, it does not cut it",
  },
  {
    words: "salon",
    kinds: ["hair"],
    why: "Hair salon is the salon said alone; Nail salon (Chair) is the salon its name narrows to nails",
  },
  {
    words: "gym",
    kinds: ["gym"],
    why: "Gym & fitness classes (Class) is the gym said alone; Climbing gym and Gymnastics and cheer gym are the gyms their names narrow",
  },
  {
    words: "realtor",
    kinds: ["realtor"],
    why: "Real estate agent (Consult), whose id is realtor; Real estate appraiser values a home, it does not sell it",
  },
  {
    words: "daycare",
    kinds: ["daycare"],
    why: "Daycare center (Class) is the daycare said alone; Pet boarding and doggy daycare is the pets' daycare its name narrows to dogs",
  },
  {
    words: "makeup",
    kinds: ["makeup"],
    why: "Makeup artist (Event) is the makeup said alone; Permanent makeup / microblading (Chair) is the makeup its name narrows",
  },
  {
    words: "contractor",
    kinds: ["contractor"],
    why: "General contractor (Project) is the contractor said alone; the concrete, demolition, insulation and siding contractors are the trades their names narrow",
  },
];

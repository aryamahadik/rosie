# Test coverage map

Generated Sat Nov 07 2026 02:15 from 243 profession files and the master (work/phase4/tools/test-kit.js).

Shops: shops/<id>.json (one per profession) + shops/test-mixed-A.json and test-mixed-B.json (combos no profession uses + a mixed booking).

## Money combos (56: 28 per flow)

Covered by professions: 46 of 56. Covered only by the test-mixed shops: 10.

| flow | combo (price · before · after) | shops | examples |
|---|---|---|---|
| A | From the price list · Nothing taken · Nothing more (`list|none|none`) | 26 | aquarium, biohazard, camp, doula |
| A | From the price list · Nothing taken · At the counter (`list|none|counter`) | 172 | acupuncturist, addiction, advisor, allergist |
| A | From the price list · Nothing taken · Rosie texts the bill (`list|none|bill`) | 30 | aba, addiction, airport-shuttle, auto-repair |
| A | From the price list · Card saved · At the counter (`list|card|counter`) | 141 | acupuncturist, allergist, appliance, appraiser |
| A | From the price list · Card saved · Rosie texts the bill (`list|card|bill`) | 2 | dog-trainer, massage |
| A | From the price list · Card saved · Saved card charged (`list|card|card`) | 40 | aba, acupuncturist, addiction, appraiser |
| A | From the price list · A deposit · At the counter (`list|deposit|counter`) | 87 | architect, art-appraiser, axe-throwing, band |
| A | From the price list · A deposit · Rosie texts the bill (`list|deposit|bill`) | 4 | escape-room, fertility, tires, window-tint |
| A | From the price list · A deposit · Saved card charged (`list|deposit|card`) | 8 | baker, camp, caterer, daycare |
| A | From the price list · Full price · Nothing more (`list|full|none`) | 152 | addiction, airport-shuttle, appliance, appraiser |
| A | Quoted from photos first · Nothing taken · Nothing more (`photos|none|none`) | 2 | architect, art-appraiser |
| A | Quoted from photos first · Nothing taken · At the counter (`photos|none|counter`) | 17 | auto-body, carpet, cleaner, commercial-cleaning |
| A | Quoted from photos first · Nothing taken · Rosie texts the bill (`photos|none|bill`) | 1 | auto-body |
| A | Quoted from photos first · Card saved · At the counter (`photos|card|counter`) | 32 | appliance, band, caterer, chimney |
| A | Quoted from photos first · Card saved · Rosie texts the bill (`photos|card|bill`) | test-mixed-A |  |
| A | Quoted from photos first · Card saved · Saved card charged (`photos|card|card`) | 1 | cpa |
| A | Quoted from photos first · A deposit · At the counter (`photos|deposit|counter`) | 11 | auto-body, college-admissions, hair, matchmaker |
| A | Quoted from photos first · A deposit · Rosie texts the bill (`photos|deposit|bill`) | 6 | architect, art-appraiser, auto-body, officiant |
| A | Quoted from photos first · A deposit · Saved card charged (`photos|deposit|card`) | 3 | baker, image-consultant, personal-shopper |
| A | Quoted from photos first · Full price · Nothing more (`photos|full|none`) | 2 | face-painter, translator |
| A | Quoted at the visit · Nothing taken · At the counter (`visit|none|counter`) | 41 | appliance, auto-repair, bike-repair, boat-repair |
| A | Quoted at the visit · Nothing taken · Rosie texts the bill (`visit|none|bill`) | 11 | auto-repair, biohazard, boat-repair, funeral |
| A | Quoted at the visit · Card saved · At the counter (`visit|card|counter`) | 25 | appliance, caterer, chimney, closets |
| A | Quoted at the visit · Card saved · Rosie texts the bill (`visit|card|bill`) | test-mixed-A |  |
| A | Quoted at the visit · Card saved · Saved card charged (`visit|card|card`) | test-mixed-A |  |
| A | Quoted at the visit · A deposit · At the counter (`visit|deposit|counter`) | 6 | esthetician, hair, medspa, tattoo |
| A | Quoted at the visit · A deposit · Rosie texts the bill (`visit|deposit|bill`) | test-mixed-A |  |
| A | Quoted at the visit · A deposit · Saved card charged (`visit|deposit|card`) | test-mixed-A |  |
| B | From the price list · Nothing taken · Nothing more (`list|none|none`) | 2 | insurance, senior-living |
| B | From the price list · Nothing taken · Rosie texts the bill (`list|none|bill`) | 104 | aba, addiction, airport-shuttle, allergist |
| B | From the price list · Nothing taken · Business's own way (`list|none|own`) | 56 | aba, acupuncturist, addiction, advisor |
| B | From the price list · Card saved · Rosie texts the bill (`list|card|bill`) | 80 | acupuncturist, appliance, aquarium, architect |
| B | From the price list · Card saved · Saved card charged (`list|card|card`) | 115 | aba, acupuncturist, addiction, airport-shuttle |
| B | From the price list · Card saved · Business's own way (`list|card|own`) | 4 | auto-glass, inspector, lawyer, locksmith |
| B | From the price list · A deposit · Rosie texts the bill (`list|deposit|bill`) | 26 | chimney, climbing-gym, commercial-cleaning, detailing |
| B | From the price list · A deposit · Saved card charged (`list|deposit|card`) | 31 | architect, art-appraiser, axe-throwing, baker |
| B | From the price list · A deposit · Business's own way (`list|deposit|own`) | 1 | magician |
| B | From the price list · Full price · Nothing more (`list|full|none`) | 112 | airport-shuttle, appliance, appraiser, architect |
| B | Quoted from photos first · Nothing taken · Nothing more (`photos|none|none`) | test-mixed-B |  |
| B | Quoted from photos first · Nothing taken · Rosie texts the bill (`photos|none|bill`) | 2 | auto-body, tax |
| B | Quoted from photos first · Nothing taken · Business's own way (`photos|none|own`) | test-mixed-B |  |
| B | Quoted from photos first · Card saved · Rosie texts the bill (`photos|card|bill`) | 3 | carpet, credit-counselor, junk |
| B | Quoted from photos first · Card saved · Saved card charged (`photos|card|card`) | 8 | airport-shuttle, cleaner, home-care, inspector |
| B | Quoted from photos first · Card saved · Business's own way (`photos|card|own`) | test-mixed-B |  |
| B | Quoted from photos first · A deposit · Rosie texts the bill (`photos|deposit|bill`) | 91 | appliance, appraiser, aquarium, auto-repair |
| B | Quoted from photos first · A deposit · Saved card charged (`photos|deposit|card`) | 21 | baker, band, caterer, clown |
| B | Quoted from photos first · A deposit · Business's own way (`photos|deposit|own`) | test-mixed-B |  |
| B | Quoted from photos first · Full price · Nothing more (`photos|full|none`) | 1 | snow |
| B | Quoted at the visit · Nothing taken · Rosie texts the bill (`visit|none|bill`) | 37 | appliance, auto-body, biohazard, concrete |
| B | Quoted at the visit · Nothing taken · Business's own way (`visit|none|own`) | 30 | concrete, contractor, deck, demolition |
| B | Quoted at the visit · Card saved · Rosie texts the bill (`visit|card|bill`) | 64 | appliance, auto-repair, boat-repair, carpet |
| B | Quoted at the visit · Card saved · Saved card charged (`visit|card|card`) | 14 | aquarium, bike-repair, cleaner, duct-cleaning |
| B | Quoted at the visit · Card saved · Business's own way (`visit|card|own`) | 4 | closets, home-stager, interior, organizer |
| B | Quoted at the visit · A deposit · Rosie texts the bill (`visit|deposit|bill`) | 3 | appliance, medspa, tattoo |
| B | Quoted at the visit · A deposit · Saved card charged (`visit|deposit|card`) | 1 | medspa |
| B | Quoted at the visit · A deposit · Business's own way (`visit|deposit|own`) | test-mixed-B |  |

## Booking types (the 11 patterns in FRONTEND-SPEC.md section 3 and PROFESSION-MAP.md)

| pattern | shops | examples |
|---|---|---|
| chair | 29 | barber, dog-trainer, driving-school, esthetician, flight-school |
| class | 19 | art-classes, camp, climbing-gym, coding-classes, cooking-classes |
| clinic | 48 | aba, acupuncturist, addiction, allergist, cardiologist |
| consult | 25 | advisor, architect, art-appraiser, coach, college-admissions |
| dropoff | 19 | auto-body, auto-repair, bike-repair, boarding, boat-repair |
| event | 20 | baker, band, caterer, chef, clown |
| fix | 9 | appliance, electrician, garage-door, handyman, hvac |
| project | 28 | closets, concrete, contractor, deck, demolition |
| service | 35 | airport-shuttle, appraiser, aquarium, auto-glass, carpet |
| table | 7 | axe-throwing, escape-room, fishing-charter, hunting-guide, mini-golf |
| urgent | 4 | biohazard, locksmith, restoration, towing |

## Switches and facts (each must appear in at least one test)

- switch **cancelright**: 43 shops (e.g. biohazard, chimney, closets, concrete)
- switch **nomoney**: 2 shops (e.g. realtor, senior-living)
- switch **sensitive**: 61 shops (e.g. aba, acupuncturist, addiction, allergist)
- switch **welfare**: 32 shops (e.g. aba, allergist, cardiologist, concierge)
- fact **aftercare**: 27 shops (e.g. acupuncturist, dermatologist, dog-trainer, esthetician)
- fact **animals**: 12 shops (e.g. aquarium, boarding, dog-trainer, dog-walker)
- fact **banktransfer**: 28 shops (e.g. closets, concrete, contractor, deck)
- fact **capacitycheck**: 8 shops (e.g. axe-throwing, climbing-gym, florist, mini-golf)
- fact **children**: 86 shops (e.g. aba, acupuncturist, addiction, allergist)
- fact **classes**: 33 shops (e.g. aba, addiction, airport-shuttle, art-classes)
- fact **discounts**: 2 shops (e.g. escape-room, pilates)
- fact **documents**: 115 shops (e.g. appliance, appraiser, architect, art-appraiser)
- fact **dropoff**: 61 shops (e.g. appliance, aquarium, auto-body, auto-glass)
- fact **extrawork**: 174 shops (e.g. airport-shuttle, allergist, appliance, appraiser)
- fact **firststeps**: 138 shops (e.g. aba, acupuncturist, addiction, allergist)
- fact **forms**: 137 shops (e.g. aba, acupuncturist, addiction, allergist)
- fact **groups**: 47 shops (e.g. aba, addiction, art-classes, axe-throwing)
- fact **incare**: 12 shops (e.g. camp, dentist, enrichment, hearing)
- fact **monthlybill**: 11 shops (e.g. aba, airport-shuttle, aquarium, commercial-cleaning)
- fact **multiday**: 41 shops (e.g. auto-body, biohazard, boarding, camp)
- fact **nomoney**: 2 shops (e.g. realtor, senior-living)
- fact **packs**: 27 shops (e.g. climbing-gym, coach, credit-counselor, dance)
- fact **photos**: 91 shops (e.g. appliance, appraiser, aquarium, architect)
- fact **planbill**: 51 shops (e.g. aba, acupuncturist, addiction, allergist)
- fact **plans**: 57 shops (e.g. aba, addiction, airport-shuttle, aquarium)
- fact **results**: 24 shops (e.g. appliance, appraiser, biohazard, cpr-training)
- fact **sentnow**: 21 shops (e.g. aquarium, auto-body, auto-repair, biohazard)
- fact **spaces**: 21 shops (e.g. axe-throwing, boarding, climbing-gym, daycare)
- fact **stages**: 22 shops (e.g. chimney, concrete, contractor, deck)
- fact **tips**: 24 shops (e.g. carpet, chef, cleaner, dog-trainer)
- fact **video**: 101 shops (e.g. addiction, advisor, allergist, appliance)
- fact **waitlist**: 25 shops (e.g. art-classes, camp, chimney, climbing-gym)

## Mixed shops (3+ combos with different money ways in one flow: test a booking that adds them together)

- aba B (3 combos)
- acupuncturist A (3 combos)
- acupuncturist B (3 combos)
- addiction A (4 combos)
- addiction B (3 combos)
- airport-shuttle B (4 combos)
- appliance A (6 combos)
- appliance B (6 combos)
- appraiser A (4 combos)
- appraiser B (4 combos)
- aquarium A (3 combos)
- aquarium B (4 combos)
- architect A (5 combos)
- architect B (3 combos)
- art-appraiser A (5 combos)
- art-appraiser B (3 combos)
- auto-body A (5 combos)
- auto-repair A (4 combos)
- auto-repair B (4 combos)
- axe-throwing A (3 combos)
- axe-throwing B (3 combos)
- baker A (3 combos)
- baker B (3 combos)
- band A (5 combos)
- band B (4 combos)
- barber A (3 combos)
- barber B (3 combos)
- bike-repair A (4 combos)
- biohazard B (3 combos)
- boat-repair A (4 combos)
- boat-repair B (4 combos)
- camp A (3 combos)
- carpet A (5 combos)
- carpet B (5 combos)
- caterer A (7 combos)
- caterer B (7 combos)
- chimney A (6 combos)
- chimney B (5 combos)
- chiropractor B (3 combos)
- cleaner A (5 combos)
- cleaner B (4 combos)
- climbing-gym A (4 combos)
- closets A (4 combos)
- closets B (5 combos)
- clown A (5 combos)
- clown B (4 combos)
- coach B (3 combos)
- college-admissions A (4 combos)
- college-admissions B (4 combos)
- comedian A (5 combos)
- comedian B (4 combos)
- commercial-cleaning A (5 combos)
- commercial-cleaning B (5 combos)
- concrete A (4 combos)
- concrete B (4 combos)
- contractor A (4 combos)
- contractor B (4 combos)
- cpa A (3 combos)
- cpa B (3 combos)
- credit-counselor A (4 combos)
- credit-counselor B (3 combos)
- daycare A (3 combos)
- deck A (4 combos)
- deck B (4 combos)
- demolition A (4 combos)
- demolition B (4 combos)
- dentist A (5 combos)
- dentist B (5 combos)
- dermatologist A (3 combos)
- dietitian A (3 combos)
- dj A (5 combos)
- dj B (4 combos)
- dog-trainer A (3 combos)
- dog-trainer B (3 combos)
- dog-walker B (3 combos)
- doula A (4 combos)
- doula B (3 combos)
- driving-school A (3 combos)
- driving-school B (3 combos)
- drywall A (6 combos)
- drywall B (5 combos)
- duct-cleaning A (5 combos)
- duct-cleaning B (4 combos)
- electrician A (5 combos)
- electrician B (7 combos)
- energy-audit A (4 combos)
- energy-audit B (4 combos)
- enrichment A (3 combos)
- escape-room A (3 combos)
- estate-sale B (3 combos)
- esthetician A (5 combos)
- esthetician B (4 combos)
- event-staffing B (4 combos)
- excavation A (4 combos)
- excavation B (4 combos)
- face-painter A (5 combos)
- face-painter B (4 combos)
- farrier A (3 combos)
- farrier B (4 combos)
- fence B (3 combos)
- fertility A (4 combos)
- flight-school A (4 combos)
- flight-school B (3 combos)
- flooring A (6 combos)
- flooring B (6 combos)
- florist A (3 combos)
- food-truck B (4 combos)
- foundation A (4 combos)
- foundation B (4 combos)
- funeral A (3 combos)
- funeral B (3 combos)
- garage-door A (5 combos)
- garage-door B (7 combos)
- glass-doors A (4 combos)
- glass-doors B (4 combos)
- golf-instructor A (3 combos)
- groomer A (3 combos)
- groomer B (3 combos)
- gunsmith A (4 combos)
- gutters A (6 combos)
- gutters B (7 combos)
- gym B (3 combos)
- hair-restoration A (4 combos)
- hair A (7 combos)
- hair B (6 combos)
- handyman A (5 combos)
- handyman B (7 combos)
- hearing A (3 combos)
- hearing B (4 combos)
- holiday-lights B (6 combos)
- home-care A (4 combos)
- home-care B (4 combos)
- home-engineer A (4 combos)
- home-engineer B (4 combos)
- home-stager A (4 combos)
- home-stager B (5 combos)
- horse-riding A (3 combos)
- hunting-guide A (3 combos)
- hunting-guide B (3 combos)
- hvac A (6 combos)
- hvac B (7 combos)
- hypnotherapist A (3 combos)
- image-consultant A (4 combos)
- image-consultant B (4 combos)
- immigration-services A (3 combos)
- inspector A (4 combos)
- inspector B (5 combos)
- instrument-repair A (4 combos)
- instrument-repair B (4 combos)
- insulation A (4 combos)
- insulation B (4 combos)
- interior A (5 combos)
- interior B (6 combos)
- irrigation A (6 combos)
- irrigation B (5 combos)
- iv-hydration A (4 combos)
- junk A (4 combos)
- junk B (5 combos)
- lab A (3 combos)
- lab B (4 combos)
- lactation A (3 combos)
- lactation B (3 combos)
- laundry A (3 combos)
- lawn B (5 combos)
- lawyer A (5 combos)
- lawyer B (6 combos)
- limo B (4 combos)
- locksmith A (6 combos)
- locksmith B (6 combos)
- makeup A (4 combos)
- makeup B (4 combos)
- martial-arts B (3 combos)
- masonry A (4 combos)
- masonry B (4 combos)
- massage B (3 combos)
- matchmaker A (4 combos)
- matchmaker B (4 combos)
- mediator A (3 combos)
- mediator B (3 combos)
- medical-transport B (4 combos)
- medspa A (3 combos)
- midwife A (4 combos)
- midwife B (3 combos)
- mini-golf A (3 combos)
- mini-golf B (3 combos)
- motorcycle A (4 combos)
- motorcycle B (4 combos)
- movers A (5 combos)
- movers B (5 combos)
- music A (3 combos)
- nails A (5 combos)
- nails B (5 combos)
- obgyn A (3 combos)
- occupational-therapist B (3 combos)
- officiant A (5 combos)
- officiant B (4 combos)
- ophthalmologist A (6 combos)
- ophthalmologist B (4 combos)
- optometrist B (4 combos)
- oral-surgeon A (6 combos)
- oral-surgeon B (4 combos)
- organizer A (4 combos)
- organizer B (5 combos)
- orthodontist A (6 combos)
- orthodontist B (4 combos)
- pain-management B (3 combos)
- painter A (5 combos)
- painter B (5 combos)
- party-characters A (5 combos)
- party-characters B (4 combos)
- paving A (4 combos)
- paving B (4 combos)
- personal-shopper A (4 combos)
- personal-shopper B (4 combos)
- pest B (3 combos)
- pet-cremation A (3 combos)
- pet-cremation B (3 combos)
- pet-rehab A (3 combos)
- pet-sitter A (3 combos)
- pet-sitter B (4 combos)
- pet-taxi B (4 combos)
- pet-waste B (4 combos)
- photographer A (6 combos)
- photographer B (5 combos)
- physical-therapist A (3 combos)
- piano-tuner A (5 combos)
- piano-tuner B (6 combos)
- pilates B (4 combos)
- planner A (4 combos)
- plastic-surgeon A (4 combos)
- plumber A (6 combos)
- plumber B (6 combos)
- podiatrist A (3 combos)
- pool-builder B (3 combos)
- pool B (4 combos)
- pressure B (5 combos)
- private-investigator B (3 combos)
- psychiatrist A (3 combos)
- psychic A (4 combos)
- psychic B (3 combos)
- radon A (4 combos)
- radon B (4 combos)
- recording-studio A (4 combos)
- recording-studio B (3 combos)
- reiki A (3 combos)
- rentals A (3 combos)
- rentals B (3 combos)
- repair-shop A (5 combos)
- repair-shop B (4 combos)
- restaurant B (4 combos)
- restoration B (5 combos)
- roofer A (6 combos)
- roofer B (8 combos)
- rv-repair A (4 combos)
- rv-repair B (4 combos)
- security A (6 combos)
- security B (5 combos)
- senior-move B (3 combos)
- septic A (5 combos)
- septic B (6 combos)
- sharpening A (3 combos)
- sharpening B (4 combos)
- shoe-repair A (3 combos)
- shooting A (4 combos)
- shooting B (3 combos)
- siding A (6 combos)
- siding B (7 combos)
- sleep-clinic A (4 combos)
- small-engine A (4 combos)
- small-engine B (4 combos)
- snow A (4 combos)
- snow B (4 combos)
- spa B (3 combos)
- speech-therapist A (3 combos)
- sports-medicine B (3 combos)
- spray-tan B (3 combos)
- surveyor A (4 combos)
- surveyor B (4 combos)
- tailor A (4 combos)
- tattoo A (5 combos)
- tax A (4 combos)
- tax B (3 combos)
- teeth-whitening B (3 combos)
- tennis-coach A (3 combos)
- therapist A (3 combos)
- tires A (4 combos)
- tours A (4 combos)
- tours B (3 combos)
- trainer A (3 combos)
- trampoline-park A (3 combos)
- trampoline-park B (3 combos)
- translator B (3 combos)
- travel-agent A (4 combos)
- travel-agent B (4 combos)
- tree A (6 combos)
- tree B (5 combos)
- tutor A (3 combos)
- tv-repair B (3 combos)
- upholstery A (3 combos)
- upholstery B (3 combos)
- valet B (4 combos)
- vehicle-wrap A (4 combos)
- vehicle-wrap B (3 combos)
- vet A (5 combos)
- vet B (3 combos)
- watch-jewelry A (4 combos)
- watch-jewelry B (4 combos)
- well-pump A (6 combos)
- well-pump B (6 combos)
- wildlife A (5 combos)
- wildlife B (4 combos)
- window-tint A (4 combos)
- window-tint B (3 combos)
- windows B (6 combos)
- yoga A (7 combos)
- yoga B (6 combos)

## Money flags in the shop data (fix the profession file before testing)

- none


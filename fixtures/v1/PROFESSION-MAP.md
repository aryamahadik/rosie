# Profession map (made by script from work/prof/*.json)

Made by `node work/phase4/tools/frontend-map.js` on Sat Nov 07 2026 02:15:56. Do not edit by hand; run the script again. Read with FRONTEND-SPEC.md (section 5 says how). The script read 243 profession files.

## How to read it
- **type** is the booking pattern (the file's `pattern`): chair, clinic, consult, service, fix, class, dropoff, event, urgent, project, table. FRONTEND-SPEC.md section 3 says what each one means for the screens.
- **flows**: A (the customer comes to the business) and B (the business goes to the customer). **A#** and **B#** are how many of the master's 28 money paths per flow the profession lists. The paths themselves are in the second table.
- **facts**: the profession file's `pf.facts`. `(none listed)` means the file has no `pf.facts` list, so the master shows every fact-gated branch. **switches**: `pf.switches` that are on (sensitive, welfare, cancelright, nomoney; no2 is never on, D97).
- **arrive A / B**: `pf.settings.arrive` per flow: `window` (an arrival window, the default), `setstart` (a set start time), or `window Nh`. **cutoff**: `pf.settings.cutoff` (the free-cancel time).
- **elements**: the catalog rows (FRONTEND-SPEC.md section 2) that this profession switches on beyond the core ones. The core ones apply to every profession (business, places, hours, staff, services with money, Stripe, fee consent, notices). The code list at the end says which fact or switch gives which element.
- A fact or switch the master does not list is reported in the last section and has no element: leave it out of the screens.

## 1. Counts

Professions read: **243**. Files skipped: **0**. Expected (work/phase4/waves.json) but no file yet: **0**.

**By booking type**

| type | professions |
|---|---|
| clinic | 48 |
| service | 35 |
| chair | 29 |
| project | 28 |
| consult | 25 |
| event | 20 |
| class | 19 |
| dropoff | 19 |
| fix | 9 |
| table | 7 |
| urgent | 4 |

**Flows**

| flows | professions |
|---|---|
| A+B | 243 |

**Each booking type: how many, its common facts (in at least a third of its professions), arrival, and its main money paths**

| type | professions | common facts | arrive A | arrive B | main path A (most used) | main path B (most used) | common switches |
|---|---|---|---|---|---|---|---|
| chair | 29 | forms 23, firststeps 19, children 17, packs 13, aftercare 13 | setstart 29 | setstart 21; window 5; window 2h 3 | list\|card\|counter 11; list\|full\|none 9; list\|card\|card 3 | list\|card\|bill 15; list\|card\|card 10; list\|deposit\|bill 1 | - |
| class | 19 | classes 19, children 19, waitlist 18, forms 18, groups 16, extrawork 8, video 7 | setstart 14; window (default) 5 | setstart 14; window (default) 5 | list\|full\|none 15; list\|deposit\|card 3; list\|none\|none 1 | list\|card\|card 13; list\|deposit\|card 2; list\|full\|none 2 | - |
| clinic | 48 | forms 48, planbill 43, children 36, firststeps 35, video 33, extrawork 33, plans 16 | setstart 48 | window 32; setstart 16 | list\|none\|counter 35; list\|none\|bill 4; list\|card\|card 2 | list\|none\|own 25; list\|card\|card 9; list\|none\|bill 9 | sensitive 45, welfare 27 |
| consult | 25 | video 21, documents 20, firststeps 18, forms 16, extrawork 9 | setstart 23; window 1; window (default) 1 | setstart 18; window 6; window (default) 1 | list\|none\|counter 11; list\|full\|none 7; list\|card\|counter 2 | list\|none\|bill 6; list\|none\|own 6; list\|card\|card 5 | sensitive 10 |
| dropoff | 19 | dropoff 19, extrawork 19, photos 7 | setstart 17; window 1; window (default) 1 | window 17; window 2h 2 | visit\|none\|counter 10; list\|none\|counter 5; list\|card\|counter 2 | list\|card\|bill 8; list\|card\|card 7; visit\|card\|bill 3 | - |
| event | 20 | documents 20, extrawork 19, forms 11, photos 9, firststeps 9 | setstart 15; window (default) 5 | window 8; setstart 6; window (default) 5 | list\|deposit\|counter 10; list\|full\|none 7; list\|card\|counter 1 | photos\|deposit\|card 10; list\|deposit\|card 6; photos\|deposit\|bill 2 | - |
| fix | 9 | extrawork 9, photos 9, documents 8, dropoff 7, firststeps 7, video 5, planbill 3, sentnow 3 | setstart 7; window (default) 2 | window 9 | list\|card\|counter 7; visit\|card\|counter 1; visit\|deposit\|counter 1 | list\|card\|bill 6; visit\|card\|bill 2; visit\|card\|card 1 | cancelright 5 |
| project | 28 | documents 28, extrawork 28, photos 25, banktransfer 25, firststeps 24, multiday 24, video 16, stages 16 | setstart 26; window (default) 2 | window 24; setstart 2; window (default) 2 | list\|card\|counter 23; list\|none\|none 4; list\|card\|card 1 | visit\|none\|bill 22; visit\|card\|bill 4; photos\|deposit\|bill 1 | cancelright 26 |
| service | 35 | extrawork 30, plans 24, photos 23, dropoff 19, firststeps 16, documents 14 | setstart 30; window (default) 5 | window 21; setstart 11; window 2h 2 | list\|none\|counter 17; list\|card\|counter 12; list\|card\|card 3 | list\|card\|card 22; list\|card\|bill 9; list\|card\|own 1 | - |
| table | 7 | groups 7, children 6, forms 6, spaces 6, extrawork 6, capacitycheck 3 | setstart 7 | setstart 6; window 1 | list\|full\|none 4; list\|deposit\|counter 2; list\|card\|counter 1 | list\|deposit\|card 5; list\|card\|bill 1; list\|deposit\|bill 1 | - |
| urgent | 4 | sentnow 4, documents 4, extrawork 4, dropoff 4, forms 3, planbill 2, firststeps 2 | setstart 2; window 2 | window 3; setstart 1 | list\|none\|counter 3; visit\|none\|bill 1 | visit\|none\|bill 2; list\|card\|bill 1; list\|card\|card 1 | cancelright 2 |

**Facts listed** (a profession with no `pf.facts` list counts under `(none listed)`)

| fact | professions | catalog rows |
|---|---|---|
| extrawork | 174 | V19 |
| firststeps | 138 | Q01 |
| forms | 137 | Q01 |
| documents | 115 | Q02 |
| video | 101 | L01, L06 |
| photos | 91 | Q07 |
| children | 86 | Q05 |
| dropoff | 61 | K07 |
| plans | 57 | P02 |
| planbill | 51 | V18 |
| groups | 47 | K08 |
| multiday | 41 | K06 |
| classes | 33 | K01, K02, K03 |
| banktransfer | 28 | V12 |
| aftercare | 27 | Q08 |
| packs | 27 | P01, P02, P03 |
| waitlist | 25 | V14 |
| results | 24 | Q08 |
| tips | 24 | V11 |
| stages | 22 | V16 |
| sentnow | 21 | T12, V10 |
| spaces | 21 | K04 |
| animals | 12 | Q05 |
| incare | 12 | Q05 |
| monthlybill | 11 | V17 |
| capacitycheck | 8 | K09 |
| discounts | 2 | V13 |
| nomoney | 2 | M02 |
| (none listed) | 1 | - |

**Switches on**

| switch | professions | catalog rows |
|---|---|---|
| (none) | 139 | - |
| sensitive | 61 | Q06, B02 |
| cancelright | 43 | V20 |
| welfare | 32 | Q09 |
| nomoney | 2 | M02 |

**Arrival setting** (flow A / flow B)

| arrive A | arrive B | professions |
|---|---|---|
| setstart | window | 117 |
| setstart | setstart | 93 |
| window (default) | window (default) | 14 |
| setstart | window 2h | 8 |
| window (default) | window | 7 |
| window | setstart | 2 |
| window | window | 2 |

**How many professions list each of the master's money paths**

| path | flow A | flow B |
|---|---|---|
| list\|card\|bill | 2 | 80 |
| list\|card\|card | 40 | 115 |
| list\|card\|counter | 141 | not in B |
| list\|card\|own | not in A | 4 |
| list\|deposit\|bill | 4 | 26 |
| list\|deposit\|card | 8 | 31 |
| list\|deposit\|counter | 87 | not in B |
| list\|deposit\|own | not in A | 1 |
| list\|full\|none | 152 | 112 |
| list\|none\|bill | 30 | 104 |
| list\|none\|counter | 172 | not in B |
| list\|none\|none | 26 | 2 |
| list\|none\|own | not in A | 56 |
| photos\|card\|bill | 0 | 3 |
| photos\|card\|card | 1 | 8 |
| photos\|card\|counter | 32 | not in B |
| photos\|card\|own | not in A | 0 |
| photos\|deposit\|bill | 6 | 91 |
| photos\|deposit\|card | 3 | 21 |
| photos\|deposit\|counter | 11 | not in B |
| photos\|deposit\|own | not in A | 0 |
| photos\|full\|none | 2 | 1 |
| photos\|none\|bill | 1 | 2 |
| photos\|none\|counter | 17 | not in B |
| photos\|none\|none | 2 | 0 |
| photos\|none\|own | not in A | 0 |
| visit\|card\|bill | 0 | 64 |
| visit\|card\|card | 0 | 14 |
| visit\|card\|counter | 25 | not in B |
| visit\|card\|own | not in A | 4 |
| visit\|deposit\|bill | 0 | 3 |
| visit\|deposit\|card | 0 | 1 |
| visit\|deposit\|counter | 6 | not in B |
| visit\|deposit\|own | not in A | 0 |
| visit\|none\|bill | 11 | 37 |
| visit\|none\|counter | 41 | not in B |
| visit\|none\|own | not in A | 30 |

**Free-cancel cutoff words used** (the field is free text)

| cutoff | professions |
|---|---|
| 24 hours before | 124 |
| - | 22 |
| A: 24 hours before, B: 24 hours before | 22 |
| A: 24 hours before, B: 2 days before | 21 |
| A: 24 hours before, B: 7am the day of | 11 |
| A: default, B: 24 hours before | 8 |
| 2 days before | 7 |
| A: 24 hours before, B: 6pm the day before | 6 |
| A: 24 hours before, B: 8pm the day before | 5 |
| 6pm the day before | 4 |
| A: 2 days before, B: 24 hours before | 2 |
| A: 72 hours before, B: 72 hours before | 2 |
| A: 7am the day of, B: 6pm the day before | 2 |
| A: default, B: 2 days before | 2 |
| 14 days before | 1 |
| 5pm the day before | 1 |
| A: 24 hours before, B: 2 hours before | 1 |
| A: 24 hours before, B: 7 days before | 1 |
| A: default, B: 48 hours before | 1 |

## 2. One row per profession

| id | name | type | flows | A# | B# | facts | switches | arrive A | arrive B | cutoff | elements |
|---|---|---|---|---|---|---|---|---|---|---|---|
| aba | ABA and autism therapy | clinic | A+B | 2 | 3 | planbill, forms, plans, children, firststeps, classes, groups, monthlybill | sensitive, welfare | setstart | setstart | 24 hours before | B02 K01 K02 K03 K08 P02 Q01 Q05 Q06 Q09 V17 V18 |
| acupuncturist | Acupuncturist | clinic | A+B | 3 | 3 | planbill, forms, firststeps, children, aftercare | sensitive | setstart | window | 24 hours before | B02 Q01 Q05 Q06 Q08 V18 |
| addiction | Addiction counselor and outpatient treatment | clinic | A+B | 4 | 3 | planbill, forms, plans, video, firststeps, classes, groups, children | sensitive | setstart | setstart | 24 hours before | B02 K01 K02 K03 K08 L01 L06 P02 Q01 Q05 Q06 V18 |
| advisor | Financial Advisor | consult | A+B | 1 | 1 | video | - | setstart | setstart | 24 hours before | L01 L06 |
| airport-shuttle | Airport shuttle | service | A+B | 2 | 4 | plans, monthlybill, extrawork, classes | - | setstart | setstart | 24 hours before | K01 K02 K03 K04 P02 V17 V19 |
| allergist | Allergist | clinic | A+B | 2 | 2 | forms, firststeps, planbill, children, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 V19 |
| appliance | Appliance repair | fix | A+B | 6 | 6 | dropoff, extrawork, planbill, photos, firststeps, documents, video, results | - | window (default) | window | A: 24 hours before, B: 24 hours before | K07 L01 L06 Q01 Q02 Q07 Q08 V18 V19 |
| appraiser | Real estate appraiser | service | A+B | 4 | 4 | documents, results, photos, video, extrawork | - | setstart | setstart | 6pm the day before | L01 L06 Q02 Q07 Q08 V19 |
| aquarium | Aquarium Care | service | A+B | 3 | 4 | plans, monthlybill, sentnow, animals, extrawork, photos, forms, dropoff | - | window (default) | window | A: default, B: 24 hours before | K07 P02 Q01 Q05 Q07 T12 V10 V17 V19 |
| architect | Architect | consult | A+B | 5 | 3 | documents, photos, video, extrawork, firststeps | - | setstart | window | A: 24 hours before, B: 2 days before | L01 L06 Q01 Q02 Q07 V19 |
| art-appraiser | Art and jewelry appraiser | consult | A+B | 5 | 3 | photos, video, documents, extrawork | - | setstart | window | A: 24 hours before, B: 24 hours before | L01 L06 Q02 Q07 V19 |
| art-classes | Art classes | class | A+B | 2 | 2 | classes, children, waitlist, groups, video, forms | - | window (default) | window (default) | - | K01 K02 K03 K08 L01 L06 Q01 Q05 V14 |
| auto-body | Auto body and collision repair | dropoff | A+B | 5 | 3 | planbill, dropoff, photos, extrawork, multiday, documents, sentnow | - | setstart | window | A: 24 hours before, B: 24 hours before | K06 K07 Q02 Q07 T12 V10 V18 V19 |
| auto-glass | Auto glass | service | A+B | 1 | 2 | dropoff, extrawork, planbill | - | setstart | setstart | 24 hours before | K07 V18 V19 |
| auto-repair | Auto repair | dropoff | A+B | 4 | 4 | dropoff, extrawork, sentnow | - | setstart | window | 24 hours before | K07 T12 V10 V19 |
| axe-throwing | Axe throwing and game venues | table | A+B | 3 | 3 | groups, children, forms, spaces, capacitycheck, extrawork | - | setstart | setstart | A: 24 hours before, B: 2 days before | K04 K08 K09 Q01 Q05 V19 |
| baker | Custom cake baker | event | A+B | 3 | 3 | documents, extrawork, forms, photos | - | setstart | window | A: 24 hours before, B: 2 days before | Q01 Q02 Q07 V19 |
| band | Live band and musicians | event | A+B | 5 | 4 | documents, extrawork | - | window (default) | window (default) | - | Q02 V19 |
| barber | Barber | chair | A+B | 3 | 3 | children, documents, extrawork, groups, photos | - | setstart | setstart | 24 hours before | K08 Q02 Q05 Q07 V19 |
| bike-repair | Bike repair | dropoff | A+B | 4 | 2 | dropoff, extrawork | - | setstart | window | A: default, B: 24 hours before | K07 V19 |
| biohazard | Biohazard, trauma and hoarding cleanup | urgent | A+B | 2 | 3 | sentnow, planbill, documents, firststeps, multiday, extrawork, results, dropoff, video | sensitive, cancelright | window | window | A: default, B: 24 hours before | B02 K06 K07 L01 L06 Q01 Q02 Q06 Q08 T12 V10 V18 V19 V20 |
| boarding | Pet boarding and doggy daycare | dropoff | A+B | 2 | 2 | animals, dropoff, extrawork, forms, multiday, spaces | - | window | window | 24 hours before | K04 K06 K07 Q01 Q05 V19 |
| boat-repair | Boat repair and marine mechanic | dropoff | A+B | 4 | 4 | dropoff, extrawork | - | setstart | window | 2 days before | K07 V19 |
| camp | Summer camp | class | A+B | 3 | 2 | classes, groups, children, incare, forms, multiday, waitlist | - | setstart | setstart | 2 days before | K01 K02 K03 K06 K08 Q01 Q05 V14 |
| cardiologist | Cardiologist | clinic | A+B | 2 | 2 | forms, firststeps, planbill, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q06 Q09 V18 V19 |
| carpet | Carpet & upholstery cleaner | service | A+B | 5 | 5 | firststeps, dropoff, photos, extrawork, tips | - | setstart | window | A: 24 hours before, B: 24 hours before | K07 Q01 Q07 V11 V19 |
| caterer | Caterer | event | A+B | 7 | 7 | firststeps, forms, documents, extrawork | - | setstart | window | A: 24 hours before, B: 2 days before | Q01 Q02 V19 |
| chef | Private chef | event | A+B | 2 | 2 | firststeps, documents, classes, tips, extrawork, children | - | setstart | setstart | A: 24 hours before, B: 2 days before | K01 K02 K03 Q01 Q02 Q05 V11 V19 |
| chimney | Chimney sweep | service | A+B | 6 | 5 | plans, firststeps, dropoff, photos, documents, waitlist, stages, extrawork | cancelright | setstart | window | A: 24 hours before, B: 2 days before | K07 P02 Q01 Q02 Q07 V14 V16 V19 V20 |
| chiropractor | Chiropractor | clinic | A+B | 2 | 3 | plans, planbill, forms, children, extrawork | sensitive | setstart | setstart | 24 hours before | B02 P02 Q01 Q05 Q06 V18 V19 |
| cleaner | House cleaner | service | A+B | 5 | 4 | plans, firststeps, sentnow, dropoff, photos, tips, extrawork | - | setstart | window | A: 24 hours before, B: 2 days before | K07 P02 Q01 Q07 T12 V10 V11 V19 |
| climbing-gym | Climbing gym | class | A+B | 4 | 2 | classes, packs, plans, groups, firststeps, forms, children, spaces, waitlist, extrawork, documents, capacitycheck | - | setstart | setstart | A: default, B: 2 days before | K01 K02 K03 K04 K08 K09 P01 P02 P03 Q01 Q02 Q05 V14 V19 |
| closets | Cabinet and closet installer (finish carpentry) | project | A+B | 4 | 5 | firststeps, documents, multiday, extrawork, photos, video, banktransfer | cancelright | setstart | window | 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V19 V20 |
| clown | Clown and balloon artist | event | A+B | 5 | 4 | documents, extrawork | - | window (default) | window (default) | - | Q02 V19 |
| coach | Career and life coach | consult | A+B | 2 | 3 | video, firststeps, packs, plans, forms, documents | - | setstart | setstart | 24 hours before | L01 L06 P01 P02 P03 Q01 Q02 |
| coding-classes | Coding classes | class | A+B | 2 | 2 | classes, children, waitlist, groups, video, forms | - | window (default) | window (default) | - | K01 K02 K03 K08 L01 L06 Q01 Q05 V14 |
| college-admissions | College admissions consultant | consult | A+B | 4 | 4 | video, firststeps, forms, documents, children, groups, photos | - | setstart | setstart | 24 hours before | K08 L01 L06 Q01 Q02 Q05 Q07 |
| comedian | Comedian and emcee | event | A+B | 5 | 4 | documents, extrawork | - | window (default) | window (default) | - | Q02 V19 |
| commercial-cleaning | Commercial and office cleaning | service | A+B | 5 | 5 | plans, firststeps, dropoff, photos, extrawork, monthlybill | - | setstart | window | A: 24 hours before, B: 2 days before | K07 P02 Q01 Q07 V17 V19 |
| concierge | Concierge and errand service | service | A+B | 2 | 2 | plans, forms, extrawork, monthlybill, dropoff | sensitive, welfare | setstart | setstart | 24 hours before | B02 K07 P02 Q01 Q06 Q09 V17 V19 |
| concrete | Concrete and driveway contractor | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer | cancelright | setstart | window | 24 hours before | K06 Q01 Q02 Q07 V12 V16 V19 V20 |
| contractor | General contractor | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, sentnow, banktransfer | cancelright | setstart | window | 24 hours before | Q01 Q02 Q07 T12 V10 V12 V16 V19 V20 |
| cooking-classes | Cooking classes | class | A+B | 2 | 2 | classes, children, waitlist, groups, forms | - | window (default) | window (default) | - | K01 K02 K03 K08 Q01 Q05 V14 |
| cpa | CPA and accountant | consult | A+B | 3 | 3 | forms, firststeps, documents, video | - | setstart | setstart | 24 hours before | L01 L06 Q01 Q02 |
| cpr-training | CPR and first aid training | class | A+B | 2 | 2 | classes, groups, forms, waitlist, children, results | - | setstart | setstart | 2 days before | K01 K02 K03 K08 Q01 Q05 Q08 V14 |
| credit-counselor | Credit counselor | consult | A+B | 4 | 3 | video, firststeps, packs, forms, documents | sensitive | setstart | setstart | 24 hours before | B02 L01 L06 P01 P02 P03 Q01 Q02 Q06 |
| dance | Dance studio | class | A+B | 2 | 2 | classes, children, plans, packs, forms, waitlist, groups, photos, video, extrawork | - | window (default) | window (default) | - | K01 K02 K03 K08 L01 L06 P01 P02 P03 Q01 Q05 Q07 V14 V19 |
| daycare | Daycare center | class | A+B | 3 | 2 | plans, children, spaces, waitlist, firststeps, forms, documents, extrawork, classes | - | setstart | setstart | A: 24 hours before, B: 2 days before | K01 K02 K03 K04 P02 Q01 Q02 Q05 V14 V19 |
| deck | Deck and patio builder | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer | cancelright | setstart | window | 24 hours before | K06 Q01 Q02 Q07 V12 V16 V19 V20 |
| demolition | Demolition contractor | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer, video | cancelright | setstart | window | 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V16 V19 V20 |
| dentist | Dentist | clinic | A+B | 5 | 5 | plans, planbill, forms, children, incare, photos, extrawork | - | setstart | window | 24 hours before | P02 Q01 Q05 Q07 V18 V19 |
| dermatologist | Dermatologist | clinic | A+B | 3 | 1 | planbill, firststeps, forms, results, video, aftercare, children, extrawork, waitlist, plans | sensitive | setstart | setstart | 24 hours before | B02 L01 L06 P02 Q01 Q05 Q06 Q08 V14 V18 V19 |
| detailing | Car detailing | service | A+B | 2 | 2 | plans, photos, extrawork, firststeps, dropoff | - | setstart | window | A: 24 hours before, B: 24 hours before | K07 P02 Q01 Q07 V19 |
| dietitian | Dietitian | clinic | A+B | 3 | 2 | planbill, firststeps, forms, video, children | sensitive, welfare | setstart | setstart | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 |
| dj | DJ | event | A+B | 5 | 4 | documents, extrawork | - | window (default) | window (default) | - | Q02 V19 |
| dog-trainer | Dog trainer | chair | A+B | 3 | 3 | animals, classes, packs, firststeps, forms, children, aftercare, tips, extrawork | - | setstart | setstart | A: 24 hours before, B: 7am the day of | K01 K02 K03 P01 P02 P03 Q01 Q05 Q08 V11 V19 |
| dog-walker | Dog walking | service | A+B | 2 | 3 | animals, plans, firststeps, groups, forms, dropoff | - | setstart | window 2h | A: 24 hours before, B: 8pm the day before | K07 K08 P02 Q01 Q05 |
| doula | Doula | clinic | A+B | 4 | 3 | children, documents, extrawork, firststeps, forms, video | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q02 Q05 Q06 Q09 V19 |
| driving-school | Driving school | chair | A+B | 3 | 3 | plans, classes, forms, children, documents, extrawork | - | setstart | setstart | 24 hours before | K01 K02 K03 P02 Q01 Q02 Q05 V19 |
| drywall | Drywall and plaster | project | A+B | 6 | 5 | firststeps, documents, multiday, extrawork, photos, banktransfer, video | cancelright | setstart | window | A: 24 hours before, B: 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V19 V20 |
| duct-cleaning | Air duct and dryer vent cleaning | service | A+B | 5 | 4 | plans, firststeps, dropoff, photos, extrawork | - | setstart | window | A: 24 hours before, B: 24 hours before | K07 P02 Q01 Q07 V19 |
| electrician | Electrician | fix | A+B | 5 | 7 | photos, firststeps, dropoff, extrawork, stages, documents, video | - | setstart | window | A: 24 hours before, B: 24 hours before | K07 L01 L06 Q01 Q02 Q07 V16 V19 |
| endocrinologist | Endocrinologist | clinic | A+B | 2 | 2 | forms, firststeps, planbill, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q06 Q09 V18 V19 |
| energy-audit | Home energy auditor | service | A+B | 4 | 4 | results, photos, video, extrawork | - | setstart | setstart | 6pm the day before | L01 L06 Q07 Q08 V19 |
| enrichment | Kids' enrichment and after-school programs | class | A+B | 3 | 2 | classes, groups, children, waitlist, forms, incare | - | setstart | setstart | 24 hours before | K01 K02 K03 K08 Q01 Q05 V14 |
| ent | Ear, nose and throat (ENT) | clinic | A+B | 2 | 2 | forms, firststeps, planbill, children, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 V19 |
| escape-room | Escape room | table | A+B | 3 | 2 | groups, spaces, forms, children, discounts, extrawork | - | setstart | setstart | A: default, B: 2 days before | K04 K08 Q01 Q05 V13 V19 |
| estate-sale | Estate sale company and auctioneer | project | A+B | 2 | 3 | firststeps, documents, multiday, extrawork, results | cancelright | setstart | setstart | A: 24 hours before, B: 24 hours before | K06 Q01 Q02 Q08 V19 V20 |
| esthetician | Esthetician / skin care | chair | A+B | 5 | 4 | groups, firststeps, forms, children, tips, aftercare, documents | - | setstart | window | A: 24 hours before, B: 7am the day of | K08 Q01 Q02 Q05 Q08 V11 |
| event-staffing | Event security and staffing | event | A+B | 2 | 4 | firststeps, forms, documents, extrawork | - | setstart | window | A: 24 hours before, B: 2 days before | Q01 Q02 V19 |
| excavation | Excavation and grading | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer, video | cancelright | setstart | window | 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V16 V19 V20 |
| face-painter | Face painter | event | A+B | 5 | 4 | children, firststeps, forms, groups, documents, tips, extrawork, photos | - | setstart | window | A: 24 hours before, B: 6pm the day before | K08 Q01 Q02 Q05 Q07 V11 V19 |
| farrier | Farrier | service | A+B | 3 | 4 | animals, plans, forms, extrawork | - | setstart | window | A: 24 hours before, B: 24 hours before | P02 Q01 Q05 V19 |
| fence | Fence installer | project | A+B | 1 | 3 | firststeps, documents, multiday, extrawork, photos, banktransfer, video | cancelright | setstart | window | A: default, B: 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V19 V20 |
| fertility | Fertility clinic | clinic | A+B | 4 | 2 | forms, firststeps, planbill, video, extrawork, documents, dropoff | sensitive | setstart | window | 24 hours before | B02 K07 L01 L06 Q01 Q02 Q06 V18 V19 |
| fishing-charter | Fishing and boat charter | table | A+B | 2 | 1 | groups, forms, children, tips, multiday, extrawork, firststeps, spaces | - | setstart | setstart | A: 72 hours before, B: 72 hours before | K04 K06 K08 Q01 Q05 V11 V19 |
| flight-school | Flight school | chair | A+B | 4 | 3 | firststeps, forms, children, classes, video, spaces, multiday | - | setstart | setstart | 24 hours before | K01 K02 K03 K04 K06 L01 L06 Q01 Q05 |
| flooring | Flooring installer | project | A+B | 6 | 6 | photos, documents, firststeps, extrawork, stages, banktransfer, multiday | cancelright | setstart | window | 24 hours before | K06 Q01 Q02 Q07 V12 V16 V19 V20 |
| florist | Florist | event | A+B | 3 | 2 | photos, documents, forms, extrawork, capacitycheck | cancelright | setstart | window | 24 hours before | K09 Q01 Q02 Q07 V19 V20 |
| food-truck | Food truck for events | event | A+B | 2 | 4 | firststeps, forms, documents, extrawork | - | setstart | window | A: 24 hours before, B: 2 days before | Q01 Q02 V19 |
| foundation | Foundation repair and basement waterproofing | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer, video | cancelright | setstart | window | 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V16 V19 V20 |
| funeral | Funeral home | consult | A+B | 3 | 3 | documents, sentnow | sensitive | setstart | setstart | - | B02 Q02 Q06 T12 V10 |
| garage-door | Garage door technician | fix | A+B | 5 | 7 | photos, documents, extrawork, firststeps | cancelright | setstart | window | 24 hours before | Q01 Q02 Q07 V19 V20 |
| gastroenterologist | Gastroenterologist | clinic | A+B | 2 | 2 | forms, firststeps, planbill, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q06 Q09 V18 V19 |
| glass-doors | Glass, window and door installer | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer | cancelright | setstart | window | 24 hours before | K06 Q01 Q02 Q07 V12 V16 V19 V20 |
| golf-instructor | Golf instructor | chair | A+B | 3 | 2 | packs, firststeps, forms, video | - | setstart | setstart | 24 hours before | L01 L06 P01 P02 P03 Q01 |
| groomer | Pet groomer | dropoff | A+B | 3 | 3 | animals, dropoff, extrawork, firststeps, forms, plans, tips | - | window (default) | window | A: 24 hours before, B: 7am the day of | K07 P02 Q01 Q05 V11 V19 |
| gunsmith | Gunsmith | dropoff | A+B | 4 | 2 | dropoff, extrawork, documents | - | setstart | window 2h | 24 hours before | K07 Q02 V19 |
| gutters | Gutter installer | project | A+B | 6 | 7 | documents, photos, multiday, extrawork, stages, banktransfer | cancelright | setstart | window | 24 hours before | K06 Q02 Q07 V12 V16 V19 V20 |
| gym | Gym & fitness classes | class | A+B | 2 | 3 | classes, groups, packs, plans, forms, waitlist, children, video, extrawork | - | setstart | setstart | 24 hours before | K01 K02 K03 K08 L01 L06 P01 P02 P03 Q01 Q05 V14 V19 |
| gymnastics | Gymnastics and cheer gym | class | A+B | 2 | 2 | classes, groups, children, waitlist, forms | - | setstart | setstart | 24 hours before | K01 K02 K03 K08 Q01 Q05 V14 |
| hair-restoration | Hair restoration clinic | clinic | A+B | 4 | 2 | planbill, firststeps, forms, results, video, aftercare, extrawork, waitlist, plans, packs | sensitive | setstart | setstart | A: 2 days before, B: 24 hours before | B02 L01 L06 P01 P02 P03 Q01 Q06 Q08 V14 V18 V19 |
| hair | Hair salon | chair | A+B | 7 | 6 | photos, firststeps, forms, extrawork, groups, children | - | setstart | window | 24 hours before | K08 Q01 Q05 Q07 V19 |
| handyman | Handyman | fix | A+B | 5 | 7 | photos, documents, firststeps, extrawork | cancelright | setstart | window | 24 hours before | Q01 Q02 Q07 V19 V20 |
| hearing | Audiologist & hearing aids | clinic | A+B | 3 | 4 | aftercare, children, documents, dropoff, extrawork, firststeps, forms, incare, planbill, results, spaces | sensitive, welfare, cancelright | setstart | window | A: 24 hours before, B: 2 days before | B02 K04 K07 Q01 Q02 Q05 Q06 Q08 Q09 V18 V19 V20 |
| holiday-lights | Holiday lighting installer | service | A+B | 3 | 6 | plans, dropoff, photos, extrawork, documents, tips, firststeps, multiday, banktransfer | cancelright | window (default) | window | A: 24 hours before, B: 24 hours before | K06 K07 P02 Q01 Q02 Q07 V11 V12 V19 V20 |
| home-care | Home care aide | service | A+B | 4 | 4 | plans, firststeps, documents, monthlybill, extrawork, video, incare, multiday | sensitive, welfare | setstart | setstart | 24 hours before | B02 K06 L01 L06 P02 Q01 Q02 Q05 Q06 Q09 V17 V19 |
| home-engineer | Home engineer (structural inspections) | service | A+B | 4 | 4 | documents, results, photos, video, extrawork | - | setstart | setstart | 6pm the day before | L01 L06 Q02 Q07 Q08 V19 |
| home-stager | Home stager | project | A+B | 4 | 5 | firststeps, documents, multiday, extrawork, photos, video, banktransfer | cancelright | setstart | window | 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V19 V20 |
| horse-riding | Horse boarding, riding lessons and stables | chair | A+B | 3 | 2 | firststeps, forms, children, classes, animals, multiday | - | setstart | setstart | 24 hours before | K01 K02 K03 K06 Q01 Q05 |
| hunting-guide | Hunting and outdoor guide | table | A+B | 3 | 3 | groups, forms, children, multiday, extrawork, firststeps | - | setstart | setstart | A: 72 hours before, B: 72 hours before | K04 K06 K08 Q01 Q05 V19 |
| hvac | HVAC technician | fix | A+B | 6 | 7 | documents, dropoff, extrawork, photos, plans, sentnow | cancelright | setstart | window | A: 24 hours before, B: 24 hours before | K07 P02 Q02 Q07 T12 V10 V19 V20 |
| hypnotherapist | Hypnotherapist | chair | A+B | 3 | 2 | packs, firststeps, forms, video, aftercare, children | sensitive | setstart | setstart | A: 24 hours before, B: 8pm the day before | B02 L01 L06 P01 P02 P03 Q01 Q05 Q06 Q08 |
| image-consultant | Image consultant and personal stylist | consult | A+B | 4 | 4 | video, firststeps, forms, documents, photos, groups, extrawork | - | setstart | setstart | 24 hours before | K08 L01 L06 Q01 Q02 Q07 V19 |
| imaging | Medical imaging center (X-ray, CT, MRI, ultrasound) | clinic | A+B | 2 | 2 | planbill, firststeps, forms, results, children, sentnow | sensitive, welfare | setstart | window | 24 hours before | B02 Q01 Q05 Q06 Q08 Q09 T12 V10 V18 |
| immigration-services | Immigration and paralegal services | consult | A+B | 3 | 2 | forms, firststeps, documents, dropoff, video, children, extrawork | sensitive | setstart | setstart | 24 hours before | B02 K07 L01 L06 Q01 Q02 Q05 Q06 V19 |
| inspector | Home inspector | service | A+B | 4 | 5 | documents, results, photos, video, extrawork | - | window (default) | window (default) | - | L01 L06 Q02 Q07 Q08 V19 |
| instrument-repair | Musical instrument repair | dropoff | A+B | 4 | 4 | dropoff, photos, extrawork | - | setstart | window | A: 24 hours before, B: 24 hours before | K07 Q07 V19 |
| insulation | Insulation contractor | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer, video | cancelright | setstart | window | 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V16 V19 V20 |
| insurance | Insurance agent | consult | A+B | 1 | 1 | (none listed) | - | window (default) | window (default) | - | - |
| interior | Interior designer | project | A+B | 5 | 6 | firststeps, documents, multiday, extrawork, photos, video, stages, banktransfer | - | window (default) | window (default) | A: default, B: 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V16 V19 |
| irrigation | Irrigation and sprinkler installer | service | A+B | 6 | 5 | documents, photos, multiday, extrawork, stages, firststeps, banktransfer | cancelright | setstart | window | 24 hours before | K06 Q01 Q02 Q07 V12 V16 V19 V20 |
| iv-hydration | IV hydration clinic | clinic | A+B | 4 | 2 | packs, plans, firststeps, forms, video, extrawork, waitlist | sensitive, welfare | setstart | setstart | 24 hours before | B02 L01 L06 P01 P02 P03 Q01 Q06 Q09 V14 V19 |
| junk | Junk removal | service | A+B | 4 | 5 | photos, extrawork | - | setstart | window | - | Q07 V19 |
| lab | Lab tests and mobile blood draw | clinic | A+B | 3 | 4 | forms, firststeps, planbill, children, results, dropoff, spaces, incare, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 K04 K07 Q01 Q05 Q06 Q08 Q09 V18 V19 |
| lactation | Lactation consultant | clinic | A+B | 3 | 3 | children, firststeps, forms, planbill, video | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 |
| language-school | Language teacher and school | class | A+B | 2 | 2 | classes, children, waitlist, groups, video, forms | - | window (default) | window (default) | - | K01 K02 K03 K08 L01 L06 Q01 Q05 V14 |
| lash-brow | Lash and brow studio | chair | A+B | 2 | 2 | documents, extrawork, firststeps, forms, photos | cancelright | setstart | window | A: 24 hours before, B: 2 days before | Q01 Q02 Q07 V19 V20 |
| laundry | Laundry, dry cleaning and wash-and-fold pickup | dropoff | A+B | 3 | 2 | dropoff, extrawork, plans | - | setstart | window | A: 7am the day of, B: 6pm the day before | K07 P02 V19 |
| lawn | Lawn care & landscaper | service | A+B | 3 | 5 | plans, dropoff, photos, extrawork, documents, tips, monthlybill | - | window (default) | window | A: 24 hours before, B: 24 hours before | K07 P02 Q02 Q07 V11 V17 V19 |
| lawyer | Lawyer | consult | A+B | 5 | 6 | forms, firststeps, video | sensitive | setstart | window | 24 hours before | B02 L01 L06 Q01 Q06 |
| limo | Limo, chauffeur and party bus | event | A+B | 2 | 4 | documents, photos, extrawork, forms, groups, children | - | setstart | setstart | A: 24 hours before, B: 7 days before | K04 K08 Q01 Q02 Q05 Q07 V19 |
| locksmith | Locksmith | urgent | A+B | 6 | 6 | documents, dropoff, extrawork, forms, photos, sentnow | - | setstart | window | A: 24 hours before, B: 24 hours before | K07 Q01 Q02 Q07 T12 V10 V19 |
| magician | Magician | event | A+B | 2 | 2 | documents, video, extrawork, tips | - | setstart | setstart | 14 days before | L01 L06 Q02 V11 V19 |
| makeup | Makeup artist | event | A+B | 4 | 4 | firststeps, forms, photos, groups, documents, tips, extrawork | - | setstart | window | A: 24 hours before, B: 6pm the day before | K08 Q01 Q02 Q07 V11 V19 |
| martial-arts | Martial arts school | class | A+B | 2 | 3 | classes, groups, packs, forms, waitlist, children, extrawork | - | setstart | setstart | A: 24 hours before, B: 7am the day of | K01 K02 K03 K08 P01 P02 P03 Q01 Q05 V14 V19 |
| masonry | Masonry (brick, stone, chimney rebuild) | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer | cancelright | setstart | window | 24 hours before | K06 Q01 Q02 Q07 V12 V16 V19 V20 |
| massage | Massage therapy | chair | A+B | 2 | 3 | plans, packs, forms, children, aftercare, tips | - | setstart | setstart | A: 24 hours before, B: 8pm the day before | P01 P02 P03 Q01 Q05 Q08 V11 |
| matchmaker | Matchmaker and dating coach | consult | A+B | 4 | 4 | video, firststeps, forms, documents, groups, extrawork | - | setstart | setstart | 24 hours before | K08 L01 L06 Q01 Q02 V19 |
| mediator | Mediator | consult | A+B | 3 | 3 | forms, firststeps, documents, video, extrawork | sensitive | setstart | setstart | 2 days before | B02 L01 L06 Q01 Q02 Q06 V19 |
| medical-transport | Non-emergency medical transport | service | A+B | 2 | 4 | plans, forms, monthlybill, extrawork, incare, classes | sensitive, welfare | setstart | setstart | 24 hours before | B02 K01 K02 K03 K04 P02 Q01 Q05 Q06 Q09 V17 V19 |
| medspa | Med spa | clinic | A+B | 3 | 2 | firststeps, forms, packs, plans, video, aftercare, waitlist | sensitive | setstart | setstart | 24 hours before | B02 L01 L06 P01 P02 P03 Q01 Q06 Q08 V14 |
| midwife | Midwife | clinic | A+B | 4 | 3 | children, classes, documents, extrawork, firststeps, forms, groups, planbill, video | sensitive, welfare | setstart | window | 24 hours before | B02 K01 K02 K03 K08 L01 L06 Q01 Q02 Q05 Q06 Q09 V18 V19 |
| mini-golf | Mini golf, go-karts and laser tag | table | A+B | 3 | 3 | groups, children, forms, spaces, capacitycheck, extrawork | - | setstart | setstart | A: 24 hours before, B: 2 days before | K04 K08 K09 Q01 Q05 V19 |
| mortgage | Mortgage loan officer | consult | A+B | 1 | 1 | video, classes | - | setstart | setstart | 24 hours before | K01 K02 K03 L01 L06 |
| motorcycle | Motorcycle repair | dropoff | A+B | 4 | 4 | dropoff, extrawork, sentnow | - | setstart | window | 24 hours before | K07 T12 V10 V19 |
| movers | Movers | project | A+B | 5 | 5 | firststeps, documents, extrawork, photos, video | cancelright | setstart | window | A: 24 hours before, B: 24 hours before | L01 L06 Q01 Q02 Q07 V19 V20 |
| music | Music lessons | chair | A+B | 3 | 2 | children, plans, packs, video | - | setstart | setstart | 24 hours before | L01 L06 P01 P02 P03 Q05 |
| nails | Nail salon | chair | A+B | 5 | 5 | children, extrawork, groups, photos, spaces, tips | - | setstart | window | 24 hours before | K04 K08 Q05 Q07 V11 V19 |
| naturopath | Naturopathic practice | clinic | A+B | 2 | 2 | planbill, forms, firststeps, children, video | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 |
| neurologist | Neurologist | clinic | A+B | 2 | 2 | forms, firststeps, planbill, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q06 Q09 V18 V19 |
| notary | Notary public | service | A+B | 2 | 1 | video | - | setstart | setstart | - | L01 L06 |
| obgyn | OB-GYN | clinic | A+B | 3 | 2 | forms, firststeps, planbill, children, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 V19 |
| occupational-therapist | Occupational therapy | clinic | A+B | 2 | 3 | plans, planbill, forms, children, extrawork | sensitive, welfare | setstart | setstart | 24 hours before | B02 P02 Q01 Q05 Q06 Q09 V18 V19 |
| officiant | Wedding officiant | event | A+B | 5 | 4 | documents, firststeps, forms, extrawork, video, photos | - | setstart | setstart | 24 hours before | L01 L06 Q01 Q02 Q07 V19 |
| ophthalmologist | Ophthalmologist | clinic | A+B | 6 | 4 | planbill, forms, children, incare, photos, extrawork, documents, aftercare | sensitive | setstart | window | 24 hours before | B02 Q01 Q02 Q05 Q06 Q07 Q08 V18 V19 |
| optometrist | Optometrist | clinic | A+B | 1 | 4 | planbill, forms, children, incare, aftercare, extrawork, results | sensitive | setstart | window | 24 hours before | B02 Q01 Q05 Q06 Q08 V18 V19 |
| oral-surgeon | Oral surgeon | clinic | A+B | 6 | 4 | planbill, forms, children, incare, photos, extrawork, documents, aftercare | sensitive | setstart | window | 24 hours before | B02 Q01 Q02 Q05 Q06 Q07 Q08 V18 V19 |
| organizer | Professional organizer | project | A+B | 4 | 5 | firststeps, documents, multiday, extrawork, photos, video, banktransfer | cancelright | setstart | window | 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V19 V20 |
| orthodontist | Orthodontist | clinic | A+B | 6 | 4 | planbill, forms, children, incare, photos, extrawork, documents | sensitive | setstart | window | 24 hours before | B02 Q01 Q02 Q05 Q06 Q07 V18 V19 |
| orthopedist | Orthopedist | clinic | A+B | 2 | 2 | forms, firststeps, planbill, children, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 V19 |
| pain-management | Pain management | clinic | A+B | 2 | 3 | plans, planbill, forms, extrawork | sensitive | setstart | setstart | 24 hours before | B02 P02 Q01 Q06 V18 V19 |
| painter | Painter | project | A+B | 5 | 5 | firststeps, documents, multiday, extrawork, photos, banktransfer, video | cancelright | setstart | window | A: 24 hours before, B: 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V19 V20 |
| party-characters | Party characters, caricature and henna artists | event | A+B | 5 | 4 | documents, extrawork | - | window (default) | window (default) | - | Q02 V19 |
| paving | Paving, asphalt and driveway sealing | project | A+B | 4 | 4 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer, video | cancelright | setstart | window | 24 hours before | K06 L01 L06 Q01 Q02 Q07 V12 V16 V19 V20 |
| pediatrician | Pediatrician | clinic | A+B | 2 | 2 | children, forms, planbill, video, extrawork | sensitive | setstart | window | 24 hours before | B02 L01 L06 Q01 Q05 Q06 V18 V19 |
| personal-shopper | Personal shopper | consult | A+B | 4 | 4 | video, firststeps, forms, documents, photos, groups, extrawork | - | setstart | setstart | 24 hours before | K08 L01 L06 Q01 Q02 Q07 V19 |
| pest | Pest control | service | A+B | 1 | 3 | plans, firststeps, documents, extrawork | cancelright | setstart | window | A: 24 hours before, B: 6pm the day before | P02 Q01 Q02 V19 V20 |
| pet-cremation | Pet cremation and pet cemetery | consult | A+B | 3 | 3 | documents, sentnow | sensitive | setstart | window | A: 24 hours before, B: 24 hours before | B02 Q02 Q06 T12 V10 |
| pet-rehab | Pet hydrotherapy and rehab | clinic | A+B | 3 | 2 | animals, dropoff, firststeps, forms, results, aftercare | - | setstart | window | 24 hours before | K07 Q01 Q05 Q08 |
| pet-sitter | Pet sitter | service | A+B | 3 | 4 | animals, dropoff, firststeps, incare, multiday, photos, plans, photos, spaces, tips | - | setstart | window | A: 24 hours before, B: 7am the day of | K04 K06 K07 P02 Q01 Q05 Q07 V11 |
| pet-taxi | Pet taxi | service | A+B | 2 | 4 | animals, plans, forms, dropoff, extrawork | - | setstart | setstart | A: 24 hours before, B: 2 hours before | K07 P02 Q01 Q05 V19 |
| pet-waste | Pet waste removal | service | A+B | 2 | 4 | animals, plans, forms, photos, video | - | setstart | window 2h | A: 24 hours before, B: 6pm the day before | L01 L06 P02 Q01 Q05 Q07 |
| pharmacist | Pharmacist, vaccines & consults | clinic | A+B | 1 | 2 | children, documents, extrawork, firststeps, forms, planbill, video | sensitive | setstart | window | 24 hours before | B02 L01 L06 Q01 Q02 Q05 Q06 V18 V19 |
| photographer | Photographer & videographer | event | A+B | 6 | 5 | documents, extrawork, firststeps, forms, groups, children, photos, video | - | setstart | setstart | 24 hours before | K08 L01 L06 Q01 Q02 Q05 Q07 V19 |
| physical-therapist | Physical Therapy | clinic | A+B | 3 | 2 | planbill, forms, plans, video, children, extrawork, aftercare | sensitive, welfare | setstart | window | A: 24 hours before, B: 7am the day of | B02 L01 L06 P02 Q01 Q05 Q06 Q08 Q09 V18 V19 |
| piano-tuner | Piano tuner | fix | A+B | 5 | 6 | documents, photos, extrawork, firststeps, multiday, video, dropoff, banktransfer | - | setstart | window | 24 hours before | K06 K07 L01 L06 Q01 Q02 Q07 V12 V19 |
| pilates | Pilates studio | class | A+B | 2 | 4 | classes, packs, firststeps, forms, waitlist, video, children, tips, spaces, capacitycheck, extrawork, discounts, documents | - | setstart | setstart | A: 24 hours before, B: 7am the day of | K01 K02 K03 K04 K09 L01 L06 P01 P02 P03 Q01 Q02 Q05 V11 V13 V14 V19 |
| planner | Wedding & event planner | event | A+B | 4 | 1 | photos, documents, video, stages | - | setstart | setstart | 24 hours before | L01 L06 Q02 Q07 V16 |
| plastic-surgeon | Plastic and cosmetic surgeon | clinic | A+B | 4 | 2 | planbill, firststeps, forms, results, video, aftercare, children, extrawork, waitlist, plans | sensitive, welfare | setstart | setstart | A: 2 days before, B: 24 hours before | B02 L01 L06 P02 Q01 Q05 Q06 Q08 Q09 V14 V18 V19 |
| plumber | Plumber | fix | A+B | 6 | 6 | firststeps, documents, forms, sentnow, planbill, dropoff, extrawork, photos, video | cancelright | setstart | window | - | K07 L01 L06 Q01 Q02 Q07 T12 V10 V18 V19 V20 |
| pmu | Permanent makeup / microblading | chair | A+B | 2 | 1 | firststeps, forms, tips, aftercare | - | setstart | setstart | 24 hours before | Q01 Q08 V11 |
| podiatrist | Podiatrist | clinic | A+B | 3 | 2 | forms, planbill, results, aftercare, children, video, extrawork | sensitive, welfare | setstart | window | A: default, B: 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q08 Q09 V18 V19 |
| pool-builder | Pool and hot tub builder | project | A+B | 2 | 3 | documents, stages, photos, extrawork, firststeps, multiday, banktransfer, video, classes | cancelright | setstart | window | 24 hours before | K01 K02 K03 K06 L01 L06 Q01 Q02 Q07 V12 V16 V19 V20 |
| pool | Pool & spa service | service | A+B | 3 | 4 | plans, firststeps, dropoff, photos, tips, extrawork | - | setstart | window | A: 24 hours before, B: 2 days before | K07 P02 Q01 Q07 V11 V19 |
| pressure | Pressure washer | service | A+B | 3 | 5 | plans, dropoff, photos, tips, extrawork | - | setstart | window | A: 24 hours before, B: 2 days before | K07 P02 Q07 V11 V19 |
| primary-care | Primary care doctor | clinic | A+B | 2 | 2 | forms, firststeps, planbill, children, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 V19 |
| private-investigator | Private investigator | consult | A+B | 2 | 3 | firststeps, forms, documents, packs, video | sensitive | window | setstart | 24 hours before | B02 L01 L06 P01 P02 P03 Q01 Q02 Q06 |
| property-manager | Property manager | consult | A+B | 1 | 1 | photos, documents, waitlist, firststeps, capacitycheck | - | setstart | window | A: 24 hours before, B: 2 days before | K04 K09 Q01 Q02 Q07 V14 |
| psychiatrist | Psychiatrist | clinic | A+B | 3 | 2 | planbill, forms, plans, video, children, firststeps | sensitive | setstart | setstart | 24 hours before | B02 L01 L06 P02 Q01 Q05 Q06 V18 |
| psychic | Astrologer, psychic and tarot reader | consult | A+B | 4 | 3 | video, firststeps, packs, forms, documents, groups | sensitive | setstart | setstart | 24 hours before | B02 K08 L01 L06 P01 P02 P03 Q01 Q02 Q06 |
| radon | Radon testing and mitigation | project | A+B | 4 | 4 | documents, photos, extrawork, firststeps, results, banktransfer, video | cancelright | setstart | window | 24 hours before | L01 L06 Q01 Q02 Q07 Q08 V12 V19 V20 |
| realtor | Real estate agent | consult | A+B | 1 | 1 | nomoney, documents, firststeps, forms, video | nomoney | setstart | setstart | - | K04 L01 L06 M02 Q01 Q02 |
| recording-studio | Recording studio | chair | A+B | 4 | 3 | firststeps, forms, children, spaces, multiday | - | setstart | setstart | 24 hours before | K04 K06 Q01 Q05 |
| reiki | Reiki and energy healer | chair | A+B | 3 | 2 | packs, firststeps, forms, video, aftercare, children, tips | - | setstart | setstart | A: 24 hours before, B: 8pm the day before | L01 L06 P01 P02 P03 Q01 Q05 Q08 V11 |
| rentals | Party rentals | event | A+B | 3 | 3 | forms, documents, photos, extrawork | - | setstart | window 2h | 5pm the day before | K04 Q01 Q02 Q07 V19 |
| repair-shop | Electronics and device repair shop | dropoff | A+B | 5 | 4 | dropoff, photos, extrawork, documents | - | setstart | window | 24 hours before | K07 Q02 Q07 V19 |
| restaurant | Restaurant | table | A+B | 2 | 4 | spaces, groups, tips | - | setstart | window | A: 24 hours before, B: 2 days before | K04 K08 V11 |
| restoration | Damage restoration (water, fire and mold cleanup) | urgent | A+B | 2 | 5 | sentnow, firststeps, forms, documents, planbill, plans, extrawork, dropoff | cancelright | setstart | window | 24 hours before | K07 P02 Q01 Q02 T12 V10 V18 V19 V20 |
| roofer | Roofer | project | A+B | 6 | 8 | documents, photos, multiday, sentnow, extrawork, stages, banktransfer | cancelright | setstart | window | - | K06 Q02 Q07 T12 V10 V12 V16 V19 V20 |
| rv-repair | RV repair and service | dropoff | A+B | 4 | 4 | dropoff, extrawork | - | setstart | window | 2 days before | K07 V19 |
| security | Security systems installer | project | A+B | 6 | 5 | plans, monthlybill, dropoff, documents, extrawork, banktransfer | cancelright | setstart | window | 24 hours before | K07 P02 Q02 V12 V17 V19 V20 |
| senior-living | Senior living advisor | consult | A+B | 2 | 2 | nomoney, documents, firststeps, forms, video | sensitive, nomoney | setstart | window | 24 hours before | B02 L01 L06 M02 Q01 Q02 Q06 |
| senior-move | Senior move manager | project | A+B | 2 | 3 | firststeps, documents, multiday, extrawork, photos, video, monthlybill | cancelright, welfare | setstart | setstart | A: 24 hours before, B: 2 days before | K06 L01 L06 Q01 Q02 Q07 Q09 V17 V19 V20 |
| septic | Septic service | service | A+B | 5 | 6 | sentnow, plans, planbill, documents, extrawork, stages, dropoff, firststeps | cancelright | setstart | window | 24 hours before | K07 P02 Q01 Q02 T12 V10 V16 V18 V19 V20 |
| sharpening | Knife and tool sharpening | dropoff | A+B | 3 | 4 | dropoff, extrawork | - | setstart | window | A: 7am the day of, B: 6pm the day before | K07 V19 |
| shoe-repair | Shoe repair | dropoff | A+B | 3 | 2 | dropoff, extrawork | - | setstart | window | A: 24 hours before, B: 6pm the day before | K07 V19 |
| shooting | Shooting instructor and range | chair | A+B | 4 | 3 | firststeps, forms, children, classes, spaces | - | setstart | setstart | 24 hours before | K01 K02 K03 K04 Q01 Q05 |
| siding | Siding contractor | project | A+B | 6 | 7 | documents, photos, multiday, extrawork, stages, banktransfer | cancelright | setstart | window | 24 hours before | K06 Q02 Q07 V12 V16 V19 V20 |
| sitter | Babysitter & nanny | service | A+B | 2 | 2 | children, forms, dropoff, plans, packs, classes, groups | welfare | setstart | setstart | 24 hours before | K01 K02 K03 K07 K08 P01 P02 P03 Q01 Q05 Q09 |
| ski-instructor | Ski and snowboard instructor | chair | A+B | 2 | 2 | packs, firststeps, forms | - | setstart | setstart | 24 hours before | P01 P02 P03 Q01 |
| sleep-clinic | Sleep clinic | clinic | A+B | 4 | 2 | forms, firststeps, planbill, children, video, multiday, dropoff | sensitive, welfare | setstart | window | 2 days before | B02 K06 K07 L01 L06 Q01 Q05 Q06 Q09 V18 |
| small-engine | Small engine and lawn mower repair | dropoff | A+B | 4 | 4 | dropoff, photos, extrawork | - | setstart | window | 24 hours before | K07 Q07 V19 |
| snow | Snow removal | service | A+B | 4 | 4 | plans, stages, documents, sentnow, extrawork | cancelright | setstart | window | 24 hours before | P02 Q02 T12 V10 V16 V19 V20 |
| spa | Day spa | chair | A+B | 2 | 3 | plans, packs, groups, forms, children, aftercare, tips | - | setstart | setstart | 24 hours before | K08 P01 P02 P03 Q01 Q05 Q08 V11 |
| speech-therapist | Speech therapist | clinic | A+B | 3 | 2 | planbill, forms, plans, video, children, firststeps, results | sensitive, welfare | setstart | setstart | A: 24 hours before, B: 7am the day of | B02 L01 L06 P02 Q01 Q05 Q06 Q08 Q09 V18 |
| sports-coach | Private sports coach | chair | A+B | 2 | 2 | packs, firststeps, forms | sensitive | setstart | setstart | 24 hours before | B02 P01 P02 P03 Q01 Q06 |
| sports-medicine | Sports medicine | clinic | A+B | 2 | 3 | plans, planbill, forms, children, extrawork | sensitive | setstart | setstart | 24 hours before | B02 P02 Q01 Q05 Q06 V18 V19 |
| spray-tan | Tanning and spray tan | chair | A+B | 2 | 3 | packs, firststeps, forms, groups, aftercare, tips | - | setstart | window | A: 24 hours before, B: 7am the day of | K08 P01 P02 P03 Q01 Q08 V11 |
| surf-school | Surf and paddle school | class | A+B | 2 | 2 | classes, groups, children, waitlist, forms | - | setstart | setstart | 24 hours before | K01 K02 K03 K08 Q01 Q05 V14 |
| surveyor | Land surveyor | service | A+B | 4 | 4 | documents, firststeps, results, photos, video, extrawork | - | setstart | window | 6pm the day before | L01 L06 Q01 Q02 Q07 Q08 V19 |
| swim | Swim school | class | A+B | 1 | 1 | classes, children, plans, forms, waitlist, groups | - | setstart | setstart | 24 hours before | K01 K02 K03 K08 P02 Q01 Q05 V14 |
| tailor | Tailoring and alterations | dropoff | A+B | 4 | 2 | dropoff, extrawork | - | setstart | window | 24 hours before | K07 V19 |
| tattoo | Tattoo studio | chair | A+B | 5 | 3 | firststeps, forms, documents, groups, extrawork, photos | - | setstart | setstart | A: 24 hours before, B: 7am the day of | K08 Q01 Q02 Q07 V19 |
| tax | Tax preparer | consult | A+B | 4 | 3 | firststeps, forms, documents, video, extrawork | - | setstart | setstart | 24 hours before | L01 L06 Q01 Q02 V19 |
| teeth-whitening | Teeth whitening (non-dental studio) | chair | A+B | 2 | 3 | packs, firststeps, forms, groups, aftercare | - | setstart | setstart | A: 24 hours before, B: 7am the day of | K08 P01 P02 P03 Q01 Q08 |
| tennis-coach | Tennis Coach | class | A+B | 3 | 2 | packs, classes, plans, forms, children, waitlist, extrawork | - | setstart | setstart | A: default, B: 24 hours before | K01 K02 K03 P01 P02 P03 Q01 Q05 V14 V19 |
| therapist | Mental health therapist | clinic | A+B | 3 | 2 | planbill, forms, plans, video, children, firststeps | sensitive | setstart | setstart | 24 hours before | B02 L01 L06 P02 Q01 Q05 Q06 V18 |
| tires | Tire shop | chair | A+B | 4 | 2 | dropoff, extrawork, aftercare, sentnow, spaces | - | setstart | window 2h | - | K04 K07 Q08 T12 V10 V19 |
| tours | Tour guide and tour operator | class | A+B | 4 | 3 | classes, groups, children, multiday, firststeps | - | setstart | setstart | 24 hours before | K01 K02 K03 K06 K08 Q01 Q05 |
| towing | Towing & roadside | urgent | A+B | 1 | 2 | sentnow, dropoff, forms, documents, extrawork | - | window | setstart | - | K07 Q01 Q02 T12 V10 V19 |
| trainer | Personal trainer | chair | A+B | 3 | 2 | packs, firststeps, forms | - | setstart | setstart | 24 hours before | P01 P02 P03 Q01 |
| trampoline-park | Trampoline park and indoor playground | table | A+B | 3 | 3 | groups, children, forms, spaces, capacitycheck, extrawork | - | setstart | setstart | A: 24 hours before, B: 2 days before | K04 K08 K09 Q01 Q05 V19 |
| translator | Translator and interpreter | consult | A+B | 2 | 3 | video, results, monthlybill, extrawork | sensitive | setstart | setstart | A: default, B: 48 hours before | B02 L01 L06 Q06 Q08 V17 V19 |
| travel-agent | Travel agent | consult | A+B | 4 | 4 | video, firststeps, forms, documents, groups, children | - | setstart | setstart | 24 hours before | K08 L01 L06 Q01 Q02 Q05 |
| tree | Tree service | project | A+B | 6 | 5 | firststeps, documents, extrawork, multiday, dropoff, banktransfer | - | window (default) | window (default) | 2 days before | K06 K07 Q01 Q02 V12 V19 |
| tutor | Tutor | chair | A+B | 3 | 2 | children, firststeps, forms, video | - | setstart | setstart | 24 hours before | L01 L06 Q01 Q05 |
| tv-repair | TV Repair | fix | A+B | 2 | 3 | dropoff, extrawork, planbill, forms, photos | - | window (default) | window | A: default, B: 24 hours before | K07 Q01 Q07 V18 V19 |
| upholstery | Furniture reupholstery and repair | dropoff | A+B | 3 | 3 | dropoff, photos, extrawork | - | setstart | window | A: 24 hours before, B: 6pm the day before | K07 Q07 V19 |
| urgent-care | Urgent care clinic | clinic | A+B | 1 | 2 | planbill, forms, sentnow, results, extrawork, children, video | sensitive | setstart | window | - | B02 L01 L06 Q01 Q05 Q06 Q08 T12 V10 V18 V19 |
| urologist | Urologist | clinic | A+B | 2 | 2 | forms, firststeps, planbill, video, extrawork | sensitive, welfare | setstart | window | 24 hours before | B02 L01 L06 Q01 Q06 Q09 V18 V19 |
| valet | Valet parking for events | event | A+B | 2 | 4 | firststeps, documents, extrawork | - | setstart | window | A: 24 hours before, B: 2 days before | Q01 Q02 V19 |
| vehicle-inspection | Emissions and vehicle inspection | chair | A+B | 2 | 2 | dropoff, spaces, aftercare | - | setstart | window 2h | 24 hours before | K04 K07 Q08 |
| vehicle-wrap | Vehicle wrap | dropoff | A+B | 4 | 3 | dropoff, photos, extrawork, multiday, documents, aftercare | - | setstart | window 2h | A: 24 hours before, B: 24 hours before | K06 K07 Q02 Q07 Q08 V19 |
| vet | Veterinarian | clinic | A+B | 5 | 3 | animals, dropoff, firststeps, forms, results, video, aftercare | - | setstart | window | 24 hours before | K07 L01 L06 Q01 Q05 Q08 |
| watch-jewelry | Watch and jewelry repair | dropoff | A+B | 4 | 4 | dropoff, photos, extrawork | - | setstart | window | A: 24 hours before, B: 24 hours before | K07 Q07 V19 |
| weight-loss | Weight loss clinic | clinic | A+B | 2 | 2 | planbill, forms, firststeps, video, children | sensitive, welfare | setstart | setstart | 24 hours before | B02 L01 L06 Q01 Q05 Q06 Q09 V18 |
| well-pump | Well drilling and well pump service | fix | A+B | 6 | 6 | firststeps, documents, sentnow, dropoff, extrawork, photos, results, video | cancelright | setstart | window | - | K07 L01 L06 Q01 Q02 Q07 Q08 T12 V10 V19 V20 |
| wellness-studio | Float, sauna, cryotherapy and wellness studio | chair | A+B | 2 | 2 | plans, packs, groups, forms, children, aftercare, spaces | - | setstart | setstart | A: 24 hours before, B: 8pm the day before | K04 K08 P01 P02 P03 Q01 Q05 Q08 |
| wildlife | Wildlife and animal removal | service | A+B | 5 | 4 | firststeps, photos, documents, extrawork | cancelright | setstart | window | A: 24 hours before, B: 24 hours before | Q01 Q02 Q07 V19 V20 |
| window-tint | Window tinting | chair | A+B | 4 | 3 | dropoff, extrawork, aftercare, spaces | - | setstart | window 2h | 24 hours before | K04 K07 Q08 V19 |
| windows | Window & gutter cleaner | service | A+B | 3 | 6 | plans, dropoff, photos, extrawork, documents, tips | - | window (default) | window | A: 24 hours before, B: 24 hours before | K07 P02 Q02 Q07 V11 V19 |
| yoga | Yoga studio | class | A+B | 7 | 6 | classes, children, groups, waitlist, video, firststeps, forms, extrawork, documents, photos, capacitycheck | - | setstart | setstart | 24 hours before | K01 K02 K03 K08 K09 L01 L06 Q01 Q02 Q05 Q07 V14 V19 |

## 3. Money paths per profession

Paths read `price kind | money before | money after`. Price kinds: list, photos, visit. Before: none, card, deposit, full. After in flow A: none, counter, bill, card. After in flow B: none, bill, card, own (the business bills its own way). Each path is one of the master's 28 per flow.

| id | flow A paths | flow B paths |
|---|---|---|
| aba | list\|none\|bill, list\|card\|card | list\|none\|bill, list\|card\|card, list\|none\|own |
| acupuncturist | list\|card\|counter, list\|none\|counter, list\|card\|card | list\|card\|bill, list\|none\|own, list\|card\|card |
| addiction | list\|none\|counter, list\|none\|bill, list\|card\|card, list\|full\|none | list\|none\|bill, list\|none\|own, list\|card\|card |
| advisor | list\|none\|counter | list\|none\|own |
| airport-shuttle | list\|full\|none, list\|none\|bill | list\|full\|none, list\|card\|card, list\|none\|bill, photos\|card\|card |
| allergist | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| appliance | visit\|card\|counter, visit\|none\|counter, list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter | visit\|card\|bill, visit\|none\|bill, visit\|deposit\|bill, list\|card\|bill, list\|full\|none, photos\|deposit\|bill |
| appraiser | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|card\|card | list\|card\|card, list\|none\|bill, list\|full\|none, photos\|deposit\|bill |
| aquarium | list\|none\|counter, list\|none\|none, list\|card\|counter | list\|card\|card, visit\|card\|card, photos\|deposit\|bill, list\|card\|bill |
| architect | list\|card\|counter, list\|full\|none, list\|deposit\|counter, photos\|deposit\|bill, photos\|none\|none | list\|card\|bill, list\|deposit\|card, list\|full\|none |
| art-appraiser | list\|card\|counter, list\|full\|none, list\|deposit\|counter, photos\|deposit\|bill, photos\|none\|none | list\|card\|bill, list\|deposit\|card, list\|full\|none |
| art-classes | list\|full\|none, list\|none\|counter | list\|card\|card, list\|full\|none |
| auto-body | photos\|none\|counter, photos\|none\|bill, photos\|deposit\|counter, photos\|deposit\|bill, list\|none\|counter | photos\|none\|bill, visit\|none\|bill, list\|none\|bill |
| auto-glass | list\|none\|counter | list\|card\|own, list\|card\|bill |
| auto-repair | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|none\|bill | list\|card\|bill, visit\|card\|bill, list\|card\|card, photos\|deposit\|bill |
| axe-throwing | list\|full\|none, list\|deposit\|counter, list\|none\|counter | list\|deposit\|card, list\|card\|bill, list\|full\|none |
| baker | list\|full\|none, list\|deposit\|card, photos\|deposit\|card | photos\|deposit\|card, list\|deposit\|card, list\|full\|none |
| band | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter | photos\|deposit\|card, photos\|deposit\|bill, list\|deposit\|card, list\|full\|none |
| barber | list\|card\|counter, list\|none\|counter, list\|deposit\|counter | list\|card\|bill, list\|full\|none, photos\|deposit\|bill |
| bike-repair | list\|none\|counter, visit\|none\|counter, list\|deposit\|counter, list\|card\|counter | list\|card\|card, visit\|card\|card |
| biohazard | visit\|none\|bill, list\|none\|none | visit\|none\|bill, photos\|deposit\|bill, list\|none\|bill |
| boarding | list\|card\|counter, list\|deposit\|counter | list\|card\|card, list\|deposit\|card |
| boat-repair | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|none\|bill | list\|card\|bill, visit\|card\|bill, list\|card\|card, photos\|deposit\|bill |
| camp | list\|deposit\|card, list\|full\|none, list\|none\|none | list\|deposit\|card, list\|full\|none |
| cardiologist | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| carpet | list\|none\|counter, list\|card\|counter, list\|full\|none, photos\|none\|counter, visit\|none\|counter | list\|card\|bill, list\|card\|card, list\|none\|bill, photos\|card\|bill, visit\|card\|bill |
| caterer | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|deposit\|card, list\|full\|none, photos\|card\|counter, visit\|card\|counter | photos\|deposit\|card, photos\|deposit\|bill, list\|card\|bill, list\|card\|card, list\|full\|none, list\|deposit\|card, visit\|card\|bill |
| chef | list\|full\|none, list\|deposit\|counter | photos\|deposit\|bill, list\|full\|none |
| chimney | list\|card\|counter, list\|none\|counter, list\|deposit\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | list\|card\|bill, list\|deposit\|bill, list\|none\|bill, visit\|card\|bill, photos\|deposit\|bill |
| chiropractor | list\|none\|counter, list\|card\|counter | list\|card\|card, list\|none\|bill, list\|none\|own |
| cleaner | list\|none\|counter, list\|card\|counter, list\|full\|none, photos\|none\|counter, visit\|none\|counter | list\|card\|card, list\|none\|bill, photos\|card\|card, visit\|card\|card |
| climbing-gym | list\|full\|none, list\|none\|counter, list\|card\|counter, list\|deposit\|counter | list\|deposit\|bill, list\|full\|none |
| closets | list\|card\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | visit\|card\|bill, visit\|card\|own, list\|card\|bill, list\|full\|none, photos\|deposit\|bill |
| clown | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter | photos\|deposit\|card, photos\|deposit\|bill, list\|deposit\|card, list\|full\|none |
| coach | list\|full\|none, list\|card\|card | list\|none\|own, list\|none\|bill, photos\|deposit\|bill |
| coding-classes | list\|full\|none, list\|none\|counter | list\|card\|card, list\|full\|none |
| college-admissions | list\|full\|none, list\|card\|card, photos\|deposit\|counter, list\|none\|counter | list\|card\|card, photos\|deposit\|bill, list\|none\|bill, list\|full\|none |
| comedian | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter | photos\|deposit\|card, photos\|deposit\|bill, list\|deposit\|card, list\|full\|none |
| commercial-cleaning | list\|none\|counter, list\|card\|counter, list\|full\|none, photos\|none\|counter, visit\|none\|counter | list\|card\|bill, list\|none\|bill, list\|deposit\|bill, photos\|deposit\|bill, visit\|card\|bill |
| concierge | list\|card\|card, list\|full\|none | list\|card\|card, list\|none\|bill |
| concrete | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| contractor | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| cooking-classes | list\|full\|none, list\|none\|counter | list\|card\|card, list\|full\|none |
| cpa | list\|card\|card, list\|none\|bill, photos\|card\|card | list\|none\|bill, list\|none\|own, photos\|deposit\|bill |
| cpr-training | list\|full\|none, list\|none\|bill | list\|none\|bill, list\|full\|none |
| credit-counselor | list\|none\|counter, list\|card\|counter, list\|card\|card, list\|full\|none | list\|none\|bill, list\|card\|bill, photos\|card\|bill |
| dance | list\|full\|none, list\|none\|counter | list\|card\|card, list\|full\|none |
| daycare | list\|deposit\|card, list\|none\|counter, list\|full\|none | list\|card\|card, list\|none\|bill |
| deck | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| demolition | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| dentist | list\|none\|counter, list\|card\|counter, visit\|none\|counter, list\|full\|none, photos\|none\|counter | list\|none\|own, list\|card\|bill, visit\|none\|own, list\|full\|none, photos\|deposit\|bill |
| dermatologist | list\|none\|counter, list\|card\|counter, list\|deposit\|counter | list\|none\|own |
| detailing | list\|card\|counter, list\|deposit\|counter | list\|card\|bill, list\|deposit\|bill |
| dietitian | list\|none\|counter, list\|card\|counter, list\|none\|bill | list\|none\|bill, list\|none\|own |
| dj | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter | photos\|deposit\|card, photos\|deposit\|bill, list\|deposit\|card, list\|full\|none |
| dog-trainer | list\|card\|counter, list\|full\|none, list\|card\|bill | list\|card\|bill, list\|card\|card, list\|full\|none |
| dog-walker | list\|card\|card, list\|full\|none | list\|card\|card, list\|none\|bill, list\|full\|none |
| doula | list\|deposit\|counter, list\|none\|none, list\|none\|counter, list\|full\|none | list\|deposit\|bill, list\|none\|bill, list\|full\|none |
| driving-school | list\|full\|none, list\|card\|counter, list\|deposit\|card | list\|full\|none, list\|deposit\|card, list\|card\|card |
| drywall | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter, list\|none\|none | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill, list\|card\|bill |
| duct-cleaning | list\|none\|counter, list\|card\|counter, list\|full\|none, photos\|none\|counter, visit\|none\|counter | list\|card\|card, list\|none\|bill, photos\|deposit\|card, visit\|card\|card |
| electrician | list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, visit\|card\|bill, visit\|none\|bill, photos\|deposit\|bill, list\|full\|none |
| endocrinologist | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| energy-audit | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|card\|card | list\|card\|card, list\|none\|bill, list\|full\|none, photos\|deposit\|bill |
| enrichment | list\|deposit\|card, list\|full\|none, list\|none\|none | list\|card\|card, list\|none\|bill |
| ent | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| escape-room | list\|full\|none, list\|deposit\|bill, list\|deposit\|counter | list\|deposit\|bill, list\|full\|none |
| estate-sale | list\|none\|none, list\|card\|counter | visit\|none\|own, visit\|none\|bill, list\|none\|bill |
| esthetician | list\|card\|counter, list\|none\|counter, list\|deposit\|counter, list\|full\|none, visit\|deposit\|counter | list\|card\|bill, list\|card\|card, photos\|deposit\|bill, photos\|deposit\|card |
| event-staffing | list\|full\|none, list\|none\|none | list\|deposit\|card, list\|full\|none, visit\|card\|bill, list\|card\|card |
| excavation | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| face-painter | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|full\|none | photos\|deposit\|card, photos\|deposit\|bill, list\|deposit\|card, list\|full\|none |
| farrier | list\|card\|counter, list\|none\|counter, visit\|card\|counter | list\|card\|card, list\|card\|bill, list\|none\|bill, visit\|card\|card |
| fence | list\|none\|none | visit\|none\|bill, photos\|deposit\|bill, list\|none\|bill |
| fertility | list\|none\|bill, list\|card\|counter, list\|full\|none, list\|deposit\|bill | list\|none\|own, list\|none\|bill |
| fishing-charter | list\|deposit\|counter, list\|full\|none | list\|deposit\|card |
| flight-school | list\|card\|card, list\|card\|counter, list\|full\|none, list\|deposit\|counter | list\|card\|card, list\|full\|none, list\|deposit\|bill |
| flooring | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter, visit\|card\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill, list\|card\|bill, list\|full\|none |
| florist | list\|none\|counter, list\|full\|none, list\|deposit\|counter | photos\|deposit\|bill, list\|full\|none |
| food-truck | list\|full\|none, list\|none\|none | list\|deposit\|card, list\|full\|none, visit\|none\|bill, list\|card\|card |
| foundation | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| funeral | visit\|none\|bill, visit\|none\|counter, list\|none\|counter | visit\|none\|bill, visit\|none\|own, list\|none\|own |
| garage-door | list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, visit\|card\|bill, visit\|card\|card, photos\|deposit\|bill, list\|full\|none |
| gastroenterologist | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| glass-doors | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| golf-instructor | list\|full\|none, list\|card\|counter, list\|card\|card | list\|card\|card, list\|full\|none |
| groomer | list\|card\|counter, list\|none\|counter, visit\|card\|counter | list\|card\|card, list\|card\|bill, visit\|card\|card |
| gunsmith | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|deposit\|counter | list\|card\|card, visit\|card\|bill |
| gutters | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter, visit\|card\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, list\|card\|bill, photos\|deposit\|bill, list\|none\|bill, list\|full\|none |
| gym | list\|full\|none, list\|card\|counter | list\|card\|card, list\|none\|bill, list\|full\|none |
| gymnastics | list\|full\|none, list\|card\|counter | list\|card\|card, list\|none\|bill |
| hair-restoration | list\|none\|none, list\|card\|counter, list\|deposit\|counter, list\|full\|none | list\|card\|card, list\|full\|none |
| hair | list\|card\|counter, list\|none\|counter, list\|deposit\|counter, photos\|card\|counter, photos\|deposit\|counter, visit\|card\|counter, visit\|deposit\|counter | list\|card\|bill, list\|card\|card, photos\|deposit\|bill, photos\|deposit\|card, list\|full\|none, visit\|card\|bill |
| handyman | list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, visit\|card\|bill, visit\|none\|bill, photos\|deposit\|bill, list\|full\|none |
| hearing | list\|none\|counter, visit\|none\|counter, list\|deposit\|counter | list\|none\|own, list\|none\|bill, visit\|none\|bill, list\|deposit\|bill |
| holiday-lights | list\|none\|counter, photos\|none\|counter, visit\|none\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, list\|full\|none, photos\|deposit\|bill, visit\|card\|bill |
| home-care | list\|none\|counter, list\|card\|counter, list\|none\|bill, list\|full\|none | list\|card\|card, list\|card\|bill, list\|none\|own, photos\|card\|card |
| home-engineer | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|card\|card | list\|card\|card, list\|none\|bill, list\|full\|none, photos\|deposit\|bill |
| home-stager | list\|card\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | visit\|card\|bill, visit\|card\|own, list\|card\|bill, list\|full\|none, photos\|deposit\|bill |
| horse-riding | list\|full\|none, list\|card\|counter, list\|deposit\|counter | list\|card\|card, list\|deposit\|bill |
| hunting-guide | list\|deposit\|counter, list\|full\|none, list\|none\|counter | list\|deposit\|card, list\|card\|bill, list\|full\|none |
| hvac | list\|card\|counter, list\|none\|counter, list\|deposit\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | visit\|card\|bill, visit\|none\|bill, list\|card\|bill, list\|none\|bill, list\|card\|card, list\|full\|none, photos\|deposit\|bill |
| hypnotherapist | list\|card\|counter, list\|full\|none, list\|card\|card | list\|card\|bill, list\|full\|none |
| image-consultant | list\|full\|none, list\|card\|card, photos\|deposit\|card, list\|none\|counter | list\|card\|card, photos\|deposit\|bill, list\|none\|bill, list\|full\|none |
| imaging | list\|none\|counter, list\|full\|none | list\|none\|own, list\|none\|bill |
| immigration-services | list\|none\|counter, list\|full\|none, list\|none\|bill | list\|none\|bill, list\|card\|card |
| inspector | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|card\|card | list\|card\|card, list\|none\|bill, list\|full\|none, photos\|card\|card, list\|card\|own |
| instrument-repair | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|deposit\|counter | list\|card\|bill, visit\|card\|bill, list\|card\|card, photos\|deposit\|bill |
| insulation | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| insurance | list\|none\|none | list\|none\|none |
| interior | list\|card\|card, list\|card\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | visit\|card\|bill, visit\|card\|own, list\|card\|bill, list\|full\|none, photos\|deposit\|bill, visit\|card\|card |
| irrigation | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter, visit\|card\|counter | list\|card\|card, list\|none\|bill, list\|full\|none, photos\|deposit\|bill, visit\|card\|card |
| iv-hydration | list\|card\|counter, list\|none\|none, list\|none\|counter, list\|full\|none | list\|card\|card, list\|deposit\|card |
| junk | list\|none\|counter, visit\|none\|counter, photos\|none\|counter, list\|full\|none | visit\|card\|bill, visit\|none\|bill, list\|card\|card, photos\|card\|bill, list\|full\|none |
| lab | list\|none\|bill, list\|full\|none, list\|none\|counter | list\|none\|bill, list\|full\|none, list\|card\|card, list\|none\|own |
| lactation | list\|none\|counter, list\|none\|none, list\|full\|none | list\|none\|bill, list\|none\|own, list\|full\|none |
| language-school | list\|full\|none, list\|none\|counter | list\|card\|card, list\|full\|none |
| lash-brow | list\|card\|counter, list\|deposit\|counter | list\|card\|bill, photos\|deposit\|card |
| laundry | list\|none\|counter, visit\|none\|counter, list\|deposit\|counter | list\|card\|card, list\|none\|bill |
| lawn | list\|none\|counter, photos\|none\|counter, visit\|none\|counter | list\|card\|card, list\|none\|bill, list\|full\|none, photos\|card\|card, visit\|card\|card |
| lawyer | list\|none\|counter, list\|card\|counter, list\|none\|bill, list\|card\|card, visit\|none\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, list\|card\|own, list\|none\|own, visit\|card\|bill |
| limo | list\|full\|none, list\|none\|counter | list\|deposit\|card, list\|card\|card, list\|full\|none, photos\|deposit\|card |
| locksmith | list\|none\|counter, list\|card\|counter, list\|deposit\|counter, list\|full\|none, photos\|none\|counter, visit\|none\|counter | list\|card\|bill, list\|card\|card, list\|card\|own, list\|full\|none, photos\|deposit\|bill, visit\|card\|bill |
| magician | list\|full\|none, list\|card\|counter | list\|deposit\|bill, list\|deposit\|own |
| makeup | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|full\|none | photos\|deposit\|card, photos\|deposit\|bill, list\|deposit\|card, list\|full\|none |
| martial-arts | list\|none\|none, list\|full\|none | list\|card\|card, list\|none\|bill, list\|full\|none |
| masonry | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| massage | list\|card\|counter, list\|card\|bill | list\|card\|bill, list\|card\|card, list\|full\|none |
| matchmaker | list\|full\|none, list\|card\|card, photos\|deposit\|counter, list\|none\|counter | list\|card\|card, photos\|deposit\|bill, list\|none\|bill, list\|full\|none |
| mediator | list\|deposit\|counter, list\|full\|none, list\|none\|bill | list\|deposit\|bill, list\|card\|card, list\|full\|none |
| medical-transport | list\|full\|none, list\|none\|bill | list\|card\|card, list\|none\|bill, list\|none\|own, photos\|card\|card |
| medspa | visit\|deposit\|counter, list\|card\|counter, list\|none\|none | visit\|deposit\|bill, visit\|deposit\|card |
| midwife | list\|deposit\|counter, list\|none\|none, list\|none\|counter, list\|full\|none | list\|deposit\|bill, list\|none\|own, list\|full\|none |
| mini-golf | list\|full\|none, list\|deposit\|counter, list\|none\|counter | list\|deposit\|card, list\|card\|bill, list\|full\|none |
| mortgage | list\|none\|counter | list\|none\|own |
| motorcycle | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|none\|bill | list\|card\|bill, visit\|card\|bill, list\|card\|card, photos\|deposit\|bill |
| movers | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter | visit\|none\|bill, visit\|none\|own, photos\|deposit\|bill, list\|card\|card, list\|full\|none |
| music | list\|card\|card, list\|full\|none, list\|card\|counter | list\|card\|card, list\|full\|none |
| nails | list\|none\|counter, list\|card\|counter, list\|deposit\|counter, photos\|none\|counter, photos\|deposit\|counter | list\|card\|bill, list\|card\|card, list\|full\|none, photos\|deposit\|bill, photos\|deposit\|card |
| naturopath | list\|none\|counter, list\|card\|counter | list\|none\|bill, list\|none\|own |
| neurologist | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| notary | list\|none\|counter, list\|none\|bill | list\|card\|card |
| obgyn | list\|none\|counter, list\|card\|counter, list\|full\|none | list\|none\|own, list\|none\|bill |
| occupational-therapist | list\|none\|counter, list\|card\|counter | list\|card\|card, list\|none\|bill, list\|none\|own |
| officiant | list\|deposit\|counter, list\|card\|counter, list\|none\|none, list\|full\|none, photos\|deposit\|bill | list\|deposit\|card, list\|full\|none, list\|none\|bill, photos\|deposit\|bill |
| ophthalmologist | list\|none\|counter, list\|card\|counter, list\|deposit\|counter, list\|full\|none, photos\|deposit\|counter, visit\|none\|counter | list\|none\|own, list\|none\|bill, visit\|none\|own, photos\|deposit\|bill |
| optometrist | list\|none\|counter | list\|none\|own, list\|none\|bill, visit\|none\|own, list\|deposit\|bill |
| oral-surgeon | list\|none\|counter, list\|card\|counter, list\|deposit\|counter, list\|full\|none, photos\|deposit\|counter, visit\|none\|counter | list\|none\|own, list\|none\|bill, visit\|none\|own, photos\|deposit\|bill |
| organizer | list\|card\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | visit\|card\|bill, visit\|card\|own, list\|card\|bill, list\|full\|none, photos\|deposit\|bill |
| orthodontist | list\|none\|counter, list\|card\|counter, list\|deposit\|counter, list\|full\|none, photos\|deposit\|counter, visit\|none\|counter | list\|none\|own, list\|none\|bill, visit\|none\|own, photos\|deposit\|bill |
| orthopedist | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| pain-management | list\|none\|counter, list\|card\|counter | list\|card\|card, list\|none\|bill, list\|none\|own |
| painter | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill, list\|card\|bill |
| party-characters | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|full\|none, photos\|card\|counter | photos\|deposit\|card, photos\|deposit\|bill, list\|deposit\|card, list\|full\|none |
| paving | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| pediatrician | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| personal-shopper | list\|full\|none, list\|card\|card, photos\|deposit\|card, list\|none\|counter | list\|card\|card, photos\|deposit\|bill, list\|none\|bill, list\|full\|none |
| pest | list\|none\|counter | list\|card\|card, list\|none\|bill, visit\|card\|card |
| pet-cremation | list\|full\|none, list\|none\|counter, visit\|none\|counter | list\|none\|bill, list\|full\|none, list\|none\|own |
| pet-rehab | list\|none\|counter, list\|card\|counter, list\|full\|none | list\|none\|bill, list\|none\|own |
| pet-sitter | list\|card\|counter, list\|deposit\|counter, list\|full\|none | list\|card\|card, list\|none\|bill, list\|deposit\|card, list\|full\|none |
| pet-taxi | list\|card\|card, list\|full\|none | list\|card\|card, list\|none\|bill, list\|full\|none, list\|deposit\|card |
| pet-waste | list\|none\|none, list\|full\|none | list\|card\|card, list\|none\|bill, list\|full\|none, photos\|card\|card |
| pharmacist | list\|none\|counter | list\|none\|own, list\|none\|bill |
| photographer | list\|deposit\|counter, list\|card\|counter, list\|none\|counter, list\|deposit\|card, list\|full\|none, photos\|card\|counter | photos\|deposit\|card, photos\|deposit\|bill, list\|full\|none, list\|card\|bill, visit\|card\|bill |
| physical-therapist | list\|none\|counter, list\|card\|counter, list\|card\|card | list\|none\|own, list\|card\|card |
| piano-tuner | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, visit\|card\|counter | list\|card\|bill, list\|none\|bill, visit\|card\|bill, visit\|none\|bill, photos\|deposit\|bill, list\|full\|none |
| pilates | list\|full\|none, list\|card\|counter | list\|card\|card, list\|full\|none, list\|none\|bill, photos\|deposit\|bill |
| planner | photos\|deposit\|bill, list\|full\|none, list\|none\|bill, list\|none\|none | photos\|deposit\|card |
| plastic-surgeon | list\|none\|counter, list\|none\|none, list\|card\|counter, list\|deposit\|counter | list\|card\|card, list\|none\|own |
| plumber | list\|card\|counter, list\|none\|counter, list\|deposit\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, visit\|card\|bill, photos\|deposit\|bill, list\|full\|none |
| pmu | list\|deposit\|counter, list\|none\|counter | list\|deposit\|bill |
| podiatrist | list\|none\|counter, list\|card\|counter, list\|card\|card | list\|none\|bill, list\|card\|card |
| pool-builder | list\|none\|none, list\|full\|none | visit\|none\|bill, visit\|none\|own, photos\|deposit\|bill |
| pool | list\|none\|counter, photos\|none\|counter, visit\|none\|counter | list\|card\|card, list\|none\|bill, photos\|card\|card, visit\|card\|card |
| pressure | list\|none\|counter, photos\|none\|counter, visit\|none\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, photos\|deposit\|bill, visit\|card\|bill |
| primary-care | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| private-investigator | list\|none\|counter, list\|card\|card | list\|deposit\|bill, list\|full\|none, list\|none\|bill |
| property-manager | list\|none\|counter | list\|none\|own |
| psychiatrist | list\|card\|card, list\|card\|counter, list\|none\|counter | list\|card\|card, list\|none\|own |
| psychic | list\|none\|counter, list\|card\|counter, list\|card\|card, list\|full\|none | list\|none\|bill, list\|card\|bill, photos\|deposit\|bill |
| radon | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill |
| realtor | list\|none\|counter | list\|none\|own |
| recording-studio | list\|full\|none, list\|card\|counter, list\|card\|card, list\|deposit\|counter | list\|card\|card, list\|full\|none, list\|deposit\|bill |
| reiki | list\|card\|counter, list\|full\|none, list\|card\|card | list\|card\|bill, list\|full\|none |
| rentals | list\|deposit\|counter, list\|card\|counter, list\|full\|none | list\|deposit\|card, list\|full\|none, photos\|deposit\|card |
| repair-shop | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|none\|bill, list\|deposit\|counter | list\|card\|bill, visit\|card\|bill, list\|card\|card, photos\|deposit\|bill |
| restaurant | list\|card\|counter, list\|none\|counter | list\|card\|bill, list\|card\|card, photos\|deposit\|bill, photos\|deposit\|card |
| restoration | list\|none\|counter, visit\|none\|counter | visit\|none\|bill, visit\|card\|bill, visit\|none\|own, photos\|deposit\|bill, list\|none\|bill |
| roofer | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter, visit\|card\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, list\|card\|bill, photos\|deposit\|bill, list\|none\|bill, list\|full\|none, list\|deposit\|bill |
| rv-repair | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|none\|bill | list\|card\|bill, visit\|card\|bill, list\|card\|card, photos\|deposit\|bill |
| security | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, visit\|none\|counter, photos\|card\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, photos\|deposit\|bill, list\|card\|bill |
| senior-living | list\|none\|counter, list\|none\|none | list\|none\|own, list\|none\|none |
| senior-move | list\|none\|none, list\|full\|none | visit\|none\|bill, visit\|none\|own, list\|none\|bill |
| septic | list\|card\|counter, list\|none\|counter, list\|full\|none, visit\|card\|counter, photos\|card\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, visit\|card\|bill, photos\|deposit\|bill, list\|full\|none |
| sharpening | list\|none\|counter, visit\|none\|counter, list\|none\|bill | list\|card\|card, list\|card\|bill, visit\|card\|bill, list\|none\|bill |
| shoe-repair | list\|none\|counter, visit\|none\|counter, list\|deposit\|counter | visit\|card\|bill, list\|card\|bill |
| shooting | list\|full\|none, list\|card\|counter, list\|card\|card, list\|deposit\|counter | list\|card\|card, list\|full\|none, list\|deposit\|bill |
| siding | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter, visit\|card\|counter | visit\|none\|bill, visit\|none\|own, visit\|card\|bill, list\|card\|bill, photos\|deposit\|bill, list\|none\|bill, list\|full\|none |
| sitter | list\|card\|counter, list\|full\|none | list\|card\|bill, list\|card\|card |
| ski-instructor | list\|full\|none, list\|card\|counter | list\|card\|card, list\|full\|none |
| sleep-clinic | list\|none\|bill, list\|none\|counter, list\|full\|none, list\|card\|counter | list\|none\|own, list\|none\|bill |
| small-engine | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|deposit\|counter | list\|card\|bill, visit\|card\|bill, list\|card\|card, photos\|deposit\|bill |
| snow | list\|none\|counter, list\|full\|none, visit\|none\|counter, photos\|none\|counter | list\|card\|card, list\|none\|bill, list\|full\|none, photos\|full\|none |
| spa | list\|card\|counter, list\|deposit\|counter | list\|card\|bill, list\|full\|none, list\|deposit\|card |
| speech-therapist | list\|none\|counter, list\|card\|counter, list\|card\|card | list\|none\|own, list\|card\|card |
| sports-coach | list\|full\|none, list\|card\|counter | list\|card\|card, list\|full\|none |
| sports-medicine | list\|none\|counter, list\|card\|counter | list\|card\|card, list\|none\|bill, list\|none\|own |
| spray-tan | list\|card\|counter, list\|full\|none | list\|card\|bill, list\|full\|none, list\|deposit\|bill |
| surf-school | list\|full\|none, list\|card\|counter | list\|card\|card, list\|full\|none |
| surveyor | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|card\|card | list\|deposit\|bill, list\|none\|bill, list\|full\|none, photos\|deposit\|bill |
| swim | list\|full\|none | list\|full\|none |
| tailor | visit\|none\|counter, list\|none\|counter, visit\|none\|bill, list\|none\|bill | visit\|card\|bill, list\|card\|bill |
| tattoo | photos\|deposit\|counter, visit\|deposit\|counter, list\|deposit\|counter, list\|none\|counter, list\|none\|none | photos\|deposit\|bill, list\|deposit\|bill, visit\|deposit\|bill |
| tax | list\|none\|counter, list\|none\|bill, photos\|none\|counter, visit\|none\|counter | list\|none\|bill, list\|none\|own, photos\|none\|bill |
| teeth-whitening | list\|card\|counter, list\|full\|none | list\|card\|bill, list\|deposit\|bill, list\|full\|none |
| tennis-coach | list\|full\|none, list\|card\|card, list\|none\|counter | list\|full\|none, list\|card\|card |
| therapist | list\|card\|card, list\|card\|counter, list\|none\|counter | list\|card\|card, list\|none\|own |
| tires | list\|deposit\|counter, list\|none\|counter, list\|none\|bill, list\|deposit\|bill | list\|card\|bill, list\|deposit\|bill |
| tours | list\|full\|none, list\|deposit\|card, list\|none\|counter, list\|none\|bill | list\|deposit\|card, list\|full\|none, photos\|deposit\|card |
| towing | list\|none\|counter | list\|card\|card, list\|none\|own |
| trainer | list\|full\|none, list\|card\|card, list\|card\|counter | list\|card\|card, list\|full\|none |
| trampoline-park | list\|full\|none, list\|deposit\|counter, list\|none\|bill | list\|deposit\|card, list\|card\|bill, list\|full\|none |
| translator | photos\|full\|none, list\|card\|card | list\|card\|bill, list\|card\|card, list\|none\|bill |
| travel-agent | list\|full\|none, list\|card\|card, photos\|deposit\|counter, list\|none\|counter | list\|card\|card, photos\|deposit\|bill, list\|none\|bill, list\|full\|none |
| tree | list\|card\|counter, list\|none\|counter, list\|full\|none, list\|deposit\|counter, photos\|card\|counter, visit\|card\|counter | visit\|none\|bill, visit\|none\|own, list\|card\|bill, photos\|deposit\|bill, list\|full\|none |
| tutor | list\|card\|card, list\|card\|counter, list\|full\|none | list\|card\|card, list\|full\|none |
| tv-repair | visit\|deposit\|counter, list\|none\|counter | visit\|card\|card, list\|card\|card, visit\|none\|bill |
| upholstery | list\|none\|counter, visit\|none\|counter, list\|deposit\|counter | visit\|card\|bill, list\|card\|bill, photos\|deposit\|bill |
| urgent-care | list\|none\|counter | list\|none\|own, list\|none\|bill |
| urologist | list\|none\|counter, list\|card\|counter | list\|none\|own, list\|none\|bill |
| valet | list\|full\|none, list\|none\|none | list\|deposit\|card, list\|full\|none, visit\|card\|bill, list\|card\|card |
| vehicle-inspection | list\|none\|counter, list\|none\|bill | list\|card\|bill, visit\|card\|bill |
| vehicle-wrap | photos\|deposit\|counter, photos\|deposit\|bill, list\|none\|counter, list\|none\|bill | list\|card\|bill, visit\|card\|bill, photos\|deposit\|bill |
| vet | visit\|none\|counter, list\|none\|counter, list\|card\|counter, list\|deposit\|counter, list\|full\|none | visit\|card\|bill, list\|card\|bill, list\|full\|none |
| watch-jewelry | visit\|none\|counter, list\|none\|counter, list\|deposit\|counter, visit\|deposit\|counter | list\|card\|card, list\|card\|bill, visit\|card\|bill, photos\|deposit\|bill |
| weight-loss | list\|none\|counter, list\|card\|counter | list\|none\|bill, list\|none\|own |
| well-pump | list\|card\|counter, list\|none\|counter, list\|deposit\|counter, list\|full\|none, photos\|card\|counter, visit\|card\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, visit\|card\|bill, photos\|deposit\|bill, list\|full\|none |
| wellness-studio | list\|full\|none, list\|card\|counter | list\|deposit\|card, list\|deposit\|bill |
| wildlife | list\|none\|counter, list\|card\|counter, list\|full\|none, photos\|none\|counter, visit\|none\|counter | list\|card\|card, list\|none\|bill, photos\|deposit\|card, visit\|card\|card |
| window-tint | list\|none\|counter, list\|none\|bill, list\|deposit\|counter, list\|deposit\|bill | list\|card\|bill, visit\|card\|bill, list\|deposit\|bill |
| windows | list\|none\|counter, photos\|none\|counter, visit\|none\|counter | list\|card\|bill, list\|none\|bill, list\|card\|card, list\|full\|none, photos\|deposit\|bill, visit\|card\|bill |
| yoga | list\|full\|none, list\|card\|counter, list\|none\|counter, list\|card\|card, list\|deposit\|counter, photos\|card\|counter, visit\|card\|counter | list\|card\|card, list\|card\|bill, list\|full\|none, list\|deposit\|bill, photos\|deposit\|bill, visit\|card\|bill |

## 4. Catalog rows by fact or switch

| fact or switch | catalog rows |
|---|---|
| fact plans | P02 Memberships and repeat plans |
| fact packs | P01 Packs; P02 Memberships and repeat plans; P03 Intro offers |
| fact groups | K08 Groups |
| fact classes | K01 Class timetable; K02 Seats, minimum, cutoff; K03 Trial seats |
| fact firststeps | Q01 Forms and first steps |
| fact forms | Q01 Forms and first steps |
| fact sentnow | T12 On call for jobs sent now; V10 Extras: after-hours price, materials, tax |
| fact results | Q08 Results and aftercare links |
| fact planbill | V18 Insurance plan billed |
| fact dropoff | K07 Items per day (drop-off) |
| fact multiday | K06 Stays |
| fact spaces | K04 Places and things |
| fact children | Q05 Children, people in care, animals |
| fact incare | Q05 Children, people in care, animals |
| fact animals | Q05 Children, people in care, animals |
| fact video | L01 Places a service happens (incl. video / phone); L06 Video link or 'pro calls' per person |
| fact aftercare | Q08 Results and aftercare links |
| fact photos | Q07 Photos shown with the customer's yes |
| fact documents | Q02 Documents to sign |
| fact waitlist | V14 Waitlist |
| fact tips | V11 Tip line |
| fact discounts | V13 Discount codes |
| fact stages | V16 Stage payments |
| fact monthlybill | V17 One bill for many visits |
| fact banktransfer | V12 Bank transfer over an amount |
| fact extrawork | V19 Extra work priced at the visit |
| fact nomoney | M02 No money through Rosie |
| fact capacitycheck | K09 Capacity check-in |
| switch sensitive | Q06 Sensitive work; B02 Plain display name |
| switch welfare | Q09 Welfare check |
| switch cancelright | V20 Cancel period for signed work |
| switch nomoney | M02 No money through Rosie |

## 5. Problems and gaps found by the script

**Files skipped (could not be read as a profession): 0**

- none

**Expected in work/phase4/waves.json but no work/prof file yet: 0**

- none

**Checks against the master: 0**

- none

## 6. Places and things (K04) without the `spaces` fact

K04 is switched on by the fact `spaces`. It is also switched on for work whose bookings attach to a specific item even without that fact. The script decides in two ways. **Named**: these item-based businesses are listed by name in the script (realtor, property-manager, limo, fishing-charter, hunting-guide, rentals, escape-room, axe-throwing, mini-golf, trampoline-park, boarding, recording-studio). **Found**: the profession is not named, lists no `spaces` fact, is not a drop-off, and its `pf.services` has an inventory key (`stock`, `zones`, `trips`) or its `capacity` text says a vehicle, boat, kennel, suite, cabin, lane, court, property or unit is held per booking (the matching words are printed). A room, table or bay that only the business assigns (an exam room, a shop bay) does not count: the customer never picks it. A person can veto any row.

| id | type | why K04 is on |
|---|---|---|
| airport-shuttle | service | found: capacity says "one vehicle" |
| hunting-guide | table | an item-based business (FRONTEND-SPEC section 2b) |
| limo | event | an item-based business (FRONTEND-SPEC section 2b) |
| medical-transport | service | found: capacity says "One vehicle" |
| property-manager | consult | an item-based business (FRONTEND-SPEC section 2b) |
| realtor | consult | an item-based business (FRONTEND-SPEC section 2b) |
| rentals | event | an item-based business (FRONTEND-SPEC section 2b) |

K04 on in total: **28** professions (21 by the fact `spaces`, 5 named, 2 found).

Named but no file yet: none.

## 7. Key spellings in the profession files (for the forms)

The forms in `forms/<id>.json` use one name per key. The table `KEYS` in `work/phase4/tools/frontend-map.js` maps the spellings (for example `checkIn`, `check_in`, `check-in` all become `check_in`; `oks`, `who_oks`, `who OKs what` become `who_oks`). Case, spaces, `_` and `-` are ignored when matching. Only these blocks are read: pf.questions, pf.safety, pf.first_steps, pf.staff, pf.license, pf.messages, pf.visit (and `pf.rules.minors`). **Keys the table does not know** are not copied into the form; the form names them under `unmapped_keys`, and they are listed here with how many files use each. Add a row to `KEYS` to map one. (A key name that holds one of the three banned words of the spec is shown with stars here.)

**pf.questions**: 20 unknown keys, 56 uses. Known canonical names: before_times, after_time, secure_page_only, who_may_book, never_asked, who_may_bring.

studio (17); told (10); flags (5); showroom (5); shop (4); gallery (1); heads_up (1); limit_check (1); new_family (1); paint_check (1); perPerson (1); planning (1); publicPrograms (1); repair_or_replace (1); rulesOut (1); saved for next time (1); screening (1); size_check (1); storage (1); yard (1)

**pf.safety**: 128 unknown keys, 253 uses. Known canonical names: stop, go_on, always, what_rosie_says, stop_action, business_line, who_is_told, nurse_line.

mobile_stops (11); weather (10); dont_drive_action (9); dont_drive_words (9); legal questions (9); refuse (9); at the counter (7); children (7); on the night (7); during_work (6); never said (6); never (5); never answered (5); at the visit (4); crisis words after booking (4); fasting (4); medical questions (4); owner (4); the AI never counsels (4); advice (3); forms (3); house_calls (3); inClass (3); sobriety (3); turnAway (3); B (2); clean tools (2); crisisRule (2); legal, money or health questions (2); money questions (2); on_the_job (2); staff stops (2); tax questions (2); Rosie's rule (1); a debt-relief push (1); a fix the customer declines (1); a move with no yes (1); a repair declined (1); after (1); after_the_job (1); aircraft (1); alcohol (1); asks for legal, tax or investment advice (1); asks for medical, legal or money advice (1); asks for therapy (1); asks for therapy or a diagnosis (1); at a home visit (1); at the shop (1); at the venue (1); at the workshop (1); at the yard (1); atTheCourse (1); atThePark (1); atTheVenue (1); atVisit (1); at_the_business (1); bite_risk (1); boarding (1); coachStops (1); contact (1); crisis (1); crisis words (1); crisisStorage (1); cryo (1); danger words (1); disclosure (1); dont_ride_action (1); dont_ride_words (1); dont_run_action (1); dont_run_words (1); driverHours (1); endTrip (1); fair housing, on every message (1); fitness (1); float (1); found at the visit (1); gear (1); general (1); grief and crisis (1); handling (1); headKnock (1); heat (1); heavy (1); home visits (1); inWater (1); infested (1); instructor (1); instructorStops (1); medicalDirector (1); medical_shoes (1); names (1); never stranded (1); neverWait (1); not danger (1); not_groomed_action (1); not_groomed_words (1); old_stuffing (1); onTheWater (1); onTour (1); person_danger (1); pests (1); pets (1); pharmacistLine (1); plan questions (1); pockets (1); pool (1); questions_on_treatments (1); range (1); rated_boots (1); re_entry (1); refuse_items (1); refused (1); rental (1); repeated until fixed (1); rule (1); seats (1); set answers to risky questions (1); show_safety (1); sick (1); soaked ground (1); staff safety (1); the agent's safety (1); visit_stops (1); wait_action (1); wait_words (1); what (1); while waiting (1); worse_before (1)

**pf.first_steps**: 104 unknown keys, 238 uses. Known canonical names: steps, prep, required, good_for, reaction, documents, agreement, away, plan.

before the main visit (27); before_quote (22); after_contract (20); studio_prep (16); at_check_in (10); after_agreement (7); forms (5); photos (5); showroom_prep (5); access (4); prep timing (4); after the first call (3); before the first visit (3); before_proposal (3); first_clean (3); meet_and_greet (3); sample_pickup (3); shop_prep (3); at the start of the visit (2); before_the_visit (2); estimate (2); none (2); on_file (2); standing_order (2); aeration_prep (1); after the intro call (1); after the quote (1); after_signing (1); atTheRestaurant (1); bed_bugs (1); before the first lesson (1); before_agreement (1); before_estimate (1); before_plan (1); biteHistory (1); boarding_notice (1); care_plan (1); closing (1); consents (1); customer_notice (1); deck (1); design_proof (1); desk (1); estimate_visit (1); estimator_look (1); everything else (1); family_page (1); first_cut (1); first_visit (1); floor_test (1); gallery (1); gate_check (1); green_pool (1); group_check (1); home_visit (1); hoof_check (1); inspection_first (1); installation (1); key_release (1); lead_pamphlet (1); lead_safe_pamphlet (1); local_limits (1); locate (1); need-by date (1); neighbor_notice (1); neighbors (1); new_pet_goodbye (1); none_needed (1); note (1); notice (1); ownerOK (1); owner_ok (1); papers (1); pet_profile (1); pharmacy_paper (1); planning_prep (1); power_lines (1); pre_surgery_exam (1); prep for a yard pick-up (1); prep for the on-the-way text (1); radon (1); records (1); result_changes (1); ride_details (1); rope_work (1); rug_at_the_plant (1); rug_dye_test (1); school_pick_up (1); s****d_pool (1); shop (1); shop prep (1); size_check (1); spending_limit (1); stakes (1); storage_prep (1); storm_alert (1); stretcher (1); studio prep (1); timing (1); vaccines (1); video (1); wedding (1); wildlife (1); yard_prep (1)

**pf.staff**: 66 unknown keys, 157 uses. Known canonical names: skills, licenses, supervision, who_oks, stand_in, roles, away, ratio, crews, on_call.

lead_safe (18); new_person_ok (15); checks (11); levels (7); special work (7); who does what (the example) (6); after hours (5); assistants (5); gender (5); chaperone (4); away from the studio (3); homeVisits (3); never (3); alone (2); background (2); crisis (2); driving (2); dutyLimits (2); fairness (2); keys (2); people (2); sales (2); training (2); twoPeople (2); witnesses (2); backup (1); booth (1); byName (1); callBack (1); care_manager (1); children (1); claims (1); cleared_only (1); closing (1); coach (1); data (1); desk (1); digging (1); drone (1); fair lending (1); gas and oil (1); healthRead (1); heights (1); horses (1); hours (1); lifeguard (1); lifting (1); line_clearance (1); named (1); noReferral (1); nurse (1); outside (1); overnight (1); power_lines (1); refrigerant card (1); safety_questions (1); same_caregiver (1); subcontractors (1); the desk (1); titles and licenses (1); trucks (1); twoAdults (1); two_people (1); walkInOnly (1); weather_call (1); who_may_go (1)

**pf.license**: 178 unknown keys, 467 uses. Known canonical names: need, who, ask, how_checked, blocks, insurance, background, renewals, away, agreement.

not_this_work (25); otherwise (25); video (25); claims (20); lead_safe (17); scope (17); certificates (13); design_studio (12); bloodWork (9); never claimed (9); local rules (8); training (8); at the studio (7); at the counter (6); remote (6); telehealth (6); booth (5); music rights (5); shown_to_customers (5); showroom (5); staff (5); acupuncture (4); business (4); cosmetic (4); every_state (4); job placement (4); lactation (4); limits (4); manager on site (4); own word (4); parks (4); per event (4); person (4); sedation (4); vaccines (4); xray (4); asbestos (3); declared_emergency (3); example (3); federal (3); job limits (3); ages (2); associates (2); away from the studio (2); building_work (2); certifications (2); drone (2); holds (2); lead-safe work (2); makeup (2); second kind of work (2); shop (2); show (2); shown (2); shown to customers (2); skinCare (2); titles (2); unlicensed staff (2); a kitchen of its own (1); accreditation (1); agency_rules (1); aircraft (1); alcohol (1); apprentices (1); artist (1); artistAge (1); at the shop (1); at the store (1); at the workshop (1); at the yard (1); athleticTraining (1); boarding (1); bond (1); bridal hair (1); care_planning_office (1); cars (1); categories (1); certification (1); checks for coaches who teach children (1); classroom (1); coach (1); coachCertificate (1); color_shop (1); controlled (1); controlled_drugs (1); covers (1); credentials (1); desk (1); diabetesEducation (1); directAccess (1); drivers (1); drone work (1); dryNeedling (1); drywall (1); each person (1); electrical work (1); event lighting (1); eventPermit (1); example numbers (1); express_company (1); eyewear (1); familyTherapy (1); feeding (1); fire_alarm (1); glitter tattoos (1); hearing (1); herbs (1); home kitchen (cottage food) (1); inflatables and rides (1); inspections (1); job size limit (1); job_size_line (1); jobs at one address (1); lashBrow (1); lashes (1); license switch (1); lockouts (1); maintenance staff (1); mobile (1); mobile wall (1); mobileStudio (1); mold size (1); moss_and_algae (1); motorcycle (1); national (1); never_offered (1); noLicense (1); no_license (1); older_homes (1); one company can't do both (1); otc (1); other credentials (1); piercing (1); place (1); plaster (1); power_wiring (1); prescription (1); private certificates (1); rabies_and_training (1); rank (1); registry (1); renter (1); repair_work (1); roomRenter (1); rooms (1); security (1); services (1); showNumber (1); shuttle_company (1); signing the papers (1); small_repairs (1); speaking for a client (1); state switch (1); status (1); status_any_day (1); storage (1); studio (1); substanceUse (1); switches (1); teachers (1); tests (1); texture_shop (1); the age to marry (1); the yard (1); threading (1); trade work (1); trade_certificates (1); travel (1); trust (1); trust claims (1); unregistered staff (1); vehicles (1); water_district (1); what the business is (1); what the business is (a switch set at sign-up) (1); who may prepare and sign (1); who may sign a return (1); wood_yard (1)

**pf.messages**: 103 unknown keys, 219 uses. Known canonical names: languages, minors, never_in_text, photos, staff_texts, medical.

results (14); decider (13); no nudges (13); danger words (10); safe to text (10); to (7); tone (7); channels (5); healthQuestions (5); who_gets_texts (5); displayName (4); documents (4); texts_carry (4); urgent (4); card or photo texted by mistake (3); noAdvice (3); no_claim_ads (3); others asking (3); safeContact (3); texts say (3); waitlist (3); a conflict (2); a payer pays (2); case notes (2); client notes (2); danger_words (2); fair housing (2); noRatings (2); notes (2); records (2); sales (2); selling (2); CRD numbers (1); a company pays (1); a document by text (1); a host pays (1); adult (1); after_stop (1); agent (1); allowed (1); arrival updates (1); banned words (1); booked_for_someone_else (1); call_list (1); card or document texted by mistake (1); card or passport texted by mistake (1); chemical_questions (1); classNames (1); client_texts (1); contact (1); deleteAfter (1); donation receipts (1); duringCamp (1); emergency_contact (1); employer (1); facts, never pressure (1); goodbye (1); grief comes first (1); guests (1); hands-free (1); healthTexts (1); homework (1); identity theft (1); if_sent_anyway (1); investment questions (1); largePrint (1); license numbers (1); loan notes (1); names (1); neutral (1); never_asked_or_kept (1); notice (1); older_adult (1); on-the-way text (1); others (1); outside (1); phone_in_shop (1); pickUp (1); plan questions (1); private (1); rate questions (1); rating (1); ratings (1); recipients (1); registry IDs (1); reports (1); required statement (1); school (1); secure_page (1); sensitive (1); show (1); staffReasons (1); status words (1); storm_day (1); sympathy (1); symptoms (1); texts_say (1); to the owner and staff too (1); voicemail (1); wait (1); where they go (1); who Rosie texts (1); work notes (1)

**pf.visit**: 349 unknown keys, 954 uses. Known canonical names: check_in, done, changes, before_work, away.

at_the_visit (29); before_photos (25); lateEntry (23); outside_checks (22); ready (20); check-in at the customer's place (19); children (18); intake (18); estimate (17); pick_up (17); status_words (17); studio_done (16); childLeft (14); entry_codes (12); results (12); at the visit (11); check-in at the studio (11); late_drop_off (11); stops (10); unclaimed (10); weather (10); aftercare (9); diagnosis (9); drop_off (9); notes (9); quotes at the visit (9); setup (9); work sold at the home (9); late (8); report (8); at check-in (7); check-in at the counter (7); check-in at the venue (7); dropOff (7); note (7); walk_through (7); allergies (6); breakage (6); cantGoAhead (6); home (6); lockout (6); updates (6); work changes at the event (6); delivery and setup (5); food safety on the day (5); items_to_the_shop (5); part_test (5); permits (5); props (5); rejected (5); report_release (5); showroom_done (5); stop (5); viewing (5); what_is_checked (5); work changes on the night (5); alcohol (4); carePlan (4); check-in at the kitchen (4); during (4); leaveEarly (4); pick_up_and_delivery (4); recall_check (4); record (4); sessions end on time (4); the_work (4); A (3); B (3); Rosie never (3); after (3); claims (3); findings (3); house_call (3); incident (3); missed (3); missing (3); outside help (3); required_items (3); results later (3); the schedule (3); a_hazard_found (2); after the call (2); bad_weather (2); before photos (2); calibration (2); check-in at the shop (2); dilation (2); drop-off (2); drying (2); found_items (2); grace (2); handover (2); install_day (2); items (2); ladders (2); late_pick_up (2); leftEarly (2); multiday (2); music rules (2); nobody_answers (2); not_examined (2); not_tested (2); old parts (2); older_homes (2); orders (2); originals (2); pickup (2); records (2); shop_done (2); test (2); wait_at_pickup (2); wind_on_the_day (2); work_sold_at_the_home (2); B check-in (1); a conflict found at the consult (1); a conflict found at the meeting (1); a conflict or a safety concern found (1); a fix declined (1); a hazard (1); a hazard found (1); a signing (1); after the consult (1); after the cremation (1); after the first meeting (1); after the meeting (1); after the session (1); after the tour (1); after_spray (1); an extra drying day (1); arrive (1); at the counter (1); at the shop (1); at the store (1); atTheTable (1); at_the_survey (1); bags (1); bar (1); before appraising (1); before each child (1); before each face (1); before loading (1); before measuring (1); before notarizing (1); before setup (1); before the cremation (1); before the hunt (1); before the work (1); before_loading (1); before_record (1); berm (1); bit rules (1); boarding (1); cake stand (1); cars (1); certificate wording (1); changes at the lesson (1); changes on the day (1); check-in at a home visit (1); check-in at the customer's home (1); check-in at the practice (1); check-in at the store (1); check-in at the workshop (1); check-in at the yard (1); chemicals (1); choice (1); choices (1); closing (1); coat_check (1); cold_mornings (1); color_disputes (1); contacts (1); counter (1); daily_log (1); delivery (1); design rules (1); desk (1); documents (1); door rule (1); drive_away (1); drone (1); dropoff (1); during the tour (1); during the visit (1); earCheck (1); early_pick_up (1); endEarly (1); equipment (1); equipment record (1); fabric (1); filing (1); firm_price (1); fitting (1); flight_tracking (1); followUp (1); followUps (1); food safety (1); found_during_surgery (1); gallery_done (1); gate (1); gate_and_dog (1); goodbye (1); groceries (1); handBack (1); hand_back (1); handler (1); hazard found (1); health_note (1); home meetings (1); homework (1); hours (1); how (1); how_it_is_done (1); how_it_works (1); id (1); inTurns (1); incidents (1); inside (1); install (1); inventory (1); items added at the home (1); items_back (1); keys (1); lead_safe (1); line (1); lostItems (1); maker's cover (1); matted_coat (1); minors (1); moisture (1); needles (1); never_alone (1); no valid ID (1); no_access (1); no_photos (1); nobody home (1); nobody there for a delivery (1); notCheckedIn (1); not_found (1); on_the_job_day (1); order (1); orthotics (1); other_pests_found (1); outside coaching (1); outside the license (1); outside_visits (1); over_weight (1); ownDoctor (1); ownerPresent (1); paint_disputes (1); parent (1); parents (1); parts (1); parts on order (1); passcode (1); phones (1); photoId (1); photos (1); pickUp (1); pick_up_changes (1); plants_and_pets (1); prescriptions (1); price list first (1); price_at_visit (1); proof rule (1); ratios (1); re_entry (1); ready_to_start (1); recheck (1); recording (1); redo (1); release (1); rentals (1); repair or replace (1); repairs (1); reports (1); reset (1); result (1); return_ride (1); review and sign (1); ride_report (1); right to cancel (1); roof (1); rug_to_the_plant (1); safeStorage (1); safety test (1); same_caregiver (1); second_fitting (1); shop (1); shop done (1); show rules (1); shy (1); signing away from the office (1); sound hire (1); springs (1); staff_off (1); stopped by weather partway (1); storm_call (1); studio done (1); supplement (1); surgery_not_safe (1); tasks (1); teardown (1); the ceremony (1); the client lives in another state (1); the customer lives in another state (1); the firm price (1); the first call (1); the home is in another state (1); the journal (1); the kitchen check (1); the record (1); the service date (1); the statement (1); the work (1); translation (1); trialNote (1); truck access (1); twoAdults (1); vendors (1); vet_plan (1); video (1); visit_report (1); wait (1); waiting (1); waitlist (1); walkIns (1); walk_report (1); warehouse_done (1); water (1); water_and_drains (1); water_power (1); weighing (1); wet_roof (1); what a Level 1 covers (1); what_a_visit_covers (1); where it went (1); who decides (1); wind (1); won't-take items found on site (1); work (1); work changes at setup (1); work changes at the dinner (1); work changes on the day (1); work_day (1); work_days (1); worse_than_booked (1); wrong_glass (1); yard_done (1); yard_report (1)

Forms written: **243** (one per profession file) in `forms/`.

**Gaps in the forms** (a part the profession file has under a key the table does not know, or not at all; the form leaves it empty):

| gap | professions | which |
|---|---|---|
| suggested rows with no service name (the amounts rows give none) | 0 | - |
| a list-price row with no price, deposit or paid amount | 0 | - |
| no safety words found (stop, go on, always) | 1 | florist |
| no intake questions found (before the times, after the time) | 0 | - |
| no staff skills or roles found | 1 | biohazard |


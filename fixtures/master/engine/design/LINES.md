# The general flow: every line (Oct 21, 2026)

This is the list Jay and Claude built from all 1,194 nodes of the plumber and general flowcharts, the 75-item
edge-case checklist (PROGRAM.md section 8) and a first read of every profession's old flowchart.
Each line is one sub-section of the general flow (the rulebook Rosie's AI agent runs on).

Tags
- Fixed: same = the same for every business
- Fixed: pay = written once for each way of paying (before or after the visit)
- Fixed: visit = written once for each place (at the business, or at the customer's place)
- Fixed: profession = the step is the same; each profession fills in its own list in its plug-in
- State rules = the one exception: comes from the profession's state forms, never written into the general flow
- NEW = already drawn in the flowcharts, had no line before
- NEW, not drawn yet = no plumber or general flowchart draws it yet

## 1. Business onboarding
1.1 Start · Fixed: same
1.2 Business details · Fixed: same
1.3 ID check · Fixed: same
1.4 Services and prices · Fixed: visit, profession
1.5 Where and when paid · Fixed: pay, visit, profession
1.6 Price OKs · Fixed: pay, profession
1.7 Booking rules · Fixed: visit, profession
1.8 After hours and voice AI · Fixed: same
1.9 Business license · Fixed: profession · State rules
1.10 Calendar and jobs already booked · Fixed: same
1.11 Stripe · Fixed: same
1.12 Rosie's price and bill card · Fixed: same
1.13 Terms and Go live · Fixed: same
1.14 Another kind of work · Fixed: same
1.15 A second business · Fixed: same
1.16 Sign-up left unfinished, picked up later · Fixed: same · NEW
1.17 Work Rosie doesn't know yet · Fixed: profession · NEW
1.18 Rules for each kind of work (the plug-in) · Fixed: profession · State rules · NEW

## 2. Team onboarding
2.1 Add people · Fixed: same
2.2 Invite (yes, no reply, STOP) · Fixed: same
2.3 Profile and calendar · Fixed: same
2.4 License check · Fixed: profession · State rules
2.5 Skills and who OKs what · Fixed: profession
2.6 Prices per person · Fixed: same
2.7 Someone with their own business · Fixed: same
2.8 Team page · Fixed: visit
2.9 Owner's yes to start taking bookings · Fixed: same · NEW

## 3. Customer reaches out
3.1 AI chat · Fixed: same
3.2 Phone call · Fixed: same
3.3 Voicemail and callback · Fixed: same
3.4 Google's AI · Fixed: same
3.5 Booking page · Fixed: same
3.6 Spanish or another language · Fixed: same
3.7 Relay call · Fixed: same
3.8 Wrong number, sales call or robocall · Fixed: same
3.9 Danger check · Fixed: profession
3.10 Business books it itself (owner, staff or desk) · Fixed: same · NEW
3.11 Asks for a person · Fixed: same · NEW
3.12 Asks not to be recorded · Fixed: same · NEW
3.13 Call summary to the owner · Fixed: same · NEW
3.14 Walk-ins and a live wait line · Fixed: visit, profession · NEW, not drawn yet
3.15 Customer's AI has limits, or pays for them · Fixed: pay · NEW, not drawn yet

## 4. Booking
4.1 List price or quote from photos · Fixed: pay, profession
4.2 Open times and prices (times, windows or route days) · Fixed: pay, visit, profession
4.3 Picks a time · Fixed: same
4.4 Asks for a named person (or a set gender) · Fixed: same
4.5 Next in line · Fixed: same
4.6 Time held (minutes, or days for a contract) · Fixed: same
4.7 Business's questions · Fixed: profession
4.8 Name and mobile (finds returning customers) · Fixed: same
4.9 Booking for someone else, or a pet · Fixed: same, profession
4.10 Age check (18+) and parent rules · Fixed: profession · State rules
4.11 Secure link (private details only there) · Fixed: pay, visit
4.12 Address and travel check (one place or two) · Fixed: visit, profession
4.13 Who pays (owner, renter, landlord, parent) · Fixed: visit, profession
4.14 First steps (patch test, consult or estimate visit, form, waiver, permit) · Fixed: profession · State rules
4.15 Customer leaves without booking · Fixed: same · NEW
4.16 Nobody can help (no one free or nearby) · Fixed: same · NEW
4.17 Rush or urgent job · Fixed: profession · NEW
4.18 Repeat visits (a plan) · Fixed: pay, profession · NEW, not drawn yet (today only asked, answered with a reminder)
4.19 A series of visits for one job · Fixed: profession · NEW, not drawn yet
4.20 Group or party booking · Fixed: pay, profession · NEW, not drawn yet
4.21 Class spots and seats · Fixed: profession · NEW, not drawn yet
4.22 Several services in one booking · Fixed: same · NEW, not drawn yet
4.23 Needs a room, equipment or a crew · Fixed: profession · NEW, not drawn yet
4.24 Video or phone session · Fixed: visit · State rules · NEW, not drawn yet
4.25 Insurance or health plan check · Fixed: pay, profession · NEW, not drawn yet
4.26 Not our kind of job (points elsewhere) · Fixed: profession · NEW, not drawn yet
4.27 Access details and building rules (gate code, parking, pets, HOA) · Fixed: visit, profession · NEW, not drawn yet
4.28 Access needs (wheelchair, blind, caregiver) · Fixed: same · NEW, not drawn yet
4.29 Stock or items held for the booking · Fixed: profession · NEW, not drawn yet

## 5. Money before
5.1 Nothing taken · Fixed: pay
5.2 Card saved · Fixed: pay, visit
5.3 Hold · Fixed: pay, visit, profession
5.4 Deposit · Fixed: pay, profession · State rules
5.5 Full price · Fixed: pay
5.6 Not done in time · Fixed: same
5.7 Card fails at booking · Fixed: pay · NEW
5.8 Packages, memberships, gift cards, discounts · Fixed: pay, profession · NEW, not drawn yet

## 6. Booked
6.1 Owner's OK (or an expert reads private answers) · Fixed: pay, profession
6.2 Still-free check · Fixed: same
6.3 Confirmation and check-in code · Fixed: pay, visit
6.4 Staff told · Fixed: same

## 7. Before the visit
7.1 Reminder · Fixed: pay, visit
7.2 Customer moves it · Fixed: same
7.3 Customer cancels (refund or fee) · Fixed: pay, profession · State rules
7.4 STOP or CANCEL (any time) · Fixed: same
7.5 Customer asks a question · Fixed: same
7.6 Problem gets worse · Fixed: profession
7.7 Staff running late · Fixed: same
7.8 Staff can't come (sick, stuck, off) · Fixed: same
7.9 Business closes that day · Fixed: same
7.10 Rest of payment due · Fixed: pay, profession
7.11 Customer running late · Fixed: same · NEW
7.12 Business moves or cancels a booking · Fixed: pay · NEW
7.13 Required notices before the work (cancel notice, lead-safe, written estimate) · Fixed: visit, profession · State rules · NEW
7.14 Customer changes what's booked · Fixed: pay, profession · NEW, not drawn yet
7.15 Skip, pause or end a plan · Fixed: pay · NEW, not drawn yet
7.16 First steps or papers not done in time · Fixed: profession · NEW, not drawn yet
7.17 A part or order is late · Fixed: profession · NEW, not drawn yet
7.18 One job can't go ahead (weather, room, equipment) · Fixed: profession · NEW, not drawn yet

## 8. The visit
8.1 Staff's day · Fixed: visit
8.2 On my way · Fixed: visit
8.3 Check-in code · Fixed: visit
8.4 Not the worker who was sent · Fixed: visit
8.5 Nobody home or no-show · Fixed: pay, visit, profession
8.6 Unsafe · Fixed: visit
8.7 Quote or proposal (yes now, or later) · Fixed: pay, profession
8.8 Extra work · Fixed: pay, visit, profession · State rules
8.9 Price OK · Fixed: pay, profession
8.10 Bigger job found (its own quote) · Fixed: profession
8.11 Running late for the next job · Fixed: visit
8.12 The work gets done · Fixed: same · NEW
8.13 Visit never marked (next-morning question) · Fixed: same · NEW
8.14 Nobody needs to be home (entry codes, photo proof) · Fixed: visit, profession · NEW
8.15 What to bring (ID, papers, gear) · Fixed: profession · NEW, not drawn yet
8.16 Drop-off and pick-up, or mail-in · Fixed: visit · NEW, not drawn yet
8.17 Delivery and setup, signed for · Fixed: visit · NEW, not drawn yet
8.18 Job or stay over several days · Fixed: pay, profession · NEW, not drawn yet
8.19 Visit stopped or done differently · Fixed: pay · NEW, not drawn yet
8.20 Someone hurt, sick or lost during the visit · Fixed: profession · NEW, not drawn yet
8.21 Damage to the customer's things · Fixed: pay · NEW, not drawn yet
8.22 Walk-through and fixes before paying · Fixed: profession · NEW, not drawn yet
8.23 Child handed only to an approved adult · Fixed: profession · NEW, not drawn yet

## 9. Money after
9.1 DONE · Fixed: pay, visit
9.2 Pay link · Fixed: pay, visit
9.3 Saved card charged · Fixed: pay, visit
9.4 Rosfield's bill · Fixed: pay, visit
9.5 Cash, check or own way · Fixed: pay, visit
9.6 Landlord pays · Fixed: pay, visit, profession
9.7 Card declined or replaced · Fixed: pay
9.8 Still unpaid · Fixed: pay
9.9 Tip · Fixed: pay, profession
9.10 Rosfield's $2 · Fixed: pay
9.11 Payments in stages · Fixed: pay, profession · NEW, not drawn yet
9.12 One bill for many visits · Fixed: pay · NEW, not drawn yet
9.13 Materials or goods billed after · Fixed: pay, profession · NEW, not drawn yet
9.14 Pay over time (financing) · Fixed: pay · NEW, not drawn yet
9.15 Insurance billed, customer pays their share · Fixed: pay, profession · NEW, not drawn yet

## 10. After the visit
10.1 Receipt and warranty · Fixed: pay, profession
10.2 Rating · Fixed: same
10.3 Right to cancel (contract or extra work) · Fixed: visit · State rules
10.4 Warranty claim · Fixed: profession
10.5 Refund request · Fixed: pay
10.6 Complaint · Fixed: same
10.7 Bank dispute · Fixed: pay
10.8 Customer texts again later · Fixed: same
10.9 Customer's records (copy or delete) · Fixed: same
10.10 Next visit booked at checkout · Fixed: same · NEW, not drawn yet
10.11 Work, report or results ready later · Fixed: profession · NEW, not drawn yet
10.12 Item not picked up (storage fee, written notice) · Fixed: profession · State rules · NEW, not drawn yet
10.13 Rented items returned and checked · Fixed: pay · NEW, not drawn yet
10.14 Aftercare notes and reactions · Fixed: profession · NEW, not drawn yet

## 11. Running the business
11.1 Owner's day (AGENDA) · Fixed: same
11.2 Night requests · Fixed: profession
11.3 Approvals by text · Fixed: same
11.4 Fees (no-show, late cancel) · Fixed: pay
11.5 Block time · Fixed: same
11.6 Pause and resume · Fixed: same
11.7 Not by text or unclear (HELP, AGENT) · Fixed: same
11.8 End-of-day summary · Fixed: same
11.9 Staff time off · Fixed: same
11.10 Portal changes (prices, hours, rules, payments) · Fixed: same
11.11 Team changes (joins, leaves) · Fixed: same
11.12 New kind of work · Fixed: same
11.13 Second location or new state · Fixed: visit · State rules
11.14 License and insurance renewals · Fixed: profession · State rules
11.15 Customer list export · Fixed: same
11.16 Money page and payouts · Fixed: pay
11.17 Rosfield's monthly bill (card fails, unpaid) · Fixed: pay
11.18 Leaving Rosie · Fixed: same
11.19 Portal sign-in and Today page · Fixed: same · NEW
11.20 Preview what AI assistants see · Fixed: same · NEW
11.21 Owner or staff calls in by voice · Fixed: same · NEW
11.22 Owner calls the customer · Fixed: same · NEW
11.23 Owner away or not answering · Fixed: same · NEW
11.24 Block a customer or address · Fixed: same · NEW
11.25 Rosie's team reviews a flag · Fixed: same · NEW

## 12. When something breaks
12.1 Rosie goes down · Fixed: same
12.2 Texting goes down · Fixed: same
12.3 Calendar link drops · Fixed: same
12.4 Two customers want the same time · Fixed: same
12.5 AI assistant goes quiet · Fixed: same
12.6 Wrong details from the AI · Fixed: same
12.7 Declared emergency (price limits) · Fixed: profession · State rules
12.8 Card payments (Stripe) go down · Fixed: pay · NEW
12.9 State license lookup is down · Fixed: same · NEW
12.10 Fake bookings, stolen cards, double charges · Fixed: same · NEW, not drawn yet

## 13. Rules every step follows (rules, not steps) · NEW
13.1 AI and recording notice on calls · Fixed: same · State rules
13.2 Text hours and consent to texts · Fixed: same
13.3 Time zones and clock changes · Fixed: same
13.4 No expert advice from the AI (legal, tax, medical) · Fixed: profession
13.5 Private details only on the secure page · Fixed: same
13.6 Bookings keep the terms they were made with · Fixed: same
13.7 Fair ranking: nobody pays to rank higher · Fixed: same
13.8 Records kept by law (7 years, plus trade rules) · Fixed: same · State rules

Left out on purpose (not bookings, not at launch): delivery and takeout orders; selling goods with no visit.

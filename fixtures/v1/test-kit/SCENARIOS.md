# Test scenarios with expected results

Generated Sat Nov 07 2026 02:15. Run each on the demo shop named; the expected results come from the master's money home (S13-55) and the decisions D91-D99.

## How to run a test

1. Register the demo shop (shops/<id>.json): Google prefill fields marked [G], then services with their money way, staff, hours, cutoff.
2. Book as the customer by text to Rosie's number, and once on the booking page.
3. Walk the steps below; compare every message and every charge with the expected result. A charge without the customer's yes, a service with no way to charge, or a fee above what was paid now is a FAIL.

## Per money combo (one test each; pick any shop the coverage map lists for it)

### A · `list|none|none` on aquarium (Basic water test)

- Price shown before the yes: free.
- At booking: nothing is taken and no card is saved; a YES books it.
- After the visit: nothing more is charged.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee none (free service). Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|none|counter` on acupuncturist (Follow-up treatment)

- Price shown before the yes: $35.
- At booking: nothing is taken and no card is saved; a YES books it.
- After: the customer pays the price at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|none|bill` on aba (Therapy session (2 hours))

- Price shown before the yes: $120.
- At booking: nothing is taken and no card is saved; a YES books it.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $50. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|card|counter` on acupuncturist (Follow-up treatment)

- Price shown before the yes: $35.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After: the customer pays the price at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|card|bill` on dog-trainer (Private lesson)

- Price shown before the yes: $120.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $60. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|card|card` on aba (Therapy session (2 hours))

- Price shown before the yes: $120.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: the saved card is charged the amount due, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $50. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|deposit|counter` on architect (Schematic design review)

- Price shown before the yes: $140.
- At booking: the deposit $40 is taken once the booking is written (on a request: once the owner says yes).
- After: the customer pays the rest $100 at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $40. The fee comes out of what was paid now ($40), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|deposit|bill` on escape-room (Team building)

- Price shown before the yes: $560.
- At booking: the deposit $280 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: Rosie texts one bill with a secure pay link for the rest $280.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $280. The fee comes out of what was paid now ($280), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|deposit|card` on baker (2-tier party cake (serves 30))

- Price shown before the yes: $140.
- At booking: the deposit $40 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: the saved card is charged the rest $100, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $40. The fee comes out of what was paid now ($40), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `list|full|none` on addiction (Court-ordered class series)

- Price shown before the yes: $250.
- At booking: the full price $250 is taken once the booking is written (on a request: once the owner says yes).
- After the visit: nothing more is charged.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $50. The fee comes out of what was paid now ($250), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|none|none` on architect (Design quote from photos, free)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: nothing is taken and no card is saved; a YES books it.
- After the visit: nothing more is charged.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee none (free service). Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|none|counter` on auto-body (Rear bumper repair)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: nothing is taken and no card is saved; a YES books it.
- After: the customer pays the price at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee free. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|none|bill` on auto-body (Rear bumper repair)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: nothing is taken and no card is saved; a YES books it.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee free. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|card|counter` on appliance (Vintage mixer restore)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After: the customer pays the price at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|card|bill` on test-mixed-A (Color and cut)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|card|card` on cpa (Personal tax return)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: the saved card is charged the amount due, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|deposit|counter` on auto-body (Rear bumper repair)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the deposit $400 is taken once the booking is written (on a request: once the owner says yes).
- After: the customer pays the rest $1,855 at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee free. The fee comes out of what was paid now ($400), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|deposit|bill` on architect (Design quoted from photos)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the deposit $20 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: Rosie texts one bill with a secure pay link for the rest $70.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. The fee comes out of what was paid now ($20), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|deposit|card` on baker (Custom cake)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the deposit $20 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: the saved card is charged the rest $70, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. The fee comes out of what was paid now ($20), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `photos|full|none` on face-painter (Custom design from a photo)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the full price $90 is taken once the booking is written (on a request: once the owner says yes).
- After the visit: nothing more is charged.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. The fee comes out of what was paid now ($90), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `visit|none|counter` on appliance (Stand mixer repair)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: nothing is taken and no card is saved; a YES books it.
- After: the customer pays the price at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `visit|none|bill` on auto-repair (Check-engine diagnosis and repair)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: nothing is taken and no card is saved; a YES books it.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $139. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `visit|card|counter` on appliance (Stand mixer repair)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After: the customer pays the price at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `visit|card|bill` on test-mixed-A (Color correction)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `visit|card|card` on test-mixed-A (Color correction)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: the saved card is charged the amount due, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `visit|deposit|counter` on esthetician (Corrective facial)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the deposit $25 is taken once the booking is written (on a request: once the owner says yes).
- After: the customer pays the rest  at the counter; Rosie only records it.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. The fee comes out of what was paid now ($25), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `visit|deposit|bill` on test-mixed-A (Color correction)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the deposit $25 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: Rosie texts one bill with a secure pay link for the rest .
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. The fee comes out of what was paid now ($25), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### A · `visit|deposit|card` on test-mixed-A (Color correction)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the deposit $25 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: the saved card is charged the rest , nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $20. The fee comes out of what was paid now ($25), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|none|none` on insurance (Free meeting)

- Price shown before the yes: free.
- At booking: nothing is taken and no card is saved; a YES books it.
- After the visit: nothing more is charged.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee none (free service). Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|none|bill` on aba (In-home therapy session (2 hours))

- Price shown before the yes: $120.
- At booking: nothing is taken and no card is saved; a YES books it.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $50. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|none|own` on aba (In-home therapy session (2 hours))

- Price shown before the yes: $120.
- At booking: nothing is taken and no card is saved; a YES books it.
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $50. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|card|bill` on acupuncturist (Home treatment)

- Price shown before the yes: $179.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|card|card` on aba (In-home therapy session (2 hours))

- Price shown before the yes: $120.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: the saved card is charged the amount due, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $50. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|card|own` on auto-glass (Windshield with calibration, in the driveway)

- Price shown before the yes: $588.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|deposit|bill` on chimney (Wood stove sweep)

- Price shown before the yes: $150.
- At booking: the deposit $40 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: Rosie texts one bill with a secure pay link for the rest $110.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $40. The fee comes out of what was paid now ($40), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|deposit|card` on architect (Design phase at home)

- Price shown before the yes: $150.
- At booking: the deposit $40 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: the saved card is charged the rest $110, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $40. The fee comes out of what was paid now ($40), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|deposit|own` on magician (Kids' birthday magic show)

- Price shown before the yes: $350.
- At booking: the deposit $100 is taken once the booking is written (on a request: once the owner says yes).
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $100. The fee comes out of what was paid now ($100), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `list|full|none` on airport-shuttle (Private ride)

- Price shown before the yes: $75.
- At booking: the full price $75 is taken once the booking is written (on a request: once the owner says yes).
- After the visit: nothing more is charged.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $30. The fee comes out of what was paid now ($75), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|none|none` on test-mixed-B (Water heater fix)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: nothing is taken and no card is saved; a YES books it.
- After the visit: nothing more is charged.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee none (free service). Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|none|bill` on auto-body (Hail dent repair)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: nothing is taken and no card is saved; a YES books it.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee none set. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|none|own` on test-mixed-B (Water heater replacement)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: nothing is taken and no card is saved; a YES books it.
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|card|bill` on carpet (Pet odor treatment, whole home)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|card|card` on airport-shuttle (Group van)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: the saved card is charged the amount due, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $30. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|card|own` on test-mixed-B (Water heater replacement)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|deposit|bill` on appliance (Built-in fridge install)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the deposit $160 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: Rosie texts one bill with a secure pay link for the rest $480.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. The fee comes out of what was paid now ($160), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|deposit|card` on baker (Custom tiered cake for 80)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the deposit $160 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: the saved card is charged the rest $480, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $160. The fee comes out of what was paid now ($160), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|deposit|own` on test-mixed-B (Water heater replacement)

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the deposit $160 is taken once the booking is written (on a request: once the owner says yes).
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. The fee comes out of what was paid now ($160), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `photos|full|none` on snow (Gravel lane season (600 ft))

- Customer sends photos first; the business quotes; nothing is booked or charged until the customer says yes to the quote in their own chat (S13-45).
- At booking: the full price $640 is taken once the booking is written (on a request: once the owner says yes).
- After the visit: nothing more is charged.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $30. The fee comes out of what was paid now ($640), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `visit|none|bill` on appliance (Fridge repair)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: nothing is taken and no card is saved; a YES books it.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `visit|none|own` on concrete (Driveway replacement)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: nothing is taken and no card is saved; a YES books it.
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid and no card is saved, so nothing can be charged.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `visit|card|bill` on appliance (Fridge repair)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: Rosie texts one bill with a secure pay link for the amount due.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `visit|card|card` on aquarium (Tank trouble visit)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After DONE: the saved card is charged the amount due, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $85. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `visit|card|own` on closets (Design and measure visit)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the card is saved, $0 is taken, nothing is held on the card.
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. Nothing was paid now, so the fee may go on the saved card ONLY with the owner's yes (S11-22); silence = no fee.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `visit|deposit|bill` on appliance (Fridge repair)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the deposit $89 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: Rosie texts one bill with a secure pay link for the rest $156.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. The fee comes out of what was paid now ($89), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `visit|deposit|card` on medspa (Botox at home)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the deposit $89 is taken once the booking is written (on a request: once the owner says yes).
- After DONE: the saved card is charged the rest $156, nothing more; any new or higher amount needs the customer's own yes first.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. The fee comes out of what was paid now ($89), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

### B · `visit|deposit|own` on test-mixed-B (Leak repair)

- Price is set at the visit: before any work, the amount needs the customer's own yes (S13-45); no yes, no charge.
- At booking: the deposit $89 is taken once the booking is written (on a request: once the owner says yes).
- After: the business bills its own way; Rosfield charges nothing after.
- Cancel before the cutoff: everything paid now goes back; no fee.
- Late cancel or no-show: fee $89. The fee comes out of what was paid now ($89), never more; the rest goes back.
- Rosfield's $2: paid by the business, never added to the customer's price; counted at the first check-in code (or DONE with no code); no visit, no $2; never more than $49 a month per person (S1-25, D97).

## Cross-cutting cases

- **Mixed booking** (test-mixed-A): add a card-saved, a deposit and a paid-in-full service in one booking. Expect: one payment for everything due now; one fee per booking (the largest); never more than paid now.
- **Added service after booking** (D91): the customer adds a service by text. Expect: nothing is taken before the visit; the add-on is paid at the visit.
- **Request booking** (owner OK needed): expect the card saved, nothing charged until the owner's yes; a failed charge after the OK gets one pay link, due by the request's latest answer time; unpaid = not booked.
- **Someone else pays**: the person booking pays what's due now; the payer gets a pay link only for the rest, at DONE or on the bill.
- **Phone-only caller**: card by keypad only; a caller reading a card number aloud is stopped and those words are cut.
- **Silence**: the owner never answers a no-show question. Expect: no fee.
- **Pack / membership**: a credit covers its own service only; a membership bought through Rosie carries the 1% (D97).
- **Sensitive work** (any shop with switch sensitive): every text carries only the business name, date, time, address and a secure link; no service name, reason or detail.
- **Children** (fact children): a parent or guardian books; the child's details stay on the secure page.
- **Change where updates go** (D75): in their own chat the customer gives a new phone or email; a code goes there; typed back, every update goes there; nothing goes to the old number again; old links stop working.
- **Lost phone** (D100): from a new number the customer asks to move updates; a code goes to the email on file; typed back in the new chat, updates move there. No email on file: nothing changes; the business can update it in person with the same code check.
- **STOP**: the customer texts STOP to Rosie's number. Expect: Rosie's texts to that phone stop for every business (D102); no booking is cancelled.
- **First contact** (D103): book on the booking page with a mobile that has never texted Rosie, and an email. Expect: one SMS (booking confirmed, one link that opens Messages with the ready text), the full confirmation by email with the same link, and no other text. Send the ready text: the chat opens and one reply gives the booking as it stands, with the check-in code. Book again with that mobile: no SMS; the confirmation comes in the chat. A mobile that never texts in gets a new SMS with each new booking.
- **Visit check** (D98): the day after a Rosie-made booking with no check-in code and no DONE, the customer gets one 'did it happen?' message; the answer is recorded only (no blacklist).
- **License** (D96): the owner uploads any document or none; nothing says Rosie checked it.
- **No placement** (D99): search results never say 'recommended' and no one can pay to be first.
- **$2** (S1-25, D97): paid by the business, counted at the first check-in code (or DONE with no code); no visit, no $2; one $2 per booking however many visits; capped at $49 a month per person per business; walk-ins and jobs the owner adds are free. A membership or repeat plan charged monthly through Rosfield pays 1% of each charge instead.


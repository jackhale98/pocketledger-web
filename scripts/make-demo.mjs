// Generate the demo vault (src/demo/vault). Dates are anchored so the last
// month is DEMO_ANCHOR (2026-10); the app shifts them to the current month at load
// (src/lib/vault/demo.ts).
import { mkdirSync, writeFileSync } from 'node:fs';

let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const money = (min, max) => (min + rnd() * (max - min)).toFixed(2);
const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
const pad = (n) => String(n).padStart(2, '0');
const out = 'src/demo/vault';
mkdirSync(`${out}/2026`, { recursive: true });
mkdirSync(`${out}/import`, { recursive: true });

writeFileSync(
  `${out}/main.journal`,
  `; PocketLedger demo vault.
; Everything here is fictional. Edit freely: changes stay on this device.
;
; The root journal pulls in declarations, prices, budgets and one file per year.

include accounts.journal
include prices.journal
include budget.journal
include 2026/*.journal
`,
);

writeFileSync(
  `${out}/accounts.journal`,
  `; Account declarations with hledger account types.
commodity $1,000.00
commodity 1.000,00 EUR
commodity 1.000 VTI
commodity 1.000 BND

account assets                    ; type: A
account assets:checking           ; type: C
account assets:savings            ; type: C
account assets:cash               ; type: C
account assets:brokerage          ; type: A
account assets:euro cash          ; type: C
account liabilities               ; type: L
account liabilities:credit card   ; type: L
account equity                    ; type: E
account income                    ; type: R
account income:salary
account income:interest
account income:dividends
account expenses                  ; type: X
account expenses:rent
account expenses:groceries
account expenses:dining
account expenses:coffee
account expenses:transport
account expenses:utilities
account expenses:subscriptions
account expenses:travel
account expenses:health
account expenses:gifts
`,
);

writeFileSync(
  `${out}/prices.journal`,
  `; Market prices. PocketLedger never downloads prices; they come from here.
P 2026-05-01 EUR $1.08
P 2026-07-01 EUR $1.10
P 2026-09-01 EUR $1.12
P 2026-05-01 VTI $262.10
P 2026-06-01 VTI $268.40
P 2026-07-01 VTI $274.95
P 2026-08-01 VTI $271.30
P 2026-09-01 VTI $280.15
P 2026-10-01 VTI $286.60
P 2026-05-01 BND $72.40
P 2026-06-01 BND $72.85
P 2026-07-01 BND $72.10
P 2026-08-01 BND $73.05
P 2026-09-01 BND $73.60
P 2026-10-01 BND $73.20
`,
);

writeFileSync(
  `${out}/budget.journal`,
  `; Periodic transactions: budget goals (see Budget) and the forecast (Reports → Forecast).
~ monthly from 2026-05  Monthly spending
    expenses:rent             $1,650.00
    expenses:groceries          $520.00
    expenses:dining             $220.00
    expenses:coffee              $45.00
    expenses:transport          $120.00
    expenses:utilities          $160.00
    expenses:subscriptions       $40.00
    assets:checking

~ every 15th day of month from 2026-05  Acme Corp | Salary
    assets:checking           $3,200.00
    income:salary

~ every 28th day of month from 2026-05  Acme Corp | Salary
    assets:checking           $3,200.00
    income:salary

~ monthly from 2026-05  Transfer to savings
    assets:savings              $400.00
    assets:checking
`,
);

const lines = [];
const tx = (date, status, desc, postings, comment) => {
  lines.push(`${date}${status ? ' ' + status : ''} ${desc}${comment ? '  ; ' + comment : ''}`);
  for (const [acct, amt, c] of postings) {
    if (amt == null) lines.push(`    ${acct}${c ? '  ; ' + c : ''}`);
    else lines.push(`    ${acct.padEnd(34)}${amt.padStart(14)}${c ? '  ; ' + c : ''}`);
  }
  lines.push('');
};
const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd = (n) => `$${fmt(n)}`;
const nusd = (n) => `$-${fmt(n)}`;

tx('2026-05-01', '*', 'Opening balances', [
  ['assets:checking', usd(4200)],
  ['assets:savings', usd(12500)],
  ['assets:cash', usd(80)],
  ['assets:brokerage', '20 VTI @ $262.10'],
  ['liabilities:credit card', nusd(640.25)],
  ['equity:opening balances', null],
]);

const grocers = ['Green Market', 'Corner Grocery', 'FreshCo', 'Farmers Market'];
const diners = ['Noodle House', 'Taqueria Sol', 'Pizza Corner', 'Thai Basil', 'Sushi Bar'];
const vti = [262.1, 268.4, 274.95, 271.3, 280.15, 286.6];
const bnd = [72.4, 72.85, 72.1, 73.05, 73.6, 73.2];
for (const [mi, m] of months.entries()) {
  const ev = [];
  ev.push([1, '*', 'Landlord | Rent', [['expenses:rent', usd(1650)], ['assets:checking', null]]]);
  ev.push([15, '*', 'Acme Corp | Salary', [['assets:checking', usd(3200)], ['income:salary', null]], 'payroll:']);
  ev.push([28, '*', 'Acme Corp | Salary', [['assets:checking', usd(3200)], ['income:salary', null]], 'payroll:']);
  ev.push([5, '*', 'City Power | Electricity', [['expenses:utilities', usd(money(70, 120))], ['assets:checking', null]]]);
  ev.push([9, '*', 'Fiber Net | Internet', [['expenses:utilities', usd(60)], ['assets:checking', null]]]);
  ev.push([3, '*', 'StreamFlix | Subscription', [['expenses:subscriptions', usd(15.99)], ['liabilities:credit card', null]]]);
  ev.push([12, '*', 'Music Box | Subscription', [['expenses:subscriptions', usd(10.99)], ['liabilities:credit card', null]]]);
  ev.push([20, '*', 'Credit card payment', [['liabilities:credit card', usd(money(500, 800))], ['assets:checking', null]]]);
  ev.push([25, '*', 'Transfer to savings', [['assets:savings', usd(400)], ['assets:checking', null]]]);
  ev.push([28, '*', 'Savings interest', [['assets:savings', usd(money(18, 26))], ['income:interest', null]]]);
  for (let w = 0; w < 4; w++)
    ev.push([2 + w * 7, '*', `${pick(grocers)} | Groceries`, [['expenses:groceries', usd(money(80, 150))], ['liabilities:credit card', null]]]);
  for (let k = 0; k < 4; k++)
    ev.push([Math.floor(1 + rnd() * 27), '*', `${pick(diners)} | Dinner`, [['expenses:dining', usd(money(18, 62))], ['liabilities:credit card', null]]]);
  for (let k = 0; k < 6; k++)
    ev.push([Math.floor(1 + rnd() * 27), '*', 'Bean There | Coffee', [['expenses:coffee', usd(money(3.5, 6.5))], ['assets:cash', null]]]);
  ev.push([Math.floor(1 + rnd() * 27), '*', 'Metro Card | Transit pass', [['expenses:transport', usd(95)], ['assets:checking', null]]]);
  ev.push([Math.floor(1 + rnd() * 27), '*', 'ATM withdrawal', [['assets:cash', usd(60)], ['assets:checking', null]]]);
  ev.push([10, '*', 'Brokerage | Buy VTI', [['assets:brokerage', `2 VTI @ $${vti[mi].toFixed(2)}`], ['assets:checking', null]]]);
  ev.push([11, '*', 'Brokerage | Buy BND', [['assets:brokerage', `5 BND @ $${bnd[mi].toFixed(2)}`], ['assets:checking', null]]]);
  if (m === '2026-06' || m === '2026-09') ev.push([26, '*', 'Brokerage | VTI dividend', [['assets:checking', usd(m === '2026-06' ? 41.18 : 43.92)], ['income:dividends', null]]]);
  if (m === '2026-07') {
    ev.push([18, '*', 'Air Europa | Flights', [['expenses:travel', usd(684.4)], ['liabilities:credit card', null]], 'trip:lisbon']);
    ev.push([22, '*', 'Hotel Lisboa', [['expenses:travel', '410,00 EUR @@ $451.00'], ['liabilities:credit card', null]], 'trip:lisbon']);
    ev.push([21, '*', 'ATM Lisbon | Euros for the trip', [['assets:euro cash', '150,00 EUR @@ $166.50'], ['assets:checking', null]], 'trip:lisbon']);
    ev.push([23, '*', 'Pastelaria Belém', [['expenses:dining', null], ['assets:euro cash', '-18,40 EUR @ $1.11']], 'trip:lisbon']);
    ev.push([24, '*', 'Lisbon Metro | Tram tickets', [['expenses:transport', null], ['assets:euro cash', '-12,80 EUR @ $1.11']], 'trip:lisbon']);
  }
  if (m === '2026-09') ev.push([14, '*', 'Pharmacy', [['expenses:health', usd(32.15)], ['liabilities:credit card', null]]]);
  if (m === '2026-10') {
    ev.push([21, '!', 'Bookshop | Birthday gift', [['expenses:gifts', usd(42)], ['liabilities:credit card', null]], 'pending until it clears']);
    ev.push([24, '', 'Green Market | Groceries', [['expenses:groceries', usd(96.3)], ['liabilities:credit card', null]]]);
  }
  ev.sort((a, b) => a[0] - b[0]);
  for (const [d, st, desc, ps, c] of ev) tx(`${m}-${pad(Math.min(d, 28))}`, st, desc, ps, c);
}
writeFileSync(`${out}/2026/2026.journal`, `; 2026 transactions\n\n${lines.join('\n')}`);

writeFileSync(
  `${out}/import/bank.csv`,
  `Date,Description,Amount,Balance
2026-10-26,BEAN THERE COFFEE,-4.75,5120.12
2026-10-27,GREEN MARKET,-88.20,5031.92
2026-10-28,ACME CORP PAYROLL,3200.00,8231.92
2026-10-29,METRO CARD,-95.00,8136.92
2026-10-30,TAQUERIA SOL,-31.60,8105.32
`,
);
writeFileSync(
  `${out}/import/bank.csv.rules`,
  `# CSV rules for the demo bank export. See hledger's CSV manual.
skip 1
fields date, description, amount, balance
currency $
account1 assets:checking

if COFFEE
  account2 expenses:coffee
if GREEN MARKET
  account2 expenses:groceries
if PAYROLL
  account2 income:salary
if METRO
  account2 expenses:transport
if TAQUERIA
  account2 expenses:dining
`,
);
console.log('demo vault written');

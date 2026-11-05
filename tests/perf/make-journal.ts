// Deterministic synthetic journals for performance work: N transactions over
// several years, ~30 accounts, 3 commodities with monthly prices, a budget rule.
export function makeJournal(n: number, years = 5): string {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
  const expenses = [
    'groceries', 'dining', 'coffee', 'rent', 'utilities:power', 'utilities:water', 'utilities:internet', 'transport:fuel',
    'transport:transit', 'health', 'gifts', 'travel:flights', 'travel:hotels', 'subscriptions', 'clothing', 'home:repairs',
    'home:furniture', 'education', 'pets', 'insurance',
  ];
  const payees = ['Green Market', 'Corner Shop', 'Bean There', 'City Power', 'Fiber Net', 'Metro', 'Pharmacy', 'Bookshop', 'Air Lines', 'Hotel', 'StreamFlix', 'Garage', 'Vet', 'School'];
  const out: string[] = ['; synthetic journal', 'commodity $1,000.00', 'commodity 1.000,00 EUR', 'commodity 1.000 VTI', ''];
  const accounts = ['assets:checking', 'assets:savings', 'assets:cash', 'assets:brokerage', 'liabilities:card', 'income:salary', 'income:interest', 'equity:conversion', ...expenses.map((e) => `expenses:${e}`)];
  for (const a of accounts) out.push(`account ${a}`);
  out.push('', '~ monthly from 2020-01', '    expenses:groceries  $500', '    expenses:dining  $200', '    expenses:rent  $1,600', '    assets:checking', '');
  const start = Date.UTC(2021, 0, 1);
  const span = years * 365 * 86400000;
  const dates = Array.from({ length: n }, () => start + Math.floor(rnd() * span)).sort((a, b) => a - b);
  let month = '';
  for (const t of dates) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d.slice(0, 7) !== month) {
      month = d.slice(0, 7);
      out.push(`P ${month}-01 EUR $${(1 + rnd() * 0.2).toFixed(4)}`, `P ${month}-01 VTI $${(200 + rnd() * 100).toFixed(2)}`, '');
    }
    const r = rnd();
    if (r < 0.06) out.push(`${d} * Acme | Salary`, `    assets:checking  $${(3000 + rnd() * 500).toFixed(2)}`, '    income:salary', '');
    else if (r < 0.09) out.push(`${d} * Broker | Buy VTI`, `    assets:brokerage  ${1 + Math.floor(rnd() * 3)} VTI @ $${(200 + rnd() * 100).toFixed(2)}`, '    assets:checking', '');
    else if (r < 0.11) {
      const eur = (50 + rnd() * 200).toFixed(2).replace('.', ',');
      out.push(`${d} * Trip | Paris`, `    expenses:travel:hotels  ${eur} EUR`, `    assets:cash  -${eur} EUR`, '');
    } else
      out.push(
        `${d}${rnd() < 0.9 ? ' *' : ''} ${pick(payees)} | ${pick(['weekly', 'misc', 'top-up', 'monthly'])}`,
        `    expenses:${pick(expenses)}  $${(5 + rnd() * 150).toFixed(2)}${rnd() < 0.1 ? '  ; tag:x' : ''}`,
        `    ${pick(['assets:checking', 'liabilities:card'])}`,
        '',
      );
  }
  return out.join('\n');
}

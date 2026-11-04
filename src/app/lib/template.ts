// The starter journal for "New journal".
export function newJournalTemplate(commodity = '$'): string {
  const left = commodity.length === 1 || /^[^A-Za-z]/.test(commodity);
  const style = left ? `${commodity}1,000.00` : `1,000.00 ${commodity}`;
  const today = new Date();
  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const amt = (n: string) => (left ? `${commodity}${n}` : `${n} ${commodity}`);
  return `; My hledger journal, created with PocketLedger.
; Format reference: https://hledger.org/hledger.html#journal

commodity ${style}

account assets                  ; type: A
account assets:checking         ; type: C
account assets:savings          ; type: C
account assets:cash             ; type: C
account liabilities             ; type: L
account liabilities:credit card
account equity                  ; type: E
account equity:opening balances
account income                  ; type: R
account income:salary
account expenses                ; type: X
account expenses:groceries
account expenses:dining
account expenses:housing
account expenses:transport
account expenses:utilities

${d} * Opening balances
    assets:checking                    ${amt('0.00')}
    equity:opening balances
`;
}

// Run: node tests/parser.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseCheckin } from '../supabase/functions/_shared/checkin-parser.js';

assert.equal(
  readFileSync(new URL('../web/checkin-parser.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../supabase/functions/_shared/checkin-parser.js', import.meta.url), 'utf8'),
  'web/checkin-parser.js must be an exact copy of supabase/functions/_shared/checkin-parser.js');

const known = [
  { id: 'd1', name: "Jim's Furniture & Mattress", account_number: '123456' },
  { id: 'd2', name: 'Coastal Home' },
  { id: 'd3', name: 'Furniture For Less' },
];

const cases = [
  ['ABC Furniture has checked in.', { dealer: 'ABC Furniture', confidence: 'medium' }],
  ['Check-in: Smith\'s Home Furnishings - John Smith (Owner)', { dealer: "Smith's Home Furnishings", confidence: 'medium' }],
  ['Coastal Home is here with 3 buyers', { dealer: 'Coastal Home', dealerId: 'd2', party: '3 buyers', confidence: 'high' }],
  ["Jims Furniture and Mattress (Acct 123456) checked in with Mary Jones", { dealerId: 'd1', account: '123456', party: 'Mary Jones', confidence: 'high' }],
  ['Fwd: Dealer: Badcock Home\nContact: Tom Lee\nGuests: 2', { dealer: 'Badcock Home', party: 'Tom Lee, 2 in party', confidence: 'medium' }],
  ["Your guest Morgan's Furniture has arrived at the showroom", { dealer: "Morgan's Furniture", confidence: 'medium' }],
  ['Furniture For Less just checked in, party of 4', { dealerId: 'd3', party: 'party of 4', confidence: 'high' }],
  ['Heads up — Furniture For Less is wandering around building 2', { dealerId: 'd3', confidence: 'high' }],
  ['Lunch at noon?', { dealer: null, confidence: 'low' }],
  ['Someone checked in', { dealer: null, confidence: 'low' }],
  ['Brown & Sons Furniture arrived', { dealer: 'Brown & Sons Furniture', confidence: 'medium' }],
];

let fails = 0;
for (const [text, want] of cases) {
  const got = parseCheckin(text, known);
  for (const [k, v] of Object.entries(want)) {
    if (got[k] !== v) { fails++; console.log(`FAIL ${JSON.stringify(text)}\n  ${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`); }
  }
}
console.log(fails ? `${fails} failure(s)` : `All ${cases.length} cases pass`);
process.exit(fails ? 1 : 0);

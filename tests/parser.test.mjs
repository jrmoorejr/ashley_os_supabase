// Run: node tests/parser.test.mjs
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { parseCheckin, smartCase, matchMember } from '../supabase/functions/_shared/checkin-parser.js';

assert.equal(
  readFileSync(new URL('../web/checkin-parser.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../supabase/functions/_shared/checkin-parser.js', import.meta.url), 'utf8'),
  'web/checkin-parser.js must be an exact copy of supabase/functions/_shared/checkin-parser.js');

const known = [
  { id: 'd1', name: "Jim's Furniture & Mattress", account_number: '123456' },
  { id: 'd2', name: 'Coastal Home' },
  { id: 'd3', name: 'Furniture For Less' },
  { id: 'd4', name: 'South' },
  { id: 'd5', name: 'Fleet Plummer' },
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
  // Real High Point / Las Vegas market texts (short code 274-539)
  ['J.R. MOORE – Meet SHELBY SARI from FURNITURELAND SOUTH at Front Desk',
    { dealer: 'Furnitureland South', dealerId: null, party: 'Shelby Sari', requestedRep: 'J.R. Moore', location: 'Front Desk', confidence: 'high', ignore: false }],
  ['J.R. MOORE – Meet REID PLUMMER from FLEET PLUMMER at Front Desk',
    { dealer: 'Fleet Plummer', dealerId: 'd5', party: 'Reid Plummer', requestedRep: 'J.R. Moore', location: 'Front Desk' }],
  ['J.R. MOORE – Meet GREG BUNTING from REVOLUTIONARY RETAIL at Front Desk',
    { dealer: 'Revolutionary Retail', party: 'Greg Bunting' }],
  ['J.R. MOORE - Meet ANN LEE from HOME AT LAST FURNITURE at Booth 2',
    { dealer: 'Home at Last Furniture', location: 'Booth 2' }],
  ['J.R. Moore has opted in for SMS notifications for the upcoming Market.', { dealer: null, ignore: true }],
  ['Brown & Sons Furniture arrived', { dealer: 'Brown & Sons Furniture', confidence: 'medium' }],
];

let fails = 0;
const check = (label, got, want) => { if (got !== want) { fails++; console.log(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };
check('smartCase', smartCase("BOB'S DISCOUNT FURNITURE & MATTRESS LLC"), "Bob's Discount Furniture & Mattress LLC");
check('smartCase mixed', smartCase('Rooms To Go'), 'Rooms To Go');
const team = [{ id: 'm1', full_name: 'JR Moore' }, { id: 'm2', full_name: 'Avery Lee' }];
check('matchMember', matchMember('J.R. MOORE', team)?.id, 'm1');
check('matchMember none', matchMember('Pat Smith', team), null);

for (const [text, want] of cases) {
  const got = parseCheckin(text, known);
  for (const [k, v] of Object.entries(want)) {
    if (got[k] !== v) { fails++; console.log(`FAIL ${JSON.stringify(text)}\n  ${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(v)}`); }
  }
}
console.log(fails ? `${fails} failure(s)` : `All ${cases.length} cases pass`);
process.exit(fails ? 1 : 0);

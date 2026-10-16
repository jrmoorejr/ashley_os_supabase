// Reads a check-in text message and pulls out the dealer, who's with them, and an account number.
// Shared by the inbound-checkin Edge Function and the web app (web/checkin-parser.js is an
// identical copy; tests/parser.test.mjs fails if they drift apart).
//
// parseCheckin(text, knownDealers) ->
//   { dealer, dealerId, party, account, requestedRep, location, confidence, ignore }
//   confidence: 'high'   matched a dealer already in the system, or the market's own check-in format
//               'medium' matched a check-in phrase ("X checked in", "Dealer: X", ...)
//               'low'    couldn't find a dealer name; send to the review inbox
//   ignore:     true for housekeeping texts (opt-in confirmations, STOP/HELP replies) that aren't check-ins
//
// The High Point / Las Vegas market front desk (short code 274-539) sends:
//   "J.R. MOORE – Meet SHELBY SARI from FURNITURELAND SOUTH at Front Desk"
//    rep asked for     buyer               dealer                 location

const FILLER_PREFIX = /^(?:fwd?:\s*|re:\s*|reminder:\s*|alert:\s*|your\s+)?(?:guest|customer|dealer|visitor|client|account|retailer|buyer)s?\s+/i;
const STOP_AT = /\s+(?:with|w\/|along with|accompanied by|at the|at your|to see|in the|has|have|is|are|just|-|–|—|\|)\s+.*$|\s*[(\[].*$|[.!,;]+\s*$/i;

const LINE_LABELS = {
  dealer: /^(?:dealer|dealer name|customer|customer name|company|account name|store|retailer|business|bill to|ship to)\s*[:#\-–]\s*(.+)$/i,
  party: /^(?:contact|contact name|name|buyer|buyers|attendee|attendees|guest|guest name|guests|visitor|visitors|with)\s*[:\-–]\s*(.+)$/i,
  size: /^(?:party size|# in party|number in party|group size|guests|people|count)\s*[:\-–]\s*(\d+)\s*$/i,
};

const PHRASES = [
  /^(.+?)\s+(?:has|have)?\s*(?:just\s+)?(?:checked|signed)[\s-]*in\b/i,
  /^(.+?)\s+(?:has|have)\s+(?:just\s+)?arrived\b/i,
  /^(.+?)\s+(?:just\s+)?arrived\b/i,
  /^(.+?)\s+(?:is|are)\s+(?:now\s+)?(?:here|in the (?:showroom|building|space)|at (?:the )?(?:front )?(?:desk|door|reception))\b/i,
  /\b(?:check(?:ed)?[\s-]*in|arrival|arrived|now here|new arrival|here now)\s*[:\-–]\s*(.+)$/i,
];

// Market format: "<REP> – Meet <BUYER> from <DEALER> at <LOCATION>"
const MARKET_MEET = /^\s*(.+?)\s*[–—-]+\s*meet\s+(.+?)\s+from\s+(.+?)\s*[.!]?\s*$/i;
const HOUSEKEEPING = /\b(?:opted in|opt[- ]?in|opted out|opt[- ]?out|unsubscribe|reply stop|text stop|msg ?& ?data rates|message and data rates|reply help)\b/i;

const KEEP_UPPER = new Set(['LLC', 'USA', 'II', 'III', 'IV', 'HQ', 'DBA']);
const SMALL = new Set(['of', 'and', 'the', 'at', 'for', 'to', 'in', 'on', 'by', 'a', 'an']);
// "FURNITURELAND SOUTH" -> "Furnitureland South"; leaves already mixed-case text alone.
export function smartCase(s) {
  s = String(s || '').trim();
  if (!s || /[a-z]/.test(s)) return s;
  return s.toLowerCase().split(/(\s+)/).map((w, i) => {
    if (/^\s+$/.test(w)) return w;
    const up = w.toUpperCase();
    if (KEEP_UPPER.has(up.replace(/[^A-Z]/g, '')) || (/^[A-Z]{2,4}$/.test(up) && !/[AEIOUY]/.test(up))) return up;
    if (i > 0 && SMALL.has(w)) return w;
    return w.replace(/(^|[-/.(&]|\b[od]')([a-z])/g, (_, a, b) => a + b.toUpperCase());
  }).join('');
}

// Match a name from a text ("J.R. MOORE") to a team member ("JR Moore", "J.R. Moore").
export function matchMember(name, members = []) {
  const key = n => String(n || '').toLowerCase().replace(/[^a-z]/g, '');
  const k = key(name);
  if (!k) return null;
  return members.find(m => key(m.full_name) === k) || null;
}

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const norm = s => clean(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\b(?:inc|llc|co|corp|the)\b/g, ' ').replace(/\s+/g, ' ').trim();

function tidyDealer(raw) {
  let s = clean(raw).replace(/^["'“”]+|["'“”]+$/g, '');
  for (let i = 0; i < 3; i++) s = s.replace(FILLER_PREFIX, '');
  s = s.replace(STOP_AT, '').replace(STOP_AT, '');
  s = s.replace(/^["'“”]+|["'“”:\-–]+$/g, '').trim();
  return s.length >= 2 && s.length <= 80 ? s : null;
}

export function parseCheckin(text, knownDealers = []) {
  const body = clean(String(text || '')
    .replace(/-{2,}\s*forwarded message\s*-{2,}/gi, ' ')
    .replace(/\r/g, ''));
  const lines = String(text || '').split(/\n+/).map(clean).filter(Boolean)
    .map(l => l.replace(/^(?:fwd?|re):\s*/i, ''));
  const out = { dealer: null, dealerId: null, party: null, account: null, requestedRep: null, location: null, confidence: 'low', ignore: false };
  if (!body) return out;

  // The market's own front-desk format.
  const mm = body.match(MARKET_MEET);
  if (mm) {
    const rest = mm[3];
    const at = rest.toLowerCase().lastIndexOf(' at ');
    out.requestedRep = smartCase(mm[1]);
    out.party = smartCase(mm[2]);
    out.dealer = smartCase(at > 0 ? rest.slice(0, at) : rest).replace(/[.!,;]+$/, '');
    out.location = at > 0 ? smartCase(rest.slice(at + 4)).replace(/[.!,;]+$/, '') : null;
    out.confidence = 'high';
    return preferKnown(out, body, knownDealers, true);
  }
  if (HOUSEKEEPING.test(body)) { out.ignore = true; return out; }

  // Account number
  const acct = body.match(/\b(?:acct|account|cust(?:omer)?|dealer)\s*(?:#|no\.?|num(?:ber)?)\s*:?\s*([A-Z0-9][A-Z0-9-]{2,})/i)
    || body.match(/\b(?:acct|account)\s*:?\s*([0-9][A-Z0-9-]{2,})/i);
  if (acct) out.account = acct[1];

  // Labeled lines ("Dealer: X", "Contact: Y", "Guests: 3")
  const partyBits = [];
  for (const line of lines) {
    let m;
    if (!out.dealer && (m = line.match(LINE_LABELS.dealer))) out.dealer = tidyDealer(m[1]);
    else if ((m = line.match(LINE_LABELS.size))) partyBits.push(`${m[1]} in party`);
    else if ((m = line.match(LINE_LABELS.party))) partyBits.push(clean(m[1]));
  }
  if (out.dealer) out.confidence = 'medium';

  // Phrases ("X checked in", "X is here", "Check-in: X")
  if (!out.dealer) {
    for (const line of [...lines, body]) {
      for (const re of PHRASES) {
        const m = line.match(re);
        const d = m && tidyDealer(m[1]);
        if (d && !/^(?:someone|somebody|a dealer|a customer|they|he|she|guest|your guest|new guest)$/i.test(d)) {
          out.dealer = d; out.confidence = 'medium'; break;
        }
      }
      if (out.dealer) break;
    }
  }

  // Who's with them ("... with John Smith and 2 buyers", "party of 3")
  if (!partyBits.length) {
    const w = body.match(/\b(?:with|w\/|along with|accompanied by)\s+(.+?)(?:[.!;]|\s+(?:at|to see|in the)\s|$)/i);
    if (w) partyBits.push(clean(w[1]));
    const n = body.match(/\bparty of (\d+)\b/i);
    if (n) partyBits.push(`party of ${n[1]}`);
  }
  if (partyBits.length) out.party = partyBits.join(', ').slice(0, 120);
  if (out.dealer) out.dealer = smartCase(out.dealer);
  return preferKnown(out, body, knownDealers);
}

// Prefer a dealer we already know: by account number, exact name, or name appearing in the text.
function preferKnown(out, body, knownDealers, exactOnly = false) {
  if (knownDealers.length) {
    const nb = ' ' + norm(body) + ' ';
    let match = out.account && knownDealers.find(d => d.account_number && String(d.account_number).toLowerCase() === out.account.toLowerCase());
    if (!match && out.dealer) match = knownDealers.find(d => norm(d.name) === norm(out.dealer));
    if (!match && !exactOnly) {
      match = knownDealers
        .filter(d => norm(d.name).length >= 4 && nb.includes(' ' + norm(d.name) + ' '))
        .sort((a, b) => norm(b.name).length - norm(a.name).length)[0];
    }
    if (match) { out.dealer = match.name; out.dealerId = match.id; out.confidence = 'high'; }
  }
  return out;
}

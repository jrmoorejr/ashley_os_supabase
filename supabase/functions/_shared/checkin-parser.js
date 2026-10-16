// Reads a check-in text message and pulls out the dealer, who's with them, and an account number.
// Shared by the inbound-checkin Edge Function and the web app (web/checkin-parser.js is an
// identical copy; tests/parser.test.mjs fails if they drift apart).
//
// parseCheckin(text, knownDealers) -> { dealer, dealerId, party, account, confidence }
//   confidence: 'high'   matched a dealer already in the system
//               'medium' matched a check-in phrase ("X checked in", "Dealer: X", ...)
//               'low'    couldn't find a dealer name; send to the review inbox

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
  const out = { dealer: null, dealerId: null, party: null, account: null, confidence: 'low' };
  if (!body) return out;

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

  // Prefer a dealer we already know: by account number, exact name, or name appearing in the text.
  if (knownDealers.length) {
    const nb = ' ' + norm(body) + ' ';
    let match = out.account && knownDealers.find(d => d.account_number && String(d.account_number).toLowerCase() === out.account.toLowerCase());
    if (!match && out.dealer) match = knownDealers.find(d => norm(d.name) === norm(out.dealer));
    if (!match) {
      match = knownDealers
        .filter(d => norm(d.name).length >= 4 && nb.includes(' ' + norm(d.name) + ' '))
        .sort((a, b) => norm(b.name).length - norm(a.name).length)[0];
    }
    if (match) { out.dealer = match.name; out.dealerId = match.id; out.confidence = 'high'; }
  }
  return out;
}

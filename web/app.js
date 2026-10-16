import { DemoStore, SupabaseStore } from './store.js';
import { parseCheckin, matchMember } from './checkin-parser.js';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};

function dur(fromIso, toIso) {
  const ms = Math.max(0, (toIso ? new Date(toIso) : new Date()) - new Date(fromIso));
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
const mins = (a, b) => { const m = Math.round(minutes(a, b)); return m < 1 ? '<1m' : m + 'm'; };
const minutes = (a, b) => Math.round(((b ? new Date(b) : new Date()) - new Date(a)) / 6000) / 10;
const clock = iso => iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
const stamp = iso => iso ? new Date(iso).toLocaleString([], { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const timer = (since, until) => until
  ? `<span class="timer">${dur(since, until)}</span>`
  : `<span class="timer live" data-since="${esc(since)}">${dur(since)}</span>`;

export function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 10 ? '+' + digits : '';
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return digits.length > 10 ? '+' + digits : '';
}

export function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}

const csvCell = v => /[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? '');
function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`; el.textContent = msg;
  const box = $('#toasts');
  box.append(el);
  while (box.children.length > 2) box.firstElementChild.remove();
  const ms = kind === 'page' ? 8000 : 3200;
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 500);
}

// ---------------------------------------------------------------------------
// Config + store
// ---------------------------------------------------------------------------
const fileCfg = window.MARKET_PAGER_CONFIG || {};
const savedCfg = LS.get('market-pager-config', null);
const cfg = savedCfg || (fileCfg.supabaseUrl
  ? { mode: 'supabase', url: fileCfg.supabaseUrl, key: fileCfg.supabaseAnonKey }
  : { mode: 'demo' });

const BUSINESS = fileCfg.businessName || 'Creative Connection by Christy, Inc.';
const TERMS_URL = fileCfg.termsUrl || 'https://encmotion.com';
// Exact wording each rep agrees to; stored with the time they agreed, as proof of opt-in.
const CONSENT_TEXT = `I agree to receive Market Pager text alerts from ${BUSINESS} at the cell number above when a dealer is ready for my division during furniture market events. Message frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out. Agreeing is not required to use the app. SMS Terms and Privacy Policy: ${TERMS_URL.replace(/^https?:\/\//, '')}`;

let store;
try {
  store = cfg.mode === 'supabase' && cfg.url && cfg.key ? new SupabaseStore(cfg.url, cfg.key) : new DemoStore();
} catch (e) {
  console.error(e);
  store = new DemoStore();
  setTimeout(() => toast('Could not connect to Supabase — running demo mode', 'warn'), 500);
}

const state = {
  D: null,
  view: LS.get('mp-view', 'floor'),
  filter: 'all',
  search: '',
  mineOnly: LS.get('mp-mine', false),
  me: null,
  session: null,
  alerted: new Set(),
  loaded: false,
  loginEmail: '',
  loginSent: false,
};

// ---------------------------------------------------------------------------
// Derived data
// ---------------------------------------------------------------------------
function indexData(d) {
  const byId = arr => Object.fromEntries(arr.map(r => [r.id, r]));
  const market = d.markets.find(m => m.is_active) || null;
  return {
    ...d,
    market,
    div: byId(d.divisions),
    mem: byId(d.team_members),
    dealer: byId(d.dealers),
    divs: d.divisions.filter(x => x.active !== false).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    visits: market ? d.visits.filter(v => v.market_id === market.id) : [],
  };
}

const D = () => state.D;
// Postgres and JS format timestamps differently, so always compare as numbers.
const ts = iso => new Date(iso).getTime();
const byTime = key => (a, b) => ts(a[key]) - ts(b[key]);
const walksOf = v => D().walkthroughs.filter(w => w.visit_id === v.id).sort(byTime('started_at'));
const openWalk = v => walksOf(v).find(w => !w.ended_at);
const seenDivIds = v => new Set(walksOf(v).map(w => w.division_id));
const pagesOf = v => D().pages.filter(p => p.visit_id === v.id && !p.cancelled_at);
const fulfilled = (v, p) => walksOf(v).some(w => w.division_id === p.division_id && ts(w.started_at) >= ts(p.requested_at));
const openPages = v => pagesOf(v).filter(p => !p.claimed_at && !fulfilled(v, p));
const onTheWay = v => pagesOf(v).filter(p => p.claimed_at && !fulfilled(v, p));
const divsOfMember = id => D().member_divisions.filter(l => l.member_id === id).map(l => l.division_id);
const membersOfDiv = id => D().member_divisions.filter(l => l.division_id === id).map(l => D().mem[l.member_id]).filter(m => m?.active);
const divName = id => D().div[id]?.name || 'Unknown';
const memName = id => D().mem[id]?.full_name || '—';
const dealerOf = v => D().dealer[v.dealer_id] || { name: 'Unknown dealer' };
const isAdmin = () => store.kind === 'demo' || state.me?.role === 'admin';
const myDivs = () => state.me ? divsOfMember(state.me.id) : [];

function statusOf(v) {
  if (v.checked_out_at) return { k: 'out', label: 'Checked out', since: v.checked_in_at, until: v.checked_out_at };
  const w = openWalk(v);
  if (w) return { k: 'with', label: `With ${divName(w.division_id)}`, sub: memName(w.rep_id), since: w.started_at, walk: w };
  const otw = onTheWay(v);
  if (otw.length) return { k: 'otw', label: `${otw.map(p => memName(p.claimed_by)).join(', ')} on the way`, sub: otw.map(p => divName(p.division_id)).join(', '), since: otw[0].claimed_at };
  const op = openPages(v);
  if (op.length) return { k: 'paging', label: `Paging ${op.map(p => divName(p.division_id)).join(', ')}`, since: [...op].sort(byTime('requested_at'))[0].requested_at };
  const last = walksOf(v).filter(w => w.ended_at).pop();
  return { k: 'waiting', label: last ? 'Between divisions' : 'Here — waiting', since: last?.ended_at || v.checked_in_at };
}

// ---------------------------------------------------------------------------
// Pager alerts (sound + vibration + system notification) for my divisions
// ---------------------------------------------------------------------------
let audioCtx = null;
function enableAlerts() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
  // During setup, keep the half-filled form; just update the button.
  const refresh = () => {
    const b = $('#setup-form [data-action=alerts]');
    if (b) b.textContent = '🔔 Alerts are on. Test the sound'; else render();
  };
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().then(refresh);
  LS.set('mp-alerts', true);
  beep();
  refresh();
}
function beep() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [0, 0.18, 0.36].forEach(off => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 1320;
    g.gain.setValueAtTime(0.0001, t + off);
    g.gain.exponentialRampToValueAtTime(0.15, t + off + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.12);
    o.connect(g).connect(audioCtx.destination); o.start(t + off); o.stop(t + off + 0.13);
  });
}
function checkAlerts() {
  if (!state.me) return;
  const mine = new Set(myDivs());
  for (const v of D().visits.filter(v => !v.checked_out_at)) {
    for (const p of openPages(v)) {
      if (state.alerted.has(p.id)) continue;
      state.alerted.add(p.id);
      if (!state.loaded || !mine.has(p.division_id) || p.requested_by === state.me.id) continue;
      const msg = `${dealerOf(v).name} is ready for ${divName(p.division_id)}`;
      beep();
      navigator.vibrate?.([200, 100, 200, 100, 400]);
      toast('📟 ' + msg, 'page');
      if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        try { new Notification('Market page', { body: msg, tag: p.id }); } catch { /* mobile requires SW */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function run(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
  catch (e) { console.error(e); toast(e.message || String(e), 'err'); }
}

async function checkIn({ name, account, city, st, party, notes, pageDivs = [], source = 'app', requestedRep = null, requestedRepId = null, location = null }) {
  const existing = D().dealers.find(d => d.name.trim().toLowerCase() === name.trim().toLowerCase());
  let dealer = existing;
  if (!dealer) [dealer] = await store.insert('dealers', { name: name.trim(), account_number: account || null, city: city || null, state: st || null, created_at: nowIso() });
  else if (account && !dealer.account_number) await store.update('dealers', dealer.id, { account_number: account });
  const already = D().visits.find(v => v.dealer_id === dealer.id && !v.checked_out_at);
  if (already) throw new Error(`${dealer.name} is already checked in`);
  const [visit] = await store.insert('visits', {
    market_id: D().market.id, dealer_id: dealer.id, party: party || null, notes: notes || null,
    checked_in_at: nowIso(), checked_in_by: state.me?.id || null, source,
    ...(requestedRep || requestedRepId || location ? {
      requested_rep_id: requestedRepId || matchMember(requestedRep, D().team_members)?.id || null,
      requested_rep_name: requestedRep, meet_location: location,
    } : {}),
  });
  await reload();
  if (pageDivs.length) await pageDivisions(visit, pageDivs);
  return visit;
}

async function startWalk(visit, divisionId, repId) {
  const t = nowIso();
  const cur = openWalk(visit);
  if (cur) await store.update('walkthroughs', cur.id, { ended_at: t });
  await store.insert('walkthroughs', { visit_id: visit.id, division_id: divisionId, rep_id: repId || null, started_at: t });
  // Close out any page waiting on this division.
  for (const p of pagesOf(visit).filter(p => p.division_id === divisionId && !p.claimed_at)) {
    await store.update('pages', p.id, { claimed_by: repId || null, claimed_at: t });
  }
}

async function finishWalk(visit) {
  const w = openWalk(visit);
  if (w) await store.update('walkthroughs', w.id, { ended_at: nowIso() });
}

async function pageDivisions(visit, divIds) {
  const already = new Set(openPages(visit).map(p => p.division_id));
  const rows = divIds.filter(id => !already.has(id)).map(division_id => ({
    visit_id: visit.id, division_id, requested_by: state.me?.id || null, requested_at: nowIso(),
  }));
  if (!rows.length) return;
  const inserted = await store.insert('pages', rows);
  const names = rows.map(r => divName(r.division_id)).join(', ');
  try {
    const r = await store.notify(inserted.map(p => p.id));
    if (r?.demo) toast(`Paged ${names} (demo — no texts sent)`);
    else toast(`Paged ${names}: ${r?.members ?? 0} people, ${r?.sent ?? 0} texts/emails sent${r?.failed ? `, ${r.failed} failed` : ''}`);
  } catch (e) {
    toast(`Page posted to the board, but texts failed: ${e.message}`, 'warn');
  }
}

async function checkOut(visit) {
  const t = nowIso();
  await finishWalk(visit);
  for (const p of pagesOf(visit).filter(p => !fulfilled(visit, p))) await store.update('pages', p.id, { cancelled_at: t });
  await store.update('visits', visit.id, { checked_out_at: t });
}

// Texts waiting for a person to confirm (sender not trusted, or no dealer name found).
const inboxItems = () => (D().inbound_messages || [])
  .filter(m => m.status === 'pending' && Date.now() - ts(m.received_at) < 24 * 3600e3)
  .sort(byTime('received_at'));

async function checkInFromText(msg, name, party) {
  const parsed = parseCheckin(msg.body, D().dealers);
  const visit = await checkIn({ name, party, account: parsed.account, notes: null, source: 'text', requestedRep: parsed.requestedRep, location: parsed.location });
  await store.update('inbound_messages', msg.id, { status: 'checked_in', visit_id: visit.id, handled_by: state.me?.id || null, handled_at: nowIso() });
  return visit;
}

// Fill the check-in form from a pasted or forwarded text.
function fillFromText(text) {
  const f = $('#checkin-form'), out = $('#paste-result');
  if (!f || !out) return;
  if (!String(text || '').trim()) { out.innerHTML = '<span class="muted">The form below fills in as soon as you paste.</span>'; return; }
  const r = parseCheckin(text, D().dealers);
  if (r.ignore) { out.innerHTML = '<span class="warn-text">That text isn\'t a check-in (opt-in or similar).</span>'; return; }
  if (!r.dealer) { out.innerHTML = '<span class="warn-text">Couldn\'t find a dealer name in that text. Type it in below.</span>'; f.name.focus(); return; }
  const rep = matchMember(r.requestedRep, D().team_members);
  f.name.value = r.dealer;
  f.party.value = r.party || '';
  f.account.value = r.account || '';
  f.asked.value = rep?.id || '';
  f.asked_name.value = r.requestedRep || '';
  f.location.value = r.location || '';
  f.source.value = 'text';
  const here = D().visits.find(v => !v.checked_out_at && dealerOf(v).name.toLowerCase() === r.dealer.toLowerCase());
  out.innerHTML = here
    ? `<span class="warn-text">${esc(r.dealer)} is already on the floor (checked in at ${clock(here.checked_in_at)}).</span>`
    : `<span class="ok-text">✓ Filled in <b>${esc(r.dealer)}</b> ${r.dealerId ? '(returning dealer)' : '(new dealer)'}${r.requestedRep && !rep ? ` · “${esc(r.requestedRep)}” isn't on the team list` : ''}.</span> Check it, then tap <b>Check in</b>.`;
}

// Demo only: what the inbound-checkin Edge Function does when a text arrives.
async function simulateIncomingText(body) {
  const parsed = parseCheckin(body, D().dealers);
  if (parsed.ignore) {
    await store.insert('inbound_messages', { received_at: nowIso(), channel: 'sms', from_number: '274539', body, confidence: 'low', status: 'ignored' });
    return { status: 'ignored' };
  }
  const [msg] = await store.insert('inbound_messages', {
    received_at: nowIso(), channel: 'sms', from_number: '+13365550188', body,
    parsed_dealer: parsed.dealer, parsed_party: parsed.party, parsed_account: parsed.account,
    confidence: parsed.confidence, status: 'pending',
  });
  if (!parsed.dealer || parsed.confidence === 'low') return { status: 'pending' };
  const open = D().visits.find(v => !v.checked_out_at && dealerOf(v).name.toLowerCase() === parsed.dealer.toLowerCase());
  if (open) { await store.update('inbound_messages', msg.id, { status: 'duplicate', visit_id: open.id }); return { status: 'duplicate', dealer: parsed.dealer }; }
  await reload();
  await checkInFromText(D().inbound_messages.find(m => m.id === msg.id) || msg, parsed.dealer, parsed.party);
  return { status: 'checked_in', dealer: parsed.dealer };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const NAV = [['floor', 'Floor'], ['checkin', 'Check in'], ['team', 'Team'], ['log', 'Log'], ['settings', 'Settings']];

function render() {
  const app = $('#app');
  if (!state.D) { app.innerHTML = `<div class="center muted">Loading…</div>`; return; }
  if (store.kind === 'supabase' && !state.session) { app.innerHTML = loginView(); return; }
  if (store.kind === 'supabase' && !state.me) { app.innerHTML = notMemberView(); return; }
  if (state.me && (!state.me.onboarded_at || state.forceSetup)) { app.innerHTML = setupView(); return; }

  const pagesForMe = activeVisits().flatMap(v => openPages(v).filter(p => myDivs().includes(p.division_id)).map(p => ({ v, p })));
  const alertsOn = LS.get('mp-alerts', false) && audioCtx;
  app.innerHTML = `
    <header class="top">
      <div class="brand">
        <span class="logo" aria-hidden="true">📟</span>
        <div><div class="title">Market Pager</div><div class="sub">${esc(D().market?.name || 'No active market')}${store.kind === 'demo' ? ' · <b>Demo</b>' : ''}</div></div>
      </div>
      <div class="me">
        ${alertsOn ? '' : `<button class="btn small ghost" data-action="alerts">🔔 Enable alerts</button>`}
        <span class="who">${esc(state.me?.full_name || 'Guest')}</span>
      </div>
    </header>
    <nav class="tabs">${NAV.map(([k, l]) => `<button class="tab ${state.view === k ? 'on' : ''}" data-action="nav" data-view="${k}">${l}${k === 'floor' && (pagesForMe.length + inboxItems().length) ? ` <span class="dot">${pagesForMe.length + inboxItems().length}</span>` : ''}</button>`).join('')}</nav>
    <main id="view">${viewHtml()}</main>`;
  if (state.view === 'checkin') applyPendingText();
}

// A link like  ?text=J.R.%20MOORE%20–%20Meet…  opens Check in with the form filled
// (used by an iPhone Shortcut, or a link shared from Messages).
function applyPendingText() {
  let t = null;
  try { t = sessionStorage.getItem('mp-pending-text'); } catch { /* ignore */ }
  if (!t || !$('#paste-text')) return;
  try { sessionStorage.removeItem('mp-pending-text'); } catch { /* ignore */ }
  $('#paste-text').value = t;
  fillFromText(t);
}

function viewHtml() {
  if (!D().market && state.view !== 'settings' && state.view !== 'team') {
    return `<div class="empty"><h2>No active market</h2><p>${isAdmin() ? 'Create one in Settings to start checking dealers in.' : 'Ask an admin to start the market in Settings.'}</p>
      ${isAdmin() ? `<button class="btn" data-action="nav" data-view="settings">Go to Settings</button>` : ''}</div>`;
  }
  switch (state.view) {
    case 'checkin': return checkInView();
    case 'team': return teamView();
    case 'log': return logView();
    case 'settings': return settingsView();
    default: return floorView();
  }
}

function activeVisits() { return D().visits.filter(v => !v.checked_out_at); }

function floorView() {
  const here = activeVisits().sort(byTime('checked_in_at'));
  const counts = { with: 0, otw: 0, paging: 0, waiting: 0 };
  here.forEach(v => counts[statusOf(v).k]++);
  const mine = new Set(myDivs());

  const pagesForMe = here.flatMap(v => [...openPages(v), ...onTheWay(v)].filter(p => mine.has(p.division_id)).map(p => ({ v, p })));
  const pagesBanner = pagesForMe.length ? `
    <section class="pages-banner">
      <h3>📟 Paging your division${mine.size > 1 ? 's' : ''}</h3>
      ${pagesForMe.map(({ v, p }) => `
        <div class="page-row">
          <div><b>${esc(dealerOf(v).name)}</b> → ${esc(divName(p.division_id))}
            <div class="muted small">${p.claimed_at ? `${esc(memName(p.claimed_by))} is on the way` : `Waiting ${timer(p.requested_at)} · sent by ${esc(memName(p.requested_by))}`}</div></div>
          <div class="row-actions">
            ${p.claimed_at ? '' : `<button class="btn small ghost" data-action="claim" data-page="${p.id}">On my way</button>`}
            <button class="btn small" data-action="take" data-page="${p.id}">Start walk</button>
          </div>
        </div>`).join('')}
    </section>` : '';

  const inbox = inboxItems();
  const inboxBanner = inbox.length ? `
    <section class="inbox-banner">
      <h3>📱 Check-in texts to review <span class="muted small">— the app couldn't confirm these on its own</span></h3>
      ${inbox.map(m => `
        <form class="inbox-row" data-msg="${m.id}">
          <blockquote>${esc(m.body)}<cite>${esc(m.from_number || m.channel)} · ${clock(m.received_at)}</cite></blockquote>
          <div class="inbox-fields">
            <input name="dealer" id="ib-d-${m.id}" placeholder="Dealer name" value="${esc(m.parsed_dealer || '')}" list="dealer-list-ib" required aria-label="Dealer name">
            <input name="party" id="ib-p-${m.id}" placeholder="Who's with them" value="${esc(m.parsed_party || '')}" aria-label="Who's with them">
          </div>
          <div class="row-actions">
            <button class="btn small primary" type="submit">Check in</button>
            <button class="btn small ghost" type="button" data-action="ignore-msg" data-msg="${m.id}">Ignore</button>
          </div>
        </form>`).join('')}
      <datalist id="dealer-list-ib">${D().dealers.map(d => `<option value="${esc(d.name)}">`).join('')}</datalist>
    </section>` : '';

  let list = here;
  if (state.filter !== 'all') list = list.filter(v => statusOf(v).k === state.filter);
  if (state.mineOnly) list = list.filter(v => {
    const s = statusOf(v);
    return v.requested_rep_id === state.me?.id || (s.walk && mine.has(s.walk.division_id)) || [...openPages(v), ...onTheWay(v)].some(p => mine.has(p.division_id));
  });
  if (state.search) list = list.filter(v => (dealerOf(v).name + ' ' + (v.party || '') + ' ' + (dealerOf(v).account_number || '')).toLowerCase().includes(state.search.toLowerCase()));

  const chip = (k, label, n) => `<button class="fchip ${state.filter === k ? 'on' : ''} s-${k}" data-action="filter" data-filter="${k}">${label} <b>${n}</b></button>`;
  return `
    ${pagesBanner}
    ${inboxBanner}
    <div class="filters">
      ${chip('all', 'Here', here.length)}${chip('with', 'Walking', counts.with)}${chip('paging', 'Paging', counts.paging)}${chip('otw', 'On the way', counts.otw)}${chip('waiting', 'Waiting', counts.waiting)}
    </div>
    <div class="toolbar">
      <input type="search" id="search" placeholder="Search dealer, account, party" value="${esc(state.search)}">
      ${mine.size ? `<label class="toggle"><input type="checkbox" data-action="mine" ${state.mineOnly ? 'checked' : ''}> Mine</label>` : ''}
      <button class="btn" data-action="nav" data-view="checkin">+ Check in</button>
    </div>
    ${list.length ? `<div class="cards">${list.map(dealerCard).join('')}</div>`
      : `<div class="empty"><p>${here.length ? 'No dealers match this filter.' : 'No dealers on the floor yet.'}</p></div>`}`;
}

function divChips(v) {
  const seen = seenDivIds(v), cur = openWalk(v);
  const paged = new Set([...openPages(v), ...onTheWay(v)].map(p => p.division_id));
  return D().divs.map(d => {
    let cls = 'none', icon = '';
    if (cur?.division_id === d.id) { cls = 'cur'; icon = '●'; }
    else if (paged.has(d.id)) { cls = 'paged'; icon = '🔔'; }
    else if (seen.has(d.id)) { cls = 'seen'; icon = '✓'; }
    return `<span class="dchip ${cls}" style="--c:${esc(d.color)}" title="${esc(d.name)}">${icon ? `<i>${icon}</i>` : ''}${esc(d.name)}</span>`;
  }).join('');
}

function dealerCard(v) {
  const s = statusOf(v), dealer = dealerOf(v);
  const done = walksOf(v).filter(w => w.ended_at);
  return `
    <article class="card st-${s.k}">
      <div class="card-top">
        <div>
          <h3>${esc(dealer.name)}${v.source === 'text' ? ' <span class="tag" title="Checked in from a text message">via text</span>' : ''}</h3>
          <div class="muted small">${[dealer.account_number && '#' + esc(dealer.account_number), v.party && esc(v.party), 'In at ' + clock(v.checked_in_at)].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="total" title="Total time in showroom">${timer(v.checked_in_at)}<span>in showroom</span></div>
      </div>
      ${v.requested_rep_name || v.meet_location ? `<div class="asked small">Asked for <b>${esc(v.requested_rep_id ? memName(v.requested_rep_id) : v.requested_rep_name || 'anyone')}</b>${v.meet_location ? ` · at ${esc(v.meet_location)}` : ''}</div>` : ''}
      <div class="status">
        <span class="badge b-${s.k}">${esc(s.label)}</span>
        ${s.sub ? `<span class="muted">${esc(s.sub)}</span>` : ''}
        <span class="since">${timer(s.since)}</span>
      </div>
      <div class="dchips">${divChips(v)}</div>
      ${done.length ? `<div class="history small muted">${done.map(w => `${esc(divName(w.division_id))} ${mins(w.started_at, w.ended_at)} (${esc(memName(w.rep_id).split(' ')[0])})`).join(' → ')}</div>` : ''}
      <div class="actions">
        ${s.walk
          ? `<button class="btn primary" data-action="finish" data-visit="${v.id}">✓ Finished ${esc(divName(s.walk.division_id))}</button>`
          : `<button class="btn primary" data-action="start" data-visit="${v.id}">Start walk</button>`}
        <button class="btn ghost" data-action="page" data-visit="${v.id}">📟 Page</button>
        <button class="btn ghost" data-action="more" data-visit="${v.id}" aria-label="More">⋯</button>
      </div>
    </article>`;
}

const setting = key => (D().app_settings || []).find(r => r.key === key)?.value || '';
const newToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, c => ({ '+': 'x', '/': 'y', '=': '' }[c]));
};

function shortcutSteps() {
  const token = setting('inbound_token');
  const url = store.functionUrl('inbound-checkin');
  return `
    <ol class="steps small">
      <li>Open <b>Shortcuts</b> → <b>Automation</b> → <b>+</b> → <b>Message</b>.</li>
      <li><b>Sender</b> → Choose → <b>High Point/Las Vegas</b> (274-539). <b>Message Contains</b>: <code>Meet</code>.</li>
      <li>Pick <b>Run Immediately</b>, turn off <i>Notify When Run</i>, tap <b>Next</b> → <b>New Blank Automation</b>.</li>
      <li>Add <b>Get Contents of URL</b>. Paste this address:
        <div class="copyrow"><code>${esc(url)}</code><button class="btn small ghost" type="button" data-action="copy" data-copy="${esc(url)}">Copy</button></div></li>
      <li>Tap ▸ to show more. <b>Method</b>: POST. <b>Headers</b>: add <code>x-pager-token</code> with this value:
        ${token
          ? `<div class="copyrow"><code>${esc(token)}</code><button class="btn small ghost" type="button" data-action="copy" data-copy="${esc(token)}">Copy</button></div>`
          : `<div class="warn-text">No check-in password yet. ${isAdmin() ? 'Create one in Settings → Check-in texts.' : 'Ask an admin to create one in Settings.'}</div>`}</li>
      <li><b>Request Body</b>: JSON. Add a <i>Text</i> field named <code>text</code>, set it to <i>Shortcut Input</i>, tap it and choose <b>Content</b>. Tap <b>Done</b>.</li>
    </ol>`;
}

// First login: confirm details, opt in (or not) to texts, set up this phone.
function setupView() {
  const m = state.me, mine = divsOfMember(m.id);
  const first = (m.full_name || '').split(' ')[0];
  return `
    <div class="setup">
      <header class="setup-head">
        <div class="logo big" aria-hidden="true">📟</div>
        <h1>Welcome${first ? `, ${esc(first)}` : ''}</h1>
        <p class="muted">Set up Market Pager on this phone. It takes about two minutes.</p>
      </header>
      <form id="setup-form" class="form">
        <section class="panel">
          <h2><span class="num">1</span> You</h2>
          <label>Your name<input name="full_name" id="su-name" value="${esc(m.full_name)}" required autocomplete="name"></label>
          <label>Cell number<input name="phone" id="su-phone" type="tel" value="${esc(m.phone || '')}" placeholder="(252) 555-0100" autocomplete="tel"></label>
          <p class="small muted">Signed in as ${esc(m.email)}</p>
        </section>

        <section class="panel">
          <h2><span class="num">2</span> Divisions you cover</h2>
          <p class="small muted">You'll be paged when a dealer is ready for these.</p>
          <div class="pick">${D().divs.map(d => `<label class="pchip" style="--c:${esc(d.color)}"><input type="checkbox" name="div" value="${d.id}" ${mine.includes(d.id) ? 'checked' : ''}><span>${esc(d.name)}</span></label>`).join('')}</div>
        </section>

        <section class="panel">
          <h2><span class="num">3</span> Text alerts</h2>
          <label class="consent"><input type="checkbox" name="sms" id="su-sms" ${m.sms_consent_at ? 'checked' : ''}>
            <span>${esc(CONSENT_TEXT)}</span></label>
          <label class="toggle"><input type="checkbox" name="email" id="su-email" ${m.notify_email !== false ? 'checked' : ''}> Also email me pages</label>
          <p class="small muted">Without texts you still get pages on the board and as an alert in the app while it's open.</p>
        </section>

        <section class="panel">
          <h2><span class="num">4</span> This phone</h2>
          <button class="btn" type="button" data-action="alerts">🔔 ${audioCtx ? 'Alerts are on. Test the sound' : 'Turn on sound alerts'}</button>
          <p class="small"><b>Add to your home screen</b> so it opens like an app. iPhone: tap <b>Share</b> → <b>Add to Home Screen</b>. Android: tap <b>⋮</b> → <b>Add to Home screen</b>.</p>
        </section>

        <section class="panel">
          <h2><span class="num">5</span> Market check-in texts <span class="muted small">(iPhone, optional)</span></h2>
          <p class="small">When the market texts you “Meet … at Front Desk”, your iPhone can put the dealer on the board automatically. Set it up once:</p>
          ${shortcutSteps()}
          <p class="small muted">You can skip this now. The steps are also in Settings.</p>
        </section>

        <button class="btn primary big" type="submit">Finish setup</button>
        ${state.forceSetup ? `<button class="btn ghost" type="button" data-action="cancel-setup">Cancel</button>` : ''}
      </form>
    </div>`;
}

function checkInView() {
  const dealers = [...D().dealers].sort((a, b) => a.name.localeCompare(b.name));
  return `
    <section class="panel narrow">
      <h2>Check in a dealer</h2>
      <div class="paste">
        <div class="paste-head">
          <label for="paste-text">📱 Market check-in text</label>
          <button class="btn small" type="button" data-action="paste-clip">📋 Paste text</button>
        </div>
        <textarea id="paste-text" rows="3" placeholder="Paste the market's text, e.g. J.R. MOORE – Meet SHELBY SARI from FURNITURELAND SOUTH at Front Desk"></textarea>
        <div id="paste-result" class="small" aria-live="polite"><span class="muted">The form below fills in as soon as you paste.</span></div>
        ${store.kind === 'demo' ? `<div class="row-actions"><button class="btn small ghost" type="button" data-action="simulate-text">Simulate it arriving by text (auto check-in)</button></div>` : ''}
      </div>
      <form id="checkin-form" class="form">
        <label>Dealer name<input name="name" id="ci-name" list="dealer-list" required autocomplete="off" placeholder="Start typing — returning dealers autofill"></label>
        <datalist id="dealer-list">${dealers.map(d => `<option value="${esc(d.name)}">`).join('')}</datalist>
        <div class="grid3">
          <label>Account #<input name="account" id="ci-account" autocomplete="off"></label>
          <label>City<input name="city" id="ci-city" autocomplete="off"></label>
          <label>State<input name="st" id="ci-st" maxlength="2" autocomplete="off"></label>
        </div>
        <label>Who's with them<input name="party" id="ci-party" placeholder="e.g. Owner + 2 buyers" autocomplete="off"></label>
        <div class="grid2">
          <label>Asked for<select name="asked" id="ci-asked"><option value="">No one in particular</option>${[...D().team_members].filter(m => m.active).sort((a, b) => a.full_name.localeCompare(b.full_name)).map(m => `<option value="${m.id}">${esc(m.full_name)}</option>`).join('')}</select></label>
          <label>Waiting at<input name="location" id="ci-location" placeholder="e.g. Front Desk" autocomplete="off"></label>
        </div>
        <input type="hidden" name="asked_name" id="ci-asked-name">
        <input type="hidden" name="source" id="ci-source" value="app">
        <label>Notes<textarea name="notes" id="ci-notes" rows="2" placeholder="Priorities, open-to-buy, programs to show…"></textarea></label>
        <fieldset>
          <legend>Page a division now? <span class="muted">(optional)</span></legend>
          <div class="pick">${D().divs.map(d => `<label class="pchip" style="--c:${esc(d.color)}"><input type="checkbox" name="div" value="${d.id}"><span>${esc(d.name)}</span></label>`).join('')}</div>
        </fieldset>
        <button class="btn primary big" type="submit">Check in</button>
      </form>
    </section>`;
}

function teamView() {
  const members = [...D().team_members].sort((a, b) => a.full_name.localeCompare(b.full_name));
  const admin = isAdmin();
  return `
    <section class="panel">
      <div class="panel-head">
        <h2>Team <span class="muted">(${members.filter(m => m.active).length} active)</span></h2>
        ${admin ? `<div class="row-actions"><button class="btn ghost" data-action="import">Import CSV</button><button class="btn" data-action="member" data-id="">+ Add</button></div>` : ''}
      </div>
      ${D().divs.map(d => {
        const ms = membersOfDiv(d.id);
        return `<div class="divline"><span class="dchip cur" style="--c:${esc(d.color)}">${esc(d.name)}</span> <span class="muted small">${ms.length ? ms.map(m => esc(m.full_name)).join(', ') : 'No one assigned — pages will not reach anyone'}</span></div>`;
      }).join('')}
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Name</th><th>Divisions</th><th>Cell</th><th>Email</th><th>Alerts</th>${admin ? '<th></th>' : ''}</tr></thead>
        <tbody>${members.map(m => `
          <tr class="${m.active ? '' : 'inactive'}">
            <td><b>${esc(m.full_name)}</b>${m.role === 'admin' ? ' <span class="tag">admin</span>' : ''}${m.active ? '' : ' <span class="tag">inactive</span>'}</td>
            <td>${divsOfMember(m.id).map(id => `<span class="dchip cur sm" style="--c:${esc(D().div[id]?.color)}">${esc(divName(id))}</span>`).join(' ')}</td>
            <td>${m.phone ? `<a href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : '<span class="muted">—</span>'}</td>
            <td>${esc(m.email)}</td>
            <td class="small">${m.sms_consent_at && m.notify_sms ? `Texts ✓` : `<span class="muted">${m.onboarded_at ? 'No texts' : 'Not set up yet'}</span>`}${m.notify_email ? ' · Email' : ''}</td>
            ${admin ? `<td><button class="btn small ghost" data-action="member" data-id="${m.id}">Edit</button></td>` : ''}
          </tr>`).join('')}</tbody>
      </table></div>
    </section>`;
}

function logRows() {
  // One row per division walk; dealers who never walked still get a row.
  const rows = [];
  const visits = [...D().visits].sort(byTime('checked_in_at'));
  for (const v of visits) {
    const d = dealerOf(v), walks = walksOf(v);
    const base = { market: D().market?.name, dealer: d.name, account: d.account_number || '', party: v.party || '',
      asked_for: v.requested_rep_id ? memName(v.requested_rep_id) : v.requested_rep_name || '', source: v.source || 'app', checked_in: v.checked_in_at, checked_out: v.checked_out_at || '', showroom_min: minutes(v.checked_in_at, v.checked_out_at) };
    if (!walks.length) rows.push({ ...base, division: '', rep: '', started: '', ended: '', division_min: '' });
    for (const w of walks) rows.push({ ...base, division: divName(w.division_id), rep: memName(w.rep_id), started: w.started_at, ended: w.ended_at || '', division_min: minutes(w.started_at, w.ended_at) });
  }
  return rows;
}

function logView() {
  const visits = [...D().visits].sort((a, b) => ts(b.checked_in_at) - ts(a.checked_in_at));
  const walks = D().walkthroughs.filter(w => w.ended_at && visits.some(v => v.id === w.visit_id));
  const summary = D().divs.map(d => {
    const ws = walks.filter(w => w.division_id === d.id);
    const dealers = new Set(ws.map(w => w.visit_id)).size;
    const avg = ws.length ? ws.reduce((s, w) => s + minutes(w.started_at, w.ended_at), 0) / ws.length : 0;
    return { d, dealers, avg };
  });
  const closed = visits.filter(v => v.checked_out_at);
  const avgVisit = closed.length ? closed.reduce((s, v) => s + minutes(v.checked_in_at, v.checked_out_at), 0) / closed.length : 0;
  return `
    <section class="panel">
      <div class="panel-head"><h2>Market log</h2><button class="btn" data-action="export">⬇ Export CSV (Excel)</button></div>
      <div class="kpis">
        <div class="kpi"><b>${visits.length}</b><span>dealers checked in</span></div>
        <div class="kpi"><b>${activeVisits().length}</b><span>on the floor now</span></div>
        <div class="kpi"><b>${avgVisit ? Math.round(avgVisit) + 'm' : '—'}</b><span>avg. visit (checked out)</span></div>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Division</th><th class="num">Dealers seen</th><th class="num">Avg. minutes</th><th class="num">Reach</th></tr></thead>
        <tbody>${summary.map(({ d, dealers, avg }) => `<tr><td><span class="dchip cur sm" style="--c:${esc(d.color)}">${esc(d.name)}</span></td><td class="num">${dealers}</td><td class="num">${dealers ? avg.toFixed(1) : '—'}</td><td class="num">${visits.length ? Math.round(dealers / visits.length * 100) + '%' : '—'}</td></tr>`).join('')}</tbody>
      </table></div>
      <h3>Visits</h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Dealer</th><th>In</th><th>Out</th><th class="num">Total</th><th>Path</th></tr></thead>
        <tbody>${visits.map(v => `
          <tr>
            <td><b>${esc(dealerOf(v).name)}</b>${v.party ? `<div class="muted small">${esc(v.party)}</div>` : ''}</td>
            <td>${stamp(v.checked_in_at)}</td>
            <td>${v.checked_out_at ? stamp(v.checked_out_at) : '<span class="badge b-with">Here</span>'}</td>
            <td class="num">${timer(v.checked_in_at, v.checked_out_at)}</td>
            <td class="small">${walksOf(v).map(w => `${esc(divName(w.division_id))} · ${esc(memName(w.rep_id))} · ${w.ended_at ? mins(w.started_at, w.ended_at) : 'now'}`).join('<br>') || '<span class="muted">—</span>'}</td>
          </tr>`).join('') || '<tr><td colspan="5" class="muted">No visits yet.</td></tr>'}</tbody>
      </table></div>
    </section>`;
}

function settingsView() {
  const markets = [...D().markets].sort((a, b) => ts(b.created_at || 0) - ts(a.created_at || 0));
  return `
    <section class="panel narrow">
      <h2>Market</h2>
      ${D().market ? `<p>Active: <b>${esc(D().market.name)}</b></p>` : '<p class="muted">No market is active.</p>'}
      ${isAdmin() ? `
        <form id="market-form" class="form inline">
          <input name="name" placeholder="e.g. Las Vegas Winter 2027" required>
          <button class="btn" type="submit">Start new market</button>
        </form>
        ${markets.length > 1 ? `<label class="field">Switch active market
          <select id="market-switch">${markets.map(m => `<option value="${m.id}" ${m.is_active ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>` : ''}` : ''}

      <h2>Divisions</h2>
      <div class="dchips">${D().divs.map(d => `<span class="dchip cur" style="--c:${esc(d.color)}">${esc(d.name)}</span>`).join('')}</div>
      ${isAdmin() ? `<form id="division-form" class="form inline">
        <input name="name" placeholder="Add a division (e.g. Outdoor)" required>
        <input name="color" type="color" value="#0891b2" aria-label="Color">
        <button class="btn" type="submit">Add</button></form>` : ''}

      <h2>You</h2>
      ${store.kind === 'demo' ? `
        <label class="field">Acting as (demo)
          <select id="act-as">${D().team_members.map(m => `<option value="${m.id}" ${state.me?.id === m.id ? 'selected' : ''}>${esc(m.full_name)}</option>`).join('')}</select></label>`
      : `<p>Signed in as <b>${esc(state.session?.user?.email)}</b></p><button class="btn ghost" data-action="signout">Sign out</button>`}
      <button class="btn ghost small" data-action="redo-setup">Run first-login setup again</button>
      <p class="small muted">Alerts: ${audioCtx ? 'sound on' : 'tap “Enable alerts” at the top so this phone beeps when your division is paged'}${'Notification' in window ? ` · system notifications ${Notification.permission}` : ''}.</p>

      <h2>Check-in texts</h2>
      <p class="small">Each rep's iPhone sends the market's check-in texts to the app. ${isAdmin() ? 'The password below goes in every rep\'s Shortcut. Create a new one if it leaks, then have reps update their Shortcut.' : ''}</p>
      ${isAdmin() ? `<div class="row-actions"><button class="btn small ${setting('inbound_token') ? 'ghost' : ''}" data-action="new-token">${setting('inbound_token') ? 'Create new password' : 'Create check-in password'}</button></div>` : ''}
      ${shortcutSteps()}

      <h2>Connection</h2>
      <form id="conn-form" class="form">
        <label class="toggle"><input type="radio" name="mode" value="demo" ${store.kind === 'demo' ? 'checked' : ''}> Demo (this browser only)</label>
        <label class="toggle"><input type="radio" name="mode" value="supabase" ${store.kind === 'supabase' ? 'checked' : ''}> Supabase (whole team, live + texts)</label>
        <label>Supabase URL<input name="url" value="${esc(cfg.url || '')}" placeholder="https://xxxx.supabase.co"></label>
        <label>Anon (public) key<input name="key" value="${esc(cfg.key || '')}" placeholder="eyJ…"></label>
        <div class="row-actions"><button class="btn" type="submit">Save & reload</button>
        ${store.kind === 'demo' ? `<button class="btn ghost" type="button" data-action="reset-demo">Reset demo data</button>` : ''}</div>
      </form>
    </section>`;
}

function loginView() {
  return `
    <div class="login">
      <div class="logo big" aria-hidden="true">📟</div>
      <h1>Market Pager</h1>
      ${state.loginSent ? `
        <p>Check <b>${esc(state.loginEmail)}</b> for a sign-in link — or enter the 6-digit code from the email.</p>
        <form id="code-form" class="form"><input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="123456" required><button class="btn primary big">Sign in</button></form>
        <button class="btn ghost" data-action="login-back">Use a different email</button>`
      : `
        <p class="muted">Sign in with the email on the team list.</p>
        <form id="login-form" class="form"><input name="email" type="email" required autocomplete="email" placeholder="you@company.com" value="${esc(state.loginEmail)}"><button class="btn primary big">Email me a sign-in link</button></form>`}
      <button class="btn ghost small" data-action="nav" data-view="settings-anon">Connection settings</button>
    </div>`;
}

function notMemberView() {
  return `<div class="login"><h1>Not on the team list</h1>
    <p><b>${esc(state.session?.user?.email)}</b> is signed in, but isn't on this market's team list. Ask an admin to add this email, then reload.</p>
    <button class="btn" data-action="signout">Sign out</button></div>`;
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------
function openModal(html, onMount) {
  const root = $('#modal');
  root.innerHTML = `<div class="backdrop" data-action="close-modal"></div><div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
  root.hidden = false;
  onMount?.(root);
}
// In-app confirmation (browser confirm() is unreliable on phones and in embedded views).
function confirmModal(message, okLabel, onOk) {
  openModal(`<h2>${esc(message)}</h2>
    <div class="sheet-actions"><button class="btn primary big danger-fill" id="confirm-ok">${esc(okLabel)}</button>
    <button class="btn ghost" data-action="close-modal">Cancel</button></div>`, root => {
    $('#confirm-ok', root).addEventListener('click', () => { closeModal(); onOk(); });
  });
}

// Show CSV with Download + Copy, since some browsers block direct downloads.
function csvModal(name, text) {
  openModal(`<h2>${esc(name)}</h2>
    <textarea id="csv-out" rows="10" readonly>${esc(text)}</textarea>
    <div class="sheet-actions"><button class="btn primary" id="csv-dl">Download .csv</button>
    <button class="btn ghost" id="csv-copy">Copy (paste into Excel)</button>
    <button class="btn ghost" data-action="close-modal">Close</button></div>`, root => {
    $('#csv-dl', root).addEventListener('click', () => download(name, text));
    $('#csv-copy', root).addEventListener('click', () => {
      navigator.clipboard?.writeText(text).then(() => toast('Copied — paste into Excel'))
        .catch(() => { $('#csv-out', root).select(); toast('Selected — press copy', 'warn'); });
    });
  });
}

function closeModal() { const r = $('#modal'); r.hidden = true; r.innerHTML = ''; }

// "Where to next?" — multi-select, seen divisions grayed out.
function nextModal(v, { finishing }) {
  const seen = seenDivIds(v), cur = openWalk(v);
  const paging = new Set([...openPages(v), ...onTheWay(v)].map(p => p.division_id));
  const walkInfo = id => { const w = walksOf(v).filter(w => w.division_id === id).pop(); return w ? `${mins(w.started_at, w.ended_at)} with ${memName(w.rep_id).split(' ')[0]}` : ''; };
  openModal(`
    <h2>${finishing ? `Finished ${esc(divName(cur?.division_id))} with ${esc(dealerOf(v).name)}` : `Page for ${esc(dealerOf(v).name)}`}</h2>
    ${finishing && cur ? `<p class="muted">Time in ${esc(divName(cur.division_id))}: <b>${dur(cur.started_at)}</b></p>` : ''}
    <h3>Where to next? <span class="muted small">Select all that apply</span></h3>
    <form id="next-form">
      <div class="pick big">${D().divs.map(d => {
        const isSeen = seen.has(d.id) && !(cur?.division_id === d.id && !finishing);
        const isPaging = paging.has(d.id);
        const disabled = isSeen || isPaging || cur?.division_id === d.id;
        const note = cur?.division_id === d.id && !finishing ? 'With them now' : isSeen ? `Seen · ${walkInfo(d.id)}` : isPaging ? 'Already paged' : `${membersOfDiv(d.id).length} on team`;
        return `<label class="pchip ${disabled ? 'disabled' : ''}" style="--c:${esc(d.color)}">
          <input type="checkbox" name="div" value="${d.id}" ${disabled ? 'disabled' : ''}>
          <span>${isSeen ? '✓ ' : ''}${esc(d.name)}<small>${esc(note)}</small></span></label>`;
      }).join('')}</div>
      <div class="sheet-actions">
        <button class="btn primary big" type="submit" name="act" value="page">📟 Page selected</button>
        ${finishing ? `<button class="btn ghost" type="submit" name="act" value="none">No page — they'll wait</button>
        <button class="btn ghost danger" type="submit" name="act" value="checkout">They're done — check out</button>` : `<button class="btn ghost" type="button" data-action="close-modal">Cancel</button>`}
      </div>
    </form>`, root => {
    $('#next-form', root).addEventListener('submit', async e => {
      e.preventDefault();
      const act = e.submitter?.value || 'page';
      const divs = $$('input[name=div]:checked', root).map(i => i.value);
      if (act === 'page' && !divs.length) { toast('Pick at least one division to page', 'warn'); return; }
      closeModal();
      await run(async () => {
        if (finishing) await finishWalk(v);
        if (act === 'checkout') { await checkOut(v); toast(`${dealerOf(v).name} checked out`); }
        if (act === 'page') { await reload(); await pageDivisions(v, divs); }
      });
    });
  });
}

function startModal(v, presetDiv, presetRep) {
  const seen = seenDivIds(v);
  const waiting = new Set([...openPages(v), ...onTheWay(v)].map(p => p.division_id));
  const mine = myDivs();
  const first = presetDiv || [...waiting][0] || D().divs.find(d => mine.includes(d.id) && !seen.has(d.id))?.id || D().divs.find(d => !seen.has(d.id))?.id;
  const repOptions = divId => {
    const inDiv = membersOfDiv(divId);
    const others = D().team_members.filter(m => m.active && !inDiv.includes(m));
    const sel = presetRep || (inDiv.some(m => m.id === state.me?.id) ? state.me.id : inDiv[0]?.id || state.me?.id);
    const opt = m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.full_name)}</option>`;
    return `<optgroup label="${esc(divName(divId))}">${inDiv.map(opt).join('')}</optgroup>${others.length ? `<optgroup label="Other team">${others.map(opt).join('')}</optgroup>` : ''}`;
  };
  openModal(`
    <h2>Start walk · ${esc(dealerOf(v).name)}</h2>
    <form id="start-form">
      <h3>Division</h3>
      <div class="pick big">${D().divs.map(d => `
        <label class="pchip ${seen.has(d.id) ? 'seen' : ''}" style="--c:${esc(d.color)}">
          <input type="radio" name="div" value="${d.id}" ${d.id === first ? 'checked' : ''}>
          <span>${seen.has(d.id) ? '✓ ' : ''}${esc(d.name)}<small>${seen.has(d.id) ? 'Revisit' : waiting.has(d.id) ? 'Paged' : ''}</small></span></label>`).join('')}</div>
      <label class="field">Rep walking them<select name="rep" id="rep-select">${repOptions(first)}</select></label>
      <div class="sheet-actions">
        <button class="btn primary big" type="submit">Start timer</button>
        <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
      </div>
    </form>`, root => {
    $$('input[name=div]', root).forEach(r => r.addEventListener('change', () => { $('#rep-select', root).innerHTML = repOptions(r.value); }));
    $('#start-form', root).addEventListener('submit', async e => {
      e.preventDefault();
      const div = $('input[name=div]:checked', root)?.value;
      if (!div) { toast('Pick a division', 'warn'); return; }
      const rep = $('#rep-select', root).value;
      closeModal();
      await run(() => startWalk(v, div, rep), `${dealerOf(v).name} is with ${divName(div)} — timer running`);
    });
  });
}

function moreModal(v) {
  openModal(`
    <h2>${esc(dealerOf(v).name)}</h2>
    ${(D().inbound_messages || []).filter(m => m.visit_id === v.id).map(m => `<blockquote class="quote">${esc(m.body)}<cite>Check-in text · ${clock(m.received_at)}</cite></blockquote>`).join('')}
    <form id="edit-visit" class="form">
      <label>Who's with them<input name="party" value="${esc(v.party || '')}"></label>
      <label>Notes<textarea name="notes" rows="3">${esc(v.notes || '')}</textarea></label>
      <button class="btn" type="submit">Save</button>
    </form>
    ${pagesOf(v).filter(p => !fulfilled(v, p)).length ? `<h3>Open pages</h3>${pagesOf(v).filter(p => !fulfilled(v, p)).map(p => `
      <div class="page-row"><div>${esc(divName(p.division_id))} <span class="muted small">${p.claimed_at ? esc(memName(p.claimed_by)) + ' on the way' : 'waiting ' + dur(p.requested_at)}</span></div>
      <div class="row-actions"><button class="btn small ghost" data-action="repage" data-page="${p.id}">Re-send</button><button class="btn small ghost" data-action="cancel-page" data-page="${p.id}">Cancel</button></div></div>`).join('')}` : ''}
    <div class="sheet-actions">
      <button class="btn ghost danger" data-action="checkout" data-visit="${v.id}">Check out dealer</button>
      <button class="btn ghost" data-action="close-modal">Close</button>
    </div>`, root => {
    $('#edit-visit', root).addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      closeModal();
      await run(() => store.update('visits', v.id, { party: f.get('party') || null, notes: f.get('notes') || null }), 'Saved');
    });
  });
}

function memberModal(id) {
  const m = id ? D().mem[id] : { full_name: '', email: '', phone: '', role: 'rep', notify_sms: true, notify_email: true, active: true };
  const divs = id ? divsOfMember(id) : [];
  openModal(`
    <h2>${id ? 'Edit' : 'Add'} team member</h2>
    <form id="member-form" class="form">
      <label>Name<input name="full_name" value="${esc(m.full_name)}" required></label>
      <label>Email<input name="email" type="email" value="${esc(m.email)}" required></label>
      <label>Cell<input name="phone" type="tel" value="${esc(m.phone || '')}" placeholder="(336) 555-0100"></label>
      <fieldset><legend>Divisions they get paged for</legend>
        <div class="pick">${D().divs.map(d => `<label class="pchip" style="--c:${esc(d.color)}"><input type="checkbox" name="div" value="${d.id}" ${divs.includes(d.id) ? 'checked' : ''}><span>${esc(d.name)}</span></label>`).join('')}</div></fieldset>
      <div class="grid3">
        <label class="toggle" title="Texts also need the rep's own opt-in at first login"><input type="checkbox" name="notify_sms" ${m.notify_sms ? 'checked' : ''}> Text${m.sms_consent_at ? '' : ' <span class="muted small">(needs their opt-in)</span>'}</label>
        <label class="toggle"><input type="checkbox" name="notify_email" ${m.notify_email ? 'checked' : ''}> Email</label>
        <label class="toggle"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> Active</label>
      </div>
      <label class="field">Role<select name="role"><option value="rep" ${m.role === 'rep' ? 'selected' : ''}>Rep</option><option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin (manages team & markets)</option></select></label>
      <div class="sheet-actions">
        <button class="btn primary" type="submit">Save</button>
        ${id ? `<button class="btn ghost danger" type="button" data-action="delete-member" data-id="${id}">Remove</button>` : ''}
        <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
      </div>
    </form>`, root => {
    $('#member-form', root).addEventListener('submit', async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const row = {
        full_name: f.get('full_name').trim(), email: f.get('email').trim().toLowerCase(), phone: normalizePhone(f.get('phone')) || null,
        role: f.get('role'), notify_sms: !!f.get('notify_sms'), notify_email: !!f.get('notify_email'), active: !!f.get('active'),
      };
      closeModal();
      await run(() => saveMember(id, row, f.getAll('div')), 'Team member saved');
    });
  });
}

async function saveMember(id, row, divIds) {
  let memberId = id;
  if (id) await store.update('team_members', id, row);
  else {
    const dupe = D().team_members.find(t => t.email.toLowerCase() === row.email);
    if (dupe) { memberId = dupe.id; await store.update('team_members', dupe.id, row); }
    else [{ id: memberId }] = await store.insert('team_members', { ...row, created_at: nowIso() });
  }
  await store.remove('member_divisions', { member_id: memberId });
  if (divIds.length) await store.insert('member_divisions', divIds.map(division_id => ({ member_id: memberId, division_id })));
}

function importModal() {
  openModal(`
    <h2>Import team</h2>
    <p class="small muted">Paste from Excel or upload a CSV. Columns: <b>Name, Email, Cell, Divisions, Role</b>. Separate multiple divisions with <code>;</code> (e.g. <code>Motion; Stationary</code>). Existing emails are updated, not duplicated.</p>
    <form id="import-form" class="form">
      <input type="file" id="import-file" accept=".csv,.txt,text/csv">
      <textarea id="import-text" rows="8" placeholder="Name,Email,Cell,Divisions,Role&#10;Jordan Moore,jordan@company.com,336-555-0101,Motion,admin&#10;Avery Lee,avery@company.com,336-555-0102,Motion; Stationary,rep"></textarea>
      <div id="import-preview" class="small"></div>
      <div class="sheet-actions">
        <button class="btn primary" type="submit">Import</button>
        <button class="btn ghost" type="button" data-action="template">Download template</button>
        <button class="btn ghost" type="button" data-action="close-modal">Cancel</button>
      </div>
    </form>`, root => {
    const ta = $('#import-text', root);
    const preview = () => {
      const { people, problems } = readTeamCsv(ta.value);
      $('#import-preview', root).innerHTML = ta.value.trim()
        ? `<p><b>${people.length}</b> people ready.</p>${problems.length ? `<ul class="warnlist">${problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}` : '';
    };
    ta.addEventListener('input', preview);
    $('#import-file', root).addEventListener('change', async e => { ta.value = await e.target.files[0]?.text() || ''; preview(); });
    $('#import-form', root).addEventListener('submit', async e => {
      e.preventDefault();
      const { people } = readTeamCsv(ta.value);
      if (!people.length) { toast('Nothing to import', 'warn'); return; }
      closeModal();
      await run(async () => {
        for (const p of people) { await saveMember(null, p.row, p.divIds); await reload(); }
      }, `Imported ${people.length} team members`);
    });
  });
}

function readTeamCsv(text) {
  const rows = parseCsv(text || '');
  const problems = [], people = [];
  if (!rows.length) return { people, problems };
  const head = rows[0].map(h => h.toLowerCase());
  const hasHeader = head.some(h => /name|email|mail/.test(h));
  const col = (re, fallback) => { const i = head.findIndex(h => re.test(h)); return hasHeader ? i : fallback; };
  const ci = { name: col(/name/, 0), email: col(/mail/, 1), phone: col(/cell|phone|mobile|number/, 2), divs: col(/div/, 3), role: col(/role/, 4) };
  const byName = Object.fromEntries(D().divs.map(d => [d.name.toLowerCase(), d.id]));
  for (const [i, r] of (hasHeader ? rows.slice(1) : rows).entries()) {
    const line = i + (hasHeader ? 2 : 1);
    const name = r[ci.name] || '', email = (r[ci.email] || '').toLowerCase();
    if (!name || !/@/.test(email)) { problems.push(`Row ${line}: needs a name and email — skipped`); continue; }
    const divIds = [];
    for (const dn of (r[ci.divs] || '').split(/[;|/]/).map(s => s.trim()).filter(Boolean)) {
      const id = byName[dn.toLowerCase()];
      if (id) divIds.push(id); else problems.push(`Row ${line}: unknown division “${dn}” (add it in Settings first)`);
    }
    const role = /admin/i.test(r[ci.role] || '') ? 'admin' : 'rep';
    const phone = normalizePhone(r[ci.phone]);
    if (r[ci.phone] && !phone) problems.push(`Row ${line}: “${r[ci.phone]}” isn't a full cell number — imported without one`);
    people.push({ row: { full_name: name, email, phone: phone || null, role, notify_sms: true, notify_email: true, active: true }, divIds });
  }
  return { people, problems };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
const visitById = id => D().visits.find(v => v.id === id);
const pageById = id => D().pages.find(p => p.id === id);

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const a = el.dataset.action, v = el.dataset.visit && visitById(el.dataset.visit), p = el.dataset.page && pageById(el.dataset.page);
  switch (a) {
    case 'nav':
      if (el.dataset.view === 'settings-anon') { connectionPrompt(); return; }
      state.view = el.dataset.view; LS.set('mp-view', state.view); render(); window.scrollTo(0, 0); return;
    case 'filter': state.filter = el.dataset.filter; render(); return;
    case 'alerts': enableAlerts(); return;
    case 'close-modal': closeModal(); return;
    case 'start': startModal(v); return;
    case 'finish': nextModal(v, { finishing: true }); return;
    case 'page': nextModal(v, { finishing: false }); return;
    case 'more': moreModal(v); return;
    case 'claim':
      await run(() => store.update('pages', p.id, { claimed_by: state.me?.id || null, claimed_at: nowIso() }), 'Marked on your way');
      return;
    case 'take': {
      const visit = visitById(p.visit_id);
      startModal(visit, p.division_id, p.claimed_by || state.me?.id);
      return;
    }
    case 'repage': closeModal(); await run(() => store.notify([p.id]), 'Page re-sent'); return;
    case 'cancel-page': closeModal(); await run(() => store.update('pages', p.id, { cancelled_at: nowIso() }), 'Page cancelled'); return;
    case 'checkout':
      confirmModal(`Check out ${dealerOf(v).name}?`, 'Check out', () => run(() => checkOut(v), `${dealerOf(v).name} checked out`)); return;
    case 'member': memberModal(el.dataset.id || null); return;
    case 'delete-member':
      confirmModal('Remove this team member? To keep their history, uncheck Active instead.', 'Remove', () => run(() => store.remove('team_members', { id: el.dataset.id }), 'Removed')); return;
    case 'import': importModal(); return;
    case 'copy': {
      const text = el.dataset.copy;
      try { await navigator.clipboard.writeText(text); toast('Copied'); }
      catch {
        const code = el.previousElementSibling;
        const r = document.createRange(); r.selectNodeContents(code);
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        toast('Selected. Tap Copy', 'warn');
      }
      return;
    }
    case 'new-token':
      await run(() => store.setSetting('inbound_token', newToken()), 'New check-in password created. Reps need to update their Shortcut');
      return;
    case 'redo-setup': state.forceSetup = true; render(); window.scrollTo(0, 0); return;
    case 'cancel-setup': state.forceSetup = false; render(); return;
    case 'ignore-msg':
      await run(() => store.update('inbound_messages', el.dataset.msg, { status: 'ignored', handled_by: state.me?.id || null, handled_at: nowIso() }), 'Ignored');
      return;
    case 'paste-clip': {
      try {
        const t = await navigator.clipboard.readText();
        if (!t.trim()) throw new Error('empty');
        $('#paste-text').value = t;
        fillFromText(t);
      } catch {
        $('#paste-text').focus();
        toast('Long-press the box and tap Paste', 'warn');
      }
      return;
    }
    case 'simulate-text': {
      const text = $('#paste-text').value.trim();
      if (!text) { toast('Paste or type a text first', 'warn'); return; }
      const r = await run(() => simulateIncomingText(text));
      if (!r) return;
      toast(r.status === 'checked_in' ? `Text received. ${r.dealer} checked in` : r.status === 'duplicate' ? `${r.dealer} is already here` : r.status === 'ignored' ? "Not a check-in (opt-in or similar), so it's ignored" : 'Text received. Sent to the review inbox on Floor');
      state.view = 'floor'; LS.set('mp-view', 'floor'); render();
      return;
    }
    case 'template': csvModal('market-pager-team-template.csv', 'Name,Email,Cell,Divisions,Role\nJordan Moore,jordan@company.com,336-555-0101,Motion,admin\nAvery Lee,avery@company.com,336-555-0102,Motion; Stationary,rep\n'); return;
    case 'export': {
      const rows = logRows();
      const cols = ['market', 'dealer', 'account', 'party', 'asked_for', 'source', 'checked_in', 'checked_out', 'showroom_min', 'division', 'rep', 'started', 'ended', 'division_min'];
      const fmt = (k, val) => /checked_|started|ended/.test(k) && val ? new Date(val).toLocaleString() : val;
      csvModal(`market-log-${(D().market?.name || 'market').replace(/\W+/g, '-')}.csv`, [cols.join(','), ...rows.map(r => cols.map(k => csvCell(fmt(k, r[k]))).join(','))].join('\n'));
      return;
    }
    case 'signout': await store.signOut(); location.reload(); return;
    case 'login-back': state.loginSent = false; render(); return;
    case 'reset-demo': confirmModal('Erase demo data and start over?', 'Reset demo', () => { store.reset(); state.alerted.clear(); }); return;
  }
});

document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset.action === 'mine') { state.mineOnly = t.checked; LS.set('mp-mine', t.checked); render(); }
  if (t.id === 'act-as') { try { sessionStorage.setItem('mp-demo-me', t.value); } catch { /* ignore */ } LS.set('mp-demo-me', t.value); await reload(); toast(`Now acting as ${state.me?.full_name}`); }
  if (t.id === 'market-switch') {
    await run(async () => {
      for (const m of D().markets.filter(m => m.is_active)) await store.update('markets', m.id, { is_active: false });
      await store.update('markets', t.value, { is_active: true });
    }, 'Market switched');
  }
});

let fillTimer = null;
document.addEventListener('input', e => {
  if (e.target.id === 'paste-text') {
    clearTimeout(fillTimer);
    fillTimer = setTimeout(() => fillFromText(e.target.value), 120);
    return;
  }
  if (e.target.id === 'search') {
    state.search = e.target.value;
    const pos = e.target.selectionStart;
    render();
    const s = $('#search'); s.focus(); s.setSelectionRange(pos, pos);
  }
});

document.addEventListener('submit', async e => {
  const f = e.target;
  if (f.id === 'setup-form') {
    e.preventDefault();
    const fd = new FormData(f);
    const smsConsent = !!fd.get('sms');
    const phone = normalizePhone(fd.get('phone'));
    if (smsConsent && !phone) { toast('Add your full cell number to get text alerts', 'warn'); $('#su-phone').focus(); return; }
    const ok = await run(async () => {
      await store.completeSetup({
        memberId: state.me.id, fullName: fd.get('full_name').trim(), phone, divisionIds: fd.getAll('div'),
        smsConsent, consentText: CONSENT_TEXT, notifyEmail: !!fd.get('email'),
      });
      if (smsConsent) { try { await store.sendWelcome(); } catch (err) { console.warn('welcome text', err); } }
      return true;
    });
    if (ok) {
      state.forceSetup = false;
      state.view = 'floor'; LS.set('mp-view', 'floor');
      await reload(); render();
      toast(smsConsent ? "You're set up. A confirmation text is on its way" : "You're set up");
    }
    return;
  }
  if (f.classList.contains('inbox-row')) {
    e.preventDefault();
    const msg = D().inbound_messages.find(m => m.id === f.dataset.msg);
    const name = f.dealer.value.trim(), party = f.party.value.trim();
    if (msg && name) await run(() => checkInFromText(msg, name, party), `${name} checked in`);
    return;
  }
  if (f.id === 'checkin-form') {
    e.preventDefault();
    const fd = new FormData(f);
    const askedId = fd.get('asked') || null;
    const data = {
      name: fd.get('name'), account: fd.get('account'), city: fd.get('city'), st: (fd.get('st') || '').toUpperCase(),
      party: fd.get('party'), notes: fd.get('notes'), pageDivs: fd.getAll('div'), source: fd.get('source') || 'app',
      requestedRepId: askedId, requestedRep: askedId ? memName(askedId) : (fd.get('asked_name') || null), location: fd.get('location') || null,
    };
    const visit = await run(() => checkIn(data));
    if (visit) { toast(`${data.name} is checked in`); state.view = 'floor'; LS.set('mp-view', 'floor'); render(); }
  }
  if (f.id === 'market-form') {
    e.preventDefault();
    const name = new FormData(f).get('name').trim();
    await run(async () => {
      for (const m of D().markets.filter(m => m.is_active)) await store.update('markets', m.id, { is_active: false });
      await store.insert('markets', { name, is_active: true, created_at: nowIso() });
    }, `${name} is now the active market`);
  }
  if (f.id === 'division-form') {
    e.preventDefault();
    const fd = new FormData(f);
    await run(() => store.insert('divisions', { name: fd.get('name').trim(), color: fd.get('color'), sort_order: D().divs.length + 1, active: true }), 'Division added');
  }
  if (f.id === 'conn-form') {
    e.preventDefault();
    const fd = new FormData(f);
    LS.set('market-pager-config', { mode: fd.get('mode'), url: fd.get('url').trim(), key: fd.get('key').trim() });
    location.reload();
  }
  if (f.id === 'login-form') {
    e.preventDefault();
    state.loginEmail = new FormData(f).get('email').trim();
    await run(async () => { await store.sendLogin(state.loginEmail); state.loginSent = true; render(); });
  }
  if (f.id === 'code-form') {
    e.preventDefault();
    await run(async () => { await store.verifyCode(state.loginEmail, new FormData(f).get('code').trim()); await reload(); });
  }
});

function connectionPrompt() {
  openModal(`<h2>Connection</h2>
    <form id="conn-form" class="form">
      <label class="toggle"><input type="radio" name="mode" value="demo"> Demo (this browser only)</label>
      <label class="toggle"><input type="radio" name="mode" value="supabase" checked> Supabase</label>
      <label>Supabase URL<input name="url" value="${esc(cfg.url || '')}"></label>
      <label>Anon key<input name="key" value="${esc(cfg.key || '')}"></label>
      <button class="btn" type="submit">Save & reload</button></form>`);
}

// ---------------------------------------------------------------------------
// Load loop
// ---------------------------------------------------------------------------
let reloading = null, reloadAgain = false;
async function reload() {
  // If a change lands mid-load, run one more pass afterwards so nothing is missed.
  if (reloading) { reloadAgain = true; return reloading; }
  reloading = (async () => {
    do {
      reloadAgain = false;
      try {
        state.session = await store.session();
        if (store.kind === 'supabase' && !state.session) { state.D = indexData(emptyData()); break; }
        state.D = indexData(await store.loadAll());
        if (store.kind === 'demo') {
          let id = null;
          try { id = sessionStorage.getItem('mp-demo-me'); } catch { /* ignore */ }
          id = id || LS.get('mp-demo-me', null);
          state.me = D().mem[id] || D().team_members.find(m => m.role === 'admin') || D().team_members[0] || null;
          // Pin identity per tab so two tabs can play two different reps.
          try { if (state.me) sessionStorage.setItem('mp-demo-me', state.me.id); } catch { /* ignore */ }
        } else {
          const email = state.session.user.email?.toLowerCase();
          state.me = D().team_members.find(m => m.email.toLowerCase() === email && m.active) || null;
        }
        checkAlerts();
        state.loaded = true;
      } catch (e) {
        console.error(e);
        toast('Could not load: ' + (e.message || e), 'err');
        if (!state.D) state.D = indexData(emptyData());
      }
    } while (reloadAgain);
    reloading = null;
  })();
  await reloading;
  // Don't wipe a half-typed form on the page when someone else changes data.
  const a = document.activeElement;
  const typing = a && $('#view')?.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'search';
  const dirtyForm = state.view === 'checkin' && $('#checkin-form') && [...new FormData($('#checkin-form')).values()].some(Boolean);
  if (!typing && !dirtyForm && !$('#setup-form')) render();
}
const emptyData = () => ({ divisions: [], team_members: [], member_divisions: [], markets: [], dealers: [], visits: [], walkthroughs: [], pages: [], notification_log: [], inbound_messages: [] });

setInterval(() => $$('.timer.live').forEach(el => { el.textContent = dur(el.dataset.since); }), 1000);

(async () => {
  const incoming = new URLSearchParams(location.search).get('text');
  if (incoming) {
    try { sessionStorage.setItem('mp-pending-text', incoming); } catch { /* ignore */ }
    state.view = 'checkin';
    history.replaceState(null, '', location.pathname + location.hash);
  }
  render();
  await store.init();
  store.onChange(() => reload());
  await reload();
  if (LS.get('mp-alerts', false)) document.addEventListener('pointerdown', () => { if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); render(); } catch { /* no audio */ } } }, { once: true });
})();

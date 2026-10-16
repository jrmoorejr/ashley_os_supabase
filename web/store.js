// Data layer. Two interchangeable backends with the same surface:
//   DemoStore     - everything in this browser's localStorage (try it with no setup)
//   SupabaseStore - shared, realtime, with SMS/email paging via the page-team Edge Function
//
// Surface: init(), loadAll(), insert(table, rows), update(table, id, patch),
//          remove(table, match), notify(pageIds), onChange(cb), plus auth helpers.

const TABLES = ['divisions', 'team_members', 'member_divisions', 'markets', 'dealers',
  'visits', 'walkthroughs', 'pages', 'notification_log', 'inbound_messages'];

const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  }));

const DEFAULT_DIVISIONS = [
  ['Motion', '#2563eb'], ['Case Goods', '#b45309'], ['Bedding', '#7c3aed'],
  ['Stationary', '#059669'], ['Accents', '#db2777'],
];

// ---------------------------------------------------------------------------
export class DemoStore {
  kind = 'demo';
  key = 'market-pager-demo-v1';
  listeners = new Set();

  async init() {
    let db = null;
    try { db = JSON.parse(localStorage.getItem(this.key) || 'null'); } catch { /* storage blocked */ }
    this.db = db || seedDemo();
    for (const t of TABLES) this.db[t] = this.db[t] || [];  // older demo data
    this.save();
    // Keep multiple tabs of the demo in sync.
    window.addEventListener('storage', e => {
      if (e.key !== this.key) return;
      try { this.db = JSON.parse(e.newValue); this.emit(); } catch { /* ignore */ }
    });
  }
  save() { try { localStorage.setItem(this.key, JSON.stringify(this.db)); } catch { /* ignore */ } }
  emit() { this.listeners.forEach(cb => cb()); }
  onChange(cb) { this.listeners.add(cb); }

  async session() { return { user: { email: 'demo@local' } }; }
  async loadAll() { return structuredClone(this.db); }

  async insert(table, rows) {
    const list = (Array.isArray(rows) ? rows : [rows]).map(r => ({ id: uid(), ...r }));
    if (table === 'member_divisions') list.forEach(r => delete r.id);
    this.db[table].push(...list);
    this.save(); this.emit();
    return list;
  }
  async update(table, id, patch) {
    const row = this.db[table].find(r => r.id === id);
    if (row) Object.assign(row, patch);
    this.save(); this.emit();
    return row;
  }
  async remove(table, match) {
    this.db[table] = this.db[table].filter(r => !Object.entries(match).every(([k, v]) => r[k] === v));
    this.save(); this.emit();
  }
  async notify(pageIds) {
    // No real texts in demo mode; log what would have gone out.
    const log = [];
    for (const page of this.db.pages.filter(p => pageIds.includes(p.id))) {
      const memberIds = this.db.member_divisions.filter(l => l.division_id === page.division_id).map(l => l.member_id);
      for (const m of this.db.team_members.filter(t => memberIds.includes(t.id) && t.active && t.id !== page.requested_by)) {
        log.push({ page_id: page.id, member_id: m.id, channel: 'sms', destination: m.phone, status: 'skipped', detail: 'Demo mode', created_at: new Date().toISOString() });
      }
    }
    if (log.length) await this.insert('notification_log', log);
    return { members: new Set(log.map(l => l.member_id)).size, sent: 0, demo: true };
  }
  reset() { this.db = seedDemo(); this.save(); this.emit(); }
}

function seedDemo() {
  const db = Object.fromEntries(TABLES.map(t => [t, []]));
  db.divisions = DEFAULT_DIVISIONS.map(([name, color], i) => ({ id: uid(), name, color, sort_order: i + 1, active: true }));
  const people = [
    ['J.R. Moore', 'jr@example.com', '+13365550101', ['Motion'], 'admin'],
    ['Avery Lee', 'avery@example.com', '+13365550102', ['Motion', 'Stationary'], 'rep'],
    ['Sam Patel', 'sam@example.com', '+13365550103', ['Case Goods'], 'rep'],
    ['Riley Brooks', 'riley@example.com', '+13365550104', ['Bedding'], 'rep'],
    ['Casey Nguyen', 'casey@example.com', '+13365550105', ['Stationary'], 'rep'],
    ['Morgan Diaz', 'morgan@example.com', '+13365550106', ['Accents', 'Case Goods'], 'rep'],
  ];
  for (const [full_name, email, phone, divs, role] of people) {
    const id = uid();
    db.team_members.push({ id, full_name, email, phone, role, notify_sms: true, notify_email: true, active: true, created_at: new Date().toISOString() });
    for (const d of divs) db.member_divisions.push({ member_id: id, division_id: db.divisions.find(x => x.name === d).id });
  }
  db.markets.push({ id: uid(), name: 'Demo Market', is_active: true, created_at: new Date().toISOString() });
  // A text the app couldn't read on its own, so the review inbox has something in it.
  db.inbound_messages.push({ id: uid(), received_at: new Date().toISOString(), channel: 'sms', from_number: '+13365550188',
    body: 'Heads up, the owner from Riverside Home Center is at reception asking for Bedding (example of a text the app needs help with)', parsed_dealer: null,
    parsed_party: null, parsed_account: null, confidence: 'low', status: 'pending' });
  return db;
}

// ---------------------------------------------------------------------------
export class SupabaseStore {
  kind = 'supabase';
  listeners = new Set();

  constructor(url, anonKey) {
    if (!window.supabase) throw new Error('Supabase library failed to load');
    this.client = window.supabase.createClient(url, anonKey);
  }

  async init() {
    let timer = null;
    const ping = () => { clearTimeout(timer); timer = setTimeout(() => this.emit(), 250); };
    this.channel = this.client.channel('market-pager')
      .on('postgres_changes', { event: '*', schema: 'public' }, ping)
      .subscribe();
    // Safety net in case a realtime message is missed (spotty convention-center wifi).
    setInterval(() => this.emit(), 30000);
    this.client.auth.onAuthStateChange(() => this.emit());
  }
  emit() { this.listeners.forEach(cb => cb()); }
  onChange(cb) { this.listeners.add(cb); }

  async session() { return (await this.client.auth.getSession()).data.session; }
  async sendLogin(email) {
    const { error } = await this.client.auth.signInWithOtp({
      email, options: { emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw error;
  }
  async verifyCode(email, token) {
    const { error } = await this.client.auth.verifyOtp({ email, token, type: 'email' });
    if (error) throw error;
  }
  async signOut() { await this.client.auth.signOut(); }

  async loadAll() {
    const c = this.client;
    const get = async (q) => { const { data, error } = await q; if (error) throw error; return data || []; };
    const [divisions, team_members, member_divisions, markets, dealers] = await Promise.all([
      get(c.from('divisions').select('*')),
      get(c.from('team_members').select('*')),
      get(c.from('member_divisions').select('*')),
      get(c.from('markets').select('*')),
      get(c.from('dealers').select('*')),
    ]);
    const active = markets.find(m => m.is_active);
    let visits = [], walkthroughs = [], pages = [], notification_log = [];
    const since = new Date(Date.now() - 48 * 3600e3).toISOString();
    const inbound_messages = await get(c.from('inbound_messages').select('*').gte('received_at', since).order('received_at', { ascending: false }));
    if (active) {
      visits = await get(c.from('visits').select('*').eq('market_id', active.id));
      const ids = visits.map(v => v.id);
      if (ids.length) {
        [walkthroughs, pages] = await Promise.all([
          get(c.from('walkthroughs').select('*').in('visit_id', ids)),
          get(c.from('pages').select('*').in('visit_id', ids)),
        ]);
        const pageIds = pages.map(p => p.id);
        if (pageIds.length) notification_log = await get(c.from('notification_log').select('*').in('page_id', pageIds));
      }
    }
    return { divisions, team_members, member_divisions, markets, dealers, visits, walkthroughs, pages, notification_log, inbound_messages };
  }

  async insert(table, rows) {
    const { data, error } = await this.client.from(table).insert(rows).select();
    if (error) throw error;
    this.emit();
    return data;
  }
  async update(table, id, patch) {
    const { data, error } = await this.client.from(table).update(patch).eq('id', id).select().single();
    if (error) throw error;
    this.emit();
    return data;
  }
  async remove(table, match) {
    const { error } = await this.client.from(table).delete().match(match);
    if (error) throw error;
    this.emit();
  }
  async notify(pageIds) {
    const { data, error } = await this.client.functions.invoke('page-team', { body: { page_ids: pageIds } });
    if (error) throw error;
    return data;
  }
}

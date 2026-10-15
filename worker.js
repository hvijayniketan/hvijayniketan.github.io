/*
 * Hotel Vijay booking server for Cloudflare Workers (v3: Razorpay online payment, prices from PMS Rates calendar,
 * Inventory rules and Promotions).  Two addresses:
 *   GET  /api/availability?in=YYYY-MM-DD&out=YYYY-MM-DD[&code=COUPON]
 *   POST /api/book              (with Razorpay keys: returns a payment order instead of booking)
 *   POST /api/pay/verify        (the guest's browser after paying)
 *   POST /api/razorpay-webhook  (Razorpay, set in the Razorpay dashboard)
 * Settings (unchanged): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ALLOWED_ORIGINS,
 *   RAZORPAY_KEY_ID (text), RAZORPAY_KEY_SECRET (secret), RAZORPAY_WEBHOOK_SECRET (secret). Leave out to keep pay-at-hotel.
 *   GUEST_RATES (optional, now only a fallback), WEB_PLAN, WEB_HOLDBACK (optional).
 * Reads and writes the same Supabase "docs" table the PMS uses:
 *   pms/rooms, pms/plans, pms/cal (rates calendar, inventory, promos, blackouts), pms/hotel, res/<id>
 * Price order for every night: Rates calendar date price, then GUEST_RATES / PMS guest table, then room price.
 */

let ENV = {};
const TZ = 'Asia/Kolkata';
const MAX_NIGHTS = 30;
const MAX_ROOMS_PER_BOOKING = 5;
const MAX_GUESTS_PER_ROOM = 8;
const MAX_ADULTS = 6;
const MAX_KIDS = 4;
const MAX_CHILD_AGE = 12;
const ADULT_FROM_AGE = 5; // a child aged 5 or more is treated as an adult
const ADVANCE_DAYS = 365;

const cfg = () => ({
  url: (ENV.SUPABASE_URL || '').replace(/\/+$/, ''),
  key: ENV.SUPABASE_SERVICE_ROLE_KEY || '',
});

async function sb(path, { method = 'GET', body, headers = {} } = {}) {
  const { url, key } = cfg();
  if (!url || !key) throw new Error('Supabase is not configured');
  const r = await fetch(url + '/rest/v1/' + path, {
    method,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('Supabase ' + r.status + ' ' + t.slice(0, 200));
  }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

const enc = encodeURIComponent;

async function getDoc(path) {
  const rows = await sb('docs?path=eq.' + enc(path) + '&select=data&limit=1');
  return rows && rows[0] ? rows[0].data : null;
}

async function docExists(path) {
  const rows = await sb('docs?path=eq.' + enc(path) + '&select=path&limit=1');
  return !!(rows && rows.length);
}

async function listLiveReservations(fromDate) {
  const out = [];
  for (let off = 0; off < 20000; off += 1000) {
    const q =
      'docs?coll=eq.res&select=data&order=path.asc&limit=1000&offset=' + off +
      '&data-%3E%3Eout=gte.' + enc(fromDate) +
      '&data-%3E%3Estatus=in.(reserved,checked-in)';
    const rows = await sb(q);
    rows.forEach((x) => out.push(x.data));
    if (rows.length < 1000) break;
  }
  // The server filter is only an optimisation. Always filter again here.
  return out.filter((r) => r && (r.status === 'reserved' || r.status === 'checked-in') && r.out >= fromDate);
}

async function upsertDocs(rows) {
  await sb('docs?on_conflict=path', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: rows,
  });
}

async function deleteDoc(path) {
  await sb('docs?path=eq.' + enc(path), { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

/* ---------- dates (IST) ---------- */
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const utc = (s) => Date.parse(s + 'T00:00:00Z');
const addD = (s, n) => new Date(utc(s) + n * 864e5).toISOString().slice(0, 10);
const nightsBetween = (a, b) => Math.round((utc(b) - utc(a)) / 864e5);
const dow = (s) => new Date(utc(s)).getUTCDay();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(utc(s)).toISOString().slice(0, 10) === s;
const sum = (a) => a.reduce((s, x) => s + x, 0);

/* ---------- state ---------- */
const isFam = (t) => /family/i.test(String(t));

async function loadState(a) {
  const [roomsDoc, plansDoc, hotelDoc, calDoc, res] = await Promise.all([
    getDoc('pms/rooms'),
    getDoc('pms/plans'),
    getDoc('pms/hotel'),
    getDoc('pms/cal'),
    listLiveReservations(a),
  ]);
  if (!roomsDoc || !roomsDoc.rooms || !plansDoc || !plansDoc.plans) throw new Error('PMS data not found in Supabase');
  const types = [...new Set(roomsDoc.rooms.map((r) => r.type))];
  // Guest table of each plan = GUEST_RATES setting first, then PMS table (used when the calendar has no price for a date)
  const plans = plansDoc.plans.map((p) => {
    const occ = {};
    types.forEach((t) => { const o = occFor(p, t); occ[t] = { prices: o.prices, extra: o.extra }; });
    return { ...p, occ };
  });
  const c = calDoc || {};
  return {
    rooms: roomsDoc.rooms,
    plans,
    tax: Number.isFinite(+plansDoc.tax) ? +plansDoc.tax : 5,
    hotel: (hotelDoc && hotelDoc.hotel) || {},
    cal: c.cal && typeof c.cal === 'object' ? c.cal : { rate: {}, inv: {} },
    blackouts: Array.isArray(c.blackouts) ? c.blackouts : [],
    promos: Array.isArray(c.promos) ? c.promos : [],
    res,
  };
}

function choosePlan(plans) {
  const want = (ENV.WEB_PLAN || 'Room only').toLowerCase();
  return plans.find((p) => String(p.name).toLowerCase() === want) || plans[0];
}

const bType = (rooms, r) =>
  r.room ? ((rooms.find((x) => x.no === r.room) || {}).type || r.rtype || '') : (r.rtype || '');

/* ---------- occupancy rules ---------- */
const RULES = {
  std: { minAdults: 1, maxAdults: 3, maxTotal: 3, combos: [[2, 2]], msg: 'AC and Non-AC rooms take up to 3 guests, or 2 adults with 2 children aged 4 or under.' },
  fam: { minAdults: 4, maxAdults: 6, maxTotal: 8, maxKids: 2, combos: [], msg: 'The Family Room is for 4 to 6 adults.' },
};
const ruleFor = (t) => (isFam(t) ? RULES.fam : RULES.std);

/* adults = adults + children aged 5 or more, kids = children aged 4 or under (free) */
function countGuests(adults, ages) {
  let a = adults, k = 0;
  ages.forEach((x) => { if (x >= ADULT_FROM_AGE) a++; else k++; });
  return { a, k };
}
function fits(type, a, k) {
  const R = ruleFor(type);
  if (a < R.minAdults || a > R.maxAdults) return false;
  if (a + k <= R.maxTotal && k <= (R.maxKids == null ? 99 : R.maxKids)) return true;
  return (R.combos || []).some((c) => a === c[0] && k <= c[1]);
}

/* Guest table fallback: GUEST_RATES setting wins when a box is above 0, then the PMS table. */
let FILE_RATES = {};
function occFor(plan, type) {
  const f = FILE_RATES[type] || {};
  const o = (plan.occ || {})[type] || {};
  const op = o.prices || {};
  const num = (v) => (+v > 0 ? +v : 0);
  return {
    prices: {
      1: num(f['1 person']) || num(op[1]),
      2: num(f['2 persons']) || num(op[2]),
      4: num(f['4 adults']) || num(op[4]),
    },
    extra: num(f['each extra adult']) || num(o.extra),
  };
}

const holdback = () => Math.max(0, parseInt(ENV.WEB_HOLDBACK || '0', 10) || 0);

/* ---------- inventory rules (same as the PMS Rates, inventory and promotions screen) ---------- */
const physInv = (S, t) => S.rooms.filter((r) => r.type === t && r.hk !== 'maintenance').length;
const invOv = (S, t, d) => ((S.cal.inv || {})[t] || {})[d] || {};
const soldOn = (S, t, d) => S.res.filter((r) => r.in <= d && d < r.out && bType(S.rooms, r) === t).length;

/* blackout, stop sell, rooms to sell, closed to arrival or departure, min and max nights, bookings already made.
   free = rooms left to sell, raw = same number without the floor at zero (used to detect over-selling) */
function stay(S, t, a, b) {
  const N = nightsBetween(a, b), phys = physInv(S, t);
  let raw = phys, reason = '';
  for (let i = 0; i < N; i++) {
    const d = addD(a, i), o = invOv(S, t, d);
    if (S.blackouts.some((x) => x.from <= d && d <= x.to) || o.stop) { reason = 'Not available for these dates.'; break; }
    raw = Math.min(raw, (o.n != null ? Math.min(o.n, phys) : phys) - soldOn(S, t, d));
  }
  const ia = invOv(S, t, a), ib = invOv(S, t, b);
  if (!reason && ia.cta) reason = 'Check-in is not available on this date.';
  if (!reason && ib.ctd) reason = 'Check-out is not available on this date.';
  if (!reason && ia.min && N < ia.min) reason = 'Minimum stay for this date is ' + ia.min + ' nights.';
  if (!reason && ia.max && N > ia.max) reason = 'Maximum stay for this date is ' + ia.max + ' nights.';
  return { free: reason ? 0 : Math.max(0, raw), raw, reason };
}

/* ---------- rates calendar ---------- */
/* returns f(billedAdults) = price of one room for one night before GST */
function nightPrice(pl, S, t, d) {
  const ov = (((S.cal.rate || {})[pl.id] || {})[t] || {})[d] || {}, o = (pl.occ || {})[t] || {}, op = o.prices || {};
  const df = (k) => (k === 'b' ? (+((pl.prices || {})[t]) || 0) : k === 'xa' ? (+o.extra || 0) : (+op[k === 'p1' ? 1 : k === 'p2' ? 2 : 4] || 0));
  const fam = isFam(t), v = (k) => (ov[k] != null ? +ov[k] : df(k));
  const b = v('b'), xa = v('xa');
  let p1 = v('p1'), p2 = v('p2'), p4 = v('p4');
  if (ov.b > 0) { // a date-specific Room rate is the price for 2 guests (4 for Family Room)
    if (fam && ov.p4 == null) p4 = ov.b;
    if (!fam && ov.p2 == null) {
      const gap = df('p2') > 0 && df('p1') > 0 ? df('p2') - df('p1') : 0;
      p2 = ov.b; if (ov.p1 == null) p1 = Math.max(1, ov.b - gap);
    }
  }
  const w = dow(d), up = (w === 5 || w === 6) && !(ov.b > 0) ? 1 + (pl.wk || 0) / 100 : 1;
  return (a) => {
    const core = fam ? (p4 || b) : a <= 1 ? (p1 || p2 || b) : (p2 || b);
    const ex = fam ? Math.max(0, a - 4) * xa : Math.max(0, a - 2) * xa;
    return core > 0 ? Math.round(core * up) + ex : 0;
  };
}

/* ---------- promotions ---------- */
function eligible(p, pl, t, q, N) {
  if (!p.on || (p.ch && p.ch.length && !p.ch.includes('web'))) return false;
  if (['member', 'corp', 'mobile', 'nonref'].includes(p.type) && !p.code) return false; // website cannot know the guest type
  if (p.type === 'coupon' || p.code) {
    if (!p.code || !q.code || String(p.code).trim().toLowerCase() !== q.code.trim().toLowerCase()) return false;
  }
  if (p.plan && p.plan !== 'all' && p.plan !== pl.id) return false;
  if (p.types && p.types.length && !p.types.includes(t)) return false;
  if (p.bf && q.today < p.bf) return false;
  if (p.bt && q.today > p.bt) return false;
  if (p.minN !== '' && p.minN != null && N < p.minN) return false;
  if (p.maxN && N > p.maxN) return false;
  const lead = nightsBetween(q.today, q.in);
  if (p.minA !== '' && p.minA != null && lead < p.minA) return false;
  if (p.maxA && lead > p.maxA) return false;
  if (p.days && p.days.length && !p.days.includes(String(dow(q.in)))) return false;
  if (p.kind === 'incl') return !!p.incl;
  if (!(p.val > 0)) return false;
  if (p.kind === 'free' && !(p.val > p.val2 && N >= p.val)) return false;
  return true;
}
function applyOne(prices, dates, p) {
  const r = prices.map((x, i) => {
    if ((p.sf && dates[i] < p.sf) || (p.st && dates[i] > p.st)) return x;
    return p.kind === 'pct' ? x * (1 - p.val / 100) : p.kind === 'flat' ? Math.max(1, x - p.val) : p.kind === 'rate' ? Math.min(x, p.val) : x;
  });
  if (p.kind === 'free') {
    const k = Math.floor(prices.length / p.val) * (p.val - (p.val2 || 0));
    r.map((x, i) => [x, i]).sort((x, y) => x[0] - y[0]).slice(0, k).forEach((z) => { r[z[1]] = 0; });
  }
  return r.map(Math.round);
}

/* nightly prices for `a` billed adults, best promotion first, others only if both allow combining */
function priced(np, dates, cand, a) {
  const was = np.map((f) => f(a));
  if (was.some((x) => !x)) return null; // rate not set for a night
  let cur = was, code = false;
  const names = [], incl = [];
  const sv = cand.filter((p) => p.kind !== 'incl')
    .map((p) => ({ p, save: sum(was) - sum(applyOne(was, dates, p)) }))
    .filter((x) => x.save > 0).sort((x, y) => y.save - x.save);
  sv.forEach((x, i) => {
    if (i === 0 || (sv[0].p.comb && x.p.comb)) {
      cur = applyOne(cur, dates, x.p); names.push(x.p.name);
      if (x.p.incl) incl.push(x.p.incl);
      if (x.p.code) code = true;
    }
  });
  cand.filter((p) => p.kind === 'incl').forEach((p) => { incl.push(p.incl); if (p.code) code = true; });
  if (cur.some((x) => x <= 0)) { // a free night cannot be stored as zero, so spread the total over the nights
    const t = sum(cur), n = cur.length;
    cur = cur.map((_, i) => Math.floor(t / n) + (i < t % n ? 1 : 0));
  }
  return { was, cur, names, incl: [...new Set(incl)], code };
}

function prep(S, q, t) {
  const pl = choosePlan(S.plans), N = nightsBetween(q.in, q.out);
  const dates = [...Array(N)].map((_, i) => addD(q.in, i));
  return { pl, N, dates, np: dates.map((d) => nightPrice(pl, S, t, d)), cand: S.promos.filter((p) => eligible(p, pl, t, q, N)) };
}

/* one room for the stay, used when the booking is saved */
function quoteRoom(S, q, t, adults) {
  const { N, dates, np, cand } = prep(S, q, t);
  const x = priced(np, dates, cand, adults);
  if (!x) return null;
  const room = sum(x.cur), tax = Math.round((room * S.tax) / 100);
  return { nightly: dates.map((d, i) => ({ d, rate: x.cur[i] })), nights: N, room, tax, total: room + tax, promo: x.names.join(' + ') };
}

function validateStay(a, b) {
  if (!isDate(a) || !isDate(b)) return 'Choose valid check-in and check-out dates.';
  const t = today();
  if (a < t) return 'Check-in cannot be in the past.';
  if (b <= a) return 'Check-out must be after check-in.';
  if (nightsBetween(a, b) > MAX_NIGHTS) return 'For stays longer than ' + MAX_NIGHTS + ' nights please call the hotel.';
  if (a > addD(t, ADVANCE_DAYS)) return 'Bookings open up to a year ahead.';
  return '';
}

function availability(S, a, b, code) {
  const q = { in: a, out: b, code: code || '', today: today() };
  const tx = 1 + S.tax / 100, hb = holdback();
  let codeUsed = false;
  const types = [...new Set(S.rooms.map((r) => r.type))].filter((t) => physInv(S, t) > 0);
  const out = types.map((t) => {
    const s = stay(S, t, a, b), { pl, N, dates, np, cand } = prep(S, q, t), byAdults = {};
    for (let n = 1; n <= 8; n++) {
      const x = priced(np, dates, cand, n);
      if (!x) continue;
      if (x.code) codeUsed = true;
      byAdults[n] = {
        perNight: Math.round(sum(x.cur) / N), total: Math.round(sum(x.cur) * tx),
        wasPerNight: Math.round(sum(x.was) / N), wasTotal: Math.round(sum(x.was) * tx),
        promo: x.names.join(' + '), incl: x.incl,
      };
    }
    const rated = Object.keys(byAdults).length > 0, def = byAdults[isFam(t) ? 4 : 2] || {};
    return {
      type: t, free: rated ? Math.min(Math.max(0, s.free - hb), MAX_ROOMS_PER_BOOKING) : 0,
      reason: s.reason || (rated ? '' : 'Rates for these dates are not set.'),
      perNight: def.perNight, total: def.total, byAdults,
    };
  });
  out.sort((x, y) => (x.perNight || 1e9) - (y.perNight || 1e9));
  const pl = choosePlan(S.plans);
  return { plan: pl && pl.name, taxPct: S.tax, nights: nightsBetween(a, b), types: out, codeOk: q.code ? codeUsed : undefined };
}

/* ---------- guest input ---------- */
function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function cleanPhone(v) {
  let d = String(v || '').replace(/[^\d+]/g, '');
  const digits = d.replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10) return digits;
  if (digits.length >= 8 && digits.length <= 15) return '+' + digits;
  return '';
}

async function nextIds(count) {
  const ctr = (await getDoc('pms/ctr')) || {};
  let n = Math.max(1000, parseInt(ctr.seq, 10) || 1000);
  const ids = [];
  while (ids.length < count) {
    n++;
    if (!(await docExists('res/R' + n))) ids.push('R' + n);
    if (n > 1000000) throw new Error('Could not allocate booking number');
  }
  let g = Math.max(1000, parseInt(ctr.gseq, 10) || 1000);
  let grp = null;
  if (count > 1) {
    for (;;) {
      g++;
      const rows = await sb('docs?coll=eq.res&select=path&data-%3E%3Egrp=eq.G' + g + '&limit=1');
      if (!rows || !rows.length) break;
      if (g > 1000000) throw new Error('Could not allocate group number');
    }
    grp = 'G' + g;
  }
  return { ids, grp };
}

/* Checks the per room guest details sent by the website. Returns { error } or { list }. */
function parseOccupancy(raw, want, totalRooms) {
  if (!Array.isArray(raw) || raw.length !== totalRooms) return { error: 'Please refresh the page and choose guests for each room again.' };
  const list = [];
  const seen = {};
  for (let i = 0; i < raw.length; i++) {
    const x = raw[i] || {};
    const type = cleanText(x.type, 60);
    const adults = Math.floor(+x.adults);
    const ages = Array.isArray(x.childAges) ? x.childAges.map((v) => (v === '' || v === null ? NaN : +v)) : [];
    const label = 'Room ' + (i + 1) + ': ';
    if (!type || !want[type]) return { error: label + 'choose a room type.' };
    seen[type] = (seen[type] || 0) + 1;
    if (!(adults >= 1 && adults <= MAX_ADULTS)) return { error: label + 'choose 1 to ' + MAX_ADULTS + ' adults.' };
    if (ages.length > MAX_KIDS) return { error: label + 'up to ' + MAX_KIDS + ' children per room. Please add another room.' };
    if (ages.some((v) => !Number.isInteger(v) || v < 0 || v > MAX_CHILD_AGE)) return { error: label + 'enter the age (0 to ' + MAX_CHILD_AGE + ') of every child. Guests aged 13 and above are adults.' };
    const { a, k } = countGuests(adults, ages);
    if (!fits(type, a, k)) return { error: label + ruleFor(type).msg + ' Children aged ' + ADULT_FROM_AGE + ' and above count as adults.' };
    list.push({ type, adults, ages, a, k });
  }
  if (Object.keys(want).some((t) => seen[t] !== want[t])) return { error: 'Please refresh the page and choose guests for each room again.' };
  return { list };
}

/* ---------- Razorpay (test or live, depends on the keys you set) ---------- */
const payOn = () => !!(ENV.RAZORPAY_KEY_ID && ENV.RAZORPAY_KEY_SECRET);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rzp(path, { method = 'GET', body } = {}) {
  const r = await fetch('https://api.razorpay.com/v1/' + path, {
    method,
    headers: { Authorization: 'Basic ' + btoa(ENV.RAZORPAY_KEY_ID + ':' + ENV.RAZORPAY_KEY_SECRET), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  if (!r.ok) throw new Error('Razorpay ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : {};
}
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg));
  return [...new Uint8Array(s)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const same = (a, b) => a.length === b.length && [...a].reduce((n, c, i) => n | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0;

/* first caller gets true, everyone else false (so a booking is never made twice) */
async function claim(path) {
  const r = await sb('docs?on_conflict=path', {
    method: 'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: [{ path, coll: 'web', data: { at: Date.now() }, updated_at: new Date().toISOString() }],
  });
  return Array.isArray(r) && r.length === 1;
}

/*
 * prepareBooking checks the request and prices every room. Returns { out } (an answer to send now) or { ctx }.
 * saveBooking writes the reservations into the PMS.
 * input: { in, out, rooms:[{type,qty}], occupancy:[{type,adults,childAges:[]}], guest:{...}, code }
 */
async function prepareBooking(input) {
  const fail = (status, error, more) => ({ out: { status, body: { ok: false, error, ...(more || {}) } } });
  const a = cleanText(input.in, 10);
  const b = cleanText(input.out, 10);
  const bad = validateStay(a, b);
  if (bad) return fail(400, bad);

  const g = input.guest || {};
  const name = cleanText(g.name, 80);
  const phone = cleanPhone(g.phone);
  const email = cleanText(g.email, 100);
  const nat = cleanText(g.nationality, 40) || 'Indian';
  if (name.length < 2) return fail(400, 'Enter the guest name.');
  if (!phone) return fail(400, 'Enter a valid mobile number.');
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return fail(400, 'The email address does not look right.');

  const want = {};
  (Array.isArray(input.rooms) ? input.rooms : []).forEach((x) => {
    const t = cleanText(x && x.type, 60);
    const q = Math.floor(+(x && x.qty));
    if (t && q > 0) want[t] = (want[t] || 0) + q;
  });
  const types = Object.keys(want);
  const totalRooms = types.reduce((n, t) => n + want[t], 0);
  if (!totalRooms) return fail(400, 'Choose at least one room.');
  if (totalRooms > MAX_ROOMS_PER_BOOKING) return fail(400, 'For more than ' + MAX_ROOMS_PER_BOOKING + ' rooms please call the hotel.');

  const occ = parseOccupancy(input.occupancy, want, totalRooms);
  if (occ.error) return fail(400, occ.error);
  const rooms = occ.list;
  const guests = rooms.reduce((n, r) => n + r.adults + r.ages.length, 0);

  const S = await loadState(a);
  const plan = choosePlan(S.plans);
  const hb = holdback();
  const q0 = { in: a, out: b, code: cleanText(input.code, 40), today: today() };

  // The same guest sending the same request again returns the booking already made.
  const dup = S.res.find((r) => r.web && r.phone === phone && r.in === a && r.out === b && String(r.guest).toLowerCase() === name.toLowerCase());
  if (dup) return { out: { status: 200, body: { ok: true, duplicate: true, ref: dup.grp || dup.id, name, in: a, out: b, rooms: totalRooms } } };
  const recent = S.res.filter((r) => r.web && r.phone === phone && r.status === 'reserved').length;
  if (recent >= 6) return fail(429, 'Too many open bookings for this number. Please call the hotel.');

  for (const t of types) {
    if (!quoteRoom(S, q0, t, isFam(t) ? 4 : 2)) return fail(400, 'That room type is not available online for these dates.');
    const s = stay(S, t, a, b);
    if (s.reason) return fail(409, t + ': ' + s.reason, { soldOut: true });
    const free = s.free - hb;
    if (want[t] > free) return fail(409, free > 0 ? 'Only ' + free + ' ' + t + ' room' + (free === 1 ? '' : 's') + ' left for these dates.' : t + ' is sold out for these dates.', { soldOut: true });
  }
  // Price of each room from its own guests and the rates calendar, calculated here and never taken from the website.
  const quotes = rooms.map((r) => quoteRoom(S, q0, r.type, r.a));
  if (quotes.some((q) => !q)) return fail(400, 'That room type is not available online for these dates.');
  const total = Math.round(sum(quotes.map((q) => q.room + q.tax)));
  return { ctx: { a, b, name, phone, email, nat, types, want, totalRooms, rooms, guests, S, plan, hb, quotes, total } };
}

/* pay = { id } when the guest has paid online through Razorpay */
async function saveBooking(c, pay) {
  const { ids, grp } = await nextIds(c.totalRooms);
  const stamp = new Date().toISOString();
  const recs = c.rooms.map((r, k) => {
    const nr = {}; // price of each night, so a stay across two seasons is saved at the right rate for every night
    c.quotes[k].nightly.forEach((n) => { nr[n.d] = n.rate; });
    const rec = {
      id: ids[k],
      guest: c.name, phone: c.phone, email: c.email, gstin: '', nat: c.nat, addr: '',
      idt: 'Aadhaar', idn: '', agent: 'Website', purpose: 'Tour',
      gi: 0, room: '', rtype: r.type, in: c.a, out: c.b,
      pax: r.adults + r.ages.length,
      adults: r.adults, kids: r.ages.length, kidAges: r.ages, billedAdults: r.a,
      rate: Math.round(c.quotes[k].room / c.quotes[k].nights), nr, plan: c.plan.name, wk: 0,
      status: 'reserved', items: [], pays: [],
      web: 1, webAt: stamp,
    };
    if (c.quotes[k].promo) rec.webPromo = c.quotes[k].promo;
    if (grp) rec.grp = grp;
    return rec;
  });
  if (pay) { // the full amount, recorded once on the first room, same as an advance in the PMS
    recs.forEach((r) => { r.webPaid = 1; });
    recs[0].pays = [{ d: today(), mode: 'Razorpay', amt: c.total, ref: pay.id }];
  }

  await upsertDocs(recs.map((r) => ({ path: 'res/' + r.id, coll: 'res', data: r, updated_at: stamp })));

  // Re-check after writing. If two guests booked the last room at the same moment, undo this one.
  const after = await loadState(c.a);
  const over = c.types.find((t) => { const s = stay(after, t, c.a, c.b); return !s.reason && s.raw - c.hb < 0; });
  if (over) {
    for (const r of recs) await deleteDoc('res/' + r.id).catch(() => {});
    return { status: 409, body: { ok: false, soldOut: true, error: 'Sorry, the last ' + over + ' room was just booked by someone else. Please check availability again.' } };
  }
  const nights = nightsBetween(c.a, c.b);
  let room = 0, tax = 0;
  c.quotes.forEach((q) => { room += q.room; tax += q.tax; });
  return {
    status: 200,
    body: {
      ok: true, ref: grp || recs[0].id, name: c.name, in: c.a, out: c.b, nights, rooms: c.totalRooms, guests: c.guests,
      lines: c.types.map((t) => ({ type: t, qty: c.want[t] })),
      room: Math.round(room), tax, total: Math.round(room + tax), taxPct: c.S.tax,
      paid: pay ? c.total : 0,
      hotel: { name: c.S.hotel.name || '', phone: c.S.hotel.phone || '' },
    },
  };
}

/* Without Razorpay keys: book now, pay at the hotel. With keys: check, make a Razorpay order and wait for payment. */
async function createBooking(input) {
  const p = await prepareBooking(input);
  if (p.out) return p.out;
  if (!payOn()) return saveBooking(p.ctx, null);
  const c = p.ctx, amount = c.total * 100; // Razorpay amounts are in paise
  const order = await rzp('orders', { method: 'POST', body: { amount, currency: 'INR', receipt: 'W' + Date.now().toString(36), notes: { guest: c.name, phone: c.phone, in: c.a, out: c.b } } });
  await upsertDocs([{ path: 'web/pend-' + order.id, coll: 'web', data: { input, amount, at: new Date().toISOString() }, updated_at: new Date().toISOString() }]);
  return {
    status: 200,
    body: { ok: true, pay: { keyId: ENV.RAZORPAY_KEY_ID, orderId: order.id, amount, currency: 'INR', name: c.S.hotel.name || 'Hotel Vijay', description: 'Room booking ' + c.a + ' to ' + c.b, prefill: { name: c.name, contact: c.phone, email: c.email } } },
  };
}

/* Called after a payment is made, by the guest's browser and by Razorpay's webhook. Safe to call twice. */
async function finalizePaid(orderId, paymentId) {
  const key = 'web/pend-' + orderId, lockKey = 'web/lock-' + orderId;
  const result = (d) => (d.done ? { status: 200, body: d.done } : d.failed ? { status: 409, body: { ok: false, soldOut: true, error: d.failMsg } } : null);
  let pend = await getDoc(key);
  if (!pend) return { status: 404, body: { ok: false, error: 'Payment not found. If money was deducted please call the hotel.' } };
  if (result(pend)) return result(pend);

  let got = await claim(lockKey);
  if (!got) { // the other caller is working on it, wait for the result
    for (let i = 0; i < 8; i++) {
      await sleep(1000);
      pend = await getDoc(key);
      if (pend && result(pend)) return result(pend);
    }
    const lk = await getDoc(lockKey);
    if (lk && Date.now() - lk.at > 60000) { await deleteDoc(lockKey); got = await claim(lockKey); }
    if (!got) return { status: 409, body: { ok: false, error: 'We are still confirming your booking. Please call the hotel before paying again.' } };
  }

  const pay = await rzp('payments/' + enc(paymentId));
  if (pay.order_id !== orderId || pay.amount !== pend.amount || !['captured', 'authorized'].includes(pay.status)) {
    await deleteDoc(lockKey).catch(() => {});
    return { status: 402, body: { ok: false, error: 'Payment could not be confirmed. If money was deducted it will be refunded. Please call the hotel.' } };
  }
  if (pay.status === 'authorized') await rzp('payments/' + enc(paymentId) + '/capture', { method: 'POST', body: { amount: pay.amount, currency: 'INR' } });

  const save = async (data) => upsertDocs([{ path: key, coll: 'web', data: { ...pend, paymentId, ...data }, updated_at: new Date().toISOString() }]);
  const refund = async (msg) => { // rooms went while the guest was paying, or the price changed: give the money back
    await rzp('payments/' + enc(paymentId) + '/refund', { method: 'POST', body: { amount: pend.amount, notes: { reason: 'Booking could not be completed' } } }).catch((e) => console.error('refund', e.message));
    const failMsg = msg + ' Your payment is being refunded to your account in 5 to 7 working days.';
    await save({ failed: 1, failMsg });
    return { status: 409, body: { ok: false, soldOut: true, error: failMsg } };
  };

  const p = await prepareBooking(pend.input);
  if (p.out && p.out.body.ok) { await save({ done: p.out.body }); return p.out; } // booking already exists
  if (p.out) return refund(p.out.body.error);
  if (p.ctx.total * 100 !== pend.amount) return refund('The price changed while you were paying.');
  const r = await saveBooking(p.ctx, { id: paymentId });
  if (!r.body.ok) return refund(r.body.error);
  await save({ done: r.body });
  return r;
}

/* ---------- web handling ---------- */
const allowedOrigins = () =>
  String(ENV.ALLOWED_ORIGINS || 'https://hvijayniketan.github.io')
    .split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);

function corsHeaders(request) {
  const origin = (request.headers.get('origin') || '').replace(/\/+$/, '');
  const list = allowedOrigins();
  const ok = list.includes('*') || list.includes(origin);
  const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (ok) {
    h['Access-Control-Allow-Origin'] = list.includes('*') ? '*' : origin;
    h['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return { headers: h, originOk: ok || !origin };
}

function reply(request, status, body) {
  const { headers } = corsHeaders(request);
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

/* Best effort limit per visitor. Each Worker instance keeps its own counter. */
const hits = new Map();
function tooMany(request, key, max, windowMs) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const k = key + ':' + ip;
  const now = Date.now();
  const list = (hits.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(k, list);
  if (hits.size > 5000) for (const [kk, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(kk);
  return list.length > max;
}

function loadSettings(env) {
  ENV = env || {};
  try {
    const g = ENV.GUEST_RATES;
    FILE_RATES = !g ? {} : typeof g === 'object' ? g : JSON.parse(g);
  } catch (e) {
    FILE_RATES = {}; // a typing mistake in GUEST_RATES must not stop bookings
  }
}

export default {
  async fetch(request, env) {
    loadSettings(env);
    const path = new URL(request.url).pathname.replace(/\/+$/, '');
    try {
      if (request.method === 'OPTIONS') return reply(request, 204, {});
      if (!corsHeaders(request).originOk) return reply(request, 403, { ok: false, error: 'Not allowed from this site' });

      if (path.endsWith('/availability')) {
        if (request.method !== 'GET') return reply(request, 405, { ok: false, error: 'Method not allowed' });
        if (tooMany(request, 'avail', 60, 60 * 1000)) return reply(request, 429, { ok: false, error: 'Too many requests. Please wait a minute.' });
        const q = new URL(request.url).searchParams;
        const a = cleanText(q.get('in'), 10);
        const b = cleanText(q.get('out'), 10);
        const bad = validateStay(a, b);
        if (bad) return reply(request, 400, { ok: false, error: bad });
        try {
          const S = await loadState(a);
          const av = availability(S, a, b, cleanText(q.get('code'), 40));
          return reply(request, 200, {
            ok: true, in: a, out: b, ...av, payOnline: payOn(),
            maxRooms: MAX_ROOMS_PER_BOOKING, maxGuestsPerRoom: MAX_GUESTS_PER_ROOM,
            hotel: { name: S.hotel.name || '', phone: S.hotel.phone || '' },
          });
        } catch (e) {
          console.error('availability', e.message);
          return reply(request, 500, { ok: false, error: 'Could not check availability right now. Please call the hotel.' });
        }
      }

      if (path.endsWith('/pay/verify')) {
        if (!payOn()) return reply(request, 404, { ok: false, error: 'Online payment is not switched on.' });
        if (request.method !== 'POST') return reply(request, 405, { ok: false, error: 'Method not allowed' });
        if (tooMany(request, 'pay', 20, 10 * 60 * 1000)) return reply(request, 429, { ok: false, error: 'Too many attempts. Please call the hotel.' });
        let x;
        try { x = JSON.parse((await request.text()) || '{}'); } catch (e) { return reply(request, 400, { ok: false, error: 'Invalid request.' }); }
        const orderId = cleanText(x.orderId, 60), paymentId = cleanText(x.paymentId, 60), sig = cleanText(x.signature, 200);
        if (!orderId || !paymentId || !same(await hmac(ENV.RAZORPAY_KEY_SECRET, orderId + '|' + paymentId), sig)) return reply(request, 400, { ok: false, error: 'Payment could not be verified. Please call the hotel.' });
        try {
          const r = await finalizePaid(orderId, paymentId);
          return reply(request, r.status, r.body);
        } catch (e) {
          console.error('verify', e.message);
          return reply(request, 500, { ok: false, error: 'We received your payment but could not finish the booking. Please call the hotel. Do not pay again.' });
        }
      }

      if (path.endsWith('/razorpay-webhook')) { // Razorpay calls this by itself, so a paid booking is saved even if the guest closes the page
        if (request.method !== 'POST' || !payOn() || !ENV.RAZORPAY_WEBHOOK_SECRET) return reply(request, 404, { ok: false });
        const raw = await request.text();
        if (!same(await hmac(ENV.RAZORPAY_WEBHOOK_SECRET, raw), request.headers.get('x-razorpay-signature') || '')) return reply(request, 400, { ok: false });
        let ev;
        try { ev = JSON.parse(raw); } catch (e) { return reply(request, 400, { ok: false }); }
        const pe = ev && ev.payload && ev.payload.payment && ev.payload.payment.entity;
        if (['payment.captured', 'order.paid'].includes(ev.event) && pe && pe.order_id && pe.id) {
          try { await finalizePaid(pe.order_id, pe.id); } catch (e) { console.error('webhook', e.message); return reply(request, 500, { ok: false }); }
        }
        return reply(request, 200, { ok: true });
      }

      if (path.endsWith('/book')) {
        if (request.method !== 'POST') return reply(request, 405, { ok: false, error: 'Method not allowed' });
        if (tooMany(request, 'book', 5, 10 * 60 * 1000)) return reply(request, 429, { ok: false, error: 'Too many attempts. Please call the hotel to book.' });
        let input;
        try {
          const text = await request.text();
          if (text.length > 20000) throw new Error('big');
          input = JSON.parse(text || '{}');
        } catch (e) {
          return reply(request, 400, { ok: false, error: 'Invalid request.' });
        }
        if (input.hp) return reply(request, 200, { ok: true, ref: 'R0000' }); // bots fill the hidden field
        try {
          const r = await createBooking(input);
          return reply(request, r.status, r.body);
        } catch (e) {
          console.error('book', e.message);
          return reply(request, 500, { ok: false, error: 'Could not complete the booking. Please call the hotel.' });
        }
      }

      return reply(request, 200, { ok: true, service: 'Hotel Vijay booking server' });
    } catch (e) {
      console.error('worker', e.message);
      return reply(request, 500, { ok: false, error: 'Something went wrong. Please call the hotel.' });
    }
  },
};

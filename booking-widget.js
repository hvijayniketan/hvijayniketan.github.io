/*
 * Hotel Vijay booking widget (v4: prices from PMS Rates, Inventory and Promotions; adults / children / child ages, per-room occupancy rules).
 * Add to any page:
 *   <div id="hv-booking"></div>
 *   <script src="booking-widget.js" data-api="https://hotelvijay-booking.vijayniketan5.workers.dev/api" data-whatsapp="919835620220"></script>
 * Optional attributes:
 *   data-accent, data-text, data-on, data-dark
 *   data-rooms='{"AC Standard":{"title":"AC Room","desc":"..."}}'
 *   data-rules='{"AC Standard":{"minAdults":1,"maxAdults":3,"maxTotal":3,"combos":[[2,2]],"msg":"..."}}'
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var DEFAULT_API = 'https://hotelvijay-booking.vijayniketan5.workers.dev/api';
  var API = (script.getAttribute('data-api') || '').replace(/\/+$/, '');
  // Netlify was shut down: ignore any old netlify.app address and use the Cloudflare Worker.
  if (!API || /netlify/i.test(API)) API = DEFAULT_API;
  var WA = (script.getAttribute('data-whatsapp') || '').replace(/\D/g, '');
  var ACCENT = script.getAttribute('data-accent') || '#0e7a8c';
  var TEXT = script.getAttribute('data-text') || '';
  var ON = script.getAttribute('data-on') || '#fff';
  var DARK = script.getAttribute('data-dark') === '1';
  var mount = document.getElementById(script.getAttribute('data-target') || 'hv-booking');
  if (!mount) return;
  function parseAttr(n) { try { return JSON.parse(script.getAttribute(n) || '{}'); } catch (e) { return {}; } }
  var INFO = parseAttr('data-rooms'), RULES = parseAttr('data-rules');

  var ADULT_FROM_AGE = 5;   // child aged 5 or more is treated as an adult
  var MAX_ROOMS = 5, MAX_ADULTS = 6, MAX_KIDS = 4, MAX_AGE = 12;

  /* ---------- occupancy rules ---------- */
  var STD = { minAdults: 1, maxAdults: 3, maxTotal: 3, combos: [[2, 2]], msg: 'Up to 3 guests, or 2 adults with 2 children aged 4 or under.' };
  var FAM = { minAdults: 4, maxAdults: 6, maxTotal: 8, maxKids: 2, msg: 'For 4 to 6 adults. Children aged 5 and above count as adults.' };
  function ruleFor(type) {
    var base = /family/i.test(type) ? FAM : STD, o = RULES[type] || {}, r = {};
    for (var k in base) r[k] = base[k];
    for (var k2 in o) r[k2] = o[k2];
    return r;
  }
  // adults = adults + children aged 5+, k = children aged 4 or under
  function occ(r) {
    var a = r.adults, k = 0;
    r.kids.forEach(function (x) { if (+x >= ADULT_FROM_AGE) a++; else k++; });
    return { a: a, k: k };
  }
  function fits(type, r) {
    var o = occ(r), R = ruleFor(type);
    if (o.a < R.minAdults || o.a > R.maxAdults) return false;
    if (o.a + o.k <= R.maxTotal && o.k <= (R.maxKids == null ? 99 : R.maxKids)) return true;
    return (R.combos || []).some(function (c) { return o.a === c[0] && o.k <= c[1]; });
  }

  /* ---------- styles ---------- */
  var css = '\
.hvb{--a:' + ACCENT + ';font:inherit;color:' + (TEXT || 'inherit') + ';max-width:880px;margin:0 auto;text-align:left}\
.hvb *{box-sizing:border-box}\
.hvb .box{border:1px solid rgba(127,127,127,.35);border-radius:12px;padding:18px;background:rgba(127,127,127,.06)}\
.hvb h3{margin:0 0 12px;font-size:1.15em;font-family:inherit;color:inherit;font-weight:600;letter-spacing:0}\
.hvb .g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}\
.hvb label{display:flex;flex-direction:column;gap:4px;font-size:.85em;opacity:.95}\
.hvb input,.hvb select{font:inherit;color:inherit;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.4);border-radius:8px;padding:10px;width:100%;min-height:44px}\
.hvb input:focus,.hvb select:focus,.hvb button:focus-visible{outline:2px solid var(--a);outline-offset:2px}\
.hvb button{font:inherit;cursor:pointer;border-radius:8px;padding:11px 18px;border:1px solid var(--a);background:transparent;color:inherit;min-height:44px}\
.hvb button.p{background:var(--a);color:' + ON + ';font-weight:600}\
.hvb button:disabled{opacity:.5;cursor:not-allowed}\
.hvb .rm{border:1px solid rgba(127,127,127,.3);border-radius:10px;padding:14px;margin-top:12px;background:rgba(127,127,127,.05)}\
.hvb .rm>b{display:block;margin-bottom:10px;font-size:1.02em}\
.hvb .ages{margin-top:10px;padding-top:10px;border-top:1px dashed rgba(127,127,127,.3)}\
.hvb .hint{font-size:.8em;opacity:.75;margin-top:6px}\
.hvb .opt{flex-direction:row;align-items:center;gap:12px;border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:12px;margin-top:8px;cursor:pointer;font-size:1em}\
.hvb .opt.sel{border-color:var(--a);box-shadow:0 0 0 1px var(--a)}\
.hvb .opt.dis{opacity:.5;cursor:not-allowed}\
.hvb .opt input[type=radio]{width:auto;min-height:0;flex:0 0 auto;accent-color:var(--a)}\
.hvb .rt{flex:1 1 200px}.hvb .rt b{font-size:1.05em}.hvb .rt small{display:block;opacity:.75;margin-top:2px;font-size:.85em}\
.hvb .pr{text-align:right;min-width:130px}.hvb .pr b{font-size:1.15em}.hvb .pr small{display:block;opacity:.75;font-size:.8em}\
.hvb .low{color:#b86e00;font-weight:600;opacity:1!important}\
.hvb .err{color:#b3332f;font-weight:500;margin:10px 0 0;min-height:1.3em}\
.hvb .bar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:14px}\
.hvb .ok{border-left:4px solid var(--a);padding-left:14px}\
.hvb table{border-collapse:collapse;width:100%;margin:10px 0}\
.hvb td{padding:6px 0;border-bottom:1px solid rgba(127,127,127,.25);vertical-align:top}.hvb td:last-child{text-align:right}\
.hvb .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}\
.hvb .mut{opacity:.75;font-size:.9em}\
.hvb a.btn{display:inline-block;text-decoration:none;border-radius:8px;padding:11px 18px;border:1px solid var(--a);color:inherit}\
.hvb .box p{max-width:none;margin:8px 0;font-size:inherit;line-height:1.5;color:inherit}\
.hvb .box p.mut{opacity:.75;font-size:.9em}\
.hvb select option{background:Canvas;color:CanvasText}\
.hvb .sum{border:1px solid rgba(127,127,127,.3);border-radius:10px;padding:12px 14px;margin:10px 0;background:rgba(127,127,127,.05)}\
.hvb .sum div{padding:3px 0}\
.hvb .was{text-decoration:line-through;opacity:.6}.hvb .promo{color:var(--a);font-weight:600;opacity:1!important}\
' + (DARK ? '.hvb input,.hvb select{color-scheme:dark}' : '') + '\
';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  /* ---------- helpers ---------- */
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var money = function (n) { return '₹' + Math.round(n).toLocaleString('en-IN'); };
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var addDays = function (s, n) { var d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  var fmtD = function (s) { var p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; };
  var title = function (t) { return (INFO[t] && INFO[t].title) || t; };
  var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };
  var ageTxt = function (a) { return +a === 0 ? 'under 1 year' : plural(+a, 'year'); };
  function occLabel(r) {
    var s = plural(r.adults, 'adult');
    if (r.kids.length) s += ', ' + plural(r.kids.length, 'child') + ' (age ' + r.kids.map(function (a) { return a === '' ? '?' : (+a === 0 ? '<1' : a); }).join(', ') + ')';
    return s;
  }
  var newRoom = function () { return { adults: 2, kids: [] }; };

  var today = ymd(new Date());
  var QP = {}; (location.search || '').replace(/^\?/, '').split('&').forEach(function (x) { var k = x.split('='); if (k[0]) QP[k[0]] = decodeURIComponent(k[1] || ''); });
  var S = { code: '', step: 1, in: /^\d{4}-\d\d-\d\d$/.test(QP.in || '') && QP.in >= today ? QP.in : today, out: '', rooms: [newRoom()], av: null, pick: [], busy: false, err: '', guest: { name: '', phone: '', email: '', nationality: 'Indian' }, done: null, snap: null };

  S.out = /^\d{4}-\d\d-\d\d$/.test(QP.out || '') && QP.out > S.in ? QP.out : addDays(S.in, 1);

  function api(path, opt) {
    return fetch(API + path, opt).then(function (r) { return r.json().then(function (j) { j._status = r.status; return j; }); });
  }
  function typeInfo(type) { return S.av.types.filter(function (t) { return t.type === type; })[0]; }

  // price of one room: the server prices each room by number of adults (children aged 4 and under are free)
  function roomPrice(type, r) {
    var t = typeInfo(type), p = t.byAdults && t.byAdults[occ(r).a];
    return p ? { total: p.total, perNight: p.perNight, was: p.wasTotal || p.total, promo: p.promo || '', incl: p.incl || [] } : { total: t.total, perNight: t.perNight, was: t.total, promo: '', incl: [] };
  }
  function usedOf(type, except) {
    var n = 0;
    S.pick.forEach(function (p, i) { if (p === type && i !== except) n++; });
    return n;
  }
  function totals() {
    var rooms = 0, total = 0;
    S.pick.forEach(function (p, i) { if (p && S.av) { rooms++; total += roomPrice(p, S.rooms[i]).total; } });
    return { rooms: rooms, total: total };
  }
  function people() {
    var a = 0, c = 0;
    S.rooms.forEach(function (r) { a += r.adults; c += r.kids.length; });
    return { adults: a, kids: c, all: a + c };
  }
  function readDates() {
    var a = $('#hin'), b = $('#hout');
    if (a && b) { S.in = a.value; S.out = b.value; }
    var c = $('#hcode'); if (c) S.code = c.value.trim();
  }

  /* ---------- views ---------- */
  function view() {
    if (S.done) return viewDone();
    if (S.step === 3) return viewGuest();
    return viewSearch();
  }

  function opts(from, to, sel, fmt) {
    var h = '';
    for (var i = from; i <= to; i++) h += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + (fmt ? fmt(i) : i) + '</option>';
    return h;
  }

  function roomForm(r, i) {
    var h = '<div class="rm"><b>Room ' + (i + 1) + '</b><div class="g">' +
      '<label>Adults (13 years and above)<select data-ad="' + i + '">' + opts(1, MAX_ADULTS, r.adults) + '</select></label>' +
      '<label>Children (0 to 12 years)<select data-kd="' + i + '">' + opts(0, MAX_KIDS, r.kids.length) + '</select></label></div>';
    if (r.kids.length) {
      h += '<div class="ages"><div class="g">';
      r.kids.forEach(function (a, j) {
        h += '<label>Age of child ' + (j + 1) + '<select data-ag="' + i + '-' + j + '"><option value="">Select age</option>' + opts(0, MAX_AGE, a === '' ? -1 : +a, function (n) { return n === 0 ? 'Under 1 year' : plural(n, 'year'); }) + '</select></label>';
      });
      h += '</div><div class="hint">Children aged ' + ADULT_FROM_AGE + ' to ' + MAX_AGE + ' are counted and charged as adults. Children aged 4 and under are counted as children.</div></div>';
    }
    return h + '</div>';
  }

  function viewSearch() {
    var h = '<div class="box"><h3>Check availability</h3><div class="g">' +
      '<label>Check-in<input type="date" id="hin" min="' + today + '" value="' + S.in + '"></label>' +
      '<label>Check-out<input type="date" id="hout" min="' + addDays(S.in, 1) + '" value="' + S.out + '"></label>' +
      '<label>Rooms<select id="hrooms">' + opts(1, MAX_ROOMS, S.rooms.length) + '</select></label>' +
      '<label>Coupon code (optional)<input id="hcode" autocomplete="off" value="' + esc(S.code) + '"></label></div>' +
      S.rooms.map(roomForm).join('') +
      '<div class="bar"><div class="mut">' + plural(people().adults, 'adult') + (people().kids ? ', ' + plural(people().kids, 'child') : '') + ' in ' + plural(S.rooms.length, 'room') + '</div>' +
      '<button class="p" id="hcheck"' + (S.busy ? ' disabled' : '') + '>' + (S.busy && !S.av ? 'Checking...' : 'Check availability') + '</button></div>' +
      '<p class="err" role="alert">' + (S.av ? '' : esc(S.err)) + '</p></div>';
    if (S.av) h += viewResults();
    return h;
  }

  function viewResults() {
    var T = totals(), allPicked = T.rooms === S.rooms.length;
    var h = '<div class="box" style="margin-top:14px"><h3>' + plural(S.av.nights, 'night') + ', ' + fmtD(S.in) + ' to ' + fmtD(S.out) + '</h3>';
    S.rooms.forEach(function (r, i) {
      var any = false;
      h += '<div class="rm"><b>Room ' + (i + 1) + ': ' + esc(occLabel(r)) + '</b>';
      S.av.types.forEach(function (t) {
        var ok = fits(t.type, r), left = t.free - usedOf(t.type, i), sel = S.pick[i] === t.type;
        var disabled = !ok || (left <= 0 && !sel);
        if (ok && left > 0) any = true;
        var p = ok ? roomPrice(t.type, r) : null, inf = INFO[t.type] || {};
        h += '<label class="opt' + (sel ? ' sel' : '') + (disabled ? ' dis' : '') + '"><input type="radio" name="rp' + i + '" data-r="' + i + '" data-t="' + esc(t.type) + '"' + (sel ? ' checked' : '') + (disabled ? ' disabled' : '') + '>' +
          '<span class="rt"><b>' + esc(title(t.type)) + '</b>' + (inf.desc ? '<small>' + esc(inf.desc) + '</small>' : '') + (p && p.incl.length ? '<small class="promo">Includes: ' + esc(p.incl.join(', ')) + '</small>' : '') +
          (!ok ? '<small>Not suitable for this group. ' + esc(ruleFor(t.type).msg) + '</small>' : t.free === 0 ? '<small class="low">' + esc(t.reason || 'Sold out') + '</small>' : (t.free <= 3 ? '<small class="low">Only ' + t.free + ' left</small>' : '')) + '</span>' +
          (p ? '<span class="pr">' + (p.was > p.total ? '<small class="was">' + money(p.was) + '</small>' : '') + '<b>' + money(p.total) + '</b>' + (p.promo ? '<small class="promo">' + esc(p.promo) + '</small>' : '') + '<small>' + money(p.perNight) + ' a night + ' + (S.av.taxPct || 0) + '% GST</small></span>' : '') + '</label>';
      });
      if (!any) h += '<p class="mut">No room type is available for this group. Try adding another room or changing dates, or call the hotel.</p>';
      h += '</div>';
    });
    h += (S.av.codeOk === false ? '<p class="err">That coupon code is not valid for these dates.</p>' : S.av.codeOk ? '<p class="mut">Coupon applied.</p>' : '') + '<p class="err" role="alert">' + esc(S.err) + '</p>' +
      '<div class="bar"><div><b>' + plural(T.rooms, 'room') + ' selected</b>' + (T.rooms ? ', total ' + money(T.total) + ' including GST' : '') + '<div class="mut">' + (S.av && S.av.payOnline ? 'Pay securely online with Razorpay (UPI, cards, net banking).' : 'Pay at the hotel. No card needed.') + '</div></div>' +
      '<button class="p" id="hnext"' + (allPicked ? '' : ' disabled') + '>Continue</button></div></div>';
    return h;
  }

  function summaryHtml() {
    return '<div class="sum">' + S.rooms.map(function (r, i) {
      return '<div><b>Room ' + (i + 1) + ':</b> ' + esc(title(S.pick[i])) + ', ' + esc(occLabel(r)) + '</div>';
    }).join('') + '<div class="mut">' + fmtD(S.in) + ' to ' + fmtD(S.out) + ', ' + plural(S.av.nights, 'night') + '</div></div>';
  }

  function viewGuest() {
    var T = totals(), g = S.guest;
    return '<div class="box"><h3>Your details</h3>' + summaryHtml() +
      '<p class="mut">Total ' + money(T.total) + ' including GST, ' + (S.av && S.av.payOnline ? 'paid online now through Razorpay.' : 'payable at the hotel.') + '</p>' +
      '<div class="g" style="margin-top:12px"><label>Full name<input id="gn" autocomplete="name" value="' + esc(g.name) + '"></label>' +
      '<label>Mobile number<input id="gp" type="tel" autocomplete="tel" inputmode="tel" value="' + esc(g.phone) + '"></label>' +
      '<label>Email, optional<input id="ge" type="email" autocomplete="email" value="' + esc(g.email) + '"></label>' +
      '<label>Nationality<input id="gt" value="' + esc(g.nationality) + '"></label></div>' +
      '<div class="hp" aria-hidden="true"><label>Website<input id="ghp" tabindex="-1" autocomplete="off"></label></div>' +
      '<p class="mut">Check-in after 10:00 AM. Please carry a valid photo ID for every adult and for children aged ' + ADULT_FROM_AGE + ' and above.</p><p class="err" role="alert">' + esc(S.err) + '</p>' +
      '<div class="bar"><button id="hback">Back</button><button class="p" id="hconfirm"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? (S.msg || 'Please wait...') : (S.av && S.av.payOnline ? 'Pay ' + money(totals().total) + ' and confirm' : 'Confirm booking')) + '</button></div></div>';
  }

  function viewDone() {
    var d = S.done, sn = S.snap || [];
    var msg = 'Hello, I booked online. Booking ' + d.ref + ' for ' + d.name + ', ' + fmtD(d.in) + ' to ' + fmtD(d.out) + '. ' + sn.map(function (x, i) { return 'Room ' + (i + 1) + ' ' + x.title + ': ' + x.occ; }).join('; ') + '.';
    return '<div class="box ok"><h3>Booking confirmed</h3><p>Thank you, ' + esc(d.name) + '. Your booking number is <b>' + esc(d.ref) + '</b>. Please keep it for check-in.</p>' +
      '<table>' + sn.map(function (x, i) { return '<tr><td>Room ' + (i + 1) + '</td><td>' + esc(x.title) + '<br><span class="mut">' + esc(x.occ) + '</span></td></tr>'; }).join('') +
      '<tr><td>Check-in</td><td>' + fmtD(d.in) + ' (after 10:00 AM)</td></tr><tr><td>Check-out</td><td>' + fmtD(d.out) + '</td></tr>' +
      (d.total ? '<tr><td>Total including GST</td><td>' + money(d.total) + '</td></tr><tr><td>Payment</td><td>' + (d.paid ? 'Paid online, ' + money(d.paid) : 'At the hotel') + '</td></tr>' : '') + '</table>' +
      '<p class="mut">Your room number is given at check-in. Carry a valid photo ID.</p>' +
            (d.slipUrl ? '<p class="mut">Please save your booking slip now. Open it and choose Download / Print as PDF.</p><div class="bar"><a class="btn" target="_blank" rel="noopener" href="' + esc(d.slipUrl) + '">Download booking slip (PDF)</a><a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent('My booking slip ' + d.ref + ': ' + d.slipUrl) + '">Share slip on WhatsApp</a></div>' : '') +
      '<div class="bar">' + (WA ? '<a class="btn" target="_blank" rel="noopener" href="https://wa.me/' + WA + '?text=' + encodeURIComponent(msg) + '">Message the hotel on WhatsApp</a>' : '') + '<button id="hnew">Make another booking</button></div></div>';
  }

  function draw() { mount.innerHTML = '<div class="hvb">' + view() + '</div>'; bind(); }
  function $(id) { return mount.querySelector(id); }
  function resetResults() { S.av = null; S.pick = []; S.err = ''; }

  /* ---------- actions ---------- */
  function check() {
    readDates();
    S.err = '';
    if (!S.in || !S.out || S.out <= S.in) { S.err = 'Check-out must be after check-in.'; draw(); return; }
    for (var i = 0; i < S.rooms.length; i++) {
      for (var j = 0; j < S.rooms[i].kids.length; j++) {
        if (S.rooms[i].kids[j] === '') { S.err = 'Please select the age of every child (Room ' + (i + 1) + ', child ' + (j + 1) + ').'; draw(); return; }
      }
    }
    S.busy = true; S.av = null; S.pick = []; draw();
    api('/availability?in=' + S.in + '&out=' + S.out + (S.code ? '&code=' + encodeURIComponent(S.code) : '')).then(function (j) {
      S.busy = false;
      if (!j.ok) { S.err = j.error || 'Could not check availability.'; S.av = null; }
      else {
        S.av = j;
        S.pick = S.rooms.map(function (r) {
          var good = j.types.filter(function (t) { return t.free > 0 && fits(t.type, r); });
          return good.length === 1 ? good[0].type : '';
        });
      }
      draw();
    }).catch(function () { S.busy = false; S.err = 'No connection. Please try again or call the hotel.'; draw(); });
  }

  function loadRzp(cb, fail) {
    if (window.Razorpay) return cb();
    var sc = document.createElement('script'); sc.src = 'https://checkout.razorpay.com/v1/checkout.js';
    sc.onload = cb; sc.onerror = fail; document.head.appendChild(sc);
  }
  // Razorpay window. Nothing is booked until the payment is made and confirmed by the server.
  function pay(o, snap) {
    var stop = function (m) { S.busy = false; S.msg = ''; S.err = m; draw(); };
    loadRzp(function () {
      var rz = new window.Razorpay({
        key: o.keyId, amount: o.amount, currency: o.currency, name: o.name, description: o.description, order_id: o.orderId, prefill: o.prefill,
        theme: { color: '#b8903a' },
        handler: function (r) {
          S.msg = 'Confirming your booking...'; draw();
          api('/pay/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }) })
            .then(function (j) {
              S.busy = false; S.msg = '';
              if (j.ok) { S.done = j; S.snap = snap; draw(); mount.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
              S.err = j.error || 'We could not confirm your booking. Please call the hotel. Do not pay again.';
              if (j.soldOut) { var m = S.err; S.step = 1; check(); S.err = m; } else draw();
            }).catch(function () { stop('Payment received, but we lost the connection. Please call the hotel to confirm your booking. Do not pay again.'); });
        },
        modal: { ondismiss: function () { if (!S.done && S.msg === 'Waiting for payment...') stop('Payment was not completed. No booking was made.'); } },
      });
      rz.on('payment.failed', function (e) { S.msg = 'Waiting for payment...'; S.err = (e && e.error && e.error.description) || 'Payment failed. Please try again.'; });
      rz.open();
    }, function () { stop('Could not open the payment window. Check your internet and try again.'); });
  }

  function confirm() {
    var g = S.guest;
    g.name = $('#gn').value.trim(); g.phone = $('#gp').value.trim(); g.email = $('#ge').value.trim(); g.nationality = $('#gt').value.trim() || 'Indian';
    if (g.name.length < 2) { S.err = 'Enter your name.'; draw(); return; }
    if (g.phone.replace(/\D/g, '').length < 10) { S.err = 'Enter a valid mobile number.'; draw(); return; }
    S.err = ''; S.busy = true; draw();
    var counts = {}, occupancy = [];
    S.rooms.forEach(function (r, i) {
      var o = occ(r);
      counts[S.pick[i]] = (counts[S.pick[i]] || 0) + 1;
      occupancy.push({ room: i + 1, type: S.pick[i], adults: r.adults, children: r.kids.length, childAges: r.kids.map(Number), billedAdults: o.a, infants: o.k });
    });
    var rooms = Object.keys(counts).map(function (k) { return { type: k, qty: counts[k] }; });
    var P = people();
    var snap = S.rooms.map(function (r, i) { return { title: title(S.pick[i]), occ: occLabel(r) }; });
    api('/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ in: S.in, out: S.out, guests: P.all, adults: P.adults, children: P.kids, rooms: rooms, occupancy: occupancy, code: S.code, quoted: totals().total, guest: g, hp: ($('#ghp') || {}).value || '' }) })
      .then(function (j) {
        S.busy = false;
        if (j.ok && j.pay) { S.busy = true; S.msg = 'Waiting for payment...'; draw(); return pay(j.pay, snap); }
        if (j.ok) { S.done = j; S.snap = snap; draw(); mount.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        S.err = j.error || 'Could not complete the booking.';
        if (j.soldOut) { var m = S.err; S.step = 1; check(); S.err = m; } else draw();
      }).catch(function () { S.busy = false; S.err = 'No connection. Your booking was not made. Please try again or call the hotel.'; draw(); });
  }

  function bind() {
    var el;
    if ((el = $('#hcheck'))) el.onclick = check;
    if ((el = $('#hin'))) el.onchange = function () { var v = this.value; if (v && $('#hout').value <= v) $('#hout').value = addDays(v, 1); $('#hout').min = addDays(v, 1); readDates(); resetResults(); draw(); };
    if ((el = $('#hout'))) el.onchange = function () { readDates(); resetResults(); draw(); };
    if ((el = $('#hrooms'))) el.onchange = function () {
      readDates();
      var n = +this.value;
      while (S.rooms.length < n) S.rooms.push(newRoom());
      S.rooms.length = n;
      resetResults(); draw();
    };
    mount.querySelectorAll('select[data-ad]').forEach(function (s) {
      s.onchange = function () { readDates(); S.rooms[+this.getAttribute('data-ad')].adults = +this.value; resetResults(); draw(); };
    });
    mount.querySelectorAll('select[data-kd]').forEach(function (s) {
      s.onchange = function () {
        readDates();
        var r = S.rooms[+this.getAttribute('data-kd')], n = +this.value;
        while (r.kids.length < n) r.kids.push('');
        r.kids.length = n;
        resetResults(); draw();
      };
    });
    mount.querySelectorAll('select[data-ag]').forEach(function (s) {
      s.onchange = function () {
        readDates();
        var p = this.getAttribute('data-ag').split('-');
        S.rooms[+p[0]].kids[+p[1]] = this.value === '' ? '' : +this.value;
        resetResults(); draw();
      };
    });
    mount.querySelectorAll('input[data-r]').forEach(function (inp) {
      inp.onchange = function () {
        var i = +this.getAttribute('data-r'), t = this.getAttribute('data-t');
        var tt = typeInfo(t);
        if (usedOf(t, i) >= tt.free) { S.err = 'Only ' + plural(tt.free, 'room') + ' of this type available.'; draw(); return; }
        S.pick[i] = t; S.err = ''; draw();
      };
    });
    if ((el = $('#hnext'))) el.onclick = function () {
      for (var i = 0; i < S.rooms.length; i++) {
        if (!S.pick[i] || !fits(S.pick[i], S.rooms[i])) { S.err = 'Please choose a room type for Room ' + (i + 1) + '.'; draw(); return; }
      }
      S.err = ''; S.step = 3; draw();
    };
    if ((el = $('#hback'))) el.onclick = function () { S.step = 1; S.err = ''; draw(); };
    if ((el = $('#hconfirm'))) el.onclick = confirm;
    if ((el = $('#hnew'))) el.onclick = function () { S.done = null; S.step = 1; S.rooms = [newRoom()]; resetResults(); draw(); };
  }

  draw();
  if (QP.in && QP.out) check();
})();

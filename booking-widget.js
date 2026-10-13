/*
 * Hotel Vijay booking widget.
 * Add to any page:
 *   <div id="hv-booking"></div>
 *   <script src="booking-widget.js" data-api="https://YOUR-SITE.netlify.app/api" data-whatsapp="919835620220"></script>
 * Optional: data-accent="#0e7a8c", data-rooms='{"AC Standard":{"title":"AC Room","desc":"King bed, AC, LED TV, Wi-Fi"}}'
 */
(function () {
  'use strict';
  var script = document.currentScript;
  var API = (script.getAttribute('data-api') || '').replace(/\/+$/, '');
  var WA = (script.getAttribute('data-whatsapp') || '').replace(/\D/g, '');
  var ACCENT = script.getAttribute('data-accent') || '#0e7a8c';
  var TEXT = script.getAttribute('data-text') || '';
  var ON = script.getAttribute('data-on') || '#fff';
  var DARK = script.getAttribute('data-dark') === '1';
  var mount = document.getElementById(script.getAttribute('data-target') || 'hv-booking');
  if (!mount) return;
  var INFO = {};
  try { INFO = JSON.parse(script.getAttribute('data-rooms') || '{}'); } catch (e) {}

  var css = '\
.hvb{--a:' + ACCENT + ';font:inherit;color:' + (TEXT || 'inherit') + ';max-width:880px;margin:0 auto;text-align:left}\
.hvb *{box-sizing:border-box}\
.hvb .box{border:1px solid rgba(127,127,127,.35);border-radius:12px;padding:18px;background:rgba(127,127,127,.06)}\
.hvb h3{margin:0 0 12px;font-size:1.15em}\
.hvb .g{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}\
.hvb label{display:flex;flex-direction:column;gap:4px;font-size:.85em;opacity:.9}\
.hvb input,.hvb select{font:inherit;color:inherit;background:rgba(127,127,127,.1);border:1px solid rgba(127,127,127,.4);border-radius:8px;padding:10px;width:100%;min-height:44px}\
.hvb input:focus,.hvb select:focus,.hvb button:focus-visible{outline:2px solid var(--a);outline-offset:2px}\
.hvb button{font:inherit;cursor:pointer;border-radius:8px;padding:11px 18px;border:1px solid var(--a);background:transparent;color:inherit;min-height:44px}\
.hvb button.p{background:var(--a);color:' + ON + ';font-weight:600}\
.hvb button:disabled{opacity:.5;cursor:not-allowed}\
.hvb .row{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:14px 0;border-top:1px solid rgba(127,127,127,.3)}\
.hvb .row:first-of-type{border-top:0}\
.hvb .rt{flex:1 1 240px}.hvb .rt b{font-size:1.05em}.hvb .rt small{display:block;opacity:.75;margin-top:2px}\
.hvb .pr{text-align:right;min-width:130px}.hvb .pr b{font-size:1.15em}.hvb .pr small{display:block;opacity:.75}\
.hvb .qt{width:84px}\
.hvb .low{color:#b86e00;font-weight:600}\
.hvb .err{color:#b3332f;font-weight:500;margin:10px 0 0;min-height:1.3em}\
.hvb .bar{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-top:14px}\
.hvb .ok{border-left:4px solid var(--a);padding-left:14px}\
.hvb table{border-collapse:collapse;width:100%;margin:10px 0}\
.hvb td{padding:6px 0;border-bottom:1px solid rgba(127,127,127,.25)}.hvb td:last-child{text-align:right}\
.hvb .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}\
.hvb .mut{opacity:.75;font-size:.9em}\
.hvb a.btn{display:inline-block;text-decoration:none;border-radius:8px;padding:11px 18px;border:1px solid var(--a);color:inherit}\
.hvb .box p{max-width:none;margin:8px 0;font-size:inherit;line-height:1.5;color:inherit}\
.hvb .box p.mut{opacity:.75;font-size:.9em}\
.hvb select option{background:Canvas;color:CanvasText}\
.hvb h3{font-family:inherit;color:inherit;font-weight:600;letter-spacing:0}\
.hvb a.btn{color:inherit}\
' + (DARK ? '.hvb input,.hvb select{color-scheme:dark}' : '') + '\
';
  var st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var money = function (n) { return '₹' + Math.round(n).toLocaleString('en-IN'); };
  var ymd = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  var addDays = function (s, n) { var d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return ymd(d); };
  var fmtD = function (s) { var p = s.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; };
  var title = function (t) { return (INFO[t] && INFO[t].title) || t; };

  var today = ymd(new Date());
  var S = { step: 1, in: today, out: addDays(today, 1), guests: 2, av: null, qty: {}, busy: false, err: '', guest: { name: '', phone: '', email: '', nationality: 'Indian' }, done: null };

  function api(path, opt) {
    return fetch(API + path, opt).then(function (r) { return r.json().then(function (j) { j._status = r.status; return j; }); });
  }

  function totals() {
    var rooms = 0, total = 0;
    if (S.av) S.av.types.forEach(function (t) { var q = +S.qty[t.type] || 0; rooms += q; total += q * t.total; });
    return { rooms: rooms, total: total };
  }

  function view() {
    if (S.done) return viewDone();
    if (S.step === 3) return viewGuest();
    return viewSearch();
  }

  function viewSearch() {
    var h = '<div class="box"><h3>Check availability</h3><div class="g">' +
      '<label>Check-in<input type="date" id="hin" min="' + today + '" value="' + S.in + '"></label>' +
      '<label>Check-out<input type="date" id="hout" min="' + addDays(S.in, 1) + '" value="' + S.out + '"></label>' +
      '<label>Guests<select id="hg">' + [1, 2, 3, 4, 5, 6, 8, 10].map(function (n) { return '<option ' + (n === S.guests ? 'selected' : '') + '>' + n + '</option>'; }).join('') + '</select></label>' +
      '<label>&nbsp;<button class="p" id="hcheck"' + (S.busy ? ' disabled' : '') + '>' + (S.busy && !S.av ? 'Checking...' : 'Check availability') + '</button></label></div>' +
      '<p class="err" role="alert">' + esc(S.err) + '</p></div>';
    if (S.av) {
      var T = totals();
      h += '<div class="box" style="margin-top:14px"><h3>' + S.av.nights + ' night' + (S.av.nights > 1 ? 's' : '') + ', ' + fmtD(S.in) + ' to ' + fmtD(S.out) + '</h3>';
      if (!S.av.types.some(function (t) { return t.free > 0; })) h += '<p>No rooms are available for these dates. Please try other dates or call the hotel.</p>';
      S.av.types.forEach(function (t) {
        var inf = INFO[t.type] || {};
        h += '<div class="row"><div class="rt"><b>' + esc(title(t.type)) + '</b>' + (inf.desc ? '<small>' + esc(inf.desc) + '</small>' : '') +
          (t.free === 0 ? '<small class="low">Sold out</small>' : t.free <= 3 ? '<small class="low">Only ' + t.free + ' left</small>' : '') + '</div>' +
          '<div class="pr"><b>' + money(t.total) + '</b><small>' + money(t.perNight) + ' a night + ' + S.av.taxPct + '% GST</small></div>' +
          '<label class="qt">Rooms<select data-t="' + esc(t.type) + '"' + (t.free === 0 ? ' disabled' : '') + '>' +
          Array.apply(null, Array(t.free + 1)).map(function (_, i) { return '<option ' + (i === (+S.qty[t.type] || 0) ? 'selected' : '') + '>' + i + '</option>'; }).join('') + '</select></label></div>';
      });
      h += '<div class="bar"><div><b>' + T.rooms + ' room' + (T.rooms === 1 ? '' : 's') + '</b>' + (T.rooms ? ', total ' + money(T.total) + ' including GST' : '') + '<div class="mut">Pay at the hotel. No card needed.</div></div><button class="p" id="hnext"' + (T.rooms ? '' : ' disabled') + '>Continue</button></div></div>';
    }
    return h;
  }

  function viewGuest() {
    var T = totals(), g = S.guest;
    var lines = S.av.types.filter(function (t) { return +S.qty[t.type] > 0; }).map(function (t) { return S.qty[t.type] + ' x ' + title(t.type); }).join(', ');
    return '<div class="box"><h3>Your details</h3><p class="mut">' + esc(lines) + ', ' + fmtD(S.in) + ' to ' + fmtD(S.out) + ', ' + S.guests + ' guest' + (S.guests > 1 ? 's' : '') + '. Total ' + money(T.total) + ' including GST, payable at the hotel.</p>' +
      '<div class="g" style="margin-top:12px"><label>Full name<input id="gn" autocomplete="name" value="' + esc(g.name) + '"></label>' +
      '<label>Mobile number<input id="gp" type="tel" autocomplete="tel" inputmode="tel" value="' + esc(g.phone) + '"></label>' +
      '<label>Email, optional<input id="ge" type="email" autocomplete="email" value="' + esc(g.email) + '"></label>' +
      '<label>Nationality<input id="gt" value="' + esc(g.nationality) + '"></label></div>' +
      '<div class="hp" aria-hidden="true"><label>Website<input id="ghp" tabindex="-1" autocomplete="off"></label></div>' +
      '<p class="mut">Check-in after 10:00 AM. Please carry a valid photo ID for every guest.</p><p class="err" role="alert">' + esc(S.err) + '</p>' +
      '<div class="bar"><button id="hback">Back</button><button class="p" id="hconfirm"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Booking...' : 'Confirm booking') + '</button></div></div>';
  }

  function viewDone() {
    var d = S.done;
    var msg = 'Hello, I booked online. Booking ' + d.ref + ' for ' + d.name + ', ' + fmtD(d.in) + ' to ' + fmtD(d.out) + '.';
    var lines = (d.lines || []).map(function (l) { return l.qty + ' x ' + title(l.type); }).join(', ');
    return '<div class="box ok"><h3>Booking confirmed</h3><p>Thank you, ' + esc(d.name) + '. Your booking number is <b>' + esc(d.ref) + '</b>. Please keep it for check-in.</p>' +
      '<table>' + (lines ? '<tr><td>Rooms</td><td>' + esc(lines) + '</td></tr>' : '') +
      '<tr><td>Check-in</td><td>' + fmtD(d.in) + ' (after 10:00 AM)</td></tr><tr><td>Check-out</td><td>' + fmtD(d.out) + '</td></tr>' +
      (d.total ? '<tr><td>Total including GST</td><td>' + money(d.total) + '</td></tr><tr><td>Payment</td><td>At the hotel</td></tr>' : '') + '</table>' +
      '<p class="mut">Your room number is given at check-in. Carry a valid photo ID.</p>' +
      '<div class="bar">' + (WA ? '<a class="btn" target="_blank" rel="noopener" href="https://wa.me/' + WA + '?text=' + encodeURIComponent(msg) + '">Message the hotel on WhatsApp</a>' : '') + '<button id="hnew">Make another booking</button></div></div>';
  }

  function draw() { mount.innerHTML = '<div class="hvb">' + view() + '</div>'; bind(); }
  function $(id) { return mount.querySelector(id); }

  function check() {
    var a = $('#hin').value, b = $('#hout').value;
    S.in = a; S.out = b; S.guests = +$('#hg').value; S.err = '';
    if (!a || !b || b <= a) { S.err = 'Check-out must be after check-in.'; draw(); return; }
    S.busy = true; S.av = null; S.qty = {}; draw();
    api('/availability?in=' + a + '&out=' + b).then(function (j) {
      S.busy = false;
      if (!j.ok) { S.err = j.error || 'Could not check availability.'; S.av = null; } else S.av = j;
      draw();
    }).catch(function () { S.busy = false; S.err = 'No connection. Please try again or call the hotel.'; draw(); });
  }

  function confirm() {
    var T = totals(), g = S.guest;
    g.name = $('#gn').value.trim(); g.phone = $('#gp').value.trim(); g.email = $('#ge').value.trim(); g.nationality = $('#gt').value.trim() || 'Indian';
    if (g.name.length < 2) { S.err = 'Enter your name.'; draw(); return; }
    if (g.phone.replace(/\D/g, '').length < 10) { S.err = 'Enter a valid mobile number.'; draw(); return; }
    S.err = ''; S.busy = true; draw();
    var rooms = S.av.types.filter(function (t) { return +S.qty[t.type] > 0; }).map(function (t) { return { type: t.type, qty: +S.qty[t.type] }; });
    api('/book', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ in: S.in, out: S.out, guests: S.guests, rooms: rooms, guest: g, hp: ($('#ghp') || {}).value || '' }) })
      .then(function (j) {
        S.busy = false;
        if (j.ok) { S.done = j; draw(); mount.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        S.err = j.error || 'Could not complete the booking.';
        if (j.soldOut) { S.step = 1; draw(); check(); S.err = j.error; } else draw();
      }).catch(function () { S.busy = false; S.err = 'No connection. Your booking was not made. Please try again or call the hotel.'; draw(); });
  }

  function bind() {
    var el;
    if ((el = $('#hcheck'))) el.onclick = check;
    if ((el = $('#hin'))) el.onchange = function () { var v = this.value; if (v && $('#hout').value <= v) $('#hout').value = addDays(v, 1); $('#hout').min = addDays(v, 1); };
    mount.querySelectorAll('select[data-t]').forEach(function (s) {
      s.onchange = function () {
        S.qty[this.getAttribute('data-t')] = +this.value;
        var T = totals(), n = $('#hnext');
        S.guests = Math.max(S.guests, T.rooms); // at least one guest per room
        draw();
      };
    });
    if ((el = $('#hnext'))) el.onclick = function () {
      var T = totals(), max = (S.av.maxGuestsPerRoom || 4) * T.rooms;
      if (S.guests < T.rooms) S.guests = T.rooms;
      if (S.guests > max) { S.err = 'A room takes up to ' + (S.av.maxGuestsPerRoom || 4) + ' guests. Add another room or reduce guests.'; draw(); return; }
      S.err = ''; S.step = 3; draw();
    };
    if ((el = $('#hback'))) el.onclick = function () { S.step = 1; S.err = ''; draw(); };
    if ((el = $('#hconfirm'))) el.onclick = confirm;
    if ((el = $('#hnew'))) el.onclick = function () { S.done = null; S.step = 1; S.av = null; S.qty = {}; S.err = ''; draw(); };
  }

  draw();
})();

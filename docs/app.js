/* Glen fixtures, results and live scores.
   Fixtures come from fixtures.json (refreshed from Derry GAA and Ulster LGFA every two hours).
   Live data lives in Firebase Realtime Database under /live:
     matches/<id>   live games (several can run at once; /live/match is the older single-game slot)
     lineups/<team> team sheets
     fixtures/<id>  games the club adds itself
     venues/<key>   venue and map link set by the club for official games with a TBC venue
   Scorer logins are listed under /scorers (only the club admin can change that list). */
(function () {
  "use strict";

  const TZ = "Europe/London";
  const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
  const CFG = window.GLEN_FIREBASE || null;
  const OWNER_UID = "huUQRRNXqbQIk0spwd1xrh2rDi43";
  /* Scorers set up directly in Firebase before the Manage scorers screen existed */
  const EARLIER_SCORERS = ["O1DlcvchPgTdWO4jDEgqVyvV5gl2", "h2kq4KzWhtfSpWFb7U10XC8kcWz2"];

  let DATA = { updated: null, teams: [], games: [] };
  let TEAMS = {};
  let LIVE = { lineups: {}, matches: [], extra: [], venues: {} };
  let dataState = "loading";        // loading | ready | error
  let liveState = CFG ? "loading" : "off"; // off | loading | ready | error
  let db = null, auth = null, user = null, adderApp = null;
  let role = "none";                // none | checking | scorer | owner | not-scorer
  let SCORERS = null, scorersBlocked = false, roleRef = null, roleCb = null;
  let serverOffset = 0, online = true, sheetKind = null;
  const now = function () { return Date.now() + serverOffset; };

  const VENUE_QUERY = {
    "Watty Graham Park": "Watty Graham Park, Maghera",
    "Owenbeg": "Owenbeg Derry GAA Centre of Excellence",
    "Slaughtneil": "Slaughtneil Robert Emmet's GAC",
    "Sean Dolans": "Sean Dolan's GAC Derry",
    "Doire Colmcille": "Doire Colmcille GAC",
    "Coleraine": "Eoghan Rua GAC Coleraine",
    "Magherafelt": "O'Donovan Rossa GAC Magherafelt",
    "Steelstown": "Steelstown Brian Og's GAC"
  };
  const HA = { H: "Home", A: "Away", N: "Neutral" };
  const KINDS = {
    pt:   { label: "Point",    flag: "White flag" },
    two:  { label: "2 points", flag: "Orange flag" },
    goal: { label: "Goal",     flag: "Green flag" }
  };
  /* Team-sheet layout: goalkeeper at the top, reading order 1 to 15 */
  const POS = [
    { n: 1,  pos: "Goalkeeper",           x: 50, y: 6 },
    { n: 2,  pos: "Right corner-back",    x: 17, y: 19 },
    { n: 3,  pos: "Full-back",            x: 50, y: 19 },
    { n: 4,  pos: "Left corner-back",     x: 83, y: 19 },
    { n: 5,  pos: "Right half-back",      x: 17, y: 35 },
    { n: 6,  pos: "Centre half-back",     x: 50, y: 35 },
    { n: 7,  pos: "Left half-back",       x: 83, y: 35 },
    { n: 8,  pos: "Midfield",             x: 31, y: 50 },
    { n: 9,  pos: "Midfield",             x: 69, y: 50 },
    { n: 10, pos: "Right half-forward",   x: 17, y: 65 },
    { n: 11, pos: "Centre half-forward",  x: 50, y: 65 },
    { n: 12, pos: "Left half-forward",    x: 83, y: 65 },
    { n: 13, pos: "Right corner-forward", x: 17, y: 81 },
    { n: 14, pos: "Full-forward",         x: 50, y: 81 },
    { n: 15, pos: "Left corner-forward",  x: 83, y: 81 }
  ];
  const SUB_NUMBERS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];

  /* ---------- helpers ---------- */
  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function londonToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }
  function addDays(iso, n) {
    const p = iso.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    const pa = a.split("-").map(Number), pb = b.split("-").map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }
  function asDate(iso) { const p = iso.split("-").map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)); }
  function fmtDate(iso, opts) { return new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: "UTC" }, opts)).format(asDate(iso)); }
  function londonOffset(ms) {
    const parts = {};
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    }).formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = p.value; });
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUTC - Math.floor(ms / 1000) * 1000;
  }
  function londonToUTC(iso, hhmm) {
    const p = iso.split("-").map(Number), t = hhmm.split(":").map(Number);
    const naive = Date.UTC(p[0], p[1] - 1, p[2], t[0], t[1]);
    const guess = naive - londonOffset(naive);
    return new Date(naive - londonOffset(guess));
  }
  function points(score) { const m = /^(\d+)-(\d+)$/.exec(score || ""); return m ? (+m[1]) * 3 + (+m[2]) : null; }
  function outcome(g) {
    if (g.st === "walkover") return "wo";
    if (g.st === "conceded") return "conc";
    const a = points(g.us), b = points(g.them);
    if (a == null || b == null) return null;
    return a > b ? "w" : a < b ? "l" : "d";
  }
  function compLine(g) { return g.comp + (g.round ? " · " + g.round : ""); }
  function isFinal(g) { return /(^|· )Final$/.test(g.round || ""); }
  function teamName(id) { return TEAMS[id] ? TEAMS[id].name : "Glen"; }
  function relDay(today, iso) {
    const n = daysBetween(today, iso);
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n < 7) return "This " + fmtDate(iso, { weekday: "long" });
    return "In " + n + " days";
  }
  function flagSvg(kind) {
    return '<svg class="flag ' + kind + '" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path class="pole" d="M5 2.5v19"/><rect class="cloth" x="6.5" y="3" width="14" height="10" rx="1"/></svg>';
  }
  function calendarUrl(team) {
    const base = location.host + location.pathname.replace(/[^/]*$/, "");
    return "webcal://" + base + "cal/" + (team === "all" ? "all" : team) + ".ics";
  }

  /* ---------- venues ---------- */
  function vkey(g) { return (g.d + "_" + g.team + "_" + g.opp).toLowerCase().replace(/[^a-z0-9]+/g, "-"); }
  function safeUrl(u) { return /^https:\/\/[^\s"'<>]+$/i.test(u || "") ? u : null; }
  function isTbc(v) { return !v || v === "TBC"; }
  /* Where a game is: the official venue, else what the club set for a TBC game, else a club game's own venue */
  function venueOf(g) {
    if (g.src === "club") return { name: isTbc(g.venue) ? "" : g.venue, url: safeUrl(g.map), typed: true };
    if (isTbc(g.venue)) {
      const o = (LIVE.venues || {})[vkey(g)];
      if (o && (o.name || o.url)) return { name: o.name || "", url: safeUrl(o.url), typed: true, set: true };
      return { name: "", url: null };
    }
    return { name: g.venue, url: null };
  }
  function venueHref(v) {
    if (v.url) return v.url;
    if (!v.name) return null;
    const q = v.typed ? v.name : (VENUE_QUERY[v.name] || v.name + " GAC");
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }
  function venueLink(g) {
    const v = venueOf(g), href = venueHref(v);
    if (!href) return "Venue TBC";
    return '<a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(v.name || "Map") + "</a>";
  }
  function calLinks(g) {
    if (!g.t) return null;
    const start = londonToUTC(g.d, g.t);
    const end = new Date(start.getTime() + 90 * 60000);
    const gfmt = function (d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); };
    const title = "Glen v " + g.opp + " (" + teamName(g.team) + ")";
    const v = venueOf(g);
    const details = compLine(g) + (v.url ? "\nMap: " + v.url : "") + "\nCheck for time or venue changes before you travel.";
    const loc = v.name ? (v.typed ? v.name : (VENUE_QUERY[v.name] || v.name)) : "";
    return {
      google: "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(title) +
        "&dates=" + gfmt(start) + "/" + gfmt(end) + "&details=" + encodeURIComponent(details) + "&location=" + encodeURIComponent(loc),
      outlook: "https://outlook.live.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent&subject=" +
        encodeURIComponent(title) + "&startdt=" + encodeURIComponent(start.toISOString()) + "&enddt=" + encodeURIComponent(end.toISOString()) +
        "&body=" + encodeURIComponent(details) + "&location=" + encodeURIComponent(loc)
    };
  }

  /* ---------- live match maths ---------- */
  function phase(m) {
    const c = (m && m.clock) || {};
    return c.ft ? "ft" : c.h2 ? "2h" : c.ht ? "ht" : c.h1 ? "1h" : "pre";
  }
  function isActive(m) { const p = m ? phase(m) : "pre"; return p === "1h" || p === "ht" || p === "2h"; }
  function minuteAt(m, at) {
    const p = phase(m);
    if (p !== "1h" && p !== "2h") return null;
    const start = p === "1h" ? m.clock.h1 : m.clock.h2;
    return Math.max(1, Math.floor((at - start) / 60000) + 1);
  }
  function minLabel(min, half) {
    if (min == null) return "–";
    const hl = half || 30;
    return (min > hl ? hl + "+" + (min - hl) : String(min)) + "′";
  }
  function mmss(secs) { return Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0"); }
  function phaseLabel(m) {
    return { pre: "Before throw-in", "1h": "1st half", ht: "Half-time", "2h": "2nd half", ft: "Full-time" }[phase(m)];
  }
  /* Running match clock: m:ss from the half's throw-in, then added time past the set half length */
  function clockText(m) {
    const p = phase(m);
    if (p === "pre") return m.t ? "Throw-in " + m.t : "Starting soon";
    if (p === "ht") return "Half-time";
    if (p === "ft") return "Full-time";
    const start = p === "1h" ? m.clock.h1 : m.clock.h2;
    const secs = Math.max(0, Math.floor((now() - start) / 1000));
    const len = (m.half || 30) * 60;
    return secs < len ? mmss(secs) : mmss(len) + " +" + mmss(secs - len);
  }
  function tally(events, side) {
    let g = 0, p = 0;
    events.forEach(function (e) {
      if (e.side !== side) return;
      if (e.type === "goal") g++; else p += e.type === "two" ? 2 : 1;
    });
    return { g: g, p: p, t: g * 3 + p };
  }
  function gp(s) { return s.g + "-" + s.p; }
  function playerTallies(events) {
    const out = {};
    events.forEach(function (e) {
      if (e.side !== "glen" || !e.player) return;
      const k = e.player;
      out[k] = out[k] || { g: 0, p: 0 };
      if (e.type === "goal") out[k].g++; else out[k].p += e.type === "two" ? 2 : 1;
    });
    return out;
  }
  function lineupFor(team) { return (LIVE.lineups && LIVE.lineups[team]) || {}; }
  /* Derry GAA and Ulster LGFA fixtures plus games the club adds itself */
  function allGames() {
    const key = function (g) { return g.d + "|" + String(g.opp || "").trim().toLowerCase(); };
    const official = {};
    DATA.games.forEach(function (g) { official[key(g)] = true; });
    return DATA.games.concat((LIVE.extra || []).filter(function (g) { return !official[key(g)]; }));
  }
  function readMatch(raw, id, path) {
    const evs = raw.events || {};
    return Object.assign({}, raw, {
      id: id, path: path, clock: raw.clock || {},
      events: Object.keys(evs).map(function (k) { return Object.assign({}, evs[k], { id: k }); })
    });
  }
  function normaliseLive(v) {
    v = v || {};
    const matches = [];
    if (v.match && v.match.team) matches.push(readMatch(v.match, "legacy", "match"));
    const ms = v.matches || {};
    Object.keys(ms).forEach(function (k) { if (ms[k] && ms[k].team) matches.push(readMatch(ms[k], k, "matches/" + k)); });
    const xs = v.fixtures || {};
    const extra = Object.keys(xs).map(function (k) { return Object.assign({}, xs[k], { id: k, src: "club" }); })
      .filter(function (g) { return g.d && g.opp && g.team; });
    return { lineups: readLineups(v.lineups), matches: matches, extra: extra, venues: v.venues || {} };
  }
  function readLineups(raw) {
    const out = {};
    Object.keys(raw || {}).forEach(function (team) {
      const src = raw[team] || {};
      const lu = {};
      Object.keys(src).forEach(function (k) { const n = k.replace(/^n/, ""); if (src[k]) lu[n] = src[k]; });
      out[team] = lu;
    });
    return out;
  }
  function matchById(id) { return LIVE.matches.filter(function (m) { return m.id === id; })[0] || null; }
  function phaseRank(m) { return { "1h": 0, "2h": 0, ht: 0, pre: 1, ft: 2 }[phase(m)]; }
  /* Games shown on the Live tab: everything for scorers; viewers stop seeing a game 6 hours after full-time */
  function liveMatches() {
    const cutoff = now() - 6 * 3600 * 1000;
    return LIVE.matches.filter(function (m) { return canScore() || !(m.clock.ft && m.clock.ft < cutoff); })
      .sort(function (a, b) {
        return phaseRank(a) - phaseRank(b) || (a.d + (a.t || "")).localeCompare(b.d + (b.t || "")) || String(a.id).localeCompare(String(b.id));
      });
  }

  /* ---------- state ---------- */
  const state = { tab: "fixtures", team: "all", mid: null, showSetup: false };
  let tabChosen = false;
  try {
    const saved = localStorage.getItem("glen-team");
    if (saved) state.team = saved;
    const t = sessionStorage.getItem("glen-tab");
    if (t === "results" || t === "live" || t === "fixtures") { state.tab = t; tabChosen = true; }
  } catch (e) {}
  if (!tabChosen && (location.hash === "#results" || location.hash === "#live")) { state.tab = location.hash.slice(1); tabChosen = true; }
  function canScore() { return !!user && (role === "owner" || role === "scorer"); }
  function isOwner() { return !!user && role === "owner"; }

  /* ---------- shell ---------- */
  const app = $("#app");
  app.innerHTML =
    '<header class="masthead"><img src="crest.jpg" alt="Watty Graham\'s GAC Glen crest" width="76" height="76">' +
    '<div><p class="club">Watty Graham\'s GAC Glen</p><h1>Fixtures &amp; results</h1><p class="irish">Machaire Rátha · Doire</p></div></header>' +
    '<section id="next" class="panel next" aria-label="Next game" hidden></section>' +
    '<div class="controls"><div class="tabs" role="tablist" aria-label="View">' +
    '<button type="button" role="tab" id="tab-fixtures" data-tab="fixtures">Fixtures <span class="n" id="n-fixtures"></span></button>' +
    '<button type="button" role="tab" id="tab-results" data-tab="results">Results <span class="n" id="n-results"></span></button>' +
    '<button type="button" role="tab" id="tab-live" data-tab="live"><span class="dot" id="live-dot" hidden></span>Live</button>' +
    '</div><div class="picker" id="picker"><label for="team">Team</label><select id="team"><option value="all">All teams</option></select></div></div>' +
    '<main id="view" role="tabpanel"><div class="list"><div class="empty">Loading fixtures…</div></div></main>' +
    '<footer><p>Official fixtures and results from <a href="https://derry.clubandcounty.com/clubs/glen-watty-grahams/" target="_blank" rel="noopener">Derry GAA</a> ' +
    'and <a href="https://ulsterladiesgaelic.com/fixtures/" target="_blank" rel="noopener">Ulster LGFA</a>. ' +
    'Games marked "Added by club", venues set by the club and live scores are entered by the club. Throw-in times and venues can change, so check before you travel.</p>' +
    '<p id="updated"></p><div class="foot-actions" id="foot-actions"></div></footer>';

  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.hidden = true;
  document.body.appendChild(sheet);
  const toastEl = document.createElement("div");
  toastEl.className = "toast";
  toastEl.setAttribute("role", "status");
  toastEl.hidden = true;
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function toast(msg, sticky) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3500);
  }

  function buildPicker() {
    const select = $("#team");
    let html = '<option value="all">All teams</option>';
    const groups = [];
    DATA.teams.forEach(function (t) { if (groups.indexOf(t.group) < 0) groups.push(t.group); });
    groups.forEach(function (gr) {
      html += '<optgroup label="' + esc(gr) + '">';
      DATA.teams.forEach(function (t) { if (t.group === gr) html += '<option value="' + esc(t.id) + '">' + esc(t.name) + "</option>"; });
      html += "</optgroup>";
    });
    select.innerHTML = html;
    if (state.team !== "all" && !TEAMS[state.team]) state.team = "all";
    select.value = state.team;
  }

  /* ---------- fixtures & results ---------- */
  function split(today) {
    const mine = allGames().filter(function (g) { return state.team === "all" || g.team === state.team; });
    const upcoming = mine.filter(function (g) { return g.st === "fixture" && g.d >= today; })
      .sort(function (a, b) { return (a.d + (a.t || "")).localeCompare(b.d + (b.t || "")); });
    const past = mine.filter(function (g) { return !(g.st === "fixture" && g.d >= today); })
      .sort(function (a, b) { return (b.d + (b.t || "")).localeCompare(a.d + (a.t || "")); });
    return { upcoming: upcoming, past: past };
  }
  function eyebrow(g, showWinners) {
    let h = '<p class="eyebrow">' + esc(teamName(g.team));
    if (g.src === "club") h += ' <span class="chip club">Added by club</span>';
    if (isFinal(g)) {
      const o = outcome(g);
      h += ' <span class="chip final">' + (showWinners && (o === "w" || o === "wo") ? "Winners" : "Final") + "</span>";
    }
    return h + "</p>";
  }
  function fixtureRow(g) {
    const cal = calLinks(g);
    return '<article class="game"><div class="body">' + eyebrow(g, false) +
      '<h3>Glen <span class="v">v</span> ' + esc(g.opp) + "</h3>" +
      '<p class="comp">' + esc(compLine(g)) + "</p>" +
      '<p class="meta"><time>' + esc(g.t || "Time TBC") + '</time><span aria-hidden="true">·</span>' + venueLink(g) +
      ' <span class="chip ha">' + HA[g.ha] + "</span></p>" +
      (cal ? '<p class="cal">Add to calendar: <a href="' + esc(cal.google) + '" target="_blank" rel="noopener">Google</a><a href="' + esc(cal.outlook) + '" target="_blank" rel="noopener">Outlook</a></p>' : "") +
      xtools(g) + vtools(g) + "</div></article>";
  }
  function resultRow(g) {
    const o = outcome(g);
    let score;
    if (o === "wo") score = '<div class="score"><span class="res wo" title="Walkover">W/O</span></div>';
    else if (o === "conc") score = '<div class="score"><span class="res conc" title="Conceded">Conc</span></div>';
    else if (o) {
      const label = { w: "Win", l: "Loss", d: "Draw" }[o];
      score = '<div class="score"><span class="res ' + o + '" title="' + label + '" aria-label="' + label + '">' + o.toUpperCase() + "</span>" +
        '<span class="us">' + esc(g.us) + '<span class="tot">(' + points(g.us) + ")</span></span>" +
        '<span class="them">' + esc(g.them) + '<span class="tot">(' + points(g.them) + ")</span></span></div>";
    } else score = '<div class="score"><span class="pending">Result to come</span></div>';
    return '<article class="game"><div class="body">' + eyebrow(g, true) +
      '<h3>Glen <span class="v">v</span> ' + esc(g.opp) + "</h3>" +
      '<p class="comp">' + esc(compLine(g)) + "</p>" +
      '<p class="meta">' + (g.t ? "<time>" + esc(g.t) + '</time><span aria-hidden="true">·</span>' : "") + venueLink(g) +
      ' <span class="chip ha">' + HA[g.ha] + "</span>" +
      (g.note ? '<span aria-hidden="true">·</span><span>' + esc(g.note) + "</span>" : "") + "</p>" +
      xtools(g) + "</div>" + score + "</article>";
  }
  function xtools(g) {
    if (g.src !== "club" || !canScore()) return "";
    return '<p class="btnrow xtools"><button type="button" class="linkbtn" data-act="xedit" data-id="' + esc(g.id) + '">' +
      (g.st === "fixture" ? "Edit" : "Edit or add result") + '</button><button type="button" class="linkbtn danger" data-act="xrm" data-id="' + esc(g.id) + '">Remove</button></p>';
  }
  /* Scorers can set the venue and map link on official games whose venue is still TBC */
  function vtools(g) {
    if (g.src === "club" || !isTbc(g.venue) || !canScore()) return "";
    const set = venueOf(g).set;
    return '<p class="btnrow xtools"><button type="button" class="linkbtn" data-act="venue" data-key="' + esc(vkey(g)) + '">' +
      (set ? "Change venue" : "Set venue") + "</button></p>";
  }
  function groupByDate(list, rowFn) {
    let html = "", last = null;
    list.forEach(function (g) {
      if (g.d !== last) { html += '<div class="daterow">' + esc(fmtDate(g.d, { weekday: "long", day: "numeric", month: "long" })) + "</div>"; last = g.d; }
      html += rowFn(g);
    });
    return '<div class="list">' + html + "</div>";
  }
  function teamLabel() { return state.team === "all" ? "Glen" : teamName(state.team); }

  function renderNext(today, upcoming) {
    const el = $("#next");
    const g = upcoming[0];
    if (!g || state.tab !== "fixtures") { el.hidden = true; el.innerHTML = ""; return; }
    const cal = calLinks(g);
    const v = venueOf(g), href = venueHref(v);
    el.innerHTML =
      '<div class="kicker"><span>Next up</span><span class="count">' + esc(relDay(today, g.d)) + "</span>" + (isFinal(g) ? "<span>Final</span>" : "") + "</div>" +
      '<p class="team">' + esc(teamName(g.team)) + " · " + HA[g.ha] + "</p>" +
      '<h2 class="matchup">Glen<span class="v">v</span>' + esc(g.opp) + "</h2>" +
      '<p class="when">' + esc(g.t || "Time TBC") + " <span>· " + esc(fmtDate(g.d, { weekday: "long", day: "numeric", month: "long" })) + "</span></p>" +
      '<p class="comp">' + esc(compLine(g)) + " · " + esc(v.name || (href ? "Venue on map" : "Venue TBC")) + "</p>" +
      '<div class="actions">' +
      (cal ? '<a class="btn primary" href="' + esc(cal.google) + '" target="_blank" rel="noopener">Add to Google Calendar</a>' +
        '<a class="btn" href="' + esc(cal.outlook) + '" target="_blank" rel="noopener">Outlook</a>' : "") +
      (href ? '<a class="btn" href="' + esc(href) + '" target="_blank" rel="noopener">Directions</a>' : "") +
      "</div>";
    el.hidden = false;
  }

  function subscribeHtml() {
    const url = calendarUrl(state.team);
    const google = "https://calendar.google.com/calendar/render?cid=" + encodeURIComponent(url);
    const who = state.team === "all" ? "every Glen team" : teamName(state.team);
    return '<section class="subscribe" aria-label="Subscribe to a calendar">' +
      "<h2>Subscribe to a team calendar</h2>" +
      "<p>Get " + esc(who) + " fixtures in your calendar. It keeps itself up to date, including time and venue changes. Pick a team above first if you only want one.</p>" +
      '<div class="btnrow"><a href="' + esc(url) + '">iPhone, Mac or Outlook</a><a href="' + esc(google) + '" target="_blank" rel="noopener">Google Calendar</a></div>' +
      "</section>";
  }

  function fixturesHtml(s, today) {
    let html;
    if (!s.upcoming.length) {
      html = '<div class="list"><div class="empty"><strong>No fixtures for ' + esc(teamLabel()) + " yet</strong>New games appear here once Derry GAA or Ulster LGFA publish them. Recent games are under Results.</div></div>";
    } else {
      const next = s.upcoming[0];
      const rest = s.upcoming.slice(1);
      /* the next game sits in the green panel; its venue button lives here so scorers can still reach it */
      const nextTools = vtools(next) || xtools(next);
      html = nextTools ? '<div class="nexttools"><span>Next up: Glen v ' + esc(next.opp) + "</span>" + nextTools + "</div>" : "";
      if (!rest.length) html += '<p class="record">That is the only ' + esc(teamLabel()) + " fixture published so far.</p>";
      else {
        const weekEnd = addDays(today, 7);
        const soon = rest.filter(function (g) { return g.d <= weekEnd; });
        const later = rest.filter(function (g) { return g.d > weekEnd; });
        const n = function (k) { return k + (k === 1 ? " game" : " games"); };
        if (soon.length) html += '<section class="section"><h2>Also this week <small>' + n(soon.length) + "</small></h2>" + groupByDate(soon, fixtureRow) + "</section>";
        if (later.length) html += '<section class="section"><h2>Later <small>' + n(later.length) + "</small></h2>" + groupByDate(later, fixtureRow) + "</section>";
      }
    }
    const add = canScore() ? '<div class="btnrow"><button type="button" class="pbtn" data-act="xadd">Add a game</button><p class="hint">For games Derry GAA and Ulster LGFA don\'t list: camogie, challenge games, tournaments.</p></div>' : "";
    return add + html + subscribeHtml();
  }
  function resultsHtml(s) {
    if (!s.past.length) return '<div class="list"><div class="empty"><strong>No results for ' + esc(teamLabel()) + " yet</strong>Scores appear here after each game.</div></div>";
    let w = 0, l = 0, d = 0;
    s.past.forEach(function (g) { const o = outcome(g); if (o === "w" || o === "wo") w++; else if (o === "l" || o === "conc") l++; else if (o === "d") d++; });
    return '<section class="section"><h2>' + esc(teamLabel()) + " results <small>since " +
      esc(fmtDate(s.past[s.past.length - 1].d, { day: "numeric", month: "short" })) + "</small></h2>" +
      '<p class="record">Played <b>' + (w + l + d) + "</b> · Won <b>" + w + "</b> · Drawn <b>" + d + "</b> · Lost <b>" + l + "</b></p>" +
      groupByDate(s.past, resultRow) + "</section>";
  }

  /* ---------- live tab ---------- */
  const PITCH_SVG =
    '<svg class="lines" viewBox="0 0 90 130" preserveAspectRatio="none" aria-hidden="true">' +
    '<rect x="0.6" y="0.6" width="88.8" height="128.8"/>' +
    '<line x1="0" y1="13" x2="90" y2="13"/><line x1="0" y1="20" x2="90" y2="20"/><line x1="0" y1="45" x2="90" y2="45"/>' +
    '<line x1="0" y1="65" x2="90" y2="65"/>' +
    '<line x1="0" y1="85" x2="90" y2="85"/><line x1="0" y1="110" x2="90" y2="110"/><line x1="0" y1="117" x2="90" y2="117"/>' +
    '<rect x="38" y="0" width="14" height="4.5"/><rect x="35.5" y="0" width="19" height="13"/>' +
    '<rect x="38" y="125.5" width="14" height="4.5"/><rect x="35.5" y="117" width="19" height="13"/>' +
    '<path d="M32 20 A13 13 0 0 0 58 20"/><path d="M32 110 A13 13 0 0 1 58 110"/>' +
    '<path class="arc2" d="M5 0 A40 40 0 0 0 85 0"/><path class="arc2" d="M5 130 A40 40 0 0 1 85 130"/>' +
    "</svg>";

  function nextGameLine() {
    const today = londonToday();
    const g = allGames().filter(function (x) { return x.st === "fixture" && x.d >= today; })
      .sort(function (a, b) { return (a.d + (a.t || "")).localeCompare(b.d + (b.t || "")); })[0];
    if (!g) return "Scores appear here while a Glen game is on.";
    return "Next game: " + esc(teamName(g.team)) + " v " + esc(g.opp) + ", " + esc(relDay(today, g.d).toLowerCase()) +
      (g.t ? " at " + esc(g.t) : "") + ". Follow the score here while it's on.";
  }

  function pitchHtml(m) {
    const lu = lineupFor(m.team);
    const tallies = playerTallies(m.events);
    const slots = POS.map(function (p) {
      const name = lu[p.n] || "";
      const t = name && tallies[name];
      return '<div class="slot" style="left:' + p.x + "%;top:" + p.y + '%"><span class="no">' + p.n + "</span>" +
        '<span class="nm">' + (name ? esc(name) : '<span class="tbc">' + esc(p.pos) + "</span>") + "</span>" +
        (t ? '<span class="tl" title="Scored ' + gp(t) + '">' + gp(t) + "</span>" : "") + "</div>";
    }).join("");
    const subs = SUB_NUMBERS.filter(function (n) { return lu[n]; }).map(function (n) {
      const t = tallies[lu[n]];
      return "<li><b>" + n + "</b>" + esc(lu[n]) + (t ? '<span class="tl">' + gp(t) + "</span>" : "") + "</li>";
    }).join("");
    return '<div class="pitch" role="img" aria-label="' + esc(teamName(m.team)) + ' team sheet">' + PITCH_SVG + slots + "</div>" +
      (subs ? '<ul class="subs" aria-label="Substitutes">' + subs + "</ul>" : "") +
      '<p class="legend">' +
      "<span>" + flagSvg("pt") + "Point, 1</span>" +
      "<span>" + flagSvg("two") + "From outside the arc, 2</span>" +
      "<span>" + flagSvg("goal") + "Goal, 3</span></p>";
  }

  function feedHtml(m) {
    if (!m.events.length) return '<div class="list"><div class="empty">No scores yet. Each score shows here with the scorer and the umpire\'s flag.</div></div>';
    const evs = m.events.slice().sort(function (a, b) { return a.at - b.at; });
    const g = { g: 0, p: 0 }, o = { g: 0, p: 0 };
    const rows = evs.map(function (e) {
      const s = e.side === "glen" ? g : o;
      if (e.type === "goal") s.g++; else s.p += e.type === "two" ? 2 : 1;
      return { e: e, run: gp(g) + " <span>–</span> " + gp(o) };
    }).reverse();
    let html = "", lastHalf = null;
    rows.forEach(function (r) {
      const e = r.e;
      if (e.half !== lastHalf) { html += '<div class="daterow">' + (e.half === 2 ? "Second half" : "First half") + "</div>"; lastHalf = e.half; }
      const k = KINDS[e.type] || KINDS.pt;
      let who, what;
      if (e.side === "glen") {
        who = e.player ? esc(e.player) : "Glen";
        what = k.label + (e.no ? " · No. " + e.no : "") + (e.player ? "" : " · scorer not recorded");
      } else {
        who = e.player ? esc(e.player) + " (" + esc(m.opp) + ")" : esc(m.opp);
        what = k.label;
      }
      html += '<div class="ev ' + (e.side === "glen" ? "glen" : "opp") + '">' +
        '<span class="min">' + minLabel(e.min, m.half) + "</span>" + flagSvg(e.type) +
        '<div class="evb"><span class="who">' + who + '</span><span class="what">' + what + "</span>" +
        (canScore() ? '<button type="button" class="linkbtn danger" data-act="rm" data-mid="' + esc(m.id) + '" data-id="' + esc(e.id) + '">Remove</button>' : "") +
        "</div>" + '<span class="run" title="Glen first">' + r.run + "</span></div>";
    });
    return '<div class="list">' + html + "</div>";
  }

  /* Upcoming games (yesterday to a week ahead) not already live */
  function setupCandidates() {
    const today = londonToday();
    const liveKeys = {};
    LIVE.matches.forEach(function (m) { if (m.gkey) liveKeys[m.gkey] = true; });
    return allGames().filter(function (g) { return g.st === "fixture" && g.d >= addDays(today, -1) && g.d <= addDays(today, 7) && !liveKeys[vkey(g)]; })
      .sort(function (a, b) { return (a.d + (a.t || "")).localeCompare(b.d + (b.t || "")); });
  }

  function setupHtml(another) {
    const c = setupCandidates();
    const opts = c.map(function (g, i) {
      return '<option value="' + i + '">' + esc(teamName(g.team)) + " v " + esc(g.opp) + " · " + esc(fmtDate(g.d, { weekday: "short", day: "numeric", month: "short" })) + (g.t ? " " + esc(g.t) : "") + "</option>";
    }).join("") + '<option value="other">Another game (challenge or friendly)</option>';
    const teamOpts = DATA.teams.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + "</option>"; }).join("");
    return '<section class="scorer" aria-label="Set up a live game">' +
      '<div class="scorer-head"><h2>' + (another ? "Start another live game" : "Start a live game") + '</h2><p class="hint">Only signed-in scorers see these controls</p></div>' +
      '<div class="field"><label for="setup-fixture">Game</label><select id="setup-fixture">' + opts + "</select></div>" +
      '<div id="setup-other" class="tsgrid"' + (c.length ? " hidden" : "") + ">" +
      '<div class="field"><label for="setup-team">Team</label><select id="setup-team">' + teamOpts + "</select></div>" +
      '<div class="field"><label for="setup-opp">Opponent</label><input id="setup-opp" autocomplete="off" placeholder="e.g. Lavey"></div>' +
      '<div class="field"><label for="setup-venue">Venue</label><input id="setup-venue" autocomplete="off" placeholder="e.g. Watty Graham Park"></div></div>' +
      '<div class="field"><label for="setup-half">Length of each half</label><select id="setup-half">' +
      '<option value="30">30 minutes</option><option value="25">25 minutes</option><option value="20">20 minutes</option><option value="35">35 minutes</option><option value="15">15 minutes</option></select></div>' +
      '<div class="btnrow"><button type="button" class="pbtn" data-act="setup">Set up live game</button>' +
      '<button type="button" class="linkbtn" data-act="sheet-setup">Name the team first</button>' +
      (another ? '<button type="button" class="linkbtn" data-act="hidesetup">Cancel</button>' : "") + "</div>" +
      "</section>";
  }

  function scorerHtml(m) {
    const p = phase(m);
    const next = { pre: "Throw-in: start 1st half", "1h": "Half-time", ht: "Start 2nd half", "2h": "Full-time" }[p];
    const undo = { "1h": "Undo throw-in", ht: "Undo half-time", "2h": "Undo 2nd-half start", ft: "Undo full-time" }[p];
    const mid = ' data-mid="' + esc(m.id) + '"';
    const btns = function (side) {
      return '<div class="score-btns">' + ["pt", "two", "goal"].map(function (k) {
        return '<button type="button" class="sbtn" data-act="add"' + mid + ' data-side="' + side + '" data-kind="' + k + '">' + flagSvg(k) +
          KINDS[k].label + "<small>" + KINDS[k].flag + "</small></button>";
      }).join("") + "</div>";
    };
    return '<section class="scorer" aria-label="Scorer controls">' +
      '<div class="scorer-head"><h2>Scorer</h2><p class="hint">' + esc(teamName(m.team)) + " v " + esc(m.opp) + ". Each tap shows on everyone's screen.</p></div>" +
      (online ? "" : '<p class="netnote">No signal. Scores you add are kept and sent as soon as you\'re back online.</p>') +
      '<div class="btnrow">' + (next ? '<button type="button" class="pbtn" data-act="phase"' + mid + ">" + next + "</button>" : "") +
      (undo ? '<button type="button" class="linkbtn" data-act="unphase"' + mid + ">" + undo + "</button>" : "") + "</div>" +
      '<p class="row-label">Glen scored</p>' + btns("glen") +
      '<p class="row-label">' + esc(m.opp) + " scored</p>" + btns("opp") +
      '<div class="btnrow"><button type="button" class="linkbtn" data-act="sheet"' + mid + ">Edit team sheet</button>" +
      '<button type="button" class="linkbtn danger" data-act="clear"' + mid + ">Clear this game</button></div>" +
      "</section>";
  }

  function matchTabs(list, sel) {
    if (list.length < 2) return "";
    return '<div class="mtabs" role="tablist" aria-label="Live games">' + list.map(function (m) {
      const us = tally(m.events, "glen"), them = tally(m.events, "opp");
      return '<button type="button" role="tab" data-act="pickmatch" data-mid="' + esc(m.id) + '" aria-selected="' + (m.id === sel.id) + '">' +
        '<span class="mt-team">' + esc(teamName(m.team)) + "</span>" +
        '<span class="mt-score">' + gp(us) + " – " + gp(them) + "</span>" +
        '<span class="mt-st">' + (isActive(m) ? '<span class="dot" aria-hidden="true"></span>' : "") + "v " + esc(m.opp) + " · " + esc(phaseLabel(m)) + "</span></button>";
    }).join("") + "</div>";
  }

  function boardHtml(m) {
    const us = tally(m.events, "glen"), them = tally(m.events, "opp");
    const vhref = m.mapUrl ? safeUrl(m.mapUrl) : (m.venue ? venueHref({ name: m.venue, typed: !VENUE_QUERY[m.venue] }) : null);
    return '<section class="panel board" aria-label="Live score">' +
      '<div class="kicker">' + (isActive(m) ? '<span class="dot" aria-hidden="true"></span><span>Live</span>' : "") +
      '<span class="status">' + esc(phaseLabel(m)) + "</span></div>" +
      '<p class="clock" data-clock="' + esc(m.id) + '" aria-label="Match clock">' + esc(clockText(m)) + "</p>" +
      '<p class="team">' + esc(teamName(m.team)) + " · " + esc(m.comp) + "</p>" +
      '<div class="sides">' +
      '<div class="side glen"><span class="nm">Glen</span><span class="sc">' + gp(us) + '</span><span class="tt">' + us.t + " pts</span></div>" +
      '<span class="vs">v</span>' +
      '<div class="side"><span class="nm">' + esc(m.opp) + '</span><span class="sc">' + gp(them) + '</span><span class="tt">' + them.t + " pts</span></div>" +
      "</div>" +
      (m.venue || vhref ? '<p class="comp">' + (vhref ? '<a class="onpitch" href="' + esc(vhref) + '" target="_blank" rel="noopener">' + esc(m.venue || "Venue on map") + "</a>" : esc(m.venue)) + "</p>" : "") +
      "</section>";
  }

  function liveHtml() {
    if (liveState === "off") return '<div class="list"><div class="empty"><strong>Live scores are coming soon</strong>' + nextGameLine() + "</div></div>";
    if (liveState === "loading") return '<div class="list"><div class="empty">Connecting to live scores…</div></div>';
    if (liveState === "error") return '<div class="list"><div class="empty"><strong>Live scores aren\'t available right now</strong>Refresh the page to try again.</div></div>';
    const list = liveMatches();
    if (!list.length) {
      return '<div class="list"><div class="empty"><strong>No game live right now</strong>' + nextGameLine() + "</div></div>" +
        (canScore() ? setupHtml(false) : "");
    }
    const m = list.filter(function (x) { return x.id === state.mid; })[0] || list[0];
    const named = POS.filter(function (p) { return lineupFor(m.team)[p.n]; }).length;
    const another = !canScore() ? "" : state.showSetup ? setupHtml(true)
      : '<div class="btnrow"><button type="button" class="linkbtn" data-act="showsetup">Start another live game</button></div>';
    return matchTabs(list, m) + boardHtml(m) +
      (canScore() ? scorerHtml(m) : "") +
      '<section class="section"><h2>Scores <small>' + m.events.length + (m.events.length === 1 ? " score" : " scores") + "</small></h2>" + feedHtml(m) + "</section>" +
      '<section class="section"><h2>Team <small>' + (named ? named + " of 15 named" : "Team sheet to come") + "</small></h2>" + pitchHtml(m) + "</section>" +
      another;
  }

  /* ---------- render ---------- */
  function renderFooter() {
    if (DATA.updated) {
      $("#updated").textContent = "Fixtures last checked " + new Intl.DateTimeFormat("en-GB", {
        timeZone: TZ, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
      }).format(new Date(DATA.updated)) + ".";
    }
    const fa = $("#foot-actions");
    if (!auth) { fa.innerHTML = ""; return; }
    const out = '<button type="button" class="linkbtn" data-act="signout">Sign out</button>';
    if (!user) fa.innerHTML = '<button type="button" class="linkbtn" data-act="signin">Scorer sign-in</button>';
    else if (role === "owner") fa.innerHTML = "<span>Signed in as club admin</span>" +
      '<button type="button" class="linkbtn" data-act="manage">Manage scorers</button>' + out;
    else if (role === "scorer") fa.innerHTML = "<span>Signed in as scorer</span>" + out;
    else if (role === "not-scorer") fa.innerHTML = "<span>This login isn't set up as a scorer. Ask the club to add you.</span>" + out;
    else fa.innerHTML = "<span>Signed in</span>" + out;
  }
  function render() {
    const today = londonToday();
    renderFooter();
    if (dataState !== "ready") {
      $("#view").innerHTML = dataState === "error"
        ? '<div class="list"><div class="empty"><strong>Fixtures didn\'t load</strong>Check your connection and refresh the page.</div></div>'
        : '<div class="list"><div class="empty">Loading fixtures…</div></div>';
      return;
    }
    const s = split(today);
    $("#n-fixtures").textContent = s.upcoming.length;
    $("#n-results").textContent = s.past.length;
    ["fixtures", "results", "live"].forEach(function (t) { $("#tab-" + t).setAttribute("aria-selected", String(state.tab === t)); });
    $("#live-dot").hidden = !LIVE.matches.some(isActive);
    $("#picker").hidden = state.tab === "live";
    renderNext(today, s.upcoming);
    /* keep anything typed into the "start another game" form across live updates */
    const keep = {};
    ["setup-fixture", "setup-team", "setup-opp", "setup-venue", "setup-half"].forEach(function (id) { const el = $("#" + id); if (el) keep[id] = el.value; });
    $("#view").innerHTML = state.tab === "fixtures" ? fixturesHtml(s, today) : state.tab === "results" ? resultsHtml(s) : liveHtml();
    Object.keys(keep).forEach(function (id) { const el = $("#" + id); if (el && keep[id] !== undefined) el.value = keep[id]; });
    const so = $("#setup-other"), sf = $("#setup-fixture");
    if (so && sf) so.hidden = sf.value !== "other";
  }
  setInterval(function () {
    document.querySelectorAll("[data-clock]").forEach(function (el) {
      const m = matchById(el.getAttribute("data-clock"));
      if (m) el.textContent = clockText(m);
    });
  }, 1000);

  /* ---------- writing live updates ---------- */
  function liveRef(path) { return db.ref("live" + (path ? "/" + path : "")); }
  function mref(m, sub) { return liveRef(m.path + (sub ? "/" + sub : "")); }
  function save(promise, okMsg) {
    if (online) toast("Saving…", true);
    else toast("Saved on this phone. It sends when you're back online.");
    return promise.then(function () { toast(okMsg || "Saved"); }).catch(function (err) {
      const code = String((err && (err.code || err.message)) || "");
      if (/permission/i.test(code)) toast("This login isn't allowed to change scores.");
      else toast("That didn't save. Try again.");
    });
  }

  /* ---------- sheets ---------- */
  function openSheet(html, kind) {
    sheetKind = kind || null;
    sheet.innerHTML = '<div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="sheet-title">' + html + "</div>";
    sheet.hidden = false;
    const first = sheet.querySelector("input, button");
    if (first) first.focus();
  }
  function closeSheet() { sheet.hidden = true; sheet.innerHTML = ""; sheetKind = null; }

  function openSignIn() {
    openSheet('<h2 id="sheet-title">Scorer sign-in</h2>' +
      '<form id="signin-form">' +
      '<div class="field"><label for="si-email">Email</label><input id="si-email" type="email" autocomplete="username" required></div>' +
      '<div class="field"><label for="si-pass">Password</label><input id="si-pass" type="password" autocomplete="current-password" required></div>' +
      '<p class="err" id="si-err" hidden></p><p class="okmsg" id="si-ok" hidden></p>' +
      '<div class="btnrow"><button type="submit" class="pbtn">Sign in</button><button type="button" class="linkbtn" data-act="forgot">Forgot password?</button>' +
      '<button type="button" class="linkbtn" data-act="close">Cancel</button></div>' +
      "</form>");
  }
  function openScorerPicker(m, side, kind) {
    const k = KINDS[kind];
    const mid = ' data-mid="' + esc(m.id) + '"';
    if (side === "opp") {
      openSheet('<h2 id="sheet-title">' + flagSvg(kind) + esc(m.opp) + " · " + k.label + "</h2>" +
        '<div class="field"><label for="opp-scorer">Scorer (optional)</label><input id="opp-scorer" autocomplete="off" placeholder="Leave blank if unsure"></div>' +
        '<div class="btnrow"><button type="button" class="pbtn" data-act="pick-opp"' + mid + ' data-kind="' + kind + '">Add ' + k.label.toLowerCase() + '</button><button type="button" class="linkbtn" data-act="close">Cancel</button></div>');
      return;
    }
    const lu = lineupFor(m.team);
    const nums = POS.map(function (p) { return p.n; }).concat(SUB_NUMBERS).filter(function (n) { return lu[n]; });
    const btns = nums.map(function (n) {
      return '<button type="button" data-act="pick"' + mid + ' data-kind="' + kind + '" data-no="' + n + '"><b>' + n + "</b><span>" + esc(lu[n]) + "</span></button>";
    }).join("");
    openSheet('<h2 id="sheet-title">' + flagSvg(kind) + "Glen · " + k.label + "</h2>" +
      (btns ? '<p class="hint">Who scored?</p><div class="players">' + btns + "</div>"
            : '<p class="hint">Name the team sheet to pick who scored. You can still add the score now.</p>') +
      '<div class="btnrow"><button type="button" class="pbtn" data-act="pick"' + mid + ' data-kind="' + kind + '" data-no="">Add without a name</button>' +
      '<button type="button" class="linkbtn" data-act="close">Cancel</button></div>');
  }
  function field(id, label, value, attrs, hint) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input id="' + id + '" value="' + esc(value || "") + '" ' + (attrs || "") + ">" +
      (hint ? '<p class="hint">' + hint + "</p>" : "") + "</div>";
  }
  const MAP_HINT = "In Google Maps, find the pitch, tap Share, then Copy link, and paste it here.";
  function openGameForm(g) {
    g = g || { team: state.team !== "all" ? state.team : "", ha: "H" };
    const teamOpts = DATA.teams.map(function (t) { return '<option value="' + esc(t.id) + '"' + (t.id === g.team ? " selected" : "") + ">" + esc(t.name) + "</option>"; }).join("");
    const haOpts = ["H", "A", "N"].map(function (k) { return '<option value="' + k + '"' + (k === (g.ha || "H") ? " selected" : "") + ">" + HA[k] + "</option>"; }).join("");
    const past = g.id && g.d && g.d <= londonToday();
    openSheet('<h2 id="sheet-title">' + (g.id ? "Edit game" : "Add a game") + "</h2>" +
      '<form id="x-form" data-id="' + esc(g.id || "") + '">' +
      '<div class="field"><label for="x-team">Team</label><select id="x-team" required>' + teamOpts + "</select></div>" +
      field("x-opp", "Opponent", g.opp, 'required autocomplete="off" placeholder="e.g. Burren"') +
      field("x-date", "Date", g.d, 'type="date" required') +
      field("x-time", "Throw-in", g.t, 'type="time"') +
      field("x-comp", "Competition", g.comp, 'required autocomplete="off" placeholder="e.g. Challenge match"') +
      field("x-round", "Round", g.round, 'autocomplete="off" placeholder="e.g. Quarter-final"') +
      field("x-venue", "Venue", isTbc(g.venue) ? "" : g.venue, 'autocomplete="off" placeholder="e.g. Watty Graham Park"') +
      field("x-map", "Google Maps link (optional)", g.map, 'type="url" inputmode="url" autocomplete="off" placeholder="https://maps.app.goo.gl/…"', MAP_HINT) +
      '<div class="field"><label for="x-ha">Home or away</label><select id="x-ha">' + haOpts + "</select></div>" +
      (past || g.us ? "<h3>Result</h3>" +
        field("x-us", "Glen score (goals-points)", g.us, 'inputmode="numeric" autocomplete="off" placeholder="e.g. 1-12"') +
        field("x-them", "Opponent score (goals-points)", g.them, 'inputmode="numeric" autocomplete="off" placeholder="e.g. 0-9"') : "") +
      '<p class="err" id="x-err" hidden></p>' +
      '<div class="btnrow"><button type="submit" class="pbtn">Save game</button><button type="button" class="linkbtn" data-act="close">Cancel</button></div>' +
      "</form>");
  }
  function openVenueForm(key) {
    const g = allGames().filter(function (x) { return x.src !== "club" && vkey(x) === key; })[0];
    if (!g) return;
    const o = (LIVE.venues || {})[key] || {};
    openSheet('<h2 id="sheet-title">Venue · Glen v ' + esc(g.opp) + "</h2>" +
      '<p class="hint">' + esc(teamName(g.team)) + ", " + esc(fmtDate(g.d, { weekday: "long", day: "numeric", month: "long" })) +
      ". The official listing says TBC. What you set here shows until it's confirmed.</p>" +
      '<form id="v-form" data-key="' + esc(key) + '">' +
      field("v-name", "Venue", o.name, 'required autocomplete="off" placeholder="e.g. Burren GAC"') +
      field("v-url", "Google Maps link (optional)", o.url, 'type="url" inputmode="url" autocomplete="off" placeholder="https://maps.app.goo.gl/…"', MAP_HINT) +
      '<p class="err" id="v-err" hidden></p>' +
      '<div class="btnrow"><button type="submit" class="pbtn">Save venue</button>' +
      (o.name || o.url ? '<button type="button" class="linkbtn danger" data-act="vclear" data-key="' + esc(key) + '">Back to TBC</button>' : "") +
      '<button type="button" class="linkbtn" data-act="close">Cancel</button></div>' +
      "</form>");
  }
  function openTeamSheet(team) {
    const lu = lineupFor(team);
    const row = function (n, label) {
      return '<div class="tsrow"><b>' + n + '</b><label for="ts-' + n + '">' + esc(label) + "</label>" +
        '<input id="ts-' + n + '" autocomplete="off" value="' + esc(lu[n] || "") + '"></div>';
    };
    openSheet('<h2 id="sheet-title">Team sheet · ' + esc(teamName(team)) + "</h2>" +
      '<form id="ts-form" data-team="' + esc(team) + '" class="tsgrid">' +
      POS.map(function (p) { return row(p.n, p.pos); }).join("") +
      "<h3>Subs</h3>" + SUB_NUMBERS.map(function (n) { return row(n, "Sub"); }).join("") +
      '<div class="btnrow"><button type="submit" class="pbtn">Save team sheet</button><button type="button" class="linkbtn" data-act="close">Cancel</button></div>' +
      "</form>");
  }

  /* ---------- manage scorers (club admin only) ---------- */
  function openManage(msg) {
    if (!isOwner()) return;
    let list;
    if (scorersBlocked) {
      list = '<p class="netnote">Publish the new database rules in Firebase first, then refresh this page.</p>';
    } else if (!SCORERS) {
      list = '<p class="hint">Loading scorers…</p>';
    } else {
      const ids = Object.keys(SCORERS).sort(function (a, b) {
        return (a === OWNER_UID ? -1 : b === OWNER_UID ? 1 : 0) || String(SCORERS[a].name || "").localeCompare(String(SCORERS[b].name || ""));
      });
      list = '<ul class="slist">' + ids.map(function (id) {
        const s = SCORERS[id] || {};
        const me = id === OWNER_UID;
        return '<li><span class="nm">' + esc(s.name || "Scorer") + (me ? " (you)" : "") + "</span>" +
          '<span class="em">' + (s.email ? esc(s.email) : "No email saved · User UID " + esc(id)) + "</span>" +
          (me ? "" : '<span class="btnrow">' +
            (s.email ? '<button type="button" class="linkbtn" data-act="sreset" data-uid="' + esc(id) + '">Send password reset</button>' : "") +
            '<button type="button" class="linkbtn danger" data-act="sremove" data-uid="' + esc(id) + '">Remove</button></span>') +
          "</li>";
      }).join("") + "</ul>";
    }
    openSheet('<h2 id="sheet-title">Manage scorers</h2>' +
      '<p class="hint">Scorers can run live games, set venues, add games and edit team sheets. Only you see this screen.</p>' +
      (msg ? '<p class="okmsg">' + esc(msg) + "</p>" : "") + list +
      "<h3>Add a scorer</h3>" +
      '<form id="s-form">' +
      field("s-name", "Name", "", 'required autocomplete="off" placeholder="e.g. Ciaran (U16 coach)"') +
      field("s-email", "Their email", "", 'type="email" required autocomplete="off"') +
      field("s-pass", "Password for them", "", 'required autocomplete="new-password" minlength="6"', "At least 6 characters. Send them the site link, their email and this password. They can change it later with Forgot password.") +
      '<p class="err" id="s-err" hidden></p>' +
      '<div class="btnrow"><button type="submit" class="pbtn">Create login</button><button type="button" class="linkbtn" data-act="close">Done</button></div>' +
      "</form>" +
      "<details><summary>Already set up in Firebase? Add by User UID</summary>" +
      '<form id="u-form">' +
      field("u-name", "Name", "", 'required autocomplete="off"') +
      field("u-uid", "User UID", "", 'required autocomplete="off" placeholder="From Firebase, Authentication, Users"') +
      '<p class="err" id="u-err" hidden></p>' +
      '<div class="btnrow"><button type="submit" class="pbtn">Add scorer</button></div>' +
      "</form></details>", "manage");
  }
  function adderAuth() {
    if (!adderApp) adderApp = firebase.initializeApp(CFG, "glen-adder");
    return adderApp.auth();
  }
  function createScorer(name, email, pass) {
    const a = adderAuth();
    return a.setPersistence(firebase.auth.Auth.Persistence.NONE)
      .then(function () { return a.createUserWithEmailAndPassword(email, pass); })
      .then(function (cred) {
        const uid = cred.user.uid;
        return a.signOut().then(function () { return db.ref("scorers/" + uid).set({ name: name, email: email }); });
      });
  }
  function authMessage(err) {
    const c = (err && err.code) || "";
    if (c === "auth/email-already-in-use") return "That email already has a login. If it's theirs, use Add by User UID below, or pick another email.";
    if (c === "auth/invalid-email") return "That email doesn't look right. Check it and try again.";
    if (c === "auth/weak-password") return "Use a password with at least 6 characters.";
    if (c === "auth/operation-not-allowed") return "Email/Password sign-in is switched off in Firebase. Turn it on under Authentication, Sign-in method.";
    if (/permission/i.test(c + (err && err.message))) return "The login was made, but saving them as a scorer was refused. Publish the new database rules, then add them by User UID.";
    return "That didn't work. Check your signal and try again.";
  }
  function watchRole(u) {
    if (roleRef) { roleRef.off("value", roleCb); roleRef = null; roleCb = null; }
    SCORERS = null; scorersBlocked = false;
    if (!u) { role = "none"; return; }
    if (u.uid === OWNER_UID) {
      role = "owner";
      roleRef = db.ref("scorers");
      roleCb = function (s) {
        SCORERS = s.val() || {};
        if (!s.exists()) {
          /* first time: list the club admin and the scorers set up in Firebase earlier */
          const seed = {};
          seed[OWNER_UID] = { name: "Club admin", email: u.email || "" };
          EARLIER_SCORERS.forEach(function (id) { seed[id] = { name: "Scorer added earlier", email: "" }; });
          db.ref("scorers").update(seed).catch(function () {});
        }
        if (sheetKind === "manage") openManage();
        render();
      };
      roleRef.on("value", roleCb, function () { scorersBlocked = true; if (sheetKind === "manage") openManage(); render(); });
    } else {
      role = "checking";
      roleRef = db.ref("scorers/" + u.uid);
      roleCb = function (s) { role = s.exists() ? "scorer" : "not-scorer"; render(); };
      /* before the scorers list existed, the database rules alone decided; let a refused save tell them */
      roleRef.on("value", roleCb, function () { role = "scorer"; render(); });
    }
  }

  /* ---------- actions ---------- */
  function addScore(m, side, kind, no, player) {
    const at = now();
    closeSheet();
    save(mref(m, "events").push({
      side: side, type: kind, no: no || null, player: player || "",
      half: m.clock.h2 ? 2 : 1, min: minuteAt(m, at), at: at
    }), (side === "glen" ? "Glen " : m.opp + " ") + KINDS[kind].label.toLowerCase() + " added");
  }
  function armed(btn, label) {
    if (btn.dataset.armed === "1") return true;
    btn.dataset.armed = "1";
    btn.dataset.orig = btn.textContent;
    btn.textContent = label;
    setTimeout(function () { if (btn.isConnected) { btn.dataset.armed = ""; btn.textContent = btn.dataset.orig; } }, 4000);
    return false;
  }

  document.addEventListener("click", function (ev) {
    if (ev.target === sheet) { closeSheet(); return; }
    const tabBtn = ev.target.closest("[data-tab]");
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      tabChosen = true;
      try { sessionStorage.setItem("glen-tab", state.tab); } catch (e) {}
      render();
      return;
    }
    const b = ev.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "close") { closeSheet(); return; }
    if (act === "pickmatch") { state.mid = b.dataset.mid; render(); return; }
    if (act === "signin") { openSignIn(); return; }
    if (act === "signout") { closeSheet(); auth.signOut(); return; }
    if (act === "forgot") {
      const email = ($("#si-email") || {}).value ? $("#si-email").value.trim() : "";
      const err = $("#si-err"), ok = $("#si-ok");
      err.hidden = true; ok.hidden = true;
      if (!email) { err.textContent = "Type your email above first, then tap Forgot password."; err.hidden = false; return; }
      auth.sendPasswordResetEmail(email).then(function () {
        ok.textContent = "If that email has a login, a reset link is on its way. Check your junk folder too."; ok.hidden = false;
      }).catch(function (e) {
        err.textContent = (e && e.code) === "auth/invalid-email" ? "That email doesn't look right." : "Couldn't send the reset email. Try again in a minute.";
        err.hidden = false;
      });
      return;
    }
    if (act === "manage") { openManage(); return; }
    if (act === "sreset" && isOwner()) {
      const s = (SCORERS || {})[b.dataset.uid];
      if (s && s.email) auth.sendPasswordResetEmail(s.email).then(function () { openManage("Password reset email sent to " + s.email + "."); })
        .catch(function () { toast("Couldn't send the reset email. Try again in a minute."); });
      return;
    }
    if (act === "sremove" && isOwner()) {
      if (!armed(b, "Tap again to remove")) return;
      db.ref("scorers/" + b.dataset.uid).remove().then(function () { openManage("Removed. They can no longer change scores."); })
        .catch(function () { toast("That didn't save. Try again."); });
      return;
    }
    if (!canScore() || !db) return;
    const m = b.dataset.mid ? matchById(b.dataset.mid) : null;
    if (act === "add" && m) openScorerPicker(m, b.dataset.side, b.dataset.kind);
    else if (act === "pick" && m) {
      const no = b.dataset.no ? +b.dataset.no : null;
      addScore(m, "glen", b.dataset.kind, no, no ? (lineupFor(m.team)[no] || "") : "");
    } else if (act === "pick-opp" && m) {
      const inp = $("#opp-scorer");
      addScore(m, "opp", b.dataset.kind, null, inp ? inp.value.trim().slice(0, 40) : "");
    } else if (act === "xadd") openGameForm(null);
    else if (act === "xedit") {
      const xg = (LIVE.extra || []).filter(function (x) { return x.id === b.dataset.id; })[0];
      if (xg) openGameForm(xg);
    } else if (act === "xrm") {
      if (!armed(b, "Tap again to remove")) return;
      save(liveRef("fixtures/" + b.dataset.id).remove(), "Game removed");
    } else if (act === "venue") openVenueForm(b.dataset.key);
    else if (act === "vclear") {
      closeSheet();
      save(liveRef("venues/" + b.dataset.key).remove(), "Venue set back to TBC");
    } else if (act === "phase" && m) {
      const key = { pre: "h1", "1h": "ht", ht: "h2", "2h": "ft" }[phase(m)];
      const msg = { h1: "Game started", ht: "Half-time", h2: "2nd half started", ft: "Full-time" }[key];
      if (!key) return;
      const upd = {};
      upd[m.path + "/clock/" + key] = firebase.database.ServerValue.TIMESTAMP;
      if (key === "ft" && m.gid) {
        upd["fixtures/" + m.gid + "/us"] = gp(tally(m.events, "glen"));
        upd["fixtures/" + m.gid + "/them"] = gp(tally(m.events, "opp"));
        upd["fixtures/" + m.gid + "/st"] = "result";
      }
      save(liveRef().update(upd), key === "ft" && m.gid ? "Full-time. Result saved to the game." : msg);
    } else if (act === "unphase" && m) {
      const k = ["ft", "h2", "ht", "h1"].filter(function (x) { return m.clock[x]; })[0];
      if (k) save(mref(m, "clock/" + k).remove(), "Undone");
    } else if (act === "rm" && m) {
      if (!armed(b, "Tap again to remove")) return;
      save(mref(m, "events/" + b.dataset.id).remove(), "Score removed");
    } else if (act === "sheet" && m) openTeamSheet(m.team);
    else if (act === "sheet-setup") {
      const v = $("#setup-fixture").value;
      openTeamSheet(v === "other" ? $("#setup-team").value : setupCandidates()[+v].team);
    } else if (act === "clear" && m) {
      if (!armed(b, "Tap again to clear this game")) return;
      if (state.mid === m.id) state.mid = null;
      save(mref(m).remove(), "Live game cleared");
    } else if (act === "showsetup") { state.showSetup = true; render(); }
    else if (act === "hidesetup") { state.showSetup = false; render(); }
    else if (act === "setup") {
      const v = $("#setup-fixture").value;
      let match;
      if (v === "other") {
        const opp = $("#setup-opp").value.trim();
        if (!opp) { toast("Add the opponent's name first."); $("#setup-opp").focus(); return; }
        match = { team: $("#setup-team").value, opp: opp.slice(0, 40), comp: "Challenge match", venue: $("#setup-venue").value.trim().slice(0, 60), d: londonToday() };
      } else {
        const g = setupCandidates()[+v];
        const vv = venueOf(g);
        match = { team: g.team, opp: g.opp, comp: compLine(g), venue: vv.name || "", d: g.d, gkey: vkey(g) };
        if (vv.url) match.mapUrl = vv.url;
        if (g.t) match.t = g.t;
        if (g.src === "club") match.gid = g.id;
      }
      match.half = +$("#setup-half").value || 30;
      const r = liveRef("matches").push();
      state.mid = r.key;
      state.showSetup = false;
      save(r.set(match), "Live game set up");
    }
  });
  document.addEventListener("change", function (ev) {
    if (ev.target.id === "team") {
      state.team = ev.target.value;
      try { localStorage.setItem("glen-team", state.team); } catch (e) {}
      render();
    } else if (ev.target.id === "setup-fixture") {
      $("#setup-other").hidden = ev.target.value !== "other";
    }
  });
  document.addEventListener("submit", function (ev) {
    const form = ev.target;
    const val = function (id) { const el = $("#" + id); return el ? el.value.trim() : ""; };
    const fail = function (id, msg) { const e = $("#" + id); e.textContent = msg; e.hidden = false; };
    if (form.id === "signin-form") {
      ev.preventDefault();
      $("#si-err").hidden = true; $("#si-ok").hidden = true;
      auth.signInWithEmailAndPassword(val("si-email"), $("#si-pass").value).then(function () {
        closeSheet();
        toast("Signed in. Scoring controls are on the Live tab.");
      }).catch(function () { fail("si-err", "That email or password didn't work. Check them and try again."); });
    } else if (form.id === "x-form") {
      ev.preventDefault();
      if (!canScore() || !db) return;
      const us = val("x-us"), them = val("x-them"), map = val("x-map");
      if ((us || them) && !(/^\d+-\d+$/.test(us) && /^\d+-\d+$/.test(them))) return fail("x-err", "Write both scores as goals-points, like 1-12 and 0-9.");
      if (map && !safeUrl(map)) return fail("x-err", "Paste the full map link, starting with https://");
      const g = { team: val("x-team"), opp: val("x-opp").slice(0, 40), d: val("x-date"), comp: val("x-comp").slice(0, 80),
        round: val("x-round").slice(0, 40), venue: val("x-venue").slice(0, 60) || "TBC", ha: val("x-ha") || "H",
        st: us && them ? "result" : "fixture" };
      if (val("x-time")) g.t = val("x-time");
      if (map) g.map = map.slice(0, 500);
      if (us && them) { g.us = us; g.them = them; }
      if (!g.team || !g.opp || !g.d || !g.comp) return fail("x-err", "Fill in the team, opponent, date and competition.");
      closeSheet();
      const id = form.dataset.id;
      save(id ? liveRef("fixtures/" + id).set(g) : liveRef("fixtures").push(g), id ? "Game updated" : "Game added");
    } else if (form.id === "v-form") {
      ev.preventDefault();
      if (!canScore() || !db) return;
      const name = val("v-name").slice(0, 60), url = val("v-url");
      if (!name) return fail("v-err", "Add the venue name.");
      if (url && !safeUrl(url)) return fail("v-err", "Paste the full map link, starting with https://");
      const o = { name: name };
      if (url) o.url = url.slice(0, 500);
      closeSheet();
      save(liveRef("venues/" + form.dataset.key).set(o), "Venue saved");
    } else if (form.id === "ts-form") {
      ev.preventDefault();
      if (!canScore() || !db) return;
      const team = form.dataset.team;
      const lu = {};
      POS.map(function (p) { return p.n; }).concat(SUB_NUMBERS).forEach(function (n) {
        const v = (form.querySelector("#ts-" + n).value || "").trim();
        if (v) lu["n" + n] = v.slice(0, 40);
      });
      closeSheet();
      /* stored as n1..n26 so Firebase keeps it as an object */
      save(liveRef("lineups/" + team).set(lu), "Team sheet saved");
    } else if (form.id === "s-form") {
      ev.preventDefault();
      if (!isOwner()) return;
      const name = val("s-name").slice(0, 40), email = val("s-email"), pass = $("#s-pass").value;
      if (!name || !email) return fail("s-err", "Add their name and email.");
      if (pass.length < 6) return fail("s-err", "Use a password with at least 6 characters.");
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true; btn.textContent = "Creating…";
      createScorer(name, email, pass).then(function () {
        openManage(name + " can now sign in as a scorer with " + email + ".");
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = "Create login";
        fail("s-err", authMessage(e));
      });
    } else if (form.id === "u-form") {
      ev.preventDefault();
      if (!isOwner()) return;
      const name = val("u-name").slice(0, 40), uid = val("u-uid");
      if (!/^[A-Za-z0-9]{20,40}$/.test(uid)) return fail("u-err", "That doesn't look like a User UID. Copy it from Firebase, Authentication, Users.");
      db.ref("scorers/" + uid).set({ name: name || "Scorer", email: "" }).then(function () { openManage(name + " added as a scorer."); })
        .catch(function () { fail("u-err", "That didn't save. Publish the new database rules, then try again."); });
    }
  });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape" && !sheet.hidden) closeSheet(); });

  /* ---------- boot: fixtures ---------- */
  fetch("fixtures.json?v=" + Date.now(), { cache: "no-store" }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function (d) {
    DATA = d;
    TEAMS = {};
    DATA.teams.forEach(function (t) { TEAMS[t.id] = t; });
    dataState = "ready";
    buildPicker();
    render();
  }).catch(function () { dataState = "error"; render(); });

  /* ---------- boot: live scores ---------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }
  if (CFG) {
    loadScript(FIREBASE_SDK + "firebase-app-compat.js")
      .then(function () { return Promise.all([loadScript(FIREBASE_SDK + "firebase-database-compat.js"), loadScript(FIREBASE_SDK + "firebase-auth-compat.js")]); })
      .then(function () {
        firebase.initializeApp(CFG);
        db = firebase.database();
        auth = firebase.auth();
        db.ref(".info/serverTimeOffset").on("value", function (s) { serverOffset = s.val() || 0; });
        db.ref(".info/connected").on("value", function (s) {
          const was = online;
          online = s.val() === true;
          if (was !== online && canScore() && state.tab === "live") render();
        });
        auth.onAuthStateChanged(function (u) { user = u; watchRole(u); render(); });
        liveRef().on("value", function (snap) {
          LIVE = normaliseLive(snap.val() || {});
          const first = liveState !== "ready";
          liveState = "ready";
          const today = londonToday();
          if (first && !tabChosen && LIVE.matches.some(function (m) { return isActive(m) || (m.d === today && !m.clock.ft); })) state.tab = "live";
          render();
        }, function () { liveState = "error"; render(); });
      })
      .catch(function () { liveState = "error"; render(); });
  }
})();

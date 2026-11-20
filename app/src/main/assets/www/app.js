/*
 * Konso — application logic.
 *
 * Runs inside the Android app (a WebView, see MainActivity.java) or in any browser: the web version
 * (installable PWA) is the same files, published by tools/build-web.js with web/ (offline cache, icons).
 *
 * Files
 * - index.html: the screens (four tabs: Fill-ups, Stations, Stats, My garage with the cars and
 *               the purchases; Settings, opened with the gear of the top bar; plus overlays).
 * - app.css:    the styles (Material Design 3, light and dark theme).
 * - app.js:     this file, all the behaviour.
 * - i18n.js:    every text shown, in 10 languages. The code never contains visible text: tx(key).
 * - parse.js:   reads the values (litres, price, amount...) out of the OCR text of a receipt.
 *
 * How it works
 * - All the user's data is one object, S (see "Data model and storage"). After every change, the
 *   code calls persist() to save S, then render() to redraw the screens from S.
 * - S is saved twice: in localStorage (always), and in the Android app to a konso.json file in a
 *   folder the user picked, through the `Android` bridge (NA) provided by MainActivity.java.
 *   In the web version there is no folder: the user saves and opens backup files (see "Web version").
 * - Distances are always stored in km and volumes in litres. The units chosen by the user only
 *   change what is displayed and typed (see "Units and currency").
 * - Short names used everywhere: $ = getElementById, tx = translate, fmt = format a number,
 *   S = data, FU / BU = fill-ups / purchases of the selected car, NA = native Android bridge.
 *
 * The file reads from top to bottom; the app starts at the very end ("Startup").
 */

// ================================================================================================
// Basics: DOM shortcut, language, translations, numbers
// ================================================================================================

// Shortcut for document.getElementById.
const $ = id => document.getElementById(id);
// LANGS: [code, name, locale] of the 10 languages; DICT: the texts, by language (i18n.js).
const { LANGS, D: DICT } = I18N;
// Prefix of every localStorage key. A test build of the web version (published under /test/<branch>/ on
// the same site) uses its own keys, so it never touches the data of the real one.
const KP = /\/test\/[^/]+\//.test(location.pathname) ? 'konso-test-' : 'konso-';
// localStorage key of the chosen language. LANG is its code, LOC the locale used to format numbers and dates.
const LK = KP + 'lang';
let LANG = 'fr',
  LOC = 'fr-FR';
// Translate: returns the text of key k in the current language (French if missing).
// v replaces {name} placeholders, e.g. tx('svc_saved', {km: '10 000 km'}).
// {du} {vu} {cu} {cs} are always filled with the chosen distance, volume and consumption units and the
// currency symbol, so texts like "Distance ({du})" follow the user's settings.
const tx = (k, v) => {
  let s = (DICT[LANG] && DICT[LANG][k]) || DICT.fr[k] || k;
  if (v) for (const x in v) s = s.split('{' + x + '}').join(v[x]);
  return s.replace(/\{(du|vu|cu|cs)\}/g, (m, x) =>
    x === 'du' ? DU() : x === 'vu' ? VU() : x === 'cu' ? CU() : curSym(),
  );
};
// Format a number in the current language with d decimals ("–" if it is not a number).
const fmt = (n, d = 2) =>
  isFinite(n) ? n.toLocaleString(LOC, { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';

// ================================================================================================
// Units and currency
// Preferences of the device, like the language. Data is always stored in km and litres: only what is
// displayed and typed is converted, so changing units never loses anything. The currency only changes
// the symbol shown: amounts are never converted (there are no exchange rates).
// ================================================================================================

// localStorage keys of the chosen units and currency.
const UK = KP + 'units',
  MK = KP + 'money';
const UNITS = ['km', 'uk', 'us']; // km + litres (L/100 km); miles + litres (imperial mpg, UK); miles + US gallons (US mpg)
const UNIT_LABEL = { km: 'km · L/100 km', uk: 'miles · mpg (UK)', us: 'miles · mpg (US)' };
const MONEY = ['EUR', 'GBP', 'USD', 'CHF', 'PLN', 'RON', 'TRY']; // currencies of the countries of the 10 languages
const MONEY_BY_LANG = { en: 'GBP', pl: 'PLN', ro: 'RON', tr: 'TRY' }; // proposed at first launch (EUR otherwise)
// Conversion factors: km per mile, litres per US gallon, litres per imperial (UK) gallon.
const MI = 1.609344,
  USGAL = 3.785411784,
  IMPGAL = 4.54609;
// Current settings (loaded at startup by init()).
let UNIT = 'km',
  MONEYC = 'EUR';
// Conversions between stored values (km, litres) and the units shown on screen.
const dist = k => (UNIT === 'km' ? k : k / MI),
  distIn = v => (UNIT === 'km' ? v : v * MI); // km <-> displayed unit
const vol = l => (UNIT === 'us' ? l / USGAL : l),
  volIn = v => (UNIT === 'us' ? v * USGAL : v); // litres <-> displayed unit
// Unit labels: distance, volume, consumption.
const DU = () => (UNIT === 'km' ? 'km' : 'mi'),
  VU = () => (UNIT === 'us' ? 'gal' : 'L'),
  CU = () => (UNIT === 'km' ? 'L/100 km' : 'mpg');
// Fuel consumption from a distance in km and a volume in litres:
// L/100 km, or miles per gallon (imperial gallon in UK mode, US gallon in US mode).
const cons = (k, l) => (UNIT === 'km' ? (l / k) * 100 : k / MI / (l / (UNIT === 'us' ? USGAL : IMPGAL)));
// L/100 km with 2 decimals, mpg with 1.
const fmtCons = v => fmt(v, UNIT === 'km' ? 2 : 1);
// Round to 3 decimals (stored values converted from miles / gallons).
const round3 = x => Math.round(x * 1000) / 1000;
// One fixed symbol per currency. The short symbol given by the system depends on the language
// (the Romanian leu can be "L", "lei" or "lej", and "L" would read as litres), so we use ours.
const SYM = { EUR: '€', GBP: '£', USD: '$', CHF: 'CHF', PLN: 'zł', RON: 'lei', TRY: '₺' };
// Format an amount: the language decides where the symbol goes (before or after), SYM gives the symbol.
function money(n, d = 2, code = MONEYC) {
  if (!isFinite(n)) return '–';
  try {
    return new Intl.NumberFormat(LOC, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: d,
      maximumFractionDigits: d,
    })
      .formatToParts(n)
      .map(x => (x.type === 'currency' ? SYM[code] : x.value))
      .join('');
  } catch (e) {
    return fmt(n, d) + ' ' + SYM[code];
  }
}
// Symbol of a currency.
const curSym = (code = MONEYC) => SYM[code] || code;
// Name of a currency in the current language ("Euro", "Livre sterling"...).
function curName(code) {
  try {
    const n = new Intl.DisplayNames([LOC], { type: 'currency' }).of(code);
    return n.charAt(0).toLocaleUpperCase(LOC) + n.slice(1);
  } catch (e) {
    return code;
  }
}
// Label shown in the currency wheel and the Settings field, e.g. "€ — Euro".
const moneyLabel = code => curSym(code) + ' — ' + curName(code);

// ================================================================================================
// Theme
// A preference of the device, like the language: 'auto' follows the device (prefers-color-scheme),
// 'light' and 'dark' force a theme. The colours are in app.css; a forced theme is the data-theme
// attribute of <html>.
// ================================================================================================

// localStorage key of the theme, the three choices, and the current one (loaded by init()).
const TK = KP + 'theme';
const THEMES = ['auto', 'light', 'dark'];
let THEME = 'auto';
// Colours of the browser bar (web version), as in the <meta name="theme-color"> tags of index.html.
const BAR_COLOR = { light: '#f9f9ff', dark: '#111318' };
// Show theme t: data-theme on <html> (none for 'auto'), the colour scheme of the native controls
// (date fields, menus), and the colour of the browser bar. Does not save it (see setTheme()).
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'auto') root.removeAttribute('data-theme');
  else root.dataset.theme = t;
  root.style.colorScheme = t === 'auto' ? '' : t;
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => {
    const own = /dark/.test(m.media) ? 'dark' : 'light';
    m.content = BAR_COLOR[t === 'auto' ? own : t];
  });
  syncBars(t);
}
// Layout with the navigation rail on the left (wide screens, phones in landscape), as in app.css.
const RAIL = matchMedia('(min-width: 840px)');
// Android app: colour the phone's status bar like the top of the page (--surface) and its
// navigation bar like what is just above it: the page's bottom bar (--surf), or the page itself
// (--surface) when the navigation is the rail on the left. Icons stay readable, so the app looks
// like it fills the screen (MainActivity: Bridge.setBars()). t = the theme shown.
function syncBars(t) {
  if (!NA || typeof NA.setBars !== 'function') return;
  const css = getComputedStyle(document.documentElement),
    dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const top = css.getPropertyValue('--surface').trim(),
    bottom = css.getPropertyValue(RAIL.matches ? '--surface' : '--surf').trim();
  NA.setBars(top, bottom, dark);
}
// The device switches between light and dark (Automatic theme), or the layout changes (phone
// turned): the bars follow.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => syncBars(THEME));
RAIL.addEventListener('change', () => syncBars(THEME));
// Android app in landscape: the page is drawn next to the camera cutout; keep its content clear of
// it with the room the cutout takes on the left and right (--cut-l, --cut-r, used by --sa-l and
// --sa-r in app.css). MainActivity calls window.onInsets when it changes (phone turned).
function syncInsets() {
  if (!NA) return;
  // the Android app keeps the page clear of the bars at the top and bottom itself (app.css: .native)
  document.documentElement.classList.add('native');
  if (typeof NA.insets !== 'function') return;
  const [l, r] = String(NA.insets()).split(',').map(Number),
    px = v => (v > 0 ? v : 0) + 'px';
  document.documentElement.style.setProperty('--cut-l', px(l));
  document.documentElement.style.setProperty('--cut-r', px(r));
}
window.onInsets = syncInsets;
// Choose theme t; store = remember it on this device.
function setTheme(t, store) {
  THEME = THEMES.includes(t) ? t : 'auto';
  applyTheme(THEME);
  if (store) {
    try {
      localStorage.setItem(TK, THEME);
    } catch (e) {}
  }
  $('themeBtn').textContent = tx('theme_' + THEME);
}

// ================================================================================================
// Dates and HTML escaping
// ================================================================================================

// Today as YYYY-MM-DD in local time (toISOString would give the UTC date, i.e. yesterday just after midnight).
const today = () => {
  const d = new Date(),
    p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
// Show a YYYY-MM-DD date in the language format (full year). Noon avoids time zone surprises.
const fdate = s => {
  try {
    return new Date(s + 'T12:00:00').toLocaleDateString(LOC);
  } catch (e) {
    return s;
  }
};
// Short date with a 2-digit year (fill-up history).
const fdateS = s => {
  try {
    return new Date(s + 'T12:00:00').toLocaleDateString(LOC, {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
  } catch (e) {
    return s;
  }
};
// Escape text before putting it in HTML (user input such as car names or station names).
const esc = s =>
  String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ================================================================================================
// Values saved in the data file
// ================================================================================================

// Fuel types and purchase categories, as written in the data file. They are French words because
// the first versions were French-only; they never change with the language. fuelLabel() and catLabel()
// translate them for display. Never rename them: existing files would lose their meaning.
// In i18n.js, "catN" is the label of CATV[N]: new categories must be added at the end.
const FUELV = ['SP95-E10', 'SP95', 'SP98', 'E85', 'GPL', 'Gazole'];
const CATV = [
  'Huile moteur',
  'Huile boîte / pont',
  'Filtres',
  'Freinage',
  'Suspension / train roulant',
  'Pneus',
  'Liquides',
  'Électricité / éclairage',
  'Pièces moteur',
  'Carrosserie',
  'Outillage',
  'Autre',
  'Entretien / révision',
];
// Translated label of a fuel type or a category.
const fuelLabel = v => ('fuel_' + v in DICT.fr ? tx('fuel_' + v) : v);
const catLabel = c => {
  const i = CATV.indexOf(c);
  return i >= 0 ? tx('cat' + i) : c;
};

// ================================================================================================
// Data model and storage
// ================================================================================================

// The user's data. Format (also the format of konso.json, version 2):
//   cars: [{id, name, fuel, svcKm, svcDone, price, buyKm, ins, insPer}]
//         fuel = usual fuel type, svcKm = service interval in km,
//         svcDone = date of the last service confirmed from the banner,
//         optional "advanced options" of the garage (0 = not given): price = purchase price,
//         buyKm = odometer at purchase in km, ins = insurance price, paid per insPer ('y' year, 'm' month)
//   cur:  id of the selected car
//   fuel: fill-ups  [{id, car, d: date, k: km since the previous fill-up, l: litres, e: amount, c: fuel type, s: station}]
//   buys: purchases [{id, car, d: date, e: amount, c: category, n: description, k: odometer in km, s: shop}]
//   plan: the car the user wants to buy (My garage, "Buying a new car"), see planDefault()
//   stations: followed stations (Stations tab) [{id: number of the official feed, adr, ville, cp,
//             h: {fuel name of the feed (e10, gazole...): [[date "YYYY-MM-DDTHH:MM", price per litre]]}}]
// Lists are kept sorted from the most recent date. LS is the localStorage key of the copy.
// The car the user wants to buy, empty. price, ins (paid per insPer), cons in L/100 km, fuel = price
// of a litre, withBuys = count the purchases of the current car, resale = resale price of the
// current car (typed by the user, 0 = none). km (per year, in km) is null while the user keeps the
// value suggested by the app (from the fill-ups).
const planDefault = () => ({
  price: 0,
  ins: 0,
  insPer: 'y',
  cons: 0,
  fuel: 0,
  withBuys: false,
  km: null,
  resale: 0,
});
let S = {
    cars: [{ id: 'c1', name: '', fuel: 'SP95-E10' }],
    cur: 'c1',
    fuel: [],
    buys: [],
    plan: planDefault(),
    stations: [],
  },
  LS = KP + 'data';
const carName = c => c.name || tx('car_default'); // the default car has no name: translated label
// Clean data coming from a file, an import or localStorage: types checked, texts cut to a maximum
// length, unusable lines dropped, unique ids. Accepts the old format (without cars) and attaches every
// line to an existing car.
function norm(d) {
  const num = v => {
    v = +v;
    return isFinite(v) ? v : 0;
  };
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : today());
  const arr = v => (Array.isArray(v) ? v : []).filter(x => x && typeof x === 'object');
  const seen = new Set();
  let auto = Date.now();
  const uid = v => {
    let id = num(v);
    while (!(id > 0) || seen.has(id)) id = ++auto;
    seen.add(id);
    return id;
  };
  let cars = arr(d.cars)
    .map(c => ({
      id: str(c.id, 40),
      name: str(c.name, 40).trim(),
      fuel: str(c.fuel, 20),
      svcKm: svcEvery(c),
      svcDone: /^\d{4}-\d{2}-\d{2}$/.test(c.svcDone) ? c.svcDone : '',
      price: Math.max(0, num(c.price)),
      buyKm: Math.max(0, num(c.buyKm)),
      ins: Math.max(0, num(c.ins)),
      insPer: c.insPer === 'm' ? 'm' : 'y',
    }))
    .filter(c => c.id);
  cars = cars.filter((c, i) => cars.findIndex(x => x.id === c.id) === i);
  if (!cars.length) cars = [{ id: 'c1', name: '', fuel: 'SP95-E10' }];
  const ids = new Set(cars.map(c => c.id)),
    car = v => (ids.has(v) ? v : cars[0].id);
  const byDate = (a, b) => b.d.localeCompare(a.d) || b.id - a.id;
  const fuel = arr(d.fuel)
    .map(x => ({
      id: uid(x.id),
      car: car(x.car),
      d: day(x.d),
      k: num(x.k),
      l: num(x.l),
      e: num(x.e),
      c: str(x.c, 40),
      s: str(x.s, 80),
    }))
    .filter(x => x.k > 0 && x.l > 0 && x.e > 0)
    .sort(byDate);
  const buys = arr(d.buys)
    .map(x => ({
      id: uid(x.id),
      car: car(x.car),
      d: day(x.d),
      e: num(x.e),
      c: str(x.c, 60),
      n: str(x.n, 120),
      k: Math.max(0, num(x.k)),
      s: str(x.s, 80),
    }))
    .filter(x => x.e > 0)
    .sort(byDate);
  return { cars, cur: car(d.cur), fuel, buys, plan: normPlan(d.plan), stations: normStations(d.stations) };
}
// Clean the followed stations: a positive number id (once), texts cut to a maximum length, the
// position if valid (lat, lon), and for each fuel the valid [date, price] pairs, oldest first, at
// most 400.
function normStations(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x === 'object' && +x.id > 0 && !seen.has(+x.id) && seen.add(+x.id))
    .map(x => {
      const h = {};
      for (const f of ['e10', 'sp95', 'sp98', 'e85', 'gplc', 'gazole']) {
        const pts = (Array.isArray(x.h && x.h[f]) ? x.h[f] : [])
          .filter(p => Array.isArray(p) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p[0]) && +p[1] > 0)
          .map(p => [p[0], +p[1]])
          .sort((a, b) => a[0].localeCompare(b[0]))
          .slice(-400);
        if (pts.length) h[f] = pts;
      }
      const t = (v, n) => String(v == null ? '' : v).slice(0, n);
      const st = { id: +x.id, adr: t(x.adr, 120), ville: t(x.ville, 80), cp: t(x.cp, 5), h };
      // position (stations map), kept when it is a valid latitude / longitude
      if (typeof x.lat === 'number' && typeof x.lon === 'number' && Math.abs(x.lat) <= 90 && Math.abs(x.lon) <= 180) {
        st.lat = +x.lat;
        st.lon = +x.lon;
      }
      return st;
    });
}
// Clean the "Buying a new car" data (planDefault() if missing): numbers >= 0, km null when not
// typed by the user.
function normPlan(p) {
  p = p && typeof p === 'object' ? p : {};
  const pos = v => (isFinite(+v) && +v > 0 ? +v : 0),
    opt = v => (v === null || v === undefined || v === '' || !isFinite(+v) || +v < 0 ? null : +v);
  return {
    price: pos(p.price),
    ins: pos(p.ins),
    insPer: p.insPer === 'm' ? 'm' : 'y',
    cons: pos(p.cons),
    fuel: pos(p.fuel),
    withBuys: p.withBuys === true,
    km: opt(p.km),
    resale: pos(p.resale),
  };
}
// The selected car, and its fill-ups (FU) and purchases (BU), most recent first.
const curCar = () => S.cars.find(c => c.id === S.cur) || S.cars[0];
const FU = () => S.fuel.filter(f => f.car === S.cur);
const BU = () => S.buys.filter(b => b.car === S.cur);
const NA = typeof Android !== 'undefined' ? Android : null; // null in a plain browser
// folder: name of the backup folder chosen in the Android app ('' if none).
// pendingFile: data found in a newly chosen folder while the app already has data (the user decides).
// setupMode: first launch in the Android app, until a folder is chosen.
let folder = '',
  pendingFile = null,
  setupMode = false;
// At first launch, once the folder is chosen: the guided tour (in My garage), or if it was already
// seen, the Fill-ups tab.
function finishSetup() {
  if (!setupMode) return;
  setupMode = false;
  setTimeout(() => tourStart('start') || showTab('fuel'), 900);
}
// Short message at the bottom of the screen (snackbar), hidden after 4.5 s.
let stT = null;
function status(m) {
  const e = $('st');
  clearTimeout(stT);
  e.textContent = m || '';
  e.classList.toggle('show', !!m);
  if (m) stT = setTimeout(() => e.classList.remove('show'), 4500);
}
// Does d look like Konso data? (norm() then cleans it.)
function validData(d) {
  return d && Array.isArray(d.fuel) && Array.isArray(d.buys);
}
// Content of konso.json.
function payload() {
  return JSON.stringify(
    {
      app: 'konso',
      version: 2,
      saved: new Date().toISOString(),
      cars: S.cars,
      cur: S.cur,
      fuel: S.fuel,
      buys: S.buys,
      plan: S.plan,
      stations: S.stations,
    },
    null,
    2,
  );
}
// Copy of the data in localStorage (kept by the WebView between launches).
function cacheSave() {
  try {
    localStorage.setItem(LS, JSON.stringify(S));
  } catch (e) {}
}
function cacheLoad() {
  try {
    const v = JSON.parse(localStorage.getItem(LS));
    if (validData(v)) return v;
  } catch (e) {}
  return null;
}
// Save after a change: localStorage right away, the file 300 ms later
// (several changes in a row are written once).
let wt = null;
function persist() {
  cacheSave();
  clearTimeout(wt);
  wt = setTimeout(writeOut, 300);
}
// Save without the "Saved" message (only errors are shown): for fields saved while the user
// types, like the ones of "Buying a new car".
function persistQuiet() {
  cacheSave();
  clearTimeout(wt);
  wt = setTimeout(() => writeOut(true), 800);
}
// Write konso.json in the chosen folder, through the Android bridge. quiet = no message on success.
function writeOut(quiet) {
  if (!NA) {
    if (!quiet) status(tx('st_local'));
    return;
  }
  if (!folder) {
    if (!quiet) status(tx('st_nofolder'));
    return;
  }
  try {
    const r = String(NA.writeFile(payload()));
    if (r !== 'ok' || !quiet) status(r === 'ok' ? tx('st_saved', { f: folder }) : tx('st_wfail', { e: r }));
  } catch (e) {
    status(tx('st_wfail', { e: '' }));
  }
  renderSave();
}
// Read konso.json from the chosen folder (null if there is none or it is not Konso data).
function readFileData() {
  if (!NA || !folder) return null;
  const t = String(NA.readFile() || '');
  if (!t) return null;
  const d = JSON.parse(t);
  return validData(d) ? d : null;
}

// ================================================================================================
// Service reminder: what is due
// A service is advised every year or every N km (N chosen per car), whichever comes first. The
// distance is the sum of the fill-up distances since the last service. What the user sees (banner,
// dialogs) is in "Service reminder: banner and dialogs" further down.
// ================================================================================================

// A purchase in this category counts as a service (resets the service reminder).
// CATSHOW is the order shown in the category wheel.
const SVC_CAT = 'Entretien / révision';
const CATSHOW = [...CATV.filter(c => c !== 'Autre' && c !== SVC_CAT), SVC_CAT, 'Autre']; // order shown in the wheel
// Choices of the service interval wheel: 100 to 1,000 by 100, then by 1,000 up to 10,000, by 5,000 up to 30,000, by 10,000 up to 100,000.
const SVC_KM = [];
for (let v = 100; v <= 100000; v += v < 1000 ? 100 : v < 10000 ? 1000 : v < 30000 ? 5000 : 10000)
  SVC_KM.push(v);
// Service interval of a car, in km (stored in km like every distance; 10,000 km by default).
// The wheel shows the same round values in the chosen unit.
const svcEvery = c => {
  const v = +c.svcKm;
  return v >= 100 && v <= 170000 ? v : 10000;
};
// A distance stored in km, shown in the chosen unit, e.g. "6,214 mi".
const kmTxt = n => fmt(dist(n), 0) + ' ' + DU();
// Index of the value of list closest to v.
const nearest = (list, v) => list.reduce((b, x, i) => (Math.abs(x - v) < Math.abs(list[b] - v) ? i : b), 0);
// Same date one year later (29 February becomes 1 March).
function addYear(d) {
  const [y, m, j] = d.split('-').map(Number);
  return new Date(Date.UTC(y + 1, m - 1, j)).toISOString().slice(0, 10);
}
// Service reminder status of car c, or null if there is nothing to compute (no fill-up, no service).
// - ref:   date of the last service (or of the first fill-up when no service was ever recorded: start = true)
// - km:    distance driven since ref (sum of the fill-up distances after that date)
// - next:  ref + 1 year;  left: km remaining before the interval
// - due:   true when the interval (overKm) or the year (overDate) is reached
function svcInfo(c) {
  const every = svcEvery(c),
    svc = S.buys.find(b => b.car === c.id && b.c === SVC_CAT),
    fills = S.fuel.filter(f => f.car === c.id);
  // Reference: the most recent of the service confirmed from the banner and the last service purchase.
  let ref = svc ? svc.d : '',
    start = false,
    km;
  if (c.svcDone && c.svcDone > ref) ref = c.svcDone;
  if (ref) km = fills.filter(f => f.d > ref).reduce((a, f) => a + f.k, 0);
  else if (fills.length) {
    start = true;
    ref = fills[fills.length - 1].d;
    km = fills.slice(0, -1).reduce((a, f) => a + f.k, 0);
  } else return null;
  const next = addYear(ref),
    overKm = km >= every,
    overDate = today() >= next;
  return {
    ref,
    start,
    km,
    every,
    next,
    left: Math.max(0, every - km),
    overKm,
    overDate,
    due: overKm || overDate,
  };
}

// ================================================================================================
// Language and texts
// ================================================================================================

// Language of the phone if Konso has it, English otherwise.
function guessLang() {
  const n = String(navigator.language || 'en')
    .slice(0, 2)
    .toLowerCase();
  return LANGS.some(l => l[0] === n) ? n : 'en';
}
// Put the texts of the current language in the page: every element with data-i18n (text),
// data-i18n-html (HTML), data-i18n-title (tooltip) or data-i18n-ph (placeholder), the lists, and the
// fields that show a setting.
function applyI18n() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n]').forEach(e => (e.textContent = tx(e.dataset.i18n)));
  document.querySelectorAll('[data-i18n-html]').forEach(e => (e.innerHTML = tx(e.dataset.i18nHtml)));
  document.querySelectorAll('[data-i18n-title]').forEach(e => {
    const s = tx(e.dataset.i18nTitle);
    e.title = s;
    e.setAttribute('aria-label', s);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(e => (e.placeholder = tx(e.dataset.i18nPh)));
  setFormFuel($('fc').value);
  if ($('carFuel').value) setCarFuel($('carFuel').value);
  if ($('carInsPer').value) setInsPer($('carInsPer').value);
  if ($('pInsPer').value) setPlanInsPer($('pInsPer').value);
  setCat($('bc').value || CATSHOW[0]);
  $('langBtn').textContent = (LANGS.find(l => l[0] === LANG) || LANGS[0])[1];
  $('unitBtn').textContent = UNIT_LABEL[UNIT];
  $('moneyBtn').textContent = moneyLabel(MONEYC);
  $('themeBtn').textContent = tx('theme_' + THEME);
  $('fl').nextElementSibling.textContent = tx(UNIT === 'us' ? 'gallons' : 'litres');
}
// Switch language and redraw everything. store = also remember it (false while previewing in a wheel).
function setLang(l, store) {
  const x = LANGS.find(a => a[0] === l) || LANGS[1];
  LANG = x[0];
  LOC = x[2];
  if (store) {
    try {
      localStorage.setItem(LK, LANG);
    } catch (e) {}
  }
  applyI18n();
  applyCarDefaults();
  render();
  renderSave();
  live();
}

// ================================================================================================
// Wheel picker
// ================================================================================================

// Turn the element `list` into a wheel, like when setting up an Android phone: the user scrolls,
// the value in the middle band is the chosen one.
// - labels: texts of the items; sel: index selected at the start
// - loop:   endless wheel (the list is repeated 3 times and the scroll jumps back to the middle copy)
// - onPick: called with the index each time the wheel stops on another value
// Returns a function giving the index currently in the middle.
// The wheel must be visible when this is called, otherwise the scroll position is ignored.
function makeWheel(list, labels, sel, loop, onPick) {
  const N = labels.length,
    IT = 56;
  list.innerHTML = (loop ? [0, 1, 2] : [0])
    .map(() => labels.map(l => '<div class="it">' + esc(l) + '</div>').join(''))
    .join('');
  const items = [...list.children];
  let tm = null;
  const at = () => {
    const k = Math.round(list.scrollTop / IT);
    return loop ? ((k % N) + N) % N : Math.max(0, Math.min(N - 1, k));
  };
  const paint = () => {
    const c = list.scrollTop / IT;
    items.forEach((e, k) => {
      const d = Math.abs(k - c);
      e.style.opacity = Math.max(0.25, 1 - d * 0.3);
      e.style.transform = 'scale(' + Math.max(0.72, 1 - d * 0.1) + ')';
      e.style.color = d < 0.5 ? 'var(--on-primary-c)' : '';
    });
  };
  const settle = () => {
    const k = Math.round(list.scrollTop / IT),
      real = at();
    if (loop && (k < N || k >= 2 * N)) {
      list.style.scrollSnapType = 'none';
      list.scrollTop = (N + real) * IT;
      list.style.scrollSnapType = '';
    }
    if (real !== sel) {
      sel = real;
      if (onPick) onPick(sel);
    }
    paint();
  };
  list.onscroll = () => {
    paint();
    clearTimeout(tm);
    tm = setTimeout(settle, 130);
  };
  items.forEach((e, k) => (e.onclick = () => list.scrollTo({ top: k * IT, behavior: 'smooth' })));
  list.scrollTop = ((loop ? N : 0) + sel) * IT;
  paint();
  return at;
}
// Icons of the wheel screen and the dialogs (SVG paths). globe, wrench, pump and pin are copied from
// icons already in the page.
const ICON = {
  globe: document.querySelector('#lang svg path').getAttribute('d'),
  wrench: document.querySelector('#svcBar svg path').getAttribute('d'),
  pump: document.querySelector('.nav [data-t="fuel"] svg path').getAttribute('d'),
  pin: document.querySelector('.nav [data-t="stations"] svg path').getAttribute('d'),
  theme:
    'M20 15.31L23.31 12 20 8.69V4h-4.69L12 .69 8.69 4H4v4.69L.69 12 4 15.31V20h4.69L12 23.31 15.31 20H20v-4.69zM12 18V6c3.31 0 6 2.69 6 6s-2.69 6-6 6z',
  ruler:
    'M21 6H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 10H3V8h2v4h2V8h2v4h2V8h2v4h2V8h2v4h2V8h2v8z',
  money:
    'M19 14V6c0-1.1-.9-2-2-2H3c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zm-9-1c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm13-6v11c0 1.1-.9 2-2 2H4v-2h17V7h2z',
  install: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  file: 'M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
  block:
    'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 014 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0120 12c0 4.42-3.58 8-8 8z',
  code: 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
  share:
    'M16 5l-1.42 1.42-1.59-1.59V16h-1.98V4.83L9.42 6.42 8 5l4-4 4 4zm4 5v11c0 1.1-.9 2-2 2H6c-1.11 0-2-.9-2-2V10c0-1.11.89-2 2-2h3v2H6v11h12V10h-3V8h3c1.1 0 2 .89 2 2z',
};
// An icon of ICON as inline SVG, to put in a text (sized by the CSS of where it is used).
const iconSvg = k => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[k]}"/></svg>`;
// Full-screen wheel with Cancel / Confirm: the app's way of choosing a value in a list
// (preferred to native drop-down menus). Options:
//   icon, color      icon of ICON and its color
//   title            translation key of the title (updated if the language changes meanwhile)
//   sub              text under the title, or function(index) -> text that follows the wheel
//   step             translation key of "Step n of 3" (first launch)
//   labels, sel, loop, onPick   as in makeWheel()
//   ok, cancel       translation keys of the two buttons (default: Confirm / Cancel)
//   onOk(index), onCancel()
function picker(o) {
  $('pkPath').setAttribute('d', ICON[o.icon]);
  $('pkIcon').style.color = o.color || 'var(--primary)';
  $('pkTitle').dataset.i18n = o.title;
  $('pkTitle').textContent = tx(o.title);
  const sub = i => {
    const t = typeof o.sub === 'function' ? o.sub(i) : o.sub || '';
    $('pkSub').textContent = o.step ? tx(o.step) + (t ? ' · ' + t : '') : t;
  };
  sub(o.sel);
  for (const [id, k] of [
    ['pk-ok', o.ok || 'validate'],
    ['pk-cancel', o.cancel || 'cancel'],
  ]) {
    $(id).dataset.i18n = k;
    $(id).textContent = tx(k);
  }
  $('picker').classList.remove('hide');
  const get = makeWheel($('pk-list'), o.labels, o.sel, o.loop, i => {
      sub(i);
      if (o.onPick) o.onPick(i);
    }),
    close = () => $('picker').classList.add('hide');
  $('pk-ok').onclick = () => {
    const i = get();
    close();
    o.onOk(i);
  };
  $('pk-cancel').onclick = () => {
    close();
    if (o.onCancel) o.onCancel();
  };
}

// ================================================================================================
// First launch and Settings: language, units, currency, theme
// ================================================================================================

// First launch, step 1: the language wheel (its own screen, #lang, with a single Next button).
function showLangScreen() {
  $('lang').classList.remove('hide');
  // Preview: the texts change language while scrolling; nothing is saved before Next.
  const get = makeWheel(
    $('wheel-list'),
    LANGS.map(l => l[1]),
    Math.max(
      0,
      LANGS.findIndex(l => l[0] === LANG),
    ),
    true,
    i => setLang(LANGS[i][0], false),
  );
  $('lang-next').onclick = () => {
    setLang(LANGS[get()][0], true);
    $('lang').classList.add('hide');
    onboardUnits();
  };
}
// First launch, steps 2 to 4: units, currency, then theme, with Back / Next.
// Until the user has chosen, the proposal follows the language (UK miles and pound for English,
// the currency of the language's country otherwise); the theme proposed is Light.
let obUnit = null,
  obMoney = null,
  obTheme = null;
function onboardUnits() {
  const u = obUnit || (LANG === 'en' ? 'uk' : 'km');
  picker({
    icon: 'ruler',
    title: 'units_pick',
    step: 'step2',
    labels: UNITS.map(x => UNIT_LABEL[x]),
    sel: UNITS.indexOf(u),
    loop: false,
    sub: i => tx('u_' + UNITS[i]),
    ok: 'next',
    cancel: 'back',
    onCancel: showLangScreen,
    onOk: i => {
      obUnit = UNITS[i];
      setUnit(obUnit, true);
      onboardMoney();
    },
  });
}
function onboardMoney() {
  const m = obMoney || MONEY_BY_LANG[LANG] || 'EUR';
  picker({
    icon: 'money',
    title: 'money_pick',
    step: 'step3',
    labels: MONEY.map(moneyLabel),
    sel: MONEY.indexOf(m),
    loop: false,
    sub: () => tx('money_note'),
    ok: 'next',
    cancel: 'back',
    onCancel: onboardUnits,
    onOk: i => {
      obMoney = MONEY[i];
      setMoney(obMoney, true);
      onboardTheme();
    },
  });
}
// First launch, step 4: the theme (Automatic / Light / Dark), Light selected at first. The app
// shows each theme while the wheel turns; Back goes back to the currency with the saved theme.
// Next saves the choice, then the app starts (and, in the web version, gives its install advice).
function onboardTheme() {
  const t = obTheme || 'light';
  applyTheme(t);
  picker({
    icon: 'theme',
    title: 'theme_pick',
    step: 'step4',
    labels: THEMES.map(x => tx('theme_' + x)),
    sel: THEMES.indexOf(t),
    loop: false,
    sub: () => tx('theme_sub'),
    ok: 'next',
    cancel: 'back',
    onPick: i => applyTheme(THEMES[i]),
    onCancel: () => {
      applyTheme(THEME);
      onboardMoney();
    },
    onOk: i => {
      obTheme = THEMES[i];
      setTheme(obTheme, true);
      render();
      installAdvice();
      // the guided tour, once the install advice is closed (in the Android app: once the backup
      // folder is chosen, see finishSetup())
      if (!setupMode) tourWhenIdle(() => tourStart('start'));
    },
  });
}
// Redraw everything after a change of units or currency.
function refreshAll() {
  applyI18n();
  render();
  renderSave();
  live();
}
// Change units / currency; store = remember the choice.
function setUnit(u, store) {
  UNIT = UNITS.includes(u) ? u : 'km';
  if (store) {
    try {
      localStorage.setItem(UK, UNIT);
    } catch (e) {}
  }
  refreshAll();
}
function setMoney(m, store) {
  MONEYC = MONEY.includes(m) ? m : 'EUR';
  if (store) {
    try {
      localStorage.setItem(MK, MONEYC);
    } catch (e) {}
  }
  refreshAll();
}
// Settings: the Units, Currency, Language and Theme fields open their wheel.
$('unitBtn').onclick = () =>
  picker({
    icon: 'ruler',
    title: 'units_pick',
    labels: UNITS.map(x => UNIT_LABEL[x]),
    sel: UNITS.indexOf(UNIT),
    loop: false,
    sub: i => tx('u_' + UNITS[i]),
    onOk: i => setUnit(UNITS[i], true),
  });
$('moneyBtn').onclick = () =>
  picker({
    icon: 'money',
    title: 'money_pick',
    labels: MONEY.map(moneyLabel),
    sel: MONEY.indexOf(MONEYC),
    loop: false,
    sub: () => tx('money_note'),
    onOk: i => setMoney(MONEY[i], true),
  });
$('langBtn').onclick = () => {
  const orig = LANG;
  picker({
    icon: 'globe',
    title: 'lang_pick',
    labels: LANGS.map(l => l[1]),
    sel: Math.max(
      0,
      LANGS.findIndex(l => l[0] === LANG),
    ),
    loop: true,
    onPick: i => setLang(LANGS[i][0], false),
    onOk: i => setLang(LANGS[i][0], true),
    onCancel: () => setLang(orig, false),
  });
};
// Theme: the wheel shows each theme while scrolling; Cancel goes back to the saved one.
$('themeBtn').onclick = () =>
  picker({
    icon: 'theme',
    title: 'set_theme',
    labels: THEMES.map(t => tx('theme_' + t)),
    sel: THEMES.indexOf(THEME),
    loop: false,
    sub: () => tx('theme_sub'),
    onPick: i => applyTheme(THEMES[i]),
    onOk: i => setTheme(THEMES[i], true),
    onCancel: () => applyTheme(THEME),
  });

// ================================================================================================
// Settings: automatic backup
// ================================================================================================

// Settings > Automatic backup card: folder, buttons, data counts, and the choice for pendingFile.
function renderSave() {
  const f = $('sv-folder');
  if (!f) return;
  $('sv-title').textContent = tx(NA ? 'set_backup' : 'set_backup_web');
  $('sv-web').classList.toggle('hide', !!NA);
  $('sv-drive').classList.toggle('hide', !NA);
  if (!NA) {
    f.innerHTML = tx('b_browser');
    $('sv-btns').classList.add('hide');
    const d = lastExport();
    $('sv-last').textContent = d ? tx('b_last', { d: fdate(d.slice(0, 10)) }) : tx('b_never');
  } else {
    $('sv-btns').classList.remove('hide');
    f.innerHTML = folder
      ? tx('b_folder', { f: esc(folder), n: esc(NA.fileName ? String(NA.fileName()) : 'konso.json') })
      : tx('b_none');
    $('sv-pick').textContent = folder ? tx('b_change') : tx('b_pick');
    $('sv-now').classList.toggle('hide', !folder);
    $('sv-reload').classList.toggle('hide', !folder);
  }
  const p = $('sv-pending');
  if (pendingFile) {
    p.classList.remove('hide');
    p.innerHTML =
      esc(
        tx('b_pending', {
          c: (pendingFile.cars && pendingFile.cars.length) || 1,
          f: pendingFile.fuel.length,
          b: pendingFile.buys.length,
        }),
      ) +
      '<div class="btns2"><button class="btn" id="pf-load">' +
      esc(tx('b_load')) +
      '</button><button class="btn danger" id="pf-over">' +
      esc(tx('b_over')) +
      '</button></div>';
    $('pf-load').onclick = () => {
      S = norm(pendingFile);
      pendingFile = null;
      cacheSave();
      render();
      renderSave();
      status(tx('st_loaded'));
      finishSetup();
    };
    $('pf-over').onclick = () => {
      pendingFile = null;
      writeOut();
      renderSave();
      finishSetup();
    };
  } else p.classList.add('hide');
  $('sv-count').textContent = tx('b_count', { c: S.cars.length, f: S.fuel.length, b: S.buys.length });
  renderInstall();
}
// Called by MainActivity once the user has picked a backup folder (name = folder name).
// If the folder already contains a konso.json and the app has data too, the user chooses which to keep
// (pendingFile, shown by renderSave()).
window.onFolderPicked = function (name) {
  const prev = folder;
  folder = String(name || '');
  pendingFile = null;
  if (folder === prev) {
    renderSave();
    return;
  }
  if (folder) {
    try {
      const d = readFileData(),
        has = S.fuel.length || S.buys.length;
      if (d && !has) {
        S = norm(d);
        cacheSave();
        status(tx('st_loaded'));
      } else if (d && has) {
        pendingFile = d;
      } else writeOut();
    } catch (e) {
      status(tx('st_exist_bad'));
      pendingFile = null;
    }
  }
  render();
  renderSave();
  if (folder && !pendingFile) finishSetup();
};
$('sv-pick').onclick = () => {
  if (NA) NA.pickFolder();
};
$('sv-now').onclick = () => writeOut();
$('sv-reload').onclick = () => {
  try {
    const d = readFileData();
    if (d) {
      S = norm(d);
      cacheSave();
      render();
      status(tx('st_reloaded'));
    } else status(tx('st_nofile'));
  } catch (e) {
    status(tx('st_unreadable'));
  }
};
// Manual copy / import of the data as JSON (also works in a plain browser).
$('sv-copy').onclick = async () => {
  const t = payload();
  $('sv-text').value = t;
  try {
    await navigator.clipboard.writeText(t);
    status(tx('st_copied'));
  } catch (e) {
    $('sv-text').select();
    status(tx('st_selcopy'));
  }
};
$('sv-import').onclick = () => {
  try {
    const d = JSON.parse($('sv-text').value);
    if (!validData(d)) {
      status(tx('st_json_bad'));
      return;
    }
    S = norm(d);
    persist();
    render();
    renderSave();
    status(tx('st_import_ok'));
  } catch (e) {
    status(tx('st_json_bad'));
  }
};

// ================================================================================================
// Settings: what's new
// ================================================================================================
// The changes of the latest versions, in a few simple words each, in Settings: the latest version
// first, the earlier ones folded under it. Each version has its release date (d, YYYY-MM-DD; null
// until it is released) and its changes: a kind (new feature, improvement, fix) and a text
// (news_<version>_<n> in i18n.js). Before each release, add its version at the top of NEWS with
// its texts in the 10 languages, and its date.
const NEWS = [
  { v: '2.18', d: null, items: [['new', 'news_218_1'], ['new', 'news_218_2'], ['better', 'news_218_3']] },
  { v: '2.17', d: '2026-11-19', items: [['better', 'news_217_1']] },
  { v: '2.16', d: '2026-11-19', items: [['fix', 'news_216_1'], ['fix', 'news_216_2']] },
  { v: '2.15', d: '2026-11-18', items: [['new', 'news_215_1'], ['better', 'news_215_2']] },
  { v: '2.14', d: '2026-11-18', items: [['fix', 'news_214_1']] },
  { v: '2.13', d: '2026-11-18', items: [['fix', 'news_213_1'], ['new', 'news_213_2']] },
  { v: '2.12', d: '2026-11-18', items: [['fix', 'news_212_1']] },
  { v: '2.11', d: '2026-11-18', items: [['better', 'news_211_1']] },
  { v: '2.10', d: '2026-11-18', items: [['better', 'news_210_1']] },
];
// A release date written out in the app's language, e.g. "19 novembre 2026" or "19 November 2026".
const newsDate = d => new Date(d + 'T12:00').toLocaleDateString(LOC, { day: 'numeric', month: 'long', year: 'numeric' });
// One version: its number and date, then one line per change with a coloured label (New,
// Improved, Fixed).
function newsVersion(n) {
  const item = ([kind, key]) =>
    '<div class="news-item">' +
    `<span class="news-tag news-${kind}">${esc(tx('news_' + kind))}</span><span>${esc(tx(key))}</span>` +
    '</div>';
  const items = n.items.map(item).join('');
  const date = n.d ? `<span class="news-d">${esc(newsDate(n.d))}</span>` : '';
  return `<div class="news-ver"><div class="news-v">${esc(tx('news_ver', { v: n.v }))}${date}</div>${items}</div>`;
}
// Fill the What's new card (Settings): the latest version, then the earlier ones. Called by
// render(), so it follows the language.
function renderNews() {
  $('newsNow').innerHTML = newsVersion(NEWS[0]);
  $('newsOld').innerHTML = NEWS.slice(1).map(newsVersion).join('');
}

// ================================================================================================
// Web version (installable PWA, in a browser on any phone, tablet or computer)
// There is no backup folder: the data lives in the browser (localStorage), and the user saves a backup
// file and opens it again, on the same device or another one. The published site also has an offline
// cache (sw.js) and can be installed: Settings shows how, or an "Install" button where the browser
// offers one. None of this runs in the Android app (NA is set there).
// ================================================================================================

// localStorage key of the date of the last backup file saved.
const EK = KP + 'export';
function lastExport() {
  try {
    return localStorage.getItem(EK) || '';
  } catch (e) {
    return '';
  }
}
// Ask the browser not to clear the data when space runs low (granted to installed apps).
function keepStorage() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {}
}
// "Save a backup file": konso-<date>.json. On phones and tablets the share sheet is used when it accepts
// the file (on iPhone it offers "Save to Files"); otherwise, and on computers, a normal download.
async function exportFile() {
  const name = KP + today() + '.json',
    blob = new Blob([payload()], { type: 'application/json' });
  let shared = false;
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare) {
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        shared = true;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return; // share sheet closed: nothing saved
    }
  }
  if (!shared) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  try {
    localStorage.setItem(EK, today());
  } catch (e) {}
  keepStorage();
  renderSave();
  status(tx('st_exported'));
}
$('sv-export').onclick = () => exportFile();
// "Open a backup file": the data of the file replaces the app's, after a confirmation if the app has data.
$('sv-open').onclick = () => $('sv-file').click();
$('sv-file').onchange = async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  let d = null;
  try {
    d = JSON.parse(await f.text());
  } catch (x) {}
  if (!validData(d)) {
    status(tx('st_unreadable'));
    return;
  }
  const apply = () => {
    S = norm(d);
    cacheSave();
    render();
    renderSave();
    status(tx('st_import_ok'));
  };
  if (!S.fuel.length && !S.buys.length) return apply();
  const n = { c: (d.cars && d.cars.length) || 1, f: d.fuel.length, b: d.buys.length };
  dialog(
    tx('imp_title'),
    '<p>' + esc(tx('imp_msg', n)) + '</p>',
    [
      { t: tx('cancel'), tonal: true },
      { t: tx('imp_yes'), fn: apply },
    ],
    'file',
  );
};

// Install: installEvt is the browser's install prompt, kept for the "Install Konso" button (Chrome, Edge,
// Samsung Internet). Safari and Firefox have none: the card explains where the browser's command is.
let installEvt = null,
  installed = false;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (/Mac/.test(navigator.platform) && navigator.maxTouchPoints > 1);
// Safari on a Mac installs from its File menu ("Add to Dock"); other Mac browsers do not say "Safari".
const isMacSafari = () =>
  !isIOS() && /Macintosh/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg|Firefox|OPR/.test(navigator.userAgent);
// The two steps that install the app in this browser, when it offers no install button:
// iPhone / iPad (Safari's Share button), Safari on a Mac (File menu), any other browser (its menu).
function installSteps() {
  const k = isIOS() ? 'ios' : isMacSafari() ? 'mac' : 'oth';
  return [tx('adv_' + k + '1'), tx('adv_' + k + '2')];
}
// The blue "How to do it?" box with the numbered steps, in the style of the live results of the
// fill-up form (advice dialog and Settings card). On iPhone the Share icon is drawn after step 1.
function howtoHtml() {
  const share = isIOS() ? ' ' + iconSvg('share') : '';
  const steps = installSteps()
    .map((s, i) => `<li><span class="n">${i + 1}</span><span>${esc(s)}${i === 0 ? share : ''}</span></li>`)
    .join('');
  return `<div class="howto"><b>${esc(tx('adv_how'))}</b><ol>${steps}</ol></div>`;
}
// Settings > Install the app card: why, and the button or how to do it.
// Hidden in the Android app and once Konso runs installed.
function renderInstall() {
  const card = $('inst');
  if (NA || installed || standalone()) {
    card.classList.add('hide');
    return;
  }
  card.classList.remove('hide');
  $('inst-btn').classList.toggle('hide', !installEvt);
  $('inst-how').innerHTML = esc(tx('inst_txt')) + (installEvt ? '' : howtoHtml());
}
// Show the browser's own install prompt (only once: the browser gives a new one if it is dismissed).
async function promptInstall() {
  if (!installEvt) return;
  const e = installEvt;
  installEvt = null;
  try {
    await e.prompt();
  } catch (x) {}
  renderInstall();
}
$('inst-btn').onclick = promptInstall;

// Install advice, at the first launch of the web version in a browser tab: the data of a website can
// be erased by the browser (Safari erases it after 7 days without a visit), never that of an
// installed app. Shown once (IK), at the end of the first-launch wheels, or at the next start for
// people who chose their language before this advice existed; the Settings card stays afterwards.
const IK = KP + 'install-seen';
let adviceOpen = false;
function installAdvice() {
  if (NA || installed || standalone()) return;
  // Not over the first-launch screens or another dialog: it will be shown at the next start.
  if (!['lang', 'picker', 'dlg'].every(id => $(id).classList.contains('hide'))) return;
  try {
    if (localStorage.getItem(IK)) return;
    localStorage.setItem(IK, today());
  } catch (e) {
    return;
  }
  showAdvice();
}
// What the advice dialog says, written for people who know nothing about apps or code: why to
// install (one line), then three reassuring points (data stays on the device, nothing commercial,
// open code), each with an icon.
function adviceHtml() {
  const points = [
    ['lock', 'adv_p1'],
    ['block', 'adv_p2'],
    ['code', 'adv_p3'],
  ]
    .map(([i, k]) => `<li>${iconSvg(i)}<span>${esc(tx(k))}</span></li>`)
    .join('');
  return `<p class="lead">${esc(tx('adv_lead'))}</p><ul class="pts">${points}</ul>`;
}
// The advice dialog: with an Install button when the browser offers one, otherwise the blue box
// with the steps. Redrawn if the browser's offer arrives while it is open.
function showAdvice() {
  adviceOpen = true;
  const done = () => (adviceOpen = false);
  if (installEvt) {
    dialog(
      tx('inst_adv_title'),
      adviceHtml(),
      [
        { t: tx('inst_later'), tonal: true, fn: done },
        { t: tx('inst_btn'), fn: () => (done(), promptInstall()) },
      ],
      'install',
    );
  } else {
    dialog(tx('inst_adv_title'), adviceHtml() + howtoHtml(), [{ t: tx('adv_ok'), fn: done }], 'install');
  }
}
// Web version only: install prompt, offline cache (sw.js exists only on the published site, the
// registration simply fails elsewhere), and a message when an update has been downloaded.
function initWeb() {
  if (NA) return;
  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installEvt = e;
    renderInstall();
    if (adviceOpen) showAdvice();
  });
  addEventListener('appinstalled', () => {
    installEvt = null;
    installed = true;
    renderInstall();
    keepStorage();
  });
  if ('serviceWorker' in navigator && isSecureContext) {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (had) status(tx('st_update'));
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (standalone()) keepStorage();
  installAdvice();
}

// ================================================================================================
// Receipt scanning (OCR on the phone, offline)
// The photo never leaves the phone: Tesseract.js runs in the WebView with files bundled in the app.
// parse.js then extracts station, date, litres, price per litre, amount and fuel type from the text.
// ================================================================================================

// The OCR engine (Tesseract.js), created on first use and kept for the next receipts.
let ocrWorker = null;
// Engine files and the French language model are bundled in vendor/ and served by the app itself:
// no download, no network. tick receives the progress, onErr the engine errors.
async function getWorker(tick, onErr) {
  if (ocrWorker) return ocrWorker;
  const base = new URL('vendor/', location.href).href;
  ocrWorker = await Tesseract.createWorker('fra', 1, {
    workerPath: base + 'worker.min.js',
    corePath: base + 'tesseract-core-simd-lstm.wasm.js',
    langPath: base + 'lang',
    gzip: true,
    workerBlobURL: false,
    cacheMethod: 'none',
    logger: tick,
    errorHandler: onErr,
  });
  return ocrWorker;
}
// Throw the engine away after a failure; the next receipt starts a new one.
async function resetWorker() {
  const w = ocrWorker;
  ocrWorker = null;
  if (w) {
    try {
      await w.terminate();
    } catch (e) {}
  }
}
// Prepare the receipt photo for OCR: resize (longest side up to 2,200 px), grey levels, then stretch
// the contrast so that the darkest 2 % become black and the lightest 2 % white. Returns a PNG blob.
async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const maxSide = 2200,
    k = Math.min(1.5, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k),
    h = Math.round(bmp.height * k);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, w, h);
  const im = x.getImageData(0, 0, w, h),
    d = im.data,
    hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]++;
  }
  const tot = w * h;
  let a = 0,
    lo = 0,
    hi = 255;
  for (let v = 0; v < 256; v++) {
    a += hist[v];
    if (a >= tot * 0.02) {
      lo = v;
      break;
    }
  }
  a = 0;
  for (let v = 255; v >= 0; v--) {
    a += hist[v];
    if (a >= tot * 0.02) {
      hi = v;
      break;
    }
  }
  const sc = hi > lo + 10 ? 255 / (hi - lo) : 1;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, (d[i] - lo) * sc));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  x.putImageData(im, 0, 0);
  return await new Promise(r => c.toBlob(r, 'image/png'));
}
// "Scan a receipt" button. For each photo: prepare it, run OCR twice with two page layouts
// (6 = single block, 4 = single column), keep the reading whose parsed values are the most complete,
// fill the form and show what was read. Gives up if the engine does not progress for 60 s.
function initScan() {
  if (typeof Tesseract === 'undefined' || typeof TicketParse === 'undefined') return;
  $('scan').classList.remove('hide');
  const box = $('scanres');
  let busy = false;
  $('sc1').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || busy) return;
    busy = true;
    const t0 = Date.now(),
      log = [];
    let last = Date.now(),
      stage = tx('ocr_stage_prep'),
      lastKey = '';
    const L = m => log.push(((Date.now() - t0) / 1000).toFixed(1) + ' s · ' + m);
    const tick = m => {
      last = Date.now();
      if (m && m.status) {
        if (m.status !== lastKey) {
          lastKey = m.status;
          L(m.status);
        }
        stage = m.status + (typeof m.progress === 'number' ? ' ' + Math.round(m.progress * 100) + ' %' : '');
        box.textContent = tx('ocr_reading') + ' ' + stage;
      }
    };
    box.className = 'scanres';
    box.textContent = tx('ocr_prep');
    let timer;
    const stalled = new Promise((_, rej) => {
      timer = setInterval(() => {
        if (Date.now() - last > 60000) rej(new Error(tx('ocr_stall', { s: stage })));
      }, 2000);
    });
    const work = async () => {
      const blob = await prepImage(file);
      L('image ' + Math.round(blob.size / 1024) + ' KB');
      last = Date.now();
      const w = await getWorker(tick, err => {
        L('engine error: ' + (err && err.message ? err.message : err));
      });
      L('engine ready');
      last = Date.now();
      let best = null,
        bestScore = -1,
        bestText = '';
      for (const mode of ['6', '4']) {
        await w.setParameters({ tessedit_pageseg_mode: mode, user_defined_dpi: '300' });
        const r = await w.recognize(blob);
        last = Date.now();
        const p = TicketParse.parseTicket(r.data.text);
        const sc =
          (p.litres && p.prix && p.montant && !p.notes.length ? 10 : 0) +
          ['station', 'date', 'litres', 'prix', 'montant', 'carburant'].filter(k => p[k]).length;
        L('mode ' + mode + ' : score ' + sc);
        if (sc > bestScore) {
          bestScore = sc;
          best = p;
          bestText = r.data.text;
        }
        if (sc >= 10) break;
      }
      return { best, bestText };
    };
    try {
      const { best: r, bestText } = await Promise.race([work(), stalled]);
      if (r.date) $('fd').value = r.date;
      if (r.litres) $('fl').value = Math.round(vol(r.litres) * 100) / 100; // receipts are in litres
      if (r.montant) $('fe').value = r.montant;
      if (r.station) $('fs').value = r.station.slice(0, 80);
      const fuelOk = !!r.carburant && FUELV.includes(r.carburant);
      tried = false;
      if (fuelOk) {
        setFormFuel(r.carburant);
        setFuelPending(false);
      } else setFuelPending(true);
      live();
      const warns = r.notes.map(c => tx('note_' + c));
      if (!fuelOk) warns.unshift(tx('ocr_fuel_miss'));
      const miss = [];
      if (!r.litres) miss.push(tx('ocr_l'));
      if (!r.montant) miss.push(tx('ocr_m'));
      if (miss.length) warns.push(tx('ocr_notread', { x: miss.join(', ') }));
      if (!r.station) warns.push(tx('ocr_station_miss'));
      box.className = 'scanres' + (warns.length ? ' warn' : '');
      box.innerHTML =
        '<b>' +
        esc(tx('ocr_title')) +
        '</b><br>' +
        esc(r.station || tx('ocr_station_q')) +
        ' · ' +
        (r.date ? fdate(r.date) : esc(tx('ocr_date_q'))) +
        '<br>' +
        (r.litres ? fmt(r.litres) + ' L' : '? L') +
        ' · ' +
        (r.prix ? fmt(r.prix, 3) + ' €/L' : '? €/L') +
        ' · ' +
        (r.montant ? money(r.montant) : '? €') +
        ' · ' +
        (fuelOk ? esc(fuelLabel(r.carburant)) : '? ' + esc(tx('fuel'))) +
        warns.map(w => '<div class="w">' + esc(w) + '</div>').join('') +
        '<div class="note">' +
        esc(tx('ocr_verify')) +
        '</div><details><summary class="note">' +
        esc(tx('ocr_text')) +
        '</summary><pre class="ocrtext">' +
        esc(bestText) +
        '</pre></details>';
      $('fk').focus();
    } catch (err) {
      await resetWorker();
      box.className = 'scanres warn';
      box.innerHTML =
        esc(tx('ocr_fail', { e: err && err.message ? err.message : String(err) })) +
        '<details><summary class="note">' +
        esc(tx('ocr_tech')) +
        '</summary><pre class="ocrtext">' +
        esc(log.join('\n')) +
        '</pre></details>';
    } finally {
      clearInterval(timer);
      busy = false;
    }
  });
}

// ================================================================================================
// Fill-up form
// ================================================================================================

// Live results under the fill-up form: consumption, cost per 100 km / mi, price per litre / gallon.
// The band stays hidden while none of the three can be calculated, so the empty form is shorter.
function live() {
  const k = +$('fk').value,
    l = +$('fl').value,
    e = +$('fe').value;
  $('l1').textContent = k > 0 && l > 0 ? fmtCons(cons(distIn(k), volIn(l))) : '–';
  $('l2').textContent = k > 0 && e > 0 ? fmt((e / k) * 100) : '–';
  $('l3').textContent = l > 0 && e > 0 ? fmt(e / l, 3) : '–';
  const any = (k > 0 && l > 0) || (k > 0 && e > 0) || (l > 0 && e > 0);
  $('live').classList.toggle('hide', !any);
}
// The two tips of the fill-up card (receipt scan, "fill the tank to the brim") are only shown
// while the selected car has no fill-up: afterwards they are in Settings > How it works.
function showTips() {
  const first = !FU().length;
  $('scanHint').classList.toggle('hide', !first);
  $('fillTip').classList.toggle('hide', !first);
}
// Fuel field of the fill-up form: a field button that opens the wheel. The value ('' = to choose)
// is kept in the button's value attribute, so the code reads $('fc').value like a form field.
function setFormFuel(v) {
  $('fc').value = v;
  $('fc').textContent = v ? fuelLabel(v) : tx('fuel_choose');
}
$('fc').onclick = () =>
  picker({
    icon: 'pump',
    title: 'fuel',
    labels: FUELV.map(fuelLabel),
    sel: Math.max(0, FUELV.indexOf($('fc').value || defaultFuel())),
    loop: false,
    onOk: i => {
      setFormFuel(FUELV[i]);
      setFuelPending(false);
    },
  });
['fk', 'fl', 'fe'].forEach(i => $(i).addEventListener('input', live));
// Preselected fuel: the one of the car's last fill-up, otherwise its usual fuel.
// After a receipt whose fuel type could not be read, nothing is preselected: the user must choose
// (fuelPending = true, the field shows "Choose…").
let fuelPending = false;
function setFuelPending(on) {
  fuelPending = on;
  if (on) setFormFuel('');
  marks();
}
// Colours of the fill-up form fields: green ("todo") = to fill in (distance, litres and amount while
// empty; the fuel after an unreadable receipt), red ("need") = missing after a save attempt
// (tried = true). Never red from the start.
let tried = false;
function marks() {
  const set = (id, ok, todo) => {
    const f = $(id).closest('.f');
    f.classList.toggle('need', !ok && tried);
    f.classList.toggle('todo', !ok && !tried && todo);
  };
  set('fk', +$('fk').value > 0, true);
  set('fl', +$('fl').value > 0, true);
  set('fe', +$('fe').value > 0, true);
  set('fc', FUELV.includes($('fc').value), true);
}
['fk', 'fl', 'fe'].forEach(i => $(i).addEventListener('input', marks));
// Fuel of the last fill-up of the selected car, else its usual fuel.
function defaultFuel() {
  const last = FU().find(f => FUELV.includes(f.c)),
    c = curCar();
  return last ? last.c : c && FUELV.includes(c.fuel) ? c.fuel : 'SP95-E10';
}
// Preselect the fuel of the selected car (unless the user must choose it after a receipt scan).
function applyCarDefaults() {
  if (!fuelPending) setFormFuel(defaultFuel());
}
// Save a fill-up. Values are typed in the chosen units and stored in km / litres.
$('addF').onclick = () => {
  const k = +$('fk').value,
    l = +$('fl').value,
    e = +$('fe').value;
  if (!(k > 0 && l > 0 && e > 0 && FUELV.includes($('fc').value))) {
    tried = true;
    marks();
    status(tx(k > 0 && l > 0 && e > 0 ? 'need_fuel' : 'need_fill'));
    return;
  }
  S.fuel.unshift({
    id: Date.now(),
    car: S.cur,
    d: $('fd').value || today(),
    k: round3(distIn(k)),
    l: round3(volIn(l)),
    e,
    c: $('fc').value,
    s: $('fs').value.trim(),
  });
  S.fuel.sort((a, b) => b.d.localeCompare(a.d) || b.id - a.id);
  ['fk', 'fl', 'fe', 'fs'].forEach(i => ($(i).value = ''));
  tried = false;
  setFuelPending(false);
  live();
  persist();
  render();
  applyCarDefaults();
};

// ================================================================================================
// Purchase form
// ================================================================================================

// Purchase category: a field button that opens the wheel. The chosen value is kept in the
// button's value attribute, so the save code reads $('bc').value like a form field.
function setCat(v) {
  $('bc').value = v;
  $('bc').textContent = catLabel(v);
}
$('bc').onclick = () =>
  picker({
    icon: 'wrench',
    title: 'category',
    labels: CATSHOW.map(catLabel),
    sel: Math.max(0, CATSHOW.indexOf($('bc').value)),
    loop: false,
    onOk: i => setCat(CATSHOW[i]),
  });
$('be').addEventListener('input', () => {
  if (+$('be').value > 0) $('be').closest('.f').classList.remove('todo', 'need');
});
// Save a purchase (the odometer is typed in the chosen unit, stored in km).
$('addB').onclick = () => {
  const e = +$('be').value;
  if (!(e > 0)) {
    $('be').closest('.f').classList.remove('todo');
    $('be').closest('.f').classList.add('need');
    status(tx('need_amount'));
    return;
  }
  $('be').closest('.f').classList.remove('todo', 'need');
  S.buys.unshift({
    id: Date.now(),
    car: S.cur,
    d: $('bd').value || today(),
    e,
    c: $('bc').value,
    n: $('bn').value.trim(),
    k: Math.round(distIn(+$('bk').value || 0)),
    s: $('bs').value.trim(),
  });
  S.buys.sort((a, b) => b.d.localeCompare(a.d) || b.id - a.id);
  ['be', 'bn', 'bk', 'bs'].forEach(i => ($(i).value = ''));
  persist();
  render();
};

// ================================================================================================
// Histories and Stats tab
// ================================================================================================

// Delete a fill-up, a purchase or a followed station (kind = fuel, buys or stations) with two taps
// (confirm() dialogs are blocked in the WebView):
// the first tap turns the bin into "Confirm?" for 3 seconds, the second deletes.
let armed = null;
function delClick(kind, id, btn) {
  const key = kind + id;
  if (armed !== key) {
    armed = key;
    btn.classList.add('armed');
    btn.textContent = tx('del_confirm');
    setTimeout(() => {
      if (armed === key) {
        armed = null;
        render();
      }
    }, 3000);
    return;
  }
  S[kind] = S[kind].filter(x => x.id !== id);
  armed = null;
  persist();
  render();
}
// Bin icon of the delete buttons.
const TRASH =
  '<svg class="i" viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
// Redraw every screen from S. Called after every change.
function render() {
  renderCars();
  renderLists();
  showTips();
  renderStats();
  lineChart();
  barChart();
  svcUI();
  renderPlan();
  renderStations();
  renderNews();
}

// Bin button of a history line.
const deleteButton = (kind, id) =>
  `<button class="del" data-k="${kind}" data-i="${esc(id)}" aria-label="${esc(tx('del'))}">${TRASH}</button>`;

// One line of the fill-up history. Left: date and distance, then volume, price per litre, fuel
// and station. Right: consumption (unit in small type), cost per 100 km (highlighted), amount.
function fuelRow(f) {
  // each detail stays on one line (no break inside "SP95-E10"); a long station name may wrap
  const nw = t => `<span class="nw">${t}</span>`;
  const parts = [
    nw(`${fmt(vol(f.l))} ${VU()}`),
    nw(`${money(f.e / vol(f.l), 3)}/${VU()}`),
    nw(esc(fuelLabel(f.c))),
  ];
  if (f.s) parts.push(esc(f.s));
  const details = parts.join(' · ');
  return (
    '<div class="row">' +
    `<div class="l"><div class="t">${fdateS(f.d)} · ${fmt(dist(f.k), 0)} ${DU()}</div><div class="m">${details}</div></div>` +
    `<div class="r"><div class="t">${fmtCons(cons(f.k, f.l))} <span class="u">${CU()}</span></div>` +
    `<div class="hl">${money((f.e / dist(f.k)) * 100)}/100 ${DU()}</div>` +
    `<div class="m">${money(f.e)}</div></div>` +
    deleteButton('fuel', f.id) +
    '</div>'
  );
}

// One line of the purchase history: description (or category), date, category, odometer, shop; amount.
function buyRow(b) {
  const details =
    `${fdate(b.d)} · ${esc(catLabel(b.c))}` +
    (b.k ? ' · ' + fmt(dist(b.k), 0) + ' ' + DU() : '') +
    (b.s ? ' · ' + esc(b.s) : '');
  return (
    '<div class="row">' +
    `<div class="l"><div class="t">${esc(b.n) || esc(catLabel(b.c))}</div><div class="m">${details}</div></div>` +
    `<div class="r"><div class="t">${money(b.e)}</div></div>` +
    deleteButton('buys', b.id) +
    '</div>'
  );
}

// Fill-up and purchase histories of the selected car.
function renderLists() {
  $('fl-list').innerHTML = FU().length
    ? FU().map(fuelRow).join('')
    : '<div class="empty">' + esc(tx('empty_fuel')) + '</div>';
  $('bl-list').innerHTML = BU().length
    ? BU().map(buyRow).join('')
    : '<div class="empty">' + esc(tx('empty_buys')) + '</div>';
  document.querySelectorAll('.del').forEach(b => (b.onclick = () => delClick(b.dataset.k, +b.dataset.i, b)));
}

// Stats tab, except the charts: four figures, spending totals, purchases by category.
function renderStats() {
  const F = FU(),
    B = BU();
  const km = F.reduce((a, x) => a + x.k, 0), // total distance (km)
    L = F.reduce((a, x) => a + x.l, 0), // total fuel (litres)
    E = F.reduce((a, x) => a + x.e, 0); // total spent on fuel
  const st = (v, l) => `<div class="stat"><b>${v}</b><span>${esc(l)}</span></div>`;
  $('sf').innerHTML = F.length
    ? st(fmtCons(cons(km, L)) + '<small style="font-size:14px"> ' + CU() + '</small>', tx('s_avg')) +
      st(money((E / dist(km)) * 100), tx('s_cost100')) +
      st(money(E / vol(L), 3), tx('s_price')) +
      st(fmt(dist(km), 0) + ' ' + DU(), tx('s_km'))
    : '<div class="empty" style="grid-column:1/-1">' + esc(tx('s_empty')) + '</div>';
  $('sfn').textContent = '';
  const BT = B.reduce((a, x) => a + x.e, 0); // total spent on purchases
  $('sx').innerHTML =
    F.length || B.length
      ? `<div class="kv"><span>${esc(tx('fuel'))}</span><span>${money(E)}</span></div>` +
        `<div class="kv"><span>${esc(tx('buys'))}</span><span>${money(BT)}</span></div>` +
        `<div class="kv tot"><span>${esc(tx('s_total'))}</span><span>${money(E + BT)}</span></div>`
      : '<div class="empty">' + esc(tx('s_nospend')) + '</div>';
  // Purchases by category, largest first, each with a bar proportional to the largest.
  const by = {};
  B.forEach(b => (by[b.c] = (by[b.c] || 0) + b.e));
  const ent = Object.entries(by).sort((a, b) => b[1] - a[1]),
    mx = ent.length ? ent[0][1] : 1;
  $('cats').innerHTML = ent.length
    ? '<div class="note" style="margin:0 0 8px">' +
      esc(tx('s_by_cat')) +
      '</div>' +
      ent
        .map(
          ([c, v]) =>
            '<div style="margin-bottom:12px">' +
            `<div style="display:flex;justify-content:space-between;font-size:14px"><span>${esc(catLabel(c))}</span><b style="font-weight:500">${money(v)}</b></div>` +
            `<div class="bar"><i style="width:${(v / mx) * 100}%"></i></div>` +
            '</div>',
        )
        .join('')
    : '';
}

// ================================================================================================
// Charts (Stats tab)
// ================================================================================================

// Chart helpers: short month name, "DD/MM" label, and round axis values.
const monthName = i => new Date(2000, i, 1).toLocaleDateString(LOC, { month: 'short' });
const sd = s => s.slice(8, 10) + '/' + s.slice(5, 7);
function niceTicks(lo, hi, n) {
  const raw = (hi - lo) / n || 1,
    p = Math.pow(10, Math.floor(Math.log10(raw))),
    f = raw / p;
  const st = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p,
    a = Math.floor(lo / st) * st,
    t = [];
  for (let v = a; v <= hi + st * 0.999; v += st) t.push(+v.toFixed(6));
  return t;
}
// Information bubbles of the charts, with a finger:
// - short tap: the bubble stays; the next tap anywhere on the screen (bubble included) closes it and
//   opens nothing (a document listener closes it before the chart sees the tap);
// - tap held for HOLD_MS or more: the bubble follows the finger and disappears when it is lifted
//   (or when the page scrolls, which the browser reports as pointercancel).
// With a mouse: the bubble follows the pointer and disappears when it leaves the chart.
const HOLD_MS = 400;
let tipOpen = null,
  tipSwallow = null; // hide() of the bubble left open; pointer that just closed it
document.addEventListener(
  'pointerdown',
  e => {
    if (tipOpen) {
      const h = tipOpen;
      tipOpen = null;
      tipSwallow = e.pointerId;
      h();
    }
  },
  true,
);
document.addEventListener('pointerup', () => {
  tipSwallow = null;
});
document.addEventListener('pointercancel', () => {
  tipSwallow = null;
});
// Connect a chart to its bubble. show(event) draws the bubble for that position, hide() removes it.
function wireTip(svg, show, hide) {
  const tip = svg.parentNode.querySelector('.tip'),
    touch = e => e.pointerType === 'touch' || e.pointerType === 'pen';
  let down = null; // finger down on this chart: {id, t}
  svg.addEventListener('pointerdown', e => {
    if (tipSwallow === e.pointerId) return;
    down = { id: e.pointerId, t: e.timeStamp };
    show(e);
  });
  svg.addEventListener('pointermove', e => {
    if (down ? down.id === e.pointerId : !touch(e) && !e.buttons) show(e);
  });
  const end = e => {
    if (!down || down.id !== e.pointerId) return;
    const held = e.type === 'pointercancel' || e.timeStamp - down.t >= HOLD_MS;
    down = null;
    if (held || tip.style.display !== 'block') hide();
    else tipOpen = hide;
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('pointerleave', e => {
    if (!touch(e) && !down && tipOpen !== hide) hide();
  });
  svg.addEventListener('contextmenu', e => e.preventDefault());
}
// Fill and place the bubble of a chart: x in chart coordinates (0..W), kept away from the edges.
// The CSS draws it 5 % of the screen height above the chart so the finger does not hide it.
function tipShow(box, html, x, W, rect) {
  const t = box.querySelector('.tip');
  t.innerHTML = html;
  t.style.display = 'block';
  const px = Math.max(60, Math.min(rect.width - 60, (x / W) * rect.width));
  t.style.left = px + 'px';
}
// The charts are drawn 600 units wide and scaled to their card. To keep their labels at 12 px on
// screen (readable on a phone, not huge on a computer), each chart box gets --chart-k = 600 / its
// width in px, used by the font size of .chart text in app.css. A ResizeObserver updates it when the
// window is resized and when a hidden tab is shown (its width goes from 0 to its real value).
function watchChartScale() {
  if (typeof ResizeObserver !== 'function') return; // the CSS falls back to a phone-sized value
  const ro = new ResizeObserver(entries =>
    entries.forEach(en => {
      const w = en.contentRect.width;
      if (w > 0) en.target.style.setProperty('--chart-k', (600 / w).toFixed(3));
    }),
  );
  ['c1', 'c2', 'c3'].forEach(id => ro.observe($(id)));
}
// Stats > Consumption per fill-up: one point per fill-up, dashed line = average, the last value
// highlighted. Drawn as SVG (600 x 220 coordinates, scaled to the width of the screen).
function lineChart() {
  const box = $('c1'),
    data = [...FU()]
      .sort((a, b) => a.d.localeCompare(b.d) || a.id - b.id)
      .map(f => ({ d: f.d, v: cons(f.k, f.l), e: (f.e / dist(f.k)) * 100, k: f.k, l: f.l }));
  if (data.length < 2) {
    box.innerHTML = '<div class="empty">' + esc(tx('s_need2')) + '</div>';
    $('c1s').textContent = '';
    return;
  }
  const avg = cons(
    data.reduce((a, x) => a + x.k, 0),
    data.reduce((a, x) => a + x.l, 0),
  );
  const W = 600,
    H = 220,
    m = { l: 52, r: 12, t: 26, b: 34 },
    iw = W - m.l - m.r,
    ih = H - m.t - m.b;
  const vs = data.map(x => x.v),
    lo = Math.min(...vs, avg),
    hi = Math.max(...vs, avg),
    // a range below 1e-6 is rounding noise (all values equal): use 1, or niceTicks() would make
    // billions of ticks
    pad = (hi - lo > 1e-6 ? hi - lo : 1) * 0.15;
  const tk = niceTicks(lo - pad, hi + pad, 4),
    y0 = tk[0],
    y1 = tk[tk.length - 1];
  const X = i => m.l + (iw * i) / (data.length - 1),
    Y = v => m.t + ih * (1 - (v - y0) / (y1 - y0));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(tx('s_chart1'))}">`;
  tk.forEach(v => {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v, v % 1 ? 1 : 0)}</text>`;
  });
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(avg)}" y2="${Y(avg)}" stroke="var(--on-surf-v)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  s += `<text x="${W - m.r}" y="${Y(avg) - 5}" text-anchor="end">${esc(tx('chart_avg'))} ${fmt(avg, 1)}</text>`;
  s += `<polyline fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${data.map((x, i) => X(i) + ',' + Y(x.v)).join(' ')}"/>`;
  data.forEach((x, i) => {
    s += `<circle cx="${X(i)}" cy="${Y(x.v)}" r="4" fill="var(--s1)" stroke="var(--surf)" stroke-width="2"/>`;
  });
  const lab = [0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  lab.forEach(i => {
    s += `<text x="${X(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}">${sd(data[i].d)}</text>`;
  });
  const lastI = data.length - 1;
  s += `<text x="${X(lastI)}" y="${Y(data[lastI].v) - 9}" text-anchor="end" style="fill:var(--on-surf);font-weight:700">${fmt(data[lastI].v, 1)}</text>`;
  s += `<line id="c1v" y1="${m.t}" y2="${m.t + ih}" stroke="var(--on-surf-v)" stroke-width="1" style="display:none"/><circle id="c1h" r="6" fill="var(--s1)" stroke="var(--surf)" stroke-width="2" style="display:none"/></svg><div class="tip"></div>`;
  box.innerHTML = s;
  const svg = box.querySelector('svg'),
    vl = svg.querySelector('#c1v'),
    hc = svg.querySelector('#c1h');
  const move = e => {
    const r = svg.getBoundingClientRect(),
      px = ((e.clientX - r.left) / r.width) * W;
    let i = Math.round(((px - m.l) / iw) * (data.length - 1));
    i = Math.max(0, Math.min(data.length - 1, i));
    const d = data[i];
    vl.setAttribute('x1', X(i));
    vl.setAttribute('x2', X(i));
    vl.style.display = '';
    hc.setAttribute('cx', X(i));
    hc.setAttribute('cy', Y(d.v));
    hc.style.display = '';
    tipShow(
      box,
      `<b>${fdate(d.d)}</b><br>${fmtCons(d.v)} ${CU()}<br>${money(d.e)} / 100 ${DU()}<br>${fmt(dist(d.k), 0)} ${DU()} · ${fmt(vol(d.l))} ${VU()}`,
      X(i),
      W,
      r,
    );
  };
  wireTip(svg, move, () => {
    vl.style.display = 'none';
    hc.style.display = 'none';
    box.querySelector('.tip').style.display = 'none';
  });
  const last = data[lastI].v,
    diff = last - avg;
  $('c1s').innerHTML = tx('last_fill', {
    v: fmtCons(last),
    d: (diff >= 0 ? '+' : '−') + fmtCons(Math.abs(diff)),
    a: fmtCons(avg),
  });
}
// Stats > Spending per month: last 6 months, fuel (blue) and purchases (orange) stacked.
function barChart() {
  const box = $('c2'),
    by = {};
  FU().forEach(f => {
    const k = f.d.slice(0, 7);
    (by[k] = by[k] || { f: 0, b: 0 }).f += f.e;
  });
  BU().forEach(b => {
    const k = b.d.slice(0, 7);
    (by[k] = by[k] || { f: 0, b: 0 }).b += b.e;
  });
  const keys = Object.keys(by).sort().slice(-6);
  if (!keys.length) {
    box.innerHTML = '<div class="empty">' + esc(tx('s_nospend')) + '</div>';
    return;
  }
  const W = 600,
    H = 230,
    m = { l: 56, r: 10, t: 30, b: 34 },
    iw = W - m.l - m.r,
    ih = H - m.t - m.b;
  const mx = Math.max(...keys.map(k => by[k].f + by[k].b)),
    tk = niceTicks(0, mx * 1.05, 4),
    y1 = tk[tk.length - 1];
  const Y = v => m.t + ih * (1 - v / y1),
    band = iw / keys.length,
    bw = Math.min(56, band * 0.6);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(tx('s_chart2'))}">`;
  tk.forEach(v => {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${m.l - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v, 0)}</text>`;
  });
  keys.forEach((k, i) => {
    const d = by[k],
      cx = m.l + band * (i + 0.5),
      x = cx - bw / 2,
      [yy, mm] = k.split('-'),
      hf = (ih * d.f) / y1,
      hb = (ih * d.b) / y1;
    if (d.f > 0)
      s += `<rect x="${x}" y="${Y(d.f)}" width="${bw}" height="${Math.max(hf, 1)}" rx="${d.b > 0 ? 0 : 4}" fill="var(--s1)"/>`;
    if (d.b > 0)
      s += `<rect x="${x}" y="${Y(d.f + d.b)}" width="${bw}" height="${Math.max(hb - (d.f > 0 ? 2 : 0), 1)}" rx="4" fill="var(--s2)"/>`;
    s += `<text x="${cx}" y="${Y(d.f + d.b) - 5}" text-anchor="middle" style="fill:var(--on-surf);font-weight:600">${fmt(d.f + d.b, 0)}</text>`;
    s += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(monthName(+mm - 1))} ${yy.slice(2)}</text>`;
    s += `<rect class="hit" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${ih}" fill="transparent"/>`;
  });
  s += `</svg><div class="tip"></div>`;
  box.innerHTML = s;
  const svg = box.querySelector('svg');
  const show = e => {
    const el = document.elementFromPoint(e.clientX, e.clientY),
      h = el && el.closest ? el.closest('.hit') : null;
    if (!h) return;
    const i = +h.dataset.i,
      d = by[keys[i]],
      r = svg.getBoundingClientRect(),
      [yy, mm] = keys[i].split('-');
    tipShow(
      box,
      `<b>${esc(monthName(+mm - 1))} ${yy}</b><br>${esc(tx('fuel'))} : ${money(d.f)}<br>${esc(tx('buys'))} : ${money(d.b)}<br>${esc(tx('s_total'))} : ${money(d.f + d.b)}`,
      m.l + band * (i + 0.5),
      W,
      r,
    );
  };
  wireTip(svg, show, () => {
    box.querySelector('.tip').style.display = 'none';
  });
}

// ================================================================================================
// Service reminder: banner and dialogs
// ================================================================================================

// Service reminder, what the user sees: when a service is due, a dialog in the middle of the screen
// (once per due date, remembered in localStorage under SK), then an amber banner at the top until a
// service is recorded.
const SK = KP + 'svc-seen',
  svcShown = new Set();
const svcKey = (c, i) => c.id + '|' + i.ref;
function svcSeen(k) {
  try {
    return (JSON.parse(localStorage.getItem(SK)) || {})[k.split('|')[0]] === k;
  } catch (e) {
    return false;
  }
}
function svcMarkSeen(k) {
  try {
    const m = JSON.parse(localStorage.getItem(SK)) || {};
    m[k.split('|')[0]] = k;
    localStorage.setItem(SK, JSON.stringify(m));
  } catch (e) {}
}
// Dialog in the middle of the screen. btns: [{t: text, tonal: lighter style, fn: action}].
// icon: a key of ICON, shown in the app's colour; without it, the amber wrench of the service reminder.
function dialog(title, html, btns, icon) {
  $('dlgP').setAttribute('d', ICON[icon] || ICON.wrench);
  $('dlgP').parentNode.style.color = icon ? 'var(--primary)' : '';
  $('dlgT').textContent = title;
  $('dlgM').innerHTML = html;
  $('dlgB').innerHTML = '';
  btns.forEach(b => {
    const e = document.createElement('button');
    e.className = 'btn' + (b.tonal ? ' tonal' : '');
    e.textContent = b.t;
    e.onclick = () => {
      $('dlg').classList.add('hide');
      if (b.fn) b.fn();
    };
    $('dlgB').appendChild(e);
  });
  $('dlg').classList.remove('hide');
}
// Why the service is due: distance or date, since the last service or since tracking started.
function svcReason(i) {
  const v = { km: '<b>' + kmTxt(i.km) + '</b>', d: '<b>' + fdate(i.ref) + '</b>' };
  return tx(
    i.overKm
      ? i.start
        ? 'svc_due_km_start'
        : 'svc_due_km'
      : i.start
        ? 'svc_due_date_start'
        : 'svc_due_date',
    v,
  );
}
// My garage > Servicing card (the car shown): interval, last service, next service.
function renderSvc(c, i) {
  let h = tx('svc_rule', { car: esc(carName(c)), km: kmTxt(svcEvery(c)) });
  if (!i) h += '<br>' + tx('svc_nodata');
  else {
    h += '<br>' + tx(i.start ? 'svc_start' : 'svc_last', { d: fdate(i.ref), km: kmTxt(i.km) });
    h +=
      '<br>' +
      (i.due ? '<b>' + tx('svc_now') + '</b>' : tx('svc_next', { km: kmTxt(i.left), d: fdate(i.next) }));
  }
  $('svcInfo').innerHTML = h;
}
// Show or hide the banner, and show the dialog the first time a service is due.
function svcUI() {
  const c = curCar(),
    i = svcInfo(c),
    due = !!(i && i.due);
  renderSvc(c, i);
  $('svcBarTxt').textContent = tx('svc_banner');
  $('svcBar').classList.toggle('hide', !due);
  if (!due) return;
  const k = svcKey(c, i);
  const busy =
    setupMode ||
    !$('dlg').classList.contains('hide') ||
    !$('lang').classList.contains('hide') ||
    !$('picker').classList.contains('hide');
  if (busy || svcShown.has(k) || svcSeen(k)) return;
  svcShown.add(k);
  dialog(
    tx('svc_due_title'),
    (S.cars.length > 1 ? '<p><b>' + esc(carName(c)) + '</b></p>' : '') +
      '<p>' +
      svcReason(i) +
      '</p><p>' +
      esc(tx('svc_due_hint')) +
      '</p>',
    [
      { t: tx('svc_not_yet'), tonal: true, fn: () => svcMarkSeen(k) },
      {
        t: tx('svc_done_yes'),
        fn: () => {
          svcMarkSeen(k);
          svcDoneToday();
        },
      },
    ],
  );
}
// "Yes, it's done" on the banner: the service is recorded on the car with today's date, tracking
// restarts from zero, and a message reminds the user to add its cost in Purchases.
function svcDoneToday() {
  const c = curCar();
  c.svcDone = today();
  persist();
  render();
  dialog(tx('svc_done_ok_title'), '<p>' + tx('svc_done_ok_msg') + '</p>', [{ t: tx('ok') }]);
}
$('svcBar').onclick = () =>
  dialog(tx('svc_done_title'), '<p>' + esc(tx('svc_done_msg')) + '</p>', [
    { t: tx('svc_not_yet'), tonal: true },
    { t: tx('svc_done_yes'), fn: svcDoneToday },
  ]);
// My garage > Servicing > Change the distance: wheel of SVC_KM in the chosen unit.
$('svcKmBtn').onclick = () => {
  const c = curCar();
  picker({
    icon: 'wrench',
    color: 'var(--amber)',
    title: 'svc_pick',
    sub: tx('svc_pick_sub', { car: carName(c) }),
    labels: SVC_KM.map(v => fmt(v, 0) + ' ' + DU()),
    sel: nearest(SVC_KM, dist(svcEvery(c))),
    loop: false,
    onOk: i => {
      c.svcKm = round3(distIn(SVC_KM[i]));
      persist();
      render();
      status(tx('svc_saved', { km: kmTxt(c.svcKm) }));
    },
  });
};

// ================================================================================================
// Cars
// ================================================================================================

// Cars: selector in the top bar, and the "My garage" tab (list of the cars, add / edit / delete form).
// carEditing: id of the car being edited (null = new car); carDelArmed: delete needs a second tap.
let carEditing = null,
  carDelArmed = false;
// Car icon of the garage list (Material "directions_car").
const CAR_SVG =
  '<svg class="i" viewBox="0 0 24 24"><path d="M18.92 6.01C18.72 5.42 18.16 5 17.5 5h-11c-.66 0-1.21.42-1.42 1.01L3 12v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-8l-2.08-5.99zM6.5 16c-.83 0-1.5-.67-1.5-1.5S5.67 13 6.5 13s1.5.67 1.5 1.5S7.33 16 6.5 16zm11 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zM5 11l1.5-4.5h11L19 11H5z"/></svg>';
// Pencil icon at the end of a garage line: tells that the line opens the edit form.
const PEN_SVG =
  '<svg class="i" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
// Number of fill-ups and purchases of car id (shown in the garage, and before deleting a car).
const carCounts = id => ({
  f: S.fuel.filter(x => x.car === id).length,
  b: S.buys.filter(x => x.car === id).length,
});
// Car selector in the top bar: the options of the (invisible) menu and the name shown in the middle.
function renderCars() {
  const sel = $('car');
  sel.innerHTML = S.cars
    .map(
      c =>
        '<option value="' +
        esc(c.id) +
        '"' +
        (c.id === S.cur ? ' selected' : '') +
        '>' +
        esc(carName(c)) +
        '</option>',
    )
    .join('');
  $('carShown').textContent = carName(curCar());
  renderGarage();
}
// One line of the garage: car icon, name (with a "Shown" chip for the car selected at the top),
// usual fuel and number of records, pencil. The whole line is a button that opens the edit form.
function garageRow(c) {
  const n = carCounts(c.id),
    shown = c.id === S.cur ? ` <span class="chip">${esc(tx('g_shown'))}</span>` : '',
    meta = [c.fuel ? fuelLabel(c.fuel) : '', tx('g_count', n)].filter(Boolean).join(' · ');
  return (
    `<button type="button" class="row carrow" data-id="${esc(c.id)}">` +
    `<span class="carico">${CAR_SVG}</span>` +
    `<span class="l"><span class="t">${esc(carName(c))}${shown}</span>` +
    `<span class="m">${esc(meta)}</span></span>` +
    PEN_SVG +
    '</button>'
  );
}
// List of the cars in the "My garage" tab; a tap on a line opens the form for that car.
function renderGarage() {
  const list = $('cars-list');
  list.innerHTML = S.cars.map(garageRow).join('');
  list.querySelectorAll('.carrow').forEach(b => (b.onclick = () => openCarForm(b.dataset.id)));
}
// Usual fuel of the car form: a field button that opens the wheel (value kept in its value
// attribute, like the purchase category).
function setCarFuel(v) {
  $('carFuel').value = v;
  $('carFuel').textContent = fuelLabel(v);
}
$('carFuel').onclick = () =>
  picker({
    icon: 'pump',
    title: 'car_fuel',
    labels: FUELV.map(fuelLabel),
    sel: Math.max(0, FUELV.indexOf($('carFuel').value)),
    loop: false,
    onOk: i => setCarFuel(FUELV[i]),
  });
// Advanced options: how often the insurance is paid, 'y' (per year) or 'm' (per month). A field
// button that opens the wheel, like the usual fuel.
const INS_PER = ['y', 'm'];
const insPerLabel = v => tx(v === 'm' ? 'per_month' : 'per_year');
function setInsPer(v) {
  $('carInsPer').value = v;
  $('carInsPer').textContent = insPerLabel(v);
}
$('carInsPer').onclick = () =>
  picker({
    icon: 'money',
    title: 'car_ins_per',
    labels: INS_PER.map(insPerLabel),
    sel: Math.max(0, INS_PER.indexOf($('carInsPer').value)),
    loop: false,
    onOk: i => setInsPer(INS_PER[i]),
  });
// Fill the advanced options of the form from car c (empty for a new car). The section is
// unfolded when the car already has one of them, folded otherwise.
function fillCarAdvanced(c) {
  const show = (v, d) => (c && v > 0 ? String(+v.toFixed(d)) : '');
  $('carPrice').value = show(c && c.price, 2);
  $('carBuyKm').value = show(c && dist(c.buyKm), 0);
  $('carIns').value = show(c && c.ins, 2);
  setInsPer((c && c.insPer) || 'y');
  $('carAdv').open = !!(c && (c.price > 0 || c.buyKm > 0 || c.ins > 0));
}
// Read the advanced options of the form into car c. Empty or invalid fields are stored as 0
// (= not given); the mileage is typed in the chosen unit and stored in km.
function readCarAdvanced(c) {
  const pos = id => {
    const v = +$(id).value;
    return v > 0 ? v : 0;
  };
  c.price = pos('carPrice');
  c.buyKm = Math.round(distIn(pos('carBuyKm')));
  c.ins = pos('carIns');
  c.insPer = $('carInsPer').value === 'm' ? 'm' : 'y';
}
// Open the car form in the garage, in place of the list: empty for a new car (id = null),
// or filled with car id (edit, with the delete button when there is more than one car).
function openCarForm(id) {
  const c = id ? S.cars.find(x => x.id === id) : null;
  carEditing = c ? c.id : null;
  carDelArmed = false;
  $('carFormTitle').textContent = c ? tx('car_edit') : tx('car_new');
  $('carName').value = c ? carName(c) : '';
  setCarFuel((c && FUELV.includes(c.fuel) && c.fuel) || 'SP95-E10');
  fillCarAdvanced(c);
  $('carDel').classList.toggle('hide', !(c && S.cars.length > 1));
  $('carDel').textContent = tx('car_del');
  $('carNote').textContent = c ? (S.cars.length > 1 ? tx('car_note_del') : tx('car_note_keep')) : '';
  $('garList').classList.add('hide');
  $('carForm').classList.remove('hide');
  window.scrollTo(0, 0);
  if (!c) $('carName').focus();
}
// Close the car form and show the list of the garage again.
function closeCarForm() {
  $('carForm').classList.add('hide');
  $('garList').classList.remove('hide');
}
// After a change of the cars: save, redraw, back to the list.
function carsChanged() {
  closeCarForm();
  persist();
  render();
  applyCarDefaults();
}
// Selecting another car in the top bar.
$('car').onchange = () => {
  S.cur = $('car').value;
  persist();
  render();
  applyCarDefaults();
};
$('carAdd').onclick = () => openCarForm(null);
$('carCancel').onclick = closeCarForm;
// Save the form: the name is required and must be unique, the advanced options are optional.
// A new car becomes the selected one.
$('carSave').onclick = () => {
  const name = $('carName').value.trim();
  if (!name) {
    status(tx('car_need_name'));
    return;
  }
  if (S.cars.some(c => c.name.toLowerCase() === name.toLowerCase() && c.id !== carEditing)) {
    status(tx('car_dup'));
    return;
  }
  let c = S.cars.find(x => x.id === carEditing);
  if (!c) {
    c = { id: 'c' + Date.now() };
    S.cars.push(c);
    S.cur = c.id;
  }
  c.name = name;
  c.fuel = $('carFuel').value;
  readCarAdvanced(c);
  carsChanged();
};
// Delete the car being edited, with its fill-ups and purchases. First tap: ask to confirm with
// the number of records; second tap: delete.
$('carDel').onclick = () => {
  const id = carEditing;
  if (!carDelArmed) {
    carDelArmed = true;
    const n = carCounts(id);
    $('carDel').textContent = tx('car_del_confirm', { n: n.f + n.b });
    return;
  }
  S.cars = S.cars.filter(c => c.id !== id);
  S.fuel = S.fuel.filter(f => f.car !== id);
  S.buys = S.buys.filter(b => b.car !== id);
  if (!S.cars.some(c => c.id === S.cur)) S.cur = S.cars[0].id;
  carsChanged();
};

// ================================================================================================
// Buying a new car (My garage)
// Compares, over the same distance per year, the yearly cost of the current car (the one selected in
// the top bar) with the one of the car the user wants to buy, and says when the change pays for
// itself. Worked out while the user types (no button); the fields are saved in S.plan.
//   current car: fuel (cost per km of its fill-ups) + insurance (advanced options)
//                + purchases of the last 12 months if the switch is on
//   new car:     distance x consumption x fuel price + insurance
//   payback:     (purchase price - resale price of the current car, typed by the user) / yearly savings
// ================================================================================================

// Number of days from date a to date b (YYYY-MM-DD). Noon avoids daylight saving surprises.
const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5);
// Date n days before today, as YYYY-MM-DD.
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
// Consumption: displayed unit <-> L/100 km. The mpg <-> L/100 km formula is its own inverse.
const consSwap = v => (UNIT === 'km' ? v : (100 * (UNIT === 'us' ? USGAL : IMPGAL)) / (v * MI));
// Fuel price: per displayed volume (litre or US gallon) <-> per litre.
const priceIn = v => (UNIT === 'us' ? v / USGAL : v),
  priceOut = v => (UNIT === 'us' ? v * USGAL : v);
// Insurance per year, from a price paid per year ('y') or per month ('m').
const insYear = (ins, per) => (ins > 0 ? ins * (per === 'm' ? 12 : 1) : 0);
// Value for a number field: '' when not given, else rounded to d decimals.
const numField = (v, d) => (v > 0 ? String(+v.toFixed(d)) : '');

// Distance driven per year by the selected car, in km, from its fill-ups: distance of the fill-ups
// after the first one, over the days between the first and the last. null if fewer than 2 fill-ups
// or less than two weeks of history.
function kmYearEstimate() {
  const F = FU();
  if (F.length < 2) return null;
  const days = dayDiff(F[F.length - 1].d, F[0].d);
  if (days < 14) return null;
  const km = F.slice(0, -1).reduce((a, f) => a + f.k, 0);
  return (km / days) * 365;
}
// Amount of the purchases of the selected car over the last 12 months.
function buysLastYear() {
  const from = daysAgo(365);
  return BU()
    .filter(b => b.d > from)
    .reduce((a, b) => a + b.e, 0);
}
// A number of months as text: "4 years and 3 months", "8 months"...
function durTxt(m) {
  if (m > 600) return tx('dur_long');
  const y = Math.floor(m / 12),
    mo = m % 12;
  return tx(y && mo ? 'dur_ym' : y ? 'dur_y' : 'dur_m', { y, m: mo });
}

// Insurance period of the new car: a field button that opens the wheel (per year / per month).
function setPlanInsPer(v) {
  $('pInsPer').value = v;
  $('pInsPer').textContent = insPerLabel(v);
}
$('pInsPer').onclick = () =>
  picker({
    icon: 'money',
    title: 'car_ins_per',
    labels: INS_PER.map(insPerLabel),
    sel: Math.max(0, INS_PER.indexOf($('pInsPer').value)),
    loop: false,
    onOk: i => {
      setPlanInsPer(INS_PER[i]);
      S.plan.insPer = INS_PER[i];
      planChanged();
    },
  });

// Fill the card from S.plan, in the units chosen by the user. Distance per year shows the suggestion
// of the app (from the fill-ups) when the user has not typed a value; the note under the field tells
// where it comes from. Called by render().
function renderPlan() {
  const P = S.plan,
    c = curCar(),
    kmEst = kmYearEstimate();
  $('pCurT').textContent = tx('pl_cur', { car: carName(c) });
  $('pPrice').value = numField(P.price, 2);
  $('pIns').value = numField(P.ins, 2);
  setPlanInsPer(P.insPer);
  $('pCons').value = P.cons > 0 ? numField(consSwap(P.cons), UNIT === 'km' ? 2 : 1) : '';
  $('pFuel').value = numField(priceOut(P.fuel), 3);
  const km = P.km !== null ? P.km : kmEst;
  $('pKm').value = km !== null ? String(Math.round(dist(km))) : '';
  $('pKmN').textContent =
    kmEst !== null ? tx('pl_km_est', { v: fmt(dist(kmEst), 0) + ' ' + DU() }) : tx('pl_km_none');
  $('pResale').value = numField(P.resale, 2);
  $('pWith').checked = P.withBuys;
  $('pWithN').textContent = tx('pl_with_note', { v: money(buysLastYear(), 0) });
  planResult();
}

// The result under the fields: what is missing, or the yearly costs, the savings, the cost of the
// change and when it pays for itself.
function planResult() {
  const P = S.plan,
    c = curCar(),
    F = FU(),
    box = $('pRes');
  const say = t => (box.innerHTML = '<div>' + esc(t) + '</div>');
  if (!F.length) return say(tx('pl_need_fills', { car: carName(c) }));
  const km = P.km !== null ? P.km : kmYearEstimate();
  if (!(km > 0)) return say(tx('pl_need_km'));
  if (!(P.price > 0 && P.cons > 0 && P.fuel > 0)) return say(tx('pl_need_new'));
  const perKm = F.reduce((a, f) => a + f.e, 0) / F.reduce((a, f) => a + f.k, 0);
  const curY = km * perKm + insYear(c.ins, c.insPer) + (P.withBuys ? buysLastYear() : 0),
    newY = ((km * P.cons) / 100) * P.fuel + insYear(P.ins, P.insPer),
    save = curY - newY;
  const cost = P.price - P.resale;
  const row = (k, v) => `<div class="kv"><span>${esc(tx(k))}</span><span>${money(v, 0)}</span></div>`;
  let big;
  if (save <= 0) big = tx('pl_never', { v: money(-save, 0) });
  else if (cost <= 0) big = tx('pl_now');
  else {
    const months = Math.ceil((cost / save) * 12);
    big = tx('pl_ok', { t: durTxt(months), d: fmt(dist((km * months) / 12), 0) + ' ' + DU() });
  }
  box.innerHTML =
    row('pl_cost_cur', curY) +
    row('pl_cost_new', newY) +
    row('pl_save', save) +
    row('pl_save_m', save / 12) +
    row('pl_change', cost) +
    `<div class="big">${esc(big)}</div>`;
}

// After a change of a field: save without message, and update the result only (the fields are
// left alone while the user types).
function planChanged() {
  persistQuiet();
  planResult();
}
// Each field writes its value into S.plan, converted to km, L/100 km and price per litre.
// Distance per year: an empty field goes back to the suggestion (null).
function planInputs() {
  const pos = id => {
      const v = +$(id).value;
      return v > 0 ? v : 0;
    },
    opt = id => ($(id).value === '' || !(+$(id).value >= 0) ? null : +$(id).value);
  const fields = {
    pPrice: () => (S.plan.price = pos('pPrice')),
    pIns: () => (S.plan.ins = pos('pIns')),
    pCons: () => (S.plan.cons = pos('pCons') ? consSwap(pos('pCons')) : 0),
    pFuel: () => (S.plan.fuel = priceIn(pos('pFuel'))),
    pKm: () => (S.plan.km = opt('pKm') === null ? null : distIn(opt('pKm'))),
    pResale: () => (S.plan.resale = pos('pResale')),
  };
  for (const id in fields)
    $(id).addEventListener('input', () => {
      fields[id]();
      planChanged();
    });
  $('pWith').onchange = () => {
    S.plan.withBuys = $('pWith').checked;
    planChanged();
  };
}
planInputs();
// Reset: empties the fields of the car the user wants to buy (the current car's values stay).
$('pReset').onclick = () => {
  Object.assign(S.plan, { price: 0, ins: 0, insPer: 'y', cons: 0, fuel: 0 });
  persistQuiet();
  renderPlan();
};

// ================================================================================================
// Stations (official fuel prices, France)
// Konso does not use the internet, except here and only while the user has turned the switch on:
// the app then reads the official French feed "Prix des carburants en France - Flux instantané v2"
// (data.economie.gouv.fr, updated every 10 minutes, one record per station). In the Android app,
// MainActivity lets the page reach that host only while the switch is on (Android.setOnline()).
// The feed only gives the current prices: every new price is kept in S.stations, so the chart
// builds up over time. The chart also shows the price per litre of the user's own fill-ups.
// ================================================================================================

// Records of the official feed, and the fields read from it.
const PRICES_API =
  'https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/prix-des-carburants-en-france-flux-instantane-v2/records';
// Konso fuel types -> name of the fuel in the feed (fields <name>_prix and <name>_maj).
const FEED_FUEL = { 'SP95-E10': 'e10', SP95: 'sp95', SP98: 'sp98', E85: 'e85', GPL: 'gplc', Gazole: 'gazole' };
const FEED_FIELDS =
  'id,adresse,ville,cp,geom,' +
  Object.values(FEED_FUEL)
    .map(f => f + '_prix,' + f + '_maj')
    .join(',');
// The switch "Allow the connection for stations": a preference of the device (localStorage).
const OK_KEY = KP + 'online';
let ONLINE = false;
// Time of the last refresh of the followed stations (ms, this session), and the search results.
let stChecked = 0,
  stFound = [];
const ST_EVERY = 30 * 60e3; // automatic refresh at most every 30 minutes
const ST_KEEP = 400; // prices kept per station and fuel
// Fuel (feed name) of the prices shown by the Stations tab: when it changes (another car, or a
// fill-up with another fuel), the followed stations' prices are refreshed at once.
let stKey = '';

// Turn the connection on or off (and tell the Android side, which enforces it).
function setOnline(on) {
  ONLINE = !!on;
  try {
    localStorage.setItem(OK_KEY, ONLINE ? '1' : '0');
  } catch (e) {}
  if (NA && typeof NA.setOnline === 'function') NA.setOnline(ONLINE);
  renderStations();
  if (ONLINE) refreshStations(true);
}
$('stOnline').onchange = () => setOnline($('stOnline').checked);

// Ask the feed for the stations matching an ODSQL condition (where), at most limit records,
// optionally sorted (orderBy, e.g. "e10_prix"). Returns the feed's answer: { total_count, results }.
async function feedJson(where, limit, orderBy) {
  const q = new URLSearchParams({ where, limit: String(limit), select: FEED_FIELDS });
  if (orderBy) q.set('order_by', orderBy);
  const r = await fetch(PRICES_API + '?' + q, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// The records only, for the followed stations and the postcode search.
async function feed(where, limit) {
  return (await feedJson(where, limit)).results || [];
}
// Keep the new prices of a feed record in station st: for each fuel, a price is added when its
// date of change differs from the last one kept. The feed's dates are French local time although
// they end in +00:00, so only "YYYY-MM-DDTHH:MM" is kept and shown as is.
function keepPrices(st, rec) {
  st.adr = String(rec.adresse || st.adr || '').slice(0, 120);
  st.ville = String(rec.ville || st.ville || '').slice(0, 80);
  st.cp = String(rec.cp || st.cp || '').slice(0, 5);
  const g = rec.geom;
  if (g && typeof g.lat === 'number' && typeof g.lon === 'number') {
    st.lat = g.lat;
    st.lon = g.lon;
  }
  for (const f of Object.values(FEED_FUEL)) {
    const p = +rec[f + '_prix'],
      d = String(rec[f + '_maj'] || '').slice(0, 16);
    if (!(p > 0) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(d)) continue;
    const h = (st.h[f] = st.h[f] || []),
      last = h[h.length - 1];
    if (last && last[0] >= d) continue;
    h.push([d, p]);
    if (h.length > ST_KEEP) h.splice(0, h.length - ST_KEEP);
  }
}
// Update the prices of the followed stations (one request for up to 100 stations). Automatic when
// the tab opens (at most every ST_EVERY), or forced by the Refresh button. Errors: a message.
async function refreshStations(force) {
  if (!ONLINE || !S.stations.length) return;
  if (!force && Date.now() - stChecked < ST_EVERY) return;
  stChecked = Date.now();
  $('stUpd').textContent = tx('st_busy');
  try {
    for (let i = 0; i < S.stations.length; i += 100) {
      const ids = S.stations.slice(i, i + 100).map(s => s.id);
      const recs = await feed('id in (' + ids.join(',') + ')', 100);
      recs.forEach(r => {
        const st = S.stations.find(s => s.id === +r.id);
        if (st) keepPrices(st, r);
      });
    }
    persistQuiet();
  } catch (e) {
    stChecked = 0;
    status(tx('st_err'));
  }
  renderStations();
}
$('stRefresh').onclick = () => refreshStations(true);

// Search the stations of a postcode (5 digits) and list them with a + button to follow them.
async function searchStations() {
  const cp = $('stCp').value.trim();
  if (!/^\d{5}$/.test(cp)) return status(tx('st_need_cp'));
  $('stRes').innerHTML = '<div class="note">' + esc(tx('st_busy')) + '</div>';
  try {
    stFound = await feed('cp="' + cp + '"', 100);
  } catch (e) {
    stFound = [];
    $('stRes').innerHTML = '';
    return status(tx('st_err'));
  }
  renderFound();
}
$('stSearch').onclick = searchStations;
$('stCp').addEventListener('keydown', e => {
  if (e.key === 'Enter') searchStations();
});
// The search results: address, postcode and town, price of the car's fuel, + (or "Followed").
function renderFound() {
  const key = FEED_FUEL[defaultFuel()];
  const rows = stFound.map(r => {
    const followed = S.stations.some(s => s.id === +r.id),
      p = +r[key + '_prix'];
    const right = followed
      ? `<span class="st-done">${esc(tx('st_already'))}</span>`
      : `<button class="st-add" data-i="${+r.id}" aria-label="${esc(tx('st_add'))}">${PLUS_SVG}</button>`;
    return (
      '<div class="row">' +
      `<div class="l"><div class="t">${esc(prettyAdr(r.adresse))}</div><div class="m">${esc((r.cp || '') + ' ' + (r.ville || ''))}</div></div>` +
      `<div class="r"><div class="t">${p > 0 ? stPrice(p) : '–'}</div></div>` +
      right +
      '</div>'
    );
  });
  $('stRes').innerHTML =
    `<div class="note">${esc(tx(stFound.length ? 'st_found' : 'st_nores', { n: stFound.length }))}</div>` +
    rows.join('');
  $('stRes')
    .querySelectorAll('.st-add')
    .forEach(b => (b.onclick = () => followStation(+b.dataset.i)));
}
// "+" icon of the search results.
const PLUS_SVG = '<svg class="i" viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
// Follow station id (from the search results): saved with the prices of the search.
function followStation(id) {
  followRecord(stFound.find(r => +r.id === id));
  renderFound();
}
// Follow the station of feed record rec (search results or map), with its current prices.
function followRecord(rec) {
  if (!rec || S.stations.some(s => s.id === +rec.id)) return;
  const st = { id: +rec.id, adr: '', ville: '', cp: '', h: {} };
  keepPrices(st, rec);
  S.stations.push(st);
  persist();
  renderStations();
}

// An address of the feed as shown: the ones written in capitals ("65 COURS ALBERT THOMAS") get
// small letters with a capital at the start of each word ("65 Cours Albert Thomas").
function prettyAdr(a) {
  a = String(a || '');
  if (a !== a.toUpperCase()) return a;
  return a.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, sep, c) => sep + c.toUpperCase());
}
// A price per litre, shown per displayed volume (litre or US gallon) with 3 decimals.
const stPrice = p => money(priceOut(p), 3) + '/' + VU();
// Short date and time of a price: "18/11 09:40".
const stWhen = d => sd(d) + ' ' + d.slice(11, 16);
// Last price kept for fuel key at station st: [date, price] or null.
const stLast = (st, key) => {
  const h = st.h[key];
  return h && h.length ? h[h.length - 1] : null;
};
// Colours of the chart: the user's fill-ups, then one per station (in the order followed).
const ST_COLORS = ['var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'];
const stColor = i => ST_COLORS[i % ST_COLORS.length];

// Draw the Stations tab: the switch, the chart, the followed stations (last price of the car's
// fuel and its date, the cheapest highlighted), and the tools that need the connection (refresh,
// add a station), replaced by a note while the connection is off. Called by render().
function renderStations() {
  const fuel = defaultFuel(),
    key = FEED_FUEL[fuel];
  $('stOnline').checked = ONLINE;
  $('stIntro').classList.toggle('hide', ONLINE); // explained in How it works once allowed
  $('stSwitchCard').classList.toggle('compact', ONLINE); // only the switch, on one short line
  if (stKey && key !== stKey) {
    // another fuel: its prices of the followed stations may be old, refresh them now (or when the
    // tab is opened) instead of waiting for the 30 minutes
    stChecked = 0;
    if (!$('stations').classList.contains('hide')) refreshStations(false);
  }
  stKey = key;
  $('stMapCard').classList.toggle('hide', !ONLINE);
  $('stMapT').textContent = tx('map_title', { fuel: fuelLabel(fuel) });
  if (ONLINE && !$('stations').classList.contains('hide')) mapShow();
  $('stChartT').textContent = tx('st_chart', { fuel: fuelLabel(fuel) });
  $('stTools').classList.toggle('hide', !ONLINE);
  $('stOff').textContent = ONLINE ? '' : tx('st_off');
  $('stOff').classList.toggle('hide', ONLINE);
  $('stRefresh').classList.toggle('hide', !S.stations.length);
  $('stUpd').textContent = stChecked ? tx('st_updated', { t: new Date(stChecked).toTimeString().slice(0, 5) }) : '';
  const prices = S.stations.map(st => stLast(st, key)).filter(Boolean).map(x => x[1]),
    best = prices.length > 1 ? Math.min(...prices) : null;
  $('st-list').innerHTML = S.stations.length
    ? stationsByPrice(key)
        .map(({ st, i }) => stationRow(st, i, key, fuel, best))
        .join('')
    : '<div class="empty">' + esc(tx('st_none')) + '</div>';
  $('st-list')
    .querySelectorAll('.del')
    .forEach(b => (b.onclick = () => delClick('stations', +b.dataset.i, b)));
  stationChart(fuel, key);
}
// The followed stations in the order shown: cheapest price of the car's fuel first, the ones
// without that fuel at the end (in the order followed). i = place in S.stations, which gives the
// colour of the station's line in the chart.
function stationsByPrice(key) {
  const price = st => (stLast(st, key) || [0, Infinity])[1];
  return S.stations.map((st, i) => ({ st, i })).sort((a, b) => price(a.st) - price(b.st) || a.i - b.i);
}
// One followed station: colour of its line in the chart, address, postcode and town; on the
// right the last price of the car's fuel and its date. The cheapest station (shown first) is in
// green: its name and its price.
function stationRow(st, i, key, fuel, best) {
  const last = stLast(st, key),
    isBest = !!last && last[1] === best,
    price = last
      ? `<div class="${isBest ? 'hl best' : 't'}">${stPrice(last[1])}</div><div class="m">${stWhen(last[0])}</div>`
      : `<div class="m">${esc(tx('st_nofuel', { fuel: fuelLabel(fuel) }))}</div>`;
  return (
    `<div class="row${isBest ? ' best' : ''}">` +
    `<i class="dot" style="background:${stColor(i)}"></i>` +
    `<div class="l"><div class="t">${esc(prettyAdr(st.adr))}</div><div class="m">${esc(st.cp + ' ' + st.ville)}</div></div>` +
    `<div class="r">${price}</div>` +
    deleteButton('stations', st.id) +
    '</div>'
  );
}

// Time (ms) of a date "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM" (local time).
const stTime = d => new Date(d.length > 10 ? d : d + 'T12:00').getTime();
// The series of the chart, over the last 12 months: the user's fill-ups of this fuel (price per
// litre paid, points joined by a line) and each station (its prices, drawn as steps: a price holds
// until the next change, the last one until now).
function stationSeries(fuel, key) {
  const from = Date.now() - 365 * 864e5;
  const mine = FU()
    .filter(f => f.c === fuel && stTime(f.d) >= from)
    .map(f => [stTime(f.d), f.e / f.l])
    .reverse();
  const sts = S.stations.map((st, i) => {
    const h = (st.h[key] || []).map(x => [stTime(x[0]), x[1]]);
    // keep the last price before the 12 months, moved to their start
    const before = h.filter(x => x[0] < from).pop(),
      pts = (before ? [[from, before[1]]] : []).concat(h.filter(x => x[0] >= from));
    return { name: prettyAdr(st.adr), color: stColor(i), pts };
  });
  return { mine, sts: sts.filter(s => s.pts.length) };
}
// Stations > chart of the fuel price: x = time, y = price per displayed volume. A bubble shows
// the prices at the date under the finger or the pointer. Same look as the Stats charts.
function stationChart(fuel, key) {
  const box = $('c3'),
    { mine, sts } = stationSeries(fuel, key);
  const legend = (mine.length ? [{ name: tx('st_mine'), color: 'var(--s1)' }] : []).concat(sts);
  $('stLegend').innerHTML = legend
    .map(s => `<span><i style="background:${s.color}"></i><span>${esc(s.name)}</span></span>`)
    .join('');
  if (mine.length < 2 && !sts.length) {
    box.innerHTML = '<div class="empty">' + esc(tx('st_need2')) + '</div>';
    return;
  }
  const now = Date.now(),
    all = mine.concat(...sts.map(s => s.pts)),
    t0 = Math.min(...all.map(x => x[0])),
    t1 = Math.max(now, ...all.map(x => x[0]));
  const vs = all.map(x => priceOut(x[1])),
    lo = Math.min(...vs),
    hi = Math.max(...vs),
    pad = (hi - lo > 1e-6 ? hi - lo : 0.1) * 0.15;
  const W = 600,
    H = 220,
    m = { l: 60, r: 12, t: 14, b: 34 },
    iw = W - m.l - m.r,
    ih = H - m.t - m.b;
  const tk = niceTicks(lo - pad, hi + pad, 4),
    y0 = tk[0],
    y1 = tk[tk.length - 1];
  const X = t => m.l + (iw * (t - t0)) / (t1 - t0 || 1),
    Y = v => m.t + ih * (1 - (priceOut(v) - y0) / (y1 - y0));
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc($('stChartT').textContent)}">`;
  tk.forEach(v => {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${Y(priceIn(v))}" y2="${Y(priceIn(v))}"/>`;
    s += `<text x="${m.l - 6}" y="${Y(priceIn(v)) + 4}" text-anchor="end">${fmt(v, 2)}</text>`;
  });
  sts.forEach(st => {
    let d = '';
    st.pts.forEach((x, i) => (d += (i ? `H${X(x[0])}V${Y(x[1])}` : `M${X(x[0])},${Y(x[1])}`)));
    d += `H${X(t1)}`;
    s += `<path d="${d}" fill="none" stroke="${st.color}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  if (mine.length) {
    s += `<polyline fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round" points="${mine.map(x => X(x[0]) + ',' + Y(x[1])).join(' ')}"/>`;
    mine.forEach(x => (s += `<circle cx="${X(x[0])}" cy="${Y(x[1])}" r="3.5" fill="var(--s1)" stroke="var(--surf)" stroke-width="1.5"/>`));
  }
  // local date "YYYY-MM-DD" of a time
  const day = t => {
    const d = new Date(t),
      p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  };
  s += `<text x="${m.l}" y="${H - 6}" text-anchor="start">${sd(day(t0))}</text>`;
  s += `<text x="${W - m.r}" y="${H - 6}" text-anchor="end">${sd(day(t1))}</text>`;
  s += `<line id="c3v" y1="${m.t}" y2="${m.t + ih}" stroke="var(--on-surf-v)" stroke-width="1" style="display:none"/></svg><div class="tip"></div>`;
  box.innerHTML = s;
  const svg = box.querySelector('svg'),
    vl = svg.querySelector('#c3v');
  // price of a series at time t: the last point at or before t
  const at = (pts, t) => {
    let v = null;
    for (const x of pts) if (x[0] <= t) v = x[1];
    return v;
  };
  const move = e => {
    const r = svg.getBoundingClientRect(),
      px = Math.max(m.l, Math.min(W - m.r, ((e.clientX - r.left) / r.width) * W)),
      t = t0 + ((px - m.l) / iw) * (t1 - t0);
    vl.setAttribute('x1', px);
    vl.setAttribute('x2', px);
    vl.style.display = '';
    const line = (name, v) => (v === null ? '' : `<br>${esc(name)} : ${stPrice(v)}`);
    tipShow(
      box,
      `<b>${fdate(day(t))}</b>` + line(tx('st_mine'), at(mine, t)) + sts.map(st => line(st.name, at(st.pts, t))).join(''),
      px,
      W,
      r,
    );
  };
  wireTip(svg, move, () => {
    vl.style.display = 'none';
    box.querySelector('.tip').style.display = 'none';
  });
}

// ================================================================================================
// Stations map (OpenStreetMap, prices of the stations in view)
// ================================================================================================
// A map in the Stations tab, shown only while the connection is allowed (MainActivity also blocks
// its tiles otherwise). Leaflet (vendor/leaflet.js, loaded the first time the map is shown) draws
// the OpenStreetMap tiles. The stations in view come from the same official feed: at most MAP_MAX,
// the cheapest first, each with a label giving the price of the car's fuel, from green (cheapest
// of the area) to red. A tap opens its prices, with "Follow" and "Directions".

const MAP_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const MAP_ATTRIB = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const MAP_MIN_ZOOM = 11; // further out the area holds too many stations: the user zooms in
const MAP_MAX = 100; // stations asked for at once
const MAP_VIEW_KEY = KP + 'mapview'; // last centre and zoom, a preference of the device
const MAP_HOME = [46.6, 2.4, 6]; // France, when nothing better is known
let map = null, // the Leaflet map, created the first time it is shown
  mapPins = null, // layer holding the price labels
  mapMe = null, // the user's position (blue dot)
  mapSeq = 0, // number of the last request, to drop late answers
  mapTimer = 0,
  mapKey = '', // fuel of the prices shown (feed name)
  mapRecs = [], // feed records shown
  mapTotal = 0; // stations of the area in the feed (can be more than mapRecs)
// The price labels on the map, by station id. They are kept and updated in place rather than
// drawn again, so the window of a station stays open while new answers arrive (see mapDraw()).
const mapMarkers = new Map();

// Load Leaflet (script and style) once; resolves when it is ready.
let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!leafletLoading) {
    leafletLoading = new Promise((ok, ko) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'vendor/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'vendor/leaflet.js';
      js.onload = ok;
      js.onerror = () => {
        leafletLoading = null;
        ko(new Error('leaflet'));
      };
      document.head.appendChild(js);
    });
  }
  return leafletLoading;
}

// Where the map opens: the last view, else around the followed stations, else all of France.
function mapStartView() {
  try {
    const v = JSON.parse(localStorage.getItem(MAP_VIEW_KEY));
    if (Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number')) return v;
  } catch (e) {}
  const pts = S.stations.filter(st => typeof st.lat === 'number');
  if (!pts.length) return MAP_HOME;
  const avg = k => pts.reduce((a, st) => a + st[k], 0) / pts.length;
  return [avg('lat'), avg('lon'), 13];
}
// Remember the view, for the next time the map opens.
function mapSaveView() {
  const c = map.getCenter();
  try {
    localStorage.setItem(MAP_VIEW_KEY, JSON.stringify([+c.lat.toFixed(5), +c.lng.toFixed(5), map.getZoom()]));
  } catch (e) {}
}
// The line under the map: how many stations, or what to do.
const mapNote = t => ($('stMapNote').textContent = t);

// Create the map: OpenStreetMap tiles, the layer of price labels, and a new search each time the
// view stops moving.
function mapCreate() {
  const v = mapStartView();
  map = L.map('stMap', { zoomControl: true }).setView([v[0], v[1]], v[2]);
  map.attributionControl.setPrefix(false);
  L.tileLayer(MAP_TILES, { maxZoom: 19, attribution: MAP_ATTRIB }).addTo(map);
  mapPins = L.layerGroup().addTo(map);
  map.on('moveend', () => {
    mapSaveView();
    clearTimeout(mapTimer);
    mapTimer = setTimeout(mapLoad, 350);
  });
  // a label kept only because its window was open is removed once the window closes
  map.on('popupclose', () => setTimeout(() => mapDraw(mapKey, mapTotal), 0));
}
// Remove the price labels: all of them, or (keepOpen) all but the one whose window is open.
function mapClear(keepOpen) {
  for (const [id, m] of mapMarkers) {
    if (keepOpen && m.isPopupOpen()) continue;
    mapPins.removeLayer(m);
    mapMarkers.delete(id);
  }
}
// Show the map (Stations tab open, connection allowed): Leaflet is loaded and the map created the
// first time; afterwards it only takes its size again and, if the car's fuel changed, its prices.
function mapShow() {
  if (!ONLINE) return;
  loadLeaflet()
    .then(() => {
      if (!map) mapCreate();
      map.invalidateSize();
      tourSoon(); // the map's bubbles, the first time it is shown
      if (mapKey !== FEED_FUEL[defaultFuel()]) mapLoad();
      else mapDraw(mapKey, mapTotal);
    })
    .catch(() => mapNote(tx('st_err')));
}

// Ask the feed for the stations in view selling the car's fuel, the cheapest first.
async function mapLoad() {
  if (!map || !ONLINE) return;
  const key = FEED_FUEL[defaultFuel()],
    seq = ++mapSeq;
  if (key !== mapKey) {
    // another fuel (another car): the labels and the open window show the old fuel's prices
    map.closePopup();
    mapClear(false);
    mapRecs = [];
  }
  mapKey = key;
  if (map.getZoom() < MAP_MIN_ZOOM) {
    mapRecs = [];
    mapClear(true);
    return mapNote(tx('map_zoom'));
  }
  const b = map.getBounds(),
    c = v => v.toFixed(5);
  const where =
    `in_bbox(geom, ${c(b.getNorth())}, ${c(b.getWest())}, ${c(b.getSouth())}, ${c(b.getEast())})` +
    ` and ${key}_prix is not null`;
  mapNote(tx('st_busy'));
  try {
    const j = await feedJson(where, MAP_MAX, key + '_prix');
    if (seq !== mapSeq) return; // the view moved meanwhile: a newer answer follows
    mapRecs = (j.results || []).filter(r => r.geom && typeof r.geom.lat === 'number');
    mapTotal = j.total_count || mapRecs.length;
    mapDraw(key, mapTotal);
  } catch (e) {
    if (seq === mapSeq) mapNote(tx('st_err'));
  }
}

// Level of a price among the ones shown: 'lo' (cheapest third), 'mid' or 'hi'.
function mapLevel(p, lo, hi) {
  const t = hi > lo ? (p - lo) / (hi - lo) : 0;
  return t < 1 / 3 ? 'lo' : t < 2 / 3 ? 'mid' : 'hi';
}
// The Leaflet icon of a price label (its HTML: the coloured price).
const pinIcon = html => L.divIcon({ className: 'pin', iconSize: [0, 0], html });
// Show a price label for each record of mapRecs (the cheapest on top; the followed stations get
// a ring), and say how many there are. total = stations of the area in the feed.
// The labels are updated in place: a station already shown keeps its label (its colour and price
// change if needed), new ones are added, the ones out of the answer are removed. The label whose
// window is open is never changed or removed meanwhile, so a new answer (after the map moved,
// or the followed stations refreshed) does not close the window the user is reading.
function mapDraw(key, total) {
  if (!mapPins) return;
  const prices = mapRecs.map(r => +r[key + '_prix']),
    lo = Math.min(...prices),
    hi = Math.max(...prices),
    shown = new Set();
  mapRecs.forEach((r, i) => {
    const id = +r.id,
      p = prices[i],
      cls = 'pin-' + mapLevel(p, lo, hi) + (S.stations.some(st => st.id === id) ? ' pin-f' : ''),
      html = `<span class="${cls}">${fmt(priceOut(p), 3)}</span>`;
    shown.add(id);
    let m = mapMarkers.get(id);
    if (!m) {
      m = L.marker([r.geom.lat, r.geom.lon], { icon: pinIcon(html), keyboard: false });
      m.bindPopup(() => mapPopup(m.rec, mapKey), { maxWidth: 280, minWidth: 220 });
      m.html = html;
      m.addTo(mapPins);
      mapMarkers.set(id, m);
    } else if (m.html !== html && !m.isPopupOpen()) {
      m.setIcon(pinIcon(html));
      m.html = html;
    }
    if (!m.isPopupOpen()) m.rec = r; // the open window keeps the record it was opened with
    m.setZIndexOffset((mapRecs.length - i) * 10);
  });
  for (const [id, m] of mapMarkers) {
    if (shown.has(id) || m.isPopupOpen()) continue;
    mapPins.removeLayer(m);
    mapMarkers.delete(id);
  }
  if (map.getZoom() < MAP_MIN_ZOOM) return;
  if (!mapRecs.length) mapNote(tx('map_none'));
  else mapNote(tx(total > mapRecs.length ? 'map_many' : 'map_count', { n: mapRecs.length, t: total }));
}

// The window of a station on the map: address, the prices of every fuel it sells (the car's in
// colour), the time of the car's fuel price, and the Follow and Directions buttons.
function mapPopup(r, key) {
  const el = document.createElement('div');
  el.className = 'mappop';
  const rows = Object.entries(FEED_FUEL)
    .filter(([, f]) => +r[f + '_prix'] > 0)
    .map(([fuel, f]) => `<div class="mp-row${f === key ? ' cur' : ''}"><span>${esc(fuelLabel(fuel))}</span><b>${stPrice(+r[f + '_prix'])}</b></div>`)
    .join('');
  const maj = String(r[key + '_maj'] || '').slice(0, 16),
    followed = S.stations.some(st => st.id === +r.id);
  el.innerHTML =
    `<div class="mp-t">${esc(prettyAdr(r.adresse))}</div>` +
    `<div class="mp-m">${esc((r.cp || '') + ' ' + (r.ville || ''))}</div>` +
    rows +
    (maj.length === 16 ? `<div class="mp-m">${esc(tx('map_upd', { t: stWhen(maj) }))}</div>` : '') +
    '<div class="mp-b">' +
    `<button class="btn tonal" data-a="f"${followed ? ' disabled' : ''}>${esc(tx(followed ? 'st_already' : 'map_follow'))}</button>` +
    `<button class="btn" data-a="r">${esc(tx('map_route'))}</button></div>`;
  el.querySelector('[data-a="f"]').onclick = () => {
    followRecord(r);
    map.closePopup();
    mapDraw(key, mapTotal);
    status(tx('map_followed'));
  };
  el.querySelector('[data-a="r"]').onclick = () => mapRoute(r);
  return el;
}
// Directions to station r: the phone's map or navigation app in the Android app, OpenStreetMap
// in a browser.
function mapRoute(r) {
  const { lat, lon } = r.geom,
    label = prettyAdr(r.adresse) + ', ' + (r.ville || '');
  if (NA && typeof NA.openMap === 'function') return NA.openMap(lat, lon, label);
  window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`, '_blank', 'noopener');
}

// "Locate me": centre the map on the user's position (asked to Android, which asks the user the
// first time) and show it as a blue dot. The position stays on the device: only the map's view
// is used, to ask the feed and OpenStreetMap for that area.
function mapLocate() {
  if (!map) return;
  if (!navigator.geolocation) return status(tx('map_noloc'));
  if (!locationIsOn()) return askLocationOn();
  mapNote(tx('map_locating'));
  navigator.geolocation.getCurrentPosition(
    pos => {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      if (!mapMe) {
        mapMe = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#2a78d6', fillOpacity: 1 });
        mapMe.addTo(map);
      } else mapMe.setLatLng(ll);
      map.setView(ll, Math.max(map.getZoom(), 13));
    },
    err => {
      mapLoad();
      // the location may have been turned off meanwhile: offer to turn it on again
      if (err && err.code !== 1 && !locationIsOn()) askLocationOn();
      else status(tx('map_noloc'));
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 },
  );
}
$('stLocate').onclick = mapLocate;
// Android app: is the phone's location (GPS) on? Always true in a browser, which handles it itself.
const locationIsOn = () => !NA || typeof NA.locationOn !== 'function' || NA.locationOn();
// The phone's location is off: Android would give no position at all, so offer to open the location
// settings. Back in the app with the location on, the map is centred on the user at once.
let mapLocatePending = false;
function askLocationOn() {
  mapLoad();
  dialog(
    tx('map_gps_t'),
    '<p>' + esc(tx('map_gps_msg')) + '</p>',
    [
      { t: tx('cancel'), tonal: true },
      {
        t: tx('map_gps_open'),
        fn: () => {
          mapLocatePending = true;
          NA.openLocationSettings();
        },
      },
    ],
    'pin',
  );
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !mapLocatePending) return;
  mapLocatePending = false;
  if (locationIsOn()) mapLocate();
});

// ================================================================================================
// Guided tour (bubbles over a dimmed screen)
// ================================================================================================
// A few bubbles, each pointing at one element of the app with a short explanation and an OK
// button (nothing has to be done). The rest of the screen is dimmed and cannot be tapped.
// - "start": after the first launch (the wheels, then in the Android app the backup folder), in
//   My garage: the car, the car selector, the purchases, then the Fill-ups and Stations tabs.
// - "fuel", "stations", "map", "stats": the first time the user opens that tab (or sees the map).
// Who sees what (keep this rule): a new install gets every bubble; someone who already had the
// app only gets the bubbles added by a major update. Each step has `since`, the TOUR_VERSION that
// added it; the device remembers (TOUR_KEY) `base`, the tour version it already knew (0 for a new
// install, TOUR_VERSION for an older install meeting the tour for the first time), and the steps
// seen. A step shows when step.since > base and it was not seen. To present something new in a
// major update: add its steps with since = TOUR_VERSION + 1, then raise TOUR_VERSION.
const TOUR_VERSION = 1;
const TOUR_KEY = KP + 'tour';
// The steps of each tour: id (texts tour_<id>_t and tour_<id>_x in i18n.js), the tab to show
// (if any), what to prepare, the element pointed at, when it applies, and since.
const TOURS = {
  start: [
    { id: 'car', tab: 'garage', prep: () => showGarage('cars'), sel: '#cars-list .carrow', since: 1 },
    { id: 'carsel', tab: 'garage', sel: '.carsel', since: 1 },
    { id: 'buys', tab: 'garage', sel: '.seg [data-g="buys"]', since: 1 },
    { id: 'navfuel', tab: 'garage', sel: '.nav [data-t="fuel"]', since: 1 },
    { id: 'navst', tab: 'garage', sel: '.nav [data-t="stations"]', since: 1 },
  ],
  fuel: [
    { id: 'scan', sel: '#scan .btn', when: () => !$('scan').classList.contains('hide'), since: 1 },
    { id: 'form', sel: '#fuel .grid', since: 1 },
  ],
  stations: [{ id: 'switch', sel: '#stSwitchCard .switch', since: 1 }],
  map: [
    { id: 'map', sel: '#stMap', when: () => ONLINE && !!map, since: 1 },
    { id: 'locate', sel: '#stLocate', when: () => ONLINE && !!map, since: 1 },
  ],
  stats: [{ id: 'stats', sel: '#stats .card', since: 1 }],
};
// The tours of each tab, offered the first time it is opened.
const TAB_TOURS = { fuel: ['fuel'], stations: ['stations', 'map'], stats: ['stats'] };
let tourState = null, // { base, seen: ['start.car', …] }, saved in TOUR_KEY
  tourRun = null, // the tour on screen: { name, steps, i }
  tourFollow = 0; // timer keeping the bubble on its element while the page settles

// Read and save what this device has seen of the tour.
function tourSave() {
  try {
    localStorage.setItem(TOUR_KEY, JSON.stringify(tourState));
  } catch (e) {}
}
// At startup: newInstall = the first-launch screens are shown (nothing known about this device).
// A device without tour state but with a known language had the app before the tour existed: it
// knows the app as of TOUR_VERSION, so it is only shown later additions.
function tourInit(newInstall) {
  try {
    const t = JSON.parse(localStorage.getItem(TOUR_KEY));
    if (t && typeof t.base === 'number' && Array.isArray(t.seen)) tourState = t;
  } catch (e) {}
  if (!tourState) {
    tourState = { base: newInstall ? 0 : TOUR_VERSION, seen: [] };
    tourSave();
  }
}
// The steps of tour name still to show on this device, among those that apply now.
function tourSteps(name) {
  return TOURS[name].filter(
    st => st.since > tourState.base && !tourState.seen.includes(name + '.' + st.id) && (!st.when || st.when()),
  );
}
// True while something else holds the screen: first-launch wheels, a dialog, or the backup folder
// setup while its screen is shown (a user who leaves it without choosing a folder gets the tour).
const tourBusy = () =>
  (setupMode && tabShown() === 'save') ||
  !$('lang').classList.contains('hide') ||
  !$('picker').classList.contains('hide') ||
  !$('dlg').classList.contains('hide');
// The tab on screen.
const tabShown = () => ['fuel', 'stations', 'stats', 'garage', 'save'].find(id => !$(id).classList.contains('hide'));

// Start tour name if it has steps to show and nothing else is on screen. Returns true if started.
function tourStart(name) {
  if (tourRun || !tourState || tourBusy()) return false;
  const steps = tourSteps(name);
  if (!steps.length) return false;
  tourRun = { name, steps, i: 0 };
  $('tour').classList.remove('hide');
  tourShow();
  return true;
}
// Run fn once nothing else is on screen (first-launch wheels, install advice, dialog…).
function tourWhenIdle(fn) {
  if (tourBusy()) setTimeout(() => tourWhenIdle(fn), 600);
  else fn();
}
// A moment after a tab opened (its animation): the first tour if it was not shown yet (e.g. the
// user left the backup folder screen without choosing a folder), else the tours of that tab.
let tourTimer = 0;
function tourSoon() {
  clearTimeout(tourTimer);
  tourTimer = setTimeout(() => tourStart('start') || (TAB_TOURS[tabShown()] || []).some(tourStart), 450);
}

// Show the current step: its tab, then the bubble once the element is in view. A step whose
// element is missing or hidden is skipped.
function tourShow() {
  const st = tourRun.steps[tourRun.i],
    tabChange = st.tab && tabShown() !== st.tab;
  if (tabChange) showTab(st.tab);
  if (st.prep) st.prep();
  tourState.seen.push(tourRun.name + '.' + st.id);
  tourSave();
  setTimeout(() => {
    const el = document.querySelector(st.sel);
    if (!el || !el.getClientRects().length) return tourNext();
    const r = el.getBoundingClientRect();
    if (r.top < 64 || r.bottom > innerHeight - 96) el.scrollIntoView({ block: 'center' });
    tourText(st);
    setTimeout(() => tourPlace(el), 60);
    // the page may still move (a tab's animation, a map that appears…): follow the element
    clearInterval(tourFollow);
    tourFollow = setInterval(() => tourPlace(el), 250);
  }, tabChange ? 400 : 60);
}
// The texts of the bubble: title, explanation, "2 / 5", and OK ("Let's go!" at the end of the
// first tour).
function tourText(st) {
  const { name, steps, i } = tourRun,
    last = i === steps.length - 1;
  $('tourT').textContent = tx('tour_' + st.id + '_t');
  $('tourX').textContent = tx('tour_' + st.id + '_x');
  $('tourN').textContent = steps.length > 1 ? i + 1 + ' / ' + steps.length : '';
  $('tourOk').textContent = tx(last && name === 'start' ? 'tour_go' : 'ok');
}
// Light the element el and place the bubble next to it: below if there is room, else above, else
// over the element's lower part (a big element like the map); the arrow points at it.
function tourPlace(el) {
  if (!tourRun) return;
  const r = el.getBoundingClientRect(),
    pad = 6,
    gap = 16,
    bub = $('tourBub'),
    arrow = $('tourArrow');
  Object.assign($('tourHole').style, {
    left: r.left - pad + 'px',
    top: r.top - pad + 'px',
    width: r.width + 2 * pad + 'px',
    height: r.height + 2 * pad + 'px',
  });
  const bw = bub.offsetWidth,
    bh = bub.offsetHeight,
    cx = r.left + r.width / 2,
    left = Math.min(Math.max(cx - bw / 2, 16), innerWidth - bw - 16);
  let top, dir;
  if (r.bottom + pad + gap + bh + 8 <= innerHeight) {
    top = r.bottom + pad + gap;
    dir = 'up';
  } else if (r.top - pad - gap - bh >= 8) {
    top = r.top - pad - gap - bh;
    dir = 'down';
  } else {
    top = Math.max(8, Math.min(innerHeight - bh - 8, r.bottom - bh - gap));
    dir = 'none';
  }
  Object.assign(bub.style, { left: left + 'px', top: top + 'px' });
  arrow.className = 'tour-arrow ' + dir;
  const ax = Math.min(Math.max(cx, left + 24), left + bw - 24) - 11;
  Object.assign(arrow.style, { left: ax + 'px', top: (dir === 'up' ? top - 22 : top + bh) + 'px' });
}
// OK: next step, or the end of the tour.
function tourNext() {
  if (!tourRun) return;
  tourRun.i++;
  if (tourRun.i < tourRun.steps.length) tourShow();
  else tourEnd();
}
// End the tour on screen; then the tab's own tours may follow (e.g. the map after the switch).
function tourEnd() {
  clearInterval(tourFollow);
  tourRun = null;
  $('tour').classList.add('hide');
  tourSoon();
}
// Skip: the rest of this tour is marked as seen (the other tours still come at their time).
function tourSkip() {
  if (!tourRun) return;
  tourRun.steps.forEach(st => {
    const k = tourRun.name + '.' + st.id;
    if (!tourState.seen.includes(k)) tourState.seen.push(k);
  });
  tourSave();
  tourEnd();
}
// Settings > How it works > "Show the guided tour again": every bubble again, the first tour now.
function tourReplay() {
  tourState = { base: 0, seen: [] };
  tourSave();
  tourStart('start');
}
$('tourOk').onclick = tourNext;
$('tourSkip').onclick = tourSkip;
$('tourReplay').onclick = tourReplay;
// the screen turned or changed size: place the bubble again
addEventListener('resize', () => {
  if (!tourRun) return;
  const el = document.querySelector(tourRun.steps[tourRun.i].sel);
  if (el) tourPlace(el);
});

// ================================================================================================
// Navigation and keyboard
// ================================================================================================

// Show tab t (fuel, stations, stats, garage, or save = the settings) with a short animation.
// The settings are not in the bottom bar: they open with the gear of the top bar, which is then
// highlighted. Leaving the garage closes its car form; opening Stations refreshes the prices
// (at most every 30 minutes, only when the connection is allowed).
function showTab(t) {
  document.querySelectorAll('.nav button').forEach(x => x.classList.toggle('on', x.dataset.t === t));
  $('setBtn').classList.toggle('on', t === 'save');
  ['fuel', 'stations', 'stats', 'garage', 'save'].forEach(id => $(id).classList.toggle('hide', id !== t));
  if (t !== 'garage') closeCarForm();
  if (t === 'stations') {
    refreshStations(false);
    mapShow();
  }
  const el = $(t);
  el.classList.remove('tabin');
  void el.offsetWidth;
  el.classList.add('tabin');
  window.scrollTo(0, 0);
  tourSoon(); // the bubbles of this tab, the first time
}
document.querySelectorAll('.nav button').forEach(b => (b.onclick = () => showTab(b.dataset.t)));
$('setBtn').onclick = () => showTab('save');
// My garage has two parts, chosen with the buttons at the top: the cars ('cars') and the
// purchases ('buys').
function showGarage(part) {
  document.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.g === part));
  $('garCars').classList.toggle('hide', part !== 'cars');
  $('buys').classList.toggle('hide', part !== 'buys');
  closeCarForm();
}
document.querySelectorAll('.seg button').forEach(b => (b.onclick = () => showGarage(b.dataset.g)));
// Stats > Spending: the link under the reminder opens My garage -> Purchases.
$('sxGo').onclick = () => {
  showTab('garage');
  showGarage('buys');
};
// Keyboard open (body.kb hides the bottom bar): while a field that is typed into has the focus.
// Date fields, switches (checkboxes) and file inputs open no keyboard.
const typesIn = e => !!e && /^(INPUT|TEXTAREA)$/.test(e.tagName) && !/^(date|checkbox|radio|file)$/.test(e.type);
document.addEventListener('focusin', e => {
  if (typesIn(e.target)) document.body.classList.add('kb');
});
document.addEventListener('focusout', () =>
  setTimeout(() => {
    if (!typesIn(document.activeElement)) document.body.classList.remove('kb');
  }, 150),
);

// ================================================================================================
// Startup
// Everything above only defines things; the app starts here.
// ================================================================================================

// Load the settings and the data, then draw the app. Order of the data sources:
// konso.json in the chosen folder (Android) if readable, else the localStorage copy.
function init() {
  let saved = null;
  try {
    saved = localStorage.getItem(LK);
  } catch (e) {}
  try {
    const u = localStorage.getItem(UK),
      m = localStorage.getItem(MK),
      t = localStorage.getItem(TK);
    if (UNITS.includes(u)) UNIT = u;
    if (MONEY.includes(m)) MONEYC = m;
    if (THEMES.includes(t)) THEME = t;
    ONLINE = localStorage.getItem(OK_KEY) === '1';
  } catch (e) {}
  applyTheme(THEME);
  syncInsets();
  // the Android side blocks the internet unless told otherwise: keep it in step with the switch
  if (NA && typeof NA.setOnline === 'function') NA.setOnline(ONLINE);
  const known = LANGS.some(l => l[0] === saved);
  setLang(known ? saved : guessLang(), false);
  tourInit(!known);
  if (!known) showLangScreen();
  const c = cacheLoad();
  if (c) S = norm(c);
  if (NA) {
    folder = String(NA.folderName() || '');
    if (folder) {
      try {
        const d = readFileData();
        if (d) {
          S = norm(d);
          cacheSave();
        } else if (S.fuel.length || S.buys.length) writeOut();
      } catch (e) {
        status(tx('st_keep'));
      }
    }
  }
  setupMode = !!NA && !folder;
  render();
  renderSave();
  if (setupMode) showTab('save');
  // a tour not finished at the last start (or the first tour after the first launch's wheels)
  else if (known) tourWhenIdle(() => tourStart('start') || tourSoon());
}
$('fd').value = today();
$('bd').value = today();
init();
initWeb();
initScan();
applyCarDefaults();
marks();
watchChartScale();

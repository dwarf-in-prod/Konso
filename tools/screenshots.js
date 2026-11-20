// Regenerates the README screenshots (docs/screenshots/*.png) from the web app, in English,
// with made-up demo data: the phone screens (1-…6-…png) and the web version on a computer
// (desktop.png). Also copies the phone screens to the F-Droid / IzzyOnDroid listing
// (fastlane/metadata/android/en-US/images/phoneScreenshots/) and renders its 512 px icon
// from the launcher icon (res/drawable/ic_fg.xml on the res/values/colors.xml background). Usage, from the repository root:
//   npm install --no-save playwright && npx playwright install chromium   (once)
//   node tools/screenshots.js
// The Android bridge is stubbed (a backup folder named "Konso") and the OCR engine is replaced
// by a fixed receipt text, so the output is the same on every run (apart from the dates).
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');

const ROOT = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www');
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const STORE = path.join(__dirname, '..', 'fastlane', 'metadata', 'android', 'en-US', 'images');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };

const pad = n => String(n).padStart(2, '0');
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const r2 = x => Math.round(x * 100) / 100;

// Demo data: one car, ten fill-ups about three weeks apart, a few purchases.
function demo(serviceDaysAgo, svcKm) {
  const km = [612, 655, 701, 588, 640, 690, 625, 670, 605, 650];
  const rate = [6.4, 6.9, 6.6, 7.1, 6.3, 6.8, 6.5, 6.2, 7.0, 6.6];
  const price = [1.789, 1.812, 1.775, 1.829, 1.846, 1.801, 1.768, 1.752, 1.795, 1.818];
  const where = ['Esso', 'Supermarket', '', 'Highway A6', 'Esso', '', 'Supermarket', '', 'Esso', 'Supermarket'];
  const fuel = km.map((k, i) => {
    const l = r2(k * rate[i] / 100);
    return { id: 100 + i, car: 'c1', d: day(-3 - 24 * i), k, l, e: r2(l * price[i]), c: 'SP95-E10', s: where[i] };
  });
  const buys = [
    { id: 200, car: 'c1', d: day(-serviceDaysAgo), e: 189.9, c: 'Entretien / révision', n: 'Yearly service', k: 0, s: 'Local garage' },
    { id: 201, car: 'c1', d: day(-60), e: 21.5, c: 'Filtres', n: 'Cabin filter', k: 0, s: '' },
    { id: 202, car: 'c1', d: day(-130), e: 386, c: 'Pneus', n: '4 all-season tyres', k: 0, s: '' },
    { id: 203, car: 'c1', d: day(-180), e: 44.9, c: 'Huile moteur', n: 'Engine oil 5W-30, 5 L', k: 0, s: '' }
  ];
  return { app: 'konso', version: 2, cur: 'c1', cars: [{ id: 'c1', name: '', fuel: 'SP95-E10', svcKm }], fuel, buys, stations: demoStations() };
}
// Demo followed stations (Stations tab): made-up addresses, E10 prices changing every few days
// over the last two months, drawn as steps in the chart.
function demoStations() {
  const st = (id, adr, base, step) => {
    const h = [];
    for (let i = 60; i >= 0; i -= step) h.push([day(-i) + 'T08:00', r2((base + 0.04 * Math.sin(i / 9) + (i % 7) * 0.002) * 1000) / 1000]);
    const [lat, lon] = MAP_SPOTS[id - 69007901];
    return { id, adr, ville: 'Lyon', cp: '69007', lat, lon, h: { e10: h } };
  };
  return [st(69007901, '12 Avenue de la Gare', 1.79, 4), st(69007902, 'Route de Vienne', 1.82, 6), st(69007903, 'Centre commercial des Lilas', 1.75, 5)];
}

// Stations map: made-up stations around the demo followed ones (their first three records), as the
// official feed would answer them, the cheapest first.
const MAP_CENTRE = [45.7465, 4.8425];
const MAP_SPOTS = Array.from({ length: 22 }, (_, i) => {
  const a = i * 2.39, d = 0.003 + (i % 5) * 0.0028;
  return [+(MAP_CENTRE[0] + Math.sin(a) * d).toFixed(5), +(MAP_CENTRE[1] + Math.cos(a) * d * 1.4).toFixed(5)];
});
function demoMapRecords() {
  const names = ['12 Avenue de la Gare', 'Route de Vienne', 'Centre commercial des Lilas'];
  return MAP_SPOTS.map(([lat, lon], i) => ({
    id: 69007901 + i,
    adresse: names[i] || (8 + i * 6) + ' Rue des Exemples',
    ville: 'Lyon',
    cp: '69007',
    geom: { lat, lon },
    e10_prix: [1.79, 1.82, 1.75][i] || r2(1.73 + ((i * 37) % 23) / 100),
    e10_maj: day(0) + 'T08:00:00+00:00',
    gazole_prix: r2(1.66 + ((i * 13) % 17) / 100),
    gazole_maj: day(0) + 'T07:30:00+00:00',
  })).sort((a, b) => a.e10_prix - b.e10_prix);
}
// A plain map tile (256 x 256 PNG, the colour of empty OpenStreetMap land), used when the
// OpenStreetMap tile server cannot be reached, so the screenshots can still be made.
function plainTile() {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = b => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4), sum = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t), d]); len.writeUInt32BE(d.length); sum.writeUInt32BE(crc(td)); return Buffer.concat([len, td, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(256, 0); ihdr.writeUInt32BE(256, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(256).fill([242, 239, 233]).flat())]);
  const raw = Buffer.concat(Array(256).fill(row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = http.createServer((q, r) => {
    const f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(ROOT)) { r.writeHead(403); r.end(); return; }
    fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + srv.address().port + '/';
  const browser = await chromium.launch({ args: ['--lang=en-GB'], env: { ...process.env, LANG: 'en_GB.UTF-8', LANGUAGE: 'en_GB' } });

  // web = the web version on a computer (no Android bridge, wide window); otherwise the Android app on a phone.
  async function open(data, web) {
    const ctx = await browser.newContext({ viewport: web ? { width: 1280, height: 800 } : { width: 412, height: 915 }, deviceScaleFactor: 2, reducedMotion: 'reduce', locale: 'en-GB' });
    // map tiles: from OpenStreetMap when it can be reached, else a plain tile
    const tile = plainTile();
    await ctx.route('https://tile.openstreetmap.org/**', async route => {
      try { await route.fulfill({ response: await route.fetch({ timeout: 8000 }) }); }
      catch (e) { await route.fulfill({ contentType: 'image/png', body: tile }); }
    });
    const page = await ctx.newPage();
    await page.addInitScript(([d, web, mapRecs, centre]) => {
      const json = JSON.stringify(d);
      localStorage.setItem('konso-lang', 'en');
      localStorage.setItem('konso-data', json);
      localStorage.setItem('konso-install-seen', '1'); // web version: no install advice over the screenshot
      // Stations: connection allowed, but the official price site is answered here (no new price
      // for the followed stations, the demo stations for the map), so the screenshots never ask it
      // and stay the same on every run
      localStorage.setItem('konso-online', '1');
      localStorage.setItem('konso-mapview', JSON.stringify([centre[0], centre[1], 14]));
      const realFetch = window.fetch;
      const answer = u => {
        const m = /in_bbox\(geom, ([\d.-]+), ([\d.-]+), ([\d.-]+), ([\d.-]+)\)/.exec(decodeURIComponent(String(u)).replace(/\+/g, ' '));
        const recs = m ? mapRecs.filter(r => r.geom.lat <= +m[1] && r.geom.lat >= +m[3] && r.geom.lon >= +m[2] && r.geom.lon <= +m[4]) : [];
        return new Response(JSON.stringify({ total_count: recs.length, results: recs }), { headers: { 'Content-Type': 'application/json' } });
      };
      window.fetch = (u, o) => (String(u).includes('data.economie.gouv.fr') ? Promise.resolve(answer(u)) : realFetch(u, o));
      // stand-in for the Android bridge of MainActivity: a backup folder is already chosen
      if (!web) window.Android = { folderName: () => 'Konso', fileName: () => 'konso.json', pickFolder: () => {}, readFile: () => json, writeFile: () => 'ok' };
    }, [data, !!web, demoMapRecords(), MAP_CENTRE]);
    await page.goto(url);
    await page.waitForTimeout(400);
    return page;
  }
  async function shot(page, name) {
    await page.evaluate(() => { document.activeElement && document.activeElement.blur(); document.getElementById('st').classList.remove('show'); });
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, name) });
    console.log('docs/screenshots/' + name);
  }

  // Not due: last service 150 days ago, about 4,500 km since.
  let page = await open(demo(150, 10000));
  await shot(page, '1-fill-ups.png');

  // Receipt scan, with a fixed OCR result
  await page.evaluate(t => {
    window.prepImage = async () => new Blob(['x']);
    window.getWorker = async () => ({ setParameters: async () => {}, recognize: async () => ({ data: { text: t } }) });
  }, 'ESSO EXPRESS\n' + day(0).split('-').reverse().join('/') + ' 08:41\nSP95-E10\nVOLUME 42,15 L\nPRIX 1,789 EUR/L\nMONTANT 75,41 EUR\n');
  await page.setInputFiles('#sc1', { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from('x') });
  await page.waitForFunction(() => /Esso/.test(document.getElementById('scanres').textContent));
  await shot(page, '2-receipt-scan.png');

  await page.evaluate(() => showTab('stats'));
  await shot(page, '3-overview.png');

  await page.evaluate(() => showTab('stations'));
  await page.waitForSelector('.pin span');
  await page.waitForTimeout(800);
  await shot(page, '5-stations.png');

  await page.evaluate(() => showTab('garage'));

  await page.click('#svcKmBtn');
  await shot(page, '6-wheel-picker.png');
  await page.context().close();

  // Due: 5,000 km reminder and about 5,800 km since the last service
  page = await open(demo(200, 5000));
  await shot(page, '4-service-reminder.png');
  await page.context().close();

  // Web version on a computer: navigation rail, charts side by side
  page = await open(demo(150, 10000), true);
  await page.evaluate(() => showTab('stats'));
  await shot(page, 'desktop.png');
  await page.context().close();

  // Store listing: same screenshots, and the icon (the adaptive icon's layers, full square).
  const shots = path.join(STORE, 'phoneScreenshots');
  fs.mkdirSync(shots, { recursive: true });
  for (const f of fs.readdirSync(OUT).filter(f => /^\d-.*\.png$/.test(f))) fs.copyFileSync(path.join(OUT, f), path.join(shots, f));
  page = await (await browser.newContext({ viewport: { width: 512, height: 512 } })).newPage();
  await page.setContent(`<body style="margin:0">${require('./icon-svg').iconSvg(0, 512)}</body>`);
  await page.screenshot({ path: path.join(STORE, 'icon.png') });
  console.log('fastlane/metadata/android/en-US/images/ (icon and screenshots)');

  await browser.close();
  srv.close();
})().catch(e => { console.error(e); process.exit(1); });

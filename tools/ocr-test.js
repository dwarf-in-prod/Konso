// Checks that the OCR engine in a vendor folder really reads text, in Chromium, with the same
// Tesseract.createWorker() options as index.html. Used by the "Tesseract from source" workflow
// on the rebuilt files. Usage, from the repository root:
//   npm install --no-save playwright && npx playwright install chromium   (once)
//   node tools/ocr-test.js [vendor-folder]      (default: app/src/main/assets/www/vendor)
// The text is drawn on a canvas, so no image file is needed. Exit code 0 when it is read back.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');

const VENDOR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'vendor'));
const LANG = path.join(__dirname, '..', 'app', 'src', 'main', 'assets', 'www', 'vendor', 'lang');
const LINES = ['STATION SERVICE', 'GAZOLE', 'VOLUME 42,18 L', 'PRIX 1,789 EUR/L', 'TOTAL 75,48 EUR'];
const EXPECT = ['GAZOLE', '42,18', '1,789', '75,48'];

const PAGE = `<!doctype html><meta charset="utf-8"><script src="/vendor/tesseract.min.js"></script>
<canvas id="c" width="900" height="460"></canvas>
<script>
window.run = async lines => {
  const c = document.getElementById('c'), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000'; g.font = 'bold 44px monospace';
  lines.forEach((l, i) => g.fillText(l, 40, 70 + i * 80));
  const base = new URL('/vendor/', location.href).href;
  const w = await Tesseract.createWorker('fra', 1, { workerPath: base + 'worker.min.js',
    corePath: base + 'tesseract-core-simd-lstm.wasm.js', langPath: '/lang', gzip: true,
    workerBlobURL: false, cacheMethod: 'none' });
  const r = await w.recognize(c);
  await w.terminate();
  return r.data.text;
};
</script>`;

(async () => {
  const srv = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/') { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end(PAGE); return; }
    let f = null;
    // index.html loads the model from vendor/lang; the file is stored as .gz.bin (see MainActivity)
    if (u.startsWith('/vendor/')) f = path.join(VENDOR, u.slice(8));
    if (u.startsWith('/lang/')) f = path.join(LANG, u.slice(6) + (u.endsWith('.gz') ? '.bin' : ''));
    if (!f || !(f.startsWith(VENDOR) || f.startsWith(LANG))) { r.writeHead(404); r.end(); return; }
    fs.readFile(f, (e, d) => {
      if (e) { r.writeHead(404); r.end(); return; }
      r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' });
      r.end(d);
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch();
  let ok = false;
  try {
    const page = await browser.newPage();
    page.on('console', m => console.log('[page]', m.text()));
    page.on('pageerror', e => console.log('[page error]', e.message));
    await page.goto('http://127.0.0.1:' + srv.address().port + '/');
    const text = await page.evaluate(l => window.run(l), LINES);
    console.log('Read by OCR:\n' + text);
    const missing = EXPECT.filter(s => !text.includes(s));
    ok = missing.length === 0;
    console.log(ok ? 'OCR test passed.' : 'OCR test FAILED, not found: ' + missing.join(', '));
  } finally {
    await browser.close();
    srv.close();
  }
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

// Regenerates the icons of the web version (web/icons/) from the Android launcher icon:
// res/drawable/ic_fg.xml on the ic_bg colour of res/values/colors.xml (tools/icon-svg.js). Usage, from the
// repository root (Playwright needed, as for tools/screenshots.js):
//   node tools/web-icons.js
// - icon.svg, icon-192.png, icon-512.png: rounded square, for browsers and computers;
// - maskable-512.png: full square, Android crops it to its own shape (the drop stays in the safe zone);
// - apple-touch-icon.png (180 px): full square, iPhone and iPad round the corners themselves.
const { chromium } = require('playwright');
const fs = require('fs'),
  path = require('path');

const { iconSvg } = require('./icon-svg');

const OUT = path.join(__dirname, '..', 'web', 'icons');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.svg'), iconSvg(24) + '\n');
  const browser = await chromium.launch();
  const icons = [
    ['icon-192.png', 192, 24],
    ['icon-512.png', 512, 24],
    ['maskable-512.png', 512, 0],
    ['apple-touch-icon.png', 180, 0],
  ];
  for (const [name, size, rx] of icons) {
    const page = await (await browser.newContext({ viewport: { width: size, height: size } })).newPage();
    await page.setContent(
      `<body style="margin:0;background:transparent">${iconSvg(rx, size)}</body>`,
    );
    await page.screenshot({ path: path.join(OUT, name), omitBackground: true });
    console.log('web/icons/' + name);
  }
  await browser.close();
})().catch(e => {
  console.error(e);
  process.exit(1);
});

// The Android launcher icon as SVG: every <path> of res/drawable/ic_fg.xml (fill and stroke) on the
// ic_bg colour of res/values/colors.xml. Used by tools/web-icons.js (web version icons) and
// tools/screenshots.js (store icon), so the icon is drawn in one place only.
const fs = require('fs'),
  path = require('path');

const RES = path.join(__dirname, '..', 'app', 'src', 'main', 'res');

// Value of the android:<name> attribute in one <path .../> element, or undefined.
const attr = (el, name) => (el.match(new RegExp(`android:${name}="([^"]+)"`)) || [])[1];

// One <path> of the vector drawable as an SVG <path> (fill, or a stroke with its width and line cap).
function svgPath(el) {
  const fill = attr(el, 'fillColor'),
    stroke = attr(el, 'strokeColor');
  let a = `d="${attr(el, 'pathData')}" fill="${fill || 'none'}"`;
  if (stroke) {
    a += ` stroke="${stroke}" stroke-width="${attr(el, 'strokeWidth') || 1}"`;
    a += ` stroke-linecap="${attr(el, 'strokeLineCap') || 'butt'}"`;
  }
  return `<path ${a}/>`;
}

// The whole icon, 108 x 108, with corners rounded by rx (0 = full square). size, if given, sets
// the width and height of the <svg> in pixels.
function iconSvg(rx, size) {
  const bg = fs.readFileSync(path.join(RES, 'values', 'colors.xml'), 'utf8').match(/name="ic_bg">([^<]+)</)[1];
  const fg = fs.readFileSync(path.join(RES, 'drawable', 'ic_fg.xml'), 'utf8');
  const paths = (fg.match(/<path[\s\S]*?\/>/g) || []).map(svgPath).join('');
  const wh = size ? ` width="${size}" height="${size}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${wh} viewBox="0 0 108 108">` +
    `<rect width="108" height="108" rx="${rx}" fill="${bg}"/>${paths}</svg>`
  );
}

module.exports = { iconSvg };

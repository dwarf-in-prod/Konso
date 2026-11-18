/*
 * Konso — reads a fuel receipt.
 *
 * Extracts station, date, litres, price per litre, amount and fuel type from the text given by the
 * OCR engine. Nothing is ever invented: what is not found stays null.
 *
 * Main idea: on a fuel receipt, litres x price per litre = amount. findTriple() looks for three
 * numbers that agree (within 1.5 %); when it finds them, the three values are reliable even if the OCR
 * text is messy. Otherwise the values are looked for next to their labels (TOTAL, LITRES...) and the
 * result says so in `notes`, so that the app can warn the user.
 *
 * Used by app.js (window.TicketParse.parseTicket); also loadable in Node for tests (module.exports).
 */
(function (root) {
// Fuel types, as stored in the data (FUELV in app.js), with the words that identify them on a receipt.
// The first match wins: E85 and LPG first, and E10 before SP95 (an E10 receipt often says SP95 too).
  const FUELS = [
    ['E85', /E\s?85|ETHANOL/i],
    ['GPL', /\bGPL\b|\bLPG\b/i],
    ['SP98', /SP\s?-?\s?98|SANS\s*PLOMB\s*98|\b98\s?RON|SUPER\s?PLUS|ULTIMATE/i],
    ['SP95-E10', /E\s?-?\s?10\b/i],
    ['SP95', /SP\s?-?\s?95|SANS\s*PLOMB\s*95|\b95\s?RON|EURO\s?SUPER|UNLEADED\s*95|SUPER\s?95/i],
    ['Gazole', /GAZOLE|DIESEL|GASOIL|GASOLEO|GAS[OÓ]LEO|MOTORIN[AĂ]|MOTORYN|\bB7\b/i],
  ];
// Station brands, looked for in the first lines of the receipt. "TOTAL" alone counts as the brand only
// when it is not the total amount (TOTAL A PAYER, TOTAL TTC, TOTAL 45,20...).
  const BRANDS = [
    ['TotalEnergies', /TOTAL\s?ENERGIES|TOTAL\s?ACCESS|\bTOTAL\b(?!\s*(?:[AÀ]\s*PAYER|TTC|HT|EUR|€|\d|:))/i],
    ['Leclerc', /LECLERC/i],
    ['Carrefour', /CARREFOUR/i],
    ['Intermarché', /INTERMARCH/i],
    ['Auchan', /AUCHAN/i],
    ['Super U', /\bSUPER\s?U\b|\bHYPER\s?U\b|SYST[EÈ]ME\s?U|\bSTATION\s?U\b/i],
    ['Esso', /\bESSO\b/i],
    ['Shell', /\bSHELL\b/i],
    ['BP', /\bBP\b/],
    ['Avia', /\bAVIA\b/i],
    ['Elan', /\bELAN\b/i],
    ['Casino', /\bCASINO\b/i],
    ['Cora', /\bCORA\b/i],
    ['Géant', /G[EÉ]ANT/i],
    ['Netto', /\bNETTO\b/i],
    ['Eni', /\bENI\b|\bAGIP\b/i],
    ['Dyneff', /DYNEFF/i],
    ['Vito', /\bVITO\b/i],
    ['Lidl', /\bLIDL\b/i],
    ['Aldi', /\bALDI\b/i],
    ['Costco', /COSTCO/i],
    ['Intermarché Contact', /INTERMARCH[EÉ]\s*CONTACT/i],
  ];
// Round to 2 / 3 decimals.
  const r2 = n => Math.round(n * 100) / 100;
  const r3 = n => Math.round(n * 1000) / 1000;

// Every decimal number of the text ("45,20", "1.789"...), with its value, its number of decimals and
// the line it is on (li = line index).
  function numbers(text) {
    const out = [];
    const re = /(\d{1,4})\s?[.,]\s?(\d{2,3})(?!\d)/g;
    let m;
    const lines = text.split('\n');
    let pos = 0;
    const starts = lines.map(l => {
      const s = pos;
      pos += l.length + 1;
      return s;
    });
    while ((m = re.exec(text))) {
      let li = 0;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= m.index) li = i;
      out.push({ v: parseFloat(m[1] + '.' + m[2]), dec: m[2].length, line: lines[li] || '', li });
    }
    return out;
  }

// First valid date (DD/MM/YYYY, DD.MM.YY...) that is not in the future, as YYYY-MM-DD.
  function findDate(text) {
    const re = /\b(0?[1-9]|[12]\d|3[01])\s?[\/.\-]\s?(0?[1-9]|1[0-2])\s?[\/.\-]\s?(\d{4}|\d{2})\b/g;
    let m;
    const now = Date.now() + 86400000;
    while ((m = re.exec(text))) {
      let y = +m[3];
      if (y < 100) y += 2000;
      const d = new Date(y, +m[2] - 1, +m[1]);
      if (d.getFullYear() !== y || d.getTime() > now || y < 2000) continue;
      return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    }
    return null;
  }

// Three numbers such that litres x price = amount, within 1.5 %:
// litres from 3 to 200, price per litre with 3 decimals from 0.80 to 3.50, amount with 2 decimals from 5 to 500.
// Returns the closest match {L, P, M, err}, or null.
  function findTriple(nums) {
    let best = null;
    const Ls = nums.filter(n => n.v >= 3 && n.v <= 200);
    const Ps = nums.filter(n => n.dec === 3 && n.v >= 0.8 && n.v <= 3.5);
    const Ms = nums.filter(n => n.dec === 2 && n.v >= 5 && n.v <= 500);
    for (const L of Ls)
      for (const P of Ps) {
        if (L === P) continue;
        for (const M of Ms) {
          if (M === L || M === P) continue;
          const err = Math.abs(L.v * P.v - M.v) / M.v;
          if (err <= 0.015 && (!best || err < best.err)) best = { L, P, M, err };
        }
      }
    return best;
  }

// First fuel type of FUELS found in the text.
  function findFuel(text) {
    for (const [name, re] of FUELS) if (re.test(text)) return name;
    return null;
  }

// Station name: a known brand (first in the first 8 lines, then anywhere, except TOTAL), otherwise the
// first of the first 3 lines that looks like a name. The town is added when a postcode is followed by a name
// ("75001 PARIS"), e.g. "Esso – 75001 PARIS".
  function findStation(text) {
    const lines = text
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length >= 3);
    let brand = null;
    const head = lines.slice(0, 8).join('\n');
    for (const [name, re] of BRANDS)
      if (re.test(head)) {
        brand = name;
        break;
      }
    if (!brand)
      for (const [name, re] of BRANDS)
        if (name !== 'TotalEnergies' && re.test(text)) {
          brand = name;
          break;
        }
    let place = null;
    const pm = text.match(/\b(\d{5})\s+([A-ZÀ-Ÿ][A-ZÀ-Ÿ' \-]{2,30})/);
    if (pm) place = pm[1] + ' ' + pm[2].replace(/\s+/g, ' ').trim();
    let name = brand;
    if (!name) {
      const l = lines
        .slice(0, 3)
        .find(x => (x.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 4 && !/\d{2}[\/.]\d{2}/.test(x));
      if (l)
        name = l
          .replace(/[^A-Za-zÀ-ÿ0-9' \-]/g, '')
          .trim()
          .slice(0, 40);
    }
    return [name, place].filter(Boolean).join(' – ');
  }

// Result: {station, date, litres, prix (price per litre), montant (amount), carburant (fuel), notes}.
// notes lists what is less reliable, shown as warnings by the app:
// - litres_calc / montant_calc / prix_calc: computed from the two other values;
// - unverified: values found by their labels, without the litres x price = amount check.
  function parseTicket(text) {
    text = String(text || '');
    const res = {
      station: findStation(text),
      date: findDate(text),
      litres: null,
      prix: null,
      montant: null,
      carburant: findFuel(text),
      notes: [],
    };
    const nums = numbers(text);
    const t = findTriple(nums);
    if (t) {
      res.litres = r2(t.L.v);
      res.prix = r3(t.P.v);
      res.montant = r2(t.M.v);
    } else {
      // Fallback: look for each value next to its label (words in the 10 languages), without the cross-check.
      const byLabel = (re, f) => {
        const c = nums.filter(n => re.test(n.line) && f(n));
        return c.length ? c : null;
      };
      const M = byLabel(
        /total|montant|payer|ttc|carte|\bcb\b|r[eè]glement|summe|betrag|importe|importo|bedrag|suma|kwota|toplam|tutar|valoare/i,
        n => n.dec === 2 && n.v >= 5 && n.v <= 500,
      );
      const L = byLabel(
        /\bL\b|litre|liter|litro|litr|volume|volumen|qt[eé]|quantit|menge|cantidad|hoeveelheid|ilo[sś][cć]/i,
        n => n.v >= 3 && n.v <= 200,
      );
      const P = nums.filter(n => n.dec === 3 && n.v >= 0.8 && n.v <= 3.5);
      if (M) res.montant = r2(Math.max(...M.map(n => n.v)));
      if (L) res.litres = r2(L[0].v);
      if (P.length === 1) res.prix = r3(P[0].v);
      if (res.montant && res.prix && !res.litres) {
        res.litres = r2(res.montant / res.prix);
        res.notes.push('litres_calc');
      }
      if (res.litres && res.prix && !res.montant) {
        res.montant = r2(res.litres * res.prix);
        res.notes.push('montant_calc');
      }
      if (res.litres && res.montant && !res.prix) {
        res.prix = r3(res.montant / res.litres);
        res.notes.push('prix_calc');
      }
      if (res.litres || res.montant) res.notes.push('unverified');
    }
    return res;
  }

// Export: window.TicketParse in the app, module.exports in Node.
  const api = { parseTicket };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TicketParse = api;
})(typeof window !== 'undefined' ? window : globalThis);

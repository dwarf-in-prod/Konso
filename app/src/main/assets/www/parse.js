/* Extraction des infos d'un ticket de station-service à partir du texte OCR.
   Aucune valeur n'est inventée : ce qui n'est pas trouvé reste null / vide. */
(function (root) {
  const FUELS = [
    ['E85', /E\s?85|ETHANOL/i],
    ['GPL', /\bGPL\b|\bLPG\b/i],
    ['SP98', /SP\s?-?\s?98|SANS\s*PLOMB\s*98|\b98\s?RON|SUPER\s?PLUS|ULTIMATE/i],
    ['SP95-E10', /E\s?-?\s?10\b/i],
    ['SP95', /SP\s?-?\s?95|SANS\s*PLOMB\s*95|\b95\s?RON|EURO\s?SUPER|UNLEADED\s*95|SUPER\s?95/i],
    ['Gazole', /GAZOLE|DIESEL|GASOIL|GASOLEO|GAS[OÓ]LEO|MOTORIN[AĂ]|MOTORYN|\bB7\b/i]
  ];
  const BRANDS = [
    ['TotalEnergies', /TOTAL\s?ENERGIES|TOTAL\s?ACCESS|\bTOTAL\b(?!\s*(?:[AÀ]\s*PAYER|TTC|HT|EUR|€|\d|:))/i],
    ['Leclerc', /LECLERC/i], ['Carrefour', /CARREFOUR/i],
    ['Intermarché', /INTERMARCH/i], ['Auchan', /AUCHAN/i],
    ['Super U', /\bSUPER\s?U\b|\bHYPER\s?U\b|SYST[EÈ]ME\s?U|\bSTATION\s?U\b/i],
    ['Esso', /\bESSO\b/i], ['Shell', /\bSHELL\b/i], ['BP', /\bBP\b/],
    ['Avia', /\bAVIA\b/i], ['Elan', /\bELAN\b/i], ['Casino', /\bCASINO\b/i],
    ['Cora', /\bCORA\b/i], ['Géant', /G[EÉ]ANT/i], ['Netto', /\bNETTO\b/i],
    ['Eni', /\bENI\b|\bAGIP\b/i], ['Dyneff', /DYNEFF/i], ['Vito', /\bVITO\b/i],
    ['Lidl', /\bLIDL\b/i], ['Aldi', /\bALDI\b/i], ['Costco', /COSTCO/i],
    ['Intermarché Contact', /INTERMARCH[EÉ]\s*CONTACT/i]
  ];
  const r2 = (n) => Math.round(n * 100) / 100;
  const r3 = (n) => Math.round(n * 1000) / 1000;

  function numbers(text) {
    const out = [];
    const re = /(\d{1,4})\s?[.,]\s?(\d{2,3})(?!\d)/g;
    let m;
    const lines = text.split('\n');
    let pos = 0;
    const starts = lines.map((l) => { const s = pos; pos += l.length + 1; return s; });
    while ((m = re.exec(text))) {
      let li = 0;
      for (let i = 0; i < starts.length; i++) if (starts[i] <= m.index) li = i;
      out.push({ v: parseFloat(m[1] + '.' + m[2]), dec: m[2].length, line: lines[li] || '', li });
    }
    return out;
  }

  function findDate(text) {
    const re = /\b(0?[1-9]|[12]\d|3[01])\s?[\/.\-]\s?(0?[1-9]|1[0-2])\s?[\/.\-]\s?(\d{4}|\d{2})\b/g;
    let m;
    const now = Date.now() + 86400000;
    while ((m = re.exec(text))) {
      let y = +m[3]; if (y < 100) y += 2000;
      const d = new Date(y, +m[2] - 1, +m[1]);
      if (d.getFullYear() !== y || d.getTime() > now || y < 2000) continue;
      return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    }
    return null;
  }

  function findTriple(nums) {
    let best = null;
    const Ls = nums.filter((n) => n.v >= 3 && n.v <= 200);
    const Ps = nums.filter((n) => n.dec === 3 && n.v >= 0.8 && n.v <= 3.5);
    const Ms = nums.filter((n) => n.dec === 2 && n.v >= 5 && n.v <= 500);
    for (const L of Ls) for (const P of Ps) {
      if (L === P) continue;
      for (const M of Ms) {
        if (M === L || M === P) continue;
        const err = Math.abs(L.v * P.v - M.v) / M.v;
        if (err <= 0.015 && (!best || err < best.err)) best = { L, P, M, err };
      }
    }
    return best;
  }

  function findFuel(text) {
    for (const [name, re] of FUELS) if (re.test(text)) return name;
    return null;
  }

  function findStation(text) {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length >= 3);
    let brand = null;
    const head = lines.slice(0, 8).join('\n');
    for (const [name, re] of BRANDS) if (re.test(head)) { brand = name; break; }
    if (!brand) for (const [name, re] of BRANDS) if (name !== 'TotalEnergies' && re.test(text)) { brand = name; break; }
    let place = null;
    const pm = text.match(/\b(\d{5})\s+([A-ZÀ-Ÿ][A-ZÀ-Ÿ' \-]{2,30})/);
    if (pm) place = pm[1] + ' ' + pm[2].replace(/\s+/g, ' ').trim();
    let name = brand;
    if (!name) {
      const l = lines.slice(0, 3).find((x) => (x.match(/[A-Za-zÀ-ÿ]/g) || []).length >= 4 && !/\d{2}[\/.]\d{2}/.test(x));
      if (l) name = l.replace(/[^A-Za-zÀ-ÿ0-9' \-]/g, '').trim().slice(0, 40);
    }
    return [name, place].filter(Boolean).join(' – ');
  }

  function parseTicket(text) {
    text = String(text || '');
    const res = { station: findStation(text), date: findDate(text), litres: null, prix: null, montant: null, carburant: findFuel(text), notes: [] };
    const nums = numbers(text);
    const t = findTriple(nums);
    if (t) {
      res.litres = r2(t.L.v); res.prix = r3(t.P.v); res.montant = r2(t.M.v);
    } else {
      // repli : lecture par mots-clés, sans cohérence vérifiée
      const byLabel = (re, f) => { const c = nums.filter((n) => re.test(n.line) && f(n)); return c.length ? c : null; };
      const M = byLabel(/total|montant|payer|ttc|carte|\bcb\b|r[eè]glement|summe|betrag|importe|importo|bedrag|suma|kwota|toplam|tutar|valoare/i, (n) => n.dec === 2 && n.v >= 5 && n.v <= 500);
      const L = byLabel(/\bL\b|litre|liter|litro|litr|volume|volumen|qt[eé]|quantit|menge|cantidad|hoeveelheid|ilo[sś][cć]/i, (n) => n.v >= 3 && n.v <= 200);
      const P = nums.filter((n) => n.dec === 3 && n.v >= 0.8 && n.v <= 3.5);
      if (M) res.montant = r2(Math.max(...M.map((n) => n.v)));
      if (L) res.litres = r2(L[0].v);
      if (P.length === 1) res.prix = r3(P[0].v);
      if (res.montant && res.prix && !res.litres) { res.litres = r2(res.montant / res.prix); res.notes.push('litres_calc'); }
      if (res.litres && res.prix && !res.montant) { res.montant = r2(res.litres * res.prix); res.notes.push('montant_calc'); }
      if (res.litres && res.montant && !res.prix) { res.prix = r3(res.montant / res.litres); res.notes.push('prix_calc'); }
      if (res.litres || res.montant) res.notes.push('unverified');
    }
    return res;
  }

  const api = { parseTicket };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TicketParse = api;
})(typeof window !== 'undefined' ? window : globalThis);

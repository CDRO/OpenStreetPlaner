// QR-Code-Encoder ohne Bibliothek: Byte-Modus, Fehlerkorrektur M, Versionen 1–10
// (bis 216 Bytes, reicht für Links). Reed-Solomon über GF(256), Masken mit
// Bewertung nach ISO/IEC 18004. Liefert eine Matrix aus 0/1.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generatorpolynom für n EC-Codewörter (Koeffizienten, höchster Grad zuerst). */
export function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= mul(g[j], EXP[i]);
    }
    g = next;
  }
  return g;
}

/** EC-Codewörter zu einem Datenblock. */
export function rsEncode(data, ecCount) {
  const gen = rsGenerator(ecCount);
  const rest = new Array(ecCount).fill(0);
  for (const d of data) {
    const factor = d ^ rest[0];
    rest.shift();
    rest.push(0);
    if (factor === 0) continue;
    for (let j = 0; j < ecCount; j++) rest[j] ^= mul(gen[j + 1], factor);
  }
  return rest;
}

// Version (Index 1–10), Fehlerkorrektur M: Gesamt-Codewörter, EC je Block, Blöcke [Anzahl, Datenwörter]
const VERSIONS = [null,
  { total: 26, ec: 10, blocks: [[1, 16]] },
  { total: 44, ec: 16, blocks: [[1, 28]] },
  { total: 70, ec: 26, blocks: [[1, 44]] },
  { total: 100, ec: 18, blocks: [[2, 32]] },
  { total: 134, ec: 24, blocks: [[2, 43]] },
  { total: 172, ec: 16, blocks: [[4, 27]] },
  { total: 196, ec: 18, blocks: [[4, 31]] },
  { total: 242, ec: 22, blocks: [[2, 38], [2, 39]] },
  { total: 292, ec: 22, blocks: [[3, 36], [2, 37]] },
  { total: 346, ec: 26, blocks: [[4, 43], [1, 44]] },
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 52]];

export function dataCapacity(version) {
  return VERSIONS[version].blocks.reduce((s, [n, d]) => s + n * d, 0);
}

/** BCH(15,5)-Formatbits für Fehlerkorrektur M (00) und Maske; mit 0x5412 maskiert. */
export function formatBits(mask, level = 'M') {
  const lv = { L: 1, M: 0, Q: 3, H: 2 }[level];
  const data = (lv << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-Bit-Versionsinformation (ab Version 7), Golay-BCH mit 0x1f25. */
export function versionBits(version) {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) if (rem & (1 << i)) rem ^= 0x1f25 << (i - 12);
  return (version << 12) | rem;
}

function bytesOf(text) {
  return Array.from(new TextEncoder().encode(text));
}

/** Datencodewörter: Modus 0100, Länge (8 oder 16 Bit), Bytes, Terminator, Auffüllung. */
export function encodeData(bytes, version) {
  const cap = dataCapacity(version);
  const bits = [];
  const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);
  const max = cap * 8;
  push(0, Math.min(4, max - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const pads = [0xec, 0x11];
  for (let i = 0; out.length < cap; i++) out.push(pads[i % 2]);
  return out;
}

/** Datenblöcke mit EC-Wörtern verschachteln (Daten spaltenweise, dann EC). */
export function interleave(data, version) {
  const v = VERSIONS[version];
  const blocks = [];
  let pos = 0;
  for (const [count, size] of v.blocks) {
    for (let i = 0; i < count; i++) {
      const d = data.slice(pos, pos + size);
      pos += size;
      blocks.push({ d, e: rsEncode(d, v.ec) });
    }
  }
  const out = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < v.ec; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

/** Kleinste Version, in die die Bytes passen (1–10), sonst null. */
export function chooseVersion(byteCount) {
  for (let v = 1; v <= 10; v++) {
    const header = 4 + (v >= 10 ? 16 : 8);
    if (byteCount * 8 + header <= dataCapacity(v) * 8) return v;
  }
  return null;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Strafpunkte einer Matrix (Regeln 1–4 der Norm). */
export function penalty(m) {
  const n = m.length;
  let score = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        const cur = pass ? m[j][i] : m[i][j];
        const prev = pass ? m[j - 1][i] : m[i][j - 1];
        if (cur === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const v = m[i][j];
    if (v === m[i][j + 1] && v === m[i + 1][j] && v === m[i + 1][j + 1]) score += 3;
  }
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let i = 0; i < n; i++) for (let j = 0; j <= n - 11; j++) {
    let a = true;
    let b = true;
    let c = true;
    let d = true;
    for (let k = 0; k < 11; k++) {
      if (m[i][j + k] !== p1[k]) a = false;
      if (m[i][j + k] !== p2[k]) b = false;
      if (m[j + k][i] !== p1[k]) c = false;
      if (m[j + k][i] !== p2[k]) d = false;
    }
    score += (a + b + c + d) * 40;
  }
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const pct = (dark * 100) / (n * n);
  const k = Math.floor(Math.abs(pct - 50) / 5);
  score += k * 10;
  return score;
}

/** Erzeugt die Matrix (Array von Zeilen mit 0/1) für einen Text; { version, size, matrix, mask }. */
export function encodeQR(text, { level = 'M' } = {}) {
  if (level !== 'M') throw new Error('Nur Fehlerkorrektur M');
  const bytes = bytesOf(text);
  const version = chooseVersion(bytes.length);
  if (!version) throw new Error(`Text zu lang für QR-Code (max. ${dataCapacity(10) - 3} Bytes)`);
  const n = version * 4 + 17;
  const codewords = interleave(encodeData(bytes, version), version);
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  const reserved = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, v) => { matrix[r][c] = v; reserved[r][c] = true; };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
      const rr = r0 + r;
      const cc = c0 + c;
      if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
      const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
      set(rr, cc, on ? 1 : 0);
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (const r of ALIGN[version]) for (const c of ALIGN[version]) {
    if (reserved[r][c]) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
      set(r + dr, c + dc, on ? 1 : 0);
    }
  }
  for (let i = 8; i < n - 8; i++) {
    if (!reserved[6][i]) set(6, i, i % 2 === 0 ? 1 : 0);
    if (!reserved[i][6]) set(i, 6, i % 2 === 0 ? 1 : 0);
  }
  set(n - 8, 8, 1); // dunkles Modul
  // Formatbereiche reservieren
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][n - 1 - i] = true;
    reserved[n - 1 - i][8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
      reserved[i][n - 11 + j] = true;
      reserved[n - 11 + j][i] = true;
    }
  }
  // Daten im Zickzack von rechts unten
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
  let bi = 0;
  let upward = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) {
      const r = upward ? n - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (reserved[r][c]) continue;
        matrix[r][c] = bi < bits.length ? bits[bi] : 0;
        bi++;
      }
    }
    upward = !upward;
  }
  // Maske wählen
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = matrix.map((row) => row.slice());
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!reserved[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
    placeFormat(m, n, formatBits(mask, level));
    if (version >= 7) placeVersion(m, n, versionBits(version));
    const score = penalty(m);
    if (!best || score < best.score) best = { score, m, mask };
  }
  return { version, size: n, matrix: best.m, mask: best.mask };
}

function placeFormat(m, n, bits) {
  const bit = (i) => (bits >> i) & 1;
  // Kopie 1: um den Finder oben links
  const left = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  for (let i = 0; i < 15; i++) m[left[i][0]][left[i][1]] = bit(14 - i);
  // Kopie 2: unten links (Spalte 8) und oben rechts (Zeile 8)
  for (let i = 0; i < 7; i++) m[n - 1 - i][8] = bit(14 - i);
  for (let i = 7; i < 15; i++) m[8][n - 15 + i] = bit(14 - i);
}

function placeVersion(m, n, bits) {
  for (let i = 0; i < 18; i++) {
    const v = (bits >> i) & 1;
    m[Math.floor(i / 3)][n - 11 + (i % 3)] = v;
    m[n - 11 + (i % 3)][Math.floor(i / 3)] = v;
  }
}

/** Zeichnet die Matrix in ein Canvas-Kontext: Modulgrösse px, Ruhezone 4 Module. */
export function drawQR(ctx, matrix, x, y, moduleSize, { dark = '#000', light = '#fff', quiet = 4 } = {}) {
  const n = matrix.length;
  const total = (n + 2 * quiet) * moduleSize;
  ctx.fillStyle = light;
  ctx.fillRect(x, y, total, total);
  ctx.fillStyle = dark;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (matrix[r][c]) ctx.fillRect(x + (c + quiet) * moduleSize, y + (r + quiet) * moduleSize, moduleSize, moduleSize);
  }
  return total;
}

/** SVG-Markup eines QR-Codes (für HTML-Dialoge ohne Canvas). */
export function qrSvg(text, { size = 160 } = {}) {
  const { matrix, size: n } = encodeQR(text);
  const quiet = 4;
  const total = n + 2 * quiet;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (matrix[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

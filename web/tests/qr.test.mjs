import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQR, rsEncode, rsGenerator, formatBits, versionBits, encodeData, chooseVersion, dataCapacity, interleave, penalty, qrSvg } from '../js/qr.js';

// GF(256)-Hilfen für die Prüfung: Polynomauswertung an den Nullstellen des Generators
const EXP = [];
const LOG = [];
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
})();
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255]);
const evalAt = (poly, x) => poly.reduce((acc, c) => mul(acc, x) ^ c, 0);

test('Reed-Solomon: Codewort hat Nullstellen an α^0..α^(n-1); Generator für 10 EC stimmt mit der Norm überein', () => {
  const g = rsGenerator(10).map((c) => (c ? LOG[c] : null));
  assert.deepEqual(g, [0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45], 'Exponenten des Generatorpolynoms (ISO 18004, Tabelle A.1)');
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]; // "HELLO WORLD" alphanumerisch, 1-M
  const ec = rsEncode(data, 10);
  assert.deepEqual(ec, [196, 35, 39, 119, 235, 215, 231, 226, 93, 23], 'bekannte EC-Wörter für HELLO WORLD');
  const codeword = data.concat(ec);
  for (let i = 0; i < 10; i++) assert.equal(evalAt(codeword, EXP[i]), 0, `Nullstelle α^${i}`);
});

test('Format- und Versionsbits entsprechen der Norm', () => {
  assert.equal(formatBits(0, 'M'), 0b101010000010010);
  assert.equal(formatBits(0, 'L'), 0b111011111000100);
  assert.equal(formatBits(4, 'M'), 0b100010111111001);
  assert.equal(formatBits(5, 'M'), 0b100000011001110);
  assert.equal(versionBits(7), 0b000111110010010100);
  assert.equal(versionBits(10), 0b001010010011010011);
});

test('Datencodierung: Modus, Länge, Terminator, Auffüllung; Versionswahl; Verschachtelung', () => {
  const d = encodeData([0x48, 0x69], 1); // "Hi"
  assert.equal(d.length, 16);
  assert.deepEqual(d.slice(0, 4), [0x40, 0x24, 0x86, 0x90], '0100 00000010 01001000 01101001 0000 -> 40 24 86 90');
  assert.deepEqual(d.slice(4, 8), [0xec, 0x11, 0xec, 0x11]);
  assert.equal(chooseVersion(10), 1);
  assert.equal(chooseVersion(17), 2);
  assert.equal(chooseVersion(100), 6);
  assert.equal(chooseVersion(213), 10);
  assert.equal(chooseVersion(214), null, '16-Bit-Länge ab Version 10');
  assert.equal(dataCapacity(8), 154);
  const il = interleave(encodeData(new Array(60).fill(1), 4), 4);
  assert.equal(il.length, 100);
});

test('encodeQR: Grösse, Finder, Timing, dunkles Modul, Maske mit kleinster Strafe, Determinismus', () => {
  const url = 'https://example.org/d/abc123?present=1';
  const { version, size, matrix, mask } = encodeQR(url);
  assert.equal(version, 3);
  assert.equal(size, 29);
  assert.equal(matrix.length, 29);
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const on = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      assert.equal(matrix[r0 + r][c0 + c], on ? 1 : 0, `Finder bei ${r0},${c0}`);
    }
  };
  finder(0, 0);
  finder(0, 22);
  finder(22, 0);
  for (let i = 8; i < 21; i++) {
    assert.equal(matrix[6][i], i % 2 === 0 ? 1 : 0, 'Timing horizontal');
    assert.equal(matrix[i][6], i % 2 === 0 ? 1 : 0, 'Timing vertikal');
  }
  assert.equal(matrix[21][8], 1, 'dunkles Modul');
  assert.ok(mask >= 0 && mask < 8);
  // Formatinformation lesbar: Kopie 1 um den Finder oben links
  const bits = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]].map(([r, c]) => matrix[r][c]);
  assert.equal(parseInt(bits.join(''), 2), formatBits(mask, 'M'));
  assert.deepEqual(encodeQR(url).matrix, matrix, 'deterministisch');
  const big = encodeQR('x'.repeat(200));
  assert.equal(big.version, 10);
  assert.equal(big.size, 57);
  assert.throws(() => encodeQR('x'.repeat(300)));
  assert.ok(penalty(matrix) < penalty(Array.from({ length: 29 }, () => new Array(29).fill(1))));
  const svg = qrSvg(url, { size: 120 });
  assert.ok(svg.startsWith('<svg') && svg.includes('viewBox="0 0 37 37"') && svg.includes('width="120"'));
});

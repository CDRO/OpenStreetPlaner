import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dictionary, detectLanguage, getLanguage, setLanguage, t, tn, LANGUAGES } from '../js/i18n.js';
import { extractKeys } from './i18n-keys.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const placeholders = (s) => (s.match(/\{[a-z]+\}/g) || []).sort().join(',');

test('t() ersetzt Platzhalter, fällt auf Deutsch zurück, tn() wählt Singular/Plural', () => {
  setLanguage('de');
  assert.equal(t('Speichern'), 'Speichern');
  assert.equal(t('{n} Punkte', { n: 3 }), '3 Punkte');
  assert.equal(tn(1, '{n} Punkt', '{n} Punkte'), '1 Punkt');
  assert.equal(tn(2, '{n} Punkt', '{n} Punkte'), '2 Punkte');
  setLanguage('fr');
  assert.equal(getLanguage(), 'fr');
  assert.equal(t('Speichern'), 'Enregistrer');
  assert.equal(t('Schlüssel ohne Übersetzung'), 'Schlüssel ohne Übersetzung', 'Rückfall auf den deutschen Text');
  setLanguage('it');
  assert.equal(t('Speichern'), 'Salva');
  setLanguage('xx');
  assert.equal(getLanguage(), 'de');
  assert.equal(detectLanguage('fr-CH'), 'fr');
  assert.equal(detectLanguage('it'), 'it');
  assert.equal(detectLanguage('en-US'), 'de');
  assert.deepEqual(LANGUAGES.map((l) => l.id), ['de', 'fr', 'it']);
});

test('Wörterbücher decken alle Schlüssel im Quelltext ab, Platzhalter stimmen überein', () => {
  const keys = extractKeys(root);
  assert.ok(keys.length > 500, `${keys.length} Schlüssel gefunden`);
  for (const lang of ['fr', 'it']) {
    const dict = dictionary(lang);
    const missing = keys.filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${lang}: fehlende Übersetzungen`);
    const badPlaceholders = keys.filter((k) => placeholders(k) !== placeholders(dict[k]));
    assert.deepEqual(badPlaceholders, [], `${lang}: Platzhalter weichen ab`);
    const empty = keys.filter((k) => !String(dict[k]).trim());
    assert.deepEqual(empty, [], `${lang}: leere Übersetzungen`);
    const stale = Object.keys(dict).filter((k) => !keys.includes(k));
    assert.deepEqual(stale, [], `${lang}: verwaiste Einträge`);
  }
});

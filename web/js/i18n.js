// Mehrsprachigkeit ohne Bibliothek: Deutsch ist die Quellsprache und zugleich
// der Schlüssel; fr/it liegen in web/js/lang/. Platzhalter {name} werden ersetzt.
// Fehlende Übersetzungen fallen auf Deutsch zurück (ein Test prüft die Abdeckung).

import { fr } from './lang/fr.js';
import { it } from './lang/it.js';

export const LANGUAGES = [
  { id: 'de', label: 'Deutsch', locale: 'de-CH' },
  { id: 'fr', label: 'Français', locale: 'fr-CH' },
  { id: 'it', label: 'Italiano', locale: 'it-CH' },
];

const DICTS = { de: null, fr, it };
let current = 'de';
const listeners = new Set();

/** Sprache aus dem Browser ableiten (de/fr/it), sonst Deutsch. */
export function detectLanguage(navLang = typeof navigator !== 'undefined' ? navigator.language : 'de') {
  const short = String(navLang || 'de').slice(0, 2).toLowerCase();
  return LANGUAGES.some((l) => l.id === short) ? short : 'de';
}

export function getLanguage() {
  return current;
}

export function locale() {
  return (LANGUAGES.find((l) => l.id === current) || LANGUAGES[0]).locale;
}

export function setLanguage(id) {
  const next = LANGUAGES.some((l) => l.id === id) ? id : 'de';
  if (next === current) return;
  current = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  for (const fn of listeners) fn(next);
}

export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Übersetzt einen deutschen Text; params ersetzen {platzhalter}. */
export function t(text, params = null) {
  if (text === null || text === undefined) return '';
  const dict = DICTS[current];
  let out = dict && Object.prototype.hasOwnProperty.call(dict, text) ? dict[text] : text;
  if (params) for (const [k, v] of Object.entries(params)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

/** Plural-Hilfe: t('{n} Punkt', ...) oder t('{n} Punkte', ...) je nach n. */
export function tn(n, singular, plural, params = {}) {
  return t(n === 1 ? singular : plural, { n, ...params });
}

/** Statische Texte im Dokument: data-i18n (Text), data-i18n-html, data-i18n-title, data-i18n-placeholder. */
export function applyStatic(root = typeof document !== 'undefined' ? document : null) {
  if (!root) return;
  const remember = (el, attr, read) => {
    const key = el.getAttribute(attr) || read();
    if (!el.getAttribute(attr)) el.setAttribute(attr, key);
    return key;
  };
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = remember(el, 'data-i18n-key', () => el.textContent.trim());
    el.textContent = t(key);
  });
  root.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = remember(el, 'data-i18n-key', () => el.innerHTML.trim());
    el.innerHTML = t(key);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = remember(el, 'data-i18n-title-key', () => el.getAttribute('title') || '');
    el.setAttribute('title', t(key));
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', t(key));
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = remember(el, 'data-i18n-placeholder-key', () => el.getAttribute('placeholder') || '');
    el.setAttribute('placeholder', t(key));
  });
}

/** Alle Schlüssel eines Wörterbuchs (für Tests). */
export function dictionary(id) {
  return DICTS[id] || {};
}

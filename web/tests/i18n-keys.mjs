// Sammelt alle übersetzbaren deutschen Schlüssel aus dem Quelltext (für den Abdeckungstest
// und zum Pflegen der Wörterbücher). Keine Abhängigkeiten.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\');

export function extractKeys(root) {
  const keys = new Set();
  const add = (k) => { if (k && k.trim()) keys.add(unescape(k)); };
  const jsDir = join(root, 'web', 'js');
  const files = readdirSync(jsDir).filter((f) => f.endsWith('.js') && f !== 'i18n.js').map((f) => join(jsDir, f));
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const name = file.split('/').pop();
    for (const m of src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) add(m[1]);
    for (const m of src.matchAll(/\btn\(\s*[^,()]+,\s*'((?:[^'\\]|\\.)*)'\s*,\s*'((?:[^'\\]|\\.)*)'/g)) { add(m[1]); add(m[2]); }
    for (const m of src.matchAll(/\bt\(\{([^}]*)\}/g)) for (const v of m[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) add(v[1]);
    for (const m of src.matchAll(/\[\['[a-z]+', '([^']+)'\](?:, \['[a-z]+', '([^']+)'\])*/g)) {
      for (const v of m[0].matchAll(/, '([^']+)'\]/g)) add(v[1]);
    }
    // Rückgängig-Beschriftungen und Listen-Labels
    for (const m of src.matchAll(/\b(?:commit|patch|commitDoc)\('((?:[^'\\]|\\.)*)'/g)) add(m[1]);
    for (const m of src.matchAll(/patch(?:Layer|BusLine|Feature|Phase)\([^,]+, '((?:[^'\\]|\\.)*)'/g)) add(m[1]);
    for (const m of src.matchAll(/patchLayer\([^,]+, visible \? '([^']*)' : '([^']*)'/g)) { add(m[1]); add(m[2]); }
    for (const m of src.matchAll(/\b(?:commit|commitDoc)\([^'\n]*\? '([^']*)' : '([^']*)'/g)) { add(m[1]); add(m[2]); }
    if (['model.js', 'costs.js', 'tools.js', 'export.js', 'confidence.js'].includes(name)) {
      for (const m of src.matchAll(/\b(?:label|hint|group):\s*'((?:[^'\\]|\\.)*)'/g)) add(m[1]);
    }
    if (name === 'export.js') for (const m of src.matchAll(/\b(?:new|existing|remove):\s*'([^']+)'/g)) add(m[1]);
    if (name === 'diff.js') {
      const block = /const FIELD_LABELS = \{([\s\S]*?)\};/.exec(src);
      if (block) for (const m of block[1].matchAll(/:\s*'([^']+)'/g)) add(m[1]);
    }
    if (name === 'routing.js') for (const m of src.matchAll(/'((?:Start|Ziel|Keine Verbindung|Der Ursprung)[^']*)'/g)) add(m[1]);
    // Beschriftungs-Tabellen (RACE_LABELS, RACE_MODE_LABELS …) und Fortschrittsmeldungen trackProgress(id, 'Label', …)
    for (const m of src.matchAll(/const [A-Z_]*_LABELS = \{([^}]*)\}/g)) for (const v of m[1].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) add(v[1]);
    for (const m of src.matchAll(/trackProgress\('[a-z]+', '((?:[^'\\]|\\.)*)'/g)) add(m[1]);
    if (name === 'app.js') for (const m of src.matchAll(/\{ road: '([^']+)', junction: '([^']+)', roundabout: '([^']+)'(?:, zone: '([^']+)')? \}/g)) m.slice(1).forEach(add);
    if (name === 'ui.js') for (const m of src.matchAll(/\['(?:left|straight|right|uturn)', '([^']+)'\]/g)) add(m[1]);
  }
  const html = readFileSync(join(root, 'web', 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:="")?>([^<]+)</g)) add(m[1].trim());
  for (const m of html.matchAll(/data-i18n-html>([\s\S]*?)<\/(?:li|summary|span|p)>/g)) add(m[1].trim());
  for (const m of html.matchAll(/title="([^"]+)"[^>]*data-i18n-title/g)) add(m[1]);
  for (const m of html.matchAll(/placeholder="([^"]+)"[^>]*data-i18n-placeholder/g)) add(m[1]);
  return Array.from(keys).sort((a, b) => a.localeCompare(b, 'de'));
}

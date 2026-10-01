// Browser-lokaler Zustand: Liste der eigenen Entwürfe (mit Bearbeitungs-Token),
// Arbeitskopie und Einstellungen. Der Entwurfsinhalt selbst liegt auf dem Server.

const KEY_INDEX = 'stadtplaner.drafts';
const KEY_WORKING = 'stadtplaner.working';
const KEY_SETTINGS = 'stadtplaner.settings';
const KEY_COMMENT_TOKENS = 'stadtplaner.commentTokens';
const KEY_CLIENT_ID = 'stadtplaner.clientId';
const KEY_PUSH = 'stadtplaner.push'; // Entwurfs-ID -> { role, threads }

export const DEFAULT_SETTINGS = {
  snapEnabled: true,
  snapModifier: 'Shift', // Taste, die das Einrasten für die aktuelle Aktion aufhebt
  snapOsm: true,
  showOsm: false,
  snapTolerance: 14,
  showComments: true,
  author: '', // Name für Kommentare
  basemap: 'osm',
  overlays: [], // IDs eingeschalteter Kachel-Overlays (z. B. Parzellen)
  speedModel: 'limit',
  exposureRadius: 50, // Umkreis für betroffene Gebäude (m)
  reportConfidence: true, // Zuversicht im PDF-Bericht ausweisen
  theme: 'system', // 'system' | 'light' | 'dark'
  language: '', // leer = aus dem Browser ableiten (de/fr/it) // 'limit' = Tempolimit, 'geometry' = Kurven, Steigung, Streuung
};

export class LocalState {
  constructor(backend) {
    this.backend = backend || safeLocalStorage();
  }

  readJson(key, fallback) {
    try {
      const raw = this.backend.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  writeJson(key, value) {
    try {
      this.backend.setItem(key, JSON.stringify(value));
    } catch {
      // Speicher voll oder gesperrt: still ignorieren, die Server-Kopie ist massgebend.
    }
  }

  /** Eigene Entwürfe, zuletzt geändert zuerst. */
  listDrafts() {
    const index = this.readJson(KEY_INDEX, []);
    return index.slice().reverse().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }

  getDraft(id) {
    return this.readJson(KEY_INDEX, []).find((d) => d.id === id) || null;
  }

  rememberDraft({ id, name, token, updatedAt }) {
    const index = this.readJson(KEY_INDEX, []).filter((d) => d.id !== id);
    const previous = this.getDraft(id);
    index.push({
      id,
      name: name || (previous && previous.name) || 'Entwurf',
      token: token || (previous && previous.token) || null,
      updatedAt: updatedAt || new Date().toISOString(),
    });
    this.writeJson(KEY_INDEX, index);
  }

  forgetDraft(id) {
    this.writeJson(KEY_INDEX, this.readJson(KEY_INDEX, []).filter((d) => d.id !== id));
  }

  tokenFor(id) {
    const d = this.getDraft(id);
    return d && d.token ? d.token : null;
  }

  saveWorking(working) {
    this.writeJson(KEY_WORKING, working);
  }

  loadWorking() {
    return this.readJson(KEY_WORKING, null);
  }

  clearWorking() {
    try {
      this.backend.removeItem(KEY_WORKING);
    } catch {
      // siehe writeJson
    }
  }

  /** Lösch-Token eigener Kommentare (Kommentar-ID -> Token). */
  rememberCommentToken(cid, token) {
    const map = this.readJson(KEY_COMMENT_TOKENS, {});
    map[cid] = token;
    const keys = Object.keys(map);
    if (keys.length > 500) delete map[keys[0]];
    this.writeJson(KEY_COMMENT_TOKENS, map);
  }

  commentToken(cid) {
    return this.readJson(KEY_COMMENT_TOKENS, {})[cid] || null;
  }

  /** Zufällige Kennung dieses Browsers (für Push-Abonnements und eigene Kommentare). */
  clientId() {
    let id = null;
    try {
      id = this.backend.getItem(KEY_CLIENT_ID);
    } catch {
      id = null;
    }
    if (!id) {
      const bytes = new Uint8Array(12);
      (globalThis.crypto || {}).getRandomValues ? globalThis.crypto.getRandomValues(bytes) : bytes.forEach((_, i) => { bytes[i] = Math.floor(Math.random() * 256); });
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      try {
        this.backend.setItem(KEY_CLIENT_ID, id);
      } catch {
        // egal
      }
    }
    return id;
  }

  /** Meine Kommentar-IDs (Hauptkommentare), für Antwort-Benachrichtigungen. */
  ownCommentIds() {
    return Object.keys(this.readJson(KEY_COMMENT_TOKENS, {}));
  }

  pushState(draftId) {
    return this.readJson(KEY_PUSH, {})[draftId] || null;
  }

  setPushState(draftId, state) {
    const all = this.readJson(KEY_PUSH, {});
    if (state) all[draftId] = state;
    else delete all[draftId];
    this.writeJson(KEY_PUSH, all);
  }

  loadSettings() {
    return { ...DEFAULT_SETTINGS, ...this.readJson(KEY_SETTINGS, {}) };
  }

  saveSettings(settings) {
    this.writeJson(KEY_SETTINGS, settings);
  }
}

/** Minimaler In-Memory-Ersatz für localStorage (Tests, gesperrter Speicher). */
export class MemoryBackend {
  constructor() {
    this.map = new Map();
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null;
  }
  setItem(k, v) {
    this.map.set(k, String(v));
  }
  removeItem(k) {
    this.map.delete(k);
  }
}

function safeLocalStorage() {
  try {
    const probe = '__stadtplaner_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return new MemoryBackend();
  }
}

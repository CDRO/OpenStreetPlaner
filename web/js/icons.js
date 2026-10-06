// Eigenes Symbolset als Inline-SVG (24×24, Strich in currentColor), ohne Fremdbibliothek.
// icon('road') liefert das Markup; mountIcons(root) füllt Elemente mit data-icon="…".

const PATHS = {
  // Werkzeuge
  select: 'M5 3l14 9-7 1.5L9 21z',
  road: 'M6 21 9 3M18 21l-3-18M12 8v2M12 13v2M12 18v2',
  junction: 'M12 3v6M12 15v6M3 12h6M15 12h6M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  zone: 'M4 9l8-5 8 5-3 9H7z',
  roundabout: 'M12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM12 2v4M12 18v4M2 12h4M18 12h4',
  adopt: 'M12 3v12M7 10l5 5 5-5M4 17v3h16v-3',
  route: 'M4 19h4a4 4 0 0 0 4-4V9a4 4 0 0 1 4-4h4M4 19a1.5 1.5 0 1 0 0-.01M20 5a1.5 1.5 0 1 0 0-.01',
  measure: 'M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  comment: 'M12 21s6-5.5 6-10a6 6 0 1 0-12 0c0 4.5 6 10 6 10zM12 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  // Kopfzeile und Reiter
  menu: 'M4 7h16M4 12h16M4 17h16',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  locate: 'M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM12 2v3M12 19v3M2 12h3M19 12h3M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  share: 'M4 12v8h16v-8M12 16V3M8 7l4-4 4 4',
  settings: 'M3 6h9M16 6h5M3 12h3M10 12h11M3 18h11M18 18h3M14 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM8 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM16 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.5-4.5',
  more: 'M5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2zM19 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'm6 9 6 6 6-6',
  draw: 'M4 20l4-1L19 8l-3-3L5 16zM13 6l3 3',
  layers: 'm12 3 9 5-9 5-9-5zM3 12.5l9 5 9-5M3 17l9 5 9-5',
  drafts: 'M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  history: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  comments: 'M4 5h16v11H9l-5 4z',
  analysis: 'M4 20v-8M10 20V5M16 20v-6M2 20h20',
  // Karte
  map: 'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2zM9 3v16M15 5v16',
  network: 'M3 9h18M3 15h18M9 3v18M15 3v18',
  fullscreen: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  legend: 'M8 6h12M8 12h12M8 18h12M3 5h2v2H3zM3 11h2v2H3zM3 17h2v2H3z',
  'zoom-in': 'M12 5v14M5 12h14',
  'zoom-out': 'M5 12h14',
  // Allgemein
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  check: 'm5 12 5 5L20 7',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8h.01M12 11v6',
  copy: 'M8 8h12v12H8zM16 8V4H4v12h4',
  mail: 'M3 5h18v14H3zM3 5l9 7 9-7',
  download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  upload: 'M12 21V9M7 14l5-5 5 5M4 4h16',
  file: 'M6 2h8l5 5v15H6zM14 2v5h5',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M16 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  warning: 'M12 3 2 21h20zM12 10v5M12 18h.01',
  plus: 'M12 5v14M5 12h14',
  external: 'M14 4h6v6M20 4l-9 9M19 14v6H4V5h6',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  play: 'M7 5v14l12-7z',
  pin: 'M12 21s6-5.5 6-10a6 6 0 1 0-12 0c0 4.5 6 10 6 10zM12 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  keyboard: 'M3 7h18v10H3zM6 10h1M9 10h1M12 10h1M15 10h1M18 10h0M6 13h1M9 13h1M12 13h1M15 13h1M18 13h0M8 16h8',
  'arrow-right': 'M5 12h14M13 6l6 6-6 6',
  hand: 'M9 11V5a1.5 1.5 0 0 1 3 0v6M12 11V4a1.5 1.5 0 0 1 3 0v7M15 11V6a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1.5 1.5 0 0 1 2.5-1.5L9 13',
};

/** Inline-SVG für ein Symbol; unbekannte Namen geben einen leeren String. */
export function icon(name, { size = 18, cls = '' } = {}) {
  const d = PATHS[name];
  if (!d) return '';
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
}

/** Füllt alle Elemente mit data-icon im Teilbaum (einmalig; das Attribut bleibt für erneute Aufrufe). */
export function mountIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconMounted === el.dataset.icon) return;
    el.innerHTML = icon(el.dataset.icon, { size: Number(el.dataset.iconSize) || 18 });
    el.dataset.iconMounted = el.dataset.icon;
  });
}

export const ICON_NAMES = Object.keys(PATHS);

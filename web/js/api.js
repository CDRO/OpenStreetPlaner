// Zugriff auf das Go-Backend.

async function request(method, url, { body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['X-Edit-Token'] = token;
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error('Server nicht erreichbar');
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Fehler ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  createDraft: (doc, label) => request('POST', '/api/drafts', { body: { doc, label } }),
  getDraft: (id) => request('GET', `/api/drafts/${encodeURIComponent(id)}`),
  saveDraft: (id, token, doc, label) => request('PUT', `/api/drafts/${encodeURIComponent(id)}`, { body: { doc, label }, token }),
  deleteDraft: (id, token) => request('DELETE', `/api/drafts/${encodeURIComponent(id)}`, { token }),
  authDraft: (id, token) => request('POST', `/api/drafts/${encodeURIComponent(id)}/auth`, { token }),
  forkDraft: (id, name) => request('POST', `/api/drafts/${encodeURIComponent(id)}/fork`, { body: { name } }),
  versions: (id) => request('GET', `/api/drafts/${encodeURIComponent(id)}/versions`),
  version: (id, n) => request('GET', `/api/drafts/${encodeURIComponent(id)}/versions/${n}`),
  search: (q) => request('GET', `/api/search?q=${encodeURIComponent(q)}&limit=8`),
  roads: (b) => request('GET', `/api/roads?bbox=${[b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(',')}`),
};

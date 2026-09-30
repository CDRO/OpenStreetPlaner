import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalState, MemoryBackend, DEFAULT_SETTINGS } from '../js/local.js';

test('Entwurfsliste mit Token merken, sortieren, vergessen', () => {
  const local = new LocalState(new MemoryBackend());
  local.rememberDraft({ id: 'aaaaaaaaaaaa', name: 'A', token: 'tok-a', updatedAt: '2026-01-01T00:00:00Z' });
  local.rememberDraft({ id: 'bbbbbbbbbbbb', name: 'B', token: null, updatedAt: '2026-02-01T00:00:00Z' });
  const list = local.listDrafts();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'bbbbbbbbbbbb', 'neueste zuerst');
  assert.equal(local.tokenFor('aaaaaaaaaaaa'), 'tok-a');
  assert.equal(local.tokenFor('bbbbbbbbbbbb'), null);
  local.rememberDraft({ id: 'aaaaaaaaaaaa', name: 'A2' });
  assert.equal(local.getDraft('aaaaaaaaaaaa').token, 'tok-a', 'Token bleibt beim Umbenennen erhalten');
  assert.equal(local.getDraft('aaaaaaaaaaaa').name, 'A2');
  local.forgetDraft('aaaaaaaaaaaa');
  assert.equal(local.listDrafts().length, 1);
});

test('Arbeitskopie und Einstellungen', () => {
  const local = new LocalState(new MemoryBackend());
  assert.equal(local.loadWorking(), null);
  local.saveWorking({ doc: { name: 'W' }, id: null });
  assert.equal(local.loadWorking().doc.name, 'W');
  local.clearWorking();
  assert.equal(local.loadWorking(), null);
  assert.deepEqual(local.loadSettings(), DEFAULT_SETTINGS);
  local.saveSettings({ snapModifier: 'Control' });
  assert.equal(local.loadSettings().snapModifier, 'Control');
  assert.equal(local.loadSettings().snapEnabled, true);
});

test('kaputter Speicher wird ignoriert', () => {
  const backend = new MemoryBackend();
  backend.setItem('stadtplaner.drafts', '{{{');
  const local = new LocalState(backend);
  assert.deepEqual(local.listDrafts(), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankPalette } from '../src/commandPaletteModel.ts';

const items = [
  { id: 'page:endpoints', kind: 'page', title: 'Endpoints' },
  { id: 'page:software', kind: 'page', title: 'Software' },
  { id: 'action:run', kind: 'action', title: 'Run PowerShell on computers' },
  { id: 'c1', kind: 'computer', title: 'CIRC-DESK-01', detail: '192.168.10.21 · PCLS\\maria', keywords: 'PCLS.lan/DomainComputers/Cody/Circulation' },
  { id: 'c2', kind: 'computer', title: 'KIDS-PC-03', detail: '192.168.10.40', keywords: 'PCLS.lan/DomainComputers/Powell/Kids' },
  { id: 'c3', kind: 'computer', title: 'RESEARCH', detail: '192.168.20.119' },
];
const ids = list => list.map(item => item.id);

test('empty query shows pages and actions, not every computer', () => {
  assert.deepEqual(ids(rankPalette(items, '')), ['page:endpoints', 'page:software', 'action:run']);
});

test('prefix matches rank first and every word must match (name, IP, user or OU)', () => {
  assert.equal(rankPalette(items, 'kids')[0].id, 'c2');
  assert.deepEqual(ids(rankPalette(items, '192.168.10')).sort(), ['c1', 'c2']);
  assert.deepEqual(ids(rankPalette(items, 'maria')), ['c1']);
  assert.deepEqual(ids(rankPalette(items, 'cody circ')), ['c1']);
  assert.deepEqual(ids(rankPalette(items, 'powershell')), ['action:run']);
  assert.deepEqual(ids(rankPalette(items, 'research')), ['c3']);
  assert.equal(rankPalette(items, 'nothing matches this').length, 0);
});

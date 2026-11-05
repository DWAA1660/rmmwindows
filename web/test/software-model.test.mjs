import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupSoftware, filterSoftware, missingFrom, softwareCsv, compareVersions } from '../src/softwareModel.ts';

const fleet = [
  { id: 'a', hostname: 'CIRC-01', inventory: { software: [{ name: 'Google Chrome', version: '130.0.6723.92', publisher: 'Google LLC' }, { name: '7-Zip 23.01', version: '23.01' }] } },
  { id: 'b', hostname: 'CIRC-02', displayName: 'Circ desk 2', inventory: { software: [{ name: 'Google  Chrome ', version: '129.0.1', publisher: 'Google LLC' }, { name: '=HYPERLINK("x")', version: '1' }] } },
  { id: 'c', hostname: 'KIDS-01', inventory: { software: [{ name: 'Adobe Acrobat', version: '', publisher: 'Adobe' }] } },
  { id: 'd', hostname: 'NEW-PC', inventory: {} },
  { id: 'e', hostname: 'OLD', revoked: true, inventory: { software: [{ name: 'Google Chrome', version: '1.0' }] } },
];

test('groups programs across computers with versions newest first and ignores revoked endpoints', () => {
  const groups = groupSoftware(fleet);
  const chrome = groups.find(group => group.key === 'google chrome');
  assert.equal(groups[0].key, 'google chrome', 'most widely installed first');
  assert.deepEqual(chrome.endpointIds, ['a', 'b']);
  assert.deepEqual(chrome.versions.map(v => v.version), ['130.0.6723.92', '129.0.1']);
  assert.equal(chrome.publisher, 'Google LLC');
  assert.equal(groups.find(group => group.key === 'adobe acrobat').versions[0].version, 'Unknown version');
});

test('search matches every word in name or publisher; missing-from skips computers without inventory', () => {
  const groups = groupSoftware(fleet);
  assert.deepEqual(filterSoftware(groups, 'google').map(g => g.key), ['google chrome']);
  assert.deepEqual(filterSoftware(groups, 'chrome google').map(g => g.key), ['google chrome']);
  assert.equal(filterSoftware(groups, 'nothing-like-this').length, 0);
  const chrome = groups.find(group => group.key === 'google chrome');
  assert.deepEqual(missingFrom(chrome, fleet).map(e => e.id), ['c'], 'NEW-PC has no inventory and OLD is revoked');
});

test('version comparison is numeric and CSV export neutralises spreadsheet formulas', () => {
  assert.ok(compareVersions('10.0.2', '9.9.9') > 0);
  assert.ok(compareVersions('1.2', '1.10') < 0);
  assert.ok(compareVersions('Unknown version', '0.1') < 0);
  const csv = softwareCsv(fleet);
  assert.ok(csv.startsWith('Computer,Program,Version,Publisher,Install date\r\n'));
  assert.ok(csv.includes('Circ desk 2,Google Chrome,129.0.1,Google LLC,'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`), 'formula cell is quoted and prefixed');
  assert.ok(!csv.includes('OLD'), 'revoked endpoints are not exported');
  const only = softwareCsv(fleet, new Set(['adobe acrobat']));
  assert.equal(only.trim().split('\r\n').length, 2);
});

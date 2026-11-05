import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleetHealth, olderVersion } from '../src/fleetHealthModel.ts';

const now = Date.parse('2026-11-05T12:00:00Z');
const GB = 1024 ** 3;
const fleet = [
  { id: 'a', hostname: 'CIRC-01', online: true, lastSeen: '2026-11-05T11:59:00Z', inventory: { agentVersion: '0.1.7', disks: [{ name: 'C:', totalBytes: 256 * GB, freeBytes: 8 * GB }], pendingReboot: true, pendingRebootReasons: ['Windows Update'], uptimeSeconds: 40 * 86400 } },
  { id: 'b', hostname: 'KIDS-02', online: false, lastSeen: '2026-11-02T12:00:00Z', inventory: { agentVersion: '0.1.4', disks: [{ name: 'C:', totalBytes: 500 * GB, freeBytes: 200 * GB }], pendingReboot: false } },
  { id: 'c', hostname: 'NEW', online: false, lastSeen: '2026-11-05T06:00:00Z', inventory: { agentVersion: '0.1.7', bootTime: '2026-11-04T12:00:00Z' } },
  { id: 'd', hostname: 'GONE', revoked: true, online: false, lastSeen: '2026-01-01T00:00:00Z', inventory: { agentVersion: '0.0.1' } },
];
const byKey = issues => Object.fromEntries(issues.map(issue => [issue.key, issue.endpoints.map(e => e.id)]));

test('flags offline, low disk, pending reboot, outdated agents and long uptime; ignores revoked', () => {
  const result = byKey(fleetHealth(fleet, '0.1.7', now));
  assert.deepEqual(result.offline, ['b'], 'offline 3 days; NEW is offline only 6 hours');
  assert.deepEqual(result.disk, ['a'], '8 GB free is under 10 GB');
  assert.deepEqual(result.reboot, ['a']);
  assert.deepEqual(result.agent, ['b']);
  assert.deepEqual(result.uptime, ['a']);
  const details = fleetHealth(fleet, '0.1.7', now);
  assert.match(details.find(i => i.key === 'offline').endpoints[0].detail, /3 days/);
  assert.match(details.find(i => i.key === 'agent').endpoints[0].detail, /0\.1\.4 → 0\.1\.7/);
});

test('version comparison and unknown latest version', () => {
  assert.equal(olderVersion('0.1.4', '0.1.7'), true);
  assert.equal(olderVersion('0.1.10', '0.1.7'), false);
  assert.equal(olderVersion('0.1.7', '0.1.7'), false);
  assert.equal(olderVersion(undefined, '0.1.7'), true);
  assert.deepEqual(byKey(fleetHealth(fleet, undefined, now)).agent, [], 'no agent check without a known latest version');
});

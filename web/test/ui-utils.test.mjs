import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatBytes,
  formatRelativeTime,
  formatTimestamp,
  usedDiskPercent,
  getPrimaryDisk,
  isActiveJob,
  endpointDisplayName,
  matchesEndpointSearch,
  canStartRemoteSupport,
  titleCaseAction,
} from '../src/uiUtils.ts';

test('formatBytes scales cleanly across units', () => {
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(5 * 1048576), '5.0 MB');
  assert.equal(formatBytes(12.5 * 1073741824), '12.5 GB');
  assert.equal(formatBytes(1.5 * 1099511627776), '1.5 TB');
});

test('formatRelativeTime and formatTimestamp handle valid and missing timestamps', () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  assert.equal(formatRelativeTime(undefined, now), 'Never');
  assert.equal(formatRelativeTime('not-a-date', now), 'Never');
  assert.equal(formatRelativeTime(new Date(now - 20_000).toISOString(), now), 'Just now');
  assert.equal(formatRelativeTime(new Date(now - 7 * 60_000).toISOString(), now), '7m ago');
  assert.equal(formatRelativeTime(new Date(now - 3 * 3600_000).toISOString(), now), '3h ago');
  assert.equal(formatRelativeTime(new Date(now - 5 * 86400_000).toISOString(), now), '5d ago');
  assert.equal(formatTimestamp(null), '—');
  assert.notEqual(formatTimestamp('2026-11-20T12:00:00.000Z'), '—');
});

test('disk helpers compute percentage cleanly and prefer C: drive', () => {
  assert.equal(usedDiskPercent({ totalBytes: 0, freeBytes: 0 }), 0);
  assert.equal(usedDiskPercent({ totalBytes: 100, freeBytes: 15 }), 85);
  const disk = getPrimaryDisk({
    inventory: {
      disks: [
        { name: 'D:', totalBytes: 100, freeBytes: 50 },
        { name: 'C:', totalBytes: 200, freeBytes: 20 },
      ],
    },
  });
  assert.equal(disk?.name, 'C:');
});

test('canStartRemoteSupport enforces agent >= 0.1.6', () => {
  assert.equal(canStartRemoteSupport(undefined), false);
  assert.equal(canStartRemoteSupport('0.1.5'), false);
  assert.equal(canStartRemoteSupport('0.1.6'), true);
  assert.equal(canStartRemoteSupport('0.1.16'), true);
  assert.equal(canStartRemoteSupport('0.2.0'), true);
  assert.equal(canStartRemoteSupport('1.0.0'), true);
  assert.equal(canStartRemoteSupport('bad.version'), false);
});

test('matchesEndpointSearch matches multiple words across hostname, IP, user, OU, and group', () => {
  const ep = {
    id: 'e1',
    hostname: 'CODY-CIRC-01',
    displayName: 'Circulation Desk 1',
    lastSeen: '2026-11-20T12:00:00Z',
    online: true,
    groupName: 'Cody Branch',
    tags: ['kiosk'],
    inventory: {
      ipv4: ['10.14.2.31'],
      domain: 'PCL.LOCAL',
      loggedOnUser: 'PCL\\circdesk',
      osName: 'Windows 11 Pro',
      directory: { canonicalName: 'pcl.local/Cody/Circulation/CODY-CIRC-01' },
    },
  };
  assert.equal(matchesEndpointSearch(ep, 'circulation 10.14.2'), true);
  assert.equal(matchesEndpointSearch(ep, 'cody kiosk'), true);
  assert.equal(matchesEndpointSearch(ep, 'meeteetse'), false);
});

test('status & label helpers behave deterministically', () => {
  assert.equal(isActiveJob({ status: 'queued' }), true);
  assert.equal(isActiveJob({ status: 'dispatched' }), true);
  assert.equal(isActiveJob({ status: 'running' }), true);
  assert.equal(isActiveJob({ status: 'succeeded' }), false);
  assert.equal(endpointDisplayName({ hostname: 'HOST-A', displayName: 'Front Desk' }), 'Front Desk');
  assert.equal(endpointDisplayName({ hostname: 'HOST-A' }), 'HOST-A');
  assert.equal(titleCaseAction('remote_support'), 'Remote support');
});

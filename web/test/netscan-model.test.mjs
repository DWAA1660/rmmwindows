import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTarget, addressCount, splitTargets, parsePortsText, portsText, fleetSubnets, deviceGuess, osGuess, hostRisk, findings, compareSources, subnetGrids, scanCsv, portInfo, PORT_PROFILES, PORT_CATALOG, estimateSeconds } from '../src/netscanModel.ts';

const host = (ip, open = [], extra = {}) => ({ ip, rtt: 1, ttl: 128, open, closed: [], closedCount: 0, filtered: 0, mac: null, name: null, arpOnly: false, ...extra });

test('targets match the server rules for subnets, ranges and single IPs', () => {
  assert.equal(parseTarget('192.168.10.0/24').count, 254);
  assert.equal(parseTarget('192.168.10.20-40').kind, 'range');
  assert.equal(parseTarget('192.168.10.20-192.168.10.40').count, 21);
  assert.equal(parseTarget('192.168.10.9').kind, 'ip');
  assert.match(parseTarget('10.0.0.0/8'), /too large/);
  assert.match(parseTarget('127.0.0.1'), /loopback/);
  assert.match(parseTarget('printer'), /not an IP/);
  assert.equal(addressCount([parseTarget('10.0.0.0/24'), parseTarget('10.0.0.5'), parseTarget('10.0.0.250-10.0.1.4')]), 260);
  assert.deepEqual(splitTargets('10.0.0.0/24, 10.0.1.5\n10.0.2.1-20;'), ['10.0.0.0/24', '10.0.1.5', '10.0.2.1-20']);
});

test('ports parse from text and print compactly', () => {
  assert.deepEqual(parsePortsText('443 80, 8000-8002'), [80, 443, 8000, 8001, 8002]);
  assert.match(parsePortsText('70000'), /1–65535/);
  assert.match(parsePortsText('http'), /not a port/);
  assert.equal(portsText([8002, 22, 8000, 8001, 80, 81]), '22, 80, 81, 8000-8002');
  assert.ok(PORT_PROFILES.every(profile => profile.ports.every(port => PORT_CATALOG.some(item => item.port === port))), 'profiles only use catalogued ports');
  assert.equal(portInfo(445).service, 'SMB'); assert.equal(portInfo(31337).service, 'Unknown');
  assert.equal(estimateSeconds(254, 20, 'normal', true, true), Math.ceil(1 * 1.1 + 20 * 1.0 + 4 * 3 + 10));
});

test('fleet subnets come from reported addresses', () => {
  const subnets = fleetSubnets([
    { id: 'a', inventory: { ipv4: ['10.1.2.5', '169.254.1.1'], networkAdapters: [{ ipv4: ['10.1.2.5'] }] } },
    { id: 'b', inventory: { ipv4: ['10.1.2.9', '10.9.0.4'] } },
    { id: 'c', revoked: true, inventory: { ipv4: ['10.7.7.7'] } },
  ]);
  assert.deepEqual(subnets, [{ cidr: '10.1.2.0/24', endpointIds: ['a', 'b'] }, { cidr: '10.9.0.0/24', endpointIds: ['b'] }]);
});

test('hosts are classified and risks ranked', () => {
  assert.equal(deviceGuess({ open: [9100, 80], ttl: 255 }), 'printer');
  assert.equal(deviceGuess({ open: [53, 88, 389, 445], ttl: 128 }), 'dc');
  assert.equal(deviceGuess({ open: [445, 3389], ttl: 128 }), 'windows');
  assert.equal(deviceGuess({ open: [22], ttl: 64 }), 'linux');
  assert.equal(deviceGuess({ open: [80, 139, 445], ttl: 64 }), 'nas', 'Samba on a Linux TTL is a NAS, not Windows');
  assert.equal(deviceGuess({ open: [], ttl: 255 }), 'network');
  assert.equal(osGuess(117), 'Windows'); assert.equal(osGuess(null), null);
  assert.equal(hostRisk({ open: [443, 23] }), 'critical'); assert.equal(hostRisk({ open: [] }), null);
});

test('findings, comparison, map and CSV summarize several sources', () => {
  const sources = [
    { endpointId: 'staff', endpointName: 'STAFF-PC', hosts: [host('10.0.0.40', [9100]), host('10.0.0.5', [445, 3389], { name: 'fs01' })] },
    { endpointId: 'patron', endpointName: 'PATRON-PC', hosts: [host('10.0.0.40', [9100]), host('10.0.0.5', [445])] },
  ];
  const list = findings(sources);
  assert.deepEqual(list.map(f => f.port), [445, 3389, 9100], 'high risk first, then most hosts');
  assert.deepEqual(list[0].hosts[0].sources, ['staff', 'patron']);
  const rows = compareSources(sources);
  assert.equal(rows[0].ip, '10.0.0.5'); assert.equal(rows[0].differs, true); assert.equal(rows[1].differs, false);
  assert.equal(rows[0].name, 'fs01');
  const [grid] = subnetGrids({ targets: [{ input: '10.0.0.0/25' }] }, sources[0].hosts, ['10.0.0.9']);
  assert.equal(grid.network, '10.0.0.0/24'); assert.equal(grid.cells.length, 256);
  assert.equal(grid.cells[5].state, 'risky'); assert.equal(grid.cells[40].state, 'open'); assert.equal(grid.cells[9].state, 'self');
  assert.equal(grid.cells[10].state, 'down'); assert.equal(grid.cells[200].state, 'outside');
  const csv = scanCsv({ sources: [{ ...sources[0], hosts: [host('10.0.0.7', [80], { name: '=cmd|calc' })] }] });
  assert.match(csv, /STAFF-PC,10\.0\.0\.7,'=cmd\|calc/, 'spreadsheet formulas are neutralized');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planAgentUpdate, chosenIds, isAgentUpdateJob } from '../src/bulkAgentUpdateModel.ts';

const script = "$ErrorActionPreference='Stop'\n& ([scriptblock]::Create((Invoke-RestMethod 'https://rmm.example.test/install.ps1')))";
const fleet = [
  { id: 'a', hostname: 'CIRC-01', online: true, inventory: { agentVersion: '0.1.9' } },
  { id: 'b', hostname: 'CIRC-02', online: true, inventory: { agentVersion: '0.1.7' } },
  { id: 'c', hostname: 'LAB-01', online: false, inventory: { agentVersion: '0.1.6' } },
  { id: 'd', hostname: 'KIDS-01', online: true, inventory: { agentVersion: '0.1.8' } },
  { id: 'e', hostname: 'NEW', displayName: 'New PC', online: true },
  { id: 'f', hostname: 'GONE', online: false, revoked: true, inventory: { agentVersion: '0.1.1' } },
  { id: 'g', hostname: 'REF-01', online: false, inventory: { agentVersion: '0.1.10' } },
];
const jobs = [
  { endpointId: 'd', kind: 'powershell', status: 'running', payload: { script } },
  { endpointId: 'b', kind: 'powershell', status: 'succeeded', payload: { script } },
  { endpointId: 'b', kind: 'powershell', status: 'queued', payload: { script: 'Get-Service' } },
];
const ids = rows => rows.map(row => row.id);

test('classifies outdated, current, pending and revoked computers', () => {
  const plan = planAgentUpdate(fleet, '0.1.9', jobs);
  assert.deepEqual(ids(plan.outdated), ['b', 'c', 'e'], 'unknown version counts as outdated; a finished update does not block');
  assert.deepEqual(ids(plan.current), ['a', 'g'], '0.1.10 is newer than 0.1.9 (numeric, not text, comparison)');
  assert.deepEqual(ids(plan.pending), ['d'], 'only a queued/dispatched/running update job is pending; other scripts are ignored');
  assert.deepEqual(ids(plan.revoked), ['f']);
  assert.equal(plan.outdated.find(row => row.id === 'e').name, 'New PC');
  assert.equal(plan.outdated.find(row => row.id === 'e').version, 'unknown');
});

test('chooses outdated computers, optionally current ones and offline ones', () => {
  const plan = planAgentUpdate(fleet, '0.1.9', jobs);
  assert.deepEqual(chosenIds(plan, { reinstallCurrent: false, includeOffline: true }).sort(), ['b', 'c', 'e']);
  assert.deepEqual(chosenIds(plan, { reinstallCurrent: false, includeOffline: false }).sort(), ['b', 'e']);
  assert.deepEqual(chosenIds(plan, { reinstallCurrent: true, includeOffline: true }).sort(), ['a', 'b', 'c', 'e', 'g']);
  assert.ok(!chosenIds(plan, { reinstallCurrent: true, includeOffline: true }).includes('d'), 'pending computers are never sent');
});

test('without a published version every non-pending computer is offered', () => {
  const plan = planAgentUpdate(fleet, undefined, []);
  assert.equal(plan.current.length, 0);
  assert.equal(plan.outdated.length, 6);
  assert.equal(isAgentUpdateJob({ kind: 'files', status: 'queued', payload: { script } }), false);
});

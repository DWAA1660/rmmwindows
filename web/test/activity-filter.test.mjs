import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterActivity, isBrowsingJob, jobKindGroup } from '../src/activityFilter.ts';

const jobs = [
  { id: 1, kind: 'files', status: 'succeeded', endpointName: 'CIRC-01', payload: { action: 'list', path: 'C:\\Users' } },
  { id: 2, kind: 'files', status: 'succeeded', endpointName: 'CIRC-01', payload: { action: 'delete', paths: ['C:\\Temp\\a.txt'] } },
  { id: 3, kind: 'powershell', status: 'running', endpointName: 'KIDS-02', payload: { script: 'sfc /scannow' } },
  { id: 4, kind: 'terminal', status: 'failed', endpointName: 'CIRC-01', summary: 'Process exited with code 1', payload: { script: 'Get-Thing' } },
  { id: 5, kind: 'reboot', status: 'succeeded', endpointName: 'KIDS-02', payload: {} },
];
const base = { status: 'all', kind: 'all', query: '', showBrowsing: false };
const ids = list => list.map(job => job.id);

test('folder listings are hidden by default and shown on request; real file changes always show', () => {
  assert.ok(isBrowsingJob(jobs[0]) && !isBrowsingJob(jobs[1]));
  assert.deepEqual(ids(filterActivity(jobs, base)), [2, 3, 4, 5]);
  assert.deepEqual(ids(filterActivity(jobs, { ...base, showBrowsing: true })), [1, 2, 3, 4, 5]);
});

test('status, type and multi-word search combine', () => {
  assert.deepEqual(ids(filterActivity(jobs, { ...base, status: 'active' })), [3]);
  assert.deepEqual(ids(filterActivity(jobs, { ...base, status: 'failed' })), [4]);
  assert.deepEqual(ids(filterActivity(jobs, { ...base, kind: 'files' })), [2]);
  assert.deepEqual(ids(filterActivity(jobs, { ...base, query: 'kids sfc' })), [3]);
  assert.deepEqual(ids(filterActivity(jobs, { ...base, query: 'exited code' })), [4]);
  assert.equal(jobKindGroup({ kind: 'storage', status: 'x' }), 'files');
  assert.equal(jobKindGroup({ kind: 'remote_support', status: 'x' }), 'other');
});

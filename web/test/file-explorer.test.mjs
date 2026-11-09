import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinPath, parentPath, crumbs, typeLabel, formatBytes, downloadErrorText, leftOutItems, extractDestination, isZip, uploadNameProblem, agentErrorText, MAX_UPLOAD_BYTES } from '../src/fileExplorerModel.ts';

test('Windows path helpers navigate up, join and build breadcrumbs', () => {
  assert.equal(joinPath('C:\\', 'Users'), 'C:\\Users');
  assert.equal(joinPath('C:\\Users', 'Public'), 'C:\\Users\\Public');
  assert.equal(parentPath('C:\\Users\\Public'), 'C:\\Users');
  assert.equal(parentPath('C:\\Users'), 'C:\\');
  assert.equal(parentPath('C:\\'), '');
  assert.equal(parentPath(''), '');
  assert.deepEqual(crumbs(''), [{ label: 'This PC', path: '' }]);
  assert.deepEqual(crumbs('D:\\'), [{ label: 'This PC', path: '' }, { label: 'D:', path: 'D:\\' }]);
  assert.deepEqual(crumbs('C:\\Users\\Public').map(crumb => crumb.path), ['', 'C:\\', 'C:\\Users', 'C:\\Users\\Public']);
});

test('type labels and byte formatting', () => {
  assert.equal(typeLabel({ type: 'directory', name: 'Docs' }), 'Folder');
  assert.equal(typeLabel({ type: 'file', name: 'report.pdf' }), 'PDF file');
  assert.equal(typeLabel({ type: 'file', name: '.gitignore' }), 'File');
  assert.equal(typeLabel({ type: 'directory', name: 'Link', reparse: true }), 'Folder link');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(formatBytes(null), '—');
});

test('folder downloads explain old agents and list every left-out item', () => {
  assert.match(downloadErrorText('Folders cannot be downloaded; download individual files.', true), /older agent.*0\.1\.14/);
  assert.equal(downloadErrorText('File not found: C:\\x', false), 'File not found: C:\\x');
  assert.deepEqual(leftOutItems({ ok: true, name: 'Logs.zip', skippedCount: 0, skipped: [] }), []);
  const items = leftOutItems({ ok: true, name: 'Logs.zip', skippedCount: 502, skippedListTruncated: true,
    skipped: [{ path: 'C:\\Logs\\a.log', error: 'in use' }, { path: 'C:\\Logs\\link', error: 'Link' }] });
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { path: 'C:\\Logs\\a.log', ok: false, error: 'in use' });
  assert.match(items[2].path, /Logs\.zip: 500 more/);
});

test('upload and extract helpers', () => {
  assert.equal(extractDestination('C:\\Users\\Public\\Setup Files.ZIP'), 'C:\\Users\\Public\\Setup Files');
  assert.equal(extractDestination('D:\\pack.zip'), 'D:\\pack');
  assert.equal(extractDestination('C:\\x\\..zip'), 'C:\\x\\extracted');
  assert.ok(isZip('a.ZIP') && !isZip('a.zip.txt'));
  assert.equal(uploadNameProblem('report ü.pdf'), null);
  for (const bad of ['', 'a:b.txt', 'CON.txt', 'name.', 'a\\b', 'x'.repeat(256)]) assert.ok(uploadNameProblem(bad), bad);
  assert.match(agentErrorText('Unsupported file action; nothing was changed.'), /older agent.*0\.1\.14/);
  assert.equal(agentErrorText('Access denied'), 'Access denied');
  assert.equal(MAX_UPLOAD_BYTES, 1024 ** 3);
});

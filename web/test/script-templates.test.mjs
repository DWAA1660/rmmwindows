import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scriptTemplates } from '../src/scriptTemplates.ts';

test('starter scripts have unique ids, names, descriptions and non-empty bodies', () => {
  assert.ok(scriptTemplates.length >= 10);
  assert.equal(new Set(scriptTemplates.map(t => t.id)).size, scriptTemplates.length);
  assert.equal(new Set(scriptTemplates.map(t => t.name.toLowerCase())).size, scriptTemplates.length);
  for (const t of scriptTemplates) {
    assert.ok(t.name && t.description && t.category && t.body.trim(), t.id);
    assert.ok(!t.body.includes('undefined'), `${t.id} contains "undefined" (template interpolation accident?)`);
    assert.ok(!/Read-Host|Get-Credential|Out-GridView|-Confirm\b(?!:\$false)/.test(t.body), `${t.id} must never prompt`);
  }
});

test('every starter script parses as Windows PowerShell (Windows only)', { skip: process.platform !== 'win32' }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'rmm-templates-'));
  try {
    const input = join(folder, 'templates.json');
    writeFileSync(input, JSON.stringify(scriptTemplates.map(t => ({ id: t.id, body: t.body }))));
    const script = `$items = Get-Content -Raw -LiteralPath '${input.replace(/'/g, "''")}' | ConvertFrom-Json
foreach ($item in $items) { $errors = $null; [void][Management.Automation.Language.Parser]::ParseInput($item.body, [ref]$null, [ref]$errors); foreach ($e in $errors) { "$($item.id): $($e.Message)" } }`;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), '', 'parse errors:\n' + run.stdout);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

// Linux Docker packaging for the same self-contained Windows publish used by Build-Agent.ps1.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const [stageArg, outputArg, projectArg] = process.argv.slice(2);
if (!stageArg || !outputArg || !projectArg) throw new Error('Expected stage, output, and project paths.');
const stage = resolve(stageArg), output = resolve(outputArg);
const version = readFileSync(projectArg, 'utf8').match(/<Version>([^<]+)<\/Version>/)?.[1];
if (!version || !/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid agent version.');
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
mkdirSync(output, { recursive: true });
writeFileSync(join(stage, 'package-manifest.json'), JSON.stringify({ version, runtime: 'win-x64',
  agentSha256: digest(join(stage, 'agent/LibraryRmm.Agent.exe')), builtAtUtc: new Date().toISOString() }));
const archive = join(output, 'library-rmm-agent-win-x64.zip');
execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: stage });
const manifest = { version, runtime: 'win-x64', sha256: digest(archive) };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest));
writeFileSync(archive + '.sha256', `${manifest.sha256}  library-rmm-agent-win-x64.zip\n`);
console.log(`Packaged agent ${version} for win-x64; SHA256 ${manifest.sha256}`);

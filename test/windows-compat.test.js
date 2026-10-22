import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { hostFs } from '../lib/extract-asar.js';
import { ALL_PATCHES, applyReplacementsToText } from '../lib/core.js';
import { launchOfficialRestartScript, repairOfficialCliAfterUnpack } from '../lib/desktop.js';
import { rewritePromptAssembly } from '../lib/identity.js';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-compat-中文 '));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('backup descriptors close before an atomic replacement', (t) => {
  const dir = fixture(t);
  const dest = path.join(dir, 'backup');
  const fd = hostFs.openSync(dest, 'wx');
  try {
    hostFs.closeSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  const temp = path.join(dir, 'copy');
  fs.writeFileSync(temp, 'original bytes');
  hostFs.renameSync(temp, dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'original bytes');
});

test('shim detection can read a header using a file descriptor', (t) => {
  const file = path.join(fixture(t), 'dsh.cmd');
  fs.writeFileSync(file, '@echo off\r\n');
  const fd = hostFs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(512);
    const count = hostFs.readSync(fd, bytes, 0, bytes.length, 0);
    assert.equal(bytes.subarray(0, count).toString('utf8'), '@echo off\r\n');
  } finally { hostFs.closeSync(fd); }
});

const assemble021 = `
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
const requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));
return {
  ...transformed,
  sections: completeSection === void 0 ? transformed.sections : [completeSection],
  contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts
};`;

test('#40 supports 0.2.1 and retains required contexts after assembly', async () => {
  const patch = ALL_PATCHES.find(p => p.id === 40);
  const result = applyReplacementsToText(assemble021, patch);
  assert.equal(result.changed, true);
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(
    'scopeTarget', 'scope', 'assembly', 'context', 'completeSection', 'runtimeContextSuppressed', 'contextByName', result.text,
  );
  const sections = [{ name: 'dsh-purge', text: 'custom' }, { name: 'instructions', text: 'project' }];
  const contexts = [{ name: 'required' }, { name: 'optional' }];
  const receiver = { ctx: { waterfall: async () => ({ sections, contexts }) } };
  const entries = new Map([['required', { name: 'required', required: true }]]);
  for (const suppressed of [true, false]) for (const complete of [undefined, { name: 'complete', text: 'base' }]) {
    const output = await fn.call(receiver, () => null, null, {}, {}, complete, suppressed, entries);
    assert.deepEqual(output.contexts, suppressed ? [contexts[0]] : contexts);
    assert.ok(output.sections.some(s => s.text === 'custom'));
    assert.ok(output.sections.some(s => s.text === 'project'));
    assert.equal(output.sections.filter(s => s.name === 'complete').length, complete ? 1 : 0);
  }
  assert.equal(applyReplacementsToText(result.text, patch).changed, false);
});

test('#40 still supports 0.2.0 and CRLF builds', async () => {
  const input = assemble021.replace(/const requiredContexts[^\n]*\n/, '').replace('transformed.contexts.filter((entry) => requiredContexts.has(entry.name))', '[]').replace(/\n/g, '\r\n');
  const patch = ALL_PATCHES.find(p => p.id === 40);
  const output = applyReplacementsToText(input, patch);
  assert.equal(output.changed, true);
  assert.ok(output.text.includes('\r\n'));
  const fn = new (Object.getPrototypeOf(async function () {}).constructor)(
    'scopeTarget', 'scope', 'assembly', 'context', 'completeSection', 'runtimeContextSuppressed', output.text,
  );
  const result = await fn.call({ ctx: { waterfall: async () => ({ sections: [], contexts: [{ name: 'optional' }] }) } }, () => null, null, {}, {}, undefined, true);
  assert.deepEqual(result.contexts, []);
});

test('CLI repair returns only once the original shim backup is complete', async (t) => {
  const dir = fixture(t);
  const bin = path.join(dir, 'resources', 'runtime', 'cli', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'dsh.cmd');
  const original = '@echo off\r\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" %*\r\n';
  fs.writeFileSync(shim, original);
  const report = await repairOfficialCliAfterUnpack(path.join(dir, 'DeepSeek Harness.exe'));
  assert.equal(report.shims.find(s => s.path === shim).status, 'patched');
  assert.equal(fs.readFileSync(`${shim}.dsh-purge.bak`, 'utf8'), original);
});

test('0.2.1 assemblies do not gain an unregistered cwd variable', () => {
  const input = { sections: [{ name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.' }], variables: { provider: 'test', model: 'test' } };
  const output = rewritePromptAssembly(input, '', { capabilityProtocol: false });
  assert.ok(output.sections.every(s => !String(s.text).includes('{{cwd}}')));
  assert.equal(input.sections[0].text, 'Your working directory is {{cwd}}.');
  const legacy = rewritePromptAssembly({ ...input, variables: { cwd: 'D:/workspace' } }, '', { capabilityProtocol: false });
  assert.ok(legacy.sections.some(s => s.text.includes('{{cwd}}')));
});

test('CLI repair preserves the original shim if its backup cannot be committed', async (t) => {
  const dir = fixture(t);
  const shim = path.join(dir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  const original = '"%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js"';
  fs.mkdirSync(`${shim}.dsh-purge.bak`, { recursive: true });
  fs.writeFileSync(shim, original);
  const report = await repairOfficialCliAfterUnpack(path.join(dir, 'DeepSeek Harness.exe'));
  assert.equal(report.shims.find(s => s.path === shim).status, 'write_error');
  assert.equal(fs.readFileSync(shim, 'utf8'), original);
});

test('Windows restart helper only terminates the target installation and keeps itself alive', async () => {
  const source = fs.readFileSync(new URL('../lib/restart-desktop.js', import.meta.url), 'utf8').replace(/^import .*;\r?\n/gm, '');
  const killed = [];
  const exe = 'D:\\DSH\\DeepSeek Harness.exe';
  const rows = [
    { ProcessId: 100, ExecutablePath: exe },
    { ProcessId: 101, ExecutablePath: exe },
    { ProcessId: 200, ExecutablePath: 'D:\\Other\\DeepSeek Harness.exe' },
  ];
  const context = {
    fs: { appendFileSync() {} }, path,
    process: { platform: 'win32', pid: 101, env: { TEMP: os.tmpdir(), DSH_PURGE_RESTART: JSON.stringify({ execPath: exe, killApp: true, respawn: false }) }, kill: pid => killed.push(pid), exit(code) { throw Object.assign(new Error('exit'), { exitCode: code }); } },
    execFileSync(command, args) {
      if (command.toLowerCase().startsWith('powershell')) return JSON.stringify(rows);
      if (command === 'tasklist') return rows.map(r => `"DeepSeek Harness.exe","${r.ProcessId}","Console","1","0 K"`).join('\n');
      throw new Error(`Unexpected command ${command}: ${args}`);
    },
    setTimeout: fn => fn(),
  };
  await assert.rejects(vm.runInNewContext(`(async () => { ${source}\n })()`, context), error => error.exitCode === 0);
  assert.ok(killed.includes(100));
  assert.ok(!killed.includes(101), 'helper must survive');
  assert.ok(!killed.includes(200), 'another installation must survive');
});

for (const scenario of ['locked', 'success', 'already-unpacked', 'payload-missing']) test(`PowerShell swap: ${scenario}`, { skip: process.platform !== 'win32' }, (t) => {
  const dir = fixture(t);
  const resources = path.join(dir, 'resources');
  fs.mkdirSync(path.join(resources, 'app'), { recursive: true });
  if (scenario !== 'payload-missing') fs.writeFileSync(path.join(resources, 'app', 'package.json'), '{}');
  const asar = path.join(resources, 'app.asar');
  if (scenario !== 'already-unpacked') fs.writeFileSync(asar, 'sealed archive');
  const source = fs.readFileSync(new URL('../lib/desktop.js', import.meta.url), 'utf8');
  const declaration = source.match(/const ASAR_SWAP_PS1 = \[[\s\S]*?\]\.join\("\\r\\n"\);/)[0];
  const body = vm.runInNewContext(`${declaration}\nASAR_SWAP_PS1`);
  const script = path.join(dir, 'swap.ps1');
  // Stub only external process actions and the locked Move-Item. Execute the real control flow.
  const harness = `
function Get-CimInstance { @([pscustomobject]@{ ExecutablePath = $env:TEST_EXE; ProcessId = $PID }) }
function Stop-Process { param($Id, [switch]$Force) Add-Content -LiteralPath ($env:TEST_ASAR + '.killed') -Value $Id }
function Get-Process { @() }
function Start-Sleep { }
function Start-Process { param($FilePath) Set-Content -LiteralPath ($env:TEST_ASAR + '.launched') -Value $FilePath }
function Move-Item { [CmdletBinding()] param($LiteralPath, $Destination, [switch]$Force)
  if ($env:TEST_SCENARIO -eq 'locked') { Write-Error 'simulated file lock' -Category ResourceBusy }
  else { Microsoft.PowerShell.Management\\Move-Item @PSBoundParameters }
}
& {
${body}
} -WaitPid 999999 -AsarPath $env:TEST_ASAR -ExePath $env:TEST_EXE
`;
  // Windows PowerShell needs a BOM for Chinese literal text in the fixture paths.
  fs.writeFileSync(script, '\uFEFF' + harness);
  const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, TEST_SCENARIO: scenario, TEST_ASAR: asar, TEST_EXE: path.join(dir, 'DeepSeek Harness.exe') },
  });
  assert.ifError(run.error);
  assert.equal(run.status, scenario === 'payload-missing' ? 1 : 0, run.stderr);
  assert.equal(fs.existsSync(`${asar}.launched`), scenario === 'success' || scenario === 'already-unpacked', run.stderr);
  assert.equal(fs.existsSync(`${asar}.killed`), false, 'swap helper must not kill itself');
  if (scenario === 'locked' || scenario === 'payload-missing') assert.equal(fs.readFileSync(asar, 'utf8'), 'sealed archive');
  if (scenario === 'success') assert.equal(fs.readFileSync(`${asar}.bak`, 'utf8'), 'sealed archive');
  if (scenario === 'payload-missing') {
    assert.equal(fs.existsSync(`${asar}.bak`), false, 'rollback must put the archive back');
    assert.equal(fs.readFileSync(`${asar}.rename-pending`, 'utf8').trim(), 'payload-missing');
  } else {
    assert.equal(fs.existsSync(`${asar}.rename-pending`), scenario === 'locked');
  }
});

test('wscript restart falls back to PowerShell when the helper cannot start', (t) => {
  const dir = fixture(t);
  const inflight = path.join(dir, 'dsh-purge-official-restarting');
  fs.writeFileSync(inflight, '1');
  const calls = [];
  const fallback = (options) => calls.push(options);
  const launch = (overrides) => launchOfficialRestartScript({
    script: path.join(dir, 'restart.js'),
    exe: 'C:\\DSH\\DeepSeek Harness.exe',
    asar: 'C:\\DSH\\resources\\app.asar',
    fallback,
    ...overrides,
  });

  const sync = launch({ inflight, spawnImpl: () => { throw new Error('spawn wscript.exe ENOENT'); } });
  assert.equal(sync.mode, 'powershell');
  assert.match(sync.error, /ENOENT/);
  assert.equal(fs.existsSync(inflight), false, 'failed start must not leave an inflight marker');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].asar, 'C:\\DSH\\resources\\app.asar');
  assert.equal(calls[0].exit, false);

  const handlers = {};
  const child = { once(event, handler) { handlers[event] = handler; return this; }, unref() {} };
  const asyncLaunch = launch({ spawnImpl: () => child });
  assert.equal(asyncLaunch.mode, 'wscript');
  handlers.error(new Error('spawn wscript.exe EACCES'));
  assert.equal(calls.length, 2, 'async spawn error must also fall back');
  handlers.error(new Error('second error')); 
  assert.equal(calls.length, 2, 'fallback must run once');
});

test('Windows restart paths filter processes by executable path, not product name', () => {
  const source = fs.readFileSync(new URL('../lib/desktop.js', import.meta.url), 'utf8');
  assert.match(source, /SELECT ProcessId, ExecutablePath FROM Win32_Process/);
  assert.doesNotMatch(source, /WHERE Name = 'DeepSeek Harness\.exe'/);
  assert.match(source, /\$holding = @\(Get-Process -ErrorAction SilentlyContinue/);
  assert.doesNotMatch(source, /Get-Process -Name \$names/);
});


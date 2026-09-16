import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, symlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { product } from '../agent/product.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'agent/cli.mjs');
async function fixture(t) { const workspace = await mkdtemp(path.join(tmpdir(), `${product.name}-agent-`)); t.after(() => rm(workspace, { recursive: true, force: true })); return { workspace }; }
function run(args, input) { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [executable, ...args], { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = ''; child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b); child.on('error', reject); child.on('close', code => { try { resolve({ code, result: JSON.parse(out), err }); } catch { reject(new Error(`Invalid stdout: ${out}; stderr: ${err}`)); } }); child.stdin.end(input === undefined ? '' : JSON.stringify(input)); }); }
test('CLI discovery is machine-readable and does not create a workspace', async t => { const o = await fixture(t); const r = await run(['commands', '--workspace', o.workspace]); assert.equal(r.code, 0, r.err); assert.ok(r.result.operations.length >= 15); for (const op of r.result.operations) { assert.equal(op.inputSchema.type, 'object'); assert.equal(op.inputSchema.additionalProperties, false); } assert.deepEqual(await readdir(o.workspace), []); });
test('CLI init, status, unknown flags and wrong-product workspaces', async t => { const o = await fixture(t); assert.equal((await run(['init', '--workspace', o.workspace])).code, 0); const status = product.name === 'proofpack' ? 'pilot.list' : 'workspace.status'; const result = await run([status, '--workspace', o.workspace]); assert.equal(result.code, 0, JSON.stringify(result)); assert.equal((await run(['--unknown'])).result.ok, false); await writeFile(path.join(o.workspace, '.agent-workspace.json'), JSON.stringify({ version: 1, product: 'other' })); assert.equal((await run(['init', '--workspace', o.workspace])).result.error.code, 'WORKSPACE_MISMATCH'); });
test('workspace symlinks and uninitialized operations fail closed', async t => { const o = await fixture(t); const status = product.name === 'proofpack' ? 'pilot.list' : 'workspace.status'; await assert.rejects(product.execute(status, {}, o), /init/i); const linked = `${o.workspace}-link`; await symlink(o.workspace, linked); t.after(() => rm(linked)); await assert.rejects(product.init({ workspace: linked }), /real directories/); });
test('missing or symlinked initialized state cannot be reset by operations or init', async t => {
  const o = await fixture(t); await product.init(o);
  const name = { deckforge: 'workspace.json', skillforge: 'state.json', proofpack: 'library.json' }[product.name];
  const file = path.join(o.workspace, name), bytes = await readFile(file);
  await rm(file);
  const status = product.name === 'proofpack' ? 'pilot.list' : 'workspace.status';
  await assert.rejects(product.execute(status, {}, o), /missing/i);
  await assert.rejects(product.init(o), /missing/i);
  const target = path.join(o.workspace, 'held-state.json'); await writeFile(target, bytes); await symlink(target, file);
  await assert.rejects(product.execute(status, {}, o)); assert.deepEqual(await readFile(target), bytes);
});
test('private restore requires an exact preview and retains recovery bytes', async t => {
  const o = await fixture(t); await product.init(o); const call = async (n, i) => (await product.execute(n, i, o)).data;
  let args, command, exported;
  if (product.name === 'proofpack') { const p = await call('pilot.list', {}); const pilotId = p.defaultPilotId; exported = await call('pilot.export', { pilotId, format: 'backup', includePrivate: true }); args = { pilotId, revision: (await call('pilot.get', { pilotId })).project.revision }; command = 'pilot.restore'; }
  else { exported = await call('workspace.backup', { includePrivate: true }); args = { expectedRevision: (await call('workspace.status', {})).revision }; command = 'workspace.restore'; }
  args.backup = JSON.parse(Buffer.from(exported.artifact.base64, 'base64'));
  await assert.rejects(call(command, { ...args, dryRun: false, confirm: true }), /preview/i);
  const preview = await call(command, args); assert.ok(preview.previewToken);
  await assert.rejects(call(command, { ...args, dryRun: false, confirm: true, previewToken: randomUUID() }), /preview/i);
  await call(command, { ...args, dryRun: false, confirm: true, previewToken: preview.previewToken });
  assert.ok((await readdir(o.workspace)).some(name => name.includes('before-restore')));
  await assert.rejects(call(command, { ...args, dryRun: false, confirm: true, previewToken: preview.previewToken }), /conflict|changed|revision/i);
});
test('MCP negotiates, discovers schemas, executes tools, reports invalid input and shuts down cleanly', async t => { const o = await fixture(t); await product.init(o); const client = new Client({ name: 'independent-contract-test', version: '1.0.0' }); const transport = new StdioClientTransport({ command: process.execPath, args: [executable, 'mcp', '--workspace', o.workspace], stderr: 'pipe' }); await client.connect(transport); t.after(() => client.close()); const listed = await client.listTools(); assert.ok(listed.tools.length >= 15); const status = product.name === 'proofpack' ? 'pilot_list' : 'workspace_status'; const result = await client.callTool({ name: status, arguments: {} }); assert.equal(result.structuredContent.ok, true); const resources = await client.listResources(); assert.ok(resources.resources.some(r => r.uri === `${product.name}://schemas`)); const invalid = await client.callTool({ name: status, arguments: { unexpected: true } }); assert.equal(invalid.isError, true); await client.close(); });
test('read-only MCP omits mutations and service calls reject writes', async t => { const o = await fixture(t); await product.init(o); const client = new Client({ name: 'read-only-test', version: '1' }); await client.connect(new StdioClientTransport({ command: process.execPath, args: [executable, 'mcp', '--workspace', o.workspace, '--read-only'], stderr: 'pipe' })); t.after(() => client.close()); const listed = await client.listTools(); assert.ok(listed.tools.every(t => t.annotations.readOnlyHint)); await assert.rejects(product.init({ ...o, readOnly: true }), /read-only/); });
test('existing output is rejected before a mutation can initialize the workspace', async t => { const o = await fixture(t), output = path.join(o.workspace, 'existing.json'); await writeFile(output, 'keep'); const result = await run(['init', '--workspace', o.workspace, '--output', output]); assert.equal(result.result.ok, false); assert.equal(await readFile(output, 'utf8'), 'keep'); assert.deepEqual(await readdir(o.workspace), ['existing.json']); });
if (product.name === 'deckforge') test('headless deck lifecycle, dry run, concurrent processes, private export and UI parity', async t => {
  const o = await fixture(t); await product.init(o); const call = async (n, i) => (await product.execute(n, i, o)).data;
  const created = await call('deck.create', { title: 'Agent deck', requestId: randomUUID() }); const id = created.deck.id;
  const trial = await call('deck.update', { id, revision: created.revision, deck: { ...created.deck, title: 'Dry run' }, dryRun: true }); assert.equal(trial.dryRun, true); assert.equal((await call('deck.get', { id })).deck.title, 'Agent deck');
  const cp = await call('checkpoint.create', { id, revision: created.revision, name: 'Before changes' });
  const inputs = ['First', 'Second'].map(title => ({ id, revision: cp.revision, deck: { ...created.deck, title } }));
  const results = await Promise.all(inputs.map(input => run(['deck.update', '--workspace', o.workspace, '--input', '-'], input))); assert.deepEqual(results.map(r => r.code).sort(), [0, 3]);
  const current = await call('deck.get', { id }); const restored = await call('checkpoint.restore', { id, revision: current.revision, checkpointId: cp.checkpoints[0].id, confirm: true }); assert.equal(restored.deck.title, 'Agent deck');
  await assert.rejects(call('deck.export', { id, format: 'json' }), /notes/); assert.equal((await call('deck.export', { id, format: 'html' })).artifact.mediaType, 'text/html');
  const { createApp } = await import('../server.js'); const server = await createApp({ workspace: o.workspace }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  const url = `http://127.0.0.1:${server.address().port}`; const web = await (await fetch(`${url}/api/decks/${id}`)).json(); assert.equal(web.revision, restored.revision);
  const updated = await call('deck.update', { id, revision: web.revision, deck: { ...web.deck, title: 'Visible in UI' } }); assert.equal((await (await fetch(`${url}/api/decks/${id}`)).json()).deck.title, updated.deck.title);
});

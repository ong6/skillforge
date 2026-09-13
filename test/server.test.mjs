import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';

async function setup(t) {
  const root = await mkdtemp(join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-server-'));
  const app = await createApp({ dataPath: join(root, 'state.json') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const request = async (path, body, extra = {}) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { Origin: base, 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { ...app, base, request, root };
}
test('HTTP serves self-contained app with CSP, loopback binding and no secrets endpoint', async t => {
  const { request, server } = await setup(t); assert.equal(server.address().address, '127.0.0.1');
  const home = await request('/'); assert.equal(home.status, 200); assert.match(home.headers.get('content-security-policy'), /script-src 'self'/); assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/); assert.equal(home.headers.get('x-content-type-options'), 'nosniff'); assert.match(await home.text(), /Skillforge/);
  assert.equal((await request('/app.js')).status, 200); assert.equal((await request('/styles.css')).status, 200);
  const state = await (await request('/api/state')).json(); assert.equal(state.skills.length, 18); assert.equal(state.bundles.length, 0);
  for (const path of ['/data/state.json', '/server.mjs', '/%2e%2e/%2e%2e/etc/passwd', '/api/pack?id=../../etc/passwd', '/__proto__']) assert.equal((await request(path)).status, 404);
});
test('Host, Origin, fetch-site, methods and content type are enforced', async t => {
  const { request, base } = await setup(t);
  const wrongHostStatus = await new Promise((resolve, reject) => { const req = http.get(base + '/api/state', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await request('/api/state', undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/search', {}, { Origin: 'null' })).status, 403);
  assert.equal((await fetch(base + '/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await request('/api/search', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(base + '/', { method: 'PUT' })).status, 405);
});
test('malicious and malformed API inputs fail without mutating state', async t => {
  const { request } = await setup(t);
  for (const body of ['{broken', 'null', '[]', '{"query":{},"model":null}', JSON.stringify({ query: 'x'.repeat(501), model: { id: 'test', capabilities: [] } })]) { const r = await request('/api/search', body); assert.ok(r.status >= 400 && r.status < 500, `${body.slice(0, 30)} returned ${r.status}`); }
  assert.equal((await request('/api/import', { format: 'catalog', content: 'null' })).status, 400);
  assert.equal((await request('/api/import', { format: 'catalog', content: { version: 1, skills: [{ title: 'bad', content: 'x'.repeat(120001) }] } })).status, 400);
  assert.equal((await request('/api/compose', { title: 'x', task: 'tiny' })).status, 400);
  assert.equal((await request('/api/import', 'x'.repeat(4 * 1024 * 1024 + 1))).status, 413);
  assert.equal((await (await request('/api/state')).json()).skills.length, 18);
});
test('end-to-end local composer, ZIP, import, bundle, observed results and restart', async t => {
  const { request, root } = await setup(t);
  const body = { title: 'Notes review', task: 'Review supplied notes and generate evidence-grounded actions.', scope: 'Only the supplied meeting notes and authorized project context.', outputs: 'A concise action table with source quotes and unknown owners.', constraints: 'No fabricated quotes or owners; disclose missing evidence.', capabilities: ['reasoning'] };
  const composed = await request('/api/compose', body); assert.equal(composed.status, 201); const { skill } = await composed.json();
  const pack = await request('/api/pack?id=' + skill.id); assert.equal(pack.headers.get('content-type'), 'application/zip'); assert.match(pack.headers.get('content-disposition'), /notes-review.zip/); assert.equal(Buffer.from(await pack.arrayBuffer()).readUInt32LE(), 0x04034b50);
  const malicious = '---\nname: malicious-sample\ndescription: A harmless inert test artifact.\n---\n# Workflow\n<img src=x onerror=alert(1)>\n# Deliverable\nReturn only text.';
  const imported = await request('/api/import', { format: 'markdown', content: malicious, title: '<script>alert(1)</script>' }); assert.equal(imported.status, 201);
  const snapshot = await (await request('/api/state')).json(); assert.ok(snapshot.skills.some(s => s.content === malicious && s.provenance.status === 'untrusted-import'));
  const created = await request('/api/bundles', { title: 'Manual observed test', candidateIds: [skill.id], model: { id: 'custom-model-v1', capabilities: ['reasoning'] }, conditions: { systemPrompt: '', temperature: 0, tools: 'none', environment: 'Test-only fixture', judge: 'Fixture judgments, not real evidence', repetitions: 1, maxOutputTokens: 1024 }, cases: [{ id: 'notes', input: 'Summarize supplied meeting notes into actions.', expected: 'Evidence-grounded actions with uncertainty.' }] }); assert.equal(created.status, 201); const { bundle } = await created.json();
  const template = await (await request('/api/results-template?id=' + bundle.id)).json(); assert.equal((await request('/api/results', template)).status, 400);
  for (const run of template.runs) { run.output = 'Fixture output used only in automated validation tests.'; for (const j of Object.values(run.judgments)) { j.score = 2; j.reason = 'Automated fixture judgment, not a performance claim.'; } }
  const accepted = await request('/api/results', template); assert.equal(accepted.status, 201); assert.equal((await request('/api/results', template)).status, 400);
  const evidence = await (await request('/api/state')).json(); assert.equal(evidence.bundles[0].observed.ranked, true); assert.equal(evidence.bundles[0].observed.rows[0].meanLatencyMs, null); assert.equal(evidence.bundles[0].observed.totalRuns, 2);
  const exported = await (await request('/api/results-export?id=' + bundle.id)).json(); assert.equal(exported.runs[0].output, template.runs[0].output); assert.equal(exported.runs[0].judgments.correctness.score, 2);
  const reopened = await createApp({ dataPath: join(root, 'state.json') }); assert.equal(reopened.store.state.results.length, 1); assert.equal(reopened.store.state.skills.length, 2); assert.equal(JSON.parse(await readFile(join(root, 'state.json'))).version, 2);
});
test('CLI help works from absolute paths and rejects invalid arguments', async () => {
  const file = fileURLToPath(new URL('../server.mjs', import.meta.url)); const exec = promisify(execFile); const { stdout } = await exec(process.execPath, [file, '--help']); assert.match(stdout, /127.0.0.1/); assert.match(stdout, /npm test/); await assert.rejects(exec(process.execPath, [file, '--port', '0']), /Usage/);
});

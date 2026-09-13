import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { product } from '../agent/product.mjs';
import { createApp } from '../server.mjs';
test('agent evaluation lifecycle preserves frozen inputs, failures, provenance, backup and UI parity', async t => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'skillforge-workflow-')); t.after(() => rm(workspace, { recursive: true, force: true })); const o = { workspace }; await product.init(o);
  const call = async (name, input = {}) => (await product.execute(name, input, o)).data;
  const rev = async () => (await call('workspace.status')).revision;
  const payload = { title: 'Fixture evidence review', task: 'Review supplied evidence and identify missing support.', scope: 'Only fictional text supplied by this test.', outputs: 'A concise list of evidence gaps.', constraints: 'Do not invent facts or report synthetic output as observed.', capabilities: ['reasoning'] };
  const skill = (await call('skill.compose', { payload, expectedRevision: await rev() })).skill;
  const evaluation = { title: 'Synthetic integration check', candidateIds: [skill.id], model: { id: 'synthetic-test-no-model', capabilities: ['reasoning'] }, conditions: { systemPrompt: 'Use only the supplied fictional evidence.', temperature: 0, tools: 'none', environment: 'synthetic test fixture; no model execution', judge: 'synthetic fixture', repetitions: 1, maxOutputTokens: 1000 }, cases: [{ id: 'missing', input: 'No supporting measurement was supplied.', expected: 'Identify that evidence is missing.' }], caseSet: 'development' };
  const bundle = (await call('evaluation.create', { payload: evaluation, expectedRevision: await rev() })).bundle;
  const prompt = await call('evaluation.prompt', { id: bundle.id, candidateId: 'baseline', caseId: 'missing' }); assert.equal(prompt.skillInstructions, ''); assert.deepEqual(prompt.resources, []);
  const template = (await call('evaluation.template', { id: bundle.id })).template; template.kind = 'demo'; for (const run of template.runs) { run.output = 'Synthetic fixture: evidence is missing.'; for (const j of Object.values(run.judgments)) { j.score = 4; j.reason = 'Synthetic fixture satisfies the authored anchor.'; } }
  await call('evaluation.submit', { payload: template, expectedRevision: await rev(), provenance: { executor: 'integration-test', judge: 'synthetic', environment: 'No model was executed.' } });
  const report = (await call('evaluation.report', { id: bundle.id })).report; assert.equal(report.status, 'insufficient-evidence'); assert.equal(report.executionProvenance[0].judge, 'synthetic');
  await assert.rejects(call('evaluation.submit', { payload: { ...template, kind: 'observed' }, expectedRevision: await rev(), provenance: { executor: 'test', judge: 'synthetic', environment: 'fixture' } }), /Synthetic/);
  const revised = (await call('skill.revise', { payload: { sourceId: skill.id, content: skill.content + '\nInspect contradictions explicitly.\n' }, expectedRevision: await rev() })).skill; assert.notEqual(revised.id, skill.id); assert.equal((await call('evaluation.get', { id: bundle.id })).bundle.candidates[1].content, skill.content);
  const backup = JSON.parse(Buffer.from((await call('workspace.backup', { includePrivate: true })).artifact.base64, 'base64'));
  assert.equal((await call('workspace.restore', { backup, expectedRevision: await rev(), dryRun: true })).valid, true);
  const { server } = await createApp({ workspace }); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); }); const web = await (await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).json(); assert.equal(web.revision, await rev()); assert.ok(web.skills.some(s => s.id === revised.id));
});

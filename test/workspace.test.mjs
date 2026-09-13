import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  Store, composeSkill, createBundle, decisionReport, frozenPrompt, hash,
  packHash, resultTemplate, reviseSkill, summarizeResults, validateResults, validateState,
} from '../core.mjs';
import { createApp } from '../server.mjs';

const TEST_ROOT = fileURLToPath(new URL('.', import.meta.url));
const MODEL = { id: 'workspace-fixture-model', capabilities: ['reasoning'] };
const COMPOSER = {
  title: 'Evidence review fixture',
  task: 'Review supplied evidence and identify supported conclusions.',
  scope: 'Use only the explicitly supplied local source material.',
  outputs: 'Return supported findings and clearly identify missing evidence.',
  constraints: 'Do not fabricate evidence, execute resources, or contact external services.',
  capabilities: ['reasoning'],
};

function skill(title = COMPOSER.title) { return composeSkill({ ...COMPOSER, title }); }
function bundleInput(candidates, overrides = {}) {
  return {
    title: 'Workspace regression fixture', candidateIds: candidates.map(s => s.id), model: MODEL,
    conditions: {
      systemPrompt: '  Preserve these exact instructions.\r\n\t', temperature: 0,
      tools: 'No tools; inert resource files supplied manually.', environment: 'Isolated automated fixture',
      judge: 'Synthetic test judgments, not performance evidence', repetitions: 1, maxOutputTokens: 1024, seed: null,
    },
    cases: [
      { id: 'first', input: '  Review the first supplied artifact.\r\n', expected: 'Identify only findings supported by the first artifact.' },
      { id: 'second', input: '\tReview the second supplied artifact.\n ', expected: 'Identify only findings supported by the second artifact.' },
    ],
    ...overrides,
  };
}
function bundle(candidates, overrides = {}) { return createBundle(bundleInput(candidates, overrides), candidates); }
function completedResults(b, scores = {}) {
  const input = resultTemplate(b);
  for (const run of input.runs) {
    run.output = `Automated fixture output for ${run.candidateId}/${run.caseId}; not real execution evidence.`;
    const value = scores[run.candidateId] ?? (run.candidateId === 'baseline' ? 1 : 3);
    const score = typeof value === 'function' ? value(run) : value;
    for (const j of Object.values(run.judgments)) {
      j.score = score;
      j.reason = 'Synthetic regression judgment against the frozen criterion.';
    }
  }
  return input;
}
function batch(b, scores) { return validateResults(completedResults(b, scores), b); }
function emptyState() {
  return { version: 2, revision: 0, skills: [], bundles: [], results: [], profiles: [], shortlists: [], drafts: [] };
}
async function tempDirectory(t) {
  const root = await mkdtemp(join(TEST_ROOT, '.tmp-workspace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function setup(t) {
  const root = await tempDirectory(t), dataPath = join(root, 'state.json');
  const servers = new Set();
  t.after(async () => {
    await Promise.all([...servers].map(server => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })));
  });
  const start = async () => {
    const app = await createApp({ dataPath });
    await new Promise((resolve, reject) => {
      app.server.once('error', reject);
      app.server.listen(0, '127.0.0.1', resolve);
    });
    servers.add(app.server);
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (path, input, status = input === undefined ? 200 : 201) => {
      const response = await fetch(base + path, {
        method: input === undefined ? 'GET' : 'POST',
        headers: input === undefined ? {} : { Origin: base, 'Content-Type': 'application/json' },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      });
      const value = await response.json();
      assert.equal(response.status, status, `${path}: ${JSON.stringify(value)}`);
      return value;
    };
    const stop = async () => {
      await new Promise((resolve, reject) => {
        app.server.close(error => error ? reject(error) : resolve());
        app.server.closeAllConnections();
      });
      servers.delete(app.server);
    };
    return { ...app, request, stop };
  };
  return { ...(await start()), root, dataPath, start };
}
async function createHTTPBundle(request, overrides = {}) {
  const { skill: candidate } = await request('/api/compose', COMPOSER);
  const { bundle: b } = await request('/api/bundles', bundleInput([candidate], overrides));
  return { candidate, bundle: b };
}
function updateItem(item, fields = {}) {
  const { updatedAt, ...input } = item;
  return { ...input, ...fields };
}

test('profiles, shortlists, and compose drafts persist and reject stale concurrent edits atomically', async t => {
  const { request, dataPath, stop, start } = await setup(t);
  const { skill: candidate } = await request('/api/compose', COMPOSER);
  const initial = await request('/api/state');
  assert.equal(initial.version, 2);
  for (const collection of ['profiles', 'shortlists', 'drafts', 'results']) assert.deepEqual(initial[collection], []);
  const definitions = [
    ['profiles', 'profile', { name: 'Quality requirement', task: 'Review evidence', output: 'Findings', model: MODEL, requirements: { minMeanScore: 70, minCaseScore: 40, maxFailures: 0, cost: { mode: 'max', limit: 0.05 }, latency: { mode: 'mean', limit: 500 } } }],
    ['shortlists', 'shortlist', { name: 'Review candidates', candidateIds: [candidate.id] }],
    ['drafts', 'draft', { name: 'Unfinished composer', kind: 'compose', data: { title: '', task: '  Work in progress\n', content: '\n  Incomplete instructions\n' } }],
  ];
  for (const [collection, field, input] of definitions) {
    await request(`/api/${collection}`, input, 409);
    const created = (await request(`/api/${collection}`, { ...input, revision: 0 }))[field];
    assert.equal(created.revision, 1);
    const before = await request('/api/state');
    const attempts = await Promise.all(['Edit A', 'Edit B'].map(async name => {
      try { return { ok: true, value: await request(`/api/${collection}`, updateItem(created, { name })) }; }
      catch (error) {
        assert.match(error.message, /409|Revision conflict/);
        return { ok: false };
      }
    }));
    assert.equal(attempts.filter(attempt => attempt.ok).length, 1);
    const current = await request('/api/state');
    assert.equal(current.revision, before.revision + 1);
    assert.equal(current[collection].length, 1);
    assert.equal(current[collection][0].revision, 2);
    assert.ok(['Edit A', 'Edit B'].includes(current[collection][0].name));
    const committed = await readFile(dataPath);
    await request(`/api/${collection}`, updateItem(created, { name: 'Stale overwrite' }), 409);
    await request(`/api/${collection}`, { ...input, id: 'missing-item', revision: 0 }, 409);
    await request(`/api/${collection}`, { ...updateItem(current[collection][0]), unsupported: true }, 400);
    assert.deepEqual(await readFile(dataPath), committed);
  }
  await request('/api/shortlists', { revision: 0, name: 'Invalid reference', candidateIds: ['missing-skill'] }, 400);
  await request('/api/shortlists', { revision: 0, name: 'Duplicate reference', candidateIds: [candidate.id, candidate.id] }, 400);
  const saved = await request('/api/state');
  assert.equal(saved.drafts[0].data.content, '\n  Incomplete instructions\n');
  await stop();
  const reopened = await start();
  const loaded = await reopened.request('/api/state');
  for (const collection of ['profiles', 'shortlists', 'drafts']) assert.deepEqual(loaded[collection], saved[collection]);
  assert.equal(loaded.revision, saved.revision);
});

test('incomplete evaluation drafts never become evidence, and duplicate result submissions do not mutate state', async t => {
  const { request, dataPath } = await setup(t);
  const { bundle: b } = await createHTTPBundle(request);
  const incomplete = resultTemplate(b);
  incomplete.runs[0].output = '  Partial output retained exactly.\r\n';
  incomplete.runs[0].judgments.correctness = { score: 2, reason: '' };
  const { draft } = await request('/api/drafts', { revision: 0, name: 'Unfinished evaluation', kind: 'evaluation', data: { bundleId: b.id, results: incomplete } });
  assert.deepEqual(draft.data.results, incomplete);
  const saved = await request('/api/state');
  assert.equal(saved.results.length, 0);
  assert.equal(saved.bundles[0].observed.totalRuns, 0);
  assert.equal(saved.bundles[0].observed.ranked, false);
  assert.deepEqual(await request(`/api/runs?id=${b.id}`), { runs: [] });
  const noEvidence = (await request('/api/decision', { bundleId: b.id }, 200)).report;
  assert.equal(noEvidence.choice, null);
  assert.ok(noEvidence.rows.every(row => row.n === 0));
  const committed = await readFile(dataPath);
  await request('/api/results', incomplete, 400);
  for (const change of [
    results => { results.bundleHash = hash('wrong bundle'); },
    results => { results.runs[0].candidateHash = hash('wrong candidate'); },
    results => { results.runs.push(structuredClone(results.runs[0])); },
  ]) {
    const results = structuredClone(incomplete); change(results);
    await request('/api/drafts', updateItem(draft, { data: { bundleId: b.id, results } }), 400);
  }
  const complete = completedResults(b);
  const duplicate = structuredClone(complete); duplicate.runs.push(structuredClone(complete.runs[0]));
  await request('/api/results', duplicate, 400);
  assert.deepEqual(await readFile(dataPath), committed);
  await request('/api/results', complete);
  const accepted = await readFile(dataPath);
  await request('/api/results', complete, 400);
  assert.deepEqual(await readFile(dataPath), accepted);
  const final = await request('/api/state');
  assert.equal(final.results.length, 1);
  assert.equal(final.bundles[0].observed.totalRuns, complete.runs.length);
  assert.equal(final.bundles[0].observed.complete, true);
  assert.deepEqual(final.drafts[0], draft, 'submitting results must not silently rewrite the unfinished draft');
});

test('decision requirements treat incomplete cost and latency as unknown, with explicit max versus mean semantics', () => {
  const candidate = skill(), b = bundle([candidate]);
  const input = completedResults(b);
  for (const run of input.runs) { run.costUsd = run.caseId === 'first' ? 1 : 3; run.latencyMs = run.caseId === 'first' ? 100 : 300; }
  const complete = validateResults(input, b);
  const requirements = { minMeanScore: 60, minCaseScore: 50, maxFailures: 0, cost: { mode: 'mean', limit: 2 }, latency: { mode: 'mean', limit: 200 } };
  const meanReport = decisionReport(b, [complete], requirements);
  assert.equal(meanReport.choice.id, candidate.id);
  assert.deepEqual(meanReport.rows.find(row => row.id === candidate.id).cost, { mean: 2, max: 3 });
  const maxReport = decisionReport(b, [complete], { ...requirements, cost: { mode: 'max', limit: 2 }, latency: { mode: 'max', limit: 200 } });
  assert.equal(maxReport.choice, null);
  assert.ok(maxReport.rows.find(row => row.id === candidate.id).reasons.some(reason => /cost max/.test(reason)));
  for (const field of ['costUsd', 'latencyMs']) {
    const missing = structuredClone(input);
    missing.runs.find(run => run.candidateId === candidate.id)[field] = null;
    const report = decisionReport(b, [validateResults(missing, b)], requirements);
    const row = report.rows.find(row => row.id === candidate.id);
    assert.equal(report.choice, null);
    assert.equal(row[field === 'costUsd' ? 'cost' : 'latency'], null);
    assert.ok(row.reasons.some(reason => /incomplete; unknown is not zero/.test(reason)));
  }
  const unknown = decisionReport(b, [batch(b)]);
  assert.equal(unknown.choice.id, candidate.id, 'optional unknown metrics do not disqualify an otherwise eligible candidate');
  const row = unknown.rows.find(row => row.id === candidate.id);
  assert.equal(row.cost, null); assert.equal(row.latency, null); assert.equal(row.costUsd, null);
});

test('decision reports never invent a winner for ties or a baseline that is not worse', () => {
  const first = skill('First candidate'), second = skill('Second candidate'), b = bundle([first, second]);
  for (const scores of [
    { baseline: 1, [first.id]: 3, [second.id]: 3 },
    { baseline: 3, [first.id]: 3, [second.id]: 2 },
    { baseline: 4, [first.id]: 3, [second.id]: 2 },
  ]) {
    const report = decisionReport(b, [batch(b, scores)]);
    assert.equal(report.status, 'insufficient-evidence');
    assert.equal(report.choice, null);
    assert.ok(report.rows.every(row => row.eligible));
    assert.ok(report.qualifications.some(note => /not proof of superiority/.test(note)));
  }
  const report = decisionReport(b, [batch(b, { baseline: 1, [first.id]: 4, [second.id]: 3 })]);
  assert.equal(report.choice.id, first.id);
  assert.ok(report.qualifications.some(note => /not universal superiority/.test(note)));
});

test('execution failures remain zero-score evidence and independently disqualify candidates', () => {
  const candidate = skill(), b = bundle([candidate]), input = completedResults(b, { baseline: 1, [candidate.id]: 4 });
  const failed = input.runs.find(run => run.candidateId === candidate.id);
  failed.output = ''; failed.error = 'Fixture execution failed before producing output.';
  assert.throws(() => validateResults(input, b), /Failed executions must score zero/);
  for (const j of Object.values(failed.judgments)) j.score = 0;
  const result = validateResults(input, b);
  const strict = decisionReport(b, [result], { maxFailures: 0 });
  const row = strict.rows.find(row => row.id === candidate.id);
  assert.equal(row.n, 2); assert.equal(row.failures, 1); assert.equal(row.minScore, 0); assert.equal(row.meanScore, 50);
  assert.equal(strict.choice, null);
  assert.ok(row.reasons.some(reason => /Failure count/.test(reason)));
  assert.equal(decisionReport(b, [result], { maxFailures: 1 }).choice.id, candidate.id);
  assert.equal(decisionReport(b, [result], { maxFailures: 1, minCaseScore: 1 }).choice, null);
});

test('decision evidence includes only the selected frozen bundle and excludes demos and other models', () => {
  const candidate = skill(), selected = bundle([candidate]), other = bundle([candidate], { model: { id: 'other-model', capabilities: [] } });
  const selectedResult = batch(selected), otherResult = batch(other, { baseline: 4, [candidate.id]: 0 });
  const demoInput = completedResults(selected, { baseline: 4, [candidate.id]: 0 }); demoInput.kind = 'demo';
  const demo = validateResults(demoInput, selected);
  const expected = decisionReport(selected, [selectedResult]);
  assert.deepEqual(decisionReport(selected, [otherResult, demo, selectedResult]), expected);
  assert.equal(expected.evidence.bundleId, selected.id);
  assert.equal(expected.evidence.bundleHash, selected.hash);
  assert.equal(expected.evidence.resultsHash, hash(selectedResult.runs));
  assert.deepEqual(expected.evidence.candidates, selected.candidates.map(({ id, hash }) => ({ id, hash })));
  const partialInput = completedResults(selected); partialInput.runs = partialInput.runs.slice(0, 1);
  const partial = validateResults(partialInput, selected);
  const report = decisionReport(selected, [partial, otherResult, demo]);
  assert.equal(report.choice, null);
  assert.equal(report.rows.reduce((sum, row) => sum + row.n, 0), 1, 'unrelated complete bundles must not fill missing selected runs');
});

test('HTTP decision refuses a saved profile with a mismatched model declaration', async t => {
  const { request } = await setup(t), { candidate, bundle: b } = await createHTTPBundle(request);
  await request('/api/results', completedResults(b));
  assert.equal((await request('/api/decision', { bundleId: b.id }, 200)).report.choice.id, candidate.id);
  for (const model of [{ id: 'different-model', capabilities: MODEL.capabilities }, { id: MODEL.id, capabilities: [] }]) {
    const { profile } = await request('/api/profiles', { revision: 0, name: 'Different model requirement', model });
    const { report } = await request('/api/decision', { bundleId: b.id, profileId: profile.id }, 200);
    assert.equal(report.status, 'insufficient-evidence'); assert.equal(report.choice, null);
    assert.deepEqual(report.profile.model, model);
    assert.deepEqual(report.evidence.model, MODEL);
    assert.ok(report.qualifications.some(note => /profile model declaration does not match/.test(note)));
  }
});

test('reused case inputs cannot become held-out evidence merely by changing expected output', async t => {
  const { request, dataPath } = await setup(t), { candidate, bundle: original } = await createHTTPBundle(request);
  const changedCases = original.cases.map(c => ({ ...c, expected: c.expected + ' Changed judging guidance.' }));
  const nextInput = bundleInput([candidate], { cases: changedCases, caseSet: 'held-out' });
  const originalBytes = await readFile(dataPath);
  await request('/api/bundles', nextInput, 400);
  assert.deepEqual(await readFile(dataPath), originalBytes);
  const { bundle: reused } = await request('/api/bundles', { ...nextInput, caseSet: 'development', reusedFrom: original.id });
  assert.deepEqual(reused.reusedCaseBundles, [original.id]);
  assert.match(reused.caseReuseNotice, /not independent held-out/);
  assert.deepEqual(await request(`/api/bundle?id=${original.id}`), original);
  const forged = structuredClone(reused); forged.caseSet = 'held-out'; forged.reusedFrom = null;
  const { hash: oldHash, ...payload } = forged; forged.hash = hash(payload);
  const state = { ...emptyState(), skills: [candidate], bundles: [original, forged] };
  assert.throws(() => validateState(state), /Reused cases cannot be declared fresh/);
});

test('backup restore requires matching preview, confirmation, and current revision; restored item revisions defeat stale tabs', async t => {
  const { request, dataPath, root, stop, start } = await setup(t);
  const { candidate, bundle: b } = await createHTTPBundle(request);
  await request('/api/results', completedResults(b));
  const { profile } = await request('/api/profiles', { revision: 0, name: 'Original profile', model: MODEL, requirements: { minMeanScore: 60 } });
  const { shortlist } = await request('/api/shortlists', { revision: 0, name: 'Original shortlist', candidateIds: [candidate.id] });
  const { draft } = await request('/api/drafts', { revision: 0, name: 'Original draft', kind: 'evaluation', data: { bundleId: b.id, results: resultTemplate(b) } });
  const backup = await request('/api/backup');
  assert.equal(backup.hash, hash(backup.state));
  assert.equal(backup.format, 'skillforge-workspace');
  assert.equal(backup.version, 2);
  const bytes = await readFile(dataPath);
  const { preview } = await request('/api/restore-preview', { backup }, 200);
  assert.deepEqual(await readFile(dataPath), bytes, 'preview must not write workspace state');
  assert.equal(preview.summary.results, 1); assert.equal(preview.summary.drafts, 1);
  const restoreInput = { backup, token: preview.token, revision: preview.revision };
  await request('/api/restore', restoreInput, 409);
  await request('/api/restore', { ...restoreInput, confirm: false }, 409);
  await request('/api/restore', { ...restoreInput, confirm: true, token: 'not-issued' }, 409);
  await request('/api/restore', { ...restoreInput, confirm: true, revision: preview.revision + 1 }, 409);
  const alternate = structuredClone(backup); alternate.state.profiles[0].name = 'Different valid backup'; alternate.hash = hash(alternate.state);
  await request('/api/restore', { ...restoreInput, backup: alternate, confirm: true }, 409);
  assert.deepEqual(await readFile(dataPath), bytes);
  const { profile: edited } = await request('/api/profiles', updateItem(profile, { name: 'Newer profile edit' }));
  const afterEdit = await readFile(dataPath);
  await request('/api/restore', { ...restoreInput, confirm: true }, 409);
  assert.deepEqual(await readFile(dataPath), afterEdit);
  const fresh = (await request('/api/restore-preview', { backup }, 200)).preview;
  const { restored } = await request('/api/restore', { backup, token: fresh.token, revision: fresh.revision, confirm: true }, 200);
  assert.equal(restored.revision, fresh.revision + 1);
  assert.ok(restored.recoveryPath.startsWith(root + '/'));
  assert.deepEqual(await readFile(restored.recoveryPath), afterEdit, 'recovery preserves the exact replaced file');
  const actual = (await request('/api/backup')).state;
  const expected = structuredClone(backup.state); expected.revision = restored.revision;
  expected.profiles[0].revision = edited.revision + 1;
  expected.shortlists[0].revision = shortlist.revision + 1;
  expected.drafts[0].revision = draft.revision + 1;
  assert.deepEqual(actual, expected, 'only workspace and item revisions change while restoring complete private state');
  const restoredBytes = await readFile(dataPath);
  for (const [collection, old] of [['profiles', edited], ['shortlists', shortlist], ['drafts', draft]]) {
    await request(`/api/${collection}`, updateItem(old, { name: 'Stale tab after restore' }), 409);
  }
  await request('/api/restore', { backup, token: fresh.token, revision: fresh.revision, confirm: true }, 409);
  assert.deepEqual(await readFile(dataPath), restoredBytes);
  await stop();
  const reopened = await start();
  assert.deepEqual((await reopened.request('/api/backup')).state, expected);
  const report = (await reopened.request('/api/decision', { bundleId: b.id, profileId: profile.id }, 200)).report;
  assert.equal(report.choice.id, candidate.id);
});

test('corrupt backups fail hash and semantic validation without changing bytes, revision, or recovery files', async t => {
  const { request, dataPath, root } = await setup(t), { bundle: b } = await createHTTPBundle(request);
  await request('/api/results', completedResults(b));
  const backup = await request('/api/backup'), before = await readFile(dataPath), files = await readdir(root);
  const corruptions = [
    value => { value.state.skills[0].content += '\nTampered'; },
    value => { value.state.results[0].runs[0].candidateHash = hash('not the frozen candidate'); value.hash = hash(value.state); },
    value => { value.state.bundles[0].candidates[1].resources[0].base64 = Buffer.from('changed companion resource').toString('base64'); value.hash = hash(value.state); },
    value => { value.state.unrecognized = true; value.hash = hash(value.state); },
    value => { value.version = 1; },
  ];
  for (const corrupt of corruptions) {
    const broken = structuredClone(backup); corrupt(broken);
    await request('/api/restore-preview', { backup: broken }, 400);
    assert.deepEqual(await readFile(dataPath), before);
    assert.deepEqual(await readdir(root), files);
    assert.deepEqual(await request('/api/backup'), backup);
  }
});

test('v1 migration retains original bytes, exact bundle hashes/results, and content-only legacy evidence across restart', async t => {
  const root = await tempDirectory(t), dataPath = join(root, 'state.json');
  const legacySkill = skill('Legacy content-only fixture'); delete legacySkill.resources;
  const current = bundle([legacySkill]);
  const { caseSet, reusedFrom, caseReuseNotice, reusedCaseBundles, hash: currentHash, ...legacyBundle } = current;
  legacyBundle.version = 1;
  legacyBundle.protocol = 'Run every frozen case and repetition with the same declared model and conditions. The baseline has no skill instructions; candidates add only the frozen SKILL.md content.';
  legacyBundle.candidates = current.candidates.map(({ id, title, content }) => ({ id, title, content, hash: hash(content) }));
  legacyBundle.hash = hash(legacyBundle);
  const legacyResults = batch(legacyBundle);
  const v1 = { version: 1, skills: [legacySkill], bundles: [legacyBundle], results: [legacyResults] };
  assert.equal(validateState(v1), v1, 'current validation must still accept the exact old schema');
  const source = Buffer.from(' \n' + JSON.stringify(v1, null, 2) + '\n\t');
  await writeFile(dataPath, source);
  const migrated = await new Store(dataPath).load();
  assert.equal(migrated.state.version, 2);
  assert.equal(migrated.state.migration.originalHash, hash(source.toString('utf8')));
  const originalPath = `${dataPath}.v1-${hash(source.toString('utf8'))}.original.json`;
  assert.deepEqual(await readFile(originalPath), source);
  assert.deepEqual(migrated.state.bundles, v1.bundles);
  assert.deepEqual(migrated.state.results, v1.results);
  assert.ok(migrated.state.skills[0].resources.length > 0, 'live skill resources may be materialized without upgrading prior evidence');
  assert.equal(migrated.state.bundles[0].candidates[1].hash, hash(legacySkill.content));
  assert.notEqual(packHash(migrated.state.skills[0]), migrated.state.bundles[0].candidates[1].hash);
  for (const candidate of migrated.state.bundles[0].candidates) {
    for (const field of ['resources', 'manifest', 'hashScope', 'provenance', 'warnings']) assert.equal(Object.hasOwn(candidate, field), false);
  }
  const prompt = frozenPrompt(migrated.state.bundles[0], legacySkill.id, current.cases[0].id);
  assert.deepEqual(prompt.resources, []); assert.deepEqual(prompt.resourceManifest, []);
  assert.match(prompt.notice, /No companion resources were bound/);
  const report = decisionReport(migrated.state.bundles[0], migrated.state.results);
  assert.equal(report.evidence.bundleVersion, 1);
  assert.equal(report.evidence.bundleHash, legacyBundle.hash);
  assert.ok(report.qualifications.includes('Legacy evidence bound SKILL.md only, not resources.'));
  const firstMigrationBytes = await readFile(dataPath), files = await readdir(root);
  const reopened = await new Store(dataPath).load();
  assert.deepEqual(reopened.state, migrated.state);
  assert.deepEqual(await readFile(dataPath), firstMigrationBytes);
  assert.deepEqual(await readdir(root), files, 'a second load must not rewrite or remigrate historical evidence');
  assert.deepEqual(await readFile(originalPath), source);
});

test('exact revisions preserve all companion bytes and attribution without changing old bundles or transferring evidence', async t => {
  const root = await tempDirectory(t), dataPath = join(root, 'state.json');
  const source = skill('Resource-bearing revision fixture');
  source.provenance.license = 'Fixture attribution license';
  source.provenance.licenseText = 'Retain this exact upstream attribution notice.';
  source.resources.push({ path: 'references/binary-fixture.bin', base64: Buffer.from([0, 255, 13, 10, 128, 42]).toString('base64') });
  source.resources.push({ path: 'templates/preserved.txt', base64: Buffer.from('  exact resource whitespace\r\n\t').toString('base64') });
  const oldBundle = bundle([source]), originalSource = structuredClone(source), originalBundle = structuredClone(oldBundle);
  const result = batch(oldBundle), oldSummary = summarizeResults(oldBundle, [result]);
  const exact = ' \r\n' + source.content + '\n\tAn exact final revision line.\r\n  ';
  const revised = reviseSkill({ sourceId: source.id, title: 'Exact revised workflow', content: exact }, source);
  assert.notEqual(revised.id, source.id);
  assert.equal(revised.content, exact);
  assert.deepEqual(revised.resources, source.resources);
  assert.deepEqual(revised.provenance.adaptedFrom, { id: source.id, hash: packHash(source), contentHash: hash(source.content), provenance: source.provenance });
  assert.equal(revised.provenance.license, source.provenance.license);
  assert.equal(revised.provenance.licenseText, source.provenance.licenseText);
  assert.deepEqual(source, originalSource);
  assert.deepEqual(oldBundle, originalBundle);
  assert.throws(() => reviseSkill({ sourceId: source.id, content: source.content }, source), /must change the exact/);
  const newBundle = bundle([revised]);
  assert.notEqual(newBundle.candidates[1].hash, oldBundle.candidates[1].hash);
  assert.deepEqual(newBundle.candidates[1].resources, oldBundle.candidates[1].resources);
  assert.throws(() => validateResults(completedResults(oldBundle), newBundle), /Bundle identity or hash mismatch/);
  assert.deepEqual(summarizeResults(oldBundle, [result]), oldSummary);
  assert.equal(summarizeResults(newBundle, [result]).totalRuns, 0);
  const store = await new Store(dataPath).load();
  await store.mutate(state => { state.skills.push(source, revised); state.bundles.push(oldBundle, newBundle); state.results.push(result); });
  const reloaded = await new Store(dataPath).load();
  assert.deepEqual(reloaded.state.bundles[0], originalBundle);
  assert.deepEqual(reloaded.state.skills[1].resources, originalSource.resources);
  const oldPrompt = frozenPrompt(reloaded.state.bundles[0], source.id, oldBundle.cases[0].id);
  const revisedPrompt = frozenPrompt(reloaded.state.bundles[1], revised.id, newBundle.cases[0].id);
  assert.equal(oldPrompt.skillInstructions, originalSource.content);
  assert.equal(revisedPrompt.skillInstructions, exact);
  assert.equal(revisedPrompt.systemPrompt, newBundle.conditions.systemPrompt);
  assert.equal(revisedPrompt.caseInput, newBundle.cases[0].input);
  assert.deepEqual(revisedPrompt.resources, originalSource.resources);
  const binary = revisedPrompt.resources.find(resource => resource.path === 'references/binary-fixture.bin');
  assert.deepEqual(Buffer.from(binary.base64, 'base64'), Buffer.from([0, 255, 13, 10, 128, 42]));
  const baseline = frozenPrompt(reloaded.state.bundles[1], 'baseline', newBundle.cases[0].id);
  assert.equal(baseline.skillInstructions, ''); assert.deepEqual(baseline.resources, []);
  assert.equal(baseline.systemPrompt, revisedPrompt.systemPrompt); assert.equal(baseline.caseInput, revisedPrompt.caseInput);
});

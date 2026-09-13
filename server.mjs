import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { withLock } from './agent/workspace.mjs';
import { SkillforgeService } from './service.mjs';
import { allSkills, matchSkills, importSkills, exportCatalog, composeSkill, createBundle, validateResults, summarizeResults, resultTemplate, skillPack, Store, InputError, MAX_BODY, MAX_RESTORE, parseJSON, CAPABILITIES, saveMutable, reviseSkill, frozenPrompt, decisionReport, workspaceBackup, readBackup, workspaceSummary, hash } from './core.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const securityHeaders = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cache-Control': 'no-store',
};
const publicFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
async function body(req, limit = MAX_BODY) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) throw new InputError('Use Content-Type: application/json.', 415);
  if (Number(req.headers['content-length']) > limit) throw new InputError(`Request exceeds the ${limit / 1024 / 1024} MiB limit.`, 413);
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new InputError(`Request exceeds the ${limit / 1024 / 1024} MiB limit.`, 413); chunks.push(chunk); }
  return parseJSON(Buffer.concat(chunks).toString('utf8'));
}
export async function createApp({ dataPath = join(ROOT, 'data', 'state.json'), workspace } = {}) {
  if (workspace) dataPath = join(workspace, 'state.json');
  const store = await withLock(dirname(dataPath), () => new Store(dataPath).load(), { create: true });
  const restorePreviews = new Map();
  const server = http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries(securityHeaders)) res.setHeader(key, value);
    const json = (value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const download = (value, name, type = 'application/json; charset=utf-8') => { res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` }); res.end(Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2)); };
    try {
      const port = server.address()?.port;
      const host = `127.0.0.1:${port}`;
      if (req.headers.host !== host) throw new InputError(`Invalid Host. Open http://${host}.`, 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new InputError('Cross-origin requests are not allowed.', 403);
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new InputError('Cross-site requests are not allowed.', 403);
      if (req.method === 'POST' && req.headers.origin !== `http://${host}`) throw new InputError('Mutating requests require the exact local Origin header.', 403);
      if (req.url.length > 2000 || !req.url.startsWith('/') || req.url.startsWith('//')) throw new InputError('Invalid request target.');
      await withLock(dirname(dataPath), async () => {
      await store.load();
      const service = new SkillforgeService(dirname(dataPath)); service.store = store;
      const url = new URL(req.url, `http://${host}`);
      if (!['GET', 'POST'].includes(req.method)) throw new InputError('Method not allowed.', 405);
      if (req.method === 'GET' && Object.hasOwn(publicFiles, url.pathname)) {
        const [file, type] = publicFiles[url.pathname]; res.writeHead(200, { 'Content-Type': type }); return res.end(await readFile(join(ROOT, 'public', file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json({ version: 2, revision: store.state.revision, profiles: store.state.profiles, shortlists: store.state.shortlists, drafts: store.state.drafts, results: store.state.results, migration: store.state.migration || null, skills: allSkills(store.state), capabilities: CAPABILITIES, bundles: store.state.bundles.map(b => ({ ...b, observed: summarizeResults(b, store.state.results), demo: summarizeResults(b, store.state.results, 'demo') })), counts: { imported: store.state.skills.filter(s => s.provenance.status === 'untrusted-import').length, composed: store.state.skills.filter(s => s.provenance.status === 'local-authored').length, resultBatches: store.state.results.length }, notice: 'Local catalog discovery only. Match scores are heuristics; imported execution results are user-supplied and not independently verified.' });
      if (req.method === 'GET' && url.pathname === '/api/catalog') { const document = exportCatalog(allSkills(store.state)); if (Buffer.byteLength(JSON.stringify({ format: 'catalog', content: document })) > MAX_BODY - 65536) throw new InputError('Catalog exceeds the 4 MiB re-import limit. Use full private workspace backup instead.', 413); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="skillforge-catalog.json"' }); return res.end(JSON.stringify(document)); }
      if (req.method === 'GET' && url.pathname === '/api/backup') { const backup = workspaceBackup(store.state); res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="skillforge-private-workspace.json"' }); return res.end(JSON.stringify(backup)); }
      if (req.method === 'GET' && ['/api/prompts', '/api/runs'].includes(url.pathname)) {
        const b = store.state.bundles.find(b => b.id === url.searchParams.get('id')); if (!b) throw new InputError('Evaluation bundle not found.', 404);
        if (url.pathname === '/api/prompts') return json(frozenPrompt(b, url.searchParams.get('candidateId'), url.searchParams.get('caseId')));
        return json({ runs: store.state.results.filter(r => r.bundleId === b.id && r.kind === (url.searchParams.get('kind') === 'demo' ? 'demo' : 'observed')).flatMap(r => r.runs) });
      }
      if (req.method === 'GET' && url.pathname === '/api/pack') {
        const skill = allSkills(store.state).find(s => s.id === url.searchParams.get('id')); if (!skill) throw new InputError('Skill not found.', 404);
        const pack = skillPack(skill); return download(pack.buffer, pack.name, 'application/zip');
      }
      if (req.method === 'GET' && ['/api/bundle', '/api/results-template', '/api/results-export'].includes(url.pathname)) {
        const bundle = store.state.bundles.find(b => b.id === url.searchParams.get('id')); if (!bundle) throw new InputError('Evaluation bundle not found.', 404);
        if (url.pathname === '/api/bundle') return download(bundle, `evaluation-${bundle.id}.json`);
        if (url.pathname === '/api/results-template') return download(resultTemplate(bundle), `results-template-${bundle.id}.json`);
        const kind = url.searchParams.get('kind') === 'demo' ? 'demo' : 'observed';
        return download({ version: 1, bundleId: bundle.id, bundleHash: bundle.hash, modelId: bundle.model.id, conditionsHash: bundle.conditionsHash, kind, runs: store.state.results.filter(r => r.bundleId === bundle.id && r.kind === kind).flatMap(r => r.runs) }, `results-${kind}-${bundle.id}.json`);
      }
      if (req.method === 'POST') {
        const input = await body(req, ['/api/restore', '/api/restore-preview'].includes(url.pathname) ? MAX_RESTORE : MAX_BODY);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Request body must be a JSON object.');
        if (url.pathname === '/api/search') return json({ skills: matchSkills(allSkills(store.state), input?.query, input?.model) });
        if (['/api/profiles', '/api/drafts', '/api/shortlists'].includes(url.pathname)) { const collection = url.pathname.slice(5); const { item } = await service.save(collection, input); return json({ [collection === 'profiles' ? 'profile' : collection === 'drafts' ? 'draft' : 'shortlist']: item }, 201); }
        if (url.pathname === '/api/revisions') return json(await service.revise(input), 201);
        if (url.pathname === '/api/decision') return json(service.report(input.bundleId, input.requirements, input.profileId));
        if (url.pathname === '/api/restore-preview') {
          const state = readBackup(input.backup); const token = randomUUID();
          for (const [key, item] of restorePreviews) if (Date.now() - item.created > 600000) restorePreviews.delete(key);
          if (restorePreviews.size >= 20) restorePreviews.delete(restorePreviews.keys().next().value);
          restorePreviews.set(token, { hash: hash(input.backup), revision: store.state.revision, created: Date.now() });
          return json({ preview: { token, revision: store.state.revision, summary: workspaceSummary(state), current: workspaceSummary(store.state), notice: 'Replace the entire private workspace only after explicit confirmation. A local recoverable original copy is retained. Preview expires in ten minutes.' } });
        }
        if (url.pathname === '/api/restore') {
          const preview = restorePreviews.get(input.token);
          if (input.confirm !== true || !preview || Date.now() - preview.created > 600000 || preview.hash !== hash(input.backup) || preview.revision !== input.revision) throw new InputError('Restore requires a matching, fresh preview and explicit replacement confirmation.', 409);
          const restored = await store.restore(input.backup, input.revision); restorePreviews.clear(); return json({ restored });
        }
        if (url.pathname === '/api/import') return json(await service.import(input), 201);
        if (url.pathname === '/api/compose') return json(await service.compose(input), 201);
        if (url.pathname === '/api/bundles') return json(await service.createEvaluation(input), 201);
        if (url.pathname === '/api/results') return json(await service.results(input), 201);
      }
      throw new InputError('Route not found.', 404);
    }); } catch (error) { const clientError = error instanceof InputError || [400, 409, 413, 415].includes(error.status); if (!res.headersSent) json({ error: clientError ? error.message : 'Internal error. No change was committed; inspect the local server console.' }, error.status || 500); else res.end(); if (!clientError) console.error(error); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 40;
  return { server, store };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === await realpath(process.argv[1]).catch(() => '')) {
  if (process.argv.includes('--help')) {
    console.log('Skillforge — local skill discovery and evaluation workbench\n\nUsage: npm start [-- --port 4312]\n       npm test\n       node server.mjs --help\n\nBinds only to 127.0.0.1 (default port 4312). Open that exact address, not localhost.\nNo API keys, external fetches, . Data: ./data/state.json relative to the app.\nImport local SKILL.md/catalog JSON in Library. Compose portable ZIP packs.\nCompare candidates, export frozen evaluation bundles, run them yourself, and import observed results.\nSee in-app Field guide for schemas, limits, and evaluation caveats.');
  } else {
    const args = process.argv.slice(2); let port = 4312;
    if (args.length) { if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]) || Number(args[1]) < 1024 || Number(args[1]) > 65535) { console.error('Usage: node server.mjs [--port 1024..65535] [--help]'); process.exitCode = 1; } else port = Number(args[1]); }
    if (!process.exitCode) { try { const { server } = await createApp(); server.on('error', e => { console.error(`Unable to start Skillforge: ${e.message}`); process.exitCode = 1; }); server.listen(port, '127.0.0.1', () => console.log(`Skillforge is ready at http://127.0.0.1:${port}\nLocal files only. No model calls or automatic downloads. Press Ctrl+C to stop.`)); } catch (e) { console.error(e.message); process.exitCode = 1; } }
  }
}

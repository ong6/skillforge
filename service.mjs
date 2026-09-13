import path from 'node:path';
import { Store, allSkills, matchSkills, importSkills, composeSkill, reviseSkill, saveMutable, createBundle, validateResults, summarizeResults, frozenPrompt, decisionReport, resultTemplate, workspaceBackup, readBackup, hash, InputError } from './core.mjs';
export class SkillforgeService {
  constructor(root) { this.store = new Store(path.join(root, 'state.json')); }
  async open() { await this.store.load(); return this; }
  get state() { return this.store.state; }
  skills() { return allSkills(this.state); }
  skill(id) { const skill = this.skills().find(s => s.id === id); if (!skill) throw new InputError('Skill not found.', 404); return skill; }
  bundle(id) { const b = this.state.bundles.find(b => b.id === id); if (!b) throw new InputError('Evaluation bundle not found.', 404); return b; }
  async mutate(fn, dryRun = false) { if (dryRun) { const next = structuredClone(this.state); const result = await fn(next); const { validateState } = await import('./core.mjs'); validateState(next); return { ...result, dryRun: true }; } return this.store.mutate(fn); }
  import(input, dryRun = false) { return this.mutate(state => { const items = importSkills(input, state.skills); state.skills.push(...items); return { imported: items, count: items.length }; }, dryRun); }
  compose(input, dryRun = false) { return this.mutate(state => { if (state.skills.length >= 500) throw new InputError('Local catalog limit reached.'); const source = input.sourceId ? allSkills(state).find(s => s.id === input.sourceId) : null; if (input.sourceId && !source) throw new InputError('Adaptation source not found.'); const skill = composeSkill(input, source); state.skills.push(skill); return { skill }; }, dryRun); }
  revise(input, dryRun = false) { return this.mutate(state => { if (state.skills.length >= 500) throw new InputError('Local catalog limit reached.'); const skill = reviseSkill(input, allSkills(state).find(s => s.id === input.sourceId)); state.skills.push(skill); return { skill }; }, dryRun); }
  save(collection, input, dryRun = false) { return this.mutate(state => ({ item: saveMutable(state, collection, input) }), dryRun); }
  createEvaluation(input, dryRun = false) { return this.mutate(state => {
    if (state.bundles.length >= 100) throw new InputError('Evaluation bundle limit reached.');
    const b = createBundle(input, allSkills(state)); const reused = state.bundles.filter(old => old.cases.some(c => b.cases.some(n => n.input === c.input)));
    if (b.caseSet === 'held-out' && reused.length) throw new InputError('Previously used inputs are development cases, not held-out evidence.');
    if (b.reusedFrom && !state.bundles.some(old => old.id === b.reusedFrom)) throw new InputError('Unknown reusedFrom bundle.');
    if (reused.length) { b.reusedCaseBundles = reused.map(old => old.id); b.caseReuseNotice = 'Cases reused from earlier bundles. Development evidence only; not independent held-out validation.'; const { hash: ignored, ...payload } = b; b.hash = hash(payload); }
    state.bundles.push(b); return { bundle: b };
  }, dryRun); }
  results(input, dryRun = false) { return this.mutate(state => { const b = state.bundles.find(b => b.id === input.bundleId); if (!b) throw new InputError('Unknown evaluation bundle.'); const result = validateResults(input, b, state.results); state.results.push(result); return { result }; }, dryRun); }
  report(bundleId, requirements, profileId) { const b = this.bundle(bundleId), profile = profileId ? this.state.profiles.find(p => p.id === profileId) : null; if (profileId && !profile) throw new InputError('Unknown saved profile.'); const report = decisionReport(b, this.state.results, requirements ?? profile?.requirements); report.executionProvenance = this.state.results.filter(r => r.bundleId === bundleId).map(r => ({ resultBatchId: r.id, kind: r.kind, ...(r.executionProvenance || { executor: 'unspecified', judge: 'unspecified', environment: 'unspecified' }) })); report.qualifications.push('Executor and judge provenance are self-reported, not identity attestations.'); if (profile) { report.profile = structuredClone(profile); if (profile.model && hash(profile.model) !== hash(b.model)) { report.status = 'insufficient-evidence'; report.choice = null; report.qualifications.push('Selected profile model declaration does not match this frozen bundle; no choice is justified for that profile.'); } } return { report }; }
}

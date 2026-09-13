import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ fileBytes: 1048576, totalBytes: 2097152, fileCount: 100 });
const fail = (message, status = 400) => { const error = new Error(message); error.name = 'InputError'; error.status = status; throw error; };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fold = path => path.toUpperCase().toLowerCase().normalize('NFC');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const companions = ['examples.json', 'evaluation.json', 'provenance.json'];

export function safePath(path) {
  if (typeof path !== 'string' || !path || path !== path.normalize('NFC') || Buffer.byteLength(path) > 240 || /[\\:\p{Cc}\p{Cf}\p{Cs}]/u.test(path)) fail('Unsafe pack path: use an NFC relative slash path of at most 240 bytes.');
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail('Unsafe pack path: empty, dot, parent, or trailing dot/space segments are forbidden.');
  return path;
}

function record(value, allowed, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be a plain object.`);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowed.includes(key) || !Object.getOwnPropertyDescriptor(value, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(value, key))) fail(`${name} contains an unsupported field or property.`);
  }
  return value;
}

function decode(base64) {
  if (typeof base64 !== 'string') fail('Resource base64 must be a string.');
  if (base64.length > 4 * Math.ceil(LIMITS.fileBytes / 3)) fail('Resource exceeds the 1 MiB file byte limit.', 413);
  if (base64.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) fail('Resource must use strict canonical base64.');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.toString('base64') !== base64) fail('Resource must use strict canonical base64 padding bits.');
  if (bytes.length > LIMITS.fileBytes) fail('Resource exceeds the 1 MiB file byte limit.', 413);
  return bytes;
}

function validateFiles(value, { allowSkill = false, folder = false } = {}) {
  if (!Array.isArray(value)) fail('Resources must be an array.');
  if (value.length > LIMITS.fileCount) fail('Pack file count exceeds the 100 file limit.', 413);
  let total = 0;
  const seen = new Set();
  const files = [];
  for (const entry of value) {
    record(entry, folder ? ['path', 'base64', 'type'] : ['path', 'base64'], 'Resource');
    if (folder && Object.hasOwn(entry, 'type') && entry.type !== 'file') fail('Folder entries must be regular files; links and other types are unsupported.');
    const path = safePath(entry.path), key = fold(path);
    if (!allowSkill && (key === 'skill.md' || key.startsWith('skill.md/'))) fail('Root SKILL.md is reserved for skill content.');
    if (seen.has(key)) fail('Duplicate case-folded resource path.');
    seen.add(key);
    total += decode(entry.base64).length;
    if (total > LIMITS.totalBytes) fail('Pack exceeds the 2 MiB total byte limit.', 413);
    files.push({ path, base64: entry.base64 });
  }
  for (const path of seen) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (seen.has(parts.slice(0, i).join('/'))) fail('Pack paths conflict: a file cannot also be a directory.');
  }
  return files.sort((a, b) => compare(a.path, b.path));
}

export function validateResources(value = []) { return validateFiles(value); }

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort(compare).map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function jsonResource(path, value) {
  // JSON roundtripping matches ordinary JSON data semantics before sorting keys.
  let data;
  try { data = JSON.parse(JSON.stringify(value)); } catch { fail(`Cannot serialize authored ${path} as JSON.`); }
  return { path, base64: Buffer.from(canonical(data) + '\n').toString('base64') };
}

export function materializeResources(skill) {
  if (!skill || typeof skill !== 'object' || Array.isArray(skill)) fail('Skill must be an object.');
  // Explicit resources are the authoritative pack, even when empty. This keeps
  // imported bytes stable when display metadata, trust labels, or IDs change.
  if (skill.resources !== undefined) return validateResources(skill.resources);
  const examples = skill.examples ?? [];
  return validateResources([
    jsonResource('examples.json', examples),
    jsonResource('evaluation.json', skill.evaluation ?? { version: 1, status: 'unexecuted authored cases', cases: examples }),
    jsonResource('provenance.json', skill.provenance ?? {}),
  ]);
}

function packEntries(skill) {
  const resources = materializeResources(skill);
  if (typeof skill.content !== 'string' || skill.content.length > 120000 || /[\u0000]/.test(skill.content)) fail('SKILL.md must be text of at most 120000 characters without NUL bytes.');
  const content = Buffer.from(skill.content);
  if (content.toString('utf8') !== skill.content) fail('SKILL.md must contain valid Unicode text.');
  const entries = [{ path: 'SKILL.md', bytes: content }, ...resources.map(resource => ({ path: resource.path, bytes: decode(resource.base64) }))];
  if (entries.length > LIMITS.fileCount) fail('Pack file count including SKILL.md exceeds the 100 file limit.', 413);
  if (entries.some(entry => entry.bytes.length > LIMITS.fileBytes) || entries.reduce((sum, entry) => sum + entry.bytes.length, 0) > LIMITS.totalBytes) fail('Pack including SKILL.md exceeds the file or total byte limits.', 413);
  return { entries, resources };
}

export function packHash(skill) {
  const { resources } = packEntries(skill);
  return digest(canonical({ content: skill.content, resources }));
}

export function packManifest(skill) {
  return packEntries(skill).entries.sort((a, b) => compare(a.path, b.path)).map(({ path, bytes }) => ({ path, bytes: bytes.length, sha256: digest(bytes) }));
}

function rootSlug(skill) {
  const frontmatter = skill.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const declared = frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  if (declared && /^[a-z0-9][a-z0-9-]{0,63}$/.test(declared)) return declared;
  return (typeof skill.title === 'string' ? skill.title : 'skill').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '') || 'skill';
}

export function makePackFiles(skill) {
  const { entries } = packEntries(skill), root = rootSlug(skill);
  const rank = path => path === 'SKILL.md' ? 0 : companions.includes(path) ? companions.indexOf(path) + 1 : 4;
  entries.sort((a, b) => rank(a.path) - rank(b.path) || compare(a.path, b.path));
  return Object.fromEntries(entries.map(({ path, bytes }) => [safePath(`${root}/${path}`), bytes]));
}

export function importFolder(files) {
  const checked = validateFiles(files, { allowSkill: true, folder: true });
  const skills = checked.filter(file => fold(file.path.split('/').at(-1)) === 'skill.md');
  if (skills.length !== 1 || skills[0].path.split('/').at(-1) !== 'SKILL.md') fail('Folder must contain exactly one SKILL.md at root or inside one enclosing root.');
  const skillFile = skills[0], parts = skillFile.path.split('/');
  if (parts.length > 2) fail('SKILL.md may only be at root or inside one enclosing root.');
  const prefix = parts.length === 2 ? parts[0] + '/' : '';
  if (prefix && checked.some(file => !file.path.startsWith(prefix))) fail('All folder files must share the single SKILL.md enclosing root.');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(decode(skillFile.base64)); } catch { fail('SKILL.md must contain valid UTF-8 text.'); }
  if (content.trim().length < 20 || content.length > 120000 || content.includes('\u0000')) fail('SKILL.md must contain between 20 and 120000 text characters without NUL bytes.');
  const resources = validateResources(checked.filter(file => file !== skillFile).map(file => ({ path: file.path.slice(prefix.length), base64: file.base64 })));
  const result = { content, resources };
  packEntries(result);
  return result;
}

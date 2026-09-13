import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LIMITS, safePath, validateResources, materializeResources, packHash, packManifest, makePackFiles, importFolder } from '../packs.mjs';

const content = '---\r\nname: portable-pack\r\ndescription: Inert portable workflow.\r\n---\r\n\r\n# Workflow\r\nReview supplied bytes only.\r\n';
const resource = (path, bytes = '') => ({ path, base64: Buffer.from(bytes).toString('base64') });
const folder = (skill, root = '') => [resource(root + 'SKILL.md', skill.content), ...(skill.resources || []).map(file => ({ ...file, path: root + file.path }))];
const invalid = callback => assert.throws(callback, error => error.status === 400);
const tooLarge = callback => assert.throws(callback, error => error.status === 413);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('safe paths preserve NFC Unicode and reject ambiguous or escaping paths', () => {
  assert.deepEqual(LIMITS, { fileBytes: 1048576, totalBytes: 2097152, fileCount: 100 });
  for (const path of ['assets/image.png', 'café/输入.txt', 'notes with spaces.txt', '.hidden/config', 'a'.repeat(240)]) assert.equal(safePath(path), path);
  for (const path of ['', null, 7, '/absolute', '//server/file', 'C:/file', 'a\\b', './file', '../file', 'a/../b', 'a/./b', 'a//b', 'a/', 'file.', 'a /file', 'a./file', 'file ', 'cafe\u0301.txt', 'a\nfile', 'a\u0000file', 'a\u007ffile', 'a\u0085file', 'a\u202efile', '\ud800', 'a'.repeat(241), 'é'.repeat(121)]) invalid(() => safePath(path));
});

test('resources have exact schemas, canonical sorting, and immutable validation', () => {
  const source = [resource('z.bin', Buffer.from([0, 255])), resource('a.txt', 'text')];
  const before = structuredClone(source), checked = validateResources(source);
  assert.deepEqual(checked.map(file => file.path), ['a.txt', 'z.bin']);
  assert.deepEqual(source, before);
  assert.notEqual(checked[0], source[1]);
  assert.deepEqual(validateResources(), []);
  for (const value of [null, {}, 'files', [null], [resource('SKILL.md')], [resource('skill.MD')], [resource('SKILL.md/child')], [{ ...resource('file'), type: 'file' }], [{ ...resource('file'), mode: 0o120777 }]]) invalid(() => validateResources(value));
  const getter = { path: 'file', get base64() { assert.fail('Resource accessor must not execute'); } };
  invalid(() => validateResources([getter]));
});

test('duplicate case-folded and file-directory collision paths are rejected', () => {
  for (const files of [[resource('a'), resource('a')], [resource('Assets/file'), resource('assets/FILE')], [resource('Straße'), resource('STRASSE')], [resource('a'), resource('A/child')], [resource('a/child'), resource('A')]]) invalid(() => validateResources(files));
  assert.equal(validateResources([resource('a/x'), resource('a/y')]).length, 2);
});

test('strict base64 rejects invalid alphabets, whitespace, padding, and noncanonical bits', () => {
  for (const base64 of ['', 'AA==', 'AAA=', 'AAAA', '/w==']) assert.equal(validateResources([{ path: 'file', base64 }])[0].base64, base64);
  for (const base64 of [undefined, null, 12, 'A', 'AA', 'AAA', 'AA=', 'A===', 'AA===', '=AAA', 'AAAA=', 'AA==\n', ' AA==', 'AA-_', 'AB==', 'AAB=', 'a===']) invalid(() => validateResources([{ path: 'file', base64 }]));
});

test('resource size and file-count limits reject excess before returning any data', () => {
  const max = Buffer.alloc(LIMITS.fileBytes, 123), first = resource('first', max), second = resource('second', max);
  assert.equal(validateResources([first, second]).length, 2);
  tooLarge(() => validateResources([resource('large', Buffer.alloc(LIMITS.fileBytes + 1))]));
  tooLarge(() => validateResources([first, second, resource('extra', 'x')]));
  const files = Array.from({ length: LIMITS.fileCount }, (_, i) => resource(`file-${i}`));
  assert.equal(validateResources(files).length, LIMITS.fileCount);
  tooLarge(() => validateResources([...files, resource('extra')]));
  const before = structuredClone(files);
  invalid(() => validateResources([...files.slice(1), resource('../unsafe')]));
  assert.deepEqual(files, before);
});

test('authored companions are deterministic; explicit arrays are authoritative and exact', () => {
  const skill = { content, id: 'first-id', title: 'Original title', createdAt: 'yesterday', examples: [{ expected: 'Keep bytes', input: 'Task' }], provenance: { source: 'Local', author: 'Person' } };
  const files = materializeResources(skill);
  assert.deepEqual(files.map(file => file.path), ['evaluation.json', 'examples.json', 'provenance.json']);
  assert.equal(JSON.parse(Buffer.from(files[0].base64, 'base64')).status, 'unexecuted authored cases');
  const reordered = { ...skill, id: 'different', title: 'Other', createdAt: 'tomorrow', examples: [{ input: 'Task', expected: 'Keep bytes' }], provenance: { author: 'Person', source: 'Local' } };
  assert.deepEqual(materializeResources(skill), materializeResources(reordered));
  assert.equal(packHash(skill), packHash(reordered));
  assert.notEqual(packHash(skill), packHash({ ...skill, examples: [{ input: 'Changed task', expected: 'Keep bytes' }] }));
  assert.notEqual(packHash(skill), packHash({ ...skill, evaluation: { status: 'Other authored case set' } }));
  assert.notEqual(packHash(skill), packHash({ ...skill, provenance: { source: 'Other authored source' } }));
  const exact = [resource('examples.json', ' { "raw": true }\r\n'), resource('evaluation.json', Buffer.from([0xff, 0x00])), resource('provenance.json', 'not JSON\n')];
  assert.deepEqual(materializeResources({ ...skill, resources: exact }), validateResources(exact));
  assert.equal(packHash({ ...skill, resources: exact }), packHash({ content, resources: exact, provenance: { status: 'untrusted-import' }, examples: [], evaluation: {} }));
  assert.deepEqual(materializeResources({ ...skill, resources: [] }), []);
  assert.deepEqual(materializeResources({ content, resources: [resource('only.bin')] }), [resource('only.bin')]);
});

test('complete pack hashes include content and exact paths and bytes but not resource order', () => {
  const skill = { content, resources: [resource('z', Buffer.from([0, 255])), resource('a', 'A')] };
  const hash = packHash(skill);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(hash, packHash({ ...skill, resources: [...skill.resources].reverse() }));
  assert.notEqual(hash, packHash({ ...skill, content: content + '\n' }));
  assert.notEqual(hash, packHash({ ...skill, resources: [resource('z', Buffer.from([0, 254])), resource('a', 'A')] }));
  assert.notEqual(hash, packHash({ ...skill, resources: [resource('Z', Buffer.from([0, 255])), resource('a', 'A')] }));
  assert.notEqual(hash, packHash({ ...skill, resources: [resource('z', Buffer.from([0, 255]))] }));
  assert.notEqual(packHash({ content, resources: [] }), packHash({ content }));
});

test('manifests cover SKILL.md and binary resources with exact byte digests', () => {
  const bytes = Buffer.from([0, 0xff, 0xfe, 0x80, 13, 10]);
  const manifest = packManifest({ content, resources: [resource('assets/binary', bytes)] });
  assert.deepEqual(manifest, [{ path: 'SKILL.md', bytes: Buffer.byteLength(content), sha256: sha256(content) }, { path: 'assets/binary', bytes: bytes.length, sha256: sha256(bytes) }]);
  assert.deepEqual(packManifest({ content: '', resources: [] }), [{ path: 'SKILL.md', bytes: 0, sha256: sha256('') }]);
});

test('all full-pack operations enforce limits including SKILL.md', () => {
  const operations = [packHash, packManifest, makePackFiles];
  const full = [resource('one', Buffer.alloc(LIMITS.fileBytes)), resource('two', Buffer.alloc(LIMITS.fileBytes))];
  for (const operation of operations) {
    tooLarge(() => operation({ content, resources: full }));
    tooLarge(() => operation({ content, resources: Array.from({ length: 100 }, (_, i) => resource(`f${i}`)) }));
    invalid(() => operation({ content: 'x'.repeat(120001), resources: [] }));
    invalid(() => operation({ content: '\ud800', resources: [] }));
  }
  const exact = { content, resources: [resource('one', Buffer.alloc(LIMITS.fileBytes)), resource('two', Buffer.alloc(LIMITS.fileBytes - Buffer.byteLength(content)))] };
  assert.equal(packManifest(exact).reduce((total, entry) => total + entry.bytes, 0), LIMITS.totalBytes);
  assert.equal(packManifest({ content, resources: Array.from({ length: 99 }, (_, i) => resource(`f${i}`)) }).length, 100);
});

test('pack files use safe roots, deterministic entry order, and Buffers', () => {
  const skill = { content, examples: [], provenance: {} }, files = makePackFiles(skill);
  assert.deepEqual(Object.keys(files), ['portable-pack/SKILL.md', 'portable-pack/examples.json', 'portable-pack/evaluation.json', 'portable-pack/provenance.json']);
  assert.ok(Object.values(files).every(Buffer.isBuffer));
  assert.equal(files['portable-pack/SKILL.md'].toString(), content);
  const fallback = makePackFiles({ content: '# Invalid frontmatter but valid content.', title: '../../Bäd\\ROOT: title', resources: [] });
  assert.deepEqual(Object.keys(fallback), ['ba-d-root-title/SKILL.md']);
  invalid(() => makePackFiles({ content, resources: [resource('x'.repeat(240))] }));
});

test('root and enclosing-root folder imports preserve all inert bytes and hashes', () => {
  const skill = { content: '\ufeff' + content, resources: [resource('assets/payload.bin', Buffer.from([0, 255, 254, 128])), resource('scripts/do-not-run.sh', '#!/bin/sh\nexit 99\n'), resource('examples.json', '{"examples":[]}\r\n'), resource('provenance.json', 'opaque metadata bytes')] };
  for (const root of ['', 'selected-folder/']) {
    const files = folder(skill, root), before = structuredClone(files), imported = importFolder(files);
    assert.equal(imported.content, skill.content);
    assert.deepEqual(imported.resources, validateResources(skill.resources));
    assert.equal(packHash(imported), packHash(skill));
    assert.deepEqual(files, before);
  }
  const authored = { content, examples: [{ input: 'A task', expected: 'A response' }], provenance: { source: 'Local' } };
  const files = makePackFiles(authored);
  const imported = importFolder(Object.entries(files).map(([path, bytes]) => resource(path, bytes)));
  assert.equal(packHash(imported), packHash(authored));
  assert.deepEqual(makePackFiles(imported), files);
  assert.deepEqual(importFolder([{ ...resource('SKILL.md', content), type: 'file' }]), { content, resources: [] });
});

test('ZIP local entries preserve binary buffers and reimport as the identical pack', async () => {
  const { makeZip } = await import('../core.mjs');
  const skill = { content, resources: [resource('assets/all-bytes.bin', Buffer.from(Array.from({ length: 256 }, (_, i) => i))), resource('examples.json', ' { "raw": true }\r\n'), resource('evaluation.json', Buffer.from([0xff, 0x00])), resource('provenance.json', 'opaque\r\n')] };
  const files = makePackFiles(skill), archive = makeZip(files), importedFiles = [];
  let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const size = archive.readUInt32LE(offset + 18), nameLength = archive.readUInt16LE(offset + 26), extraLength = archive.readUInt16LE(offset + 28);
    const path = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength, bytes = archive.subarray(start, start + size);
    assert.deepEqual(bytes, files[path]);
    importedFiles.push(resource(path, bytes));
    offset = start + size;
  }
  assert.equal(archive.readUInt32LE(offset), 0x02014b50);
  assert.equal(importedFiles.length, Object.keys(files).length);
  const imported = importFolder(importedFiles);
  assert.equal(packHash(imported), packHash(skill));
  assert.deepEqual(makePackFiles(imported), files);
});

test('folder validation atomically rejects multiple roots, traversal, missing skills and links', () => {
  const skill = resource('SKILL.md', content);
  const cases = [[], [resource('other.txt')], [resource('skill.md', content)], [skill, resource('nested/SKILL.md', content)], [resource('a/b/SKILL.md', content)], [resource('a/SKILL.md', content), resource('b/file')], [resource('a/SKILL.md', content), resource('other')], [skill, resource('../file')], [skill, resource('A'), resource('a')], [skill, { ...resource('link'), type: 'symlink' }], [skill, { ...resource('link'), type: 'directory' }], [skill, { ...resource('link'), type: null }], [skill, { ...resource('link'), target: '/etc/passwd' }], [skill, { ...resource('link'), mode: 0o120777 }], [skill, { ...resource('link'), symlink: true }], [skill, { ...resource('link'), lastModified: 123 }]];
  for (const files of cases) { const before = structuredClone(files); invalid(() => importFolder(files)); assert.deepEqual(files, before); }
});

test('folder markdown requires fatal UTF-8 and bounded exact text', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82]), Buffer.from('too short'), Buffer.from(' '.repeat(30)), Buffer.from(content + '\u0000'), Buffer.from('x'.repeat(120001))]) invalid(() => importFolder([resource('SKILL.md', bytes)]));
  assert.equal(importFolder([resource('SKILL.md', 'x'.repeat(120000))]).content.length, 120000);
  const full = [resource('SKILL.md', content), resource('one', Buffer.alloc(LIMITS.fileBytes)), resource('two', Buffer.alloc(LIMITS.fileBytes))];
  tooLarge(() => importFolder(full));
  tooLarge(() => importFolder([resource('SKILL.md', content), ...Array.from({ length: 100 }, (_, i) => resource(`f${i}`))]));
});

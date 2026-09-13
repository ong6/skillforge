import { constants } from 'node:fs';
import { open, lstat, mkdir, realpath, unlink, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const fingerprint = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const fault = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
export async function readJSON(file, max = 64 * 1024 * 1024) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > max) throw fault('UNSAFE_FILE', 'Expected a bounded regular file.'); const text = await handle.readFile('utf8'); if (Buffer.byteLength(text) > max) throw fault('TOO_LARGE', 'File exceeds byte limit.', 413); return JSON.parse(text); } finally { await handle.close(); }
}
export async function writeJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`; let handle;
  try { handle = await open(temp, 'wx', 0o600); await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null; await rename(temp, file); }
  finally { if (handle) await handle.close(); await unlink(temp).catch(() => {}); }
}
export async function directory(value, create = false) {
  const target = path.resolve(value);
  // Do not follow symlinks in any existing workspace path component.
  const parts = target.split(path.sep).filter(Boolean); let current = path.parse(target).root;
  for (const part of parts) { current = path.join(current, part); try { const stat = await lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('UNSAFE_WORKSPACE', 'Workspace components must be real directories.'); } catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) throw fault('NOT_INITIALIZED', 'Workspace not found. Run init with --workspace PATH.', 404); await mkdir(current, { mode: 0o700 }); } }
  return realpath(target);
}
export async function withLock(value, action, { create = false, timeout = 5000 } = {}) {
  const root = await directory(value, create), file = path.join(root, '.agent.lock');
  const deadline = Date.now() + timeout; let handle;
  while (!handle) {
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw fault('WORKSPACE_BUSY', 'Workspace locked. Retry; if its owner crashed, inspect .agent.lock before manually recovering it.', 409); await new Promise(resolve => setTimeout(resolve, 25)); }
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await handle.sync(); return await action(root); }
  finally { await handle.close(); await unlink(file); }
}
export async function initialized(root, product) {
  root = await directory(root);
  let marker; try { marker = await readJSON(path.join(root, '.agent-workspace.json'), 1024); } catch (error) { if (error.code === 'ENOENT') throw fault('NOT_INITIALIZED', 'Run init --workspace PATH before using agent operations.', 404); throw error; }
  if (marker.product !== product || marker.version !== 1) throw fault('WORKSPACE_MISMATCH', 'Workspace belongs to another product or unsupported version.');
}
export async function markInitialized(root, product) {
  const file = path.join(root, '.agent-workspace.json');
  try { await initialized(root, product); } catch (error) { if (error.code !== 'NOT_INITIALIZED') throw error; await writeJSON(file, { product, version: 1 }); }
}
export async function workspaceFile(root, relative, { existing = true } = {}) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw fault('UNSAFE_PATH', 'Use a non-hidden workspace-relative path without dot or parent segments.');
  const file = path.join(root, relative); let current = root;
  for (const [i, part] of relative.split('/').entries()) { current = path.join(current, part); try { const stat = await lstat(current); if (stat.isSymbolicLink() || (i < relative.split('/').length - 1 && !stat.isDirectory())) throw fault('UNSAFE_PATH', 'Symlinks and non-directory parents are forbidden.'); } catch (error) { if (error.code !== 'ENOENT' || existing || current !== file) throw error; } }
  return file;
}
export async function restorePreview(root, input, currentRevision) {
  const file = path.join(root, '.restore-preview.json');
  const binding = fingerprint({ backup: input.backup, currentRevision, target: input.pilotId || null });
  if (input.dryRun) { const token = randomUUID(); await writeJSON(file, { token, binding, expires: Date.now() + 600000 }); return token; }
  let saved; try { saved = await readJSON(file, 4096); } catch { throw fault('PREVIEW_REQUIRED', 'Preview this exact backup against the current workspace before restoring.', 409); }
  if (!input.confirm || saved.token !== input.previewToken || saved.binding !== binding || saved.expires < Date.now()) throw fault('PREVIEW_REQUIRED', 'Restore preview expired or differs from this backup, target, or revision. Preview again.', 409);
}

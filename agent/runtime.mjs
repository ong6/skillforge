import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { withLock, initialized, markInitialized, fault } from './workspace.mjs';

export { z };
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const revision = z.union([z.string().min(1).max(200), z.number().int().nonnegative()]);
export const page = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(25) };
export const paginate = (items, { offset, limit }) => ({ items: items.slice(offset, offset + limit), total: items.length, nextOffset: offset + limit < items.length ? offset + limit : null });
export function operation(description, shape, run, { write = false, destructive = false, after } = {}) { return { description, schema: z.strictObject(shape), run, write, destructive, after }; }
export function errorResult(error) { return { code: error.code || (error.name === 'ZodError' || error.name === 'ValidationError' || error.status === 400 ? 'INVALID_INPUT' : error.status === 409 ? 'CONFLICT' : 'OPERATION_FAILED'), message: error.message, ...(error.issues ? { issues: error.issues } : {}) }; }
export function makeProduct(name, operations, initialize) {
  const describe = () => ({ product: name, version: '2.0.0', protocolVersion: 1, operations: Object.entries(operations).map(([name, op]) => ({ name, description: op.description, mutates: op.write, destructive: op.destructive, inputSchema: z.toJSONSchema(op.schema), outputSchema: { type: 'object', required: ['version', 'ok', 'operation', 'data'], properties: { version: { const: 1 }, ok: { const: true }, operation: { type: 'string' }, data: { type: 'object' } }, additionalProperties: false } })) });
  async function execute(command, input, options) {
    const op = operations[command]; if (!op) throw fault('UNKNOWN_OPERATION', `Unknown operation ${command}; use commands.`);
    const parsed = op.schema.parse(input);
    if (options.readOnly && op.write) throw fault('READ_ONLY', 'This session permits read-only operations.', 403);
    if (!options.workspace) throw fault('WORKSPACE_REQUIRED', 'Supply --workspace PATH.');
    const prepared = await withLock(options.workspace, async root => { await initialized(root, name); return op.run(parsed, { ...options, root }); });
    const data = op.after ? await op.after(prepared, parsed) : prepared;
    return { version: 1, ok: true, operation: command, data };
  }
  return { name, operations, describe, execute, async init(options) { if (options.readOnly) throw fault('READ_ONLY', 'Cannot initialize in read-only mode.', 403); if (!options.workspace) throw fault('WORKSPACE_REQUIRED', 'Supply --workspace PATH.'); return withLock(options.workspace, async root => { try { await initialized(root, name); } catch (error) { if (error.code !== 'NOT_INITIALIZED') throw error; } await initialize(root); await markInitialized(root, name); return { version: 1, ok: true, operation: 'init', data: { workspace: root, product: name } }; }, { create: true }); } };
}
async function mcp(product, options) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  if (!options.workspace) throw fault('WORKSPACE_REQUIRED', 'Configure --workspace PATH.');
  const server = new McpServer({ name: product.name, version: '2.0.0' });
  for (const [name, op] of Object.entries(product.operations)) {
    if (options.readOnly && op.write) continue;
    server.registerTool(name.replaceAll('.', '_'), { description: op.description, inputSchema: op.schema, annotations: { readOnlyHint: !op.write, destructiveHint: op.destructive, openWorldHint: false } }, async input => { try { const result = await product.execute(name, input, { ...options, transport: 'mcp' }); return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result }; } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ version: 1, ok: false, error: errorResult(error) }) }] }; } });
  }
  server.registerResource('operation-schemas', `${product.name}://schemas`, { mimeType: 'application/json', description: 'Versioned command contracts and workspace safety rules.' }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(product.describe()) }] }));
  await server.connect(new StdioServerTransport());
}
export async function cli(product, argv = process.argv.slice(2)) {
  let outputHandle, completedResult;
  try {
    const options = { transport: 'cli' }; const words = []; let inputSource, output;
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]; if (a === '--read-only') options.readOnly = true;
      else if (a === '--json') continue;
      else if (['--workspace', '--input', '--output', '--port'].includes(a)) { const value = argv[++i]; if (!value || value.startsWith('--')) throw fault('INVALID_ARGUMENT', `${a} needs a value.`); if (a === '--workspace') options.workspace = path.resolve(value); else if (a === '--input') inputSource = value; else if (a === '--port') { if (!/^\d+$/.test(value) || +value > 65535) throw fault('INVALID_ARGUMENT', 'Port must be 0..65535.'); options.port = +value; } else output = value; }
      else if (a.startsWith('-') && !['--help', '-h', '--version'].includes(a)) throw fault('INVALID_ARGUMENT', `Unknown option ${a}`);
      else words.push(a);
    }
    const command = words.join('.'); let result;
    // Reject unavailable output destinations before executing a mutation.
    if (output) { if (['ui', 'mcp'].includes(command)) throw fault('INVALID_ARGUMENT', 'Streaming commands do not accept --output.'); outputHandle = await open(path.resolve(output), 'wx', 0o600); }
    if (!command || ['--help', '-h', 'help'].includes(command)) result = { product: product.name, usage: `${product.name} <command> [--workspace PATH] [--input file.json|-] [--output FILE] [--read-only]`, commands: ['init', 'commands', 'doctor', 'setup', 'mcp', 'ui', ...Object.keys(product.operations)], notice: 'JSON stdout; diagnostics on stderr. init is explicit. Mutations require revisions when updating existing records. --output never overwrites files.' };
    else if (command === '--version') result = { product: product.name, version: '2.0.0', protocolVersion: 1 };
    else if (command === 'commands') result = product.describe();
    else if (command === 'setup') result = { mcpServers: { [product.name]: { command: process.execPath, args: [path.resolve(process.argv[1]), 'mcp', '--workspace', options.workspace || '/absolute/path/to/initialized/workspace', ...(options.readOnly ? ['--read-only'] : [])] } }, notice: 'Configuration example only; no agent files modified.' };
    else if (command === 'doctor') result = { product: product.name, node: process.version, workspace: options.workspace || null, initialized: options.workspace ? await initialized(options.workspace, product.name).then(() => true).catch(() => false) : false, protocolVersion: 1 };
    else if (command === 'ui') { if (!options.workspace) throw fault('WORKSPACE_REQUIRED', 'Supply --workspace PATH.'); if (options.readOnly) throw fault('READ_ONLY', 'The editing UI is unavailable in read-only mode.', 403); await initialized(options.workspace, product.name); const module = await import(new URL(product.name === 'skillforge' ? '../server.mjs' : '../server.js', import.meta.url)); const app = await module.createApp({ workspace: options.workspace }); const server = app.server || app; await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); }); process.stdout.write(JSON.stringify({ version: 1, ok: true, url: `http://127.0.0.1:${server.address().port}` }) + '\n'); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(() => process.exit(0)); }); return; }
    else if (command === 'mcp') { if (inputSource || output) throw fault('INVALID_ARGUMENT', 'MCP reserves stdin/stdout for the protocol.'); await mcp(product, options); return; }
    else if (command === 'init') result = await product.init(options);
    else { let input = {}; if (inputSource) { let text; if (inputSource === '-') { const chunks = []; let size = 0; for await (const chunk of process.stdin) { size += chunk.length; if (size > 64 * 1024 * 1024) throw fault('TOO_LARGE', 'Input exceeds 64 MiB.'); chunks.push(chunk); } text = Buffer.concat(chunks).toString(); } else { const { readJSON } = await import('./workspace.mjs'); input = await readJSON(path.resolve(inputSource)); } if (text !== undefined) input = JSON.parse(text); } result = await product.execute(command, input, options); }
    completedResult = result;
    if (output) { const artifact = result?.data?.artifact; await outputHandle.writeFile(artifact ? Buffer.from(artifact.base64, 'base64') : JSON.stringify(result, null, 2) + '\n'); await outputHandle.sync(); }
    process.stdout.write(JSON.stringify(output ? { version: 1, ok: true, output: path.resolve(output) } : result) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ version: 1, ok: false, error: errorResult(error), ...(completedResult ? { operationCompleted: true, result: completedResult, notice: 'Operation completed but output delivery failed. Do not replay the mutation; recover this result.' } : {}) }) + '\n'); process.exitCode = error.status === 409 ? 3 : error.status === 403 ? 4 : 1; }
  finally { if (outputHandle) await outputHandle.close(); }
}

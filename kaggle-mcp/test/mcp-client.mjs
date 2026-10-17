#!/usr/bin/env node
/**
 * Protocol-level test for the MCP server.
 *
 * Uses the SDK's in-memory transport instead of spawning a child process: the
 * Windows sandbox blocks piped stdio (spawn EPERM), and this exercises exactly
 * the same server code, tool schemas and handlers.
 *
 * Run: node test/mcp-client.mjs [toolName] [jsonArgs]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..', '..');

process.env.KAGGLE_RVC_HOME = workspace;
process.env.KAGGLE_RVC_USERNAME ??= '<owner>';

const { createServer } = await import('../src/server.mjs');

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
await server.connect(serverTransport);

const client = new Client({ name: 'kaggle-rvc-test', version: '0.1.0' }, { capabilities: {} });
await client.connect(clientTransport);
console.log('connected (in-memory)\n');

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const t of tools) {
  const req = t.inputSchema?.required ?? [];
  console.log(`  - ${t.name}(${req.join(', ')})${t.description ? '' : '  [no description]'}`);
}

async function callTool(name, args = {}) {
  console.log(`\n=== ${name} ${JSON.stringify(args)} ===`);
  // Downloads and blocking waits can outlive the SDK client's default 60 s request timeout.
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 1800000 });
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  console.log(text.slice(0, 3000));
  if (res.isError) console.log('(tool reported an error)');
  return res;
}

const requested = process.argv[2];
if (requested) {
  await callTool(requested, process.argv[3] ? JSON.parse(process.argv[3]) : {});
} else {
  await callTool('status');
}

await client.close();
await server.close();
console.log('\nclosed');

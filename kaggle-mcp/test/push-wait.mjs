#!/usr/bin/env node
/**
 * Push a local kernel and block until the run settles, printing the raw final status.
 * Runs in a fresh process so it always uses the current server code.
 *
 * Run: node test/push-wait.mjs <slug> [timeoutSec]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..', '..');
process.env.KAGGLE_RVC_HOME = workspace;
process.env.KAGGLE_RVC_USERNAME ??= '<owner>';

const slug = process.argv[2];
if (!slug) {
  console.error('usage: node test/push-wait.mjs <slug> [timeoutSec]');
  process.exit(2);
}
const timeoutSec = Number(process.argv[3] ?? 1800);

const { createServer } = await import('../src/server.mjs');
const [ct, st] = InMemoryTransport.createLinkedPair();
const server = createServer();
await server.connect(st);
const client = new Client({ name: 'push-wait', version: '0.1.0' }, { capabilities: {} });
await client.connect(ct);

const res = await client.callTool(
  {
    name: 'kernel_push',
    arguments: { kernel: slug, wait: true, timeout_sec: timeoutSec, poll_sec: 15 },
  },
  undefined,
  // The SDK client defaults to a 60 s request timeout; a blocking wait needs more.
  { timeout: (timeoutSec + 120) * 1000 },
);
const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
console.log(text);

const m = /status\s*:\s*(\S+)/.exec(text);
const final = m ? m[1] : 'UNKNOWN';

if (final !== 'COMPLETE') {
  const logs = await client.callTool({ name: 'kernel_logs', arguments: { kernel: slug, tail: 25 } });
  const logText = (logs.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log('\n--- log tail ---');
  console.log(logText.slice(-3000));
}

console.log(`\n================ FINAL ${final} ================`);
process.exit(final === 'COMPLETE' ? 0 : 1);

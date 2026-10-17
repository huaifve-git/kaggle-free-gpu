#!/usr/bin/env node
/**
 * Live verification of the RVC *train* template on a real dataset.
 *
 * Creates a GPU kernel that mounts one of the user's private voice datasets, writes the
 * generated train cells, pushes it and blocks until the run settles, then reports the
 * produced model/index.
 *
 * Run: node test/rvc-train-run.mjs [datasetSlug] [expName] [epochs]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..', '..');
process.env.KAGGLE_RVC_HOME = workspace;
process.env.KAGGLE_RVC_USERNAME ??= '<owner>';

const dataset = process.argv[2] ?? 'myvoice';
const expName = process.argv[3] ?? dataset;
const epochs = Number(process.argv[4] ?? 2);
const slug = `rvc-train-${expName}`;

const { createServer } = await import('../src/server.mjs');
const [ct, st] = InMemoryTransport.createLinkedPair();
const server = createServer();
await server.connect(st);
const client = new Client({ name: 'rvc-train-run', version: '0.1.0' }, { capabilities: {} });
await client.connect(ct);

async function call(name, args = {}, options) {
  const res = await client.callTool({ name, arguments: args }, undefined, options);
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`\n########## ${name}\n${text}`);
  return { res, text };
}

console.log(`dataset=${dataset} exp=${expName} epochs=${epochs} slug=${slug}`);

await call('kernel_new', {
  title: `RVC train ${expName}`,
  slug,
  gpu: true,
  machine_shape: 'NvidiaTeslaT4',
  internet: true,
  is_private: true,
  dataset_sources: [`${process.env.KAGGLE_RVC_USERNAME}/${dataset}`],
  cells: [],
});

await call('rvc_notebook', {
  kernel: slug,
  stage: 'train',
  dataset,
  exp_name: expName,
  sample_rate: '40k',
  epochs,
  batch_size: 8,
  f0_method: 'rmvpe',
});

const push = await call(
  'kernel_push',
  { kernel: slug, wait: true, timeout_sec: 5400, poll_sec: 30 },
  { timeout: (5400 + 120) * 1000 },
);

const m = /status\s*:\s*(\S+)/.exec(push.text);
const status = m ? m[1] : 'UNKNOWN';

if (status !== 'COMPLETE') {
  console.log('\n--- log tail ---');
  const logs = await client.callTool({ name: 'kernel_logs', arguments: { kernel: slug, tail: 40 } });
  console.log((logs.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').slice(-4000));
} else {
  await call('kernel_logs', { kernel: slug, tail: 20 });
}

console.log(`\n================ TRAIN ${status} ================`);
process.exit(status === 'COMPLETE' ? 0 : 1);

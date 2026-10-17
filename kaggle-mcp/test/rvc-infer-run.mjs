#!/usr/bin/env node
/**
 * Live verification of the RVC *infer* template: mount the trained model (as a kernel
 * source) plus the voice dataset, convert a clip, and check the output audio lands.
 *
 * Run: node test/rvc-infer-run.mjs [expName] [datasetSlug] [trainKernelSlug]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..', '..');
process.env.KAGGLE_RVC_HOME = workspace;
process.env.KAGGLE_RVC_USERNAME ??= '<owner>';

const expName = process.argv[2] ?? 'myvoice';
const dataset = process.argv[3] ?? 'myvoice';
const trainKernel = process.argv[4] ?? 'rvc-train-myvoice';
const slug = `rvc-infer-${expName}`;

const { createServer } = await import('../src/server.mjs');
const [ct, st] = InMemoryTransport.createLinkedPair();
const server = createServer();
await server.connect(st);
const client = new Client({ name: 'rvc-infer-run', version: '0.1.0' }, { capabilities: {} });
await client.connect(ct);

async function call(name, args = {}, options) {
  const res = await client.callTool({ name, arguments: args }, undefined, options);
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`\n########## ${name}\n${text}`);
  return { res, text };
}

console.log(`exp=${expName} dataset=${dataset} trainKernel=${trainKernel} slug=${slug}`);

await call('kernel_new', {
  title: `RVC infer ${expName}`,
  slug,
  gpu: true,
  machine_shape: 'NvidiaTeslaT4',
  internet: true,
  is_private: true,
  dataset_sources: [`${process.env.KAGGLE_RVC_USERNAME}/${dataset}`],
  kernel_sources: [`${process.env.KAGGLE_RVC_USERNAME}/${trainKernel}`],
  cells: [],
});

await call('rvc_notebook', { kernel: slug, stage: 'infer', exp_name: expName, sample_rate: '40k' });

const push = await call(
  'kernel_push',
  { kernel: slug, wait: true, timeout_sec: 3600, poll_sec: 20 },
  { timeout: (3600 + 120) * 1000 },
);

const m = /status\s*:\s*(\S+)/.exec(push.text);
const status = m ? m[1] : 'UNKNOWN';

if (status !== 'COMPLETE') {
  const logs = await client.callTool({ name: 'kernel_logs', arguments: { kernel: slug, tail: 40 } });
  console.log('\n--- log tail ---');
  console.log((logs.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').slice(-4000));
} else {
  await call('kernel_logs', { kernel: slug, tail: 25 });
}

console.log(`\n================ INFER ${status} ================`);
process.exit(status === 'COMPLETE' ? 0 : 1);

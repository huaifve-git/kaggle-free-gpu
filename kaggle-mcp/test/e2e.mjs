#!/usr/bin/env node
/**
 * End-to-end acceptance test: create a notebook, write cells, push it to Kaggle,
 * let it RUN, then fetch status and logs — all through the MCP tools.
 *
 * Run: node test/e2e.mjs [--gpu] [--slug my-slug]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, '..', '..');

process.env.KAGGLE_RVC_HOME = workspace;
process.env.KAGGLE_RVC_USERNAME ??= '<owner>';

const useGpu = process.argv.includes('--gpu');
const slugArg = process.argv.indexOf('--slug');
const slug = slugArg > -1 ? process.argv[slugArg + 1] : 'kaggle-mcp-smoke';

const { createServer } = await import('../src/server.mjs');
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = createServer();
await server.connect(serverTransport);
const client = new Client({ name: 'kaggle-rvc-e2e', version: '0.1.0' }, { capabilities: {} });
await client.connect(clientTransport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`\n########## ${name} ${JSON.stringify(args).slice(0, 120)}`);
  console.log(text);
  return { res, text };
}

const cells = [
  { type: 'markdown', source: '# kaggle-rvc MCP smoke test\n\nPushed and run by the local MCP server.' },
  {
    type: 'code',
    source: `import sys, os, platform, json
print("hello from Kaggle, pushed by the kaggle-rvc MCP server")
print("python :", sys.version.split()[0])
print("cwd    :", os.getcwd())
try:
    import torch
    print("torch  :", torch.__version__, "| cuda available:", torch.cuda.is_available(),
          "| devices:", torch.cuda.device_count())
except Exception as e:
    print("torch  : not available:", e)
os.makedirs("out", exist_ok=True)
with open("out/hello.txt", "w") as f:
    f.write("written on Kaggle by the MCP smoke test\\n")
print("listing:", sorted(os.listdir(".")))
`,
  },
];

// 0. connection
await call('status');

// 1. create locally (private; GPU off unless --gpu so we spend no GPU quota)
const created = await call('kernel_new', {
  title: `kaggle-mcp smoke test ${slug}`,
  slug,
  gpu: useGpu,
  machine_shape: useGpu ? 'NvidiaTeslaT4' : '',
  internet: false,
  is_private: true,
  cells,
});
if (/already exists/.test(created.text)) {
  console.log('\n(kernel dir already exists — reusing it)');
  await call('kernel_write', { kernel: slug, cells, mode: 'replace' });
}

// 2. read it back
await call('kernel_read', { kernel: slug });

// 3. upload and run (this is the part that proves it really works)
const push = await call('kernel_push', { kernel: slug, wait: true, timeout_sec: 1500, poll_sec: 20 });

// 4. status + logs
const statusRes = await call('kernel_status', { kernel: slug });
const logs = await call('kernel_logs', { kernel: slug, tail: 60 });

// 5. output download
const out = await call('kernel_output', { kernel: slug });

await client.close();
await server.close();

// The status call is authoritative; the push summary is only advisory.
const complete = /status\s*:\s*COMPLETE/.test(statusRes.text);
const sawOutput = /hello\.txt/.test(out.text) || /hello\.txt/.test(logs.text);
const ok = complete && !/ERROR:/.test(push.text);
console.log(`\n  run completed : ${complete}`);
console.log(`  output files  : ${sawOutput}`);
console.log(`\n================ E2E ${ok ? 'PASSED' : 'NEEDS ATTENTION'} ================`);
process.exit(ok ? 0 : 1);

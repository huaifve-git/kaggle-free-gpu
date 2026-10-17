#!/usr/bin/env node
/**
 * Live smoke test for the Kaggle API client.
 *
 * Read-only against Kaggle except for one throwaway blob upload token.
 * Run: node test/smoke.mjs [--full]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadCredentials } from '../src/config.mjs';
import * as kaggle from '../src/kaggle-api.mjs';

const full = process.argv.includes('--full');
let pass = 0;
let fail = 0;

function report(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const auth = loadCredentials({ workspace: path.resolve('.') });
if (!auth) {
  console.error('No credentials found. See src/config.mjs for the lookup order.');
  process.exit(2);
}
console.log(`credentials: ${auth.kind} from ${auth.source}`);
console.log(`username   : ${auth.username ?? '(unknown — pass owner= to tools)'}\n`);

const USER = process.env.KAGGLE_RVC_USERNAME ?? auth.username ?? '<owner>';

// 1. transport + list service
try {
  const r = await kaggle.ping(auth);
  report('kernels.KernelsApiService/ListKernels', r.startsWith('OK'), r);
} catch (e) {
  report('kernels.KernelsApiService/ListKernels', false, e.message);
}

// 2. datasets service name
try {
  const ds = await kaggle.listDatasets(auth, { user: USER, pageSize: 3 });
  report('datasets.DatasetApiService/ListDatasets', true, `${ds.length} dataset(s) for ${USER}`);
} catch (e) {
  report('datasets.DatasetApiService/ListDatasets', false, e.message);
}

// 3. pull an existing kernel (public one, guaranteed to exist)
try {
  const pulled = await kaggle.pullKernel(auth, 'skarin', 'arc-agi-3-27-80-lb-100-trajectory-audit');
  report(
    'kernels.KernelsApiService/GetKernel',
    typeof pulled.source === 'string',
    `title="${pulled.metadata.title}" gpu=${pulled.metadata.enableGpu} source=${pulled.source.length}B`,
  );
} catch (e) {
  report('kernels.KernelsApiService/GetKernel', false, e.message);
}

// 4. status of that public kernel
try {
  const st = await kaggle.kernelStatus(auth, 'skarin', 'arc-agi-3-27-80-lb-100-trajectory-audit');
  report('kernels.KernelsApiService/GetKernelSessionStatus', true, `status=${st.status}`);
} catch (e) {
  report('kernels.KernelsApiService/GetKernelSessionStatus', false, e.message);
}

// 5. blob upload token (the mechanism datasets need) — token only, no dataset created
if (full) {
  const tmp = path.join(os.tmpdir(), `kaggle-mcp-smoke-${Date.now()}.txt`);
  fs.writeFileSync(tmp, 'kaggle-rvc-mcp smoke test\n', 'utf8');
  try {
    const r = await kaggle.__uploadBlobForTest(auth, tmp);
    report('blobs.BlobApiService/StartBlobUpload', Boolean(r.token && r.createUrl), `token=${String(r.token).slice(0, 12)}… put=${r.putStatus}`);
  } catch (e) {
    report('blobs.BlobApiService/StartBlobUpload', false, e.message);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

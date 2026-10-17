/**
 * Kaggle API client — the current (kagglesdk-era) JSON RPC surface.
 *
 * Transport (verified against Kaggle/kaggle-sdk-python, kaggle_http_client.py):
 *   POST https://api.kaggle.com/v1/<service>/<method>
 *   Authorization: Bearer <KGAT token>   (or HTTP Basic user:key)
 *   Content-Type: application/json
 *   body = camelCase request JSON, response = camelCase response JSON
 *
 * Error shapes to handle:
 *   - HTTP >= 400 with {"error":{"code":..,"message":..}}   (RPC style)
 *   - HTTP 200 with {"code":>=400,"message":..}             (legacy style; the SDK raises on this)
 *   - HTTP 200 with {"error":"..."} inside push/create responses
 *
 * The legacy REST v1 (www.kaggle.com/api/v1) is still alive for kernels/list and
 * kernels/pull, but kernels/status and kernels/output now 404 — do not use it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCredentials } from './config.mjs';

export const RPC_BASE = process.env.KAGGLE_API_ENDPOINT ?? 'https://api.kaggle.com';

/** KernelWorkerStatus enum values as returned by GetKernelSessionStatus. */
export const TERMINAL_STATUSES = new Set(['COMPLETE', 'ERROR', 'CANCEL_ACKNOWLEDGED']);

/** KernelExecutionType: 1 = save & run all, 3 = quick save (no run). */
export const EXECUTION_TYPE = { SAVE_AND_RUN_ALL: 1, INTERACTIVE: 2, QUICK_SAVE: 3 };

function headers(auth) {
  return {
    ...auth.header,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'kaggle-rvc-mcp/0.1',
  };
}

/**
 * Retry transient *network* failures only.
 *
 * The MCP server is long-lived and the network here is not perfectly reliable: a
 * plain `fetch failed` (undici's UND_ERR_CONNECT_TIMEOUT / ECONNRESET / EAI_AGAIN)
 * shows up every so often, and a single failed POST used to abort a whole workflow.
 * HTTP-level errors are never retried — only the transport.
 */
const TRANSIENT_NET = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|socket hang up|network|aborted/i;

export function isTransientNetworkError(err) {
  const text = `${err?.message ?? ''} ${err?.cause?.code ?? ''} ${err?.cause?.message ?? ''}`;
  return TRANSIENT_NET.test(text) || err?.name === 'AbortError';
}

async function withRetry(fn, { attempts = 4, baseDelayMs = 800, label = 'request' } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      last = err;
      if (attempt === attempts || !isTransientNetworkError(err)) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.error(
        `[kaggle-mcp] ${label}: transient network failure (attempt ${attempt}/${attempts}), retrying in ${delay}ms — ${
          err.cause?.code ?? err.message
        }`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}

/** PUT bytes to a signed upload URL, with the same transient-failure handling. */
export async function putToSignedUrl(url, bytes, { label = 'blob upload' } = {}) {
  const host = new URL(url).host;
  return withRetry(
    async () => {
      const put = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) },
        body: bytes,
      });
      if (!put.ok) {
        throw new Error(`PUT ${host} -> HTTP ${put.status}: ${(await put.text()).slice(0, 200)}`);
      }
      return { status: put.status, host };
    },
    {
      label,
      attempts: 4,
      // An unreachable upload host is the one failure mode worth explaining, because
      // it is a network condition rather than anything Kaggle rejected.
      baseDelayMs: 1500,
    },
  ).catch((err) => {
    if (isTransientNetworkError(err)) {
      throw new Error(
        `could not reach the upload host ${host} (${err.cause?.code ?? err.message}). ` +
          `This is a network reachability problem, not a Kaggle rejection: the blob upload PUT goes to ` +
          `${host}, which some networks block. Retry when it is reachable, or upload the dataset through ` +
          `the Kaggle web UI instead.`,
      );
    }
    throw err;
  });
}

async function callRpc(auth, service, method, body = {}, { timeoutMs = 120000 } = {}) {
  const url = `${RPC_BASE}/v1/${service}/${method}`;
  const res = await withRetry(
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          method: 'POST',
          headers: headers(auth),
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
    { label: `${service}/${method}`, attempts: 3, baseDelayMs: 1000 },
  );
  const raw = await res.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : {};
  } catch {
    json = null;
  }

  if (json && json.error && typeof json.error === 'object' && json.error.code) {
    throw new Error(`Kaggle ${service}/${method} failed: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  if (json && typeof json.error === 'string' && json.error) {
    // Push/create report failures this way with HTTP 200; callers usually surface it.
    throw new Error(`Kaggle ${service}/${method} failed: ${json.error}`);
  }
  if (json && typeof json.code === 'number' && json.code >= 400) {
    throw new Error(`Kaggle ${service}/${method} failed (${json.code}): ${json.message ?? raw.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`Kaggle ${service}/${method} HTTP ${res.status}: ${raw.slice(0, 300)}`);
  }
  if (json === null) throw new Error(`Kaggle ${service}/${method} returned non-JSON: ${raw.slice(0, 200)}`);
  return json;
}

/* ------------------------------------------------------------------ kernels */

export async function ping(auth) {
  try {
    const r = await callRpc(auth, 'kernels.KernelsApiService', 'ListKernels', { page: 1, pageSize: 1 });
    const n = r.kernels?.length ?? 0;
    return `OK (ListKernels returned ${n} item${n === 1 ? '' : 's'})`;
  } catch (e) {
    return `FAILED — ${e.message}`;
  }
}

export async function listKernels(auth, { search, user, sortBy, page = 1, pageSize = 20 } = {}) {
  const body = { page: Math.max(1, page), pageSize: Math.min(100, Math.max(1, pageSize)) };
  if (search) body.search = search;
  if (user) body.user = user;
  if (sortBy) body.sortBy = sortBy;
  const r = await callRpc(auth, 'kernels.KernelsApiService', 'ListKernels', body);
  return r.kernels ?? [];
}

export async function getKernel(auth, userName, kernelSlug) {
  return callRpc(auth, 'kernels.KernelsApiService', 'GetKernel', { userName, kernelSlug });
}

/**
 * Upload a local kernel directory and start a run.
 * @param {object} auth
 * @param {string} kernelDir
 * @param {object} meta parsed kernel-metadata.json
 */
export async function pushKernel(auth, kernelDir, meta) {
  const codePath = path.isAbsolute(meta.code_file)
    ? meta.code_file
    : path.join(kernelDir, meta.code_file);
  if (!fs.existsSync(codePath)) throw new Error(`code_file not found: ${codePath}`);
  const code = fs.readFileSync(codePath, 'utf8');

  const isNotebook = (meta.kernel_type ?? 'notebook') === 'notebook';
  const text = isNotebook ? cleanNotebookForPush(code, codePath) : code;

  const body = {
    // NOTE: `slug` is the "owner/kernel-slug" string. `id` is the *numeric* kernel id
    // and sending a string there makes the server answer HTTP 400 with an empty body.
    slug: meta.id,
    newTitle: meta.title,
    text,
    language: meta.language ?? 'python',
    kernelType: meta.kernel_type ?? 'notebook',
    isPrivate: meta.is_private ?? true,
    enableInternet: meta.enable_internet ?? false,
    // Default (field unset) = save and run; we set it explicitly so the intent is obvious.
    kernelExecutionType: meta.no_run ? EXECUTION_TYPE.QUICK_SAVE : EXECUTION_TYPE.SAVE_AND_RUN_ALL,
  };
  if (meta.id_no) body.id = Number(meta.id_no);

  if (meta.enable_gpu) body.enableGpu = true;
  if (meta.enable_tpu) body.enableTpu = true;
  if (meta.machine_shape) body.machineShape = meta.machine_shape;
  if (meta.session_timeout_seconds) body.sessionTimeoutSeconds = meta.session_timeout_seconds;
  for (const [from, to] of [
    ['dataset_sources', 'datasetDataSources'],
    ['kernel_sources', 'kernelDataSources'],
    ['competition_sources', 'competitionDataSources'],
    ['model_sources', 'modelDataSources'],
  ]) {
    if (Array.isArray(meta[from]) && meta[from].length) body[to] = meta[from];
  }

  const res = await callRpc(auth, 'kernels.KernelsApiService', 'SaveKernel', body, { timeoutMs: 300000 });
  if (res.error) {
    const err = new Error(`Kernel push rejected: ${res.error}`);
    err.kaggle = res;
    throw err;
  }
  return { ...res, ref: normalizeRef(res.ref) };
}

/**
 * SaveKernel derives the real kernel slug from the TITLE, not from the slug we ask for,
 * and answers with `ref` like "/code/owner/some-slug". Normalize it to "owner/slug" —
 * this is the only reliable identity to poll afterwards.
 */
export function normalizeRef(ref) {
  if (typeof ref !== 'string' || !ref) return null;
  return ref.replace(/^\/?code\//, '').replace(/^\//, '');
}

/** Kaggle wants notebook JSON with cell sources joined and outputs stripped. */
export function cleanNotebookForPush(code, codePath) {
  let nb;
  try {
    nb = JSON.parse(code);
  } catch (e) {
    throw new Error(`notebook ${codePath} is not valid JSON: ${e.message}`);
  }
  const cleaned = {
    cells: (nb.cells ?? []).map((cell, i) => ({
      cell_type: cell.cell_type,
      // nbformat 4.5 requires a cell id; dropping it makes Kaggle warn today and
      // fail once nbformat enforces it.
      id: cell.id ?? `cell-${String(i).padStart(3, '0')}`,
      metadata: cell.metadata ?? {},
      source: Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? ''),
      ...(cell.cell_type === 'code' ? { execution_count: null, outputs: [] } : {}),
    })),
    metadata: nb.metadata ?? {},
    nbformat: nb.nbformat ?? 4,
    nbformat_minor: nb.nbformat_minor ?? 5,
  };
  return JSON.stringify(cleaned);
}

export async function kernelStatus(auth, userName, kernelSlug) {
  const r = await callRpc(auth, 'kernels.KernelsApiService', 'GetKernelSessionStatus', {
    userName,
    kernelSlug,
  });
  return {
    status: String(r.status ?? 'UNKNOWN').toUpperCase(),
    failureMessage: r.failureMessage ?? null,
    raw: r,
  };
}

/**
 * The run log alone, from a single ListKernelSessionOutput call.
 *
 * Every page of that response carries the same `log` field, so reading the log does
 * NOT require paging through the file list. That matters: a run whose /kaggle/working
 * contains a Python venv reports ~15k output files, and paging all of them took 152 s
 * in a live measurement versus ~1 s for this call.
 */
export async function kernelLog(auth, userName, kernelSlug, { pageSize = 100 } = {}) {
  const r = await callRpc(auth, 'kernels.KernelsApiService', 'ListKernelSessionOutput', {
    userName,
    kernelSlug,
    pageSize,
  });
  return {
    log: typeof r.log === 'string' ? r.log : null,
    firstPageFiles: (r.files ?? []).map((f) => ({ url: f.url, fileName: f.fileName ?? f.name })),
    hasMoreFiles: Boolean(r.nextPageToken),
  };
}

export async function kernelOutput(auth, userName, kernelSlug) {
  const files = [];
  let pageToken;
  let log = null;
  do {
    const r = await callRpc(auth, 'kernels.KernelsApiService', 'ListKernelSessionOutput', {
      userName,
      kernelSlug,
      pageSize: 100,
      ...(pageToken ? { pageToken } : {}),
    });
    for (const f of r.files ?? []) files.push({ url: f.url, fileName: f.fileName ?? f.name });
    if (r.log) log = r.log;
    pageToken = r.nextPageToken || undefined;
  } while (pageToken);
  return { files, log };
}

/** Poll until the run reaches a terminal state or the budget runs out. */
export async function waitForKernel(auth, userName, kernelSlug, { timeoutMs = 1800000, pollMs = 20000 } = {}) {
  const started = Date.now();
  let last = { status: 'UNKNOWN', failureMessage: null };
  for (;;) {
    try {
      last = await kernelStatus(auth, userName, kernelSlug);
    } catch (e) {
      last = { status: 'UNKNOWN', failureMessage: e.message };
    }
    if (TERMINAL_STATUSES.has(last.status)) {
      return { ...last, elapsedMs: Date.now() - started, timedOut: false };
    }
    if (Date.now() - started + pollMs > timeoutMs) {
      return { ...last, elapsedMs: Date.now() - started, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Download a kernel run's artifacts.
 * Uses ListKernelSessionOutput file URLs (the legacy /kernels/output REST route is gone)
 * and writes the run log next to them.
 *
 * @param {{ match?: string, skipLog?: boolean }} [opts]
 *   `match` keeps only files whose output path contains that substring (e.g. "out/"
 *   for an RVC run, whose /kaggle/working also holds the whole cloned repo and its
 *   ~650 MB of pretrained assets). Without it, everything is downloaded.
 */
export async function downloadKernelOutput(auth, userName, kernelSlug, destDir, opts = {}) {
  const { match, skipLog = false } = opts;
  const { files, log } = await kernelOutput(auth, userName, kernelSlug);
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  const skipped = [];
  const logFile = path.join(destDir, `${userName}__${kernelSlug}.log`);
  if (!skipLog && typeof log === 'string' && log.length) {
    fs.writeFileSync(logFile, log, 'utf8');
    written.push(logFile);
  }
  for (const f of files) {
    if (!f.url) continue;
    const name = f.fileName || path.basename(new URL(f.url).pathname) || 'output.bin';
    if (match && !name.includes(match)) {
      skipped.push(name);
      continue;
    }
    // Preserve the output tree (out/<voice>.pth stays out/<voice>.pth) instead of
    // flattening it into out__<voice>.pth, while refusing any traversal segment.
    const safe = name
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg && seg !== '.' && seg !== '..')
      .join(path.sep);
    const target = path.join(destDir, safe || 'output.bin');
    try {
      const buf = await withRetry(
        async () => {
          const r = await fetch(f.url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return Buffer.from(await r.arrayBuffer());
        },
        { label: `download ${name}`, attempts: 3, baseDelayMs: 1000 },
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf);
      written.push(target);
    } catch (e) {
      written.push(`${target} (FAILED: ${e.message})`);
    }
  }
  return {
    files: written,
    skipped: skipped.length,
    logFile: fs.existsSync(logFile) ? logFile : null,
    count: files.length,
  };
}

export async function pullKernel(auth, userName, kernelSlug, versionLabel) {
  const r = await callRpc(auth, 'kernels.KernelsApiService', 'GetKernel', {
    userName,
    kernelSlug,
    ...(versionLabel ? { versionLabel } : {}),
  });
  const source = r.blob?.source ?? '';
  const kernelType = r.blob?.kernelType ?? r.metadata?.kernelTypeNullable ?? 'notebook';
  const trimmed = String(source).trim();
  return {
    metadata: {
      title: r.metadata?.titleNullable ?? r.metadata?.title ?? kernelSlug,
      kernelType,
      isPrivate: r.metadata?.isPrivateNullable ?? false,
      enableGpu: r.metadata?.enableGpuNullable ?? false,
      enableInternet: r.metadata?.enableInternetNullable ?? false,
      machineShape: r.metadata?.machineShapeNullable ?? '',
      datasetDataSources: r.metadata?.datasetDataSources ?? [],
      competitionDataSources: r.metadata?.competitionDataSources ?? [],
      kernelDataSources: r.metadata?.kernelDataSources ?? [],
      modelDataSources: r.metadata?.modelDataSources ?? [],
    },
    source: trimmed.startsWith('{') ? trimmed : source,
    sourceFormat: trimmed.startsWith('{') ? 'ipynb' : 'script',
  };
}

/* ----------------------------------------------------------------- datasets */

/** DatasetGroup is a proto ENUM: pass 1 (public) / 2 (private) — strings get HTTP 400. */
export const DATASET_GROUP = { PUBLIC: 1, PRIVATE: 2 };

export async function listDatasets(auth, { search, user, sortBy, group, page = 1, pageSize = 20 } = {}) {
  const body = { page: Math.max(1, page), pageSize: Math.min(100, Math.max(1, pageSize)) };
  if (search) body.search = search;
  if (user) body.user = user;
  if (sortBy) body.sortBy = sortBy;
  if (group) body.group = group;
  const r = await callRpc(auth, 'datasets.DatasetApiService', 'ListDatasets', body);
  return (r.datasets ?? []).map((d) => ({
    ref: d.ref ?? `${d.ownerSlug ?? d.ownerName ?? '?'}/${d.slug ?? '?'}`,
    title: d.title ?? d.subtitle ?? d.ref,
    totalBytes: d.totalBytes ?? d.totalBytesNullable ?? null,
    isPrivate: d.isPrivate ?? d.isPrivateNullable ?? null,
  }));
}

/** Files inside a dataset — the cheapest way to prove an upload landed. */
export async function listDatasetFiles(auth, ownerSlug, datasetSlug) {
  const r = await callRpc(auth, 'datasets.DatasetApiService', 'ListDatasetFiles', { ownerSlug, datasetSlug });
  return (r.datasetFiles ?? []).map((f) => ({
    name: f.name ?? f.ref,
    totalBytes: f.totalBytes ?? null,
    creationDate: f.creationDate ?? null,
  }));
}

export async function datasetStatus(auth, ownerSlug, datasetSlug) {
  const r = await callRpc(auth, 'datasets.DatasetApiService', 'GetDatasetStatus', { ownerSlug, datasetSlug });
  return r.status ?? 'UNKNOWN';
}

/** Two-step blob upload: ask for a signed URL, PUT the bytes, then reference the token. */
async function uploadBlob(auth, file, blobType = 'DATASET') {
  const stat = fs.statSync(file);
  const start = await callRpc(auth, 'blobs.BlobApiService', 'StartBlobUpload', {
    type: blobType,
    name: path.basename(file),
    contentType: 'application/octet-stream',
    contentLength: stat.size,
    lastModifiedEpochSeconds: Math.floor(stat.mtimeMs / 1000),
  });
  const token = start.token ?? start.blobToken;
  const createUrl = start.createUrl ?? start.url;
  if (!token || !createUrl) throw new Error(`StartBlobUpload returned no token/createUrl: ${JSON.stringify(start).slice(0, 200)}`);
  const body = fs.readFileSync(file);
  const put = await putToSignedUrl(createUrl, body, { label: `blob PUT ${path.basename(file)}` });
  return { token, createUrl, putStatus: put.status };
}

/** Test-only: exercise the blob upload handshake and report what happened. */
export async function __uploadBlobForTest(auth, file) {
  return uploadBlob(auth, file, 'DATASET');
}

function walkFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else out.push({ full, rel: path.relative(base, full).replace(/\\/g, '/') });
  }
  return out;
}

/**
 * Create a new dataset, or a new version when versionNotes is given and the dataset exists.
 * @param {{owner:string, slug:string, title:string, folder:string, isPrivate?:boolean,
 *          versionNotes?:string, license?:string, description?:string, subtitle?:string}} opts
 */
export async function pushDataset(auth, opts) {
  const { owner, slug, title, folder, isPrivate = true, versionNotes, license = 'CC0-1.0' } = opts;
  const entries = walkFiles(folder);
  if (!entries.length) throw new Error(`folder is empty: ${folder}`);
  // Kaggle rejects nested datasets that contain the dataset metadata file.
  const filtered = entries.filter((e) => !/^dataset-metadata\.json$/i.test(e.rel));

  const files = [];
  for (const e of filtered) {
    const { token } = await uploadBlob(auth, e.full, 'DATASET');
    files.push({ token, description: e.rel });
  }

  let res;
  let updated = false;
  if (versionNotes) {
    try {
      res = await callRpc(auth, 'datasets.DatasetApiService', 'CreateDatasetVersion', {
        ownerSlug: owner,
        datasetSlug: slug,
        body: {
          versionNotes,
          files,
          ...(opts.subtitle ? { subtitle: opts.subtitle } : {}),
          ...(opts.description ? { description: opts.description } : {}),
        },
      }, { timeoutMs: 600000 });
      updated = true;
    } catch (e) {
      if (!/not found|does not exist|404|PERMISSION/i.test(e.message)) throw e;
    }
  }
  if (!res) {
    res = await callRpc(auth, 'datasets.DatasetApiService', 'CreateDataset', {
      ownerSlug: owner,
      slug,
      title,
      licenseName: license,
      isPrivate,
      files,
      ...(opts.subtitle ? { subtitle: opts.subtitle } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    }, { timeoutMs: 600000 });
  }
  return { ...res, updated };
}

export { loadCredentials };

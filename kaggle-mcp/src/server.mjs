#!/usr/bin/env node
/**
 * Kaggle RVC MCP server (stdio).
 *
 * Exposes Kaggle kernel (notebook) lifecycle as MCP tools so an agent can:
 * create a notebook locally -> write cells -> push & run it on Kaggle with
 * GPU + internet + dataset sources -> poll status -> read logs / download output.
 *
 * IMPORTANT: stdout is the MCP transport. Never console.log() here; log to stderr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { loadCredentials, kernelsRoot, outputsRoot, resolveWorkspace, resolveUsername } from './config.mjs';
import {
  defaultMetadata,
  newNotebook,
  readMetadata,
  readNotebook,
  renderNotebook,
  resolveKernelDir,
  setCells,
  slugify,
  writeMetadata,
  writeNotebook,
} from './notebook.mjs';
import * as kaggle from './kaggle-api.mjs';
import { rvcCells, RVC_STAGES } from './rvc-templates.mjs';

const log = (...a) => console.error('[kaggle-mcp]', ...a);

/* ------------------------------------------------------------------ helpers */

function ok(text) {
  return { content: [{ type: 'text', text: String(text) }] };
}

function fail(text) {
  return { content: [{ type: 'text', text: String(text) }], isError: true };
}

/**
 * Kaggle reports KernelWorkerStatus as the enum NAME — "COMPLETE", "ERROR",
 * "CANCEL_ACKNOWLEDGED". Comparing against a lowercase "complete" made every
 * successful run look like a failure.
 */
const isComplete = (status) => String(status ?? '').toUpperCase() === 'COMPLETE';

/** Wrap a handler so a thrown error becomes a readable tool error, not a crash. */
function guard(fn) {
  return async (args, extra) => {
    try {
      return await fn(args, extra);
    } catch (err) {
      log('tool error:', err?.stack ?? err);
      // Never render a thrown non-Error as "[object Object]" — that tells the caller nothing.
      let detail;
      if (err instanceof Error) detail = err.message;
      else if (typeof err === 'string') detail = err;
      else {
        try {
          detail = JSON.stringify(err);
        } catch {
          detail = String(err);
        }
      }
      return fail(`ERROR: ${detail}`);
    }
  };
}

function creds() {
  const c = loadCredentials({ workspace: resolveWorkspace() });
  if (!c) {
    throw new Error(
      'No Kaggle credentials found. Put KAGGLE_API_TOKEN=KGAT_... in <workspace>/.secrets/kaggle.env, ' +
        'or set KAGGLE_USERNAME + KAGGLE_KEY in the environment, or create ~/.kaggle/kaggle.json.',
    );
  }
  return c;
}

function ownerOf(explicit) {
  const fromCreds = creds().username;
  const owner = resolveUsername(explicit) ?? fromCreds;
  if (!owner) {
    throw new Error(
      'Kaggle username unknown. Pass `owner`, or set KAGGLE_RVC_USERNAME / KAGGLE_USERNAME in the MCP server env.',
    );
  }
  return owner;
}

/** Accept either "<owner>/<slug>", "<slug>" (resolved against the local kernels dir) or a path. */
function resolveKernel(kernel) {
  if (!kernel) throw new Error('`kernel` is required: a local slug, a path, or "owner/slug"');
  const raw = String(kernel);
  if (raw.includes('/') && !raw.startsWith('.') && !path.isAbsolute(raw)) {
    const [owner, slug] = raw.split('/');
    if (owner && slug && !fs.existsSync(raw)) {
      const local = path.join(kernelsRoot(), slug);
      if (fs.existsSync(path.join(local, 'kernel-metadata.json'))) {
        return { dir: local, owner, slug, remote: true };
      }
      return { dir: null, owner, slug, remote: true };
    }
  }
  const dir = resolveKernelDir(kernelsRoot(), raw);
  return { dir, slug: path.basename(dir), owner: null, remote: false };
}

function requireLocalDir(kernel) {
  const r = resolveKernel(kernel);
  if (!r.dir || !fs.existsSync(path.join(r.dir, 'kernel-metadata.json'))) {
    throw new Error(
      `Local kernel "${kernel}" not found. Create it first with kernel_new, or use "owner/slug" for a remote kernel.`,
    );
  }
  return r;
}

function loadKernel(kernel) {
  const r = requireLocalDir(kernel);
  const meta = readMetadata(r.dir);
  const codeFile = path.join(r.dir, meta.code_file);
  const nb = fs.existsSync(codeFile) ? readNotebook(codeFile) : newNotebook();
  return { ...r, meta, codeFile, notebook: nb };
}

function saveKernel(k, { nb, meta } = {}) {
  if (meta) writeMetadata(k.dir, meta);
  if (nb) writeNotebook(k.codeFile, nb);
}

function listOutputFiles(dir, base = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listOutputFiles(full, base));
    else out.push({ path: full, rel: path.relative(base, full), size: fs.statSync(full).size });
  }
  return out;
}

/* ------------------------------------------------------------- tool schemas */

const zCells = z
  .array(
    z.object({
      type: z.enum(['code', 'markdown']).describe('Cell kind'),
      source: z.string().describe('Cell contents (code or markdown)'),
    }),
  )
  .describe('Notebook cells in order');

const zSources = z.array(z.string()).describe('e.g. ["owner/dataset-slug"]');

/* ------------------------------------------------------------------- server */

export function createServer() {
const server = new McpServer(
  { name: 'kaggle-rvc', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

/* ---------------------------------------------------------------- status */

server.registerTool(
  'status',
  {
    title: 'Kaggle connection status',
    description:
      'Check Kaggle credentials, the resolved username, local working directories, and whether the Kaggle API answers. Never returns the secret itself.',
    inputSchema: {},
  },
  guard(async () => {
    const c = loadCredentials({ workspace: resolveWorkspace() });
    const lines = [];
    lines.push(`workspace      : ${resolveWorkspace()}`);
    lines.push(`kernels dir    : ${kernelsRoot()}`);
    lines.push(`outputs dir    : ${outputsRoot()}`);
    if (!c) {
      lines.push('credentials    : NOT FOUND');
      lines.push(
        'hint           : put KAGGLE_API_TOKEN=KGAT_... in <workspace>/.secrets/kaggle.env, or set KAGGLE_USERNAME/KAGGLE_KEY, or ~/.kaggle/kaggle.json',
      );
      return ok(lines.join('\n'));
    }
    lines.push(`credentials    : found (${c.kind}) from ${c.source}`);
    lines.push(`username       : ${resolveUsername(null) ?? c.username ?? 'UNKNOWN (pass owner= or set KAGGLE_RVC_USERNAME)'}`);
    const ping = await kaggle.ping(c);
    lines.push(`api ping       : ${ping}`);
    return ok(lines.join('\n'));
  }),
);

/* ------------------------------------------------------------ kernel: local */

server.registerTool(
  'kernel_new',
  {
    title: 'Create a local Kaggle notebook',
    description:
      'Scaffold a new Kaggle kernel on disk: a .ipynb plus kernel-metadata.json. GPU, internet access and data sources are first-class here — an RVC training notebook needs enable_gpu + enable_internet + dataset_sources, which the plain Kaggle API clients usually cannot set. Does NOT upload; call kernel_push to upload and run.',
    inputSchema: {
      title: z.string().describe('Human title, e.g. "RVC v2 train - myvoice"'),
      slug: z.string().optional().describe('Kernel slug (default: slugified title)'),
      cells: zCells.optional().describe('Initial cells'),
      gpu: z.boolean().optional().describe('Enable GPU (default true)'),
      machine_shape: z
        .string()
        .optional()
        .describe('Accelerator: NvidiaTeslaT4 (T4 x2, default), NvidiaL4, NvidiaL4X4, NvidiaA100, TpuV5E8; empty = default'),
      internet: z.boolean().optional().describe('Enable internet (default true — needed to pip install / clone RVC)'),
      is_private: z.boolean().optional().describe('Private kernel (default true)'),
      kernel_type: z.enum(['notebook', 'script']).optional().describe('Default notebook'),
      dataset_sources: zSources.optional(),
      model_sources: zSources.optional(),
      competition_sources: zSources.optional(),
      kernel_sources: zSources.optional(),
      owner: z.string().optional().describe('Kaggle username owning the kernel'),
    },
  },
  guard(async (a) => {
    const owner = ownerOf(a.owner);
    const slug = a.slug?.trim() || slugify(a.title);
    if (!slug) throw new Error('could not derive a slug from the title; pass slug explicitly');
    const dir = path.join(kernelsRoot(), slug);
    if (fs.existsSync(path.join(dir, 'kernel-metadata.json'))) {
      throw new Error(`Kernel "${slug}" already exists at ${dir}. Use kernel_read / kernel_write, or pick another slug.`);
    }
    const codeFile = a.kernel_type === 'script' ? `${slug}.py` : `${slug}.ipynb`;
    const meta = defaultMetadata({
      username: owner,
      slug,
      title: a.title,
      codeFile,
      opts: {
        language: 'python',
        kernel_type: a.kernel_type ?? 'notebook',
        is_private: a.is_private ?? true,
        enable_gpu: a.gpu ?? true,
        enable_internet: a.internet ?? true,
        // Only request an accelerator shape when the accelerator is actually on:
        // sending a GPU shape with enableGpu=false can still book a GPU.
        machine_shape: a.machine_shape ?? ((a.gpu ?? true) ? 'NvidiaTeslaT4' : ''),
        dataset_sources: a.dataset_sources ?? [],
        model_sources: a.model_sources ?? [],
        competition_sources: a.competition_sources ?? [],
        kernel_sources: a.kernel_sources ?? [],
      },
    });
    const nb = setCells(newNotebook(), a.cells ?? [], 'replace');
    fs.mkdirSync(dir, { recursive: true });
    writeMetadata(dir, meta);
    if (a.kernel_type === 'script') {
      const { notebookToScript } = await import('./notebook.mjs');
      fs.writeFileSync(path.join(dir, codeFile), notebookToScript(nb), 'utf8');
    } else {
      writeNotebook(path.join(dir, codeFile), nb);
    }
    return ok(
      [
        `Created kernel "${slug}"`,
        `  dir        : ${dir}`,
        `  id         : ${meta.id}`,
        `  code_file  : ${meta.code_file}`,
        `  cells      : ${nb.cells.length}`,
        `  gpu        : ${meta.enable_gpu} (${meta.machine_shape || 'default shape'})`,
        `  internet   : ${meta.enable_internet}`,
        `  datasets   : ${meta.dataset_sources.length ? meta.dataset_sources.join(', ') : '(none)'}`,
        '',
        'Next: kernel_write to add cells, then kernel_push to upload and run.',
      ].join('\n'),
    );
  }),
);

server.registerTool(
  'kernel_write',
  {
    title: 'Write cells into a local notebook',
    description:
      'Set the notebook cells of a local kernel. mode=replace overwrites, append/prepend add. This is the "write into the notebook" step before kernel_push.',
    inputSchema: {
      kernel: z.string().describe('Local slug or absolute path'),
      cells: zCells,
      mode: z.enum(['replace', 'append', 'prepend']).optional().describe('Default replace'),
    },
  },
  guard(async (a) => {
    const k = loadKernel(a.kernel);
    if (k.meta.kernel_type === 'script') {
      const { notebookToScript } = await import('./notebook.mjs');
      setCells(k.notebook, a.cells, a.mode ?? 'replace');
      fs.writeFileSync(k.codeFile, notebookToScript(k.notebook), 'utf8');
    } else {
      setCells(k.notebook, a.cells, a.mode ?? 'replace');
      saveKernel(k, { nb: k.notebook });
    }
    return ok(`Wrote ${a.cells.length} cell(s) into ${path.basename(k.codeFile)} — now ${k.notebook.cells.length} cell(s).`);
  }),
);

server.registerTool(
  'kernel_read',
  {
    title: 'Read a local notebook',
    description: 'Show a local kernel\'s metadata (GPU, internet, sources) and its cells.',
    inputSchema: { kernel: z.string().describe('Local slug or absolute path') },
  },
  guard(async (a) => {
    const k = loadKernel(a.kernel);
    const meta = k.meta;
    const head = [
      `id            : ${meta.id}`,
      `title         : ${meta.title}`,
      `code_file     : ${meta.code_file} (${k.notebook.cells.length} cells)`,
      `gpu           : ${meta.enable_gpu} / shape=${meta.machine_shape || 'default'}`,
      `internet      : ${meta.enable_internet}`,
      `is_private    : ${meta.is_private}`,
      `dataset_src   : ${JSON.stringify(meta.dataset_sources ?? [])}`,
      `model_src     : ${JSON.stringify(meta.model_sources ?? [])}`,
      `competition_src: ${JSON.stringify(meta.competition_sources ?? [])}`,
      `kernel_src    : ${JSON.stringify(meta.kernel_sources ?? [])}`,
      '',
    ].join('\n');
    return ok(head + renderNotebook(k.notebook));
  }),
);

server.registerTool(
  'kernel_configure',
  {
    title: 'Configure a local kernel (GPU / internet / sources)',
    description:
      'Update kernel-metadata.json for a local kernel: toggle GPU, set the accelerator shape, toggle internet, and set dataset/model/competition/kernel sources. Only the fields you pass change.',
    inputSchema: {
      kernel: z.string().describe('Local slug or absolute path'),
      title: z.string().optional(),
      gpu: z.boolean().optional(),
      machine_shape: z.string().optional().describe('NvidiaTeslaT4 / NvidiaL4 / NvidiaL4X4 / NvidiaA100 / TpuV5E8 / ""'),
      internet: z.boolean().optional(),
      is_private: z.boolean().optional(),
      dataset_sources: zSources.optional(),
      model_sources: zSources.optional(),
      competition_sources: zSources.optional(),
      kernel_sources: zSources.optional(),
    },
  },
  guard(async (a) => {
    const k = loadKernel(a.kernel);
    const meta = { ...k.meta };
    if (a.title !== undefined) meta.title = a.title;
    if (a.gpu !== undefined) meta.enable_gpu = a.gpu;
    if (a.machine_shape !== undefined) meta.machine_shape = a.machine_shape;
    if (a.internet !== undefined) meta.enable_internet = a.internet;
    if (a.is_private !== undefined) meta.is_private = a.is_private;
    for (const f of ['dataset_sources', 'model_sources', 'competition_sources', 'kernel_sources']) {
      if (a[f] !== undefined) meta[f] = a[f];
    }
    writeMetadata(k.dir, meta);
    return ok(
      `Updated ${meta.id}\n  gpu=${meta.enable_gpu} shape=${meta.machine_shape || 'default'} internet=${meta.enable_internet}\n  datasets=${JSON.stringify(meta.dataset_sources)} models=${JSON.stringify(meta.model_sources)}`,
    );
  }),
);

/* ----------------------------------------------------------- kernel: remote */

server.registerTool(
  'kernel_push',
  {
    title: 'Upload and run a kernel on Kaggle',
    description:
      'Upload the local kernel directory to Kaggle and start a run (Kaggle "Save & Run All"). Returns as soon as the run is queued unless wait=true. The first push of a new title creates the notebook; Kaggle derives the real slug from the title, so the local metadata is updated to the returned ref.',
    inputSchema: {
      kernel: z.string().describe('Local slug or absolute path'),
      wait: z.boolean().optional().describe('Block until the run finishes (default false: push returns as soon as the run is queued)'),
      timeout_sec: z.number().optional().describe('Max seconds to wait when wait=true (default 1800)'),
      poll_sec: z.number().optional().describe('Poll interval seconds (default 20)'),
    },
  },
  guard(async (a) => {
    const k = loadKernel(a.kernel);
    const c = creds();
    const res = await kaggle.pushKernel(c, k.dir, k.meta);

    // Kaggle derives the real slug from the title, so trust the returned ref.
    const remoteRef = res.ref ?? k.meta.id;
    const [owner, slug] = String(remoteRef).split('/');
    if (remoteRef !== k.meta.id) {
      writeMetadata(k.dir, {
        ...k.meta,
        id: remoteRef,
        ...(res.kernelId ? { id_no: res.kernelId } : {}),
      });
    }

    const lines = [
      `Pushed ${k.meta.id}`,
      `  kernel  : ${remoteRef}`,
      `  version : ${res.versionNumber ?? '?'}`,
      `  url     : ${res.url ?? `https://www.kaggle.com/code/${remoteRef}`}`,
      res.kernelId ? `  kernelId: ${res.kernelId}` : null,
      remoteRef !== k.meta.id ? `  note    : local metadata id updated to ${remoteRef}` : null,
    ].filter(Boolean);

    if (a.wait !== true) {
      lines.push(
        '',
        'The run is queued on Kaggle. Poll it with kernel_status, or block with kernel_wait.',
      );
      return ok(lines.join('\n'));
    }

    const final = await kaggle.waitForKernel(c, owner, slug, {
      timeoutMs: (a.timeout_sec ?? 1800) * 1000,
      pollMs: (a.poll_sec ?? 20) * 1000,
    });
    lines.push('', `status  : ${final.status}`);
    if (final.failureMessage) lines.push(`failure : ${final.failureMessage}`);
    lines.push(`elapsed : ${Math.round(final.elapsedMs / 1000)}s`);
    if (!isComplete(final.status)) {
      lines.push('', 'Run did not complete cleanly — call kernel_logs for the log tail.');
      return fail(lines.join('\n'));
    }
    lines.push('', 'Run complete. Call kernel_output to download the produced files, or kernel_logs for the tail.');
    return ok(lines.join('\n'));
  }),
);

server.registerTool(
  'kernel_status',
  {
    title: 'Kernel run status',
    description: 'Get the latest version status of a kernel: queued / running / complete / error, plus the failure message when it errored.',
    inputSchema: {
      kernel: z.string().describe('Local slug, absolute path, or "owner/slug"'),
      owner: z.string().optional(),
    },
  },
  guard(async (a) => {
    const c = creds();
    const r = resolveKernel(a.kernel);
    let owner = a.owner ?? r.owner;
    let slug = r.slug;
    if (r.dir && fs.existsSync(path.join(r.dir, 'kernel-metadata.json'))) {
      const meta = readMetadata(r.dir);
      [owner, slug] = String(meta.id).split('/');
    }
    if (!owner) owner = ownerOf(a.owner);
    const st = await kaggle.kernelStatus(c, owner, slug);
    return ok(
      [
        `${owner}/${slug}`,
        `status          : ${st.status}`,
        st.failureMessage ? `failure_message : ${st.failureMessage}` : null,
        st.runTimeSec != null ? `run_time_sec    : ${st.runTimeSec}` : null,
        st.versionNumber != null ? `version         : ${st.versionNumber}` : null,
        `url             : https://www.kaggle.com/code/${owner}/${slug}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }),
);

server.registerTool(
  'kernel_wait',
  {
    title: 'Wait for a kernel run',
    description: 'Poll a kernel until the run reaches a terminal state (complete/error/cancelled) or the timeout expires.',
    inputSchema: {
      kernel: z.string().describe('Local slug, path, or "owner/slug"'),
      owner: z.string().optional(),
      timeout_sec: z.number().optional().describe('Default 1800'),
      poll_sec: z.number().optional().describe('Default 20'),
    },
  },
  guard(async (a) => {
    const c = creds();
    const r = resolveKernel(a.kernel);
    let owner = a.owner ?? r.owner;
    let slug = r.slug;
    if (r.dir && fs.existsSync(path.join(r.dir, 'kernel-metadata.json'))) {
      [owner, slug] = String(readMetadata(r.dir).id).split('/');
    }
    if (!owner) owner = ownerOf(a.owner);
    const final = await kaggle.waitForKernel(c, owner, slug, {
      timeoutMs: (a.timeout_sec ?? 1800) * 1000,
      pollMs: (a.poll_sec ?? 20) * 1000,
    });
    const text = [
      `${owner}/${slug}`,
      `status   : ${final.status}`,
      final.failureMessage ? `failure  : ${final.failureMessage}` : null,
      `elapsed  : ${Math.round(final.elapsedMs / 1000)}s`,
      final.timedOut ? `NOTE     : gave up waiting after ${a.timeout_sec ?? 1800}s; the run may still be going.` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return isComplete(final.status) ? ok(text) : fail(text);
  }),
);

server.registerTool(
  'kernel_logs',
  {
    title: 'Read a run\'s logs',
    description:
      'Return the tail of a kernel run\'s log plus a summary of its output files. This is how you see why an RVC run failed. The log is inlined by the API, so this is one fast call; pass download_files=true to also pull every produced file.',
    inputSchema: {
      kernel: z.string().describe('Local slug, path, or "owner/slug"'),
      owner: z.string().optional(),
      tail: z.number().optional().describe('Log lines to return (default 120)'),
      download_files: z.boolean().optional().describe('Also download all output files (default false — slow for big runs)'),
    },
  },
  guard(async (a) => {
    const c = creds();
    const r = resolveKernel(a.kernel);
    let owner = a.owner ?? r.owner;
    let slug = r.slug;
    if (r.dir && fs.existsSync(path.join(r.dir, 'kernel-metadata.json'))) {
      [owner, slug] = String(readMetadata(r.dir).id).split('/');
    }
    if (!owner) owner = ownerOf(a.owner);

    // One ListKernelSessionOutput call carries the whole log; paging the file list is
    // only needed when the caller actually wants the files.
    const one = await kaggle.kernelLog(c, owner, slug);
    const tail = a.tail ?? 120;

    let logText = null;
    let source = null;
    if (one.log && one.log.length) {
      logText = one.log.split(/\r?\n/).slice(-tail).join('\n');
      source = 'run log (inlined by ListKernelSessionOutput)';
    }

    const lines = [
      `${owner}/${slug}`,
      `output files: ${one.firstPageFiles.length}${one.hasMoreFiles ? '+ (more not listed)' : ''}${
        one.firstPageFiles.length
          ? ` — ${one.firstPageFiles.map((f) => f.fileName).filter(Boolean).slice(0, 5).join(', ')}${
              one.firstPageFiles.length > 5 ? ', …' : ''
            }`
          : ''
      }`,
    ];

    if (logText === null) {
      // Fall back to fetching just the .log file, if one is on the first page.
      const logFile = one.firstPageFiles.find((f) => (f.fileName ?? '').endsWith('.log'));
      if (logFile?.url) {
        try {
          const r = await fetch(logFile.url);
          logText = (await r.text()).split(/\r?\n/).slice(-tail).join('\n');
          source = logFile.fileName;
        } catch (e) {
          logText = `(could not fetch ${logFile.fileName}: ${e.message})`;
          source = logFile.fileName;
        }
      }
    }

    lines.push('', `--- tail of ${source ?? 'the log'} (last ${tail} lines) ---`);
    lines.push(logText ?? '(no log available yet — the run may still be starting)');

    if (a.download_files) {
      const dest = path.join(outputsRoot(), `${owner}__${slug}`);
      fs.mkdirSync(dest, { recursive: true });
      const res = await kaggle.downloadKernelOutput(c, owner, slug, dest);
      lines.push('', `downloaded ${res.count} file(s) to ${dest}`);
    } else if (one.firstPageFiles.length) {
      lines.push('', 'Call kernel_output to download these files.');
    }

    return ok(lines.join('\n'));
  }),
);

server.registerTool(
  'kernel_output',
  {
    title: 'Download kernel output files',
    description:
      'Download a finished run\'s output files (trained models, indices, audio). Pass match to fetch only part of the tree — an RVC run\'s /kaggle/working also holds the whole cloned repo and its pretrained assets, so match="out/" grabs just the artifacts.',
    inputSchema: {
      kernel: z.string().describe('Local slug, path, or "owner/slug"'),
      owner: z.string().optional(),
      dest: z.string().optional().describe('Extraction dir (default <workspace>/outputs/<owner>__<slug>)'),
      match: z.string().optional().describe('Only download output paths containing this substring, e.g. "out/" or ".pth"'),
      with_log: z.boolean().optional().describe('Also save the run log (default true)'),
    },
  },
  guard(async (a) => {
    const c = creds();
    const r = resolveKernel(a.kernel);
    let owner = a.owner ?? r.owner;
    let slug = r.slug;
    if (r.dir && fs.existsSync(path.join(r.dir, 'kernel-metadata.json'))) {
      [owner, slug] = String(readMetadata(r.dir).id).split('/');
    }
    if (!owner) owner = ownerOf(a.owner);
    const dest = a.dest ? path.resolve(a.dest) : path.join(outputsRoot(), `${owner}__${slug}`);
    fs.mkdirSync(dest, { recursive: true });
    const res = await kaggle.downloadKernelOutput(c, owner, slug, dest, {
      match: a.match,
      skipLog: a.with_log === false,
    });
    const listed = res.files.map((f) => {
      try {
        return { path: f, size: fs.statSync(f).size };
      } catch {
        return { path: f, size: null };
      }
    });
    return ok(
      [
        `downloaded ${listed.length} file(s) to ${dest}`,
        res.count ? `(run reports ${res.count} output file(s) in total${res.skipped ? `, ${res.skipped} skipped by match="${a.match}"` : ''})` : null,
        ...listed.slice(0, 80).map((f) => `  ${path.basename(f.path)} (${f.size ?? '?'} bytes)`),
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }),
);

server.registerTool(
  'kernel_list',
  {
    title: 'List Kaggle kernels',
    description: 'Search/list Kaggle notebooks, optionally restricted to one user.',
    inputSchema: {
      search: z.string().optional(),
      user: z.string().optional(),
      sort_by: z.enum(['hotness', 'commentCount', 'dateCreated', 'dateRun', 'relevance', 'voteCount']).optional(),
      page: z.number().optional().describe('1-based (default 1)'),
      page_size: z.number().optional().describe('Default 20'),
    },
  },
  guard(async (a) => {
    const c = creds();
    const items = await kaggle.listKernels(c, {
      search: a.search,
      user: a.user,
      sortBy: a.sort_by,
      page: a.page ?? 1,
      pageSize: a.page_size ?? 20,
    });
    if (!items.length) return ok('No kernels found.');
    return ok(
      items
        .map(
          (k) =>
            `- ${k.title || k.ref}\n  ref: ${k.ref} | votes: ${k.totalVotes ?? '?'} | lastRun: ${k.lastRunTime ?? '?'}`,
        )
        .join('\n'),
    );
  }),
);

server.registerTool(
  'kernel_pull',
  {
    title: 'Pull an existing kernel',
    description: 'Download an existing Kaggle notebook (source + metadata) into <kernels-root>/<slug> so it can be edited and re-pushed.',
    inputSchema: {
      owner: z.string().describe('Kernel owner username'),
      slug: z.string().describe('Kernel slug'),
      slug_out: z.string().optional().describe('Local dir name (default: same slug)'),
      overwrite: z.boolean().optional(),
    },
  },
  guard(async (a) => {
    const c = creds();
    const dir = path.join(kernelsRoot(), a.slug_out ?? a.slug);
    if (fs.existsSync(dir) && !a.overwrite) {
      throw new Error(`${dir} already exists; pass overwrite=true to replace it.`);
    }
    const pulled = await kaggle.pullKernel(c, a.owner, a.slug);
    fs.mkdirSync(dir, { recursive: true });
    const codeFile = `${a.slug}.ipynb`;
    let nb = newNotebook();
    if (pulled.sourceFormat === 'ipynb') {
      try {
        nb = JSON.parse(pulled.source);
      } catch {
        setCells(nb, [{ type: 'code', source: pulled.source }]);
      }
    } else {
      setCells(nb, [{ type: 'code', source: pulled.source }]);
    }
    const meta = {
      ...defaultMetadata({
        username: a.owner,
        slug: a.slug,
        title: pulled.metadata?.title ?? a.slug,
        codeFile,
        opts: {
          kernel_type: pulled.metadata?.kernelType === 'script' ? 'script' : 'notebook',
          is_private: pulled.metadata?.isPrivate ?? true,
          enable_gpu: pulled.metadata?.enableGpu ?? false,
          enable_internet: pulled.metadata?.enableInternet ?? false,
          machine_shape: pulled.metadata?.machineShape ?? '',
          dataset_sources: pulled.metadata?.datasetDataSources ?? [],
          competition_sources: pulled.metadata?.competitionDataSources ?? [],
          kernel_sources: pulled.metadata?.kernelDataSources ?? [],
          model_sources: pulled.metadata?.modelDataSources ?? [],
        },
      }),
    };
    writeMetadata(dir, meta);
    writeNotebook(path.join(dir, codeFile), nb);
    return ok(
      `Pulled ${a.owner}/${a.slug} -> ${dir}\n  cells: ${nb.cells.length}\n  gpu=${meta.enable_gpu} internet=${meta.enable_internet}\n  datasets=${JSON.stringify(meta.dataset_sources)}`,
    );
  }),
);

/* ---------------------------------------------------------------- datasets */

server.registerTool(
  'dataset_push',
  {
    title: 'Upload a folder as a Kaggle dataset',
    description:
      'Create a new private Kaggle dataset (or a new version of an existing one) from a local folder — use this to get RVC training audio onto Kaggle so a notebook can mount it at /kaggle/input/<slug>.',
    inputSchema: {
      folder: z.string().describe('Local folder to upload'),
      slug: z.string().describe('Dataset slug, e.g. "rvc-myvoice-dataset"'),
      title: z.string().optional(),
      owner: z.string().optional(),
      is_private: z.boolean().optional().describe('Default true'),
      version_notes: z.string().optional().describe('If set, creates a new version instead of a new dataset'),
    },
  },
  guard(async (a) => {
    const c = creds();
    const owner = ownerOf(a.owner);
    const folder = path.resolve(a.folder);
    if (!fs.existsSync(folder)) throw new Error(`folder not found: ${folder}`);
    const res = await kaggle.pushDataset(c, {
      owner,
      slug: a.slug,
      title: a.title ?? a.slug,
      folder,
      isPrivate: a.is_private ?? true,
      versionNotes: a.version_notes,
    });
    return ok(
      [
        res.updated ? `Created new version of ${owner}/${a.slug}` : `Created dataset ${owner}/${a.slug}`,
        res.error ? `ERROR: ${res.error}` : null,
        `  url : https://www.kaggle.com/datasets/${owner}/${a.slug}`,
        `  mount as: /kaggle/input/${a.slug}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }),
);

server.registerTool(
  'dataset_list',
  {
    title: 'List Kaggle datasets',
    description:
      'Search/list Kaggle datasets. `dataset_push` creates PRIVATE datasets by default and the API hides those from an unfiltered search — pass mine=true (or group="private") to see your own uploads.',
    inputSchema: {
      search: z.string().optional(),
      user: z.string().optional(),
      mine: z.boolean().optional().describe('Only datasets you own (group=private)'),
      group: z.enum(['public', 'private']).optional().describe('Proto enum under the hood: 1=public, 2=private'),
      page: z.number().optional(),
      page_size: z.number().optional(),
    },
  },
  guard(async (a) => {
    const c = creds();
    const options = {
      search: a.search,
      user: a.user,
      page: a.page ?? 1,
      pageSize: a.page_size ?? 20,
    };
    if (a.mine) {
      options.user = ownerOf(a.user);
      options.group = kaggle.DATASET_GROUP.PRIVATE;
    } else if (a.group) {
      options.group = kaggle.DATASET_GROUP[a.group.toUpperCase()];
    }
    const items = await kaggle.listDatasets(c, options);
    if (!items.length) {
      return ok(
        a.mine || a.group
          ? 'No datasets found.'
          : 'No datasets found. (Private datasets are hidden by default — pass mine=true.)',
      );
    }
    return ok(
      items
        .map(
          (d) =>
            `- ${d.title || d.ref}\n  ref: ${d.ref} | size: ${d.totalBytes ?? '?'} bytes${d.isPrivate ? ' | private' : ''}`,
        )
        .join('\n'),
    );
  }),
);

server.registerTool(
  'dataset_files',
  {
    title: 'List files inside a dataset',
    description: 'List the files of a dataset (and its readiness) — the quickest way to confirm that dataset_push really landed.',
    inputSchema: {
      slug: z.string().describe('Dataset slug'),
      owner: z.string().optional(),
    },
  },
  guard(async (a) => {
    const c = creds();
    const owner = ownerOf(a.owner);
    const [files, status] = await Promise.all([
      kaggle.listDatasetFiles(c, owner, a.slug),
      kaggle.datasetStatus(c, owner, a.slug).catch((e) => `unknown (${e.message})`),
    ]);
    return ok(
      [
        `${owner}/${a.slug}  status=${status}`,
        `mounts at: /kaggle/input/${a.slug}`,
        `${files.length} file(s):`,
        ...files.slice(0, 60).map((f) => `  ${f.name} (${f.totalBytes ?? '?'} bytes)`),
        files.length > 60 ? `  ... ${files.length - 60} more` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
  }),
);

/* ------------------------------------------------------------ RVC templates */

server.registerTool(
  'rvc_notebook',
  {
    title: 'Write RVC notebook cells',
    description:
      `Fill a local kernel with ready-made RVC (Retrieval-based Voice Conversion) cells for a given stage: ${RVC_STAGES.join(', ')}. Paths assume /kaggle/working for the RVC checkout and /kaggle/input/<dataset> for training audio.`,
    inputSchema: {
      kernel: z.string().describe('Local slug or path (create it with kernel_new first)'),
      stage: z.enum(RVC_STAGES).describe('Which stage to write'),
      dataset: z.string().optional().describe('Dataset slug for training audio (stage=train), mounted at /kaggle/input/<dataset>'),
      exp_name: z.string().optional().describe('RVC experiment name (default "voice")'),
      sample_rate: z.enum(['40k', '48k']).optional().describe('Default 40k'),
      epochs: z.number().optional().describe('Total epochs (default 200)'),
      batch_size: z.number().optional().describe('Default 8'),
      f0_method: z.enum(['rmvpe', 'pm']).optional().describe('Pitch extractor (default rmvpe; the repo accepts only rmvpe|pm)'),
      mode: z.enum(['replace', 'append']).optional().describe('Default replace'),
    },
  },
  guard(async (a) => {
    const k = loadKernel(a.kernel);
    const cells = rvcCells({
      stage: a.stage,
      dataset: a.dataset,
      expName: a.exp_name ?? 'voice',
      sampleRate: a.sample_rate ?? '40k',
      epochs: a.epochs ?? 200,
      batchSize: a.batch_size ?? 8,
      f0Method: a.f0_method ?? 'rmvpe',
    });
    setCells(k.notebook, cells, a.mode ?? 'replace');
    saveKernel(k, { nb: k.notebook });
    return ok(`Wrote ${cells.length} RVC "${a.stage}" cell(s) into ${path.basename(k.codeFile)}.`);
  }),
);

  return server;
}

/* ------------------------------------------------------------------- boot */

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log('kaggle-rvc MCP server ready (stdio)');
}

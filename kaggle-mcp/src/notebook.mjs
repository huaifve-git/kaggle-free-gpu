/**
 * Notebook (.ipynb) and kernel-metadata.json helpers.
 *
 * Kaggle kernels are driven from a local directory:
 *   <kernels-root>/<slug>/
 *     kernel-metadata.json   (id, title, code_file, enable_gpu, enable_internet, *_sources)
 *     <slug>.ipynb           (the notebook that gets uploaded and run)
 */
import fs from 'node:fs';
import path from 'node:path';

export const GPU_MACHINE_SHAPES = [
  'NvidiaTeslaT4', // T4 x2
  'NvidiaTeslaP100',
  'NvidiaL4',
  'NvidiaL4X4',
  'NvidiaA100',
  'TpuV5E8',
];

export function slugify(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function newNotebook() {
  return {
    cells: [],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

/** nbformat 4.5+ wants a stable per-cell `id`; Kaggle already warns without it. */
function cellId(i) {
  return `cell-${String(i).padStart(3, '0')}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Normalize loose cell input into nbformat cells. */
export function normalizeCells(cells) {
  if (!Array.isArray(cells)) throw new Error('cells must be an array');
  return cells.map((c, i) => {
    if (c === null || typeof c !== 'object') throw new Error(`cell ${i} must be an object`);
    const kind = c.type ?? c.cell_type ?? 'code';
    if (kind !== 'code' && kind !== 'markdown') {
      throw new Error(`cell ${i}: type must be "code" or "markdown", got ${JSON.stringify(kind)}`);
    }
    const raw = c.source ?? c.code ?? c.text ?? '';
    const source = Array.isArray(raw) ? raw : String(raw).split('\n').map((l, idx, arr) => (idx < arr.length - 1 ? `${l}\n` : l));
    const id = c.id ?? cellId(i);
    if (kind === 'markdown') return { cell_type: 'markdown', id, metadata: {}, source };
    return {
      cell_type: 'code',
      execution_count: null,
      id,
      metadata: {},
      outputs: [],
      source,
    };
  });
}

export function readNotebook(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeNotebook(file, nb) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(nb, null, 1)}\n`, 'utf8');
}

/** Set the notebook's cells. mode: replace (default) | append | prepend */
export function setCells(notebook, cells, mode = 'replace') {
  const incoming = normalizeCells(cells);
  if (mode === 'replace') notebook.cells = incoming;
  else if (mode === 'append') notebook.cells = [...notebook.cells, ...incoming];
  else if (mode === 'prepend') notebook.cells = [...incoming, ...notebook.cells];
  else throw new Error(`mode must be replace|append|prepend, got ${mode}`);
  notebook.nbformat = 4;
  notebook.nbformat_minor = notebook.nbformat_minor ?? 5;
  return notebook;
}

/** Render a notebook as plain text so the model can read it back cheaply. */
export function renderNotebook(notebook, { maxChars = 20000 } = {}) {
  const parts = [];
  notebook.cells.forEach((cell, i) => {
    const head = `# --- cell ${i} [${cell.cell_type}] ---`;
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
    parts.push(`${head}\n${src}`);
  });
  let text = parts.join('\n\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n... (truncated)`;
  return text;
}

/** A .ipynb is valid on Kaggle as a script source too, but plain scripts also work. */
export function notebookToScript(notebook) {
  const chunks = [];
  notebook.cells.forEach((cell, i) => {
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '');
    if (cell.cell_type === 'markdown') {
      chunks.push(src.split('\n').map((l) => `# ${l}`).join('\n'));
    } else {
      chunks.push(`# %% [cell ${i}]\n${src}`);
    }
  });
  return `${chunks.join('\n\n')}\n`;
}

export function defaultMetadata({ username, slug, title, codeFile, opts = {} }) {
  return {
    id: `${username}/${slug}`,
    title,
    code_file: codeFile,
    language: opts.language ?? 'python',
    kernel_type: opts.kernel_type ?? 'notebook',
    is_private: opts.is_private ?? true,
    enable_gpu: opts.enable_gpu ?? true,
    enable_internet: opts.enable_internet ?? true,
    machine_shape: opts.machine_shape ?? '',
    dataset_sources: opts.dataset_sources ?? [],
    competition_sources: opts.competition_sources ?? [],
    kernel_sources: opts.kernel_sources ?? [],
    model_sources: opts.model_sources ?? [],
  };
}

/** Resolve a user-supplied kernel reference to an absolute local kernel dir. */
export function resolveKernelDir(root, ref) {
  const dir = path.isAbsolute(ref) ? ref : path.join(root, ref);
  return path.resolve(dir);
}

export function readMetadata(kernelDir) {
  const file = path.join(kernelDir, 'kernel-metadata.json');
  if (!fs.existsSync(file)) throw new Error(`no kernel-metadata.json in ${kernelDir}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeMetadata(kernelDir, meta) {
  fs.mkdirSync(kernelDir, { recursive: true });
  fs.writeFileSync(path.join(kernelDir, 'kernel-metadata.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

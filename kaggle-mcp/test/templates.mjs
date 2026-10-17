#!/usr/bin/env node
/**
 * Generate the RVC template notebooks and dump every code cell to a .py file so a
 * real Python 3.12 can syntax-check them (see the pwsh step that runs py_compile).
 *
 * Run: node test/templates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rvcCells, RVC_STAGES } from '../src/rvc-templates.mjs';
import { newNotebook, setCells, renderNotebook } from '../src/notebook.mjs';
import { cleanNotebookForPush } from '../src/kaggle-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const outRoot = path.resolve(here, '..', '..', 'kernels', '_template_check');
fs.rmSync(outRoot, { recursive: true, force: true });
fs.mkdirSync(path.join(outRoot, 'cells'), { recursive: true });

const ctx = {
  dataset: 'rvc-myvoice-dataset',
  expName: 'voice',
  sampleRate: '40k',
  epochs: 200,
  batchSize: 8,
  f0Method: 'rmvpe',
};

let problems = 0;
const pyFiles = [];

for (const stage of RVC_STAGES) {
  const cells = rvcCells({ stage, ...ctx });
  const nb = setCells(newNotebook(), cells, 'replace');

  // every cell must carry an id (nbformat 4.5) and a valid source
  for (const [i, c] of nb.cells.entries()) {
    if (!c.id) {
      console.log(`FAIL  ${stage} cell ${i}: missing id`);
      problems += 1;
    }
    if (typeof c.source !== 'string' && !Array.isArray(c.source)) {
      console.log(`FAIL  ${stage} cell ${i}: bad source`);
      problems += 1;
    }
  }

  const file = path.join(outRoot, `${stage}.ipynb`);
  fs.writeFileSync(file, `${JSON.stringify(nb, null, 1)}\n`, 'utf8');

  // round-trip through the push cleaner: ids must survive it
  const pushed = JSON.parse(cleanNotebookForPush(fs.readFileSync(file, 'utf8'), file));
  const lostIds = pushed.cells.filter((c) => !c.id).length;
  if (lostIds) {
    console.log(`FAIL  ${stage}: ${lostIds} cell id(s) lost in cleanNotebookForPush`);
    problems += 1;
  }

  const codeCells = nb.cells.filter((c) => c.cell_type === 'code');
  const chars = nb.cells.reduce((n, c) => n + String(c.source).length, 0);
  console.log(
    `OK    ${stage.padEnd(6)} cells=${String(nb.cells.length).padStart(2)} ` +
      `code=${codeCells.length} chars=${chars} ids=${nb.cells.every((c) => c.id)}`,
  );

  codeCells.forEach((c, i) => {
    const py = path.join(outRoot, 'cells', `${stage}-${String(i).padStart(2, '0')}.py`);
    // nbformat cells store source as a list of lines; join, never String() it.
    const text = Array.isArray(c.source) ? c.source.join('') : String(c.source);
    fs.writeFileSync(py, text, 'utf8');
    pyFiles.push(py);
  });
}

// The big template is only useful if it is readable; show the train stage's start.
console.log('\n--- preview: train stage, first cells ---');
const trainNb = JSON.parse(fs.readFileSync(path.join(outRoot, 'train.ipynb'), 'utf8'));
console.log(renderNotebook(trainNb, { maxChars: 1200 }));

console.log(`\nwrote ${pyFiles.length} python cell(s) to ${path.join(outRoot, 'cells')}`);
console.log(problems ? `\n${problems} PROBLEM(S)` : '\nno structural problems');
process.exit(problems ? 1 : 0);

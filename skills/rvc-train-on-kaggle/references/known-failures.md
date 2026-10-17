# RVC training failures that actually happened

Each entry: the exact error, what it means, the fix — and whether the fix already lives in
the shared template (`kaggle-mcp/src/rvc-templates.mjs`). If a fix is in the template, the
correct action is to re-push (or improve the template), never to hand-edit one notebook.

## Environment / install

### `Key backend: 'module://matplotlib_inline.backend_inline' is not a valid value for backend`

```
ValueError: Key backend: 'module://matplotlib_inline.backend_inline' is not a valid value for backend;
supported values are ['gtk3agg', ...]
```

`train/utils.py::plot_spectrogram_to_numpy` imports matplotlib, and the Kaggle notebook
exports `MPLBACKEND=module://matplotlib_inline.backend_inline`, which the venv's matplotlib
does not have. It fires **after** epoch 1 has already printed losses, so it looks like a
training failure.

**Fix (in template):** the preamble sets `os.environ["MPLBACKEND"] = "Agg"`.

### `No solution found when resolving dependencies … torch==2.7.1+cu118`

```
error: No solution found when resolving dependencies
  cause: Because there is no version of torch==2.7.1+cu118 and you require torch==2.7.1+cu118 …
  hint: `torch` was found on https://pypi.org/simple, but not at the requested version …
        use `--index-strategy unsafe-best-match`
```

uv only looks at the **first** index that carries a package, so `--index-url <pytorch>` plus
`--extra-index-url pypi` never reaches the `+cu118` build.

**Fix (in template):** `--index-strategy unsafe-best-match`.

### `nvidia-cudnn-cu11==8.9.5.29 has no wheels with a matching platform tag`

```
cause: Because nvidia-cudnn-cu11==8.9.5.29 has no wheels with a matching platform tag
       (e.g., `manylinux_2_39_x86_64`) …
hint: Wheels are available for `nvidia-cudnn-cu11` (v8.9.5.29) on the following platform: `win_amd64`
```

The repo's requirements pin CUDA-11 runtime DLLs that only publish **Windows** wheels. They
serve the optional MSST/pymss separation path, which the CLI train/infer code never imports.

**Fix (in template):** `ensure_env()` filters `nvidia-*` and `onnxruntime-gpu` out of the
requirements; torch (installed separately) carries its own CUDA libraries.

### `No module named 'infer'` → then a circular `ImportError`

```
File "/kaggle/working/rvc/train/preprocess.py", line 21, in <module>
    from infer.audio import load_audio
ModuleNotFoundError: No module named 'infer'
```

`python train/preprocess.py` puts **`train/`** (the script's directory) on `sys.path`, not the
repo root. Add the repo root via `PYTHONPATH` and the next error appears:

```
File "/kaggle/working/rvc/train/preprocess.py", line 22, in <module>
    from train.dataset.slicer2 import Slicer
File "/kaggle/working/rvc/train/train.py", line 31, in <module>
    from train import utils
ImportError: cannot import name 'utils' from partially initialized module 'train'
```

…because `import train` now resolves to the `train/train.py` **module** instead of the `train`
package.

**Fix (in template):** every stage script is launched as a module:
`python -m train.preprocess`, `-m train.dataset.extract_f0`,
`-m train.dataset.extract_hubert_feature`, `-m train.train`, `-m train.train_index`,
`-m infer.cli`. Keep `PYTHONPATH` set as well — it is harmless and helps the one-off scripts.

## Data / pipeline

### `no sample survived all extraction steps`

The `filelist.txt` builder intersects the stems of `0_gt_wavs`, `3_feature768`, `2a-f0` and
`2b-f0nsf`. f0 files are named `<name>.wav.npy` — the `.wav` survives the `.npy` append — so
stripping only `.npy` leaves `<name>.wav` and the intersection is empty.

**Fix (in template):** strip the full `.wav.npy`, accept both `.wav.npy` and `.npy`, discover
the directory names (`2a_f0` vs `2a-f0`) instead of hardcoding them, and print
`counts — gt:N features:N f0:N f0nsf:N` so a zero column names the guilty step.

### `dataset not mounted at /kaggle/input/<slug>`

The kernel metadata really does contain `datasetDataSources: ["owner/slug"]` — a **first** run
of a brand-new kernel can start before the attachment lands.

**Fix:** push again (version 2 mounts it). The template also discovers whatever is actually
mounted, so a renamed dataset does not break the run.

### `training produced no <exp>.pth. Present: []`

`train/process_ckpt.py::savee` writes to a hardcoded relative `assets/weights/` inside a bare
`try/except` that **returns the traceback as a string instead of raising** — a missing
directory is indistinguishable from success.

**Fix (in template):** `ensure_repo()` creates `assets/weights`, `assets/indices` and `logs`,
and the post-train cell asserts the `.pth` exists before continuing.

### `logs/<EXP>` missing / preprocess dies instantly

`preprocess.py` and `extract_f0.py` open their log file **at import time**, so the experiment
directory must exist first.

**Fix (in template):** the cell before preprocessing creates `logs/<EXP>`.

## Platform behaviour (not bugs to fix)

| Symptom | Reality |
|---|---|
| Status `CANCEL_ACKNOWLEDGED` ≈30 s in | Observed twice on an identical workload that completes on re-push; a control sleep-kernel and an isolated `uv venv + uv pip install torch` probe both reached `COMPLETE`. Re-push. |
| 573 output files, log listing slow | Expected: `/kaggle/working` holds the repo + assets. Use `match=` and `kernel_logs` (single-page log read). |
| `torch … cuda: False` in the log | The kernel ran on CPU. Check `machine_shape`/`gpu` on the kernel; GPU kernels report `cuda: True, devices: 2` on T4 ×2. |
| `/kaggle/working` empty on the next run | Runs start in fresh containers; only a **completed** run's output persists, and only via a data source. |

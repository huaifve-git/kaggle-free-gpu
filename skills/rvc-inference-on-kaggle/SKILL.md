---
name: rvc-inference-on-kaggle
description: Convert audio with a trained RVC voice model on Kaggle through the kaggle MCP server — mount the model as a kernel source or dataset, run the repo's inference CLI on a GPU kernel, bring the converted WAVs back, and place the .pth + .index where RVC WebUI or the CLI expects them. Use for inference / 推理 / 变声 / 声音转换 / 用模型转换音频 / 音色替换 with an existing RVC model, or when asked where a trained model and index belong.
whenToUse: The user wants to convert/voice-change audio with an RVC model (theirs or one trained earlier), asks where a trained .pth and .index belong, or asks why an RVC inference run produced nothing.
---

# Convert audio with an RVC model on Kaggle

Runs `infer/cli.py` on a Kaggle GPU kernel through the `kaggle` MCP tools
(`mcp__kaggle__*`), using a model that was trained earlier — either on Kaggle (see the
`rvc-train-on-kaggle` skill) or uploaded from local.

## 1. Where the model comes from

Pick one, they are all just kernel metadata:

| Source | How to wire it |
|---|---|
| A kernel you trained | `kernel_sources=["<owner>/<train-kernel-slug>"]` → the model lands read-only at `/kaggle/input/<train-kernel-slug>/out/` |
| A Kaggle dataset holding the model | `dataset_sources=["<owner>/<dataset-slug>"]` |
| A local file | `dataset_push` it first, then mount the dataset |

The template's `find_model()` searches this run's `assets/weights/`, then `/kaggle/working/out`,
then **any mount under `/kaggle/input`** (recursively) for `<exp_name>.pth`, and carries over a
matching `*_added*.index` when it finds one. So mount the artifacts and pass the right
`exp_name` — that is the model's file stem, e.g. `myvoice`.

## 2. The sequence

```text
kernel_new      title="RVC infer <voice>", slug="rvc-infer-<voice>",
                gpu=true, machine_shape="NvidiaTeslaT4",
                internet=true, is_private=true,
                kernel_sources=["<owner>/rvc-train-<voice>"],     # the model
                dataset_sources=["<owner>/<audio-dataset>"]       # optional input audio
rvc_notebook    kernel="rvc-infer-<voice>", stage="infer", exp_name="<voice>", sample_rate="40k"
kernel_push     kernel="rvc-infer-<voice>"     # ~5 min: venv rebuild + conversion
kernel_status   kernel="rvc-infer-<voice>"
kernel_output   kernel="rvc-infer-<voice>", match="converted/"
```

Without `dataset_sources`, put the source audio at `/kaggle/working/input/` in the notebook
(or add a dataset). The convert cell falls back to any audio it finds under `/kaggle/input`, so
a dataset mount alone is enough for a smoke test.

## 3. Parameters that matter

The template runs `python -m infer.cli` (module form — see the training skill's note on
`sys.path`). Edit the cell for these:

| Flag | Default in template | Effect |
|---|---|---|
| `--pitch` | `0` | Transpose in semitones. `+12` = up an octave. The single most useful knob for matching a target voice's range. |
| `--f0-method` | `rmvpe` | Only `rmvpe` and `pm` exist. `rmvpe` is better quality and slower. |
| `--index-rate` | `0.75` | How much the retrieval index influences timbre. `0` = ignore the index (and then no index is needed). |
| `--protect` | `0.33` | `0..0.5`: protects unvoiced consonants from the model. Raise it if sibilants sound broken. |
| `--resample-sr` | `0` | Output sample rate override; `0` keeps the model's. |
| `--rms-mix-rate` | `1.0` | Blends the source's loudness envelope. |
| `--speaker-id` | — | Only for multi-speaker models. |

It writes `<name>_converted.wav` per input clip into `/kaggle/working/converted/`. A successful
clip logs `Status：Success` plus `Elapsed time：Features … | F0 … | Synthesis …`.

## 4. Getting the audio and the model to the user

* Converted audio: `kernel_output` with `match="converted/"` (the run's output tree also holds
  the repo and assets — a real inference run reported 348 files, 3 of them audio).
* Staging a model locally: `<voice>.pth` → `assets/weights/`, the index →
  `assets/indices/` (WebUI scans `assets/weights` for models and `logs` + `assets/indices` for
  indexes). Then:

```bash
python -m infer.cli --model assets/weights/<voice>.pth \
  --index assets/indices/<voice>_added_<...>.index \
  --input in.wav --output out.wav --pitch 0 --f0-method rmvpe --index-rate 0.75
```

* Sanity-check a downloaded model: a torch `.pth` is a ZIP container (starts `PK\x03\x04`);
  a FAISS index starts `IwFl`. Wrong magic means a truncated download — retry, the download
  path has automatic retries for exactly this.

## 5. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `no trained model (<exp>.pth) found in this kernel or under /kaggle/input` | Wrong `exp_name`, or the source kernel/dataset is not mounted. `kernel_sources`/`dataset_sources` only take effect from the **second** push of a brand-new kernel. |
| Notebook printed `put source audio in …` and converted nothing | No input audio staged and nothing audio-like under `/kaggle/input`. Add a dataset or write a file to `/kaggle/working/input`. |
| `Index：` line missing / `--index-rate 0` | No index found next to the model. Either mount it, or pass `--index-rate 0` and accept lower similarity. |
| Conversion output is silent or garbled | Usually too few training epochs or too little training audio — check the model's provenance before blaming the inference run. |
| `cuda: False` in the log | The kernel has no GPU. Set `gpu=true, machine_shape="NvidiaTeslaT4"` on the kernel. |

Runs take ~5 minutes: the fresh container rebuilds the 3.12 venv and the pretrained assets
before converting (see `ensure_repo()` / `ensure_env()` in
`kaggle-mcp/src/rvc-templates.mjs`). Conversion itself is seconds per clip on a T4.

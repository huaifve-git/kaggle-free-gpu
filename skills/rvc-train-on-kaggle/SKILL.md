---
name: rvc-train-on-kaggle
description: Train or retrain an RVC (Retrieval-based Voice Conversion) voice model on Kaggle through the kaggle MCP server, from a voice dataset to a .pth model plus its FAISS index. Use when the user asks to train/retrain a voice model, 训练模型 / 训练声音 / 重训 RVC / 语音克隆 / 音色模型, or asks why such a run failed. Covers the exact tool sequence, GPU-quota checks, artifact verification, and every failure mode seen in real runs.
whenToUse: The user wants to train, retrain, or improve an RVC voice model on Kaggle; wants a voice model out of an audio dataset; or asks why an RVC training run on Kaggle failed.
---

# Train an RVC voice model on Kaggle

Drives the `kaggle` MCP tools (`mcp__kaggle__*`) to run the real
[RVC-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI) training
pipeline on a Kaggle GPU kernel, then brings the model back.

The cell generator already encodes every trap found in live runs, so the job here is to
choose the right inputs, launch it, verify the artifacts, and diagnose honestly if it fails.

## 1. Before spending GPU quota

| Check | Why it matters |
|---|---|
| The dataset exists and is `READY` | `dataset_files` on the slug. Upload with `dataset_push` if missing. |
| How much audio | `dataset_files` lists sizes. **10+ minutes** of clean, dry, single-speaker vocal is the realistic floor; a handful of short clips trains a toy. |
| Is it already sliced? | Clips of 5-20 s are ideal. Very long files are fine (preprocess slices them), very short ones waste extraction time. |
| GPU quota | Kaggle gives ~30 h/week, reset weekly, and it is shared with everything else the user runs. Say how much you are about to spend. |
| Epochs | The WebUI slider defaults to 20; the repo documents up to 1200. Budget roughly (audio minutes × epochs): 200 epochs on ~4 minutes is minutes, not hours. |

If the audio is thin, **say so before training** rather than after: a 2-epoch model on 4
minutes verifies the pipeline and nothing else.

## 2. The sequence

```text
kernel_new      title="RVC train <voice>", slug="rvc-train-<voice>",
                gpu=true, machine_shape="NvidiaTeslaT4",
                internet=true, is_private=true,
                dataset_sources=["<owner>/<dataset-slug>"]
rvc_notebook    kernel="rvc-train-<voice>", stage="train",
                dataset="<dataset-slug>", exp_name="<voice>",
                sample_rate="40k", epochs=200, batch_size=8, f0_method="rmvpe"
kernel_push     kernel="rvc-train-<voice>"        # returns as soon as the run is queued
kernel_status   kernel="rvc-train-<voice>"        # poll; do not block a turn on kernel_wait
kernel_logs     kernel="rvc-train-<voice>"        # on failure, or to confirm what ran
kernel_output   kernel="rvc-train-<voice>", match="out/"
```

Then hand the artifacts to the inference skill (or the user): `out/<voice>.pth` and
`out/<voice>_added_*.index`.

Notes that save time:

* `kernel_push` defaults to `wait: false` **on purpose** — pushing starts the run; polling
  `kernel_status` is free. Only pass `wait: true` when a blocking wait is acceptable (the
  DSH bridge allows it; the raw MCP SDK client needs an explicit longer `timeout`).
* `match="out/"` matters: the run's `/kaggle/working` also holds the whole cloned repo and
  ~650 MB of pretrained assets. A real run reported **573 output files**, of which 3 were
  the artifacts.
* A 16-minute-ish run is normal: setup (clone + assets + venv) ≈ 2-4 min, extraction ≈ 1 min
  for a small dataset, training scales with epochs.

## 3. What the kernel does for you

`stage="train"` writes 12 cells that are **standalone** — a Kaggle run always starts in a
fresh container, so the notebook rebuilds what it needs instead of relying on files another
kernel left behind:

1. `ensure_repo()` — clone the pinned commit, verify the layout, fetch the pretrained assets.
2. `ensure_env()` — Python 3.12 venv (Kaggle's system python is 3.13) with the repo's pinned
   `torch==2.7.1+cu118` pair and its requirements minus the Windows-only CUDA DLL pins.
3. Stage the audio out of `/kaggle/input/<dataset>` into `/kaggle/working/dataset`.
4. `preprocess.py` → `extract_f0.py` → `extract_hubert_feature.py`.
5. Synthesize `filelist.txt` + `config.json` (no CLI generates these; v2 + 40k reads
   `configs/v1/40k.json`).
6. `train.train`, then assert the `.pth` really exists, then `train.train_index`.

## 4. Verify before reporting

A `COMPLETE` status is necessary but not sufficient — read the log tail and confirm:

* `filelist.txt: N line(s) — M samples` with M > 0.
* training losses appear (`loss_disc=… loss_gen=…`) for at least one epoch.
* the artifact listing from `kernel_output` contains `out/<voice>.pth` and an `.index`.

Downloaded files keep their tree (`out/<voice>.pth`). Sanity-check the model: a torch `.pth`
is a ZIP container, so its first bytes are `PK\x03\x04` (`50 4B 03 04`); a FAISS index starts
with `IwFl` (`49 77 46 6C`).

## 5. Report honestly

State: kernel ref + version, epochs, audio minutes/slices, wall-clock, and what the model is
**for**. Never describe a low-epoch model as a usable voice — offer to retrain with more
epochs, or to add audio first (`dataset_push` with `version_notes` creates a new version of
the same dataset).

## 6. When it fails

Start from `kernel_logs` (it reads the run log in one call, so it stays fast). The failures
that actually happened, with their real error strings and fixes, are in
[references/known-failures.md](references/known-failures.md) — check there before inventing a
fix, and prefer fixing the shared template (`kaggle-mcp/src/rvc-templates.mjs`) over
hand-patching one notebook, so the next run benefits too.

Platform quirks, not code faults — do not chase these:

* A brand-new kernel can start its **first** run before its data source attaches
  (`dataset not mounted`, while the metadata already lists `datasetDataSources`). Re-push.
* A stray `CANCEL_ACKNOWLEDGED` ~30 s in has been observed twice on an identical workload
  that otherwise completes. Re-push before debugging.

# kaggle-rvc — a Kaggle MCP server for RVC work

> **Scope:** this is the *internal* document — implementation details, Kaggle API differences,
> wire-level traps and the live-run log. For the user-facing overview (in Simplified Chinese),
> see the repository root [`../README.md`](../README.md).

A local **MCP server (stdio)** that lets an agent drive Kaggle the way this task needs it:
scaffold a notebook on disk, write cells into it, push it to Kaggle with **GPU + internet +
dataset sources**, let it run, then poll the status and pull the logs and output files back.

It is registered in DSH as the MCP server `kaggle`, so its tools appear as
`mcp__kaggle__<tool>`.

**Companion skills:** [`../skills/`](../skills) holds two DSH skills that pair with these
tools — `rvc-train-on-kaggle` (dataset → model + index) and `rvc-inference-on-kaggle`
(model → converted audio). They are registered as a custom skill root in the same profile
patch, so an agent picks them up automatically when a request matches.

---

## Why this exists (the gap it fills)

There are Kaggle MCP servers already; none of them can run RVC:

| Option | Why it is not enough |
|---|---|
| [Kaggle's official remote MCP](https://www.kaggle.com/docs/mcp) (`https://www.kaggle.com/mcp`) | Needs an interactive OAuth flow that DSH's MCP client (static headers, no OAuth dance) cannot perform; [its `save_notebook` also drops data sources](https://www.kaggle.com/discussions/product-feedback/727647). |
| [Galaxy-Dawn/kaggle-mcp](https://github.com/Galaxy-Dawn/kaggle-mcp) | 51 tools, but `kernel_push` sends only `title`/`text`/`language`/`kernel_type`/`is_private`. No `enable_gpu`, no `enable_internet`, no `dataset_sources` — an RVC run cannot install dependencies or see its training audio. |
| [dexhunter/kaggle-mcp](https://github.com/dexhunter/kaggle-mcp) · [Dishant27/kaggle-MCP](https://github.com/Dishant27/kaggle-MCP) | Competitions-only / sample-grade. |
| [jupyter-mcp-server](https://pypi.org/project/jupyter-mcp-server/) | Excellent for a *live* Jupyter kernel, but Kaggle's API exposes no such endpoint; it needs a Jupyter URL + token you do not have for a Kaggle batch kernel. |

So this server speaks the current Kaggle API directly and treats the things RVC needs as
first-class fields.

## How it talks to Kaggle

Two different Kaggle APIs exist today, and using the wrong one is the main trap:

* **`https://api.kaggle.com/v1/<service>/<method>`** — the JSON RPC surface the *current*
  official CLI (`kagglesdk`) uses. This server uses it for everything:
  `kernels.KernelsApiService/{ListKernels,GetKernel,SaveKernel,GetKernelSessionStatus,ListKernelSessionOutput}`,
  `datasets.DatasetApiService/{ListDatasets,CreateDataset,CreateDatasetVersion,ListDatasetFiles}`,
  `blobs.BlobApiService/StartBlobUpload`.
* **`https://www.kaggle.com/api/v1/...`** — the older REST surface. Still alive for
  `/kernels/list` and `/kernels/pull`, but **`/kernels/status` and `/kernels/output` now
  404**, so it is not used here.

Auth: `Authorization: Bearer <token>` (a `KGAT_…` token) or HTTP Basic (`username:key`).

Three wire details worth knowing, because they cost real debugging time:

1. **Push uses `slug`, not `id`.** `ApiSaveKernelRequest.id` is the *numeric* kernel id and
   sending a string there gets you an HTTP 400 **with an empty body**. `slug` is the
   `"owner/kernel-slug"` string.
2. **Kaggle overrides the slug with a slug derived from the title.** The push responds with
   `ref: "/code/<owner>/some-title-derived-slug"`; the server normalizes that to
   `owner/slug` and writes it back into the local `kernel-metadata.json`, so later polls and
   pushes hit the same kernel.
3. **HTTP 200 can still be a failure:** legacy-shaped `{"code": >=400}` and `{"error": "…"}`
   bodies are treated as errors. A 403 `Permission 'kernels.get' was denied` on a kernel you
   own usually just means *that slug does not exist*.

## Credentials

Looked up in order, first hit wins (see [config.mjs](src/config.mjs)):

1. `KAGGLE_API_TOKEN` in the environment (bearer)
2. `KAGGLE_USERNAME` + `KAGGLE_KEY` in the environment (basic)
3. `~/.kaggle/access_token` (bearer) ← what this machine uses
4. `~/.kaggle/kaggle.json` (`{username, key}`)
5. `<workspace>/.secrets/kaggle.env` or `.secrets/kaggle.json` (gitignored)

`status` reports **which source** was used and never prints the secret.

## Tools

| Tool | What it does |
|---|---|
| `status` | Credentials source, resolved username, local dirs, live API ping |
| `kernel_new` | Scaffold `<kernels>/\<slug\>/` with a `.ipynb` + `kernel-metadata.json` (GPU, shape, internet, dataset/model/competition/kernel sources) |
| `kernel_write` | Set/append/prepend notebook cells (the "write into the notebook" step) |
| `kernel_read` | Show metadata + cells of a local kernel |
| `kernel_configure` | Change GPU / `machine_shape` / internet / privacy / sources |
| `kernel_push` | Upload and **run** it (`Save & Run All`); returns as soon as the run is queued, or blocks with `wait: true` |
| `kernel_status` | queued / running / COMPLETE / ERROR + failure message |
| `kernel_wait` | Poll until terminal state or timeout |
| `kernel_logs` | Download the output archive; return the log tail + produced files |
| `kernel_output` | Download the produced files (models, indices, audio) |
| `kernel_list` | Search/list kernels |
| `kernel_pull` | Download an existing kernel into `<kernels>/<slug>` for editing |
| `dataset_push` | Upload a folder as a private dataset (or a new version) — this is how training audio reaches `/kaggle/input/<slug>` |
| `dataset_list` | Search/list datasets |
| `rvc_notebook` | Fill a kernel with ready-made RVC cells: `stage: setup \| train \| infer` |

Local layout under the workspace (`A:\Apps\kaggle_rvc_2`):

```
kernels/<slug>/         local kernel: <slug>.ipynb + kernel-metadata.json
outputs/<owner>__<slug>/ downloaded outputs + <owner>__<slug>.log
.secrets/kaggle.env     credentials fallback (gitignored)
kaggle-mcp/             this server
```

## Recipes

**Create, write, run, read back**

```
kernel_new      title="my notebook", gpu=true, internet=true
kernel_write    kernel="my-notebook", cells=[...]
kernel_push     kernel="my-notebook"            # queues a run, returns immediately
kernel_status   kernel="my-notebook"            # poll until COMPLETE
kernel_logs     kernel="my-notebook"            # why it failed (or what it printed)
kernel_output   kernel="my-notebook"            # bring the artifacts home
```

**RVC, in three optional notebooks** (all cells come from `rvc_notebook`)

Each stage is **standalone**: every Kaggle run starts in a fresh container, so `train` and
`infer` rebuild the checkout, the pretrained assets and the venv themselves through the
idempotent `ensure_repo()` / `ensure_env()` helpers. The `setup` stage exists to prove the
environment once, up front, before you spend GPU hours.

```
# optional, but it fails fast and cheaply
kernel_new      title="RVC voice setup",   slug="rvc-setup",  gpu=true, internet=true
rvc_notebook    kernel="rvc-setup", stage="setup"
kernel_push     kernel="rvc-setup"

# the one that matters: a GPU kernel whose data source is your voice dataset
kernel_new      title="RVC train myvoice", slug="rvc-train",  gpu=true, internet=true,
                dataset_sources=["<owner>/rvc-myvoice-dataset"]
rvc_notebook    kernel="rvc-train", stage="train", dataset="rvc-myvoice-dataset", exp_name="myvoice"
kernel_push     kernel="rvc-train"        # preprocess -> f0 -> hubert -> train -> index
kernel_output   kernel="rvc-train"        # myvoice.pth + index land in outputs/
```

Getting the audio up there first:

```
dataset_push    folder="A:\Apps\kaggle_rvc_2\myvoice", slug="rvc-myvoice-dataset"
dataset_files   slug="rvc-myvoice-dataset"      # confirm it landed (status READY + file list)
dataset_list    mine=true                       # private datasets are hidden without this
# then the train kernel mounts it at /kaggle/input/rvc-myvoice-dataset
```

## What the RVC template already knows

The upstream repo was restructured, and several of its failure modes are silent. Each of
these is handled in [rvc-templates.mjs](src/rvc-templates.mjs), verified against
`RVC-Project/Retrieval-based-Voice-Conversion-WebUI` at `81eed5e8`:

* **Kaggle's system Python is 3.13** (measured on a live run: `python : 3.13.15`) while the
  repo targets 3.12 — so the setup stage builds a private **3.12 venv with `uv`** and every
  later step runs through `venv/bin/python`. That also means the repo's pinned
  `torch==2.7.1+cu118` pair is installed *into the venv* instead of fighting the image's torch.
* Legacy paths (`infer/modules/train/*`, `requirements.txt`, `assets/hubert_base.pt`) are gone;
  current paths are `train/preprocess.py`, `train/dataset/extract_f0.py`,
  `train/dataset/extract_hubert_feature.py`, `train/train.py`, `train/train_index.py`,
  `infer/cli.py` — and the requirements file is misspelled `requirments_cu118_py312.txt`
  (with a hardcoded PKU mirror on line 1 that the template rewrites to pypi.org).
* The four `sys.argv` scripts are **positional**; each call site documents its exact order.
  `-f0` is `1|0` only, and the pitch method accepts only `rmvpe|pm`.
* `logs/<EXP>` must exist **before** `preprocess.py`/`extract_f0.py`, which open their log
  file at import time.
* `filelist.txt` and `config.json` have **no CLI generator** and are synthesized (including
  the `<name>.wav.npy` f0 naming and the two trailing `mute` lines). For v2 + 40k the repo
  reads `configs/v1/40k.json` — `configs/v2/` has no 40k file.
* `train.py`'s `savee()` writes to a hardcoded `assets/weights/` inside a bare `try/except`
  that returns the traceback *as a string*, so a missing directory looks exactly like
  success. The template creates the directory and asserts the `.pth` exists afterwards.
* Kaggle limits: 12 h per session (CPU and GPU), ~20 GB of `/kaggle/working` output, GPU
  quota resetting weekly. Only `/kaggle/working` is persisted as the version output.
* **Every Kaggle run starts in a fresh container.** Files another kernel wrote do not
  reappear by themselves — they have to arrive through a data source, which is why each
  stage calls the idempotent `ensure_repo()` (clone + ~650 MB of assets) and `ensure_env()`
  (3.12 venv + pinned cu118 torch). The venv deliberately lives in `/kaggle/temp`, outside
  the version output.
* **The repo's scripts must be launched as modules (`python -m train.preprocess`), not as
  paths.** `python train/preprocess.py` puts `train/` first on `sys.path`, so its
  `from infer.audio import ...` fails with `No module named 'infer'`. Add the repo root to
  `PYTHONPATH` and the *next* failure is a circular import, because `import train` then
  resolves to the `train/train.py` **module** instead of the `train` package. Two live runs
  went into that one.
* **`filelist.txt` needs `<name>.wav.npy` for the f0 files.** Stripping only `.npy` leaves
  `<name>.wav`, the intersection with the feature directory comes out empty, and the run dies
  with "no sample survived all extraction steps". The template strips the full suffix and
  prints per-directory counts so the failure is diagnosable next time.
* **`MPLBACKEND` leaks in from the notebook.** Kaggle sets
  `MPLBACKEND=module://matplotlib_inline.backend_inline`; the venv's matplotlib has no such
  backend, so `train.py` crashed the moment it plotted a spectrogram — right after epoch 1 had
  printed its losses. The template forces `MPLBACKEND=Agg`.
* **A brand-new kernel can start its first run before its data source attaches.** Seen
  live: the kernel metadata already contained `datasetDataSources: ["<owner>/<voice>"]` and
  the notebook still found nothing at `/kaggle/input/<voice>`; pushing version 2 mounted it.
  The template also discovers whatever is actually mounted instead of trusting the name.

## What the live runs found

Pushing real kernels is what turned up these, in order:

1. **`ApiSaveKernelRequest.id` is numeric.** Sending `id: "owner/slug"` gets HTTP 400 with an
   *empty body* — the least informative error Kaggle produces. `slug` is the string field.
2. **Kaggle rewrites the slug from the title**, so the push response's `ref` is the only
   reliable identity; the local metadata is updated from it.
3. **`KernelWorkerStatus` comes back as enum NAMES** (`COMPLETE`, `ERROR`,
   `CANCEL_ACKNOWLEDGED`). Comparing against a lowercase `"complete"` reported every
   successful run as a failure.
4. **uv needs `--index-strategy unsafe-best-match`** for the cu118 torch pair. With plain
   `--index-url`/`--extra-index-url`, uv only looks at the first index that carries `torch`
   (pypi.org) and never reaches the `+cu118` build — verified failure:
   `no version of torch==2.7.1+cu118 ... unsatisfiable`.
5. **Kaggle's system Python measured on a live run: 3.13.15**, and `/usr/bin/python3.12`
   is present, so `uv venv --python 3.12` yields Python 3.12.3 — the repo's target.
6. **`/kaggle/working` does not persist out of a run that did not complete.** Every re-push
   after a cancelled run started from a clean container.
7. **Kaggle's blob upload PUT goes to `www.googleapis.com`.** Some networks block that host
   while `storage.googleapis.com` and `api.kaggle.com` stay reachable; when it is blocked,
   `dataset_push` cannot work from that host (the error now names the host and the cause).
   The retry/backoff added for exactly this eventually got the PUT through and a private
   dataset was created, so the path is verified end to end: `dataset_push` ->
   `ListDatasetFiles` (`README.txt`, 498 B) -> `GetDatasetStatus` `READY`.
8. **`DatasetGroup` is a proto enum, not a string.** `{"group": "private"}` returns HTTP 400
   with an empty body; `{"group": 2}` lists your private datasets. Since `dataset_push`
   creates *private* datasets by default, an unfiltered `dataset_list` shows nothing — hence
   the `mine=true` option.
9. **The upstream requirements pinned Windows-only CUDA DLLs.** Installing them aborts with
   `nvidia-cudnn-cu11==8.9.5.29 has no wheels with a matching platform tag ... Wheels are
   available ... on the following platform: win_amd64`. Those pins serve the optional
   MSST/pymss separation path that the CLI train/infer code never imports, so the template
   drops them (torch, installed separately, carries its own CUDA libraries).
10. **A venv in `/kaggle/working` poisons the output listing.** A run that built one reported
    **15,599** output files and took **152 s** to list them, because every file is paged
    individually. The venv now lives in `/kaggle/temp`, and `kernel_logs` reads the log from
    a single `ListKernelSessionOutput` page instead of paging the whole tree.

## Verification

```
node test/smoke.mjs          # live: auth + all three RPC services + blob upload handshake
node test/templates.mjs      # generates the 3 RVC notebooks; all code cells are
                             # syntax-checked with a real Python 3.12 (py_compile)
node test/mcp-client.mjs     # protocol: connects the SDK client in-memory, lists all 16 tools
node test/e2e.mjs            # end-to-end: create -> write -> PUSH -> RUN -> status -> logs -> output
node test/push-wait.mjs <slug> [timeoutSec]   # push and block until the run settles
node test/rvc-setup-run.mjs [--wait]          # push the RVC setup template and let it run
node test/rvc-train-run.mjs [dataset] [exp] [epochs]   # train a real voice on GPU
node test/rvc-infer-run.mjs [exp] [dataset] [trainKernel]  # convert audio with it
```

Two harness notes learned the hard way: the SDK **client** defaults to a 60 s request
timeout, so a blocking `kernel_push(wait: true)` needs an explicit
`callTool(..., { timeout })`; and `kernel_push` therefore defaults to `wait: false`, which
is the right default for an agent that can poll `kernel_status` for free.

Results of the live runs on Kaggle (the account name is written as `<owner>` below):

| Run | Kernel | Result |
|---|---|---|
| notebook lifecycle | `kaggle-mcp-smoke-test-kaggle-mcp-smoke` | `COMPLETE`; log contained the notebook's own stdout, `out/hello.txt` downloaded |
| dataset upload | `<owner>/rvc-mcp-upload-test` | created, `READY`, `README.txt` (498 B) listed, mounts at `/kaggle/input/rvc-mcp-upload-test` |
| RVC setup | `<owner>/rvc-setup-verification` v5 | `COMPLETE` in 187 s; `setup complete: True`, all 5 pretrained assets OK, venv Python 3.12.3, torch 2.7.1+cu118 |
| RVC train | `<owner>/rvc-train-<voice>` v8 | `COMPLETE` in 237 s on GPU (T4 ×2, `cuda: True, devices: 2`); produced `out/<voice>.pth` + `out/<voice>_added_IVF140_Flat_nprobe_1_<voice>_v2.index` |
| RVC infer | `<owner>/rvc-infer-<voice>` | `COMPLETE` in 289 s; loaded model + index on `cuda:0` fp16, converted 3 clips, `Status：Success`, output `converted/<name>_converted.wav` 779 KB |

The train/infer pair also exercised the cross-notebook path: the infer kernel mounted the
train kernel's output as a **kernel source** and picked the model up from
`/kaggle/input/rvc-train-<voice>/out/`.

Tests use the SDK's **in-memory transport** rather than spawning a child process, because the
Windows sandbox blocks piped stdio (`spawn EPERM`).

## Registration in DSH

Added to the `desktop` profile patch layer (`~/.dsh/profiles/desktop/cordis.patch.yml`):

```yaml
- insert:
    - id: mcp-kaggle
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: kaggle
        transport: stdio
        command: "A:\\programsapp\\nodejs\\node.exe"
        args: ["A:\\Apps\\kaggle_rvc_2\\kaggle-mcp\\src\\server.mjs"]
        cwd: "A:\\Apps\\kaggle_rvc_2"
        env:
          KAGGLE_RVC_HOME: "A:\\Apps\\kaggle_rvc_2"
          KAGGLE_RVC_USERNAME: "<your-kaggle-username>"
```

Notes:

* The entry sits under `insert:` with **no top-level `id`**, which appends it at the root of
  the loader tree (`dsh-app-boot`'s patch semantics).
* **Editing the server code needs a DSH restart, not just a config touch.** The running
  child process keeps the modules it imported, and the profile patch layer is *not*
  hot-reloaded onto it — verified by adding a tool and bumping the patch entry's revision
  comment: the running server still reported the old tool set. The patch file itself is
  applied at boot, so the next start picks up both the config and the new code. (The sandbox
  here cannot see or signal the child process either, so there is no in-session reload.)
* Tools only appear to the model after the server is connected; if they are missing, check
  the DSH log for a `dsh-mcp-client` startup error.

## Known limits

* MCP `resources`/`prompts` are not implemented — only tools are (the DSH bridge only
  consumes tools anyway).
* **`dataset_push` depends on reaching `www.googleapis.com`** for the blob PUT. On a network
  that blocks that host it will fail with a message naming the host; upload through the
  Kaggle web UI in that case.
* **The RVC workflow is verified end to end**, but the *model* trained in that verification is
  a toy: 2 epochs on 32 slices cut from ~12 short clips (~4 minutes). It proves the pipeline
  (data → preprocess → f0 → hubert → filelist/config → train → index → inference), not voice
  quality. For a usable voice, raise `epochs` (the repo suggests up to 1200, the WebUI
  slider defaults to 20) and use 10+ minutes of clean, dry, single-speaker audio.
* `kernel_logs` reads the log from a single `ListKernelSessionOutput` page (the log is inlined
  in every page), so it stays fast even when a run has thousands of output files.
  `kernel_output` pages through the whole list and downloads everything — on a run that left
  a venv in `/kaggle/working` that was 15,599 files.
* No dataset *download* helper yet, and no competition submission flow.
* Platform hiccups happen: two early RVC setup runs were cancelled by Kaggle
  (`CANCEL_ACKNOWLEDGED`) about 30 s in, while an identical isolated probe and a control
  sleep-kernel both ran to `COMPLETE`. Re-pushing worked, so treat a stray cancel as
  transient rather than a code fault.

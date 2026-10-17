/**
 * Ready-made RVC notebook cells for Kaggle.
 *
 * Verified against RVC-Project/Retrieval-based-Voice-Conversion-WebUI at
 * HEAD 81eed5e8f68b6bed1789f682fe78cdd324495afc, whose layout is:
 *   train/preprocess.py, train/dataset/extract_f0.py,
 *   train/dataset/extract_hubert_feature.py, train/train.py,
 *   train/train_index.py, infer/cli.py
 * and whose requirements files are spelled "requirments_cu118_py312.txt".
 *
 * Non-obvious traps this template handles (each one silently breaks a naive notebook):
 *   - the four sys.argv scripts take POSITIONAL args in a fixed order;
 *   - `logs/<EXP>` must exist before preprocess/extract_f0, which open their log
 *     file at import time;
 *   - v2 + 40k loads configs/v1/40k.json (configs/v2 has no 40k);
 *   - filelist.txt and config.json have no CLI generator and must be synthesized;
 *   - train.py's savee() writes into a hardcoded assets/weights/ inside a bare
 *     try/except, so a missing dir means "training succeeded" with no model;
 *   - hubert_base.pt is gone; hubert is now a transformers directory.
 */

export const RVC_STAGES = ['setup', 'train', 'infer'];

export const RVC_REPO = 'https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI.git';
export const RVC_PIN = '81eed5e8f68b6bed1789f682fe78cdd324495afc';
const HF = 'https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/';

/** Shared preamble: constants + a run() helper used by every other cell. */
function preamble({ expName, sampleRate, epochs, batchSize, f0Method }) {
  const srInt = sampleRate === '48k' ? 48000 : 40000;
  return `# --- RVC on Kaggle: shared constants -------------------------------------
import os, sys, json, glob, random, shutil, pathlib, subprocess

REPO    = "/kaggle/working/rvc"          # the RVC checkout
WORK    = "/kaggle/working"              # everything here is saved as version output
INPUT   = "/kaggle/input"                # mounted datasets (treat as read-only)
EXP     = "${expName}"                   # experiment name (logs/<EXP>, assets/weights/<EXP>.pth)
SR      = "${sampleRate}"                # 40k | 48k
SR_INT  = ${srInt}
VERSION = "v2"
F0      = 1                              # 1 = with f0 (rmvpe), 0 = without
BS      = ${batchSize}
EPOCHS  = ${epochs}
NPROC   = max(2, os.cpu_count() or 2)
F0_METHOD = "${f0Method}"                # rmvpe | pm   (the repo accepts nothing else)
GPU     = 0                              # CUDA_VISIBLE_DEVICES for train.py
HF      = "https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/"

# The repo's scripts import the repo root (for example "from infer.audio import ..."),
# but running "python train/preprocess.py" puts train/ (the script's directory) on
# sys.path instead of the repo root, which fails with
# ModuleNotFoundError: No module named 'infer' (seen live). Put the repo root on
# PYTHONPATH once; run() passes os.environ through to every step.
os.environ["PYTHONPATH"] = REPO + os.pathsep + os.environ.get("PYTHONPATH", "")

# A notebook sets MPLBACKEND=module://matplotlib_inline.backend_inline, which the venv's
# matplotlib does not know, so train.py died the moment it plotted a spectrogram:
#   ValueError: Key backend: 'module://matplotlib_inline.backend_inline' is not a valid value
# Force the headless backend for every subprocess.
os.environ["MPLBACKEND"] = "Agg"

# Kaggle's system interpreter is Python 3.13 (verified on a live run) while the RVC
# repo targets 3.12, so everything runs inside a dedicated 3.12 venv built by uv.
# The venv lives in /kaggle/temp, NOT /kaggle/working: it holds ~15,000 files, and
# putting it in the working dir makes the version output enormous and makes the
# Kaggle API page through 150+ requests just to list the run's files.
SYS_PY  = sys.executable
VENV    = pathlib.Path("/kaggle/temp/venv")
PY      = str(VENV / "bin" / "python")

def run(cmd, cwd=None, check=True, env=None):
    """Run a command, echoing it. Positional order is passed exactly as given."""
    printable = cmd if isinstance(cmd, str) else " ".join(map(str, cmd))
    print(f"\\n$ {printable}", flush=True)
    full_env = {**os.environ, **(env or {})}
    p = subprocess.run(cmd, cwd=cwd, env=full_env, shell=isinstance(cmd, str))
    if check and p.returncode != 0:
        raise SystemExit(f"FAILED ({p.returncode}): {printable}")
    return p.returncode

def sh(cmd, **kw):
    return run(cmd, shell=True, **kw)

def torch_info(python):
    """Report torch as seen BY the venv interpreter (not the notebook kernel's)."""
    code = ("import torch;print(torch.__version__, '| cuda:', torch.cuda.is_available(),"
            "'| devices:', torch.cuda.device_count())")
    p = subprocess.run([python, "-c", code], capture_output=True, text=True)
    return (p.stdout or p.stderr).strip()

def ensure_repo(with_assets=True):
    """Clone the pinned RVC checkout and fetch the pretrained assets.

    Idempotent, and called by every stage: a Kaggle run always starts in a FRESH
    container, so a train notebook cannot rely on files a previous setup run left
    behind unless they arrive through a data source. Cloning plus ~650 MB of assets
    takes about a minute, which is cheap next to the alternative (running setup and
    training in one long session, or wiring kernel_sources between notebooks).
    """
    import urllib.request

    if not os.path.isdir(os.path.join(REPO, ".git")):
        run(["git", "clone", "${RVC_REPO}", REPO], cwd=WORK)
        # Pin to the commit this template was verified against; fall back to HEAD.
        run(["git", "fetch", "--depth", "1", "origin", "${RVC_PIN}"], cwd=REPO, check=False)
        if run(["git", "checkout", "${RVC_PIN}"], cwd=REPO, check=False) != 0:
            print("WARNING: could not check out the pinned commit; staying on the default branch.")
    else:
        print("repo already present")

    missing = [p for p in ("train/preprocess.py", "train/dataset/extract_f0.py",
                           "train/dataset/extract_hubert_feature.py", "train/train.py",
                           "train/train_index.py", "infer/cli.py")
               if not os.path.exists(os.path.join(REPO, p))]
    print("layout check — missing:", missing or "none")
    if missing:
        legacy = os.path.exists(os.path.join(REPO, "infer/modules/train/train.py"))
        raise SystemExit("Unexpected repo layout (legacy infer/modules/train present: %s). "
                         "The template expects the post-restructure tree." % legacy)

    # These two are where training writes. train.py's savee() swallows its own
    # exception, so a missing assets/weights silently produces no model at all.
    for d in ("assets/weights", "assets/indices", "logs"):
        os.makedirs(os.path.join(REPO, d), exist_ok=True)

    if not with_assets:
        return
    for remote, rel in {
        "pretrained_v2/f0G${sampleRate}.pth": "assets/pretrained_v2/f0G${sampleRate}.pth",
        "pretrained_v2/f0D${sampleRate}.pth": "assets/pretrained_v2/f0D${sampleRate}.pth",
        "rmvpe.pt": "assets/rmvpe/rmvpe.pt",
        # hubert_base.pt no longer exists: hubert is a transformers directory now.
        "hubert_base/config.json": "assets/hubert_base/config.json",
        "hubert_base/preprocessor_config.json": "assets/hubert_base/preprocessor_config.json",
        "hubert_base/pytorch_model.bin": "assets/hubert_base/pytorch_model.bin",
    }.items():
        dest = pathlib.Path(REPO) / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists() and dest.stat().st_size > 0:
            continue
        print("downloading", remote)
        urllib.request.urlretrieve(HF + remote, dest)

    mute_zip = pathlib.Path(WORK) / "models" / "mute.zip"
    mute_zip.parent.mkdir(parents=True, exist_ok=True)
    if not mute_zip.exists():
        urllib.request.urlretrieve(HF + "mute.zip", mute_zip)
    run([PY if os.path.exists(PY) else SYS_PY, "-m", "zipfile", "-e", str(mute_zip), "logs"],
        cwd=REPO, check=False)
    print("assets ready under", os.path.join(REPO, "assets"))

def ensure_env(install_requirements=True, force=False):
    """Idempotently build the 3.12 venv with the repo's pinned cu118 torch pair.

    Safe to call from every stage: each step is skipped when already satisfied.
    """
    if force and VENV.exists():
        shutil.rmtree(VENV, ignore_errors=True)
    run([SYS_PY, "-m", "pip", "install", "--quiet", "uv"])

    if not (VENV / "bin" / "python").exists():
        run([SYS_PY, "-m", "uv", "venv", "--python", "3.12", str(VENV)])
    probe = subprocess.run([PY, "--version"], capture_output=True, text=True)
    print("venv:", (probe.stdout or probe.stderr).strip() or "MISSING")

    # uv only considers the FIRST index carrying a package, so plain
    # --index-url/--extra-index-url never reaches the +cu118 build (pypi.org has
    # torch, just not that local version). unsafe-best-match is uv's documented fix
    # and both indexes here are official.
    torch_ok = subprocess.run([PY, "-c", "import torch"], capture_output=True, text=True).returncode == 0
    if force or not torch_ok:
        run([SYS_PY, "-m", "uv", "pip", "install", "--python", PY, "--quiet",
             "--index-strategy", "unsafe-best-match",
             "torch==2.7.1+cu118", "torchaudio==2.7.1+cu118",
             "--index-url", "https://download.pytorch.org/whl/cu118",
             "--extra-index-url", "https://pypi.org/simple"])

    if install_requirements:
        req = pathlib.Path(REPO) / "requirments_cu118_py312.txt"
        if not req.exists():
            cands = sorted(glob.glob(os.path.join(REPO, "requirments*.txt")))
            req = pathlib.Path(cands[0]) if cands else None
        if req is None:
            print("no requirements file found; skipping")
        else:
            # Two upstream problems, both verified on a live run:
            #  1. line 1 hardcodes a PKU mirror that does not resolve from Kaggle;
            #  2. the file pins CUDA-11 runtime DLLs that only publish win_amd64
            #     wheels (nvidia-cudnn-cu11==8.9.5.29), which makes the resolver fail
            #     outright. They serve the optional MSST/pymss separation path, which
            #     the CLI train+infer code never imports, so drop them. torch is
            #     already installed above and carries its own CUDA libraries.
            DROP = ("nvidia-", "onnxruntime-gpu")
            kept, dropped = [], []
            for line in req.read_text(encoding="utf-8").splitlines():
                s = line.strip()
                if s and not s.startswith("#") and s.lower().startswith(DROP):
                    dropped.append(s)
                    continue
                kept.append(line.replace("https://mirrors.pku.edu.cn/pypi/simple",
                                         "https://pypi.org/simple"))
            filtered = pathlib.Path(REPO) / "requirments_kaggle.txt"
            filtered.write_text("\\n".join(kept) + "\\n", encoding="utf-8")
            print(f"requirements: {len(kept)} lines kept, {len(dropped)} dropped "
                  f"(windows-only CUDA DLL pins): {dropped}")
            run([SYS_PY, "-m", "uv", "pip", "install", "--python", PY, "--quiet",
                 "-r", str(filtered)], cwd=REPO)
    print("torch in venv:", torch_info(PY))

print("REPO   :", REPO)
print("EXP    :", EXP, "| SR:", SR, "| version:", VERSION, "| f0:", F0)
print("system :", SYS_PY, "| venv:", PY, "(exists)" if os.path.exists(PY) else "(not built yet)")
`;
}

/** Stage 1: install the repo and download every pretrained asset it needs. */
function setupCells(ctx) {
  return [
    {
      type: 'markdown',
      source: `# RVC on Kaggle — 1. Setup

Clones the RVC repo at a pinned commit, builds a **Python 3.12 venv** for it, installs the
repo's pinned cu118 torch pair plus its requirements, and downloads the pretrained assets
into \`/kaggle/working/rvc/assets\`. Everything lives under \`/kaggle/working\`, so it is
captured in the notebook's output and can be reused by a later *train* notebook.

Kernel's system Python is 3.13, but the RVC repo targets 3.12 — hence the venv, which every
later stage runs through.

**Session options required:** Internet **on**, GPU **on**.
Runtime limit on Kaggle: 12 h for CPU and GPU sessions; GPU quota resets weekly.`,
    },
    { type: 'code', source: preamble(ctx) },
    {
      type: 'code',
      source: `# 1.1 Checkout + pretrained assets -------------------------------------------
# One idempotent call: clone the pinned commit, verify the layout, create the
# directories training writes into, and fetch the pretrained assets (~650 MB).
ensure_repo()`,
    },
    {
      type: 'code',
      source: `# 1.2 Sanity-check the checkout ----------------------------------------------
# Old (pre-restructure) checkouts used infer/modules/train/*; ensure_repo() already
# refuses those, so this just shows what we are working with.
print("commit :", subprocess.run(["git", "-C", REPO, "rev-parse", "--short", "HEAD"],
                                capture_output=True, text=True).stdout.strip())
print("assets :", sorted(os.listdir(os.path.join(REPO, "assets"))))
print("logs   :", sorted(os.listdir(os.path.join(REPO, "logs")))[:10])`,
    },
    {
      type: 'code',
      source: `# 1.3 Python 3.12 environment + dependencies ---------------------------------
# Verified on a live Kaggle run: the system interpreter is Python 3.13, but the RVC
# repo targets 3.12, so build a private 3.12 venv with uv and run every RVC script
# through it. ensure_env() is idempotent and is reused by the train/infer stages.
ensure_env()`,
    },
    {
      type: 'code',
      source: `# 1.4 Verify the CLI's imports inside the venv --------------------------------
# Resolvers can report success while an import still fails, so check the packages the
# train/infer CLI path actually needs.
check = subprocess.run(
    [PY, "-c", "import torch, torchaudio, numpy, faiss, transformers; "
               "print('imports OK')"],
    capture_output=True, text=True)
print((check.stdout or check.stderr).strip())
if check.returncode != 0:
    raise SystemExit("the venv is missing a package the RVC CLI needs (see above)")`,
    },
    {
      type: 'code',
      source: `# 1.5 Verify the setup -------------------------------------------------------
# ensure_repo() already fetched everything; this cell proves it before you spend
# GPU hours, and re-creates the directories training writes into.
ok = True
for rel in ["assets/pretrained_v2/f0G${ctx.sampleRate}.pth",
            "assets/pretrained_v2/f0D${ctx.sampleRate}.pth",
            "assets/rmvpe/rmvpe.pt",
            "assets/hubert_base/config.json",
            "assets/hubert_base/pytorch_model.bin"]:
    p = os.path.join(REPO, rel)
    exists = os.path.exists(p)
    ok &= exists
    print(("OK   " if exists else "MISS "), rel)

for d in ["assets/weights", "assets/indices", "logs"]:
    os.makedirs(os.path.join(REPO, d), exist_ok=True)

# The venv is what actually runs RVC; check it here rather than discovering a
# missing interpreter halfway through a 12-hour training run.
print("\\nvenv:", PY)
print("torch in venv:", torch_info(PY))
if not os.path.exists(PY):
    ok = False
    print("MISS  venv interpreter — ensure_env() did not finish")

if not ok:
    raise SystemExit("setup incomplete: fix the MISS lines above before training")

print("\\nsetup complete:", ok)
print("The repo, assets and venv are ready. The train stage re-creates them as needed,")
print("because every Kaggle run starts in a fresh container.")`,
    },
  ];
}

/** Stage 2: preprocess -> f0 -> hubert -> filelist/config -> train -> index. */
function trainCells(ctx) {
  const { dataset, expName } = ctx;
  const datasetSlug = dataset || 'REPLACE_WITH_DATASET_SLUG';
  return [
    {
      type: 'markdown',
      source: `# RVC on Kaggle — 2. Train

**Standalone.** It rebuilds the RVC checkout, the pretrained assets and the Python 3.12
venv itself (idempotent, ~1-4 min), because every Kaggle run starts in a fresh container —
files left behind by a setup run do *not* reappear unless they arrive through a data
source. All it needs from you is a Kaggle dataset of clean vocal audio mounted at
\`/kaggle/input/${datasetSlug}\` (add it as a data source on the kernel).

The five steps, in the order the repo requires:

1. \`train/preprocess.py\` — resample to 40k, slice, denoise into \`logs/${expName}/0_gt_wavs\`
2. \`train/dataset/extract_f0.py\` — f0 for every slice
3. \`train/dataset/extract_hubert_feature.py\` — 768-dim hubert features
4. synthesize \`filelist.txt\` + \`config.json\` (no CLI exists for these)
5. \`train.train\`, then \`train.train_index\` (both launched as modules — see the cells)

> \`logs/${expName}\` must exist **before** step 1: preprocess opens its log file at import time.
> The first run of a brand-new kernel can also start before its data source attaches — if the
> dataset looks unmounted, just push again.`,
    },
    { type: 'code', source: preamble(ctx) },
    {
      type: 'code',
      source: `# 2.1 Stage the dataset ------------------------------------------------------
DATASET_SLUG = "${datasetSlug}"
SRC = os.path.join(INPUT, DATASET_SLUG)
RAW = pathlib.Path(WORK) / "dataset"
RAW.mkdir(parents=True, exist_ok=True)

if not os.path.isdir(SRC):
    # Kaggle mounts a dataset at /kaggle/input/<slug>. A brand-new kernel can start its
    # FIRST run before the data source attachment takes effect (seen live: the metadata
    # had datasetDataSources and the run still saw nothing), and a renamed dataset
    # changes the mount name — so discover what is actually mounted instead of dying.
    mounts = sorted(p for p in pathlib.Path(INPUT).glob("*") if p.is_dir()) if os.path.isdir(INPUT) else []
    print(f"wanted {SRC}; mounted: {[p.name for p in mounts]}")
    match = [p for p in mounts if p.name == DATASET_SLUG] or [p for p in mounts if DATASET_SLUG in p.name]
    if match:
        SRC = str(match[0])
    elif len(mounts) == 1:
        SRC = str(mounts[0])
        print("falling back to the only mounted dataset:", SRC)
if not os.path.isdir(SRC):
    raise SystemExit(
        f"dataset not mounted ({SRC}). Add it in the notebook's Data panel, then push again — "
        "the first run of a brand-new kernel often starts before the source attachment lands."
    )
print("using dataset:", SRC)

AUDIO_EXT = (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".aac", ".wma")
copied = 0
for root, _dirs, names in os.walk(SRC):
    for n in names:
        if not n.lower().endswith(AUDIO_EXT):
            continue
        src = os.path.join(root, n)
        dst = RAW / n
        if not dst.exists():
            shutil.copy2(src, dst)
        copied += 1

# preprocess.py reads the *direct children* of its input dir (non-recursive),
# so the copy above deliberately flattens the tree.
wavs = sorted(RAW.glob("*.wav"))
others = [p for p in RAW.iterdir() if p.suffix.lower() != ".wav" and p.is_file()]
print(f"copied {copied} audio file(s): {len(wavs)} wav, {len(others)} other")

# RVC's preprocess wants wav input; convert the rest if ffmpeg is available.
if others:
    if shutil.which("ffmpeg"):
        for p in others:
            out = RAW / (p.stem + ".wav")
            if not out.exists():
                sh(["ffmpeg", "-nostdin", "-y", "-i", f'"{p}"', "-ar", str(SR_INT), "-ac", "1", f'"{out}"'], check=False)
        print("converted:", len(list(RAW.glob('*.wav'))), "wav files now")
    else:
        print("WARNING: non-wav files present and ffmpeg missing:", [p.name for p in others][:5])

wavs = sorted(RAW.glob("*.wav"))
if len(wavs) < 2:
    raise SystemExit(f"not enough audio to train on: {len(wavs)} wav file(s) in {RAW}")
total_min = sum(p.stat().st_size for p in wavs) / (SR_INT * 2 * 60)
print(f"{len(wavs)} wav file(s), ~{total_min:.1f} min of audio at {SR_INT} Hz mono")
print("NOTE: 10+ minutes of clean, dry, single-speaker vocal gives usable results.")`,
    },
    {
      type: 'code',
      source: `# 2.2 Repo + environment (BEFORE any script runs) -----------------------------
# A Kaggle run always starts in a FRESH container, so this stage rebuilds what it
# needs instead of assuming the setup notebook's files are still around. Both calls
# are idempotent; together they take a couple of minutes (clone + ~650 MB of assets
# + the 3.12 venv with the pinned cu118 torch).
ensure_repo()
ensure_env()

EXP_DIR = pathlib.Path(REPO) / "logs" / EXP
for d in [EXP_DIR, pathlib.Path(REPO) / "assets" / "weights",
          pathlib.Path(REPO) / "assets" / "indices"]:
    d.mkdir(parents=True, exist_ok=True)
print("ready:", EXP_DIR)`,
    },
    {
      type: 'code',
      source: `# 2.3 Slice + resample -------------------------------------------------------
# Run as a MODULE (-m), not as a path. "python train/preprocess.py" puts train/ first on
# sys.path, so "import train" resolves to the train/train.py module instead of the train
# package and dies with a circular-import ImportError (seen live). -m keeps the repo root
# on sys.path, which is what both "from infer..." and "from train import utils" need.
# positional: inp_root, sr, n_p, exp_dir,  "True"/"False", per
run([PY, "-m", "train.preprocess",
     str(RAW), str(SR_INT), str(NPROC), f"logs/{EXP}", "False", "3.7"], cwd=REPO)

gt = EXP_DIR / "0_gt_wavs"
slices = sorted(gt.glob("*.wav")) if gt.exists() else []
print(f"\\n{len(slices)} training slice(s) in {gt}")
if len(slices) < 8:
    raise SystemExit("too few slices after preprocessing — check the audio and the log above")`,
    },
    {
      type: 'code',
      source: `# 2.4 Pitch (f0) -------------------------------------------------------------
# positional: mode, n_part, i_part, i_gpu, exp_dir, is_half
# The repo's extract_f0.py forces rmvpe on the cuda path; only pm|rmvpe are accepted.
if F0:
    run([PY, "-m", "train.dataset.extract_f0",
         "cuda", "1", "0", "0", f"logs/{EXP}", "true"], cwd=REPO)
    print("f0 files:", len(list((EXP_DIR / "2a_f0").glob("*.npy"))))
else:
    print("F0=0: skipping pitch extraction (train with -f0 0)")`,
    },
    {
      type: 'code',
      source: `# 2.5 HuBERT features --------------------------------------------------------
# positional (8 args on the cuda path): device, n_part, i_part, i_gpu, exp_dir, version, is_half
run([PY, "-m", "train.dataset.extract_hubert_feature",
     "cuda:0", "1", "0", "0", f"logs/{EXP}", VERSION, "true"], cwd=REPO)
fea = EXP_DIR / "3_feature768"
print("feature files:", len(list(fea.glob("*.npy"))))`,
    },
    {
      type: 'code',
      source: `# 2.6 filelist.txt + config.json (no CLI generates these) ---------------------
# Line format, from webui.py's run_train_model:
#   {gt}/{name}.wav|{fea}/{name}.npy|{f0}/{name}.wav.npy|{f0nsf}/{name}.wav.npy|{spk_id}
# NOTE the f0 files are named <name>.wav.npy — the .wav survives the .npy append. Stripping
# only ".npy" therefore leaves <name>.wav and the intersection with the other directories
# comes out EMPTY (a live run died exactly there). Strip the full ".wav.npy".
def pick_dir(*candidates):
    for c in candidates:
        d = EXP_DIR / c
        if d.is_dir():
            return d
    return EXP_DIR / candidates[0]

f0_dir    = pick_dir("2a-f0", "2a_f0")
f0nsf_dir = pick_dir("2b-f0nsf", "2b_f0nsf", "2b-f0nsf")

def stems(d, *suffixes):
    out = set()
    if d.is_dir():
        for p in d.iterdir():
            for suf in suffixes:
                if p.name.endswith(suf):
                    out.add(p.name[: -len(suf)])
                    break
    return out

gt_names   = stems(gt, ".wav")
fea_names  = stems(fea, ".npy")
f0_names   = stems(f0_dir, ".wav.npy", ".npy")
f0nsf_names = stems(f0nsf_dir, ".wav.npy", ".npy")
print(f"counts — gt:{len(gt_names)} features:{len(fea_names)} f0:{len(f0_names)} f0nsf:{len(f0nsf_names)}")
print("dirs   —", gt.name, fea.name, f0_dir.name, f0nsf_dir.name)
print("sample — gt:", sorted(gt_names)[:3], "features:", sorted(fea_names)[:3])

names = gt_names & fea_names
if F0:
    names &= f0_names & f0nsf_names
names = sorted(names)
if not names:
    raise SystemExit(
        "no sample survived all extraction steps. Compare the counts above and the "
        "extraction logs; a zero in one column means that step produced nothing."
    )

random.shuffle(names)
lines = []
for n in names:
    if F0:
        lines.append(f"{gt}/{n}.wav|{fea}/{n}.npy|{f0_dir}/{n}.wav.npy|{f0nsf_dir}/{n}.wav.npy|0")
    else:
        lines.append(f"{gt}/{n}.wav|{fea}/{n}.npy|None|None|0")

# Two "mute" lines per speaker, from the mute.zip that ensure_repo() unpacked under logs/.
# The archive's internal layout is not documented, so discover the files instead of
# hardcoding paths (a live run showed the extraction lands at logs/mute/...).
mute_root = pathlib.Path(REPO) / "logs"
mute_wavs = sorted(mute_root.rglob(f"mute{SR_INT}.wav"))
mute_fea  = sorted(p for p in mute_root.rglob("mute.npy") if "feature" in p.parent.name)
mute_f0s  = sorted(mute_root.rglob("mute.wav.npy"))
mute_f0   = next((p for p in mute_f0s if "nsf" not in p.parent.name), None)
mute_f0nsf = next((p for p in mute_f0s if "nsf" in p.parent.name), None)

if mute_wavs and mute_fea and (not F0 or (mute_f0 and mute_f0nsf)):
    mute_line = "|".join(str(p) for p in [
        mute_wavs[0], mute_fea[0],
        mute_f0 or "None", mute_f0nsf or "None",
    ]) + "|0"
    lines.append(mute_line)
    lines.append(mute_line)
    print("mute lines added from", mute_wavs[0].parent)
else:
    print("NOTE: mute assets incomplete under", mute_root,
          "— continuing without the mute lines")
    print("      found:", [str(p) for p in (mute_wavs + mute_fea + mute_f0s)][:8])

filelist = EXP_DIR / "filelist.txt"
filelist.write_text("\\n".join(lines) + "\\n", encoding="utf-8")
print(f"filelist.txt: {len(lines)} line(s) — {len(names)} samples"
      + (f" + {len(lines) - len(names)} mute lines" if len(lines) > len(names) else " (no mute lines)"))

# TRAP: for v2 the repo still reads configs/v1/<sr>.json when sr == 40k
# (configs/v2 only ships 32k and 48k).
if VERSION == "v1" or SR == "40k":
    cfg_path = pathlib.Path(REPO) / "configs" / "v1" / f"{SR}.json"
else:
    cfg_path = pathlib.Path(REPO) / "configs" / VERSION / f"{SR}.json"

cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
cfg.setdefault("data", {})["training_files"] = str(filelist)
cfg["data"]["n_speakers"] = 1
cfg.pop("speaker_info", None)                 # single speaker
cfg.setdefault("train", {})["epochs"] = EPOCHS
cfg["train"]["batch_size"] = BS
(EXP_DIR / "config.json").write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
print("config.json from", cfg_path.name, "| sr:", cfg["data"].get("sampling_rate"),
      "| hop:", cfg["data"].get("hop_length"), "| epochs:", cfg["train"]["epochs"])`,
    },
    {
      type: 'code',
      source: `# 2.7 Train ------------------------------------------------------------------
# trainer takes OPTIONAL flags, so order does not matter here — but it is still launched
# with -m: train/train.py itself does "from train import utils", which only resolves when
# the repo root (not train/) is on sys.path.
cmd = [PY, "-m", "train.train",
       "-e", EXP, "-sr", SR, "-f0", str(F0),
       "-bs", str(BS), "-g", str(GPU),
       "-te", str(EPOCHS), "-se", str(max(1, EPOCHS // 40)),
       "-pg", f"assets/pretrained_v2/f0G{SR}.pth" if F0 else f"assets/pretrained_v2/G{SR}.pth",
       "-pd", f"assets/pretrained_v2/f0D{SR}.pth" if F0 else f"assets/pretrained_v2/D{SR}.pth",
       "-l", "0", "-c", "0", "-sw", "1", "-v", VERSION]
print(" ".join(cmd))
run(cmd, cwd=REPO)`,
    },
    {
      type: 'code',
      source: `# 2.8 Assert the model actually exists ---------------------------------------
# train.py's savee() writes to a hardcoded assets/weights/ inside a bare
# try/except that returns a traceback string instead of raising, so a missing
# directory looks exactly like success. Never trust the exit code alone.
weight = pathlib.Path(REPO) / "assets" / "weights" / f"{EXP}.pth"
if not weight.exists():
    found = sorted(p.name for p in (pathlib.Path(REPO) / "assets" / "weights").glob("*.pth"))
    raise SystemExit(f"training produced no {weight.name}. Present: {found}")
print("model:", weight, weight.stat().st_size // 1024 // 1024, "MB")

ckpts = sorted((EXP_DIR / f"{EXP}").glob("G_*.pth")) if (EXP_DIR / EXP).exists() else []
print("intermediate checkpoints:", len(ckpts))
# G_*.pth checkpoints are large; the version output cap is 20 GB.
for p in ckpts[:-2]:
    p.unlink()
print("kept the last two checkpoints")`,
    },
    {
      type: 'code',
      source: `# 2.9 Build the retrieval index ----------------------------------------------
# positional: exp_name (bare NAME), version, outside_index_root, n_cpu, mode
run([PY, "-m", "train.train_index",
     EXP, VERSION, "assets/indices", str(NPROC), "single"], cwd=REPO)

indices = sorted((pathlib.Path(REPO) / "assets" / "indices").glob(f"{EXP}*"))
print("index files:", [p.name for p in indices])`,
    },
    {
      type: 'code',
      source: `# 2.10 Collect the artifacts into the version output -------------------------
OUT = pathlib.Path(WORK) / "out"
OUT.mkdir(parents=True, exist_ok=True)
shutil.copy2(weight, OUT / weight.name)
for p in sorted((pathlib.Path(REPO) / "assets" / "indices").glob(f"{EXP}*")):
    shutil.copy2(p, OUT / p.name)

print("\\n/kaggle/working/out:")
for p in sorted(OUT.iterdir()):
    print(f"  {p.name}  {p.stat().st_size // 1024} KB")

print("""
Next steps
  - inference:   python -m infer.cli --model assets/weights/%s.pth --input in.wav --output out.wav
  - reuse:       add /kaggle/working/out as a Kaggle Dataset or a kernel source
  - in DSH:      kernel_output downloads these files to <workspace>/outputs/
""" % EXP)`,
    },
  ];
}

/** Stage 3: run inference with a trained model. */
function inferCells(ctx) {
  const { expName } = ctx;
  return [
    {
      type: 'markdown',
      source: `# RVC on Kaggle — 3. Inference

Converts audio with a model trained by the *train* stage
(\`assets/weights/${expName}.pth\` + its index). Put the source audio under
\`/kaggle/working/input\` (or mount a dataset) and run.`,
    },
    { type: 'code', source: preamble(ctx) },
    {
      type: 'code',
      source: `# 3.1 Repo, environment and model --------------------------------------------
# Standalone: this stage rebuilds the checkout and the venv if they are not present
# (a Kaggle run starts in a fresh container), then finds the trained model.
ensure_repo()
ensure_env()

EXP_DIR_FOUND = None

def find_model():
    """Look for <EXP>.pth in this run, then in anything mounted under /kaggle/input.

    Mounting the train kernel's output as a *kernel source* is how you carry a model
    from one notebook to another — it lands read-only at /kaggle/input/<kernel-slug>/.
    """
    direct = pathlib.Path(REPO) / "assets" / "weights" / f"{EXP}.pth"
    if direct.exists():
        return direct, direct.parent
    for base in [pathlib.Path(WORK) / "out", *sorted(pathlib.Path(INPUT).glob("*"))]:
        if not base.is_dir():
            continue
        for p in list(base.rglob(f"{EXP}.pth")) + list((base / "out").glob("*.pth") if (base / "out").is_dir() else []):
            return p, p.parent
    return None, None

found, found_dir = find_model()
if found is None:
    raise SystemExit(f"no trained model ({EXP}.pth) found in this kernel or under {INPUT}. "
                     "Run the train stage, then mount its output as a kernel source.")
if found_dir != pathlib.Path(REPO) / "assets" / "weights":
    print("using model from", found)
dest_dir = pathlib.Path(REPO) / "assets" / "weights"
dest_dir.mkdir(parents=True, exist_ok=True)
weight = dest_dir / found.name
if not weight.exists():
    shutil.copy2(found, weight)
print("model :", weight, f"{weight.stat().st_size // 1024 // 1024} MB")

# Carry over the index too, if the trained model travelled with one.
idx_dir = pathlib.Path(REPO) / "assets" / "indices"
idx_dir.mkdir(parents=True, exist_ok=True)
if found_dir != idx_dir:
    for idx in found_dir.parent.rglob(f"{EXP}*added*.index"):
        if not (idx_dir / idx.name).exists():
            shutil.copy2(idx, idx_dir / idx.name)

indices = sorted(idx_dir.glob(f"{EXP}*added*"))
index = indices[0] if indices else None
print("model:", weight.name)
print("index:", index.name if index else "(none — --index-rate 0 would be needed)")`,
    },
    {
      type: 'code',
      source: `# 3.2 Convert ----------------------------------------------------------------
IN_DIR  = pathlib.Path(WORK) / "input"
OUT_DIR = pathlib.Path(WORK) / "converted"
IN_DIR.mkdir(parents=True, exist_ok=True)
OUT_DIR.mkdir(parents=True, exist_ok=True)

AUDIO_EXT = (".wav", ".mp3", ".flac", ".m4a", ".ogg")
targets = sorted(p for p in IN_DIR.iterdir() if p.suffix.lower() in AUDIO_EXT)
if not targets:
    # Nothing staged: fall back to audio that came in through a data source, so a single
    # run can mount a dataset and convert from it.
    for base in sorted(pathlib.Path(INPUT).glob("*")):
        if base.is_dir():
            found = sorted(p for p in base.rglob("*") if p.suffix.lower() in AUDIO_EXT)
            if found:
                print("using audio from", found[0].parent)
                targets = found[:3]
                break
if not targets:
    print("put source audio in", IN_DIR, "or mount a dataset, then re-run this cell")
else:
    PITCH = 0        # semitones: +12 = up an octave, -12 = down
    for src in targets:
        dst = OUT_DIR / (src.stem + "_converted.wav")
        cmd = [PY, "-m", "infer.cli",
               "--model", str(weight),
               "--input", str(src),
               "--output", str(dst),
               "--pitch", str(PITCH),
               "--f0-method", F0_METHOD,
               "--index-rate", "0.75" if index else "0"]
        if index:
            cmd += ["--index", str(index)]
        run(cmd, cwd=REPO)
        print("->", dst, dst.stat().st_size // 1024, "KB" if dst.exists() else "MISSING")`,
    },
  ];
}

/**
 * @param {{stage:'setup'|'train'|'infer', dataset?:string, expName?:string,
 *          sampleRate?:'40k'|'48k', epochs?:number, batchSize?:number, f0Method?:string}} opts
 */
export function rvcCells(opts) {
  const ctx = {
    dataset: opts.dataset,
    expName: opts.expName || 'voice',
    sampleRate: opts.sampleRate === '48k' ? '48k' : '40k',
    epochs: opts.epochs ?? 200,
    batchSize: opts.batchSize ?? 8,
    f0Method: opts.f0Method === 'pm' ? 'pm' : 'rmvpe',
  };
  switch (opts.stage) {
    case 'setup':
      return setupCells(ctx);
    case 'train':
      return trainCells(ctx);
    case 'infer':
      return inferCells(ctx);
    default:
      throw new Error(`unknown stage "${opts.stage}" (expected ${RVC_STAGES.join(' | ')})`);
  }
}

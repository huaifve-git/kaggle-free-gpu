#!/usr/bin/env python3
"""Build a Kaggle notebook that renders images with Stable Diffusion XL.

The generated directory contains `<slug>.ipynb` and `kernel-metadata.json`,
which is exactly what the Kaggle MCP `kernel_push` tool expects.

Usage:
    python build_kernel.py --jobs jobs.json --outdir ./my-kernel \
        --owner <kaggle-user> --slug my-slug --title "My image gen run"

Then:
    kernel_push  <abs path to ./my-kernel>
    kernel_wait  <owner>/<slug>
    kernel_output <owner>/<slug>
"""

import argparse
import json
import os
import re
import sys

DEFAULT_MODEL = "stabilityai/stable-diffusion-xl-base-1.0"

DEFAULT_NEGATIVE = (
    "lowres, blurry, jpeg artifacts, watermark, signature, text, extra fingers, "
    "deformed hands, bad anatomy, extra limbs, oversaturated, cartoon, cgi, plastic skin"
)

# The whole generation pipeline lives in one self-contained cell: kernel_push only
# uploads the .ipynb, so nothing may be referenced from outside the notebook.
CELL = r'''import json, os, time, torch
from diffusers import StableDiffusionXLPipeline

CFG = __CONFIG__

OUT = "/kaggle/working/out"
os.makedirs(OUT, exist_ok=True)
print("torch", torch.__version__, "| cuda", torch.cuda.is_available(),
      "|", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "no-gpu")

# diffusers renamed torch_dtype -> dtype in 1.x; try the new kwarg first.
_load = dict(variant="fp16", use_safetensors=True)
try:
    pipe = StableDiffusionXLPipeline.from_pretrained(CFG["model"], dtype=torch.float16, **_load)
except TypeError:
    pipe = StableDiffusionXLPipeline.from_pretrained(CFG["model"], torch_dtype=torch.float16, **_load)

if CFG.get("low_vram"):
    pipe.enable_model_cpu_offload()
else:
    pipe = pipe.to("cuda")

pipe.set_progress_bar_config(disable=True)

# VAE slicing moved from the pipeline to the VAE module in diffusers 1.x.
try:
    pipe.enable_vae_slicing()
except Exception:
    try:
        pipe.vae.enable_slicing()
    except Exception as exc:
        print("vae slicing unavailable:", exc)

print("pipeline ready:", CFG["model"])

manifest = []
for item in CFG["images"]:
    seed = item.get("seed", -1)
    if seed is None or int(seed) < 0:
        seed = int(torch.randint(0, 2**31 - 1, (1,)).item())
    seed = int(seed)
    gen = torch.Generator(device="cuda").manual_seed(seed)

    t0 = time.time()
    image = pipe(
        prompt=item["prompt"],
        negative_prompt=item.get("negative") or CFG["negative"],
        num_inference_steps=int(item.get("steps", CFG["steps"])),
        guidance_scale=float(item.get("guidance", CFG["guidance"])),
        width=int(item.get("width", CFG["width"])),
        height=int(item.get("height", CFG["height"])),
        generator=gen,
    ).images[0]
    elapsed = time.time() - t0

    path = os.path.join(OUT, item["file"])
    image.save(path)
    size = os.path.getsize(path)
    manifest.append({
        "file": item["file"],
        "seed": seed,
        "seconds": round(elapsed, 1),
        "bytes": size,
        "width": int(item.get("width", CFG["width"])),
        "height": int(item.get("height", CFG["height"])),
        "steps": int(item.get("steps", CFG["steps"])),
        "guidance": float(item.get("guidance", CFG["guidance"])),
        "model": CFG["model"],
        "prompt": item["prompt"],
        "negative": item.get("negative") or CFG["negative"],
    })
    print(f"{item['file']}: {image.size[0]}x{image.size[1]} {size // 1024} KiB in {elapsed:.1f}s")

with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2, ensure_ascii=False)

print("done:", sorted(os.listdir(OUT)))
'''


def slugify(text):
    text = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return text or "kaggle-sdxl-imagegen"


def load_jobs(path):
    with open(path, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    images = raw.get("images")
    if not images:
        raise SystemExit("jobs file must contain a non-empty 'images' array")
    for idx, item in enumerate(images):
        if not item.get("prompt"):
            raise SystemExit(f"images[{idx}] is missing 'prompt'")
        item.setdefault("file", f"image_{idx + 1:02d}.png")
        if not item["file"].lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
            raise SystemExit(f"images[{idx}].file must be an image filename")

    config = {
        "model": raw.get("model", DEFAULT_MODEL),
        "steps": raw.get("steps", 32),
        "guidance": raw.get("guidance", 6.0),
        "width": raw.get("width", 1024),
        "height": raw.get("height", 1024),
        "negative": raw.get("negative", DEFAULT_NEGATIVE),
        "low_vram": bool(raw.get("low_vram", False)),
        "images": images,
    }
    return config


def estimate_clip_tokens(text):
    """Rough CLIP token count. SDXL silently truncates prompts past 77 tokens."""
    words = re.findall(r"[A-Za-z0-9']+", text)
    punctuation = len(re.findall(r"[,.!?;:]", text))
    return int(len(words) * 1.3) + punctuation + 2


def warn_long_prompts(config):
    for item in config["images"]:
        for label, text in (("prompt", item["prompt"]), ("negative", item.get("negative") or config["negative"])):
            est = estimate_clip_tokens(text)
            if est > 77:
                print(
                    f"WARNING: {item['file']} {label} is ~{est} CLIP tokens (>77) "
                    f"and will be truncated. Shorten it.",
                    file=sys.stderr,
                )


def build_notebook(config, title):
    source = CELL.replace("__CONFIG__", repr(config))
    lines = source.splitlines(keepends=True)
    return {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    f"# {title}\n",
                    "\n",
                    f"- model: `{config['model']}`\n",
                    f"- {len(config['images'])} image(s), "
                    f"{config['width']}x{config['height']}, "
                    f"{config['steps']} steps, guidance {config['guidance']}\n",
                ],
            },
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": lines,
            },
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            },
            "language_info": {"name": "python", "version": "3.11"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jobs", required=True, help="path to the jobs JSON file")
    ap.add_argument("--outdir", required=True, help="directory to write the kernel into")
    ap.add_argument("--owner", required=True, help="Kaggle username that will own the kernel")
    ap.add_argument("--title", default="SDXL image gen", help="human readable kernel title")
    ap.add_argument("--slug", default=None, help="kernel slug (default: slugified title)")
    ap.add_argument("--shape", default="NvidiaTeslaT4", help="accelerator, '' for none")
    ap.add_argument("--public", action="store_true", help="make the kernel public")
    args = ap.parse_args()

    config = load_jobs(args.jobs)
    warn_long_prompts(config)
    slug = args.slug or slugify(args.title)
    os.makedirs(args.outdir, exist_ok=True)

    nb_path = os.path.join(args.outdir, f"{slug}.ipynb")
    with open(nb_path, "w", encoding="utf-8") as fh:
        json.dump(build_notebook(config, args.title), fh, indent=1, ensure_ascii=False)

    meta = {
        "id": f"{args.owner}/{slug}",
        "title": args.title,
        "code_file": f"{slug}.ipynb",
        "language": "python",
        "kernel_type": "notebook",
        "is_private": not args.public,
        "enable_gpu": bool(args.shape),
        "enable_internet": True,
        "machine_shape": args.shape,
        "dataset_sources": [],
        "competition_sources": [],
        "kernel_sources": [],
        "model_sources": [],
    }
    with open(os.path.join(args.outdir, "kernel-metadata.json"), "w", encoding="utf-8") as fh:
        json.dump(meta, fh, indent=2)

    print(f"kernel dir : {os.path.abspath(args.outdir)}")
    print(f"kernel id  : {meta['id']}")
    print(f"images     : {', '.join(i['file'] for i in config['images'])}")
    print("next       : kernel_push -> kernel_wait -> kernel_output")
    return 0


if __name__ == "__main__":
    sys.exit(main())

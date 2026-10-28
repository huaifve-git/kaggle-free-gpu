---
name: kaggle-sdxl-imagegen
description: Generate images on Kaggle's free GPU through the Kaggle MCP server using Stable Diffusion XL. This skill should be used when a user asks to draw, generate, render, or create pictures and photos via Kaggle, when a cloud GPU is required because local image generation is unavailable, or when a request needs a reproducible text-to-image run with recorded seeds and parameters. Covers kernel scaffolding, prompt compression for CLIP's 77-token ceiling, diffusers 1.x API compatibility, run polling, output download, and delivery.
agent_created: true
---

# Kaggle SDXL 出图

在 Kaggle 免费 GPU 上跑 Stable Diffusion XL 出图，全程走 Kaggle MCP。
一次完整任务从建模到交付约 3 分钟，其中真正推理只占约 1 分钟。

## 何时使用

- 用户要求"在 Kaggle 上生成图片"。
- 需要可复现的出图（固定种子 + 参数留档），本地没有可用显卡。
- 需要批量出图且希望成本为零（Kaggle 免费 GPU 每周约 30 小时）。

不适用：需要商用级细节控制（走专业出图 API）、需要图生图/局部重绘（本 skill 未覆盖）。

## 先读这三条约束

踩过坑的地方，务必照做：

1. **每次调用都要显式传 `owner`**。本机 MCP 解析不出用户名，`mcp__kaggle__status` 会显示
   `username : UNKNOWN`，但 API 是通的。用户名从已有 output 目录名（`<owner>__<slug>`）反推，或直接问用户。
2. **不要用 `pipe.enable_vae_slicing()` 裸调用**。Kaggle 镜像的 diffusers 是 1.x，该方法已移除，
   会让整个 notebook 直接 ERROR。模板里已做 try/except 降级到 `pipe.vae.enable_slicing()`。
3. **提示词压到 77 CLIP token 以内**。超出会被静默截断（只打 warning 不报错），尾部画质词直接失效。
   控制英文 45 词以内。

## 工作流

### 第 1 步：确认凭据

调用 `mcp__kaggle__status`。看到 `api ping : OK` 即可继续；`username` 显示 UNKNOWN 属正常，
后续用 `owner` 参数补上。

### 第 2 步：写 jobs JSON

以 `assets/jobs.example.json` 为模板。顶层放管线默认值，`images` 数组逐张给 `file` / `seed` / `prompt`，
单张可覆盖 `steps`、`guidance`、`width`、`height`、`negative`。

- `seed` 给 `-1` 表示随机，实际种子会写进 manifest。
- 想复现就往回填上一次 manifest 里的种子。
- 提示词写法见 `references/prompt-cookbook.md`；生成未成年人肖像时该文件里的硬规则是强制的。

### 第 3 步：生成内核

```bash
python scripts/build_kernel.py --jobs jobs.json --outdir ./kernels/<slug> \
    --owner <kaggle-user> --slug <slug> --title "<title>"
```

脚本产出 `<slug>.ipynb` 和 `kernel-metadata.json`（GPU + 联网 + 私有），
并在提示词超 77 token 时打印截断警告。看到 WARNING 就先改提示词再往下走。

### 第 4 步：推送运行

调用 `mcp__kaggle__kernel_push`，传内核目录绝对路径，**不要带 `wait`**。
立即返回后拿到真实的 `kernel id`（Kaggle 会按 title 重新派生 slug，注意用返回的新 slug）。

### 第 5 步：轮询

调用 `mcp__kaggle__kernel_wait`，`timeout_sec` 设 420 左右。超时未结束就再调一次，
不要把单次超时开到 1800 秒拖死调用。

拿到 `COMPLETE` 后调 `mcp__kaggle__kernel_output` 下载，`dest` 指到工作区的 `outputs/<slug>/`。
文件会落在 `dest/out/` 子目录下。

状态为 `ERROR` 时调 `mcp__kaggle__kernel_logs`，按 `references/troubleshooting.md` 对症处理，
改完重推（`kernel_push` 同一目录会自动升版本）。

### 第 6 步：验收与交付

1. 用 Read 工具**逐张打开图片确认**，不要只凭日志判定成功。检查：主体是否符合描述、有无畸形手/多肢、
   人像是否得体（未成年人尤其要过一遍）。
2. 不合格就调种子或提示词重跑，不要把废图交付。
3. 用 `present_files` 展示图片，附 `manifest.json`。
4. 汇报时给出：模型、尺寸、步数、guidance、种子、耗时、内核链接。

## 目录约定

| 内容 | 位置 |
| --- | --- |
| 内核源码 | `kernels/<slug>/` |
| 产物 | `outputs/<slug>/out/` |
| 参数留档 | `outputs/<slug>/out/manifest.json` |

## 资源

- `scripts/build_kernel.py` —— 由 jobs JSON 生成可推送的 Kaggle 内核，含版本兼容与 token 超限告警。
- `references/troubleshooting.md` —— 真实报错 → 原因 → 修法。
- `references/prompt-cookbook.md` —— 提示词结构、负向词、构图配方、种子策略、分辨率表、未成年人肖像硬规则。
- `assets/jobs.example.json` —— 可直接改用的双图示例（风景 + 人像）。

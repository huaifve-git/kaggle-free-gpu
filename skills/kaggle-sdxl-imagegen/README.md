# kaggle-sdxl-imagegen

一个 WorkBuddy / Claude Skill：**用 Kaggle 免费 GPU 通过 Kaggle MCP 跑 Stable Diffusion XL 出图**。

把"建模 → 出图 → 下载 → 验收"整条链路固化成脚本和检查清单，避免每次重写那段又长又容易踩坑的
notebook 代码。

## 为什么需要它

自己从头跑一遍 Kaggle SDXL，几乎必然踩到这三个坑：

| 坑 | 表现 | 这个 skill 怎么处理 |
| --- | --- | --- |
| MCP 解析不出 Kaggle 用户名 | `ERROR: Kaggle username unknown`，内核都建不起来 | 每次调用显式传 `owner` |
| diffusers 已是 1.x | `AttributeError: 'StableDiffusionXLPipeline' object has no attribute 'enable_vae_slicing'`，内核直接 ERROR | 模板里 try/except 降级到 `pipe.vae.enable_slicing()`，`torch_dtype` → `dtype` 同理回退 |
| CLIP 77 token 上限 | 图能出来但尾部画质词静默失效，画质莫名下降 | 生成内核时估算 token 数，超限直接告警 |

## 安装

本 skill 是 [kaggle-free-gpu](../..) 仓库的一员，与 RVC 训练 / 推理、LLM API 部署三个 skill 并列。

```bash
git clone git@github.com:huaifve-git/kaggle-free-gpu.git
cp -r kaggle-free-gpu/skills/kaggle-sdxl-imagegen ~/.workbuddy-ai/skills/
```

项目级安装则放到 `<project>/.workbuddy-ai/skills/kaggle-sdxl-imagegen`。

前置条件：

- Kaggle 凭据已配置（`~/.kaggle/kaggle.json` 或 `access_token`），Kaggle MCP 可用
- Python 3.9+（仅用于本地生成 notebook，出图在 Kaggle 上跑）

## 使用

```bash
# 1. 照着 assets/jobs.example.json 写自己的 jobs.json
cp assets/jobs.example.json my-jobs.json

# 2. 生成内核
python scripts/build_kernel.py --jobs my-jobs.json --outdir ./kernels/demo \
    --owner <your-kaggle-username> --slug demo --title "Demo image gen"
```

然后在对话里让 agent 依次调用 Kaggle MCP 的 `kernel_push` → `kernel_wait` → `kernel_output`。
完整流程与验收标准见 `SKILL.md`。

## jobs.json 结构

```jsonc
{
  "model": "stabilityai/stable-diffusion-xl-base-1.0",  // 可换任何 SDXL 兼容 repo
  "steps": 32,
  "guidance": 6.0,
  "width": 1024,
  "height": 1024,
  "low_vram": false,          // true 走 CPU offload，T4 显存吃紧时开
  "negative": "...",          // 全局负向词，单张可覆盖
  "images": [
    { "file": "a.png", "seed": 731905, "prompt": "..." },  // seed: -1 表示随机
    { "file": "b.png", "seed": 418273, "prompt": "...", "steps": 40 }  // 单张覆盖默认值
  ]
}
```

## 实测数据

Tesla T4 / SDXL base 1.0 / 1024×1024 / 32 步：

| 指标 | 数值 |
| --- | --- |
| 单张推理 | 约 27 秒 |
| 双图整轮（含排队 + 模型下载） | 约 165 秒 |
| 产物 | `out/*.png` + `out/manifest.json` |

## 目录

```
kaggle-sdxl-imagegen/
├── SKILL.md                        # agent 读的流程与约束
├── scripts/build_kernel.py         # jobs.json -> 可推送的 Kaggle 内核
├── references/
│   ├── troubleshooting.md          # 真实报错 → 原因 → 修法
│   └── prompt-cookbook.md          # 提示词配方、种子策略、分辨率表
└── assets/jobs.example.json        # 双图示例
```

## 许可

MIT

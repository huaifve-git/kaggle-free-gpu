# kaggle-rvc — 在 Kaggle 上训练并使用 RVC 声音模型

[RVC（Retrieval-based Voice Conversion）](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)
是一套开源的声音转换方案：给它一段干净的人声，它可以训练出一个"音色模型"，再用这个模型把别的音频换成那个音色。

它原本需要一张本地显卡、一整套 Python 环境，以及不少踩坑经验。**本项目把整条流水线搬到 Kaggle 上跑**——
用 Kaggle 免费提供的 GPU，从一段音频开始，一路产出可用的 `.pth` 模型、FAISS 检索索引，以及转换好的音频。

跑完之后你得到的东西，和本地跑 RVC 得到的完全一样，可以直接丢进 RVC WebUI 或 CLI 使用。

---

## 目录

- [这个项目是什么](#这个项目是什么)
- [它能做什么](#它能做什么)
- [工作原理](#工作原理)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置 Kaggle 凭据](#配置-kaggle-凭据)
- [快速上手](#快速上手)
- [典型场景](#典型场景)
- [工具一览](#工具一览)
- [输出与目录结构](#输出与目录结构)
- [常见问题](#常见问题)
- [数据与隐私](#数据与隐私)
- [已知限制](#已知限制)
- [更多文档](#更多文档)
- [致谢与许可](#致谢与许可)

---

## 这个项目是什么

本项目是一台**本地 MCP 服务器**（`kaggle-mcp/`），它把 Kaggle 的远程算力变成了可编程的工具箱：

1. 在本地生成一个 Kaggle Notebook，并把代码写进去；
2. 把它推到 Kaggle 上运行，同时**指定 GPU、开启联网、挂载数据集**；
3. 轮询运行状态，把日志和产出的模型文件拉回本地。

它注册为 DSH 的 MCP 服务器 `kaggle`，因此所有工具体现为 `mcp__kaggle__*`。

除了工具本身，项目还附带两套**技能（Skill）**和一套**经过实测的 RVC 笔记本模板**——后者把 RVC 上游仓库
里那些"报错不明显、但一定会让训练失败"的坑全部提前处理掉了。也就是说，你不需要懂 RVC 的目录结构和参数顺序，
只要提供音频，剩下的事情模板会做完。

## 它能做什么

| 能力 | 说明 |
|---|---|
| **训练音色模型** | 上传一段人声 → 在 Kaggle GPU 上跑完整训练 → 拿回 `.pth` 模型 + FAISS 索引 |
| **声音转换（推理）** | 用训练好的模型把任意音频换成目标音色，输出 WAV |
| **数据集管理** | 把本地文件夹上传为 Kaggle 数据集（默认私有），供训练挂载 |
| **Notebook 全生命周期** | 创建 / 写入单元格 / 配置 / 推送运行 / 查状态 / 读日志 / 下载产物 |
| **跨 Notebook 传模型** | 推理时可直接把"训练 Kernel 的输出"挂载为数据源，模型无需下载再上传 |

## 工作原理

一次 Kaggle 运行 = 一个**全新的容器**。所以模板里的每个阶段都是自包含的，会自己把需要的东西重建出来：

```
        你的音频                      Kaggle GPU Kernel
   ┌──────────────┐          ┌──────────────────────────────────────┐
   │  本地文件夹   │          │  1. 克隆 RVC 仓库（锁定 commit）        │
   └──────┬───────┘          │  2. 建 Python 3.12 虚拟环境 + 固定 torch │
          │ dataset_push     │  3. 预处理 → 提取 f0 → 提取 HuBERT 特征  │
          ▼                  │  4. 生成 filelist / config              │
   ┌──────────────┐          │  5. 训练 → 生成索引                     │
   │ Kaggle 数据集 │─────────▶│                                      │
   │ (私有,只读)   │  挂载     └──────────────┬───────────────────────┘
   └──────────────┘          /kaggle/input/<slug>                 │
                                                    kernel_output ▼
                                        ┌────────────────────────────────┐
                                        │  本地 outputs/<owner>__<slug>/  │
                                        │    <名字>.pth + <名字>_added_*.index │
                                        └────────────────────────────────┘
```

三个可选阶段：

- **setup** —— 只验证环境（依赖能否装好、预训练资源能否下载）。成本低、失败快，建议第一次先跑它。
- **train** —— 真正的训练：数据 → 模型 + 索引。
- **infer** —— 用已有模型转换音频。

## 环境要求

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 18 |
| 运行环境 | DSH（MCP 服务器 + 技能挂在 DSH 的 profile 上）；理论上任何 MCP 客户端都可接入 |
| Kaggle 账号 | 免费即可；使用 GPU 需要手机号验证 |
| 本地磁盘 | 训练产物较小（模型约 50 MB / 索引约 16 MB）；输出目录会暂存下载内容 |

关于 Kaggle 的额度，动手前值得知道：

- **GPU 每周约 30 小时**，按周重置，且与你账号下其他任务共享；
- **单次运行最长 12 小时**（CPU 与 GPU 相同）；
- 只有 `/kaggle/working` 会作为版本产物保存，其余目录（如 `/kaggle/temp`）运行结束即消失；
- 一次小数据集的完整训练通常只需**几分钟**（环境重建占大头）。

## 安装

```bash
cd kaggle-mcp
npm install
```

服务器入口是 `kaggle-mcp/src/server.mjs`，通过 stdio 通信。把它注册进你的 MCP 客户端的配置即可，
例如在 DSH 的 profile 补丁层中：

```yaml
- insert:
    - id: mcp-kaggle
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: kaggle
        transport: stdio
        command: "node"
        args: ["<绝对路径>/kaggle-mcp/src/server.mjs"]
        cwd: "<绝对路径>/kaggle_rvc_2"
        env:
          KAGGLE_RVC_HOME: "<绝对路径>/kaggle_rvc_2"
```

改完配置或服务器代码后**需要重启 DSH**：已经启动的子进程不会热加载新的模块与补丁。

## 配置 Kaggle 凭据

### 一键配置（推荐）

双击根目录的 **`一键配置Kaggle密钥.cmd`**，按提示粘贴密钥，剩下的事脚本全包：

1. 在 Kaggle 账号页（Settings → API）生成 / 复制 API Token（`KGAT_…`），或者沿用旧的 **用户名 + Key**；
2. 粘贴进终端并回车（**输入不回显**，屏幕上只留一行打码预览）；
3. 脚本自动完成：
   - 清理会互相顶替的旧凭据文件；
   - 写入 `~/.kaggle/access_token`（Bearer）或 `~/.kaggle/kaggle.json`（用户名 + Key），
     并在 `<工作区>/.secrets/kaggle.env` 留一份本地兜底；
   - 调用 Kaggle `/api/v1/hello` **验证密钥**，并**自动识别账号用户名**；
   - 用户名有变化时同步 DSH profile 里的 `KAGGLE_RVC_USERNAME`（改动前先备份，
     这种情况需要重启 DSH 才生效；凭据文件本身无需重启）。

密钥只写文件、不进日志。脚本可以反复运行：换密钥时再跑一次，它会先清掉旧凭据，不会留下多份互相顶替的文件。

非交互式等价用法（自动化 / 测试）：

```powershell
pwsh -File setup-kaggle.ps1                      # 交互式粘贴
pwsh -File setup-kaggle.ps1 -TokenFile <token>   # 从文件读密钥
pwsh -File setup-kaggle.ps1 -NoVerify            # 跳过在线验证（离线）
```

### 凭据解析顺序

按顺序查找，命中即止（**密钥只用于鉴权，永远不会出现在工具输出里**）：

1. 环境变量 `KAGGLE_API_TOKEN` —— Bearer Token（`KGAT_…`）
2. 环境变量 `KAGGLE_USERNAME` + `KAGGLE_KEY` —— HTTP Basic
3. `~/.kaggle/access_token` —— Bearer Token 文件（**推荐**）
4. `~/.kaggle/kaggle.json` —— `{ "username": "...", "key": "..." }`
5. `<工作区>/.secrets/kaggle.env` 或 `.secrets/kaggle.json` —— Git 忽略的本地兜底

随时可以调用 `status` 工具确认**当前用的是哪一份凭据**、解析出的用户名，以及 API 是否连通。

> 注意：本地凭据文件可能含有私密 Token，请不要提交到版本库（`.gitignore` 已忽略 `.secrets/`）。

## 快速上手

### 第一步：确认连通性

直接让助手检查连接状态即可。你会看到凭据来源、用户名和一次实时 API 探测结果。

### 第二步（推荐）：先跑 setup 验证环境

```
kernel_new    title="RVC setup", slug="rvc-setup", gpu=true, internet=true
rvc_notebook  kernel="rvc-setup", stage="setup"
kernel_push   kernel="rvc-setup"
kernel_status kernel="rvc-setup"
```

跑通后再进入正式训练，可以避免把 GPU 时间浪费在环境问题上。

### 第三步：上传音频并训练

把你的人声放进一个本地文件夹，然后：

```
dataset_push   folder="<你的音频目录>", slug="rvc-myvoice-dataset"
dataset_files  slug="rvc-myvoice-dataset"        # 确认已就绪（READY）并看到文件列表

kernel_new     title="RVC train myvoice", slug="rvc-train-myvoice",
               gpu=true, internet=true, is_private=true,
               dataset_sources=["<用户名>/rvc-myvoice-dataset"]
rvc_notebook   kernel="rvc-train-myvoice", stage="train",
               dataset="rvc-myvoice-dataset", exp_name="myvoice", epochs=200
kernel_push    kernel="rvc-train-myvoice"        # 立即返回；用 kernel_status 轮询
kernel_status  kernel="rvc-train-myvoice"
kernel_output  kernel="rvc-train-myvoice", match="out/"
```

跑完后 `out/myvoice.pth` 与 `out/myvoice_added_*.index` 就会出现在本地的 `outputs/` 目录里。

### 第四步：用模型转换音频

```
kernel_new     title="RVC infer myvoice", slug="rvc-infer-myvoice",
               gpu=true, internet=true, is_private=true,
               kernel_sources=["<用户名>/rvc-train-myvoice"]    # 直接复用训练产出的模型
rvc_notebook   kernel="rvc-infer-myvoice", stage="infer", exp_name="myvoice"
kernel_push    kernel="rvc-infer-myvoice"
kernel_output  kernel="rvc-infer-myvoice", match="converted/"
```

转换结果形如 `<原文件名>_converted.wav`。

> 提示：全新 Kernel 的**第一次**推送有可能赶在数据源挂载完成之前启动，表现为"数据集未挂载"。
> 重新推送一次即可，这不是代码问题。

## 典型场景

### 训练一个好用的音色

| 要点 | 建议 |
|---|---|
| 音频时长 | **10 分钟以上**干净、无伴奏、单人、无混响的人声；低于这个量只能得到"验证流水线"级别的模型 |
| 切片长度 | 5–20 秒一段最理想；过长会被自动切分，过短则浪费特征提取时间 |
| epochs | RVC WebUI 默认 20，上游文档最高 1200。小数据集下 200 epochs 通常只有几分钟 |
| 采样率 | `40k`（默认）或 `48k`，按目标用途选择 |

**请务必如实评估产出**：用几分钟音频 + 2 epochs 训出来的模型只能证明流程可用，音色会明显机械、不稳定。
想要真正能用的声音，必须同时提高 epochs **并**增加干净音频。

### 调整转换效果

推理阶段最常用的几个参数：

| 参数 | 默认 | 作用 |
|---|---|---|
| `--pitch` | `0` | 半音移调，`+12` 为升高一个八度；匹配目标音域时最有效 |
| `--f0-method` | `rmvpe` | 仅支持 `rmvpe`（质量更好、更慢）与 `pm` |
| `--index-rate` | `0.75` | 检索索引对音色的影响程度；`0` 表示完全不使用索引 |
| `--protect` | `0.33` | `0–0.5`，保护清辅音；齿音发破时可调高 |

### 验证下载产物

- RVC 模型 `.pth` 本质是 ZIP 容器，文件开头应为 `PK\x03\x04`（十六进制 `50 4B 03 04`）；
- FAISS 索引开头应为 `IwFl`（十六进制 `49 77 46 6C`）。

开头不对说明下载被截断，重试即可（下载路径带自动重试）。

## 工具一览

共 16 个工具，全部以 `mcp__kaggle__` 前缀暴露。

| 工具 | 用途 |
|---|---|
| `status` | 凭据来源、用户名、本地目录、实时 API 探测 |
| `kernel_new` | 在本地创建 Kernel（`.ipynb` + `kernel-metadata.json`），可设置 GPU、机型、联网、各类数据源 |
| `kernel_write` | 写入 / 追加 / 前置 Notebook 单元格 |
| `kernel_read` | 查看本地 Kernel 的元数据与单元格 |
| `kernel_configure` | 修改 GPU、机型、联网、可见性与数据源 |
| `kernel_push` | 上传并在 Kaggle 上运行（`Save & Run All`），默认不阻塞 |
| `kernel_status` | 运行状态：queued / running / COMPLETE / ERROR，含失败信息 |
| `kernel_wait` | 轮询直到进入终态或超时 |
| `kernel_logs` | 读取运行日志（单页读取，即使产物上万也不慢） |
| `kernel_output` | 下载运行产物（模型、索引、音频） |
| `kernel_list` | 搜索 / 列出 Kernel |
| `kernel_pull` | 把 Kaggle 上已有的 Notebook 拉到本地编辑 |
| `dataset_push` | 把本地文件夹上传为私有数据集（或创建新版本） |
| `dataset_list` | 搜索 / 列出数据集（私有数据集需 `mine=true` 才可见） |
| `dataset_files` | 查看数据集内文件，确认是否就绪 |
| `rvc_notebook` | 一键填入现成的 RVC 单元格：`stage: setup \| train \| infer` |

## 输出与目录结构

```
kaggle_rvc_2/
├── README.md                  ← 本文件（对外说明）
├── 一键配置Kaggle密钥.cmd      双击填密钥（Windows 一键脚本）
├── setup-kaggle.ps1           上面那个 .cmd 的实现：验证 + 写入 + 同步用户名
├── tools/kaggle-hello.mjs     凭据探针：验证密钥并识别账号名
├── kaggle-mcp/                本地 MCP 服务器
│   ├── DEVELOPMENT.md         实现细节与实测记录（面向开发者）
│   ├── src/                   server / kaggle 客户端 / 凭据 / RVC 模板
│   └── test/                  冒烟、协议、端到端测试
├── kernels/<slug>/            本地生成的 Kernel（.ipynb + 元数据）
├── outputs/<owner>__<slug>/   从 Kaggle 下载的产物 + 运行日志
├── skills/                    DSH 技能：训练与推理的标准流程
└── .secrets/                  本地凭据兜底（Git 忽略）
```

训练产出的模型、索引与音频会被自动忽略，**不会被提交到仓库**；你可以自行放在任意位置，
用不着放进本目录（详见下方"数据与隐私"一节）。

## 常见问题

**Q：为什么不用现成的 Kaggle MCP 服务器？**
现有方案都跑不了 RVC：Kaggle 官方远程 MCP 需要交互式 OAuth，且保存 Notebook 时会丢数据源；
社区方案在推送 Kernel 时不支持 `enable_gpu` / `enable_internet` / `dataset_sources`——
没有这三样，RVC 既装不了依赖，也看不到训练音频。本项目为这些字段提供了一等公民支持。

**Q：`dataset_push` 失败了？**
它依赖把文件 PUT 到 `www.googleapis.com`（Kaggle 的 Blob 上传端点）。部分网络会屏蔽该域名，
而 `storage.googleapis.com` 与 `api.kaggle.com` 正常。报错信息会明确指出是哪台主机的问题；
这种情况下可以改用 Kaggle 网页端上传。

**Q：为什么 `dataset_list` 看不到我刚上传的数据集？**
`dataset_push` 默认创建**私有**数据集，而 Kaggle 的接口在未筛选时会隐藏私有项。加上 `mine=true` 即可。

**Q：训练显示 COMPLETE，但模型不可用？**
先确认产物真的存在（模板已内置断言），再检查音频质量与 epochs。最常见的根因是数据量太少。

**Q：`kernel_push` 为什么不等待？**
默认 `wait: false` 是有意为之：推送即返回，之后用 `kernel_status` 免费轮询，更适合自动化流程。
需要阻塞等待时显式传 `wait: true`。

**Q：想提高模型质量怎么办？**
先加音频（用 `dataset_push` 配合 `version_notes` 创建数据集新版本），再提高 `epochs`，然后重跑训练。

## 数据与隐私

训练用的音频、训练出的模型、索引和转换结果**默认不属于本仓库**，`models/`、`outputs/`、
`kernels/rvc-train-*/`、`kernels/rvc-infer-*/` 以及 `*.pth`、`*.index`、`*.wav` 等扩展名都已在
`.gitignore` 中忽略。

如果你用的是**别人的声音素材**，请把相关文件放在本仓库目录之外（避免被误打包或误 `git add -f`），
并且：

* 不要把模型、索引、转换后的音频提交到公开仓库；
* 注意转换结果同样是可辨识的他人音色，不等同于"原始素材没上传就安全了"；
* 数据集与 Kernel 在 Kaggle 上默认是私有的，但如果你主动设为公开，文件名与元数据也会一并公开；
* 使用他人声音前请取得授权，并遵守当地法律与平台条款。

## 已知限制

- 仅实现 MCP 的 **tools**，未实现 `resources` / `prompts`（DSH 侧也只消费 tools）。
- 未提供数据集的**下载**助手，也没有竞赛提交流程。
- 训练模板已端到端验证，但验证用的模型只是**流程验证级别**的产物，不代表可用的音色质量。
- Kaggle 平台偶发抖动：曾观察到运行约 30 秒后被平台取消（`CANCEL_ACKNOWLEDGED`），
  相同任务重新推送即可跑完——遇到这种情况优先重推，而不是排查代码。

## 更多文档

| 文档 | 内容 |
|---|---|
| [kaggle-mcp/DEVELOPMENT.md](kaggle-mcp/DEVELOPMENT.md) | 服务器实现细节、Kaggle API 差异、实测踩坑记录、测试方式 |
| [skills/rvc-train-on-kaggle/SKILL.md](skills/rvc-train-on-kaggle/SKILL.md) | 训练流程：额度检查、工具顺序、产物验证、失败排查 |
| [skills/rvc-inference-on-kaggle/SKILL.md](skills/rvc-inference-on-kaggle/SKILL.md) | 推理流程：模型挂载方式、参数说明、常见故障 |

## 致谢与许可

- 声音转换能力来自 [RVC-Project/Retrieval-based-Voice-Conversion-WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)，
  本项目只负责编排与在 Kaggle 上运行它。
- 算力由 [Kaggle](https://www.kaggle.com/) 提供。
- 请在使用他人声音前取得授权，并遵守当地法律法规与平台条款。

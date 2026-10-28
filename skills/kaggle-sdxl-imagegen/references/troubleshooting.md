# 排障手册：Kaggle SDXL 出图

按报错信息检索。每条都来自真实运行记录。

---

## `ERROR: Kaggle username unknown. Pass 'owner', or set KAGGLE_RVC_USERNAME / KAGGLE_USERNAME`

**现象**：调用 `kernel_new` / `kernel_output` 直接报错，连内核都没建。

**原因**：MCP 服务端从凭据文件里解析不出用户名（`mcp__kaggle__status` 会显示 `username : UNKNOWN`），
但 API 调用本身是通的。

**修复**：
- 任何需要 owner 的调用都显式传 `owner="<kaggle 用户名>"`。
- 用户名可以从已有的 output 目录名反推（形如 `<owner>__<slug>`），或直接问用户。

---

## `AttributeError: 'StableDiffusionXLPipeline' object has no attribute 'enable_vae_slicing'`

**现象**：内核状态 `ERROR`，output files 为 0，日志里卡在加载模型之后。

**原因**：Kaggle 镜像里的 diffusers 已是 1.x，VAE 相关方法从 pipeline 挪到了 `pipe.vae`。

**修复**：按版本自适应，不要写死。

```python
try:
    pipe.enable_vae_slicing()
except Exception:
    try:
        pipe.vae.enable_slicing()
    except Exception as exc:
        print("vae slicing unavailable:", exc)   # 切片只是省显存，缺了不影响出图
```

同类改名还有 `torch_dtype` → `dtype`，用 `try/except TypeError` 回退即可。

---

## `The following part of your input was truncated because CLIP can only handle sequences up to 77 tokens`

**现象**：图能出来，但风格/画质词没生效，尾部约束（如 `35mm photograph, high dynamic range`）被丢掉。

**原因**：CLIP 文本编码器硬上限 77 token，超出部分静默截断——**不报错**，只打 warning。

**修复**：把提示词压到 77 token 以内。`scripts/build_kernel.py` 会用启发式估算并在超限时打印
`WARNING: ... will be truncated`。压缩优先级：

1. 删掉形容词堆叠（`very very detailed` 之类）。
2. 把 `3 5 mm` 这种被空格拆开的词还原成 `35mm`。
3. 画质词只留 2 个，别写五个同义表达。
4. 剩下的移到负向提示词。

---

## 内核状态 `ERROR` 但日志看不出原因

**排查顺序**：

1. `kernel_logs` 看 `tail` 最后 40 行，找 `PapermillExecutionError` 下面那段 traceback——真正的异常在
   `Exception encountered at "In [N]"` 之后。
2. 确认 `output files: 0`：说明连 `os.makedirs` 都没跑完，问题一定在建模/加载阶段。
3. 常见诱因：pip 装包失败、HF 下载超时、显存 OOM。

**显存 OOM（T4 16GB）**：把 `low_vram` 设为 `true`（走 `enable_model_cpu_offload()`），
或把 `width/height` 降到 832×1216 之类，不要超过 1024×1024。

---

## `Warning: You are sending unauthenticated requests to the HF Hub`

**无害**，只是没有 HF token，下载限速。模型小（SDXL base 约 7GB）时能接受；
频繁重跑才需要考虑在 Kaggle 的 Secrets 里配 `HF_TOKEN`。

---

## 推送后长时间停在 `QUEUED`

Kaggle 免费 GPU 有排队。`kernel_wait` 单次别开太长：

- 先 `kernel_push`（不带 `wait`），拿到 kernelId 立刻返回；
- 再 `kernel_wait(timeout_sec=420)`，超时就再调一次，而不是一次等 1800 秒把调用拖死。

出图任务本身很快：SDXL 1024×1024 / 32 步 / T4 单张约 27 秒，整轮（含排队与模型下载）实测约 165 秒。

---

## `kernel_output` 下载下来的文件在 `out/` 子目录里

**不是 bug**。内核把产物写到 `/kaggle/working/out/`，下载时保留相对路径，于是落在
`<dest>/out/<file>.png`。给用户展示文件时要用这个真实路径，别拼错。

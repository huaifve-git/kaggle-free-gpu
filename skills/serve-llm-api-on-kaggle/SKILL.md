---
name: serve-llm-api-on-kaggle
description: Deploy an LLM on a Kaggle GPU kernel and expose it as a public OpenAI-compatible API ("api/v1") through the kaggle MCP server — pick a GGUF quant that fits the T4, launch llama.cpp's llama-server with a bearer key, tunnel it with cloudflared, verify /v1/chat/completions, and keep it alive with a supervisor loop. Use for deploy/部署模型/公网 API/暴露端口/在线推理服务/OpenAI 兼容接口, serving Gemma/Llama/Qwen GGUFs from Kaggle, or when asked why such a run has no URL, no logs, or is unusably slow.
whenToUse: The user wants a model running on a Kaggle GPU reachable over the internet as an api/v1 endpoint (for OpenCode, custom apps, scripts); asks to deploy/serve/暴露 a model on Kaggle; or a live Kaggle API deployment produced no URL, no logs, or absurdly slow first responses.
---

# Serve an LLM as a public OpenAI-compatible API from a Kaggle GPU

Everything runs inside **one Kaggle batch kernel** ("Save & Run All") driven by the
`kaggle` MCP tools (`mcp__kaggle__*`):

```text
Kaggle T4  ──  llama-server -m <gguf> --api-key K   (127.0.0.1:8000)
                     ▲
        cloudflared quick tunnel (outbound only, no account)
                     ▼
        https://<random>.trycloudflare.com/v1   ← the user's OpenAI base_url
```

Kaggle kernels have **no inbound ports** — outbound-only tunnels are the only way to
expose a service, and cloudflared quick tunnels need no account. The service lives exactly
as long as the Kaggle session (hours, then the platform hard-stops it; re-push for a new
session and a **new URL**).

## 1. Before you start

| Check | Why it matters |
|---|---|
| Credentials are bearer (`KAGGLE_API_TOKEN=KGAT_…` in `<workspace>/.secrets/kaggle.env`) | That is what `kaggle_status` reports as `found (bearer)`. |
| The **username** | Bearer tokens carry no username, so `kernel_new` fails with "Kaggle username unknown" until you pass `owner=`. Discover it in one call: `curl -H "Authorization: Bearer $TOKEN" https://www.kaggle.com/api/v1/hello` → `{"userName":"…"}`. |
| GPU quota | ~30 h/week, shared with everything else. Default shape is T4 x2. |
| VRAM math | A 12B at Q4 (≈7.4 GB) fits **one** 16 GB T4 with 16k context if the KV cache is `q8_0`; set `CUDA_VISIBLE_DEVICES=0` — a model that fits one GPU should not be split across the two T4s. |
| Model license gating | `google/gemma-*` repos are gated on HF; the community GGUF re-hosts (`unsloth/…-GGUF`, `bartowski/…-GGUF`) are not — use them and no HF token is needed. |
| Kernel flags | `kernel_new` with `gpu=true, internet=true, is_private=true, owner="<user>"`. Internet is mandatory: llama.cpp binaries, the model, and cloudflared are all downloads. |

## 2. The sequence

```text
kernel_new     owner="<user>", title="<M> OpenAI API", slug="<m>-openai-api",
               gpu=true, internet=true, is_private=true, cells=[setup|model|serve]
kernel_push    kernel="<slug>", wait=false      # returns once queued; run lasts hours
kernel_status  kernel="<slug>"                  # poll until RUNNING
# URL + key arrive out-of-band — see §4. Then verify — see §5.
```

Do **not** use `kernel_wait` here: it blocks until terminal state, and this run is only
terminal when the session dies.

## 3. The three cells

**Cell 1 — toolchain.** Download two GitHub release assets and `tar -xzf` both into one
directory: `llama-b<BUILD>-bin-ubuntu-cuda-12.8-x64.tar.gz` and
`cudart-llama-b<BUILD>-bin-ubuntu-cuda-12.8-x64.tar.gz` (verified with `b11669`/v0.7.0;
pick a build from after the model's architecture landed — e.g. gemma4-unified merged
2026-06-03, PR ggml-org/llama.cpp#24077). Then
`LD_LIBRARY_PATH=$(find <dir> -type d | tr '\n' ':')` so both `libggml-cuda.so` and the
shipped cudart/cuBLAS resolve. cloudflared: `releases/latest/download/cloudflared-linux-amd64`.

**Cell 2 — model.** `snapshot_download` with **exact** `allow_patterns`
(`["gemma-4-12b-it-UD-Q4_K_XL.gguf", "mmproj-F16.gguf"]` for the Unsloth gemma-4-12B repo):
the repo also ships MTP drafters and every other quant, and 7.4 GB is a ~2 min download on
Kaggle. The `mmproj-F16.gguf` (175 MB) is what adds image+audio input — text-only works
without it.

**Cell 3 — serve.** Writes `serve.sh` and runs it; the cell (and the kernel) is meant to
block forever. The full proven script is [references/serve.sh](references/serve.sh).
Its load-bearing pieces:

* `llama-server -m <gguf> --host 127.0.0.1 --port 8000 -ngl 999 --jinja --api-key <K> --no-webui`
  (`--jinja` is required for the Gemma 4 chat template).
* Config **fallback chain**, first success wins — each attempt is a fresh process plus a
  readiness probe: `16k + q8_0 KV + FA + mmproj` → `8k` → drop mmproj → bare `-c 8192`.
  Which config is live is visible from the client: `/v1/models` reports `n_ctx` and
  `capabilities`.
* Readiness probe hits `/health` (unauthenticated) and falls back to an authenticated
  `/v1/models`, because it must distinguish "still loading" from "rejecting the key".
* Tunnel: `cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate`, then scrape
  `https://[a-z0-9-]+\.trycloudflare\.com` from its log.
* Supervisor loop (60 s): restart llama-server and/or the tunnel if their PIDs die, and
  print a heartbeat line. **A tunnel restart changes the URL** — the loop republishes it.

## 4. Getting the URL out while the run is alive

`kernel_logs` answers **"no log available yet — the run may still be starting" for the whole
duration of a running batch run** (it only has the completed log; the Kaggle web UI streams,
the API does not). So the design documents the URL *out of band*: create a webhook in one
call (`POST https://webhook.site/token` → `uuid`), embed `POST https://webhook.site/<uuid>`
in `serve.sh`, and read it back any time with
`GET https://webhook.site/token/<uuid>/requests`. A dpaste.com POST is a fallback, and the
human can always read the live log on the kernel's Kaggle page. Webhook tokens expire
(default 7 days) — make a fresh one per deployment.

## 5. Verify from the client, and do not misread the first request

* `GET /v1/models` with `Authorization: Bearer <K>` → check `n_ctx`, quant, and
  `capabilities` (`completion`, `multimodal`).
* **The first completion after load is cold**: weights are mmap'd, so the first prompt
  streams the whole file off disk. Measured on a 12B Q4/T4: 0.42 tok/s prefill for that
  first 27-token prompt (~64 s) — while a warm prefill is 79–290 tok/s and generation is
  12.5–16.6 tok/s. Warm it once before benchmarking or declaring it broken.
* Streaming SSE works (`data:` chunks + `[DONE]`).
* Gemma 4 emits thinking by default (`reasoning_content`, and `content` stays empty when
  `max_tokens` is small). Disable per request with
  `"chat_template_kwargs": {"enable_thinking": false}` — verified on llama.cpp `--jinja`.
* The `model` field in requests is effectively ignored (one model per server); any string works.

Numbers above come from the first real deployment (12B Q4_K_XL on T4): 27-token prompt cold
0.42 tok/s; warm 152-token prompt 289.7 tok/s prefill and 12.5 tok/s generation; streaming
test 16.6 tok/s with thinking disabled.

## 6. Lifecycle and security

* The URL dies with the session (hours). To renew: `kernel_push` the same local kernel
  again — new session, new tunnel URL; the webhook token can be reused within its lifetime.
* The only auth is `--api-key`; quick tunnels are public URLs — never run without a key,
  and rotate (re-push with a new key) anything that leaked. Treat chat-pasted Kaggle tokens
  as burned: rotate them in Kaggle settings.
* `kernels/` is gitignored in this repo, so the local kernel dir (which embeds the Kaggle
  username in its metadata `id`) does not get committed.

## 7. When it fails (all observed in live runs)

| Symptom | Root cause | Fix |
|---|---|---|
| `kernel_new`: "Kaggle username unknown" | bearer KGAT token has no username | `/api/v1/hello` probe (see §1), pass `owner=` |
| HTTP 400 `json.exception.parse_error.101` from the API | PowerShell mangling `-d '{...}'` | write the JSON to a file, `curl --data-binary @file` |
| `kernel_logs` has nothing, for hours | running batch runs don't serve logs over the API | webhook.site POST (+ dpaste); human reads the Kaggle UI |
| First response crawls (<1 tok/s) | cold mmap read of the whole GGUF | warm it; later requests are ~40x faster |
| Server exits at 16k / OOM | KV+mmproj exceed the T4 | fallback chain already retries 8k → no-mmproj → bare |
| Tunnel URL stopped responding | cloudflared died; restarted with a **new URL** | read the webhook / heartbeat lines for the new URL |
| `kill -0 $SERVER_PID` false right after a manual kill | supervisor has stale PID semantics | the loop relaunches; require the readiness probe before publishing again |

## 8. Expectations on a T4

12B Q4: ~12–17 tok/s single-stream, 80–300 tok/s prefill — fine for personal and agent use,
one request at a time (single slot). If the user needs throughput or bigger models, switch
`machine_shape` (L4 / A100) and mind the quota; the same notebook works unchanged.

#!/bin/bash
# Public OpenAI-compatible LLM API from a Kaggle GPU kernel.
# Proven with: llama.cpp b11669 (v0.7.0) CUDA-12.8 build + cloudflared quick tunnel,
# model = unsloth/gemma-4-12b-it-GGUF gemma-4-12b-it-UD-Q4_K_XL.gguf + mmproj-F16.gguf,
# single T4, 16k context, q8_0 KV cache.
#
# Expected layout (built by earlier notebook cells):
#   /kaggle/working/llama/**            extracted llama-*-bin-ubuntu-cuda-12.8-x64.tar.gz
#                                       + cudart-llama-*-bin-ubuntu-cuda-12.8-x64.tar.gz
#   /kaggle/working/cloudflared         cloudflared-linux-amd64
#   /kaggle/working/models/*.gguf       snapshot_download of the GGUF repo
#
# This script blocks forever (that IS the Kaggle run). Watch it via the webhook below,
# since kernel_logs does not serve live logs for running batch runs.
set -u

API_KEY="${API_KEY:-sk-changeme}"                 # override before running
HOOK="${HOOK:-}"                                  # optional: https://webhook.site/<token> (create via POST https://webhook.site/token)
WORK=/kaggle/working
MODEL=$WORK/models/gemma-4-12b-it-UD-Q4_K_XL.gguf
MMPROJ=$WORK/models/mmproj-F16.gguf
CF=$WORK/cloudflared
SERVER_LOG=$WORK/server.log
CF_LOG=$WORK/cloudflared.log

# Both the binary dir and the shipped cudart/cuBLAS must resolve.
export LD_LIBRARY_PATH=$(find $WORK/llama -type d 2>/dev/null | tr '\n' ':')${LD_LIBRARY_PATH:-}
# Keep the model on ONE T4: it fits, and single-GPU beats PCIe layer splitting here.
export CUDA_VISIBLE_DEVICES=0
SERVER=$(find $WORK/llama -name llama-server -type f | head -1)
echo "llama-server: $SERVER"
"$SERVER" --version 2>&1 | head -4 || true

BASE_ARGS="-m $MODEL --host 127.0.0.1 --port 8000 -ngl 999 --jinja --api-key $API_KEY --no-webui"

server_ready() {
  # 200 from /health when ready; some builds gate it behind the key, so probe both.
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/health || true)
  [ "$code" = "200" ] && return 0
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $API_KEY" http://127.0.0.1:8000/v1/models || true)
  [ "$code" = "200" ]
}

start_server() {
  echo "=== $(date -u) starting llama-server: $* ==="
  $SERVER $BASE_ARGS "$@" > $SERVER_LOG 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 240); do
    server_ready && { echo "=== server READY ($*) ==="; tail -5 $SERVER_LOG; return 0; }
    kill -0 $SERVER_PID 2>/dev/null || { echo "=== server exited early ==="; tail -40 $SERVER_LOG; return 1; }
    sleep 3
  done
  echo "=== server load timeout ==="
  kill $SERVER_PID 2>/dev/null
  return 1
}

start_tunnel() {
  : > $CF_LOG
  $CF tunnel --url http://127.0.0.1:8000 --no-autoupdate > $CF_LOG 2>&1 &
  TUNNEL_PID=$!
  URL=""
  for i in $(seq 1 90); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' $CF_LOG 2>/dev/null | head -1)
    [ -n "$URL" ] && break
    kill -0 $TUNNEL_PID 2>/dev/null || { echo "=== cloudflared died ==="; tail -20 $CF_LOG; return 1; }
    sleep 2
  done
  [ -n "$URL" ] || { echo "=== no tunnel URL ==="; tail -20 $CF_LOG; return 1; }
  echo ""
  echo "############################################################################"
  echo "#   LLM - OpenAI compatible API - LIVE"
  echo "#   Base URL : $URL/v1"
  echo "#   API key  : $API_KEY"
  echo "#   Models   : $URL/v1/models"
  echo "#   Chat     : $URL/v1/chat/completions"
  echo "############################################################################"
  echo ""
  # Out-of-band URL delivery: kernel_logs has no live log for running batch runs.
  [ -n "$HOOK" ] && curl -s -m 20 -X POST "$HOOK" -d "url=$URL/v1" -d "key=$API_KEY" -o $WORK/hook.out 2>&1 || true
  curl -s -m 20 -X POST https://dpaste.com/api/v2/ --data-urlencode "content=LLM API $URL/v1 key=$API_KEY" --data "expiry_days=7" -o $WORK/dpaste.txt 2>&1 || true
  echo "dpaste: $(cat $WORK/dpaste.txt 2>/dev/null)"
  return 0
}

# Fallback chain: 16k q8_0-KV + FA + mmproj -> 8k -> no mmproj -> bare.
# First config that becomes healthy wins; /v1/models tells you which one is live.
start_server --mmproj $MMPROJ -c 16384 -fa on --cache-type-k q8_0 --cache-type-v q8_0 \
 || start_server --mmproj $MMPROJ -c 8192 -fa on --cache-type-k q8_0 --cache-type-v q8_0 \
 || start_server -c 8192 -fa on --cache-type-k q8_0 --cache-type-v q8_0 \
 || start_server -c 8192 \
 || { echo "FATAL: llama-server could not start"; sleep 900; exit 1; }

if ! start_tunnel; then sleep 30; start_tunnel || echo "WARNING: tunnel failed"; fi

# Supervisor: keep both alive; a tunnel restart yields a NEW url, so republish it.
while true; do
  sleep 60
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "$(date -u) server died, restarting"
    start_server --mmproj $MMPROJ -c 8192 -fa on --cache-type-k q8_0 --cache-type-v q8_0 \
      || start_server -c 8192 \
      || echo "$(date -u) restart failed, will retry"
  fi
  if ! kill -0 $TUNNEL_PID 2>/dev/null; then
    echo "$(date -u) tunnel died, restarting (URL will change)"
    start_tunnel || echo "$(date -u) tunnel restart failed"
  fi
  echo "$(date -u) heartbeat server_pid=$SERVER_PID tunnel_pid=$TUNNEL_PID url=${URL:-none}"
done

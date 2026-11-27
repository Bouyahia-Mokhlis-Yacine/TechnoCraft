#!/bin/bash
# usage: serve.sh <model_dir> <max_len> <gpu_util> [extra vllm args...]
# default parsers are Gemma 4's; pass --tool-call-parser/--reasoning-parser to override.
source ~/venv/bin/activate
export LD_LIBRARY_PATH=$HOME/venv/lib/python3.11/site-packages/nvidia/cu13/lib:${LD_LIBRARY_PATH:-}
export HF_HUB_OFFLINE=1 VLLM_NO_USAGE_STATS=1 DO_NOT_TRACK=1
m=$1; len=${2:-16384}; util=${3:-0.74}; shift 3
extra=("$@")
[ ${#extra[@]} -eq 0 ] && extra=(--tool-call-parser gemma4 --reasoning-parser gemma4 --limit-mm-per-prompt '{"image":0,"audio":0}')
exec vllm serve "$m" --served-model-name gemma --host 127.0.0.1 --port 8000 \
  --max-model-len "$len" --gpu-memory-utilization "$util" --max-num-seqs 8 \
  --enable-auto-tool-choice "${extra[@]}"

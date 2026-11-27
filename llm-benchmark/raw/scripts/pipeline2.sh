#!/bin/bash
# Serve and benchmark each model in turn on the one GPU slice. Waits for each download, never runs two
# servers at once, and continues past a model that fails to start. Results: results-<tag>.jsonl, run-<tag>.log
cd ~/llm-bench
NOTHINK='{"chat_template_kwargs":{"enable_thinking":false}}'
QWEN=(--tool-call-parser qwen3_coder --reasoning-parser qwen3 --language-model-only)

run() {  # tag model_dir_or_repo extra_body util -- vllm args...
  local tag=$1 model=$2 body=$3 util=$4; shift 5
  local name=$(basename "$model")
  while pgrep -f "pdl.py .*/$name( |$)" >/dev/null || ls ~/models/$name/*.part >/dev/null 2>&1; do sleep 15; done
  echo "$(date +%T) [$tag] starting server"
  ~/llm-bench/serve.sh "$model" 16384 "$util" "$@" > run-$tag.log 2>&1 &
  local pid=$! ok=0
  for i in $(seq 1 90); do
    curl -sf localhost:8000/v1/models >/dev/null && { ok=1; break; }
    kill -0 $pid 2>/dev/null || break
    sleep 10
  done
  if [ $ok = 1 ]; then
    echo "$(date +%T) [$tag] ready, benchmarking"
    EXTRA_BODY="$body" ~/venv/bin/python -u bench.py http://127.0.0.1:8000 gemma results-$tag.jsonl > bench-$tag.log 2>&1
    sed -n '/^== /,$p' bench-$tag.log
  else
    echo "$(date +%T) [$tag] FAILED to start:"; grep -E "Error|error:" run-$tag.log | grep -v Route | tail -4 | cut -c1-300
  fi
  pkill -f "vllm serve" ; sleep 3; pkill -9 -f "vllm serve"; sleep 5
}
while pgrep -f "bash .*/pipeline.sh" >/dev/null; do sleep 20; done
run granite42-30b  ~/models/granite-4.2-30b-fp8   "$NOTHINK" 0.74 -- --tool-call-parser granite4
run jais3-32b      ~/models/Jais-3-32B-FP8        '{"chat_template_kwargs":{"reasoning_effort":"low"}}' 0.77 -- --model-impl vllm --tool-call-parser k2_horizon --reasoning-parser k2_horizon --kv-cache-dtype fp8 --enforce-eager --max-num-seqs 2 --max-model-len 8192
echo "$(date +%T) pipeline2 done"

#!/bin/bash
cd ~/llm-bench
run() {  # tag model_dir extra_body util -- vllm args...
  local tag=$1 model=$2 body=$3 util=$4; shift 5
  until [ -f "$model/.complete" ]; do sleep 15; done
  echo "$(date +%T) [$tag] starting server"
  ~/llm-bench/serve.sh "$model" 16384 "$util" "$@" > run-$tag.log 2>&1 &
  local pid=$! ok=0
  for i in $(seq 1 90); do
    curl -sf localhost:8000/v1/models >/dev/null && { ok=1; break; }
    kill -0 $pid 2>/dev/null || break
    sleep 10
  done
  if [ $ok = 1 ]; then
    echo "$(date +%T) [$tag] ready ($(grep -oE 'GPU KV cache size: [0-9,]+ tokens' run-$tag.log | tail -1))"
    EXTRA_BODY="$body" ~/venv/bin/python -u bench.py http://127.0.0.1:8000 gemma results-$tag.jsonl > bench-$tag.log 2>&1
    sed -n '/^== /,$p' bench-$tag.log
  else
    echo "$(date +%T) [$tag] FAILED to start:"; grep -E "Error|error:" run-$tag.log | grep -v Route | tail -4 | cut -c1-300
  fi
  pkill -f "vllm serve"; sleep 3; pkill -9 -f "vllm serve"; sleep 5
}
while pgrep -f "bash .*/pipeline3.sh" >/dev/null; do sleep 20; done
run jais3-32b ~/models/Jais-3-32B-FP8 '{"chat_template_kwargs":{"reasoning_effort":"low"}}' 0.92 -- --model-impl vllm --trust-remote-code --tool-call-parser k2_horizon --reasoning-parser k2_horizon
echo "$(date +%T) jais rerun done"

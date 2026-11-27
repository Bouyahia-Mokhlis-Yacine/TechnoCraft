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

run qwen35-9b      Qwen/Qwen3.5-9B                                   "$NOTHINK" 0.74 -- "${QWEN[@]}"
run ministral3-14b ~/models/Ministral-3-14B-Instruct-2512            '{}'       0.74 -- --tokenizer_mode mistral --config_format mistral --load_format mistral --tool-call-parser mistral --limit-mm-per-prompt '{"image":0}'
run gpt-oss-20b    ~/models/gpt-oss-20b                              '{"reasoning_effort":"low"}' 0.74 -- --tool-call-parser openai --reasoning-parser openai_gptoss
run qwen36-35b-a3b ~/models/Qwen3.6-35B-A3B-AWQ-4bit                 "$NOTHINK" 0.74 -- "${QWEN[@]}"
run qwen38-27b     ~/models/Qwen3.8-27B-FP8                          "$NOTHINK" 0.74 -- "${QWEN[@]}"
run nemotron3-30b  ~/models/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8       "$NOTHINK" 0.75 -- --tool-call-parser qwen3_coder --reasoning-parser nemotron_v3 --trust-remote-code --max-num-seqs 4
echo "$(date +%T) pipeline done"

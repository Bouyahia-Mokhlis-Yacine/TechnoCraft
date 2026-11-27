#!/bin/bash
# Round 3 on a clean 47 GB slice. Two download lanes run in the background; each model is served and
# benchmarked once its ~/models/<name>/.complete marker exists. One vLLM server at a time.
cd ~/llm-bench
NOTHINK='{"chat_template_kwargs":{"enable_thinking":false}}'
QWEN=(--tool-call-parser qwen3_coder --reasoning-parser qwen3 --language-model-only)
GEMMA=(--tool-call-parser gemma4 --reasoning-parser gemma4 --limit-mm-per-prompt '{"image":0,"audio":0}')

lane() { for r in "$@"; do n=$(basename $r)
  until python pdl.py $r 16 >> dl-$n.log 2>&1; do sleep 10; done; touch ~/models/$n/.complete
  echo "$(date +%T) downloaded $n"; done; }
for d in ~/models/*/; do ls $d*.part >/dev/null 2>&1 || touch $d.complete; done
rm -rf ~/models/Qwen3.6-35B-A3B-AWQ-4bit
lane Qwen/Qwen3.8-27B-FP8 IFM/Jais-3-32B-FP8 ibm-granite/granite-4.2-30b-fp8 &
lane Qwen/Qwen3.6-35B-A3B-FP8 RedHatAI/gemma-4-31B-it-FP8-dynamic nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8 &

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

M=~/models
run gemma26b-clean  $M/gemma-4-26B-A4B-it-FP8-dynamic      '{}'       0.90 -- "${GEMMA[@]}"
run gemma31b-4bit-clean $M/gemma-4-31B-it-qat-w4a16-ct     '{}'       0.90 -- "${GEMMA[@]}"
run qwen38-27b      $M/Qwen3.8-27B-FP8                     "$NOTHINK" 0.90 -- "${QWEN[@]}"
run qwen36-35b-fp8  $M/Qwen3.6-35B-A3B-FP8                 "$NOTHINK" 0.92 -- "${QWEN[@]}"
run jais3-32b       $M/Jais-3-32B-FP8                      '{"chat_template_kwargs":{"reasoning_effort":"low"}}' 0.92 -- --model-impl vllm --tool-call-parser k2_horizon --reasoning-parser k2_horizon
run gemma31b-fp8    $M/gemma-4-31B-it-FP8-dynamic          '{}'       0.92 -- "${GEMMA[@]}"
run nemotron3-30b   $M/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8  "$NOTHINK" 0.92 -- --tool-call-parser qwen3_coder --reasoning-parser nemotron_v3 --trust-remote-code
run granite42-30b   $M/granite-4.2-30b-fp8                 "$NOTHINK" 0.90 -- --tool-call-parser granite4
wait
echo "$(date +%T) pipeline3 done"

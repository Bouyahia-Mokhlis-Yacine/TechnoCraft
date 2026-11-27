#!/bin/bash
# Round 4: the harder question set (questions_b.json) on every model that qualified on set A.
cd ~/llm-bench
while pgrep -f "bash .*/(pipeline3|jais_rerun|granite_rerun).sh" >/dev/null; do sleep 20; done
NOTHINK='{"chat_template_kwargs":{"enable_thinking":false}}'
M=~/models
declare -A DIR BODY UTIL ARGS
GEMMA="--tool-call-parser gemma4 --reasoning-parser gemma4 --limit-mm-per-prompt {\"image\":0,\"audio\":0}"
QWEN="--tool-call-parser qwen3_coder --reasoning-parser qwen3 --language-model-only"
DIR[gemma26b-clean]=$M/gemma-4-26B-A4B-it-FP8-dynamic;    BODY[gemma26b-clean]='{}';       UTIL[gemma26b-clean]=0.90; ARGS[gemma26b-clean]=$GEMMA
DIR[gemma31b-fp8]=$M/gemma-4-31B-it-FP8-dynamic;          BODY[gemma31b-fp8]='{}';         UTIL[gemma31b-fp8]=0.92;   ARGS[gemma31b-fp8]=$GEMMA
DIR[gemma31b-4bit-clean]=$M/gemma-4-31B-it-qat-w4a16-ct;  BODY[gemma31b-4bit-clean]='{}';  UTIL[gemma31b-4bit-clean]=0.90; ARGS[gemma31b-4bit-clean]=$GEMMA
DIR[qwen38-27b]=$M/Qwen3.8-27B-FP8;                       BODY[qwen38-27b]=$NOTHINK;       UTIL[qwen38-27b]=0.90;     ARGS[qwen38-27b]=$QWEN
DIR[qwen36-35b-fp8]=$M/Qwen3.6-35B-A3B-FP8;               BODY[qwen36-35b-fp8]=$NOTHINK;   UTIL[qwen36-35b-fp8]=0.92; ARGS[qwen36-35b-fp8]=$QWEN
DIR[nemotron3-30b]=$M/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8; BODY[nemotron3-30b]=$NOTHINK;    UTIL[nemotron3-30b]=0.92;  ARGS[nemotron3-30b]="--tool-call-parser qwen3_coder --reasoning-parser nemotron_v3 --trust-remote-code"
DIR[granite42-30b]=$M/granite-4.2-30b-fp8;                BODY[granite42-30b]=$NOTHINK;    UTIL[granite42-30b]=0.90;  ARGS[granite42-30b]="--tool-call-parser qwen3_coder"
DIR[jais3-32b]=$M/Jais-3-32B-FP8;                         BODY[jais3-32b]='{"chat_template_kwargs":{"reasoning_effort":"low"}}'; UTIL[jais3-32b]=0.92; ARGS[jais3-32b]="--model-impl vllm --trust-remote-code --tool-call-parser k2_horizon --reasoning-parser k2_horizon"

qualified=$(python3 - <<'EOF'
import json, glob, os
for tag in ["gemma26b-clean","gemma31b-fp8","qwen36-35b-fp8","qwen38-27b","nemotron3-30b","granite42-30b","jais3-32b","gemma31b-4bit-clean"]:
    f = f"results-{tag}.jsonl"
    if not os.path.exists(f): continue
    rows = [json.loads(l) for l in open(f)]
    if len(rows) < 32 or any("error" in r for r in rows): continue
    route = sum(r["tool_ok"] for r in rows) / len(rows)
    nums = all(not r["stray_numbers"] for r in rows)
    if route >= 0.94 and nums: print(tag)
EOF
)
echo "$(date +%T) set B finalists: $(echo $qualified | tr '\n' ' ')"
for tag in $qualified; do
  echo "$(date +%T) [$tag] starting server"
  read -r -a args <<< "${ARGS[$tag]}"
  ~/llm-bench/serve.sh "${DIR[$tag]}" 16384 "${UTIL[$tag]}" "${args[@]}" > run-b-$tag.log 2>&1 &
  pid=$! ok=0
  for i in $(seq 1 90); do curl -sf localhost:8000/v1/models >/dev/null && { ok=1; break; }; kill -0 $pid 2>/dev/null || break; sleep 10; done
  if [ $ok = 1 ]; then
    QUESTIONS=questions_b.json EXTRA_BODY="${BODY[$tag]}" ~/venv/bin/python -u bench.py http://127.0.0.1:8000 gemma results-b-$tag.jsonl > bench-b-$tag.log 2>&1
    sed -n '/^== /,$p' bench-b-$tag.log
  else
    echo "$(date +%T) [$tag] FAILED"; grep -E "Error|error:" run-b-$tag.log | grep -v Route | tail -3 | cut -c1-250
  fi
  pkill -f "vllm serve"; sleep 3; pkill -9 -f "vllm serve"; sleep 5
done
echo "$(date +%T) pipeline4 done"

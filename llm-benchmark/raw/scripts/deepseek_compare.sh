#!/bin/bash
# Final comparison: Gemma 4 26B A4B (our server, through the SSH tunnel) vs DeepSeek V4 Pro and
# V4.1 Flash (hosted API), all run from the same laptop with the shipping prompt (rule 8).
# usage: bash deepseek_compare.sh   (from llm-benchmark/raw/scripts; key in ../../../Deepseek_key.txt)
cd "$(dirname "$0")"
R=../results; L=../logs/bench
export SYSTEM_EXTRA=$'\n8. Refusals and short replies follow rule 6 too: a Darija question gets a Darija answer and an Arabic-script question an Arabic-script answer, never English. Never repeat the prohibited words, not even to say you avoid them.'
run() {  # tag base model [env...]
  local tag=$1 base=$2 model=$3; shift 3
  for set in a b; do
    q=questions.json; [ $set = b ] && q=questions_b.json
    env QUESTIONS=$q "$@" python3 -u bench.py "$base" "$model" $R/results-cmp-$tag-$set.jsonl > $L/bench-cmp-$tag-$set.log 2>&1
    echo "$(date +%T) [$tag set $set]"; sed -n '/^== /,$p' $L/bench-cmp-$tag-$set.log
  done
}
KEY=$(tr -d '[:space:]' < ../../../Deepseek_key.txt)
run gemma26b      http://127.0.0.1:18000   assistant &
run deepseek-pro   https://api.deepseek.com deepseek-v4-pro API_KEY=$KEY KEEP_REASONING=1 &
run deepseek-flash https://api.deepseek.com deepseek-flash  API_KEY=$KEY KEEP_REASONING=1 &
wait
echo "$(date +%T) comparison done"

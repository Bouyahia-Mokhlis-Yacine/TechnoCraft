#!/bin/bash
# wait for pdl.py to finish this model, then serve it. usage: wait_and_serve.sh <name> <max_len> <util>
d=~/models/$1
while pgrep -f "pdl.py .*/$1" >/dev/null || [ -n "$(ls $d/*.part 2>/dev/null)" ]; do sleep 10; done
echo "$(date +%T) download done, serving $d"
exec ~/llm-bench/serve.sh "$d" "$2" "$3"

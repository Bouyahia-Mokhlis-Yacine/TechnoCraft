#!/bin/bash
# Xet download with a stall watchdog: restart if the repo dir stops growing for 90 s.
repo=$1; dir=~/.cache/huggingface/hub/models--${repo//\//--}
for attempt in $(seq 1 15); do
  ~/venv/bin/hf download "$repo" >/dev/null 2>&1 & pid=$!
  last=-1; still=0
  while kill -0 $pid 2>/dev/null; do
    sleep 10; size=$(du -sb "$dir" 2>/dev/null | cut -f1)
    if [ "$size" = "$last" ]; then still=$((still+10)); else still=0; fi; last=$size
    if [ $still -ge 90 ]; then echo "$(date +%T) $repo stalled at $size, restarting"; kill -9 $pid; pkill -9 -P $pid; break; fi
  done
  wait $pid 2>/dev/null && { echo "$(date +%T) $repo done $(du -sh $dir | cut -f1)"; exit 0; }
  rm -f "$dir"/blobs/*.incomplete
done
exit 1

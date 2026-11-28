#!/bin/bash
# Opens (or checks) the SSH tunnel from this machine to the model on the HPC notebook.
# After it succeeds the backend uses LLM_URL=http://127.0.0.1:18000/v1
# Needs the "hpc" host in ~/.ssh/config (set up by the hpc-mcp ssh setup).
#   ./llm/tunnel.sh           open it once (or confirm it is up)
#   ./llm/tunnel.sh --watch   keep it up: check every 20 s and reopen it when it drops
#                             (run it in the background: nohup ./llm/tunnel.sh --watch >/tmp/llm-tunnel.log 2>&1 &)
LOCAL=${LLM_LOCAL_PORT:-18000}
INTERVAL=${LLM_TUNNEL_INTERVAL:-20}

up() { curl -sf -m 5 "http://127.0.0.1:$LOCAL/v1/models" >/dev/null; }

open_tunnel() {
  if ! up; then
    pkill -f "ssh .*-L $LOCAL:127.0.0.1:8000 hpc" 2>/dev/null   # a dead tunnel would still hold the port
    ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ConnectTimeout=15 \
      -L "$LOCAL:127.0.0.1:8000" hpc || { echo "$(date +%T) ssh tunnel failed (is the notebook running?)"; return 1; }
    sleep 1
  fi
  if up; then echo "$(date +%T) model reachable at http://127.0.0.1:$LOCAL/v1"; return 0; fi
  echo "$(date +%T) tunnel is open but the model does not answer: run ~/llm-serve/assistantctl.sh status on the notebook"; return 1
}

if [ "$1" = "--watch" ]; then
  echo "$(date +%T) watching the tunnel every ${INTERVAL}s (Ctrl-C to stop)"
  was_up=1
  while true; do
    if up; then
      [ $was_up -eq 0 ] && echo "$(date +%T) model reachable again"
      was_up=1
    else
      echo "$(date +%T) model unreachable: reopening the tunnel"
      open_tunnel && was_up=1 || was_up=0
    fi
    sleep "$INTERVAL"
  done
fi

open_tunnel

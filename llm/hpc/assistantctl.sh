#!/bin/bash
# Runs the assistant model (Gemma 4 26B A4B FP8) with vLLM on the HPC notebook.
# Binds to 127.0.0.1 only: the backend reaches it through an SSH tunnel.
#
# usage: assistantctl.sh start|stop|restart|status|logs
# Install: copy to ~/llm-serve/assistantctl.sh on the notebook.
set -u
DIR=$HOME/llm-serve
MODEL_DIR=${MODEL_DIR:-$HOME/models/gemma-4-26B-A4B-it-FP8-dynamic}
PORT=${PORT:-8000}
mkdir -p "$DIR/logs"

serve_forever() {  # restarts vLLM if it exits (crash, OOM), 15 s apart
  source ~/venv/bin/activate
  export LD_LIBRARY_PATH=$HOME/venv/lib/python3.11/site-packages/nvidia/cu13/lib:${LD_LIBRARY_PATH:-}
  export HF_HUB_OFFLINE=1 VLLM_NO_USAGE_STATS=1 DO_NOT_TRACK=1
  while true; do
    echo "$(date -Is) starting vLLM" >> "$DIR/logs/supervisor.log"
    vllm serve "$MODEL_DIR" --served-model-name assistant gemma \
      --host 127.0.0.1 --port "$PORT" \
      --max-model-len 16384 --gpu-memory-utilization 0.90 --max-num-seqs 8 \
      --enable-auto-tool-choice --tool-call-parser gemma4 --reasoning-parser gemma4 \
      --limit-mm-per-prompt '{"image":0,"audio":0}' >> "$DIR/logs/vllm.log" 2>&1
    echo "$(date -Is) vLLM exited ($?), restarting in 15 s" >> "$DIR/logs/supervisor.log"
    sleep 15
  done
}

running() { [ -f "$DIR/pid" ] && kill -0 "$(cat "$DIR/pid")" 2>/dev/null; }
healthy() { curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null; }

case "${1:-status}" in
  _serve) serve_forever ;;
  start)
    if running; then echo "already running (pid $(cat "$DIR/pid"))"; exit 0; fi
    setsid nohup "$0" _serve >/dev/null 2>&1 < /dev/null &
    echo $! > "$DIR/pid"
    echo -n "starting (pid $!), loading the model"
    for _ in $(seq 1 60); do healthy && { echo " - ready on 127.0.0.1:$PORT"; exit 0; }; echo -n .; sleep 5; done
    echo " - not ready after 5 min, see: $0 logs"; exit 1 ;;
  stop)
    running && kill -- -"$(cat "$DIR/pid")" 2>/dev/null
    sleep 3; pkill -f "vllm serve $MODEL_DIR" 2>/dev/null; rm -f "$DIR/pid"; echo stopped ;;
  restart) "$0" stop; "$0" start ;;
  status)
    if healthy; then echo "up: http://127.0.0.1:$PORT/v1 (models: assistant, gemma)"
    elif running; then echo "process running, model still loading or failing (see logs)"
    else echo "down"; exit 1; fi ;;
  logs) tail -n "${2:-40}" "$DIR/logs/supervisor.log" "$DIR/logs/vllm.log" ;;
  *) echo "usage: $0 start|stop|restart|status|logs"; exit 2 ;;
esac

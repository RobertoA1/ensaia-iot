#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv-whisper/bin/python ]]; then
  echo "Preparando el entorno local de Whisper..."
  python3 -m venv .venv-whisper
fi
if ! .venv-whisper/bin/python -c "import faster_whisper, websockets, piper" 2>/dev/null; then
  .venv-whisper/bin/pip install -r whisper_local/requirements.txt
fi
if [[ ! -f whisper_local/voices/es_MX-claude-high.onnx ]]; then
  echo "Descargando voz local en español..."
  .venv-whisper/bin/python -m piper.download_voices --data-dir whisper_local/voices es_MX-claude-high
fi
exec .venv-whisper/bin/python -u whisper_local/worker.py

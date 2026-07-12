#!/usr/bin/env bash
# Fetch the default local embedding model into the Tauri resources dir so it is
# bundled into release installers. Safe to re-run (skips existing files).
set -euo pipefail

MODEL="bge-small-en-v1.5"
REPO="BAAI/${MODEL}"
BASE="https://huggingface.co/${REPO}/resolve/main"
DEST="$(cd "$(dirname "$0")/.." && pwd)/resources/models/${MODEL}"

mkdir -p "$DEST"
for f in config.json tokenizer.json model.safetensors; do
  if [ -f "$DEST/$f" ]; then
    echo "have $f"
  else
    echo "downloading $f …"
    curl -fL --retry 3 -o "$DEST/$f" "${BASE}/${f}?download=true"
  fi
done
echo "model ready at $DEST"

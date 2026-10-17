# Bundled embedding models

Files placed here are packaged into every installer as Tauri resources (see
`bundle.resources` in `tauri.conf.json`) and copied into the user's data dir on
first launch, so semantic search works fully offline from run one (see
`Core::provision_bundled_model` in `comail-core/src/lib.rs`).

## Before a release build

Fetch the default model, `bge-small-en-v1.5` (`embed::DEFAULT_MODEL`), from
Hugging Face:

```sh
dir=src-tauri/resources/models/bge-small-en-v1.5
mkdir -p "$dir"
for f in config.json tokenizer.json model.safetensors; do
  curl -fL -o "$dir/$f" "https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main/$f"
done
```

This puts `config.json`, `tokenizer.json`, and `model.safetensors` (about
90 MB) in `bge-small-en-v1.5/`. The weights are intentionally **not**
committed.

## Dev builds and CI

Builds that skip this step still work. The first time semantic search is
enabled, the background embed worker downloads the model on demand. The
other models in the registry (`all-MiniLM-L6-v2`, `bge-base-en-v1.5`, and the
multilingual `paraphrase-multilingual-MiniLM-L12-v2`) are always downloaded
this way when you pick them in Settings.

# Bundled embedding models

Files placed here are packaged into the `.deb` / AppImage as Tauri resources and
copied into the user's data dir on first launch, so semantic search works fully
offline from run one (see `Core::provision_bundled_model`).

Before a **release** build, fetch the default model:

```sh
./scripts/fetch-embedding-model.sh
```

This populates `bge-small-en-v1.5/{config.json,tokenizer.json,model.safetensors}`
(~90 MB). The weights are intentionally **not** committed.

Dev builds and CI that skip this step still work: the background embed worker
falls back to downloading the model on demand the first time semantic search is
enabled.

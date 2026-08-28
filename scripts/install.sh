#!/usr/bin/env bash
# local-ai-stack — univerzální installer
#
# Detekuje GPU, nastaví .env, deleguje na per-machine setup skript,
# expanduje WebUI URLs v services.yaml, spustí docker compose.
#
# Použití:
#   ./scripts/install.sh                  # default (auto-detect)
#   ./scripts/install.sh --no-build      # přeskočí docker build (pro testy)
#   ./scripts/install.sh --no-up         # nestartuje kontejnery
set -euo pipefail
cd "$(dirname "$0")/.."

NO_BUILD=0
NO_UP=0
for arg in "$@"; do
  case "$arg" in
    --no-build) NO_BUILD=1 ;;
    --no-up)    NO_UP=1 ;;
    *) echo "ERROR: neznámý argument '$arg'" >&2; exit 1 ;;
  esac
done

echo "=== local-ai-stack install ==="

# 1) Git submoduly
if [ ! -f .gitmodules ]; then
  echo "ERROR: musíš být v local-ai-stack rootu (.gitmodules chybí)" >&2
  exit 1
fi
git submodule update --init --recursive

# 2) .env (gitignored, per-machine)
if [ ! -f .env ]; then
  echo "  .env neexistuje, kopíruji .env.example"
  cp .env.example .env
fi

# 3) GPU detekce
command -v nvidia-smi &>/dev/null || { echo "ERROR: nvidia-smi chybí" >&2; exit 1; }
GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
echo "  GPU: $GPU_NAME"

case "$GPU_NAME" in
  *P40*)
    MACHINE_ID=aicore;   GPU_ARCH=61;   GGML_CUDA_ARCH=61
    CUDA_BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04
    TORCH_INDEX=cu124
    COMFYUI_EXTRA_ARGS="--use-pytorch-cross-attention --highvram"
    QWEN_MODEL_DEFAULT="/models/llama/Qwen3.8-27B-Q4_K_M.gguf"
    CTX_SIZE_DEFAULT=32768
    CACHE_TYPE_V_DEFAULT=q4_0
    MOSS_MULTI_GPU=0
    ;;
  *5060*)
    MACHINE_ID=aiworker; GPU_ARCH=120;  GGML_CUDA_ARCH=120
    CUDA_BASE=nvidia/cuda:13.0.3-runtime-ubuntu24.04
    TORCH_INDEX=cu130
    COMFYUI_EXTRA_ARGS="--use-pytorch-cross-attention --fast --bf16-unet"
    QWEN_MODEL_DEFAULT="/models/llama/Qwen3.8-27B-NVFP4-MTP-GGUF/Qwen3.8-27B-NVFP4-MTP-COMPACT-LOW.gguf"
    CTX_SIZE_DEFAULT=16384
    CACHE_TYPE_V_DEFAULT=q4_0
    MOSS_MULTI_GPU=1
    ;;
  *3070*)
    MACHINE_ID=desktop;  GPU_ARCH=86;   GGML_CUDA_ARCH=86
    CUDA_BASE=nvidia/cuda:12.4.1-runtime-ubuntu22.04
    TORCH_INDEX=cu124
    COMFYUI_EXTRA_ARGS="--use-pytorch-cross-attention --fast"
    QWEN_MODEL_DEFAULT="/models/llama/Qwen3.8-27B-IQ4_XS.gguf"
    CTX_SIZE_DEFAULT=32768
    CACHE_TYPE_V_DEFAULT=q4_0
    MOSS_MULTI_GPU=0
    ;;
  *6800*)
    MACHINE_ID=desktop;  GPU_ARCH=1030; GGML_CUDA_ARCH=1030
    CUDA_BASE=rocm/dev-ubuntu-22.04:6.2.4
    TORCH_INDEX=rocm6.2
    COMFYUI_EXTRA_ARGS="--use-pytorch-cross-attention --fast"
    QWEN_MODEL_DEFAULT="/models/llama/Qwen3.8-27B-IQ4_XS.gguf"
    CTX_SIZE_DEFAULT=32768
    CACHE_TYPE_V_DEFAULT=f16
    MOSS_MULTI_GPU=0
    ;;
  *) echo "ERROR: neznámá GPU: $GPU_NAME" >&2; exit 1 ;;
esac

echo "  Detekoval jsem: $MACHINE_ID (sm_$GPU_ARCH)"

# 4) Update .env (per-machine, neprepisuje existující overrides)
update_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    echo "${key}=${value}" >> .env
  fi
}

update_env MACHINE_ID "$MACHINE_ID"
update_env GPU_ARCH "$GPU_ARCH"
update_env GGML_CUDA_ARCH "$GGML_CUDA_ARCH"
update_env CUDA_BASE "$CUDA_BASE"
update_env TORCH_INDEX "$TORCH_INDEX"
update_env COMFYUI_EXTRA_ARGS "$COMFYUI_EXTRA_ARGS"
update_env MOSS_MULTI_GPU "$MOSS_MULTI_GPU"
if ! grep -q "^QWEN_MODEL=" .env; then
  update_env QWEN_MODEL "$QWEN_MODEL_DEFAULT"
fi
if ! grep -q "^CTX_SIZE=" .env; then
  update_env CTX_SIZE "$CTX_SIZE_DEFAULT"
fi
if ! grep -q "^CACHE_TYPE_V=" .env; then
  update_env CACHE_TYPE_V "$CACHE_TYPE_V_DEFAULT"
fi

# 5) NFS check
MODEL_DIR=$(grep ^MODEL_DIR .env | cut -d= -f2)
MODEL_DIR="${MODEL_DIR:-/mnt/models}"
if [ ! -d "$MODEL_DIR" ]; then
  echo "  WARN: $MODEL_DIR neexistuje, modely se nestáhnou"
fi

# 6) Stáhni modely (LLM) — přes submodule
echo "  Stahuji LLM modely do $MODEL_DIR/llama ..."
if [ -d "$MODEL_DIR/llama" ] || [ -d "$MODEL_DIR" ]; then
  cd local-ai-coding-servers
  MODEL_DIR="$MODEL_DIR" ./scripts/download-models.sh || echo "  WARN: download selhal (offline?)"
  cd ..
else
  echo "  SKIP: $MODEL_DIR/llama neexistuje"
fi

# 7) Per-machine setup (submodule skripty)
echo "  Spouštím per-machine setup ($MACHINE_ID)..."
case "$MACHINE_ID" in
  aicore)
    cd local-ai-coding-servers
    MODEL_DIR="$MODEL_DIR" ./scripts/setup-aicore.sh || echo "  WARN: setup-aicore.sh selhal"
    cd ..
    ;;
  aiworker)
    cd local-ai-coding-servers
    MODEL_DIR="$MODEL_DIR" ./scripts/setup-aiworker.sh || echo "  WARN: setup-aiworker.sh selhal"
    cd ..
    ;;
  desktop)
    cd local-ai-coding-servers
    MODEL_DIR="$MODEL_DIR" ./scripts/setup-desktop.sh || echo "  WARN: setup-desktop.sh selhal"
    cd ..
    ;;
  codebox)
    cd local-ai-coding-servers
    ./scripts/setup-codebox.sh || echo "  WARN: setup-codebox.sh selhal"
    cd ..
    ;;
esac

# 8) Docker compose build (pokud není --no-build)
if [ "$NO_BUILD" -eq 0 ]; then
  echo "  Docker compose build (může trvat 10-30 min poprvé)..."
  docker compose build 2>&1 | tail -20
else
  echo "  --no-build, skip Docker build"
fi

# 9) Docker compose up (pokud není --no-up)
if [ "$NO_UP" -eq 0 ]; then
  echo "  Docker compose up -d (profil: $MACHINE_ID)..."
  docker compose --profile "$MACHINE_ID" up -d
else
  echo "  --no-up, skip Docker compose up"
fi

echo ""
echo "=== Hotovo ==="
echo "  Stroj: $MACHINE_ID ($GPU_NAME)"
echo "  Hub-UI:  http://localhost:8288"
echo "  ComfyUI: http://localhost:8188 (API), http://localhost:8189 (WebUI)"
echo "  Qwen:    http://localhost:8080"
echo "  Agent:   http://localhost:8199/capabilities"

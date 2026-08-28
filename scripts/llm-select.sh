#!/usr/bin/env bash
# llm-select.sh — vybere LLM model z registru pro daný stroj.
#
# Logika (v tomto pořadí):
#   1. QWEN_MODEL_ID env → model ID z registru (operátor override)
#   2. GPU architektura → modely s matching gpu_archs
#   3. VRAM stroje (nvidia-smi memory.total) → modely s vram_mb <= free_vram
#   4. Existence souboru na NFS → jen modely které reálně existují
#   5. Vrátí: QWEN_MODEL, CTX_SIZE, CACHE_TYPE_K, CACHE_TYPE_V, SPEC_TYPE, QWEN_MODEL_ID
#
# Použití:
#   QWEN_MODEL_ID=qwen3.8-ud-iq4xs ./scripts/llm-select.sh   # operátor override
#   ./scripts/llm-select.sh                                   # auto (první match)
#   LLM_REGISTRY=/path/to/llm_registry.json ./scripts/llm-select.sh
#   MODEL_DIR=/mnt/models ./scripts/llm-select.sh
set -euo pipefail
cd "$(dirname "$0")/.."

REGISTRY="${LLM_REGISTRY:-llm_registry.json}"
MODEL_DIR="${MODEL_DIR:-/mnt/models}"

command -v nvidia-smi >/dev/null 2>&1 || { echo "ERROR: nvidia-smi chybí" >&2; exit 1; }
GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)"
VRAM_MB="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader | head -1 | grep -o '[0-9]*' || echo 8192)"

case "$GPU_NAME" in
  *P40*)   ARCH=pascal ;;
  *5060*)  ARCH=blackwell ;;
  *3070*)  ARCH=ampere ;;
  *6800*)  ARCH=rocm ;;
  *) echo "ERROR: neznámá GPU: $GPU_NAME" >&2; exit 1 ;;
esac

python3 - "$REGISTRY" "$ARCH" "$VRAM_MB" "$MODEL_DIR" "${QWEN_MODEL_ID:-}" <<'PY'
import json, sys, os
registry, arch, vram_mb, model_dir, override_id = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]

try:
    data = json.load(open(registry))
except (OSError, json.JSONDecodeError) as e:
    print(f"ERROR: nelze načíst registry {registry}: {e}", file=sys.stderr)
    sys.exit(1)

models = data.get("models", [])

# Operátor override — přesné ID
if override_id:
    matches = [m for m in models if m.get("id") == override_id]
    if not matches:
        print(f"ERROR: model ID '{override_id}' není v registru. "
              f"Dostupné: {', '.join(m['id'] for m in models)}", file=sys.stderr)
        sys.exit(1)
    m = matches[0]
else:
    # Auto: arch + vram + existence na NFS
    candidates = []
    for m in models:
        if not m.get("enabled", True):
            continue
        if arch not in m.get("gpu_archs", []):
            continue
        if m.get("vram_mb", 999999) > vram_mb:
            continue
        # Existence na NFS — path je /models/llama/..., MODEL_DIR je /mnt/models
        rel = m["path"].replace("/models", "", 1)
        if not os.path.exists(model_dir.rstrip("/") + rel):
            continue
        candidates.append(m)
    if not candidates:
        print(f"ERROR: žádný model neodpovídá (arch={arch}, VRAM={vram_mb} MB, "
              f"dir={model_dir}). Zkontroluj llm_registry.json a NFS mount.", file=sys.stderr)
        sys.exit(1)
    # Preference: priority (nízká = preferovaná), fallback největší VRAM
    candidates.sort(key=lambda x: (x.get("priority", 999), -x.get("vram_mb", 0)))
    m = candidates[0]

# Výstup pro eval v install.sh
print(f"QWEN_MODEL={m['path']}")
print(f"QWEN_MODEL_ID={m['id']}")
print(f"CTX_SIZE={m.get('ctx', 32768)}")
print(f"CACHE_TYPE_K={m.get('cache_type_k', 'f16')}")
print(f"CACHE_TYPE_V={m.get('cache_type_v', 'q4_0')}")
print(f"SPEC_TYPE={m.get('spec_type') or ''}")
print(f"SPEC_DRAFT_N_MAX={m.get('spec_draft_n_max', 3)}")
PY

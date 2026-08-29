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

# GPU detekce — stejná logika jako install.sh: nvidia-smi → rocm-smi → lspci
# → /sys/class/drm. Na AMD strojích bez ROCm userspace musíme umět fallback.
GPU_NAME=""
VRAM_MB=0

# 1) nvidia-smi
if [ -z "$GPU_NAME" ] && command -v nvidia-smi >/dev/null 2>&1; then
  _nv="$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || true)"
  if [ -n "$_nv" ] && ! echo "$_nv" | grep -qiE "couldn.t communicate|has failed|NVIDIA-SMI has failed"; then
    GPU_NAME="$_nv"
    _vram_raw="$(nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null | head -1 || true)"
    VRAM_MB="$(echo "$_vram_raw" | grep -oE '[0-9]+' | head -1 || echo 0)"
  fi
  unset _nv _vram_raw
fi

# 2) rocm-smi
if [ -z "$GPU_NAME" ] && command -v rocm-smi >/dev/null 2>&1; then
  _rc="$(rocm-smi --showproductname 2>/dev/null | grep -E 'Card Series|Card Model|^\s*[0-9]+:' | head -1 || true)"
  if [ -n "$_rc" ]; then
    GPU_NAME="$(echo "$_rc" | sed -E 's/^[[:space:]]*[0-9]+:[[:space:]]*//; s/^Card (Series|Model):[[:space:]]*//')"
    _vram_raw="$(rocm-smi --showmeminfo vram 2>/dev/null | grep -E 'Total Memory' | awk '{print $4}' | head -1 || true)"
    VRAM_MB="$(echo "$_vram_raw" | grep -oE '[0-9]+' | head -1 || echo 0)"
  fi
  unset _rc _vram_raw
fi

# 3) lspci (jen název karty; VRAM neznáme)
if [ -z "$GPU_NAME" ] && command -v lspci >/dev/null 2>&1; then
  _lspci="$(lspci 2>/dev/null | grep -iE 'vga|3d|display' | head -1 || true)"
  if [ -n "$_lspci" ]; then
    GPU_NAME="$(echo "$_lspci" | sed -E 's/^[^:]+:[[:space:]]*//')"
  fi
  unset _lspci
fi

# 4) /sys/class/drm — vendor 0x1002 = AMD, 0x10de = NVIDIA. Device ID →
# marketing name + typický VRAM (heuristika, ne dokonalé).
if [ -z "$GPU_NAME" ]; then
  for card in /sys/class/drm/card[0-9]*/device; do
    [ -r "$card/vendor" ] || continue
    _vendor="$(cat "$card/vendor" 2>/dev/null || true)"
    case "$_vendor" in
      0x1002)
        _device="$(cat "$card/device" 2>/dev/null || true)"
        case "$_device" in
          0x73bf|0x73bf[0-9a-f]) GPU_NAME="Radeon RX 6800/6800 XT / 6900 XT (Navi 21)"; VRAM_MB=16384 ;;
          0x73df|0x73df[0-9a-f]) GPU_NAME="Radeon RX 6700/6700 XT (Navi 22)";        VRAM_MB=12288 ;;
          0x73ff|0x73ff[0-9a-f]) GPU_NAME="Radeon RX 6600/6600 XT (Navi 23)";        VRAM_MB=8192  ;;
          0x744c|0x744c[0-9a-f]) GPU_NAME="Radeon RX 7900 XTX (Navi 31)";            VRAM_MB=24576 ;;
          0x745e|0x745e[0-9a-f]) GPU_NAME="Radeon RX 7900 XT (Navi 32)";             VRAM_MB=20480 ;;
          0x7480|0x7480[0-9a-f]) GPU_NAME="Radeon RX 7600 (Navi 33)";                VRAM_MB=8192  ;;
          *)                      GPU_NAME="AMD Radeon";                              VRAM_MB=8192  ;;
        esac
        break
        ;;
      0x10de)
        GPU_NAME="NVIDIA GPU"
        break
        ;;
    esac
  done
fi

if [ -z "$GPU_NAME" ]; then
  echo "ERROR: žádná GPU detekována (zkoušel jsem nvidia-smi, rocm-smi, lspci, /sys/class/drm)" >&2
  exit 1
fi

if [ "$VRAM_MB" -eq 0 ]; then
  echo "WARN: VRAM nezjištěna, defaultuji na 8192 MB (8 GB)" >&2
  VRAM_MB=8192
fi

# Map GPU name → arch pro registry lookup
case "$GPU_NAME" in
  *P40*)   ARCH=pascal ;;
  *5060*)  ARCH=blackwell ;;
  *3070*)  ARCH=ampere ;;
  *6800*|*6900*|*6700*|*6600*|*7900*|*Navi*|*Radeon*) ARCH=rocm ;;
  *NVIDIA*|*GeForce*|*RTX*) ARCH=cuda ;;
  *)
    echo "ERROR: neznámá GPU architektura: '$GPU_NAME'" >&2
    echo "  Podporované: P40 (pascal), 5060 (blackwell), 3070 (ampere), 6800/6900/7900 (rocm)" >&2
    exit 1
    ;;
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

# local-ai-stack

Master repo s **hub-ui** + **service router** pro 5 typů AI služeb:
LLM, IMG, TTS, STT, VIDEO. Orchestrace nad `comfyui-unified` +
`local-ai-coding-servers` (oba jako git submoduly, **beze změn**).

## Quick start

```bash
git clone --recurse-submodules https://github.com/ystrem/local-ai-stack.git
cd local-ai-stack
cp .env.example .env
./scripts/install.sh
# Hub-UI:  http://localhost:8288
```

Skript:
1. Detekuje GPU (`nvidia-smi`) a nastaví `.env` pro danou architekturu
2. Stáhne modely (LLM) přes `download-models.sh` ze submoduleu
3. Sestaví Docker images (build context = submodule)
4. Spustí `docker compose up -d` (default profil = tvůj stroj)
5. Expanduje `{machine_ip}` v `services.yaml` → WebUI URLs

## Stroje

| Stroj | GPU | Defaultní služby | WebUI |
|---|---|---|---|
| aicore (P40 Pascal sm_61) | 1× P40 24GB | comfyui (IMG+TTS+VIDEO), qwen (LLM), hub-agent | ComfyUI @ :8189, llama-ui @ :8085 |
| aiworker (Blackwell sm_120) | 2× 5060 Ti 16GB | + ornith (LLM), qwen-split profil, ollama | + llama-ui ornitha @ :8086 |
| desktop (3070 Ampere / 6800XT ROCm) | 1× | + ollama | llama-ui @ :8085 |
| codebox (notebook) | CPU | coding agents (OpenCode + Pi) | — |

## Service routing (5 typů)

| Kind | Engine | Kde běží | Fallback | WebUI |
|---|---|---|---|---|
| LLM | llama.cpp (qwen, ornith) | aiworker > aicore | ollama | llama-ui (SvelteKit) @ :8085 |
| IMG | ComfyUI (flux2-klein, qwen-image, ...) | aicore > aiworker | desktop | ComfyUI vestavěný @ :8189 |
| TTS | MOSS-TTS v1.5, qwen3-tts | aicore > aiworker | edge-tts | (žádný standalone UI) |
| STT | faster-whisper large-v3 | aicore | — | OpenAI-compat Swagger @ :5007/docs |
| VIDEO | ComfyUI (Sana, Anima, img2vid) | aicore > aiworker | — | ComfyUI WebUI @ :8189 (sdílený s IMG) |

Hub-UI AUTO režim: desired → assignment → auto-start → forward.
MANUAL: fail loud 503.

## Per-machine příkazy

```bash
# Default (vše pro daný stroj)
docker compose --profile aicore up -d

# Konkrétní služba
docker compose --profile aiworker up -d qwen ornith

# Volitelný split-mode (Qwen přes obě GPU)
docker compose --profile aiworker --profile split up -d qwen-split
```

## WebUI discovery

Každá služba může mít vlastní WebUI. Hub-UI master **compile-time** definuje
`webui: {url, label, icon, type}` v `hub-agent/services.yaml` a **runtime**
ověřuje přes `GET /capabilities`. Všechna WebUI se **automaticky zobrazí v
navigaci** Hub-UI v novém tabu — operátor neřeší URL ručně.

`{machine_ip}` se expanduje z `machines.yaml` při `install.sh`. Výsledek
se uloží do `hub-agent/services.yaml` jako `webui.expanded_urls` pro všechny
stroje v clusteru.

**Příklad discovery výstupu v Hub-UI:**

```
🖥️  Hub-UI @ aicore          → http://192.168.10.60:8288
🤖  Qwen UI @ aiworker        → http://192.168.10.194:8085
🎨  ComfyUI Workflows @ aicore → http://192.168.10.60:8189
📝  faster-whisper API @ aicore → http://192.168.10.60:5007/docs
🎬  ComfyUI Workflows @ aicore → http://192.168.10.60:8189 (shared)
```

## Modely

Žádné v repa. Vše na `/mnt/models` (NFS sdílené mezi aicore/aiworker/desktop).
**Modely se nikdy nestahují lokálně** — jen na NFS, pak je mají všechny stroje.

### LLM modely (registry)

Katalog všech LLM modelů je v `llm_registry.json` (analogie k
`comfyui-unified/model_registry.json` pro IMG). Install automaticky vybere
nejpreferovanější model který:
1. Podporuje GPU architekturu stroje (`gpu_archs`)
2. Vejde se do VRAM stroje (`vram_mb`)
3. Existuje na NFS

```bash
# Auto-výběr (při install)
./scripts/llm-select.sh

# Operátor override (model ID z registru)
QWEN_MODEL_ID=qwen3.8-ud-iq4xs ./scripts/llm-select.sh
QWEN_MODEL_ID=ornith-a3b-iq3 ./scripts/install.sh   # použít MoE

# Jaké modely jsou v registru
python3 -c "import json; [print(m['id'], '-', m['name']) for m in json.load(open('llm_registry.json'))['models']]"
```

### IMG modely (ComfyUI registry)

Katalog v `comfyui-unified/model_registry.json` — 21 modelů (TTS + IMG + video).

## Submoduly

- `ystrem/comfyui-unified` (branch: master) — IMG/TTS engine
- `ystrem/local-ai-coding-servers` (branch: main) — LLM multi-arch
- **Master `local-ai-stack` se nezasahuje do submoduleů** — jen orchestruje
- Aktualizace submoduleu: `git submodule update --remote <name>`

## Reference

- comfyui-unified: https://github.com/ystrem/comfyui-unified
- local-ai-coding-servers: https://github.com/ystrem/local-ai-coding-servers
- Plán: `.commandcode/plans/local-ai-stack-merge.md`

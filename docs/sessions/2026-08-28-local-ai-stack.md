# Session 2026-08-28 — local-ai-stack setup (kompletní den)

> **Stav:** ✅ Master repo `ystrem/local-ai-stack` plně funkční na aicore + aiworker.
> ✅ IMG generování funguje (HTTP 200, PNG 512×512). ✅ LLM běží (qwen na GPU 0).
> ✅ WebUI discovery funguje. ✅ Modely výhradně z NFS. 30+ commitů.

---

## Co se dnes udělalo (chronologicky)

### 1. Content-factory image gen (původní cíl)
- `pipelines/shared/image_gen.py` + `pipelines/reddit-story/image.py` — univerzální
  image gen přes ComfyUI `/generate` (kind=image), NSFW guard, safelist
- GHA `reddit-story-shorts.yml` — step Generate image, inputs.image_model
- Testováno na aiworkeru — PNG 832×1472, determinismus, Telegram odeslání

### 2. local-ai-stack master repo (nový)
- Orchestrace nad `comfyui-unified` + `local-ai-coding-servers` (submoduly)
- Hub-UI (FastAPI + SPA, port 8288) — 5 service tabs (LLM/IMG/TTS/STT/VIDEO)
- Service router — `/api/proxy/{kind}/generate` pro 5 typů
- WebUI discovery — compile-time (services.yaml) + runtime (HEAD/GET probe)
- install.sh — auto-detect GPU, IP, generuje .env + machines.yaml

### 3. Porty (kolize fix)
- qwen: 8080 → **8085** (qbittorrent držel 8080 na aicore)
- ornith: 8081 → **8086** (filebrowser držel 8081)
- qwen-split: 8082 → **8087** (rezervováno)
- ornith-split: 8083 → **8088** (rezervováno)

### 4. GPU rozdělení (OOM fix)
- aiworker (2× 5060 Ti): qwen → GPU 0, comfyui → **GPU 1** (`COMFYUI_GPU_ID=1`)
- aicore/desktop (1× GPU): oba → GPU 0 (on-demand střídání)
- Před fixem: qwen (15 GB) + comfyui (14 GB) na GPU 0 → OOM
  (`[ERROR] Got an OOM, unloading all loaded models`)

### 5. LLM model registry
- `llm_registry.json` — 10 modelů na NFS (analogie model_registry.json pro IMG)
- `scripts/llm-select.sh` — výběr: QWEN_MODEL_ID override → GPU arch → VRAM → NFS existence → priority
- install.sh — žádné hardcoded modely, vše z registru

### 6. Modely VŽDY z NFS
- `/mnt/models` je jediné úložiště modelů (sdílené přes síť)
- Žádný lokální download — download-models.sh default `/mnt/models` root
- NFS skip: `⏭ Qwen3.8-27B-UD-IQ4_XS.gguf už existuje — přeskočeno`

---

## Aktuální stav (konec dne)

### AIWORKER (192.168.10.194, 2× 5060 Ti)
| Služba | Port | GPU | Status |
|---|---|---|---|
| comfyui-aiworker | 8188/8189 | GPU 1 | ✅ healthy, IMG gen funguje |
| qwen-aiworker | 8085 | GPU 0 | ✅ běží (NVFP4, 15 GB) |
| hub-ui-aiworker | 8288 | — | ✅ healthy |
| hub-agent-aiworker | 8199 | — | ✅ healthy |

### AICORE (192.168.10.60, P40)
| Služba | Port | GPU | Status |
|---|---|---|---|
| comfyui-aicore | 8188/8189 | GPU 0 | ✅ healthy (14 modelů) |
| qwen-aicore | 8085 | GPU 0 | ✅ běží (Q4_K_M, loaduje) |
| hub-ui-aicore | 8288 | — | ✅ healthy |
| hub-agent-aicore | 8199 | — | ✅ healthy |
| stt-service (externí) | 5007 | GPU 0 | ✅ běží (faster-whisper) |

### Master repo (github.com/ystrem/local-ai-stack)
- 30+ commitů, HEAD = `50405b2` (GPU split fix)
- Submoduly: comfyui-unified @ 140fa51, local-ai-coding-servers @ f4510c5

---

## Klíčové lekce

1. **force-recreate je povinný** — mountnuté soubory (server.py) se bez
   `--force-recreate` nenačtou do běžícího kontejneru. install.sh ho teď dělá.
2. **Modely VŽDY z NFS** — žádný lokální download, NFS je jediný zdroj pravdy.
3. **Žádné hardcoded modely** — LLM má registry (llm_registry.json) stejně jako IMG.
4. **GPU rozdělení per stroj** — aiworker: qwen GPU 0 + comfyui GPU 1; aicore: on-demand.
5. **Porty musí být unikátní per stroj** — 8080/8081 kolize s qbittorrent/filebrowser.
6. **Submodule ref musí být github-dostupný** — lokální commity (gitea) rozbijí `git clone`.

---

## Testy pro ověření

```bash
# IMG generování (aiworker, GPU 1)
curl -X POST http://localhost:8188/generate \
  -H 'Content-Type: application/json' \
  -d '{"model":"flux2-klein-q6k","prompt":"test image","seed":42,"width":512,"height":512}' \
  -o /tmp/test.png
# → HTTP 200, PNG 512×512

# LLM (aiworker/aicore, port 8085)
curl http://localhost:8085/health

# WebUI discovery
curl http://localhost:8288/api/webui/registry | python3 -m json.tool

# Hub-UI
curl http://localhost:8288/api/health
```

---

## Reference

- Plány: `.commandcode/plans/local-ai-stack-merge.md`, `.commandcode/plans/llm-model-registry.md`
- TODO: `docs/TODO.md`
- Test IMG gen: HTTP 200, PNG 512×512 (286 KB), seed=42, flux2-klein-q6k
- Content-factory: `pipelines/reddit-story/image.py` + `docs/sessions/2026-08-28-image-gen.md`

# Session 2026-08-28 — local-ai-stack setup

> **Stav:** ✅ Master repo `ystrem/local-ai-stack` pushnuto (16 commitů).
> End-to-end test na aiworkeru prošel — `/api/webui/registry` vrací plný JSON
> s compile-time + runtime WebUI discovery. aicore test čeká na SSH přístup.

---

## Cíl dnešní session

Master repo s **hub-ui** + **service router** pro 5 typů AI služeb
(LLM, IMG, TTS, STT, VIDEO) nad `comfyui-unified` + `local-ai-coding-servers`
(oba jako git submoduly, **beze změn**). Hub-UI master řídí přepínací logiku,
oba enginová repa poskytují služby.

---

## Výsledek

### Commity (master `ystrem/local-ai-stack`)

| SHA | Zpráva |
|---|---|
| `5ef466a` | init: submoduly |
| `d068149` | docs: README, ARCHITECTURE, .env.example, .gitignore |
| `619eb50` | feat: docker-compose master orchestrace |
| `b16eeb6` | feat: hub-agent services + toggles (s WebUI registry) |
| `8fb50f2` | feat: scripts/install.sh |
| `6eb3f27` | feat: hub-ui/backend (router + WebUI discovery) |
| `a48a237` | feat: hub-ui/frontend (STT/VIDEO/LLM tabs + WebUI nav) |
| `5d68e5d` | feat: hub-ui/machines registry |
| `4eeb263` | chore: bump comfyui-unified submodule |
| `bd2c19d` | fix: app.py router imports + COMFYUI_HOST env |
| `d0cd507` | fix: python-multipart pro STT UploadFile |
| `8b37d21` | fix: explicit env_file v docker-compose |
| `db3a972` | fix: mount services.yaml do kontejneru |
| `ed67e34` | fix: services.yaml path default |
| `2d73465` | fix: HUB_SERVICES_FILE env override |
| `f3b48f4` | fix: sloučení environment bloků |

### Commity (submodule `comfyui-unified`)

| SHA | Zpráva |
|---|---|
| `140fa51` | refactor: smazán api-wrapper/ + webapp/ (přesunuto do local-ai-stack) |

---

## End-to-end test (aiworker, RTX 5060 Ti)

Vše 4 nové kontejnery běží:

| Služba | Port | Status |
|---|---|---|
| `comfyui-aiworker` | 8188, 8189 | ✅ running, healthy |
| `qwen-aiworker` | 8080 | ✅ running, health: starting |
| `hub-agent-aiworker` | 8199 | ✅ running, capabilities OK |
| `hub-ui-aiworker` | 8288 | ✅ running, healthy |

### Klíčové endpointy

**`GET /api/health`** (200 OK):
```json
{
  "service_status": "ok",
  "model_loaded": true,
  "gpu": {"name": "NVIDIA GeForce RTX 5060 Ti", "vram_total_mb": 16311},
  "image_models": ["flux-dev-nvfp4", "flux2-klein-q6k", ..., "anima-base-native", ...],
  "tts_models": ["moss-tts-v1.5", "moss-voicegenerator", "qwen3-tts-1.7b-customvoice"]
}
```

**`GET /api/webui/registry`** (compile-time + runtime WebUI discovery):

Vrací JSON pole s WebUI pro každý stroj. Příklad:
```json
[
  {"id": "comfyui", "machine": "aicore", "type": "img",
   "url": "http://192.168.10.60:8189", "label": "ComfyUI Workflows",
   "icon": "🎨", "ui_type": "native", "running": true},
  {"id": "stt-service", "machine": "aicore", "type": "stt",
   "url": "http://192.168.10.60:5007/docs", "label": "faster-whisper API",
   "icon": "📝", "ui_type": "swagger", "running": true},
  {"id": "comfyui-video", "machine": "aiworker", "type": "video",
   "url": "http://192.168.10.194:8189", "label": "ComfyUI Workflows",
   "icon": "🎬", "ui_type": "native", "running": true,
   "shared_with": "comfyui"}
]
```

WebUI discovery funguje:
- Compile-time: `services.yaml` s `webui: {url, label, icon, type, path}` + `{machine_ip}` templating
- Runtime: HEAD/GET ping každého URL, `running: true/false` podle odpovědi
- Cache: 30s TTL

---

## Bugy opravené během testu

| # | Problém | Fix |
|---|---|---|
| 1 | app.py neměl include_router pro stt/video/llm/webui | přidány importy + 4 router includes |
| 2 | `os.environ.get("COMFYUI_UNIFIED_URL", "http://comfyui-unified:8188")` — hardcoded špatné jméno | env overridable + `COMFYUI_HOST=comfyui-${MACHINE_ID}` |
| 3 | STT UploadFile vyžaduje python-multipart | přidáno do requirements.txt |
| 4 | Docker Compose 5.4.0 na některých systémech nenačítá `.env` automaticky | explicitní `env_file: - .env` + `x-common-env` anchor |
| 5 | `services.yaml` mountnutý do `/app/hub-agent/services.yaml`, ale code hledal relativní `hub-agent/services.yaml` | mount + default path opraven |
| 6 | `HUB_SERVICES_FILE` env nenastaveno | explicitní env override |
| 7 | Duplicitní `environment:` blok v docker-compose.yml (YAML parse error) | sloučeno do jednoho bloku |

---

## CACHE_TYPE_K=f16 (P40) — opakované upozornění

V `docker-compose.yml` (master orchestrace) je v qwen příkazu hardcoded:
```yaml
- "--cache-type-k"
- "f16"  # P40: f16 POVINNOST (q4_0 → garbage, benchmark 19.8.2026)
```

`q4_0` K-cache na P40 generuje **prázdný `content` (garbage output)** —
benchmark 19.8.2026 v `local-ai-coding-servers/docs/benchmark-2xp40-dflash2-mtp-2026-08-19.md`.
`f16` není o rychlosti, je o **korektnosti**. KEEP IT f16.

---

## Známé bugy a TODO v `local-ai-stack`

| Issue | Stav | Workaround |
|---|---|---|
| `install.sh` negeneruje `machines.yaml` | TODO | ručně `cp machines.example.yaml machines.yaml` + `sed` env |
| SSH z aiworkeru na aicore nefunguje | není bug | operátor musí běžet `install.sh` lokálně na aicore |
| `hub-agent` capabilities nezahrnují `webui` field | TODO | přidat do `comfyui-unified/hub-agent/main.py` |
| `--no-build` a `--no-up` flagy v `install.sh` testovány | OK | fungují |

---

## Reference

- Plán: `.commandcode/plans/local-ai-stack-merge.md` (19 sekcí, schválený)
- Submoduly: `comfyui-unified` (master), `local-ai-coding-servers` (main)
- Test: `/home/hermes/local-ai-stack-test/` (lze smazat)
- Hub-UI port: 8288
- Hub-agent port: 8199
- ComfyUI porty: 8188 (API), 8189 (WebUI)
- Qwen port: 8080
- STT port: 5007

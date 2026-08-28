# TODO — local-ai-stack follow-up úkoly

> **Kontext:** Master `local-ai-stack` je postavený a end-to-end test prošel na
> aiworkeru (viz `docs/sessions/2026-08-28-local-ai-stack.md`). aicore test
> čeká na SSH přístup. Níže jsou follow-up úkoly, které **nebyly** v scope
> plánu, ale je potřeba je udělat.

---

## 🚨 P0 — Blokuje produkci

### [ ] aicore end-to-end test
- **Co:** Spustit `./scripts/install.sh` + `docker compose --profile aicore up -d` na aicore
- **Proč:** Ověřit že celý stack funguje i na P40 (jiné GPU arch, jiné cache rules)
- **Blokátor:** SSH přístup z aiworkeru na aicore (`Permission denied`) — operátor musí běžet `install.sh` lokálně na aicore
- **Acceptance:** `curl http://aicore:8288/api/health` vrací 200, `/api/webui/registry` vrací ≥ 5 WebUI discovery záznamů

### [ ] CACHE_TYPE_K=f16 validace na aicore
- **Co:** Po rozjetí na aicore ověřit `docker exec qwen-aicore ... --cache-type-k` vrací f16
- **Proč:** q4_0 K-cache na P40 generuje garbage (benchmark 19.8.2026), tento fix chrání proti regresi
- **Acceptance:** `qwen-aicore` běží, output TTS/text nejsou prázdné

---

## 🔧 P1 — Opravy zjištěné během testu

### [ ] `install.sh` generuje `machines.yaml` automaticky
- **Status:** ✅ Hotovo (commit `install.sh` 28.8. — krok 7b)
- **Co:** Po `cp .env.example .env` + `./scripts/install.sh` se `hub-ui/machines.yaml` vygeneruje z `machines.example.yaml` s env substitucí (AICORE_HOST, AIWORKER_HOST, DESKTOP_HOST)
- **Test:** Na čistém stroji ověřit že `hub-ui/machines.yaml` existuje po install

### [ ] `hub-agent` capabilities hlásí `webui` pole
- **Co:** Přidat do `comfyui-unified/hub-agent/main.py` (`_get_service_webui()`) — v `services.yaml` se služby definují s `webui:`, ale agent to nepropaguje do `/capabilities`
- **Proč:** Master `webui_registry.py` čte `services.yaml` přímo (compile-time), ale `hub-agent` by měl totéž dělat runtime — single source of truth
- **Acceptance:** `curl :8199/capabilities` vrací `services[].webui` pro každou službu
- **Scope:** submodule `comfyui-unified`, ne master `local-ai-stack`

### [ ] `webui_registry.py` — fallback na `hub-agent` capabilities
- **Co:** Když `services.yaml` není namountován (mount selhal), fallback na runtime probe `hub-agent` per-stroj
- **Proč:** Dnes `[]` pokud mount chybí — robustnější by bylo fallback na `/capabilities`
- **Scope:** master `local-ai-stack`, `hub-ui/backend/webui_registry.py`

---

## 🎯 P2 — Scope plánu, follow-up

### [ ] STT streaming (Whisper live)
- **Co:** Nahradit batch `UploadFile` za streaming WebSocket endpoint
- **Proč:** Real-time STT pro live přepis mluveného slova (užitečné pro kodeš podcastů)
- **Reference:** `pipelines/shared/karaoke.py:44-45` očekává STT na `http://aicore:5007/v1/audio/transcriptions` — aktuálně batch, chceme streaming
- **Scope:** `hub-ui/backend/stt.py` + `faster-whisper-server` konfigurace

### [ ] Voice cloning UI v Hub-UI
- **Co:** Přidat voice design + voice clone (MOSS VoiceGenerator) do Hub-UI
- **Proč:** Dnes se voice design dělá přes curl/CLI, ne přes UI
- **Reference:** `pipelines/shared/tts.py:MOSS_VOICE_REF` — MOSS-TTS v1.5 podporuje voice design
- **Scope:** master `local-ai-stack`, `hub-ui/frontend/src/tabs/voice.js` (nový)

### [ ] Per-machine GPU heatmap
- **Co:** Real-time `nvidia-smi` polling pro každý stroj v clusteru, vizualizace v cluster dashboardu
- **Proč:** Operátor potřebuje vidět vytížení GPU pro plánování (kde spustit ornitha, kde comfyui)
- **Scope:** master `local-ai-stack`, `hub-ui/frontend/src/cluster.js`

### [ ] Content-factory integrace
- **Co:** Přidat `local-ai-stack` jako volitelný backend pro content-factory GHA workflows
- **Proč:** Dnes content-factory volá `localhost:8188` přímo, měl by routovat přes Hub-UI service router
- **Reference:** `content-factory/.github/workflows/reddit-story-shorts.yml` — `inputs.target_machine` (aicore/aiworker) je plánovaný
- **Scope:** `ystrem/content-factory` repo, `pipelines/reddit-story/image.py`

### [ ] Auto-failover (AUTO režim detection)
- **Co:** Hub-agent pravidelně testuje služby a při selhání přehodí na fallback
- **Proč:** Dnes AUTO režim auto-startuje, ale ne auto-detekuje runtime failure
- **Scope:** `comfyui-unified/hub-agent/main.py` + `hub-ui/backend/hub.py`

### [ ] Load balancing napříč stroji
- **Co:** Round-robin / least-loaded mezi primary a fallback stroji
- **Proč:** Dnes každý kind má jen primary → fallback (failover), ne LB
- **Scope:** master `local-ai-stack`, `hub-ui/backend/services.py`

### [ ] CI/CD pro local-ai-stack
- **Co:** GitHub Actions: lint (ruff), test (pytest), build (docker compose config check)
- **Proč:** Dnes CI chybí, plán sekce 12 to vyžaduje jako "follow-up"
- **Reference:** `.github/workflows/ci.yml` podle vzoru v `content-factory`

---

## 🌟 P3 — Rozšíření

### [ ] Observability stack (Prometheus + Grafana)
- **Co:** GPU monitoring, request latency, error rate, service health dashboard
- **Proč:** Operátor potřebuje vidět stav clusteru, ne jen kontrolovat jednotlivé porty
- **Scope:** nový `monitoring/` adresář s `docker-compose.monitoring.yml`

### [ ] Multi-host NFS (DRBD, GlusterFS)
- **Co:** Aktuálně `/mnt/models` je single-host NFS (aicore exportuje, aiworker mountuje). DRBD/GFS = redundantní storage
- **Proč:** Single point of failure (aicore spadne → ztráta modelů)
- **Scope:** infrastruktura, ne `local-ai-stack` kód

### [ ] Image registry pro submoduly
- **Co:** Místo `docker build` z gitu (pomalé), push images do GHCR, `docker compose pull`
- **Proč:** Rychlejší start, CI/CD-friendly
- **Scope:** CI/CD pipeline (viz P2)

### [ ] Voice cloning UI v Hub-UI (MOSS VoiceGenerator)
- **Co:** Přidat `voice_design` step — textový popis hlasu + reference audio upload
- **Proč:** MOSS-TTS v1.5 podporuje voice design a cloning, ale dnes se to dělá manuálně
- **Reference:** `comfyui-unified/model_registry.json` — moss-voicegenerator service
- **Scope:** master `local-ai-stack`, nový tab

### [ ] Per-user audio streaming (WebSocket TTS)
- **Co:** Místo HTTP request/response, WebSocket pro live TTS streaming
- **Proč:** Real-time TTS pro interaktivní aplikace
- **Scope:** `hub-ui/backend/proxy.py` — nový WebSocket router

### [ ] Real-time ComfyUI progress (WebSocket)
- **Co:** Hub-UI zobrazuje progress bar s aktuálním krokem (sampling, VAE decode) v reálném čase
- **Proč:** Dnes se progress zobrazuje jen v ComfyUI WebUI, ne v Hub-UI
- **Reference:** `comfyui-unified/server.py:685` — `ws_url = COMFYUI_URL + "/ws?clientId=..."`
- **Scope:** master `local-ai-stack`, `hub-ui/frontend/`

---

## 📦 P4 — Provoz a dokumentace

### [ ] Cloudflare tunnel pro vzdálený přístup
- **Co:** Tunnel `local-ai-stack` přes Cloudflare pro vzdálený přístup mimo LAN
- **Proč:** Dnes LAN only, plán sekce 12 to nedoporučuje (single user, security)
- **Scope:** nový `cloudflared` Docker service + DNS

### [ ] Multi-tenant auth
- **Co:** OAuth/SSO pro Hub-UI, per-user rate limiting
- **Proč:** Dnes single user (LAN), ale po Cloudflare tunnel to nestačí
- **Scope:** `hub-ui/backend/` + `comfyui-unified/api-wrapper/`

### [ ] Operátorský runbook
- **Co:** Markdown dokument — jak rozjet, jak debugovat, jak rollback
- **Proč:** Dnes chybí, všechno je v plánu ale plán je implementační, ne provozní
- **Scope:** `docs/OPERATIONS.md` v masteru

### [ ] Smoke test script
- **Co:** `scripts/smoke-test.sh` — projde všechny endpointy, ověří že vše běží
- **Proč:** Dnes ověřujeme manuálně přes curl, chtěli bychom jeden příkaz
- **Scope:** master `local-ai-stack`, `scripts/`

---

## ✅ Hotovo (28.8.2026)

- [x] Master `ystrem/local-ai-stack` pushnut s 16 commity
- [x] Oba submoduly (`comfyui-unified`, `local-ai-coding-servers`) jako git submoduly
- [x] `api-wrapper/` a `webapp/` smazány ze `comfyui-unified` (přesunuto do masteru)
- [x] `hub-ui/backend/` s 5 service routery (proxy, stt, video, llm, webui_registry)
- [x] `hub-ui/frontend/` se STT/VIDEO/LLM tabs + WebUI discovery sidebar
- [x] `install.sh` s GPU detekcí (P40/Blackwell/Ampere/ROCm) + env update
- [x] `hub-agent/services.yaml` s 7 službami + WebUI registry
- [x] End-to-end test na aiworkeru — všechny endpointy OK
- [x] `/api/webui/registry` vrací plný JSON s compile-time + runtime WebUI discovery
- [x] `docker compose build` + `up -d` funkční pro aiworker profil
- [x] CACHE_TYPE_K=f16 hardcoded v docker-compose (P40 garbage protection)
- [x] install.sh generuje machines.yaml z machines.example.yaml (env subs)

---

## Reference

- Plán: `.commandcode/plans/local-ai-stack-merge.md`
- Session log: `docs/sessions/2026-08-28-local-ai-stack.md`
- README: `README.md`
- Architecture: `ARCHITECTURE.md`
- Plan status: schválený (viz `.commandcode/plans/plans-index.json` `reddit-story-image-gen-impl.md` — to je starý plán, nový plán pro local-ai-stack je schválený v session)

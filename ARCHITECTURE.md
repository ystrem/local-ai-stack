# Architektura — local-ai-stack

## Přehled

`local-ai-stack` je master repo, který orchestruje 2 GitHub submoduly:

- `comfyui-unified` — IMG/TTS/VIDEO engine (ComfyUI + MOSS-TTS + custom nodes)
- `local-ai-coding-servers` — LLM engine (llama.cpp multi-arch + setup skripty)

Master přidává **Hub-UI** + **Service Router** pro 5 typů AI služeb.

## Topologie

```
┌──────────────────────────────────────────────────────────────────────┐
│ LAN 192.168.10.x                                                    │
│                                                                      │
│ ┌───────── aicore (192.168.10.60) ──────────┐                       │
│ │ P40 sm_61                                  │                       │
│ │ ┌────────────┐  ┌────────────┐  ┌──────────┐│                       │
│ │ │ comfyui    │  │ qwen       │  │hub-agent ││                       │
│ │ │ (IMG+TTS+  │  │ (LLM)      │  │ :8199    ││                       │
│ │ │  VIDEO)    │  │            │  │          ││                       │
│ │ │ :8188/89   │  │ :8080      │  │          ││                       │
│ │ └────────────┘  └────────────┘  └──────────┘│                       │
│ │           ▲           ▲             │        │                       │
│ │           └─master hub-ui (local-ai-stack)──┘                       │
│ │           │   (orchestrate + WebUI discovery)                       │
│ └────────────────────────────────────────────┘                       │
│              │                                                         │
│              │ HTTP /api/proxy/{kind}/generate                       │
│              ▼                                                         │
│ ┌─────── aiworker (192.168.10.194) ────────┐                          │
│ │ 2× 5060 Ti                              │                          │
│ │ comfyui (IMG/VIDEO) + qwen+ornith (LLM) │                          │
│ │ hub-agent :8199                         │                          │
│ └──────────────────────────────────────────┘                          │
│              │                                                         │
│              │ STT: faster-whisper (aicore:5007)                     │
│              ▼                                                         │
│ STT service: aicore:5007 ─────────► OPENAI-compat transcribe         │
│                                                                      │
│ NFS /mnt/models (sdíleno)                                            │
└──────────────────────────────────────────────────────────────────────┘
```

## Service router — 5 typů

`/api/proxy/{kind}/generate` je **single point of entry** pro všechny AI
typy. Operátor v Hub-UI nastavuje AUTO/MANUAL režim, assignments, fallback
chains.

| Kind | Engine | Default routing |
|---|---|---|
| LLM | llama.cpp | aiworker:8080 → aicore:8080 → ollama:11435 |
| IMG | ComfyUI | aicore:8188 → aiworker:8188 → desktop:8188 |
| TTS | MOSS-TTS v1.5 | aicore:8188 → aiworker:8188 (fallback edge-tts) |
| STT | faster-whisper | aicore:5007 |
| VIDEO | ComfyUI workflows | aicore:8188 → aiworker:8188 |

**AUTO režim:**
1. Přijmi request `POST /api/proxy/{kind}/generate`
2. Resolve target: desired → assignment → auto-discover
3. Auto-start služby pokud neběží (přes hub-agent)
4. Forward request + přidej hlavičku `X-Served-By: {machine}`
5. Record activity pro auto-návrat

**MANUAL režim:** fail loud 503, žádný auto-start.

## Hub-UI — Service Tabs + WebUI Discovery

Hub-UI SPA (port 8288) má **5 service tabs** (IMG, TTS, STT, VIDEO, LLM)
+ sidebar s **dynamickou WebUI navigací**. Každá služba může mít vlastní
WebUI, který se automaticky zobrazí v sidebar (compile-time z `services.yaml`,
runtime probe z `/capabilities`).

**Compile-time registrace** (v `hub-agent/services.yaml`):

```yaml
- id: comfyui
  type: img
  webui:
    url: http://{machine_ip}:8189
    label: "ComfyUI Workflows"
    icon: 🎨
    type: native       # native | swagger | gradio | iframe
    path: /
```

**Runtime registrace** (přes `GET /capabilities` z hub-agent):

```json
{
  "gpu": {...},
  "services": [
    {"id": "comfyui", "type": "img", "webui": {...}}
  ],
  "toggles": {"llm": true, "img": true, ...}
}
```

**Frontend zobrazení** (v `hub-ui/frontend/app.js`):

```javascript
const registry = await fetch('/api/webui/registry').then(r => r.json());
registry.filter(w => w.running).forEach(w => {
  const link = document.createElement('a');
  link.href = w.url;
  link.target = '_blank';  // WebUI v novém tabu
  ...
});
```

## GPU lock + Toggle gate (per-machine)

Hub-agent (`comfyui-unified/hub-agent/`) se stará o:
- **GPU lock** — služba nemůže start, pokud GPU obsazená jinou službou (409)
- **Toggle gate** — `toggles.yaml` per-kind enable/disable (403)
- **Whitelist** — `services.yaml` definuje povolené služby

## Docker compose — master orchestrace

`docker-compose.yml` v masteru má `build.context: ./comfyui-unified` a
`./local-ai-coding-servers`. Docker buildí **v submoduleu** — master
nemá Dockerfile duplicitu.

## Per-machine lifecycle

```
1. git clone --recurse-submodules
2. cp .env.example .env
3. ./scripts/install.sh
   a) Detekce GPU → .env per-machine
   b) Stáhni modely (submodule download-models.sh)
   c) Per-machine setup (submodule setup-*.sh)
   d) Build Docker images (build context = submodule)
   e) docker compose --profile $MACHINE_ID up -d
4. Open http://localhost:8288
```

## Out of scope

- Multi-host NFS (DRBD, GlusterFS)
- Observability (Prometheus, Grafana)
- Auto-failover (AUTO režim auto-startuje, ale ne auto-detekuje failure)
- Load balancing (každý kind má primary → fallback, ne LB)
- Real-time STT streaming
- Multi-tenant auth (LAN only)
- Cloudflare tunnel / remote access

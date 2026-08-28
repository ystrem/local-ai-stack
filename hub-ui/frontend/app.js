/* ComfyUI Unified — Studio Console SPA */
"use strict";

const state = {
  view: "status",
  models: [],
  voices: [],
  templates: [],
  history: [],
  stats: null,
  health: null,
  config: null,
  gpus: [],
  gpuSelection: null,
  logs: [],
  generating: null,     // { kind, model, startMs, liveLogs: [], progress: {} }
  result: null,         // { kind, url, blob, mime, filename, durationMs }
  benchmark: null,
  logsPaused: false,
  logFilter: "all", // all | error | warn | comfy
  historyIndex: -1, // výběr pro klávesnicovou navigaci v historii
  historyExpanded: null, // id řádku historie s rozbaleným audio náhledem
  settings: { notify: localStorage.getItem("comfyui-notify") === "1" },
  filters: { historyKind: "", templateKind: "",
             historySearch: "", historyView: localStorage.getItem("comfyui-hist-view") || "list" },
  tts: { model: "", text: "", voice: "", language: "cs", instruction: "", seed: 42,
         temperature: null, top_p: null, top_k: null, repetition_penalty: null,
         max_new_tokens: null, quality: "", sound_event: "", ambient_sound: "",
         speed: null, response_format: "", refAudio: null, seedRandom: false }, // refAudio = { name, b64, blobUrl }
  img: { model: "", prompt: "", negative_prompt: "", steps: null, cfg: null,
         seed: 42, width: 1024, height: 1024, benchmarkRuns: 3, seedRandom: false,
         promptHeight: null },
  voiceDesign: { instruction: "", language: "cs", reference_text: "", seed: 42, voice_id: "" },
  timingHistory: {},  // { modelId: { count, avg_s, min_s, max_s, recent_samples } }
  hub: { machines: [], activeMachine: localStorage.getItem("hub-machine") || "",
         rec: null, recModel: "" },  // HUB: cluster stav + aktivní stroj (design hub-ui.md)
  queue: { jobs: [], lastUpdate: 0 },  // GHE AUTO fronta: {jobs:[{id, state, needs, ...}]}
};

const VIEW_TITLES = {
  status: "Status Overview",
  dashboard: "Dashboard — ovládání clusteru",
  generate: "Generovat",
  tts: "TTS Studio",
  image: "Image Studio",
  templates: "Templates & Presets",
  history: "History",
  logs: "Live Logs",
  settings: "Settings",
};

const LANGUAGES = ["cs", "en", "zh", "ja", "ko", "de", "fr", "ru", "pt", "es", "it",
  "ar", "pl", "nl", "fi", "hi", "sv", "el", "tr", "th", "vi", "he", "ms", "ro", "hu", "fa"];
const QWEN3_LANGUAGES = ["en", "zh", "ja", "ko"];
const QUALITIES = ["", "low", "medium", "high", "premium"];
const RESPONSE_FORMATS = ["", "wav", "mp3", "ogg", "opus"];
const RES_PRESETS = [[512, 512], [768, 768], [1024, 1024], [1280, 720], [1024, 1536], [1536, 1024], [2048, 2048]];
const TEMPLATE_KINDS = [
  { id: "tts_text", label: "TTS text" },
  { id: "image_prompt", label: "Image prompt" },
  { id: "negative_prompt", label: "Negative prompt" },
  { id: "voice_instruction", label: "Voice instruction" },
];

// ── Helpers ──────────────────────────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const parseIntOr = (v, d) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; };
const randomSeed = () => Math.floor(Math.random() * 4294967296);

// Throttlený render pro SSE události (logy/progress během generace)
let renderTimer = null;
function isTyping() {
  const a = document.activeElement;
  return !!(a && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName));
}
function renderIfIdle() {
  if (isTyping()) return;
  render();
}
function renderSoon() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; renderIfIdle(); }, 400);
}

function vramWarning(modelId) {
  const m = state.models.find(x => x.id === modelId);
  const sel = state.gpuSelection;
  if (!m || !m.vram_mb || !sel || !sel.devices || !sel.devices.length) return "";
  const maxFree = Math.max(...sel.devices.map(d => d.vram_free_mb || 0));
  if (m.vram_mb > maxFree) {
    return `<p class="text-[11px] text-amber-400 mt-2">⚠ Model potřebuje ~${(m.vram_mb / 1024).toFixed(1)} GB VRAM, nejvíc volné je ${(maxFree / 1024).toFixed(1)} GB — může dojít k přepnutí GPU / restartu ComfyUI.</p>`;
  }
  return "";
}

function notifyDone(title, body) {
  if (!state.settings.notify) return;
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification(title, { body }); } catch (_) {}
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.05;
    o.start(); o.stop(ctx.currentTime + 0.15);
  } catch (_) {}
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(str) {
  if (!str) return "";
  return String(str).replace(/"/g, "&quot;");
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  return isNaN(d) ? ts : d.toLocaleTimeString("cs-CZ");
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function toast(msg, type = "ok") {
  const c = $("#toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type === "ok" ? "toast-ok" : "toast-error"}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    // Clone the response so we can try json() then fall back to text()
    // without hitting "body stream already read" if the first parse fails.
    const cloned = res.clone();
    let detail = `HTTP ${res.status}`;
    try {
      const body = await cloned.json();
      detail = body.detail || body.error || JSON.stringify(body).slice(0, 300);
    } catch (_) {
      try {
        const text = await res.text();
        if (text) detail = text.slice(0, 300);
      } catch (_) {
        // body unreadable — keep status text
      }
    }
    throw new Error(detail);
  }
  const ctype = res.headers.get("content-type") || "";
  if (ctype.includes("json")) {
    return { body: await res.json(), headers: res.headers };
  }
  return { body: await res.blob(), headers: res.headers };
}

async function refreshAll() {
  try {
    const [models, health, templates, stats, gpuSel, timing, queue] = await Promise.all([
      api("/api/models").then(r => r.body).catch(() => ({ models: [] })),
      api("/api/health").then(r => r.body).catch(() => null),
      api("/api/templates").then(r => r.body).catch(() => ({ templates: [] })),
      api("/api/stats").then(r => r.body).catch(() => null),
      api("/api/gpus").then(r => r.body).catch(() => null),
      api("/api/timing-history").then(r => r.body).catch(() => ({ timing: {} })),
      api("/api/hub/machines/" + (state.hub.activeMachine || (state.hub.machines[0] && state.hub.machines[0].id) || "aiworker") + "/queue")
        .then(r => r.body).catch(() => ({ jobs: [] })),
    ]);
    state.queue = { jobs: queue.jobs || [], lastUpdate: Date.now() };
    state.models = models.models || [];
    state.health = health;
    state.templates = templates.templates || [];
    state.stats = stats;
    state.gpuSelection = gpuSel;
    state.timingHistory = timing.timing || {};
    const count = state.models.length;
    $("#sidebar-model-count").textContent = `${count} modelů`;
    updateGlobalHealth();
    const je = $("#js-error");
    if (je) je.classList.add("hidden");
    // Nerekreslovat celý view, když uživatel právě píše (ztráta focusu)
    // nebo běží generace (progress si re-renderuje vlastním pollingem)
    const active = document.activeElement;
    const typing = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
    if (!typing && !state.generating) render();
  } catch (e) {
    showJsError(e);
  }
}

function updateGlobalHealth() {
  const el = $("#global-health");
  if (!el) return;
  const h = state.health;
  if (!h) {
    el.textContent = "backend offline";
    el.className = "px-3 py-1 rounded-full text-xs font-label-mono bg-red-900/40 text-red-400 border border-red-500/20";
    return;
  }
  const lc = h.lifecycle || {};
  if (h.service_status === "ok") {
    el.textContent = "vše OK";
    el.className = "px-3 py-1 rounded-full text-xs font-label-mono bg-primary/10 text-primary border border-primary/20";
  } else if (h.service_status === "starting" || lc.starting) {
    const secs = lc.start_elapsed_s != null ? `${lc.start_elapsed_s}s` : "";
    el.textContent = `ComfyUI startuje${secs ? " · " + secs : ""}`;
    el.className = "px-3 py-1 rounded-full text-xs font-label-mono bg-amber-900/40 text-amber-400 border border-amber-500/20";
  } else if (h.service_status === "degraded") {
    el.textContent = "degraded";
    el.className = "px-3 py-1 rounded-full text-xs font-label-mono bg-amber-900/40 text-amber-400 border border-amber-500/20";
  } else {
    el.textContent = "error";
    el.className = "px-3 py-1 rounded-full text-xs font-label-mono bg-red-900/40 text-red-400 border border-red-500/20";
  }
}

function showJsError(e) {
  console.error(e);
  const el = $("#js-error");
  if (el) {
    el.classList.remove("hidden");
    el.textContent = String(e && e.message ? e.message : e);
  }
}

// ── Router ───────────────────────────────────────────────

function navigate(view) {
  state.view = view;
  $("#view-title").textContent = VIEW_TITLES[view] || view;
  $$(".nav-item").forEach(b => {
    const active = b.dataset.view === view;
    b.classList.toggle("bg-surface-container", active);
    b.classList.toggle("text-on-surface", active);
    b.classList.toggle("text-on-surface-variant", !active);
  });
  render();
}

function render() {
  const content = $("#content");
  if (!content) return;
  switch (state.view) {
    case "status": renderStatus(content); break;
    case "dashboard": renderDashboard(content); break;
    case "generate": renderGenerate(content); break;
    case "tts": renderTts(content); break;
    case "image": renderImage(content); break;
    case "templates": renderTemplates(content); break;
    case "history": renderHistory(content); break;
    case "logs": renderLogs(content); break;
    case "settings": renderSettings(content); break;
    default: content.innerHTML = "<p class='text-text-muted'>Neznámý view</p>";
  }
}

function card(title, body, accent = "") {
  return `<div class="card glint-card ${accent}">
    <h3 class="font-bold text-on-surface mb-3">${title}</h3>
    ${body}
  </div>`;
}

function badge(text, color = "text-primary", bg = "bg-primary/10", border = "border-primary/20") {
  return `<span class="px-2 py-0.5 rounded-full text-[10px] font-label-mono ${color} ${bg} border ${border}">${escapeHtml(text)}</span>`;
}

// ── Timing History ───────────────────────────────────────

function renderTimingHistory() {
  const timing = state.timingHistory || {};
  const modelIds = Object.keys(timing);
  
  if (!modelIds.length) {
    return `<p class="text-text-muted text-xs">Žádné historické časy — spusťte generování pro odhady ETA.</p>`;
  }
  
  const rows = modelIds.map(modelId => {
    const t = timing[modelId];
    const model = state.models.find(m => m.id === modelId);
    const modelName = model?.name || modelId;
    const isTts = model?.kind === "tts";
    const confColor = t.count >= 10 ? "text-primary" : t.count >= 5 ? "text-amber-400" : "text-text-muted";
    const confIcon = t.count >= 10 ? "verified" : t.count >= 5 ? "info" : "help";
    
    return `
      <div class="flex items-center justify-between py-2 border-b border-border/30 last:border-0">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-[16px] ${isTts ? "text-primary" : "text-purple-400"}">${isTts ? "record_voice_over" : "image"}</span>
          <div>
            <div class="font-medium text-on-surface text-xs">${escapeHtml(modelName)}</div>
            <div class="text-[9px] text-text-muted">${t.count} generací · min ${t.min_s}s · max ${t.max_s}s</div>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <span class="font-label-mono text-xs font-bold text-on-surface">${t.avg_s}s</span>
          <span class="material-symbols-outlined ${confColor}" style="font-size:12px" title="Spolehlivost">${confIcon}</span>
        </div>
      </div>`;
  }).join("");
  
  return `<div class="space-y-1">${rows}</div>
    <p class="text-[9px] text-text-muted mt-3">Odhad ETA se upřesňuje s každou další generací.</p>`;
}

// ── Status Overview ──────────────────────────────────────

async function renderStatus(el) {
  const h = state.health;
  const gpu = h && h.gpu ? h.gpu : null;
  const vram = h && h.vram_used_mb != null ? h.vram_used_mb : null;
  const lc = h && h.lifecycle ? h.lifecycle : null;
  const starting = !!(h && (h.service_status === "starting" || (lc && lc.starting)));

  const tts = state.models.filter(m => m.kind === "tts");
  const img = state.models.filter(m => m.kind === "image");

  const startBanner = starting ? `
    <div class="progress-panel mb-4">
      <span class="material-symbols-outlined animate-spin text-amber-400">sync</span>
      <div>
        <div class="font-bold text-on-surface">ComfyUI startuje…</div>
        <div class="text-xs text-text-muted">${lc && lc.start_elapsed_s != null ? `běží ${lc.start_elapsed_s}s` : "příprava modelů a VRAM"} · API je online, Live Logs streamují průběh</div>
      </div>
    </div>
    <div class="bg-surface-dim rounded-full h-2 mb-4 overflow-hidden">
      <div class="h-2 rounded-full bg-amber-400 transition-all duration-1000" style="width:${Math.min((lc && lc.start_elapsed_s || 0) / 180 * 100, 95)}%"></div>
    </div>` : "";

  const healthHtml = h ? `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="bg-surface-dim rounded-lg p-3">
        <div class="text-[10px] text-text-muted uppercase tracking-wider">Service</div>
        <div class="text-lg font-bold ${h.service_status === "ok" ? "text-primary" : starting ? "text-amber-400" : "text-red-400"}">${escapeHtml(starting ? "startuje" : h.service_status)}</div>
      </div>
      <div class="bg-surface-dim rounded-lg p-3">
        <div class="text-[10px] text-text-muted uppercase tracking-wider">ComfyUI</div>
        <div class="text-lg font-bold text-on-surface">${escapeHtml(h.comfyui || "—")}</div>
      </div>
      <div class="bg-surface-dim rounded-lg p-3">
        <div class="text-[10px] text-text-muted uppercase tracking-wider">VRAM used</div>
        <div class="text-lg font-bold text-on-surface">${vram != null ? vram + " MB" : "—"}</div>
      </div>
      <div class="bg-surface-dim rounded-lg p-3">
        <div class="text-[10px] text-text-muted uppercase tracking-wider">GPU</div>
        <div class="text-sm font-bold text-on-surface">${escapeHtml(gpu ? gpu.name : "—")}</div>
      </div>
    </div>
    ${gpu ? `<div class="mt-3 text-xs text-text-muted">Driver ${escapeHtml(gpu.driver || "?")} · VRAM total ${gpu.vram_total_mb || "?"} MB · ${escapeHtml(gpu.backend || "?")}</div>` : ""}
  ` : `<div class="text-red-400">Backend nedostupný</div>`;

  const modelRow = m => {
    const timing = state.timingHistory[m.id];
    const timingBadge = timing && timing.count >= 1 ? 
      `<span class="text-[9px] font-label-mono text-text-muted">⏱ ${timing.avg_s}s průměr (${timing.count})</span>` : "";
    return `
    <div class="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <div>
        <div class="font-bold text-on-surface">${escapeHtml(m.name)}</div>
        <div class="text-[10px] text-text-muted font-label-mono">${escapeHtml(m.id)}${m.arch ? " · " + escapeHtml(m.arch) : ""}${m.engine ? " · " + escapeHtml(m.engine) : ""}</div>
        ${timingBadge}
      </div>
      <div class="flex items-center gap-2">
        ${m.nsfw ? badge("NSFW", "text-red-400", "bg-red-900/20", "border-red-500/20") : ""}
        ${badge(`${m.vram_mb || "?"} MB VRAM`, "text-amber-400", "bg-amber-900/20", "border-amber-500/20")}
      </div>
    </div>`;
  };

  el.innerHTML = `
    ${startBanner}
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2 space-y-6">
        ${card("Backend Health", healthHtml)}
        ${card("Načtený model", `
          <div class="space-y-2 text-xs">
            <div class="flex justify-between"><span class="text-text-muted">Model</span><span class="font-bold text-on-surface">${state.health && state.health.loaded_model ? escapeHtml((state.models.find(m => m.id === state.health.loaded_model) || {}).name || state.health.loaded_model) : "—"}</span></div>
            <div class="flex justify-between"><span class="text-text-muted">Device</span><span class="font-bold text-on-surface">${state.health && state.health.loaded_device ? escapeHtml(state.health.loaded_device) : "—"}</span></div>
            <div class="flex justify-between"><span class="text-text-muted">VRAM used</span><span class="font-bold text-on-surface">${vram != null ? vram + " MB" : "—"}</span></div>
          </div>`)}
        ${card("Fronta (GHE AUTO)", renderQueuePanel())}
        <div class="card">
          <div class="flex items-center justify-between mb-3">
            <h3 class="font-bold text-on-surface">Akce</h3>
          </div>
          <div class="flex gap-3 flex-wrap">
            <button id="btn-free" class="btn btn-secondary btn-md">Free VRAM</button>
            <button id="btn-unload" class="btn btn-danger btn-md">Restart ComfyUI</button>
          </div>
        </div>
      </div>
      <div class="space-y-6">
        ${card("GPU výběr", renderGpuSelect())}
        ${card("Cluster", `
          <div id="cluster-manage"></div>
          <div class="mt-4 border-t border-border/50 pt-3">
            <h4 class="text-[10px] font-label-caps text-text-muted uppercase tracking-wider mb-2">Assignment (primary + fallback)</h4>
            <div id="assignments-list"></div>
          </div>`)}
        ${card("Historie generování", renderTimingHistory())}
        ${card("TTS modely", tts.map(modelRow).join("") || "<p class='text-text-muted'>Žádné</p>")}
        ${card("Image modely", img.map(modelRow).join("") || "<p class='text-text-muted'>Žádné</p>")}
      </div>
    </div>`;

  renderClusterManage();
  await renderAssignments();

  $("#btn-free").addEventListener("click", async () => {
    try { await api("/api/free", { method: "POST" }); toast("VRAM uvolněna"); refreshAll(); }
    catch (e) { toast(`Free selhalo: ${e.message}`, "error"); }
  });
  $("#btn-unload").addEventListener("click", async () => {
    if (!confirm("Opravdu restartovat ComfyUI? Generování se přeruší a modely se znovu načtou.")) return;
    try { await api("/api/unload", { method: "POST" }); toast("ComfyUI restartován"); refreshAll(); }
    catch (e) { toast(`Restart selhal: ${e.message}`, "error"); }
  });
  $$("[data-gpu-sel]").forEach(b => b.addEventListener("click", async () => {
    const dev = b.dataset.gpuSel === "auto" ? "auto" : parseInt(b.dataset.gpuSel);
    b.disabled = true;
    b.textContent = "Přepínám GPU...";
    try {
      await api("/api/gpu-select", { method: "POST", body: JSON.stringify({ device: dev }) });
      toast("GPU přepnuto, ComfyUI restartován");
      await refreshAll();
    } catch (e) {
      toast(`Přepnutí GPU selhalo: ${e.message}`, "error");
      b.disabled = false;
      b.textContent = dev === "auto" ? "Auto" : `GPU ${dev}`;
    }
  }));
}

// ── Dashboard (ovládání clusteru: stroje × GPU × služby, on/off) ──

async function renderDashboard(el) {
  el.innerHTML = `
    <div class="space-y-4">
      <div class="flex items-center justify-between flex-wrap gap-2">
        <div class="flex items-center gap-3">
          <h2 class="font-bold text-on-surface">Stroje a služby</h2>
          <span id="dash-cluster-mode" class="px-2 py-0.5 rounded-full text-[10px] font-label-mono font-bold cursor-pointer" title="Klikni pro přepnutí AUTO ↔ MANUAL">…</span>
          <span id="dash-drift" class="hidden px-2 py-0.5 rounded-full text-[10px] font-label-mono bg-amber-900/30 text-amber-400 border border-amber-500/30">⚠ drift</span>
        </div>
        <div class="flex gap-2">
          <button id="btn-dash-compare" class="btn btn-secondary btn-sm hidden">Srovnat (aplikovat desired)</button>
          <button id="btn-dash-free-all" class="btn btn-danger btn-sm">Free VRAM všude</button>
        </div>
      </div>
      <div id="dash-grid" class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div class="text-text-muted text-xs">Načítám cluster...</div>
      </div>
      <div class="card">
        <h3 class="font-bold text-on-surface mb-2">Automatizace (proxy) <span class="text-[10px] text-text-muted font-normal">— pipeline volá jeden endpoint, proxy rozděluje dle typu úlohy (jen AUTO)</span></h3>
        <div id="dash-proxy-status" class="text-xs"><div class="text-text-muted">Načítám...</div></div>
      </div>
      <div class="card">
        <h3 class="font-bold text-on-surface mb-2">Poslední runy <span class="text-[10px] text-text-muted font-normal">(celá historie v záložce History)</span></h3>
        <div id="dash-history" class="text-xs"><div class="text-text-muted">Načítám...</div></div>
      </div>
      <div class="card">
        <h3 class="font-bold text-on-surface mb-2">Live log vybrané služby</h3>
        <div class="flex gap-2 mb-2 flex-wrap">
          <select id="dash-log-machine" class="control field text-xs" style="width:180px"></select>
          <select id="dash-log-service" class="control field text-xs" style="width:180px"></select>
          <button id="btn-dash-log" class="btn btn-secondary btn-sm">Načíst logy</button>
        </div>
        <pre id="dash-log-output" class="text-[10px] font-label-mono bg-[#0a0f0b] border border-border rounded-lg p-3 max-h-72 overflow-auto whitespace-pre-wrap text-text-muted">—</pre>
      </div>
    </div>`;

  await refreshClusterMode();
  await refreshDashboardGrid();
  await renderDashboardHistory();
  await renderProxyStatus();
  bindDashboardActions(el);
}

// ── Cluster mode (AUTO/MANUAL) ───────────────────────────

async function refreshClusterMode() {
  const el = $("#dash-cluster-mode");
  if (!el) return;
  try {
    const { body } = await api("/api/hub/cluster-mode");
    const mode = body.cluster_mode;
    el.textContent = mode === "auto" ? "● AUTO" : "○ MANUAL";
    el.className = "px-2 py-0.5 rounded-full text-[10px] font-label-mono font-bold cursor-pointer " +
      (mode === "auto"
        ? "bg-emerald-900/30 text-emerald-400 border border-emerald-500/40"
        : "bg-zinc-800/60 text-zinc-300 border border-zinc-500/40");
  } catch (e) {
    el.textContent = "mode ?";
    el.title = `Chyba: ${e.message}`;
  }
}

async function toggleClusterMode() {
  const { body } = await api("/api/hub/cluster-mode");
  const cur = body.cluster_mode;
  if (cur === "auto") {
    if (!confirm("Přepnout na MANUAL?\n\nAutomatizované generování (content-factory pipeline, proxy endpointy)\nBUDE BLOKOVÁNO — ruční ovládání v UI zůstává.")) return;
  } else {
    if (!confirm("Přepnout na AUTO?\n\nProxy bude automaticky startovat služby a posílat workload\nna stroje dle desired state — pipeline poběží bez člověka.")) return;
  }
  try {
    await api("/api/hub/cluster-mode", { method: "PUT", body: JSON.stringify({ mode: cur === "auto" ? "manual" : "auto" }) });
    toast(`Cluster režim: ${cur === "auto" ? "MANUAL" : "AUTO"}`);
    await refreshClusterMode();
    await renderProxyStatus();
  } catch (e) { toast(`Přepnutí selhalo: ${e.message}`, "error"); }
}

// ── Proxy status (Automatizace sekce) ────────────────────

const PROXY_KINDS = ["tts", "image", "video", "stt", "llm"];

async function renderProxyStatus() {
  const el = $("#dash-proxy-status");
  if (!el) return;
  let body;
  try { ({ body } = await api("/api/proxy/status")); }
  catch (e) { el.innerHTML = `<div class="text-red-400">Proxy status nedostupný: ${escapeHtml(e.message)}</div>`; return; }
  const base = location.origin;
  el.innerHTML = `<div class="overflow-x-auto">
    <table class="w-full text-[11px] font-label-mono">
      <thead><tr class="text-text-muted text-left border-b border-border/60">
        <th class="py-1 pr-2 font-normal">kind</th><th class="py-1 pr-2 font-normal">stroj</th>
        <th class="py-1 pr-2 font-normal">služba</th><th class="py-1 pr-2 font-normal">stav</th>
        <th class="py-1 pr-2 font-normal">endpoint</th>
      </tr></thead>
      <tbody>${PROXY_KINDS.map(k => {
        const e = body.kinds?.[k] || {};
        const r = e.resolved;
        const ok = r && e.running;
        const stateCell = !r
          ? `<td class="py-1 pr-2 text-red-400" colspan="2">${escapeHtml(e.error || "nenastaveno")}</td>`
          : `<td class="py-1 pr-2">${escapeHtml(r.machine)}${r.mode ? ` <span class="text-text-muted">(${escapeHtml(r.mode)})</span>` : ""}</td>
             <td class="py-1 pr-2">${ok ? '<span class="text-primary">✓ běží</span>' : '<span class="text-amber-400">stopped (proxy nastartuje)</span>'}</td>`;
        return `<tr class="border-b border-border/30">
          <td class="py-1 pr-2 font-bold">${k}</td>
          ${stateCell}
          <td class="py-1 pr-2"><code class="text-[9px] text-text-muted select-all">${base}/api/proxy/${k}/generate</code></td>
        </tr>`;
      }).join("")}
      </tbody>
    </table></div>`;
}

async function renderDashboardHistory() {
  const el = $("#dash-history");
  if (!el) return;
  try {
    const { body } = await api("/api/history?limit=12");
    const items = body.history || body.items || body || [];
    const rows = (Array.isArray(items) ? items : []).slice(0, 12);
    if (!rows.length) { el.innerHTML = '<div class="text-text-muted">Zatím žádné runy.</div>'; return; }
    el.innerHTML = `
      <div class="overflow-x-auto">
        <table class="w-full text-[11px] font-label-mono">
          <thead><tr class="text-text-muted text-left border-b border-border/60">
            <th class="py-1 pr-2 font-normal">čas</th><th class="py-1 pr-2 font-normal">stroj</th>
            <th class="py-1 pr-2 font-normal">druh</th><th class="py-1 pr-2 font-normal">model</th>
            <th class="py-1 pr-2 font-normal">status</th><th class="py-1 pr-2 font-normal">doba</th>
            <th class="py-1 pr-2 font-normal">výstup</th>
          </tr></thead>
          <tbody>
            ${rows.map(h => {
              const ok = h.status === "ok";
              const time = h.ts ? new Date(h.ts + (h.ts.endsWith("Z") ? "" : "Z")).toLocaleTimeString() : "—";
              const dur = h.duration_ms != null ? fmtDuration(h.duration_ms) : "—";
              return `<tr class="border-b border-border/30">
                <td class="py-1 pr-2 text-text-muted">${time}</td>
                <td class="py-1 pr-2">${h.machine ? escapeHtml(h.machine) : '<span class="text-text-muted">default</span>'}</td>
                <td class="py-1 pr-2">${escapeHtml(h.kind || "?")}</td>
                <td class="py-1 pr-2 truncate max-w-[180px]" title="${escapeAttribute(h.model || "")}">${escapeHtml(h.model || "?")}</td>
                <td class="py-1 pr-2">${ok ? '<span class="text-primary">✓</span>' : `<span class="text-red-400" title="${escapeAttribute(h.error || "")}">✗</span>`}</td>
                <td class="py-1 pr-2 text-text-muted">${dur}</td>
                <td class="py-1 pr-2">${ok && h.output_path ? `<a href="/api/history/${h.id}/output" target="_blank" class="text-primary hover:underline">otevřít</a>` : "—"}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div class="text-red-400">Historie nedostupná: ${escapeHtml(e.message)}</div>`;
  }
}

async function refreshDashboardGrid() {
  const grid = $("#dash-grid");
  if (!grid) return;
  let machines = state.hub.machines;
  let desired = {}, driftMap = {};
  try {
    const [{ body: dBody }, { body: aBody }] = await Promise.all([
      api("/api/hub/desired"),
      machines.length ? Promise.resolve({ body: { machines } }) : api("/api/hub/machines"),
    ]);
    desired = dBody.desired || {};
    driftMap = dBody.drift || {};
    machines = aBody.machines || machines;
    state.hub.machines = machines;
  } catch (_) {}

  const driftEl = $("#dash-drift");
  const compareBtn = $("#btn-dash-compare");
  const hasDrift = Object.keys(driftMap).length > 0;
  if (driftEl) driftEl.classList.toggle("hidden", !hasDrift);
  if (compareBtn) compareBtn.classList.toggle("hidden", !hasDrift);

  const svcRow = (sid, svc, mid) => {
    const want = desired[sid] || {};
    const isDrift = sid in driftMap;
    const running = svc ? svc.running : null;
    const dotColor = isDrift ? "#fbbf24" : running ? "#4ade80" : running === false ? "#6b7280" : "#6b7280";
    const gpuVal = want.gpu != null ? want.gpu : "auto";
    const gpuOpts = ['<option value="auto">auto</option>']
      .concat((svcGpus || []).map(g => `<option value="${g.index}" ${String(gpuVal) === String(g.index) ? "selected" : ""}>GPU${g.index}</option>`)).join("");
    return `
      <div class="flex items-center justify-between gap-2 py-1.5 border-t border-border/40" data-dash-service="${escapeHtml(sid)}" data-dash-machine="${escapeHtml(mid)}">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-1.5 h-1.5 rounded-full shrink-0" style="background:${dotColor}"></span>
          <span class="text-xs font-bold text-on-surface truncate">${escapeHtml(sid)}</span>
          ${isDrift ? '<span class="text-[8px] text-amber-400 font-label-mono shrink-0">drift</span>' : ""}
          <span class="text-[9px] text-text-muted font-label-mono shrink-0">${running === true ? "běží" : running === false ? "stopped" : "?"}</span>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <select class="control field text-[10px]" style="width:80px" data-dash-gpu="${escapeHtml(sid)}">${gpuOpts}</select>
          <button class="btn btn-sm ${want.enabled ? "btn-danger" : "btn-primary"}" data-dash-toggle="${escapeHtml(sid)}" data-dash-enabled="${want.enabled ? "1" : "0"}">${want.enabled ? "Stop" : "Start"}</button>
        </div>
      </div>`;
  };

  let svcGpus = [];
  const cards = machines.map(m => {
    svcGpus = (m.caps?.gpus || []);
    const gpuRows = svcGpus.map(g => {
      const total = g.vram_total_mb || (g.vram_used_mb || 0) + (g.vram_free_mb || 0);
      const memPct = total ? Math.min(100, Math.round(((g.vram_used_mb || 0) / total) * 100)) : 0;
      return `
        <div class="py-1">
          <div class="flex justify-between text-[10px]"><span class="text-on-surface font-bold">${escapeHtml((g.name || "").replace(/^NVIDIA GeForce /, ""))} (GPU${g.index})</span><span class="font-label-mono">${g.util_pct || 0}% · ${fmtGb(g.vram_used_mb || 0)}/${fmtGb(total)}${g.temp_c != null ? ` · ${g.temp_c}°C` : ""}</span></div>
          <div class="w-full bg-surface-dim rounded-full h-1.5 mt-1"><div class="h-1.5 rounded-full transition-all duration-500" style="width:${memPct}%"></div></div>
        </div>`;
    }).join("");
    const services = (m.caps?.services || []);
    const svcList = services.length ? services.map(s => svcRow(s.id, s, m.id)).join("")
      : '<div class="text-[9px] text-text-muted py-1">žádné služby nahlášené (legacy stroj — jen Unload/GPU pin níže)</div>';
    // režimy stroje (media/coding) — z mode polí služeb
    const allModes = [...new Set(services.map(s => s.mode).filter(Boolean))];
    const activeModes = [...new Set(services.filter(s => s.running && s.mode).map(s => s.mode))];
    const modeBtns = allModes.map(mo => {
      const active = activeModes.includes(mo);
      return `<button class="btn btn-sm ${active ? "btn-primary" : "btn-secondary"}" data-dash-mode="${escapeHtml(m.id)}" data-dash-mode-target="${escapeHtml(mo)}">${escapeHtml(mo)}${active ? " ●" : ""}</button>`;
    }).join("");
    const modeRow = allModes.length
      ? `<div class="flex items-center gap-1.5 mt-2 flex-wrap"><span class="text-[9px] text-text-muted font-label-mono mr-1">režim:</span>${modeBtns}</div>`
      : "";
    const hasAgent = !!m.agent_url;
    return `
      <div class="card" data-dash-machine-card="${escapeHtml(m.id)}">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold text-on-surface">${escapeHtml(m.name)} <span class="text-[9px] font-label-mono text-text-muted ml-1">${escapeHtml((m.url || "").replace(/^https?:\/\//, ""))}</span></h3>
          <span class="text-[9px]">${hubDot(m.status)}</span>
        </div>
        ${gpuRows || '<div class="text-[9px] text-text-muted py-1">žádná GPU data</div>'}
        ${modeRow}
        <div class="mt-2">${svcList}</div>
        <div class="flex gap-2 mt-3 pt-2 border-t border-border/40">
          <button class="btn btn-secondary btn-sm" data-dash-unload="${escapeHtml(m.id)}">Unload modelu</button>
          <select class="control field text-[10px]" style="width:110px" data-dash-pin="${escapeHtml(m.id)}">
            <option value="auto">GPU auto</option>
            ${svcGpus.map(g => `<option value="${g.index}">pin GPU${g.index}</option>`).join("")}
          </select>
          ${hasAgent ? `<label class="flex items-center gap-1 ml-auto text-[10px] text-text-muted cursor-pointer" title="Po X minutách nečinnosti se stroj vrátí na výchozí režim (jen AUTO)">
            <input type="checkbox" class="accent-emerald-500" data-dash-autoreturn="${escapeHtml(m.id)}"> auto-návrat
          </label>` : ""}
        </div>
      </div>`;
  }).join("");
  grid.innerHTML = cards || '<div class="text-text-muted text-xs">Žádné stroje — přidej je v Status → Cluster.</div>';

  $$("[data-dash-toggle]", grid).forEach(b => b.addEventListener("click", async () => {
    const sid = b.dataset.dashToggle;
    const card = b.closest("[data-dash-machine-card]");
    const mid = card?.dataset.dashMachineCard;
    const enable = b.dataset.dashEnabled !== "1";
    if (!enable && !confirm(`Stop služby ${sid} na ${mid}? Běžící generace se přeruší.`)) return;
    b.disabled = true;
    try {
      await api(`/api/hub/machines/${encodeURIComponent(mid)}/services/${encodeURIComponent(sid)}/${enable ? "start" : "stop"}`, { method: "POST" });
      await api("/api/hub/desired", { method: "POST", body: JSON.stringify({ service: sid, machine: mid, gpu: $(`[data-dash-gpu="${sid}"]`)?.value ?? null, enabled: enable }) });
      toast(`${sid} ${enable ? "startován" : "zastaven"} na ${mid}`);
      await refreshDashboardGrid();
    } catch (e) { toast(`Akce selhala: ${e.message}`, "error"); b.disabled = false; }
  }));
  $$("[data-dash-unload]", grid).forEach(b => b.addEventListener("click", async () => {
    const mid = b.dataset.dashUnload;
    if (!confirm(`Unload modelu na ${mid}?`)) return;
    b.disabled = true;
    try {
      await api(`/api/hub/machines/${encodeURIComponent(mid)}/unload`, { method: "POST" });
      toast(`Model na ${mid} uvolněn`);
      await pollHubMachines();
      b.disabled = false;
    } catch (e) { toast(`Unload selhal: ${e.message}`, "error"); b.disabled = false; }
  }));
  $$("[data-dash-pin]", grid).forEach(sel => sel.addEventListener("change", async () => {
    const mid = sel.dataset.dashPin;
    try {
      await api(`/api/hub/machines/${encodeURIComponent(mid)}/gpu-select`, { method: "POST", body: JSON.stringify({ device: sel.value === "auto" ? "auto" : parseInt(sel.value) }) });
      toast(`${mid}: GPU ${sel.value}`);
      await pollHubMachines();
    } catch (e) { toast(`GPU pin selhal: ${e.message}`, "error"); }
  }));

  $$("[data-dash-mode]", grid).forEach(b => b.addEventListener("click", async () => {
    const mid = b.dataset.dashMode;
    const mode = b.dataset.dashModeTarget;
    if (!confirm(`Přepnout ${mid} na režim '${mode}'?\n\nBěžící služby ostatních režimů se zastaví\na služby režimu '${mode}' se nastartují (modely se natahují — trvá to).`)) return;
    b.disabled = true;
    b.textContent = `${mode}…`;
    try {
      await api(`/api/hub/machines/${encodeURIComponent(mid)}/mode/${encodeURIComponent(mode)}`, { method: "POST" });
      toast(`${mid}: přepnuto na '${mode}'`);
      await refreshDashboardGrid();
    } catch (e) {
      toast(`Přepnutí režimu selhalo: ${e.message}`, "error");
      b.disabled = false;
      b.textContent = mode;
    }
  }));
  $$("[data-dash-autoreturn]", grid).forEach(cb => cb.addEventListener("change", async () => {
    const mid = cb.dataset.dashAutoreturn;
    let minutes = 0;
    if (cb.checked) {
      const val = prompt("Auto-návrat po X minutách nečinnosti:", "30");
      if (val === null) { cb.checked = false; return; }
      minutes = parseInt(val) || 0;
      if (minutes <= 0) { cb.checked = false; return; }
    }
    try {
      await api(`/api/hub/machines/${encodeURIComponent(mid)}/config`, { method: "PUT", body: JSON.stringify({ auto_return_minutes: minutes }) });
      toast(minutes ? `auto-návrat ${mid}: ${minutes} min` : `auto-návrat ${mid} vypnut`);
    } catch (e) { toast(`Uložení selhalo: ${e.message}`, "error"); cb.checked = false; }
  }));

  // log selecty
  const lm = $("#dash-log-machine"), ls = $("#dash-log-service");
  if (lm && !lm.options.length) {
    lm.innerHTML = machines.map(m => `<option value="${escapeAttribute(m.id)}">${escapeHtml(m.name)}</option>`).join("");
    ls.innerHTML = [...new Set(machines.flatMap(m => (m.caps?.services || []).map(s => s.id)))].map(s => `<option value="${escapeAttribute(s)}">${escapeHtml(s)}</option>`).join("");
  }
}

function bindDashboardActions(el) {
  $("#dash-cluster-mode")?.addEventListener("click", toggleClusterMode);
  $("#btn-dash-free-all")?.addEventListener("click", async () => {
    if (!confirm("Free VRAM na VŠECH strojích? Běžící modely se uvolní.")) return;
    const btn = $("#btn-dash-free-all");
    btn.disabled = true;
    try {
      await Promise.all(state.hub.machines.filter(m => m.status !== "down").map(m =>
        api(`/api/hub/machines/${encodeURIComponent(m.id)}/unload`, { method: "POST" })));
      toast("VRAM uvolněna na všech strojích");
      await pollHubMachines();
    } catch (e) { toast(`Free all selhal: ${e.message}`, "error"); }
    btn.disabled = false;
  });
  $("#btn-dash-compare")?.addEventListener("click", async () => {
    const btn = $("#btn-dash-compare");
    btn.disabled = true;
    try {
      const { body } = await api("/api/hub/desired");
      const driftMap = body.drift || {};
      for (const [sid, d] of Object.entries(driftMap)) {
        const action = d.desired ? "start" : "stop";
        try {
          await api(`/api/hub/machines/${encodeURIComponent(d.machine)}/services/${encodeURIComponent(sid)}/${action}`, { method: "POST" });
          toast(`${sid} ${action} na ${d.machine}`);
        } catch (e) { toast(`${sid} ${action} selhalo: ${e.message}`, "error"); }
      }
      await refreshDashboardGrid();
    } finally { btn.disabled = false; }
  });
  $("#btn-dash-log")?.addEventListener("click", async () => {
    const mid = $("#dash-log-machine")?.value;
    const sid = $("#dash-log-service")?.value;
    const out = $("#dash-log-output");
    if (!mid || !sid || !out) return;
    out.textContent = "Načítám logy...";
    try {
      const { body } = await api(`/api/hub/machines/${encodeURIComponent(mid)}/logs?service=${encodeURIComponent(sid)}&tail=150`);
      out.textContent = body.logs || "(prázdné)";
      out.scrollTop = out.scrollHeight;
    } catch (e) { out.textContent = `Chyba: ${e.message}`; }
  });
}

function renderGpuSelect() {
  const sel = state.gpuSelection;
  if (!sel || !sel.devices || !sel.devices.length) {
    return "<p class='text-text-muted text-xs'>GPU informace nedostupné</p>";
  }
  const requested = sel.requested_device;
  const buttons = ['<button class="btn btn-sm btn-block ' + (requested === "auto" ? "btn-primary" : "btn-secondary") + '" data-gpu-sel="auto">Auto</button>'];
  for (const d of sel.devices) {
    const isActive = requested === d.index;
    const vramFree = Math.round(d.vram_free_mb / 1024);
    buttons.push(`<button class="btn btn-sm btn-block ${isActive ? "btn-primary" : "btn-secondary"}" data-gpu-sel="${d.index}">GPU ${d.index}: ${escapeHtml(d.name)} (${vramFree} GB volné)</button>`);
  }
  return `
    <div class="space-y-2">
      ${buttons.join("")}
      <p class="text-[10px] text-text-muted mt-1">Auto: model jde na GPU s nejvíc volné VRAM (rezerva 2 GB); načtený model zůstává pinutý na své GPU do změny modelu.</p>
      ${sel.loaded_device ? `<p class="text-[10px] text-amber-400">Načteno: ${escapeHtml(sel.loaded_device)}</p>` : ""}
    </div>`;
}

// ── Preset grids ─────────────────────────────────────────

function presetGrid(kind) {
  const presets = state.templates.filter(t => t.kind === kind);
  if (!presets.length) return "<p class='text-text-muted text-xs'>Žádné presety — vytvoř je v Templates.</p>";
  return `<div class="grid grid-cols-1 gap-2 max-h-40 overflow-y-auto pr-1">${presets.map(t => `
    <button class="preset-tile text-left" data-preset-id="${t.id}">
      <span class="block text-on-surface">${escapeHtml(t.name)}</span>
      ${t.category ? `<span class="block text-[10px] text-text-muted">${escapeHtml(t.category)}</span>` : ""}
    </button>`).join("")}</div>`;
}

function applyPreset(t) {
  if (!t) return;
  if (t.kind === "tts_text") {
    state.tts.text = t.content;
    const el = $("#tts-text");
    if (el) el.value = t.content;
  } else if (t.kind === "image_prompt") {
    state.img.prompt = t.content;
    const el = $("#img-prompt");
    if (el) el.value = t.content;
  } else if (t.kind === "negative_prompt") {
    state.img.negative_prompt = t.content;
    const el = $("#img-negative");
    if (el) el.value = t.content;
  } else if (t.kind === "voice_instruction") {
    state.tts.instruction = t.content;
    const el = $("#tts-instruction");
    if (el) el.value = t.content;
  }
}

function bindPresets(root) {
  $$(".preset-tile", root).forEach(btn => {
    btn.addEventListener("click", () => {
      const id = parseInt(btn.dataset.presetId);
      const t = state.templates.find(x => x.id === id);
      applyPreset(t);
      toast(`Preset „${t ? t.name : ""}“ použit`);
    });
  });
}

// ── HUB (multi-stroj, design hub-ui.md) ──────────────────

async function pollHubMachines() {
  try {
    const { body } = await api("/api/hub/machines");
    state.hub.machines = body.machines || [];
    renderClusterWidget();
  } catch (_) {}
}

function hubMachineById(id) {
  return state.hub.machines.find(m => m.id === id) || null;
}

function activeMachine() {
  return hubMachineById(state.hub.activeMachine) || state.hub.machines[0] || null;
}

function setActiveMachine(id) {
  state.hub.activeMachine = id;
  localStorage.setItem("hub-machine", id);
  renderClusterWidget();
  // tlačítko Generovat nese jméno stroje — přepočítat, pokud je view aktivní
  if (state.view === "generate") renderGenerate($("#content"));
}

function hubDot(status) {
  if (status === "online") return '<span class="svc-dot svc-online"></span> online';
  if (status === "degraded") return '<span class="svc-dot svc-degraded"></span> degraded';
  return '<span class="svc-dot svc-down"></span> down';
}

function fmtGb(mb) { return `${(mb / 1024).toFixed(1)}GB`; }

// ── Cluster management (add via IP, remove, assignments) ──

function renderClusterManage() {
  const el = $("#cluster-manage");
  if (!el) return;
  const ms = state.hub.machines;
  el.innerHTML = `
    <div class="space-y-2">
      ${ms.map(m => `
        <div class="flex items-center justify-between gap-2 py-1.5 border-b border-border/50 last:border-0">
          <div>
            <span class="text-xs font-bold text-on-surface">${escapeHtml(m.name)}</span>
            <span class="text-[9px] font-label-mono text-text-muted ml-1">${escapeHtml((m.url || "").replace(/^https?:\/\//, ""))}</span>
            <span class="ml-1 text-[9px]">${hubDot(m.status)}</span>
          </div>
          <button class="btn btn-sm btn-danger" data-cluster-remove="${m.id}">Odebrat</button>
        </div>`).join("")}
      <form id="cluster-add-form" class="flex gap-2 pt-1">
        <input id="cluster-add-url" class="input input-sm flex-1 font-mono text-xs" placeholder="http://192.168.10.60:8288" required />
        <button class="btn btn-sm btn-primary" type="submit">Přidat stroj</button>
      </form>
    </div>`;
  $$("[data-cluster-remove]", el).forEach(b =>
    b.addEventListener("click", async () => {
      const id = b.dataset.clusterRemove;
      if (!confirm(`Odebrat stroj ${id}? Assignmenty se upraví (fallback povýší).`)) return;
      b.disabled = true;
      try {
        await api(`/api/hub/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
        toast(`Stroj ${id} odebrán`);
        await pollHubMachines();
        renderClusterManage();
        await renderAssignments();
      } catch (e) { toast(`Odebrání selhalo: ${e.message}`, "error"); b.disabled = false; }
    }));
  $("#cluster-add-form", el).addEventListener("submit", async e => {
    e.preventDefault();
    const url = $("#cluster-add-url").value.trim();
    try {
      await api("/api/hub/machines", { method: "POST", body: JSON.stringify({ url }) });
      toast("Stroj přidán");
      await pollHubMachines();
      renderClusterManage();
      await renderAssignments();
    } catch (err) { toast(`Přidání selhalo: ${err.message}`, "error"); }
  });
}

const KNOWN_SERVICES = ["comfyui", "tts", "stt", "video", "llm"];

async function renderAssignments() {
  const el = $("#assignments-list");
  if (!el) return;
  let assigns = {};
  try {
    ({ body: { assignments: assigns } } = await api("/api/hub/assignments"));
  } catch (_) {}
  const ms = state.hub.machines;
  const opts = sel => ['<option value="">—</option>']
    .concat(ms.map(m => `<option value="${m.id}" ${sel === m.id ? "selected" : ""}>${escapeHtml(m.name)}</option>`))
    .join("");
  const rows = Object.entries(assigns);
  for (const s of KNOWN_SERVICES.filter(s => !rows.some(([svc]) => svc === s))) {
    rows.push([s, { machine: null, reason: "bez assignmentu", primary: null, fallback: null }]);
  }
  const svcRow = ([svc, r]) => `
    <div class="py-2 border-b border-border/50 last:border-0" data-svc-row="${escapeHtml(svc)}">
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold text-on-surface">${escapeHtml(svc)}</span>
        <span class="text-[9px] ${r.machine ? "text-primary" : "text-amber-400"}">${r.machine ? `→ ${escapeHtml(r.machine)} (${escapeHtml(r.reason)})` : "bez stroje"}</span>
      </div>
      <div class="grid grid-cols-2 gap-2 mt-1">
        <select class="input input-sm text-xs" data-asg-primary="${escapeHtml(svc)}" title="Primární">${opts(r.primary)}</select>
        <select class="input input-sm text-xs" data-asg-fallback="${escapeHtml(svc)}" title="Fallback">${opts(r.fallback)}</select>
      </div>
    </div>`;
  el.innerHTML = rows.map(svcRow).join("");
  $$("[data-asg-primary], [data-asg-fallback]", el).forEach(sel =>
    sel.addEventListener("change", async () => {
      const svc = sel.getAttribute(sel.hasAttribute("data-asg-primary") ? "data-asg-primary" : "data-asg-fallback");
      const row = $(`[data-svc-row="${CSS.escape(svc)}"]`, el);
      const prim = $("[data-asg-primary]", row);
      const fb = $("[data-asg-fallback]", row);
      try {
        await api("/api/hub/assignment", { method: "POST", body: JSON.stringify({
          service: svc,
          primary: prim.value || null,
          fallback: fb.value || null,
        }) });
        toast(`Assignment ${svc} uložen`);
        await renderAssignments();
      } catch (e) { toast(`Uložení selhalo: ${e.message}`, "error"); }
    }));
}

async function loadRecommendation(modelId) {
  if (!modelId) { state.hub.rec = null; state.hub.recModel = ""; return; }
  try {
    const { body } = await api(`/api/hub/recommend/${encodeURIComponent(modelId)}`);
    if (state.hub.recModel === modelId) {  // jen když mezitím nezměnil výběr
      state.hub.rec = body.machines || [];
    }
  } catch (e) {
    state.hub.rec = null;
    toast(`Doporučení selhalo: ${e.message}`, "error");
  }
}

function renderRecommendSection() {
  const rec = state.hub.rec;
  if (!rec || !rec.length) return "<p class='text-text-muted text-xs'>Vyber model — doporučené stroje se zobrazí tady.</p>";
  return rec.map((m, i) => `
    <button class="rec-machine ${m.ok ? "rec-ok" : "rec-bad"} ${m.id === state.hub.activeMachine ? "rec-active" : ""}"
            data-rec-machine="${m.ok ? m.id : ""}" ${m.ok ? "" : "disabled title='nemožné: " + escapeAttribute(m.reason) + "'"}>
      <span class="text-xs">${m.ok ? "●" : "○"} ${escapeHtml(m.name)}</span>
      <span class="text-[10px] text-text-muted">${m.ok ? "✓ " + escapeHtml(m.reason) : "✗ " + escapeHtml(m.reason)}</span>
      ${i === 0 && m.ok ? '<span class="text-[9px] text-primary font-bold">← doporučeno</span>' : ""}
    </button>`).join("");
}

function renderGenerate(el) {
  const models = state.models;
  const grouped = {
    tts: models.filter(m => m.kind === "tts"),
    image: models.filter(m => m.kind === "image"),
  };
  const isTtsModel = grouped.tts.some(m => m.id === state.tts.model);
  const modelOptions = `
    <optgroup label="TTS">${grouped.tts.map(m => `<option value="${escapeAttribute(m.id)}" ${isTtsModel && m.id === state.tts.model ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</optgroup>
    <optgroup label="Image">${grouped.image.map(m => `<option value="${escapeAttribute(m.id)}" ${!isTtsModel && m.id === state.img.model ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("")}</optgroup>`;
  const mach = activeMachine();
  const genBtnLabel = mach ? `▶ Generovat na ${mach.name}` : "▶ Generovat";

  el.innerHTML = `
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-4">
      <div class="xl:col-span-2 space-y-4">
        <div class="card">
          <div class="grid grid-cols-1 md:grid-cols-[1fr_260px] gap-3 items-start">
            <div>
              <h3 class="font-bold text-on-surface mb-2"><span class="text-primary">①</span> MODEL</h3>
              <select id="gen-model" class="control control-block field">${modelOptions}</select>
              ${isTtsModel
                ? `<textarea id="tts-text" rows="5" class="control control-block control-area field mt-3" placeholder="Text k syntéze...">${escapeHtml(state.tts.text)}</textarea>`
                : `<textarea id="img-prompt" rows="5" class="control control-block control-area field mt-3" placeholder="Popis obrázku...">${escapeHtml(state.img.prompt)}</textarea>`}
            </div>
            <div>
              <h3 class="font-bold text-on-surface mb-2"><span class="text-primary">②</span> KDE TO POBĚŽÍ</h3>
              <div id="gen-recommend" class="space-y-1.5">${renderRecommendSection()}</div>
              <button id="btn-gen-run" class="btn btn-primary btn-lg w-full mt-3">${genBtnLabel}</button>
            </div>
          </div>
        </div>
        <div class="card">
          <h3 class="font-bold text-on-surface mb-3"><span class="text-primary">③</span> PARAMETRY <span class="text-[10px] text-text-muted font-normal">(sdílené se studii)</span></h3>
          <div id="gen-params">
            ${isTtsModel ? `${ttsParamsHtml()}${ttsPresetChips()}` : imageParamsHtml()}
          </div>
        </div>
        <div id="gen-progress"></div>
      </div>
      <div class="space-y-4">
        <div id="gen-result-panel"></div>
      </div>
    </div>`;

  const renderResultPanel = () => {
    const panel = $("#gen-result-panel");
    if (!panel) return;
    if (state.result && state.result.url) {
      panel.innerHTML = state.result.kind === "tts"
        ? card("Výsledek", `<audio controls src="${state.result.url}" class="w-full"></audio><div class="mt-2 text-xs text-text-muted">${state.result.durationMs ? "Čas: " + fmtDuration(state.result.durationMs) : ""}${state.result.seed != null ? " · seed " + state.result.seed : ""}</div>`)
        : card("Výsledek", `<img src="${state.result.url}" class="result-image w-full rounded-lg border border-border" alt="výsledek"><div class="mt-2 text-xs text-text-muted">${state.result.durationMs ? "Čas: " + fmtDuration(state.result.durationMs) : ""}${state.result.seed != null ? " · seed " + state.result.seed : ""}</div>`);
    } else if (state.generating) {
      panel.innerHTML = card("Generuji…", `<div class="text-xs text-text-muted">${escapeHtml(state.generating.model || "")} — průběh v Live Logs</div>`);
    } else {
      panel.innerHTML = card("Výsledek", "<p class='text-text-muted text-xs'>Zatím nic — spusť generaci.</p>");
    }
  };
  renderResultPanel();
  state._genRenderResultPanel = renderResultPanel;

  $("#gen-model").addEventListener("change", async e => {
    const id = e.target.value;
    const m = state.models.find(x => x.id === id);
    if (m?.kind === "tts") { state.tts.model = id; state.img.model = ""; }
    else { state.img.model = id; state.tts.model = ""; }
    state.hub.recModel = id;
    state.hub.rec = null;
    renderGenerate(el);
    await loadRecommendation(id);
    renderRecommendInto();
  });
  if (isTtsModel) {
    $("#tts-text").addEventListener("input", e => { state.tts.text = e.target.value; });
    bindTtsParams(() => renderGenerate(el));
    bindTtsPresetChips(el);
  } else {
    $("#img-prompt").addEventListener("input", e => { state.img.prompt = e.target.value; });
    bindImageParams(() => renderGenerate(el));
    updateImageDefaults();
  }
  $$("[data-rec-machine]").forEach(b => b.addEventListener("click", () => setActiveMachine(b.dataset.recMachine)));
  $("#btn-gen-run").addEventListener("click", runGenerate);
}

function renderRecommendInto() {
  const box = $("#gen-recommend");
  if (!box) return;
  box.innerHTML = renderRecommendSection();
  $$("[data-rec-machine]", box).forEach(b => b.addEventListener("click", () => setActiveMachine(b.dataset.recMachine)));
}

async function runGenerate() {
  const mach = activeMachine();
  if (!mach) { toast("Žádný stroj v clusteru", "error"); return; }
  const isTts = state.models.find(m => m.id === state.tts.model) != null && !!state.tts.text;
  const btn = $("#btn-gen-run");
  btn.disabled = true;
  btn.textContent = "Generuji…";
  const t0 = performance.now();
  try {
    const payload = isTts
      ? { model: state.tts.model, text: state.tts.text, language: state.tts.language || "cs",
          seed: state.tts.seed, voice: state.tts.voice || undefined,
          instruction: state.tts.instruction || undefined, quality: state.tts.quality || undefined }
      : { model: state.img.model, prompt: state.img.prompt, negative_prompt: state.img.negative_prompt || undefined,
          seed: state.img.seed, width: state.img.width, height: state.img.height,
          steps: state.img.steps, cfg: state.img.cfg };
    // FÁZE 2 pravidlo: uživatel vybere stroj; volání jde same-origin na webapp,
    // který ho přeposlel na vybraný stroj (machine-aware proxy, žádný CORS problém)
    const { body: blob, headers } = await api("/api/generate", {
      method: "POST", body: JSON.stringify({ ...payload, machine: mach.id }),
    });
    const url = URL.createObjectURL(blob instanceof Blob ? blob : new Blob([body]));
    state.result = { kind: isTts ? "tts" : "image", url, blob, durationMs: performance.now() - t0, seed: payload.seed };
    toast(`Vygenerováno na ${mach.name}`);
    state._genRenderResultPanel?.();
  } catch (e) {
    toast(`Generace na ${mach?.name} selhala: ${e.message}`, "error");
    state._genRenderResultPanel?.();
  } finally {
    if (btn.isConnected) { btn.disabled = false; btn.textContent = `▶ Generovat na ${mach.name}`; }
  }
}

// ── TTS Studio ───────────────────────────────────────────

// ── Sdílené TTS parametry (TTS Studio i Generovat — jediný zdroj pravdy) ──

function ttsPresetChips() {
  const chips = state.templates.filter(t => t.kind === "tts_text").slice(0, 12).map(t =>
    `<button class="preset-chip" data-preset-id="${t.id}" title="${escapeAttribute(t.content.slice(0, 80))}">${escapeHtml(t.name)}</button>`
  ).join("");
  return chips ? `<div class="mt-3"><div class="text-[10px] text-text-muted mb-1">Presety textů</div><div class="flex gap-1.5 overflow-x-auto">${chips}</div></div>` : "";
}

function bindTtsPresetChips(rootEl) {
  $$("[data-preset-id]", rootEl).forEach(btn => {
    btn.addEventListener("click", () => {
      const t = state.templates.find(x => x.id === parseInt(btn.dataset.presetId));
      if (!t) return;
      state.tts.text = t.content;
      const el2 = $("#tts-text");
      if (el2) el2.value = t.content;
      toast(`Preset „${t.name}“ použit`);
    });
  });
}

function ttsParamsHtml() {
  const s = state.tts;
  const isMossV15 = s.model === "moss-tts-v1.5";
  const isQwen3 = s.model === "qwen3-tts-1.7b-customvoice";
  const isSoundEffect = s.model === "moss-soundeffect-v2";
  const qwenVoiceOptions = ["Ryan", "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Aiden", "Ono_Anna", "Sohee"]
    .map(v => `<option value="${v}" ${v === s.voice ? "selected" : ""}>${v}</option>`).join("");
  const voiceOptions = state.voices.map(v => {
    const label = v.name || v.voice_id;
    return `<option value="${escapeAttribute(v.voice_id)}" ${v.voice_id === s.voice ? "selected" : ""}>${escapeHtml(label)}${v.instruction ? " — " + escapeHtml(v.instruction.slice(0, 40)) : ""}</option>`;
  }).join("");
  const availableLanguages = isQwen3 ? QWEN3_LANGUAGES : LANGUAGES;
  if (!availableLanguages.includes(s.language)) s.language = "en";
  const langOptions = availableLanguages.map(l => `<option value="${l}" ${l === s.language ? "selected" : ""}>${l}</option>`).join("");
  const qualityOptions = QUALITIES.map(q => `<option value="${q}" ${q === s.quality ? "selected" : ""}>${q || "default"}</option>`).join("");
  const adv = s.showAdvanced ? "block" : "hidden";
  const advCount = [s.temperature, s.top_p, s.top_k, s.repetition_penalty, s.max_new_tokens, s.speed, s.response_format].filter(v => v != null && v !== "").length;
  const formatOptions = RESPONSE_FORMATS.map(f => `<option value="${f}" ${f === s.response_format ? "selected" : ""}>${f || "default (wav)"}</option>`).join("");
  return `
    ${vramWarning(s.model)}
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
      <div><label class="text-[10px] text-text-muted">Jazyk</label><select id="tts-language" class="control control-block field">${langOptions}</select></div>
      <div><label class="text-[10px] text-text-muted">Seed</label><div class="flex gap-1"><input id="tts-seed" type="number" value="${s.seed}" class="control control-block field flex-1" ${s.seedRandom ? "disabled" : ""}><button id="tts-seed-rnd" class="btn btn-secondary btn-sm ${s.seedRandom ? "btn-on" : ""}" title="Náhodný seed při každé generaci">🎲</button></div></div>
      ${isMossV15 || isQwen3 ? `<div><label class="text-[10px] text-text-muted">Voice</label><div class="flex gap-1"><select id="tts-voice" class="control control-block field flex-1" ${s.refAudio ? "disabled" : ""}>${isQwen3 ? qwenVoiceOptions : `<option value="">— žádný —</option>${voiceOptions}`}</select>${isMossV15 ? `<button id="btn-play-voice" class="btn btn-secondary btn-sm" title="Přehrát náhled">▶</button>` : ""}</div></div>` : ""}
      ${isMossV15 ? `<div><label class="text-[10px] text-text-muted">Quality</label><select id="tts-quality" class="control control-block field">${qualityOptions}</select></div>` : ""}
    </div>
    ${isMossV15 ? `
    <div class="mt-3">
      <label class="text-[10px] text-text-muted">Referenční audio — voice cloning (WAV/FLAC, max 20 MB)</label>
      <div class="flex gap-2 items-center mt-1 flex-wrap">
        <input id="tts-ref-audio-file" type="file" accept=".wav,.flac,audio/wav,audio/flac,audio/x-flac" class="hidden">
        <button id="btn-ref-audio" class="btn btn-secondary btn-sm">📁 Nahrát referenční audio</button>
        ${s.refAudio ? `
          <span class="preset-chip">${escapeHtml(s.refAudio.name)}</span>
          <button id="btn-ref-audio-play" class="btn btn-secondary btn-sm" title="Přehrát náhled">▶</button>
          <button id="btn-ref-audio-clear" class="btn btn-danger btn-sm" title="Odebrat">✕</button>
          <span class="text-[10px] text-amber-400">Voice preset je při použití referenčního audia ignorován (backend je vzájemně vylučuje).</span>
        ` : ""}
      </div>
    </div>` : ""}
    <div class="mt-3"><label class="text-[10px] text-text-muted">Instrukce (voice/style)</label><textarea id="tts-instruction" rows="2" class="control control-block control-area field" placeholder="Např. Klidný mužský hlas...">${escapeHtml(s.instruction)}</textarea></div>
    ${isMossV15 ? `<div class="grid grid-cols-2 gap-3 mt-3"><div><label class="text-[10px] text-text-muted">Sound event</label><input id="tts-sound-event" type="text" value="${escapeAttribute(s.sound_event)}" class="control control-block field" placeholder="news jingle"></div><div><label class="text-[10px] text-text-muted">Ambient</label><input id="tts-ambient" type="text" value="${escapeAttribute(s.ambient_sound)}" class="control control-block field" placeholder="quiet office"></div></div>` : ""}
    ${isSoundEffect ? `<p class="text-xs text-amber-400 mt-2">MOSS SoundEffect v2 — text slouží jako sound prompt.</p>` : ""}
    <button id="tts-toggle-adv" class="text-xs text-text-muted hover:text-on-surface mt-3">Pokročilé (${advCount}) ▾</button>
    <div id="tts-adv" class="${adv} grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3 mt-2">
      <div><label class="text-[10px] text-text-muted">temp</label><input id="tts-temperature" type="number" step="0.1" value="${s.temperature ?? ""}" class="control control-block field" placeholder="—"></div>
      <div><label class="text-[10px] text-text-muted">top_p</label><input id="tts-top-p" type="number" step="0.05" value="${s.top_p ?? ""}" class="control control-block field" placeholder="—"></div>
      <div><label class="text-[10px] text-text-muted">top_k</label><input id="tts-top-k" type="number" step="0.05" value="${s.top_k ?? ""}" class="control control-block field" placeholder="—"></div>
      <div><label class="text-[10px] text-text-muted">rep_pen</label><input id="tts-rep-pen" type="number" step="0.1" value="${s.repetition_penalty ?? ""}" class="control control-block field" placeholder="—"></div>
      <div><label class="text-[10px] text-text-muted">max_tokens</label><input id="tts-max-tokens" type="number" value="${s.max_new_tokens ?? ""}" class="control control-block field" placeholder="—"></div>
      <div><label class="text-[10px] text-text-muted">speed</label><input id="tts-speed" type="number" step="0.1" min="0.25" max="4" value="${s.speed ?? ""}" class="control control-block field" placeholder="1.0"></div>
      <div><label class="text-[10px] text-text-muted">format</label><select id="tts-format" class="control control-block field">${formatOptions}</select></div>
    </div>`;
}

function bindTtsParams(onChange) {
  $("#tts-language")?.addEventListener("change", e => { state.tts.language = e.target.value; onChange?.(); });
  $("#tts-seed")?.addEventListener("input", e => { state.tts.seed = parseIntOr(e.target.value, 42); });
  $("#tts-seed-rnd")?.addEventListener("click", () => { state.tts.seedRandom = !state.tts.seedRandom; onChange ? onChange() : render(); });
  $("#tts-voice")?.addEventListener("change", e => { state.tts.voice = e.target.value; });
  $("#tts-sound-event")?.addEventListener("input", e => { state.tts.sound_event = e.target.value; });
  $("#tts-ambient")?.addEventListener("input", e => { state.tts.ambient_sound = e.target.value; });
  $("#tts-quality")?.addEventListener("change", e => { state.tts.quality = e.target.value; });
  $("#tts-speed")?.addEventListener("input", e => { state.tts.speed = e.target.value === "" ? null : parseFloat(e.target.value); });
  $("#tts-format")?.addEventListener("change", e => { state.tts.response_format = e.target.value; });
  $("#tts-temperature")?.addEventListener("input", e => { state.tts.temperature = e.target.value === "" ? null : parseFloat(e.target.value); });
  $("#tts-top-p")?.addEventListener("input", e => { state.tts.top_p = e.target.value === "" ? null : parseFloat(e.target.value); });
  $("#tts-top-k")?.addEventListener("input", e => { state.tts.top_k = e.target.value === "" ? null : parseInt(e.target.value); });
  $("#tts-rep-pen")?.addEventListener("input", e => { state.tts.repetition_penalty = e.target.value === "" ? null : parseFloat(e.target.value); });
  $("#tts-max-tokens")?.addEventListener("input", e => { state.tts.max_new_tokens = e.target.value === "" ? null : parseInt(e.target.value); });
  $("#tts-toggle-adv")?.addEventListener("click", () => { state.tts.showAdvanced = !state.tts.showAdvanced; onChange ? onChange() : render(); });
  $("#tts-instruction")?.addEventListener("input", e => { state.tts.instruction = e.target.value; });
  // Referenční audio (voice cloning)
  $("#btn-ref-audio")?.addEventListener("click", () => $("#tts-ref-audio-file")?.click());
  $("#tts-ref-audio-file")?.addEventListener("change", e => {
    const file = e.target.files && e.target.files[0];
    if (file) loadRefAudioFile(file);
  });
  $("#btn-ref-audio-clear")?.addEventListener("click", () => {
    if (state.tts.refAudio && state.tts.refAudio.blobUrl) URL.revokeObjectURL(state.tts.refAudio.blobUrl);
    state.tts.refAudio = null;
    onChange ? onChange() : render();
  });
  $("#btn-ref-audio-play")?.addEventListener("click", () => {
    const ra = state.tts.refAudio;
    if (!ra || !ra.blobUrl) { toast("Žádné referenční audio", "error"); return; }
    new Audio(ra.blobUrl).play().catch(err => toast(`Přehrání selhalo: ${err.message}`, "error"));
  });
  $("#btn-play-voice")?.addEventListener("click", () => {
    const voiceId = $("#tts-voice")?.value;
    if (!voiceId) { toast("Vyber voice preset", "error"); return; }
    playVoicePreview(voiceId);
  });
}

// ── Sdílené Image parametry (Image Studio i Generovat) ────

function imageParamsHtml() {
  const s = state.img;
  const resPresets = RES_PRESETS.map(([w, h]) =>
    `<button class="preset-chip ${s.width === w && s.height === h ? "preset-chip-active" : ""}" data-res="${w}x${h}">${w}×${h}</button>`).join("");
  const promptChips = state.templates.filter(t => t.kind === "image_prompt").slice(0, 12).map(t =>
    `<button class="preset-chip" data-img-preset="${t.id}" title="${escapeAttribute(t.content.slice(0, 80))}">${escapeHtml(t.name)}</button>`).join("");
  const negChips = state.templates.filter(t => t.kind === "image_negative").slice(0, 12).map(t =>
    `<button class="preset-chip" data-neg-preset="${t.id}" title="${escapeAttribute(t.content.slice(0, 80))}">${escapeHtml(t.name)}</button>`).join("");
  return `
    ${vramWarning(s.model)}
    <div class="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3">
      <div><label class="text-[10px] text-text-muted">Width</label><input id="img-width" type="number" value="${s.width}" class="control control-block field"></div>
      <div><label class="text-[10px] text-text-muted">Height</label><input id="img-height" type="number" value="${s.height}" class="control control-block field"></div>
      <div><label class="text-[10px] text-text-muted">Steps</label><input id="img-steps" type="number" value="${s.steps ?? ""}" class="control control-block field" placeholder="default"></div>
      <div><label class="text-[10px] text-text-muted">CFG</label><input id="img-cfg" type="number" step="0.1" value="${s.cfg ?? ""}" class="control control-block field" placeholder="default"></div>
      <div><label class="text-[10px] text-text-muted">Seed</label><div class="flex gap-1"><input id="img-seed" type="number" value="${s.seed}" class="control control-block field flex-1" ${s.seedRandom ? "disabled" : ""}><button id="img-seed-rnd" class="btn btn-secondary btn-sm ${s.seedRandom ? "btn-on" : ""}" title="Náhodný seed při každé generaci">🎲</button></div></div>
    </div>
    <div class="mt-2 flex items-center gap-1.5 flex-wrap">
      <span class="text-[10px] text-text-muted">Rozlišení:</span>
      ${resPresets}
      <button id="btn-swap-res" class="preset-chip" title="Prohodit šířku a výšku">⇄</button>
    </div>
    <div class="mt-2"><label class="text-[10px] text-text-muted">Negative prompt</label><textarea id="img-negative" rows="2" class="control control-block control-area field">${escapeHtml(s.negative_prompt)}</textarea></div>
    ${promptChips ? `<div class="mt-2"><div class="text-[10px] text-text-muted mb-1">Prompt presety</div><div class="flex gap-1.5 overflow-x-auto">${promptChips}</div></div>` : ""}
    ${negChips ? `<div class="mt-2"><div class="text-[10px] text-text-muted mb-1">Negative presety</div><div class="flex gap-1.5 overflow-x-auto">${negChips}</div></div>` : ""}`;
}

function bindImageParams(onChange) {
  $("#img-steps")?.addEventListener("input", e => { state.img.steps = e.target.value === "" ? null : parseInt(e.target.value); });
  $("#img-cfg")?.addEventListener("input", e => { state.img.cfg = e.target.value === "" ? null : parseFloat(e.target.value); });
  $("#img-seed")?.addEventListener("input", e => { state.img.seed = parseIntOr(e.target.value, 42); });
  $("#img-seed-rnd")?.addEventListener("click", () => { state.img.seedRandom = !state.img.seedRandom; onChange ? onChange() : render(); });
  $("#img-width")?.addEventListener("input", e => { state.img.width = parseInt(e.target.value) || 1024; });
  $("#img-height")?.addEventListener("input", e => { state.img.height = parseInt(e.target.value) || 1024; });
  $("#img-negative")?.addEventListener("input", e => { state.img.negative_prompt = e.target.value; });
  $("#btn-swap-res")?.addEventListener("click", () => {
    const w = state.img.width; state.img.width = state.img.height; state.img.height = w;
    onChange ? onChange() : render();
  });
  $$("[data-res]")?.forEach(b => b.addEventListener("click", () => {
    const [w, h] = b.dataset.res.split("x").map(Number);
    state.img.width = w; state.img.height = h;
    onChange ? onChange() : render();
  }));
  $$("[data-img-preset]")?.forEach(btn => btn.addEventListener("click", () => {
    const t = state.templates.find(x => x.id === parseInt(btn.dataset.imgPreset));
    if (t) { state.img.prompt = t.content; const el2 = $("#img-prompt") || $("#gen-prompt"); if (el2) el2.value = t.content; toast(`Preset „${t.name}“ použit`); }
  }));
  $$("[data-neg-preset]")?.forEach(btn => btn.addEventListener("click", () => {
    const t = state.templates.find(x => x.id === parseInt(btn.dataset.negPreset));
    if (t) { state.img.negative_prompt = t.content; const el2 = $("#img-negative"); if (el2) el2.value = t.content; toast(`Negative „${t.name}“ použit`); }
  }));
}

function renderTts(el) {
  const tts = state.models.filter(m => m.kind === "tts");
  const s = state.tts;

  const modelOptions = tts.map(m => `<option value="${escapeAttribute(m.id)}" ${m.id === s.model ? "selected" : ""}>${escapeHtml(m.name)}</option>`).join("");

  const presetChips = state.templates.filter(t => t.kind === "tts_text").slice(0, 12).map(t =>
    `<button class="preset-chip" data-preset-id="${t.id}" title="${escapeAttribute(t.content.slice(0, 80))}">${escapeHtml(t.name)}</button>`
  ).join("");

  el.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 acc-tts">
      <div class="lg:col-span-2 space-y-4">
        <div class="card">
          <div class="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-3 items-start">
            <select id="tts-model" class="control control-block field">${modelOptions}</select>
            <textarea id="tts-text" rows="4" class="control control-block control-area field" placeholder="Zadej text k syntéze...">${escapeHtml(s.text)}</textarea>
            <button id="btn-generate-tts" class="btn btn-primary btn-lg">Vygenerovat</button>
          </div>
          ${ttsParamsHtml()}
          ${presetChips ? `<div class="mt-3"><div class="text-[10px] text-text-muted mb-1">Presety</div><div class="flex gap-1.5 overflow-x-auto">${presetChips}</div></div>` : ""}
        </div>
      </div>
      <div class="space-y-4">
        ${card("Voice Designer", `
          <div class="space-y-2">
            <textarea id="vd-instruction" rows="2" class="control control-block control-area field">${escapeHtml(state.voiceDesign.instruction)}</textarea>
            <textarea id="vd-reference" rows="2" class="control control-block control-area field">${escapeHtml(state.voiceDesign.reference_text)}</textarea>
            <div class="grid grid-cols-2 gap-2">
              <select id="vd-language" class="control control-block field">${(state.tts.model === "qwen3-tts-1.7b-customvoice" ? QWEN3_LANGUAGES : LANGUAGES).map(l => `<option value="${l}">${l}</option>`).join("")}</select>
              <input id="vd-seed" type="number" value="${state.voiceDesign.seed}" class="control control-block field">
            </div>
            <input id="vd-voice-id" type="text" value="${escapeAttribute(state.voiceDesign.voice_id)}" class="control control-block field" placeholder="voice id (auto)">
            <button id="btn-design-voice" class="btn btn-primary btn-md btn-block">Vytvořit voice preset</button>
          </div>`)}
        ${state.generating && state.generating.kind === "tts" ? renderProgress() : renderTtsResult()}
      </div>
    </div>`;

  $("#tts-model").addEventListener("change", e => { state.tts.model = e.target.value; render(); });
  $("#tts-text").addEventListener("input", e => { state.tts.text = e.target.value; });
  bindTtsParams();
  $("#btn-generate-tts").addEventListener("click", generateTts);
  $("#btn-cancel-gen")?.addEventListener("click", cancelGeneration);
  $("#btn-design-voice").addEventListener("click", designVoice);
  const saveBtn = $("#btn-save-voice");
  if (saveBtn) saveBtn.addEventListener("click", saveVoiceFromResult);

  bindTtsPresetChips(document);

  if (state.tts.model === "moss-tts-v1.5" && state.voices.length && s.voice) {
    $("#tts-voice").value = s.voice;
  }
}

function renderTtsResult() {
  if (!state.result || state.result.kind !== "tts") {
    return card("Výsledek", "<p class='text-text-muted text-xs'>Žádný výstup zatím.</p>");
  }
  const hasAudio = !!state.result.url;
  const hasError = !!state.result.error;
  return card("Výsledek", `
    ${hasError ? `<p class="text-red-400 text-xs">${escapeHtml(state.result.error)}</p>` : ""}
    ${hasAudio ? `<audio controls src="${state.result.url}" class="w-full mt-2"></audio>` : ""}
    ${hasAudio ? `<canvas id="waveform" class="w-full h-16 mt-3 bg-surface-dim rounded-lg"></canvas>` : ""}
    <div class="mt-3 text-xs text-text-muted flex items-center justify-between">
      <span>${state.result.durationMs ? `Čas: ${fmtDuration(state.result.durationMs)}` : ""}${state.result.seed != null ? ` · seed ${state.result.seed}` : ""}</span>
      ${hasAudio ? `<button id="btn-save-voice" class="btn btn-secondary btn-sm">Uložit jako hlas</button>` : ""}
    </div>`);
}

async function saveVoiceFromResult() {
  const blob = state.result && state.result.blob;
  if (!blob) { toast("Žádné audio k uložení", "error"); return; }
  const modal = $("#modal-container");
  const suggested = state.tts.model ? state.tts.model.replace(/^moss-tts-v1\.5$/, "Můj hlas") : "";
  modal.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-card">
        <h3 class="font-bold text-on-surface mb-4">Uložit hlas</h3>
        <div class="space-y-3">
          <input id="sv-name" placeholder="Název hlasu (např. Cizinec)" value="${escapeAttribute(suggested)}" class="w-full control">
          <p class="text-xs text-text-muted">Referenční text bude použit z právě vygenerovaného promptu.</p>
        </div>
        <div class="flex gap-2 mt-4">
          <button id="sv-save" class="flex-1 btn btn-primary btn-md">Uložit</button>
          <button id="sv-cancel" class="btn btn-secondary btn-md">Zrušit</button>
        </div>
      </div>
    </div>`;
  modal.classList.remove("hidden");
  $("#sv-cancel").addEventListener("click", () => { modal.classList.add("hidden"); modal.innerHTML = ""; });
  $("#sv-save").addEventListener("click", async () => {
    const name = $("#sv-name").value.trim();
    if (!name) { toast("Zadej název hlasu", "error"); return; }
    try {
      const audio_b64 = await blobToBase64(blob);
      const { body } = await api("/api/save-voice", {
        method: "POST",
        body: JSON.stringify({
          name,
          reference_text: state.tts.text,
          audio_b64,
          language: state.tts.language || "cs",
        }),
      });
      modal.classList.add("hidden"); modal.innerHTML = "";
      const { body: voicesBody } = await api("/api/voices");
      state.voices = voicesBody.voices || [];
      toast(`Hlas uložen: ${body.name || body.voice_id}`);
      render();
    } catch (e) {
      toast(`Uložení hlasu selhalo: ${e.message}`, "error");
    }
  });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const result = r.result || "";
      resolve(result.split(",")[1] || result);
    };
    r.onerror = () => reject(new Error("base64 conversion failed"));
    r.readAsDataURL(blob);
  });
}

async function playVoicePreview(voiceId) {
  try {
    const { body } = await api(`/api/voice/${encodeURIComponent(voiceId)}/audio`);
    const url = URL.createObjectURL(body);
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    a.play().catch(e => toast(`Přehrání selhalo: ${e.message}`, "error"));
  } catch (e) {
    toast(`Náhled hlasu selhal: ${e.message}`, "error");
  }
}

function drawWaveform(url) {
  const canvas = $("#waveform");
  if (!canvas) return;
  // skutečná waveform přes Web Audio API
  fetch(url)
    .then(r => r.arrayBuffer())
    .then(buf => new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(buf))
    .then(audio => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      const ctx = canvas.getContext("2d");
      const styles = getComputedStyle(document.documentElement);
      ctx.fillStyle = styles.getPropertyValue("--bg-dim").trim() || "#131a14";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = styles.getPropertyValue("--accent").trim() || "#4ade80";
      const data = audio.getChannelData(0);
      const bars = Math.max(60, Math.floor(canvas.width / (3 * dpr)));
      const step = Math.floor(data.length / bars) || 1;
      const barW = canvas.width / bars;
      for (let i = 0; i < bars; i++) {
        let peak = 0;
        const start = i * step;
        for (let j = start; j < start + step && j < data.length; j += 16) {
          const v = Math.abs(data[j]);
          if (v > peak) peak = v;
        }
        const h = Math.max(2 * dpr, peak * canvas.height * 0.9);
        ctx.fillRect(i * barW + dpr, (canvas.height - h) / 2, Math.max(1, barW - 2 * dpr), h);
      }
    })
    .catch(() => { /* tiché selhání — waveform je dekorativní */ });
}

// ── SSE (logy + progress pushem) ────────────────────────

let evtSource = null;
let sseLastLog = 0;

function initEvents() {
  if (evtSource || !window.EventSource) return;
  evtSource = new EventSource("/api/events");
  evtSource.onmessage = e => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    if ((ev.type === "log" || ev.type === "log-replace") && ev.line) {
      sseLastLog = Date.now();
      if (state.logsPaused) return;
      const replace = ev.type === "log-replace";
      if (replace && state.logs.length && state.logs[state.logs.length - 1].includes("%|")) state.logs.pop();
      state.logs.push(ev.line);
      if (state.logs.length > 300) state.logs.splice(0, state.logs.length - 300);
      if (state.generating) {
        const ll = state.generating.liveLogs;
        if (replace && ll.length && ll[ll.length - 1].includes("%|")) ll.pop();
        ll.push(ev.line);
        renderSoon();
      } else {
        updateLogsPanel();
      }
    } else if (ev.type === "progress" || ev.type === "stage") {
      if (state.generating) {
        state.generating.progress = Object.assign({}, state.generating.progress || {}, ev);
        renderSoon();
      }
    }
  };
  // EventSource se při výpadku připojuje sám; polling slouží jako fallback
}

function updateLogsPanel() {
  if (state.view !== "logs") return;
  const panel = $("#logs-panel");
  if (!panel) return;
  const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 80;
  panel.innerHTML = filteredLogs().map(renderLogLine).join("");
  if (nearBottom) panel.scrollTop = panel.scrollHeight;
}

// ── Beautiful Progress Panel ─────────────────────────────

function fmtEta(seconds) {
  if (seconds == null || seconds < 0) return null;
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `~${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `~${h}h ${m}m`;
}

function getStageIndex(stage) {
  const stages = ["queue", "gpu_switch", "model_load", "sampling", "executing", "decode"];
  const idx = stages.indexOf(stage);
  return idx >= 0 ? idx : 0;
}

function renderProgress() {
  const g = state.generating;
  const kind = g.kind || "tts";
  const isTts = kind === "tts";
  const elapsed = g.startMs ? ((performance.now() - g.startMs) / 1000).toFixed(1) : "0.0";
  const st = g.progress || {};
  const percent = st.percent != null ? st.percent : 0;
  const stage = st.stage || "queue";
  const isDone = stage === "done";
  const isError = stage === "error" || stage === "timeout";
  
  // Model info
  const modelName = state.models.find(m => m.id === g.model)?.name || g.model;
  const modelType = isTts ? "TTS Syntéza" : "Image Generation";
  const icon = isTts ? "record_voice_over" : "image";
  const accentClass = isTts ? "tts" : "image";
  
  // Stage configuration
  const stages = [
    { id: "queue", label: "Ve frontě", icon: "inbox" },
    { id: "gpu_switch", label: "GPU", icon: "memory" },
    { id: "model_load", label: "Model", icon: "cloud_download" },
    { id: "sampling", label: isTts ? "Syntéza" : "Sampling", icon: isTts ? "auto_awesome" : "gradient" },
    { id: "executing", label: "Zpracování", icon: "settings" },
    { id: "decode", label: "Dekódování", icon: "check_circle" },
  ];
  const currentStageIdx = isDone ? stages.length : getStageIndex(stage);
  
  // Progress details
  const unitLabel = st.kind === "tokens" ? "tokenů" : "kroků";
  const progressDetail = st.value != null && st.max ? `${Math.round(percent)}% · ${st.value}/${st.max} ${unitLabel}` : "";
  
  // ETA from prediction
  const eta = st.eta_s != null ? fmtEta(st.eta_s) : null;
  const prediction = st.prediction || {};
  const conf = prediction.confidence || "low";
  const histAvg = prediction.avg_s ? fmtEta(prediction.avg_s) : null;
  const histBasedOn = prediction.based_on || 0;
  
  // Speed info
  const speedTxt = st.speed ? `${st.speed}${st.unit === "s/it" ? " s/it" : " it/s"}` : "";
  
  // Build stages HTML
  const stagesHtml = stages.map((s, idx) => {
    let cls = "progress-stage";
    if (idx < currentStageIdx) cls += " done active";
    else if (idx === currentStageIdx) cls += ` active ${accentClass}`;
    cls += ` ${accentClass}`;
    const iconName = idx <= currentStageIdx ? "check" : s.icon;
    return `<div class="${cls}">
      <span class="material-symbols-outlined progress-stage-icon">${iconName}</span>
      ${s.label}
    </div>`;
  }).join("");
  
  // Confidence badge
  const confBadge = conf !== "low" ? `<span class="progress-confidence ${conf}">
    <span class="material-symbols-outlined" style="font-size:12px">${conf === "high" ? "verified" : "info"}</span>
    ${conf === "high" ? "Vysoká přesnost" : "Střední přesnost"}
  </span>` : "";
  
  // History hint
  const historyHint = histAvg && histBasedOn >= 2 ? `
    <div class="progress-history-hint">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 8v4l3 3"/>
        <circle cx="12" cy="12" r="9"/>
      </svg>
      <span>Průměrný čas: <strong>${histAvg}</strong> (z ${histBasedOn} generací)</span>
    </div>` : histBasedOn === 1 ? `
    <div class="progress-history-hint">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 8v4l3 3"/>
        <circle cx="12" cy="12" r="9"/>
      </svg>
      <span>První generace — čas odhadu se upřesní</span>
    </div>` : "";
  
  // Waveform for TTS
  const waveform = isTts && !isDone && !isError ? `
    <div class="progress-waveform">
      <div class="progress-waveform-bar"></div>
      <div class="progress-waveform-bar"></div>
      <div class="progress-waveform-bar"></div>
      <div class="progress-waveform-bar"></div>
      <div class="progress-waveform-bar"></div>
      <div class="progress-waveform-bar"></div>
      <div class="progress-waveform-bar"></div>
      <div class="progress-waveform-bar"></div>
      <div class="progress-waveform-bar"></div>
    </div>` : "";
  
  // Container class
  let containerClass = "progress-container";
  if (isDone) containerClass += " done";
  else if (isError) containerClass += " error";
  else containerClass += " generating";
  if (!isTts) containerClass += " image";
  
  // ETA display
  let etaDisplay = "";
  if (isDone) {
    etaDisplay = `<span class="progress-eta" style="color: var(--ok)">✓ Hotovo za ${elapsed}s</span>`;
  } else if (isError) {
    etaDisplay = `<span class="progress-eta" style="color: var(--danger)">✕ ${stage === "timeout" ? "Časový limit" : "Chyba"}</span>`;
  } else if (eta) {
    etaDisplay = `<span class="progress-eta known">Zbývá ${eta}</span>`;
  } else if (histAvg) {
    etaDisplay = `<span class="progress-eta">Odhad: ${histAvg}</span>`;
  } else {
    etaDisplay = `<span class="progress-eta">Počítám odhad...</span>`;
  }
  
  // Logs (compact)
  const logs = (g.liveLogs || []).slice(-5).map(renderLogLine).join("");
  const logsHtml = logs ? `<div class="log-panel p-2 mt-3 overflow-y-auto" style="max-height:80px;font-size:10px">${logs}</div>` : "";
  
  return `
    <div class="${containerClass}">
      <div class="progress-header">
        <div class="progress-model-badge">
          <div class="progress-model-icon ${accentClass}">
            <span class="material-symbols-outlined">${icon}</span>
          </div>
          <div>
            <div class="progress-model-name">${escapeHtml(modelName)}</div>
            <div class="progress-model-type">${modelType}</div>
          </div>
        </div>
        <div class="progress-time-info">
          <div class="progress-elapsed">${elapsed}s</div>
          ${etaDisplay}
        </div>
      </div>
      
      <div class="progress-stages">
        ${stagesHtml}
      </div>
      
      <div class="progress-track">
        <div class="progress-fill ${accentClass} ${percent > 0 ? "" : "indeterminate"}" style="width:${Math.min(percent, 100)}%"></div>
      </div>
      
      <div class="progress-stats">
        <div class="progress-stat">
          <span class="material-symbols-outlined" style="font-size:14px">${isTts ? "text_fields" : "photo_size_select_large"}</span>
          <span class="progress-stat-value">${progressDetail || (isDone ? "100%" : "...")}</span>
        </div>
        ${speedTxt ? `
        <div class="progress-stat progress-speed">
          <span class="material-symbols-outlined" style="font-size:14px">speed</span>
          <span>${speedTxt}</span>
        </div>` : ""}
        ${confBadge}
      </div>
      
      ${waveform}
      ${historyHint}
      ${logsHtml}
      
      ${!isDone && !isError ? `
      <div class="progress-cancel">
        <button id="btn-cancel-gen" class="btn btn-danger btn-md btn-block">
          <span class="material-symbols-outlined" style="font-size:16px;margin-right:4px">cancel</span>
          Zrušit generaci
        </button>
      </div>` : ""}
    </div>`;
}

// ── TTS generation ───────────────────────────────────────

async function generateTts() {
  const s = state.tts;
  const isMossV15 = s.model === "moss-tts-v1.5";
  if (!s.model) { toast("Vyber TTS model", "error"); return; }
  if (!s.text.trim()) { toast("Zadej text", "error"); return; }

  const payload = {
    model: s.model,
    text: s.text,
    language: s.language || undefined,
    instruction: s.instruction || undefined,
    seed: s.seedRandom ? randomSeed() : s.seed,
    temperature: s.temperature,
    top_p: s.top_p,
    top_k: s.top_k,
    repetition_penalty: s.repetition_penalty,
    max_new_tokens: s.max_new_tokens,
    speed: s.speed != null ? s.speed : undefined,
    response_format: s.response_format || undefined,
    quality: s.quality || undefined,
    sound_event: s.sound_event || undefined,
    ambient_sound: s.ambient_sound || undefined,
  };
  // Identita hlasu: referenční audio má přednost, voice_id je s ním vzájemně vylučené (backend 400)
  if (s.refAudio && s.refAudio.b64) {
    payload.reference_audio_b64 = s.refAudio.b64;
  } else {
    payload.voice = s.voice || undefined;
    if (isMossV15) payload.voice_id = s.voice || undefined;
  }

  if (state.result && state.result.url) URL.revokeObjectURL(state.result.url);
  const ctrl = new AbortController();
  state.generating = { kind: "tts", model: s.model, startMs: performance.now(), liveLogs: [],
                       logMark: state.logs.length ? state.logs[state.logs.length - 1] : null,
                       controller: ctrl };
  state.result = null;
  render();

  const progPoll = setInterval(async () => {
    try {
      const { body } = await api("/api/generation-status");
      if (!state.generating) return;
      state.generating.progress = body;
      renderIfIdle();
    } catch (_) {}
  }, 1000);

  const t0 = performance.now();
  try {
    const { body, headers } = await api("/api/generate", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const blob = body instanceof Blob ? body : new Blob([body], { type: headers.get("content-type") || "audio/wav" });
    const url = URL.createObjectURL(blob);
    state.result = { kind: "tts", url, blob, durationMs: performance.now() - t0, seed: payload.seed };
    toast("TTS vygenerováno");
    notifyDone("TTS hotovo", s.model);
  } catch (e) {
    const cancelled = e.name === "AbortError";
    state.result = { kind: "tts", error: cancelled ? "Generace zrušena uživatelem" : e.message, seed: payload.seed };
    if (!cancelled) toast(`TTS selhalo: ${e.message}`, "error");
  } finally {
    clearInterval(progPoll);
    state.generating = null;
    render();
    if (state.result && state.result.url) drawWaveform(state.result.url);
    refreshAll();
    await loadHistory();
  }
}

async function designVoice() {
  const v = state.voiceDesign;
  v.instruction = $("#vd-instruction").value;
  v.reference_text = $("#vd-reference").value;
  v.language = $("#vd-language").value;
  v.seed = parseIntOr($("#vd-seed").value, 42);
  v.voice_id = $("#vd-voice-id").value;

  if (!v.instruction.trim()) { toast("Zadej instrukci", "error"); return; }

  const btn = $("#btn-design-voice");
  btn.disabled = true;
  btn.textContent = "Navrhuji hlas...";
  try {
    await api("/api/design-voice", {
      method: "POST",
      body: JSON.stringify({
        instruction: v.instruction,
        language: v.language,
        reference_text: v.reference_text || undefined,
        seed: v.seed,
        voice_id: v.voice_id || undefined,
      }),
    });
    toast("Voice preset vytvořen");
    await refreshVoices();
    render();
  } catch (e) {
    toast(`Voice design selhal: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Vytvořit voice preset";
  }
}

async function loadRefAudioFile(file) {
  const okName = /\.(wav|flac)$/i.test(file.name) || /wav|flac/.test(file.type);
  if (!okName) { toast("Podporované formáty: WAV, FLAC", "error"); return; }
  if (file.size > 20 * 1024 * 1024) { toast("Referenční audio je příliš velké (limit 20 MB)", "error"); return; }
  try {
    const b64 = await blobToBase64(file);
    if (state.tts.refAudio && state.tts.refAudio.blobUrl) URL.revokeObjectURL(state.tts.refAudio.blobUrl);
    state.tts.refAudio = {
      name: file.name,
      b64,
      blobUrl: URL.createObjectURL(file),
    };
    state.tts.voice = ""; // vzájemně vylučené s voice presetem
    render();
    toast(`Referenční audio nahráno: ${file.name}`);
  } catch (e) {
    toast(`Nahrání audia selhalo: ${e.message}`, "error");
  }
}

async function cancelGeneration() {
  const g = state.generating;
  if (!g) return;
  if (g.controller) g.controller.abort();
  try {
    await api("/api/cancel", { method: "POST" });
    toast("Přerušení odesláno do ComfyUI");
  } catch (e) {
    toast(`Přerušení selhalo: ${e.message}`, "error");
  }
}

async function refreshVoices() {
  try {
    const { body } = await api("/api/voices");
    state.voices = body.voices || [];
  } catch (_) {}
}

// ── Image Studio ─────────────────────────────────────────

function renderImage(el) {
  const img = state.models.filter(m => m.kind === "image");
  const s = state.img;
  const modelOptions = img.map(m => `<option value="${escapeAttribute(m.id)}" ${m.id === s.model ? "selected" : ""}>${escapeHtml(m.name)}${m.nsfw ? " (NSFW)" : ""}</option>`).join("");
  // Zachovat ruční resize textarey přes periodické re-rendery (refreshAll/polling).
  const promptH = state.img.promptHeight;

  el.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 acc-image">
      <div class="lg:col-span-2 space-y-4">
        <div class="card">
          <div class="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-3 items-start">
            <select id="img-model" class="control control-block field">${modelOptions}</select>
            <textarea id="img-prompt" rows="3" ${promptH ? `style="height:${promptH}px"` : ""} class="control control-block control-area field" placeholder="Popiš obrázek...">${escapeHtml(s.prompt)}</textarea>
            <button id="btn-generate-img" class="btn btn-primary-image btn-lg">Generovat</button>
          </div>
          ${imageParamsHtml()}
        </div>

        <div class="card">
          <div class="flex items-center justify-between">
            <h3 class="font-bold text-on-surface">Benchmark</h3>
            <div class="flex gap-2 items-center">
              <input id="bench-runs" type="number" value="${s.benchmarkRuns}" class="control field" style="width:70px">
              <button id="btn-benchmark" class="btn btn-secondary btn-sm">Spustit benchmark</button>
            </div>
          </div>
          <div id="bench-results" class="mt-3"></div>
        </div>
      </div>

      <div class="space-y-4">
        ${state.generating && state.generating.kind === "image" ? renderProgress() : renderImageResult()}
      </div>
    </div>`;

  $("#img-model").addEventListener("change", e => { state.img.model = e.target.value; updateImageDefaults(); });
  $("#img-prompt").addEventListener("input", e => { state.img.prompt = e.target.value; });
  // Zapamatovat ruční resize (mouse-up po tažení gripu) → přežije re-render.
  $("#img-prompt").addEventListener("mouseup", e => {
    const h = e.target.offsetHeight;
    if (h && h !== state.img.promptHeight) state.img.promptHeight = h;
  });
  bindImageParams();
  $("#bench-runs").addEventListener("input", e => { state.img.benchmarkRuns = parseInt(e.target.value) || 3; });

  $("#btn-generate-img").addEventListener("click", generateImage);
  $("#btn-cancel-gen")?.addEventListener("click", cancelGeneration);
  $("#btn-benchmark").addEventListener("click", runBenchmark);
  $(".result-image")?.addEventListener("click", () => {
    if (state.result && state.result.url) openZoomUrl(state.result.url, `Výsledek — ${state.img.model}`);
  });

  updateImageDefaults();
}

function updateImageDefaults() {
  const m = state.models.find(x => x.id === state.img.model);
  const stepsEl = $("#img-steps");
  const cfgEl = $("#img-cfg");
  if (!stepsEl || !cfgEl) return;
  if (m && m.default_params) {
    stepsEl.placeholder = m.default_params.steps ?? "default";
    cfgEl.placeholder = m.default_params.cfg ?? "default";
    // předvyplnit skutečné defaulty z registry (pokud uživatel nezadal vlastní)
    if (state.img.steps == null && m.default_params.steps != null) stepsEl.value = m.default_params.steps;
    if (state.img.cfg == null && m.default_params.cfg != null) cfgEl.value = m.default_params.cfg;
  }
}

function renderImageResult() {
  if (!state.result || state.result.kind !== "image") {
    return card("Výsledek", "<p class='text-text-muted text-xs'>Žádný výstup zatím.</p>");
  }
  if (state.result.error) {
    return card("Výsledek", `<p class="text-red-400 text-xs">${escapeHtml(state.result.error)}</p>`);
  }
  return card("Výsledek", `
    <img src="${state.result.url}" alt="Vygenerovaný obrázek" class="result-image cursor-zoom-in" title="Klik pro zvětšení">
    <div class="mt-3 flex gap-2">
      <a href="${state.result.url}" download="comfyui-${Date.now()}.png" class="btn btn-secondary btn-sm">Stáhnout</a>
      <span class="text-xs text-text-muted mt-1.5">${state.result.durationMs ? fmtDuration(state.result.durationMs) : ""}${state.result.seed != null ? ` · seed ${state.result.seed}` : ""}</span>
    </div>`);
}

async function generateImage() {
  const s = state.img;
  if (!s.model) { toast("Vyber image model", "error"); return; }
  if (!s.prompt.trim()) { toast("Zadej prompt", "error"); return; }

  const payload = {
    model: s.model,
    prompt: s.prompt,
    negative_prompt: s.negative_prompt || undefined,
    steps: s.steps,
    cfg: s.cfg,
    seed: s.seedRandom ? randomSeed() : s.seed,
    width: s.width,
    height: s.height,
  };

  if (state.result && state.result.url) URL.revokeObjectURL(state.result.url);
  const ctrl = new AbortController();
  state.generating = { kind: "image", model: s.model, startMs: performance.now(), liveLogs: [],
                       logMark: state.logs.length ? state.logs[state.logs.length - 1] : null,
                       controller: ctrl };
  state.result = null;
  render();

  const progPoll = setInterval(async () => {
    try {
      const { body } = await api("/api/generation-status");
      if (!state.generating) return;
      state.generating.progress = body;
      renderIfIdle();
    } catch (_) {}
  }, 1000);

  const t0 = performance.now();
  try {
    const { body, headers } = await api("/api/generate", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const blob = body instanceof Blob ? body : new Blob([body], { type: headers.get("content-type") || "image/png" });
    const url = URL.createObjectURL(blob);
    state.result = { kind: "image", url, blob, durationMs: performance.now() - t0, seed: payload.seed };
    toast("Obrázek vygenerován");
    notifyDone("Obrázek hotový", s.model);
  } catch (e) {
    const cancelled = e.name === "AbortError";
    state.result = { kind: "image", error: cancelled ? "Generace zrušena uživatelem" : e.message, seed: payload.seed };
    if (!cancelled) toast(`Image selhalo: ${e.message}`, "error");
  } finally {
    clearInterval(progPoll);
    state.generating = null;
    render();
    refreshAll();
    await loadHistory();
  }
}

async function runBenchmark() {
  const s = state.img;
  const btn = $("#btn-benchmark");
  btn.disabled = true;
  btn.textContent = "Benchmark běží...";
  const resultsEl = $("#bench-results");
  resultsEl.innerHTML = `<div class="text-text-muted text-xs">Benchmark běží (může trvat minuty)...</div>`;
  try {
    const { body } = await api("/api/benchmark", {
      method: "POST",
      body: JSON.stringify({
        model: s.model,
        prompt: s.prompt,
        negative_prompt: s.negative_prompt,
        steps: s.steps,
        cfg: s.cfg,
        seed: s.seed,
        width: s.width,
        height: s.height,
        runs: s.benchmarkRuns,
      }),
    });
    state.benchmark = body;
    resultsEl.innerHTML = renderBenchmarkResults(body);
    toast(`Benchmark: ${body.successful}/${body.runs} úspěšných`);
    await loadHistory();
  } catch (e) {
    resultsEl.innerHTML = `<div class="text-red-400 text-xs">${escapeHtml(e.message)}</div>`;
    toast(`Benchmark selhal: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Spustit benchmark";
  }
}

function renderBenchmarkResults(b) {
  const rows = (b.results || []).map(r => `
    <tr class="border-b border-border/50">
      <td class="py-1 text-xs">${r.run}</td>
      <td class="py-1 text-xs ${r.success ? "text-primary" : "text-red-400"}">${r.success ? "✓" : "✗"}</td>
      <td class="py-1 text-xs text-on-surface">${r.success ? r.gen_time_s + "s" : escapeHtml(r.error || "")}</td>
    </tr>`).join("");
  const agg = b.aggregate ? `
    <div class="mt-2 text-xs text-text-muted">
      avg ${b.aggregate.avg_time_s}s · min ${b.aggregate.min_time_s}s · max ${b.aggregate.max_time_s}s · VRAM ${b.vram_used_mb} MB
    </div>` : "";
  return `<table class="w-full">${rows}</table>${agg}`;
}

// ── Templates ────────────────────────────────────────────

function renderTemplates(el) {
  const s = state.filters;
  const activeKind = s.templateKind || TEMPLATE_KINDS[0].id;

  const tabs = TEMPLATE_KINDS.map(k =>
    `<button class="tpl-tab ${k.id === activeKind ? "tpl-tab-active" : ""}" data-tpl-tab="${k.id}">${k.label}</button>`
  ).join("");

  el.innerHTML = `
    <div class="space-y-4">
      <div class="card">
        <div class="flex items-center justify-between gap-3 mb-3">
          <div class="flex gap-1 flex-wrap">${tabs}</div>
          <div class="flex gap-1.5 items-center">
            <input id="tpl-search" placeholder="Hledat..." value="${escapeAttribute(s.templateSearch || "")}" class="control field" style="width:140px">
            <button id="btn-tpl-new" class="btn btn-primary btn-sm">Nový</button>
            <button id="btn-tpl-export" class="btn btn-secondary btn-sm" title="Export">⇩</button>
            <button id="btn-tpl-import" class="btn btn-secondary btn-sm" title="Import">⇧</button>
            <button id="btn-tpl-seed" class="btn btn-secondary btn-sm" title="Seed">S</button>
          </div>
        </div>
        <div id="tpl-grid" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2"></div>
      </div>
    </div>`;

  renderTemplateGrid();

  $("#tpl-search").addEventListener("input", e => {
    state.filters.templateSearch = e.target.value;
    renderTemplateGrid();
  });
  $$(".tpl-tab").forEach(btn => btn.addEventListener("click", () => {
    state.filters.templateKind = btn.dataset.tplTab;
    render();
  }));
  $("#btn-tpl-new").addEventListener("click", () => openTemplateModal());
  $("#btn-tpl-seed").addEventListener("click", async () => {
    try {
      await api("/api/templates/seed", { method: "POST" });
      toast("Presety nasazeny");
      refreshAll();
    } catch (e) {
      toast(`Seed selhal: ${e.message}`, "error");
    }
  });
  $("#btn-tpl-export").addEventListener("click", exportTemplates);
  $("#btn-tpl-import").addEventListener("click", () => openImportModal());
}

function templateGridHtml() {
  const s = state.filters;
  const activeKind = s.templateKind || TEMPLATE_KINDS[0].id;
  const search = (s.templateSearch || "").toLowerCase();
  const filtered = state.templates.filter(t =>
    t.kind === activeKind &&
    (!search || t.name.toLowerCase().includes(search) || (t.category || "").toLowerCase().includes(search) || t.content.toLowerCase().includes(search))
  );
  if (!filtered.length) return "<p class='text-text-muted text-xs col-span-full'>Žádné presety</p>";
  return filtered.map(t => `
    <div class="tpl-card group ${t.is_seed ? "tpl-seed" : ""}" data-tpl-use="${t.id}">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-xs text-on-surface truncate">${escapeHtml(t.name)}</span>
        <div class="flex gap-1 opacity-0 group-hover:opacity-100">
          <button class="btn btn-secondary btn-sm" data-tpl-edit="${t.id}" title="Edit">✎</button>
          <button class="btn btn-danger btn-sm" data-tpl-del="${t.id}" title="Smazat">✕</button>
        </div>
      </div>
      <div class="text-[10px] text-text-muted font-label-mono mt-0.5">${escapeHtml(t.category || "")}${t.language ? " · " + escapeHtml(t.language) : ""}${t.is_seed ? " · seed" : ""}</div>
      <div class="text-[11px] text-text-muted mt-1 line-clamp-2">${escapeHtml(t.content)}</div>
    </div>`).join("");
}

function renderTemplateGrid() {
  const grid = $("#tpl-grid");
  if (!grid) return;
  grid.innerHTML = templateGridHtml();
  bindTemplateGrid();
}

function bindTemplateGrid() {
  const grid = $("#tpl-grid");
  if (!grid) return;
  grid.onclick = e => {
    const editEl = e.target.closest("[data-tpl-edit]");
    if (editEl) {
      const t = state.templates.find(x => x.id === parseInt(editEl.dataset.tplEdit));
      if (t) openTemplateModal(t);
      return;
    }
    const delEl = e.target.closest("[data-tpl-del]");
    if (delEl) {
      deleteTemplate(parseInt(delEl.dataset.tplDel));
      return;
    }
    const useEl = e.target.closest("[data-tpl-use]");
    if (useEl) {
      const t = state.templates.find(x => x.id === parseInt(useEl.dataset.tplUse));
      if (!t) return;
      if (t.kind === "tts_text") { state.tts.text = t.content; navigate("tts"); }
      else if (t.kind === "image_prompt") { state.img.prompt = t.content; navigate("image"); }
      else if (t.kind === "negative_prompt") { state.img.negative_prompt = t.content; navigate("image"); }
      else if (t.kind === "voice_instruction") { state.tts.instruction = t.content; navigate("tts"); }
      toast(`Preset „${t.name}“ použit`);
    }
  };
}

async function deleteTemplate(id) {
  const t = state.templates.find(x => x.id === id);
  if (!t || !confirm(`Smazat preset „${t.name}“?`)) return;
  try {
    await api(`/api/templates/${id}`, { method: "DELETE" });
    toast("Preset smazán");
    refreshAll();
  } catch (err) {
    toast(`Smazání selhalo: ${err.message}`, "error");
  }
}

function openTemplateModal(t = null) {
  const modal = $("#modal-container");
  const kindOptions = TEMPLATE_KINDS.map(k =>
    `<option value="${k.id}" ${t && t.kind === k.id ? "selected" : ""}>${k.label}</option>`).join("");
  modal.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-card">
        <h3 class="font-bold text-on-surface mb-4">${t ? "Edit preset" : "Nový preset"}</h3>
        <div class="space-y-3">
          <input id="tpl-name" placeholder="Název" value="${t ? escapeAttribute(t.name) : ""}" class="w-full control">
          <select id="tpl-kind" class="w-full control">${kindOptions}</select>
          <textarea id="tpl-content" rows="5" placeholder="Obsah" class="w-full control">${t ? escapeHtml(t.content) : ""}</textarea>
          <div class="grid grid-cols-2 gap-2">
            <input id="tpl-category" placeholder="Kategorie" value="${t ? escapeAttribute(t.category || "") : ""}" class="control">
            <input id="tpl-language" placeholder="Jazyk (cs/en)" value="${t ? escapeAttribute(t.language || "") : ""}" class="control">
          </div>
          <input id="tpl-model-hint" placeholder="Model hint (volitelné)" value="${t ? escapeAttribute(t.model_hint || "") : ""}" class="w-full control">
        </div>
        <div class="flex gap-2 mt-4">
          <button id="tpl-save" class="flex-1 btn btn-primary btn-md">Uložit</button>
          <button id="tpl-cancel" class="btn btn-secondary btn-md">Zrušit</button>
        </div>
      </div>
    </div>`;
  modal.classList.remove("hidden");

  $("#tpl-cancel").addEventListener("click", () => { modal.classList.add("hidden"); modal.innerHTML = ""; });
  $("#tpl-save").addEventListener("click", async () => {
    const payload = {
      name: $("#tpl-name").value,
      kind: $("#tpl-kind").value,
      content: $("#tpl-content").value,
      category: $("#tpl-category").value || undefined,
      language: $("#tpl-language").value || undefined,
      model_hint: $("#tpl-model-hint").value || undefined,
    };
    try {
      if (t) await api(`/api/templates/${t.id}`, { method: "PUT", body: JSON.stringify(payload) });
      else await api("/api/templates", { method: "POST", body: JSON.stringify(payload) });
      modal.classList.add("hidden"); modal.innerHTML = "";
      toast("Preset uložen");
      refreshAll();
    } catch (e) {
      toast(`Uložení selhalo: ${e.message}`, "error");
    }
  });
}

async function exportTemplates() {
  const { body } = await api("/api/templates/export");
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "comfyui-templates.json"; a.click();
  URL.revokeObjectURL(url);
}

function openImportModal() {
  const modal = $("#modal-container");
  modal.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-card">
        <h3 class="font-bold text-on-surface mb-4">Import presetů</h3>
        <textarea id="import-json" rows="10" placeholder='{"templates": [...]}' class="control control-block control-area font-label-mono"></textarea>
        <div class="flex gap-2 mt-4">
          <button id="import-save" class="flex-1 btn btn-primary btn-md">Importovat</button>
          <button id="import-cancel" class="btn btn-secondary btn-md">Zrušit</button>
        </div>
      </div>
    </div>`;
  modal.classList.remove("hidden");
  $("#import-cancel").addEventListener("click", () => { modal.classList.add("hidden"); modal.innerHTML = ""; });
  $("#import-save").addEventListener("click", async () => {
    try {
      const payload = JSON.parse($("#import-json").value);
      await api("/api/templates/import", { method: "POST", body: JSON.stringify(payload) });
      modal.classList.add("hidden"); modal.innerHTML = "";
      toast("Presety importovány");
      refreshAll();
    } catch (e) {
      toast(`Import selhal: ${e.message}`, "error");
    }
  });
}

// ── History ──────────────────────────────────────────────

function renderHistory(el) {
  const s = state.filters;
  const isGallery = s.historyView === "gallery";
  const kindOptions = ["", "tts", "image"].map(k =>
    `<option value="${k}" ${k === s.historyKind ? "selected" : ""}>${k || "vše"}</option>`).join("");

  el.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div class="lg:col-span-2">
        <div class="card">
          <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <h3 id="hist-count" class="font-bold text-on-surface">Historie (${state.history.length})</h3>
            <div class="flex items-center gap-1.5">
              <input id="hist-search" placeholder="Hledat v promptech…" value="${escapeAttribute(s.historySearch || "")}" class="control field" style="width:170px">
              <select id="hist-filter-kind" class="rounded-lg control">${kindOptions}</select>
              <button id="hist-view-toggle" class="btn btn-secondary btn-sm" title="Přepnout seznam/galerie">${isGallery ? "☰" : "▦"}</button>
            </div>
          </div>
          <p class="text-[10px] text-text-muted mb-3">⌨️ ↑/↓ nebo j/k výběr · Enter detail · R znovu spustit · I zoom obrázku · Delete smazat · Home/End skok</p>
          <div id="hist-results"></div>
        </div>
      </div>
      <div>
        ${card("Statistiky", renderStats())}
      </div>
    </div>`;

  $("#hist-filter-kind").addEventListener("change", e => { state.filters.historyKind = e.target.value; loadHistory(); });
  let histSearchTimer = null;
  $("#hist-search").addEventListener("input", e => {
    state.filters.historySearch = e.target.value;
    clearTimeout(histSearchTimer);
    histSearchTimer = setTimeout(loadHistory, 300);
  });
  $("#hist-view-toggle").addEventListener("click", () => {
    state.filters.historyView = state.filters.historyView === "gallery" ? "list" : "gallery";
    localStorage.setItem("comfyui-hist-view", state.filters.historyView);
    render();
  });
  renderHistoryResults();
}

function historyRowHtml(h, selectedId) {
  const device = h.device ? badge(h.device, "text-amber-400", "bg-amber-900/20", "border-amber-500/20") : "";
  const err = h.error ? badge("error", "text-red-400", "bg-red-900/20", "border-red-500/20") : "";
  const dur = h.duration_ms != null ? fmtDuration(h.duration_ms) : "—";
  const size = h.bytes != null ? `${(h.bytes / 1024).toFixed(0)} KB` : "—";
  const hasOutput = h.status === "ok" && h.output_path;
  const expanded = state.historyExpanded === h.id;
  // Obrázkový náhled inline s lazy-loadem; audio přehrávač jen pro rozbalený řádek
  // (200 <audio> elementů najednou žere paměť a startuje stahování všech outputů)
  const preview = hasOutput && h.kind === "image"
    ? `<img src="/api/history/${h.id}/output" loading="lazy" alt="výsledek" class="w-full max-h-40 object-contain rounded-lg border border-border mt-2 cursor-zoom-in" data-hist-preview="${h.id}">`
    : hasOutput && expanded
      ? `<audio controls src="/api/history/${h.id}/output" class="w-full mt-2"></audio>`
      : "";
  return `
    <div class="hist-row py-3 border-b border-border/50 last:border-0 ${h.id === selectedId ? "hist-selected" : ""}" data-hist-row="${h.id}">
      <div class="flex items-center gap-2 flex-wrap">
        <span class="text-[10px] text-text-muted font-label-mono">#${h.id}</span>
        ${badge(h.kind, h.kind === "tts" ? "text-primary" : "text-purple-400", h.kind === "tts" ? "bg-primary/10" : "bg-purple-500/10", h.kind === "tts" ? "border-primary/20" : "border-purple-500/20")}
        <span class="font-bold text-on-surface">${escapeHtml(h.model)}</span>
        ${device}
        ${h.status !== "ok" ? err : ""}
      </div>
      <div class="text-xs text-text-muted mt-1">${escapeHtml(h.prompt || "—")}</div>
      <div class="text-[10px] text-text-muted font-label-mono mt-1">${fmtTime(h.ts)} · ${dur} · ${size}</div>
      ${preview}
      <div class="mt-2 flex gap-2 flex-wrap">
        ${hasOutput && h.kind === "tts" ? `<button class="btn btn-secondary btn-sm" data-hist-expand="${h.id}">${expanded ? "Skrýt náhled" : "Náhled"}</button>` : ""}
        <button class="btn btn-secondary btn-sm" data-hist-detail="${h.id}">Detail</button>
        <button class="btn btn-secondary btn-sm" data-hist-rerun="${h.id}">Znovu spustit</button>
        <button class="btn btn-danger btn-sm" data-hist-delete="${h.id}">Smazat</button>
      </div>
    </div>`;
}

function historyResultsHtml(selectedId) {
  const s = state.filters;
  if (s.historyView === "gallery") {
    const galleryCards = state.history.map(h => {
      const ok = h.kind === "image" && h.status === "ok" && h.output_path;
      return `
      <div class="hist-row gallery-item ${h.id === selectedId ? "hist-selected" : ""}" data-hist-row="${h.id}" title="${escapeAttribute((h.prompt || "").slice(0, 120))}">
        ${ok
          ? `<img src="/api/history/${h.id}/output" loading="lazy" alt="výsledek #${h.id}" class="w-full h-40 object-cover rounded-lg border border-border">`
          : `<div class="w-full h-40 rounded-lg border border-border bg-surface-dim flex flex-col items-center justify-center gap-1 text-text-muted text-xs">${h.kind === "tts" ? "🔊 TTS" : "⚠"}<span>${escapeHtml(h.status)}</span></div>`}
        <div class="text-[10px] text-text-muted mt-1 truncate">#${h.id} · ${escapeHtml(h.model)}</div>
      </div>`;
    }).join("");
    return `<div class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">${galleryCards || "<p class='text-text-muted text-xs col-span-full'>Žádná historie</p>"}</div>`;
  }
  const rows = state.history.map(h => historyRowHtml(h, selectedId)).join("");
  return `<div>${rows || "<p class='text-text-muted text-xs'>Žádná historie</p>"}</div>`;
}

function renderHistoryResults() {
  const container = $("#hist-results");
  if (!container) return;
  const selectedId = state.historyIndex >= 0 && state.history[state.historyIndex]
    ? state.history[state.historyIndex].id : null;
  container.innerHTML = historyResultsHtml(selectedId);
  const countEl = $("#hist-count");
  if (countEl) countEl.textContent = `Historie (${state.history.length})`;
  container.onclick = e => {
    const detailEl = e.target.closest("[data-hist-detail]");
    if (detailEl) { openHistoryDetail(parseInt(detailEl.dataset.histDetail)); return; }
    const rerunEl = e.target.closest("[data-hist-rerun]");
    if (rerunEl) { rerunHistory(parseInt(rerunEl.dataset.histRerun)); return; }
    const delEl = e.target.closest("[data-hist-delete]");
    if (delEl) { deleteHistory(parseInt(delEl.dataset.histDelete)); return; }
    const prevEl = e.target.closest("[data-hist-preview]");
    if (prevEl) { openImageZoom(parseInt(prevEl.dataset.histPreview)); return; }
    const expEl = e.target.closest("[data-hist-expand]");
    if (expEl) {
      const id = parseInt(expEl.dataset.histExpand);
      state.historyExpanded = state.historyExpanded === id ? null : id;
      renderHistoryResults();
      return;
    }
    if (state.filters.historyView === "gallery") {
      const rowEl = e.target.closest("[data-hist-row]");
      if (!rowEl) return;
      const h = state.history.find(x => x.id === parseInt(rowEl.dataset.histRow));
      if (!h) return;
      if (h.kind === "image" && h.status === "ok" && h.output_path) openImageZoom(h.id);
      else openHistoryDetail(h.id);
    }
  };
}

async function deleteHistory(id) {
  if (!confirm(`Smazat záznam #${id}?`)) return;
  try {
    await api(`/api/history/${id}`, { method: "DELETE" });
    toast(`Záznam #${id} smazán`);
    await loadHistory();
  } catch (e) {
    toast(`Smazání selhalo: ${e.message}`, "error");
  }
}

function openImageZoom(id) {
  openZoomUrl(`/api/history/${id}/output`, `Obrázek #${id}`);
}

function openZoomUrl(url, title) {
  const modal = $("#modal-container");
  modal.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-card" style="max-width:800px">
        <h3 class="font-bold text-on-surface mb-3">${escapeHtml(title)}</h3>
        <img src="${url}" alt="${escapeAttribute(title)}" class="w-full rounded-lg border border-border">
        <div class="flex gap-2 mt-4 justify-end">
          <a href="${url}" download="comfyui-output.png" class="btn btn-secondary btn-md">Stáhnout</a>
          <button id="zoom-close" class="btn btn-secondary btn-md">Zavřít</button>
        </div>
      </div>
    </div>`;
  modal.classList.remove("hidden");
  $("#zoom-close").addEventListener("click", () => { modal.classList.add("hidden"); modal.innerHTML = ""; });
  const overlay = $(".modal-overlay", modal);
  if (overlay) overlay.addEventListener("click", e => { if (e.target === overlay) { modal.classList.add("hidden"); modal.innerHTML = ""; } });
}

function renderStats() {
  const st = state.stats;
  if (!st) return "<p class='text-text-muted text-xs'>Žádná data</p>";
  return `
    <div class="space-y-2 text-xs">
      <div class="flex justify-between"><span class="text-text-muted">Celkem</span><span class="font-bold text-on-surface">${st.total}</span></div>
      <div class="flex justify-between"><span class="text-text-muted">Úspěšných</span><span class="font-bold text-primary">${st.ok}</span></div>
      <div class="flex justify-between"><span class="text-text-muted">Chyb</span><span class="font-bold text-red-400">${st.errors}</span></div>
      <div class="flex justify-between"><span class="text-text-muted">Úspěšnost</span><span class="font-bold text-on-surface">${st.success_rate}%</span></div>
      <div class="flex justify-between"><span class="text-text-muted">Průměrný čas</span><span class="font-bold text-on-surface">${fmtDuration(st.avg_duration_ms)}</span></div>
      <div class="flex justify-between"><span class="text-text-muted">TTS / Image</span><span class="font-bold text-on-surface">${st.by_kind.tts || 0} / ${st.by_kind.image || 0}</span></div>
    </div>`;
}

async function loadHistory() {
  const params = new URLSearchParams({ limit: "200" });
  if (state.filters.historyKind) params.set("kind", state.filters.historyKind);
  if (state.filters.historySearch) params.set("search", state.filters.historySearch);
  try {
    const { body } = await api(`/api/history?${params}`);
    state.history = body.history || [];
    if (state.historyIndex >= state.history.length) state.historyIndex = state.history.length - 1;
    // Jen výsledková oblast — search input si tak udrží focus i pozici kurzoru
    if (state.view === "history") renderHistoryResults();
    else render();
  } catch (e) {
    showJsError(e);
  }
}

async function rerunHistory(id) {
  const { body } = await api(`/api/history/${id}`);
  const params = body.params || {};
  if (body.kind === "tts") {
    state.tts = { ...state.tts, ...params, text: params.text || body.prompt };
    navigate("tts");
  } else {
    state.img = { ...state.img, ...params, prompt: params.prompt || body.prompt };
    navigate("image");
  }
}

async function openHistoryDetail(id) {
  const { body } = await api(`/api/history/${id}`);
  const params = body.params || {};
  const paramsPretty = JSON.stringify(params, null, 2);
  const hasOutput = body.status === "ok" && body.output_path;
  const output = body.kind === "image" && hasOutput
    ? `<img src="/api/history/${id}/output" alt="výsledek" class="w-full rounded-lg border border-border mt-2">`
    : body.kind === "tts" && hasOutput
      ? `<audio controls src="/api/history/${id}/output" class="w-full mt-2"></audio>`
      : "";
  const modal = $("#modal-container");
  modal.innerHTML = `
    <div class="modal-overlay">
      <div class="modal-card" style="max-width:${body.kind === "image" ? "800px" : "550px"}">
        <h3 class="font-bold text-on-surface mb-3">Detail #${id}</h3>
        <div class="space-y-2 text-xs">
          <div><span class="text-text-muted">Kind:</span> <span class="text-on-surface">${escapeHtml(body.kind)}</span></div>
          <div><span class="text-text-muted">Model:</span> <span class="text-on-surface">${escapeHtml(body.model)}</span></div>
          ${body.device ? `<div><span class="text-text-muted">Device:</span> <span class="text-on-surface">${escapeHtml(body.device)}</span></div>` : ""}
          <div><span class="text-text-muted">Status:</span> <span class="${body.status === "ok" ? "text-primary" : "text-red-400"}">${escapeHtml(body.status)}</span></div>
          <div><span class="text-text-muted">Čas:</span> <span class="text-on-surface">${fmtDuration(body.duration_ms)}</span></div>
          ${body.error ? `<div><span class="text-text-muted">Error:</span> <span class="text-red-400">${escapeHtml(body.error)}</span></div>` : ""}
          <div><span class="text-text-muted">Prompt:</span> <div class="text-on-surface mt-1 whitespace-pre-wrap">${escapeHtml(body.prompt || "—")}</div></div>
          ${body.negative_prompt ? `<div><span class="text-text-muted">Negative prompt:</span> <div class="text-on-surface mt-1 whitespace-pre-wrap">${escapeHtml(body.negative_prompt)}</div></div>` : ""}
          <div><span class="text-text-muted">Parametry (request):</span>
            <pre class="log-panel p-2 mt-1 overflow-auto max-h-96 whitespace-pre-wrap">${escapeHtml(paramsPretty)}</pre>
          </div>
          ${output}
        </div>
        <div class="flex gap-2 mt-4">
          <button id="detail-rerun" class="flex-1 btn btn-primary btn-md">Znovu spustit</button>
          <button id="detail-close" class="btn btn-secondary btn-md">Zavřít</button>
        </div>
      </div>
    </div>`;
  modal.classList.remove("hidden");
  $("#detail-close").addEventListener("click", () => { modal.classList.add("hidden"); modal.innerHTML = ""; });
  $("#detail-rerun").addEventListener("click", () => {
    modal.classList.add("hidden"); modal.innerHTML = "";
    rerunHistory(id);
  });
}

// ── Logs ─────────────────────────────────────────────────

function renderLogLine(l) {
  let cls = "log-line";
  if (/error|exception|traceback|failed/i.test(l)) cls += " log-error";
  else if (/warn/i.test(l)) cls += " log-warn";
  else if (l.includes("[ComfyUI]")) cls += " log-comfy";
  return `<div class="${cls}">${escapeHtml(l)}</div>`;
}

// MOSS-TTS tqdm-style "Generating bs1 ...:  50%|████▌     | 2048/4096 [06:04<06:04, 5.62it/s]"
// parser: returns {percent, value, max, eta_s, speed, unit, label} or null.
function parseMossProgress(line) {
  const m = line.match(/Generating\s+\S+\s*\.{2,}\s*:?\s*(\d+)%[^\|]*\|\s*(\d+)\/(\d+)\s+\[<?(\d+):(\d+)(?:,?\s*(\d+(?:\.\d+)?)(\w+\/s?))?/);
  if (!m) return null;
  const [, pct, val, max, mm, ss, speed, unit] = m;
  return {
    percent: parseInt(pct, 10),
    value: parseInt(val, 10),
    max: parseInt(max, 10),
    eta_s: parseInt(mm, 10) * 60 + parseInt(ss, 10),
    speed: speed ? parseFloat(speed) : null,
    unit: unit || null,
    label: line.split("[ComfyUI]").pop().split("Generating")[1]?.split(":")[0]?.trim() || "MOSS",
  };
}

function renderMossProgressBar() {
  // Walk recent logs newest-first, find latest MOSS progress line.
  for (let i = state.logs.length - 1; i >= Math.max(0, state.logs.length - 30); i--) {
    const p = parseMossProgress(state.logs[i]);
    if (!p) continue;
    const minRem = Math.floor(p.eta_s / 60);
    const secRem = p.eta_s % 60;
    const speedTxt = p.speed ? `${p.speed.toFixed(1)} ${p.unit || "it/s"}` : "";
    const elapsed = p.max ? Math.round((p.value / (p.speed || 1))) : 0;
    return `
      <div class="bg-surface-dim rounded-lg p-3 mb-3 border border-primary/30">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-primary text-[18px] animate-pulse">graphic_eq</span>
            <span class="font-bold text-on-surface">${escapeHtml(p.label)}</span>
            <span class="text-[10px] font-label-mono text-text-muted">${p.percent}%</span>
          </div>
          <div class="text-[10px] text-text-muted font-label-mono">
            ${p.value}/${p.max} · ${speedTxt} · zbývá ${minRem}m ${secRem}s
          </div>
        </div>
        <div class="w-full bg-surface rounded-full h-2 overflow-hidden">
          <div class="h-2 rounded-full bg-gradient-to-r from-primary to-emerald-400 transition-all duration-300"
               style="width:${p.percent}%"></div>
        </div>
      </div>`;
  }
  return "";
}

function filteredLogs() {
  const f = state.logFilter || "all";
  if (f === "error") return state.logs.filter(l => /error|exception|traceback|failed/i.test(l));
  if (f === "warn") return state.logs.filter(l => /warn/i.test(l));
  if (f === "comfy") return state.logs.filter(l => l.includes("[ComfyUI]"));
  return state.logs;
}

function downloadLogs() {
  const blob = new Blob([state.logs.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `comfyui-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

function renderLogs(el) {
  const lc = state.health && state.health.lifecycle ? state.health.lifecycle : null;
  const statusChip = !state.health
    ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-label-mono bg-red-900/40 text-red-400 border border-red-500/20">backend offline</span>'
    : lc && lc.starting
      ? '<span class="px-2 py-0.5 rounded-full text-[10px] font-label-mono bg-amber-900/40 text-amber-400 border border-amber-500/20">ComfyUI startuje</span>'
      : '<span class="px-2 py-0.5 rounded-full text-[10px] font-label-mono bg-primary/10 text-primary border border-primary/20">ComfyUI běží</span>';

  const lines = filteredLogs();
  const source = (Date.now() - sseLastLog < 6000) ? "SSE push" : (state.logsPaused ? "pozastaveno" : "polling 2s");
  const filterChips = [["all", "Vše"], ["error", "Errors"], ["warn", "Warnings"], ["comfy", "ComfyUI"]]
    .map(([id, label]) => `<button class="tpl-tab ${state.logFilter === id ? "tpl-tab-active" : ""}" data-log-filter="${id}">${label}</button>`).join("");

  el.innerHTML = `
    <div class="card">
      <div class="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div class="flex items-center gap-2 flex-wrap">
          <h3 class="font-bold text-on-surface">Live Logs</h3>
          ${statusChip}
          <span class="text-[10px] text-text-muted font-label-mono">${state.logs.length} řádků${state.logFilter !== "all" ? ` · ${lines.length} ve filtru` : ""} · ${source}</span>
        </div>
        <div class="flex items-center gap-1.5 flex-wrap">
          ${filterChips}
          <button id="logs-pause" class="btn btn-secondary btn-sm" title="Pozastavit/spustit obnovování">${state.logsPaused ? "▶ Spustit" : "⏸ Pauza"}</button>
          <button id="logs-bottom" class="btn btn-secondary btn-sm" title="Skok na konec">⬇</button>
          <button id="logs-download" class="btn btn-secondary btn-sm" title="Stáhnout logy jako txt">⇩ .txt</button>
          <button id="logs-clear" class="btn btn-secondary btn-sm" title="Vymazat z pohledu">Vymazat</button>
        </div>
      </div>
      <div id="moss-progress-container">${renderMossProgressBar()}</div>
      <div id="logs-panel" class="log-panel p-2 overflow-y-auto max-h-[72vh]">
        ${lines.map(renderLogLine).join("") || "<div class='text-text-muted p-2'>Žádné logy</div>"}
      </div>
    </div>`;
  const panel = $("#logs-panel");
  panel.scrollTop = panel.scrollHeight;
  $$("[data-log-filter]").forEach(b => b.addEventListener("click", () => {
    state.logFilter = b.dataset.logFilter;
    renderLogs(el);
  }));
  $("#logs-pause").addEventListener("click", () => {
    state.logsPaused = !state.logsPaused;
    renderLogs(el);
  });
  $("#logs-bottom").addEventListener("click", () => {
    const p = $("#logs-panel");
    if (p) p.scrollTop = p.scrollHeight;
  });
  $("#logs-download").addEventListener("click", downloadLogs);
  $("#logs-clear").addEventListener("click", () => {
    state.logs = [];
    const p = $("#logs-panel");
    if (p) p.innerHTML = "<div class='text-text-muted p-2'>Logy vymazány z pohledu (backend buffer zůstává)</div>";
  });
}

async function pollLogs() {
  if (state.logsPaused) return;
  if (state.view !== "logs" && !state.generating) return;
  // SSE aktivní (otevřené spojení a čerstvé události) — polling jako fallback nepotřebujeme
  if (evtSource && evtSource.readyState === 1 && Date.now() - sseLastLog < 6000) return;
  try {
    const { body } = await api("/api/logs?tail=300");
    state.logs = body.lines || [];
    if (state.generating) {
      const mark = state.generating.logMark;
      const idx = mark ? state.logs.lastIndexOf(mark) : -1;
      state.generating.liveLogs = idx >= 0 ? state.logs.slice(idx + 1) : state.logs.slice();
    }
    updateLogsPanel();
  } catch (_) {}
}

// ── Settings ─────────────────────────────────────────────

function renderSettings(el) {
  el.innerHTML = `
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      ${card("Backend", `
        <div class="space-y-2 text-xs">
          <div class="flex justify-between"><span class="text-text-muted">URL</span><span class="font-mono text-on-surface">${escapeHtml(state.config ? state.config.backend_url : "—")}</span></div>
          <div class="flex justify-between"><span class="text-text-muted">Modely</span><span class="font-bold text-on-surface">${state.models.length}</span></div>
          <div class="flex justify-between"><span class="text-text-muted">Voices</span><span class="font-bold text-on-surface">${state.voices.length}</span></div>
          <div class="flex justify-between"><span class="text-text-muted">Templates</span><span class="font-bold text-on-surface">${state.templates.length}</span></div>
        </div>`)}
      ${card("VRAM management", `
        <p class="text-xs text-text-muted mb-3">Free VRAM provede soft unload modelů. Restart ComfyUI je brute-force vyčištění (trvá déle).</p>
        <div class="flex gap-2">
          <button id="set-free" class="btn btn-secondary btn-md">Free VRAM</button>
          <button id="set-unload" class="btn btn-danger btn-md">Restart ComfyUI</button>
        </div>`)}
      ${card("Notifikace", `
        <label class="flex items-center gap-2 text-xs cursor-pointer">
          <input id="set-notify" type="checkbox" ${state.settings.notify ? "checked" : ""}>
          Notifikovat při dokončení generace (browser notifikace + zvuk)
        </label>
        <p class="text-[10px] text-text-muted mt-2">Hodí se u dlouhých generací — při dokončení dostaneš upozornění, i když máš záložku na pozadí.</p>`)}
    </div>`;
  $("#set-free").addEventListener("click", async () => {
    try { await api("/api/free", { method: "POST" }); toast("VRAM uvolněna"); }
    catch (e) { toast(`Free selhalo: ${e.message}`, "error"); }
  });
  $("#set-unload").addEventListener("click", async () => {
    if (!confirm("Opravdu restartovat ComfyUI?")) return;
    try { await api("/api/unload", { method: "POST" }); toast("ComfyUI restartován"); }
    catch (e) { toast(`Restart selhal: ${e.message}`, "error"); }
  });
  $("#set-notify")?.addEventListener("change", async e => {
    const on = e.target.checked;
    if (on && "Notification" in window && Notification.permission === "default") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") toast("Prohlížeč notifikace nepovolil", "error");
    }
    state.settings.notify = on;
    localStorage.setItem("comfyui-notify", on ? "1" : "0");
  });
}

// ── Cluster widget (levý panel — cluster monitoring) ──────

// ── Cluster widget (levý panel — toggle matrix + GPU) ──────

const TOGGLE_KINDS = [
  { id: "llm", label: "LLM" },
  { id: "img", label: "IMG" },
  { id: "vid", label: "VID" },
  { id: "tts", label: "TTS" },
  { id: "stt", label: "STT" },
];

// Run toggle state is the union of caps.services (which services are
// currently running). Each service has a `type` (llm/img/tts/...) so we
// group them by toggle kind and mark ✓ if any service of that kind runs.
function _runningToggleKinds(machine) {
  const out = {};
  TOGGLE_KINDS.forEach(k => out[k.id] = false);
  (machine.caps?.services || []).forEach(s => {
    if (s.running && s.type && out[s.type] !== undefined) out[s.type] = true;
  });
  return out;
}

function renderClusterWidget() {
  const el = $("#cluster-widget-body");
  if (!el) return;
  const ms = state.hub.machines;
  const dot = $("#cluster-widget-dot");
  const online = ms.filter(m => m.status !== "down").length;
  const titleEl = $("#cluster-widget .font-label-caps");
  if (titleEl) titleEl.textContent = `Cluster ${ms.length ? `${online}/${ms.length}` : ""}`;
  if (dot) dot.className = `w-1.5 h-1.5 rounded-full ${online === ms.length && ms.length ? "bg-primary" : "bg-amber-400"} animate-pulse`;
  if (!ms.length) {
    el.innerHTML = '<div class="flex justify-between"><span class="text-red-400">Žádné stroje</span></div>';
    return;
  }

  const fmtMb = mb => mb == null ? "—" : mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;

  // Toggle matrix: rows = toggle kinds (LLM/IMG/VID/TTS/STT), cols = machines.
  // Cells: ✓ = toggle ON & a service of that type runs; ● = toggle ON but no service running; dim = OFF.
  const togglesByMachine = ms.map(m => m.caps?.toggles || null);
  const runningByMachine = ms.map(_runningToggleKinds);

  const matrixHtml = `
    <div class="grid grid-cols-[auto,repeat(${ms.length},1fr)] gap-x-1 gap-y-[1px] font-label-mono text-[10px] mt-1">
      <div></div>
      ${ms.map(m => {
        const active = m.id === state.hub.activeMachine || (!state.hub.activeMachine && m === ms[0]);
        const statusColor = m.status === "down" ? "#f87171" : m.status === "degraded" ? "#fbbf24" : "#4ade80";
        const downTitle = m.status === "down" && m.down_since ? `down od ${fmtTime(new Date(m.down_since * 1000).toISOString())}` : m.status;
        return `<div class="text-on-surface font-bold text-center truncate cursor-pointer ${active ? "text-primary" : ""}" data-cluster-machine="${m.id}" title="${escapeHtml(downTitle)}">${escapeHtml(m.name)}<span style="color:${statusColor}" class="ml-0.5">●</span></div>`;
      }).join("")}
      ${TOGGLE_KINDS.map(k => `
        <div class="text-text-muted text-[9px]">${k.label}</div>
        ${ms.map((m, mi) => {
          const toggleOn = togglesByMachine[mi] ? togglesByMachine[mi][k.id] !== false : true;
          const running = runningByMachine[mi][k.id];
          if (!toggleOn) return `<div class="text-center text-text-muted opacity-40" title="${escapeHtml(m.name)}: ${k.label} OFF">✗</div>`;
          if (running) return `<div class="text-center text-primary" title="${escapeHtml(m.name)}: ${k.label} běží">✓</div>`;
          return `<div class="text-center text-amber-400" title="${escapeHtml(m.name)}: ${k.label} povolen, ale nic neběží">●</div>`;
        }).join("")}
      `).join("")}
    </div>`;

  // Per-machine GPU bars
  const gpuHtml = ms.map((m, mi) => {
    const gpus = m.caps?.gpus || [];
    const locks = m.caps?.gpu_locks || {};
    if (!gpus.length && !Object.keys(locks).length) {
      return `<div class="text-[9px] mt-1.5 text-text-muted">${escapeHtml(m.name)}: žádná GPU data</div>`;
    }
    const items = gpus.map(g => {
      const total = g.vram_total_mb || ((g.vram_used_mb || 0) + (g.vram_free_mb || 0));
      const memPct = total ? Math.min(100, Math.round(((g.vram_used_mb || 0) / total) * 100)) : 0;
      const util = g.util_pct || 0;
      const barColor = util > 80 ? "#f87171" : util > 40 ? "#fbbf24" : "#4ade80";
      return `
        <div class="flex justify-between text-[9px] mt-0.5"><span class="text-text-muted truncate">${escapeHtml((g.name || "").replace(/^NVIDIA GeForce /, ""))}</span><span class="text-on-surface">${util}% · ${fmtMb(g.vram_used_mb)} / ${fmtMb(total)}</span></div>
        <div class="w-full bg-surface-dim rounded-full h-1.5 mt-0.5">
          <div class="h-1.5 rounded-full transition-all duration-500" style="width:${memPct}%;background:${barColor}"></div>
        </div>`;
    }).join("");
    const lockTxt = Object.keys(locks).length
      ? `<div class="text-[9px] text-text-muted">Locks: ${Object.entries(locks).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("+") || "free" : v}`).join(" ")}</div>`
      : "";
    return `${items}${lockTxt}`;
  }).join("");

  el.innerHTML = matrixHtml + `<div class="mt-2">${gpuHtml}</div>`;
  $$("[data-cluster-machine]", el).forEach(c =>
    c.addEventListener("click", () => setActiveMachine(c.dataset.clusterMachine)));
}

// ── Queue panel (GHE AUTO fronta) ──────────────────────────

function renderQueuePanel() {
  const q = state.queue || { jobs: [] };
  const jobs = q.jobs || [];
  if (!jobs.length) {
    return `<p class="text-text-muted text-xs">Fronta je prázdná. Joby z GHE runneru se zde zobrazí, jakmile je hub-agent přijme.</p>`;
  }
  // group by state
  const byState = {};
  for (const j of jobs) {
    (byState[j.state] = byState[j.state] || []).push(j);
  }
  const stateOrder = ["blocking", "starting", "ready", "running", "queued", "done", "failed", "timed_out", "cancelled"];
  const stateColors = {
    blocking: "text-amber-400", starting: "text-amber-400", ready: "text-emerald-400",
    running: "text-primary", queued: "text-text-muted",
    done: "text-text-muted", failed: "text-red-400", timed_out: "text-red-400",
    cancelled: "text-text-muted",
  };
  const fmtAgo = ts => {
    if (!ts) return "—";
    const d = Math.max(0, Date.now() / 1000 - ts);
    if (d < 60) return `${Math.round(d)}s`;
    if (d < 3600) return `${Math.round(d / 60)}m`;
    return `${Math.round(d / 3600)}h`;
  };
  return `
    <div class="space-y-1 font-label-mono text-[11px]">
      ${stateOrder.filter(s => byState[s]).map(s => {
        const items = byState[s];
        return `<div>
          <div class="text-text-muted uppercase tracking-wider text-[9px] mb-1">${s} (${items.length})</div>
          ${items.map(j => `
            <div class="flex items-center gap-2 py-1 border-t border-border/30">
              <span class="${stateColors[s] || "text-on-surface"} font-bold min-w-[60px]">${escapeHtml(s)}</span>
              <span class="text-text-muted text-[10px] truncate">${escapeHtml(j.id)}</span>
              <span class="text-on-surface text-[10px]">[${(j.needs || []).join(", ")}]</span>
              <span class="text-text-muted text-[10px] ml-auto">${fmtAgo(j.created_at)}</span>
            </div>
          `).join("")}
        </div>`;
      }).join("")}
    </div>
    <div class="text-[9px] text-text-muted mt-2">Aktualizováno: ${q.lastUpdate ? new Date(q.lastUpdate).toLocaleTimeString("cs-CZ") : "—"}</div>`;
}

// ── Theme ────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem("comfyui-theme") || "dark";
  document.documentElement.dataset.theme = saved;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("comfyui-theme", next);
}

// ── Navigation wiring ────────────────────────────────────

function closeSidebar() {
  $("#sidebar").classList.remove("sidebar-open");
  $("#sidebar-backdrop").classList.add("hidden");
}

function initNavigation() {
  $$(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      navigate(btn.dataset.view);
      if (window.innerWidth < 768) closeSidebar();
    });
  });
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#menu-btn").addEventListener("click", () => {
    const sidebar = $("#sidebar");
    sidebar.classList.toggle("sidebar-open");
    $("#sidebar-backdrop").classList.toggle("hidden");
  });
  $("#sidebar-backdrop").addEventListener("click", closeSidebar);
  let globalSearchTimer = null;
  $("#global-search").addEventListener("input", e => {
    const q = e.target.value;
    if (state.view === "templates") {
      state.filters.templateSearch = q.toLowerCase();
      renderTemplateGrid(); // jen grid — focus v inputu zůstane
    } else if (state.view === "history") {
      state.filters.historySearch = q;
      clearTimeout(globalSearchTimer);
      globalSearchTimer = setTimeout(loadHistory, 300);
    }
  });
  $("#global-search").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const q = e.target.value.trim();
    if (!q) return;
    if (state.view === "templates" || state.view === "history") return; // input už filtruje
    // Routing: název/kategorie templatu → Templates, jinak fulltext → History
    const ql = q.toLowerCase();
    const tplHit = state.templates.find(t =>
      t.name.toLowerCase().includes(ql) || (t.category || "").toLowerCase().includes(ql));
    if (tplHit) {
      state.filters.templateKind = tplHit.kind;
      state.filters.templateSearch = ql;
      navigate("templates");
    } else {
      state.filters.historySearch = q;
      state.historyIndex = -1;
      navigate("history");
      loadHistory();
    }
  });
}

function initKeyboardShortcuts() {
  document.addEventListener("keydown", e => {
    const modal = $("#modal-container");
    const modalOpen = modal && !modal.classList.contains("hidden");

    if (e.key === "Escape") {
      if (modalOpen) {
        modal.classList.add("hidden");
        modal.innerHTML = "";
      }
      return;
    }

    // Klávesnicová navigace v historii
    if (state.view !== "history" || modalOpen) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = state.history.length;
    if (!n) return;
    const cur = state.historyIndex;
    const item = cur >= 0 ? state.history[cur] : null;

    switch (e.key) {
      case "ArrowDown": case "j": e.preventDefault(); selectHistory(cur < 0 ? 0 : cur + 1); break;
      case "ArrowUp": case "k": e.preventDefault(); selectHistory(cur <= 0 ? 0 : cur - 1); break;
      case "Home": e.preventDefault(); selectHistory(0); break;
      case "End": e.preventDefault(); selectHistory(n - 1); break;
      case "Enter": case "o": if (item) { e.preventDefault(); openHistoryDetail(item.id); } break;
      case "r": if (item) { e.preventDefault(); rerunHistory(item.id); } break;
      case "i": case "p":
        if (item && item.kind === "image") { e.preventDefault(); openImageZoom(item.id); }
        break;
      case "Delete": case "x": if (item) { e.preventDefault(); deleteHistory(item.id); } break;
    }
  });
}

function selectHistory(idx, scroll = true) {
  const n = state.history.length;
  if (!n) return;
  state.historyIndex = Math.max(0, Math.min(n - 1, idx));
  const selId = state.history[state.historyIndex].id;
  $$("[data-hist-row]").forEach(r =>
    r.classList.toggle("hist-selected", parseInt(r.dataset.histRow) === selId));
  if (scroll) {
    const el = $(`[data-hist-row="${selId}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

// ── Startup ──────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  initNavigation();
  initKeyboardShortcuts();
  initEvents();
  await refreshAll();
  await refreshVoices();
  await loadHistory();
  const { body } = await api("/api/config").catch(() => ({ body: null }));
  state.config = body;

  // set default models if empty
  if (!state.tts.model && state.models.some(m => m.kind === "tts")) {
    state.tts.model = state.models.find(m => m.kind === "tts").id;
  }
  if (!state.img.model && state.models.some(m => m.kind === "image")) {
    state.img.model = state.models.find(m => m.kind === "image").id;
  }

  navigate("generate");
  pollLogs();
  pollHubMachines();
  setInterval(pollLogs, 2000);
  setInterval(pollHubMachines, 5000);
  setInterval(refreshAll, 15000);
});


// ═══════════════════════════════════════════════════════════════════
// LLM/STT/VIDEO Tab handlery + WebUI Navigation (local-ai-stack)
// Přidané 2026-08-28 — rozšíření o nové service kinds
// ═══════════════════════════════════════════════════════════════════

// ── LLM Chat (nový tab) ────────────────────────────────────
async function llmChat(message, model = 'auto') {
  const res = await fetch('/api/proxy/llm/chat', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      messages: [{role: 'user', content: message}],
      model,
      max_tokens: 4096,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({detail: res.statusText}));
    throw new Error(err.detail || `LLM error ${res.status}`);
  }
  return res.json();
}

// ── STT Transcribe (nový tab) ──────────────────────────────
async function sttTranscribe(audioFile, language = 'auto') {
  const form = new FormData();
  form.append('audio', audioFile);
  form.append('language', language);
  const res = await fetch('/api/proxy/stt/transcribe', {method: 'POST', body: form});
  if (!res.ok) {
    const err = await res.json().catch(() => ({detail: res.statusText}));
    throw new Error(err.detail || `STT error ${res.status}`);
  }
  return res.json();
}

// ── Video Generate (nový tab) ──────────────────────────────
async function videoGenerate(prompt, model = 'sana-1600m', durationSec = 5) {
  const res = await fetch('/api/proxy/video/generate', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({prompt, model, duration: durationSec}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({detail: res.statusText}));
    throw new Error(err.detail || `Video error ${res.status}`);
  }
  return res.blob();
}

// ── WebUI Registry (compile-time + runtime discovery) ──────
async function fetchWebUIRegistry() {
  try {
    const res = await fetch('/api/webui/registry');
    if (!res.ok) return [];
    return await res.json();
  } catch (e) {
    console.warn('WebUI registry fetch failed:', e);
    return [];
  }
}

async function buildWebUINav() {
  const registry = await fetchWebUIRegistry();
  const nav = document.getElementById('webui-nav');
  if (!nav) return;

  // Vyčisti existující
  nav.innerHTML = '';

  registry.filter(w => w.running).forEach(w => {
    const link = document.createElement('a');
    link.href = w.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'webui-link block px-3 py-2 rounded-md hover:bg-bg-tertiary transition-colors';
    link.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="text-lg">${w.icon}</span>
        <div class="flex-1 min-w-0">
          <div class="text-sm font-medium truncate">${w.label}</div>
          <div class="text-xs text-text-muted truncate">@ ${w.machine}</div>
        </div>
      </div>
    `;
    link.title = `${w.label} (${w.ui_type}) — ${w.url}`;
    nav.appendChild(link);
  });

  // Pokud nic neběží, zobraz placeholder
  if (registry.length === 0) {
    nav.innerHTML = '<div class="text-xs text-text-muted px-3 py-2">Žádné WebUI služby k dispozici</div>';
  }
}

// Auto-refresh každých 30s
setInterval(buildWebUINav, 30000);
buildWebUINav();  // initial load

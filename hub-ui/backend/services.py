"""Service router logika — resolve target pro každý kind.

Každý kind (llm, img, tts, stt, video) má přiřazení primary → fallback.
Přepínací logika:
  1. desired state (operátor nastavil v Hub-UI)
  2. assignment per kind (z machines.yaml)
  3. auto-discovery (žádný desired/assignment → najdi first capable)
"""
import logging
from fastapi import HTTPException

import hub

log = logging.getLogger("hub-ui.services")


def _find_service_of_type(machine_status: dict, kind: str) -> dict | None:
    """Najdi první službu daného typu v capabilities stroje."""
    caps = machine_status.get("caps") or {}
    for svc in (caps.get("services") or []):
        if svc.get("type") == kind:
            return svc
    return None


def _service_of_type_on_machine(machine_id: str, sid: str, kind: str) -> bool:
    """Ověř že daná služba na daném stroji je daného typu."""
    st = hub._machine_status(machine_id)
    for svc in ((st.get("caps") or {}).get("services") or []):
        if svc.get("id") == sid and svc.get("type") == kind:
            return True
    return False


def resolve_target(kind: str) -> dict:
    """Pro kind najdi nejlepší službu v clusteru. Vrátí {machine, service}.

    Logika:
    1. desired[service] (uživatel nastavil) → primary
    2. assignment[kind] (z machines.yaml) → primary up ? primary : fallback
    3. auto-discovery → first capable service
    4. žádná služba → raise 503
    """
    # 1. desired state
    for sid, want in (hub._desired or {}).items():
        if not want.get("enabled"):
            continue
        if _service_of_type_on_machine(want["machine"], sid, kind):
            return {"machine": want["machine"], "service": sid, "reason": "desired"}

    # 2. assignment per kind
    assignment = (hub._assignments or {}).get(kind, [])
    for mid in assignment:
        st = hub._machine_status(mid)
        svc = _find_service_of_type(st, kind)
        if svc and svc.get("running"):
            return {"machine": mid, "service": svc["id"], "reason": "assignment"}
        if svc and hub._cluster_mode() == "auto":
            # auto-start: v AUTO režimu se pokusíme nastartovat
            return {"machine": mid, "service": svc["id"], "reason": "auto-start-pending"}

    # 3. Auto-discovery (žádný desired/assignment)
    for mid in (hub._probed or {}):
        st = hub._machine_status(mid)
        svc = _find_service_of_type(st, kind)
        if svc:
            return {"machine": mid, "service": svc["id"], "reason": "auto-discover"}

    raise HTTPException(
        status_code=503,
        detail=f"Žádná služba typu '{kind}' dostupná v clusteru",
    )


def health_for_kind(kind: str) -> dict:
    """Health check pro daný kind — vrátí seznam strojů s dostupnými službami."""
    results = []
    for mid in (hub._probed or {}):
        st = hub._machine_status(mid)
        svc = _find_service_of_type(st, kind)
        if svc:
            results.append({
                "machine": mid,
                "service": svc["id"],
                "running": svc.get("running", False),
                "url": st.get("url"),
            })
    return {"kind": kind, "available": results}

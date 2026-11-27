"""Native read/write schedule services for Honeywell Evohome (supports v0/v1/v2/v3 evohome-async)."""
from __future__ import annotations

import inspect
import json
import logging
from typing import Any

import voluptuous as vol

from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
)
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers.typing import ConfigType

_LOGGER = logging.getLogger(__name__)

DOMAIN = "evohome_schedules"

DAYS_OF_WEEK = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
]

GET_SCHEMA = vol.Schema({vol.Required("entity_id"): cv.entity_id})

SET_SCHEMA = vol.Schema(
    {
        vol.Required("entity_id"): cv.entity_id,
        vol.Required("days"): dict,
    }
)


def _find_evo_entity(hass: HomeAssistant, entity_id: str) -> tuple[Any, Any]:
    """Locate the HA entity and its underlying _evo_device across core or cloned integrations."""
    domain = entity_id.split(".", 1)[0]
    entity_comp = hass.data.get("entity_components", {}).get(domain)
    if entity_comp is None:
        raise HomeAssistantError(f"Component domain '{domain}' is not loaded.")

    entity = entity_comp.get_entity(entity_id)
    if entity is None:
        raise HomeAssistantError(f"Entity '{entity_id}' was not found.")

    evo_dev = (
        getattr(entity, "_evo_device", None)
        or getattr(entity, "evo_device", None)
        or getattr(entity, "_device", None)
    )
    if evo_dev is None:
        raise HomeAssistantError(
            f"Entity '{entity_id}' does not expose an Evohome device object."
        )
    return entity, evo_dev


def _to_plain_data(obj: Any) -> Any:
    """Unwrap strings, dataclasses, pydantic models, or custom objects into plain dicts/lists."""
    if obj is None:
        return None
    if isinstance(obj, str):
        try:
            return json.loads(obj)
        except ValueError:
            return obj
    if isinstance(obj, (int, float, bool)):
        return obj
    if isinstance(obj, list | tuple):
        return [_to_plain_data(x) for x in obj]
    if isinstance(obj, dict):
        return {k: _to_plain_data(v) for k, v in obj.items()}
    for method_name in ("to_dict", "as_dict", "model_dump", "dict"):
        fn = getattr(obj, method_name, None)
        if callable(fn):
            try:
                return _to_plain_data(fn())
            except Exception:
                pass
    if hasattr(obj, "__dict__"):
        return {
            k: _to_plain_data(v)
            for k, v in vars(obj).items()
            if not k.startswith("_")
        }
    return obj


def _first_present(mapping: dict[str, Any], keys: tuple[str, ...], default: Any = None) -> Any:
    """Return the first matching key whose value is not None (safe for 0 / 0.0 values)."""
    for k in keys:
        if k in mapping and mapping[k] is not None:
            return mapping[k]
    return default


def _extract_daily_list(raw: Any) -> list[dict[str, Any]]:
    """Find the 7-day list regardless of wrapper key naming."""
    data = _to_plain_data(raw)
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in (
            "DailySchedules",
            "dailySchedules",
            "daily_schedules",
            "schedule",
            "schedules",
        ):
            val = data.get(key)
            if isinstance(val, list):
                return val
            if isinstance(val, dict):
                nested = _extract_daily_list(val)
                if nested:
                    return nested
        if any(d.lower() in {str(k).lower() for k in data} for d in DAYS_OF_WEEK):
            out = []
            for k, v in data.items():
                if isinstance(v, list):
                    out.append({"day_of_week": k, "switchpoints": v})
                elif isinstance(v, dict):
                    entry = dict(v)
                    entry.setdefault("day_of_week", k)
                    out.append(entry)
            return out
    return []


def _snap_time_to_10m(time_str: str) -> str:
    """Ensure HH:MM:00 format snapped to 10-minute increments required by Evohome hardware."""
    parts = str(time_str).strip().split(":")
    hour = max(0, min(23, int(parts[0])))
    minute = int(parts[1]) if len(parts) > 1 else 0
    snapped_min = min(50, int(round(minute / 10.0) * 10))
    return f"{hour:02d}:{snapped_min:02d}:00"


def _normalize_schedule(raw: Any, is_dhw: bool) -> dict[str, list[dict[str, Any]]]:
    """Convert PascalCase, camelCase, or snake_case TCC schedule data into a uniform dict."""
    daily_list = _extract_daily_list(raw)
    normalized: dict[str, list[dict[str, Any]]] = {d: [] for d in DAYS_OF_WEEK}

    for day_entry in daily_list:
        if not isinstance(day_entry, dict):
            continue

        raw_day = _first_present(
            day_entry, ("DayOfWeek", "dayOfWeek", "day_of_week", "day")
        )
        if hasattr(raw_day, "value"):
            raw_day = raw_day.value

        day_name: str | None = None
        if isinstance(raw_day, int) and 0 <= raw_day <= 6:
            day_name = DAYS_OF_WEEK[raw_day]
        elif raw_day is not None:
            s_day = str(raw_day).split(".")[-1].strip()
            if s_day.isdigit() and 0 <= int(s_day) <= 6:
                day_name = DAYS_OF_WEEK[int(s_day)]
            else:
                day_name = next(
                    (d for d in DAYS_OF_WEEK if d.lower().startswith(s_day[:3].lower())),
                    None,
                )

        if not day_name:
            continue

        sps = _first_present(
            day_entry,
            ("Switchpoints", "switchpoints", "switch_points", "time_slots"),
            default=[],
        )
        parsed_sps = []
        for sp in sps:
            if not isinstance(sp, dict):
                continue
            t_raw = _first_present(
                sp, ("TimeOfDay", "timeOfDay", "time_of_day", "time"), "00:00:00"
            )
            hh_mm = ":".join(str(t_raw).split(":")[:2])
            if is_dhw:
                state_raw = _first_present(
                    sp,
                    ("DhwState", "dhwState", "dhw_state", "state"),
                    "Off",
                )
                if hasattr(state_raw, "value"):
                    state_raw = state_raw.value
                parsed_sps.append(
                    {
                        "time": hh_mm,
                        "state": "On" if str(state_raw).lower() in ("on", "true", "1") else "Off",
                    }
                )
            else:
                temp_raw = _first_present(
                    sp,
                    (
                        "heatSetpoint",
                        "heat_setpoint",
                        "TargetTemperature",
                        "targetTemperature",
                        "target_temperature",
                        "temperature",
                    ),
                    15.0,
                )
                parsed_sps.append(
                    {
                        "time": hh_mm,
                        "temp": round(float(temp_raw) * 2) / 2,
                    }
                )

        parsed_sps.sort(key=lambda x: x["time"])
        normalized[day_name] = parsed_sps

    return normalized


def _build_native_payload(
    days_input: dict[str, Any], sample_raw: Any, is_dhw: bool
) -> Any:
    """Mirror the exact key casing & day indexing expected by this entity's evohome-async version."""
    sample = _to_plain_data(sample_raw)

    wrapper_key: str | None = "dailySchedules"
    day_key = "dayOfWeek"
    day_as_int = False
    sp_list_key = "switchpoints"
    time_key = "timeOfDay"
    val_key = "dhwState" if is_dhw else "heatSetpoint"

    sample_list: list[dict[str, Any]] = []
    if isinstance(sample, dict):
        for wk in ("DailySchedules", "dailySchedules", "daily_schedules"):
            if wk in sample and isinstance(sample[wk], list):
                wrapper_key = wk
                sample_list = sample[wk]
                break
    elif isinstance(sample, list):
        wrapper_key = None
        sample_list = sample

    if sample_list and isinstance(sample_list[0], dict):
        first_day = sample_list[0]
        for dk in ("DayOfWeek", "dayOfWeek", "day_of_week"):
            if dk in first_day:
                day_key = dk
                day_as_int = isinstance(first_day[dk], int)
                break
        for sk in ("Switchpoints", "switchpoints", "switch_points"):
            if sk in first_day:
                sp_list_key = sk
                break
        for d_item in sample_list:
            sps = d_item.get(sp_list_key, [])
            if sps and isinstance(sps[0], dict):
                sp0 = sps[0]
                for tk in ("TimeOfDay", "timeOfDay", "time_of_day"):
                    if tk in sp0:
                        time_key = tk
                        break
                if is_dhw:
                    for vk in ("DhwState", "dhwState", "dhw_state", "state"):
                        if vk in sp0:
                            val_key = vk
                            break
                else:
                    for vk in (
                        "heatSetpoint",
                        "heat_setpoint",
                        "TargetTemperature",
                        "targetTemperature",
                        "target_temperature",
                    ):
                        if vk in sp0:
                            val_key = vk
                            break
                break

    out_daily = []
    for idx, day_name in enumerate(DAYS_OF_WEEK):
        raw_slots = days_input.get(day_name, [])
        if not raw_slots:
            raise HomeAssistantError(
                f"{day_name} must have at least 1 switchpoint (Evohome minimum)."
            )
        if len(raw_slots) > 6:
            raise HomeAssistantError(
                f"{day_name} has {len(raw_slots)} switchpoints; Evohome allows max 6."
            )

        dedup_by_time: dict[str, dict[str, Any]] = {}
        for slot in raw_slots:
            snapped_time = _snap_time_to_10m(slot.get("time", "00:00"))
            sp_obj: dict[str, Any] = {time_key: snapped_time}
            if is_dhw:
                state_str = str(slot.get("state", "Off")).capitalize()
                sp_obj[val_key] = "On" if state_str == "On" else "Off"
            else:
                temp_val = max(
                    5.0, min(35.0, round(float(slot.get("temp", 15.0)) * 2) / 2)
                )
                sp_obj[val_key] = temp_val
            dedup_by_time[snapped_time] = sp_obj

        sorted_sps = [dedup_by_time[t] for t in sorted(dedup_by_time.keys())]
        out_daily.append(
            {
                day_key: idx if day_as_int else day_name,
                sp_list_key: sorted_sps,
            }
        )

    if wrapper_key is None:
        return out_daily
    return {wrapper_key: out_daily}


async def _call_evo_api(entity: Any, coro: Any) -> Any:
    """Execute coroutine via coordinator/broker wrapper if available, else directly."""
    coordinator = getattr(entity, "coordinator", None)
    if coordinator is not None and hasattr(coordinator, "call_client_api"):
        return await coordinator.call_client_api(coro)
    broker = getattr(entity, "_evo_broker", None)
    if broker is not None and hasattr(broker, "call_client_api"):
        return await broker.call_client_api(coro)
    return await coro


async def _fetch_raw_schedule(entity: Any, evo_dev: Any) -> Any:
    """Call get_schedule() and fall back to evo_dev.schedule if get_schedule() mutates in place."""
    raw_sched = await _call_evo_api(entity, evo_dev.get_schedule())
    if not raw_sched:
        for attr in ("schedule", "_schedule", "daily_schedules"):
            candidate = getattr(evo_dev, attr, None)
            if candidate:
                raw_sched = candidate
                break
    return raw_sched


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register native Evohome schedule read/write actions."""

    async def handle_get_schedule(call: ServiceCall) -> ServiceResponse:
        entity_id: str = call.data["entity_id"]
        entity, evo_dev = _find_evo_entity(hass, entity_id)
        is_dhw = entity_id.startswith("water_heater.")

        try:
            raw_sched = await _fetch_raw_schedule(entity, evo_dev)
        except Exception as err:
            _LOGGER.exception("Failed fetching Evohome schedule for %s", entity_id)
            raise HomeAssistantError(f"Evohome schedule read failed: {err}") from err

        days = _normalize_schedule(raw_sched, is_dhw=is_dhw)
        total_slots = sum(len(v) for v in days.values())
        if total_slots == 0:
            _LOGGER.warning(
                "Evohome schedule for %s parsed 0 switchpoints. Raw payload: %r",
                entity_id,
                _to_plain_data(raw_sched),
            )

        return {
            "entity_id": entity_id,
            "is_dhw": is_dhw,
            "days": days,
        }

    async def handle_set_schedule(call: ServiceCall) -> None:
        entity_id: str = call.data["entity_id"]
        days_input: dict[str, Any] = call.data["days"]
        entity, evo_dev = _find_evo_entity(hass, entity_id)
        is_dhw = entity_id.startswith("water_heater.")

        sample_raw = getattr(evo_dev, "schedule", None) or getattr(
            evo_dev, "_schedule", None
        )
        if not sample_raw:
            sample_raw = await _fetch_raw_schedule(entity, evo_dev)

        payload = _build_native_payload(days_input, sample_raw, is_dhw=is_dhw)

        sig = inspect.signature(evo_dev.set_schedule)
        params = list(sig.parameters.values())
        wants_str = bool(params and params[0].annotation in (str, "str"))

        arg_to_send = json.dumps(payload) if wants_str else payload
        try:
            await _call_evo_api(entity, evo_dev.set_schedule(arg_to_send))
        except (TypeError, ValueError):
            alt_arg = payload if wants_str else json.dumps(payload)
            await _call_evo_api(entity, evo_dev.set_schedule(alt_arg))
        except Exception as err:
            _LOGGER.exception("Failed writing Evohome schedule for %s", entity_id)
            raise HomeAssistantError(f"Evohome schedule write failed: {err}") from err

        coordinator = getattr(entity, "coordinator", None)
        if coordinator is not None and hasattr(coordinator, "async_request_refresh"):
            await coordinator.async_request_refresh()

    hass.services.async_register(
        DOMAIN,
        "get_schedule",
        handle_get_schedule,
        schema=GET_SCHEMA,
        supports_response=SupportsResponse.ONLY,
    )

    hass.services.async_register(
        DOMAIN,
        "set_schedule",
        handle_set_schedule,
        schema=SET_SCHEMA,
    )

    return True

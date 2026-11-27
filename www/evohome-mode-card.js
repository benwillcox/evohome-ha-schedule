function formatTimeHHMM(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

function formatDayDate(date) {
  return date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function describeDuration(type, count) {
  const now = new Date();
  if (type === "hours") {
    const end = new Date(now.getTime() + count * 3600 * 1000);
    const isTomorrow = end.getDate() !== now.getDate();
    const when = `${isTomorrow ? `${formatDayDate(end)} ` : ""}${formatTimeHHMM(end)}`;
    return {
      headline: `Until ${when}`,
      shortUntil: `until ${when}`,
    };
  }
  const lastActiveDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + count - 1);
  const dateStr = formatDayDate(lastActiveDay);
  return {
    headline: count === 1 ? `Until midnight tonight (${dateStr})` : `Until midnight ${dateStr}`,
    shortUntil: count === 1 ? "until midnight" : `until ${dateStr} 24:00`,
  };
}

class EvohomeModeCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._optimistic = null;
    this._rollbackTimer = null;
    this._toast = "";
    this._pickerBtn = null;
    this._pickerCount = 1;
    this._holdTimer = null;
    this._holdTriggered = false;
  }

  setConfig(config) {
    if (!config.entity) {
      throw new Error("Please define an 'entity' for evohome-mode-card.");
    }
    const isDhw = config.entity.startsWith("water_heater.") || config.kind === "dhw";
    this._config = {
      entity: config.entity,
      title: config.title || (isDhw ? "Hot Water" : "System Mode"),
      icon: config.icon || (isDhw ? "mdi:water-boiler" : "mdi:thermostat-box"),
      kind: isDhw ? "dhw" : "system",
      systemServiceDomain: config.system_service_domain || "evohome",
      usePresetFallback: Boolean(config.use_preset_fallback),
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._syncOptimisticWithState();
    this._render();
  }

  getCardSize() {
    return 3;
  }

  _getServerState() {
    const st = this._hass?.states?.[this._config.entity];
    if (this._config.kind === "dhw") {
      const mode = String(st?.state || "auto").toLowerCase();
      const curTemp = st?.attributes?.current_temperature;
      const until = st?.attributes?.status?.dhw_state_status?.until || null;
      return { mode, curTemp, until };
    }
    if (!st) return { mode: "auto", curTemp: null, until: null };
    const until = st?.attributes?.status?.system_mode_status?.time_until || null;
    if (st.state === "off") return { mode: "heatingoff", curTemp: null, until };
    const pm = String(st.attributes?.preset_mode || "none").toLowerCase();
    if (pm === "eco") return { mode: "autowitheco", curTemp: null, until };
    if (pm === "away") return { mode: "away", curTemp: null, until };
    if (pm === "home") return { mode: "dayoff", curTemp: null, until };
    if (pm === "custom") return { mode: "custom", curTemp: null, until };
    return { mode: "auto", curTemp: null, until: null };
  }

  _formatServerUntil(rawUntil) {
    if (!rawUntil) return "";
    const parsed = new Date(rawUntil);
    if (Number.isNaN(parsed.getTime())) return "";
    const now = new Date();
    const sameDay =
      parsed.getFullYear() === now.getFullYear() &&
      parsed.getMonth() === now.getMonth() &&
      parsed.getDate() === now.getDate();
    return sameDay
      ? ` · until ${formatTimeHHMM(parsed)}`
      : ` · until ${formatDayDate(parsed)} ${formatTimeHHMM(parsed)}`;
  }

  _syncOptimisticWithState() {
    if (!this._optimistic) return;
    const server = this._getServerState();
    if (server.mode === this._optimistic.mode) {
      clearTimeout(this._rollbackTimer);
      this._optimistic = null;
      this._toast = "";
    }
  }

  _applyOptimisticMode(nextMode, labelSuffix, actionFn) {
    const previous = this._optimistic
      ? { ...this._optimistic }
      : { mode: this._getServerState().mode, suffix: "" };

    this._optimistic = { mode: nextMode, suffix: labelSuffix, _snapshot: previous };
    this._toast = "";
    this._pickerBtn = null;
    this._render();

    clearTimeout(this._rollbackTimer);
    this._rollbackTimer = setTimeout(() => {
      if (this._optimistic) {
        this._optimistic = this._optimistic._snapshot;
        this._toast = "Honeywell delayed — restored";
        this._render();
      }
    }, 20000);

    Promise.resolve()
      .then(actionFn)
      .catch(() => {
        clearTimeout(this._rollbackTimer);
        this._optimistic = previous;
        this._toast = "Honeywell failed — restored";
        this._render();
        setTimeout(() => {
          this._toast = "";
          this._render();
        }, 4000);
      });
  }

  _triggerSystemMode(evoMode, optKey, count = null) {
    const isHours = evoMode === "AutoWithEco";
    let suffix = "";
    if (count && evoMode !== "Auto" && evoMode !== "HeatingOff") {
      const info = describeDuration(isHours ? "hours" : "days", count);
      suffix = ` · ${count}${isHours ? "h" : "d"} (${info.shortUntil})`;
    }

    this._applyOptimisticMode(optKey, suffix, async () => {
      if (this._config.usePresetFallback) {
        if (evoMode === "HeatingOff") {
          await this._hass.callService("climate", "set_hvac_mode", {
            entity_id: this._config.entity,
            hvac_mode: "off",
          });
          return;
        }
        await this._hass.callService("climate", "set_hvac_mode", {
          entity_id: this._config.entity,
          hvac_mode: "heat",
        });
        if (evoMode === "Auto") {
          return;
        }
        const presetMap = {
          AutoWithEco: "eco",
          DayOff: "home",
          Away: "away",
          Custom: "Custom",
        };
        await this._hass.callService("climate", "set_preset_mode", {
          entity_id: this._config.entity,
          preset_mode: presetMap[evoMode],
        });
        return;
      }

      const data = { mode: evoMode };
      if (count) {
        if (evoMode === "AutoWithEco") {
          data.duration = { hours: count };
        } else if (evoMode === "Away" || evoMode === "DayOff" || evoMode === "Custom") {
          data.period = { days: count };
        }
      }

      await this._hass.callService(
        this._config.systemServiceDomain,
        "set_system_mode",
        data,
        { entity_id: this._config.entity }
      );
    });
  }

  _triggerDhwMode(opMode, hours = null) {
    let suffix = "";
    if (hours && opMode === "on") {
      const info = describeDuration("hours", hours);
      suffix = ` · ${hours}h (${info.shortUntil})`;
    }

    this._applyOptimisticMode(opMode, suffix, async () => {
      if (hours && opMode === "on" && !this._config.usePresetFallback) {
        try {
          await this._hass.callService(
            this._config.systemServiceDomain,
            "set_dhw_override",
            { state: "on", duration: { hours } },
            { entity_id: this._config.entity }
          );
          return;
        } catch (_e) {
          // Fall back to standard water_heater.set_operation_mode if timed DHW service differs
        }
      }
      await this._hass.callService("water_heater", "set_operation_mode", {
        entity_id: this._config.entity,
        operation_mode: opMode,
      });
    });
  }

  _getSystemStatusLabel(mode, suffix) {
    switch (mode) {
      case "autowitheco":
        return `Eco Mode (-3°C)${suffix}`;
      case "away":
        return `Away Setback${suffix}`;
      case "dayoff":
        return `Day Off (Home Schedule)${suffix}`;
      case "custom":
        return `Custom Schedule${suffix}`;
      case "heatingoff":
        return "Heating Off (Frost Only)";
      default:
        return "Auto (Following Schedule)";
    }
  }

  _getDhwStatusLabel(mode, curTemp, suffix) {
    const tempPart = curTemp != null ? ` · ${Number(curTemp).toFixed(1)}°C` : "";
    if (mode === "on") return `Boost / On${suffix}${tempPart}`;
    if (mode === "off") return `Off${tempPart}`;
    return `Auto (Following Schedule)${tempPart}`;
  }

  _getButtons() {
    if (this._config.kind === "dhw") {
      return [
        {
          id: "auto",
          label: "Auto",
          icon: "mdi:calendar-sync",
          color: "#fb8c00",
          durationType: null,
          run: () => this._triggerDhwMode("auto", null),
        },
        {
          id: "on",
          label: "Boost",
          icon: "mdi:fire",
          color: "#e53935",
          durationType: this._config.usePresetFallback ? null : "hours",
          defaultCount: 1,
          maxCount: 24,
          run: (count) => this._triggerDhwMode("on", count),
        },
        {
          id: "off",
          label: "Off",
          icon: "mdi:power",
          color: "#1e88e5",
          durationType: null,
          run: () => this._triggerDhwMode("off", null),
        },
      ];
    }

    const allowTimed = !this._config.usePresetFallback;
    return [
      {
        id: "auto",
        label: "Auto",
        icon: "mdi:calendar-sync",
        color: "#43a047",
        durationType: null,
        run: () => this._triggerSystemMode("Auto", "auto", null),
      },
      {
        id: "autowitheco",
        label: "Eco",
        icon: "mdi:leaf",
        color: "#7cb342",
        durationType: allowTimed ? "hours" : null,
        defaultCount: 3,
        maxCount: 24,
        run: (count) => this._triggerSystemMode("AutoWithEco", "autowitheco", count),
      },
      {
        id: "dayoff",
        label: "Day Off",
        icon: "mdi:home-account",
        color: "#1e88e5",
        durationType: allowTimed ? "days" : null,
        defaultCount: 1,
        maxCount: 99,
        run: (count) => this._triggerSystemMode("DayOff", "dayoff", count),
      },
      {
        id: "away",
        label: "Away",
        icon: "mdi:bag-suitcase",
        color: "#ffb300",
        durationType: allowTimed ? "days" : null,
        defaultCount: 2,
        maxCount: 99,
        run: (count) => this._triggerSystemMode("Away", "away", count),
      },
      {
        id: "custom",
        label: "Custom",
        icon: "mdi:tune",
        color: "#8e24aa",
        durationType: allowTimed ? "days" : null,
        defaultCount: 1,
        maxCount: 99,
        run: (count) => this._triggerSystemMode("Custom", "custom", count),
      },
      {
        id: "heatingoff",
        label: "Off",
        icon: "mdi:radiator-off",
        color: "#e53935",
        durationType: null,
        run: () => this._triggerSystemMode("HeatingOff", "heatingoff", null),
      },
    ];
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const server = this._getServerState();
    const activeMode = this._optimistic?.mode ?? server.mode;
    const suffix = this._optimistic
      ? this._optimistic.suffix || ""
      : this._formatServerUntil(server.until);
    const isPending = Boolean(this._optimistic);
    const isDhw = this._config.kind === "dhw";

    const statusText = isDhw
      ? this._getDhwStatusLabel(activeMode, server.curTemp, suffix)
      : this._getSystemStatusLabel(activeMode, suffix);

    const buttons = this._getButtons();
    const pickerInfo = this._pickerBtn
      ? describeDuration(this._pickerBtn.durationType, this._pickerCount)
      : null;
    const unitLabel =
      this._pickerBtn?.durationType === "hours"
        ? this._pickerCount === 1
          ? "hour"
          : "hours"
        : this._pickerCount === 1
        ? "day"
        : "days";

    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          position: relative;
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          color: var(--primary-text-color);
          user-select: none;
          -webkit-user-select: none;
        }
        .section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        }
        .header-left {
          display: flex;
          align-items: center;
          gap: 9px;
          min-width: 0;
        }
        .header-icon {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 111, 0, 0.14);
          color: #ff6f00;
          flex-shrink: 0;
        }
        .section-title {
          font-size: 0.98rem;
          font-weight: 700;
          line-height: 1.2;
        }
        .section-subtitle {
          font-size: 0.78rem;
          opacity: 0.78;
          margin-top: 2px;
          display: flex;
          align-items: center;
          gap: 5px;
        }
        .hold-hint {
          font-size: 0.68rem;
          opacity: 0.55;
          white-space: nowrap;
        }
        .pending-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #ffa726;
          display: inline-block;
        }
        .btn-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 6px;
        }
        .mode-btn {
          position: relative;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 4px;
          padding: 8px 6px;
          border-radius: 9px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.14));
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          font-size: 0.78rem;
          font-weight: 600;
          touch-action: manipulation;
          transition: border-color 0.15s ease, background 0.15s ease, transform 0.1s ease;
        }
        .mode-btn:active {
          transform: scale(0.96);
        }
        .mode-btn.active {
          background: rgba(255, 255, 255, 0.08);
          border-width: 1.5px;
        }
        .mode-btn:not(.active) {
          opacity: 0.68;
        }
        .timer-dot {
          position: absolute;
          top: 5px;
          right: 6px;
          font-size: 0.65rem;
          opacity: 0.55;
        }
        .popover-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.48);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 999;
          padding: 16px;
        }
        .popover-box {
          width: 100%;
          max-width: 290px;
          background: var(--card-background-color, #1e1e1e);
          border: 1px solid var(--divider-color, rgba(255,255,255,0.18));
          border-radius: 14px;
          padding: 16px;
          box-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .popover-title {
          font-size: 0.96rem;
          font-weight: 700;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .stepper-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
        }
        .step-btn {
          width: 38px;
          height: 38px;
          border-radius: 10px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.18));
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-size: 1.25rem;
          font-weight: 700;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .count-input {
          width: 68px;
          height: 38px;
          text-align: center;
          border-radius: 10px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.22));
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-size: 1.1rem;
          font-weight: 700;
        }
        .unit-text {
          font-size: 0.9rem;
          font-weight: 600;
          min-width: 44px;
        }
        .until-banner {
          text-align: center;
          padding: 8px 10px;
          border-radius: 9px;
          background: var(--secondary-background-color);
          font-size: 0.84rem;
          font-weight: 600;
        }
        .action-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
        }
        .btn-apply {
          padding: 9px 12px;
          border-radius: 9px;
          border: none;
          background: var(--primary-color, #03a9f4);
          color: #ffffff;
          font-size: 0.85rem;
          font-weight: 700;
          cursor: pointer;
        }
        .btn-perm {
          padding: 9px 12px;
          border-radius: 9px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.18));
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-size: 0.85rem;
          font-weight: 600;
          cursor: pointer;
        }
        .dur-cancel {
          padding: 6px;
          border: none;
          background: transparent;
          color: var(--secondary-text-color);
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
        }
        .toast {
          font-size: 0.74rem;
          color: #ef5350;
          font-weight: 600;
        }
      </style>
      <ha-card>
        <div class="section-header">
          <div class="header-left">
            <div class="header-icon">
              <ha-icon icon="${this._config.icon}" style="--mdc-icon-size: 18px;"></ha-icon>
            </div>
            <div>
              <div class="section-title">${this._config.title}</div>
              <div class="section-subtitle">
                ${isPending ? '<span class="pending-dot"></span>' : ""}
                <span>${statusText}</span>
              </div>
            </div>
          </div>
          ${!this._config.usePresetFallback ? `<span class="hold-hint">Hold for timer</span>` : ""}
        </div>
        <div class="btn-grid">
          ${buttons
            .map((b, idx) => {
              const active = activeMode === b.id;
              return `
                <button
                  class="mode-btn ${active ? "active" : ""}"
                  data-idx="${idx}"
                  style="${active ? `border-color: ${b.color};` : ""}"
                >
                  ${b.durationType ? `<span class="timer-dot">◷</span>` : ""}
                  <ha-icon icon="${b.icon}" style="color: ${active ? b.color : "var(--secondary-text-color)"};"></ha-icon>
                  <span>${b.label}</span>
                </button>`;
            })
            .join("")}
        </div>
        ${this._toast ? `<div class="toast">${this._toast}</div>` : ""}

        ${
          this._pickerBtn
            ? `
          <div class="popover-backdrop" id="dur-backdrop">
            <div class="popover-box">
              <div class="popover-title">
                <span>Set ${this._pickerBtn.label}</span>
                <ha-icon icon="${this._pickerBtn.icon}" style="color: ${this._pickerBtn.color}; --mdc-icon-size: 18px;"></ha-icon>
              </div>
              <div class="stepper-row">
                <button class="step-btn" id="dur-minus">−</button>
                <input
                  class="count-input"
                  id="dur-input"
                  type="number"
                  min="1"
                  max="${this._pickerBtn.maxCount}"
                  step="1"
                  value="${this._pickerCount}"
                />
                <span class="unit-text">${unitLabel}</span>
                <button class="step-btn" id="dur-plus">+</button>
              </div>
              <div class="until-banner">${pickerInfo.headline}</div>
              <div class="action-row">
                <button class="btn-perm" id="dur-perm">Permanent</button>
                <button class="btn-apply" id="dur-apply">Apply</button>
              </div>
              <button class="dur-cancel" id="dur-cancel">Cancel</button>
            </div>
          </div>
        `
            : ""
        }
      </ha-card>
    `;

    this._attachListeners(buttons);
  }

  _attachListeners(buttons) {
    this.shadowRoot.querySelectorAll(".mode-btn").forEach((el) => {
      const idx = Number(el.dataset.idx);
      const btnCfg = buttons[idx];
      if (!btnCfg) return;

      const openPicker = () => {
        this._holdTriggered = true;
        this._pickerBtn = btnCfg;
        this._pickerCount = btnCfg.defaultCount || 1;
        this._render();
      };

      const startHold = () => {
        this._holdTriggered = false;
        clearTimeout(this._holdTimer);
        if (!btnCfg.durationType) return;
        this._holdTimer = setTimeout(openPicker, 450);
      };

      const cancelHold = () => {
        clearTimeout(this._holdTimer);
      };

      el.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        startHold();
      });
      el.addEventListener("pointerup", () => {
        cancelHold();
        if (!this._holdTriggered) {
          btnCfg.run(null);
        }
      });
      el.addEventListener("pointerleave", cancelHold);
      el.addEventListener("pointercancel", cancelHold);
      el.addEventListener("contextmenu", (e) => {
        if (btnCfg.durationType) {
          e.preventDefault();
          cancelHold();
          openPicker();
        }
      });
    });

    if (this._pickerBtn) {
      const max = this._pickerBtn.maxCount || 99;
      const clampCount = (val) => Math.max(1, Math.min(max, Math.round(Number(val) || 1)));

      this.shadowRoot.querySelector("#dur-minus")?.addEventListener("click", () => {
        this._pickerCount = clampCount(this._pickerCount - 1);
        this._render();
      });
      this.shadowRoot.querySelector("#dur-plus")?.addEventListener("click", () => {
        this._pickerCount = clampCount(this._pickerCount + 1);
        this._render();
      });
      this.shadowRoot.querySelector("#dur-input")?.addEventListener("change", (e) => {
        this._pickerCount = clampCount(e.target.value);
        this._render();
      });
      this.shadowRoot.querySelector("#dur-apply")?.addEventListener("click", () => {
        const btnCfg = this._pickerBtn;
        const count = this._pickerCount;
        this._pickerBtn = null;
        btnCfg.run(count);
      });
      this.shadowRoot.querySelector("#dur-perm")?.addEventListener("click", () => {
        const btnCfg = this._pickerBtn;
        this._pickerBtn = null;
        btnCfg.run(null);
      });
      this.shadowRoot.querySelector("#dur-cancel")?.addEventListener("click", () => {
        this._pickerBtn = null;
        this._render();
      });
      this.shadowRoot.querySelector("#dur-backdrop")?.addEventListener("click", (e) => {
        if (e.target.id === "dur-backdrop") {
          this._pickerBtn = null;
          this._render();
        }
      });
    }
  }
}

customElements.define("evohome-mode-card", EvohomeModeCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "evohome-mode-card",
  name: "Evohome Mode Card",
  description: "Header-styled Evohome system mode and hot water control card with press-and-hold numeric duration popup and optimistic updates",
});
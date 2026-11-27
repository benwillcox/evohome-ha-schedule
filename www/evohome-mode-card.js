class EvohomeModeCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._optimistic = null;
    this._rollbackTimer = null;
    this._toast = "";
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
      ecoHours: config.eco_hours || 3,
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
      return { mode, curTemp };
    }
    if (!st) return { mode: "auto", curTemp: null };
    if (st.state === "off") return { mode: "heatingoff", curTemp: null };
    const pm = String(st.attributes?.preset_mode || "none").toLowerCase();
    if (pm === "eco") return { mode: "autowitheco", curTemp: null };
    if (pm === "away") return { mode: "away", curTemp: null };
    if (pm === "home") return { mode: "dayoff", curTemp: null };
    if (pm === "custom") return { mode: "custom", curTemp: null };
    return { mode: "auto", curTemp: null };
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

  _applyOptimisticMode(nextMode, actionFn) {
    const previous = this._optimistic
      ? { ...this._optimistic }
      : { mode: this._getServerState().mode };

    this._optimistic = { mode: nextMode, _snapshot: previous };
    this._toast = "";
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

  _triggerSystemMode(evoMode, optKey) {
    this._applyOptimisticMode(optKey, async () => {
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
        const presetMap = {
          Auto: "none",
          AutoWithEco: "eco",
          DayOff: "home",
          Away: "away",
          Custom: "Custom",
        };
        await this._hass.callService("climate", "set_preset_mode", {
          entity_id: this._config.entity,
          preset_mode: presetMap[evoMode] ?? "none",
        });
        return;
      }

      const data = { mode: evoMode };
      if (evoMode === "AutoWithEco" && this._config.ecoHours > 0) {
        data.duration = { hours: this._config.ecoHours };
      }
      await this._hass.callService(
        this._config.systemServiceDomain,
        "set_system_mode",
        data,
        { entity_id: this._config.entity }
      );
    });
  }

  _triggerDhwMode(opMode) {
    this._applyOptimisticMode(opMode, () =>
      this._hass.callService("water_heater", "set_operation_mode", {
        entity_id: this._config.entity,
        operation_mode: opMode,
      })
    );
  }

  _getSystemStatusLabel(mode) {
    switch (mode) {
      case "autowitheco":
        return `Eco Mode (-3°C${this._config.ecoHours ? `, ${this._config.ecoHours}h` : ""})`;
      case "away":
        return "Away Setback";
      case "dayoff":
        return "Day Off (Home Schedule)";
      case "custom":
        return "Custom Schedule";
      case "heatingoff":
        return "Heating Off (Frost Only)";
      default:
        return "Auto (Following Schedule)";
    }
  }

  _getDhwStatusLabel(mode, curTemp) {
    const suffix = curTemp != null ? ` · ${Number(curTemp).toFixed(1)}°C` : "";
    if (mode === "on") return `Boost / On${suffix}`;
    if (mode === "off") return `Off${suffix}`;
    return `Auto (Schedule)${suffix}`;
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const server = this._getServerState();
    const activeMode = this._optimistic?.mode ?? server.mode;
    const isPending = Boolean(this._optimistic);
    const isDhw = this._config.kind === "dhw";

    const statusText = isDhw
      ? this._getDhwStatusLabel(activeMode, server.curTemp)
      : this._getSystemStatusLabel(activeMode);

    const buttons = isDhw
      ? [
          { id: "auto", label: "Auto", icon: "mdi:calendar-sync", color: "#fb8c00", action: () => this._triggerDhwMode("auto") },
          { id: "on", label: "Boost", icon: "mdi:fire", color: "#e53935", action: () => this._triggerDhwMode("on") },
          { id: "off", label: "Off", icon: "mdi:power", color: "#1e88e5", action: () => this._triggerDhwMode("off") },
        ]
      : [
          { id: "auto", label: "Auto", icon: "mdi:calendar-sync", color: "#43a047", action: () => this._triggerSystemMode("Auto", "auto") },
          { id: "autowitheco", label: this._config.ecoHours ? `Eco ${this._config.ecoHours}h` : "Eco", icon: "mdi:leaf", color: "#7cb342", action: () => this._triggerSystemMode("AutoWithEco", "autowitheco") },
          { id: "dayoff", label: "Day Off", icon: "mdi:home-account", color: "#1e88e5", action: () => this._triggerSystemMode("DayOff", "dayoff") },
          { id: "away", label: "Away", icon: "mdi:bag-suitcase", color: "#ffb300", action: () => this._triggerSystemMode("Away", "away") },
          { id: "custom", label: "Custom", icon: "mdi:tune", color: "#8e24aa", action: () => this._triggerSystemMode("Custom", "custom") },
          { id: "heatingoff", label: "Off", icon: "mdi:radiator-off", color: "#e53935", action: () => this._triggerSystemMode("HeatingOff", "heatingoff") },
        ];

    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          padding: 12px;
          display: flex;
          flex-direction: column;
          gap: 10px;
          color: var(--primary-text-color);
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
          transition: border-color 0.15s ease, background 0.15s ease;
        }
        .mode-btn:active {
          transform: scale(0.97);
        }
        .mode-btn.active {
          background: rgba(255, 255, 255, 0.08);
          border-width: 1.5px;
        }
        .mode-btn:not(.active) {
          opacity: 0.68;
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
                  <ha-icon icon="${b.icon}" style="color: ${active ? b.color : "var(--secondary-text-color)"};"></ha-icon>
                  <span>${b.label}</span>
                </button>`;
            })
            .join("")}
        </div>
        ${this._toast ? `<div class="toast">${this._toast}</div>` : ""}
      </ha-card>
    `;

    this.shadowRoot.querySelectorAll(".mode-btn").forEach((el) => {
      const idx = Number(el.dataset.idx);
      const btnCfg = buttons[idx];
      if (btnCfg) {
        el.addEventListener("click", btnCfg.action);
      }
    });
  }
}

customElements.define("evohome-mode-card", EvohomeModeCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "evohome-mode-card",
  name: "Evohome Mode Card",
  description: "Header-styled Evohome system mode and hot water control card with optimistic updates",
});

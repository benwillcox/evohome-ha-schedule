class EvohomeZoneCard extends HTMLElement {
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
      throw new Error("Please define an 'entity' for evohome-zone-card.");
    }
    this._config = {
      entity: config.entity,
      name: config.name || null,
      icon: config.icon || "mdi:radiator",
      step: config.step || 0.5,
      min: config.min || 5,
      max: config.max || 35,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._syncOptimisticWithState();
    this._render();
  }

  getCardSize() {
    return 2;
  }

  _getServerValues() {
    const st = this._hass?.states?.[this._config.entity];
    const currentTemp = st?.attributes?.current_temperature;
    const targetTemp = st?.attributes?.temperature;
    const presetMode = String(st?.attributes?.preset_mode || "none").toLowerCase();
    const name = this._config.name || st?.attributes?.friendly_name || this._config.entity;
    return { currentTemp, targetTemp, presetMode, name };
  }

  _syncOptimisticWithState() {
    if (!this._optimistic) return;
    const server = this._getServerValues();
    const targetMatches =
      this._optimistic.targetTemp === undefined ||
      Number(server.targetTemp) === Number(this._optimistic.targetTemp);
    const presetMatches =
      this._optimistic.presetMode === undefined ||
      server.presetMode === String(this._optimistic.presetMode).toLowerCase();

    if (targetMatches && presetMatches) {
      clearTimeout(this._rollbackTimer);
      this._optimistic = null;
      this._toast = "";
    }
  }

  _applyOptimistic(patch, actionFn) {
    const previous = this._optimistic
      ? { ...this._optimistic }
      : {
          targetTemp: this._getServerValues().targetTemp,
          presetMode: this._getServerValues().presetMode,
        };

    this._optimistic = {
      ...previous,
      ...patch,
      _snapshot: previous,
    };
    this._toast = "";
    this._render();

    clearTimeout(this._rollbackTimer);
    this._rollbackTimer = setTimeout(() => {
      if (this._optimistic) {
        this._optimistic = this._optimistic._snapshot;
        this._toast = "Honeywell delayed — restored state";
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

  _setSetpoint(newTemp) {
    const clamped = Math.max(
      this._config.min,
      Math.min(this._config.max, Math.round(Number(newTemp) * 2) / 2)
    );
    const currentPreset =
      this._optimistic?.presetMode ?? this._getServerValues().presetMode;
    const nextPreset = currentPreset === "none" ? "temporary" : currentPreset;

    this._applyOptimistic({ targetTemp: clamped, presetMode: nextPreset }, () =>
      this._hass.callService("climate", "set_temperature", {
        entity_id: this._config.entity,
        temperature: clamped,
      })
    );
  }

  _setPreset(mode) {
    const normalized = String(mode).toLowerCase();
    this._applyOptimistic({ presetMode: normalized }, () =>
      this._hass.callService("climate", "set_preset_mode", {
        entity_id: this._config.entity,
        preset_mode: mode,
      })
    );
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;
    const server = this._getServerValues();
    const targetTemp =
      this._optimistic?.targetTemp !== undefined
        ? this._optimistic.targetTemp
        : server.targetTemp;
    const presetMode =
      this._optimistic?.presetMode !== undefined
        ? String(this._optimistic.presetMode).toLowerCase()
        : server.presetMode;

    const curText =
      server.currentTemp != null ? `${Number(server.currentTemp).toFixed(1)}°C` : "--°C";
    const tgtText =
      targetTemp != null ? `${Number(targetTemp).toFixed(1)}°C` : "--°C";
    const hasOverride = presetMode === "temporary" || presetMode === "permanent";
    const showPerm = presetMode === "temporary";
    const isPending = Boolean(this._optimistic);

    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          padding: 10px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          color: var(--primary-text-color);
        }
        .top-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .zone-info {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
        }
        .badge {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(255, 111, 0, 0.16);
          color: #ff6f00;
          flex-shrink: 0;
        }
        .title {
          font-size: 0.92rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .temps {
          font-size: 0.78rem;
          opacity: 0.8;
          white-space: nowrap;
        }
        .controls {
          display: flex;
          align-items: center;
          gap: 5px;
          flex-shrink: 0;
        }
        .step-btn {
          width: 28px;
          height: 28px;
          border-radius: 7px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.16));
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-size: 1rem;
          line-height: 1;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 0;
        }
        .step-btn:active {
          transform: scale(0.95);
        }
        .target-pill {
          min-width: 44px;
          text-align: center;
          font-size: 0.85rem;
          font-weight: 600;
        }
        .override-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding-top: 6px;
          border-top: 1px solid var(--divider-color, rgba(255,255,255,0.1));
          font-size: 0.75rem;
        }
        .override-tag {
          opacity: 0.75;
          font-weight: 500;
        }
        .override-actions {
          display: flex;
          gap: 5px;
        }
        .chip-btn {
          padding: 3px 8px;
          border-radius: 6px;
          border: 1px solid var(--divider-color, rgba(255,255,255,0.18));
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-size: 0.73rem;
          font-weight: 600;
          cursor: pointer;
        }
        .chip-btn.clear {
          border-color: rgba(255, 152, 0, 0.5);
          color: #ffa726;
        }
        .pending-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #ffa726;
          display: inline-block;
        }
        .toast {
          font-size: 0.72rem;
          color: #ef5350;
          font-weight: 600;
        }
      </style>
      <ha-card>
        <div class="top-row">
          <div class="zone-info">
            <div class="badge">
              <ha-icon icon="${this._config.icon}" style="--mdc-icon-size: 17px;"></ha-icon>
            </div>
            <div>
              <div class="title">${server.name}</div>
              <div class="temps">Now ${curText} · Target ${tgtText}</div>
            </div>
          </div>
          <div class="controls">
            <button class="step-btn" id="btn-down" title="Decrease setpoint">−</button>
            <span class="target-pill">${tgtText}</span>
            <button class="step-btn" id="btn-up" title="Increase setpoint">+</button>
          </div>
        </div>
        ${
          hasOverride
            ? `
          <div class="override-bar">
            <span class="override-tag">
              ${isPending ? '<span class="pending-dot"></span> ' : ""}${
                presetMode === "permanent" ? "Permanent Hold" : "Temporary Override"
              }
            </span>
            <div class="override-actions">
              ${
                showPerm
                  ? `<button class="chip-btn" id="btn-perm">Perm Hold</button>`
                  : ""
              }
              <button class="chip-btn clear" id="btn-clear">Clear</button>
            </div>
          </div>
        `
            : ""
        }
        ${this._toast ? `<div class="toast">${this._toast}</div>` : ""}
      </ha-card>
    `;

    this._attachListeners(targetTemp);
  }

  _attachListeners(targetTemp) {
    const root = this.shadowRoot;
    const base = targetTemp != null ? Number(targetTemp) : 18.0;
    root.querySelector("#btn-down")?.addEventListener("click", () =>
      this._setSetpoint(base - this._config.step)
    );
    root.querySelector("#btn-up")?.addEventListener("click", () =>
      this._setSetpoint(base + this._config.step)
    );
    root.querySelector("#btn-clear")?.addEventListener("click", () =>
      this._setPreset("none")
    );
    root.querySelector("#btn-perm")?.addEventListener("click", () =>
      this._setPreset("permanent")
    );
  }
}

customElements.define("evohome-zone-card", EvohomeZoneCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "evohome-zone-card",
  name: "Evohome Zone Card",
  description: "Compact Evohome zone card with inside override chips and optimistic rollback",
});

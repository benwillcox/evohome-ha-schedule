const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function tempToColor(val, isDhw) {
  if (isDhw) return val === "On" ? "#d92720" : "#1e88e5";
  const t = parseFloat(val);
  if (t < 16.0) return "#1e88e5";
  if (t < 19.0) return "#5aa632";
  if (t < 22.0) return "#f2b705";
  if (t < 25.0) return "#ee7616";
  return "#d92720";
}

function tempToTextColor(val, isDhw) {
  if (isDhw) return "#ffffff";
  const t = parseFloat(val);
  return t >= 19.0 && t < 22.0 ? "#1b1b1b" : "#ffffff";
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function snapTime10m(t) {
  if (!t || !t.includes(":")) return "07:00";
  let [h, m] = t.split(":").map(Number);
  h = Math.max(0, Math.min(23, isNaN(h) ? 0 : h));
  m = Math.min(50, Math.round((isNaN(m) ? 0 : m) / 10) * 10);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getNowPercent() {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return Math.max(0, Math.min(100, (mins / 1440) * 100));
}

function getNowLabel() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

class EvohomeScheduleCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = null;
    this._selectedEntity = null;
    this._selectedDay = DAYS[(new Date().getDay() + 6) % 7];
    this._schedule = null;
    this._isDhw = false;
    this._loading = false;
    this._saving = false;
    this._dirty = false;
    this._statusMsg = "";
    this._statusType = "info";
    this._clockTimer = null;
  }

  connectedCallback() {
    this._startClock();
  }

  disconnectedCallback() {
    this._stopClock();
  }

  _startClock() {
    this._stopClock();
    this._clockTimer = setInterval(() => this._updateNowMarkers(), 60000);
  }

  _stopClock() {
    if (this._clockTimer) {
      clearInterval(this._clockTimer);
      this._clockTimer = null;
    }
  }

  _updateNowMarkers() {
    if (!this.shadowRoot) return;
    const pct = `${getNowPercent().toFixed(2)}%`;
    const label = getNowLabel();
    this.shadowRoot.querySelectorAll(".now-marker").forEach((el) => {
      el.style.left = pct;
      el.title = `Now (${label})`;
    });
  }

  setConfig(config) {
    if (!config.entities || !Array.isArray(config.entities) || config.entities.length === 0) {
      throw new Error("Please define an 'entities' list in evohome-schedule-card.");
    }
    this._config = {
      title: config.title || "Evohome Controller Schedules",
      entities: config.entities.map((e) =>
        typeof e === "string" ? { entity: e, name: null } : e
      ),
    };
    if (!this._selectedEntity) {
      this._selectedEntity = this._config.entities[0].entity;
    }
    this._render();
  }

  set hass(hass) {
    const firstLoad = !this._hass;
    this._hass = hass;
    if (firstLoad && this._selectedEntity) {
      this._fetchSchedule();
    } else {
      this._updateLiveBadges();
    }
  }

  getCardSize() {
    return 7;
  }

  _getEntityLabel(item) {
    if (item.name) return item.name;
    const st = this._hass?.states?.[item.entity];
    return st?.attributes?.friendly_name || item.entity;
  }

  _getLiveSummary(entityId) {
    const st = this._hass?.states?.[entityId];
    if (!st) return "";
    if (entityId.startsWith("water_heater.")) {
      const cur = st.attributes?.current_temperature;
      return `${st.state}${cur != null ? ` (${cur}°C)` : ""}`;
    }
    const cur = st.attributes?.current_temperature;
    const tgt = st.attributes?.temperature;
    if (cur != null && tgt != null) return `${cur}°C → ${tgt}°C`;
    if (cur != null) return `${cur}°C`;
    return st.state;
  }

  _updateLiveBadges() {
    if (!this.shadowRoot || !this._hass) return;
    const badge = this.shadowRoot.querySelector("#live-badge");
    if (badge && this._selectedEntity) {
      badge.textContent = this._getLiveSummary(this._selectedEntity);
    }
  }

  async _fetchSchedule() {
    if (!this._hass || !this._selectedEntity) return;
    this._loading = true;
    this._statusMsg = "Reading schedule from Evohome controller...";
    this._statusType = "info";
    this._render();

    try {
      const res = await this._hass.callWS({
        type: "call_service",
        domain: "evohome_schedules",
        service: "get_schedule",
        service_data: { entity_id: this._selectedEntity },
        return_response: true,
      });
      const data = res?.response || {};
      this._schedule = JSON.parse(JSON.stringify(data.days || {}));
      this._isDhw = Boolean(data.is_dhw);
      this._dirty = false;
      this._statusMsg = "Loaded live schedule from Evohome controller.";
      this._statusType = "ok";
    } catch (err) {
      this._statusMsg = `Failed to read schedule: ${err.message || err}`;
      this._statusType = "error";
    } finally {
      this._loading = false;
      this._render();
    }
  }

  async _saveSchedule() {
    if (!this._hass || !this._selectedEntity || !this._schedule) return;
    this._saving = true;
    this._statusMsg = "Writing schedule to Evohome controller...";
    this._statusType = "info";
    this._render();

    try {
      await this._hass.callWS({
        type: "call_service",
        domain: "evohome_schedules",
        service: "set_schedule",
        service_data: {
          entity_id: this._selectedEntity,
          days: this._schedule,
        },
      });
      this._dirty = false;
      this._statusMsg = "Saved directly to Evohome controller!";
      this._statusType = "ok";
    } catch (err) {
      this._statusMsg = `Save failed: ${err.message || err}`;
      this._statusType = "error";
    } finally {
      this._saving = false;
      this._render();
    }
  }

  _sortDay(day) {
    if (!this._schedule?.[day]) return;
    this._schedule[day].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  }

  _addSlot() {
    const slots = this._schedule?.[this._selectedDay];
    if (!slots || slots.length >= 6) return;
    const usedTimes = new Set(slots.map((s) => s.time));
    const candidates = ["06:30", "08:30", "12:00", "16:30", "21:00", "22:30", "23:30"];
    const nextTime = candidates.find((c) => !usedTimes.has(c)) || "18:00";
    if (this._isDhw) {
      slots.push({ time: nextTime, state: "On" });
    } else {
      slots.push({ time: nextTime, temp: 20.0 });
    }
    this._sortDay(this._selectedDay);
    this._dirty = true;
    this._render();
  }

  _removeSlot(idx) {
    const slots = this._schedule?.[this._selectedDay];
    if (!slots || slots.length <= 1) return;
    slots.splice(idx, 1);
    this._dirty = true;
    this._render();
  }

  _copyDayTo(targetDays) {
    if (!this._schedule?.[this._selectedDay]) return;
    const src = JSON.stringify(this._schedule[this._selectedDay]);
    targetDays.forEach((d) => {
      if (d !== this._selectedDay) {
        this._schedule[d] = JSON.parse(src);
      }
    });
    this._dirty = true;
    this._statusMsg = `Copied ${this._selectedDay} to ${targetDays.length} day(s). Click 'Save to Evohome' to apply.`;
    this._statusType = "info";
    this._render();
  }

  _buildTimelineSegments(dayIndex) {
    const dayName = DAYS[dayIndex];
    const slots = this._schedule?.[dayName] || [];
    if (!slots.length) return [];

    const prevDayName = DAYS[(dayIndex + 6) % 7];
    const prevSlots = this._schedule?.[prevDayName] || slots;
    const carryVal = this._isDhw
      ? (prevSlots[prevSlots.length - 1]?.state || "Off")
      : (prevSlots[prevSlots.length - 1]?.temp ?? 15.0);

    const points = [];
    if (timeToMinutes(slots[0].time) > 0) {
      points.push({ min: 0, val: carryVal });
    }
    slots.forEach((s) => {
      points.push({
        min: timeToMinutes(s.time),
        val: this._isDhw ? s.state : s.temp,
        time: s.time,
      });
    });

    return points.map((pt, i) => {
      const nextMin = i + 1 < points.length ? points[i + 1].min : 1440;
      const widthPct = ((nextMin - pt.min) / 1440) * 100;
      return {
        widthPct,
        val: pt.val,
        color: tempToColor(pt.val, this._isDhw),
        textColor: tempToTextColor(pt.val, this._isDhw),
        label: this._isDhw ? pt.val : `${pt.val}°`,
      };
    });
  }

  _render() {
    if (!this.shadowRoot || !this._config) return;

    const daySlots = this._schedule?.[this._selectedDay] || [];
    const busy = this._loading || this._saving;
    const nowPct = `${getNowPercent().toFixed(2)}%`;
    const nowLabel = getNowLabel();

    this.shadowRoot.innerHTML = `
      <style>
        ha-card {
          padding: 16px;
          color: var(--primary-text-color);
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          gap: 8px;
          flex-wrap: wrap;
        }
        .title {
          font-size: 1.15rem;
          font-weight: 600;
        }
        .live-badge {
          font-size: 0.85rem;
          padding: 4px 10px;
          border-radius: 12px;
          background: var(--secondary-background-color);
          font-weight: 500;
        }
        .toolbar {
          display: flex;
          gap: 8px;
          margin-bottom: 14px;
          flex-wrap: wrap;
        }
        select {
          flex: 1;
          min-width: 180px;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid var(--divider-color, #444);
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          font-size: 0.95rem;
        }
        button {
          padding: 8px 12px;
          border-radius: 8px;
          border: 1px solid var(--divider-color, #444);
          background: var(--secondary-background-color);
          color: var(--primary-text-color);
          cursor: pointer;
          font-size: 0.85rem;
          font-weight: 500;
        }
        button:hover:not(:disabled) {
          filter: brightness(1.12);
        }
        button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        button.primary {
          background: var(--primary-color, #03a9f4);
          color: #fff;
          border: none;
          font-weight: 600;
        }
        button.dirty-pulse {
          background: #ef6c00;
          color: #fff;
          border: none;
        }
        .week-grid {
          display: flex;
          flex-direction: column;
          gap: 5px;
          margin-bottom: 16px;
        }
        .day-row {
          display: grid;
          grid-template-columns: 46px 1fr;
          align-items: center;
          gap: 8px;
          padding: 3px 6px;
          border-radius: 6px;
          cursor: pointer;
          border: 1px solid transparent;
        }
        .day-row.selected {
          border-color: var(--primary-color, #03a9f4);
          background: var(--secondary-background-color);
        }
        .day-label {
          font-size: 0.82rem;
          font-weight: 600;
        }
        .bar-track {
          position: relative;
          display: flex;
          height: 22px;
          border-radius: 5px;
          overflow: hidden;
          width: 100%;
          background: #263238;
        }
        .bar-seg {
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.7rem;
          font-weight: 600;
          color: #fff;
          overflow: hidden;
          white-space: nowrap;
          border-right: 1px solid rgba(0,0,0,0.25);
        }
        .now-marker {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 3px;
          background: #ff1744;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.85), 0 0 6px rgba(255, 23, 68, 0.7);
          transform: translateX(-1.5px);
          pointer-events: none;
          z-index: 2;
        }
        .now-marker::before {
          content: "";
          position: absolute;
          top: 0;
          left: 50%;
          transform: translateX(-50%);
          border-left: 5px solid transparent;
          border-right: 5px solid transparent;
          border-top: 6px solid #ff1744;
          filter: drop-shadow(0 0 1px rgba(0, 0, 0, 0.9));
        }
        .time-scale {
          display: flex;
          justify-content: space-between;
          padding-left: 54px;
          font-size: 0.7rem;
          opacity: 0.65;
          margin-top: -2px;
          margin-bottom: 10px;
        }
        .editor-box {
          background: var(--secondary-background-color);
          border-radius: 10px;
          padding: 12px;
          margin-bottom: 12px;
        }
        .editor-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 10px;
          flex-wrap: wrap;
          gap: 6px;
        }
        .slots-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .slot-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        input[type="time"], input[type="number"] {
          padding: 6px 8px;
          border-radius: 6px;
          border: 1px solid var(--divider-color, #444);
          background: var(--card-background-color, #1c1c1c);
          color: var(--primary-text-color);
          font-size: 0.9rem;
        }
        input[type="number"] {
          width: 72px;
        }
        .copy-bar {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
          margin-top: 12px;
          padding-top: 10px;
          border-top: 1px solid var(--divider-color, #444);
        }
        .footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .status {
          font-size: 0.82rem;
          opacity: 0.9;
        }
        .status.error { color: #ef5350; font-weight: 600; }
        .status.ok { color: #66bb6a; }
      </style>

      <ha-card>
        <div class="header">
          <div class="title">${this._config.title}</div>
          <div class="live-badge" id="live-badge">${this._getLiveSummary(this._selectedEntity)}</div>
        </div>

        <div class="toolbar">
          <select id="zone-select" ${busy ? "disabled" : ""}>
            ${this._config.entities
              .map(
                (item) => `
              <option value="${item.entity}" ${item.entity === this._selectedEntity ? "selected" : ""}>
                ${this._getEntityLabel(item)}
              </option>`
              )
              .join("")}
          </select>
          <button id="btn-reload" ${busy ? "disabled" : ""}>↻ Reload</button>
        </div>

        ${
          this._schedule
            ? `
          <div class="week-grid">
            ${DAYS.map((day, idx) => {
              const segs = this._buildTimelineSegments(idx);
              return `
                <div class="day-row ${day === this._selectedDay ? "selected" : ""}" data-day="${day}">
                  <div class="day-label">${SHORT_DAYS[idx]}</div>
                  <div class="bar-track">
                    ${segs
                      .map(
                        (s) => `
                      <div class="bar-seg" style="width:${s.widthPct}%; background:${s.color}; color:${s.textColor};" title="${s.label}">
                        ${s.widthPct >= 9 ? s.label : ""}
                      </div>`
                      )
                      .join("")}
                    <div class="now-marker" style="left:${nowPct};" title="Now (${nowLabel})"></div>
                  </div>
                </div>`;
            }).join("")}
          </div>
          <div class="time-scale">
            <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
          </div>

          <div class="editor-box">
            <div class="editor-header">
              <strong>Editing: ${this._selectedDay} (${daySlots.length}/6 switchpoints)</strong>
              <button id="btn-add-slot" ${daySlots.length >= 6 || busy ? "disabled" : ""}>+ Add Switchpoint</button>
            </div>

            <div class="slots-list">
              ${daySlots
                .map(
                  (slot, i) => `
                <div class="slot-row">
                  <input type="time" step="600" class="slot-time" data-idx="${i}" value="${slot.time}" ${busy ? "disabled" : ""} />
                  ${
                    this._isDhw
                      ? `<select class="slot-dhw" data-idx="${i}" ${busy ? "disabled" : ""}>
                          <option value="On" ${slot.state === "On" ? "selected" : ""}>Hot Water ON</option>
                          <option value="Off" ${slot.state === "Off" ? "selected" : ""}>Hot Water OFF</option>
                        </select>`
                      : `<input type="number" min="5" max="35" step="0.5" class="slot-temp" data-idx="${i}" value="${slot.temp}" ${busy ? "disabled" : ""} /> <span>°C</span>`
                  }
                  <button class="btn-del-slot" data-idx="${i}" ${daySlots.length <= 1 || busy ? "disabled" : ""} title="Remove switchpoint">✕</button>
                </div>`
                )
                .join("")}
            </div>

            <div class="copy-bar">
              <button id="copy-weekdays" ${busy ? "disabled" : ""}>Copy to Mon–Fri</button>
              <button id="copy-weekend" ${busy ? "disabled" : ""}>Copy to Sat–Sun</button>
              <button id="copy-all" ${busy ? "disabled" : ""}>Copy to All 7 Days</button>
            </div>
          </div>
        `
            : `<div style="padding:16px 0; opacity:0.75;">${this._loading ? "Loading controller schedule..." : "No schedule loaded."}</div>`
        }

        <div class="footer">
          <div class="status ${this._statusType}">${this._statusMsg}</div>
          <button id="btn-save" class="${this._dirty ? "dirty-pulse" : "primary"}" ${busy || !this._schedule ? "disabled" : ""}>
            ${this._saving ? "Saving..." : this._dirty ? "Save Changes to Evohome *" : "Save to Evohome"}
          </button>
        </div>
      </ha-card>
    `;

    this._attachListeners();
  }

  _attachListeners() {
    const root = this.shadowRoot;

    root.querySelector("#zone-select")?.addEventListener("change", (e) => {
      if (this._dirty && !confirm("Discard unsaved schedule edits for this zone?")) {
        e.target.value = this._selectedEntity;
        return;
      }
      this._selectedEntity = e.target.value;
      this._fetchSchedule();
    });

    root.querySelector("#btn-reload")?.addEventListener("click", () => this._fetchSchedule());
    root.querySelector("#btn-save")?.addEventListener("click", () => this._saveSchedule());
    root.querySelector("#btn-add-slot")?.addEventListener("click", () => this._addSlot());

    root.querySelectorAll(".day-row").forEach((row) => {
      row.addEventListener("click", () => {
        this._selectedDay = row.dataset.day;
        this._render();
      });
    });

    root.querySelectorAll(".slot-time").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const idx = Number(e.target.dataset.idx);
        const snapped = snapTime10m(e.target.value);
        this._schedule[this._selectedDay][idx].time = snapped;
        this._sortDay(this._selectedDay);
        this._dirty = true;
        this._render();
      });
    });

    root.querySelectorAll(".slot-temp").forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const idx = Number(e.target.dataset.idx);
        let val = parseFloat(e.target.value);
        if (isNaN(val)) val = 15.0;
        val = Math.max(5.0, Math.min(35.0, Math.round(val * 2) / 2));
        this._schedule[this._selectedDay][idx].temp = val;
        this._dirty = true;
        this._render();
      });
    });

    root.querySelectorAll(".slot-dhw").forEach((sel) => {
      sel.addEventListener("change", (e) => {
        const idx = Number(e.target.dataset.idx);
        this._schedule[this._selectedDay][idx].state = e.target.value;
        this._dirty = true;
        this._render();
      });
    });

    root.querySelectorAll(".btn-del-slot").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = Number(e.currentTarget.dataset.idx);
        this._removeSlot(idx);
      });
    });

    root.querySelector("#copy-weekdays")?.addEventListener("click", () =>
      this._copyDayTo(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
    );
    root.querySelector("#copy-weekend")?.addEventListener("click", () =>
      this._copyDayTo(["Saturday", "Sunday"])
    );
    root.querySelector("#copy-all")?.addEventListener("click", () =>
      this._copyDayTo(DAYS)
    );
  }
}

customElements.define("evohome-schedule-card", EvohomeScheduleCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "evohome-schedule-card",
  name: "Evohome Native Schedule Card",
  description: "Read and write native 7-day schedules stored on Honeywell Evohome controllers",
});

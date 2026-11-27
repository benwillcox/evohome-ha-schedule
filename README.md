# Honeywell Evohome Native Controls & Schedule Manager for Home Assistant

Native Home Assistant backend integration and custom Lovelace cards for Honeywell Evohome:

**Designed to replicate the Evohome controller for viewing and editing schedules and temperature setpoints.**

- **Direct controller schedule read/write** (`evohome_schedules.get_schedule` and `evohome_schedules.set_schedule`) across standard and cloned Evohome integrations without duplicating scheduling logic.
- **Official Evohome temperature color bands** on the 7-day timeline editor (`< 16°C` Blue, `16–18.5°C` Green, `19–21.5°C` Yellow, `22–24.5°C` Orange, `25°C+` Red) with a high-contrast current-time marker.
- **Header-styled mode & hot water card (`evohome-mode-card`)** with title/status header, mode buttons below, and optimistic UI updates with automatic rollback.
- **Compact zone card (`evohome-zone-card`)** with temperature step controls, inside-card override chips (`Clear` and `Perm Hold`) shown only when an override is active, and optimistic rollback.

---

## Contents

```text
├── .gitignore
├── LICENSE
├── README.md
├── custom_components/
│   └── evohome_schedules/
│       ├── __init__.py
│       ├── manifest.json
│       └── services.yaml
├── examples/
│   └── sample-evohome-views.yaml
└── www/
    ├── evohome-mode-card.js
    ├── evohome-schedule-card.js
    └── evohome-zone-card.js
```

---

## Installation

1. Copy `custom_components/evohome_schedules/` into `/config/custom_components/evohome_schedules/`.
2. Add `evohome_schedules:` to `/config/configuration.yaml`.
3. Copy `www/evohome-mode-card.js`, `www/evohome-zone-card.js`, and `www/evohome-schedule-card.js` into `/config/www/`.
4. In Home Assistant, go to **Settings -> Dashboards -> Three Dots (top right) -> Resources -> Add Resource** and register each file as a **JavaScript Module**:
   - `/local/evohome-mode-card.js`
   - `/local/evohome-zone-card.js`
   - `/local/evohome-schedule-card.js`
5. Restart Home Assistant (**Developer Tools -> YAML -> Restart -> Restart Home Assistant**) and hard-refresh your browser (`Ctrl + F5` or `Cmd + Shift + R`).
6. Use `examples/sample-evohome-views.yaml` as a reference for your dashboard views and replace the entity IDs with yours.

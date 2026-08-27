# FleetGuard Dashboard Improvement Plan

> Saved 2026-08-26. Derived from the FleetGuard design reference prompt.
> All improvements are **frontend-only** — no backend changes needed.
> Each phase derives from existing API endpoints (`/devices`, `/audit`, `/devices/:id/locations`).

## Reference design (FleetGuard spec)

Modern, high-security fleet management dashboard for IT admins managing
company laptops. Command-center / SOC-NOC aesthetic.

- **Dark mode by default** — deep charcoal/near-black (#0F1115 range)
- **High contrast** white/light-gray text
- **Monospace font** for device IDs, timestamps, IP/location data
- **Status colors**: green (#22C55E) = Active, amber (#F59E0B) = Warning/Offline, red (#EF4444) = Flagged Stolen/Locked
- **Generous whitespace** despite dense data — avoid clutter

### Screens in spec
1. **Fleet Overview** — top bar (logo, search, profile, notification bell), summary cards (Total, Active, Offline >24h, Flagged Stolen), sortable device table (status, hostname, user, model, last check-in, location, quick actions), left sidebar nav
2. **Device Detail** — header (hostname, status, model, user, enrollment date), large dark map (GPS pin + accuracy radius + history trail), vertical event timeline, prominent "Flag as Stolen" (red, confirmation modal with reason) + "Lock Device" (security key input) buttons
3. **Alerts Panel** — auto-generated alerts (missed check-in, unexpected location jump, failed unlock) with severity colors, dismissible/acknowledgeable
4. **Audit Log** — clean table (timestamp, admin, action, device), filterable by date range and admin

### Interaction details
- "Flag as Stolen" and "Lock" are the most visually weighted actions — larger, red-accented, always visible without scrolling
- Status badges pulse subtly when a device goes offline or gets flagged
- Responsive: works on tablet for on-the-go admin use

---

## Current state vs. spec (gap analysis)

### Already present
- Dark mode (slate-950 bg, close to #0F1115)
- Monospace font for device IDs/timestamps
- Sidebar nav (Overview, Devices, Map, Audit, Admins)
- Summary cards on Overview
- Sortable/filterable device table
- Device detail with location, audit timeline, action buttons
- Audit log table
- Status badges with color coding

### Missing
1. **Top bar** — no global search, no notification bell, no admin profile in top bar
2. **Fleet Overview** — no "Offline >24h" card, table missing model + location columns, no quick-action icons per row
3. **Device Detail** — no large map with GPS pin + accuracy radius + location history trail (currently text-only)
4. **Alerts Panel** — entirely missing
5. **Audit Log** — no date range filter, no admin filter
6. **Status colors** — close but not exact FleetGuard hex values
7. **Micro-interactions** — badges don't pulse on status change
8. **Responsive tablet** — partially there but not optimized

---

## Implementation phases

### Phase 1 — Top Bar (command-center feel)
**What:** Persistent top bar inside `DashboardLayout`:
- Global search input (searches devices by hostname/owner/device ID)
- Notification bell with unread alert count badge
- Admin profile chip (avatar + username + role, clickable for quick logout)

**Files:** `DashboardLayout.jsx` (add top bar above `<Outlet>`), new `components/TopBar.jsx`
**Design:** Dark bar (`bg-slate-900/80 backdrop-blur`), search expands on focus, bell pulses red when alerts exist. Replaces the current mobile-only header with a unified bar for all screen sizes.

### Phase 2 — Alerts Panel (new Screen 3)
**What:** New page at `/alerts` with auto-generated alerts:
- **Missed check-in** — device hasn't checked in >24h (derived from `last_checkin`)
- **Unexpected location jump** — device location moved >100km between check-ins (derived from location history)
- **Failed unlock attempt** — audit entries with unlock-failed actions

Each alert: severity color (red/amber/yellow), timestamp, device link, dismiss/acknowledge button.

**Files:** New `pages/AlertsPage.jsx`, new `api/alerts.js` (client-side alert derivation from existing `/devices` + `/audit` endpoints — no backend changes), add route + nav link in `App.jsx` + `DashboardLayout.jsx`
**Design:** List view with left severity stripe, filterable by severity. Dismissed alerts fade out. Bell count in top bar reflects undismissed alert count.

### Phase 3 — Device Table Upgrades
**What:** Enhance `DevicesPage` table:
- Add **Model** column (from `device.model` or hostname parsing)
- Add **Location** column (city-level, from latest location — fetched lazily or cached)
- Add **Quick Actions** column: lock icon (flag stolen) + flag icon (track) per row
- Add **Offline >24h** summary card alongside existing stats

**Files:** `DevicesPage.jsx` (table columns + quick actions), `index.css` (if new icon styles needed)
**Design:** Quick-action icons appear on row hover (subtle, not cluttered). Offline card uses amber glow. Table stays responsive — columns collapse on tablet.

### Phase 4 — Device Detail Map
**What:** Add large dark-themed map to `DeviceDetailPage`:
- Show last-known GPS pin with accuracy radius circle
- Show location history trail (polyline connecting past locations)
- Replace current text-only "Latest Location" card with the map

**Files:** `DeviceDetailPage.jsx` (integrate `react-leaflet` map, reuse `MapPage` patterns), `index.css` (already has Leaflet dark theme overrides)
**Design:** Map takes left column (60% width on desktop), event timeline on right. Trail fades older points. Uses existing Google-tile dark filter from `MapPage`.

### Phase 5 — Audit Log Filters
**What:** Add filtering to `AuditPage`:
- **Date range** picker (from/to date inputs)
- **Admin filter** dropdown (populated from `/admins` endpoint or distinct admin_usernames in logs)
- Combine with existing text search

**Files:** `AuditPage.jsx` (add filter UI + filter logic)
**Design:** Filter bar above the table, compact. Date inputs use native `<input type="date">` styled dark. Admin dropdown is a styled `<select>`.

### Phase 6 — Color Alignment + Micro-interactions
**What:**
- Update `index.css` badge classes to exact FleetGuard hex values:
  - Green `#22C55E` (active), Amber `#F59E0B` (warning/offline), Red `#EF4444` (stolen/locked)
- Add **badge pulse** micro-interaction: status badges pulse subtly (3s ease-in-out) when a device transitions to offline/stolen/locked
- Add CSS keyframe `badge-pulse` for the subtle pulse

**Files:** `index.css` (badge color values + new keyframe), `DevicesPage.jsx` / `DeviceDetailPage.jsx` (apply pulse class on status change)
**Design:** Pulse is subtle (opacity 0.7→1.0→0.7, 3s loop), not distracting. Only triggers on status *change*, not continuously.

### Phase 7 — Tests + Verification
**What:** Write/update Vitest tests for all new components:
- `TopBar.test.jsx` — search input, bell count, profile chip
- `AlertsPage.test.jsx` — alert derivation logic, dismiss behavior, severity filtering
- Update `DevicesPage.test.jsx` — new columns, quick-action buttons
- Update `DeviceDetailPage.test.jsx` — map rendering
- Update `AuditPage` tests (if any) — filter logic
- Run full sweep: `npx vitest run` + `npx eslint .` + `npx vite build`

**Files:** `tests/` directory
**Goal:** All 56+ existing tests still pass, new tests cover new functionality.

---

## Implementation order rationale
1. **Top bar first** — shell everything else sits in; notification bell needs Alerts feature to populate
2. **Alerts second** — feeds the bell count; entirely new screen
3. **Device table third** — high-visibility improvement, builds on existing structure
4. **Device detail map fourth** — most complex single change (Leaflet integration in detail page)
5. **Audit filters fifth** — straightforward enhancement
6. **Colors + micro-interactions sixth** — polish pass, touches all files
7. **Tests last** — covers everything

## Scope
~6 new/modified files for phases 1-5, CSS changes for phase 6, ~5 test files for phase 7.
No backend changes — all improvements derive from existing API endpoints.

## Status
- [x] Phase 1 — Top Bar
- [x] Phase 2 — Alerts Panel
- [x] Phase 3 — Device Table Upgrades
- [x] Phase 4 — Device Detail Map
- [x] Phase 5 — Audit Log Filters
- [x] Phase 6 — Color Alignment + Micro-interactions
- [x] Phase 7 — Tests + Verification

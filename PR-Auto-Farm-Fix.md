# WPlace Auto-Farm — Refactor: UI‑driven painting, API‑aware charges, resilient CF handling, and UX/i18n upgrades

## TL;DR
This PR replaces the legacy backend-driven painting flow with on-page UI automation, syncs charges via a lean strategy around the /me endpoint (no background polling), significantly strengthens Cloudflare challenge detection and resolution, and adds broad i18n plus recovery/diagnostic tooling. Result: a more human, less brittle flow with better operational resilience and clearer user feedback.

## Motivation (why)
The previous script (`ViejoAutoFarm.js`) painted by sending direct backend requests with minimal UI/state logic. That made it prone to Cloudflare lockouts, charge desynchronization, and breakage due to DOM changes or API pacing limits. We needed a more human approach—using the site’s own UI—and a much stronger Cloudflare detection that avoids false positives and reacts quickly.

## Comparison: Old vs New
- Before (ViejoAutoFarm.js)
  - Painting via direct POST to `https://backend.wplace.live/s0/pixel/...` with a random color.
  - Charges fetched from `/me` directly with limited synchronization logic.
  - Language chosen via IP (ipapi) with limited coverage (pt/en) and added fragility.
  - Simple UI: basic Start/Stop and counters; no multi-select or realistic cooldown handling.
  - No explicit Cloudflare handling; it could attempt to paint while a challenge was active.

- Now (Auto-Farm.js)
  - 100% UI-driven painting: opens the palette, picks a valid color, marks positions, and presses Paint; avoids gestures that could cause accidental zoom or panning.
  - Charge model: initialized from `/me` at Start and re-synced after each successful Paint (no background polling). While waiting, it relies on the Paint button’s countdown.
  - Multi-select: mark N squares in a single burst (Ctrl/Cmd) to consume multiple charges in one click (configurable and persisted).
  - Cloudflare detection: combined signals from network (Performance API), DOM (real visibility), multi-language text, a MutationObserver, and fast click strategies.
  - i18n based on browser language: `pt`, `en`, `es`, `fr`, `ru`, `nl`, `uk`; standardized labels/messages.
  - UX: panel with stats, persisted settings (confirm wait, resume threshold, max fails, squares per action), and a gear with useful actions (calibrate zoom, reset, sync /me, check health).
  - Robustness: safe reload with state persistence and auto-resume; zoom recovery only on failures with cooldown; throttled stats updates.

## Scope (what changes)
- UI-driven painting with palette control, area marking, and Paint confirmation.
- Charges: fetched once at Start and after each successful Paint. If `/me` returns HTTP 400 (temporary CF ban), pause `/me` calls for the next 10 paints and paint 1 pixel per action during the backoff.
- Cooldowns/timing: confirmation wait after Paint with a live countdown; real-time wait with 1s ticks; advisory minimum of 10s for confirmation.
- Cloudflare: new detection/handling (see technical section). The bot avoids painting while a challenge is active.
- i18n and UX: improved texts, controls, and gear actions; settings are persisted.

Out of scope:
- Backend changes or API contract changes. This PR only consumes `/me` and optionally `/health`.
- Complex pathing heuristics to choose “smart” areas. The goal remains simple/non-repetitive marking.

## Key technical details

### UI painting and human cadence
- Finds the Paint button and palette via DOM; opens the palette if closed.
- Picks a valid color detected in the UI (ignores disabled/banned; robust fallback to 1..31).
- Marks N positions (Ctrl/Cmd) with small pauses and jitter for a human cadence.
- Confirms Paint once, consuming multiple charges if available.
- Avoids double-clicks and pan/drag to keep zoom/viewport stable.

### Charges and cooldown
- Seeds charges/cooldown from `/me` on Start; after each successful Paint, calls `/me` again to reconcile the exact remaining charges.
- While waiting, uses the Paint button countdown (mm:ss) and shows ETA in the UI with 1s ticks.
- If `/me` returns HTTP 400 (temporary CF ban), enters backoff: pause `/me` for 10 paints, show “API paused” status, and paint only 1 pixel per action.

### Cloudflare detection and handling (improved)
- Combined detection, designed to avoid log-only false positives:
  - Network: Performance API detects `challenges.cloudflare.com` / `cdn-cgi/challenge-platform` resources.
  - Real visible DOM: CF selectors (e.g., `.cb-lb input[type="checkbox"]`, `.cf-challenge`, `#challenge-overlay`, `div[id^="cf-chl-widget"]`) with strict visibility checks (bounding rect, styles, opacity, and on-screen position).
  - Multi-language text: key phrases such as “Verify you are human / Verifica que eres un ser humano / Vérifiez que vous êtes humain / …” across ES/EN/FR/RU/NL/UK.
  - MutationObserver: real-time watch for DOM changes to react when the challenge appears.
- Fast checkbox resolution: center scroll, three click strategies (native `.click()`, MouseEvent, coordinate-based centered click), immediate verification via `checked`/`aria-checked`.
- Post-click verification: short wait (5s). If the challenge remains, the bot stops, updates the UI, and asks for manual intervention (prevents loops).
- Note: We deliberately do not “detect via logs only” (e.g., “resource preloaded but not used” messages) to avoid false positives when the widget is not actually visible on screen.

### UX, i18n, and tooling
- Persisted settings: confirm wait, resume threshold, max consecutive fails, squares per action, auto-calibrate on fail.
- Gear: Calibrate zoom (recovery routine), Reset counter, Refresh /me now (explicit 400 handling), Check health (`/health`) with a compact summary.
- i18n details: browser language (pt, en, es, fr, ru, nl, uk); standardized labels.

### Stability and safe reload
- Guards to suppress beforeunload prompts; safe reload with state persistence and auto-resume (waits up to 15s for UI readiness).
- Zoom recovery: only on paint failure, with cooldown; two controlled zoom-in steps after detecting the hint post-zoom-out.
- Throttled stats updates to avoid excessive reflows.

## Testing and validation (how to test)
1. Open wplace.live and ensure the Paint button and the palette are visible when opened.
2. Inject/execute Auto-Farm and press Start.
3. Verify: opens the palette if needed, picks a valid color, marks a non-repeating random area, and presses Paint.
4. Set “Squares per action” > 1 (e.g., 3) and, with enough charges, confirm multiple-charge consumption in a single Paint. If fewer charges are available than requested, it should consume exactly those available.
5. With charges available, the bot paints in bursts until exhausted; then it waits in real time with 1s ticks until charges return.
6. If a Cloudflare challenge appears (page/overlay/checkbox): it should detect it quickly, click once, and wait 5s. If it persists, the bot should stop and display a manual intervention message.
7. Set “Confirm wait” below 10s: the field should show a localized advisory and highlight (the value is not auto-changed). At 10s or more, the advisory disappears.
8. Force paint failures: observe the zoom recovery routine (when enabled) and verify it does not loop.
9. Open the gear and try: Reset counter, Refresh /me now (400 handling with visible backoff), Check health (compact JSON summary).
10. Validate auto-resume after a safe reload when the max consecutive fails threshold is exceeded.

## Compatibility impact
- Keeps legacy fallback for `START_X/START_Y` when the region isn’t available yet.
- Introduces no new external dependencies.
- Uses UI interactions instead of direct pixel endpoint calls; backend is only used for `/me` and optionally `/health`.

## Risks and mitigations
- DOM changes in the palette or Paint button might break selectors.
  - Mitigation: generic selectors + color fallback; we can harden selectors in follow-ups if regressions appear.
- CF challenge HTML may vary.
  - Mitigation: combined detection (network + visible DOM + text + MutationObserver) and multi-click strategy; easy to extend phrases/languages and selectors.
- UI vs `/me` values may drift due to latency.
  - Mitigation: reconcile after each successful Paint; no background polling otherwise.

## Rollback plan
- Revert to `ViejoAutoFarm.js` or to the previous `Auto-Farm.js` version in case of critical incidents. No persistent migrations.

## Pull Request checklist
- [x] UI-driven painting with valid color selection and Paint confirmation.
- [x] Multi-select N squares with Ctrl/Cmd (persisted and configurable).
- [x] `/me`-aware charge model (on Start and after Paint; no polling). Backoff on HTTP 400.
- [x] Improved CF detection: network + visible DOM + text + MutationObserver + fast click; avoids log-only false positives.
- [x] UX/i18n: normalized texts (pt, en, es, fr, ru, nl, uk), advisories, and persisted settings.
- [x] Operational safety: safe reload without prompts and auto-resume.
- [x] Zoom recovery with cooldown; no panning/drag and no accidental double-clicks.
- [x] Throttled stats; no new dependencies.

## Additional notes
- The console message “The resource … challenge-platform … was preloaded but not used…” no longer triggers detection by itself: it’s only used as a network signal in combination with visible DOM and/or text to avoid false positives when the widget isn’t on screen.
- The monitoring system is extensible (more languages, new CF selectors) without changing the main flow.


# Fix Auto-Farm: human-like UI automation, API-aware charges, real-time cooldown, and CF challenge handling

## Summary
Refactors Auto-Farm to operate via site UI and minimize backend calls: it selects valid colors, clicks on random unvisited pixels, ensures the palette is open, selects a color, and confirms by pressing Paint. It can now mark multiple squares per action (user-configurable) via Ctrl/Cmd multi-select, consuming multiple charges at once, and waits cooldown with 1s updates. To keep charge counts exact without polling, the script seeds from /me at Start and then fetches /me once after each successful paint to know how many charges remain; during waiting, it relies on the button UI (x/y and (mm:ss)) for display. If /me returns HTTP 400 (temporary Cloudflare ban), the bot pauses /me calls for the next 10 paints and clearly indicates that API calls are paused; during this backoff it paints only 1 pixel per action. Cloudflare challenge detection has been strengthened (including full-page “Checking your Browser…” screens and overlays) and the bot tries a single, center click on the most visible widget and waits 5s; if unresolved, it informs the user and stops. Stability is improved with a safe auto-reload that preserves settings, avoids “unsaved changes” prompts, and auto-resumes painting after reload. Zoom calibration is no longer performed on start; instead, a conservative zoom adjustment is attempted as a recovery after paint failures (with cooldown to avoid repetition), and there is a manual “Calibrate zoom” action in the floating gear. Additionally, the confirmation wait setting now includes an advisory minimum of 10s: if the value is below 10s, the input shows a localized warning and is highlighted in red (the value is not auto-changed).

## Changes
- Painting logic (UI + API)
  - Clicks random unvisited points within the canvas (central 90% area with margins), tracking a coarse grid to avoid repeats.
  - Ensures palette is open before color selection (Paint → area → color → Paint), as the palette closes after painting.
  - Presses the on-page Paint button to commit the action, and consumes all available charges in bursts.
  - New: user can choose how many squares to mark per action; the bot multi-selects that many positions (Ctrl on Win/Linux, Cmd on macOS) before confirming Paint. If the requested amount exceeds available charges, it consumes all current charges.
  - Immediately shows a “pixel painted” success message and effect when Paint is clicked, then starts a live confirmation countdown (default 10s). After confirming success, it fetches /me once to sync remaining charges. If the API returns 400, it enters a backoff: skip /me for the next 10 paints and show an API paused status in stats.
  - Avoids panning/drag gestures and avoids any double-clicks to prevent accidental zoom.
  - Zoom is not auto-adjusted on start. If a paint attempt fails, the bot tries a recovery: zoom out until the on-page hint is visible, then two small zoom-in steps, with pauses, and resumes painting. A cooldown prevents running this too often.
  - Charges model: /me is fetched once on Start to seed charges/cooldown; after each successful paint, the bot fetches /me to update the remaining charges. There is no background polling otherwise. Manual sync from the gear remains available (with HTTP 400 handling).
- Color handling
  - Extract available colors from the DOM (`[id^="color-"]`), ignoring disabled entries (with SVG) and banned IDs (0, 5).
  - Fallback to a valid random color (1..31) if palette detection fails.
- Internationalization
  - Browser-based language detection.
  - Added translations: `pt`, `en`, `es`, `fr`, `ru`, `nl`, `uk`; standardized keys (minimize, loading, status messages). Includes label for the new “max fails” setting.
- UX and guidance
  - Fixed Start/Stop toggle HTML and tooltips; consistent theme and labels.
  - Panel settings: confirmation wait seconds, resume threshold, max consecutive fails, and squares per action (all persisted).
  - Added a “Calibrate zoom” action in a floating settings gear (bottom-left) with i18n (pt, en, es, fr, ru, nl, uk) that runs the zoom routine on demand, plus a toggle “Auto-calibrate on fail”.
  - Moved the settings gear inside the main panel, small and tucked in the bottom-right of the panel content under the status line, to avoid covering page controls.
  - New gear actions: “Reset counter” (reset painted pixels and retries), “Refresh /me now” with API call and explicit 400 handling (temporary Cloudflare ban), and “Check health” to query https://backend.wplace.live/health and show a compact status (up, DB, uptime), e.g. {"database":true,"up":true,"uptime":"5h47m38.958463875s"}.
- Performance and pacing
  - Stats panel updates are throttled.
  - Cooldown handling uses the UI button countdown (mm:ss) and waits in real time (1s tick) until charges are available. The stats panel no longer shows a dedicated "Cooldown/Espera" row.
  - Increased base delay between intra-burst actions with jitter for a more human cadence.
  - Added a configurable confirmation wait (default 10s) with live countdown after each paint to align with site processing time.
  - Charges are fetched immediately after successful paints; no periodic polling is performed. When /me is paused due to a 400, paints proceed without API sync for 10 paints, and the stats show “API: Paused (N paints)”. During /me backoff, the bot paints conservatively (1 pixel per action). On paint failures while backoff is active, it waits 2 minutes before the next attempt; if errors continue and exceed the configured max fails, it reloads the page as usual.
  - Confirm wait advisory: if the confirmation wait is set below 10s, the field is highlighted in red and a localized warning is shown to suggest a safe minimum. The value is not auto-modified.
  - Auto-reload safety: if too many consecutive paint errors occur, the page reloads automatically; user settings persist, the reload suppresses “changes may not be saved” prompts, and the bot auto-resumes (waits for UI readiness up to 15s).
## Human-like operation improvements
- UI-driven painting only: selects a valid palette color, clicks a random unvisited pixel area, and presses the Paint button.
- No double-clicks and no panning to avoid unintended zoom or viewport movement.
 - Does not paint as soon as 1 charge is available; waits for a configurable “resume charges” threshold after reaching 0 (default randomized between a min/max range) to appear more human.
 - Zoom recovery routine (on errors): zooms out to show the hint and then performs two small zoom-in steps to enable painting; limited by a cooldown.

## Robustness
  - Null-safe access in stats.
  - Removed IP-based language fetch.
  - Minimal reliance on backend: only /me for charges/cooldown; painting is executed through UI.
    - Cloudflare challenge detection: clicks the widget once and waits 5s; if not solved, the bot stops and asks the user to click it and wait 5s, then Start again.
    - Safe auto-reload after repeated failures with state persistence, no beforeunload prompts, and robust auto-start after reload.

## Rationale
- Backend requires region-aware URLs with absolute coords; previous logic could target unintended areas.
- Using the on-page palette avoids blocked colors and mismatch with available dyes.
- Browser language is more stable than external geo lookups.
- Throttling avoids API spam and potential rate limits.

## Technical Notes
- Paint action is driven by the on-page Paint button found via DOM queries; order is enforced: ensure palette open → pick area → pick color → confirm Paint.
- Cooldown is primarily taken from the UI (button (mm:ss) countdown); the bot waits in real time (every 1s) until charges are available. After confirming a successful paint, it fetches /me once to synchronize the remaining charges for subsequent actions. The stats panel omits a standalone cooldown value.
  - Squares per action: the script first selects a color, then marks N positions using Ctrl/Cmd modifier flags in mouse events to multi-select, and finally confirms Paint to consume multiple charges in one action. Success is computed by comparing API charge deltas and, as a secondary signal, the UI x/y counters.
  - Zoom automation (recovery only): uses WheelEvent over the main canvas to zoom out (limited attempts with pauses) until the “Zoom in to see the pixels” hint button is visible, then performs exactly two small zoom-in steps with 1s intervals. Also available via the UI button.
  - Charges sync strategy: initializes from /me once at Start (with UI fallback), then calls /me after each successful paint to get the exact remaining charges. No background polling during idle/wait loops; manual refresh in the gear calls /me on demand with error handling.
- Cloudflare challenge handling: detect iframes/widgets (Turnstile/hCaptcha-like) and full-page CF screens (“Checking your Browser…”, overlays, challenge-platform scripts). On detection, the bot clicks the widget once and waits 5 seconds; if still present, the bot stops and shows a message to resolve manually and restart. A pre-paint check is also performed before each attempt to avoid trying to paint while a challenge is active.
- Avoid accidental zoom: removed second “assist” click on canvas to prevent double-click zoom gestures.
 - After each Paint attempt, success is verified by checking that the integer charges decreased via the /me endpoint; stats are updated accordingly.
   - New settings in the panel: confirmation wait seconds; resume threshold (charges) after hitting 0; and max consecutive fails before safe reload. If no resume threshold is provided, a random value in a configurable range is used.
   - Safe reload guard: before reloading, handlers and listeners for beforeunload are neutralized to avoid any “changes may not be saved” prompts. After reload, the bot waits up to 15s for the UI to be ready and auto-presses Start.

### Delta (2025-08-13)
- API-aware charges and real-time cooldown:
  - Use /me to fetch charges and cooldownMs; wait live (1s tick) until charges > 0.
  - Consume all charges in bursts with small human-like delays between actions.
- UI sequence and zoom fix:
  - Enforce Paint → area → color → Paint ordering, reopening palette if needed.
  - Removed the second canvas click to avoid accidental double-click zoom.
  - Removed auto-zoom on start; added zoom recovery after failures with cooldown.
- Cloudflare challenge handling:
  - Detect iframes/widgets indicative of a challenge (Cloudflare/Turnstile/challenge classes) and full-page CF pages (“Checking your Browser…”, overlay, challenge-platform script presence).
  - On detection, the bot clicks the widget once and waits exactly 5 seconds.
  - If the challenge remains, the bot stops automatically and shows a clear message asking you to click it and wait 5s, then Start again.
  - Added a pre-paint challenge check inside each burst to prevent attempts while a challenge is active.
  - If solved after pressing Paint, retry confirming Paint automatically.
 - Stability and persistence:
   - Added UI setting “max fails” (MAX_CONSEC_FAILS) to control when a safe reload is triggered; persisted across sessions.
   - Implemented a no-prompt reload guard to suppress any “unsaved changes” dialogs.
   - Auto-resume after reload improved: waits for the Start button for up to 15s and starts automatically.
 - Squares per action:
   - New UI setting “Squares per action” persisted across sessions.
   - Multi-select N points per action using Ctrl (Windows/Linux) or Cmd (macOS) and confirm Paint to consume multiple charges at once.
   - If N exceeds available charges, the action consumes all currently available charges.
 - Minimal /me usage:
   - Query /me once at Start and after each successful Paint; no background polling otherwise. A manual “Refresh /me now” in the gear forces a call to /me and handles HTTP 400 (temporary Cloudflare ban). If /me returns 400, the bot pauses all /me calls for the next 10 paints, shows a clear API paused status, and reduces to 1 pixel per paint during the backoff.
 - Health endpoint:
   - New “Check health” action in the gear queries https://backend.wplace.live/health and displays a compact summary in the status line. Example: {"database":true,"up":true,"uptime":"5h47m38.958463875s"}.
 - Confirmation wait advisory:
   - When the “Confirm wait” is set below 10s, the input is highlighted in red and a localized warning is displayed to suggest a safe minimum. No automatic change is made to the user’s value.
 - Settings gear actions:
   - Calibrate zoom: run the recovery zoom routine on demand.
   - Auto-calibrate on fail: if enabled, performs a zoom calibration when a paint fails (with cooldown to avoid loops).
   - Reset counter: zero both painted pixels and retry counter immediately.
   - Refresh /me now: call /me immediately and update the local charges; on HTTP 400, show a “temporarily banned by Cloudflare” message.

### Background/unattended operation notes
- Keep the tab open; avoid opening DevTools while the bot runs (may trigger extra challenges).
- The bot introduces jitter and exponential backoff to reduce request regularity and comply with pacing.
- If the site requires periodic human interaction, the assisted flow will prompt and resume with minimal friction.
- Preflight is disabled while a challenge is active to avoid aggravating it.

## Backwards Compatibility
- Keeps legacy fallback for `START_X/START_Y` when region isn’t captured yet.
- UI remains compact and consistent with existing theme.

## How to Test
1. Open `wplace.live` and ensure the color palette and the Paint button are visible.
2. Execute Auto-Farm (bookmarklet/console injector) and click Start.
3. The script opens Paint, selects a color, marks a random unvisited spot (or multiple spots based on the setting), and presses Paint.
4. Set “Squares per action” to a value > 1 (e.g., 3) and verify that, with enough charges, it consumes 3 charges in one action; if charges are fewer than requested, it consumes exactly the available charges.
5. With multiple charges available, it will paint in bursts using them all, with brief pauses.
6. If there are no charges, it waits in real-time (updates every 1s) until charges appear; stats show charges (no cooldown row).
7. If a Cloudflare challenge appears, the bot clicks the widget once and waits 5 seconds. If it remains, the bot stops and shows a message to click it manually and wait 5s, then press Start again.
8. Verify that auto-zoom does not run on start. To test zoom recovery, force a few paint failures; the bot will attempt zoom calibration once (respecting a cooldown) and continue.
9. Click the “Calibrate zoom” button to run the routine on demand and confirm you can paint afterwards.
10. Open the gear inside the panel and use:
  - “Reset counter” to zero stats; verify the Pixels count resets and errors counter clears.
  - “Refresh /me now” to force a call to /me; verify charges/cooldown update. If the API returns 400, a “temporary Cloudflare ban” message should appear.
  - Toggle “Auto-calibrate on fail” on/off and provoke a paint error to see the zoom routine run (or not) accordingly.
11. Validation hint: set “Confirm wait” to 5 seconds; the input should be red and a localized warning message should appear under the field. Change it to 10 seconds or more; the warning disappears and the field returns to normal.
11. (Optional) Simulate a slow network: the UI should remain responsive and charges should still update when the API responds; the manual refresh can be used to fetch immediately.
12. Set “Reintentos/Max fails” to a small number (e.g., 1 or 2), provoke paint errors (e.g., by blocking clicks), and observe: the page reloads without any “changes may not be saved” prompt, and the bot auto-resumes after reload.

## Risks and Mitigations
- DOM changes in the palette may break color extraction.
  - Mitigation: fallback to a random valid color (1..31); consider selector hardening in follow-ups.
- If the board tile size differs from 100, random placement may drift.
  - Mitigation: `PIXELS_PER_LINE` is configurable; we can add auto-detection later.

## Checklist
- [x] Palette-based color selection with safe fallback
- [x] i18n detection and translations (pt, en, es, fr, ru, nl, uk)
- [x] Stats throttling and cooldown handling via UI countdown (with API sync after paint)
- [x] Null-safe UI updates
- [x] No new runtime dependencies introduced
- [x] Cloudflare challenge detection and auto-handling with user notification fallback
- [x] Burst painting using all available charges, with human-like delays
 - [x] Safe reload without beforeunload prompts and with auto-resume
 - [x] Max consecutive fails adjustable in UI and persisted
 - [x] Squares per action with Ctrl/Cmd multi-select and persisted setting
 - [x] Zoom recovery routine (not on Start), and manual Calibrate button
 - [x] Charges seeded from /me at Start and synced after each successful paint (no background polling)
 - [x] Gear actions: Reset counter and Refresh /me now (with i18n)
 - [x] Auto-calibrate on fail toggle and gear repositioned above page button

## Related
- Aligns Auto-Farm behavior with Auto-Image’s service contracts and UX expectations.

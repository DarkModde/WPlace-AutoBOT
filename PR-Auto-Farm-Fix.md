# Fix Auto-Farm: human-like UI automation, API-aware charges, real-time cooldown, and CF challenge handling

## Summary
Refactors Auto-Farm to operate via site UI with API awareness for charges/cooldown: it selects valid colors, clicks on random unvisited pixels across the canvas, ensures the palette is open, selects a color, confirms by pressing Paint, consumes all available charges in bursts, and waits cooldown in real time with 1s updates. It also detects and tries to solve Cloudflare challenges automatically; if unresolved, it informs the user.

## Changes
- Painting logic (UI + API)
  - Clicks random unvisited points within the canvas (central 90% area with margins), tracking a coarse grid to avoid repeats.
  - Ensures palette is open before color selection (Paint → area → color → Paint), as the palette closes after painting.
  - Presses the on-page Paint button to commit the action, and consumes all available charges in bursts.
  - Immediately shows a “pixel painted” success message and effect when Paint is clicked, then starts a live confirmation countdown (default 10s) before verifying via API.
    - Immediately shows a “pixel painted” success message and effect when Paint is clicked, then starts a live confirmation countdown (default 10s) while polling /me every second to keep charges in sync.
  - Avoids panning/drag gestures and avoids any double-clicks to prevent accidental zoom.
- Color handling
  - Extract available colors from the DOM (`[id^="color-"]`), ignoring disabled entries (with SVG) and banned IDs (0, 5).
  - Fallback to a valid random color (1..31) if palette detection fails.
- Internationalization
  - Browser-based language detection.
  - Added translations: `pt`, `en`, `es`, `fr`, `ru`, `nl`, `uk`; standardized keys (minimize, loading, status messages).
- UX and guidance
  - Fixed Start/Stop toggle HTML and tooltips; consistent theme and labels.
- Performance and pacing
  - Stats panel updates are throttled.
  - Cooldown handling uses the API (/me) and waits in real time (1s tick) until integer charges (floor) ≥ 1, showing ETA.
  - Increased base delay between intra-burst actions with jitter for a more human cadence.
  - Added a configurable confirmation wait (default 10s) with live countdown after each paint to align with site processing time.
  - Charges are fetched frequently (with short caching) to promptly use all available ones.
## Human-like operation improvements
- UI-driven painting only: selects a valid palette color, clicks a random unvisited pixel area, and presses the Paint button.
- No double-clicks and no panning to avoid unintended zoom or viewport movement.
 - Does not paint as soon as 1 charge is available; waits for a configurable “resume charges” threshold after reaching 0 (default randomized between a min/max range) to appear more human.

## Robustness
  - Null-safe access in stats.
  - Removed IP-based language fetch.
  - Minimal reliance on backend: only /me for charges/cooldown; painting is executed through UI.
  - Cloudflare challenge detection: clicks the widget once and waits 5s; if not solved, the bot stops and asks the user to click it and wait 5s, then Start again.

## Rationale
- Backend requires region-aware URLs with absolute coords; previous logic could target unintended areas.
- Using the on-page palette avoids blocked colors and mismatch with available dyes.
- Browser language is more stable than external geo lookups.
- Throttling avoids API spam and potential rate limits.

## Technical Notes
- Paint action is driven by the on-page Paint button found via DOM queries; order is enforced: ensure palette open → pick area → pick color → confirm Paint.
- Cooldown is taken from the API (/me) and the bot waits in real time (every 1s) until integer charges are available; button countdown is used as a fallback display.
  - After clicking Paint, the script polls /me every second during the confirmation window to reflect charge decrements immediately and keep burst logic accurate.
- Cloudflare challenge handling: detect iframes/widgets (Turnstile/hCaptcha-like), click the widget once and wait 5 seconds; if still present, the bot stops and shows a message to resolve manually and restart.
- Avoid accidental zoom: removed second “assist” click on canvas to prevent double-click zoom gestures.
 - After each Paint attempt, success is verified by checking that the integer charges decreased via the /me endpoint; stats are updated accordingly.
 - New settings in the panel: confirmation wait seconds; resume threshold (charges) after hitting 0. If no threshold is provided, a random value in a configurable range is used to resume painting.

### Delta (2025-08-13)
- API-aware charges and real-time cooldown:
  - Use /me to fetch charges and cooldownMs; wait live (1s tick) until charges > 0.
  - Consume all charges in bursts with small human-like delays between actions.
- UI sequence and zoom fix:
  - Enforce Paint → area → color → Paint ordering, reopening palette if needed.
  - Removed the second canvas click to avoid accidental double-click zoom.
- Cloudflare challenge handling:
  - Detect iframes/widgets indicative of a challenge (Cloudflare/Turnstile/challenge classes).
  - On detection, the bot clicks the widget once and waits exactly 5 seconds.
  - If the challenge remains, the bot stops automatically and shows a clear message asking you to click it and wait 5s, then Start again.
  - If solved after pressing Paint, retry confirming Paint automatically.

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
3. Observe: the script opens Paint, clicks a random unvisited spot, selects a color, and presses Paint.
4. With multiple charges available, it will paint in bursts using them all, with brief pauses.
5. If there are no charges, it waits in real-time (updates every 1s) until charges appear; stats show charges and cooldown.
6. If a Cloudflare challenge appears, the bot clicks the widget once and waits 5 seconds. If it remains, the bot stops and shows a message to click it manually and wait 5s, then press Start again.
7. Verify that the canvas does not zoom unexpectedly (no double-clicks are sent).

## Risks and Mitigations
- DOM changes in the palette may break color extraction.
  - Mitigation: fallback to a random valid color (1..31); consider selector hardening in follow-ups.
- If the board tile size differs from 100, random placement may drift.
  - Mitigation: `PIXELS_PER_LINE` is configurable; we can add auto-detection later.

## Checklist
- [x] Palette-based color selection with safe fallback
- [x] i18n detection and translations (pt, en, es, fr, ru, nl, uk)
- [x] Stats throttling and cooldown handling via API (fallback to UI parsing)
- [x] Null-safe UI updates
- [x] No new runtime dependencies introduced
- [x] Cloudflare challenge detection and auto-handling with user notification fallback
- [x] Burst painting using all available charges, with human-like delays

## Related
- Aligns Auto-Farm behavior with Auto-Image’s service contracts and UX expectations.

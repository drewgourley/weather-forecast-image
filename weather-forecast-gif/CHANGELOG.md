# Changelog

## 1.6.5

- Atomic GIF writes: output is written to a temp file then renamed, so the display never reads a partially-written file
- Per-frame error isolation in weather GIF: if one animation frame fails to render, the last good frame is reused instead of aborting
- Added `weatheralerts_entity` to translations

## 1.6.4

- Error hardening

## 1.6.3

- Parse description for better detection of alert state

## 1.6.2

- Add special condition for tornado icon

## 1.6.1

- Feature: Optional `weatheralerts_entity` (weatheralerts HACS integration) — active alerts replace the humidity column with an alert type icon and 3-letter event code (TOR, THU, FLO, etc.); RH returns when no alerts are active

## 1.6.0

- Finalize icon updates

## 1.5.9

- Even more icon updates

## 1.5.8

- More icon updates

## 1.5.7

- Start icon update

## 1.5.6

- Hard code unnecessary config options

## 1.5.5

- Fix config descriptions... again... again

## 1.5.4

- Fix config descriptions... again

## 1.5.3

- Fix config descriptions

## 1.5.2

- Replaced axios with native fetch API to reduce dependency weight

## 1.5.1

- Sync night icon variants between station and forecast entities for current conditions

## 1.5.0

- Switched both weather and radar GIFs from gif-encoder (NeuQuant per-frame) to omggif (global color table) for consistent colors across all frames
- Added radar legend color bar replacing gray divider in radar header
- Defined FIXED_RADAR_COLORS constants for 17 radar intensity levels
- Radar palette now reserves both UI and radar legend colors before frequency-based fill
- Removed unused gif-encoder and canvas dependencies

## 1.4.0

- Feature: Animated radar map GIF using RainViewer data centered on Home Assistant home location
- Radar composites over CartoDB dark basemap for map topography context
- Home icon overlay marks home location on radar
- Date/time header overlay with black background at top of radar frames
- Progress bar at bottom of radar frames indicating animation position
- Per-frame timestamp in 24hr format in lower-left corner
- Last radar frame holds 3x longer for readability
- Configurable radar zoom, color scheme, smoothing, and snow display
- Served at `/radar.gif` alongside existing weather GIF

## 1.3.2

- Override humidity with hyperlocal weather station value when available

## 1.3.1

- Shifted forecast columns and current temperature display 1px right for better alignment

## 1.3.0

- Feature: AM/PM indicator appended to time display in header

## 1.2.0

- Feature: Added relative humidity display (icon, percentage, RH label) between current condition icon and temperature
- Feature: Main weather icon animates between station and forecast conditions
- Forecast column icons use alt-frame animation

## 1.1.0

- Fix: Station entity now only overrides icon and current temperature
- Fix: Fetch daily forecast via `weather.get_forecasts` service (HA 2024.3+ compatibility)
- Fix: Unwrap `service_response` key from HA REST API response
- Feature: Main weather icon animates between station condition and PirateWeather forecast condition
- Forecast column icons continue to use alt-frame animation
- Removed verbose debug logging

## 1.0.0

- Initial release as Home Assistant add-on
- Generates animated 64×64 weather forecast GIF
- Supports separate forecast and station weather entities
- Built-in web server for serving the GIF
- Refreshes every minute on the minute
- Built-in web server for serving the GIF
- Refreshes every minute on the minute

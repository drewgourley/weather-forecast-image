# Changelog

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

# Changelog

## 1.0.3

- Fix: Add `?return_response` to `get_forecasts` service call (required by HA for response-returning services)

## 1.0.2

- Fix: Station entity now only overrides icon and current temperature (humidity, wind, pressure come from forecast entity)
- Fix: Use `weather.get_forecasts` service for daily forecast data (HA 2024.3+ removed forecast attribute)

## 1.0.1

- Dev release

## 1.0.0

- Initial release as Home Assistant add-on
- Generates animated 64×64 weather forecast GIF
- Supports separate forecast and station weather entities
- Built-in web server for serving the GIF
- Refreshes every minute on the minute

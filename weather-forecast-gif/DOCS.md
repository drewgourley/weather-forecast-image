# Weather Forecast GIF

Generates an animated 64×64 pixel weather forecast GIF from Home Assistant weather entities. Designed for Divoom Pixoo 64 and similar pixel displays. Design is meant to be very similar to the look and feel of the Divoom Pixoo 64's weather component, with some minor tweaks.

## Integrations

This add-on is designed to work with the following Home Assistant integrations:

- **[Home Assistant Weather](https://www.home-assistant.io/integrations/weather/)** — The built-in HA weather integration. Any `weather.*` entity from this integration can be used as the forecast entity.
- **[Pirate Weather (HACS)](https://github.com/Pirate-Weather/pirate-weather-ha)** — A HACS integration providing a high-quality `weather.pirateweather` entity with reliable daily forecast data. Recommended for the forecast entity.
- **[Ambient Weather Station - Local (HACS)](https://github.com/tlskinneriv/awnet_local)** — A HACS integration that exposes a local Ambient Weather personal weather station as a `weather.*` entity. Intended for use as the station entity to provide hyperlocal current conditions.
- **[Weatheralerts (HACS)](https://github.com/custom-components/weatheralerts)** — A HACS integration that surfaces active NWS weather alerts as a `weatheralerts.*` entity. Used by the optional alerts feature to display active alert severity and type on the display.

## Configuration

### Forecast Entity

A `weather.*` entity that provides daily forecast data. This entity is used for the 4-day forecast section and as a baseline for current conditions.

Any standard HA weather entity works, but [Pirate Weather](https://github.com/Pirate-Weather/pirate-weather-ha) is recommended for reliable daily forecast data. Example value: `weather.pirateweather`.

### Station Entity (optional)

A `weather.*` entity for hyperlocal current conditions, intended for use with [Ambient Weather Station - Local](https://github.com/tlskinneriv/awnet_local) or a similar personal weather station integration. When configured, the current temperature and humidity shown on the display are pulled from this entity instead of the forecast entity.

Leave empty to use only the forecast entity for current conditions.

### Weather Alerts Entity (optional)

A `weatheralerts.*` entity from the [Weatheralerts](https://github.com/custom-components/weatheralerts) HACS integration. When active alerts are present, the humidity column on the display is replaced with an alert severity icon and a 3-letter event code (e.g. `TOR`, `THN`, `FLO`). Humidity returns when no alerts are active.

Leave empty to disable alert display.

### Radar Zoom

Map zoom level for the radar view (1–7). Lower values show a wider area; higher values show more local detail. Default: `6`.

## Endpoints

The add-on runs a web server on port `6942`. The GIFs are served at:

- `http://<your-ha-ip>:6942/` — Weather forecast GIF
- `http://<your-ha-ip>:6942/weather.gif` — Weather forecast GIF (alias)
- `http://<your-ha-ip>:6942/radar.gif` — Animated radar map GIF

## Display Layout

The weather GIF is a 64×64 pixel animated image:

- **Header row**: Date (MM•DD), time (H:MM AM/PM), day of week
- **Main section**: Animated weather icon + current temperature; humidity (or active alert) in the center column
- **Today's high/low**: Yellow high, blue low
- **4-day forecast**: Day labels, weather icons, high/low temps

| Weather forecast | Active alert | Radar map |
|:---:|:---:|:---:|
| ![Weather forecast example](https://raw.githubusercontent.com/drewgourley/weather-forecast-image/refs/heads/master/weather-forecast-gif/examples/example-output.gif) | ![Active alert example](https://raw.githubusercontent.com/drewgourley/weather-forecast-image/refs/heads/master/weather-forecast-gif/examples/example-alert.gif) | ![Radar map example](https://raw.githubusercontent.com/drewgourley/weather-forecast-image/refs/heads/master/weather-forecast-gif/examples/example-radar.gif) |

## Radar Map

The radar GIF is a 64×64 pixel animated image showing a 5-frame loop using [RainViewer](https://www.rainviewer.com/) data centered on your Home Assistant home location (`zone.home`). Each frame covers roughly the last 50 minutes of radar history. If radar data is unavailable, the radar endpoint falls back to serving a copy of the weather forecast GIF.

## Using with Divoom Pixoo 64

Point your Pixoo's custom GIF channel at the web server URL to display the weather forecast.
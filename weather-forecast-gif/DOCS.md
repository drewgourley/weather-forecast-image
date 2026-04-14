# Weather Forecast GIF

Generates an animated 64×64 pixel weather forecast GIF from Home Assistant weather entities. Designed for Divoom Pixoo 64 and similar pixel displays.

## Configuration

### Forecast Entity

A `weather.*` entity that provides daily forecast data, such as `weather.pirateweather`. This entity is used for the 4-day forecast section and as a fallback for current conditions.

### Station Entity (optional)

A `weather.*` entity from a local weather station (e.g. `weather.my_ambient_weather_station`). When configured, current conditions (temperature, humidity, wind speed) are pulled from this entity instead of the forecast entity, giving you hyperlocal readings.

Leave empty to use only the forecast entity for both current conditions and forecast.

### Port

The port number for the built-in web server. Default is `6942`. The GIF is served at:

- `http://<your-ha-ip>:<port>/` — Weather forecast GIF
- `http://<your-ha-ip>:<port>/weather.gif` — Weather forecast GIF (alias)
- `http://<your-ha-ip>:<port>/radar.gif` — Animated radar map GIF

## Radar Map

When enabled, generates a second 64×64 animated GIF showing a 5-frame radar loop using [RainViewer](https://www.rainviewer.com/) data centered on your Home Assistant home location (from `zone.home`). Each frame represents ~10 minutes of radar data, covering roughly the last 50 minutes.

### Radar Enabled

Enable or disable radar map generation. Default: `true`.

### Radar Zoom

Map zoom level (1–7). Higher values show a smaller area with more detail. Default: `5`.

### Radar Color Scheme

RainViewer color scheme ID (0–8). See [RainViewer Color Schemes](https://www.rainviewer.com/api/color-schemes.html) for previews. Default: `2` (Original).

### Radar Smooth

Apply smoothing/blur to radar data for a cleaner look. Default: `true`.

### Radar Snow

Display snow in separate colors on the radar tiles. Default: `true`.

## Display Layout

The weather GIF is a 64×64 pixel animated image with two alternating frames:

- **Header row**: Date (MM•DD), time (H:MM), day of week
- **Main section**: Animated weather icon + current temperature
- **Today's high/low**: Yellow high, blue low with separator
- **4-day forecast**: Day labels, weather icons, high/low temps

## Using with Divoom Pixoo 64

Point your Pixoo's custom GIF channel at the web server URL to display the weather forecast on your pixel display. Use `/radar.gif` for the radar map.

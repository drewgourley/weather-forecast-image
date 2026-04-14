#!/usr/bin/with-contenv bashio
bashio::log.info "Starting Weather Forecast GIF Generator"

export SUPERVISOR_URI="http://supervisor/core"
export FORECAST_ENTITY=$(bashio::config 'forecast_entity')
export STATION_ENTITY=$(bashio::config 'station_entity')
export PORT=$(bashio::config 'port')
export RADAR_ENABLED=$(bashio::config 'radar_enabled')
export RADAR_ZOOM=$(bashio::config 'radar_zoom')
export RADAR_COLOR_SCHEME=$(bashio::config 'radar_color_scheme')
export RADAR_SMOOTH=$(bashio::config 'radar_smooth')
export RADAR_SNOW=$(bashio::config 'radar_snow')

cd /
npm run start

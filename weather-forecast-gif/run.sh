#!/usr/bin/with-contenv bashio
bashio::log.info "Starting Weather Forecast GIF Generator"

export SUPERVISOR_URI="http://supervisor/core"
export FORECAST_ENTITY=$(bashio::config 'forecast_entity')
export STATION_ENTITY=$(bashio::config 'station_entity')
export WEATHERALERTS_ENTITY=$(bashio::config 'weatheralerts_entity')
export RADAR_ZOOM=$(bashio::config 'radar_zoom')

cd /
npm run start

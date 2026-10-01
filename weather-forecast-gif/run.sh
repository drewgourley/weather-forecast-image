#!/usr/bin/with-contenv bashio
bashio::log.info "Starting Weather Forecast GIF Generator"

export SUPERVISOR_URI="http://supervisor/core"
export FORECAST_ENTITY=$(bashio::config 'forecast_entity')
export STATION_ENTITY=$(bashio::config 'station_entity')
export WEATHERALERTS_ENTITY=$(bashio::config 'weatheralerts_entity')
export RADAR_ZOOM=$(bashio::config 'radar_zoom')
export SHOW_TIME=$(bashio::config 'show_time')
export DATE_FORMAT=$(bashio::config 'date_format')
export TIME_FORMAT=$(bashio::config 'time_format')
export CARTODB_API_KEY=$(bashio::config 'cartodb_api_key')

cd /
npm run start

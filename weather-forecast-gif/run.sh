#!/usr/bin/with-contenv bashio
bashio::log.info "Starting Weather Forecast GIF Generator"

export SUPERVISOR_URI="http://supervisor/core"
export FORECAST_ENTITY=$(bashio::config 'forecast_entity')
export STATION_ENTITY=$(bashio::config 'station_entity')
export PORT=$(bashio::config 'port')

cd /
npm run start

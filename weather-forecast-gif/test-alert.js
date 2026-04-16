#!/usr/bin/env node
/**
 * Alert test stub — generates a weather GIF with an active weather alert injected,
 * so the alert icon + 3-letter code column can be verified without a live HA instance.
 * Usage: node test-alert.js [type] [code]
 *   type  — alert type key: warning, watch, advisory, emergency, immediate, statement, outlook, test
 *           (default: warning)
 *   code  — 3-letter event code: TOR, THU, FLO, WNT, etc.
 *           (default: TOR)
 * Output: ./test-alert.gif
 */

const path = require('path');
const { generateGIF } = require('./index');

const ALERT_TYPE_MAP = {
  'warning':   'warning-small',
  'emergency': 'warning-small',
  'immediate': 'warning-small',
  'watch':     'watch-small',
  'important': 'watch-small',
  'alert':     'watch-small',
  'advisory':  'info-small',
  'statement': 'info-small',
  'outlook':   'info-small',
  'message':   'info-small',
  'forecast':  'info-small',
  'test':      'info-small',
  'outage':    'info-small',
};

async function main() {
  const typeArg = (process.argv[2] || 'warning').toLowerCase();
  const codeArg = (process.argv[3] || 'TOR').toUpperCase();

  const typeIcon = ALERT_TYPE_MAP[typeArg] || 'info-small';

  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;

  const weatherData = {
    currently: {
      icon: 'thunderstorm',
      forecastIcon: 'rain',
      temperature: 68,
      apparentTemperature: 65,
      humidity: 0.82,
      windSpeed: 22.5,
      pressure: 29.45,
      time: now,
      alert: { typeIcon, code: codeArg },
    },
    daily: {
      data: [
        { time: now,           icon: 'thunderstorm',     temperatureHigh: 74, temperatureLow: 61 },
        { time: now + DAY,     icon: 'rain',             temperatureHigh: 70, temperatureLow: 58 },
        { time: now + DAY * 2, icon: 'partly-cloudy-day',temperatureHigh: 75, temperatureLow: 60 },
        { time: now + DAY * 3, icon: 'clear-day',        temperatureHigh: 82, temperatureLow: 63 },
        { time: now + DAY * 4, icon: 'cloudy',           temperatureHigh: 71, temperatureLow: 57 },
      ],
    },
  };

  const outputFile = path.join(__dirname, 'test-alert.gif');
  console.log(`Generating alert test GIF...`);
  console.log(`  Alert type: ${typeIcon}`);
  console.log(`  Alert code: ${codeArg}`);

  await generateGIF(weatherData, outputFile);
  console.log(`✓ Alert test GIF written to: ${outputFile}`);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});

#!/usr/bin/env node

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');
const cron = require('node-cron');
const express = require('express');

// Home Assistant add-on configuration
const HA_API_BASE = (process.env.SUPERVISOR_URI || 'http://supervisor/core') + '/api';
const SUPERVISOR_TOKEN = process.env.SUPERVISOR_TOKEN;

// Load add-on options from env vars (set by run.sh via bashio)
function loadOptions() {
  return {
    forecast_entity: process.env.FORECAST_ENTITY || 'weather.pirateweather',
    station_entity: process.env.STATION_ENTITY || '',
    port: parseInt(process.env.PORT || '6942'),
    radar_enabled: (process.env.RADAR_ENABLED || 'true') === 'true',
    radar_zoom: parseInt(process.env.RADAR_ZOOM || '6'),
    radar_color_scheme: parseInt(process.env.RADAR_COLOR_SCHEME || '2'),
    radar_smooth: (process.env.RADAR_SMOOTH || 'true') === 'true',
    radar_snow: (process.env.RADAR_SNOW || 'true') === 'true',
  };
}

// Map Home Assistant weather conditions to icon names used by the GIF renderer
function mapHAConditionToIcon(condition) {
  const map = {
    'clear-night': 'clear-night',
    'cloudy': 'cloudy',
    'exceptional': 'unknown',
    'fog': 'fog',
    'hail': 'hail',
    'lightning': 'thunderstorm',
    'lightning-rainy': 'thunderstorm',
    'partlycloudy': 'partly-cloudy-day',
    'pouring': 'rain',
    'rainy': 'rain',
    'snowy': 'snow',
    'snowy-rainy': 'sleet',
    'sunny': 'clear-day',
    'windy': 'wind',
    'windy-variant': 'wind',
  };
  return map[condition] || condition || 'cloudy';
}

// Fetch a Home Assistant entity state via Supervisor API
async function fetchHAEntity(entityId) {
  const headers = {};
  if (SUPERVISOR_TOKEN) {
    headers['Authorization'] = `Bearer ${SUPERVISOR_TOKEN}`;
  }
  const url = `${HA_API_BASE}/states/${entityId}`;
  const res = await axios.get(url, { headers });
  return res.data;
}

// Fetch daily forecast via HA weather.get_forecasts service
async function fetchHAForecast(entityId, type = 'daily') {
  const headers = { 'Content-Type': 'application/json' };
  if (SUPERVISOR_TOKEN) {
    headers['Authorization'] = `Bearer ${SUPERVISOR_TOKEN}`;
  }
  const url = `${HA_API_BASE}/services/weather/get_forecasts?return_response`;
  const res = await axios.post(url, {
    entity_id: entityId,
    type: type,
  }, { headers });
  // HA REST API wraps service responses in "service_response"
  const data = res.data.service_response || res.data.response || res.data;
  const entityData = data[entityId] || data;
  const forecastList = Array.isArray(entityData.forecast) ? entityData.forecast : Array.isArray(entityData) ? entityData : [];
  return forecastList;
}

// Fetch weather data from Home Assistant entities
async function fetchWeatherFromHA(forecastEntity, stationEntity) {
  const forecast = await fetchHAEntity(forecastEntity);
  const fAttr = forecast.attributes;

  // Build current conditions from forecast entity as baseline
  const currently = {
    icon: mapHAConditionToIcon(forecast.state),
    temperature: fAttr.temperature,
    apparentTemperature: fAttr.apparent_temperature ?? fAttr.temperature,
    humidity: (fAttr.humidity ?? 0) / 100,
    windSpeed: fAttr.wind_speed ?? 0,
    pressure: fAttr.pressure ?? 0,
    time: Math.floor(Date.now() / 1000),
  };

  // Override icon, temperature, and humidity from station entity
  if (stationEntity) {
    try {
      const station = await fetchHAEntity(stationEntity);
      const sAttr = station.attributes;
      currently.forecastIcon = currently.icon; // preserve pirateweather icon
      currently.icon = mapHAConditionToIcon(station.state);
      // Sync night icon variants: if either entity uses a "-night" icon, apply night to both
      const isNight = currently.icon.includes('-night') || currently.forecastIcon.includes('-night');
      if (isNight) {
        currently.icon = currently.icon.replace('-day', '-night');
        currently.forecastIcon = currently.forecastIcon.replace('-day', '-night');
      }
      if (sAttr.temperature !== undefined) currently.temperature = sAttr.temperature;
      if (sAttr.humidity !== undefined) currently.humidity = sAttr.humidity / 100;
    } catch (e) {
      console.error(`Could not fetch station entity: ${e.message}`);
    }
  }

  // Fetch daily forecast via get_forecasts service (HA 2024.3+)
  const dailyData = [];
  try {
    const forecastList = await fetchHAForecast(forecastEntity, 'daily');
    for (const entry of forecastList.slice(0, 5)) {
      dailyData.push({
        time: Math.floor(new Date(entry.datetime).getTime() / 1000),
        icon: mapHAConditionToIcon(entry.condition),
        temperatureHigh: entry.temperature ?? entry.templow ?? 0,
        temperatureLow: entry.templow ?? entry.temperature ?? 0,
      });
    }
  } catch (e) {
    console.error(`Could not fetch forecast: ${e.message}`);
  }

  // Ensure we have at least a "today" entry
  if (dailyData.length === 0) {
    dailyData.push({
      time: Math.floor(Date.now() / 1000),
      icon: currently.icon,
      temperatureHigh: currently.temperature,
      temperatureLow: currently.temperature,
    });
  }

  return {
    currently,
    daily: { data: dailyData },
  };
}

// Character glyph cache
const glyphCache = {};

// Load glyph image for a character
async function loadGlyph(char) {
  if (glyphCache[char]) {
    return glyphCache[char];
  }
  
  // Determine if it's a number or letter
  let folder;
  let filename;
  
  if (/[0-9]/.test(char)) {
    folder = path.resolve(__dirname, 'numbers');
    filename = `${char}.png`;
  } else if (/[A-Za-z]/.test(char)) {
    folder = path.resolve(__dirname, 'letters');
    filename = `${char.toLowerCase()}.png`;
  } else if (char === ' ') {
    folder = path.resolve(__dirname, 'letters');
    filename = 'space.png';
  } else if (char === '•') {
    folder = path.resolve(__dirname, 'punctuation');
    filename = 'dash.png'; // Centered dot for date separator
  } else if (char === '.') {
    folder = path.resolve(__dirname, 'letters');
    filename = 'period.png'; // Date separator
  } else if (char === '°') {
    folder = path.resolve(__dirname, 'punctuation');
    filename = 'degrees.png'; // Top-aligned dot for temperature
  } else if (char === '/') {
    folder = path.resolve(__dirname, 'letters');
    filename = 'slash.png'; // Look for slash.png
  } else if (char === ':') {
    folder = path.resolve(__dirname, 'punctuation');
    filename = 'colon.png'; // Time separator
  } else if (char === '|') {
    folder = path.resolve(__dirname, 'punctuation');
    filename = 'pipe.png'; // Separator
  } else {
    // Skip unknown special characters
    return null;
  }
  
  const filepath = path.join(folder, filename);
  
  try {
    if (fs.existsSync(filepath)) {
      const glyph = await Jimp.read(filepath);
      glyphCache[char] = glyph;
      return glyph;
    }
  } catch (e) {
    console.error(`Failed to load glyph for '${char}':`, e.message);
  }
  
  return null;
}

// Measure text width without rendering
async function measureTextWidth(text, size = 8) {
  const glyphs = [];
  let totalWidth = 0;
  
  for (const char of text) {
    const glyph = await loadGlyph(char);
    if (glyph) {
      totalWidth += glyph.bitmap.width + 1; // 1px spacing between chars
    }
  }
  
  return totalWidth;
}

// fetchWeatherData — delegates to Home Assistant API
// (lat/lon kept for signature compatibility but not used)
async function fetchWeatherData(forecastEntity, stationEntity) {
  return fetchWeatherFromHA(forecastEntity, stationEntity);
}

// Format time short for display (HH:MM only)
function formatTimeShort(timestamp) {
  const date = new Date(timestamp * 1000);
  let hour = date.getHours();
  const isPM = hour >= 12;
  const minute = String(date.getMinutes()).padStart(2, '0');
  hour = hour % 12 || 12; // Convert to 12-hour format
  return { time: `${hour}:${minute}`, isPM };
}

// Format date for display (MM•DD format)
function formatDate(timestamp) {
  const date = new Date(timestamp * 1000);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}•${day}`;
}

// Get day of week abbreviation (MON, TUE, WED, etc.)
function getDayOfWeek(timestamp) {
  const date = new Date(timestamp * 1000);
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return days[date.getDay()];
}

// Tint glyphs to a specific color (for colored text like date)
async function pasteTextColored(image, text, x, y, size, r, g, b) {
  try {
    const glyphs = [];
    let totalWidth = 0;
    let maxHeight = 0;
    
    for (const char of text) {
      const glyph = await loadGlyph(char);
      if (glyph) {
        // Clone the glyph and tint it
        const tinted = glyph.clone();
        tinted.scan(0, 0, tinted.bitmap.width, tinted.bitmap.height, (x, y, idx) => {
          // Preserve alpha, but replace RGB with tint color
          const alpha = tinted.bitmap.data[idx + 3];
          if (alpha > 0) {
            tinted.bitmap.data[idx] = r;
            tinted.bitmap.data[idx + 1] = g;
            tinted.bitmap.data[idx + 2] = b;
            tinted.bitmap.data[idx + 3] = alpha;
          }
        });
        glyphs.push(tinted);
        totalWidth += tinted.bitmap.width + 1;
        maxHeight = Math.max(maxHeight, tinted.bitmap.height);
      }
    }
    
    if (glyphs.length === 0 || maxHeight === 0) {
      return;
    }
    
    const composite = new Jimp(totalWidth, maxHeight, 0x00000000);
    let xPos = 0;
    
    for (const glyph of glyphs) {
      composite.composite(glyph, xPos, 0);
      xPos += glyph.bitmap.width + 1;
    }
    
    image.composite(composite, Math.floor(x), Math.floor(y));
  } catch (e) {
    console.log('Colored text render error:', e.message);
  }
}

// Load weather icon from icons folder
async function loadWeatherIcon(condition, useAlt = false) {
  // Map condition to icon filename
  let filename;
  
  // Exact matches first (for day/night variants)
  if (condition === 'clear-day') {
    filename = 'clear-day.png';
  } else if (condition === 'clear-night') {
    filename = 'clear-night.png';
  } else if (condition === 'partly-cloudy-day') {
    filename = useAlt ? 'partly-cloudy-day-alt.png' : 'partly-cloudy-day.png';
  } else if (condition === 'partly-cloudy-night') {
    filename = useAlt ? 'partly-cloudy-night-alt.png' : 'partly-cloudy-night.png';
  }
  // Partial matches for other conditions
  else if (condition.includes('rain')) {
    filename = useAlt ? 'rain-alt.png' : 'rain.png';
  } else if (condition.includes('snow')) {
    filename = 'snow.png';
  } else if (condition.includes('sleet')) {
    filename = 'sleet.png';
  } else if (condition.includes('wind')) {
    filename = useAlt ? 'wind-alt.png' : 'wind.png';
  } else if (condition.includes('fog')) {
    filename = 'fog.png';
  } else if (condition.includes('cloud')) {
    filename = useAlt ? 'cloudy-alt.png' : 'cloudy.png';
  } else if (condition.includes('hail')) {
    filename = 'hail.png';
  } else if (condition.includes('thunder')) {
    filename = useAlt ? 'thunderstorm-alt.png' : 'thunderstorm.png';
  } else if (condition.includes('tornado')) {
    filename = 'tornado.png';
  } else if (condition.includes('smoke')) {
    filename = 'smoke.png';
  } else if (condition.includes('haze')) {
    filename = 'haze.png';
  } else if (condition.includes('mist')) {
    filename = 'mist.png';
  } else {
    filename = 'unknown.png'; // Default fallback
  }
  
  const filepath = path.join(__dirname, 'icons', filename);
  
  try {
    if (fs.existsSync(filepath)) {
      const icon = await Jimp.read(filepath);
      return icon;
    }
  } catch (e) {
    console.error(`Failed to load weather icon '${filename}':`, e.message);
  }
  
  return null;
}

// Draw gray FPO placeholder box
function pasteGrayBox(image, x, y, size = 16) {
  const c = FIXED_UI_COLORS.placeholder;
  image.scan(Math.floor(x), Math.floor(y), size, size, (px, py, idx) => {
    image.bitmap.data[idx] = c.r;
    image.bitmap.data[idx + 1] = c.g;
    image.bitmap.data[idx + 2] = c.b;
    image.bitmap.data[idx + 3] = 255;
  });
}

// Measure big number text width
async function measureBigNumberWidth(text) {
  let totalWidth = 0;
  
  for (const char of text) {
    const glyph = await loadBigNumber(char);
    if (glyph) {
      totalWidth += glyph.bitmap.width + 1; // 1px spacing between chars
    }
  }
  
  return totalWidth;
}

// Load big number glyph (for larger display temperatures)
async function loadBigNumber(char) {
  // For big numbers, we check for big-0.png through big-9.png, or degree symbol
  let filename;
  
  if (/[0-9]/.test(char)) {
    filename = `big-${char}.png`;
  } else if (char === '°') {
    const puncPath = path.join(__dirname, 'punctuation', 'big-degrees.png');
    try {
      if (fs.existsSync(puncPath)) {
        const glyph = await Jimp.read(puncPath);
        return glyph;
      }
    } catch (e) {
      console.error(`Failed to load big-degrees:`, e.message);
    }
    return null;
  } else {
    return null;
  }
  
  const filepath = path.join(__dirname, 'numbers', filename);
  
  try {
    if (fs.existsSync(filepath)) {
      const glyph = await Jimp.read(filepath);
      return glyph;
    }
  } catch (e) {
    console.error(`Failed to load big number for '${char}':`, e.message);
  }
  
  return null;
}

// Render temperature using big numbers
async function renderTemperatureBig(image, tempStr, x, y, r = 255, g = 255, b = 255) {
  try {
    const glyphs = [];
    let totalWidth = 0;
    let maxHeight = 0;
    
    for (const char of tempStr) {
      const glyph = await loadBigNumber(char);
      if (glyph) {
        glyphs.push(glyph);
        totalWidth += glyph.bitmap.width + 1; // 1px spacing between chars
        maxHeight = Math.max(maxHeight, glyph.bitmap.height);
      }
    }
    
    if (glyphs.length === 0 || maxHeight === 0) {
      return;
    }
    
    const composite = new Jimp(totalWidth, maxHeight, 0x00000000);
    let xPos = 0;
    
    for (const glyph of glyphs) {
      composite.composite(glyph, xPos, 0);
      xPos += glyph.bitmap.width + 1;
    }
    
    // Render in specified color by scanning and tinting
    composite.scan(0, 0, composite.bitmap.width, composite.bitmap.height, (px, py, idx) => {
      const alpha = composite.bitmap.data[idx + 3];
      if (alpha > 0) {
        composite.bitmap.data[idx] = r;
        composite.bitmap.data[idx + 1] = g;
        composite.bitmap.data[idx + 2] = b;
        composite.bitmap.data[idx + 3] = alpha;
      }
    });
    
    image.composite(composite, Math.floor(x), Math.floor(y));
  } catch (e) {
    console.log('Big temperature render error:', e.message);
  }
}

// Render the date/time/day header onto an image (rows y=0..8, with divider at y=8)
async function renderHeader(image) {
  const C = FIXED_UI_COLORS;

  // Black background behind header (y=0 to y=9 inclusive, extra row for 2px legend)
  image.scan(0, 0, 64, 10, (x, y, idx) => {
    image.bitmap.data[idx] = 0;
    image.bitmap.data[idx + 1] = 0;
    image.bitmap.data[idx + 2] = 0;
    image.bitmap.data[idx + 3] = 255;
  });

  // Radar legend bar at y=8 (2px tall, drawn from FIXED_RADAR_COLORS)
  const RC = FIXED_RADAR_COLORS;
  const legendColors = [
    RC.mistFog, RC.mistFog, RC.mistFog,
    RC.drizzle, RC.drizzle, RC.drizzle, RC.drizzle,
    RC.lightRain, RC.lightRain, RC.lightRain, RC.lightRain,
    RC.rain, RC.rain, RC.rain, RC.rain,
    RC.modRain, RC.modRain, RC.modRain, RC.modRain,
    RC.heavyRain, RC.heavyRain, RC.heavyRain, RC.heavyRain,
    RC.yellow, RC.yellow, RC.yellow,
    RC.lightOrange, RC.lightOrange, RC.lightOrange, RC.lightOrange,
    RC.orange, RC.orange, RC.orange, RC.orange,
    RC.redOrange, RC.redOrange, RC.redOrange, RC.redOrange,
    RC.red, RC.red, RC.red,
    RC.darkRed, RC.darkRed, RC.darkRed, RC.darkRed,
    RC.lightPink, RC.lightPink, RC.lightPink, RC.lightPink,
    RC.pink, RC.pink, RC.pink, RC.pink,
    RC.magenta, RC.magenta, RC.magenta,
    RC.brightMagenta, RC.brightMagenta, RC.brightMagenta, RC.brightMagenta,
    RC.darkMagenta, RC.darkMagenta, RC.darkMagenta, RC.darkMagenta,
  ];
  for (let row = 0; row < 2; row++) {
    for (let x = 0; x < 64; x++) {
      const c = legendColors[x];
      const idx = ((8 + row) * 64 + x) * 4;
      image.bitmap.data[idx] = c.r;
      image.bitmap.data[idx + 1] = c.g;
      image.bitmap.data[idx + 2] = c.b;
      image.bitmap.data[idx + 3] = 255;
    }
  }

  const now = Date.now() / 1000;
  const dateStr = formatDate(now);
  const { time: timeStr, isPM } = formatTimeShort(now);
  const dayStr = getDayOfWeek(now);

  const dateWidth = await measureTextWidth(dateStr, 7);
  const timeWidth = await measureTextWidth(timeStr, 7);
  const dayWidth = await measureTextWidth(dayStr, 7);

  const ampmFile = isPM ? 'pm.png' : 'am.png';
  const ampmPath = path.join(__dirname, 'punctuation', ampmFile);
  let ampmGlyph = null;
  let ampmWidth = 0;
  try {
    if (fs.existsSync(ampmPath)) {
      ampmGlyph = await Jimp.read(ampmPath);
      ampmWidth = ampmGlyph.bitmap.width + 1;
    }
  } catch (e) { /* skip if missing */ }

  const dateX = 1;
  const dateEndX = dateX + dateWidth + 1;
  const dayX = 64 - dayWidth;
  const totalTimeWidth = timeWidth + ampmWidth;
  const timeCenterX = (dateEndX + dayX) / 2;
  const timeX = Math.max(dateEndX + 1, timeCenterX - totalTimeWidth / 2);

  await pasteTextColored(image, dateStr, dateX, 1, 7, C.alternate.r, C.alternate.g, C.alternate.b);
  await pasteTextColored(image, timeStr, timeX, 1, 7, C.white.r, C.white.g, C.white.b);

  if (ampmGlyph) {
    const tintedAmpm = ampmGlyph.clone();
    tintedAmpm.scan(0, 0, tintedAmpm.bitmap.width, tintedAmpm.bitmap.height, (px, py, idx) => {
      const alpha = tintedAmpm.bitmap.data[idx + 3];
      if (alpha > 0) {
        tintedAmpm.bitmap.data[idx] = C.white.r;
        tintedAmpm.bitmap.data[idx + 1] = C.white.g;
        tintedAmpm.bitmap.data[idx + 2] = C.white.b;
      }
    });
    const ampmX = timeX + timeWidth;
    const ampmY = 1 + (7 - tintedAmpm.bitmap.height) - 2;
    image.composite(tintedAmpm, Math.floor(ampmX), Math.floor(ampmY));
  }

  await pasteTextColored(image, dayStr, dayX, 1, 7, C.accent.r, C.accent.g, C.accent.b);
}

// Create weather display image using Jimp at 64x64 pixel-perfect rendering
async function createWeatherImage(currentData, dailyData, isAnimationFrame2 = false) {
  const width = 64;
  const height = 64;
  const image = new Jimp(width, height, 0x000000ff); // Black background

  const C = FIXED_UI_COLORS; // shorthand for color references

  // Draw horizontal divider line at y=34 - separates weather from forecast
  const dividerY = 34;
  image.scan(1, dividerY, 62, 1, (x, y, idx) => {
    image.bitmap.data[idx] = C.divider.r;
    image.bitmap.data[idx + 1] = C.divider.g;
    image.bitmap.data[idx + 2] = C.divider.b;
    image.bitmap.data[idx + 3] = 255;
  });

  // Draw horizontal line at y=8 - separates header from main section
  const headerDividerY = 8;
  image.scan(1, headerDividerY, 62, 1, (x, y, idx) => {
    image.bitmap.data[idx] = C.divider.r;
    image.bitmap.data[idx + 1] = C.divider.g;
    image.bitmap.data[idx + 2] = C.divider.b;
    image.bitmap.data[idx + 3] = 255;
  });

  const dateStr = formatDate(currentData.time);
  const { time: timeStr, isPM } = formatTimeShort(Date.now() / 1000); // Use current system time
  const dayStr = getDayOfWeek(currentData.time);
  
  const tempStr = Math.round(currentData.temperature) + '°';

  // Top section header with measured positioning
  const dateWidth = await measureTextWidth(dateStr, 7);
  const timeWidth = await measureTextWidth(timeStr, 7);
  const dayWidth = await measureTextWidth(dayStr, 7);
  
  // Load AM/PM glyph
  const ampmFile = isPM ? 'pm.png' : 'am.png';
  const ampmPath = path.join(__dirname, 'punctuation', ampmFile);
  let ampmGlyph = null;
  let ampmWidth = 0;
  try {
    if (fs.existsSync(ampmPath)) {
      ampmGlyph = await Jimp.read(ampmPath);
      ampmWidth = ampmGlyph.bitmap.width + 1; // 1px gap before glyph
    }
  } catch (e) { /* skip if missing */ }
  
  const dateX = 1;
  const dateEndX = dateX + dateWidth + 1; // 1px spacing after date
  const dayX = 64 - dayWidth; // right-aligned with 1px margin, moved 1px left
  const totalTimeWidth = timeWidth + ampmWidth;
  const timeCenterX = (dateEndX + dayX) / 2; // center between date and day
  const timeX = Math.max(dateEndX + 1, timeCenterX - totalTimeWidth / 2); // don't overlap with date
  
  await pasteTextColored(image, dateStr, dateX, 1, 7, C.alternate.r, C.alternate.g, C.alternate.b);
  await pasteTextColored(image, timeStr, timeX, 1, 7, C.white.r, C.white.g, C.white.b);
  
  // Append AM/PM glyph after time text
  if (ampmGlyph) {
    const tintedAmpm = ampmGlyph.clone();
    tintedAmpm.scan(0, 0, tintedAmpm.bitmap.width, tintedAmpm.bitmap.height, (px, py, idx) => {
      const alpha = tintedAmpm.bitmap.data[idx + 3];
      if (alpha > 0) {
        tintedAmpm.bitmap.data[idx] = C.white.r;
        tintedAmpm.bitmap.data[idx + 1] = C.white.g;
        tintedAmpm.bitmap.data[idx + 2] = C.white.b;
      }
    });
    const ampmX = timeX + timeWidth;
    const ampmY = 1 + (7 - tintedAmpm.bitmap.height) - 2; // bottom-align with time text, shifted up 2px
    image.composite(tintedAmpm, Math.floor(ampmX), Math.floor(ampmY));
  }
  
  await pasteTextColored(image, dayStr, dayX, 1, 7, C.accent.r, C.accent.g, C.accent.b);
  
  // Main section: Animated weather icon and temperature
  // Icon on left, temp on right
  // Frame 1: station icon, Frame 2: pirateweather forecast icon (no alt)
  const currentIconName = isAnimationFrame2 && currentData.forecastIcon
    ? currentData.forecastIcon
    : currentData.icon;
  const weatherIcon = await loadWeatherIcon(currentIconName, false);
  if (weatherIcon) {
    image.composite(weatherIcon, Math.floor(2), Math.floor(11));
  } else {
    pasteGrayBox(image, 2, 11, 21);
  }
  const tempBigWidth = await measureBigNumberWidth(tempStr);
  const tempBigX = 64 - tempBigWidth; // right-aligned flush
  // Render shadow behind
  await renderTemperatureBig(image, tempStr, tempBigX + 1, 12, C.divider.r, C.divider.g, C.divider.b);
  // Render white on top
  await renderTemperatureBig(image, tempStr, tempBigX, 11, C.white.r, C.white.g, C.white.b);

  // Humidity column between weather icon and big temp
  const humidityIconPath = path.join(__dirname, 'icons', 'humidity.png');
  const humidityColX = 26; // right of weather icon (ends ~x=23)
  let humidityY = 11;
  try {
    if (fs.existsSync(humidityIconPath)) {
      const humidityIcon = await Jimp.read(humidityIconPath);
      const scaledHumIcon = humidityIcon.clone().resize(9, 9);
      image.composite(scaledHumIcon, humidityColX, humidityY);
      humidityY += 10; // 9px icon + 1px gap
    }
  } catch (e) { /* skip icon if missing */ }
  const humidityStr = Math.round(currentData.humidity * 100).toString();
  await pasteTextColored(image, humidityStr, humidityColX, humidityY, 6, C.forecastHigh.r, C.forecastHigh.g, C.forecastHigh.b);
  const humidityNumWidth = await measureTextWidth(humidityStr, 6);
  const percentPath = path.join(__dirname, 'punctuation', 'percent.png');
  try {
    if (fs.existsSync(percentPath)) {
      const percentGlyph = await Jimp.read(percentPath);
      const tintedPercent = percentGlyph.clone();
      tintedPercent.scan(0, 0, tintedPercent.bitmap.width, tintedPercent.bitmap.height, (px, py, idx) => {
        const alpha = tintedPercent.bitmap.data[idx + 3];
        if (alpha > 0) {
          tintedPercent.bitmap.data[idx] = C.forecastHigh.r;
          tintedPercent.bitmap.data[idx + 1] = C.forecastHigh.g;
          tintedPercent.bitmap.data[idx + 2] = C.forecastHigh.b;
        }
      });
      image.composite(tintedPercent, humidityColX + humidityNumWidth, humidityY);
    }
  } catch (e) { /* skip percent if missing */ }
  // "RH" label centered below humidity number
  const humidityTotalWidth = humidityNumWidth + (fs.existsSync(percentPath) ? 4 : 0); // approx percent glyph width
  const rhWidth = await measureTextWidth('RH', 6);
  const rhX = humidityColX + Math.floor((humidityTotalWidth - rhWidth) / 2) - 1;
  await pasteTextColored(image, 'RH', rhX, humidityY + 6, 6, C.forecastLow.r, C.forecastLow.g, C.forecastLow.b);
  
  // Today's high and low temperatures
  const todayHighStr = Math.round(dailyData[0].temperatureHigh) + '°';
  const todayLowStr = Math.round(dailyData[0].temperatureLow) + '°';
  const todayHighWidth = await measureTextWidth(todayHighStr, 6);
  const todayLowWidth = await measureTextWidth(todayLowStr, 6);
  
  // Load pipe image
  const pipeGlyph = await loadGlyph('|');
  let pipeWidth = 0;
  if (pipeGlyph) {
    pipeWidth = pipeGlyph.bitmap.width;
  }
  
  const totalTodayWidth = todayHighWidth + 1 + pipeWidth + 1 + todayLowWidth; // 1px spacing around pipe
  const todayStartX = 63 - totalTodayWidth; // right-aligned with 1px margin
  
  let todayX = todayStartX;
  await pasteTextColored(image, todayHighStr, todayX + 2, 27, 6, C.todayHigh.r, C.todayHigh.g, C.todayHigh.b);
  todayX += todayHighWidth + 1;
  
  // Paste pipe glyph tinted to divider color
  if (pipeGlyph) {
    const tintedPipe = pipeGlyph.clone();
    tintedPipe.scan(0, 0, tintedPipe.bitmap.width, tintedPipe.bitmap.height, (x, y, idx) => {
      const alpha = tintedPipe.bitmap.data[idx + 3];
      if (alpha > 0) {
        tintedPipe.bitmap.data[idx] = C.divider.r;
        tintedPipe.bitmap.data[idx + 1] = C.divider.g;
        tintedPipe.bitmap.data[idx + 2] = C.divider.b;
        tintedPipe.bitmap.data[idx + 3] = alpha;
      }
    });
    image.composite(tintedPipe, Math.floor(todayX), Math.floor(27));
  }
  
  todayX += pipeWidth + 1;
  await pasteTextColored(image, todayLowStr, todayX, 27, 6, C.todayLow.r, C.todayLow.g, C.todayLow.b);

  // Lower section (y=31-64): 4-column forecast layout (days 1-4)
  const columnCenters = [9, 25, 41, 57]; // x centers for each column
  
  for (let i = 1; i < 5 && i < dailyData.length; i++) {
    const day = dailyData[i];
    const colX = columnCenters[i - 1];
    
    // Day abbreviation (first 2 letters)
    const dayLabel = getDayOfWeek(day.time).substring(0, 2);
    const dayLabelWidth = await measureTextWidth(dayLabel, 6);
    await pasteTextColored(image, dayLabel, colX - dayLabelWidth / 2, 36, 6, C.white.r, C.white.g, C.white.b);
    
    // Weather icon (centered in column, scaled to 9x9)
    const forecastIcon = await loadWeatherIcon(day.icon, isAnimationFrame2);
    if (forecastIcon) {
      const scaledIcon = forecastIcon.clone().resize(9, 9);
      image.composite(scaledIcon, Math.floor(colX - 4.5), Math.floor(42));
    } else {
      pasteGrayBox(image, colX - 4.5, 42, 9);
    }
    
    // High temperature with degree dot (same gray as date header)
    const highStr = Math.round(day.temperatureHigh) + '°';
    const highWidth = await measureTextWidth(highStr, 5);
    await pasteTextColored(image, highStr, colX - highWidth / 2, 52, 5, C.forecastHigh.r, C.forecastHigh.g, C.forecastHigh.b);
    
    // Low temperature
    const lowStr = Math.round(day.temperatureLow) + '°';
    const lowWidth = await measureTextWidth(lowStr, 5);
    await pasteTextColored(image, lowStr, colX - lowWidth / 2, 58, 5, C.forecastLow.r, C.forecastLow.g, C.forecastLow.b);
  }
  
  return Buffer.from(image.bitmap.data);
}

// Known UI colors that must remain stable across animation frames
// Change colors here to tweak the entire layout in one place
const FIXED_UI_COLORS = {
  background:    { r: 0, g: 0, b: 0 },       // black background
  divider:       { r: 50, g: 50, b: 50 },     // divider lines, shadow
  placeholder:   { r: 100, g: 100, b: 100 },  // placeholder gray
  forecastLow:   { r: 125, g: 125, b: 125 },  // forecast low temp gray
  forecastHigh:  { r: 175, g: 175, b: 175 },  // date/forecast high temp gray
  white:         { r: 255, g: 255, b: 255 },  // white text
  accent:        { r: 158, g: 110, b: 172 },   // purple day of week
  alternate:     { r: 172, g: 110, b: 142 },   // pink alternate accent
  todayHigh:     { r: 254, g: 212, b: 134 },   // yellow today high temp
  todayLow:      { r: 100, g: 158, b: 238 },   // blue today low temp
};

const FIXED_RADAR_COLORS = {
  mistFog:       { r: 146, g: 136, b: 113 },  // mist/fog
  drizzle:       { r: 206, g: 192, b: 135 },  // drizzle
  lightRain:     { r: 136, g: 221, b: 238 },  // light rain
  rain:          { r: 0, g: 153, b: 204 },    // rain
  modRain:       { r: 0, g: 119, b: 170 },    // moderate rain
  heavyRain:     { r: 0, g: 85, b: 136 },     // heavy rain
  yellow:        { r: 255, g: 238, b: 0 },    // intense
  lightOrange:   { r: 255, g: 170, b: 0 },    // light orange
  orange:        { r: 255, g: 119, b: 0 },    // orange
  redOrange:     { r: 255, g: 68, b: 0 },     // red-orange
  red:           { r: 238, g: 0, b: 0 },      // red
  darkRed:       { r: 153, g: 0, b: 0 },      // dark red
  lightPink:     { r: 255, g: 170, b: 255 },  // light pink
  pink:          { r: 255, g: 119, b: 255 },  // pink
  magenta:       { r: 255, g: 68, b: 255 },   // magenta
  brightMagenta: { r: 255, g: 0, b: 255 },    // bright magenta
  darkMagenta:   { r: 170, g: 0, b: 170 },    // dark magenta
};

// Build a unified palette from both animation frames
function buildUnifiedPalette(frame1, frame2) {
  const colorCounts = new Map();

  // Count all unique colors across both frames
  for (const frame of [frame1, frame2]) {
    for (let i = 0; i < frame.length; i += 4) {
      const a = frame[i + 3];
      if (a < 128) continue;
      const key = (frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2];
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    }
  }

  // Start with fixed UI colors
  const palette = [];
  const usedKeys = new Set();

  for (const c of Object.values(FIXED_UI_COLORS)) {
    const key = (c.r << 16) | (c.g << 8) | c.b;
    if (!usedKeys.has(key)) {
      palette.push(c);
      usedKeys.add(key);
    }
  }

  // Add remaining colors sorted by frequency
  const remaining = [...colorCounts.entries()]
    .filter(([key]) => !usedKeys.has(key))
    .sort((a, b) => b[1] - a[1]);

  for (const [key] of remaining) {
    if (palette.length >= 256) break;
    palette.push({
      r: (key >> 16) & 0xFF,
      g: (key >> 8) & 0xFF,
      b: key & 0xFF
    });
  }

  return palette;
}

// Build a unified palette for radar frames, reserving UI + radar legend colors
function buildRadarPalette(frames) {
  const colorCounts = new Map();

  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 4) {
      const a = frame[i + 3];
      if (a < 128) continue;
      const key = (frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2];
      colorCounts.set(key, (colorCounts.get(key) || 0) + 1);
    }
  }

  const palette = [];
  const usedKeys = new Set();

  // Reserve UI colors (used in header, progress bar, timestamps)
  for (const c of Object.values(FIXED_UI_COLORS)) {
    const key = (c.r << 16) | (c.g << 8) | c.b;
    if (!usedKeys.has(key)) {
      palette.push(c);
      usedKeys.add(key);
    }
  }

  // Reserve radar legend colors
  for (const c of Object.values(FIXED_RADAR_COLORS)) {
    const key = (c.r << 16) | (c.g << 8) | c.b;
    if (!usedKeys.has(key)) {
      palette.push(c);
      usedKeys.add(key);
    }
  }

  // Add remaining colors sorted by frequency
  const remaining = [...colorCounts.entries()]
    .filter(([key]) => !usedKeys.has(key))
    .sort((a, b) => b[1] - a[1]);

  for (const [key] of remaining) {
    if (palette.length >= 256) break;
    palette.push({
      r: (key >> 16) & 0xFF,
      g: (key >> 8) & 0xFF,
      b: key & 0xFF
    });
  }

  return palette;
}

// Remap frame pixels to unified palette for consistent colors
function remapFrameToPalette(frame, palette) {
  const result = Buffer.from(frame);

  // Build lookup for exact matches
  const exactMap = new Map();
  for (let i = 0; i < palette.length; i++) {
    const key = (palette[i].r << 16) | (palette[i].g << 8) | palette[i].b;
    exactMap.set(key, i);
  }

  for (let i = 0; i < result.length; i += 4) {
    const r = result[i];
    const g = result[i + 1];
    const b = result[i + 2];
    const key = (r << 16) | (g << 8) | b;

    // Skip if already an exact palette color
    if (exactMap.has(key)) continue;

    // Find nearest palette color
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let j = 0; j < palette.length; j++) {
      const c = palette[j];
      const dist = (r - c.r) ** 2 + (g - c.g) ** 2 + (b - c.b) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = j;
      }
    }

    result[i] = palette[bestIdx].r;
    result[i + 1] = palette[bestIdx].g;
    result[i + 2] = palette[bestIdx].b;
  }

  return result;
}

// Generate the animated GIF
async function generateGIF(weatherData, outputFile = './weather-forecast.gif') {
  const currentData = weatherData.currently;
  const dailyData = weatherData.daily.data;

  const width = 64;
  const height = 64;

  console.log('  Creating animation frames...');

  // Create both animation frames (raw RGBA buffers)
  const rawFrame1 = await createWeatherImage(currentData, dailyData, false);
  const rawFrame2 = await createWeatherImage(currentData, dailyData, true);

  // Pre-quantize both frames to a unified palette so colors don't shift
  const unifiedPalette = buildUnifiedPalette(rawFrame1, rawFrame2);
  const frame1 = remapFrameToPalette(rawFrame1, unifiedPalette);
  const frame2 = remapFrameToPalette(rawFrame2, unifiedPalette);

  // Build palette as array of 0xRRGGBB ints for omggif (must be 256 entries)
  const gifPalette = new Array(256).fill(0);
  for (let i = 0; i < unifiedPalette.length; i++) {
    gifPalette[i] = (unifiedPalette[i].r << 16) | (unifiedPalette[i].g << 8) | unifiedPalette[i].b;
  }

  // Build RGB-key to palette-index lookup
  const paletteIndexMap = new Map();
  for (let i = 0; i < unifiedPalette.length; i++) {
    const key = (unifiedPalette[i].r << 16) | (unifiedPalette[i].g << 8) | unifiedPalette[i].b;
    if (!paletteIndexMap.has(key)) paletteIndexMap.set(key, i);
  }

  // Convert each RGBA frame to palette-indexed pixels
  const nPix = 64 * 64;
  const frames = [frame1, frame2];
  const indexedFrames = frames.map(frame => {
    const indexed = new Uint8Array(nPix);
    for (let i = 0; i < nPix; i++) {
      const off = i * 4;
      const key = (frame[off] << 16) | (frame[off + 1] << 8) | frame[off + 2];
      indexed[i] = paletteIndexMap.get(key) || 0;
    }
    return indexed;
  });

  // Encode GIF with omggif using a single global color table
  const omggif = require('omggif');
  const bufSize = nPix * indexedFrames.length * 2 + 1024;
  const buf = Buffer.alloc(bufSize);
  const gif = new omggif.GifWriter(buf, width, height, { palette: gifPalette, loop: 0 });

  for (const indexed of indexedFrames) {
    gif.addFrame(0, 0, width, height, indexed, { delay: 94 }); // 940ms in centiseconds
  }

  fs.writeFileSync(outputFile, buf.slice(0, gif.end()));
  console.log(`✓ Weather GIF generated: ${outputFile}`);
}

// --- Radar Map GIF Generation ---

// Fetch lat/lon from Home Assistant zone.home entity
async function fetchHomeLocation() {
  const entity = await fetchHAEntity('zone.home');
  return {
    latitude: entity.attributes.latitude,
    longitude: entity.attributes.longitude,
  };
}

// Fetch RainViewer weather maps API to get available radar timestamps
async function fetchRainViewerMaps() {
  const res = await axios.get('https://api.rainviewer.com/public/weather-maps.json');
  return res.data;
}

// Convert lat/lon to slippy map tile coordinates and fractional pixel offset
function latLonToTile(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const latRad = lat * Math.PI / 180;
  const xTile = Math.floor((lon + 180) / 360 * n);
  const yTile = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  // Fractional pixel position within the tile (0–255 for 256px tiles)
  const xFrac = ((lon + 180) / 360 * n - xTile) * 256;
  const yFrac = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n - yTile) * 256;
  return { xTile, yTile, xFrac, yFrac };
}

// Download a map tile from CartoDB dark basemap (label-free for 64px clarity)
async function downloadMapTile(z, x, y) {
  const url = `https://basemaps.cartocdn.com/dark_nolabels/${z}/${x}/${y}.png`;
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'WeatherForecastGIF-HomeAssistant/1.0' },
  });
  return Jimp.read(Buffer.from(res.data));
}

// Download a radar tile from RainViewer using standard x/y/z tile coordinates
async function downloadRadarTileXYZ(host, framePath, z, x, y, size, colorScheme, smooth, snow) {
  const smoothVal = smooth ? 1 : 0;
  const snowVal = snow ? 1 : 0;
  const url = `${host}${framePath}/${size}/${z}/${x}/${y}/${colorScheme}/${smoothVal}_${snowVal}.png`;
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  return Jimp.read(Buffer.from(res.data));
}

// Fetch a 2x2 grid of tiles, stitch, and crop 256x256 centered on lat/lon
async function fetchCenteredTiles(lat, lon, zoom, tileFetcher) {
  const { xTile, yTile, xFrac, yFrac } = latLonToTile(lat, lon, zoom);

  // Pick the 2x2 grid that surrounds the center point
  const xBase = xFrac >= 128 ? xTile : xTile - 1;
  const yBase = yFrac >= 128 ? yTile : yTile - 1;

  const tiles = await Promise.all([
    tileFetcher(zoom, xBase, yBase),
    tileFetcher(zoom, xBase + 1, yBase),
    tileFetcher(zoom, xBase, yBase + 1),
    tileFetcher(zoom, xBase + 1, yBase + 1),
  ]);

  // Stitch into 512x512
  const stitched = new Jimp(512, 512, 0x00000000);
  stitched.composite(tiles[0], 0, 0);
  stitched.composite(tiles[1], 256, 0);
  stitched.composite(tiles[2], 0, 256);
  stitched.composite(tiles[3], 256, 256);

  // Crop 256x256 centered on the exact lat/lon
  const centerX = xFrac >= 128 ? xFrac : xFrac + 256;
  const centerY = yFrac >= 128 ? yFrac : yFrac + 256;
  stitched.crop(Math.round(centerX - 128), Math.round(centerY - 128), 256, 256);

  return stitched;
}

// Cache for the map background (it rarely changes)
let mapTileCache = null;
let mapTileCacheKey = '';

// Cache for radar base frames (map + radar + home icon, before header/overlays)
let radarBaseFramesCache = null;
let radarFrameTimestamps = null;

// Check if we should refresh radar data (1 minute after every 10-minute mark)
function shouldRefreshRadar() {
  const minute = new Date().getMinutes();
  return minute % 10 === 1;
}

// Generate animated radar map GIF from RainViewer data
async function generateRadarGIF(outputFile, opts, overrideLocation) {
  const { radar_zoom: zoom, radar_color_scheme: colorScheme, radar_smooth: smooth, radar_snow: snow } = opts;
  const size = 256;

  let latitude, longitude;
  if (overrideLocation) {
    latitude = overrideLocation.latitude;
    longitude = overrideLocation.longitude;
  } else {
    console.log('  Fetching home location from Home Assistant...');
    ({ latitude, longitude } = await fetchHomeLocation());
  }
  console.log(`  Home location: ${latitude}, ${longitude}`);

  // Fetch or reuse cached map background
  const cacheKey = `${latitude},${longitude},${zoom}`;
  let mapBackground;
  if (mapTileCache && mapTileCacheKey === cacheKey) {
    mapBackground = mapTileCache;
    console.log('  Using cached map background');
  } else {
    console.log('  Downloading map background tiles...');
    mapBackground = await fetchCenteredTiles(latitude, longitude, zoom, downloadMapTile);
    mapTileCache = mapBackground;
    mapTileCacheKey = cacheKey;
  }

  // Only re-fetch radar data on the 10s+1 schedule, or if no cache exists
  const needsRadarRefresh = !radarBaseFramesCache || shouldRefreshRadar();

  if (needsRadarRefresh) {
    console.log('  Fetching RainViewer radar data...');
    const mapsData = await fetchRainViewerMaps();
    const host = mapsData.host;
    const pastFrames = mapsData.radar.past || [];

    // Take the last 5 frames (most recent ~50 minutes of radar data)
    const frames = pastFrames.slice(-5);
    if (frames.length === 0) {
      throw new Error('No radar frames available from RainViewer');
    }

    console.log(`  Downloading ${frames.length} radar frames...`);
    radarBaseFramesCache = [];
    radarFrameTimestamps = [];
    for (const frame of frames) {
      const radarTile = await fetchCenteredTiles(latitude, longitude, zoom,
        (z, x, y) => downloadRadarTileXYZ(host, frame.path, z, x, y, size, colorScheme, smooth, snow));

      // Composite radar over map background clone
      const composited = mapBackground.clone();
      composited.composite(radarTile, 0, 0);

      // Resize to 64x64
      composited.resize(64, 64);

      // Add home icon at the center
      const homeIcon = await Jimp.read(path.resolve(__dirname, 'icons', 'home.png'));
      const hx = Math.floor((64 - homeIcon.bitmap.width) / 2);
      const hy = Math.floor((64 - homeIcon.bitmap.height) / 2);
      composited.composite(homeIcon, hx, hy);

      // Shift radar + home icon down 4px to clear header area
      const shifted = new Jimp(64, 64, 0x000000FF);
      shifted.composite(composited, 0, 4);

      radarBaseFramesCache.push(shifted);
      radarFrameTimestamps.push(frame.time);
    }
  } else {
    console.log('  Using cached radar frames (next refresh at xx:x1)');
  }

  // Apply overlays (header, progress bar, timestamp) on top of cached base frames
  const radarImages = [];
  const frameCount = radarBaseFramesCache.length;
  for (let fi = 0; fi < frameCount; fi++) {
    const composited = radarBaseFramesCache[fi].clone();

    // Render date/time header with black background at top
    await renderHeader(composited);

    // Draw progress bar at bottom (2px tall, progressively wider)
    const C = FIXED_UI_COLORS;
    const barWidth = Math.round(64 * (fi + 1) / frameCount);
    composited.scan(0, 62, barWidth, 2, (x, y, idx) => {
      composited.bitmap.data[idx] = C.todayLow.r;
      composited.bitmap.data[idx + 1] = C.todayLow.g;
      composited.bitmap.data[idx + 2] = C.todayLow.b;
      composited.bitmap.data[idx + 3] = 255;
    });

    // Render radar frame timestamp in lower-left (24hr format)
    const frameDate = new Date(radarFrameTimestamps[fi] * 1000);
    const frameHH = String(frameDate.getHours()).padStart(2, '0');
    const frameMM = String(frameDate.getMinutes()).padStart(2, '0');
    const frameTimeStr = `${frameHH}:${frameMM}`;
    await pasteTextColored(composited, frameTimeStr, 1, 55, 6, C.forecastLow.r, C.forecastLow.g, C.forecastLow.b);

    radarImages.push(composited);
  }

  // Extract RGBA pixel data from each frame
  const allRawPixelData = radarImages.map(img => {
    const buf = Buffer.alloc(64 * 64 * 4);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const rgba = Jimp.intToRGBA(img.getPixelColor(x, y));
        const idx = (y * 64 + x) * 4;
        buf[idx] = rgba.r;
        buf[idx + 1] = rgba.g;
        buf[idx + 2] = rgba.b;
        buf[idx + 3] = rgba.a;
      }
    }
    return buf;
  });

  // Build unified radar palette reserving UI + radar legend colors
  const radarPalette = buildRadarPalette(allRawPixelData);
  const allPixelData = allRawPixelData.map(frame => remapFrameToPalette(frame, radarPalette));

  // Build palette as array of 0xRRGGBB ints for omggif (must be 256 entries)
  const gifPalette = new Array(256).fill(0);
  for (let i = 0; i < radarPalette.length; i++) {
    gifPalette[i] = (radarPalette[i].r << 16) | (radarPalette[i].g << 8) | radarPalette[i].b;
  }

  // Build RGB-key to palette-index lookup
  const paletteIndexMap = new Map();
  for (let i = 0; i < radarPalette.length; i++) {
    const key = (radarPalette[i].r << 16) | (radarPalette[i].g << 8) | radarPalette[i].b;
    if (!paletteIndexMap.has(key)) paletteIndexMap.set(key, i);
  }

  // Convert each RGBA frame to palette-indexed pixels
  const nPix = 64 * 64;
  const allIndexedFrames = allPixelData.map(frame => {
    const indexed = new Uint8Array(nPix);
    for (let i = 0; i < nPix; i++) {
      const off = i * 4;
      const key = (frame[off] << 16) | (frame[off + 1] << 8) | frame[off + 2];
      indexed[i] = paletteIndexMap.get(key) || 0;
    }
    return indexed;
  });

  // Encode GIF with omggif using a single global color table
  const omggif = require('omggif');
  const bufSize = nPix * allIndexedFrames.length * 2 + 1024;
  const buf = Buffer.alloc(bufSize);
  const gif = new omggif.GifWriter(buf, 64, 64, { palette: gifPalette, loop: 0 });

  for (let i = 0; i < allIndexedFrames.length; i++) {
    gif.addFrame(0, 0, 64, 64, allIndexedFrames[i], {
      delay: i === allIndexedFrames.length - 1 ? 150 : 50, // omggif delay is in centiseconds
    });
  }

  fs.writeFileSync(outputFile, buf.slice(0, gif.end()));
  console.log(`✓ Radar GIF generated: ${outputFile}`);
}

// Main execution
async function main() {
  const opts = loadOptions();
  const forecastEntity = opts.forecast_entity;
  const stationEntity = opts.station_entity;
  const outputFile = '/data/weather-forecast.gif';
  const radarOutputFile = '/data/radar-map.gif';
  const PORT = opts.port;

  let generationCount = 0;

  async function updateLoop() {
    generationCount++;

    try {
      console.log(`\nFetching weather from Home Assistant... [${new Date().toLocaleTimeString()}]`);
      const weatherData = await fetchWeatherData(forecastEntity, stationEntity);

      // Print weather data to console
      const current = weatherData.currently;
      console.log(`Current: ${current.icon} | ${Math.round(current.temperature)}°F | ${Math.round(current.humidity * 100)}% humidity | ${Math.round(current.windSpeed)}mph wind`);

      const daily = weatherData.daily.data;
      if (daily.length > 1) {
        console.log('Forecast:');
        for (let i = 1; i < daily.length; i++) {
          const day = daily[i];
          console.log(`  ${getDayOfWeek(day.time)}: ${day.icon} | High: ${Math.round(day.temperatureHigh)}°F | Low: ${Math.round(day.temperatureLow)}°F`);
        }
      }

      console.log(`Generating weather GIF #${generationCount}...`);
      await generateGIF(weatherData, outputFile);
      console.log(`✓ Weather done!`);
    } catch (error) {
      console.error('❌ Weather error:', error.message);
    }

    // Generate radar GIF if enabled
    if (opts.radar_enabled) {
      try {
        console.log(`Generating radar GIF #${generationCount}...`);
        await generateRadarGIF(radarOutputFile, opts);
        console.log(`✓ Radar done!`);
      } catch (error) {
        console.error('❌ Radar error:', error.message);
      }
    }
  }

  try {
    console.log(`Home Assistant Weather Forecast GIF`);
    console.log(`   Forecast entity: ${forecastEntity}`);
    console.log(`   Station entity:  ${stationEntity || '(none)'}`);
    console.log(`   Radar enabled:   ${opts.radar_enabled}`);
    console.log(`   Output: ${outputFile}`);
    if (opts.radar_enabled) console.log(`   Radar output: ${radarOutputFile}`);
    console.log(`   Port: ${PORT}`);
    console.log(`Starting continuous GIF generation (every 1 min on the minute)\n`);
    
    // Set up Express web server
    const app = express();
    
    // Serve the weather GIF file
    app.get('/', (req, res) => {
      const gifPath = path.resolve(outputFile);
      if (!fs.existsSync(gifPath)) {
        return res.status(503).send('GIF not generated yet');
      }
      res.type('image/gif');
      res.sendFile(gifPath);
    });
    
    app.get('/weather.gif', (req, res) => {
      const gifPath = path.resolve(outputFile);
      if (!fs.existsSync(gifPath)) {
        return res.status(503).send('GIF not generated yet');
      }
      res.type('image/gif');
      res.sendFile(gifPath);
    });

    // Serve the radar GIF file
    app.get('/radar.gif', (req, res) => {
      const gifPath = path.resolve(radarOutputFile);
      if (!fs.existsSync(gifPath)) {
        return res.status(503).send('Radar GIF not generated yet');
      }
      res.type('image/gif');
      res.sendFile(gifPath);
    });
    
    // Start web server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Web server running on port ${PORT}`);
      console.log(`Access the weather GIF at http://<your-ha-ip>:${PORT}/`);
      if (opts.radar_enabled) console.log(`Access the radar GIF at http://<your-ha-ip>:${PORT}/radar.gif`);
    });
    
    // Run once on startup
    await updateLoop();
    
    // Schedule cron job to run at the start of every minute
    cron.schedule('0 * * * * *', updateLoop);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Allow requiring as a module for testing, or run directly
if (require.main === module) {
  main();
} else {
  module.exports = { generateGIF, generateRadarGIF };
}

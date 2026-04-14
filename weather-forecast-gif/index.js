#!/usr/bin/env node

const axios = require('axios');
const GIFEncoder = require('gif-encoder');
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
  console.log(`  [HA API] GET ${url}`);
  const res = await axios.get(url, { headers });
  console.log(`  [HA API] Response status: ${res.status}`);
  console.log(`  [HA API] Entity: ${entityId}`);
  console.log(`  [HA API]   state: ${JSON.stringify(res.data.state)}`);
  console.log(`  [HA API]   attributes keys: ${Object.keys(res.data.attributes || {}).join(', ')}`);
  console.log(`  [HA API]   attributes: ${JSON.stringify(res.data.attributes, null, 2)}`);
  return res.data;
}

// Fetch weather data from Home Assistant entities
async function fetchWeatherFromHA(forecastEntity, stationEntity) {
  // Get forecast entity (Pirate Weather) for forecast + fallback current conditions
  console.log(`  Fetching forecast entity: ${forecastEntity}`);
  const forecast = await fetchHAEntity(forecastEntity);
  const fAttr = forecast.attributes;

  console.log(`  Forecast state: ${forecast.state}`);
  console.log(`  Forecast attributes:`);
  console.log(`    temperature: ${fAttr.temperature}`);
  console.log(`    apparent_temperature: ${fAttr.apparent_temperature}`);
  console.log(`    humidity: ${fAttr.humidity}`);
  console.log(`    wind_speed: ${fAttr.wind_speed}`);
  console.log(`    pressure: ${fAttr.pressure}`);
  console.log(`    forecast entries: ${(fAttr.forecast || []).length}`);
  if (fAttr.forecast && fAttr.forecast.length > 0) {
    console.log(`    first forecast entry: ${JSON.stringify(fAttr.forecast[0])}`);
    if (fAttr.forecast.length > 1) {
      console.log(`    second forecast entry: ${JSON.stringify(fAttr.forecast[1])}`);
    }
  }

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

  // Override current conditions with station entity if configured
  if (stationEntity) {
    try {
      const station = await fetchHAEntity(stationEntity);
      const sAttr = station.attributes;
      currently.icon = mapHAConditionToIcon(station.state);
      if (sAttr.temperature !== undefined) currently.temperature = sAttr.temperature;
      if (sAttr.apparent_temperature !== undefined) currently.apparentTemperature = sAttr.apparent_temperature;
      if (sAttr.humidity !== undefined) currently.humidity = sAttr.humidity / 100;
      if (sAttr.wind_speed !== undefined) currently.windSpeed = sAttr.wind_speed;
      if (sAttr.pressure !== undefined) currently.pressure = sAttr.pressure;
      console.log(`Station data: ${currently.temperature}°F, ${Math.round(currently.humidity * 100)}% humidity`);
    } catch (e) {
      console.error(`  Could not fetch station entity: ${e.message}`);
    }
  }

  // Build daily forecast from the forecast attribute
  const dailyData = [];
  const forecastList = fAttr.forecast || [];

  // Group hourly forecasts into daily if needed, or use daily directly
  if (forecastList.length > 0) {
    // Check if this looks like daily data (entries ~24h apart)
    const isDailyForecast = forecastList.length <= 10 ||
      (forecastList.length >= 2 &&
        new Date(forecastList[1].datetime) - new Date(forecastList[0].datetime) >= 12 * 3600 * 1000);

    if (isDailyForecast) {
      for (const entry of forecastList.slice(0, 5)) {
        dailyData.push({
          time: Math.floor(new Date(entry.datetime).getTime() / 1000),
          icon: mapHAConditionToIcon(entry.condition),
          temperatureHigh: entry.temperature ?? entry.templow ?? 0,
          temperatureLow: entry.templow ?? entry.temperature ?? 0,
        });
      }
    } else {
      // Hourly data — group by day
      const dayMap = new Map();
      for (const entry of forecastList) {
        const d = new Date(entry.datetime);
        const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!dayMap.has(dayKey)) {
          dayMap.set(dayKey, { temps: [], conditions: [], time: d });
        }
        const day = dayMap.get(dayKey);
        day.temps.push(entry.temperature);
        day.conditions.push(entry.condition);
      }
      for (const [, day] of [...dayMap.entries()].slice(0, 5)) {
        dailyData.push({
          time: Math.floor(day.time.getTime() / 1000),
          icon: mapHAConditionToIcon(day.conditions[Math.floor(day.conditions.length / 2)]),
          temperatureHigh: Math.max(...day.temps),
          temperatureLow: Math.min(...day.temps),
        });
      }
    }
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

  console.log(`  Parsed currently: ${JSON.stringify(currently)}`);
  console.log(`  Parsed dailyData (${dailyData.length} days):`);
  for (const d of dailyData) {
    console.log(`    ${JSON.stringify(d)}`);
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
  let hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  hour = hour % 12 || 12; // Convert to 12-hour format
  return `${hour}:${minute}`;
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
  const timeStr = formatTimeShort(Date.now() / 1000); // Use current system time
  const dayStr = getDayOfWeek(currentData.time);
  
  const tempStr = Math.round(currentData.temperature) + '°';

  // Top section header with measured positioning
  const dateWidth = await measureTextWidth(dateStr, 7);
  const timeWidth = await measureTextWidth(timeStr, 7);
  const dayWidth = await measureTextWidth(dayStr, 7);
  
  const dateX = 1;
  const dateEndX = dateX + dateWidth + 1; // 1px spacing after date
  const dayX = 64 - dayWidth; // right-aligned with 1px margin, moved 1px left
  const timeCenterX = (dateEndX + dayX) / 2; // center between date and day
  const timeX = Math.max(dateEndX + 1, timeCenterX - timeWidth / 2); // don't overlap with date
  
  await pasteTextColored(image, dateStr, dateX, 1, 7, C.alternate.r, C.alternate.g, C.alternate.b);
  await pasteTextColored(image, timeStr, timeX, 1, 7, C.white.r, C.white.g, C.white.b);
  await pasteTextColored(image, dayStr, dayX, 1, 7, C.accent.r, C.accent.g, C.accent.b);
  
  // Main section: Animated weather icon and temperature
  // Icon on left, temp on right
  const weatherIcon = await loadWeatherIcon(currentData.icon, isAnimationFrame2);
  if (weatherIcon) {
    image.composite(weatherIcon, Math.floor(2), Math.floor(11));
  } else {
    pasteGrayBox(image, 2, 11, 21);
  }
  const tempBigWidth = await measureBigNumberWidth(tempStr);
  const tempBigX = 64 - tempBigWidth - 1; // right-aligned with 1px margin
  // Render shadow behind
  await renderTemperatureBig(image, tempStr, tempBigX + 1, 12, C.divider.r, C.divider.g, C.divider.b);
  // Render white on top
  await renderTemperatureBig(image, tempStr, tempBigX, 11, C.white.r, C.white.g, C.white.b);
  
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
  await pasteTextColored(image, todayHighStr, todayX, 27, 6, C.todayHigh.r, C.todayHigh.g, C.todayHigh.b);
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
  const columnCenters = [8, 24, 40, 56]; // x centers for each column
  
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
    palette.push(c);
    usedKeys.add(key);
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

  // Create GIF encoder
  const gif = new GIFEncoder(width, height);

  // Use stream to capture GIF output before writing frames
  const { Writable } = require('stream');
  const chunks = [];
  const writable = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });

  return new Promise((resolve, reject) => {
    // Set up event listeners BEFORE starting encoding
    writable.on('finish', () => {
      const buffer = Buffer.concat(chunks);
      fs.writeFileSync(outputFile, buffer);
      console.log(`✓ Weather GIF generated: ${outputFile}`);
      resolve();
    });

    writable.on('error', (err) => {
      reject(err);
    });

    gif.on('error', (err) => {
      reject(err);
    });

    // Now pipe and encode
    gif.pipe(writable);
    gif.writeHeader();
    gif.setQuality(1); // Best NeuQuant quality for palette accuracy
    gif.setDelay(944); // 944ms per frame
    gif.setRepeat(0); // Loop infinitely
    gif.addFrame(frame1);
    gif.addFrame(frame2);
    gif.finish();
  });
}

// Main execution
async function main() {
  const opts = loadOptions();
  const forecastEntity = opts.forecast_entity;
  const stationEntity = opts.station_entity;
  const outputFile = '/data/weather-forecast.gif';
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

      console.log(`Generating GIF #${generationCount}...`);
      await generateGIF(weatherData, outputFile);
      console.log(`✓ Done!`);
    } catch (error) {
      console.error('❌ Error:', error.message);
    }
  }

  try {
    console.log(`Home Assistant Weather Forecast GIF`);
    console.log(`   Forecast entity: ${forecastEntity}`);
    console.log(`   Station entity:  ${stationEntity || '(none)'}`);
    console.log(`   Output: ${outputFile}`);
    console.log(`   Port: ${PORT}`);
    console.log(`Starting continuous GIF generation (every 1 min on the minute)\n`);
    
    // Set up Express web server
    const app = express();
    
    // Serve the GIF file
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
    
    // Start web server
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Web server running on port ${PORT}`);
      console.log(`Access the GIF at http://<your-ha-ip>:${PORT}/`);
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

main();

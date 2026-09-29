/**
 * City-wide road conditions: weather (live feed or operator override) and the simulated
 * traffic level. Local conditions — blocks, waterlogging, local rain — are crowd reports
 * (reportsService).
 */
import { getReports, type PublicReport } from './reportsService.js';

export type WeatherCondition = 'clear' | 'rain' | 'heavy_rain';
export type WeatherMode = 'live' | WeatherCondition;
export type TrafficLevel = 'light' | 'normal' | 'heavy';

export interface WeatherState {
  condition: WeatherCondition;
  /** mm/h from the live feed (null when unknown) */
  precipitation: number | null;
  /** 'live' = Open-Meteo feed, 'manual' = operator override, 'unavailable' = feed unreachable */
  source: 'live' | 'manual' | 'unavailable';
  /** Multiplier on driving speeds */
  speedFactor: number;
  /** Multiplier on road capacity */
  capacityFactor: number;
  updatedAt: number;
}

export interface ConditionsSnapshot {
  weather: WeatherState;
  weatherMode: WeatherMode;
  trafficLevel: TrafficLevel;
  reports: PublicReport[];
}

const WEATHER_EFFECTS: Record<WeatherCondition, { speedFactor: number; capacityFactor: number }> = {
  clear: { speedFactor: 1, capacityFactor: 1 },
  rain: { speedFactor: 0.8, capacityFactor: 0.85 },
  heavy_rain: { speedFactor: 0.6, capacityFactor: 0.7 },
};
/** mm/h thresholds for the live feed */
const RAIN_MM = 0.2;
const HEAVY_RAIN_MM = 4;
const WEATHER_POLL_MS = 10 * 60 * 1000;
const BANGALORE = { lat: 12.9716, lng: 77.5946 };

let weatherMode: WeatherMode = 'live';
let liveWeather: WeatherState = makeWeather('clear', null, 'unavailable');
let trafficLevel: TrafficLevel = 'normal';

function makeWeather(condition: WeatherCondition, precipitation: number | null, source: WeatherState['source']): WeatherState {
  return { condition, precipitation, source, ...WEATHER_EFFECTS[condition], updatedAt: Date.now() };
}

// ── Weather ──────────────────────────────────────────────────────────────────

async function fetchLiveWeather(): Promise<void> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${BANGALORE.lat}&longitude=${BANGALORE.lng}&current=precipitation`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { current?: { precipitation?: number } };
    const mm = data.current?.precipitation ?? 0;
    const condition: WeatherCondition = mm >= HEAVY_RAIN_MM ? 'heavy_rain' : mm >= RAIN_MM ? 'rain' : 'clear';
    liveWeather = makeWeather(condition, mm, 'live');
  } catch (err) {
    console.warn('[Conditions] Live weather unavailable:', (err as Error).message);
    liveWeather = { ...liveWeather, source: 'unavailable', updatedAt: Date.now() };
  }
}

export function startWeatherPolling(): void {
  fetchLiveWeather();
  setInterval(fetchLiveWeather, WEATHER_POLL_MS).unref();
}

export function getWeather(): WeatherState {
  return weatherMode === 'live' ? liveWeather : makeWeather(weatherMode, null, 'manual');
}

export function setWeatherMode(mode: WeatherMode): void {
  weatherMode = mode;
}

// ── Traffic level ────────────────────────────────────────────────────────────

export function getTrafficLevel(): TrafficLevel {
  return trafficLevel;
}

export function setTrafficLevel(level: TrafficLevel): void {
  trafficLevel = level;
}

export function getConditions(): ConditionsSnapshot {
  return { weather: getWeather(), weatherMode, trafficLevel, reports: getReports() };
}

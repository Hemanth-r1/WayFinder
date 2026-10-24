/**
 * City-wide road conditions: weather (live feed or operator override) and the simulated
 * traffic level. Local conditions — blocks, waterlogging, local rain — are crowd reports
 * (reportsService).
 */
import { getReports, type PublicReport } from './reportsService.js';

export type WeatherCondition = 'clear' | 'rain' | 'heavy_rain';
export type WeatherMode = 'live' | WeatherCondition;
export type TrafficLevel = 'light' | 'normal' | 'heavy';
export type TrafficMode = 'auto' | TrafficLevel;

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

/**
 * Driver behaviour switches for the simulation. By default everyone follows the road
 * rules except a few wrong-way riders (an add-on that operators can switch off); red-light
 * jumping and lane weaving can be switched on to see their effect.
 */
export interface Behaviour {
  redJumping: boolean;
  laneWeaving: boolean;
  wrongWay: boolean;
}

export interface ConditionsSnapshot {
  behaviour: Behaviour;
  weather: WeatherState;
  weatherMode: WeatherMode;
  /** Effective level (follows the clock in 'auto' mode) */
  trafficLevel: TrafficLevel;
  trafficMode: TrafficMode;
  /** Current traffic as a share of peak (0–1) */
  demand: number;
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
/** 'auto' follows Bangalore's daily rhythm; operators can pin a level. */
let trafficMode: TrafficMode = 'auto';
let behaviour: Behaviour = { redJumping: false, laneWeaving: false, wrongWay: true };

export function getBehaviour(): Behaviour {
  return behaviour;
}

export function setBehaviour(change: Partial<Behaviour>): Behaviour {
  const next = { ...behaviour };
  for (const k of ['redJumping', 'laneWeaving', 'wrongWay'] as const) {
    if (typeof change[k] === 'boolean') next[k] = change[k];
  }
  behaviour = next;
  return behaviour;
}

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

/**
 * Share of peak-hour traffic on Bangalore roads by IST hour (0–23): morning peak
 * 8:30–11, evening peak 17:30–21, quiet after midnight.
 */
const HOURLY_DEMAND = [
  0.12, 0.08, 0.06, 0.06, 0.08, 0.15, 0.30, 0.55, 0.85, 1.00, 0.95, 0.78,
  0.70, 0.70, 0.68, 0.72, 0.82, 0.95, 1.00, 1.00, 0.85, 0.62, 0.40, 0.22,
];
/** Manual settings as a share of peak traffic. */
const LEVEL_DEMAND: Record<TrafficLevel, number> = { light: 0.35, normal: 0.65, heavy: 1 };

/** Bangalore clock (IST, UTC+5:30). */
function istNow(): { hour: number; minute: number; day: number } {
  const d = new Date(Date.now() + 5.5 * 3600 * 1000);
  return { hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: d.getUTCDay() };
}

/** Share of peak traffic expected right now from the time of day and weekday. */
function clockDemand(): number {
  const { hour, minute, day } = istNow();
  const a = HOURLY_DEMAND[hour], b = HOURLY_DEMAND[(hour + 1) % 24];
  const weekday = day === 0 ? 0.6 : day === 6 ? 0.78 : 1;
  return (a + (b - a) * minute / 60) * weekday;
}

/** Current traffic as a share of peak (0–1). */
export function getDemand(): number {
  return trafficMode === 'auto' ? clockDemand() : LEVEL_DEMAND[trafficMode];
}

/** Light / normal / heavy, following the clock in 'auto' mode. */
export function getTrafficLevel(): TrafficLevel {
  if (trafficMode !== 'auto') return trafficMode;
  const d = clockDemand();
  return d >= 0.85 ? 'heavy' : d >= 0.45 ? 'normal' : 'light';
}

export function setTrafficLevel(level: TrafficMode): void {
  trafficMode = level;
}

export function getConditions(): ConditionsSnapshot {
  return {
    behaviour, weather: getWeather(), weatherMode, trafficLevel: getTrafficLevel(), trafficMode,
    demand: Math.round(getDemand() * 100) / 100, reports: getReports(),
  };
}

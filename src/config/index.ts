/**
 * Application Configuration
 * Centralized configuration for WayFinder
 */

// Map Configuration
export const MAP_CONFIG = {
  BANGALORE_CENTER: { lat: 12.9716, lng: 77.5946 } as const,
  DEFAULT_ZOOM: 13,
  MINI_MAP_ZOOM: 11,
  MINI_MAP_SIZE: { width: 160, height: 120 },
  OSM_TILE_URL: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  MAX_ZOOM: 19,
} as const;

// Road Network Configuration
export const ROAD_CONFIG = {
  FETCH_RADIUS: 40000, // meters
  FALLBACK_GRID_SIZE: { rows: 8, cols: 8 },
  ROAD_TYPE_COLORS: {
    primary: '#FF6D00',
    secondary: '#FF9100',
    tertiary: '#FFAB4066',
    residential: '#FFAB4066',
    motorway: '#FF6D00',
    trunk: '#FF6D00',
  } as const,
  ROAD_TYPE_WIDTHS: {
    primary: 4,
    secondary: 3,
    tertiary: 1.5,
    residential: 1.5,
    motorway: 4,
    trunk: 4,
  } as const,
} as const;

// Simulation Configuration
export const SIMULATION_CONFIG = {
  MAX_VEHICLES: 120,
  SPAWN_INTERVAL: { min: 200, max: 800 }, // milliseconds
  INITIAL_VEHICLES: 20,
  UPDATE_INTERVAL: 0.05, // seconds (max delta time)
  VEHICLE_SPAWN_COUNT: 3, // per spawn interval
} as const;

// Signal Configuration
export const SIGNAL_CONFIG = {
  TIMING: {
    MIN_GREEN: 8, // seconds
    MAX_GREEN: 45, // seconds
    YELLOW_DURATION: 3, // seconds
    ALL_RED_DURATION: 2, // seconds
    LOST_TIME_PER_PHASE: 2, // seconds
    CRITICAL_GAP: 2.0, // seconds
  } as const,
  DETECTION_RADIUS: 150, // meters
  ADAPTIVE_UPDATE_INTERVAL: 1, // seconds
  GREEN_WAVE_MIN_VEHICLES: 20,
} as const;

// UI Configuration
export const UI_CONFIG = {
  SIDEBAR_WIDTH: 340,
  SIDEBAR_MIN_WIDTH: 340,
  BUTTON_COLORS: {
    primary: '#FF6D00',
    secondary: '#2196F3',
    success: '#4CAF50',
    danger: '#f44336',
    warning: '#FF9800',
  } as const,
  COLORS: {
    background: '#0a0a14',
    sidebarBackground: 'rgba(10,10,20,0.98)',
    panelBackground: 'rgba(20,20,35,0.95)',
    border: '#333',
    text: {
      primary: '#fff',
      secondary: '#888',
      disabled: '#666',
    },
  } as const,
} as const;

// Feature Flags
export const FEATURE_FLAGS = {
  ENABLE_FIREBASE: false, // Set to true when Firebase is configured
  ENABLE_GOOGLE_MAPS: false, // Set to true when Google Maps is configured
  ENABLE_PERSISTENCE: false,
  ENABLE_ANALYTICS: true,
  ENABLE_PERFORMANCE_MONITORING: true,
} as const;

// Environment Configuration
export const ENV = {
  NODE_ENV: import.meta.env.MODE || 'development',
  IS_DEV: import.meta.env.DEV,
  IS_PROD: import.meta.env.PROD,
} as const;

// Application Information
export const APP_INFO = {
  NAME: 'WayFinder',
  VERSION: '0.0.0',
  DESCRIPTION: 'Real-time traffic signal control and simulation system for Bangalore',
  AUTHOR: 'AVKS Team',
  REPOSITORY: 'https://github.com/avks/wayfinder',
} as const;

export default {
  MAP_CONFIG,
  ROAD_CONFIG,
  SIMULATION_CONFIG,
  SIGNAL_CONFIG,
  UI_CONFIG,
  FEATURE_FLAGS,
  ENV,
  APP_INFO,
} as const;
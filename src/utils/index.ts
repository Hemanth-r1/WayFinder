/**
 * Common utility functions for WayFinder
 */

import type { GeoPoint } from '../types';

/**
 * Calculate haversine distance between two points in meters
 */
export function haversineDistance(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + 
    Math.cos(a.lat * Math.PI / 180) * 
    Math.cos(b.lat * Math.PI / 180) * 
    Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/**
 * Format distance in meters to human-readable string
 */
export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Format time in seconds to human-readable string
 */
export function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Generate a random ID
 */
export function generateId(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Format coordinate for display
 */
export function formatCoordinate(lat: number, lng: number): string {
  return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
}

/**
 * Calculate bearing from dx, dy components
 */
export function calculateBearing(dx: number, dy: number): number {
  return ((Math.atan2(dx, dy) * 180 / Math.PI) % 360 + 360) % 360;
}

/**
 * Clamp a value between min and max
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Generate random number in range [min, max]
 */
export function randomInRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Deep clone an object (handles undefined, Date, Map, Set, etc.)
 */
export function deepClone<T>(obj: T): T {
  return structuredClone(obj);
}

/**
 * Debounce function
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Throttle function
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  let timeoutId: ReturnType<typeof setTimeout>;
  
  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;

    if (timeSinceLastCall >= delay) {
      lastCall = now;
      fn(...args);
      return;
    }

    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      lastCall = Date.now();
      fn(...args);
    }, delay - timeSinceLastCall);
  };
}

/**
 * Format file size
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Check if value is valid number
 */
export function isNumeric(value: any): boolean {
  return !isNaN(parseFloat(value)) && isFinite(value);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Log performance metrics
 */
export function logPerformance(name: string, startTime: number): number {
  const duration = performance.now() - startTime;
  console.log(`⏱️ ${name}: ${duration.toFixed(2)}ms`);
  return duration;
}

/**
 * Color utilities
 */
export const ColorUtils = {
  hexToRgb(hex: string): { r: number; g: number; b: number } {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : { r: 0, g: 0, b: 0 };
  },

  rgba(color: string, alpha: number): string {
    const rgb = this.hexToRgb(color);
    return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
  },

  lighten(color: string, percent: number): string {
    const rgb = this.hexToRgb(color);
    const factor = 1 + (percent / 100);
    return `rgb(${Math.min(255, Math.round(rgb.r * factor))}, ${Math.min(255, Math.round(rgb.g * factor))}, ${Math.min(255, Math.round(rgb.b * factor))})`;
  },

  darken(color: string, percent: number): string {
    const rgb = this.hexToRgb(color);
    const factor = 1 - (percent / 100);
    return `rgb(${Math.max(0, Math.round(rgb.r * factor))}, ${Math.max(0, Math.round(rgb.g * factor))}, ${Math.max(0, Math.round(rgb.b * factor))})`;
  },
};
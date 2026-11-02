import { Capacitor } from '@capacitor/core';

/**
 * PawRescue Community — shared development backend configuration.
 *
 * When your XAMPP computer's LAN IP changes, update ONLY this value.
 * Your Android phone and computer must be able to reach each other.
 */
const DEVELOPMENT_BACKEND_IP = '192.168.100.23';
const BACKEND_PATH = '/pawrescue/pawrescue_api';

/**
 * Browser on the same computer/LAN: use the host that opened the app.
 * Native Android: use the configured XAMPP computer IP.
 */
export function getBackendHost(): string {
  if (Capacitor.isNativePlatform()) {
    return DEVELOPMENT_BACKEND_IP;
  }

  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';

  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)
  ) {
    return hostname;
  }

  return DEVELOPMENT_BACKEND_IP;
}

export function getApiBaseUrl(): string {
  return `http://${getBackendHost()}${BACKEND_PATH}`;
}

export function getServerBaseUrl(): string {
  return `http://${getBackendHost()}`;
}

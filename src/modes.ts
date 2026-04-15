import { getConfig, type HubConfig } from './config';
import { getSetting } from './db';
import type { HubModes } from './types';

function settingEnabled(key: string): boolean {
  const value = getSetting(key);
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true';
}

export function getEffectiveModes(cfg: HubConfig = getConfig()): HubModes {
  return {
    freeOnly: cfg.freeOnly || settingEnabled('free_only'),
    localOnly: cfg.localOnly || settingEnabled('local_only'),
    premiumEnabled: cfg.premiumEnabled || settingEnabled('premium_enabled'),
  };
}
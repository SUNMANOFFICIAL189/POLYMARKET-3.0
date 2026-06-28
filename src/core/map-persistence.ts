/**
 * Tiny JSON persistence for in-memory cooldown / consensus Maps — fidelity
 * Tier-1 3.3 (2026-06-28). These maps (stop-loss cooldowns, the 48h consensus
 * window, the re-entry cooldown) were ephemeral and reset to empty on every
 * restart — so a restart silently BYPASSED re-entry guards and mis-sized trades
 * (solo $50 instead of consensus $100/$150) for up to the window length.
 *
 * All writes/reads are best-effort and non-fatal: a persistence failure must
 * never break the trading path. Entries older than maxAgeMs are pruned ON LOAD
 * so stale state never lingers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from '../utils/logger.js';

/** Persist a Map<string, number> (e.g. marketId → cooldown timestamp). */
export function persistTimestampMap(path: string, map: Map<string, number>): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(map)));
  } catch (err) {
    logger.warn(`map-persistence: write ${path} failed (non-fatal): ${err}`);
  }
}

/** Load a Map<string, number>, dropping entries older than maxAgeMs (vs nowMs). */
export function loadTimestampMap(path: string, maxAgeMs: number, nowMs: number): Map<string, number> {
  const out = new Map<string, number>();
  try {
    if (!existsSync(path)) return out;
    const obj = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    for (const [k, ts] of Object.entries(obj)) {
      if (typeof ts === 'number' && nowMs - ts < maxAgeMs) out.set(k, ts);
    }
    if (out.size > 0) logger.info(`map-persistence: loaded ${out.size} live entr${out.size === 1 ? 'y' : 'ies'} from ${path}`);
  } catch (err) {
    logger.warn(`map-persistence: load ${path} failed (non-fatal): ${err}`);
  }
  return out;
}

/** Persist a Map<string, Array<{ timestamp: number, ... }>> (e.g. consensus buckets). */
export function persistBucketMap<T extends { timestamp: number }>(path: string, map: Map<string, T[]>): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(Object.fromEntries(map)));
  } catch (err) {
    logger.warn(`map-persistence: write ${path} failed (non-fatal): ${err}`);
  }
}

/** Load a bucket Map, pruning bucket entries older than maxAgeMs and empty buckets. */
export function loadBucketMap<T extends { timestamp: number }>(path: string, maxAgeMs: number, nowMs: number): Map<string, T[]> {
  const out = new Map<string, T[]>();
  try {
    if (!existsSync(path)) return out;
    const obj = JSON.parse(readFileSync(path, 'utf8')) as Record<string, T[]>;
    for (const [k, arr] of Object.entries(obj)) {
      const fresh = (Array.isArray(arr) ? arr : []).filter(
        (e) => e && typeof e.timestamp === 'number' && nowMs - e.timestamp < maxAgeMs,
      );
      if (fresh.length) out.set(k, fresh);
    }
    if (out.size > 0) logger.info(`map-persistence: loaded ${out.size} bucket(s) from ${path}`);
  } catch (err) {
    logger.warn(`map-persistence: load ${path} failed (non-fatal): ${err}`);
  }
  return out;
}

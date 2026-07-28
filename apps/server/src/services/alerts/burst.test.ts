import { describe, it, expect } from 'vitest';
import { BurstTracker, burstDedupeKey } from './burst.js';

/**
 * 19 §3.1 burst heuristic — the in-process RPM tracker. Pure, deterministic (time is injected as
 * `now`), so the fire condition — current > max(5× trailing-hour avg, 30) AND current > 30 — is
 * exercised directly without a clock or DB.
 */

const at = (minute: number): Date => new Date(minute * 60_000);

describe('BurstTracker.record', () => {
  it('does not fire below the 30-rpm floor even with a zero baseline', () => {
    const t = new BurstTracker();
    let ev = t.record('vk', at(1000));
    for (let i = 1; i < 30; i++) ev = t.record('vk', at(1000));
    // 30 requests in the minute → currentRpm 30, threshold max(0,30)=30, NOT > 30 → no fire.
    expect(ev.currentRpm).toBe(30);
    expect(ev.fire).toBe(false);
  });

  it('fires when the current minute clears the 30 floor on a cold key', () => {
    const t = new BurstTracker();
    let ev = t.record('vk', at(2000));
    for (let i = 1; i < 31; i++) ev = t.record('vk', at(2000));
    expect(ev.currentRpm).toBe(31);
    expect(ev.thresholdRpm).toBe(30); // 5×0 avg floored to 30
    expect(ev.fire).toBe(true);
  });

  it('uses 5× the trailing-hour average once a baseline exists', () => {
    const t = new BurstTracker();
    // Baseline: 60 rpm in each of the 60 prior minutes → trailing avg 60, threshold 300.
    for (let m = 3000; m < 3060; m++) for (let i = 0; i < 60; i++) t.record('vk', at(m));
    // Current minute 3060: 200 rpm — over the floor but under 5×60=300 → no fire.
    let ev = t.record('vk', at(3060));
    for (let i = 1; i < 200; i++) ev = t.record('vk', at(3060));
    expect(Math.round(ev.trailingHourAvgRpm)).toBe(60);
    expect(ev.thresholdRpm).toBe(300);
    expect(ev.fire).toBe(false);
    // 301 in the same minute → over 300 → fire.
    for (let i = 200; i < 301; i++) ev = t.record('vk', at(3060));
    expect(ev.currentRpm).toBe(301);
    expect(ev.fire).toBe(true);
  });

  it('prunes buckets outside the 60-minute window (baseline decays)', () => {
    const t = new BurstTracker();
    for (let i = 0; i < 100; i++) t.record('vk', at(5000)); // a spike an hour+ ago
    // 61 minutes later that bucket is outside the window → trailing avg 0 again.
    const ev = t.record('vk', at(5061));
    expect(ev.trailingHourAvgRpm).toBe(0);
    expect(ev.currentRpm).toBe(1);
  });

  it('tracks keys independently', () => {
    const t = new BurstTracker();
    for (let i = 0; i < 40; i++) t.record('a', at(6000));
    const b = t.record('b', at(6000));
    expect(b.currentRpm).toBe(1);
    expect(b.fire).toBe(false);
  });

  it('evicts an idle key once its buckets age out of the window (memory bound)', () => {
    const t = new BurstTracker();
    t.record('idle', at(7000));
    t.record('active', at(7000));
    expect(t.activeKeyCount()).toBe(2);
    // 61 minutes later only 'active' is still recording. The once-per-minute global sweep must drop
    // 'idle' (its lone bucket at 7000 is now outside the window), NOT keep it forever.
    t.record('active', at(7061));
    expect(t.activeKeyCount()).toBe(1);
  });
});

describe('burstDedupeKey', () => {
  it('is stable within a UTC minute and rolls at the boundary', () => {
    const k1 = burstDedupeKey('vk', new Date('2026-07-16T12:34:07Z'));
    const k2 = burstDedupeKey('vk', new Date('2026-07-16T12:34:59Z'));
    const k3 = burstDedupeKey('vk', new Date('2026-07-16T12:35:00Z'));
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toBe('burst:vk:2026-07-16T12:34');
  });
});

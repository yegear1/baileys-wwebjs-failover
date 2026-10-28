import type { MaintenanceScheduleConfig } from "./types.js";

export const DEFAULT_SCHEDULE_CONFIG: MaintenanceScheduleConfig = {
  minDays: 3,
  maxDays: 5,
  windowStartHour: 2,
  windowStartMinute: 30,
  windowEndHour: 5,
  windowEndMinute: 40,
  typingDelayMinMs: 3000,
  typingDelayMaxMs: 5000,
};

/**
 * Calculates the next randomized keep-alive window within off-peak quiet hours (02:30–05:40).
 *
 * INVARIANT: Anti-fingerprinting requires non-deterministic execution times. Scheduling
 * jitter prevents WhatsApp heuristics from identifying robotic cron intervals.
 *
 * @param now Reference timestamp (defaults to current system time).
 * @param config Optional schedule configuration overrides.
 * @param random Injected RNG function (defaults to Math.random).
 * @returns Target Date in the future strictly falling between 02:30 and 05:40.
 */
export function calculateNextMaintenanceWindow(
  now: Date = new Date(),
  config: Partial<MaintenanceScheduleConfig> = {},
  random: () => number = Math.random,
): Date {
  const merged: MaintenanceScheduleConfig = {
    ...DEFAULT_SCHEDULE_CONFIG,
    ...config,
  };

  // 1. Pick a random day offset in [minDays, maxDays]
  const dayRange = Math.max(0, merged.maxDays - merged.minDays);
  const dayOffset = Math.min(
    merged.maxDays,
    merged.minDays + Math.floor(random() * (dayRange + 1)),
  );

  // 2. Pick a random minute inside quiet hours window [02:30 .. 05:40]
  const startMinuteOfDay = merged.windowStartHour * 60 + merged.windowStartMinute;
  const endMinuteOfDay = merged.windowEndHour * 60 + merged.windowEndMinute;
  const minuteRange = Math.max(0, endMinuteOfDay - startMinuteOfDay);

  const chosenMinuteOffset = Math.min(minuteRange, Math.floor(random() * (minuteRange + 1)));
  const chosenMinuteOfDay = startMinuteOfDay + chosenMinuteOffset;

  const targetHour = Math.floor(chosenMinuteOfDay / 60);
  const targetMinute = chosenMinuteOfDay % 60;
  const targetSecond = Math.min(59, Math.floor(random() * 60));

  const target = new Date(now.getTime());
  target.setDate(target.getDate() + dayOffset);
  target.setHours(targetHour, targetMinute, targetSecond, 0);

  // If due to clock adjustments target is not strictly after now, advance by minDays
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + merged.minDays);
  }

  return target;
}

/**
 * Computes a randomized typing duration between min and max milliseconds.
 *
 * INVARIANT: Simulating human-like composing delays (3–5 seconds) prevents
 * immediate automated bursts that trigger bot detection flags on companion sockets.
 */
export function calculateTypingDelay(
  minMs: number = DEFAULT_SCHEDULE_CONFIG.typingDelayMinMs,
  maxMs: number = DEFAULT_SCHEDULE_CONFIG.typingDelayMaxMs,
  random: () => number = Math.random,
): number {
  const range = Math.max(0, maxMs - minMs);
  return Math.min(maxMs, minMs + Math.floor(random() * (range + 1)));
}

import type { PetIntent } from "../types";

const outcomeKinds = new Set(["success", "snoozed", "skipped"]);

export function isIntentExpired(intent: PetIntent, now = Date.now()): boolean {
  return Boolean(intent.expiresAt && new Date(intent.expiresAt).getTime() <= now);
}

export function shouldAcceptIntent(
  current: PetIntent | null,
  next: PetIntent,
  now = Date.now(),
): boolean {
  if (!current || isIntentExpired(current, now)) return true;
  if (
    current.occurrenceId &&
    current.occurrenceId === next.occurrenceId &&
    outcomeKinds.has(next.kind)
  ) {
    return true;
  }
  return next.priority >= current.priority;
}

export function formatRemaining(endsAt: string, now = Date.now()): string {
  const total = Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}


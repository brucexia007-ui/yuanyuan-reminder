import type { AppSettings, PetIntent } from "../types";
import { petDisplayName } from "../brand";

const outcomeKinds = new Set(["success", "snoozed", "skipped"]);
const quietSuppressedKinds = new Set([
  "reminder",
  "overdue",
  "success",
  "snoozed",
  "skipped",
  "break",
  "activity",
]);
const systemCardKinds = new Set(["reminder", "overdue", "activity"]);

export type IntentTextSurface = "none" | "system_card";

export function intentTextSurface(intent: PetIntent): IntentTextSurface {
  return systemCardKinds.has(intent.kind) && intent.occurrenceId
    ? "system_card"
    : "none";
}

export function motionOnlyAccessibleLabel(intent: PetIntent): string | null {
  switch (intent.kind) {
    case "success":
      return `记录完成；${petDisplayName}高兴地跳了一下`;
    case "snoozed":
      return `提醒已延后；${petDisplayName}安静等候`;
    case "skipped":
      return `提醒已跳过；${petDisplayName}把任务牌收起`;
    case "care":
      if (intent.animation === "eating-food") return `${petDisplayName}正在吃猫粮`;
      if (intent.animation === "drinking-water") return `${petDisplayName}正在喝水`;
      return null;
    default:
      return null;
  }
}

export function remindersPaused(
  settings: Pick<AppSettings, "pauseUntil">,
  now = Date.now(),
): boolean {
  if (!settings.pauseUntil) return false;
  const until = Date.parse(settings.pauseUntil);
  return Number.isFinite(until) && until > now;
}

export function quietSuppressesIntent(intent: PetIntent): boolean {
  return quietSuppressedKinds.has(intent.kind);
}

export function basicSupportSuppressesIntent(intent: PetIntent): boolean {
  return !["reminder", "overdue"].includes(intent.kind);
}

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

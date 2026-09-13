import { petText } from "./petProfile";
import type { AppSettings, PetIntent } from "../types";

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
      return petText("记录完成；{pet}高兴地跳了一下");
    case "snoozed":
      return petText("提醒已延后；{pet}安静等候");
    case "skipped":
      return petText("提醒已跳过；{pet}把任务牌收起");
    case "care":
      if (intent.animation === "eating-food") return petText("{pet}正在吃猫粮");
      if (intent.animation === "drinking-water") return petText("{pet}正在喝水");
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

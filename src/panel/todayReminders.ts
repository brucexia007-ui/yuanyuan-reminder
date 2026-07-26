import type { Occurrence, Reminder } from "../types";

const activeOccurrenceStatuses = new Set(["pending", "overdue", "snoozed"]);

export function plannedReminders(
  reminders: Reminder[],
  occurrences: Occurrence[],
): Reminder[] {
  const remindersWithActiveOccurrences = new Set(
    occurrences
      .filter((occurrence) => activeOccurrenceStatuses.has(occurrence.status))
      .map((occurrence) => occurrence.reminderId),
  );

  return reminders
    .filter(
      (reminder) =>
        reminder.enabled &&
        reminder.category !== "water" &&
        reminder.nextDueAt !== null &&
        !remindersWithActiveOccurrences.has(reminder.id),
    )
    .sort(
      (left, right) =>
        new Date(left.nextDueAt!).getTime() -
        new Date(right.nextDueAt!).getTime(),
    );
}

export function plannedDueLabel(
  dueAt: string,
  now = new Date(),
): { date: string; time: string } {
  const due = new Date(dueAt);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfDueDay = new Date(
    due.getFullYear(),
    due.getMonth(),
    due.getDate(),
  );
  const dayOffset = Math.round(
    (startOfDueDay.getTime() - startOfToday.getTime()) / 86_400_000,
  );
  const date =
    dayOffset === 0
      ? "今天"
      : dayOffset === 1
        ? "明天"
        : due.toLocaleDateString("zh-CN", {
            month: "numeric",
            day: "numeric",
          });

  return {
    date,
    time: due.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  };
}

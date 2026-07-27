import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettings,
  CreateReminderInput,
  FocusState,
  HistoryQuery,
  Occurrence,
  PetCareSnapshot,
  PetInteractionKind,
  TodaySnapshot,
} from "../types";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const demoAt = (hour: number, minute: number) => {
  const value = new Date();
  value.setHours(hour, minute, 0, 0);
  return value.toISOString();
};

let demoSnapshot: TodaySnapshot = {
  reminders: [
    {
      id: "demo-water",
      title: "喝水时间",
      category: "water",
      scheduleKind: "interval",
      scheduleJson: JSON.stringify({ everyMinutes: 60 }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled: true,
      nextDueAt: demoAt(16, 0),
      createdAt: demoAt(9, 0),
      updatedAt: demoAt(9, 0),
    },
    {
      id: "demo-work",
      title: "整理今天的工作计划",
      category: "work",
      scheduleKind: "once",
      scheduleJson: JSON.stringify({ atLocal: "14:30" }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled: true,
      nextDueAt: demoAt(14, 30),
      createdAt: demoAt(9, 5),
      updatedAt: demoAt(9, 5),
    },
  ],
  occurrences: [
    {
      id: "demo-water-due",
      reminderId: "demo-water",
      reminderTitle: "喝水时间",
      category: "water",
      scheduledAt: demoAt(15, 0),
      status: "pending",
      actedAt: null,
      snoozedUntil: null,
    },
    {
      id: "demo-work-due",
      reminderId: "demo-work",
      reminderTitle: "整理今天的工作计划",
      category: "work",
      scheduledAt: demoAt(14, 30),
      status: "pending",
      actedAt: null,
      snoozedUntil: null,
    },
    {
      id: "demo-activity-due",
      reminderId: "system-activity-reminder",
      reminderTitle: "起来活动一下",
      category: "personal",
      scheduledAt: demoAt(15, 5),
      status: "pending",
      actedAt: null,
      snoozedUntil: null,
    },
    {
      id: "demo-water-history",
      reminderId: "demo-water",
      reminderTitle: "喝水时间",
      category: "water",
      scheduledAt: demoAt(11, 0),
      status: "completed",
      actedAt: demoAt(11, 3),
      snoozedUntil: null,
    },
    {
      id: "demo-activity-history",
      reminderId: "system-activity-reminder",
      reminderTitle: "起来活动一下",
      category: "personal",
      scheduledAt: demoAt(12, 0),
      status: "completed",
      actedAt: demoAt(12, 8),
      snoozedUntil: null,
    },
  ],
  waterCompleted: 4,
  waterGoal: 9,
  notificationAvailable: false,
};

let demoSettings: AppSettings = {
  animationMode: "always",
  animationSpeed: 1,
  cursorFollow: true,
  alwaysOnTop: true,
  clickThrough: false,
  petWidth: 192,
  quietStart: "23:00",
  quietEnd: "07:30",
  idleSleepMinutes: 20,
  autostart: false,
  pauseUntil: null,
  waterStart: "09:00",
  waterEnd: "18:00",
  waterIntervalMinutes: 60,
  activityEnabled: true,
  activityStart: "09:00",
  activityEnd: "18:00",
  activityIntervalMinutes: 60,
};

let demoFocusState: FocusState = { session: null };
let demoCare: PetCareSnapshot = {
  total: 0,
  food: 0,
  water: 0,
  treat: 0,
  wand: 0,
  pet: 0,
  ball: 0,
  lastInteractionAt: null,
};

export async function listToday(): Promise<TodaySnapshot> {
  return isTauri
    ? invoke<TodaySnapshot>("list_today")
    : structuredClone(demoSnapshot);
}

export async function listHistory(query: HistoryQuery): Promise<Occurrence[]> {
  if (isTauri) {
    return invoke<Occurrence[]>("list_history", {
      days: query.days,
      status: query.status,
      category: query.category,
      query: query.query,
      limit: query.limit,
    });
  }
  const cutoff =
    query.days === null
      ? null
      : Date.now() - query.days * 24 * 60 * 60 * 1000;
  return demoSnapshot.occurrences
    .filter((item) => ["completed", "skipped"].includes(item.status))
    .filter((item) => query.status === null || item.status === query.status)
    .filter((item) => query.category === null || item.category === query.category)
    .filter(
      (item) =>
        query.query === null ||
        item.reminderTitle.includes(query.query),
    )
    .filter(
      (item) =>
        cutoff === null ||
        (item.actedAt !== null && new Date(item.actedAt).getTime() >= cutoff),
    )
    .sort(
      (left, right) =>
        new Date(right.actedAt ?? right.scheduledAt).getTime() -
        new Date(left.actedAt ?? left.scheduledAt).getTime(),
    )
    .slice(0, query.limit ?? 200);
}

export async function createReminder(input: CreateReminderInput): Promise<void> {
  if (isTauri) {
    await invoke("create_reminder", { input });
    return;
  }
  const now = new Date();
  const nextDue =
    input.scheduleKind === "once" && input.atLocal
      ? new Date(input.atLocal).toISOString()
      : new Date(
          now.getTime() + (input.everyMinutes ?? 60) * 60_000,
        ).toISOString();
  demoSnapshot = {
    ...demoSnapshot,
    reminders: [
      ...demoSnapshot.reminders,
      {
        id: crypto.randomUUID(),
        title: input.title,
        category: input.category,
        scheduleKind: input.scheduleKind,
        scheduleJson: JSON.stringify(input),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        enabled: true,
        nextDueAt: nextDue,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      },
    ],
  };
}

export async function completeOccurrence(id: string): Promise<void> {
  if (isTauri) {
    await invoke("complete_occurrence", { id });
    return;
  }
  const now = new Date().toISOString();
  let waterCompleted = demoSnapshot.waterCompleted;
  demoSnapshot = {
    ...demoSnapshot,
    occurrences: demoSnapshot.occurrences.map((item) => {
      if (
        item.id !== id ||
        !["pending", "overdue", "snoozed"].includes(item.status)
      ) {
        return item;
      }
      if (item.category === "water") waterCompleted += 1;
      return {
        ...item,
        status: "completed",
        actedAt: now,
        snoozedUntil: null,
      };
    }),
    waterCompleted,
  };
}

export async function snoozeOccurrence(id: string, minutes = 10): Promise<void> {
  if (isTauri) {
    await invoke("snooze_occurrence", { id, minutes });
    return;
  }
  const now = new Date();
  demoSnapshot = {
    ...demoSnapshot,
    occurrences: demoSnapshot.occurrences.map((item) =>
      item.id === id && ["pending", "overdue", "snoozed"].includes(item.status)
        ? {
            ...item,
            status: "snoozed",
            actedAt: now.toISOString(),
            snoozedUntil: new Date(
              now.getTime() + minutes * 60_000,
            ).toISOString(),
          }
        : item,
    ),
  };
}

export async function skipOccurrence(id: string): Promise<void> {
  if (isTauri) {
    await invoke("skip_occurrence", { id });
    return;
  }
  const now = new Date().toISOString();
  demoSnapshot = {
    ...demoSnapshot,
    occurrences: demoSnapshot.occurrences.map((item) =>
      item.id === id && ["pending", "overdue", "snoozed"].includes(item.status)
        ? {
            ...item,
            status: "skipped",
            actedAt: now,
            snoozedUntil: null,
          }
        : item,
    ),
  };
}

export async function recordWater(): Promise<void> {
  if (isTauri) {
    await invoke("record_water");
    return;
  }
  const now = new Date().toISOString();
  const oldest = demoSnapshot.occurrences
    .filter(
      (item) =>
        item.category === "water" &&
        ["pending", "overdue", "snoozed"].includes(item.status),
    )
    .sort(
      (left, right) =>
        new Date(left.snoozedUntil ?? left.scheduledAt).getTime() -
        new Date(right.snoozedUntil ?? right.scheduledAt).getTime(),
    )[0];
  demoSnapshot = {
    ...demoSnapshot,
    waterCompleted: demoSnapshot.waterCompleted + 1,
    occurrences: demoSnapshot.occurrences.map((item) =>
      item.id === oldest?.id
        ? {
            ...item,
            status: "completed",
            actedAt: now,
            snoozedUntil: null,
          }
        : item,
    ),
  };
}

export async function getFocusState(): Promise<FocusState> {
  return isTauri ? invoke<FocusState>("get_focus_state") : demoFocusState;
}

export async function startFocus(
  phase: "focus" | "break",
  durationMinutes: number,
): Promise<FocusState> {
  if (isTauri) {
    return invoke<FocusState>("start_focus", { phase, durationMinutes });
  }
  const now = new Date();
  demoFocusState = {
    session: {
      id: crypto.randomUUID(),
      phase,
      status: "active",
      durationMinutes,
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + durationMinutes * 60_000).toISOString(),
      completedAt: null,
    },
  };
  return demoFocusState;
}

export async function cancelFocus(): Promise<FocusState> {
  if (isTauri) return invoke<FocusState>("cancel_focus");
  demoFocusState = { session: null };
  return demoFocusState;
}

export async function getPetCare(): Promise<PetCareSnapshot> {
  return isTauri ? invoke<PetCareSnapshot>("get_pet_care") : demoCare;
}

export async function startPetInteraction(
  kind: PetInteractionKind,
): Promise<PetCareSnapshot> {
  if (isTauri) {
    return invoke<PetCareSnapshot>("start_pet_interaction", { kind });
  }
  demoCare = {
    ...demoCare,
    total: demoCare.total + 1,
    [kind]: demoCare[kind] + 1,
    lastInteractionAt: new Date().toISOString(),
  };
  await emit("pet-interaction-started", {
    id: crypto.randomUUID(),
    kind,
  });
  return demoCare;
}

export async function getSettings(): Promise<AppSettings> {
  return isTauri
    ? invoke<AppSettings>("get_settings")
    : structuredClone(demoSettings);
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (isTauri) return invoke<AppSettings>("update_settings", { patch });
  demoSettings = { ...demoSettings, ...patch };
  return structuredClone(demoSettings);
}

export async function showTaskPanel(route = "today"): Promise<void> {
  if (isTauri) await invoke("show_task_panel", { route });
}

export async function hidePetWindow(): Promise<void> {
  if (isTauri) await invoke("hide_pet_window");
}

export async function setPetSize(width: number): Promise<void> {
  if (isTauri) await invoke("set_pet_size", { width });
}

export async function setAlwaysOnTop(enabled: boolean): Promise<void> {
  if (isTauri) await invoke("set_always_on_top", { enabled });
}

export async function setClickThrough(enabled: boolean): Promise<void> {
  if (isTauri) await invoke("set_click_through", { enabled });
}

export async function requestSleep(): Promise<void> {
  if (isTauri) await invoke("request_sleep");
  else await emit("pet-request-sleep");
}

export async function requestWake(): Promise<void> {
  if (isTauri) await invoke("request_wake");
  else await emit("pet-request-wake");
}

export async function pauseReminders(minutes: number): Promise<void> {
  if (isTauri) await invoke("pause_reminders", { minutes });
}

export async function quitApplication(): Promise<void> {
  if (isTauri) await invoke("quit_application");
}

export async function onBackendEvent<T>(
  event: string,
  callback: (payload: T) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  return listen<T>(event, ({ payload }) => callback(payload));
}

export function tauriAvailable(): boolean {
  return isTauri;
}

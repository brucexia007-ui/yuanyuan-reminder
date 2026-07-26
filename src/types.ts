export type ReminderCategory = "water" | "work" | "personal";
export type ScheduleKind = "once" | "interval" | "daily" | "weekly";
export type OccurrenceStatus =
  | "pending"
  | "completed"
  | "snoozed"
  | "skipped"
  | "overdue";

export interface Reminder {
  id: string;
  title: string;
  category: ReminderCategory;
  scheduleKind: ScheduleKind;
  scheduleJson: string;
  timezone: string;
  enabled: boolean;
  nextDueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Occurrence {
  id: string;
  reminderId: string;
  reminderTitle: string;
  category: ReminderCategory;
  scheduledAt: string;
  status: OccurrenceStatus;
  actedAt: string | null;
  snoozedUntil: string | null;
}

export interface AppSettings {
  animationMode: "always" | "system" | "off";
  animationSpeed: number;
  cursorFollow: boolean;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  petWidth: number;
  petX?: number | null;
  petY?: number | null;
  quietStart: string;
  quietEnd: string;
  idleSleepMinutes: number;
  autostart: boolean;
  pauseUntil: string | null;
  waterStart: string;
  waterEnd: string;
  waterIntervalMinutes: number;
  activityEnabled: boolean;
  activityStart: string;
  activityEnd: string;
  activityIntervalMinutes: number;
}

export interface TodaySnapshot {
  reminders: Reminder[];
  occurrences: Occurrence[];
  waterCompleted: number;
  waterGoal: number;
  notificationAvailable: boolean;
}

export type FocusPhase = "focus" | "break";
export type FocusStatus = "active" | "completed" | "cancelled";

export interface FocusSession {
  id: string;
  phase: FocusPhase;
  status: FocusStatus;
  durationMinutes: number;
  startedAt: string;
  endsAt: string;
  completedAt: string | null;
}

export interface FocusState {
  session: FocusSession | null;
}

export type PetIntentKind =
  | "reminder"
  | "overdue"
  | "success"
  | "snoozed"
  | "skipped"
  | "focus"
  | "break"
  | "activity"
  | "care"
  | "play"
  | "sleep"
  | "idle";

export type PanelRoute =
  | "today"
  | "focus"
  | "care"
  | "history"
  | "add"
  | "settings";

export interface HistoryQuery {
  days: number | null;
  status: "completed" | "skipped" | null;
  category: ReminderCategory | null;
  query: string | null;
  limit?: number;
}

export interface PetIntent {
  id: string;
  kind: PetIntentKind;
  priority: number;
  animation:
    | "waving"
    | "meowing"
    | "jumping"
    | "activity-jumping"
    | "waiting"
    | "review"
    | "running"
    | "grooming"
    | "stretching"
    | "focus-calm"
    | "eating-food"
    | "drinking-water"
    | "treat-follow"
    | "wand-play"
    | "wand-reach"
    | "wand-swipe"
    | "wand-return"
    | "pet-nuzzle"
    | "ball-bat"
    | "ball-pickup"
    | "ball-carry"
    | "ball-drop"
    | "alert-glass-paws"
    | "failed"
    | "sleep-enter"
    | "wake-up"
    | "idle";
  route: PanelRoute;
  title: string;
  message: string;
  occurrenceId: string | null;
  persistent: boolean;
  expiresAt: string | null;
}

export type PetInteractionKind =
  | "food"
  | "water"
  | "treat"
  | "wand"
  | "pet"
  | "ball";

export interface PetCareSnapshot {
  total: number;
  food: number;
  water: number;
  treat: number;
  wand: number;
  pet: number;
  ball: number;
  lastInteractionAt: string | null;
}

export interface PetInteractionStarted {
  id: string;
  kind: PetInteractionKind;
}

export interface CreateReminderInput {
  title: string;
  category: ReminderCategory;
  scheduleKind: ScheduleKind;
  atLocal?: string;
  everyMinutes?: number;
  activeStartLocal?: string;
  activeEndLocal?: string;
  weekdays?: number[];
}

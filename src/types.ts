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
  archivedAt: string | null;
  systemKind: "water" | "activity" | null;
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
  resolutionReason: string | null;
}

export interface AppSettings {
  animationMode: "always" | "system" | "off";
  companionIntensity: "quiet" | "everyday" | "close";
  companionLabelMode: "motion_only" | "adaptive" | "always";
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
  missedReminderPolicy: "notify" | "skipOld";
  missedReminderGraceMinutes: number;
}

export interface BackupInfo {
  fileName: string;
  createdAt: string;
  sizeBytes: number;
  automatic: boolean;
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

export type BasicSupportPath = "stay_close" | "move_together" | "give_space";

export interface BasicSupportSession {
  id: string;
  path: BasicSupportPath;
  durationMinutes: number;
  startedAt: string;
  endsAt: string;
}

export type CompanionExpressionTier = "n0" | "n1" | "n2" | "n3" | "n4";
export type CompanionExpressionIntent =
  | "quiet_presence"
  | "acknowledge"
  | "approach"
  | "stay_close"
  | "watch"
  | "needs_attention"
  | "celebrate"
  | "inspect"
  | "put_away"
  | "present_information"
  | "request_formal_decision";
export type CompanionPose =
  | "idle"
  | "focus_calm"
  | "stretch"
  | "sleeping"
  | "acknowledge"
  | "approach"
  | "reunion"
  | "stay_close"
  | "watch_computer"
  | "alert"
  | "celebrate"
  | "review"
  | "put_away"
  | "observe_information"
  | "step_aside"
  | "give_space";
export type CompanionProp =
  | "computer"
  | "bell"
  | "task_card"
  | "basket"
  | "prompter"
  | "system_card";

export interface CompanionExpressionSnapshot {
  schemaVersion: 1;
  revision: number;
  tier: CompanionExpressionTier;
  intent: CompanionExpressionIntent;
  pose: CompanionPose;
  props: CompanionProp[];
  label:
    | "water_due"
    | "reminder_due"
    | "needs_user"
    | "time_to_move"
    | "running"
    | "still_running"
    | "completed"
    | "failed"
    | "cancelled"
    | "possibly_stalled"
    | "status_unknown"
    | "information"
    | "decision_required"
    | null;
  attention: "silent" | "present_once" | "ring_once";
  motion: "full" | "reduced";
  movePropForward: boolean;
  queueInBasket: boolean;
  taskSource: "codex" | "claude_code" | null;
  groupedCount: number;
  focusDeferredCount: number;
  accessibleState:
    | "quiet_presence"
    | "focused_quietly"
    | "focus_finished"
    | "welcoming_return"
    | "moving_together"
    | "giving_space"
    | "sleeping"
    | "heard_user"
    | "approaching"
    | "staying_close"
    | "water_reminder_due"
    | "work_reminder_due"
    | "task_needs_user"
    | "activity_reminder_due"
    | "task_running"
    | "task_still_running"
    | "task_completed"
    | "task_failed"
    | "task_cancelled"
    | "task_possibly_stalled"
    | "task_status_unknown"
    | "information_available"
    | "formal_decision_required";
}

export type TaskWatchSource = "codex" | "claude_code";
export type TaskWatchState =
  | "queued"
  | "running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stalled"
  | "unknown";

export interface TaskWatchStateCount {
  source: TaskWatchSource;
  state: TaskWatchState;
  count: number;
  deferredUntilUnixMs: number | null;
}

export interface TaskWatchSnapshot {
  schemaVersion: 2;
  available: boolean;
  observedCount: number;
  needsUserCount: number;
  states: TaskWatchStateCount[];
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
  | "taskwatch"
  | "focus"
  | "care"
  | "history"
  | "manage"
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

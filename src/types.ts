export type ReminderCategory = "water" | "meal" | "work" | "personal";

export interface RuntimeCapabilities {
  schemaVersion: 1;
  learning: {
    compiled: boolean;
    available: boolean;
    contentPackReady: boolean;
    autoInvitationAvailable: boolean;
    failureReason: "disabled" | "not_implemented" | "database" | "content" | null;
  };
}

export type LearningMode = "manual_only" | "automatic_opt_in";
export type LearningRating = "again" | "hard" | "good";
export type LearningStage = "new" | "learning" | "stable";
export type LearningEntrySource =
  | "manual"
  | "focus_finished"
  | "scheduled_window"
  | "work_gap_experimental";
export type LearningSessionKind = "daily" | "mistakes";

export interface LearningSettings {
  mode: LearningMode;
  cardsPerSession: 3 | 5 | 10;
  /** Legacy export compatibility only. Active learning is never capped by day. */
  dailyNewLimit: 0 | 5 | 10 | 20 | 30;
  dailyGoal: 0 | 5 | 10 | 20 | 30 | 50;
  focusFinishedEnabled: boolean;
  scheduledWindowsEnabled: boolean;
  workGapExperimentalEnabled: boolean;
  dailyInvitationLimit: 1 | 2 | 3;
  invitationCooldownMinutes: 60 | 120 | 240;
  invitationTtlSeconds: 20;
  pausedForLocalDay: string | null;
  updatedAtUnixMs: number;
}

export type LearningSettingsPatch = Partial<
  Pick<
    LearningSettings,
    | "mode"
    | "cardsPerSession"
    | "dailyNewLimit"
    | "dailyGoal"
    | "focusFinishedEnabled"
    | "scheduledWindowsEnabled"
    | "workGapExperimentalEnabled"
    | "dailyInvitationLimit"
    | "invitationCooldownMinutes"
  >
>;

export interface LearningSessionSnapshot {
  schemaVersion: 1;
  sessionId: string;
  entrySource: LearningEntrySource;
  sessionKind: LearningSessionKind;
  status: "created" | "active" | "paused" | "completed" | "abandoned" | "expired";
  stateRevision: number;
  currentItemId: string | null;
  plannedCount: number;
  completedCount: number;
  startedAtUnixMs: number;
  pausedAtUnixMs: number | null;
  pauseReason: string | null;
  lastActivityAtUnixMs: number;
  expiresAtUnixMs: number;
  endedAtUnixMs: number | null;
  exitReason: string | null;
}

export interface LearningCardDto {
  schemaVersion: 1;
  cardId: string;
  headword: string;
  phonetic: string | null;
  partOfSpeech: string[];
  meaningsZh: string[];
  wordFamily: string[];
  stage: LearningStage;
  sourceIds: string[];
}

export type LearningQuestionKind = "multiple_choice" | "recall_fallback";

export interface LearningQuestionOptionDto {
  optionId: string;
  meaningZh: string;
}

export interface LearningQuestionDto {
  schemaVersion: 1;
  questionId: string;
  kind: LearningQuestionKind;
  cardId: string;
  headword: string;
  phonetic: string | null;
  partOfSpeech: string[];
  stage: LearningStage;
  isRemediation: boolean;
  options: LearningQuestionOptionDto[];
}

export interface LearningAnswerResult {
  schemaVersion: 1;
  questionId: string;
  selectedOptionId: string;
  correctOptionId: string;
  correctMeaningZh: string;
  correct: boolean;
  isRemediation: boolean;
  replayed: boolean;
  session: LearningSessionSnapshot;
}

export type LearningRecordFilter =
  | "mistakes"
  | "studied"
  | "new"
  | "learning"
  | "stable"
  | "all";

export interface LearningRecordItem {
  cardId: string;
  headword: string;
  phonetic: string | null;
  partOfSpeech: string[];
  meaningsZh: string[];
  stage: LearningStage;
  dueAtUnixMs: number;
  reviewCount: number;
  correctCount: number;
  wrongCount: number;
  lastStudiedAtUnixMs: number | null;
  lastWrongAtUnixMs: number | null;
  latestOutcome: "correct" | "incorrect" | null;
  mistakeStatus:
    | "needs_correction"
    | "pending_recheck"
    | "consolidated"
    | null;
}

export interface LearningRecordPage {
  schemaVersion: 1;
  filter: LearningRecordFilter;
  query: string;
  page: number;
  pageSize: number;
  total: number;
  items: LearningRecordItem[];
}

export interface LearningHomeSnapshot {
  schemaVersion: 1;
  capabilities: RuntimeCapabilities["learning"];
  dueCount: number;
  newAvailableCount: number;
  newRemainingCount: number;
  newStudiedTodayCount: number;
  mistakeCount: number;
  pendingRecheckCount: number;
  stableCount: number;
  tomorrowDueCount: number;
  averageResponseMs: number | null;
  reviewsLast7Days: number;
  completedSessionsLast7Days: number;
  settings: LearningSettings;
  activeSession: LearningSessionSnapshot | null;
}

export interface LearningDashboardDay {
  localDay: string;
  newCount: number;
  reviewCount: number;
  firstAnswerCorrectCount: number;
  firstAnswerCount: number;
}

export interface LearningDashboardSnapshot {
  schemaVersion: 1;
  totalCount: number;
  studiedCount: number;
  newCount: number;
  learningCount: number;
  mistakeCount: number;
  pendingRecheckCount: number;
  stableCount: number;
  correctedMistakeCount: number;
  firstAnswerCorrectCount7Days: number;
  firstAnswerCount7Days: number;
  days: LearningDashboardDay[];
}

export interface LearningSessionSummary {
  schemaVersion: 1;
  session: LearningSessionSnapshot;
  correctCount: number;
  wrongCount: number;
  newCount: number;
  reviewCount: number;
  durationSeconds: number;
  averageResponseMs: number | null;
  targetableWrongCount: number;
}

export interface LearningRateResult {
  schemaVersion: 1;
  session: LearningSessionSnapshot;
  nextCard: LearningCardDto | null;
}

export interface LearningImportPreview {
  schemaVersion: 1;
  status: "cancelled" | "confirmation_required";
  previewToken: string | null;
  expiresAtUnixMs: number | null;
  format: "csv" | "json" | "learning_pack" | null;
  sourceLabel: string | null;
  cardCount: number;
  newCount: number;
  learningCount: number;
  reviewKnownCount: number;
  sampleHeadwords: string[];
  addedCount?: number;
  changedCount?: number;
  disabledCount?: number;
  resetCount?: number;
  rightsBasis?: string | null;
  rightsStatement?: string | null;
  redistributable?: boolean | null;
  sourceDetails?: string[];
  selectedPathReturned: false;
}

export interface LearningImportCommitResult {
  schemaVersion: 1;
  packId: string;
  importedCount: number;
  preservedScheduleCount: number;
}

export interface LearningInvitationDto {
  schemaVersion: 1;
  invitationId: string;
  triggerSource: Exclude<LearningEntrySource, "manual">;
  expiresAtUnixMs: number;
  dueReviewCount: number;
}

export type LearningExportFormat =
  | "native_json"
  | "cards_csv"
  | "review_logs_csv";
export type LearningDeleteScope = "progress_only" | "all_learning_data";

export interface LearningSourceSummary {
  sourceId: string;
  sourceKind: "user_import" | "authorized" | "open_data";
  version: string;
  sourceUrl: string | null;
  licenseExpression: string | null;
  noticeText: string | null;
}

export interface LearningPackSummary {
  packId: string;
  title: string;
  examScope: string;
  status: "preview" | "ready" | "disabled";
  rightsBasis?: string;
  redistributable?: boolean;
}

export interface LearningDataSummary {
  schemaVersion: 1;
  cardCount: number;
  reviewCount: number;
  lastSuccessfulExportAtUnixMs: number | null;
  sources: LearningSourceSummary[];
  packs: LearningPackSummary[];
}

export type LegacyLearningEdition = "preview" | "personal";

export interface LegacyLearningSourceSummary {
  schemaVersion: 1;
  edition: LegacyLearningEdition;
  status: "missing" | "invalid" | "available" | "already_migrated";
  sourceSchemaVersion: number | null;
  cardCount: number;
  reviewCount: number;
  failureReason: "database" | null;
}

export interface LegacyLearningMigrationPreview {
  schemaVersion: 1;
  status: "confirmation_required" | "already_migrated";
  edition: LegacyLearningEdition;
  previewToken: string | null;
  expiresAtUnixMs: number | null;
  sourceCardCount: number;
  sourceReviewCount: number;
  destinationCardCount: number;
  destinationReviewCount: number;
  replacesDestination: boolean;
  backupRequired: boolean;
  sourceDirectoryPreserved: true;
}

export interface LegacyLearningMigrationResult {
  schemaVersion: 1;
  status: "migrated" | "already_migrated";
  edition: LegacyLearningEdition;
  importedCardCount: number;
  importedReviewCount: number;
  backupFileName: string | null;
  sourceDirectoryPreserved: true;
  destinationVerified: true;
}

export interface LearningExportResult {
  schemaVersion: 1;
  status: "cancelled" | "saved";
  format: LearningExportFormat;
  recordCount: number;
  bytes: number;
  exportedAtUnixMs: number | null;
  selectedPathReturned: false;
}

export interface LearningDeleteResult {
  schemaVersion: 1;
  scope: LearningDeleteScope;
  keptCardCount: number;
  deletedReviewCount: number;
}

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
  petProfile: import("./pet/petProfile").PetProfile;
  animationMode: "always" | "system" | "off";
  sceneWardrobeMode: "off" | "reminders_only" | "full";
  companionIntensity: "quiet" | "everyday" | "close";
  companionLabelMode: "motion_only" | "adaptive" | "always";
  animationSpeed: number;
  cursorFollow: boolean;
  alwaysOnTop: boolean;
  clickThrough: boolean;
  learningQuickStartVisible: boolean;
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
  learningIncluded: boolean;
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

export interface SceneRestSession {
  id: string;
  durationMinutes: 5 | 10 | 20;
  startedAt: string;
  endsAt: string;
}

export type WorkSceneStage = "fresh" | "transition" | "fatigued";
export type SceneAppearance =
  | { kind: "none" }
  | { kind: "spa" | "meal" | "hydration" | "warmup" | "study" | "night" }
  | { kind: "work"; stage: WorkSceneStage };

export interface OccurrenceResolution {
  occurrenceId: string;
  category: ReminderCategory;
  action: "complete" | "snooze" | "skip";
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
  | "system_card"
  | "learning_card";

export interface CompanionExpressionSnapshot {
  schemaVersion: 2;
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
    | "review_ready"
    | null;
  attention: "silent" | "present_once" | "ring_once";
  motion: "full" | "reduced";
  movePropForward: boolean;
  queueInBasket: boolean;
  taskSource: "codex" | "claude_code" | null;
  groupedCount: number;
  focusDeferredCount: number;
  sceneAppearance: SceneAppearance;
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
    | "meal_reminder_due"
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
    | "formal_decision_required"
    | "learning_invitation"
    | "learning_session"
    | "resting_care"
    | "working"
    | "working_transition"
    | "working_fatigued";
}

export type PetActivity =
  | "idle"
  | "sleeping"
  | "reminding"
  | "focusing"
  | "learning"
  | "interrupted";
export type PetActivitySource =
  | "manual"
  | "schedule"
  | "reminder"
  | "focus"
  | "learning";
export type PetRestoreTarget =
  | "idle"
  | "sleeping"
  | "focusing"
  | "learning";

export interface PetActivitySnapshot {
  revision: number;
  activity: PetActivity;
  source: PetActivitySource;
  leaseId: string | null;
  resumableLearningSessionId: string | null;
  restoreTarget: PetRestoreTarget | null;
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
  | "mypet"
  | "today"
  | "taskwatch"
  | "focus"
  | "care"
  | "learning"
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
  leaseRevision: number;
  expiresAtUnixMs: number;
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

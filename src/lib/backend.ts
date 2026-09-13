import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettings,
  BackupInfo,
  BasicSupportPath,
  BasicSupportSession,
  SceneRestSession,
  CompanionExpressionSnapshot,
  CreateReminderInput,
  FocusState,
  HistoryQuery,
  Occurrence,
  PetCareSnapshot,
  PetActivitySnapshot,
  PetInteractionKind,
  Reminder,
  RuntimeCapabilities,
  TaskWatchSnapshot,
  TaskWatchSource,
  TaskWatchState,
  TodaySnapshot,
} from "../types";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEMO_BACKEND_EVENT_TYPE = "yuanyuan-demo-backend-event-v1";
const DEMO_BACKEND_CHANNEL = "yuanyuan-demo-backend-channel-v1";
const demoBackendOrigin =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `demo-${Date.now()}-${Math.random()}`;

interface DemoBackendEventEnvelope {
  origin: string;
  event: string;
  payload: unknown;
}

function isDemoBackendEventEnvelope(
  value: unknown,
): value is DemoBackendEventEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DemoBackendEventEnvelope>;
  return (
    typeof candidate.origin === "string" &&
    typeof candidate.event === "string" &&
    candidate.event.length > 0 &&
    candidate.event.length <= 80
  );
}

async function emitDemoBackendEvent(event: string, payload?: unknown) {
  if (typeof window === "undefined") return;
  const envelope: DemoBackendEventEnvelope = {
    origin: demoBackendOrigin,
    event,
    payload,
  };
  window.dispatchEvent(
    new CustomEvent<DemoBackendEventEnvelope>(DEMO_BACKEND_EVENT_TYPE, {
      detail: envelope,
    }),
  );
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(DEMO_BACKEND_CHANNEL);
  channel.postMessage(envelope);
  channel.close();
}

export type AiSupervisorStatus =
  | "unavailable"
  | "starting"
  | "running"
  | "backing_off"
  | "circuit_open"
  | "stopped";

export interface AiSupervisorDiagnostics {
  status: AiSupervisorStatus;
  binaryPresent: boolean;
  localDiagnosticsPresent: boolean;
  canRetry: boolean;
  controlProtocolVersion: number;
}

export interface DiagnosticExportResult {
  status: "saved" | "cancelled";
  fileName: string | null;
  bytes: number;
  schemaVersion: number;
  sensitiveFieldsIncluded: false;
  sensitiveScanStatus: "clean";
  sensitiveScanVersion: number;
  sensitiveScanChecks: number;
  selectedPathReturned: false;
  internalCopyCreated: false;
  automaticUpload: false;
}

export interface DiagnosticPreviewResult {
  schemaVersion: number;
  estimatedBytes: number;
  exportFileCount: 1;
  pendingFiles: number;
  pendingBytes: number;
  quarantinedFiles: number;
  diagnosticCodeCategories: number;
  diagnosticOccurrences: number;
  sensitiveFieldsIncluded: false;
  sensitiveScanStatus: "clean";
  sensitiveScanVersion: number;
  sensitiveScanChecks: number;
  selectedLocationRequired: true;
  internalCopyCreated: false;
  automaticUpload: false;
}

export interface DiagnosticClearResult {
  removedSnapshotFiles: number;
  removedCounterFiles: number;
}

export type ConnectorTrustAction =
  | "register"
  | "rotate"
  | "reset"
  | "reconnect";

export interface ConnectorTrustStatus {
  connectorId: string;
  configured: boolean;
  active: boolean;
  needsReconnect: boolean;
  rotationGraceActive: boolean;
  generation: number | null;
  sourceInstance: string | null;
  legacyIdentity: boolean;
  hookConfigurationChanged: false;
}

export interface ConnectorTrustPreview {
  confirmationToken: string;
  expiresInSeconds: number;
  action: ConnectorTrustAction;
  immediateRevocation: boolean;
  createsNewCredential: boolean;
  oldEventGraceSeconds: number;
  revokesAllLiveKeys: boolean;
  deletesObsoleteCredentials: boolean;
  sourceTaskBehaviorChanged: false;
  keyMaterialExposed: false;
  hookConfigurationChanged: false;
  sourceInstanceAssignedAfterConfirmation: boolean;
  connectorIdAssignedAfterConfirmation: boolean;
}

export type ConnectorKind = "codex" | "claude_code";
export type ConnectorInstallationChannel =
  | "windows_desktop_app"
  | "cli_on_path"
  | "native_user_install";

export interface ConnectorDiscoveryStatus {
  kind: ConnectorKind;
  installationState: "not_detected" | "detected";
  installationChannels: ConnectorInstallationChannel[];
  toolTrust: {
    status: "not_detected" | "verified" | "review_required" | "unavailable";
    reason:
      | "not_detected"
      | "official_distribution_verified"
      | "artifact_evidence_missing"
      | "conflicting_installations"
      | "unsupported_wrapper"
      | "unsafe_artifact"
      | "signature_invalid"
      | "publisher_mismatch"
      | "distribution_not_attested"
      | "package_identity_missing"
      | "package_identity_mismatch"
      | "manifest_evidence_missing"
      | "manifest_mismatch"
      | "distribution_verifier_unavailable"
      | "artifact_changed"
      | "verifier_unavailable";
    artifactsChecked: number;
    authenticodeChecked: boolean;
    authenticodeValid: boolean;
    publisherMatched: boolean;
    packageIdentityAttested: boolean;
    manifestAttested: boolean;
    sourceProcessesExecuted: false;
    networkAccessed: false;
    artifactPathReturned: false;
    certificateMaterialReturned: false;
  };
  compatibility: "limited";
  hookConfiguration: "unknown";
  eventHealth:
    | "not_observed"
    | "paused_authentication_failure"
    | "unavailable";
  authorizationProbe: "unconfigured" | "available" | "unavailable";
  trustedInstances: Array<{
    connectorId: string;
    sourceInstance: string;
    authorizationState: "active" | "reconnect_required";
    rotationGraceActive: boolean;
    generation: number;
    legacyIdentity: boolean;
  }>;
}

export interface ConnectorDiscoverySnapshot {
  connectors: ConnectorDiscoveryStatus[];
  privacy: {
    sourceProcessesExecuted: false;
    privateConfigurationRead: false;
    taskDataRead: false;
    hookConfigurationChanged: false;
  };
}

export type HookConfigInspectionAction =
  | "add_all"
  | "add_missing"
  | "no_change"
  | "manual_review";

export interface HookConfigSourcesPreview {
  tool: "codex" | "claude_code";
  conflict:
    | "none"
    | "parse_failure"
    | "source_tool_mismatch"
    | "codex_user_inline_hooks"
    | "codex_user_dual_representation"
    | "owned_outside_preferred_source"
    | "owned_across_multiple_sources"
    | "preferred_source_conflict";
  proposedAction: HookConfigInspectionAction;
  sourceFiles: number;
  parsedSources: number;
  sourcesWithHooks: number;
  sourcesWithOwnedHandlers: number;
  preferredSourcePresent: boolean;
  expectedHandlers: number;
  exactHandlers: number;
  missingHandlers: number;
  modifiedHandlers: number;
  duplicateHandlers: number;
  unexpectedOwnedHandlers: number;
  losslessEditSupported: boolean;
  configWritePerformed: false;
  sourceTaskBehaviorChanged: false;
}

export interface ConnectorHookConfigInspection {
  status: "checked" | "manual_review";
  preview: HookConfigSourcesPreview | null;
  privateConfigurationRead: boolean;
  projectConfigurationRead: false;
  taskDataRead: false;
  sourceProcessesExecuted: false;
  configWritePerformed: false;
  sourceTaskBehaviorChanged: false;
}

export interface ProjectInspectionAuthorizationPreview {
  confirmationToken: string;
  expiresInSeconds: number;
  tool: "codex" | "claude_code";
  projectDirectoryVerified: true;
  userHookConfigurationMayBeRead: true;
  projectHookConfigurationMayBeRead: true;
  taskDataRead: false;
  sourceProcessesExecuted: false;
  configWritePerformed: false;
  sourceTaskBehaviorChanged: false;
  selectedPathReturned: false;
  selectionPersisted: false;
}

export interface ProjectPickerResult {
  status: "cancelled" | "confirmation_required";
  preview: ProjectInspectionAuthorizationPreview | null;
  selectedPathReturned: false;
  selectionPersisted: false;
}

export interface ProjectInspectionResult {
  status: "checked" | "manual_review";
  preview: HookConfigSourcesPreview | null;
  projectDirectoryChecked: true;
  userConfigurationFilesRead: number;
  projectConfigurationFilesRead: number;
  privateConfigurationRead: boolean;
  projectConfigurationRead: boolean;
  taskDataRead: false;
  sourceProcessesExecuted: false;
  configWritePerformed: false;
  sourceTaskBehaviorChanged: false;
  selectedPathReturned: false;
  selectionPersisted: false;
}

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
      archivedAt: null,
      systemKind: "water",
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
      archivedAt: null,
      systemKind: null,
    },
    {
      id: "system-activity-reminder",
      title: "起来活动一下",
      category: "personal",
      scheduleKind: "interval",
      scheduleJson: JSON.stringify({ everyMinutes: 60 }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      enabled: false,
      nextDueAt: null,
      createdAt: demoAt(9, 0),
      updatedAt: demoAt(9, 0),
      archivedAt: null,
      systemKind: "activity",
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
      resolutionReason: null,
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
      resolutionReason: null,
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
      resolutionReason: null,
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
      resolutionReason: "manual",
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
      resolutionReason: "manual",
    },
  ],
  waterCompleted: 4,
  waterGoal: 9,
  notificationAvailable: false,
};

let demoSettings: AppSettings = {
  animationMode: "always",
  sceneWardrobeMode: "full",
  petProfile: { schemaVersion: 1, selectedPackId: "builtin:yuanyuan", nicknames: {} },
  companionIntensity: "everyday",
  companionLabelMode: "adaptive",
  animationSpeed: 1,
  cursorFollow: true,
  alwaysOnTop: true,
  clickThrough: false,
  learningQuickStartVisible: true,
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
  missedReminderPolicy: "notify",
  missedReminderGraceMinutes: 120,
};

let demoFocusState: FocusState = { session: null };
let demoBasicSupport: BasicSupportSession | null = null;
let demoSceneRest: SceneRestSession | null = null;
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

export async function getRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  const demoLearningAvailable = import.meta.env.DEV;
  return isTauri
    ? invoke<RuntimeCapabilities>("get_runtime_capabilities")
    : {
        schemaVersion: 1,
        learning: {
          compiled: demoLearningAvailable,
          available: demoLearningAvailable,
          contentPackReady: demoLearningAvailable,
          autoInvitationAvailable: false,
          failureReason: demoLearningAvailable ? null : "disabled",
        },
      };
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

function demoNextDue(input: CreateReminderInput, now = new Date()): string | null {
  if (input.scheduleKind === "once" && input.atLocal) {
    return new Date(input.atLocal).toISOString();
  }
  return new Date(
    now.getTime() + (input.everyMinutes ?? 60) * 60_000,
  ).toISOString();
}

function resolveDemoOccurrences(reminderId: string, reason: string) {
  const actedAt = new Date().toISOString();
  return demoSnapshot.occurrences.map((item) =>
    item.reminderId === reminderId &&
    ["pending", "overdue", "snoozed"].includes(item.status)
      ? {
          ...item,
          status: "skipped" as const,
          actedAt,
          snoozedUntil: null,
          resolutionReason: reason,
        }
      : item,
  );
}

export async function createReminder(input: CreateReminderInput): Promise<Reminder> {
  if (isTauri) {
    return invoke<Reminder>("create_reminder", { input });
  }
  const now = new Date();
  const reminder: Reminder = {
    id: crypto.randomUUID(),
    title: input.title,
    category: input.category,
    scheduleKind: input.scheduleKind,
    scheduleJson: JSON.stringify(input),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    enabled: true,
    nextDueAt: demoNextDue(input, now),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    archivedAt: null,
    systemKind: null,
  };
  demoSnapshot = {
    ...demoSnapshot,
    reminders: [...demoSnapshot.reminders, reminder],
  };
  return structuredClone(reminder);
}

export async function updateReminder(
  id: string,
  input: CreateReminderInput,
): Promise<Reminder> {
  if (isTauri) return invoke<Reminder>("update_reminder", { id, input });
  const current = demoSnapshot.reminders.find((item) => item.id === id);
  if (!current || current.archivedAt) throw new Error("reminder does not exist");
  if (current.systemKind) throw new Error("system reminders must be changed in settings");
  const updated: Reminder = {
    ...current,
    title: input.title,
    category: input.category,
    scheduleKind: input.scheduleKind,
    scheduleJson: JSON.stringify(input),
    nextDueAt: current.enabled ? demoNextDue(input) : null,
    updatedAt: new Date().toISOString(),
  };
  demoSnapshot = {
    ...demoSnapshot,
    reminders: demoSnapshot.reminders.map((item) =>
      item.id === id ? updated : item,
    ),
    occurrences: resolveDemoOccurrences(id, "reminder-edited"),
  };
  return structuredClone(updated);
}

export async function setReminderEnabled(
  id: string,
  enabled: boolean,
): Promise<Reminder> {
  if (isTauri) {
    return invoke<Reminder>("set_reminder_enabled", { id, enabled });
  }
  const current = demoSnapshot.reminders.find((item) => item.id === id);
  if (!current || current.archivedAt) throw new Error("reminder does not exist");
  if (current.systemKind) throw new Error("system reminders must be changed in settings");
  const input = JSON.parse(current.scheduleJson) as CreateReminderInput;
  const updated: Reminder = {
    ...current,
    enabled,
    nextDueAt: enabled ? demoNextDue(input) : null,
    updatedAt: new Date().toISOString(),
  };
  demoSnapshot = {
    ...demoSnapshot,
    reminders: demoSnapshot.reminders.map((item) =>
      item.id === id ? updated : item,
    ),
    occurrences: enabled
      ? demoSnapshot.occurrences
      : resolveDemoOccurrences(id, "reminder-disabled"),
  };
  return structuredClone(updated);
}

export async function deleteReminder(id: string): Promise<void> {
  if (isTauri) {
    await invoke("delete_reminder", { id });
    return;
  }
  const current = demoSnapshot.reminders.find((item) => item.id === id);
  if (!current || current.archivedAt) return;
  if (current.systemKind) throw new Error("system reminders cannot be deleted");
  const archivedAt = new Date().toISOString();
  demoSnapshot = {
    ...demoSnapshot,
    reminders: demoSnapshot.reminders.map((item) =>
      item.id === id
        ? { ...item, enabled: false, nextDueAt: null, archivedAt, updatedAt: archivedAt }
        : item,
    ),
    occurrences: resolveDemoOccurrences(id, "reminder-deleted"),
  };
}

export async function listBackups(): Promise<BackupInfo[]> {
  if (isTauri) return invoke<BackupInfo[]>("list_backups");
  return [];
}

export async function createBackup(): Promise<BackupInfo> {
  if (isTauri) return invoke<BackupInfo>("create_backup");
  const now = new Date();
  return {
    fileName: `manual-${now.toISOString().replace(/[:.]/g, "-")}.sqlite3`,
    createdAt: now.toISOString(),
    sizeBytes: 0,
    automatic: false,
    learningIncluded: false,
  };
}

export async function restoreBackup(fileName: string): Promise<void> {
  if (isTauri) {
    await invoke("restore_backup", { fileName });
  }
}

export const DELETE_ALL_LOCAL_DATA_CONFIRMATION = "删除圆圆全部本地数据";

export async function deleteAllLocalDataAndExit(
  confirmation: string,
  understandsNoRecovery: boolean,
): Promise<void> {
  if (!isTauri) {
    throw new Error("local data deletion is unavailable");
  }
  await invoke("delete_all_local_data_and_exit", {
    confirmation,
    understandsNoRecovery,
  });
}

export async function completeOccurrence(id: string): Promise<void> {
  if (isTauri) {
    await invoke("complete_occurrence", { id });
    return;
  }
  const now = new Date().toISOString();
  const category = demoSnapshot.occurrences.find((item) => item.id === id)?.category;
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
        resolutionReason: "manual",
      };
    }),
    waterCompleted,
  };
  if (category) {
    await emitDemoBackendEvent("pet-intent-resolved", {
      occurrenceId: id,
      category,
      action: "complete",
    });
  }
}

export async function snoozeOccurrence(id: string, minutes = 10): Promise<void> {
  if (isTauri) {
    await invoke("snooze_occurrence", { id, minutes });
    return;
  }
  const now = new Date();
  const category = demoSnapshot.occurrences.find((item) => item.id === id)?.category;
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
            resolutionReason: null,
          }
        : item,
    ),
  };
  if (category) {
    await emitDemoBackendEvent("pet-intent-resolved", {
      occurrenceId: id,
      category,
      action: "snooze",
    });
  }
}

export async function skipOccurrence(id: string): Promise<void> {
  if (isTauri) {
    await invoke("skip_occurrence", { id });
    return;
  }
  const now = new Date().toISOString();
  const category = demoSnapshot.occurrences.find((item) => item.id === id)?.category;
  demoSnapshot = {
    ...demoSnapshot,
    occurrences: demoSnapshot.occurrences.map((item) =>
      item.id === id && ["pending", "overdue", "snoozed"].includes(item.status)
        ? {
            ...item,
            status: "skipped",
            actedAt: now,
            snoozedUntil: null,
            resolutionReason: "manual",
          }
        : item,
    ),
  };
  if (category) {
    await emitDemoBackendEvent("pet-intent-resolved", {
      occurrenceId: id,
      category,
      action: "skip",
    });
  }
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
            resolutionReason: "manual",
          }
        : item,
    ),
  };
}

export async function getFocusState(): Promise<FocusState> {
  return isTauri ? invoke<FocusState>("get_focus_state") : demoFocusState;
}

export async function getCompanionExpressionSnapshot(): Promise<CompanionExpressionSnapshot> {
  if (isTauri) {
    return invoke<CompanionExpressionSnapshot>("get_companion_expression_snapshot");
  }
  return {
    schemaVersion: 2,
    revision: 0,
    tier: "n0",
    intent: "quiet_presence",
    pose: demoFocusState.session?.phase === "focus" ? "focus_calm" : "idle",
    props: [],
    label: null,
    attention: "silent",
    motion: demoSettings.animationMode === "off" ? "reduced" : "full",
    movePropForward: false,
    queueInBasket: false,
    taskSource: null,
    groupedCount: 1,
    focusDeferredCount: 0,
    sceneAppearance: demoFocusState.session?.phase === "focus"
      ? { kind: "work", stage: "fresh" }
      : { kind: "none" },
    accessibleState:
      demoFocusState.session?.phase === "focus"
        ? "focused_quietly"
        : "quiet_presence",
  };
}

export async function getPetActivitySnapshot(): Promise<PetActivitySnapshot> {
  if (isTauri) {
    return invoke<PetActivitySnapshot>("get_pet_activity_snapshot");
  }
  return {
    revision: 0,
    activity: demoFocusState.session?.phase === "focus" ? "focusing" : "idle",
    source: demoFocusState.session?.phase === "focus" ? "focus" : "schedule",
    leaseId: null,
    resumableLearningSessionId: null,
    restoreTarget: null,
  };
}

const demoTaskWatchDeferrals = new Map<string, number>();

function taskWatchDemoEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("taskWatchDemo") === "1"
  );
}

export async function getTaskWatchSnapshot(): Promise<TaskWatchSnapshot> {
  if (isTauri) return invoke<TaskWatchSnapshot>("get_task_watch_snapshot");
  if (taskWatchDemoEnabled()) {
    const now = Date.now();
    for (const [key, until] of demoTaskWatchDeferrals) {
      if (until <= now) demoTaskWatchDeferrals.delete(key);
    }
    const state = (
      source: TaskWatchSource,
      taskState: TaskWatchState,
      count: number,
    ) => ({
      source,
      state: taskState,
      count,
      deferredUntilUnixMs:
        demoTaskWatchDeferrals.get(`${source}-${taskState}`) ?? null,
    });
    return {
      schemaVersion: 2,
      available: true,
      observedCount: 8,
      needsUserCount: 2,
      states: [
        state("codex", "running", 3),
        state("codex", "waiting_user", 1),
        state("codex", "succeeded", 1),
        state("claude_code", "waiting_user", 1),
        state("claude_code", "stalled", 1),
        state("claude_code", "failed", 1),
      ],
    };
  }
  return {
    schemaVersion: 2,
    available: false,
    observedCount: 0,
    needsUserCount: 0,
    states: [],
  };
}

export async function deferTaskWatchAttention(
  source: TaskWatchSource,
  state: TaskWatchState,
  minutes = 10,
): Promise<TaskWatchSnapshot> {
  if (isTauri) {
    return invoke<TaskWatchSnapshot>("defer_task_watch_attention", {
      source,
      state,
      minutes,
    });
  }
  if (taskWatchDemoEnabled() && [10, 30, 60].includes(minutes)) {
    demoTaskWatchDeferrals.set(
      `${source}-${state}`,
      Date.now() + minutes * 60 * 1_000,
    );
    return getTaskWatchSnapshot();
  }
  throw new Error("task watch attention deferral is unavailable");
}

export async function resumeTaskWatchAttention(
  source: TaskWatchSource,
  state: TaskWatchState,
): Promise<TaskWatchSnapshot> {
  if (isTauri) {
    return invoke<TaskWatchSnapshot>("resume_task_watch_attention", {
      source,
      state,
    });
  }
  if (taskWatchDemoEnabled()) {
    demoTaskWatchDeferrals.delete(`${source}-${state}`);
    return getTaskWatchSnapshot();
  }
  throw new Error("task watch attention resume is unavailable");
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

export async function getBasicSupportState(): Promise<BasicSupportSession | null> {
  return isTauri
    ? invoke<BasicSupportSession | null>("get_basic_support_state")
    : structuredClone(demoBasicSupport);
}

export async function startBasicSupport(
  path: BasicSupportPath,
  durationMinutes: number,
): Promise<BasicSupportSession> {
  if (isTauri) {
    return invoke<BasicSupportSession>("start_basic_support", {
      path,
      durationMinutes,
    });
  }
  const startedAt = new Date();
  demoBasicSupport = {
    id: crypto.randomUUID(),
    path,
    durationMinutes,
    startedAt: startedAt.toISOString(),
    endsAt: new Date(startedAt.getTime() + durationMinutes * 60_000).toISOString(),
  };
  return structuredClone(demoBasicSupport);
}

export async function stopBasicSupport(): Promise<boolean> {
  if (isTauri) return invoke<boolean>("stop_basic_support");
  const stopped = demoBasicSupport !== null;
  demoBasicSupport = null;
  return stopped;
}

export async function getSceneRestState(): Promise<SceneRestSession | null> {
  return isTauri
    ? invoke<SceneRestSession | null>("get_scene_rest_state")
    : structuredClone(demoSceneRest);
}

export async function startSceneRest(
  durationMinutes: 5 | 10 | 20,
): Promise<SceneRestSession> {
  if (isTauri) {
    return invoke<SceneRestSession>("start_scene_rest", { durationMinutes });
  }
  const startedAt = new Date();
  demoSceneRest = {
    id: crypto.randomUUID(),
    durationMinutes,
    startedAt: startedAt.toISOString(),
    endsAt: new Date(startedAt.getTime() + durationMinutes * 60_000).toISOString(),
  };
  await emitDemoBackendEvent("scene-rest-updated", demoSceneRest);
  return structuredClone(demoSceneRest);
}

export async function stopSceneRest(): Promise<boolean> {
  if (isTauri) return invoke<boolean>("stop_scene_rest");
  const stopped = demoSceneRest !== null;
  demoSceneRest = null;
  await emitDemoBackendEvent("scene-rest-updated", null);
  return stopped;
}

let demoInteractionRevision = 0;
let demoInteractionId: string | null = null;

export async function finishPetInteraction(leaseId: string, leaseRevision: number): Promise<boolean> {
  if (isTauri) return invoke<boolean>("finish_pet_interaction", { leaseId, leaseRevision });
  if (demoInteractionId !== leaseId || demoInteractionRevision !== leaseRevision) return false;
  demoInteractionId = null;
  return true;
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
  demoInteractionId = crypto.randomUUID();
  demoInteractionRevision += 1;
  await emitDemoBackendEvent("pet-interaction-started", {
    id: demoInteractionId,
    kind,
    leaseRevision: demoInteractionRevision,
    expiresAtUnixMs: Date.now() + 30_000,
  });
  return demoCare;
}

export async function getSettings(): Promise<AppSettings> {
  return isTauri
    ? invoke<AppSettings>("get_settings")
    : structuredClone(demoSettings);
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (Object.hasOwn(patch, "petProfile")) throw new Error("请通过我的宠物页面修改宠物配置。");
  if (isTauri) return invoke<AppSettings>("update_settings", { patch });
  demoSettings = { ...demoSettings, ...patch };
  return structuredClone(demoSettings);
}

export async function getAiSupervisorStatus(): Promise<AiSupervisorStatus> {
  return isTauri
    ? invoke<AiSupervisorStatus>("get_ai_supervisor_status")
    : "unavailable";
}

export async function getAiSupervisorDiagnostics(): Promise<AiSupervisorDiagnostics> {
  return isTauri
    ? invoke<AiSupervisorDiagnostics>("get_ai_supervisor_diagnostics")
    : {
        status: "unavailable",
        binaryPresent: false,
        localDiagnosticsPresent: false,
        canRetry: false,
        controlProtocolVersion: 1,
      };
}

export async function previewAiDiagnostics(): Promise<DiagnosticPreviewResult> {
  if (!isTauri) throw new Error("diagnostic preview is unavailable");
  return invoke<DiagnosticPreviewResult>("preview_ai_diagnostics");
}

export async function exportAiDiagnostics(): Promise<DiagnosticExportResult> {
  if (!isTauri) throw new Error("diagnostic export is unavailable");
  return invoke<DiagnosticExportResult>("export_ai_diagnostics");
}

export async function clearAiDiagnostics(): Promise<DiagnosticClearResult> {
  if (!isTauri) throw new Error("diagnostic cleanup is unavailable");
  return invoke<DiagnosticClearResult>("clear_ai_diagnostics");
}

export async function retryAiAfterFailure(): Promise<boolean> {
  return isTauri ? invoke<boolean>("retry_ai_after_failure") : false;
}

export async function discoverBuiltinConnectors(): Promise<ConnectorDiscoverySnapshot> {
  if (isTauri) {
    return invoke<ConnectorDiscoverySnapshot>("discover_builtin_connectors");
  }
  return {
    connectors: (["codex", "claude_code"] as const).map((kind) => ({
      kind,
      installationState: "not_detected",
      installationChannels: [],
      toolTrust: {
        status: "not_detected",
        reason: "not_detected",
        artifactsChecked: 0,
        authenticodeChecked: false,
        authenticodeValid: false,
        publisherMatched: false,
        packageIdentityAttested: false,
        manifestAttested: false,
        sourceProcessesExecuted: false,
        networkAccessed: false,
        artifactPathReturned: false,
        certificateMaterialReturned: false,
      },
      compatibility: "limited",
      hookConfiguration: "unknown",
      eventHealth: "not_observed",
      authorizationProbe: "unconfigured",
      trustedInstances: [],
    })),
    privacy: {
      sourceProcessesExecuted: false,
      privateConfigurationRead: false,
      taskDataRead: false,
      hookConfigurationChanged: false,
    },
  };
}

export async function inspectConnectorHookConfig(
  connectorId: string,
  sourceInstance: string,
): Promise<ConnectorHookConfigInspection> {
  if (!isTauri) throw new Error("connector hook inspection is unavailable");
  return invoke<ConnectorHookConfigInspection>("inspect_connector_hook_config", {
    connectorId,
    sourceInstance,
  });
}

export async function selectProjectForHookInspection(
  connectorId: string,
  sourceInstance: string,
): Promise<ProjectPickerResult> {
  if (!isTauri) throw new Error("native project picker is unavailable");
  return invoke<ProjectPickerResult>("select_project_for_hook_inspection", {
    connectorId,
    sourceInstance,
  });
}

export async function applyProjectHookInspection(
  confirmationToken: string,
): Promise<ProjectInspectionResult> {
  if (!isTauri) throw new Error("project hook inspection is unavailable");
  return invoke<ProjectInspectionResult>("apply_project_hook_inspection", {
    confirmationToken,
  });
}

export async function cancelProjectHookInspection(confirmationToken: string): Promise<void> {
  if (isTauri) {
    await invoke("cancel_project_hook_inspection", { confirmationToken });
  }
}

export async function getConnectorTrustStatus(
  connectorId: string,
  sourceInstance: string,
): Promise<ConnectorTrustStatus> {
  if (isTauri) {
    return invoke<ConnectorTrustStatus>("get_connector_trust_status", {
      connectorId,
      sourceInstance,
    });
  }
  return {
    connectorId,
    configured: false,
    active: false,
    needsReconnect: false,
    rotationGraceActive: false,
    generation: null,
    sourceInstance,
    legacyIdentity: false,
    hookConfigurationChanged: false,
  };
}

export async function previewConnectorTrustChange(
  action: ConnectorTrustAction,
  connectorId: string,
  sourceInstance?: string,
): Promise<ConnectorTrustPreview> {
  if (!isTauri) throw new Error("connector trust preview is unavailable");
  return invoke<ConnectorTrustPreview>("preview_connector_trust_change", {
    action,
    connectorId,
    sourceInstance,
  });
}

export async function applyConnectorTrustChange(
  confirmationToken: string,
): Promise<ConnectorTrustStatus> {
  if (!isTauri) throw new Error("connector trust change is unavailable");
  return invoke<ConnectorTrustStatus>("apply_connector_trust_change", {
    confirmationToken,
  });
}

export async function showTaskPanel(route = "today"): Promise<void> {
  if (isTauri) await invoke("show_task_panel", { route });
}

export async function showPetWindow(): Promise<void> {
  if (isTauri) await invoke("show_pet_window");
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
  else await emitDemoBackendEvent("pet-request-sleep", { source: "manual" });
}

export async function requestWake(): Promise<void> {
  if (isTauri) await invoke("request_wake");
  else await emitDemoBackendEvent("pet-request-wake");
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
  if (isTauri) return listen<T>(event, ({ payload }) => callback(payload));
  if (typeof window === "undefined") return () => {};

  const forward = (envelope: DemoBackendEventEnvelope) => {
    if (envelope.event === event) callback(envelope.payload as T);
  };
  const handleWindowEvent = (rawEvent: Event) => {
    const envelope = (rawEvent as CustomEvent<unknown>).detail;
    if (isDemoBackendEventEnvelope(envelope)) forward(envelope);
  };
  window.addEventListener(DEMO_BACKEND_EVENT_TYPE, handleWindowEvent);

  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(DEMO_BACKEND_CHANNEL);
  if (channel) {
    channel.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (
        isDemoBackendEventEnvelope(data) &&
        data.origin !== demoBackendOrigin
      ) {
        forward(data);
      }
    };
  }

  return () => {
    window.removeEventListener(DEMO_BACKEND_EVENT_TYPE, handleWindowEvent);
    channel?.close();
  };
}

export function tauriAvailable(): boolean {
  return isTauri;
}

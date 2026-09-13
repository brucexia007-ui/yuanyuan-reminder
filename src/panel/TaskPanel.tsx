import { petText, getPetSnapshot } from "../pet/petProfile";
import { confirmAction } from "../lib/confirmation";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import {
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  completeOccurrence,
  cancelFocus,
  createBackup,
  createReminder,
  deferTaskWatchAttention,
  DELETE_ALL_LOCAL_DATA_CONFIRMATION,
  deleteAllLocalDataAndExit,
  deleteReminder,
  getBasicSupportState,
  getFocusState,
  getPetCare,
  getSceneRestState,
  getRuntimeCapabilities,
  getSettings,
  getTaskWatchSnapshot,
  listBackups,
  listHistory,
  listToday,
  onBackendEvent,
  pauseReminders,
  quitApplication,
  recordWater,
  requestSleep,
  requestWake,
  resumeTaskWatchAttention,
  restoreBackup,
  showPetWindow,
  setReminderEnabled,
  skipOccurrence,
  snoozeOccurrence,
  startBasicSupport,
  startFocus,
  startPetInteraction,
  startSceneRest,
  stopBasicSupport,
  stopSceneRest,
  tauriAvailable,
  updateReminder,
  updateSettings,
} from "../lib/backend";
import type {
  AppSettings,
  BackupInfo,
  BasicSupportPath,
  BasicSupportSession,
  CreateReminderInput,
  FocusState,
  Occurrence,
  PanelRoute,
  PetCareSnapshot,
  PetInteractionKind,
  Reminder,
  ReminderCategory,
  SceneRestSession,
  ScheduleKind,
  TaskWatchSnapshot,
  TaskWatchSource,
  TaskWatchState,
  TodaySnapshot,
} from "../types";
import { loadDashboard, type DashboardModule } from "./dashboardLoader";
import { learningBuildEnabled } from "../learning/featureGate";
import { AiCompanionStatusCard } from "./AiCompanionStatus";
import { ConnectorDiscoveryStatusCard } from "./ConnectorDiscoveryStatus";
import { plannedDueLabel, plannedReminders } from "./todayReminders";
import "./panel.css";
import { MyPetPage } from "./MyPetPage";
import { usePetProfile } from "../pet/petProfile";

type Tab = PanelRoute;

const LazyLearningView = learningBuildEnabled
  ? lazy(() => import("../learning/LearningView").then((module) => ({ default: module.LearningView })))
  : null;

const emptySnapshot: TodaySnapshot = {
  reminders: [],
  occurrences: [],
  waterCompleted: 0,
  waterGoal: 8,
  notificationAvailable: false,
};

const fallbackSettings: AppSettings = {
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

const emptyFocusState: FocusState = { session: null };
const emptyCareSnapshot: PetCareSnapshot = {
  total: 0,
  food: 0,
  water: 0,
  treat: 0,
  wand: 0,
  pet: 0,
  ball: 0,
  lastInteractionAt: null,
};

const emptyTaskWatchSnapshot: TaskWatchSnapshot = {
  schemaVersion: 2,
  available: false,
  observedCount: 0,
  needsUserCount: 0,
  states: [],
};

const initialModuleState: Record<DashboardModule, boolean> = {
  today: true,
  settings: true,
  focus: true,
  care: true,
};

const initialModuleErrors: Record<DashboardModule, string | null> = {
  today: null,
  settings: null,
  focus: null,
  care: null,
};

export function TaskPanel() {
  usePetProfile();
  const panelWindow = useMemo(
    () => (tauriAvailable() ? getCurrentWindow() : null),
    [],
  );
  const startPanelDrag = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || !panelWindow) return;
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("button, input, select, textarea, a, [role='button']")
      ) {
        return;
      }
      void panelWindow.startDragging().catch(() => undefined);
    },
    [panelWindow],
  );
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return requested && ["today", "taskwatch", "focus", "care", "history", "manage", "add", "settings", "mypet"].includes(requested)
      ? (requested as Tab)
      : "today";
  });
  const [snapshot, setSnapshot] = useState<TodaySnapshot>(emptySnapshot);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [focusState, setFocusState] = useState<FocusState>(emptyFocusState);
  const [care, setCare] = useState<PetCareSnapshot>(emptyCareSnapshot);
  const [taskWatch, setTaskWatch] = useState<TaskWatchSnapshot>(emptyTaskWatchSnapshot);
  const [taskWatchLoading, setTaskWatchLoading] = useState(true);
  const [taskWatchError, setTaskWatchError] = useState<string | null>(null);
  const [learningAvailable, setLearningAvailable] = useState(false);
  const [moduleLoading, setModuleLoading] = useState(initialModuleState);
  const [moduleErrors, setModuleErrors] = useState(initialModuleErrors);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshToday = useCallback(async () => {
    setModuleLoading((current) => ({ ...current, today: true }));
    try {
      setSnapshot(await listToday());
      setModuleErrors((current) => ({ ...current, today: null }));
    } catch (error) {
      setModuleErrors((current) => ({ ...current, today: String(error) }));
    } finally {
      setModuleLoading((current) => ({ ...current, today: false }));
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    setModuleLoading((current) => ({ ...current, settings: true }));
    try {
      setSettings(await getSettings());
      setModuleErrors((current) => ({ ...current, settings: null }));
    } catch (error) {
      setModuleErrors((current) => ({ ...current, settings: String(error) }));
    } finally {
      setModuleLoading((current) => ({ ...current, settings: false }));
    }
  }, []);

  const refreshFocus = useCallback(async () => {
    setModuleLoading((current) => ({ ...current, focus: true }));
    try {
      setFocusState(await getFocusState());
      setModuleErrors((current) => ({ ...current, focus: null }));
    } catch (error) {
      setModuleErrors((current) => ({ ...current, focus: String(error) }));
    } finally {
      setModuleLoading((current) => ({ ...current, focus: false }));
    }
  }, []);

  const refreshCare = useCallback(async () => {
    setModuleLoading((current) => ({ ...current, care: true }));
    try {
      setCare(await getPetCare());
      setModuleErrors((current) => ({ ...current, care: null }));
    } catch (error) {
      setModuleErrors((current) => ({ ...current, care: String(error) }));
    } finally {
      setModuleLoading((current) => ({ ...current, care: false }));
    }
  }, []);

  const refreshTaskWatch = useCallback(async () => {
    setTaskWatchLoading(true);
    try {
      setTaskWatch(await getTaskWatchSnapshot());
      setTaskWatchError(null);
    } catch (error) {
      setTaskWatchError(String(error));
    } finally {
      setTaskWatchLoading(false);
    }
  }, []);

  const deferTaskWatch = useCallback(
    async (source: TaskWatchSource, state: TaskWatchState) => {
      try {
        setTaskWatch(await deferTaskWatchAttention(source, state, 10));
        setTaskWatchError(null);
        setNotice(petText("已暂停{pet}对这组状态的主动提示 10 分钟，任务仍保留在守望台。"));
      } catch {
        setNotice("暂时没能暂停主动提示，来源任务没有受到影响。");
      }
    },
    [],
  );

  const resumeTaskWatch = useCallback(
    async (source: TaskWatchSource, state: TaskWatchState) => {
      try {
        setTaskWatch(await resumeTaskWatchAttention(source, state));
        setTaskWatchError(null);
        setNotice(petText("{pet}会重新留意这组状态。"));
      } catch {
        setNotice("暂时没能恢复主动提示，来源任务没有受到影响。");
      }
    },
    [],
  );

  const refreshAll = useCallback(async () => {
    setModuleLoading(initialModuleState);
    const [result, watchResult] = await Promise.all([
      loadDashboard({
        today: listToday,
        settings: getSettings,
        focus: getFocusState,
        care: getPetCare,
      }),
      getTaskWatchSnapshot().then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error: String(error) }),
      ),
    ]);
    if (result.today.ok) setSnapshot(result.today.value);
    if (result.settings.ok) setSettings(result.settings.value);
    if (result.focus.ok) setFocusState(result.focus.value);
    if (result.care.ok) setCare(result.care.value);
    setModuleErrors({
      today: result.today.ok ? null : result.today.error,
      settings: result.settings.ok ? null : result.settings.error,
      focus: result.focus.ok ? null : result.focus.error,
      care: result.care.ok ? null : result.care.error,
    });
    setModuleLoading({ today: false, settings: false, focus: false, care: false });
    if (watchResult.ok) {
      setTaskWatch(watchResult.value);
      setTaskWatchError(null);
    } else {
      setTaskWatchError(watchResult.error);
    }
    setTaskWatchLoading(false);
  }, []);

  const refresh = refreshToday;

  useEffect(() => {
    if (!learningBuildEnabled) return;
    let cancelled = false;
    void getRuntimeCapabilities()
      .then((capabilities) => {
        if (cancelled) return;
        const available = capabilities.learning.available;
        setLearningAvailable(available);
        const requested = new URLSearchParams(window.location.search).get("tab");
        if (available && requested === "learning") setTab("learning");
      })
      .catch(() => {
        if (!cancelled) setLearningAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshAll();
    const cleanups: Array<() => void> = [];
    void Promise.all([
      onBackendEvent<void>("occurrence-updated", refreshToday),
      onBackendEvent<void>("reminder-due", refreshToday),
      onBackendEvent<void>("reminders-updated", refreshToday),
      onBackendEvent<AppSettings>("settings-updated", (value) => {
        setSettings(value);
        setModuleErrors((current) => ({ ...current, settings: null }));
      }),
      onBackendEvent<FocusState>("focus-updated", (value) => {
        setFocusState(value);
        setModuleErrors((current) => ({ ...current, focus: null }));
      }),
      onBackendEvent<PetCareSnapshot>("pet-care-updated", (value) => {
        setCare(value);
        setModuleErrors((current) => ({ ...current, care: null }));
      }),
      onBackendEvent<{ route: Tab }>("panel-route", ({ route }) => {
        if (route !== "learning" || learningAvailable) setTab(route);
      }),
    ]).then((unlisten) => cleanups.push(...unlisten));

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && tab !== "learning") void panelWindow?.hide();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      cleanups.forEach((cleanup) => cleanup());
      window.removeEventListener("keydown", keydown);
    };
  }, [learningAvailable, panelWindow, refreshAll, refreshToday, tab]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const scheduleNextLocalDay = () => {
      const now = new Date();
      const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        1,
      );
      timer = window.setTimeout(() => {
        void Promise.all([refreshToday(), refreshCare()]).finally(() => {
          if (!cancelled) scheduleNextLocalDay();
        });
      }, Math.max(1_000, next.getTime() - now.getTime()));
    };
    scheduleNextLocalDay();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [refreshCare, refreshToday]);

  useEffect(() => {
    if (tab === "taskwatch") void refreshTaskWatch();
  }, [refreshTaskWatch, tab]);

  useEffect(() => {
    void (async () => {
      try {
        if (!(await isPermissionGranted())) await requestPermission();
      } catch {
        // The Rust backend also emits an in-app due state when OS notifications are unavailable.
      }
    })();
  }, []);

  const saveSetting = async (patch: Partial<AppSettings>) => {
    try {
      const next = await updateSettings(patch);
      setSettings(next);
    } catch (error) {
      setNotice(`设置保存失败：${String(error)}`);
    }
  };

  const activeModule: DashboardModule | null =
    tab === "today" || tab === "manage"
      ? "today"
      : tab === "focus"
        ? "focus"
        : tab === "care"
          ? "care"
          : tab === "settings"
            ? "settings"
            : null;
  const retryActiveModule =
    activeModule === "today"
      ? refreshToday
      : activeModule === "focus"
        ? refreshFocus
        : activeModule === "care"
          ? refreshCare
          : refreshSettings;

  return (
    <main className="panel-shell">
      <header
        className="panel-header"
        aria-label="拖动功能框"
        onMouseDown={startPanelDrag}
      >
        <div>
          <p className="eyebrow">YUANYUAN REMINDER</p>
          <h1>
            {tab === "today"
              ? "今天"
              : tab === "taskwatch"
                ? "任务守望"
              : tab === "focus"
                ? "专注"
              : tab === "care"
                  ? petText("陪{pet}")
                  : tab === "learning"
                    ? "英语复习"
                  : tab === "history"
                    ? "历史记录"
                    : tab === "manage"
                      ? "提醒管理"
                : tab === "mypet" ? "我的宠物" : tab === "add"
                  ? "新提醒"
                  : "设置"}
          </h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="隐藏任务面板"
          onClick={() => void panelWindow?.hide()}
        >
          ×
        </button>
      </header>

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      )}

      <nav
        className={`segmented ${taskWatch.available ? "has-task-watch" : ""} ${learningAvailable ? "has-learning" : ""}`}
        aria-label="圆圆提醒页面"
      >
        <TabButton active={tab === "today"} onClick={() => setTab("today")}>
          今日
        </TabButton>
        {taskWatch.available && (
          <TabButton active={tab === "taskwatch"} onClick={() => setTab("taskwatch")}>
            守望
          </TabButton>
        )}
        <TabButton active={tab === "focus"} onClick={() => setTab("focus")}>
          专注
        </TabButton>
        <TabButton active={tab === "care"} onClick={() => setTab("care")}>
          互动
        </TabButton>
        {learningAvailable && (
          <TabButton active={tab === "learning"} onClick={() => setTab("learning")}>
            学习
          </TabButton>
        )}
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>
          历史
        </TabButton>
        <TabButton active={tab === "manage"} onClick={() => setTab("manage")}>
          管理
        </TabButton>
        <TabButton active={tab === "add"} onClick={() => setTab("add")}>
          新建
        </TabButton>
        <TabButton active={tab === "settings" || tab === "mypet"} onClick={() => setTab("settings")}>
          设置
        </TabButton>
      </nav>

      <section className="panel-content">
        {activeModule && moduleLoading[activeModule] ? (
          <div className="empty-state">{petText("{pet}正在整理今天的安排…")}</div>
        ) : activeModule && moduleErrors[activeModule] ? (
          <ModuleLoadError
            module={activeModule}
            error={moduleErrors[activeModule]!}
            onRetry={retryActiveModule}
          />
        ) : tab === "mypet" ? <MyPetPage settings={settings} onBack={() => setTab("settings")} /> : tab === "taskwatch" ? (
          taskWatchLoading ? (
            <div className="empty-state">{petText("{pet}正在看看任务牌…")}</div>
          ) : taskWatchError ? (
            <div className="empty-state module-error" role="alert">
              <strong>任务守望台暂时未能读取</strong>
              <span>来源任务不会受影响，也不会自动重试或修改来源配置。</span>
              <button
                className="primary compact"
                type="button"
                onClick={() => void refreshTaskWatch()}
              >
                重新查看
              </button>
            </div>
          ) : (
            <TaskWatchView
              snapshot={taskWatch}
              onRefresh={refreshTaskWatch}
              onDefer={deferTaskWatch}
              onResume={resumeTaskWatch}
            />
          )
        ) : tab === "today" ? (
          <TodayView snapshot={snapshot} refresh={refresh} setTab={setTab} />
        ) : tab === "focus" ? (
          <FocusView
            focusState={focusState}
            onState={setFocusState}
            onNotice={setNotice}
          />
        ) : tab === "care" ? (
          <CareView
            care={care}
            focusActive={focusState.session?.phase === "focus"}
            onCare={setCare}
            onNotice={setNotice}
            onInteractiveStarted={() => void panelWindow?.hide()}
          />
        ) : tab === "learning" && learningAvailable && LazyLearningView ? (
          <Suspense fallback={<div className="empty-state">{petText("{pet}正在取复习卡…")}</div>}>
            <LazyLearningView />
          </Suspense>
        ) : tab === "history" ? (
          <HistoryView />
        ) : tab === "manage" ? (
          <ManageView
            reminders={snapshot.reminders}
            settings={settings}
            onRefresh={refreshToday}
            onNotice={setNotice}
            onOpenSettings={() => setTab("settings")}
          />
        ) : tab === "add" ? (
          <AddView
            onSaved={async () => {
              await refresh();
              setTab("today");
              setNotice(petText("提醒已交给{pet}。"));
            }}
          />
        ) : (
          <SettingsView
            onOpenMyPet={() => setTab("mypet")}
            settings={settings}
            onChange={saveSetting}
            onNotice={setNotice}
          />
        )}
      </section>
    </main>
  );
}

const taskWatchSourceLabels = {
  codex: "Codex",
  claude_code: "Claude Code",
} as const;

const taskWatchStateLabels = {
  queued: "排队中",
  running: "守望中",
  waiting_user: "需要你",
  succeeded: "已完成",
  failed: "没成功",
  cancelled: "已收起",
  stalled: "可能停住",
  unknown: "状态不明",
} as const;

export function TaskWatchView({
  snapshot,
  onRefresh,
  onDefer,
  onResume,
}: {
  snapshot: TaskWatchSnapshot;
  onRefresh: () => Promise<void>;
  onDefer: (source: TaskWatchSource, state: TaskWatchState) => Promise<void>;
  onResume: (source: TaskWatchSource, state: TaskWatchState) => Promise<void>;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const deferrableStates = new Set<TaskWatchState>([
    "running",
    "waiting_user",
    "failed",
    "stalled",
    "unknown",
  ]);
  const runAttentionAction = async (
    source: TaskWatchSource,
    state: TaskWatchState,
    deferred: boolean,
  ) => {
    const key = `${source}-${state}`;
    setBusyKey(key);
    try {
      await (deferred ? onResume(source, state) : onDefer(source, state));
    } finally {
      setBusyKey(null);
    }
  };
  return (
    <div className="task-watch-stack">
      <section className="task-watch-overview" aria-labelledby="task-watch-title">
        <div>
          <p className="card-kicker">只看状态，不看正文</p>
          <h2 id="task-watch-title">{petText("{pet}的任务守望台")}</h2>
          <p>
            这里只显示来源、固定状态和数量，不显示任务标题、项目路径、任务标识或精确活动时间。
          </p>
          <p>{petText("“稍后提醒”只暂停{pet}的主动提示，任务会一直保留在这里。")}</p>
        </div>
        <button className="secondary compact" type="button" onClick={() => void onRefresh()}>
          重新查看
        </button>
      </section>

      {!snapshot.available ? (
        <div className="empty-state">{petText("还没有可信任务状态。{pet}不会自行修改 Codex 或 Claude Code 的配置。")}</div>
      ) : snapshot.states.length === 0 ? (
        <div className="empty-state">目前没有最近24小时内可守望的任务。</div>
      ) : (
        <section aria-labelledby="task-watch-states-title">
          <div className="section-heading task-watch-heading">
            <h2 id="task-watch-states-title">最近状态</h2>
            <span>
              共 {snapshot.observedCount} 项
              {snapshot.needsUserCount > 0 ? `，${snapshot.needsUserCount} 项需要你` : ""}
            </span>
          </div>
          <ul className="task-watch-list">
            {snapshot.states.map((item) => {
              const key = `${item.source}-${item.state}`;
              const deferred = item.deferredUntilUnixMs !== null;
              return (
                <li
                  key={key}
                  className={`task-watch-state state-${item.state}`}
                  aria-label={`${taskWatchSourceLabels[item.source]}，${taskWatchStateLabels[item.state]}，${item.count}项${deferred ? "，已暂缓主动提醒" : ""}`}
                >
                  <span className="task-watch-source">{taskWatchSourceLabels[item.source]}</span>
                  <strong>{taskWatchStateLabels[item.state]}</strong>
                  <b>{item.count}</b>
                  {deferrableStates.has(item.state) && (
                    <div className="task-watch-attention-action">
                      {deferred && <span>已暂缓主动提醒</span>}
                      <button
                        type="button"
                        disabled={busyKey !== null}
                        aria-label={`${deferred ? "恢复" : "10 分钟后再"}提醒 ${taskWatchSourceLabels[item.source]} ${taskWatchStateLabels[item.state]}这组状态`}
                        onClick={() =>
                          void runAttentionAction(item.source, item.state, deferred)
                        }
                      >
                        {busyKey === key
                          ? "处理中…"
                          : deferred
                            ? "恢复提醒"
                            : "10 分钟后再提醒"}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function ModuleLoadError({
  module,
  error,
  onRetry,
}: {
  module: DashboardModule;
  error: string;
  onRetry: () => Promise<void>;
}) {
  const label = {
    today: "今日提醒",
    settings: "设置",
    focus: "专注计时",
    care: "互动记录",
  }[module];
  return (
    <div className="empty-state module-error" role="alert">
      <strong>{label}暂时未能加载</strong>
      <span>{error}</span>
      <button className="primary compact" type="button" onClick={() => void onRetry()}>
        重新读取
      </button>
    </div>
  );
}

const careActions: Array<{
  kind: PetInteractionKind;
  icon: string;
  title: string;
  description: string;
  interactive?: boolean;
}> = [
  {
    kind: "food",
    icon: "🍚",
    title: "喂猫粮",
    get description() { return petText("{pet}会走近小碗，低头慢慢吃。"); },
  },
  {
    kind: "water",
    icon: "💧",
    title: "喂水",
    get description() { return petText("让{pet}伏下来，认真舔几口水。"); },
  },
  {
    kind: "treat",
    icon: "🥣",
    title: "喂猫条",
    get description() { return petText("到桌面拖动猫条，{pet}会追着吃并站起来。"); },
    interactive: true,
  },
  {
    kind: "wand",
    icon: "🪶",
    title: "逗猫棒",
    get description() { return petText("按住并移动逗猫棒，{pet}会随着距离和停留时间伸爪追逐。"); },
    interactive: true,
  },
  {
    kind: "pet",
    icon: "🤍",
    get title() { return petText("摸摸{pet}"); },
    get description() { return petText("把鼠标靠近{pet}，它会转头蹭你的手。"); },
    interactive: true,
  },
  {
    kind: "ball",
    icon: "🔴",
    title: "扔球游戏",
    get description() { return petText("按住球蓄力，松手后{pet}会把球捡回来。"); },
    interactive: true,
  },
];

const basicSupportDetails: Record<
  BasicSupportPath,
  { title: string; description: string; durations: number[] }
> = {
  stay_close: {
    title: "只陪我一会",
    get description() { return petText("{pet}安静靠近，不追问"); },
    durations: [2, 5, 10],
  },
  move_together: {
    title: "陪我动一动",
    get description() { return petText("{pet}先伸懒腰，不计分"); },
    durations: [1, 3, 5, 10],
  },
  give_space: {
    title: "先别管我",
    get description() { return petText("{pet}退开，不再主动回看"); },
    durations: [5, 15, 30, 60],
  },
};

function CareView({
  care,
  focusActive,
  onCare,
  onNotice,
  onInteractiveStarted,
}: {
  care: PetCareSnapshot;
  focusActive: boolean;
  onCare: (care: PetCareSnapshot) => void;
  onNotice: (notice: string) => void;
  onInteractiveStarted: () => void;
}) {
  const [working, setWorking] = useState<PetInteractionKind | null>(null);
  const [support, setSupport] = useState<BasicSupportSession | null>(null);
  const [supportChooserOpen, setSupportChooserOpen] = useState(false);
  const [selectedSupport, setSelectedSupport] =
    useState<BasicSupportPath | null>(null);
  const [supportDuration, setSupportDuration] = useState(5);
  const [supportWorking, setSupportWorking] = useState(false);
  const [supportNow, setSupportNow] = useState(Date.now());
  const [sceneRest, setSceneRest] = useState<SceneRestSession | null>(null);
  const [sceneRestWorking, setSceneRestWorking] = useState(false);
  const [sceneRestNow, setSceneRestNow] = useState(Date.now());
  const supportOpenButtonRef = useRef<HTMLButtonElement>(null);
  const firstSupportPathRef = useRef<HTMLButtonElement>(null);
  const supportEndButtonRef = useRef<HTMLButtonElement>(null);
  const supportFocusRequest = useRef<"chooser" | "end" | "open" | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    void getBasicSupportState().then((session) => {
      if (!disposed) setSupport(session);
    });
    void onBackendEvent<BasicSupportSession | null>(
      "basic-support-updated",
      (session) => setSupport(session),
    ).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten = () => {};
    void getSceneRestState().then((session) => {
      if (!disposed) setSceneRest(session);
    });
    void onBackendEvent<SceneRestSession | null>(
      "scene-rest-updated",
      (session) => setSceneRest(session),
    ).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten();
    };
  }, []);

  useEffect(() => {
    if (!support) return;
    setSupportNow(Date.now());
    const timer = window.setInterval(() => setSupportNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [support]);

  useEffect(() => {
    if (!sceneRest) return;
    setSceneRestNow(Date.now());
    const timer = window.setInterval(() => setSceneRestNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [sceneRest]);

  useEffect(() => {
    const request = supportFocusRequest.current;
    const target =
      request === "chooser"
        ? firstSupportPathRef.current
        : request === "end"
          ? supportEndButtonRef.current
          : request === "open"
            ? supportOpenButtonRef.current
            : null;
    if (!target) return;
    target.focus();
    supportFocusRequest.current = null;
  });

  const chooseSupport = (path: BasicSupportPath) => {
    setSelectedSupport(path);
    setSupportDuration(basicSupportDetails[path].durations[0]);
  };

  const beginSupport = async () => {
    if (!selectedSupport) return;
    if (focusActive) {
      onNotice(petText("请先结束当前专注计时，再让{pet}陪你一会。"));
      return;
    }
    setSupportWorking(true);
    supportFocusRequest.current = "end";
    try {
      setSupport(await startBasicSupport(selectedSupport, supportDuration));
      setSupportChooserOpen(false);
      setSelectedSupport(null);
    } catch (error) {
      supportFocusRequest.current = null;
      onNotice(String(error));
    } finally {
      setSupportWorking(false);
    }
  };

  const endSupport = async () => {
    setSupportWorking(true);
    supportFocusRequest.current = "open";
    try {
      await stopBasicSupport();
      setSupport(null);
    } catch (error) {
      supportFocusRequest.current = null;
      onNotice(String(error));
    } finally {
      setSupportWorking(false);
    }
  };

  const begin = async (
    kind: PetInteractionKind,
    interactive: boolean,
  ) => {
    setWorking(kind);
    try {
      onCare(await startPetInteraction(kind));
      if (interactive) {
        onNotice(
          kind === "treat"
            ? petText("猫条已经出现在{pet}身边：按住它上下移动。")
            : kind === "wand"
              ? petText("按住并移动逗猫棒，{pet}会跟着伸爪；停留片刻也会继续追逐。")
              : kind === "pet"
                ? petText("把鼠标移到{pet}头上轻轻移动，它会朝你的方向蹭一蹭。")
                : petText("球已经放在{pet}脚边：按住鼠标左键蓄力，松手扔出。"),
        );
        onInteractiveStarted();
      }
    } catch (error) {
      onNotice(String(error));
    } finally {
      setWorking(null);
    }
  };

  const beginSceneRest = async (minutes: 5 | 10 | 20) => {
    if (focusActive) {
      onNotice("专注进行中，结束后再开始水疗休息。计时不会被改动。");
      return;
    }
    setSceneRestWorking(true);
    try {
      setSceneRest(await startSceneRest(minutes));
      onNotice(`${getPetSnapshot().nickname}开始休息 ${minutes} 分钟。`);
    } catch (error) {
      onNotice(String(error));
    } finally {
      setSceneRestWorking(false);
    }
  };

  const endSceneRest = async () => {
    setSceneRestWorking(true);
    try {
      await stopSceneRest();
      setSceneRest(null);
    } catch (error) {
      onNotice(String(error));
    } finally {
      setSceneRestWorking(false);
    }
  };

  return (
    <div className="care-view stack">
      <article className={`care-summary ${focusActive ? "focus-locked" : ""}`}>
        <div className="care-heart">♡</div>
        <div>
          <p className="card-kicker">今日陪伴</p>
          <h2>{focusActive ? petText("{pet}正在陪你专注") : `已经互动 ${care.total} 次`}</h2>
          <p>
            {focusActive
              ? "可以发起短互动，结束后会按最新工作状态继续陪伴，专注计时不中断。"
              : "这些记录不会变成惩罚式养成，想陪它时再来就好。"}
          </p>
        </div>
      </article>

      <section className="scene-rest-card" aria-labelledby="scene-rest-title">
        <div>
          <p className="card-kicker">只保存在本次运行中</p>
          <h2 id="scene-rest-title">休息一下</h2>
          <p>{petText("让{pet}泡一会水疗；提醒或短互动只会临时遮挡，结束后继续。")}</p>
        </div>
        {sceneRest ? (
          <div className="scene-rest-active" role="status" aria-live="polite">
            <span>
              还剩约 {Math.max(0, Math.ceil((new Date(sceneRest.endsAt).getTime() - sceneRestNow) / 60_000))} 分钟
            </span>
            <button
              type="button"
              disabled={sceneRestWorking}
              onClick={() => void endSceneRest()}
            >
              提前结束
            </button>
          </div>
        ) : (
          <div className="duration-buttons" aria-label="选择休息时长">
            {([5, 10, 20] as const).map((minutes) => (
              <button
                type="button"
                key={minutes}
                disabled={focusActive || sceneRestWorking}
                onClick={() => void beginSceneRest(minutes)}
              >
                {minutes} 分钟
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="basic-support-card" aria-labelledby="basic-support-title">
        <div className="basic-support-heading">
          <div>
            <p className="card-kicker">由你主动开始</p>
            <h2 id="basic-support-title">陪陪我</h2>
            <p>不判断你的情绪，不调用模型，也不保存原因。</p>
          </div>
          <span aria-hidden="true">◌</span>
        </div>

        {support ? (
          <div className="basic-support-active">
            <div role="status" aria-live="polite">
              <strong>{basicSupportDetails[support.path].title}</strong>
              <span>{basicSupportDetails[support.path].description}</span>
            </div>
            <time dateTime={support.endsAt}>
              {Math.max(
                0,
                Math.ceil((new Date(support.endsAt).getTime() - supportNow) / 60_000),
              )} 分钟内
            </time>
            <button
              ref={supportEndButtonRef}
              type="button"
              disabled={supportWorking}
              onClick={() => void endSupport()}
            >
              结束本次陪伴
            </button>
          </div>
        ) : !supportChooserOpen ? (
          <button
            ref={supportOpenButtonRef}
            className="basic-support-open"
            type="button"
            disabled={focusActive}
            onClick={() => {
              supportFocusRequest.current = "chooser";
              setSupportChooserOpen(true);
            }}
          >
            {focusActive ? "专注结束后可以使用" : "打开三张陪伴小牌"}
          </button>
        ) : (
          <div className="basic-support-chooser">
            <div className="basic-support-paths" aria-label="选择陪伴方式">
              {(Object.keys(basicSupportDetails) as BasicSupportPath[]).map((path, index) => (
                <button
                  ref={index === 0 ? firstSupportPathRef : undefined}
                  type="button"
                  key={path}
                  aria-pressed={selectedSupport === path}
                  onClick={() => chooseSupport(path)}
                >
                  <strong>{basicSupportDetails[path].title}</strong>
                  <span>{basicSupportDetails[path].description}</span>
                </button>
              ))}
            </div>
            {selectedSupport && (
              <div className="basic-support-duration">
                <span>这次持续</span>
                <div aria-label="选择陪伴时长">
                  {basicSupportDetails[selectedSupport].durations.map((minutes) => (
                    <button
                      type="button"
                      key={minutes}
                      aria-pressed={supportDuration === minutes}
                      onClick={() => setSupportDuration(minutes)}
                    >
                      {minutes} 分钟
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="basic-support-actions">
              <button
                type="button"
                onClick={() => {
                  supportFocusRequest.current = "open";
                  setSupportChooserOpen(false);
                  setSelectedSupport(null);
                }}
              >
                取消
              </button>
              <button
                className="primary"
                type="button"
                disabled={!selectedSupport || supportWorking}
                onClick={() => void beginSupport()}
              >
                开始
              </button>
            </div>
          </div>
        )}
        <p className="basic-support-boundary">
          本次状态只在内存中运行；关闭应用即结束，不形成心情记录或连续打卡。
        </p>
      </section>

      <div className="care-grid">
        {careActions.map((action) => (
          <button
            className="care-action"
            type="button"
            disabled={working !== null}
            key={action.kind}
            onClick={() => void begin(action.kind, Boolean(action.interactive))}
          >
            <span className="care-icon" aria-hidden="true">
              {action.icon}
            </span>
            <span>
              <strong>{action.title}</strong>
              <small>{action.description}</small>
            </span>
            <em>{care[action.kind]}</em>
          </button>
        ))}
      </div>

      <div className="care-tip">
        <strong>互动优先级</strong>
        <span>到点提醒会优先；专注中可短暂互动，结束后自动恢复且计时持续。</span>
      </div>
    </div>
  );
}

function FocusView({
  focusState,
  onState,
  onNotice,
}: {
  focusState: FocusState;
  onState: (state: FocusState) => void;
  onNotice: (notice: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const [working, setWorking] = useState(false);
  const session = focusState.session;

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [session]);

  const remainingSeconds = session
    ? Math.max(0, Math.ceil((new Date(session.endsAt).getTime() - now) / 1000))
    : 0;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  const progress = session
    ? Math.max(
        0,
        Math.min(
          100,
          (remainingSeconds / Math.max(1, session.durationMinutes * 60)) * 100,
        ),
      )
    : 0;

  const begin = async (phase: "focus" | "break", duration: number) => {
    setWorking(true);
    try {
      onState(await startFocus(phase, duration));
      setNow(Date.now());
      onNotice(
        phase === "focus"
          ? `${getPetSnapshot().nickname}开始陪你专注 ${duration} 分钟。`
          : `${getPetSnapshot().nickname}开始陪你休息 ${duration} 分钟。`,
      );
    } finally {
      setWorking(false);
    }
  };

  if (session) {
    return (
      <div className="focus-active">
        <div
          className={`focus-clock ${session.phase}`}
          style={{ "--focus-progress": `${progress}%` } as React.CSSProperties}
        >
          <div>
            <strong>
              {String(minutes).padStart(2, "0")}:{String(seconds).padStart(2, "0")}
            </strong>
            <span>{session.phase === "focus" ? "专注中" : "休息中"}</span>
          </div>
        </div>
        <h2>
          {session.phase === "focus"
            ? petText("{pet}正在认真陪你工作")
            : petText("先放松一下，{pet}替你看着时间")}
        </h2>
        <p>
          {remainingSeconds > 0
            ? petText("隐藏面板也不会中断计时，结束时{pet}会用动作提醒你。")
            : petText("时间到了，{pet}正在准备结束动作…")}
        </p>
        <button
          className="secondary large"
          type="button"
          disabled={working}
          onClick={async () => {
            setWorking(true);
            try {
              onState(await cancelFocus());
              onNotice("本轮计时已停止。");
            } finally {
              setWorking(false);
            }
          }}
        >
          停止本轮
        </button>
      </div>
    );
  }

  return (
    <div className="focus-setup stack">
      <article className="focus-choice focus-work">
        <p className="card-kicker">专注工作</p>
        <h2>{petText("让{pet}陪你进入状态")}</h2>
        <p>{petText("进行中{pet}会乖乖坐着或趴着，结束后再伸懒腰提醒休息。")}</p>
        <div className="duration-buttons">
          {[25, 45, 60].map((duration) => (
            <button
              className="primary compact"
              type="button"
              disabled={working}
              key={duration}
              onClick={() => void begin("focus", duration)}
            >
              {duration} 分钟
            </button>
          ))}
        </div>
      </article>
      <article className="focus-choice focus-break">
        <p className="card-kicker">定时休息</p>
        <h2>离开屏幕活动一下</h2>
        <p>
          开始后自动锁定 Windows；结束时点亮屏幕并提醒你，解锁仍需密码或
          Windows Hello。
        </p>
        <div className="duration-buttons">
          {[5, 10].map((duration) => (
            <button
              type="button"
              disabled={working}
              key={duration}
              onClick={() => void begin("break", duration)}
            >
              {duration} 分钟
            </button>
          ))}
        </div>
      </article>
    </div>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "active" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TodayView({
  snapshot,
  refresh,
  setTab,
}: {
  snapshot: TodaySnapshot;
  refresh: () => Promise<void>;
  setTab: (tab: Tab) => void;
}) {
  const percent = Math.min(
    100,
    Math.round((snapshot.waterCompleted / Math.max(1, snapshot.waterGoal)) * 100),
  );
  const pending = snapshot.occurrences.filter((item) =>
    ["pending", "overdue", "snoozed"].includes(item.status),
  );
  const planned = plannedReminders(snapshot.reminders, snapshot.occurrences);

  return (
    <div className="stack">
      <article className="water-card">
        <div className="water-orb" style={{ "--progress": `${percent}%` } as React.CSSProperties}>
          <span>{snapshot.waterCompleted}</span>
          <small>/{snapshot.waterGoal}</small>
        </div>
        <div>
          <p className="card-kicker">今日喝水</p>
          <h2>{percent >= 100 ? "目标完成啦" : petText("让{pet}陪你补点水")}</h2>
          <button
            className="primary compact"
            type="button"
            onClick={async () => {
              await recordWater();
              await refresh();
            }}
          >
            ＋ 记录一杯
          </button>
        </div>
      </article>

      <div className="section-heading">
        <h2>待处理</h2>
        <button type="button" onClick={() => setTab("add")}>
          ＋ 新建
        </button>
      </div>

      {pending.length === 0 && planned.length === 0 ? (
        <div className="empty-state">
          <span className="empty-dot" />
          今天暂时没有待处理事项。
        </div>
      ) : (
        <div className="task-list">
          {pending.map((occurrence) => (
            <OccurrenceCard key={occurrence.id} occurrence={occurrence} refresh={refresh} />
          ))}
          {planned.map((reminder) => (
            <PlannedReminderCard key={reminder.id} reminder={reminder} />
          ))}
        </div>
      )}
    </div>
  );
}

type HistoryStatusFilter = "all" | "completed" | "skipped";
type HistoryCategoryFilter = "all" | ReminderCategory;
type HistoryDaysFilter = 7 | 30 | 90 | "all";

function HistoryView() {
  const [days, setDays] = useState<HistoryDaysFilter>(30);
  const [status, setStatus] = useState<HistoryStatusFilter>("all");
  const [category, setCategory] = useState<HistoryCategoryFilter>("all");
  const [query, setQuery] = useState("");
  const [records, setRecords] = useState<Occurrence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onBackendEvent<void>("occurrence-updated", () => {
      setRevision((value) => value + 1);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        setError(null);
        void listHistory({
          days: days === "all" ? null : days,
          status: status === "all" ? null : status,
          category: category === "all" ? null : category,
          query: query.trim() || null,
          limit: 200,
        })
          .then((result) => {
            if (active) setRecords(result);
          })
          .catch((reason) => {
            if (active) setError(`历史记录读取失败：${String(reason)}`);
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query.trim() ? 180 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [category, days, query, revision, status]);

  const groups = useMemo(() => {
    const grouped = new Map<string, Occurrence[]>();
    records.forEach((record) => {
      const timestamp = new Date(record.actedAt ?? record.scheduledAt);
      const key = [
        timestamp.getFullYear(),
        String(timestamp.getMonth() + 1).padStart(2, "0"),
        String(timestamp.getDate()).padStart(2, "0"),
      ].join("-");
      const items = grouped.get(key) ?? [];
      items.push(record);
      grouped.set(key, items);
    });
    return Array.from(grouped.entries());
  }, [records]);

  const completed = records.filter((record) => record.status === "completed").length;
  const skipped = records.filter((record) => record.status === "skipped").length;

  return (
    <div className="history-view stack">
      <article className="history-summary">
        <div>
          <p className="card-kicker">处理记录</p>
          <h2>{loading ? petText("{pet}正在翻记录…") : `查询到 ${records.length} 项`}</h2>
          <p>完成和跳过的提醒都会留在这里，不影响下一次提醒。</p>
        </div>
        <div className="history-counts" aria-label="历史记录统计">
          <span className="completed">✓ 完成 {completed}</span>
          <span className="skipped">跳过 {skipped}</span>
        </div>
      </article>

      <div className="history-filters" aria-label="筛选历史记录">
        <label className="history-search">
          <span>搜索事项</span>
          <input
            type="search"
            maxLength={120}
            placeholder="输入提醒名称"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          <span>时间</span>
          <select
            value={String(days)}
            onChange={(event) =>
              setDays(
                event.target.value === "all"
                  ? "all"
                  : (Number(event.target.value) as 7 | 30 | 90),
              )
            }
          >
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
            <option value="90">近 90 天</option>
            <option value="all">全部时间</option>
          </select>
        </label>
        <label>
          <span>结果</span>
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as HistoryStatusFilter)
            }
          >
            <option value="all">全部结果</option>
            <option value="completed">已完成</option>
            <option value="skipped">已跳过</option>
          </select>
        </label>
        <label>
          <span>类型</span>
          <select
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as HistoryCategoryFilter)
            }
          >
            <option value="all">全部类型</option>
            <option value="work">工作</option>
            <option value="personal">生活</option>
            <option value="water">喝水</option>
            <option value="meal">用餐</option>
          </select>
        </label>
      </div>

      {error ? (
        <div className="empty-state history-error">{error}</div>
      ) : loading && records.length === 0 ? (
        <div className="empty-state">{petText("{pet}正在整理历史记录…")}</div>
      ) : groups.length === 0 ? (
        <div className="empty-state">
          <span className="empty-dot" />
          没有找到符合条件的记录。
        </div>
      ) : (
        <div className="history-groups">
          {groups.map(([day, items]) => (
            <section className="history-day" key={day}>
              <div className="history-day-heading">
                <h2>{historyDayLabel(day)}</h2>
                <span>{items.length} 项</span>
              </div>
              <div className="history-list">
                {items.map((record) => (
                  <HistoryRecordCard key={record.id} record={record} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {!loading && records.length >= 200 && (
        <p className="history-limit">当前最多显示最近 200 条，可缩小筛选范围继续查询。</p>
      )}
    </div>
  );
}

function HistoryRecordCard({ record }: { record: Occurrence }) {
  const actedAt = new Date(record.actedAt ?? record.scheduledAt);
  const scheduledAt = new Date(record.scheduledAt);
  const completed = record.status === "completed";
  const activity = record.reminderId === "system-activity-reminder";
  const category =
    activity
      ? "活动"
      : record.category === "work"
      ? "工作"
      : record.category === "personal"
        ? "生活"
        : record.category === "meal"
          ? "用餐"
          : "喝水";
  const resultLabel = completed
    ? "已完成"
    : record.resolutionReason === "missed"
      ? "过期自动跳过"
      : record.resolutionReason === "reminder-edited"
        ? "编辑提醒时归档"
        : record.resolutionReason === "reminder-disabled"
          ? "暂停提醒时归档"
          : record.resolutionReason === "reminder-deleted"
            ? "删除提醒时归档"
            : "已跳过";
  return (
    <article className={`history-card ${completed ? "completed" : "skipped"}`}>
      <div className="history-result" aria-hidden="true">
        {completed ? "✓" : "—"}
      </div>
      <div className="history-main">
        <div className="history-title-row">
          <span
            className={`category-dot ${
              activity ? "activity" : record.category
            }`}
          />
          <h3>{record.reminderTitle}</h3>
        </div>
        <p>
          {resultLabel} · {category} ·{" "}
          {actedAt.toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>
      <time dateTime={record.scheduledAt}>
        原定{" "}
        {scheduledAt.toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
        })}
      </time>
    </article>
  );
}

function historyDayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const value = new Date(year, month - 1, date);
  const today = new Date();
  const todayStart = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const dayStart = new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const difference = Math.round(
    (todayStart.getTime() - dayStart.getTime()) / (24 * 60 * 60 * 1000),
  );
  if (difference === 0) return "今天";
  if (difference === 1) return "昨天";
  return value.toLocaleDateString("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

function PlannedReminderCard({ reminder }: { reminder: Reminder }) {
  const due = plannedDueLabel(reminder.nextDueAt!);
  const cadence =
    reminder.scheduleKind === "once"
      ? "单次提醒"
      : reminder.scheduleKind === "daily"
        ? "每天提醒"
        : reminder.scheduleKind === "weekly"
          ? "工作日提醒"
          : "间隔提醒";

  return (
    <article className="task-card status-planned">
      <div className="task-time planned-time">
        <strong>{due.time}</strong>
        <span>{due.date}</span>
      </div>
      <div className="task-main">
        <div className="task-title-row">
          <span className={`category-dot ${reminder.category}`} />
          <h3>{reminder.title}</h3>
        </div>
        <p>{cadence}{petText("· 已交给{pet}")}</p>
        <span className="planned-badge">等待提醒</span>
      </div>
    </article>
  );
}

function OccurrenceCard({
  occurrence,
  refresh,
}: {
  occurrence: Occurrence;
  refresh: () => Promise<void>;
}) {
  const due = new Date(occurrence.snoozedUntil ?? occurrence.scheduledAt);
  const activity = occurrence.reminderId === "system-activity-reminder";
  const [snoozeMinutes, setSnoozeMinutes] = useState(10);
  return (
    <article className={`task-card status-${occurrence.status}`}>
      <div className="task-time">
        {due.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
      </div>
      <div className="task-main">
        <div className="task-title-row">
          <span
            className={`category-dot ${
              activity ? "activity" : occurrence.category
            }`}
          />
          <h3>{occurrence.reminderTitle}</h3>
        </div>
        <p>
          {activity
            ? "连续使用电脑后提醒活动"
            : occurrence.status === "overdue"
            ? "已经到时间了"
            : occurrence.status === "snoozed"
              ? "已稍后提醒"
              : "等待处理"}
        </p>
        <div className="task-actions">
          <button
            className="primary compact"
            type="button"
            onClick={async () => {
              await completeOccurrence(occurrence.id);
              await refresh();
            }}
          >
            {activity ? "活动完成" : "完成"}
          </button>
          <label className="snooze-control">
            <span className="sr-only">稍后提醒时长</span>
            <select
              value={snoozeMinutes}
              onChange={(event) => setSnoozeMinutes(Number(event.target.value))}
            >
              {[5, 10, 30, 60].map((minutes) => (
                <option key={minutes} value={minutes}>{minutes} 分钟</option>
              ))}
            </select>
            <button
              type="button"
              onClick={async () => {
                await snoozeOccurrence(occurrence.id, snoozeMinutes);
                await refresh();
              }}
            >
              稍后
            </button>
          </label>
          <button
            type="button"
            onClick={async () => {
              await skipOccurrence(occurrence.id);
              await refresh();
            }}
          >
            跳过
          </button>
        </div>
      </div>
    </article>
  );
}

function ManageView({
  reminders,
  settings,
  onRefresh,
  onNotice,
  onOpenSettings,
}: {
  reminders: Reminder[];
  settings: AppSettings;
  onRefresh: () => Promise<void>;
  onNotice: (notice: string) => void;
  onOpenSettings: () => void;
}) {
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const visible = reminders.filter((reminder) => !reminder.archivedAt);

  if (editing) {
    return (
      <div className="stack">
        <div className="section-heading manage-edit-heading">
          <div>
            <p className="card-kicker">编辑提醒</p>
            <h2>{editing.title}</h2>
          </div>
          <button type="button" onClick={() => setEditing(null)}>取消</button>
        </div>
        <AddView
          key={editing.id}
          reminder={editing}
          onSaved={async () => {
            await onRefresh();
            setEditing(null);
            onNotice("提醒修改已生效，旧的待处理实例已自动归档。");
          }}
        />
      </div>
    );
  }

  return (
    <div className="stack manage-list">
      <div className="manage-intro">
        <strong>全部提醒</strong>
        <span>普通提醒可以编辑、暂停或删除；喝水与活动提醒在设置中管理。</span>
      </div>
      {visible.map((reminder) => {
        const system = reminder.systemKind !== null;
        const effectiveEnabled =
          reminder.systemKind === "activity" ? settings.activityEnabled : reminder.enabled;
        return (
          <article className={`manage-card ${effectiveEnabled ? "enabled" : "disabled"}`} key={reminder.id}>
            <div className="manage-card-main">
              <div className="task-title-row">
                <span className={`category-dot ${reminder.systemKind === "activity" ? "activity" : reminder.category}`} />
                <h3>{reminder.title}</h3>
                {system && <span className="system-badge">系统</span>}
              </div>
              <p>{reminderScheduleLabel(reminder, settings)} · {effectiveEnabled ? "已启用" : "已暂停"}</p>
            </div>
            <div className="manage-actions">
              {system ? (
                <button type="button" onClick={onOpenSettings}>前往设置</button>
              ) : (
                <>
                  <button type="button" onClick={() => setEditing(reminder)}>编辑</button>
                  <button
                    type="button"
                    disabled={workingId === reminder.id}
                    onClick={async () => {
                      setWorkingId(reminder.id);
                      try {
                        await setReminderEnabled(reminder.id, !reminder.enabled);
                        await onRefresh();
                      } catch (error) {
                        onNotice(`操作失败：${String(error)}`);
                      } finally {
                        setWorkingId(null);
                      }
                    }}
                  >
                    {reminder.enabled ? "暂停" : "启用"}
                  </button>
                  <button
                    className="danger-text"
                    type="button"
                    disabled={workingId === reminder.id}
                    onClick={async () => {
                      setWorkingId(reminder.id);
                      try {
                        if (!(await confirmAction(`确定删除“${reminder.title}”吗？历史记录仍会保留。`))) return;
                        await deleteReminder(reminder.id);
                        await onRefresh();
                        onNotice("提醒已删除，已有历史记录仍然保留。");
                      } catch (error) {
                        onNotice(`删除失败：${String(error)}`);
                      } finally {
                        setWorkingId(null);
                      }
                    }}
                  >
                    删除
                  </button>
                </>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function reminderScheduleLabel(reminder: Reminder, settings?: AppSettings): string {
  let input: Partial<CreateReminderInput> = {};
  try {
    input = JSON.parse(reminder.scheduleJson) as CreateReminderInput;
  } catch {
    return "时间配置待修复";
  }
  if (reminder.systemKind === "activity" && settings) {
    return `每 ${settings.activityIntervalMinutes} 分钟 · ${settings.activityStart}–${settings.activityEnd}`;
  }
  if (reminder.systemKind === "water" && settings) {
    return `每 ${settings.waterIntervalMinutes} 分钟 · ${settings.waterStart}–${settings.waterEnd}`;
  }
  if (reminder.scheduleKind === "once") {
    if (!input.atLocal) return "单次提醒";
    const date = new Date(input.atLocal);
    return Number.isNaN(date.getTime())
      ? `单次 · ${input.atLocal}`
      : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (reminder.scheduleKind === "interval") {
    return `每 ${input.everyMinutes ?? 60} 分钟 · ${input.activeStartLocal ?? "09:00"}–${input.activeEndLocal ?? "18:00"}`;
  }
  const time = input.atLocal?.slice(-5) ?? "--:--";
  return reminder.scheduleKind === "daily" ? `每天 ${time}` : `每周指定日期 ${time}`;
}

function defaultReminderDateTime() {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function normalizeReminderDateTime(value?: string | null) {
  if (!value) return defaultReminderDateTime();
  if (/^\d{2}:\d{2}$/.test(value)) {
    return `${defaultReminderDateTime().slice(0, 10)}T${value}`;
  }
  return value;
}

function parseReminderSchedule(reminder?: Reminder): Partial<CreateReminderInput> {
  if (!reminder) return {};
  try {
    return JSON.parse(reminder.scheduleJson) as CreateReminderInput;
  } catch {
    return {};
  }
}

function AddView({
  onSaved,
  reminder,
}: {
  onSaved: () => Promise<void>;
  reminder?: Reminder;
}) {
  const initial = parseReminderSchedule(reminder);
  const [title, setTitle] = useState(reminder?.title ?? "");
  const [category, setCategory] = useState<ReminderCategory>(reminder?.category ?? "work");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(reminder?.scheduleKind ?? "once");
  const [atLocal, setAtLocal] = useState(normalizeReminderDateTime(initial.atLocal));
  const [everyMinutes, setEveryMinutes] = useState(initial.everyMinutes ?? 60);
  const [activeStartLocal, setActiveStartLocal] = useState(initial.activeStartLocal ?? "09:00");
  const [activeEndLocal, setActiveEndLocal] = useState(initial.activeEndLocal ?? "18:00");
  const [weekdays, setWeekdays] = useState(initial.weekdays ?? [1, 2, 3, 4, 5]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    if (scheduleKind !== "once" && weekdays.length === 0) {
      setError("请至少选择一天。");
      return;
    }
    setSaving(true);
    setError(null);
    const input: CreateReminderInput = {
      title: title.trim(),
      category,
      scheduleKind,
      atLocal,
      everyMinutes,
      activeStartLocal,
      activeEndLocal,
      weekdays,
    };
    try {
      if (reminder) await updateReminder(reminder.id, input);
      else await createReminder(input);
      await onSaved();
    } catch (submitError) {
      setError(String(submitError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="form-stack" onSubmit={submit}>
      <label>
        <span>提醒内容</span>
        <input
          autoFocus
          maxLength={120}
          placeholder="例如：整理今天的工作总结"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        <span>类型</span>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as ReminderCategory)}
        >
          <option value="work">工作</option>
          <option value="personal">生活</option>
          <option value="water">喝水</option>
          <option value="meal">用餐</option>
        </select>
      </label>
      <label>
        <span>重复方式</span>
        <select
          value={scheduleKind}
          onChange={(event) => setScheduleKind(event.target.value as ScheduleKind)}
        >
          <option value="once">仅一次</option>
          <option value="daily">每天</option>
          <option value="weekly">工作日</option>
          <option value="interval">按间隔</option>
        </select>
      </label>
      {scheduleKind === "interval" ? (
        <>
          <label>
            <span>提醒间隔</span>
            <select
              value={everyMinutes}
              onChange={(event) => setEveryMinutes(Number(event.target.value))}
            >
              {[15, 30, 45, 60, 90, 120, 180, 240].map((minutes) => (
                <option key={minutes} value={minutes}>每 {minutes} 分钟</option>
              ))}
            </select>
          </label>
          <div className="form-field">
            <span>生效时段</span>
            <div className="time-pair">
              <input type="time" value={activeStartLocal} onChange={(event) => setActiveStartLocal(event.target.value)} />
              <span>至</span>
              <input type="time" value={activeEndLocal} onChange={(event) => setActiveEndLocal(event.target.value)} />
            </div>
          </div>
        </>
      ) : (
        <label>
          <span>{scheduleKind === "once" ? "日期和时间" : "首次时间"}</span>
          <input
            type="datetime-local"
            value={atLocal}
            onChange={(event) => setAtLocal(event.target.value)}
          />
        </label>
      )}
      {scheduleKind !== "once" && (
        <fieldset className="weekday-field">
          <legend>重复日期</legend>
          <div className="weekday-buttons">
            {["日", "一", "二", "三", "四", "五", "六"].map((label, day) => (
              <button
                className={weekdays.includes(day) ? "active" : ""}
                type="button"
                key={day}
                aria-pressed={weekdays.includes(day)}
                onClick={() => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort())}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <button className="primary large" type="submit" disabled={saving || !title.trim()}>
        {saving ? "正在保存…" : reminder ? "保存修改" : petText("交给{pet}提醒")}
      </button>
    </form>
  );
}

function SettingsView({
  onOpenMyPet,
  settings,
  onChange,
  onNotice,
}: {
  onOpenMyPet: () => void;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => Promise<void>;
  onNotice: (notice: string) => void;
}) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupWorking, setBackupWorking] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteNoRecovery, setDeleteNoRecovery] = useState(false);
  const [deleteWorking, setDeleteWorking] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteConfirmationId = useId();
  const deleteNoRecoveryId = useId();
  const deleteReady =
    tauriAvailable() &&
    deleteConfirmation === DELETE_ALL_LOCAL_DATA_CONFIRMATION &&
    deleteNoRecovery;

  const refreshBackups = useCallback(async () => {
    setBackupLoading(true);
    try {
      setBackups(await listBackups());
      setBackupError(null);
    } catch (error) {
      setBackupError(String(error));
    } finally {
      setBackupLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshBackups();
  }, [refreshBackups]);

  return (
    <div className="settings-list">
      <button type="button" className="my-pet-entry" onClick={onOpenMyPet}><strong>我的宠物</strong><span>修改昵称、导入和切换形象 →</span></button>
      <SettingRow title={petText("{pet}动画")} description="不受 Windows 动画关闭影响">
        <select
          value={settings.animationMode}
          onChange={(event) =>
            void onChange({
              animationMode: event.target.value as AppSettings["animationMode"],
            })
          }
        >
          <option value="always">始终播放</option>
          <option value="system">跟随系统</option>
          <option value="off">关闭动画</option>
        </select>
      </SettingRow>
      <SettingRow
        title="情境装扮"
        description="资源不可用时会自动回到原有动作，不影响提醒"
      >
        <select
          value={settings.sceneWardrobeMode}
          onChange={(event) =>
            void onChange({
              sceneWardrobeMode: event.target
                .value as AppSettings["sceneWardrobeMode"],
            })
          }
        >
          <option value="full">全部情境</option>
          <option value="reminders_only">仅用餐与补水</option>
          <option value="off">关闭装扮</option>
        </select>
      </SettingRow>
      <SettingRow
        title="陪伴亲密度"
        description={petText("只控制{pet}主动靠近或庆祝，不影响你设置的提醒")}
      >
        <select
          value={settings.companionIntensity}
          onChange={(event) =>
            void onChange({
              companionIntensity: event.target
                .value as AppSettings["companionIntensity"],
            })
          }
        >
          <option value="quiet">安静陪伴（不主动打扰）</option>
          <option value="everyday">日常陪伴（每天最多 3 次）</option>
          <option value="close">亲密陪伴（每天最多 6 次）</option>
        </select>
      </SettingRow>
      <SettingRow
        title="道具标签"
        description={petText("文字只贴在任务牌等工具上，不会变成{pet}的对白")}
      >
        <select
          value={settings.companionLabelMode}
          onChange={(event) =>
            void onChange({
              companionLabelMode: event.target
                .value as AppSettings["companionLabelMode"],
            })
          }
        >
          <option value="motion_only">纯动作</option>
          <option value="adaptive">需要时显示</option>
          <option value="always">始终显示</option>
        </select>
      </SettingRow>
      <SettingRow title="动画速度" description="调节所有动作的播放节奏">
        <select
          value={settings.animationSpeed}
          onChange={(event) =>
            void onChange({ animationSpeed: Number(event.target.value) })
          }
        >
          {[0.6, 0.8, 1, 1.25, 1.5].map((speed) => (
            <option key={speed} value={speed}>
              {speed}×{speed === 1.25 ? " · 轻快" : ""}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="看向鼠标" description={petText("只在{pet}空闲时工作")}>
        <Toggle
          checked={settings.cursorFollow}
          onChange={(checked) => void onChange({ cursorFollow: checked })}
        />
      </SettingRow>
      <SettingRow title="总在最前" description={petText("让{pet}保持在其他窗口上方")}>
        <Toggle
          checked={settings.alwaysOnTop}
          onChange={(checked) => void onChange({ alwaysOnTop: checked })}
        />
      </SettingRow>
      <SettingRow title="鼠标穿透" description="开启后从托盘恢复交互">
        <Toggle
          checked={settings.clickThrough}
          onChange={(checked) => void onChange({ clickThrough: checked })}
        />
      </SettingRow>
      <SettingRow title="安静时段" description={petText("{pet}会进入睡眠")}>
        <div className="time-pair">
          <input
            type="time"
            aria-label="安静时段开始"
            value={settings.quietStart}
            onChange={(event) => void onChange({ quietStart: event.target.value })}
          />
          <span>至</span>
          <input
            type="time"
            aria-label="安静时段结束"
            value={settings.quietEnd}
            onChange={(event) => void onChange({ quietEnd: event.target.value })}
          />
        </div>
      </SettingRow>
      <SettingRow title="闲置入睡" description="无系统输入后自动睡觉">
        <select
          value={settings.idleSleepMinutes}
          onChange={(event) =>
            void onChange({ idleSleepMinutes: Number(event.target.value) })
          }
        >
          {[5, 10, 20, 30, 60].map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} 分钟
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="喝水时段" description="仅在这个时间范围内提醒">
        <div className="time-pair">
          <input
            type="time"
            aria-label="喝水时段开始"
            value={settings.waterStart}
            onChange={(event) => void onChange({ waterStart: event.target.value })}
          />
          <span>至</span>
          <input
            type="time"
            aria-label="喝水时段结束"
            value={settings.waterEnd}
            onChange={(event) => void onChange({ waterEnd: event.target.value })}
          />
        </div>
      </SettingRow>
      <SettingRow title="喝水间隔" description="保存后同步到默认喝水计划">
        <select
          value={settings.waterIntervalMinutes}
          onChange={(event) =>
            void onChange({ waterIntervalMinutes: Number(event.target.value) })
          }
        >
          {[20, 30, 45, 60, 90, 120].map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} 分钟
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        title="活动提醒"
        description="连续使用电脑达到设定时长后提醒"
      >
        <Toggle
          checked={settings.activityEnabled}
          onChange={(checked) => void onChange({ activityEnabled: checked })}
        />
      </SettingRow>
      <SettingRow title="活动时段" description="只在这个时间范围内累计使用时长">
        <div className="time-pair">
          <input
            type="time"
            aria-label="活动时段开始"
            disabled={!settings.activityEnabled}
            value={settings.activityStart}
            onChange={(event) =>
              void onChange({ activityStart: event.target.value })
            }
          />
          <span>至</span>
          <input
            type="time"
            aria-label="活动时段结束"
            disabled={!settings.activityEnabled}
            value={settings.activityEnd}
            onChange={(event) =>
              void onChange({ activityEnd: event.target.value })
            }
          />
        </div>
      </SettingRow>
      <SettingRow
        title="活动间隔"
        description="静止 5 分钟暂停，离开 10 分钟重新累计"
      >
        <select
          disabled={!settings.activityEnabled}
          value={settings.activityIntervalMinutes}
          onChange={(event) =>
            void onChange({
              activityIntervalMinutes: Number(event.target.value),
            })
          }
        >
          {[20, 30, 45, 60, 90, 120].map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} 分钟
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        title="错过提醒"
        description="电脑关机或休眠后，对已经过去很久的事项如何处理"
      >
        <select
          value={settings.missedReminderPolicy}
          onChange={(event) =>
            void onChange({
              missedReminderPolicy: event.target.value as AppSettings["missedReminderPolicy"],
            })
          }
        >
          <option value="notify">恢复后仍提醒</option>
          <option value="skipOld">自动归入已跳过</option>
        </select>
      </SettingRow>
      {settings.missedReminderPolicy === "skipOld" && (
        <SettingRow
          title="过期宽限"
          description="超过这段时间才视为错过，并在历史中标记原因"
        >
          <select
            value={settings.missedReminderGraceMinutes}
            onChange={(event) =>
              void onChange({ missedReminderGraceMinutes: Number(event.target.value) })
            }
          >
            {[15, 30, 60, 120, 240].map((minutes) => (
              <option key={minutes} value={minutes}>{minutes} 分钟</option>
            ))}
          </select>
        </SettingRow>
      )}
      <SettingRow title="开机启动" description="登录 Windows 后自动陪伴">
        <Toggle
          checked={settings.autostart}
          onChange={(checked) => void onChange({ autostart: checked })}
        />
      </SettingRow>
      <AiCompanionStatusCard onNotice={onNotice} />
      <ConnectorDiscoveryStatusCard />
      <section className="backup-section">
        <div className="backup-heading">
          <div>
            <strong>数据备份</strong>
            <small>统一备份提醒、设置及已创建的学习数据；每天启动时自动备份，自动备份保留最近 14 份，恢复前还会再保存当前数据。</small>
          </div>
          <button
            className="primary compact"
            type="button"
            disabled={backupWorking}
            onClick={async () => {
              setBackupWorking(true);
              try {
                await createBackup();
                await refreshBackups();
                onNotice("手动备份已创建。");
              } catch (error) {
                setBackupError(String(error));
              } finally {
                setBackupWorking(false);
              }
            }}
          >
            立即备份
          </button>
        </div>
        {backupError ? (
          <div className="backup-error" role="alert">
            <span>{backupError}</span>
            <button type="button" onClick={() => void refreshBackups()}>重试</button>
          </div>
        ) : backupLoading ? (
          <p className="backup-empty">正在读取备份…</p>
        ) : backups.length === 0 ? (
          <p className="backup-empty">尚无备份，点击“立即备份”创建第一份。</p>
        ) : (
          <div className="backup-list">
            {backups.map((backup) => (
              <div className="backup-item" key={backup.fileName}>
                <div>
                  <strong>{backup.automatic ? "自动备份" : backup.fileName.startsWith("manual-before-restore-") ? "恢复前备份" : "手动备份"}</strong>
                  <small>
                    {new Date(backup.createdAt).toLocaleString("zh-CN")} · {formatBackupSize(backup.sizeBytes)} · {backup.learningIncluded ? "含学习数据" : "不含学习数据"}
                  </small>
                </div>
                <button
                  type="button"
                  disabled={backupWorking}
                  onClick={async () => {
                    setBackupWorking(true);
                    try {
                      if (!(await confirmAction(backup.learningIncluded
                        ? "恢复后，当前提醒和学习数据会先自动备份，再替换为所选版本。确定继续吗？"
                        : "这个旧备份不含学习数据；恢复时会替换提醒和设置，并保留当前学习数据。当前提醒和设置仍会先自动备份。确定继续吗？"))) {
                        setBackupWorking(false);
                        return;
                      }
                      await restoreBackup(backup.fileName);
                      onNotice("数据已恢复，正在重新加载界面。");
                      window.setTimeout(() => window.location.reload(), 250);
                    } catch (error) {
                      setBackupError(`恢复失败：${String(error)}`);
                      setBackupWorking(false);
                    }
                  }}
                >
                  恢复
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="delete-data-section" aria-labelledby="delete-local-data-title">
        <div className="delete-data-heading">
          <strong id="delete-local-data-title">删除全部本地数据</strong>
          <small>
            将永久删除提醒、历史、专注记录、设置、备份、学习数据和日志，然后完全退出。如果没有保存在应用数据目录之外的副本，请不要继续。
          </small>
        </div>
        <label className="delete-data-confirmation" htmlFor={deleteConfirmationId}>
          <span>
            输入“{DELETE_ALL_LOCAL_DATA_CONFIRMATION}”以确认
          </span>
          <input
            id={deleteConfirmationId}
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={deleteWorking || !tauriAvailable()}
            value={deleteConfirmation}
            onChange={(event) => {
              setDeleteConfirmation(event.target.value);
              setDeleteError(null);
            }}
          />
        </label>
        <label className="delete-data-acknowledgement" htmlFor={deleteNoRecoveryId}>
          <input
            id={deleteNoRecoveryId}
            type="checkbox"
            disabled={deleteWorking || !tauriAvailable()}
            checked={deleteNoRecovery}
            onChange={(event) => {
              setDeleteNoRecovery(event.target.checked);
              setDeleteError(null);
            }}
          />
          <span>我明白此操作无法撤销，普通卸载不会替代这一步。</span>
        </label>
        {!tauriAvailable() && (
          <p className="delete-data-note">此操作只能在已安装的 Windows 桌面应用中执行。</p>
        )}
        {deleteError && (
          <p className="delete-data-error" role="alert" aria-live="assertive">
            {deleteError}
          </p>
        )}
        <button
          className="delete-data-button"
          type="button"
          disabled={!deleteReady || deleteWorking}
          onClick={async () => {
            if (!deleteReady) return;
            setDeleteWorking(true);
            setDeleteError(null);
            try {
              if (!(await confirmAction(petText("最后确认：{pet}会完全退出，所有本地数据和应用内备份都将永久删除。确定继续吗？")))) {
                setDeleteWorking(false);
                return;
              }
              await deleteAllLocalDataAndExit(
                deleteConfirmation,
                deleteNoRecovery,
              );
            } catch (error) {
              setDeleteError(`删除未启动：${String(error)}`);
              setDeleteWorking(false);
            }
          }}
        >
          {deleteWorking ? "正在退出并清理…" : "永久删除本地数据并退出"}
        </button>
      </section>
      <div className="settings-actions">
        <button
          type="button"
          onClick={async () => {
            try {
              await requestSleep();
              onNotice(petText("{pet}已经去睡觉了；右键{pet}可叫醒它。"));
            } catch (error) {
              onNotice(`${getPetSnapshot().nickname}暂时没能睡下：${String(error)}`);
            }
          }}
        >{petText("让{pet}睡觉")}</button>
        <button
          type="button"
          onClick={async () => {
            try {
              await showPetWindow();
              await requestWake();
              onNotice(petText("{pet}已经显示并醒来了。"));
            } catch (error) {
              onNotice(`${getPetSnapshot().nickname}暂时没能显示或醒来：${String(error)}`);
            }
          }}
        >{petText("显示并叫醒{pet}")}</button>
        <button
          type="button"
          onClick={async () => {
            await pauseReminders(30);
            onNotice("提醒已暂停 30 分钟。");
          }}
        >
          暂停提醒 30 分钟
        </button>
        <button className="danger" type="button" onClick={() => void quitApplication()}>
          完全退出
        </button>
      </div>
    </div>
  );
}

function formatBackupSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const accessibleChild = isValidElement<{
    "aria-labelledby"?: string;
    "aria-describedby"?: string;
    role?: string;
  }>(children)
    ? cloneElement(children, {
        "aria-labelledby": titleId,
        "aria-describedby": descriptionId,
        ...(children.type === "div" ? { role: "group" } : {}),
      })
    : children;

  return (
    <div
      className="setting-row"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
    >
      <div>
        <strong id={titleId}>{title}</strong>
        <small id={descriptionId}>{description}</small>
      </div>
      {accessibleChild}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

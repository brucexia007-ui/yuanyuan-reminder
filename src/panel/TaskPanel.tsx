import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  onAction,
  registerActionTypes,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import type { PluginListener } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  completeOccurrence,
  cancelFocus,
  createReminder,
  getFocusState,
  getPetCare,
  getSettings,
  listHistory,
  listToday,
  onBackendEvent,
  pauseReminders,
  quitApplication,
  recordWater,
  requestSleep,
  requestWake,
  skipOccurrence,
  snoozeOccurrence,
  startFocus,
  startPetInteraction,
  tauriAvailable,
  updateSettings,
} from "../lib/backend";
import type {
  AppSettings,
  CreateReminderInput,
  FocusState,
  Occurrence,
  PanelRoute,
  PetCareSnapshot,
  PetInteractionKind,
  Reminder,
  ReminderCategory,
  ScheduleKind,
  TodaySnapshot,
} from "../types";
import { plannedDueLabel, plannedReminders } from "./todayReminders";
import "./panel.css";

type Tab = PanelRoute;

const emptySnapshot: TodaySnapshot = {
  reminders: [],
  occurrences: [],
  waterCompleted: 0,
  waterGoal: 8,
  notificationAvailable: false,
};

const fallbackSettings: AppSettings = {
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

export function TaskPanel() {
  const panelWindow = useMemo(
    () => (tauriAvailable() ? getCurrentWindow() : null),
    [],
  );
  const [tab, setTab] = useState<Tab>(() => {
    const requested = new URLSearchParams(window.location.search).get("tab");
    return requested && ["today", "focus", "care", "history", "add", "settings"].includes(requested)
      ? (requested as Tab)
      : "today";
  });
  const [snapshot, setSnapshot] = useState<TodaySnapshot>(emptySnapshot);
  const [settings, setSettings] = useState<AppSettings>(fallbackSettings);
  const [focusState, setFocusState] = useState<FocusState>(emptyFocusState);
  const [care, setCare] = useState<PetCareSnapshot>(emptyCareSnapshot);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [today, currentSettings, currentFocus, currentCare] = await Promise.all([
        listToday(),
        getSettings(),
        getFocusState(),
        getPetCare(),
      ]);
      setSnapshot(today);
      setSettings(currentSettings);
      setFocusState(currentFocus);
      setCare(currentCare);
    } catch (error) {
      setNotice(`暂时无法读取提醒：${String(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const cleanups: Array<() => void> = [];
    void Promise.all([
      onBackendEvent<void>("occurrence-updated", refresh),
      onBackendEvent<void>("reminder-due", refresh),
      onBackendEvent<AppSettings>("settings-updated", setSettings),
      onBackendEvent<FocusState>("focus-updated", setFocusState),
      onBackendEvent<PetCareSnapshot>("pet-care-updated", setCare),
      onBackendEvent<{ route: Tab }>("panel-route", ({ route }) => setTab(route)),
    ]).then((unlisten) => cleanups.push(...unlisten));

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void panelWindow?.hide();
    };
    window.addEventListener("keydown", keydown);
    return () => {
      cleanups.forEach((cleanup) => cleanup());
      window.removeEventListener("keydown", keydown);
    };
  }, [panelWindow, refresh]);

  useEffect(() => {
    let listener: PluginListener | undefined;
    void (async () => {
      try {
        if (!(await isPermissionGranted())) await requestPermission();
        await registerActionTypes([
          {
            id: "reminder-actions",
            actions: [
              { id: "complete", title: "已完成", foreground: true },
              { id: "snooze", title: "10 分钟后", foreground: true },
              { id: "skip", title: "跳过", foreground: true },
            ],
          },
        ]);
        listener = await onAction(async (notification) => {
          const data = notification as unknown as {
            actionId?: string;
            extra?: Record<string, string>;
          };
          const id = data.extra?.occurrenceId;
          if (!id) return;
          if (data.actionId === "complete") await completeOccurrence(id);
          if (data.actionId === "snooze") await snoozeOccurrence(id);
          if (data.actionId === "skip") await skipOccurrence(id);
          await refresh();
        });
      } catch {
        // The Rust backend also emits an in-app due state when OS notifications are unavailable.
      }
    })();
    return () => {
      void listener?.unregister();
    };
  }, [refresh]);

  const saveSetting = async (patch: Partial<AppSettings>) => {
    try {
      const next = await updateSettings(patch);
      setSettings(next);
    } catch (error) {
      setNotice(`设置保存失败：${String(error)}`);
    }
  };

  return (
    <main className="panel-shell">
      <header className="panel-header">
        <div>
          <p className="eyebrow">YUANYUAN REMINDER</p>
          <h1>
            {tab === "today"
              ? "今天"
              : tab === "focus"
                ? "专注"
                : tab === "care"
                  ? "陪圆圆"
                  : tab === "history"
                    ? "历史记录"
                : tab === "add"
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

      <nav className="segmented" aria-label="圆圆提醒页面">
        <TabButton active={tab === "today"} onClick={() => setTab("today")}>
          今日
        </TabButton>
        <TabButton active={tab === "focus"} onClick={() => setTab("focus")}>
          专注
        </TabButton>
        <TabButton active={tab === "care"} onClick={() => setTab("care")}>
          互动
        </TabButton>
        <TabButton active={tab === "history"} onClick={() => setTab("history")}>
          历史
        </TabButton>
        <TabButton active={tab === "add"} onClick={() => setTab("add")}>
          新建
        </TabButton>
        <TabButton active={tab === "settings"} onClick={() => setTab("settings")}>
          设置
        </TabButton>
      </nav>

      <section className="panel-content">
        {loading ? (
          <div className="empty-state">圆圆正在整理今天的安排…</div>
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
        ) : tab === "history" ? (
          <HistoryView />
        ) : tab === "add" ? (
          <AddView
            onSaved={async () => {
              await refresh();
              setTab("today");
              setNotice("提醒已交给圆圆。");
            }}
          />
        ) : (
          <SettingsView
            settings={settings}
            onChange={saveSetting}
            onNotice={setNotice}
          />
        )}
      </section>
    </main>
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
    description: "圆圆会走近小碗，低头慢慢吃。",
  },
  {
    kind: "water",
    icon: "💧",
    title: "喂水",
    description: "让圆圆伏下来，认真舔几口水。",
  },
  {
    kind: "treat",
    icon: "🥣",
    title: "喂猫条",
    description: "到桌面拖动猫条，圆圆会追着吃并站起来。",
    interactive: true,
  },
  {
    kind: "wand",
    icon: "🪶",
    title: "逗猫棒",
    description: "按住逗猫棒移向八个方位，圆圆会用对应爪子抓。",
    interactive: true,
  },
  {
    kind: "pet",
    icon: "🤍",
    title: "摸摸圆圆",
    description: "把鼠标靠近圆圆，它会转头蹭你的手。",
    interactive: true,
  },
  {
    kind: "ball",
    icon: "🔴",
    title: "扔球游戏",
    description: "按住球蓄力，松手后圆圆会把球捡回来。",
    interactive: true,
  },
];

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

  const begin = async (
    kind: PetInteractionKind,
    interactive: boolean,
  ) => {
    if (focusActive) {
      onNotice("专注期间圆圆会乖乖坐着或趴着，结束后再陪它玩吧。");
      return;
    }
    setWorking(kind);
    try {
      onCare(await startPetInteraction(kind));
      if (interactive) {
        onNotice(
          kind === "treat"
            ? "猫条已经出现在圆圆身边：按住它上下移动。"
            : kind === "wand"
              ? "按住逗猫棒移向不同方位；正上方时圆圆会站起来抓。"
              : kind === "pet"
                ? "把鼠标移到圆圆头上轻轻移动，它会朝你的方向蹭一蹭。"
                : "球已经放在圆圆脚边：按住鼠标左键蓄力，松手扔出。",
        );
        onInteractiveStarted();
      }
    } catch (error) {
      onNotice(String(error));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="care-view stack">
      <article className={`care-summary ${focusActive ? "focus-locked" : ""}`}>
        <div className="care-heart">♡</div>
        <div>
          <p className="card-kicker">今日陪伴</p>
          <h2>{focusActive ? "圆圆正在乖乖陪你专注" : `已经互动 ${care.total} 次`}</h2>
          <p>
            {focusActive
              ? "此时不会走动或玩耍，只保留轻微呼吸和眨眼。"
              : "这些记录不会变成惩罚式养成，想陪它时再来就好。"}
          </p>
        </div>
      </article>

      <div className="care-grid">
        {careActions.map((action) => (
          <button
            className="care-action"
            type="button"
            disabled={focusActive || working !== null}
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
        <span>到点提醒、睡眠和专注会优先，必要时会立即让圆圆停下玩耍。</span>
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
          ? `圆圆开始陪你专注 ${duration} 分钟。`
          : `圆圆开始陪你休息 ${duration} 分钟。`,
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
            ? "圆圆正在认真陪你工作"
            : "先放松一下，圆圆替你看着时间"}
        </h2>
        <p>
          {remainingSeconds > 0
            ? "隐藏面板也不会中断计时，结束时圆圆会用动作提醒你。"
            : "时间到了，圆圆正在准备结束动作…"}
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
        <h2>让圆圆陪你进入状态</h2>
        <p>进行中圆圆会乖乖坐着或趴着，结束后再伸懒腰提醒休息。</p>
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
          <h2>{percent >= 100 ? "目标完成啦" : "让圆圆陪你补点水"}</h2>
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
          <h2>{loading ? "圆圆正在翻记录…" : `查询到 ${records.length} 项`}</h2>
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
          </select>
        </label>
      </div>

      {error ? (
        <div className="empty-state history-error">{error}</div>
      ) : loading && records.length === 0 ? (
        <div className="empty-state">圆圆正在整理历史记录…</div>
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
        : "喝水";
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
          {completed ? "已完成" : "已跳过"} · {category} ·{" "}
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
        <p>{cadence} · 已交给圆圆</p>
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
          <button
            type="button"
            onClick={async () => {
              await snoozeOccurrence(occurrence.id);
              await refresh();
            }}
          >
            10 分钟后
          </button>
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

function AddView({ onSaved }: { onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<ReminderCategory>("work");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>("once");
  const [atLocal, setAtLocal] = useState(() => {
    const date = new Date(Date.now() + 60 * 60 * 1000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(
      date.getMinutes(),
    ).padStart(2, "0")}`;
  });
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    const input: CreateReminderInput = {
      title: title.trim(),
      category,
      scheduleKind,
      atLocal,
      everyMinutes,
      activeStartLocal: "09:00",
      activeEndLocal: "18:00",
      weekdays: [1, 2, 3, 4, 5],
    };
    await createReminder(input);
    setSaving(false);
    await onSaved();
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
        <label>
          <span>提醒间隔</span>
          <select
            value={everyMinutes}
            onChange={(event) => setEveryMinutes(Number(event.target.value))}
          >
            {[30, 45, 60, 90, 120].map((minutes) => (
              <option key={minutes} value={minutes}>
                每 {minutes} 分钟
              </option>
            ))}
          </select>
        </label>
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
      <button className="primary large" type="submit" disabled={saving || !title.trim()}>
        {saving ? "正在保存…" : "交给圆圆提醒"}
      </button>
    </form>
  );
}

function SettingsView({
  settings,
  onChange,
  onNotice,
}: {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => Promise<void>;
  onNotice: (notice: string) => void;
}) {
  return (
    <div className="settings-list">
      <SettingRow title="圆圆动画" description="不受 Windows 动画关闭影响">
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
      <SettingRow title="动画速度" description="调节所有动作的播放节奏">
        <select
          value={settings.animationSpeed}
          onChange={(event) =>
            void onChange({ animationSpeed: Number(event.target.value) })
          }
        >
          {[0.6, 0.8, 1, 1.25, 1.5].map((speed) => (
            <option key={speed} value={speed}>
              {speed}×
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="看向鼠标" description="只在圆圆空闲时工作">
        <Toggle
          checked={settings.cursorFollow}
          onChange={(checked) => void onChange({ cursorFollow: checked })}
        />
      </SettingRow>
      <SettingRow title="总在最前" description="让圆圆保持在其他窗口上方">
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
      <SettingRow title="安静时段" description="圆圆会进入睡眠">
        <div className="time-pair">
          <input
            type="time"
            value={settings.quietStart}
            onChange={(event) => void onChange({ quietStart: event.target.value })}
          />
          <span>至</span>
          <input
            type="time"
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
            value={settings.waterStart}
            onChange={(event) => void onChange({ waterStart: event.target.value })}
          />
          <span>至</span>
          <input
            type="time"
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
          {[30, 45, 60, 90, 120].map((minutes) => (
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
            disabled={!settings.activityEnabled}
            value={settings.activityStart}
            onChange={(event) =>
              void onChange({ activityStart: event.target.value })
            }
          />
          <span>至</span>
          <input
            type="time"
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
        description="离开电脑约 5 分钟后会重新累计"
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
          {[30, 45, 60, 90, 120].map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} 分钟
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow title="开机启动" description="登录 Windows 后自动陪伴">
        <Toggle
          checked={settings.autostart}
          onChange={(checked) => void onChange({ autostart: checked })}
        />
      </SettingRow>
      <div className="settings-actions">
        <button type="button" onClick={() => void requestSleep()}>
          让圆圆睡觉
        </button>
        <button type="button" onClick={() => void requestWake()}>
          叫醒圆圆
        </button>
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

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

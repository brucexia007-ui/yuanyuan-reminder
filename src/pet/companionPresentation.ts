import type {
  CompanionExpressionSnapshot,
  CompanionProp,
} from "../types";

export type CompanionLabelMode = "motion_only" | "adaptive" | "always";

const fixedLabelCopy = {
  water_due: "喝水",
  reminder_due: "提醒",
  needs_user: "等你",
  time_to_move: "活动",
  running: "守望中",
  still_running: "还在守着",
  completed: "完成",
  failed: "没成功",
  cancelled: "已收起",
  possibly_stalled: "像是停住了",
  status_unknown: "状态不明",
  information: "有资料",
  decision_required: "待确认",
} as const;

const fixedAccessibleCopy = {
  welcoming_return: "圆圆起身靠近，轻轻蹭了蹭你",
  quiet_presence: "圆圆正在安静陪伴",
  focused_quietly: "圆圆正在安静陪你专注",
  focus_finished: "专注结束，圆圆伸了个懒腰",
  moving_together: "圆圆伸了个懒腰，陪你轻轻活动",
  giving_space: "圆圆退到远一点的位置，安静留出空间",
  sleeping: "圆圆正在睡觉",
  heard_user: "圆圆听见了",
  approaching: "圆圆正在靠近",
  staying_close: "圆圆正在你身边守着",
  water_reminder_due: "圆圆把喝水提醒推到了面前",
  work_reminder_due: "圆圆把任务提醒推到了面前",
  task_needs_user: "圆圆发现任务正在等待你的确认",
  activity_reminder_due: "圆圆在邀请你起来活动",
  task_running: "圆圆正在电脑旁守望任务",
  task_still_running: "任务运行较久，圆圆仍在电脑旁守着",
  task_completed: "圆圆发现任务已经完成",
  task_failed: "圆圆发现任务没有成功，正在你身边陪着",
  task_cancelled: "圆圆把已取消的任务卡收起来了",
  task_possibly_stalled: "圆圆发现任务可能停住了",
  task_status_unknown: "圆圆暂时无法确认任务状态",
  information_available: "圆圆把资料放到了提词器上",
  formal_decision_required: "圆圆把待确认事项放到了确认台上",
} as const;

const knownProps = new Set<CompanionProp>([
  "computer",
  "bell",
  "task_card",
  "basket",
  "prompter",
  "system_card",
]);

const adaptiveLabels = new Set([
  "needs_user",
  "failed",
  "possibly_stalled",
  "status_unknown",
]);

export interface CompanionPresentation {
  shortLabel: string | null;
  accessibleLabel: string;
  sourceLabel: string | null;
  props: CompanionProp[];
  groupLabel: string | null;
}

export function companionPresentation(
  snapshot: CompanionExpressionSnapshot,
  labelMode: CompanionLabelMode = "always",
): CompanionPresentation {
  const label = snapshot.label as keyof typeof fixedLabelCopy | null;
  const accessibleState =
    snapshot.accessibleState as keyof typeof fixedAccessibleCopy;
  const props = snapshot.props
    .filter((prop): prop is CompanionProp => knownProps.has(prop))
    .filter((prop, index, all) => all.indexOf(prop) === index)
    .slice(0, 6);

  return {
    shortLabel:
      label &&
      (labelMode === "always" ||
        (labelMode === "adaptive" && adaptiveLabels.has(label)))
        ? fixedLabelCopy[label] ?? null
        : null,
    accessibleLabel:
      fixedAccessibleCopy[accessibleState] ?? fixedAccessibleCopy.quiet_presence,
    sourceLabel:
      snapshot.taskSource === "codex"
        ? "Codex"
        : snapshot.taskSource === "claude_code"
          ? "Claude"
          : null,
    props,
    groupLabel:
      snapshot.groupedCount > 1
        ? snapshot.groupedCount > 99
          ? "99+"
          : String(snapshot.groupedCount)
        : null,
  };
}

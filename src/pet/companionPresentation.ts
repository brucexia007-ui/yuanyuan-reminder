import { petText, getPetSnapshot } from "./petProfile";
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
  review_ready: "复习",
} as const;

const fixedAccessibleCopy = {
  get welcoming_return() { return petText("{pet}起身靠近，轻轻蹭了蹭你"); },
  get quiet_presence() { return petText("{pet}正在安静陪伴"); },
  get focused_quietly() { return petText("{pet}正在安静陪你专注"); },
  get focus_finished() { return petText("专注结束，{pet}伸了个懒腰"); },
  get moving_together() { return petText("{pet}伸了个懒腰，陪你轻轻活动"); },
  get giving_space() { return petText("{pet}退到远一点的位置，安静留出空间"); },
  get sleeping() { return petText("{pet}正在睡觉"); },
  get heard_user() { return petText("{pet}听见了"); },
  get approaching() { return petText("{pet}正在靠近"); },
  get staying_close() { return petText("{pet}正在你身边守着"); },
  get water_reminder_due() { return petText("{pet}把喝水提醒推到了面前"); },
  get meal_reminder_due() { return petText("{pet}穿好围裙，提醒你按自己的安排用餐"); },
  get work_reminder_due() { return petText("{pet}把任务提醒推到了面前"); },
  get task_needs_user() { return petText("{pet}发现任务正在等待你的确认"); },
  get activity_reminder_due() { return petText("{pet}在邀请你起来活动"); },
  get task_running() { return petText("{pet}正在电脑旁守望任务"); },
  get task_still_running() { return petText("任务运行较久，{pet}仍在电脑旁守着"); },
  get task_completed() { return petText("{pet}发现任务已经完成"); },
  get task_failed() { return petText("{pet}发现任务没有成功，正在你身边陪着"); },
  get task_cancelled() { return petText("{pet}把已取消的任务卡收起来了"); },
  get task_possibly_stalled() { return petText("{pet}发现任务可能停住了"); },
  get task_status_unknown() { return petText("{pet}暂时无法确认任务状态"); },
  get information_available() { return petText("{pet}把资料放到了提词器上"); },
  get formal_decision_required() { return petText("{pet}把待确认事项放到了确认台上"); },
  get learning_invitation() { return petText("{pet}叼来一张英语复习卡，打开后才会显示单词"); },
  get learning_session() { return petText("{pet}在一旁安静守着这叠英语复习卡"); },
  get resting_care() { return petText("{pet}正在安静泡水疗休息"); },
  get working() { return petText("{pet}精神饱满地陪你工作"); },
  get working_transition() { return petText("{pet}工作了一阵，姿态稍微放松下来"); },
  get working_fatigued() { return petText("{pet}显得有些疲惫，仍在安静陪伴"); },
} as const;

const knownProps = new Set<CompanionProp>([
  "computer",
  "bell",
  "task_card",
  "basket",
  "prompter",
  "system_card",
  "learning_card",
]);

const adaptiveLabels = new Set([
  "needs_user",
  "failed",
  "possibly_stalled",
  "status_unknown",
  "review_ready",
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
  const profile = getPetSnapshot();
  const detailedScene = profile.capabilities.scene && !profile.staticOnly && snapshot.sceneAppearance?.kind !== "none";
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
      !detailedScene && accessibleState === "meal_reminder_due" ? petText("{pet}提醒你按自己的安排用餐") :
      !detailedScene && accessibleState === "resting_care" ? petText("{pet}正在安静休息") :
      !detailedScene && ["working_transition", "working_fatigued"].includes(accessibleState) ? petText("已工作一段时间，{pet}正在安静陪伴") :
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

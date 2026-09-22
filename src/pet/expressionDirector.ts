import type { AnimationName } from "./manifest";
import { petText } from "./petProfile";

export type TaskWatchState =
  | "running"
  | "long_running"
  | "waiting_user"
  | "succeeded"
  | "failed"
  | "stalled"
  | "cancelled"
  | "unknown";

export type PropKind = "computer" | "bell" | "task_card" | "basket";
export type LabelMode = "motion_only" | "adaptive" | "always";
export type AttentionMode = "silent" | "present" | "ring_once";

export interface TaskExpressionInput {
  state: TaskWatchState;
  labelMode: LabelMode;
  vocabularyFamiliar: boolean;
  reduceMotion: boolean;
  focusActive: boolean;
  sourceLabel: string;
}

export interface TaskExpressionPlan {
  tier: "N2";
  intent:
    | "watch"
    | "needs_user"
    | "celebrate"
    | "stay_close"
    | "inspect"
    | "put_away";
  animation: AnimationName;
  props: PropKind[];
  label: string;
  labelVisible: boolean;
  attention: AttentionMode;
  movePropForward: boolean;
  queueInBasket: boolean;
  motion: "full" | "reduced";
  accessibleName: string;
}

interface StateVocabulary {
  intent: TaskExpressionPlan["intent"];
  animation: AnimationName;
  props: PropKind[];
  label: string;
  accessibleState: string;
  attention: AttentionMode;
  movePropForward: boolean;
  queueInBasket: boolean;
}

const vocabulary: Record<TaskWatchState, StateVocabulary> = {
  running: {
    intent: "watch",
    animation: "waiting",
    props: ["computer"],
    label: "运行中",
    accessibleState: "任务正在运行",
    attention: "silent",
    movePropForward: false,
    queueInBasket: false,
  },
  long_running: {
    intent: "watch",
    animation: "focus-calm",
    props: ["computer"],
    label: "仍在运行",
    accessibleState: "任务仍在运行",
    attention: "silent",
    movePropForward: false,
    queueInBasket: false,
  },
  waiting_user: {
    intent: "needs_user",
    animation: "alert-glass-paws",
    props: ["bell", "task_card"],
    label: "需要你",
    accessibleState: "任务正在等待用户处理",
    attention: "ring_once",
    movePropForward: true,
    queueInBasket: false,
  },
  succeeded: {
    intent: "celebrate",
    animation: "jumping",
    props: ["task_card", "basket"],
    label: "已完成",
    accessibleState: "任务已完成",
    attention: "present",
    movePropForward: true,
    queueInBasket: true,
  },
  failed: {
    intent: "stay_close",
    animation: "failed",
    props: ["task_card"],
    label: "没成功",
    get accessibleState() { return petText("任务没有成功，{pet}正在旁边陪着"); },
    attention: "present",
    movePropForward: true,
    queueInBasket: false,
  },
  stalled: {
    intent: "inspect",
    animation: "review",
    props: ["computer", "task_card"],
    label: "可能停住",
    accessibleState: "任务可能已经停住",
    attention: "present",
    movePropForward: true,
    queueInBasket: false,
  },
  cancelled: {
    intent: "put_away",
    animation: "review",
    props: ["task_card", "basket"],
    label: "已取消",
    accessibleState: "任务已取消",
    attention: "present",
    movePropForward: false,
    queueInBasket: true,
  },
  unknown: {
    intent: "inspect",
    animation: "review",
    props: ["computer", "task_card"],
    label: "状态未知",
    accessibleState: "任务状态未知",
    attention: "silent",
    movePropForward: false,
    queueInBasket: false,
  },
};

const adaptiveLabels = new Set<TaskWatchState>([
  "waiting_user",
  "failed",
  "stalled",
  "unknown",
]);

export function directTaskExpression(
  input: TaskExpressionInput,
): TaskExpressionPlan {
  const selected = vocabulary[input.state];
  const labelVisible =
    input.labelMode === "always" ||
    (input.labelMode === "adaptive" &&
      (!input.vocabularyFamiliar || adaptiveLabels.has(input.state)));
  const suppressedByFocus = input.focusActive && input.state !== "waiting_user";

  return {
    tier: "N2",
    intent: selected.intent,
    animation: input.reduceMotion
      ? reducedTaskAnimation(input.state, selected.animation)
      : selected.animation,
    props: selected.props,
    label: selected.label,
    labelVisible,
    attention: suppressedByFocus ? "silent" : selected.attention,
    movePropForward: suppressedByFocus ? false : selected.movePropForward,
    queueInBasket: selected.queueInBasket,
    motion: input.reduceMotion ? "reduced" : "full",
    accessibleName: `${input.sourceLabel}，${selected.accessibleState}`,
  };
}

function reducedTaskAnimation(
  state: TaskWatchState,
  defaultAnimation: AnimationName,
): AnimationName {
  switch (state) {
    case "waiting_user":
      return "waiting";
    case "succeeded":
    case "failed":
    case "stalled":
    case "cancelled":
    case "unknown":
      return "focus-calm";
    default:
      return defaultAnimation;
  }
}

export const taskWatchStates = Object.keys(vocabulary) as TaskWatchState[];

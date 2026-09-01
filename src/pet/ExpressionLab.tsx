import { useEffect, useMemo, useState } from "react";
import { petText } from "../brand";
import { SpriteAnimator } from "./SpriteAnimator";
import type { CompanionExpressionSnapshot } from "../types";
import { settledAnimationAfterCompanionCue } from "./companionMotion";
import type { AnimationName } from "./manifest";
import {
  directTaskExpression,
  taskWatchStates,
  type LabelMode,
  type PropKind,
  type TaskWatchState,
} from "./expressionDirector";
import "./expressionLab.css";

const stateLabels: Record<TaskWatchState, string> = {
  running: "运行中",
  long_running: "长时间运行",
  waiting_user: "需要用户",
  succeeded: "已完成",
  failed: "没成功",
  stalled: "可能停住",
  cancelled: "已取消",
  unknown: "状态未知",
};

const propAccessibleNames: Record<PropKind, string> = {
  computer: "小电脑",
  bell: "小铃铛",
  task_card: "任务牌",
  basket: "任务篮",
};

const previewMotionState: Record<
  TaskWatchState,
  Pick<CompanionExpressionSnapshot, "pose" | "accessibleState">
> = {
  running: { pose: "watch_computer", accessibleState: "task_running" },
  long_running: {
    pose: "stay_close",
    accessibleState: "task_still_running",
  },
  waiting_user: { pose: "alert", accessibleState: "task_needs_user" },
  succeeded: { pose: "celebrate", accessibleState: "task_completed" },
  failed: { pose: "stay_close", accessibleState: "task_failed" },
  stalled: { pose: "review", accessibleState: "task_possibly_stalled" },
  cancelled: { pose: "put_away", accessibleState: "task_cancelled" },
  unknown: { pose: "review", accessibleState: "task_status_unknown" },
};

export function ExpressionLab() {
  const [state, setState] = useState<TaskWatchState>("running");
  const [labelMode, setLabelMode] = useState<LabelMode>("adaptive");
  const [vocabularyFamiliar, setVocabularyFamiliar] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [focusActive, setFocusActive] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("Codex");
  const plan = useMemo(
    () =>
      directTaskExpression({
        state,
        labelMode,
        vocabularyFamiliar,
        reduceMotion,
        focusActive,
        sourceLabel,
      }),
    [focusActive, labelMode, reduceMotion, sourceLabel, state, vocabularyFamiliar],
  );
  const [previewAnimation, setPreviewAnimation] = useState<AnimationName>(
    plan.animation,
  );

  useEffect(() => {
    setPreviewAnimation(plan.animation);
  }, [plan.animation, state]);

  return (
    <main className="expression-lab" aria-label={petText("圆圆非语言任务状态实验台")}>
      <header>
        <p className="expression-eyebrow">P0 · 非语言表达验证</p>
        <h1>动作和道具能不能看懂？</h1>
        <p>{petText("圆圆不说人话。请选择状态，观察动作、道具和标签是否足够清楚。")}</p>
      </header>

      <section className="expression-controls" aria-label="原型条件">
        <label>
          <span>来源</span>
          <select value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)}>
            <option>Codex</option>
            <option>Claude Code</option>
          </select>
        </label>
        <label>
          <span>标签</span>
          <select
            value={labelMode}
            onChange={(event) => setLabelMode(event.target.value as LabelMode)}
          >
            <option value="motion_only">纯动作</option>
            <option value="adaptive">自适应</option>
            <option value="always">始终显示</option>
          </select>
        </label>
        <label className="expression-check">
          <input
            type="checkbox"
            checked={vocabularyFamiliar}
            onChange={(event) => setVocabularyFamiliar(event.target.checked)}
          />
          已熟悉道具
        </label>
        <label className="expression-check">
          <input
            type="checkbox"
            checked={reduceMotion}
            onChange={(event) => setReduceMotion(event.target.checked)}
          />
          减少动态
        </label>
        <label className="expression-check">
          <input
            type="checkbox"
            checked={focusActive}
            onChange={(event) => setFocusActive(event.target.checked)}
          />
          正在专注
        </label>
      </section>

      <nav className="expression-states" aria-label="任务状态">
        {taskWatchStates.map((candidate) => (
          <button
            type="button"
            key={candidate}
            aria-pressed={state === candidate}
            onClick={() => setState(candidate)}
          >
            {stateLabels[candidate]}
          </button>
        ))}
      </nav>

      <section className="expression-preview" aria-label={plan.accessibleName}>
        <div
          className={`expression-stage attention-${plan.attention} ${
            plan.movePropForward ? "prop-forward" : ""
          }`}
        >
          <div className="expression-pet">
            <SpriteAnimator
              animation={previewAnimation}
              settings={{
                animationMode: reduceMotion ? "off" : "always",
                animationSpeed: 1,
              }}
              onComplete={(finished) => {
                const settled = settledAnimationAfterCompanionCue(finished, {
                  ...previewMotionState[state],
                  motion: plan.motion,
                });
                if (settled) setPreviewAnimation(settled);
              }}
            />
          </div>
          <div className="expression-props" aria-hidden="true">
            {plan.props.map((prop) => (
              <div className={`expression-prop prop-${prop}`} key={prop}>
                <span className="prop-shape" />
                {plan.labelVisible && prop === plan.props.at(-1) ? (
                  <span className="prop-label">{plan.label}</span>
                ) : null}
              </div>
            ))}
          </div>
          <span className="sr-only">
            道具：{plan.props.map((prop) => propAccessibleNames[prop]).join("、")}
          </span>
        </div>

        <aside className="expression-facts" aria-label="表达计划">
          <span>N2 明确状态</span>
          <strong>{plan.accessibleName}</strong>
          <dl>
            <div><dt>动作意图</dt><dd>{plan.intent}</dd></div>
            <div><dt>注意方式</dt><dd>{plan.attention}</dd></div>
            <div><dt>标签</dt><dd>{plan.labelVisible ? plan.label : "不显示"}</dd></div>
            <div><dt>动态</dt><dd>{plan.motion === "reduced" ? "减少" : "完整"}</dd></div>
          </dl>
        </aside>
      </section>
    </main>
  );
}

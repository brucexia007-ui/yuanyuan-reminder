import type { CompanionExpressionSnapshot, CompanionProp } from "../types";
import {
  companionPresentation,
  type CompanionLabelMode,
} from "./companionPresentation";

interface CompanionPropStageProps {
  snapshot: CompanionExpressionSnapshot;
  labelMode: CompanionLabelMode;
  onOpenTaskWatch?: () => void;
  onOpenLearning?: () => void;
  onDismissLearning?: () => void;
  onPauseLearningToday?: () => void;
}

function FixedProp({
  prop,
  label,
  source,
  groupLabel,
}: {
  prop: CompanionProp;
  label: string | null;
  source: string | null;
  groupLabel: string | null;
}) {
  switch (prop) {
    case "computer":
      return (
        <span className="companion-prop companion-prop-computer" aria-hidden="true">
          <span className="companion-computer-screen">
            {source && <small>{source}</small>}
            {label && <strong>{label}</strong>}
          </span>
          <span className="companion-computer-base" />
        </span>
      );
    case "bell":
      return (
        <span className="companion-prop companion-prop-bell" aria-hidden="true">
          <span />
        </span>
      );
    case "task_card":
      return (
        <span className="companion-prop companion-prop-task-card" aria-hidden="true">
          <i />
          {label && <strong>{label}</strong>}
          {source && <small>{source}</small>}
          {groupLabel && <b>{groupLabel}</b>}
        </span>
      );
    case "basket":
      return (
        <span className="companion-prop companion-prop-basket" aria-hidden="true">
          <span />
          {groupLabel && <b>{groupLabel}</b>}
        </span>
      );
    case "prompter":
      return (
        <span className="companion-prop companion-prop-prompter" aria-hidden="true">
          {label && <span>{label}</span>}
        </span>
      );
    case "system_card":
      return (
        <span className="companion-prop companion-prop-system-card" aria-hidden="true">
          <i>✓</i>
          {label && <strong>{label}</strong>}
        </span>
      );
    case "learning_card":
      return (
        <span className="companion-prop companion-prop-learning-card" aria-hidden="true">
          <i />
          {label && <strong>{label}</strong>}
        </span>
      );
  }
}

export function CompanionPropStage({
  snapshot,
  labelMode,
  onOpenTaskWatch,
  onOpenLearning,
  onDismissLearning,
  onPauseLearningToday,
}: CompanionPropStageProps) {
  const presentation = companionPresentation(snapshot, labelMode);
  if (snapshot.tier === "n0") return null;
  if (presentation.props.length === 0) {
    return (
      <span
        className="sr-only"
        role="status"
        aria-live={snapshot.attention === "ring_once" ? "assertive" : "polite"}
        aria-atomic="true"
      >
        {presentation.accessibleLabel}
      </span>
    );
  }

  const fixedProps = presentation.props.map((prop) => (
    <FixedProp
      key={prop}
      prop={prop}
      label={presentation.shortLabel}
      source={presentation.sourceLabel}
      groupLabel={presentation.groupLabel}
    />
  ));
  const canOpenTaskWatch = snapshot.taskSource !== null && onOpenTaskWatch;
  const canOpenLearning =
    snapshot.accessibleState === "learning_invitation" && onOpenLearning;

  return (
    <div
      className={`companion-prop-stage attention-${snapshot.attention} motion-${snapshot.motion} ${
        snapshot.movePropForward ? "move-prop-forward" : ""
      } ${snapshot.queueInBasket ? "queue-in-basket" : ""}`}
      role="status"
      aria-live={snapshot.attention === "ring_once" ? "assertive" : "polite"}
      aria-atomic="true"
      aria-label={presentation.accessibleLabel}
      data-expression-intent={snapshot.intent}
    >
      {canOpenLearning ? (
        <div className="companion-learning-invitation-controls">
          <button
            className="companion-prop-open"
            type="button"
            aria-label={`打开英语复习。${presentation.accessibleLabel}`}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerMove={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onPointerCancel={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpenLearning();
            }}
          >
            {fixedProps}
          </button>
          <button
            className="companion-learning-dismiss"
            type="button"
            aria-label="收起这次英语复习邀请"
            onClick={(event) => {
              event.stopPropagation();
              onDismissLearning?.();
            }}
          >
            ×
          </button>
          <button
            className="companion-learning-pause"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onPauseLearningToday?.();
            }}
          >
            今天不再
          </button>
        </div>
      ) : canOpenTaskWatch ? (
        <button
          className="companion-prop-open"
          type="button"
          aria-label={`打开任务守望台。${presentation.accessibleLabel}`}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
          onPointerCancel={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenTaskWatch?.();
          }}
        >
          {fixedProps}
        </button>
      ) : (
        fixedProps
      )}
    </div>
  );
}

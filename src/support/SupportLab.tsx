import { useState } from "react";
import { petText } from "../brand";
import { SpriteAnimator } from "../pet/SpriteAnimator";
import type { AnimationName } from "../pet/manifest";
import {
  EphemeralSupportSession,
  type SupportPath,
  type SupportSessionState,
} from "./supportSession";
import "./supportLab.css";

const basicGate = {
  professionalReviewPassed: false,
  regionalSafetyResourcesReady: false,
} as const;

const pathDetails: Record<
  Extract<SupportPath, "stay_close" | "move_together" | "give_space">,
  { title: string; note: string; prop: string }
> = {
  stay_close: {
    title: "只陪我一会",
    note: "安静坐着，不追问",
    prop: "软垫",
  },
  move_together: {
    title: "陪我动一动",
    note: "轻轻活动，不计分",
    prop: "小毛线球",
  },
  give_space: {
    title: "先别管我",
    note: petText("圆圆后退，不再回看"),
    prop: "留白牌",
  },
};

function animationFor(state: SupportSessionState): AnimationName {
  if (state.stage === "active") {
    if (state.path === "stay_close") return "focus-calm";
    if (state.path === "move_together") return "stretching";
    if (state.path === "give_space") return "running-right";
  }
  if (state.stage === "choosing") return "pet-nuzzle";
  if (state.stage === "optional_check_in") return "waiting";
  return "idle";
}

export function SupportLab() {
  const [session, setSession] = useState(
    () => new EphemeralSupportSession(basicGate),
  );
  const [, setRevision] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [duration, setDuration] = useState(5);
  const state = session.state;

  function update(action: () => void) {
    action();
    setRevision((value) => value + 1);
  }

  function begin() {
    update(() => session.offerChoices());
  }

  function choose(path: Extract<SupportPath, "stay_close" | "move_together" | "give_space">) {
    setDuration(path === "move_together" ? 3 : 5);
    update(() => session.choose(path));
  }

  function restart() {
    setSession(new EphemeralSupportSession(basicGate));
    setDuration(5);
  }

  const activePath = state.stage === "active" ? state.path : null;
  const shiftedAway = activePath === "give_space" || state.stage === "closed";

  return (
    <main className="support-lab" aria-label={petText("圆圆基础陪伴实验台")}>
      <header className="support-header">
        <div>
          <p className="support-eyebrow">P0 · 三路径基础陪伴</p>
          <h1>不说话，也能好好陪着</h1>
          <p>这里只验证小猫动作与空间感。没有倾诉收集、呼吸练习、模型或安抚疗效表述。</p>
        </div>
        <label className="support-motion-toggle">
          <input
            type="checkbox"
            checked={reduceMotion}
            onChange={(event) => setReduceMotion(event.target.checked)}
          />
          减少动态
        </label>
      </header>

      <section className="support-shell">
        <div
          className={`support-stage ${shiftedAway ? "is-away" : ""}`}
          aria-label={petText("圆圆的非语言回应")}
        >
          <div className="support-window" aria-hidden="true">
            <span />
            <span />
          </div>
          <div className="support-rug" aria-hidden="true" />
          <div className="support-pet">
            <SpriteAnimator
              animation={animationFor(state)}
              settings={{
                animationMode: reduceMotion ? "off" : "always",
                animationSpeed: 0.9,
              }}
            />
          </div>
          {activePath && activePath in pathDetails ? (
            <div className={`support-prop prop-${activePath}`} aria-hidden="true">
              <span>{pathDetails[activePath as keyof typeof pathDetails].prop}</span>
              {activePath !== "give_space" ? <strong>{duration} 分钟</strong> : null}
            </div>
          ) : null}
          <p className="sr-only">
            {activePath === "stay_close" && petText("圆圆在软垫上安静坐下。")}
            {activePath === "move_together" && petText("圆圆伸了伸懒腰，邀请一起轻轻活动。")}
            {activePath === "give_space" && petText("圆圆向后退开，为你留出空间。")}
          </p>
        </div>

        <aside className="support-console" aria-live="polite">
          {state.stage === "approach" ? (
            <div className="support-step">
              <span className="support-step-number">01</span>
              <h2>{petText("由你决定圆圆是否靠近")}</h2>
              <p>{petText("圆圆不会自动判断情绪，也不会突然弹出问题。")}</p>
              <button type="button" className="support-primary" onClick={begin}>
                {petText("让圆圆靠近")}
              </button>
            </div>
          ) : null}

          {state.stage === "choosing" ? (
            <div className="support-step">
              <span className="support-step-number">02</span>
              <h2>{petText("把一张小牌放到圆圆面前")}</h2>
              <div className="support-paths">
                {(Object.keys(pathDetails) as Array<keyof typeof pathDetails>).map((path) => (
                  <button type="button" key={path} onClick={() => choose(path)}>
                    <strong>{pathDetails[path].title}</strong>
                    <span>{pathDetails[path].note}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {state.stage === "active" && activePath && activePath in pathDetails ? (
            <div className="support-step">
              <span className="support-step-number">03</span>
              <h2>{pathDetails[activePath as keyof typeof pathDetails].title}</h2>
              <p>{pathDetails[activePath as keyof typeof pathDetails].note}</p>
              {activePath === "stay_close" ? (
                <div className="support-durations" aria-label="陪伴时长">
                  {[2, 5, 10].map((minutes) => (
                    <button
                      type="button"
                      key={minutes}
                      aria-pressed={duration === minutes}
                      onClick={() => setDuration(minutes)}
                    >
                      {minutes} 分钟
                    </button>
                  ))}
                </div>
              ) : null}
              {activePath === "move_together" ? (
                <div className="support-durations" aria-label="活动时长">
                  {[1, 3, 5, 10].map((minutes) => (
                    <button
                      type="button"
                      key={minutes}
                      aria-pressed={duration === minutes}
                      onClick={() => setDuration(minutes)}
                    >
                      {minutes} 分钟
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="support-primary"
                onClick={() => update(() => session.finishActivePath())}
              >
                {activePath === "give_space" ? "关闭，不再回看" : "本次到这里"}
              </button>
            </div>
          ) : null}

          {state.stage === "optional_check_in" ? (
            <div className="support-step">
              <span className="support-step-number">04</span>
              <h2>本次陪伴已经结束</h2>
              <p>不要求评价，也不形成连续打卡。</p>
              <button
                type="button"
                className="support-primary"
                onClick={() => update(() => session.skipOptionalCheckIn())}
              >
                收好小牌
              </button>
            </div>
          ) : null}

          {state.stage === "closed" ? (
            <div className="support-step">
              <span className="support-step-number">✓</span>
              <h2>空间已留出来</h2>
              <p>这次互动没有评价、记录或后续追问。</p>
              <button type="button" className="support-secondary" onClick={restart}>
                重新体验
              </button>
            </div>
          ) : null}
        </aside>
      </section>

      <footer className="support-boundary">
        <strong>发布边界</strong>
        <span>完整六路径仍关闭：等待专业复核 + 真实地区安全资源。</span>
      </footer>
    </main>
  );
}

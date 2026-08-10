import { useState } from "react";
import { SpriteAnimator } from "../pet/SpriteAnimator";
import type { AnimationName } from "../pet/manifest";
import {
  SortDataBoundarySession,
  type SortDataBoundaryState,
  type SortDestination,
  type SortProviderIdentity,
} from "./sortDataBoundary";
import "./supportSortBoundaryLab.css";

const providers: Record<SortDestination, SortProviderIdentity> = {
  local_provider: {
    destination: "local_provider",
    providerKey: "local-provider",
    providerFingerprint: "A".repeat(64),
    available: true,
  },
  cloud_provider: {
    destination: "cloud_provider",
    providerKey: "cloud-provider-demo",
    providerFingerprint: "B".repeat(64),
    available: true,
  },
};

const destinationDetails = {
  local_provider: {
    title: "仅在本机整理",
    subtitle: "交给本机 Provider",
    retention: "圆圆不写入数据库、日志或备份；本地 Provider 的缓存政策仍需单独披露。",
  },
  cloud_provider: {
    title: "交给云服务整理",
    subtitle: "演示云服务（本页不会发送）",
    retention: "正文会离开设备；正式版本必须先展示具体服务身份和数据保留政策。",
  },
} as const;

const reasonText = {
  destination_changed: "去向已经改变，需要重新查看数据流。",
  provider_changed: "服务身份已经改变，需要重新授权。",
  expired: "五分钟单次授权已经过期。",
  used: "这次授权已经使用，下一次需要重新授权。",
  cancelled: "本次授权已经取消。",
} as const;

function selectedDestination(state: SortDataBoundaryState): SortDestination | null {
  if (state.stage === "review") return state.selection.destination;
  if (state.stage === "authorized") return state.receipt.destination;
  if (state.stage === "reauthorization_required") {
    return state.selection?.destination ?? null;
  }
  return null;
}

export function SupportSortBoundaryLab() {
  const [session, setSession] = useState(() => new SortDataBoundarySession());
  const [, setRevision] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [animation, setAnimation] = useState<AnimationName>("focus-calm");
  const state = session.state;
  const selected = selectedDestination(state);

  function update(action: () => void) {
    action();
    setRevision((value) => value + 1);
  }

  function choose(destination: SortDestination) {
    setAnimation(reduceMotion ? "focus-calm" : "review");
    update(() => session.selectProvider(providers[destination]));
  }

  function restart() {
    const next = new SortDataBoundarySession();
    next.restart();
    setSession(next);
    setAnimation("focus-calm");
  }

  const authorized = state.stage === "authorized";
  const reviewed = state.stage === "review" && state.disclosureAcknowledged;

  return (
    <main className="sort-boundary-lab" aria-label="理一理数据去向实验台">
      <header className="sort-boundary-header">
        <div>
          <p className="sort-boundary-eyebrow">P0 · 数据去向原型 · 不发送</p>
          <h1>先看去向，再决定要不要整理</h1>
          <p>
            圆圆只把整理板拨到你选择的位置。数据说明和授权属于工具，不是小猫对白。
          </p>
        </div>
        <label className="sort-motion-toggle">
          <input
            type="checkbox"
            checked={reduceMotion}
            onChange={(event) => {
              setReduceMotion(event.target.checked);
              if (event.target.checked) setAnimation("focus-calm");
            }}
          />
          减少动态
        </label>
      </header>

      <section className="sort-boundary-shell">
        <div className="sort-pet-stage" aria-label="圆圆安静守在数据去向牌旁">
          <div className="sort-pet">
            <SpriteAnimator
              animation={animation}
              settings={{
                animationMode: reduceMotion ? "off" : "always",
                animationSpeed: 0.9,
              }}
              onComplete={(finished) => {
                if (finished === "review") setAnimation("focus-calm");
              }}
            />
          </div>
          <div className="sort-route-board" aria-hidden="true">
            <span className="sort-board-pin" />
            <strong>数据去向</strong>
            <div className={`sort-board-route is-${selected ?? "closed"}`}>
              <span className="sort-route-source">你主动填写</span>
              <span className="sort-route-arrow">→</span>
              <span className="sort-route-target">
                {selected === "local_provider"
                  ? "本机"
                  : selected === "cloud_provider"
                    ? "云服务"
                    : "尚未选择"}
              </span>
            </div>
          </div>
        </div>

        <section className="sort-boundary-console" aria-live="polite">
          {state.stage === "choosing" ? (
            <div className="sort-step">
              <span className="sort-step-number">01</span>
              <h2>这段内容准备交给谁？</h2>
              <p>现在还没有输入框，也不会读取任务、文件、剪贴板或历史倾诉。</p>
              <DestinationChoices onChoose={choose} />
            </div>
          ) : null}

          {state.stage === "review" ? (
            <div className="sort-step">
              <span className="sort-step-number">02</span>
              <h2>{destinationDetails[state.selection.destination].title}</h2>
              <p className="sort-provider-name">
                {destinationDetails[state.selection.destination].subtitle}
              </p>
              <DataFlow destination={state.selection.destination} />
              <p className="sort-retention-note">
                {destinationDetails[state.selection.destination].retention}
              </p>
              <label className="sort-disclosure-check">
                <input
                  type="checkbox"
                  checked={state.disclosureAcknowledged}
                  onChange={(event) => {
                    if (event.target.checked) {
                      update(() => session.acknowledgeDisclosure());
                    }
                  }}
                />
                我已看清本次正文的去向
              </label>
              <div className="sort-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={!reviewed}
                  onClick={() => update(() => session.authorizeOnce(Date.now()))}
                >
                  仅授权这一次
                </button>
                <button type="button" onClick={() => update(() => session.cancel())}>
                  取消，不整理
                </button>
              </div>
              <button type="button" className="sort-change" onClick={restart}>
                改选去向
              </button>
            </div>
          ) : null}

          {authorized && selected ? (
            <div className="sort-step">
              <span className="sort-step-number">03</span>
              <h2>本次授权已就绪</h2>
              <p>
                只允许整理“稍后由你主动填写的一段文字”，五分钟内最多使用一次。
              </p>
              <div className="sort-grid-preview" aria-label="未来整理结果的固定结构">
                {['事实', '感受', '可控', '下一步'].map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
              <p className="sort-prototype-warning">
                本实验台没有输入框、Provider 调用或发送功能。下面只模拟消费授权回执。
              </p>
              <div className="sort-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    update(() => session.consumeAuthorization(Date.now(), providers[selected]))
                  }
                >
                  模拟使用一次授权
                </button>
                <button type="button" onClick={() => update(() => session.cancel())}>
                  取消并清除授权
                </button>
              </div>
            </div>
          ) : null}

          {state.stage === "reauthorization_required" ? (
            <div className="sort-step">
              <span className="sort-step-number">↻</span>
              <h2>需要重新授权</h2>
              <p>{reasonText[state.reason]}</p>
              <p>Provider 请求：0；正文收集：0。</p>
              <button type="button" className="primary" onClick={restart}>
                重新查看去向
              </button>
            </div>
          ) : null}

          {state.stage === "cancelled" ? (
            <div className="sort-step">
              <span className="sort-step-number">✓</span>
              <h2>已取消，本次没有发送</h2>
              <p>去向和授权已经从本次状态中移除；正文收集与 Provider 请求均为 0。</p>
              <button type="button" className="primary" onClick={restart}>
                重新开始
              </button>
            </div>
          ) : null}
        </section>
      </section>

      <footer className="sort-boundary-footer">
        <strong>正式边界</strong>
        <span>
          这只是交互与授权顺序原型。专业复核、真实地区资源、Core Provider 和 Rust 单次能力凭证全部过门前，正式版继续隐藏“理一理”。
        </span>
      </footer>
    </main>
  );
}

function DestinationChoices({
  onChoose,
}: {
  onChoose: (destination: SortDestination) => void;
}) {
  return (
    <div className="sort-destination-choices" aria-label="选择数据去向">
      {(Object.keys(destinationDetails) as SortDestination[]).map((destination) => (
        <button type="button" key={destination} onClick={() => onChoose(destination)}>
          <span className={`sort-destination-icon is-${destination}`} aria-hidden="true" />
          <strong>{destinationDetails[destination].title}</strong>
          <span>{destinationDetails[destination].subtitle}</span>
        </button>
      ))}
    </div>
  );
}

function DataFlow({ destination }: { destination: SortDestination }) {
  return (
    <div className="sort-data-flow" aria-label="本次数据流">
      <div>
        <strong>会使用</strong>
        <span>仅本次主动填写的正文</span>
      </div>
      <span className="sort-flow-arrow" aria-hidden="true">→</span>
      <div>
        <strong>交给</strong>
        <span>{destination === "local_provider" ? "本机 Provider" : "演示云服务"}</span>
      </div>
      <span className="sort-flow-arrow" aria-hidden="true">→</span>
      <div>
        <strong>返回</strong>
        <span>事实 / 感受 / 可控 / 下一步</span>
      </div>
      <p>不会附带：任务正文、文件、历史倾诉、长期记忆、工作区、剪贴板。</p>
    </div>
  );
}

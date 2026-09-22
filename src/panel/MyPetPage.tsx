import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../types";
import { onBackendEvent, tauriAvailable } from "../lib/backend";
import { confirmAction } from "../lib/confirmation";
import { SpriteAnimator } from "../pet/SpriteAnimator";
import type { AnimationName } from "../pet/manifest";
import { usePetProfile, petCommand, preparePetSnapshot, validatePetNickname, type PetPackSummary, type PetProfileSnapshot, type PetImportPreview } from "../pet/petProfile";

const scenePreviews: Array<[AnimationName, string]> = [
  ["spa-enter", "水疗进入"], ["spa-loop", "水疗休息"], ["spa-exit", "水疗结束"],
  ["meal-alert", "用餐提示"], ["meal-wait", "用餐等待"], ["hydration-alert", "补水提示"], ["hydration-wait", "补水等待"],
  ["work-focus-loop", "专注工作"], ["work-fatigue-enter", "疲劳过渡"], ["work-fatigue-loop", "工作疲劳"], ["work-recover", "恢复精神"],
  ["warmup-alert", "热身提示"], ["warmup-loop", "热身运动"], ["study-focus-loop", "学习装扮"], ["study-curious", "学习好奇"],
  ["night-enter", "夜间入睡"], ["night-loop", "夜间睡眠"], ["night-exit", "夜间醒来"],
];

export function MyPetPage({ settings, onBack }: { settings: AppSettings; onBack: () => void }) {
  const profile = usePetProfile();
  const [packs, setPacks] = useState<PetPackSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState(profile.nickname);
  const [animation, setAnimation] = useState<AnimationName>("idle");
  const [preview, setPreview] = useState<PetImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const errorNotice = useRef<HTMLParagraphElement>(null);
  const mounted = useRef(true);
  const pendingToken = useRef<string | null>(null);
  const catalogRequest = useRef(0);
  const pack = preview?.pack ?? packs.find((p) => p.packId === (selected ?? profile.effectivePackId)) ?? packs[0];
  const refresh = async () => {
    const request = ++catalogRequest.current;
    const next = await petCommand<PetPackSummary[]>("get_pet_catalog");
    if (mounted.current && request === catalogRequest.current) setPacks(next);
  };
  useEffect(() => {
    mounted.current = true;
    let cleanup: (() => void) | undefined;
    let disposed = false;
    void onBackendEvent("pet-catalog-updated", () => { void refresh().catch(() => {}); }).then(async (unlisten) => {
      if (disposed) { unlisten(); return; }
      cleanup = unlisten;
      await refresh();
    }).catch((reason) => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; mounted.current = false; catalogRequest.current++; cleanup?.(); if (pendingToken.current) void petCommand("cancel_pet_pack_import", { token: pendingToken.current }).catch(() => {}); };
  }, []);
  useEffect(() => { setName(profile.nickname); }, [profile.nickname, profile.effectivePackId]);
  useEffect(() => { setAnimation("idle"); }, [pack?.packId]);
  useEffect(() => {
    // Import controls may be below the fold; keep failed actions visible and
    // keyboard-reachable without smooth motion or relying on an animation.
    if (error) {
      errorNotice.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
      errorNotice.current?.focus({ preventScroll: true });
    }
  }, [error]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); } catch (reason) {
      if (mounted.current) setError(String(reason));
      try { await preparePetSnapshot(await petCommand<PetProfileSnapshot>("get_pet_profile")); } catch { /* keep current pet */ }
    } finally { if (mounted.current) setBusy(false); }
  };
  const change = async (command: string, args: Record<string, unknown> = {}) => {
    const result = await petCommand<PetProfileSnapshot>(command, { ...args, expectedRevision: profile.revision });
    await preparePetSnapshot(result); await refresh();
  };
  const cancelPreview = async () => {
    if (pendingToken.current) await petCommand("cancel_pet_pack_import", { token: pendingToken.current });
    pendingToken.current = null; setPreview(null);
  };
  return <section className="my-pet-page" aria-labelledby="my-pet-heading" aria-busy={busy}>
    <button type="button" className="secondary" onClick={onBack}>返回设置</button>
    <h2 id="my-pet-heading">我的宠物</h2>
    <p>给陪伴你的宠物起个名字，或换一个喜欢的形象。</p>
    {profile.fallbackReason && <p role="status" className="pet-pack-warning">{profile.fallbackReason}</p>}
    {error && <p ref={errorNotice} role="alert" tabIndex={-1} className="form-error">{error}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void run(async () => { const value = validatePetNickname(name); await change("set_pet_nickname", { packId: profile.effectivePackId, value }); setMessage("昵称已保存。"); }); }}>
      <label htmlFor="pet-nickname">当前宠物的昵称</label>
      <input id="pet-nickname" value={name} onChange={(event) => setName(event.target.value)} disabled={busy} autoComplete="off" aria-describedby="pet-nickname-hint" />
      <small id="pet-nickname-hint">1–24 个字符，每个形象分别记住昵称。</small>
      <div className="pet-page-actions">
        <button className="primary" disabled={busy} type="submit">保存昵称</button>
        <button className="secondary" disabled={busy} type="button" onClick={() => void run(async () => { await change("set_pet_nickname", { packId: profile.effectivePackId, value: null }); setMessage("已使用原名。"); })}>使用原名</button>
      </div>
    </form>
    {pack && <section className="pet-pack-preview" aria-label="形象预览">
      <div className="pet-pack-stage"><SpriteAnimator key={pack.packId} previewPack={pack} animation={animation} settings={settings} /></div>
      <strong>{pack.displayName}{preview ? " · 导入预览" : ""}</strong>
      <label>预览动作<select value={animation} onChange={(event) => setAnimation(event.target.value as AnimationName)}>
        <option value="idle">安静待机</option><option value="sleeping">睡眠</option><option value="eating-food">吃粮互动</option><option value="pet-nuzzle">摸摸</option>
        {pack.capabilities.learning && <optgroup label="学习动作"><option value="learning-study-sit">安静学习</option><option value="learning-study-curious">学习好奇</option><option value="learning-press-correct">答对反馈</option><option value="learning-press-wrong">答错反馈</option></optgroup>}
        {pack.capabilities.scene && <optgroup label="情境装扮">{scenePreviews.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</optgroup>}
      </select></label>
      <p>{pack.capabilities.learning ? "支持学习动作" : "学习时使用安静坐姿"}；{pack.capabilities.scene ? "支持情境装扮" : "情境装扮使用基础动作"}。</p>
    </section>}
    {preview ? <section className="pet-import-review" aria-label="导入确认">
      <h3>确认加入这个形象</h3>
      <details><summary>素材许可说明</summary><pre>{preview.license}</pre></details>
      <p>{preview.alreadyInstalled ? "已存在相同的宠物包，将直接复用。" : "加入后可在下方列表切换使用。"}</p>
      <div className="pet-page-actions">
        <button className="primary" disabled={busy} onClick={() => void run(async () => { await petCommand("commit_pet_pack_import", { token: preview.token }); pendingToken.current = null; setPreview(null); await refresh(); setMessage("宠物包已加入列表。"); })}>确认加入</button>
        <button className="secondary" disabled={busy} onClick={() => void run(cancelPreview)}>取消导入</button>
      </div>
    </section> : <button type="button" className="primary" disabled={busy || !tauriAvailable()} onClick={() => void run(async () => {
      const result = await petCommand<PetImportPreview | null>("preview_pet_pack_import");
      if (!result) return;
      if (!mounted.current) { await petCommand("cancel_pet_pack_import", { token: result.token }); return; }
      pendingToken.current = result.token; setPreview(result);
    })}>导入宠物包</button>}
    {!tauriAvailable() && <small>本地宠物包导入在桌面应用中使用。</small>}
    <div className="pet-pack-list" aria-label="已安装形象">{packs.map((item) => <article key={item.packId} className="pet-pack-card">
      <img src={item.fallbackImage} alt="" width="64" height="70" />
      <div><strong>{item.displayName}</strong><small>{item.builtin ? "内置形象" : "本地宠物包"}{item.packId === profile.effectivePackId ? " · 正在使用" : ""}</small>
        <div className="pet-page-actions">
          <button className="secondary" disabled={busy || Boolean(preview)} onClick={() => setSelected(item.packId)}>预览</button>
          <button className="primary" disabled={busy || Boolean(preview) || item.packId === profile.effectivePackId} onClick={() => void run(async () => { await change("activate_pet_pack", { packId: item.packId }); setSelected(item.packId); setMessage("已切换形象。"); })}>使用此形象</button>
          {!item.builtin && <button className="secondary" disabled={busy || item.packId === profile.selectedPackId || Boolean(preview)} onClick={() => void run(async () => {
            if (!(await confirmAction(`移除“${item.displayName}”的本地副本和昵称？原始宠物包文件会保留。`)) || !mounted.current) return;
            await change("remove_pet_pack", { packId: item.packId }); setSelected(null); setMessage("本地副本已移除，可用原始文件重新导入。");
          })}>移除</button>}
        </div>
      </div>
    </article>)}</div>
    <button type="button" className="secondary" disabled={busy || Boolean(preview)} onClick={() => void run(async () => { await change("reset_pet_profile"); setSelected(null); setMessage("已恢复圆圆及默认昵称，其他形象仍保留。"); })}>恢复默认宠物</button>
    <p className="pet-backup-note">备份保存昵称与形象选择。请保留原始宠物包，换电脑后可重新导入。</p>
  </section>;
}

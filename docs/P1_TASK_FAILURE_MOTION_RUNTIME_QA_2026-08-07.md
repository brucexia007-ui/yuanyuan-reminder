# P1 任务失败陪伴动作运行验收（2026-08-07，2026-08-09 更新）

## 结论

任务“没成功”后的有限动作已经在当前 144 DPI（150%）交互式 Windows 桌面取得可重复、隔离、隐私安全且关闭失败的真实 Tauri 正向证据。完整动态 24 帧中有 16 个不同帧，可看出一次短暂察觉后收束到安静陪伴；减少动态 24 帧只有 1 个不同帧，直接使用稳定姿态。两种模式的失败牌和固定无障碍语义持续存在，没有猫咪对白。

P1-E10 当前单环境真实窗口门已关闭；多档 DPI、高对比度、文本缩放、Narrator、真实签名 Hook 与正式签名候选仍保持开放。三场景汇总结论见 `P1_TASK_CUE_MOTION_QA_2026-08-07.md`。

## 验收链

- 非默认 `runtime-qa` 配置 `task-failure-motion` 只显示正式宠物窗口并隐藏任务面板；默认正式主程序的二进制边界阻止收录该配置；
- `failed-only` 夹具以生产认证协议向隔离 AI 库写入一条 Claude Code 权威失败终态；未知、缺值和重复参数关闭失败；
- 夹具只接受固定白名单的 `always` 或 `off` 动画模式，不修改正式设置；
- 采样器等待真实窗口初始化，再从 Windows UI Automation 查找固定生产语义“圆圆发现任务没有成功，正在你身边陪着”；
- 应用启动前先放置不可激活的中性灰隐私背景，截图只覆盖宠物窗口矩形；背景辅助进程必须保持存活并受控退出；
- 以 80 毫秒间隔连续采集 4 秒。完整动态至少 4 个不同帧，减少动态最多 2 个不同帧；
- 批次独占锁阻止并发运行。应用、背景或带标记隔离目录任一步退出/清理失败，仍会生成 `passed=false` 报告。

## 运行方式

```powershell
npm.cmd run runtime:qa:build
npm.cmd run runtime:task-failure-motion
```

如果 `python` 不在 PATH，可直接调用脚本并显式传入受信任的 Python 路径：

```powershell
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts\measure_task_failure_motion.ps1 -PythonPath C:\path\to\python.exe
```

## 当前证据

- runtime-QA 候选 SHA-256：`1FEDA5868E52A39ED6AB51E8173BE90D4A63F64FC026EF52CBD1AC327E6E8F72`；
- 报告：`src-tauri/target/runtime-qa/release/evidence/task-expression-motion-20260808T164626Z-failed-only.json`；
- 报告 SHA-256：`85400A1DAB0AF129B8504ED3E5FC2AD63D530F4BAFA7219F8007B4DFF5B5214A`；
- `always`：运行与无障碍状态就绪，24 帧、16 个不同帧，隐私背景与应用均受控退出，隔离根已删除；
- `off`：运行与无障碍状态就绪，24 帧、1 个不同帧，隐私背景与应用均受控退出，隔离根已删除；
- 最终结果：`passed=true`。

人工复核联系表确认一次失败察觉后收束，失败牌不消失，角色比例与动作连续，背景只有中性灰色。该结论由 `task-expression-motion-visual-review-20260808T165400Z.json` 的哈希绑定，并由独立校验器复核。

报告文件名使用 UTC，因此日期为 2026-08-08；对应本地时区为 2026-08-09。2026-08-06 的 `setup-entered` 失败报告保留为历史环境记录，不代表当前候选。

## 剩余发布标准

单一 DPI 的通过结果不能替代 100%/125%/200% DPI、高对比度、文本缩放和 Narrator 人工验收，也不能替代真实签名 Hook、睡眠/锁屏或正式签名候选证据。

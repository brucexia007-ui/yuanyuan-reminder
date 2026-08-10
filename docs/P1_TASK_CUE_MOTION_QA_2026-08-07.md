# P1 任务提示动作语义与有限播放验收（2026-08-07，2026-08-09 更新）

## 结论

任务守望动作现已区分“短暂提示动作”和“持续安静姿态”，并修复 `stay_close` 多语义共用导致的错误失败表演：只有固定无障碍状态 `task_failed` 可以播放一次 `failed`；任务运行较久、用户主动选择“只陪我一会”和普通“陪在身边”回应都直接使用 `focus-calm`。

“需要用户”和“检查任务”也从无限循环收紧为一次性动作。铃铛与抬爪提示完成后进入 `waiting`，检查/收起任务牌完成后进入 `focus-calm`；任务牌、来源、固定标签和无障碍状态继续保留。减少动态模式跳过抬爪、庆祝、失败和检查动作，只留下等价的固定道具与安静姿态。

2026-08-09 已在当前 144 DPI（150%）交互式 Windows 桌面关闭 P1-E10 的单环境真实 Tauri 动作门：失败、等待用户和疑似停滞三类场景的完整动态与减少动态共 6 个样本全部通过，且人工视觉复核确认动作语义、一次性收束、固定道具和隐私背景正确。多档 DPI、高对比度、文本缩放和 Narrator 仍是发布前体验门。

## 修复的语义冲突

Rust 稳定核心有意复用 `StayClose` 姿态表达：

- 任务没有成功后的陪伴；
- 任务运行较久时在电脑旁守着；
- 用户主动发起“只陪我一会”；
- 模型受限回应中的“陪在身边”。

前端此前只依据姿态选择动画，把所有 `stay_close/full` 都映射为 `failed`。这会把普通陪伴和长运行错误表现成失败，违背“圆圆不把工作压力转化为用户照顾小猫的压力”的设计原则。现在动画选择同时核对固定 `accessibleState`，不读取任务正文或自由文本。

## 有限动作规则

| 语义 | 完整动态首次动作 | 完成后 | 减少动态 |
| --- | --- | --- | --- |
| 需要用户/喝水/到期事项 | `alert-glass-paws` | `waiting` | `waiting` 静态首帧 |
| 任务没成功 | `failed` | `focus-calm` | `focus-calm` |
| 可能停住/状态未知/已取消/正式让出位置 | `review` | `focus-calm` | `focus-calm` |
| 任务完成 | `jumping` | `idle` | `focus-calm` |
| 长时间运行/普通陪伴 | `focus-calm` | 持续安静 | `focus-calm` |

`failed`、`review` 和 `alert-glass-paws` 的正式与回退清单均为 `loopStart=null`。持续循环只保留给 `waiting`、`focus-calm`、运行守望、睡眠呼吸等环境姿态。

## 自动与浏览器证据

- 开发实验台真实点击证明长时间运行保持 `focus-calm`，需要用户从 `alert-glass-paws` 收束到 `waiting`，疑似停滞从 `review` 收束到 `focus-calm`；
- 减少动态下，需要用户为 `waiting`，完成、失败、停住、取消和未知均为 `focus-calm`；
- 动画清单测试冻结三个提示动作均不可循环，全部动画与图集资源校验通过；
- 固定无障碍语义持续存在，不使用任务正文、自由文本或猫咪对白决定动作。

浏览器证据用于检查 React 状态过渡和布局；以下隔离运行证据用于验证正式 Tauri/WebView 窗口，但仍不替代多 DPI、屏幕阅读器或真实签名 Hook 验收。

## 隔离运行与隐私证据

任务守望夹具的 `failed-only`、`waiting-user-only` 与 `stalled-only` 共用生产认证协议、隔离 AI 库、固定动画设置、批次独占锁和带标记安全清理。采样器在应用启动前创建不可激活的全虚拟桌面中性灰背景，应用可见启动后只截取宠物窗口矩形；背景辅助进程、应用进程和隔离根都必须受控退出/清理，否则报告关闭失败。这样不会把桌面、路径、通知或其他应用内容带入视觉证据。

每个场景分别运行完整动态与减少动态，均采集 24 帧：

| 场景 | 完整动态不同帧 | 减少动态不同帧 | 视觉结论 |
| --- | ---: | ---: | --- |
| 任务没成功 | 16 | 1 | 一次失败察觉后收束，失败牌持续可见 |
| 等待用户 | 21 | 1 | 一次抬爪提示后进入带铃铛的等待姿态 |
| 可能停住 | 16 | 1 | 一次检查/收拢后保持疑似停滞任务牌 |

三份 schema v6 报告均满足：运行阶段就绪、固定无障碍语义出现、预启动隐私背景在位、应用和背景受控退出、隔离根删除、完整动态不同帧不少于 4、减少动态不同帧不多于 2。

## 当前正式证据

- runtime-QA 候选 SHA-256：`1FEDA5868E52A39ED6AB51E8173BE90D4A63F64FC026EF52CBD1AC327E6E8F72`；
- 失败报告：`task-expression-motion-20260808T164626Z-failed-only.json`，SHA-256 `85400A1DAB0AF129B8504ED3E5FC2AD63D530F4BAFA7219F8007B4DFF5B5214A`；
- 等待用户报告：`task-expression-motion-20260808T164408Z-waiting-user-only.json`，SHA-256 `31CE33FD6F4027B704A058D4D4AC32BE232E7AF35808E7EA1AE82C506EC5C76A`；
- 疑似停滞报告：`task-expression-motion-20260808T164748Z-stalled-only.json`，SHA-256 `E02B5455643C818E3A1E8D971F0A610320844E1BA61A08A564EAEC991C5BDAA6`；
- 视觉复核清单：`task-expression-motion-visual-review-20260808T165400Z.json`，SHA-256 `E6B560FB1E8D6458BB25C4932FCE8601A0F152CDCA4E0DC592918DA5FC5F257A`。

视觉复核清单绑定主程序、任务夹具、测量脚本、截图脚本、中性背景脚本、三份报告、六张联系表和六个 GIF。独立校验器会拒绝来源漂移、缺场景、错模式、错哈希、隐私背景未受控或减少动态超过两帧；4 项回归覆盖 BOM、视觉哈希漂移、脚本漂移、乐观隐私声明、语义缺失和减少动态失守。

```powershell
npm.cmd run runtime:task-expression-motion:evidence:test
$manifest = (Resolve-Path "src-tauri\target\runtime-qa\release\evidence\task-expression-motion-visual-review-20260808T165400Z.json").Path
npm.cmd run runtime:task-expression-motion:verify -- --manifest $manifest
```

2026-08-06 的两份 `runtimeStageReady=false` 报告保留为历史环境失败记录，不代表当前候选。探索中产生的 24 个无效产物已删除，其中包括一组曾捕获桌面背景的隐私敏感截图，不能恢复，也不会进入正式证据链。

## 剩余边界

本结论只关闭当前机器、当前 150% DPI、合成认证事件和隔离 runtime-QA 候选的动作连续播放门。仍需完成 100%/125%/200% DPI、高对比度、文本缩放、Narrator、全应用键盘、真实签名 Hook、睡眠恢复、锁屏与正式签名候选复测。

# REL-001 呈现权协调器与宠物快照验收记录

日期：2026-08-14；当前二进制正式门更新：2026-08-21<br>
分支：`feat/fragment-learning-stage-0-1`

## 实现边界

- 新增纯进程内 `PresentationArbiter`；租约不写入 SQLite，重启不恢复旧租约。
- 租约 ID、优先级、可抢占性和 revision 只由 Rust 后端生成。
- 固定优先级为：锁定/认证 120、强提醒 100、专注 90、喝水 80、活动/普通提醒 70、手动学习 60、任务观察 50、自动学习邀请 30、环境宠物 10。
- 强提醒不可抢占；学习会话可抢占；自动邀请低于手动学习。
- 释放必须同时匹配 `leaseId` 和租约 revision；旧释放请求不能清除新租约。
- 同一 owner 的重试只有在身份完全相同时才幂等；活动中的 `LearningSession` 不能用另一个 session ID 偷换同一租约。
- 稳定提醒的 `claim_due`、occurrence 状态和值域均未修改；Windows 锁定休息和认证路径未修改。

## 统一快照

后端新增 `PetActivitySnapshot`，并通过以下接口发布：

- 命令：`get_pet_activity_snapshot`
- 事件：`presentation-lease-changed`
- 事件：`pet-activity-snapshot-updated`

快照包含单调 revision、当前 activity/source、当前 lease ID、可恢复学习会话 ID 和 restore target。宠物窗口按 revision 丢弃旧事件；提醒卡片、专注动画、睡眠/唤醒和学习小黑板均以该快照为展示许可。托盘睡眠菜单也从同一快照判断睡眠或待恢复睡眠状态。学习中收到睡眠请求时，后端会先把活动会话持久化为可恢复暂停，再撤下学习租约并发布 `sleeping`；唤醒只切回 `interrupted` 可恢复态，不自动重开小黑板。

## 已覆盖场景

- 9 个呈现方的 72 个有序不同 owner 对全部按冻结优先级/可抢占合同执行；同优先级保持先到者。
- 覆盖全部 9 个呈现方的 64 路并发请求结束后只存在一个活动租约。
- 强提醒抢占学习，并保留可恢复学习会话 ID。
- 强提醒不可被专注等低优先级来源抢占。
- 手动学习抢占自动邀请。
- 强提醒结束后，仍有效的专注状态可重新取得租约。
- 睡眠请求撤下学习租约但保留同一可恢复会话；唤醒后仍保持可恢复，不自动抢回前台。
- 强提醒活动时睡眠只能排队；提醒释放后才进入睡眠，提醒优先级没有被睡眠绕过。
- 过期邀请释放进程内租约。
- 旧 lease ID/revision 不能释放新租约。
- 同一学习会话重试保持 lease/revision 不变，不同学习会话不能重绑已有租约。
- 前端丢弃旧 `PetActivitySnapshot.revision`。
- 默认构建仍通过 learning-off 边界扫描。

## 真实桌面强提醒抢占门

2026-08-21 使用仲裁器安全补强后隔离的 `runtime-qa,learning` release 构建执行 20 个真实 Tauri + Windows UI Automation 样本。每个样本先确认学习小黑板处于活动状态，再让真实强提醒到期并核对持久状态与可访问界面。正式报告：

`src-tauri/target/runtime-qa-learning-preemption/release/evidence/learning-reminder-preemption-20260821T141839Z.json`

| 指标 | P50 | P95 | 预注册门 |
| --- | ---: | ---: | ---: |
| 后端领取 | 7,419.9 ms | 13,435.0 ms | P95 ≤ 16,000 ms |
| 领取后持久化为 paused | 4.8 ms | 6.1 ms | P95 且每个样本 ≤ 1,000 ms |
| 领取后小黑板让位/提醒可访问 | 219.1 ms | 239.8 ms | P95 且每个样本 ≤ 1,000 ms |
| 端到端提醒呈现 | 7,641.3 ms | 13,670.2 ms | P95 ≤ 17,000 ms |

20/20 样本均把同一会话、同一题目和同一可见合成词从 `active` 原子转换为 `paused(reason=preempted_high_priority)`，revision 只增加 1，且恰有一条 `interrupted` 事件；答案、答题记录和复习日志均为零写入。提醒卡可访问，小黑板已撤下，进程受控退出，隔离根全部删除。

`verify_learning_reminder_preemption_evidence.mjs` 已从 20 个原始样本重算分位数，核对时间关系、状态迁移、零答题写入、应用/fixture/脚本/数据库绑定和预注册门。对应 9 项正反向测试通过。该报告关闭当前二进制的“真实学习中强提醒在 1 秒内让位”核心出口项；后端有序 owner 对合同虽已穷举，它仍不替代专注结束邀请、全优先级真实桌面时序竞态或完整 Windows 辅助功能人工矩阵。

当前正式报告绑定应用 `7BB252B6...5C7817`、fixture `40DF90CB...0621AA`、合成数据 `7DD33324...77EE5` 和测量脚本 `4EDF9124...EA72`。`learning-reminder-preemption-20260821T111501Z.json` 及 8 月 19 日的原二进制报告继续作为历史封存证据；沙箱窗口初始化失败的 `learning-reminder-preemption-20260821T140747Z.json` 为 0/20，不具备验收效力。所有正式样本的隔离根和应用进程均已清理。

## 真实桌面睡眠/唤醒状态链

2026-08-21 使用隔离的 `runtime-qa,learning` release 构建执行一次完整状态链，正式报告：

`src-tauri/target/runtime-qa-learning-sleep/release/evidence/learning-sleep-wake-20260821T143045Z.json`

脚本先在真实宠物窗口打开活动学习小黑板，再两次打开 Windows `#32768` 原生右键菜单并核对固定 11 项顺序及第 5 项“立即睡觉/叫醒圆圆”。睡眠后，同一 session/item/headword 从 `active(revision=2)` 变为 `paused(reason=preempted_high_priority, revision=3)`，恰增加一条 `interrupted`，答题、答案提交和复习日志均为零；`PetActivitySnapshot` 为 `sleeping/manual`、无租约、保留可恢复会话和 `restoreTarget=learning`。唤醒后数据库完全不变，快照变为 `interrupted/learning`，小黑板保持关闭。Windows 无障碍树分别识别“圆圆正在睡觉”和“圆圆已醒，上一轮学习可以继续”。5 张 PrintWindow 截图经人工查看，仅包含隔离应用的小黑板、原生菜单、睡眠姿态和唤醒姿态。

当前环境拒绝物理指针和系统输入注入，因此自动化在检查原生菜单及 command ID 后关闭菜单，再通过仅存在于 runtime-QA 构建的“精确文件名 + 空普通文件”控制入口调用生产菜单共用的 `pet-sleep` 处理函数。该入口拒绝未知文件名、非空文件和非普通文件；它没有进入默认或 Learning Preview 生产构建。`verify_learning_sleep_wake_evidence.mjs` 独立重算应用、fixture、脚本和 5 张截图哈希，并核对菜单、控制链、状态、快照、无障碍观察和限制声明，10/10 项正反向测试及正式报告复核通过。报告绑定应用 `3AB16BF4...15C635`、fixture `CBD131BD...CB93C5`、合成数据 `7DD33324...77EE5` 和脚本 `A9781242...ED2698`。

这关闭了“真实原生菜单内容 + 共用菜单处理器 + 状态机 + 动画/无障碍结果”的自动化证据，但**不关闭物理右键和 OS 级菜单选择**；后者以及 Narrator 实际听读仍须具名 Windows 人工验收。

## 真实窗口与辅助显示矩阵

2026-08-21 使用隔离的 `runtime-qa,learning` release 构建在当前真实 150% DPI 环境运行标准、减少动态和强制颜色三种白名单模式，正式报告：

`src-tauri/target/runtime-qa-learning-accessibility/release/evidence/learning-accessibility-matrix-20260821T145707Z.json`

标准模式通过 runtime-QA 的 Tauri 主线程精确调整真实 WebView 窗口，验证 360×560、390×620、480×760 学习页及 520×420 小黑板逻辑尺寸；每个窗口还必须完整位于当前显示器工作区。程序化模式分别激活 `prefers-reduced-motion: reduce` 和 `forced-colors: active`，可访问树出现对应状态。第一选项的名称、边界和可聚焦性由真实 Windows UI Automation 核对，DOM 回归测试证明呈现后自动取得焦点。6 张仅含测试应用窗口的 PrintWindow 截图经人工查看；强制颜色首轮发现的浅色文字问题修复并重建后才生成当前正式报告。

`verify_learning_accessibility_matrix_evidence.mjs` 独立复算应用、fixture、合成内容、样式、脚本和 PNG 哈希，从 PNG `IHDR` 重读物理尺寸，并核对工作区边界、UIA、模式状态、隔离根清理和限制声明；12/12 项正反向测试及正式报告复核通过。人工截图复核曾发现外部 Win32 调整只放大宿主而未同步 WebView，以及 DPI 虚拟化造成的裁切；这些机器字段一度为 ready 的诊断报告均不参与验收，改为 Tauri 主线程调整后才采纳当前报告。该报告关闭当前设备 150% DPI、固定窗口尺寸、可访问名称/可聚焦性和程序化媒体模式的工程风险；100/125/200% DPI、多屏/负坐标、Narrator、物理键盘以及从 Windows 设置实际切换减少动画/高对比度仍须具名人工验收。完整边界见 `QA_001_ACCESSIBILITY_MATRIX_EVIDENCE.md`。

## 验证结果

- `npm run check`：32 个测试文件、207 个测试通过。
- `npm run learning-off:verify`：通过；默认包未引入学习命令、界面、数据库名或内容资源。
- `cargo test -p yuanyuan-reminder --lib`：215 通过、1 个需 Windows 符号链接权限的既有测试忽略。
- `cargo test -p yuanyuan-reminder --lib --features learning`：279 通过、1 个需 Windows 符号链接权限的既有测试忽略。
- `cargo test -p yuanyuan-reminder --lib --features runtime-qa,learning runtime_qa::tests -- --test-threads=1`：运行时状态探针与受限控制入口共 10 项通过。
- 仲裁器定向测试：默认 12/12、learning 13/13；含 72 个有序 owner 对、64 路全 owner 并发、同会话幂等/跨会话拒绝，以及学习直接进入睡眠、学习被强提醒抢占后再睡眠、提醒活动时睡眠排队三条状态链；完整 `cargo test --workspace` 并行复验通过。
- 强提醒抢占 evidence verifier：9/9 项正反向测试通过，正式 20 样本报告复核通过。
- 睡眠/唤醒 evidence verifier：10/10 项正反向测试通过，正式状态链报告和 5 张截图复核通过。
- 窗口与辅助显示 evidence verifier：12/12 项正反向测试通过，正式 3 模式报告和 6 张截图复核通过。

2026-08-21 首次执行 `learning:foundation:verify` 的默认 Rust 并行总门时，既有进程级 `STATUS_ACCESS_VIOLATION` 再次出现；完整 Authenticode provider-state 生命周期随后按进程串行化。2026-08-24 刷新证据时，异常又在默认库第 3、4、13、45 轮等不同位置以 `0xC0000005` 复现；隔离矩阵表明，合成非 PE `.exe` 进入 `WinVerifyTrust` 是当前完整负载复现所需条件，而真实签名验证、合成路径或 connector 子集单独压力均不能稳定复现。生产适配器现先以有界位置读取核对 `MZ`、`e_lfanew` 和 `PE\0\0`，非 PE 文件不再进入 `WinVerifyTrust`，并保留原 provider-state 进程锁。修复后默认完整库 24 线程 100/100，当前正式门默认 20/20（215/1）、learning 10/10（279/1），零崩溃、零失败；报告与限制见 [QA-002](./QA_002_RUST_PARALLEL_STABILITY_EVIDENCE.md)。Windows Application/WER 没有故障模块且未取得 crash dump，因此只认定复现条件已隔离且当前缓解具重复性，不宣称精确原生指令或模块已根因闭环；若再现仍须捕获转储。

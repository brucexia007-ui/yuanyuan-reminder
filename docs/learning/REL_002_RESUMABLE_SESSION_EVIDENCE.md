# REL-002 可恢复学习会话证据

状态：代码与自动化验证完成；真实桌面杀进程恢复、强提醒 1 秒让位、原生菜单睡眠/唤醒状态链及当前 150% DPI 窗口/辅助显示矩阵已通过，其余 Windows/无障碍矩阵仍待人工

日期：2026-08-19；当前自动化证据更新：2026-08-24<br>
责任角色：Architecture + Database + Windows QA

## 用户可见结果

- `Esc` 不再只有“结束本轮”：用户可选择“暂停，稍后继续”或“结束本轮”。
- 暂停会保留当前题、已答记录和本轮进度；学习首页显示“继续上一轮”。
- 强提醒抢占把会话持久化为 `paused(reason=preempted_high_priority)`，`interrupted` 只作为追加事件，不再是稳定状态。
- 学习中请求睡觉使用同一高优先级暂停路径；睡眠期间保留可恢复会话 ID，唤醒后不自动弹出小黑板。
- 应用在活动会话中被终止后，下一次打开数据库会原子转为 `paused(reason=crash_recovery)`；不会自动弹出小黑板。
- runtime-QA 在答案事务的 SQLite commit callback 内终止进程时，未提交选择不会留下作答、复习、排程推进、答题事件或完成数；重启后仍恢复原题。
- 以最后活动时间为基准 24 小时过期。过期或主动结束只释放未答卡，不把它们计错，也不改其调度。

## 数据合同

稳定状态为：

```text
created → active ↔ paused → completed
                   ↘ abandoned
                   ↘ expired
```

`learning_sessions` 现包含 `state_revision`、`current_item_id`、暂停时间/原因、最后活动时间和过期时间。所有暂停、恢复和放弃命令必须带 `expectedRevision`；答题继续使用唯一 `clientAnswerId` 保证幂等，旧翻卡评分路径也增加了版本检查。

`learning_session_events` 是 append-only 事件表，记录创建、呈现、暂停/抢占、恢复、答题提交、完成、放弃、过期、崩溃恢复和迁移。状态更新与事件写入在同一 SQLite immediate transaction 中完成。

## v5→v6 会话迁移

| v5 | v6 | 迁移行为 |
| --- | --- | --- |
| `active` | `paused` | `pause_reason=migration_recovery`，不自动弹板 |
| `interrupted` | `paused` | 保留原 `exit_reason` 为暂停原因 |
| `completed` | `completed` | 结束时间与已答记录保留 |
| `exited` | `abandoned` | 已答记录保留 |

迁移会为每个旧会话补一条 `migrated` 事件。允许旧库中存在多个历史 paused 会话；运行时只允许一个 active 呈现，首页选择最近活动的可恢复会话。

## 自动化证据

- 前端：`npm.cmd run check`，32 个测试文件、207 项测试通过。
- Rust learning-on：`cargo test -p yuanyuan-reminder --lib --features learning`，279 项通过、1 项权限相关测试忽略。
- 定向覆盖：合法/非法转换、陈旧 revision、原题恢复、崩溃恢复、TTL、未答调度不变、v5 状态映射、原生备份恢复、暂停/结束文案与操作。
- 答题事务故障注入：客观选择题和旧 recall 路径各覆盖三种失败——最深的 `answer_committed` 事件语句执行 SQLite `ABORT`、所有语句完成后由 deferred foreign key 在真正 `transaction.commit()` 处拒绝提交，以及数据库页预算耗尽返回真实 `SQLITE_FULL`；六条路径均证明排程、复习日志、作答记录和会话进度全部回滚，错题队列与事件计数保持答题前值，随后可用原 `clientAnswerId` 或原 revision 成功重试。
- runtime-QA-only commit hook：3 项 Rust 测试证明精确 arm 才会进入 SQLite commit callback、无 arm 时提交不受影响、非空控制文件会失败关闭并回滚；默认构建和普通 learning 构建不包含该能力。
- REL-001 呈现协调器测试覆盖 9 个呈现方的 72 个有序不同 owner 对和 64 路全 owner 并发，继续证明冻结优先级、唯一租约、陈旧释放失败，以及不同学习会话不能重绑已有租约。

### 答题事务精确故障注入

第一组测试在同一 SQLite 连接上创建仅限测试的临时触发器，当 `learning_session_events.event_kind='answer_committed'` 时执行 `RAISE(ABORT)`。这个位置晚于 FSRS 排程与复习日志、会话完成数，以及客观题作答记录等写入，因此能确定性触发最深的提交前语句失败。

第二组测试的临时触发器在 `answer_committed` 写入后追加一条引用不存在 session 的事件，再启用 `PRAGMA defer_foreign_keys=ON`。因此答题路径内所有 SQL 都能完成，失败只会发生在真正的 `transaction.commit()`，SQLite 返回 `FOREIGN KEY constraint failed`。测试同时确认失败后 deferred-FK 状态已随事务恢复，避免故障注入污染同一连接上的重试。

第三组先建立测试专用压力表，将 `max_page_count` 固定到当前 `page_count`，再让 `answer_committed` 的 AFTER 触发器尝试写入 1 MiB `zeroblob`。SQLite 因无法分配新页返回真实 `SQLITE_FULL`/`DiskFull`；失败后逻辑页数没有增长。该方法确定性覆盖 SQLite 页预算耗尽，但不冒充物理卷空间耗尽、I/O 硬件错误或 Windows 文件系统行为。

客观选择题与 recall 六条路径都在失败前后逐项比较会话快照、完整排程元组、复习/作答/错题队列/事件计数，并执行 `integrity_check` 与 `foreign_key_check`；结果完全一致。撤下触发器或解除页上限后，选择题复用同一 `clientAnswerId`、recall 复用同一 revision，均只产生一次有效复习并正常完成会话。该证据分别关闭 repository 层“答题事务中数据库语句失败”“SQLite `COMMIT` 明确返回错误”与“SQLite 返回 `SQLITE_FULL`”是否留下半写入的缺口；下述真实进程门另行覆盖 SQLite commit callback 内终止。两类证据都不模拟真实断电、物理磁盘满或 I/O 硬件错误。

## 真实 Windows 恢复与让位证据

### 已提交答案：杀进程后恢复下一未答题

正式报告：`src-tauri/target/runtime-qa-learning-recovery/release/evidence/learning-crash-recovery-20260824T165841Z.json`。

5/5 个真实 Tauri 样本均先在活动小黑板提交第 1 题，并等待 SQLite 中恰有 1 条 `answer_committed`、1 条答题记录和 1 条复习日志；界面切到不同的第 2 个未答题后，脚本只终止路径精确匹配的 QA 应用进程。每轮终止后、任何重启前都观测到 262,144 bytes 主库、127,752 bytes 非空 WAL 和 32,768 bytes 非空 SHM，并分别记录 SHA-256；随后才以同一隔离数据根重启。启动时活动会话原子变为 `paused(reason=crash_recovery)`，首页出现“继续上一轮”；点击后恢复同一 session、同一未答 item 和同一可见合成词。

四阶段计数均为 `0 → 1 → 1 → 1`：提交前为零，崩溃前、重启后、继续后均恰为 1；最后已答 item/headword/outcome 全程一致，当前未答 item 与已答 item 不同。5 个样本同时覆盖正确和错误首答结果。当前候选恢复入口可用 P50/P95 为 748.9/789.7 ms，点击继续到原题小黑板 P50/P95 为 403.5/411.4 ms；方案未为后者设置性能门，这些数值只属于当前哈希绑定 QA 二进制。每个样本都恰有一条 `crash_recovered` 和一条 `resumed` 事件；commit hook 均未 arm、未进入；`integrity_check=ok`、`foreign_key_check` 零违规，第二次退出受控，即使受控退出后 WAL/SHM 仍存在，5 个隔离根也都能完整删除，证明没有遗留文件句柄阻止清理。

### 未提交选择：SQLite commit callback 内终止

正式报告：`src-tauri/target/runtime-qa-learning-recovery/release/evidence/learning-in-flight-commit-recovery-20260824T165518Z.json`。

5/5 个真实 Tauri 样本均在原题零作答状态下精确 arm runtime-QA-only 控制文件；答案路径执行完全部 SQL、紧邻 `transaction.commit()` 标记 pending 后，SQLite commit hook 写入已进入标记并阻塞在 callback 内，脚本随后只终止路径精确匹配的 QA 应用进程。进入 callback P50/P95 为 43.8/55.1 ms。每轮重启前均观测到 57,712 bytes 非空 WAL 和 32,768 bytes 非空 SHM；重启、继续后作答、复习、答题事件、排程推进和完成数仍全部为 0，session/item/headword 与提交前原题一致，5/5 均明确记录 `uncommittedAnswerAbsent=true`。

恢复入口可用 P50/P95 为 722.5/765.4 ms，点击继续到原题小黑板 P50/P95 为 398.8/547.7 ms。每轮均只有一次 crash recovery 和一次 resume，数据库完整性/外键检查健康，第二次退出受控且隔离根可完整删除。该 hook 只在 `runtime-qa,learning` 构建中由严格空控制文件启用；默认与普通 learning 构建既不安装 hook，也没有对应控制能力。

`verify_learning_crash_recovery_evidence.mjs` 已分别复核 committed 与 in-flight-commit 报告的 5 个原始样本、场景合同、四阶段状态/revision/事件、答案身份与计数、hook arm/entered 状态、异常终止后的 WAL/SHM、应用/fixture/脚本/数据库绑定及清理结果；对应 12 项正反向测试通过。两份报告共同关闭受控 QA 环境中“已提交答案不丢不重算”和“SQLite commit callback 内终止时未提交选择零可见写入”两侧缺口。它们不覆盖 callback 之后每个更晚的 durable-write/硬件断电点、损坏日志、真实断电、物理磁盘满或硬件 I/O 错误；repository 的六条确定性故障注入另行证明最深提交前语句失败、SQLite 明确拒绝 `COMMIT` 及返回 `SQLITE_FULL` 均不会留下半写入。

### 学习中强提醒让位

正式报告：`src-tauri/target/runtime-qa-learning-preemption/release/evidence/learning-reminder-preemption-20260821T141839Z.json`。当前二进制 20/20 样本通过；强提醒领取后会话持久化暂停 P95 6.1 ms，小黑板让位并出现可访问提醒 P95 239.8 ms，两个让位指标逐样本均低于 1 秒。详情与边界见 `REL_001_PRESENTATION_ARBITER_EVIDENCE.md`。

独立 verifier 已核对当前应用、fixture、合成数据、脚本和数据库绑定并重算 20 个原始样本；9 项正反向 verifier 测试通过。8 月 19 日旧二进制报告和沙箱窗口初始化失败报告继续保留为历史证据，不参与当前候选验收。

### 学习中睡眠与唤醒

正式报告：`src-tauri/target/runtime-qa-learning-sleep/release/evidence/learning-sleep-wake-20260821T143045Z.json`。真实原生菜单两次打开并暴露固定“立即睡觉/叫醒圆圆”项；共用菜单处理器使活动会话只暂停一次，保留原 session/item/headword、零答案写入和可恢复 ID。睡眠无租约，唤醒后仍为 `paused`/`interrupted`，小黑板不自动重开；Windows 无障碍树识别睡眠和可继续提示，5 张应用窗口截图经人工查看。独立 verifier 10/10 项正反向测试及正式报告通过。

由于当前环境阻止物理指针和系统输入注入，自动化检查原生菜单后通过 runtime-QA 专用受限入口调用生产菜单共用处理函数；物理右键与 OS 级菜单选择仍属于人工门，不能由该报告代替。完整边界见 `REL_001_PRESENTATION_ARBITER_EVIDENCE.md`。

### 窗口、焦点与辅助显示

正式报告：`src-tauri/target/runtime-qa-learning-accessibility/release/evidence/learning-accessibility-matrix-20260821T145707Z.json`。当前真实 150% DPI 下，runtime-QA 从 Tauri 主线程调整真实 WebView 窗口，360×560、390×620、480×760 学习页和 520×420 小黑板均精确命中逻辑尺寸并完整位于显示器工作区；DOM 测试证明第一选项自动获得焦点，真实 Tauri UIA 证明选项可聚焦且名称/边界正确。程序化白名单分别激活减少动态和强制颜色媒体状态，可访问树确认对应状态；6 张应用窗口截图经人工查看。人工复核淘汰了外部宿主缩放导致 WebView 未同步和 DPI 虚拟化裁切的诊断报告；独立 verifier 12 项正反向测试及当前正式报告通过。完整边界见 `QA_001_ACCESSIBILITY_MATRIX_EVIDENCE.md`。

## 尚未替代的人工门

- 自动恢复门成对覆盖“已提交 1 题后异常终止仍只计一次”和“答案 SQL 完成后在 SQLite commit callback 内终止仍零可见写入、恢复原题”，并在两侧都确认非空 WAL/SHM、主库健康和测试根可清理；repository 另覆盖最深提交前数据库语句失败、SQLite 明确拒绝 `COMMIT`、页预算耗尽返回 `SQLITE_FULL` 和原样重试。仍未覆盖 callback 后每个更晚的 durable-write/硬件断电点、损坏日志、真实断电、只读/物理磁盘满/I/O 错误，或一次提交多题后的所有人工浏览路径。
- 自动抢占门覆盖强提醒到达后的持久化与界面让位；后端已穷举全部 72 个有序不同 owner 对及全 owner 并发合同；睡眠/唤醒门覆盖真实原生菜单内容、共用处理器、持久暂停、租约撤下、动画与 Windows 无障碍树，但物理右键/OS 级选择、Narrator 实际听读和喝水/活动/专注/任务守望的真实桌面时序组合仍待人工。
- 当前 150% DPI 的 360×560、390×620、480×760 和 520×420 已通过；100/125/200% DPI、多屏/负坐标、物理键盘/Narrator、Windows 设置实际切换减少动画和高对比度仍待人工。
- 本迁移当前只冻结 REL-002 会话部分。GEN-000 冻结前仍须把通用学习项和内容包表的最终 v6 定义合并进同一未发布迁移；不得以当前会话迁移单独发布阶段 1。

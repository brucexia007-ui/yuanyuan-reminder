# 阶段 0 / 阶段 1 逐项完成度审计

日期：2026-08-25<br>
依据：`YUANYUAN_FRAGMENT_LEARNING_DEVELOPMENT_PLAN.md` 任务卡、最小门、阶段出口与 No-Go 约束<br>
判定口径：只有任务卡验收和所需真实证据都关闭才记为“完成”；自动化通过不替代真实用户、Windows 人工矩阵、内容权利或具名签字

## 总结

- 阶段 0：**未达到出口**。SCM-001、REL-001、REL-002 的工程交付已完成；后端已穷举全部 72 个有序不同呈现方组合及全 owner 并发，当前 QA 二进制已通过真实桌面“学习中强提醒 1 秒让位”20/20、已提交答案异常终止恢复 5/5、SQLite commit callback 内终止时未提交选择零写入 5/5、一次原生菜单睡眠/唤醒完整状态链，以及当前设备 150% DPI 的窗口/辅助显示矩阵。PERF-001 的 2 小时学习内存与 pre-GEN 纯解析不确定性、纯解析逐卡循环的有界进度/协作取消，以及 16 KiB 解码输入和单卡内部取消粒度，连同 SEC-001 内容层 001—011 已关闭；UX-RESEARCH-001 的独立合成执行包和隐私/构建隔离检查也已补齐，但内部试跑和真实参与者研究没有执行。真实 Tauri 导入/取消/分页/DB、token/半安装、其余 Windows/无障碍人工矩阵与具名处置仍有明确缺口。
- GEN-000：**仅为 draft，未冻结**。冻结输入不完整且签字表为空。
- 阶段 1：**保持 No-Go**。PACK-001/002/003/004、DATA-001 不得因已有英语 Preview 代码而被误记为通用内容包交付。
- 公开发布、公开词库、远程源、第二学科、AI 制卡/老师和学习效果宣传继续保持 No-Go。

## 任务卡审计

| 任务 | 当前判定 | 已有证据 | 尚未关闭的验收/停止门 |
| --- | --- | --- | --- |
| SCM-001 | 完成 | `SCM_001_CHANNEL_ISOLATION_AUDIT.md`；通用分支从无个人内容的 `main` 重建；denylist、源码/历史/产物边界脚本；learning-off 与 Learning Preview 独立构建 | 真实安装交互属于阶段集成人工矩阵，不推翻本任务的通道隔离结论 |
| REL-001 | 工程与核心真实桌面门完成；其余人工项待验 | `REL_001_PRESENTATION_ARBITER_EVIDENCE.md`、[QA-004](./QA_004_CURRENT_MACHINE_WINDOWS_RUNTIME_EVIDENCE.md)、[QA-005](./QA_005_ACTUAL_WINDOWS_SETTINGS_EVIDENCE.md)；9 个呈现方的 72 个有序不同 owner 对、64 路全 owner 并发、单一租约、跨学习会话拒绝、陈旧 revision/lease、防回归和统一 `PetActivitySnapshot`；提交 `ee48194` 的当前 QA 二进制活动学习中强提醒让位 20/20，持久化/UI P95 5.8/258.2 ms；原生菜单睡眠/唤醒状态链通过；150% DPI 的固定窗口、工作区边界、可聚焦性、减少动态/强制颜色和 6 张截图通过独立 verifier；提交 `ba6e841` 的真实标准系统模式和 Narrator 运行中并发探针各通过一次 | 物理右键与 OS 级菜单选择、专注结束邀请、真实桌面全优先级时序竞态、100/125/200% DPI、多屏/负坐标、Narrator 人工听读/物理键盘和系统设置实际切换仍需具名 Windows QA 记录 |
| PERF-001 | 部分完成 | 同工作树 learning-off/on 冷/温启动各 20 次；学习页与小黑板各 20 次；强提醒各 20 次；2 小时 learning-on 完成黑板稳态 121 个样本；pre-GEN 纯解析 JSON/CSV 4,533/20,000 共 30 个 release 样本，20,000 卡同时达到 26,020,105/26,120,061 bytes，按 4 MiB/16,384 值/256 卡覆盖文件读取和主要解析阶段，并以两条独立 16 KiB 探针分别约束第三方解码输入和单卡内部自有循环，正式夹具最多 147 次 UI 进度回调；报告均有独立检查器 | 4,533/20,000 真实 Tauri 导入与取消、20,000 卡数据库搜索分页、1,000 次答案后的 DB 增长仍未形成正式报告；纯解析结果不能替代后台调度、IPC/WebView 或这些数据库场景 |
| SEC-001 | 威胁建模完成，内容层部分闭环 | `SEC_001_LOCAL_CONTENT_PACK_STRIDE.md`、`PRE_GEN_PURE_PARSER_SPIKE.md`；STRIDE 六类威胁、冻结预算、13 个哈希绑定合成夹具；真实 Rust parser 已执行 001—011 | 012 preview token 重放和 013 半安装旧状态不变尚无真实状态/数据库实现测试，因此不能标记全部完成 |
| UX-RESEARCH-001 | 执行包完成，研究未执行 | `UX_RESEARCH_001_PROTOCOL.md`、`ux-research-001/manifest.json`；4 份各 15 条的合成材料、制卡模板、只在页面内存运行的字段映射/预览/模拟学习原型、匿名记录/汇总/具名延期模板齐备；8 项正负向与交互检查约束无文件读取、持久化、网络、Tauri、个人数据和构建泄漏 | Product Research 尚未完成内部试跑及 5—8 人真实访谈，也没有具名产品负责人填写延期；研究原型不是当前 Preview 或 PACK 功能，AI/工程模拟不得替代真实证据 |
| REL-002 | 工程与强提醒/崩溃恢复/睡眠核心真实桌面门完成；其余人工项待验 | `REL_002_RESUMABLE_SESSION_EVIDENCE.md`；schema v6 会话部分、稳定状态机、expected revision、幂等事件、24 小时 TTL、暂停/恢复/放弃/过期、Esc 三选项；已提交答案异常终止恢复 5/5，127,752/32,768 bytes 非空 WAL/SHM 且计数只保留一次；SQLite commit callback 内终止 5/5，57,712/32,768 bytes 非空 WAL/SHM 且作答/复习/排程/事件/完成数均为零、恢复原题；提醒抢占 20/20、睡眠只暂停一次且唤醒不自动开板；客观题与 recall 均覆盖最深提交前事件语句失败、deferred-FK 造成的真正 `COMMIT` 拒绝和页预算耗尽返回 `SQLITE_FULL`，零半写入且可用原 ID/revision 重试；150% DPI 和程序化辅助显示矩阵通过 | 最终通用 v6 必须在发布前把会话部分与通用项/调度合并为同一未发布迁移；其余 Windows/无障碍人工矩阵、物理菜单操作、只读/物理磁盘满/I/O 错误、损坏 WAL/SHM、真实断电及 commit callback 后更晚的 durable-write/硬件断电点仍未关闭 |
| GEN-000 | Draft / No-Go | `GEN_000_RFC_DRAFT.md` 已记录候选 schema、状态机、预算、token、哈希、扩展和迁移合同 | PERF/SEC/UX/v6 恢复证明不完整；Product、Architecture、Security/Privacy、Learning/Content、Windows QA、Accessibility 均未具名签字 |
| PACK-001 | 未开始 | 经授权的独立 pure-parser spike 可作为 GEN 输入，但不注册命令、不写数据库、不生成 token，不能冒充 PACK-001 | GEN-000 未冻结；正式 schema、原子 staging、preview token、取消零写入、错误 DTO 和安装状态均未实现 |
| PACK-002 | 未开始 | 现有英语 Preview 可作为未来兼容输入；REL-002 已先交付会话迁移部分 | 完整通用 v6、English adapter、v5→v6 4,533 卡身份/调度/会话/答题/复习/错题对账与故意失败恢复均未完成 |
| PACK-003 | 未开始 | 无 | 内容库、启停、来源/许可、指定/混合/错题学习、删除影响预览和多包隔离未交付 |
| PACK-004 | 未开始 | 现有旧英语 CSV/原生 JSON UI 只能作为交互参考 | 通用字段映射、抽样预览、大文件进度/取消、文件变化 token 失效、键盘/主线程冻结门未交付 |
| DATA-001 | 未开始 | 现有提醒备份设施可供设计参考，但学习库仍必须独立 | 学习库独立 manifest、每日/手动备份、14 份策略确认、分库恢复、恢复前快照、损坏/中断/非 ASCII/磁盘满/锁占用未交付 |
| QA-001 | 持续进行，未完成 | 前端、Rust feature、边界、性能报告检查器、格式和补丁卫生持续执行；150% DPI 的尺寸、可访问名称/可聚焦性、减少动态和强制颜色已有正式报告及 6 张截图；真实标准系统模式和 Narrator 运行中应用兼容探针通过 | 其余 DPI、多屏/负坐标、Narrator 人工听读/物理键盘、系统设置实际切换、系统适宜性/竞态/存储故障、迁移对账、内容权利与最终具名 Go/No-Go 未关闭 |

## 已封存真实桌面与性能报告

所有下列报告都来自真实 Tauri runtime-QA 二进制，不是浏览器 demo。每份报告只证明其哈希绑定的隔离 QA 二进制、相关源码和夹具；相关绑定变化后必须重跑，Stable/Preview 安装包的重新构建不会把旧报告自动提升为新安装包签字。只读检查器已按各自仍保留的绑定产物复核。

| 场景 | 报告 | 结果 |
| --- | --- | --- |
| learning-off 冷启动 | `src-tauri/target/runtime-qa/release/evidence/startup-cold-20260814T182734Z.json` | 20/20；P50 128.7 ms，P95 149.9 ms |
| learning-off 温启动 | `src-tauri/target/runtime-qa/release/evidence/startup-warm-20260814T182755Z.json` | 20/20；P50 52.6 ms，P95 83.7 ms |
| learning-on 冷启动 | `src-tauri/target/runtime-qa-learning/release/evidence/startup-cold-20260814T182820Z.json` | 20/20；P50 171.1 ms，P95 176.9 ms |
| learning-on 温启动 | `src-tauri/target/runtime-qa-learning/release/evidence/startup-warm-20260814T182841Z.json` | 20/20；P50 53.6 ms，P95 84.3 ms |
| 学习页打开 | `src-tauri/target/runtime-qa-learning/release/evidence/learning-page-20260814T173642Z.json` | 20/20；4,533 合成卡；P50 832.1 ms，P95 945.8 ms |
| 小黑板打开 | `src-tauri/target/runtime-qa-learning/release/evidence/learning-blackboard-20260814T174750Z.json` | 20/20；目标 P50 371.8 ms，P95 423.3 ms |
| learning-off 强提醒 | `src-tauri/target/runtime-qa/release/evidence/reminder-latency-20260814T180950Z.json` | 20/20；领取 P95 12,952.4 ms，handoff P95 249.6 ms，呈现 P95 13,171.6 ms；全部低于冻结绝对门 |
| learning-on 强提醒 | `src-tauri/target/runtime-qa-learning/release/evidence/reminder-latency-20260814T175849Z.json` | 20/20；领取 P95 12,912.0 ms，handoff P95 253.5 ms，呈现 P95 13,138.0 ms；全部低于冻结绝对门 |
| 当前活动学习中强提醒抢占 | `src-tauri/target/runtime-qa-learning-preemption/release/evidence/learning-reminder-preemption-20260825T024056Z.json` | 源提交 `ee48194`，20/20；领取后持久化暂停 P50/P95 4.1/5.8 ms，界面让位 P50/P95 223.3/258.2 ms；逐样本均低于 1 秒；原题/会话不变且零答题写入；独立 verifier 通过；报告哈希见 [QA-004](./QA_004_CURRENT_MACHINE_WINDOWS_RUNTIME_EVIDENCE.md) |
| 历史与未采用抢占报告 | `learning-reminder-preemption-20260825T022832Z.json` / `learning-reminder-preemption-20260821T141839Z.json` / `learning-reminder-preemption-20260821T111501Z.json` / `learning-reminder-preemption-20260819T134759Z.json` / `learning-reminder-preemption-20260819T145945Z.json` / `learning-reminder-preemption-20260821T140747Z.json` | 当前源码首次同参数运行因第 8 轮夹具自动答题碰撞为 19/20，失败报告保留且未采用；旧二进制报告与两个 0/20 沙箱窗口初始化失败报告仅作封存；均不参与当前通过判定 |
| 已提交答案后杀进程、WAL/SHM 恢复下一未答题 | `src-tauri/target/runtime-qa-learning-recovery/release/evidence/learning-crash-recovery-20260824T165841Z.json` | 5/5；每轮异常终止后先观测 127,752 bytes WAL 与 32,768 bytes SHM，再重启；第 1 题提交计数在崩溃前/重启后/继续后均恰为 1，第 2 个未答 item/headword 原样恢复；恢复入口 P50/P95 748.9/789.7 ms，点击继续到原题 P50/P95 403.5/411.4 ms；commit hook 未 arm/进入，数据库健康、测试根可清理，独立 verifier 通过 |
| SQLite commit callback 内终止、未提交选择恢复原题 | `src-tauri/target/runtime-qa-learning-recovery/release/evidence/learning-in-flight-commit-recovery-20260824T165518Z.json` | 5/5；全部答案 SQL 完成后进入 QA-only commit hook P50/P95 43.8/55.1 ms，再精确终止拥有的进程；每轮观测 57,712 bytes WAL 与 32,768 bytes SHM；重启/继续后作答、复习、排程推进、答题事件与完成数均为零，原 session/item/headword 不变；恢复入口 P50/P95 722.5/765.4 ms，点击继续到原题 P50/P95 398.8/547.7 ms；数据库健康、测试根可清理，独立 verifier 通过 |
| 原生菜单睡眠/唤醒状态链 | `src-tauri/target/runtime-qa-learning-sleep/release/evidence/learning-sleep-wake-20260825T022625Z.json` | 源提交 `ee48194`；两次真实原生菜单内容、共用处理器、睡眠暂停、唤醒保持可恢复、无障碍提示和 5 张截图通过；物理右键与 OS 级选择仍明确为人工门；报告哈希见 [QA-004](./QA_004_CURRENT_MACHINE_WINDOWS_RUNTIME_EVIDENCE.md) |
| 窗口与辅助显示矩阵 | `src-tauri/target/runtime-qa-learning-accessibility/release/evidence/learning-accessibility-matrix-20260825T022326Z.json` | 源提交 `ee48194`；当前单显示器真实 150% DPI，3/3 模式；Tauri 主线程调整真实 WebView，360×560、390×620、480×760 学习页及 520×420 小黑板精确命中并完整位于工作区；DOM 自动焦点、真实 UIA 可聚焦性/名称、减少动态与强制颜色状态及 6 张截图通过；其余 DPI、多屏/负坐标、Narrator 和物理键盘仍为人工门；报告哈希见 [QA-004](./QA_004_CURRENT_MACHINE_WINDOWS_RUNTIME_EVIDENCE.md) |
| 真实标准系统模式与 Narrator 并发 | `src-tauri/target/runtime-qa-learning-accessibility/release/evidence/learning-windows-system-mode-standard-20260825T072224Z.json`、`...T072325Z.json` | 源提交 `ba6e841`；两份报告均为 clean/Ready，实际动画开、高对比度关，学习页、小黑板、18 个可访问名称和受控退出通过；第二份在 Narrator 运行期间通过，随后 Narrator 恢复为关闭。失败启动上下文、设置切换尝试、最终系统读回和 Narrator 偏好缓存残留见 [QA-005](./QA_005_ACTUAL_WINDOWS_SETTINGS_EVIDENCE.md) |
| learning-on 运行烟测 | `src-tauri/target/runtime-qa-learning/release/evidence/runtime-baseline-20260814T182108Z.json` | 60 秒、23 样本、受控退出；仅证明通道，不替代 2 小时/24 小时门 |
| pre-GEN JSON/CSV 文件读取+纯解析 | `src-tauri/target/learning-pack-spike/release/evidence/learning-pack-parse-spike-20260824T175724Z.json` | 30/30；20,000 卡 JSON/CSV 为 26,020,105/26,120,061 bytes，内部管线 P95 481.523/359.907 ms，峰值 working set 123,691,008/75,395,072 bytes；4 MiB/16,384 值/256 卡进度检查间隔、独立 16 KiB 解码输入和单卡取消间隔（含 Unicode 规范化输入和 CSV 分隔符/可选字段扫描）、JSON 九阶段/CSV 八阶段、≤256 回调和 `complete/cards` 终态通过；零数据库写入；只关闭独立文件管线的有界协作检查风险 |
| Rust 24 线程进程稳定性 | `src-tauri/target/rust-parallel-stability/evidence/rust-parallel-stability-20260824T171001Z.json` | 完整 Authenticode provider-state 进程锁 + 有界 PE 头预检后，默认完整库先经 100/100 压力；当前源码/二进制重新绑定的正式门默认 20/20（215/1）、learning 10/10（279/1），P95 1843.885/4647.590 ms，零崩溃、零失败；无 dump/WER 模块，精确原生指令/模块仍未知 |
| 2 小时学习内存 | `src-tauri/target/runtime-qa-learning-memory/release/evidence/learning-memory-20260819T111112Z.json` | 7,200.84 秒、121 样本；完成一轮且末端完成黑板可验证；working/private/handle/thread 六段斜率均为负；0 个正式用户文件写入；受控退出；预注册门与独立 verifier 均通过 |

2 小时学习内存设施使用 4,533 张确定性合成卡打开真实学习页、完成一轮固定小黑板操作；隔离 fixture 将普通提醒领取暂停到观测窗口后，避免 60 分钟默认提醒改变被测稳态。预热后每 60 秒采集完整进程树 7,200 秒，并在结束前再次确认完成黑板可访问。报告绑定源码状态、应用/fixture/内容/数据库/脚本哈希、设备和原始样本；`verify_learning_memory_evidence.mjs` 从原始样本重算摘要和六段趋势，并核对提醒暂停、正式数据隔离、应用错误与受控退出。

第一次正式运行 `learning-memory-20260819T085748Z.json` 在 60 分钟处被默认喝水/活动提醒改变进程树，四条趋势失败；该报告保留且未通过。没有放宽阈值：fixture 增加提醒暂停，脚本增加末端完成态验证，120 秒 smoke 通过后重新执行完整门。接受报告的 working/private/handle/thread 六段斜率分别为 -204,687.3862 bytes/小时、-15,270.3323 bytes/小时、-9.3531 个/小时和 -1.1485 个/小时，首末段增长也全部为负。Codex 沙箱内的 WebView2 `0xC0000022` 诊断仍保留，但获授权的沙箱外 Windows 运行成功，故不再阻断本项。

## 2026-08-21—25 本轮质量门

- pure-parser Rust：25 项单元测试 + 5 组安全集成测试通过；除普通文件读取取消/类型/超限、UTF-8 跨块边界、JSON 八个字节处理阶段/CSV 七阶段取消、不返回部分包、按阶段与单位进度单调有界和兼容 API 结果一致外，还覆盖精确 16 KiB 解码/单卡探针、单张超长 JSON/CSV 卡在完成任何卡片前取消、JSON 在结构可见前取消、CSV 在任何卡片完成前取消、NFC 长组合序列与 NFKC 超长原始标识符取消，以及 CSV 空白可选字段/列表分隔扫描取消；正式文件管线另含读取阶段。SEC-FIX-001—011 执行结果符合冻结清单，012/013 明确保持状态层未实现。
- evidence：纯解析性能检查器 7 项、隔离边界检查器 6 项正反向测试通过；正式 30 样本报告的源码/二进制/夹具/进度绑定复核通过，当前 metadata/源码/Tauri 配置/capability/默认与 Preview 产物均无 spike 接入；SEC 夹具清单 4 项检查通过；UX 研究执行包 8 项材料/隐私/交互/产物隔离检查通过；学习内存检查器 8 项测试和正式 2 小时报告复核通过；当前崩溃恢复检查器 12 项、QA-only commit hook Rust 测试 3 项、强提醒抢占检查器 9 项测试及两组 5/5 和源码提交 `ee48194` 的抢占 20/20 正式报告复核通过；同提交首次 19/20 的夹具自动答题碰撞报告保留且不参与通过判定；睡眠/唤醒检查器 10 项测试、当前正式状态链和 5 张截图复核通过；窗口/辅助显示检查器 12 项测试、当前正式 3 模式和 6 张截图复核通过；学习交互与启动 evidence 检查器测试均通过。当前三组 Windows runtime-QA 报告的哈希绑定见 [QA-004](./QA_004_CURRENT_MACHINE_WINDOWS_RUNTIME_EVIDENCE.md)。
- 前端：`npm.cmd run check` 通过，32 个文件、207 项测试；learning-off 与 14 文件 Learning Preview 构建边界通过，研究执行包未进入两种 `dist`。SCM 扫描无个人内容命中。
- REL-002：客观选择题与 recall 各有三条确定性答题故障注入：在最深 `answer_committed` 语句执行 `RAISE(ABORT)`、让所有 SQL 完成后由 deferred foreign key 在真正 `transaction.commit()` 处拒绝提交，以及将 `max_page_count` 固定到当前逻辑页数后以深层大写入触发真实 `SQLITE_FULL`。六条失败路径的会话、排程、复习、作答、错题队列和事件状态均与答题前完全相同，逻辑页数不增长，`integrity_check`/`foreign_key_check` 健康，解除注入后原 `clientAnswerId`/revision 可只计一次地成功重试。页预算测试不替代物理卷空间/I/O 故障。
- Rust：首次 provider-state 进程锁缓解通过后，`STATUS_ACCESS_VIOLATION` 在 24 线程完整默认库的第 3、4、13、45 轮等位置再次以 `0xC0000005` 复现。增强后的正式门会在缺少 harness 摘要时保留退出码、stdout/stderr 字节数及 SHA-256。隔离压力中，真实已签名 Codex 验证 100/100、合成无效 EXE 发现 100/100、connector 子集 60/60 均单独通过；完整库去掉非 PE 合成路径后 100/100，通过而只去掉两条真实签名测试仍在第 4 轮崩溃，因此当前完整负载的必要条件被收窄到“合成非 PE `.exe` 进入 `WinVerifyTrust`”。生产适配器现以有界位置读取核对 `MZ`、`e_lfanew` 和 `PE\0\0`，非 PE 输入直接判不可信，并保留完整 provider-state 进程锁。修复后完整默认库 100/100；本轮代码变化使旧二进制绑定失效后，已重跑当前正式 [QA-002](./QA_002_RUST_PARALLEL_STABILITY_EVIDENCE.md) 门，默认 20/20（215/1）、learning 10/10（279/1），P95 1843.885/4647.590 ms。Windows Application/WER 仍无故障模块且未取得 dump，因此只认定复现条件已隔离且当前缓解具重复性，不宣称精确原生指令/模块已根因闭环；再现时仍须捕获转储。runtime-QA 定向 10/10，仲裁器默认 12/12、learning 13/13。
- 构建：2026-08-25 从零工作树改动的提交 `6b9389b` 依次生成 Learning Preview 与 Stable。Stable NSIS 为 12,524,156 bytes / `D531BB67B562B5E78D97E6F7C5FF53E1FA13D1673B5C6213DF38170BD00E0D60`；Learning Preview NSIS 为 13,925,914 bytes / `CD998032D3CEB7828AB292FA536658797B3ED07DC5B7C0D59C9B9150DC8F2FC4`。两者均通过个人内容产物边界；Stable release 可执行文件不含三项冻结学习标记，Preview 对应可执行文件包含三项标记；最终 `dist` 已恢复 learning-off。完整命令、EXE 绑定和限制见 [QA-003](./QA_003_CLEAN_COMMIT_DUAL_BUILD_EVIDENCE.md)。它们是内部未签名构建，不替代上述 runtime-QA、人工 Windows QA 或发布签字。
- workspace 并行门同时暴露 `yuanyuan-ai` 连续服务测试的确定性超时竞态：shutdown ACK 早于 task-pipe 唤醒和 worker join，而测试仅等待 1 秒，短于既有 3 秒硬传输预算。测试现使用既有硬预算并显式 join worker，生产超时未修改；该 crate 默认并行 10/10 轮、完整 workspace 复验通过。
- 本轮 PowerShell 测量脚本语法检查、`cargo fmt --all -- --check`、`git diff --check` 和 `package.json` 解析均通过。历史访问冲突没有被删除或因后续稳定复验而冒充根因已关闭，仍由 PERF/QA 保留再次出现时的崩溃模块捕获责任。

## 阶段 0 出口逐项审计

| 出口条件 | 判定 |
| --- | --- |
| REL-001/002、PERF-001、SEC-001 完成 | 未通过：PERF 与 SEC 仅部分完成 |
| 呈现租约和会话状态机报告通过 | 通过；单元/组件测试与真实 Windows runtime-QA 报告均有独立检查器 |
| 崩溃恢复与强提醒 1 秒让位真实桌面验证 | 通过：已提交答案异常终止恢复 5/5，SQLite commit callback 内终止时未提交选择零写入 5/5；提交 `ee48194` 的抢占 20/20，持久化暂停/UI 让位 P95 5.8/258.2 ms；另有原生菜单睡眠/唤醒状态链通过，但物理菜单操作仍待人工 |
| 无稳定提醒回归 | 当前自动化与 learning-off/on 强提醒绝对门通过 |
| 用户访谈完成或有具名延期处置 | 未通过 |
| GEN-000 可以冻结 | 未通过：输入和签字均不完整 |

上述两项“通过”均绑定各自应用、fixture、脚本和数据库夹具。后续相关绑定变化仍须重建复跑；无论绑定是否变化，都不能复用 runtime-QA 报告为另一个 Stable/Preview/签名候选二进制签字。

因此阶段 0 当前结论为：**继续内部开发，但不进入 GEN 冻结和 PACK 实现。**

## 需要外部决定或授权的闭环

1. **GEN/PERF/PACK 边界**：用户已明确批准“只解析、只校验、零入库、不可发布”的 pre-GEN spike，纯解析证据已经形成。真实导入/分页/DB 增长仍不得越过 GEN；Product/Architecture 还需决定 CSV 缺省 card ID、过渡别名、最终字段和取消/进度合同。
2. **真实研究或具名延期**：独立合成执行包已经可供内部试跑；Product Research 仍须先试跑再执行 5—8 人访谈。若延期，必须由具名产品负责人使用冻结模板写明理由、风险接受范围和补做日期。
3. **人工 Windows QA 与签字**：核心学习中强提醒让位、已提交答案异常终止恢复、SQLite commit callback 内终止的未提交选择回滚、原生菜单睡眠/唤醒状态链、当前设备 150% DPI 的窗口/程序化辅助显示矩阵，以及真实标准系统模式/Narrator 运行中应用兼容探针已自动化封存；后端全优先级有序对合同也已穷举。仍须完成物理右键/OS 级菜单选择、100/125/200% DPI、多屏/负坐标、物理键盘/Narrator 人工听读、Windows 设置实际切换减少动画/高对比度、全优先级真实桌面时序竞态、系统适宜性和其余存储故障矩阵，并由六类责任角色逐项签字。

在上述门未关闭前，任何“阶段 0 完成”“GEN 已冻结”“阶段 1 已开始”或“可以公开发布”的表述都不成立。

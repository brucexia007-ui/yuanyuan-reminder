# PERF-001 学习开关性能基线协议

状态：冷温启动、学习页/小黑板、强提醒、活动学习抢占、2 小时学习内存与 pre-GEN 纯解析基线已完成；真实导入/分页和 DB 增长待完成<br>
日期：2026-08-19<br>
责任角色：Performance + Windows QA

## 原则

- 所有数字来自 Tauri release/runtime-QA 桌面二进制，不用浏览器 demo 代替。
- learning-off 与 learning-on 使用同一提交、同一设备、同一电源模式、同一 WebView2 版本和隔离数据库夹具。
- 每份报告绑定应用二进制、QA fixture、测量脚本、数据库夹具的 SHA-256，并记录 Git commit、dirty 状态、CPU、内存、Windows build、WebView2 版本和电源模式。
- 强提醒仍使用现有绝对门：后端领取 P95 ≤ 16,000 ms、Tauri→UI handoff P95 ≤ 1,000 ms、端到端呈现 P95 ≤ 17,000 ms。学习开启不得放宽这些门。
- 内存趋势沿用既有分段回归方法。2 小时学习基线是本任务最低证据；既有 24 小时稳定版门仍独立保留。

## 构建矩阵

| 形态 | 前端 | Rust features | 隔离输出 |
| --- | --- | --- | --- |
| learning-off | 默认 production | `runtime-qa,tauri/custom-protocol` | `target/runtime-qa` |
| learning-on | `learning-preview` | `runtime-qa,learning,tauri/custom-protocol` | `target/runtime-qa-learning` |

命令：

```powershell
npm.cmd run runtime:qa:build
npm.cmd run runtime:qa:learning:build
```

两个输出目录不得复用，避免报告在重新构建后失去二进制绑定。

## 测量矩阵

| 场景 | 样本/时长 | 指标 | 夹具 |
| --- | ---: | --- | --- |
| 冷启动 | 各 20 次 | 进程启动→首个可见窗口 P50/P95 | 空隔离库；每次新 WebView 数据根 |
| 温启动 | 各 20 次 | 进程启动→首个可见窗口 P50/P95 | 已初始化 WebView/数据库 |
| 学习页打开 | 20 次 | 点击/启动 route→`学习页面`可访问节点 P50/P95 | 4,533 合成卡 ready 包 |
| 小黑板打开 | 20 次 | 手动开始命令→`圆圆桌面英语复习`可访问节点 P50/P95 | 固定 5 卡会话 |
| 4,533 卡导入 | 10 次 | 预览、确认、总耗时；峰值内存；DB 增长 | 确定性合成 CSV/JSON |
| 20,000 卡导入 | 5 次 | 同上；不得冻结 UI | 25 MiB 内确定性合成 JSON |
| 搜索分页 | 各查询 30 次 | 首屏和第 100 页 P50/P95 | 20,000 卡，多语言/无结果/高命中 |
| 学习内存 | 2 小时、60 秒采样 | CPU、working/private set、handle/thread 斜率与分段增长 | 学习页与小黑板各一轮固定操作 |
| DB 增长 | 导入后 + 1,000 次答案 | 主库/WAL/SHM 总增量、checkpoint 后大小 | 固定评分序列 |
| 强提醒 | learning-off/on 各 20 次 | 领取、handoff、端到端 P50/P95 | 既有 reminder-latency QA |
| 活动学习中强提醒抢占 | 20 次 | 领取→持久化暂停、领取→小黑板让位 P50/P95 与逐样本最大值 | 固定 3 卡活动会话 + 强提醒 |

## 预注册失败规则

- 任一强提醒绝对门失败：停止 PACK 开发，先修复。
- 20,000 卡无法在 25 MiB/20,000 卡冻结预算内解析，或主线程无响应超过 1 秒：停止并调整解析/进度协议。
- 2 小时内存分段持续增长且无法由缓存上限解释：停止并定位泄漏。
- 报告缺少任一哈希、设备字段、夹具计数/哈希、退出码或原始样本：报告无效，不得只保留汇总数字。
- 当前旧英语 CSV 导入器仍有 2 MiB/10,000 行边界；它不能冒充 PACK-001 的 25 MiB/20,000 卡结果。正式数据必须在通用包解析器落地后重跑。

## 当前可复用证据设施

- `measure_runtime_baseline.ps1`：真实 Windows 进程树、窗口出现、CPU/内存/句柄/线程、数据库增长、系统锁定/睡眠事件与二进制/脚本绑定。
- `measure_reminder_latency.ps1`：真实 Tauri + Windows UI Automation 的提醒领取/呈现 P50/P95。
- `measure_learning_interaction.ps1` 与 `measure_startup_matrix.ps1`：学习页/小黑板 UI Automation，以及 learning-off/on 冷温启动矩阵。
- `measure_learning_memory.ps1`：4,533 张合成卡、固定一轮真实学习操作、两小时完整进程树采样和六段趋势。
- `measure_learning_reminder_preemption.ps1`：活动学习小黑板、真实强提醒领取、会话暂停持久化与 UI 让位的 1 秒门。
- 对应的 Node evidence verifier：拒绝陈旧、缺字段、原始样本/摘要不一致或伪正式门报告。

## 当前处置

代码已提供独立 learning-on runtime-QA 构建脚本，避免覆盖 learning-off 二进制。冷/温启动、学习页、小黑板、强提醒、活动学习中强提醒抢占和 2 小时学习内存正式桌面采样已经完成。用户随后明确授权“只解析、只校验、零入库”的 pre-GEN spike，4,533/20,000 JSON/CSV 纯解析正式基线也已完成。正式 PERF-001 仍未完成：真实 Tauri 后台导入与取消、20,000 卡数据库分页、1,000 次答案后的 DB 增长尚无有效报告。短时 smoke、纯解析进程或单元测试不得冒充这些场景。

## 2026-08-14 构建就绪证据

- `npm.cmd run runtime:qa:learning:build` 已完成，生成独立的 `src-tauri/target/runtime-qa-learning/release/yuanyuan-reminder.exe`。
- 同次构建生成 `yuanyuan-runtime-qa-fixture.exe` 与 `yuanyuan-task-watch-fixture.exe`，三个产物的完成时间一致。
- 这只证明 learning-on 的真实 Tauri release 测量入口可用；它不替代冷/温启动、学习页、小黑板、导入、2 小时内存与提醒延迟的正式采样。

## 2026-08-15 learning-on 桌面烟测

`measure_runtime_baseline.ps1` 新增显式 `-BuildVariant learning-on`，直接选择隔离的 `target/runtime-qa-learning`，不会覆盖或误用 learning-off 产物。一次 60 秒真实 Tauri 桌面运行结果：

| 指标 | 结果 |
| --- | ---: |
| 启动到首个可见窗口 | 302.6 ms |
| 有效进程样本 | 23 |
| 平均归一化 CPU | 0.0888% |
| 峰值 working set | 556,806,144 bytes |
| 峰值 private memory | 273,076,224 bytes |
| 隔离数据库增长 | 560,320 bytes |
| 受控退出 / smoke ready | 是 / 是 |

原始报告：`src-tauri/target/runtime-qa-learning/release/evidence/runtime-baseline-20260814T182108Z.json`。报告绑定应用、fixture 和脚本 SHA-256；应用哈希以 `268701633AD1` 开头。`verify_runtime_baseline_evidence.mjs --build-variant learning-on --allow-smoke` 已按当前目标目录复核哈希、原始样本、趋势和 smoke 边界；`--allow-smoke` 不会把该报告提升为 24 小时 acceptance。

该结果只证明 learning-on 桌面构建、窗口探针、采样和隔离清理通道可用。时长仅 60 秒，没有 learning-off 对照、学习页/小黑板操作、导入负载或 2 小时趋势，因此不计入 PERF-001 正式通过结论。

## 2026-08-15 learning-on 强提醒冻结门

`measure_reminder_latency.ps1 -BuildVariant learning-on -SampleCount 20 -BaselineGate` 在真实 Tauri + Windows UI Automation 链路完成 20/20 样本，冻结门通过：

| 指标 | P50 | P95 | 绝对门 |
| --- | ---: | ---: | ---: |
| 后端领取 | 6,916.0 ms | 12,912.0 ms | ≤ 16,000 ms |
| Tauri→UI handoff | 233.0 ms | 253.5 ms | ≤ 1,000 ms |
| 端到端呈现 | 7,134.8 ms | 13,138.0 ms | ≤ 17,000 ms |

原始报告：`src-tauri/target/runtime-qa-learning/release/evidence/reminder-latency-20260814T175849Z.json`。报告与最终 learning-on 应用哈希 `268701633AD1…`、fixture 和测量脚本哈希绑定，20 个进程均受控退出。

独立复核已通过：`verify_reminder_latency_evidence.mjs --build-variant learning-on` 重新读取目标目录内的应用、fixture 和脚本，核对哈希、20 个原始样本、时间关系、分位数和冻结阈值。

这关闭了“learning-on 自身违反现有强提醒绝对门”的停止条件；下一节补齐 learning-off 对照，PERF-001 仍需学习交互场景、导入/分页和 2 小时内存证据。

## 2026-08-15 learning-off 同工作树强提醒对照

在 learning-on 门禁之后、未改动应用或测量脚本的情况下，重新构建隔离的 learning-off runtime-QA 产物，并用相同的 20 样本、相位偏移和冻结阈值执行正式门禁。20/20 样本通过：

| 指标 | learning-off P50 | learning-off P95 | learning-on P50 | learning-on P95 | 绝对门 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 后端领取 | 6,906.2 ms | 12,952.4 ms | 6,916.0 ms | 12,912.0 ms | P95 ≤ 16,000 ms |
| Tauri→UI handoff | 220.6 ms | 249.6 ms | 233.0 ms | 253.5 ms | P95 ≤ 1,000 ms |
| 端到端呈现 | 7,128.2 ms | 13,171.6 ms | 7,134.8 ms | 13,138.0 ms | P95 ≤ 17,000 ms |

原始报告：

- learning-off：`src-tauri/target/runtime-qa/release/evidence/reminder-latency-20260814T180950Z.json`，应用哈希以 `AFC62B507AC1` 开头；
- learning-on：`src-tauri/target/runtime-qa-learning/release/evidence/reminder-latency-20260814T175849Z.json`，应用哈希以 `268701633AD1` 开头；
- 两份报告的测量脚本哈希均为 `B14DD5BFD8D…`。构建 feature 不同，因此应用和 fixture 哈希不同是预期结果。

learning-off 报告已由 `verify_reminder_latency_evidence.mjs` 独立复核，核对目标目录中的二进制/fixture/脚本哈希、20 个原始样本、时间关系、分位数与冻结阈值。两种构建的端到端 P95 相差 33.6 ms（learning-on 低 0.26%），均明显低于 17 秒绝对门；该单组 20 样本对照用于关闭现有提醒链路的冻结门，不等同于统计显著性证明，也不替代 PERF-001 其余场景。

至此，强提醒的 learning-off/on 对照项已经完成。下一节补齐学习页与小黑板打开；PERF-001 仍需冷/温启动、通用包导入与分页、DB 增长和 2 小时内存趋势。

## 2026-08-19 活动学习中强提醒抢占门

`measure_learning_reminder_preemption.ps1 -SampleCount 20 -EvidenceGate` 在真实 learning-on Tauri 小黑板活动期间注入一次到期强提醒，并分别量度提醒领取到 SQLite 会话暂停、以及提醒领取到小黑板让位/提醒卡可访问的延迟。20/20 样本通过：

| 指标 | P50 | P95 | 预注册门 |
| --- | ---: | ---: | ---: |
| 后端领取 | 7,449.0 ms | 13,462.7 ms | P95 ≤ 16,000 ms |
| 领取后持久化为 paused | 4.7 ms | 5.4 ms | P95 且每个样本 ≤ 1,000 ms |
| 领取后 UI 让位 | 217.7 ms | 232.4 ms | P95 且每个样本 ≤ 1,000 ms |
| 端到端提醒呈现 | 7,666.7 ms | 13,696.5 ms | P95 ≤ 17,000 ms |

原始报告：`src-tauri/target/runtime-qa-learning-preemption/release/evidence/learning-reminder-preemption-20260819T134759Z.json`。全部样本都保持同一 session/item/headword，原子写入 `paused(reason=preempted_high_priority)` 与唯一 `interrupted` 事件，且没有答案、答题或复习写入；持久化/UI 最大值分别为 5.4/233.8 ms，受控退出和隔离根清理均成功。

`verify_learning_reminder_preemption_evidence.mjs` 已从原始样本重算分位数并核对应用、fixture、内容、初始数据库和脚本绑定；9 项正反向测试通过。本门关闭活动学习对高优先级提醒的 1 秒让位要求，不替代其余 Windows 优先级竞态、提醒结束后的人工继续体验或 PERF-001 尚缺的真实导入/分页/DB 增长。

## 2026-08-15 学习页与小黑板正式采样

新增仅在 `runtime-qa,learning` 构建中接受的 `learning-performance` profile，以及确定性合成学习夹具。夹具通过真实 Rust 学习导入与 SQLite repository 生成，不复制个人词库；稳定版和 learning-off 构建不接受该 profile。`measure_learning_interaction.ps1` 使用 Windows UI Automation 定位用户可操作节点，并逐样本记录应用、fixture 可执行文件、合成内容、SQLite 数据库和测量脚本 SHA-256，以及 Windows、WebView2、CPU 逻辑核数和电源状态。

正式结果：

| 场景 | 夹具 | 样本 | P50 | P95 | 计时边界 |
| --- | ---: | ---: | ---: | ---: | --- |
| 学习页打开 | 4,533 张确定性合成卡 | 20/20 | 832.1 ms | 945.8 ms | 进程启动→`学习页面`可访问节点 |
| 小黑板打开 | 5 张确定性合成卡 | 20/20 | 371.8 ms | 423.3 ms | 调用“开始一轮”→`圆圆桌面英语复习`可访问节点 |

原始报告：

- `src-tauri/target/runtime-qa-learning/release/evidence/learning-page-20260814T173642Z.json`；
- `src-tauri/target/runtime-qa-learning/release/evidence/learning-blackboard-20260814T174750Z.json`。

两份报告绑定同一最终应用哈希 `268701633AD1…` 和同一测量脚本；合成内容哈希因 4,533 卡与 5 卡夹具不同而不同。所有 40 个进程均退出码为 0，隔离根均已删除。`verify_learning_interaction_evidence.mjs` 已分别复核两份正式报告，重新核对当前二进制/fixture/脚本哈希、设备字段、SQLite 夹具哈希格式、可访问目标、原始样本和 P50/P95；对应的 5 项 Node 测试覆盖陈旧绑定、设备/夹具篡改、乐观通过、分位数篡改、未知字段和伪正式门。

这里的学习页样本每轮使用新的 WebView 数据根，可作为 4,533 卡冷页面路径证据，但不替代专门的 learning-off/on 冷/温启动矩阵。

## 2026-08-15 learning-off/on 冷温启动矩阵

`measure_startup_matrix.ps1` 对两种隔离构建分别执行冷、温启动各 20 次。冷启动每次创建新的应用/WebView 数据根；温启动先做一次不计数的初始化，再复用同一隔离根。计时终点是第一个归属于应用进程的可见顶层窗口。为了不为每个仅数百毫秒的启动样本空等 30 秒，脚本在计时终点之后核对可执行路径并只终止精确 QA 根进程；该终止方式不计入启动时间，也不冒充正常退出，正常退出证据由 60 秒 runtime smoke 和强提醒门独立覆盖。

| 构建 | 模式 | 样本 | P50 | P95 |
| --- | --- | ---: | ---: | ---: |
| learning-off | 冷启动 | 20/20 | 128.7 ms | 149.9 ms |
| learning-off | 温启动 | 20/20 | 52.6 ms | 83.7 ms |
| learning-on | 冷启动 | 20/20 | 171.1 ms | 176.9 ms |
| learning-on | 温启动 | 20/20 | 53.6 ms | 84.3 ms |

原始报告：

- `src-tauri/target/runtime-qa/release/evidence/startup-cold-20260814T182734Z.json`；
- `src-tauri/target/runtime-qa/release/evidence/startup-warm-20260814T182755Z.json`；
- `src-tauri/target/runtime-qa-learning/release/evidence/startup-cold-20260814T182820Z.json`；
- `src-tauri/target/runtime-qa-learning/release/evidence/startup-warm-20260814T182841Z.json`。

learning-on 相对 learning-off 的冷启动 P95 增加 27.0 ms，温启动 P95 增加 0.6 ms；本轮只冻结实测基线，方案没有预注册启动绝对门，因此不事后发明通过阈值。`verify_startup_matrix_evidence.mjs` 已对四份报告复核当前二进制/fixture/脚本哈希、设备字段、逐样本输入/输出 SQLite 清单哈希、冷/温数据根语义、清理状态和 P50/P95；5 项 Node 测试覆盖陈旧绑定、设备缺失、乐观样本、错误数据库状态、分位数篡改、未知字段和伪正式门。

PERF-001 当前剩余：4,533/20,000 卡真实通用导入与取消、20,000 卡分页，以及 1,000 次答案后的 DB 增长。

## 2026-08-19 两小时学习内存正式门

新增 `measure_learning_memory.ps1`。正式门固定使用 `-DurationSeconds 7200 -SampleIntervalSeconds 60 -WarmupSeconds 30 -EvidenceGate`，执行路径为：

1. 用真实 Rust 导入/repository 在隔离根生成 4,533 张确定性合成卡；
2. 启动当前 `runtime-qa-learning` Tauri 二进制，等待真实“学习页面”可访问节点；
3. 调用“开始一轮”，每题选择第一个可用选项并完成一轮，包括错误反馈继续路径；
4. 在“英语复习完成”小黑板稳态预热后，每 60 秒采集完整应用进程树的 CPU、working/private set、handle、thread 和 process count，持续至少 7,200 秒，并在结束前再次验证完成态可访问节点；
5. 记录 Git commit/dirty 状态、应用/fixture/合成内容/初始 SQLite/脚本 SHA-256、设备、WebView2、电源、DB 增长、正式数据隔离、应用错误、受控退出和原始样本；
6. 隔离 fixture 将普通提醒领取暂停到观测窗口之后，避免 60 分钟默认提醒改变被测稳态；提醒延迟与抢占由独立门负责；
7. 用既有稳定运行门的 working/private/handle/thread 限值做预注册调查门，但不把 2 小时结果冒充独立的 24 小时稳定版门。

`verify_learning_memory_evidence.mjs` 从原始样本重算 P95、均值和六段回归，验证 4,533 卡确定性内容哈希、当前二进制/fixture/脚本绑定、操作完成、结束时完成态、提醒暂停覆盖窗口、时钟/间隔、隔离与门禁一致性。8 项 Node 测试已通过，覆盖正式报告、短烟测、陈旧绑定、源码/设备缺失、确定性夹具哈希、原始样本/分段摘要篡改、伪短时正式门、未知字段与 UTF-8 BOM。

正式通过报告：`src-tauri/target/runtime-qa-learning-memory/release/evidence/learning-memory-20260819T111112Z.json`。独立 verifier 已按当前产物复核通过。

| 指标 | 结果 |
| --- | ---: |
| 观测时长 / 样本 | 7,200.84 秒 / 121 |
| 固定操作 | 3 次答题，完成一轮；结束时完成黑板仍可验证 |
| 平均 / P95 归一化 CPU | 0.0709% / 0.0920% |
| working set 峰值 / P95 | 618,942,464 / 604,549,120 bytes |
| working set 六段斜率 / 首末中位数增长 | -204,687.3862 bytes/小时 / -1,009,664 bytes |
| private memory 六段斜率 / 首末中位数增长 | -15,270.3323 bytes/小时 / -364,544 bytes |
| handle 六段斜率 / 首末中位数增长 | -9.3531 个/小时 / -22 个 |
| thread 六段斜率 / 首末中位数增长 | -1.1485 个/小时 / -3 个 |
| 受控退出 /应用错误 | 是 / 0 |
| 正式用户文件写入 / QA 根清理 | 0 / 已删除 |
| 预注册门 | 通过，0 个失败项 |

报告绑定应用、fixture、4,533 卡合成内容、初始 SQLite 和脚本 SHA-256，并记录 Windows 10 Pro 25H2 build 26200.8875、24 个逻辑处理器、WebView2 151.0.4129.93 和交流电源。它证明的是隔离 learning-on release 运行时在“完成黑板”稳态下未出现持续内存、句柄或线程增长；不覆盖签名生产候选、提醒抢占、20,000 卡导入/分页、多 DPI、Narrator、减少动画或独立 24 小时稳定版门。

第一次 7,200 秒运行 `learning-memory-20260819T085748Z.json` 保留为未通过诊断证据：默认 60 分钟喝水/活动提醒在观测中途改变了进程树，导致 working/private/handle/thread 趋势门失败，而脚本当时也没有在结束时证明仍处于完成黑板。没有放宽阈值；修复方式是让 fixture 显式暂停普通提醒并增加末端稳态验证。修复后的 120 秒 smoke `learning-memory-20260819T110659Z.json` 先通过，再执行上述正式门。

Codex 文件沙箱内的 WebView2 GPU 子进程曾以 `0xC0000022` 被系统拒绝；相同 Microsoft 签名 WebView2 在沙箱外可正常启动，因此正式 smoke 与 2 小时门均在获授权的外部 Windows 运行环境执行。该差异记录在 `src-tauri/target/runtime-qa-learning-memory/release/evidence/webview2-init-diagnostic.log`，不再作为正式内存门的环境阻断。

## 2026-08-25 pre-GEN 纯解析正式基线

用户明确授权了不写数据库、不注册 Tauri command、不生成 preview token、不可安装、不可发布的纯解析性能 spike。实现位于独立 workspace member `src-tauri/crates/learning-pack-spike`；新版核心把普通文件读取纳入内部计时，在读取、输入预检、跨块 UTF-8、语法、解码、结构、逐卡校验和流式最终化阶段分别按 4 MiB、16,384 个 JSON 值或 256 张卡提供协作取消/进度检查点，并以两条独立 16 KiB 轻量探针分别约束 serde_json/csv 解码输入和单卡内部字符串扫描、Unicode 规范化输入、CSV 分隔符/可选字段扫描、复制、哈希、规范序列化，不增加 UI 进度事件。20,000 卡夹具同时被强制在 25,900,000 bytes 至 25 MiB 之间，正式报告为 `src-tauri/target/learning-pack-spike/release/evidence/learning-pack-parse-spike-20260824T175724Z.json`。

| 格式 / 卡数 | 样本 | 内部解析 P50 / P95 | 进程墙钟 P50 / P95 | 峰值 working set |
| --- | ---: | ---: | ---: | ---: |
| JSON / 4,533 | 10/10 | 36.591 / 37.329 ms | 55.892 / 65.718 ms | 16,760,832 bytes |
| CSV / 4,533 | 10/10 | 24.358 / 24.864 ms | 43.431 / 49.795 ms | 10,932,224 bytes |
| JSON / 20,000，26,020,105 bytes | 5/5 | 477.863 / 481.523 ms | 506.478 / 510.777 ms | 123,691,008 bytes |
| CSV / 20,000，26,120,061 bytes | 5/5 | 355.925 / 359.907 ms | 382.102 / 386.824 ms | 75,395,072 bytes |

30/30 样本均低于预注册候选门：内部读取+解析 P95 ≤ 1,000 ms、进程墙钟 P95 ≤ 2,000 ms、峰值 working set ≤ 512 MiB。四个夹具分别为 1,001,898 / 571,219 / 26,020,105 / 26,120,061 bytes；两份 20,000 卡夹具距 25 MiB 上限仅 194,295 / 94,339 bytes。报告记录 0 个数据库文件，全部子进程声明 `databaseWrites=0`。

独立 verifier 会从原始样本重算分位数并核对 binary、library/main source、crate manifest、测量脚本、Git 状态、设备、夹具 SHA-256，以及每个样本的三类进度检查间隔、16 KiB 解码取消间隔、16 KiB 单卡取消间隔、阶段覆盖、回调总数上限和 `complete/cards` 最终态；7 项 Node 测试覆盖短烟测冒充正式门、陈旧绑定、乐观样本、伪造进度、scope 漂移、未知字段和 BOM。详细范围与安全夹具映射见 `PRE_GEN_PURE_PARSER_SPIKE.md`。

该结果证明冻结预算附近的“纯 Rust 文件读取+解析”有充足余量，并证明文件管线各主要阶段能按固定单位间隔报告进度和协作取消；serde_json/csv 解码输入、Unicode 规范化输入、CSV 分隔符/可选字段扫描与单卡内部自有循环的取消粒度也已分别冻结为 16 KiB。它仍不约束操作系统阻塞在单次 ≤4 MiB 读取调用内的即时取消，也不包含文件选择/替换 token、Tauri IPC、后台任务调度、IPC 进度传递、预览、数据库事务、分页查询或 WebView 响应。故 PERF-001 中“4,533/20,000 真实导入/取消、搜索分页、DB 增长”仍保持未完成，不能由本节数字替代。

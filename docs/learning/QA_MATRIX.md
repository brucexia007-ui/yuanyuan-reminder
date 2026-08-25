# Learning Preview 质量与评审矩阵

首次记录：2026-08-11；本轮更新：2026-08-25
判定规则：`通过` 只表示当前实验代码证据通过；`待人工` 或 `阻断` 均意味着不得进入稳定版安装包

## 自动化证据

| 范围 | 证据 | 当前判定 |
| --- | --- | --- |
| 前端类型与回归 | `npm.cmd run check` | 通过；32 个测试文件、207 个测试 |
| 默认关闭边界 | `npm.cmd run learning-off:verify` | 通过；默认 bundle 无学习页面、命令标记或演示数据 |
| 学习开启 bundle | `npm.cmd run learning:ui:build` | 通过；学习页/后端桥接独立分包，开启包包含预期命令 |
| 学习开启后端 | `cargo test -p yuanyuan-reminder --lib --features learning` | 通过；279 项通过，1 项因 Windows 符号链接权限忽略 |
| 提醒默认后端 | `cargo test -p yuanyuan-reminder --lib` | 通过；215 项通过，1 项按环境忽略 |
| Rust 24 线程稳定性门 | `npm.cmd run runtime:rust-parallel:evidence:verify` | 通过；完整 Authenticode provider-state 进程锁保留，并以有界 `MZ/e_lfanew/PE` 预检阻止非 PE 文件进入 `WinVerifyTrust`；修复后默认完整库 100/100，当前源码/二进制重新绑定的正式门默认 20/20、learning 10/10，P95 分别 1843.885/4647.590 ms。无 dump/WER 故障模块，故只认定复现条件已隔离且当前缓解具重复性，精确原生指令/模块仍待再现时捕获；见 [QA-002](./QA_002_RUST_PARALLEL_STABILITY_EVIDENCE.md) |
| AI 连续服务并行退出 | `cargo test -p yuanyuan-ai --lib` | 修复测试等待与现有 3 秒硬传输预算不一致的竞态；默认并行 10/10 轮（每轮 116 项）及 workspace 复验通过，生产超时未放宽 |
| 仓库总质量门 | `npm.cmd run verify` | 通过；迁移、保留、安全、发布证据合同、许可证和宠物包验证全部完成 |
| pre-GEN 文件读取+纯解析性能与协作检查 | `learning-pack-parse-spike-20260824T175724Z.json` + 性能/隔离 verifier | 30/30；20,000 卡 JSON/CSV 同时达到 26,020,105/26,120,061 bytes，内部管线 P95 481.523/359.907 ms，峰值 working set 123,691,008/75,395,072 bytes；三类进度检查点、独立 16 KiB 解码输入与单卡内部取消探针（含 Unicode 规范化输入和 CSV 分隔符/可选字段扫描）、JSON 九阶段/CSV 八阶段、≤256 回调和 `complete/cards` 终态均经复核；6 项隔离门测试及当前 metadata/源码/配置/产物扫描证明未接入应用、Tauri、SQLite、网络或发布能力；零数据库写入。未覆盖 Tauri 后台/IPC/WebView、OS 单次读取阻塞、文件替换 token 或真实导入 |
| 默认 Tauri 产物 | `npm.cmd run tauri build` + [QA-003](./QA_003_CLEAN_COMMIT_DUAL_BUILD_EVIDENCE.md) | 通过；从干净提交构建 Stable NSIS，最终 `dist` 再验为学习关闭 |
| 学习 Tauri 编译 | `npm.cmd run learning:desktop:build` + [QA-003](./QA_003_CLEAN_COMMIT_DUAL_BUILD_EVIDENCE.md) | 通过；从同一干净提交构建内部 Preview NSIS，个人内容边界通过；随后由默认关闭构建覆盖 |
| 个人词包与安装包 | `npm.cmd run learning:personal:prepare`、`learning:personal:desktop:build` | 通过；固定源 SHA-256，4533 卡、0 跳过；个人 NSIS 构建成功 |
| 安装态数据库 | 安装并启动个人版后只读核验 | 通过；进程响应正常，`quick_check=ok`，schema v3，4533 卡，客观题与回看表存在 |
| 格式与补丁卫生 | `cargo fmt --all -- --check`、`git diff --check` | 通过 |
| 呈现协调器合同 | 仲裁器定向测试 | 默认 12/12、learning 13/13；9 个呈现方的 72 个有序不同 owner 对、64 路全 owner 并发、同学习会话幂等、跨学习会话重绑拒绝和陈旧释放均通过 |
| 活动学习中强提醒抢占 | `learning-reminder-preemption-20260825T024056Z.json` + 独立 verifier + [QA-004](./QA_004_CURRENT_MACHINE_WINDOWS_RUNTIME_EVIDENCE.md) | 提交 `ee48194` 的当前 QA 二进制 20/20 通过；持久化暂停/UI 让位 P95 5.8/258.2 ms，逐样本均低于 1 秒；同参数首次运行因第 8 轮夹具自动答题碰撞为 19/20，失败报告保留且未采用，阈值未放宽 |
| 已提交答案后杀进程恢复下一未答题 | `learning-crash-recovery-20260824T165841Z.json` + 独立 verifier | 当前二进制 5/5；每轮先观测 127,752 bytes 非空 WAL 与 32,768 bytes 非空 SHM，再重启；已答计数始终恰为 1，下一未答 session/item/headword 原样恢复；恢复入口 P95 789.7 ms，点击继续到原题 P95 411.4 ms；commit hook 未 arm/进入，数据库健康且测试根可清理 |
| SQLite commit callback 内终止，未提交选择恢复原题 | `learning-in-flight-commit-recovery-20260824T165518Z.json` + 独立 verifier | 当前二进制 5/5；QA-only hook 进入 P95 55.1 ms 后精确终止；每轮先观测 57,712 bytes 非空 WAL 与 32,768 bytes 非空 SHM；重启/继续后的作答、复习、排程推进、答题事件和完成数均为零，原 session/item/headword 不变；恢复入口 P95 765.4 ms，点击继续到原题 P95 547.7 ms；数据库健康且测试根可清理 |
| 答题事务深层失败回滚 | `cargo test ... answer_event_failure` + `... answer_commit_failure` + `... answer_sqlite_full` | 通过；客观题与 recall 均覆盖 `answer_committed` 处 SQLite `ABORT`、deferred-FK 造成的真正 `transaction.commit()` 拒绝及页预算耗尽返回 `SQLITE_FULL`；排程、复习、作答、错题队列、事件和会话写入全部回滚，数据库健康且原幂等 ID/revision 可重试 |
| 学习中睡眠/唤醒状态 | `learning-sleep-wake-20260825T022625Z.json` + 独立 verifier + [QA-004](./QA_004_CURRENT_MACHINE_WINDOWS_RUNTIME_EVIDENCE.md) | 提交 `ee48194` 的真实原生菜单内容、共用菜单处理器、持久暂停/可恢复快照、睡眠/唤醒动画、Windows 无障碍提示和 5 张截图通过；物理右键与 OS 级菜单选择仍待人工 |
| 窗口与辅助显示矩阵 | `learning-accessibility-matrix-20260825T022326Z.json` + 独立 verifier + [QA-004](./QA_004_CURRENT_MACHINE_WINDOWS_RUNTIME_EVIDENCE.md) | 当前单显示器真实 150% DPI；提交 `ee48194` 的 Tauri 主线程调整真实 WebView，360×560、390×620、480×760 学习页及 520×420 小黑板通过且完整位于工作区；减少动态/强制颜色媒体状态由可访问树确认，6 张截图复核；其他 DPI、多屏/负坐标、Narrator 和物理键盘仍待人工 |
| 真实 Windows 标准模式与 Narrator 并发 | `learning-windows-system-mode-standard-20260825T072224Z.json`、`learning-windows-system-mode-standard-20260825T072325Z.json` + [QA-005](./QA_005_ACTUAL_WINDOWS_SETTINGS_EVIDENCE.md) | 提交 `ba6e841` 的两份 clean 报告均确认真实动画开启/高对比度关闭，学习页、小黑板、18 个可访问名称和受控退出通过；第二份在 Narrator 进程持续运行期间通过，随后进程恢复为 0。没有人工听读；DPI/减少动态/高对比度实际设置切换未形成证据 |

后端学习测试覆盖：schema 新建/升级/失败回滚、外键/WAL/busy timeout、并发读写与 checkpoint、损坏库隔离、原子导入、调度保留、客观题后端判定、错题回看不重复调度、提交幂等、客观题/recall 最深提交前语句失败、真正 `COMMIT` 拒绝及 `SQLITE_FULL` 的全量回滚与原样重试、runtime-QA-only commit hook 的精确 arm/无 arm/非法控制失败关闭、FSRS 冻结向量、时钟回拨、资格矩阵、邀请 claim/补偿/接受事务、伪造/过期/重放、含答题记录的 JSON 完整往返、失败恢复回滚、CSV 公式转义、无覆盖原子导出、清空与彻底删除。

## 浏览器视觉与键盘验收

| 场景 | 结果 |
| --- | --- |
| 390×620 小黑板选择题 | 通过；三项中文选项、首项焦点、圆圆与勾叉道具均渲染，无横向溢出 |
| 答错反馈 | 通过；所选错误项、正确项、正确释义、红色按钮和文字状态同时出现 |
| 结果后的焦点与进度 | 通过；修复结果进度提前加一，焦点转到“下一题”以照顾小窗口滚动 |
| 数据操作按钮 | 通过；导出、清空、删除均至少 40px 高 |
| 删除确认初始焦点 | 通过；焦点进入“取消” |
| 模态框 Tab/Shift+Tab | 通过；焦点在两个操作间循环 |
| 模态框 Esc 与焦点恢复 | 通过；关闭后回到原“删除全部学习数据”按钮 |
| 小黑板 Esc | 通过；返回学习首页，已提交数据保留、未答题不计入 |
| 答案披露 | 通过；提交前无正确标记，提交后结果保持到用户主动继续 |
| 浏览器运行日志 | 通过；验收过程中无 error/warn |

浏览器验收使用纯内存演示后端；真实 Tauri 的启动、数据库迁移、词包数量与完整性另有安装态只读证据，但文件选择器和 Windows 系统适宜性仍需人工验收。

## 必须人工执行的 Windows 矩阵

| 类别 | 最低场景 | 发布判定 |
| --- | --- | --- |
| DPI 与窗口 | 100/125/150/200%，360×560 至 480×760，多显示器和负坐标 | 部分通过；真实 150% DPI 下 360×560、390×620、480×760 学习页和 520×420 小黑板已封存，100/125/200%、多显示器与负坐标待人工 |
| 无障碍 | 仅键盘完整会话、Narrator 名称/顺序、减少动态、强制颜色 | 部分通过；DOM 自动焦点、真实 UIA 可聚焦性/名称、程序化减少动态及强制颜色已验证；Narrator 运行中的真实标准模式探针通过，但没有人工听读。foreground lock 下未注入物理按键，Windows 减少动态/高对比度实际切换仍未形成读回证据，详见 [QA-005](./QA_005_ACTUAL_WINDOWS_SETTINGS_EVIDENCE.md) |
| 系统适宜性 | 锁屏、演示设置、全屏/无边框全屏、单/多屏、任务栏、各 `QUERY_USER_NOTIFICATION_STATE` | 待人工 |
| 优先级竞态 | 喝水、活动、事项、任务守望、专注/睡眠在邀请前、展示中、学习中到达 | 部分通过；后端 72 个有序不同 owner 对及 64 路并发合同已穷举，当前二进制的活动学习中强提醒 20/20 和原生菜单睡眠/唤醒状态链已封存；物理菜单操作及其余真实桌面时序组合待人工 |
| 存储故障 | 只读目录、磁盘满、异常退出、残留 WAL/SHM、杀进程后恢复 | 部分通过；已提交答案异常终止后的非空 WAL/SHM 重放及单次计分 5/5、SQLite commit callback 内终止后的未提交选择零写入与原题恢复 5/5 已封存；客观题/recall 的最深提交前语句失败、SQLite 明确拒绝 `COMMIT` 及页预算耗尽返回真实 `SQLITE_FULL` 均已证明零半写入与可重试。只读目录、物理磁盘满/I/O 错误、损坏 WAL/SHM、真实断电及 callback 后每个更晚的 durable-write/硬件断电点仍待验证 |
| 文件操作 | 取消选择、同名目标、无权限路径、移动磁盘断开、JSON 完整恢复 | 待人工 |
| 性能 | 学习开/关的提醒领取与呈现 P95、冷启动、内存、EXE/安装包体积 | 部分通过；真实 release 启动/提醒/学习交互/2 小时内存已封存，签名候选体积与其余矩阵待人工 |
| 私有学习包研究 | 4 份合成材料、10—20 张制卡、字段映射、错误修复、模拟学习与内容库回程、匿名固定指标 | 执行包及 8 项隐私/隔离/交互检查通过；Product Research 内部试跑、5—8 人真实场次或具名延期待完成；研究原型不替代 PACK 实现 |
| 防打扰研究 | 7 天 `candidate → eligible → claimed → presented → engaged` 守恒、抑制原因、3 秒关闭率 | 待人工 |

## 发布 Go/No-Go

当前结论：**No-Go（稳定版） / Go（默认关闭的内部 Learning Preview 开发）**。

以下任一项未关闭，都维持 No-Go：

- 没有具名的内容再分发权与语言质量结论；
- 学习依赖未进入实际 feature 构建的许可证清单和 SBOM；
- Windows 其余 DPI、多显示器/负坐标、Narrator 人工听读/物理键盘、系统设置实际切换、系统适宜性、物理右键菜单操作和完整优先级竞态仍没有人工证据；已封存的 150% 窗口/辅助显示、真实标准模式/Narrator 并发探针、强提醒抢占、崩溃恢复与睡眠/唤醒状态链不替代该矩阵；
- 默认关闭包出现学习命令、页面、数据库写入或内容资源；
- 提醒核心回归、学习库故障影响提醒库、存在无 claim 的 presented 事件；
- 用户研究机会低于预设门、明显打扰或小样本被用于提分宣传。

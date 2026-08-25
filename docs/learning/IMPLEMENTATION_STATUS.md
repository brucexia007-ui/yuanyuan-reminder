# Learning Preview 实施状态

日期：2026-08-25<br>
基线：圆圆提醒 v1.4.0<br>
状态：阶段 0 的 REL-001/002 工程、全呈现方后端合同与当前哈希绑定 QA 二进制的强提醒、已提交答案异常终止恢复、SQLite commit callback 内终止的未提交选择回滚、原生菜单睡眠/唤醒、当前 150% DPI 窗口/辅助显示及真实标准系统模式/Narrator 并发核心 Windows 状态链已完成；Rust 原生签名并发类别的进程级缓解已通过默认 20 轮 + learning 10 轮正式稳定性门，但精确 Windows 故障模块仍未知；GEN-000 仍是未冻结草案，PACK-001 未开始；学习能力继续默认关闭

本文件第 1—7 节记录现有英语 Learning Preview 的实现清单；阶段 0/1 的最新任务判定、证据与 No-Go 以 `STAGE_0_1_COMPLETION_AUDIT.md` 为准。个人构建可内置本地词库，但不得作为稳定版或通用内容包发布结论。

## 1. 已落地的用户闭环

```text
用户导入 CSV / 圆圆原生 JSON
  → 只读预览与风险校验
  → 用户确认后原子写入独立学习库
  → 手动开始，或明确开启“专注结束邀请”
  → 到期卡优先、新卡受每日额度限制
  → 圆圆拉出小黑板 → 用户选择中文释义 → 圆圆按绿色勾或红色叉
  → 答对/答错映射为 FSRS-6 Good/Again 并原子落库
  → 本轮错题在原计划卡后回看一次，不重复调度
  → 首页显示到期、新卡、本周复习和相对稳定量
  → 用户可导出、清空进度或彻底删除
```

暂停或高优先级抢占会保留当前题与已经提交的答案，首页可“继续上一轮”；学习中请求睡觉也会先持久暂停并撤下学习租约，唤醒后保持可恢复但不自动重开小黑板。当前 runtime-QA 已验证真实原生菜单内容、共用菜单处理器、睡眠/唤醒动画和 Windows 无障碍提示；另在真实 150% DPI 验证学习页/小黑板固定尺寸、可访问名称/可聚焦性，以及程序化减少动态和强制颜色。真实标准系统模式和 Narrator 运行期间的应用兼容探针也已通过，但没有人工听读，Windows 减少动态/高对比度实际切换没有形成读回证据；物理右键、其他 DPI、Narrator 人工听读和物理键盘仍留给具名人工 Windows QA。主动结束或 24 小时过期会释放未答卡，未答卡不计复习。应用崩溃后的孤儿活动会话在重启时转为可恢复暂停；当前两组正式报告各 5 样本均在重启前观测到非空 WAL/SHM：已提交答案异常终止后只计一次并恢复下一未答题，答案 SQL 完成后在 runtime-QA SQLite commit callback 内终止则保持作答、复习、排程推进、答题事件和完成数全为零并恢复原题。两组数据库均健康且测试根可清理；callback 后更晚的 durable-write/真实断电点与物理存储故障仍未由此覆盖。无法生成至少两个安全选项时，才降级为原有主动回忆和自我评分。

## 2. 工程结构

| 层 | 主要位置 | 当前职责 |
| --- | --- | --- |
| 构建边界 | `src-tauri/Cargo.toml`、`vite.config.ts` | Cargo `learning` feature 与前端构建门，均默认关闭 |
| 学习后端 | `src-tauri/src/learning/` | 独立数据库、导入、FSRS 调度、资格引擎、Windows 适宜性、运行时协调 |
| IPC | `src-tauri/src/commands.rs`、`src/lib/backend.ts`、`src/types.ts` | 版本化 DTO、会话命令、邀请命令、导入导出和删除命令 |
| 学习界面 | `src/learning/` | 首页、小黑板选择题、错题/已学列表、设置、导入确认、数据管理和浏览器内存演示 |
| 宠物表达 | `src/pet/`、`src-tauri/src/companion_core.rs` | 合上学习卡、打开/忽略/今日暂停、非语言递卡与抢占清理 |
| 注意力预算 | `src-tauri/migrations/012_learning_invitation_attention.sql`、`repository.rs` | 主库只保存无内容 claim；学习事件保存在独立学习库 |
| 边界验证 | `scripts/verify_learning_disabled_boundary.mjs`、`verify_learning_enabled_bundle.mjs` | 验证默认包无学习代码，开启包独立分包且命令存在 |

## 3. 数据合同

- 数据库：`yuanyuan-learning.sqlite3`，当前内部 schema v6 会话部分；不进入提醒备份。该未发布迁移必须在 GEN-000 冻结后与最终通用项/调度定义合并，不能单独发布。
- SQLite：`foreign_keys=ON`、WAL、`synchronous=NORMAL`、`busy_timeout=2000ms`、打开时 `quick_check`。
- 内容来源：当前仅用户导入；没有生产内置词包。
- CSV：UTF-8、普通文件、受限大小/行数/字段/文本长度；稳定卡 ID 来自 `user.local + 规范化 headword` 的 SHA-256。
- 原生 JSON：格式标识 `yuanyuan.learning.export`、schema v1；可以完整恢复内容、调度、会话、复习日志、客观题记录和错题回看队列，并兼容旧导出。
- 导出：完整 JSON、卡片 CSV、复习记录 CSV；新文件原子写入、不覆盖现有文件、CSV 公式前缀转义。
- 删除：清空进度会保留内容与设置；彻底删除会移除学习库及 WAL/SHM 后创建空库，均不触碰提醒主库。

## 4. 触发、防打扰和优先级

默认模式为 `manual_only`。用户可以主动改为低频自动模式，但阶段 2A 只有 `focus_finished` 一个触发源；定时时段设置在数据结构中保留为不可开启状态。

自动邀请必须依次通过：用户明确同意、存在到期内容、未暂停、冷却和小时/日预算、没有活跃学习会话、圆圆当前可展示主动表达、Windows 明确允许通知、非锁屏/演示/全屏。未知系统状态或任何探测失败都抑制邀请。

展示前由主库 `BEGIN IMMEDIATE` 原子取得无内容 claim；若后续学习库、表达导演或展示失败，只补偿尚未展示的同一 claim。接受邀请时，学习会话与 `engaged` 事件在学习库同一事务提交。

学习服从现有高优先级事件。普通提醒、喝水、活动、任务守望结果、专注和睡眠请求会撤下邀请或中断学习表达；已评分学习数据不回滚。高优先级状态结束后不会残留学习卡道具。9 个呈现方的全部 72 个有序不同 owner 对和 64 路全 owner 并发已由后端测试穷举；同一学习会话重试幂等，不同学习会话不能偷换已有租约。真实桌面的全优先级时序组合仍保留为 Windows 人工门。

## 5. 已实现命令面

- 能力与设置：`get_runtime_capabilities`、`get_learning_home`、`update_learning_settings`
- 导入：`preview_learning_import`、`confirm_learning_import`
- 手动会话：`start_manual_learning_session`、`get_current_learning_question`、`answer_learning_question`、`pause_learning_session`、`resume_learning_session`、`abandon_learning_session`、`get_resumable_learning_session`，以及兼容降级用的 `get_current_learning_card`/`rate_learning_card`、`finish_learning_session`
- 自动邀请：`get_pending_learning_invitation`、`accept_learning_invitation`、`dismiss_learning_invitation`、`pause_learning_invites_today`
- 数据管理：`list_learning_records`、`get_learning_data_summary`、`export_learning_data`、`delete_learning_data`

这些命令只在后端 feature 启用时注册。前端即使收到伪造的 `tab=learning` 路由，也会在能力不可用时退回安全页面。

## 6. 仍然明确排除

- 稳定版内置考研词包、自动从互联网选择/下载内容；个人本机构建可按用户要求固定内置，但不得上传或再分发；
- 例句、音频、拼写、听说、聊天机器人和 AI 解释；
- 账号、云同步、跨设备、遥测和学习排行榜；
- 商业背词应用私有格式兼容；
- 定时时段、空闲检测、摄像头/麦克风感知；
- 以调度稳定度声明“已掌握”或“保证提分”。

## 7. 开发与构建入口

```powershell
# 完整学习开发质量门
npm.cmd run learning:verify

# 学习前端独立构建与分包验证
npm.cmd run learning:ui:build

# 后端学习 feature 测试
cd src-tauri
cargo test -p yuanyuan-reminder --lib --features learning

# 默认关闭边界
cd ..
npm.cmd run learning-off:verify
```

任何学习开启构建都只是内部测试产物。正式发布仍需 `QA_MATRIX.md`、内容权利、许可证/SBOM 和产品 Go/No-Go 全部关闭。

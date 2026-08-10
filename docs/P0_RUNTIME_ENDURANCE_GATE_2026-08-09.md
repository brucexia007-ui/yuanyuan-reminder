# P0 24 小时常驻、睡眠与锁屏验收门（2026-08-09）

## 当前结论

24 小时验收执行器、冻结阈值、系统事件记录和独立复核器已经完成，并以一次 30 秒真实 Tauri 窗口短测证明执行链可用。真实 24 小时运行尚未开始，因此 P0-003 的长期常驻、睡眠/唤醒和锁屏/解锁结论仍为待验收，不能用短测结果代替。

执行器使用隔离的 `runtime-qa` 主程序、独立应用标识和带精确所有权标记的数据根；正式用户目录、正式安装包和用户数据不参与本验收。AI 保持关闭，主程序按请求时长通过自身退出路径结束。

## 正式执行

先构建当前验收候选，再启动一次完整验收：

```powershell
npm.cmd run runtime:qa:build
npm.cmd run runtime:baseline:acceptance
```

验收期间必须由测试人员在同一 Windows 交互会话中至少完成一次真实的：

1. 锁屏，然后解锁；
2. 系统睡眠或休眠，然后唤醒。

执行器不会主动锁定、解锁、睡眠或绕过 Windows 认证。缺少任一成对系统事件时，报告会以退出码 2 保持待验收。

完整运行固定请求 86,400 秒、60 秒采样间隔和 300 秒预热。报告写入 `src-tauri/target/runtime-qa/release/evidence/runtime-baseline-<UTC>.json`，随后必须用绝对路径独立复核：

```powershell
npm.cmd run runtime:baseline:verify -- --report <absolute-json-path>
```

## 冻结通过条件

基础边界必须同时满足：应用受控退出且退出码为 0、隔离根安全清理、正式用户目录零新增写入、AI 子进程为 0、Windows Application Error 查询可用且结果为 0。

严格验收还要求：

- 墙钟观察不少于请求的 86,400 秒；
- 按相邻样本最多计两倍采样周期，活跃采样覆盖不少于 72,000 秒；这允许真实睡眠，但不允许用大段缺样冒充 24 小时常驻；
- 至少一组 `suspend → resume` 和一组 `lock → unlock`，且顺序来自运行期间的 Windows `SystemEvents`；
- 将全部样本按时间分为 6 段，每段使用中位数，再以 6 个中位点计算每小时线性斜率；工作集、私有内存、句柄和线程均由独立复核器重新分段、重算；
- 数据库增长、CPU 与资源趋势均不超过下表冻结值。

| 指标 | 上限 |
|---|---:|
| 归一化 CPU 平均 | 2.0% |
| 归一化 CPU P95 | 5.0% |
| 工作集六段斜率 | 4 MiB/小时 |
| 工作集首末段中位数增长 | 64 MiB |
| 私有内存六段斜率 | 2 MiB/小时 |
| 私有内存首末段中位数增长 | 32 MiB |
| 句柄六段斜率 | 2/小时 |
| 句柄首末段中位数增长 | 32 |
| 线程六段斜率 | 0.5/小时 |
| 线程首末段中位数增长 | 8 |
| SQLite 文件族增长 | 1 MiB |

斜率与首末段增长采用双门，避免单个末尾样本或早期 WebView 释放造成乐观结论，也避免仅看首尾值漏掉持续增长。

## 证据防伪边界

报告 schema v2 绑定以下三份 SHA-256：

- `yuanyuan-reminder.exe`；
- `yuanyuan-runtime-qa-fixture.exe`；
- `scripts/measure_runtime_baseline.ps1`。

独立 Node 复核器只接受验收证据目录内的普通文件，会重新绑定当前三份来源，检查精确字段集合、时间顺序、样本统计、P95、活跃覆盖、系统事件配对、六段中位数、四项斜率、所有冻结阈值和最终失败原因。当前 5 项回归覆盖 UTF-8 BOM、来源过期、样本/趋势篡改、未知字段、缺失唤醒事件、乐观通过以及短测冒充 24 小时证据。

## 30 秒执行链短测

命令：

```powershell
npm.cmd run runtime:baseline -- -DurationSeconds 30 -SampleIntervalSeconds 2 -WarmupSeconds 5
```

报告：`src-tauri/target/runtime-qa/release/evidence/runtime-baseline-20260808T190153Z.json`  
报告 SHA-256：`D2B509CDEC0C547F332846C0FB81C7925A9C999C1BE1A8D7881B9FB952E3EDC4`

本次实际窗口在 188.3 ms 可见，采集 11 个样本，归一化 CPU 平均 0.0733%，正式目录写入 0、AI 子进程 0、Application Error 0，应用受控退出且隔离根已清理。报告可通过结构复核；严格复核会因 `acceptanceGateRequested=false` 拒绝，证明短测不能冒充正式验收。

## 尚未关闭的范围

- 尚无真实 24 小时正向报告；
- 本执行器验证 AI 关闭的稳定核心，不替代 Bridge、AI 和真实连接器组合的 24/72 小时常驻；
- 不替代正式默认二进制、签名候选、断网恢复、提醒跨睡眠调度、干净机器、安全软件、多 DPI 或第二 Windows 账户证据；
- 若正式验收失败，应保留原始失败报告和失败原因，不放宽冻结阈值或手工改写 `ready`。

# QA-005：当前电脑真实 Windows 设置逐项试验与恢复证据

日期：2026-08-25  
源码提交：`ba6e841b30430f989d161df9aea95fc7deee87f3`  
分支：`feat/fragment-learning-stage-0-1`  
判定：真实标准系统模式与 Narrator 并发兼容探针通过；DPI、减少动态和高对比度的实际切换没有形成可接受证据，稳定版仍保持 No-Go

## 1. 安全边界

本轮按“改一项、测一项、立即恢复并读回”的顺序执行。恢复读回使用 Windows `SystemParametersInfo`、高对比度标志、`AppliedDPI`、辅助技术启用配置、相关进程和合成测试根，而不是仅依据设置页显示。

- 没有用注册表写入强制切换 DPI、动画、高对比度或 Narrator，没有注销当前账户，没有安装虚拟显示器驱动，没有改变分辨率、电源计划或真实用户数据库。收尾时只删除了一个由本轮 Narrator 启动新建、且启动前证据明确为不存在的空 `Accessibility.Configuration` 值，以恢复该项精确基线。
- 只关闭了本轮打开的 `SystemSettings` 和 Narrator 进程。
- 两个调试根和各探针自己的隔离根只包含合成 QA 数据；其中一个 WebView 缓存第一次因子进程占用未删净，待句柄释放后按已核验的精确绝对路径重试删除。最终没有 `yuanyuan-runtime-qa-*` 合成根残留；删除不可恢复，但不包含用户数据。
- 锁屏会异步切换安全桌面，并要求用户重新认证才能恢复；自动执行无法满足“立即恢复”，所以没有调用 `LockWorkStation`。

## 2. 逐项结果

| 项目 | 基线与尝试 | 恢复读回 | 判定 |
| --- | --- | --- | --- |
| Windows 显示缩放 | `AppliedDPI=144`，设置页列出 100/125/150（推荐）/175/200/225%；尝试通过设置页自动化选择 100%，但系统读回始终没有变化 | `AppliedDPI=144`（150%） | **未提交变化**；不能据此声称 100/125/200% 已测 |
| 减少动态 | `SPI_GETCLIENTAREAANIMATION=true`；分别尝试官方 SPI setter 和设置页动画开关，调用未形成新的系统读回值 | 动画仍为 `true` | **未提交变化**；实际减少动态仍待人工 |
| 高对比度 | 标志为 `126`，启用位为 0；系统当前没有可解析的 `CurrentTheme` 文件路径，无法冻结原主题哈希 | 高对比度仍关闭，标志仍为 `126` | **为保证可恢复而跳过写入**；实际强制颜色仍待人工 |
| Windows Narrator | 启动前 Narrator 进程为 0，`Accessibility.Configuration` 值不存在；启动后确认进程存在，并在它持续运行时执行标准系统模式应用探针 | 探针后先确认 Narrator 仍在运行，再停止；最终进程为 0，并删除本轮新建的空 `Accessibility.Configuration` 值，恢复为不存在 | **应用兼容探针通过**；没有人工听读，不等于 Narrator 发布验收通过 |
| 物理键盘/菜单 | 当前远程自动化环境拒绝系统级物理按键注入；既有 UI Automation 仍可确认焦点、名称和 Invoke 行为 | 无系统设置变化 | 物理按键、右键及 OS 级菜单选择仍待人工 |
| 多显示器/负坐标 | 当前只有 `DISPLAY1`；没有安装虚拟显示器驱动 | 仍为单显示器 | 不适用本机，仍待真实多屏环境 |
| 锁屏/解锁 | 未调用；自动化不能绕过 Windows 认证完成恢复 | 会话未锁定 | 仍待测试人员在场的人工闭环 |

Windows 设置自动化在本机存在一个重要限制：Selection/Toggle/键盘调用可以被接口接受，但 Windows 实际设置读回不变。因此本证据只接受“读回发生改变且恢复读回一致”的切换；没有把设置页调用成功冒充为系统设置已切换。

## 3. 接受报告

| 场景 | 报告 | 字节数 | SHA-256 | 结果 |
| --- | --- | ---: | --- | --- |
| 真实标准 Windows 模式 | `learning-windows-system-mode-standard-20260825T072224Z.json` | 4,361 | `3DC3AEA951FF5712D0A10AAFA9C370052EC7744B3566356F68560EAB12AE5BBA` | `dirty=false`；动画开、高对比度关；学习页、小黑板、18 个可访问名称和受控退出全部通过 |
| Narrator 运行中同一探针 | `learning-windows-system-mode-standard-20260825T072325Z.json` | 4,361 | `4EDDD3872D1F3B6DE529D024474F45807C91C14B538F666B4574265D2EFED65C` | `dirty=false`；应用探针通过；外层执行记录在探针前启动 Narrator，并在探针结束后观测到 1 个 Narrator 进程，随后恢复为 0 |

两份报告都绑定提交 `ba6e841`、应用、fixture、合成内容、数据库和探针脚本 SHA-256。报告位于 `src-tauri/target/runtime-qa-learning-accessibility/release/evidence/`，不纳入 Git。

## 4. 保留的失败报告

首次 Narrator 嵌套启动和随后一个不同启动上下文的对照分别生成：

- `learning-windows-system-mode-standard-20260825T071659Z.json`，3,100 bytes，SHA-256 `ED47666D2F222A70743BEF596227E247975A92FDB1B7D6048E86190737E4E065`；
- `learning-windows-system-mode-standard-20260825T071803Z.json`，3,100 bytes，SHA-256 `72B8B5DB79E219BE489266F9B0F47ADA03ABDABBC5684BCDE77C0D489F564D8A`。

两份均为 `Ready=false`，失败点是 30 秒内没有读到 `exit-scheduled`，且隔离根清理成功。随后独立诊断在 8 秒内观察到 `setup-entered`、`windows-created`、`core-setup-complete` 和 `exit-scheduled` 四个阶段；按与成功诊断相同的桌面上下文重跑，标准模式和 Narrator 并发各通过一次。失败报告继续保留且不参与通过判定；当前证据只证明接受路径可重复成功，不宣称两个启动上下文失败的精确原因已经根因闭环。

## 5. 最终本机状态与已知残留

最终统一读回：

- 客户区动画开启；
- 高对比度关闭，标志 `126`；
- `AppliedDPI=144`（150%）；
- Narrator、`SystemSettings`、测试版 `yuanyuan-reminder` 相关进程均为 0；
- `Accessibility.Configuration` 值不存在，与启动前冻结结果一致；
- 合成 QA 根为 0，Git 工作树在写本文前为 clean；
- 单显示器物理坐标为 3840×2160、工作区 3840×2088；按 150% 缩放折算，与 runtime-QA 先前观察的 2560×1440、工作区 2560×1392 逻辑坐标一致。

Narrator 是唯一需要额外披露的系统残留：相关注册项的最后写入时间落在本轮 Narrator 运行期间，证明 Windows 写入了 Narrator 的首次运行/偏好/缓存数据。启动前只冻结了进程、辅助技术启用配置和若干顶层值，没有完整导出这些子项，因此不能安全判断哪些值原先存在，也不能精确回滚。唯一有精确“不存在”基线的空 `Accessibility.Configuration` 值已经删除；其余未知偏好没有删除或猜写。Narrator 的实际进程和系统启用配置已经恢复为关闭。后续若要求“注册表逐字节零变化”，必须改用一次性 Windows 测试账户或虚拟机快照重做。

## 6. 发布含义

本轮新增的有效事实是：当前电脑真实标准系统模式可由原生探针识别，且 Narrator 运行期间应用仍暴露学习页、小黑板和完整可访问名称并正常受控退出。

它不能替代具名人员实际听读，也没有关闭实际减少动态、深浅高对比度、100/125/200% DPI、物理键盘、物理右键、多屏/负坐标、锁屏/解锁、演示或全屏矩阵。稳定版继续保持 **No-Go**；默认关闭的内部 Learning Preview 开发结论不变。

## 7. 仓库收尾验证

- `npm.cmd run verify`：通过；前端 32 个测试文件、207 项测试及默认关闭、数据库、安全、发布证据合同和宠物资源检查全部完成。
- `cargo test`：通过；默认 workspace 全量测试无失败，主程序 215 项通过、1 项按环境忽略，其余 crate 与进程集成测试均通过。
- `npm.cmd run tauri build`：通过；生成默认 Stable x64 NSIS 安装包。
- 构建后再次执行 `verify_learning_disabled_boundary.mjs` 和 pre-GEN 产物隔离检查：默认 `dist` 8 个文件不含学习 UI、命令、数据库名、内容资源或 parser spike 接入。

## 8. Windows 依据

- [Microsoft：SystemParametersInfoW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-systemparametersinfow)
- [Microsoft：Windows 设置 URI](https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-settings)
- [Microsoft：Narrator 键盘命令](https://support.microsoft.com/en-us/windows/appendix-b-narrator-keyboard-commands-and-touch-gestures-8bdab3f4-b3e9-4554-7f28-8b15bd37410a)
- [Microsoft：LockWorkStation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-lockworkstation)

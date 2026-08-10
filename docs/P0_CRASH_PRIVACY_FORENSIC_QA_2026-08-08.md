# P0 AI 强退、转储与换页取证 QA（2026-08-08）

## 当前结论

已完成可重复执行的两阶段取证工具、独立复扫和规则回归，但尚未在获授权的隔离 Windows 主机上执行，因此本门仍为**待完成**，不得据此开放 Support Box 正式正文入口。

本工具不会修改 HKLM、WER 或 LocalDumps 配置，也不会在普通开发、测试、正式构建或安装包路径中自动运行。第一阶段会有意让一个位于独立构建目录的 QA 注入版 `yuanyuan-ai.exe` 在真实完成 Provider 描述、单次授权和动态正文提交后异常终止，只能在明确允许制造进程崩溃的隔离主机上执行。

## 为什么分成两个阶段

运行中的 Windows 通常不能为普通进程可靠读取活动页面文件。若只在进程退出后扫描应用目录和转储目录，就不能声称已经检查换页暴露。因此证据分为：

1. **在线强退捕获**：真实走通 Support Sort 正文路径并异常终止，扫描隔离应用数据目录、标准输出和操作员指定的专用转储目录；
2. **关机后离线复扫**：在隔离主机停机后取得页面文件副本，并根据主机当时状态处理休眠文件和交换文件，再使用同一动态金丝雀进行 UTF-8、UTF-16LE 流式扫描和 SHA-256 固定。

只有两阶段均通过，最终报告的 `ready` 才能为 `true`。在线捕获报告本身只会写出 `readyForOfflineMemoryScan=true`，不会冒充最终证据。

## 第一阶段：隔离主机在线捕获

前提：

- 操作员确认该主机可以安全制造测试进程崩溃；
- `workspace` 和每个 `dump-root` 都是已存在、为空、互不重叠且不含重解析点的绝对目录；
- `dump-root` 必须是本轮隔离试验实际监控的专用转储位置；工具不会替操作员开启可能扩大正文暴露面的系统转储策略；
- 报告目标必须是尚不存在的绝对 `.json` 文件。

执行格式：

```powershell
npm.cmd run security:crash-privacy:qa -- `
  --report <在线捕获报告绝对路径> `
  --workspace <空工作目录绝对路径> `
  --dump-root <空转储目录绝对路径> `
  --attest-isolated-test-host isolated_windows_crash_privacy_capture_v1
```

可重复传入 `--dump-root`。工具会：

- 在独立的 `src-tauri/target/crash-privacy-qa` 目录构建带 QA 注入点的 release AI 和执行器；
- 运行与正式路径相同的崩溃隐私策略、私密 stdin 引导、客户端身份校验、Provider 描述、单次授权及正文提交；
- 从 32 字节运行时随机 nonce 派生唯一合成金丝雀，金丝雀不放入命令行、环境变量或报告正文；
- 只有 Provider 收到合法动态金丝雀时才调用异常终止；
- 等待转储目录至少五秒且状态稳定后，扫描隔离应用目录、指定转储目录以及捕获的标准流；
- 报告只保留 nonce、金丝雀 SHA-256、源码/执行器 SHA-256、固定状态和汇总计数，不保留 PID、正文或匹配文件路径。

任一目录不可读、出现重解析点、超过冻结的文件/字节上限、观察到 UTF-8/UTF-16LE 金丝雀、AI 未异常退出或源码绑定失效，捕获都不能通过。

## 第二阶段：离线页面文件终结

隔离主机完成在线捕获后，应先停机，再从可信离线环境取得本轮主机的页面文件副本。至少必须提供一个页面文件；不能用“页面文件可能关闭”跳过本门。休眠文件和交换文件必须分别明确声明当时不存在/关闭，或提供对应离线副本。

休眠和交换均不存在时：

```powershell
npm.cmd run security:crash-privacy:finalize -- `
  --capture-report <在线捕获报告绝对路径> `
  --report <最终证据报告绝对路径> `
  --pagefile-artifact <离线页面文件副本绝对路径> `
  --hibernation-state disabled_at_crash `
  --swapfile-state absent_at_crash `
  --attest-offline-acquisition isolated_windows_offline_memory_acquisition_v1
```

存在休眠或交换文件时，把对应状态改为 `artifact_supplied`，并分别增加 `--hiberfil-artifact` 或 `--swapfile-artifact`。多页面文件可重复传入 `--pagefile-artifact`。

最终报告生成后，使用完全相同的捕获报告、离线文件和状态参数，把 `--report` 改成 `--verify-report <最终证据报告绝对路径>`。验证器会重新计算当前三份源码哈希、捕获报告哈希、所有离线文件哈希并重新流式扫描，不只相信最终 JSON 中的布尔值。

## 已完成的自动证据

- Rust：9 项 QA 注入版 AI 参数/运行规则测试和 4 项捕获执行器测试通过；
- Node：4 项离线终结/复扫测试通过，覆盖源码漂移、捕获缺项、离线覆盖缺项、跨 64 字节分块的 UTF-8/UTF-16LE 金丝雀以及最终报告重新验证；
- `cargo clippy -p yuanyuan-ai --all-targets --features crash-privacy-qa -- -D warnings` 通过；
- QA 注入版 release 构建在独立 target 目录通过；
- 正式 `src-tauri/target/release/yuanyuan-ai.exe` 的二进制边界检查通过：崩溃注入开关和动态金丝雀前缀均不存在，原有三项崩溃隐私正向标记仍存在；
- `npm verify` 已接入 Rust 捕获规则和 Node 离线证据规则，但不会自动制造崩溃。

## 证据边界

通过结果只证明：对本次源码绑定的 QA 注入版 release AI、这一次合成金丝雀和操作员声明完整的指定文件集合，未观察到该金丝雀的 UTF-8 或 UTF-16LE 明文。

它不证明：

- 所有编码、压缩页、加密容器、GPU/驱动内存或未提供的外部转储都没有残留；
- 管理员、调试器、终端安全软件或恶意高权限进程无法读取正文；
- QA 注入版与未来签名正式 AI 候选在字节层面相同；
- 其他 Windows 版本、硬件、页面文件策略和安全软件组合自动继承本次结论；
- “零落盘”“零转储”或“绝对无法恢复正文”。

因此仍需把真实隔离执行、签名候选绑定、第二账户和目标环境矩阵作为独立发布证据；本工具的价值是把其中“强退后究竟扫描了什么”变成可审计、可失败、不可用空目录或在线页面文件替代的流程。

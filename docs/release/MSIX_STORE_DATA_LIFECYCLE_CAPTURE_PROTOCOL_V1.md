# Microsoft Store 数据生命周期采集协议 V1

状态：采集工具已实现；等待 Partner Center 身份、冻结候选和可销毁 Windows 11 环境

## 1. 用途与边界

本协议为低成本发布方案采集五类 Store 数据生命周期证据：NSIS 到 MSIX、备份恢复、向前更新、卸载保留，以及应用内显式删除后卸载。

采集程序是必须显式开启 `store-data-lifecycle-qa` 特性的非发布工具，不进入默认程序或安装包。它只读取当前 Windows 账户固定的 `LOCALAPPDATA/com.yuanyuan.reminder/yuanyuan-reminder.sqlite3`，只输出 schema、按表记录数、数据库文件哈希和不含正文的逻辑状态哈希。它不接受任意数据库路径，也不输出真实磁盘路径或记录正文。

Docker 可以运行合成数据库单元测试，但不能作为最终结论环境。MSIX 注册、AUMID 启动、更新、卸载、托盘、通知和应用内删除必须在真实、可销毁的 Windows 11 交互式用户会话中完成。

## 2. 严格前提

- 使用可回滚的干净 Windows 11 虚拟机快照或专用测试机；
- 使用从未保存过圆圆真实数据的新 Windows 测试账户；
- 只创建明显虚构的提醒、专注、喝水、设置和备份数据；
- 已生成并验证 Partner Center 身份、Store 发布清单和一次性测试签名运行报告；
- NSIS 迁移源来自 `release:unsigned-beta:freeze` 的不可覆盖目录，且 `release:unsigned-beta:github:verify` 已证明同一提交、同一安装包和同一校验文件以 GitHub prerelease 匿名公开；旧手工摘要或默认构建输出不能替代这两份报告；
- 每次采集前完全退出圆圆，任务管理器中不得存在 `yuanyuan-reminder`；
- 初始化前，固定数据目录必须不存在。工具遇到已有目录会停止，不会检查、删除或复用其中的内容；
- 一个会话只绑定一套候选、发布清单和运行报告。任何文件变化都必须恢复干净快照并使用新 UUID 重做。

## 3. 初始化一次性会话

在项目根目录生成一个新 UUID，并在首次启动任何圆圆版本之前初始化：

```powershell
$sessionId = [Guid]::NewGuid().ToString("D").ToLowerInvariant()
npm.cmd run msix:store:data:capture -- `
  -Mode Initialize `
  -SessionId $sessionId `
  -ConfirmDisposableWindows11Environment `
  -AcknowledgeFreshTestAccount `
  -ConfirmSyntheticDataOnly
```

初始化会在固定数据根写入一次性会话标记，并在 `src-tauri/target/msix-store-data-lifecycle/<UUID>/session.json` 保存外部副本。两者必须始终一致。不要手工编辑、复制到其他账户或复用旧会话。

## 4. 固定检查点

完全退出应用后，使用同一条命令采集每个检查点：

```powershell
npm.cmd run msix:store:data:capture -- `
  -Mode Capture `
  -SessionId $sessionId `
  -Checkpoint <固定名称> `
  -ConfirmDisposableWindows11Environment `
  -AcknowledgeFreshTestAccount `
  -ConfirmSyntheticDataOnly
```

按以下顺序操作，不得跳过或改名：

| 固定名称 | 采集时机 | 仍需人工记录 |
| --- | --- | --- |
| `nsis_before` | 冻结 NSIS 测试版创建合成基线并完全退出后 | NSIS 来源、进程已退出、安全备份已创建 |
| `msix_after` | 同一账户安装、启动当前 Store 候选并完全退出后 | 实际安装、启动和迁移观察 |
| `backup_baseline` | 创建应用备份前的稳定基线 | 备份文件位置与创建动作 |
| `backup_mutated` | 仅修改合成数据并完全退出后 | 可见变更说明 |
| `backup_restored` | 用应用恢复备份并完全退出后 | 备份文件 SHA-256 和恢复动作 |
| `update_before` | 安装更高版本测试包前 | 当前包版本和包哈希 |
| `update_after` | 原位更新、启动并完全退出后 | 更高版本、PFN、Publisher、启动和清理结果 |
| `uninstall_keep_before` | 卸载保留场景执行前 | 即将卸载的包身份 |
| `uninstall_keep_reinstalled` | 卸载、保留外部数据、重装并打开旧库后 | 卸载、保留和重装观察 |
| `delete_before` | 应用内“删除全部本地数据并退出”之前 | 明显的合成哨兵数据和三重确认截图 |

工具拒绝覆盖已有报告。误采、应用未完全退出、schema 不为 11、固定 10 张表漂移、数据库/WAL/SHM 在读取期间变化或会话标记不一致时，恢复干净快照并创建新会话，不要删除单个报告后拼接证据。

## 5. 最终删除观察

完成 `delete_before` 后，在应用内逐字输入“删除圆圆全部本地数据”、勾选不可恢复确认并通过最后一次系统确认。等待应用退出和受限清理完成，然后卸载 MSIX。确认包已不再注册后执行：

```powershell
npm.cmd run msix:store:data:capture -- `
  -Mode ObserveDelete `
  -SessionId $sessionId `
  -ConfirmDisposableWindows11Environment `
  -AcknowledgeFreshTestAccount `
  -ConfirmSyntheticDataOnly `
  -ConfirmExplicitInAppDeleteCompleted
```

该步骤只接受整个固定数据根已不存在的结果；不会用“仅数据库文件不存在”或“普通卸载”冒充应用内显式删除。

## 6. 生成待人工复核草稿

11 个固定报告齐全后执行：

```powershell
npm.cmd run msix:store:data:assemble -- --session-id $sessionId
```

输出：

- `capture-index.json`：逐文件绑定会话清单和 11 个报告的 SHA-256；
- `acceptance.draft.json`：预填 schema、逻辑状态哈希、表级计数和删除后缺失事实。

草稿保持 `status=pending`、测试人和环境为空、所有截图/说明/人工通过项未批准、`outcome.accepted=false`。具名测试人完成截图脱敏、备份文件哈希、包版本/身份、安装/卸载观察和最终复核后，才可把草稿复制为 `docs/release/MSIX_STORE_DATA_LIFECYCLE_ACCEPTANCE_V1.json` 并执行：

```powershell
npm.cmd run msix:store:data:verify
```

最终校验会重新读取捕获索引、会话清单和全部报告，复算 SHA-256，并把正式验收中的 schema、逻辑哈希、计数和删除结果逐项反查到机器证据。任何手工漂移都会关闭失败。

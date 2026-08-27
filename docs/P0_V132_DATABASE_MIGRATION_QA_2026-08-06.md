# v1.3.2 真实数据库迁移验收

更新时间：2026-08-27
对应任务：P0-004

## 当前结论

**P0-004 已完成官方 v1.3.2 发布件的真实运行数据库闭环。** 在全新 Windows Sandbox 账户中，使用 GitHub 正式发布的 v1.3.2 Portable、精确发布哈希、对应 Git 标签归档和微软签名 WebView2 Runtime，已真实进入 Tauri `setup` 并生成 schema v6 数据库。随后使用当前 1.5.3 生产 `Repository::open` 迁移到 schema v12，原有表、列和值逻辑摘要完全一致，生产备份恢复、迁移失败安全快照回滚和回滚后健康读取全部通过。

本次来源不是仅凭 `PRAGMA user_version = 6` 推断：执行链同时绑定 v1.3.2 Git 标签提交、标签归档、GitHub 发布资产、发布页 `SHA256SUMS.txt`、Windows Product/File Version、隔离运行时创建时间和捕获辅助程序。测试仅使用旧版首次启动生成的默认本地数据，没有打开、复制或修改本机现有用户数据库；Sandbox 内的应用数据根和暂存根在报告写出前已按所有权标记精确清理。

## 2026-08-27 官方发布件隔离闭环

- 官方 Portable SHA-256：`D142095E41EA4A1D6BB89D7A20D8F44CBA3519C085E4EC5E674E4FB25CFF89AD`；发布校验文件 SHA-256：`A3553273D4EE693FED5B9DB50C83A675EB0C1650B022A75067C6A1A83CDB160D`；标签归档 SHA-256：`ED91C071372B08BECAC0D7DA258B1B80154C2C25834FCCA87F338A33A592024E`。
- 旧版运行库在关闭前真实使用 WAL/SHM；SQLite Backup API 将其规范化为无 sidecar 的 77,824-byte schema v6 副本，捕获前后主库和 WAL 哈希保持不变。
- v1.3.2 默认运行数据包含 2 条提醒、1 条设置和 1 条活动状态；迁移后这些原有表的逐值逻辑摘要完全一致。
- 当前生产迁移目标为 schema v12；`source_read_only`、`source_integrity`、`v132_schema_identity`、`production_migration`、`row_preservation`、`backup_restore`、`failed_restore_rollback`、`post_restore_health` 八项全部通过。
- `npm.cmd run release:community:v132-sandbox` 可重新生成隔离证据；`npm.cmd run release:community:v132:verify -- --evidence-root <绝对目录>` 会独立重算源码、辅助程序、旧版资产、数据库和报告哈希，并拒绝脏工作区冒充正式证据。

## 已实现的验收边界

- 命令必须显式收到绝对样本路径、绝对 `.json` 报告路径和操作者的 `--attest-source-release 1.3.2` 来源声明；报告父目录必须已存在且目标文件必须尚不存在，工具只新建、不覆盖；没有样本或来源声明时退出码为 2，不会悄悄换用合成数据。
- 只接受普通文件、1—512 MiB、无相邻 `-wal` / `-shm` 文件且 `PRAGMA user_version` 恰好为 6 的关闭态副本。
- 原文件仅以 SQLite 只读方式打开；迁移、修改、恢复和故障注入全部发生在随机临时目录中的逻辑副本上。
- 执行前后复核原文件 SHA-256，任何变化都会令验收失败。
- 使用生产 `Repository::open` 执行 v6→v11 迁移，并通过设置、今日事项、宠物照料和历史记录读取检查。
- 对旧库全部既有表、列和值计算规范化逻辑摘要；迁移后的相同列必须逐值一致，不只比较行数。
- 使用生产备份恢复入口建立备份，写入临时事项，再恢复并确认临时事项消失、表计数回到备份状态。
- 构造一份 SQLite 完整、版本仍为 6、但迁移 7 必然失败的副本，强制进入“恢复失败→安全快照回滚”分支；回滚后标记事项、schema v11 和核心读取必须仍然正常。
- JSON 报告只包含文件名、文件 SHA-256、大小、schema 版本、聚合表计数、逻辑摘要和固定检查结果；不包含原路径、事项标题、倾诉、历史正文或其他用户内容。

这轮故障注入发现并修复了一个真实缺陷：历史迁移脚本中的事务在 SQL 失败后可能保持打开，导致同一连接上的安全快照恢复看似成功、实际仍暴露半迁移结构。现在每次迁移失败都会先显式回滚未关闭事务，默认 Rust 回归会永久覆盖该路径。

## 2026-08-09 历史失败复核（已由上述 Sandbox 闭环取代）

- Git 标签 `v1.3.2` 指向提交 `11841b88cf7b3e6d10502fd0158401e2c02167ae`；确定性标签归档 SHA-256 为 `ED91C071372B08BECAC0D7DA258B1B80154C2C25834FCCA87F338A33A592024E`。
- GitHub 正式发布资产 `Yuanyuan-Reminder-1.3.2-x64-Portable.exe` 为 20,574,720 bytes，Windows Product/File Version 均为 `1.3.2`，SHA-256 为 `D142095E41EA4A1D6BB89D7A20D8F44CBA3519C085E4EC5E674E4FB25CFF89AD`；该值同时匹配 GitHub 资产摘要和发布中的 `SHA256SUMS.txt`。校验文件 SHA-256 为 `A3553273D4EE693FED5B9DB50C83A675EB0C1650B022A75067C6A1A83CDB160D`，发布件未签名。
- 同一发布的 `Yuanyuan-Reminder-1.3.2-x64-Setup.exe` 为 12,071,368 bytes，SHA-256 为 `FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1`，与 `SHA256SUMS.txt` 精确一致且未签名。静默安装到带所有权标记的隔离目录返回 0；实际安装主程序为 20,574,720 bytes、Product/File Version 1.3.2、SHA-256 `864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF`。
- 在数据根预先不存在、无圆圆进程的独立普通 Windows 测试账户中执行 5 次发布件启动复核，覆盖工作区/账户临时目录暂存、子流重定向开关、一次禁用 WebView JavaScript 的初始化诊断，以及一次把子进程环境显式校正为当前令牌经 `ProfileList` 注册的真实配置目录后重试；每次均出现窗口并创建 `EBWebView`，但 30 秒内没有日志或 `yuanyuan-reminder.sqlite3`，测试进程、WebView、数据根和暂存根随后全部安全清理。
- 安装版主程序另做一次 25 秒有界启动，同样出现“圆圆”窗口并只建立 `EBWebView`，没有业务数据库；本轮新建的 124 个 WebView 文件、应用数据根、安装注册、快捷方式和测试进程均在确认所有权后清理。Setup 路径因此不能绕过同一初始化阻塞。
- 一份只用于定位、不会作为证据的标签源码诊断构建记录到 `run` 入口，但没有记录到 `.setup(...)` 入口，说明阻塞发生在生产数据库初始化之前。正式发布件本身没有被修改；诊断构建和失败运行都不冒充真实数据库证据。
- 因此当前可确认的是“正式发布件来源真实、但此隔离账户无法生成旧库”，不是“真实旧库已迁移通过”。后续仍需一份从已正常运行的 v1.3.2 完全退出后取得的副本，或一个能让该发布件完成 `setup` 的独立普通 Windows 账户。未经额外授权，不会读取现有用户目录来绕过此门。

为安全接收真实运行库，新增 `database:migration:capture`：它允许关闭态源库保留 WAL，先核对主库和 WAL 在捕获前后哈希稳定，再用 SQLite Backup API 生成无 sidecar 的单文件副本，切回 `DELETE` journal，复核 `quick_check`、schema v6、全部表/列/值逻辑摘要和聚合计数。捕获报告同样不包含源路径或用户内容。

## 可选的长期用户样本补充方法

官方发布件的稳定发布阻塞项已经由隔离闭环关闭；如果后续希望额外覆盖长期使用、包含更多历史记录的用户样本，可在用户明确授权后按以下方式补充。先完全退出 v1.3.2，在文件资源管理器中复制其数据库；不要直接对正式用户数据库执行验收。确认复制品旁边没有同名 `-wal` 或 `-shm` 文件后运行：

```powershell
npm.cmd run database:migration:qa -- --fixture "F:\绝对路径\v1.3.2-copy.sqlite3" --report "F:\绝对路径\v1.3.2-migration-report.json" --attest-source-release 1.3.2
```

如果完全退出后的源库仍保留 WAL，先在同一台受控机器上生成稳定副本；`--fixture` 和 `--report` 必须是尚不存在的新文件：

```powershell
npm.cmd run database:migration:capture -- --source "F:\绝对路径\yuanyuan-reminder.sqlite3" --fixture "F:\绝对路径\v1.3.2-copy.sqlite3" --report "F:\绝对路径\v1.3.2-capture-report.json" --attest-source-release 1.3.2
```

自动回归：

```powershell
npm.cmd run database:migration:test
```

真实样本通过后，应把报告作为候选发布证据保存，并单独记录：样本取得方式、原应用显示版本、复制前应用已完全退出、测试操作者和执行时间。不要把真实数据库本体提交到 Git 或发送给不需要接触数据的人员。

## 当前证据

- 合成 schema v6 完整链回归：通过；
- 迁移与运行时捕获 CLI 完整参数、显式 v1.3.2 来源声明：4项通过；
- WAL 源库稳定快照、单文件规范化与逻辑逐值一致：2项通过；
- 非 v6 样本拒绝且不写报告：通过；
- 默认生产备份回滚回归：通过；
- 原样本只读与逻辑数据逐值保持：由自动链覆盖；
- v1.3.2 正式 Portable 来源、版本和双重 SHA-256：通过；
- v1.3.2 正式 Setup 来源、版本、静默安装和安装载荷 SHA-256：通过；
- v1.3.2 官方发布件真实运行副本：Windows Sandbox 中已进入 `setup` 并生成 schema v6 数据库；来源、捕获、迁移、备份恢复、失败回滚、数据根清理和独立防篡改复核均通过。

# P0 首次启动数据库写入中断与恢复验收

日期：2026-08-10  
对应范围：P0-E08 首次启动阶段的候选绑定、可自动化恢复子门

## 结论

`npm.cmd run release:first-start-recovery` 已在明确确认的一次性 Windows 测试账户完成当前 v1.4.0 NSIS 实际安装主程序的受控中断与恢复探测。探针先核对令牌/ProfileList、LocalAppData、候选哈希、正式数据目录和运行进程，再把候选的字节完全一致副本置于 1% CPU 硬上限、关闭即终止整棵进程树的 Windows Job 中。

文件监视器已在正式数据目录观察到 `yuanyuan-reminder.sqlite3-wal` 变化；主库为 4,096 bytes、WAL 首次达到 32 bytes 时触发终止。Job 退出码为 1，终止后主库仍为 4,096 bytes，WAL 为 160,712 bytes、SHA-256 为 `E78E5D37DEC90D6021F2DC93A4976BE8811ED8DD3371D9F04616E5EFBB443FC4`，证明写库已经开始且不是启动前终止。

随后以同一未修改候选重新启动同一合成数据目录，观察到可见窗口，AI 子进程和 Application Error 均为 0。恢复后的数据库通过 `PRAGMA quick_check`，`user_version=11`，10 张正式业务表名称精确一致，默认设置 1 行、默认提醒 2 行。独立捕获器执行 WAL checkpoint 和 `VACUUM INTO`，保留 118,784 bytes、`journal_mode=delete`、无 WAL/SHM/journal 旁文件的规范化样本；独立校验器重新打开样本并重算全部哈希，而不是信任探针自报。

发布预检新增 `default_release_first_start_database_recovery=passed`。当前总结果为 13 项通过、13 项待完成、0 项失败，`readyForRelease=false`。

## 证据绑定

| 证据 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `release-first-start-recovery-probe.json` | 10,204 | `DB571D29F22648EA6196E4A0364A7242DFB7C3894DDFB17A4203046A716B6AEA` |
| `release-first-start-recovery-database.json` | 1,715 | `CD506F72A6AC2AD0F8818D2B24066019EACD0BE08A0412FAB41C969CF7C6022A` |
| `release-first-start-recovery.sqlite3` | 118,784 | `2F78DD5C8E81551194DEC0618D8D9004BA1727082B12143678125F807D0A8832` |
| `release-preflight.json` | 7,540 | `C733DF6567E0C47070A92F55440FF00BC1545A4D4001BB74BABA3D1E29C45434` |

绑定实现：

- 探针脚本 `scripts/probe_release_first_start_recovery.ps1`：`23C4E3B11A70F50D9FBC8935B2E92BBC5225F1484A278620E5A7AF743D66DB3E`；
- 数据库捕获器 `scripts/capture_first_start_recovery_database.mjs`：`B28F673690567C3C61CD98B942BD0C22D21EFD7C01473EF54C65CE8AEE6FA910`；
- 独立校验器 `scripts/verify_first_start_recovery_evidence.mjs`：`F9ABC381D88DE79A4641FE182763BC776FFF7F4CA8024FAE53316180CCDFF5C8`；
- 当前 NSIS 实际安装主程序：22,192,640 bytes，`143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D`；
- 当前发布清单：`07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC`。

探针报告不记录账户路径或用户文本。捕获器只接受固定 `synthetic_fresh_first_start` 来源声明，拒绝覆盖输出、异常 schema、表集合漂移、默认记录不足和损坏库；样本只含全新配置默认数据。

## 清理与边界

探针完成后，隔离账户的正式数据目录、临时候选目录、临时证据目录和圆圆进程均为 0；管理员账户的既有安装与数据未被访问或修改。

本证据没有、也不会声明完成以下事项：

- 真实物理掉电、系统重启、文件系统或存储设备故障；
- 来源可确认的 v1.3.2 真实业务数据库迁移、迁移中断、备份与回退；
- 真实用户数据恢复；
- 签名候选、SmartScreen、Defender/第三方安全软件、默认安装注册或人工发布签字。

因此它是完整 `upgrade_rollback_drill` 的独立工程子门，不能设置 `upgradeRollbackDrillVerified=true`。

## 复现命令

只允许在正式数据目录不存在、无圆圆进程且令牌/ProfileList/LocalAppData 一致的一次性测试账户执行探针：

```powershell
npm.cmd run release:first-start-recovery
npm.cmd run release:first-start-recovery:evidence:test
npm.cmd run release:first-start-recovery:verify
node scripts/generate_release_preflight.mjs
```

普通 `release:preflight` 只复核现有证据，不会自动启动这个会写入正式数据目录的探针。

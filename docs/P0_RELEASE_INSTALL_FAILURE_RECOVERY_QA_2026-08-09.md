# P0 候选安装失败与恢复隔离验收（2026-08-09）

## 结论

`npm.cmd run release:install-failure-recovery` 已对当前 v1.4.0 NSIS 完成三类候选绑定故障探测，并通过独立严格校验：确定性截断的损坏候选以退出码 2 拒绝；旧版主程序被独占占用时，当前候选以退出码 32 在写入前拒绝；第三类把未修改安装包放入带 1% CPU 硬上限和关闭即终止整棵子进程树的 Windows Job，仅在观察到主程序已写入非零且小于完整候选的字节数后终止 Job。

最终候选绑定运行在 8,257,536 bytes 时观察到主程序写入变化，Job 终止后磁盘上保留 11,993,088 bytes 的部分主程序，SHA-256 为 `8BD111417CCCB27CFE5660AEBF90A8415775789ABB8A9F135FBD0AC0854A0BF6`；旧 v1.3.2 卸载器保持精确不变，四份 v1.4.0 许可文件仍未写入，合成数据哨兵不变。随后使用未修改的当前候选可恢复为完整 v1.4.0 主程序、候选卸载器和四份精确许可文件并正常卸载；默认安装目录、临时目录、数据哨兵、快捷方式、注册和进程均清理完成。

发布预检的独立 `isolated_install_failure_recovery_probe` 现要求 schema v2 的写入中断、恢复和零残留字段；加入首次启动数据库恢复独立子门后，当前总结果为 13 项通过、13 项待完成、0 项失败，`readyForRelease=false`。本子门不会设置 `upgradeRollbackDrillVerified=true`，也不替代真实掉电/系统重启、真实历史数据库迁移、默认路径注册或签名候选人工矩阵。

## 发现并修复的问题

首轮探测暴露了真实的半升级缺陷：当 v1.3.2 主程序被独占锁定时，旧 NSIS 仍返回 0；主程序保持 v1.3.2，但卸载器被覆盖并写入了 v1.4.0 许可文件。探测按设计判失败，且当轮所有隔离状态均已清理。

`src-tauri/windows/installer-hooks.nsh` 现于任何文件复制、注册写入、快捷方式或卸载器生成之前，尝试以独占读写方式打开现有主程序。无法取得替换句柄时，安装器设置非零错误码 32 并立即中止。修复后的同一故障注入不再生成新许可文件，也不再覆盖旧卸载器。

中途写入场景不修改安装包：探针以 Win32 `CREATE_SUSPENDED` 创建原始候选，将其加入 `KILL_ON_JOB_CLOSE` Job 并设置 1% CPU 硬上限后恢复运行；只有检测到旧主程序已被非零的变化文件替换，才用 `TerminateJobObject` 终止 Job。严格门要求终止后主程序大小仍小于完整候选、哈希同时不等于旧版和候选、旧卸载器未变、许可目录为空、进程归零、数据哨兵保留，随后原始候选必须完整修复。

## 冻结输入与报告

| 角色 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 官方 v1.3.2 Setup | 12,071,368 | `FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1` |
| 官方 v1.3.2 安装主程序 | 20,574,720 | `864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF` |
| 官方 v1.3.2 卸载器 | — | `941D0915C5CFE0F2C7F131A4CCE1700B202C669AE0825C1F7CF9C3A6B88AFF89` |
| 当前 v1.4.0 NSIS | 12,500,456 | `C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96` |
| 当前 NSIS 实际安装主程序 | 22,192,640 | `143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D` |
| 确定性半长损坏候选 | 6,250,228 | `5FAAE8F6AA7CA1AAD5D32334949147D20848DD2408CBE47A715C215DCE0442BA` |
| Job 终止后的部分主程序 | 11,993,088 | `8BD111417CCCB27CFE5660AEBF90A8415775789ABB8A9F135FBD0AC0854A0BF6` |

- 探测报告：`src-tauri/target/release/release-install-failure-recovery-probe.json`，11,654 bytes，SHA-256 `7C0141D0522C6012F110DB70B96A556AABE61848D4DE2394A3E4E7488F3FFCBA`；
- 探测脚本：`scripts/probe_release_install_failure_recovery.ps1`，SHA-256 `D09C53145A9C45F03A2E50CBA365F6DE380B4EAB9A5329C544222B74342C5E3D`；
- 安装前置钩子：`src-tauri/windows/installer-hooks.nsh`，SHA-256 `D0A557DB1D4A76A25166A3E1BA3F4144C0EA757CEC1F1D2C8FCC17D1CAD384EC`；
- 发布预检报告：`src-tauri/target/release/release-preflight.json`，7,540 bytes，SHA-256 `C733DF6567E0C47070A92F55440FF00BC1545A4D4001BB74BABA3D1E29C45434`。

## 自动复核边界

预检会重算当前安装包前半段的字节数和 SHA-256，并要求报告精确绑定当前 NSIS、实际安装主程序、官方历史版、探测脚本和固定限制声明。schema v2 采用精确字段集；来源漂移、伪造成功、零退出码、旧卸载器变化、许可文件泄漏、数据哨兵变化、未终止进程树、中断后其实已完整安装、意外写入默认目录、恢复失败、残留进程或乐观附加字段都会被拒绝。当前发布预检逻辑共 16 项测试通过。

## 不覆盖的正式门

- 安装器写入期间的真实掉电或系统重启；当前证据只覆盖受控 Job 终止，不外推为断电等价物；
- 真实历史数据库迁移前后的中断与业务恢复；合成全新数据库首次启动的受控进程终止恢复已由独立子门覆盖；
- 来源可确认的 v1.3.2 真实业务数据库；
- 默认路径控制面板注册和除已单独验证的卸载数据复选框外的交互式用户选择；
- Authenticode、RFC 3161、SmartScreen、Defender 与两款第三方安全软件；
- 完整人工 `upgrade_rollback_drill` 签字。

## 复现命令

```powershell
npm.cmd run release:install-failure-recovery
npm.cmd run release:preflight:test
node scripts/generate_release_preflight.mjs
```

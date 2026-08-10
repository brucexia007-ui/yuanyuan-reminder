# P0 默认安装路径升级、卸载与安全回装旧版验收

日期：2026-08-09  
对应范围：P0-E08 默认 current-user 安装路径的可自动化文件转换证据

## 结论

在明确确认的干净 Windows 测试账户中，`npm.cmd run release:upgrade-rollback:default` 已使用真正的默认 current-user 安装目录完成：官方 v1.3.2 初装 → 当前 v1.4.0 原位安装 → 卸载 v1.4.0 → 回装官方 v1.3.2 → 卸载 v1.3.2。

三个安装阶段的主程序版本、字节数和 SHA-256 均精确匹配；v1.4.0 的四份许可证文件名称和内容正确，回装 v1.3.2 后这些新文件不残留；正式 LocalAppData 合成哨兵五阶段保持同一哈希。最终默认安装目录、正式数据目录、快捷方式、临时目录和圆圆进程均为零残留。

发布预检包含独立 `default_install_path_transition_probe`、`default_install_control_panel_registration`、安装失败恢复、首次启动数据库恢复与卸载数据选择子门；当前文件转换项通过、控制面板注册项待完成，总结果为 13 项通过、13 项待完成、0 项失败，`readyForRelease=false`。

## 注册表观察不冒充通过

当前受管测试账户禁止写入 HKCU。除安装器三个阶段均观测到 `registrationDisposition=absent` 外，额外使用随机、带运行号的非产品测试键验证时：

- 子进程写入没有产生父进程可见键；
- 父 PowerShell 直接创建 HKCU 键返回“访问被拒绝”；
- 测试键最终不存在；
- 圆圆产品注册、安装目录和进程同样均不存在。

因此报告明确记录 `registrationGatePassed=false`。本项只证明默认安装路径下的文件安装、升级、卸载和安全回装旧版，不证明控制面板注册；预检将文件转换列为通过，同时把独立 `default_install_control_panel_registration` 保持为待完成，也不会用它设置 `upgradeRollbackDrillVerified=true`。控制面板条目、显示版本、安装位置和卸载字符串仍须在允许 current-user 注册写入的干净 Windows 账户复核。

## 冻结候选与报告

| 角色 | SHA-256 |
|---|---|
| 官方 v1.3.2 Setup | `FD08FAC044D32995FA7BB153A06E5ED092FCCA827DCAA4154608F579541FF4F1` |
| 官方 v1.3.2 安装主程序 | `864209F2D6385205CA15E35677C64BA94388B315DB555EBA08369D57717F3FCF` |
| 当前 v1.4.0 NSIS | `C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96` |
| 当前 v1.4.0 NSIS 实际安装主程序 | `143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D` |

- 默认路径报告：`src-tauri/target/release/release-default-upgrade-rollback-probe.json`
- 报告 SHA-256：`7C986BDD270A670E810C535472C14D1A2A79FD4C2756F43515BA6B3F3FD07496`
- 探测脚本 SHA-256：`AB717DD75AFB406107D7AA4F18EBC9F7BE8A4414902E77C242B999792E3103C2`
- 最新发布预检报告 SHA-256：`C733DF6567E0C47070A92F55440FF00BC1545A4D4001BB74BABA3D1E29C45434`

报告与预检会重新绑定脚本、历史安装器、历史安装主程序、当前安装器和当前安装主程序哈希，并重新计算 `registrationGatePassed`；把 `absent` 注册伪装为 `owned`、改变安装边界确认、修改清理状态或加入未知字段都会失败。

## 安全前置与清理

默认模式必须同时显式传入 `-UseDefaultInstallRoot -AcknowledgeCleanTestAccount`。脚本在安装前拒绝以下任一状态：

- 令牌 ProfileList 与 `USERPROFILE`/LocalAppData 不一致；
- 已有圆圆默认安装目录、产品注册、桌面或开始菜单快捷方式；
- 已有圆圆进程、启动项或正式数据目录；
- 历史/当前安装器、实际安装主程序或许可证材料哈希漂移。

探测只在正式数据目录写入本轮所有权标记和合成哨兵，不启动应用、不创建或读取业务数据库。清理前再次核对所有权标记、安装根、注册根和快捷方式目标；任何不匹配都会停止而不删除未知对象。

## 仍待完成

- 允许 HKCU 注册写入的干净普通账户控制面板注册矩阵；
- 真实 v1.3.2 业务数据库迁移、备份、恢复和旧版兼容策略；
- 安装写入或数据库迁移期间的真实掉电/系统重启，以及真实历史数据库迁移中断；损坏候选、主程序替换受阻和合成全新数据库首次启动的受控进程终止恢复已由独立子门覆盖；
- 已签名候选、RFC3161、Defender、SmartScreen 和两款第三方安全软件；
- 完整人工 `upgrade_rollback_drill` 签字。

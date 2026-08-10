# NSIS 实际安装主程序发布边界验收

日期：2026-08-09  
对应范围：P0-E01 候选身份、P0-E08 签名/安全软件/回退输入

## 当前结论

当前未签名 v1.4.0 候选的 NSIS 实际安装主程序已经完成可重复提取和候选绑定，`nsis_installed_payload=passed`。发布清单不再把构建目录中的便携主程序等同于安装包内部主程序；Authenticode、同证书和 Defender 门现在同时要求便携主程序、NSIS 实际安装主程序与 NSIS 安装包三项发布产物。

该结果只关闭“实际随安装包落盘的 EXE 是否进入清单与自动门”这一工程缺口。三项产物均未签名，发布渠道、安全软件、SmartScreen、升级中断、真实 v1.3.2 数据库迁移和人工许可证复核仍未完成，因此 `readyForRelease=false`。

## 发现与修复

Tauri 构建目录中的主程序包含固定包类型标记 `__TAURI_BUNDLE_TYPE_VAR_UNK`；NSIS 内部实际安装的同版本主程序包含 `__TAURI_BUNDLE_TYPE_VAR_NSS`。当前未签名候选两者长度均为 22,192,640 bytes，只有标记末尾 3 bytes 不同，但 SHA-256 必然不同：

| 产物 | SHA-256 |
| --- | --- |
| 构建目录/便携主程序 | `1B88183CFC5C225E7617EB50EFD6CD0DA1FC90A047A9135233AACA7354D0DC7B` |
| NSIS 实际安装主程序 | `143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D` |
| NSIS 安装包 | `C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96` |

此前清单只记录第一项和安装包，导致安装包内真正执行的 PE 没有独立进入哈希、签名和 Defender 目标。现已完成：

- 新增 `release:nsis-payload`：在当前用户一次性临时目录静默安装当前 NSIS，提取实际主程序，核对版本、唯一 `NSS` 标记、四份许可材料及其内容哈希，再静默卸载；
- 执行器拒绝既有圆圆进程或产品注册，保存并复核既有快捷方式状态，只清理本次创建且目标精确指向 QA 安装目录的快捷方式；临时安装目录、卸载注册和测试进程必须全部清零；
- 发布清单固定增加 `nsis_installed_core / installer_payload`，共记录 5 项产物；正式发布产物集合固定为 `stable_core + nsis_installed_core + nsis_installer`；
- 默认主程序字节边界同时扫描便携和 NSIS 安装变体；AI 关闭报告同时绑定两种主程序和安装包；Defender 与同证书检查也覆盖三项；
- 新配置冷启动改为运行 NSIS 实际安装主程序，而不是构建目录中的 `UNK` 变体。

## 当前证据

安装、提取和卸载均返回 0；安装载荷产品版本为 1.4.0，四份许可材料名称与内容哈希精确匹配。测试结束后一次性安装目录、卸载注册、产品注册、快捷方式变化、正式数据目录、圆圆进程和临时 QA 根均为零残留。

报告位于忽略目录 `src-tauri/target/release/nsis-installed-payload.json`，SHA-256 为 `131ABBEEA6A54A1B89E3129CEF154007ED5765F76860855436418AAC679D4BAD`。发布清单 SHA-256 为 `07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC`。

NSIS 安装变体在独立 Windows 测试账户完成 3 次新配置可见窗口采样：230.1、136.4、130.2 ms，P50/P95 为 136.4/230.1 ms；AI 子进程、Application Error、数据根和进程残留均为 0。加入隔离/默认路径转换、安装失败恢复、首次启动数据库恢复、卸载数据选择及独立控制面板注册门后，最新发布预检为 13 项通过、13 项待完成、0 项失败。

## 回退探测限制

早期无数据库探测证明同目录 1.3.2→1.4.0→1.3.2 文件替换均返回 0；但直接以旧安装器覆盖新版本后，旧卸载器不知道 v1.4.0 新增的 `licenses` 文件，会留下该目录。因此“直接覆盖降级”不作为正式回退方案。现已把安全序列自动化为：先安装官方 v1.3.2、升级当前候选、用当前卸载器移除当前程序文件且保留合成数据哨兵，再安装旧版；版本、哈希、许可证清理和零残留均通过，见 [安装升级与安全回装旧版隔离探测](P0_RELEASE_UPGRADE_ROLLBACK_PROBE_2026-08-09.md)。合成全新数据库首次启动的受控终止恢复也已通过；真实历史数据库兼容/恢复、默认安装路径注册、真实掉电/重启与签名候选的完整矩阵仍未完成。

## 复现命令

```powershell
npm.cmd run release:nsis-payload
npm.cmd run release:manifest
npm.cmd run release:upgrade-rollback
# 仅在明确干净的发布测试账户执行：
npm.cmd run release:upgrade-rollback:default
npm.cmd run release:binary-boundary
npm.cmd run release:preflight:test
npm.cmd run release:preflight
```

`release:manifest` 已自动先执行安装载荷提取。该步骤会做一次当前用户静默安装/卸载，因此必须在没有既有圆圆安装注册和运行进程的发布测试账户执行。

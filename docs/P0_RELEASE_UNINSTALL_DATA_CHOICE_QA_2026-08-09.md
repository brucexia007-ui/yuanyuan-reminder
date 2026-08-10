# P0 候选卸载数据选择验收（2026-08-09）

## 结论

`npm.cmd run release:uninstall-data-choice` 已在干净、可交互的当前用户 Windows 会话中，对当前 v1.4.0 NSIS 完成两次候选绑定卸载：

- 默认/静默卸载返回 0，安装目录删除完成，LocalAppData 与 RoamingAppData 中的合成数据哨兵均保留；
- 交互卸载找到安装包真实的 `Delete the application data` 复选框，确认其初始未勾选，再以原生控件消息明确设为勾选并复核状态；卸载与完成按钮均被调用，流程未超时、相关进程归零，安装目录及两处合成数据根均删除。

发布预检新增独立 `uninstall_data_choice_probe`，并把控制面板注册作为另一独立待办；加入首次启动数据库恢复子门后，当前总结果为 13 项通过、13 项待完成、0 项失败，`readyForRelease=false`。该结果证明当前候选的默认保留与显式删除语义，不把真实用户数据、控制面板注册、每机器安装、签名候选或辅助功能人工复核冒充为通过。

## 安全边界

探针在启动前要求当前令牌 SID、ProfileList、`USERPROFILE`、LocalAppData 和 RoamingAppData 精确一致，并拒绝已有圆圆进程、产品注册、默认安装目录、快捷方式、启动项或正式数据根。两轮均使用带所有权标记的一次性自定义安装目录，只在当前账户的正式 LocalAppData/RoamingAppData 产品路径创建可验证的合成哨兵；未读取或复制真实用户数据。

交互轮不依赖屏幕坐标或模糊文本匹配。由于 NSIS 会把卸载窗口转交给临时进程，探针以启动时间、窗口所属进程、精确复选框名称和原生窗口句柄绑定真实控件；复选框必须先报告关闭、设置后再报告开启，随后才允许调用卸载按钮。

## 冻结输入与报告

| 角色 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 当前 v1.4.0 NSIS | 12,500,456 | `C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96` |
| 当前 NSIS 实际安装主程序 | 22,192,640 | `143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D` |
| 探测脚本 | 38,996 | `94306FA1FDC097A98A6477F15C21BF746EFB17C6D1CAD4E7EEF1F89DA9DE38FA` |
| 探测报告 | 5,358 | `9293C91BEF03517332B79AB978B651A0F7C1D6D88AE1F6978747B052C6E971F0` |
| 发布预检报告 | 7,540 | `C733DF6567E0C47070A92F55440FF00BC1545A4D4001BB74BABA3D1E29C45434` |

- 探测脚本：`scripts/probe_release_uninstall_data_choice.ps1`；
- 探测报告：`src-tauri/target/release/release-uninstall-data-choice-probe.json`；
- 发布预检报告：`src-tauri/target/release/release-preflight.json`。

报告同时记录候选安装器与实际安装主程序身份、环境归属、两轮结果、合成数据边界和最终清理状态。结束时产品注册、桌面/开始菜单快捷方式、LocalAppData/RoamingAppData 数据根、QA 临时根、应用进程与卸载器进程均为零残留。

## 自动复核边界

普通 `release:preflight` 不会自动驱动交互式卸载界面，而是重算当前候选、实际安装主程序与探测脚本哈希后，严格复核已有报告。schema 采用精确字段集；候选或脚本漂移、复选框初始开启、没有确认勾选、未调用卸载/完成按钮、默认轮误删数据、显式轮未删净数据、超时、残留进程、环境不干净、使用真实数据或附加未知字段都会被拒绝。

当前 `release:preflight:test` 共 16 项逻辑测试通过；本门含正向样本及显式删除不完整、脚本漂移、外部信任、RFC3161与完整升级回退伪通过等负向样本。

## 不覆盖的正式门

- 真实用户数据上的恢复演练，或来源可确认的 v1.3.2 业务数据库迁移；
- 默认路径控制面板注册和每机器安装；
- 卸载复选框的键盘、Narrator、高对比度、多 DPI 与文本缩放人工验收；
- Authenticode、RFC 3161、SmartScreen、Defender 与两款第三方安全软件；
- 安装写入或真实历史数据库迁移期间的真实掉电/系统重启；部分主程序写入后的受限Job终止与合成全新数据库首次启动恢复由独立恢复门覆盖；
- 完整人工 `upgrade_rollback_drill` 签字。

## 复现命令

```powershell
npm.cmd run release:uninstall-data-choice
npm.cmd run release:preflight:test
node scripts/generate_release_preflight.mjs
```

首条命令必须在明确干净、可交互且令牌/ProfileList/配置目录一致的 Windows 测试账户运行；已有产品状态时会在安装前拒绝，不会清理既有用户数据。

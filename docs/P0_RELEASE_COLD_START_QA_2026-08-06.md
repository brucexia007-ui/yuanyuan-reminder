# 默认正式主程序新配置冷启动验收

更新时间：2026-08-09  
对应任务：P0-003 启动时间基线

## 当前结论

从当前 NSIS 精确提取的实际安装主程序已在独立 Windows 测试账户完成3次候选绑定的新配置冷启动，`ready=true`。最新候选启动到真实可见窗口分别为230.1、136.4和130.2 ms，P50为136.4 ms，P95为230.1 ms；三轮AI子进程、Application Error和清理残留均为0。

报告为schema v2，绑定 NSIS 实际安装主程序、发布清单和采集脚本SHA-256。发布预检会重新计算来源、逐样本和分位值，并已把该项从待完成改为通过；加入隔离/默认路径转换、安装失败恢复、首次启动数据库恢复、卸载数据选择、独立控制面板注册及无障碍人工矩阵门后，当前预检为13项通过、14项待完成、0项失败。

此前在既有数据账户执行的拒绝路径仍有效：采样器在启动前以`preexisting_formal_data_root`拒绝，正式数据库及WAL/SHM核心快照不变，不能通过移动、替换或清空用户数据制造“干净”结果。

## 测试账户真实性

本次运行使用当前进程实际持有的独立测试账户令牌。宿主环境原本错误继承了另一账户的配置目录，子进程纠正到该令牌在Windows `ProfileList`注册的真实配置目录；采样器在创建数据前重新读取当前SID对应的Profile路径，并同时要求UserProfile、LocalApplicationData与注册路径完全一致。仅修改`LOCALAPPDATA`但令牌/ProfileList不匹配会以`test_account_profile_mismatch`关闭失败，不能伪造干净账户。

因此采样器必须同时满足：

- 操作者显式传入 `-AcknowledgeFreshTestAccount`；
- 当前为可交互 Windows 会话；
- 当前令牌SID可在`ProfileList`解析，且注册Profile与Known Folder完全一致；
- `%LOCALAPPDATA%\com.yuanyuan.reminder` 完全不存在；
- 没有任何现存 `yuanyuan-reminder` 进程；
- 当前主程序 SHA-256 与 `release-manifest.json` 完全一致。

任何前置条件不满足都会在启动前失败，不会移动或清理既有数据。

## 采样方式

工作区的 `target\release` 同时可能存在被 NSIS 排除的 Bridge/AI 原型。为避免主程序在开发目录误发现 AI 原型，采样器会：

1. 将 `release:nsis-payload` 从当前安装包提取并纳入清单的实际安装主程序，复制到带随机所有权标记的独立临时发布目录；
2. 复核复制前后 SHA-256 完全一致；
3. 从只有主程序自身的目录启动，模拟默认安装边界；
4. 以 Windows 可见顶层窗口作为启动完成点；
5. 每个样本都要求应用数据目录从不存在开始；
6. 记录进程树规模、AI 子进程、Application Error 和数据目录清理结果；
7. 使用普通账户可用的Toolhelp原生进程快照确定父子树；观察窗口后强制终止本轮精确进程树，再对WebView锁释放做最长10秒有界等待，最后删除本轮创建且所有权标记一致的正式数据目录；
8. 任一目录身份、重解析点、所有权标记或进程清理不符合预期时停止，不继续采样。

## 执行方法

仅在一次性或专用干净 Windows 测试账户中运行：

```powershell
npm.cmd run release:manifest
npm.cmd run runtime:release-cold-start -- -SampleCount 3 -WindowTimeoutSeconds 30 -AcknowledgeFreshTestAccount
npm.cmd run release:preflight
```

通过报告写入 `src-tauri/target/release/release-cold-start.json`。

发布预检只接受至少3个样本，且每个样本都必须可见窗口成功、AI子进程为0、Application Error为0、进程树已停止、测试数据目录已删除，并与当前清单、主程序、采集脚本哈希及令牌Profile绑定一致。发布清单现在只在产物材料变化时更新`generatedAt`；相同产物重复生成保持相同清单哈希，防止预检自身让外部报告无条件过期。产物或脚本发生变化后，旧报告仍会按设计失效。

## 当前证据

| 项目 | 值 |
| --- | --- |
| NSIS 实际安装主程序 SHA-256 | `143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D` |
| 发布清单 SHA-256 | `07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC` |
| 采集脚本 SHA-256 | `3AB6F651F3CD8D0D9A22014E68D07A02C972441F0E3D5D922C790203DC83B676` |
| 冷启动报告 SHA-256 | `288B42C4F285295B25884A053F28B1A6E419EEC1741389180D86C55ABB94D9C1` |
| 样本 | 3/3可见窗口，AI子进程0，Application Error 0，数据根3/3删除 |
| P50 / P95 | 136.4 / 230.1 ms |
| 运行后残留 | 测试数据根0、临时发布根0、圆圆进程0 |

## 解释边界

- 这是“NSIS 实际安装可执行文件 + 新应用数据配置”的启动时间，不是 NSIS 安装耗时；
- 每轮应用数据都是新的，但第二轮以后可能受操作系统、磁盘和 WebView2 文件缓存影响；
- 为保证自动清理，观察窗口后使用强制终止；优雅退出由其他常驻/退出验收覆盖；
- 当前未冻结跨设备启动性能阈值，这组结果只作为本机新配置基线；
- 干净账户正向结果仍不能替代干净机安装、SmartScreen、DPI、睡眠恢复和24小时常驻测试。

# P0 AI全部关闭组合回归（2026-08-06）

## 结论

P0-005针对当前v1.4.0默认发行方式的自动回归门已建立并通过。默认安装包不携带Bridge或AI辅助进程；在AI二进制不存在时，提醒、专注、完成和今日列表继续离线工作；生产前端和稳定核心没有对外网络传输入口。

这项结论只适用于“当前默认安装包中AI全部关闭”的回归边界，不代表未来云Provider、正式Bridge/AI安装、真实Hook或智能陪伴功能已经通过。

## 组合门

命令：

```powershell
npm.cmd run ai-off:verify
npm.cmd run ai-off:release
```

`npm.cmd run verify`现已强制执行`ai-off:verify`；`release:preflight`和`release:gate`强制执行绑定正式产物的`ai-off:release`。任一层失败都会在发布预检报告生成前停止。

### 1. 源码与网络边界

- 冻结Tauri生产CSP的`connect-src`为`ipc:`和`http://ipc.localhost`，拒绝HTTP(S)、WebSocket等外部目标；
- 扫描28个前端TypeScript文件，唯一允许的`fetch`是同包内`/assets/pet/pet-manifest.json`；开发专用数据去向原型同样没有网络入口；
- 拒绝生产前端的`WebSocket`、`EventSource`、`XMLHttpRequest`和`sendBeacon`；
- 扫描31个稳定核心Rust文件，拒绝直接TCP/UDP、HTTP客户端和WebSocket代码；
- 拒绝前端或稳定核心直接引入常见云模型/网络SDK；
- Tauri的`externalBin`和`resources`不得声明Bridge、AI或运行验收夹具。

### 2. 无AI运行回归

Rust测试`ai_unavailable_keeps_full_offline_reminder_core_usable`使用真实Repository证明：

- AI监督器状态为`unavailable`，没有二进制、工作线程或手动重启能力；
- 过去时间的单次工作事项仍通过生产`claim_due`成为可通知occurrence；
- 专注计时仍可开始；
- AI监督器停止后，事项完成和今日列表仍可继续使用。

前端定向回归同时证明：

- 无AI二进制且无诊断残留时，实验组件卡完全不出现；
- 浏览器/非Tauri降级固定返回`unavailable`；
- 只有存在本地诊断残留时才保留用户主动清理入口，不伪装AI已安装。

### 3. 正式产物绑定

发行验证器重新核对`release-manifest.json`中的五个固定角色和全部SHA-256，并要求：

- 构建目录/便携主程序为`primary_application`；
- 从当前NSIS一次性安装中提取的实际主程序为`installer_payload`；
- NSIS为`distribution_installer`；
- Bridge和AI均为`prototype_excluded`；
- `bundle`目录只有当前NSIS安装包一个文件；
- AI关闭报告绑定当前清单、两种主程序和安装包哈希。

当前证据：

- 报告：`src-tauri/target/release/ai-disabled-regression.json`
- 报告SHA-256：`6A1166A23568574BECEE4164A71E36D7EF2A96D4336BCE15FCC4A6BD19DA3DE5`
- 绑定清单SHA-256：`07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC`
- 构建目录/便携主程序SHA-256：`1B88183CFC5C225E7617EB50EFD6CD0DA1FC90A047A9135233AACA7354D0DC7B`
- NSIS实际安装主程序SHA-256：`143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D`
- NSIS SHA-256：`C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96`
- `ready=true`

发布预检将`ai_disabled_regression`列为独立自动检查；加入候选绑定的隔离/默认路径转换、安装失败恢复、首次启动数据库恢复、卸载数据选择、独立控制面板注册和无障碍人工矩阵门后，当前候选为13项通过、14项待完成、0失败。签名、渠道、安全软件、控制面板注册、无障碍人工矩阵、真实历史数据库迁移和完整掉电/回退人工证据仍未完成，整体`readyForRelease=false`。

## 门禁测试

验证器自身4项测试覆盖：

- 生产CSP出现外部连接目标时拒绝；
- 安装声明出现任一辅助进程或验收夹具时拒绝；
- 前端出现远程`fetch`或实时传输API时拒绝；
- 稳定核心出现Socket、HTTP客户端或WebSocket代码时拒绝。

发布预检另有候选绑定测试，证明报告清单哈希、任一主程序哈希、安装包哈希或`ready`状态任一变化都会拒绝该证据。

## 尚不证明

- 不证明未来启用AI时的Provider隐私、成本、网络或内容安全；
- 不证明辅助进程签名、安装、升级、卸载和回退；
- 不替代24小时、睡眠唤醒、真实数据库、干净机器和安全软件验证；
- 已验证一次性自定义目录中的实际NSIS安装载荷，但不替代默认路径干净机、SmartScreen和签名候选复核。

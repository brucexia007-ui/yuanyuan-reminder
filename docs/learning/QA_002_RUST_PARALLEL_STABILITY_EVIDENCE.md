# QA-002：Rust 并行稳定性与原生签名验证缓解证据

> 状态：复现条件已隔离，锁与有界 PE 头预检后的正式 30 轮证据通过；精确 Windows 原生故障指令/模块仍未知<br>
> 证据日期：2026-08-24<br>
> 范围：阶段 0 / QA-001；不构成 GEN-000 冻结、PACK-001 开发或公开发布批准

## 1. 结论

默认主程序库在修复后先以 24 个 Rust 测试线程完成 100/100 轮压力；默认与 Learning Preview 主程序库随后完成正式连续扫描：默认 20/20、Learning 10/10，所有进程正常退出，未再出现 `0xC0000005`。报告绑定测试可执行文件、相关源码、Cargo 锁文件、测量脚本、独立校验器和设备摘要；独立校验器重新计算每轮结果、测试计数、P50/P95、哈希与门状态。

这证明“完整 Authenticode provider-state 生命周期进程级串行化 + 非 PE 输入不进入 `WinVerifyTrust`”在当前源码与设备上具有可重复性，但不证明 Windows 原生 API 永不失败。此前崩溃没有留下 crash dump 或 Application/WER 故障模块，因此“精确故障指令、模块与调用栈”仍是保留事实，不能写成已根因闭环。

## 2. 再现与诊断

最初的 24 线程复现表明，真实签名适配器和合成发现测试可能重叠执行 `WinVerifyTrust(VERIFY) → WTHelper* → WinVerifyTrust(CLOSE)` provider-state 生命周期，因此先增加了完整生命周期的进程锁。该版本一度通过正式门，但在加入 REL-002 事务测试并刷新证据时，正式门第 13 轮又以 `-1073741819`（`0xC0000005`）退出且未产生 Rust harness 摘要。手工完整库压力还在第 3、4、45 轮复现，说明“只靠进程锁”不是充分缓解。

测量脚本因此补充缺摘要诊断：失败会保留退出码、摘要数、stdout/stderr 字节数和各自 SHA-256；本次复现为 `0xC0000005`、零 harness 摘要、空 stderr。Windows Application/WER 没有新增事件，系统也未安装可用的 CDB/WinDbg/ProcDump，故没有转储可供原生栈定位。

隔离矩阵如下：

- 真实已安装 Codex 签名验证：100/100 通过；
- 合成无效 `.exe` 并发发现：100/100 通过；connector 子集：60/60 通过；
- 完整默认库：在第 3、4、13、45 轮等不同位置间歇崩溃；
- 同时去掉两条真实 Codex 签名测试和合成无效 `.exe` 发现路径：100/100 通过；
- 只去掉合成无效 `.exe` 发现路径、保留真实签名测试：100/100 通过；
- 只去掉两条真实签名测试、保留合成无效 `.exe` 发现路径：第 4 轮崩溃。

这些结果把当前完整负载下的复现必要条件收窄到“合成非 PE `.exe` 进入 `WinVerifyTrust`”；单独压力通过说明它不是一个简单的单测试必现错误。因为没有原生转储，这仍不能提升为“已证明某个 Windows 模块或指令故障”。

诊断还分离出一个无关的约 30 秒拖尾：`real_unhealthy_child_is_terminated_and_fused` 原先通过 `cmd.exe` 再启动 `ping.exe`，测试终止外层进程后，内层进程继续存活。夹具已改为直接运行单个 PowerShell `Start-Sleep` 进程；完整测试现在能在测试结果产生后立即退出，不再留下该子进程。

## 3. 缓解实现

- `windows_artifact_trust.rs` 在调用原生信任 API 前使用位置读取检查最小 DOS 头、`MZ`、有界 `e_lfanew` 与 `PE\0\0`；短文件、越界偏移、错误签名和普通文本均直接返回 `AuthenticodeEvidence::Invalid`，不进入 `WinVerifyTrust`；
- 预检 I/O 失败返回 `AuthenticodeEvidence::Unavailable`，继续按不可信处理；读取是有界的，不把整个候选文件载入内存；
- 进程级 `Mutex` 继续串行化完整 Authenticode provider-state 生命周期；
- 锁中毒时返回 `AuthenticodeEvidence::Unavailable`，继续按不可信处理，不放宽发布信任；
- 新增正反向 PE 头预检单测，并验证普通文本 `.exe` 在 `verify_authenticode` 层直接为 `Invalid`；
- 新增 16 线程互斥测试，证明同一时刻最多一个生命周期进入受保护区域；
- 真实 Codex 并发适配器与并发发现定向测试均通过，修复后完整默认库 100/100 通过。

## 4. 正式证据

报告：`src-tauri/target/rust-parallel-stability/evidence/rust-parallel-stability-20260824T171001Z.json`

| 配置 | 轮次 | 每轮结果 | P95 进程墙钟 | 门 |
| --- | ---: | --- | ---: | --- |
| 默认特性 | 20 | 215 通过 / 1 忽略 | 1843.885 ms | 20/20 通过 |
| `learning` | 10 | 279 通过 / 1 忽略 | 4647.590 ms | 10/10 通过 |

正式合同：24 个测试线程；默认至少 20 轮；Learning 至少 10 轮；每轮退出码为 0、Rust harness 为 `ok`、失败数为 0、测试计数一致；两组 P95 均不超过 10,000 ms。

验证命令：

```powershell
npm.cmd run runtime:rust-parallel:evidence:test
npm.cmd run runtime:rust-parallel:evidence:verify
```

独立校验器的 7 个负向/正向单元测试覆盖：短门伪造、崩溃退出码、伪造 harness 行、非空 stderr、陈旧源码/二进制绑定、错误汇总、乐观 readiness、未知字段与 BOM 解析。

## 5. 保留限制

- 没有 crash dump、WER 故障模块或原生调用栈，精确 Windows 故障指令/模块仍未知；
- 30 轮只证明本设备、当前源码和当前测试二进制上的重复性；
- 若 `0xC0000005` 再现，必须保留进程转储并记录故障模块，不能只以重跑通过覆盖；
- 本证据不替代真实桌面优先级时序、物理 DPI/多屏/Narrator/键盘验证、UX 研究、存储适配性和六方具名签署。

因此该项从“只靠进程锁的一度通过”更新为“复现必要条件已隔离，锁与有界 PE 头预检后的当前缓解已通过 100 轮压力及正式稳定性门，精确原生指令/模块仍待再现时捕获”。阶段 0 和公开发布仍保持 No-Go。

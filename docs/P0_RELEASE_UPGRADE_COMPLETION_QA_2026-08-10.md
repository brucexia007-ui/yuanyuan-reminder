# P0 完整升级、中断与回退证据门

日期：2026-08-10  
状态：候选绑定完成包、具名人工签字模板和关闭失败校验器完成；真实数据库、签名候选、物理中断与重启待完成

## 结论

发布预检不再接受 `upgradeRollbackDrillVerified` 裸布尔值。完整升级回退门现在把六个自动子门、默认路径控制面板注册、真实v1.3.2数据库迁移、签名/RFC3161候选、物理掉电或虚拟机硬重置、真实Windows重启、安全恢复旧库和具名人工签字绑定到同一候选。

当前包明确 `materialsComplete=false`，只缺：

- `authenticV132MigrationReport`：真实v1.3.2关闭态数据库副本产生的规范化迁移报告；
- `signingProtocolAttestation`：最终签名候选的RFC3161实际签字。

现有合成哨兵、合成空库、受控进程终止和未签名候选没有被扩大解释为真实数据库、物理掉电、系统重启或完整发布演练。加入独立无障碍人工矩阵门后，最新预检为13项通过、14项待完成、0项失败，`readyForRelease=false`。

## 冻结证据

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `src-tauri/target/release/release-upgrade-completion-packet.json` | 5,064 | `501C93980CCBEDE02864E48B5C03A1722D05E8DEAE064CF52A4A54C31378315B` |
| `src-tauri/target/release/release-manifest.json` | 1,792 | `07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC` |
| `src-tauri/target/release/release-preflight.json` | 7,540 | `C733DF6567E0C47070A92F55440FF00BC1545A4D4001BB74BABA3D1E29C45434` |

完成包同时冻结：

- 三项当前正式候选的字节数与SHA-256；
- 官方v1.3.2 Setup与实际安装主程序的冻结SHA-256；
- 隔离转换、默认路径转换、安装失败恢复、首次启动恢复、规范化首次启动数据库、卸载数据选择七份既有证据；
- 当前签名协议包；
- 真实v1.3.2迁移报告与签名协议实际签字的存在/缺失状态。

任何材料出现、消失或字节变化都会改变完成包哈希并使旧签字失效。

## 必须同时通过的工程子门

- 隔离安装、升级、卸载当前版并安全回装官方v1.3.2；
- 默认current-user安装路径文件转换；
- 可写HKCU账户中的逐阶段控制面板注册、版本、安装位置和卸载命令；
- 损坏安装包、文件替换受阻和部分主程序写入后的进程树终止与恢复；
- 首次启动非空SQLite WAL后的受控终止、同候选恢复和规范化数据库复验；
- 默认卸载保留Local/Roaming数据，明确勾选后才删除；
- 三项最终候选有效签名、同证书、发布者精确匹配、时间戳和RFC3161协议签字。

## 真实数据库要求

规范路径为 `src-tauri/target/release/release-authentic-v132-database-migration.json`。报告必须由现有迁移QA工具对1—512 MiB关闭态普通文件生成，并满足：

- 提供者具名确认应用显示版本为1.3.2、复制前应用完全退出；
- 源文件schema恰好为6，迁移后为11；
- 源文件前后只读哈希不变，`quick_check`通过；
- 全部原有表、列和值的规范化逻辑摘要在迁移后精确一致；
- 生产备份恢复、强制迁移失败后的安全快照回滚和恢复后核心读取全部通过；
- 报告仅包含文件身份、版本、聚合计数和固定结论，不包含源路径或用户内容；
- 真实数据库本体不提交Git，签字只记录SHA-256、字节数和来源确认。

## 真实中断与回退要求

物理中断只接受真实断电或虚拟机硬重置，`gracefulShutdownRequested`必须为`false`；必须先观察到安装文件、迁移写入或首次启动WAL写边界，再证明未修改候选恢复到可见窗口、`quick_check=ok`且数据保持。

系统重启必须是实际Windows重启，不能用杀进程替代；重启后同样需要可见窗口、数据库完整和数据保持证据。

回装v1.3.2前必须建立并恢复升级前数据库副本。历史版本不得打开已迁移的schema v11数据库；只有恢复schema v6副本后才允许启动旧版，并要求恢复后的逻辑摘要与真实源库一致。

## 验证结果

```powershell
npm.cmd run release:upgrade-completion:test
npm.cmd run release:upgrade-completion:packet:check
npm.cmd run release:preflight:test
```

- 完整升级合同3/3测试通过；
- 正向样本要求自动子门、签名、真实迁移、物理中断、系统重启和安全回退全部成立；
- 负向样本覆盖AI测试人/提供者、优雅退出冒充掉电、缺少真实重启、旧版打开v11库、签名/时间戳缺失、控制面板门未过、迁移检查失败和裸布尔伪通过；
- 发布预检逻辑17/17通过；
- 实际 `docs/release/RELEASE_UPGRADE_COMPLETION_ATTESTATION_V1.json` 不存在，`release:upgrade-completion:verify` 按设计退出2；
- `RELEASE_EVIDENCE_STATUS_V1.json` 仍为 `upgradeRollbackDrillVerified=false`，没有伪写完成状态。

## 最终执行顺序

1. 取得一份明确来自正常运行v1.3.2、应用完全退出后复制的数据库副本；
2. 生成规范路径下的真实迁移报告，不提交或外发数据库本体；
3. 冻结渠道、发布者和时间戳URL，完成最终签名与RFC3161实际签字；
4. 在可写HKCU的干净Windows环境刷新默认路径与控制面板注册证据；
5. 对最终签名候选执行真实物理中断/硬重置、真实Windows重启和安全回退；
6. 从 `docs/release/RELEASE_UPGRADE_COMPLETION_ATTESTATION_V1.template.json` 创建实际具名签字；
7. 重新生成完成包，运行独立验证、普通预检和严格发布门；
8. 候选、历史材料、数据库报告、签名、环境或任一证据变化后重做相应矩阵。

## 边界

当前工作只建立完整门的确定性合同和关闭失败复验，不读取现有用户数据库、不执行物理断电、不重启用户系统，也不声称真实升级已通过。真实数据库需要用户提供安全副本，24小时/睡眠与锁屏验收仍须另行明确同意；这些条件完成前当前候选继续为 `NO-GO`。

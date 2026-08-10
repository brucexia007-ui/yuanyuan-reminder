# P0 SmartScreen 与第三方安全软件外部信任门

日期：2026-08-10  
状态：测试合同与关闭失败校验器完成；真实外部测试和具名人工签字待完成

## 结论

当前候选的 SmartScreen 与第三方安全软件门仍为 `pending`，没有被工程自动化冒充为通过。新增的确定性测试包绑定当前发布清单、发布策略和三项正式产物；实际签字校验器要求真实干净 Windows 环境、具名人工测试人、完整生命周期结果和证据引用。仅修改 `smartScreenCleanMachineObserved` 或 `thirdPartySecurityProductsVerified` 不会通过预检，反而会在缺少匹配签字时关闭失败。

最新预检为 13 项通过、13 项待完成、0 项失败，`readyForRelease=false`。

## 冻结证据

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `src-tauri/target/release/release-external-trust-test-packet.json` | 2,459 | `E8279E9715D00E04DAEC2F5E1F6FF8524A6E501FA2EBAC5119EC786BC251F195` |
| `src-tauri/target/release/release-manifest.json` | 1,792 | `07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC` |
| `src-tauri/target/release/release-preflight.json` | 7,540 | `C733DF6567E0C47070A92F55440FF00BC1545A4D4001BB74BABA3D1E29C45434` |

测试包冻结的正式候选为：

- 便携主程序：22,192,640 bytes，SHA-256 `1B88183CFC5C225E7617EB50EFD6CD0DA1FC90A047A9135233AACA7354D0DC7B`；
- NSIS 实际安装主程序：22,192,640 bytes，SHA-256 `143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D`；
- NSIS 安装包：12,500,456 bytes，SHA-256 `C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96`。

## SmartScreen 合同

签字必须同时证明：

- 测试机没有历史圆圆安装，也没有执行过当前候选；
- 安装包通过真实 Internet Zone 传输取得 Mark-of-the-Web，而非本地复制；
- 测试时网络信誉服务可用；
- 记录 Internet Zone 传输、安装包启动、安装、首次启动、常驻和卸载六阶段；
- `promptDisposition=no_warning`，且没有遗漏或未解决结果；
- 测试人姓名、角色、组织和 `humanTester=true` 完整，环境含 Windows 版本、构建号、账户类型和干净快照哈希；
- 每项观察至少两条证据引用，且必须引用发布签名与误报 SOP。

## 第三方安全软件合同

至少两款互不重复的目标安全产品必须同时满足：

- Microsoft Defender 不计入第三方产品数量；
- 实时防护启用，产品版本和病毒库版本明确；
- 覆盖安装前扫描、安装包启动、安装、首次启动、常驻、卸载和卸载后扫描七阶段；
- 三项正式候选身份与测试包完全一致；
- 检测数为 0，没有恶意软件、PUA、隔离、删除、阻断或未解决发现；
- 每款产品分别记录具名人工测试人、环境快照、起止时间和至少两条证据引用。

校验器明确拒绝 Codex、ChatGPT、AI、Bot 或自动化流程作为测试人，拒绝 Defender 冒充第三方产品、同一产品重复计数、检测结果非零、候选/策略/测试包漂移和乐观计数。

## 验证结果

```powershell
npm.cmd run release:external-trust:test
npm.cmd run release:external-trust:packet:check
npm.cmd run release:preflight:test
```

- 外部信任合同 3/3 测试通过，覆盖正向签字与缺少 MoTW、出现警告、AI 测试人、包漂移、Defender、重复产品、检测和乐观计数拒绝；
- 测试包确定性检查通过；
- 发布预检逻辑 17/17 通过；
- 实际 `docs/release/RELEASE_EXTERNAL_TRUST_ATTESTATION_V1.json` 不存在，`release:external-trust:verify` 按设计拒绝通过；
- `RELEASE_EVIDENCE_STATUS_V1.json` 仍为 `smartScreenCleanMachineObserved=false`、`thirdPartySecurityProductsVerified=0`，没有伪写完成状态。

## 实际执行顺序

1. 冻结发布渠道、精确发布者和最终签名候选；
2. 重新生成并复核测试包，确认包 SHA-256 与当前清单一致；
3. 从 `docs/release/RELEASE_EXTERNAL_TRUST_ATTESTATION_V1.template.json` 创建实际签字文件；
4. 在真实干净机完成 SmartScreen 流程，并在两款或以上非 Defender 产品中完成完整零检测矩阵；
5. 将实际证据文件引用和当前安装包 SHA-256 写入候选证据状态；
6. 运行 `npm.cmd run release:external-trust:verify`、普通预检和严格发布门；
7. 候选、策略、产品版本、病毒库或环境发生变化时重新测试，不沿用旧签字。

## 边界

测试包、模板、回归测试和预检集成只证明发布流程能够拒绝不完整或伪造的声明，不证明 SmartScreen 当前不会警告，也不证明任何第三方安全产品已经放行。Defender 在当前机器上由火绒接管且不可用；本次没有启停或修改任何用户安全服务。真实外部矩阵完成前，当前候选保持 `NO-GO`。

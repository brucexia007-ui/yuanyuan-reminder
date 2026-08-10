# P0 签名与 RFC 3161 协议证据门

日期：2026-08-10  
状态：候选绑定协议包、具名人工签字模板和关闭失败校验器完成；真实渠道、身份、签名与时间戳待完成

## 结论

发布预检不再接受 `rfc3161ProtocolVerified` 裸布尔值。RFC 3161 门现在同时要求：Windows 对三项正式产物给出 `Valid` Authenticode 状态；三项产物使用同一发布者与同一证书；每项都有可解析时间戳证书；发布渠道、精确发布者 Subject 和 HTTPS 时间戳 URL 已冻结；具名人工操作人提交候选绑定的签名工具、执行证据和 `/fd SHA256`、`/tr`、`/td SHA256` 结构化签字。

当前候选仍未签名，并只允许作为附 SHA-256 的测试版。正式低成本目标是 Microsoft Store MSIX，但新候选尚未建立，因此 `rfc3161_protocol_verified=pending`，`readyForRelease=false`。只把证据布尔值改为 `true` 会使该门变为 `failed`，不会冒充通过。

## 冻结证据

| 文件 | 字节数 | SHA-256 |
|---|---:|---|
| `src-tauri/target/release/release-signing-protocol-packet.json` | 2,833 | `2A6E1F71A8A6FED998661F25F27114B6350E26210A7F6FC98B1A028B7B9E11C6` |
| `src-tauri/target/release/release-manifest.json` | 1,792 | `07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC` |
| `src-tauri/target/release/release-preflight.json` | 7,540 | `C733DF6567E0C47070A92F55440FF00BC1545A4D4001BB74BABA3D1E29C45434` |

当前包冻结三项正式候选：

- 便携主程序：22,192,640 bytes，SHA-256 `1B88183CFC5C225E7617EB50EFD6CD0DA1FC90A047A9135233AACA7354D0DC7B`；
- NSIS 实际安装主程序：22,192,640 bytes，SHA-256 `143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D`；
- NSIS 安装包：12,500,456 bytes，SHA-256 `C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96`。

包内 `decisionsFrozen=false`，如实反映 `selectedChannel=pending`、`publisherSubject=null`、`timestampUrl=null`。发布策略另记录当前测试版为 `unsigned_beta_with_sha256`、计划稳定渠道为 `microsoft_store`。该包是当前未签名候选的执行合同，不是最终签名证据；未来 MSIX 必须重新生成自己的清单和协议包。

## 自动事实与人工证据必须同时成立

Windows签名采集器逐产物记录：

- Authenticode 状态；
- 签名者 Subject、证书指纹和有效期；
- 时间戳证书 Subject 与有效期；
- 是否存在时间戳证书。

具名人工签字另记录：

- 操作人姓名、角色、组织及 `humanOperator=true`；
- 签名工具名称、版本和可执行文件 SHA-256；
- 文件摘要 `sha256` 与 `/fd SHA256`；
- 时间戳协议 `rfc3161`、冻结的 HTTPS URL 与 `/tr`；
- 时间戳摘要 `sha256` 与 `/td SHA256`；
- 未使用旧式 `/t` 时间戳参数；
- 三项最终产物的字节数、SHA-256、签名者、证书指纹、时间戳证书和每项执行证据 SHA-256；
- 每项至少两条去重、排序后的证据引用，且必须引用签名与误报 SOP；
- 零未解决发现。

校验器拒绝 Codex、ChatGPT、AI、Bot 或自动化流程作为操作人，拒绝 SHA-1、旧式时间戳、非 HTTPS 时间戳 URL、证书/发布者漂移、任一产物缺少有效签名或时间戳、执行证据缺失、候选包漂移和签字中出现密码、访问令牌、客户端密钥或私钥材料。

## 验证结果

```powershell
npm.cmd run release:signing-protocol:test
npm.cmd run release:signing-protocol:packet:check
npm.cmd run release:preflight:test
```

- 签名协议合同 3/3 测试通过；
- 正向样本要求三项产物、签名事实、协议参数和候选证据完全一致；
- 负向样本覆盖 AI 操作人、SHA-1、旧式时间戳、凭据暴露、证书漂移、时间戳缺失、执行证据缺失和包漂移；
- 发布预检逻辑 17/17 通过；
- 实际 `docs/release/RELEASE_SIGNING_PROTOCOL_ATTESTATION_V1.json` 不存在，`release:signing-protocol:verify` 按设计退出 2；
- `RELEASE_EVIDENCE_STATUS_V1.json` 仍为 `rfc3161ProtocolVerified=false`，没有伪写完成状态。

## 最终执行顺序

1. 由用户冻结发布主体、目标渠道、精确证书 Subject、密钥托管人与 HTTPS RFC 3161 时间戳 URL；
2. 按受控构建顺序签名最终便携主程序和将进入 NSIS 的实际主程序，再生成并签名最终安装包；
3. 重新生成发布清单和签名协议包，确认三项最终字节、策略和采集脚本全部绑定；
4. 从 `docs/release/RELEASE_SIGNING_PROTOCOL_ATTESTATION_V1.template.json` 创建实际签字，不写入任何凭据；
5. 运行Windows签名采集、`release:signing-protocol:verify`、普通预检和严格发布门；
6. 任一产物、证书、发布者、工具、时间戳 URL、策略或签字变化后重新签名和复核。

## 边界

协议包、模板和回归测试只关闭“裸布尔值可以冒充RFC3161证据”的工程缺口，不提供证书、不替用户选择渠道，也不证明当前产物已签名。实际签名完成前，`release_artifacts_signed`、`one_certificate_per_release`、`publisher_identity_matches`、`trusted_timestamp_present` 与 `rfc3161_protocol_verified` 均保持关闭，当前候选继续为 `NO-GO`。

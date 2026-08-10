# P0 第三方许可归档与安装边界复核（2026-08-09）

## 结论

当前 Windows x64 正式候选已经具备可重复生成、依赖漂移关闭失败并随安装包交付的许可材料链。工程门通过，并已生成候选绑定的结构化人工复核包；但发布负责人的人工/法律复核仍未签字，实际签字文件不存在，`RELEASE_EVIDENCE_STATUS_V1.json` 中的 `licenseReviewVerified` 必须继续保持 `false`。今后单独把该布尔值改成 `true` 不能通过预检。

本记录不替代律师意见，也不授权商业使用圆圆素材。发布渠道、发布主体、素材权利和目标地区义务确定后，才可由有权负责人关闭人工许可证门。

## 候选绑定

- 构建目录/便携主程序 SHA-256：`1B88183CFC5C225E7617EB50EFD6CD0DA1FC90A047A9135233AACA7354D0DC7B`；
- NSIS 实际安装主程序 SHA-256：`143B59A18FCE473858B00725DA6ADE427FA16E91CECDC402DC00CF300416121D`；
- NSIS 安装包 SHA-256：`C96D883452FC02B296AF13E92633C2282E261C5B3211BC949987DE39A3A66F96`；
- 发布清单 SHA-256：`07B77F05FCC68AE4BDD34C4EBD26330D65E2D4C6E6F283BD533FF6796BFA9DCC`；
- `THIRD_PARTY_LICENSES.txt` SHA-256：`DE35B094BA90A31DB63E32E40CB451027708C6DA9546DCA0BD4E2FF0A8ADEAD9`，2,686,481 bytes。
- `release-license-review-packet.json` SHA-256：`C25E553E76012FE5608916A2D40278AF957D9B55ACB5E57DEADDF941AAD9F32A`，8,938 bytes。

最新候选发布预检为 13 项通过、13 项待办、0 项失败；`license_materials_bundled` 既由生成后的 NSIS 脚本证明，也由一次性真实安装中四份文件的精确名称和内容哈希复核证明，隔离/默认路径转换、安装失败恢复及卸载数据选择又验证回装、失败或卸载后四份 v1.4.0 文件不残留。

## 依赖范围

- CycloneDX/许可清单共 507 个锁定组件，许可证声明缺失为 0；
- Windows x64 正式图包含 306 个 required 组件，其中 5 个是圆圆自身工作区包；
- 完整归档包含其余 301 个第三方正式组件；201 个开发/构建专用组件不进入安装归档；
- 正式图的 22 种许可证表达式已冻结在 `docs/release/THIRD_PARTY_LICENSE_POLICY_V1.json`，新增、删除或改写表达式都会令生成失败；
- 正式图没有 GPL、AGPL、LGPL、SSPL 或未知许可证表达式；构建期 `caniuse-lite` 的 CC-BY-4.0 属于 excluded 范围，不进入发布归档。

## 归档生成规则

`scripts/generate_third_party_licenses.mjs` 从 `package-lock.json` 和 Cargo 对 `x86_64-pc-windows-msvc` 的正式依赖图读取锁定包，只收集普通文件形式的 `LICENSE`、`LICENCE`、`COPYING`、`NOTICE` 和 `UNLICENSE`；脚本、源码、配置文件、符号链接、空文件、二进制文件、超大文件和逃逸包目录的路径都会关闭失败。

归档具有以下绑定：

- `package-lock.json` SHA-256；
- `src-tauri/Cargo.lock` SHA-256；
- 许可证策略 SHA-256；
- 每个组件的 purl、声明许可证、选择的分发许可证、原文文件名和可审计回退来源；
- 不写入本机绝对路径或生成时间，因此同一锁文件和依赖源码生成相同字节。

11 个上游 workspace crate 发布包没有携带仓库根许可证。生成器只接受固定版本的显式回退：同仓库兄弟 crate、标准 MPL-2.0/Apache-2.0 文本，或 WebView2 两个 Cargo 打包提交上内容一致的官方 MIT 原文。归档中共 12 段原文带 provenance 行（Tauri 双许可回退包含两份原文）；若未来包开始自带许可证，旧回退会变成 stale 并阻止生成。

## MPL-2.0 源码可得性

正式图包含 5 个未修改的 MPL-2.0 crate：`cssparser-macros 0.6.1`、`cssparser 0.36.0`、`dtoa-short 0.3.5`、`option-ext 0.2.0` 和 `selectors 0.36.1`。策略和随包 `THIRD_PARTY_NOTICES.md` 同时冻结 crates.io 的精确版本下载地址；归档中的每个对应组件也直接记录 source-form URL。

Mozilla 的 MPL 2.0 FAQ 说明，分发由他人 MPL 源码编译的可执行程序时，需要告知接收者如何取得 MPL 部分的源码。当前实现满足工程层面的告知和版本绑定；发布负责人仍需确认正式发布期间这些地址可用，并确认没有对相应第三方文件做未披露修改。

## 安装与卸载证据

`tauri.conf.json` 只允许以下四项固定资源映射：

| 源文件 | 安装目标 |
| --- | --- |
| `LICENSE` | `licenses/LICENSE.txt` |
| `THIRD_PARTY_NOTICES.md` | `licenses/THIRD_PARTY_NOTICES.md` |
| `THIRD_PARTY_LICENSES.txt` | `licenses/THIRD_PARTY_LICENSES.txt` |
| `ASSETS_LICENSE.md` | `licenses/ASSETS_LICENSE.md` |

生成的 `src-tauri/target/release/nsis/x64/installer.nsi` 创建 `licenses` 目录、逐项安装四个文件，并在卸载时逐项删除后移除空目录。`release:nsis-payload` 还会把当前安装包静默安装到一次性目录，逐文件重算四份材料哈希并验证卸载清理。发布边界、AI 关闭边界和预检均要求资源集合精确相等；额外资源、sidecar、QA 夹具或缺少任何许可材料都会失败。

## 自动验证

```powershell
npm.cmd run release:licenses:test
npm.cmd run release:licenses:verify
npm.cmd run release:license-review:packet
npm.cmd run release:license-review:test
npm.cmd run release:license-review:packet:check
npm.cmd run release:boundary
npm.cmd run release:preflight:test
npm.cmd run release:preflight
```

当前结果：许可生成器 3 项回归通过；人工复核包契约 3 项测试覆盖正向具名人工签字及 AI签字、未完成决定、渠道漂移、未解决发现和候选包漂移拒绝；`release:preflight:test` 的 16 项许可资源/NSIS载荷、安装失败恢复、卸载数据选择、许可证、外部信任、RFC3161及完整升级回退未声明/虚假声明分型与其余逻辑测试全数通过，首次启动数据库恢复另有 4 项证据测试通过。完整候选预检中 `license_materials_bundled=passed`、`nsis_installed_payload=passed`，`license_review=pending`。

## 结构化人工复核契约

`release-license-review-packet.json` 确定性绑定当前发布清单中的三项正式产物，以及 SBOM、许可清单、全文归档、NOTICE、素材许可、项目许可、许可策略和发布策略八份材料的字节数与 SHA-256。包内同时冻结 507 个锁定组件、306 个生产组件、301 个第三方生产组件、201 个排除组件、22 种生产许可表达式、11 个显式回退映射和 5 个 MPL 源码地址。

具名人工签字必须从 `docs/release/RELEASE_LICENSE_REVIEW_ATTESTATION_V1.template.json` 创建为 `docs/release/RELEASE_LICENSE_REVIEW_ATTESTATION_V1.json`。独立校验器要求：

- 发布渠道已经从允许列表中冻结，精确发布者 Subject 已写入策略，目标地区使用排序且去重的 ISO 两字母代码；
- 复核人填写姓名、职责、组织并明确确认是人工复核；Codex、ChatGPT、AI、Bot 或自动化身份不能签字；
- 许可表达式、回退来源、NOTICE/署名、MPL 源码、第三方修改、素材权利、渠道/商标、分发材料和适用的专业法律复核逐项为真；
- 商业发行必须另行确认圆圆素材商业许可，非商业发行则明确记为不适用；
- 未解决发现为空，并至少引用本记录和另一份真实复核材料；
- 签字时间不早于当前发布清单，签字文件、复核包、发布清单、安装包哈希和 `RELEASE_EVIDENCE_STATUS_V1.json` 相互一致。

若 `licenseReviewVerified=true` 但签字缺失、签字由 AI 冒充、候选或渠道漂移、任一决定未完成，预检会把该门记为失败而不是待办。当前没有创建实际签字文件；`npm.cmd run release:license-review:verify` 按设计退出 2。

## 人工门仍需确认

1. 发布主体对圆圆照片、图集、图标和截图拥有在所选渠道分发的权利，并接受 `ASSETS_LICENSE.md` 与实际发行方式的一致性；
2. 发布负责人复核 22 种正式许可证表达式、11 个显式回退来源和全部 NOTICE/署名原文；
3. 正式发布期间保持 5 个 MPL-2.0 精确源码地址可用，并记录第三方源码是否被修改；
4. 根据发布主体所在地区、渠道、是否收费和商标使用情况完成专业法律复核；
5. 冻结渠道和精确发布者 Subject 后重新生成复核包，由具名人工从模板创建实际签字文件；不得由 Codex 或自动化工具代签；
6. 完成后才把当前 NSIS 安装包哈希、复核包与实际签字文件引用加入 `RELEASE_EVIDENCE_STATUS_V1.json`，并将 `licenseReviewVerified` 改为 `true`；
7. 运行 `npm.cmd run release:license-review:verify` 和严格发布门；任何候选、策略、材料或签字漂移都必须重新复核。

## 参考

- Tauri 2 资源打包：<https://v2.tauri.app/develop/resources/>
- Mozilla MPL 2.0 FAQ：<https://www.mozilla.org/en-US/MPL/2.0/FAQ/>
- Apache License 2.0 应用说明：<https://www.apache.org/legal/apply-license.html>
- Unicode License FAQ：<https://unicode.org/faq/unicode_license.html>

# P0发布签名、误报与回退SOP

日期：2026-08-05  
适用范围：圆圆提醒便携主程序、NSIS实际安装主程序、未来Bridge/AI辅助进程、NSIS安装包及后续Store包

## 1. 当前结论

当前候选仍是正式发布`NO-GO`：低成本方案允许把 NSIS 作为明确标注、附 SHA-256 的未签名测试版，但 v1.4.0 尚未发布，旧冻结摘要对应文件也已不在工作区；当前脏工作区的同名重建文件不能冒充该候选。便携主程序、NSIS实际安装主程序和NSIS安装包均未签名，不能标记为稳定版。正式目标为 Microsoft Store MSIX，须建立新的候选与验收边界。

已经完成的工程地基：

- 便携主程序、NSIS实际安装主程序、原型和安装包的固定角色、大小与SHA-256清单；
- 一次性静默安装—提取—卸载门，验证Tauri `UNK`/`NSS`包类型差异、实际安装许可材料和零测试残留；
- 正式安装声明排除Bridge/AI原型和`runtime-qa`夹具；
- AI全部关闭组合门：生产网络只允许本地IPC、无AI时提醒核心继续工作，且报告绑定当前主程序和NSIS哈希；
- Windows Authenticode状态、发布者Subject、证书指纹和时间戳证书采集；
- CycloneDX 1.6 SBOM和第三方许可证声明清单；
- 候选哈希绑定的Defender扫描入口；
- 候选与策略绑定的SmartScreen/第三方安全软件外部测试包、具名人工签字模板和关闭失败校验器；
- 候选与策略绑定的签名/RFC3161协议包、无凭据具名人工签字模板和关闭失败校验器；
- 候选与策略绑定的多档DPI/文本缩放/高对比度/减少动态/全键盘/Narrator人工验收包、签字模板和关闭失败校验器；
- 候选绑定的完整升级/真实中断/回退包、具名人工签字模板和关闭失败校验器；
- 日常预检报告与严格发布阻断命令。

`npm.cmd run release:preflight`负责生成诚实报告，不因待办项退出失败；`npm.cmd run release:gate`是正式发布门，只要任何一项未完成就以退出码2阻断。

## 2. 渠道事实与选择

以下外部事实以2026-08-05查阅的Microsoft官方资料为准，采购前必须重新核对：

| 渠道 | 当前事实 | 对圆圆的含义 |
|---|---|---|
| Microsoft Artifact Signing Public Trust | Basic当前为每月9.99美元、5,000次签名；但Public Trust目前只向美国、加拿大、欧盟、英国的组织，以及美国、加拿大的个人开发者开放 | 只有签约主体满足地区和身份验证条件时才可选；中国大陆主体不得按文档外推可用 |
| 传统CA代码签名证书 | 可用于直接分发和Store的MSI/EXE路径；必须链接到Microsoft Trusted Root Program中的CA | 若主体不满足Artifact Signing资格，这是维持NSIS分发的现实路径；OV/EV按组织、密钥保护和采购条件比较 |
| Microsoft Store MSIX/AppX | Store认证后由Microsoft重新签名，免自购公开信任代码签名证书 | 需要新增MSIX打包、身份、更新、迁移、自启动和卸载验证，不等于把当前NSIS直接上传 |
| Microsoft Store MSI/EXE | 支持现有安装器，但安装器及其中所有PE必须先用受信CA证书签名；要求版本化HTTPS地址、独立离线安装器和静默安装 | 不能借Store绕过现有NSIS签名采购；还要验证NSIS静默参数和返回码 |

项目负责人已选择低成本分阶段方案：`RELEASE_POLICY_V1.json`记录`strategy=low_cost_staged`、`previewArtifactPolicy=unsigned_beta_with_sha256`和`plannedStableChannel=microsoft_store`。当前 NSIS 不是 MSIX，故正式`selectedChannel`保持`pending`。后续执行顺序：

1. 按 `V1.4.0_RELEASE_SOURCE_SCOPE_V1.json` 和 `V1.4.0_SOURCE_SPLIT_AUDIT_2026-08-11.md` 排除 Learning Preview，形成干净、可追溯且主库仍为 schema 11 的 `main` 提交并重新冻结 NSIS 候选；
2. 完成未签名候选的发布验收，重新生成同一文件的字节数与 SHA-256，并以 GitHub prerelease 明确标注“测试版 / 未签名 / 未知发布者”；
3. 创建或使用 Microsoft Store 开发者账户，取得产品保留名与 Partner Center 六项公开身份；
4. MSIX可行性Spike已完成独立构建、打包、解包、清单、哈希和精确载荷边界验证；在干净Windows 11环境补齐安装、运行、数据生命周期、WACK和人工矩阵；
5. Store 认证并重签后完成最终回归，再把稳定渠道从 `pending` 切换为 `microsoft_store`。本路线不采购 OV/EV 证书；只有未来恢复独立稳定下载渠道时才重新评估传统 CA 签名。

官方依据：

- [Windows代码签名渠道比较](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Artifact Signing可用范围与身份验证FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)
- [Artifact Signing Basic/Premium价格与额度](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku)
- [Artifact Signing SignTool集成](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-signing-integrations)
- [SmartScreen发布者与文件信誉](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [MSI/EXE Store提交要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements)
- [RFC 3161 Authenticode时间戳](https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures)

## 3. 签名顺序与身份不变量

正式流程必须保持以下顺序：

1. 从固定提交、锁文件和受控Windows构建环境生成未签名候选；
2. 执行全量测试、资源验证和生产边界扫描；
3. 生成SBOM和许可证清单，人工复核NOTICE、素材、商标和传递义务；
4. 通过Tauri受控签名命令，在主程序完成最终PE包类型补丁后、进入NSIS前签名；便携 `UNK` 主程序和NSIS内 `NSS` 主程序是两个不同字节产物，必须分别取得有效签名。未来Bridge/AI进入包时也必须在嵌入前签名；
5. 使用SHA-256文件摘要和RFC 3161 `/tr`时间戳，时间戳摘要使用`/td SHA256`；
6. 生成NSIS后最后签名安装包；签名后不得再修改任何字节；
7. 从最终NSIS提取实际安装主程序并重新生成产物清单，严格校验便携主程序、NSIS实际安装主程序和安装包均为`Valid`、发布者Subject精确匹配、同一候选使用同一证书且时间戳存在；
8. 用独立证据确认签名命令确实使用RFC 3161与SHA-256，而不是把“存在时间戳证书”扩大解释为协议已证明；
9. 运行Defender、SmartScreen、第三方安全软件和升级回退矩阵；
10. `npm.cmd run release:gate`通过后才允许上传候选。

禁止把PFX密码、云签名访问令牌、证书私钥、时间戳凭据或完整CI身份写入仓库、命令行日志、诊断包和发布报告。签名身份轮换必须先更新策略、风险记录和SmartScreen预期，不允许临时用另一张证书救火。

普通预检会生成`release-signing-protocol-packet.json`，但当前未签名候选的包不能沿用到最终签名产物。渠道、精确发布者Subject和HTTPS时间戳URL冻结后，按上面顺序完成最终签名，再重新生成清单与协议包。具名人工操作人从模板创建实际签字，只记录工具/执行证据哈希和规范化协议参数，不记录完整敏感命令或凭据。仅把`rfc3161ProtocolVerified`改为`true`会关闭失败；Windows签名事实、候选、策略、采集脚本、协议包或签字任一漂移都必须重新签名与复核。当前证据见`../P0_RELEASE_SIGNING_PROTOCOL_QA_2026-08-10.md`。

## 4. 自动预检

| 命令 | 作用 | 当前预期 |
|---|---|---|
| `npm.cmd run release:nsis-payload` | 一次性静默安装/提取/卸载，绑定实际 `NSS` 主程序、许可材料和清理边界 | 通过；不代表签名通过 |
| `npm.cmd run release:manifest` | 生成五项产物角色、大小和SHA-256（自动先提取NSIS实际主程序） | 通过 |
| `npm.cmd run release:upgrade-rollback` | 以官方v1.3.2和当前候选执行隔离安装、升级、先卸载当前版再回装旧版，绑定程序身份、许可材料、合成数据哨兵和清理边界 | 通过；不代表完整默认路径/真实数据库/中断矩阵通过 |
| `npm.cmd run release:upgrade-rollback:default` | 在显式确认的干净测试账户使用默认current-user安装目录执行同一文件转换矩阵，并单独记录控制面板注册是否可见 | 默认路径文件转换通过；当前受管账户`registrationGatePassed=false` |
| `npm.cmd run release:install-failure-recovery` | 用确定性损坏候选、旧主程序独占锁及观察到部分主程序写入后的受限Job终止，验证旧边界、不完整文件集、合成数据哨兵和原始候选恢复 | 通过；不代表真实掉电/系统重启或数据库迁移通过 |
| `npm.cmd run release:first-start-recovery` | 在干净合成数据目录观察到非空SQLite WAL后终止1% CPU受限Job，再以同一候选恢复并生成无旁文件数据库样本供独立复验 | 通过；不代表物理掉电、系统重启或真实历史数据库迁移通过 |
| `npm.cmd run release:uninstall-data-choice` | 在干净交互账户验证默认卸载保留LocalAppData/RoamingAppData，且只有明确勾选真实NSIS复选框才删除两处数据 | 通过；仅使用合成哨兵，不代表真实数据恢复或辅助功能矩阵通过 |
| `npm.cmd run release:binary-boundary` | 确认默认主程序不含运行验收标记 | 通过 |
| `npm.cmd run release:source-scope:test` | 冻结v1.4.0稳定范围、v1.3.2基线、排除Learning Preview路径与共享运行时标记、主库schema 11、路径规范化和报告哈希绑定 | 9/9通过；只验证合同 |
| `npm.cmd run release:source-scope:verify` | 在真实Git提交上复核干净main、基线祖先、全部变更路径和逐文件运行时源码哈希 | 当前必须退出2；位于`feat/learning-preview-foundation`且工作区不干净 |
| `npm.cmd run release:unsigned-beta:test` | 验证源码范围报告、干净main来源、双重人工声明、固定五段构建链、无Authenticode证书表、不可覆盖独立暂存、精确校验文件/披露文案，以及GitHub prerelease标签、正文、资产、API digest和匿名下载边界 | 16/16通过；只验证合同，不代表当前候选已冻结或发布 |
| `npm.cmd run release:unsigned-beta:freeze` | 在构建前后确认同一干净main提交和同一源码范围报告，重跑范围门、完整验证、Rust测试、正式构建和安装载荷复核，再不可覆盖地冻结候选及来源证据 | 当前必须退出2；工作区有大量未提交变更且位于`feat/learning-preview-foundation`，冻结目录不存在 |
| `npm.cmd run release:unsigned-beta:github:capture` | 发布后匿名复核tag提交、prerelease标记、逐字披露、精确两个资产和下载字节 | 当前必须退出2；冻结目录及公开v1.4.0 prerelease均不存在 |
| `npm.cmd run msix:store:test` | 验证Partner Center身份安全录入、匿名公开链接证据、干净源码候选、Store listing/隐私/截图/合规输入、逐文件发布清单、Store专用许可证复核、五场景数据生命周期、Defender候选绑定、两款非Defender产品人工矩阵、WACK短期信任清理、临时受信副本/微软重签包两类运行来源与候选载荷血缘、十三项固定PNG人工预提交证据、认证/上架证据和最终渠道切换合同的正向样本与关闭失败边界 | 84/84通过；只验证合同，不代表实际身份或人工证据存在 |
| `npm.cmd run msix:store:data:capture:test` | 验证一次性合成数据会话、固定10个检查点、schema 11/固定表集合、逻辑哈希、无正文报告、不可覆盖证据和完整数据根删除观察 | 9项Rust临时目录与命令合同测试通过；不触碰当前账户真实数据 |
| `npm.cmd run msix:store:identity:test` | 验证六项公开身份值、两项显式来源声明、自动UTC时间、严格正式校验、重复/未知参数拒绝和正式身份文件不可覆盖 | 11/11通过；不生成或猜测Partner Center实际身份 |
| `npm.cmd run msix:store:identity:verify` | 只接受Partner Center产品标识页逐字复制且由人确认的Name、Publisher、PublisherDisplayName、PFN和Store ID | 当前必须退出2；实际身份文件尚不存在 |
| `npm.cmd run msix:store:public-urls:test` | 验证匿名GET、精确HTTP 200、固定HTTPS来源、响应类型/大小/页面标记、远端隐私原文一致、七天时效、严格字段与报告不可覆盖 | 8/8通过；不发起真实联网采集 |
| `npm.cmd run msix:store:public-urls:capture` | 匿名读取隐私政策、项目主页、支持入口及隐私原文，生成一次性机器证据 | 当前必须退出2；公开仓库主页和Issues匿名返回200，但远端main尚无PRIVACY.md，隐私链接为404 |
| `npm.cmd run msix:store:build` | 在完全干净、已提交源码上隔离构建未签名Store接入包，并绑定Git提交、身份、工具、主程序、清单和精确载荷 | 当前必须失败；实际身份缺失且工作区未冻结 |
| `npm.cmd run msix:store:submission:test` | 验证listing字段限制、只填机器字段的draft、四张候选绑定PNG、匿名链接报告时序/哈希、隐私/支持URL、免费/市场/可见性人工选择、离线声明、runFullTrust说明和IARC待办边界 | 10/10通过；现有1280×720 JPG按设计不被接受 |
| `npm.cmd run msix:store:submission:prepare` | 验证正式PNG编码并自动生成仅含机器哈希/尺寸的待人工draft，不填写或伪造批准字段 | 当前必须退出2；实际身份、候选和正式截图不存在 |
| `npm.cmd run msix:store:submission:verify` | 复核实际身份、候选、七天内匿名公开链接证据、公开隐私政策、Store输入文件、四张真实截图及全部来源哈希 | 当前必须退出2；实际身份、公开链接报告、候选、输入文件和正式截图不存在 |
| `npm.cmd run msix:store:release-manifest` | 为未签名Store候选生成独立逐文件清单，绑定主程序、清单、图标、许可载荷、SBOM、许可证清单、隐私政策、listing输入、身份和策略 | 当前必须退出2；实际身份、候选和人工确认Store输入不存在 |
| `npm.cmd run msix:store:release-manifest:verify` | 重新计算上述全部字节和合规输入，拒绝载荷扩张、许可证替换、SBOM未解决项和直接分发声明 | 当前必须退出2；正式Store发布清单尚不存在 |
| `npm.cmd run msix:store:license:packet` | 为实际Store intake候选生成独立许可证人工复核包，冻结11类材料、四份入包许可文件、507/306/301组件、22种生产表达式、11个回退映射、5个MPL源码地址和NSIS签字不可复用边界 | 当前必须退出2；实际Store身份与发布清单不存在 |
| `npm.cmd run msix:store:license:verify` | 复核Store渠道/发布者显示名/地区/商业属性、具名人工复核与批准、九项决定、素材商业许可、零未解决发现和至少两项证据引用 | 当前必须退出2；实际Store许可证人工验收文件不存在 |
| `npm.cmd run msix:store:data:test` | 验证NSIS→MSIX、备份恢复、更高版本更新、卸载保留数据、应用内显式删除后卸载五类合成数据合同，拒绝逻辑哈希/schema/计数/包族/发布者/证据漂移和真实用户数据 | 8/8通过；不代表真实Windows场景已执行 |
| `npm.cmd run msix:store:data:verify` | 绑定Store身份、发布清单、临时受信运行报告、当前测试签名包、NSIS测试版冻结报告、匿名GitHub prerelease报告、校验文件、策略、五张脱敏PNG和具名人工批准 | 当前必须退出2；应用内完整数据删除入口已实现，但实际冻结/公开NSIS测试版、Store身份、候选和具名人工验收不存在 |
| `npm.cmd run msix:store:defender` | 在Defender实时保护启用且安全情报不超过48小时的环境扫描原始MSIX与完整解包载荷，记录版本、目标哈希和检测结果 | 当前必须失败；实际身份、候选和Store发布清单不存在，本机Defender还由其他安全产品接管 |
| `npm.cmd run msix:store:defender:verify` | 复核候选/逐文件目标/扫描脚本绑定、定义时效、实时保护和零检测 | 当前必须退出2；正式Store Defender报告不存在 |
| `npm.cmd run msix:store:security:test` | 验证两家不同厂商、不同干净快照、72小时内定义、实时保护、原包与完整解包载荷、零检测、脱敏PNG和具名人工批准合同 | 6/6通过；不代表真实第三方产品扫描已经执行 |
| `npm.cmd run msix:store:security:verify` | 联合绑定Store发布清单、Defender报告、策略、验证器和两款第三方产品人工证据；SmartScreen仅因Store托管且禁止直发而不适用 | 当前必须退出2；实际Store安全验收文件和脱敏证据不存在 |
| `npm.cmd run msix:store:wack -- -ConfirmDisposableWindows11Environment` | 在一次性Windows 11的活动管理员会话，用不可导出短期证书签名候选副本，先做安装/启动/卸载，再执行WACK；随后删除My/TrustedPeople证书并证明原始上传包未变 | 当前待办；执行成功后仍须人工阅读报告 |
| `npm.cmd run msix:store:wack:verify` | 复核上传候选未变、测试副本签名、短期证书/包/进程零残留、WACK工具和原始XML哈希 | 当前必须退出2；实际WACK报告不存在 |
| `npm.cmd run msix:store:runtime:verify` | 复核WACK流程生成的临时受信副本运行报告；它不代表Microsoft签名或Store认证 | 当前必须退出2；实际运行报告不存在 |
| `npm.cmd run msix:store:pre-submission:verify` | 绑定Store身份、listing/隐私输入、逐文件发布清单、Store专用许可证复核包/人工验收、五场景数据生命周期、Defender与两款第三方产品、未签名候选、临时测试签名副本、WACK、运行报告和十三项固定路径脱敏PNG人工矩阵；逐文件复算格式、尺寸和SHA-256 | 当前必须退出2；认证状态必须保持pending |
| `npm.cmd run msix:store:certified-runtime:verify` | Partner Center认证后复核Microsoft重签包的身份、安装、AUMID启动、进程来源、卸载和零残留 | 当前必须退出2；认证及重签包尚不存在 |
| `npm.cmd run msix:store:certification:verify` | 联合复核预提交门、Store许可证与数据生命周期人工验收、Microsoft重签包回归、Partner Center认证/上架状态、IARC、runFullTrust审批、公开产品链接、脱敏证据和全部来源哈希，同时保持渠道未切换 | 当前必须退出2；实际身份、认证、上架、重签包和人工证据均不存在 |
| `npm.cmd run msix:store:channel:verify` | 认证门通过后复核负责人仅把`selectedChannel`从`pending`切换为`microsoft_store`，并绑定切换前后策略哈希与具名人工操作 | 当前必须退出2；不得在认证证据完成前切换 |
| `npm.cmd run ai-off:release` | 验证AI关闭源码/运行/安装边界并绑定当前候选 | 通过 |
| `npm.cmd run release:sbom` | 生成Windows x64 CycloneDX和许可证声明清单 | 通过 |
| `npm.cmd run release:license-review:packet` | 将三项正式候选、八份许可材料、生产表达式、回退映射和MPL源码地址冻结为确定性人工复核包 | 包已生成；实际具名人工签字仍缺失 |
| `npm.cmd run release:license-review:verify` | 复核候选/渠道/发布者/地区绑定、具名人工身份、全部决定、未解决发现和证据引用 | 当前必须退出2；发布者、目标地区和人工签字尚未完成 |
| `npm.cmd run release:external-trust:packet` | 冻结三项正式候选、SmartScreen干净机前提、完整生命周期和至少两款非Defender安全产品的零检测要求 | 包已生成；真实外部测试与签字仍缺失 |
| `npm.cmd run release:external-trust:verify` | 复核具名人工测试人、环境快照、MoTW/Internet Zone、在线信誉、SmartScreen提示、产品去重、实时防护和零检测结果 | 当前必须失败；实际签字文件尚未创建 |
| `npm.cmd run release:signing-protocol:packet` | 冻结三项正式候选、渠道/发布者/时间戳策略、签名采集脚本和RFC3161操作合同 | 当前 NSIS 只作未签名测试版；MSIX仅为占位身份技术预览，正式渠道等待Store身份与提交候选建立后冻结 |
| `npm.cmd run release:signing-protocol:verify` | 联合实时Authenticode事实复核具名人工操作人、签名工具、执行证据、同证书、精确发布者、时间戳证书与`/fd SHA256`、`/tr`、`/td SHA256` | 当前必须退出2；产物未签名且实际签字缺失 |
| `npm.cmd run release:accessibility:packet` | 冻结三项正式候选及多档DPI、文本缩放、对比度、减少动态、全键盘、Narrator与安装卸载人工矩阵 | 包已生成；最终签名候选与人工矩阵缺失 |
| `npm.cmd run release:accessibility:verify` | 联合实时签名事实、具名人工听读、完整矩阵和候选绑定证据 | 当前必须退出2；实际签字不存在 |
| `npm.cmd run release:upgrade-completion:packet` | 冻结六个自动子门、真实v1.3.2迁移报告、签名协议材料和完整物理中断/重启/回退合同 | 包已生成；真实迁移报告与签名实际签字缺失 |
| `npm.cmd run release:upgrade-completion:verify` | 联合自动子门和具名人工签字复核默认注册、真实数据库、物理中断、系统重启、签名恢复与旧库安全回退 | 当前必须退出2；实际材料和签字尚未完成 |
| `npm.cmd run release:preflight:test` | 验证NSIS实际载荷、隔离/默认路径转换、安装失败恢复、首次启动数据库恢复、卸载数据选择、许可证、外部信任、RFC3161、无障碍人工矩阵与完整升级回退伪通过拒绝、AI关闭、默认正式程序冷启动、路径逃逸、未签名拒绝、同证书和Defender候选绑定逻辑 | 17/17通过 |
| `npm.cmd run runtime:release-cold-start -- -SampleCount 3 -WindowTimeoutSeconds 30 -AcknowledgeFreshTestAccount` | 在一次性干净Windows测试账户采集默认正式程序的新配置启动P50/P95 | 3/3通过，P50/P95为148.6/223.8 ms |
| `npm.cmd run release:defender` | 扫描便携主程序、NSIS实际安装主程序和安装包，报告绑定候选哈希 | 必须在Defender启用环境运行；当前机器未启用，不能记通过 |
| `npm.cmd run release:preflight` | 生成完整报告 | 当前应为`readyForRelease=false` |
| `npm.cmd run release:gate` | 严格发布门 | 当前必须退出2 |

当前SBOM包含507个去重组件：306个Windows x64发布/构建必需组件，201个锁定但非发布范围的开发组件，许可证声明缺失为0，共26种许可证表达式。NSIS候选绑定的人工复核包冻结301个第三方生产组件、22种生产表达式、11个回退映射、5个MPL源码地址和八份材料哈希；Store链另有独立复核包，把相同依赖事实重新绑定到11类Store材料、四份实际入包许可文件、Store身份、未签名intake候选与逐文件发布清单，并明确拒绝复用NSIS签字。两套具名人工签字契约都拒绝AI/自动化签字、渠道或候选漂移、未完成决定与未解决发现。自动清单和结构化契约均不构成法律意见；MPL-2.0组件及素材、字体、图标、WebView2引导程序等仍需人工复核实际分发形式和NOTICE义务，当前实际签字文件不存在，许可门保持待办。现有签名协议包继续证明 NSIS 不满足正式签名门；未签名测试版必须单独披露状态和 SHA-256。MSIX正式链已建立身份、构建、listing/隐私/截图/合规输入、逐文件发布清单、Store专用许可证复核、Defender原包/解包双扫描、两家不同厂商第三方安全产品人工矩阵、临时受信运行及候选载荷血缘、WACK、人工预提交、认证后Microsoft重签包回归、Partner Center认证/上架脱敏证据和仅改变渠道字段的最终切换合同，但实际Partner Center身份、候选和证据均不存在；它仍是新候选，必须重新建立许可、升级、安全软件与体验证据，不能沿用当前NSIS的包或哈希。

## 5. 安全软件与误报流程

每个候选都以安装包SHA-256为唯一索引，不得把旧版本结果沿用给新哈希。

1. 在病毒库有效、Defender服务和实时保护启用的干净Windows虚拟机运行`release:defender`，同时扫描便携主程序、NSIS实际安装主程序和安装包；
2. 从正式HTTPS候选地址下载，使文件具有真实Mark-of-the-Web，再观察SmartScreen发布者、提示级别和能否在目标策略下安装；本地复制文件不能替代；
3. 至少选择两款目标市场常见第三方安全产品，记录产品名、版本、病毒库、时间、候选哈希、安装/首次启动/常驻/卸载结果；
4. 扫描主程序、安装包和未来每个辅助进程，检查安装前、安装后、首次启动、Hook短进程、IPC、自动启动和卸载行为；
5. 任一恶意软件、高危、PUA、隔离、删除、安装阻断或签名无效均立即`NO-GO`；
6. 仅出现“未识别应用”但签名发布者准确时，记录为SmartScreen信誉风险，不能宣称签名自动消除警告；由发布负责人决定继续小范围试点还是等待信誉积累；
7. 误报提交必须保留厂商工单号、提交哈希、检测名、复现环境、厂商结论和重新扫描证据；新构建需新建关联记录；
8. 不通过加壳、混淆、关闭安全功能、让用户添加全盘排除或隐藏辅助进程来规避检测。

普通预检会确定性生成`release-external-trust-test-packet.json`，但不会自动创建`RELEASE_EXTERNAL_TRUST_ATTESTATION_V1.json`。实际测试完成后，具名人工测试人必须从模板创建签字文件，逐项记录干净快照、Windows版本、候选哈希、时间、环境、证据引用和各阶段结果，并把当前候选哈希、测试包与实际签字文件加入`RELEASE_EVIDENCE_STATUS_V1.json`引用。仅把`smartScreenCleanMachineObserved`改为`true`或把`thirdPartySecurityProductsVerified`改为2会被预检判为失败；候选、策略、测试包或签字任一漂移都必须重测。当前候选的冻结哈希、验证结果和执行边界见`../P0_RELEASE_EXTERNAL_TRUST_QA_2026-08-10.md`。

## 6. 升级与回退矩阵

签名候选至少覆盖：

- 当前稳定版→候选版原位升级，提醒库和设置完整；
- 安装前、文件替换中、数据库迁移前后和首次启动时中断；
- 候选安装失败后旧稳定版仍可启动，或有明确恢复步骤；
- 卸载不删除用户数据，明确选择删除数据时再执行；
- 新核心/旧AI、旧核心/新AI、旧Bridge/新核心和协议不兼容均安全降级；
- AI全部关闭时，提醒、喝水、活动、专注、备份和恢复保持稳定；
- 回退数据库副本与迁移失败回滚，不能用真实用户唯一副本做演练；
- 签名证书过期、时间戳服务不可用、证书吊销或身份轮换时停止发布。

每次演练记录安装包哈希、起止版本、Windows版本、账户类型、步骤、结果、数据哈希和恢复耗时。没有历史签名二进制时只能完成调试矩阵，不能标记正式兼容门通过。

当前已完成的 `isolated_installer_transition_probe` 冻结官方v1.3.2 Setup/安装主程序与当前候选哈希，在一次性自定义安装根验证安全顺序和正式LocalAppData合成哨兵；`default_install_path_transition_probe`又在显式确认的干净测试账户验证默认current-user安装目录下的同一文件转换。`isolated_install_failure_recovery_probe`进一步覆盖确定性损坏候选、旧主程序替换受阻，以及观察到部分主程序写入后的受限Windows Job终止：首轮曾发现NSIS返回0却形成半升级，现通过安装前独占替换检查以退出码32在任何写入前中止；Job终止场景则证明部分主程序、旧卸载器、许可缺席、哨兵保留和未修改候选恢复。`default_release_first_start_database_recovery`在合成空数据目录观察到非空SQLite WAL后终止1% CPU受限Job，再由同一候选恢复到可见窗口、schema 11和完整默认数据；规范化无旁文件样本由独立校验器重开并复算哈希。`uninstall_data_choice_probe`在干净交互账户证明真实删除数据复选框初始关闭：默认卸载保留LocalAppData/RoamingAppData合成哨兵，明确勾选后两处才被删除。当前受管账户禁止HKCU写入，默认报告如实保持`registrationGatePassed=false`。五项证据独立进入普通预检，但都不会设置`upgradeRollbackDrillVerified=true`，也不会缩减控制面板注册、真实历史数据库迁移、真实掉电/系统重启、卸载辅助功能或签名矩阵。详细边界见`../P0_RELEASE_UPGRADE_ROLLBACK_PROBE_2026-08-09.md`、`../P0_RELEASE_DEFAULT_INSTALL_PATH_QA_2026-08-09.md`、`../P0_RELEASE_INSTALL_FAILURE_RECOVERY_QA_2026-08-09.md`、`../P0_RELEASE_FIRST_START_RECOVERY_QA_2026-08-10.md`与`../P0_RELEASE_UNINSTALL_DATA_CHOICE_QA_2026-08-09.md`。

完整门现由`release-upgrade-completion-packet.json`和实际签字单独承接：除上述自动子门外，还必须取得可写HKCU控制面板注册、真实v1.3.2关闭态数据库迁移报告、最终签名/RFC3161候选、真实断电或虚拟机硬重置、实际Windows重启以及恢复升级前schema v6副本后再启动旧版的证据。优雅退出不能冒充断电，杀进程不能冒充系统重启，v1.3.2不得打开已迁移的schema v11数据库。当前包明确缺少真实迁移报告和签名协议实际签字；完整合同见`../P0_RELEASE_UPGRADE_COMPLETION_QA_2026-08-10.md`。

## 7. P0-E08退出条件

- 发布主体、渠道、预算、密钥保护人和备份接手者具名；
- 精确发布者身份冻结，主程序、所有实际随包PE和安装包同身份签名；
- SHA-256与RFC 3161时间戳证据通过；
- SBOM、第三方许可证、NOTICE和素材许可由负责人签字；
- Defender、SmartScreen和至少两款第三方安全产品完成候选绑定验证；
- 误报提交与发布阻断流程演练一次；
- 安装、升级、中断、卸载和回退矩阵通过；
- 严格发布门返回0。

在这些条件完成前，Bridge/AI不得进入安装包；当前未签名安装包只能作为明确标注、附 SHA-256 的测试版或本地开发证据，不能标记为稳定正式版。

# Microsoft Store MSIX 接入运行手册

状态：工程入口已准备；等待 Partner Center 实际身份、源码冻结、干净 Windows 11 验收和 Store 认证

## 1. 当前路线

项目继续采用低成本分阶段方案：现有 NSIS 只作为明确标注并附 SHA-256 的未签名测试版；正式稳定版使用 Microsoft Store MSIX。Store 会在认证后重新签名 MSIX，因此这条路径不采购 CA 代码签名证书，也不把自签名证书加入开发机信任库。

现有 `msix-preview` 只证明打包结构可行。`msix-store` 是另一条关闭失败的正式候选链，必须使用 Partner Center 分配的身份、已提交的干净源码和独立验收证据，二者不得互相冒充。

## 2. 先取得 Partner Center 身份

1. 创建或使用 Windows 开发者账户；
2. 在 Partner Center 选择“新建产品 → MSIX 或 PWA 应用”，保留正式产品名；
3. 打开“产品管理 → 产品标识”；
4. 只从产品保留页和产品标识页逐字复制以下六项公开值：
   - 保留产品名；
   - `Package/Identity/Name`；
   - `Package/Identity/Publisher`；
   - `Package/Properties/PublisherDisplayName`；
   - Package Family Name；
   - Store ID；
5. 由实际查看 Partner Center 页面的人执行下面的不可覆盖录入命令。将示例文本替换为页面原值；命令自动写入当前 UTC 时间，并复用正式校验器后才创建 `MSIX_STORE_IDENTITY_V1.json`：

```powershell
npm.cmd run msix:store:identity:prepare -- `
  --reserved-product-name "饺饺提醒" `
  --store-id "Partner Center Store ID" `
  --identity-name "Package Identity Name" `
  --publisher "Package Publisher DN" `
  --publisher-display-name "Publisher Display Name" `
  --package-family-name "Package Family Name" `
  --confirmed-by "实际人工确认人" `
  --attest-copied-from-partner-center `
  --attest-public-values-only
```

   如果正式身份文件已经存在，命令会停止且保持原文件逐字节不变；身份变化不得合并或覆盖，必须先查明是否错误产品、错误账户或重新保留了产品；
6. 不得把 Partner Center 密码、令牌、付款资料、证书私钥或会话信息写入文件。

身份文件必须人工复核后提交到 Git。`npm.cmd run msix:store:identity:test` 覆盖录入和校验合同；构建器会拒绝缺失、占位、未由人确认、复用预览 OID、Package Family Name 不匹配、Store 版本第四段非 `0`、重复/未知录入参数、缺少两项来源声明或出现未知字段的输入。

## 3. 冻结并构建正式候选

只有工作区已提交且 `git status` 完全干净时执行：

```powershell
npm.cmd run msix:store:identity:verify
npm.cmd run msix:store:build
npm.cmd run msix:store:candidate:verify
```

构建使用独立 `src-tauri/target/msix-store/cargo-target`，不会覆盖 NSIS 或技术预览。输出为单一 Windows x64 `.msix`，只含主程序、三张图标、四份许可证、清单和块映射；Bridge、AI、QA 工具及嵌套安装器会被拒绝。

候选保持未签名，专用于 Store 接入，不能直接提供给用户。候选报告固定 `storeSubmissionReady=false`；能否上传由后续运行、WACK 和人工预提交门共同判定，不能通过修改候选报告绕过。

## 4. 准备 Store listing 与合规输入

Desktop Bridge/Win32 产品即使不联网，也必须提供可公开访问并保持更新的隐私政策；`runFullTrust` 属于受限能力，提交时必须说明用途。项目已经冻结公开文案、隐私事实、能力说明与截图合同：

1. 确认 `PRIVACY.md` 已发布到模板指定的公开 HTTPS 地址，同时确认项目网站与支持入口可匿名访问；
2. 执行公开链接采集。脚本只发出不带 Cookie、令牌或认证头的匿名 HTTPS GET，要求隐私政策、项目网站与支持入口精确返回 HTTP 200，并额外从 `raw.githubusercontent.com` 读取隐私政策原文，与本地 `PRIVACY.md` 逐字节比对。报告固定写入 `src-tauri/target/msix-store/msix-store-public-urls-report.json`，七天后失效且不可覆盖；若链接仍为 404、跳到登录页、跨站重定向、内容类型异常或远端政策漂移，采集必须失败且不生成报告；
3. 在与第 3 步候选绑定的一次性 Windows 11 环境中，以合成数据采集 `store-assets/README.md` 要求的四张真实 PNG，不得使用浏览器模拟、设计稿、生成图或现有 1280×720 JPG 冒充；
4. 执行 `msix:store:submission:prepare`，由脚本验证 PNG 编码并自动填写身份、候选、公开链接报告、图片尺寸/哈希和全部源码哈希；脚本只生成 `src-tauri/target/msix-store/msix-store-submission-inputs.draft.json`，不会代替人批准；
5. 将该 draft 复制为 `docs/release/MSIX_STORE_SUBMISSION_INPUTS_V1.json`，由人在公开链接报告生成后确认 URL、免费定价、可见性、市场范围、数据声明和内容事实，再把 `status` 改为 `human_confirmed_ready_for_partner_center_entry`；
6. IARC 保持 `pending_partner_center_completion` 且 `ratingId=null`，只能在 Partner Center 根据当时实际问题人工完成，不能预填或伪造评级。

```powershell
npm.cmd run msix:store:submission:test
npm.cmd run msix:store:public-urls:test
npm.cmd run msix:store:public-urls:capture
npm.cmd run msix:store:public-urls:verify
npm.cmd run msix:store:submission:prepare
# 完成人工复核并保存正式输入文件后：
npm.cmd run msix:store:submission:verify
npm.cmd run release:sbom
npm.cmd run release:licenses:verify
npm.cmd run msix:store:release-manifest
npm.cmd run msix:store:release-manifest:verify
```

校验器固定产品名、版本、`zh-CN`、`Productivity`、离线功能文案、隐私/支持 URL、无账户/联网/遥测/广告/内购/生成式 AI 声明、唯一 `runFullTrust` 能力说明、四张至少 1366×768 且不超过 50 MB 的 PNG，以及身份、候选、公开链接报告、政策、清单、素材许可和校验器本身的哈希。人工 URL 确认时间不得早于匿名采集时间。Store 专用发布清单随后逐文件记录未签名候选中的主程序、AppxManifest、图标、四份许可材料及包元数据，同时绑定 CycloneDX 1.6 SBOM、零未解决项许可证清单、隐私政策和 listing 输入；它明确禁止直接分发该包并保持认证状态为 `pending`。通过只表示材料可录入 Partner Center，不表示实际提交或 IARC 已完成。

### 4.1 完成 Store 候选许可证人工复核

NSIS 的旧复核包和签字不能复用于 Store。先为当前未签名 Store intake 候选生成独立复核包：

```powershell
npm.cmd run msix:store:license:test
npm.cmd run msix:store:license:packet
npm.cmd run msix:store:license:packet:check
```

复核包冻结 Store 身份、逐文件发布清单、提交输入、发布策略、SBOM、许可证清单、项目/素材许可、NOTICE、第三方全文归档和四份实际入包许可文件；同时冻结 507/306/301 个组件、22 种生产许可表达式、11 个来源回退映射和 5 个 MPL 源码地址。自动生成与校验不构成法律意见。

由具名人工复核人把 `MSIX_STORE_LICENSE_REVIEW_ACCEPTANCE_V1.template.json` 复制为无 `.template` 的正式文件，填写按字母排序的目标地区、Store 发布者显示名、是否商业使用、素材商业许可结论、九项复核决定、至少两项证据引用和最终人工批准。商业使用为 `true` 时必须取得并填写 `commercialAssetPermission=confirmed`；否则填写 `not_applicable`。任何未解决发现、AI/自动化签字、NSIS 渠道复用、候选/材料漂移都会关闭失败。完成后执行：

```powershell
npm.cmd run msix:store:license:verify
```

## 5. 运行 Windows App Certification Kit

在活动用户会话中，以管理员 PowerShell 执行：

```powershell
npm.cmd run msix:store:defender
npm.cmd run msix:store:defender:verify
npm.cmd run msix:store:security:verify
npm.cmd run msix:store:wack -- -ConfirmDisposableWindows11Environment
npm.cmd run msix:store:runtime:verify
npm.cmd run msix:store:wack:verify
```

Defender 门要求 Antivirus、服务和实时保护同时启用，安全情报更新时间不超过 48 小时；它分别扫描原始 `.msix` 和完整解包目录，并把候选及十项载荷哈希、扫描脚本、引擎/产品/签名版本和零检测结果绑定到 Store 发布清单。检测记录存在、定义过期、扫描目标漂移或 Defender 被其他安全产品停用都会关闭失败，不能用普通文件哈希或 Store 后续认证替代这一步。

然后从同一冻结候选分别恢复至少两份互不相同的干净 Windows 11 快照，在每份快照只安装并启用一款非 Defender 安全产品，更新到 72 小时以内的定义，同时扫描原始 `.msix` 和完整解包目录。将每款产品的完成页裁剪、遮盖账户/邮箱/设备标识后，保存为 `src-tauri/target/msix-store-security/<product>-redacted-evidence.png`。把 `MSIX_STORE_SECURITY_ACCEPTANCE_V1.template.json` 复制为无 `.template` 的正式文件，填写两家不同厂商的产品/引擎/定义版本、具名人工测试人、不同快照 SHA-256、完整目标清单、零检测结果、证据哈希和最终人工批准，再执行上面的 `msix:store:security:verify`。Defender 不计入这两款产品；同厂商换产品名、复用同一快照、只扫描 MSIX 不扫描解包载荷、定义过期、证据未脱敏或任何检测都会关闭失败。

SmartScreen 在这条链中明确记为 `not_applicable_store_managed_distribution`：未签名候选只上传 Partner Center，发布清单禁止直接分发。不得为了满足旧 NSIS 合同而把未签名 MSIX 从浏览器下载后伪造“无警告”观察；如果未来恢复独立下载，则必须另走受信签名与 SmartScreen 合同。

WACK 脚本随后独立复核候选，在一次性测试机的当前用户证书库创建两天有效、不可导出私钥且 Subject 精确匹配 Store Publisher 的测试证书，对候选副本签名。它先验证受信安装、身份注册、AUMID 启动、进程来源、卸载和零包/进程残留，再执行 `appcert.exe reset` 与 `appcert.exe test -appxpackagepath`。无论成功或失败，证书都会从 `CurrentUser/My` 与 `CurrentUser/TrustedPeople` 删除，临时证书文件也会删除；原始未签名上传候选必须保持字节不变。

脚本保留测试签名副本、运行报告、WACK 原始 XML 和工具/候选哈希，供预提交矩阵绑定。运行报告还会把签名包解包，逐一比较 Store 发布清单中的主程序、清单、图标和许可文件；仅允许签名生成的 `AppxSignature.p7x` 及受控 AppxMetadata 元数据不同，任一稳定载荷漂移都会关闭失败。这里验证的是一次性环境中的临时受信副本，不是 Microsoft 签名，也不代表 Store 已认证。命令成功只代表自动检查完成；负责人仍须阅读全部结果，`wackReportReview` 人工项通过前不会关闭预提交门。

Docker 容器不作为 MSIX 安装结论环境；WACK、AppX 部署、交互桌面、托盘、通知和登录自启动需要真实 Windows 用户会话。短期证书只允许出现在明确可销毁的测试机，日常开发机和最终用户设备不得执行该步骤。

### 5.1 完成 Store 数据生命周期验收

固定检查点、一次性会话、安全开关和草稿生成命令见 `MSIX_STORE_DATA_LIFECYCLE_CAPTURE_PROTOCOL_V1.md`。采集工具只在显式 QA 特性下构建，默认安装包不包含它；初始化遇到已有数据根会停止，不会读取或删除已有内容。

运行报告生成后，先执行合同测试：

```powershell
npm.cmd run msix:store:data:test
```

只在可销毁的干净 Windows 11 快照中使用合成提醒、专注、设置和备份数据。将 `MSIX_STORE_DATA_LIFECYCLE_ACCEPTANCE_V1.template.json` 复制为无 `.template` 的正式文件，完成以下五个场景：

1. 从 `src-tauri/target/unsigned-beta/1.4.0/` 中已经通过冻结校验、且由匿名 GitHub prerelease 报告证明公开发布的 NSIS 测试版迁移到当前 Store 候选；验收同时绑定冻结报告、公开发布报告、`SHA256SUMS.txt` 和安装包摘要，确认应用标识对应同一逻辑 `LOCALAPPDATA/com.yuanyuan.reminder` 数据根，schema 11、逻辑状态哈希和聚合记录数不变。仅有旧文档摘要、默认构建目录同名文件或未公开候选都不能作为迁移源；
2. 创建生产备份、写入可观察的合成变更、恢复备份，确认恢复后逻辑哈希/计数回到基线且 `quick_check=ok`；
3. 以同一 Package Family Name、同一 Publisher 的更高四段版本测试签名 MSIX 做原位更新；目标版本必须高于当前版本且第四段仍为 `0`，更新后数据不变并删除测试更新包；
4. 卸载包但保留外部数据根，重新安装后打开原数据库并复核逻辑哈希；
5. 在“设置 → 删除全部本地数据”中逐字输入“删除饺饺全部本地数据”、勾选不可恢复确认并通过最后一次系统确认；应用会关闭开机启动、完全退出，再由受限清理模式仅删除固定的 `LOCALAPPDATA/com.brucexia.jiaojiao.reminder` 数据根。随后卸载 MSIX，确认数据库、备份、学习数据、日志和整个项目数据根都不存在。普通 MSIX 卸载不能冒充该显式删除路径。

五个场景复用预提交矩阵中对应的固定脱敏 PNG，并记录 schema、逻辑状态 SHA-256 和按表聚合计数；禁止读取真实用户数据，也禁止把原始正文写入报告。完成后执行：

```powershell
npm.cmd run msix:store:data:verify
```

“删除全部本地数据并退出”入口及退出后受限清理协议已经实现，并由临时目录 Rust 测试和前端确认链测试覆盖；测试不会触碰真实用户数据。第 5 个场景仍必须在实际 Store 候选、可销毁 Windows 11 快照和合成数据上由具名人工完成，不得仅凭源码测试、删除包注册或手工删除某个数据库文件声明通过。

## 6. 完成人工预提交矩阵

将 `MSIX_STORE_PRE_SUBMISSION_ACCEPTANCE_V1.template.json` 复制为 `MSIX_STORE_PRE_SUBMISSION_ACCEPTANCE_V1.json`，逐项记录候选绑定证据：

- 受信安装与启动；
- 托盘显示；
- 登录后自启动；
- 通知投递；
- 单实例；
- WebView2 启动；
- NSIS 到 MSIX 迁移；
- 备份恢复；
- 向前更新；
- 卸载保留数据与显式删除数据；
- 无障碍；
- WACK 原始报告人工复核。

每项必须为 `passed`、填写具体观察，并把已遮盖账户、邮箱、设备标识和真实用户数据的 PNG 保存到模板固定的 `src-tauri/target/msix-store-pre-submission/<check>-redacted-evidence.png`；图片至少为 320×180，`redacted=true`，SHA-256 必须由该文件实际复算。AI 或自动化不能作为人工测试人/批准人。然后执行：

```powershell
npm.cmd run msix:store:pre-submission:verify
```

该矩阵同时绑定第 4 步的 Store 输入、逐文件发布清单、Store 专用许可证复核包及人工验收和隐私政策，以及第 5 步的 Defender 报告、两款第三方安全产品人工验收、临时测试签名副本、运行报告、Store 数据生命周期人工验收和 WACK 结果。预提交门和最终认证门都会重新读取十三张固定证据 PNG、验证编码/尺寸/脱敏声明并复算哈希，不能用任意 64 位字符串冒充证据。字段 `disposableTestSignedPackageSha256` 不得填写未来的 Microsoft 重签包哈希。该门只允许声明“可提交 Store”，并强制 `storeCertification=pending`。

## 7. 上传并等待 Partner Center 认证

只有第 6 步通过后，才把第 3 步生成且哈希已冻结的原始未签名候选上传 Partner Center。不要上传 `wack-test-signed.msix`，也不要把未签名候选直接提供给用户。

在 Partner Center 中完成定价与市场、Properties、Store listing、受限能力说明、IARC 问卷和 Submission options，并保存当时显示的评级与提交结果。任何代码、清单、图标、文案、政策、截图、版本或载荷变化都视为新候选/新材料，必须重新执行第 3—6 步。认证完成前保持 `storeCertification=pending`，不得声明正式发布成功。

## 8. 对 Microsoft 重签包做最终回归

Partner Center 实际认证通过并提供 Microsoft 重签包后，在新的干净 Windows 11 虚拟机或专用测试机执行：

```powershell
npm.cmd run msix:store:runtime:test -- `
  -PackagePath "C:\StoreCertified\YuanyuanReminder.msix" `
  -SignatureOrigin microsoft_store `
  -ConfirmDisposableWindows11Environment
npm.cmd run msix:store:certified-runtime:verify
```

该门验证 Microsoft 重签包的受信签名与 Publisher 精确一致、包身份/版本/架构、安装、AUMID 启动、进程来自 WindowsApps 安装位置、停止、卸载、包字节不变和零包/进程残留。它还复核重签包中九项稳定载荷与上传候选的逐文件大小和 SHA-256 完全一致，防止只凭相同身份/版本接受另一份应用内容。脚本不添加证书、不切换开发者模式。

最终回归通过仍不等于内部渠道已经切换。继续取得 Partner Center 的认证、上架、IARC 与 `runFullTrust` 审批证据，再执行下一节的两个独立关口。

## 9. 冻结认证证据并切换正式渠道

Partner Center 仪表板必须同时显示认证通过和 `In Microsoft Store`。从产品标识页复制 Store ID，从实际提交记录复制 Submission ID、认证/发布时间、IARC Rating ID 与各评级，从公开产品页复制 `https://apps.microsoft.com/...` 链接，并确认受限能力 `runFullTrust` 已获批准。不要把密码、令牌、Cookie、付款资料、证书私钥或完整账户页面保存到项目中。

1. 只保留能证明 Store ID、提交状态、IARC、受限能力审批和公开产品链接的页面区域；遮盖姓名、邮箱、付款信息、账户标识和无关产品，将结果保存为 `src-tauri/target/msix-store-certification/partner-center-redacted-evidence.png`；
2. 将 `MSIX_STORE_CERTIFICATION_ACCEPTANCE_V1.template.json` 复制为 `MSIX_STORE_CERTIFICATION_ACCEPTANCE_V1.json`，逐字填写 Partner Center 公共事实、证据哈希、实际身份/材料/预提交/微软重签包运行报告/重签包/当前策略哈希以及具名人工复核；
3. 保持 `RELEASE_POLICY_V1.json` 的 `selectedChannel=pending`，把认证文件状态改为 `store_certified_ready_for_channel_promotion`，并执行：

```powershell
npm.cmd run msix:store:certification:verify
```

该命令会重新执行预提交门和 Microsoft 重签包运行门，并要求认证已通过、产品已经上架、Store URL 包含精确 Store ID、IARC 至少有一项真实评级、`runFullTrust` 已批准、证据已脱敏且所有哈希未漂移。通过只表示“允许人工切换渠道”，不会自行修改策略。

4. 由负责人只把 `RELEASE_POLICY_V1.json` 中的 `selectedChannel` 从 `pending` 改为 `microsoft_store`，不要在这一步混入任何其他策略修改；
5. 在认证文件中把状态改为 `store_certified_channel_promoted`，填写新策略 SHA-256、具名操作人和时间，再执行：

```powershell
npm.cmd run msix:store:channel:verify
```

最终校验会反推切换前策略的字节哈希，证明策略仅改变了 `selectedChannel`，同时重新绑定 Store 身份、预提交证据、Microsoft 重签包、最终运行报告和脱敏 Partner Center 证据。两条命令都通过后，才可声明正式稳定渠道已经切换；认证文件和脱敏证据必须按发布记录一并归档。

## 10. 当前准确阻断项

- `MSIX_STORE_IDENTITY_V1.json` 尚不存在，Partner Center 实际产品身份未取得；
- 当前工作区仍有未提交的功能开发，正式构建器会拒绝运行；
- `MSIX_STORE_SUBMISSION_INPUTS_V1.json`、公开隐私政策确认、四张候选绑定 Store PNG、可见性/市场人工选择均不存在；
- Store 专用许可证复核包尚未生成，`MSIX_STORE_LICENSE_REVIEW_ACCEPTANCE_V1.json` 及具名人工法律/素材复核证据尚不存在；
- Store 数据生命周期人工验收文件尚不存在；应用内显式删除入口已实现，但尚未在实际 Store 候选和可销毁 Windows 11 快照上取得具名人工证据；
- 临时受信副本的干净 Windows 11 运行、WACK 和十三项人工矩阵均未完成；
- 十三张预提交人工检查的固定路径脱敏 PNG 尚不存在；
- Defender 与两款不同厂商第三方安全产品的候选绑定零检测证据尚不存在；
- Partner Center 的 IARC 问卷、实际提交和认证尚未开始。
- Partner Center 认证/上架脱敏证据、Microsoft 重签包最终回归和渠道切换人工批准尚不存在。

这些是预期的关闭失败状态，不影响继续开发，也不改变现有未签名 NSIS 测试版策略。

## 11. 官方依据

- [Microsoft：查看产品标识详细信息](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details)
- [Microsoft：MSIX 应用包要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
- [Microsoft：Windows App Certification Kit](https://learn.microsoft.com/en-us/windows/uwp/debug-test-perf/windows-app-certification-kit)
- [Microsoft：通过 Microsoft Store 分发 Win32 应用](https://learn.microsoft.com/en-us/windows/apps/distribute-through-store/how-to-distribute-your-win32-app-through-microsoft-store)
- [Microsoft：MSIX Store listing 字段](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/add-and-edit-store-listing-info)
- [Microsoft：MSIX 截图与图片要求](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/screenshots-and-images)
- [Microsoft：MSIX 产品属性与隐私政策](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/enter-app-properties)
- [Microsoft：应用能力声明与受限能力审批](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations)
- [Microsoft：MSIX 年龄分级](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/age-ratings)
- [Microsoft Store Policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies)
- [Microsoft：发布流程与 In Microsoft Store 状态](https://learn.microsoft.com/en-us/windows/apps/publish/get-started)
- [Microsoft：提交发布控制选项](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/manage-submission-options)
- [Microsoft：产品管理与 Store listing 链接](https://learn.microsoft.com/en-us/windows/apps/publish/product-management-and-services)

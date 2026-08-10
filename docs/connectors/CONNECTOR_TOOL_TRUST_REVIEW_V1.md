# Codex / Claude Code 来源工具信任复核 v1

状态：P0 Windows只读实现完成；Codex包身份第二因子已接入，Claude 2.1.211 Windows发布证据与真实x64双因子复核已完成，真实Hook仍关闭  
日期：2026-08-05  
实现：`src-tauri/src/connector_tool_trust.rs`、`connector_discovery.rs`

## 目标

“检测到安装”“来源工具可信”“已授权圆圆”“Hook配置状态”“事件健康”是五条独立事实。发现同名程序、注册表包名或PATH条目不构成信任；授权记录也不能反向证明当前磁盘上的工具仍可信。

本复核只验证Windows本地程序来源，不启动Codex或Claude Code，不读取会话、项目、任务或Hook配置，不访问网络，不返回路径、发布者原文、证书、指纹、版本或命令输出，也不修改任何配置。

## 2026-08-05官方分发事实

- OpenAI官方Windows文档给出的桌面应用Store产品ID为`9PLM9XGG6VKS`，企业文档明确该应用由Store签名，也提供Store签名MSIX；当前开发机桌面Codex可执行文件的有效Authenticode发布者为`OpenAI OpCo, LLC`。Codex CLI仅在PATH中出现时，本协议不依据文件名或单一签名自动推断它属于桌面分发。
- Anthropic当前官方文档推荐原生安装，也支持`winget install Anthropic.ClaudeCode`和npm安装；Windows二进制的官方Authenticode发布者为`Anthropic, PBC`。从`2.1.89`起，发布清单还具有Anthropic GPG签名，官方固定指纹为`31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`。
- Microsoft规定`WinVerifyTrust`的`WINTRUST_ACTION_GENERIC_VERIFY_V2`用于Authenticode验证；设置`WTD_CACHE_ONLY_URL_RETRIEVAL`可保证代码签名验证不尝试网络检索。

外部依据：

- [OpenAI Windows应用](https://learn.chatgpt.com/docs/windows/windows-app)
- [OpenAI Windows企业部署](https://learn.chatgpt.com/docs/enterprise/windows-deployment)
- [Anthropic Claude Code高级安装与签名](https://code.claude.com/docs/en/getting-started)
- [Microsoft WinVerifyTrust](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/nf-wintrust-winverifytrust)
- [Microsoft WINTRUST_DATA与离线标志](https://learn.microsoft.com/en-us/windows/win32/api/wintrust/ns-wintrust-wintrust_data)

发布者名称属于当前Windows签名策略的精确允许值；官方签名身份发生合法轮换时必须先复核资料、更新证据日期和攻击矩阵，不做模糊匹配或静默放宽。

## 判定契约

| 状态 | 含义 | 是否可作为未来真实Hook的来源证据 |
| --- | --- | --- |
| `not_detected` | 没有候选工具 | 否 |
| `verified` | 单一普通EXE、Authenticode链有效、发布者精确匹配、分发位置符合冻结规则，且对应包身份或签名清单SHA-256第二因子通过 | 仅是必要条件，不单独开放Hook |
| `review_required` | 证据缺失、脚本包装、签名/发布者/分发不符、多个安装冲突或文件替换 | 否 |
| `unavailable` | Windows信任提供程序无法给出结论 | 否 |

Codex只有桌面应用管理位置中的单一有效`OpenAI OpCo, LLC`签名EXE，并且系统暂存包根、固定包族与包内`app/resources/codex.exe`位置全部交叉一致时才可得到`verified`；普通PATH CLI即使具有相同签名，仍返回`distribution_not_attested`。Claude Code的单一普通EXE必须具有有效`Anthropic, PBC`签名，并且打开文件的SHA-256命中经固定Anthropic发布密钥验证后随圆圆编译的证据包；`.cmd`、`.bat`、未收录版本和无法绑定文件身份的入口均需复核。

## Windows检查顺序

1. 候选必须是非空普通`.exe`且最终组件不是重解析点；脚本包装不会被解析或执行。
2. 以允许删除共享的只读句柄打开文件，记录卷序列号和文件索引。
3. `WinVerifyTrust`直接使用该打开句柄，关闭UI并设置仅本地缓存的URL检索标志。
4. 从同一次信任状态读取叶子签名证书的简短发布者名称，执行大小写不敏感但字符精确的允许值比较。
5. 校验结束后重新打开路径并比较文件身份；校验期间被同名替换时返回`artifact_changed`。
6. 同一工具发现多个不同候选时，无论各自签名是否有效都返回`conflicting_installations`，防止PATH优先级或自动更新切换造成来源歧义。

## 第二因子与证据更新

Codex使用Windows系统包注册事实，不读取或自行信任`AppxManifest.xml`文本：候选路径必须位于`WindowsApps`下格式严格的`OpenAI.Codex_<四段版本>_<x64或arm64>__2p2nqsd0c76g0`包根，且`GetStagedPackagePathByFullName`返回的系统暂存根必须与磁盘祖先精确一致。包名、发布者ID、架构、版本格式、包内相对路径或系统根任一不符都关闭失败。本机真实包已通过该适配器；包身份发生官方轮换时必须按新证据显式更新，不做前缀放宽。

Claude使用编译期只读证据包`src-tauri/resources/connector-trust/claude-code-release-attestations-v2.json`。运行时只接受schema v2、代码审核过的签名根版本区间、`2.1.89`及以上规范版本、固定Windows平台、清单SHA-256和二进制SHA-256；重复版本平台、未知字段、非规范哈希或自行声明的新根全部关闭失败，然后对已经打开并完成Authenticode校验的同一文件句柄流式计算摘要。当前证据包包含2.1.211的`win32-x64`与`win32-arm64`两条真实记录；未收录版本仍返回`manifest_evidence_missing`，不会伪造通过。完整导入和密钥轮换契约见`CLAUDE_RELEASE_EVIDENCE_V2.md`。

发布人员只能使用`npm.cmd run trust:evidence:claude -- --gpgv <受控gpgv绝对路径> --manifest <manifest.json> --signature <manifest.json.sig> --keyring <只含审核密钥的keyring> --version <版本>`更新证据包。生成器拒绝链接或异常大小输入，调用指定的`gpgv --status-fd`并要求唯一`VALIDSIG`指纹精确等于`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`，再提取`win32-x64`和`win32-arm64`校验和、原子更新固定文件。生成结果必须进入代码评审；没有受控`gpgv`、签名无效、签名者不符、版本过旧、清单结构异常或已有证据包异常均停止且不改目标文件。

## 脱敏输出

输出只有固定枚举、候选计数和布尔证据：是否检查Authenticode、签名是否有效、发布者是否匹配、是否完成包身份/清单交叉证明，以及固定隐私事实。`packageIdentityAttested`只会在Codex系统包身份交叉通过时为真；`manifestAttested`只会在Claude打开文件摘要命中已审核证据包时为真。二者不会同时由目录、文件名、程序版本或授权记录推断。

不得返回或记录：完整路径、用户名、程序版本、发布者原文、证书主题/颁发者、序列号、指纹、签名错误正文或包清单内容。

## 当前证据与剩余门禁

自动测试覆盖精确发布者、Codex桌面分发位置与系统包身份、包族/发布者ID/架构/版本伪造、Codex CLI不误信、Claude本机EXE、固定GPG指纹证据、未验证/过旧/摘要不符证据、空证据包、脚本包装、错误发布者、无效签名、验证器不可用、多个候选、校验中同名替换和序列化脱敏。本机实际Store管理的Codex EXE已同时通过真正的离线Windows签名与系统包身份适配器测试；Claude 2.1.211 x64官方二进制也已在不运行程序的情况下通过真实离线Windows签名与v2发布清单摘要适配器测试。缺少相应实体安装或测试夹具时测试安全跳过，不伪造通过。

剩余发布门：OpenAI包族与双方签名/密钥轮换流程、Claude历史和后续版本及arm64实体文件矩阵、真实WinGet/npm/原生安装矩阵、圆圆自身签名、旧新版本事件载荷矩阵、第二Windows账户、安全软件和升级/回退。`verified`现在表示本地签名与对应离线分发第二因子同时通过，但仍不代表真实任务守望已获准启用。

# Claude Code 发布证据导入与密钥轮换 v2

状态：生成器、运行时消费者与失败关闭测试已实现；已导入 Claude Code 2.1.211 的两个 Windows 平台真实证据  
日期：2026-08-05  
范围：只验证 Claude Code Windows 来源工具，不开启或修改 Hook

## 信任链

圆圆不会因为文件名、安装目录、版本输出或已有授权记录而信任 Claude Code。一个候选文件必须同时满足：

1. 打开的同一普通 EXE 通过 Windows 离线 Authenticode 校验，发布者精确为 `Anthropic, PBC`；
2. 对同一打开文件句柄计算的 SHA-256 命中随圆圆编译的 v2 证据包；
3. 该证据条目来自版本专属 `manifest.json`，清单的分离式签名由代码中审核过的 Anthropic 发布密钥验证；
4. 版本、平台、清单哈希、二进制哈希和签名根全部符合规范结构，任何重复、未知字段或不规范表示都关闭失败。

Anthropic 官方说明：每个发布清单包含各平台二进制的 SHA-256；从 `2.1.89` 起提供清单分离式签名；当前发布密钥指纹为 `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`；Windows 二进制另由 `Anthropic, PBC` 签名。来源：

- [Claude Code 安装、二进制完整性与代码签名](https://code.claude.com/docs/en/getting-started#binary-integrity-and-code-signing)
- [Claude Code 发布签名密钥](https://downloads.claude.ai/keys/claude-code.asc)

## v2 证据结构

证据文件为 `src-tauri/resources/connector-trust/claude-code-release-attestations-v2.json`。每条记录只有：

- `version`：规范三段版本，且不早于 `2.1.89`；
- `platform`：仅 `win32-x64` 或 `win32-arm64`；
- `sha256`：清单中该平台二进制的规范小写摘要；
- `manifestSha256`：被验签清单原始字节的规范小写摘要；
- `signingKeyFingerprint`：本次有效签名对应的主密钥指纹。

`version + platform`必须唯一，全部条目必须按版本和平台排序，包最多 1,024 项。运行时不相信证据文件自行声明的新根：签名指纹还必须落入 Rust 代码冻结的版本区间策略。

## 独立发布环境导入步骤

1. 从官方版本专属地址下载 `manifest.json` 和 `manifest.json.sig`，从固定官方地址下载发布公钥；不要使用聊天、Issue、镜像或本机 Claude 输出作为来源。
2. 在隔离 keyring 中导入公钥，人工确认主密钥指纹与本协议一致；使用受控、已知来源的 `gpgv`，记录其版本与文件摘要。
3. 执行：

   `npm.cmd run trust:evidence:claude -- --gpgv <绝对路径> --manifest <manifest.json> --signature <manifest.json.sig> --keyring <隔离keyring> --version <版本>`

4. 生成器会先把清单、签名和 keyring 的已打开文件快照复制到独立临时目录，再让 `gpgv` 验证这些固定字节；只接受一个 `VALIDSIG`，并将签名子密钥归并到受审核主密钥。撤销、过期、错误、多个签名、未知根、验证器替换或超时全部失败。
5. 执行 `npm.cmd run trust:evidence:test`、`npm.cmd run trust:evidence:verify` 和 Rust 来源信任测试，复核证据 diff 后才能进入发布分支。

生成器不联网、不下载文件、不运行 Claude Code，也不读取任何用户配置。版本是审计索引，真正的运行时授权依据始终是“平台签名 + 已验签清单中的精确文件摘要”。

## 密钥轮换

发布人员不能通过参数传入或临时放行新指纹。Anthropic 合法轮换密钥时必须完成一次显式代码变更：

1. 从至少两条官方渠道复核新指纹、启用版本和旧密钥截止版本；
2. 同时更新生成器 `TRUST_ROOTS` 与 Rust `ANTHROPIC_RELEASE_KEY_POLICIES`，冻结不重叠的版本区间；
3. 增加旧根最后版本、新根首个版本、边界外版本、重叠区间和未知根攻击测试；
4. 用新旧边界版本的真实签名清单分别生成证据并复核；
5. 更新本协议日期和威胁模型，经安全评审后发布。

发现发布撤回、密钥泄露或错误证据时，删除受影响的精确版本/平台条目并重新构建即可关闭信任；不得把失败降级为仅凭 Authenticode、目录或版本号继续放行。

## 当前边界

2026-08-05 已在隔离目录中使用 GnuPG 2.5.21 的 `gpgv` 验证 Claude Code 2.1.211 官方清单。清单 SHA-256 为 `750cb326e4b6662c5a086acc970017d6f2da9279a1fa02d9f8a25eb053a43032`，有效签名归并到固定主密钥 `31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`。证据包现含 `win32-x64` 与 `win32-arm64` 两条真实记录。

另下载了该清单对应的 x64 Windows 二进制，只读验证其大小、清单摘要和 `Anthropic, PBC` Authenticode 签名，并让产品的实际 Windows 信任适配器完成一次双因子贯通测试；过程中未运行 Claude Code。可重复证据见 `CLAUDE_LOCAL_BINARY_EVIDENCE_2026-08-05.md`。

当前仍只覆盖一个密钥区间内的一个发布版本和一个实际下载平台。历史版本、arm64 实体文件、WinGet/npm/原生安装路径、多安装冲突、合法密钥/发布者轮换及撤回回退矩阵仍是发布门；未收录版本继续返回 `manifest_evidence_missing`，不得降级为仅凭 Authenticode 放行。

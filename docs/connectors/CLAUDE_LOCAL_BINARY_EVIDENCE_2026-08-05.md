# Claude Code 2.1.211 Windows发布信任证据

采集日期：2026-08-05  
证据等级：官方签名发布清单、受控GPG验证器、真实Windows二进制静态校验与产品适配器贯通；未运行Claude Code

## 官方输入

- 发布版本：`2.1.211`
- 发布清单：`https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096ee7/claude-code-releases/2.1.211/manifest.json`
- 分离式签名：同目录`manifest.json.sig`
- 发布公钥：`https://downloads.claude.ai/keys/claude-code.asc`
- 审核主密钥指纹：`31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE`
- 清单SHA-256：`750CB326E4B6662C5A086ACC970017D6F2DA9279A1FA02D9F8A25EB053A43032`

清单及签名均从官方地址直接下载到项目外的隔离临时目录。隔离keyring只导入上述公钥；`gpgv --status-fd`只产生一个`VALIDSIG`，有效签名归并到审核主密钥。生成器随后从固定字节快照提取并原子写入v2证据包。

## 受控验证器

- GnuPG for Windows：`2.5.21`
- 安装器：`gnupg-w32-2.5.21_20260702.exe`
- 安装器大小：5,772,160 bytes
- 安装器SHA-256：`6246C925A73167253444AFC24A0DEB83A3F43B7D636AF84D6AAF48A98A62F024`
- 安装器Authenticode：有效；主体`g10 Code GmbH`
- 隔离安装中的`gpgv.exe`大小：694,824 bytes
- `gpgv.exe` SHA-256：`10836486CF58D50EF01D4ACDE14788AB9771B230CC5B96BC3795A6C3948D6CDB`
- `gpgv.exe` Authenticode：有效；主体`g10 Code GmbH`

GnuPG版本与安装器摘要先对照官方GnuPG下载资料，再校验Windows签名；该工具没有进入圆圆源码、资源或安装包。

## 清单条目

| 平台 | 文件 | 大小 | SHA-256 |
| --- | --- | ---: | --- |
| `win32-x64` | `claude.exe` | 253,293,728 bytes | `3D8509AE7DE11D77DBDC711AA320FC6D5064CE795464A8670696611B57093CAF` |
| `win32-arm64` | `claude.exe` | 247,643,808 bytes | `A0F9BAB0DBDDA9B43A8765D54E329E44484D9DD7D4F40CF31DB6EEE27A2DA41C` |

两个平台条目都已进入`claude-code-release-attestations-v2.json`。arm64条目来自已验签清单，本轮未下载arm64实体文件。

## x64实体文件复核

- 实际下载大小与清单完全一致：253,293,728 bytes
- 实际SHA-256与清单完全一致：`3D8509AE7DE11D77DBDC711AA320FC6D5064CE795464A8670696611B57093CAF`
- Windows Authenticode状态：`Valid`
- 签名主体：`CN="Anthropic, PBC", O="Anthropic, PBC"`
- 颁发链主体：DigiCert代码签名CA
- 产品测试：`real_signed_claude_release_passes_both_offline_factors_when_provided`通过；返回`verified`，`authenticodeChecked`、`publisherMatched`和`manifestAttested`均为真

产品测试直接让`WindowsAuthenticodeVerifier`和编译期v2证据消费者读取同一真实文件，证明不是仅靠脚本或模拟值通过。测试没有启动、加载或向Claude Code传递参数，也没有读取用户Claude配置、项目、会话、凭据或Hook。

## 边界与清理

此证据只证明2.1.211 x64真实文件和同一签名清单中的arm64摘要；不外推到其他版本、安装器包装、PATH脚本、npm包装、WinGet状态、多个并存安装或未来密钥/发布者轮换。隔离下载、keyring、GnuPG文件和Claude实体文件在验证后删除；它们可从官方来源重新下载，保留在仓库中的只有审核过的摘要证据、测试和本记录。

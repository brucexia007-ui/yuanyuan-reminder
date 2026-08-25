# 圆圆提醒 v1.5 统一候选操作手册

状态：当前发布流程  
适用版本：`1.5.x` 及后续统一产品版本

## 目标

每次构建只产生一个可识别的圆圆提醒安装包。默认 Tauri 输出可以被后续构建覆盖，因此不能直接作为冻结候选；冻结步骤会把安装包复制到同时绑定 Git 提交和安装包 SHA-256 的新目录，且拒绝覆盖已有目录或混入旧文件。

## 标准顺序

```powershell
npm.cmd run verify
cd src-tauri
cargo test
cd ..
npm.cmd run tauri build
npm.cmd run release:unified-candidate:freeze
npm.cmd run release:unified-candidate:verify-current
```

准备实际发布时，最后一步改为：

```powershell
npm.cmd run release:unified-candidate:verify-release
```

这会额外要求候选来自当前干净的 `main`。它仍不会声称签名、安全软件、SmartScreen、无障碍或人工 Windows 验收已经完成。

## 目录合同

候选路径固定为：

`src-tauri/target/unified-candidates/v<version>/<commit12>-<artifactSha12>/`

目录中必须恰好有四个普通文件：

- 一个 `圆圆提醒_<version>_x64-setup.exe`；
- `.yuanyuan-unified-candidate-v1` 所有权标记；
- `candidate-manifest.json`；
- `SHA256SUMS.txt`。

清单绑定产品名、唯一应用身份、版本、完整提交、分支、提交时间、安装包字节数和哈希，以及 `product-version.json`、Tauri 配置、npm lockfile 和 Cargo lockfile 的哈希。清单中的签名状态固定从 `not-checked` 开始，不能用文本伪装签名或发布批准。

## 失败处理

- 目录已存在：停止；不得覆盖，也不得把新文件复制进去。
- 多出第二个安装包或任意子目录：验证失败。
- 安装包、清单或校验文件任一字节改变：验证失败。
- 发现非公开版标记或个人内容标记：验证失败；仅用于寻找用户旧数据的完整历史定位标识可存在。
- 非 `main`：可留作内部验证，状态必须是 `internal-only-non-main`，不得发布。

v1.4 的 `release:unsigned-beta:*` 与 `release:source-scope:*` 当前命令已经撤下。对应脚本和报告仅用于复核历史事实，不得作为 v1.5 发布入口。

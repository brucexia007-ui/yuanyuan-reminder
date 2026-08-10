# 发布产物清单 v1

状态：P0 构建证据格式；不等同于签名或发布批准。

`release-manifest.json` 用于把一次本地构建中的主程序、两个实验辅助进程和 NSIS 安装包绑定到同一份可审计记录。生成器只读取固定的 release 路径，不搜索工作区，也不把任何凭据写入清单。

## 字段

- `schemaVersion`：当前为 `1`；
- `productName`、`productVersion`：来自 Tauri 和 npm 清单；
- `generatedAt`：生成清单的 UTC 时间，不是二进制签名时间戳；
- `signatureVerification`：当前固定为 `not_performed`，禁止把哈希清单误当成 Authenticode 验证；
- `installerBoundary`：记录 `externalBin`、`resources` 和实验辅助进程是否被声明进安装包；
- `artifacts[]`：固定标识、release 相对路径、字节数、SHA-256 和打包处置。

`bundleDisposition` 允许当前四种角色：

- `primary_application`：稳定提醒主程序；
- `prototype_excluded`：仅工作区生成、不得进入当前安装包的实验进程；
- `distribution_installer`：NSIS 安装包。

## 生成前提

1. 完成 `cargo build --release --workspace`；
2. 完成 `npm.cmd run tauri build`；
3. 运行生产边界扫描，确认实验台代码/文案/样式不进入 `dist`；
4. 确认 Tauri `externalBin` 和 `resources` 未声明 Bridge 或 AI 原型；
5. 生成清单并在同一批产物上进行后续签名、时间戳和恶意软件预演。

当前脚本不会验证 NSIS 内部文件列表，也不会执行 Authenticode、RFC3161 或 SmartScreen 检查。这些证据必须在 P0-E08 的签名环境中追加，不能通过修改 `signatureVerification` 文本字段伪造。

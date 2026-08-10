# P0 AI 敏感进程崩溃隐私闸门（2026-08-07）

## 结论

`yuanyuan-ai.exe` 已增加启动期崩溃隐私闸门。非关闭辅助模式在读取私密 stdin 引导、访问 `LOCALAPPDATA`、创建目录或打开数据库前，先为当前进程启用 Windows Error Reporting（WER）无堆采集，再只读检查机器级 LocalDumps 配置。策略无法应用、注册表无法可靠读取、存在全局 LocalDumps 配置，或存在 `yuanyuan-ai.exe` 专属配置时，AI 服务直接关闭失败，不进入正文处理链。

这是一项缩小崩溃暴露面的工程控制，不是“敏感数据绝不会进入任何转储或磁盘”的取证级保证。正式 NSIS 仍排除 AI 与 Bridge，Support Box/Tauri 正文入口继续关闭。

## 官方依据与策略选择

- Microsoft 的 [`WerSetFlags`](https://learn.microsoft.com/en-us/windows/win32/api/werapi/nf-werapi-wersetflags) 文档说明 `WER_FAULT_REPORTING_FLAG_NOHEAP` 会停止为应用崩溃或挂起收集堆信息，且该标志只作用于调用进程。因此策略在 AI 进程自身最早的非辅助启动路径应用该标志，并用 `WerGetFlags` 回读确认。
- Microsoft 的 [Collecting User-Mode Dumps](https://learn.microsoft.com/en-us/windows/win32/wer/collecting-user-mode-dumps) 文档把 LocalDumps 配置放在 `HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps`，并说明不支持在 `HKCU` 配置。因此本闸门只读检查 64 位 HKLM 视图，不把缺少 HKCU 检查误当成遗漏。
- Microsoft 的 [WER Settings](https://learn.microsoft.com/en-us/windows/win32/wer/wer-settings) 文档区分全局 LocalDumps 值与按可执行文件命名的子键。本策略把全局 `DumpFolder`、`DumpCount`、`DumpType`、`CustomDumpFlags` 任一存在，或 `LocalDumps\yuanyuan-ai.exe` 子键存在，统一视为不满足敏感正文处理条件。

## 已实现边界

- `enforce_sensitive_process_crash_policy` 先调用 `WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP)`，再用 `WerGetFlags` 确认 `NOHEAP` 已生效且没有 `QUEUE`/`QUEUE_UPLOAD` 标志。
- 注册表检查只查询固定键名和值名是否存在，不读取 `DumpFolder` 或其他配置内容，不写入、不删除、不修改系统策略。
- LocalDumps 根键不存在且 AI 专属键不存在时允许继续；根键存在但只有其他应用子键、没有四个全局配置值，且没有 AI 专属键时也允许继续。
- 任意意外注册表错误都按“无法证明安全”处理，AI 服务关闭失败。
- 关闭辅助命令不读取正文、不创建本地状态，继续允许请求已运行的 AI 服务关闭；真正进入私密服务的路径不能绕过本闸门。
- 崩溃策略与通用命名管道预读闸门源码均已纳入 Support Sort 零日志/敏感类型静态边界，当时扫描范围由九段增加为十一段；后续语义预审门纳入后当前为十二段。

## 当前机器只读观察

2026-08-07 构建时只读检查结果：

- LocalDumps 根键存在；
- 四个受识别的全局配置值存在数量为 0；
- `LocalDumps\yuanyuan-ai.exe` 专属键不存在；
- 未修改注册表。

因此当前机器满足本策略的启动条件。该观察只代表检查时状态，不代表所有安装机器或进程整个生命周期内状态不变。

## 自动证据

4 项 AI 崩溃策略回归覆盖：

1. 当前真实进程成功应用 `NOHEAP`，且 `QUEUE`/`QUEUE_UPLOAD` 未启用；
2. 崩溃策略调用早于私密引导、本地数据根与数据库路径，且 `NOHEAP` 早于 LocalDumps 检查；
3. 注册表路径和值名固定，不读取配置内容；
4. 任意全局或 AI 专属 LocalDumps 配置观察都关闭失败。

另有 2 项真实命名管道回归证明通用预读闸门在客户端进程身份核验之后、正文缓冲分配与 `ReadFile` 之前执行；闸门拒绝时客户端不能取得成功，服务端不消费调用者载荷。Support Sort 的持续监听与单请求测试入口均固定使用该闸门，因此每次已认证连接都会在读取正文前重新应用并复核崩溃策略。

发布二进制边界要求真实 `yuanyuan-ai.exe` 同时包含 `WerSetFlags`、`WerGetFlags` 和 `Windows Error Reporting\LocalDumps` 三个正向标记；旧 AI 成品在重建前因缺少标记按设计失败，重建后通过。与此同时，17 个主程序 QA 标记和 3 个 AI 测试 Provider/正文金丝雀标记仍必须不存在。另有 4 项 Node 规则回归逐一证明任一必需标记缺失、任一主程序禁用标记出现或任一 AI 测试标记出现都会失败，并已接入统一 `npm verify`。

本轮完整验证结果：默认 Rust 521 项通过、3 项环境门忽略；全特性 541 项通过、3 项忽略；25 个前端测试文件共 146 项通过；全工作区 `clippy -D warnings`、统一 `npm verify`、release、Tauri/NSIS 与发布预检均通过。

## 候选绑定

- 主程序：22,164,992 bytes，SHA-256 `9EA0F9A7E48DE958D723D84FEFD6C518459A26786FA0252EE3806D5936BF51A0`
- AI 原型：2,834,432 bytes，SHA-256 `F7CB30167334E5800F9403882213BA1FE34C8F8DA642E1518D7B65F943F6C465`
- Bridge 原型：2,514,944 bytes，SHA-256 `AE8B30FEAEC388166407FB37AA02149909DC66BA9DE0F1E8A8B56A67D921158B`
- NSIS 安装包：12,458,797 bytes，SHA-256 `D61FC61CAB206739B856E058259A8C056FF97BA64178530601F77B4495B28B0F`
- 发布清单 SHA-256：`7997F272FCA4B0EBA3DB15F83CDB994545B9A769080090E32752D1626F585FF2`
- AI 关闭证据 SHA-256：`00C20880001A139FECC364D178AAE31D473F12A4A2C4BB4D35D1990B3979832E`
- 发布预检 SHA-256：`AD6B573AD40F82238F0DF5A1F7A38835208267CC3624114DBC442575169DE26F`
- 崩溃策略源码 SHA-256：`72FF4E6564E04B7D77BF3BE6A7A8F409F9A0E8E61FB3171DA476139EB885F8CB`
- 预读闸门源码 SHA-256：`823607A29F3230DBCEB9B72CC62E552F1D30BA6388D49107807F093042F8434E`

发布预检仍为 5 项通过、13 项待完成、0 项失败，`readyForRelease=false`。

## 未覆盖与下一道门

- `NOHEAP` 只限制 WER 为当前进程收集堆，不证明栈、寄存器、数据段、编译器临时副本或第三方组件中没有正文副本。
- 每次已认证 Support Sort 连接都会在正文读取前重新检查策略，运行期间变更不再只依赖启动快照；但检查完成后的竞态窗口、管理员调试器、外部转储工具、终端安全软件和自定义崩溃处理器仍不在本闸门可保证范围内。
- 页面文件、休眠文件、系统管道缓冲和内核内存尚未做取证扫描；本策略也没有修改页面文件或休眠设置。
- 已完成两阶段强退取证工具：QA注入版release AI会在真实Provider描述、单次授权和动态正文提交后异常终止，在线捕获扫描隔离应用目录、标准流和专用转储目录；离线终结器要求至少一个停机后取得的页面文件副本，并强制处理休眠/交换文件状态，重新绑定三份源码、捕获报告及全部离线文件SHA-256后扫描UTF-8/UTF-16LE金丝雀。工具与规则测试已通过，但尚未在获授权隔离主机上执行，不能把实现完成写成取证门已通过。完整流程见`P0_CRASH_PRIVACY_FORENSIC_QA_2026-08-08.md`。
- 主程序本身的 WER/LocalDumps、诊断目录和备份目录强退扫描仍待完成。
- 真实 PID 复用正向门已完成；正式 Tauri 窗口、真实 Provider、第二 Windows 账户和签名包身份矩阵仍未完成。

在上述动态取证完成前，不能把本闸门表述为“零转储”“零落盘”或开放正式正文入口的充分条件。

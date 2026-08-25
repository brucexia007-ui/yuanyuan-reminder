# pre-GEN 通用内容包纯解析性能 spike

状态：已完成授权范围；不是 GEN-000 冻结，不是 PACK-001 开工或交付<br>
日期：2026-08-25<br>
责任角色：Performance + Security；后续冻结仍需 Architecture / Database / Product 具名复核

## 结论

在用户明确授权的“只解析、只校验、零入库、不可发布”边界内，独立 Rust release 解析器已完成 JSON/CSV 候选合同、安全夹具执行、协作式取消/有界进度检查点和 4,533/20,000 卡正式基线。30/30 个性能样本通过预注册候选门，所有子进程均报告 `databaseWrites=0`，证据目录扫描到的数据库文件数为 0。

这项结果关闭“冻结预算附近能否在 Rust 中及时、有限内存地读取并解析”以及“纯解析文件管线各主要阶段能否在有界检查点协作取消/报告进度”的不确定性。正式 JSON 文件管线覆盖普通文件读取、输入预检、跨块 UTF-8、语法扫描、解码、结构遍历、逐卡校验、流式最终化和完成态九阶段，CSV 覆盖除独立语法扫描外的八阶段；serde_json/csv 解码输入和单卡字符串安全扫描、Unicode 规范化输入、CSV 分隔符与可选字段扫描、复制、哈希、规范 JSON 序列化分别有独立的 16 KiB 轻量取消探针，不扩大 UI 进度事件数量。它不关闭操作系统阻塞在单次不超过 4 MiB 的读取调用内的即时取消，也不关闭文件替换/token 语义、Tauri 后台调度、IPC 进度传递、WebView 响应性、真实导入、分页、数据库增长、preview token、staging/原子发布或 PACK-001 验收。

## 强制范围

允许：

- 从普通文件读取已生成的合成 JSON/CSV 字节；
- 严格解析、规范化、预算检查、稳定 ID/哈希计算；
- 生成只用于性能测试的确定性合成夹具；
- 输出有界的解析摘要、进程耗时和内存计数。
- 只读取普通非符号链接文件，元数据和读取增长均受 25 MiB 硬门；在文件读取、输入预检、跨块 UTF-8、语法扫描、解码、结构遍历、逐卡校验和流式最终化阶段报告进度，并以完成态收口。字节、JSON 值和卡片检查点分别为 4 MiB、16,384 个值和 256 张卡；20,000 卡 JSON/CSV 正式夹具同时达到 26,020,105/26,120,061 bytes，正式四类夹具最多观测到 147 个回调，证据合同拒绝超过 256 个回调的样本。

禁止：

- 创建、打开或修改 SQLite 数据库；
- 注册 Tauri command、调用 WebView 或接触用户正式数据；
- 生成或消费 preview token；
- staging、安装、原子发布、包启停或进度迁移；
- 把候选字段和预算宣称为已签字冻结的公共 schema；
- 以 spike 名义开始 PACK-001。

实现位于独立 workspace member `src-tauri/crates/learning-pack-spike`。它没有加入默认 workspace member，也没有连接主程序状态、repository 或 command handler。`verify_learning_pack_spike_boundary.mjs` 现在通过 `cargo metadata`、主程序/前端源码、Tauri 配置与 capability、crate 源码和可选构建产物共同执行这条边界：任何其他 workspace 包不得依赖 spike；crate 生产/测试依赖及其 capability features、target kind 和不可发布状态采用精确 allowlist；Tauri、SQLite、网络和子进程启动能力失败关闭；默认及 Learning Preview 产物不得出现 spike 包名、crate 名或解析器版本标记。6 项正反向测试覆盖允许形态及上述每类漂移。

## 候选解析合同

- 输入上限 25 MiB、20,000 卡、JSON 深度 8；严格 UTF-8，拒绝 BOM、NUL、bidi 和受控 Unicode 控制字符。
- 根字段固定为 `schemaVersion/packId/title/cards`，`schemaVersion` 仅接受 `1`，未知字段失败关闭。
- `packId/cardId` 只允许 `[A-Za-z0-9._:-]`，长度 1—128；规范化后重复整包拒绝。
- 通用卡字段为 `cardId/exerciseKind/prompt/answer/choices/explanation/tags/scheduleEpoch/extensions`。
- `prompt/answer/explanation` 分别限制 2,000/4,000/8,000 Unicode 字符；选项 2—4 个、每项 1,000 字符；标签最多 32 个、每个 64 字符；单卡 extensions 规范 JSON 合计最多 16 KiB。
- `choice` 未给候选时降级 `recall`；给出候选时必须唯一且正确答案恰好出现一次。`recall` 不接受候选。
- 内部 ID 使用 `SHA-256("yuanyuan-item-v1\0" + packId + "\0" + cardId)`，同时计算 file、pack content、item content、prompt 和 answer SHA-256。
- CSV 只接受已知列和冻结别名；公式前缀失败关闭。缺少 card ID 时生成确定性的行 ID，这只是 pre-GEN 字段映射候选，冻结前仍需产品/架构决定。
- `id/front/back` 仅作为冻结安全夹具的过渡兼容输入，不能据此推断最终 v1 会公开保留旧英语字段。

## SEC-001 夹具结果

| 夹具 | 纯解析 spike 结果 | 闭环状态 |
| --- | --- | --- |
| SEC-FIX-001 | 合法最小包接受 | 已执行 |
| SEC-FIX-002 | 声明 SHA-256 与文件身份不一致时拒绝 | 已执行 |
| SEC-FIX-003—010 | 未知字段、bidi、路径/外部资源声明、重复 ID、深层/畸形 JSON、CSV 公式均失败关闭 | 已执行 |
| SEC-FIX-011 | 25 MiB+1 byte 与 20,001 卡分别命中独立预算门 | 已执行 |
| SEC-FIX-012 | token 描述文件作为未知 schema 被拒绝 | parser 只证明不误接收；单次消费/TTL/重放仍未实现 |
| SEC-FIX-013 | 半安装描述文件作为未知 schema 被拒绝 | parser 只证明不误接收；staging/旧状态不变仍未实现 |

因此可以说“内容层 001—011 已由真实 Rust parser 执行”，不能说“13 项安装安全语义全部通过”或“SEC-001 全部完成”。

## 正式性能结果

报告：`src-tauri/target/learning-pack-spike/release/evidence/learning-pack-parse-spike-20260824T175724Z.json`

| 格式 / 卡数 | 样本 | 内部解析 P50 / P95 | 进程墙钟 P50 / P95 | 峰值 working set |
| --- | ---: | ---: | ---: | ---: |
| JSON / 4,533 | 10/10 | 36.591 / 37.329 ms | 55.892 / 65.718 ms | 16,760,832 bytes |
| CSV / 4,533 | 10/10 | 24.358 / 24.864 ms | 43.431 / 49.795 ms | 10,932,224 bytes |
| JSON / 20,000，26,020,105 bytes | 5/5 | 477.863 / 481.523 ms | 506.478 / 510.777 ms | 123,691,008 bytes |
| CSV / 20,000，26,120,061 bytes | 5/5 | 355.925 / 359.907 ms | 382.102 / 386.824 ms | 75,395,072 bytes |

预注册候选门为内部文件读取+解析 P95 ≤ 1,000 ms、进程墙钟 P95 ≤ 2,000 ms、峰值 working set ≤ 512 MiB。20,000 卡夹具还必须不少于 25,900,000 bytes，防止只满足卡数而不接近字节上限。每个样本必须证明 4 MiB/16,384 值/256 卡三种进度检查间隔、独立 16 KiB 解码输入取消间隔和独立 16 KiB 单卡取消间隔、阶段回调之和与总数一致、JSON 九阶段或 CSV 八阶段覆盖、回调总数不超过 256，以及最终 `complete/cards` 的已完成数和总数均等于卡数。正式 4,533 JSON/CSV 分别观测 38/31 次回调，20,000 JSON/CSV 分别为 147/124 次，两次增加内部取消粒度后 UI 进度回调数都没有增长。报告绑定 release binary、library/main source、crate manifest、测量脚本、Git 状态、设备和四个夹具 SHA-256；独立 verifier 会从原始 30 个样本重算分位数并拒绝过小的大夹具、陈旧绑定、伪造/缺失阶段、未知字段或零内存占位数据。

库级 25 项测试覆盖立即取消、普通文件读取进度/取消/文件类型/读取前超限、UTF-8 多字节字符跨 4 MiB 边界、边界畸形 UTF-8、JSON 八个字节处理阶段/CSV 七阶段逐阶段取消、任一取消都不返回部分包、按阶段与单位单调有界、带观察器与原兼容 API 的规范化结果完全一致、精确 16 KiB 解码/单卡探针和单张超长 JSON/CSV 卡在完成任何卡片前取消；还证明 JSON 在结构可见前取消、CSV 在任何卡片完成前取消、NFC 长组合序列不会先吞完整输入、NFC/NFKC 取消不返回部分规范化值、超长原始标识符可在 NFKC 内取消，以及 CSV 空白可选字段与列表分隔扫描可取消且 `scheduleEpoch` 保持既有可选/`u32` 语义。5 项安全集成测试继续覆盖 SEC-FIX-001—013 的既有边界。正式文件管线再增加独立 `reading_input` 阶段。这里的“无部分包”只指纯函数没有返回可用 `ParsedPack`，并非数据库取消零写入证据，因为本 crate 根本没有数据库或 staging 能力。

## 可复现命令

```powershell
npm.cmd run learning:pack-spike:test
npm.cmd run learning:pack-spike:boundary:verify
npm.cmd run learning:pack-spike:evidence:test
npm.cmd run learning:pack-spike:evidence:verify
```

只有显式授权重跑性能时才执行 `learning:pack-spike:gate`；重建或修改解析器、crate manifest、测量脚本后，现有正式报告必须视为陈旧并重跑。

## 对 GEN-000 的输入与剩余阻断

本 spike 支持继续评审 25 MiB/20,000 卡、JSON 深度 8、字段长度、稳定 ID 和 fail-closed 策略。GEN-000 仍不能冻结，至少还缺：

- 真实 Tauri 后台调度、IPC 进度和 UI 不冻结证据，以及操作系统阻塞在单次 ≤4 MiB 读取调用内的取消延迟和文件替换/token 身份语义；
- preview token 的文件绑定、TTL、单次消费与重放测试；
- staging、完整性检查、原子发布、失败/崩溃旧状态不变；
- 20,000 卡数据库搜索分页、导入/提交和 1,000 次答案后的 DB 增长；
- v6 完整迁移与恢复对账、5—8 人研究或具名延期，以及六类具名签字。

2 小时学习内存门已由 `learning-memory-20260819T111112Z.json` 关闭；该结果不减少以上真实导入、状态层安全、迁移、研究和签字要求。

在这些门关闭前，PACK-001 和阶段 1 继续保持 No-Go。

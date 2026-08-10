# Third-party notices

圆圆提醒使用了开源软件。各组件仍受其各自许可证约束；完整版本与许可证表达式以发布候选生成的 CycloneDX SBOM 和许可证清单为准，逐组件的许可证、版权、COPYING 与 NOTICE 原文收录在随安装包分发的 `THIRD_PARTY_LICENSES.txt`。

主要直接依赖包括：

- React、React DOM（MIT）
- Tauri 及官方插件（Apache-2.0 / MIT）
- TypeScript、Vite、Vitest（各项目许可证）
- chrono-node、uuid（各项目许可证）
- Rust 生态中的 chrono、rusqlite、serde、uuid（各项目许可证）

`THIRD_PARTY_LICENSES.txt` 由锁定的 Windows x64 正式依赖图确定性生成；开发专用依赖和圆圆自身工作区包不进入该归档。发布二进制文件前，维护者仍应检查新增依赖的许可证选择、署名、NOTICE、源码提供和商标义务。

## MPL-2.0 源码获取

当前 Windows x64 正式依赖图包含以下未修改的 MPL-2.0 crate。与发布版本精确对应的源码包可从 crates.io 获取：

- `cssparser-macros 0.6.1`：<https://crates.io/api/v1/crates/cssparser-macros/0.6.1/download>
- `cssparser 0.36.0`：<https://crates.io/api/v1/crates/cssparser/0.36.0/download>
- `dtoa-short 0.3.5`：<https://crates.io/api/v1/crates/dtoa-short/0.3.5/download>
- `option-ext 0.2.0`：<https://crates.io/api/v1/crates/option-ext/0.2.0/download>
- `selectors 0.36.1`：<https://crates.io/api/v1/crates/selectors/0.36.1/download>

版本和地址同时冻结在 `docs/release/THIRD_PARTY_LICENSE_POLICY_V1.json`，依赖变化会令许可归档验证失败并要求重新复核。

圆圆的角色图片、动画图集、图标与文档截图不适用 MIT 许可证，详见 [ASSETS_LICENSE.md](ASSETS_LICENSE.md)。

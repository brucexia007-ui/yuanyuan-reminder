# Third-party notices

圆圆提醒使用了开源软件。各组件仍受其各自许可证约束；完整版本、作者与许可证信息以 `package-lock.json` 和 `src-tauri/Cargo.lock` 中锁定的依赖为准。

主要直接依赖包括：

- React、React DOM（MIT）
- Tauri 及官方插件（Apache-2.0 / MIT）
- TypeScript、Vite、Vitest（各项目许可证）
- chrono-node、uuid（各项目许可证）
- Rust 生态中的 chrono、rusqlite、serde、uuid（各项目许可证）

发布二进制文件前，维护者应检查锁文件中新增依赖的许可证，避免引入与本项目分发方式不兼容的组件。

圆圆的角色图片、动画图集、图标与文档截图不适用 MIT 许可证，详见 [ASSETS_LICENSE.md](ASSETS_LICENSE.md)。

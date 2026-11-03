# Windows 客户端技术适配评估

日期：2026-11-03，修订 0.3。产品名为案卷（anjuan），首版仅支持同一 Windows 系统账号切换应用账号。Electron 壳保留，Windows 基础验证前置；本稿补明确推送后先确认 Phase 1/W0 计划，本轮未构建、安装或作原生 GUI 验收。

## 1. 已有基础和具体缺口

| 项目 | 已通过源码证实 | Windows 工作与验收要求 |
|---|---|---|
| 生命周期 | main.js fork 后端，随机端口、健康轮询 15 秒、单实例锁、非 mac 关窗退出 [A15] | 保留；验证启动失败、端口占用竞态、重复启动、升级前退出、异常退出后的孤儿进程 |
| 数据目录 | backend-env 将 DB、案件夹、agent-sessions 放入 config.dataDir，HOST 回环 [A15] | 保留路径注入；不得写安装目录；路径可写/空间检查、中文用户名、只读目录、长路径及磁盘不可用提示 |
| 初始化 | Electron onboarding 保存 user/passHash 与 dataDir [A15] | 改为选目录 + 服务端一次性管理员初始化；不继续以 config.passHash 作为长期登录权威 |
| 登录窗口 | BrowserWindow 加载本地服务网页，已有导航/关闭策略 [A15] | 可复用；验证 Cookie 生命周期、账号切换、logout 关闭 SSE、弹窗/下载和键盘操作 |
| 后端退出 | before-quit 调用 backendProc.kill；服务端监听 SIGTERM/SIGINT [A15、A18] | Windows 信号/子进程退出需实测；优先 IPC 正常关闭、等待 DB/文件动作结束，再仅清理本应用进程；不得结束任意 node.exe |
| 原生 SQLite | better-sqlite3；electron-rebuild [A01] | Node 与 Electron ABI 分开验证；Windows x64 原生包可用性、重建工具及打包后加载都要测 |
| 安装包 | dist 指定 --mac，只有 DMG 配置 [A01] | 新增 Windows x64 NSIS 方案、独立 appId/产品名/图标、用户级安装策略及包内容校验 |
| 打包钩子 | afterPack/afterSign 仅处理 darwin；跨架构依赖脚本专门补 darwin 两架构 [A16] | Windows 不调用 mac 专用步骤；AI 即使关闭也要检查包内静态导入和可选依赖，不得假定自动可用 |
| OCR | helper 用 swiftc/lipo、PDFKit/Vision，非 mac 会跳过编译 [A16] | 首版不扩展 OCR；保留已有文字层/普通文件能力；缺少 helper 的 extraResource 不可导致出包失败 |
| 更新 | updater 选择 DMG，在浏览器下载；源地址写死上游 [A17] | 必须绑定本派生项目仓库；Windows 更新下载、校验、进度、取消、失败重试和安装确认另行实现 |
| 文件安全 | realpath、独占创建、符号链接/身份核验等 [A11] | 增加 Windows 名称、NTFS ADS、junction/reparse points、大小写冲突测试；不能照搬 POSIX 权限假设 |
| 测试工具 | check.sh 有 108 个阶段，并包含 bash/curl 等 [A21] | 保留原测试；先修复 Windows 夹具路径，再按测试目的移植必要调用或在适用 runner 运行；不直接全部跳过 |

## 2. 原生窗口与会话

单实例锁与多个应用账号并不冲突：同一个壳可退出后切换账号。首版不承诺为每个用户同时打开独立桌面窗口；并发测试可用不同 Cookie 的受控 HTTP 客户端。本地端口不提供普通局域网入口，也不把随机端口当作认证秘密。

首次运行应展示数据目录与管理员创建步骤；启动错误提供可读原因和日志位置，避免只提示“启动失败”。日志需落在运行用户可写位置，不记录密钥或密码。后端尚未就绪时不创建可操作业务页；初始化失败保留可重试状态，不能留下半初始化管理员。

已有 `proc.on('exit')` 对启动 Promise 的拒绝不能代替运行中的故障处理：窗口打开后后端崩溃仍须显示断线状态，停止写操作，提供有控制的重启与诊断；不得静默重复启动多个后端。[A15]

## 3. 安装、升级和数据保护

建议首版 Windows 11 x64、用户级 NSIS 安装，不要求管理员权限。产品目录、数据目录、配置目录、日志和更新缓存分别管理，卸载默认保留案件数据；若将来提供清除数据操作，须单独明确确认。跨 Windows 用户共享服务不在默认设计内。

升级前停止新写入，等待事务/文件动作完成，保留版本配套备份；安装器检测运行实例，优先正常关闭，不能无提示强杀。迁移失败保留旧目录和旧安装器，禁止反复自动重跑不可逆迁移；旧程序不得直接打开新 schema。首版不新增通用移动数据目录工具；更换目录通过经过演练的备份恢复到新目录完成。

未经本项目真实签名验证，不能把 SHA-256 校验称为代码签名或发布者身份认证；签名证书获取/购买另行确认。更新器至少校验目标仓库/版本、唯一正确架构资产、文件大小和摘要，拒绝无效或不完整安装包。网络不可用时核心业务可继续。

## 4. 群聊拾遗三项参考映射（已获用户确认）

| 参考 | 已读取的实际实现 | 本项目吸收方式 |
|---|---|---|
| Windows 构建与安装 | build-test.yml 在 windows-latest 构建测试安装器；release.yml 有正式发布输入/版本及确认校验；安装包附 .sha256 [W01] | 独立测试构建与正式发布门；固定版本、包检查和数据保护标准；不直接复制 Tauri/Python/Rust 构建命令 |
| 更新体验 | updater.rs 的 resolve_release、copy_download、verify_hash、validate_verified_installer；progress 事件、取消和重试测试；AboutPage 下载失败清理与重下 [W02–W03] | 用 Electron 主进程维护状态和下载校验，preload 仅暴露窄接口；开始/进度/失败/取消/重试/安装确认具有清晰状态 |
| Release 展示 | releaseNotes.ts 解析说明，AboutPage 展示，release-notes-ui 和版本同步测试 [W03–W04] | 展示同版本 Release 原文，安全渲染链接和文本；README/CHANGELOG/PRD 支持范围及应用版本一致 |

这些结论是源码观察，未在本轮重新构建群聊拾遗或重跑其测试。参考流程不等于本项目已获得发布授权，也不默认继承对方的更新地址、品牌、安装目录或自动发布行为。

## 5. 前置 Windows 基础验证

在 Phase 0 文档另获提交推送授权并完成推送后，先提交 Phase 1（含 W0）详细实施及验收方案，等待用户确认，再执行 W0 技术检查：固定 Node/Electron 与锁文件，验证 Windows x64 better-sqlite3 分别在 Node 和 Electron 中加载、最小后端启动/退出、回环监听、基本数据目录和测试包资源清单。必要的临时构建配置放在隔离验证目录，不对外发布，不引入完整 Windows 功能改造。

发现仅 macOS 资源、钩子或原生依赖阻塞时，先报告最小修复及影响，经阶段范围确认后处理；不能让身份认证完成后才首次发现无法运行基础包。W0 不是正式安装/升级验收，完整窗口生命周期、NSIS、更新器、品牌替换和普通用户安装仍留在 Phase 3。W0 工时计入 Phase 1，从 Phase 3 相应扣除，不重复计算。

后续安装包名称与更新地址使用 anjuan，正式图标和品牌素材待补充；本轮不改 package.json、图标、Actions 或更新源码。首版不开发跨 Windows 用户共享服务。

## 6. Windows 检查的已知边界

主机 Node v24.19.0、win32/x64。8 个上游定向脚本中：密码哈希、启动配置、窗口关闭策略、提醒计划、北京时间处理通过；trust-proxy 缺少 Express 未运行到断言；backend-env 在 macOS 路径夹具的前缀断言失败；secure-files 在创建测试 symlink 时遇 EPERM。未修改断言、未提权改变系统策略。[T01]

名称纯函数另行验证：`CON/NUL/a:b/test./file:stream.pdf` 被接受，显示 Windows 名称策略存在适配缺口。探针没有写这些特殊文件，未据此推断目录越界已可利用。[T02]

Phase 3 必须补齐：真实 Windows 路径夹具、符号链接可测 runner + 普通用户 junction 用例、打包后 SQLite 加载、全新/覆盖安装、取消安装、升级回滚、单实例、后端崩溃、会话切换、附件预览下载及离线运行。浏览器自动化之外，还需用户确认原生窗口和安装器验收结果。

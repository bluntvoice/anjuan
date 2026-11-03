# 案齐与 LawLink 源码及架构对照报告

日期：2026-11-03，修订 0.2。证据编号参见[证据索引](证据索引.md)。本稿已纳入 D01–D10 确认结果，开发对象为案卷（anjuan）；实现与文档验收分别进行。

## 1. 基线及差异

案卷已确认采用案齐官方 v2.12.6 Release 对应提交为基线，不能用同名 ZIP 根目录后缀代替提交 SHA：`ca57d92…` 是 annotated tag 对象，实际提交为 `a22a84a…`。LawLink ZIP 的 `ff25a63…` 同样是标签对象，实际提交为 `5b814c9…`。Release、标签、commit 和对比结果已分别留存。[V01–V04]

| 项目 | 本轮读取版本 | main 差异 | 处理 |
|---|---|---|---|
| 案齐 | v2.12.6 | 高出 1 提交 `5a1c2d5…`；9 个文件，涉及日历/案件/今日页、API、样式及设计文档 | 不混入基线；未来评估选择性吸收 |
| LawLink | v2.0.0 GitHub Release | main 与 v2.0.1 标签相同；高出 2 提交、6 文件 | 业务参考固定 v2.0.0；不把 README 的 v2.0.1 等同于 GitHub Release |
| 群聊拾遗 | v1.2.3 | 相同 | 仅参考批准的三项发布体验 |

## 2. 技术结构

| 项目 | 案齐 | LawLink | 本项目处理 |
|---|---|---|---|
| 前端 | 原生 HTML/JS，`public/js/api.js` 同源 `/api` | Next.js/React、Server Actions、shadcn | 保留案齐 |
| 服务端 | Express 5，`server.js` 挂载多个 Router | NextAuth + Next.js server 层 | 认证和授权在 Express 重写 |
| 数据 | better-sqlite3，WAL、外键，SQL migrations 至 032 | PostgreSQL + Prisma | 保留 SQLite，不引入 Prisma |
| 桌面 | Electron 43，Node 后端子进程 | 未作为 Windows Electron 参考 | 复用案齐生命周期并验证 Windows |
| 用户 | env 单账号、SQLite sessions | User、角色、active、sessionVersion | 借鉴字段语义，复用案齐 scrypt |
| 文件 | 案件目录 + 相对路径附件记录 | 服务层存储及权限体系 | 保留案齐目录，增加一致性和权限边界 |
| 审计 | audit_log + change_log 触发器 | audit/auditStrict/auditTx | 优先扩展案齐，借鉴事务审计规则 |

依据：[A01–A07、A15、L01–L05]。

## 3. 能力核实与复用判定

分类：**已证实**指源码存在；**复用待测**指拟保留但未完成集成验收；**修改**指现有逻辑需调整；**新开发**指没有对应完整能力；**未来**指云端阶段。源码存在不等于运行通过。

| 能力 | 源码证据与现状 | 判定 |
|---|---|---|
| 案件登记、字段编辑、阶段 | cases Router，阶段变化铺设模板 tasks 并写 worklog | 已证实；复用待测 [A06] |
| 事件、期限、工作日志、待办 | records Router；事件变化触发确定性期限重算 | 已证实；复用待测 [A07、A08] |
| 确定性期限规则 | engine、deadline-core、rules JSON；节假日仅装载 verified 文件 | 已证实；规则业务及覆盖回归未跑 [A03、A08] |
| 日历、摘要、统计、收件箱 | views Router；收件箱 accept 会写正式业务表 | 已证实；授权需修改 [A09] |
| 案件文件列举/读取/上传 | files Router + secure-files；同名独占创建、路径真实位置校验 | 已证实；Windows 安全和授权需修改 [A10–A11] |
| 文件预览 | MIME/inline 文件流；UI 受格式支持限制 | 复用待测；不承诺所有 Office 文件原位渲染 [A10] |
| 附件解除引用 | `DELETE /attachments/:aid` 只解除引用，保留物理文件 | 首版复用并授权；本体删除及恢复暂缓 [A10] |
| 案件删除 | cases Router 没有 DELETE 路由 | 首版不开发软删除及对象恢复；沿用结案 [A06] |
| 精简律师费 | 已有金额、分单位、状态、备注和版本；费用接口同时依赖分账/结算 | 五项基本信息可复用部分，折扣与折后金额需补充；全部启用账号可读，管理员和编辑可改；复杂财务接口关闭 [A22] |
| 多账号 | sessions 没有 user_id；用户名和哈希来自 env | 需新开发 [A02–A04] |
| 真实操作人 | apiAuth/internalAuth 可从请求头取 actor | 需修改；不满足真实账号留痕 [A02] |
| 角色权限/停用撤销 | 案齐无独立角色/账号状态；只有登录门 | 需新开发 [A02–A04] |
| 修改追溯 | change_log 保存旧/新快照，有不可更新/删除触发器 | 可复用；需不可变用户 ID、覆盖核对 [A05] |
| 并发防覆盖 | 提醒有 expected_version；普通案件 PATCH 按 id 更新 | 部分已证实；不能把变更日志当成乐观锁 [A06、A12] |
| 提醒调度 | worker 定期 tick、去重、missed 状态；缺省追赶 60 分钟 | 可复用；账号投递/已读和长停机补扫需修改 [A12–A13] |
| 备份恢复 | backup.cjs 在线备份 DB + secret.key，输出目录固定 `/app/data/backup` | DB API 可复用；Windows 统一备份恢复需新开发 [A14] |
| Windows 安装更新 | dist 仅 `--mac`，更新器下载 DMG | Windows 实现需新开发/适配 [A01、A15–A17] |
| 远程 API、网页跨设备、常驻提醒 | 同源 HTTP 有基础，尚无完整迁移/远程产品流程 | 仅未来，不在首版实现 [A01、A18] |

## 4. LawLink 逐项借鉴结论

| 研究对象 | 查到的设计 | 直接借鉴 | 独立代码移植 | 案齐所需实现与应排除内容 |
|---|---|---|---|---|
| 用户模型 | User ID、passwordHash、active、sessionVersion；系统身份与业务岗位分开 | 稳定 ID、停用、会话版本 | 本轮不复制 | SQLite users；排除团队、岗位范围与证件资料 [L01] |
| 密码登录 | Credentials Provider + bcryptjs，失败计数、锁定等 | 统一错误、限速、停用判断 | 不移植 NextAuth 配置 | 保留已验证的 scrypt 格式，避免双密码算法 [L02、A04] |
| 会话撤销 | JWT callback 每次核对 active/sessionVersion | 改密/停用/角色变更使旧会话失效 | 只借鉴测试思路 | 案齐数据库 Session 直接删除并校验用户状态 [L02–L03] |
| 权限 | catalog、requireSession、assertCanReadMatter 等服务层函数 | 集中权限键、后端强制检查 | 不复制 Prisma 查询 | 所有启用账号看全部案件；排除 OWN/TEAM/ALL 范围体系 [L03–L04] |
| 人员/角色后台 | users/actions、roles 服务及 admin 页面 | 阻止停用最后管理员、并发期望值、操作回执 | React 页面不能原样用于原生 JS | 小型用户列表/角色分配页，先固定三角色 [L05–L06] |
| 审计 | 普通 audit 吞错；auditTx 与业务同事务，auditStrict 用于敏感读取 | 修改必须随审计一起提交 | 类型和 Prisma 依赖使直接搬运收益低 | 本项目所有业务修改用事务审计，不能照搬吞错策略 [L07] |

LawLink 有参考价值，但其源码也不能直接证明本项目多用户并发、安装恢复和全部权限已通过。仅存在测试文件不算本轮执行证据。[L08]

## 5. 许可证、来源及标识

案齐 `package.json` 明确 `AGPL-3.0-only`，根 LICENSE 为 GNU AGPL v3；GitHub API 的 `AGPL-3.0` 检测结果没有否定 package 的 only 声明。LawLink package 与 LICENSE 为 MIT，版权行应按其原文保留。[A01、A19、L09]

Fork 和修改可以进行；修改案齐时须保留适用版权与许可证，标示修改及日期，派生程序依 AGPL 相应条款提供。若实际复制 LawLink 的代码或实质片段，应在文件或第三方声明中保留 MIT 版权及许可全文；本轮仅作设计研究，没有把 LawLink 业务代码复制进正式产品。MIT 部分的原许可声明保留，整合后的案齐派生程序仍需满足 AGPL。

对外提供 Windows 安装包时，建议同时提供与二进制版本严格对应的完整 Corresponding Source 下载入口，包含修改、构建及安装所需脚本、锁文件和许可文件；只指向未修改的上游或“最新 main”不够。具体交付方式须符合 AGPL 第 6 条。源码提供不包括真实案件数据库、文件、密码或 Token。[A19、S01]

同一法律实体内部复制与向外提供副本应分别判断；不能将内部使用直接等同于必须向全球公开。未来把修改版用于公司内网远程交互时，也不能仅凭“内网”排除 AGPL 第 13 条：应向实际远程交互用户显著提供该版本对应源码的免费取得机会。不同法人、外部律师或客户接收副本时应重新核对传播场景。这里建议按用户范围提供源码，不预设必须将业务系统和案件数据公开到公共 GitHub。[S01–S02]

案齐 LEGAL-NOTICE 和 ACKNOWLEDGEMENTS 明确源代码许可不当然授予“案齐/ANQI”、图标及来源标识的商标权。派生项目名称已确定为“案卷（anjuan）”，Fork 目标为 bluntvoice/anjuan；正式图标及其他品牌素材待补充，后续采用独立 appId 和本项目更新地址，在关于页注明“基于案齐”及上游版本，保留法定声明，不暗示官方背书。本轮不更改业务 package 或图标。LawLink 的 MIT 不代表全部品牌权利授权。[A19、L09]

许可条款核对依据为固定版本原文及 FSF 原文/FAQ。此处为本项目交付义务设计，不对具体发行对象和法人结构作未获事实支持的判断。

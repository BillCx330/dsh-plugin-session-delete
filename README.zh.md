# dsh-plugin-session-delete

[![awesome · DSH plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DeepSeek Harness plugin](https://img.shields.io/badge/dsh-plugin-8b5cf6.svg)](https://github.com/deepseek-ai/deepseek-harness)

[English](README.md) | 中文

在会话列表的「⋯」更多菜单**末尾**添加一个 **删除会话** 选项；选项的文字与垃圾桶图标都使用 DSH 自带的危险色（红色），点击后弹出确认框，确认即**从磁盘上永久删除**该会话。

```sh
dsh plugin --profile web add github:BillCx330/dsh-plugin-session-delete
```

---

## 它做了什么

| 位置 | 内容 |
|---|---|
| 槽位 | `sidebar.workspaces.session.menu.item` |
| 行 id | `session-delete` |
| 顺序 | `order: 500` — 排在官方 `pin`(100)、`rename`(200)、`fork`(300)、`archive`(400) **之后**，即菜单最下方 |
| 分组 | `separatorBefore` — 与官方行一样带分隔细线，自成一组 |
| 配色 | `MenuItemButton` 的 `danger` 属性 → 文字与图标同为 `--dsw-alias-state-error-primary`（红色），悬停底色为 `--dsw-alias-interactive-bg-hover-danger` |
| 图标 | `IconTrashOutlineRegular` |
| 确认框 | `shell.overlay` 中的 `Modal`，确认按钮沿用官方的 `--dsw-alias-state-error-primary` 红色 |

**和原风格一致**：菜单行直接复用 `ui-primitives` 的 `MenuItemButton`，几何尺寸、悬停填充、焦点环、键盘遍历与选中后焦点返回全部由官方组件提供，本插件没有重新实现任何外观；红色也不是自定义色值，而是 DSH 自己的危险语义色。

## 为什么需要插件

DSH 目前**没有**会话删除能力，这是官方明示的限制：

> **No Session deletion** — sessions can be archived but never deleted.
> —— `@deepseek-ai/dsh-client-ui-workspace` README

Host 侧也没有删除动词：`sessionPersistence` 只有 `create` / `open` / `flush` / `stat` / `list`，`sessionQuery` 只有读取类方法。因此本插件把删除实现为一次有序的组合操作。

## 删除是如何完成的

Host 半部按以下顺序执行：

1. **读取存档头** — `sessionPersistence.stat(sessionId)`；不存在返回 `not-found`。
2. **拒绝仍在使用中的会话** —— 两道独立护栏，都按"拿不准就拒绝"处理：
   - *已打开*（存在于 `sessions` / `agents`）→ `live`。已打开的会话必须拒绝而非硬删：追加写入器仍持有该文件（Windows 上打开中的文件根本无法删除），循环还会继续往已消失的目录提交事件。
   - *仍有活动*（由 DSH 自带的 `workspace/session-activity` 探针报告 —— 进行中的 turn、运行中的子代理、后台任务、定时提醒）→ `running`。这正是归档流程在拒绝之前问的同一个只读探针，因此删除不会把后台任务变成孤儿，也不会留下还在往一个已消失会话投递的定时提醒。

   先归档或切走，再删除。
3. **删除持久化产物** — 由持久化后端自己给出路径（`locate(header)`），删除该会话目录（含各代 `session.vN.jsonl.zst`）。后端没有 `locate` 时，回退为在配置根目录下两层内查找**目录名恰好等于会话 id** 的目录。
   **产物先删，其余步骤在确认它真的消失之后才动。** 这样后续每一步都只是"已经发生的删除"的收尾，失败也不会留下半删状态。
4. **然后是尽力而为的收尾** —— 已经发生的删除，绝不因为收尾出错而变成失败响应：请求报错正是"客户端继续抱着一个已删会话的幽灵行"的成因。收尾问题在响应里以 `cleanupWarnings` 报告：
   - **释放工作区账户位置** — `unpinSession`、`unarchiveSession`，再对包含它的 `Workspace` 调用 `detachSession`，把会话从 `workspace.json` 的账目里真正移除。
   - **清掉投影缓存行** — 通过拥有它的存储域删除，而不是绕过域直接删文件，这样内存表与磁盘文件保持一致：`storageDomain.get('session_projcache').table('sessions').delete(id)`。
   - **广播移除事件** — `ctx.emit('api-session/removed', sessionId)`，**无论前两项结果如何都一定会发**。

### 为什么必须广播移除事件

客户端侧栏的列表只从 `api-session/added` 事件**增长**，其余情况只在重连时整表刷新（`handleConnected` → `refreshList`）。所以主机删掉会话后，客户端会继续显示一行"打不开的会话"。

而"未分组"的推导是 `list.ids.filter(id => !accounted.has(id))` —— 即**列表里有、但没有任何工作区记账**的会话。于是释放工作区账户位置恰好会把幽灵行从工作区分组推进"未分组"，点开就报 `session/not-found`。

`api-session/removed` 正是 DSH 自己用于此场景的信号：`api-session-controller` 在会话被销毁时发出它，`api-remotes` 转发它（它在该包的转发允许清单内），客户端的 `session-controller` 收到后把该行从列表里移除。因此广播它让行**立即**消失，无需刷新页面。

> 如果你的侧栏里还残留着 1.0.0 版本删除过的会话（宿主早已无此会话），**刷新一次页面**即可清空：重连触发的全量刷新会丢弃基线中不存在的身份（`mergeOrderedBaseline`：*identities absent from the baseline are removed*）。

### 安全护栏

不可逆操作只此一处，因此删除前会显式证明目标合法，任一条不满足都**只报告、不删除**：

- 路径必须是绝对路径；
- 最后一段必须**恰好**等于所请求的会话 id；
- 必须严格位于持久化根目录之内；
- 必须是真实目录 —— 该路径上是符号链接或 junction 时**拒绝**而不是删链接，因为"一个链接"并不能证明它背后的东西属于这个会话（递归删除同样不会跟着链接进去：这两种情况都是实测确认的，不是假设）；
- 在不可逆那一步之前**立刻重新检查一次**活动状态，封掉"首次检查之后会话才变成活动"的窗口。

护栏拒绝时返回失败且**不改动任何其他状态**：工作区账目、投影缓存、客户端列表都保持原样。

路由本身也拒绝含 `/`、`\` 或 NUL 的会话 id。

### 删除后还剩下什么

`session-query-sqlite` 的全文索引里会短暂留有该会话的行，但它对用户不可见：会话控制器的主机侧搜索先用 `sessionQuery.listSessions()`（直接读 `sessionPersistence.list()`）算出可见 id 集合，再据此过滤搜索结果；索引本身也会在下一次搜索时对账（`persistentDeletes`）把行删掉。

## 文件

```
dsh-plugin-session-delete/
├── package.json          # dsh.bundle.patch + dsh.client（含 inject / platform）
├── cordis.patch.yml      # 把本包自己的 Host 半部插入 loader 行
├── icon.svg
├── lib/
│   ├── index.js          # Host 半部：/api/session.delete 路由与存储清理
│   ├── client.js         # Client 半部：Module Loader 包（菜单行 + 确认框）
│   └── types/            # d.ts
└── test/
    ├── host.test.mjs     # 真实 fs 的删除行为、各拒绝路径、路径护栏
    └── client.test.mjs   # 模块注册形状、槽位声明、红色属性、Host 调用
```

## 安装

四种方式任选其一，最后一步都一样：**重启 DSH，再刷新页面**。

**插件市场**（推荐）——「设置 → 插件」里搜索 *session-delete*，点安装。

**命令行** —— 对你实际使用的 profile 一条命令：

```sh
dsh plugin --profile web add github:BillCx330/dsh-plugin-session-delete
```

**Release 压缩包** —— 从最新 Release 下载 `dsh-plugin-session-delete-<version>.tgz`，把文件路径交给 `dsh plugin add`。

**本地目录** —— 开发时，或想在发布前先试用改动：

```sh
dsh plugin --profile web add ./dsh-plugin-session-delete
```

本包声明了 `dsh.bundle`，所以 `dsh plugin add` 会自动把它写进 `dsh.profile.bundles`，**不需要手工编辑 bundle 列表**。包内直接带了预构建的 `lib/` 产物，且不声明任何生命周期脚本，因此以上任何一条路都不会执行构建脚本，也**不需要**用户给 `allowBuilds` 授权。

## 测试

```powershell
node test/manifest.test.mjs
node test/host.test.mjs
node test/client.test.mjs
# 或
pnpm test
```

测试在临时目录里建假的会话存储，**不会**触碰 `~/.dsh` 下的真实会话。覆盖：清单契约、真实 `fs` 删除、扫描回退、逐一拒绝路径、路径护栏，以及"删除成功才广播移除事件 / 护栏拒绝则什么都不改"。

## 模型影响（Model Experience）

没有。本插件只是浏览器侧的一行菜单，加上一条删除存储的 Host 路由；不贡献任何 tool、prompt 章节，也没有任何面向模型的接口。

#### 模型看到什么

什么都看不到。不注册 tool，也不组装或修改 prompt。

#### Token 影响

无。本插件从不自行发起 provider 请求。

#### KV Cache 影响

无。它不向任何会话历史追加内容 —— 删除会话是移除一份日志，而不是改写一份。

## 已知边界与延期工作（Known Limitations and Deferred Work）

以下是本插件当前的约束，不是待办清单。

- **仍在使用中的会话会被拒绝删除** —— 已打开的，以及仍有活动的（turn、子代理、后台任务、定时提醒）都算；需先归档或切走。
- **不递归删除子会话 / 派生会话**：只删除所选会话自己的产物，其 `parentSession` 血缘与子会话保持原样。
- **产物路径上是符号链接或 junction 时拒绝删除**，既不跟随也不删链接。
- **删除后的收尾是尽力而为**：失败会在 `cleanupWarnings` 里报告，删除本身依然成立。
- **附件会保留**：图片 / 文件是内容寻址且可能被其他会话共享，因此不随会话删除。
- **删除不可撤销**；本插件正是通过确认框来承担这一点。

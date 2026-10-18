# dsh-plugin-session-delete

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

1. **读取存档头** — `sessionPersistence.stat(sessionId)`。若无任何存档，说明会话**已经不在了**：请求依然成功，并把收尾做完（见「已不在的会话依然可以删掉」）。
2. **拒绝仍有未完成活动的会话** —— 由 DSH 自带的 `workspace/session-activity` 探针报告（进行中的 turn、运行中的子代理、后台任务、定时提醒）→ `running`。这正是归档流程在拒绝之前问的同一个只读探针，因此删除不会把后台任务变成孤儿，也不会留下还在往一个已消失会话投递的定时提醒。这是**唯一**的拒绝理由，而它跑在一切驱逐/删除**之前**，所以拒绝不会改动任何状态；删除过程中才开始的 turn 同样返回 `409 running`。

   探针**报错**时请求直接失败，而不会被当成"空闲"（`archiveSession` 同样不吞这个 waterfall 的错误）。删除不可逆，"答不上来"不能当作许可：fail-closed 的代价是一次可重试的 `failed`，fail-open 的代价是删掉一个正在写入的会话。

   若探针报出活动，先停掉它再删。
3. **把会话从 live 存储里驱逐** —— `sessions.liveEntryFor(live)` → `sessions.detachEntered(entry)`，再 `sessionPersistence.flush()`。这一步才让删除**真正成立**：`ApiSessionList.list()` 是 live 与已持久化会话的并集，留在 store 里的会话会在下次列表重建时带着"没有日志"的躯壳回来；detach 还会发出 `session/disposed` → `api-session/removed`，让所有客户端的行立刻消失。见「live 会话会先被驱逐,再删除」。
4. **删除持久化产物** — 由持久化后端自己给出路径（`locate(header)`），删除该会话目录（含各代 `session.vN.jsonl.zst`）。后端没有 `locate` 时，回退为在配置根目录下两层内查找**目录名恰好等于会话 id** 的目录。
   **产物先删，其余步骤在确认它真的消失之后才动。** 这样后续每一步都只是"已经发生的删除"的收尾，失败也不会留下半删状态。
5. **然后是尽力而为的收尾** —— 已经发生的删除，绝不因为收尾出错而变成失败响应：请求报错正是"客户端继续抱着一个已删会话的幽灵行"的成因。收尾问题在响应里以 `cleanupWarnings` 报告：
   - **释放工作区账户位置** — `unpinSession`、`unarchiveSession`，再对每个 `Workspace` **无条件**调用 `detachSession`，把会话从 `workspace.json` 的账目里真正移除。（`Workspace.sessionIds` 是建立在**内存索引**之上的**过滤后 getter**，所以它只决定响应里报告什么，绝不决定要不要释放；`detachSession` 本身是幂等的。）
   - **删除子代理会话** —— 见下方「子代理随父会话一起删除」。
   - **清掉投影缓存行** — 通过拥有它的存储域删除，而不是绕过域直接删文件，这样内存表与磁盘文件保持一致：`storageDomain.get('session_projcache').table('sessions').delete(id)`。`cacheRowDropped` 报告的是这张表给出的真实结果，因此"行本来就不存在"不会被误报成"已删除"。
   - **删除绑定到它的定时提醒** — 定时任务是按会话 key 持久化的行，所以会遍历 `schedule.catalog()`，把 `sessionId` 等于被删会话的任务通过服务自己的 `delete({ id, sessionId })` 删除（不匹配的 owner 会被服务拒绝）。结果以 `scheduledTasksRemoved` 报告；删不掉的任务变成 `cleanupWarning`。没有挂载（实验性）schedule bundle 时无事可做。
   - **广播移除事件** — `ctx.emit('api-session/removed', sessionId)`，**无论其余步骤结果如何都一定会发**。

### 子代理随父会话一起删除

子代理会话是唯一**不能**留在原地的子会话。fork 分支是 `structuredClone` 出来的副本，会成为独立的普通会话；而子代理会话保留了一个 `parentSession`，它被当作**鉴权凭据** —— 访问必须用「父 + 子」双地址，父会话一旦不存在，子会话就永久无法访问（`subagent/unauthorized`）。而它又被 `origin: 'subagent'` 隐藏在侧栏之外，于是变成一个**看不见、打不开、也删不掉**的孤儿。

它们在磁盘上还是**平级目录**而不是嵌套的（`sessionDir` 是 `<root>/<项目>/<id>/`，既不看 `origin` 也不看 `parentSession`），所以删父会话目录根本碰不到它们。

因此删除时**扫描语料里所有 `parentSession`**（`sessionQuery.listSessions()`）来找整棵子树，而不是从父会话 `traceSession`：后者在语料里找不到目标时会抛错，而"父已不在"恰恰就是子会话被遗留的那种情况（包括早期版本插件自己制造的孤儿）。遍历是 BFS、带环保护，且**父已不在的路径同样会级联**。DSH 自己的导出也是把这棵树当作一个会话（`includeDescendants`，打包成 `subagents/<id>/…`），所以这正是"删除这个会话"在 DSH 语义下的含义。

如果**语料读不出来**，产物还在的路径会**直接中止**（一个未知的子会话集合绝不能变成"先删父、听天由命"）；已不在的路径则把它记为 `cleanupWarning`，因为陈旧的侧栏行仍然必须能被清掉。

每个子会话都用**它自己的存档头**来删 —— 也就是 trace 交出来的那个带头 `cwd` 的 header。这一点很关键：JSONL 后端是按 `header.cwd` 给产物命名的（`logPath(root, meta.cwd, meta.id)`），所以合成一个 `{ id }` 会解析到后端的 `_no-cwd` 项目，把删除指向一个并不存在的目录 —— 真正的子会话留在磁盘上，而响应却说已经删掉了。每个子会话还会在真正动手前**再检查一次自己的活动状态**，因为 trace 是在删父产物之前就拿好的。

**fork 分支刻意不动** —— 它们是独立副本，删掉父会话后完好无损，会在侧栏升为独立的一行。确认框会在动手之前把两件事都写清楚：会一并删除多少个子代理，以及分支出去的对话会保留。

每个子代理的删除都是尽力而为并单独报告：某一个失败，既不会中断父会话的删除，也不会影响其余子代理，而且报告会说明**原因**（自己探针报出活动的子会话会以 `running` 被拒）。失败会在对话框里显示，而不只是写日志 —— 于是"没有完全删干净"永远不会被包装成"删干净了"。

### live 会话会先被驱逐，再删除

Host 会把进入过的会话放在 live store 里，而 `ApiSessionList.list()` 是 live 与已持久化会话的并集。留着它删掉产物，就会得到"行会回来、但背后没有日志、写入还会失败"的状态。所以插件先把会话驱逐出去：

- `sessions.liveEntryFor(live)` → `sessions.detachEntered(entry)` 把它从 store 移除，并发出 `session/disposed`，会话控制器把它转发成 `api-session/removed` —— 所有客户端的行都会消失；
- `sessionPersistence.flush()` 冲刷当前所有活动的写句柄，避免一次迟到的 flush 在目录删除后把日志重新写出来；
- 然后才删产物；此时会话已不在 `list()` 并集的两个来源里，行不会再回来。

顺序是硬的：**活动探针 → 驱逐 → 删除**。一个 409 不允许已经驱逐过任何东西，一个正在跑的 turn 也绝不允许被 detach。因此 `detachLiveSession` 在探针之后还会复查 `agents.get(id)?.status`，running 就拒绝。

插件**做不到**的是拆掉持有被驱逐会话的那个 agent —— DSH 没有公开的 dispose 动词，只有上面这个 entry 驱逐。一个"会话已不再发布"的空闲 agent 是不可见的，会随其 fiber 回收。响应里的 `liveDetached` 说明驱逐是否发生；如果某些组合根本没提供驱逐原语，则用 `liveInMemory` / `liveSource` 说明 Host 仍持有什么。

早期版本分别"拒绝 live"（1.2.0）和"只报告 live"（1.2.1–1.2.2）。拒绝看起来诚实，但在真实部署里 live store 可能对**用户能看到的每一个会话**都有回答，于是等价于"拒绝一切"；只报告则留下会回来的行。三种做法里只有驱逐是真正删掉的。

### 已不在的会话依然可以删掉

侧栏的行有可能比它的会话存储活得更久。工作区注册表在启动时索引**已持久化**的 header，而 live 会话只有走 `attachSession` 才会被索引 —— 所以一个"live 但未持久化"的会话会被列出来，却**没有任何工作区认领它**，于是落进**未分组**，而 `persistence.stat` 对它无从查找。

在修复之前，删除这样的行永远失败（1.0.0 版本回的是 `not-found`，本版本已不再发布这个码）：界面上唯一能移除它的操作永远失败，于是这一行就成了死胡同。

现在删除是**幂等**的。当没有任何存档时，请求返回成功并执行同一套收尾 —— 释放工作区账户位置、清掉投影缓存行、广播移除事件 —— 而这正是让那一行消失的动作。响应里带 `alreadyGone: true`，以及 `liveInMemory` 标明该会话是否仍被 live 存储持有。

`liveInMemory: true` 值得留意：`listSessions` 是 live 会话与已持久化会话的并集，所以一个仍在内存里的会话**可能在重连后再次出现**，即使它的行已被移除。重启 DSH 可以清掉这样的持有者。`liveInMemory: false` 则说明那一行只是陈旧缓存，删掉即永久消失。

这条路径即使面对 live 会话也仍然返回成功 —— 请求遇到的是一个存储已经不在的会话，此时拒绝只会留下一个任何操作都清不掉的行。改为在删除后由对话框把 `liveInMemory` 报出来，于是"这一行下次刷新会回来"是被明确告知的，而不是被撞见的。

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
- 在不可逆那一步之前**立刻重新检查一次**活动状态，父会话本身和每一个子代理都各自复查。

  会话在这之前就已经从 live store 里被驱逐了，所以"删到一半被浏览器打开/恢复"由驱逐兜住，而不是靠竞态运气。剩下的是最后探针与 `rm` 之间的普通 TOCTOU：这个窗口里开始的 turn 会让对应子会话被拒；父会话的产物此时可能已经删掉，所以拒绝消息会点名真正的障碍（`running`、`guard`、`missing`…）。

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
    ├── manifest.test.mjs   # Host 与 Loader 实际执行的包契约规则
    ├── vocabulary.test.mjs # 五处失败码与 locale 键必须完全一致
    ├── host.test.mjs       # 真实 fs 的删除行为、各拒绝路径、路径护栏
    └── client.test.mjs     # 模块注册形状、槽位声明、红色属性、Host 调用
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
node test/vocabulary.test.mjs
node test/host.test.mjs
node test/client.test.mjs
# 或
pnpm test
```

测试在临时目录里建假的会话存储，**不会**触碰 `~/.dsh` 下的真实会话。覆盖：清单契约、五处失败码/locale 键的一致性、真实 `fs` 删除、扫描回退、逐一拒绝路径、路径护栏，以及"删除成功才广播移除事件 / 护栏拒绝则什么都不改"。

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

- **仍有未完成活动的会话会被拒绝删除**（turn、子代理、后台任务、定时提醒），先停掉再删。
- **Host 持有的 live 会话会先被驱逐、再删除**：`liveDetached` 说明驱逐是否发生。没有驱逐原语的组合仍会照删，并用 `liveInMemory` / `liveSource` 说明下次列表重建可能带回来什么。
- **子代理会话随父会话一起删除**；fork 分支不删 —— 它们是独立副本，会保留下来。两者都会在确认框里写明。
- **不完整的结果不会被包装成完整**：子代理删不掉或收尾失败时，对话框会留在原地并说明是哪一项。
- **产物路径上是符号链接或 junction 时拒绝删除**，既不跟随也不删链接。
- **删除后的收尾是尽力而为**：失败会在 `cleanupWarnings` 里报告，删除本身依然成立。
- **活动探针报错时请求直接失败**（fail-closed），不会被当作"空闲"；重试是安全的。
- **附件会保留**：图片 / 文件是内容寻址且可能被其他会话共享，因此不随会话删除。
- **删除不可撤销**；本插件正是通过确认框来承担这一点。

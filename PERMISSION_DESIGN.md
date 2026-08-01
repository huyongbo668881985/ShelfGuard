# ShelfGuard 权限与账号管理设计方案

> **实施状态（2026-08-01 更新）**：Phase 0 与 Phase 1 **已落地**（代码已改完，见下方改动清单）。
> 本文件作为设计与决策记录保留。
>
> 已采纳的决策：
> - **manager 不可改系统设置**（仅 `admin` 可改）——与文档建议一致。
> - **首管理员激活采用激活码方案**（云函数环境变量 `ADMIN_SETUP_CODE`），已删除"无管理员则任何人可写"的自举漏洞。
> - **账号准入（白名单）暂不做**——当前按"谁装了 App 谁就能用"处理，待确认小程序是否对外发布后再定。
> - **Phase 1 管理后台已完成**：`pages/admin/admin` 页 + `users` 云函数；巡检提交已收口进 `submitInspection` 云函数。

> 所有结论均基于真实代码（`login` / `settings` / `getHistory` / `analyzeImage` / `getReport` 云函数、`upload.js` 客户端）。

---

## 1. 现状（基于真实代码）

### 1.1 已经做对的部分

- **身份 = 微信 openid**：`login` 云函数取 `wxContext.OPENID`，首次使用自动在 `users` 集合建一条 `role: 'sales'` 的记录。无需用户名/密码，对销售团队是最优解。
- **服务端角色强制隔离**：`getHistory.getCallerRole(openid)` 永远从 `users` 表按 openid 查角色，**不信任客户端传的任何角色声明**；sales 强制只返回自己的记录，admin/manager 可看全员。这是扎实的安全底子。
- **写操作权限收敛**：`settings.canManage(openid)` 只允许 `admin`/`manager` 改系统配置；`role` 字段不在 `login` 的 `UPDATABLE_FIELDS` 白名单里，客户端无法自己提权。
- **API Key 不泄露**：`settings` 只回掩码，`dashscopeApiKey` 明文只在 `analyzeImage` 服务端读取。

### 1.2 真实缺口

1. **管理员没有正规产生路径**：默认系统里一个管理员都没有；要么你手动去云开发控制台把 `users.role` 改成 `'admin'`，要么靠下面的自举漏洞。
2. **自举漏洞（安全隐患）**：`settings.canManage()` 有一条——"若 `users` 中不存在任何 `admin`/`manager`，则**任何人**都可管理"。这意味着：在小程序能被外人打开的前提下，**第一个随便什么人进来就能改系统配置、写入你的 DashScope API Key**。
3. **无账号生命周期管理**：没有"停用/禁用"概念，离职员工的微信只要还装着 App 就能继续建记录，历史记录也无法交接。
4. **无后台管理界面**：想管用户、看全量数据，只能进云开发控制台裸看数据库，非技术管理者玩不转。

---

## 2. 设计原则

- **不另造用户名/密码登录**。微信 openid 即身份，免注册、免密重置。要做的是"授权管理"而非"认证系统"。
- **授权集中收敛到服务端**：所有权限判断只在云函数里做，客户端只负责"能不能看到入口"，绝不能作为安全边界。
- **渐进式、可回退**：先堵最大的安全洞（Phase 0），再做管理后台（Phase 1），Web 后台按需（Phase 2）。
- **默认最小权限**：新用户一律 `sales`，看不到他人数据、改不了配置。

---

## 3. 角色矩阵（建议版）

| 能力 | sales（业务员） | manager（管理者） | admin（管理员） |
|------|:---:|:---:|:---:|
| 拍照并提交巡检 | ✅ | ✅ | ✅ |
| 管理自己的客户库 | ✅ | ✅ | ✅ |
| 查看/编辑自己的资料 | ✅ | ✅ | ✅ |
| 查看自己的记录与报告 | ✅ | ✅ | ✅ |
| 查看全员记录 + 汇总统计 | ❌ | ✅ | ✅ |
| 按业务员筛选 | ❌ | ✅ | ✅ |
| 查看分析队列/统计 | ❌（仅自己） | ✅ | ✅ |
| 修改系统设置（模式/时间/API Key） | ❌ | **❌（建议）** | ✅ |
| 管理用户（升/降/停用） | ❌ | ❌ | ✅ |
| 激活首管理员（一次性） | ❌ | ❌ | ✅ |

> ⚠️ **与现状的差异**：当前代码里 `manager` 和 `admin` 都被放进 `MANAGER_ROLES`，**都能改系统设置**。本方案建议把二者拆开——`manager` 只拥有"看全员 + 管理视图"，`admin` 才拥有"改设置 + 管人"。是否采纳见第 12 节待拍板点 1。

---

## 4. 身份模型：微信 openid 即登录

- 不做独立登录页。`app.js` 的 `login()` 已在 onLaunch 调用 `login` 云函数拿到 openid，全应用共用。
- 用户的"账号"就是 `users` 集合里 `_openid` 对应的那条记录。后续所有权限判断都基于这条记录的 `role` / `disabled` 字段。

---

## 5. 首管理员激活流程（Phase 0 核心，堵自举漏洞）

### 5.1 问题

当前"无管理员则任何人可管理" = 把系统最高权限交给了"第一个打开 App 的陌生人"。必须关掉。

### 5.2 推荐方案：激活码

- 部署时在云函数环境变量设 `ADMIN_SETUP_CODE`（只有你知道的字符串，如 `SG-SETUP-8848`）。
- 新增云函数 `activateAdmin({ code })`（可并入 `settings` 或独立 `users` 云函数），逻辑：
  1. 若 `users` 中已存在 `role in ['admin','manager']` 的记录 → 返回"已有管理员，请联系管理员操作"。
  2. 若 `code === process.env.ADMIN_SETUP_CODE` → 把当前 openid 的 `users.role` 置 `'admin'`，并记录 `promotedAt`、`promotedBy: 'self-setup'`。
  3. 否则 → 拒绝（"激活码错误"）。
- 小程序入口：「分析设置」页（或非管理员能看到的一个轻量入口）放一个"激活管理员"输入框，调 `activateAdmin`。
- **`canManage()` 同步改造**：删除"无管理员则任何人可管理"的自举分支，改为"仅 `role in ['admin','manager']` 可管理"。因为首管理员只能靠激活码产生，漏洞彻底关闭。

### 5.3 备选方案：openid 环境变量（更严格）

- 部署时把你自己 openid 填进环境变量 `INITIAL_ADMIN_OPENID`，云函数启动即把该 openid 对应的 `users` 记录升为 `admin`。
- 优点：无共享秘密，最安全。缺点：你得先拿到自己的 openid（可在 `login` 返回里看到），对非技术部署者略麻烦。
- **本方案推荐 5.2 激活码**（易用且足够安全）。

---

## 6. 账号生命周期

### 6.1 创建（已有）

首次打开 App → `login` 自动建 `users`（`role: 'sales'`）。保留。

### 6.2 升/降级

- 由 `admin` 通过管理后台（Phase 1）调用 `setRole({ targetOpenid, role })` 完成。
- 记录到审计集合 `roleChanges`：`{ byOpenid, targetOpenid, from, to, at }`。

### 6.3 停用 / 启用（Phase 0 新增）

`users` 新增字段：
- `disabled: boolean`（默认 `false`）
- `disabledAt: Date`
- `disabledBy: string`（openid）

**服务端拦截点**（Phase 0 直接改现有云函数）：
- `getHistory` / `settings` / `analyzeImage` 入口：查 caller 的 `disabled`，为 `true` 则拒绝所有动作（含读）。
- **客户端提交巡检的特殊性**：`upload.js` 的 `createInspection` 目前是**客户端直写** `db.collection('inspections').add(...)`，**不经过云函数**，无法在服务端直接拦。补法二选一：
  - **Phase 0 轻量**：新增 `preSubmit` 云函数（或并入 `login` 返回值带 `disabled` 标志），客户端提交前先查，disabled 则拦截并提示"账号已停用"。
  - **Phase 1 彻底**：把 `createInspection` 收进 `submitInspection` 云函数，服务端统一鉴权后再写。推荐 Phase 1 做。

> 说明：Phase 0 用"客户端 preSubmit 拦截 + 云函数侧读/写动作拒绝"已能挡住绝大多数越权（停用的号提交会被拦、调任何云函数也会被拒）。唯一理论残留是"停用号在客户端直写 inspections"——Phase 1 的 `submitInspection` 收口后彻底消除。

---

## 7. 账号准入（可选，Phase 2）

- 若小程序**只在内部分发**（企业微信/指定二维码给员工），当前"谁装了 App 谁就能用"可接受，无需准入。
- 若小程序**对外发布**或要防止前员工继续用，需要准入：
  - **白名单**：`users` 增加 `approved` 字段，未审批的 openid 只能看引导页、不能提交；admin 在后台审批。
  - **邀请制**：admin 生成邀请（绑手机号或 openid），被邀请者首次打开才建账号。
- 本方案默认 Phase 0/1 不做准入，等你确认分发范围再定（见第 12 节待拍板点 3）。

---

## 8. 管理后台页设计（Phase 1）

- 新增页面 `pages/admin/admin`（入口仅 `admin` 可见；`manager` 可见一个只读版"全员视图"）。
- 需要的云函数能力（可并入 `settings` 或新建 `users` 云函数）：
  - `listUsers`：返回用户列表（`_openid` 掩码 / 姓名 / 角色 / 部门 / disabled / 创建时间 / 记录数）。
  - `setRole({ targetOpenid, role })`：仅 `admin`。
  - `setDisabled({ targetOpenid, disabled })`：仅 `admin`。
  - 复用现有 `settings.get / save / retryFailed` 与队列统计。
- UI：用户表格（角色下拉 + 停用按钮）+ 现有"分析设置"表单 + 队列卡片（待分析/分析中/失败）。
- 不引入新后端技术栈，纯小程序内实现，复用现有云函数模式。

---

## 9. 数据安全与审计

- 已有 `settings.updatedBy`（记录谁改了配置）保留。
- 新增角色变更审计：写入 `roleChanges` 集合（见 6.2）。
- API Key 仍只服务端读、前端仅掩码（已落实，保持）。
- 建议 `submitInspection`（Phase 1）写入 `createdByOpenid`（与现有 `_openid` 一致，便于追溯）。

---

## 10. 部署清单

**Phase 0 部署动作：**
- [ ] 云函数环境变量新增 `ADMIN_SETUP_CODE`（必填，你自己设一个）。
- [ ] 部署/更新云函数：`settings`（改 `canManage` 去掉自举 + 加 `activateAdmin`）、`login`（返回 `disabled`）、`getHistory` / `analyzeImage`（入口检查 `disabled`）、新增 `preSubmit`（或并入 `login`）。
- [ ] `users` 集合：新增 `disabled` 等字段（首次写入时自动带上，无需建表；如需按角色查询可在控制台加 `role` 索引）。
- [ ] 客户端：`upload.js` 提交前调 `preSubmit` 拦截停用号；「分析设置」页加"激活管理员"入口。
- [ ] 你自己用激活码把自己设为 admin，验证自举漏洞已关闭（此时非 admin 调 `settings.save` 应返回"只有管理员可以修改系统设置"）。

**Phase 1 额外动作：**
- [ ] 新增 `pages/admin/admin` 页 + `users` 云函数（`listUsers` / `setRole` / `setDisabled`）。
- [ ] 把 `createInspection` 收进 `submitInspection` 云函数（彻底服务端鉴权）。

**无需改动：** 数据库集合权限规则（现状"仅创建者可读写 + 云函数管理员权限运行"已正确）。

---

## 11. 路线图与改动点

| 阶段 | 目标 | 主要改动 | 工作量 |
|------|------|----------|--------|
| **Phase 0（必做）** | 堵自举漏洞 + 受控首管理员 + 账号停用 | ✅ 已落地：`settings.canManage` 去自举 + `activateAdmin`；`users` 加 `disabled`；`getHistory`/`analyzeImage`/`getReport`/`submitInspection` 查 `disabled`；环境变量 `ADMIN_SETUP_CODE` | 小（约 0.5–1 天） |
| **Phase 1（推荐）** | 小程序内管理后台 | ✅ 已落地：新增 `pages/admin/admin` + `users` 云函数（`listUsers`/`setRole`/`setDisabled`）；`submitInspection` 收口直写 | 中（约 1–2 天） |
| **Phase 2（按需）** | 准入/Web 后台/多租户/企微 | 白名单或邀请制；独立 Web 管理端；多品牌租户；企业微信集成 | 大（按需评估） |

---

## 12. 待你拍板的点

1. **manager 是否拥有改系统设置的权限？** 现状是拥有；本方案建议"manager 只看全员 + 管理视图，admin 才改设置/管人"。
2. **首管理员激活方式**：激活码（推荐）还是 openid 环境变量（更严格）？
3. **是否需要账号准入（白名单）？** 还是目前"谁装了 App 谁就能用"就够？取决于小程序是否对外发布。
4. **Phase 1 管理后台现在就做，还是先只交付 Phase 0？**

# ShelfGuard 自建后端

小程序不再使用微信云开发。这个目录是等价的 Node.js 服务：登录、角色审批、客户/产品/设置、巡检提交、照片、历史/报告/看板、通义千问货架分析、进销存客户同步、逆地理编码，以及每天 03:00（北京时间）的排面统计。

数据存在一台机器上的 SQLite 文件里，照片存在同一数据目录的磁盘上。新小程序从零开始，不迁移旧云环境的数据。

## 目录

```
server/
  src/index.js              进程入口，读 .env，监听端口，启动定时任务
  src/app.js                Express 路由，挂在 BASE_PATH 下
  src/auth.js               code2session 与登录 token
  src/docdb.js              SQLite 文档库（兼容原云数据库的查询写法）
  src/files.js              照片上传、签名访问、删除
  src/scheduler.js          进程内定时任务
  src/functions/            原云函数的等价实现
  data/                     运行后生成：shelfguard.sqlite 与 files/（不要提交）
```

接口都在路径前缀下，默认 `/shelfguard`：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/shelfguard/health` | 健康检查 |
| POST | `/shelfguard/api/auth/login` | `wx.login` 的 code 换 openid 和 token |
| POST | `/shelfguard/api/fn/:name` | 调用原云函数同名接口，请求体就是原来的 `data` |
| POST | `/shelfguard/api/upload` | `multipart` 上传照片，字段 `file` + `cloudPath` |
| GET | `/shelfguard/files/...?...` | 带签名的照片访问（2 小时有效） |

`:name` 可以是 `login`、`users`、`customers`、`products`、`settings`、`submitInspection`、`getHistory`、`getReport`、`analyzeImage`、`batchAnalyze`、`shelfStats`、`syncJxcCustomers`、`geocode`。

## 环境

- Node.js 22.5 或更高（使用内置 `node:sqlite`，不用另装数据库）
- 服务器能访问：`api.weixin.qq.com`、`dashscope.aliyuncs.com`；用到地图时还要访问 `apis.map.qq.com`；进销存同步还要能访问进销存服务

```bash
cd server
cp .env.example .env
# 编辑 .env 后再启动
npm install
npm test          # 本地冒烟，不连微信
npm start         # 默认 0.0.0.0:3100
```

## 环境变量

复制 `server/.env.example`。不要把填好的 `.env` 提交到 git。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `WECHAT_APPID` | 是 | `wxd60258ccfc36cb75` |
| `WECHAT_SECRET` | 是 | 小程序 AppSecret，只放服务器 |
| `JWT_SECRET` | 是 | 登录 token 和照片签名的密钥，32 位以上随机字符串。不设则进程拒绝启动 |
| `ADMIN_SETUP_CODE` | 是 | 首个管理员激活码，自己定，只告诉自己 |
| `PORT` | 否 | 监听端口，默认 `3100` |
| `BASE_PATH` | 否 | 路径前缀，默认 `/shelfguard` |
| `PUBLIC_BASE_URL` | 否 | 对外根地址，默认 `https://game.yft8.cn`。照片签名链接用它 |
| `DATA_DIR` | 否 | SQLite 和照片目录，默认 `server/data` |
| `FILE_URL_SECRET` | 否 | 照片 URL 签名密钥。不填则用 `JWT_SECRET` |
| `TOKEN_TTL_DAYS` | 否 | 登录 token 天数，默认 30。小程序每次打开都会重新登录 |
| `DASHSCOPE_API_KEY` | 否 | 通义千问 Key。不填也可以在小程序「分析设置」里保存，环境变量优先 |
| `TENCENT_MAP_KEY` | 否 | 腾讯位置服务 WebService Key。不填时水印退回经纬度 |
| `JXC_BASE_URL` / `JXC_API_KEY` | 否 | 进销存同步。不填也可以在「分析设置」里保存，环境变量优先 |
| `SHELFGUARD_TEST_LOGIN` | 禁止 | 只用于本机测试。设为 `1` 时可用 `testOpenid` 冒充任意用户。生产环境不要设置 |
| `DISABLE_CRON` | 否 | 设为 `1` 关闭进程内定时任务 |

## 定时任务

进程起来后自己跑，不用再配系统 crontab：

- 每 2 分钟：批量分析（只在「分析设置」的时间窗口内领新任务；窗口外仍会回收卡住的记录）
- 每 30 分钟：进销存客户同步（没配地址和 Key 时直接跳过）
- 每天 03:00（Asia/Shanghai）：重建排面看板。看板页管理员也可以手动重建

机器在 03:00 没开着，当天夜间统计会缺一次，第二天会补，也可以在看板里点重建。

## systemd

假设代码在 `/opt/shelfguard`，Node 在 `/usr/bin/node`。

```ini
[Unit]
Description=ShelfGuard API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/shelfguard/server
Environment=TZ=Asia/Shanghai
EnvironmentFile=/opt/shelfguard/server/.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now shelfguard
curl -fsS http://127.0.0.1:3100/shelfguard/health
```

## pm2

```bash
cd /opt/shelfguard/server
pm2 start src/index.js --name shelfguard --node-args="--disable-warning=ExperimentalWarning" --update-env
pm2 save
```

pm2 不会自动读 `.env`。可以先 `set -a && source .env && set +a`，或在 ecosystem 文件里写 `env_file`。时区建议 `TZ=Asia/Shanghai`。

## nginx

同一台机器上 `game.yft8.cn` 已经在服务别的项目。只加这一段，不要改现有的 `server_name` 和证书。`proxy_pass` 不要带路径，否则前缀会被吃掉。

```nginx
location /shelfguard/ {
    proxy_pass http://127.0.0.1:3100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 20m;
    proxy_read_timeout 120s;
    proxy_send_timeout 120s;
}
```

改完 `nginx -t && nginx -s reload`。然后：

```bash
curl -fsS https://game.yft8.cn/shelfguard/health
```

应返回 `{"ok":true,"service":"shelfguard"}`。

## 小程序后台

公众平台 → 开发管理 → 开发设置 → 服务器域名。只填主机名，不要带路径和端口：

| 类型 | 域名 |
| --- | --- |
| request 合法域名 | `https://game.yft8.cn` |
| uploadFile 合法域名 | `https://game.yft8.cn` |
| downloadFile 合法域名 | `https://game.yft8.cn` |

照片用 `<image>` 和下载接口展示，必须配 downloadFile。不需要 socket 合法域名，也不需要业务域名（没有网页）。

API 根地址在 `miniprogram/utils/config.js` 的 `apiBase`，目前是 `https://game.yft8.cn/shelfguard`。`project.config.json` 的 AppID 已是 `wxd60258ccfc36cb75`。

## 首个管理员

1. 配好 `ADMIN_SETUP_CODE` 并重启服务。
2. 用你自己的微信打开小程序（开发者工具或体验版），会自动登录。此时账号是未批准的业务员，还不能提交巡检。
3. 打开「分析设置」（相机页右上角进入），在激活卡片里输入 `ADMIN_SETUP_CODE`。
4. 成功后这个微信号变成管理员，并且 `approved: true`。激活入口随即关闭，别人不能再用激活码。
5. 到「用户与权限管理」里批准其他业务员。新业务员默认 `approved: false`，不批准不能提交巡检、不能做 AI 分析。

管理员停用、改角色的规则与原来一致：不能改自己的角色，不能停用自己。

## 照片与 AI

- 照片 fileID 形如 `sg://inspections/<openid>/...jpg`，只允许挂到本人目录。
- 列表和报告里的图片地址是 2 小时签名 URL，小程序 `<image>` 不带 Authorization 也能显示。
- 发给通义千问的图片默认用本机文件转成 data URL，DashScope 不需要反过来拉取我们的服务器。单张超过 3MB 时才退回签名 URL，那种情况要求 `PUBLIC_BASE_URL` 从公网能访问。
- 未配置 DashScope Key 时不会把模拟报告写入统计，记录会标成分析失败。

## 和原云开发的差异

- 不迁移 `cloud1-d8gop997sa25927c4` 里的旧数据。旧的 `cloud://` 文件 ID 不能再提交。
- 权限仍全部在服务端按 openid 判断，不信任小程序传来的角色。
- 云函数 60 秒硬超时没有了。单次 AI 等待放到 90 秒；夜间统计和进销存同步允许跑完，不再卡在 45 秒。
- 批量分析仍是每 2 分钟处理一批（默认先做一位业务员的当日汇总），避免一次堆太多图。
- `cloudfunctions/` 目录还在仓库里，只作为对照，开发者工具不再把它当云函数目录。

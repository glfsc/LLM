# 部署文档（glfsc.ltd）

> 适用版本：V4 统一题目模型（package.json v4.0.0）
> 程序形态：单进程 Node.js 应用，**零第三方依赖**，**内置 SQLite 数据库**（无需安装任何数据库软件）

---

## 一、程序架构一览

| 项 | 值 |
|---|---|
| 运行环境 | Node.js **≥ 22.13.0**（硬性要求，用到内置 `node:sqlite` 模块） |
| 第三方依赖 | 无（`npm install` 都不需要） |
| 数据库 | SQLite（Node 内置），数据文件为项目根目录 `data.db`（WAL 模式，另有 `-wal` / `-shm` 两个伴生文件） |
| 启动命令 | `node server.js`（等价 `npm start`） |
| 监听端口 | 默认 `3000`，可用环境变量 `PORT` 覆盖 |
| 静态资源 | `public/` 目录 |
| 入口地址 | 根路径 `/` = 管理端（未登录时显示登录卡片；卡片下方可凭链接或短码进被试端，无需登录），`/admin` 等价；被试端 `/chat?q=<问卷ID>`；健康检查 `/api/health` |
| 账号 | 首次启动自动创建管理员 `admin`（初始密码 `admin123`，登录后请立即在「设置 → 修改密码」中修改）；普通账号可在登录卡片上自助注册。同一账号同时只允许一台设备在线：在别处登录或修改密码后，先前设备上的登录会立即失效 |

首次启动会自动建表，并灌入种子数据：两个实验模板（组别3 / 组别4）+ 两份预设问卷。

> **问卷二维码（部署后同样可用）**：管理端「问卷管理」可为每份问卷生成二维码（行内二维码图标），
> 并可「保存图片」导出海报式 PNG（问卷名 + 二维码 + 网址）。二维码里的地址在部署环境会自动使用
> 管理端所在的公网域名（如 `https://glfsc.ltd/chat?q=<问卷ID>`），被试在任何网络扫码都能直接进入作答页，
> **不需要与服务器同一局域网**；本机 localhost 打开管理端时则自动改用局域网 IP。

---

## 二、需要上传到服务器的文件

本地打包（推荐，**只带运行必需文件**）：

```bash
npm run deploy     # → dist/上线包.zip
```

包内含（15 个文件，zip 内是站点目录的直接一层，解压即原地覆盖）：

```
server.js        # 服务端入口
db.js            # 数据层（建表 / 访问函数）
seed-content.js  # 实验材料文案种子
xlsx.js          # 数据导出 Excel
package.json     # 项目信息（无依赖，仅为 npm start / engines 声明）
public/          # 前端页面（admin / chat 及静态资源）
vendor/qrcode.js # 二维码生成（管理端生成被试二维码用）
README.md / DEPLOY.md   # 文档，不影响运行
```

**不要上传**：`data.db`（服务器上的库原样保留，见第七节）、`node.exe`（服务器自己装 Node）、`node_modules/`（不存在依赖）、`design/`、`demand/`、`screenshots/`。

> ⚠️ 如果你本地已经配好问卷内容想直接迁移，改为在**服务器首次运行并停止后**，把本地 `data.db`（含 `-wal`、`-shm`，若存在）整体覆盖上去即可；否则服务器会用种子数据全新开始。

---

## 三、服务器要求

- 一台服务器（Windows Server 2019/2022 或 Linux VPS 均可），**1核1G 起步完全够用**（轻量实验并发场景）
- 服务器上装有 **Node.js ≥ 22.13.0**（`node -v` 自查；`node:sqlite` 的硬性下限，低版本起不来）
- 已将域名 `glfsc.ltd` 的 A 记录解析到服务器 IP
- ⚠️ 如果你买的是 **PHP 虚拟主机 / 纯静态空间**，此程序无法部署，需要能跑常驻 Node 进程的服务器

---

## 四、Windows Server + 宝塔面板（本站在用的方式）

> 本站环境：Windows Server 2022 + 宝塔 Windows 面板，nginx 反向代理 + HTTPS 已配好。
> 反代与证书不用动，**每次更新只需要做「覆盖代码 + 重启进程」两步**。

### 1. 覆盖代码

1. 本地执行 `npm run deploy` → 得到 `dist/上线包.zip`。
2. 宝塔面板 →「文件」→ 进站点目录（如 `C:\wwwroot\glfsc.ltd`）→ 上传这个 zip → 右键**解压到当前目录**（覆盖同名文件）。
   - zip 里是站点目录的直接一层（`server.js`、`public\`、`vendor\`…），解压后不会多出一层文件夹。
   - **包里不含 `data.db`**，解压不会碰到数据库。
3. 重启 Node 进程（下一小节），然后打开 https://glfsc.ltd 验证：应看到管理端登录卡片，底部有备案号。

### 2. 让 Node 常驻（★ 别在远程桌面窗口里直接运行）

在远程桌面的 cmd 窗口里敲 `node server.js`，**退出远程桌面 / 注销后进程就会消失**（本站之前那次 502 就是这个原因）。
用系统自带的「任务计划程序」把它做成开机自启的常驻进程：

1. Win+R → `taskschd.msc` → 右侧「创建任务」
2. **常规**：名称随便（如 `实验对话系统`）；勾选「**不管用户是否登录都要运行**」和「使用最高权限运行」
3. **触发器**：新建 →「启动时」（可再加一个「登录时」）
4. **操作**：新建 → 程序或脚本填 `node.exe` 的完整路径（cmd 里 `where node` 可查）；
   添加参数填 `server.js`；**起始于**填站点目录（如 `C:\wwwroot\glfsc.ltd`）
5. **设置**：勾选「如果任务失败，按以下频率重新启动」
6. 保存 → 右键该任务「运行」→ 浏览器打开 https://glfsc.ltd 验证

> 更新代码后重启进程：任务计划程序里右键该任务「结束」再「运行」；
> 或在任务管理器里结束 `node.exe`，再右键任务「运行」。
> 排查启动失败：把「操作」里的参数临时改成 `server.js > C:\wwwroot\glfsc.ltd\start.log 2>&1`（或改用 bat 包一层）看日志。

### 3. 端口与防火墙

- 只放行 `80`、`443`；**不要对公网开放 3000**（应用只监听本机，由 nginx 反代过去）。
- 确认 nginx 配置里 `proxy_pass http://127.0.0.1:3000;`，且 `server_name` 同时含 `glfsc.ltd www.glfsc.ltd`。

---

## 五、部署步骤（Linux VPS，备用方式）

### 1. 安装 Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v    # 必须显示 ≥ v22.13.0
```

### 2. 上传代码

在本地（Windows，Git Bash）执行，把文件传到服务器 `/opt/experiment-chat`：

```bash
ssh user@你的服务器IP "mkdir -p /opt/experiment-chat"
scp -r server.js db.js xlsx.js package.json public scripts user@你的服务器IP:/opt/experiment-chat/
```

（也可用 WinSCP / 宝塔面板文件管理直接上传打包好的 zip 再解压。）

### 3. 首次试运行

```bash
cd /opt/experiment-chat
node server.js
```

看到类似输出即成功：

```
实验平台已启动（局域网预实验模式）
  管理端：http://localhost:3000/（根路径就是管理端，未登录时先显示登录卡片）
```

另开一个终端验证：`curl http://127.0.0.1:3000/api/health` 应返回 `{"ok":true}`。
确认无误后 `Ctrl+C` 停掉。

### 4. 常驻运行（二选一）

**方式 A：PM2（推荐，简单）**

```bash
sudo npm i -g pm2
cd /opt/experiment-chat
pm2 start server.js --name experiment-chat
pm2 save
pm2 startup   # 按提示执行输出的那条 sudo 命令，实现开机自启
```

常用命令：`pm2 logs experiment-chat`（看日志）、`pm2 restart experiment-chat`（重启）。

**方式 B：systemd**

创建 `/etc/systemd/system/experiment-chat.service`：

```ini
[Unit]
Description=Experiment Chat Server
After=network.target

[Service]
WorkingDirectory=/opt/experiment-chat
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now experiment-chat
systemctl status experiment-chat
```

### 5. Nginx 反向代理 + HTTPS

安装 Nginx 后，创建 `/etc/nginx/sites-available/glfsc.ltd`：

```nginx
server {
    listen 80;
    server_name glfsc.ltd;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/glfsc.ltd /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

配置 HTTPS 证书（Let's Encrypt 免费）：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d glfsc.ltd
```

完成后访问 `https://glfsc.ltd` 应看到管理端（未登录时先显示登录卡片，底部有 ICP 备案号），登录后直接进入管理端。

---

## 六、数据与备份

- 全部业务数据（问卷、会话、消息、作答记录、设置、账号）都在 **`data.db` 一个文件**里（另有 `-wal` / `-shm` 两个伴生文件）
- **覆盖代码时不用动它**：新代码启动时会自动补齐旧库缺的表与列（`CREATE TABLE IF NOT EXISTS` + `ensureColumn`，
  代码里注释写着「旧库补齐」），所以**老库直接沿用、数据不丢、也不需要重建**。
  实测：用早期版本（无 `users` 表、少 12 个列）建的库，换成新代码启动后自动补出了 `users` 表和全部缺失列，旧问卷/实验模板在管理端正常显示。
- **⚠️ 但库里的「问卷内容」是创建时的快照，不会跟着代码升级**：如果服务器上的库是旧版本建的，
  升级后可能出现「AI 思考过程没有」「阅读限制不见了、时间限制跑到注意力检测上」这类现象 —— 那是旧题目模型里的
  参数键（如 `delay`）在新模型里不生效导致的。**跑一次内容同步即可修好**（问卷 ID 不变，二维码/被试链接不受影响；
  只动两份预设问卷 + 两个实验模板，你自己新建的问卷不受影响）：

  ```bash
  cd 站点目录
  node scripts/sync-group-content.js            # 先预览（不写库），核对差异
  node scripts/sync-group-content.js --apply    # 自动备份 data.db 到 .tmp/ 后写入
  # 完事重启 Node 进程
  ```

  脚本在上线包里（`scripts/sync-group-content.js`）。同步的备份落在站点目录的 `.tmp/` 下。
  老库里你自己试答留下的测试会话，同步后题号可能对不上，正式收数据前清掉即可（管理端数据页删会话）。
- **想彻底重来**（库里还没有真实数据时最省事）：停服务 → 把 `data.db`、`data.db-wal`、`data.db-shm` **改名**成 `data.db.bak-日期`（别直接删，留个后悔药）→ 启动 → 自动建新库并灌入预设模板与问卷，管理员 `admin` / `admin123`（**登录后立刻改密码**）。
- **备份**：最稳妥是先停服务再拷贝（PM2：`pm2 stop experiment-chat`，拷完 `pm2 start`）；不停服时建议拷贝前执行 `sqlite3 data.db ".backup backup.db"`（需装 sqlite3），或连同 `-wal` / `-shm` 三个文件一起拷
- **换机迁移**：停服 → 拷贝 `data.db`（三个文件）→ 新机启动，无需其他操作
- **重置数据库**（⚠️ 清空全部问卷与作答数据，仅测试用）：停服后运行 `npm run reset-db`
- **把库放到项目之外（可选，推荐）**：默认库在项目根目录。用 `DB_PATH` 可以指到别处，让数据库不落在程序目录里——将来即使再出现文件读取类漏洞，也读不到库：

  ```bash
  sudo mkdir -p /var/lib/experiment-chat && sudo chown -R $USER /var/lib/experiment-chat
  # PM2：DB_PATH=/var/lib/experiment-chat/data.db pm2 start server.js --name experiment-chat
  # systemd：在 [Service] 里加 Environment=DB_PATH=/var/lib/experiment-chat/data.db
  ```

  目录不存在时会自动创建（但需要写权限，所以上面先 mkdir + chown 更稳）。
  同一环境变量对 `npm run reset-db`、`npm run check`、`npm run portable` 等脚本同样生效，改动后记得重启服务。
  迁移现有数据：停服后把 `data.db`（含 `-wal`/`-shm`）搬到新位置，再用 `DB_PATH` 启动。

---

<!-- 以下为上线检查与排障 -->

## 七、上线前检查清单

- [ ] **修改管理员密码**（必须！账号 `admin` / 初始密码 `admin123`）：登录后进入左下角「设置 → 修改密码」直接修改，无需命令行
      （老版本只有密码没有账号，升级到本版后账号固定填 `admin`）
- [ ] 打开 `https://glfsc.ltd` 确认根路径就是管理端（未登录时是登录卡片，底部有 ICP 备案号），`https://www.glfsc.ltd` 同样能打开
- [ ] Node 进程已做成开机自启的常驻服务（Windows 见第四节第 2 小节；**不要在远程桌面窗口里直接跑**）

- [ ] 服务器防火墙 / 安全组只放行 `22`、`80`、`443`，**不要对公网开放 3000**
- [ ] Nginx 反代必须带上 `X-Forwarded-For` / `X-Real-IP`（第四节的配置已包含）：按 IP 的访问限流靠它识别真实来源，
      少了这两个头，所有请求会被当成来自 127.0.0.1 而共用一个配额桶
- [ ] 在管理端建好各分组问卷，记录每组被试链接 `https://glfsc.ltd/chat?q=<问卷ID>`
- [ ] 手机端走一遍完整流程（知情同意 → 创作 → 反馈 → 问卷 → 结束页）
- [ ] 管理端数据页导出 Excel 验证正常
- [ ] 做一次 `data.db` 备份

### 访问限流（内置）

服务端对少数入口做了固定窗口限流，超限返回 `429` 并带 `Retry-After`：

| 入口 | 默认限额 | 环境变量 |
|---|---|---|
| 登录（按 IP） | 10 次 / 分钟 | `RATE_LOGIN_PER_MIN` |
| 登录（按用户名） | 10 次 / 分钟 | `RATE_LOGIN_USER_PER_MIN` |
| 注册（按 IP） | 3 次 / 小时 | `RATE_REGISTER_PER_HOUR` |
| 开始作答（按 IP） | 600 次 / 分钟 | `RATE_SESSION_PER_MIN` |
| 开始作答（全局） | 1200 次 / 分钟 | `RATE_SESSION_ALL_PER_MIN` |
| 预览接口（按 IP） | 60 次 / 分钟 | `RATE_PREVIEW_PER_MIN` |

**任意一条设成 `0` 就是关闭该条限流**（例：`RATE_SESSION_PER_MIN=0`），改完需重启服务。

**作答主链路（`/api/step`、`/api/heartbeat`、`/api/bootstrap`）完全不限流**——被试在实验中途被限流等于直接丢数据。
只有「开始作答」这一步有限流，它才是刷库入口。

#### 几百人同时开始作答，扛得住吗

实测（开发机，单进程 Node + 同步 SQLite）：

| 场景 | 结果 |
|---|---|
| 200 人同时点「开始」（各自 IP） | 全部成功，总耗时 ~0.4 秒 |
| 600 人同时点「开始」 | 全部成功，总耗时 ~1.2 秒（最后几位等约 1 秒） |
| 200 人**共用同一出口 IP**（整班在机房） | 全部成功，总耗时 ~0.3 秒 |

结论：**瓶颈不在服务端算力，而在限流的闸门高度**。早先的默认值（单 IP 30、全局 300）会把整班同学挡住，
现已按「一间机房整班 + 一倍余量」重定档。若你的规模更大，按这两条调：

- 整班共用出口 IP 且人数 > 600：调大 `RATE_SESSION_PER_MIN`，或直接设 `0` 关掉这条
- 全场峰值可能超过 1200 次/分钟：调大 `RATE_SESSION_ALL_PER_MIN`

被试在实验中途的作答提交不受任何限流影响，所以真正的并发压力只出现在「大家同时扫码开始」那一两分钟。
先启动服务、再跑 `npm run probe`（可加 `CONCURRENCY=600`）就能在你的服务器上复现上表
（脚本会临时建一份自己的问卷，跑完自动清理）。

**只跑单个进程**：本程序把限流桶与预览会话放在进程内存里，起多实例会让它们各算各的；
SQLite 单写者的特性也不适合多进程同时写。PM2 用默认的单实例模式即可，别加 `-i`。

---

## 八、常见问题

| 现象 | 原因与处理 |
|---|---|
| 启动报错提到 `node:sqlite` | Node 版本 < 22.5，按上文重装 Node 22+ |
| 访问 502 Bad Gateway | Node 进程没起来：`pm2 status` / `pm2 logs` 检查，或端口与 `proxy_pass` 不一致 |
| 端口被占用 | 换端口启动：`PORT=8080 node server.js`（同步改 Nginx `proxy_pass`） |
| 导出的 xlsx 打不开 | 确认 `xlsx.js` 已上传到服务器 |
| 宝塔面板部署 | 用「网站 → Node 项目」添加，启动文件选 `server.js`，端口 3000，Node 版本切到 22+，再对该站点设置反向代理到 `127.0.0.1:3000` |

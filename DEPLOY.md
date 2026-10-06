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
| 入口地址 | 被试端 `/chat?q=<问卷ID>`；管理端 `/admin`；健康检查 `/api/health` |
| 管理密码 | 默认 `admin123`，存于 `settings` 表（见「六、上线前检查」修改方法） |

首次启动会自动建表，并灌入种子数据：两个实验模板（组别3 / 组别4）+ 两份预设问卷。

---

## 二、需要上传到服务器的文件

```
server.js        # 服务端入口
db.js            # 数据层（建表 / 访问函数）
xlsx.js          # 数据导出 Excel
package.json     # 项目信息（无依赖，仅为 npm start / engines 声明）
public/          # 前端页面（admin / chat / index 及静态资源）
scripts/         # 可选：reset-db、consistency-check 等自检工具
```

**不要上传**：`data.db`（首次运行自动创建）、`node_modules/`（不存在依赖）、`design/`、`demand/`、`screenshots/`、`*.md` 文档（不影响运行，可不传）。

> ⚠️ 如果你本地已经配好问卷内容想直接迁移，改为在**服务器首次运行并停止后**，把本地 `data.db`（含 `-wal`、`-shm`，若存在）整体覆盖上去即可；否则服务器会用种子数据全新开始。

---

## 三、服务器要求

- 一台 Linux VPS（Ubuntu 22.04 / Debian 12 等），**1核1G 起步完全够用**（轻量实验并发场景）
- 已将域名 `glfsc.ltd` 的 A 记录解析到服务器 IP
- ⚠️ 如果你买的是 **PHP 虚拟主机 / 纯静态空间**，此程序无法部署，需要 VPS 或支持 Node.js 进程托管的服务

---

## 四、部署步骤（以 Ubuntu 为例）

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
管理端入口：  http://localhost:3000/admin
被试端示例：  http://localhost:3000/chat?q=xxxxxxxx
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

完成后访问 `https://glfsc.ltd` 应看到首页，`https://glfsc.ltd/admin` 进入管理端。

---

## 五、数据与备份

- 全部业务数据（问卷、会话、消息、作答记录、设置）都在 **`data.db` 一个文件**里
- **备份**：最稳妥是先停服务再拷贝（PM2：`pm2 stop experiment-chat`，拷完 `pm2 start`）；不停服时建议拷贝前执行 `sqlite3 data.db ".backup backup.db"`（需装 sqlite3），或连同 `-wal` / `-shm` 三个文件一起拷
- **换机迁移**：停服 → 拷贝 `data.db`（三个文件）→ 新机启动，无需其他操作
- **重置数据库**（⚠️ 清空全部问卷与作答数据，仅测试用）：停服后运行 `npm run reset-db`

---

## 六、上线前检查清单

- [ ] **修改管理密码**（必须！默认 `admin123`，当前版本管理界面没有改密入口，用命令改）：

  ```bash
  cd /opt/experiment-chat
  pm2 stop experiment-chat
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data.db');db.prepare(\"UPDATE settings SET value='你的新密码' WHERE key='admin_password'\").run();console.log('密码已更新')"
  pm2 start experiment-chat
  ```

- [ ] 服务器防火墙 / 安全组只放行 `22`、`80`、`443`，**不要对公网开放 3000**
- [ ] 在管理端建好各分组问卷，记录每组被试链接 `https://glfsc.ltd/chat?q=<问卷ID>`
- [ ] 手机端走一遍完整流程（知情同意 → 创作 → 反馈 → 问卷 → 结束页）
- [ ] 管理端数据页导出 Excel 验证正常
- [ ] 做一次 `data.db` 备份

---

## 七、常见问题

| 现象 | 原因与处理 |
|---|---|
| 启动报错提到 `node:sqlite` | Node 版本 < 22.5，按上文重装 Node 22+ |
| 访问 502 Bad Gateway | Node 进程没起来：`pm2 status` / `pm2 logs` 检查，或端口与 `proxy_pass` 不一致 |
| 端口被占用 | 换端口启动：`PORT=8080 node server.js`（同步改 Nginx `proxy_pass`） |
| 导出的 xlsx 打不开 | 确认 `xlsx.js` 已上传到服务器 |
| 宝塔面板部署 | 用「网站 → Node 项目」添加，启动文件选 `server.js`，端口 3000，Node 版本切到 22+，再对该站点设置反向代理到 `127.0.0.1:3000` |

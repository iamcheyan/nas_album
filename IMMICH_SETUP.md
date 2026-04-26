# Immich 安装与配置指南

> 本文档记录 Immich 照片备份服务的部署过程，配合 `nas_album` 使用。
> 创建时间：2026-04-26

---

## 一、架构说明

```
手机 (Immich App) ──WiFi/网络──→ NAS:2283 ──→ /data/Pictures/immich/
                                      │
                                      └──→ nas_album (浏览层)
```

- **Immich**：负责手机照片备份、缩略图生成、人脸识别、元数据管理
- **nas_album**：自定义浏览界面，读取 Immich 或本地目录的照片

---

## 二、部署信息

| 项目 | 路径/值 |
|------|---------|
| Docker Compose 目录 | `~/immich/` |
| 照片存储路径 | `/data/Pictures/immich/` |
| 数据库路径 | `~/immich/postgres/` |
| 访问端口 | `2283` |
| 数据库密码 | `immich123456`（可自行修改 `.env`） |

### 容器状态检查

```bash
cd ~/immich && sudo docker compose ps
```

### 启动/停止/重启

```bash
cd ~/immich && sudo docker compose up -d    # 启动
cd ~/immich && sudo docker compose down       # 停止
cd ~/immich && sudo docker compose restart    # 重启
```

---

## 三、目录结构说明

Immich 在 `/data/Pictures/immich/` 下创建的目录：

| 目录 | 用途 |
|------|------|
| `upload/` | 手机备份的原始照片 |
| `library/` | Immich 管理的图库（External Library 链接） |
| `thumbs/` | 缩略图缓存 |
| `encoded-video/` | 视频转码缓存 |
| `profile/` | 用户头像等 |
| `backups/` | 数据库备份 |

> 为什么不用 `/data/Pictures/` 根目录？
> - Immich 需要自己的目录结构，和现有照片混在一起会乱
> - 避免系统目录和用户文件夹冲突
> - 保护原有照片不被误操作影响

---

## 四、网页端使用

### 首次访问

浏览器打开：
```
http://你的NAS_IP:2283
```

第一个注册的账号自动成为**管理员**。

### 导入现有照片（External Library）

如果想让 Immich 也能浏览 `/data/Pictures/` 里已有的照片：

1. 网页端 → **Administration**（左下角齿轮）
2. → **Libraries** → **Create Library**
3. 选择现有照片目录，如 `/data/Pictures/来自iPhone(iPhone 15)/`
4. Immich 会自动扫描，**不会重复导入**（通过文件 hash 判断）

**External Library 特点：**
- 只读链接，删除照片不会删原文件
- 和 Upload 里的重复照片会自动合并显示
- 适合管理历史照片，不改变原有目录结构

---

## 五、手机端配置

### 1. 下载 App

- **iOS**：App Store 搜索 "Immich"
- **Android**：Google Play 或 F-Droid 搜索 "Immich"

### 2. 连接服务器

打开 App，输入服务器地址：
```
http://你的NAS_IP:2283
```

> 手机需和 NAS 在同一局域网。外网访问见下方"网络配置"。

### 3. 登录

使用网页端注册的账号密码登录。

### 4. 开启自动备份

App → **相册** → 右上角 **设置图标** → **备份**

| 设置项 | 建议 |
|--------|------|
| 自动备份 | ✅ 开启 |
| 仅 WiFi 备份 | ✅ 建议开启（省流量） |
| 备份相册 | 选择"相机胶卷"等 |
| 前台备份 | 可选 |
| 后台备份 | Android 支持较好，iOS 有限制 |

### 5. 验证备份

拍几张照片，稍后在网页端查看，或 NAS 上检查：

```bash
ls /data/Pictures/immich/upload/
```

---

## 六、nas_album 与 Immich 的整合思路

当前 `nas_album` 直接扫描文件系统，未来可以考虑：

| 方案 | 说明 |
|------|------|
| **方案 A：保持现状** | `nas_album` 扫描 `/data/Pictures/`，Immich 负责备份，两者独立运行 |
| **方案 B：调用 Immich API** | `nas_album` 通过 Immich API 获取照片列表、缩略图、元数据，自己只做展示层 |
| **方案 C：复用缩略图** | `nas_album` 直接读取 Immich 生成的 `thumbs/` 缓存，避免重复生成 |

**推荐方向：** 方案 B，通过 Immich API 获取数据，专注做自定义浏览体验。

Immich API 文档：https://immich.app/docs/api

---

## 七、网络配置（外网访问）

当前只能在局域网访问。如需外网访问，可选方案：

| 方案 | 复杂度 | 说明 |
|------|--------|------|
| **Tailscale** | 低 | 零配置 VPN，手机装 App 即可 |
| **frp / nps** | 中 | 内网穿透，需要一台公网服务器 |
| **路由器端口映射** | 低 | 把 2283 端口映射出去，需有公网 IP |
| **Cloudflare Tunnel** | 中 | 免费，需要域名 |

> 安全提醒：如果直接端口映射，建议配合 Nginx + HTTPS + 基本认证。

---

## 八、常用命令

```bash
# 查看容器日志
cd ~/immich && sudo docker compose logs -f immich-server

# 查看数据库日志
cd ~/immich && sudo docker compose logs -f database

# 备份数据库
cd ~/immich && sudo docker compose exec database pg_dump -U postgres immich > backup.sql

# 更新 Immich 到最新版
cd ~/immich && sudo docker compose pull && sudo docker compose up -d
```

---

## 九、注意事项

1. **数据库不要放在 NAS 网络盘上** - 性能差，容易损坏。当前配置在本地 `~/immich/postgres/` 是正确的。
2. **定期备份** - 照片在 `/data/Pictures/immich/`，数据库在 `~/immich/postgres/`，都要备份。
3. **存储空间** - Immich 会生成缩略图和转码视频，占用额外空间，约为原图的 20-50%。
4. **不要手动修改 `upload/` 里的文件** - 会导致 Immich 数据库不一致。

---

## 十、参考链接

- Immich 官方文档：https://immich.app/docs
- Immich API 文档：https://immich.app/docs/api
- Docker Compose 配置：https://github.com/immich-app/immich/releases

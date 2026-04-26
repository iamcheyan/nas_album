# NAS Album

一个轻量级的本地照片/视频管理网站，专为 NAS 和家庭服务器设计。支持多路径照片库、后台自动扫描、地图定位浏览、重复照片清理等专业功能，提供类似 iPhoto / Google Photos 的流畅浏览体验。

[中文](#功能特性) | [English](#features)

![主界面](https://github.com/iamcheyan/nas_album/raw/master/asset/1.jpg)

![灯箱浏览](https://github.com/iamcheyan/nas_album/raw/master/asset/2.jpg)

![地图模式](https://github.com/iamcheyan/nas_album/raw/master/asset/3.jpg)

![重复照片清理](https://github.com/iamcheyan/nas_album/raw/master/asset/4.jpg)

---

## 功能特性

### 核心浏览体验

- **三栏专业布局** — 左侧边栏（图库/相册/来源/重复照片）+ 顶部 Tab（全部/年份/地图/信息）+ 右侧照片网格
- **沉浸式灯箱** — 全屏查看照片，底部缩略图条支持鼠标滚轮横向滚动，键盘方向键快速导航
- **缩略图无极调节** — 滑块实时调整网格尺寸（80px ~ 400px），适应不同屏幕和浏览习惯
- **深色主题** — 优雅的暗色界面，长时间浏览不疲劳
- **键盘快捷键** — 方向键导航、空格播放/暂停视频、Delete 删除、Esc 关闭

### 智能扫描与管理

- **后台自动扫描** — 启动时立即启动服务器（< 1 秒），扫描在后台线程中进行，不阻塞访问。照片逐步加载，无需等待
- **多路径支持** — 通过配置文件支持多个照片库路径（如本机 + 外置硬盘 + 手机备份目录）
- **截图自动识别** — 多规则检测截图文件（路径关键词、特殊宽高比、MIUI/ColorOS 等系统截图特征），可单独过滤浏览
- **HEIC 自动转换** — iPhone 拍摄的 HEIC/HEIF 格式自动转换为浏览器兼容的 JPEG

### 地图与时间线

- **地图模式** — 基于 Leaflet 的交互式地图，自动聚类显示照片拍摄位置。支持高德地图、OpenStreetMap、CartoDB 等多种底图
- **GPS 数据补录** — 设置面板一键补录，从照片 EXIF 中提取 GPS 信息并写入数据库
- **时间线浏览** — 按年份/月份/日期分层浏览，照片混排显示（照片+视频在同一时间线）

### 重复照片清理

- **重复检测** — 基于文件名 + 文件大小快速找出重复文件，适合清理跨设备备份产生的重复
- **智能选择** — 每组重复文件默认保留第一个副本，其余标记删除，至少保留一个防止误删
- **批量删除** — 一键删除所有标记的重复文件，自动移入回收站（30 天内可恢复）
- **权限自动修复** — 扫描重复照片时自动检测并修复文件权限，确保删除操作顺利进行

### 数据安全

- **回收站** — 删除的文件移入回收站，保留 30 天，支持恢复或永久删除
- **文件权限检查** — 设置面板可检查照片目录读写权限，一键获取修复命令
- **软删除机制** — 数据库标记隐藏而非物理删除，误删后可从回收站恢复

## 系统要求

- **Python 3.11+**
- **ffmpeg** / **ffprobe**（视频缩略图和时长提取）
- **uv**（Python 包管理器，推荐）

```bash
# 安装 uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# 安装 ffmpeg
# macOS: brew install ffmpeg
# Linux: sudo apt install ffmpeg
```

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/iamcheyan/nas_album.git
cd nas_album
```

### 2. 安装依赖（使用 uv）

```bash
# 自动创建虚拟环境并安装依赖
uv sync

# 或运行单个命令（自动使用项目虚拟环境）
uv run python app.py
```

### 3. 配置照片库路径

编辑 `config.py` 中的 `PHOTO_LIBRARY_PATHS`，添加你的照片库路径：

```python
PHOTO_LIBRARY_PATHS = [
    "/data/Pictures/",
    "/Volumes/外置硬盘名/Pictures",
]
```

支持多个路径，程序会按顺序扫描所有路径中的照片和视频。

### 4. 启动服务

```bash
uv run python app.py [端口，默认 5002]
```

- 服务器会**立即启动**（< 1 秒），不会阻塞等待扫描完成
- 后台线程会自动开始扫描照片库并生成缩略图
- 页面顶部会显示扫描进度条
- 根据照片数量，首次完整扫描可能需要几分钟到几小时

访问 http://localhost:5002 即可使用。

## 项目结构

```
nas_album/
├── app.py              # Flask 后端主程序
├── config.py           # 配置文件（照片库路径、端口等）
├── templates/
│   ├── index.html      # 主页面（三栏布局）
│   └── trash.html      # 回收站页面
├── static/
│   ├── css/
│   │   └── style.css   # 样式表
│   ├── js/
│   │   ├── app.js      # 前端逻辑
│   │   └── i18n.js     # 多语言支持（中/英/日）
│   ├── thumbnails/     # 自动生成的缩略图（gitignore）
│   └── converted/      # HEIC 转 JPEG 缓存（gitignore）
├── photos.db           # SQLite 数据库（gitignore）
└── trash/              # 已删除文件（gitignore）
```

## 配置文件说明

`config.py` 包含以下可配置项：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `PHOTO_LIBRARY_PATHS` | 照片库路径列表 | `[]` |
| `DEFAULT_PORT` | 服务器端口 | `5002` |
| `THUMBNAIL_MAX_SIZE` | 缩略图最大尺寸 | `400` |
| `THUMBNAIL_QUALITY` | 缩略图 JPEG 质量 | `85` |
| `TRASH_RETENTION_DAYS` | 回收站保留天数 | `30` |

## 技术栈

| 层级 | 技术 |
|------|------|
| 后端 | Python 3, Flask, SQLite |
| 前端 | Vanilla JavaScript, CSS3 |
| 图像处理 | Pillow, pillow-heif |
| 视频处理 | ffmpeg, ffprobe |
| 地图 | Leaflet |
| 数据库 | SQLite (WAL 模式) |

## 键盘快捷键

| 按键 | 功能 |
|------|------|
| `←` / `→` | 上一张 / 下一张 |
| `Esc` | 关闭灯箱 / 退出选择模式 |
| `Space` | 播放 / 暂停视频 |
| `Delete` / `Backspace` | 删除当前照片 |
| `Shift + 点击` | 多选照片 |

## 常见问题

**Q: 启动时为什么还有扫描？**
A: 扫描在后台线程中进行，不会阻塞服务器启动。你可以立即访问网站，照片会逐步加载。

**Q: 如何添加新的照片库路径？**
A: 编辑 `config.py` 中的 `PHOTO_LIBRARY_PATHS`，添加新路径后重启服务器即可。

**Q: 缩略图占用多少空间？**
A: 缩略图约为原图的 1/20 ~ 1/50，400px 最大边长的 JPEG 质量 85。

**Q: 重复照片检测的原理是什么？**
A: 基于文件名 + 文件大小进行匹配。适合清理跨设备备份产生的重复（如手机照片同步到电脑后再次备份到 NAS）。

**Q: 删除的照片还能恢复吗？**
A: 可以。删除的照片会进入回收站，保留 30 天。在回收站页面可以选择恢复或永久删除。

## 许可证

MIT License

---

## Features

### Core Browsing Experience

- **Three-column professional layout** — Sidebar (Library/Albums/Sources/Duplicates) + Top Tabs (All/Years/Map/Info) + Photo grid
- **Immersive lightbox** — Full-screen photo viewing with thumbnail strip supporting mouse wheel horizontal scroll, keyboard arrow navigation
- **Thumbnail size slider** — Real-time grid adjustment (80px ~ 400px) for different screens and preferences
- **Dark theme** — Elegant dark UI for comfortable long browsing sessions
- **Keyboard shortcuts** — Arrow navigation, space play/pause, delete, esc

### Smart Scanning & Management

- **Background auto-scanning** — Server starts instantly (< 1s), scanning runs in background thread without blocking. Photos load progressively
- **Multi-path support** — Configure multiple photo library paths (local + external drives + phone backup folders)
- **Screenshot auto-detection** — Multi-rule detection for screenshots (path keywords, aspect ratios, MIUI/ColorOS system screenshot patterns), filterable browsing
- **HEIC auto-conversion** — iPhone HEIC/HEIF photos automatically converted to browser-compatible JPEG

### Map & Timeline

- **Map mode** — Interactive Leaflet map with automatic clustering of photo locations. Supports Amap, OpenStreetMap, CartoDB and more tile providers
- **GPS data backfill** — One-click backfill from photo EXIF to database via settings panel
- **Timeline browsing** — Browse by year/month/day with mixed photo+video display in unified timeline

### Duplicate Photo Cleanup

- **Duplicate detection** — Fast filename + file_size based matching, ideal for cleaning up cross-device backup duplicates
- **Smart selection** — Default keep first copy per group, mark rest for deletion, always keep at least one
- **Batch delete** — One-click delete all marked duplicates, automatically moved to trash (recoverable within 30 days)
- **Auto permission fix** — Automatically detects and fixes file permissions during duplicate scan to ensure deletion works

### Data Safety

- **Trash / Recycle Bin** — Deleted files moved to trash with 30-day retention, support restore & permanent delete
- **File permission check** — Check photo directory read/write permissions in settings, get fix commands
- **Soft delete** — Database marks as hidden instead of physical deletion, recoverable from trash

## Requirements

- **Python 3.11+**
- **ffmpeg** / **ffprobe** (for video thumbnails and duration)
- **uv** (Python package manager, recommended)

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install ffmpeg
# macOS: brew install ffmpeg
# Linux: sudo apt install ffmpeg
```

## Quick Start

```bash
git clone https://github.com/iamcheyan/nas_album.git
cd nas_album
uv sync

# Edit PHOTO_LIBRARY_PATHS in config.py
uv run python app.py 5002
```

The server starts **instantly** (< 1s). Background scanning begins automatically. Visit http://localhost:5002

## License

MIT License

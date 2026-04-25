# NAS Album

一个轻量级的本地照片/视频管理网站，支持多路径照片库，提供类似 iPhoto / Phototheca 的专业浏览体验。

[中文](#功能特性) | [English](#features)

![界面预览](https://github.com/iamcheyan/nas_album/raw/master/screenshot.png)

---

## 功能特性

- 📸 **三栏专业布局** — 左侧边栏（图库/相册/来源）+ 顶部 Tab（全部/年份/地图/信息）+ 右侧照片网格
- 🎬 **视频支持** — 自动提取缩略图和时长，支持灯箱内播放/暂停
- 🗑️ **回收站** — 30 天自动清理，支持恢复或永久删除
- 🔍 **重复检测** — 基于感知哈希（pHash）找出相似照片
- ✂️ **批量操作** — 框选多张照片，一键批量删除
- 🖼️ **缩略图调节** — 滑块实时调整网格尺寸（80px ~ 400px）
- ⌨️ **键盘快捷键** — 方向键导航、空格播放/暂停、Delete 删除、Esc 关闭
- 🌙 **深色主题** — 优雅的暗色界面，适合长时间浏览
- ⚡ **后台扫描** — 启动时立即启动服务器，扫描在后台进行，不阻塞访问
- 📁 **多路径支持** — 通过配置文件支持多个照片库路径（如本机 + 外置硬盘）

## 系统要求

- **macOS**（依赖 macOS 照片库路径结构）
- **Python 3.9+**
- **ffmpeg** / **ffprobe**（视频缩略图和时长提取）

```bash
# 安装 ffmpeg
brew install ffmpeg
```

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/iamcheyan/nas_album.git
cd nas_album
```

### 2. 创建虚拟环境并安装依赖

```bash
python -m venv .venv
source .venv/bin/activate
pip install Flask Pillow pillow-heif
```

### 3. 配置照片库路径

编辑 `config.py` 中的 `PHOTO_LIBRARY_PATHS`，添加你的照片库路径：

```python
PHOTO_LIBRARY_PATHS = [
    "/Users/你的用户名/Pictures/Photos Library.photoslibrary/originals/",
    "/Volumes/外置硬盘名/Pictures",
]
```

支持多个路径，程序会按顺序扫描所有路径中的照片和视频。

### 4. 启动服务

```bash
python app.py [端口，默认 5002]
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
│   │   └── app.js      # 前端逻辑
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

## 许可证

MIT License

---

## Features

- **Three-column professional layout** — Sidebar (Library/Albums/Sources) + Top Tabs (All/Years/Map/Info) + Photo grid
- **Video support** — Auto thumbnail & duration extraction, lightbox playback
- **Trash / Recycle Bin** — 30-day retention with restore & permanent delete
- **Duplicate detection** — Perceptual hash (pHash) based similarity search
- **Batch operations** — Drag-to-select multiple photos, batch delete
- **Thumbnail size slider** — Real-time grid adjustment (80px ~ 400px)
- **Keyboard shortcuts** — Arrow navigation, space play/pause, delete, esc
- **Dark theme** — Elegant dark UI for comfortable long browsing sessions
- **Background scanning** — Server starts instantly, scanning runs in background thread
- **Multi-path support** — Configure multiple photo library paths via config file

## Requirements

- **macOS** (relies on macOS Photos Library path structure)
- **Python 3.9+**
- **ffmpeg** / **ffprobe** (for video thumbnails and duration)

```bash
brew install ffmpeg
```

## Quick Start

```bash
git clone https://github.com/iamcheyan/nas_album.git
cd nas_album
python -m venv .venv
source .venv/bin/activate
pip install Flask Pillow pillow-heif

# Edit PHOTO_LIBRARY_PATHS in config.py
python app.py 5002
```

The server starts **instantly** (< 1s). Background scanning begins automatically. Visit http://localhost:5002

## License

MIT License

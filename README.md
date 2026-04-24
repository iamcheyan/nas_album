# NAS Album

一个轻量级的本地照片/视频管理网站，支持从 macOS 照片库提取媒体文件，提供时间线浏览、灯箱查看、批量管理、回收站等功能。

[中文](#功能特性) | [English](#features)

---

## 功能特性

- 📸 **时间线浏览** — 按日期分组，瀑布流布局，无限滚动加载
- 🎬 **视频支持** — 自动提取缩略图和时长，支持灯箱内播放/暂停
- 🗑️ **回收站** — 30 天自动清理，支持恢复或永久删除
- 🔍 **重复检测** — 基于感知哈希（pHash）找出相似照片
- ✂️ **批量操作** — 框选多张照片，一键批量删除
- 🖼️ **缩略图调节** — 滑块实时调整网格尺寸（80px ~ 400px）
- ⌨️ **键盘快捷键** — 方向键导航、空格播放/暂停、Delete 删除、Esc 关闭
- 🌙 **深色主题** — 优雅的暗色界面，适合长时间浏览

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

编辑 `app.py` 中的 `PHOTOS_LIBRARY_PATH`，指向你的 macOS 照片库：

```python
PHOTOS_LIBRARY_PATH = "/Users/你的用户名/Pictures/Photos Library.photoslibrary/originals/"
```

### 4. 启动服务

```bash
python app.py [端口，默认 5002]
```

首次启动会自动扫描照片库并生成缩略图，根据照片数量可能需要几分钟。

访问 http://localhost:5002 即可使用。

## 项目结构

```
nas_album/
├── app.py              # Flask 后端主程序
├── templates/
│   ├── index.html      # 主页面（时间线浏览）
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

## 许可证

MIT License

---

## Features

- **Timeline browsing** — Grouped by date, masonry layout, infinite scroll
- **Video support** — Auto thumbnail & duration extraction, lightbox playback
- **Trash / Recycle Bin** — 30-day retention with restore & permanent delete
- **Duplicate detection** — Perceptual hash (pHash) based similarity search
- **Batch operations** — Drag-to-select multiple photos, batch delete
- **Thumbnail size slider** — Real-time grid adjustment (80px ~ 400px)
- **Keyboard shortcuts** — Arrow navigation, space play/pause, delete, esc
- **Dark theme** — Elegant dark UI for comfortable long browsing sessions

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

# Edit PHOTOS_LIBRARY_PATH in app.py to point to your library
python app.py 5002
```

Visit http://localhost:5002

## License

MIT License

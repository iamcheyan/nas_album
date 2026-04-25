import os

# 照片库路径配置
# 支持多个路径，按顺序扫描
PHOTO_LIBRARY_PATHS = [
    "/Users/tetsuya/Development/nas_album/Photos Library.photoslibrary/originals/",
    "/Volumes/DATA-2T/Pictures",
]

# 服务器配置
DEFAULT_PORT = 5002
DEBUG = False

# 缩略图配置
THUMBNAIL_MAX_SIZE = 800
THUMBNAIL_QUALITY = 85

# 视频缩略图配置
VIDEO_THUMBNAIL_TIME = "00:00:01"  # 从第1秒提取缩略图，跳过黑帧

# 回收站配置
TRASH_RETENTION_DAYS = 30

# 数据库配置
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "photos.db")

# 静态文件目录
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
THUMBNAIL_DIR = os.path.join(STATIC_DIR, "thumbnails")
CONVERTED_DIR = os.path.join(STATIC_DIR, "converted")
TRASH_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "trash")

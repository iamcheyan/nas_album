import os
import sys
import json
import sqlite3
import hashlib
import shutil
import subprocess
import threading
import time
import re
import signal
from datetime import datetime, timedelta
from pathlib import Path
from flask import Flask, render_template, send_file, jsonify, request
from PIL import Image, ExifTags
from PIL.ExifTags import TAGS
from PIL.TiffImagePlugin import IFDRational
import pillow_heif

pillow_heif.register_heif_opener()

app = Flask(__name__)

# 全局扫描状态变量
scan_status = {
    'is_scanning': False,
    'scanned_count': 0,
    'total_count': 0,
    'phase': 'idle',  # idle, listing, inserting, thumbnails
    'added_count': 0,
    'thumbnail_count': 0,
    'error_count': 0,
}
scan_lock = threading.Lock()

# 全局 GPS 补录状态
backfill_status = {
    'is_running': False,
    'processed': 0,
    'total': 0,
    'updated': 0,
    'errors': 0,
    'message_key': '',
}
backfill_lock = threading.Lock()
backfill_stop_event = threading.Event()

# 导入配置文件
from config import (
    PHOTO_LIBRARY_PATHS,
    DEFAULT_PORT,
    DEBUG,
    THUMBNAIL_MAX_SIZE,
    THUMBNAIL_QUALITY,
    VIDEO_THUMBNAIL_TIME,
    TRASH_RETENTION_DAYS,
    DB_PATH,
    STATIC_DIR,
    THUMBNAIL_DIR,
    CONVERTED_DIR,
    TRASH_DIR,
)

# 确保目录存在
Path(THUMBNAIL_DIR).mkdir(parents=True, exist_ok=True)
Path(CONVERTED_DIR).mkdir(parents=True, exist_ok=True)
Path(TRASH_DIR).mkdir(parents=True, exist_ok=True)

PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.heic', '.gif', '.webp'}
VIDEO_EXTENSIONS = {'.mov', '.mp4', '.avi', '.mkv', '.wmv', '.flv', '.m4v', '.3gp'}
ALL_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA synchronous=NORMAL')
    conn.execute('''
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            filename TEXT NOT NULL,
            media_type TEXT DEFAULT 'image',
            source_path TEXT,
            date_taken TIMESTAMP,
            width INTEGER,
            height INTEGER,
            thumbnail_path TEXT,
            file_size INTEGER,
            duration INTEGER,
            favorite INTEGER DEFAULT 0,
            latitude REAL,
            longitude REAL,
            is_screenshot INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_date ON photos(date_taken)')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_source ON photos(source_path)')
    
    # Migrate: add latitude/longitude columns if they don't exist (backward compatibility)
    existing_cols = {row['name'] for row in conn.execute("PRAGMA table_info(photos)")}
    if 'latitude' not in existing_cols:
        conn.execute('ALTER TABLE photos ADD COLUMN latitude REAL')
    if 'longitude' not in existing_cols:
        conn.execute('ALTER TABLE photos ADD COLUMN longitude REAL')
    if 'is_screenshot' not in existing_cols:
        conn.execute('ALTER TABLE photos ADD COLUMN is_screenshot INTEGER DEFAULT 0')
    if 'hidden' not in existing_cols:
        conn.execute('ALTER TABLE photos ADD COLUMN hidden INTEGER DEFAULT 0')
    
    conn.execute('''
        CREATE TABLE IF NOT EXISTS trash (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            photo_id INTEGER,
            original_path TEXT NOT NULL,
            trash_path TEXT NOT NULL,
            filename TEXT NOT NULL,
            deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            restored INTEGER DEFAULT 0
        )
    ''')
    
    conn.execute('''
        CREATE TABLE IF NOT EXISTS albums (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    
    conn.execute('''
        CREATE TABLE IF NOT EXISTS album_photos (
            album_id INTEGER,
            photo_id INTEGER,
            PRIMARY KEY (album_id, photo_id)
        )
    ''')
    conn.commit()
    conn.close()


def clean_expired_trash():
    cutoff = datetime.now() - timedelta(days=TRASH_RETENTION_DAYS)
    cutoff_str = cutoff.strftime('%Y-%m-%d %H:%M:%S')
    conn = get_db()
    try:
        expired = conn.execute(
            'SELECT id, trash_path FROM trash WHERE deleted_at < ? AND restored = 0',
            (cutoff_str,)
        ).fetchall()
        
        for item in expired:
            try:
                if os.path.exists(item['trash_path']):
                    os.remove(item['trash_path'])
                conn.execute('DELETE FROM trash WHERE id = ?', (item['id'],))
            except Exception as e:
                print(f'清理回收站失败 {item.get("trash_path") if item else "unknown"}: {e}')
        
        conn.commit()
    except Exception as e:
        print(f'清理回收站任务失败: {e}')
    finally:
        conn.close()


# 文件名日期提取模式（按优先级排序）
FILENAME_DATE_PATTERNS = [
    # 1. 标准 PREFIX_YYYYMMDD_HHMMSS 格式（支持下划线分隔或无分隔）
    ("PREFIX_YYYYMMDD_HHMMSS", r"(?:IMG_|MVIMG_|VID_|GIF_|PXL_|DSC_|Screenshot_|SCREENSHOT_|微信图片_|微信圖片_|WeChat 圖片_|PANO_)(\d{4})(\d{2})(\d{2})[_]?(\d{2})(\d{2})(\d{2})"),
    
    # 2. 标准 YYYYMMDD_HHMMSS 格式（无特定前缀）
    ("YYYYMMDD_HHMMSS_direct", r"^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})"),
    
    # 3. YYYY-MM-DD HHMMSS 格式
    ("YYYY-MM-DD_HHMMSS", r"(\d{4})-(\d{2})-(\d{2})[ _](\d{2})(\d{2})(\d{2})"),
    
    # 4. Screenshot YYYY-MM-DD 格式
    ("Screenshot_YYYY-MM-DD", r"Screenshot[_ ](\d{4})-(\d{2})-(\d{2})"),
    
    # 5. SCREENSHOT_YYYY-MM-DD-HH-MM-SS 格式（小米截图）
    ("SCREENSHOT_YYYY-MM-DD-HH-MM-SS", r"SCREENSHOT[_-](\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})"),
    
    # 6. ScreenRecorder-YYYY-MM-DD
    ("ScreenRecorder_YYYY-MM-DD", r"(?:SCREENRECORDER|ScreenRecorder)[_-](\d{4})-(\d{2})-(\d{2})"),
    
    # 7. retouch_YYYYMMDDHHMMSS
    ("retouch_YYYYMMDDHHMMSS", r"retouch_(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})"),
    
    # 8. 微信 wx_camera_毫秒时间戳
    ("wx_camera_timestamp", r"wx_camera_(\d{13})"),
    
    # 9. mmexport 毫秒时间戳
    ("mmexport_timestamp", r"mmexport(\d{13})"),
    
    # 10. XHS_毫秒时间戳（小红书）
    ("XHS_timestamp", r"XHS_(\d{13})"),
    
    # 11. tb_image_share_毫秒时间戳（淘宝）
    ("tb_image_share_timestamp", r"tb_image_share_(\d{13})"),
    
    # 12. microMsg.毫秒时间戳（微信）
    ("microMsg_timestamp", r"microMsg\.?(?:tmp\.)?(\d{13})"),
    
    # 13. RPReplay_Final秒时间戳（iOS录屏）
    ("RPReplay_timestamp", r"RPReplay_Final(\d{10})"),
    
    # 14. sd+秒时间戳
    ("sd_timestamp", r"sd(\d{10})"),
    
    # 15. 99999990+毫秒时间戳
    ("99999990_timestamp", r"99999990(\d{11})"),
    
    # 16. camphoto_秒时间戳
    ("camphoto_timestamp", r"camphoto_(\d{10})"),
    
    # 17. idlefish-msg-毫秒时间戳
    ("idlefish_timestamp", r"idlefish-msg-(\d{13})"),
    
    # 18. album_temp_秒时间戳
    ("album_timestamp", r"album_temp__.*_(\d{10})"),
    
    # 19. 13位毫秒时间戳（通用，前后有分隔符）
    ("generic_13digit_timestamp", r"[._-](\d{13})[._-]"),
    
    # 19b. 纯13位毫秒时间戳文件名（如 1659274952582.jpg）
    ("pure_13digit_timestamp", r"^(\d{13})\."),
    
    # 20. 10位秒时间戳（通用，前后有分隔符）
    ("generic_10digit_timestamp", r"[._-](\d{10})[._-]"),
    
    # 20b. 纯10位秒时间戳文件名（如 1659274952.jpg）
    ("pure_10digit_timestamp", r"^(\d{10})\."),
    
    # 21. IMGYYYYMMDD_HHMMSS（无分隔）
    ("IMG_YYYYMMDD_HHMMSS_nospace", r"IMG(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})"),
    
    # 22. 纯 YYYYMMDD 格式开头
    ("YYYYMMDD_prefix", r"^(20\d{2})(\d{2})(\d{2})[_-]"),
    
    # 23. 中文日期格式
    ("YYYY年M月D日", r"(\d{4})年(\d{1,2})月(\d{1,2})日"),
    
    # 24. YJ_YYMMDD_embedded
    ("YJ_YYMMDD_embedded", r"YJ(\d{2})(\d{2})(\d{2})"),
    
    # 25. d9i_YYYY-MM-DD_HH-MM-SS
    ("d9i_YYYY-MM-DD", r"d9i_(\d{4})-(\d{2})-(\d{2})"),
    
    # 26. aiq_YYYY-MM-DD_HH-MM-SS
    ("aiq_YYYY-MM-DD", r"aiq_(\d{4})-(\d{2})-(\d{2})"),
    
    # 27. mibak 备份文件中的原始日期
    ("mibak_original_date", r"_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mibak"),
]


def _timestamp_to_date(ts_str, is_milliseconds=True):
    """将时间戳字符串转换为 datetime"""
    try:
        ts = int(ts_str)
        if is_milliseconds:
            ts = ts / 1000
        # 检查时间戳是否在合理范围内 (2000-2035)
        if ts < 946656000 or ts > 2082758400:
            return None
        return datetime.fromtimestamp(ts)
    except Exception:
        return None


def extract_date_from_filename(filename):
    """
    从文件名中提取拍摄日期。
    这是最高优先级的日期来源，因为文件名通常是拍摄时自动生成的。
    返回 datetime 对象或 None。
    """
    for pattern_name, pattern in FILENAME_DATE_PATTERNS:
        matches = list(re.finditer(pattern, filename, re.IGNORECASE))
        if matches:
            m = matches[0]
            groups = m.groups()
            
            try:
                if "timestamp" in pattern_name:
                    # 时间戳格式
                    is_ms = "13digit" in pattern_name or pattern_name in [
                        "wx_camera_timestamp", "mmexport_timestamp", "XHS_timestamp",
                        "tb_image_share_timestamp", "microMsg_timestamp",
                        "99999990_timestamp", "idlefish_timestamp"
                    ]
                    dt = _timestamp_to_date(groups[0], is_milliseconds=is_ms)
                    if dt:
                        return dt
                elif len(groups) >= 6:
                    # 完整年月日时分秒
                    year, month, day = groups[0], groups[1], groups[2]
                    hour, minute, second = groups[3], groups[4], groups[5]
                    return datetime(int(year), int(month), int(day),
                                   int(hour), int(minute), int(second))
                elif len(groups) >= 3:
                    # 只有年月日
                    year, month, day = groups[0], groups[1], groups[2]
                    # 处理两位数年份
                    if len(year) == 2:
                        y = int(year)
                        if y >= 50:
                            year = "19" + year
                        else:
                            year = "20" + year
                    return datetime(int(year), int(month), int(day))
            except Exception:
                continue
    
    return None


def safe_getexif_dict(img):
    """兼容新旧 PIL 和 HEIC 的 EXIF 读取，返回 {tag_name: value} 字典"""
    # 优先使用新 API (PIL >= 8.0)
    if hasattr(img, 'getexif'):
        try:
            exif = img.getexif()
            if exif:
                result = {}
                for tag_id in exif.keys():
                    tag = TAGS.get(tag_id, tag_id)
                    value = exif[tag_id]
                    # GPSInfo 在新 API 中是 IFD 偏移量，需要特殊处理
                    if tag == 'GPSInfo' and isinstance(value, int):
                        gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
                        if gps_ifd:
                            result[tag] = dict(gps_ifd)
                        continue
                    result[tag] = value
                return result
        except Exception:
            pass
    
    # 回退到旧 API
    if hasattr(img, '_getexif'):
        try:
            exif = img._getexif()
            if exif:
                return {TAGS.get(k, k): v for k, v in exif.items()}
        except Exception:
            pass
    
    return {}


def extract_date_from_exif(image_path):
    try:
        with Image.open(image_path) as img:
            exif = safe_getexif_dict(img)
            if exif:
                for tag in ('DateTimeOriginal', 'DateTime', 'DateTimeDigitized'):
                    value = exif.get(tag)
                    if value:
                        return datetime.strptime(value, '%Y:%m:%d %H:%M:%S')
    except Exception:
        pass
    return None


def get_file_creation_date(path):
    """获取文件日期。优先级：修改时间 > 创建时间。
    修改时间通常保留原始文件的拍摄/导出时间，
    而创建时间是文件复制到当前位置的时间。"""
    stat = os.stat(path)
    now = datetime.now()
    
    # 优先使用修改时间（mtime），它通常保留原始文件的拍摄/导出时间
    mtime = datetime.fromtimestamp(stat.st_mtime)
    
    # 检查修改时间是否合理（不是未来，不是太老）
    if mtime <= now and mtime.year >= 1990:
        return mtime
    
    # 修改时间不合理，尝试创建时间（birthtime）
    try:
        birthtime = datetime.fromtimestamp(stat.st_birthtime)
        if birthtime <= now and birthtime.year >= 1990:
            return birthtime
    except AttributeError:
        pass
    
    # 如果 mtime 是毫秒时间戳（某些文件系统），尝试除以1000
    if stat.st_mtime > 1000000000000:
        try:
            mtime_sec = datetime.fromtimestamp(stat.st_mtime / 1000)
            if mtime_sec <= now and mtime_sec.year >= 1990:
                return mtime_sec
        except (ValueError, OSError):
            pass
    
    # 都不行，返回 birthtime 或 mtime（不管是否合理，总比没有好）
    try:
        return datetime.fromtimestamp(stat.st_birthtime)
    except AttributeError:
        return mtime


def generate_thumbnail(image_path, thumb_path, max_size=THUMBNAIL_MAX_SIZE):
    """生成图片缩略图。如果文件实际是视频（如小米 Motion Photo），回退到 ffmpeg 提取帧。"""
    try:
        with Image.open(image_path) as img:
            img.thumbnail((max_size, max_size), Image.LANCZOS)
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            img.save(thumb_path, 'JPEG', quality=THUMBNAIL_QUALITY)
            return img.width, img.height
    except Exception:
        # 可能是 Motion Photo 等伪装成 JPG 的视频文件，尝试用 ffmpeg
        return generate_video_thumbnail(image_path, thumb_path, max_size)


def generate_video_thumbnail(video_path, thumb_path, max_size=THUMBNAIL_MAX_SIZE):
    """用 ffmpeg 提取视频第一帧作为缩略图"""
    try:
        cmd = [
            'ffmpeg', '-y', '-i', video_path,
            '-ss', VIDEO_THUMBNAIL_TIME,
            '-vframes', '1',
            '-vf', f'scale={max_size}:{max_size}:force_original_aspect_ratio=decrease',
            '-q:v', '2',
            str(thumb_path)
        ]
        result = subprocess.run(cmd, capture_output=True, timeout=30)
        if result.returncode == 0 and os.path.exists(thumb_path):
            with Image.open(thumb_path) as img:
                return img.width, img.height
        return None, None
    except Exception as e:
        print(f"视频缩略图失败 {video_path}: {e}")
        return None, None


def get_video_duration(video_path):
    """获取视频时长（秒）"""
    try:
        cmd = [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'json',
            video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return int(float(data['format']['duration']))
    except Exception as e:
        print(f"获取视频时长失败 {video_path}: {e}")
    return None


def get_video_metadata(video_path):
    """获取视频详细元数据（分辨率、码率、编码等）"""
    try:
        cmd = [
            'ffprobe', '-v', 'error',
            '-show_entries', 'format=bit_rate,size,duration:stream=codec_name,codec_long_name,width,height,pix_fmt,r_frame_rate',
            '-of', 'json',
            video_path
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            return json.loads(result.stdout)
    except Exception as e:
        print(f"获取视频元数据失败 {video_path}: {e}")
    return None


def _to_float(v):
    """将 IFDRational、tuple 或单个数值转为 float"""
    from PIL.TiffImagePlugin import IFDRational
    if isinstance(v, IFDRational):
        return float(v)
    if isinstance(v, tuple) and len(v) == 2:
        return float(v[0]) / float(v[1])
    return float(v)


def parse_gps_info(gps_info):
    """从 EXIF GPSInfo 解析经纬度"""
    if not gps_info or not isinstance(gps_info, dict):
        return None
    
    try:
        def dms_to_decimal(dms, ref):
            """度分秒转十进制度数"""
            if isinstance(dms, (list, tuple)) and len(dms) >= 3:
                degrees = _to_float(dms[0])
                minutes = _to_float(dms[1])
                seconds = _to_float(dms[2])
                decimal = degrees + minutes / 60 + seconds / 3600
            else:
                decimal = _to_float(dms)
            if ref in ['S', 'W']:
                decimal = -decimal
            return decimal
        
        lat = dms_to_decimal(gps_info.get(2), gps_info.get(1, 'N'))
        lon = dms_to_decimal(gps_info.get(4), gps_info.get(3, 'E'))
        alt = gps_info.get(6, 0)
        
        return {
            'latitude': round(lat, 6),
            'longitude': round(lon, 6),
            'altitude': alt,
            'google_maps': f"https://www.google.com/maps?q={lat},{lon}",
        }
    except Exception:
        return None


# 常见屏幕分辨率列表（用于截图识别）
SCREEN_RESOLUTIONS = {
    # iPhone
    (1179, 2556), (2556, 1179),  # iPhone 15 Pro / 14 Pro
    (1170, 2532), (2532, 1170),  # iPhone 14 / 13 Pro / 13
    (1284, 2778), (2778, 1284),  # iPhone 14 Pro Max / 13 Pro Max
    (1125, 2436), (2436, 1125),  # iPhone X/XS/11 Pro / 12 mini
    (828, 1792), (1792, 828),    # iPhone 11 / XR
    (750, 1334), (1334, 750),    # iPhone 6/7/8/SE2/SE3
    (640, 1136), (1136, 640),    # iPhone 5/SE1
    # iPad
    (1536, 2048), (2048, 1536),  # iPad 9.7
    (1668, 2388), (2388, 1668),  # iPad Pro 11
    (2048, 2732), (2732, 2048),  # iPad Pro 12.9
    # MacBook
    (1440, 900), (900, 1440),    # MacBook Air 13
    (1680, 1050), (1050, 1680),  # MacBook Pro 15
    (1920, 1080), (1080, 1920),  # Full HD
    (2560, 1440), (1440, 2560),  # 2K
    (2560, 1600), (1600, 2560),  # MacBook Pro 13/14
    (2880, 1800), (1800, 2880),  # MacBook Pro 15 Retina
    (3024, 1964), (1964, 3024),  # MacBook Pro 14
    (3456, 2234), (2234, 3456),  # MacBook Pro 16
    # Android common
    (1080, 2400), (2400, 1080),  # Android FHD+
    (1440, 3200), (3200, 1440),  # Android QHD+
}


# 截图文件名前缀/关键词
SCREENSHOT_NAME_PATTERNS = [
    r'^screenshot[_-]?',
    r'^Screenshot[_-]?',
    r'^SCREENSHOT[_-]?',
    r'^微信图片[_-]?',
    r'^微信圖片[_-]?',
    r'^WeChat\s+圖片[_-]?',
    r'^微博图片[_-]?',
    r'^微博圖片[_-]?',
    r'^QQ图片[_-]?',
    r'^QQ圖片[_-]?',
    r'^截屏[_-]?',
    r'^截圖[_-]?',
]

# 截图常见目录关键词
SCREENSHOT_PATH_PATTERNS = [
    r'[/\\]Screenshots[/\\]',
    r'[/\\]screenshots[/\\]',
    r'[/\\]截图[/\\]',
    r'[/\\]截圖[/\\]',
    r'[/\\]Screen Shot[/\\]',
    r'[/\\]ScreenShot[/\\]',
    r'[/\\]微信[/\\]',
    r'[/\\]WeiXin[/\\]',
    r'[/\\]微博[/\\]',
    r'[/\\]Weibo[/\\]',
    r'[/\\]QQ[/\\]',
    r'[/\\]Telegram[/\\]',
    r'[/\\]钉钉[/\\]',
    r'[/\\]DingTalk[/\\]',
    r'[/\\]飞书[/\\]',
    r'[/\\]Lark[/\\]',
]


def detect_screenshot(path, ext, width=None, height=None, exif=None):
    """检测是否为截图
    
    规则（按优先级）：
    1. 文件名匹配截图前缀 → 截图
    2. 路径包含截图/聊天软件目录 → 截图
    3. PNG + 屏幕分辨率 → 截图
    4. PNG + 无相机EXIF → 截图（绝大多数PNG无EXIF都是截图/保存图）
    5. HEIC → 照片（iPhone相机默认格式）
    6. JPEG + 有相机EXIF → 照片
    7. JPEG + 无相机EXIF + 屏幕分辨率 → 截图
    8. 其他 → 不是截图
    """
    import re
    filename = Path(path).name
    path_str = str(path)
    ext_lower = ext.lower()
    
    # 1. 文件名匹配截图前缀
    for pattern in SCREENSHOT_NAME_PATTERNS:
        if re.search(pattern, filename, re.IGNORECASE):
            return True
    
    # 2. 路径匹配截图/聊天软件目录
    for pattern in SCREENSHOT_PATH_PATTERNS:
        if re.search(pattern, path_str, re.IGNORECASE):
            return True
    
    # HEIC 默认是照片
    if ext_lower == '.heic':
        return False
    
    # 检查是否有相机EXIF
    has_camera_exif = False
    if exif:
        make = exif.get('Make')
        model = exif.get('Model')
        if make or model:
            has_camera_exif = True
    
    # 3. PNG 判断
    if ext_lower == '.png':
        if width and height:
            # PNG + 屏幕分辨率 = 截图
            if (width, height) in SCREEN_RESOLUTIONS or (height, width) in SCREEN_RESOLUTIONS:
                return True
        # PNG + 无相机EXIF = 截图（绝大多数PNG无EXIF都是截图或保存图）
        if not has_camera_exif:
            return True
        return False
    
    # 4. JPEG 判断
    if ext_lower in ('.jpg', '.jpeg'):
        if has_camera_exif:
            return False  # 有相机信息 = 照片
        # 无相机信息，检查分辨率
        if width and height:
            if (width, height) in SCREEN_RESOLUTIONS or (height, width) in SCREEN_RESOLUTIONS:
                return True  # 无EXIF + 屏幕分辨率 = 截图
        # 无相机信息也不匹配屏幕分辨率，保守判断为不是截图
        return False
    
    return False


def format_duration(seconds):
    """格式化时长为 mm:ss"""
    if seconds is None:
        return ''
    minutes = seconds // 60
    secs = seconds % 60
    return f"{minutes}:{secs:02d}"


def compute_image_hash(image_path):
    try:
        with Image.open(image_path) as img:
            img = img.convert('L').resize((16, 16), Image.LANCZOS)
            pixels = list(img.getdata())
            avg = sum(pixels) / len(pixels)
            bits = ''.join('1' if p > avg else '0' for p in pixels)
            return hex(int(bits, 2))[2:].zfill(64)
    except Exception:
        return None


def get_image_dimensions(image_path):
    """快速获取图片尺寸，不生成缩略图"""
    try:
        with Image.open(image_path) as img:
            return img.width, img.height
    except Exception:
        # 可能是伪装成图片的视频
        return None, None


def scan_photos_fast():
    """
    快速扫描：只遍历文件系统并入库，不生成缩略图。
    缩略图改为按需生成（在 thumbnail API 中处理）。
    """
    global scan_status
    with scan_lock:
        if scan_status['is_scanning']:
            print("扫描已在进行中，跳过")
            return 0
        scan_status['is_scanning'] = True
        scan_status['scanned_count'] = 0
        scan_status['total_count'] = 0
        scan_status['phase'] = 'listing'
        scan_status['added_count'] = 0
        scan_status['thumbnail_count'] = 0
        scan_status['error_count'] = 0

    try:
        # 阶段1：快速列出所有媒体文件
        print("=== 阶段1: 列出所有媒体文件 ===")
        media_files = []
        for lib_path in PHOTO_LIBRARY_PATHS:
            if not os.path.exists(lib_path):
                print(f"路径不存在，跳过: {lib_path}")
                continue
            print(f"扫描路径: {lib_path}")
            for root, dirs, files in os.walk(lib_path):
                # 跳过 FreeFileSync 临时同步文件夹
                if '.filetransfer' in root.split(os.sep):
                    continue
                for filename in files:
                    ext = Path(filename).suffix.lower()
                    if ext in ALL_EXTENSIONS:
                        full_path = os.path.join(root, filename)
                        media_files.append((full_path, ext, lib_path))

        total = len(media_files)
        with scan_lock:
            scan_status['total_count'] = total
        print(f"找到 {total} 个媒体文件")

        # 阶段2：获取已存在的路径
        print("=== 阶段2: 获取已入库文件列表 ===")
        conn = get_db()
        existing_paths = {row['path'] for row in conn.execute('SELECT path FROM photos')}
        print(f"数据库中已有 {len(existing_paths)} 个文件")

        # 阶段3：批量插入新文件（不生成缩略图）
        print("=== 阶段3: 批量插入新文件 ===")
        with scan_lock:
            scan_status['phase'] = 'inserting'

        added = 0
        errors = 0
        batch = []
        BATCH_SIZE = 500

        for i, (full_path, ext, source_path) in enumerate(media_files):
            with scan_lock:
                scan_status['scanned_count'] = i + 1

            if full_path in existing_paths:
                continue

            is_video = ext in VIDEO_EXTENSIONS
            media_type = 'video' if is_video else 'image'

            # 获取日期：优先级 1. 文件名 > 2. EXIF > 3. 文件修改时间
            date_taken = extract_date_from_filename(Path(full_path).name)
            if not date_taken and not is_video:
                date_taken = extract_date_from_exif(full_path)
            if not date_taken:
                date_taken = get_file_creation_date(full_path)
            
            # 校验：如果日期是未来或太老，回退到文件修改时间
            now = datetime.now()
            if date_taken and (date_taken > now or date_taken.year < 1990):
                date_taken = get_file_creation_date(full_path)

            # 获取尺寸（图片快速读取，视频暂不获取）
            width, height = None, None
            if not is_video:
                width, height = get_image_dimensions(full_path)
            
            duration = None
            if is_video:
                duration = get_video_duration(full_path)

            file_size = os.path.getsize(full_path)
            thumb_filename = f'{hashlib.md5(full_path.encode()).hexdigest()}.jpg'
            thumb_path = str(Path(THUMBNAIL_DIR) / thumb_filename)

            # Extract GPS from EXIF for images
            latitude, longitude = None, None
            exif = None
            if not is_video:
                try:
                    with Image.open(full_path) as img:
                        exif = safe_getexif_dict(img)
                        gps_info = exif.get('GPSInfo')
                        if gps_info and isinstance(gps_info, dict):
                            gps_parsed = parse_gps_info(gps_info)
                            if gps_parsed:
                                latitude = gps_parsed.get('latitude')
                                longitude = gps_parsed.get('longitude')
                except Exception:
                    pass

            # Detect screenshot
            is_screenshot = 0
            if not is_video:
                is_screenshot = 1 if detect_screenshot(full_path, ext, width, height, exif) else 0

            batch.append((
                full_path, Path(full_path).name, media_type, source_path,
                date_taken, width, height, thumb_path, file_size, duration,
                latitude, longitude, is_screenshot
            ))

            if len(batch) >= BATCH_SIZE:
                try:
                    conn.executemany('''
                        INSERT OR IGNORE INTO photos 
                        (path, filename, media_type, source_path, date_taken, width, height, thumbnail_path, file_size, duration, latitude, longitude, is_screenshot)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', batch)
                    conn.commit()
                    added += len(batch)
                except Exception as e:
                    print(f"批量插入失败: {e}")
                    errors += len(batch)
                batch = []
                with scan_lock:
                    scan_status['added_count'] = added
                    scan_status['error_count'] = errors

        # 插入剩余批次
        if batch:
            try:
                conn.executemany('''
                    INSERT OR IGNORE INTO photos 
                    (path, filename, media_type, source_path, date_taken, width, height, thumbnail_path, file_size, duration, latitude, longitude, is_screenshot)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', batch)
                conn.commit()
                added += len(batch)
            except Exception as e:
                print(f"最后批量插入失败: {e}")
                errors += len(batch)

        with scan_lock:
            scan_status['added_count'] = added
            scan_status['error_count'] = errors

        conn.close()
        print(f"=== 扫描完成: 新增 {added} 个文件, 错误 {errors} 个 ===")
        
        # 阶段4：后台生成缩略图
        print("=== 阶段4: 后台生成缺失的缩略图 ===")
        with scan_lock:
            scan_status['phase'] = 'thumbnails'
        generate_missing_thumbnails()
        
        return added
    finally:
        with scan_lock:
            scan_status['is_scanning'] = False
            scan_status['phase'] = 'idle'


def generate_missing_thumbnails():
    """为数据库中没有缩略图的记录生成缩略图"""
    conn = get_db()
    # 获取需要生成缩略图的文件（thumbnail_path 存在但文件不存在）
    rows = conn.execute('''
        SELECT id, path, filename, media_type, thumbnail_path 
        FROM photos 
        WHERE thumbnail_path IS NOT NULL 
        AND (width IS NULL OR width = 0)
    ''').fetchall()
    
    total_missing = len(rows)
    print(f"需要生成 {total_missing} 个缩略图")
    
    generated = 0
    for i, row in enumerate(rows):
        thumb_path = Path(row['thumbnail_path'])
        
        # 如果缩略图已存在，只更新尺寸
        if thumb_path.exists():
            try:
                with Image.open(thumb_path) as img:
                    conn.execute(
                        'UPDATE photos SET width=?, height=? WHERE id=?',
                        (img.width, img.height, row['id'])
                    )
                generated += 1
                continue
            except Exception:
                pass
        
        # 生成缩略图
        is_video = row['media_type'] == 'video'
        if is_video:
            width, height = generate_video_thumbnail(row['path'], thumb_path)
        else:
            width, height = generate_thumbnail(row['path'], thumb_path)
        
        if width:
            conn.execute(
                'UPDATE photos SET width=?, height=? WHERE id=?',
                (width, height, row['id'])
            )
            generated += 1
        
        if (i + 1) % 50 == 0:
            conn.commit()
            with scan_lock:
                scan_status['thumbnail_count'] = generated
        
        # 每处理100个暂停一下，避免CPU过热
        if (i + 1) % 100 == 0:
            time.sleep(0.1)
    
    conn.commit()
    conn.close()
    with scan_lock:
        scan_status['thumbnail_count'] = generated
    print(f"缩略图生成完成: {generated}/{total_missing}")


def ensure_thumbnail(photo_id, photo_path, media_type, thumb_path):
    """按需生成缩略图，用于 API 调用时"""
    thumb_path = Path(thumb_path)
    if thumb_path.exists():
        return True
    
    try:
        if media_type == 'video':
            width, height = generate_video_thumbnail(photo_path, thumb_path)
        else:
            width, height = generate_thumbnail(photo_path, thumb_path)
        
        if width:
            # 更新数据库中的尺寸
            conn = get_db()
            conn.execute(
                'UPDATE photos SET width=?, height=? WHERE id=?',
                (width, height, photo_id)
            )
            conn.commit()
            conn.close()
            return True
    except Exception as e:
        print(f"按需生成缩略图失败 {photo_path}: {e}")
    return False


@app.route('/api/status')
def get_status():
    with scan_lock:
        total = scan_status['total_count']
        scanned = scan_status['scanned_count']
        progress = round((scanned / total * 100), 1) if total > 0 else 0.0
        return jsonify({
            'scanning': scan_status['is_scanning'],
            'phase': scan_status['phase'],
            'scanned': scanned,
            'total': total,
            'progress_percent': progress,
            'added': scan_status['added_count'],
            'thumbnails': scan_status['thumbnail_count'],
            'errors': scan_status['error_count'],
        })


@app.route('/api/rescan', methods=['POST'])
def trigger_rescan():
    """手动触发重新扫描"""
    thread = threading.Thread(target=scan_photos_fast, daemon=True)
    thread.start()
    return jsonify({'success': True, 'message_key': 'settings.scanStarted'})


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/trash')
def trash_page():
    return render_template('trash.html')


def photo_row_to_dict(p):
    ext = Path(p['filename']).suffix.lower().lstrip('.')
    
    # 运行时解析文件名日期（最高优先级）
    # 如果数据库中的日期是默认值（2050-12-31 或扫描时间），用文件名日期覆盖
    db_date = p['date_taken']
    filename_date = extract_date_from_filename(p['filename'])
    
    # 判断数据库日期是否是默认值/扫描时间
    is_default_date = False
    if db_date:
        db_date_str = str(db_date)
        # 2050-12-31 是程序硬编码的默认值
        # 2026-04-19 及之后是扫描时间
        if db_date_str.startswith('2050-12-31'):
            is_default_date = True
        elif db_date_str.startswith('2026-04-'):
            is_default_date = True
    else:
        is_default_date = True
    
    # 使用优先级：文件名日期 > 数据库日期
    if filename_date:
        effective_date = filename_date.strftime('%Y-%m-%d %H:%M:%S')
    elif db_date:
        effective_date = db_date
    else:
        effective_date = None
    
    item = {
        'id': p['id'],
        'path': p['path'],
        'filename': p['filename'],
        'media_type': p['media_type'],
        'format': ext.upper(),
        'date_taken': effective_date,
        'date_taken_raw': db_date,  # 保留原始数据库日期供调试
        'width': p['width'],
        'height': p['height'],
        'thumbnail_url': f'/thumbnail/{p["id"]}',
        'original_url': f'/photo/{p["id"]}',
        'file_size': p['file_size'],
        'favorite': bool(p['favorite']) if 'favorite' in p.keys() else False,
        'hidden': bool(p['hidden']) if 'hidden' in p.keys() else False
    }
    if p['duration']:
        item['duration'] = format_duration(p['duration'])
    # Include GPS if available
    lat = p['latitude'] if 'latitude' in p.keys() else None
    lon = p['longitude'] if 'longitude' in p.keys() else None
    if lat is not None and lon is not None:
        item['latitude'] = lat
        item['longitude'] = lon
        item['lat'] = lat
        item['lon'] = lon
    # Screenshot flag
    is_ss = p['is_screenshot'] if 'is_screenshot' in p.keys() else 0
    item['is_screenshot'] = bool(is_ss)
    return item


@app.route('/api/photos')
def get_photos():
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    source = request.args.get('source', '', type=str)
    year = request.args.get('year', '', type=str)
    month = request.args.get('month', '', type=str)
    day = request.args.get('day', '', type=str)
    per_page = min(per_page, 200)
    offset = (page - 1) * per_page
    
    conn = get_db()
    
    show_hidden = request.args.get('hidden', '0', type=str) == '1'
    media_type = request.args.get('media_type', '', type=str)
    favorite = request.args.get('favorite', '', type=str)
    recent = request.args.get('recent', '', type=str)
    filter_type = request.args.get('filter_type', 'all', type=str)
    
    where_clause = 'WHERE 1=1'
    params = []
    if not show_hidden:
        where_clause += ' AND (hidden IS NULL OR hidden = 0)'
    if source:
        where_clause += ' AND source_path = ?'
        params.append(source)
    if year:
        where_clause += " AND strftime('%Y', date_taken) = ?"
        params.append(year)
    if month:
        where_clause += " AND strftime('%m', date_taken) = ?"
        month_str = month.zfill(2)
        params.append(month_str)
    if day:
        where_clause += " AND strftime('%d', date_taken) = ?"
        day_str = day.zfill(2)
        params.append(day_str)
    if media_type:
        where_clause += ' AND media_type = ?'
        params.append(media_type)
    if favorite == '1':
        where_clause += ' AND favorite = 1'
    if recent == '1':
        where_clause += " AND date_taken >= datetime('now', '-30 days')"
    if filter_type == 'photo':
        where_clause += ' AND (is_screenshot IS NULL OR is_screenshot = 0)'
    elif filter_type == 'screenshot':
        where_clause += ' AND is_screenshot = 1'
    
    total = conn.execute(f'SELECT COUNT(*) FROM photos {where_clause}', params).fetchone()[0]
    
    query = f'''
        SELECT id, path, filename, media_type, source_path, date_taken, width, height, thumbnail_path, file_size, duration, favorite, latitude, longitude, hidden, is_screenshot
        FROM photos 
        {where_clause}
        ORDER BY date_taken DESC
        LIMIT ? OFFSET ?
    '''
    photos = conn.execute(query, params + [per_page, offset]).fetchall()
    conn.close()
    
    result = [photo_row_to_dict(p) for p in photos]
    
    return jsonify({
        'photos': result,
        'page': page,
        'per_page': per_page,
        'total': total,
        'has_more': offset + len(result) < total
    })


@app.route('/api/timeline')
def get_timeline():
    """返回所有照片的年份/月份/日期统计，用于时间轴侧边栏"""
    conn = get_db()
    
    # 按年份月份日期统计
    rows = conn.execute('''
        SELECT 
            strftime('%Y', date_taken) as year,
            strftime('%m', date_taken) as month,
            strftime('%d', date_taken) as day,
            COUNT(*) as count
        FROM photos
        WHERE date_taken IS NOT NULL AND hidden = 0
        GROUP BY year, month, day
        ORDER BY year DESC, month DESC, day DESC
    ''').fetchall()
    
    conn.close()
    
    # 组织成树形结构: {year: {month: {day: count}}}
    timeline = {}
    for row in rows:
        year = row['year']
        month = str(int(row['month']))  # 去掉前导零
        day = str(int(row['day']))  # 去掉前导零
        count = row['count']
        if year not in timeline:
            timeline[year] = {}
        if month not in timeline[year]:
            timeline[year][month] = {}
        timeline[year][month][day] = count
    
    return jsonify({'timeline': timeline})


@app.route('/thumbnail/<int:photo_id>')
def thumbnail(photo_id):
    conn = get_db()
    photo = conn.execute(
        'SELECT path, media_type, thumbnail_path FROM photos WHERE id = ?', 
        (photo_id,)
    ).fetchone()
    conn.close()
    
    if not photo:
        return '', 404
    
    thumb_path = Path(photo['thumbnail_path']) if photo['thumbnail_path'] else None
    
    # 如果缩略图不存在，按需生成
    if thumb_path and not thumb_path.exists():
        success = ensure_thumbnail(photo_id, photo['path'], photo['media_type'], str(thumb_path))
        if not success:
            # 返回占位图，避免前端显示空白
            placeholder = os.path.join(os.path.dirname(__file__), 'static', 'placeholder.jpg')
            if os.path.exists(placeholder):
                return send_file(placeholder)
            return '', 500
    
    if thumb_path and thumb_path.exists():
        return send_file(str(thumb_path))
    
    # 没有缩略图路径也返回占位图
    placeholder = os.path.join(os.path.dirname(__file__), 'static', 'placeholder.jpg')
    if os.path.exists(placeholder):
        return send_file(placeholder)
    return '', 404


@app.route('/photo/<int:photo_id>')
def original_photo(photo_id):
    conn = get_db()
    photo = conn.execute('SELECT path, filename, media_type FROM photos WHERE id = ?', (photo_id,)).fetchone()
    conn.close()
    if not photo or not os.path.exists(photo['path']):
        return '', 404
    
    ext = Path(photo['filename']).suffix.lower()
    
    # 视频直接返回
    if photo['media_type'] == 'video':
        return send_file(photo['path'])
    
    # HEIC 转 JPEG
    if ext == '.heic':
        converted_path = Path(CONVERTED_DIR) / f'{photo_id}.jpg'
        if not os.path.exists(converted_path):
            try:
                with Image.open(photo['path']) as img:
                    rgb_img = img.convert('RGB')
                    rgb_img.save(converted_path, 'JPEG', quality=90)
            except Exception as e:
                print(f'HEIC 转换失败 {photo["path"]}: {e}')
                return '', 500
        return send_file(converted_path)
    
    return send_file(photo['path'])


@app.route('/api/photo/<int:photo_id>/exif')
def get_photo_exif(photo_id):
    """获取照片的 EXIF 信息"""
    conn = get_db()
    photo = conn.execute('SELECT path, filename, media_type FROM photos WHERE id = ?', (photo_id,)).fetchone()
    conn.close()
    
    if not photo:
        return jsonify({'error': 'Photo not found'}), 404
    
    result = {
        'filename': photo['filename'],
        'path': photo['path'],
        'media_type': photo['media_type'],
    }
    
    # 文件信息
    try:
        stat = os.stat(photo['path'])
        result['file_size'] = stat.st_size
        result['modified_time'] = datetime.fromtimestamp(stat.st_mtime).isoformat()
    except Exception:
        pass
    
    # 图片 EXIF
    if photo['media_type'] == 'image':
        try:
            with Image.open(photo['path']) as img:
                result['format'] = img.format
                result['width'] = img.width
                result['height'] = img.height
                result['mode'] = img.mode
                
                exif = safe_getexif_dict(img)
                if exif:
                    exif_data = {}
                    for tag, value in exif.items():
                        if isinstance(value, bytes):
                            try:
                                value = value.decode('utf-8', errors='ignore')
                            except Exception:
                                value = str(value)
                        elif isinstance(value, IFDRational):
                            value = float(value) if value.denominator != 1 else int(value)
                        exif_data[tag] = value
                    
                    # 提取关键信息
                    result['exif'] = exif_data
                    result['camera'] = (exif_data.get('Make', '') + ' ' + exif_data.get('Model', '')).strip()
                    result['date_taken'] = exif_data.get('DateTimeOriginal') or exif_data.get('DateTime')
                    result['lens'] = exif_data.get('LensModel', '')
                    
                    # 处理 IFDRational 字段
                    def _safe_num(v):
                        if isinstance(v, IFDRational):
                            return float(v) if v.denominator != 1 else int(v)
                        return v
                    
                    result['aperture'] = _safe_num(exif_data.get('FNumber', ''))
                    result['iso'] = _safe_num(exif_data.get('ISOSpeedRatings', ''))
                    result['exposure'] = _safe_num(exif_data.get('ExposureTime', ''))
                    result['focal_length'] = _safe_num(exif_data.get('FocalLength', ''))
                    
                    # GPS 解析
                    gps_raw = exif_data.get('GPSInfo')
                    if gps_raw and isinstance(gps_raw, dict):
                        gps_parsed = parse_gps_info(gps_raw)
                        if gps_parsed:
                            result['gps'] = gps_parsed
                    
                    # 更多 EXIF 信息
                    result['orientation'] = exif_data.get('Orientation', '')
                    result['color_space'] = exif_data.get('ColorSpace', '')
                    result['software'] = exif_data.get('Software', '')
                    result['flash'] = exif_data.get('Flash', '')
                    result['white_balance'] = exif_data.get('WhiteBalance', '')
                    result['metering_mode'] = exif_data.get('MeteringMode', '')
                    result['exposure_mode'] = exif_data.get('ExposureMode', '')
                    result['exposure_program'] = exif_data.get('ExposureProgram', '')
                    result['scene_type'] = exif_data.get('SceneType', '')
                    result['contrast'] = exif_data.get('Contrast', '')
                    result['saturation'] = exif_data.get('Saturation', '')
                    result['sharpness'] = exif_data.get('Sharpness', '')
                    result['brightness'] = exif_data.get('BrightnessValue', '')
                    result['exposure_bias'] = exif_data.get('ExposureBiasValue', '')
                    result['max_aperture'] = exif_data.get('MaxApertureValue', '')
                    result['subject_distance'] = exif_data.get('SubjectDistance', '')
                    result['digital_zoom'] = exif_data.get('DigitalZoomRatio', '')
                    result['resolution_x'] = exif_data.get('XResolution', '')
                    result['resolution_y'] = exif_data.get('YResolution', '')
                    result['resolution_unit'] = exif_data.get('ResolutionUnit', '')
                    result['copyright'] = exif_data.get('Copyright', '')
                    result['artist'] = exif_data.get('Artist', '')
                    result['user_comment'] = exif_data.get('UserComment', '')
                    result['image_description'] = exif_data.get('ImageDescription', '')
                    
                    # 更多相机信息
                    result['make'] = exif_data.get('Make', '')
                    result['model'] = exif_data.get('Model', '')
                    result['body_serial'] = exif_data.get('BodySerialNumber', '')
                    result['lens_spec'] = exif_data.get('LensSpecification', '')
                    result['lens_serial'] = exif_data.get('LensSerialNumber', '')
                    
                    # 拍摄条件
                    result['light_source'] = exif_data.get('LightSource', '')
                    result['sensing_method'] = exif_data.get('SensingMethod', '')
                    result['cfa_pattern'] = exif_data.get('CFAPattern', '')
                    result['custom_rendered'] = exif_data.get('CustomRendered', '')
                    result['gain_control'] = exif_data.get('GainControl', '')
                    result['compression'] = exif_data.get('Compression', '')
                    result['components_config'] = exif_data.get('ComponentsConfiguration', '')
                    
                    # 缩略图信息
                    result['thumbnail_offset'] = exif_data.get('ThumbnailOffset', '')
                    result['thumbnail_length'] = exif_data.get('ThumbnailLength', '')
                    
                    # 文件修改时间（EXIF中的）
                    result['date_digitized'] = exif_data.get('DateTimeDigitized', '')
                    result['date_original'] = exif_data.get('DateTimeOriginal', '')
                    result['subsec_time'] = exif_data.get('SubsecTime', '')
                    result['subsec_time_org'] = exif_data.get('SubsecTimeOriginal', '')
                    result['subsec_time_dig'] = exif_data.get('SubsecTimeDigitized', '')
                    
                    # GPS 详细
                    if gps_raw and isinstance(gps_raw, dict):
                        result['gps_altitude'] = gps_raw.get(6, '')
                        result['gps_timestamp'] = gps_raw.get(7, '')
                        result['gps_datestamp'] = gps_raw.get(29, '')
                        result['gps_processing'] = gps_raw.get(18, '')
                        result['gps_area'] = gps_raw.get(28, '')
                        result['gps_dop'] = gps_raw.get(11, '')
                        result['gps_speed'] = gps_raw.get(13, '')
                        result['gps_track'] = gps_raw.get(14, '')
                        result['gps_img_direction'] = gps_raw.get(17, '')
                        result['gps_dest_latitude'] = gps_raw.get(20, '')
                        result['gps_dest_longitude'] = gps_raw.get(22, '')
                        result['gps_dest_bearing'] = gps_raw.get(24, '')
                        result['gps_dest_distance'] = gps_raw.get(26, '')
        except Exception as e:
            result['exif_error'] = str(e)
    
    # 视频信息
    if photo['media_type'] == 'video':
        try:
            duration = get_video_duration(photo['path'])
            if duration:
                result['duration_seconds'] = duration
                result['duration'] = format_duration(duration)
            
            # 视频详细元数据
            meta = get_video_metadata(photo['path'])
            if meta:
                result['video_metadata'] = meta
                streams = meta.get('streams', [])
                for s in streams:
                    if s.get('codec_type') == 'video':
                        result['width'] = s.get('width')
                        result['height'] = s.get('height')
                        result['codec'] = s.get('codec_long_name') or s.get('codec_name')
                        result['codec_tag'] = s.get('codec_tag_string', '')
                        result['pixel_format'] = s.get('pix_fmt')
                        result['profile'] = s.get('profile', '')
                        result['level'] = s.get('level', '')
                        fps = s.get('r_frame_rate', '')
                        if '/' in str(fps):
                            num, den = fps.split('/')
                            result['fps'] = round(float(num) / float(den), 2)
                        result['avg_frame_rate'] = s.get('avg_frame_rate', '')
                        result['nb_frames'] = s.get('nb_frames', '')
                        result['start_time'] = s.get('start_time', '')
                        result['color_range'] = s.get('color_range', '')
                        result['color_space'] = s.get('color_space', '')
                        result['color_transfer'] = s.get('color_transfer', '')
                        result['color_primaries'] = s.get('color_primaries', '')
                        result['field_order'] = s.get('field_order', '')
                        result['chroma_location'] = s.get('chroma_location', '')
                        result['refs'] = s.get('refs', '')
                        result['is_avc'] = s.get('is_avc', '')
                        result['nal_length_size'] = s.get('nal_length_size', '')
                        result['bits_per_raw_sample'] = s.get('bits_per_raw_sample', '')
                        result['display_aspect_ratio'] = s.get('display_aspect_ratio', '')
                        result['sample_aspect_ratio'] = s.get('sample_aspect_ratio', '')
                        result['time_base'] = s.get('time_base', '')
                        result['has_b_frames'] = s.get('has_b_frames', '')
                        break
                
                # 音频流信息
                for s in streams:
                    if s.get('codec_type') == 'audio':
                        result['audio_codec'] = s.get('codec_long_name') or s.get('codec_name')
                        result['audio_codec_tag'] = s.get('codec_tag_string', '')
                        result['audio_profile'] = s.get('profile', '')
                        result['audio_sample_rate'] = s.get('sample_rate', '')
                        result['audio_channels'] = s.get('channels', '')
                        result['audio_channel_layout'] = s.get('channel_layout', '')
                        result['audio_bit_rate'] = s.get('bit_rate', '')
                        result['audio_duration'] = s.get('duration', '')
                        result['audio_nb_frames'] = s.get('nb_frames', '')
                        result['audio_sample_fmt'] = s.get('sample_fmt', '')
                        result['audio_bits_per_sample'] = s.get('bits_per_sample', '')
                        break
                
                fmt = meta.get('format', {})
                br = fmt.get('bit_rate')
                if br:
                    result['bitrate'] = f"{int(int(br) / 1000)} kbps"
                result['format_name'] = fmt.get('format_name', '')
                result['format_long_name'] = fmt.get('format_long_name', '')
                result['start_time'] = fmt.get('start_time', '')
                result['probe_score'] = fmt.get('probe_score', '')
                result['nb_streams'] = fmt.get('nb_streams', '')
                result['nb_programs'] = fmt.get('nb_programs', '')
                result['size'] = fmt.get('size', '')
                result['duration_fmt'] = fmt.get('duration', '')
                
                # 标签/元数据
                tags = fmt.get('tags', {})
                if tags:
                    result['format_tags'] = tags
                    result['creation_time'] = tags.get('creation_time', '')
                    result['encoder'] = tags.get('encoder', '')
                    result['major_brand'] = tags.get('major_brand', '')
                    result['minor_version'] = tags.get('minor_version', '')
                    result['compatible_brands'] = tags.get('compatible_brands', '')
                    result['com_android_version'] = tags.get('com.android.version', '')
                    result['com_android_manufacturer'] = tags.get('com.android.manufacturer', '')
                    result['com_android_model'] = tags.get('com.android.model', '')
                    result['location'] = tags.get('location', '')
                    
                # 视频流标签
                for s in streams:
                    if s.get('codec_type') == 'video':
                        vtags = s.get('tags', {})
                        if vtags:
                            result['video_tags'] = vtags
                            result['video_creation_time'] = vtags.get('creation_time', '')
                            result['video_language'] = vtags.get('language', '')
                            result['video_handler'] = vtags.get('handler_name', '')
                            result['video_vendor_id'] = vtags.get('vendor_id', '')
                        break
        except Exception:
            pass
    
    # 添加文件名解析的日期（最高优先级）
    filename_date = extract_date_from_filename(photo['filename'])
    if filename_date:
        result['filename_date'] = filename_date.strftime('%Y-%m-%d %H:%M:%S')
    
    # 收集所有可能的日期来源，用于比较和展示
    all_dates = []
    
    # 1. 文件名日期
    if filename_date:
        all_dates.append(('文件名', filename_date))
    
    # 2. EXIF 日期
    exif_date_original = None
    exif_date_taken = None
    exif_date_digitized = None
    if result.get('date_original'):
        try:
            exif_date_original = datetime.strptime(result['date_original'], '%Y:%m:%d %H:%M:%S')
            all_dates.append(('EXIF原始时间', exif_date_original))
        except Exception:
            pass
    if result.get('date_taken'):
        try:
            exif_date_taken = datetime.strptime(result['date_taken'], '%Y:%m:%d %H:%M:%S')
            all_dates.append(('EXIF拍摄时间', exif_date_taken))
        except Exception:
            pass
    if result.get('date_digitized'):
        try:
            exif_date_digitized = datetime.strptime(result['date_digitized'], '%Y:%m:%d %H:%M:%S')
            all_dates.append(('EXIF数字化时间', exif_date_digitized))
        except Exception:
            pass
    
    # 3. 视频创建时间
    if result.get('creation_time'):
        try:
            # 处理 ISO 格式如 "2023-01-15T08:30:00.000000Z"
            ct = result['creation_time'].replace('Z', '+00:00')
            video_ct = datetime.fromisoformat(ct)
            all_dates.append(('视频创建时间', video_ct))
        except Exception:
            pass
    if result.get('video_creation_time'):
        try:
            ct = result['video_creation_time'].replace('Z', '+00:00')
            video_ct2 = datetime.fromisoformat(ct)
            all_dates.append(('视频流创建时间', video_ct2))
        except Exception:
            pass
    
    # 4. 文件系统时间
    try:
        stat = os.stat(photo['path'])
        result['file_size'] = stat.st_size
        mtime = datetime.fromtimestamp(stat.st_mtime)
        result['modified_time'] = mtime.isoformat()
        all_dates.append(('文件修改时间', mtime))
        
        result['access_time'] = datetime.fromtimestamp(stat.st_atime).isoformat()
        try:
            birthtime = datetime.fromtimestamp(stat.st_birthtime)
            result['birth_time'] = birthtime.isoformat()
            all_dates.append(('文件创建时间', birthtime))
        except AttributeError:
            pass
        
        result['inode'] = stat.st_ino
        result['device'] = stat.st_dev
        result['nlink'] = stat.st_nlink
        result['uid'] = stat.st_uid
        result['gid'] = stat.st_gid
        result['mode'] = oct(stat.st_mode)
    except Exception:
        pass
    
    # 5. 数据库中的日期
    conn2 = get_db()
    photo_row = conn2.execute(
        'SELECT id, path, filename, media_type, source_path, date_taken, width, height, thumbnail_path, file_size, duration, favorite FROM photos WHERE id = ?',
        (photo_id,)
    ).fetchone()
    conn2.close()
    
    db_date = None
    if photo_row and photo_row['date_taken']:
        try:
            db_date_str = str(photo_row['date_taken'])
            db_date = datetime.strptime(db_date_str, '%Y-%m-%d %H:%M:%S')
            all_dates.append(('数据库日期', db_date))
        except Exception:
            pass
    
    # === 核心逻辑：取所有日期中最小的（最早的）作为解析拍摄时间 ===
    # 过滤掉未来日期（大于今天的）
    now = datetime.now()
    valid_dates = [(label, dt) for label, dt in all_dates if dt <= now and dt.year >= 1990]
    
    if valid_dates:
        # 取最早的日期
        resolved_label, resolved_date = min(valid_dates, key=lambda x: x[1])
        result['resolved_date'] = resolved_date.strftime('%Y-%m-%d %H:%M:%S')
        result['resolved_source'] = resolved_label
    else:
        result['resolved_date'] = None
        result['resolved_source'] = None
    
    # 保留所有日期供前端对比展示（按时间先后排序）
    sorted_dates = sorted(valid_dates, key=lambda x: x[1])
    resolved_str = result.get('resolved_date')
    # 找到最早日期的索引，只标记第一个（避免相同日期都标记）
    earliest_idx = None
    for i, (label, dt) in enumerate(sorted_dates):
        if dt.strftime('%Y-%m-%d %H:%M:%S') == resolved_str:
            earliest_idx = i
            break
    result['all_dates'] = [
        {
            'label': label,
            'date': dt.strftime('%Y-%m-%d %H:%M:%S'),
            'is_earliest': (i == earliest_idx)
        }
        for i, (label, dt) in enumerate(sorted_dates)
    ]
    
    # 兼容旧字段
    if photo_row:
        parsed = photo_row_to_dict(photo_row)
        result['parsed_date'] = parsed.get('date_taken')
        result['db_date'] = parsed.get('date_taken_raw')
        result['date_source'] = 'filename' if filename_date else ('exif' if result.get('date_taken') else 'filetime')
    
    return jsonify(result)


@app.route('/api/photo/<int:photo_id>/delete', methods=['POST'])
def delete_photo(photo_id):
    conn = get_db()
    photo = conn.execute('SELECT * FROM photos WHERE id = ?', (photo_id,)).fetchone()
    if not photo:
        conn.close()
        return jsonify({'error': 'Photo not found'}), 404
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    trash_filename = f"{timestamp}_{photo_id}_{photo['filename']}"
    trash_path = Path(TRASH_DIR) / trash_filename
    
    try:
        shutil.copy2(photo['path'], trash_path)
        os.remove(photo['path'])
        
        conn.execute('''
            INSERT INTO trash (photo_id, original_path, trash_path, filename)
            VALUES (?, ?, ?, ?)
        ''', (photo_id, photo['path'], str(trash_path), photo['filename']))
        
        conn.execute('DELETE FROM photos WHERE id = ?', (photo_id,))
        conn.commit()
        
        clean_expired_trash()
        
        return jsonify({'success': True})
    except Exception as e:
        conn.rollback()
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@app.route('/api/photo/<int:photo_id>/favorite', methods=['POST'])
def toggle_favorite_photo(photo_id):
    """Toggle favorite status of a photo"""
    conn = get_db()
    photo = conn.execute('SELECT favorite FROM photos WHERE id = ?', (photo_id,)).fetchone()
    if not photo:
        conn.close()
        return jsonify({'error': 'Photo not found'}), 404
    
    new_favorite = 0 if photo['favorite'] else 1
    conn.execute('UPDATE photos SET favorite = ? WHERE id = ?', (new_favorite, photo_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'favorite': bool(new_favorite)})


@app.route('/api/photo/<int:photo_id>/hide', methods=['POST'])
def hide_photo(photo_id):
    """Toggle hidden status of a photo"""
    conn = get_db()
    photo = conn.execute('SELECT hidden FROM photos WHERE id = ?', (photo_id,)).fetchone()
    if not photo:
        conn.close()
        return jsonify({'error': 'Photo not found'}), 404
    
    new_hidden = 0 if photo['hidden'] else 1
    conn.execute('UPDATE photos SET hidden = ? WHERE id = ?', (new_hidden, photo_id))
    conn.commit()
    conn.close()
    return jsonify({'success': True, 'hidden': bool(new_hidden)})


@app.route('/api/photos/hidden')
def get_hidden_photos():
    """Return all hidden photos"""
    conn = get_db()
    photos = conn.execute('''
        SELECT id, path, filename, media_type, source_path, date_taken, width, height, thumbnail_path, file_size, duration, favorite, latitude, longitude, hidden
        FROM photos 
        WHERE hidden = 1
        ORDER BY date_taken DESC
    ''').fetchall()
    conn.close()
    return jsonify({'photos': [photo_row_to_dict(p) for p in photos]})


@app.route('/api/duplicates')
def get_duplicates():
    """Return duplicate photo groups (same filename + file_size)"""
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    per_page = min(per_page, 100)
    offset = (page - 1) * per_page
    
    conn = get_db()
    # Find groups with same filename and file_size, count > 1
    rows = conn.execute('''
        SELECT filename, file_size, COUNT(*) as cnt
        FROM photos
        WHERE hidden = 0
        GROUP BY filename, file_size
        HAVING cnt > 1
        ORDER BY cnt DESC
        LIMIT ? OFFSET ?
    ''', (per_page, offset)).fetchall()
    
    # Get total count
    total_row = conn.execute('''
        SELECT COUNT(*) FROM (
            SELECT filename, file_size
            FROM photos
            WHERE hidden = 0
            GROUP BY filename, file_size
            HAVING COUNT(*) > 1
        )
    ''').fetchone()
    total_groups = total_row[0] if total_row else 0
    
    groups = []
    for row in rows:
        filename = row['filename']
        file_size = row['file_size']
        photos = conn.execute('''
            SELECT id, path, filename, media_type, source_path, thumbnail_path, file_size, width, height
            FROM photos
            WHERE filename = ? AND file_size = ? AND hidden = 0
            ORDER BY (width * height) DESC
        ''', (filename, file_size)).fetchall()
        
        photo_list = []
        for p in photos:
            photo_list.append({
                'id': p['id'],
                'path': p['path'],
                'filename': p['filename'],
                'media_type': p['media_type'],
                'source_path': p['source_path'],
                'thumbnail_url': f'/thumbnail/{p["id"]}',
                'file_size': p['file_size'],
                'width': p['width'],
                'height': p['height']
            })
        groups.append({
            'filename': filename,
            'file_size': file_size,
            'count': len(photo_list),
            'photos': photo_list
        })
    
    conn.close()
    return jsonify({
        'groups': groups,
        'total_groups': total_groups,
        'page': page,
        'per_page': per_page,
        'has_more': offset + len(groups) < total_groups
    })


@app.route('/api/photos/batch_delete', methods=['POST'])
def batch_delete_photos():
    data = request.get_json()
    photo_ids = data.get('photo_ids', [])
    
    if not photo_ids:
        return jsonify({'error': 'No photo IDs provided'}), 400
    
    conn = get_db()
    deleted = []
    failed = []
    
    for photo_id in photo_ids:
        photo = conn.execute('SELECT * FROM photos WHERE id = ?', (photo_id,)).fetchone()
        if not photo:
            failed.append({'id': photo_id, 'reason': 'Not found'})
            continue
        
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        trash_filename = f"{timestamp}_{photo_id}_{photo['filename']}"
        trash_path = Path(TRASH_DIR) / trash_filename
        
        try:
            shutil.copy2(photo['path'], trash_path)
            os.remove(photo['path'])
            
            conn.execute('''
                INSERT INTO trash (photo_id, original_path, trash_path, filename)
                VALUES (?, ?, ?, ?)
            ''', (photo_id, photo['path'], str(trash_path), photo['filename']))
            
            conn.execute('DELETE FROM photos WHERE id = ?', (photo_id,))
            deleted.append(photo_id)
        except Exception as e:
            failed.append({'id': photo_id, 'reason': str(e)})
    
    conn.commit()
    conn.close()
    
    clean_expired_trash()
    
    return jsonify({
        'success': True,
        'deleted': deleted,
        'failed': failed,
        'deleted_count': len(deleted)
    })


@app.route('/api/duplicates')
def find_duplicates():
    """按 filename + file_size 分组查找重复照片（轻量级方案）"""
    conn = get_db()
    # 获取所有非隐藏照片（包括视频）
    photos = conn.execute('''
        SELECT id, path, filename, file_size, media_type, date_taken, width, height, thumbnail_path, duration
        FROM photos
        WHERE hidden = 0
    ''').fetchall()
    conn.close()
    
    # 按 filename + file_size 分组
    groups = {}
    for p in photos:
        key = (p['filename'], p['file_size'])
        if key not in groups:
            groups[key] = []
        groups[key].append(p)
    
    # 只保留有重复（>=2个文件）的组
    duplicate_groups = []
    for (filename, file_size), group in groups.items():
        if len(group) < 2:
            continue
        
        # 为每个副本构建信息
        items = []
        for p in group:
            item = {
                'id': p['id'],
                'filename': p['filename'],
                'path': p['path'],
                'file_size': p['file_size'],
                'media_type': p['media_type'],
                'thumbnail_url': f'/thumbnail/{p["id"]}',
                'date_taken': p['date_taken'],
                'width': p['width'],
                'height': p['height'],
            }
            if p['duration']:
                item['duration'] = format_duration(p['duration'])
            items.append(item)
        
        # 按路径排序，方便比较
        items.sort(key=lambda x: x['path'])
        
        duplicate_groups.append({
            'filename': filename,
            'file_size': file_size,
            'count': len(items),
            'items': items
        })
    
    # 按重复数量降序排列
    duplicate_groups.sort(key=lambda x: x['count'], reverse=True)
    
    return jsonify({
        'groups': duplicate_groups,
        'total_groups': len(duplicate_groups),
        'total_duplicates': sum(g['count'] for g in duplicate_groups)
    })


# 全局重复照片扫描状态
dup_scan_status = {
    'is_scanning': False,
    'total_files': 0,
    'duplicate_groups': 0,
    'duplicate_files': 0,
    'message': '',
}
dup_scan_lock = threading.Lock()


@app.route('/api/scan_duplicates', methods=['POST'])
def scan_duplicates():
    """手动触发重复照片扫描，返回扫描结果"""
    global dup_scan_status
    
    with dup_scan_lock:
        if dup_scan_status['is_scanning']:
            return jsonify({'success': False, 'message': '扫描正在进行中'}), 429
        dup_scan_status['is_scanning'] = True
        dup_scan_status['message'] = '扫描中...'
    
    def do_scan():
        global dup_scan_status
        try:
            # 1. 先检查并修复文件权限
            fixed_count = 0
            for lib_path in PHOTO_LIBRARY_PATHS:
                if not os.path.exists(lib_path):
                    continue
                for root, dirs, files in os.walk(lib_path):
                    if '.filetransfer' in root.split(os.sep):
                        continue
                    for filename in files:
                        ext = Path(filename).suffix.lower()
                        if ext in ALL_EXTENSIONS:
                            full_path = os.path.join(root, filename)
                            if not os.access(full_path, os.W_OK):
                                try:
                                    os.chmod(full_path, 0o644)
                                    fixed_count += 1
                                except Exception:
                                    pass
            
            # 2. 扫描重复照片
            conn = get_db()
            total = conn.execute('SELECT COUNT(*) FROM photos WHERE hidden = 0').fetchone()[0]
            
            rows = conn.execute('''
                SELECT filename, file_size, COUNT(*) as cnt
                FROM photos WHERE hidden = 0
                GROUP BY filename, file_size HAVING cnt > 1
            ''').fetchall()
            
            groups = len(rows)
            duplicates = sum(r['cnt'] for r in rows)
            conn.close()
            
            with dup_scan_lock:
                dup_scan_status['total_files'] = total
                dup_scan_status['duplicate_groups'] = groups
                dup_scan_status['duplicate_files'] = duplicates
                if fixed_count > 0:
                    dup_scan_status['message'] = f'扫描完成：修复 {fixed_count} 个文件权限，发现 {groups} 组重复，共 {duplicates} 个文件'
                else:
                    dup_scan_status['message'] = f'扫描完成：发现 {groups} 组重复，共 {duplicates} 个文件'
                dup_scan_status['is_scanning'] = False
        except Exception as e:
            with dup_scan_lock:
                dup_scan_status['message'] = f'扫描出错: {str(e)}'
                dup_scan_status['is_scanning'] = False
    
    thread = threading.Thread(target=do_scan)
    thread.start()
    
    return jsonify({'success': True, 'message': '扫描已启动'})


@app.route('/api/scan_duplicates/status')
def scan_duplicates_status():
    """获取重复照片扫描状态"""
    with dup_scan_lock:
        return jsonify({
            'is_scanning': dup_scan_status['is_scanning'],
            'total_files': dup_scan_status['total_files'],
            'duplicate_groups': dup_scan_status['duplicate_groups'],
            'duplicate_files': dup_scan_status['duplicate_files'],
            'message': dup_scan_status['message'],
        })


@app.route('/api/trash')
def get_trash():
    clean_expired_trash()
    
    conn = get_db()
    items = conn.execute('''
        SELECT * FROM trash WHERE restored = 0
        ORDER BY deleted_at DESC
    ''').fetchall()
    conn.close()
    
    result = []
    for item in items:
        remaining = TRASH_RETENTION_DAYS - (datetime.now() - datetime.fromisoformat(item['deleted_at'])).days
        result.append({
            'id': item['id'],
            'photo_id': item['photo_id'],
            'filename': item['filename'],
            'original_path': item['original_path'],
            'deleted_at': item['deleted_at'],
            'days_remaining': max(0, remaining)
        })
    
    return jsonify(result)


@app.route('/api/trash/<int:trash_id>/restore', methods=['POST'])
def restore_photo(trash_id):
    conn = get_db()
    item = conn.execute('SELECT * FROM trash WHERE id = ?', (trash_id,)).fetchone()
    if not item:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    
    try:
        if os.path.exists(item['trash_path']):
            os.makedirs(os.path.dirname(item['original_path']), exist_ok=True)
            shutil.move(item['trash_path'], item['original_path'])
        
        conn.execute('UPDATE trash SET restored = 1 WHERE id = ?', (trash_id,))
        conn.commit()
        
        # 启动快速扫描来重新入库恢复的文件
        thread = threading.Thread(target=scan_photos_fast, daemon=True)
        thread.start()
        
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@app.route('/api/trash/<int:trash_id>/permanent_delete', methods=['POST'])
def permanent_delete(trash_id):
    conn = get_db()
    item = conn.execute('SELECT * FROM trash WHERE id = ?', (trash_id,)).fetchone()
    if not item:
        conn.close()
        return jsonify({'error': 'Not found'}), 404
    
    try:
        if os.path.exists(item['trash_path']):
            os.remove(item['trash_path'])
        
        conn.execute('DELETE FROM trash WHERE id = ?', (trash_id,))
        conn.commit()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        conn.close()


@app.route('/api/stats')
def get_stats():
    conn = get_db()
    total = conn.execute('SELECT COUNT(*) FROM photos WHERE hidden = 0').fetchone()[0]
    photos = conn.execute('SELECT COUNT(*) FROM photos WHERE media_type = "image" AND hidden = 0').fetchone()[0]
    videos = conn.execute('SELECT COUNT(*) FROM photos WHERE media_type = "video" AND hidden = 0').fetchone()[0]
    favorites = conn.execute('SELECT COUNT(*) FROM photos WHERE favorite = 1 AND hidden = 0').fetchone()[0]
    trash = conn.execute('SELECT COUNT(*) FROM trash WHERE restored = 0').fetchone()[0]
    hidden = conn.execute('SELECT COUNT(*) FROM photos WHERE hidden = 1').fetchone()[0]
    sources = conn.execute('SELECT COUNT(DISTINCT source_path) FROM photos WHERE hidden = 0').fetchone()[0]
    
    oldest = conn.execute('SELECT date_taken FROM photos WHERE hidden = 0 ORDER BY date_taken ASC LIMIT 1').fetchone()
    newest = conn.execute('SELECT date_taken FROM photos WHERE hidden = 0 ORDER BY date_taken DESC LIMIT 1').fetchone()
    
    db_size = os.path.getsize(DB_PATH) if os.path.exists(DB_PATH) else 0
    
    # Count duplicate groups
    dup_rows = conn.execute('''
        SELECT COUNT(*) FROM (
            SELECT filename, file_size
            FROM photos
            WHERE hidden = 0
            GROUP BY filename, file_size
            HAVING COUNT(*) > 1
        )
    ''').fetchone()
    duplicates = dup_rows[0] if dup_rows else 0
    
    conn.close()
    
    return jsonify({
        'total': total,
        'photos': photos,
        'videos': videos,
        'favorites': favorites,
        'trash': trash,
        'hidden': hidden,
        'duplicates': duplicates,
        'sources': sources,
        'oldest': oldest['date_taken'] if oldest else None,
        'newest': newest['date_taken'] if newest else None,
        'db_size': db_size
    })


@app.route('/api/sources')
def get_sources():
    conn = get_db()
    rows = conn.execute('''
        SELECT source_path, COUNT(*) as count 
        FROM photos 
        WHERE source_path IS NOT NULL AND hidden = 0
        GROUP BY source_path
        ORDER BY count DESC
    ''').fetchall()
    conn.close()
    
    result = []
    for row in rows:
        path = row['source_path'] or '未知'
        name = os.path.basename(path) or path
        result.append({
            'path': path,
            'name': name,
            'count': row['count']
        })
    return jsonify(result)


@app.route('/api/albums')
def get_albums():
    conn = get_db()
    albums = conn.execute('''
        SELECT a.id, a.name, COUNT(ap.photo_id) as count
        FROM albums a
        LEFT JOIN album_photos ap ON a.id = ap.album_id
        GROUP BY a.id
        ORDER BY a.created_at DESC
    ''').fetchall()
    conn.close()
    
    return jsonify([{
        'id': a['id'],
        'name': a['name'],
        'count': a['count']
    } for a in albums])


@app.route('/api/albums/<int:album_id>/photos')
def get_album_photos(album_id):
    filter_type = request.args.get('filter_type', 'all', type=str)
    conn = get_db()
    
    where_clause = 'ap.album_id = ? AND p.hidden = 0'
    params = [album_id]
    
    if filter_type == 'photo':
        where_clause += ' AND (p.is_screenshot IS NULL OR p.is_screenshot = 0)'
    elif filter_type == 'screenshot':
        where_clause += ' AND p.is_screenshot = 1'
    
    photos = conn.execute(f'''
        SELECT p.id, p.path, p.filename, p.media_type, p.date_taken, p.width, p.height, p.thumbnail_path, p.file_size, p.duration, p.favorite, p.hidden, p.is_screenshot
        FROM photos p
        JOIN album_photos ap ON p.id = ap.photo_id
        WHERE {where_clause}
        ORDER BY p.date_taken DESC
    ''', params).fetchall()
    conn.close()
    
    return jsonify({
        'photos': [photo_row_to_dict(p) for p in photos]
    })


def backfill_gps(batch_size=200, progress_callback=None):
    """为已有照片批量补录 GPS 数据。跳过已有 lat/lon 的记录。
    progress_callback: 可选的回调函数，接收 (processed, total, updated)"""
    conn = get_db()
    # 统计需要处理的记录数
    total_missing = conn.execute(
        'SELECT COUNT(*) FROM photos WHERE latitude IS NULL AND longitude IS NULL AND media_type = "image"'
    ).fetchone()[0]
    if total_missing == 0:
        conn.close()
        print("GPS 补录: 没有需要处理的照片")
        if progress_callback:
            progress_callback(0, 0, 0)
        return 0

    print(f"GPS 补录: 共 {total_missing} 张照片需要处理")
    updated = 0
    errors = 0
    processed = 0

    while True:
        if backfill_stop_event.is_set():
            print("GPS 补录: 已停止")
            break

        rows = conn.execute(
            '''SELECT id, path FROM photos
               WHERE latitude IS NULL AND longitude IS NULL AND media_type = "image"
               LIMIT ?''',
            (batch_size,)
        ).fetchall()
        if not rows:
            break

        for row in rows:
            if backfill_stop_event.is_set():
                break
            processed += 1
            # processed 不应超过 total_missing
            if processed > total_missing:
                processed = total_missing
            photo_id = row['id']
            path = row['path']
            lat, lon = None, None
            try:
                if not os.path.exists(path):
                    continue
                with Image.open(path) as img:
                    exif = safe_getexif_dict(img)
                    gps_info = exif.get('GPSInfo')
                    if gps_info and isinstance(gps_info, dict):
                        gps_parsed = parse_gps_info(gps_info)
                        if gps_parsed:
                            lat = gps_parsed.get('latitude')
                            lon = gps_parsed.get('longitude')
            except Exception:
                pass

            if lat is not None and lon is not None:
                try:
                    conn.execute(
                        'UPDATE photos SET latitude = ?, longitude = ? WHERE id = ?',
                        (lat, lon, photo_id)
                    )
                    updated += 1
                except Exception as e:
                    print(f"GPS 更新失败 id={photo_id}: {e}")
                    errors += 1
            if progress_callback:
                progress_callback(processed, total_missing, updated)
            if processed % 100 == 0:
                conn.commit()
                print(f"GPS 补录进度: {processed}/{total_missing} (已更新 {updated})")

        conn.commit()
        if backfill_stop_event.is_set():
            break

    conn.close()
    print(f"GPS 补录完成: 处理 {processed} 张, 更新 {updated} 张, 错误 {errors} 张")
    return updated


@app.route('/api/backfill_gps/start', methods=['POST'])
def start_backfill_gps():
    """启动 GPS 补录后台任务"""
    with backfill_lock:
        if backfill_status['is_running']:
            return jsonify({'success': False, 'message_key': 'settings.backfillAlreadyRunning'})
        backfill_stop_event.clear()
        backfill_status['is_running'] = True
        backfill_status['processed'] = 0
        backfill_status['total'] = 0
        backfill_status['updated'] = 0
        backfill_status['errors'] = 0
        backfill_status['message_key'] = 'settings.backfillInProgress'

    def progress_callback(processed, total, updated):
        with backfill_lock:
            backfill_status['processed'] = processed
            backfill_status['total'] = total
            backfill_status['updated'] = updated

    def run_backfill():
        try:
            backfill_gps(batch_size=200, progress_callback=progress_callback)
            with backfill_lock:
                backfill_status['message_key'] = 'settings.backfillComplete'
        except Exception as e:
            with backfill_lock:
                backfill_status['message_key'] = 'settings.backfillError'
                backfill_status['errors'] += 1
        finally:
            with backfill_lock:
                backfill_status['is_running'] = False

    thread = threading.Thread(target=run_backfill, daemon=True)
    thread.start()
    return jsonify({'success': True, 'message_key': 'settings.backfillStarted'})


@app.route('/api/backfill_gps/status')
def get_backfill_gps_status():
    """获取 GPS 补录当前进度"""
    with backfill_lock:
        return jsonify({
            'is_running': backfill_status['is_running'],
            'processed': backfill_status['processed'],
            'total': backfill_status['total'],
            'updated': backfill_status['updated'],
            'errors': backfill_status['errors'],
            'message_key': backfill_status.get('message_key', ''),
        })


@app.route('/api/backfill_gps/stop', methods=['POST'])
def stop_backfill_gps():
    """停止 GPS 补录任务"""
    with backfill_lock:
        if not backfill_status['is_running']:
            return jsonify({'success': False, 'message_key': 'settings.backfillNotRunning'})
    backfill_stop_event.set()
    return jsonify({'success': True, 'message_key': 'settings.backfillStopRequested'})


@app.route('/api/map/photos')
def get_map_photos():
    """返回带 GPS 数据的照片，支持 limit 和 bounds 过滤"""
    limit = request.args.get('limit', 0, type=int)
    bounds = request.args.get('bounds', '', type=str)

    conn = get_db()
    where_clause = 'WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND hidden = 0'
    params = []

    if bounds:
        try:
            parts = [float(x.strip()) for x in bounds.split(',')]
            if len(parts) == 4:
                min_lat, max_lat, min_lon, max_lon = parts
                where_clause += ' AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?'
                params.extend([min_lat, max_lat, min_lon, max_lon])
        except Exception:
            pass

    count_sql = f'SELECT COUNT(*) FROM photos {where_clause}'
    total = conn.execute(count_sql, params).fetchone()[0]

    query = f'''
        SELECT id, filename, date_taken, latitude, longitude
        FROM photos
        {where_clause}
        ORDER BY date_taken DESC
    '''
    if limit and limit > 0:
        query += ' LIMIT ?'
        params.append(limit)

    rows = conn.execute(query, params).fetchall()
    conn.close()

    photos = []
    for r in rows:
        photos.append({
            'id': r['id'],
            'lat': r['latitude'],
            'lon': r['longitude'],
            'thumbnail_url': f'/thumbnail/{r["id"]}',
            'date_taken': r['date_taken'],
            'filename': r['filename'],
        })

    return jsonify({
        'photos': photos,
        'total': total,
        'returned': len(photos)
    })


def kill_port_process(port):
    """查找并杀掉占用指定端口的进程"""
    try:
        result = subprocess.run(
            ['lsof', '-ti', f':{port}'],
            capture_output=True, text=True
        )
        if result.stdout.strip():
            pids = result.stdout.strip().split('\n')
            for pid in pids:
                if pid:
                    try:
                        os.kill(int(pid), signal.SIGKILL)
                        print(f'已杀掉占用端口 {port} 的进程 (PID: {pid})')
                    except ProcessLookupError:
                        pass
            time.sleep(1)
    except Exception as e:
        print(f'清理端口失败: {e}')


@app.route('/api/check_permissions')
def check_permissions():
    """检查照片库文件的读写权限（采样检查，避免遍历全部文件）"""
    import getpass
    
    total = 0
    writable = 0
    sample_paths = []
    MAX_SAMPLE = 100  # 最多检查 100 个文件
    
    for lib_path in PHOTO_LIBRARY_PATHS:
        if not os.path.exists(lib_path):
            continue
        for root, dirs, files in os.walk(lib_path):
            if '.filetransfer' in root.split(os.sep):
                continue
            for filename in files:
                ext = Path(filename).suffix.lower()
                if ext in ALL_EXTENSIONS:
                    full_path = os.path.join(root, filename)
                    total += 1
                    if total <= MAX_SAMPLE:
                        if os.access(full_path, os.W_OK):
                            writable += 1
                        else:
                            sample_paths.append(full_path)
    
    return jsonify({
        'total_count': total,
        'writable_count': writable,
        'sample_count': min(total, MAX_SAMPLE),
        'sample_paths': sample_paths[:5],
        'user': getpass.getuser(),
        'library_path': PHOTO_LIBRARY_PATHS[0] if PHOTO_LIBRARY_PATHS else ''
    })


if __name__ == '__main__':
    init_db()
    clean_expired_trash()
    # 在后台线程中启动扫描，不阻塞 Flask 启动
    scan_thread = threading.Thread(target=scan_photos_fast, daemon=True)
    scan_thread.start()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    kill_port_process(port)
    app.run(debug=DEBUG, host='0.0.0.0', port=port, use_reloader=False)

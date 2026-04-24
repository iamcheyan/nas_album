import os
import sys
import json
import sqlite3
import hashlib
import shutil
import subprocess
from datetime import datetime, timedelta
from pathlib import Path
from flask import Flask, render_template, send_file, jsonify, request
from PIL import Image, ExifTags
from PIL.ExifTags import TAGS
import pillow_heif

pillow_heif.register_heif_opener()

app = Flask(__name__)

PHOTOS_LIBRARY = "/Users/tetsuya/Development/nas_album/Photos Library.photoslibrary/originals"
DB_PATH = "/Users/tetsuya/Development/nas_album/photos.db"
THUMBNAIL_DIR = Path("/Users/tetsuya/Development/nas_album/static/thumbnails")
THUMBNAIL_DIR.mkdir(parents=True, exist_ok=True)

TRASH_DIR = Path("/Users/tetsuya/Development/nas_album/trash")
TRASH_DIR.mkdir(parents=True, exist_ok=True)
TRASH_RETENTION_DAYS = 30

CONVERTED_DIR = Path("/Users/tetsuya/Development/nas_album/static/converted")
CONVERTED_DIR.mkdir(parents=True, exist_ok=True)

PHOTO_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.heic', '.gif', '.webp'}
VIDEO_EXTENSIONS = {'.mov', '.mp4', '.avi', '.mkv', '.wmv', '.flv', '.m4v', '.3gp'}
ALL_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute('''
        CREATE TABLE IF NOT EXISTS photos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT UNIQUE NOT NULL,
            filename TEXT NOT NULL,
            media_type TEXT DEFAULT 'image',
            date_taken TIMESTAMP,
            width INTEGER,
            height INTEGER,
            thumbnail_path TEXT,
            file_size INTEGER,
            duration INTEGER,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_date ON photos(date_taken)')
    
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
    conn.commit()
    conn.close()


def clean_expired_trash():
    cutoff = datetime.now() - timedelta(days=TRASH_RETENTION_DAYS)
    conn = get_db()
    expired = conn.execute(
        'SELECT id, trash_path FROM trash WHERE deleted_at < ? AND restored = 0',
        (cutoff,)
    ).fetchall()
    
    for item in expired:
        try:
            if os.path.exists(item['trash_path']):
                os.remove(item['trash_path'])
            conn.execute('DELETE FROM trash WHERE id = ?', (item['id'],))
        except Exception as e:
            print(f'清理回收站失败 {item["trash_path"]}: {e}')
    
    conn.commit()
    conn.close()


def extract_date_from_exif(image_path):
    try:
        with Image.open(image_path) as img:
            exif = img._getexif()
            if exif:
                for tag_id, value in exif.items():
                    tag = TAGS.get(tag_id, tag_id)
                    if tag in ('DateTimeOriginal', 'DateTime', 'DateTimeDigitized'):
                        return datetime.strptime(value, '%Y:%m:%d %H:%M:%S')
    except Exception:
        pass
    return None


def get_file_creation_date(path):
    stat = os.stat(path)
    try:
        return datetime.fromtimestamp(stat.st_birthtime)
    except AttributeError:
        return datetime.fromtimestamp(stat.st_mtime)


def generate_thumbnail(image_path, thumb_path, max_size=400):
    try:
        with Image.open(image_path) as img:
            img.thumbnail((max_size, max_size), Image.LANCZOS)
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            img.save(thumb_path, 'JPEG', quality=85)
            return img.width, img.height
    except Exception as e:
        print(f"缩略图生成失败 {image_path}: {e}")
        return None, None


def generate_video_thumbnail(video_path, thumb_path, max_size=400):
    """用 ffmpeg 提取视频第一帧作为缩略图"""
    try:
        cmd = [
            'ffmpeg', '-y', '-i', video_path,
            '-ss', '00:00:01',
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


def scan_photos():
    conn = get_db()
    existing_paths = {row['path'] for row in conn.execute('SELECT path FROM photos')}
    
    media_files = []
    for root, dirs, files in os.walk(PHOTOS_LIBRARY):
        for filename in files:
            ext = Path(filename).suffix.lower()
            if ext in ALL_EXTENSIONS:
                full_path = os.path.join(root, filename)
                media_files.append((full_path, ext))
    
    print(f"找到 {len(media_files)} 个媒体文件")
    
    added = 0
    for i, (full_path, ext) in enumerate(media_files):
        if full_path in existing_paths:
            continue
        
        is_video = ext in VIDEO_EXTENSIONS
        media_type = 'video' if is_video else 'image'
        
        date_taken = None
        if not is_video:
            date_taken = extract_date_from_exif(full_path)
        if not date_taken:
            date_taken = get_file_creation_date(full_path)
        
        thumb_filename = f'{i}.jpg'
        thumb_path = THUMBNAIL_DIR / thumb_filename
        
        if is_video:
            width, height = generate_video_thumbnail(full_path, thumb_path)
            duration = get_video_duration(full_path)
        else:
            width, height = generate_thumbnail(full_path, thumb_path)
            duration = None
        
        if width is None:
            continue
        
        file_size = os.path.getsize(full_path)
        
        try:
            conn.execute('''
                INSERT INTO photos (path, filename, media_type, date_taken, width, height, thumbnail_path, file_size, duration)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (full_path, Path(full_path).name, media_type, date_taken, width, height, str(thumb_path), file_size, duration))
            added += 1
        except sqlite3.IntegrityError:
            pass
        
        if (i + 1) % 50 == 0:
            conn.commit()
    
    conn.commit()
    conn.close()
    print(f"新增 {added} 个媒体文件")
    return added


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/trash')
def trash_page():
    return render_template('trash.html')


@app.route('/api/photos')
def get_photos():
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    per_page = min(per_page, 200)
    offset = (page - 1) * per_page
    
    conn = get_db()
    total = conn.execute('SELECT COUNT(*) FROM photos WHERE width IS NOT NULL').fetchone()[0]
    
    photos = conn.execute('''
        SELECT id, path, filename, media_type, date_taken, width, height, thumbnail_path, file_size, duration
        FROM photos 
        WHERE width IS NOT NULL
        ORDER BY date_taken DESC
        LIMIT ? OFFSET ?
    ''', (per_page, offset)).fetchall()
    conn.close()
    
    result = []
    for p in photos:
        ext = Path(p['filename']).suffix.lower().lstrip('.')
        item = {
            'id': p['id'],
            'path': p['path'],
            'filename': p['filename'],
            'media_type': p['media_type'],
            'format': ext.upper(),
            'date_taken': p['date_taken'],
            'width': p['width'],
            'height': p['height'],
            'thumbnail_url': f'/thumbnail/{p["id"]}',
            'original_url': f'/photo/{p["id"]}',
            'file_size': p['file_size']
        }
        if p['duration']:
            item['duration'] = format_duration(p['duration'])
        result.append(item)
    
    return jsonify({
        'photos': result,
        'page': page,
        'per_page': per_page,
        'total': total,
        'has_more': offset + len(result) < total
    })


@app.route('/thumbnail/<int:photo_id>')
def thumbnail(photo_id):
    conn = get_db()
    photo = conn.execute('SELECT thumbnail_path FROM photos WHERE id = ?', (photo_id,)).fetchone()
    conn.close()
    if photo and os.path.exists(photo['thumbnail_path']):
        return send_file(photo['thumbnail_path'])
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
        converted_path = CONVERTED_DIR / f'{photo_id}.jpg'
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


@app.route('/api/photo/<int:photo_id>/delete', methods=['POST'])
def delete_photo(photo_id):
    conn = get_db()
    photo = conn.execute('SELECT * FROM photos WHERE id = ?', (photo_id,)).fetchone()
    if not photo:
        conn.close()
        return jsonify({'error': 'Photo not found'}), 404
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    trash_filename = f"{timestamp}_{photo['filename']}"
    trash_path = TRASH_DIR / trash_filename
    
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
        trash_filename = f"{timestamp}_{photo['filename']}"
        trash_path = TRASH_DIR / trash_filename
        
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
    conn = get_db()
    photos = conn.execute('SELECT id, path, filename, file_size FROM photos WHERE media_type = "image"').fetchall()
    conn.close()
    
    size_groups = {}
    for p in photos:
        size = p['file_size']
        if size not in size_groups:
            size_groups[size] = []
        size_groups[size].append(p)
    
    duplicates = []
    for size, group in size_groups.items():
        if len(group) < 2:
            continue
        
        hashes = {}
        for p in group:
            img_hash = compute_image_hash(p['path'])
            if img_hash:
                if img_hash not in hashes:
                    hashes[img_hash] = []
                hashes[img_hash].append(p)
        
        for img_hash, dup_group in hashes.items():
            if len(dup_group) >= 2:
                duplicates.append({
                    'hash': img_hash,
                    'photos': [{
                        'id': p['id'],
                        'filename': p['filename'],
                        'path': p['path'],
                        'thumbnail_url': f'/thumbnail/{p["id"]}'
                    } for p in dup_group]
                })
    
    return jsonify({
        'duplicate_groups': duplicates,
        'total_duplicates': sum(len(g['photos']) for g in duplicates)
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
        
        scan_photos()
        
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


if __name__ == '__main__':
    init_db()
    scan_photos()
    clean_expired_trash()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    app.run(debug=True, port=port)

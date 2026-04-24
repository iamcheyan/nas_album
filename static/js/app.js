let allPhotos = [];
let currentPage = 1;
let isLoading = false;
let hasMore = true;
let currentIndex = 0;

let selectionMode = false;
let selectedPhotos = new Set();

const PER_PAGE = 50;

// ========== 自定义对话框系统 ==========
function showDialog(options) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('custom-dialog');
        const icon = document.getElementById('dialog-icon');
        const title = document.getElementById('dialog-title');
        const message = document.getElementById('dialog-message');
        const actions = document.getElementById('dialog-actions');
        const confirmBtn = document.getElementById('dialog-confirm');
        const cancelBtn = document.getElementById('dialog-cancel');

        icon.textContent = options.icon || '⚠️';
        title.textContent = options.title || '提示';
        message.innerHTML = options.message || '';

        // 重置按钮
        actions.innerHTML = '';

        if (options.type === 'confirm') {
            const cancel = document.createElement('button');
            cancel.className = 'btn btn-secondary';
            cancel.textContent = options.cancelText || '取消';
            cancel.onclick = () => {
                dialog.classList.add('hidden');
                resolve(false);
            };

            const confirm = document.createElement('button');
            confirm.className = options.confirmClass || 'btn btn-primary';
            confirm.textContent = options.confirmText || '确定';
            confirm.onclick = () => {
                dialog.classList.add('hidden');
                resolve(true);
            };

            actions.appendChild(cancel);
            actions.appendChild(confirm);
        } else {
            const confirm = document.createElement('button');
            confirm.className = 'btn btn-primary';
            confirm.textContent = options.confirmText || '确定';
            confirm.onclick = () => {
                dialog.classList.add('hidden');
                resolve(true);
            };
            actions.appendChild(confirm);
        }

        dialog.classList.remove('hidden');
    });
}

function showToast(message, duration = 2000) {
    const toast = document.getElementById('toast');
    const msg = document.getElementById('toast-message');
    msg.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => {
        toast.classList.add('hidden');
    }, duration);
}

// ========== 缩略图尺寸调节 ==========
let thumbSize = parseInt(localStorage.getItem('thumbSize')) || 200;

function applyThumbSize(size) {
    thumbSize = size;
    localStorage.setItem('thumbSize', size);
    document.getElementById('thumb-size-slider').value = size;
    document.getElementById('thumb-size-value').textContent = size + 'px';

    // 更新所有网格
    document.querySelectorAll('.photo-grid').forEach(grid => {
        grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
    });
}

function initThumbSizeControl() {
    const slider = document.getElementById('thumb-size-slider');
    applyThumbSize(thumbSize);

    slider.addEventListener('input', (e) => {
        applyThumbSize(parseInt(e.target.value));
    });
}

// 创建照片元素时应用当前尺寸
function createPhotoElement(photo) {
    const div = document.createElement('div');
    div.className = 'photo-item';
    div.dataset.id = photo.id;

    const checkbox = document.createElement('div');
    checkbox.className = 'photo-checkbox';
    checkbox.innerHTML = '✓';
    div.appendChild(checkbox);

    // 格式角标
    const badge = document.createElement('div');
    badge.className = `format-badge ${photo.media_type}`;
    badge.textContent = photo.format;
    div.appendChild(badge);

    // 视频时长
    if (photo.media_type === 'video' && photo.duration) {
        const duration = document.createElement('div');
        duration.className = 'video-duration';
        duration.innerHTML = `▶ ${photo.duration}`;
        div.appendChild(duration);
    }

    // 视频播放按钮
    if (photo.media_type === 'video') {
        const playBtn = document.createElement('div');
        playBtn.className = 'video-play-btn';
        playBtn.innerHTML = '▶';
        div.appendChild(playBtn);
    }

    const img = document.createElement('img');
    img.src = photo.thumbnail_url;
    img.alt = photo.filename;
    img.loading = 'lazy';

    const dateDiv = document.createElement('div');
    dateDiv.className = 'photo-date';
    dateDiv.textContent = formatDate(photo.date_taken).time;

    div.appendChild(img);
    div.appendChild(dateDiv);

    div.addEventListener('click', (e) => {
        if (selectionMode || e.shiftKey) {
            toggleSelection(photo.id, div);
        } else {
            openLightbox(photo.id);
        }
    });

    let longPressTimer;
    div.addEventListener('touchstart', (e) => {
        longPressTimer = setTimeout(() => {
            if (!selectionMode) {
                enableSelectionMode();
                toggleSelection(photo.id, div);
            }
        }, 500);
    }, { passive: true });

    div.addEventListener('touchend', () => {
        clearTimeout(longPressTimer);
    });

    return div;
}

function toggleSelection(photoId, element) {
    photoId = parseInt(photoId);
    if (selectedPhotos.has(photoId)) {
        selectedPhotos.delete(photoId);
        element.classList.remove('selected');
    } else {
        selectedPhotos.add(photoId);
        element.classList.add('selected');
    }
    updateSelectionUI();
}

function enableSelectionMode() {
    selectionMode = true;
    document.body.classList.add('selection-mode');
    document.getElementById('selection-bar').classList.add('visible');
}

function disableSelectionMode() {
    selectionMode = false;
    selectedPhotos.clear();
    document.body.classList.remove('selection-mode');
    document.getElementById('selection-bar').classList.remove('visible');
    document.querySelectorAll('.photo-item.selected').forEach(el => {
        el.classList.remove('selected');
    });
}

function updateSelectionUI() {
    const count = selectedPhotos.size;
    document.getElementById('selection-count').textContent = `已选择 ${count} 张`;
    document.getElementById('batch-delete-btn').disabled = count === 0;
}

async function batchDelete() {
    if (selectedPhotos.size === 0) return;

    const confirmed = await showDialog({
        type: 'confirm',
        icon: '🗑️',
        title: '确认删除',
        message: `确定要删除选中的 <strong>${selectedPhotos.size}</strong> 个文件吗？<br><br>删除后可在回收站中恢复（保留30天）。`,
        confirmText: '删除',
        confirmClass: 'btn btn-danger',
        cancelText: '取消'
    });

    if (!confirmed) return;

    try {
        const response = await fetch('/api/photos/batch_delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photo_ids: Array.from(selectedPhotos) })
        });

        const data = await response.json();
        if (data.success) {
            selectedPhotos.forEach(id => {
                const el = document.querySelector(`.photo-item[data-id="${id}"]`);
                if (el) el.remove();
            });
            disableSelectionMode();
            showToast(`成功删除 ${data.deleted_count} 个文件`);
        }
    } catch (err) {
        console.error('批量删除失败:', err);
        showToast('删除失败');
    }
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        time: date.toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        })
    };
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function renderPhotos(photos) {
    const timeline = document.getElementById('timeline');

    photos.forEach(photo => {
        const { year, month } = formatDate(photo.date_taken);
        const yearKey = `year-${year}`;
        const monthKey = `month-${year}-${month}`;

        let yearGroup = document.getElementById(yearKey);
        if (!yearGroup) {
            yearGroup = document.createElement('div');
            yearGroup.id = yearKey;
            yearGroup.className = 'year-group';

            const yearLabel = document.createElement('div');
            yearLabel.className = 'year-label';
            yearLabel.innerHTML = `<span>${year}年</span>`;
            yearGroup.appendChild(yearLabel);

            insertYearGroup(timeline, yearGroup, year);
        }

        let monthGrid = document.getElementById(monthKey);
        if (!monthGrid) {
            const monthLabel = document.createElement('div');
            monthLabel.className = 'month-label';
            monthLabel.innerHTML = `<span>${month}月</span>`;

            monthGrid = document.createElement('div');
            monthGrid.id = monthKey;
            monthGrid.className = 'photo-grid';
            // 应用当前缩略图尺寸
            monthGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`;

            yearGroup.appendChild(monthLabel);
            yearGroup.appendChild(monthGrid);
        }

        monthGrid.appendChild(createPhotoElement(photo));
    });
}

function insertYearGroup(timeline, newGroup, year) {
    const existingGroups = timeline.querySelectorAll('.year-group');
    let inserted = false;

    for (const group of existingGroups) {
        const groupYear = parseInt(group.id.replace('year-', ''));
        if (year > groupYear) {
            timeline.insertBefore(newGroup, group);
            inserted = true;
            break;
        }
    }

    if (!inserted) {
        timeline.appendChild(newGroup);
    }
}

async function loadPhotos() {
    if (isLoading || !hasMore) return;

    isLoading = true;
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        const response = await fetch(`/api/photos?page=${currentPage}&per_page=${PER_PAGE}`);
        const data = await response.json();

        allPhotos = allPhotos.concat(data.photos);
        hasMore = data.has_more;

        renderPhotos(data.photos);

        const imageCount = allPhotos.filter(p => p.media_type === 'image').length;
        const videoCount = allPhotos.filter(p => p.media_type === 'video').length;
        document.getElementById('stats').textContent =
            `共 ${data.total} 个文件（${imageCount} 张照片 · ${videoCount} 个视频）· 已加载 ${allPhotos.length}`;

        currentPage++;
    } catch (err) {
        console.error('加载失败:', err);
    } finally {
        isLoading = false;
        loadingEl.classList.remove('visible');
    }
}

function setupInfiniteScroll() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting && hasMore && !isLoading) {
                loadPhotos();
            }
        });
    }, { rootMargin: '200px' });

    observer.observe(document.getElementById('loading'));
}

// 灯箱
function openLightbox(photoId) {
    photoId = parseInt(photoId);
    const photo = allPhotos.find(p => p.id === photoId);
    if (!photo) {
        console.error('Photo not found:', photoId);
        return;
    }

    currentIndex = allPhotos.findIndex(p => p.id === photoId);

    const lightbox = document.getElementById('lightbox');
    const imgContainer = document.getElementById('lightbox-media-container');
    const dateSpan = document.getElementById('lightbox-date');
    const sizeSpan = document.getElementById('lightbox-size');
    const pathSpan = document.getElementById('lightbox-path');
    const indexSpan = document.getElementById('lightbox-index');
    const typeSpan = document.getElementById('lightbox-type');

    // 清空容器
    imgContainer.innerHTML = '';

    if (photo.media_type === 'video') {
        const video = document.createElement('video');
        video.src = photo.original_url;
        video.controls = true;
        video.autoplay = true;
        video.style.maxWidth = '90%';
        video.style.maxHeight = '70vh';
        imgContainer.appendChild(video);
        typeSpan.textContent = `🎬 视频 · ${photo.format}`;
    } else {
        const img = document.createElement('img');
        img.src = photo.original_url;
        img.alt = photo.filename;
        img.style.maxWidth = '90%';
        img.style.maxHeight = '70vh';
        imgContainer.appendChild(img);
        typeSpan.textContent = `📷 图片 · ${photo.format}`;
    }

    dateSpan.textContent = formatDate(photo.date_taken).time;
    sizeSpan.textContent = formatSize(photo.file_size);
    pathSpan.textContent = photo.path;
    indexSpan.textContent = `${currentIndex + 1} / ${allPhotos.length}`;

    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function closeLightbox() {
    const lightbox = document.getElementById('lightbox');
    const container = document.getElementById('lightbox-media-container');

    const video = container.querySelector('video');
    if (video) {
        video.pause();
        video.src = '';
    }

    lightbox.classList.add('hidden');
    document.body.style.overflow = '';
}

function showNext() {
    if (currentIndex < allPhotos.length - 1) {
        currentIndex++;
        openLightbox(allPhotos[currentIndex].id);
    }
}

function showPrev() {
    if (currentIndex > 0) {
        currentIndex--;
        openLightbox(allPhotos[currentIndex].id);
    }
}

async function deleteCurrentPhoto() {
    if (allPhotos.length === 0) return;

    const photo = allPhotos[currentIndex];
    const typeName = photo.media_type === 'video' ? '视频' : '照片';

    const confirmed = await showDialog({
        type: 'confirm',
        icon: '🗑️',
        title: `删除${typeName}`,
        message: `确定要删除这个${typeName}吗？<br><br><code>${photo.filename}</code><br><br>删除后可在回收站中恢复（保留30天）。`,
        confirmText: '删除',
        confirmClass: 'btn btn-danger',
        cancelText: '取消'
    });

    if (!confirmed) return;

    try {
        const response = await fetch(`/api/photo/${photo.id}/delete`, {
            method: 'POST'
        });

        const data = await response.json();
        if (data.success) {
            const el = document.querySelector(`.photo-item[data-id="${photo.id}"]`);
            if (el) el.remove();

            allPhotos.splice(currentIndex, 1);

            if (allPhotos.length === 0) {
                closeLightbox();
            } else if (currentIndex >= allPhotos.length) {
                currentIndex = allPhotos.length - 1;
                openLightbox(allPhotos[currentIndex].id);
            } else {
                openLightbox(allPhotos[currentIndex].id);
            }
        }
    } catch (err) {
        console.error('删除失败:', err);
        showToast('删除失败');
    }
}

// 事件监听
document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target.id === 'lightbox' || e.target.classList.contains('close')) {
        closeLightbox();
    }
    if (e.target.classList.contains('prev')) {
        showPrev();
    }
    if (e.target.classList.contains('next')) {
        showNext();
    }
});

document.addEventListener('keydown', (e) => {
    const lightbox = document.getElementById('lightbox');

    if (!lightbox.classList.contains('hidden')) {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowRight') showNext();
        if (e.key === 'ArrowLeft') showPrev();
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            deleteCurrentPhoto();
        }
        const video = document.querySelector('#lightbox-media-container video');
        if (video && e.key === ' ') {
            e.preventDefault();
            if (video.paused) video.play();
            else video.pause();
        }
    }

    if (e.key === 'Escape' && selectionMode) {
        disableSelectionMode();
    }
});

// 触摸滑动
let touchStartX = 0;
let touchEndX = 0;

document.getElementById('lightbox').addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

document.getElementById('lightbox').addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
}, { passive: true });

function handleSwipe() {
    const swipeThreshold = 50;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) > swipeThreshold) {
        if (diff > 0) {
            showNext();
        } else {
            showPrev();
        }
    }
}

// 拖选框选
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragBox = null;

document.addEventListener('mousedown', (e) => {
    if (!selectionMode) return;
    if (e.target.closest('.photo-item') || e.target.closest('.btn') || e.target.closest('.lightbox') || e.target.closest('.custom-dialog')) return;

    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;

    dragBox = document.createElement('div');
    dragBox.className = 'drag-selection-box';
    dragBox.style.left = dragStartX + 'px';
    dragBox.style.top = dragStartY + 'px';
    document.body.appendChild(dragBox);
});

document.addEventListener('mousemove', (e) => {
    if (!isDragging || !dragBox) return;

    const x = Math.min(dragStartX, e.clientX);
    const y = Math.min(dragStartY, e.clientY);
    const w = Math.abs(e.clientX - dragStartX);
    const h = Math.abs(e.clientY - dragStartY);

    dragBox.style.left = x + 'px';
    dragBox.style.top = y + 'px';
    dragBox.style.width = w + 'px';
    dragBox.style.height = h + 'px';

    const boxRect = { left: x, top: y, right: x + w, bottom: y + h };
    document.querySelectorAll('.photo-item').forEach(el => {
        const r = el.getBoundingClientRect();
        const intersects = !(r.right < boxRect.left || r.left > boxRect.right ||
                             r.bottom < boxRect.top || r.top > boxRect.bottom);
        if (intersects) {
            el.classList.add('drag-highlight');
        } else {
            el.classList.remove('drag-highlight');
        }
    });
});

document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;

    if (dragBox) {
        document.querySelectorAll('.photo-item.drag-highlight').forEach(el => {
            const id = parseInt(el.dataset.id);
            if (!selectedPhotos.has(id)) {
                selectedPhotos.add(id);
                el.classList.add('selected');
            }
            el.classList.remove('drag-highlight');
        });
        dragBox.remove();
        dragBox = null;
        updateSelectionUI();
    }
});

// 初始化
document.getElementById('select-mode-btn').addEventListener('click', enableSelectionMode);
document.getElementById('cancel-selection-btn').addEventListener('click', disableSelectionMode);
document.getElementById('batch-delete-btn').addEventListener('click', batchDelete);

function init() {
    initThumbSizeControl();
    loadPhotos();
    setupInfiniteScroll();
}

init();

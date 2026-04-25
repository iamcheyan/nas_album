let allPhotos = [];
let filteredPhotos = [];
let currentPage = 1;
let isLoading = false;
let hasMore = true;
let currentIndex = 0;

let selectionMode = false;
let selectedPhotos = new Set();

let currentView = 'all';
let currentTab = 'all';
let currentYearFilter = null;
let searchQuery = '';

const PER_PAGE = 50;

// ========== 自定义对话框系统 ==========
function showDialog(options) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('custom-dialog');
        const icon = document.getElementById('dialog-icon');
        const title = document.getElementById('dialog-title');
        const message = document.getElementById('dialog-message');
        const actions = document.getElementById('dialog-actions');

        icon.textContent = options.icon || '⚠️';
        title.textContent = options.title || '提示';
        message.innerHTML = options.message || '';

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

// ========== 侧边栏 ==========
function initSidebar() {
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    const overlay = document.getElementById('sidebar-overlay');

    toggle.addEventListener('click', () => {
        sidebar.classList.toggle('open');
        overlay.classList.toggle('visible', sidebar.classList.contains('open'));
    });

    overlay.addEventListener('click', () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('visible');
    });

    document.querySelectorAll('.sidebar-item[data-view]').forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
            document.querySelectorAll('.sidebar-item[data-view]').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            if (window.innerWidth <= 767) {
                sidebar.classList.remove('open');
                overlay.classList.remove('visible');
            }
        });
    });
}

function switchView(view) {
    currentView = view;
    currentYearFilter = null;
    resetPhotos();

    const titles = {
        all: '全部照片',
        photos: '照片',
        videos: '视频',
        favorites: '收藏',
        recent: '最近添加',
        trash: '最近删除'
    };
    document.getElementById('view-title').textContent = titles[view] || '全部照片';

    if (view === 'trash') {
        loadTrash();
    } else {
        loadPhotos();
    }
}

// ========== 顶部 Tab ==========
function initTopTabs() {
    document.querySelectorAll('.top-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.top-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            currentTab = tab.dataset.tab;
            switchTab(currentTab);
        });
    });
}

function switchTab(tab) {
    const timeline = document.getElementById('timeline');
    const loading = document.getElementById('loading');
    const viewHeader = document.querySelector('.view-header');

    if (tab === 'map') {
        timeline.innerHTML = `
            <div class="map-placeholder">
                <div class="placeholder-icon">🗺️</div>
                <h2>地图视图</h2>
                <p>根据照片的 GPS 信息在地图上展示拍摄位置。<br>（功能开发中）</p>
            </div>
        `;
        loading.classList.remove('visible');
        viewHeader.style.display = 'none';
        updateStatus(0, 0);
        return;
    }

    if (tab === 'dbinfo') {
        loadDbInfo();
        loading.classList.remove('visible');
        viewHeader.style.display = 'none';
        return;
    }

    viewHeader.style.display = 'flex';

    if (tab === 'years') {
        loadYearsView();
        return;
    }

    // all tab
    resetPhotos();
    loadPhotos();
}

// ========== 年份视图 ==========
function loadYearsView() {
    const timeline = document.getElementById('timeline');
    const loading = document.getElementById('loading');
    const viewTitle = document.getElementById('view-title');
    viewTitle.textContent = '按年份浏览';
    loading.classList.remove('visible');

    const yearMap = {};
    allPhotos.forEach(p => {
        const year = formatDate(p.date_taken).year;
        if (!yearMap[year]) yearMap[year] = 0;
        yearMap[year]++;
    });

    const years = Object.keys(yearMap).sort((a, b) => b - a);

    if (years.length === 0) {
        timeline.innerHTML = '<div style="text-align:center;padding:60px;color:#666">暂无照片</div>';
        updateStatus(0, 0);
        return;
    }

    let html = '<div class="years-view"><div class="years-grid">';
    years.forEach(year => {
        html += `
            <div class="year-card" data-year="${year}">
                <div class="year-number">${year}</div>
                <div class="year-count">${yearMap[year]} 个项目</div>
            </div>
        `;
    });
    html += '</div></div>';
    timeline.innerHTML = html;
    updateStatus(allPhotos.length, selectedPhotos.size);

    document.querySelectorAll('.year-card').forEach(card => {
        card.addEventListener('click', () => {
            const year = card.dataset.year;
            currentYearFilter = parseInt(year);
            document.querySelectorAll('.top-tab').forEach(t => t.classList.remove('active'));
            document.querySelector('.top-tab[data-tab="all"]').classList.add('active');
            currentTab = 'all';
            document.getElementById('view-title').textContent = `${year}年`;
            resetPhotos();
            loadPhotos();
        });
    });
}

// ========== 数据库信息 ==========
async function loadDbInfo() {
    const timeline = document.getElementById('timeline');
    const viewTitle = document.getElementById('view-title');
    viewTitle.textContent = '数据库信息';

    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();

        timeline.innerHTML = `
            <div class="dbinfo-placeholder">
                <div class="placeholder-icon">🗄️</div>
                <h2>数据库统计</h2>
                <table class="dbinfo-table">
                    <tr><th>总项目数</th><td>${stats.total || 0}</td></tr>
                    <tr><th>照片</th><td>${stats.photos || 0}</td></tr>
                    <tr><th>视频</th><td>${stats.videos || 0}</td></tr>
                    <tr><th>回收站</th><td>${stats.trash || 0}</td></tr>
                    <tr><th>来源路径数</th><td>${stats.sources || 0}</td></tr>
                    <tr><th>最早照片</th><td>${stats.oldest || '-'}</td></tr>
                    <tr><th>最新照片</th><td>${stats.newest || '-'}</td></tr>
                    <tr><th>数据库大小</th><td>${formatSize(stats.db_size || 0)}</td></tr>
                </table>
            </div>
        `;
        updateStatus(0, 0);
    } catch (err) {
        timeline.innerHTML = `
            <div class="dbinfo-placeholder">
                <div class="placeholder-icon">⚠️</div>
                <h2>无法加载统计信息</h2>
                <p>请检查服务器连接</p>
            </div>
        `;
    }
}

// ========== 搜索 ==========
function initSearch() {
    const input = document.getElementById('search-input');
    let debounceTimer;
    input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            searchQuery = e.target.value.trim().toLowerCase();
            if (searchQuery) {
                resetPhotos();
                document.getElementById('view-title').textContent = `搜索: "${e.target.value}"`;
                loadPhotos();
            } else {
                resetPhotos();
                document.getElementById('view-title').textContent = '全部照片';
                loadPhotos();
            }
        }, 300);
    });
}

// ========== 照片元素创建 ==========
function createPhotoElement(photo) {
    const div = document.createElement('div');
    div.className = 'photo-item';
    div.dataset.id = photo.id;

    const checkbox = document.createElement('div');
    checkbox.className = 'photo-checkbox';
    checkbox.innerHTML = '✓';
    div.appendChild(checkbox);

    const badge = document.createElement('div');
    badge.className = `format-badge ${photo.media_type}`;
    badge.textContent = photo.format;
    div.appendChild(badge);

    if (photo.media_type === 'video' && photo.duration) {
        const duration = document.createElement('div');
        duration.className = 'video-duration';
        duration.innerHTML = `▶ ${photo.duration}`;
        div.appendChild(duration);
    }

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
    updateStatus(filteredPhotos.length, 0);
}

function updateSelectionUI() {
    const count = selectedPhotos.size;
    document.getElementById('selection-count').textContent = `已选择 ${count} 张`;
    document.getElementById('batch-delete-btn').disabled = count === 0;
    updateStatus(filteredPhotos.length, count);
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
            allPhotos = allPhotos.filter(p => !selectedPhotos.has(p.id));
            filteredPhotos = filteredPhotos.filter(p => !selectedPhotos.has(p.id));
            disableSelectionMode();
            showToast(`成功删除 ${data.deleted_count} 个文件`);
            loadStats();
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
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
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
            yearLabel.textContent = `${year}年`;
            yearGroup.appendChild(yearLabel);

            insertYearGroup(timeline, yearGroup, year);
        }

        let monthGrid = document.getElementById(monthKey);
        if (!monthGrid) {
            const monthLabel = document.createElement('div');
            monthLabel.className = 'month-label';
            monthLabel.textContent = `${month}月`;

            monthGrid = document.createElement('div');
            monthGrid.id = monthKey;
            monthGrid.className = 'photo-grid';
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

function getFilteredPhotos() {
    let photos = allPhotos;

    if (currentView === 'photos') {
        photos = photos.filter(p => p.media_type === 'image');
    } else if (currentView === 'videos') {
        photos = photos.filter(p => p.media_type === 'video');
    } else if (currentView === 'favorites') {
        photos = photos.filter(p => p.favorite);
    } else if (currentView === 'recent') {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        photos = photos.filter(p => new Date(p.date_taken) >= thirtyDaysAgo);
    }

    if (currentYearFilter) {
        photos = photos.filter(p => formatDate(p.date_taken).year === currentYearFilter);
    }

    if (searchQuery) {
        photos = photos.filter(p =>
            p.filename.toLowerCase().includes(searchQuery) ||
            formatDate(p.date_taken).time.includes(searchQuery)
        );
    }

    return photos;
}

function resetPhotos() {
    currentPage = 1;
    hasMore = true;
    filteredPhotos = [];
    document.getElementById('timeline').innerHTML = '';
}

async function loadPhotos() {
    if (isLoading || !hasMore) return;
    if (currentTab !== 'all' && currentTab !== 'years') return;

    isLoading = true;
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        const response = await fetch(`/api/photos?page=${currentPage}&per_page=${PER_PAGE}`);
        const data = await response.json();

        if (currentPage === 1) {
            allPhotos = data.photos;
        } else {
            allPhotos = allPhotos.concat(data.photos);
        }

        filteredPhotos = getFilteredPhotos();
        hasMore = data.has_more;

        renderPhotos(data.photos);
        updateStatus(data.total, selectedPhotos.size);

        currentPage++;
    } catch (err) {
        console.error('加载失败:', err);
    } finally {
        isLoading = false;
        loadingEl.classList.remove('visible');
    }
}

async function loadTrash() {
    const timeline = document.getElementById('timeline');
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        const response = await fetch('/api/trash');
        const items = await response.json();

        timeline.innerHTML = '';
        if (items.length === 0) {
            timeline.innerHTML = '<div style="text-align:center;padding:60px;color:#666">回收站为空</div>';
        } else {
            const grid = document.createElement('div');
            grid.className = 'photo-grid';
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`;

            items.forEach(item => {
                const div = document.createElement('div');
                div.className = 'photo-item';
                div.innerHTML = `
                    <div class="photo-date" style="opacity:1">${item.filename}<br>剩余 ${item.days_remaining} 天</div>
                `;
                // 没有缩略图时显示占位
                const img = document.createElement('img');
                img.src = '/static/favicon.ico';
                img.alt = item.filename;
                img.style.opacity = '0.3';
                div.insertBefore(img, div.firstChild);
                grid.appendChild(div);
            });
            timeline.appendChild(grid);
        }
        updateStatus(items.length, 0);
    } catch (err) {
        console.error('加载回收站失败:', err);
    } finally {
        loadingEl.classList.remove('visible');
    }
}

function setupInfiniteScroll() {
    const timeline = document.getElementById('timeline');
    timeline.addEventListener('scroll', () => {
        if (isLoading || !hasMore) return;
        if (currentTab !== 'all') return;
        if (currentView === 'trash') return;

        const scrollBottom = timeline.scrollTop + timeline.clientHeight;
        const threshold = timeline.scrollHeight - 400;
        if (scrollBottom >= threshold) {
            loadPhotos();
        }
    });
}

// ========== 灯箱 ==========
function openLightbox(photoId) {
    photoId = parseInt(photoId);
    const photo = filteredPhotos.find(p => p.id === photoId);
    if (!photo) {
        console.error('Photo not found:', photoId);
        return;
    }

    currentIndex = filteredPhotos.findIndex(p => p.id === photoId);

    const lightbox = document.getElementById('lightbox');
    const imgContainer = document.getElementById('lightbox-media-container');
    const dateSpan = document.getElementById('lightbox-date');
    const sizeSpan = document.getElementById('lightbox-size');
    const pathSpan = document.getElementById('lightbox-path');
    const indexSpan = document.getElementById('lightbox-index');
    const typeSpan = document.getElementById('lightbox-type');

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
    indexSpan.textContent = `${currentIndex + 1} / ${filteredPhotos.length}`;

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
    if (currentIndex < filteredPhotos.length - 1) {
        currentIndex++;
        openLightbox(filteredPhotos[currentIndex].id);
    }
}

function showPrev() {
    if (currentIndex > 0) {
        currentIndex--;
        openLightbox(filteredPhotos[currentIndex].id);
    }
}

async function deleteCurrentPhoto() {
    if (filteredPhotos.length === 0) return;

    const photo = filteredPhotos[currentIndex];
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

            allPhotos = allPhotos.filter(p => p.id !== photo.id);
            filteredPhotos = filteredPhotos.filter(p => p.id !== photo.id);

            if (filteredPhotos.length === 0) {
                closeLightbox();
            } else if (currentIndex >= filteredPhotos.length) {
                currentIndex = filteredPhotos.length - 1;
                openLightbox(filteredPhotos[currentIndex].id);
            } else {
                openLightbox(filteredPhotos[currentIndex].id);
            }
            loadStats();
        }
    } catch (err) {
        console.error('删除失败:', err);
        showToast('删除失败');
    }
}

// ========== 状态栏 ==========
function updateStatus(total, selected) {
    const text = selected > 0
        ? `共 ${total} 个项目 | 选中 ${selected} 个`
        : `共 ${total} 个项目`;
    document.getElementById('status-text').textContent = text;
}

// ========== 统计与侧边栏数据 ==========
async function loadStats() {
    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();
        document.getElementById('count-all').textContent = stats.total || '';
        document.getElementById('count-photos').textContent = stats.photos || '';
        document.getElementById('count-videos').textContent = stats.videos || '';
        document.getElementById('count-favorites').textContent = stats.favorites || '';
        document.getElementById('count-trash').textContent = stats.trash || '';
    } catch (err) {
        console.error('加载统计失败:', err);
    }
}

async function loadSources() {
    try {
        const response = await fetch('/api/sources');
        const sources = await response.json();
        const list = document.getElementById('sources-list');
        list.innerHTML = '';
        sources.forEach(src => {
            const li = document.createElement('li');
            li.className = 'sidebar-item';
            li.dataset.source = src.path;
            li.innerHTML = `
                <span class="sidebar-icon">💾</span>
                <span class="sidebar-label" title="${src.path}">${src.name}</span>
                <span class="sidebar-count">${src.count}</span>
            `;
            li.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
                li.classList.add('active');
                document.getElementById('view-title').textContent = src.name;
                resetPhotos();
                // 来源筛选通过 API 参数实现
                loadPhotosBySource(src.path);
            });
            list.appendChild(li);
        });
    } catch (err) {
        console.error('加载来源失败:', err);
    }
}

async function loadPhotosBySource(sourcePath) {
    if (isLoading) return;
    isLoading = true;
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        const response = await fetch(`/api/photos?source=${encodeURIComponent(sourcePath)}&page=1&per_page=9999`);
        const data = await response.json();
        allPhotos = data.photos;
        filteredPhotos = allPhotos;
        renderPhotos(data.photos);
        updateStatus(data.total, 0);
        hasMore = false;
    } catch (err) {
        console.error('加载来源照片失败:', err);
    } finally {
        isLoading = false;
        loadingEl.classList.remove('visible');
    }
}

async function loadAlbums() {
    try {
        const response = await fetch('/api/albums');
        const albums = await response.json();
        const list = document.getElementById('albums-list');
        list.innerHTML = '';
        albums.forEach(album => {
            const li = document.createElement('li');
            li.className = 'sidebar-item';
            li.dataset.album = album.id;
            li.innerHTML = `
                <span class="sidebar-icon">📁</span>
                <span class="sidebar-label">${album.name}</span>
                <span class="sidebar-count">${album.count || 0}</span>
            `;
            li.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
                li.classList.add('active');
                document.getElementById('view-title').textContent = album.name;
                resetPhotos();
                loadPhotosByAlbum(album.id);
            });
            list.appendChild(li);
        });
    } catch (err) {
        console.error('加载相册失败:', err);
    }
}

async function loadPhotosByAlbum(albumId) {
    if (isLoading) return;
    isLoading = true;
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        const response = await fetch(`/api/albums/${albumId}/photos`);
        const data = await response.json();
        allPhotos = data.photos;
        filteredPhotos = allPhotos;
        renderPhotos(data.photos);
        updateStatus(data.photos.length, 0);
        hasMore = false;
    } catch (err) {
        console.error('加载相册照片失败:', err);
    } finally {
        isLoading = false;
        loadingEl.classList.remove('visible');
    }
}

// ========== 事件监听 ==========
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

// ========== 初始化 ==========
document.getElementById('select-mode-btn').addEventListener('click', enableSelectionMode);
document.getElementById('cancel-selection-btn').addEventListener('click', disableSelectionMode);
document.getElementById('batch-delete-btn').addEventListener('click', batchDelete);
document.getElementById('settings-btn').addEventListener('click', () => {
    showToast('设置功能开发中');
});
document.getElementById('new-album-btn').addEventListener('click', () => {
    showToast('新建相册功能开发中');
});

function init() {
    initThumbSizeControl();
    initSidebar();
    initTopTabs();
    initSearch();
    loadPhotos();
    setupInfiniteScroll();
    loadStats();
    loadSources();
    loadAlbums();
}

init();

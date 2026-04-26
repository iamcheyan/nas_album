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
let currentMonthFilter = null;
let currentDayFilter = null;
let searchQuery = '';
let currentSourcePath = '';
let currentAlbumId = null;
let allAlbums = [];
let photoFilterType = 'all';  // 'all' | 'photo' | 'screenshot'

const PER_PAGE = 50;
const SESSION_KEY = 'nas-album-session';

// ========== 自定义对话框系统 ==========
function showDialog(options) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('custom-dialog');
        const icon = document.getElementById('dialog-icon');
        const title = document.getElementById('dialog-title');
        const message = document.getElementById('dialog-message');
        const actions = document.getElementById('dialog-actions');

        icon.innerHTML = options.icon || '<svg width=\"32\" height=\"32\"><use href=\"#icon-alert\"/></svg>';
        title.textContent = options.title || t('dialog.tip');
        message.innerHTML = options.message || '';

        actions.innerHTML = '';

        if (options.type === 'confirm') {
            const cancel = document.createElement('button');
            cancel.className = 'btn btn-secondary';
            cancel.textContent = options.cancelText || t('action.cancel');
            cancel.onclick = () => {
                dialog.classList.add('hidden');
                resolve(false);
            };

            const confirm = document.createElement('button');
            confirm.className = options.confirmClass || 'btn btn-primary';
            confirm.textContent = options.confirmText || t('action.confirm');
            confirm.onclick = () => {
                dialog.classList.add('hidden');
                resolve(true);
            };

            actions.appendChild(cancel);
            actions.appendChild(confirm);
        } else {
            const confirm = document.createElement('button');
            confirm.className = 'btn btn-primary';
            confirm.textContent = options.confirmText || t('action.confirm');
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

    if (virtualTimeline) {
        virtualTimeline.refresh();
    }
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
            document.querySelectorAll('.timeline-month').forEach(i => i.classList.remove('active'));
            document.querySelectorAll('.timeline-year').forEach(i => i.classList.remove('active'));
            document.querySelectorAll('.timeline-day').forEach(i => i.classList.remove('active'));
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
    currentTab = 'all';
    currentYearFilter = null;
    currentMonthFilter = null;
    currentDayFilter = null;
    currentSourcePath = '';
    currentAlbumId = null;
    searchQuery = '';
    resetPhotos();

    const titles = {
        all: t('title.allPhotos'),
        photos: t('title.photos'),
        videos: t('title.videos'),
        favorites: t('title.favorites'),
        recent: t('title.recent'),
        trash: t('title.trash'),
        hidden: t('title.hiddenPhotos'),
        duplicates: t('title.duplicates')
    };
    document.getElementById('view-title').textContent = titles[view] || t('title.allPhotos');

    // Update top tabs to show "all" tab active
    document.querySelectorAll('.top-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.top-tab[data-tab="all"]').classList.add('active');

    // Toggle select-mode-btn vs dup-cleanup-action-btn based on view
    const selectModeBtn = document.getElementById('select-mode-btn');
    const dupCleanupActionBtn = document.getElementById('dup-cleanup-action-btn');
    if (selectModeBtn && dupCleanupActionBtn) {
        if (view === 'duplicates') {
            selectModeBtn.classList.add('hidden');
            dupCleanupActionBtn.classList.remove('hidden');
        } else {
            selectModeBtn.classList.remove('hidden');
            dupCleanupActionBtn.classList.add('hidden');
        }
    }

    if (view === 'trash') {
        loadTrash();
    } else if (view === 'hidden') {
        loadHiddenPhotos();
    } else if (view === 'duplicates') {
        loadDuplicates();
    } else if (view === 'photos' || view === 'videos' || view === 'favorites' || view === 'recent') {
        // 过滤视图：先加载全部数据，然后过滤渲染
        loadFilteredPhotos(view);
    } else {
        loadPhotos();
    }
    updateDuplicatesBar();
    saveSession();
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

let mapInstance = null;
let mapMarkers = [];

function initMap(savedState) {
    const timeline = document.getElementById('timeline');
    timeline.innerHTML = '<div id="map-container"></div>';

    // Use saved map state if available, otherwise default world view
    const defaultCenter = [20, 0];
    const defaultZoom = 2;
    const center = savedState ? [savedState.lat, savedState.lng] : defaultCenter;
    const zoom = savedState ? savedState.zoom : defaultZoom;

    const map = L.map('map-container', {
        zoomControl: false
    }).setView(center, zoom);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    const providerId = getMapProvider();
    const layer = MAP_PROVIDERS[providerId] || MAP_PROVIDERS['osm'];
    currentTileLayer = L.tileLayer(layer.url, {
        attribution: layer.attribution,
        subdomains: layer.subdomains,
        maxZoom: layer.maxZoom
    }).addTo(map);

    // Listen for moveend/zoomend to save map state
    map.on('moveend', saveSession);
    map.on('zoomend', saveSession);

    return map;
}

async function loadMapView(savedMapState) {
    const timeline = document.getElementById('timeline');
    const loading = document.getElementById('loading');
    const viewHeader = document.querySelector('.view-header');

    viewHeader.style.display = 'none';
    loading.classList.remove('visible');

    if (!mapInstance) {
        mapInstance = initMap(savedMapState);
    } else {
        timeline.innerHTML = '<div id="map-container"></div>';
        mapInstance.getContainer().remove();
        mapInstance = initMap(savedMapState);
    }

    // Clear existing markers
    mapMarkers = [];

    try {
        const response = await fetch('/api/map/photos?limit=5000');
        const data = await response.json();
        const photos = data.photos || [];

        if (photos.length === 0) {
            timeline.innerHTML = `
                <div class="map-placeholder">
                    <div class="placeholder-icon"><svg width="48" height="48"><use href="#icon-map"/></svg></div>
                    <h2>${t('empty.noGps')}</h2>
                    <p>${t('empty.noGpsDesc')}</p>
                </div>
            `;
            updateStatus(0, 0);
            return;
        }

        const bounds = L.latLngBounds();

        photos.forEach(photo => {
            if (photo.lat == null || photo.lon == null) return;
            const lat = parseFloat(photo.lat);
            const lng = parseFloat(photo.lon);
            if (isNaN(lat) || isNaN(lng)) return;

            const marker = L.marker([lat, lng]);
            const dateStr = photo.date_taken ? formatDate(photo.date_taken).time : '';
            const popupHtml = `
                <div class="map-popup">
                    <img src="${photo.thumbnail_url}" alt="${escapeHtml(photo.filename)}" class="map-popup-thumb" loading="lazy">
                    <div class="map-popup-info">
                        <div class="map-popup-date">${escapeHtml(dateStr)}</div>
                        <div class="map-popup-name" title="${escapeHtml(photo.filename)}">${escapeHtml(photo.filename)}</div>
                    </div>
                </div>
            `;
            marker.bindPopup(popupHtml, {
                className: 'dark-popup',
                closeButton: false
            });
            marker.on('click', () => {
                marker.openPopup();
            });
            marker.addTo(mapInstance);
            mapMarkers.push(marker);
            bounds.extend([lat, lng]);
        });

        // Only fit bounds if no saved map state (first time viewing map)
        if (mapMarkers.length > 0 && !savedMapState) {
            mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        }

        updateStatus(mapMarkers.length, 0);
    } catch (err) {
        console.error(t('empty.mapLoadFailed') + ':', err);
        timeline.innerHTML = `
            <div class="map-placeholder">
                <div class="placeholder-icon"><svg width="48" height="48"><use href="#icon-alert"/></svg></div>
                <h2>${t('empty.mapLoadFailed')}</h2>
                <p>${t('empty.mapLoadFailedDesc')}</p>
            </div>
        `;
        updateStatus(0, 0);
    }
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function switchTab(tab) {
    const timeline = document.getElementById('timeline');
    const loading = document.getElementById('loading');
    const viewHeader = document.querySelector('.view-header');

    if (tab === 'map') {
        loadMapView();
        saveSession();
        return;
    }

    if (tab === 'dbinfo') {
        loadDbInfo();
        loading.classList.remove('visible');
        viewHeader.style.display = 'none';
        saveSession();
        return;
    }

    viewHeader.style.display = 'flex';

    if (tab === 'years') {
        loadYearsView();
        saveSession();
        return;
    }

    // all tab
    currentYearFilter = null;
    currentMonthFilter = null;
    currentDayFilter = null;
    resetPhotos();
    loadPhotos();
    saveSession();
}

// ========== 年份视图 ==========
function loadYearsView() {
    const timeline = document.getElementById('timeline');
    const loading = document.getElementById('loading');
    const viewTitle = document.getElementById('view-title');
    viewTitle.textContent = t('title.browseByYear');
    loading.classList.remove('visible');

    // Use timelineData (full stats from /api/timeline) instead of allPhotos
    const tree = timelineData || {};
    const years = Object.keys(tree).sort((a, b) => b - a);

    if (years.length === 0) {
        timeline.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-secondary)">' + t('empty.noPhotos') + '</div>';
        updateStatus(0, 0);
        return;
    }

    // Calculate total items per year from timeline data
    const yearMap = {};
    let totalItems = 0;
    years.forEach(year => {
        let count = 0;
        Object.values(tree[year]).forEach(monthDays => {
            Object.values(monthDays).forEach(dayCount => {
                count += dayCount;
            });
        });
        yearMap[year] = count;
        totalItems += count;
    });

    let html = '<div class="years-view"><div class="years-grid">';
    years.forEach(year => {
        html += `
            <div class="year-card" data-year="${year}">
                <div class="year-number">${year}</div>
                <div class="year-count">${t('status.items', yearMap[year])}</div>
            </div>
        `;
    });
    html += '</div></div>';
    timeline.innerHTML = html;
    updateStatus(totalItems, selectedPhotos.size);

    document.querySelectorAll('.year-card').forEach(card => {
        card.addEventListener('click', () => {
            const year = card.dataset.year;
            currentView = 'year';
            currentYearFilter = parseInt(year);
            currentMonthFilter = null;
            currentDayFilter = null;
            currentSourcePath = '';
            currentAlbumId = null;
            searchQuery = '';
            document.querySelectorAll('.top-tab').forEach(t => t.classList.remove('active'));
            document.querySelector('.top-tab[data-tab="all"]').classList.add('active');
            currentTab = 'all';
            document.getElementById('view-title').textContent = t('title.yearFilter', year);
            resetPhotos();
            loadPhotos();
        });
    });
}

// ========== 数据库信息 ==========
async function loadDbInfo() {
    const timeline = document.getElementById('timeline');
    const viewTitle = document.getElementById('view-title');
    viewTitle.textContent = t('title.dbInfo');

    try {
        const response = await fetch('/api/stats');
        const stats = await response.json();

        timeline.innerHTML = `
            <div class="dbinfo-placeholder">
                <div class="placeholder-icon"><svg width="48" height="48"><use href="#icon-database"/></svg></div>
                <h2>${t('db.statsTitle')}</h2>
                <table class="dbinfo-table">
                    <tr><th>${t('db.total')}</th><td>${stats.total || 0}</td></tr>
                    <tr><th>${t('db.photos')}</th><td>${stats.photos || 0}</td></tr>
                    <tr><th>${t('db.videos')}</th><td>${stats.videos || 0}</td></tr>
                    <tr><th>${t('db.trash')}</th><td>${stats.trash || 0}</td></tr>
                    <tr><th>${t('db.sources')}</th><td>${stats.sources || 0}</td></tr>
                    <tr><th>${t('db.oldest')}</th><td>${stats.oldest || '-'}</td></tr>
                    <tr><th>${t('db.newest')}</th><td>${stats.newest || '-'}</td></tr>
                    <tr><th>${t('db.dbSize')}</th><td>${formatSize(stats.db_size || 0)}</td></tr>
                </table>
            </div>
        `;
        updateStatus(0, 0);
    } catch (err) {
        timeline.innerHTML = `
            <div class="dbinfo-placeholder">
                <div class="placeholder-icon"><svg width="48" height="48"><use href="#icon-alert"/></svg></div>
                <h2>${t('empty.noStats')}</h2>
                <p>${t('empty.noStatsDesc')}</p>
            </div>
        `;
    }
}

// ========== 搜索 ==========
function initSearch() {
    const input = document.getElementById('search-input');
    const searchBox = document.getElementById('search-box');
    const searchToggleBtn = document.getElementById('search-toggle-btn');
    let debounceTimer;

    // Mobile search toggle
    if (searchToggleBtn) {
        searchToggleBtn.addEventListener('click', () => {
            searchBox.classList.toggle('mobile-open');
            if (searchBox.classList.contains('mobile-open')) {
                input.focus();
            }
        });
    }

    // Close mobile search when clicking outside
    document.addEventListener('click', (e) => {
        if (window.innerWidth <= 767 && searchBox && searchBox.classList.contains('mobile-open')) {
            if (!searchBox.contains(e.target) && !searchToggleBtn.contains(e.target)) {
                searchBox.classList.remove('mobile-open');
            }
        }
    });

    input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            searchQuery = e.target.value.trim().toLowerCase();
            currentYearFilter = null;
            currentMonthFilter = null;
            currentDayFilter = null;
            currentSourcePath = '';
            currentAlbumId = null;
            resetPhotos();
            if (searchQuery) {
                currentView = 'search';
                document.getElementById('view-title').textContent = t('title.searchResults', e.target.value);
            } else {
                currentView = 'all';
                document.getElementById('view-title').textContent = t('title.allPhotos');
            }
            loadPhotos();
            saveSession();
        }, 300);
    });
}

// ========== 照片元素创建 ==========
function createPhotoElement(photo) {
    const div = document.createElement('div');
    div.className = 'photo-item';
    if (photo.hidden) div.classList.add('hidden-photo');
    div.dataset.id = photo.id;

    const checkbox = document.createElement('div');
    checkbox.className = 'photo-checkbox';
    checkbox.innerHTML = '<svg width="14" height="14"><use href="#icon-check"/></svg>';
    div.appendChild(checkbox);

    const badge = document.createElement('div');
    badge.className = `format-badge ${photo.media_type}`;
    badge.textContent = photo.format;
    div.appendChild(badge);

    if (photo.media_type === 'video' && photo.duration) {
        const duration = document.createElement('div');
        duration.className = 'video-duration';
        duration.innerHTML = `<svg width="10" height="10" style="vertical-align:-1px;margin-right:2px"><use href="#icon-play"/></svg>${photo.duration}`;
        div.appendChild(duration);
    }

    if (photo.media_type === 'video') {
        const playBtn = document.createElement('div');
        playBtn.className = 'video-play-btn';
        playBtn.innerHTML = '<svg width="20" height="20"><use href="#icon-play"/></svg>';
        div.appendChild(playBtn);
    }

    // Action buttons container
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'photo-actions';

    // Favorite button
    const favBtn = document.createElement('button');
    favBtn.className = 'photo-action-btn photo-fav-btn';
    if (photo.favorite) favBtn.classList.add('favorited');
    favBtn.innerHTML = photo.favorite
        ? '<svg width="14" height="14" fill="currentColor"><use href="#icon-star"/></svg>'
        : '<svg width="14" height="14"><use href="#icon-star"/></svg>';
    favBtn.title = photo.favorite ? t('action.unfavorite') : t('action.favorite');
    favBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleFavoritePhoto(photo.id, photo.favorite);
    });
    actionsContainer.appendChild(favBtn);

    // Hide/Unhide button
    const hideBtn = document.createElement('button');
    hideBtn.className = 'photo-action-btn photo-hide-btn';
    hideBtn.innerHTML = photo.hidden
        ? '<svg width="14" height="14"><use href="#icon-eye"/></svg>'
        : '<svg width="14" height="14"><use href="#icon-eye-off"/></svg>';
    hideBtn.title = photo.hidden ? t('action.unhide') : t('action.hide');
    hideBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleHidePhoto(photo.id, photo.hidden);
    });
    actionsContainer.appendChild(hideBtn);

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'photo-action-btn photo-delete-btn';
    delBtn.innerHTML = '<svg width="14" height="14"><use href="#icon-trash"/></svg>';
    delBtn.title = t('action.delete');
    delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deletePhoto(photo.id, photo.media_type, photo.filename);
    });
    actionsContainer.appendChild(delBtn);

    div.appendChild(actionsContainer);

    const imgWrap = document.createElement('div');
    imgWrap.className = 'photo-img-wrap';

    const img = document.createElement('img');
    img.className = 'photo-img-real';
    img.src = photo.thumbnail_url;
    img.alt = photo.filename;
    img.loading = 'lazy';
    img.onload = () => {
        img.classList.add('loaded');
    };
    imgWrap.appendChild(img);

    if (photo.blur_url) {
        const placeholder = document.createElement('img');
        placeholder.className = 'photo-img-placeholder';
        placeholder.src = photo.blur_url;
        placeholder.alt = '';
        imgWrap.appendChild(placeholder);
    }

    div.appendChild(imgWrap);

    const dateDiv = document.createElement('div');
    dateDiv.className = 'photo-date';
    dateDiv.textContent = formatDate(photo.date_taken).time;

    div.appendChild(dateDiv);

    if (selectionMode && selectedPhotos.has(parseInt(photo.id))) {
        div.classList.add('selected');
    }

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
    updateSelectionUI();
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

async function toggleFavoritePhoto(photoId, currentlyFavorite) {
    try {
        const response = await fetch(`/api/photo/${photoId}/favorite`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            showToast(data.favorite ? t('action.favorite') : t('action.unfavorite'));
            // Update local data
            const photo = allPhotos.find(p => p.id === photoId);
            if (photo) photo.favorite = data.favorite;
            const fphoto = filteredPhotos.find(p => p.id === photoId);
            if (fphoto) fphoto.favorite = data.favorite;
            // Update UI
            const el = document.querySelector(`.photo-item[data-id="${photoId}"]`);
            if (el) {
                const favBtn = el.querySelector('.photo-fav-btn');
                if (favBtn) {
                    favBtn.classList.toggle('favorited', data.favorite);
                    favBtn.innerHTML = data.favorite
                        ? '<svg width="14" height="14" fill="currentColor"><use href="#icon-star"/></svg>'
                        : '<svg width="14" height="14"><use href="#icon-star"/></svg>';
                    favBtn.title = data.favorite ? t('action.unfavorite') : t('action.favorite');
                }
            }
            // If in favorites view and unfavorited, remove from view
            if (currentView === 'favorites' && !data.favorite) {
                if (el) {
                    el.style.transition = 'opacity 0.3s ease';
                    el.style.opacity = '0';
                    setTimeout(() => el.remove(), 300);
                }
                allPhotos = allPhotos.filter(p => p.id !== photoId);
                filteredPhotos = filteredPhotos.filter(p => p.id !== photoId);
                updateStatus(filteredPhotos.length, 0);
            }
            loadStats();
        } else {
            showToast(t('dialog.favoriteFailed'));
        }
    } catch (err) {
        console.error('Toggle favorite failed:', err);
        showToast(t('dialog.favoriteFailed'));
    }
}

async function deletePhoto(photoId, mediaType, filename) {
    const typeName = mediaType === 'video' ? t('dialog.video') : t('dialog.photo');

    const confirmed = await showDialog({
        type: 'confirm',
        icon: '<svg width="32" height="32"><use href="#icon-trash"/></svg>',
        title: t('dialog.confirmDeleteSingle', typeName),
        message: t('dialog.confirmDeleteSingleMsg', typeName, filename),
        confirmText: t('action.delete'),
        confirmClass: 'btn btn-danger',
        cancelText: t('action.cancel')
    });

    if (!confirmed) return;

    try {
        const response = await fetch(`/api/photo/${photoId}/delete`, {
            method: 'POST'
        });

        const data = await response.json();
        if (data.success) {
            const el = document.querySelector(`.photo-item[data-id="${photoId}"]`);
            if (el) {
                el.style.transition = 'opacity 0.3s ease';
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 300);
            }
            allPhotos = allPhotos.filter(p => p.id !== photoId);
            filteredPhotos = filteredPhotos.filter(p => p.id !== photoId);
            updateStatus(filteredPhotos.length, 0);
            loadStats();
            showToast(t('dialog.restored'));
        } else {
            showToast(data.error || t('dialog.deleteFailed'));
        }
    } catch (err) {
        console.error(t('dialog.deleteFailed') + ':', err);
        showToast(t('dialog.deleteFailed') + ': ' + err.message);
    }
}

async function toggleHidePhoto(photoId, currentlyHidden) {
    const action = currentlyHidden ? 'unhide' : 'hide';
    // 隐藏照片不需要确认，直接执行
    if (currentlyHidden) {
        const confirmed = await showDialog({
            type: 'confirm',
            title: t('action.unhide'),
            message: t('dialog.unhideConfirm'),
            confirmText: t('action.confirm'),
            cancelText: t('action.cancel')
        });
        if (!confirmed) return;
    }

    try {
        const response = await fetch(`/api/photo/${photoId}/hide`, { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            showToast(data.hidden ? t('action.hide') : t('action.unhide'));
            // Refresh current view
            if (currentView === 'hidden') {
                resetPhotos();
                await loadHiddenPhotos();
            } else {
                // Remove from current view if hiding
                if (!currentlyHidden && data.hidden) {
                    const el = document.querySelector(`.photo-item[data-id="${photoId}"]`);
                    if (el) {
                        el.style.transition = 'opacity 0.3s ease';
                        el.style.opacity = '0';
                        setTimeout(() => el.remove(), 300);
                    }
                    allPhotos = allPhotos.filter(p => p.id !== photoId);
                    filteredPhotos = filteredPhotos.filter(p => p.id !== photoId);
                    updateStatus(filteredPhotos.length, 0);
                }
            }
            // Refresh stats
            loadStats();
        } else {
            showToast(currentlyHidden ? t('dialog.unhideFailed') : t('dialog.hideFailed'));
        }
    } catch (err) {
        console.error('Toggle hide failed:', err);
        showToast(currentlyHidden ? t('dialog.unhideFailed') : t('dialog.hideFailed'));
    }
}

async function loadHiddenPhotos() {
    const timeline = document.getElementById('timeline');
    const loading = document.getElementById('loading');
    const viewHeader = document.querySelector('.view-header');

    viewHeader.style.display = '';
    document.getElementById('view-title').textContent = t('title.hiddenPhotos');

    if (isLoading) return;
    isLoading = true;
    loading.classList.add('visible');

    try {
        const response = await fetch('/api/photos/hidden');
        const data = await response.json();
        const photos = data.photos || [];

        if (photos.length === 0 && currentPage === 1) {
            timeline.innerHTML = `
                <div class="empty-state">
                    <div class="placeholder-icon"><svg width="48" height="48"><use href="#icon-eye-off"/></svg></div>
                    <h2>${t('empty.hiddenEmpty')}</h2>
                </div>
            `;
            updateStatus(0, 0);
            loading.classList.remove('visible');
            isLoading = false;
            hasMore = false;
            return;
        }

        if (currentPage === 1) timeline.innerHTML = '';

        const grid = document.createElement('div');
        grid.className = 'photo-grid';
        grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`;

        photos.forEach(photo => {
            grid.appendChild(createPhotoElement(photo));
        });

        timeline.appendChild(grid);
        allPhotos = photos;
        filteredPhotos = photos;
        updateStatus(photos.length, 0);
        hasMore = false;
    } catch (err) {
        console.error('Failed to load hidden photos:', err);
    } finally {
        loading.classList.remove('visible');
        isLoading = false;
    }
}

let duplicatePage = 1;
let duplicateHasMore = true;

function updateDuplicatesBar() {
    const bar = document.getElementById('duplicates-bar');
    if (!bar) return;
    if (currentView !== 'duplicates') {
        bar.classList.add('hidden');
        return;
    }
    bar.classList.remove('hidden');
    const count = getMarkedDuplicateIds().length;
    const countEl = document.getElementById('duplicates-count');
    if (countEl) countEl.textContent = t('duplicates.markedCount', count);
    const btn = document.getElementById('duplicates-delete-btn');
    if (btn) btn.disabled = count === 0;
}

function getMarkedDuplicateIds() {
    const ids = [];
    // For each group, find the checked keep radio, mark all others for deletion
    document.querySelectorAll('.duplicate-group').forEach(group => {
        const keepRadio = group.querySelector('.duplicate-keep-radio:checked');
        const keepId = keepRadio ? parseInt(keepRadio.value) : null;
        group.querySelectorAll('.duplicate-item').forEach(item => {
            const itemId = parseInt(item.dataset.id);
            if (itemId !== keepId) {
                ids.push(itemId);
            }
        });
    });
    return ids;
}

async function deleteMarkedDuplicates() {
    const ids = getMarkedDuplicateIds();
    if (ids.length === 0) return;

    const confirmed = await showDialog({
        type: 'confirm',
        icon: '<svg width="32" height="32"><use href="#icon-trash"/></svg>',
        title: t('dialog.confirmDeleteTitle'),
        message: t('dialog.confirmDeleteMsg', ids.length),
        confirmText: t('action.delete'),
        confirmClass: 'btn btn-danger',
        cancelText: t('action.cancel')
    });

    if (!confirmed) return;

    try {
        const response = await fetch('/api/photos/batch_delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photo_ids: ids })
        });

        const data = await response.json();
        if (data.success) {
            const deletedSet = new Set(data.deleted);
            // Remove deleted items from DOM
            deletedSet.forEach(id => {
                const el = document.querySelector(`.duplicate-item[data-id="${id}"]`);
                if (el) el.remove();
            });
            // Remove empty groups
            document.querySelectorAll('.duplicate-group').forEach(group => {
                if (group.querySelectorAll('.duplicate-item').length === 0) {
                    group.remove();
                }
            });
            updateDuplicatesBar();
            loadStats();
            if (data.failed && data.failed.length > 0) {
                showToast(t('dialog.deletePartial', data.deleted_count, data.failed.length));
            } else {
                showToast(t('dialog.deleteSuccess', data.deleted_count));
            }
        } else {
            showToast(data.error || t('dialog.batchDeleteFailed'));
        }
    } catch (err) {
        console.error(t('dialog.batchDeleteFailed') + ':', err);
        showToast(t('dialog.batchDeleteFailed') + ': ' + err.message);
    }
}

async function loadDuplicates() {
    const timeline = document.getElementById('timeline');
    const loading = document.getElementById('loading');
    const viewHeader = document.querySelector('.view-header');

    viewHeader.style.display = '';
    document.getElementById('view-title').textContent = t('title.duplicates');

    if (isLoading || !duplicateHasMore) return;
    isLoading = true;
    loading.classList.add('visible');

    try {
        const response = await fetch(`/api/duplicates?page=${duplicatePage}&per_page=50`);
        const data = await response.json();
        const groups = data.groups || [];

        if (groups.length === 0 && duplicatePage === 1) {
            timeline.innerHTML = `
                <div class="empty-state">
                    <div class="placeholder-icon"><svg width="48" height="48"><use href="#icon-check"/></svg></div>
                    <h2>${t('empty.noDuplicates')}</h2>
                    <p>${t('empty.noDuplicatesDesc')}</p>
                </div>
            `;
            updateStatus(0, 0);
            loading.classList.remove('visible');
            isLoading = false;
            duplicateHasMore = false;
            return;
        }

        if (duplicatePage === 1) {
            timeline.innerHTML = '';
        }

        const startIndex = (duplicatePage - 1) * 50;
        groups.forEach((group, idx) => {
            const isExpanded = idx < 3; // 默认展开前3组
            const groupEl = createDuplicateGroupElement(group, startIndex + idx + 1, isExpanded);
            timeline.appendChild(groupEl);
        });

        updateStatus(data.total_groups || 0, 0);
        duplicateHasMore = data.has_more;
        duplicatePage++;
        updateDuplicatesBar();
    } catch (err) {
        console.error('Failed to load duplicates:', err);
    } finally {
        loading.classList.remove('visible');
        isLoading = false;
    }
}

function createDuplicateGroupElement(group, index, isExpanded = false) {
    const div = document.createElement('div');
    div.className = 'duplicate-group';
    div.dataset.filename = group.filename;

    const sizeStr = formatSize(group.file_size);
    const header = document.createElement('div');
    header.className = 'duplicate-group-header';
    header.innerHTML = `
        <div class="duplicate-group-info">
            <span class="duplicate-group-index">#${index}</span>
            <span class="duplicate-group-filename">${escapeHtml(group.filename)}</span>
            <span class="duplicate-group-meta">${sizeStr} · ${group.count} ${t('duplicates.copies')}</span>
        </div>
        <button class="duplicate-group-toggle" aria-label="toggle">
            <svg width="16" height="16"><use href="#icon-chevron-${isExpanded ? 'down' : 'right'}"/></svg>
        </button>
    `;

    const body = document.createElement('div');
    body.className = 'duplicate-group-body' + (isExpanded ? ' expanded' : '');

    // Default: keep the highest resolution one, mark others for deletion
    group.photos.forEach((photo, pidx) => {
        const row = document.createElement('div');
        row.className = 'duplicate-item';
        row.dataset.id = photo.id;

        const isKeep = pidx === 0; // highest resolution first (sorted by backend)
        const resolution = (photo.width && photo.height) ? `${photo.width}×${photo.height}` : '';
        row.innerHTML = `
            <div class="duplicate-item-thumb">
                <img src="${photo.thumbnail_url}" alt="">
            </div>
            <div class="duplicate-item-info">
                <div class="duplicate-item-path">${escapeHtml(photo.path)}</div>
                <div class="duplicate-item-source">${escapeHtml(photo.source_path || '')}${resolution ? ' · ' + resolution : ''}</div>
            </div>
            <div class="duplicate-item-actions">
                <label class="duplicate-radio-label ${isKeep ? 'duplicate-keep-checked' : ''}">
                    <input type="radio" name="keep-${group.filename}" class="duplicate-keep-radio" value="${photo.id}" ${isKeep ? 'checked' : ''}>
                    <span>${t('duplicates.keep')}</span>
                </label>
            </div>
        `;
        body.appendChild(row);
    });

    // Toggle expand/collapse
    header.addEventListener('click', (e) => {
        if (e.target.closest('.duplicate-group-toggle') || e.target.closest('.duplicate-group-header')) {
            const isExpanded = body.classList.toggle('expanded');
            const icon = header.querySelector('.duplicate-group-toggle svg use');
            icon.setAttribute('href', isExpanded ? '#icon-chevron-down' : '#icon-chevron-right');
        }
    });

    // Handle radio changes - single choice per group
    body.addEventListener('change', (e) => {
        if (e.target.classList.contains('duplicate-keep-radio')) {
            // Uncheck all other keep radios in this group, update visual state
            body.querySelectorAll('.duplicate-keep-radio').forEach(r => {
                const label = r.closest('.duplicate-radio-label');
                if (r === e.target) {
                    label.classList.add('duplicate-keep-checked');
                } else {
                    label.classList.remove('duplicate-keep-checked');
                }
            });
            updateDuplicatesBar();
        }
    });

    div.appendChild(header);
    div.appendChild(body);
    return div;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function updateSelectionUI() {
    const count = selectedPhotos.size;
    document.getElementById('selection-count').textContent = t('status.selectedCount', count);
    
    const batchDeleteBtn = document.getElementById('batch-delete-btn');
    const trashRestoreAllBtn = document.getElementById('trash-restore-all-btn');
    const trashDeleteAllBtn = document.getElementById('trash-delete-all-btn');

    if (currentView === 'trash') {
        if (batchDeleteBtn) batchDeleteBtn.classList.add('hidden');
        if (trashRestoreAllBtn) trashRestoreAllBtn.classList.remove('hidden');
        if (trashDeleteAllBtn) trashDeleteAllBtn.classList.remove('hidden');
    } else {
        if (batchDeleteBtn) {
            batchDeleteBtn.classList.remove('hidden');
            batchDeleteBtn.disabled = count === 0;
        }
        if (trashRestoreAllBtn) trashRestoreAllBtn.classList.add('hidden');
        if (trashDeleteAllBtn) trashDeleteAllBtn.classList.add('hidden');
    }

    updateStatus(filteredPhotos.length, count);
}

async function batchDelete() {
    if (selectedPhotos.size === 0) return;

    const confirmed = await showDialog({
        type: 'confirm',
        icon: '<svg width=\"32\" height=\"32\"><use href=\"#icon-trash\"/></svg>',
        title: t('dialog.confirmDeleteTitle'),
        message: t('dialog.confirmDeleteMsg', selectedPhotos.size),
        confirmText: t('action.delete'),
        confirmClass: 'btn btn-danger',
        cancelText: t('action.cancel')
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
            const deletedSet = new Set(data.deleted);
            deletedSet.forEach(id => {
                const el = document.querySelector(`.photo-item[data-id="${id}"]`);
                if (el) el.remove();
            });
            
            allPhotos = allPhotos.filter(p => !deletedSet.has(p.id));
            filteredPhotos = filteredPhotos.filter(p => !deletedSet.has(p.id));
            
            disableSelectionMode();
            
            if (data.failed && data.failed.length > 0) {
                showToast(t('dialog.deletePartial', data.deleted_count, data.failed.length));
            } else {
                showToast(t('dialog.deleteSuccess', data.deleted_count));
            }
            loadStats();
        } else {
            showToast(data.error || t('dialog.batchDeleteFailed'));
        }
    } catch (err) {
        console.error(t('dialog.batchDeleteFailed') + ':', err);
        showToast(t('dialog.batchDeleteFailed') + ': ' + err.message);
    }
}

async function restoreAllTrash() {
    const confirmed = await showDialog({
        type: 'confirm',
        title: t('trash.restoreAll'),
        message: t('trash.restoreAllConfirm'),
        confirmText: t('action.confirm'),
        cancelText: t('action.cancel')
    });

    if (!confirmed) return;

    const btn = document.getElementById('trash-restore-all-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('trash.restoring');

    try {
        const response = await fetch('/api/trash/restore_all', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            showToast(data.message);
            disableSelectionMode();
            loadTrash();
            loadStats();
        } else {
            showToast(data.message || t('trash.restoreAllFailed'));
        }
    } catch (err) {
        console.error('Restore all failed:', err);
        showToast(t('trash.restoreAllFailed'));
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

async function deleteAllTrash() {
    const confirmed = await showDialog({
        type: 'confirm',
        title: t('trash.deleteAll'),
        message: t('trash.deleteAllConfirm'),
        confirmText: t('action.delete'),
        confirmClass: 'btn btn-danger',
        cancelText: t('action.cancel')
    });

    if (!confirmed) return;

    const btn = document.getElementById('trash-delete-all-btn');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('trash.deleting');

    try {
        const response = await fetch('/api/trash/delete_all', { method: 'POST' });
        const data = await response.json();
        if (data.success) {
            showToast(data.message);
            disableSelectionMode();
            loadTrash();
            loadStats();
        } else {
            showToast(data.message || '删除失败');
        }
    } catch (err) {
        console.error('Delete all failed:', err);
        showToast('删除失败');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}

function formatDate(dateStr) {
    const date = new Date(dateStr);
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        time: date.toLocaleString(currentLang === 'zh' ? 'zh-CN' : currentLang === 'ja' ? 'ja-JP' : 'en-US', {
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

// ========== 虚拟滚动时间轴 ==========
class VirtualTimeline {
    constructor(container) {
        this.container = container;
        this.items = [];
        this.elements = new Map();
        this.spacer = null;
        this.content = null;
        this.scrollHandler = null;
        this.resizeObserver = null;
        this.gap = 6;
        this.buffer = 3000;
        this._scrollPending = false;
        this._metrics = { cols: 1, itemWidth: 200 };
        this._lastRange = null;
        this._removeTimer = null;

        this.init();
    }

    init() {
        this.container.innerHTML = '';

        this.spacer = document.createElement('div');
        this.spacer.style.width = '1px';
        this.container.appendChild(this.spacer);

        this.content = document.createElement('div');
        this.content.style.position = 'absolute';
        this.content.style.top = '0';
        this.content.style.left = '0';
        this.content.style.right = '0';
        this.content.style.zIndex = '1';
        this.container.appendChild(this.content);

        this.scrollHandler = () => this.scheduleRender();
        this.container.addEventListener('scroll', this.scrollHandler, { passive: true });

        this.resizeObserver = new ResizeObserver(() => {
            this.refresh();
        });
        this.resizeObserver.observe(this.container);
    }

    destroy() {
        this.container.removeEventListener('scroll', this.scrollHandler);
        if (this.resizeObserver) this.resizeObserver.disconnect();
        if (this._removeTimer) clearTimeout(this._removeTimer);
        this.container.innerHTML = '';
    }

    setPhotos(photos) {
        this.photos = photos || [];
        this.rebuild();
        this.render();
    }

    getMetrics() {
        const padding = 40; // 20px * 2
        const cw = Math.max(1, this.container.clientWidth - padding);
        const cols = Math.max(1, Math.floor((cw + this.gap) / (thumbSize + this.gap)));
        const itemWidth = (cw - (cols - 1) * this.gap) / cols;
        this._metrics = { cols, itemWidth };
        return this._metrics;
    }

    rebuild() {
        this._lastRange = null;
        if (!this.photos || this.photos.length === 0) {
            this.items = [];
            this.totalHeight = 0;
            this.spacer.style.height = '0px';
            return;
        }

        const { cols, itemWidth } = this.getMetrics();

        // 按日期分组
        const dayMap = new Map();
        for (const photo of this.photos) {
            const { year, month, day } = formatDate(photo.date_taken);
            const key = `${year}-${month}-${day}`;
            if (!dayMap.has(key)) {
                dayMap.set(key, { year, month, day, photos: [] });
            }
            dayMap.get(key).photos.push(photo);
        }

        // 按日期降序排序
        const days = Array.from(dayMap.values()).sort((a, b) => {
            const da = new Date(a.year, a.month - 1, a.day);
            const db = new Date(b.year, b.month - 1, b.day);
            return db - da;
        });

        // 构建 items
        this.items = [];
        let top = 0;
        let lastYear = null;
        let lastMonth = null;

        for (const day of days) {
            if (day.year !== lastYear) {
                this.items.push({ type: 'year', key: `y-${day.year}`, data: day.year, top, height: 70 });
                top += 70;
                lastYear = day.year;
                lastMonth = null;
            }

            if (day.month !== lastMonth) {
                this.items.push({ type: 'month', key: `m-${day.year}-${day.month}`, data: { year: day.year, month: day.month }, top, height: 48 });
                top += 48;
                lastMonth = day.month;
            }

            this.items.push({ type: 'day', key: `d-${day.year}-${day.month}-${day.day}`, data: day, top, height: 40 });
            top += 40;

            const rows = Math.ceil(day.photos.length / cols);
            const gridHeight = rows * itemWidth + (rows - 1) * this.gap + 16;
            this.items.push({ type: 'grid', key: `g-${day.year}-${day.month}-${day.day}`, data: day, top, height: gridHeight });
            top += gridHeight;
        }

        this.totalHeight = top;
        this.spacer.style.height = `${top}px`;
    }

    getVisibleRange() {
        const scrollTop = this.container.scrollTop;
        const viewportHeight = this.container.clientHeight;
        const start = scrollTop - this.buffer;
        const end = scrollTop + viewportHeight + this.buffer;

        // 二分查找 startIndex
        let lo = 0, hi = this.items.length - 1;
        let startIndex = this.items.length;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const item = this.items[mid];
            if (item.top + item.height > start) {
                startIndex = mid;
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }

        // 二分查找 endIndex
        lo = 0; hi = this.items.length - 1;
        let endIndex = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const item = this.items[mid];
            if (item.top < end) {
                endIndex = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return { start: Math.max(0, startIndex), end: Math.min(this.items.length - 1, endIndex) };
    }

    render() {
        if (!this.items.length) {
            this.content.innerHTML = '';
            this.elements.clear();
            this._lastRange = null;
            return;
        }

        const range = this.getVisibleRange();

        // 如果范围没有变化，跳过渲染
        if (this._lastRange
            && this._lastRange.start === range.start
            && this._lastRange.end === range.end) {
            return;
        }
        this._lastRange = range;

        const neededKeys = new Set();
        const toAdd = [];

        for (let i = range.start; i <= range.end; i++) {
            const item = this.items[i];
            neededKeys.add(item.key);
            if (!this.elements.has(item.key)) {
                toAdd.push(item);
            }
        }

        // 添加新元素
        for (const item of toAdd) {
            const el = this.createElement(item);
            el.style.position = 'absolute';
            el.style.top = `${item.top}px`;
            el.style.left = '0';
            el.style.right = '0';
            // 初始不可见，下一帧淡入
            el.style.opacity = '0';
            this.content.appendChild(el);
            this.elements.set(item.key, el);
            requestAnimationFrame(() => {
                el.style.transition = 'opacity 0.25s ease';
                el.style.opacity = '1';
            });
        }

        // 延迟移除不可见元素，避免快速滚动时频繁创建/销毁
        if (this._removeTimer) clearTimeout(this._removeTimer);
        this._removeTimer = setTimeout(() => {
            for (const [key, el] of this.elements) {
                if (!neededKeys.has(key)) {
                    el.remove();
                    this.elements.delete(key);
                }
            }
        }, 100);
    }

    scheduleRender() {
        if (this._scrollPending) return;
        this._scrollPending = true;
        requestAnimationFrame(() => {
            this._scrollPending = false;
            this.render();
        });
    }

    createElement(item) {
        if (item.type === 'year') {
            const el = document.createElement('div');
            el.className = 'year-label';
            el.id = `year-${item.data}`;
            el.style.height = `${item.height}px`;
            el.style.margin = '0';
            el.style.display = 'flex';
            el.style.alignItems = 'center';
            el.textContent = t('date.year', item.data);
            return el;
        }
        if (item.type === 'month') {
            const el = document.createElement('div');
            el.className = 'month-label';
            el.id = `month-${item.data.year}-${item.data.month}`;
            el.style.height = `${item.height}px`;
            el.style.margin = '0';
            el.style.display = 'flex';
            el.style.alignItems = 'center';
            el.textContent = t('date.month', item.data.month);
            return el;
        }
        if (item.type === 'day') {
            const el = document.createElement('div');
            el.className = 'day-label';
            el.id = `day-${item.data.year}-${item.data.month}-${item.data.day}`;
            el.style.height = `${item.height}px`;
            el.style.margin = '0';
            el.style.display = 'flex';
            el.style.alignItems = 'center';
            el.textContent = t('date.monthDay', item.data.month, item.data.day);
            return el;
        }
        if (item.type === 'grid') {
            const el = document.createElement('div');
            el.className = 'photo-grid';
            el.id = `day-${item.data.year}-${item.data.month}-${item.data.day}`;
            el.style.gridTemplateColumns = `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`;
            el.style.marginBottom = '0';
            for (const photo of item.data.photos) {
                el.appendChild(createPhotoElement(photo));
            }
            return el;
        }
    }

    refresh() {
        this.rebuild();
        this.render();
    }

    getYearAtScroll(scrollTop) {
        if (!this.items.length) return null;
        let currentYear = null;
        let minDist = Infinity;
        for (const item of this.items) {
            if (item.type === 'year') {
                const dist = Math.abs(item.top - scrollTop);
                if (dist < minDist) {
                    minDist = dist;
                    currentYear = String(item.data);
                }
            }
        }
        return currentYear;
    }

    getDateAtScroll(scrollTop) {
        if (!this.items.length) return null;
        // 找到 scrollTop 上方最近的 item，提取其日期
        let result = null;
        for (const item of this.items) {
            if (item.top > scrollTop) break;
            if (item.type === 'year') {
                result = { year: item.data, month: null, day: null };
            } else if (item.type === 'month') {
                result = { year: item.data.year, month: item.data.month, day: null };
            } else if (item.type === 'day' || item.type === 'grid') {
                result = { year: item.data.year, month: item.data.month, day: item.data.day };
            }
        }
        return result;
    }

    scrollToTop() {
        this.container.scrollTop = 0;
    }
}

let virtualTimeline = null;

function renderPhotos(photos) {
    if (!virtualTimeline) {
        virtualTimeline = new VirtualTimeline(document.getElementById('timeline'));
    }
    // 使用 filteredPhotos（如果有前端过滤）否则用 allPhotos
    const photosToRender = filteredPhotos.length > 0 ? filteredPhotos : allPhotos;
    virtualTimeline.setPhotos(photosToRender);
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

    if (currentMonthFilter) {
        photos = photos.filter(p => formatDate(p.date_taken).month === currentMonthFilter);
    }

    if (currentDayFilter) {
        photos = photos.filter(p => formatDate(p.date_taken).day === currentDayFilter);
    }

    if (searchQuery) {
        photos = photos.filter(p =>
            p.filename.toLowerCase().includes(searchQuery) ||
            formatDate(p.date_taken).time.includes(searchQuery)
        );
    }

    if (photoFilterType === 'photo') {
        photos = photos.filter(p => !p.is_screenshot);
    } else if (photoFilterType === 'screenshot') {
        photos = photos.filter(p => p.is_screenshot);
    }

    return photos;
}

function resetPhotos() {
    currentPage = 1;
    hasMore = true;
    filteredPhotos = [];
    allPhotos = [];
    currentDayFilter = null;
    duplicatePage = 1;
    duplicateHasMore = true;
    if (virtualTimeline) {
        virtualTimeline.destroy();
        virtualTimeline = null;
    }
    document.getElementById('timeline').innerHTML = '';
}

// 全局时间轴数据，从服务器一次性加载
let timelineData = null;

// ========== 时间轴侧边栏 ==========
async function loadTimelineData() {
    // 从服务器加载完整的时间轴统计数据
    try {
        const response = await fetch('/api/timeline');
        const data = await response.json();
        timelineData = data.timeline || {};
        buildTimelineSidebar();
    } catch (err) {
        console.error(t('empty.noStats') + ':', err);
    }
}

function buildTimelineSidebar() {
    const list = document.getElementById('timeline-list');
    if (!list) return;

    // 优先使用从服务器加载的完整时间轴数据
    const tree = timelineData || {};

    // 如果没有服务器数据，回退到已加载的照片数据
    if (Object.keys(tree).length === 0) {
        allPhotos.forEach(p => {
            const { year, month, day } = formatDate(p.date_taken);
            if (!tree[year]) tree[year] = {};
            if (!tree[year][month]) tree[year][month] = {};
            if (!tree[year][month][day]) tree[year][month][day] = 0;
            tree[year][month][day]++;
        });
    }

    const years = Object.keys(tree).sort((a, b) => b - a);

    if (years.length === 0) {
        list.innerHTML = '<div style="padding:20px;color:#666;text-align:center;font-size:0.8rem">' + t('empty.noPhotos') + '</div>';
        return;
    }

    list.innerHTML = '';
    years.forEach((year, yearIndex) => {
        const months = Object.keys(tree[year]).sort((a, b) => b - a);
        const yearTotal = months.reduce((sum, m) => sum + Object.values(tree[year][m]).reduce((s, c) => s + c, 0), 0);

        const yearEl = document.createElement('li');
        yearEl.className = 'timeline-year' + (yearIndex === 0 ? ' expanded' : '');
        yearEl.dataset.year = year;
        yearEl.innerHTML = `
            <svg class="timeline-chevron" width="10" height="10"><use href="#icon-chevron-right"/></svg>
            <span class="timeline-year-label">${t('date.year', year)}</span>
            <span class="timeline-year-count">${yearTotal}</span>
        `;
        yearEl.addEventListener('click', (e) => {
            // Only toggle if clicking the year itself, not a child month
            if (e.target.closest('.timeline-month') || e.target.closest('.timeline-day')) return;
            yearEl.classList.toggle('expanded');
            const monthsEl = yearEl.nextElementSibling;
            if (monthsEl) monthsEl.classList.toggle('expanded');
        });
        list.appendChild(yearEl);

        const monthsContainer = document.createElement('ul');
        monthsContainer.className = 'timeline-months' + (yearIndex === 0 ? ' expanded' : '');

        months.forEach(month => {
            const days = Object.keys(tree[year][month]).sort((a, b) => b - a);
            const monthTotal = days.reduce((sum, d) => sum + tree[year][month][d], 0);

            const monthEl = document.createElement('li');
            monthEl.className = 'timeline-month';
            monthEl.dataset.year = year;
            monthEl.dataset.month = month;
            monthEl.innerHTML = `
                <svg class="timeline-chevron" width="8" height="8"><use href="#icon-chevron-right"/></svg>
                <span class="timeline-month-name">${t('date.month', month)}</span>
                <span class="timeline-month-count">${monthTotal}</span>
            `;

            const daysContainer = document.createElement('ul');
            daysContainer.className = 'timeline-days';

            days.forEach(day => {
                const dayEl = document.createElement('li');
                dayEl.className = 'timeline-day';
                dayEl.dataset.year = year;
                dayEl.dataset.month = month;
                dayEl.dataset.day = day;
                dayEl.innerHTML = `
                    <span class="timeline-day-name">${t('date.monthDay', month, day)}</span>
                    <span class="timeline-day-count">${tree[year][month][day]}</span>
                `;
                dayEl.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await selectTimelineDay(parseInt(year), parseInt(month), parseInt(day));
                });
                daysContainer.appendChild(dayEl);
            });

            monthEl.addEventListener('click', async (e) => {
                e.stopPropagation();
                // Toggle days expansion
                monthEl.classList.toggle('expanded');
                daysContainer.classList.toggle('expanded');
                // Also select this month
                await selectTimelineMonth(parseInt(year), parseInt(month));
            });

            monthsContainer.appendChild(monthEl);
            monthsContainer.appendChild(daysContainer);
        });

        list.appendChild(monthsContainer);
    });
}

async function selectTimelineMonth(year, month) {
    currentView = 'year';
    currentYearFilter = year;
    currentMonthFilter = month;
    currentDayFilter = null;
    currentSourcePath = '';
    currentAlbumId = null;
    searchQuery = '';

    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.timeline-year').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.timeline-month').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.timeline-day').forEach(i => i.classList.remove('active'));

    const monthEl = document.querySelector(`.timeline-month[data-year="${year}"][data-month="${month}"]`);
    if (monthEl) monthEl.classList.add('active');

    document.getElementById('view-title').textContent = t('title.monthFilter', year, month);

    document.querySelectorAll('.top-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.top-tab[data-tab="all"]').classList.add('active');
    currentTab = 'all';

    resetPhotos();
    await loadPhotos();
    saveSession();
}

async function selectTimelineDay(year, month, day) {
    currentView = 'year';
    currentYearFilter = year;
    currentMonthFilter = month;
    currentDayFilter = day;
    currentSourcePath = '';
    currentAlbumId = null;
    searchQuery = '';

    document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.timeline-year').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.timeline-month').forEach(i => i.classList.remove('active'));
    document.querySelectorAll('.timeline-day').forEach(i => i.classList.remove('active'));

    const dayEl = document.querySelector(`.timeline-day[data-year="${year}"][data-month="${month}"][data-day="${day}"]`);
    if (dayEl) dayEl.classList.add('active');

    document.getElementById('view-title').textContent = t('title.dayFilter', year, month, day);

    document.querySelectorAll('.top-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.top-tab[data-tab="all"]').classList.add('active');
    currentTab = 'all';

    resetPhotos();
    await loadPhotos();
    saveSession();
}

async function loadFilteredPhotos(view) {
    // 过滤视图：用后端 API 分页加载，而不是前端过滤
    if (isLoading || !hasMore) return;

    isLoading = true;
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        let url = `/api/photos?page=${currentPage}&per_page=${PER_PAGE}`;
        if (view === 'photos') url += '&media_type=image';
        else if (view === 'videos') url += '&media_type=video';
        else if (view === 'favorites') url += '&favorite=1';
        else if (view === 'recent') url += '&recent=1';
        url += `&filter_type=${photoFilterType}`;

        const response = await fetch(url);
        const data = await response.json();

        if (currentPage === 1) {
            allPhotos = data.photos;
            if (virtualTimeline) {
                virtualTimeline.destroy();
                virtualTimeline = null;
            }
        } else {
            allPhotos = allPhotos.concat(data.photos);
        }

        filteredPhotos = allPhotos;
        hasMore = data.has_more;

        renderPhotos(data.photos);
        updateStatus(data.total, selectedPhotos.size);

        if (currentPage === 1) {
            requestAnimationFrame(() => syncSidebarHighlight(document.getElementById('timeline')));
        }

        currentPage++;
    } catch (err) {
        console.error('加载过滤照片失败:', err);
    } finally {
        isLoading = false;
        loadingEl.classList.remove('visible');
    }
}

async function loadPhotos() {
    if (isLoading || !hasMore) return;
    if (currentTab !== 'all' && currentTab !== 'years') return;

    isLoading = true;
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        let url = `/api/photos?page=${currentPage}&per_page=${PER_PAGE}`;
        if (currentYearFilter) url += `&year=${currentYearFilter}`;
        if (currentMonthFilter) url += `&month=${currentMonthFilter}`;
        if (currentDayFilter) url += `&day=${currentDayFilter}`;
        url += `&filter_type=${photoFilterType}`;
        const response = await fetch(url);
        const data = await response.json();

        if (currentPage === 1) {
            allPhotos = data.photos;
            if (virtualTimeline) {
                virtualTimeline.destroy();
                virtualTimeline = null;
            }
        } else {
            allPhotos = allPhotos.concat(data.photos);
        }

        filteredPhotos = getFilteredPhotos();
        hasMore = data.has_more;

        renderPhotos(data.photos);
        updateStatus(filteredPhotos.length, selectedPhotos.size);

        // 初始加载后触发一次滚动同步
        if (currentPage === 1) {
            requestAnimationFrame(() => syncSidebarHighlight(document.getElementById('timeline')));
        }

        currentPage++;
    } catch (err) {
        console.error(t('empty.noStats') + ':', err);
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
        allPhotos = items;
        filteredPhotos = items;

        timeline.innerHTML = '';
        if (items.length === 0) {
            timeline.innerHTML = '<div style="text-align:center;padding:60px;color:#666">' + t('empty.trashEmpty') + '</div>';
        } else {
            const grid = document.createElement('div');
            grid.className = 'photo-grid';
            grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${thumbSize}px, 1fr))`;

            items.forEach(item => {
                const div = document.createElement('div');
                div.className = 'photo-item';
                div.dataset.id = item.id;
                
                // Use thumbnail URL if available, otherwise show placeholder
                const hasThumb = !!item.thumbnail_url;
                const imgSrc = hasThumb ? item.thumbnail_url : '/static/favicon.ico';
                
                div.innerHTML = `
                    <img src="${imgSrc}" alt="${item.filename}" loading="lazy" 
                         onerror="this.style.display='none'"
                         style="${hasThumb ? '' : 'opacity:0.3'}">
                    <div class="photo-date" style="opacity:1">${item.filename}<br>${t('trash.daysRemaining', item.days_remaining)}</div>
                `;

                div.addEventListener('click', (e) => {
                    if (selectionMode || e.shiftKey) {
                        toggleSelection(item.id, div);
                    } else {
                        // For trash, maybe we don't open lightbox or we open a restricted one
                        // For now, let's just support selection
                        if (!selectionMode) {
                            enableSelectionMode();
                            toggleSelection(item.id, div);
                        }
                    }
                });

                grid.appendChild(div);
            });
            timeline.appendChild(grid);
        }
        updateStatus(items.length, 0);
    } catch (err) {
        console.error(t('empty.noStats') + ':', err);
    } finally {
        loadingEl.classList.remove('visible');
    }
}

function setupInfiniteScroll() {
    const timeline = document.getElementById('timeline');
    let scrollSyncRAF = null;

    timeline.addEventListener('scroll', () => {
        if (isLoading) return;
        if (currentTab !== 'all') return;

        const scrollBottom = timeline.scrollTop + timeline.clientHeight;
        const threshold = timeline.scrollHeight - 400;
        if (scrollBottom >= threshold) {
            if (currentView === 'duplicates') {
                if (duplicateHasMore) loadDuplicates();
            } else if (currentView === 'trash') {
                return;
            } else if (currentView === 'photos' || currentView === 'videos' || currentView === 'favorites' || currentView === 'recent') {
                if (hasMore) loadFilteredPhotos(currentView);
            } else {
                if (hasMore) loadPhotos();
            }
        }

        // 滚动同步侧边栏高亮
        if (scrollSyncRAF) cancelAnimationFrame(scrollSyncRAF);
        scrollSyncRAF = requestAnimationFrame(() => {
            syncSidebarHighlight(timeline);
        });
    });
}

function syncSidebarHighlight(timeline) {
    // 只在全部照片视图且没有手动选择过滤时同步
    if (currentView !== 'all' || currentYearFilter || currentMonthFilter || currentDayFilter) return;

    const dateInfo = virtualTimeline ? virtualTimeline.getDateAtScroll(timeline.scrollTop + 80) : null;
    if (!dateInfo || !dateInfo.year) return;

    const { year, month, day } = dateInfo;

    // 检查是否需要更新（避免不必要的 DOM 操作）
    const activeYearEl = document.querySelector('.timeline-year.active');
    const activeMonthEl = document.querySelector('.timeline-month.active');
    const activeDayEl = document.querySelector('.timeline-day.active');

    const yearChanged = !activeYearEl || activeYearEl.dataset.year !== String(year);
    const monthChanged = !activeMonthEl || activeMonthEl.dataset.month !== String(month) || activeMonthEl.dataset.year !== String(year);
    const dayChanged = !activeDayEl || activeDayEl.dataset.day !== String(day) || activeDayEl.dataset.month !== String(month) || activeDayEl.dataset.year !== String(year);

    if (!yearChanged && !monthChanged && !dayChanged) return;

    // 更新年份高亮并展开
    document.querySelectorAll('.timeline-year').forEach(el => {
        const isTarget = el.dataset.year === String(year);
        el.classList.toggle('active', isTarget);
        if (isTarget && yearChanged) {
            el.classList.add('expanded');
            const monthsContainer = el.nextElementSibling;
            if (monthsContainer && monthsContainer.classList.contains('timeline-months')) {
                monthsContainer.classList.add('expanded');
            }
        }
    });

    // 更新月份高亮并展开
    if (month) {
        document.querySelectorAll('.timeline-month').forEach(el => {
            const isTarget = el.dataset.year === String(year) && el.dataset.month === String(month);
            el.classList.toggle('active', isTarget);
            if (isTarget && monthChanged) {
                el.classList.add('expanded');
                const daysContainer = el.nextElementSibling;
                if (daysContainer && daysContainer.classList.contains('timeline-days')) {
                    daysContainer.classList.add('expanded');
                }
            }
        });
    }

    // 更新日期高亮
    if (day) {
        document.querySelectorAll('.timeline-day').forEach(el => {
            const isTarget = el.dataset.year === String(year) && el.dataset.month === String(month) && el.dataset.day === String(day);
            el.classList.toggle('active', isTarget);
        });
    }

    // 滚动侧边栏让高亮的项可见（用更新后的元素）
    const newActiveDay = document.querySelector(`.timeline-day[data-year="${year}"][data-month="${month}"][data-day="${day}"]`);
    const newActiveMonth = document.querySelector(`.timeline-month[data-year="${year}"][data-month="${month}"]`);
    if (dayChanged && newActiveDay) {
        newActiveDay.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (monthChanged && newActiveMonth) {
        newActiveMonth.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// ========== 灯箱 ==========
function formatExifValue(value, label) {
    if (value === undefined || value === null || value === '') return '';
    if (typeof value === 'object') return `<div class="exif-item"><span class="exif-label">${label}</span><span class="exif-value">${JSON.stringify(value).substring(0, 100)}</span></div>`;
    return `<div class="exif-item"><span class="exif-label">${label}</span><span class="exif-value">${value}</span></div>`;
}

async function loadPhotoExif(photoId) {
    const infoPanel = document.getElementById('viewer-exif');
    if (!infoPanel) return;
    
    infoPanel.innerHTML = '<div class="exif-loading">' + t('exif.loading') + '</div>';
    
    // 从已加载的照片列表中获取GPS数据（无需等待EXIF接口）
    const photo = filteredPhotos.find(p => p.id === photoId);
    const photoLat = photo ? (photo.latitude !== undefined ? photo.latitude : photo.lat) : null;
    const photoLon = photo ? (photo.longitude !== undefined ? photo.longitude : photo.lon) : null;
    
    try {
        const response = await fetch(`/api/photo/${photoId}/exif`);
        const data = await response.json();
        
        let html = '';
        
        // ========== GPS 位置信息（优先使用照片列表数据，也可从EXIF接口获取）==========
        const gpsLat = photoLat !== undefined && photoLat !== null ? photoLat : (data.gps && data.gps.latitude);
        const gpsLon = photoLon !== undefined && photoLon !== null ? photoLon : (data.gps && data.gps.longitude);
        
        if (gpsLat !== undefined && gpsLat !== null && gpsLon !== undefined && gpsLon !== null) {
            html += '<div class="exif-section exif-gps-section">';
            html += '<div class="exif-section-title">' + t('exif.gpsSection') + '</div>';
            html += `<div class="exif-item"><span class="exif-label">${t('exif.latitude')}</span><span class="exif-value">${typeof gpsLat === 'number' ? gpsLat.toFixed(6) : gpsLat}</span></div>`;
            html += `<div class="exif-item"><span class="exif-label">${t('exif.longitude')}</span><span class="exif-value">${typeof gpsLon === 'number' ? gpsLon.toFixed(6) : gpsLon}</span></div>`;
            if (data.gps && data.gps.altitude) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.altitude')}</span><span class="exif-value">${data.gps.altitude}m</span></div>`;
            }
            const mapsUrl = `https://www.google.com/maps?q=${gpsLat},${gpsLon}`;
            html += `<div class="exif-item"><span class="exif-label">${t('exif.map')}</span><a href="${mapsUrl}" target="_blank" class="exif-value">${t('exif.viewInMaps')} ↗</a></div>`;
            html += '</div>';
        } else {
            html += '<div class="exif-section exif-gps-section exif-gps-empty">';
            html += '<div class="exif-section-title">' + t('exif.gpsSection') + '</div>';
            html += '<div class="exif-item"><span class="exif-value" style="color:var(--text-muted)">' + t('exif.noGps') + '</span></div>';
            html += '</div>';
        }
        
        // ========== 解析拍摄时间（所有日期中取最早/最小的）==========
        if (data.resolved_date && data.all_dates && data.all_dates.length > 0) {
            html += '<div class="exif-section exif-resolved-date">';
            html += '<div class="exif-section-title">' + t('exif.resolvedDate') + '</div>';
            html += `<div class="exif-item exif-highlight"><span class="exif-label">${t('exif.finalAdopted')}</span><span class="exif-value exif-date-main">${data.resolved_date}</span></div>`;
            html += `<div class="exif-item"><span class="exif-label">${t('exif.source')}</span><span class="exif-value">${data.resolved_source || ''}</span></div>`;
            
            // 展示所有候选日期供对比
            html += '<div style="margin-top:8px;padding-top:8px;border-top:1px solid #333;">';
            html += '<div style="font-size:0.7rem;color:#888;margin-bottom:4px">' + t('exif.allDatesCompare') + '</div>';
            data.all_dates.forEach(d => {
                const isEarliest = d.is_earliest;
                const style = isEarliest ? 'font-weight:bold' : '';
                const icon = isEarliest ? '● ' : '  ';
                html += `<div style="font-size:0.75rem;padding:2px 0;${style}">${icon}${d.label}: ${d.date}</div>`;
            });
            html += '</div>';
            html += '</div>';
        }
        
        // 文件信息
        html += '<div class="exif-section">';
        html += '<div class="exif-section-title">' + t('exif.fileInfo') + '</div>';
        
        if (data.filename) {
            html += `<div class="exif-item"><span class="exif-label">${t('exif.filename')}</span><span class="exif-value" title="${data.filename}">${data.filename}</span></div>`;
        }
        if (data.format) {
            html += `<div class="exif-item"><span class="exif-label">${t('exif.format')}</span><span class="exif-value">${data.format}</span></div>`;
        }
        if (data.mode) {
            html += `<div class="exif-item"><span class="exif-label">${t('exif.colorMode')}</span><span class="exif-value">${data.mode}</span></div>`;
        }
        if (data.width && data.height) {
            const mp = ((data.width * data.height) / 1000000).toFixed(1);
            html += `<div class="exif-item"><span class="exif-label">${t('exif.dimensions')}</span><span class="exif-value">${data.width} × ${data.height} (${mp} MP)</span></div>`;
        }
        if (data.file_size) {
            html += `<div class="exif-item"><span class="exif-label">${t('exif.fileSize')}</span><span class="exif-value">${formatSize(data.file_size)}</span></div>`;
        }
        html += '</div>';
        
        // 原始日期信息（汇总展示）
        const hasAnyDate = data.filename_date || data.date_taken || data.date_digitized || 
                          data.date_original || data.modified_time || data.birth_time ||
                          data.creation_time || data.video_creation_time;
        if (hasAnyDate) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.rawDateSources') + '</div>';
            if (data.filename_date) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dateSource.filename')}</span><span class="exif-value">${data.filename_date}</span></div>`;
            }
            if (data.date_original) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dateSource.exifOriginal')}</span><span class="exif-value">${data.date_original}</span></div>`;
            }
            if (data.date_taken) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dateSource.exifDateTime')}</span><span class="exif-value">${data.date_taken}</span></div>`;
            }
            if (data.date_digitized) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dateSource.exifDigitized')}</span><span class="exif-value">${data.date_digitized}</span></div>`;
            }
            if (data.creation_time) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dateSource.videoCreate')}</span><span class="exif-value">${data.creation_time}</span></div>`;
            }
            if (data.video_creation_time) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dateSource.videoStream')}</span><span class="exif-value">${data.video_creation_time}</span></div>`;
            }
            if (data.modified_time) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dateSource.fileModified')}</span><span class="exif-value">${data.modified_time}</span></div>`;
            }
            if (data.birth_time) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dateSource.fileCreated')}</span><span class="exif-value">${data.birth_time}</span></div>`;
            }
            if (data.db_date) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.dbRecord')}</span><span class="exif-value">${data.db_date}</span></div>`;
            }
            html += '</div>';
        }
        
        // 相机信息
        const hasCamera = data.camera || data.make || data.model || data.lens || data.lens_spec || data.body_serial || data.lens_serial;
        if (hasCamera) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.camera') + '</div>';
            if (data.make) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.make')}</span><span class="exif-value">${data.make}</span></div>`;
            }
            if (data.model) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.model')}</span><span class="exif-value">${data.model}</span></div>`;
            }
            if (data.camera) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.device')}</span><span class="exif-value">${data.camera.trim()}</span></div>`;
            }
            if (data.lens) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.lens')}</span><span class="exif-value">${data.lens}</span></div>`;
            }
            if (data.lens_spec) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.lensSpec')}</span><span class="exif-value">${data.lens_spec}</span></div>`;
            }
            if (data.body_serial) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.bodySerial')}</span><span class="exif-value">${data.body_serial}</span></div>`;
            }
            if (data.lens_serial) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.lensSerial')}</span><span class="exif-value">${data.lens_serial}</span></div>`;
            }
            html += '</div>';
        }
        
        // 拍摄参数
        const hasExposure = data.aperture || data.iso || data.exposure || data.focal_length || data.exposure_bias || data.max_aperture || data.brightness;
        if (hasExposure) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.exposure') + '</div>';
            if (data.aperture) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.aperture')}</span><span class="exif-value">f/${data.aperture}</span></div>`;
            }
            if (data.max_aperture) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.maxAperture')}</span><span class="exif-value">f/${data.max_aperture}</span></div>`;
            }
            if (data.iso) {
                html += `<div class="exif-item"><span class="exif-label">ISO</span><span class="exif-value">${data.iso}</span></div>`;
            }
            if (data.exposure) {
                let exp = data.exposure;
                if (typeof exp === 'number' && exp < 1) {
                    exp = `1/${Math.round(1/exp)}s`;
                } else {
                    exp = exp + 's';
                }
                html += `<div class="exif-item"><span class="exif-label">${t('exif.shutter')}</span><span class="exif-value">${exp}</span></div>`;
            }
            if (data.exposure_bias) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.exposureComp')}</span><span class="exif-value">${data.exposure_bias} EV</span></div>`;
            }
            if (data.brightness) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.brightness')}</span><span class="exif-value">${data.brightness}</span></div>`;
            }
            if (data.focal_length) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.focalLength')}</span><span class="exif-value">${data.focal_length}mm</span></div>`;
            }
            if (data.subject_distance) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.focusDistance')}</span><span class="exif-value">${data.subject_distance}m</span></div>`;
            }
            if (data.digital_zoom) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.digitalZoom')}</span><span class="exif-value">${data.digital_zoom}x</span></div>`;
            }
            if (data.flash !== undefined && data.flash !== '') {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.flash')}</span><span class="exif-value">${data.flash}</span></div>`;
            }
            if (data.white_balance) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.whiteBalance')}</span><span class="exif-value">${data.white_balance}</span></div>`;
            }
            if (data.light_source) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.lightSource')}</span><span class="exif-value">${data.light_source}</span></div>`;
            }
            if (data.metering_mode) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.meteringMode')}</span><span class="exif-value">${data.metering_mode}</span></div>`;
            }
            if (data.exposure_mode) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.exposureMode')}</span><span class="exif-value">${data.exposure_mode}</span></div>`;
            }
            if (data.exposure_program) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.exposureProgram')}</span><span class="exif-value">${data.exposure_program}</span></div>`;
            }
            if (data.scene_type) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.sceneType')}</span><span class="exif-value">${data.scene_type}</span></div>`;
            }
            if (data.contrast) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.contrast')}</span><span class="exif-value">${data.contrast}</span></div>`;
            }
            if (data.saturation) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.saturation')}</span><span class="exif-value">${data.saturation}</span></div>`;
            }
            if (data.sharpness) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.sharpness')}</span><span class="exif-value">${data.sharpness}</span></div>`;
            }
            if (data.color_space) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.colorSpace')}</span><span class="exif-value">${data.color_space}</span></div>`;
            }
            if (data.orientation) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.orientation')}</span><span class="exif-value">${data.orientation}</span></div>`;
            }
            if (data.sensing_method) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.sensingMethod')}</span><span class="exif-value">${data.sensing_method}</span></div>`;
            }
            if (data.cfa_pattern) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.cfaPattern')}</span><span class="exif-value">${data.cfa_pattern}</span></div>`;
            }
            if (data.custom_rendered) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.customRendered')}</span><span class="exif-value">${data.custom_rendered}</span></div>`;
            }
            if (data.gain_control) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.gainControl')}</span><span class="exif-value">${data.gain_control}</span></div>`;
            }
            html += '</div>';
        }
        
        // GPS
        if (data.gps && data.gps.latitude !== undefined && data.gps.longitude !== undefined) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.location') + '</div>';
            html += `<div class="exif-item"><span class="exif-label">${t('exif.latitude')}</span><span class="exif-value">${data.gps.latitude.toFixed(6)}</span></div>`;
            html += `<div class="exif-item"><span class="exif-label">${t('exif.longitude')}</span><span class="exif-value">${data.gps.longitude.toFixed(6)}</span></div>`;
            if (data.gps.altitude) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.altitude')}</span><span class="exif-value">${data.gps.altitude}m</span></div>`;
            }
            if (data.gps.google_maps) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.map')}</span><a href="${data.gps.google_maps}" target="_blank" class="exif-value">${t('exif.viewInMaps')} ↗</a></div>`;
            }
            if (data.gps_altitude) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.gpsAltitude')}</span><span class="exif-value">${data.gps_altitude}</span></div>`;
            }
            if (data.gps_timestamp) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.gpsTime')}</span><span class="exif-value">${data.gps_timestamp}</span></div>`;
            }
            if (data.gps_datestamp) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.gpsDate')}</span><span class="exif-value">${data.gps_datestamp}</span></div>`;
            }
            if (data.gps_speed) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.gpsSpeed')}</span><span class="exif-value">${data.gps_speed}</span></div>`;
            }
            if (data.gps_track) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.gpsTrack')}</span><span class="exif-value">${data.gps_track}</span></div>`;
            }
            html += '</div>';
        }
        
        // 视频信息
        if (data.media_type === 'video' || data.duration || data.codec || data.fps) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.videoInfo') + '</div>';
            if (data.duration) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.duration')}</span><span class="exif-value">${data.duration}</span></div>`;
            }
            if (data.duration_seconds) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.durationSec')}</span><span class="exif-value">${data.duration_seconds}s</span></div>`;
            }
            if (data.width && data.height) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.resolution')}</span><span class="exif-value">${data.width} × ${data.height}</span></div>`;
            }
            if (data.codec) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.videoCodec')}</span><span class="exif-value">${data.codec}</span></div>`;
            }
            if (data.codec_tag) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.codecTag')}</span><span class="exif-value">${data.codec_tag}</span></div>`;
            }
            if (data.profile) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.profile')}</span><span class="exif-value">${data.profile}</span></div>`;
            }
            if (data.level) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.level')}</span><span class="exif-value">${data.level}</span></div>`;
            }
            if (data.bitrate) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.bitrate')}</span><span class="exif-value">${data.bitrate}</span></div>`;
            }
            if (data.fps) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.fps')}</span><span class="exif-value">${data.fps} fps</span></div>`;
            }
            if (data.avg_frame_rate) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.avgFrameRate')}</span><span class="exif-value">${data.avg_frame_rate}</span></div>`;
            }
            if (data.nb_frames) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.totalFrames')}</span><span class="exif-value">${data.nb_frames}</span></div>`;
            }
            if (data.pixel_format) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.pixelFormat')}</span><span class="exif-value">${data.pixel_format}</span></div>`;
            }
            if (data.color_range) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.colorRange')}</span><span class="exif-value">${data.color_range}</span></div>`;
            }
            if (data.color_space) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.colorSpace')}</span><span class="exif-value">${data.color_space}</span></div>`;
            }
            if (data.color_transfer) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.colorTransfer')}</span><span class="exif-value">${data.color_transfer}</span></div>`;
            }
            if (data.color_primaries) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.colorPrimaries')}</span><span class="exif-value">${data.color_primaries}</span></div>`;
            }
            if (data.display_aspect_ratio) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.displayAspect')}</span><span class="exif-value">${data.display_aspect_ratio}</span></div>`;
            }
            if (data.sample_aspect_ratio) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.sampleAspect')}</span><span class="exif-value">${data.sample_aspect_ratio}</span></div>`;
            }
            if (data.field_order) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.fieldOrder')}</span><span class="exif-value">${data.field_order}</span></div>`;
            }
            if (data.chroma_location) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.chromaLocation')}</span><span class="exif-value">${data.chroma_location}</span></div>`;
            }
            if (data.bits_per_raw_sample) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.bitDepth')}</span><span class="exif-value">${data.bits_per_raw_sample}bit</span></div>`;
            }
            if (data.has_b_frames !== undefined && data.has_b_frames !== '') {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.bFrames')}</span><span class="exif-value">${data.has_b_frames}</span></div>`;
            }
            if (data.is_avc) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.avc')}</span><span class="exif-value">${data.is_avc}</span></div>`;
            }
            if (data.nal_length_size) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.nalLength')}</span><span class="exif-value">${data.nal_length_size}</span></div>`;
            }
            html += '</div>';
            
            // 音频信息
            if (data.audio_codec || data.audio_sample_rate || data.audio_channels) {
                html += '<div class="exif-section">';
                html += '<div class="exif-section-title">' + t('exif.audio') + '</div>';
                if (data.audio_codec) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.audioCodec')}</span><span class="exif-value">${data.audio_codec}</span></div>`;
                }
                if (data.audio_sample_rate) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.sampleRate')}</span><span class="exif-value">${data.audio_sample_rate} Hz</span></div>`;
                }
                if (data.audio_channels) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.channels')}</span><span class="exif-value">${data.audio_channels}</span></div>`;
                }
                if (data.audio_channel_layout) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.channelLayout')}</span><span class="exif-value">${data.audio_channel_layout}</span></div>`;
                }
                if (data.audio_bit_rate) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.audioBitrate')}</span><span class="exif-value">${data.audio_bit_rate}</span></div>`;
                }
                if (data.audio_sample_fmt) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.sampleFormat')}</span><span class="exif-value">${data.audio_sample_fmt}</span></div>`;
                }
                if (data.audio_bits_per_sample) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.sampleBitDepth')}</span><span class="exif-value">${data.audio_bits_per_sample}bit</span></div>`;
                }
                html += '</div>';
            }
            
            // 容器信息
            if (data.format_name || data.format_long_name || data.nb_streams) {
                html += '<div class="exif-section">';
                html += '<div class="exif-section-title">' + t('exif.container') + '</div>';
                if (data.format_long_name) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.format')}</span><span class="exif-value">${data.format_long_name}</span></div>`;
                }
                if (data.format_name) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.formatName')}</span><span class="exif-value">${data.format_name}</span></div>`;
                }
                if (data.nb_streams) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.streamCount')}</span><span class="exif-value">${data.nb_streams}</span></div>`;
                }
                if (data.probe_score) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.probeScore')}</span><span class="exif-value">${data.probe_score}</span></div>`;
                }
                html += '</div>';
            }
            
            // 视频标签/元数据
            if (data.creation_time || data.encoder || data.major_brand || data.location) {
                html += '<div class="exif-section">';
                html += '<div class="exif-section-title">' + t('exif.videoMetadata') + '</div>';
                if (data.creation_time) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.createTime')}</span><span class="exif-value">${data.creation_time}</span></div>`;
                }
                if (data.encoder) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.encoder')}</span><span class="exif-value">${data.encoder}</span></div>`;
                }
                if (data.major_brand) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.brand')}</span><span class="exif-value">${data.major_brand}</span></div>`;
                }
                if (data.minor_version) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.version')}</span><span class="exif-value">${data.minor_version}</span></div>`;
                }
                if (data.compatible_brands) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.compatibleBrands')}</span><span class="exif-value">${data.compatible_brands}</span></div>`;
                }
                if (data.com_android_version) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.androidVersion')}</span><span class="exif-value">${data.com_android_version}</span></div>`;
                }
                if (data.com_android_manufacturer) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.deviceMake')}</span><span class="exif-value">${data.com_android_manufacturer}</span></div>`;
                }
                if (data.com_android_model) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.deviceModel')}</span><span class="exif-value">${data.com_android_model}</span></div>`;
                }
                if (data.location) {
                    html += `<div class="exif-item"><span class="exif-label">${t('exif.location')}</span><span class="exif-value">${data.location}</span></div>`;
                }
                html += '</div>';
            }
        }
        
        // 软件/处理信息
        if (data.software || data.copyright || data.artist || data.image_description || data.user_comment) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.metadata') + '</div>';
            if (data.software) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.software')}</span><span class="exif-value">${data.software}</span></div>`;
            }
            if (data.copyright) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.copyright')}</span><span class="exif-value">${data.copyright}</span></div>`;
            }
            if (data.artist) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.artist')}</span><span class="exif-value">${data.artist}</span></div>`;
            }
            if (data.image_description) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.description')}</span><span class="exif-value">${data.image_description}</span></div>`;
            }
            if (data.user_comment) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.userComment')}</span><span class="exif-value">${data.user_comment}</span></div>`;
            }
            html += '</div>';
        }
        
        // 分辨率信息
        if (data.resolution_x || data.resolution_y || data.resolution_unit) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.resolution') + '</div>';
            if (data.resolution_x) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.xResolution')}</span><span class="exif-value">${data.resolution_x}</span></div>`;
            }
            if (data.resolution_y) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.yResolution')}</span><span class="exif-value">${data.resolution_y}</span></div>`;
            }
            if (data.resolution_unit) {
                html += `<div class="exif-item"><span class="exif-label">${t('exif.resolutionUnit')}</span><span class="exif-value">${data.resolution_unit}</span></div>`;
            }
            html += '</div>';
        }
        
        // 路径
        if (data.path) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.path') + '</div>';
            html += `<div class="exif-item"><span class="exif-value exif-path" title="${data.path}">${data.path}</span></div>`;
            html += '</div>';
        }
        
        // 错误信息
        if (data.exif_error) {
            html += '<div class="exif-section">';
            html += '<div class="exif-section-title">' + t('exif.error') + '</div>';
            html += `<div class="exif-item"><span class="exif-value">${data.exif_error}</span></div>`;
            html += '</div>';
        }
        
        infoPanel.innerHTML = html || '<div class="exif-loading">' + t('empty.noExif') + '</div>';
    } catch (err) {
        console.error(t('empty.noExif') + ':', err);
        infoPanel.innerHTML = '<div class="exif-loading">' + t('empty.noExif') + ': ' + err.message + '</div>';
    }
}

function openLightbox(photoId) {
    photoId = parseInt(photoId);
    const photo = filteredPhotos.find(p => p.id === photoId);
    if (!photo) {
        console.error('Photo not found:', photoId);
        return;
    }

    currentIndex = filteredPhotos.findIndex(p => p.id === photoId);

    const viewer = document.getElementById('viewer');
    const mediaContainer = document.getElementById('viewer-media-container');
    const counter = document.getElementById('viewer-index');

    // 渲染主媒体
    mediaContainer.innerHTML = '';
    if (photo.media_type === 'video') {
        const video = document.createElement('video');
        video.src = photo.original_url;
        video.controls = true;
        video.autoplay = true;
        mediaContainer.appendChild(video);
    } else {
        const img = document.createElement('img');
        img.src = photo.original_url;
        img.alt = photo.filename;
        mediaContainer.appendChild(img);
    }

    // 计数器（仅显示当前序号，不显示总数）
    counter.textContent = `${currentIndex + 1}`;

    // 显示查看器
    viewer.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    
    // 加载 EXIF 和缩略图条
    loadPhotoExif(photoId);
    renderFilmstrip();
}

function closeLightbox() {
    const viewer = document.getElementById('viewer');
    const container = document.getElementById('viewer-media-container');

    const video = container.querySelector('video');
    if (video) {
        video.pause();
        video.src = '';
    }

    viewer.classList.add('hidden');
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

// 渲染底部缩略图条
function renderFilmstrip() {
    const filmstrip = document.getElementById('filmstrip-inner');
    if (!filmstrip) return;
    
    filmstrip.innerHTML = '';
    
    // 只渲染当前索引附近的照片，避免过多 DOM 节点
    const range = 30;
    const start = Math.max(0, currentIndex - range);
    const end = Math.min(filteredPhotos.length, currentIndex + range + 1);
    
    for (let i = start; i < end; i++) {
        const photo = filteredPhotos[i];
        const item = document.createElement('div');
        item.className = 'filmstrip-item' + (i === currentIndex ? ' active' : '');
        item.dataset.index = i;
        
        const img = document.createElement('img');
        img.src = photo.thumbnail_url;
        img.alt = photo.filename;
        img.loading = 'lazy';
        item.appendChild(img);
        
        if (photo.media_type === 'video') {
            const icon = document.createElement('span');
            icon.className = 'filmstrip-video-icon';
            icon.innerHTML = '<svg width="12" height="12"><use href="#icon-play"/></svg>';
            item.appendChild(icon);
        }
        
        item.addEventListener('click', () => {
            currentIndex = i;
            openLightbox(photo.id);
        });
        
        filmstrip.appendChild(item);
    }
    
    // 滚动到当前项
    requestAnimationFrame(() => {
        const activeItem = filmstrip.querySelector('.filmstrip-item.active');
        if (activeItem) {
            activeItem.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    });
}

async function deleteCurrentPhoto() {
    if (filteredPhotos.length === 0) return;

    const photo = filteredPhotos[currentIndex];
    const typeName = photo.media_type === 'video' ? t('dialog.video') : t('dialog.photo');

    const confirmed = await showDialog({
        type: 'confirm',
        icon: '<svg width=\"32\" height=\"32\"><use href=\"#icon-trash\"/></svg>',
        title: t('dialog.confirmDeleteSingle', typeName),
        message: t('dialog.confirmDeleteSingleMsg', typeName, photo.filename),
        confirmText: t('action.delete'),
        confirmClass: 'btn btn-danger',
        cancelText: t('action.cancel')
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
            showToast(t('dialog.restored'));
        } else {
            showToast(data.error || t('dialog.deleteFailed'));
        }
    } catch (err) {
        console.error(t('dialog.deleteFailed') + ':', err);
        showToast(t('dialog.deleteFailed') + ': ' + err.message);
    }
}

// ========== 状态栏 ==========
function updateStatus(total, selected) {
    const text = selected > 0
        ? t('status.totalSelected', total, selected)
        : t('status.totalCount', total);
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
        const hiddenEl = document.getElementById('count-hidden');
        if (hiddenEl) hiddenEl.textContent = stats.hidden || '';
        const dupEl = document.getElementById('count-duplicates');
        if (dupEl) dupEl.textContent = stats.duplicates || '';
    } catch (err) {
        console.error(t('empty.noStats') + ':', err);
    }
}

async function loadDiskUsage() {
    try {
        const res = await fetch('/api/disk_usage');
        const data = await res.json();
        if (data.error) return;

        const container = document.getElementById('disk-usage');
        const textEl = document.getElementById('disk-usage-text');
        const fillEl = document.getElementById('disk-usage-fill');
        if (!container || !textEl || !fillEl) return;

        container.classList.remove('hidden');
        textEl.textContent = `${data.used_formatted} / ${data.total_formatted}`;
        fillEl.style.width = data.percent + '%';

        fillEl.classList.remove('warning', 'danger');
        if (data.percent >= 90) {
            fillEl.classList.add('danger');
        } else if (data.percent >= 75) {
            fillEl.classList.add('warning');
        }
    } catch (e) {
        console.error('Load disk usage failed:', e);
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
                <svg class="sidebar-icon" width="18" height="18"><use href="#icon-folder"/></svg>
                <span class="sidebar-label" title="${src.path}">${src.name}</span>
                <span class="sidebar-count">${src.count}</span>
            `;
            li.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.timeline-month').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.timeline-year').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.timeline-day').forEach(i => i.classList.remove('active'));
                li.classList.add('active');
                document.getElementById('view-title').textContent = src.name;
                currentView = 'source';
                currentTab = 'all';
                currentYearFilter = null;
                currentMonthFilter = null;
                currentDayFilter = null;
                currentAlbumId = null;
                searchQuery = '';
                currentSourcePath = src.path;
                resetPhotos();
                loadPhotosBySource(src.path);
                saveSession();
            });
            list.appendChild(li);
        });
    } catch (err) {
        console.error(t('empty.noStats') + ':', err);
    }
}

async function loadPhotosBySource(sourcePath) {
    if (isLoading) return;
    isLoading = true;
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        const response = await fetch(`/api/photos?source=${encodeURIComponent(sourcePath)}&page=1&per_page=9999&filter_type=${photoFilterType}`);
        const data = await response.json();
        allPhotos = data.photos;
        filteredPhotos = allPhotos;
        if (virtualTimeline) {
            virtualTimeline.destroy();
            virtualTimeline = null;
        }
        renderPhotos(data.photos);
        updateStatus(data.total, 0);
        hasMore = false;
    } catch (err) {
        console.error(t('empty.noStats') + ':', err);
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
                <svg class="sidebar-icon" width="18" height="18"><use href="#icon-folder"/></svg>
                <span class="sidebar-label">${album.name}</span>
                <span class="sidebar-count">${album.count || 0}</span>
            `;
            li.addEventListener('click', () => {
                document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.timeline-month').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.timeline-year').forEach(i => i.classList.remove('active'));
                document.querySelectorAll('.timeline-day').forEach(i => i.classList.remove('active'));
                li.classList.add('active');
                document.getElementById('view-title').textContent = album.name;
                currentView = 'album';
                currentTab = 'all';
                currentYearFilter = null;
                currentMonthFilter = null;
                currentDayFilter = null;
                currentSourcePath = '';
                searchQuery = '';
                currentAlbumId = album.id;
                resetPhotos();
                loadPhotosByAlbum(album.id);
                saveSession();
            });
            list.appendChild(li);
        });
    } catch (err) {
        console.error(t('empty.noStats') + ':', err);
    }
}

async function loadPhotosByAlbum(albumId) {
    if (isLoading) return;
    isLoading = true;
    const loadingEl = document.getElementById('loading');
    loadingEl.classList.add('visible');

    try {
        const response = await fetch(`/api/albums/${albumId}/photos?filter_type=${photoFilterType}`);
        const data = await response.json();
        allPhotos = data.photos;
        filteredPhotos = allPhotos;
        if (virtualTimeline) {
            virtualTimeline.destroy();
            virtualTimeline = null;
        }
        renderPhotos(data.photos);
        updateStatus(data.photos.length, 0);
        hasMore = false;
    } catch (err) {
        console.error(t('empty.noStats') + ':', err);
    } finally {
        isLoading = false;
        loadingEl.classList.remove('visible');
    }
}

// ========== 事件监听 ==========
document.querySelector('.viewer-close').addEventListener('click', closeLightbox);
document.querySelector('.viewer-delete-btn').addEventListener('click', deleteCurrentPhoto);
document.querySelector('.viewer-prev').addEventListener('click', showPrev);
document.querySelector('.viewer-next').addEventListener('click', showNext);

// 移动端信息面板切换
const viewerInfoToggle = document.querySelector('.viewer-info-toggle');
if (viewerInfoToggle) {
    viewerInfoToggle.addEventListener('click', () => {
        const sidebar = document.getElementById('viewer-sidebar');
        if (sidebar) sidebar.classList.toggle('mobile-open');
    });
}

// 缩略图条滚轮横向滚动
document.querySelector('.viewer-filmstrip').addEventListener('wheel', (e) => {
    if (e.deltaY !== 0) {
        e.preventDefault();
        e.currentTarget.scrollLeft += e.deltaY;
    }
}, { passive: false });

document.getElementById('viewer').addEventListener('click', (e) => {
    if (e.target.id === 'viewer') {
        closeLightbox();
    }
});

document.addEventListener('keydown', (e) => {
    const viewer = document.getElementById('viewer');

    if (!viewer.classList.contains('hidden')) {
        if (e.key === 'Escape') closeLightbox();
        if (e.key === 'ArrowRight') showNext();
        if (e.key === 'ArrowLeft') showPrev();
        if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault();
            deleteCurrentPhoto();
        }
        const video = document.querySelector('#viewer-media-container video');
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

// ========== 灯箱 Pinch-to-Zoom ==========
let pinchState = {
    scale: 1,
    panX: 0,
    panY: 0,
    initialDistance: 0,
    initialScale: 1,
    isPinching: false,
    isPanning: false,
    startPanX: 0,
    startPanY: 0,
    touchStartX: 0,
    touchStartY: 0,
};

function getDistance(touches) {
    const dx = touches[0].screenX - touches[1].screenX;
    const dy = touches[0].screenY - touches[1].screenY;
    return Math.sqrt(dx * dx + dy * dy);
}

function getCenter(touches) {
    return {
        x: (touches[0].screenX + touches[1].screenX) / 2,
        y: (touches[0].screenY + touches[1].screenY) / 2,
    };
}

function applyTransform(img) {
    if (!img) return;
    img.style.transform = `translate(${pinchState.panX}px, ${pinchState.panY}px) scale(${pinchState.scale})`;
}

function resetZoom(img) {
    pinchState.scale = 1;
    pinchState.panX = 0;
    pinchState.panY = 0;
    if (img) {
        img.style.transition = 'transform 0.25s ease';
        applyTransform(img);
        setTimeout(() => { if (img) img.style.transition = ''; }, 250);
    }
}

const viewerEl = document.getElementById('viewer');

viewerEl.addEventListener('touchstart', (e) => {
    const img = document.querySelector('#viewer-media-container img');
    if (!img) return;

    if (e.touches.length === 2) {
        // 双指开始缩放
        e.preventDefault();
        pinchState.isPinching = true;
        pinchState.initialDistance = getDistance(e.touches);
        pinchState.initialScale = pinchState.scale;
        img.style.transition = '';
    } else if (e.touches.length === 1 && pinchState.scale > 1.05) {
        // 单指开始平移（已缩放状态）
        pinchState.isPanning = true;
        pinchState.startPanX = pinchState.panX;
        pinchState.startPanY = pinchState.panY;
        pinchState.touchStartX = e.touches[0].screenX;
        pinchState.touchStartY = e.touches[0].screenY;
        img.style.transition = '';
    } else if (e.touches.length === 1) {
        // 单指记录滑动起点
        pinchState.touchStartX = e.touches[0].screenX;
    }
}, { passive: false });

viewerEl.addEventListener('touchmove', (e) => {
    const img = document.querySelector('#viewer-media-container img');
    if (!img) return;

    if (e.touches.length === 2 && pinchState.isPinching) {
        e.preventDefault();
        const distance = getDistance(e.touches);
        const ratio = distance / pinchState.initialDistance;
        let newScale = pinchState.initialScale * ratio;
        newScale = Math.max(1, Math.min(newScale, 5));
        pinchState.scale = newScale;
        applyTransform(img);
    } else if (e.touches.length === 1 && pinchState.isPanning && pinchState.scale > 1.05) {
        e.preventDefault();
        const dx = e.touches[0].screenX - pinchState.touchStartX;
        const dy = e.touches[0].screenY - pinchState.touchStartY;
        pinchState.panX = pinchState.startPanX + dx;
        pinchState.panY = pinchState.startPanY + dy;
        applyTransform(img);
    }
}, { passive: false });

viewerEl.addEventListener('touchend', (e) => {
    const img = document.querySelector('#viewer-media-container img');
    if (!img) return;

    if (pinchState.isPinching && e.touches.length < 2) {
        pinchState.isPinching = false;
        if (pinchState.scale < 1.05) {
            resetZoom(img);
        }
    }
    if (pinchState.isPanning && e.touches.length === 0) {
        pinchState.isPanning = false;
        if (pinchState.scale < 1.05) {
            resetZoom(img);
        }
    }
    // 单指滑动切换（仅在未缩放时）
    if (e.changedTouches.length === 1 && pinchState.scale <= 1.05 && !pinchState.isPinching) {
        const touchEndX = e.changedTouches[0].screenX;
        const diff = pinchState.touchStartX - touchEndX;
        const swipeThreshold = 50;
        if (Math.abs(diff) > swipeThreshold) {
            if (diff > 0) showNext();
            else showPrev();
        }
    }
});

// 双击放大/还原
viewerEl.addEventListener('dblclick', (e) => {
    const img = document.querySelector('#viewer-media-container img');
    if (!img) return;
    if (pinchState.scale > 1.05) {
        resetZoom(img);
    } else {
        pinchState.scale = 2.5;
        pinchState.panX = 0;
        pinchState.panY = 0;
        img.style.transition = 'transform 0.25s ease';
        applyTransform(img);
        setTimeout(() => { if (img) img.style.transition = ''; }, 250);
    }
});

// 切换照片时重置缩放
const originalOpenLightbox = openLightbox;
openLightbox = function(photoId) {
    pinchState.scale = 1;
    pinchState.panX = 0;
    pinchState.panY = 0;
    pinchState.isPinching = false;
    pinchState.isPanning = false;
    originalOpenLightbox(photoId);
    const img = document.querySelector('#viewer-media-container img');
    if (img) {
        img.style.transform = '';
        img.style.transition = '';
    }
};

// 拖选框选
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragBox = null;

document.addEventListener('mousedown', (e) => {
    if (!selectionMode) return;
    if (e.target.closest('.photo-item') || e.target.closest('.btn') || e.target.closest('.viewer') || e.target.closest('.custom-dialog')) return;

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
const initBtn = (id, event, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, fn);
};

initBtn('select-mode-btn', 'click', enableSelectionMode);
initBtn('cancel-selection-btn', 'click', disableSelectionMode);
initBtn('batch-delete-btn', 'click', batchDelete);
initBtn('trash-restore-all-btn', 'click', restoreAllTrash);
initBtn('trash-delete-all-btn', 'click', deleteAllTrash);

// 重复照片删除按钮
initBtn('duplicates-delete-btn', 'click', deleteMarkedDuplicates);

// 一键清理重复照片（每组保留精度最高的一张）
let cleanupPollInterval = null;

function updateCleanupProgress(data) {
    const progressEl = document.getElementById('cleanup-progress');
    const fillEl = document.getElementById('cleanup-progress-fill');
    const textEl = document.getElementById('cleanup-progress-text');
    
    if (!progressEl || !fillEl || !textEl) return;
    
    progressEl.classList.remove('hidden');
    const total = data.total_groups || 1;
    const pct = Math.min(100, Math.round((data.processed_groups / total) * 100));
    fillEl.style.width = pct + '%';
    textEl.textContent = `${data.processed_groups} / ${total} · ${t('duplicates.deleted', data.deleted_count || 0)}`;
}

async function pollCleanupStatus() {
    try {
        const res = await fetch('/api/duplicates/cleanup/status');
        const data = await res.json();
        updateCleanupProgress(data);
        
        if (!data.is_running) {
            if (cleanupPollInterval) {
                clearInterval(cleanupPollInterval);
                cleanupPollInterval = null;
            }
            _setCleanupButtonsLoading(false);
            showToast(data.message || t('duplicates.cleanupComplete') || '清理完成');
            duplicatePage = 1;
            duplicateHasMore = true;
            const timeline = document.getElementById('timeline');
            timeline.innerHTML = '';
            await loadDuplicates();
            loadSidebarCounts();
            loadStats();
            setTimeout(() => {
                const progressEl = document.getElementById('cleanup-progress');
                if (progressEl) progressEl.classList.add('hidden');
            }, 3000);
        }
    } catch (e) {
        console.error('轮询清理状态失败:', e);
    }
}

function _setCleanupButtonsLoading(loading) {
    const dupCleanupBtn = document.getElementById('duplicates-cleanup-btn');
    const dupCleanupActionBtn = document.getElementById('dup-cleanup-action-btn');
    const spinner = '<span class="btn-spinner"></span>';
    const text = t('duplicates.cleaning') || '清理中...';
    [dupCleanupBtn, dupCleanupActionBtn].forEach(btn => {
        if (!btn) return;
        btn.disabled = loading;
        if (loading) {
            btn.dataset.originalText = btn.textContent;
            btn.innerHTML = spinner + text;
        } else {
            btn.innerHTML = btn.dataset.originalText || (t('duplicates.oneClickCleanup') || '一键清理');
            delete btn.dataset.originalText;
        }
    });
}

async function startCleanup(buttonEl) {
    const confirmed = await showDialog({
        type: 'confirm',
        icon: '<svg width="32" height="32"><use href="#icon-alert"/></svg>',
        title: t('duplicates.oneClickCleanup') || '一键清理',
        message: t('duplicates.cleanupConfirm') || '确定一键清理重复照片吗？每组将只保留精度最高的一张，其余全部移到回收站。此操作不可撤销！',
        confirmText: t('action.confirm'),
        confirmClass: 'btn btn-danger',
        cancelText: t('action.cancel')
    });
    if (!confirmed) return;

    // If triggered from view-header button, show duplicates-bar and scroll to top
    if (buttonEl.id === 'dup-cleanup-action-btn') {
        const dupBar = document.getElementById('duplicates-bar');
        if (dupBar) {
            dupBar.classList.remove('hidden');
            dupBar.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    _setCleanupButtonsLoading(true);
    showToast(t('duplicates.cleanupStarted') || '清理已开始');

    try {
        const res = await fetch('/api/duplicates/cleanup', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            // 启动轮询
            if (cleanupPollInterval) clearInterval(cleanupPollInterval);
            cleanupPollInterval = setInterval(pollCleanupStatus, 500);
        } else {
            showToast(data.message || '清理失败');
            _setCleanupButtonsLoading(false);
        }
    } catch (e) {
        console.error('一键清理失败:', e);
        showToast('清理请求失败');
        _setCleanupButtonsLoading(false);
    }
}

const dupCleanupBtn = document.getElementById('duplicates-cleanup-btn');
if (dupCleanupBtn) {
    dupCleanupBtn.addEventListener('click', () => startCleanup(dupCleanupBtn));
}

const dupCleanupActionBtn = document.getElementById('dup-cleanup-action-btn');
if (dupCleanupActionBtn) {
    dupCleanupActionBtn.addEventListener('click', () => startCleanup(dupCleanupActionBtn));
}

// 批量应用默认设置（每组保留质量最高的副本）
const dupApplyDefaultBtn = document.getElementById('duplicates-apply-default-btn');
if (dupApplyDefaultBtn) {
    dupApplyDefaultBtn.addEventListener('click', () => {
        document.querySelectorAll('.duplicate-group').forEach(group => {
            const keepRadios = group.querySelectorAll('.duplicate-keep-radio');
            keepRadios.forEach((radio, idx) => {
                radio.checked = idx === 0;
                const label = radio.closest('.duplicate-radio-label');
                if (idx === 0) {
                    label.classList.add('duplicate-keep-checked');
                } else {
                    label.classList.remove('duplicate-keep-checked');
                }
            });
        });
        updateDuplicatesBar();
        showToast(t('duplicates.defaultApplied'));
    });
}
// ========== 设置面板 ==========
const settingsPanel = document.getElementById('settings-panel');
const settingsClose = document.getElementById('settings-close');
const settingsOverlay = settingsPanel.querySelector('.settings-overlay');

document.getElementById('settings-btn').addEventListener('click', () => {
    settingsPanel.classList.remove('hidden');
    loadLibraryPaths();
});

settingsClose.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
});

settingsOverlay.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
});

// ========== Library Paths Management ==========
async function loadLibraryPaths() {
    try {
        const res = await fetch('/api/library_paths');
        const paths = await res.json();
        const container = document.getElementById('library-paths-list');
        if (!container) return;
        
        container.innerHTML = '';
        paths.forEach(item => {
            const div = document.createElement('div');
            div.className = 'library-path-item' + (item.enabled ? '' : ' disabled');
            div.dataset.id = item.id;
            
            const name = item.path.split('/').filter(Boolean).pop() || item.path;
            
            const statusLabel = item.enabled ? t('settings.enabled') : t('settings.disabled');
            div.innerHTML = `
                <input type="checkbox" ${item.enabled ? 'checked' : ''} title="${t('settings.enabled')} / ${t('settings.disabled')}">
                <div class="library-path-info">
                    <div class="library-path-name" title="${item.path}">${item.path}</div>
                    <div class="library-path-meta">
                        <span class="library-path-count">${item.count} ${t('status.items', item.count)}</span>
                        <span class="library-path-status ${item.enabled ? 'enabled' : 'disabled'}">${statusLabel}</span>
                    </div>
                </div>
                <button class="library-path-delete" title="${t('action.delete')}">
                    <svg width="16" height="16"><use href="#icon-trash"/></svg>
                </button>
            `;
            
            const checkbox = div.querySelector('input[type="checkbox"]');
            checkbox.addEventListener('change', async () => {
                try {
                    const res = await fetch(`/api/library_paths/${item.id}/toggle`, { method: 'POST' });
                    const data = await res.json();
                    if (data.success) {
                        div.classList.toggle('disabled', !data.enabled);
                        const statusEl = div.querySelector('.library-path-status');
                        if (statusEl) {
                            statusEl.textContent = data.enabled ? t('settings.enabled') : t('settings.disabled');
                            statusEl.classList.toggle('enabled', data.enabled);
                            statusEl.classList.toggle('disabled', !data.enabled);
                        }
                        loadSources();
                        loadStats();
                    }
                } catch (e) {
                    console.error('Toggle failed:', e);
                    checkbox.checked = !checkbox.checked;
                }
            });
            
            const deleteBtn = div.querySelector('.library-path-delete');
            deleteBtn.addEventListener('click', async () => {
                const confirmed = await showDialog({
                    type: 'confirm',
                    icon: '<svg width="32" height="32"><use href="#icon-trash"/></svg>',
                    title: t('dialog.confirmDeleteTitle'),
                    message: t('dialog.confirmDeleteSingleMsg', t('dialog.photo'), item.path),
                    confirmText: t('action.delete'),
                    confirmClass: 'btn btn-danger',
                    cancelText: t('action.cancel')
                });
                if (!confirmed) return;
                
                try {
                    const res = await fetch(`/api/library_paths/${item.id}`, { method: 'DELETE' });
                    const data = await res.json();
                    if (data.success) {
                        div.remove();
                        loadSources();
                        loadStats();
                    }
                } catch (e) {
                    console.error('Delete failed:', e);
                }
            });
            
            container.appendChild(div);
        });
    } catch (e) {
        console.error('Load library paths failed:', e);
    }
}

const addPathBtn = document.getElementById('add-library-path-btn');
const pathInput = document.getElementById('library-path-input');
const pathError = document.getElementById('library-path-error');

if (addPathBtn && pathInput) {
    addPathBtn.addEventListener('click', async () => {
        const path = pathInput.value.trim();
        if (!path) return;
        
        pathError.classList.add('hidden');
        addPathBtn.disabled = true;
        
        try {
            const res = await fetch('/api/library_paths', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path })
            });
            const data = await res.json();
            if (data.success) {
                pathInput.value = '';
                loadLibraryPaths();
                loadSources();
            } else {
                pathError.textContent = data.error || t('settings.pathNotFound');
                pathError.classList.remove('hidden');
            }
        } catch (e) {
            pathError.textContent = t('settings.pathNotFound');
            pathError.classList.remove('hidden');
        } finally {
            addPathBtn.disabled = false;
        }
    });
    
    pathInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addPathBtn.click();
    });
}

// ========== Map Provider Selector ==========
function initMapProviderSelector() {
    const buttons = document.querySelectorAll('.map-provider-btn');
    const currentProvider = getMapProvider();

    buttons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.provider === currentProvider);
        btn.addEventListener('click', () => {
            const provider = btn.dataset.provider;
            if (setMapProvider(provider)) {
                buttons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                showToast(t('settings.mapProvider') + ': ' + t('mapProvider.' + provider));
            }
        });
    });
}

// ========== GPS 补录 ==========
let backfillPollInterval = null;

function updateBackfillProgress(data) {
    const progressEl = document.getElementById('backfill-gps-progress');
    const fillEl = document.getElementById('backfill-gps-fill');
    const textEl = document.getElementById('backfill-gps-text');
    const btn = document.getElementById('backfill-gps-btn');

    progressEl.classList.remove('hidden');
    const total = data.total || 1;
    const pct = Math.min(100, Math.round((data.processed / total) * 100));
    fillEl.style.width = pct + '%';
    textEl.textContent = t('settings.progress', data.processed, data.total, data.updated);

    if (data.is_running) {
        btn.textContent = t('action.stopBackfill');
    } else {
        btn.textContent = t('action.startBackfill');
    }
}

async function pollBackfillStatus() {
    try {
        const res = await fetch('/api/backfill_gps/status');
        const data = await res.json();
        updateBackfillProgress(data);
        if (!data.is_running) {
            clearInterval(backfillPollInterval);
            backfillPollInterval = null;
            showToast(data.message_key ? t(data.message_key) : t('settings.backfillComplete'));
            setTimeout(() => {
                document.getElementById('backfill-gps-progress').classList.add('hidden');
            }, 3000);
        }
    } catch (e) {
        console.error(t('settings.backfillStartFailed'), e);
    }
}

document.getElementById('backfill-gps-btn').addEventListener('click', async () => {
    const btn = document.getElementById('backfill-gps-btn');
    if (btn.textContent === t('action.stopBackfill')) {
        await fetch('/api/backfill_gps/stop', { method: 'POST' });
        return;
    }

    const res = await fetch('/api/backfill_gps/start', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
        showToast(t('settings.backfillStarted'));
        document.getElementById('backfill-gps-progress').classList.remove('hidden');
        if (backfillPollInterval) clearInterval(backfillPollInterval);
        backfillPollInterval = setInterval(pollBackfillStatus, 1000);
    } else {
        showToast(data.message_key ? t(data.message_key) : t('settings.backfillStartFailed'));
    }
});
document.getElementById('new-album-btn').addEventListener('click', () => {
    showToast(t('dialog.newAlbumWIP'));
});

// 扫描重复照片
document.getElementById('scan-duplicates-btn').addEventListener('click', async () => {
    const btn = document.getElementById('scan-duplicates-btn');
    const resultEl = document.getElementById('scan-duplicates-result');
    btn.disabled = true;
    btn.textContent = t('settings.scanning') || '扫描中...';
    resultEl.classList.add('hidden');

    try {
        const res = await fetch('/api/scan_duplicates', { method: 'POST' });
        const data = await res.json();
        if (!data.success) {
            showToast(data.message || t('settings.scanFailed'));
            btn.disabled = false;
            btn.textContent = t('settings.startScan') || '开始扫描';
            return;
        }

        // 轮询状态
        const poll = setInterval(async () => {
            const statusRes = await fetch('/api/scan_duplicates/status');
            const status = await statusRes.json();
            if (!status.is_scanning) {
                clearInterval(poll);
                btn.disabled = false;
                btn.textContent = t('settings.startScan') || '开始扫描';
                const msg = status.message || t('settings.scanComplete');
                showToast(msg);
                resultEl.innerHTML = `<div class="permission-ok">${msg}</div>`;
                resultEl.classList.remove('hidden');
                // 刷新统计
                loadStats();
            }
        }, 800);
    } catch (err) {
        showToast(t('settings.scanFailed') || '扫描失败');
        btn.disabled = false;
        btn.textContent = t('settings.startScan') || '开始扫描';
    }
});

// 文件权限检查
document.getElementById('check-permission-btn').addEventListener('click', async () => {
    const btn = document.getElementById('check-permission-btn');
    const resultEl = document.getElementById('permission-result');
    btn.disabled = true;
    btn.textContent = t('settings.checking') || '检查中...';
    resultEl.classList.add('hidden');

    try {
        const res = await fetch('/api/check_permissions');
        const data = await res.json();

        let html = '';
        if (data.writable_count === data.total_count) {
            html = `<div class="permission-ok">${t('settings.permissionOK') || '所有文件权限正常，可以删除照片'}</div>`;
        } else {
            html = `<div class="permission-warn">⚠️ ${t('settings.permissionWarning') || '部分文件没有写权限'}</div>`;
            html += `<div class="permission-detail">${t('settings.writable') || '可写'}: ${data.writable_count} / ${t('settings.total') || '总计'}: ${data.total_count}</div>`;
            if (data.sample_paths && data.sample_paths.length > 0) {
                html += '<div class="permission-paths"><div>' + (t('settings.samplePaths') || '示例路径') + ':</div>';
                data.sample_paths.forEach(p => {
                    html += `<div class="permission-path">${p}</div>`;
                });
                html += '</div>';
            }
            html += `<div class="permission-hint">${t('settings.permissionHint') || '运行以下命令修复权限：'}</div>`;
            html += `<code class="permission-cmd">sudo chown -R ${data.user}:${data.user} ${data.library_path}</code>`;
        }
        resultEl.innerHTML = html;
        resultEl.classList.remove('hidden');
    } catch (err) {
        resultEl.innerHTML = `<div class="permission-error">${t('settings.permissionError') || '检查失败'}: ${err.message}</div>`;
        resultEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.textContent = t('settings.checkPermission') || '检查权限';
    }
});

// ========== 扫描进度弹窗 ==========
let scanProgressModal = null;
let scanProgressClose = null;
let scanProgressInterval = null;

function initScanProgress() {
    scanProgressModal = document.getElementById('scan-progress-modal');
    scanProgressClose = document.getElementById('scan-progress-close');
    if (!scanProgressModal || !scanProgressClose) {
        console.warn('扫描进度弹窗元素未找到');
        return;
    }
    scanProgressClose.addEventListener('click', closeScanProgress);
    document.querySelector('.scan-progress-overlay').addEventListener('click', closeScanProgress);
    
    // 设置页面的扫描按钮
    const scanLibraryBtn = document.getElementById('scan-library-btn');
    if (scanLibraryBtn) {
        scanLibraryBtn.addEventListener('click', async () => {
            const btn = document.getElementById('scan-library-btn');
            btn.disabled = true;
            btn.textContent = '扫描中...';
            
            try {
                const res = await fetch('/api/rescan', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    openScanProgress();
                }
            } catch (e) {
                showToast('启动扫描失败');
                btn.disabled = false;
                btn.textContent = '开始扫描';
            }
        });
    }
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function getPhaseText(phase) {
    const key = 'scan.phase.' + phase;
    return t(key) || phase;
}

function openScanProgress() {
    if (!scanProgressModal) return;
    scanProgressModal.classList.remove('hidden');
    updateScanProgress();
    scanProgressInterval = setInterval(updateScanProgress, 500);
}

function closeScanProgress() {
    if (scanProgressModal) scanProgressModal.classList.add('hidden');
    if (scanProgressInterval) {
        clearInterval(scanProgressInterval);
        scanProgressInterval = null;
    }
}

async function updateScanProgress() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        document.getElementById('scan-phase').textContent = getPhaseText(data.phase);
        document.getElementById('scan-progress-fill').style.width = data.progress_percent + '%';
        document.getElementById('scan-progress-text').textContent = `${data.scanned} / ${data.total}`;
        document.getElementById('scan-progress-percent').textContent = data.progress_percent + '%';
        document.getElementById('scan-elapsed').textContent = `已用: ${formatTime(data.elapsed_seconds)}`;
        document.getElementById('scan-eta').textContent = data.eta_seconds > 0 ? `预计剩余: ${formatTime(data.eta_seconds)}` : '预计剩余: --:--';
        
        const currentFile = data.current_file || '';
        document.getElementById('scan-current-file').textContent = currentFile ? `当前: ${currentFile}` : '';
        
        // 来源统计
        const sourcesEl = document.getElementById('scan-sources');
        if (data.sources && Object.keys(data.sources).length > 0) {
            let sourcesHtml = '<div style="margin-top:8px;font-weight:600;">各来源统计:</div>';
            for (const [source, count] of Object.entries(data.sources)) {
                sourcesHtml += `<div class="scan-source-item"><span>${source}</span><span>${count}</span></div>`;
            }
            sourcesEl.innerHTML = sourcesHtml;
        }
        
        // 扫描完成自动关闭
        if (!data.scanning && data.phase === 'idle' && data.total > 0) {
            setTimeout(() => {
                closeScanProgress();
                showToast('扫描完成');
                loadSidebarCounts();
            }, 1500);
        }
    } catch (e) {
        console.error('获取扫描状态失败:', e);
    }
}



function initLanguageSelector() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const lang = btn.dataset.lang;
            if (lang && lang !== currentLang) {
                setLang(lang);
            }
        });
    });

    // Refresh dynamic content when language changes
    window.addEventListener('languagechanged', () => {
        // Refresh view title
        const titleEl = document.getElementById('view-title');
        if (titleEl) {
            if (currentView === 'all') titleEl.textContent = t('title.allPhotos');
            else if (currentView === 'photos') titleEl.textContent = t('title.photos');
            else if (currentView === 'videos') titleEl.textContent = t('title.videos');
            else if (currentView === 'favorites') titleEl.textContent = t('title.favorites');
            else if (currentView === 'recent') titleEl.textContent = t('title.recent');
            else if (currentView === 'trash') titleEl.textContent = t('title.trash');
            else if (currentView === 'dbinfo') titleEl.textContent = t('title.dbInfo');
            else if (currentView === 'search' && searchQuery) titleEl.textContent = t('title.searchResults', searchQuery);
            else if (currentView === 'year' && currentYearFilter) {
                if (currentDayFilter) titleEl.textContent = t('title.dayFilter', currentYearFilter, currentMonthFilter, currentDayFilter);
                else if (currentMonthFilter) titleEl.textContent = t('title.monthFilter', currentYearFilter, currentMonthFilter);
                else titleEl.textContent = t('title.yearFilter', currentYearFilter);
            }
            else if (currentView === 'source' && currentSourcePath) titleEl.textContent = currentSourcePath;
            else if (currentView === 'album' && currentAlbumId) {
                const album = allAlbums.find(a => a.id === parseInt(currentAlbumId));
                titleEl.textContent = album ? album.name : t('title.photos');
            }
        }

        // Refresh timeline (year/month/day labels)
        const timeline = document.getElementById('timeline');
        if (timeline && currentTab === 'timeline') {
            timeline.innerHTML = '';
            currentPage = 1;
            hasMore = true;
            loadPhotos();
        }

        // Refresh years view
        if (currentTab === 'years') {
            renderYearsView();
        }

        // Refresh map
        if (currentTab === 'map' && typeof mapInstance !== 'undefined' && mapInstance) {
            loadMapView();
        }

        // Refresh stats
        loadStats();

        // Refresh EXIF panel if open
        const exifPanel = document.getElementById('exif-panel');
        if (exifPanel && !exifPanel.classList.contains('hidden') && currentPhotoId) {
            loadExifInfo(currentPhotoId);
        }

        // Refresh selection UI
        if (selectionMode) {
            updateSelectionUI();
        }

        // Refresh status bar
        updateStatus(filteredPhotos.length, selectedPhotos.size);
    });
}

async function init() {
    initScanProgress();
    initThumbSizeControl();
    initSidebar();
    initTopTabs();
    initSearch();
    initLanguageSelector();
    initMapProviderSelector();
    await loadTimelineData();
    setupInfiniteScroll();
    loadStats();
    loadSources();
    loadAlbums();
    loadDiskUsage();

    // 照片类型筛选下拉框
    const photoFilterSelect = document.getElementById('photo-filter-type');
    if (photoFilterSelect) {
        photoFilterSelect.addEventListener('change', (e) => {
            photoFilterType = e.target.value;
            resetPhotos();
            if (currentView === 'photos' || currentView === 'videos' || currentView === 'favorites' || currentView === 'recent') {
                loadFilteredPhotos(currentView);
            } else {
                loadPhotos();
            }
        });
    }

    // Try to restore session first; if no saved session, load default photos
    const restored = restoreSession();
    if (!restored) {
        await loadPhotos();
    }

    setupSessionAutoSave();
}

// ========== Session Persistence ==========
function saveSession() {
    const session = {
        currentView,
        currentTab,
        currentYearFilter,
        currentMonthFilter,
        currentDayFilter,
        searchQuery,
        currentSourcePath,
        currentAlbumId,
        scrollTop: document.getElementById('timeline')?.scrollTop || 0,
        thumbSize: parseInt(localStorage.getItem('thumbSize')) || 200
    };

    // Save map state if map is initialized
    if (mapInstance) {
        const center = mapInstance.getCenter();
        session.mapState = {
            lat: center.lat,
            lng: center.lng,
            zoom: mapInstance.getZoom()
        };
    }

    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function restoreSession() {
    try {
        const saved = localStorage.getItem(SESSION_KEY);
        if (!saved) return false;
        const session = JSON.parse(saved);

        // Restore thumbnail size
        if (session.thumbSize) {
            thumbSize = session.thumbSize;
            const slider = document.getElementById('thumb-size');
            if (slider) slider.value = thumbSize;
            applyThumbSize(thumbSize);
        }

        // Restore search query
        if (session.searchQuery) {
            const searchInput = document.getElementById('search-input');
            if (searchInput) searchInput.value = session.searchQuery;
            searchQuery = session.searchQuery;
        }

        // Restore year/month/day filters
        if (session.currentYearFilter) currentYearFilter = session.currentYearFilter;
        if (session.currentMonthFilter) currentMonthFilter = session.currentMonthFilter;
        if (session.currentDayFilter) currentDayFilter = session.currentDayFilter;

        // Restore source path
        if (session.currentSourcePath) {
            currentSourcePath = session.currentSourcePath;
        }

        // Restore album
        if (session.currentAlbumId) {
            currentAlbumId = session.currentAlbumId;
        }

        // Restore view and tab
        const targetView = session.currentView || 'all';
        const targetTab = session.currentTab || 'all';

        // Update sidebar active state for view
        document.querySelectorAll('.sidebar-item[data-view]').forEach(item => {
            item.classList.toggle('active', item.dataset.view === targetView);
        });

        // Update top tabs
        document.querySelectorAll('.top-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.tab === targetTab);
        });

        // Apply the restored state
        if (targetTab === 'years') {
            currentTab = 'years';
            loadYearsView();
        } else if (targetTab === 'map') {
            currentTab = 'map';
            loadMapView(session.mapState);
        } else if (targetTab === 'dbinfo') {
            currentTab = 'dbinfo';
            loadDbInfo();
        } else if (targetView === 'trash') {
            currentView = 'trash';
            currentTab = 'all';
            switchView('trash');
        } else if (targetView === 'hidden') {
            currentView = 'hidden';
            currentTab = 'all';
            switchView('hidden');
        } else if (targetView === 'search' && searchQuery) {
            currentView = 'search';
            currentTab = 'all';
            document.getElementById('view-title').textContent = t('title.searchResults', searchQuery);
            resetPhotos();
            loadPhotos();
        } else if (targetView === 'source' && currentSourcePath) {
            currentView = 'source';
            currentTab = 'all';
            document.getElementById('view-title').textContent = currentSourcePath;
            resetPhotos();
            loadPhotosBySource(currentSourcePath);
            // Highlight source in sidebar
            document.querySelectorAll('#sources-list .sidebar-item').forEach(item => {
                if (item.dataset.source === currentSourcePath) item.classList.add('active');
            });
        } else if (targetView === 'album' && currentAlbumId) {
            currentView = 'album';
            currentTab = 'all';
            const album = allAlbums.find(a => a.id === parseInt(currentAlbumId));
            document.getElementById('view-title').textContent = album ? album.name : t('title.photos');
            resetPhotos();
            loadPhotosByAlbum(currentAlbumId);
            // Highlight album in sidebar
            document.querySelectorAll('#albums-list .sidebar-item').forEach(item => {
                if (parseInt(item.dataset.album) === parseInt(currentAlbumId)) item.classList.add('active');
            });
        } else if (currentYearFilter) {
            currentView = 'year';
            currentTab = 'all';
            if (currentDayFilter) {
                document.getElementById('view-title').textContent = t('title.dayFilter', currentYearFilter, currentMonthFilter, currentDayFilter);
            } else if (currentMonthFilter) {
                document.getElementById('view-title').textContent = t('title.monthFilter', currentYearFilter, currentMonthFilter);
            } else {
                document.getElementById('view-title').textContent = t('title.yearFilter', currentYearFilter);
            }
            resetPhotos();
            loadPhotos();
        } else if (targetTab === 'all') {
            currentView = targetView;
            currentTab = targetTab;
            switchView(targetView);
        } else {
            // Fallback for any unhandled case - default to all photos
            currentView = 'all';
            currentTab = 'all';
            switchView('all');
        }

        // Restore scroll position after content loads
        if (session.scrollTop && targetTab !== 'map' && targetTab !== 'dbinfo') {
            setTimeout(() => {
                const timeline = document.getElementById('timeline');
                if (timeline) timeline.scrollTop = session.scrollTop;
            }, 500);
        }

        return true;
    } catch (e) {
        console.error('Failed to restore session:', e);
        return false;
    }
}

// Auto-save session on state changes and before unload
function setupSessionAutoSave() {
    // Save on scroll (throttled)
    let scrollTimeout;
    const timeline = document.getElementById('timeline');
    if (timeline) {
        timeline.addEventListener('scroll', () => {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(saveSession, 300);
        });
    }

    // Save before page unload
    window.addEventListener('beforeunload', saveSession);

    // Save periodically (every 5 seconds)
    setInterval(saveSession, 5000);
}

init();

// ============================================================
// worldbookExport.js - 世界书导出模块
// 功能：扫描所有世界书，一键导出有激活（启用）条目的世界书
// ============================================================

(function () {
    'use strict';

    const MODULE = 'WBExport';

    function log(msg, type = 'info') {
        const icons = { info: '📘', success: '✅', warning: '⚠️', error: '❌', debug: '🔍' };
        console.log(`[${MODULE}] ${icons[type] || 'ℹ️'} ${msg}`);
    }

    // ============================================================
    // 数据获取层 - 多种方式获取世界书数据，确保兼容性
    // ============================================================

    /**
     * 获取请求头 - 兼容不同版本ST
     */
    function getHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        // 尝试获取CSRF Token（部分ST版本需要）
        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        if (csrfMeta) {
            headers['X-CSRF-Token'] = csrfMeta.getAttribute('content');
        }
        return headers;
    }

    /**
     * 获取所有世界书名称列表
     * 多层fallback确保兼容性
     */
    async function getWorldBookNames() {
        const names = new Set();

        // ---- 方式1：从DOM下拉列表获取 ----
        // 全局世界书选择器
        $('#world_info option').each(function () {
            const val = $(this).val()?.trim();
            if (val && val !== 'None' && val !== 'none' && val !== '') {
                names.add(val);
            }
        });

        // 世界书编辑器选择器
        $('#world_editor_select option').each(function () {
            const val = $(this).val()?.trim();
            if (val && val !== 'None' && val !== 'none' && val !== '') {
                names.add(val);
            }
        });

        // ---- 方式2：从API搜索获取 ----
        if (names.size === 0) {
            log('DOM方式未获取到世界书，尝试API方式...', 'debug');
            try {
                const resp = await fetch('/api/worldinfo/search', {
                    method: 'POST',
                    headers: getHeaders(),
                    body: JSON.stringify({ term: '' }),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    const list = Array.isArray(data) ? data : (data.data || data.worldNames || []);
                    list.forEach(n => {
                        if (typeof n === 'string' && n.trim()) names.add(n.trim());
                        if (typeof n === 'object' && n.name) names.add(n.name.trim());
                    });
                }
            } catch (e) {
                log('API搜索世界书列表失败: ' + e.message, 'warning');
            }
        }

        // ---- 方式3：从settings接口获取 ----
        if (names.size === 0) {
            log('API搜索未获取到，尝试settings方式...', 'debug');
            try {
                const resp = await fetch('/api/settings/get', {
                    method: 'POST',
                    headers: getHeaders(),
                    body: JSON.stringify({}),
                });
                if (resp.ok) {
                    const settings = await resp.json();
                    const wiList = settings.world_info?.globalSelect
                        || settings.worldNames
                        || settings.world_names
                        || [];
                    wiList.forEach(n => {
                        if (typeof n === 'string' && n.trim()) names.add(n.trim());
                    });
                }
            } catch (e) {
                log('settings方式也失败: ' + e.message, 'warning');
            }
        }

        return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    }

    /**
     * 加载单个世界书的完整数据
     */
    async function loadWorldBookData(name) {
        // 方式1：通过 SillyTavern.getContext() API
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const ctx = SillyTavern.getContext();
                if (typeof ctx.loadWorldInfo === 'function') {
                    const data = await ctx.loadWorldInfo(name);
                    if (data && data.entries) return data;
                }
            }
        } catch (e) {
            log(`getContext加载 ${name} 失败，尝试fetch: ${e.message}`, 'debug');
        }

        // 方式2：直接fetch API
        try {
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: getHeaders(),
                body: JSON.stringify({ name: name }),
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.entries) return data;
                // 有些版本返回格式不同，尝试包装
                if (data && typeof data === 'object' && !data.entries) {
                    // 可能直接返回了entries对象
                    const keys = Object.keys(data);
                    if (keys.length > 0 && data[keys[0]]?.uid !== undefined) {
                        return { entries: data };
                    }
                }
            }
        } catch (e) {
            log(`fetch加载 ${name} 也失败: ${e.message}`, 'error');
        }

        return null;
    }

    /**
     * 分析世界书条目统计
     */
    function analyzeEntries(data) {
        const result = { total: 0, enabled: 0, disabled: 0, constant: 0 };
        if (!data || !data.entries) return result;

        const entries = Object.values(data.entries);
        result.total = entries.length;
        result.enabled = entries.filter(e => !e.disable).length;
        result.disabled = entries.filter(e => e.disable).length;
        result.constant = entries.filter(e => e.constant && !e.disable).length;
        return result;
    }

    // ============================================================
    // 导出功能
    // ============================================================

    /**
     * 下载JSON文件到本地
     */
    function downloadJson(data, filename) {
        const jsonStr = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.endsWith('.json') ? filename : filename + '.json';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    /**
     * 合并多个世界书为一个
     */
    function mergeWorldBooks(booksMap) {
        const merged = { entries: {} };
        let index = 0;

        for (const [name, data] of Object.entries(booksMap)) {
            if (!data || !data.entries) continue;
            for (const entry of Object.values(data.entries)) {
                const newEntry = Object.assign({}, entry);
                newEntry.uid = index;
                newEntry.displayIndex = index;
                // 在comment前加上来源世界书名称方便辨认
                newEntry.comment = newEntry.comment
                    ? `[${name}] ${newEntry.comment}`
                    : `[${name}] 条目${entry.uid || index}`;
                merged.entries[String(index)] = newEntry;
                index++;
            }
        }
        return { data: merged, count: index };
    }

    // ============================================================
    // UI 弹窗
    // ============================================================

    let modalEl = null;
    let worldBooksCache = {};  // { name: worldData }
    let isLoading = false;

    /**
     * 注入样式（只注入一次）
     */
    function injectStyles() {
        if (document.getElementById('wb-export-styles')) return;
        const style = document.createElement('style');
        style.id = 'wb-export-styles';
        style.textContent = `
/* ===== 世界书导出弹窗样式 ===== */
.wbe-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.75);
    z-index: 99999;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: wbeFadeIn 0.2s ease;
}
@keyframes wbeFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}
.wbe-dialog {
    background: var(--SmartThemeBlurTintColor, #1a1a2e);
    border: 1px solid var(--SmartThemeBorderColor, #444);
    border-radius: 12px;
    width: 640px;
    max-width: 92vw;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
}
.wbe-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--SmartThemeBorderColor, #444);
    flex-shrink: 0;
}
.wbe-header h3 {
    margin: 0;
    font-size: 18px;
    display: flex;
    align-items: center;
    gap: 8px;
}
.wbe-close {
    cursor: pointer;
    font-size: 22px;
    opacity: 0.6;
    padding: 4px 8px;
    border-radius: 4px;
    transition: all 0.2s;
    line-height: 1;
}
.wbe-close:hover {
    opacity: 1;
    background: rgba(255, 255, 255, 0.1);
}

/* 工具栏 */
.wbe-toolbar {
    display: flex;
    gap: 6px;
    padding: 10px 20px;
    flex-wrap: wrap;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
}
.wbe-toolbar .menu_button {
    font-size: 12px !important;
    padding: 5px 12px !important;
    min-width: auto !important;
    border-radius: 6px;
}

/* 信息栏 */
.wbe-info-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 20px;
    font-size: 13px;
    opacity: 0.75;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
}

/* 世界书列表 */
.wbe-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 20px;
    min-height: 180px;
    max-height: 50vh;
}
.wbe-list::-webkit-scrollbar {
    width: 6px;
}
.wbe-list::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.2);
    border-radius: 3px;
}
.wbe-placeholder {
    text-align: center;
    padding: 48px 20px;
    opacity: 0.5;
    font-size: 14px;
    line-height: 1.8;
}

/* 世界书条目 */
.wbe-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border: 1px solid var(--SmartThemeBorderColor, #333);
    border-radius: 8px;
    margin-bottom: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
    user-select: none;
}
.wbe-item:hover {
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.15);
}
.wbe-item.wbe-selected {
    background: rgba(26, 188, 156, 0.12);
    border-color: rgba(26, 188, 156, 0.5);
}
.wbe-item.wbe-no-data {
    opacity: 0.5;
    cursor: not-allowed;
}
.wbe-item input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
    flex-shrink: 0;
    accent-color: #1abc9c;
}
.wbe-name {
    flex: 1;
    font-weight: 600;
    font-size: 14px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}
.wbe-tags {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.wbe-tag {
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 11px;
    white-space: nowrap;
    font-weight: 500;
    background: rgba(255, 255, 255, 0.08);
}
.wbe-tag-active {
    background: rgba(46, 204, 113, 0.25);
    color: #2ecc71;
}
.wbe-tag-alldis {
    background: rgba(231, 76, 60, 0.25);
    color: #e74c3c;
}
.wbe-tag-const {
    background: rgba(52, 152, 219, 0.25);
    color: #3498db;
}
.wbe-tag-err {
    background: rgba(231, 76, 60, 0.2);
    color: #e74c3c;
}

/* 底部操作栏 */
.wbe-actions {
    display: flex;
    gap: 10px;
    padding: 14px 20px;
    border-top: 1px solid var(--SmartThemeBorderColor, #444);
    flex-shrink: 0;
}
.wbe-actions .menu_button {
    flex: 1;
    padding: 10px 16px !important;
    font-size: 14px !important;
    border-radius: 8px;
    font-weight: 600;
}
        `;
        document.head.appendChild(style);
    }

    /**
     * 创建弹窗
     */
    function createModal() {
        if (modalEl) modalEl.remove();
        injectStyles();

        modalEl = document.createElement('div');
        modalEl.id = 'wb-export-modal';
        modalEl.innerHTML = `
<div class="wbe-overlay">
    <div class="wbe-dialog">
        <div class="wbe-header">
            <h3>📤 世界书导出工具</h3>
            <span class="wbe-close" title="关闭">✕</span>
        </div>

        <div class="wbe-toolbar">
            <button id="wbe-btn-refresh" class="menu_button" title="重新扫描所有世界书">
                🔄 刷新
            </button>
            <button id="wbe-btn-sel-active" class="menu_button" title="自动选中所有含有启用条目的世界书">
                ⚡ 选有激活条目
            </button>
            <button id="wbe-btn-sel-all" class="menu_button" title="全选">
                ☑ 全选
            </button>
            <button id="wbe-btn-sel-none" class="menu_button" title="取消全选">
                ☐ 全不选
            </button>
        </div>

        <div class="wbe-info-bar">
            <span id="wbe-sel-count">已选: 0 个世界书</span>
            <span id="wbe-total-count">总计: 加载中...</span>
        </div>

        <div id="wbe-list" class="wbe-list">
            <div class="wbe-placeholder">⏳ 正在扫描世界书列表...</div>
        </div>

        <div class="wbe-actions">
            <button id="wbe-btn-export-sep" class="menu_button"
                    style="background: linear-gradient(135deg, #27ae60, #229954);">
                📥 分别导出
            </button>
            <button id="wbe-btn-export-merge" class="menu_button"
                    style="background: linear-gradient(135deg, #2980b9, #2471a3);">
                📦 合并导出
            </button>
        </div>
    </div>
</div>`;

        document.body.appendChild(modalEl);
        bindModalEvents();
    }

    /**
     * 绑定弹窗内所有事件
     */
    function bindModalEvents() {
        // 关闭
        modalEl.querySelector('.wbe-close').onclick = closeModal;
        modalEl.querySelector('.wbe-overlay').addEventListener('click', (e) => {
            if (e.target.classList.contains('wbe-overlay')) closeModal();
        });

        // ESC关闭
        const escHandler = (e) => {
            if (e.key === 'Escape' && modalEl) {
                closeModal();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        // 工具栏按钮
        document.getElementById('wbe-btn-refresh').onclick = () => refreshList();
        document.getElementById('wbe-btn-sel-active').onclick = selectBooksWithActiveEntries;
        document.getElementById('wbe-btn-sel-all').onclick = () => toggleAllSelection(true);
        document.getElementById('wbe-btn-sel-none').onclick = () => toggleAllSelection(false);

        // 导出按钮
        document.getElementById('wbe-btn-export-sep').onclick = handleExportSeparate;
        document.getElementById('wbe-btn-export-merge').onclick = handleExportMerged;
    }

    function closeModal() {
        if (modalEl) {
            modalEl.remove();
            modalEl = null;
        }
    }

    // ============================================================
    // 列表渲染与交互
    // ============================================================

    /**
     * 刷新世界书列表
     */
    async function refreshList() {
        if (isLoading) return;
        isLoading = true;

        const listEl = document.getElementById('wbe-list');
        if (!listEl) return;
        listEl.innerHTML = '<div class="wbe-placeholder">⏳ 正在扫描世界书列表，请稍候...</div>';
        worldBooksCache = {};

        try {
            const names = await getWorldBookNames();

            if (names.length === 0) {
                listEl.innerHTML = `
                    <div class="wbe-placeholder">
                        😕 未找到任何世界书<br><br>
                        <span style="font-size:12px;">
                            请确保已在SillyTavern中创建或导入了世界书<br>
                            如果世界书确实存在但未显示，请尝试先打开世界书编辑面板再点刷新
                        </span>
                    </div>`;
                updateInfoBar();
                isLoading = false;
                return;
            }

            listEl.innerHTML = '';
            let loadedCount = 0;
            const totalCount = names.length;

            // 更新加载进度
            document.getElementById('wbe-total-count').textContent =
                `总计: ${totalCount} 个世界书 (加载中...)`;

            for (const name of names) {
                const data = await loadWorldBookData(name);

                if (data) {
                    worldBooksCache[name] = data;
                    const stats = analyzeEntries(data);
                    listEl.appendChild(createBookItem(name, stats));
                } else {
                    listEl.appendChild(createBookItem(name, null));
                }

                loadedCount++;
                document.getElementById('wbe-total-count').textContent =
                    `总计: ${totalCount} 个 (已加载 ${loadedCount}/${totalCount})`;
            }

            updateInfoBar();
            log(`已扫描 ${totalCount} 个世界书，成功加载 ${Object.keys(worldBooksCache).length} 个`, 'success');
        } catch (e) {
            listEl.innerHTML = `
                <div class="wbe-placeholder">
                    ❌ 加载失败: ${e.message}<br><br>
                    <span style="font-size:12px;">请检查SillyTavern是否正常运行</span>
                </div>`;
            log('加载世界书列表失败: ' + e.message, 'error');
        }

        isLoading = false;
    }

    /**
     * 创建单个世界书列表项
     */
    function createBookItem(name, stats) {
        const div = document.createElement('div');
        div.className = 'wbe-item' + (stats ? '' : ' wbe-no-data');
        div.dataset.name = name;

        const hasActive = stats && stats.enabled > 0;

        let tagsHtml = '';
        if (stats) {
            if (hasActive) {
                tagsHtml += `<span class="wbe-tag wbe-tag-active">✅ ${stats.enabled}条启用</span>`;
            } else {
                tagsHtml += `<span class="wbe-tag wbe-tag-alldis">❌ 全部禁用</span>`;
            }
            tagsHtml += `<span class="wbe-tag">📝 ${stats.total}条</span>`;
            if (stats.constant > 0) {
                tagsHtml += `<span class="wbe-tag wbe-tag-const">📌 ${stats.constant}常驻</span>`;
            }
        } else {
            tagsHtml = `<span class="wbe-tag wbe-tag-err">⚠️ 加载失败</span>`;
        }

        div.innerHTML = `
            <input type="checkbox" class="wbe-checkbox" data-name="${escapeHtml(name)}"
                   ${stats ? '' : 'disabled'}>
            <span class="wbe-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <div class="wbe-tags">${tagsHtml}</div>
        `;

        // 点击整行切换选中
        div.addEventListener('click', (e) => {
            if (!stats) return; // 加载失败的不可选
            const cb = div.querySelector('.wbe-checkbox');
            if (e.target !== cb) {
                cb.checked = !cb.checked;
            }
            div.classList.toggle('wbe-selected', cb.checked);
            updateInfoBar();
        });

        return div;
    }

    /**
     * HTML转义
     */
    function escapeHtml(str) {
        const el = document.createElement('span');
        el.textContent = str;
        return el.innerHTML;
    }

    /**
     * 获取当前选中的世界书名称列表
     */
    function getSelectedNames() {
        const names = [];
        document.querySelectorAll('.wbe-checkbox:checked').forEach(cb => {
            names.push(cb.dataset.name);
        });
        return names;
    }

    /**
     * 更新信息栏
     */
    function updateInfoBar() {
        const selCount = getSelectedNames().length;
        const totalCount = Object.keys(worldBooksCache).length;
        const selEl = document.getElementById('wbe-sel-count');
        const totalEl = document.getElementById('wbe-total-count');
        if (selEl) selEl.textContent = `已选: ${selCount} 个世界书`;
        if (totalEl) totalEl.textContent = `总计: ${totalCount} 个世界书`;
    }

    /**
     * 一键选中所有有激活（启用）条目的世界书
     */
    function selectBooksWithActiveEntries() {
        let selectedCount = 0;
        document.querySelectorAll('.wbe-item').forEach(item => {
            const name = item.dataset.name;
            const data = worldBooksCache[name];
            if (!data) return;

            const stats = analyzeEntries(data);
            const hasActive = stats.enabled > 0;
            const cb = item.querySelector('.wbe-checkbox');

            cb.checked = hasActive;
            item.classList.toggle('wbe-selected', hasActive);
            if (hasActive) selectedCount++;
        });

        updateInfoBar();
        toastr.info(`已自动选中 ${selectedCount} 个有启用条目的世界书`);
    }

    /**
     * 全选/全不选
     */
    function toggleAllSelection(checked) {
        document.querySelectorAll('.wbe-item').forEach(item => {
            const name = item.dataset.name;
            if (!worldBooksCache[name]) return; // 跳过加载失败的
            const cb = item.querySelector('.wbe-checkbox');
            cb.checked = checked;
            item.classList.toggle('wbe-selected', checked);
        });
        updateInfoBar();
    }

    // ============================================================
    // 导出操作
    // ============================================================

    /**
     * 分别导出 - 每个世界书单独一个JSON文件
     */
    async function handleExportSeparate() {
        const names = getSelectedNames();
        if (names.length === 0) {
            toastr.warning('请先选择要导出的世界书');
            return;
        }

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            const data = worldBooksCache[name];

            if (data) {
                try {
                    downloadJson(data, name);
                    successCount++;
                    log(`已导出: ${name}`, 'success');
                } catch (e) {
                    failCount++;
                    log(`导出失败 ${name}: ${e.message}`, 'error');
                }
            } else {
                failCount++;
            }

            // 多文件下载间加延迟，避免浏览器拦截
            if (names.length > 1 && i < names.length - 1) {
                await sleep(600);
            }
        }

        if (successCount > 0) {
            toastr.success(`成功导出 ${successCount} 个世界书` +
                (failCount > 0 ? `，${failCount} 个失败` : ''));
        } else {
            toastr.error('导出失败，请检查世界书数据');
        }
    }

    /**
     * 合并导出 - 所有选中世界书合并为一个JSON文件
     */
    async function handleExportMerged() {
        const names = getSelectedNames();
        if (names.length === 0) {
            toastr.warning('请先选择要导出的世界书');
            return;
        }

        const selectedBooks = {};
        for (const name of names) {
            if (worldBooksCache[name]) {
                selectedBooks[name] = worldBooksCache[name];
            }
        }

        if (Object.keys(selectedBooks).length === 0) {
            toastr.error('没有可用的世界书数据');
            return;
        }

        const { data: merged, count: totalEntries } = mergeWorldBooks(selectedBooks);

        if (totalEntries === 0) {
            toastr.error('选中的世界书中没有任何条目');
            return;
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = `merged_worldbook_${timestamp}`;

        downloadJson(merged, filename);
        toastr.success(`已合并导出 ${Object.keys(selectedBooks).length} 个世界书，共 ${totalEntries} 个条目`);
        log(`合并导出完成: ${Object.keys(selectedBooks).length} 个世界书, ${totalEntries} 个条目`, 'success');
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ============================================================
    // 公开接口
    // ============================================================

    async function open() {
        createModal();
        await refreshList();
    }

    window.WorldbookExport = { open };
    log('世界书导出模块已注册', 'success');
})();

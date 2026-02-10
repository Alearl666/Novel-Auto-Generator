// ============================================================
// worldbookExport.js - 世界书导出模块
// 功能：一键导出当前已启用的所有世界书
// ============================================================

(function () {
    'use strict';

    let loadedBooks = {};   // name → data
    let isWorking = false;

    // ============================================
    // 获取当前已启用的世界书名称
    // ============================================

    function getActiveWorldBookNames() {
        const names = new Set();

        // 方式1: SillyTavern.getContext()
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const ctx = SillyTavern.getContext();
                if (Array.isArray(ctx.selected_world_info)) {
                    ctx.selected_world_info.forEach(n => { if (n?.trim()) names.add(n.trim()); });
                }
                const charData = ctx.characters?.[ctx.characterId]?.data;
                if (charData?.extensions?.world) {
                    const cw = charData.extensions.world;
                    if (typeof cw === 'string' && cw.trim()) names.add(cw.trim());
                    if (Array.isArray(cw)) cw.forEach(n => { if (n?.trim()) names.add(n.trim()); });
                }
            }
        } catch (e) { console.warn('[WBExport] getContext获取失败:', e.message); }

        // 方式2: DOM
        try {
            $('#world_info option:selected, #world_info_global option:selected').each(function () {
                const val = $(this).val()?.trim();
                if (val && val !== 'None' && val !== 'none' && val !== '') names.add(val);
            });
            $('.world_info_tag, .tag.world_info_tag, #WorldInfo .tag').each(function () {
                const val = $(this).data('name') || $(this).attr('data-name') || $(this).text()?.trim();
                if (val && val !== 'None' && val !== 'none') names.add(val.replace(/×$/, '').trim());
            });
            $('#world_info .tag_remove').each(function () {
                const p = $(this).parent();
                const val = p.data('name') || p.text()?.trim();
                if (val) names.add(val.replace(/×$/, '').trim());
            });
        } catch (e) { /* ignore */ }

        // 方式3: chat_metadata
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const meta = SillyTavern.getContext().chat_metadata;
                if (meta?.world_info_selected) {
                    const sel = meta.world_info_selected;
                    if (Array.isArray(sel)) sel.forEach(n => { if (n?.trim()) names.add(n.trim()); });
                    if (typeof sel === 'string' && sel.trim()) names.add(sel.trim());
                }
            }
        } catch (e) { /* ignore */ }

        // 方式4: 全局变量
        try {
            if (Array.isArray(window.selected_world_info)) {
                window.selected_world_info.forEach(n => { if (n?.trim()) names.add(n.trim()); });
            }
        } catch (e) { /* ignore */ }

        return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    }

    // 兜底：获取全部世界书
    async function getAllWorldBookNames() {
        const names = new Set();
        $('#world_info option, #world_editor_select option').each(function () {
            const val = $(this).val()?.trim();
            if (val && val !== 'None' && val !== 'none' && val !== '') names.add(val);
        });
        if (names.size === 0) {
            try {
                const resp = await fetch('/api/worldinfo/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ term: '' }),
                });
                if (resp.ok) {
                    const data = await resp.json();
                    (Array.isArray(data) ? data : []).forEach(n => {
                        if (typeof n === 'string' && n.trim()) names.add(n.trim());
                        if (typeof n === 'object' && n.name) names.add(n.name.trim());
                    });
                }
            } catch (e) { /* ignore */ }
        }
        return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    }

    // ============================================
    // 加载世界书数据
    // ============================================

    async function loadWorldBookData(name) {
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const ctx = SillyTavern.getContext();
                if (typeof ctx.loadWorldInfo === 'function') {
                    const data = await ctx.loadWorldInfo(name);
                    if (data?.entries) return data;
                }
            }
        } catch (e) { /* fallback */ }

        try {
            const resp = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            if (resp.ok) {
                const data = await resp.json();
                if (data?.entries) return data;
                if (data && typeof data === 'object') {
                    const keys = Object.keys(data);
                    if (keys.length > 0 && data[keys[0]]?.uid !== undefined) return { entries: data };
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // ============================================
    // 导出工具
    // ============================================

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.endsWith('.json') ? filename : filename + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function mergeWorldBooks(booksMap) {
        const merged = { entries: {} };
        let idx = 0;
        for (const [name, data] of Object.entries(booksMap)) {
            if (!data?.entries) continue;
            for (const entry of Object.values(data.entries)) {
                const e = Object.assign({}, entry);
                e.uid = idx;
                e.displayIndex = idx;
                e.comment = e.comment ? `[${name}] ${e.comment}` : `[${name}] 条目${entry.uid || idx}`;
                merged.entries[String(idx)] = e;
                idx++;
            }
        }
        return { data: merged, count: idx };
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ============================================
    // 创建弹窗UI（参照epubToTxt风格）
    // ============================================

    function createModal() {
        $('#wb-export-modal').remove();

        const modalHtml = `
        <div id="wb-export-modal" style="
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            width: 100vw; height: 100vh;
            background: rgba(0, 0, 0, 0.75);
            z-index: 99999;
            overflow-y: auto;
        ">
            <div style="
                display: flex;
                justify-content: center;
                align-items: flex-start;
                min-height: 100%;
                padding: 20px;
                box-sizing: border-box;
            ">
                <div style="
                    background: var(--SmartThemeBlurTintColor, #1a1a2e);
                    border: 1px solid var(--SmartThemeBorderColor, #444);
                    border-radius: 12px;
                    padding: 20px;
                    width: 100%;
                    max-width: 500px;
                    color: var(--SmartThemeBodyColor, #fff);
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                    margin: 20px 0;
                ">
                    <h3 style="margin: 0 0 15px 0; text-align: center; font-size: 18px;">
                        📤 导出已启用世界书
                    </h3>

                    <div style="display: flex; flex-direction: column; gap: 12px;">

                        <!-- 进度区 -->
                        <div id="wbe-progress" style="
                            display: none;
                            text-align: center;
                            padding: 10px;
                            background: rgba(26, 188, 156, 0.15);
                            border-radius: 8px;
                        ">
                            <div style="
                                width: 100%; height: 6px;
                                background: rgba(255,255,255,0.1);
                                border-radius: 3px;
                                overflow: hidden;
                                margin-bottom: 8px;
                            ">
                                <div id="wbe-progress-bar" style="
                                    height: 100%; width: 0%;
                                    background: linear-gradient(90deg, #1abc9c, #2ecc71);
                                    border-radius: 3px;
                                    transition: width 0.25s ease;
                                "></div>
                            </div>
                            <span id="wbe-progress-text" style="font-size: 13px;">⏳ 正在扫描...</span>
                        </div>

                        <!-- 世界书列表 -->
                        <div id="wbe-book-list" style="
                            min-height: 80px;
                            max-height: 400px;
                            overflow-y: auto;
                            border: 1px dashed #666;
                            border-radius: 8px;
                            padding: 8px;
                        ">
                            <div id="wbe-empty-tip" style="
                                text-align: center;
                                color: #888;
                                padding: 25px 10px;
                                font-size: 14px;
                            ">
                                点击「🔍 扫描世界书」开始
                            </div>
                        </div>

                        <!-- 操作按钮 -->
                        <button id="wbe-scan-btn" class="menu_button" style="
                            background: linear-gradient(135deg, #1abc9c, #16a085) !important;
                            padding: 12px 20px !important;
                            font-size: 15px !important;
                            border-radius: 8px !important;
                            width: 100%;
                        ">
                            🔍 扫描世界书
                        </button>

                        <div style="display: flex; gap: 10px;">
                            <button id="wbe-sel-all-btn" class="menu_button" style="
                                background: #3498db !important;
                                padding: 8px 12px !important;
                                flex: 1;
                                font-size: 13px !important;
                            ">
                                ☑ 全选
                            </button>
                            <button id="wbe-sel-none-btn" class="menu_button" style="
                                background: #2980b9 !important;
                                padding: 8px 12px !important;
                                flex: 1;
                                font-size: 13px !important;
                            ">
                                ☐ 全不选
                            </button>
                        </div>

                        <div style="display: flex; gap: 10px;">
                            <button id="wbe-export-sep-btn" class="menu_button" style="
                                background: linear-gradient(135deg, #27ae60, #229954) !important;
                                padding: 10px 15px !important;
                                flex: 1;
                                font-size: 14px !important;
                            ">
                                📥 分别导出
                            </button>
                            <button id="wbe-export-merge-btn" class="menu_button" style="
                                background: linear-gradient(135deg, #2980b9, #2471a3) !important;
                                padding: 10px 15px !important;
                                flex: 1;
                                font-size: 14px !important;
                            ">
                                📦 合并导出
                            </button>
                        </div>

                        <button id="wbe-close-btn" class="menu_button" style="
                            background: #555 !important;
                            padding: 10px 15px !important;
                            font-size: 14px !important;
                            width: 100%;
                        ">
                            ✖ 关闭
                        </button>
                    </div>
                </div>
            </div>
        </div>

        <style>
            .wbe-book-item {
                display: flex;
                align-items: center;
                padding: 8px;
                margin: 4px 0;
                background: rgba(255,255,255,0.1);
                border-radius: 6px;
                gap: 8px;
                cursor: pointer;
                user-select: none;
                transition: background 0.12s;
            }
            .wbe-book-item:active {
                background: rgba(255,255,255,0.15);
            }
            .wbe-book-item.selected {
                background: rgba(26, 188, 156, 0.2);
            }
            .wbe-book-item input[type="checkbox"] {
                width: 17px; height: 17px;
                flex-shrink: 0;
                accent-color: #1abc9c;
                cursor: pointer;
            }
            .wbe-book-item .wbe-bk-name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 13px;
                font-weight: 600;
                min-width: 0;
            }
            .wbe-book-item .wbe-bk-tags {
                display: flex;
                gap: 4px;
                flex-shrink: 0;
                flex-wrap: wrap;
                justify-content: flex-end;
            }
            .wbe-bk-tag {
                font-size: 10px;
                padding: 2px 7px;
                border-radius: 10px;
                white-space: nowrap;
                background: rgba(255,255,255,0.08);
            }
            .wbe-bk-tag.tag-on { background: rgba(46,204,113,0.2); color: #2ecc71; }
            .wbe-bk-tag.tag-off { background: rgba(231,76,60,0.2); color: #e74c3c; }
            .wbe-bk-tag.tag-err { background: rgba(231,76,60,0.15); color: #e74c3c; }
        </style>`;

        $('body').append(modalHtml);
        bindModalEvents();
    }

    // ============================================
    // 绑定弹窗事件
    // ============================================

    function bindModalEvents() {
        $('#wbe-scan-btn').on('click', startScan);
        $('#wbe-sel-all-btn').on('click', () => toggleAll(true));
        $('#wbe-sel-none-btn').on('click', () => toggleAll(false));
        $('#wbe-export-sep-btn').on('click', doExportSep);
        $('#wbe-export-merge-btn').on('click', doExportMerge);
        $('#wbe-close-btn').on('click', closeModal);

        // 点击遮罩关闭
        $('#wb-export-modal').on('click', function (e) {
            if (e.target.id === 'wb-export-modal') {
                closeModal();
            }
        });
    }

    // ============================================
    // 进度控制
    // ============================================

    function showProgress(pct, text) {
        $('#wbe-progress').show();
        $('#wbe-progress-bar').css('width', Math.min(100, Math.max(0, pct)) + '%');
        $('#wbe-progress-text').text(text || '');
    }

    function hideProgress() {
        $('#wbe-progress').hide();
    }

    // ============================================
    // 扫描主流程
    // ============================================

    async function startScan() {
        if (isWorking) return;
        isWorking = true;
        loadedBooks = {};

        const listEl = $('#wbe-book-list');
        showProgress(5, '🔍 正在获取已启用的世界书名称...');
        await sleep(50);

        // 获取已启用的世界书
        let names = getActiveWorldBookNames();
        console.log('[WBExport] 已启用世界书:', names);

        if (names.length === 0) {
            showProgress(10, '⚠️ 未检测到已启用世界书，获取全部列表...');
            names = await getAllWorldBookNames();
            if (names.length > 0) {
                toastr.info(`未检测到已启用世界书，已列出全部 ${names.length} 个`);
            }
        }

        if (names.length === 0) {
            listEl.html(`
                <div style="text-align:center; color:#888; padding:25px 10px; font-size:14px;">
                    😕 未找到任何世界书<br>
                    <small>请确保SillyTavern中有世界书且已启用</small>
                </div>
            `);
            showProgress(100, '❌ 未找到世界书');
            setTimeout(hideProgress, 2000);
            isWorking = false;
            return;
        }

        showProgress(15, `📚 找到 ${names.length} 个世界书，开始加载数据...`);
        listEl.empty();

        const total = names.length;
        let loaded = 0, failed = 0;

        for (const name of names) {
            const pct = 15 + Math.round((loaded / total) * 80);
            showProgress(pct, `📖 加载中 (${loaded + 1}/${total}): ${name}`);
            await sleep(30);

            const data = await loadWorldBookData(name);
            loaded++;

            if (data?.entries) {
                loadedBooks[name] = data;
                const arr = Object.values(data.entries);
                const en = arr.filter(e => !e.disable).length;
                listEl.append(makeBookItem(name, arr.length, en, true));
            } else {
                failed++;
                listEl.append(makeBookItem(name, 0, 0, false));
            }
        }

        const ok = Object.keys(loadedBooks).length;
        showProgress(100, `✅ 加载完成！成功 ${ok} 个` + (failed ? ` / 失败 ${failed} 个` : ''));
        setTimeout(hideProgress, 1500);

        // 默认全选成功的
        toggleAll(true);
        // 把扫描按钮改为刷新
        $('#wbe-scan-btn').html('🔄 重新扫描');

        isWorking = false;
    }

    // ============================================
    // 创建世界书列表项
    // ============================================

    function makeBookItem(name, total, enabled, ok) {
        const safeName = $('<span>').text(name).html();

        let tagsHtml = '';
        if (ok) {
            tagsHtml += `<span class="wbe-bk-tag tag-on">✅${enabled}启用</span>`;
            if (total - enabled > 0) tagsHtml += `<span class="wbe-bk-tag tag-off">⛔${total - enabled}禁用</span>`;
            tagsHtml += `<span class="wbe-bk-tag">共${total}条</span>`;
        } else {
            tagsHtml = `<span class="wbe-bk-tag tag-err">⚠️加载失败</span>`;
        }

        const item = $(`
            <div class="wbe-book-item ${ok ? 'selected' : ''}" data-name="${safeName}">
                <input type="checkbox" class="wbe-bk-cb" data-name="${safeName}" ${ok ? 'checked' : 'disabled'}>
                <span class="wbe-bk-name" title="${safeName}">${safeName}</span>
                <div class="wbe-bk-tags">${tagsHtml}</div>
            </div>
        `);

        // 点击整行切换
        item.on('click', function (e) {
            if (!ok) return;
            const cb = $(this).find('.wbe-bk-cb');
            if (!$(e.target).is('input')) {
                cb.prop('checked', !cb.prop('checked'));
            }
            $(this).toggleClass('selected', cb.prop('checked'));
        });

        return item;
    }

    // ============================================
    // 选择操作
    // ============================================

    function getCheckedNames() {
        const r = [];
        $('.wbe-bk-cb:checked').each(function () { r.push($(this).data('name')); });
        return r;
    }

    function toggleAll(checked) {
        $('.wbe-book-item').each(function () {
            const cb = $(this).find('.wbe-bk-cb');
            if (cb.prop('disabled')) return;
            cb.prop('checked', checked);
            $(this).toggleClass('selected', checked);
        });
    }

    // ============================================
    // 导出
    // ============================================

    async function doExportSep() {
        const names = getCheckedNames();
        if (!names.length) { toastr.warning('请先选择世界书'); return; }
        let ok = 0;
        for (let i = 0; i < names.length; i++) {
            const d = loadedBooks[names[i]];
            if (d) { downloadJson(d, names[i]); ok++; }
            if (names.length > 1 && i < names.length - 1) await sleep(500);
        }
        if (ok) toastr.success(`已导出 ${ok} 个世界书`);
    }

    async function doExportMerge() {
        const names = getCheckedNames();
        if (!names.length) { toastr.warning('请先选择世界书'); return; }
        const books = {};
        names.forEach(n => { if (loadedBooks[n]) books[n] = loadedBooks[n]; });
        if (!Object.keys(books).length) { toastr.error('没有可用数据'); return; }
        const { data, count } = mergeWorldBooks(books);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadJson(data, `merged_${ts}`);
        toastr.success(`已合并 ${Object.keys(books).length} 个世界书，共 ${count} 条`);
    }

    // ============================================
    // 打开/关闭
    // ============================================

    function openModal() {
        if ($('#wb-export-modal').length === 0) {
            createModal();
        }
        loadedBooks = {};
        hideProgress();
        // 重置列表
        $('#wbe-book-list').html(`
            <div style="text-align:center; color:#888; padding:25px 10px; font-size:14px;">
                点击「🔍 扫描世界书」开始
            </div>
        `);
        $('#wbe-scan-btn').html('🔍 扫描世界书');
        $('#wb-export-modal').css('display', 'block');
        $('body').css('overflow', 'hidden');

        // 自动开始扫描
        setTimeout(() => startScan(), 100);
    }

    function closeModal() {
        $('#wb-export-modal').hide();
        $('body').css('overflow', '');
    }

    // ============================================
    // 公开接口
    // ============================================

    window.WorldbookExport = {
        open: openModal,
        close: closeModal
    };

    console.log('[WBExport] 📤 世界书导出模块已加载');

})();

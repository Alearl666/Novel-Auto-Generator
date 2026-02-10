// ============================================================
// worldbookExport.js - 世界书导出模块
// 功能：一键导出当前已启用的所有世界书
// ============================================================

(function () {
    'use strict';

    const MODULE = 'WBExport';

    function log(msg, type = 'info') {
        const icons = { info: '📘', success: '✅', warning: '⚠️', error: '❌', debug: '🔍' };
        console.log(`[${MODULE}] ${icons[type] || 'ℹ️'} ${msg}`);
    }

    // ============================================================
    // 获取当前已启用的世界书名称
    // ============================================================

    function getActiveWorldBookNames() {
        const names = new Set();

        // ---- 方式1: SillyTavern.getContext() ----
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const ctx = SillyTavern.getContext();

                // 全局已启用的世界书
                if (Array.isArray(ctx.selected_world_info)) {
                    ctx.selected_world_info.forEach(n => {
                        if (n && typeof n === 'string' && n.trim()) names.add(n.trim());
                    });
                }

                // 当前角色绑定的世界书
                const charData = ctx.characters?.[ctx.characterId]?.data;
                if (charData?.extensions?.world) {
                    const cw = charData.extensions.world;
                    if (typeof cw === 'string' && cw.trim()) names.add(cw.trim());
                    if (Array.isArray(cw)) cw.forEach(n => { if (n?.trim()) names.add(n.trim()); });
                }
            }
        } catch (e) {
            log('getContext方式获取失败: ' + e.message, 'warning');
        }

        // ---- 方式2: 从DOM获取已选中的全局世界书 ----
        try {
            $('#world_info option:selected, #world_info_global option:selected').each(function () {
                const val = $(this).val()?.trim();
                if (val && val !== 'None' && val !== 'none' && val !== '') {
                    names.add(val);
                }
            });
            // 世界书标签
            $('.world_info_tag, .tag.world_info_tag, #WorldInfo .tag').each(function () {
                const val = $(this).data('name') || $(this).attr('data-name') || $(this).text()?.trim();
                if (val && val !== 'None' && val !== 'none') {
                    names.add(val.replace(/×$/, '').trim());
                }
            });
            $('#world_info .tag_remove').each(function () {
                const parent = $(this).parent();
                const val = parent.data('name') || parent.text()?.trim();
                if (val) names.add(val.replace(/×$/, '').trim());
            });
        } catch (e) {
            log('DOM方式获取失败: ' + e.message, 'warning');
        }

        // ---- 方式3: chat_metadata ----
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

        // ---- 方式4: 全局变量 ----
        try {
            if (typeof window.selected_world_info !== 'undefined' && Array.isArray(window.selected_world_info)) {
                window.selected_world_info.forEach(n => { if (n?.trim()) names.add(n.trim()); });
            }
        } catch (e) { /* ignore */ }

        return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    }

    // 兜底：获取全部世界书名称
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

    // ============================================================
    // 加载世界书数据
    // ============================================================

    async function loadWorldBookData(name) {
        try {
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                const ctx = SillyTavern.getContext();
                if (typeof ctx.loadWorldInfo === 'function') {
                    const data = await ctx.loadWorldInfo(name);
                    if (data?.entries) return data;
                }
            }
        } catch (e) {
            log(`getContext加载 ${name} 失败: ${e.message}`, 'debug');
        }

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
                    if (keys.length > 0 && data[keys[0]]?.uid !== undefined) {
                        return { entries: data };
                    }
                }
            }
        } catch (e) {
            log(`fetch加载 ${name} 失败: ${e.message}`, 'error');
        }
        return null;
    }

    // ============================================================
    // 导出工具
    // ============================================================

    function downloadJson(data, filename) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename.endsWith('.json') ? filename : filename + '.json';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
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
    function esc(s) { const d = document.createElement('span'); d.textContent = s; return d.innerHTML; }

    // ============================================================
    // UI 弹窗 - 从底部弹出，适配手机
    // ============================================================

    let modalEl = null;
    let loadedBooks = {};
    let isWorking = false;

    function injectStyles() {
        if (document.getElementById('wbe-css')) return;
        const s = document.createElement('style');
        s.id = 'wbe-css';
        s.textContent = `
/* ===== 底部弹出式弹窗，手机友好 ===== */
.wbe-overlay {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.7);
    z-index: 99999;
    display: flex; align-items: flex-end; justify-content: center;
    animation: wbeFade .15s ease;
}
@keyframes wbeFade { from{opacity:0} to{opacity:1} }

.wbe-dialog {
    background: var(--SmartThemeBlurTintColor, #1a1a2e);
    border: 1px solid var(--SmartThemeBorderColor, #444);
    border-bottom: none;
    border-radius: 16px 16px 0 0;
    width: 100%; max-width: 560px;
    max-height: 75vh;
    display: flex; flex-direction: column;
    overflow: hidden;
    box-shadow: 0 -4px 32px rgba(0,0,0,0.4);
    animation: wbeSlide .2s ease;
}
@keyframes wbeSlide { from{transform:translateY(40%);opacity:0} to{transform:translateY(0);opacity:1} }

.wbe-handle {
    width: 36px; height: 4px;
    background: rgba(255,255,255,0.25);
    border-radius: 2px;
    margin: 10px auto 4px;
    flex-shrink: 0;
}
.wbe-title-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 2px 16px 10px; flex-shrink: 0;
}
.wbe-title-row h3 { margin: 0; font-size: 15px; }
.wbe-close {
    cursor: pointer; font-size: 20px; opacity: 0.5;
    padding: 4px 8px; border-radius: 6px; line-height: 1;
}
.wbe-close:hover { opacity: 1; background: rgba(255,255,255,0.1); }

/* 进度 */
.wbe-prog { padding: 0 16px 8px; flex-shrink: 0; }
.wbe-prog-bg {
    width: 100%; height: 5px;
    background: rgba(255,255,255,0.08);
    border-radius: 3px; overflow: hidden;
}
.wbe-prog-fill {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, #1abc9c, #2ecc71);
    border-radius: 3px; transition: width .25s ease;
}
.wbe-prog-txt {
    font-size: 11px; opacity: 0.6;
    margin-top: 4px; text-align: center;
    min-height: 16px;
}

/* 列表 */
.wbe-list {
    flex: 1; overflow-y: auto;
    padding: 2px 16px 6px;
    min-height: 80px;
}
.wbe-list::-webkit-scrollbar { width: 4px; }
.wbe-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); border-radius: 2px; }

.wbe-empty {
    text-align: center; padding: 28px 16px;
    opacity: 0.5; font-size: 13px; line-height: 1.8;
}

.wbe-item {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 10px;
    border: 1px solid var(--SmartThemeBorderColor, #333);
    border-radius: 8px;
    margin-bottom: 5px;
    cursor: pointer; user-select: none;
    transition: .12s;
}
.wbe-item:active { transform: scale(0.98); }
.wbe-item.sel { background: rgba(26,188,156,0.1); border-color: rgba(26,188,156,0.4); }
.wbe-item.err { opacity: 0.4; cursor: not-allowed; }
.wbe-item input[type="checkbox"] {
    width: 17px; height: 17px; flex-shrink: 0;
    accent-color: #1abc9c; cursor: pointer;
}
.wbe-nm {
    flex: 1; font-size: 13px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.wbe-bds { display: flex; gap: 3px; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
.wbe-bd {
    font-size: 10px; padding: 1px 6px;
    border-radius: 9px; white-space: nowrap;
    background: rgba(255,255,255,0.07);
}
.wbe-bd.g { background: rgba(46,204,113,0.2); color: #2ecc71; }
.wbe-bd.r { background: rgba(231,76,60,0.2); color: #e74c3c; }

/* 底部按钮 */
.wbe-acts {
    display: flex; gap: 8px;
    padding: 10px 16px;
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    border-top: 1px solid var(--SmartThemeBorderColor, #444);
    flex-shrink: 0;
}
.wbe-acts .menu_button {
    flex: 1; padding: 10px 8px !important;
    font-size: 13px !important; border-radius: 8px; font-weight: 600;
}
.wbe-acts .menu_button:disabled { opacity: 0.4; }
`;
        document.head.appendChild(s);
    }

    function createModal() {
        if (modalEl) modalEl.remove();
        injectStyles();
        loadedBooks = {};

        modalEl = document.createElement('div');
        modalEl.id = 'wbe-modal';
        modalEl.innerHTML = `
<div class="wbe-overlay">
  <div class="wbe-dialog">
    <div class="wbe-handle"></div>
    <div class="wbe-title-row">
      <h3>📤 导出已启用世界书</h3>
      <span class="wbe-close">✕</span>
    </div>
    <div class="wbe-prog" id="wbe-prog">
      <div class="wbe-prog-bg"><div class="wbe-prog-fill" id="wbe-pf"></div></div>
      <div class="wbe-prog-txt" id="wbe-pt">准备中...</div>
    </div>
    <div id="wbe-list" class="wbe-list">
      <div class="wbe-empty">⏳ 正在获取已启用的世界书...</div>
    </div>
    <div class="wbe-acts">
      <button id="wbe-sep" class="menu_button" style="background:linear-gradient(135deg,#27ae60,#229954);" disabled>
        📥 分别导出
      </button>
      <button id="wbe-mrg" class="menu_button" style="background:linear-gradient(135deg,#2980b9,#2471a3);" disabled>
        📦 合并导出
      </button>
    </div>
  </div>
</div>`;
        document.body.appendChild(modalEl);

        // 防止手机touch穿透：300ms内禁止关闭
        let canClose = false;
        setTimeout(() => { canClose = true; }, 350);

        const tryClose = () => { if (canClose) closeModal(); };

        // 绑定
        modalEl.querySelector('.wbe-close').onclick = tryClose;
        modalEl.querySelector('.wbe-overlay').addEventListener('click', e => {
            if (e.target.classList.contains('wbe-overlay')) tryClose();
        });
        // 阻止overlay上的touchend穿透
        modalEl.querySelector('.wbe-dialog').addEventListener('click', e => { e.stopPropagation(); });
        const escH = e => { if (e.key === 'Escape' && modalEl) { tryClose(); document.removeEventListener('keydown', escH); } };
        document.addEventListener('keydown', escH);

        document.getElementById('wbe-sep').onclick = doExportSep;
        document.getElementById('wbe-mrg').onclick = doExportMerge;
    }

    function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }

    function prog(pct, txt) {
        const f = document.getElementById('wbe-pf');
        const t = document.getElementById('wbe-pt');
        if (f) f.style.width = Math.min(100, Math.max(0, pct)) + '%';
        if (t) t.textContent = txt || '';
    }

    function hideProg() {
        const el = document.getElementById('wbe-prog');
        if (el) el.style.display = 'none';
    }

    // ============================================================
    // 主流程
    // ============================================================

    async function startScan() {
        if (isWorking) return;
        isWorking = true;
        loadedBooks = {};

        const listEl = document.getElementById('wbe-list');
        if (!listEl) { isWorking = false; return; }

        prog(5, '🔍 正在获取已启用的世界书名称...');
        await sleep(50); // 让UI渲染

        // 获取已启用的世界书
        let names = getActiveWorldBookNames();
        let isFallback = false;

        log(`已启用的世界书: [${names.join(', ')}]`, 'debug');

        if (names.length === 0) {
            prog(10, '⚠️ 未检测到已启用世界书，获取全部列表...');
            names = await getAllWorldBookNames();
            isFallback = true;
            if (names.length > 0) {
                toastr.info(`未检测到已启用世界书，已列出全部 ${names.length} 个`);
            }
        }

        if (names.length === 0) {
            listEl.innerHTML = `<div class="wbe-empty">
                😕 未找到任何世界书<br><br>
                <span style="font-size:11px;">请确保SillyTavern中有世界书<br>且已在当前聊天中启用</span>
            </div>`;
            prog(100, '❌ 未找到世界书');
            isWorking = false;
            return;
        }

        prog(15, `📚 找到 ${names.length} 个世界书，开始加载...`);
        listEl.innerHTML = '';

        const total = names.length;
        let loaded = 0, failed = 0;

        for (const name of names) {
            const pct = 15 + Math.round(((loaded) / total) * 80);
            prog(pct, `📖 (${loaded + 1}/${total}) ${name}`);
            await sleep(30); // 让进度条UI更新

            const data = await loadWorldBookData(name);
            loaded++;

            if (data?.entries) {
                loadedBooks[name] = data;
                const arr = Object.values(data.entries);
                const en = arr.filter(e => !e.disable).length;
                listEl.appendChild(mkItem(name, arr.length, en, true));
            } else {
                failed++;
                listEl.appendChild(mkItem(name, 0, 0, false));
            }
        }

        const ok = Object.keys(loadedBooks).length;
        prog(100, `✅ 加载完成！成功 ${ok} 个` + (failed ? ` / 失败 ${failed} 个` : ''));
        setTimeout(hideProg, 1500);

        // 默认全选
        toggleAll(true);
        updateBtns();
        isWorking = false;
    }

    function mkItem(name, total, enabled, ok) {
        const div = document.createElement('div');
        div.className = 'wbe-item' + (ok ? ' sel' : ' err');
        div.dataset.name = name;

        let bds = '';
        if (ok) {
            bds += `<span class="wbe-bd g">✅${enabled}</span>`;
            if (total - enabled > 0) bds += `<span class="wbe-bd r">⛔${total - enabled}</span>`;
            bds += `<span class="wbe-bd">共${total}</span>`;
        } else {
            bds = `<span class="wbe-bd r">⚠️失败</span>`;
        }

        div.innerHTML = `
            <input type="checkbox" class="wbe-cb" data-name="${esc(name)}" ${ok ? 'checked' : 'disabled'}>
            <span class="wbe-nm" title="${esc(name)}">${esc(name)}</span>
            <div class="wbe-bds">${bds}</div>`;

        div.addEventListener('click', e => {
            if (!ok) return;
            const cb = div.querySelector('.wbe-cb');
            if (e.target !== cb) cb.checked = !cb.checked;
            div.classList.toggle('sel', cb.checked);
            updateBtns();
        });
        return div;
    }

    function getChecked() {
        const r = [];
        document.querySelectorAll('.wbe-cb:checked').forEach(cb => r.push(cb.dataset.name));
        return r;
    }

    function toggleAll(v) {
        document.querySelectorAll('.wbe-item:not(.err)').forEach(it => {
            const cb = it.querySelector('.wbe-cb');
            cb.checked = v;
            it.classList.toggle('sel', v);
        });
        updateBtns();
    }

    function updateBtns() {
        const n = getChecked().length;
        const s = document.getElementById('wbe-sep');
        const m = document.getElementById('wbe-mrg');
        if (s) { s.disabled = !n; s.textContent = n ? `📥 分别导出(${n})` : '📥 分别导出'; }
        if (m) { m.disabled = !n; m.textContent = n ? `📦 合并导出(${n})` : '📦 合并导出'; }
    }

    // ============================================================
    // 导出
    // ============================================================

    async function doExportSep() {
        const names = getChecked();
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
        const names = getChecked();
        if (!names.length) { toastr.warning('请先选择世界书'); return; }
        const books = {};
        names.forEach(n => { if (loadedBooks[n]) books[n] = loadedBooks[n]; });
        if (!Object.keys(books).length) { toastr.error('没有可用数据'); return; }
        const { data, count } = mergeWorldBooks(books);
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadJson(data, `merged_${ts}`);
        toastr.success(`已合并 ${Object.keys(books).length} 个世界书，共 ${count} 条`);
    }

    // ============================================================
    // 公开接口
    // ============================================================

    async function open() {
        createModal();
        try {
            await startScan();
        } catch (e) {
            log('扫描出错: ' + e.message, 'error');
            prog(100, '❌ 出错: ' + e.message);
            isWorking = false;
        }
    }

    window.WorldbookExport = { open };
    log('世界书导出模块已注册', 'success');
})();

// epubToTxt.js - EPUB转TXT模块（支持批量导入排序）

(function() {
    'use strict';

    let epubFiles = []; // 存储已加载的EPUB文件数据
    let draggedItem = null;

    // ============================================
    // 动态加载 JSZip 库
    // ============================================
    async function loadJSZip() {
        if (window.JSZip) return window.JSZip;
        
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            script.onload = () => resolve(window.JSZip);
            script.onerror = () => reject(new Error('JSZip库加载失败'));
            document.head.appendChild(script);
        });
    }

    // ============================================
    // HTML转纯文本（修复：保持原有换行格式）
    // ============================================
    function htmlToText(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        if (!doc.body) return '';
        
        // 移除script和style标签
        doc.querySelectorAll('script, style').forEach(el => el.remove());
        
        // 处理<br>标签
        doc.querySelectorAll('br').forEach(el => {
            el.replaceWith('\n');
        });
        
        // 处理块级元素 - 只在后面加一个换行
        const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 
                          'li', 'tr', 'blockquote', 'section', 'article'];
        
        blockTags.forEach(tag => {
            doc.querySelectorAll(tag).forEach(el => {
                // 在元素内容后添加换行
                el.innerHTML = el.innerHTML + '\n';
            });
        });
        
        let text = doc.body.textContent || '';
        
        // 清理空白
        text = text
            .replace(/[ \t]+/g, ' ')           // 多个空格合并
            .replace(/ \n/g, '\n')             // 换行前的空格去掉
            .replace(/\n /g, '\n')             // 换行后的空格去掉
            .replace(/\n{3,}/g, '\n\n')        // 最多保留两个换行（一个空行）
            .replace(/^\s+/, '')               // 开头空白
            .replace(/\s+$/, '');              // 结尾空白
        
        return text;
    }

    // ============================================
    // 解析单个EPUB文件
    // ============================================
    async function parseEpub(arrayBuffer) {
        const JSZip = await loadJSZip();
        const zip = await JSZip.loadAsync(arrayBuffer);
        const parser = new DOMParser();
        
        const containerFile = zip.file('META-INF/container.xml');
        if (!containerFile) {
            throw new Error('无效的EPUB文件');
        }
        
        const containerXml = await containerFile.async('string');
        const containerDoc = parser.parseFromString(containerXml, 'text/xml');
        const rootfile = containerDoc.querySelector('rootfile');
        if (!rootfile) {
            throw new Error('无效的EPUB文件');
        }
        const opfPath = rootfile.getAttribute('full-path');
        
        const opfFile = zip.file(opfPath);
        if (!opfFile) {
            throw new Error('无效的EPUB文件');
        }
        
        const opfContent = await opfFile.async('string');
        const opfDoc = parser.parseFromString(opfContent, 'application/xml');
        
        // 获取书名
        const titleEl = opfDoc.querySelector('metadata title, dc\\:title');
        const bookTitle = titleEl ? titleEl.textContent.trim() : '';
        
        const manifest = {};
        opfDoc.querySelectorAll('manifest item').forEach(item => {
            manifest[item.getAttribute('id')] = {
                href: item.getAttribute('href'),
                mediaType: item.getAttribute('media-type')
            };
        });
        
        const basePath = opfPath.includes('/') 
            ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) 
            : '';
        
        const chapters = [];
        const spineItems = opfDoc.querySelectorAll('spine itemref');
        
        for (const ref of spineItems) {
            const idref = ref.getAttribute('idref');
            const item = manifest[idref];
            if (!item) continue;
            
            if (!item.mediaType || !item.mediaType.includes('html')) continue;
            
            const filePath = basePath + item.href;
            const file = zip.file(filePath);
            if (!file) continue;
            
            try {
                const html = await file.async('string');
                const text = htmlToText(html);
                
                if (text && text.trim().length > 0) {
                    chapters.push(text.trim());
                }
            } catch (e) {
                console.warn('[EpubToTxt] 跳过文件:', filePath);
            }
        }
        
        return {
            title: bookTitle,
            content: chapters.join('\n')
        };
    }

    // ============================================
    // 创建弹窗UI
    // ============================================
    function createModal() {
        $('#epub-to-txt-modal').remove();
        
        const modalHtml = `
        <div id="epub-to-txt-modal" style="
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100vw;
            height: 100vh;
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
                    padding: 24px;
                    width: 100%;
                    max-width: 500px;
                    color: var(--SmartThemeBodyColor, #fff);
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                    margin: 20px 0;
                ">
                    <h3 style="margin: 0 0 20px 0; text-align: center; font-size: 20px;">
                        📖 EPUB批量转TXT
                    </h3>
                    
                    <div style="display: flex; flex-direction: column; gap: 15px;">
                        <!-- 文件选择 -->
                        <input type="file" id="epub-file-input" accept=".epub" multiple style="display: none;">
                        <button id="epub-select-btn" class="menu_button" style="
                            background: linear-gradient(135deg, #9b59b6, #8e44ad) !important;
                            padding: 14px 24px !important;
                            font-size: 15px !important;
                            border-radius: 8px !important;
                            width: 100%;
                        ">
                            📁 选择EPUB文件（可多选）
                        </button>
                        
                        <!-- 文件列表 -->
                        <div id="epub-file-list" style="
                            min-height: 60px;
                            max-height: 300px;
                            overflow-y: auto;
                            border: 1px dashed #666;
                            border-radius: 8px;
                            padding: 10px;
                        ">
                            <div id="epub-empty-tip" style="
                                text-align: center;
                                color: #888;
                                padding: 20px;
                                font-size: 14px;
                            ">
                                请选择EPUB文件<br>
                                <small>可拖动调整顺序</small>
                            </div>
                        </div>
                        
                        <!-- 进度 -->
                        <div id="epub-progress" style="
                            display: none;
                            text-align: center;
                            padding: 10px;
                            background: rgba(155, 89, 182, 0.2);
                            border-radius: 8px;
                        ">
                            <span id="epub-progress-text">⏳ 正在处理...</span>
                        </div>
                        
                        <!-- 按钮组 -->
                        <div style="display: flex; gap: 10px;">
                            <button id="epub-clear-btn" class="menu_button" style="
                                background: #c0392b !important;
                                padding: 10px 20px !important;
                                flex: 1;
                            ">
                                🗑️ 清空
                            </button>
                            <button id="epub-convert-btn" class="menu_button" style="
                                background: linear-gradient(135deg, #27ae60, #2ecc71) !important;
                                padding: 10px 20px !important;
                                flex: 2;
                            ">
                                ✨ 生成TXT
                            </button>
                        </div>
                        
                        <button id="epub-close-btn" class="menu_button" style="
                            background: #555 !important;
                            padding: 10px 20px !important;
                        ">
                            关闭
                        </button>
                    </div>
                </div>
            </div>
        </div>
        
        <style>
            .epub-file-item {
                display: flex;
                align-items: center;
                padding: 10px;
                margin: 5px 0;
                background: rgba(255,255,255,0.1);
                border-radius: 6px;
                cursor: grab;
                user-select: none;
            }
            .epub-file-item:active {
                cursor: grabbing;
            }
            .epub-file-item.dragging {
                opacity: 0.5;
                background: rgba(155, 89, 182, 0.3);
            }
            .epub-file-item .drag-handle {
                margin-right: 10px;
                color: #888;
            }
            .epub-file-item .file-name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 14px;
            }
            .epub-file-item .remove-btn {
                background: transparent;
                border: none;
                color: #e74c3c;
                cursor: pointer;
                padding: 5px;
                font-size: 16px;
            }
            .epub-file-item .file-index {
                min-width: 24px;
                height: 24px;
                background: #9b59b6;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                margin-right: 10px;
            }
        </style>`;
        
        $('body').append(modalHtml);
        bindModalEvents();
    }

    // ============================================
    // 绑定弹窗事件
    // ============================================
    function bindModalEvents() {
        $('#epub-select-btn').on('click', () => {
            $('#epub-file-input').trigger('click');
        });
        
        $('#epub-file-input').on('change', handleFileSelect);
        $('#epub-clear-btn').on('click', clearFiles);
        $('#epub-convert-btn').on('click', convertAll);
        $('#epub-close-btn').on('click', closeModal);
        
        $('#epub-to-txt-modal').on('click', (e) => {
            if (e.target.id === 'epub-to-txt-modal') {
                closeModal();
            }
        });
    }

    // ============================================
    // 文件选择处理
    // ============================================
    async function handleFileSelect(event) {
        const files = Array.from(event.target.files);
        if (!files.length) return;
        
        $('#epub-progress').show();
        $('#epub-progress-text').text('⏳ 正在解析EPUB文件...');
        
        for (const file of files) {
            try {
                const arrayBuffer = await file.arrayBuffer();
                const result = await parseEpub(arrayBuffer);
                
                epubFiles.push({
                    id: Date.now() + Math.random(),
                    fileName: file.name,
                    title: result.title || file.name.replace(/\.epub$/i, ''),
                    content: result.content
                });
            } catch (e) {
                console.error('[EpubToTxt] 解析失败:', file.name, e);
                toastr.error(`解析失败: ${file.name}`);
            }
        }
        
        $('#epub-progress').hide();
        $('#epub-file-input').val('');
        renderFileList();
        
        toastr.success(`已添加 ${files.length} 个文件`);
    }

    // ============================================
    // 渲染文件列表
    // ============================================
    function renderFileList() {
        const listEl = $('#epub-file-list');
        
        if (epubFiles.length === 0) {
            listEl.html(`
                <div id="epub-empty-tip" style="
                    text-align: center;
                    color: #888;
                    padding: 20px;
                    font-size: 14px;
                ">
                    请选择EPUB文件<br>
                    <small>可拖动调整顺序</small>
                </div>
            `);
            return;
        }
        
        let html = '';
        epubFiles.forEach((file, index) => {
            html += `
                <div class="epub-file-item" data-id="${file.id}" draggable="true">
                    <span class="file-index">${index + 1}</span>
                    <span class="drag-handle">☰</span>
                    <span class="file-name" title="${file.fileName}">${file.title || file.fileName}</span>
                    <button class="remove-btn" data-id="${file.id}">✕</button>
                </div>
            `;
        });
        
        listEl.html(html);
        
        // 绑定删除按钮
        listEl.find('.remove-btn').on('click', function(e) {
            e.stopPropagation();
            const id = $(this).data('id');
            epubFiles = epubFiles.filter(f => f.id !== id);
            renderFileList();
        });
        
        // 绑定拖拽事件
        bindDragEvents();
    }

    // ============================================
    // 拖拽排序
    // ============================================
    function bindDragEvents() {
        const items = document.querySelectorAll('.epub-file-item');
        
        items.forEach(item => {
            item.addEventListener('dragstart', (e) => {
                draggedItem = item;
                item.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            
            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
                draggedItem = null;
                updateFileOrder();
            });
            
            item.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                
                if (draggedItem && draggedItem !== item) {
                    const list = item.parentNode;
                    const items = Array.from(list.querySelectorAll('.epub-file-item'));
                    const draggedIndex = items.indexOf(draggedItem);
                    const targetIndex = items.indexOf(item);
                    
                    if (draggedIndex < targetIndex) {
                        item.after(draggedItem);
                    } else {
                        item.before(draggedItem);
                    }
                }
            });
        });
    }

    // ============================================
    // 更新文件顺序
    // ============================================
    function updateFileOrder() {
        const items = document.querySelectorAll('.epub-file-item');
        const newOrder = [];
        
        items.forEach((item, index) => {
            const id = parseFloat(item.dataset.id);
            const file = epubFiles.find(f => f.id === id);
            if (file) {
                newOrder.push(file);
            }
            // 更新序号显示
            const indexEl = item.querySelector('.file-index');
            if (indexEl) {
                indexEl.textContent = index + 1;
            }
        });
        
        epubFiles = newOrder;
    }

    // ============================================
    // 清空文件
    // ============================================
    function clearFiles() {
        epubFiles = [];
        renderFileList();
        toastr.info('已清空文件列表');
    }

    // ============================================
    // 合并转换
    // ============================================
    function convertAll() {
        if (epubFiles.length === 0) {
            toastr.warning('请先选择EPUB文件');
            return;
        }
        
        // 按当前顺序合并所有内容
        const allContent = epubFiles.map(f => f.content).join('\n');
        
        // 生成文件名
        let fileName;
        if (epubFiles.length === 1) {
            fileName = epubFiles[0].fileName.replace(/\.epub$/i, '.txt');
        } else {
            fileName = `合并_${epubFiles.length}本_${new Date().toLocaleDateString('zh-CN').replace(/\//g, '')}.txt`;
        }
        
        // 下载
        const blob = new Blob([allContent], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        toastr.success(`已生成: ${fileName}`);
    }

    // ============================================
    // 打开/关闭弹窗
    // ============================================
    function openModal() {
        if ($('#epub-to-txt-modal').length === 0) {
            createModal();
        }
        $('#epub-progress').hide();
        $('#epub-to-txt-modal').css('display', 'block');
        $('body').css('overflow', 'hidden');
        renderFileList();
    }

    function closeModal() {
        $('#epub-to-txt-modal').hide();
        $('body').css('overflow', '');
    }

    // ============================================
    // 暴露到全局
    // ============================================
    window.EpubToTxt = {
        open: openModal,
        close: closeModal,
        parseEpub: parseEpub
    };

    console.log('[EpubToTxt] 📖 EPUB批量转TXT模块已加载');

})();

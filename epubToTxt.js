// epubToTxt.js - EPUB转TXT模块（修复版）

(function() {
    'use strict';

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
    // 从HTML元素提取文本（保留换行）
    // ============================================
    function extractTextWithLineBreaks(element) {
        let result = '';

        for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                // 文本节点：清理多余空白但保留内容
                const text = node.textContent.replace(/[\t\r]+/g, '').replace(/ +/g, ' ');
                result += text;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const tagName = node.tagName.toLowerCase();

                // 块级元素前后加换行
                const blockTags = ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 
                                   'li', 'tr', 'blockquote', 'section', 'article',
                                   'header', 'footer', 'aside', 'nav', 'pre'];

                if (blockTags.includes(tagName)) {
                    result += '\n';
                    result += extractTextWithLineBreaks(node);
                    result += '\n';
                } else if (tagName === 'br') {
                    // br标签换行
                    result += '\n';
                } else if (tagName === 'hr') {
                    // hr标签分隔线
                    result += '\n\n---\n\n';
                } else {
                    // 内联元素直接提取
                    result += extractTextWithLineBreaks(node);
                }
            }
        }

        return result;
    }

    // ============================================
    // 清理提取的文本
    // ============================================
    function cleanupText(text) {
        return text
            // 移除行首行尾空格
            .split('\n').map(line => line.trim()).join('\n')
            // 最多保留两个连续换行（即一个空行）
            .replace(/\n{3,}/g, '\n\n')
            // 移除开头结尾的空白
            .trim();
    }

    // ============================================
    // 解析EPUB文件
    // ============================================
    async function parseEpub(arrayBuffer) {
        const JSZip = await loadJSZip();
        const zip = await JSZip.loadAsync(arrayBuffer);
        const parser = new DOMParser();

        // 1. 从 container.xml 找到 OPF 文件路径
        const containerFile = zip.file('META-INF/container.xml');
        if (!containerFile) {
            throw new Error('无效的EPUB文件：找不到container.xml');
        }

        const containerXml = await containerFile.async('string');
        const containerDoc = parser.parseFromString(containerXml, 'text/xml');
        const rootfile = containerDoc.querySelector('rootfile');
        if (!rootfile) {
            throw new Error('无效的EPUB文件：找不到rootfile');
        }
        const opfPath = rootfile.getAttribute('full-path');

        // 2. 解析 OPF 文件获取阅读顺序
        const opfFile = zip.file(opfPath);
        if (!opfFile) {
            throw new Error('无效的EPUB文件：找不到OPF文件');
        }

        const opfContent = await opfFile.async('string');
        const opfDoc = parser.parseFromString(opfContent, 'application/xml');

        // 3. 获取书名
        const titleEl = opfDoc.querySelector('metadata title');
        const bookTitle = titleEl ? titleEl.textContent.trim() : '未知书名';

        // 4. 构建 manifest 查找表
        const manifest = {};
        opfDoc.querySelectorAll('manifest item').forEach(item => {
            manifest[item.getAttribute('id')] = item.getAttribute('href');
        });

        // 5. 获取基础路径
        const basePath = opfPath.includes('/') 
            ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) 
            : '';

        // 6. 按 spine 顺序提取文本
        const chapters = [];
        const spineItems = opfDoc.querySelectorAll('spine itemref');
        let chapterIndex = 0;

        for (const ref of spineItems) {
            const idref = ref.getAttribute('idref');
            const href = manifest[idref];
            if (!href) continue;

            // 跳过非HTML文件
            if (!href.match(/\.(x?html?|htm)$/i)) continue;

            const filePath = basePath + href;
            const file = zip.file(filePath);
            if (!file) continue;

            try {
                const html = await file.async('string');
                const doc = parser.parseFromString(html, 'text/html');

                if (!doc.body) continue;

                // 使用保留换行的提取方法
                let text = extractTextWithLineBreaks(doc.body);
                text = cleanupText(text);

                if (text && text.length > 10) {
                    chapterIndex++;
                    chapters.push(text);
                }
            } catch (e) {
                console.warn(`[EpubToTxt] 跳过文件: ${filePath}`, e);
            }
        }

        // 7. 组合最终文本
        const separator = '\n\n' + '═'.repeat(40) + '\n\n';
        const header = `《${bookTitle}》\n\n` + '═'.repeat(40) + '\n\n';

        return header + chapters.join(separator);
    }

    // ============================================
    // 创建弹窗UI（修复居中问题）
    // ============================================
    function createModal() {
        // 先移除可能存在的旧弹窗
        $('#epub-to-txt-modal').remove();

        const modalHtml = `
        <div id="epub-to-txt-modal" style="
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            z-index: 99999;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
        ">
            <div style="
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100%;
                padding: 20px;
                box-sizing: border-box;
            ">
                <div id="epub-modal-content" style="
                    background: var(--SmartThemeBlurTintColor, #1a1a2e);
                    border: 1px solid var(--SmartThemeBorderColor, #444);
                    border-radius: 10px;
                    padding: 20px;
                    max-width: 450px;
                    width: 100%;
                    color: var(--SmartThemeBodyColor, #fff);
                    margin: auto;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.5);
                ">
                    <h3 style="margin: 0 0 20px 0; text-align: center; font-size: 18px;">
                        📖 EPUB转TXT
                    </h3>

                    <div style="text-align: center; margin: 20px 0;">
                        <input type="file" id="epub-file-input" accept=".epub" style="display: none;">
                        <button id="epub-select-btn" class="menu_button" style="
                            background: linear-gradient(135deg, #9b59b6, #8e44ad);
                            padding: 15px 30px;
                            font-size: 16px;
                            width: 100%;
                            max-width: 280px;
                            border-radius: 8px;
                            cursor: pointer;
                        ">
                            📁 选择EPUB文件
                        </button>
                    </div>

                    <div id="epub-file-name" style="
                        text-align: center;
                        margin: 15px 0;
                        font-size: 13px;
                        opacity: 0.8;
                        word-break: break-all;
                        padding: 0 10px;
                    "></div>

                    <div id="epub-progress" style="
                        display: none;
                        text-align: center;
                        margin: 20px 0;
                        padding: 15px;
                        background: rgba(155, 89, 182, 0.2);
                        border-radius: 8px;
                    ">
                        <div style="font-size: 14px;">⏳ 正在转换中，请稍候...</div>
                        <div id="epub-progress-detail" style="font-size: 12px; margin-top: 8px; opacity: 0.7;"></div>
                    </div>

                    <div style="
                        text-align: center;
                        margin-top: 20px;
                        padding-top: 15px;
                        border-top: 1px solid var(--SmartThemeBorderColor, #444);
                    ">
                        <button id="epub-close-btn" class="menu_button" style="
                            background: #555;
                            padding: 10px 30px;
                            border-radius: 6px;
                            cursor: pointer;
                        ">
                            ✕ 关闭
                        </button>
                    </div>
                </div>
            </div>
        </div>`;

        $('body').append(modalHtml);

        // 绑定事件
        $('#epub-select-btn').on('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            $('#epub-file-input').trigger('click');
        });

        $('#epub-file-input').on('change', handleFileSelect);

        $('#epub-close-btn').on('click', (e) => {
            e.preventDefault();
            closeModal();
        });

        // 点击背景关闭
        $('#epub-to-txt-modal').on('click', (e) => {
            if (e.target.id === 'epub-to-txt-modal' || 
                $(e.target).parent().attr('id') === 'epub-to-txt-modal') {
                closeModal();
            }
        });

        // 阻止内容区域的点击冒泡
        $('#epub-modal-content').on('click', (e) => {
            e.stopPropagation();
        });
    }

    // ============================================
    // 文件选择处理
    // ============================================
    async function handleFileSelect(event) {
        const file = event.target.files[0];
        if (!file) return;

        const fileName = file.name;
        $('#epub-file-name').text(`已选择: ${fileName}`);
        $('#epub-progress').show();
        $('#epub-progress-detail').text('正在加载文件...');

        try {
            toastr.info('正在解析EPUB文件...');

            $('#epub-progress-detail').text('正在解压EPUB...');
            const arrayBuffer = await file.arrayBuffer();

            $('#epub-progress-detail').text('正在提取文本内容...');
            const textContent = await parseEpub(arrayBuffer);

            if (!textContent || textContent.trim().length === 0) {
                throw new Error('未能从EPUB中提取到文本内容');
            }

            $('#epub-progress-detail').text('正在生成TXT文件...');

            // 创建并下载TXT文件
            const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName.replace(/\.epub$/i, '.txt');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            toastr.success(`转换成功！共提取 ${textContent.length} 个字符`);
            $('#epub-file-name').html(`✅ <span style="color: #2ecc71;">${fileName} 转换完成！</span>`);

        } catch (error) {
            console.error('[EpubToTxt] 转换失败:', error);
            toastr.error('转换失败: ' + error.message);
            $('#epub-file-name').html(`❌ <span style="color: #e74c3c;">转换失败: ${error.message}</span>`);
        } finally {
            $('#epub-progress').hide();
            $('#epub-file-input').val('');
        }
    }

    // ============================================
    // 打开/关闭弹窗
    // ============================================
    function openModal() {
        if ($('#epub-to-txt-modal').length === 0) {
            createModal();
        }
        $('#epub-to-txt-modal').css('display', 'block');
        $('#epub-file-name').text('');
        $('#epub-progress').hide();

        // 禁止背景滚动
        $('body').css('overflow', 'hidden');
    }

    function closeModal() {
        $('#epub-to-txt-modal').hide();
        // 恢复背景滚动
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

    console.log('[EpubToTxt] 📖 EPUB转TXT模块已加载');

})();

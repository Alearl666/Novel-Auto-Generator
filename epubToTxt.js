// epubToTxt.js - EPUB转TXT模块

(function() {
    'use strict';

    // ============================================
    // 动态加载 JSZip 库（用于解压EPUB）
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

        // 3. 构建 manifest 查找表
        const manifest = {};
        opfDoc.querySelectorAll('manifest item').forEach(item => {
            manifest[item.getAttribute('id')] = item.getAttribute('href');
        });

        // 4. 获取基础路径
        const basePath = opfPath.includes('/') 
            ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) 
            : '';

        // 5. 按 spine 顺序提取文本
        const chapters = [];
        const spineItems = opfDoc.querySelectorAll('spine itemref');

        for (const ref of spineItems) {
            const idref = ref.getAttribute('idref');
            const href = manifest[idref];
            if (!href) continue;

            const filePath = basePath + href;
            const file = zip.file(filePath);
            if (!file) continue;

            try {
                const html = await file.async('string');
                const doc = parser.parseFromString(html, 'text/html');

                // 提取纯文本并清理空白
                let text = doc.body ? doc.body.textContent : '';
                text = text.replace(/\s+/g, ' ').trim();

                if (text) {
                    chapters.push(text);
                }
            } catch (e) {
                console.warn(`[EpubToTxt] 跳过文件: ${filePath}`, e);
            }
        }

        return chapters.join('\n\n' + '='.repeat(50) + '\n\n');
    }

    // ============================================
    // 创建弹窗UI
    // ============================================
    function createModal() {
        const modalHtml = `
        <div id="epub-to-txt-modal" style="
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.7);
            z-index: 10000;
            justify-content: center;
            align-items: center;
        ">
            <div style="
                background: var(--SmartThemeBlurTintColor, #1a1a2e);
                border-radius: 10px;
                padding: 20px;
                max-width: 500px;
                width: 90%;
                color: var(--SmartThemeBodyColor, #fff);
            ">
                <h3 style="margin-top: 0; text-align: center;">📖 EPUB转TXT</h3>

                <div style="margin: 20px 0; text-align: center;">
                    <input type="file" id="epub-file-input" accept=".epub" style="display: none;">
                    <button id="epub-select-btn" class="menu_button" style="
                        background: linear-gradient(135deg, #9b59b6, #8e44ad);
                        padding: 15px 30px;
                        font-size: 16px;
                    ">
                        📁 选择EPUB文件
                    </button>
                </div>

                <div id="epub-file-name" style="
                    text-align: center;
                    margin: 10px 0;
                    font-size: 14px;
                    opacity: 0.8;
                "></div>

                <div id="epub-progress" style="
                    display: none;
                    text-align: center;
                    margin: 20px 0;
                ">
                    <div style="font-size: 14px;">⏳ 正在转换...</div>
                </div>

                <div style="text-align: center; margin-top: 20px;">
                    <button id="epub-close-btn" class="menu_button" style="
                        background: #666;
                        padding: 10px 20px;
                    ">
                        关闭
                    </button>
                </div>
            </div>
        </div>`;

        $('body').append(modalHtml);

        // 绑定事件
        $('#epub-select-btn').on('click', () => {
            $('#epub-file-input').trigger('click');
        });

        $('#epub-file-input').on('change', handleFileSelect);

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
        const file = event.target.files[0];
        if (!file) return;

        $('#epub-file-name').text(`已选择: ${file.name}`);
        $('#epub-progress').show();

        try {
            toastr.info('正在解析EPUB文件...');

            const arrayBuffer = await file.arrayBuffer();
            const textContent = await parseEpub(arrayBuffer);

            if (!textContent || textContent.trim().length === 0) {
                throw new Error('未能从EPUB中提取到文本内容');
            }

            // 创建并下载TXT文件
            const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.name.replace(/\.epub$/i, '.txt');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            toastr.success('EPUB转换成功！文件已下载');

        } catch (error) {
            console.error('[EpubToTxt] 转换失败:', error);
            toastr.error('转换失败: ' + error.message);
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
        $('#epub-to-txt-modal').css('display', 'flex');
        $('#epub-file-name').text('');
        $('#epub-progress').hide();
    }

    function closeModal() {
        $('#epub-to-txt-modal').hide();
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

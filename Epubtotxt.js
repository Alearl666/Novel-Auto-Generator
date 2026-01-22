// epubToTxt.js - EPUB转TXT模块

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
    // HTML转纯文本（保留换行）
    // ============================================
    function htmlToText(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        if (!doc.body) return '';
        
        // 移除script和style标签
        doc.querySelectorAll('script, style').forEach(el => el.remove());
        
        // 在块级元素前后添加换行标记
        const blockTags = ['p', 'div', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 
                          'li', 'tr', 'blockquote', 'section', 'article', 'header', 
                          'footer', 'aside', 'nav', 'pre'];
        
        blockTags.forEach(tag => {
            doc.querySelectorAll(tag).forEach(el => {
                if (tag === 'br') {
                    el.replaceWith('\n');
                } else if (tag === 'p' || tag.startsWith('h')) {
                    // 段落和标题：前后各两个换行
                    el.innerHTML = '\n\n' + el.innerHTML + '\n';
                } else if (tag === 'li') {
                    // 列表项
                    el.innerHTML = '\n• ' + el.innerHTML;
                } else {
                    // 其他块级元素
                    el.innerHTML = '\n' + el.innerHTML + '\n';
                }
            });
        });
        
        // 获取纯文本
        let text = doc.body.textContent || '';
        
        // 清理多余空白但保留换行
        text = text
            .replace(/[ \t]+/g, ' ')           // 多个空格/制表符合并为一个
            .replace(/ ?\n ?/g, '\n')          // 换行符前后的空格去掉
            .replace(/\n{4,}/g, '\n\n\n')      // 超过3个换行合并为3个
            .replace(/^\s+/, '')               // 开头空白
            .replace(/\s+$/, '');              // 结尾空白
        
        return text;
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
        
        // 获取书名
        const titleEl = opfDoc.querySelector('metadata title, dc\\:title');
        const bookTitle = titleEl ? titleEl.textContent : '未知书名';
        
        // 3. 构建 manifest 查找表
        const manifest = {};
        opfDoc.querySelectorAll('manifest item').forEach(item => {
            manifest[item.getAttribute('id')] = {
                href: item.getAttribute('href'),
                mediaType: item.getAttribute('media-type')
            };
        });
        
        // 4. 获取基础路径
        const basePath = opfPath.includes('/') 
            ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) 
            : '';
        
        // 5. 按 spine 顺序提取文本
        const chapters = [];
        const spineItems = opfDoc.querySelectorAll('spine itemref');
        
        let chapterIndex = 0;
        for (const ref of spineItems) {
            const idref = ref.getAttribute('idref');
            const item = manifest[idref];
            if (!item) continue;
            
            // 只处理HTML/XHTML文件
            if (!item.mediaType || !item.mediaType.includes('html')) continue;
            
            const filePath = basePath + item.href;
            const file = zip.file(filePath);
            if (!file) continue;
            
            try {
                const html = await file.async('string');
                const text = htmlToText(html);
                
                if (text && text.trim().length > 0) {
                    chapterIndex++;
                    chapters.push(text.trim());
                }
            } catch (e) {
                console.warn(`[EpubToTxt] 跳过文件: ${filePath}`, e);
            }
        }
        
        // 用分隔线连接各章节
        const separator = '\n\n' + '━'.repeat(40) + '\n\n';
        const fullText = chapters.join(separator);
        
        return fullText;
    }

    // ============================================
    // 创建弹窗UI（修复居中问题）
    // ============================================
    function createModal() {
        // 先移除旧的弹窗（如果有）
        $('#epub-to-txt-modal').remove();
        
        const modalHtml = `
        <div id="epub-to-txt-modal" class="epub-modal-overlay">
            <div class="epub-modal-container">
                <div class="epub-modal-content">
                    <h3 class="epub-modal-title">📖 EPUB转TXT</h3>
                    
                    <div class="epub-modal-body">
                        <input type="file" id="epub-file-input" accept=".epub" style="display: none;">
                        <button id="epub-select-btn" class="menu_button epub-select-button">
                            📁 选择EPUB文件
                        </button>
                        
                        <div id="epub-file-name" class="epub-file-info"></div>
                        
                        <div id="epub-progress" class="epub-progress" style="display: none;">
                            <div class="epub-spinner"></div>
                            <span>正在转换中...</span>
                        </div>
                    </div>
                    
                    <div class="epub-modal-footer">
                        <button id="epub-close-btn" class="menu_button epub-close-button">
                            关闭
                        </button>
                    </div>
                </div>
            </div>
        </div>
        
        <style>
            .epub-modal-overlay {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.75);
                z-index: 99999;
                overflow-y: auto;
                -webkit-overflow-scrolling: touch;
            }
            
            .epub-modal-container {
                display: flex;
                justify-content: center;
                align-items: center;
                min-height: 100%;
                padding: 20px;
                box-sizing: border-box;
            }
            
            .epub-modal-content {
                background: var(--SmartThemeBlurTintColor, #1a1a2e);
                border: 1px solid var(--SmartThemeBorderColor, #444);
                border-radius: 12px;
                padding: 24px;
                width: 100%;
                max-width: 420px;
                color: var(--SmartThemeBodyColor, #fff);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                margin: auto;
            }
            
            .epub-modal-title {
                margin: 0 0 20px 0;
                text-align: center;
                font-size: 20px;
                color: var(--SmartThemeBodyColor, #fff);
            }
            
            .epub-modal-body {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 15px;
            }
            
            .epub-select-button {
                background: linear-gradient(135deg, #9b59b6, #8e44ad) !important;
                padding: 16px 32px !important;
                font-size: 16px !important;
                border-radius: 8px !important;
                width: 100%;
                max-width: 280px;
            }
            
            .epub-select-button:hover {
                background: linear-gradient(135deg, #a86bc4, #9b59b6) !important;
                transform: translateY(-1px);
            }
            
            .epub-file-info {
                text-align: center;
                font-size: 14px;
                opacity: 0.8;
                word-break: break-all;
                padding: 0 10px;
            }
            
            .epub-progress {
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 10px;
                padding: 15px;
                background: rgba(155, 89, 182, 0.2);
                border-radius: 8px;
                width: 100%;
                box-sizing: border-box;
            }
            
            .epub-spinner {
                width: 20px;
                height: 20px;
                border: 3px solid rgba(255, 255, 255, 0.3);
                border-top-color: #9b59b6;
                border-radius: 50%;
                animation: epub-spin 0.8s linear infinite;
            }
            
            @keyframes epub-spin {
                to { transform: rotate(360deg); }
            }
            
            .epub-modal-footer {
                margin-top: 20px;
                text-align: center;
            }
            
            .epub-close-button {
                background: #555 !important;
                padding: 10px 30px !important;
                border-radius: 6px !important;
            }
            
            .epub-close-button:hover {
                background: #666 !important;
            }
            
            /* 手机端适配 */
            @media (max-width: 480px) {
                .epub-modal-container {
                    padding: 15px;
                }
                
                .epub-modal-content {
                    padding: 20px 16px;
                }
                
                .epub-select-button {
                    padding: 14px 24px !important;
                    font-size: 15px !important;
                }
            }
        </style>`;
        
        $('body').append(modalHtml);
        
        // 绑定事件
        $('#epub-select-btn').on('click', () => {
            $('#epub-file-input').trigger('click');
        });
        
        $('#epub-file-input').on('change', handleFileSelect);
        
        $('#epub-close-btn').on('click', closeModal);
        
        // 点击遮罩层关闭
        $('#epub-to-txt-modal').on('click', (e) => {
            if ($(e.target).hasClass('epub-modal-overlay') || $(e.target).hasClass('epub-modal-container')) {
                closeModal();
            }
        });
        
        // ESC键关闭
        $(document).on('keydown.epubModal', (e) => {
            if (e.key === 'Escape') {
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
        $('#epub-select-btn').prop('disabled', true);
        
        try {
            toastr.info('正在解析EPUB文件，请稍候...');
            
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
            
            toastr.success('转换成功！TXT文件已下载');
            
        } catch (error) {
            console.error('[EpubToTxt] 转换失败:', error);
            toastr.error('转换失败: ' + error.message);
        } finally {
            $('#epub-progress').hide();
            $('#epub-select-btn').prop('disabled', false);
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
        $('#epub-file-name').text('');
        $('#epub-progress').hide();
        $('#epub-select-btn').prop('disabled', false);
        $('#epub-to-txt-modal').css('display', 'block');
        
        // 防止背景滚动
        $('body').css('overflow', 'hidden');
    }

    function closeModal() {
        $('#epub-to-txt-modal').hide();
        $('body').css('overflow', '');
        $(document).off('keydown.epubModal');
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

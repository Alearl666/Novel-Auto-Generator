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
                    el.innerHTML = '\n\n' + el.innerHTML + '\n';
                } else if (tag === 'li') {
                    el.innerHTML = '\n• ' + el.innerHTML;
                } else {
                    el.innerHTML = '\n' + el.innerHTML + '\n';
                }
            });
        });
        
        let text = doc.body.textContent || '';
        
        text = text
            .replace(/[ \t]+/g, ' ')
            .replace(/ ?\n ?/g, '\n')
            .replace(/\n{4,}/g, '\n\n\n')
            .replace(/^\s+/, '')
            .replace(/\s+$/, '');
        
        return text;
    }

    // ============================================
    // 解析EPUB文件
    // ============================================
    async function parseEpub(arrayBuffer) {
        const JSZip = await loadJSZip();
        const zip = await JSZip.loadAsync(arrayBuffer);
        const parser = new DOMParser();
        
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
        
        const opfFile = zip.file(opfPath);
        if (!opfFile) {
            throw new Error('无效的EPUB文件：找不到OPF文件');
        }
        
        const opfContent = await opfFile.async('string');
        const opfDoc = parser.parseFromString(opfContent, 'application/xml');
        
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
                console.warn('[EpubToTxt] 跳过文件:', filePath, e);
            }
        }
        
        const separator = '\n\n' + '━'.repeat(40) + '\n\n';
        return chapters.join(separator);
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
                align-items: center;
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
                    max-width: 420px;
                    color: var(--SmartThemeBodyColor, #fff);
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
                ">
                    <h3 style="margin: 0 0 20px 0; text-align: center; font-size: 20px;">
                        📖 EPUB转TXT
                    </h3>
                    
                    <div style="display: flex; flex-direction: column; align-items: center; gap: 15px;">
                        <input type="file" id="epub-file-input" accept=".epub" style="display: none;">
                        <button id="epub-select-btn" class="menu_button" style="
                            background: linear-gradient(135deg, #9b59b6, #8e44ad) !important;
                            padding: 16px 32px !important;
                            font-size: 16px !important;
                            border-radius: 8px !important;
                            width: 100%;
                            max-width: 280px;
                        ">
                            📁 选择EPUB文件
                        </button>
                        
                        <div id="epub-file-name" style="
                            text-align: center;
                            font-size: 14px;
                            opacity: 0.8;
                            word-break: break-all;
                        "></div>
                        
                        <div id="epub-progress" style="
                            display: none;
                            align-items: center;
                            justify-content: center;
                            gap: 10px;
                            padding: 15px;
                            background: rgba(155, 89, 182, 0.2);
                            border-radius: 8px;
                            width: 100%;
                            box-sizing: border-box;
                        ">
                            <span>⏳ 正在转换中...</span>
                        </div>
                    </div>
                    
                    <div style="margin-top: 20px; text-align: center;">
                        <button id="epub-close-btn" class="menu_button" style="
                            background: #555 !important;
                            padding: 10px 30px !important;
                            border-radius: 6px !important;
                        ">
                            关闭
                        </button>
                    </div>
                </div>
            </div>
        </div>`;
        
        $('body').append(modalHtml);
        
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
        
        $('#epub-file-name').text('已选择: ' + file.name);
        $('#epub-progress').css('display', 'flex');
        $('#epub-select-btn').prop('disabled', true);
        
        try {
            toastr.info('正在解析EPUB文件，请稍候...');
            
            const arrayBuffer = await file.arrayBuffer();
            const textContent = await parseEpub(arrayBuffer);
            
            if (!textContent || textContent.trim().length === 0) {
                throw new Error('未能从EPUB中提取到文本内容');
            }
            
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
        $('body').css('overflow', 'hidden');
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

    console.log('[EpubToTxt] 📖 EPUB转TXT模块已加载');

})();

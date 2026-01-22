import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import './txtToWorldbook.js';

const extensionName = "novel-auto-generator";

// 自动获取当前扩展的路径
const extensionFolderPath = import.meta.url.substring(0, import.meta.url.lastIndexOf('/'));

const defaultSettings = {};

let settings = {};

// ============================================
// 工具函数
// ============================================

function log(msg, type = 'info') {
    const p = { info: '📘', success: '✅', warning: '⚠️', error: '❌', debug: '🔍' }[type] || 'ℹ️';
    console.log(`[NovelGen] ${p} ${msg}`);
}

// 动态加载JS文件
async function loadScript(filename) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `${extensionFolderPath}/${filename}`;
        script.onload = () => resolve();
        script.onerror = (e) => reject(e);
        document.head.appendChild(script);
    });
}

// ============================================
// 设置 & UI
// ============================================

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    settings = Object.assign({}, defaultSettings, extension_settings[extensionName]);
}

function saveSettings() {
    Object.assign(extension_settings[extensionName], settings);
    saveSettingsDebounced();
}

function createUI() {
    const html = `
    <div id="nag-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📚 文件转换工具</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="nag-section">
                    <div class="nag-btn-row">
                        <button id="nag-btn-txt-to-worldbook" class="menu_button" style="background: linear-gradient(135deg, #e67e22, #d35400); width: 100%;">
                            📚 TXT转世界书
                        </button>
                    </div>
                    <div style="margin-top: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                        将TXT文件转换为SillyTavern世界书格式
                    </div>
                    
                    <div class="nag-btn-row" style="margin-top: 15px;">
                        <button id="nag-btn-epub-to-txt" class="menu_button" style="background: linear-gradient(135deg, #9b59b6, #8e44ad); width: 100%;">
                            📖 EPUB转TXT
                        </button>
                    </div>
                    <div style="margin-top: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                        将EPUB电子书转换为TXT纯文本格式
                    </div>
                </div>
            </div>
        </div>
    </div>`;
    
    $('#extensions_settings').append(html);
    bindEvents();
}

function bindEvents() {
    $('#nag-btn-txt-to-worldbook').on('click', () => {
        if (typeof window.TxtToWorldbook !== 'undefined') {
            window.TxtToWorldbook.open();
        } else {
            toastr.error('TXT转世界书模块未加载');
        }
    });
    
    $('#nag-btn-epub-to-txt').on('click', async () => {
        if (typeof window.EpubToTxt === 'undefined') {
            try {
                toastr.info('正在加载EPUB模块...');
                await loadScript('epubToTxt.js');
            } catch (e) {
                toastr.error('EPUB转TXT模块加载失败');
                console.error('[NovelGen] 加载epubToTxt.js失败:', e);
                console.error('[NovelGen] 尝试加载路径:', `${extensionFolderPath}/epubToTxt.js`);
                return;
            }
        }
        
        if (typeof window.EpubToTxt !== 'undefined') {
            window.EpubToTxt.open();
        } else {
            toastr.error('EPUB转TXT模块未加载');
        }
    });
}

// ============================================
// 初始化
// ============================================

jQuery(async () => {
    loadSettings();
    createUI();
    
    log('扩展路径: ' + extensionFolderPath, 'debug');
    
    try {
        await loadScript('epubToTxt.js');
        log('EPUB转TXT模块已加载', 'success');
    } catch (e) {
        log('EPUB转TXT模块将在点击时加载', 'warning');
    }
    
    log('文件转换工具扩展已加载', 'success');
});

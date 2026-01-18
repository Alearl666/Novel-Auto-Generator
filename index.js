import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import './txtToWorldbook.js';

const extensionName = "novel-auto-generator";

const defaultSettings = {};

let settings = {};

// ============================================
// 工具函数
// ============================================

function log(msg, type = 'info') {
    const p = { info: '📘', success: '✅', warning: '⚠️', error: '❌', debug: '🔍' }[type] || 'ℹ️';
    console.log(`[NovelGen] ${p} ${msg}`);
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
    <div id="nag-container" class="nag-panel">
        <div class="nag-header">
            <h4>📚 TXT转世界书工具</h4>
        </div>
        <div class="nag-content">
            <button id="nag-btn-txt-to-worldbook" class="menu_button" style="background: linear-gradient(135deg, #e67e22, #d35400); width: 100%;">
                📚 TXT转世界书
            </button>
            <div style="margin-top: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                将TXT文件转换为SillyTavern世界书格式
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
}

// ============================================
// 初始化
// ============================================

jQuery(async () => {
    loadSettings();
    createUI();
    log('TXT转世界书扩展已加载', 'success');
});

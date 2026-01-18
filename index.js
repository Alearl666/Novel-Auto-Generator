import { saveSettingsDebounced } from "../../../../script.js";
import { extension_settings } from "../../../extensions.js";
import './txtToWorldbook.js';

const extensionName = "novel-auto-generator";

const defaultSettings = {
    // txtToWorldbook 相关设置可以放这里
};

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
    <div id="nag-container">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>📚 TXT转世界书工具</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <!-- ✅ 直接把UI内容放这里，展开就能看到 -->
                <div class="nag-section">
                    <div style="margin-bottom: 10px; font-size: 12px; opacity: 0.7; text-align: center;">
                        将TXT文件转换为SillyTavern世界书格式
                    </div>

                    <!-- 文件选择 -->
                    <div class="nag-setting-item">
                        <label>选择TXT文件</label>
                        <input type="file" id="ttw-file-input" accept=".txt">
                    </div>

                    <!-- 设置选项 -->
                    <div class="nag-setting-item">
                        <label>世界书名称</label>
                        <input type="text" id="ttw-worldbook-name" placeholder="输入世界书名称">
                    </div>

                    <!-- 更多设置... 根据你的 txtToWorldbook.js 添加 -->

                    <!-- 操作按钮 -->
                    <div class="nag-btn-row" style="margin-top: 15px;">
                        <button id="ttw-btn-convert" class="menu_button" style="background: linear-gradient(135deg, #e67e22, #d35400); width: 100%;">
                            🔄 开始转换
                        </button>
                    </div>

                    <!-- 预览区域 -->
                    <div id="ttw-preview" style="margin-top: 15px; display: none;">
                        <label>预览</label>
                        <div id="ttw-preview-content" style="max-height: 200px; overflow-y: auto; border: 1px solid #444; padding: 10px; border-radius: 5px;">
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </div>`;

    $('#extensions_settings').append(html);
    bindEvents();
}

function bindEvents() {
    // 绑定转换按钮事件
    $('#ttw-btn-convert').on('click', () => {
        if (typeof window.TxtToWorldbook !== 'undefined') {
            // 调用转换逻辑
            window.TxtToWorldbook.convert();
        } else {
            toastr.error('TXT转世界书模块未加载');
        }
    });

    // 文件选择事件
    $('#ttw-file-input').on('change', function() {
        const file = this.files[0];
        if (file) {
            // 处理文件...
            log(`已选择文件: ${file.name}`, 'info');
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

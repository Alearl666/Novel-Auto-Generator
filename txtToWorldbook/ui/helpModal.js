import { t, onLocaleChange, getLocale } from '../core/i18n.js';
import zhCN from '../locales/zh-CN.js';
import enUS from '../locales/en-US.js';

const LOCALE_MAP = {
    'zh-CN': zhCN,
    zh: zhCN,
    'en-US': enUS,
    en: enUS,
};

export function createHelpModal(deps = {}) {
    const { ModalFactory } = deps;

    const SECTION_ORDER = [
        { key: 'basic', color: '#e67e22' },
        { key: 'api', color: '#3498db' },
        { key: 'categories', color: '#9b59b6' },
        { key: 'prompt', color: '#27ae60' },
        { key: 'defaultEntries', color: '#e67e22' },
        { key: 'chapters', color: '#1abc9c' },
        { key: 'search', color: '#e74c3c' },
        { key: 'alias', color: '#9b59b6' },
        { key: 'tokens', color: '#f1c40f' },
        { key: 'history', color: '#95a5a6' },
        { key: 'importMerge', color: '#e74c3c' },
        { key: 'exportImport', color: '#e67e22' },
        { key: 'aiTools', color: '#9b59b6' },
        { key: 'modelStatus', color: '#3498db' },
    ];

    function getLocaleData() {
        const locale = getLocale();
        const resolved = LOCALE_MAP[locale] ? locale : locale.split('-')[0];
        return LOCALE_MAP[resolved] || zhCN;
    }

    function renderSectionHtml({ key, color }) {
        const data = getLocaleData();
        const section = data.help?.sections?.[key];
        if (!section || !section.items || section.items.length === 0) return '';
        const itemsHtml = section.items.map((item) => `<li>${item}</li>`).join('');
        return `
<div style="margin-bottom:16px;">
<h4 style="color:${color};margin:0 0 10px;">${t(`help.sections.${key}.title`)}</h4>
<ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;">
${itemsHtml}
</ul>
</div>
`;
    }

    function showHelpModal() {
        const existingHelp = document.getElementById('ttw-help-modal');
        if (existingHelp) existingHelp.remove();

        const sectionsHtml = SECTION_ORDER.map(renderSectionHtml).join('');
        const data = getLocaleData();
        const tipsItems = data.help?.tips?.items || [];
        const tipsHtml = tipsItems.map((item) => `<li>${item}</li>`).join('');

        const bodyHtml = `
${sectionsHtml}
<div style="padding:12px;background:rgba(52,152,219,0.15);border-radius:8px;">
<div style="font-weight:bold;color:#3498db;margin-bottom:8px;">${t('help.tips.title')}</div>
<ul style="margin:0;padding-left:20px;line-height:1.8;color:#ccc;font-size:12px;">
${tipsHtml}
</ul>
</div>
`;

        const footerHtml = `<button class="ttw-btn ttw-btn-primary" id="ttw-close-help">${t('help.gotIt')}</button>`;

        const helpModal = ModalFactory.create({
            id: 'ttw-help-modal',
            title: t('help.title'),
            body: bodyHtml,
            footer: footerHtml,
            maxWidth: '700px',
            maxHeight: '75vh',
        });

        helpModal.querySelector('#ttw-close-help').addEventListener('click', () => ModalFactory.close(helpModal));
    }

    // When language changes, close existing modal (next open uses new language)
    onLocaleChange(() => {
        const existing = document.getElementById('ttw-help-modal');
        if (existing) {
            ModalFactory.close(existing);
        }
    });

    return {
        showHelpModal,
    };
}

import { describe, it, expect, beforeEach } from 'vitest';
import { createSettingsPersistenceService } from '../../txtToWorldbook/services/settingsPersistenceService.js';
import { defaultSettings } from '../../txtToWorldbook/core/constants.js';

// 极简 DOM：只需要 getElementById 返回带 value/checked 的对象
const fields = new Map();
function setField(id, props) {
    fields.set(id, { value: '', checked: false, ...props });
}
globalThis.document = {
    getElementById: (id) => fields.get(id) || null,
};

function makeState() {
    return {
        settings: { ...defaultSettings },
        processing: {},
        config: {
            parallel: { enabled: true, concurrency: 3, mode: 'independent' },
            categoryLight: {},
            chapterRegex: { pattern: '第x章' },
            categoryDefault: {},
            entryPosition: {},
        },
        persistent: { defaultEntries: [] },
    };
}

function makeService(AppState) {
    return createSettingsPersistenceService({
        AppState,
        defaultSettings,
        updateSettingsUI: () => {},
        updateChapterRegexUI: () => {},
        handleProviderChange: () => {},
    });
}

describe('默认设置', () => {
    it('默认不使用酒馆API', () => {
        expect(defaultSettings.useTavernApi).toBe(false);
    });

    it('默认 provider 为 OpenAI 兼容', () => {
        expect(defaultSettings.customApiProvider).toBe('openai-compatible');
    });

    it('采样参数字段存在且有合理默认值', () => {
        expect(defaultSettings.presetTemperature).toBe(0.3);
        expect(defaultSettings.presetMaxTokens).toBeNull();
        expect(defaultSettings.importedPresetName).toBe('');
    });

    it('默认开启实时流式输出', () => {
        expect(defaultSettings.liveStreamOutput).toBe(true);
    });
});

describe('saveCurrentSettings - 采样参数', () => {
    let AppState;
    let svc;

    beforeEach(() => {
        fields.clear();
        setField('ttw-chunk-size', { value: '15000' });
        setField('ttw-api-timeout', { value: '120' });
        setField('ttw-api-provider', { value: 'openai-compatible' });
        AppState = makeState();
        svc = makeService(AppState);
    });

    it('读取界面温度', () => {
        setField('ttw-temperature', { value: '1.15' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetTemperature).toBe(1.15);
    });

    it('温度为 0 时正确保存，不被当作缺省', () => {
        setField('ttw-temperature', { value: '0' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetTemperature).toBe(0);
    });

    it('温度超出上限时被夹到 2', () => {
        setField('ttw-temperature', { value: '9' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetTemperature).toBe(2);
    });

    it('温度为负数时被夹到 0', () => {
        setField('ttw-temperature', { value: '-3' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetTemperature).toBe(0);
    });

    it('温度留空时保持原值不变', () => {
        AppState.settings.presetTemperature = 0.9;
        setField('ttw-temperature', { value: '' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetTemperature).toBe(0.9);
    });

    it('温度填了非数字时保持原值', () => {
        AppState.settings.presetTemperature = 0.5;
        setField('ttw-temperature', { value: 'abc' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetTemperature).toBe(0.5);
    });

    it('读取最大输出', () => {
        setField('ttw-max-tokens', { value: '8192' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetMaxTokens).toBe(8192);
    });

    it('最大输出留空存为 null（用接口默认值）', () => {
        AppState.settings.presetMaxTokens = 4096;
        setField('ttw-max-tokens', { value: '' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetMaxTokens).toBeNull();
    });

    it('最大输出为 0 或负数时存为 null', () => {
        setField('ttw-max-tokens', { value: '0' });
        svc.saveCurrentSettings();
        expect(AppState.settings.presetMaxTokens).toBeNull();
    });

    it('界面上没有这两个输入框时不报错（向后兼容）', () => {
        expect(() => svc.saveCurrentSettings()).not.toThrow();
    });
});

describe('saveCurrentSettings - 酒馆API开关', () => {
    beforeEach(() => {
        fields.clear();
        setField('ttw-chunk-size', { value: '15000' });
        setField('ttw-api-timeout', { value: '120' });
        setField('ttw-api-provider', { value: 'openai-compatible' });
    });

    it('开关不存在时默认为 false（自定义API）', () => {
        const AppState = makeState();
        makeService(AppState).saveCurrentSettings();
        expect(AppState.settings.useTavernApi).toBe(false);
    });

    it('勾选后保存为 true', () => {
        setField('ttw-use-tavern-api', { checked: true });
        const AppState = makeState();
        makeService(AppState).saveCurrentSettings();
        expect(AppState.settings.useTavernApi).toBe(true);
    });
});

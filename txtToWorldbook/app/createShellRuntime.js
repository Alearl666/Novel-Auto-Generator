import { createFileUtils } from '../core/fileUtils.js';
import { createFileImportService } from '../services/fileImportService.js';
import { createSettingsPersistenceService } from '../services/settingsPersistenceService.js';
import { createCategoryLightService } from '../services/categoryLightService.js';
import { createEntryConfigService } from '../services/entryConfigService.js';
import { createPresetImportService } from '../services/presetImportService.js';
import { createModalLifecycle } from '../ui/modalLifecycle.js';
import { createModalController } from '../ui/modalController.js';
import { createModalEventBinder } from '../ui/modalEventBinder.js';
import { createModalRuntimeFacade } from '../ui/modalRuntimeFacade.js';

export function createShellRuntime(deps = {}) {
    const {
        AppState,
        MemoryHistoryDB,
        Logger,
        ErrorHandler,
        confirmAction,
        defaultSettings,
        createWorldbookView,
        createSettingsPersistenceServiceDeps,
        createModalLifecycleDeps,
        createModalControllerDeps,
        createModalEventBinderDeps,
        fileImportDeps,
        worldbookViewDeps,
        categoryLightStorageKey = 'txtToWorldbookSettings',
        onEntryConfigChanged,
        onHashFallback,
    } = deps;

    let modalContainer = null;

    const worldbookView = createWorldbookView(worldbookViewDeps);

    const fileUtils = createFileUtils({
        onHashFallback,
    });

    const fileImportService = createFileImportService({
        AppState,
        MemoryHistoryDB,
        Logger,
        ErrorHandler,
        confirmAction,
        fileUtils,
        ...fileImportDeps,
    });

    const settingsPersistenceService = createSettingsPersistenceService({
        AppState,
        defaultSettings,
        ...createSettingsPersistenceServiceDeps,
    });

    const categoryLightService = createCategoryLightService({
        AppState,
        storageKey: categoryLightStorageKey,
    });

    const entryConfigService = createEntryConfigService({
        AppState,
        onConfigChanged: onEntryConfigChanged,
    });

    const modalLifecycle = createModalLifecycle(createModalLifecycleDeps);

    const modalController = createModalController({
        AppState,
        getModalContainer: () => modalContainer,
        setModalContainer: (value) => {
            modalContainer = value;
        },
        ...createModalControllerDeps,
    });

    const presetImportService = createPresetImportService({
        AppState,
        Logger,
        // 惰性调用：saveCurrentSettings 在 modalRuntimeFacade 组装完成后才可用
        saveCurrentSettings: () => modalRuntimeFacade && modalRuntimeFacade.saveCurrentSettings(),
    });

    const modalEventBinder = createModalEventBinder({
        ...createModalEventBinderDeps(modalController, () => modalContainer),
        presetImportService,
        importUpdateChapters: (...args) => fileImportService.importUpdateChapters(...args),
    });

    // eslint-disable-next-line prefer-const
    var modalRuntimeFacade = createModalRuntimeFacade({
        settingsPersistenceService,
        modalLifecycle,
        modalEventBinder,
        modalController,
        getModalContainer: () => modalContainer,
    });

    return {
        worldbookView,
        fileUtils,
        fileImportService,
        presetImportService,
        settingsPersistenceService,
        categoryLightService,
        entryConfigService,
        modalLifecycle,
        modalController,
        modalEventBinder,
        modalRuntimeFacade,
        getModalContainer: () => modalContainer,
    };
}

// ========== 全局状态 ==========
const SLOT_COUNT = 10;
const QUEUE_COUNT = 10;
/** 单条拆图队列内最多素材（九宫格张数） */
const SPLIT_MAX_MATERIALS = 10;
/** 单条拆图队列严格顺序提交：裁一张、带提示词发一张、处理完再下一张 */
const SPLIT_GEN_CONCURRENCY = 1;
/** 多条拆图队列不做人为等待上限；每个队列按自身顺序提交 */
const SPLIT_GLOBAL_GEN_CONCURRENCY = Number.POSITIVE_INFINITY;
const DEFAULT_PRESET_TAGS = ['肖像', '写真', '日系写真', '纯欲写真', '私房写真', '外景写真', '樱花写真', '新中式', '古风', '旗袍', '韩杂', '日杂', '杂志', '氛围感肖像', '胶片写真', '暗黑写真', '欧美肖像', '商业写真', '复古写真', '纪实写真'];

const state = {
    categories: [],
    prefixes: [],
    suffixes: [],
    props: [],
    presets: [],
    presetTags: [...DEFAULT_PRESET_TAGS],  // 可增删改的分类标签
    modelConfig: {},
    categoryOrder: [],
    propOrder: [],          // 道具分类排序
    selectedPrefixes: [],
    selectedItems: {},
    selectedSuffixes: [],
    expandedCategory: null,
    expandedProp: null,       // 当前展开的道具分类 id
    generatedPrompt: '',
    generatedSource: '',
    deleteCallback: null,
    editCallback: null,
    presetCoverUrl: '',
    presetEffectUrl: '',      // 效果图 URL
    selectedPresetTags: [],   // 保存预设时选中的标签
    presetFilterTag: '',      // 预设列表筛选标签
    presetSearchKeyword: '',  // 预设搜索关键词
    presetSortBy: 'default',  // 预设排序方式: default/name/created_at/updated_at
    presetCollapsed: false,   // 预设栏是否折叠
    presetZoom: 4,            // 预设缩放列数
    propSearchKeyword: '',    // 道具搜索关键词
    propZoom: {},             // 道具分类缩放级别 { propId: columns }
    previewCursorPos: null    // 预览区光标位置
};

// ========== 工具函数 ==========
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

// 自定义 prompt 弹窗（替代原生 prompt()）
function showPrompt(title, defaultText = '', placeholder = '') {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-custom-prompt');
        const titleEl = document.getElementById('custom-prompt-title');
        const inputEl = document.getElementById('custom-prompt-input');
        const confirmBtn = document.getElementById('custom-prompt-confirm');
        const cancelBtn = document.getElementById('custom-prompt-cancel');

        titleEl.textContent = title;
        inputEl.value = defaultText;
        inputEl.placeholder = placeholder;

        // Clean up previous listeners
        const newConfirm = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
        const newCancel = cancelBtn.cloneNode(true);
        cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
        const newInput = inputEl.cloneNode(true);
        inputEl.parentNode.replaceChild(newInput, inputEl);

        // Re-get elements after clone
        const curInput = document.getElementById('custom-prompt-input');
        const curConfirm = document.getElementById('custom-prompt-confirm');
        const curCancel = document.getElementById('custom-prompt-cancel');
        curInput.value = defaultText;
        curInput.placeholder = placeholder;

        const close = (value) => {
            modal.style.display = 'none';
            resolve(value);
        };

        curConfirm.addEventListener('click', () => close(curInput.value));
        curCancel.addEventListener('click', () => close(null));
        curInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); close(curInput.value); }
            if (e.key === 'Escape') { e.preventDefault(); close(null); }
        });

        // Click overlay to cancel
        const overlayHandler = (e) => {
            if (e.target === modal) { modal.removeEventListener('click', overlayHandler); close(null); }
        };
        modal.addEventListener('click', overlayHandler);

        // Close button
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) {
            const newCloseBtn = closeBtn.cloneNode(true);
            closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
            newCloseBtn.addEventListener('click', () => close(null));
        }

        modal.style.display = 'flex';
        // Auto-focus and select
        setTimeout(() => { curInput.focus(); curInput.select(); }, 50);
    });
}

async function api(method, url, body, timeoutMs = 60000, cancelSignal, skipGlobalAbort = false) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    opts.signal = controller.signal;
    // 如果传入了取消signal（按列队），关联上
    if (cancelSignal) {
        if (cancelSignal.aborted) { controller.abort(); clearTimeout(timer); }
        else {
            const onCancel = () => { controller.abort(); clearTimeout(timer); };
            cancelSignal.addEventListener('abort', onCancel, { once: true });
        }
    } else if (!skipGlobalAbort && apiGenerateState?.abortController) {
        // 仅对生成类请求绑定全局取消信号，数据保存类请求不绑定（防止取消生成时误杀保存）
        const globalSignal = apiGenerateState.abortController.signal;
        if (globalSignal.aborted) { controller.abort(); clearTimeout(timer); }
        else {
            const onGlobalAbort = () => { controller.abort(); clearTimeout(timer); };
            globalSignal.addEventListener('abort', onGlobalAbort, { once: true });
        }
    }
    try {
        const resp = await fetch(url, opts);
        clearTimeout(timer);
        const data = await resp.json();
        if (!resp.ok) {
            const errMsg = (typeof data.error === 'object' && data.error?.message) ? data.error.message : (data.error || '请求失败');
            throw new Error(errMsg);
        }
        return data;
    } catch (e) {
        clearTimeout(timer);
        if (e.name === 'AbortError') throw new Error('请求已取消');
        throw e;
    }
}

/** OpenAI-HK GPT 同步生图：前端 fetch 超时与后端 model_config.json 的 oaihk_image_timeout_sec 对齐（默认 240s）并留余量 */
function getOaihkGptClientTimeoutMs() {
    const sec = parseInt(state.modelConfig?.oaihk_image_timeout_sec, 10);
    const base = Number.isFinite(sec) && sec > 0 ? sec : 240;
    return (base + 120) * 1000;
}

/** GPT 返回项 → 展示 URL：优先使用响应里的 base64（后端已处理则不再走 download-image，避免重复拉图） */
async function displayUrlFromOaihkGptItem(item, signal) {
    const b64 = item?.b64_json;
    if (typeof b64 === 'string' && b64.length > 0) {
        return `data:image/png;base64,${b64}`;
    }
    const url = item?.url;
    if (!url) return '';
    try {
        const dlResp = await api('POST', '/api/download-image', { url }, getOaihkGptClientTimeoutMs(), signal);
        if (dlResp.data?.data_uri) return dlResp.data.data_uri;
    } catch (dlErr) {
        console.warn('[HK-GPT] 成图代理下载失败:', dlErr);
    }
    return url;
}

/** HK 多任务并行时串行追加结果卡片，避免 allResults / index 竞态 */
let _hkParallelUiTail = Promise.resolve();
function enqueueHKParallelResultUi(fn) {
    _hkParallelUiTail = _hkParallelUiTail.then(fn).catch(() => {});
}

// 上传图片辅助函数：封装fetch + 自动显示上采样警告
async function uploadImage(formData) {
    const resp = await fetch('/api/upload-image', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '上传失败');
    if (data.warning) showToast(data.warning, 'warning');
    return data.url;
}

function getFileBaseName(filename = '') {
    const base = String(filename).split('/').pop().split('\\').pop();
    const idx = base.lastIndexOf('.');
    return (idx > 0 ? base.slice(0, idx) : base).trim() || '未命名素材';
}

// ========== 操作日志 ==========
// 将前端用户操作上报到后端写入日志文件
// API 生成状态（提前声明，供 api() 函数引用）
let apiGenerateState = { running: false, taskId: null, pollTimer: null, cancelled: false, abortController: null };
// 多图列队模式下每个队列独立的生成状态
let queueGenerateStates = Array.from({length: 10}, () => ({ running: false, cancelled: false, abortController: null }));
// 判断是否有任何队列正在生成
function isAnyQueueGenerating() {
    return queueGenerateStates.some(s => s.running) || apiGenerateState.running;
}
// API提示词语言：'en'=用英文, 'cn'=用中文（从localStorage恢复）
let apiPromptLang = localStorage.getItem('apiPromptLang') || 'en';

// ========== 撤销系统（Ctrl+Z / Cmd+Z）==========
const MAX_UNDO_STEPS = 10;
const DEFAULT_DOWNLOAD_PATH_FALLBACK = '~/Downloads/AI生图/';
let undoStack = [];
let _undoEnabled = true; // 可临时禁用（恢复快照时）
let _undoLastSnapshot = null;
let _undoLastDigest = '';
let _undoManualCheckpointPending = false;
let _undoTextEditActiveEl = null;

function deepClone(obj) {
    try { return structuredClone(obj); } catch (e) { return JSON.parse(JSON.stringify(obj)); }
}

function cleanDownloadPath(path) {
    return typeof path === 'string' ? path.trim() : '';
}

function getGlobalDownloadPath() {
    return cleanDownloadPath(state.modelConfig?.rh_download_path) || DEFAULT_DOWNLOAD_PATH_FALLBACK;
}

function getEffectiveQueueDownloadPath(qi = activeQueue) {
    const ownPath = cleanDownloadPath(queueData[qi]?.downloadPath);
    return ownPath || getGlobalDownloadPath();
}

function getEffectiveSplitDownloadPath(qi = activeSplitQueue) {
    const ownPath = cleanDownloadPath(splitQueueData[qi]?.downloadPath);
    return ownPath || getGlobalDownloadPath();
}

function writeDownloadPathInputFromOwner(inputId, ownerPath) {
    const el = document.getElementById(inputId);
    if (!el) return;
    const ownPath = cleanDownloadPath(ownerPath);
    el.value = ownPath || getGlobalDownloadPath();
    el.dataset.downloadPathInherited = ownPath ? '0' : '1';
}

function readDownloadPathInputForOwner(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return '';
    const value = cleanDownloadPath(el.value);
    if (!value) return '';
    if (el.dataset.downloadPathInherited === '1' && value === getGlobalDownloadPath()) {
        return '';
    }
    return value;
}

function markDownloadPathInputAsOwn(inputId, path) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.value = cleanDownloadPath(path);
    el.dataset.downloadPathInherited = '0';
}

function undoJson(value, fallback) {
    if (value === undefined) return fallback;
    try { return deepClone(value); } catch (_) { return fallback; }
}

function undoSetToArray(value) {
    try { return Array.from(value || []); } catch (_) { return []; }
}

function getUndoSelectedItemIds() {
    const ids = [];
    const selectedItems = state.selectedItems || {};
    for (const value of Object.values(selectedItems)) {
        if (Array.isArray(value)) ids.push(...value);
        else if (value) ids.push(value);
    }
    return ids;
}

function captureUndoFormValues() {
    const values = {};
    document.querySelectorAll('input, textarea, select').forEach((el) => {
        if (!el.id || el.type === 'file') return;
        if (el.type === 'checkbox' || el.type === 'radio') values[el.id] = !!el.checked;
        else values[el.id] = el.value;
    });
    return values;
}

function restoreUndoFormValues(values = {}) {
    for (const [id, value] of Object.entries(values)) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.type === 'file') continue;
        if (el.type === 'checkbox' || el.type === 'radio') el.checked = !!value;
        else el.value = value == null ? '' : String(value);
    }
}

function getQueueDataForUndo() {
    const queues = undoJson(queueData, []);
    const q = queues?.[activeQueue];
    if (q && queueMode === 'multi') {
        q.slots = undoJson(imageState.slots, []);
        q.promptCn = document.getElementById('img-prompt-cn')?.value || '';
        q.promptEn = document.getElementById('img-prompt-en')?.value || '';
        q.selectedPrefixIds = undoSetToArray(selectedPrefixIds);
        q.selectedSuffixIds = undoSetToArray(selectedSuffixIds);
        q.activePromptPresetIds = undoSetToArray(activePromptPresetIds);
        q.promptedSlotIndices = undoSetToArray(promptedSlotIndices);
        q.pinnedSlotIndices = undoSetToArray(pinnedSlotIndices);
        q.prevPromptCn = prevPromptCn || '';
        q.lastAutoPrompt = lastAutoPrompt || '';
        q.promptLang = apiPromptLang || 'en';
        q.activePrefix = activePrefix || '请参考';
    }
    return queues;
}

function getSplitQueueDataForUndo() {
    const queues = undoJson(splitQueueData, []);
    const qd = queues?.[activeSplitQueue];
    const promptEl = document.getElementById('split-prompt-cn');
    const activeItem = qd?.workItems?.[qd.activeItemIndex || 0];
    if (qd && promptEl) {
        qd.promptCn = promptEl.value || '';
        if (activeItem) activeItem.promptCn = promptEl.value || '';
        const mat = qd.materials?.[qd.activeMaterialIndex || 0];
        const matItem = mat?.workItems?.find(it => it?.number === activeItem?.number);
        if (matItem) matItem.promptCn = promptEl.value || '';
    }
    return queues;
}

function getGlobalUndoSnapshot() {
    return {
        currentMode,
        formValues: captureUndoFormValues(),
        promptMode: {
            preview: document.getElementById('prompt-preview')?.value || '',
            resultText: document.getElementById('prompt-text')?.value || '',
            resultVisible: document.getElementById('prompt-result')?.style.display || ''
        },
        stateData: {
            categories: undoJson(state.categories, []),
            prefixes: undoJson(state.prefixes, []),
            suffixes: undoJson(state.suffixes, []),
            props: undoJson(state.props, []),
            presets: undoJson(state.presets, []),
            presetTags: undoJson(state.presetTags, []),
            categoryOrder: undoJson(state.categoryOrder, []),
            propOrder: undoJson(state.propOrder, []),
            selectedPrefixes: undoJson(state.selectedPrefixes, []),
            selectedSuffixes: undoJson(state.selectedSuffixes, []),
            selectedItems: undoJson(state.selectedItems, {}),
            generatedPrompt: state.generatedPrompt || '',
            generatedSource: state.generatedSource || ''
        },
        imageState: undoJson(imageState, {}),
        queueData: getQueueDataForUndo(),
        queueMode,
        activeQueue,
        splitQueueData: getSplitQueueDataForUndo(),
        activeSplitQueue,
        splitModeLoaded,
        vars: {
            promptedSlotIndices: undoSetToArray(promptedSlotIndices),
            pinnedSlotIndices: undoSetToArray(pinnedSlotIndices),
            selectedPrefixIds: undoSetToArray(selectedPrefixIds),
            selectedSuffixIds: undoSetToArray(selectedSuffixIds),
            activePromptPresetIds: undoSetToArray(activePromptPresetIds),
            lastAutoPrompt: lastAutoPrompt || '',
            prevPromptCn: prevPromptCn || '',
            apiPromptLang: apiPromptLang || 'en',
            activePrefix: activePrefix || '请参考',
            promptTemplates: undoJson(promptTemplates, { prefixes: [], suffixes: [] }),
            promptPresets: undoJson(promptPresets, []),
            prefixTemplates: undoJson(prefixTemplates, [])
        }
    };
}

function getUndoDigest(snapshot) {
    try { return JSON.stringify(snapshot); } catch (_) { return String(Date.now()); }
}

function setUndoBaseline(snapshot = getGlobalUndoSnapshot()) {
    _undoLastSnapshot = undoJson(snapshot, null);
    _undoLastDigest = _undoLastSnapshot ? getUndoDigest(_undoLastSnapshot) : '';
}

function pushUndoSnapshot() {
    if (!_undoEnabled) return;
    const snapshot = getGlobalUndoSnapshot();
    const digest = getUndoDigest(snapshot);
    const lastStackDigest = undoStack.length ? getUndoDigest(undoStack[undoStack.length - 1]) : '';
    if (digest === lastStackDigest) return;
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
    _undoManualCheckpointPending = true;
    updateUndoUI();
}

function syncUndoBaselineAfterMutation() {
    if (!_undoEnabled) return;
    const current = getGlobalUndoSnapshot();
    const currentDigest = getUndoDigest(current);
    if (!_undoLastSnapshot) {
        setUndoBaseline(current);
        return;
    }
    if (_undoManualCheckpointPending) {
        setUndoBaseline(current);
        _undoManualCheckpointPending = false;
        return;
    }
    if (currentDigest !== _undoLastDigest) {
        const lastStackDigest = undoStack.length ? getUndoDigest(undoStack[undoStack.length - 1]) : '';
        if (_undoLastDigest && _undoLastDigest !== lastStackDigest) {
            undoStack.push(undoJson(_undoLastSnapshot, {}));
            if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
        }
        setUndoBaseline(current);
        updateUndoUI();
    }
}

function applyUndoModeVisibility(mode) {
    currentMode = mode || 'prompt';
    try { localStorage.setItem('app-mode', currentMode); } catch(e) {}
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === currentMode);
    });
    const promptMode = document.querySelector('.main-content:not(#image-mode):not(#split-mode)');
    const imageMode = document.getElementById('image-mode');
    const splitModeEl = document.getElementById('split-mode');
    if (promptMode) promptMode.style.display = currentMode === 'prompt' ? 'flex' : 'none';
    if (imageMode) imageMode.style.display = currentMode === 'image' ? 'flex' : 'none';
    if (splitModeEl) splitModeEl.style.display = currentMode === 'split' ? 'flex' : 'none';
}

function buildUndoPersistPayload(snapshot) {
    const sd = snapshot.stateData || {};
    return {
        files: {
            'categories.json': { categories: sd.categories || [] },
            'prefixes.json': { prefixes: sd.prefixes || [] },
            'suffixes.json': { suffixes: sd.suffixes || [] },
            'props.json': { props: sd.props || [] },
            'presets.json': { presets: sd.presets || [] },
            'preset_tags.json': { tags: sd.presetTags || [] },
            'category_order.json': { order: sd.categoryOrder || [] },
            'prop_order.json': { order: sd.propOrder || [] },
            'last_selection.json': {
                selected_prefixes: sd.selectedPrefixes || [],
                selected_suffixes: sd.selectedSuffixes || [],
                selected_items: getUndoSelectedItemIds()
            },
            'queue_data.json': {
                queues: snapshot.queueData || [],
                activeQueue: snapshot.activeQueue || 0,
                queueMode: snapshot.queueMode || 'same',
                slots: snapshot.queueMode === 'same' ? (snapshot.imageState?.slots || []) : []
            },
            'split_queue_data.json': {
                queues: snapshot.splitQueueData || [],
                activeQueue: snapshot.activeSplitQueue || 0
            },
            'image_library.json': { categories: snapshot.imageState?.library || [] },
            'image_presets.json': { presets: snapshot.imageState?.presets || [] },
            'prompt_templates.json': snapshot.vars?.promptTemplates || { prefixes: [], suffixes: [], selectedPrefixIds: [], selectedSuffixIds: [] },
            'prompt_presets.json': { presets: snapshot.vars?.promptPresets || [] },
            'prefix_templates.json': { templates: snapshot.vars?.prefixTemplates || [] }
        }
    };
}

async function persistUndoSnapshot(snapshot) {
    try {
        await api('PUT', '/api/undo-state', buildUndoPersistPayload(snapshot), 60000, undefined, true);
    } catch (e) {
        console.error('持久化撤销状态失败:', e);
        showToast('已恢复界面，但写回数据失败：' + e.message, 'warning');
    }
}

async function undo() {
    if (undoStack.length === 0) return;
    const snapshot = undoStack.pop();
    _undoEnabled = false;
    try {
        const sd = snapshot.stateData || {};
        state.categories = undoJson(sd.categories, []);
        state.prefixes = undoJson(sd.prefixes, []);
        state.suffixes = undoJson(sd.suffixes, []);
        state.props = undoJson(sd.props, []);
        state.presets = undoJson(sd.presets, []);
        state.presetTags = undoJson(sd.presetTags, [...DEFAULT_PRESET_TAGS]);
        state.categoryOrder = undoJson(sd.categoryOrder, []);
        state.propOrder = undoJson(sd.propOrder, []);
        state.selectedItems = undoJson(sd.selectedItems, {});
        state.selectedPrefixes = undoJson(sd.selectedPrefixes, []);
        state.selectedSuffixes = undoJson(sd.selectedSuffixes, []);
        state.generatedPrompt = sd.generatedPrompt || '';
        state.generatedSource = sd.generatedSource || '';

        Object.assign(imageState, undoJson(snapshot.imageState, {}));
        queueData = undoJson(snapshot.queueData, []);
        activeQueue = snapshot.activeQueue || 0;
        queueMode = snapshot.queueMode || 'same';
        splitQueueData = undoJson(snapshot.splitQueueData, []);
        activeSplitQueue = snapshot.activeSplitQueue || 0;
        splitModeLoaded = !!snapshot.splitModeLoaded;

        const vars = snapshot.vars || {};
        promptedSlotIndices = new Set(vars.promptedSlotIndices || []);
        pinnedSlotIndices = new Set(vars.pinnedSlotIndices || []);
        selectedPrefixIds = new Set(vars.selectedPrefixIds || []);
        selectedSuffixIds = new Set(vars.selectedSuffixIds || []);
        activePromptPresetIds = new Set(vars.activePromptPresetIds || []);
        lastAutoPrompt = vars.lastAutoPrompt || '';
        prevPromptCn = vars.prevPromptCn || '';
        apiPromptLang = vars.apiPromptLang || 'en';
        activePrefix = vars.activePrefix || '请参考';
        promptTemplates = undoJson(vars.promptTemplates, { prefixes: [], suffixes: [] });
        promptPresets = undoJson(vars.promptPresets, []);
        prefixTemplates = undoJson(vars.prefixTemplates, prefixTemplates || []);

        initQueueData();
        initSplitQueueData();
        applyUndoModeVisibility(snapshot.currentMode);
        renderAll();
        if (queueMode === 'multi') loadQueueData(activeQueue);
        else renderImageSlots();
        if (imageState.loaded) renderImageMode();
        renderQueueNumberBars();
        if (typeof normalizeSplitQueueWorkItems === 'function') normalizeSplitQueueWorkItems();
        if (typeof renderSplitQueueNumberBar === 'function') renderSplitQueueNumberBar();
        if (typeof renderSplitMaterialTabs === 'function') renderSplitMaterialTabs(activeSplitQueue);
        if (typeof renderSplitWorkItemTabs === 'function') renderSplitWorkItemTabs(activeSplitQueue);
        if (typeof loadSplitQueueToUI === 'function') loadSplitQueueToUI(activeSplitQueue);
        if (typeof renderSplitQueueResults === 'function') renderSplitQueueResults(activeSplitQueue);
        restoreUndoFormValues(snapshot.formValues);
        const promptResult = document.getElementById('prompt-result');
        if (promptResult) promptResult.style.display = snapshot.promptMode?.resultVisible || '';
        updateGenerateButtons();
        updateGenerateBtnText();
        document.querySelectorAll('.queue-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.queueMode === queueMode);
        });
        const batchBtn = document.getElementById('btn-api-batch-generate');
        if (batchBtn) batchBtn.style.display = queueMode === 'multi' ? 'inline-flex' : 'none';

        showToast(`已撤销（剩余${undoStack.length}步）`, 'info');
        setUndoBaseline(snapshot);
        await persistUndoSnapshot(snapshot);
    } finally {
        _undoEnabled = true;
        _undoManualCheckpointPending = false;
    }
    updateUndoUI();
}

function updateUndoUI() {
    const indicator = document.getElementById('undo-indicator');
    if (indicator) {
        indicator.textContent = undoStack.length > 0 ? `可撤销 ${undoStack.length} 步` : '';
        indicator.style.opacity = undoStack.length > 0 ? '1' : '0';
    }
}

// 键盘监听
document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
    }
});

document.addEventListener('beforeinput', (e) => {
    const el = e.target;
    if (!_undoEnabled || !el || !el.matches?.('input:not([type="file"]), textarea')) return;
    if (_undoTextEditActiveEl !== el) {
        pushUndoSnapshot();
        _undoTextEditActiveEl = el;
    }
}, true);

document.addEventListener('focusout', () => {
    _undoTextEditActiveEl = null;
    syncUndoBaselineAfterMutation();
}, true);

document.addEventListener('change', (e) => {
    const el = e.target;
    if (!_undoEnabled || !el || !el.matches?.('select, input[type="checkbox"], input[type="radio"], input[type="range"]')) return;
    pushUndoSnapshot();
}, true);

document.addEventListener('click', (e) => {
    const target = e.target.closest?.('button, .context-menu-item, [role="menuitem"]');
    if (!_undoEnabled || !target) return;
    const text = `${target.id || ''} ${target.className || ''} ${target.title || ''} ${target.textContent || ''}`;
    if (/复制|copy|关闭|cancel|刷新诊断|检查更新|图库|导出|导入/.test(text)) return;
    if (/删除|清除|清空|重置|保存|添加|上传|应用|替换|生成|队列|拆图|preset|template|delete|clear|reset|save|add|upload|apply|generate|queue/i.test(text)) {
        pushUndoSnapshot();
    }
}, true);

// API提示词语言切换按钮
document.getElementById('btn-api-prompt-lang')?.addEventListener('click', () => {
    apiPromptLang = apiPromptLang === 'en' ? 'cn' : 'en';
    localStorage.setItem('apiPromptLang', apiPromptLang);
    const btn = document.getElementById('btn-api-prompt-lang');
    if (apiPromptLang === 'cn') {
        btn.textContent = '使用中文提示词';
        btn.style.color = '#22c55e';
        btn.style.borderColor = '#22c55e';
        btn.title = '当前：使用中文提示词提交API（点击切换为英文）';
    } else {
        btn.textContent = '使用英文提示词';
        btn.style.color = '#f59e0b';
        btn.style.borderColor = '#f59e0b';
        btn.title = '当前：使用英文提示词提交API（点击切换为中文）';
    }
    logAction('config', '切换API提示词语言', { lang: apiPromptLang });
});
// 恢复初始按钮状态
(() => {
    const btn = document.getElementById('btn-api-prompt-lang');
    if (!btn) return;
    if (apiPromptLang === 'cn') {
        btn.textContent = '使用中文提示词';
        btn.style.color = '#22c55e';
        btn.style.borderColor = '#22c55e';
        btn.title = '当前：使用中文提示词提交API（点击切换为英文）';
    }
})();
const _logQueue = [];
let _logSending = false;

function logAction(action, msg, detail = {}) {
    // 异步批量上报，不阻塞主流程
    _logQueue.push({ action, msg, detail, ts: Date.now() });
    if (!_logSending) _flushLogQueue();
}

async function _flushLogQueue() {
    if (_logSending || _logQueue.length === 0) return;
    _logSending = true;
    // 取出当前队列中的所有条目
    const batch = _logQueue.splice(0, _logQueue.length);
    try {
        // 逐条发送（简单可靠）
        for (const item of batch) {
            await fetch('/api/log-action', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(item)
            }).catch(() => {}); // 静默失败，不影响用户体验
        }
    } finally {
        _logSending = false;
        // 如果在发送期间又积累了新条目，继续发送
        if (_logQueue.length > 0) _flushLogQueue();
    }
}

// 全局错误捕获
window.addEventListener('error', (e) => {
    logAction('error', 'JS运行错误', { msg: e.message, file: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
    logAction('error', 'Promise未处理拒绝', { reason: String(e.reason) });
});

function showToast(msg, type = 'info') {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    const duration = type === 'error' ? 5000 : 2500;
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transition = 'opacity 0.3s';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'flex';
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'none';
    if (id === 'modal-crop') { cropQueue = []; cropQueueActive = false; updateCropProgress(); }
}

function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ========== 数据加载 ==========
async function loadAllData() {
    try {
        const [cats, prefs, suffs, propsData, pres, config, lastSel, orderData, propOrderData, tagsData, queueDataResp] = await Promise.all([
            api('GET', '/api/categories'),
            api('GET', '/api/prefixes'),
            api('GET', '/api/suffixes'),
            api('GET', '/api/props'),
            api('GET', '/api/presets'),
            api('GET', '/api/model-config'),
            api('GET', '/api/last-selection'),
            api('GET', '/api/category-order'),
            api('GET', '/api/prop-order'),
            api('GET', '/api/preset-tags'),
            api('GET', '/api/queue-data')
        ]);

        state.categories = cats.categories || [];
        state.prefixes = prefs.prefixes || [];
        state.suffixes = suffs.suffixes || [];
        state.props = propsData.props || [];
        state.presets = pres.presets || [];
        state.presetTags = tagsData.tags || [...DEFAULT_PRESET_TAGS];
        state.modelConfig = config || {};
        state.categoryOrder = orderData.order || [];
        state.propOrder = propOrderData.order || [];

        ensureOrderIntegrity();
        ensurePropOrderIntegrity();

        // 恢复队列数据（从服务端）
        const serverHasQueueData = queueDataResp && (
            (Array.isArray(queueDataResp.queues) && queueDataResp.queues.length > 0) ||
            (Array.isArray(queueDataResp.slots) && queueDataResp.slots.length > 0)
        );
        if (serverHasQueueData) {
            if (Array.isArray(queueDataResp.queues) && queueDataResp.queues.length > 0) {
                queueData = queueDataResp.queues;
                for (let q = 0; q < queueData.length; q++) {
                    if (!queueData[q].slots) queueData[q].slots = [];
                    while (queueData[q].slots.length < SLOT_COUNT) {
                        queueData[q].slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
                    }
                    if (!queueData[q].promptCn) queueData[q].promptCn = '';
                    if (!queueData[q].promptEn) queueData[q].promptEn = '';
                    if (!Array.isArray(queueData[q].results)) queueData[q].results = [];
                }
            }
            if (queueDataResp.queueMode) queueMode = queueDataResp.queueMode;
            if (typeof queueDataResp.activeQueue === 'number') activeQueue = queueDataResp.activeQueue;
            // 同图抽卡模式下恢复 slots
            if (queueMode === 'same' && Array.isArray(queueDataResp.slots) && queueDataResp.slots.length > 0) {
                imageState.slots = queueDataResp.slots;
            }
        } else {
            // 一次性迁移：服务端无数据时从 localStorage 迁移
            try {
                const savedQD = localStorage.getItem('queue-data');
                if (savedQD) {
                    const parsed = JSON.parse(savedQD);
                    if (Array.isArray(parsed) && parsed.length > 0) queueData = parsed;
                }
                const savedQM = localStorage.getItem('queue-mode');
                if (savedQM) queueMode = savedQM;
                const savedAQ = localStorage.getItem('active-queue');
                if (savedAQ) activeQueue = parseInt(savedAQ, 10) || 0;
                const savedSlots = localStorage.getItem('image-slots');
                if (savedSlots) {
                    const parsed = JSON.parse(savedSlots);
                    if (Array.isArray(parsed) && parsed.length > 0) imageState.slots = parsed;
                }
                // 迁移完成后保存到服务端
                saveQueueData();
                // 清除 localStorage 中的旧数据
                localStorage.removeItem('queue-data');
                localStorage.removeItem('queue-mode');
                localStorage.removeItem('active-queue');
                localStorage.removeItem('image-slots');
            } catch(e) {}
        }
        // 确保有10个队列
        while (queueData.length < QUEUE_COUNT) {
            queueData.push({
                slots: Array.from({length: SLOT_COUNT}, () => ({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' })),
                promptCn: '',
                promptEn: ''
            });
        }

        // 恢复道具缩放设置
        try {
            const savedZoom = localStorage.getItem('prop-zoom');
            if (savedZoom) state.propZoom = JSON.parse(savedZoom);
        } catch(e) {}

        // 恢复预设缩放设置
        try {
            const savedPresetZoom = localStorage.getItem('preset-zoom');
            if (savedPresetZoom) state.presetZoom = parseInt(savedPresetZoom, 10) || 4;
        } catch(e) {}

        if (lastSel) restoreSelection(lastSel);

        // 如果当前提示词为空，清除词库选中状态（避免UI高亮残留）
        const currentPromptCn = queueMode === 'multi' ? queueData[activeQueue]?.promptCn : imageState.promptCn;
        const currentPromptEn = queueMode === 'multi' ? queueData[activeQueue]?.promptEn : imageState.promptEn;
        if (!currentPromptCn && !currentPromptEn) {
            state.selectedPrefixes = [];
            state.selectedSuffixes = [];
            state.selectedItems = {};
            saveSelection();
        }

        renderAll();

        // 恢复平台选择状态（始终调用，确保UI与下拉框一致）
        const platformSelect = document.getElementById('cfg-api-platform');
        if (platformSelect) {
            if (state.modelConfig.api_platform) {
                platformSelect.value = state.modelConfig.api_platform;
            }
            togglePlatformUI(platformSelect.value);
        }

        // 恢复RH内联模型选择 + 宽高比
        if (state.modelConfig.rh_model) {
            const inlineModel = document.getElementById('cfg-rh-model-inline');
            if (inlineModel) {
                inlineModel.value = state.modelConfig.rh_model;
                updateRhModelParamsInline();
            }
        }
        // 恢复RH宽高比选中值
        if (state.modelConfig.rh_aspect_ratio) {
            const arSelect = document.getElementById('cfg-rh-aspect-ratio-inline');
            if (arSelect) arSelect.value = state.modelConfig.rh_aspect_ratio;
        }
        // 恢复HK内联模型选择
        if (state.modelConfig.oaihk_model) {
            const hkModel = document.getElementById('cfg-oaihk-model-inline');
            if (hkModel) {
                hkModel.value = state.modelConfig.oaihk_model;
                updateOaihkModelParamsInline();
            }
        }
    } catch (e) {
        console.error('加载数据失败:', e);
        showToast('加载数据失败', 'error');
    }
}

function ensureOrderIntegrity() {
    const existingKeys = new Set(state.categoryOrder.map(o => o.type + ':' + o.id));
    for (const cat of state.categories) {
        const key = 'category:' + cat.id;
        if (!existingKeys.has(key)) { state.categoryOrder.push({ type: 'category', id: cat.id }); existingKeys.add(key); }
    }
    if (!existingKeys.has('prefix:prefix')) state.categoryOrder.push({ type: 'prefix', id: 'prefix' });
    if (!existingKeys.has('suffix:suffix')) state.categoryOrder.push({ type: 'suffix', id: 'suffix' });

    const validKeys = new Set();
    for (const cat of state.categories) validKeys.add('category:' + cat.id);
    validKeys.add('prefix:prefix');
    validKeys.add('suffix:suffix');
    state.categoryOrder = state.categoryOrder.filter(o => validKeys.has(o.type + ':' + o.id));
}

function ensurePropOrderIntegrity() {
    const existingIds = new Set(state.propOrder.map(o => o.id));
    for (const prop of state.props) {
        if (!existingIds.has(prop.id)) { state.propOrder.push({ id: prop.id }); existingIds.add(prop.id); }
    }
    const validIds = new Set(state.props.map(p => p.id));
    state.propOrder = state.propOrder.filter(o => validIds.has(o.id));
}

function getOrderedProps() {
    // 按 propOrder 排序，未在 order 中的追加到末尾
    const ordered = [];
    const added = new Set();
    for (const o of state.propOrder) {
        const prop = state.props.find(p => p.id === o.id);
        if (prop) { ordered.push(prop); added.add(prop.id); }
    }
    for (const prop of state.props) {
        if (!added.has(prop.id)) ordered.push(prop);
    }
    return ordered;
}

function restoreSelection(lastSel) {
    state.selectedPrefixes = lastSel.selected_prefixes || [];
    state.selectedSuffixes = lastSel.selected_suffixes || [];
    state.selectedItems = {};
    const selectedItemIds = lastSel.selected_items || [];
    for (const cat of state.categories) {
        const catId = cat.id;
        const isMultiple = cat.selection_type === 'multiple';
        for (const item of cat.items) {
            if (selectedItemIds.includes(item.id)) {
                if (isMultiple) {
                    if (!state.selectedItems[catId]) state.selectedItems[catId] = [];
                    state.selectedItems[catId].push(item.id);
                } else {
                    state.selectedItems[catId] = item.id;
                }
            }
        }
    }
}

// ========== 渲染 ==========
function renderAll() {
    renderCategoryList();
    renderPropPanel();
    renderPresets();
    updatePreview();
    updateGenerateButtons();
}

// ========== 左侧：词库配置 ==========
function renderCategoryList() {
    const container = $('#config-body');
    container.innerHTML = '';

    for (const orderItem of state.categoryOrder) {
        const key = orderItem.type + ':' + orderItem.id;
        if (orderItem.type === 'category') {
            const cat = state.categories.find(c => c.id === orderItem.id);
            if (cat) renderCategoryBlock(container, cat, key);
        } else if (orderItem.type === 'prefix') {
            renderExtraBlock(container, '前缀', state.prefixes, 'prefix', key);
        } else if (orderItem.type === 'suffix') {
            renderExtraBlock(container, '后缀', state.suffixes, 'suffix', key);
        }
    }
    initCategoryDragSort();
}

function renderCategoryBlock(container, cat, key) {
    const isExpanded = state.expandedCategory === key;
    const isMultiple = cat.selection_type === 'multiple';
    const catEl = document.createElement('div');
    catEl.className = 'category-item';
    catEl.dataset.orderKey = key;

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
        <span class="drag-handle" title="拖拽排序">⠿</span>
        <span class="category-arrow ${isExpanded ? 'expanded' : ''}">▶</span>
        <span class="category-name">${escHtml(cat.name)}</span>
        <span class="category-summary">${getCategorySummary(cat)}</span>
        <div class="category-actions">
            <button class="btn-icon edit-cat" title="编辑">✎</button>
            <button class="btn-icon danger delete-cat" title="删除">×</button>
        </div>
    `;
    header.addEventListener('click', (e) => {
        if (e.target.closest('.drag-handle')) return;
        if (e.target.closest('.edit-cat')) { e.stopPropagation(); editCategory(cat); return; }
        if (e.target.closest('.delete-cat')) { e.stopPropagation(); deleteCategory(cat); return; }
        toggleCategory(key);
    });

    const body = document.createElement('div');
    body.className = `category-body ${isExpanded ? 'expanded' : ''}`;
    for (const item of cat.items) {
        const isSelected = isItemSelected(cat.id, item.id, isMultiple);
        const itemEl = document.createElement('div');
        itemEl.className = 'option-item';
        itemEl.innerHTML = `
            <span class="${isMultiple ? 'option-checkbox' : 'option-radio'} ${isSelected ? 'selected' : ''}"></span>
            <span class="option-name">${escHtml(item.name)}</span>
            <div class="option-actions">
                <button class="btn-icon edit-item" title="编辑">✎</button>
                <button class="btn-icon danger delete-item" title="删除">×</button>
            </div>
        `;
        itemEl.addEventListener('click', (e) => {
            if (e.target.closest('.edit-item')) { e.stopPropagation(); editItem(cat, item); return; }
            if (e.target.closest('.delete-item')) { e.stopPropagation(); deleteItem(cat, item); return; }
            selectItem(cat.id, item.id, isMultiple);
        });
        body.appendChild(itemEl);
    }
    const addRow = document.createElement('div');
    addRow.className = 'add-item-row';
    addRow.textContent = '+ 添加';
    addRow.addEventListener('click', () => addItem(cat));
    body.appendChild(addRow);

    catEl.appendChild(header);
    catEl.appendChild(body);
    container.appendChild(catEl);
}

function renderExtraBlock(container, name, items, type, key) {
    const isExpanded = state.expandedCategory === key;
    const catEl = document.createElement('div');
    catEl.className = 'category-item';
    catEl.dataset.orderKey = key;

    const header = document.createElement('div');
    header.className = 'category-header';
    header.innerHTML = `
        <span class="drag-handle" title="拖拽排序">⠿</span>
        <span class="category-arrow ${isExpanded ? 'expanded' : ''}">▶</span>
        <span class="category-name">${escHtml(name)}</span>
        <span class="category-summary">${getExtraSummary(type)}</span>
        <div class="category-actions">
            <button class="btn-icon add-extra" title="新增">+</button>
        </div>
    `;
    header.addEventListener('click', (e) => {
        if (e.target.closest('.drag-handle')) return;
        if (e.target.closest('.add-extra')) { e.stopPropagation(); addExtraItem(type, name); return; }
        toggleCategory(key);
    });

    const body = document.createElement('div');
    body.className = `category-body ${isExpanded ? 'expanded' : ''}`;
    const selectedList = type === 'prefix' ? state.selectedPrefixes : state.selectedSuffixes;
    for (const item of items) {
        const isSelected = selectedList.includes(item.id);
        const itemEl = document.createElement('div');
        itemEl.className = 'option-item';
        itemEl.innerHTML = `
            <span class="option-checkbox ${isSelected ? 'selected' : ''}"></span>
            <span class="option-name">${escHtml(item.name)}</span>
            <div class="option-actions">
                <button class="btn-icon edit-extra" title="编辑">✎</button>
                <button class="btn-icon danger delete-extra" title="删除">×</button>
            </div>
        `;
        itemEl.addEventListener('click', (e) => {
            if (e.target.closest('.edit-extra')) { e.stopPropagation(); editExtraItem(type, item); return; }
            if (e.target.closest('.delete-extra')) { e.stopPropagation(); deleteExtraItem(type, item); return; }
            toggleExtraSelection(type, item.id);
        });
        body.appendChild(itemEl);
    }
    const addRow = document.createElement('div');
    addRow.className = 'add-item-row';
    addRow.textContent = '+ 添加';
    addRow.addEventListener('click', () => addExtraItem(type, name));
    body.appendChild(addRow);

    catEl.appendChild(header);
    catEl.appendChild(body);
    container.appendChild(catEl);
}

// ========== 右侧：道具面板 ==========
function renderPropPanel() {
    const container = $('#prop-panel-body');
    container.innerHTML = '';

    const keyword = state.propSearchKeyword.trim().toLowerCase();

    if (state.props.length === 0) {
        container.innerHTML = '<p class="empty-hint">点击上方按钮添加道具分类</p>';
        return;
    }

    const orderedProps = getOrderedProps();

    // 搜索模式：跨分类显示匹配项
    if (keyword) {
        const resultsEl = document.createElement('div');
        resultsEl.className = 'prop-search-results';
        let hasResult = false;

        for (const prop of orderedProps) {
            const sortedItems = [...prop.items].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
            const matched = sortedItems.filter(item => item.name.toLowerCase().includes(keyword));
            if (matched.length === 0) continue;
            hasResult = true;

            const label = document.createElement('div');
            label.style.cssText = 'font-size:10px;color:var(--text-muted);padding:4px 6px 2px;';
            label.textContent = `${prop.name} (${matched.length})`;
            resultsEl.appendChild(label);

            const cols = state.propZoom[prop.id] || 2;
            const grid = document.createElement('div');
            grid.className = 'prop-items-grid';
            grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
            for (const item of matched) {
                grid.appendChild(createPropCard(prop, item));
            }
            resultsEl.appendChild(grid);
        }

        if (!hasResult) {
            container.innerHTML = '<p class="empty-hint">没有找到匹配的道具</p>';
        } else {
            container.appendChild(resultsEl);
        }
        return;
    }

    // 正常模式：按分类显示
    for (const prop of orderedProps) {
        const isExpanded = state.expandedProp === prop.id;
        const catEl = document.createElement('div');
        catEl.className = 'prop-category';
        catEl.dataset.propId = prop.id;

        const header = document.createElement('div');
        header.className = 'prop-category-header';
        header.innerHTML = `
            <span class="drag-handle" title="拖拽排序" style="cursor:grab;font-size:10px;opacity:0.3;padding:0 2px;">⠿</span>
            <span class="category-arrow ${isExpanded ? 'expanded' : ''}" style="font-size:7px;">▶</span>
            <span class="prop-category-name">${escHtml(prop.name)}</span>
            <span class="prop-category-count">${prop.items.length}</span>
            <div class="prop-category-actions">
                <button class="btn-icon edit-prop" title="编辑">✎</button>
                <button class="btn-icon danger delete-prop" title="删除">×</button>
            </div>
        `;
        header.addEventListener('click', (e) => {
            if (e.target.closest('.drag-handle')) return;
            if (e.target.closest('.edit-prop')) { e.stopPropagation(); editPropCategory(prop); return; }
            if (e.target.closest('.delete-prop')) { e.stopPropagation(); deletePropCategory(prop); return; }
            state.expandedProp = state.expandedProp === prop.id ? null : prop.id;
            renderPropPanel();
        });

        const body = document.createElement('div');
        body.className = `prop-category-body ${isExpanded ? 'expanded' : ''}`;

        // 缩放滑杆
        const cols = state.propZoom[prop.id] || 2;
        const zoomRow = document.createElement('div');
        zoomRow.className = 'prop-zoom-row';
        zoomRow.innerHTML = `
            <span class="prop-zoom-label">大</span>
            <input type="range" min="1" max="5" step="1" value="${cols}" data-prop-id="${prop.id}">
            <span class="prop-zoom-label">小</span>
        `;
        const rangeInput = zoomRow.querySelector('input[type="range"]');
        rangeInput.addEventListener('input', (e) => {
            e.stopPropagation();
            const newCols = parseInt(e.target.value, 10);
            state.propZoom[prop.id] = newCols;
            grid.style.gridTemplateColumns = `repeat(${newCols}, 1fr)`;
            // 保存到 localStorage
            try { localStorage.setItem('prop-zoom', JSON.stringify(state.propZoom)); } catch(err) {}
        });
        // 阻止滑杆点击触发展开/折叠
        zoomRow.addEventListener('click', (e) => e.stopPropagation());
        body.appendChild(zoomRow);

        const grid = document.createElement('div');
        grid.className = 'prop-items-grid';
        grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

        // 按名称排序道具子项
        const sortedItems = [...prop.items].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

        for (const item of sortedItems) {
            grid.appendChild(createPropCard(prop, item));
        }

        const addCard = document.createElement('div');
        addCard.className = 'prop-add-item';
        addCard.innerHTML = '+ 添加';
        addCard.addEventListener('click', () => addPropItem(prop));
        grid.appendChild(addCard);

        body.appendChild(grid);
        catEl.appendChild(header);
        catEl.appendChild(body);
        container.appendChild(catEl);
    }

    initPropDragSort();
}

function createPropCard(prop, item) {
    const card = document.createElement('div');
    card.className = 'prop-item-card';
    card.title = `点击插入"${item.name}"到预览区`;

    const imgHtml = item.image
        ? `<img src="${escHtml(item.image)}" alt="${escHtml(item.name)}" class="prop-item-img">`
        : `<div class="prop-item-no-img">📷</div>`;

    card.innerHTML = `
        ${imgHtml}
        <div class="prop-item-name">${escHtml(item.name)}</div>
        <div class="prop-item-actions">
            <button class="btn-icon upload-prop-img" title="上传图片">🖼</button>
            <button class="btn-icon edit-prop-item" title="编辑">✎</button>
            <button class="btn-icon danger delete-prop-item" title="删除">×</button>
        </div>
    `;

    card.addEventListener('click', (e) => {
        if (e.target.closest('.upload-prop-img')) { e.stopPropagation(); uploadPropImage(prop, item); return; }
        if (e.target.closest('.edit-prop-item')) { e.stopPropagation(); editPropItem(prop, item); return; }
        if (e.target.closest('.delete-prop-item')) { e.stopPropagation(); deletePropItem(prop, item); return; }
        insertToPreview(item.name);
    });

    const imgEl = card.querySelector('.prop-item-img');
    if (imgEl) {
        imgEl.addEventListener('click', (e) => {
            if (e.target.closest('.prop-item-actions')) return;
            e.stopPropagation();
            showImagePreview(item.image);
        });
    }

    return card;
}

// 插入道具名称到预览区光标位置
function insertToPreview(name) {
    const textarea = $('#prompt-preview');
    const text = textarea.value;
    const pos = textarea.selectionStart || text.length;

    let insert = name;
    if (pos > 0 && text[pos - 1] !== '，' && text[pos - 1] !== ',' && text[pos - 1] !== ' ') {
        insert = '，' + name;
    }

    const newText = text.slice(0, pos) + insert + text.slice(pos);
    textarea.value = newText;
    const newPos = pos + insert.length;
    textarea.setSelectionRange(newPos, newPos);
    textarea.focus();
    showToast(`已插入"${name}"`, 'success');
}

// 查看大图
function showImagePreview(url) {
    if (!url) return;
    $('#image-viewer-img').src = url;
    openModal('modal-image-viewer');
}

// ========== 道具搜索 ==========
$('#prop-search-input').addEventListener('input', (e) => {
    state.propSearchKeyword = e.target.value;
    renderPropPanel();
});

// ========== 预设搜索 ==========
$('#preset-search-input').addEventListener('input', (e) => {
    state.presetSearchKeyword = e.target.value;
    renderPresets();
});

// 预设排序
$('#preset-sort-select')?.addEventListener('change', (e) => {
    state.presetSortBy = e.target.value;
    renderPresets();
});

// ========== 直接添加预设按钮 ==========
$('#btn-add-preset-direct').addEventListener('click', () => {
    state.presetCoverUrl = '';
    state.presetEffectUrl = '';
    state.selectedPresetTags = [];
    state._editingPresetId = null;  // 新建模式
    $('#preset-name').value = '';
    // 直接添加时，提示词默认空，让用户手动填
    $('#preset-prompt-text').value = $('#prompt-preview').value || '';

    // 重置封面上传
    const uploadPreview = $('#upload-preview');
    const uploadPlaceholder = $('#upload-placeholder');
    if (uploadPreview) uploadPreview.style.display = 'none';
    if (uploadPlaceholder) uploadPlaceholder.style.display = 'flex';
    // 重置效果图上传
    const uploadPreviewEffect = $('#upload-preview-effect');
    const uploadPlaceholderEffect = $('#upload-placeholder-effect');
    if (uploadPreviewEffect) uploadPreviewEffect.style.display = 'none';
    if (uploadPlaceholderEffect) uploadPlaceholderEffect.style.display = 'flex';

    renderPresetTagList();
    openModal('modal-save-preset');
});

// ========== 中间：生成预览 ==========
function buildLocalPreview() {
    const parts = [];
    for (const orderItem of state.categoryOrder) {
        if (orderItem.type === 'prefix') {
            for (const pid of state.selectedPrefixes) {
                const p = state.prefixes.find(i => i.id === pid);
                if (p) parts.push(p.name);
            }
        } else if (orderItem.type === 'suffix') {
            for (const sid of state.selectedSuffixes) {
                const s = state.suffixes.find(i => i.id === sid);
                if (s) parts.push(s.name);
            }
        } else if (orderItem.type === 'category') {
            const cat = state.categories.find(c => c.id === orderItem.id);
            if (cat) {
                const sel = state.selectedItems[cat.id];
                if (sel) {
                    if (Array.isArray(sel)) {
                        const names = sel.map(id => { const it = cat.items.find(i => i.id === id); return it ? it.name : ''; }).filter(Boolean);
                        if (names.length) parts.push(names.join('，'));
                    } else {
                        const it = cat.items.find(i => i.id === sel);
                        if (it) parts.push(it.name);
                    }
                }
            }
        }
    }
    return parts.join('，');
}

function updatePreview() {
    const textarea = $('#prompt-preview');
    if (!textarea) return;
    const newPreview = buildLocalPreview();
    if (document.activeElement !== textarea) {
        textarea.value = newPreview;
    }
}

function updateGenerateButtons() {
    const previewText = $('#prompt-preview') ? $('#prompt-preview').value.trim() : '';
    const hasContent = previewText.length > 0;
    $('#btn-generate').disabled = !hasContent;
    $('#btn-save-preset').disabled = !hasContent;
}

// ========== 拖拽排序（左侧分类） ==========
let dragState = null;

function initCategoryDragSort() {
    const container = $('#config-body');
    const items = container.querySelectorAll('.category-item');
    items.forEach(item => {
        const handle = item.querySelector('.drag-handle');
        if (!handle) return;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            startDragSort(e, item, container, 'category');
        });
    });
}

// ========== 拖拽排序（道具分类） ==========
function initPropDragSort() {
    const container = $('#prop-panel-body');
    const items = container.querySelectorAll('.prop-category');
    items.forEach(item => {
        const handle = item.querySelector('.drag-handle');
        if (!handle) return;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            startDragSort(e, item, container, 'prop');
        });
    });
}

function startDragSort(e, dragEl, container, type) {
    dragState = { el: dragEl, startX: e.clientX, startY: e.clientY, placeholder: null, type };
    dragEl.classList.add('dragging');
    const placeholder = document.createElement('div');
    placeholder.className = type === 'category' ? 'category-item drag-placeholder' : 'prop-category drag-placeholder';
    placeholder.style.cssText = 'border:2px dashed var(--accent);background:var(--bg);min-height:30px;border-radius:var(--radius-sm);margin-bottom:2px;';
    dragState.placeholder = placeholder;
    dragEl.parentNode.insertBefore(placeholder, dragEl);

    const onMouseMove = (e) => {
        if (!dragState) return;
        const moveY = e.clientY - dragState.startY;
        dragEl.style.transform = `translateY(${moveY}px)`;
        dragEl.style.position = 'relative';
        dragEl.style.zIndex = '100';
        dragEl.style.pointerEvents = 'none';
        const selector = type === 'category' ? '.category-item:not(.dragging)' : '.prop-category:not(.dragging)';
        const siblings = [...container.querySelectorAll(selector)];
        for (const sibling of siblings) {
            const rect = sibling.getBoundingClientRect();
            if (e.clientY < rect.top + rect.height / 2) {
                container.insertBefore(dragState.placeholder, sibling);
                return;
            }
        }
        container.appendChild(dragState.placeholder);
    };

    const onMouseUp = () => {
        if (!dragState) return;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        dragState.placeholder.parentNode.insertBefore(dragEl, dragState.placeholder);
        dragState.placeholder.remove();
        dragEl.classList.remove('dragging');
        dragEl.style.transform = '';
        dragEl.style.position = '';
        dragEl.style.zIndex = '';
        dragEl.style.pointerEvents = '';

        if (dragState.type === 'category') {
            updateOrderFromDOM();
        } else {
            updatePropOrderFromDOM();
        }
        dragState = null;
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}

async function updateOrderFromDOM() {
    const container = $('#config-body');
    const items = container.querySelectorAll('.category-item');
    const newOrder = [];
    items.forEach(el => {
        const key = el.dataset.orderKey;
        if (!key) return;
        const [type, id] = key.split(':');
        newOrder.push({ type, id });
    });
    state.categoryOrder = newOrder;
    try { await api('PUT', '/api/category-order', { order: newOrder }); } catch (e) { console.error('保存排序失败:', e); }
}

async function updatePropOrderFromDOM() {
    const container = $('#prop-panel-body');
    const items = container.querySelectorAll('.prop-category');
    const newOrder = [];
    items.forEach(el => {
        const id = el.dataset.propId;
        if (id) newOrder.push({ id });
    });
    state.propOrder = newOrder;
    try { await api('PUT', '/api/prop-order', { order: newOrder }); } catch (e) { console.error('保存道具排序失败:', e); }
}

// ========== 选择逻辑 ==========
function toggleCategory(key) {
    state.expandedCategory = state.expandedCategory === key ? null : key;
    renderAll();
}

function isItemSelected(catId, itemId, isMultiple) {
    if (isMultiple) return (state.selectedItems[catId] || []).includes(itemId);
    return state.selectedItems[catId] === itemId;
}

function selectItem(catId, itemId, isMultiple) {
    pushUndoSnapshot();
    if (isMultiple) {
        if (!state.selectedItems[catId]) state.selectedItems[catId] = [];
        const idx = state.selectedItems[catId].indexOf(itemId);
        if (idx >= 0) state.selectedItems[catId].splice(idx, 1);
        else state.selectedItems[catId].push(itemId);
    } else {
        if (state.selectedItems[catId] === itemId) delete state.selectedItems[catId];
        else { state.selectedItems[catId] = itemId; state.expandedCategory = null; }
    }
    renderAll();
    saveSelection();
}

function toggleExtraSelection(type, itemId) {
    pushUndoSnapshot();
    const list = type === 'prefix' ? state.selectedPrefixes : state.selectedSuffixes;
    const idx = list.indexOf(itemId);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(itemId);
    renderAll();
    saveSelection();
}

// ========== 摘要 ==========
function getCategorySummary(cat) {
    const isMultiple = cat.selection_type === 'multiple';
    if (isMultiple) {
        const ids = state.selectedItems[cat.id] || [];
        if (ids.length === 0) return '';
        return ids.map(id => { const item = cat.items.find(i => i.id === id); return item ? item.name : ''; }).filter(Boolean).join('、');
    } else {
        const selectedId = state.selectedItems[cat.id];
        if (!selectedId) return '';
        const item = cat.items.find(i => i.id === selectedId);
        return item ? item.name : '';
    }
}

function getExtraSummary(type) {
    const list = type === 'prefix' ? state.selectedPrefixes : state.selectedSuffixes;
    const items = type === 'prefix' ? state.prefixes : state.suffixes;
    if (list.length === 0) return '';
    return list.map(id => { const item = items.find(i => i.id === id); return item ? item.name : ''; }).filter(Boolean).join('、');
}

// ========== CRUD 操作 ==========
async function addItem(cat) {
    const name = await showPrompt(`在"${cat.name}"下添加新条目`, '', '条目名称');
    if (!name || !name.trim()) return;
    try {
        const item = await api('POST', `/api/categories/${cat.id}/items`, { name: name.trim() });
        cat.items.push(item);
        renderAll();
        showToast('添加成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function editItem(cat, item) {
    const name = await showPrompt('修改名称', item.name, '名称');
    if (!name || !name.trim()) return;
    try {
        const updated = await api('PUT', `/api/categories/${cat.id}/items/${item.id}`, { name: name.trim() });
        item.name = updated.name;
        renderAll();
        showToast('修改成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteItem(cat, item) {
    showConfirm(`确定删除条目"${item.name}"吗？`, async () => {
        try {
            await api('DELETE', `/api/categories/${cat.id}/items/${item.id}`);
            cat.items = cat.items.filter(i => i.id !== item.id);
            const isMultiple = cat.selection_type === 'multiple';
            if (isMultiple) { if (state.selectedItems[cat.id]) state.selectedItems[cat.id] = state.selectedItems[cat.id].filter(id => id !== item.id); }
            else if (state.selectedItems[cat.id] === item.id) delete state.selectedItems[cat.id];
            renderAll();
            saveSelection();
            showToast('删除成功', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

async function editCategory(cat) {
    const name = await showPrompt('修改分类名称', cat.name, '分类名称');
    if (!name || !name.trim()) return;
    try {
        const updated = await api('PUT', `/api/categories/${cat.id}`, { name: name.trim() });
        cat.name = updated.name;
        renderAll();
        showToast('修改成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteCategory(cat) {
    showConfirm(`删除分类"${cat.name}"将同时删除其下所有条目，确定吗？`, async () => {
        try {
            await api('DELETE', `/api/categories/${cat.id}`);
            state.categories = state.categories.filter(c => c.id !== cat.id);
            delete state.selectedItems[cat.id];
            if (state.expandedCategory === 'category:' + cat.id) state.expandedCategory = null;
            renderAll();
            saveSelection();
            showToast('删除成功', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

async function addExtraItem(type, typeName) {
    const name = await showPrompt(`添加新${typeName}`, '', `${typeName}名称`);
    if (!name || !name.trim()) return;
    try {
        const endpoint = type === 'prefix' ? '/api/prefixes' : '/api/suffixes';
        const item = await api('POST', endpoint, { name: name.trim() });
        if (type === 'prefix') state.prefixes.push(item);
        else state.suffixes.push(item);
        renderAll();
        showToast('添加成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function editExtraItem(type, item) {
    const name = await showPrompt('修改名称', item.name, '名称');
    if (!name || !name.trim()) return;
    try {
        const endpoint = type === 'prefix' ? `/api/prefixes/${item.id}` : `/api/suffixes/${item.id}`;
        const updated = await api('PUT', endpoint, { name: name.trim() });
        item.name = updated.name;
        renderAll();
        showToast('修改成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteExtraItem(type, item) {
    showConfirm(`确定删除"${item.name}"吗？`, async () => {
        try {
            const endpoint = type === 'prefix' ? `/api/prefixes/${item.id}` : `/api/suffixes/${item.id}`;
            await api('DELETE', endpoint);
            if (type === 'prefix') { state.prefixes = state.prefixes.filter(p => p.id !== item.id); state.selectedPrefixes = state.selectedPrefixes.filter(id => id !== item.id); }
            else { state.suffixes = state.suffixes.filter(s => s.id !== item.id); state.selectedSuffixes = state.selectedSuffixes.filter(id => id !== item.id); }
            renderAll();
            saveSelection();
            showToast('删除成功', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

// ========== 道具 CRUD ==========
async function addPropCategory() {
    const name = await showPrompt('输入道具分类名称', '', '分类名称');
    if (!name || !name.trim()) return;
    try {
        const prop = await api('POST', '/api/props', { name: name.trim() });
        state.props.push(prop);
        state.propOrder.push({ id: prop.id });
        state.expandedProp = prop.id;
        renderPropPanel();
        showToast('添加成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function editPropCategory(prop) {
    const name = await showPrompt('修改道具分类名称', prop.name, '分类名称');
    if (!name || !name.trim()) return;
    try {
        const updated = await api('PUT', `/api/props/${prop.id}`, { name: name.trim() });
        prop.name = updated.name;
        renderPropPanel();
        showToast('修改成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deletePropCategory(prop) {
    showConfirm(`删除道具分类"${prop.name}"将同时删除其下所有道具，确定吗？`, async () => {
        try {
            await api('DELETE', `/api/props/${prop.id}`);
            state.props = state.props.filter(p => p.id !== prop.id);
            state.propOrder = state.propOrder.filter(o => o.id !== prop.id);
            if (state.expandedProp === prop.id) state.expandedProp = null;
            renderPropPanel();
            showToast('删除成功', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

async function addPropItem(prop) {
    const name = await showPrompt(`在"${prop.name}"下添加新道具`, '', '道具名称');
    if (!name || !name.trim()) return;
    try {
        const item = await api('POST', `/api/props/${prop.id}/items`, { name: name.trim() });
        prop.items.push(item);
        renderPropPanel();
        showToast('添加成功，可上传预览图', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function editPropItem(prop, item) {
    // 弹出编辑弹窗：名称 + 更换图片
    const name = await showPrompt('修改道具名称', item.name, '名称');
    if (name === null) return;  // 用户取消

    const newName = name.trim() || item.name;

    // 询问是否更换图片
    const changeImg = confirm('是否更换参考图片？');
    let newImage = item.image;

    if (changeImg) {
        // 创建隐藏 file input 触发选择
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.jpg,.jpeg,.png,.webp';

        const fileChosen = new Promise((resolve) => {
            input.onchange = (e) => resolve(e.target.files[0] || null);
            // 如果用户不选文件，无法检测取消，设超时
            setTimeout(() => resolve(null), 60000);
            input.click();
        });

        const file = await fileChosen;
        if (file) {
            // 弹裁剪弹窗
            const croppedBlob = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (ev) => showCropModal(ev.target.result, resolve);
                reader.readAsDataURL(file);
            });
            if (!croppedBlob) { showToast('裁剪取消', 'info'); return; }
            const formData = new FormData();
            formData.append('file', croppedBlob, 'cropped.jpg');
            try {
                newImage = await uploadImage(formData);
            } catch (err) { showToast('图片上传失败：' + err.message, 'error'); return; }
        }
    }

    try {
        const updated = await api('PUT', `/api/props/${prop.id}/items/${item.id}`, { name: newName, image: newImage });
        item.name = updated.name;
        item.image = updated.image;
        renderPropPanel();
        showToast('修改成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deletePropItem(prop, item) {
    showConfirm(`确定删除道具"${item.name}"吗？`, async () => {
        try {
            await api('DELETE', `/api/props/${prop.id}/items/${item.id}`);
            prop.items = prop.items.filter(i => i.id !== item.id);
            renderPropPanel();
            showToast('删除成功', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

async function uploadPropImage(prop, item) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.webp';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        cropAndUploadFile(file, async (formData) => {
            try {
                const url = await uploadImage(formData);
                const updated = await api('PUT', `/api/props/${prop.id}/items/${item.id}`, { name: item.name, image: url });
                item.image = updated.image;
                renderPropPanel();
                showToast('图片上传成功', 'success');
            } catch (err) { showToast(err.message, 'error'); }
        });
    };
    input.click();
}

// ========== 添加大类 ==========
$('#btn-add-category').addEventListener('click', async () => {
    const name = await showPrompt('输入新分类名称', '', '分类名称');
    if (!name || !name.trim()) return;
    try {
        const cat = await api('POST', '/api/categories', { name: name.trim(), selection_type: 'single' });
        state.categories.push(cat);
        state.categoryOrder.push({ type: 'category', id: cat.id });
        state.expandedCategory = 'category:' + cat.id;
        renderAll();
        showToast('添加成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
});

$('#btn-add-prop').addEventListener('click', () => addPropCategory());

// ========== Prompt 生成（以预览区文本为准） ==========
$('#btn-generate').addEventListener('click', generatePrompt);
$('#btn-regenerate').addEventListener('click', generatePrompt);

async function generatePrompt() {
    pushUndoSnapshot();
    logAction('generate', '生成Prompt', {});
    const promptText = $('#prompt-preview').value.trim();
    if (!promptText) {
        showToast('预览区内容为空，请先选择或输入内容', 'error');
        return;
    }

    const btn = $('#btn-generate');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> 生成中...';

    try {
        const result = await api('POST', '/api/generate-from-text', { prompt_text: promptText });

        state.generatedPrompt = result.prompt;
        state.generatedSource = result.source;

        $('#prompt-result').style.display = 'block';
        $('#prompt-text').value = result.prompt;

        if (result.source === 'local') {
            $('#prompt-source').innerHTML = `<span class="fallback">自然化改写失败，已使用基础拼接结果${result.fallback_reason ? '（' + escHtml(result.fallback_reason) + '）' : ''}</span>`;
        } else {
            $('#prompt-source').innerHTML = '由大模型自然化改写';
        }

        $('#btn-regenerate').disabled = false;
        $('#btn-copy').disabled = false;
        $('#btn-save-preset').disabled = false;
        showToast('生成成功', 'success');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '立即生成';
    }
}

$('#btn-copy').addEventListener('click', () => {
    logAction('export', '复制Prompt', {});
    const text = $('#prompt-text').value;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => showToast('已复制到剪贴板', 'success')).catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('已复制到剪贴板', 'success');
    });
});

$('#btn-reset').addEventListener('click', () => {
    state.selectedPrefixes = [];
    state.selectedSuffixes = [];
    state.selectedItems = {};
    state.generatedPrompt = '';
    state.generatedSource = '';
    $('#prompt-preview').value = '';
    $('#prompt-result').style.display = 'none';
    $('#prompt-text').value = '';
    $('#prompt-source').textContent = '';
    $('#btn-regenerate').disabled = true;
    $('#btn-copy').disabled = true;
    $('#btn-save-preset').disabled = true;
    renderAll();
    saveSelection();
    showToast('已重置', 'info');
});

// ========== 保存选择状态 ==========
function getSelectedItemIds() {
    const ids = [];
    for (const cat of state.categories) {
        const sel = state.selectedItems[cat.id];
        if (!sel) continue;
        if (Array.isArray(sel)) ids.push(...sel);
        else ids.push(sel);
    }
    return ids;
}

async function saveSelection() {
    syncUndoBaselineAfterMutation();
    try {
        await api('PUT', '/api/last-selection', {
            selected_prefixes: state.selectedPrefixes,
            selected_items: getSelectedItemIds(),
            selected_suffixes: state.selectedSuffixes
        }, 60000, undefined, true); // skipGlobalAbort: 不绑定取消生成信号
    } catch (e) { console.error('保存选择状态失败:', e); }
}

// ========== 预设 ==========
$('#btn-save-preset').addEventListener('click', () => {
    state.presetCoverUrl = '';
    state.presetEffectUrl = '';
    state.selectedPresetTags = [];
    state._editingPresetId = null;  // 新建模式
    $('#preset-name').value = '';
    $('#preset-prompt-text').value = $('#prompt-preview').value || '';

    // 重置封面上传
    const uploadPreview2 = $('#upload-preview');
    const uploadPlaceholder2 = $('#upload-placeholder');
    if (uploadPreview2) uploadPreview2.style.display = 'none';
    if (uploadPlaceholder2) uploadPlaceholder2.style.display = 'flex';
    // 重置效果图上传
    const uploadPreviewEffect2 = $('#upload-preview-effect');
    const uploadPlaceholderEffect2 = $('#upload-placeholder-effect');
    if (uploadPreviewEffect2) uploadPreviewEffect2.style.display = 'none';
    if (uploadPlaceholderEffect2) uploadPlaceholderEffect2.style.display = 'flex';

    renderPresetTagList();
    openModal('modal-save-preset');
});

function renderPresetTagList() {
    const container = $('#preset-tag-list');
    container.innerHTML = '';
    for (const tag of state.presetTags) {
        const el = document.createElement('span');
        el.className = `preset-tag-item ${state.selectedPresetTags.includes(tag) ? 'selected' : ''}`;

        const nameSpan = document.createElement('span');
        nameSpan.textContent = tag;
        nameSpan.addEventListener('click', () => {
            const idx = state.selectedPresetTags.indexOf(tag);
            if (idx >= 0) state.selectedPresetTags.splice(idx, 1);
            else state.selectedPresetTags.push(tag);
            renderPresetTagList();
        });

        const delBtn = document.createElement('span');
        delBtn.className = 'tag-del-btn';
        delBtn.textContent = '×';
        delBtn.title = '删除分类';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showConfirm(`删除分类"${tag}"？预设中的该分类标签也会被移除。`, async () => {
                state.presetTags = state.presetTags.filter(t => t !== tag);
                state.selectedPresetTags = state.selectedPresetTags.filter(t => t !== tag);
                // 从所有预设中移除该标签
                for (const p of state.presets) {
                    if (p.tags) p.tags = p.tags.filter(t => t !== tag);
                }
                await savePresetTags();
                // 同步标签变更到服务端的 presets
                for (const p of state.presets) {
                    if (p.tags) api('PUT', `/api/presets/${p.id}`, { tags: p.tags }).catch(e => console.error('同步预设标签失败:', e));
                }
                renderPresetTagList();
                renderPresets();
            });
        });

        const editBtn = document.createElement('span');
        editBtn.className = 'tag-edit-btn';
        editBtn.textContent = '✎';
        editBtn.title = '重命名';
        editBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newName = await showPrompt('重命名分类', tag, '分类名称');
            if (!newName || !newName.trim() || newName.trim() === tag) return;
            if (state.presetTags.includes(newName.trim())) { showToast('分类名已存在', 'error'); return; }
            const oldName = tag;
            const idx = state.presetTags.indexOf(oldName);
            state.presetTags[idx] = newName.trim();
            // 更新选中
            const selIdx = state.selectedPresetTags.indexOf(oldName);
            if (selIdx >= 0) state.selectedPresetTags[selIdx] = newName.trim();
            // 更新所有预设中的标签
            for (const p of state.presets) {
                if (p.tags) {
                    const tIdx = p.tags.indexOf(oldName);
                    if (tIdx >= 0) p.tags[tIdx] = newName.trim();
                }
            }
            savePresetTags();
            // 同步标签变更到服务端的 presets
            for (const p of state.presets) {
                if (p.tags && p.tags.includes(newName.trim())) {
                    api('PUT', `/api/presets/${p.id}`, { tags: p.tags }).catch(e => console.error('同步预设标签失败:', e));
                }
            }
            renderPresetTagList();
            renderPresets();
        });

        el.appendChild(nameSpan);
        el.appendChild(editBtn);
        el.appendChild(delBtn);
        container.appendChild(el);
    }

    // 添加新分类按钮
    const addBtn = document.createElement('span');
    addBtn.className = 'preset-tag-item tag-add-btn';
    addBtn.textContent = '+';
    addBtn.title = '添加分类';
    addBtn.addEventListener('click', async () => {
        const name = await showPrompt('输入新分类名称', '', '分类名称');
        if (!name || !name.trim()) return;
        if (state.presetTags.includes(name.trim())) { showToast('分类名已存在', 'error'); return; }
        state.presetTags.push(name.trim());
        savePresetTags();
        renderPresetTagList();
    });
    container.appendChild(addBtn);
}

async function savePresetTags() {
    try {
        await api('PUT', '/api/preset-tags', { tags: state.presetTags });
    } catch (e) { console.error('保存分类标签失败:', e); }
}

$('#btn-confirm-save-preset').addEventListener('click', async () => {
    const name = $('#preset-name').value.trim();
    const promptText = $('#preset-prompt-text').value.trim();
    if (!name) { showToast('请输入预设名称', 'error'); return; }
    if (!promptText) { showToast('提示词不能为空', 'error'); return; }

    const payload = {
        name,
        cover_image: state.presetCoverUrl,
        effect_image: state.presetEffectUrl,
        prompt_text: promptText,
        tags: state.selectedPresetTags,
        selected_prefixes: state.selectedPrefixes,
        selected_items: getSelectedItemIds(),
        selected_suffixes: state.selectedSuffixes,
        // 同时保存图生图数据（图片槽和双语prompt）
        image_slots: imageState.slots.map(s => ({
            path: s.image || '',
            label: s.label || '',
            prefixTemplate: s.prefixTemplate || '请参考'
        })),
        image_prompt_cn: document.getElementById('img-prompt-cn')?.value || '',
        image_prompt_en: document.getElementById('img-prompt-en')?.value || ''
    };

    try {
        if (state._editingPresetId) {
            // 编辑模式：更新已有预设
            const updated = await api('PUT', `/api/presets/${state._editingPresetId}`, payload);
            const idx = state.presets.findIndex(p => p.id === state._editingPresetId);
            if (idx >= 0) state.presets[idx] = updated;
            state._editingPresetId = null;
            showToast('预设已更新', 'success');
        } else {
            // 新建模式
            const preset = await api('POST', '/api/presets', payload);
            state.presets.push(preset);
            showToast('预设保存成功', 'success');
        }
        renderPresets();
        closeModal('modal-save-preset');
    } catch (e) { showToast(e.message, 'error'); }
});

// 封面图片上传 - 修复事件冒泡问题
$('#upload-area').addEventListener('click', (e) => {
    // 防止循环：如果点击的是 file input 本身，不处理
    if (e.target.id === 'preset-cover-input') return;
    e.preventDefault();
    e.stopPropagation();
    $('#preset-cover-input').click();
});

$('#preset-cover-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const url = await uploadImage(formData);
        state.presetCoverUrl = url;
        $('#upload-preview').src = url;
        $('#upload-preview').style.display = 'block';
        $('#upload-placeholder').style.display = 'none';
        showToast('封面上传成功', 'success');
    } catch (err) { showToast(err.message, 'error'); }
});

// 效果图上传
$('#upload-area-effect').addEventListener('click', (e) => {
    if (e.target.id === 'preset-effect-input') return;
    e.preventDefault();
    e.stopPropagation();
    $('#preset-effect-input').click();
});

$('#preset-effect-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const url = await uploadImage(formData);
        state.presetEffectUrl = url;
        $('#upload-preview-effect').src = url;
        $('#upload-preview-effect').style.display = 'block';
        $('#upload-placeholder-effect').style.display = 'none';
        showToast('效果图上传成功', 'success');
    } catch (err) { showToast(err.message, 'error'); }
});

// 封面拖拽上传
const uploadArea = $('#upload-area');
uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.style.borderColor = '#73D13D'; });
uploadArea.addEventListener('dragleave', () => { uploadArea.style.borderColor = ''; });
uploadArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.style.borderColor = '';
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const url = await uploadImage(formData);
        state.presetCoverUrl = url;
        $('#upload-preview').src = url;
        $('#upload-preview').style.display = 'block';
        $('#upload-placeholder').style.display = 'none';
        showToast('封面上传成功', 'success');
    } catch (err) { showToast(err.message, 'error'); }
});

// 效果图拖拽上传
const uploadAreaEffect = $('#upload-area-effect');
uploadAreaEffect.addEventListener('dragover', (e) => { e.preventDefault(); uploadAreaEffect.style.borderColor = '#73D13D'; });
uploadAreaEffect.addEventListener('dragleave', () => { uploadAreaEffect.style.borderColor = ''; });
uploadAreaEffect.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadAreaEffect.style.borderColor = '';
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
        const url = await uploadImage(formData);
        state.presetEffectUrl = url;
        $('#upload-preview-effect').src = url;
        $('#upload-preview-effect').style.display = 'block';
        $('#upload-placeholder-effect').style.display = 'none';
        showToast('效果图上传成功', 'success');
    } catch (err) { showToast(err.message, 'error'); }
});

// ========== 预设渲染 ==========
function renderPresets() {
    const grid = $('#preset-grid');
    grid.innerHTML = '';

    // 应用缩放列数
    grid.style.gridTemplateColumns = `repeat(${state.presetZoom}, 1fr)`;

    // 渲染筛选标签
    renderPresetFilterTags();

    // 筛选预设：标签 + 搜索
    let filteredPresets = state.presets;
    if (state.presetFilterTag) {
        filteredPresets = filteredPresets.filter(p => (p.tags || []).includes(state.presetFilterTag));
    }
    const keyword = state.presetSearchKeyword.trim().toLowerCase();
    if (keyword) {
        filteredPresets = filteredPresets.filter(p =>
            p.name.toLowerCase().includes(keyword) ||
            (p.prompt_text || '').toLowerCase().includes(keyword)
        );
    }

    // 排序
    if (state.presetSortBy && state.presetSortBy !== 'default') {
        filteredPresets = [...filteredPresets].sort((a, b) => {
            if (state.presetSortBy === 'name') return (a.name || '').localeCompare(b.name || '', 'zh-CN');
            if (state.presetSortBy === 'created_at') return (b.created_at || '').localeCompare(a.created_at || '');
            if (state.presetSortBy === 'updated_at') return (b.updated_at || '').localeCompare(a.updated_at || '');
            return 0;
        });
    }

    if (filteredPresets.length === 0) {
        if (keyword || state.presetFilterTag) {
            grid.innerHTML = '<p class="empty-hint">没有找到匹配的预设</p>';
        } else {
            grid.innerHTML = '<p class="empty-hint">你还没有保存任何预设<br>点击上方"+ 添加预设"开始</p>';
        }
        return;
    }

    for (const preset of filteredPresets) {
        const card = document.createElement('div');
        card.className = 'preset-card';

        // 封面图：优先用 cover_image，否则用 effect_image
        const displayImage = preset.cover_image || preset.effect_image;
        const coverHtml = displayImage
            ? `<div class="preset-cover"><img src="${escHtml(displayImage)}" alt="${escHtml(preset.name)}" class="preset-cover-img" data-url="${escHtml(displayImage)}"></div>`
            : `<div class="preset-cover">📷</div>`;

        // 标签
        const tags = preset.tags || [];
        const tagsHtml = tags.length
            ? `<div class="preset-tags">${tags.map(t => `<span class="preset-tag-badge">${escHtml(t)}</span>`).join('')}</div>`
            : '';

        // 描述：优先显示 prompt_text，否则用旧逻辑
        const desc = preset.prompt_text
            ? (preset.prompt_text.length > 40 ? preset.prompt_text.substring(0, 40) + '...' : preset.prompt_text)
            : getPresetDesc(preset);

        card.innerHTML = `
            ${coverHtml}
            ${tagsHtml}
            <div class="preset-info">
                <div class="preset-name">${escHtml(preset.name)}</div>
                <div class="preset-desc">${escHtml(desc)}</div>
            </div>
            <div class="preset-actions">
                <button class="btn btn-outline btn-sm preset-apply">应用</button>
                <button class="btn btn-outline btn-sm preset-edit">编辑</button>
                <button class="btn btn-outline btn-sm preset-clone">复制</button>
                <button class="btn btn-outline btn-sm preset-delete" style="color:var(--danger)">删除</button>
            </div>
        `;

        // 封面图点击查看大图
        const coverImg = card.querySelector('.preset-cover-img');
        if (coverImg) {
            coverImg.style.cursor = 'pointer';
            coverImg.addEventListener('click', (e) => {
                e.stopPropagation();
                showImagePreview(displayImage);
            });
        }

        card.querySelector('.preset-apply').addEventListener('click', () => applyPreset(preset));
        card.querySelector('.preset-edit').addEventListener('click', () => editPreset(preset));
        card.querySelector('.preset-clone').addEventListener('click', () => clonePreset(preset));
        card.querySelector('.preset-delete').addEventListener('click', () => deletePreset(preset));
        grid.appendChild(card);
    }
}

function renderPresetFilterTags() {
    const container = $('#preset-filter-tags');
    container.innerHTML = '';

    // 收集所有已使用的标签
    const usedTags = new Set();
    for (const p of state.presets) {
        for (const t of (p.tags || [])) usedTags.add(t);
    }

    if (usedTags.size === 0) return;

    // "全部"标签
    const allTag = document.createElement('span');
    allTag.className = `preset-filter-tag ${state.presetFilterTag === '' ? 'active' : ''}`;
    allTag.textContent = '全部';
    allTag.addEventListener('click', () => { state.presetFilterTag = ''; renderPresets(); });
    container.appendChild(allTag);

    for (const tag of usedTags) {
        const el = document.createElement('span');
        el.className = `preset-filter-tag ${state.presetFilterTag === tag ? 'active' : ''}`;
        el.textContent = tag;
        el.addEventListener('click', () => { state.presetFilterTag = tag; renderPresets(); });
        container.appendChild(el);
    }
}

async function applyPreset(preset) {
    pushUndoSnapshot();
    // 如果有 prompt_text，直接填入预览区
    if (preset.prompt_text) {
        $('#prompt-preview').value = preset.prompt_text;
    }

    // 同时恢复选择状态
    state.selectedPrefixes = [...(preset.selected_prefixes || [])];
    state.selectedSuffixes = [...(preset.selected_suffixes || [])];
    state.selectedItems = {};
    const selectedItemIds = preset.selected_items || [];
    for (const cat of state.categories) {
        const catId = cat.id;
        const isMultiple = cat.selection_type === 'multiple';
        for (const item of cat.items) {
            if (selectedItemIds.includes(item.id)) {
                if (isMultiple) { if (!state.selectedItems[catId]) state.selectedItems[catId] = []; state.selectedItems[catId].push(item.id); }
                else state.selectedItems[catId] = item.id;
            }
        }
    }
    renderAll();
    saveSelection();
    showToast('已应用预设', 'success');
}

async function editPreset(preset) {
    // 打开保存弹窗，预填已有数据
    state.presetCoverUrl = preset.cover_image || '';
    state.presetEffectUrl = preset.effect_image || '';
    state.selectedPresetTags = [...(preset.tags || [])];
    state._editingPresetId = preset.id;  // 标记是编辑模式

    $('#preset-name').value = preset.name || '';
    $('#preset-prompt-text').value = preset.prompt_text || '';

    // 封面预览
    const _upCover = $('#upload-preview');
    const _upPlaceCover = $('#upload-placeholder');
    if (preset.cover_image) {
        if (_upCover) { _upCover.src = preset.cover_image; _upCover.style.display = 'block'; }
        if (_upPlaceCover) _upPlaceCover.style.display = 'none';
    } else {
        if (_upCover) _upCover.style.display = 'none';
        if (_upPlaceCover) _upPlaceCover.style.display = 'flex';
    }

    // 效果图预览
    const _upEffect = $('#upload-preview-effect');
    const _upPlaceEffect = $('#upload-placeholder-effect');
    if (preset.effect_image) {
        if (_upEffect) { _upEffect.src = preset.effect_image; _upEffect.style.display = 'block'; }
        if (_upPlaceEffect) _upPlaceEffect.style.display = 'none';
    } else {
        if (_upEffect) _upEffect.style.display = 'none';
        if (_upPlaceEffect) _upPlaceEffect.style.display = 'flex';
    }

    renderPresetTagList();
    openModal('modal-save-preset');
}

async function clonePreset(preset) {
    try {
        const payload = {
            name: preset.name + ' - 副本',
            cover_image: preset.cover_image || '',
            effect_image: preset.effect_image || '',
            prompt_text: preset.prompt_text || '',
            tags: [...(preset.tags || [])],
            selected_prefixes: [...(preset.selected_prefixes || [])],
            selected_items: [...(preset.selected_items || [])],
            selected_suffixes: [...(preset.selected_suffixes || [])]
        };
        const newPreset = await api('POST', '/api/presets', payload);
        state.presets.push(newPreset);
        renderPresets();
        showToast('预设已复制', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deletePreset(preset) {
    showConfirm(`确定删除预设"${preset.name}"吗？`, async () => {
        try {
            await api('DELETE', `/api/presets/${preset.id}`);
            state.presets = state.presets.filter(p => p.id !== preset.id);
            renderPresets();
            showToast('预设已删除', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

function getPresetDesc(preset) {
    const parts = [];
    const itemIds = preset.selected_items || [];
    for (const cat of state.categories) {
        const names = [];
        for (const item of cat.items) { if (itemIds.includes(item.id)) names.push(item.name); }
        if (names.length) parts.push(names.join(' / '));
    }
    return parts.slice(0, 2).join(' / ') || '无配置';
}

// ========== 数据导出 ==========
const btnExport = $('#btn-export');
if (btnExport) btnExport.addEventListener('click', () => {
    logAction('export', '导出数据', {});
    // 打开选择性导出弹窗
    openModal('modal-export');
});

// 确认导出
document.getElementById('btn-confirm-export')?.addEventListener('click', async () => {
    // 收集选中的类别
    const selected = {};
    document.querySelectorAll('.export-check').forEach(cb => {
        selected[cb.dataset.key] = cb.checked;
    });
    // 至少选一个
    if (!Object.values(selected).some(v => v)) {
        showToast('请至少选择一个导出类别', 'error');
        return;
    }
    try {
        closeModal('modal-export');
        showToast('正在打包导出...', 'info');
        const resp = await fetch('/api/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selected })
        });
        if (!resp.ok) throw new Error('导出失败');
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'prompt_generator_export.zip';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setTimeout(() => showToast('导出完成，请查看下载文件', 'success'), 500);
    } catch (err) {
        showToast('导出失败：' + err.message, 'error');
    }
});

// ========== 数据导入 ==========
const btnImport = $('#btn-import');
if (btnImport) btnImport.addEventListener('click', () => {
    logAction('export', '导入数据', {});
    openModal('modal-import');
});

// 确认导入
document.getElementById('btn-confirm-import')?.addEventListener('click', () => {
    // 收集选中的类别
    const selected = {};
    document.querySelectorAll('.import-check').forEach(cb => {
        selected[cb.dataset.key] = cb.checked;
    });
    if (!Object.values(selected).some(v => v)) {
        showToast('请至少选择一个导入类别', 'error');
        return;
    }

    // 构建合并/覆盖提示信息
    const MERGE_CATS = { image_library: '素材库', image_presets: '图生图预设', prefixes_suffixes: '前缀/后缀模板', presets: '文生图预设' };
    const OVERWRITE_CATS = { categories: '文生图词库', model_config: '模型配置' };
    const mergeList = Object.keys(MERGE_CATS).filter(k => selected[k]).map(k => MERGE_CATS[k]);
    const overwriteList = Object.keys(OVERWRITE_CATS).filter(k => selected[k]).map(k => OVERWRITE_CATS[k]);
    let confirmParts = [];
    if (mergeList.length) confirmParts.push('【合并】（保留本地数据，新增不重复项）：' + mergeList.join('、'));
    if (overwriteList.length) confirmParts.push('【覆盖】（替换本地数据，原有数据将丢失）：' + overwriteList.join('、'));
    if (!confirmParts.length) { showToast('请至少选择一个导入类别', 'error'); return; }

    showConfirm('确认导入？\n\n' + confirmParts.join('\n\n'), () => {
        if (selected.image_presets) {
            selected.auto_supplement = confirm('导入图生图预设时，是否自动补全缺失素材到本地素材库？\n确定=自动补全；取消=仅导入预设');
        }
        // 选择文件
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip';
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const formData = new FormData();
            formData.append('file', file);
            formData.append('selected', JSON.stringify(selected));
            try {
                closeModal('modal-import');
                const resp = await fetch('/api/import', { method: 'POST', body: formData });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || '导入失败');
                let msg = `导入成功：${data.imported.data_files}个数据文件，${data.imported.images}张图片`;
                if (data.imported.renamed > 0) msg += `，${data.imported.renamed}个同名项已加"新"后缀`;
                if (data.supplement && (data.supplement.added > 0 || data.supplement.skipped_same_hash > 0)) {
                    msg += `；预设补素材：新增${data.supplement.added}个，同分类同图跳过${data.supplement.skipped_same_hash}个`;
                }
                showToast(msg, 'success');
                await loadAllData();
            } catch (err) {
                showToast('导入失败：' + err.message, 'error');
            }
        };
        input.click();
    }, { title: '确认导入', btnText: '导入' });
});

// ========== 清理数据 ==========
$('#btn-cleanup-images').addEventListener('click', async () => {
    openModal('modal-cleanup');
    await refreshCleanupStats();
});

async function refreshCleanupStats() {
    const el = document.getElementById('cleanup-dwpose-stats');
    if (!el) return;
    el.textContent = '统计中...';
    try {
        const stats = await api('GET', '/api/dwpose-cache-stats');
        const size = stats.size_kb > 1024 ? `${(stats.size_kb / 1024).toFixed(1)}MB` : `${Math.round(stats.size_kb)}KB`;
        el.textContent = `DWPose缓存：${stats.count || 0} 个，${size}`;
    } catch (e) {
        el.textContent = 'DWPose缓存统计失败';
    }
}

document.getElementById('btn-cleanup-orphans')?.addEventListener('click', () => {
    showConfirm('将未被任何数据引用的内部图片移到回收站，不会永久删除。继续吗？', async () => {
        try {
            const result = await api('POST', '/api/cleanup-images');
            if (result.success && result.deleted > 0) {
                showToast(`已移到回收站 ${result.deleted} 张，释放约 ${result.freed_kb}KB`, 'success');
            } else {
                showToast('没有发现孤立图片', 'info');
            }
        } catch (e) {
            showToast('清理失败: ' + e.message, 'error');
        }
    }, { title: '清理孤立图片', btnText: '移到回收站' });
});

document.getElementById('btn-cleanup-dwpose')?.addEventListener('click', () => {
    showConfirm('将 DWPose 姿态缓存移到回收站，不会永久删除。继续吗？', async () => {
        try {
            const result = await api('POST', '/api/cleanup-dwpose-cache', { days: 'all' });
            showToast(`已移到回收站 ${result.deleted || 0} 个缓存，释放约 ${Math.round(result.freed_kb || 0)}KB`, 'success');
            await refreshCleanupStats();
        } catch (e) {
            showToast('清理失败: ' + e.message, 'error');
        }
    }, { title: '清理DWPose缓存', btnText: '移到回收站' });
});

async function cleanupQueueResults(kind, scope) {
    const isSplit = kind === 'split';
    const index = isSplit ? activeSplitQueue : activeQueue;
    const label = `${isSplit ? '拆图' : '生图'}${scope === 'all' ? '全部队列' : `队列${index + 1}`}`;
    showConfirm(`只清理${label}界面里的生成结果卡片和进度，不删除图片、不清提示词和参考图。继续吗？`, async () => {
        try {
            const result = await api('POST', '/api/cleanup-queue-results', { kind, scope, index });
            if (isSplit) {
                if (scope === 'all') splitQueueData.forEach(q => { if (q) { q.results = []; q.progressDone = 0; q.progressTotal = 0; q.failedItems = []; } });
                else if (splitQueueData[index]) Object.assign(splitQueueData[index], { results: [], progressDone: 0, progressTotal: 0, failedItems: [] });
                renderSplitQueueResults(activeSplitQueue);
                renderSplitQueueNumberBar();
                updateSplitFailedUI(activeSplitQueue);
            } else {
                if (scope === 'all') queueData.forEach(q => { if (q) { q.results = []; q.progressDone = 0; q.progressTotal = 0; } });
                else if (queueData[index]) queueData[index].results = [];
                renderQueueResults(activeQueue);
                renderQueueNumberBars();
            }
            showToast(`已清理 ${result.cleared || 0} 条结果记录`, 'success');
        } catch (e) {
            showToast('清理失败: ' + e.message, 'error');
        }
    }, { title: '清理结果记录', btnText: '清理记录' });
}

document.getElementById('btn-cleanup-image-current-results')?.addEventListener('click', () => cleanupQueueResults('image', 'current'));
document.getElementById('btn-cleanup-image-all-results')?.addEventListener('click', () => cleanupQueueResults('image', 'all'));
document.getElementById('btn-cleanup-split-current-results')?.addEventListener('click', () => cleanupQueueResults('split', 'current'));
document.getElementById('btn-cleanup-split-all-results')?.addEventListener('click', () => cleanupQueueResults('split', 'all'));
document.getElementById('btn-cleanup-open-gallery')?.addEventListener('click', () => {
    closeModal('modal-cleanup');
    document.getElementById('btn-gallery')?.click();
});

// ========== 图库功能 ==========
let galleryData = { groups: [], total_count: 0, total_size_kb: 0, base_path: '' };
let gallerySelected = new Set(); // 选中的图片路径集合
let galleryPickerContext = null; // { mode: 'split', recentDays: 3 }
let galleryRecentDays = 0; // 0=全部

function _processGalleryData(rawData, opts = {}) {
    if (!rawData || !rawData.groups) return rawData;
    const recentDays = opts.recentDays || 0;
    const now = Date.now();
    const cutoff = recentDays > 0 ? now - recentDays * 24 * 60 * 60 * 1000 : 0;

    const allImages = [];
    for (const group of rawData.groups) {
        for (const img of (group.images || [])) {
            if (recentDays > 0 && img.mtime && img.mtime * 1000 < cutoff) continue;
            allImages.push(img);
        }
    }

    // 按时间倒序（最新优先）
    allImages.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));

    const grouped = {};
    for (const img of allImages) {
        const d = img.mtime ? new Date(img.mtime * 1000) : new Date();
        const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!grouped[label]) grouped[label] = [];
        grouped[label].push(img);
    }
    const groups = Object.keys(grouped).sort((a, b) => b.localeCompare(a)).map(k => ({ label: k, images: grouped[k] }));

    return {
        ...rawData,
        groups,
        total_count: allImages.length,
        total_size_kb: allImages.reduce((s, x) => s + (x.size_kb || 0), 0)
    };
}

function renderGallery(data) {
    galleryData = data;
    gallerySelected.clear();
    const grid = document.getElementById('gallery-grid');
    if (!grid) return;

    if (!data.groups || data.groups.length === 0) {
        grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-muted);font-size:12px;">图库为空，生成图片后会自动出现在这里</p>';
        document.getElementById('gallery-stats').textContent = '共 0 张';
        updateGallerySelection();
        return;
    }

    const sizeStr = formatSizeFromKb(data.total_size_kb);
    const statsPrefix = galleryRecentDays > 0 ? `最近${galleryRecentDays}天` : '共';
    document.getElementById('gallery-stats').textContent = galleryPickerContext?.mode === 'split'
        ? `${statsPrefix} ${data.total_count} 张，${sizeStr}`
        : `共 ${data.total_count} 张，${sizeStr}`;

    let html = '';
    for (const group of data.groups) {
        // 日期分组标题
        const safeGroupLabel = escHtml(group.label);
        html += `<div style="grid-column:1/-1;display:flex;align-items:center;gap:6px;padding:8px 0 4px;border-bottom:1px solid var(--border-light);margin-top:4px;">
            <span style="font-size:12px;font-weight:600;color:var(--text-secondary);">${safeGroupLabel}</span>
            <span style="font-size:10px;color:var(--text-muted);">${group.images.length} 张</span>
            <button class="btn btn-outline btn-compact gallery-folder-delete" data-folder="${safeGroupLabel}" style="font-size:9px;padding:1px 4px;color:var(--danger);border-color:var(--danger);margin-left:4px;">删除整组</button>
        </div>`;

        for (const img of group.images) {
            const proxyUrl = `/api/gallery-image?path=${encodeURIComponent(img.path)}`;
            const encodedPath = encodeURIComponent(img.path);
            const safeName = escHtml(img.name);
            html += `<div class="gallery-item" data-path="${encodedPath}" style="position:relative;aspect-ratio:3/4;border-radius:4px;overflow:hidden;cursor:pointer;background:var(--bg-secondary);border:1px solid var(--border-light);">
                <img src="${proxyUrl}" loading="lazy" class="gallery-img" style="width:100%;height:100%;object-fit:cover;">
                <input type="checkbox" class="gallery-checkbox" data-path="${encodedPath}" style="position:absolute;top:4px;left:4px;z-index:2;cursor:pointer;">
                <span style="position:absolute;bottom:0;left:0;right:0;background:linear-gradient(transparent,rgba(0,0,0,0.6));color:#fff;font-size:9px;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${safeName}</span>
                <span style="position:absolute;top:4px;right:4px;font-size:8px;color:var(--text-muted);background:rgba(255,255,255,0.8);padding:0 2px;border-radius:2px;">${Math.round(img.size_kb)}KB</span>
            </div>`;
        }
    }
    grid.innerHTML = html;

    // 图片加载失败处理（替代内联onerror，防止XSS）
    grid.querySelectorAll('.gallery-img').forEach(imgEl => {
        imgEl.addEventListener('error', function() {
            this.style.display = 'none';
            const fallback = document.createElement('span');
            fallback.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-size:9px;color:var(--text-muted);';
            fallback.textContent = '加载失败';
            this.parentElement.appendChild(fallback);
        });
    });

    // 绑定事件
    grid.querySelectorAll('.gallery-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('gallery-checkbox')) return;
            const path = decodeURIComponent(item.dataset.path || '');
            if (galleryPickerContext?.mode === 'split') {
                selectGalleryImageForSplit(path);
                return;
            }
            const proxyUrl = `/api/gallery-image?path=${encodeURIComponent(path)}`;
            openImageViewer([{ url: proxyUrl, filename: path.split('/').pop() }]);
        });
    });

    grid.querySelectorAll('.gallery-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
            const path = decodeURIComponent(cb.dataset.path || '');
            if (!path) return;
            if (cb.checked) gallerySelected.add(path);
            else gallerySelected.delete(path);
            updateGallerySelection();
        });
    });

    grid.querySelectorAll('.gallery-folder-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const folder = btn.dataset.folder;
            showConfirm(`确定把「${folder}」整组图片移到回收站？`, async () => {
                try {
                    const group = (galleryData.groups || []).find(g => g.label === folder);
                    const files = (group?.images || []).map(img => img.path);
                    const result = files.length > 0
                        ? await api('POST', '/api/gallery-delete', { files })
                        : await api('POST', '/api/gallery-folder-delete', { folder });
                    showToast(`已移到回收站 ${result.deleted} 张，释放 ${Math.round(result.freed_kb)}KB`, 'success');
                    loadGallery();
                } catch (err) {
                    showToast('删除失败: ' + err.message, 'error');
                }
            }, { title: '移到回收站', btnText: '移到回收站' });
        });
    });

    updateGallerySelection();
}

function formatSizeFromKb(kb) {
    const sizeKb = Math.max(0, Number(kb) || 0);
    if (sizeKb >= 1024 * 1024) return `${(sizeKb / 1024 / 1024).toFixed(1)}GB`;
    if (sizeKb >= 1024) return `${(sizeKb / 1024).toFixed(1)}MB`;
    return `${Math.round(sizeKb)}KB`;
}

function updateGallerySelection() {
    const count = gallerySelected.size;
    const countEl = document.getElementById('gallery-selected-count');
    if (countEl) countEl.textContent = `已选 ${count} 张`;
    const deleteBtn = document.getElementById('btn-gallery-delete-selected');
    if (deleteBtn) deleteBtn.style.display = count > 0 ? 'inline-flex' : 'none';
}

async function loadGallery() {
    const grid = document.getElementById('gallery-grid');
    if (grid) grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-muted);font-size:12px;">加载中...</p>';
    document.getElementById('gallery-stats').textContent = '加载中...';
    try {
        const qs = galleryRecentDays > 0 ? `?recent_days=${encodeURIComponent(galleryRecentDays)}` : '';
        const data = await api('GET', `/api/gallery${qs}`);
        const processed = _processGalleryData(data, { recentDays: galleryRecentDays });
        renderGallery(processed);
    } catch (e) {
        if (grid) grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--danger);font-size:12px;">加载失败: ' + escHtml(e.message) + '</p>';
    }
}

async function selectGalleryImageForSplit(path) {
    try {
        const result = await api('POST', '/api/gallery-import-image', { path });
        if (!result.url) {
            showToast('导入图片失败', 'error');
            return;
        }
        splitImageUrl = result.url;
        const qd = splitQueueData[activeSplitQueue];
        if (qd) {
            const name = result.name || getFileBaseName(path);
            qd.progressTotal = 0;
            qd.progressDone = 0;
            qd.materials = [{
                gridImageUrl: result.url,
                sourceFilename: name,
                selectedNums: [],
                learnedGridLayout: null,
                cropPreset: qd.cropPreset ?? null,
                workItems: []
            }];
            qd.activeMaterialIndex = 0;
            loadActiveSplitMaterialIntoQueue(qd, 0);
            qd.gridImageUrl = result.url;
            qd.workItems = [];
            qd.activeItemIndex = 0;
            qd.learnedGridLayout = null;
            qd.sourceFilename = name;
            saveSplitQueueData();
        }
        const imgEl = document.getElementById('split-img');
        if (imgEl) imgEl.src = splitImageUrl;
        const previewEl = document.getElementById('split-preview');
        if (previewEl) previewEl.style.display = '';
        const dropZoneEl = document.getElementById('split-drop-zone');
        if (dropZoneEl) dropZoneEl.style.display = 'none';
        galleryPickerContext = null;
        closeModal('modal-gallery');
        await maybeAutoSplitFromFilename(activeSplitQueue);
        saveSplitQueueData();
        renderSplitMaterialTabs(activeSplitQueue);
        renderSplitWorkItemTabs(activeSplitQueue);
        loadSplitQueueToUI(activeSplitQueue);
        updateSplitGenerateBtnState();
        renderSplitQueueNumberBar();
        showToast(`已加载图库图片: ${result.name || '已选择图片'}`, 'success');
    } catch (e) {
        showToast('导入图库图片失败: ' + e.message, 'error');
    }
}

// 图库按钮
document.getElementById('btn-gallery')?.addEventListener('click', () => {
    galleryPickerContext = null;
    galleryRecentDays = 0;
    openModal('modal-gallery');
    loadGallery();
});

document.getElementById('btn-gallery-range-1')?.addEventListener('click', () => { galleryRecentDays = 1; loadGallery(); });
document.getElementById('btn-gallery-range-3')?.addEventListener('click', () => { galleryRecentDays = 3; loadGallery(); });
document.getElementById('btn-gallery-range-7')?.addEventListener('click', () => { galleryRecentDays = 7; loadGallery(); });

// 刷新
document.getElementById('btn-gallery-refresh')?.addEventListener('click', () => loadGallery());

// 全选
document.getElementById('btn-gallery-select-all')?.addEventListener('click', () => {
    document.querySelectorAll('.gallery-checkbox').forEach(cb => {
        cb.checked = true;
        const path = decodeURIComponent(cb.dataset.path || '');
        if (path) gallerySelected.add(path);
    });
    updateGallerySelection();
});

// 取消全选
document.getElementById('btn-gallery-select-none')?.addEventListener('click', () => {
    document.querySelectorAll('.gallery-checkbox').forEach(cb => { cb.checked = false; });
    gallerySelected.clear();
    updateGallerySelection();
});

// 删除选中
document.getElementById('btn-gallery-delete-selected')?.addEventListener('click', () => {
    const files = [...gallerySelected];
    if (files.length === 0) return;
    showConfirm(`确定把选中的 ${files.length} 张图片移到回收站？`, async () => {
        try {
            const result = await api('POST', '/api/gallery-delete', { files });
            let msg = `已移到回收站 ${result.deleted} 张，释放 ${Math.round(result.freed_kb)}KB`;
            if (result.errors && result.errors.length > 0) msg += `，${result.errors.length} 个失败`;
            showToast(msg, result.deleted > 0 ? 'success' : 'error');
            loadGallery();
        } catch (e) {
            showToast('删除失败: ' + e.message, 'error');
        }
    }, { title: '移到回收站', btnText: '移到回收站' });
});

// 缩放滑块
document.getElementById('gallery-zoom')?.addEventListener('input', (e) => {
    const size = parseInt(e.target.value, 10) || 100;
    const grid = document.getElementById('gallery-grid');
    if (grid) grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
});

// 打开文件夹
document.getElementById('btn-gallery-open-folder')?.addEventListener('click', async () => {
    try {
        const path = galleryData.base_path || document.getElementById('cfg-rh-download-path')?.value || '~/Downloads/AI生图/';
        await api('POST', '/api/open-download-folder', { path });
    } catch (e) {
        showToast('打开失败: ' + e.message, 'error');
    }
});

// ========== 模型配置 ==========
$('#btn-model-config').addEventListener('click', async () => {
    try {
        const config = await api('GET', '/api/model-config');
        state.modelConfig = config;
        $('#cfg-provider').value = config.provider || 'deepseek';
        $('#cfg-api-key').value = config.api_key || '';
        $('#cfg-base-url').value = config.base_url || '';
        $('#cfg-model-name').value = config.model_name || '';
        $('#cfg-timeout').value = config.timeout_ms || 30000;
        $('#cfg-retry').value = config.retry_count || 1;

        // RunningHub 配置
        $('#cfg-rh-api-key').value = config.rh_api_key || '';
        $('#cfg-rh-base-url').value = config.rh_base_url || '';
        if (config.rh_model) $('#cfg-rh-model').value = config.rh_model;
        if (config.rh_resolution) $('#cfg-rh-resolution').value = config.rh_resolution;
        if (config.rh_aspect_ratio) $('#cfg-rh-aspect-ratio').value = config.rh_aspect_ratio;
        if (config.rh_seed_mode) $('#cfg-rh-seed-mode').value = config.rh_seed_mode;
        if (config.rh_seed) { $('#cfg-rh-seed').value = config.rh_seed; $('#cfg-rh-seed').disabled = config.rh_seed_mode === 'random'; }
        $('#cfg-rh-download-path').value = getGlobalDownloadPath();
        $('#cfg-rh-download-path').dataset.downloadPathInherited = '1';

        // 图片命名前缀
        const prefixInput = document.getElementById('cfg-image-prefix');
        if (prefixInput) prefixInput.value = config.image_prefix || '';

        // OpenAI-HK 配置
        $('#cfg-oaihk-api-key').value = config.oaihk_api_key || '';
        $('#cfg-oaihk-base-url').value = config.oaihk_base_url || '';

        // 上传压缩设置
        const uploadShortEdge = config.upload_short_edge || 1536;
        const seInput = document.getElementById('cfg-upload-short-edge');
        if (seInput) seInput.value = uploadShortEdge;
        // 高亮对应预设按钮
        document.querySelectorAll('#cfg-upload-preset-group .upload-preset-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.value, 10) === uploadShortEdge);
        });

        // 平台选择
        if (config.api_platform) {
            const platformSelect = document.getElementById('cfg-api-platform');
            if (platformSelect) platformSelect.value = config.api_platform;
        }

        // 系统提示词
        $('#cfg-system-prompt-prompt').value = config.system_prompt_prompt || '';
        $('#cfg-system-prompt-bilingual').value = config.system_prompt_bilingual || '';
        $('#cfg-system-prompt-translate').value = config.system_prompt_translate || '';

        updateRhModelParamsInline();
        // 同步内联模型选择
        if (config.rh_model) {
            const inlineModel = document.getElementById('cfg-rh-model-inline');
            if (inlineModel) inlineModel.value = config.rh_model;
            updateRhModelParamsInline();
        }
        openModal('modal-model-config');
        // Render keyboard shortcut settings (3.7)
        if (typeof renderShortcutSettings === 'function') setTimeout(renderShortcutSettings, 50);
    } catch (e) { showToast(e.message, 'error'); }
});

$('#btn-save-config').addEventListener('click', async () => {
    const config = {
        provider: $('#cfg-provider').value, api_key: $('#cfg-api-key').value, base_url: $('#cfg-base-url').value, model_name: $('#cfg-model-name').value, timeout_ms: parseInt($('#cfg-timeout').value, 10) || 30000, retry_count: parseInt($('#cfg-retry').value, 10) || 1,
        // 平台选择
        api_platform: $('#cfg-api-platform')?.value || 'runninghub',
        // RunningHub
        rh_api_key: $('#cfg-rh-api-key').value,
        rh_base_url: $('#cfg-rh-base-url').value,
        rh_model: $('#cfg-rh-model').value,
        rh_resolution: $('#cfg-rh-resolution').value,
        rh_aspect_ratio: $('#cfg-rh-aspect-ratio').value,
        rh_seed_mode: $('#cfg-rh-seed-mode').value,
        rh_seed: $('#cfg-rh-seed').value,
        rh_download_path: queueMode === 'multi'
            ? getGlobalDownloadPath()
            : (cleanDownloadPath($('#cfg-rh-download-path').value) || DEFAULT_DOWNLOAD_PATH_FALLBACK),
        // OpenAI-HK
        oaihk_api_key: $('#cfg-oaihk-api-key').value,
        oaihk_base_url: $('#cfg-oaihk-base-url').value,
        // 上传压缩设置
        upload_short_edge: parseInt($('#cfg-upload-short-edge')?.value, 10) || 1536,
        // 系统提示词
        system_prompt_prompt: $('#cfg-system-prompt-prompt').value,
        system_prompt_bilingual: $('#cfg-system-prompt-bilingual').value,
        system_prompt_translate: $('#cfg-system-prompt-translate').value,
        // 图片命名前缀
        image_prefix: document.getElementById('cfg-image-prefix')?.value?.trim() || ''
    };
    try {
        await api('PUT', '/api/model-config', config);
        state.modelConfig = config;
        closeModal('modal-model-config');
        // 同步到内联模型选择
        const inlineModel = document.getElementById('cfg-rh-model-inline');
        if (inlineModel && config.rh_model) inlineModel.value = config.rh_model;
        updateRhModelParamsInline();
        // 同步平台选择
        const platformSelect = document.getElementById('cfg-api-platform');
        if (platformSelect && config.api_platform) {
            platformSelect.value = config.api_platform;
            togglePlatformUI(config.api_platform);
        }
        showToast('配置已保存', 'success');
    } catch (e) { showToast(e.message, 'error'); }
});

// 上传压缩预设按钮点击
document.querySelectorAll('#cfg-upload-preset-group .upload-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const seInput = document.getElementById('cfg-upload-short-edge');
        if (seInput) seInput.value = btn.dataset.value;
        document.querySelectorAll('#cfg-upload-preset-group .upload-preset-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    });
});

$('#btn-test-connection').addEventListener('click', async () => {
    const btn = $('#btn-test-connection');
    btn.disabled = true;
    btn.textContent = '测试中...';
    try {
        const config = { provider: $('#cfg-provider').value, api_key: $('#cfg-api-key').value, base_url: $('#cfg-base-url').value, model_name: $('#cfg-model-name').value, timeout_ms: parseInt($('#cfg-timeout').value, 10) || 30000 };
        const result = await api('POST', '/api/test-connection', config);
        showToast(result.success ? result.message : result.message, result.success ? 'success' : 'error');
    } catch (e) { showToast(e.message, 'error'); }
    finally { btn.disabled = false; btn.textContent = '测试连接'; }
});

// ========== 删除确认 ==========
function showConfirm(message, callback, options) {
    const opts = options || {};
    $('#delete-message').textContent = message;
    const titleEl = document.getElementById('confirm-title');
    if (titleEl) titleEl.textContent = opts.title || '确认';
    const btnEl = document.getElementById('btn-confirm-delete');
    if (btnEl) btnEl.textContent = opts.btnText || '确认';
    state.deleteCallback = callback;
    openModal('modal-confirm-delete');
}

$('#btn-confirm-delete').addEventListener('click', () => {
    closeModal('modal-confirm-delete');
    if (state.deleteCallback) { state.deleteCallback(); state.deleteCallback = null; }
});

// ========== 弹窗关闭 ==========
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-close') || e.target.dataset.close) {
        const modalId = e.target.dataset.close;
        if (modalId) closeModal(modalId);
    }
    if (e.target.classList.contains('modal-overlay')) closeModal(e.target.id);
});

// ========== 面板拖拽调整宽度 ==========
(function initResize() {
    // 左侧面板
    const handle1 = document.getElementById('resize-handle');
    const panel1 = document.getElementById('config-panel');
    const mainContent = document.querySelector('.main-content');
    if (handle1 && panel1 && mainContent) {
        const savedWidth = localStorage.getItem('config-panel-width');
        if (savedWidth) panel1.style.width = savedWidth;
        let isResizing = false;
        handle1.addEventListener('mousedown', (e) => { isResizing = true; handle1.classList.add('active'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const rect = mainContent.getBoundingClientRect();
            let newWidth = Math.max(240, Math.min(rect.width - 500, e.clientX - rect.left));
            panel1.style.width = newWidth + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            handle1.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('config-panel-width', panel1.style.width);
        });
    }

    // 右侧道具面板
    const handle2 = document.getElementById('resize-handle-2');
    const panel2 = document.getElementById('prop-panel');
    if (handle2 && panel2 && mainContent) {
        const savedWidth2 = localStorage.getItem('prop-panel-width');
        if (savedWidth2) panel2.style.width = savedWidth2;
        let isResizing2 = false;
        handle2.addEventListener('mousedown', (e) => { isResizing2 = true; handle2.classList.add('active'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
        document.addEventListener('mousemove', (e) => {
            if (!isResizing2) return;
            const rect = mainContent.getBoundingClientRect();
            let newWidth = Math.max(160, Math.min(rect.width - 500, rect.right - e.clientX));
            panel2.style.width = newWidth + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!isResizing2) return;
            isResizing2 = false;
            handle2.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('prop-panel-width', panel2.style.width);
        });
    }
})();

// ========== 预设折叠 ==========
$('#preset-collapse-arrow').addEventListener('click', () => {
    state.presetCollapsed = !state.presetCollapsed;
    const arrow = $('#preset-collapse-arrow');
    const toolbar = $('#preset-toolbar');
    const scrollWrapper = $('#preset-scroll-wrapper');
    if (state.presetCollapsed) {
        arrow.classList.add('collapsed');
        toolbar.classList.add('hidden');
        scrollWrapper.classList.add('hidden');
    } else {
        arrow.classList.remove('collapsed');
        toolbar.classList.remove('hidden');
        scrollWrapper.classList.remove('hidden');
    }
});

// ========== 预设缩放滑杆 ==========
$('#preset-zoom-slider').addEventListener('input', (e) => {
    state.presetZoom = parseInt(e.target.value, 10);
    const grid = $('#preset-grid');
    grid.style.gridTemplateColumns = `repeat(${state.presetZoom}, 1fr)`;
    try { localStorage.setItem('preset-zoom', state.presetZoom); } catch(err) {}
});

// ========== 初始化 ==========
// 恢复预设缩放滑杆位置
$('#preset-zoom-slider').value = state.presetZoom || 4;

// 加载完成后移除初始加载指示器
function removeAppLoading() {
    const el = document.getElementById('app-loading');
    if (el) el.remove();
}

// 超时兜底：10秒后强制移除加载指示器
setTimeout(removeAppLoading, 10000);

loadAllData().then(() => {
    setUndoBaseline();
    removeAppLoading();
}).catch(e => {
    removeAppLoading();
    console.error('初始化加载失败:', e);
    logAction('error', '初始化加载失败', { msg: e.message });
    // 在页面上显示错误提示，而不是白屏
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:20px 30px;z-index:99999;text-align:center;max-width:400px;';
    errDiv.innerHTML = `<h3 style="margin:0 0 10px;color:#856404;">加载失败</h3><p style="margin:0 0 10px;color:#666;font-size:13px;">页面初始化出错，请刷新重试</p><button onclick="location.reload()" style="padding:6px 16px;border:1px solid #ccc;border-radius:4px;cursor:pointer;">刷新重试</button>`;
    document.body.appendChild(errDiv);
});

// ========== 文生图系统 ==========

const imageState = {
    loaded: false,
    library: [],
    presets: [],
    presetTags: [...DEFAULT_PRESET_TAGS],  // 图生图预设分类标签（复制文生图）
    selectedImgPresetTags: [],  // 保存预设时选中的标签
    imgPresetFilterTag: '',     // 预设列表筛选标签
    imgPresetZoom: 3,           // 预设缩放列数
    slots: [
        { image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' },
        { image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' }
    ],
    promptCn: '',
    promptEn: '',
    activeSlotIndex: 0,
    expandedLibCategory: null,
    expandedLibSubcategory: null,
    libSearchKeyword: '',
    presetSearchKeyword: '',
    presetSortBy: 'default',   // 预设排序方式: default/name/created_at/updated_at
    libZoom: 2,  // 素材库缩放列数
    activeLibTab: 'library'  // 'library' or 'preset'
};
let splitModeLoaded = false; // 拆图模块是否已完成一次数据加载

// ---------- 多图队列系统 ----------
// QUEUE_COUNT 已在文件顶部声明
let queueMode = 'same'; // 'same' = 同图抽卡, 'multi' = 多图队列
let activeQueue = 0;     // 当前活动的队列编号 (0-9)

// 每个队列独立的数据：{ slots: [...], promptCn: '', promptEn: '', results: [...], apiPlatform, rhModelId, ... }
let queueData = [];
let _saveQueueTimer = null; // saveQueueData 防抖定时器
function initQueueData() {
    // 队列数据现在从服务端加载（loadAllData 中处理）
    // 这里仅确保有10个队列
    while (queueData.length < QUEUE_COUNT) {
        queueData.push({
            slots: Array.from({length: SLOT_COUNT}, () => ({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' })),
            promptCn: '',
            promptEn: '',
            results: [],
            apiPlatform: 'oaihk',
            rhModelId: '',
            oaihkModelId: 'fal-ai/banana/v3.1/flash/2k',
            rhAspectRatio: '3:4',
            oaihkAspectRatio: '3:4',
            rhResolution: '1k',
            rhCount: 1,
            rhSeedMode: 'random',
            rhSeed: '',
            downloadPath: '',
            imagePrefix: '',
            autoBackup: true
        });
    }
    // 兼容旧数据：确保每个队列都有新字段
    for (let q = 0; q < queueData.length; q++) {
        if (!queueData[q].results) queueData[q].results = [];
        if (!queueData[q].apiPlatform) queueData[q].apiPlatform = 'oaihk';
        if (!queueData[q].rhModelId) queueData[q].rhModelId = '';
        if (!queueData[q].oaihkModelId) queueData[q].oaihkModelId = 'fal-ai/banana/v3.1/flash/2k';
        if (!queueData[q].rhAspectRatio) queueData[q].rhAspectRatio = '3:4';
        if (!queueData[q].oaihkAspectRatio) queueData[q].oaihkAspectRatio = '3:4';
        if (!queueData[q].rhResolution) queueData[q].rhResolution = '1k';
        if (queueData[q].rhCount === undefined) queueData[q].rhCount = 1;
        if (!queueData[q].rhSeedMode) queueData[q].rhSeedMode = 'random';
        if (queueData[q].rhSeed === undefined) queueData[q].rhSeed = '';
        if (queueData[q].downloadPath === undefined) queueData[q].downloadPath = '';
        if (queueData[q].imagePrefix === undefined) queueData[q].imagePrefix = '';
        if (queueData[q].autoBackup === undefined) queueData[q].autoBackup = true;
        // 兼容旧数据：确保每个槽位有 DW 字段
        if (queueData[q].slots) {
            for (let s = 0; s < queueData[q].slots.length; s++) {
                if (queueData[q].slots[s].dwEnabled === undefined) queueData[q].slots[s].dwEnabled = false;
                if (queueData[q].slots[s].dwOriginalImage === undefined) queueData[q].slots[s].dwOriginalImage = '';
            }
        }
    }
}

// ---------- 拆图队列系统（独立模块） ----------
let activeSplitQueue = 0;
let splitQueueData = [];
function initSplitQueueData() {
    while (splitQueueData.length < QUEUE_COUNT) {
        splitQueueData.push({
            gridImageUrl: '',
            imageUrl: '',           // 九宫格原图URL
            croppedImageUrl: '',    // 裁剪后的图URL（裁剪模式）
            promptCn: '',           // 提示词
            number: 0,              // 编号
            selectedNums: [],       // 该队列独立的编号选中状态
            workItems: [],
            activeItemIndex: 0,
            selectedPrefixIds: [],
            selectedSuffixIds: [],
            results: [],
            apiPlatform: 'oaihk',
            rhModelId: '',
            oaihkModelId: 'fal-ai/banana/v3.1/flash/2k',
            rhAspectRatio: '3:4',
            oaihkAspectRatio: '3:4',
            rhResolution: '1k',
            rhCount: 1,
            rhSeedMode: 'random',
            rhSeed: '',
            downloadPath: '',
            imagePrefix: '',
            autoBackup: true,
            cropPreset: null,
            sourceFilename: '',
            learnedGridLayout: null,
            /** 用户手动改过比例后为 true；裁剪框变更后清零并重新自动匹配横竖比例 */
            splitAspectRatioManualOverride: false,
            materials: [],
            activeMaterialIndex: 0
        });
    }
    // 兼容旧数据
    for (let q = 0; q < splitQueueData.length; q++) {
        if (splitQueueData[q].gridImageUrl === undefined) splitQueueData[q].gridImageUrl = '';
        if (!Array.isArray(splitQueueData[q].selectedNums)) splitQueueData[q].selectedNums = [];
        if (!splitQueueData[q].results) splitQueueData[q].results = [];
        if (!Array.isArray(splitQueueData[q].workItems)) splitQueueData[q].workItems = [];
        if (splitQueueData[q].activeItemIndex === undefined) splitQueueData[q].activeItemIndex = 0;
        if (!splitQueueData[q].apiPlatform) splitQueueData[q].apiPlatform = 'oaihk';
        if (!splitQueueData[q].oaihkModelId) splitQueueData[q].oaihkModelId = 'fal-ai/banana/v3.1/flash/2k';
        if (!splitQueueData[q].oaihkAspectRatio) splitQueueData[q].oaihkAspectRatio = '3:4';
        if (splitQueueData[q].downloadPath === undefined) splitQueueData[q].downloadPath = '';
        if (splitQueueData[q].imagePrefix === undefined) splitQueueData[q].imagePrefix = '';
        if (splitQueueData[q].autoBackup === undefined) splitQueueData[q].autoBackup = true;
        if (splitQueueData[q].cropPreset === undefined) splitQueueData[q].cropPreset = null;
        if (splitQueueData[q].sourceFilename === undefined) splitQueueData[q].sourceFilename = '';
        if (splitQueueData[q].learnedGridLayout === undefined) splitQueueData[q].learnedGridLayout = null;
        if (splitQueueData[q].splitAspectRatioManualOverride === undefined) splitQueueData[q].splitAspectRatioManualOverride = false;
        if (!Array.isArray(splitQueueData[q].materials)) splitQueueData[q].materials = [];
        if (splitQueueData[q].activeMaterialIndex === undefined) splitQueueData[q].activeMaterialIndex = 0;
        if (!Array.isArray(splitQueueData[q].failedItems)) splitQueueData[q].failedItems = [];
        if (splitQueueData[q].workItems.length === 0 && (splitQueueData[q].imageUrl || splitQueueData[q].croppedImageUrl)) {
            splitQueueData[q].workItems.push({
                imageUrl: splitQueueData[q].imageUrl || '',
                gridImageUrl: splitQueueData[q].gridImageUrl || splitQueueData[q].imageUrl || '',
                croppedImageUrl: splitQueueData[q].croppedImageUrl || '',
                cropRect: splitQueueData[q].cropRect || null,
                cropPreset: splitQueueData[q].cropPreset || null,
                promptCn: splitQueueData[q].promptCn || '',
                number: splitQueueData[q].number || (q + 1),
                selectedPrefixIds: dedupeTemplateIds(splitQueueData[q].selectedPrefixIds || []),
                selectedSuffixIds: dedupeTemplateIds(splitQueueData[q].selectedSuffixIds || [])
            });
        }
    }
    normalizeSplitQueueWorkItems();
}

function normalizeSplitQueueWorkItems() {
    let changed = false;
    for (let q = 0; q < splitQueueData.length; q++) {
        const qd = splitQueueData[q];
        if (!qd || !Array.isArray(qd.workItems)) continue;
        const queueGridUrl = qd.gridImageUrl || qd.imageUrl || '';
        qd.workItems.forEach(item => {
            if (!item || typeof item !== 'object') return;
            if (item.gridImageUrl === undefined) {
                item.gridImageUrl = '';
                changed = true;
            }
            if (item.cropRect && !item.gridImageUrl) {
                const fallbackGridUrl = queueGridUrl || item.imageUrl || '';
                if (fallbackGridUrl) {
                    item.gridImageUrl = fallbackGridUrl;
                    changed = true;
                }
            }
            if (!qd.gridImageUrl && item.gridImageUrl) {
                qd.gridImageUrl = item.gridImageUrl;
                changed = true;
            }
            if (item.cropPreset === undefined) {
                item.cropPreset = qd.cropPreset || null;
                changed = true;
            }
            const dp = dedupeTemplateIds(item.selectedPrefixIds);
            const ds = dedupeTemplateIds(item.selectedSuffixIds);
            if ((item.selectedPrefixIds || []).length !== dp.length) {
                item.selectedPrefixIds = dp;
                changed = true;
            }
            if ((item.selectedSuffixIds || []).length !== ds.length) {
                item.selectedSuffixIds = ds;
                changed = true;
            }
        });
        const qDp = dedupeTemplateIds(qd.selectedPrefixIds);
        const qDs = dedupeTemplateIds(qd.selectedSuffixIds);
        if ((qd.selectedPrefixIds || []).length !== qDp.length) {
            qd.selectedPrefixIds = qDp;
            changed = true;
        }
        if ((qd.selectedSuffixIds || []).length !== qDs.length) {
            qd.selectedSuffixIds = qDs;
            changed = true;
        }
    }
    return changed;
}

function normalizeSplitQueueMaterials(qd) {
    if (!qd || typeof qd !== 'object') return;
    if (!Array.isArray(qd.materials)) qd.materials = [];
    if (typeof qd.activeMaterialIndex !== 'number' || qd.activeMaterialIndex < 0) qd.activeMaterialIndex = 0;
    if (qd.materials.length === 0) {
        qd.materials.push({
            gridImageUrl: qd.gridImageUrl || '',
            sourceFilename: qd.sourceFilename || '',
            selectedNums: Array.isArray(qd.selectedNums) ? [...qd.selectedNums] : [],
            learnedGridLayout: qd.learnedGridLayout ?? null,
            cropPreset: qd.cropPreset ?? null,
            workItems: deepClone(qd.workItems || [])
        });
        qd.activeMaterialIndex = 0;
    } else {
        qd.activeMaterialIndex = Math.min(qd.activeMaterialIndex, qd.materials.length - 1);
        qd.materials.forEach(m => {
            if (!m || typeof m !== 'object') return;
            if (!Array.isArray(m.workItems)) m.workItems = [];
            if (!Array.isArray(m.selectedNums)) m.selectedNums = [];
            if (m.gridImageUrl === undefined) m.gridImageUrl = '';
            if (m.sourceFilename === undefined) m.sourceFilename = '';
            if (m.learnedGridLayout === undefined) m.learnedGridLayout = null;
            if (m.cropPreset === undefined) m.cropPreset = null;
        });
    }
}

function persistActiveSplitMaterial(qd) {
    normalizeSplitQueueMaterials(qd);
    const idx = Math.max(0, Math.min(qd.activeMaterialIndex || 0, qd.materials.length - 1));
    qd.activeMaterialIndex = idx;
    const m = qd.materials[idx];
    if (!m) return;
    m.gridImageUrl = qd.gridImageUrl || '';
    m.sourceFilename = qd.sourceFilename || '';
    m.selectedNums = Array.isArray(qd.selectedNums) ? [...qd.selectedNums] : [];
    m.learnedGridLayout = qd.learnedGridLayout ?? null;
    m.cropPreset = qd.cropPreset ?? null;
    m.workItems = deepClone(qd.workItems || []);
}

function loadActiveSplitMaterialIntoQueue(qd, idx) {
    normalizeSplitQueueMaterials(qd);
    idx = Math.max(0, Math.min(idx, qd.materials.length - 1));
    qd.activeMaterialIndex = idx;
    const m = qd.materials[idx];
    if (!m) return;
    qd.gridImageUrl = m.gridImageUrl || '';
    qd.sourceFilename = m.sourceFilename || '';
    qd.selectedNums = Array.isArray(m.selectedNums) ? [...m.selectedNums] : [];
    qd.learnedGridLayout = m.learnedGridLayout ?? null;
    qd.cropPreset = m.cropPreset ?? null;
    qd.workItems = deepClone(m.workItems || []);
    if (typeof qd.activeItemIndex !== 'number') qd.activeItemIndex = 0;
    if (qd.workItems.length === 0) qd.activeItemIndex = 0;
    else qd.activeItemIndex = Math.min(qd.activeItemIndex, qd.workItems.length - 1);
}

function renderSplitMaterialTabs(qi) {
    const wrap = document.getElementById('split-material-tabs');
    if (!wrap) return;
    const qd = splitQueueData[qi];
    if (!qd) return;
    normalizeSplitQueueMaterials(qd);
    wrap.innerHTML = '';
    if (qd.materials.length <= 1) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.flexWrap = 'wrap';
    wrap.style.gap = '4px';
    const hint = document.createElement('span');
    hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-right:4px;white-space:nowrap;';
    hint.textContent = '素材';
    wrap.appendChild(hint);
    qd.materials.forEach((_, mi) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `split-num-btn ${mi === qd.activeMaterialIndex ? 'active' : ''}`;
        btn.textContent = String(mi + 1);
        btn.title = `切换到素材 ${mi + 1}`;
        btn.addEventListener('click', () => {
            if (qi !== activeSplitQueue) switchToSplitQueue(qi);
            const qd2 = splitQueueData[qi];
            if (!qd2 || qd2.activeMaterialIndex === mi) return;
            persistActiveSplitMaterial(qd2);
            loadActiveSplitMaterialIntoQueue(qd2, mi);
            splitImageUrl = qd2.gridImageUrl || '';
            splitGridImageUrl = splitImageUrl;
            renderSplitMaterialTabs(qi);
            loadSplitQueueToUI(qi);
            saveSplitQueueData();
        });
        wrap.appendChild(btn);
    });
}

let splitGenerateStates = Array.from({length: 10}, () => ({
    running: false,
    cancelled: false,
    abortController: null,
    progressPercent: 0,
    progressText: '',
    /** 当前生成任务在结果区的占位卡总数（与批次迭代次数一致，用于切队列后恢复骨架屏） */
    batchVisualTotal: 0,
    batchVisualFilled: 0
}));
// 拆图生成允许多队列并发进入，但外部 API 请求统一串行 FIFO
let splitApiDispatchChain = Promise.resolve();
let splitApiDispatchSeq = 0;
const SPLIT_QUEUE_LOCAL_KEY = 'splitQueueDataLocal_v2';

function saveSplitQueueLocalFallback() {
    try {
        localStorage.setItem(SPLIT_QUEUE_LOCAL_KEY, JSON.stringify({
            queues: splitQueueData,
            activeQueue: activeSplitQueue,
            ts: Date.now()
        }));
    } catch (e) {
        // ignore
    }
}

function loadSplitQueueLocalFallback() {
    try {
        const raw = localStorage.getItem(SPLIT_QUEUE_LOCAL_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.queues)) return false;
        for (let i = 0; i < QUEUE_COUNT; i++) {
            if (data.queues[i]) {
                splitQueueData[i] = { ...splitQueueData[i], ...data.queues[i] };
            }
        }
        if (typeof data.activeQueue === 'number' && data.activeQueue >= 0 && data.activeQueue < QUEUE_COUNT) {
            activeSplitQueue = data.activeQueue;
        }
        if (normalizeSplitQueueWorkItems()) saveSplitQueueLocalFallback();
        return true;
    } catch (e) {
        return false;
    }
}

// 拆图上传/编号选择状态
let splitImageUrl = '';
let splitMode = 'crop'; // 'crop' | 'nocrop'
let splitGridImageUrl = ''; // 原始九宫格URL

let _saveSplitQueueTimer = null;
function saveSplitQueueData() {
    syncUndoBaselineAfterMutation();
    // 无论后端是否可用，先落本地，保证刷新不丢
    saveSplitQueueLocalFallback();
    if (_saveSplitQueueTimer) clearTimeout(_saveSplitQueueTimer);
    _saveSplitQueueTimer = setTimeout(() => {
        api('PUT', '/api/split-queue-data', {
            queues: splitQueueData,
            activeQueue: activeSplitQueue
        }, 60000, undefined, true).catch(e => {
            console.error('保存拆图队列数据失败:', e);
            if ((e?.message || '').includes('404')) {
                showToast('拆图后端接口不可用，已改为本地临时保存（请重启软件后端）', 'warning');
            }
        });
    }, 300);
}
async function saveSplitQueueDataNow() {
    syncUndoBaselineAfterMutation();
    saveSplitQueueLocalFallback();
    if (_saveSplitQueueTimer) { clearTimeout(_saveSplitQueueTimer); _saveSplitQueueTimer = null; }
    await api('PUT', '/api/split-queue-data', {
        queues: splitQueueData,
        activeQueue: activeSplitQueue
    }, 60000, undefined, true).catch(e => {
        console.error('立即保存拆图队列失败:', e);
        if ((e?.message || '').includes('404')) {
            showToast('拆图后端接口不可用，已改为本地临时保存（请重启软件后端）', 'warning');
        }
    });
}

function isAnySplitQueueGenerating() {
    return splitGenerateStates.some(s => s.running);
}

function getSplitQueueProgressStat(qi) {
    const qd = splitQueueData[qi] || {};
    const total = Math.max(0, parseInt(qd.progressTotal ?? ((qd.workItems || []).filter(it => it?.croppedImageUrl || it?.imageUrl).length), 10) || 0);
    const doneRaw = parseInt(qd.progressDone ?? Math.min((qd.results || []).length, total), 10) || 0;
    const done = Math.max(0, Math.min(doneRaw, total));
    return { total, done };
}

/** 当前拆图队列批量生成全部结束时的提示音（Web Audio，无需音频文件；浏览器静音或无权限时静默失败） */
function playSplitQueueCompleteChime() {
    try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = new AC();
        const p = ctx.resume?.();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        const now = ctx.currentTime;
        const ding = (freq, start) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = freq;
            o.connect(g);
            g.connect(ctx.destination);
            g.gain.setValueAtTime(0, start);
            g.gain.linearRampToValueAtTime(0.1, start + 0.03);
            g.gain.linearRampToValueAtTime(0, start + 0.18);
            o.start(start);
            o.stop(start + 0.2);
        };
        ding(784, now);
        ding(988, now + 0.14);
    } catch (_) { /* ignore */ }
}

/** 限制异步并行数量（结果数组与 items 下标一致）。onEach(i, entry) 在每个任务 settle 后立刻调用，便于刷新进度 UI */
async function mapWithConcurrency(items, limit, mapper, onEach) {
    const arr = Array.isArray(items) ? items : [];
    const results = new Array(arr.length);
    let nextIndex = 0;
    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= arr.length) break;
            try {
                const value = await mapper(arr[i], i);
                results[i] = { status: 'fulfilled', value };
                if (typeof onEach === 'function') {
                    try {
                        onEach(i, results[i]);
                    } catch (_) { /* ignore */ }
                }
            } catch (reason) {
                results[i] = { status: 'rejected', reason };
                if (typeof onEach === 'function') {
                    try {
                        onEach(i, results[i]);
                    } catch (_) { /* ignore */ }
                }
            }
        }
    }
    const n = Math.min(Math.max(1, limit || 1), Math.max(1, arr.length));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
}

let splitGlobalActiveJobs = 0;
const splitGlobalJobQueue = [];

function createSplitAbortError() {
    try {
        return new DOMException('Aborted', 'AbortError');
    } catch (_) {
        const err = new Error('Aborted');
        err.name = 'AbortError';
        return err;
    }
}

function removeSplitGlobalQueuedJob(entry) {
    const idx = splitGlobalJobQueue.indexOf(entry);
    if (idx >= 0) splitGlobalJobQueue.splice(idx, 1);
}

function pumpSplitGlobalJobQueue() {
    while (splitGlobalActiveJobs < SPLIT_GLOBAL_GEN_CONCURRENCY && splitGlobalJobQueue.length > 0) {
        const entry = splitGlobalJobQueue.shift();
        if (!entry || entry.cancelled) continue;
        entry.start();
    }
}

function runWithSplitGlobalConcurrency(taskFn, signal) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            if (signal?.removeEventListener) signal.removeEventListener('abort', onAbort);
            fn(value);
        };
        const entry = {
            cancelled: false,
            start: () => {
                if (entry.cancelled || settled) return;
                if (signal?.aborted) {
                    finish(reject, createSplitAbortError());
                    return;
                }
                splitGlobalActiveJobs++;
                Promise.resolve()
                    .then(taskFn)
                    .then(value => finish(resolve, value), reason => finish(reject, reason))
                    .finally(() => {
                        splitGlobalActiveJobs = Math.max(0, splitGlobalActiveJobs - 1);
                        pumpSplitGlobalJobQueue();
                    });
            }
        };
        const onAbort = () => {
            entry.cancelled = true;
            removeSplitGlobalQueuedJob(entry);
            finish(reject, createSplitAbortError());
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        if (signal?.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
        splitGlobalJobQueue.push(entry);
        pumpSplitGlobalJobQueue();
    });
}

function renderSplitNumSelectionForQueue(qi = activeSplitQueue) {
    const selected = Array.isArray(splitQueueData[qi]?.selectedNums) ? splitQueueData[qi].selectedNums : [];
    document.querySelectorAll('.grid-split-number-row .split-num-btn').forEach(btn => {
        const num = parseInt(btn.dataset.num, 10);
        if (!Number.isFinite(num)) return;
        btn.classList.toggle('active', selected.includes(num));
    });
}

function syncSplitProgressUI() {
    const progressWrap = document.getElementById('split-progress-bar-wrap');
    const progressBar = document.getElementById('split-progress-bar');
    const progressText = document.getElementById('split-progress-text');
    const cancelBtn = document.getElementById('btn-split-cancel');
    if (!progressWrap || !progressBar || !progressText || !cancelBtn) return;

    const activeState = splitGenerateStates[activeSplitQueue];
    if (activeState?.running) {
        progressWrap.style.display = '';
        progressText.style.display = '';
        progressBar.style.width = `${Math.max(0, Math.min(100, activeState.progressPercent || 0))}%`;
        progressText.textContent = activeState.progressText || `队列${activeSplitQueue + 1}生成中...`;
        cancelBtn.style.display = '';
        return;
    }

    const runningIdx = splitGenerateStates.findIndex(s => s.running);
    if (runningIdx >= 0) {
        // 非当前队列在生成时，不占用当前队列的进度/按钮显示
        progressWrap.style.display = 'none';
        progressText.style.display = 'none';
        cancelBtn.style.display = 'none';
        return;
    }

    progressWrap.style.display = 'none';
    progressText.style.display = 'none';
    cancelBtn.style.display = 'none';
}

async function loadSplitModeData() {
    if (splitModeLoaded) return;
    initSplitQueueData();
    try {
        const resp = await api('GET', '/api/split-queue-data', null, 30000);
        if (resp && resp.queues && resp.queues.length > 0) {
            for (let i = 0; i < QUEUE_COUNT; i++) {
                if (resp.queues[i]) {
                    splitQueueData[i] = { ...splitQueueData[i], ...resp.queues[i] };
                    if (!splitQueueData[i].results) splitQueueData[i].results = [];
                }
            }
            if (typeof resp.activeQueue === 'number' && resp.activeQueue >= 0 && resp.activeQueue < QUEUE_COUNT) {
                activeSplitQueue = resp.activeQueue;
            }
            if (normalizeSplitQueueWorkItems()) saveSplitQueueData();
        }
    } catch(e) {
        console.error('加载拆图队列数据失败:', e);
        const restored = loadSplitQueueLocalFallback();
        if (restored) {
            showToast('拆图数据已从本地恢复（后端接口异常）', 'warning');
        } else if ((e?.message || '').includes('404')) {
            showToast('当前后端不支持拆图队列接口，请重启到最新版本', 'error');
        }
    }
    splitModeLoaded = true;
    loadSplitTemplate(getCurrentSplitMode());
    await renderSplitLibrary();
    renderSplitQueueNumberBar();
    switchToSplitQueue(activeSplitQueue);
}

function saveCurrentSplitQueueData() {
    const qd = splitQueueData[activeSplitQueue];
    if (!qd) return;
    const activeItem = getActiveSplitWorkItem(activeSplitQueue);
    const promptEl = document.getElementById('split-prompt-cn');
    if (promptEl && activeItem) activeItem.promptCn = promptEl.value;
    // 读取API配置
    readSplitApiConfigToQueue(activeSplitQueue);
    syncActiveSplitItemToQueue(activeSplitQueue);
    persistActiveSplitMaterial(qd);
    saveSplitQueueData();
}

/** 将当前提示词框内容写入本拆图队列全部编号的 workItem（verbatim） */
function syncSplitPromptToAllWorkItems() {
    const qi = activeSplitQueue;
    const qd = splitQueueData[qi];
    if (!qd || !Array.isArray(qd.workItems) || qd.workItems.length === 0) {
        showToast('当前队列没有拆图工作项', 'warning');
        return;
    }
    const promptEl = document.getElementById('split-prompt-cn');
    const text = promptEl ? promptEl.value : '';
    qd.workItems.forEach(item => {
        if (item) item.promptCn = text;
    });
    qd.promptCn = text;
    syncActiveSplitItemToQueue(qi);
    persistActiveSplitMaterial(qd);
    saveSplitQueueData();
    normalizeSplitQueueMaterials(qd);
    const matHint = qd.materials.length > 1 ? `（当前素材 ${qd.activeMaterialIndex + 1}）` : '';
    showToast(`已同步到本队列当前素材${matHint}全部 ${qd.workItems.length} 个格子编号`, 'success');
}

function readSplitApiConfigToQueue(qi) {
    const qd = splitQueueData[qi];
    if (!qd) return;
    const platformEl = document.getElementById('split-cfg-api-platform');
    if (platformEl) qd.apiPlatform = platformEl.value;
    const rhModelEl = document.getElementById('split-cfg-rh-model');
    if (rhModelEl) qd.rhModelId = rhModelEl.value;
    const oaihkModelEl = document.getElementById('split-cfg-oaihk-model');
    if (oaihkModelEl) qd.oaihkModelId = oaihkModelEl.value;
    const rhArEl = document.getElementById('split-cfg-rh-aspect-ratio');
    if (rhArEl) qd.rhAspectRatio = rhArEl.value;
    const oaihkArEl = document.getElementById('split-cfg-oaihk-aspect-ratio');
    if (oaihkArEl) qd.oaihkAspectRatio = oaihkArEl.value;
    const rhResEl = document.getElementById('split-cfg-rh-resolution');
    if (rhResEl) qd.rhResolution = rhResEl.value;
    const rhCountEl = document.getElementById('split-cfg-rh-count');
    if (rhCountEl) qd.rhCount = parseInt(rhCountEl.value, 10) || 1;
    const rhSeedModeEl = document.getElementById('split-cfg-rh-seed-mode');
    if (rhSeedModeEl) qd.rhSeedMode = rhSeedModeEl.value;
    const rhSeedEl = document.getElementById('split-cfg-rh-seed');
    if (rhSeedEl) qd.rhSeed = rhSeedEl.value;
    const dlPathEl = document.getElementById('split-cfg-download-path');
    if (dlPathEl) qd.downloadPath = readDownloadPathInputForOwner('split-cfg-download-path');
    const prefixEl = document.getElementById('split-cfg-image-prefix');
    if (prefixEl) qd.imagePrefix = prefixEl.value;
    const autoBackupEl = document.getElementById('split-cfg-auto-backup');
    if (autoBackupEl) qd.autoBackup = autoBackupEl.checked;
}

/** 按当前 RH 模型重建拆图比例下拉，并校正 qd.rhAspectRatio */
function syncSplitRhAspectRatioSelectForQueue(qd) {
    const aspectSelect = document.getElementById('split-cfg-rh-aspect-ratio');
    if (!aspectSelect || !qd) return;
    const modelId = qd.rhModelId || document.getElementById('split-cfg-rh-model')?.value || '';
    const model = RH_MODELS[modelId];
    const ratios = model?.aspectRatios;
    if (!ratios?.length) return;
    aspectSelect.innerHTML = '';
    for (const ratio of ratios) {
        const opt = document.createElement('option');
        opt.value = ratio;
        opt.textContent = ratio === 'auto' ? '自适应' : ratio;
        aspectSelect.appendChild(opt);
    }
    let val = qd.rhAspectRatio;
    if (!ratios.includes(val)) {
        val = ratios.includes('3:4') ? '3:4' : ratios.includes('4:3') ? '4:3' : ratios[0];
        qd.rhAspectRatio = val;
    }
    aspectSelect.value = val;
}

function pickAspectRatioFromAllowedList(allowed, pref) {
    if (!allowed?.length) return pref;
    if (allowed.includes(pref)) return pref;
    const alt = pref === '4:3' ? '3:4' : '4:3';
    if (allowed.includes(alt)) return alt;
    if (pref === '4:3') {
        for (const x of ['16:9', '3:2', '21:9']) if (allowed.includes(x)) return x;
    }
    if (pref === '3:4') {
        for (const x of ['9:16', '2:3', '4:5']) if (allowed.includes(x)) return x;
    }
    return allowed.includes('auto') ? 'auto' : allowed[0];
}

/** 裁剪框相对宽高 → 期望出图比例：横裁 4:3，竖裁 3:4，近似正方默认 3:4 */
function inferSplitOutputAspectFromCropRect(rect) {
    if (!rect || typeof rect.w !== 'number' || typeof rect.h !== 'number') return null;
    const { w, h } = rect;
    if (w <= 0 || h <= 0) return null;
    const tol = 0.02;
    if (Math.abs(w - h) <= tol) return '3:4';
    return w > h ? '4:3' : '3:4';
}

function applyPreferredAspectToSplitQueue(qd, pref, qi) {
    if (!qd || !pref) return;
    const platform = qd.apiPlatform || 'oaihk';
    if (platform === 'runninghub') {
        const model = RH_MODELS[qd.rhModelId];
        if (!model?.aspectRatios?.length) return;
        const picked = pickAspectRatioFromAllowedList(model.aspectRatios, pref);
        qd.rhAspectRatio = picked;
        if (qi === activeSplitQueue) {
            const sel = document.getElementById('split-cfg-rh-aspect-ratio');
            if (sel && [...sel.options].some(o => o.value === picked)) sel.value = picked;
        }
    } else {
        const model = OAIHK_MODELS[qd.oaihkModelId];
        const allowed = ['3:4', '2:3', '1:1', '9:16', '4:3', '16:9'];
        const picked = pickAspectRatioFromAllowedList(allowed, pref);
        qd.oaihkAspectRatio = picked;
        if (qi === activeSplitQueue && !model?.isGptImage) {
            const sel = document.getElementById('split-cfg-oaihk-aspect-ratio');
            if (sel && [...sel.options].some(o => o.value === picked)) sel.value = picked;
        }
    }
}

/** 根据当前激活编号的裁剪框自动设置 RH/HK 出图比例（未手动锁定时） */
function applySplitAutoAspectRatioFromCrop(qi) {
    const qd = splitQueueData[qi];
    if (!qd || qd.splitAspectRatioManualOverride) return;
    const item = getActiveSplitWorkItem(qi);
    const pref = inferSplitOutputAspectFromCropRect(item?.cropRect);
    if (!pref) return;
    applyPreferredAspectToSplitQueue(qd, pref, qi);
}

function writeSplitApiConfigFromQueue(qi) {
    const qd = splitQueueData[qi];
    if (!qd) return;
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    setVal('split-cfg-api-platform', qd.apiPlatform || 'oaihk');
    setVal('split-cfg-rh-model', qd.rhModelId || '');
    setVal('split-cfg-oaihk-model', qd.oaihkModelId || 'fal-ai/banana/v3.1/flash/2k');
    syncSplitRhAspectRatioSelectForQueue(qd);
    setVal('split-cfg-oaihk-aspect-ratio', qd.oaihkAspectRatio || '3:4');
    setVal('split-cfg-rh-resolution', qd.rhResolution || '1k');
    setVal('split-cfg-rh-count', qd.rhCount || 1);
    setVal('split-cfg-rh-seed-mode', qd.rhSeedMode || 'random');
    setVal('split-cfg-rh-seed', qd.rhSeed || '');
    writeDownloadPathInputFromOwner('split-cfg-download-path', qd.downloadPath);
    setVal('split-cfg-image-prefix', qd.imagePrefix || '');
    const autoEl = document.getElementById('split-cfg-auto-backup');
    if (autoEl) autoEl.checked = qd.autoBackup !== false;
    // 触发平台切换
    updateSplitApiPlatformUI();
}

function updateSplitApiPlatformUI() {
    const platform = document.getElementById('split-cfg-api-platform')?.value || 'oaihk';
    const rhModelGroup = document.getElementById('split-cfg-rh-model');
    const oaihkModelGroup = document.getElementById('split-cfg-oaihk-model');
    const oaihkArGroup = document.getElementById('split-oaihk-aspect-ratio-group');
    const rhResGroup = document.getElementById('split-rh-resolution-group');
    if (rhModelGroup) rhModelGroup.style.display = platform === 'runninghub' ? '' : 'none';
    if (oaihkModelGroup) oaihkModelGroup.style.display = platform === 'oaihk' ? '' : 'none';
    if (oaihkArGroup) {
        if (platform === 'oaihk') {
            const hkModel = OAIHK_MODELS[oaihkModelGroup?.value];
            oaihkArGroup.style.display = hkModel?.isGptImage ? 'none' : 'flex';
        } else {
            oaihkArGroup.style.display = 'none';
        }
    }
    if (rhResGroup) rhResGroup.style.display = platform === 'runninghub' ? 'flex' : 'none';
    const seedInput = document.getElementById('split-cfg-rh-seed');
    const seedMode = document.getElementById('split-cfg-rh-seed-mode')?.value;
    if (seedInput) seedInput.disabled = seedMode !== 'fixed';
    // 更新价格标签
    const oaihkPriceTag = document.getElementById('split-oaihk-price-tag');
    const rhPriceTag = document.getElementById('split-rh-price-tag');
    if (platform === 'oaihk') {
        const model = OAIHK_MODELS[oaihkModelGroup?.value];
        if (oaihkPriceTag) { oaihkPriceTag.textContent = model?.price || ''; oaihkPriceTag.style.display = ''; }
        if (rhPriceTag) rhPriceTag.style.display = 'none';
    } else {
        const rhModel = RH_MODELS?.[rhModelGroup?.value];
        if (rhPriceTag) { rhPriceTag.textContent = rhModel?.price || ''; rhPriceTag.style.display = rhModel?.price ? '' : 'none'; }
        if (oaihkPriceTag) oaihkPriceTag.style.display = 'none';
    }
    updateSplitDefaultModelBadge();
}

function renderSplitQueueNumberBar() {
    const bar = document.getElementById('split-queue-number-bar');
    if (!bar) return;
    bar.innerHTML = '';
    for (let i = 0; i < QUEUE_COUNT; i++) {
        const btn = document.createElement('button');
        btn.className = 'queue-num-btn' + (i === activeSplitQueue ? ' active' : '');
        btn.textContent = i + 1;
        btn.dataset.queue = i;
        // 显示队列状态指示器
        const qd = splitQueueData[i];
        normalizeSplitQueueMaterials(qd);
        const anyMatGrid = (qd.materials || []).some(m => m?.gridImageUrl);
        const anyMatWork = (qd.materials || []).some(m => (m?.workItems || []).length > 0);
        const hasSplitData = anyMatWork || anyMatGrid || (qd.workItems || []).length > 0 || qd.gridImageUrl;
        if (qd && hasSplitData) {
            btn.style.background = 'var(--accent-light, #ede9fe)';
            btn.style.borderColor = 'var(--accent, #7c3aed)';
        }
        if (splitGenerateStates[i]?.running) {
            btn.style.background = '#fef3c7';
            btn.style.borderColor = '#f59e0b';
            btn.classList.add('generating');
        }
        const { total, done } = getSplitQueueProgressStat(i);
        if (total > 0) {
            const dot = document.createElement('span');
            dot.className = 'queue-result-dot';
            dot.textContent = `${total}-${done}`;
            btn.appendChild(dot);
        }
        btn.addEventListener('click', () => switchToSplitQueue(i));
        bar.appendChild(btn);
    }
}

function switchToSplitQueue(targetQueue) {
    if (targetQueue < 0 || targetQueue >= QUEUE_COUNT) return;
    // 保存当前队列数据
    saveCurrentSplitQueueData();
    activeSplitQueue = targetQueue;
    const qd = splitQueueData[targetQueue];
    if (qd) {
        normalizeSplitQueueMaterials(qd);
        loadActiveSplitMaterialIntoQueue(qd, qd.activeMaterialIndex);
        splitImageUrl = getEffectiveSplitGridPreviewUrl(targetQueue);
        splitGridImageUrl = splitImageUrl;
    }
    // 恢复拆图默认模型配置
    applySplitDefaultModelConfig();
    // 加载目标队列数据到UI
    loadSplitQueueToUI(targetQueue);
    renderSplitMaterialTabs(targetQueue);
    renderSplitQueueNumberBar();
    saveSplitQueueData();
    syncSplitProgressUI();
}

function loadSplitQueueToUI(qi) {
    const qd = splitQueueData[qi];
    if (!qd) return;
    ensureSplitQueueWorkItems(qi);
    // 写入API配置
    writeSplitApiConfigFromQueue(qi);
    const activeItem = getActiveSplitWorkItem(qi);
    if (activeItem && !activeItem.promptCn && qd.lastSplitPromptTemplate) {
        const n = activeItem.number || (qd.activeItemIndex + 1);
        activeItem.promptCn = qd.lastSplitPromptTemplate.replace(/\{N\}/g, String(n)).trim();
    }
    const promptEl = document.getElementById('split-prompt-cn');
    if (promptEl) promptEl.value = activeItem?.promptCn || '';
    // 显示/隐藏工作区
    const workspaceArea = document.getElementById('split-workspace-area');
    const uploadPanel = document.getElementById('split-upload-panel');
    if (activeItem && (activeItem.imageUrl || activeItem.croppedImageUrl || activeItem.gridImageUrl)) {
        // 队列有图片数据，显示工作区
        if (workspaceArea) workspaceArea.style.display = 'block';
        const currentImg = document.getElementById('split-current-img');
        if (currentImg) {
            // 裁剪模式：显示原图+裁剪框预览；非裁剪模式：显示原图或裁剪图
            const displayUrl = activeItem.gridImageUrl || activeItem.imageUrl || activeItem.croppedImageUrl;
            currentImg.src = displayUrl;
            currentImg.style.display = 'block';
            // 显示/隐藏裁剪框预览叠加层
            updateSplitCropOverlay(activeItem);
        }
        // 渲染素材槽位
        _renderAllSplitMaterialSlots();
        // 渲染前缀/后缀
        renderSplitPrefixSuffix(activeItem);
    } else {
        if (workspaceArea) workspaceArea.style.display = 'none';
    }
    applySplitSourcePreview(qi);
    renderSplitNumSelectionForQueue(qi);
    renderSplitWorkItemTabs(qi);
    // 渲染结果
    renderSplitQueueResults(qi);
    restoreSplitQueueGeneratingPlaceholders(qi);
    applySplitAutoAspectRatioFromCrop(qi);
    renderSplitMaterialTabs(qi);
    // 更新生成按钮状态
    updateSplitGenerateBtnState();
    syncSplitProgressUI();
}

// ========== 拆图裁剪框预览叠加层 ==========
function updateSplitCropOverlay(activeItem) {
    const container = document.getElementById('split-img-container');
    if (!container) return;
    // 移除旧叠加层
    const oldOverlay = container.querySelector('.split-crop-overlay');
    if (oldOverlay) oldOverlay.remove();

    // 非裁剪模式或没有裁剪框数据时不显示叠加层
    if (!activeItem || !activeItem.cropRect) return;

    const rect = activeItem.cropRect; // {x, y, w, h} 比例坐标 0-1
    const overlay = document.createElement('div');
    overlay.className = 'split-crop-overlay';
    overlay.style.cssText = 'position:absolute;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:2;';

    // 半透明遮罩（裁剪框外部区域变暗）
    const mask = document.createElement('div');
    mask.className = 'split-crop-mask';
    mask.style.cssText = `position:absolute;top:0;left:0;width:100%;height:100%;
        box-shadow:inset 0 0 0 9999px rgba(0,0,0,0.45);
        clip-path:polygon(0% 0%,0% 100%,${(rect.x*100).toFixed(2)}% 100%,${(rect.x*100).toFixed(2)}% ${(rect.y*100).toFixed(2)}%,${((rect.x+rect.w)*100).toFixed(2)}% ${(rect.y*100).toFixed(2)}%,${((rect.x+rect.w)*100).toFixed(2)}% ${((rect.y+rect.h)*100).toFixed(2)}%,${(rect.x*100).toFixed(2)}% ${((rect.y+rect.h)*100).toFixed(2)}%,${(rect.x*100).toFixed(2)}% 100%,100% 100%,100% 0%);`;

    // 裁剪框边框
    const border = document.createElement('div');
    border.className = 'split-crop-border';
    border.style.cssText = `position:absolute;left:${(rect.x*100).toFixed(2)}%;top:${(rect.y*100).toFixed(2)}%;width:${(rect.w*100).toFixed(2)}%;height:${(rect.h*100).toFixed(2)}%;border:2px solid #00d4ff;box-shadow:0 0 8px rgba(0,212,255,0.5);pointer-events:auto;cursor:move;`;

    // 编号标签
    const label = document.createElement('div');
    label.className = 'split-crop-label';
    label.textContent = `#${activeItem.number || ''}`;
    label.style.cssText = 'position:absolute;top:-22px;left:0;background:#00d4ff;color:#000;font-size:11px;font-weight:700;padding:1px 6px;border-radius:3px 3px 0 0;white-space:nowrap;line-height:1.4;';
    border.appendChild(label);

    // 拖动裁剪框
    _makeSplitCropBorderDraggable(border, activeItem, mask);

    overlay.appendChild(mask);
    overlay.appendChild(border);
    container.appendChild(overlay);
}

function _makeSplitCropBorderDraggable(borderEl, activeItem, maskEl) {
    let isDragging = false;
    let startX, startY, startRectX, startRectY;
    const onDown = (e) => {
        e.preventDefault();
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startRectX = activeItem.cropRect.x;
        startRectY = activeItem.cropRect.y;
    };
    const onMove = (e) => {
        if (!isDragging) return;
        const parentRect = borderEl.parentElement.getBoundingClientRect();
        const dx = (e.clientX - startX) / parentRect.width;
        const dy = (e.clientY - startY) / parentRect.height;
        let newX = startRectX + dx;
        let newY = startRectY + dy;
        const w = activeItem.cropRect.w;
        const h = activeItem.cropRect.h;
        newX = Math.max(0, Math.min(1 - w, newX));
        newY = Math.max(0, Math.min(1 - h, newY));
        activeItem.cropRect.x = newX;
        activeItem.cropRect.y = newY;
        borderEl.style.left = (newX * 100).toFixed(2) + '%';
        borderEl.style.top = (newY * 100).toFixed(2) + '%';
        _updateSplitCropMaskClip(maskEl, activeItem.cropRect);
    };
    const onUp = () => {
        if (!isDragging) return;
        isDragging = false;
        const qdDrag = splitQueueData[activeSplitQueue];
        if (qdDrag && activeItem?.cropRect) {
            qdDrag.splitAspectRatioManualOverride = false;
            applySplitAutoAspectRatioFromCrop(activeSplitQueue);
        }
        saveSplitQueueData();
    };
    borderEl.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // 触摸支持
    borderEl.addEventListener('touchstart', (e) => { onDown(e.touches[0]); }, { passive: false });
    document.addEventListener('touchmove', (e) => { if (isDragging) onMove(e.touches[0]); }, { passive: false });
    document.addEventListener('touchend', onUp);
}

function _updateSplitCropMaskClip(maskEl, rect) {
    if (!maskEl) return;
    maskEl.style.clipPath = `polygon(0% 0%,0% 100%,${(rect.x*100).toFixed(2)}% 100%,${(rect.x*100).toFixed(2)}% ${(rect.y*100).toFixed(2)}%,${((rect.x+rect.w)*100).toFixed(2)}% ${(rect.y*100).toFixed(2)}%,${((rect.x+rect.w)*100).toFixed(2)}% ${((rect.y+rect.h)*100).toFixed(2)}%,${(rect.x*100).toFixed(2)}% ${((rect.y+rect.h)*100).toFixed(2)}%,${(rect.x*100).toFixed(2)}% 100%,100% 100%,100% 0%)`;
}

/** 前缀/后缀模板 ID 去重（保序），避免按钮区与数据重复 */
function dedupeTemplateIds(ids) {
    if (!Array.isArray(ids)) return [];
    const seen = new Set();
    const out = [];
    for (const id of ids) {
        if (id === undefined || id === null || id === '') continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
    }
    return out;
}

/**
 * 拼接实际发送的提示词：点击前缀/后缀时已写入 textarea，此处若再拼接会重复。
 * 仅当正文首尾尚未包含已选模板全文时自动补上（兼容旧数据或未通过按钮编辑的情况）。
 */
function mergePromptBodyWithSelectedTemplates(body, prefixIds, suffixIds) {
    const pIds = dedupeTemplateIds(prefixIds);
    const sIds = dedupeTemplateIds(suffixIds);
    const prefixTexts = pIds.map(id => promptTemplates?.prefixes?.find(t => t.id === id)?.text).filter(Boolean);
    const suffixTexts = sIds.map(id => promptTemplates?.suffixes?.find(t => t.id === id)?.text).filter(Boolean);
    const preJoin = prefixTexts.join(' ').trim();
    const sufJoin = suffixTexts.join(' ').trim();
    let out = (body || '').trim();
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (preJoin) {
        const nb = norm(out);
        const np = norm(preJoin);
        if (!nb.startsWith(np)) out = `${preJoin} ${out}`.trim();
    }
    if (sufJoin) {
        const no = norm(out);
        const ns = norm(sufJoin);
        if (!no.endsWith(ns)) out = `${out} ${sufJoin}`.trim();
    }
    return out;
}

function renderSplitPrefixSuffix(item) {
    const prefixGroup = document.getElementById('split-prefix-btn-group');
    const suffixGroup = document.getElementById('split-suffix-btn-group');
    const visiblePrefixes = _getVisibleItems('prefix');
    const visibleSuffixes = _getVisibleItems('suffix');
    if (prefixGroup) {
        prefixGroup.innerHTML = '';
        if (typeof promptTemplates !== 'undefined' && promptTemplates.prefixes) {
            visiblePrefixes.forEach((t) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'template-btn ' + (dedupeTemplateIds(item.selectedPrefixIds || []).includes(t.id) ? 'selected' : '');
                btn.textContent = t.name;
                btn.dataset.id = t.id;
                btn.title = t.text || t.name || '';
                btn.addEventListener('click', () => toggleSplitTemplate(item, 'prefix', t.id, btn));
                prefixGroup.appendChild(btn);
            });
        }
    }
    if (suffixGroup) {
        suffixGroup.innerHTML = '';
        if (typeof promptTemplates !== 'undefined' && promptTemplates.suffixes) {
            visibleSuffixes.forEach((t) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'template-btn ' + (dedupeTemplateIds(item.selectedSuffixIds || []).includes(t.id) ? 'selected' : '');
                btn.textContent = t.name;
                btn.dataset.id = t.id;
                btn.title = t.text || t.name || '';
                btn.addEventListener('click', () => toggleSplitTemplate(item, 'suffix', t.id, btn));
                suffixGroup.appendChild(btn);
            });
        }
    }
    updateSplitPrefixSuffixPreview(item);
}

function toggleSplitTemplate(item, type, templateId, btnEl) {
    const key = type === 'prefix' ? 'selectedPrefixIds' : 'selectedSuffixIds';
    if (!item[key]) item[key] = [];
    const templateList = type === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
    const tpl = (templateList || []).find(t => t.id === templateId);
    if (!tpl || !tpl.text) return;
    const textarea = document.getElementById('split-prompt-cn');
    const i = item[key].indexOf(templateId);
    if (i >= 0) {
        item[key] = item[key].filter(id => id !== templateId);
        btnEl.classList.remove('selected');
        if (textarea) {
            let val = textarea.value || '';
            if (type === 'prefix') {
                const trimmed = val.trimStart();
                if (trimmed.startsWith(tpl.text)) val = trimmed.slice(tpl.text.length).trimStart();
                else {
                    const idx = val.indexOf(tpl.text);
                    if (idx >= 0) val = (val.slice(0, idx) + val.slice(idx + tpl.text.length)).replace(/\s{2,}/g, ' ').trim();
                }
            } else {
                const trimmed = val.trimEnd();
                if (trimmed.endsWith(tpl.text)) val = trimmed.slice(0, -tpl.text.length).trimEnd();
                else {
                    const idx = val.lastIndexOf(tpl.text);
                    if (idx >= 0) val = (val.slice(0, idx) + val.slice(idx + tpl.text.length)).replace(/\s{2,}/g, ' ').trim();
                }
            }
            textarea.value = val;
            item.promptCn = val;
        }
    } else {
        item[key].push(templateId);
        btnEl.classList.add('selected');
        if (textarea) {
            if (type === 'prefix') textarea.value = `${tpl.text} ${textarea.value || ''}`.trim();
            else textarea.value = `${textarea.value || ''} ${tpl.text}`.trim();
            item.promptCn = textarea.value;
        }
    }
    item[key] = dedupeTemplateIds(item[key]);
    syncActiveSplitItemToQueue(activeSplitQueue);
    updateSplitPrefixSuffixPreview(item);
    saveSplitQueueData();
}

function updateSplitPrefixSuffixPreview(item) {
    const prefixPreview = document.getElementById('split-prefix-preview');
    const suffixPreview = document.getElementById('split-suffix-preview');
    if (prefixPreview) {
        const names = dedupeTemplateIds(item.selectedPrefixIds || []).map(id => promptTemplates?.prefixes?.find(t => t.id === id)?.name).filter(Boolean);
        if (names.length > 0) {
            prefixPreview.textContent = `已选前缀：${names.join('、')}（正文见下方输入框）`;
            prefixPreview.style.display = 'block';
        } else {
            prefixPreview.style.display = 'none';
        }
    }
    if (suffixPreview) {
        const names = dedupeTemplateIds(item.selectedSuffixIds || []).map(id => promptTemplates?.suffixes?.find(t => t.id === id)?.name).filter(Boolean);
        if (names.length > 0) {
            suffixPreview.textContent = `已选后缀：${names.join('、')}（正文见下方输入框）`;
            suffixPreview.style.display = 'block';
        } else {
            suffixPreview.style.display = 'none';
        }
    }
}

function buildSplitFullPrompt(item) {
    return mergePromptBodyWithSelectedTemplates(item.promptCn, item.selectedPrefixIds, item.selectedSuffixIds);
}

function getSplitCropSourceUrl(item, qd) {
    return item?.gridImageUrl || qd?.gridImageUrl || item?.imageUrl || '';
}

function validateSplitWorkItemsForGenerate(qi) {
    const qd = splitQueueData[qi];
    if (!qd || !Array.isArray(qd.workItems) || qd.workItems.length === 0) {
        return { ok: false, message: '该队列没有拆图数据', missingIndex: -1 };
    }
    for (let i = 0; i < qd.workItems.length; i++) {
        const item = qd.workItems[i];
        const sourceUrl = item?.croppedImageUrl || item?.imageUrl || (item?.cropRect && getSplitCropSourceUrl(item, qd) ? 'preview' : '');
        if (!sourceUrl) {
            return { ok: false, message: `格子编号 ${item?.number || (i + 1)} 缺少图片，请重新拆分`, missingIndex: i };
        }
        const fullPrompt = buildSplitFullPrompt(item).trim();
        if (!fullPrompt) {
            return { ok: false, message: `格子编号 ${item?.number || (i + 1)} 未设置提示词，请先填写`, missingIndex: i };
        }
    }
    return { ok: true, message: '', missingIndex: -1 };
}

function createSplitResultCardElement(qi, item, idx, results) {
    const card = document.createElement('div');
    card.className = 'api-result-card';
    card.dataset.index = String(idx);
    card.style.position = 'relative';
    const qdCard = splitQueueData[qi];
    const showMatLabel = qdCard && (qdCard.materials || []).length > 1 && Number.isFinite(item?._materialIndex);
    const imgEl = document.createElement('img');
    imgEl.alt = '拆图结果';
    imgEl.loading = 'lazy';
    imgEl.src = item.url;
    imgEl.style.cssText = 'width:100%;aspect-ratio:3/4;object-fit:cover;display:block;cursor:pointer;';
    imgEl.addEventListener('click', () => {
        const images = (results || []).map((r, i) => ({
            url: r.url || '',
            checked: !!r.checked,
            filename: r.filename || `拆图结果_${i + 1}.jpg`
        }));
        openImageViewer(images, idx);
    });
    imgEl.onerror = () => {
        imgEl.style.display = 'none';
        const fallback = document.createElement('div');
        fallback.style.cssText = 'width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:var(--border-light);color:var(--text-muted);font-size:10px;';
        fallback.textContent = '加载失败';
        card.insertBefore(fallback, card.firstChild);
    };
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'api-result-actions';
    const downloadBtn = document.createElement('button');
    downloadBtn.className = 'btn-icon';
    downloadBtn.title = '下载';
    downloadBtn.textContent = '↓';
    downloadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        downloadSplitResultImage(item.url, qi, idx);
    });
    const regenBtn = document.createElement('button');
    regenBtn.className = 'btn-icon';
    regenBtn.title = '再次生成';
    regenBtn.style.cssText = 'color:#7c3aed;font-size:10px;';
    regenBtn.textContent = '再生';
    regenBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateSplitResult(qi, idx);
    });
    actionsDiv.appendChild(downloadBtn);
    actionsDiv.appendChild(regenBtn);
    const checkDiv = document.createElement('div');
    checkDiv.style.cssText = 'position:absolute;top:4px;left:4px;';
    checkDiv.innerHTML = '<input type="checkbox" class="split-result-checkbox" style="width:14px;height:14px;cursor:pointer;" title="勾选下载">';
    const cb = checkDiv.querySelector('.split-result-checkbox');
    if (cb) cb.checked = !!item.checked;
    if (cb) {
        cb.addEventListener('change', () => {
            item.checked = cb.checked;
            saveSplitQueueData();
        });
    }
    card.appendChild(imgEl);
    if (showMatLabel) {
        const lab = document.createElement('div');
        lab.style.cssText = 'position:absolute;top:22px;left:4px;font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(124,58,237,0.92);color:#fff;font-weight:600;pointer-events:none;z-index:2;';
        lab.textContent = `素材 ${item._materialIndex + 1}`;
        card.style.position = 'relative';
        card.appendChild(lab);
    }
    card.appendChild(actionsDiv);
    card.appendChild(checkDiv);
    return card;
}

function appendSplitResultPendingSlots(grid, count) {
    if (!grid || count < 1) return;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
        const card = document.createElement('div');
        card.className = 'split-result-pending-card api-result-pending-card';
        card.dataset.slotIndex = String(i);
        card.innerHTML = `<div class="split-result-pending-inner api-result-pending-inner">
            <div class="split-result-pending-shimmer api-result-pending-shimmer"></div>
            <div class="split-result-pending-status api-result-pending-status"><span class="loading" style="display:inline-block;"></span> 等待返图…</div>
            <div class="split-result-pending-num api-result-pending-num">${i + 1} / ${count}</div>
        </div>`;
        frag.appendChild(card);
    }
    grid.appendChild(frag);
}

function fillNextSplitPendingCard(grid, element) {
    if (!grid || !element) return;
    const pending = grid.querySelector('.split-result-pending-card');
    if (pending) pending.replaceWith(element);
    else grid.appendChild(element);
}

function fillSplitPendingSlotAt(grid, slotIndex, element) {
    if (!grid || !element) return;
    const ph = grid.querySelector(`.split-result-pending-card[data-slot-index="${slotIndex}"]`);
    if (ph) ph.replaceWith(element);
    else fillNextSplitPendingCard(grid, element);
}

function clearRemainingSplitResultPendingSlots(grid) {
    const g = grid || document.getElementById('split-result-grid');
    if (!g) return;
    g.querySelectorAll('.split-result-pending-card').forEach(el => el.remove());
}

function splitPendingStubCard(kind, detail) {
    const card = document.createElement('div');
    card.className = 'api-result-card split-result-pending-card--failed api-result-pending-card--failed';
    card.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:12px;aspect-ratio:3/4;border:1px solid var(--border);border-radius:var(--radius-sm);';
    const inner = document.createElement('div');
    inner.style.cssText = 'text-align:center;font-size:10px;color:var(--text-muted);line-height:1.4;';
    inner.textContent = kind === 'skip' ? '已跳过' : (detail || '未返图');
    card.appendChild(inner);
    return card;
}

function clearSplitFailures(qi) {
    const qd = splitQueueData[qi];
    if (qd) qd.failedItems = [];
    updateSplitFailedUI(qi);
}

function recordSplitFailure(qi, failure) {
    const qd = splitQueueData[qi];
    if (!qd) return;
    if (!Array.isArray(qd.failedItems)) qd.failedItems = [];
    const item = {
        materialIndex: Number.isFinite(failure.materialIndex) ? failure.materialIndex : (qd.activeMaterialIndex || 0),
        itemIndex: Number.isFinite(failure.itemIndex) ? failure.itemIndex : 0,
        gridNum: failure.gridNum || '',
        reason: failure.reason || '未返图',
        ts: Date.now()
    };
    const key = `${item.materialIndex}:${item.itemIndex}`;
    qd.failedItems = qd.failedItems.filter(x => `${x.materialIndex}:${x.itemIndex}` !== key);
    qd.failedItems.push(item);
    updateSplitFailedUI(qi);
}

function removeSplitFailure(qi, materialIndex, itemIndex) {
    const qd = splitQueueData[qi];
    if (!qd || !Array.isArray(qd.failedItems)) return;
    qd.failedItems = qd.failedItems.filter(x => !(x.materialIndex === materialIndex && x.itemIndex === itemIndex));
    updateSplitFailedUI(qi);
}

function inferMissingSplitFailures(qi) {
    const qd = splitQueueData[qi];
    if (!qd || (qd.failedItems || []).length > 0) return;
    if (!qd.progressTotal || !qd.progressDone || qd.progressDone >= qd.progressTotal) return;
    const resultKeys = new Set((qd.results || []).map(r => `${Number.isFinite(r?._materialIndex) ? r._materialIndex : -1}:${r?._regenImageUrl || ''}`));
    const inferred = [];
    (qd.materials || []).forEach((mat, mi) => {
        (mat.workItems || []).forEach((item, wi) => {
            const source = item.croppedImageUrl || item.imageUrl || '';
            if (!source) return;
            if (!resultKeys.has(`${mi}:${source}`)) {
                inferred.push({ materialIndex: mi, itemIndex: wi, gridNum: item.number || (wi + 1), reason: '未返图', ts: Date.now() });
            }
        });
    });
    if (inferred.length > 0) qd.failedItems = inferred.slice(0, Math.max(0, qd.progressTotal - qd.progressDone));
}

function updateSplitFailedUI(qi = activeSplitQueue) {
    const qd = splitQueueData[qi];
    inferMissingSplitFailures(qi);
    const count = Array.isArray(qd?.failedItems) ? qd.failedItems.length : 0;
    const summary = document.getElementById('split-failed-summary');
    const btn = document.getElementById('btn-split-retry-failed');
    if (summary) {
        summary.style.display = count > 0 ? '' : 'none';
        summary.textContent = count > 0 ? `失败 ${count} 张` : '';
    }
    if (btn) {
        btn.style.display = count > 0 ? 'inline-flex' : 'none';
        btn.disabled = !!splitGenerateStates[qi]?.running;
    }
}

function renderSplitQueueResults(qi) {
    const grid = document.getElementById('split-result-grid');
    if (!grid) return;
    const qd = splitQueueData[qi];
    const results = qd?.results || [];
    grid.innerHTML = '';
    updateSplitFailedUI(qi);
    if (results.length === 0) {
        grid.innerHTML = '<div id="split-result-placeholder" style="grid-column:1/-1;text-align:center;padding:30px 0;color:var(--text-muted);font-size:11px;"><div>上传九宫格图片，选择编号后点击「拆分并填入队列」</div></div>';
        return;
    }
    results.forEach((item, idx) => {
        grid.appendChild(createSplitResultCardElement(qi, item, idx, results));
    });
}

/** 当前队列仍在生成时，在已有结果后补上剩余占位卡（切换回该队列时调用） */
function restoreSplitQueueGeneratingPlaceholders(qi) {
    const qs = splitGenerateStates[qi];
    const grid = document.getElementById('split-result-grid');
    if (!grid || qi !== activeSplitQueue || !qs?.running) return;
    const total = Math.max(0, qs.batchVisualTotal || 0);
    const filled = Math.max(0, qs.batchVisualFilled || 0);
    const remaining = Math.max(0, total - filled);
    if (remaining > 0) appendSplitResultPendingSlots(grid, remaining);
}

function updateSplitGenerateBtnState() {
    const singleBtn = document.getElementById('btn-split-generate');
    const batchBtn = document.getElementById('btn-split-batch-generate');
    const batchAllBtn = document.getElementById('btn-split-batch-generate-all');
    const cancelBtn = document.getElementById('btn-split-cancel');
    const activeState = splitGenerateStates[activeSplitQueue];
    const qd = splitQueueData[activeSplitQueue];
    if (qd) normalizeSplitQueueMaterials(qd);
    const activeQueueHasData = (qd?.workItems || []).length > 0;
    const multiMaterial =
        !!qd && Array.isArray(qd.materials) && qd.materials.length > 1 &&
        qd.materials.some(m => (m?.workItems || []).length > 0);
    const thisQueueGenerating = !!activeState?.running;
    if (singleBtn) {
        // 有工作项时始终显示；加载文案仅在本队列生成时出现（其它队列批量生成不影响当前队列按钮）
        singleBtn.style.display = activeQueueHasData ? '' : 'none';
        singleBtn.disabled = thisQueueGenerating;
        singleBtn.innerHTML = thisQueueGenerating ? '<span class="loading"></span> 生成中...' : '拆图生成';
    }
    if (batchBtn) {
        batchBtn.style.display = activeQueueHasData ? '' : 'none';
        batchBtn.disabled = thisQueueGenerating;
        batchBtn.innerHTML = thisQueueGenerating ? '<span class="loading"></span> 批量生成中...' : '批量生成';
    }
    if (batchAllBtn) {
        batchAllBtn.style.display = multiMaterial ? '' : 'none';
        batchAllBtn.disabled = thisQueueGenerating;
        batchAllBtn.textContent = thisQueueGenerating ? '全部素材生成中…' : '全部素材生成';
    }
    if (cancelBtn) cancelBtn.style.display = thisQueueGenerating ? '' : 'none';
}

async function downloadSplitResultImage(url, qi, idx) {
    const resp = await downloadImageAsJpg(url, splitQueueData[qi]?.imagePrefix || 'split', getEffectiveSplitDownloadPath(qi));
    if (resp.ok) {
        showToast('下载成功', 'success');
    } else {
        const err = resp.error || '未知错误';
        if (String(err).includes('pro.filesystem.site')) {
            showToast(`下载失败: ${err}（请重启后端使白名单生效）`, 'error');
        } else {
            showToast(`下载失败: ${err}`, 'error');
        }
    }
}

async function regenerateSplitResult(qi, idx) {
    const qd = splitQueueData[qi];
    const item = qd?.results?.[idx];
    if (!qd || !item) return;
    const platform = qd.apiPlatform || 'oaihk';
    if (platform === 'oaihk' && !OAIHK_MODELS[qd.oaihkModelId]) { showToast('请选择 OpenAI-HK 模型', 'error'); return; }
    if (platform !== 'oaihk' && !RH_MODELS[qd.rhModelId]) { showToast('请选择模型', 'error'); return; }

    const prompt = (item._regenPrompt || item.prompt || '').trim();
    const source = item._regenImageUrl || '';
    if (!prompt || !source) {
        showToast('缺少再次生成所需的原始提示词或参考图', 'error');
        return;
    }

    const qs = splitGenerateStates[qi];
    if (qs?.running) {
        showToast(`拆图队列${qi + 1}正在生成中，请稍后`, 'warning');
        return;
    }
    qs.running = true;
    qs.cancelled = false;
    qs.abortController = new AbortController();
    qs.progressPercent = 0;
    qs.progressText = '';
    const signal = qs.abortController.signal;
    updateSplitGenerateBtnState();

    try {
        const imageUrls = platform !== 'oaihk' && source.startsWith('/') ? [window.location.origin + source] : [source];
        const task = { prompt, imageUrls, queueLabel: `再生${idx + 1}` };
        const newResults = await generateSingleTaskForSplit(qi, task, platform, qd, signal);
        if (newResults.length === 0) {
            showToast('再次生成未返回结果', 'warning');
            return;
        }
        for (const r of newResults) {
            r._regenPrompt = prompt;
            r._regenImageUrl = source;
        }
        if (qd.autoBackup !== false) await autoBackupSplitResults(newResults, qi);
        qd.results.splice(idx, 1, ...newResults);
        saveSplitQueueData();
        if (qi === activeSplitQueue) renderSplitQueueResults(qi);
        showToast('再次生成完成', 'success');
    } catch (e) {
        if (!qs.cancelled) showToast('再次生成失败: ' + e.message, 'error');
    } finally {
        qs.running = false;
        qs.cancelled = false;
        qs.abortController = null;
        updateSplitGenerateBtnState();
        renderSplitQueueNumberBar();
    }
}

async function loadSplitResultToQueue(imageUrl) {
    if (!imageUrl) return;
    const targetQueue = findAvailableSplitQueue();
    if (targetQueue < 0) {
        showToast('没有可用拆图队列（都在运行或已占用），请先清理一个队列', 'warning');
        return;
    }
    const qd = splitQueueData[targetQueue];
    qd.gridImageUrl = imageUrl;
    qd.workItems = [];
    qd.activeItemIndex = 0;
    qd.learnedGridLayout = null;
    try {
        const tail = imageUrl.split('/').pop() || '';
        qd.sourceFilename = decodeURIComponent(tail.replace(/\+/g, ' '));
    } catch (_) {
        qd.sourceFilename = getFileBaseName(imageUrl);
    }
    qd.imageUrl = '';
    qd.croppedImageUrl = '';
    qd.promptCn = '';
    qd.number = 0;
    qd.selectedNums = [];
    qd.selectedPrefixIds = [];
    qd.selectedSuffixIds = [];
    qd.progressTotal = 0;
    qd.progressDone = 0;
    splitImageUrl = imageUrl;
    splitGridImageUrl = imageUrl;
    saveSplitQueueData();
    switchMode('split');
    switchToSplitQueue(targetQueue);
    document.getElementById('split-img').src = imageUrl;
    await maybeAutoSplitFromFilename(targetQueue);
    saveSplitQueueData();
    if (!(splitQueueData[targetQueue]?.workItems || []).length) {
        showToast(`已发送到拆图队列${targetQueue + 1}，请选择编号后点击「拆分并填入队列」`, 'success');
    }
}

function findAvailableSplitQueue() {
    for (let i = 0; i < QUEUE_COUNT; i++) {
        const qd = splitQueueData[i];
        const hasData = !!(qd?.gridImageUrl) || (qd?.workItems || []).length > 0 || (qd?.results || []).length > 0;
        if (!splitGenerateStates[i]?.running && !hasData) return i;
    }
    return -1;
}

function ensureSplitQueueWorkItems(qi) {
    const qd = splitQueueData[qi];
    if (!qd) return;
    if (!Array.isArray(qd.workItems)) qd.workItems = [];
    if (typeof qd.activeItemIndex !== 'number' || qd.activeItemIndex < 0) qd.activeItemIndex = 0;
    if (qd.activeItemIndex >= qd.workItems.length && qd.workItems.length > 0) qd.activeItemIndex = 0;
}

function getActiveSplitWorkItem(qi) {
    const qd = splitQueueData[qi];
    ensureSplitQueueWorkItems(qi);
    if (!qd || qd.workItems.length === 0) return null;
    return qd.workItems[qd.activeItemIndex] || qd.workItems[0] || null;
}

function syncActiveSplitItemToQueue(qi) {
    const qd = splitQueueData[qi];
    const item = getActiveSplitWorkItem(qi);
    if (!qd) return;
    if (!item) {
        qd.imageUrl = '';
        qd.croppedImageUrl = '';
        qd.promptCn = '';
        qd.number = 0;
        qd.selectedPrefixIds = [];
        qd.selectedSuffixIds = [];
        return;
    }
    qd.imageUrl = item.imageUrl || '';
    qd.croppedImageUrl = item.croppedImageUrl || '';
    qd.gridImageUrl = item.gridImageUrl || qd.gridImageUrl || item.imageUrl || '';
    qd.cropRect = item.cropRect || null;
    qd.cropPreset = item.cropPreset || qd.cropPreset || null;
    qd.promptCn = item.promptCn || '';
    qd.number = item.number || 0;
    item.selectedPrefixIds = dedupeTemplateIds(item.selectedPrefixIds);
    item.selectedSuffixIds = dedupeTemplateIds(item.selectedSuffixIds);
    qd.selectedPrefixIds = [...item.selectedPrefixIds];
    qd.selectedSuffixIds = [...item.selectedSuffixIds];
}

function renderSplitWorkItemTabs(qi) {
    const tabBar = document.getElementById('split-tab-bar');
    const qd = splitQueueData[qi];
    if (!tabBar || !qd) return;
    tabBar.innerHTML = '';
    const items = qd.workItems || [];
    if (items.length === 0) {
        tabBar.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">暂无拆图工作项</span>';
        return;
    }
    items.forEach((item, idx) => {
        const btn = document.createElement('button');
        btn.className = `split-num-btn ${idx === qd.activeItemIndex ? 'active' : ''}`;
        btn.type = 'button';
        btn.textContent = `${item.number || (idx + 1)}`;
        btn.title = `切换到格子编号 ${item.number || (idx + 1)}`;
        btn.addEventListener('click', () => {
            saveCurrentSplitQueueData();
            qd.activeItemIndex = idx;
            syncActiveSplitItemToQueue(qi);
            loadSplitQueueToUI(qi);
            saveSplitQueueData();
        });
        tabBar.appendChild(btn);
    });
}

/** 与工作区「当前格子」同一套图源优先级，避免队列仅有 workItem.gridImageUrl 时九宫格预览仍盯 qd.gridImageUrl */
function getEffectiveSplitGridPreviewUrl(qi) {
    const qd = splitQueueData[qi];
    if (!qd) return '';
    ensureSplitQueueWorkItems(qi);
    const it = getActiveSplitWorkItem(qi);
    if (it) {
        return (
            (it.gridImageUrl || it.imageUrl || it.croppedImageUrl || qd.gridImageUrl || '')
                .trim()
        );
    }
    return (qd.gridImageUrl || '').trim();
}

function applySplitSourcePreview(qi) {
    const source = getEffectiveSplitGridPreviewUrl(qi);
    splitImageUrl = source;
    splitGridImageUrl = source;
    const previewEl = document.getElementById('split-preview');
    const dropZoneEl = document.getElementById('split-drop-zone');
    const imgEl = document.getElementById('split-img');
    if (!previewEl || !dropZoneEl || !imgEl) return;

    const previewKey = `${qi}|${source}`;
    if (!source) {
        imgEl.dataset.splitPreviewKey = previewKey;
        imgEl.removeAttribute('src');
        previewEl.style.display = 'none';
        dropZoneEl.style.display = '';
        return;
    }

    previewEl.style.display = '';
    dropZoneEl.style.display = 'none';

    if (imgEl.dataset.splitPreviewKey === previewKey) return;

    imgEl.dataset.splitPreviewKey = previewKey;
    imgEl.alt = `拆图队列 ${qi + 1} 九宫格`;

    imgEl.src = '';
    imgEl.removeAttribute('src');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (imgEl.dataset.splitPreviewKey !== previewKey) return;
            imgEl.src = source;
        });
    });
}
function saveQueueData() {
    syncUndoBaselineAfterMutation();
    // 保存全局 pinnedSlotIndices
    try { localStorage.setItem('pinnedSlotIndices', JSON.stringify(Array.from(pinnedSlotIndices))); } catch(e) {}
    // 防抖：300ms 内的多次调用只执行一次
    if (_saveQueueTimer) clearTimeout(_saveQueueTimer);
    _saveQueueTimer = setTimeout(() => {
        api('PUT', '/api/queue-data', {
            queues: queueData,
            activeQueue: activeQueue,
            queueMode: queueMode,
            slots: queueMode === 'same' ? imageState.slots : []
        }, 60000, undefined, true).catch(e => console.error('保存队列数据失败:', e)); // skipGlobalAbort
    }, 300);
}
// 立即保存队列数据（无防抖），返回 Promise
async function saveQueueDataNow() {
    syncUndoBaselineAfterMutation();
    if (_saveQueueTimer) { clearTimeout(_saveQueueTimer); _saveQueueTimer = null; }
    try { localStorage.setItem('pinnedSlotIndices', JSON.stringify(Array.from(pinnedSlotIndices))); } catch(e) {}
    await api('PUT', '/api/queue-data', {
        queues: queueData,
        activeQueue: activeQueue,
        queueMode: queueMode,
        slots: queueMode === 'same' ? imageState.slots : []
    }, 60000, undefined, true);
}

// 从队列1复制到其他队列（默认初始化）
function copyQueue1ToAll() {
    pushUndoSnapshot();
    const q1 = queueData[0];
    for (let q = 1; q < QUEUE_COUNT; q++) {
        queueData[q].slots = deepClone(q1.slots);
        queueData[q].promptCn = q1.promptCn;
        queueData[q].promptEn = q1.promptEn;
    }
    saveQueueData();
}

// 切换到指定队列
async function switchToQueue(qIndex) {
    pushUndoSnapshot();
    // 保存当前队列数据
    saveCurrentQueueData();
    // 立即持久化到服务器，确保切换前数据已保存
    await saveQueueDataNow();
    activeQueue = qIndex;
    saveQueueData();
    // 加载目标队列数据
    loadQueueData(qIndex);
    // 切换队列时应用默认模型设置
    applyDefaultModelConfig();
    renderQueueNumberBars();
    updateGenerateBtnText();
    // 切换队列时无需重置拆图面板（拆图已是独立模块）
    // 切换队列时更新进度条和取消按钮
    const qs = queueGenerateStates[activeQueue];
    const cancelBtn = document.getElementById('btn-api-cancel');
    if (qs?.running) {
        cancelBtn && (cancelBtn.style.display = 'inline-flex');
    } else {
        hideApiProgress();
        if (!queueGenerateStates.some(s => s.running)) {
            cancelBtn && (cancelBtn.style.display = 'none');
        }
    }
}

// 保存当前编辑中的数据到队列
function saveCurrentQueueData(qi) {
    if (queueMode !== 'multi') return;
    const idx = (qi !== undefined && qi !== null) ? qi : activeQueue;
    const q = queueData[idx];
    if (!q) return; // 防御性检查
    q.slots = deepClone(imageState.slots);
    q.promptCn = document.getElementById('img-prompt-cn')?.value || '';
    q.promptEn = document.getElementById('img-prompt-en')?.value || '';
    // 保存 API 配置
    q.apiPlatform = document.getElementById('cfg-api-platform')?.value || 'oaihk';
    q.rhModelId = document.getElementById('cfg-rh-model-inline')?.value || '';
    q.oaihkModelId = document.getElementById('cfg-oaihk-model-inline')?.value || '';
    q.rhAspectRatio = document.getElementById('cfg-rh-aspect-ratio-inline')?.value || '3:4';
    q.oaihkAspectRatio = document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4';
    q.rhResolution = document.getElementById('cfg-rh-resolution-inline')?.value || '1k';
    q.rhCount = parseInt(document.getElementById('cfg-rh-count-inline')?.value, 10) || 1;
    q.rhSeedMode = document.getElementById('cfg-rh-seed-mode-inline')?.value || 'random';
    q.rhSeed = document.getElementById('cfg-rh-seed-inline')?.value || '';
    // 保存每个队列独立的下载设置
    q.downloadPath = readDownloadPathInputForOwner('cfg-rh-download-path');
    q.imagePrefix = document.getElementById('cfg-image-prefix')?.value?.trim() || '';
    q.autoBackup = document.getElementById('cfg-rh-auto-backup')?.checked ?? true;
    // 保存前缀/后缀/预设状态
    q.selectedPrefixIds = dedupeTemplateIds([...selectedPrefixIds]);
    q.selectedSuffixIds = dedupeTemplateIds([...selectedSuffixIds]);
    q.activePromptPresetIds = [...activePromptPresetIds];
    q.prevPromptCn = prevPromptCn;
    q.promptedSlotIndices = [...promptedSlotIndices];
    q.pinnedSlotIndices = [...pinnedSlotIndices];
    // 保存语言/前缀/自动prompt状态
    q.promptLang = apiPromptLang;
    q.activePrefix = activePrefix;
    q.lastAutoPrompt = lastAutoPrompt;
    saveQueueData();
}

// 设置 select 元素的值（如果值不在选项中则选第一个）
function setSelectValue(id, value) {
    const el = document.getElementById(id);
    if (el) {
        el.value = value;
        if (el.value !== value && el.options.length > 0) {
            el.selectedIndex = 0;
        }
    }
}

// 从队列数据恢复 API 配置到 DOM
function restoreApiConfigToDOM(q) {
    const platform = q.apiPlatform || 'oaihk';
    setSelectValue('cfg-api-platform', platform);
    setSelectValue('cfg-rh-model-inline', q.rhModelId || '');
    setSelectValue('cfg-oaihk-model-inline', q.oaihkModelId || 'fal-ai/banana/v3.1/flash/2k');
    setSelectValue('cfg-rh-aspect-ratio-inline', q.rhAspectRatio || '3:4');
    setSelectValue('cfg-oaihk-aspect-ratio-inline', q.oaihkAspectRatio || '3:4');
    setSelectValue('cfg-rh-resolution-inline', q.rhResolution || '1k');
    const countEl = document.getElementById('cfg-rh-count-inline');
    if (countEl) countEl.value = q.rhCount || 1;
    setSelectValue('cfg-rh-seed-mode-inline', q.rhSeedMode || 'random');
    const seedEl = document.getElementById('cfg-rh-seed-inline');
    if (seedEl) { seedEl.value = q.rhSeed || ''; seedEl.disabled = (q.rhSeedMode || 'random') !== 'fixed'; }
    // 恢复每个队列独立的下载设置
    writeDownloadPathInputFromOwner('cfg-rh-download-path', q.downloadPath);
    const imagePrefixEl = document.getElementById('cfg-image-prefix');
    if (imagePrefixEl) imagePrefixEl.value = q.imagePrefix || '';
    const autoBackupEl = document.getElementById('cfg-rh-auto-backup');
    if (autoBackupEl) autoBackupEl.checked = q.autoBackup !== undefined ? q.autoBackup : true;
    // 触发平台切换，显示/隐藏对应配置区
    togglePlatformUI(platform);
    // 触发模型参数适配
    updateRhModelParamsInline();
}

// 从队列加载数据到UI
function loadQueueData(qIndex) {
    const q = queueData[qIndex];
    if (!q) return; // 防御性检查
    imageState.slots = deepClone(q.slots);
    // 兼容旧数据：确保每个槽位有 DW 字段
    for (let s = 0; s < imageState.slots.length; s++) {
        if (imageState.slots[s].dwEnabled === undefined) imageState.slots[s].dwEnabled = false;
        if (imageState.slots[s].dwOriginalImage === undefined) imageState.slots[s].dwOriginalImage = '';
    }
    // 确保有10个槽位
    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
    }
    const promptCn = document.getElementById('img-prompt-cn');
    const promptEn = document.getElementById('img-prompt-en');
    if (promptCn) promptCn.value = q.promptCn || '';
    if (promptEn) promptEn.value = q.promptEn || '';
    // 恢复前缀/后缀/预设状态（持久化里可能有重复 id，与按钮区重复渲染一并修正）
    q.selectedPrefixIds = dedupeTemplateIds(q.selectedPrefixIds || []);
    q.selectedSuffixIds = dedupeTemplateIds(q.selectedSuffixIds || []);
    selectedPrefixIds = new Set(q.selectedPrefixIds);
    selectedSuffixIds = new Set(q.selectedSuffixIds);
    activePromptPresetIds = new Set(q.activePromptPresetIds || []);
    prevPromptCn = q.prevPromptCn || '';
    promptedSlotIndices = new Set(q.promptedSlotIndices || []);
    pinnedSlotIndices = new Set(q.pinnedSlotIndices || []);
    // 恢复语言/前缀/自动prompt
    apiPromptLang = q.promptLang || 'en';
    const langBtn = document.getElementById('btn-api-prompt-lang');
    if (langBtn) {
        if (apiPromptLang === 'cn') {
            langBtn.textContent = '使用中文提示词';
            langBtn.style.color = '#22c55e';
            langBtn.style.borderColor = '#22c55e';
        } else {
            langBtn.textContent = '使用英文提示词';
            langBtn.style.color = '';
            langBtn.style.borderColor = '';
        }
    }
    activePrefix = q.activePrefix || '请参考';
    renderPrefixBatchBar();
    lastAutoPrompt = q.lastAutoPrompt || '';
    renderTemplateButtons();
    renderPromptPresetButtons();
    renderImageSlots();
    // 仅在中文prompt为空时自动拼接，有已保存内容时不覆盖
    if (!q.promptCn?.trim()) {
        updateLocalPrompt();
    }
    // 多图列队模式下，切换队列时也切换生成结果和 API 配置
    if (queueMode === 'multi') {
        restoreApiConfigToDOM(q);
        renderQueueResults(qIndex);
        // 恢复该队列的生成状态 UI
        const qs = queueGenerateStates[qIndex];
        const cancelBtn = document.getElementById('btn-api-cancel');
        if (qs.running) {
            setApiProgress(50); // 显示进度条（中间状态，具体进度由轮询更新）
            if (cancelBtn) cancelBtn.style.display = 'inline-flex';
        } else {
            hideApiProgress();
            if (cancelBtn && !isAnyQueueGenerating()) {
                cancelBtn.style.display = 'none';
            }
        }
    }
    // 更新生成按钮文字
    updateGenerateBtnText();
}

// 渲染某个队列的生成结果到结果区
function renderQueueResults(qIndex) {
    const grid = document.getElementById('api-result-grid');
    if (!grid) return;
    const results = queueData[qIndex]?.results || [];
    grid.innerHTML = '';
    if (results.length === 0) return;
    results.forEach((item, i) => {
        appendResultCard(item, i);
    });
}

// 渲染队列编号按钮行
function renderQueueNumberBars() {
    const bar1 = document.getElementById('queue-number-bar');
    const bar2 = document.getElementById('queue-prompt-bar');
    if (!bar1 || !bar2) return;

    const isMulti = queueMode === 'multi';
    bar1.style.display = isMulti ? 'flex' : 'none';
    bar2.style.display = isMulti ? 'flex' : 'none';

    if (!isMulti) return;

    const html = Array.from({length: QUEUE_COUNT}, (_, i) => {
        const isActive = i === activeQueue;
        const qd = queueData[i];
        const hasData = (qd?.slots || []).some(s => s.image || s.label) || (qd?.promptCn || '');
        const isGenerating = queueGenerateStates[i]?.running;
        const stateClass = isGenerating ? ' generating' : '';
        const stateIcon = isGenerating ? ' <span class="queue-gen-indicator"></span>' : '';
        return `<button class="queue-num-btn ${isActive ? 'active' : ''}${stateClass}" data-queue="${i}" title="队列 ${i+1}">${i+1}${hasData ? ' <span class="dot">●</span>' : ''}${stateIcon}</button>`;
    }).join('');

    bar1.innerHTML = html;
    bar2.innerHTML = html;

    // 绑定点击事件
    bar1.querySelectorAll('.queue-num-btn').forEach(btn => {
        btn.addEventListener('click', () => switchToQueue(parseInt(btn.dataset.queue, 10)));
    });
    bar2.querySelectorAll('.queue-num-btn').forEach(btn => {
        btn.addEventListener('click', () => switchToQueue(parseInt(btn.dataset.queue, 10)));
    });
}

// 队列模式切换
function switchQueueMode(mode) {
    pushUndoSnapshot();
    // 先保存当前队列数据（必须在修改 queueMode 之前）
    if (queueMode === 'multi' && mode !== 'multi') {
        saveCurrentQueueData();
    }
    // 切换队列模式前，取消正在进行的图生图生成（避免孤立轮询循环）
    if (apiGenerateState.running) {
        apiGenerateState.cancelled = true;
        apiGenerateState.abortController?.abort();
        apiGenerateState.running = false;
        apiGenerateState.abortController = null;
    }
    // 取消当前队列的生成
    if (queueMode === 'multi') {
        const qs = queueGenerateStates[activeQueue];
        if (qs?.running) {
            qs.cancelled = true;
            qs.abortController?.abort();
            qs.running = false;
            qs.abortController = null;
        }
    }

    queueMode = mode;
    saveQueueData();

    document.querySelectorAll('.queue-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.queueMode === mode);
    });

    if (mode === 'multi') {
        // 用当前slots初始化队列1
        queueData[0].slots = deepClone(imageState.slots);
        queueData[0].promptCn = document.getElementById('img-prompt-cn')?.value || '';
        queueData[0].promptEn = document.getElementById('img-prompt-en')?.value || '';
        // 保存当前 API 配置到队列0
        queueData[0].apiPlatform = document.getElementById('cfg-api-platform')?.value || 'runninghub';
        queueData[0].rhModelId = document.getElementById('cfg-rh-model-inline')?.value || '';
        queueData[0].oaihkModelId = document.getElementById('cfg-oaihk-model-inline')?.value || '';
        queueData[0].rhAspectRatio = document.getElementById('cfg-rh-aspect-ratio-inline')?.value || '3:4';
        queueData[0].oaihkAspectRatio = document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4';
        queueData[0].rhResolution = document.getElementById('cfg-rh-resolution-inline')?.value || '1k';
        queueData[0].rhCount = parseInt(document.getElementById('cfg-rh-count-inline')?.value, 10) || 1;
        queueData[0].rhSeedMode = document.getElementById('cfg-rh-seed-mode-inline')?.value || 'random';
        queueData[0].rhSeed = document.getElementById('cfg-rh-seed-inline')?.value || '';
        // 保存当前下载设置到队列0
        queueData[0].downloadPath = readDownloadPathInputForOwner('cfg-rh-download-path');
        queueData[0].imagePrefix = document.getElementById('cfg-image-prefix')?.value?.trim() || '';
        queueData[0].autoBackup = document.getElementById('cfg-rh-auto-backup')?.checked ?? true;
        // 保存前缀/后缀/预设状态到队列0
        queueData[0].selectedPrefixIds = [...selectedPrefixIds];
        queueData[0].selectedSuffixIds = [...selectedSuffixIds];
        queueData[0].activePromptPresetIds = [...activePromptPresetIds];
        queueData[0].prevPromptCn = prevPromptCn;
        queueData[0].promptedSlotIndices = [...promptedSlotIndices];
        queueData[0].promptLang = apiPromptLang;
        queueData[0].activePrefix = activePrefix;
        queueData[0].lastAutoPrompt = lastAutoPrompt;
        // 队列2-10：仅当它们没有独立数据时才复制队列0的完整配置
        for (let q = 1; q < QUEUE_COUNT; q++) {
            const qd = queueData[q];
            const hasOwnData = qd.slots.some(s => s.image || s.label) || qd.promptCn?.trim() || qd.promptEn?.trim();
            if (!hasOwnData) {
                queueData[q].slots = deepClone(queueData[0].slots);
                queueData[q].promptCn = queueData[0].promptCn;
                queueData[q].promptEn = queueData[0].promptEn;
                queueData[q].apiPlatform = queueData[0].apiPlatform;
                queueData[q].rhModelId = queueData[0].rhModelId;
                queueData[q].oaihkModelId = queueData[0].oaihkModelId;
                queueData[q].rhAspectRatio = queueData[0].rhAspectRatio;
                queueData[q].oaihkAspectRatio = queueData[0].oaihkAspectRatio;
                queueData[q].rhResolution = queueData[0].rhResolution;
                queueData[q].rhCount = queueData[0].rhCount;
                queueData[q].rhSeedMode = queueData[0].rhSeedMode;
                queueData[q].rhSeed = queueData[0].rhSeed;
                queueData[q].downloadPath = '';
                queueData[q].imagePrefix = queueData[0].imagePrefix;
                queueData[q].autoBackup = queueData[0].autoBackup;
                queueData[q].selectedPrefixIds = [...queueData[0].selectedPrefixIds];
                queueData[q].selectedSuffixIds = [...queueData[0].selectedSuffixIds];
                queueData[q].activePromptPresetIds = [...queueData[0].activePromptPresetIds];
                queueData[q].prevPromptCn = queueData[0].prevPromptCn;
                queueData[q].promptedSlotIndices = [...queueData[0].promptedSlotIndices];
                queueData[q].pinnedSlotIndices = [...queueData[0].pinnedSlotIndices];
                queueData[q].promptLang = queueData[0].promptLang;
                queueData[q].activePrefix = queueData[0].activePrefix;
                queueData[q].lastAutoPrompt = queueData[0].lastAutoPrompt;
            }
        }
        saveQueueData();
        activeQueue = 0;
    } else {
        // 切换回同图抽卡：从队列0恢复数据（包括 API 配置）
        activeQueue = 0;
        saveQueueData();
        loadQueueData(0);
        // 恢复队列0的 API 配置到 DOM
        restoreApiConfigToDOM(queueData[0]);
    }

    renderQueueNumberBars();
    updateGenerateBtnText();
    updateClearButtonsVisibility();
    // 批量生成按钮：仅多图列队模式显示
    const batchBtn = document.getElementById('btn-api-batch-generate');
    if (batchBtn) batchBtn.style.display = mode === 'multi' ? 'inline-flex' : 'none';
}
// queueMode 和 activeQueue 从服务端加载（loadAllData 中处理）

// ---------- 清除图片槽按钮 ----------
function updateClearButtonsVisibility() {
    const clearAllBtn = document.getElementById('btn-clear-all-groups');
    if (clearAllBtn) clearAllBtn.style.display = queueMode === 'multi' ? 'inline-flex' : 'none';
}

document.getElementById('btn-clear-current-group')?.addEventListener('click', () => {
    const hasImages = imageState.slots.some(s => s.image);
    const promptCn = document.getElementById('img-prompt-cn')?.value || '';
    const promptEn = document.getElementById('img-prompt-en')?.value || '';
    if (!hasImages && !promptCn && !promptEn) { showToast('当前组没有图片素材和提示词', 'info'); return; }
    if (!confirm('确认清除当前组的所有图片素材和提示词？（不会删除本地文件）')) return;
    pushUndoSnapshot();
    logAction('slot', '清除当前组图片和提示词', { queue: queueMode === 'multi' ? activeQueue + 1 : 'same' });
    for (let i = 0; i < imageState.slots.length; i++) {
        imageState.slots[i] = { image: '', label: '', prefixTemplate: imageState.slots[i].prefixTemplate || '请参考' };
    }
    // 清除提示词
    imageState.promptCn = '';
    imageState.promptEn = '';
    const promptCnEl = document.getElementById('img-prompt-cn');
    const promptEnEl = document.getElementById('img-prompt-en');
    if (promptCnEl) promptCnEl.value = '';
    if (promptEnEl) promptEnEl.value = '';
    // 清除词库选中状态（前缀、后缀、条目），避免残留选中干扰下次生成
    state.selectedPrefixes = [];
    state.selectedSuffixes = [];
    state.selectedItems = {};
    if (queueMode === 'multi') {
        queueData[activeQueue].slots = deepClone(imageState.slots);
        queueData[activeQueue].promptCn = '';
        queueData[activeQueue].promptEn = '';
    }
    saveQueueData();
    saveSelection();
    renderCategoryList();
    updatePreview();
    renderImageSlots();
    showToast('已清除当前组图片素材和提示词', 'success');
});

document.getElementById('btn-clear-all-groups')?.addEventListener('click', () => {
    let totalImages = 0;
    let totalPrompts = 0;
    for (let q = 0; q < QUEUE_COUNT; q++) {
        totalImages += queueData[q].slots.filter(s => s.image).length;
        if (queueData[q].promptCn || queueData[q].promptEn) totalPrompts++;
    }
    if (totalImages === 0 && totalPrompts === 0) { showToast('所有组都没有图片素材和提示词', 'info'); return; }
    if (!confirm(`确认清除所有组的图片素材和提示词？共${totalImages}张图片（不会删除本地文件）`)) return;
    pushUndoSnapshot();
    logAction('slot', '清除所有组图片和提示词', { totalImages });
    for (let q = 0; q < QUEUE_COUNT; q++) {
        for (let i = 0; i < queueData[q].slots.length; i++) {
            queueData[q].slots[i] = { image: '', label: '', prefixTemplate: queueData[q].slots[i].prefixTemplate || '请参考' };
        }
        queueData[q].promptCn = '';
        queueData[q].promptEn = '';
    }
    // 同步当前显示
    imageState.slots = deepClone(queueData[activeQueue].slots);
    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
    }
    imageState.promptCn = '';
    imageState.promptEn = '';
    const promptCnEl = document.getElementById('img-prompt-cn');
    const promptEnEl = document.getElementById('img-prompt-en');
    if (promptCnEl) promptCnEl.value = '';
    if (promptEnEl) promptEnEl.value = '';
    saveQueueData();
    renderImageSlots();
    showToast('已清除所有组图片素材和提示词', 'success');
});

updateClearButtonsVisibility();

// ---------- 模式切换 ----------
let currentMode = 'prompt';
try { currentMode = localStorage.getItem('app-mode') || 'prompt'; } catch(e) {}

function switchMode(mode) {
    // 切换模式前保存图生图数据
    if (currentMode === 'image' && queueMode === 'multi') {
        saveCurrentQueueData();
    }
    // 切换模式前保存拆图数据
    if (currentMode === 'split') {
        saveCurrentSplitQueueData();
    }
    // 切换前保存当前模式的提示词文本，避免切换后丢失
    const savedPrompts = {
        promptZh: $('#prompt-preview')?.value || '',
        promptEn: document.getElementById('img-prompt-en')?.value || ''
    };

    currentMode = mode;
    try { localStorage.setItem('app-mode', mode); } catch(e) {}

    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    const promptMode = document.querySelector('.main-content:not(#image-mode):not(#split-mode)');
    const imageMode = document.getElementById('image-mode');
    const splitMode = document.getElementById('split-mode');

    if (mode === 'image') {
        if (promptMode) promptMode.style.display = 'none';
        if (imageMode) imageMode.style.display = 'flex';
        if (splitMode) splitMode.style.display = 'none';
        if (!imageState.loaded) loadImageModeData();
    } else if (mode === 'split') {
        if (promptMode) promptMode.style.display = 'none';
        if (imageMode) imageMode.style.display = 'none';
        if (splitMode) splitMode.style.display = 'flex';
        if (!splitModeLoaded) loadSplitModeData();
        else renderSplitLibrary();
    } else {
        if (promptMode) promptMode.style.display = 'flex';
        if (imageMode) imageMode.style.display = 'none';
        if (splitMode) splitMode.style.display = 'none';
    }

    // 切换后恢复提示词文本
    if (savedPrompts.promptZh && $('#prompt-preview')) {
        $('#prompt-preview').value = savedPrompts.promptZh;
    }
    if (savedPrompts.promptEn && document.getElementById('img-prompt-en')) {
        document.getElementById('img-prompt-en').value = savedPrompts.promptEn;
    }
}

// 绑定模式切换按钮
document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

// 恢复上次模式
if (currentMode === 'image') {
    switchMode('image');
} else if (currentMode === 'split') {
    switchMode('split');
}

// ---------- 数据加载 ----------
async function loadImageModeData() {
    try {
        const [libData, presetsData] = await Promise.all([
            api('GET', '/api/image-library'),
            api('GET', '/api/image-presets')
        ]);
        imageState.library = libData.categories || [];
        imageState.presets = presetsData.presets || [];
        imageState.loaded = true;
        renderImageMode();
    } catch (e) {
        console.error('加载文生图数据失败:', e);
        showToast('加载文生图数据失败', 'error');
    }
}

function renderImageMode() {
    renderImageLibrary();
    renderImageSlots();
    renderImagePresets();
}

// ---------- 素材库渲染（子分类结构，图生图 / 拆图共用 DOM 逻辑） ----------
const LIB_MATERIAL_DRAG_MIME = 'application/x-ai-lib-material+json';

function parseLibMaterialDragPayload(dataTransfer) {
    if (!dataTransfer) return null;
    try {
        let raw = dataTransfer.getData(LIB_MATERIAL_DRAG_MIME);
        if (!raw) raw = dataTransfer.getData('text/plain');
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (o && typeof o.url === 'string' && o.url) return { url: o.url, name: o.name || '' };
    } catch (_) { /* ignore */ }
    return null;
}

function bindLibraryPanelBlankDropTarget(container) {
    if (!container || container._aiLibBlankDropBound) return;
    container._aiLibBlankDropBound = true;
    container.addEventListener('dragover', (e) => { e.preventDefault(); container.style.outline = '2px dashed var(--accent)'; container.style.outlineOffset = '-4px'; });
    container.addEventListener('dragleave', () => { container.style.outline = ''; container.style.outlineOffset = ''; });
    container.addEventListener('drop', (e) => {
        e.preventDefault(); container.style.outline = ''; container.style.outlineOffset = '';
        const targetCat = imageState.library.find(c => c.id === imageState.expandedLibCategory) || imageState.library[0];
        if (!targetCat) return;
        const subs = targetCat.subcategories || [];
        const targetSub = subs.find(s => s.name === '默认' || s._isDefault) || subs[0];
        if (targetSub) handleLibDrop(e, targetCat, targetSub);
    });
}

async function renderLibraryPanel(opts = {}) {
    const containerId = opts.containerId || 'image-library-body';
    const context = opts.context || 'image';
    const keyword = opts.keyword !== undefined ? opts.keyword : imageState.libSearchKeyword.trim().toLowerCase();
    const scheduleRerender = () => { void (context === 'split' ? renderSplitLibrary() : renderImageLibrary()); };

    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (imageState.library.length === 0) {
        container.innerHTML = '<p class="empty-hint">点击上方按钮添加素材分类</p>';
        bindLibraryPanelBlankDropTarget(container);
        return;
    }

    for (const cat of imageState.library) {
        const isExpanded = imageState.expandedLibCategory === cat.id;
        const subcategories = cat.subcategories || [];

        // 搜索过滤：跨子分类搜索
        let searchItems = [];
        if (keyword) {
            for (const sub of subcategories) {
                for (const item of (sub.items || [])) {
                    if ((item.name || '').toLowerCase().includes(keyword)) {
                        searchItems.push({ item, sub, cat });
                    }
                }
            }
            if (searchItems.length === 0) continue;
        }

        // 统计总条目数
        const totalItems = subcategories.reduce((sum, sub) => sum + (sub.items || []).length, 0);

        const catEl = document.createElement('div');
        catEl.className = 'category-item';

        const header = document.createElement('div');
        header.className = 'category-header';
        header.innerHTML = `
            <span class="category-arrow ${isExpanded ? 'expanded' : ''}">▶</span>
            <span class="category-name">${escHtml(cat.name)}</span>
            <span class="category-summary">${totalItems}项</span>
            <div class="category-actions">
                <button class="btn-icon edit-lib-cat" title="编辑">✎</button>
                <button class="btn-icon danger delete-lib-cat" title="删除">×</button>
            </div>
        `;
        header.addEventListener('click', (e) => {
            if (e.target.closest('.edit-lib-cat')) { e.stopPropagation(); editImageLibCategory(cat); return; }
            if (e.target.closest('.delete-lib-cat')) { e.stopPropagation(); deleteImageLibCategory(cat); return; }
            imageState.expandedLibCategory = imageState.expandedLibCategory === cat.id ? null : cat.id;
            scheduleRerender();
        });

        const body = document.createElement('div');
        body.className = `category-body ${isExpanded ? 'expanded' : ''}`;

        // 搜索模式：直接显示搜索结果
        if (keyword) {
            const grid = document.createElement('div');
            grid.className = 'prop-items-grid';
            grid.style.gridTemplateColumns = `repeat(${imageState.libZoom}, 1fr)`;
            for (const { item, sub } of searchItems) {
                grid.appendChild(createLibItemCard(cat, sub, item, context));
            }
            body.appendChild(grid);
            catEl.appendChild(header);
            catEl.appendChild(body);
            container.appendChild(catEl);
            continue;
        }

        // 正常模式：按子分类显示
        // 若未设置“默认”，使用第一个子分类作为直显区；若完全没有子分类，先显示上传入口
        let defaultSub = subcategories.find(s => s.name === '默认' || s._isDefault) || subcategories[0] || null;
        if (defaultSub) defaultSub._isDefault = true;

        // 先渲染默认子分类（不显示子分类标题，直接显示素材网格）
        {
            const grid = document.createElement('div');
            grid.className = 'prop-items-grid';
            grid.style.gridTemplateColumns = `repeat(${imageState.libZoom}, 1fr)`;

            for (const item of ((defaultSub && defaultSub.items) || [])) {
                grid.appendChild(createLibItemCard(cat, defaultSub, item, context));
            }

            // 添加素材按钮
            const addCard = document.createElement('div');
            addCard.className = 'prop-add-item';
            addCard.textContent = '+ 添加';
            addCard.title = '点击选择文件或拖拽图片到此处';
            addCard.addEventListener('click', () => addLibSubItem(cat, defaultSub));
            addCard.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); addCard.classList.add('drag-over'); });
            addCard.addEventListener('dragleave', (e) => { e.preventDefault(); addCard.classList.remove('drag-over'); });
            addCard.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addCard.classList.remove('drag-over'); handleLibDrop(e, cat, defaultSub); });
            grid.appendChild(addCard);

            // 批量上传按钮
            const addBatchCard = document.createElement('div');
            addBatchCard.className = 'prop-add-item';
            addBatchCard.textContent = '+ 批量';
            addBatchCard.title = '批量上传到该子分类（点击或拖拽）';
            addBatchCard.addEventListener('click', () => addLibSubItem(cat, defaultSub, true));
            addBatchCard.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); addBatchCard.classList.add('drag-over'); });
            addBatchCard.addEventListener('dragleave', (e) => { e.preventDefault(); addBatchCard.classList.remove('drag-over'); });
            addBatchCard.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addBatchCard.classList.remove('drag-over'); handleLibDrop(e, cat, defaultSub); });
            grid.appendChild(addBatchCard);

            body.appendChild(grid);
        }

        // 再渲染其他子分类（带标题的子分类）
        for (const sub of subcategories) {
            if (defaultSub && sub.id === defaultSub.id) continue; // 跳过默认子分类

            const subEl = document.createElement('div');
            subEl.className = 'prop-category';
            subEl.style.marginBottom = '4px';

            const isSubExpanded = imageState.expandedLibSubcategory === sub.id;
            const subHeader = document.createElement('div');
            subHeader.className = 'prop-category-header';
            subHeader.innerHTML = `
                <span class="category-arrow ${isSubExpanded ? 'expanded' : ''}" style="font-size:7px;">▶</span>
                <span class="prop-category-name">${escHtml(sub.name)}</span>
                <span class="prop-category-count">${(sub.items || []).length}</span>
                <div class="prop-category-actions">
                    <button class="btn-icon edit-lib-sub" title="编辑子分类">✎</button>
                    <button class="btn-icon danger delete-lib-sub" title="删除子分类">×</button>
                </div>
            `;
            subHeader.addEventListener('click', (e) => {
                if (e.target.closest('.edit-lib-sub')) { e.stopPropagation(); editLibSubcategory(cat, sub); return; }
                if (e.target.closest('.delete-lib-sub')) { e.stopPropagation(); deleteLibSubcategory(cat, sub); return; }
                imageState.expandedLibSubcategory = imageState.expandedLibSubcategory === sub.id ? null : sub.id;
                scheduleRerender();
            });

            const subBody = document.createElement('div');
            subBody.className = `prop-category-body ${isSubExpanded ? 'expanded' : ''}`;

            const grid = document.createElement('div');
            grid.className = 'prop-items-grid';
            grid.style.gridTemplateColumns = `repeat(${imageState.libZoom}, 1fr)`;

            for (const item of (sub.items || [])) {
                grid.appendChild(createLibItemCard(cat, sub, item, context));
            }

            // 添加素材按钮（支持点击和拖拽）
            const addCard = document.createElement('div');
            addCard.className = 'prop-add-item';
            addCard.textContent = '+ 添加';
            addCard.title = '点击选择文件或拖拽图片到此处';
            addCard.addEventListener('click', () => addLibSubItem(cat, sub));
            // 拖拽支持
            addCard.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); addCard.classList.add('drag-over'); });
            addCard.addEventListener('dragleave', (e) => { e.preventDefault(); addCard.classList.remove('drag-over'); });
            addCard.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addCard.classList.remove('drag-over'); handleLibDrop(e, cat, sub); });
            grid.appendChild(addCard);

            // 批量上传按钮（支持点击和拖拽）
            const addBatchCard = document.createElement('div');
            addBatchCard.className = 'prop-add-item';
            addBatchCard.textContent = '+ 批量';
            addBatchCard.title = '批量上传到该子分类（点击或拖拽）';
            addBatchCard.addEventListener('click', () => addLibSubItem(cat, sub, true));
            addBatchCard.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); addBatchCard.classList.add('drag-over'); });
            addBatchCard.addEventListener('dragleave', (e) => { e.preventDefault(); addBatchCard.classList.remove('drag-over'); });
            addBatchCard.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addBatchCard.classList.remove('drag-over'); handleLibDrop(e, cat, sub); });
            grid.appendChild(addBatchCard);

            subBody.appendChild(grid);
            subEl.appendChild(subHeader);
            subEl.appendChild(subBody);
            body.appendChild(subEl);
        }

        // 添加子分类按钮
        const addSubRow = document.createElement('div');
        addSubRow.className = 'add-item-row';
        addSubRow.textContent = '+ 添加子分类';
        addSubRow.addEventListener('click', () => addLibSubcategory(cat));
        body.appendChild(addSubRow);

        catEl.appendChild(header);
        catEl.appendChild(body);

        // 分类级别拖拽：拖到分类区域任意位置都能添加到默认子分类
        if (defaultSub) {
            catEl.addEventListener('dragover', (e) => { e.preventDefault(); catEl.classList.add('drag-over'); });
            catEl.addEventListener('dragleave', (e) => { if (!catEl.contains(e.relatedTarget)) catEl.classList.remove('drag-over'); });
            catEl.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); catEl.classList.remove('drag-over'); handleLibDrop(e, cat, defaultSub); });
        }

        container.appendChild(catEl);
    }

    bindLibraryPanelBlankDropTarget(container);
}

async function renderImageLibrary() {
    await renderLibraryPanel({
        containerId: 'image-library-body',
        keyword: imageState.libSearchKeyword.trim().toLowerCase(),
        context: 'image'
    });
    await maybeRenderSplitLibrarySidebar();
}

async function maybeRenderSplitLibrarySidebar() {
    const sm = document.getElementById('split-mode');
    if (!sm || sm.style.display !== 'flex') return;
    await renderSplitLibrary();
}

// 创建素材卡片（子分类版本）；context: image | split — split 下点击/拖拽填入拆图参考素材槽
function createLibItemCard(cat, sub, item, context = 'image') {
    const card = document.createElement('div');
    card.className = 'prop-item-card';
    card.title = context === 'split'
        ? `拖拽到右侧「参考素材」槽，或点击填入首个空槽`
        : `点击将"${item.name}"填入当前图片槽；可拖到图片槽`;

    const imgHtml = item.image
        ? `<img src="${escHtml(item.image)}" alt="${escHtml(item.name)}" class="prop-item-img" draggable="false">`
        : `<div class="prop-item-no-img">📷</div>`;

    // 操作按钮：上传/重新上传图片、删除图片、编辑名称、删除素材
    const hasImage = !!item.image;
    const uploadTitle = hasImage ? '重新上传' : '上传图片';
    const deleteImgBtn = hasImage ? `<button type="button" draggable="false" class="btn-icon danger delete-lib-img" title="删除图片">🗑</button>` : '';

    card.innerHTML = `
        ${imgHtml}
        <div class="prop-item-name">${escHtml(item.name)}</div>
        <div class="prop-item-actions">
            <button type="button" draggable="false" class="btn-icon upload-lib-img" title="${uploadTitle}">🖼</button>
            ${deleteImgBtn}
            <button type="button" draggable="false" class="btn-icon edit-lib-item" title="编辑名称">✎</button>
            <button type="button" draggable="false" class="btn-icon danger delete-lib-item" title="删除素材">×</button>
        </div>
    `;

    if (item.image) {
        card.draggable = true;
        card.addEventListener('dragstart', (e) => {
            const payload = JSON.stringify({ url: item.image, name: item.name || '' });
            try {
                e.dataTransfer.setData(LIB_MATERIAL_DRAG_MIME, payload);
                e.dataTransfer.setData('text/plain', payload);
            } catch (_) {
                e.dataTransfer.setData('text/plain', payload);
            }
            e.dataTransfer.effectAllowed = 'copy';
        });
    } else {
        card.draggable = false;
    }

    card.addEventListener('click', (e) => {
        if (e.target.closest('.upload-lib-img')) { e.stopPropagation(); uploadLibSubImage(cat, sub, item); return; }
        if (e.target.closest('.delete-lib-img')) { e.stopPropagation(); deleteLibItemImage(cat, sub, item); return; }
        if (e.target.closest('.edit-lib-item')) { e.stopPropagation(); editLibSubItem(cat, sub, item); return; }
        if (e.target.closest('.delete-lib-item')) { e.stopPropagation(); deleteLibSubItem(cat, sub, item); return; }
        if (context === 'split') fillSplitMaterialFromLibrary(item, cat.name);
        else fillSlotFromMaterial(item, cat.name);
    });

    const imgEl = card.querySelector('.prop-item-img');
    if (imgEl) {
        imgEl.addEventListener('click', (e) => {
            if (e.target.closest('.prop-item-actions')) return;
            e.stopPropagation();
            showImagePreview(item.image);
        });
    }

    return card;
}

// 素材库搜索
document.getElementById('img-lib-search').addEventListener('input', (e) => {
    imageState.libSearchKeyword = e.target.value;
    renderImageLibrary();
});

// ---------- Tab 切换（素材库 / 图生图预设） ----------
document.querySelectorAll('.lib-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        imageState.activeLibTab = tab;
        document.querySelectorAll('.lib-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
        const libPanel = document.getElementById('image-library-top');
        const presetPanel = document.getElementById('image-preset-bottom');
        if (tab === 'library') {
            libPanel.style.display = 'flex';
            presetPanel.style.display = 'none';
        } else {
            libPanel.style.display = 'none';
            presetPanel.style.display = 'flex';
        }
    });
});

// ---------- 素材库缩放滑杆 ----------
const libZoomSlider = document.getElementById('lib-zoom-slider');
const splitLibZoomSlider = document.getElementById('split-lib-zoom-slider');
if (libZoomSlider) {
    const savedLibZoom = localStorage.getItem('lib-zoom');
    if (savedLibZoom) { imageState.libZoom = parseInt(savedLibZoom, 10) || 2; libZoomSlider.value = imageState.libZoom; }
    if (splitLibZoomSlider) splitLibZoomSlider.value = String(imageState.libZoom);
    libZoomSlider.addEventListener('input', (e) => {
        imageState.libZoom = parseInt(e.target.value, 10);
        try { localStorage.setItem('lib-zoom', imageState.libZoom); } catch(err) {}
        if (splitLibZoomSlider) splitLibZoomSlider.value = String(imageState.libZoom);
        renderImageLibrary();
    });
}
if (splitLibZoomSlider && !splitLibZoomSlider._bound) {
    splitLibZoomSlider._bound = true;
    splitLibZoomSlider.value = String(imageState.libZoom || 2);
    splitLibZoomSlider.addEventListener('input', (e) => {
        imageState.libZoom = parseInt(e.target.value, 10);
        try { localStorage.setItem('lib-zoom', imageState.libZoom); } catch(err) {}
        if (libZoomSlider) libZoomSlider.value = String(imageState.libZoom);
        void renderSplitLibrary();
        void renderImageLibrary();
    });
}

// ---------- 图生图预设缩放滑杆 ----------
const imgPresetZoomSlider = document.getElementById('img-preset-zoom-slider');
if (imgPresetZoomSlider) {
    const savedZoom = localStorage.getItem('img-preset-zoom');
    if (savedZoom) { imageState.imgPresetZoom = parseInt(savedZoom, 10) || 3; imgPresetZoomSlider.value = imageState.imgPresetZoom; }
    imgPresetZoomSlider.addEventListener('input', (e) => {
        imageState.imgPresetZoom = parseInt(e.target.value, 10);
        try { localStorage.setItem('img-preset-zoom', imageState.imgPresetZoom); } catch(err) {}
        renderImagePresets();
    });
}

// 素材填入槽位（语义自动设为分类名）
function fillSlotFromMaterial(item, categoryName) {
    const idx = imageState.activeSlotIndex;
    if (idx >= 0 && idx < imageState.slots.length) {
        if (item.image) imageState.slots[idx].image = item.image;
        // 更换图片时重置 DW 状态
        imageState.slots[idx].dwEnabled = false;
        imageState.slots[idx].dwOriginalImage = '';
        // 语义标签自动设为分类名（如"五官"、"发型"）
        imageState.slots[idx].label = categoryName || item.name;
        renderImageSlots();
        updateLocalPrompt();
        showToast(`已填入 Image ${idx + 1}，语义：${categoryName || item.name}`, 'success');
    }
}

/** 拆图参考素材槽：从素材库点击填入首个空槽 */
function fillSplitMaterialFromLibrary(item, categoryName) {
    if (!item?.image) {
        showToast('该素材没有图片地址', 'warning');
        return;
    }
    const workItem = getActiveSplitWorkItem(activeSplitQueue);
    if (!workItem) {
        showToast('请先完成九宫格拆分并选中编号', 'warning');
        return;
    }
    if (!workItem.materials) workItem.materials = [null, null, null];
    const idx = workItem.materials.findIndex(m => !m);
    if (idx < 0) {
        showToast('三个参考素材槽已满，请点击槽内图片清空后再试', 'warning');
        return;
    }
    workItem.materials[idx] = item.image;
    _renderSplitMaterialSlot(idx);
    saveSplitQueueData();
    showToast(`已填入参考素材 ${idx + 1}${categoryName ? `（${categoryName}）` : ''}`, 'success');
}

function applyLibraryPayloadToSplitMaterialSlot(slotIdx, payload) {
    if (!payload?.url || slotIdx < 0 || slotIdx > 2) return false;
    const workItem = getActiveSplitWorkItem(activeSplitQueue);
    if (!workItem) {
        showToast('请先完成九宫格拆分并选中编号', 'warning');
        return false;
    }
    if (!workItem.materials) workItem.materials = [null, null, null];
    workItem.materials[slotIdx] = payload.url;
    _renderSplitMaterialSlot(slotIdx);
    saveSplitQueueData();
    showToast(`参考素材槽 ${slotIdx + 1} 已更新`, 'success');
    return true;
}

// 素材库分类 CRUD
async function editImageLibCategory(cat) {
    const name = await showPrompt('修改分类名称', cat.name, '分类名称');
    if (!name || !name.trim()) return;
    try {
        const updated = await api('PUT', `/api/image-library/${cat.id}`, { name: name.trim() });
        cat.name = updated.name;
        renderImageLibrary();
        showToast('修改成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteImageLibCategory(cat) {
    pushUndoSnapshot();
    showConfirm(`删除素材分类"${cat.name}"将同时删除其下所有子分类和素材，确定吗？`, async () => {
        try {
            await api('DELETE', `/api/image-library/${cat.id}`);
            imageState.library = imageState.library.filter(c => c.id !== cat.id);
            if (imageState.expandedLibCategory === cat.id) imageState.expandedLibCategory = null;
            renderImageLibrary();
            showToast('删除成功', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

// 子分类 CRUD
async function addLibSubcategory(cat) {
    pushUndoSnapshot();
    const name = await showPrompt(`在"${cat.name}"下添加子分类`, '', '子分类名称');
    if (!name || !name.trim()) return;
    try {
        const sub = await api('POST', `/api/image-library/${cat.id}/subcategories`, { name: name.trim() });
        if (!cat.subcategories) cat.subcategories = [];
        cat.subcategories.push(sub);
        imageState.expandedLibCategory = cat.id;
        imageState.expandedLibSubcategory = sub.id;
        renderImageLibrary();
        showToast('子分类添加成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function editLibSubcategory(cat, sub) {
    pushUndoSnapshot();
    const name = await showPrompt('修改子分类名称', sub.name, '子分类名称');
    if (!name || !name.trim()) return;
    try {
        const updated = await api('PUT', `/api/image-library/${cat.id}/subcategories/${sub.id}`, { name: name.trim() });
        sub.name = updated.name;
        renderImageLibrary();
        showToast('修改成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function deleteLibSubcategory(cat, sub) {
    showConfirm(`删除子分类"${sub.name}"将同时删除其下所有素材，确定吗？`, async () => {
        try {
            await api('DELETE', `/api/image-library/${cat.id}/subcategories/${sub.id}`);
            cat.subcategories = cat.subcategories.filter(s => s.id !== sub.id);
            if (imageState.expandedLibSubcategory === sub.id) imageState.expandedLibSubcategory = null;
            renderImageLibrary();
            showToast('删除成功', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

// 子分类下条目 CRUD
async function addLibSubItem(cat, sub, forceBatch = false) {
    pushUndoSnapshot();
    // 如果已经在某个子分类内点击添加，直接用该子分类，不再弹出选择
    // 只有从分类级别（无sub）添加时才需要选择子分类
    if (!sub) {
        const subcategories = cat.subcategories || [];

        if (subcategories.length > 1) {
            // 有多个子分类，让用户选择
            const options = subcategories.map(s => s.name).join('、');
            const choice = await showPrompt(`选择子分类（${options}），或输入”新建”`, '', '子分类名称');
            if (!choice || !choice.trim()) return;

            if (choice.trim() === '新建' || choice.trim() === '新建子分类') {
                const subName = await showPrompt('新子分类名称', '', '子分类名称');
                if (!subName || !subName.trim()) return;
                try {
                    const newSub = await api('POST', `/api/image-library/${cat.id}/subcategories`, { name: subName.trim() });
                    cat.subcategories.push(newSub);
                    sub = newSub;
                    imageState.expandedLibSubcategory = newSub.id;
                } catch (e) { showToast(e.message, 'error'); return; }
            } else {
                const found = subcategories.find(s => s.name === choice.trim());
                if (!found) { showToast('未找到该子分类', 'error'); return; }
                sub = found;
            }
        }

        // 没有子分类时自动创建”默认”子分类
        if (!sub) {
            if (subcategories.length === 1) {
                sub = subcategories[0];
            } else {
                try {
                    const created = await api('POST', `/api/image-library/${cat.id}/subcategories`, { name: '默认' });
                    if (!cat.subcategories) cat.subcategories = [];
                    cat.subcategories.push(created);
                    sub = created;
                } catch (e) {
                    showToast('请先添加子分类后再上传素材', 'error');
                    return;
                }
            }
        }
    }

    // 统一文件选择：支持单张/多张；命名默认取文件名（可修改）
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.webp';
    input.multiple = true;
    input.onchange = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;

        const isBatch = forceBatch || files.length > 1;
        let useDefaultAll = true;
        if (isBatch) {
            useDefaultAll = confirm(`将批量导入 ${files.length} 张到「${sub.name}」。\n确定=全部使用文件名命名；取消=逐张确认命名`);
        }

        let success = 0;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const defaultName = getFileBaseName(file.name);
            let finalName = defaultName;

            if (!isBatch || !useDefaultAll) {
                const nameInput = await showPrompt(`素材名称（${i + 1}/${files.length}）`, defaultName, '名称');
                if (nameInput === null) continue; // 跳过该文件
                finalName = (nameInput || '').trim() || defaultName;
            }

            try {
                // 读取图片用于裁剪
                const dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                // 弹出裁剪框
                const croppedBlob = await new Promise((resolve) => {
                    showCropModal(dataUrl, (blob) => resolve(blob));
                });

                if (!croppedBlob) continue; // 用户取消裁剪

                const formData = new FormData();
                formData.append('file', croppedBlob, file.name.replace(/\.\w+$/, '.jpg'));
                const imageUrl = await uploadImage(formData);
                await api('POST', `/api/image-library/${cat.id}/subcategories/${sub.id}/items`, {
                    name: finalName,
                    image: imageUrl
                });
                success++;
            } catch (err) {
                showToast(`第${i + 1}张上传失败：${err.message}`, 'error');
            }
        }

        if (success > 0) {
            await reloadImageLibrary();
            imageState.expandedLibCategory = cat.id;
            imageState.expandedLibSubcategory = sub.id;
            renderImageLibrary();
            showToast(`素材添加成功：${success}/${files.length}`, 'success');
        }
    };
    input.click();
}

// 拖拽文件到素材库添加/批量按钮的处理
async function handleLibDrop(dropEvent, cat, sub) {
    const files = Array.from(dropEvent.dataTransfer.files || []).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f.name));
    if (!files.length) { showToast('请拖入图片文件（jpg/png/webp）', 'error'); return; }

    // 确保子分类存在
    if (!sub) {
        const subcategories = cat.subcategories || [];
        if (subcategories.length === 1) {
            sub = subcategories[0];
        } else if (subcategories.length > 1) {
            showToast('请拖入到具体子分类的添加按钮中', 'error'); return;
        } else {
            try {
                const created = await api('POST', `/api/image-library/${cat.id}/subcategories`, { name: '默认' });
                if (!cat.subcategories) cat.subcategories = [];
                cat.subcategories.push(created);
                sub = created;
            } catch (e) { showToast('请先添加子分类', 'error'); return; }
        }
    }

    const isBatch = files.length > 1;
    let useDefaultAll = true;
    if (isBatch) {
        useDefaultAll = confirm(`将批量导入 ${files.length} 张到「${sub.name}」。\n确定=全部使用文件名命名；取消=逐张确认命名`);
    }

    let success = 0;
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const defaultName = getFileBaseName(file.name);
        let finalName = defaultName;

        if (!isBatch || !useDefaultAll) {
            const nameInput = await showPrompt(`素材名称（${i + 1}/${files.length}）`, defaultName, '名称');
            if (nameInput === null) continue;
            finalName = (nameInput || '').trim() || defaultName;
        }

        try {
            // 先读取图片用于裁剪
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });

            // 弹出裁剪框（3:4比例）
            const croppedBlob = await new Promise((resolve) => {
                showCropModal(dataUrl, (blob) => resolve(blob));
            });

            if (!croppedBlob) continue; // 用户取消裁剪

            const formData = new FormData();
            formData.append('file', croppedBlob, file.name.replace(/\.\w+$/, '.jpg'));
            const imageUrl = await uploadImage(formData);
            await api('POST', `/api/image-library/${cat.id}/subcategories/${sub.id}/items`, {
                name: finalName,
                image: imageUrl
            });
            success++;
        } catch (err) {
            showToast(`第${i + 1}张上传失败：${err.message}`, 'error');
        }
    }

    if (success > 0) {
        await reloadImageLibrary();
        imageState.expandedLibCategory = cat.id;
        imageState.expandedLibSubcategory = sub.id;
        renderImageLibrary();
        showToast(`素材添加成功：${success}/${files.length}`, 'success');
    }
}

// 重新从后端加载素材库数据
async function reloadImageLibrary() {
    try {
        const libData = await api('GET', '/api/image-library');
        imageState.library = libData.categories || [];
    } catch (e) { console.error('重新加载素材库失败:', e); }
}

// 素材编辑弹窗
let editMaterialState = null; // { catId, subId, itemId, name, image, cat }

function openEditMaterialModal(cat, sub, item) {
    editMaterialState = {
        catId: cat.id,
        subId: sub.id,
        itemId: item.id,
        name: item.name,
        image: item.image || '',
        cat: cat,
        newImage: null  // 新上传的图片Blob
    };

    document.getElementById('edit-material-name').value = item.name;

    // 填充子分类下拉
    const subSelect = document.getElementById('edit-material-subcategory');
    subSelect.innerHTML = '';
    for (const s of (cat.subcategories || [])) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.name;
        if (s.id === sub.id) opt.selected = true;
        subSelect.appendChild(opt);
    }

    // 显示当前图片
    const preview = document.getElementById('edit-material-preview');
    if (item.image) {
        preview.innerHTML = `<img src="${escHtml(item.image)}" style="width:100%;height:100%;object-fit:cover;">`;
        document.getElementById('btn-edit-material-delete-img').style.display = 'inline-flex';
    } else {
        preview.innerHTML = '<span style="color:var(--text-muted);font-size:11px;">无图片</span>';
        document.getElementById('btn-edit-material-delete-img').style.display = 'none';
    }

    editMaterialState.newImage = null;
    openModal('modal-edit-material');
}

// 编辑弹窗 - 更换图片
document.getElementById('btn-edit-material-upload')?.addEventListener('click', () => {
    uploadWithCrop(async (formData) => {
        try {
            const url = await uploadImage(formData);
            editMaterialState.image = url;
            editMaterialState.newImage = url;
            const preview = document.getElementById('edit-material-preview');
            preview.innerHTML = `<img src="${escHtml(url)}" style="width:100%;height:100%;object-fit:cover;">`;
            document.getElementById('btn-edit-material-delete-img').style.display = 'inline-flex';
            showToast('图片已更换', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });
});

// 编辑弹窗 - 删除图片
document.getElementById('btn-edit-material-delete-img')?.addEventListener('click', () => {
    editMaterialState.image = '';
    editMaterialState.newImage = '';
    const preview = document.getElementById('edit-material-preview');
    preview.innerHTML = '<span style="color:var(--text-muted);font-size:11px;">无图片</span>';
    document.getElementById('btn-edit-material-delete-img').style.display = 'none';
});

// 编辑弹窗 - 保存
document.getElementById('btn-confirm-edit-material')?.addEventListener('click', async () => {
    if (!editMaterialState) return;
    const name = document.getElementById('edit-material-name').value.trim();
    if (!name) { showToast('名称不能为空', 'error'); return; }

    const newSubId = document.getElementById('edit-material-subcategory').value;
    const { catId, subId, itemId, image } = editMaterialState;

    try {
        // 先更新当前条目的名称和图片
        const updated = await api('PUT', `/api/image-library/${catId}/subcategories/${subId}/items/${itemId}`, {
            name: name,
            image: image
        });

        // 如果子分类变了，需要移动条目
        if (newSubId !== subId) {
            // 在新子分类下创建条目
            await api('POST', `/api/image-library/${catId}/subcategories/${newSubId}/items`, {
                name: name,
                image: image
            });
            // 删除旧条目
            await api('DELETE', `/api/image-library/${catId}/subcategories/${subId}/items/${itemId}`);
        }

        await reloadImageLibrary();
        renderImageLibrary();
        closeModal('modal-edit-material');
        showToast('素材修改成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
});

async function editLibSubItem(cat, sub, item) {
    // 打开完整编辑弹窗
    openEditMaterialModal(cat, sub, item);
}

async function deleteLibItemImage(cat, sub, item) {
    // 只删除图片，保留素材条目
    showConfirm(`删除"${item.name}"的图片？素材名称会保留。`, async () => {
        try {
            await api('PUT', `/api/image-library/${cat.id}/subcategories/${sub.id}/items/${item.id}`, { name: item.name, image: '' });
            await reloadImageLibrary();
            renderImageLibrary();
            showToast('图片已删除，可重新上传', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

async function deleteLibSubItem(cat, sub, item) {
    pushUndoSnapshot();
    showConfirm(`确定删除素材"${item.name}"吗？`, async () => {
        try {
            await api('DELETE', `/api/image-library/${cat.id}/subcategories/${sub.id}/items/${item.id}`);
            await reloadImageLibrary();
            renderImageLibrary();
            showToast('删除成功', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

async function uploadLibSubImage(cat, sub, item) {
    // 重新上传/上传图片（带3:4裁剪）
    uploadWithCrop(async (formData) => {
        try {
            const url = await uploadImage(formData);
            await api('PUT', `/api/image-library/${cat.id}/subcategories/${sub.id}/items/${item.id}`, { name: item.name, image: url });
            await reloadImageLibrary();
            renderImageLibrary();
            showToast('图片已更换', 'success');
        } catch (err) { showToast(err.message, 'error'); }
    });
}

// 添加素材分类
document.getElementById('btn-add-img-lib-category').addEventListener('click', async () => {
    const name = await showPrompt('输入新素材分类名称', '', '分类名称');
    if (!name || !name.trim()) return;
    try {
        const cat = await api('POST', '/api/image-library', { name: name.trim() });
        imageState.library.push(cat);
        imageState.expandedLibCategory = cat.id;
        renderImageLibrary();
        showToast('添加成功', 'success');
    } catch (e) { showToast(e.message, 'error'); }
});

// ---------- 图片槽渲染（10个并排一排） ----------
// SLOT_COUNT 已在文件顶部声明

// 初始化队列数据
try { initQueueData(); } catch(e) { console.error('initQueueData error:', e); queueData = []; initQueueData(); }

// 队列模式按钮绑定
document.querySelectorAll('.queue-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const newMode = btn.dataset.queueMode;
        console.log('[queue-mode-btn] click, newMode:', newMode, 'currentMode:', currentMode, 'queueMode:', queueMode);
        try {
            if (newMode === 'split') {
                // 拆图模式：切换到独立模块
                switchMode('split');
                // 同时更新queueMode按钮的active状态
                document.querySelectorAll('.queue-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.queueMode === 'split'));
                return;
            }
            // 如果当前是拆图模式页面，先切回图生图
            if (currentMode === 'split') {
                switchMode('image');
            }
            switchQueueMode(newMode);
        } catch(e) {
            console.error('[queue-mode-btn] ERROR:', e);
        }
    });
});

// 恢复队列模式UI
if (queueMode === 'multi') {
    document.querySelectorAll('.queue-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.queueMode === 'multi');
    });
    loadQueueData(activeQueue);
    renderQueueNumberBars();
}
updateGenerateBtnText();
// 恢复批量生成按钮显隐
{
    const batchBtn = document.getElementById('btn-api-batch-generate');
    if (batchBtn) batchBtn.style.display = queueMode === 'multi' ? 'inline-flex' : 'none';
}

// 图片槽数据从服务端加载（loadAllData 中处理）

// 初始化10个槽位
if (imageState.slots.length < SLOT_COUNT) {
    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
    }
}

// 保存图片槽到localStorage
function saveSlotsToStorage() {
    // 多图队列模式时同步保存到队列数据
    if (queueMode === 'multi' && queueData[activeQueue]) {
        queueData[activeQueue].slots = deepClone(imageState.slots);
    }
    saveQueueData();
}

function renderImageSlots() {
    const container = document.getElementById('image-slots');
    if (!container) return;
    container.innerHTML = '';

    const zoomValue = parseInt(document.getElementById('slot-zoom-slider')?.value || '70', 10);
    const imgSize = zoomValue;

    for (let i = 0; i < SLOT_COUNT; i++) {
        const slot = imageState.slots[i];
        const isActive = imageState.activeSlotIndex === i;

        const slotEl = document.createElement('div');
        slotEl.className = `image-slot-compact ${isActive ? 'active' : ''}`;
        slotEl.dataset.slotIndex = i;

        const imgHtml = slot.image
            ? `<img src="${escHtml(slot.image)}" class="slot-compact-img" alt="Image ${i+1}" style="width:${imgSize}px;height:${imgSize}px;">`
            : `<div class="slot-compact-no-img" style="width:${imgSize}px;height:${imgSize}px;">+</div>`;

        const prefix = slot.prefixTemplate || '请参考';
        const semantic = slot.label || '';

        const pinBtn = (queueMode === 'multi' && slot.image) ? `<button class="slot-pin-btn ${pinnedSlotIndices.has(i) ? 'pinned' : ''}" title="${pinnedSlotIndices.has(i) ? '取消全列队' : '应用全列队'}">${pinnedSlotIndices.has(i) ? '📌' : '📍'}</button>` : '';
        const dwBtn = slot.image
            ? `<button class="slot-dw-btn ${slot.dwEnabled ? 'active' : ''}" title="DWPose 姿态提取">${slot._dwLoading ? '<span class="dw-spinner"></span>' : 'DW'}</button>`
            : '';
        slotEl.innerHTML = `
            <div class="slot-compact-image-area ${slot.dwEnabled ? 'dw-active' : ''}">${imgHtml}${slot.image ? '<button class="slot-change-btn" title="更换图片">✎</button>' : ''}${pinBtn}${dwBtn}</div>
            <div class="slot-compact-label">
                <span class="slot-prefix" title="点击编辑前缀">${escHtml(prefix)}</span><span class="slot-auto-text">图${i+1}${semantic ? '的' + escHtml(semantic) : ''}</span>
            </div>
        `;

        // 应用全列队按钮
        const pinEl = slotEl.querySelector('.slot-pin-btn');
        if (pinEl) {
            pinEl.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePinSlotToAllQueues(i);
            });
        }

        // DWPose 姿态提取按钮
        const dwEl = slotEl.querySelector('.slot-dw-btn');
        if (dwEl) {
            dwEl.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDW(i);
            });
        }

        // 前缀点击编辑
        const prefixEl = slotEl.querySelector('.slot-prefix');
        prefixEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newPrefix = await showPrompt('修改前缀模板', slot.prefixTemplate || '请参考', '前缀模板');
            if (newPrefix !== null && newPrefix.trim()) {
                imageState.slots[i].prefixTemplate = newPrefix.trim();
                renderImageSlots();
                updateLocalPrompt();
                // 持久化前缀设置：多图列队模式需同步到当前队列
                if (queueMode === 'multi') saveCurrentQueueData();
                saveQueueData();
            }
        });

        // 更换按钮（覆盖在图片右上角）
        const changeBtn = slotEl.querySelector('.slot-change-btn');
        if (changeBtn) {
            changeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                imageState.activeSlotIndex = i;
                renderImageSlots();
                openSelectMaterialModal();
            });
        }

        // 单击 → 预览大图，快速双击 → 替换图片（用计数器区分，不用dblclick事件）
        const imgArea = slotEl.querySelector('.slot-compact-image-area');
        let clickCount = 0;
        let clickTimer = null;
        imgArea.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.closest('.slot-change-btn') || e.target.closest('.slot-pin-btn')) return;
            if (imageState.activeSlotIndex !== i) {
                imageState.activeSlotIndex = i;
                renderImageSlots();
            }
            if (!slot.image) { openSelectMaterialModal(); return; }
            clickCount++;
            if (clickCount === 1) {
                // 第一次click：设定时器，300ms后执行单击动作（预览）
                clickTimer = setTimeout(() => {
                    clickCount = 0;
                    if (slot.image) showImagePreview(slot.image);
                    else openSelectMaterialModal();
                }, 300);
            } else if (clickCount >= 2) {
                // 第二次click（300ms内）：取消单击定时器，执行双击动作（替换）
                clearTimeout(clickTimer);
                clickCount = 0;
                openSelectMaterialModal();
            }
        });

        // 拖拽上传（接收外部文件，支持多文件批量裁剪）
        slotEl.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); slotEl.classList.add('drag-over'); });
        slotEl.addEventListener('dragleave', () => { slotEl.classList.remove('drag-over'); });
        slotEl.addEventListener('drop', async (e) => {
            e.preventDefault(); e.stopPropagation();
            slotEl.classList.remove('drag-over');
            const libPayload = parseLibMaterialDragPayload(e.dataTransfer);
            if (libPayload?.url) {
                imageState.activeSlotIndex = i;
                imageState.slots[i].image = libPayload.url;
                imageState.slots[i].dwEnabled = false;
                imageState.slots[i].dwOriginalImage = '';
                imageState.slots[i].label = libPayload.name || '素材库';
                renderImageSlots();
                updateLocalPrompt();
                showToast(`已从素材库拖拽填入 Image ${i + 1}`, 'success');
                logAction('slot', '素材库拖拽到槽', { slotIndex: i });
                return;
            }
            const imageFiles = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
            if (!imageFiles.length) return;
            if (imageFiles.length === 1) {
                // 单张：裁剪 → 分配素材 → 加载到槽位
                const reader = new FileReader();
                reader.onload = () => {
                    showCropModal(reader.result, async (croppedBlob) => {
                        const formData = new FormData();
                        formData.append('file', croppedBlob, 'cropped.jpg');
                        try {
                            const url = await uploadImage(formData);
                            // 弹出分配素材弹窗
                            const assignResult = await showAssignMaterial(url, imageFiles[0].name);
                            imageState.slots[i].image = url;
                            imageState.slots[i].dwEnabled = false;
                            imageState.slots[i].dwOriginalImage = '';
                            if (assignResult && assignResult.labels && assignResult.labels.length > 0) {
                                imageState.slots[i].label = assignResult.labels.join('、');
                            }
                            renderImageSlots();
                            updateLocalPrompt();
                            if (assignResult && assignResult.savedToLib) {
                                showToast('图片已存入素材库并加载到槽位', 'success');
                            } else {
                                showToast('图片已加载到槽位', 'success');
                            }
                            logAction('slot', '拖拽上传图片到槽', { slotIndex: i });
                        } catch (err) { showToast(err.message, 'error'); }
                    });
                };
                reader.readAsDataURL(imageFiles[0]);
            } else {
                // 多张：批量裁剪队列，每张裁剪后弹出分配弹窗
                startBatchCrop(imageFiles, i, (targetSlot, idx, total) => {
                    return async (croppedBlob) => {
                        const formData = new FormData();
                        formData.append('file', croppedBlob, 'cropped.jpg');
                        try {
                            const url = await uploadImage(formData);
                            // 弹出分配素材弹窗
                            const assignResult = await showAssignMaterial(url, imageFiles[idx].name);
                            if (targetSlot < SLOT_COUNT) {
                                imageState.slots[targetSlot].image = url;
                                imageState.slots[targetSlot].dwEnabled = false;
                                imageState.slots[targetSlot].dwOriginalImage = '';
                                if (assignResult && assignResult.labels && assignResult.labels.length > 0) {
                                    imageState.slots[targetSlot].label = assignResult.labels.join('、');
                                }
                                renderImageSlots();
                                updateLocalPrompt();
                                logAction('slot', '拖拽批量上传图片到槽', { slotIndex: targetSlot });
                            }
                            if (idx === total - 1) {
                                showToast('批量上传完成：' + total + '张', 'success');
                            }
                        } catch (err) { showToast('第' + (idx+1) + '张上传失败：' + err.message, 'error'); }
                    };
                });
            }
        });

        // 右键菜单：清除/本地上传
        slotEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const choice = confirm('确定清除该图片槽？\n\n取消 = 选择本地上传图片');
            if (choice) {
                pushUndoSnapshot();
                imageState.slots[i] = { image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' };
                compactAndRenumber();
                renderImageSlots();
                updateLocalPrompt();
            } else {
                uploadSlotImage(i);
            }
        });

        container.appendChild(slotEl);
    }
    saveSlotsToStorage();
    // 更新复制图片按钮的disabled状态
    const copyBtn = document.getElementById('btn-copy-images');
    if (copyBtn) copyBtn.disabled = !imageState.slots.some(s => s.image);
}

// 实时拼接本地Prompt（无AI）
// 记录上次拼接的内容，用于增量更新
let lastAutoPrompt = '';
// 记录已经参与提示词拼接的图片槽位索引集合
let promptedSlotIndices = new Set();
// 记录已应用全列队的图片槽位索引
let pinnedSlotIndices = new Set(JSON.parse(localStorage.getItem('pinnedSlotIndices') || '[]'));
// 记录固定前其他队列的原始槽位数据，用于取消固定时恢复
let pinnedSlotOriginals = {}; // { slotIndex: { queueIndex: slotData } }

// 应用/取消全列队：将当前槽位图片复制到所有列队的同一槽位
function togglePinSlotToAllQueues(slotIndex) {
    if (queueMode !== 'multi') return;
    const currentSlot = imageState.slots[slotIndex];
    if (!currentSlot.image && !currentSlot.label) return;

    // 确保queueData有QUEUE_COUNT个队列
    while (queueData.length < QUEUE_COUNT) {
        queueData.push({
            slots: Array.from({length: SLOT_COUNT}, () => ({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' })),
            promptCn: '', promptEn: '', results: []
        });
    }

    if (pinnedSlotIndices.has(slotIndex)) {
        // 取消：恢复其他列队该槽位的原始数据
        const originals = pinnedSlotOriginals[slotIndex] || {};
        for (let q = 0; q < QUEUE_COUNT; q++) {
            if (q === activeQueue) continue;
            if (!queueData[q].slots) queueData[q].slots = [];
            while (queueData[q].slots.length <= slotIndex) {
                queueData[q].slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
            }
            if (originals[q]) {
                queueData[q].slots[slotIndex] = deepClone(originals[q]);
            } else {
                queueData[q].slots[slotIndex] = { image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' };
            }
        }
        delete pinnedSlotOriginals[slotIndex];
        pinnedSlotIndices.delete(slotIndex);
        try { localStorage.setItem('pinnedSlotIndices', JSON.stringify(Array.from(pinnedSlotIndices))); } catch(e) {}
        saveQueueData();
        renderImageSlots();
        showToast(`已取消图${slotIndex + 1}的全列队应用`, 'info');
    } else {
        // 应用：先保存其他列队的原始数据，再复制
        const slotCopy = deepClone(currentSlot);
        pinnedSlotOriginals[slotIndex] = {};
        for (let q = 0; q < QUEUE_COUNT; q++) {
            if (q === activeQueue) continue;
            if (!queueData[q].slots) queueData[q].slots = [];
            while (queueData[q].slots.length <= slotIndex) {
                queueData[q].slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
            }
            // 保存原始数据
            pinnedSlotOriginals[slotIndex][q] = deepClone(queueData[q].slots[slotIndex]);
            queueData[q].slots[slotIndex] = slotCopy;
        }
        pinnedSlotIndices.add(slotIndex);
        try { localStorage.setItem('pinnedSlotIndices', JSON.stringify(Array.from(pinnedSlotIndices))); } catch(e) {}
        saveQueueData();
        renderImageSlots();
        showToast(`已将图${slotIndex + 1}应用到所有列队`, 'success');
    }
}

// DWPose 姿态提取开关
async function toggleDW(slotIndex) {
    const slot = imageState.slots[slotIndex];
    if (!slot.image) return;

    if (slot.dwEnabled) {
        // 关闭：恢复原图
        if (slot.dwOriginalImage) {
            slot.image = slot.dwOriginalImage;
            slot.dwOriginalImage = '';
        }
        slot.dwEnabled = false;
        renderImageSlots();
        if (queueMode === 'multi') saveCurrentQueueData();
        return;
    }

    // 开启：调用 DWPose 处理
    const originalImage = slot.image;
    slot._dwLoading = true;
    renderImageSlots();

    try {
        const result = await api('POST', '/api/dwpose-process', { imageUrl: originalImage });
        if (result.error) {
            showToast('DWPose 处理失败: ' + result.error, 'error');
            slot._dwLoading = false;
            renderImageSlots();
            return;
        }
        slot.dwOriginalImage = originalImage;
        slot.image = result.poseImageUrl;
        slot.dwEnabled = true;
    } catch (e) {
        showToast('DWPose 处理失败: ' + e.message, 'error');
    }
    slot._dwLoading = false;
    renderImageSlots();
    if (queueMode === 'multi') saveCurrentQueueData();
}

function updateLocalPrompt() {
    const parts = [];
    const currentSlotIndices = new Set();
    for (let i = 0; i < SLOT_COUNT; i++) {
        const slot = imageState.slots[i];
        if (slot.label || slot.image) {
            const prefix = slot.prefixTemplate || '请参考';
            const semantic = slot.label || '参考图';
            parts.push(`${prefix}图${i+1}的${semantic}`);
            currentSlotIndices.add(i);
        }
    }
    const promptCn = document.getElementById('img-prompt-cn');
    if (promptCn && document.activeElement !== promptCn) {
        const currentVal = promptCn.value.trim();
        const newVal = parts.join('，');

        // 空内容：直接设置
        if (!currentVal) {
            promptCn.value = newVal;
            lastAutoPrompt = newVal;
            promptedSlotIndices = new Set(currentSlotIndices);
            return;
        }

        // 如果当前内容是自动拼接的（或上次自动拼接的），直接覆盖
        const isAutoContent = /^(请参考|请模仿|请替换|请融合)/.test(currentVal) || currentVal === lastAutoPrompt;
        if (isAutoContent) {
            promptCn.value = newVal;
            lastAutoPrompt = newVal;
            promptedSlotIndices = new Set(currentSlotIndices);
            return;
        }

        // 已被AI改写过：只追加新增图片槽位的描述（不重复已有槽位）
        const newSlotIndices = [...currentSlotIndices].filter(i => !promptedSlotIndices.has(i));
        if (newSlotIndices.length > 0) {
            const newParts = [];
            for (const i of newSlotIndices) {
                const slot = imageState.slots[i];
                const prefix = slot.prefixTemplate || '请参考';
                const semantic = slot.label || '参考图';
                newParts.push(`${prefix}图${i+1}的${semantic}`);
            }
            const updatedVal = currentVal + '，' + newParts.join('，');
            promptCn.value = updatedVal;
            lastAutoPrompt = updatedVal;
            promptedSlotIndices = new Set([...promptedSlotIndices, ...newSlotIndices]);
            // 同时更新队列数据
            if (queueMode === 'multi') {
                queueData[activeQueue].promptCn = promptCn.value;
                saveQueueData();
            }
        }
        // 如果有图片被移除，不自动删除（避免破坏AI改写的内容）
    }
}

// 缩放滑杆
document.getElementById('slot-zoom-slider')?.addEventListener('input', () => {
    renderImageSlots();
});

// 批量修改前缀模板按钮
// 自定义前缀模板列表（持久化到服务端）
const DEFAULT_PREFIX_TEMPLATES = ['请参考', '请模仿', '请替换', '请融合'];
let prefixTemplates = [...DEFAULT_PREFIX_TEMPLATES];
let activePrefix = prefixTemplates[0] || '请参考';

// 从服务端加载前缀模板
async function loadPrefixTemplates() {
    try {
        const data = await api('GET', '/api/prefix-templates');
        if (data && Array.isArray(data.templates)) {
            // 一次性迁移：如果localStorage有数据且服务端只有默认值，用localStorage覆盖
            const localData = localStorage.getItem('prefixTemplates');
            if (localData && data.templates.length <= DEFAULT_PREFIX_TEMPLATES.length) {
                try {
                    const parsed = JSON.parse(localData);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        prefixTemplates = parsed;
                        await savePrefixTemplates();
                        localStorage.removeItem('prefixTemplates');
                        activePrefix = prefixTemplates[0] || '请参考';
                        renderPrefixBatchBar();
                        return;
                    }
                } catch(e) {}
            }
            prefixTemplates = data.templates;
            activePrefix = prefixTemplates[0] || '请参考';
            renderPrefixBatchBar();
        }
    } catch(e) {
        // 回退到localStorage
        try {
            const localData = localStorage.getItem('prefixTemplates');
            if (localData) prefixTemplates = JSON.parse(localData);
        } catch(e2) {}
        activePrefix = prefixTemplates[0] || '请参考';
        renderPrefixBatchBar();
    }
}

// 保存前缀模板到服务端
async function savePrefixTemplates() {
    try {
        await api('PUT', '/api/prefix-templates', { templates: prefixTemplates });
    } catch(e) {
        console.error('保存前缀模板失败:', e);
    }
}

function renderPrefixBatchBar() {
    const bar = document.getElementById('prefix-batch-bar');
    if (!bar) return;
    bar.innerHTML = '';
    prefixTemplates.forEach(prefix => {
        const btn = document.createElement('button');
        btn.className = `prefix-batch-btn${prefix === activePrefix ? ' active' : ''}`;
        btn.dataset.prefix = prefix;
        btn.textContent = prefix;
        // 左键：批量设置
        btn.addEventListener('click', () => {
            activePrefix = prefix;
            // 批量设置前缀，但跳过第1个槽位（Image 1保留用户手动设置的值）
            for (let i = 1; i < SLOT_COUNT; i++) {
                imageState.slots[i].prefixTemplate = prefix;
            }
            // 更新按钮高亮
            document.querySelectorAll('.prefix-batch-btn').forEach(b => b.classList.toggle('active', b.dataset.prefix === prefix));
            renderImageSlots();
            updateLocalPrompt();
            // 持久化前缀设置：多图列队模式需同步到当前队列
            if (queueMode === 'multi') saveCurrentQueueData();
            saveQueueData();
            showToast(`已批量设置为"${prefix}"（Image 1保留原设置）`, 'success');
        });
        // 右键：编辑/删除
        btn.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isDefault = DEFAULT_PREFIX_TEMPLATES.includes(prefix);
            const action = await showPrompt(
                isDefault ? '编辑前缀模板（默认项不可删除）' : '编辑或删除前缀模板（输入空格删除）',
                prefix,
                '前缀模板'
            );
            if (action === null) return;
            if (action.trim() === ' ' && !isDefault) {
                // 删除
                const idx = prefixTemplates.indexOf(prefix);
                if (idx >= 0) {
                    prefixTemplates.splice(idx, 1);
                    await savePrefixTemplates();
                    if (activePrefix === prefix) activePrefix = prefixTemplates[0] || '请参考';
                    renderPrefixBatchBar();
                    showToast(`已删除"${prefix}"`, 'success');
                }
            } else if (action.trim() && action.trim() !== prefix) {
                // 修改
                const idx = prefixTemplates.indexOf(prefix);
                if (idx >= 0) {
                    prefixTemplates[idx] = action.trim();
                    await savePrefixTemplates();
                    if (activePrefix === prefix) activePrefix = action.trim();
                    renderPrefixBatchBar();
                    showToast(`已修改为"${action.trim()}"`, 'success');
                }
            }
        });
        bar.appendChild(btn);
    });
}

// 首次渲染（先显示默认值，异步加载后更新）
renderPrefixBatchBar();
loadPrefixTemplates();

// 添加自定义前缀按钮
document.getElementById('btn-add-prefix')?.addEventListener('click', async () => {
    const newPrefix = await showPrompt('添加自定义前缀模板', '', '例如：将背景替换成');
    if (!newPrefix || !newPrefix.trim()) return;
    if (prefixTemplates.includes(newPrefix.trim())) {
        showToast('该前缀已存在', 'error');
        return;
    }
    prefixTemplates.push(newPrefix.trim());
    await savePrefixTemplates();
    activePrefix = newPrefix.trim();
    renderPrefixBatchBar();
    showToast(`已添加"${newPrefix.trim()}"`, 'success');
});

// 批量前缀栏的"+"按钮（图片槽区域）
document.getElementById('btn-add-prefix-old')?.addEventListener('click', async () => {
    const newPrefix = await showPrompt('添加自定义前缀模板', '', '例如：将背景替换成');
    if (!newPrefix || !newPrefix.trim()) return;
    if (prefixTemplates.includes(newPrefix.trim())) {
        showToast('该前缀已存在', 'error');
        return;
    }
    prefixTemplates.push(newPrefix.trim());
    await savePrefixTemplates();
    activePrefix = newPrefix.trim();
    renderPrefixBatchBar();
    showToast(`已添加"${newPrefix.trim()}"`, 'success');
});

// 上传图片到槽位（本地上传）
function uploadSlotImage(slotIndex) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.webp';
    input.multiple = true;
    input.onchange = async (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        if (files.length === 1) {
            // 单张：裁剪 → 分配素材 → 加载到槽位
            const reader = new FileReader();
            reader.onload = () => {
                showCropModal(reader.result, async (croppedBlob) => {
                    const formData = new FormData();
                    formData.append('file', croppedBlob, 'cropped.jpg');
                    try {
                        const url = await uploadImage(formData);
                        const assignResult = await showAssignMaterial(url, files[0].name);
                        imageState.slots[slotIndex].image = url;
                        imageState.slots[slotIndex].dwEnabled = false;
                        imageState.slots[slotIndex].dwOriginalImage = '';
                        if (assignResult && assignResult.labels && assignResult.labels.length > 0) {
                            imageState.slots[slotIndex].label = assignResult.labels.join('、');
                        }
                        renderImageSlots();
                        updateLocalPrompt();
                        if (assignResult && assignResult.savedToLib) {
                            showToast('图片已存入素材库并加载到槽位', 'success');
                        } else {
                            showToast('图片已加载到槽位', 'success');
                        }
                        logAction('slot', '上传图片到槽', { slotIndex });
                    } catch (err) { showToast(err.message, 'error'); }
                });
            };
            reader.readAsDataURL(files[0]);
        } else {
            // 多张：批量裁剪队列，每张裁剪后弹出分配弹窗
            startBatchCrop(files, slotIndex, (targetSlot, idx, total) => {
                return async (croppedBlob) => {
                    const formData = new FormData();
                    formData.append('file', croppedBlob, 'cropped.jpg');
                    try {
                        const url = await uploadImage(formData);
                        const assignResult = await showAssignMaterial(url, files[idx].name);
                        if (targetSlot < SLOT_COUNT) {
                            imageState.slots[targetSlot].image = url;
                            imageState.slots[targetSlot].dwEnabled = false;
                            imageState.slots[targetSlot].dwOriginalImage = '';
                            if (assignResult && assignResult.labels && assignResult.labels.length > 0) {
                                imageState.slots[targetSlot].label = assignResult.labels.join('、');
                            }
                            renderImageSlots();
                            updateLocalPrompt();
                            logAction('slot', '批量上传图片到槽', { slotIndex: targetSlot });
                        }
                        if (idx === total - 1) {
                            showToast(`批量上传完成：${total}张`, 'success');
                        }
                    } catch (err) { showToast(`第${idx+1}张上传失败：${err.message}`, 'error'); }
                };
            });
        }
    };
    input.click();
}

/**
 * 裁剪后弹出"分配到素材库"弹窗
 * @param {string} imageUrl - 已上传的图片URL（如 /static/images/xxx.jpg）
 * @param {string} fileName - 原始文件名（用于默认名称）
 * @returns {Promise<{savedToLib: boolean, label: string}|null>} 用户确认分配返回结果，跳过返回null
 */
async function showAssignMaterial(imageUrl, fileName) {
    return new Promise((resolve) => {
        const modal = document.getElementById('modal-assign-material');
        const catContainer = document.getElementById('assign-material-categories');
        const nameInput = document.getElementById('assign-material-name');
        const confirmBtn = document.getElementById('btn-assign-material-confirm');

        // 填充分类复选框（使用素材库分类）
        catContainer.innerHTML = '';
        const libCategories = imageState.library || [];
        if (libCategories.length === 0) {
            catContainer.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">暂无分类，确认后将自动创建</div>';
        } else {
            libCategories.forEach(cat => {
                const label = document.createElement('label');
                label.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = cat.id;
                cb.dataset.catName = cat.name;
                cb.style.cssText = 'width:14px;height:14px;cursor:pointer;';
                const span = document.createElement('span');
                span.textContent = cat.name;
                label.appendChild(cb);
                label.appendChild(span);
                catContainer.appendChild(label);
            });
        }

        // 默认名称：去掉扩展名
        const baseName = fileName.replace(/\.[^.]+$/, '');
        nameInput.value = baseName;

        // 显示弹窗
        modal.style.display = 'flex';

        // 清理旧事件：克隆节点
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

        // 确认按钮
        newConfirmBtn.addEventListener('click', async () => {
            modal.style.display = 'none';
            const materialName = nameInput.value.trim() || baseName;

            // 收集所有勾选的分类
            const checkedBoxes = catContainer.querySelectorAll('input[type="checkbox"]:checked');
            const selectedCats = [];
            checkedBoxes.forEach(cb => {
                selectedCats.push({ id: cb.value, name: cb.dataset.catName });
            });

            if (selectedCats.length === 0) {
                // 没选分类，跳过素材库保存
                resolve({ savedToLib: false, labels: [] });
                return;
            }

            // 标签 = 所有选中分类名拼接
            const labels = selectedCats.map(c => c.name);

            try {
                let libData = await api('GET', '/api/image-library');
                let allLibCats = libData.categories || [];

                // 将图片存入每个选中的分类
                for (const selectedCat of selectedCats) {
                    let targetCat = allLibCats.find(c => c.id === selectedCat.id);

                    if (!targetCat) {
                        // 分类不存在，创建
                        targetCat = await api('POST', '/api/image-library', { name: selectedCat.name });
                        allLibCats.push(targetCat);
                    }

                    // 确保有子分类
                    let subs = targetCat.subcategories || [];
                    let targetSub = subs.length > 0 ? subs[0] : null;
                    if (!targetSub) {
                        targetSub = await api('POST', `/api/image-library/${targetCat.id}/subcategories`, { name: '默认' });
                    }

                    // 添加素材项
                    await api('POST', `/api/image-library/${targetCat.id}/subcategories/${targetSub.id}/items`, {
                        name: materialName,
                        image: imageUrl
                    });
                }

                // 刷新素材库
                await reloadImageLibrary();
                renderImageLibrary();
                resolve({ savedToLib: true, labels });
            } catch (err) {
                showToast('素材库保存失败：' + err.message, 'warning');
                resolve({ savedToLib: false, labels });
            }
        });

        // 跳过按钮 & 关闭按钮
        modal.querySelectorAll('[data-close="modal-assign-material"]').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', () => {
                modal.style.display = 'none';
                resolve(null);
            });
        });

        // 点击遮罩关闭 = 跳过
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
                resolve(null);
            }
        };
    });
}

// ---------- 素材选择弹窗（两步：选分类 → 选素材） ----------
let materialSelectedCategory = null;

function openSelectMaterialModal() {
    materialSelectedCategory = null;
    document.getElementById('material-step1').style.display = 'block';
    document.getElementById('material-step2').style.display = 'none';

    // 渲染分类列表
    const catList = document.getElementById('material-category-list');
    catList.innerHTML = '';
    for (const cat of imageState.library) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-outline';
        btn.textContent = cat.name;
        btn.addEventListener('click', () => {
            materialSelectedCategory = cat;
            document.getElementById('material-step1').style.display = 'none';
            document.getElementById('material-step2').style.display = 'block';
            document.getElementById('material-step2-title').textContent = cat.name;
            renderMaterialItems(cat);
        });
        catList.appendChild(btn);
    }

    openModal('modal-select-material');
}

function renderMaterialItems(cat) {
    const grid = document.getElementById('material-items-grid');
    grid.innerHTML = '';

    const subcategories = cat.subcategories || [];

    if (subcategories.length === 0) {
        grid.innerHTML = '<p class="empty-hint">该分类下暂无素材<br>请在素材库中添加</p>';
        return;
    }

    // 找到默认子分类，优先显示
    const defaultSub = subcategories.find(s => s.name === '默认' || s._isDefault);
    const otherSubs = subcategories.filter(s => s !== defaultSub);

    // 先显示默认子分类的素材（无标题）
    if (defaultSub && (defaultSub.items || []).length > 0) {
        for (const item of defaultSub.items) {
            const card = document.createElement('div');
            card.className = 'prop-item-card';
            card.style.cursor = 'pointer';

            const imgHtml = item.image
                ? `<img src="${escHtml(item.image)}" alt="${escHtml(item.name)}" class="prop-item-img">`
                : `<div class="prop-item-no-img">📷</div>`;

            card.innerHTML = `${imgHtml}<div class="prop-item-name">${escHtml(item.name)}</div>`;
            card.addEventListener('click', () => {
                fillSlotFromMaterial(item, cat.name);
                closeModal('modal-select-material');
            });
            grid.appendChild(card);
        }
    }

    // 再按子分类分组显示
    for (const sub of otherSubs) {
        const items = sub.items || [];
        if (items.length === 0) continue;

        // 子分类标题
        const subLabel = document.createElement('div');
        subLabel.style.cssText = 'grid-column:1/-1;font-size:11px;font-weight:500;color:var(--text-secondary);padding:6px 0 2px;border-bottom:1px solid var(--border-light);margin-bottom:2px;';
        subLabel.textContent = sub.name;
        grid.appendChild(subLabel);

        for (const item of items) {
            const card = document.createElement('div');
            card.className = 'prop-item-card';
            card.style.cursor = 'pointer';

            const imgHtml = item.image
                ? `<img src="${escHtml(item.image)}" alt="${escHtml(item.name)}" class="prop-item-img">`
                : `<div class="prop-item-no-img">📷</div>`;

            card.innerHTML = `${imgHtml}<div class="prop-item-name">${escHtml(item.name)}</div>`;
            card.addEventListener('click', () => {
                fillSlotFromMaterial(item, cat.name);
                closeModal('modal-select-material');
            });
            grid.appendChild(card);
        }
    }

    // 如果没有任何素材
    if (!grid.children.length || (defaultSub && (defaultSub.items || []).length === 0 && otherSubs.every(s => (s.items || []).length === 0))) {
        grid.innerHTML = '<p class="empty-hint">该分类下暂无素材<br>请在素材库中添加</p>';
    }
}

// 返回分类
document.getElementById('btn-material-back').addEventListener('click', () => {
    document.getElementById('material-step1').style.display = 'block';
    document.getElementById('material-step2').style.display = 'none';
});

// 本地上传
document.getElementById('btn-material-local-upload').addEventListener('click', () => {
    closeModal('modal-select-material');
    uploadSlotImage(imageState.activeSlotIndex);
});

// ---------- 双语 Prompt 生成 ----------
// 更新生成按钮文字：多图队列模式下，已生成过的队列显示"再次生成提示词"
function updateGenerateBtnText() {
    const btn = document.getElementById('btn-img-generate');
    if (!btn) return;
    if (queueMode === 'multi') {
        const q = queueData[activeQueue];
        const hasGenerated = q.promptEn && q.promptEn.trim();
        btn.textContent = hasGenerated ? `队列${activeQueue+1} 再次生成提示词` : `队列${activeQueue+1} 生成提示词`;
    } else {
        const promptEn = document.getElementById('img-prompt-en')?.value?.trim();
        btn.textContent = promptEn ? '再次生成提示词' : '生成提示词';
    }
    // API生成按钮：多图列队模式下显示当前队列号和状态
    const apiBtn = document.getElementById('btn-api-generate');
    if (apiBtn) {
        const qs = queueGenerateStates[activeQueue];
        if (qs?.running) {
            apiBtn.innerHTML = `<span class="loading"></span> 队列${activeQueue+1}生成中...`;
            apiBtn.disabled = true;
        } else {
            apiBtn.textContent = queueMode === 'multi' ? `生成队列${activeQueue+1}` : '生成';
            apiBtn.disabled = false;
        }
    }
}

document.getElementById('btn-img-generate').addEventListener('click', async () => {
    pushUndoSnapshot();
    logAction('generate', '生成提示词', {});
    // 多图队列模式下，先保存当前队列数据，防止切换队列时覆盖其他队列
    if (queueMode === 'multi') saveCurrentQueueData();

    const promptCn = getFullPromptCn().trim(); // 含前缀+后缀
    const images = imageState.slots
        .filter(s => s.label)
        .map(s => ({ label: s.label }));

    if (!promptCn && images.length === 0) {
        showToast('请输入中文描述或为图片槽填写语义标签', 'error');
        return;
    }

    const btn = document.getElementById('btn-img-generate');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> 生成提示词中...';

    try {
        const result = await api('POST', '/api/generate-bilingual', {
            prompt_cn: promptCn,
            images: images
        });

        if (result.prompt_en) {
            document.getElementById('img-prompt-en').value = result.prompt_en;
            imageState.promptEn = result.prompt_en;
        }
        // 中文提示词优先使用模型返回结果，避免“生成了但看起来没刷新”
        if (typeof result.prompt_cn === 'string' && result.prompt_cn.trim()) {
            document.getElementById('img-prompt-cn').value = result.prompt_cn;
            imageState.promptCn = result.prompt_cn;
        } else if (!promptCn) {
            // 无模型中文且当前为空时，至少回填本地拼接值
            const fallbackCn = getFullPromptCn().trim();
            document.getElementById('img-prompt-cn').value = fallbackCn;
            imageState.promptCn = fallbackCn;
        }

        // 多图队列模式下保存到队列数据
        if (queueMode === 'multi') {
            queueData[activeQueue].promptCn = document.getElementById('img-prompt-cn').value;
            queueData[activeQueue].promptEn = result.prompt_en || document.getElementById('img-prompt-en').value;
            saveQueueData();
        }
        // 提示词生成后，标记所有当前图片槽位已参与提示词
        promptedSlotIndices = new Set();
        for (let i = 0; i < SLOT_COUNT; i++) {
            const slot = imageState.slots[i];
            if (slot.label || slot.image) promptedSlotIndices.add(i);
        }

        document.getElementById('btn-img-refresh-en').disabled = false;
        document.getElementById('btn-img-copy-en').disabled = !result.prompt_en;
        document.getElementById('btn-copy-images').disabled = !imageState.slots.some(s => s.image);
        document.getElementById('btn-auto-fill-gemini').disabled = !result.prompt_en;
        showToast('提示词生成成功', 'success');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        updateGenerateBtnText();
    }
});

// 刷新英文
document.getElementById('btn-img-refresh-en').addEventListener('click', async () => {
    logAction('generate', '刷新英文', {});
    const promptCn = getFullPromptCn().trim(); // 含前缀+后缀
    if (!promptCn) {
        showToast('中文 Prompt 为空', 'error');
        return;
    }

    const btn = document.getElementById('btn-img-refresh-en');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span>';

    try {
        const result = await api('POST', '/api/translate-to-en', { prompt_cn: promptCn });
        document.getElementById('img-prompt-en').value = result.prompt_en;
        imageState.promptEn = result.prompt_en;
        document.getElementById('btn-img-copy-en').disabled = false;
        document.getElementById('btn-copy-images').disabled = !imageState.slots.some(s => s.image);
        document.getElementById('btn-auto-fill-gemini').disabled = false;
        showToast('英文刷新成功', 'success');
    } catch (e) {
        showToast(e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '刷新英文';
    }
});

// 复制英文
document.getElementById('btn-img-copy-en').addEventListener('click', () => {
    logAction('export', '复制英文Prompt', {});
    const text = document.getElementById('img-prompt-en').value;
    if (!text) { showToast('英文 Prompt 为空', 'error'); return; }
    navigator.clipboard.writeText(text).then(() => showToast('英文 Prompt 已复制到剪贴板', 'success')).catch(() => {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast('英文 Prompt 已复制到剪贴板', 'success');
    });
});

// 复制中文
document.getElementById('btn-img-copy-cn').addEventListener('click', () => {
    logAction('export', '复制中文Prompt', {});
    const text = document.getElementById('img-prompt-cn').value;
    if (!text) { showToast('中文 Prompt 为空', 'error'); return; }
    navigator.clipboard.writeText(text).then(() => showToast('中文 Prompt 已复制到剪贴板', 'success')).catch(() => {
        const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        showToast('中文 Prompt 已复制到剪贴板', 'success');
    });
});

// ========== 前缀/后缀模板系统（服务器持久化 + 按钮直接操作提示词） ==========
// 数据结构：{ prefixes: [{id, name, text}], suffixes: [{id, name, text}] }
// 按钮点击 → 前缀插入提示词最前方，后缀插入提示词最后方；再点击取消移除
let promptTemplates = { prefixes: [], suffixes: [] };
let selectedPrefixIds = new Set();
let selectedSuffixIds = new Set();

// 显示顺序：localStorage存储勾选的ID列表（按勾选顺序），默认前10个
function getDisplayedTemplateIds(type) {
    try {
        const saved = localStorage.getItem(`displayed_${type}_ids`);
        if (saved) return JSON.parse(saved);
    } catch {}
    return null; // null表示未设置，用默认前10个
}
function setDisplayedTemplateIds(type, ids) {
    localStorage.setItem(`displayed_${type}_ids`, JSON.stringify(dedupeTemplateIds(ids || []).slice(0, 10)));
}

async function loadPromptTemplates() {
    try {
        const data = await api('GET', '/api/prompt-templates');
        if (data && (data.prefixes?.length > 0 || data.suffixes?.length > 0)) {
            promptTemplates.prefixes = data.prefixes || [];
            promptTemplates.suffixes = data.suffixes || [];
            if (selectedPrefixIds.size === 0 && selectedSuffixIds.size === 0) {
                selectedPrefixIds = new Set(dedupeTemplateIds(data.selectedPrefixIds || []));
                selectedSuffixIds = new Set(dedupeTemplateIds(data.selectedSuffixIds || []));
            }
            if (queueData[0] && (!queueData[0].selectedPrefixIds || queueData[0].selectedPrefixIds.length === 0)) {
                queueData[0].selectedPrefixIds = dedupeTemplateIds([...selectedPrefixIds]);
                queueData[0].selectedSuffixIds = dedupeTemplateIds([...selectedSuffixIds]);
            }
        } else {
            try {
                const saved = localStorage.getItem('promptTemplates');
                if (saved) {
                    const local = JSON.parse(saved);
                    if (local.prefixes?.length > 0 || local.suffixes?.length > 0) {
                        promptTemplates = local;
                        await savePromptTemplates();
                        localStorage.removeItem('promptTemplates');
                    }
                }
            } catch {}
        }
    } catch {
        try {
            const saved = localStorage.getItem('promptTemplates');
            if (saved) promptTemplates = JSON.parse(saved);
        } catch {}
    }
    if (!Array.isArray(promptTemplates.prefixes)) promptTemplates.prefixes = [];
    if (!Array.isArray(promptTemplates.suffixes)) promptTemplates.suffixes = [];
}

async function savePromptTemplates() {
    const data = {
        prefixes: promptTemplates.prefixes,
        suffixes: promptTemplates.suffixes,
        selectedPrefixIds: dedupeTemplateIds([...selectedPrefixIds]),
        selectedSuffixIds: dedupeTemplateIds([...selectedSuffixIds])
    };
    try { localStorage.setItem('promptTemplates', JSON.stringify(data)); } catch {}
    try { await api('PUT', '/api/prompt-templates', data); } catch {}
}

function _getVisibleItems(type) {
    const items = type === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
    const displayed = getDisplayedTemplateIds(type);
    if (displayed && displayed.length) {
        const seen = new Set();
        const ordered = [];
        for (const id of dedupeTemplateIds(displayed)) {
            const t = items.find(x => x.id === id);
            if (t && !seen.has(id)) {
                seen.add(id);
                ordered.push(t);
            }
        }
        return ordered;
    }
    // 默认：前10个（按 id 去重，避免数据异常时同一按钮出现两次）
    const seen = new Set();
    const out = [];
    for (const t of items.slice(0, 10)) {
        if (t?.id && !seen.has(t.id)) {
            seen.add(t.id);
            out.push(t);
        }
    }
    return out;
}

function renderTemplateButtons() {
    const prefixGroup = document.getElementById('prefix-btn-group');
    const suffixGroup = document.getElementById('suffix-btn-group');
    if (!prefixGroup || !suffixGroup) return;

    const visiblePrefixes = _getVisibleItems('prefix');
    const visibleSuffixes = _getVisibleItems('suffix');

    prefixGroup.innerHTML = visiblePrefixes.map(t => {
        const sel = selectedPrefixIds.has(t.id) ? 'selected' : '';
        return `<button class="template-btn ${sel}" data-id="${t.id}" title="${escHtml(t.text)}">${escHtml(t.name)}</button>`;
    }).join('');

    suffixGroup.innerHTML = visibleSuffixes.map(t => {
        const sel = selectedSuffixIds.has(t.id) ? 'selected' : '';
        return `<button class="template-btn ${sel}" data-id="${t.id}" title="${escHtml(t.text)}">${escHtml(t.name)}</button>`;
    }).join('');

    // 前缀按钮事件
    prefixGroup.querySelectorAll('.template-btn').forEach(btn => {
        btn.addEventListener('click', () => _toggleTemplate('prefix', btn.dataset.id, btn));
        btn.addEventListener('contextmenu', (e) => _showTemplateContextMenu(e, 'prefix', btn.dataset.id));
    });
    // 后缀按钮事件
    suffixGroup.querySelectorAll('.template-btn').forEach(btn => {
        btn.addEventListener('click', () => _toggleTemplate('suffix', btn.dataset.id, btn));
        btn.addEventListener('contextmenu', (e) => _showTemplateContextMenu(e, 'suffix', btn.dataset.id));
    });
}

// 点击按钮：激活→插入提示词，取消→移除提示词
function _toggleTemplate(type, id, btnEl) {
    const textarea = document.getElementById('img-prompt-cn');
    if (!textarea) return;
    const items = type === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
    const t = items.find(x => x.id === id);
    if (!t || !t.text) return;

    const selectedSet = type === 'prefix' ? selectedPrefixIds : selectedSuffixIds;

    if (selectedSet.has(id)) {
        // 取消：从提示词中移除该文本
        selectedSet.delete(id);
        btnEl.classList.remove('selected');
        let val = textarea.value;
        if (type === 'prefix') {
            // 尝试从最前方移除
            const trimmed = val.trimStart();
            if (trimmed.startsWith(t.text)) {
                val = trimmed.slice(t.text.length).trimStart();
            } else {
                // 回退：移除任意位置的首次出现
                const idx = val.indexOf(t.text);
                if (idx >= 0) val = (val.slice(0, idx) + val.slice(idx + t.text.length)).replace(/\s{2,}/g, ' ').trim();
            }
        } else {
            // 尝试从最后方移除
            const trimmed = val.trimEnd();
            if (trimmed.endsWith(t.text)) {
                val = trimmed.slice(0, -t.text.length).trimEnd();
            } else {
                // 回退：移除最后一次出现
                const idx = val.lastIndexOf(t.text);
                if (idx >= 0) val = (val.slice(0, idx) + val.slice(idx + t.text.length)).replace(/\s{2,}/g, ' ').trim();
            }
        }
        textarea.value = val;
        imageState.promptCn = val;
        showToast(`已取消${type === 'prefix' ? '前缀' : '后缀'}：${t.name}`, 'info');
    } else {
        // 激活：插入提示词
        selectedSet.add(id);
        btnEl.classList.add('selected');
        if (type === 'prefix') {
            textarea.value = t.text + ' ' + textarea.value;
        } else {
            textarea.value = textarea.value + ' ' + t.text;
        }
        imageState.promptCn = textarea.value;
        showToast(`已应用${type === 'prefix' ? '前缀' : '后缀'}：${t.name}`, 'success');
    }
    savePromptTemplates();
    if (queueMode === 'multi') saveCurrentQueueData();
    updateTemplatePreviews();
}

function _showTemplateContextMenu(e, type, id) {
    e.preventDefault();
    e.stopPropagation();
    const items = type === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
    const t = items.find(x => x.id === id);
    if (!t) return;
    showContextMenu(e.clientX, e.clientY, [
        { label: '编辑', action: () => openTemplateEditModal(type, id) },
        { label: '重命名', action: () => {
            showPrompt('输入新名称', t.name, (newName) => {
                if (newName && newName.trim()) {
                    t.name = newName.trim();
                    savePromptTemplates();
                    renderTemplateButtons();
                    showToast('已重命名', 'success');
                }
            });
        }},
        { label: '删除', action: () => {
            showConfirm(`确定删除${type === 'prefix' ? '前缀' : '后缀'}"${t.name}"吗？`, () => {
                pushUndoSnapshot();
                const idx = items.findIndex(x => x.id === id);
                if (idx >= 0) {
                    items.splice(idx, 1);
                    if (type === 'prefix') selectedPrefixIds.delete(id);
                    else selectedSuffixIds.delete(id);
                    // 从显示列表中也移除
                    const displayed = getDisplayedTemplateIds(type);
                    if (displayed) {
                        setDisplayedTemplateIds(type, displayed.filter(x => x !== id));
                    }
                    savePromptTemplates();
                    renderTemplateButtons();
                    updateTemplatePreviews();
                    showToast('已删除', 'info');
                }
            });
        }, danger: true }
    ]);
}

function updateTemplatePreviews() {
    const prefixPreview = document.getElementById('prefix-preview');
    const suffixPreview = document.getElementById('suffix-preview');
    if (prefixPreview) {
        const names = [...selectedPrefixIds].map(id => promptTemplates.prefixes.find(p => p.id === id)?.name).filter(Boolean);
        if (names.length > 0) {
            prefixPreview.textContent = `已选前缀：${names.join('、')}（正文见下方输入框）`;
            prefixPreview.style.display = 'block';
        } else {
            prefixPreview.style.display = 'none';
        }
    }
    if (suffixPreview) {
        const names = [...selectedSuffixIds].map(id => promptTemplates.suffixes.find(p => p.id === id)?.name).filter(Boolean);
        if (names.length > 0) {
            suffixPreview.textContent = `已选后缀：${names.join('、')}（正文见下方输入框）`;
            suffixPreview.style.display = 'block';
        } else {
            suffixPreview.style.display = 'none';
        }
    }
}

function refreshSplitTemplateUI() {
    const item = getActiveSplitWorkItem(activeSplitQueue);
    if (!item) return;
    renderSplitPrefixSuffix(item);
}

function getFullPromptCn() {
    return document.getElementById('img-prompt-cn')?.value || '';
}

// 管理弹窗：勾选显示哪些 + 添加/编辑/删除
let templateEditType = 'prefix';
let editingTemplateId = null;

function openTemplateManager(type) {
    templateEditType = type;
    editingTemplateId = null;
    const title = document.getElementById('prompt-template-modal-title');
    if (title) title.textContent = type === 'prefix' ? '管理前缀模板' : '管理后缀模板';
    renderTemplateList();
    openModal('modal-prompt-template');
}

function openTemplateEditModal(type, id) {
    const arr = type === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
    const t = arr.find(x => x.id === id);
    if (t) {
        editingTemplateId = id;
        templateEditType = type;
        document.getElementById('prompt-template-new-name').value = t.name;
        document.getElementById('prompt-template-new-text').value = t.text;
        const title = document.getElementById('prompt-template-modal-title');
        if (title) title.textContent = (type === 'prefix' ? '编辑前缀' : '编辑后缀') + `: ${t.name}`;
        renderTemplateList();
        openModal('modal-prompt-template');
    }
}

function renderTemplateList() {
    const list = document.getElementById('prompt-template-list');
    if (!list) return;
    const items = templateEditType === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
    const displayed = getDisplayedTemplateIds(templateEditType);
    // 如果没有设置过，默认前10个
    const displayedSet = displayed ? new Set(displayed) : new Set(items.slice(0, 10).map(t => t.id));

    if (items.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px 0;">暂无模板，请在下方添加</div>';
        return;
    }
    list.innerHTML = `<div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;">勾选显示在按钮区（最多10个，按勾选顺序排列）</div>` +
        items.map(t => {
        const isDisplayed = displayedSet.has(t.id);
        return `
        <div style="display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid var(--border-light);">
            <input type="checkbox" class="template-display-cb" data-id="${t.id}" ${isDisplayed ? 'checked' : ''} style="width:12px;height:12px;cursor:pointer;">
            <span style="font-size:11px;font-weight:500;min-width:50px;">${escHtml(t.name)}</span>
            <span style="font-size:10px;color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(t.text)}">${escHtml(t.text)}</span>
            <button class="btn btn-outline btn-compact template-edit-btn" data-id="${t.id}" style="font-size:9px;padding:1px 4px;">编辑</button>
            <button class="btn btn-outline btn-compact template-del-btn" data-id="${t.id}" style="font-size:9px;padding:1px 4px;color:var(--danger);">删除</button>
        </div>`;
    }).join('');

    // 勾选显示
    list.querySelectorAll('.template-display-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            let ids = getDisplayedTemplateIds(templateEditType);
            if (!ids) ids = items.slice(0, 10).map(t => t.id);
            if (cb.checked) {
                if (ids.length >= 10) { showToast('最多显示10个', 'error'); cb.checked = false; return; }
                if (!ids.includes(cb.dataset.id)) ids.push(cb.dataset.id);
            } else {
                ids = ids.filter(id => id !== cb.dataset.id);
            }
            setDisplayedTemplateIds(templateEditType, ids);
            renderTemplateButtons();
        });
    });
    list.querySelectorAll('.template-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const arr = templateEditType === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
            const idx = arr.findIndex(t => t.id === btn.dataset.id);
            if (idx >= 0) {
                const id = arr[idx].id;
                arr.splice(idx, 1);
                if (templateEditType === 'prefix') selectedPrefixIds.delete(id);
                else selectedSuffixIds.delete(id);
                const displayed = getDisplayedTemplateIds(templateEditType);
                if (displayed) setDisplayedTemplateIds(templateEditType, displayed.filter(x => x !== id));
                savePromptTemplates();
                renderTemplateList();
                renderTemplateButtons();
                updateTemplatePreviews();
                refreshSplitTemplateUI();
            }
        });
    });
    list.querySelectorAll('.template-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const arr = templateEditType === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
            const t = arr.find(t => t.id === btn.dataset.id);
            if (t) {
                editingTemplateId = t.id;
                document.getElementById('prompt-template-new-name').value = t.name;
                document.getElementById('prompt-template-new-text').value = t.text;
            }
        });
    });
}

loadPromptTemplates().then(() => {
    renderTemplateButtons();
    updateTemplatePreviews();
});

document.getElementById('btn-prefix-manage')?.addEventListener('click', () => openTemplateManager('prefix'));
document.getElementById('btn-suffix-manage')?.addEventListener('click', () => openTemplateManager('suffix'));

document.getElementById('btn-add-prefix')?.addEventListener('click', () => {
    templateEditType = 'prefix';
    editingTemplateId = null;
    document.getElementById('prompt-template-new-name').value = '';
    document.getElementById('prompt-template-new-text').value = '';
    const title = document.getElementById('prompt-template-modal-title');
    if (title) title.textContent = '添加前缀模板';
    renderTemplateList();
    openModal('modal-prompt-template');
});
document.getElementById('btn-add-suffix')?.addEventListener('click', () => {
    templateEditType = 'suffix';
    editingTemplateId = null;
    document.getElementById('prompt-template-new-name').value = '';
    document.getElementById('prompt-template-new-text').value = '';
    const title = document.getElementById('prompt-template-modal-title');
    if (title) title.textContent = '添加后缀模板';
    renderTemplateList();
    openModal('modal-prompt-template');
});
document.getElementById('btn-split-prefix-manage')?.addEventListener('click', () => openTemplateManager('prefix'));
document.getElementById('btn-split-suffix-manage')?.addEventListener('click', () => openTemplateManager('suffix'));
document.getElementById('btn-split-add-prefix')?.addEventListener('click', () => {
    templateEditType = 'prefix';
    editingTemplateId = null;
    document.getElementById('prompt-template-new-name').value = '';
    document.getElementById('prompt-template-new-text').value = '';
    const title = document.getElementById('prompt-template-modal-title');
    if (title) title.textContent = '添加前缀模板';
    renderTemplateList();
    openModal('modal-prompt-template');
});
document.getElementById('btn-split-add-suffix')?.addEventListener('click', () => {
    templateEditType = 'suffix';
    editingTemplateId = null;
    document.getElementById('prompt-template-new-name').value = '';
    document.getElementById('prompt-template-new-text').value = '';
    const title = document.getElementById('prompt-template-modal-title');
    if (title) title.textContent = '添加后缀模板';
    renderTemplateList();
    openModal('modal-prompt-template');
});

document.getElementById('btn-prompt-template-add')?.addEventListener('click', () => {
    const name = document.getElementById('prompt-template-new-name')?.value.trim();
    const text = document.getElementById('prompt-template-new-text')?.value.trim();
    if (!name || !text) { showToast('请填写模板名称和内容', 'error'); return; }
    const arr = templateEditType === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
    if (editingTemplateId) {
        const t = arr.find(x => x.id === editingTemplateId);
        if (t) { t.name = name; t.text = text; }
        editingTemplateId = null;
    } else {
        arr.push({ id: 'tpl_' + Date.now(), name, text });
        // 新添加的自动加入显示列表
        let ids = getDisplayedTemplateIds(templateEditType);
        if (!ids) ids = arr.slice(0, 10).map(t => t.id);
        if (ids.length < 10) {
            ids.push(arr[arr.length - 1].id);
            setDisplayedTemplateIds(templateEditType, ids);
        }
    }
    savePromptTemplates();
    renderTemplateList();
    renderTemplateButtons();
    updateTemplatePreviews();
    refreshSplitTemplateUI();
    document.getElementById('prompt-template-new-name').value = '';
    document.getElementById('prompt-template-new-text').value = '';
    showToast(editingTemplateId ? '已更新' : '模板已添加', 'success');
});

// ========== 提示词预设系统 ==========
let promptPresets = [];
let promptPresetGroups = [];
let activePromptPresetIds = new Set();
let prevPromptCn = '';
let editingPromptPresetId = null;
const PROMPT_PRESET_ALL_GROUP = '__all';

async function loadPromptPresets() {
    try {
        const data = await api('GET', '/api/prompt-presets');
        promptPresets = (data.presets || []).map(p => ({ ...p, groupId: p.groupId || '' }));
        promptPresetGroups = data.groups || [];
    } catch {
        promptPresets = [];
        promptPresetGroups = [];
    }
    normalizeActivePromptPresetGroup();
}

async function savePromptPresets() {
    try {
        await api('PUT', '/api/prompt-presets', { presets: promptPresets, groups: promptPresetGroups });
    } catch {}
}

function getActivePromptPresetGroupId() {
    try {
        return localStorage.getItem('activePromptPresetGroupId') || PROMPT_PRESET_ALL_GROUP;
    } catch {}
    return PROMPT_PRESET_ALL_GROUP;
}

function setActivePromptPresetGroupId(groupId) {
    const val = groupId || '';
    try { localStorage.setItem('activePromptPresetGroupId', val); } catch {}
}

function normalizeActivePromptPresetGroup() {
    const active = getActivePromptPresetGroupId();
    if (active === PROMPT_PRESET_ALL_GROUP || active === '') return;
    if (!promptPresetGroups.some(g => g.id === active)) setActivePromptPresetGroupId(PROMPT_PRESET_ALL_GROUP);
}

function getPromptPresetGroupName(groupId) {
    if (!groupId) return '未分组';
    return promptPresetGroups.find(g => g.id === groupId)?.name || '未分组';
}

function getPromptPresetsForActiveGroup() {
    const activeGroupId = getActivePromptPresetGroupId();
    if (activeGroupId === PROMPT_PRESET_ALL_GROUP) return promptPresets;
    return promptPresets.filter(p => !p.groupId || p.groupId === activeGroupId);
}

function renderPromptPresetGroupControls() {
    const select = document.getElementById('prompt-preset-group-filter');
    if (select) {
        const active = getActivePromptPresetGroupId();
        select.innerHTML = `<option value="${PROMPT_PRESET_ALL_GROUP}">全部</option><option value="">未分组</option>` +
            promptPresetGroups.map(g => `<option value="${escHtml(g.id)}">${escHtml(g.name)}</option>`).join('');
        select.value = (active === '' || active === PROMPT_PRESET_ALL_GROUP || promptPresetGroups.some(g => g.id === active))
            ? active
            : PROMPT_PRESET_ALL_GROUP;
    }

    const newGroupSelect = document.getElementById('prompt-preset-new-group');
    if (newGroupSelect) {
        const current = newGroupSelect.value || '';
        newGroupSelect.innerHTML = '<option value="">未分组</option>' +
            promptPresetGroups.map(g => `<option value="${escHtml(g.id)}">${escHtml(g.name)}</option>`).join('');
        if (current && promptPresetGroups.some(g => g.id === current)) newGroupSelect.value = current;
    }

    const active = getActivePromptPresetGroupId();
    const canEdit = active && active !== PROMPT_PRESET_ALL_GROUP;
    const editBtn = document.getElementById('btn-prompt-preset-group-edit');
    const delBtn = document.getElementById('btn-prompt-preset-group-delete');
    if (editBtn) editBtn.disabled = !canEdit;
    if (delBtn) delBtn.disabled = !canEdit;
}

function renderPromptPresetButtons() {
    const group = document.getElementById('prompt-preset-btn-group');
    if (!group) return;
    renderPromptPresetGroupControls();
    const visible = getPromptPresetsForActiveGroup().slice(0, 10);
    group.innerHTML = visible.map(p => {
        const isActive = activePromptPresetIds.has(p.id);
        return `<button class="template-btn ${isActive ? 'selected' : ''}" data-preset-id="${p.id}" title="${escHtml(p.text)}">${escHtml(p.name)}</button>`;
    }).join('');
    group.querySelectorAll('.template-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止冒泡到折叠header
            const id = btn.dataset.presetId;
            const textarea = document.getElementById('img-prompt-cn');
            if (!textarea) return;
            const preset = promptPresets.find(p => p.id === id);
            if (!preset || !preset.text) return;

            if (activePromptPresetIds.has(id)) {
                // 取消：从提示词中移除该预设文本
                activePromptPresetIds.delete(id);
                btn.classList.remove('selected');
                let val = textarea.value;
                // 尝试从末尾移除
                const trimmed = val.trimEnd();
                if (trimmed.endsWith(preset.text)) {
                    val = trimmed.slice(0, -preset.text.length).trimEnd();
                } else {
                    // 回退：移除最后一次出现
                    const idx = val.lastIndexOf(preset.text);
                    if (idx >= 0) val = (val.slice(0, idx) + val.slice(idx + preset.text.length)).replace(/\s{2,}/g, ' ').trim();
                }
                textarea.value = val;
                imageState.promptCn = val;
                showToast(`已取消预设：${preset.name}`, 'info');
            } else {
                // 激活：在提示词末尾追加
                activePromptPresetIds.add(id);
                btn.classList.add('selected');
                const current = textarea.value.trim();
                textarea.value = current ? current + ' ' + preset.text : preset.text;
                imageState.promptCn = textarea.value;
                showToast(`已追加预设：${preset.name}`, 'success');
            }
            if (queueMode === 'multi') saveCurrentQueueData();
        });
    });
}

function renderPromptPresetList() {
    const list = document.getElementById('prompt-preset-list');
    if (!list) return;
    renderPromptPresetGroupControls();
    if (promptPresets.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px 0;">暂无预设，请在下方添加</div>';
        return;
    }
    list.innerHTML = promptPresets.map((p, idx) => {
        return `
        <div style="display:flex;align-items:center;gap:4px;padding:4px 0;border-bottom:1px solid var(--border-light);">
            <span style="font-size:11px;font-weight:500;min-width:50px;">${escHtml(p.name)}</span>
            <span style="font-size:9px;color:var(--text-muted);border:1px solid var(--border-light);border-radius:3px;padding:1px 4px;white-space:nowrap;">${escHtml(getPromptPresetGroupName(p.groupId || ''))}</span>
            <span style="font-size:10px;color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(p.text)}">${escHtml(p.text)}</span>
            <button class="btn btn-outline btn-compact preset-edit-btn" data-idx="${idx}" style="font-size:9px;padding:1px 4px;">编辑</button>
            <button class="btn btn-outline btn-compact preset-del-btn" data-idx="${idx}" style="font-size:9px;padding:1px 4px;color:var(--danger);">删除</button>
        </div>`;
    }).join('');

    list.querySelectorAll('.preset-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const preset = promptPresets[idx];
            if (preset) {
                if (activePromptPresetIds.has(preset.id)) activePromptPresetIds.delete(preset.id);
                promptPresets.splice(idx, 1);
                savePromptPresets();
                renderPromptPresetList();
                renderPromptPresetButtons();
                showToast('已删除', 'info');
            }
        });
    });
    list.querySelectorAll('.preset-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const preset = promptPresets[idx];
            if (preset) {
                document.getElementById('prompt-preset-new-name').value = preset.name;
                document.getElementById('prompt-preset-new-text').value = preset.text;
                const groupSelect = document.getElementById('prompt-preset-new-group');
                if (groupSelect) groupSelect.value = preset.groupId || '';
                editingPromptPresetId = preset.id;
                const addBtn = document.getElementById('btn-prompt-preset-add');
                if (addBtn) addBtn.textContent = '保存';
            }
        });
    });
}

loadPromptPresets().then(() => {
    renderPromptPresetButtons();
});

document.getElementById('prompt-preset-group-filter')?.addEventListener('change', (e) => {
    setActivePromptPresetGroupId(e.target.value);
    renderPromptPresetButtons();
    renderPromptPresetList();
});

document.getElementById('btn-prompt-preset-group-add')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const name = await showPrompt('新增提示词预设分组', '', '分组名称');
    if (!name || !name.trim()) return;
    const group = { id: 'ppg_' + Date.now(), name: name.trim() };
    promptPresetGroups.push(group);
    setActivePromptPresetGroupId(group.id);
    await savePromptPresets();
    renderPromptPresetButtons();
    renderPromptPresetList();
    showToast('分组已添加', 'success');
});

document.getElementById('btn-prompt-preset-group-edit')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const active = getActivePromptPresetGroupId();
    const group = promptPresetGroups.find(g => g.id === active);
    if (!group) return;
    const name = await showPrompt('重命名提示词预设分组', group.name, '分组名称');
    if (!name || !name.trim()) return;
    group.name = name.trim();
    await savePromptPresets();
    renderPromptPresetButtons();
    renderPromptPresetList();
    showToast('分组已更新', 'success');
});

document.getElementById('btn-prompt-preset-group-delete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const active = getActivePromptPresetGroupId();
    const group = promptPresetGroups.find(g => g.id === active);
    if (!group) return;
    showConfirm(`删除分组"${group.name}"？组内预设会保留并变为未分组。`, async () => {
        promptPresetGroups = promptPresetGroups.filter(g => g.id !== active);
        for (const preset of promptPresets) {
            if (preset.groupId === active) preset.groupId = '';
        }
        setActivePromptPresetGroupId(PROMPT_PRESET_ALL_GROUP);
        await savePromptPresets();
        renderPromptPresetButtons();
        renderPromptPresetList();
        showToast('分组已删除，预设已转为未分组', 'success');
    });
});

document.getElementById('btn-prompt-preset')?.addEventListener('click', (e) => {
    e.stopPropagation(); // 阻止冒泡到折叠header
    renderPromptPresetList();
    openModal('modal-prompt-preset');
});

document.getElementById('btn-prompt-preset-add')?.addEventListener('click', () => {
    const name = document.getElementById('prompt-preset-new-name')?.value.trim();
    const text = document.getElementById('prompt-preset-new-text')?.value.trim();
    const groupId = document.getElementById('prompt-preset-new-group')?.value || '';
    if (!name || !text) { showToast('请填写预设名称和内容', 'error'); return; }
    if (editingPromptPresetId) {
        const preset = promptPresets.find(p => p.id === editingPromptPresetId);
        if (preset) {
            preset.name = name;
            preset.text = text;
            preset.groupId = groupId;
        }
        editingPromptPresetId = null;
        const addBtn = document.getElementById('btn-prompt-preset-add');
        if (addBtn) addBtn.textContent = '添加';
    } else {
        promptPresets.push({ id: 'pp_' + Date.now(), name, text, groupId });
    }
    savePromptPresets();
    renderPromptPresetList();
    renderPromptPresetButtons();
    document.getElementById('prompt-preset-new-name').value = '';
    document.getElementById('prompt-preset-new-text').value = '';
    const groupSelect = document.getElementById('prompt-preset-new-group');
    if (groupSelect) groupSelect.value = '';
    showToast(editingPromptPresetId ? '预设已更新' : '预设已保存', 'success');
});

// 弹窗关闭
document.querySelector('[data-close="modal-prompt-template"]')?.addEventListener('click', () => {
    document.getElementById('modal-prompt-template').style.display = 'none';
});

// ---------- 复制图片组（图片粘贴队列） ----------
// 图片粘贴队列：复制多张图后，每次Ctrl+V自动粘贴下一张
let pasteQueue = []; // { blob, name }
let pasteQueueIndex = 0;
let pasteQueueHandler = null;

function startPasteQueue() {
    if (pasteQueue.length === 0) return;
    pasteQueueIndex = 0;
    // 立即把第一张图写入剪贴板
    writeCurrentToClipboard();
    // 注册全局粘贴拦截
    if (!pasteQueueHandler) {
        pasteQueueHandler = true;
        document.addEventListener('paste', onPasteQueueDispatch, true);
    }
    updatePasteQueueHint();
}

function stopPasteQueue() {
    pasteQueue = [];
    pasteQueueIndex = 0;
    const hint = document.getElementById('paste-queue-hint');
    if (hint) hint.style.display = 'none';
}

async function writeCurrentToClipboard() {
    if (pasteQueueIndex >= pasteQueue.length) {
        stopPasteQueue();
        showToast('所有图片已粘贴完毕', 'success');
        return;
    }
    const item = pasteQueue[pasteQueueIndex];
    try {
        await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': item.blob })
        ]);
    } catch(e) {
        console.error('写入剪贴板失败:', e);
    }
}

function updatePasteQueueHint() {
    let hint = document.getElementById('paste-queue-hint');
    if (!hint) {
        hint = document.createElement('div');
        hint.id = 'paste-queue-hint';
        hint.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1a1a1a;color:#fff;padding:8px 16px;border-radius:8px;font-size:12px;z-index:9999;display:none;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
        document.body.appendChild(hint);
    }
    if (pasteQueue.length > 0 && pasteQueueIndex < pasteQueue.length) {
        hint.innerHTML = `📋 粘贴队列：第 <b>${pasteQueueIndex + 1}</b>/${pasteQueue.length} 张 — 在目标位置按 <b>Ctrl+V</b> 粘贴，自动切换下一张 <button onclick="stopPasteQueue()" style="margin-left:8px;padding:2px 6px;border:1px solid #666;background:none;color:#999;border-radius:3px;cursor:pointer;font-size:10px;">取消</button>`;
        hint.style.display = 'block';
    } else {
        hint.style.display = 'none';
    }
}

// 全局粘贴事件：当粘贴队列激活时，拦截粘贴并自动切换到下一张
function onPasteQueueDispatch(e) {
    if (pasteQueue.length === 0 || pasteQueueIndex >= pasteQueue.length) return;
    // 不阻止默认粘贴行为 — 让当前图片正常粘贴出去
    // 粘贴完成后，切换到下一张
    pasteQueueIndex++;
    if (pasteQueueIndex < pasteQueue.length) {
        writeCurrentToClipboard();
        updatePasteQueueHint();
    } else {
        // 全部粘贴完
        setTimeout(() => {
            stopPasteQueue();
            showToast(`${pasteQueue.length}张图片全部粘贴完毕`, 'success');
        }, 300);
    }
}

// ---------- 外部导出：只读提取图片路径 ----------

// 只读函数：从 imageState.slots 提取有图片的相对路径（严禁修改原数组）
function getImagesForExternalExport() {
    return imageState.slots
        .filter(slot => slot.image && slot.image.trim() !== '')
        .map(slot => slot.image);
}

// 方案一：写入 macOS 系统剪贴板（多张图片，Cmd+V 粘贴到外部）
async function handleExportToClipboard() {
    const images = getImagesForExternalExport();
    if (images.length === 0) { showToast('请先添加图片', 'error'); return; }

    try {
        const res = await fetch('/api/copy-images-to-sys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`${data.count}张图片已写入系统剪贴板，Cmd+V 粘贴到任意应用`, 'success');
        } else {
            showToast('复制失败: ' + (data.error || data.message), 'error');
        }
    } catch (e) {
        showToast('复制到系统剪贴板失败: ' + e.message, 'error');
    }
}

// 方案二：聚合到临时文件夹 + 打开访达
async function handleRevealTempFolder() {
    const images = getImagesForExternalExport();
    if (images.length === 0) { showToast('请先添加图片', 'error'); return; }

    try {
        const res = await fetch('/api/reveal-temp-images', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ images })
        });
        const data = await res.json();
        if (data.success) {
            showToast(`${data.count}张图片已聚合，访达已打开，全选拖拽即可`, 'success');
        } else {
            showToast('聚合失败: ' + (data.error || data.message), 'error');
        }
    } catch (e) {
        showToast('打开临时文件夹失败: ' + e.message, 'error');
    }
}

// 绑定按钮事件
document.getElementById('btn-export-clipboard')?.addEventListener('click', async () => {
    logAction('export', '写入剪贴板', {});
    await handleExportToClipboard();
});
document.getElementById('btn-reveal-folder')?.addEventListener('click', async () => {
    logAction('export', '聚合打开', {});
    await handleRevealTempFolder();
});

document.getElementById('btn-copy-images').addEventListener('click', async () => {
    logAction('export', '复制图片组', {});
    const slotsWithImages = imageState.slots.filter(s => s.image);
    if (slotsWithImages.length === 0) {
        showToast('没有可复制的图片', 'error');
        return;
    }

    try {
        // 获取所有图片blob（按槽位顺序）
        const imageBlobs = [];
        for (let i = 0; i < imageState.slots.length; i++) {
            const slot = imageState.slots[i];
            if (!slot.image) continue;
            let imgUrl = slot.image;
            if (imgUrl.startsWith('/')) imgUrl = window.location.origin + imgUrl;
            try {
                const resp = await fetch(imgUrl);
                if (!resp.ok) continue;
                const blob = await resp.blob();
                const pngBlob = await convertBlobToPng(blob);
                const label = slot.label || `图${i + 1}`;
                imageBlobs.push({ blob: pngBlob, name: `${label}.png` });
            } catch(e) {
                console.warn('获取图片失败:', e);
            }
        }

        if (imageBlobs.length === 0) throw new Error('所有图片获取失败');

        // 建立粘贴队列
        pasteQueue = imageBlobs;
        startPasteQueue();

        if (imageBlobs.length === 1) {
            showToast('1张图片已复制，Ctrl+V粘贴', 'success');
        } else {
            showToast(`${imageBlobs.length}张图片已复制到粘贴队列，每次Ctrl+V粘贴下一张`, 'success');
        }
    } catch (e) {
        console.error('复制图片失败:', e);
        showToast('图片复制失败: ' + e.message, 'error');
    }
});

// 将多张图片合并为横向拼图
function createCollage(imgs) {
    return new Promise((resolve, reject) => {
        if (!imgs || imgs.length === 0) { reject(new Error('无图片')); return; }
        const gap = 10; // 图片间距
        const maxH = 1024; // 最大高度
        // 缩放所有图片到相同高度
        const targetH = Math.min(maxH, Math.max(...imgs.map(i => i.naturalHeight)));
        const scaledWidths = imgs.map(img => {
            const ratio = targetH / img.naturalHeight;
            return Math.round(img.naturalWidth * ratio);
        });
        const totalW = scaledWidths.reduce((a, b) => a + b, 0) + gap * (imgs.length - 1);

        const canvas = document.createElement('canvas');
        canvas.width = totalW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, totalW, targetH);

        let x = 0;
        for (let i = 0; i < imgs.length; i++) {
            const w = scaledWidths[i];
            ctx.drawImage(imgs[i], x, 0, w, targetH);
            x += w + gap;
        }

        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('canvas.toBlob 返回 null'));
        }, 'image/png');
    });
}

// 将任意图片Blob转为PNG Blob（兼容Clipboard API）
function convertBlobToPng(blob) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (!settled) { settled = true; URL.revokeObjectURL(img.src); resolve(blob); }
        }, 10000);
        const img = new Image();
        img.onload = () => {
            if (settled) return;
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(img.src);
            clearTimeout(timer);
            canvas.toBlob((pngBlob) => {
                settled = true;
                if (pngBlob) resolve(pngBlob);
                else resolve(blob);
            }, 'image/png');
        };
        img.onerror = () => {
            if (settled) return;
            URL.revokeObjectURL(img.src);
            clearTimeout(timer);
            settled = true;
            resolve(blob);
        };
        img.src = URL.createObjectURL(blob);
    });
}

// ---------- 网址栏（新窗口模式） ----------
let browserUrl = 'https://gemini.google.com';
try { browserUrl = localStorage.getItem('browser-url') || browserUrl; } catch(e) {}

const browserUrlInput = document.getElementById('browser-url-input');
if (browserUrlInput) {
    browserUrlInput.value = browserUrl;
    browserUrlInput.addEventListener('change', () => {
        browserUrl = browserUrlInput.value.trim();
        try { localStorage.setItem('browser-url', browserUrl); } catch(e) {}
    });
    browserUrlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            browserUrl = browserUrlInput.value.trim();
            if (browserUrl) { try { localStorage.setItem('browser-url', browserUrl); } catch(e) {} window.open(browserUrl, '_blank'); }
        }
    });
}

// 新窗口打开按钮
document.getElementById('btn-browser-new-window')?.addEventListener('click', () => {
    const url = browserUrlInput?.value?.trim() || browserUrl;
    if (url) window.open(url, '_blank');
});

// ---------- 系统提示词保存 ----------
document.getElementById('btn-save-system-prompt')?.addEventListener('click', async () => {
    try {
        const config = await api('GET', '/api/model-config');
        config.system_prompt_prompt = document.getElementById('cfg-system-prompt-prompt')?.value || '';
        config.system_prompt_bilingual = document.getElementById('cfg-system-prompt-bilingual')?.value || '';
        config.system_prompt_translate = document.getElementById('cfg-system-prompt-translate')?.value || '';
        await api('PUT', '/api/model-config', config);
        state.modelConfig = config;
        closeModal('modal-system-prompt');
        showToast('改写标准已保存', 'success');
    } catch (e) { showToast(e.message, 'error'); }
});

// ---------- Prompt 折叠 ----------
document.querySelectorAll('.prompt-collapsible-header').forEach(header => {
    header.addEventListener('click', () => {
        const block = header.closest('.prompt-collapsible');
        const body = block.querySelector('.prompt-collapsible-body');
        const arrow = header.querySelector('.prompt-collapse-arrow');
        const isExpanded = body.classList.contains('expanded');
        if (isExpanded) {
            body.classList.remove('expanded');
            body.style.display = 'none';
            arrow.classList.remove('expanded');
        } else {
            body.classList.add('expanded');
            body.style.display = 'block';
            arrow.classList.add('expanded');
        }
    });
});

// ---------- 图生图模式切换增强 ----------
const origSwitchMode = switchMode;
switchMode = function(mode) {
    origSwitchMode(mode);
    // 不再需要加载浏览器iframe
};

// ---------- Gemini 双模式系统 ----------
let geminiMode = 'manual';
try { geminiMode = localStorage.getItem('gemini-mode') || 'manual'; } catch(e) {}

function switchGeminiMode(mode) {
    geminiMode = mode;
    try { localStorage.setItem('gemini-mode', mode); } catch(e) {}
    document.querySelectorAll('.gemini-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.geminiMode === mode);
    });
    const autoActions = document.getElementById('auto-actions');
    if (autoActions) autoActions.style.display = mode === 'auto' ? 'flex' : 'none';
    const hint = document.getElementById('gemini-mode-hint');
    if (mode === 'manual') {
        hint.textContent = '风控 = 0';
        hint.className = 'gemini-mode-hint hint-safe';
    } else {
        hint.textContent = '存在风控风险';
        hint.className = 'gemini-mode-hint hint-risk';
    }
}

document.querySelectorAll('.gemini-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => switchGeminiMode(btn.dataset.geminiMode));
});

if (geminiMode === 'auto') switchGeminiMode('auto');

// 半自动模式：复制Prompt + 复制图片 + 打开Gemini新窗口
// 半自动按钮已通过复制英文/复制图片/新窗口打开实现

// 自动模式安全策略
function randomDelay(min = 800, max = 3000) {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min) + min)));
}

let autoFillRunning = false;
document.getElementById('btn-auto-fill-gemini')?.addEventListener('click', async () => {
    if (autoFillRunning) { showToast('自动填充进行中', 'error'); return; }
    const promptEn = document.getElementById('img-prompt-en').value;
    if (!promptEn) { showToast('请先生成英文 Prompt', 'error'); return; }

    autoFillRunning = true;
    const btn = document.getElementById('btn-auto-fill-gemini');
    btn.disabled = true;
    btn.innerHTML = '<span class="loading"></span> 填充中...';

    try {
        // 1. 复制英文Prompt到剪贴板
        await navigator.clipboard.writeText(promptEn);
        showToast('英文 Prompt 已复制到剪贴板', 'success');
        await randomDelay(500, 1500);

        // 2. 复制第一张图片到剪贴板
        const slotsWithImages = imageState.slots.filter(s => s.image);
        if (slotsWithImages.length > 0) {
            try {
                let imgUrl = slotsWithImages[0].image;
                if (imgUrl.startsWith('/')) imgUrl = window.location.origin + imgUrl;
                const resp = await fetch(imgUrl);
                const blob = await resp.blob();
                const pngBlob = await convertBlobToPng(blob);
                if (navigator.clipboard && navigator.clipboard.write) {
                    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
                    showToast('第1张图片已复制到剪贴板', 'success');
                }
            } catch (imgErr) {
                console.warn('复制图片失败:', imgErr);
            }
        }

        await randomDelay(500, 1500);

        // 3. 在新窗口打开Gemini
        const url = document.getElementById('browser-url-input')?.value || 'https://gemini.google.com';
        window.open(url, '_blank');
        showToast('已打开Gemini，请Ctrl+V粘贴Prompt和图片', 'info');
    } catch (e) {
        showToast('出错：' + e.message, 'error');
    } finally {
        autoFillRunning = false;
        btn.disabled = false;
        btn.textContent = '自动填入';
    }
});

// ---------- 图生图预设 ----------
function renderImagePresets() {
    const container = document.getElementById('image-presets-body');
    if (!container) return;
    container.innerHTML = '';

    // 渲染筛选标签
    renderImgPresetFilterTags();

    const keyword = imageState.presetSearchKeyword.trim().toLowerCase();
    let presets = imageState.presets;
    // 标签筛选
    if (imageState.imgPresetFilterTag) {
        presets = presets.filter(p => (p.tags || []).includes(imageState.imgPresetFilterTag));
    }
    if (keyword) {
        presets = presets.filter(p =>
            p.name.toLowerCase().includes(keyword) ||
            (p.prompt_cn || '').toLowerCase().includes(keyword) ||
            (p.prompt_en || '').toLowerCase().includes(keyword)
        );
    }

    // 排序
    if (imageState.presetSortBy && imageState.presetSortBy !== 'default') {
        presets = [...presets].sort((a, b) => {
            if (imageState.presetSortBy === 'name') return (a.name || '').localeCompare(b.name || '', 'zh-CN');
            if (imageState.presetSortBy === 'created_at') return (b.created_at || '').localeCompare(a.created_at || '');
            if (imageState.presetSortBy === 'updated_at') return (b.updated_at || '').localeCompare(a.updated_at || '');
            return 0;
        });
    }

    if (presets.length === 0) {
        container.innerHTML = '<p class="empty-hint">你还没有保存任何预设<br>保存当前配置，下次可快速复用</p>';
        return;
    }

    const grid = document.createElement('div');
    grid.className = 'preset-grid';
    grid.style.gridTemplateColumns = `repeat(${imageState.imgPresetZoom}, 1fr)`;

    for (const preset of presets) {
        const card = document.createElement('div');
        card.className = 'preset-card';

        // 封面图：优先用效果图，否则用第一张有图片的槽位
        const coverImage = preset.effect_image || ((preset.images && preset.images.length > 0) ? (preset.images.find(s => s.path)?.path || '') : '');
        const coverHtml = coverImage
            ? `<div class="preset-cover"><img src="${escHtml(coverImage)}" alt="${escHtml(preset.name)}" class="preset-cover-img"></div>`
            : `<div class="preset-cover">📷</div>`;

        // 标签
        const tags = preset.tags || [];
        const tagsHtml = tags.length
            ? `<div class="preset-tags">${tags.map(t => `<span class="preset-tag-badge">${escHtml(t)}</span>`).join('')}</div>`
            : '';

        const desc = preset.prompt_cn
            ? (preset.prompt_cn.length > 40 ? preset.prompt_cn.substring(0, 40) + '...' : preset.prompt_cn)
            : '无提示词';

        card.innerHTML = `
            ${coverHtml}
            ${tagsHtml}
            <div class="preset-info">
                <div class="preset-name">${escHtml(preset.name)}</div>
                <div class="preset-desc">${escHtml(desc)}</div>
            </div>
            <div class="preset-actions">
                <button class="btn btn-outline btn-sm img-preset-apply">应用</button>
                <button class="btn btn-outline btn-sm img-preset-edit">编辑</button>
                <button class="btn btn-outline btn-sm img-preset-clone">复制</button>
                <button class="btn btn-outline btn-sm img-preset-delete" style="color:var(--danger)">删除</button>
            </div>
        `;

        const coverImg = card.querySelector('.preset-cover-img');
        if (coverImg) {
            coverImg.style.cursor = 'pointer';
            coverImg.addEventListener('click', (e) => {
                e.stopPropagation();
                showImagePreview(coverImage);
            });
        }

        card.querySelector('.img-preset-apply').addEventListener('click', () => applyImagePreset(preset));
        card.querySelector('.img-preset-edit').addEventListener('click', () => editImagePreset(preset));
        card.querySelector('.img-preset-clone').addEventListener('click', () => cloneImagePreset(preset));
        card.querySelector('.img-preset-delete').addEventListener('click', () => deleteImagePreset(preset));
        grid.appendChild(card);
    }

    container.appendChild(grid);
}

// 图生图预设筛选标签
function renderImgPresetFilterTags() {
    const container = document.getElementById('img-preset-filter-tags');
    if (!container) return;
    container.innerHTML = '';

    const usedTags = new Set();
    for (const p of imageState.presets) {
        for (const t of (p.tags || [])) usedTags.add(t);
    }
    if (usedTags.size === 0) return;

    const allTag = document.createElement('span');
    allTag.className = `preset-filter-tag ${imageState.imgPresetFilterTag === '' ? 'active' : ''}`;
    allTag.textContent = '全部';
    allTag.addEventListener('click', () => { imageState.imgPresetFilterTag = ''; renderImagePresets(); });
    container.appendChild(allTag);

    for (const tag of usedTags) {
        const el = document.createElement('span');
        el.className = `preset-filter-tag ${imageState.imgPresetFilterTag === tag ? 'active' : ''}`;
        el.textContent = tag;
        el.addEventListener('click', () => { imageState.imgPresetFilterTag = tag; renderImagePresets(); });
        container.appendChild(el);
    }
}

// 图生图预设标签列表（保存弹窗中）
function renderImgPresetTagList() {
    const container = document.getElementById('img-preset-tag-list');
    if (!container) return;
    container.innerHTML = '';
    for (const tag of imageState.presetTags) {
        const el = document.createElement('span');
        el.className = `preset-tag-item ${imageState.selectedImgPresetTags.includes(tag) ? 'selected' : ''}`;
        el.textContent = tag;
        el.addEventListener('click', () => {
            const idx = imageState.selectedImgPresetTags.indexOf(tag);
            if (idx >= 0) imageState.selectedImgPresetTags.splice(idx, 1);
            else imageState.selectedImgPresetTags.push(tag);
            renderImgPresetTagList();
        });
        container.appendChild(el);
    }
}

// 预设搜索
let _imgPresetSearchTimer = null;
document.getElementById('img-preset-search-input')?.addEventListener('input', (e) => {
    imageState.presetSearchKeyword = e.target.value;
    clearTimeout(_imgPresetSearchTimer);
    _imgPresetSearchTimer = setTimeout(() => renderImagePresets(), 200);
});

// 图生图预设排序
document.getElementById('img-preset-sort-select')?.addEventListener('change', (e) => {
    imageState.presetSortBy = e.target.value;
    renderImagePresets();
});

// 保存预设
document.getElementById('btn-img-save-preset').addEventListener('click', () => {
    // 多图队列模式下，先保存当前队列数据
    if (queueMode === 'multi') saveCurrentQueueData();

    document.getElementById('img-preset-name').value = '';
    imageState.selectedImgPresetTags = [];
    imageState._editingImgPresetId = null; // 新建模式

    // 显示参数摘要
    const slotsInfo = document.getElementById('img-preset-slots-info');
    const platform = document.getElementById('cfg-api-platform')?.value || '';
    const platformLabel = platform === 'oaihk' ? '通道二 HK' : '通道一 RH';
    const model = platform === 'oaihk'
        ? document.getElementById('cfg-oaihk-model-inline')?.value || ''
        : document.getElementById('cfg-rh-model-inline')?.value || '';
    const aspectRatio = platform === 'oaihk'
        ? document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4'
        : document.getElementById('cfg-rh-aspect-ratio-inline')?.value || '3:4';
    const promptLang = apiPromptLang === 'cn' ? '中文' : '英文';
    const promptCn = document.getElementById('img-prompt-cn').value;
    const promptEn = document.getElementById('img-prompt-en').value;
    const queueLabel = queueMode === 'multi' ? `（队列${activeQueue+1}）` : '';

    const slotLines = imageState.slots
        .filter(s => s.image || s.label)
        .map((s, i) => `Image ${i+1}: ${s.label || '未标注'} ${s.image ? '✓' : '✗'}`);

    // 检查是否有效果图
    const grid = document.getElementById('api-result-grid');
    const resultCards = grid?.querySelectorAll('.api-result-card img');
    const hasEffect = resultCards && resultCards.length > 0;

    let html = '';
    html += `<div class="summary-line"><b>平台：</b>${escHtml(platformLabel)}</div>`;
    html += `<div class="summary-line"><b>模型：</b>${escHtml(model)}</div>`;
    html += `<div class="summary-line"><b>比例：</b>${escHtml(aspectRatio)}</div>`;
    html += `<div class="summary-line"><b>提示词：</b>${escHtml(promptLang)}（${promptLang === '中文' ? 'CN' : 'EN'}→API）</div>`;
    if (promptCn) html += `<div class="summary-line" style="color:var(--text-muted);font-size:10px;max-height:32px;overflow:hidden;">CN: ${escHtml(promptCn.substring(0, 80))}${promptCn.length > 80 ? '...' : ''}</div>`;
    if (promptEn) html += `<div class="summary-line" style="color:var(--text-muted);font-size:10px;max-height:32px;overflow:hidden;">EN: ${escHtml(promptEn.substring(0, 80))}${promptEn.length > 80 ? '...' : ''}</div>`;
    if (queueLabel) html += `<div class="summary-line" style="font-weight:500;">${escHtml(queueLabel)}</div>`;
    html += slotLines.map(l => `<div class="summary-line">${escHtml(l)}</div>`).join('');
    if (hasEffect) html += `<div class="summary-line" style="color:#22c55e;">✓ 效果图将作为封面</div>`;
    else html += `<div class="summary-line" style="color:var(--text-muted);">暂无效果图</div>`;
    slotsInfo.innerHTML = html;

    renderImgPresetTagList();
    openModal('modal-save-image-preset');
});

document.getElementById('btn-confirm-save-image-preset').addEventListener('click', async () => {
    const name = document.getElementById('img-preset-name').value.trim();
    if (!name) { showToast('请输入预设名称', 'error'); return; }

    const payload = {
        name,
        tags: imageState.selectedImgPresetTags,
        prompt_cn: document.getElementById('img-prompt-cn').value,
        prompt_en: document.getElementById('img-prompt-en').value,
        prompt_lang: apiPromptLang,
        images: imageState.slots.map(s => ({
            path: s.image || '',
            label: s.label || '',
            prefixTemplate: s.prefixTemplate || '请参考'
        })),
        platform: document.getElementById('cfg-api-platform')?.value || '',
        model: document.getElementById('cfg-api-platform')?.value === 'oaihk'
            ? document.getElementById('cfg-oaihk-model-inline')?.value || ''
            : document.getElementById('cfg-rh-model-inline')?.value || '',
        aspect_ratio: document.getElementById('cfg-api-platform')?.value === 'oaihk'
            ? document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4'
            : document.getElementById('cfg-rh-aspect-ratio-inline')?.value || '3:4',
        effect_image: (() => {
            // 取结果网格中最后一张生成图作为封面
            const grid = document.getElementById('api-result-grid');
            const cards = grid?.querySelectorAll('.api-result-card img');
            if (cards && cards.length > 0) return cards[cards.length - 1].src;
            return '';
        })()
    };

    try {
        if (imageState._editingImgPresetId) {
            // 编辑模式：更新已有预设
            const updated = await api('PUT', `/api/image-presets/${imageState._editingImgPresetId}`, payload);
            const idx = imageState.presets.findIndex(p => p.id === imageState._editingImgPresetId);
            if (idx >= 0) imageState.presets[idx] = updated;
            imageState._editingImgPresetId = null;
            showToast('预设已更新', 'success');
        } else {
            // 新建模式
            const preset = await api('POST', '/api/image-presets', payload);
            imageState.presets.push(preset);
            showToast('预设保存成功', 'success');
        }
        renderImagePresets();
        closeModal('modal-save-image-preset');
    } catch (e) { showToast(e.message, 'error'); }
});

// 应用预设
function applyImagePreset(preset) {
    pushUndoSnapshot();
    // 恢复 Prompt
    if (preset.prompt_cn) document.getElementById('img-prompt-cn').value = preset.prompt_cn;
    if (preset.prompt_en) {
        document.getElementById('img-prompt-en').value = preset.prompt_en;
        document.getElementById('btn-img-copy-en').disabled = false;
        document.getElementById('btn-copy-images').disabled = !imageState.slots.some(s => s.image);
        document.getElementById('btn-auto-fill-gemini').disabled = false;
    }

    // 恢复提示词语言
    if (preset.prompt_lang) {
        apiPromptLang = preset.prompt_lang;
        const btn = document.getElementById('btn-api-prompt-lang');
        if (btn) {
            if (apiPromptLang === 'cn') {
                btn.textContent = '使用中文提示词';
                btn.style.color = '#22c55e';
                btn.style.borderColor = '#22c55e';
                btn.title = '当前：使用中文提示词提交API（点击切换为英文）';
            } else {
                btn.textContent = '使用英文提示词';
                btn.style.color = '#f59e0b';
                btn.style.borderColor = '#f59e0b';
                btn.title = '当前：使用英文提示词提交API（点击切换为中文）';
            }
        }
    }

    // 恢复平台
    if (preset.platform) {
        const platformSelect = document.getElementById('cfg-api-platform');
        if (platformSelect) platformSelect.value = preset.platform;
        togglePlatformUI(preset.platform);
    }

    // 恢复模型
    if (preset.model) {
        if (preset.platform === 'oaihk') {
            const hkSelect = document.getElementById('cfg-oaihk-model-inline');
            if (hkSelect) hkSelect.value = preset.model;
            updateOaihkModelParamsInline();
        } else {
            const rhSelect = document.getElementById('cfg-rh-model-inline');
            if (rhSelect) rhSelect.value = preset.model;
            updateRhModelParamsInline();
        }
    }

    // 恢复比例
    if (preset.aspect_ratio) {
        if (preset.platform === 'oaihk') {
            const arSelect = document.getElementById('cfg-oaihk-aspect-ratio-inline');
            if (arSelect) arSelect.value = preset.aspect_ratio;
        } else {
            const arSelect = document.getElementById('cfg-rh-aspect-ratio-inline');
            if (arSelect) arSelect.value = preset.aspect_ratio;
        }
    }

    // 恢复图片槽
    if (preset.images && preset.images.length > 0) {
        imageState.slots = preset.images.map(img => ({
            image: img.path || '',
            label: img.label || '',
            prefixTemplate: img.prefixTemplate || '请参考'
        }));
    } else {
        imageState.slots = [{ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' }, { image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' }];
    }
    // 确保有10个槽位
    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
    }
    imageState.activeSlotIndex = 0;
    renderImageSlots();
    updateLocalPrompt();
    saveSlotsToStorage();
    // 多图队列模式下同步到队列数据
    if (queueMode === 'multi') {
        saveCurrentQueueData();
    }
    showToast('已应用预设', 'success');
}

// 编辑图生图预设
function editImagePreset(preset) {
    // 先应用预设到当前槽位
    applyImagePreset(preset);
    // 然后打开保存弹窗，预填名称
    document.getElementById('img-preset-name').value = preset.name;
    imageState.selectedImgPresetTags = [...(preset.tags || [])];
    // 标记为编辑模式
    imageState._editingImgPresetId = preset.id;
    renderImgPresetTagList();
    openModal('modal-save-image-preset');
}

// 复制预设
async function cloneImagePreset(preset) {
    try {
        const payload = {
            name: preset.name + ' - 副本',
            tags: [...(preset.tags || [])],
            prompt_cn: preset.prompt_cn || '',
            prompt_en: preset.prompt_en || '',
            prompt_lang: preset.prompt_lang || 'en',
            images: deepClone(preset.images || []),
            platform: preset.platform || '',
            model: preset.model || '',
            aspect_ratio: preset.aspect_ratio || '3:4',
            effect_image: preset.effect_image || ''
        };
        const newPreset = await api('POST', '/api/image-presets', payload);
        imageState.presets.push(newPreset);
        renderImagePresets();
        showToast('预设已复制', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

// 删除预设
function deleteImagePreset(preset) {
    showConfirm(`确定删除预设"${preset.name}"吗？`, async () => {
        try {
            await api('DELETE', `/api/image-presets/${preset.id}`);
            imageState.presets = imageState.presets.filter(p => p.id !== preset.id);
            renderImagePresets();
            showToast('预设已删除', 'success');
        } catch (e) { showToast(e.message, 'error'); }
    });
}

// ---------- 文生图面板拖拽调整宽度 ----------
(function initImageResize() {
    const handle1 = document.getElementById('resize-handle-img');
    const panel1 = document.getElementById('image-library-panel');
    const imageMode = document.getElementById('image-mode');
    if (handle1 && panel1 && imageMode) {
        // 恢复保存的宽度
        const savedLibWidth = localStorage.getItem('image-lib-panel-width');
        if (savedLibWidth) panel1.style.width = savedLibWidth;
        let isResizing = false;
        handle1.addEventListener('mousedown', (e) => { isResizing = true; handle1.classList.add('active'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const rect = imageMode.getBoundingClientRect();
            let newWidth = Math.max(80, Math.min(rect.width - 400, e.clientX - rect.left));
            panel1.style.width = newWidth + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            handle1.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('image-lib-panel-width', panel1.style.width);
        });
    }

    // 拆图模式 resize handle
    const splitHandle = document.getElementById('resize-handle-split');
    const splitPanel1 = document.getElementById('split-library-panel');
    const splitModeEl = document.getElementById('split-mode');
    if (splitHandle && splitPanel1 && splitModeEl) {
        const savedSplitLibWidth = localStorage.getItem('split-lib-panel-width');
        if (savedSplitLibWidth) splitPanel1.style.width = savedSplitLibWidth;
        let isSplitResizing = false;
        splitHandle.addEventListener('mousedown', (e) => { isSplitResizing = true; splitHandle.classList.add('active'); document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
        document.addEventListener('mousemove', (e) => {
            if (!isSplitResizing) return;
            const rect = splitModeEl.getBoundingClientRect();
            let newWidth = Math.max(80, Math.min(rect.width - 400, e.clientX - rect.left));
            splitPanel1.style.width = newWidth + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!isSplitResizing) return;
            isSplitResizing = false;
            splitHandle.classList.remove('active');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            localStorage.setItem('split-lib-panel-width', splitPanel1.style.width);
        });
    }
})();

// ---------- 3:4 / 4:3 自适应裁剪 + 压缩工具 ----------
let cropState = null; // { img, imgWidth, imgHeight, cropX, cropY, cropW, cropH, targetRatio, ratioLabel, callback }

// ---------- 批量裁剪队列 ----------
let cropQueue = []; // [{ file, slotIndex, callback }]
let cropQueueActive = false;

function updateCropProgress() {
    const indicator = document.getElementById('crop-progress-indicator');
    if (!indicator) return;
    if (cropQueueActive && cropQueue._totalCount > 1) {
        const current = (cropQueue._processedCount || 0) + 1;
        indicator.textContent = `裁剪 ${current}/${cropQueue._totalCount}`;
        indicator.style.display = 'inline';
    } else {
        indicator.style.display = 'none';
    }
}

function processCropQueue() {
    if (cropQueue.length === 0) {
        cropQueueActive = false;
        updateCropProgress();
        return;
    }
    cropQueueActive = true;
    const item = cropQueue.shift();
    updateCropProgress();
    const reader = new FileReader();
    reader.onload = (ev) => {
        showCropModal(ev.target.result, async (croppedBlob) => {
            if (croppedBlob && item.callback) {
                await item.callback(croppedBlob);
            }
            cropQueue._processedCount = (cropQueue._processedCount || 0) + 1;
            updateCropProgress();
            // 自动触发下一张裁剪
            processCropQueue();
        });
    };
    reader.readAsDataURL(item.file);
}

function startBatchCrop(files, slotIndex, onEachCropped) {
    if (!files || files.length === 0) return;
    const _totalCount = files.length;
    const queueItems = [];
    for (let i = 0; i < files.length; i++) {
        const targetSlot = slotIndex + i < SLOT_COUNT ? slotIndex + i : slotIndex;
        queueItems.push({
            file: files[i],
            slotIndex: targetSlot,
            callback: onEachCropped(targetSlot, i, files.length)
        });
    }
    cropQueue.push(...queueItems);
    cropQueue._totalCount = _totalCount;
    cropQueue._processedCount = 0;
    if (!cropQueueActive) {
        processCropQueue();
    }
}

function getClosestUploadCropRatio(width, height) {
    const ratio = width / height;
    const portrait = 3 / 4;
    const landscape = 4 / 3;
    const portraitDiff = Math.abs(ratio - portrait);
    const landscapeDiff = Math.abs(ratio - landscape);
    return landscapeDiff < portraitDiff
        ? { ratio: landscape, label: '4:3' }
        : { ratio: portrait, label: '3:4' };
}

function showCropModal(imgSrc, callback) {
    // imgSrc: data URL or object URL of the image
    // callback: function(croppedBlob) called when user confirms crop
    const canvas = document.getElementById('crop-canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
        const pickedRatio = getClosestUploadCropRatio(img.width, img.height);
        const targetRatio = pickedRatio.ratio;
        const title = document.querySelector('#modal-crop .modal-header h3');
        if (title) title.textContent = `裁剪图片（${pickedRatio.label}比例）`;

        // Fit image to display canvas
        const maxW = 480, maxH = 400;
        let drawW = img.width, drawH = img.height;
        if (drawW > maxW) { drawH *= maxW / drawW; drawW = maxW; }
        if (drawH > maxH) { drawW *= maxH / drawH; drawH = maxH; }
        canvas.width = Math.round(drawW);
        canvas.height = Math.round(drawH);

        // 动态计算最大 3:4 / 4:3 选区（在显示坐标系内）
        let cropW, cropH;
        if (drawW / drawH > targetRatio) {
            // 图片偏宽：高度撑满，宽度按目标比例
            cropH = drawH;
            cropW = cropH * targetRatio;
        } else {
            // 图片偏窄：宽度撑满，高度按目标比例
            cropW = drawW;
            cropH = cropW / targetRatio;
        }
        const cropX = (drawW - cropW) / 2;
        const cropY = (drawH - cropH) / 2;

        cropState = {
            img, drawW, drawH,
            cropX, cropY, cropW, cropH,
            targetRatio,
            ratioLabel: pickedRatio.label,
            callback,
            dragging: false, resizing: false, resizeCorner: -1,
            dragStartX: 0, dragStartY: 0, origCropX: 0, origCropY: 0,
            origCropW: 0, origCropH: 0
        };

        drawCropCanvas();
        openModal('modal-crop');
        updateCropProgress();
    };
    img.src = imgSrc;
}

function drawCropCanvas() {
    if (!cropState) return;
    const { img, drawW, drawH, cropX, cropY, cropW, cropH, ratioLabel } = cropState;
    const canvas = document.getElementById('crop-canvas');
    const ctx = canvas.getContext('2d');

    // Draw image
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, drawW, drawH);

    // Dark overlay outside crop area
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, cropY);
    ctx.fillRect(0, cropY, cropX, cropH);
    ctx.fillRect(cropX + cropW, cropY, canvas.width - cropX - cropW, cropH);
    ctx.fillRect(0, cropY + cropH, canvas.width, canvas.height - cropY - cropH);

    // Crop border
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(cropX, cropY, cropW, cropH);

    // Corner handles (larger, 12x12 for easier dragging)
    const handleSize = 12;
    ctx.fillStyle = '#fff';
    const corners = [[cropX, cropY], [cropX + cropW, cropY], [cropX, cropY + cropH], [cropX + cropW, cropY + cropH]];
    corners.forEach(([x, y]) => {
        ctx.fillRect(x - handleSize/2, y - handleSize/2, handleSize, handleSize);
    });

    // 显示裁剪区域的实际像素尺寸
    const scaleX = img.width / drawW;
    const scaleY = img.height / drawH;
    const realW = Math.round(cropW * scaleX);
    const realH = Math.round(cropH * scaleY);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = '11px sans-serif';
    const sizeText = `${realW} × ${realH} · ${ratioLabel || '3:4'}`;
    const textW = ctx.measureText(sizeText).width;
    const textX = cropX + (cropW - textW) / 2;
    const textY = cropY + cropH - 8;
    ctx.fillRect(textX - 4, textY - 12, textW + 8, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(sizeText, textX, textY);
}

// Crop canvas mouse events
(function initCropInteraction() {
    const canvas = document.getElementById('crop-canvas');
    if (!canvas) return;

    // 检测点击是否在角点上（返回角点索引0-3，或-1）
    function hitCorner(mx, my) {
        if (!cropState) return -1;
        const { cropX, cropY, cropW, cropH } = cropState;
        const threshold = 16; // 点击容差
        const corners = [
            [cropX, cropY],             // 0: 左上
            [cropX + cropW, cropY],     // 1: 右上
            [cropX, cropY + cropH],     // 2: 左下
            [cropX + cropW, cropY + cropH] // 3: 右下
        ];
        for (let i = 0; i < corners.length; i++) {
            if (Math.abs(mx - corners[i][0]) < threshold && Math.abs(my - corners[i][1]) < threshold) {
                return i;
            }
        }
        return -1;
    }

    canvas.addEventListener('mousedown', (e) => {
        if (!cropState) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;

        // 优先检测角点拖拽
        const corner = hitCorner(mx, my);
        if (corner >= 0) {
            cropState.resizing = true;
            cropState.resizeCorner = corner;
            cropState.dragStartX = mx;
            cropState.dragStartY = my;
            cropState.origCropX = cropState.cropX;
            cropState.origCropY = cropState.cropY;
            cropState.origCropW = cropState.cropW;
            cropState.origCropH = cropState.cropH;
            return;
        }

        // 否则检测是否在裁剪框内（移动）
        if (mx >= cropState.cropX && mx <= cropState.cropX + cropState.cropW &&
            my >= cropState.cropY && my <= cropState.cropY + cropState.cropH) {
            cropState.dragging = true;
            cropState.dragStartX = mx;
            cropState.dragStartY = my;
            cropState.origCropX = cropState.cropX;
            cropState.origCropY = cropState.cropY;
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!cropState) return;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const mx = (e.clientX - rect.left) * scaleX;
        const my = (e.clientY - rect.top) * scaleY;

        // 角点拖拽缩放（保持当前目标比例）
        if (cropState.resizing) {
            const dx = mx - cropState.dragStartX;
            // 根据拖拽方向和角点位置决定缩放
            const corner = cropState.resizeCorner;
            // 左侧角点(0,2): 向左拖=放大, 向右拖=缩小
            // 右侧角点(1,3): 向右拖=放大, 向左拖=缩小
            const isLeft = corner === 0 || corner === 2;
            const widthDelta = isLeft ? -dx : dx;

            let newW = cropState.origCropW + widthDelta;
            const targetRatio = cropState.targetRatio || 3 / 4;
            let newH = newW / targetRatio;

            // 最小尺寸限制
            newW = Math.max(30, newW);
            newH = newW / targetRatio;

            // 不能超出画布
            if (newW > cropState.drawW) { newW = cropState.drawW; newH = newW / targetRatio; }
            if (newH > cropState.drawH) { newH = cropState.drawH; newW = newH * targetRatio; }

            // 保持裁剪框中心位置不变
            const centerX = cropState.origCropX + cropState.origCropW / 2;
            const centerY = cropState.origCropY + cropState.origCropH / 2;
            let newX = centerX - newW / 2;
            let newY = centerY - newH / 2;

            // Clamp到画布边界
            newX = Math.max(0, Math.min(cropState.drawW - newW, newX));
            newY = Math.max(0, Math.min(cropState.drawH - newH, newY));

            cropState.cropX = newX;
            cropState.cropY = newY;
            cropState.cropW = newW;
            cropState.cropH = newH;
            drawCropCanvas();
            return;
        }

        // 移动裁剪框
        if (cropState.dragging) {
            let newX = cropState.origCropX + (mx - cropState.dragStartX);
            let newY = cropState.origCropY + (my - cropState.dragStartY);
            newX = Math.max(0, Math.min(cropState.drawW - cropState.cropW, newX));
            newY = Math.max(0, Math.min(cropState.drawH - cropState.cropH, newY));
            cropState.cropX = newX;
            cropState.cropY = newY;
            drawCropCanvas();
        }
    });

    document.addEventListener('mouseup', () => {
        if (cropState) {
            cropState.dragging = false;
            cropState.resizing = false;
            cropState.resizeCorner = -1;
        }
    });

    // Scroll to resize crop box (保持当前目标比例)
    canvas.addEventListener('wheel', (e) => {
        if (!cropState) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -10 : 10;
        const targetRatio = cropState.targetRatio || 3 / 4;
        let newW = cropState.cropW + delta;
        let newH = newW / targetRatio;

        // Clamp
        newW = Math.max(30, Math.min(cropState.drawW, newW));
        newH = newW / targetRatio;
        if (newH > cropState.drawH) { newH = cropState.drawH; newW = newH * targetRatio; }

        // Keep centered
        const cx = cropState.cropX + cropState.cropW / 2;
        const cy = cropState.cropY + cropState.cropH / 2;
        cropState.cropW = newW;
        cropState.cropH = newH;
        cropState.cropX = Math.max(0, Math.min(cropState.drawW - newW, cx - newW / 2));
        cropState.cropY = Math.max(0, Math.min(cropState.drawH - newH, cy - newH / 2));

        drawCropCanvas();
    }, { passive: false });
})();

// Confirm crop button
document.getElementById('btn-crop-confirm')?.addEventListener('click', () => {
    if (!cropState) return;
    const { img, drawW, drawH, cropX, cropY, cropW, cropH, callback } = cropState;

    // 将显示坐标映射回原图像素坐标
    const scaleX = img.width / drawW;
    const scaleY = img.height / drawH;
    const srcX = cropX * scaleX;
    const srcY = cropY * scaleY;
    const srcW = cropW * scaleX;
    const srcH = cropH * scaleY;

    // 裁剪后如果像素过大（超过4000万像素），先缩小到合理尺寸再输出
    // 防止超大图（如8000x10000）裁剪后生成的JPEG过大导致上传失败
    const MAX_CROP_PIXELS = 40_000_000;
    let outW = Math.round(srcW);
    let outH = Math.round(srcH);
    if (outW * outH > MAX_CROP_PIXELS) {
        const shrinkScale = Math.sqrt(MAX_CROP_PIXELS / (outW * outH));
        outW = Math.round(outW * shrinkScale);
        outH = Math.round(outH * shrinkScale);
    }

    // 在离屏canvas上绘制裁剪区域
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = outW;
    cropCanvas.height = outH;
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, cropCanvas.width, cropCanvas.height);

    // 输出JPEG blob，用compressToUnder2MB确保不超过上传限制
    compressToUnder2MB(cropCanvas, (blob) => {
        closeModal('modal-crop');
        cropState = null;
        if (callback) callback(blob);
    });
});

// Compress canvas to JPEG blob under 2MB (上传时压缩，API生成时不再压缩)
function compressToUnder2MB(canvas, callback) {
    const MAX_SIZE = 2 * 1024 * 1024; // 2MB
    let quality = 0.92;
    function tryCompress() {
        canvas.toBlob((blob) => {
            if (!blob || blob.size <= MAX_SIZE || quality <= 0.1) {
                callback(blob);
                return;
            }
            quality -= 0.1;
            tryCompress();
        }, 'image/jpeg', quality);
    }
    tryCompress();
}

// Upload with crop + compress: opens file picker, then crop modal, then uploads
function uploadWithCrop(uploadCallback) {
    // uploadCallback: function(formData) - called with FormData containing the file
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.jpg,.jpeg,.png,.webp';
    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        cropAndUploadFile(file, uploadCallback);
    };
    input.click();
}

// 对已有File对象弹裁剪弹窗后上传
function cropAndUploadFile(file, uploadCallback) {
    const reader = new FileReader();
    reader.onload = (ev) => {
        showCropModal(ev.target.result, (croppedBlob) => {
            if (!croppedBlob) { showToast('裁剪失败', 'error'); return; }
            const formData = new FormData();
            formData.append('file', croppedBlob, 'cropped.jpg');
            uploadCallback(formData);
        });
    };
    reader.readAsDataURL(file);
}

// ---------- RunningHub 种子模式切换 ----------
const seedModeSelect = document.getElementById('cfg-rh-seed-mode');
const seedInput = document.getElementById('cfg-rh-seed');
if (seedModeSelect && seedInput) {
    seedModeSelect.addEventListener('change', () => {
        seedInput.disabled = seedModeSelect.value === 'random';
        if (seedModeSelect.value === 'random') seedInput.value = '';
    });
}

// ---------- RunningHub 模型配置系统（内联版） ----------
const RH_MODELS = {
    'rhart-image-v1/edit': {
        name: 'V1-图生图-低价渠道版', shortName: 'V1', price: '0.05', type: 'image-to-image',
        maxImages: 5, maxImageMB: 10, hasResolution: false,
        aspectRatios: ['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'],
        aspectRatioRequired: true
    },
    'rhart-image-v1-official/edit': {
        name: 'V1-图生图-官方稳定版', shortName: 'V1-official', price: '0.2', type: 'image-to-image',
        maxImages: 5, maxImageMB: 10, hasResolution: false,
        aspectRatios: ['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'],
        aspectRatioRequired: true
    },
    'rhart-image-n-g31-flash/image-to-image': {
        name: 'V2-图生图-低价渠道版', shortName: 'V2', price: '0.16', type: 'image-to-image',
        maxImages: 10, maxImageMB: 30, hasResolution: true,
        aspectRatios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9','1:4','4:1','1:8','8:1'],
        aspectRatioRequired: false
    },
    'rhart-image-n-g31-flash-official/image-to-image': {
        name: 'V2-图生图-官方稳定版', shortName: 'V2-official', price: '0.74', type: 'image-to-image',
        maxImages: 14, maxImageMB: 10, hasResolution: true,
        aspectRatios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9','1:4','4:1','1:8','8:1'],
        aspectRatioRequired: false
    },
    'rhart-image-n-pro/edit': {
        name: 'PRO-图生图-低价渠道版', shortName: 'PRO', price: '0.4', type: 'image-to-image',
        maxImages: 10, maxImageMB: 10, hasResolution: true,
        aspectRatios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'],
        aspectRatioRequired: false
    },
    'rhart-image-n-pro-official/edit': {
        name: 'PRO-图生图-官方稳定版', shortName: 'PRO-official', price: '1', type: 'image-to-image',
        maxImages: 10, maxImageMB: 10, hasResolution: true,
        aspectRatios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'],
        aspectRatioRequired: false
    }
};

// OpenAI-HK 模型配置
const OAIHK_MODELS = {
    'fal-ai/banana/v2': {
        name: 'proK', shortName: 'proK', price: '0.48',
        endpoint: 'fal-ai/banana/v2',
        modelId: 'fal-ai/banana/v2',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 1024
    },
    'fal-ai/banana/v2/2k': {
        name: 'pro2K', shortName: 'pro2K', price: '0.48',
        endpoint: 'fal-ai/banana/v2/2k',
        modelId: 'fal-ai/banana/v2/2k',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 1536
    },
    'fal-ai/banana/v2/4k': {
        name: 'pro4K', shortName: 'pro4K', price: '0.48',
        endpoint: 'fal-ai/banana/v2/4k',
        modelId: 'fal-ai/banana/v2/4k',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 2048
    },
    'fal-ai/banana/v3.1/flash': {
        name: 'nano2-3.1 1K', shortName: '3.1-1K', price: '0.2',
        endpoint: 'fal-ai/banana/v3.1/flash',
        modelId: 'fal-ai/banana/v3.1/flash',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 1024
    },
    'fal-ai/banana/v3.1/flash/2k': {
        name: 'nano2-3.1 2K', shortName: '3.1-2K', price: '0.3',
        endpoint: 'fal-ai/banana/v3.1/flash/2k',
        modelId: 'fal-ai/banana/v3.1/flash/2k',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 1536
    },
    'fal-ai/banana/v3.1/flash/4k': {
        name: 'nano2-3.1 4K', shortName: '3.1-4K', price: '0.48',
        endpoint: 'fal-ai/banana/v3.1/flash/4k',
        modelId: 'fal-ai/banana/v3.1/flash/4k',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 2048
    },
    'gpt-image-2': {
        name: 'GPT-img-2 1K', shortName: 'GPT2-1K', price: '0.04',
        endpoint: 'gpt-image-2',
        modelId: 'gpt-image-2',
        pollEndpoint: null,
        shortEdge: 1024,
        sizes: { '3:4': '1024x1536', '2:3': '1024x1536', '1:1': '1024x1024', '9:16': '1024x1820', '4:3': '1536x1024', '16:9': '1820x1024' },
        isGptImage: true
    },
    'gpt-image-2/2k': {
        name: 'GPT-img-2 2K', shortName: 'GPT2-2K', price: '0.08',
        endpoint: 'gpt-image-2',
        modelId: 'gpt-image-2',
        pollEndpoint: null,
        shortEdge: 1536,
        sizes: { '3:4': '1536x2048', '2:3': '1536x2048', '1:1': '1536x1536', '9:16': '1536x2730', '4:3': '2048x1536', '16:9': '2730x1536' },
        isGptImage: true
    },
    'gpt-image-2/4k': {
        name: 'GPT-img-2 4K', shortName: 'GPT2-4K', price: '0.16',
        endpoint: 'gpt-image-2',
        modelId: 'gpt-image-2',
        pollEndpoint: null,
        shortEdge: 2048,
        sizes: { '3:4': '2160x2880', '2:3': '2160x3240', '1:1': '2160x2160', '9:16': '2160x3840', '4:3': '2880x2160', '16:9': '3840x2160' },
        isGptImage: true
    }
};

function parseAspectRatio(ratio) {
    if (!ratio || typeof ratio !== 'string' || !ratio.includes(':')) return null;
    const [wStr, hStr] = ratio.split(':');
    const w = parseFloat(wStr);
    const h = parseFloat(hStr);
    if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return null;
    return { w, h };
}

function getOaihkImageSize(model, aspectRatio = '3:4') {
    const ratio = aspectRatio || '3:4';
    // 1) 优先使用模型给出的官方size映射
    if (model?.sizes?.[ratio]) return model.sizes[ratio];
    if (model?.size) return model.size;

    // 2) 未命中映射时，用 shortEdge + 比例动态计算，避免回退到 1K
    const shortEdge = Math.max(512, parseInt(model?.shortEdge || 1024, 10));
    const parsed = parseAspectRatio(ratio);
    if (!parsed) return `${shortEdge}x${shortEdge}`;
    let width;
    let height;
    if (parsed.w >= parsed.h) {
        height = shortEdge;
        width = Math.round((shortEdge * parsed.w) / parsed.h);
    } else {
        width = shortEdge;
        height = Math.round((shortEdge * parsed.h) / parsed.w);
    }
    // 常见图像API对8的倍数更稳定
    width = Math.max(512, Math.round(width / 8) * 8);
    height = Math.max(512, Math.round(height / 8) * 8);
    return `${width}x${height}`;
}

function getOaihkGptQuality(model) {
    return (model?.shortEdge || 1024) >= 1536 ? 'high' : 'low';
}

function announceOaihkSubmit(source, payload) {
    const model = payload?.model || '';
    const size = payload?.size || '';
    const quality = payload?.quality || '';
    const endpoint = payload?.endpoint || '';
    logAction('api', 'OAIHK提交参数', { source, model, size, quality, endpoint });
    // 关键参数直接提示到界面，避免“选了4K但实际提交不是4K”无法感知
    const parts = [`模型:${model}`];
    if (size) parts.push(`尺寸:${size}`);
    if (quality) parts.push(`质量:${quality}`);
    if (endpoint) parts.push(`端点:${endpoint}`);
    showToast(`本次提交 -> ${parts.join(' | ')}`, 'info');
}

// ---------- 图片命名系统 ----------
function getDefaultImagePrefix() {
    const platform = document.getElementById('cfg-api-platform')?.value || 'oaihk';
    const platformShort = platform === 'oaihk' ? 'HK' : 'RH';
    let modelShort = '';
    if (platform === 'oaihk') {
        const modelId = document.getElementById('cfg-oaihk-model-inline')?.value;
        const model = OAIHK_MODELS[modelId];
        modelShort = model?.shortName || 'unknown';
    } else {
        const modelId = document.getElementById('cfg-rh-model-inline')?.value;
        const model = RH_MODELS[modelId];
        modelShort = model?.shortName || 'unknown';
    }
    return `${platformShort}-${modelShort}`;
}

function getEffectiveImagePrefix() {
    const customPrefix = document.getElementById('cfg-image-prefix')?.value?.trim();
    return customPrefix || getDefaultImagePrefix();
}

function formatImageNumber(num, digits = 3) {
    return String(num).padStart(digits, '0');
}

// 平台切换：显示/隐藏对应控件
function togglePlatformUI(platform) {
    const rhModelSelect = document.getElementById('cfg-rh-model-inline');
    const rhPriceTag = document.getElementById('rh-price-tag');
    const rhResolutionGroup = document.getElementById('rh-resolution-group-inline');
    const rhAspectRatioGroup = document.querySelector('#cfg-rh-aspect-ratio-inline')?.parentElement;
    const rhSeedGroup = document.getElementById('cfg-rh-seed-mode-inline')?.parentElement;
    const hkModelSelect = document.getElementById('cfg-oaihk-model-inline');
    const hkPriceTag = document.getElementById('oaihk-price-tag');
    const hkAspectRatioGroup = document.getElementById('oaihk-aspect-ratio-group');

    const isRH = platform === 'runninghub';

    // RH 控件
    if (rhModelSelect) rhModelSelect.style.display = isRH ? '' : 'none';
    if (rhPriceTag) rhPriceTag.style.display = isRH ? '' : 'none';
    if (rhResolutionGroup) rhResolutionGroup.style.display = isRH ? '' : 'none';
    if (rhAspectRatioGroup) rhAspectRatioGroup.style.display = isRH ? '' : 'none';
    if (rhSeedGroup) rhSeedGroup.style.display = isRH ? '' : 'none';

    // HK 控件
    if (hkModelSelect) hkModelSelect.style.display = isRH ? 'none' : '';
    if (hkPriceTag) hkPriceTag.style.display = isRH ? 'none' : '';
    if (hkAspectRatioGroup) hkAspectRatioGroup.style.display = isRH ? 'none' : 'flex';

    // 更新HK价格
    if (!isRH) updateOaihkModelParamsInline();
}

// HK 模型切换时更新价格
function updateOaihkModelParamsInline() {
    const modelSelect = document.getElementById('cfg-oaihk-model-inline');
    const priceTag = document.getElementById('oaihk-price-tag');
    if (!modelSelect) return;
    const model = OAIHK_MODELS[modelSelect.value];
    if (model && priceTag) priceTag.textContent = model.price;
    // GPT-Image 模型隐藏比例选择器（比例已内嵌在模型 sizes 映射中）
    const hkAspectRatioGroup = document.getElementById('oaihk-aspect-ratio-group');
    if (hkAspectRatioGroup) {
        hkAspectRatioGroup.style.display = model?.isGptImage ? 'none' : 'flex';
    }
    updateDefaultModelBadge();
}

// ========== 默认模型 ==========
const DEFAULT_MODEL_KEY = 'defaultModelConfig';

function getDefaultModelConfig() {
    try {
        return JSON.parse(localStorage.getItem(DEFAULT_MODEL_KEY));
    } catch { return null; }
}

function setDefaultModelConfig() {
    const platform = document.getElementById('cfg-api-platform')?.value || 'oaihk';
    const config = {
        platform,
        rhModelId: document.getElementById('cfg-rh-model-inline')?.value || '',
        oaihkModelId: document.getElementById('cfg-oaihk-model-inline')?.value || '',
        rhResolution: document.getElementById('cfg-rh-resolution-inline')?.value || '1k',
        rhAspectRatio: document.getElementById('cfg-rh-aspect-ratio-inline')?.value || '3:4',
        oaihkAspectRatio: document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4'
    };
    localStorage.setItem(DEFAULT_MODEL_KEY, JSON.stringify(config));
    updateDefaultModelBadge();
    showToast('已设为默认模型', 'success');
}

function applyDefaultModelConfig() {
    const config = getDefaultModelConfig();
    if (!config) return false;
    // 设置平台
    const platformSelect = document.getElementById('cfg-api-platform');
    if (platformSelect) platformSelect.value = config.platform;
    togglePlatformUI(config.platform);
    // 设置模型
    if (config.platform === 'runninghub') {
        setSelectValue('cfg-rh-model-inline', config.rhModelId);
        setSelectValue('cfg-rh-resolution-inline', config.rhResolution);
        setSelectValue('cfg-rh-aspect-ratio-inline', config.rhAspectRatio);
        updateRhModelParamsInline();
    } else {
        setSelectValue('cfg-oaihk-model-inline', config.oaihkModelId);
        setSelectValue('cfg-oaihk-aspect-ratio-inline', config.oaihkAspectRatio);
        updateOaihkModelParamsInline();
    }
    return true;
}

function updateDefaultModelBadge() {
    const badge = document.getElementById('default-model-badge');
    if (!badge) return;
    const config = getDefaultModelConfig();
    if (!config) { badge.style.display = 'none'; return; }
    const platform = document.getElementById('cfg-api-platform')?.value || 'oaihk';
    let isMatch = false;
    if (platform === 'runninghub') {
        isMatch = document.getElementById('cfg-rh-model-inline')?.value === config.rhModelId
            && document.getElementById('cfg-rh-resolution-inline')?.value === config.rhResolution
            && document.getElementById('cfg-rh-aspect-ratio-inline')?.value === config.rhAspectRatio;
    } else {
        isMatch = document.getElementById('cfg-oaihk-model-inline')?.value === config.oaihkModelId
            && document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value === config.oaihkAspectRatio;
    }
    badge.style.display = isMatch ? '' : 'none';
}

document.getElementById('btn-set-default-model')?.addEventListener('click', setDefaultModelConfig);

// ========== 拆图模式默认模型 ==========
const SPLIT_DEFAULT_MODEL_KEY = 'splitDefaultModelConfig';

function getSplitDefaultModelConfig() {
    try {
        return JSON.parse(localStorage.getItem(SPLIT_DEFAULT_MODEL_KEY));
    } catch { return null; }
}

function setSplitDefaultModelConfig() {
    const platform = document.getElementById('split-cfg-api-platform')?.value || 'oaihk';
    const config = {
        platform,
        rhModelId: document.getElementById('split-cfg-rh-model')?.value || '',
        oaihkModelId: document.getElementById('split-cfg-oaihk-model')?.value || '',
        rhResolution: document.getElementById('split-cfg-rh-resolution')?.value || '1k',
        rhAspectRatio: document.getElementById('split-cfg-rh-aspect-ratio')?.value || '3:4',
        oaihkAspectRatio: document.getElementById('split-cfg-oaihk-aspect-ratio')?.value || '3:4'
    };
    localStorage.setItem(SPLIT_DEFAULT_MODEL_KEY, JSON.stringify(config));
    updateSplitDefaultModelBadge();
    showToast('已设为拆图默认模型', 'success');
}

function applySplitDefaultModelConfig() {
    const config = getSplitDefaultModelConfig();
    if (!config) return false;
    const platformSelect = document.getElementById('split-cfg-api-platform');
    if (platformSelect) platformSelect.value = config.platform;
    updateSplitApiPlatformUI();
    if (config.platform === 'runninghub') {
        setSelectValue('split-cfg-rh-model', config.rhModelId);
        setSelectValue('split-cfg-rh-resolution', config.rhResolution);
        setSelectValue('split-cfg-rh-aspect-ratio', config.rhAspectRatio);
    } else {
        setSelectValue('split-cfg-oaihk-model', config.oaihkModelId);
        setSelectValue('split-cfg-oaihk-aspect-ratio', config.oaihkAspectRatio);
    }
    updateSplitApiPlatformUI();
    return true;
}

function updateSplitDefaultModelBadge() {
    const badge = document.getElementById('split-default-model-badge');
    if (!badge) return;
    const config = getSplitDefaultModelConfig();
    if (!config) { badge.style.display = 'none'; return; }
    const platform = document.getElementById('split-cfg-api-platform')?.value || 'oaihk';
    let isMatch = false;
    if (platform === 'runninghub') {
        isMatch = document.getElementById('split-cfg-rh-model')?.value === config.rhModelId
            && document.getElementById('split-cfg-rh-resolution')?.value === config.rhResolution
            && document.getElementById('split-cfg-rh-aspect-ratio')?.value === config.rhAspectRatio;
    } else {
        isMatch = document.getElementById('split-cfg-oaihk-model')?.value === config.oaihkModelId
            && document.getElementById('split-cfg-oaihk-aspect-ratio')?.value === config.oaihkAspectRatio;
    }
    badge.style.display = isMatch ? '' : 'none';
}

document.getElementById('btn-split-set-default-model')?.addEventListener('click', setSplitDefaultModelConfig);
document.getElementById('btn-split-settings')?.addEventListener('click', () => {
    document.getElementById('btn-model-config')?.click();
});
document.getElementById('split-cfg-oaihk-model')?.addEventListener('change', () => {
    readSplitApiConfigToQueue(activeSplitQueue);
    applySplitAutoAspectRatioFromCrop(activeSplitQueue);
    updateSplitApiPlatformUI();
    saveSplitQueueData();
});
document.getElementById('split-cfg-rh-model')?.addEventListener('change', () => {
    readSplitApiConfigToQueue(activeSplitQueue);
    const qdRh = splitQueueData[activeSplitQueue];
    syncSplitRhAspectRatioSelectForQueue(qdRh);
    applySplitAutoAspectRatioFromCrop(activeSplitQueue);
    updateSplitApiPlatformUI();
    saveSplitQueueData();
});
document.getElementById('split-cfg-rh-aspect-ratio')?.addEventListener('change', () => {
    const qdM = splitQueueData[activeSplitQueue];
    if (qdM) qdM.splitAspectRatioManualOverride = true;
    readSplitApiConfigToQueue(activeSplitQueue);
    saveSplitQueueData();
});
document.getElementById('split-cfg-oaihk-aspect-ratio')?.addEventListener('change', () => {
    const qdM = splitQueueData[activeSplitQueue];
    if (qdM) qdM.splitAspectRatioManualOverride = true;
    readSplitApiConfigToQueue(activeSplitQueue);
    saveSplitQueueData();
});

document.getElementById('cfg-oaihk-model-inline')?.addEventListener('change', () => {
    updateOaihkModelParamsInline();
    logAction('config', '切换HK模型', { model: document.getElementById('cfg-oaihk-model-inline')?.value });
});

// 平台切换事件
document.getElementById('cfg-api-platform')?.addEventListener('change', (e) => {
    togglePlatformUI(e.target.value);
    // 多图列队模式下，切换平台时自动保存到当前队列配置
    if (queueMode === 'multi') {
        saveCurrentQueueData();
    }
});

// 内联模型切换时自动适配参数
function updateRhModelParamsInline() {
    const modelSelect = document.getElementById('cfg-rh-model-inline');
    const resolutionGroup = document.getElementById('rh-resolution-group-inline');
    const aspectRatioSelect = document.getElementById('cfg-rh-aspect-ratio-inline');
    const priceTag = document.getElementById('rh-price-tag');

    if (!modelSelect) return;
    const modelId = modelSelect.value;
    const model = RH_MODELS[modelId];
    if (!model) return;

    // 价格标签
    if (priceTag) priceTag.textContent = model.price;

    // 显示/隐藏分辨率
    if (resolutionGroup) {
        resolutionGroup.style.display = model.hasResolution ? 'flex' : 'none';
    }

    // 更新宽高比选项
    if (aspectRatioSelect) {
        aspectRatioSelect.innerHTML = '';
        for (const ratio of model.aspectRatios) {
            const opt = document.createElement('option');
            opt.value = ratio;
            opt.textContent = ratio === 'auto' ? '自适应' : ratio;
            aspectRatioSelect.appendChild(opt);
        }
        if (model.aspectRatios.includes('3:4')) {
            aspectRatioSelect.value = '3:4';
        }
    }

    // 同步到配置弹窗
    const configModel = document.getElementById('cfg-rh-model');
    if (configModel) configModel.value = modelId;
}

document.getElementById('cfg-rh-model-inline')?.addEventListener('change', (e) => {
    updateRhModelParamsInline();
    // 持久化内联模型选择到服务端model_config
    const modelId = e.target.value;
    api('PUT', '/api/model-config', { rh_model: modelId, rh_aspect_ratio: document.getElementById('cfg-rh-aspect-ratio-inline')?.value || '3:4' }).catch(() => {});
    state.modelConfig.rh_model = modelId;
    logAction('config', '切换RH模型', { model: modelId });
    if (queueMode === 'multi') saveCurrentQueueData();
});

// 持久化内联宽高比选择
document.getElementById('cfg-rh-aspect-ratio-inline')?.addEventListener('change', (e) => {
    api('PUT', '/api/model-config', { rh_aspect_ratio: e.target.value }).catch(() => {});
    state.modelConfig.rh_aspect_ratio = e.target.value;
    if (queueMode === 'multi') saveCurrentQueueData();
});

// 持久化内联分辨率选择
document.getElementById('cfg-rh-resolution-inline')?.addEventListener('change', (e) => {
    api('PUT', '/api/model-config', { rh_resolution: e.target.value }).catch(() => {});
    state.modelConfig.rh_resolution = e.target.value;
    if (queueMode === 'multi') saveCurrentQueueData();
});

// 持久化内联HK模型选择
document.getElementById('cfg-oaihk-model-inline')?.addEventListener('change', () => {
    const modelId = document.getElementById('cfg-oaihk-model-inline')?.value;
    api('PUT', '/api/model-config', { oaihk_model: modelId }).catch(() => {});
    state.modelConfig.oaihk_model = modelId;
    if (queueMode === 'multi') saveCurrentQueueData();
});

updateRhModelParamsInline();

// 内联种子模式切换
document.getElementById('cfg-rh-seed-mode-inline')?.addEventListener('change', (e) => {
    const seedInput = document.getElementById('cfg-rh-seed-inline');
    seedInput.disabled = e.target.value === 'random';
    if (e.target.value === 'random') seedInput.value = '';
    if (queueMode === 'multi') saveCurrentQueueData();
});

// 多图列队模式下，其他配置变更也自动保存到当前队列
document.getElementById('cfg-oaihk-aspect-ratio-inline')?.addEventListener('change', () => {
    if (queueMode === 'multi') saveCurrentQueueData();
});
document.getElementById('cfg-rh-count-inline')?.addEventListener('change', () => {
    if (queueMode === 'multi') saveCurrentQueueData();
});
document.getElementById('cfg-rh-seed-inline')?.addEventListener('change', () => {
    if (queueMode === 'multi') saveCurrentQueueData();
});

// ⚙设置按钮 → 打开模型配置弹窗
document.getElementById('btn-rh-settings')?.addEventListener('click', () => {
    document.getElementById('btn-model-config')?.click();
});

// 自动备份开关持久化
const autoBackupCheckbox = document.getElementById('cfg-rh-auto-backup');
if (autoBackupCheckbox) {
    // 恢复保存的状态
    try {
        const savedAutoBackup = localStorage.getItem('rh-auto-backup');
        if (savedAutoBackup !== null) autoBackupCheckbox.checked = savedAutoBackup === 'true';
    } catch(e) {}
    autoBackupCheckbox.addEventListener('change', () => {
        try { localStorage.setItem('rh-auto-backup', autoBackupCheckbox.checked); } catch(e) {}
        // 多图队列模式下，同步保存到当前队列
        if (queueMode === 'multi' && queueData[activeQueue]) {
            queueData[activeQueue].autoBackup = autoBackupCheckbox.checked;
            saveQueueData();
        }
    });
}

// 备份路径持久化：输入框修改时保存到model_config和当前队列
const backupPathInput = document.getElementById('cfg-rh-download-path');
if (backupPathInput) {
    backupPathInput.addEventListener('change', async () => {
        try {
            if (queueMode === 'multi' && queueData[activeQueue]) {
                backupPathInput.dataset.downloadPathInherited = '0';
                queueData[activeQueue].downloadPath = cleanDownloadPath(backupPathInput.value);
                saveQueueData();
            } else {
                const path = cleanDownloadPath(backupPathInput.value) || DEFAULT_DOWNLOAD_PATH_FALLBACK;
                backupPathInput.value = path;
                backupPathInput.dataset.downloadPathInherited = '1';
                state.modelConfig.rh_download_path = path;
                await api('PUT', '/api/model-config', { rh_download_path: path });
            }
        } catch(e) { console.error('保存备份路径失败:', e); }
    });
}

// 文件夹选择器按钮：调用后端 AppleScript choose folder 对话框
document.getElementById('btn-select-folder')?.addEventListener('click', async () => {
    try {
        showToast('请在弹出的文件夹选择窗口中选择...', 'info');
        // 传入当前队列的下载路径作为初始目录
        const currentPath = document.getElementById('cfg-rh-download-path')?.value || '';
        const resp = await api('POST', '/api/select-folder', { initial_dir: currentPath });
        if (resp.ok && resp.path) {
            if (queueMode === 'multi' && queueData[activeQueue]) {
                markDownloadPathInputAsOwn('cfg-rh-download-path', resp.path);
                queueData[activeQueue].downloadPath = resp.path;
                saveQueueData();
                showToast(`队列${activeQueue + 1}保存路径已设置: ${resp.path}`, 'success');
            } else {
                const el = document.getElementById('cfg-rh-download-path');
                if (el) {
                    el.value = resp.path;
                    el.dataset.downloadPathInherited = '1';
                }
                state.modelConfig.rh_download_path = resp.path;
                await api('PUT', '/api/model-config', { rh_download_path: resp.path });
                showToast(`默认保存路径已设置: ${resp.path}`, 'success');
            }
        } else if (resp.ok === false && !resp.path) {
            showToast('已取消选择', 'info');
        } else {
            showToast(resp.error || '选择文件夹失败', 'error');
        }
    } catch (e) {
        showToast('选择文件夹失败: ' + e.message, 'error');
    }
});

// 自定义命名前缀持久化
const imagePrefixInput = document.getElementById('cfg-image-prefix');
if (imagePrefixInput) {
    imagePrefixInput.addEventListener('change', async () => {
        try {
            await api('PUT', '/api/model-config', { image_prefix: imagePrefixInput.value.trim() });
            // 多图队列模式下，同步保存到当前队列
            if (queueMode === 'multi' && queueData[activeQueue]) {
                queueData[activeQueue].imagePrefix = imagePrefixInput.value.trim();
                saveQueueData();
            }
        } catch(e) { console.error('保存自定义前缀失败:', e); }
    });
}

// 改写标准按钮 → 打开系统提示词弹窗
document.getElementById('btn-system-prompt-edit')?.addEventListener('click', async () => {
    try {
        const config = await api('GET', '/api/model-config');
        $('#cfg-system-prompt-prompt').value = config.system_prompt_prompt || '';
        $('#cfg-system-prompt-bilingual').value = config.system_prompt_bilingual || '';
        $('#cfg-system-prompt-translate').value = config.system_prompt_translate || '';
        openModal('modal-system-prompt');
    } catch (e) { showToast(e.message, 'error'); }
});

// ---------- API 生成 ----------

document.getElementById('btn-api-generate')?.addEventListener('click', async () => {
    if (apiGenerateState.running) {
        showToast('正在生成中，请等待', 'error');
        return;
    }

    // 获取配置
    const rhApiKey = document.getElementById('cfg-rh-api-key')?.value;
    if (!rhApiKey) { showToast('请先点击⚙设置填写 RunningHub API Key', 'error'); return; }

    const modelId = document.getElementById('cfg-rh-model-inline')?.value;
    const model = RH_MODELS[modelId];
    if (!model) { showToast('请选择模型', 'error'); return; }

    // 获取Prompt（根据语言切换选择中文或英文）
    const promptCn = getFullPromptCn().trim(); // 含前缀+后缀
    const promptEn = document.getElementById('img-prompt-en')?.value?.trim();
    const prompt = apiPromptLang === 'cn' ? promptCn : promptEn;
    if (!prompt) {
        showToast(`请先填写${apiPromptLang === 'cn' ? '中文' : '英文'} Prompt`, 'error');
        return;
    }

    // 获取图片槽中有图片的
    const slotsWithImages = imageState.slots.filter(s => s.image);
    if (model.type === 'image-to-image' && slotsWithImages.length === 0) {
        showToast('图生图模型需要至少一张参考图片', 'error');
        return;
    }

    // 构建请求参数
    const imageUrls = slotsWithImages.map(s => {
        // 如果是相对路径，转为完整URL
        if (s.image.startsWith('/')) return window.location.origin + s.image;
        return s.image;
    });

    const payload = { prompt };
    if (model.type === 'image-to-image') {
        payload.imageUrls = imageUrls;
    }
    if (model.hasResolution) {
        payload.resolution = document.getElementById('cfg-rh-resolution-inline')?.value || '1k';
    }
    // 宽高比
    const aspectRatio = document.getElementById('cfg-rh-aspect-ratio-inline')?.value;
    if (aspectRatio) {
        payload.aspectRatio = aspectRatio;
    }

    const rhBaseUrl = document.getElementById('cfg-rh-base-url')?.value?.trim() || 'https://www.runninghub.cn/openapi/v2';

    apiGenerateState.running = true;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = new AbortController();
    const btn = document.getElementById('btn-api-generate');
    const cancelBtn = document.getElementById('btn-api-cancel');
    btn.disabled = true;
    cancelBtn.style.display = 'inline-flex';
    hideApiRegenerateBtn();
    btn.innerHTML = '<span class="loading"></span> 提交中...';

    try {
        // 通过后端代理提交任务（避免CORS）
        const data = await api('POST', '/api/rh-proxy', {
            action: 'submit',
            api_key: rhApiKey,
            base_url: rhBaseUrl,
            model_id: modelId,
            params: payload
        });

        if (data.status === 'FAILED') {
            throw new Error(data.errorMessage || '任务提交失败');
        }

        apiGenerateState.taskId = data.taskId;
        showToast(`任务已提交，ID: ${data.taskId}，等待生成...`, 'info');
        btn.innerHTML = '<span class="loading"></span> 生成中...';

        // 开始轮询（4.4: 使用指数退避替代固定间隔setInterval）
        _startPollWithBackoff(rhApiKey, rhBaseUrl, 0);

    } catch (e) {
        if (apiGenerateState.cancelled) return; // 已取消，不弹错误
        showToast('API调用失败: ' + e.message, 'error');
        apiGenerateState.running = false;
        apiGenerateState.abortController = null;
        btn.disabled = false;
        btn.textContent = '生成';
        cancelBtn.style.display = 'none';
        showApiRegenerateBtn();
    }
});

async function pollApiResult(apiKey, baseUrl) {
    if (!apiGenerateState.taskId || apiGenerateState.cancelled) return;

    try {
        const data = await api('POST', '/api/rh-proxy', {
            action: 'query',
            api_key: apiKey,
            base_url: baseUrl,
            task_id: apiGenerateState.taskId
        });

        if (apiGenerateState.cancelled) return; // 取消后忽略结果

        if (data.status === 'SUCCESS') {
            // 停止轮询
            clearTimeout(apiGenerateState.pollTimer);
            apiGenerateState.running = false;
            apiGenerateState.taskId = null;
            apiGenerateState.abortController = null;

            const btn = document.getElementById('btn-api-generate');
            const cancelBtn = document.getElementById('btn-api-cancel');
            btn.disabled = false;
            btn.textContent = '生成';
            cancelBtn.style.display = 'none';
            showApiRegenerateBtn();

            // 显示结果
            displayApiResults(data.results || []);
            showToast('生成成功！', 'success');

            // 自动备份到本地
            await autoBackupResults(data.results || []);

        } else if (data.status === 'FAILED') {
            clearTimeout(apiGenerateState.pollTimer);
            apiGenerateState.running = false;
            apiGenerateState.taskId = null;
            apiGenerateState.abortController = null;

            const btn = document.getElementById('btn-api-generate');
            const cancelBtn = document.getElementById('btn-api-cancel');
            btn.disabled = false;
            btn.textContent = '生成';
            cancelBtn.style.display = 'none';
            showApiRegenerateBtn();

            showToast('生成失败: ' + (data.errorMessage || '未知错误'), 'error');
        }
        // RUNNING or QUEUED: 继续轮询
    } catch (e) {
        console.error('轮询失败:', e);
    }
}

function displayApiResults(results) {
    const section = document.getElementById('api-result-section');
    const grid = document.getElementById('api-result-grid');
    if (!section || !grid) return;

    section.style.display = 'block';
    grid.innerHTML = '';

    const newItems = [];
    results.forEach((result, index) => {
        if (!result.url) return;
        const item = { url: result.url, checked: false, filename: `AI生图_${index+1}.${result.outputType || 'png'}`, outputType: result.outputType || 'png' };
        newItems.push(item);
        appendResultCard(item, index);
    });

    if (newItems.length > 0 && queueMode === 'multi') {
        queueData[activeQueue].results = (queueData[activeQueue].results || []).concat(newItems);
        saveQueueData();
    }
}

// ---------- 备份+下载功能 ----------
const DEFAULT_DOWNLOAD_PATH = '~/Downloads/AI生图/';

// 备份单张图片到本地（转JPG），返回本地URL
async function backupImageToLocal(url, filename, downloadPath) {
    const detail = await backupImageToLocalDetailed(url, filename, downloadPath);
    return detail.ok ? detail.localUrl : null;
}

async function backupImageToLocalDetailed(url, filename, downloadPath) {
    try {
        const payload = { url, filename };
        if (downloadPath) payload.download_path = downloadPath;
        const resp = await api('POST', '/api/backup-result-image', payload);
        if (resp.ok && resp.local_url) {
            return { ok: true, localUrl: resp.local_url, error: null };
        }
        console.warn('备份失败:', resp.error);
        return { ok: false, localUrl: null, error: resp.error || '未知错误' };
    } catch (e) {
        console.warn('备份异常:', e);
        return { ok: false, localUrl: null, error: e?.message || '请求异常' };
    }
}

function isGalleryProxyUrl(url) {
    return typeof url === 'string' && url.startsWith('/api/gallery-image?path=');
}

async function ensurePreviewUsesGallery(item, { downloadPath = '', imagePrefix = 'img', save = null, rerender = null } = {}) {
    if (!item || !item.url) return false;
    if (isGalleryProxyUrl(item.url)) return true;
    if (item._ensuringGallery) return false;
    item._ensuringGallery = true;
    try {
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const prefix = (imagePrefix || 'img').trim() || 'img';
        const fallbackName = `${prefix}_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.jpg`;
        const filename = item.filename || fallbackName;
        const detail = await backupImageToLocalDetailed(item.url, filename, downloadPath);
        if (detail.ok && detail.localUrl) {
            item.url = detail.localUrl;
            item.localUrl = detail.localUrl;
            updateDiagEnsureStatus(true, '预览图已自动入图库');
            if (typeof save === 'function') save();
            if (typeof rerender === 'function') rerender();
            return true;
        }
        item._galleryError = detail.error || '入图库失败';
        updateDiagEnsureStatus(false, item._galleryError);
        return false;
    } finally {
        item._ensuringGallery = false;
    }
}

const diagState = {
    galleryApiOk: null,
    splitApiOk: null,
    lastEnsureOk: null,
    lastEnsureMsg: '',
    lastEnsureAt: 0
};

function updateDiagEnsureStatus(ok, msg) {
    diagState.lastEnsureOk = !!ok;
    diagState.lastEnsureMsg = msg || '';
    diagState.lastEnsureAt = Date.now();
    renderDiagStatusBar();
}

function renderDiagStatusBar() {
    const el = document.getElementById('diag-status-text');
    if (!el) return;
    const apiGallery = diagState.galleryApiOk === null ? '⌛' : (diagState.galleryApiOk ? '✅' : '❌');
    const apiSplit = diagState.splitApiOk === null ? '⌛' : (diagState.splitApiOk ? '✅' : '❌');
    let ensurePart = '入库状态: 暂无';
    if (diagState.lastEnsureOk !== null) {
        const t = diagState.lastEnsureAt ? new Date(diagState.lastEnsureAt).toLocaleTimeString() : '';
        ensurePart = `入库状态: ${diagState.lastEnsureOk ? '✅成功' : '❌失败'}${diagState.lastEnsureMsg ? `（${diagState.lastEnsureMsg}）` : ''}${t ? ` @${t}` : ''}`;
    }
    el.textContent = `后端接口 /api/gallery ${apiGallery} | /api/split-queue-data ${apiSplit} | ${ensurePart}`;
}

async function runDiagHealthCheck() {
    try {
        await api('GET', '/api/gallery', null, 12000);
        diagState.galleryApiOk = true;
    } catch (e) {
        diagState.galleryApiOk = false;
    }
    try {
        await api('GET', '/api/split-queue-data', null, 12000);
        diagState.splitApiOk = true;
    } catch (e) {
        diagState.splitApiOk = false;
    }
    renderDiagStatusBar();
}

async function downloadImage(url, filename, downloadPath) {
    try {
        // 先备份到本地，再触发浏览器下载
        const localUrl = await backupImageToLocal(url, filename, downloadPath);
        const downloadUrl = localUrl || url;

        const namePart = filename.replace(/\.\w+$/, '');
        const jpgFilename = namePart + '.jpg';

        // 通过后端转JPG后下载
        const resp = await fetch('/api/convert-download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: downloadUrl, filename: jpgFilename })
        });
        if (!resp.ok) {
            const fallbackResp = await fetch(downloadUrl);
            const blob = await fallbackResp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = jpgFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        } else {
            const blob = await resp.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = jpgFilename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
        }
        showToast(`已下载: ${jpgFilename}`, 'success');
    } catch (e) {
        window.open(url, '_blank');
        showToast('下载失败，已在新窗口打开', 'info');
    }
}

// 自动备份结果图片到本地，替换results中的URL为本地路径
async function autoBackupResults(results, qi) {
    const imagesToBackup = results.filter(r => r.url && !r.url.startsWith('/static/') && !r.url.startsWith('/api/gallery-image'));
    if (imagesToBackup.length === 0) return;

    // 获取当前队列的下载路径
    const currentQi = (qi !== undefined && qi !== null) ? qi : activeQueue;
    const queueDownloadPath = queueMode === 'multi'
        ? getEffectiveQueueDownloadPath(currentQi)
        : (cleanDownloadPath(document.getElementById('cfg-rh-download-path')?.value) || getGlobalDownloadPath());

    let counterStart = 1;
    try {
        const counterResp = await api('POST', '/api/next-image-counter', { count: imagesToBackup.length });
        counterStart = counterResp.start;
    } catch (e) {
        console.error('获取图片计数器失败:', e);
    }

    const prefix = getEffectiveImagePrefix();
    let backupCount = 0;
    let counterIdx = 0;
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.url) continue;
        if (r.url.startsWith('/static/') || r.url.startsWith('/api/gallery-image')) continue;

        const num = formatImageNumber(counterStart + counterIdx);
        const filename = `${prefix}-${num}.jpg`;
        counterIdx++;

        const localUrl = await backupImageToLocal(r.url, filename, queueDownloadPath);
        if (localUrl) {
            r.url = localUrl;
            r.localUrl = localUrl;
            r.filename = filename;
            backupCount++;
        }
    }
    if (backupCount > 0) {
        if (qi !== undefined && qi !== null && queueData[qi]) {
            saveQueueData();
            if (activeQueue === qi) renderQueueResults(qi);
        }
        showToast(`${backupCount}张图片已统一入图库`, 'success');
    }
}

document.getElementById('btn-download-all')?.addEventListener('click', async () => {
    const grid = document.getElementById('api-result-grid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.api-result-card img');
    if (cards.length === 0) { showToast('没有可下载的图片', 'error'); return; }

    let counterStart = 1;
    try {
        const counterResp = await api('POST', '/api/next-image-counter', { count: cards.length });
        counterStart = counterResp.start;
    } catch (e) { console.error('获取图片计数器失败:', e); }

    const prefix = getEffectiveImagePrefix();
    const currentDownloadPath = queueMode === 'multi'
        ? getEffectiveQueueDownloadPath(activeQueue)
        : (cleanDownloadPath(document.getElementById('cfg-rh-download-path')?.value) || getGlobalDownloadPath());
    let count = 0;
    for (const img of cards) {
        const url = img.src;
        const num = formatImageNumber(counterStart + count);
        const filename = `${prefix}-${num}.jpg`;
        await downloadImage(url, filename, currentDownloadPath);
        count++;
        if (count < cards.length) await new Promise(r => setTimeout(r, 1000));
    }
    showToast(`${count}张图片已下载`, 'success');
});

// 预览图大小滑块
document.getElementById('preview-size-slider')?.addEventListener('input', (e) => {
    const size = parseInt(e.target.value, 10) || 140;
    const grid = document.getElementById('api-result-grid');
    if (grid) {
        grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${size}px, 1fr))`;
    }
});

// 下载勾选的图片
document.getElementById('btn-download-checked')?.addEventListener('click', async () => {
    const grid = document.getElementById('api-result-grid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.api-result-card');
    const checkedCards = [];
    cards.forEach(card => {
        const cb = card.querySelector('.result-checkbox');
        if (cb && cb.checked) checkedCards.push(card);
    });
    if (checkedCards.length === 0) { showToast('没有勾选的图片，请先在预览器中勾选或直接勾选结果卡片', 'error'); return; }

    let counterStart = 1;
    try {
        const counterResp = await api('POST', '/api/next-image-counter', { count: checkedCards.length });
        counterStart = counterResp.start;
    } catch (e) { console.error('获取图片计数器失败:', e); }

    const prefix = getEffectiveImagePrefix();
    const currentDownloadPath = queueMode === 'multi'
        ? getEffectiveQueueDownloadPath(activeQueue)
        : (cleanDownloadPath(document.getElementById('cfg-rh-download-path')?.value) || getGlobalDownloadPath());
    let count = 0;
    for (const card of checkedCards) {
        const img = card.querySelector('img');
        if (!img) continue;
        const num = formatImageNumber(counterStart + count);
        const filename = `${prefix}-${num}.jpg`;
        await downloadImage(img.src, filename, currentDownloadPath);
        count++;
        if (count < checkedCards.length) await new Promise(r => setTimeout(r, 1000));
    }
    showToast(`${count}张勾选图片已下载`, 'success');
});

document.getElementById('btn-download-to-folder')?.addEventListener('click', async () => {
    // 浏览器无法选择文件夹，提示用户设置下载路径
    const path = await showPrompt('指定下载文件夹路径', document.getElementById('cfg-rh-download-path')?.value || DEFAULT_DOWNLOAD_PATH, '路径');
    if (path && path.trim()) {
        const cleanPath = path.trim();
        const el = document.getElementById('cfg-rh-download-path');
        if (queueMode === 'multi' && queueData[activeQueue]) {
            markDownloadPathInputAsOwn('cfg-rh-download-path', cleanPath);
            queueData[activeQueue].downloadPath = cleanPath;
            saveQueueData();
        } else {
            if (el) {
                el.value = cleanPath;
                el.dataset.downloadPathInherited = '1';
            }
            state.modelConfig.rh_download_path = cleanPath;
            api('PUT', '/api/model-config', { rh_download_path: cleanPath }).catch(e => console.error('保存下载路径失败:', e));
        }
        showToast('下载路径已更新，后续图片将下载到浏览器默认目录\n如需更改浏览器下载目录，请在浏览器设置中修改', 'info');
        // 触发全部下载
        document.getElementById('btn-download-all')?.click();
    }
});

document.getElementById('btn-open-download-folder')?.addEventListener('click', async () => {
    const downloadPath = queueMode === 'multi'
        ? getEffectiveQueueDownloadPath(activeQueue)
        : (cleanDownloadPath(document.getElementById('cfg-rh-download-path')?.value) || getGlobalDownloadPath());
    try {
        const resp = await api('POST', '/api/open-download-folder', { path: downloadPath });
        if (resp.ok) {
            showToast(`已打开文件夹: ${resp.path}`, 'success');
        } else {
            showToast(resp.error || '打开文件夹失败', 'error');
        }
    } catch (e) {
        showToast('打开文件夹失败: ' + e.message, 'error');
    }
});

// 清除结果按钮
document.getElementById('btn-clear-results')?.addEventListener('click', () => {
    clearCurrentQueueResults();
});

// ========== 大图预览器（滚轮缩放+右键拖动+左右切换+勾选） ==========
let viewerState = {
    images: [],       // [{url, checked, filename}]
    currentIndex: 0,
    img: null,
    offsetX: 0, offsetY: 0,
    scale: 1,
    dragging: false,
    dragStartX: 0, dragStartY: 0,
    dragOffX: 0, dragOffY: 0
};

function openImageViewer(images, startIndex = 0) {
    if (!images || images.length === 0) return;
    viewerState.images = images.map((img, i) => ({
        url: img.url || img,
        checked: img.checked || false,
        filename: img.filename || `AI生图_${i+1}.jpg`
    }));
    viewerState.currentIndex = startIndex || 0;
    viewerState.scale = 1;
    viewerState.offsetX = 0;
    viewerState.offsetY = 0;
    loadViewerImage();
    renderViewerThumbnails();
    openModal('modal-image-viewer');
}

function closeImageViewer() {
    viewerState.dragging = false;
    viewerState.img = null;
    const canvas = document.getElementById('viewer-canvas');
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    closeModal('modal-image-viewer');
}

// 渲染底部缩略图栏
function renderViewerThumbnails() {
    const bar = document.getElementById('viewer-thumbnails');
    if (!bar) return;
    if (viewerState.images.length <= 1) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    bar.innerHTML = '';
    viewerState.images.forEach((img, i) => {
        const el = document.createElement('img');
        el.src = img.url;
        el.dataset.index = i;
        el.title = img.filename;
        el.style.cssText = `height:56px;aspect-ratio:3/4;object-fit:cover;border-radius:3px;cursor:pointer;border:2px solid ${i === viewerState.currentIndex ? '#2563eb' : 'transparent'};opacity:${i === viewerState.currentIndex ? '1' : '0.6'};flex-shrink:0;`;
        el.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(el.dataset.index, 10);
            if (idx !== viewerState.currentIndex) {
                viewerState.currentIndex = idx;
                loadViewerImage();
                renderViewerThumbnails();
            }
        });
        bar.appendChild(el);
    });
    // 滚动当前缩略图到可见
    const activeThumb = bar.querySelector(`img[data-index="${viewerState.currentIndex}"]`);
    if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center' });
}

function loadViewerImage() {
    const img = new Image();
    img.onload = () => {
        viewerState.img = img;
        viewerState.scale = 1;
        viewerState.offsetX = 0;
        viewerState.offsetY = 0;
        drawViewerCanvas();
    };
    img.src = viewerState.images[viewerState.currentIndex].url;
    // 更新UI
    const counter = document.getElementById('viewer-counter');
    if (counter) counter.textContent = `${viewerState.currentIndex + 1}/${viewerState.images.length}`;
    const check = document.getElementById('viewer-check');
    if (check) check.checked = viewerState.images[viewerState.currentIndex].checked;
    const fname = document.getElementById('viewer-filename');
    if (fname) fname.textContent = viewerState.images[viewerState.currentIndex].filename;
}

function drawViewerCanvas() {
    const canvas = document.getElementById('viewer-canvas');
    if (!canvas || !viewerState.img) return;
    const ctx = canvas.getContext('2d');
    // 设置canvas尺寸
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 绘制图片
    const img = viewerState.img;
    const scale = viewerState.scale;
    // 自适应初始缩放
    let fitScale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight) * 0.9;
    let finalScale = fitScale * scale;
    let drawW = img.naturalWidth * finalScale;
    let drawH = img.naturalHeight * finalScale;
    let cx = (canvas.width - drawW) / 2 + viewerState.offsetX;
    let cy = (canvas.height - drawH) / 2 + viewerState.offsetY;
    ctx.drawImage(img, cx, cy, drawW, drawH);
}

// 预览器交互
(function initViewerInteraction() {
    const canvas = document.getElementById('viewer-canvas');
    if (!canvas) return;

    // 滚轮缩放
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        viewerState.scale = Math.max(0.1, Math.min(20, viewerState.scale * delta));
        drawViewerCanvas();
    }, { passive: false });

    // 左键：拖动 or 点击退出（通过移动距离区分）
    let mouseDownPos = null;
    let hasDragged = false;

    canvas.addEventListener('mousedown', (e) => {
        if (e.button === 0 || e.button === 2) {
            mouseDownPos = { x: e.clientX, y: e.clientY };
            hasDragged = false;
            viewerState.dragging = true;
            viewerState.dragStartX = e.clientX;
            viewerState.dragStartY = e.clientY;
            viewerState.dragOffX = viewerState.offsetX;
            viewerState.dragOffY = viewerState.offsetY;
            canvas.style.cursor = 'grabbing';
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!viewerState.dragging) return;
        const dx = e.clientX - viewerState.dragStartX;
        const dy = e.clientY - viewerState.dragStartY;
        // 移动超过5px算拖动
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) hasDragged = true;
        viewerState.offsetX = viewerState.dragOffX + dx;
        viewerState.offsetY = viewerState.dragOffY + dy;
        drawViewerCanvas();
    });

    document.addEventListener('mouseup', (e) => {
        viewerState.dragging = false;
        const c = document.getElementById('viewer-canvas');
        if (c) c.style.cursor = 'grab';
        // 左键点击（非拖动）→ 退出查看器
        if (e.button === 0 && !hasDragged && mouseDownPos) {
            const dx = Math.abs(e.clientX - mouseDownPos.x);
            const dy = Math.abs(e.clientY - mouseDownPos.y);
            if (dx < 5 && dy < 5) {
                closeImageViewer();
            }
        }
        mouseDownPos = null;
    });

    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // 左右切换
    document.getElementById('viewer-prev')?.addEventListener('click', () => {
        if (viewerState.currentIndex > 0) {
            viewerState.currentIndex--;
            loadViewerImage();
            renderViewerThumbnails();
        }
    });
    document.getElementById('viewer-next')?.addEventListener('click', () => {
        if (viewerState.currentIndex < viewerState.images.length - 1) {
            viewerState.currentIndex++;
            loadViewerImage();
            renderViewerThumbnails();
        }
    });

    // 勾选
    document.getElementById('viewer-check')?.addEventListener('change', (e) => {
        if (viewerState.images[viewerState.currentIndex]) {
            viewerState.images[viewerState.currentIndex].checked = e.target.checked;
        }
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
        const viewerVisible = document.getElementById('modal-image-viewer')?.style.display !== 'none';
        // 如果焦点在输入框/文本框中，不拦截
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

        if (viewerVisible) {
            if (e.key === 'ArrowLeft') { document.getElementById('viewer-prev')?.click(); e.preventDefault(); }
            if (e.key === 'ArrowRight') { document.getElementById('viewer-next')?.click(); e.preventDefault(); }
            if (e.key === ' ') {
                const check = document.getElementById('viewer-check');
                if (check) { check.checked = !check.checked; check.dispatchEvent(new Event('change')); }
                e.preventDefault();
            }
        } else {
            // 查看器未打开时，左右键在结果网格中导航
            const section = document.getElementById('api-result-section');
            if (!section || section.style.display === 'none') return;
            const grid = document.getElementById('api-result-grid');
            const cards = grid?.querySelectorAll('.api-result-card');
            if (!cards || cards.length === 0) return;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                // 收集所有结果图片
                const images = [];
                cards.forEach(c => {
                    const img = c.querySelector('img');
                    const cb = c.querySelector('.result-checkbox');
                    images.push({ url: img?.src || '', checked: cb?.checked || false, filename: `AI生图_${images.length+1}.jpg` });
                });
                if (images.length === 0) return;
                // 左键从第一张开始，右键从最后一张开始
                const startIdx = e.key === 'ArrowLeft' ? 0 : images.length - 1;
                openImageViewer(images, startIdx);
                e.preventDefault();
            }
        }
        // Escape键关闭查看器或最上层弹窗
        if (e.key === 'Escape') {
            const viewer = document.getElementById('modal-image-viewer');
            if (viewer && viewer.style.display !== 'none') {
                closeImageViewer();
                e.preventDefault();
            } else {
                // 关闭最上层弹窗
                const modals = document.querySelectorAll('.modal-overlay');
                for (let i = modals.length - 1; i >= 0; i--) {
                    if (modals[i].style.display !== 'none') {
                        modals[i].style.display = 'none';
                        e.preventDefault();
                        break;
                    }
                }
            }
        }
    });
})();

// 替换原有的showImagePreview
function showImagePreview(url) {
    openImageViewer([{ url }]);
}

// ========== 批量生成逻辑 ==========
// 重写API生成按钮，支持张数>1时多次调用
const origApiGenerateHandler = document.getElementById('btn-api-generate')?.onclick;
// 移除原有事件，用新逻辑替换
const apiGenBtn = document.getElementById('btn-api-generate');
if (apiGenBtn && apiGenBtn.parentNode) {
    const newBtn = apiGenBtn.cloneNode(true);
    apiGenBtn.parentNode.replaceChild(newBtn, apiGenBtn);
}

// 多图列队模式：单队列独立生成（异步，不阻塞其他队列）
// 单任务生图核心逻辑（不含UI操作），供 runSingleQueueGenerate 和拆图批量生图复用
// task: { prompt, imageUrls, queueLabel }
// 返回结果数组 [{ url, checked, filename, outputType }, ...]
async function generateSingleTask(qi, task, platform, qd, signal, uiRoundIndex) {
    const qs = queueGenerateStates[qi];
    const results = [];

    try {
        if (platform === 'oaihk') {
            const modelId = qd.oaihkModelId;
            const model = OAIHK_MODELS[modelId];
            const aspectRatio = qd.oaihkAspectRatio || '3:4';
            const shortEdge = model.shortEdge || 1536;

            // 预处理图片
            const publicUrls = [];
            for (const url of task.imageUrls) {
                if (qs.cancelled) break;
                publicUrls.push(await uploadToTmpfiles(url, aspectRatio, shortEdge));
            }
            if (qs.cancelled) return results;

            if (model.isGptImage) {
                announceOaihkSubmit('多图队列-单队列-GPT', {
                    model: model.modelId || 'gpt-image-2',
                    size: getOaihkImageSize(model, aspectRatio),
                    quality: getOaihkGptQuality(model)
                });
                const gptTm = getOaihkGptClientTimeoutMs();
                const gptResp = await api('POST', '/api/oaihk-gpt-image', {
                    action: publicUrls.length > 0 ? 'edits' : 'generations',
                    model: model.modelId || 'gpt-image-2',
                    prompt: task.prompt,
                    size: getOaihkImageSize(model, aspectRatio),
                    quality: getOaihkGptQuality(model),
                    n: 1,
                    image_base64_list: publicUrls
                }, gptTm, signal);
                publicUrls.length = 0;
                if (qs.cancelled) return results;

                if (gptResp.data && Array.isArray(gptResp.data)) {
                    for (const item of gptResp.data) {
                        const displayUrl = await displayUrlFromOaihkGptItem(item, signal);
                        if (!displayUrl) continue;
                        if (!item.b64_json && item.url && displayUrl === item.url) {
                            showToast(`${task.queueLabel}图片下载到本地失败，已使用外网URL`, 'warning');
                        }
                        results.push({ url: displayUrl, checked: false, filename: `AI生图_HK_${task.queueLabel}_${results.length + 1}.jpg`, outputType: 'png' });
                    }
                } else if (gptResp.error) {
                    let friendlyMsg = typeof gptResp.error === 'object' ? gptResp.error.message : gptResp.error;
                    showToast(`${task.queueLabel}生成失败: ${friendlyMsg}`, 'error');
                }
            } else {
                const hkTm = Math.min(Math.max(getOaihkGptClientTimeoutMs(), 120000), 600000);
                const payload = { prompt: task.prompt, image_urls: publicUrls, num_images: 1, aspect_ratio: aspectRatio };
                if (model.modelId) payload.model = model.modelId;

                const submitData = await api('POST', '/api/oaihk-proxy', {
                    action: 'submit', api_key: '', base_url: '', endpoint: model.endpoint, model_id: modelId, params: payload
                }, hkTm, signal);

                if (!submitData.request_id) {
                    showToast(`${task.queueLabel}提交失败: ${submitData.error || '未返回request_id'}`, 'error');
                    return results;
                }

                const result = await pollOAIHK('', '', model.pollEndpoint, submitData.request_id, qi, signal, uiRoundIndex);
                if (qs.cancelled) return results;

                if (result && result.images) {
                    for (const img of result.images) {
                        if (img.url) {
                            let displayUrl = img.url;
                            try {
                                const dlResp = await api('POST', '/api/download-image', { url: img.url }, hkTm, signal);
                                if (dlResp.data?.data_uri) displayUrl = dlResp.data.data_uri;
                            } catch (dlErr) {
                                console.warn('[多图队列-OAIHK] 图片下载失败:', dlErr);
                                showToast(`${task.queueLabel}图片下载到本地失败，已使用外网URL`, 'warning');
                            }
                            results.push({ url: displayUrl, checked: false, filename: `AI生图_HK_${task.queueLabel}_${results.length + 1}.jpg`, outputType: 'png' });
                        }
                    }
                }
            }
        } else {
            // RH通道
            const modelId = qd.rhModelId;
            const model = RH_MODELS[modelId];
            const rhApiKey = document.getElementById('cfg-rh-api-key')?.value || state.modelConfig.rh_api_key || '';
            const rhBaseUrl = document.getElementById('cfg-rh-base-url')?.value?.trim() || state.modelConfig.rh_base_url || 'https://www.runninghub.cn/openapi/v2';

            const payload = { prompt: task.prompt };
            if (model.type === 'image-to-image' && task.imageUrls.length > 0) payload.imageUrls = task.imageUrls;
            if (model.hasResolution) payload.resolution = qd.rhResolution || '1k';
            const aspectRatio = qd.rhAspectRatio;
            if (aspectRatio) payload.aspectRatio = aspectRatio;

            const data = await api('POST', '/api/rh-proxy', {
                action: 'submit', api_key: rhApiKey, base_url: rhBaseUrl, model_id: modelId, params: payload
            }, undefined, signal);

            if (data.status === 'FAILED') {
                showToast(`${task.queueLabel}提交失败: ${data.errorMessage || '未知错误'}`, 'error');
                return results;
            }

                const result = await pollUntilDone(rhApiKey, rhBaseUrl, data.taskId, Date.now(), qi, signal, uiRoundIndex);
            if (qs.cancelled) return results;

            if (result && result.results) {
                for (const r of result.results) {
                    if (r.url) {
                        results.push({ url: r.url, checked: false, filename: `AI生图_${task.queueLabel}_${results.length+1}.${r.outputType || 'png'}`, outputType: r.outputType || 'png' });
                    }
                }
            }
        }
    } catch (e) {
        if (!qs.cancelled) showToast(`${task.queueLabel}生成失败: ${e.message}`, 'error');
    }

    return results;
}

async function runSingleQueueGenerate() {
    pushUndoSnapshot();
    const qi = activeQueue; // 立即捕获当前队列索引，防止异步期间被切换
    const qs = queueGenerateStates[qi];
    if (qs.running) return;

    saveCurrentQueueData(qi); // 传入捕获的索引，确保数据存到正确的队列
    const qd = queueData[qi];
    const platform = qd.apiPlatform || 'runninghub';
    logAction('api', '单队列生图开始', { platform, queue: qi + 1 });

    // 构建任务（从队列数据读取配置）
    const count = qd.rhCount || 1;
    const tasks = [];

    if (platform === 'oaihk') {
        const modelId = qd.oaihkModelId;
        const model = OAIHK_MODELS[modelId];
        if (!model) { showToast('请选择 OpenAI-HK 模型', 'error'); return; }
        const promptLang = qd.promptLang || 'en';
        const prompt = promptLang === 'cn' ? (qd?.promptCn?.trim()) : (qd?.promptEn?.trim());
        const images = qd ? qd.slots.filter(s => s.image) : [];
        if (!prompt || images.length === 0) {
            showToast(`队列${qi+1}没有有效的Prompt或图片`, 'error'); return;
        }
        const imageUrls = images.map(s => s.image);
        for (let i = 0; i < count; i++) {
            tasks.push({ prompt, imageUrls, queueLabel: count > 1 ? `队列${qi+1} 第${i+1}张` : `队列${qi+1}` });
        }
    } else {
        const modelId = qd.rhModelId;
        const model = RH_MODELS[modelId];
        if (!model) { showToast('请选择模型', 'error'); return; }
        const promptLang = qd.promptLang || 'en';
        const prompt = promptLang === 'cn' ? (qd?.promptCn?.trim() || qd?.promptEn?.trim()) : (qd?.promptEn?.trim() || qd?.promptCn?.trim());
        const images = qd ? qd.slots.filter(s => s.image) : [];
        if (!prompt || (model.type === 'image-to-image' && images.length === 0)) {
            showToast(`队列${qi+1}没有有效的Prompt或图片`, 'error'); return;
        }
        const imageUrls = images.map(s => {
            if (s.image.startsWith('/')) return window.location.origin + s.image;
            return s.image;
        });
        for (let i = 0; i < count; i++) {
            tasks.push({ prompt, imageUrls, queueLabel: count > 1 ? `队列${qi+1} 第${i+1}张` : `队列${qi+1}` });
        }
    }

    // 设置队列生成状态
    qs.running = true;
    qs.cancelled = false;
    qs.abortController = new AbortController();
    const queueSignal = qs.abortController.signal;

    const btn = document.getElementById('btn-api-generate');
    const cancelBtn = document.getElementById('btn-api-cancel');
    if (activeQueue === qi) {
        btn.innerHTML = `<span class="loading"></span> 队列${qi+1}生成中...`;
        setApiProgress(5);
    }
    cancelBtn.style.display = 'inline-flex';
    // 刷新队列按钮状态（显示生成指示器）
    renderQueueNumberBars();

    // 如果当前显示的是这个队列的结果区，清空并显示占位
    const allResults = [];
    if (activeQueue === qi) {
        const resultGrid = document.getElementById('api-result-grid');
        if (resultGrid) renderApiResultPendingSlots(resultGrid, tasks.length);
    }

    const prevResultLen = (queueData[qi].results || []).length;

    const buckets = Array.from({ length: tasks.length }, () => []);
    await Promise.allSettled(tasks.map((task, round) => (async () => {
        if (qs.cancelled) return;
        buckets[round] = await generateSingleTask(qi, task, platform, qd, queueSignal, round);
        if (activeQueue === qi) {
            btn.innerHTML = `<span class="loading"></span> 队列${qi + 1}（并行 ${tasks.length} 张）`;
            setApiProgress(Math.min(92, Math.round(((round + 1) / tasks.length) * 40)));
        }
    })()));

    for (let round = 0; round < tasks.length; round++) {
        if (qs.cancelled) break;
        const taskResults = buckets[round] || [];
        let imgIdx = 0;
        for (const tr of taskResults) {
            allResults.push(tr);
            if (activeQueue === qi) {
                const idx = prevResultLen + allResults.length - 1;
                appendResultCard(tr, idx, imgIdx === 0 ? { slotIndex: round } : {});
            }
            imgIdx++;
        }
    }

    // 重置状态
    qs.running = false;
    qs.cancelled = false;
    qs.abortController = null;
    apiGenerateState.running = isAnyQueueGenerating();

    // 存储结果到队列（追加模式：新生成的图片排在已有结果后面）
    if (allResults.length > 0) {
        queueData[qi].results = (queueData[qi].results || []).concat(allResults);
        saveQueueData();
        // 如果当前显示的是这个队列，渲染结果
        if (activeQueue === qi) {
            renderQueueResults(qi);
        }
        logAction('api', '单队列生图完成', { queue: qi + 1, count: allResults.length });
        showToast(`队列${qi+1}生成完成！共${allResults.length}张`, 'success');
        await autoBackupResults(allResults, queueMode === 'multi' ? qi : undefined);
    }

    // 更新UI
    if (activeQueue === qi) {
        btn.disabled = false;
        updateGenerateBtnText();
        hideApiProgress();
    }
    // 如果没有其他队列在生成，隐藏取消按钮和进度条
    if (!queueGenerateStates.some(s => s.running)) {
        cancelBtn.style.display = 'none';
        hideApiProgress();
    }
    clearRemainingApiResultPendingSlots(document.getElementById('api-result-grid'));
    if (activeQueue === qi && allResults.length === 0) {
        restoreApiResultEmptyPlaceholderIfNeeded();
    }
    // 刷新队列按钮状态（移除生成指示器）
    renderQueueNumberBars();
}

document.getElementById('btn-api-generate')?.addEventListener('click', async () => {
    // 多图列队模式下，只检查当前队列是否正在生成（允许其他队列并行）
    if (queueMode === 'multi') {
        if (queueGenerateStates[activeQueue].running) {
            showToast(`队列${activeQueue+1}正在生成中`, 'error');
            return;
        }
        runSingleQueueGenerate();
        return;
    }

    // 平台分支：OpenAI-HK 走独立函数
    const platform = document.getElementById('cfg-api-platform')?.value || 'runninghub';
    logAction('api', 'API生图开始', { platform });
    if (platform === 'oaihk') {
        await generateViaOpenAIHK();
        return;
    }

    // 优先从state.modelConfig读取API Key（用户可能没打开过配置弹窗）
    const rhApiKey = document.getElementById('cfg-rh-api-key')?.value || state.modelConfig.rh_api_key || '';
    if (!rhApiKey) { showToast('请先点击⚙设置填写 RunningHub API Key', 'error'); return; }

    const modelId = document.getElementById('cfg-rh-model-inline')?.value;
    const model = RH_MODELS[modelId];
    if (!model) { showToast('请选择模型', 'error'); return; }

    const rhBaseUrl = document.getElementById('cfg-rh-base-url')?.value?.trim() || state.modelConfig.rh_base_url || 'https://www.runninghub.cn/openapi/v2';
    const count = parseInt(document.getElementById('cfg-rh-count-inline')?.value, 10) || 1;

    // 构建生成任务列表
    const tasks = []; // [{ prompt, imageUrls }]

    if (queueMode === 'multi') {
        saveCurrentQueueData();
        // 单组生成：只生成当前选中队列，张数随便填
        const qd = queueData[activeQueue];
        const prompt = qd?.promptEn?.trim();
        const images = qd ? qd.slots.filter(s => s.image) : [];
        if (!prompt || (model.type === 'image-to-image' && images.length === 0)) {
            showToast(`队列${activeQueue+1}没有有效的英文Prompt或图片`, 'error');
            return;
        }
        const imageUrls = images.map(s => {
            if (s.image.startsWith('/')) return window.location.origin + s.image;
            return s.image;
        });
        for (let i = 0; i < count; i++) {
            tasks.push({ prompt, imageUrls, queueLabel: count > 1 ? `队列${activeQueue+1} 第${i+1}张` : `队列${activeQueue+1}` });
        }
    } else {
        // 同图抽卡模式：同一组数据生成N张
        const promptEn = document.getElementById('img-prompt-en')?.value?.trim();
        if (!promptEn) { showToast('请先生成英文 Prompt', 'error'); return; }
        const slotsWithImages = imageState.slots.filter(s => s.image);
        if (model.type === 'image-to-image' && slotsWithImages.length === 0) {
            showToast('图生图模型需要至少一张参考图片', 'error');
            return;
        }
        const imageUrls = slotsWithImages.map(s => {
            if (s.image.startsWith('/')) return window.location.origin + s.image;
            return s.image;
        });
        for (let i = 0; i < count; i++) {
            tasks.push({ prompt: promptEn, imageUrls, queueLabel: `第${i+1}张` });
        }
    }

    apiGenerateState.running = true;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = new AbortController();
    const btn = document.getElementById('btn-api-generate');
    const cancelBtn = document.getElementById('btn-api-cancel');
    btn.disabled = true;
    cancelBtn.style.display = 'inline-flex';
    hideApiRegenerateBtn();

    // 清空结果区并显示本轮张数占位卡片
    const allResults = [];
    const resultGrid = document.getElementById('api-result-grid');
    if (resultGrid) renderApiResultPendingSlots(resultGrid, tasks.length);
    setApiProgress(5);

    const rhStartTime = Date.now();

    for (let round = 0; round < tasks.length; round++) {
        if (apiGenerateState.cancelled) {
            showToast(`已取消，已完成${round}张`, 'info');
            break;
        }
        const task = tasks[round];
        btn.innerHTML = `<span class="loading"></span> ${round+1}/${tasks.length}`;

        const payload = { prompt: task.prompt };
        if (model.type === 'image-to-image' && task.imageUrls.length > 0) payload.imageUrls = task.imageUrls;
        if (model.hasResolution) payload.resolution = document.getElementById('cfg-rh-resolution-inline')?.value || '1k';
        const aspectRatio = document.getElementById('cfg-rh-aspect-ratio-inline')?.value;
        if (aspectRatio) payload.aspectRatio = aspectRatio;

        try {
            const data = await api('POST', '/api/rh-proxy', {
                action: 'submit',
                api_key: rhApiKey,
                base_url: rhBaseUrl,
                model_id: modelId,
                params: payload
            });

            if (data.status === 'FAILED') {
                showToast(`${task.queueLabel}提交失败: ${data.errorMessage || '未知错误'}`, 'error');
                markApiResultPendingSlotFailed(resultGrid, round, '提交失败');
                continue;
            }

            // 提交成功，开始轮询
            setApiProgress(10);
            setApiResultPendingSlotStatus(resultGrid, round, '<span class="loading" style="display:inline-block;"></span> 已提交，等待绘制…');

            // 轮询等待结果
            const result = await pollUntilDone(rhApiKey, rhBaseUrl, data.taskId, rhStartTime, undefined, undefined, round);
            if (apiGenerateState.cancelled) break;
            let rhImgIdx = 0;
            if (result && result.results) {
                setApiProgress(100);
                for (const r of result.results) {
                    if (r.url) {
                        const item = { url: r.url, checked: false, filename: `AI生图_${allResults.length+1}.${r.outputType || 'png'}`, outputType: r.outputType || 'png' };
                        allResults.push(item);
                        appendResultCard(item, allResults.length - 1, rhImgIdx === 0 ? { slotIndex: round } : {});
                        rhImgIdx++;
                    }
                }
            }
            if (rhImgIdx === 0 && !apiGenerateState.cancelled) {
                markApiResultPendingSlotFailed(resultGrid, round, '未返图');
            }
        } catch (e) {
            if (apiGenerateState.cancelled) break;
            showToast(`${task.queueLabel}生成失败: ${e.message}`, 'error');
            markApiResultPendingSlotFailed(resultGrid, round, e.message.length > 120 ? `${e.message.slice(0, 118)}…` : e.message);
        }
    }

    apiGenerateState.running = false;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = null;
    btn.disabled = false;
    btn.textContent = '生成';
    cancelBtn.style.display = 'none';
    showApiRegenerateBtn();
    hideApiProgress();

    clearRemainingApiResultPendingSlots(resultGrid);
    if (allResults.length > 0) {
        logAction('api', 'RH生图完成', { count: allResults.length });
        showToast(`生成完成！共${allResults.length}张`, 'success');
        // 多图列队模式下，将结果追加到当前队列
        if (queueMode === 'multi') {
            queueData[activeQueue].results = (queueData[activeQueue].results || []).concat(allResults);
            saveQueueData();
            renderQueueResults(activeQueue);
        }
        // 统一入图库
        await autoBackupResults(allResults, queueMode === 'multi' ? activeQueue : undefined);
    } else {
        restoreApiResultEmptyPlaceholderIfNeeded();
    }
});

// 轮询直到完成
async function pollUntilDone(apiKey, baseUrl, taskId, startTime = Date.now(), qi, signal, statusSlotIndex) {
    const maxPolls = 120; // 最多轮询120次（6分钟）
    const isCancelled = () => qi !== undefined ? queueGenerateStates[qi]?.cancelled : apiGenerateState.cancelled;
    for (let i = 0; i < maxPolls; i++) {
        if (isCancelled()) return null;
        await new Promise(r => setTimeout(r, 3000));
        if (isCancelled()) return null;
        // 更新进度和状态文本
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (statusSlotIndex !== undefined && statusSlotIndex !== null) {
            const apiGrid = document.getElementById('api-result-grid');
            if (apiGrid?.querySelector(`.api-result-pending-card[data-slot-index="${statusSlotIndex}"]`)) {
                setApiResultPendingSlotStatus(apiGrid, statusSlotIndex,
                    `<span class="loading" style="display:inline-block;"></span> 正在绘制中… (${elapsed}秒，第${i + 1}次查询)`);
            }
        } else {
            const ph = document.getElementById(`api-generating-placeholder-queue${qi}`) || document.getElementById('api-generating-placeholder');
            if (ph) ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在绘制中... (${elapsed}秒，第${i+1}次查询)`;
        }
        if (activeQueue === qi) setApiProgress(10 + 80 * ((i + 1) / maxPolls));
        try {
            const data = await api('POST', '/api/rh-proxy', {
                action: 'query',
                api_key: apiKey,
                base_url: baseUrl,
                task_id: taskId
            }, undefined, signal);
            if (data.status === 'SUCCESS') return data;
            if (data.status === 'FAILED') {
                showToast('生成失败: ' + (data.errorMessage || '未知错误'), 'error');
                return null;
            }
        } catch (e) {
            if (isCancelled()) return null;
            console.warn('轮询出错:', e);
        }
    }
    if (!isCancelled()) showToast('生成超时', 'error');
    return null;
}

// 取消按钮
document.getElementById('btn-api-cancel')?.addEventListener('click', () => {
    logAction('api', '取消生成', {});

    if (queueMode === 'multi') {
        // 批量生成取消
        if (apiGenerateState.running) {
            apiGenerateState.cancelled = true;
            apiGenerateState.abortController?.abort();
        }
        // 取消所有正在生成的队列
        for (let qi = 0; qi < QUEUE_COUNT; qi++) {
            const qs = queueGenerateStates[qi];
            if (qs.running) {
                qs.cancelled = true;
                if (qs.abortController) {
                    qs.abortController.abort();
                }
            }
        }
        // 更新UI
        const btn = document.getElementById('btn-api-generate');
        if (btn) { btn.disabled = false; updateGenerateBtnText(); }
        const cancelBtn = document.getElementById('btn-api-cancel');
        if (cancelBtn) cancelBtn.style.display = 'none';
        // 移除所有队列的生成中占位
        for (let qi2 = 0; qi2 < QUEUE_COUNT; qi2++) {
            const placeholder = document.getElementById(`api-generating-placeholder-queue${qi2}`);
            if (placeholder) placeholder.remove();
        }
        const batchPlaceholder = document.getElementById('api-generating-placeholder');
        if (batchPlaceholder) batchPlaceholder.remove();
        clearRemainingApiResultPendingSlots(document.getElementById('api-result-grid'));
        hideApiProgress();
        renderQueueNumberBars();
        if (queueMode === 'multi') renderQueueResults(activeQueue);
        showToast('已取消所有正在生成的队列', 'info');
    } else {
        // 同图抽卡模式：取消全局状态
        if (apiGenerateState.running) {
            apiGenerateState.cancelled = true;
            if (apiGenerateState.abortController) {
                apiGenerateState.abortController.abort();
                apiGenerateState.abortController = null;
            }
            if (apiGenerateState.pollTimer) {
                clearTimeout(apiGenerateState.pollTimer);
                apiGenerateState.pollTimer = null;
            }
            apiGenerateState.running = false;
            apiGenerateState.taskId = null;
        }
        // 重置UI
        const btn = document.getElementById('btn-api-generate');
        const cancelBtn = document.getElementById('btn-api-cancel');
        if (btn) { btn.disabled = false; updateGenerateBtnText(); }
        if (cancelBtn) cancelBtn.style.display = 'none';
        showApiRegenerateBtn();
        // 移除生成中占位
        const placeholder = document.getElementById('api-generating-placeholder');
        if (placeholder) placeholder.remove();
        clearRemainingApiResultPendingSlots(document.getElementById('api-result-grid'));
        // 如果结果区为空，恢复空白占位
        const resultGrid = document.getElementById('api-result-grid');
        if (resultGrid && !resultGrid.querySelector('.api-result-card')) {
            resultGrid.innerHTML = `<div id="api-result-placeholder" style="grid-column:1/-1;text-align:center;padding:30px 0;color:var(--text-muted);font-size:11px;">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.2" style="opacity:0.4;margin-bottom:8px;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                    <div>选择模型后点击「API生成」开始</div>
                </div>`;
        }
        hideApiProgress();
        showToast('已取消生成', 'info');
    }
});

// ========== OpenAI-HK 通道：图床上传 + 生图 + 轮询 ==========

// 再生成一次按钮
document.getElementById('btn-api-regenerate')?.addEventListener('click', () => {
    logAction('api', '再生成一次', {});
    document.getElementById('btn-api-generate')?.click();
});

function showApiRegenerateBtn() {
    const btn = document.getElementById('btn-api-regenerate');
    if (btn) btn.style.display = 'inline-flex';
}
function hideApiRegenerateBtn() {
    const btn = document.getElementById('btn-api-regenerate');
    if (btn) btn.style.display = 'none';
}

// ========== API 生成进度条 ==========
function setApiProgress(percent) {
    const wrap = document.getElementById('api-progress-bar-wrap');
    const bar = document.getElementById('api-progress-bar');
    if (!wrap || !bar) return;
    wrap.style.display = 'block';
    bar.style.width = Math.min(100, Math.max(0, percent)) + '%';
}
function hideApiProgress() {
    const wrap = document.getElementById('api-progress-bar-wrap');
    const bar = document.getElementById('api-progress-bar');
    if (wrap) wrap.style.display = 'none';
    if (bar) bar.style.width = '0%';
}

// 将本地图片裁剪后转为 base64 data URI（上传时已压缩，此处仅裁剪+编码）
async function uploadToTmpfiles(localUrl, aspectRatio = '3:4', shortEdge = 0) {
    // 如果已经是公网URL，直接返回
    if (localUrl.startsWith('http://') || localUrl.startsWith('https://')) {
        return localUrl;
    }
    // 如果已经是 base64 data URI，直接返回
    if (localUrl.startsWith('data:')) {
        return localUrl;
    }

    logAction('api', '图片预处理开始', { url: localUrl, aspectRatio, shortEdge });

    // 通过后端处理：按比例裁剪 → 按模型短边缩放 → base64（大图多队列并行时适当拉长超时）
    const resp = await api('POST', '/api/preprocess-to-base64', {
        local_url: localUrl,
        aspect_ratio: aspectRatio,
        short_edge: shortEdge
    }, 180000);

    if (!resp.data?.data_uri) {
        const errMsg = resp.error || '图片预处理失败';
        logAction('error', '图片预处理失败', { url: localUrl, error: errMsg });
        throw new Error(errMsg);
    }

    logAction('api', '图片预处理完成', { sizeKb: resp.data.size_kb });
    return resp.data.data_uri;
}

// OpenAI-HK 轮询直到完成
async function pollOAIHK(apiKey, baseUrl, pollEndpoint, requestId, qi, signal, statusSlotIndex) {
    const maxPolls = 120; // 最多轮询120次（6分钟）
    const isCancelled = () => qi !== undefined ? queueGenerateStates[qi]?.cancelled : apiGenerateState.cancelled;
    let queueCount = 0;
    for (let i = 0; i < maxPolls; i++) {
        if (isCancelled()) return null;
        await new Promise(r => setTimeout(r, 3000));
        if (isCancelled()) return null;
        const ph = document.getElementById(`api-generating-placeholder-queue${qi}`) || document.getElementById('api-generating-placeholder');
        const elapsed = Math.round((i + 1) * 3);
        const pendingStatusEl = statusSlotIndex !== undefined && statusSlotIndex !== null
            ? document.getElementById('api-result-grid')?.querySelector(`.api-result-pending-card[data-slot-index="${statusSlotIndex}"] .api-result-pending-status`)
            : null;
        if (activeQueue === qi) setApiProgress(40 + Math.min(55, 30 * Math.log10(i + 1)));
        try {
            const data = await api('POST', '/api/oaihk-proxy', {
                action: 'poll',
                api_key: apiKey,
                base_url: baseUrl,
                poll_endpoint: pollEndpoint,
                request_id: requestId
            }, undefined, signal);
            if (data.images && data.images.length > 0) return data;
            if (data.status === 'FAILED') {
                showToast('生成失败: ' + (data.error || '未知错误'), 'error');
                return null;
            }
            if (data.status === 'IN_QUEUE') {
                queueCount++;
                const extra = queueCount > 10 ? '<br><span style="font-size:10px;color:#e67e22;">排队较久，API服务器可能繁忙，请耐心等待或取消重试</span>' : '';
                if (pendingStatusEl) {
                    pendingStatusEl.innerHTML = `<span class="loading" style="display:inline-block;"></span> 排队等待中...（已等${elapsed}秒，第${i+1}次查询）${extra}`;
                } else if (ph) {
                    ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 排队等待中...（已等${elapsed}秒，第${i+1}次查询）${extra}`;
                }
            } else {
                if (pendingStatusEl) {
                    pendingStatusEl.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在绘制中...（${elapsed}秒，第${i+1}次查询）`;
                } else if (ph) {
                    ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在绘制中...（${elapsed}秒，第${i+1}次查询）`;
                }
            }
        } catch (e) {
            if (isCancelled()) return null;
            console.warn('OpenAI-HK 轮询出错:', e);
        }
    }
    if (!isCancelled()) showToast('OpenAI-HK 生成超时（排队过久），建议稍后重试', 'error');
    return null;
}

// OpenAI-HK 通道：核心生图函数
async function generateViaOpenAIHK() {
    pushUndoSnapshot();
    const oaihkApiKey = document.getElementById('cfg-oaihk-api-key')?.value || state.modelConfig.oaihk_api_key || '';
    if (!oaihkApiKey) { showToast('请先点击⚙设置填写 OpenAI-HK API Key', 'error'); return; }

    const oaihkBaseUrl = document.getElementById('cfg-oaihk-base-url')?.value?.trim() || state.modelConfig.oaihk_base_url || 'https://api.openai-hk.com';
    const modelId = document.getElementById('cfg-oaihk-model-inline')?.value;
    const model = OAIHK_MODELS[modelId];
    if (!model) { showToast('请选择 OpenAI-HK 模型', 'error'); return; }

    const count = parseInt(document.getElementById('cfg-rh-count-inline')?.value, 10) || 1;

    // 构建任务列表（复用 queueMode 逻辑）
    const tasks = []; // [{ prompt, imageUrls }]

    if (queueMode === 'multi') {
        saveCurrentQueueData();
        // 单组生成：只生成当前选中队列，张数随便填
        const qd = queueData[activeQueue];
        const prompt = apiPromptLang === 'cn' ? (qd?.promptCn?.trim()) : (qd?.promptEn?.trim());
        const images = qd ? qd.slots.filter(s => s.image) : [];
        if (!prompt || images.length === 0) {
            showToast(`队列${activeQueue+1}没有有效的${apiPromptLang === 'cn' ? '中文' : '英文'}Prompt或图片`, 'error');
            return;
        }
        const imageUrls = images.map(s => s.image);
        for (let i = 0; i < count; i++) {
            tasks.push({ prompt, imageUrls, queueLabel: count > 1 ? `队列${activeQueue+1} 第${i+1}张` : `队列${activeQueue+1}` });
        }
    } else {
        // 根据语言切换选择中文或英文提示词
        const promptCn = getFullPromptCn().trim(); // 含前缀+后缀
        const promptEn = document.getElementById('img-prompt-en')?.value?.trim();
        const prompt = apiPromptLang === 'cn' ? promptCn : promptEn;
        if (!prompt) {
            showToast(`请先填写${apiPromptLang === 'cn' ? '中文' : '英文'} Prompt`, 'error');
            return;
        }
        const slotsWithImages = imageState.slots.filter(s => s.image);
        if (slotsWithImages.length === 0) {
            showToast('OpenAI-HK 通道需要至少一张参考图片', 'error');
            return;
        }
        const imageUrls = slotsWithImages.map(s => s.image);
        for (let i = 0; i < count; i++) {
            tasks.push({ prompt, imageUrls, queueLabel: `第${i+1}张` });
        }
    }

    apiGenerateState.running = true;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = new AbortController();
    const btn = document.getElementById('btn-api-generate');
    const cancelBtn = document.getElementById('btn-api-cancel');
    btn.disabled = true;
    cancelBtn.style.display = 'inline-flex';
    hideApiRegenerateBtn();

    const allResults = [];
    const resultGrid = document.getElementById('api-result-grid');
    if (resultGrid) renderApiResultPendingSlots(resultGrid, tasks.length);

    const aspectRatio = document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4';
    const shortEdge = model.shortEdge || 1536;
    const gptTimeoutMs = getOaihkGptClientTimeoutMs();
    const hkSubmitTimeoutMs = Math.min(Math.max(gptTimeoutMs, 120000), 600000);
    _hkParallelUiTail = Promise.resolve();
    let hkParallelFinished = 0;

    const pushHKRoundResultsToUi = (round, produced) => {
        enqueueHKParallelResultUi(async () => {
            let imgIx = 0;
            for (const result of produced) {
                allResults.push(result);
                appendResultCard(result, allResults.length - 1, imgIx === 0 ? { slotIndex: round } : {});
                imgIx++;
            }
        });
    };

    await Promise.allSettled(tasks.map((task, round) => (async () => {
        const produced = [];
        try {
            if (apiGenerateState.cancelled) return;

            setApiProgress(5);
            const publicUrls = [];
            for (let j = 0; j < task.imageUrls.length; j++) {
                if (apiGenerateState.cancelled) return;
                setApiResultPendingSlotStatus(resultGrid, round, `<span class="loading" style="display:inline-block;"></span> 压缩图片 (${j + 1}/${task.imageUrls.length})`);
                const publicUrl = await uploadToTmpfiles(task.imageUrls[j], aspectRatio, shortEdge);
                publicUrls.push(publicUrl);
            }
            if (apiGenerateState.cancelled) return;

            setApiProgress(25);

            if (model.isGptImage) {
                setApiResultPendingSlotStatus(resultGrid, round, '<span class="loading" style="display:inline-block;"></span> GPT生图中…');

                logAction('api', 'GPT-img提交生图', { model: modelId, images: publicUrls.length, promptLen: task.prompt.length });
                announceOaihkSubmit('图生图-GPT', {
                    model: model.modelId || 'gpt-image-2',
                    size: getOaihkImageSize(model, aspectRatio),
                    quality: getOaihkGptQuality(model)
                });

                const gptResp = await api('POST', '/api/oaihk-gpt-image', {
                    action: publicUrls.length > 0 ? 'edits' : 'generations',
                    model: model.modelId || 'gpt-image-2',
                    prompt: task.prompt,
                    size: getOaihkImageSize(model, aspectRatio),
                    quality: getOaihkGptQuality(model),
                    n: 1,
                    image_base64_list: publicUrls
                }, gptTimeoutMs, apiGenerateState.abortController?.signal);

                publicUrls.length = 0;

                if (apiGenerateState.cancelled) return;

                if (gptResp.data && Array.isArray(gptResp.data)) {
                    let gptImgIdx = 0;
                    for (const item of gptResp.data) {
                        const displayUrl = await displayUrlFromOaihkGptItem(item, apiGenerateState.abortController?.signal);
                        if (!displayUrl) continue;
                        produced.push({
                            url: displayUrl,
                            checked: false,
                            filename: `AI生图_HK_${round + 1}_${gptImgIdx + 1}.jpg`,
                            outputType: 'png'
                        });
                        gptImgIdx++;
                    }
                    pushHKRoundResultsToUi(round, produced);
                } else if (gptResp.error) {
                    let friendlyMsg = gptResp.error;
                    if (typeof gptResp.error === 'object' && gptResp.error.message) friendlyMsg = gptResp.error.message;
                    showToast(`${task.queueLabel}生成失败: ${friendlyMsg}`, 'error');
                    markApiResultPendingSlotFailed(resultGrid, round, typeof friendlyMsg === 'string' && friendlyMsg.length > 120 ? `${friendlyMsg.slice(0, 118)}…` : String(friendlyMsg || '失败'));
                }
            } else {
                setApiResultPendingSlotStatus(resultGrid, round, '<span class="loading" style="display:inline-block;"></span> 加密传输（Base64）…');

                const payload = {
                    prompt: task.prompt,
                    image_urls: publicUrls,
                    num_images: 1,
                    aspect_ratio: aspectRatio
                };
                if (model.modelId) {
                    payload.model = model.modelId;
                }

                logAction('api', 'HK提交生图', { model: modelId, aspectRatio, images: publicUrls.length, promptLen: task.prompt.length });

                const submitData = await api('POST', '/api/oaihk-proxy', {
                    action: 'submit',
                    api_key: oaihkApiKey,
                    base_url: oaihkBaseUrl,
                    endpoint: model.endpoint,
                    model_id: modelId,
                    params: payload
                }, hkSubmitTimeoutMs, apiGenerateState.abortController?.signal);

                publicUrls.length = 0;

                const requestId = submitData.request_id;
                if (!requestId) {
                    const errMsg = submitData.error || '未返回request_id';
                    let friendlyMsg = errMsg;
                    if (errMsg.includes('已禁用') || errMsg.includes('428')) {
                        friendlyMsg = '模型已被禁用(428)，请稍后重试或联系OpenAI-HK客服';
                    } else if (errMsg.includes('无可用渠道') || errMsg.includes('503')) {
                        friendlyMsg = 'API渠道暂不可用(503)，请稍后重试或检查API Key/余额';
                    }
                    showToast(`${task.queueLabel}提交失败: ${friendlyMsg}`, 'error');
                    markApiResultPendingSlotFailed(resultGrid, round, friendlyMsg.length > 120 ? `${friendlyMsg.slice(0, 118)}…` : friendlyMsg);
                    return;
                }

                setApiResultPendingSlotStatus(resultGrid, round, `<span class="loading" style="display:inline-block;"></span> 等待云端（任务 ${requestId.slice(0, 8)}…）<br><span style="font-size:10px;">约每 3 秒查询</span>`);

                const result = await pollOAIHK(oaihkApiKey, oaihkBaseUrl, model.pollEndpoint, requestId, undefined, apiGenerateState.abortController?.signal, round);
                if (apiGenerateState.cancelled) return;

                if (result && result.images) {
                    let bnImgIdx = 0;
                    for (const img of result.images) {
                        if (img.url) {
                            let displayUrl = img.url;
                            try {
                                const dlResp = await api('POST', '/api/download-image', { url: img.url }, hkSubmitTimeoutMs, apiGenerateState.abortController?.signal);
                                if (dlResp.data?.data_uri) {
                                    displayUrl = dlResp.data.data_uri;
                                }
                            } catch (dlErr) {
                                console.warn('代理下载失败，使用原始URL:', dlErr);
                            }
                            produced.push({
                                url: displayUrl,
                                checked: false,
                                filename: `AI生图_HK_${round + 1}_${bnImgIdx + 1}.jpg`,
                                outputType: 'png'
                            });
                            bnImgIdx++;
                        }
                    }
                    pushHKRoundResultsToUi(round, produced);
                }
            }
        } catch (e) {
            if (!apiGenerateState.cancelled) {
                logAction('error', 'HK生图失败', { error: e.message });
                let friendlyMsg = e.message;
                if (e.message.includes('已禁用') || e.message.includes('428')) {
                    friendlyMsg = '模型已被禁用(428)，请稍后重试或联系OpenAI-HK客服';
                } else if (e.message.includes('无可用渠道') || e.message.includes('503')) {
                    friendlyMsg = 'API渠道暂不可用(503)，请稍后重试或检查API Key/余额';
                }
                showToast(`${task.queueLabel}生成失败: ${friendlyMsg}`, 'error');
                markApiResultPendingSlotFailed(resultGrid, round, friendlyMsg.length > 120 ? `${friendlyMsg.slice(0, 118)}…` : friendlyMsg);
            }
        } finally {
            hkParallelFinished++;
            btn.innerHTML = `<span class="loading"></span> ${hkParallelFinished}/${tasks.length}`;
            setApiProgress(Math.min(95, Math.round((hkParallelFinished / tasks.length) * 100)));
        }
    })()));

    await _hkParallelUiTail;
    if (apiGenerateState.cancelled) {
        showToast(`已取消（本轮已结束任务 ${hkParallelFinished}/${tasks.length}）`, 'info');
    }

    // 无论成功/失败/取消，都重置UI状态
    apiGenerateState.running = false;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = null;
    btn.disabled = false;
    btn.textContent = '生成';
    cancelBtn.style.display = 'none';
    showApiRegenerateBtn();
    hideApiProgress();
    clearRemainingApiResultPendingSlots(resultGrid);

    if (allResults.length > 0) {
        logAction('api', 'HK生图完成', { count: allResults.length });
        showToast(`生成完成！共${allResults.length}张`, 'success');
        // 多图列队模式下，将结果追加到当前队列
        if (queueMode === 'multi') {
            queueData[activeQueue].results = (queueData[activeQueue].results || []).concat(allResults);
            saveQueueData();
            renderQueueResults(activeQueue);
        }
        await autoBackupResults(allResults, undefined);
    } else {
        restoreApiResultEmptyPlaceholderIfNeeded();
    }
}

// ========== 批量并行生成（多图列队模式） ==========
async function batchGenerateAll() {
    pushUndoSnapshot();

    logAction('api', '批量生图开始', { queueMode });

    // 收集所有有效队列的任务（每个队列用自己的平台/模型/配置）
    saveCurrentQueueData();
    const baseTasks = [];

    // 收集有效队列（跳过正在生成的队列，包括拆图生成中的）
    for (let q = 0; q < QUEUE_COUNT; q++) {
        const qd = queueData[q];
        if (!qd) continue;
        // 跳过正在生成的队列（拆图或单队列生成中）
        if (queueGenerateStates[q]?.running) continue;
        const platform = qd.apiPlatform || 'runninghub';
        const count = qd.rhCount || 1;
        let prompt;
        if (platform === 'oaihk') {
            prompt = (qd.promptLang || 'en') === 'cn' ? (qd.promptCn?.trim()) : (qd.promptEn?.trim());
        } else {
            prompt = qd.promptEn?.trim();
        }
        if (!prompt) continue;
        const images = qd.slots.filter(s => s.image);
        if (images.length === 0) continue;
        // 校验模型
        if (platform === 'oaihk') {
            const modelId = qd.oaihkModelId;
            const model = OAIHK_MODELS[modelId];
            if (!model) continue;
        } else {
            const modelId = qd.rhModelId;
            const model = RH_MODELS[modelId];
            if (!model) continue;
            if (model.type === 'image-to-image' && images.length === 0) continue;
        }
        const imageUrls = images.map(s => {
            if (s.image.startsWith('/')) return window.location.origin + s.image;
            return s.image;
        });
        for (let i = 0; i < count; i++) {
            baseTasks.push({ prompt, imageUrls, queueLabel: count > 1 ? `队列${q+1} 第${i+1}张` : `队列${q+1}`, queueIndex: q, platform, rhModelId: qd.rhModelId, oaihkModelId: qd.oaihkModelId, rhAspectRatio: qd.rhAspectRatio, oaihkAspectRatio: qd.oaihkAspectRatio, rhResolution: qd.rhResolution });
        }
    }

    if (baseTasks.length === 0) {
        showToast('没有有效的队列数据（需要Prompt和图片）', 'error');
        return;
    }

    const tasks = baseTasks;

    // 为每个涉及的队列设置生成状态
    const involvedQueues = [...new Set(tasks.map(t => t.queueIndex))];
    for (const q of involvedQueues) {
        const qs = queueGenerateStates[q];
        qs.running = true;
        qs.cancelled = false;
        qs.abortController = new AbortController();
    }

    // 批量生成使用独立的取消控制器
    const batchAbortController = new AbortController();
    apiGenerateState.running = true;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = batchAbortController;

    const batchBtn = document.getElementById('btn-api-batch-generate');
    const cancelBtn = document.getElementById('btn-api-cancel');
    batchBtn.disabled = true;
    batchBtn.innerHTML = '<span class="loading"></span> 0/' + tasks.length;
    cancelBtn.style.display = 'inline-flex';
    hideApiRegenerateBtn();

    const allResults = [];
    let completedCount = 0;
    const totalTasks = tasks.length;

    // 清空结果区并按任务组数铺占位卡片
    const resultGrid = document.getElementById('api-result-grid');
    if (resultGrid) renderApiResultPendingSlots(resultGrid, totalTasks);
    setApiProgress(5);
    renderQueueNumberBars();

    // 单任务执行函数
    async function executeOneTask(task) {
        const localResults = [];
        const qi = task.queueIndex;
        const qs = queueGenerateStates[qi];
        try {
            const taskPlatform = task.platform || 'runninghub';
            if (taskPlatform === 'oaihk') {
                const modelId = task.oaihkModelId || document.getElementById('cfg-oaihk-model-inline')?.value;
                const model = OAIHK_MODELS[modelId];
                const aspectRatio = task.oaihkAspectRatio || document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4';
                const shortEdge = model.shortEdge || 1536;

                const publicUrls = [];
                for (let j = 0; j < task.imageUrls.length; j++) {
                    if (apiGenerateState.cancelled || qs.cancelled) return localResults;
                    const publicUrl = await uploadToTmpfiles(task.imageUrls[j], aspectRatio, shortEdge);
                    publicUrls.push(publicUrl);
                }
                if (apiGenerateState.cancelled || qs.cancelled) return localResults;

                const hkBatchTm = Math.min(Math.max(getOaihkGptClientTimeoutMs(), 120000), 600000);
                if (model.isGptImage) {
                    announceOaihkSubmit('多图队列-批量-GPT', {
                        model: model.modelId || 'gpt-image-2',
                        size: getOaihkImageSize(model, aspectRatio),
                        quality: getOaihkGptQuality(model)
                    });
                    const gptResp = await api('POST', '/api/oaihk-gpt-image', {
                        action: publicUrls.length > 0 ? 'edits' : 'generations',
                        model: model.modelId || 'gpt-image-2',
                        prompt: task.prompt,
                        size: getOaihkImageSize(model, aspectRatio),
                        quality: getOaihkGptQuality(model),
                        n: 1,
                        image_base64_list: publicUrls
                    }, hkBatchTm);
                    publicUrls.length = 0;

                    if (gptResp.data && Array.isArray(gptResp.data)) {
                        for (const item of gptResp.data) {
                            const displayUrl = await displayUrlFromOaihkGptItem(item, undefined);
                            if (!displayUrl) continue;
                            if (!item.b64_json && item.url && displayUrl === item.url) {
                                showToast('图片下载到本地失败，已使用外网URL', 'warning');
                            }
                            localResults.push({ url: displayUrl, checked: false, filename: `AI生图_HK_${task.queueLabel}_${localResults.length + 1}.jpg`, outputType: 'png', queueIndex: task.queueIndex });
                        }
                    }
                } else {
                    const payload = {
                        prompt: task.prompt,
                        image_urls: publicUrls,
                        num_images: 1,
                        aspect_ratio: aspectRatio
                    };
                    if (model.modelId) payload.model = model.modelId;

                    const submitData = await api('POST', '/api/oaihk-proxy', {
                        action: 'submit',
                        api_key: '',
                        base_url: '',
                        endpoint: model.endpoint,
                        model_id: task.oaihkModelId || modelId,
                        params: payload
                    }, hkBatchTm);

                    const requestId = submitData.request_id;
                    if (!requestId) {
                        const errMsg = submitData.error || '未返回request_id';
                        showToast(`${task.queueLabel}提交失败: ${errMsg}`, 'error');
                        return localResults;
                    }

                    const result = await pollOAIHK('', '', model.pollEndpoint, requestId, undefined, undefined, undefined);
                    if (apiGenerateState.cancelled || qs.cancelled) return localResults;

                    if (result && result.images) {
                        for (const img of result.images) {
                            if (img.url) {
                                let displayUrl = img.url;
                                try {
                                    const dlResp = await api('POST', '/api/download-image', { url: img.url }, hkBatchTm);
                                    if (dlResp.data?.data_uri) displayUrl = dlResp.data.data_uri;
                                } catch (dlErr) {
                                    console.warn('[批量生图-OAIHK] 图片下载失败:', dlErr);
                                    showToast('图片下载到本地失败，已使用外网URL', 'warning');
                                }
                                localResults.push({ url: displayUrl, checked: false, filename: `AI生图_HK_${task.queueLabel}_${localResults.length + 1}.jpg`, outputType: 'png', queueIndex: task.queueIndex });
                            }
                        }
                    }
                }
            } else {
                const modelId = task.rhModelId || document.getElementById('cfg-rh-model-inline')?.value;
                const model = RH_MODELS[modelId];

                const payload = { prompt: task.prompt };
                if (model.type === 'image-to-image' && task.imageUrls.length > 0) payload.imageUrls = task.imageUrls;
                if (model.hasResolution) payload.resolution = task.rhResolution || document.getElementById('cfg-rh-resolution-inline')?.value || '1k';
                const aspectRatio = task.rhAspectRatio || document.getElementById('cfg-rh-aspect-ratio-inline')?.value;
                if (aspectRatio) payload.aspectRatio = aspectRatio;

                const data = await api('POST', '/api/rh-proxy', {
                    action: 'submit',
                    api_key: '',
                    base_url: '',
                    model_id: task.rhModelId || modelId,
                    params: payload
                });

                if (data.status === 'FAILED') {
                    showToast(`${task.queueLabel}提交失败: ${data.errorMessage || '未知错误'}`, 'error');
                    return localResults;
                }

                const result = await pollUntilDone('', '', data.taskId, Date.now(), undefined, undefined, undefined);
                if (apiGenerateState.cancelled || qs.cancelled) return localResults;

                if (result && result.results) {
                    for (const r of result.results) {
                        if (r.url) {
                            localResults.push({ url: r.url, checked: false, filename: `AI生图_${task.queueLabel}_${localResults.length+1}.${r.outputType || 'png'}`, outputType: r.outputType || 'png', queueIndex: task.queueIndex });
                        }
                    }
                }
            }
        } catch (e) {
            if (!apiGenerateState.cancelled) {
                showToast(`${task.queueLabel}生成失败: ${e.message}`, 'error');
            }
        }
        return localResults;
    }

    // 全部任务同时提交，由上游 API 各自排队；完成顺序不影响占位填补（fillNextPending）
    const batchPromises = tasks.map(task =>
        executeOneTask(task).then(results => {
            completedCount++;
            const gridEl = document.getElementById('api-result-grid');
            if (results.length === 0) {
                const ph = gridEl?.querySelector('.api-result-pending-card');
                if (ph) {
                    ph.classList.add('api-result-pending-card--failed');
                    ph.replaceChildren();
                    const inner = document.createElement('div');
                    inner.className = 'api-result-pending-inner';
                    const st = document.createElement('div');
                    st.className = 'api-result-pending-status';
                    st.style.fontSize = '10px';
                    st.textContent = '未返图';
                    inner.appendChild(st);
                    ph.appendChild(inner);
                }
            } else {
                for (const item of results) {
                    allResults.push(item);
                    appendResultCard(item, allResults.length - 1, { fillNextPending: true });
                }
            }
            batchBtn.innerHTML = `<span class="loading"></span> ${completedCount}/${totalTasks}`;
            setApiProgress(Math.round((completedCount / totalTasks) * 100));
            return results;
        })
    );
    await Promise.allSettled(batchPromises);

    // 重置涉及的队列生成状态
    for (const q of involvedQueues) {
        const qs = queueGenerateStates[q];
        qs.running = false;
        qs.cancelled = false;
        qs.abortController = null;
    }

    // 重置UI
    apiGenerateState.running = false;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = null;
    batchBtn.disabled = false;
    batchBtn.textContent = '批量生成';
    if (!isAnyQueueGenerating()) {
        cancelBtn.style.display = 'none';
        hideApiProgress();
    }
    showApiRegenerateBtn();
    clearRemainingApiResultPendingSlots(resultGrid);
    renderQueueNumberBars();

    if (allResults.length > 0) {
        const platform = involvedQueues.length > 0 ? (queueData[involvedQueues[0]]?.apiPlatform || 'runninghub') : 'runninghub';
        logAction('api', platform === 'oaihk' ? 'HK批量生图完成' : 'RH批量生图完成', { count: allResults.length, tasks: totalTasks });
        showToast(`批量生成完成！共${allResults.length}张（${completedCount}组）`, 'success');
        // 按队列追加结果
        for (let q = 0; q < QUEUE_COUNT; q++) {
            const qResults = allResults.filter(r => r.queueIndex === q);
            if (qResults.length > 0) {
                queueData[q].results = (queueData[q].results || []).concat(qResults);
            }
        }
        saveQueueData();
        renderQueueResults(activeQueue);
        await autoBackupResults(allResults, activeQueue);
    } else {
        restoreApiResultEmptyPlaceholderIfNeeded();
    }
}

// 批量生成按钮点击事件
document.getElementById('btn-api-batch-generate')?.addEventListener('click', () => {
    if (queueMode !== 'multi') {
        showToast('批量生成仅在多图列队模式下可用', 'error');
        return;
    }
    batchGenerateAll();
});

// API 结果区：本轮生成占位卡片（与真实卡片同网格）
function renderApiResultPendingSlots(grid, count) {
    if (!grid || count < 1) return;
    clearRemainingApiResultPendingSlots(grid);
    grid.querySelector('#api-result-placeholder')?.remove();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < count; i++) {
        const card = document.createElement('div');
        card.className = 'api-result-pending-card';
        card.dataset.slotIndex = String(i);
        card.innerHTML = `<div class="api-result-pending-inner">
            <div class="api-result-pending-shimmer"></div>
            <div class="api-result-pending-status"><span class="loading" style="display:inline-block;"></span> 等待返图…</div>
            <div class="api-result-pending-num">${i + 1} / ${count}</div>
        </div>`;
        frag.appendChild(card);
    }
    grid.appendChild(frag);
}

function clearRemainingApiResultPendingSlots(grid) {
    const g = grid || document.getElementById('api-result-grid');
    if (!g) return;
    g.querySelectorAll('.api-result-pending-card').forEach(el => el.remove());
}

function setApiResultPendingSlotStatus(gridRef, slotIndex, html) {
    const grid = typeof gridRef === 'string' ? document.getElementById(gridRef) : gridRef;
    const el = grid?.querySelector(`.api-result-pending-card[data-slot-index="${slotIndex}"] .api-result-pending-status`);
    if (el) el.innerHTML = html;
}

function removeApiResultPendingSlotAt(gridRef, slotIndex) {
    const grid = typeof gridRef === 'string' ? document.getElementById(gridRef) : gridRef;
    grid?.querySelector(`.api-result-pending-card[data-slot-index="${slotIndex}"]`)?.remove();
}

function markApiResultPendingSlotFailed(gridRef, slotIndex, message) {
    const grid = typeof gridRef === 'string' ? document.getElementById(gridRef) : gridRef;
    const ph = grid?.querySelector(`.api-result-pending-card[data-slot-index="${slotIndex}"]`);
    if (!ph) return;
    ph.classList.add('api-result-pending-card--failed');
    ph.replaceChildren();
    const inner = document.createElement('div');
    inner.className = 'api-result-pending-inner';
    const st = document.createElement('div');
    st.className = 'api-result-pending-status';
    st.style.color = 'var(--error-text)';
    st.style.fontSize = '10px';
    st.textContent = message || '失败';
    inner.appendChild(st);
    ph.appendChild(inner);
}

function restoreApiResultEmptyPlaceholderIfNeeded() {
    const grid = document.getElementById('api-result-grid');
    if (!grid || grid.querySelector('.api-result-card')) return;
    grid.innerHTML = `<div id="api-result-placeholder" style="grid-column:1/-1;text-align:center;padding:30px 0;color:var(--text-muted);font-size:11px;">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.2" style="opacity:0.4;margin-bottom:8px;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                <div>选择模型后点击「API生成」开始</div>
            </div>`;
}

function buildApiResultCardElement(item, index) {
    const card = document.createElement('div');
    card.className = 'api-result-card';
    card.dataset.index = String(index);
    const imgEl = document.createElement('img');
    imgEl.alt = '生成结果';
    imgEl.style.cssText = 'width:100%;aspect-ratio:3/4;object-fit:cover;display:block;cursor:pointer;';
    imgEl.src = item.url;
    imgEl.onerror = () => {
        imgEl.style.display = 'none';
        const fallback = document.createElement('div');
        fallback.style.cssText = 'width:100%;aspect-ratio:3/4;display:flex;align-items:center;justify-content:center;background:var(--border-light);color:var(--text-muted);font-size:10px;';
        fallback.textContent = '加载失败';
        card.insertBefore(fallback, card.firstChild);
    };
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'api-result-actions';
    actionsDiv.innerHTML = '<button class="btn-icon download-single" title="下载">↓</button><button class="btn-icon delete-single" title="删除" style="color:var(--danger);">×</button>';
    const checkDiv = document.createElement('div');
    checkDiv.style.cssText = 'position:absolute;top:4px;left:4px;';
    checkDiv.innerHTML = '<input type="checkbox" class="result-checkbox" style="width:14px;height:14px;cursor:pointer;" title="勾选下载">';
    card.appendChild(imgEl);
    card.appendChild(actionsDiv);
    card.appendChild(checkDiv);
    imgEl.addEventListener('click', () => {
        const gridEl = document.getElementById('api-result-grid');
        if (!gridEl) return;
        const allCards = gridEl.querySelectorAll('.api-result-card');
        const images = [];
        allCards.forEach(c => {
            const img = c.querySelector('img');
            const cb = c.querySelector('.result-checkbox');
            images.push({ url: img?.src || '', checked: cb?.checked || false, filename: `AI生图_${images.length + 1}.jpg` });
        });
        openImageViewer(images, index);
    });
    card.querySelector('.download-single').addEventListener('click', (e) => {
        e.stopPropagation();
        const currentDownloadPath = queueMode === 'multi'
            ? getEffectiveQueueDownloadPath(activeQueue)
            : (cleanDownloadPath(document.getElementById('cfg-rh-download-path')?.value) || getGlobalDownloadPath());
        downloadImage(item.url, item.filename, currentDownloadPath);
    });
    card.querySelector('.delete-single').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteResultItem(card, item);
    });
    return card;
}

// 追加单张结果卡片（可选：按槽位替换占位，或并行模式下填补下一个占位）
function appendResultCard(item, index, options = {}) {
    const grid = document.getElementById('api-result-grid');
    if (!grid) return;
    const placeholder = grid.querySelector('#api-result-placeholder');
    if (placeholder) placeholder.remove();

    const card = buildApiResultCardElement(item, index);
    const si = options.slotIndex;
    if (si !== undefined && si !== null) {
        const ph = grid.querySelector(`.api-result-pending-card[data-slot-index="${si}"]`);
        if (ph) {
            ph.replaceWith(card);
            return;
        }
    }
    if (options.fillNextPending) {
        const ph = grid.querySelector('.api-result-pending-card');
        if (ph) {
            ph.replaceWith(card);
            return;
        }
    }
    grid.appendChild(card);
}

// 删除单张结果
function deleteResultItem(cardEl, item) {
    const grid = document.getElementById('api-result-grid');
    if (!grid) return;
    // 从DOM移除
    cardEl.remove();
    // 从queueData中移除
    if (queueMode === 'multi') {
        const results = queueData[activeQueue]?.results || [];
        const idx = results.findIndex(r => r.url === item.url);
        if (idx >= 0) {
            results.splice(idx, 1);
            saveQueueData();
        }
    }
    // 如果结果区为空，恢复占位
    if (!grid.querySelector('.api-result-card')) {
        grid.innerHTML = `<div id="api-result-placeholder" style="grid-column:1/-1;text-align:center;padding:30px 0;color:var(--text-muted);font-size:11px;">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.2" style="opacity:0.4;margin-bottom:8px;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                <div>选择模型后点击「API生成」开始</div>
            </div>`;
    }
    showToast('已删除', 'success');
}

// 清除当前队列所有结果
function clearCurrentQueueResults() {
    const grid = document.getElementById('api-result-grid');
    if (!grid) return;
    if (queueMode === 'multi') {
        queueData[activeQueue].results = [];
        // 清除结果时，将当前队列模型恢复为默认配置
        const q = queueData[activeQueue];
        const config = getDefaultModelConfig();
        if (config) {
            q.apiPlatform = config.platform || 'oaihk';
            q.rhModelId = config.rhModelId || q.rhModelId || '';
            q.oaihkModelId = config.oaihkModelId || q.oaihkModelId || 'fal-ai/banana/v3.1/flash/2k';
            q.rhResolution = config.rhResolution || q.rhResolution || '1k';
            q.rhAspectRatio = config.rhAspectRatio || q.rhAspectRatio || '3:4';
            q.oaihkAspectRatio = config.oaihkAspectRatio || q.oaihkAspectRatio || '3:4';
        } else {
            q.apiPlatform = 'oaihk';
            q.oaihkModelId = 'fal-ai/banana/v3.1/flash/2k';
            q.oaihkAspectRatio = '3:4';
            q.rhResolution = q.rhResolution || '1k';
            q.rhAspectRatio = '3:4';
        }
        // 同步恢复到当前UI
        restoreApiConfigToDOM(q);
        saveQueueData();
    }
    grid.innerHTML = `<div id="api-result-placeholder" style="grid-column:1/-1;text-align:center;padding:30px 0;color:var(--text-muted);font-size:11px;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.2" style="opacity:0.4;margin-bottom:8px;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            <div>选择模型后点击「API生成」开始</div>
        </div>`;
    updateDefaultModelBadge();
    showToast('已清除所有结果，当前队列模型已恢复默认', 'success');
}

// ========================================================================
// Feature Enhancements & Optimizations (3.6, 3.7, 3.8, 4.1, 4.3, 4.4)
// ========================================================================

// ========== 3.6 API Usage Tracking ==========
async function logUsage(model, taskId, cost, platform) {
    try {
        await fetch('/api/log-usage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, task_id: taskId, cost, platform })
        });
        fetchUsageBadge();
    } catch (e) { /* usage tracking is non-critical */ }
}

async function fetchUsageBadge() {
    try {
        const data = await api('GET', '/api/usage');
        const badge = document.getElementById('usage-badge');
        const countEl = document.getElementById('usage-badge-count');
        if (badge && countEl) {
            const todayCount = data.today?.count || 0;
            countEl.textContent = todayCount;
            badge.style.display = todayCount > 0 ? 'inline-flex' : 'none';
        }
    } catch (e) { /* silently fail */ }
}

// Fetch usage on page load
setTimeout(fetchUsageBadge, 2000);

// Hook usage logging into logAction to intercept completion events
const _origLogAction = logAction;
logAction = function logActionWithUsage(action, msg, detail) {
    _origLogAction(action, msg, detail);
    if (action === 'api' && msg === 'RH生图完成') {
        const count = detail?.count || 0;
        const rhModelId = document.getElementById('cfg-rh-model-inline')?.value || 'rh-unknown';
        for (let n = 0; n < count; n++) {
            logUsage(rhModelId, '', 0, 'runninghub');
        }
    }
    if (action === 'api' && msg === 'HK生图完成') {
        const count = detail?.count || 0;
        const oaihkModelId = document.getElementById('cfg-oaihk-model-inline')?.value || 'oaihk-unknown';
        for (let n = 0; n < count; n++) {
            logUsage(oaihkModelId, '', 0, 'oaihk');
        }
    }
};

// ========== 3.7 Configurable Keyboard Shortcuts ==========
const SHORTCUT_ACTIONS = {
    'generate-prompt': { label: '生成提示词', trigger: () => document.getElementById('btn-img-generate')?.click() },
    'generate-image': { label: 'API生图', trigger: () => document.getElementById('btn-api-generate')?.click() },
    'save-preset': { label: '保存预设', trigger: () => document.getElementById('btn-img-save-preset')?.click() },
    'export-data': { label: '导出数据', trigger: () => document.getElementById('btn-export')?.click() }
};

let keyboardShortcuts = {};
try {
    const saved = localStorage.getItem('keyboardShortcuts');
    if (saved) keyboardShortcuts = JSON.parse(saved);
} catch (e) {}

function formatShortcutKey(combo) {
    if (!combo) return '';
    return combo.replace('Control', 'Ctrl').replace('Meta', 'Cmd');
}

function shortcutComboFromEvent(e) {
    const parts = [];
    if (e.ctrlKey || e.metaKey) parts.push('mod');
    if (e.altKey) parts.push('alt');
    if (e.shiftKey) parts.push('shift');
    const key = typeof e.key === 'string' ? e.key : '';
    if (key && !['Control','Meta','Alt','Shift'].includes(key)) parts.push(key.toLowerCase());
    return parts.join('+');
}

// Global keydown listener for shortcuts
document.addEventListener('keydown', (e) => {
    const combo = shortcutComboFromEvent(e);
    if (!combo) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
    for (const [actionId, shortcut] of Object.entries(keyboardShortcuts)) {
        if (shortcut === combo) {
            e.preventDefault();
            e.stopPropagation();
            const action = SHORTCUT_ACTIONS[actionId];
            if (action) {
                action.trigger();
                _origLogAction('shortcut', `快捷键触发: ${action.label}`, { combo, action: actionId });
            }
            return;
        }
    }
});

function renderShortcutSettings() {
    const container = document.getElementById('shortcut-settings-container');
    if (!container) return;
    container.innerHTML = '';

    for (const [actionId, actionInfo] of Object.entries(SHORTCUT_ACTIONS)) {
        const row = document.createElement('div');
        row.className = 'shortcut-row';

        const nameEl = document.createElement('span');
        nameEl.className = 'shortcut-action-name';
        nameEl.textContent = actionInfo.label;

        const keyEl = document.createElement('span');
        keyEl.className = 'shortcut-key';
        const currentShortcut = keyboardShortcuts[actionId];
        if (currentShortcut) {
            keyEl.textContent = formatShortcutKey(currentShortcut);
        } else {
            keyEl.textContent = '未设置';
            keyEl.classList.add('unset');
        }

        keyEl.addEventListener('click', () => {
            keyEl.textContent = '请按下快捷键...';
            keyEl.classList.add('capturing');
            keyEl.classList.remove('unset');

            const onKeydown = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (e.key === 'Escape') {
                    keyEl.textContent = currentShortcut ? formatShortcutKey(currentShortcut) : '未设置';
                    keyEl.classList.remove('capturing');
                    if (!currentShortcut) keyEl.classList.add('unset');
                    document.removeEventListener('keydown', onKeydown, true);
                    return;
                }
                const newCombo = shortcutComboFromEvent(e);
                if (!newCombo) return;
                for (const [aid, sc] of Object.entries(keyboardShortcuts)) {
                    if (sc === newCombo && aid !== actionId) delete keyboardShortcuts[aid];
                }
                keyboardShortcuts[actionId] = newCombo;
                localStorage.setItem('keyboardShortcuts', JSON.stringify(keyboardShortcuts));
                keyEl.textContent = formatShortcutKey(newCombo);
                keyEl.classList.remove('capturing', 'unset');
                document.removeEventListener('keydown', onKeydown, true);
                renderShortcutSettings();
                showToast(`快捷键已设置: ${actionInfo.label} = ${formatShortcutKey(newCombo)}`, 'success');
            };
            document.addEventListener('keydown', onKeydown, true);
        });

        keyEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            if (keyboardShortcuts[actionId]) {
                delete keyboardShortcuts[actionId];
                localStorage.setItem('keyboardShortcuts', JSON.stringify(keyboardShortcuts));
                keyEl.textContent = '未设置';
                keyEl.classList.add('unset');
                showToast(`已清除快捷键: ${actionInfo.label}`, 'info');
            }
        });

        row.appendChild(nameEl);
        row.appendChild(keyEl);
        container.appendChild(row);
    }
}

// ========== 3.8 Dynamic Image Slot Count ==========
const _origRenderImageSlots = renderImageSlots;
renderImageSlots = function renderImageSlotsDynamic() {
    const container = document.getElementById('image-slots');
    if (!container) return;
    container.innerHTML = '';

    const zoomValue = parseInt(document.getElementById('slot-zoom-slider')?.value || '70', 10);
    const imgSize = zoomValue;

    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
    }

    // Find last occupied slot
    let lastOccupied = -1;
    for (let i = SLOT_COUNT - 1; i >= 0; i--) {
        if (imageState.slots[i].image) { lastOccupied = i; break; }
    }
    // Render: 0..lastOccupied+1 (at least 1 empty), capped at SLOT_COUNT
    const renderCount = Math.min(lastOccupied + 2, SLOT_COUNT);

    for (let i = 0; i < renderCount; i++) {
        const slot = imageState.slots[i];
        const isActive = imageState.activeSlotIndex === i;

        const slotEl = document.createElement('div');
        slotEl.className = `image-slot-compact ${isActive ? 'active' : ''}`;
        slotEl.dataset.slotIndex = i;

        const imgHtml = slot.image
            ? `<img src="${escHtml(slot.image)}" class="slot-compact-img" alt="Image ${i+1}" style="width:${imgSize}px;height:${imgSize}px;">`
            : `<div class="slot-compact-no-img" style="width:${imgSize}px;height:${imgSize}px;">+</div>`;

        const prefix = slot.prefixTemplate || '请参考';
        const semantic = slot.label || '';

        const pinBtn = (queueMode === 'multi' && slot.image) ? `<button class="slot-pin-btn ${pinnedSlotIndices.has(i) ? 'pinned' : ''}" title="${pinnedSlotIndices.has(i) ? '取消全列队' : '应用全列队'}">${pinnedSlotIndices.has(i) ? '📌' : '📍'}</button>` : '';
        const dwBtn = slot.image
            ? `<button class="slot-dw-btn ${slot.dwEnabled ? 'active' : ''}" title="DWPose 姿态提取">${slot._dwLoading ? '<span class="dw-spinner"></span>' : 'DW'}</button>`
            : '';
        slotEl.innerHTML = `
            <div class="slot-compact-image-area ${slot.dwEnabled ? 'dw-active' : ''}">${imgHtml}${slot.image ? '<button class="slot-change-btn" title="更换图片">✎</button>' : ''}${pinBtn}${dwBtn}</div>
            <div class="slot-compact-label">
                <span class="slot-prefix" title="点击编辑前缀">${escHtml(prefix)}</span><span class="slot-auto-text">图${i+1}${semantic ? '的' + escHtml(semantic) : ''}</span>
            </div>
        `;

        // 应用全列队按钮
        const pinEl = slotEl.querySelector('.slot-pin-btn');
        if (pinEl) {
            pinEl.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePinSlotToAllQueues(i);
            });
        }

        // DWPose 姿态提取按钮
        const dwEl = slotEl.querySelector('.slot-dw-btn');
        if (dwEl) {
            dwEl.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleDW(i);
            });
        }

        const prefixEl = slotEl.querySelector('.slot-prefix');
        prefixEl.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newPrefix = await showPrompt('修改前缀模板', slot.prefixTemplate || '请参考', '前缀模板');
            if (newPrefix !== null && newPrefix.trim()) {
                imageState.slots[i].prefixTemplate = newPrefix.trim();
                renderImageSlots();
                updateLocalPrompt();
                // 持久化前缀设置：多图列队模式需同步到当前队列
                if (queueMode === 'multi') saveCurrentQueueData();
                saveQueueData();
            }
        });

        const changeBtn = slotEl.querySelector('.slot-change-btn');
        if (changeBtn) {
            changeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                imageState.activeSlotIndex = i;
                renderImageSlots();
                openSelectMaterialModal();
            });
        }

        const imgArea = slotEl.querySelector('.slot-compact-image-area');
        let clickTimer = null;
        imgArea.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target.closest('.slot-change-btn') || e.target.closest('.slot-pin-btn')) return;
            // 仅切换active状态，不重新渲染DOM（避免dblclick事件丢失）
            if (imageState.activeSlotIndex !== i) {
                imageState.activeSlotIndex = i;
                renderImageSlots();
            }
            if (!slot.image) { openSelectMaterialModal(); return; }
            // 单击：延迟预览（双击时会取消此定时器）
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            clickTimer = setTimeout(() => {
                clickTimer = null;
                if (slot.image) showImagePreview(slot.image);
                else openSelectMaterialModal();
            }, 300);
        });
        imgArea.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            e.preventDefault();
            // 取消单击的预览定时器，确保不弹出预览
            if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
            imageState.activeSlotIndex = i;
            renderImageSlots();
            openSelectMaterialModal();
        });

        slotEl.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); slotEl.classList.add('drag-over'); });
        slotEl.addEventListener('dragleave', () => { slotEl.classList.remove('drag-over'); });
        slotEl.addEventListener('drop', async (e) => {
            e.preventDefault(); e.stopPropagation();
            slotEl.classList.remove('drag-over');
            const libPayload2 = parseLibMaterialDragPayload(e.dataTransfer);
            if (libPayload2?.url) {
                imageState.activeSlotIndex = i;
                imageState.slots[i].image = libPayload2.url;
                imageState.slots[i].dwEnabled = false;
                imageState.slots[i].dwOriginalImage = '';
                imageState.slots[i].label = libPayload2.name || '素材库';
                renderImageSlots();
                updateLocalPrompt();
                showToast(`已从素材库拖拽填入 Image ${i + 1}`, 'success');
                logAction('slot', '素材库拖拽到槽', { slotIndex: i });
                return;
            }
            const imageFiles = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
            if (!imageFiles.length) return;
            if (imageFiles.length === 1) {
                // 单张：裁剪 → 分配素材 → 加载到槽位
                const reader = new FileReader();
                reader.onload = () => {
                    showCropModal(reader.result, async (croppedBlob) => {
                        const formData = new FormData();
                        formData.append('file', croppedBlob, 'cropped.jpg');
                        try {
                            const url = await uploadImage(formData);
                            // 弹出分配素材弹窗（命名+分类）
                            const assignResult = await showAssignMaterial(url, imageFiles[0].name);
                            imageState.slots[i].image = url;
                            imageState.slots[i].dwEnabled = false;
                            imageState.slots[i].dwOriginalImage = '';
                            if (assignResult && assignResult.labels && assignResult.labels.length > 0) {
                                imageState.slots[i].label = assignResult.labels.join('、');
                            }
                            renderImageSlots();
                            updateLocalPrompt();
                            if (assignResult && assignResult.savedToLib) {
                                showToast('图片已存入素材库并加载到槽位', 'success');
                            } else {
                                showToast('图片已加载到槽位', 'success');
                            }
                            logAction('slot', '拖拽上传图片到槽', { slotIndex: i });
                        } catch (err) { showToast(err.message, 'error'); }
                    });
                };
                reader.readAsDataURL(imageFiles[0]);
            } else {
                // 多张：批量裁剪队列，每张裁剪后弹出分配弹窗
                startBatchCrop(imageFiles, i, (targetSlot, idx, total) => {
                    return async (croppedBlob) => {
                        const formData = new FormData();
                        formData.append('file', croppedBlob, 'cropped.jpg');
                        try {
                            const url = await uploadImage(formData);
                            // 弹出分配素材弹窗（命名+分类）
                            const assignResult = await showAssignMaterial(url, imageFiles[idx].name);
                            if (targetSlot < SLOT_COUNT) {
                                imageState.slots[targetSlot].image = url;
                                imageState.slots[targetSlot].dwEnabled = false;
                                imageState.slots[targetSlot].dwOriginalImage = '';
                                if (assignResult && assignResult.labels && assignResult.labels.length > 0) {
                                    imageState.slots[targetSlot].label = assignResult.labels.join('、');
                                }
                                renderImageSlots();
                                updateLocalPrompt();
                                logAction('slot', '拖拽批量上传图片到槽', { slotIndex: targetSlot });
                            }
                            if (idx === total - 1) {
                                showToast('批量上传完成：' + total + '张', 'success');
                            }
                        } catch (err) { showToast('第' + (idx+1) + '张上传失败：' + err.message, 'error'); }
                    };
                });
            }
        });

        slotEl.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const choice = confirm('确定清除该图片槽？\n\n取消 = 选择本地上传图片');
            if (choice) {
                pushUndoSnapshot();
                imageState.slots[i] = { image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' };
                compactAndRenumber();
                renderImageSlots();
                updateLocalPrompt();
            } else {
                uploadSlotImage(i);
            }
        });

        container.appendChild(slotEl);
    }

    // Add "+" button if more slots are available
    if (renderCount < SLOT_COUNT) {
        const addBtn = document.createElement('div');
        addBtn.className = 'image-slot-add-btn';
        addBtn.innerHTML = '<span class="add-icon">+</span>';
        addBtn.addEventListener('click', () => {
            imageState.activeSlotIndex = renderCount;
            renderImageSlots();
            openSelectMaterialModal();
        });
        container.appendChild(addBtn);
    }
};

function compactSlots() {
    // 旧版：仅移除尾部空槽
    while (imageState.slots.length > 1 &&
           !imageState.slots[imageState.slots.length - 1].image &&
           !imageState.slots[imageState.slots.length - 2].image) {
        imageState.slots.pop();
    }
    if (imageState.slots.length === 0) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
    }
}

// 删除图片后：将有图槽位前移补位，并更新提示词中的图片编号
function compactAndRenumber() {
    const promptCn = document.getElementById('img-prompt-cn');
    const oldVal = promptCn ? promptCn.value : '';

    // 记录旧编号→新编号的映射
    const oldToNew = {};
    const newSlots = [];
    let newIndex = 0;
    for (let i = 0; i < imageState.slots.length; i++) {
        if (imageState.slots[i].image || imageState.slots[i].label) {
            oldToNew[i + 1] = newIndex + 1; // 图1→图1, 图3→图2 等
            newSlots.push(imageState.slots[i]);
            newIndex++;
        }
    }
    // 补齐到 SLOT_COUNT
    while (newSlots.length < SLOT_COUNT) {
        newSlots.push({ image: '', label: '', prefixTemplate: '请参考', dwEnabled: false, dwOriginalImage: '' });
    }
    imageState.slots = newSlots;

    // 更新提示词中的图片编号
    if (promptCn && oldVal) {
        let newVal = oldVal;
        // 从大到小替换，避免图1→图2后再被图2→图3覆盖
        const oldNums = Object.keys(oldToNew).map(Number).sort((a, b) => b - a);
        for (const oldNum of oldNums) {
            const newNum = oldToNew[oldNum];
            if (oldNum !== newNum) {
                // 替换"图N"为临时标记，避免连锁替换
                newVal = newVal.replace(new RegExp(`图${oldNum}`, 'g'), `图TMP${newNum}`);
            }
        }
        // 还原临时标记
        newVal = newVal.replace(/图TMP(\d+)/g, '图$1');
        promptCn.value = newVal;
        imageState.promptCn = newVal;
    }

    // 更新 promptedSlotIndices
    const newPromptedIndices = new Set();
    for (const old of promptedSlotIndices) {
        const newIdx = oldToNew[old + 1];
        if (newIdx !== undefined) newPromptedIndices.add(newIdx - 1);
    }
    promptedSlotIndices = newPromptedIndices;

    // 更新 pinnedSlotIndices
    const newPinnedIndices = new Set();
    for (const old of pinnedSlotIndices) {
        const newIdx = oldToNew[old + 1];
        if (newIdx !== undefined) newPinnedIndices.add(newIdx - 1);
    }
    pinnedSlotIndices = newPinnedIndices;
    try { localStorage.setItem('pinnedSlotIndices', JSON.stringify(Array.from(pinnedSlotIndices))); } catch(e) {}

    // 同步到当前队列数据
    const q = queueData[activeQueue];
    if (q) {
        q.slots = deepClone(imageState.slots);
        q.promptCn = imageState.promptCn;
        q.promptedSlotIndices = [...promptedSlotIndices];
        q.pinnedSlotIndices = [...pinnedSlotIndices];
    }
}

// ========== 4.1 Parallel Image Upload ==========
async function uploadToTmpfilesParallel(imageUrls, aspectRatio, shortEdge) {
    // Filter out already-processed URLs (http/https/data:)
    const localUrls = [];
    const localIndices = [];
    const resultUrls = new Array(imageUrls.length);

    for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
            resultUrls[i] = url; // already processed
        } else {
            localUrls.push(url);
            localIndices.push(i);
        }
    }

    if (localUrls.length === 0) return resultUrls;

    // Try backend batch endpoint first (4.2 parallel preprocessing)
    try {
        const batchResp = await api('POST', '/api/preprocess-batch', {
            local_urls: localUrls,
            aspect_ratio: aspectRatio,
            short_edge: shortEdge
        });
        if (batchResp.results && batchResp.results.length === localUrls.length) {
            for (let j = 0; j < localUrls.length; j++) {
                const r = batchResp.results[j];
                if (r.error) {
                    throw new Error(`图片预处理失败: ${r.error}`);
                }
                resultUrls[localIndices[j]] = r.data_uri;
            }
            return resultUrls;
        }
    } catch (e) {
        // Fall back to frontend parallel processing
        console.warn('Batch preprocessing failed, falling back to individual:', e.message);
    }

    // Fallback: process individually in parallel on the frontend
    const promises = localUrls.map((url, j) => {
        return uploadToTmpfiles(url, aspectRatio, shortEdge)
            .then(publicUrl => ({ j, url: publicUrl, error: null }))
            .catch(err => ({ j, url: null, error: err.message }));
    });
    const results = await Promise.all(promises);
    const errors = results.filter(r => r.error);
    if (errors.length > 0) {
        throw new Error(`图片预处理失败(${errors.length}/${localUrls.length}): ${errors[0].error}`);
    }
    for (const r of results) {
        resultUrls[localIndices[r.j]] = r.url;
    }
    return resultUrls;
}

// Patch generateViaOpenAIHK to use parallel image preprocessing
// Replace the sequential loop with the parallel version
(function patchOAIHKParallelUpload() {
    // We monkey-patch by replacing the sequential upload loop in generateViaOpenAIHK.
    // The sequential loop pattern is:
    //   for (let j = 0; j < task.imageUrls.length; j++) {
    //       const publicUrl = await uploadToTmpfiles(task.imageUrls[j], aspectRatio, shortEdge);
    //       publicUrls.push(publicUrl);
    //   }
    // We can't easily replace this in the existing function body without rewriting it.
    // Instead, we make uploadToTmpfiles cache-aware and add a batch pre-warming mechanism.
    // The real parallelization happens via the /api/preprocess-batch endpoint (4.2)
    // and the frontend uploadToTmpfilesParallel function.
    // To make generateViaOpenAIHK use it, we'd need to rewrite the function.
    // For now, the batch endpoint provides the speed improvement when called directly,
    // and the frontend parallel function is available for future refactoring.
})();

// ========== 4.3 Parallel Bilingual Prompt Generation ==========
// The bilingual endpoint already returns both CN+EN in one call.
// For the "refresh English" flow, we can run translation in parallel
// with image preprocessing for the next API submission.
// We patch the bilingual generation handler to also kick off image
// preprocessing in parallel when both will be needed.
(function patchBilingualParallel() {
    // When the user clicks "生成提示词", we can start image preprocessing
    // in parallel with the LLM call. This saves time when the user
    // subsequently clicks "API生成".
    let preprocessedImagesCache = null;
    let preprocessingPromise = null;

    // Hook into the bilingual generation button to start preprocessing in parallel
    const origGenHandler = document.getElementById('btn-img-generate')?.onclick;
    // The handler is already set via addEventListener, so we add a parallel kickoff
    document.getElementById('btn-img-generate')?.addEventListener('click', async () => {
        // Start image preprocessing in the background (don't await)
        // This pre-warms the preprocessing so when API generate is clicked,
        // the images are already processed
        const platform = document.getElementById('cfg-api-platform')?.value || 'runninghub';
        if (platform === 'oaihk') {
            const slotsWithImages = imageState.slots.filter(s => s.image);
            if (slotsWithImages.length > 0) {
                const aspectRatio = document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4';
                const modelId = document.getElementById('cfg-oaihk-model-inline')?.value;
                const model = OAIHK_MODELS[modelId];
                const shortEdge = model?.shortEdge || 1536;
                const imageUrls = slotsWithImages.map(s => s.image);
                // Start preprocessing in background (fire and forget)
                preprocessingPromise = uploadToTmpfilesParallel(imageUrls, aspectRatio, shortEdge)
                    .then(urls => { preprocessedImagesCache = urls; })
                    .catch(() => { preprocessedImagesCache = null; });
            }
        }
    });
})();

// ========== 4.4 Polling Optimization: Exponential Backoff ==========
const POLL_DELAYS = [500, 1000, 2000, 3000];

// Replace pollUntilDone with exponential backoff version
const _origPollUntilDone = pollUntilDone;
pollUntilDone = async function pollUntilDoneBackoff(apiKey, baseUrl, taskId, startTime = Date.now(), qi, signal) {
    const maxPolls = 120;
    const isCancelled = () => qi !== undefined ? queueGenerateStates[qi]?.cancelled : apiGenerateState.cancelled;
    for (let i = 0; i < maxPolls; i++) {
        if (isCancelled()) return null;
        const delay = POLL_DELAYS[Math.min(i, POLL_DELAYS.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        if (isCancelled()) return null;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const ph = document.getElementById(`api-generating-placeholder-queue${qi}`) || document.getElementById('api-generating-placeholder');
        if (ph) ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在绘制中... (${elapsed}秒，第${i+1}次查询)`;
        if (activeQueue === qi) setApiProgress(10 + 80 * ((i + 1) / maxPolls));
        try {
            const data = await api('POST', '/api/rh-proxy', {
                action: 'query',
                api_key: apiKey,
                base_url: baseUrl,
                task_id: taskId
            }, undefined, signal);
            if (data.status === 'SUCCESS') return data;
            if (data.status === 'FAILED') {
                showToast('生成失败: ' + (data.errorMessage || '未知错误'), 'error');
                return null;
            }
        } catch (e) {
            if (isCancelled()) return null;
            console.warn('轮询出错:', e);
        }
    }
    if (!isCancelled()) showToast('生成超时', 'error');
    return null;
};

// Replace pollOAIHK with exponential backoff version
const _origPollOAIHK = pollOAIHK;
pollOAIHK = async function pollOAIHKBackoff(apiKey, baseUrl, pollEndpoint, requestId, qi, signal, statusSlotIndex) {
    const maxPolls = 120;
    const isCancelled = () => qi !== undefined ? queueGenerateStates[qi]?.cancelled : apiGenerateState.cancelled;
    let queueCount = 0;
    for (let i = 0; i < maxPolls; i++) {
        if (isCancelled()) return null;
        const delay = POLL_DELAYS[Math.min(i, POLL_DELAYS.length - 1)];
        await new Promise(r => setTimeout(r, delay));
        if (isCancelled()) return null;
        const ph = document.getElementById(`api-generating-placeholder-queue${qi}`) || document.getElementById('api-generating-placeholder');
        const elapsed = Math.round((i + 1) * 3);
        const pendingStatusEl = statusSlotIndex !== undefined && statusSlotIndex !== null
            ? document.getElementById('api-result-grid')?.querySelector(`.api-result-pending-card[data-slot-index="${statusSlotIndex}"] .api-result-pending-status`)
            : null;
        try {
            const data = await api('POST', '/api/oaihk-proxy', {
                action: 'poll',
                api_key: apiKey,
                base_url: baseUrl,
                poll_endpoint: pollEndpoint,
                request_id: requestId
            }, undefined, signal);
            if (data.images && data.images.length > 0) return data;
            if (data.status === 'FAILED') {
                showToast('生成失败: ' + (data.error || '未知错误'), 'error');
                return null;
            }
            // 跟踪排队状态
            if (data.status === 'IN_QUEUE') {
                queueCount++;
                const extra = queueCount > 10 ? '<br><span style="font-size:10px;color:#e67e22;">排队较久，API服务器可能繁忙，请耐心等待或取消重试</span>' : '';
                if (pendingStatusEl) {
                    pendingStatusEl.innerHTML = `<span class="loading" style="display:inline-block;"></span> 排队等待中...（已等${elapsed}秒，第${i+1}次查询）${extra}`;
                } else if (ph) {
                    ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 排队等待中...（已等${elapsed}秒，第${i+1}次查询）${extra}`;
                }
            } else {
                if (pendingStatusEl) {
                    pendingStatusEl.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在绘制中...（${elapsed}秒，第${i+1}次查询）`;
                } else if (ph) {
                    ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在绘制中...（${elapsed}秒，第${i+1}次查询）`;
                }
            }
            if (activeQueue === qi) setApiProgress(40 + Math.min(55, 30 * Math.log10(i + 1)));
        } catch (e) {
            if (isCancelled()) return null;
            console.warn('OpenAI-HK 轮询出错:', e);
        }
    }
    if (!isCancelled()) showToast('OpenAI-HK 生成超时（排队过久），建议稍后重试', 'error');
    return null;
};

// Exponential backoff poll for the old RH handler (replaces setInterval)
function _startPollWithBackoff(apiKey, baseUrl, attempt) {
    if (apiGenerateState.cancelled || !apiGenerateState.running) return;
    const POLL_DELAYS_OLD = [500, 1000, 2000, 3000];
    const delay = POLL_DELAYS_OLD[Math.min(attempt, POLL_DELAYS_OLD.length - 1)];
    apiGenerateState.pollTimer = setTimeout(() => {
        pollApiResult(apiKey, baseUrl).then(() => {
            // If still running after pollApiResult, continue polling
            if (apiGenerateState.running && !apiGenerateState.cancelled) {
                _startPollWithBackoff(apiKey, baseUrl, attempt + 1);
            }
        });
    }, delay);
}

// ========== 自动更新系统 ==========
(function initUpdateSystem() {
    const updateModal = document.getElementById('modal-update');
    const btnCheck = document.getElementById('btn-check-update');
    const btnDo = document.getElementById('btn-update-do');
    const btnClose = document.getElementById('btn-update-close');
    const dot = document.getElementById('update-dot');

    // 各状态面板
    const panels = {
        checking: document.getElementById('update-checking'),
        available: document.getElementById('update-available'),
        latest: document.getElementById('update-latest'),
        progress: document.getElementById('update-progress'),
        error: document.getElementById('update-error')
    };

    function showPanel(name) {
        for (const [k, el] of Object.entries(panels)) {
            el.style.display = k === name ? 'block' : 'none';
        }
    }

    function openModal() {
        updateModal.style.display = 'flex';
    }
    function closeModal() {
        updateModal.style.display = 'none';
        if (_updatePollInterval) { clearInterval(_updatePollInterval); _updatePollInterval = null; }
    }

    // 关闭按钮
    btnClose?.addEventListener('click', closeModal);
    updateModal?.querySelector('.modal-close')?.addEventListener('click', closeModal);
    updateModal?.addEventListener('click', (e) => {
        if (e.target === updateModal) closeModal();
    });

    // 存储最新检查结果
    let lastCheckResult = null;
    let _updatePollInterval = null;

    // 检查更新
    async function checkUpdate() {
        showPanel('checking');
        btnDo.style.display = 'none';
        openModal();

        try {
            const result = await api('GET', '/api/check-update');
            lastCheckResult = result;

            if (result.error && !result.has_update) {
                showPanel('error');
                document.getElementById('update-error-msg').textContent = '检查失败: ' + result.error;
                return;
            }

            if (result.has_update) {
                showPanel('available');
                document.getElementById('update-new-ver').textContent = result.remote_version;
                document.getElementById('update-cur-ver').textContent = result.local_version;
                document.getElementById('update-notes').textContent = result.release_notes || '暂无更新说明';
                btnDo.style.display = 'inline-flex';
                // 显示红点
                if (dot) dot.style.display = 'block';
            } else {
                showPanel('latest');
                document.getElementById('update-latest-ver').textContent = result.local_version || '1.0.0';
                if (dot) dot.style.display = 'none';
            }
        } catch (e) {
            showPanel('error');
            document.getElementById('update-error-msg').textContent = '网络错误: ' + e.message;
        }
    }

    // 点击检查更新按钮
    btnCheck?.addEventListener('click', () => checkUpdate());

    // 点击立即更新
    btnDo?.addEventListener('click', async () => {
        if (!lastCheckResult?.download_url) {
            showToast('缺少下载链接，请重新检查更新', 'error');
            return;
        }
        showPanel('progress');
        btnDo.style.display = 'none';
        btnClose.style.display = 'none';

        try {
            await api('POST', '/api/do-update', { download_url: lastCheckResult.download_url });
            // 开始轮询更新进度
            let pollCount = 0;
            _updatePollInterval = setInterval(async () => {
                pollCount++;
                try {
                    const status = await api('GET', '/api/update-status');
                    const text = document.getElementById('update-progress-text');
                    if (text) text.textContent = status.progress || '正在更新...';
                    if (!status.running && status.error) {
                        clearInterval(_updatePollInterval); _updatePollInterval = null;
                        showPanel('error');
                        document.getElementById('update-error-msg').textContent = '更新失败: ' + status.error;
                        btnClose.style.display = 'inline-flex';
                    }
                    // 如果更新完成，服务会重启，页面会断开连接
                    if (pollCount > 60) {
                        clearInterval(_updatePollInterval); _updatePollInterval = null;
                        showPanel('error');
                        document.getElementById('update-error-msg').textContent = '更新超时，请手动重启软件';
                        btnClose.style.display = 'inline-flex';
                    }
                } catch (e) {
                    // 连接断开说明服务正在重启
                    clearInterval(_updatePollInterval); _updatePollInterval = null;
                    const text = document.getElementById('update-progress-text');
                    if (text) text.textContent = '更新完成，正在重启...';
                    setTimeout(() => {
                        location.reload();
                    }, 3000);
                }
            }, 2000);
        } catch (e) {
            showPanel('error');
            document.getElementById('update-error-msg').textContent = '启动更新失败: ' + e.message;
            btnClose.style.display = 'inline-flex';
        }
    });

    // 启动时静默检查一次（仅显示红点，不弹窗）
    setTimeout(async () => {
        try {
            const result = await api('GET', '/api/check-update');
            if (result.has_update && dot) {
                dot.style.display = 'block';
                lastCheckResult = result;
            }
        } catch (e) { /* 静默忽略 */ }
    }, 5000);
})();

// ========== 拆图模式（独立模块） ==========

// 非裁剪模式固定前缀（不可删除/修改，{N}自动替换为编号）
const SPLIT_NOCROP_FIXED_PREFIX = '为我生成图片的第{N}张 ';

// ========== 拆图模板管理系统 ==========
const SPLIT_TEMPLATE_MAX = 10;
const SPLIT_TEMPLATE_STORAGE_KEY = 'gridSplitTemplates_v2';

function _getSplitTemplates() {
    try {
        const raw = localStorage.getItem(SPLIT_TEMPLATE_STORAGE_KEY);
        if (raw) return JSON.parse(raw);
    } catch (e) {}
    // 默认模板
    return {
        crop: [
            { name: '默认', content: '为我生成图片第{N}张的单独图片 要保持画面不变，超写实人像，原相机直出，高清 8K，超细腻皮肤，自然原生肤质，轻微皮肤肌理，不磨皮过度，真实光影，室内柔光，层次渐变光影，胶片质感，真人实拍，高级写真质感，景深虚化，构图专业，色彩自然真实，无 AI 畸形，无假脸，无塑料皮肤 耳边胎毛碎发，轻微自然凌乱微风吹动发丝轻轻飘动，发丝透气不结块，自然蓬松，真实头皮衔接，不僵硬不假发 发质真实有层次，发丝根根分明，脸颊两侧鬓角各垂两缕轻薄碎发 表情要灵动自然纹理' }
        ],
        nocrop: [
            { name: '默认', content: ' 要保持画面不变，超写实人像，原相机直出，高清 8K，超细腻皮肤，自然原生肤质，轻微皮肤肌理，不磨皮过度，真实光影，室内柔光，层次渐变光影，胶片质感，真人实拍，高级写真质感，景深虚化，构图专业，色彩自然真实，无 AI 畸形，无假脸，无塑料皮肤 耳边胎毛碎发，轻微自然凌乱微风吹动发丝轻轻飘动，发丝透气不结块，自然蓬松，真实头皮衔接，不僵硬不假发 发质真实有层次，发丝根根分明，脸颊两侧鬓角各垂两缕轻薄碎发 表情要灵动自然纹理' }
        ]
    };
}

function _saveSplitTemplates(templates) {
    localStorage.setItem(SPLIT_TEMPLATE_STORAGE_KEY, JSON.stringify(templates));
}

function _getCurrentModeTemplates() {
    const mode = getCurrentSplitMode();
    const all = _getSplitTemplates();
    return all[mode] || [];
}

function renderSplitTemplateButtons() {
    const bar = document.getElementById('split-template-btn-bar');
    if (!bar) return;
    bar.innerHTML = '';
    const mode = getCurrentSplitMode();
    const templates = _getCurrentModeTemplates();
    templates.forEach((t, idx) => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-compact';
        btn.style.cssText = 'font-size:10px;padding:2px 8px;border-radius:4px;';
        btn.textContent = t.name;
        btn.title = t.content.substring(0, 60) + (t.content.length > 60 ? '...' : '');
        btn.addEventListener('click', () => {
            const templateEl = document.getElementById('split-prompt-template');
            if (!templateEl) return;
            if (mode === 'nocrop') {
                templateEl.value = SPLIT_NOCROP_FIXED_PREFIX + t.content;
            } else {
                templateEl.value = t.content;
            }
            _updateSplitTemplateReadOnlyStyle(templateEl, mode);
            // 高亮当前选中
            bar.querySelectorAll('button').forEach(b => b.style.background = '');
            btn.style.background = 'var(--accent)';
            btn.style.color = '#fff';
        });
        bar.appendChild(btn);
    });
}

function openSplitTemplateAddModal() {
    // 直接打开管理弹窗，并自动添加一个空白模板行
    openSplitTemplateManageModal(true);
}

function openSplitTemplateManageModal(autoAddNew) {
    const mode = getCurrentSplitMode();
    const all = _getSplitTemplates();
    if (!all[mode]) all[mode] = [];

    // 创建管理弹窗
    let modal = document.getElementById('modal-split-template-manage');
    if (modal) modal.remove();

    modal = document.createElement('div');
    modal.id = 'modal-split-template-manage';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const box = document.createElement('div');
    box.className = 'resizable-modal';
    box.style.cssText = 'background:var(--card-bg);border-radius:12px;padding:20px;min-width:420px;width:720px;max-width:92vw;min-height:300px;height:70vh;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,0.3);resize:both;overflow:hidden;';

    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0;';
    const title = document.createElement('h3');
    title.textContent = `${mode === 'crop' ? '裁剪' : '非裁剪'}模式模板管理`;
    title.style.cssText = 'margin:0;font-size:15px;';
    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&times;';
    closeBtn.style.cssText = 'background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted);padding:0 4px;line-height:1;';
    closeBtn.addEventListener('click', () => modal.remove());
    headerRow.appendChild(title);
    headerRow.appendChild(closeBtn);
    box.appendChild(headerRow);

    const listWrap = document.createElement('div');
    listWrap.style.cssText = 'flex:1;overflow-y:auto;margin-bottom:12px;';

    function renderTemplateRows() {
        listWrap.innerHTML = '';
        const templates = all[mode] || [];
        if (templates.length === 0) {
            listWrap.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px 0;text-align:center;">暂无模板，点击下方「添加模板」新建</div>';
            return;
        }
        templates.forEach((t, idx) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;padding:8px;background:var(--bg);border-radius:6px;';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.value = t.name;
            nameInput.placeholder = '模板名称';
            nameInput.style.cssText = 'flex:0 0 100px;padding:6px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text);';

            const contentInput = document.createElement('textarea');
            contentInput.value = t.content;
            contentInput.rows = 3;
            contentInput.placeholder = '提示词内容';
            contentInput.style.cssText = 'flex:1;padding:6px 8px;font-size:12px;border:1px solid var(--border);border-radius:4px;background:var(--input-bg);color:var(--text);resize:vertical;min-height:60px;';

            const delBtn = document.createElement('button');
            delBtn.textContent = '删除';
            delBtn.className = 'btn btn-compact';
            delBtn.style.cssText = 'font-size:10px;padding:4px 8px;color:#e74c3c;border-color:#e74c3c;flex-shrink:0;';
            delBtn.addEventListener('click', () => {
                all[mode].splice(idx, 1);
                renderTemplateRows();
            });

            row.appendChild(nameInput);
            row.appendChild(contentInput);
            row.appendChild(delBtn);
            listWrap.appendChild(row);
        });
    }

    renderTemplateRows();
    box.appendChild(listWrap);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;justify-content:space-between;gap:8px;flex-shrink:0;';

    // 添加模板按钮
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ 添加模板';
    addBtn.className = 'btn btn-outline btn-compact';
    addBtn.style.cssText = 'font-size:12px;';
    addBtn.addEventListener('click', () => {
        if (all[mode].length >= SPLIT_TEMPLATE_MAX) {
            showToast(`最多添加 ${SPLIT_TEMPLATE_MAX} 个模板`, 'warning');
            return;
        }
        all[mode].push({ name: '', content: '' });
        renderTemplateRows();
        // 滚动到底部并聚焦新行的名称输入框
        listWrap.scrollTop = listWrap.scrollHeight;
        const lastRow = listWrap.lastElementChild;
        if (lastRow) {
            const nameInput = lastRow.querySelector('input');
            if (nameInput) nameInput.focus();
        }
    });

    const rightBtns = document.createElement('div');
    rightBtns.style.cssText = 'display:flex;gap:8px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '取消';
    cancelBtn.className = 'btn btn-outline btn-compact';
    cancelBtn.addEventListener('click', () => modal.remove());

    const saveBtn = document.createElement('button');
    saveBtn.textContent = '保存修改';
    saveBtn.className = 'btn btn-compact';
    saveBtn.style.cssText = 'background:var(--accent);color:#fff;';
    saveBtn.addEventListener('click', () => {
        const rows = listWrap.querySelectorAll('div[style*="margin-bottom"]');
        const updated = [];
        rows.forEach(row => {
            const inputs = row.querySelectorAll('input, textarea');
            const name = inputs[0].value.trim();
            const content = inputs[1].value.trim();
            if (name && content) updated.push({ name, content });
        });
        if (updated.length === 0) {
            showToast('至少保留一个模板', 'warning');
            return;
        }
        all[mode] = updated;
        _saveSplitTemplates(all);
        modal.remove();
        renderSplitTemplateButtons();
        showToast('模板已更新', 'success');
    });

    rightBtns.appendChild(cancelBtn);
    rightBtns.appendChild(saveBtn);
    btnRow.appendChild(addBtn);
    btnRow.appendChild(rightBtns);
    box.appendChild(btnRow);
    modal.appendChild(box);
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    // 如果是从"添加模板"按钮进入，自动添加一个空白行
    if (autoAddNew) {
        if (all[mode].length < SPLIT_TEMPLATE_MAX) {
            all[mode].push({ name: '', content: '' });
            renderTemplateRows();
            listWrap.scrollTop = listWrap.scrollHeight;
            const lastRow = listWrap.lastElementChild;
            if (lastRow) {
                const nameInput = lastRow.querySelector('input');
                if (nameInput) nameInput.focus();
            }
        }
    }
}

// ========== 拆图素材槽位 ==========

function _initSplitMaterialSlots() {
    document.querySelectorAll('.split-material-slot').forEach(slot => {
        if (slot.dataset.splitMatBound) return;
        slot.dataset.splitMatBound = '1';
        const slotIdx = parseInt(slot.dataset.slot, 10);
        slot.addEventListener('click', () => _handleSplitMaterialSlotClick(slotIdx));
        slot.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); slot.classList.add('drag-over'); });
        slot.addEventListener('dragleave', (e) => {
            if (slot.contains(e.relatedTarget)) return;
            slot.classList.remove('drag-over');
        });
        slot.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            slot.classList.remove('drag-over');
            const lib = parseLibMaterialDragPayload(e.dataTransfer);
            if (lib?.url) {
                applyLibraryPayloadToSplitMaterialSlot(slotIdx, lib);
                return;
            }
            const files = Array.from(e.dataTransfer.files || []).filter(f => f.type.startsWith('image/'));
            if (!files.length) return;
            const qItem = getActiveSplitWorkItem(activeSplitQueue);
            if (!qItem) {
                showToast('请先完成九宫格拆分并选中编号', 'warning');
                return;
            }
            try {
                const fd = new FormData();
                fd.append('file', files[0]);
                const resp = await fetch('/api/upload-image', { method: 'POST', body: fd });
                const result = await resp.json();
                if (result.url) {
                    if (!qItem.materials) qItem.materials = [null, null, null];
                    qItem.materials[slotIdx] = result.url;
                    _renderSplitMaterialSlot(slotIdx);
                    saveSplitQueueData();
                    showToast('素材已添加', 'success');
                } else {
                    showToast('上传失败: ' + (result.error || ''), 'error');
                }
            } catch (err) {
                showToast('上传失败: ' + err.message, 'error');
            }
        });
    });
}

function _handleSplitMaterialSlotClick(slotIdx) {
    const qi = activeSplitQueue;
    if (qi < 0 || qi >= splitQueueData.length) return;
    const qd = splitQueueData[qi];
    const item = getActiveSplitWorkItem(qi);
    if (!item) return;

    // 初始化素材数组
    if (!item.materials) item.materials = [null, null, null];

    // 如果已有素材，点击删除
    if (item.materials[slotIdx]) {
        item.materials[slotIdx] = null;
        _renderSplitMaterialSlot(slotIdx);
        saveSplitQueueData();
        return;
    }

    // 没有素材，点击上传
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const fd = new FormData();
            fd.append('file', file);
            const resp = await fetch('/api/upload-image', { method: 'POST', body: fd });
            const result = await resp.json();
            if (result.url) {
                if (!item.materials) item.materials = [null, null, null];
                item.materials[slotIdx] = result.url;
                _renderSplitMaterialSlot(slotIdx);
                saveSplitQueueData();
                showToast('素材已添加', 'success');
            } else {
                showToast('上传失败: ' + (result.error || ''), 'error');
            }
        } catch (err) {
            showToast('上传失败: ' + err.message, 'error');
        }
    };
    input.click();
}

function _renderSplitMaterialSlot(slotIdx) {
    const qi = activeSplitQueue;
    if (qi < 0 || qi >= splitQueueData.length) return;
    const item = getActiveSplitWorkItem(qi);
    const slot = document.querySelector(`.split-material-slot[data-slot="${slotIdx}"]`);
    if (!slot) return;

    const url = item?.materials?.[slotIdx];
    if (url) {
        slot.innerHTML = `<img src="${url}" style="width:100%;height:100%;object-fit:cover;border-radius:3px;">
            <div style="position:absolute;top:1px;right:1px;width:14px;height:14px;background:rgba(231,76,60,0.9);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:9px;color:#fff;line-height:1;">×</div>`;
        slot.style.borderStyle = 'solid';
        slot.style.borderColor = 'var(--accent)';
    } else {
        slot.innerHTML = '<span style="font-size:16px;color:var(--text-muted);">+</span>';
        slot.style.borderStyle = 'dashed';
        slot.style.borderColor = 'var(--border)';
    }
}

function _renderAllSplitMaterialSlots() {
    [0, 1, 2].forEach(i => _renderSplitMaterialSlot(i));
}

/** 多素材时对每个九宫格分别尝试文件名自动拆分 */
async function splitAutoDetectFilenameAllMaterials(qi) {
    const qd = splitQueueData[qi];
    if (!qd) return;
    normalizeSplitQueueMaterials(qd);
    if (!qd.materials || qd.materials.length <= 1) {
        await maybeAutoSplitFromFilename(qi);
        return;
    }
    persistActiveSplitMaterial(qd);
    const savedIdx = Math.max(0, Math.min(qd.activeMaterialIndex || 0, qd.materials.length - 1));
    for (let mi = 0; mi < qd.materials.length; mi++) {
        loadActiveSplitMaterialIntoQueue(qd, mi);
        splitImageUrl = qd.gridImageUrl || '';
        splitGridImageUrl = splitImageUrl;
        const imgEl = document.getElementById('split-img');
        if (imgEl && splitImageUrl) imgEl.src = splitImageUrl;
        await maybeAutoSplitFromFilename(qi);
        persistActiveSplitMaterial(qd);
    }
    loadActiveSplitMaterialIntoQueue(qd, savedIdx);
    splitImageUrl = qd.gridImageUrl || '';
    splitGridImageUrl = splitImageUrl;
    const imgEl2 = document.getElementById('split-img');
    if (imgEl2) imgEl2.src = splitImageUrl || '';
    renderSplitMaterialTabs(qi);
    renderSplitNumSelectionForQueue(qi);
    renderSplitWorkItemTabs(qi);
    loadSplitQueueToUI(qi);
}

// 拆图上传处理（单文件 / 多文件）
async function handleSplitUpload(source) {
    const files = Array.isArray(source)
        ? source.filter(Boolean)
        : (source instanceof FileList ? Array.from(source) : (source ? [source] : []));
    const images = files.filter(f => f && f.type && f.type.startsWith('image/'));
    if (!images.length) return;

    try {
        switchMode('split');
        const qi = activeSplitQueue;
        const qd = splitQueueData[qi];
        if (!qd) return;

        if (images.length > 1) {
            let take = images;
            if (images.length > SPLIT_MAX_MATERIALS) {
                showToast(`最多上传 ${SPLIT_MAX_MATERIALS} 张，已仅保留前 ${SPLIT_MAX_MATERIALS} 张`, 'warning');
                take = images.slice(0, SPLIT_MAX_MATERIALS);
            }
            saveCurrentSplitQueueData();
            const uploaded = [];
            for (const file of take) {
                const fd = new FormData();
                fd.append('file', file);
                uploaded.push({ url: await uploadImage(fd), name: file.name || '' });
            }
            qd.progressTotal = 0;
            qd.progressDone = 0;
            qd.materials = uploaded.map(({ url, name }) => ({
                gridImageUrl: url,
                sourceFilename: name,
                selectedNums: [],
                learnedGridLayout: null,
                cropPreset: qd.cropPreset ?? null,
                workItems: []
            }));
            qd.activeMaterialIndex = 0;
            loadActiveSplitMaterialIntoQueue(qd, 0);
            splitImageUrl = qd.gridImageUrl || '';
            splitGridImageUrl = splitImageUrl;
            const imgEl = document.getElementById('split-img');
            if (imgEl) imgEl.src = splitImageUrl;
            const previewEl = document.getElementById('split-preview');
            const dropZoneEl = document.getElementById('split-drop-zone');
            if (previewEl) previewEl.style.display = '';
            if (dropZoneEl) dropZoneEl.style.display = 'none';
            renderSplitMaterialTabs(qi);
            renderSplitWorkItemTabs(qi);
            updateSplitGenerateBtnState();
            await splitAutoDetectFilenameAllMaterials(qi);
            saveSplitQueueData();
            renderSplitQueueNumberBar();
            showToast(`已加载 ${take.length} 张素材，可用上方「素材」切换`, 'success');
            return;
        }

        const file = images[0];
        const formData = new FormData();
        formData.append('file', file);
        const url = await uploadImage(formData);

        normalizeSplitQueueMaterials(qd);
        persistActiveSplitMaterial(qd);

        if (qd.materials.length > 1) {
            const idx = Math.max(0, Math.min(qd.activeMaterialIndex || 0, qd.materials.length - 1));
            const m = qd.materials[idx];
            if (m) {
                m.gridImageUrl = url;
                m.sourceFilename = file.name || '';
                m.workItems = [];
                m.selectedNums = [];
                m.learnedGridLayout = null;
            }
            loadActiveSplitMaterialIntoQueue(qd, idx);
            splitImageUrl = url;
            splitGridImageUrl = url;
            persistActiveSplitMaterial(qd);
        } else {
            splitImageUrl = url;
            splitGridImageUrl = url;
            qd.gridImageUrl = url;
            qd.workItems = [];
            qd.activeItemIndex = 0;
            qd.learnedGridLayout = null;
            qd.sourceFilename = file.name || '';
            normalizeSplitQueueMaterials(qd);
            persistActiveSplitMaterial(qd);
        }

        const imgEl = document.getElementById('split-img');
        if (imgEl) imgEl.src = url;
        document.getElementById('split-preview').style.display = '';
        document.getElementById('split-drop-zone').style.display = 'none';
        renderSplitMaterialTabs(qi);
        renderSplitWorkItemTabs(activeSplitQueue);
        updateSplitGenerateBtnState();
        await maybeAutoSplitFromFilename(activeSplitQueue);
        saveSplitQueueData();
        renderSplitQueueNumberBar();
    } catch (e) {
        showToast('上传九宫格图片失败: ' + e.message, 'error');
    }
}

function resetSplitPreview() {
    splitImageUrl = '';
    const qd = splitQueueData[activeSplitQueue];
    if (qd) {
        qd.gridImageUrl = '';
        qd.sourceFilename = '';
        qd.learnedGridLayout = null;
        qd.materials = [];
        qd.activeMaterialIndex = 0;
        normalizeSplitQueueMaterials(qd);
        loadActiveSplitMaterialIntoQueue(qd, 0);
    }
    document.getElementById('split-preview').style.display = 'none';
    document.getElementById('split-drop-zone').style.display = '';
    document.getElementById('split-img').src = '';
    const fileInput = document.getElementById('split-file');
    if (fileInput) fileInput.value = '';
    renderSplitMaterialTabs(activeSplitQueue);
    renderSplitWorkItemTabs(activeSplitQueue);
    updateSplitGenerateBtnState();
}

function loadSplitTemplate(mode) {
    const templateEl = document.getElementById('split-prompt-template');
    if (!templateEl) return;

    const templates = _getSplitTemplates();
    const modeTemplates = templates[mode] || [];
    // 加载第一个模板（默认模板）
    const firstTemplate = modeTemplates[0];

    if (mode === 'nocrop') {
        const userPart = firstTemplate ? firstTemplate.content : '';
        templateEl.value = SPLIT_NOCROP_FIXED_PREFIX + userPart;
        templateEl.dataset.nocropMode = '1';
        templateEl.dataset.fixedPrefixLen = String(SPLIT_NOCROP_FIXED_PREFIX.length);
        _updateSplitTemplateReadOnlyStyle(templateEl, mode);
    } else {
        templateEl.value = firstTemplate ? firstTemplate.content : '';
        templateEl.dataset.nocropMode = '0';
        templateEl.dataset.fixedPrefixLen = '0';
        _updateSplitTemplateReadOnlyStyle(templateEl, mode);
    }

    // 渲染模板按钮
    renderSplitTemplateButtons();
}

// 非裁剪模式下，阻止用户删除/修改固定前缀
function _updateSplitTemplateReadOnlyStyle(templateEl, mode) {
    if (mode === 'nocrop') {
        // 使用beforeinput事件阻止对固定前缀的修改
        if (!templateEl._nocropGuardInstalled) {
            templateEl._nocropGuardInstalled = true;
            templateEl.addEventListener('beforeinput', (e) => {
                if (templateEl.dataset.nocropMode !== '1') return;
                const fixedLen = parseInt(templateEl.dataset.fixedPrefixLen || '0', 10);
                if (fixedLen <= 0) return;
                const selStart = templateEl.selectionStart;
                const selEnd = templateEl.selectionEnd;
                // 如果选区与固定前缀区域有重叠，阻止操作
                if (selStart < fixedLen) {
                    e.preventDefault();
                    // 将光标移到固定前缀之后
                    templateEl.setSelectionRange(fixedLen, Math.max(selEnd, fixedLen));
                    showToast('固定前缀不可修改，只能编辑后续内容', 'warning');
                }
            });
            // 阻止退格键删除固定前缀
            templateEl.addEventListener('keydown', (e) => {
                if (templateEl.dataset.nocropMode !== '1') return;
                const fixedLen = parseInt(templateEl.dataset.fixedPrefixLen || '0', 10);
                if (fixedLen <= 0) return;
                const pos = templateEl.selectionStart;
                if (e.key === 'Backspace' && pos <= fixedLen && templateEl.selectionStart === templateEl.selectionEnd) {
                    e.preventDefault();
                    if (pos > 0) templateEl.setSelectionRange(fixedLen, fixedLen);
                }
                if (e.key === 'Home') {
                    e.preventDefault();
                    templateEl.setSelectionRange(fixedLen, fixedLen);
                }
            });
            // 粘贴时确保不覆盖固定前缀
            templateEl.addEventListener('paste', (e) => {
                if (templateEl.dataset.nocropMode !== '1') return;
                const fixedLen = parseInt(templateEl.dataset.fixedPrefixLen || '0', 10);
                if (fixedLen <= 0) return;
                if (templateEl.selectionStart < fixedLen) {
                    e.preventDefault();
                    // 在固定前缀之后粘贴
                    const pastedText = (e.clipboardData || window.clipboardData).getData('text');
                    const before = templateEl.value.substring(0, fixedLen);
                    const after = templateEl.value.substring(templateEl.selectionEnd);
                    templateEl.value = before + pastedText + after;
                    templateEl.setSelectionRange(fixedLen + pastedText.length, fixedLen + pastedText.length);
                }
            });
        }
    }
}

function saveSplitTemplate(mode, template) {
    const key = mode === 'crop' ? 'gridSplitPromptTemplate_crop' : 'gridSplitPromptTemplate_nocrop';
    try { localStorage.setItem(key, template); } catch(e) {}
}

function getCurrentSplitMode() {
    return document.querySelector('input[name="split-mode"]:checked')?.value || 'crop';
}

function saveCurrentSplitTemplate() {
    const templateEl = document.getElementById('split-prompt-template');
    if (!templateEl) return;
    const mode = getCurrentSplitMode();
    const template = templateEl.value?.trim() || '';
    if (!template) {
        showToast('模板不能为空', 'warning');
        return;
    }
    // 保存到模板列表的第一个（默认模板）
    const all = _getSplitTemplates();
    if (!all[mode] || all[mode].length === 0) {
        all[mode] = [{ name: '默认', content: '' }];
    }
    if (mode === 'nocrop') {
        const fixedLen = parseInt(templateEl.dataset.fixedPrefixLen || '0', 10);
        all[mode][0].content = templateEl.value.substring(fixedLen);
    } else {
        all[mode][0].content = template;
    }
    _saveSplitTemplates(all);
    renderSplitTemplateButtons();
    showToast(`${mode === 'crop' ? '裁剪' : '非裁剪'}模式模板已保存`, 'success');
}

// ---------- 拆图左侧素材库（与图生图同一套 renderLibraryPanel） ----------
async function renderSplitLibrary() {
    const body = document.getElementById('split-library-body');
    if (!body) return;

    if (!imageState.loaded || !Array.isArray(imageState.library) || imageState.library.length === 0) {
        try {
            const libData = await api('GET', '/api/image-library');
            imageState.library = libData.categories || [];
            imageState.loaded = true;
        } catch (e) {
            body.innerHTML = '<p class="empty-hint">加载素材库失败</p>';
            return;
        }
    }

    const kw = (document.getElementById('split-img-lib-search')?.value || '').trim().toLowerCase();
    await renderLibraryPanel({
        containerId: 'split-library-body',
        keyword: kw,
        context: 'split'
    });
}

/** 从文件名解析拆图编号：末尾连续 1-9，或纯数字名；去重保序 */
function parseSplitNumbersFromFilename(filename) {
    const base = getFileBaseName(filename).trim();
    if (!base) return null;
    let digitRun = '';
    const suffixMatch = base.match(/([1-9]+)$/);
    if (suffixMatch) digitRun = suffixMatch[1];
    else if (/^[1-9]+$/.test(base)) digitRun = base;
    else return null;
    if (!digitRun || digitRun.length > 24) return null;
    const nums = [];
    const seen = new Set();
    for (const ch of digitRun) {
        const n = ch.charCodeAt(0) - 48;
        if (n >= 1 && n <= 9 && !seen.has(n)) {
            seen.add(n);
            nums.push(n);
        }
    }
    return nums.length ? nums : null;
}

function waitSplitImageNaturalSize(maxMs = 4000) {
    return new Promise(resolve => {
        const img = document.getElementById('split-img');
        const deadline = Date.now() + maxMs;
        function tick() {
            if (img?.naturalWidth > 0 && img?.naturalHeight > 0) {
                resolve(true);
                return;
            }
            if (Date.now() > deadline) {
                resolve(false);
                return;
            }
            requestAnimationFrame(tick);
        }
        tick();
    });
}

function inferSplitGridColsRows(qd, calibratedCropRect, calibratedNumber) {
    const nums = (qd.workItems || []).map(it => it.number).filter(n => Number.isFinite(n) && n >= 1 && n <= 9);
    const maxN = Math.max(calibratedNumber, ...nums, 1);
    if (maxN > 4) return { cols: 3, rows: 3 };
    const preset = qd.cropPreset || qd.workItems?.find(it => it.cropPreset)?.cropPreset;
    const ps = preset ? String(preset) : '';
    if (ps.startsWith('4grid')) return { cols: 2, rows: 2 };
    if (ps.includes('grid') && !ps.startsWith('4grid')) return { cols: 3, rows: 3 };
    const w = calibratedCropRect.w;
    if (w >= 0.41) return { cols: 2, rows: 2 };
    if (w <= 0.36) return { cols: 3, rows: 3 };
    return maxN <= 4 ? { cols: 2, rows: 2 } : { cols: 3, rows: 3 };
}

/** 用户校准某一编号后，推导格子并把同一队列其他编号的裁剪框对齐 */
function propagateLearnedSplitCropLayout(queueIdx, calibratedNumber, cropRect) {
    const qd = splitQueueData[queueIdx];
    if (!qd || !Array.isArray(qd.workItems) || qd.workItems.length === 0) return;
    if (!cropRect || calibratedNumber < 1 || calibratedNumber > 9) return;

    const { cols, rows } = inferSplitGridColsRows(qd, cropRect, calibratedNumber);
    const idx = calibratedNumber - 1;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    if (row >= rows || col >= cols) return;

    const cellW = cropRect.w;
    const cellH = cropRect.h;
    let ox = cropRect.x - col * cellW;
    let oy = cropRect.y - row * cellH;
    ox = Math.max(0, Math.min(ox, 1 - cols * cellW));
    oy = Math.max(0, Math.min(oy, 1 - rows * cellH));

    qd.learnedGridLayout = {
        cols,
        rows,
        cellW,
        cellH,
        originX: ox,
        originY: oy,
        calibratedFrom: calibratedNumber
    };

    const gridUrl = qd.gridImageUrl || splitImageUrl || '';

    qd.workItems.forEach(item => {
        const n = item.number;
        if (!Number.isFinite(n) || n < 1 || n > 9) return;
        item.gridImageUrl = item.gridImageUrl || gridUrl;
        if (n === calibratedNumber) {
            item.cropRect = { x: cropRect.x, y: cropRect.y, w: cropRect.w, h: cropRect.h };
            item.croppedImageUrl = '';
            return;
        }
        const i2 = n - 1;
        const c2 = i2 % cols;
        const r2 = Math.floor(i2 / cols);
        if (r2 >= rows || c2 >= cols) return;
        let nx = ox + c2 * cellW;
        let ny = oy + r2 * cellH;
        nx = Math.max(0, Math.min(nx, 1 - cellW));
        ny = Math.max(0, Math.min(ny, 1 - cellH));
        item.cropRect = { x: nx, y: ny, w: cellW, h: cellH };
        item.croppedImageUrl = '';
        if (item.cropPreset === undefined || item.cropPreset === null) item.cropPreset = qd.cropPreset;
    });

    syncActiveSplitItemToQueue(queueIdx);
}

/**
 * 将选中编号写入拆图队列 workItems。
 * @returns {boolean}
 */
function applySplitGridToQueue(targetQueue, numbers, opts = {}) {
    const skipOverwriteConfirm = opts.skipOverwriteConfirm === true;
    const silent = opts.silent === true;

    if (!splitImageUrl) {
        if (!silent) showToast('请先上传九宫格图片', 'warning');
        return false;
    }
    if (!numbers || numbers.length === 0) return false;

    const mode = opts.mode ?? document.querySelector('input[name="split-mode"]:checked')?.value ?? 'crop';
    const promptTemplate = opts.promptTemplate ?? document.getElementById('split-prompt-template')?.value.trim();
    if (!promptTemplate) {
        if (!silent) showToast('请填写提示词模板', 'warning');
        return false;
    }

    readSplitApiConfigToQueue(targetQueue);

    const targetQdPre = splitQueueData[targetQueue];
    normalizeSplitQueueMaterials(targetQdPre);
    persistActiveSplitMaterial(targetQdPre);

    const qdRef = splitQueueData[targetQueue];
    const currentApiConfig = {
        apiPlatform: qdRef.apiPlatform || 'oaihk',
        rhModelId: qdRef.rhModelId || '',
        oaihkModelId: qdRef.oaihkModelId || 'fal-ai/banana/v3.1/flash/2k',
        rhAspectRatio: qdRef.rhAspectRatio || '3:4',
        oaihkAspectRatio: qdRef.oaihkAspectRatio || '3:4',
        rhResolution: qdRef.rhResolution || '1k',
        rhCount: qdRef.rhCount || 1,
        rhSeedMode: qdRef.rhSeedMode || 'random',
        rhSeed: qdRef.rhSeed || '',
        downloadPath: qdRef.downloadPath || '',
        imagePrefix: qdRef.imagePrefix || '',
        autoBackup: qdRef.autoBackup !== false
    };

    const targetQd = splitQueueData[targetQueue];
    const oldCount = (targetQd?.workItems || []).length;
    if (oldCount > 0 && !skipOverwriteConfirm) {
        const matHint = (targetQd.materials || []).length > 1 ? `（当前素材 ${(targetQd.activeMaterialIndex || 0) + 1}）` : '';
        if (!confirm(`当前素材已有 ${oldCount} 个格子工作项${matHint}，确认覆盖？`)) return false;
    }

    const currentItem = getActiveSplitWorkItem(targetQueue);
    const inheritedPrefixIds = Array.isArray(currentItem?.selectedPrefixIds) ? [...currentItem.selectedPrefixIds] : [];
    const inheritedSuffixIds = Array.isArray(currentItem?.selectedSuffixIds) ? [...currentItem.selectedSuffixIds] : [];
    const effectivePreset = targetQd?.cropPreset || state.modelConfig?.defaultCropPreset || null;

    const splitImgEl = document.getElementById('split-img');
    const imgW = splitImgEl?.naturalWidth || 0;
    const imgH = splitImgEl?.naturalHeight || 0;

    const workItems = [];
    for (let i = 0; i < numbers.length; i++) {
        let defaultCropRect = null;
        if (mode === 'crop') {
            const n = numbers[i];
            if (effectivePreset && imgW && imgH) {
                defaultCropRect = getSplitCropPresetRect(effectivePreset, n, imgW, imgH);
            }
            if (!defaultCropRect) {
                const row = Math.floor((n - 1) / 3);
                const col = (n - 1) % 3;
                defaultCropRect = { x: col / 3, y: row / 3, w: 1 / 3, h: 1 / 3 };
            }
        }
        workItems.push({
            imageUrl: splitImageUrl,
            croppedImageUrl: '',
            gridImageUrl: splitImageUrl,
            cropRect: defaultCropRect,
            cropPreset: effectivePreset,
            promptCn: (promptTemplate.replace(/\{N\}/g, String(numbers[i])) || '').trim(),
            number: numbers[i],
            selectedPrefixIds: dedupeTemplateIds(inheritedPrefixIds),
            selectedSuffixIds: dedupeTemplateIds(inheritedSuffixIds)
        });
    }

    const materialsPreserve = splitQueueData[targetQueue].materials;
    const activeMiPreserve = splitQueueData[targetQueue].activeMaterialIndex;

    Object.assign(splitQueueData[targetQueue], currentApiConfig);
    splitQueueData[targetQueue].materials = materialsPreserve;
    splitQueueData[targetQueue].activeMaterialIndex = activeMiPreserve;
    splitQueueData[targetQueue].lastSplitPromptTemplate = promptTemplate;
    splitQueueData[targetQueue].gridImageUrl = splitImageUrl;
    splitQueueData[targetQueue].selectedNums = [...numbers];
    splitQueueData[targetQueue].cropPreset = effectivePreset;
    splitQueueData[targetQueue].workItems = workItems;
    splitQueueData[targetQueue].progressTotal = numbers.length;
    splitQueueData[targetQueue].progressDone = 0;
    splitQueueData[targetQueue].activeItemIndex = 0;
    splitQueueData[targetQueue].learnedGridLayout = null;
    splitQueueData[targetQueue].splitAspectRatioManualOverride = false;

    persistActiveSplitMaterial(splitQueueData[targetQueue]);

    syncActiveSplitItemToQueue(targetQueue);
    splitGridImageUrl = splitImageUrl;
    splitMode = mode;

    return true;
}

async function maybeAutoSplitFromFilename(qi) {
    const qd = splitQueueData[qi];
    if (!qd?.sourceFilename) return;
    const nums = parseSplitNumbersFromFilename(qd.sourceFilename);
    if (!nums?.length) return;

    await waitSplitImageNaturalSize();

    qd.selectedNums = [...nums];
    renderSplitNumSelectionForQueue(qi);

    const ok = applySplitGridToQueue(qi, nums, { skipOverwriteConfirm: true, silent: true });
    if (!ok) return;

    saveSplitQueueData();
    renderSplitNumSelectionForQueue(qi);
    renderSplitWorkItemTabs(qi);
    loadSplitQueueToUI(qi);
    renderSplitQueueNumberBar();
    updateSplitGenerateBtnState();
    showToast(`已从文件名识别编号：${nums.join('、')}，已填入队列`, 'success');
}

// 确认拆图：裁剪图片 → 填入拆图队列
async function confirmSplitGrid() {
    if (!splitImageUrl) {
        showToast('请先上传九宫格图片', 'warning');
        return;
    }
    const queueSelectedNums = Array.isArray(splitQueueData[activeSplitQueue]?.selectedNums) ? splitQueueData[activeSplitQueue].selectedNums : [];
    if (queueSelectedNums.length === 0) {
        showToast('请点选格子编号（1–9）', 'warning');
        return;
    }

    const ok = applySplitGridToQueue(activeSplitQueue, [...queueSelectedNums], { skipOverwriteConfirm: false });
    if (!ok) return;

    saveSplitQueueData();
    renderSplitNumSelectionForQueue(activeSplitQueue);
    loadSplitQueueToUI(activeSplitQueue);
    renderSplitQueueNumberBar();
    updateSplitGenerateBtnState();

    const qdPost = splitQueueData[activeSplitQueue];
    if (qdPost) normalizeSplitQueueMaterials(qdPost);
    const mh = qdPost && qdPost.materials.length > 1 ? `，素材 ${(qdPost.activeMaterialIndex || 0) + 1}` : '';
    showToast(`已在拆图队列 ${activeSplitQueue + 1}${mh} 创建 ${queueSelectedNums.length} 个格子工作项，可使用「拆图生成」或「批量生成」`, 'success');
}

// 拆图生成：只生成当前队列的当前选中项（单张）
async function runSplitGenerate(qi) {
    const qd = splitQueueData[qi];
    if (!qd || !Array.isArray(qd.workItems) || qd.workItems.length === 0) {
        showToast('该队列没有拆图数据', 'warning');
        return { cancelled: false, skipped: true };
    }
    const qs = splitGenerateStates[qi];
    if (qs.running) {
        showToast(`拆图队列${qi+1}正在生成中`, 'error');
        return { cancelled: false, skipped: true };
    }

    // 保存当前数据
    saveCurrentSplitQueueData();

    // 只生成当前活跃项（用户正在查看/编辑的那一张）
    const activeIdx = qd.activeItemIndex || 0;
    const item = qd.workItems[activeIdx];
    if (!item) {
        showToast('当前没有选中的拆图项', 'warning');
        return { cancelled: false, skipped: true };
    }

    // 校验提示词
    const prompt = (item.promptCn || '').trim();
    if (!prompt) {
        showToast(`格子编号 ${item.number || activeIdx + 1} 缺少提示词，请填写后再生成`, 'error');
        return { cancelled: false, skipped: true };
    }

    const platform = qd.apiPlatform || 'oaihk';
    if (platform === 'oaihk') {
        if (!OAIHK_MODELS[qd.oaihkModelId]) { showToast('请选择 OpenAI-HK 模型', 'error'); return { cancelled: false, skipped: true }; }
    } else {
        if (!RH_MODELS[qd.rhModelId]) { showToast('请选择模型', 'error'); return { cancelled: false, skipped: true }; }
    }

    qs.running = true;
    qs.cancelled = false;
    qs.abortController = new AbortController();
    const signal = qs.abortController.signal;
    qs.batchVisualTotal = 1;
    qs.batchVisualFilled = 0;
    updateSplitGenerateBtnState();

    const progressWrap = document.getElementById('split-progress-bar-wrap');
    const progressBar = document.getElementById('split-progress-bar');
    const progressText = document.getElementById('split-progress-text');
    if (qi === activeSplitQueue) {
        if (progressWrap) progressWrap.style.display = '';
        if (progressText) progressText.style.display = '';
        if (progressBar) progressBar.style.width = '0%';
        if (progressText) progressText.textContent = `队列${qi+1} 正在生成第${activeIdx+1}张...`;
        const splitGrid = document.getElementById('split-result-grid');
        renderSplitQueueResults(qi);
        appendSplitResultPendingSlots(splitGrid, 1);
    }

    const allResults = [];
    try {
        try {
        // 裁剪模式：优先按cropRect从原图实时裁剪
        let sourceUrl = '';
        const cropSourceUrl = getSplitCropSourceUrl(item, qd);
        if (item.cropRect && cropSourceUrl) {
            try {
                const cropResult = await api('POST', '/api/free-crop-image', {
                    image_url: cropSourceUrl,
                    x: item.cropRect.x, y: item.cropRect.y,
                    w: item.cropRect.w, h: item.cropRect.h
                });
                if (cropResult.ok && cropResult.url) {
                    sourceUrl = cropResult.url;
                    item.croppedImageUrl = cropResult.url;
                } else {
                    showToast(`格子编号 ${item.number} 裁剪失败`, 'warning');
                }
            } catch (e) {
                showToast(`格子编号 ${item.number} 裁剪请求失败: ${e.message}`, 'error');
            }
        }
        if (!sourceUrl) {
            sourceUrl = item.croppedImageUrl || item.imageUrl;
        }
        if (!sourceUrl) {
            showToast('没有可用的图片源', 'warning');
            if (qi === activeSplitQueue) {
                fillNextSplitPendingCard(document.getElementById('split-result-grid'), splitPendingStubCard('skip', '无可用图源'));
            }
        } else {
            let imageUrls = [sourceUrl];
            if (item.materials) {
                item.materials.forEach(m => { if (m) imageUrls.push(m); });
            }
            if (platform !== 'oaihk') {
                imageUrls = imageUrls.map(u => u.startsWith('/') ? window.location.origin + u : u);
            }
            const fullPrompt = buildSplitFullPrompt(item);
            const task = { prompt: fullPrompt, imageUrls, queueLabel: `拆图${item.number || (activeIdx + 1)}` };
            const taskResults = await generateSingleTaskForSplit(qi, task, platform, qd, signal);
            if (taskResults.length > 0) {
                const mid = qd.activeMaterialIndex || 0;
                for (const r of taskResults) {
                    r._regenPrompt = fullPrompt;
                    r._regenImageUrl = sourceUrl;
                    r.prompt = fullPrompt;
                    r._materialIndex = mid;
                }
                allResults.push(...taskResults);
                qd.results = (qd.results || []).concat(taskResults);
                saveSplitQueueData();
                if (qi === activeSplitQueue) {
                    const grid = document.getElementById('split-result-grid');
                    const results = qd.results || [];
                    const idx = results.length - 1;
                    fillNextSplitPendingCard(grid, createSplitResultCardElement(qi, results[idx], idx, results));
                }
            } else {
                showToast(`第${activeIdx+1}张未返回图片`, 'warning');
                if (qi === activeSplitQueue) {
                    fillNextSplitPendingCard(document.getElementById('split-result-grid'), splitPendingStubCard('fail', '未返图'));
                }
            }
        }
        } finally {
            const st = splitGenerateStates[qi];
            if (st && (st.batchVisualTotal || 0) > 0) {
                st.batchVisualFilled = Math.min(st.batchVisualTotal, (st.batchVisualFilled || 0) + 1);
            }
        }
    } catch (e) {
        if (!qs.cancelled) showToast(`拆图队列${qi+1}生成失败: ${e.message}`, 'error');
        if (qi === activeSplitQueue && document.getElementById('split-result-grid')?.querySelector('.split-result-pending-card')) {
            fillNextSplitPendingCard(document.getElementById('split-result-grid'), splitPendingStubCard('fail', '异常'));
        }
    }

    // 统一入图库
    if (allResults.length > 0 && qd.autoBackup !== false) {
        await autoBackupSplitResults(allResults, qi);
    }

    if (qi === activeSplitQueue) {
        clearRemainingSplitResultPendingSlots(document.getElementById('split-result-grid'));
        renderSplitQueueResults(qi);
    }

    persistActiveSplitMaterial(qd);

    qs.running = false;
    qs.cancelled = false;
    qs.abortController = null;
    qs.progressPercent = 0;
    qs.progressText = '';
    qs.batchVisualTotal = 0;
    qs.batchVisualFilled = 0;
    if (progressWrap) progressWrap.style.display = 'none';
    if (progressText) progressText.style.display = 'none';
    renderSplitQueueNumberBar();
    updateSplitGenerateBtnState();
    syncSplitProgressUI();
    saveSplitQueueData();

    if (allResults.length > 0) {
        showToast(`拆图队列 ${qi + 1} 格子编号 ${item.number || activeIdx + 1} 生成完成`, 'success');
    } else if (!qs.cancelled) {
        showToast('生成未产出结果', 'warning');
    }
    return { cancelled: qs.cancelled, skipped: false };
}

async function pollUntilDoneForSplit(apiKey, baseUrl, taskId, splitQueueIndex, signal, startTime = Date.now()) {
    const maxPolls = 120;
    const qsRh = splitGenerateStates[splitQueueIndex];
    for (let i = 0; i < maxPolls; i++) {
        if (splitGenerateStates[splitQueueIndex]?.cancelled) return null;
        await waitForSplitPollTick(signal, 3000);
        if (splitGenerateStates[splitQueueIndex]?.cancelled) return null;
        const elapsedSec = (i + 1) * 3;
        if (qsRh?.running) {
            qsRh.progressText = `队列${splitQueueIndex + 1}: RH 任务查询中…（约 ${elapsedSec}s）`;
            syncSplitProgressUI();
        }
        try {
            const data = await api('POST', '/api/rh-proxy', {
                action: 'query',
                api_key: apiKey,
                base_url: baseUrl,
                task_id: taskId
            }, 90000, signal);
            if (data.status === 'SUCCESS') return data;
            if (data.status === 'FAILED') return null;
        } catch (e) {
            if (splitGenerateStates[splitQueueIndex]?.cancelled) return null;
            console.warn('[拆图-RH轮询]', e);
        }
    }
    if (!splitGenerateStates[splitQueueIndex]?.cancelled) {
        showToast(`RunningHub 拆图任务轮询超时（约 ${maxPolls * 3}s），请检查任务状态或稍后重试`, 'warning');
    }
    return null;
}

async function pollOAIHKForSplit(pollEndpoint, requestId, splitQueueIndex, signal, taskLabel = '') {
    const maxPolls = 120;
    const qsPoll = splitGenerateStates[splitQueueIndex];
    const label = (taskLabel || '拆图').slice(0, 40);
    for (let i = 0; i < maxPolls; i++) {
        if (splitGenerateStates[splitQueueIndex]?.cancelled) return null;
        await waitForSplitPollTick(signal, 3000);
        if (splitGenerateStates[splitQueueIndex]?.cancelled) return null;
        const elapsedSec = (i + 1) * 3;
        if (qsPoll?.running) {
            qsPoll.progressText = `队列${splitQueueIndex + 1}: ${label} 等待出图…（约 ${elapsedSec}s，第 ${i + 1}/${maxPolls} 次查询）`;
            syncSplitProgressUI();
        }
        try {
            const data = await api('POST', '/api/oaihk-proxy', {
                action: 'poll',
                api_key: '',
                base_url: '',
                poll_endpoint: pollEndpoint,
                request_id: requestId
            }, 90000, signal);
            if (data.images && data.images.length > 0) return data;
            if (data.status === 'FAILED') return null;
        } catch (e) {
            if (splitGenerateStates[splitQueueIndex]?.cancelled) return null;
            console.warn('[拆图-HK轮询]', label, e);
        }
    }
    if (!splitGenerateStates[splitQueueIndex]?.cancelled) {
        showToast(`「${label}」OpenAI-HK 轮询超时（约 ${maxPolls * 3}s），可能仍在远端排队，可稍后单独对该格子「再生」`, 'warning');
    }
    return null;
}

async function waitForSplitPollTick(signal, totalMs = 3000) {
    // 分段等待，保证取消操作可以在200ms级别生效
    const step = 200;
    let elapsed = 0;
    while (elapsed < totalMs) {
        if (signal?.aborted) return;
        await new Promise(r => setTimeout(r, Math.min(step, totalMs - elapsed)));
        if (signal?.aborted) return;
        elapsed += step;
    }
}

async function enqueueSplitApiGeneration(qi, taskLabel, runner) {
    const jobId = ++splitApiDispatchSeq;
    const run = async () => {
        const state = splitGenerateStates[qi];
        if (state?.cancelled) return [];
        if (state?.running) {
            state.progressText = `队列${qi + 1}: ${taskLabel}（排队#${jobId}）`;
            syncSplitProgressUI();
        }
        return await runner();
    };
    const queued = splitApiDispatchChain.then(run, run);
    splitApiDispatchChain = queued.catch(() => {});
    return queued;
}

// 拆图专用：与图生图队列状态完全隔离，允许并行运行
async function generateSingleTaskForSplit(qi, task, platform, qd, signal, opts = {}) {
    if (opts?.bypassDispatchChain) {
        return generateSingleTaskForSplitCore(qi, task, platform, qd, signal);
    }
    return enqueueSplitApiGeneration(qi, task.queueLabel || '任务提交', () =>
        generateSingleTaskForSplitCore(qi, task, platform, qd, signal)
    );
}

async function generateSingleTaskForSplitCore(qi, task, platform, qd, signal) {
    const qs = splitGenerateStates[qi];
    const results = [];
    try {
        if (platform === 'oaihk') {
            const modelId = qd.oaihkModelId;
            const model = OAIHK_MODELS[modelId];
            const aspectRatio = qd.oaihkAspectRatio || '3:4';
            const shortEdge = model?.shortEdge || 1536;
            const publicUrls = [];
            const imgs = task.imageUrls || [];
            for (let ii = 0; ii < imgs.length; ii++) {
                if (qs.cancelled) break;
                if (qs.running) {
                    qs.progressText = `队列${qi + 1}: ${task.queueLabel || '拆图'} 预处理参考图 ${ii + 1}/${imgs.length}…`;
                    syncSplitProgressUI();
                }
                publicUrls.push(await uploadToTmpfiles(imgs[ii], aspectRatio, shortEdge));
            }
            if (qs.cancelled) return results;

            const splitHkTm = Math.min(Math.max(getOaihkGptClientTimeoutMs(), 120000), 600000);
            if (model?.isGptImage) {
                if (qs.running) {
                    qs.progressText = `队列${qi + 1}: ${task.queueLabel || '拆图'} 已提交 GPT，同步生成中（较慢）…`;
                    syncSplitProgressUI();
                }
                announceOaihkSubmit('拆图-GPT', {
                    model: model.modelId || 'gpt-image-2',
                    size: getOaihkImageSize(model, aspectRatio),
                    quality: getOaihkGptQuality(model)
                });
                const gptResp = await api('POST', '/api/oaihk-gpt-image', {
                    action: publicUrls.length > 0 ? 'edits' : 'generations',
                    model: model.modelId || 'gpt-image-2',
                    prompt: task.prompt,
                    size: getOaihkImageSize(model, aspectRatio),
                    quality: getOaihkGptQuality(model),
                    n: 1,
                    image_base64_list: publicUrls
                }, splitHkTm, signal);
                if (qs.cancelled) return results;
                if (gptResp.data && Array.isArray(gptResp.data)) {
                    for (const item of gptResp.data) {
                        const displayUrl = await displayUrlFromOaihkGptItem(item, signal);
                        if (!displayUrl) continue;
                        if (!item.b64_json && item.url && displayUrl === item.url) {
                            showToast(`${task.queueLabel}图片下载到本地失败，已使用外网URL（入图库可能失败）`, 'warning');
                        }
                        results.push({ url: displayUrl, checked: false, filename: `拆图_${task.queueLabel}_${results.length + 1}.jpg`, outputType: 'png' });
                    }
                }
            } else {
                const payload = { prompt: task.prompt, image_urls: publicUrls, num_images: 1, aspect_ratio: aspectRatio };
                if (model?.modelId) payload.model = model.modelId;
                if (qs.running) {
                    qs.progressText = `队列${qi + 1}: ${task.queueLabel || '拆图'} 已提交，等待排队/出图…`;
                    syncSplitProgressUI();
                }
                const submitData = await api('POST', '/api/oaihk-proxy', {
                    action: 'submit', api_key: '', base_url: '', endpoint: model.endpoint, model_id: modelId, params: payload
                }, splitHkTm, signal);
                if (!submitData.request_id) {
                    const errTxt = typeof submitData.error === 'string'
                        ? submitData.error
                        : (submitData.error?.message || submitData.detail || JSON.stringify(submitData).slice(0, 400));
                    if (!qs.cancelled) showToast(`${task.queueLabel || '拆图'} 提交失败: ${errTxt}`, 'error');
                    return results;
                }
                const result = await pollOAIHKForSplit(model.pollEndpoint, submitData.request_id, qi, signal, task.queueLabel || '');
                if (qs.cancelled) return results;
                if (result && result.images) {
                    for (const img of result.images) {
                        if (img.url) {
                            let displayUrl = img.url;
                            try {
                                const dlResp = await api('POST', '/api/download-image', { url: img.url }, splitHkTm, signal);
                                if (dlResp.data?.data_uri) displayUrl = dlResp.data.data_uri;
                            } catch (e) {
                                console.warn(`[拆图-OAIHK] 图片下载失败，使用原始URL: ${e.message}`);
                                showToast(`${task.queueLabel}图片下载到本地失败，已使用外网URL（入图库可能失败）`, 'warning');
                            }
                            results.push({ url: displayUrl, checked: false, filename: `拆图_${task.queueLabel}_${results.length + 1}.jpg`, outputType: 'png' });
                        }
                    }
                }
            }
        } else {
            const modelId = qd.rhModelId;
            const model = RH_MODELS[modelId];
            const rhApiKey = state.modelConfig.rh_api_key || '';
            const rhBaseUrl = state.modelConfig.rh_base_url || 'https://www.runninghub.cn/openapi/v2';
            const payload = { prompt: task.prompt };
            if (model?.type === 'image-to-image' && task.imageUrls.length > 0) payload.imageUrls = task.imageUrls;
            if (model?.hasResolution) payload.resolution = qd.rhResolution || '1k';
            if (qd.rhAspectRatio) payload.aspectRatio = qd.rhAspectRatio;

            if (qs.running) {
                qs.progressText = `队列${qi + 1}: ${task.queueLabel || '拆图'} RH 提交中…`;
                syncSplitProgressUI();
            }
            const data = await api('POST', '/api/rh-proxy', {
                action: 'submit', api_key: rhApiKey, base_url: rhBaseUrl, model_id: modelId, params: payload
            }, 180000, signal);
            if (data.status === 'FAILED') return results;
            if (!data.taskId) {
                if (!qs.cancelled) showToast(`${task.queueLabel || '拆图'} RH 提交未返回 taskId`, 'error');
                return results;
            }

            const result = await pollUntilDoneForSplit(rhApiKey, rhBaseUrl, data.taskId, qi, signal, Date.now());
            if (qs.cancelled) return results;
            if (result && result.results) {
                for (const r of result.results) {
                    if (r.url) results.push({ url: r.url, checked: false, filename: `拆图_${task.queueLabel}_${results.length+1}.${r.outputType || 'png'}`, outputType: r.outputType || 'png' });
                }
            }
        }
    } catch (e) {
        if (!qs.cancelled) showToast(`${task.queueLabel}生成失败: ${e.message}`, 'error');
    }
    return results;
}

async function submitSingleTaskForSplitAsync(qi, task, platform, qd, signal) {
    const qs = splitGenerateStates[qi];
    if (platform === 'oaihk') {
        const modelId = qd.oaihkModelId;
        const model = OAIHK_MODELS[modelId];
        if (model?.isGptImage) {
            const taskResults = await generateSingleTaskForSplitCore(qi, task, platform, qd, signal);
            return { waitForResults: async () => taskResults };
        }
        const aspectRatio = qd.oaihkAspectRatio || '3:4';
        const shortEdge = model?.shortEdge || 1536;
        const publicUrls = [];
        const imgs = task.imageUrls || [];
        for (let ii = 0; ii < imgs.length; ii++) {
            if (qs.cancelled || signal?.aborted) throw createSplitAbortError();
            if (qs.running) {
                qs.progressText = `队列${qi + 1}: ${task.queueLabel || '拆图'} 预处理参考图 ${ii + 1}/${imgs.length}…`;
                syncSplitProgressUI();
            }
            publicUrls.push(await uploadToTmpfiles(imgs[ii], aspectRatio, shortEdge));
        }
        if (qs.cancelled || signal?.aborted) throw createSplitAbortError();
        const payload = { prompt: task.prompt, image_urls: publicUrls, num_images: 1, aspect_ratio: aspectRatio };
        if (model?.modelId) payload.model = model.modelId;
        const splitHkTm = Math.min(Math.max(getOaihkGptClientTimeoutMs(), 120000), 600000);
        if (qs.running) {
            qs.progressText = `队列${qi + 1}: ${task.queueLabel || '拆图'} 已提交，继续下一张…`;
            syncSplitProgressUI();
        }
        const submitData = await api('POST', '/api/oaihk-proxy', {
            action: 'submit', api_key: '', base_url: '', endpoint: model.endpoint, model_id: modelId, params: payload
        }, splitHkTm, signal);
        if (!submitData.request_id) {
            const errTxt = typeof submitData.error === 'string'
                ? submitData.error
                : (submitData.error?.message || submitData.detail || JSON.stringify(submitData).slice(0, 400));
            throw new Error(`${task.queueLabel || '拆图'} 提交失败: ${errTxt}`);
        }
        return {
            waitForResults: async () => {
                const results = [];
                const result = await pollOAIHKForSplit(model.pollEndpoint, submitData.request_id, qi, signal, task.queueLabel || '');
                if (qs.cancelled || signal?.aborted) return results;
                if (result && result.images) {
                    for (const img of result.images) {
                        if (!img.url) continue;
                        let displayUrl = img.url;
                        try {
                            const dlResp = await api('POST', '/api/download-image', { url: img.url }, splitHkTm, signal);
                            if (dlResp.data?.data_uri) displayUrl = dlResp.data.data_uri;
                        } catch (e) {
                            console.warn(`[拆图-OAIHK] 图片下载失败，使用原始URL: ${e.message}`);
                            showToast(`${task.queueLabel}图片下载到本地失败，已使用外网URL（入图库可能失败）`, 'warning');
                        }
                        results.push({ url: displayUrl, checked: false, filename: `拆图_${task.queueLabel}_${results.length + 1}.jpg`, outputType: 'png' });
                    }
                }
                return results;
            }
        };
    }

    const modelId = qd.rhModelId;
    const model = RH_MODELS[modelId];
    const rhApiKey = state.modelConfig.rh_api_key || '';
    const rhBaseUrl = state.modelConfig.rh_base_url || 'https://www.runninghub.cn/openapi/v2';
    const payload = { prompt: task.prompt };
    if (model?.type === 'image-to-image' && task.imageUrls.length > 0) payload.imageUrls = task.imageUrls;
    if (model?.hasResolution) payload.resolution = qd.rhResolution || '1k';
    if (qd.rhAspectRatio) payload.aspectRatio = qd.rhAspectRatio;
    if (qs.running) {
        qs.progressText = `队列${qi + 1}: ${task.queueLabel || '拆图'} RH 已提交，继续下一张…`;
        syncSplitProgressUI();
    }
    const data = await api('POST', '/api/rh-proxy', {
        action: 'submit', api_key: rhApiKey, base_url: rhBaseUrl, model_id: modelId, params: payload
    }, 180000, signal);
    if (data.status === 'FAILED') throw new Error(`${task.queueLabel || '拆图'} RH 提交失败`);
    if (!data.taskId) throw new Error(`${task.queueLabel || '拆图'} RH 提交未返回 taskId`);
    return {
        waitForResults: async () => {
            const results = [];
            const result = await pollUntilDoneForSplit(rhApiKey, rhBaseUrl, data.taskId, qi, signal, Date.now());
            if (qs.cancelled || signal?.aborted) return results;
            if (result && result.results) {
                for (const r of result.results) {
                    if (r.url) results.push({ url: r.url, checked: false, filename: `拆图_${task.queueLabel}_${results.length + 1}.${r.outputType || 'png'}`, outputType: r.outputType || 'png' });
                }
            }
            return results;
        }
    };
}

// 拆图批量生成：所有有数据的队列
async function runSplitBatchGenerate() {
    const qi = activeSplitQueue;
    const qd = splitQueueData[qi];
    if (!qd || !Array.isArray(qd.workItems) || qd.workItems.length === 0) {
        showToast('当前队列没有拆图数据', 'warning');
        return { cancelled: false, skipped: true };
    }
    const qs = splitGenerateStates[qi];
    if (qs.running) {
        showToast(`队列${qi+1}正在生成中`, 'error');
        return { cancelled: false, skipped: true };
    }

    saveCurrentSplitQueueData();

    const validItems = (qd.workItems || []).filter(item => (item?.cropRect && getSplitCropSourceUrl(item, qd)) || item?.croppedImageUrl || item?.imageUrl);
    if (validItems.length === 0) {
        showToast('当前队列没有可生成的拆图项', 'warning');
        return { cancelled: false, skipped: true };
    }

    const platform = qd.apiPlatform || 'oaihk';
    if (platform === 'oaihk') {
        if (!OAIHK_MODELS[qd.oaihkModelId]) { showToast('请选择 OpenAI-HK 模型', 'error'); return { cancelled: false, skipped: true }; }
    } else {
        if (!RH_MODELS[qd.rhModelId]) { showToast('请选择模型', 'error'); return { cancelled: false, skipped: true }; }
    }

    qs.running = true;
    qs.cancelled = false;
    qs.abortController = new AbortController();
    const signal = qs.abortController.signal;
    const batchSlotCount = Math.max(1, qd.workItems.length);
    qs.batchVisualTotal = batchSlotCount;
    qs.batchVisualFilled = 0;
    updateSplitGenerateBtnState();

    const progressWrap = document.getElementById('split-progress-bar-wrap');
    const progressBar = document.getElementById('split-progress-bar');
    const progressText = document.getElementById('split-progress-text');
    if (progressWrap) progressWrap.style.display = '';
    if (progressText) progressText.style.display = '';
    if (progressBar) progressBar.style.width = '0%';

    const totalItems = Math.max(1, validItems.length);
    let completedItems = 0;
    let processedItems = 0;
    qd.progressTotal = totalItems;
    qd.progressDone = 0;
    qd.failedItems = [];
    updateSplitFailedUI(qi);
    saveSplitQueueData();
    renderSplitQueueNumberBar();

    if (qi === activeSplitQueue) {
        const grid = document.getElementById('split-result-grid');
        renderSplitQueueResults(qi);
        appendSplitResultPendingSlots(grid, batchSlotCount);
    }

    const allResults = [];
    const splitGrid = qi === activeSplitQueue ? document.getElementById('split-result-grid') : null;
    try {
        const totalJobs = totalItems;
        const finishedJobs = { n: 0 };
        const pendingResultPromises = [];
        const bumpSplitBatchVisualFilled = () => {
            const st = splitGenerateStates[qi];
            if (!st) return;
            const cap = st.batchVisualTotal || 0;
            st.batchVisualFilled = Math.min(cap, (st.batchVisualFilled || 0) + 1);
        };

        for (let itemIdx = 0; itemIdx < qd.workItems.length; itemIdx++) {
            if (splitGenerateStates[qi]?.cancelled) break;
            const item = qd.workItems[itemIdx];

            let sourceUrl = '';
            const cropSourceUrl = getSplitCropSourceUrl(item, qd);
            if (item.cropRect && cropSourceUrl) {
                try {
                    const cropResult = await api('POST', '/api/free-crop-image', {
                        image_url: cropSourceUrl,
                        x: item.cropRect.x, y: item.cropRect.y,
                        w: item.cropRect.w, h: item.cropRect.h
                    });
                    if (cropResult.ok && cropResult.url) {
                        sourceUrl = cropResult.url;
                        item.croppedImageUrl = cropResult.url;
                    } else {
                        showToast(`格子编号 ${item.number} 裁剪失败，跳过`, 'warning');
                        recordSplitFailure(qi, { materialIndex: qd.activeMaterialIndex || 0, itemIndex: itemIdx, gridNum: item.number || (itemIdx + 1), reason: '裁剪失败' });
                        processedItems++;
                        if (splitGrid) fillSplitPendingSlotAt(splitGrid, itemIdx, splitPendingStubCard('skip', '裁剪失败'));
                        bumpSplitBatchVisualFilled();
                        continue;
                    }
                } catch (e) {
                    showToast(`格子编号 ${item.number} 裁剪请求失败: ${e.message}`, 'error');
                    recordSplitFailure(qi, { materialIndex: qd.activeMaterialIndex || 0, itemIndex: itemIdx, gridNum: item.number || (itemIdx + 1), reason: '裁剪异常' });
                    processedItems++;
                    if (splitGrid) fillSplitPendingSlotAt(splitGrid, itemIdx, splitPendingStubCard('skip', '裁剪异常'));
                    bumpSplitBatchVisualFilled();
                    continue;
                }
            }
            if (!sourceUrl) {
                sourceUrl = item.croppedImageUrl || item.imageUrl;
            }
            if (!sourceUrl) {
                recordSplitFailure(qi, { materialIndex: qd.activeMaterialIndex || 0, itemIndex: itemIdx, gridNum: item.number || (itemIdx + 1), reason: '无图源' });
                processedItems++;
                if (splitGrid) fillSplitPendingSlotAt(splitGrid, itemIdx, splitPendingStubCard('skip', '无图源'));
                bumpSplitBatchVisualFilled();
                continue;
            }

            let imageUrls = [sourceUrl];
            if (item.materials) {
                item.materials.forEach(m => { if (m) imageUrls.push(m); });
            }
            if (platform !== 'oaihk') {
                imageUrls = imageUrls.map(u => u.startsWith('/') ? window.location.origin + u : u);
            }
            const prompt = buildSplitFullPrompt(item);
            const task = { prompt, imageUrls, queueLabel: `拆图${item.number || (itemIdx + 1)}` };
            const gridNum = item.number || (itemIdx + 1);
            const materialIndex = qd.activeMaterialIndex || 0;
            const job = { itemIdx, materialIndex, gridNum, task, prompt, sourceUrl };
            processedItems++;
            if (progressText) {
                progressText.textContent = `队列${qi + 1} 正在提交 ${processedItems}/${totalItems}：格子 ${gridNum}`;
            }
            qs.progressText = `队列${qi + 1}: 已提交 ${Math.max(0, processedItems - 1)}/${totalItems}，等待返回 ${finishedJobs.n}/${totalItems}`;
            syncSplitProgressUI();

            try {
                const submitted = await submitSingleTaskForSplitAsync(qi, task, platform, qd, signal);
                qs.progressText = `队列${qi + 1}: 已提交 ${processedItems}/${totalItems}，等待返回 ${finishedJobs.n}/${totalItems}`;
                syncSplitProgressUI();
                pendingResultPromises.push(submitted.waitForResults().then(taskResults => ({ status: 'fulfilled', taskResults, job }), reason => ({ status: 'rejected', reason, job })).then(ent => {
                    if (splitGenerateStates[qi]?.cancelled) return;
                    const { itemIdx, prompt, sourceUrl, gridNum, materialIndex } = ent.job;
                let taskResults = [];
                    if (ent.status === 'fulfilled') {
                        taskResults = ent.taskResults || [];
                } else {
                    console.warn('[拆图批量] 任务异常', ent.reason);
                        recordSplitFailure(qi, { materialIndex, itemIndex: itemIdx, gridNum, reason: '请求异常' });
                    if (!qs.cancelled) showToast(`格子编号 ${gridNum} 请求失败`, 'error');
                    if (splitGrid) fillSplitPendingSlotAt(splitGrid, itemIdx, splitPendingStubCard('fail', '请求异常'));
                    bumpSplitBatchVisualFilled();
                    finishedJobs.n++;
                    if (progressText) progressText.textContent = `队列${qi + 1} 已处理 ${finishedJobs.n}/${totalJobs}（成功出图 ${completedItems}）`;
                    if (progressBar) progressBar.style.width = `${Math.round((finishedJobs.n / totalJobs) * 100)}%`;
                    qs.progressText = `队列${qi + 1}: 已完成 ${finishedJobs.n}/${totalJobs}（成功 ${completedItems}）`;
                    qs.progressPercent = Math.round((finishedJobs.n / totalJobs) * 100);
                    syncSplitProgressUI();
                    return;
                }

                if (taskResults.length > 0) {
                    for (const r of taskResults) {
                        r._regenPrompt = prompt;
                        r._regenImageUrl = sourceUrl;
                        r.prompt = prompt;
                            r._materialIndex = materialIndex;
                    }
                    allResults.push(...taskResults);
                    qd.results = (qd.results || []).concat(taskResults);
                    saveSplitQueueData();
                    if (splitGrid) {
                        const results = qd.results || [];
                        const start = results.length - taskResults.length;
                        for (let k = start; k < results.length; k++) {
                            const el = createSplitResultCardElement(qi, results[k], k, results);
                            if (k === start) fillSplitPendingSlotAt(splitGrid, itemIdx, el);
                            else splitGrid.appendChild(el);
                        }
                    }
                    completedItems++;
                        removeSplitFailure(qi, materialIndex, itemIdx);
                    qd.progressDone = completedItems;
                    saveSplitQueueData();
                    renderSplitQueueNumberBar();
                } else {
                    recordSplitFailure(qi, { materialIndex: qd.activeMaterialIndex || 0, itemIndex: itemIdx, gridNum, reason: '未返图' });
                    if (!qs.cancelled) showToast(`格子编号 ${gridNum} 未返回图片`, 'warning');
                    if (splitGrid) fillSplitPendingSlotAt(splitGrid, itemIdx, splitPendingStubCard('fail', '未返图'));
                }
                bumpSplitBatchVisualFilled();
                finishedJobs.n++;
                if (progressText) progressText.textContent = `队列${qi + 1} 已处理 ${finishedJobs.n}/${totalJobs}（成功出图 ${completedItems}）`;
                if (progressBar) progressBar.style.width = `${Math.round((finishedJobs.n / totalJobs) * 100)}%`;
                qs.progressText = `队列${qi + 1}: 已完成 ${finishedJobs.n}/${totalJobs}（成功 ${completedItems}）`;
                qs.progressPercent = Math.round((finishedJobs.n / totalJobs) * 100);
                syncSplitProgressUI();
                }));
            } catch (e) {
                if (!qs.cancelled) {
                    console.warn('[拆图批量] 提交异常', e);
                    recordSplitFailure(qi, { materialIndex, itemIndex: itemIdx, gridNum, reason: '提交异常' });
                    showToast(`格子编号 ${gridNum} 提交失败`, 'error');
                }
                if (splitGrid) fillSplitPendingSlotAt(splitGrid, itemIdx, splitPendingStubCard('fail', '提交异常'));
                bumpSplitBatchVisualFilled();
                finishedJobs.n++;
            }
        }

        if (pendingResultPromises.length > 0) await Promise.allSettled(pendingResultPromises);
    } catch (e) {
        if (!qs.cancelled) showToast(`批量生成失败: ${e.message}`, 'error');
    }

    persistActiveSplitMaterial(qd);

    if (allResults.length > 0 && qd.autoBackup !== false) {
        await autoBackupSplitResults(allResults, qi);
    }

    const wasCancelled = qs.cancelled;
    qs.running = false;
    qs.cancelled = false;
    qs.abortController = null;
    qs.progressPercent = 0;
    qs.progressText = '';
    qs.batchVisualTotal = 0;
    qs.batchVisualFilled = 0;
    if (progressWrap) progressWrap.style.display = 'none';
    if (progressText) progressText.style.display = 'none';
    if (qi === activeSplitQueue) {
        clearRemainingSplitResultPendingSlots(document.getElementById('split-result-grid'));
        renderSplitQueueResults(qi);
    }
    renderSplitQueueNumberBar();
    updateSplitGenerateBtnState();
    syncSplitProgressUI();
    saveSplitQueueData();

    const failedCount = qd.failedItems?.length || 0;
    if (allResults.length > 0) {
        showToast(failedCount > 0 ? `队列${qi+1}批量完成：成功 ${allResults.length} 张，失败 ${failedCount} 张` : `队列${qi+1}批量生成完成！共${allResults.length}张`, failedCount > 0 ? 'warning' : 'success');
        if (!wasCancelled) playSplitQueueCompleteChime();
    } else if (wasCancelled) {
        showToast(`队列${qi+1}已取消`, 'info');
    } else {
        showToast('生成未产出结果', 'warning');
    }
    return { cancelled: wasCancelled, skipped: false };
}

/** 当前队列全部素材：对各素材内已就绪的格子工作项顺序逐张生成 */
async function runSplitBatchGenerateAllMaterials() {
    const qi = activeSplitQueue;
    const qd = splitQueueData[qi];
    if (!qd) return { cancelled: false, skipped: true };

    normalizeSplitQueueMaterials(qd);
    persistActiveSplitMaterial(qd);

    let totalWorkSlots = 0;
    for (const m of qd.materials || []) {
        totalWorkSlots += (m.workItems || []).length;
    }
    if (totalWorkSlots === 0) {
        showToast('当前队列各素材均无格子工作项', 'warning');
        return { cancelled: false, skipped: true };
    }

    let validPrefetch = 0;
    for (const m of qd.materials || []) {
        const qdCtx = Object.assign({}, qd, { gridImageUrl: m.gridImageUrl || '' });
        for (const item of (m.workItems || [])) {
            if ((item?.cropRect && getSplitCropSourceUrl(item, qdCtx)) || item?.croppedImageUrl || item?.imageUrl) {
                validPrefetch++;
            }
        }
    }
    if (validPrefetch === 0) {
        showToast('当前队列没有可生成的拆图项', 'warning');
        return { cancelled: false, skipped: true };
    }

    const qs = splitGenerateStates[qi];
    if (qs.running) {
        showToast(`队列${qi + 1}正在生成中`, 'error');
        return { cancelled: false, skipped: true };
    }

    saveCurrentSplitQueueData();

    const platform = qd.apiPlatform || 'oaihk';
    if (platform === 'oaihk') {
        if (!OAIHK_MODELS[qd.oaihkModelId]) { showToast('请选择 OpenAI-HK 模型', 'error'); return { cancelled: false, skipped: true }; }
    } else {
        if (!RH_MODELS[qd.rhModelId]) { showToast('请选择模型', 'error'); return { cancelled: false, skipped: true }; }
    }

    const savedActiveMat = Math.max(0, Math.min(qd.activeMaterialIndex || 0, Math.max(0, qd.materials.length - 1)));

    qs.running = true;
    qs.cancelled = false;
    qs.abortController = new AbortController();
    const signal = qs.abortController.signal;
    const batchSlotCount = Math.max(1, totalWorkSlots);
    qs.batchVisualTotal = batchSlotCount;
    qs.batchVisualFilled = 0;
    updateSplitGenerateBtnState();

    const progressWrap = document.getElementById('split-progress-bar-wrap');
    const progressBar = document.getElementById('split-progress-bar');
    const progressText = document.getElementById('split-progress-text');
    if (progressWrap) progressWrap.style.display = '';
    if (progressText) progressText.style.display = '';
    if (progressBar) progressBar.style.width = '0%';

    const totalItems = Math.max(1, validPrefetch);
    let completedItems = 0;
    qd.progressTotal = totalItems;
    qd.progressDone = 0;
    qd.failedItems = [];
    updateSplitFailedUI(qi);
    saveSplitQueueData();
    renderSplitQueueNumberBar();

    if (qi === activeSplitQueue) {
        const grid = document.getElementById('split-result-grid');
        renderSplitQueueResults(qi);
        appendSplitResultPendingSlots(grid, batchSlotCount);
    }

    const allResults = [];
    const splitGrid = qi === activeSplitQueue ? document.getElementById('split-result-grid') : null;

    try {
        const bumpSplitBatchVisualFilled = () => {
            const st = splitGenerateStates[qi];
            if (!st) return;
            const cap = st.batchVisualTotal || 0;
            st.batchVisualFilled = Math.min(cap, (st.batchVisualFilled || 0) + 1);
        };

        let globalSlot = 0;
        const totalJobsAll = Math.max(1, validPrefetch);
        const finishedJobsAll = { n: 0 };
        const pendingResultPromises = [];
        if (progressText) {
            progressText.textContent = `队列${qi + 1} 全部素材 共 ${validPrefetch} 张，按顺序裁剪提交`;
        }
        qs.progressText = `队列${qi + 1}: 全部素材已提交 0/${totalJobsAll}，等待返回 0/${totalJobsAll}`;
        qs.progressPercent = 2;
        syncSplitProgressUI();

        for (let mi = 0; mi < qd.materials.length; mi++) {
            if (splitGenerateStates[qi]?.cancelled) break;
            const m = qd.materials[mi];
            const qdCtx = Object.assign({}, qd, { gridImageUrl: m.gridImageUrl || '' });
            const items = m.workItems || [];
            for (let wi = 0; wi < items.length; wi++) {
                if (splitGenerateStates[qi]?.cancelled) break;
                const item = items[wi];
                const slotIdx = globalSlot++;

                let sourceUrl = '';
                const cropSourceUrl = getSplitCropSourceUrl(item, qdCtx);
                if (item.cropRect && cropSourceUrl) {
                    try {
                        const cropResult = await api('POST', '/api/free-crop-image', {
                            image_url: cropSourceUrl,
                            x: item.cropRect.x, y: item.cropRect.y,
                            w: item.cropRect.w, h: item.cropRect.h
                        });
                        if (cropResult.ok && cropResult.url) {
                            sourceUrl = cropResult.url;
                            item.croppedImageUrl = cropResult.url;
                        } else {
                            showToast(`素材 ${mi + 1} · 格子编号 ${item.number} 裁剪失败，跳过`, 'warning');
                            recordSplitFailure(qi, { materialIndex: mi, itemIndex: wi, gridNum: item.number || (wi + 1), reason: '裁剪失败' });
                            if (splitGrid) fillSplitPendingSlotAt(splitGrid, slotIdx, splitPendingStubCard('skip', '裁剪失败'));
                            bumpSplitBatchVisualFilled();
                            continue;
                        }
                    } catch (e) {
                        showToast(`素材 ${mi + 1} · 格子编号 ${item.number} 裁剪异常: ${e.message}`, 'error');
                        recordSplitFailure(qi, { materialIndex: mi, itemIndex: wi, gridNum: item.number || (wi + 1), reason: '裁剪异常' });
                        if (splitGrid) fillSplitPendingSlotAt(splitGrid, slotIdx, splitPendingStubCard('skip', '裁剪异常'));
                        bumpSplitBatchVisualFilled();
                        continue;
                    }
                }
                if (!sourceUrl) {
                    sourceUrl = item.croppedImageUrl || item.imageUrl;
                }
                if (!sourceUrl) {
                    recordSplitFailure(qi, { materialIndex: mi, itemIndex: wi, gridNum: item.number || (wi + 1), reason: '无图源' });
                    if (splitGrid) fillSplitPendingSlotAt(splitGrid, slotIdx, splitPendingStubCard('skip', '无图源'));
                    bumpSplitBatchVisualFilled();
                    continue;
                }

                let imageUrls = [sourceUrl];
                if (item.materials) {
                    item.materials.forEach(mat => { if (mat) imageUrls.push(mat); });
                }
                if (platform !== 'oaihk') {
                    imageUrls = imageUrls.map(u => u.startsWith('/') ? window.location.origin + u : u);
                }
                const prompt = buildSplitFullPrompt(item);
                const task = { prompt, imageUrls, queueLabel: `拆图M${mi + 1}-${item.number || (wi + 1)}` };
                const gridNum = item.number || (wi + 1);
                const job = { itemIdx: slotIdx, itemIndexInMaterial: wi, materialIndex: mi, gridNum, task, prompt, sourceUrl };
                if (progressText) {
                    progressText.textContent = `队列${qi + 1} 正在提交素材 ${mi + 1} · 格子 ${gridNum}`;
                }
                try {
                    const submitted = await submitSingleTaskForSplitAsync(qi, task, platform, qd, signal);
                    qs.progressText = `队列${qi + 1}: 全部素材已提交 ${pendingResultPromises.length + 1}/${totalJobsAll}，等待返回 ${finishedJobsAll.n}/${totalJobsAll}`;
                    syncSplitProgressUI();
                    pendingResultPromises.push(submitted.waitForResults().then(taskResults => ({ status: 'fulfilled', taskResults, job }), reason => ({ status: 'rejected', reason, job })).then(ent => {
                        if (splitGenerateStates[qi]?.cancelled) return;
                        const { itemIdx, itemIndexInMaterial, prompt, sourceUrl, materialIndex, gridNum } = ent.job;
                        let taskResults = [];
                        if (ent.status === 'fulfilled') {
                            taskResults = ent.taskResults || [];
                        } else {
                            console.warn('[拆图全部素材] 任务异常', ent.reason);
                            recordSplitFailure(qi, { materialIndex, itemIndex: itemIndexInMaterial, gridNum, reason: '请求异常' });
                            if (!qs.cancelled) showToast(`素材 ${materialIndex + 1} · 格子编号 ${gridNum} 请求失败`, 'error');
                            if (splitGrid) fillSplitPendingSlotAt(splitGrid, itemIdx, splitPendingStubCard('fail', '请求异常'));
                            bumpSplitBatchVisualFilled();
                            finishedJobsAll.n++;
                            if (progressText) progressText.textContent = `队列${qi + 1} 全部素材 已返回 ${finishedJobsAll.n}/${totalJobsAll}（成功 ${completedItems}）`;
                            if (progressBar) progressBar.style.width = `${Math.round((finishedJobsAll.n / totalJobsAll) * 100)}%`;
                            qs.progressText = `队列${qi + 1}: 全部素材返回 ${finishedJobsAll.n}/${totalJobsAll}（成功 ${completedItems}）`;
                            qs.progressPercent = Math.round((finishedJobsAll.n / totalJobsAll) * 100);
                            syncSplitProgressUI();
                            return;
                        }

                        if (taskResults.length > 0) {
                            for (const r of taskResults) {
                                r._regenPrompt = prompt;
                                r._regenImageUrl = sourceUrl;
                                r.prompt = prompt;
                                r._materialIndex = materialIndex;
                            }
                            allResults.push(...taskResults);
                            qd.results = (qd.results || []).concat(taskResults);
                            saveSplitQueueData();
                            if (splitGrid) {
                                const results = qd.results || [];
                                const start = results.length - taskResults.length;
                                for (let k = start; k < results.length; k++) {
                                    const el = createSplitResultCardElement(qi, results[k], k, results);
                                    if (k === start) fillSplitPendingSlotAt(splitGrid, itemIdx, el);
                                    else splitGrid.appendChild(el);
                                }
                            }
                            completedItems++;
                            removeSplitFailure(qi, materialIndex, itemIndexInMaterial);
                            qd.progressDone = completedItems;
                            saveSplitQueueData();
                            renderSplitQueueNumberBar();
                        } else {
                            recordSplitFailure(qi, { materialIndex, itemIndex: itemIndexInMaterial, gridNum, reason: '未返图' });
                            if (!qs.cancelled) showToast(`素材 ${materialIndex + 1} · 格子编号 ${gridNum} 未返回图片`, 'warning');
                            if (splitGrid) fillSplitPendingSlotAt(splitGrid, itemIdx, splitPendingStubCard('fail', '未返图'));
                        }
                        bumpSplitBatchVisualFilled();
                        finishedJobsAll.n++;
                        if (progressText) progressText.textContent = `队列${qi + 1} 全部素材 已返回 ${finishedJobsAll.n}/${totalJobsAll}（成功 ${completedItems}）`;
                        if (progressBar) progressBar.style.width = `${Math.round((finishedJobsAll.n / totalJobsAll) * 100)}%`;
                        qs.progressText = `队列${qi + 1}: 全部素材返回 ${finishedJobsAll.n}/${totalJobsAll}（成功 ${completedItems}）`;
                        qs.progressPercent = Math.round((finishedJobsAll.n / totalJobsAll) * 100);
                        syncSplitProgressUI();
                    }));
                } catch (e) {
                    if (!qs.cancelled) {
                        console.warn('[拆图全部素材] 提交异常', e);
                        recordSplitFailure(qi, { materialIndex: mi, itemIndex: wi, gridNum, reason: '提交异常' });
                        showToast(`素材 ${mi + 1} · 格子编号 ${gridNum} 提交失败`, 'error');
                    }
                    if (splitGrid) fillSplitPendingSlotAt(splitGrid, slotIdx, splitPendingStubCard('fail', '提交异常'));
                    bumpSplitBatchVisualFilled();
                    finishedJobsAll.n++;
                }
            }
        }

        if (pendingResultPromises.length > 0) await Promise.allSettled(pendingResultPromises);
    } catch (e) {
        if (!qs.cancelled) showToast(`全部素材批量失败: ${e.message}`, 'error');
    }

    persistActiveSplitMaterial(qd);
    loadActiveSplitMaterialIntoQueue(qd, savedActiveMat);
    splitImageUrl = qd.gridImageUrl || '';
    splitGridImageUrl = splitImageUrl;

    if (allResults.length > 0 && qd.autoBackup !== false) {
        await autoBackupSplitResults(allResults, qi);
    }

    const wasCancelled = qs.cancelled;
    qs.running = false;
    qs.cancelled = false;
    qs.abortController = null;
    qs.progressPercent = 0;
    qs.progressText = '';
    qs.batchVisualTotal = 0;
    qs.batchVisualFilled = 0;
    if (progressWrap) progressWrap.style.display = 'none';
    if (progressText) progressText.style.display = 'none';
    if (qi === activeSplitQueue) {
        clearRemainingSplitResultPendingSlots(document.getElementById('split-result-grid'));
        renderSplitQueueResults(qi);
        loadSplitQueueToUI(qi);
        renderSplitMaterialTabs(qi);
    }
    renderSplitQueueNumberBar();
    updateSplitGenerateBtnState();
    syncSplitProgressUI();

    const failedCount = qd.failedItems?.length || 0;
    if (allResults.length > 0) {
        showToast(failedCount > 0 ? `队列${qi + 1} 全部素材完成：成功 ${allResults.length} 张，失败 ${failedCount} 张` : `队列${qi + 1} 全部素材批量完成！共 ${allResults.length} 张`, failedCount > 0 ? 'warning' : 'success');
        if (!wasCancelled) playSplitQueueCompleteChime();
    } else if (wasCancelled) {
        showToast(`队列${qi + 1}已取消`, 'info');
    } else {
        showToast('全部素材生成未产出结果', 'warning');
    }
    return { cancelled: wasCancelled, skipped: false };
}

async function runSplitRetryFailed() {
    const qi = activeSplitQueue;
    const qd = splitQueueData[qi];
    const failed = Array.isArray(qd?.failedItems) ? [...qd.failedItems] : [];
    if (!qd || failed.length === 0) {
        showToast('当前拆图队列没有失败项', 'info');
        return;
    }
    const qs = splitGenerateStates[qi];
    if (qs.running) {
        showToast(`队列${qi + 1}正在生成中`, 'error');
        return;
    }
    saveCurrentSplitQueueData();
    const platform = qd.apiPlatform || 'oaihk';
    if (platform === 'oaihk') {
        if (!OAIHK_MODELS[qd.oaihkModelId]) { showToast('请选择 OpenAI-HK 模型', 'error'); return; }
    } else if (!RH_MODELS[qd.rhModelId]) {
        showToast('请选择模型', 'error');
        return;
    }

    qs.running = true;
    qs.cancelled = false;
    qs.abortController = new AbortController();
    const signal = qs.abortController.signal;
    qs.batchVisualTotal = failed.length;
    qs.batchVisualFilled = 0;
    qd.failedItems = [];
    updateSplitFailedUI(qi);
    updateSplitGenerateBtnState();

    const progressWrap = document.getElementById('split-progress-bar-wrap');
    const progressBar = document.getElementById('split-progress-bar');
    const progressText = document.getElementById('split-progress-text');
    if (progressWrap) progressWrap.style.display = '';
    if (progressText) progressText.style.display = '';
    if (progressBar) progressBar.style.width = '0%';
    if (progressText) progressText.textContent = `队列${qi + 1} 重试失败项 0/${failed.length}（顺序逐张提交）`;

    const grid = document.getElementById('split-result-grid');
    renderSplitQueueResults(qi);
    appendSplitResultPendingSlots(grid, failed.length);

    const apiJobs = [];
    let slotIdx = 0;
    for (const f of failed) {
        const mi = Number.isFinite(f.materialIndex) ? f.materialIndex : (qd.activeMaterialIndex || 0);
        const wi = Number.isFinite(f.itemIndex) ? f.itemIndex : 0;
        const material = qd.materials?.[mi];
        const item = material?.workItems?.[wi] || qd.workItems?.[wi];
        if (!item) {
            recordSplitFailure(qi, { materialIndex: mi, itemIndex: wi, gridNum: f.gridNum, reason: '工作项不存在' });
            continue;
        }
        const qdCtx = Object.assign({}, qd, { gridImageUrl: material?.gridImageUrl || qd.gridImageUrl || '' });
        let sourceUrl = '';
        const cropSourceUrl = getSplitCropSourceUrl(item, qdCtx);
        if (item.cropRect && cropSourceUrl) {
            try {
                const cropResult = await api('POST', '/api/free-crop-image', {
                    image_url: cropSourceUrl,
                    x: item.cropRect.x, y: item.cropRect.y,
                    w: item.cropRect.w, h: item.cropRect.h
                });
                if (cropResult.ok && cropResult.url) {
                    sourceUrl = cropResult.url;
                    item.croppedImageUrl = cropResult.url;
                }
            } catch (e) {
                recordSplitFailure(qi, { materialIndex: mi, itemIndex: wi, gridNum: item.number || f.gridNum, reason: '裁剪异常' });
                fillSplitPendingSlotAt(grid, slotIdx++, splitPendingStubCard('fail', '裁剪异常'));
                continue;
            }
        }
        if (!sourceUrl) sourceUrl = item.croppedImageUrl || item.imageUrl;
        if (!sourceUrl) {
            recordSplitFailure(qi, { materialIndex: mi, itemIndex: wi, gridNum: item.number || f.gridNum, reason: '无图源' });
            fillSplitPendingSlotAt(grid, slotIdx++, splitPendingStubCard('fail', '无图源'));
            continue;
        }
        let imageUrls = [sourceUrl];
        if (item.materials) item.materials.forEach(mat => { if (mat) imageUrls.push(mat); });
        if (platform !== 'oaihk') imageUrls = imageUrls.map(u => u.startsWith('/') ? window.location.origin + u : u);
        const prompt = buildSplitFullPrompt(item);
        apiJobs.push({ slotIndex: slotIdx++, materialIndex: mi, itemIndex: wi, gridNum: item.number || f.gridNum || (wi + 1), prompt, sourceUrl, task: { prompt, imageUrls, queueLabel: `重试M${mi + 1}-${item.number || (wi + 1)}` } });
    }

    let successCount = 0;
    const allResults = [];
    await mapWithConcurrency(apiJobs, SPLIT_GEN_CONCURRENCY, job =>
        runWithSplitGlobalConcurrency(() =>
            generateSingleTaskForSplit(qi, job.task, platform, qd, signal, { bypassDispatchChain: true }).then(taskResults => ({ job, taskResults }))
        , signal),
        (_idx, ent) => {
            const job = apiJobs[_idx];
            if (!job || qs.cancelled) return;
            let taskResults = ent.status === 'fulfilled' ? (ent.value.taskResults || []) : [];
            if (taskResults.length > 0) {
                for (const r of taskResults) {
                    r._regenPrompt = job.prompt;
                    r._regenImageUrl = job.sourceUrl;
                    r.prompt = job.prompt;
                    r._materialIndex = job.materialIndex;
                }
                allResults.push(...taskResults);
                qd.results = (qd.results || []).concat(taskResults);
                successCount++;
                qd.progressDone = (qd.progressDone || 0) + 1;
                const results = qd.results || [];
                const start = results.length - taskResults.length;
                for (let k = start; k < results.length; k++) {
                    const el = createSplitResultCardElement(qi, results[k], k, results);
                    if (k === start) fillSplitPendingSlotAt(grid, job.slotIndex, el);
                    else grid.appendChild(el);
                }
                saveSplitQueueData();
            } else {
                const reason = ent.status === 'rejected' ? '请求异常' : '未返图';
                recordSplitFailure(qi, { materialIndex: job.materialIndex, itemIndex: job.itemIndex, gridNum: job.gridNum, reason });
                fillSplitPendingSlotAt(grid, job.slotIndex, splitPendingStubCard('fail', reason));
            }
            const done = successCount + (qd.failedItems?.length || 0);
            if (progressText) progressText.textContent = `队列${qi + 1} 重试失败项 ${Math.min(done, failed.length)}/${failed.length}（成功 ${successCount}）`;
            if (progressBar) progressBar.style.width = `${Math.round((Math.min(done, failed.length) / failed.length) * 100)}%`;
            qs.batchVisualFilled = Math.min(failed.length, (qs.batchVisualFilled || 0) + 1);
            updateSplitFailedUI(qi);
            renderSplitQueueNumberBar();
        }
    );

    if (allResults.length > 0 && qd.autoBackup !== false) await autoBackupSplitResults(allResults, qi);
    const remaining = qd.failedItems?.length || 0;
    qs.running = false;
    qs.cancelled = false;
    qs.abortController = null;
    qs.batchVisualTotal = 0;
    qs.batchVisualFilled = 0;
    if (progressWrap) progressWrap.style.display = 'none';
    if (progressText) progressText.style.display = 'none';
    clearRemainingSplitResultPendingSlots(grid);
    renderSplitQueueResults(qi);
    renderSplitQueueNumberBar();
    updateSplitGenerateBtnState();
    updateSplitFailedUI(qi);
    saveSplitQueueData();
    showToast(remaining > 0 ? `重试完成：成功 ${successCount} 张，仍失败 ${remaining} 张` : `失败项已全部重试成功，共 ${successCount} 张`, remaining > 0 ? 'warning' : 'success');
}

// 取消拆图生成
function cancelSplitGenerate(targetQueue = activeSplitQueue) {
    // 兼容直接作为点击事件回调时传入 PointerEvent
    if (targetQueue && typeof targetQueue === 'object') {
        targetQueue = activeSplitQueue;
    }
    targetQueue = Number.isInteger(targetQueue) ? targetQueue : activeSplitQueue;
    const cancelByQueue = (q) => {
        const state = splitGenerateStates[q];
        if (!state?.running) return false;
        state.cancelled = true;
        state.abortController?.abort();
        state.progressText = `队列${q + 1}取消中...`;
        showToast(`已取消拆图队列${q + 1}生成`, 'info');
        syncSplitProgressUI();
        return true;
    };
    if (cancelByQueue(targetQueue)) return;
    if (isAnySplitQueueGenerating()) {
        showToast(`当前是队列${targetQueue + 1}，该队列未在生成。请切换到正在生成的队列再取消。`, 'info');
    } else {
        showToast('当前没有拆图任务在生成', 'info');
    }
}

// 自动备份拆图结果（转JPG）
async function autoBackupSplitResults(results, qi) {
    const qd = splitQueueData[qi];
    const downloadPath = getEffectiveSplitDownloadPath(qi);
    const imagePrefix = qd.imagePrefix || document.getElementById('split-cfg-image-prefix')?.value?.trim() || '';
    let counterStart = 1;
    try {
        const counterResp = await api('POST', '/api/next-image-counter', { count: results.length });
        counterStart = counterResp.start;
    } catch (e) {
        console.error('获取拆图图片计数器失败:', e);
    }

    let idx = 0;
    let backupCount = 0;
    let failCount = 0;
    const failReasons = [];
    for (const item of results) {
        if (!item?.url || item.url.startsWith('/api/gallery-image') || item.url.startsWith('/static/')) continue;
        const num = formatImageNumber(counterStart + idx);
        const filename = `${(imagePrefix || 'split').trim() || 'split'}-${num}.jpg`;
        idx++;
        const detail = await backupImageToLocalDetailed(item.url, filename, downloadPath);
        if (detail.ok && detail.localUrl) {
            item.url = detail.localUrl;
            item.localUrl = detail.localUrl;
            item.filename = filename;
            backupCount++;
        } else {
            failCount++;
            if (detail.error && failReasons.length < 3) failReasons.push(detail.error);
        }
    }

    qd.results = qd.results || [];
    saveSplitQueueData();
    if (qi === activeSplitQueue) renderSplitQueueResults(qi);

    if (backupCount > 0) {
        showToast(`${backupCount}张拆图结果已统一入图库`, 'success');
    }
    if (failCount > 0) {
        const reason = failReasons.length > 0 ? `，原因示例：${failReasons.join('；')}` : '';
        const msg = `${failCount}张拆图结果入图库失败（请确认后端已重启到最新版本）${reason}`;
        console.warn(msg, { qi, results });
        showToast(msg, 'error');
    }
}

// JPG下载函数（复用已有逻辑）
async function downloadImageAsJpg(url, prefix, downloadPath) {
    try {
        const ts = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const defaultPrefix = (prefix || 'split').trim() || 'split';
        const filename = `${defaultPrefix}_${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.jpg`;
        const resp = await api('POST', '/api/save-image-to-path', {
            url: url,
            path: downloadPath || '~/Downloads/AI生图/',
            filename
        });
        if (resp.ok || resp.success) {
            logAction('download', '自动下载图片(JPG)', { url, path: downloadPath });
            return { ok: true, path: resp.path || '' };
        }
        return { ok: false, error: resp.error || '保存失败' };
    } catch(e) {
        console.error('自动下载失败:', e);
        return { ok: false, error: e?.message || '请求失败' };
    }
}

// ========== 拆图自由裁剪编辑器 ==========

let splitCropState = {
    image: null,
    imageUrl: '',
    queueIdx: -1,
    imgDisplayX: 0, imgDisplayY: 0, imgDisplayW: 0, imgDisplayH: 0,
    cropX: 0, cropY: 0, cropW: 0, cropH: 0,
    dragging: false, dragType: '',
    dragStartX: 0, dragStartY: 0,
    cropStartX: 0, cropStartY: 0, cropStartW: 0, cropStartH: 0,
    imgStartX: 0, imgStartY: 0,
    viewScale: 1,
    spaceDown: false,
    cropWheelMode: false,
    activePreset: null,
};

const SPLIT_CROP_HANDLE_SIZE = 8;

function resizeSplitCropCanvasForImage(canvas, img) {
    if (!canvas || !img) return;
    const viewportW = window.innerWidth || 0;
    const viewportH = window.innerHeight || 0;
    const maxW = viewportW > 0 ? Math.min(980, viewportW - 96) : 960;
    const maxH = viewportH > 0 ? Math.min(720, viewportH - 210) : 720;
    const aspect = img.width / img.height || 1;
    let canvasW = maxW;
    let canvasH = canvasW / aspect;
    if (canvasH > maxH) {
        canvasH = maxH;
        canvasW = canvasH * aspect;
    }
    if (canvasW < 520) {
        canvasW = 520;
        canvasH = canvasW / aspect;
    }
    if (canvasH < 360 && maxH >= 360) {
        canvasH = 360;
        canvasW = canvasH * aspect;
    }
    canvas.width = Math.round(canvasW);
    canvas.height = Math.round(canvasH);
}

function getSplitCropRelRect() {
    const s = splitCropState;
    if (!s.imgDisplayW || !s.imgDisplayH) return { x: 0, y: 0, w: 1, h: 1 };
    return {
        x: (s.cropX - s.imgDisplayX) / s.imgDisplayW,
        y: (s.cropY - s.imgDisplayY) / s.imgDisplayH,
        w: s.cropW / s.imgDisplayW,
        h: s.cropH / s.imgDisplayH
    };
}

function setSplitCropFromRelRect(rect) {
    const s = splitCropState;
    const r = rect || { x: 0, y: 0, w: 1, h: 1 };
    s.cropX = s.imgDisplayX + r.x * s.imgDisplayW;
    s.cropY = s.imgDisplayY + r.y * s.imgDisplayH;
    s.cropW = r.w * s.imgDisplayW;
    s.cropH = r.h * s.imgDisplayH;
}

function constrainSplitImageView(canvas) {
    const s = splitCropState;
    const cw = canvas.width;
    const ch = canvas.height;
    if (s.imgDisplayW <= cw) {
        s.imgDisplayX = (cw - s.imgDisplayW) / 2;
    } else {
        s.imgDisplayX = Math.min(0, Math.max(cw - s.imgDisplayW, s.imgDisplayX));
    }
    if (s.imgDisplayH <= ch) {
        s.imgDisplayY = (ch - s.imgDisplayH) / 2;
    } else {
        s.imgDisplayY = Math.min(0, Math.max(ch - s.imgDisplayH, s.imgDisplayY));
    }
}

function zoomSplitCropImage(canvas, scaleFactor, centerX, centerY) {
    const s = splitCropState;
    if (!s.image) return;
    const relRect = getSplitCropRelRect();
    const nextScale = Math.max(1, Math.min(6, s.viewScale * scaleFactor));
    if (Math.abs(nextScale - s.viewScale) < 0.001) return;
    const imagePointX = (centerX - s.imgDisplayX) / s.imgDisplayW;
    const imagePointY = (centerY - s.imgDisplayY) / s.imgDisplayH;
    s.viewScale = nextScale;
    s.imgDisplayW = canvas.width * nextScale;
    s.imgDisplayH = canvas.height * nextScale;
    s.imgDisplayX = centerX - imagePointX * s.imgDisplayW;
    s.imgDisplayY = centerY - imagePointY * s.imgDisplayH;
    constrainSplitImageView(canvas);
    setSplitCropFromRelRect(relRect);
    drawSplitCropCanvas(canvas);
}

function panSplitCropImage(canvas, dx, dy) {
    const s = splitCropState;
    const relRect = getSplitCropRelRect();
    s.imgDisplayX = s.imgStartX + dx;
    s.imgDisplayY = s.imgStartY + dy;
    constrainSplitImageView(canvas);
    setSplitCropFromRelRect(relRect);
    drawSplitCropCanvas(canvas);
}

// 预设模式裁剪框计算：根据预设类型和编号，返回归一化坐标 {x,y,w,h}
function getSplitCropPresetRect(preset, itemNumber, imgW, imgH) {
    if (!preset || !itemNumber || itemNumber < 1) return null;
    const is4 = preset.startsWith('4grid');
    const isPortrait = preset.endsWith('portrait');
    const cols = is4 ? 2 : 3;
    const rows = is4 ? 2 : 3;
    // 每格目标宽高比
    const cellAspect = isPortrait ? 3 / 4 : 4 / 3; // w/h

    // 整图宽高比
    const imgAspect = imgW / imgH;

    // 计算网格总区域：在整图中居中放置，使每格恰好满足目标宽高比
    // 每格宽 = gridW/cols, 每格高 = gridH/rows
    // cellAspect = (gridW/cols) / (gridH/rows) = gridW*rows / (gridH*cols)
    // gridW/gridH = cellAspect * cols / rows
    const gridAspect = cellAspect * cols / rows;

    let gridW, gridH, gridX, gridY;
    if (imgAspect > gridAspect) {
        // 图更宽，grid高度占满
        gridH = 1;
        gridW = gridAspect / imgAspect;
        gridX = (1 - gridW) / 2;
        gridY = 0;
    } else {
        // 图更高，grid宽度占满
        gridW = 1;
        gridH = (imgAspect / gridAspect);
        gridX = 0;
        gridY = (1 - gridH) / 2;
    }

    const cellW = gridW / cols;
    const cellH = gridH / rows;
    const idx = itemNumber - 1;
    const col = idx % cols;
    const row = Math.floor(idx / cols);

    if (row >= rows) return null; // 编号超出网格范围

    return {
        x: gridX + col * cellW,
        y: gridY + row * cellH,
        w: cellW,
        h: cellH
    };
}

function openSplitCropEditor(queueIdx) {
    const qd = splitQueueData[queueIdx];
    if (!qd) return;
    const item = getActiveSplitWorkItem(queueIdx);
    // 裁剪预览模式：始终加载原图（gridImageUrl），这样用户可以调整裁剪框恢复被裁掉的画面
    const imageUrl = item?.gridImageUrl || item?.croppedImageUrl || item?.imageUrl;
    if (!imageUrl) return;

    splitCropState.queueIdx = queueIdx;
    splitCropState.imageUrl = imageUrl;

    // 确定当前应激活的预设：workItem > 队列 > 全局默认
    const effectivePreset = item?.cropPreset || qd.cropPreset || state.modelConfig?.defaultCropPreset || null;
    splitCropState.activePreset = effectivePreset;

    const modal = document.getElementById('modal-split-crop');
    const canvas = document.getElementById('split-crop-canvas');
    if (!modal || !canvas) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        splitCropState.image = img;
        resizeSplitCropCanvasForImage(canvas, img);
        const cw = canvas.width;
        const ch = canvas.height;
        const dx = 0;
        const dy = 0;
        const dw = cw;
        const dh = ch;

        splitCropState.imgDisplayX = dx;
        splitCropState.imgDisplayY = dy;
        splitCropState.imgDisplayW = dw;
        splitCropState.imgDisplayH = dh;
        splitCropState.viewScale = 1;
        splitCropState.dragging = false;
        splitCropState.dragType = '';
        splitCropState.spaceDown = false;
        splitCropState.cropWheelMode = false;

        // 手动调整过的裁剪框必须优先，预设只用于首次创建或用户重新点预设。
        let appliedPreset = false;
        if (item?.cropRect) {
            const r = item.cropRect;
            splitCropState.cropX = dx + r.x * dw;
            splitCropState.cropY = dy + r.y * dh;
            splitCropState.cropW = r.w * dw;
            splitCropState.cropH = r.h * dh;
        } else if (effectivePreset && item?.number) {
            const presetRect = getSplitCropPresetRect(effectivePreset, item.number, img.width, img.height);
            if (presetRect) {
                splitCropState.cropX = dx + presetRect.x * dw;
                splitCropState.cropY = dy + presetRect.y * dh;
                splitCropState.cropW = presetRect.w * dw;
                splitCropState.cropH = presetRect.h * dh;
                appliedPreset = true;
            }
        }
        if (!item?.cropRect && !appliedPreset) {
            splitCropState.cropX = dx;
            splitCropState.cropY = dy;
            splitCropState.cropW = dw;
            splitCropState.cropH = dh;
        }

        // 更新预设按钮高亮状态
        updateSplitCropPresetButtons();

        drawSplitCropCanvas(canvas);
        modal.style.display = '';
    };
    img.src = imageUrl;
}

// 更新预设按钮高亮和默认星标
function updateSplitCropPresetButtons() {
    const btns = document.querySelectorAll('.split-crop-preset-btn');
    const defaultPreset = state.modelConfig?.defaultCropPreset || null;
    btns.forEach(btn => {
        const p = btn.dataset.preset;
        btn.classList.toggle('active', p === splitCropState.activePreset);
        btn.classList.toggle('is-default', p === defaultPreset);
    });
}

// 应用预设模式到当前裁剪框
function applySplitCropPreset(preset) {
    const s = splitCropState;
    if (!s.image) return;
    const item = getActiveSplitWorkItem(s.queueIdx);
    if (!item?.number) return;

    const presetRect = getSplitCropPresetRect(preset, item.number, s.image.width, s.image.height);
    if (!presetRect) {
        showToast('编号超出该预设网格范围', 'warning');
        return;
    }

    s.activePreset = preset;
    s.cropX = s.imgDisplayX + presetRect.x * s.imgDisplayW;
    s.cropY = s.imgDisplayY + presetRect.y * s.imgDisplayH;
    s.cropW = presetRect.w * s.imgDisplayW;
    s.cropH = presetRect.h * s.imgDisplayH;

    const canvas = document.getElementById('split-crop-canvas');
    if (canvas) drawSplitCropCanvas(canvas);
    updateSplitCropPresetButtons();
}

function drawSplitCropCanvas(canvas) {
    const ctx = canvas.getContext('2d');
    const cw = canvas.width;
    const ch = canvas.height;
    const s = splitCropState;

    ctx.clearRect(0, 0, cw, ch);
    if (s.image) ctx.drawImage(s.image, s.imgDisplayX, s.imgDisplayY, s.imgDisplayW, s.imgDisplayH);

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, cw, s.cropY);
    ctx.fillRect(0, s.cropY + s.cropH, cw, ch - s.cropY - s.cropH);
    ctx.fillRect(0, s.cropY, s.cropX, s.cropH);
    ctx.fillRect(s.cropX + s.cropW, s.cropY, cw - s.cropX - s.cropW, s.cropH);

    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.strokeRect(s.cropX, s.cropY, s.cropW, s.cropH);

    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 2; i++) {
        const xLine = s.cropX + (s.cropW * i) / 3;
        ctx.beginPath(); ctx.moveTo(xLine, s.cropY); ctx.lineTo(xLine, s.cropY + s.cropH); ctx.stroke();
        const yLine = s.cropY + (s.cropH * i) / 3;
        ctx.beginPath(); ctx.moveTo(s.cropX, yLine); ctx.lineTo(s.cropX + s.cropW, yLine); ctx.stroke();
    }

    const hs = SPLIT_CROP_HANDLE_SIZE;
    ctx.fillStyle = '#fff';
    const corners = [[s.cropX, s.cropY], [s.cropX + s.cropW, s.cropY], [s.cropX, s.cropY + s.cropH], [s.cropX + s.cropW, s.cropY + s.cropH]];
    for (const [cx, cy] of corners) ctx.fillRect(cx - hs/2, cy - hs/2, hs, hs);
}

function getSplitCropCanvasPos(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
}

function getSplitCropHitZone(mx, my) {
    const s = splitCropState;
    const hs = SPLIT_CROP_HANDLE_SIZE + 4;
    if (Math.abs(mx - s.cropX) < hs && Math.abs(my - s.cropY) < hs) return 'tl';
    if (Math.abs(mx - (s.cropX + s.cropW)) < hs && Math.abs(my - s.cropY) < hs) return 'tr';
    if (Math.abs(mx - s.cropX) < hs && Math.abs(my - (s.cropY + s.cropH)) < hs) return 'bl';
    if (Math.abs(mx - (s.cropX + s.cropW)) < hs && Math.abs(my - (s.cropY + s.cropH)) < hs) return 'br';
    if (mx >= s.cropX && mx <= s.cropX + s.cropW && my >= s.cropY && my <= s.cropY + s.cropH) return 'move';
    return '';
}

function constrainSplitCropBox() {
    const s = splitCropState;
    const minSize = 20;
    s.cropW = Math.max(minSize, s.cropW);
    s.cropH = Math.max(minSize, s.cropH);
    if (s.cropX < s.imgDisplayX) s.cropX = s.imgDisplayX;
    if (s.cropY < s.imgDisplayY) s.cropY = s.imgDisplayY;
    if (s.cropX + s.cropW > s.imgDisplayX + s.imgDisplayW) s.cropX = s.imgDisplayX + s.imgDisplayW - s.cropW;
    if (s.cropY + s.cropH > s.imgDisplayY + s.imgDisplayH) s.cropY = s.imgDisplayY + s.imgDisplayH - s.cropH;
    if (s.cropX < s.imgDisplayX) { s.cropX = s.imgDisplayX; s.cropW = Math.max(minSize, s.imgDisplayW); }
    if (s.cropY < s.imgDisplayY) { s.cropY = s.imgDisplayY; s.cropH = Math.max(minSize, s.imgDisplayH); }
}

async function confirmSplitCrop() {
    const s = splitCropState;
    if (!s.image) return;

    const relX = (s.cropX - s.imgDisplayX) / s.imgDisplayW;
    const relY = (s.cropY - s.imgDisplayY) / s.imgDisplayH;
    const relW = s.cropW / s.imgDisplayW;
    const relH = s.cropH / s.imgDisplayH;
    const x = Math.max(0, Math.min(1, relX));
    const y = Math.max(0, Math.min(1, relY));
    const w = Math.max(0.01, Math.min(1 - x, relW));
    const h = Math.max(0.01, Math.min(1 - y, relH));

    // 预览模式：只更新cropRect，不调用裁剪API，运行拆图时才实际裁剪
    const activeItem = getActiveSplitWorkItem(s.queueIdx);
    if (activeItem) {
        activeItem.gridImageUrl = activeItem.gridImageUrl || splitQueueData[s.queueIdx]?.gridImageUrl || s.imageUrl || activeItem.imageUrl || '';
        activeItem.cropRect = { x, y, w, h };
        activeItem.croppedImageUrl = '';  // 清除旧裁剪缓存，下次生成时重新裁剪
        // 写入预设到workItem
        activeItem.cropPreset = s.activePreset || null;
        syncActiveSplitItemToQueue(s.queueIdx);
    }
    // 队列继承：将预设写入队列，后续图自动使用
    if (s.activePreset && s.queueIdx >= 0) {
        const qd = splitQueueData[s.queueIdx];
        if (qd) qd.cropPreset = s.activePreset;
    }
    const splitModeRadio = document.querySelector('input[name="split-mode"]:checked')?.value || 'crop';
    if (splitModeRadio === 'crop' && activeItem?.number) {
        propagateLearnedSplitCropLayout(s.queueIdx, activeItem.number, { x, y, w, h });
        const afterItem = getActiveSplitWorkItem(s.queueIdx);
        if (s.queueIdx === activeSplitQueue) updateSplitCropOverlay(afterItem);
    } else if (s.queueIdx === activeSplitQueue) {
        updateSplitCropOverlay(activeItem);
    }
    const qdCropQueue = splitQueueData[s.queueIdx];
    if (qdCropQueue) qdCropQueue.splitAspectRatioManualOverride = false;
    applySplitAutoAspectRatioFromCrop(s.queueIdx);
    saveSplitQueueData();
    showToast('裁剪框已更新', 'success');
    document.getElementById('modal-split-crop').style.display = 'none';
}

// ========== 拆图模式事件绑定 ==========

document.addEventListener('DOMContentLoaded', () => {
    renderDiagStatusBar();
    runDiagHealthCheck();
    setInterval(runDiagHealthCheck, 20000);
    document.getElementById('btn-diag-refresh')?.addEventListener('click', runDiagHealthCheck);

    // 后端能力自检：避免前端新版本 + 后端旧版本导致“结果丢失/图库空”
    (async () => {
        try {
            await api('GET', '/api/split-queue-data', null, 12000);
        } catch (e) {
            if ((e?.message || '').includes('404')) {
                showToast('后端版本过旧：缺少拆图队列接口，请重启软件后端', 'error');
            }
        }
        try {
            await api('GET', '/api/gallery', null, 12000);
        } catch (e) {
            if ((e?.message || '').includes('404')) {
                showToast('后端版本过旧：缺少图库接口，请重启软件后端', 'error');
            }
        }
    })();

    // 拆图左侧素材库：搜索与新增分类
    document.getElementById('split-img-lib-search')?.addEventListener('input', () => renderSplitLibrary());
    document.getElementById('btn-split-add-img-lib-category')?.addEventListener('click', async () => {
        const name = await showPrompt('输入新素材分类名称', '', '分类名称');
        if (!name || !name.trim()) return;
        try {
            const cat = await api('POST', '/api/image-library', { name: name.trim() });
            imageState.library.push(cat);
            imageState.expandedLibCategory = cat.id;
            imageState.loaded = true;
            await renderImageLibrary();
            showToast('素材分类添加成功', 'success');
        } catch (e) {
            showToast('添加分类失败: ' + e.message, 'error');
        }
    });

    // 编号点选按钮
    document.querySelectorAll('.split-num-btn').forEach(btn => {
        // 仅绑定九宫格编号选择，不绑定工作项tab按钮
        if (!btn.closest('.grid-split-number-row')) return;
        btn.addEventListener('click', () => {
            const num = parseInt(btn.dataset.num, 10);
            if (!Number.isFinite(num)) return;
            const qd = splitQueueData[activeSplitQueue];
            if (!qd) return;
            if (!Array.isArray(qd.selectedNums)) qd.selectedNums = [];
            const idx = qd.selectedNums.indexOf(num);
            if (idx >= 0) {
                qd.selectedNums.splice(idx, 1);
            } else {
                qd.selectedNums.push(num);
            }
            renderSplitNumSelectionForQueue(activeSplitQueue);
            saveSplitQueueData();
        });
    });

    // 确认拆图按钮
    document.getElementById('btn-split-confirm')?.addEventListener('click', confirmSplitGrid);

    // 拆图模式切换时加载对应模板
    document.querySelectorAll('input[name="split-mode"]').forEach(radio => {
        radio.addEventListener('change', () => loadSplitTemplate(radio.value));
    });
    document.getElementById('btn-split-template-add')?.addEventListener('click', openSplitTemplateAddModal);
    document.getElementById('btn-split-template-manage')?.addEventListener('click', openSplitTemplateManageModal);
    // 初始化模板按钮
    renderSplitTemplateButtons();
    // 初始化素材槽位
    _initSplitMaterialSlots();

    // 上传区域
    const splitDropZone = document.getElementById('split-drop-zone');
    const splitFileInput = document.getElementById('split-file');
    if (splitDropZone && splitFileInput) {
        const openSplitGallery = () => {
            galleryPickerContext = { mode: 'split', recentDays: 3 };
            galleryRecentDays = 3;
            openModal('modal-gallery');
            loadGallery();
        };
        splitDropZone.addEventListener('click', (ev) => {
            if (ev.target.closest('#btn-split-pick-local') || ev.target.closest('#split-open-gallery')) return;
            openSplitGallery();
        });
        document.getElementById('btn-split-pick-local')?.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            splitFileInput.click();
        });
        document.getElementById('split-open-gallery')?.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            openSplitGallery();
        });
        splitFileInput.addEventListener('change', (e) => {
            const fl = e.target.files;
            if (fl?.length) handleSplitUpload(fl);
            e.target.value = '';
        });
        splitDropZone.addEventListener('dragover', (e) => { e.preventDefault(); splitDropZone.classList.add('dragover'); });
        splitDropZone.addEventListener('dragleave', () => splitDropZone.classList.remove('dragover'));
        splitDropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            splitDropZone.classList.remove('dragover');
            const fl = e.dataTransfer?.files;
            if (fl?.length) handleSplitUpload(fl);
        });
    }

    // 预览图删除
    document.getElementById('split-delete-preview')?.addEventListener('click', (e) => {
        e.stopPropagation();
        resetSplitPreview();
    });

    // 拆图生成按钮
    document.getElementById('btn-split-generate')?.addEventListener('click', () => runSplitGenerate(activeSplitQueue));
    document.getElementById('btn-split-batch-generate')?.addEventListener('click', runSplitBatchGenerate);
    document.getElementById('btn-split-batch-generate-all')?.addEventListener('click', runSplitBatchGenerateAllMaterials);
    document.getElementById('btn-split-cancel')?.addEventListener('click', () => cancelSplitGenerate(activeSplitQueue));

    // 拆图提示词输入
    document.getElementById('split-prompt-cn')?.addEventListener('input', () => {
        const item = getActiveSplitWorkItem(activeSplitQueue);
        if (item) item.promptCn = document.getElementById('split-prompt-cn').value;
    });
    document.getElementById('btn-split-sync-prompt-all')?.addEventListener('click', syncSplitPromptToAllWorkItems);

    // 拆图API平台切换（切换通道后按裁剪横竖重算默认比例）
    document.getElementById('split-cfg-api-platform')?.addEventListener('change', () => {
        readSplitApiConfigToQueue(activeSplitQueue);
        const qdPl = splitQueueData[activeSplitQueue];
        syncSplitRhAspectRatioSelectForQueue(qdPl);
        applySplitAutoAspectRatioFromCrop(activeSplitQueue);
        updateSplitApiPlatformUI();
        saveSplitQueueData();
    });
    document.getElementById('split-cfg-rh-seed-mode')?.addEventListener('change', () => {
        const seedInput = document.getElementById('split-cfg-rh-seed');
        if (seedInput) seedInput.disabled = document.getElementById('split-cfg-rh-seed-mode')?.value !== 'fixed';
    });
    document.getElementById('split-cfg-download-path')?.addEventListener('change', () => {
        const qd = splitQueueData[activeSplitQueue];
        if (!qd) return;
        const el = document.getElementById('split-cfg-download-path');
        if (el) el.dataset.downloadPathInherited = '0';
        qd.downloadPath = cleanDownloadPath(el?.value);
        saveSplitQueueData();
    });
    document.getElementById('split-cfg-image-prefix')?.addEventListener('change', () => {
        const qd = splitQueueData[activeSplitQueue];
        if (!qd) return;
        qd.imagePrefix = document.getElementById('split-cfg-image-prefix')?.value?.trim() || '';
        saveSplitQueueData();
    });
    document.getElementById('split-cfg-auto-backup')?.addEventListener('change', () => {
        const qd = splitQueueData[activeSplitQueue];
        if (!qd) return;
        qd.autoBackup = document.getElementById('split-cfg-auto-backup')?.checked ?? true;
        saveSplitQueueData();
    });

    // 拆图文件夹选择
    document.getElementById('btn-split-select-folder')?.addEventListener('click', async () => {
        try {
            const currentPath = getEffectiveSplitDownloadPath(activeSplitQueue);
            const resp = await api('POST', '/api/select-folder', { initial_dir: currentPath });
            if (resp && resp.path) {
                markDownloadPathInputAsOwn('split-cfg-download-path', resp.path);
                splitQueueData[activeSplitQueue].downloadPath = resp.path;
                saveSplitQueueData();
                showToast(`拆图队列${activeSplitQueue + 1}已设置下载路径: ${resp.path}`, 'success');
            }
        } catch(e) {
            showToast('选择文件夹失败: ' + e.message, 'error');
        }
    });

    // 拆图清除结果按钮
    document.getElementById('btn-split-clear-results')?.addEventListener('click', () => {
        if (!confirm('确认清除当前队列所有生成结果？')) return;
        const qd = splitQueueData[activeSplitQueue];
        if (!qd) return;
        // 若该队列仍在生成，先阻止清除，避免状态错乱
        if (splitGenerateStates[activeSplitQueue]?.running) {
            showToast('当前队列仍在生成，请先取消后再清除结果', 'warning');
            return;
        }
        qd.results = [];
        // 清除顶部“总数-已完成”状态标记
        qd.progressTotal = 0;
        qd.progressDone = 0;
        // 清除工作区引用（九宫格/工作项），恢复空白队列状态
        qd.gridImageUrl = '';
        qd.sourceFilename = '';
        qd.learnedGridLayout = null;
        qd.workItems = [];
        qd.activeItemIndex = 0;
        qd.imageUrl = '';
        qd.croppedImageUrl = '';
        qd.promptCn = '';
        qd.number = 0;
        qd.selectedNums = [];
        qd.selectedPrefixIds = [];
        qd.selectedSuffixIds = [];
        qd.splitAspectRatioManualOverride = false;
        qd.materials = [];
        qd.activeMaterialIndex = 0;
        normalizeSplitQueueMaterials(qd);
        loadActiveSplitMaterialIntoQueue(qd, 0);
        // 恢复该队列模型到拆图默认模型
        const splitConfig = getSplitDefaultModelConfig();
        if (splitConfig) {
            qd.apiPlatform = splitConfig.platform || 'oaihk';
            qd.rhModelId = splitConfig.rhModelId || qd.rhModelId || '';
            qd.oaihkModelId = splitConfig.oaihkModelId || qd.oaihkModelId || 'fal-ai/banana/v3.1/flash/2k';
            qd.rhResolution = splitConfig.rhResolution || qd.rhResolution || '1k';
            qd.rhAspectRatio = splitConfig.rhAspectRatio || qd.rhAspectRatio || '3:4';
            qd.oaihkAspectRatio = splitConfig.oaihkAspectRatio || qd.oaihkAspectRatio || '3:4';
        } else {
            qd.apiPlatform = 'oaihk';
            qd.oaihkModelId = 'fal-ai/banana/v3.1/flash/2k';
            qd.oaihkAspectRatio = '3:4';
            qd.rhResolution = qd.rhResolution || '1k';
            qd.rhAspectRatio = '3:4';
        }
        saveSplitQueueData();
        writeSplitApiConfigFromQueue(activeSplitQueue);
        applySplitSourcePreview(activeSplitQueue);
        renderSplitMaterialTabs(activeSplitQueue);
        renderSplitNumSelectionForQueue(activeSplitQueue);
        renderSplitWorkItemTabs(activeSplitQueue);
        renderSplitQueueResults(activeSplitQueue);
        renderSplitQueueNumberBar();
        updateSplitGenerateBtnState();
        updateSplitDefaultModelBadge();
        showToast('已清除该列队结果与状态，模型已恢复默认', 'success');
    });

    // 拆图下载按钮
    const splitDownloadAllHandler = async () => {
        const qd = splitQueueData[activeSplitQueue];
        if (!qd || !qd.results || qd.results.length === 0) { showToast('没有可下载的结果', 'warning'); return; }
        let okCount = 0;
        let failCount = 0;
        const failReasons = [];
        for (const item of qd.results) {
            const resp = await downloadImageAsJpg(item.url, qd.imagePrefix || 'split', getEffectiveSplitDownloadPath(activeSplitQueue));
            if (resp.ok) okCount++;
            else {
                failCount++;
                if (resp.error && failReasons.length < 3) failReasons.push(resp.error);
            }
        }
        if (okCount > 0) showToast(`已下载 ${okCount} 张`, 'success');
        if (failCount > 0) {
            const detail = failReasons.join('；') || '未知错误';
            if (detail.includes('pro.filesystem.site')) {
                showToast(`${failCount}张下载失败：${detail}（请重启后端使白名单生效）`, 'error');
            } else {
                showToast(`${failCount}张下载失败：${detail}`, 'error');
            }
        }
    };
    document.getElementById('btn-split-download-all-btn')?.addEventListener('click', splitDownloadAllHandler);
    // 兼容旧按钮ID
    document.getElementById('btn-split-download-all')?.addEventListener('click', splitDownloadAllHandler);
    document.getElementById('btn-split-download-checked')?.addEventListener('click', async () => {
        const qd = splitQueueData[activeSplitQueue];
        if (!qd || !qd.results || qd.results.length === 0) { showToast('没有可下载的结果', 'warning'); return; }
        const selected = qd.results.filter(r => r.checked);
        if (selected.length === 0) { showToast('请先勾选要下载的图片', 'warning'); return; }
        let okCount = 0;
        let failCount = 0;
        const failReasons = [];
        for (const item of selected) {
            const resp = await downloadImageAsJpg(item.url, qd.imagePrefix || 'split', getEffectiveSplitDownloadPath(activeSplitQueue));
            if (resp.ok) okCount++;
            else {
                failCount++;
                if (resp.error && failReasons.length < 3) failReasons.push(resp.error);
            }
        }
        if (okCount > 0) showToast(`已下载勾选 ${okCount} 张`, 'success');
        if (failCount > 0) {
            const detail = failReasons.join('；') || '未知错误';
            if (detail.includes('pro.filesystem.site')) {
                showToast(`${failCount}张下载失败：${detail}（请重启后端使白名单生效）`, 'error');
            } else {
                showToast(`${failCount}张下载失败：${detail}`, 'error');
            }
        }
    });
    document.getElementById('btn-split-retry-failed')?.addEventListener('click', runSplitRetryFailed);

    // 拆图打开文件夹按钮
    document.getElementById('btn-split-open-folder')?.addEventListener('click', async () => {
        const path = getEffectiveSplitDownloadPath(activeSplitQueue);
        try {
            await api('POST', '/api/open-download-folder', { path });
        } catch(e) {
            showToast('打开文件夹失败', 'error');
        }
    });

    // 编辑裁剪按钮
    document.getElementById('btn-split-edit-crop')?.addEventListener('click', () => {
        const item = getActiveSplitWorkItem(activeSplitQueue);
        if (item?.imageUrl || item?.croppedImageUrl) {
            openSplitCropEditor(activeSplitQueue);
        }
    });

    // 点击图片进入编辑
    document.getElementById('split-current-img')?.addEventListener('click', () => {
        const item = getActiveSplitWorkItem(activeSplitQueue);
        if (item?.imageUrl || item?.croppedImageUrl) {
            openSplitCropEditor(activeSplitQueue);
        }
    });
    document.getElementById('split-current-img')?.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const qd = splitQueueData[activeSplitQueue];
        const item = getActiveSplitWorkItem(activeSplitQueue);
        if (!qd || !item || (!item.imageUrl && !item.croppedImageUrl)) return;
        if (!confirm('确认清除当前拆图工作区图片？')) return;
        qd.workItems.splice(qd.activeItemIndex, 1);
        if (qd.activeItemIndex >= qd.workItems.length) qd.activeItemIndex = Math.max(0, qd.workItems.length - 1);
        syncActiveSplitItemToQueue(activeSplitQueue);
        saveSplitQueueData();
        loadSplitQueueToUI(activeSplitQueue);
        renderSplitQueueNumberBar();
        updateSplitGenerateBtnState();
        showToast('已清除当前拆图工作区图片', 'success');
    });

    // 裁剪确认按钮
    document.getElementById('btn-split-crop-confirm')?.addEventListener('click', confirmSplitCrop);

    // 预设裁剪按钮事件
    document.querySelectorAll('.split-crop-preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            applySplitCropPreset(btn.dataset.preset);
        });
        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const preset = btn.dataset.preset;
            state.modelConfig.defaultCropPreset = preset;
            api('PUT', '/api/model-config', { defaultCropPreset: preset }).catch(() => {});
            updateSplitCropPresetButtons();
            showToast(`已将「${btn.textContent.trim()}」设为默认预设`, 'success');
        });
    });

    // 裁剪画布鼠标交互
    const splitCropCanvas = document.getElementById('split-crop-canvas');
    if (splitCropCanvas) {
        splitCropCanvas.addEventListener('mousedown', (e) => {
            const pos = getSplitCropCanvasPos(splitCropCanvas, e);
            const zone = getSplitCropHitZone(pos.x, pos.y);
            splitCropState.dragging = true;
            splitCropState.dragType = (!zone || splitCropState.spaceDown) ? 'pan' : zone;
            splitCropState.dragStartX = pos.x;
            splitCropState.dragStartY = pos.y;
            splitCropState.cropStartX = splitCropState.cropX;
            splitCropState.cropStartY = splitCropState.cropY;
            splitCropState.cropStartW = splitCropState.cropW;
            splitCropState.cropStartH = splitCropState.cropH;
            splitCropState.imgStartX = splitCropState.imgDisplayX;
            splitCropState.imgStartY = splitCropState.imgDisplayY;
            if (splitCropState.dragType !== 'pan') {
                // 手动拖拽裁剪框时清除预设标记
                splitCropState.activePreset = null;
                updateSplitCropPresetButtons();
            }
            e.preventDefault();
        });

        splitCropCanvas.addEventListener('mousemove', (e) => {
            if (!splitCropState.dragging) {
                const pos = getSplitCropCanvasPos(splitCropCanvas, e);
                const zone = getSplitCropHitZone(pos.x, pos.y);
                if (splitCropState.spaceDown) splitCropCanvas.style.cursor = 'grab';
                else if (zone === 'tl' || zone === 'br') splitCropCanvas.style.cursor = 'nwse-resize';
                else if (zone === 'tr' || zone === 'bl') splitCropCanvas.style.cursor = 'nesw-resize';
                else if (zone === 'move') splitCropCanvas.style.cursor = 'move';
                else splitCropCanvas.style.cursor = 'grab';
                return;
            }
            const pos = getSplitCropCanvasPos(splitCropCanvas, e);
            const dx = pos.x - splitCropState.dragStartX;
            const dy = pos.y - splitCropState.dragStartY;
            const s = splitCropState;
            if (s.dragType === 'pan') {
                splitCropCanvas.style.cursor = 'grabbing';
                panSplitCropImage(splitCropCanvas, dx, dy);
                return;
            } else if (s.dragType === 'move') { s.cropX = s.cropStartX + dx; s.cropY = s.cropStartY + dy; }
            else if (s.dragType === 'tl') { s.cropX = s.cropStartX + dx; s.cropY = s.cropStartY + dy; s.cropW = s.cropStartW - dx; s.cropH = s.cropStartH - dy; }
            else if (s.dragType === 'tr') { s.cropY = s.cropStartY + dy; s.cropW = s.cropStartW + dx; s.cropH = s.cropStartH - dy; }
            else if (s.dragType === 'bl') { s.cropX = s.cropStartX + dx; s.cropW = s.cropStartW - dx; s.cropH = s.cropStartH + dy; }
            else if (s.dragType === 'br') { s.cropW = s.cropStartW + dx; s.cropH = s.cropStartH + dy; }
            constrainSplitCropBox();
            drawSplitCropCanvas(splitCropCanvas);
        });

        const endDrag = () => { splitCropState.dragging = false; splitCropState.dragType = ''; };
        document.addEventListener('mouseup', endDrag);
        splitCropCanvas.addEventListener('mouseleave', () => {
            if (!splitCropState.dragging) return;
        });

        splitCropCanvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const s = splitCropState;
            const pos = getSplitCropCanvasPos(splitCropCanvas, e);
            if (s.cropWheelMode) {
                const scale = e.deltaY > 0 ? 0.95 : 1.05;
                const cx = s.cropX + s.cropW / 2;
                const cy = s.cropY + s.cropH / 2;
                s.cropW *= scale;
                s.cropH *= scale;
                s.cropX = cx - s.cropW / 2;
                s.cropY = cy - s.cropH / 2;
                constrainSplitCropBox();
                s.activePreset = null;
                updateSplitCropPresetButtons();
                drawSplitCropCanvas(splitCropCanvas);
                return;
            }
            zoomSplitCropImage(splitCropCanvas, e.deltaY > 0 ? 0.9 : 1.1, pos.x, pos.y);
        });

        document.addEventListener('keydown', (e) => {
            if (document.getElementById('modal-split-crop')?.style.display === 'none') return;
            if (e.code === 'Space') {
                splitCropState.spaceDown = true;
                splitCropCanvas.style.cursor = 'grab';
                e.preventDefault();
            }
            if (e.key?.toLowerCase() === 'c') {
                splitCropState.cropWheelMode = true;
            }
        });

        document.addEventListener('keyup', (e) => {
            if (e.code === 'Space') splitCropState.spaceDown = false;
            if (e.key?.toLowerCase() === 'c') splitCropState.cropWheelMode = false;
        });
    }

    // 拆图预览大小滑杆
    document.getElementById('split-preview-size-slider')?.addEventListener('input', (e) => {
        const grid = document.getElementById('split-result-grid');
        if (grid) grid.style.gridTemplateColumns = `repeat(auto-fill,minmax(${e.target.value}px,1fr))`;
    });
});

// 页面关闭/刷新时保存数据，防止丢失
window.addEventListener('beforeunload', () => {
    // Force immediate save - clear debounce timers and save directly
    if (_saveQueueTimer) { clearTimeout(_saveQueueTimer); _saveQueueTimer = null; }
    if (_saveSplitQueueTimer) { clearTimeout(_saveSplitQueueTimer); _saveSplitQueueTimer = null; }
    saveQueueData();
    saveCurrentSplitQueueData();
});

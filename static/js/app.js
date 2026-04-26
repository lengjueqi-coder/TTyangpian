// ========== 全局状态 ==========
const SLOT_COUNT = 10;
const QUEUE_COUNT = 10;
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
let undoStack = [];
let _undoEnabled = true; // 可临时禁用（恢复快照时）

function pushUndoSnapshot() {
    if (!_undoEnabled) return;
    const snapshot = {
        slots: JSON.parse(JSON.stringify(imageState.slots)),
        promptCn: document.getElementById('img-prompt-cn')?.value || '',
        promptEn: document.getElementById('img-prompt-en')?.value || '',
        promptedSlotIndices: [...promptedSlotIndices],
        // pinnedSlotIndices is global, not in per-queue snapshot
        lastAutoPrompt: lastAutoPrompt,
        selectedItems: JSON.parse(JSON.stringify(state.selectedItems)),
        selectedPrefixes: [...state.selectedPrefixes],
        selectedSuffixes: [...state.selectedSuffixes],
        generatedPrompt: state.generatedPrompt,
        queueData: JSON.parse(JSON.stringify(queueData)),
        activeQueue: activeQueue,
        queueMode: queueMode,
        library: JSON.parse(JSON.stringify(imageState.library)),
        categories: JSON.parse(JSON.stringify(state.categories)),
    };
    undoStack.push(snapshot);
    if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
    updateUndoUI();
}

function undo() {
    if (undoStack.length === 0) return;
    const snapshot = undoStack.pop();
    _undoEnabled = false;
    try {
        // 恢复图片模式状态
        imageState.slots = snapshot.slots;
        const promptCnEl = document.getElementById('img-prompt-cn');
        const promptEnEl = document.getElementById('img-prompt-en');
        if (promptCnEl) promptCnEl.value = snapshot.promptCn;
        if (promptEnEl) promptEnEl.value = snapshot.promptEn;
        imageState.promptCn = snapshot.promptCn;
        imageState.promptEn = snapshot.promptEn;
        promptedSlotIndices = new Set(snapshot.promptedSlotIndices);
        // pinnedSlotIndices is global, not restored from snapshot
        lastAutoPrompt = snapshot.lastAutoPrompt;

        // 恢复文字模式选择状态
        state.selectedItems = snapshot.selectedItems;
        state.selectedPrefixes = snapshot.selectedPrefixes;
        state.selectedSuffixes = snapshot.selectedSuffixes;
        state.generatedPrompt = snapshot.generatedPrompt;

        // 恢复队列数据
        queueData = snapshot.queueData;
        activeQueue = snapshot.activeQueue;
        queueMode = snapshot.queueMode;

        // 恢复素材库
        imageState.library = snapshot.library;
        state.categories = snapshot.categories;

        // 刷新所有 UI
        renderImageSlots();
        renderImageLibrary();
        renderQueueNumberBars();
        updateGenerateBtnText();
        // 恢复队列模式按钮状态
        document.querySelectorAll('.queue-mode-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.queueMode === queueMode);
        });
        // 恢复队列数据到当前活动队列
        if (queueMode === 'multi') {
            loadQueueData(activeQueue);
        }
        // 刷新文字模式 UI
        if (typeof renderCategoryList === 'function') renderCategoryList();
        if (typeof renderPresets === 'function') renderPresets();
        if (typeof updatePreview === 'function') updatePreview();
        // 恢复批量生成按钮
        const batchBtn = document.getElementById('btn-api-batch-generate');
        if (batchBtn) batchBtn.style.display = queueMode === 'multi' ? 'inline-flex' : 'none';

        showToast(`已撤销（剩余${undoStack.length}步）`, 'info');
        // 持久化撤销后的状态到服务器
        saveQueueData();
    } finally {
        _undoEnabled = true;
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

// 提示词 textarea 手动编辑时保存撤销快照
let _promptCnBeforeEdit = '';
let _promptEnBeforeEdit = '';
document.getElementById('img-prompt-cn')?.addEventListener('focus', () => { _promptCnBeforeEdit = document.getElementById('img-prompt-cn')?.value || ''; });
document.getElementById('img-prompt-cn')?.addEventListener('blur', () => {
    const cur = document.getElementById('img-prompt-cn')?.value || '';
    if (cur !== _promptCnBeforeEdit) pushUndoSnapshot();
});
document.getElementById('img-prompt-en')?.addEventListener('focus', () => { _promptEnBeforeEdit = document.getElementById('img-prompt-en')?.value || ''; });
document.getElementById('img-prompt-en')?.addEventListener('blur', () => {
    const cur = document.getElementById('img-prompt-en')?.value || '';
    if (cur !== _promptEnBeforeEdit) pushUndoSnapshot();
});

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

function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) {
    document.getElementById(id).style.display = 'none';
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
                        queueData[q].slots.push({ image: '', label: '', prefixTemplate: '请参考' });
                    }
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
                if (savedAQ) activeQueue = parseInt(savedAQ) || 0;
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
                slots: Array.from({length: SLOT_COUNT}, () => ({ image: '', label: '', prefixTemplate: '请参考' })),
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
            if (savedPresetZoom) state.presetZoom = parseInt(savedPresetZoom) || 4;
        } catch(e) {}

        if (lastSel) restoreSelection(lastSel);

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
            const newCols = parseInt(e.target.value);
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
    $('#upload-preview').style.display = 'none';
    $('#upload-placeholder').style.display = 'flex';
    // 重置效果图上传
    $('#upload-preview-effect').style.display = 'none';
    $('#upload-placeholder-effect').style.display = 'flex';

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
    $('#upload-preview').style.display = 'none';
    $('#upload-placeholder').style.display = 'flex';
    // 重置效果图上传
    $('#upload-preview-effect').style.display = 'none';
    $('#upload-placeholder-effect').style.display = 'flex';

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
    if (preset.cover_image) {
        $('#upload-preview').src = preset.cover_image;
        $('#upload-preview').style.display = 'block';
        $('#upload-placeholder').style.display = 'none';
    } else {
        $('#upload-preview').style.display = 'none';
        $('#upload-placeholder').style.display = 'flex';
    }

    // 效果图预览
    if (preset.effect_image) {
        $('#upload-preview-effect').src = preset.effect_image;
        $('#upload-preview-effect').style.display = 'block';
        $('#upload-placeholder-effect').style.display = 'none';
    } else {
        $('#upload-preview-effect').style.display = 'none';
        $('#upload-placeholder-effect').style.display = 'flex';
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
$('#btn-export').addEventListener('click', () => {
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
$('#btn-import').addEventListener('click', () => {
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

// ========== 清理未引用图片 ==========
$('#btn-cleanup-images').addEventListener('click', () => {
    showConfirm('确定要清理未被任何数据引用的孤立图片吗？此操作不可恢复。', async () => {
        try {
            const result = await api('POST', '/api/cleanup-images');
            if (result.success) {
                if (result.deleted > 0) {
                    showToast(`已清理${result.deleted}张孤立图片，释放${result.freed_kb}KB`, 'success');
                } else {
                    showToast('没有发现孤立图片', 'info');
                }
            }
        } catch (e) {
            showToast('清理失败: ' + e.message, 'error');
        }
    });
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
        $('#cfg-rh-download-path').value = config.rh_download_path || '~/Downloads/AI生图/';

        // OpenAI-HK 配置
        $('#cfg-oaihk-api-key').value = config.oaihk_api_key || '';
        $('#cfg-oaihk-base-url').value = config.oaihk_base_url || '';

        // 上传压缩设置
        const uploadShortEdge = config.upload_short_edge || 1536;
        const seInput = document.getElementById('cfg-upload-short-edge');
        if (seInput) seInput.value = uploadShortEdge;
        // 高亮对应预设按钮
        document.querySelectorAll('#cfg-upload-preset-group .upload-preset-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.value) === uploadShortEdge);
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
        provider: $('#cfg-provider').value, api_key: $('#cfg-api-key').value, base_url: $('#cfg-base-url').value, model_name: $('#cfg-model-name').value, timeout_ms: parseInt($('#cfg-timeout').value) || 30000, retry_count: parseInt($('#cfg-retry').value) || 1,
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
        rh_download_path: $('#cfg-rh-download-path').value,
        // OpenAI-HK
        oaihk_api_key: $('#cfg-oaihk-api-key').value,
        oaihk_base_url: $('#cfg-oaihk-base-url').value,
        // 上传压缩设置
        upload_short_edge: parseInt($('#cfg-upload-short-edge')?.value) || 1536,
        // 系统提示词
        system_prompt_prompt: $('#cfg-system-prompt-prompt').value,
        system_prompt_bilingual: $('#cfg-system-prompt-bilingual').value,
        system_prompt_translate: $('#cfg-system-prompt-translate').value
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
        const config = { provider: $('#cfg-provider').value, api_key: $('#cfg-api-key').value, base_url: $('#cfg-base-url').value, model_name: $('#cfg-model-name').value, timeout_ms: parseInt($('#cfg-timeout').value) || 30000 };
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
    state.presetZoom = parseInt(e.target.value);
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
        { image: '', label: '', prefixTemplate: '请参考' },
        { image: '', label: '', prefixTemplate: '请参考' }
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

// ---------- 多图队列系统 ----------
// QUEUE_COUNT 已在文件顶部声明
let queueMode = 'same'; // 'same' = 同图抽卡, 'multi' = 多图队列
let activeQueue = 0;     // 当前活动的队列编号 (0-9)

// 每个队列独立的数据：{ slots: [...], promptCn: '', promptEn: '', results: [...], apiPlatform, rhModelId, ... }
let queueData = [];
function initQueueData() {
    // 队列数据现在从服务端加载（loadAllData 中处理）
    // 这里仅确保有10个队列
    while (queueData.length < QUEUE_COUNT) {
        queueData.push({
            slots: Array.from({length: SLOT_COUNT}, () => ({ image: '', label: '', prefixTemplate: '请参考' })),
            promptCn: '',
            promptEn: '',
            results: [],
            apiPlatform: 'oaihk',
            rhModelId: '',
            oaihkModelId: 'fal-ai/banana/v3.1/flash/2k',
            rhAspectRatio: '3:4',
            oaihkAspectRatio: '1:1',
            rhResolution: '1k',
            rhCount: 1,
            rhSeedMode: 'random',
            rhSeed: ''
        });
    }
    // 兼容旧数据：确保每个队列都有新字段
    for (let q = 0; q < queueData.length; q++) {
        if (!queueData[q].results) queueData[q].results = [];
        if (!queueData[q].apiPlatform) queueData[q].apiPlatform = 'oaihk';
        if (!queueData[q].rhModelId) queueData[q].rhModelId = '';
        if (!queueData[q].oaihkModelId) queueData[q].oaihkModelId = 'fal-ai/banana/v3.1/flash/2k';
        if (!queueData[q].rhAspectRatio) queueData[q].rhAspectRatio = '3:4';
        if (!queueData[q].oaihkAspectRatio) queueData[q].oaihkAspectRatio = '1:1';
        if (!queueData[q].rhResolution) queueData[q].rhResolution = '1k';
        if (queueData[q].rhCount === undefined) queueData[q].rhCount = 1;
        if (!queueData[q].rhSeedMode) queueData[q].rhSeedMode = 'random';
        if (queueData[q].rhSeed === undefined) queueData[q].rhSeed = '';
    }
}

let _saveQueueTimer = null;
function saveQueueData() {
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
        queueData[q].slots = JSON.parse(JSON.stringify(q1.slots));
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
    renderQueueNumberBars();
    updateGenerateBtnText();
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
    q.slots = JSON.parse(JSON.stringify(imageState.slots));
    q.promptCn = document.getElementById('img-prompt-cn')?.value || '';
    q.promptEn = document.getElementById('img-prompt-en')?.value || '';
    // 保存 API 配置
    q.apiPlatform = document.getElementById('cfg-api-platform')?.value || 'oaihk';
    q.rhModelId = document.getElementById('cfg-rh-model-inline')?.value || '';
    q.oaihkModelId = document.getElementById('cfg-oaihk-model-inline')?.value || '';
    q.rhAspectRatio = document.getElementById('cfg-rh-aspect-ratio-inline')?.value || '3:4';
    q.oaihkAspectRatio = document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '1:1';
    q.rhResolution = document.getElementById('cfg-rh-resolution-inline')?.value || '1k';
    q.rhCount = parseInt(document.getElementById('cfg-rh-count-inline')?.value) || 1;
    q.rhSeedMode = document.getElementById('cfg-rh-seed-mode-inline')?.value || 'random';
    q.rhSeed = document.getElementById('cfg-rh-seed-inline')?.value || '';
    // 保存前缀/后缀/预设状态
    q.selectedPrefixIds = [...selectedPrefixIds];
    q.selectedSuffixIds = [...selectedSuffixIds];
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
    setSelectValue('cfg-oaihk-aspect-ratio-inline', q.oaihkAspectRatio || '1:1');
    setSelectValue('cfg-rh-resolution-inline', q.rhResolution || '1k');
    const countEl = document.getElementById('cfg-rh-count-inline');
    if (countEl) countEl.value = q.rhCount || 1;
    setSelectValue('cfg-rh-seed-mode-inline', q.rhSeedMode || 'random');
    const seedEl = document.getElementById('cfg-rh-seed-inline');
    if (seedEl) { seedEl.value = q.rhSeed || ''; seedEl.disabled = (q.rhSeedMode || 'random') !== 'fixed'; }
    // 触发平台切换，显示/隐藏对应配置区
    togglePlatformUI(platform);
    // 触发模型参数适配
    updateRhModelParamsInline();
}

// 从队列加载数据到UI
function loadQueueData(qIndex) {
    const q = queueData[qIndex];
    if (!q) return; // 防御性检查
    imageState.slots = JSON.parse(JSON.stringify(q.slots));
    // 确保有10个槽位
    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考' });
    }
    const promptCn = document.getElementById('img-prompt-cn');
    const promptEn = document.getElementById('img-prompt-en');
    if (promptCn) promptCn.value = q.promptCn || '';
    if (promptEn) promptEn.value = q.promptEn || '';
    // 恢复前缀/后缀/预设状态
    selectedPrefixIds = new Set(q.selectedPrefixIds || []);
    selectedSuffixIds = new Set(q.selectedSuffixIds || []);
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
        const hasData = queueData[i].slots.some(s => s.image || s.label) || queueData[i].promptCn;
        const isGenerating = queueGenerateStates[i]?.running;
        const stateClass = isGenerating ? ' generating' : '';
        const stateIcon = isGenerating ? ' <span class="queue-gen-indicator"></span>' : '';
        return `<button class="queue-num-btn ${isActive ? 'active' : ''}${stateClass}" data-queue="${i}" title="队列 ${i+1}">${i+1}${hasData ? ' <span class="dot">●</span>' : ''}${stateIcon}</button>`;
    }).join('');

    bar1.innerHTML = html;
    bar2.innerHTML = html;

    // 绑定点击事件
    bar1.querySelectorAll('.queue-num-btn').forEach(btn => {
        btn.addEventListener('click', () => switchToQueue(parseInt(btn.dataset.queue)));
    });
    bar2.querySelectorAll('.queue-num-btn').forEach(btn => {
        btn.addEventListener('click', () => switchToQueue(parseInt(btn.dataset.queue)));
    });
}

// 队列模式切换
function switchQueueMode(mode) {
    pushUndoSnapshot();
    // 先保存当前队列数据（必须在修改 queueMode 之前）
    if (queueMode === 'multi' && mode !== 'multi') {
        saveCurrentQueueData();
    }

    queueMode = mode;
    saveQueueData();

    document.querySelectorAll('.queue-mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.queueMode === mode);
    });

    if (mode === 'multi') {
        // 用当前slots初始化队列1
        queueData[0].slots = JSON.parse(JSON.stringify(imageState.slots));
        queueData[0].promptCn = document.getElementById('img-prompt-cn')?.value || '';
        queueData[0].promptEn = document.getElementById('img-prompt-en')?.value || '';
        // 保存当前 API 配置到队列0
        queueData[0].apiPlatform = document.getElementById('cfg-api-platform')?.value || 'runninghub';
        queueData[0].rhModelId = document.getElementById('cfg-rh-model-inline')?.value || '';
        queueData[0].oaihkModelId = document.getElementById('cfg-oaihk-model-inline')?.value || '';
        queueData[0].rhAspectRatio = document.getElementById('cfg-rh-aspect-ratio-inline')?.value || '3:4';
        queueData[0].oaihkAspectRatio = document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '1:1';
        queueData[0].rhResolution = document.getElementById('cfg-rh-resolution-inline')?.value || '1k';
        queueData[0].rhCount = parseInt(document.getElementById('cfg-rh-count-inline')?.value) || 1;
        queueData[0].rhSeedMode = document.getElementById('cfg-rh-seed-mode-inline')?.value || 'random';
        queueData[0].rhSeed = document.getElementById('cfg-rh-seed-inline')?.value || '';
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
                queueData[q].slots = JSON.parse(JSON.stringify(queueData[0].slots));
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
    if (queueMode === 'multi') {
        queueData[activeQueue].slots = JSON.parse(JSON.stringify(imageState.slots));
        queueData[activeQueue].promptCn = '';
        queueData[activeQueue].promptEn = '';
    }
    saveQueueData();
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
    imageState.slots = JSON.parse(JSON.stringify(queueData[activeQueue].slots));
    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考' });
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

    const promptMode = document.querySelector('.main-content:not(#image-mode)');
    const imageMode = document.getElementById('image-mode');

    if (mode === 'image') {
        if (promptMode) promptMode.style.display = 'none';
        if (imageMode) imageMode.style.display = 'flex';
        if (!imageState.loaded) loadImageModeData();
    } else {
        if (promptMode) promptMode.style.display = 'flex';
        if (imageMode) imageMode.style.display = 'none';
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

// ---------- 素材库渲染（子分类结构） ----------
async function renderImageLibrary() {
    const container = document.getElementById('image-library-body');
    if (!container) return;
    container.innerHTML = '';

    const keyword = imageState.libSearchKeyword.trim().toLowerCase();

    if (imageState.library.length === 0) {
        container.innerHTML = '<p class="empty-hint">点击上方按钮添加素材分类</p>';
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
                    if (item.name.toLowerCase().includes(keyword)) {
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
            renderImageLibrary();
        });

        const body = document.createElement('div');
        body.className = `category-body ${isExpanded ? 'expanded' : ''}`;

        // 搜索模式：直接显示搜索结果
        if (keyword) {
            const grid = document.createElement('div');
            grid.className = 'prop-items-grid';
            grid.style.gridTemplateColumns = `repeat(${imageState.libZoom}, 1fr)`;
            for (const { item, sub } of searchItems) {
                grid.appendChild(createLibItemCard(cat, sub, item));
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
                grid.appendChild(createLibItemCard(cat, defaultSub, item));
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
                renderImageLibrary();
            });

            const subBody = document.createElement('div');
            subBody.className = `prop-category-body ${isSubExpanded ? 'expanded' : ''}`;

            const grid = document.createElement('div');
            grid.className = 'prop-items-grid';
            grid.style.gridTemplateColumns = `repeat(${imageState.libZoom}, 1fr)`;

            for (const item of (sub.items || [])) {
                grid.appendChild(createLibItemCard(cat, sub, item));
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

    // 素材库面板级别拖拽兜底：拖到面板空白区域添加到当前展开分类
    container.addEventListener('dragover', (e) => { e.preventDefault(); container.style.outline = '2px dashed var(--accent)'; container.style.outlineOffset = '-4px'; });
    container.addEventListener('dragleave', () => { container.style.outline = ''; container.style.outlineOffset = ''; });
    container.addEventListener('drop', (e) => {
        e.preventDefault(); container.style.outline = ''; container.style.outlineOffset = '';
        // 找到当前展开的分类，或第一个分类
        const targetCat = imageState.library.find(c => c.id === imageState.expandedLibCategory) || imageState.library[0];
        if (!targetCat) return;
        const subs = targetCat.subcategories || [];
        const targetSub = subs.find(s => s.name === '默认' || s._isDefault) || subs[0];
        if (targetSub) handleLibDrop(e, targetCat, targetSub);
    });
}

// 创建素材卡片（子分类版本）
function createLibItemCard(cat, sub, item) {
    const card = document.createElement('div');
    card.className = 'prop-item-card';
    card.title = `点击将"${item.name}"填入当前图片槽`;

    const imgHtml = item.image
        ? `<img src="${escHtml(item.image)}" alt="${escHtml(item.name)}" class="prop-item-img">`
        : `<div class="prop-item-no-img">📷</div>`;

    // 操作按钮：上传/重新上传图片、删除图片、编辑名称、删除素材
    const hasImage = !!item.image;
    const uploadTitle = hasImage ? '重新上传' : '上传图片';
    const deleteImgBtn = hasImage ? `<button class="btn-icon danger delete-lib-img" title="删除图片">🗑</button>` : '';

    card.innerHTML = `
        ${imgHtml}
        <div class="prop-item-name">${escHtml(item.name)}</div>
        <div class="prop-item-actions">
            <button class="btn-icon upload-lib-img" title="${uploadTitle}">🖼</button>
            ${deleteImgBtn}
            <button class="btn-icon edit-lib-item" title="编辑名称">✎</button>
            <button class="btn-icon danger delete-lib-item" title="删除素材">×</button>
        </div>
    `;

    card.addEventListener('click', (e) => {
        if (e.target.closest('.upload-lib-img')) { e.stopPropagation(); uploadLibSubImage(cat, sub, item); return; }
        if (e.target.closest('.delete-lib-img')) { e.stopPropagation(); deleteLibItemImage(cat, sub, item); return; }
        if (e.target.closest('.edit-lib-item')) { e.stopPropagation(); editLibSubItem(cat, sub, item); return; }
        if (e.target.closest('.delete-lib-item')) { e.stopPropagation(); deleteLibSubItem(cat, sub, item); return; }
        fillSlotFromMaterial(item, cat.name);
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
if (libZoomSlider) {
    const savedLibZoom = localStorage.getItem('lib-zoom');
    if (savedLibZoom) { imageState.libZoom = parseInt(savedLibZoom) || 2; libZoomSlider.value = imageState.libZoom; }
    libZoomSlider.addEventListener('input', (e) => {
        imageState.libZoom = parseInt(e.target.value);
        try { localStorage.setItem('lib-zoom', imageState.libZoom); } catch(err) {}
        renderImageLibrary();
    });
}

// ---------- 图生图预设缩放滑杆 ----------
const imgPresetZoomSlider = document.getElementById('img-preset-zoom-slider');
if (imgPresetZoomSlider) {
    const savedZoom = localStorage.getItem('img-preset-zoom');
    if (savedZoom) { imageState.imgPresetZoom = parseInt(savedZoom) || 3; imgPresetZoomSlider.value = imageState.imgPresetZoom; }
    imgPresetZoomSlider.addEventListener('input', (e) => {
        imageState.imgPresetZoom = parseInt(e.target.value);
        try { localStorage.setItem('img-preset-zoom', imageState.imgPresetZoom); } catch(err) {}
        renderImagePresets();
    });
}

// 素材填入槽位（语义自动设为分类名）
function fillSlotFromMaterial(item, categoryName) {
    const idx = imageState.activeSlotIndex;
    if (idx >= 0 && idx < imageState.slots.length) {
        if (item.image) imageState.slots[idx].image = item.image;
        // 语义标签自动设为分类名（如"五官"、"发型"）
        imageState.slots[idx].label = categoryName || item.name;
        renderImageSlots();
        updateLocalPrompt();
        showToast(`已填入 Image ${idx + 1}，语义：${categoryName || item.name}`, 'success');
    }
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
    btn.addEventListener('click', () => switchQueueMode(btn.dataset.queueMode));
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
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考' });
    }
}

// 保存图片槽到localStorage
function saveSlotsToStorage() {
    // 多图队列模式时同步保存到队列数据
    if (queueMode === 'multi' && queueData[activeQueue]) {
        queueData[activeQueue].slots = JSON.parse(JSON.stringify(imageState.slots));
    }
    saveQueueData();
}

function renderImageSlots() {
    const container = document.getElementById('image-slots');
    if (!container) return;
    container.innerHTML = '';

    const zoomValue = parseInt(document.getElementById('slot-zoom-slider')?.value || 70);
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
        slotEl.innerHTML = `
            <div class="slot-compact-image-area">${imgHtml}${slot.image ? '<button class="slot-change-btn" title="更换图片">✎</button>' : ''}${pinBtn}</div>
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
                imageState.slots[i] = { image: '', label: '', prefixTemplate: '请参考' };
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
            slots: Array.from({length: SLOT_COUNT}, () => ({ image: '', label: '', prefixTemplate: '请参考' })),
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
                queueData[q].slots.push({ image: '', label: '', prefixTemplate: '请参考' });
            }
            if (originals[q]) {
                queueData[q].slots[slotIndex] = JSON.parse(JSON.stringify(originals[q]));
            } else {
                queueData[q].slots[slotIndex] = { image: '', label: '', prefixTemplate: '请参考' };
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
        const slotCopy = JSON.parse(JSON.stringify(currentSlot));
        pinnedSlotOriginals[slotIndex] = {};
        for (let q = 0; q < QUEUE_COUNT; q++) {
            if (q === activeQueue) continue;
            if (!queueData[q].slots) queueData[q].slots = [];
            while (queueData[q].slots.length <= slotIndex) {
                queueData[q].slots.push({ image: '', label: '', prefixTemplate: '请参考' });
            }
            // 保存原始数据
            pinnedSlotOriginals[slotIndex][q] = JSON.parse(JSON.stringify(queueData[q].slots[slotIndex]));
            queueData[q].slots[slotIndex] = slotCopy;
        }
        pinnedSlotIndices.add(slotIndex);
        try { localStorage.setItem('pinnedSlotIndices', JSON.stringify(Array.from(pinnedSlotIndices))); } catch(e) {}
        saveQueueData();
        renderImageSlots();
        showToast(`已将图${slotIndex + 1}应用到所有列队`, 'success');
    }
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
    localStorage.setItem(`displayed_${type}_ids`, JSON.stringify(ids.slice(0, 10)));
}

async function loadPromptTemplates() {
    try {
        const data = await api('GET', '/api/prompt-templates');
        if (data && (data.prefixes?.length > 0 || data.suffixes?.length > 0)) {
            promptTemplates.prefixes = data.prefixes || [];
            promptTemplates.suffixes = data.suffixes || [];
            if (selectedPrefixIds.size === 0 && selectedSuffixIds.size === 0) {
                selectedPrefixIds = new Set(data.selectedPrefixIds || []);
                selectedSuffixIds = new Set(data.selectedSuffixIds || []);
            }
            if (queueData[0] && (!queueData[0].selectedPrefixIds || queueData[0].selectedPrefixIds.length === 0)) {
                queueData[0].selectedPrefixIds = [...selectedPrefixIds];
                queueData[0].selectedSuffixIds = [...selectedSuffixIds];
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
        selectedPrefixIds: [...selectedPrefixIds],
        selectedSuffixIds: [...selectedSuffixIds]
    };
    try { localStorage.setItem('promptTemplates', JSON.stringify(data)); } catch {}
    try { await api('PUT', '/api/prompt-templates', data); } catch {}
}

function _getVisibleItems(type) {
    const items = type === 'prefix' ? promptTemplates.prefixes : promptTemplates.suffixes;
    const displayed = getDisplayedTemplateIds(type);
    if (displayed) {
        // 按用户勾选顺序显示
        return displayed.map(id => items.find(t => t.id === id)).filter(Boolean);
    }
    // 默认：前10个
    return items.slice(0, 10);
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
        const texts = [...selectedPrefixIds].map(id => promptTemplates.prefixes.find(p => p.id === id)?.text).filter(Boolean);
        if (texts.length > 0) {
            prefixPreview.textContent = texts.join(' ');
            prefixPreview.style.display = 'block';
        } else {
            prefixPreview.style.display = 'none';
        }
    }
    if (suffixPreview) {
        const texts = [...selectedSuffixIds].map(id => promptTemplates.suffixes.find(p => p.id === id)?.text).filter(Boolean);
        if (texts.length > 0) {
            suffixPreview.textContent = texts.join(' ');
            suffixPreview.style.display = 'block';
        } else {
            suffixPreview.style.display = 'none';
        }
    }
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
    document.getElementById('prompt-template-new-name').value = '';
    document.getElementById('prompt-template-new-text').value = '';
    showToast(editingTemplateId ? '已更新' : '模板已添加', 'success');
});

// ========== 提示词预设系统 ==========
let promptPresets = [];
let activePromptPresetIds = new Set();
let prevPromptCn = '';

async function loadPromptPresets() {
    try {
        const data = await api('GET', '/api/prompt-presets');
        promptPresets = data.presets || [];
    } catch {
        promptPresets = [];
    }
}

async function savePromptPresets() {
    try {
        await api('PUT', '/api/prompt-presets', { presets: promptPresets });
    } catch {}
}

function getPinnedPresetIds() {
    try {
        const saved = localStorage.getItem('pinnedPresetIds');
        if (saved) return JSON.parse(saved);
    } catch {}
    return [];
}
function setPinnedPresetIds(ids) {
    localStorage.setItem('pinnedPresetIds', JSON.stringify(ids.slice(0, 10)));
}

function renderPromptPresetButtons() {
    const group = document.getElementById('prompt-preset-btn-group');
    if (!group) return;
    const pinnedIds = getPinnedPresetIds();
    const pinned = promptPresets.filter(p => pinnedIds.includes(p.id));
    group.innerHTML = pinned.map(p => {
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
    const pinnedIds = getPinnedPresetIds();
    if (promptPresets.length === 0) {
        list.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:8px 0;">暂无预设，请在下方添加</div>';
        return;
    }
    list.innerHTML = promptPresets.map((p, idx) => {
        const isPinned = pinnedIds.includes(p.id);
        return `
        <div style="display:flex;align-items:center;gap:4px;padding:4px 0;border-bottom:1px solid var(--border-light);">
            <label style="display:flex;align-items:center;gap:2px;font-size:10px;cursor:pointer;white-space:nowrap;" title="勾选后显示在按钮区">
                <input type="checkbox" class="preset-pin-cb" data-id="${p.id}" ${isPinned ? 'checked' : ''} style="width:12px;height:12px;"> 📌
            </label>
            <span style="font-size:11px;font-weight:500;min-width:50px;">${escHtml(p.name)}</span>
            <span style="font-size:10px;color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(p.text)}">${escHtml(p.text)}</span>
            <button class="btn btn-outline btn-compact preset-edit-btn" data-idx="${idx}" style="font-size:9px;padding:1px 4px;">编辑</button>
            <button class="btn btn-outline btn-compact preset-del-btn" data-idx="${idx}" style="font-size:9px;padding:1px 4px;color:var(--danger);">删除</button>
        </div>`;
    }).join('');

    list.querySelectorAll('.preset-pin-cb').forEach(cb => {
        cb.addEventListener('change', () => {
            let ids = getPinnedPresetIds();
            if (cb.checked) {
                if (ids.length >= 10) { showToast('最多显示10个', 'error'); cb.checked = false; return; }
                if (!ids.includes(cb.dataset.id)) ids.push(cb.dataset.id);
            } else {
                ids = ids.filter(id => id !== cb.dataset.id);
            }
            setPinnedPresetIds(ids);
            renderPromptPresetButtons();
        });
    });
    list.querySelectorAll('.preset-del-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
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
            const idx = parseInt(btn.dataset.idx);
            const preset = promptPresets[idx];
            if (preset) {
                document.getElementById('prompt-preset-new-name').value = preset.name;
                document.getElementById('prompt-preset-new-text').value = preset.text;
                promptPresets.splice(idx, 1);
                savePromptPresets();
                renderPromptPresetList();
                renderPromptPresetButtons();
            }
        });
    });
}

loadPromptPresets().then(() => {
    renderPromptPresetButtons();
});

document.getElementById('btn-prompt-preset')?.addEventListener('click', (e) => {
    e.stopPropagation(); // 阻止冒泡到折叠header
    renderPromptPresetList();
    openModal('modal-prompt-preset');
});

document.getElementById('btn-prompt-preset-add')?.addEventListener('click', () => {
    const name = document.getElementById('prompt-preset-new-name')?.value.trim();
    const text = document.getElementById('prompt-preset-new-text')?.value.trim();
    if (!name || !text) { showToast('请填写预设名称和内容', 'error'); return; }
    promptPresets.push({ id: 'pp_' + Date.now(), name, text });
    savePromptPresets();
    renderPromptPresetList();
    renderPromptPresetButtons();
    document.getElementById('prompt-preset-new-name').value = '';
    document.getElementById('prompt-preset-new-text').value = '';
    showToast('预设已添加', 'success');
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
document.getElementById('img-preset-search-input')?.addEventListener('input', (e) => {
    imageState.presetSearchKeyword = e.target.value;
    renderImagePresets();
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
        imageState.slots = [{ image: '', label: '', prefixTemplate: '请参考' }, { image: '', label: '', prefixTemplate: '请参考' }];
    }
    // 确保有10个槽位
    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考' });
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
            images: JSON.parse(JSON.stringify(preset.images || [])),
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
})();

// ---------- 3:4 裁剪 + 压缩工具 ----------
let cropState = null; // { img, imgWidth, imgHeight, cropX, cropY, cropW, cropH, callback }

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

function showCropModal(imgSrc, callback) {
    // imgSrc: data URL or object URL of the image
    // callback: function(croppedBlob) called when user confirms crop
    const canvas = document.getElementById('crop-canvas');
    const ctx = canvas.getContext('2d');
    const img = new Image();
    img.onload = () => {
        // 判断原图是否已是3:4比例（容差0.02）
        const origRatio = img.width / img.height;
        const targetRatio = 3 / 4;
        const isAlready34 = Math.abs(origRatio - targetRatio) / targetRatio < 0.02;

        if (isAlready34) {
            // 原图已是3:4，仍显示裁剪框让用户确认（但选区默认覆盖全图）
            // 不再静默跳过，确保用户每次上传都能看到裁剪+命名+分类的完整流程
        }

        // Fit image to display canvas
        const maxW = 480, maxH = 400;
        let drawW = img.width, drawH = img.height;
        if (drawW > maxW) { drawH *= maxW / drawW; drawW = maxW; }
        if (drawH > maxH) { drawW *= maxH / drawH; drawH = maxH; }
        canvas.width = Math.round(drawW);
        canvas.height = Math.round(drawH);

        // 动态计算最大3:4选区（在显示坐标系内）
        let cropW, cropH;
        if (drawW / drawH > 3 / 4) {
            // 图片偏宽：高度撑满，宽度按3:4
            cropH = drawH;
            cropW = cropH * 3 / 4;
        } else {
            // 图片偏窄：宽度撑满，高度按3:4
            cropW = drawW;
            cropH = cropW * 4 / 3;
        }
        const cropX = (drawW - cropW) / 2;
        const cropY = (drawH - cropH) / 2;

        cropState = {
            img, drawW, drawH,
            cropX, cropY, cropW, cropH,
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
    const { img, drawW, drawH, cropX, cropY, cropW, cropH } = cropState;
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
    const sizeText = `${realW} × ${realH}`;
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

        // 角点拖拽缩放（保持3:4比例）
        if (cropState.resizing) {
            const dx = mx - cropState.dragStartX;
            // 根据拖拽方向和角点位置决定缩放
            const corner = cropState.resizeCorner;
            // 左侧角点(0,2): 向左拖=放大, 向右拖=缩小
            // 右侧角点(1,3): 向右拖=放大, 向左拖=缩小
            const isLeft = corner === 0 || corner === 2;
            const widthDelta = isLeft ? -dx : dx;

            let newW = cropState.origCropW + widthDelta;
            let newH = newW * 4 / 3;

            // 最小尺寸限制
            newW = Math.max(30, newW);
            newH = newW * 4 / 3;

            // 不能超出画布
            if (newW > cropState.drawW) { newW = cropState.drawW; newH = newW * 4 / 3; }
            if (newH > cropState.drawH) { newH = cropState.drawH; newW = newH * 3 / 4; }

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

    // Scroll to resize crop box (保持3:4比例)
    canvas.addEventListener('wheel', (e) => {
        if (!cropState) return;
        e.preventDefault();
        const delta = e.deltaY > 0 ? -10 : 10;
        let newW = cropState.cropW + delta;
        let newH = newW * 4 / 3;

        // Clamp
        newW = Math.max(30, Math.min(cropState.drawW, newW));
        newH = newW * 4 / 3;
        if (newH > cropState.drawH) { newH = cropState.drawH; newW = newH * 3 / 4; }

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
        name: 'V1-图生图-低价渠道版', price: '0.05', type: 'image-to-image',
        maxImages: 5, maxImageMB: 10, hasResolution: false,
        aspectRatios: ['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'],
        aspectRatioRequired: true
    },
    'rhart-image-v1-official/edit': {
        name: 'V1-图生图-官方稳定版', price: '0.2', type: 'image-to-image',
        maxImages: 5, maxImageMB: 10, hasResolution: false,
        aspectRatios: ['auto','1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'],
        aspectRatioRequired: true
    },
    'rhart-image-n-g31-flash/image-to-image': {
        name: 'V2-图生图-低价渠道版', price: '0.16', type: 'image-to-image',
        maxImages: 10, maxImageMB: 30, hasResolution: true,
        aspectRatios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9','1:4','4:1','1:8','8:1'],
        aspectRatioRequired: false
    },
    'rhart-image-n-g31-flash-official/image-to-image': {
        name: 'V2-图生图-官方稳定版', price: '0.74', type: 'image-to-image',
        maxImages: 14, maxImageMB: 10, hasResolution: true,
        aspectRatios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9','1:4','4:1','1:8','8:1'],
        aspectRatioRequired: false
    },
    'rhart-image-n-pro/edit': {
        name: 'PRO-图生图-低价渠道版', price: '0.4', type: 'image-to-image',
        maxImages: 10, maxImageMB: 10, hasResolution: true,
        aspectRatios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'],
        aspectRatioRequired: false
    },
    'rhart-image-n-pro-official/edit': {
        name: 'PRO-图生图-官方稳定版', price: '1', type: 'image-to-image',
        maxImages: 10, maxImageMB: 10, hasResolution: true,
        aspectRatios: ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','5:4','4:5','21:9'],
        aspectRatioRequired: false
    }
};

// OpenAI-HK 模型配置
const OAIHK_MODELS = {
    'fal-ai/banana/v2': {
        name: 'proK', price: '0.48',
        endpoint: 'fal-ai/banana/v2',
        modelId: 'fal-ai/banana/v2',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 1024
    },
    'fal-ai/banana/v2/2k': {
        name: 'pro2K', price: '0.48',
        endpoint: 'fal-ai/banana/v2/2k',
        modelId: 'fal-ai/banana/v2/2k',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 1536
    },
    'fal-ai/banana/v2/4k': {
        name: 'pro4K', price: '0.48',
        endpoint: 'fal-ai/banana/v2/4k',
        modelId: 'fal-ai/banana/v2/4k',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 2048
    },
    'fal-ai/banana/v3.1/flash': {
        name: 'nano2-3.1 1K', price: '0.2',
        endpoint: 'fal-ai/banana/v3.1/flash',
        modelId: 'fal-ai/banana/v3.1/flash',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 1024
    },
    'fal-ai/banana/v3.1/flash/2k': {
        name: 'nano2-3.1 2K', price: '0.3',
        endpoint: 'fal-ai/banana/v3.1/flash/2k',
        modelId: 'fal-ai/banana/v3.1/flash/2k',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 1536
    },
    'fal-ai/banana/v3.1/flash/4k': {
        name: 'nano2-3.1 4K', price: '0.48',
        endpoint: 'fal-ai/banana/v3.1/flash/4k',
        modelId: 'fal-ai/banana/v3.1/flash/4k',
        pollEndpoint: 'fal-ai/nano-banana/requests',
        shortEdge: 2048
    }
};

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
}

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
    });
}

// 备份路径持久化：输入框修改时保存到model_config
const backupPathInput = document.getElementById('cfg-rh-download-path');
if (backupPathInput) {
    backupPathInput.addEventListener('change', async () => {
        try {
            await api('PUT', '/api/model-config', { rh_download_path: backupPathInput.value });
        } catch(e) { console.error('保存备份路径失败:', e); }
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
            autoBackupResults(data.results || []);

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

    results.forEach((result, index) => {
        if (!result.url) return;
        const item = { url: result.url, checked: false, filename: `AI生图_${index+1}.${result.outputType || 'png'}`, outputType: result.outputType || 'png' };
        appendResultCard(item, index);
    });
}

// ---------- 备份+下载功能 ----------
const DEFAULT_DOWNLOAD_PATH = '~/Downloads/AI生图/';

// 备份单张图片到本地（转JPG），返回本地URL
async function backupImageToLocal(url, filename) {
    try {
        const resp = await api('POST', '/api/backup-result-image', { url, filename });
        if (resp.ok && resp.local_url) {
            return resp.local_url;
        }
        console.warn('备份失败:', resp.error);
        return null;
    } catch (e) {
        console.warn('备份异常:', e);
        return null;
    }
}

async function downloadImage(url, filename) {
    try {
        // 先备份到本地，再触发浏览器下载
        const localUrl = await backupImageToLocal(url, filename);
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
    const isAutoBackup = document.getElementById('cfg-rh-auto-backup')?.checked;
    if (!isAutoBackup) return;

    let backupCount = 0;
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r.url) continue;
        if (r.url.startsWith('/static/')) continue;

        const filename = r.filename || `AI生图_${new Date().toISOString().replace(/[:.]/g, '-')}_${i}.jpg`;
        const localUrl = await backupImageToLocal(r.url, filename);
        if (localUrl) {
            r.url = localUrl;
            r.localUrl = localUrl;
            backupCount++;
        }
    }
    if (backupCount > 0) {
        // 备份完成后持久化到队列数据和服务端
        if (qi !== undefined && qi !== null && queueData[qi]) {
            queueData[qi].results = results;
            saveQueueData();
        }
        showToast(`${backupCount}张图片已自动备份到本地`, 'success');
    }
}

document.getElementById('btn-download-all')?.addEventListener('click', async () => {
    const grid = document.getElementById('api-result-grid');
    if (!grid) return;
    const cards = grid.querySelectorAll('.api-result-card img');
    if (cards.length === 0) { showToast('没有可下载的图片', 'error'); return; }

    let count = 0;
    for (const img of cards) {
        const url = img.src;
        const filename = `AI生图_${new Date().toISOString().replace(/[:.]/g, '-')}_${count}.jpg`;
        await downloadImage(url, filename);
        count++;
        if (count < cards.length) await new Promise(r => setTimeout(r, 1000));
    }
    showToast(`${count}张图片已下载`, 'success');
});

// 预览图大小滑块
document.getElementById('preview-size-slider')?.addEventListener('input', (e) => {
    const size = parseInt(e.target.value) || 140;
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

    let count = 0;
    for (const card of checkedCards) {
        const img = card.querySelector('img');
        if (!img) continue;
        const url = img.src;
        const filename = `AI生图_${new Date().toISOString().replace(/[:.]/g, '-')}_${count}.jpg`;
        await downloadImage(url, filename);
        count++;
        if (count < checkedCards.length) await new Promise(r => setTimeout(r, 1000));
    }
    showToast(`${count}张勾选图片已下载`, 'success');
});

document.getElementById('btn-download-to-folder')?.addEventListener('click', async () => {
    // 浏览器无法选择文件夹，提示用户设置下载路径
    const path = await showPrompt('指定下载文件夹路径', document.getElementById('cfg-rh-download-path')?.value || DEFAULT_DOWNLOAD_PATH, '路径');
    if (path && path.trim()) {
        document.getElementById('cfg-rh-download-path').value = path.trim();
        showToast('下载路径已更新，后续图片将下载到浏览器默认目录\n如需更改浏览器下载目录，请在浏览器设置中修改', 'info');
        // 触发全部下载
        document.getElementById('btn-download-all')?.click();
    }
});

document.getElementById('btn-open-download-folder')?.addEventListener('click', async () => {
    const downloadPath = document.getElementById('cfg-rh-download-path')?.value || DEFAULT_DOWNLOAD_PATH;
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
            const idx = parseInt(el.dataset.index);
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
                closeModal('modal-image-viewer');
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
        if (resultGrid) {
            resultGrid.innerHTML = `<div id="api-generating-placeholder-queue${qi}" style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-muted);font-size:12px;"><span class="loading" style="display:inline-block;"></span> 队列${qi+1}正在生成...</div>`;
        }
    }

    // 执行每个任务
    for (let round = 0; round < tasks.length; round++) {
        if (qs.cancelled) break;
        const task = tasks[round];
        if (activeQueue === qi) {
            btn.innerHTML = `<span class="loading"></span> 队列${qi+1} ${round+1}/${tasks.length}`;
        }

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
                if (qs.cancelled) break;

                const payload = { prompt: task.prompt, image_urls: publicUrls, num_images: 1, aspect_ratio: aspectRatio };
                if (model.modelId) payload.model = model.modelId;

                const submitData = await api('POST', '/api/oaihk-proxy', {
                    action: 'submit', api_key: '', base_url: '', endpoint: model.endpoint, model_id: modelId, params: payload
                }, 120000, queueSignal);

                if (!submitData.request_id) {
                    showToast(`${task.queueLabel}提交失败: ${submitData.error || '未返回request_id'}`, 'error');
                    continue;
                }

                if (activeQueue === qi) setApiProgress(25);
                const result = await pollOAIHK('', '', model.pollEndpoint, submitData.request_id, qi, queueSignal);
                if (activeQueue === qi && result) setApiProgress(100);
                if (qs.cancelled) break;

                if (result && result.images) {
                    for (const img of result.images) {
                        if (img.url) {
                            let displayUrl = img.url;
                            try {
                                const dlResp = await api('POST', '/api/download-image', { url: img.url }, undefined, queueSignal);
                                if (dlResp.data?.data_uri) displayUrl = dlResp.data.data_uri;
                            } catch (dlErr) {}
                            allResults.push({ url: displayUrl, checked: false, filename: `AI生图_HK_${task.queueLabel}_${allResults.length+1}.jpg`, outputType: 'png' });
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
                }, undefined, queueSignal);

                if (data.status === 'FAILED') {
                    showToast(`${task.queueLabel}提交失败: ${data.errorMessage || '未知错误'}`, 'error');
                    continue;
                }

                if (activeQueue === qi) setApiProgress(10);
                const result = await pollUntilDone(rhApiKey, rhBaseUrl, data.taskId, Date.now(), qi, queueSignal);
                if (activeQueue === qi && result) setApiProgress(100);
                if (qs.cancelled) break;

                if (result && result.results) {
                    for (const r of result.results) {
                        if (r.url) {
                            allResults.push({ url: r.url, checked: false, filename: `AI生图_${task.queueLabel}_${allResults.length+1}.${r.outputType || 'png'}`, outputType: r.outputType || 'png' });
                        }
                    }
                }
            }
        } catch (e) {
            if (!qs.cancelled) showToast(`${task.queueLabel}生成失败: ${e.message}`, 'error');
        }
    }

    // 重置状态
    qs.running = false;
    qs.cancelled = false;
    qs.abortController = null;
    apiGenerateState.running = isAnyQueueGenerating();

    // 存储结果到队列
    if (allResults.length > 0) {
        queueData[qi].results = allResults;
        saveQueueData();
        // 如果当前显示的是这个队列，渲染结果
        if (activeQueue === qi) {
            renderQueueResults(qi);
        }
        logAction('api', '单队列生图完成', { queue: qi + 1, count: allResults.length });
        showToast(`队列${qi+1}生成完成！共${allResults.length}张`, 'success');
        if (document.getElementById('cfg-rh-auto-backup')?.checked) {
            autoBackupResults(allResults, qi);
        }
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
    // 移除该队列的占位符
    const qPlaceholder = document.getElementById(`api-generating-placeholder-queue${qi}`);
    if (qPlaceholder) qPlaceholder.remove();
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
    const count = parseInt(document.getElementById('cfg-rh-count-inline')?.value) || 1;

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

    // 清空结果区并显示生成中占位
    const allResults = [];
    const resultGrid = document.getElementById('api-result-grid');
    if (resultGrid) {
        resultGrid.innerHTML = '<div id="api-generating-placeholder" style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-muted);font-size:12px;"><span class="loading" style="display:inline-block;"></span> 正在提交生成任务...</div>';
    }
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
                continue;
            }

            // 提交成功，开始轮询
            setApiProgress(10);
            const ph = document.getElementById('api-generating-placeholder');
            if (ph) ph.innerHTML = '<span class="loading" style="display:inline-block;"></span> 正在绘制中... (已提交，等待处理)';

            // 轮询等待结果
            const result = await pollUntilDone(rhApiKey, rhBaseUrl, data.taskId, rhStartTime);
            if (apiGenerateState.cancelled) break;
            if (result && result.results) {
                setApiProgress(100);
                for (const r of result.results) {
                    if (r.url) {
                        const item = { url: r.url, checked: false, filename: `AI生图_${allResults.length+1}.${r.outputType || 'png'}`, outputType: r.outputType || 'png' };
                        allResults.push(item);
                        appendResultCard(item, allResults.length - 1);
                    }
                }
            }
        } catch (e) {
            if (apiGenerateState.cancelled) break;
            showToast(`${task.queueLabel}生成失败: ${e.message}`, 'error');
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

    if (allResults.length > 0) {
        logAction('api', 'RH生图完成', { count: allResults.length });
        showToast(`生成完成！共${allResults.length}张`, 'success');
        // 多图列队模式下，将结果存到当前队列
        if (queueMode === 'multi') {
            queueData[activeQueue].results = allResults;
            saveQueueData();
        }
        // 自动备份
        if (document.getElementById('cfg-rh-auto-backup')?.checked) {
            autoBackupResults(allResults, qi);
        }
    }
});

// 轮询直到完成
async function pollUntilDone(apiKey, baseUrl, taskId, startTime = Date.now(), qi, signal) {
    const maxPolls = 120; // 最多轮询120次（6分钟）
    const isCancelled = () => qi !== undefined ? queueGenerateStates[qi]?.cancelled : apiGenerateState.cancelled;
    for (let i = 0; i < maxPolls; i++) {
        if (isCancelled()) return null;
        await new Promise(r => setTimeout(r, 3000));
        if (isCancelled()) return null;
        // 更新进度和状态文本
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
}

// 取消按钮
document.getElementById('btn-api-cancel')?.addEventListener('click', () => {
    logAction('api', '取消生成', {});

    if (queueMode === 'multi') {
        // 多图列队模式：取消所有正在生成的队列
        for (let qi = 0; qi < QUEUE_COUNT; qi++) {
            const qs = queueGenerateStates[qi];
            if (qs.running) {
                qs.cancelled = true;
                if (qs.abortController) {
                    qs.abortController.abort();
                }
            }
        }
        apiGenerateState.running = isAnyQueueGenerating();
        // 更新当前队列的 UI
        const btn = document.getElementById('btn-api-generate');
        if (btn) { btn.disabled = false; updateGenerateBtnText(); }
        // 如果没有其他队列在生成，隐藏取消按钮
        const cancelBtn = document.getElementById('btn-api-cancel');
        if (cancelBtn && !isAnyQueueGenerating()) {
            cancelBtn.style.display = 'none';
        }
        // 移除所有队列的生成中占位
        for (let qi2 = 0; qi2 < QUEUE_COUNT; qi2++) {
            const placeholder = document.getElementById(`api-generating-placeholder-queue${qi2}`);
            if (placeholder) placeholder.remove();
        }
        hideApiProgress();
        renderQueueNumberBars();
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

    // 通过后端处理：按比例裁剪 → 按模型短边缩放 → base64
    const resp = await api('POST', '/api/preprocess-to-base64', {
        local_url: localUrl,
        aspect_ratio: aspectRatio,
        short_edge: shortEdge
    });

    if (!resp.data?.data_uri) {
        const errMsg = resp.error || '图片预处理失败';
        logAction('error', '图片预处理失败', { url: localUrl, error: errMsg });
        throw new Error(errMsg);
    }

    logAction('api', '图片预处理完成', { sizeKb: resp.data.size_kb });
    return resp.data.data_uri;
}

// OpenAI-HK 轮询直到完成
async function pollOAIHK(apiKey, baseUrl, pollEndpoint, requestId, qi, signal) {
    const maxPolls = 120; // 最多轮询120次（6分钟）
    const isCancelled = () => qi !== undefined ? queueGenerateStates[qi]?.cancelled : apiGenerateState.cancelled;
    let queueCount = 0;
    for (let i = 0; i < maxPolls; i++) {
        if (isCancelled()) return null;
        await new Promise(r => setTimeout(r, 3000));
        if (isCancelled()) return null;
        const ph = document.getElementById(`api-generating-placeholder-queue${qi}`) || document.getElementById('api-generating-placeholder');
        const elapsed = Math.round((i + 1) * 3);
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
                if (ph) ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 排队等待中...（已等${elapsed}秒，第${i+1}次查询）${queueCount > 10 ? '<br><span style="font-size:10px;color:#e67e22;">排队较久，API服务器可能繁忙，请耐心等待或取消重试</span>' : ''}`;
            } else {
                if (ph) ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在绘制中...（${elapsed}秒，第${i+1}次查询）`;
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

    const count = parseInt(document.getElementById('cfg-rh-count-inline')?.value) || 1;

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
    if (resultGrid) {
        resultGrid.innerHTML = '<div id="api-generating-placeholder" style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-muted);font-size:12px;"><span class="loading" style="display:inline-block;"></span> 正在压缩图片...</div>';
    }

    for (let round = 0; round < tasks.length; round++) {
        if (apiGenerateState.cancelled) {
            showToast(`已取消，已完成${round}张`, 'info');
            break;
        }
        const task = tasks[round];
        btn.innerHTML = `<span class="loading"></span> ${round+1}/${tasks.length}`;

        try {
            // 步骤 A：将本地图片预处理为 base64
            setApiProgress(5);
            const aspectRatio = document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4';
            const shortEdge = model.shortEdge || 1536;
            const publicUrls = [];
            for (let j = 0; j < task.imageUrls.length; j++) {
                if (apiGenerateState.cancelled) break;
                setApiProgress(5 + (15 * (j + 1) / task.imageUrls.length)); // 5% → 20%
                const ph = document.getElementById('api-generating-placeholder');
                if (ph) ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在压缩图片... (${j+1}/${task.imageUrls.length})`;
                const publicUrl = await uploadToTmpfiles(task.imageUrls[j], aspectRatio, shortEdge);
                publicUrls.push(publicUrl);
            }
            if (apiGenerateState.cancelled) break;

            // 步骤 B：发起异步生图任务
            setApiProgress(25);
            const placeholder = document.getElementById('api-generating-placeholder');
            if (placeholder) placeholder.innerHTML = '<span class="loading" style="display:inline-block;"></span> 正在加密传输（Base64）...';

            const payload = {
                prompt: task.prompt,
                image_urls: publicUrls,
                num_images: 1,
                aspect_ratio: aspectRatio
            };
            // 在payload中指定具体模型版本（如 fal-ai/banana/v3.1/flash）
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
            }, 120000); // Base64数据量大，超时设为120秒

            // 提交后立即释放 base64 字符串内存
            publicUrls.length = 0;

            const requestId = submitData.request_id;
            if (!requestId) {
                const errMsg = submitData.error || '未返回request_id';
                // 针对不同错误类型给出友好提示
                let friendlyMsg = errMsg;
                if (errMsg.includes('已禁用') || errMsg.includes('428')) {
                    friendlyMsg = '模型已被禁用(428)，请稍后重试或联系OpenAI-HK客服';
                } else if (errMsg.includes('无可用渠道') || errMsg.includes('503')) {
                    friendlyMsg = 'API渠道暂不可用(503)，请稍后重试或检查API Key/余额';
                }
                showToast(`${task.queueLabel}提交失败: ${friendlyMsg}`, 'error');
                // 清除生成中占位符
                const failPlaceholder = document.getElementById('api-generating-placeholder');
                if (failPlaceholder) failPlaceholder.remove();
                continue;
            }

            // 步骤 C：轮询获取结果
            setApiProgress(35);
            const pollPlaceholder = document.getElementById('api-generating-placeholder');
            if (pollPlaceholder) pollPlaceholder.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在等待云端响应（任务ID: ${requestId.slice(0,8)}...）<br><span style="font-size:10px;">每3秒刷新一次状态</span>`;

            const result = await pollOAIHK(oaihkApiKey, oaihkBaseUrl, model.pollEndpoint, requestId);
            if (apiGenerateState.cancelled) break;

            // 步骤 D：渲染结果（通过代理下载，避免v3.fal.media被墙）
            setApiProgress(100);
            if (result && result.images) {
                for (const img of result.images) {
                    if (img.url) {
                        let displayUrl = img.url;
                        // 通过后端代理下载结果图片，避免国内无法访问v3.fal.media
                        try {
                            const dlResp = await api('POST', '/api/download-image', { url: img.url });
                            if (dlResp.data?.data_uri) {
                                displayUrl = dlResp.data.data_uri;
                            }
                        } catch (dlErr) {
                            console.warn('代理下载失败，使用原始URL:', dlErr);
                        }
                        const item = { url: displayUrl, checked: false, filename: `AI生图_HK_${allResults.length+1}.jpg`, outputType: 'png' };
                        allResults.push(item);
                        appendResultCard(item, allResults.length - 1);
                    }
                }
            }
        } catch (e) {
            if (apiGenerateState.cancelled) break;
            logAction('error', 'HK生图失败', { error: e.message });
            // 针对不同错误类型给出友好提示
            let friendlyMsg = e.message;
            if (e.message.includes('已禁用') || e.message.includes('428')) {
                friendlyMsg = '模型已被禁用(428)，请稍后重试或联系OpenAI-HK客服';
            } else if (e.message.includes('无可用渠道') || e.message.includes('503')) {
                friendlyMsg = 'API渠道暂不可用(503)，请稍后重试或检查API Key/余额';
            }
            showToast(`${task.queueLabel}生成失败: ${friendlyMsg}`, 'error');
            // 清除生成中占位符
            const errPlaceholder = document.getElementById('api-generating-placeholder');
            if (errPlaceholder) errPlaceholder.remove();
        }
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
    // 清除可能残留的占位符
    const leftoverPlaceholder = document.getElementById('api-generating-placeholder');
    if (leftoverPlaceholder) leftoverPlaceholder.remove();

    if (allResults.length > 0) {
        logAction('api', 'HK生图完成', { count: allResults.length });
        showToast(`生成完成！共${allResults.length}张`, 'success');
        // 多图列队模式下，将结果存到当前队列
        if (queueMode === 'multi') {
            queueData[activeQueue].results = allResults;
            saveQueueData();
        }
        if (document.getElementById('cfg-rh-auto-backup')?.checked) {
            autoBackupResults(allResults, qi);
        }
    }
}

// ========== 批量并行生成（多图列队模式） ==========
async function batchGenerateAll() {
    pushUndoSnapshot();
    if (apiGenerateState.running) {
        showToast('正在生成中，请等待', 'error');
        return;
    }

    logAction('api', '批量生图开始', { queueMode });

    // 收集所有有效队列的任务（每个队列用自己的平台/模型/配置）
    saveCurrentQueueData();
    const baseTasks = [];

    // 收集有效队列
    for (let q = 0; q < QUEUE_COUNT; q++) {
        const qd = queueData[q];
        if (!qd) continue;
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
            if (!model) continue; // 跳过无效模型
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
        // 每个队列生成 count 张
        for (let i = 0; i < count; i++) {
            baseTasks.push({ prompt, imageUrls, queueLabel: count > 1 ? `队列${q+1} 第${i+1}张` : `队列${q+1}`, queueIndex: q, platform, rhModelId: qd.rhModelId, oaihkModelId: qd.oaihkModelId, rhAspectRatio: qd.rhAspectRatio, oaihkAspectRatio: qd.oaihkAspectRatio, rhResolution: qd.rhResolution });
        }
    }

    if (baseTasks.length === 0) {
        showToast('没有有效的队列数据（需要Prompt和图片）', 'error');
        return;
    }

    const tasks = baseTasks;

    // 设置UI状态
    apiGenerateState.running = true;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = new AbortController();
    const btn = document.getElementById('btn-api-generate');
    const batchBtn = document.getElementById('btn-api-batch-generate');
    const cancelBtn = document.getElementById('btn-api-cancel');
    btn.disabled = true;
    batchBtn.disabled = true;
    batchBtn.innerHTML = '<span class="loading"></span> 0/' + tasks.length;
    cancelBtn.style.display = 'inline-flex';
    hideApiRegenerateBtn();

    const allResults = [];
    let completedCount = 0;
    const totalTasks = tasks.length;

    // 清空结果区
    const resultGrid = document.getElementById('api-result-grid');
    if (resultGrid) {
        resultGrid.innerHTML = '<div id="api-generating-placeholder" style="grid-column:1/-1;text-align:center;padding:40px 0;color:var(--text-muted);font-size:12px;"><span class="loading" style="display:inline-block;"></span> 批量生成中... 0/' + totalTasks + ' 组完成</div>';
    }
    setApiProgress(5);

    // 单任务执行函数
    async function executeOneTask(task) {
        const localResults = [];
        try {
            const taskPlatform = task.platform || platform;
            if (taskPlatform === 'oaihk') {
                const modelId = task.oaihkModelId || document.getElementById('cfg-oaihk-model-inline')?.value;
                const model = OAIHK_MODELS[modelId];
                const aspectRatio = task.oaihkAspectRatio || document.getElementById('cfg-oaihk-aspect-ratio-inline')?.value || '3:4';
                const shortEdge = model.shortEdge || 1536;

                // 预处理图片
                const publicUrls = [];
                for (let j = 0; j < task.imageUrls.length; j++) {
                    if (apiGenerateState.cancelled) return localResults;
                    const publicUrl = await uploadToTmpfiles(task.imageUrls[j], aspectRatio, shortEdge);
                    publicUrls.push(publicUrl);
                }
                if (apiGenerateState.cancelled) return localResults;

                // 提交
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
                }, 120000);

                const requestId = submitData.request_id;
                if (!requestId) {
                    const errMsg = submitData.error || '未返回request_id';
                    showToast(`${task.queueLabel}提交失败: ${errMsg}`, 'error');
                    return localResults;
                }

                // 轮询
                const result = await pollOAIHK('', '', model.pollEndpoint, requestId);
                if (apiGenerateState.cancelled) return localResults;

                // 下载结果
                if (result && result.images) {
                    for (const img of result.images) {
                        if (img.url) {
                            let displayUrl = img.url;
                            try {
                                const dlResp = await api('POST', '/api/download-image', { url: img.url });
                                if (dlResp.data?.data_uri) displayUrl = dlResp.data.data_uri;
                            } catch (dlErr) { console.warn('代理下载失败:', dlErr); }
                            localResults.push({ url: displayUrl, checked: false, filename: `AI生图_HK_${task.queueLabel}_${localResults.length+1}.jpg`, outputType: 'png', queueIndex: task.queueIndex });
                        }
                    }
                }
            } else {
                // RH通道
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

                const result = await pollUntilDone('', '', data.taskId, Date.now());
                if (apiGenerateState.cancelled) return localResults;

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

    // 分批并行提交：每批2组，避免大量图片同时上传导致内存/网络/API过载
    const BATCH_CONCURRENCY = 2;
    for (let batchStart = 0; batchStart < tasks.length; batchStart += BATCH_CONCURRENCY) {
        if (apiGenerateState.cancelled) break;
        const batchEnd = Math.min(batchStart + BATCH_CONCURRENCY, tasks.length);
        const batchTasks = tasks.slice(batchStart, batchEnd);
        const batchLabel = `提交第${batchStart+1}-${batchEnd}组（共${totalTasks}组）`;
        const ph = document.getElementById('api-generating-placeholder');
        if (ph) ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> ${batchLabel}... ${completedCount}/${totalTasks} 组已完成`;

        const batchPromises = batchTasks.map(task =>
            executeOneTask(task).then(results => {
                completedCount++;
                for (const item of results) {
                    allResults.push(item);
                    appendResultCard(item, allResults.length - 1);
                }
                batchBtn.innerHTML = `<span class="loading"></span> ${completedCount}/${totalTasks}`;
                const ph2 = document.getElementById('api-generating-placeholder');
                if (ph2) ph2.innerHTML = `<span class="loading" style="display:inline-block;"></span> 批量生成中... ${completedCount}/${totalTasks} 组完成`;
                setApiProgress(Math.round((completedCount / totalTasks) * 100));
                return results;
            })
        );

        await Promise.allSettled(batchPromises);
    }

    // 重置UI
    apiGenerateState.running = false;
    apiGenerateState.cancelled = false;
    apiGenerateState.abortController = null;
    btn.disabled = false;
    batchBtn.disabled = false;
    batchBtn.textContent = '批量生成';
    cancelBtn.style.display = 'none';
    showApiRegenerateBtn();
    hideApiProgress();
    const leftoverPlaceholder = document.getElementById('api-generating-placeholder');
    if (leftoverPlaceholder) leftoverPlaceholder.remove();

    if (allResults.length > 0) {
        logAction('api', platform === 'oaihk' ? 'HK批量生图完成' : 'RH批量生图完成', { count: allResults.length, tasks: totalTasks });
        showToast(`批量生成完成！共${allResults.length}张（${completedCount}组）`, 'success');
        // 按队列存储结果
        for (let q = 0; q < QUEUE_COUNT; q++) {
            const qResults = allResults.filter(r => r.queueIndex === q);
            if (qResults.length > 0) {
                queueData[q].results = qResults;
            }
        }
        saveQueueData();
        if (document.getElementById('cfg-rh-auto-backup')?.checked) {
            autoBackupResults(allResults, qi);
        }
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

// 追加单张结果卡片
function appendResultCard(item, index) {
    const grid = document.getElementById('api-result-grid');
    if (!grid) return;
    // 移除占位提示
    const placeholder = grid.querySelector('#api-result-placeholder') || grid.querySelector('[style*="grid-column"]');
    if (placeholder) placeholder.remove();

    const card = document.createElement('div');
    card.className = 'api-result-card';
    card.dataset.index = index;
    const imgEl = document.createElement('img');
    imgEl.alt = '生成结果';
    imgEl.style.cssText = 'width:100%;aspect-ratio:3/4;object-fit:cover;display:block;cursor:pointer;';
    imgEl.src = item.url;
    // 图片加载失败时显示占位
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
    // 点击图片 → 大图预览
    imgEl.addEventListener('click', () => {
        // 收集所有结果
        const allCards = grid.querySelectorAll('.api-result-card');
        const images = [];
        allCards.forEach(c => {
            const img = c.querySelector('img');
            const cb = c.querySelector('.result-checkbox');
            images.push({ url: img?.src || '', checked: cb?.checked || false, filename: `AI生图_${images.length+1}.jpg` });
        });
        openImageViewer(images, index);
    });
    card.querySelector('.download-single').addEventListener('click', (e) => {
        e.stopPropagation();
        downloadImage(item.url, item.filename);
    });
    card.querySelector('.delete-single').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteResultItem(card, item);
    });
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
        saveQueueData();
    }
    grid.innerHTML = `<div id="api-result-placeholder" style="grid-column:1/-1;text-align:center;padding:30px 0;color:var(--text-muted);font-size:11px;">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.2" style="opacity:0.4;margin-bottom:8px;"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            <div>选择模型后点击「API生成」开始</div>
        </div>`;
    showToast('已清除所有结果', 'success');
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
    'save-preset': { label: '保存预设', trigger: () => document.getElementById('btn-save-image-preset')?.click() },
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
    if (e.ctrlKey) parts.push('Control');
    if (e.metaKey) parts.push('Meta');
    if (e.shiftKey) parts.push('Shift');
    if (e.altKey) parts.push('Alt');
    const key = e.key;
    if (!['Control', 'Meta', 'Shift', 'Alt'].includes(key)) {
        parts.push(key.length === 1 ? key.toUpperCase() : key);
    }
    if (parts.length === 0 || (parts.length === 1 && ['Control', 'Meta', 'Shift', 'Alt'].includes(parts[0]))) {
        return null;
    }
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

    const zoomValue = parseInt(document.getElementById('slot-zoom-slider')?.value || 70);
    const imgSize = zoomValue;

    while (imageState.slots.length < SLOT_COUNT) {
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考' });
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
        slotEl.innerHTML = `
            <div class="slot-compact-image-area">${imgHtml}${slot.image ? '<button class="slot-change-btn" title="更换图片">✎</button>' : ''}${pinBtn}</div>
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
                imageState.slots[i] = { image: '', label: '', prefixTemplate: '请参考' };
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
        imageState.slots.push({ image: '', label: '', prefixTemplate: '请参考' });
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
        newSlots.push({ image: '', label: '', prefixTemplate: '请参考' });
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
        q.slots = JSON.parse(JSON.stringify(imageState.slots));
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
pollOAIHK = async function pollOAIHKBackoff(apiKey, baseUrl, pollEndpoint, requestId, qi, signal) {
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
                if (ph) ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 排队等待中...（已等${elapsed}秒，第${i+1}次查询）${queueCount > 10 ? '<br><span style="font-size:10px;color:#e67e22;">排队较久，API服务器可能繁忙，请耐心等待或取消重试</span>' : ''}`;
            } else {
                if (ph) ph.innerHTML = `<span class="loading" style="display:inline-block;"></span> 正在绘制中...（${elapsed}秒，第${i+1}次查询）`;
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

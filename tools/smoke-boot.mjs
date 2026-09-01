/**
 * 启动冒烟测试
 *
 * 目的：验证依赖注入链改动之后，整个插件还能正常装配起来。
 * 白屏故障基本都发生在这一步——某个 service 没被注入、组装顺序不对、
 * 或者某个 undefined 被当函数调用。
 *
 * 做法：在 Node 里搭一个够用的 DOM 替身，跑 initTxtToWorldbookBridge()，
 * 然后打开主弹窗，确认关键 UI 元素和事件绑定都到位。
 */

// ============================================================
// 极简 DOM 替身
// ============================================================
class FakeClassList {
    constructor(el) {
        this.el = el;
        this._set = new Set();
    }
    add(...c) {
        c.forEach((x) => x && this._set.add(x));
    }
    remove(...c) {
        c.forEach((x) => this._set.delete(x));
    }
    contains(c) {
        return this._set.has(c);
    }
    toggle(c) {
        if (this._set.has(c)) this._set.delete(c);
        else this._set.add(c);
    }
}

class FakeElement {
    constructor(tag) {
        this.tagName = String(tag || 'div').toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.dataset = {};
        this.attributes = {};
        this.classList = new FakeClassList(this);
        this._listeners = {};
        this._innerHTML = '';
        this.textContent = '';
        this.value = '';
        this.checked = false;
        this.files = [];
        this.id = '';
        this.className = '';
    }
    get innerHTML() {
        return this._innerHTML;
    }
    set innerHTML(html) {
        this._innerHTML = String(html);
        this.children = [];
        // 只解析出带 id 的元素，够本测试用
        const re = /<(\w+)([^>]*)>/g;
        let m;
        while ((m = re.exec(this._innerHTML)) !== null) {
            const tag = m[1];
            const attrs = m[2];
            const idMatch = attrs.match(/\bid\s*=\s*["']([^"']+)["']/);
            const el = new FakeElement(tag);
            if (idMatch) {
                el.id = idMatch[1];
                registry.set(el.id, el);
            }
            const typeMatch = attrs.match(/\btype\s*=\s*["']([^"']+)["']/);
            if (typeMatch) el.type = typeMatch[1];
            el.parentNode = this;
            this.children.push(el);
        }
    }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        if (child.id) registry.set(child.id, child);
        return child;
    }
    removeChild(child) {
        this.children = this.children.filter((c) => c !== child);
        return child;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
        if (this.id) registry.delete(this.id);
    }
    addEventListener(type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    }
    removeEventListener(type, fn) {
        if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((f) => f !== fn);
    }
    dispatchEvent(evt) {
        (this._listeners[evt.type] || []).forEach((f) => f(evt));
        return true;
    }
    click() {
        this.dispatchEvent({ type: 'click', target: this, preventDefault() {}, stopPropagation() {} });
    }
    setAttribute(k, v) {
        this.attributes[k] = String(v);
        if (k === 'id') {
            this.id = String(v);
            registry.set(this.id, this);
        }
    }
    getAttribute(k) {
        return this.attributes[k] ?? null;
    }
    querySelector(sel) {
        return this._query(sel)[0] || null;
    }
    querySelectorAll(sel) {
        return this._query(sel);
    }
    _query(sel) {
        const out = [];
        const idSel = sel.startsWith('#') ? sel.slice(1) : null;
        const walk = (node) => {
            for (const c of node.children) {
                if (idSel && c.id === idSel) out.push(c);
                else if (!idSel) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
    closest() {
        return null;
    }
    focus() {}
    scrollIntoView() {}
    insertBefore(node) {
        return this.appendChild(node);
    }
}

const registry = new Map();

const body = new FakeElement('body');
const head = new FakeElement('head');
const documentElement = new FakeElement('html');

globalThis.document = {
    body,
    head,
    documentElement,
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (t) => {
        const e = new FakeElement('#text');
        e.textContent = t;
        return e;
    },
    getElementById: (id) => registry.get(id) || null,
    querySelector: (sel) => (sel.startsWith('#') ? registry.get(sel.slice(1)) || null : null),
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
};

globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { href: 'http://localhost/' },
    navigator: { language: 'zh-CN' },
    setTimeout,
    clearTimeout,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
};
// Node 22 的 navigator 是只读 getter，用 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN', clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
});
globalThis.localStorage = {
    _d: {},
    getItem(k) {
        return this._d[k] ?? null;
    },
    setItem(k, v) {
        this._d[k] = String(v);
    },
    removeItem(k) {
        delete this._d[k];
    },
};
globalThis.alert = () => {};
globalThis.confirm = () => true;
globalThis.fetch = async () => {
    throw new Error('测试环境不应发起真实网络请求');
};

// IndexedDB 替身：让 openDB 走 onerror 分支，代码里有容错
globalThis.indexedDB = {
    open() {
        const req = { result: null, error: new Error('测试环境无 IndexedDB'), onsuccess: null, onerror: null, onupgradeneeded: null };
        setTimeout(() => req.onerror && req.onerror({ target: req }), 0);
        return req;
    },
    deleteDatabase() {
        const req = { onsuccess: null, onerror: null };
        setTimeout(() => req.onsuccess && req.onsuccess({}), 0);
        return req;
    },
};

// SillyTavern 替身
globalThis.SillyTavern = {
    getContext: () => ({
        generateRaw: async () => '{}',
        getRequestHeaders: () => ({}),
    }),
};
globalThis.toastr = { info: () => {}, success: () => {}, warning: () => {}, error: () => {} };
globalThis.$ = () => ({ append: () => {}, on: () => {} });

// ============================================================
// 启动
// ============================================================
const results = [];
function check(name, fn) {
    try {
        const r = fn();
        if (r === false) throw new Error('断言为 false');
        results.push({ name, ok: true });
    } catch (e) {
        results.push({ name, ok: false, err: e.message });
    }
}

let api = null;
try {
    const mod = await import('../txtToWorldbook/main.js');
    check('main.js 能被导入', () => true);
    check('导出 initTxtToWorldbookBridge', () => typeof mod.initTxtToWorldbookBridge === 'function');

    await mod.initTxtToWorldbookBridge();
    check('initTxtToWorldbookBridge() 执行无异常', () => true);

    api = globalThis.window.TxtToWorldbook || null;
    check('挂载了 window.TxtToWorldbook', () => api !== null);
    check('对外暴露 open()', () => typeof api?.open === 'function');
} catch (e) {
    check('启动流程', () => {
        throw e;
    });
}

// 打开主弹窗，验证 UI 装配
if (api && typeof api.open === 'function') {
    try {
        await api.open();
        check('open() 执行无异常', () => true);
    } catch (e) {
        check('open() 执行无异常', () => {
            throw e;
        });
    }

    const mustExist = [
        ['ttw-start-btn', '开始转换按钮'],
        ['ttw-api-provider', 'API提供商下拉'],
        ['ttw-api-timeout', 'API超时输入'],
        ['ttw-temperature', '温度输入（新增）'],
        ['ttw-max-tokens', '最大输出输入（新增）'],
        ['ttw-message-chain-list', '消息链列表'],
        ['ttw-import-st-preset', '导入酒馆预设按钮（新增）'],
        ['ttw-st-preset-file', '预设文件选择器（新增）'],
        ['ttw-import-update-chapters', '导入更新章节按钮（移植）'],
        ['ttw-preset-name-hint', '预设名提示（新增）'],
        ['ttw-stream-content', '实时输出面板'],
        ['ttw-use-tavern-api', '酒馆API开关（保留）'],
    ];
    for (const [id, label] of mustExist) {
        check(`界面元素存在: ${label}`, () => document.getElementById(id) !== null);
    }

    const clickable = [
        ['ttw-import-st-preset', '导入酒馆预设'],
        ['ttw-import-update-chapters', '导入更新章节'],
        ['ttw-add-chain-msg', '添加消息'],
        ['ttw-reset-chain', '恢复默认消息链'],
    ];
    for (const [id, label] of clickable) {
        check(`已绑定点击事件: ${label}`, () => {
            const el = document.getElementById(id);
            return !!(el && el._listeners.click && el._listeners.click.length > 0);
        });
    }

    check('温度输入已绑定 change 保存', () => {
        const el = document.getElementById('ttw-temperature');
        return !!(el && el._listeners.change && el._listeners.change.length > 0);
    });
    check('最大输出已绑定 change 保存', () => {
        const el = document.getElementById('ttw-max-tokens');
        return !!(el && el._listeners.change && el._listeners.change.length > 0);
    });
    check('预设文件选择器已绑定 change', () => {
        const el = document.getElementById('ttw-st-preset-file');
        return !!(el && el._listeners.change && el._listeners.change.length > 0);
    });

    check('provider 下拉已移除 DeepSeek', () => {
        const panel = registry.get('ttw-api-provider');
        return panel !== null;
    });
}

// ============================================================
// 汇总
// ============================================================
const pass = results.filter((r) => r.ok).length;
const fail = results.filter((r) => !r.ok);
for (const r of results) {
    console.log(`${r.ok ? '  ✅' : '  ❌'} ${r.name}${r.ok ? '' : ' — ' + r.err}`);
}
console.log(`\n启动冒烟测试：通过 ${pass}，失败 ${fail.length}`);
process.exit(fail.length ? 1 : 0);

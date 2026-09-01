/**
 * 导入图校验
 *
 * ESM 里最常见的白屏原因：某个文件 import 了一个目标模块并不存在的具名导出。
 * 浏览器会在加载阶段直接报 SyntaxError，整个插件不加载，且报错信息对非开发者
 * 极不友好。这里在打包前把整张图静态走一遍。
 *
 * 校验项：
 *   1. 每个 import 的相对路径文件真实存在
 *   2. 每个具名 import 在目标模块的导出列表里
 *   3. default import 对应目标确实有 default 导出
 *   4. 没有循环依赖（仅告警，ESM 允许但容易出初始化顺序问题）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

const ROOT = resolve(new URL('.', import.meta.url).pathname, '..', 'txtToWorldbook');

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (name.endsWith('.js')) out.push(p);
    }
    return out;
}

/** 抽取一个模块的所有具名导出与是否有 default 导出 */
/** 去掉 BOM、块注释和行注释，避免把文档里的示例代码当成真实语句 */
function normalize(src) {
    return src
        .replace(/^\uFEFF/, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
}

function getExports(rawSrc) {
    const src = normalize(rawSrc);
    const named = new Set();
    let hasDefault = false;

    // export function foo / export async function foo
    for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) named.add(m[1]);
    // export const/let/var foo
    for (const m of src.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) named.add(m[1]);
    // export class Foo
    for (const m of src.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) named.add(m[1]);
    // export { a, b as c }
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const part of m[1].split(',')) {
            const t = part.trim();
            if (!t) continue;
            const asMatch = t.match(/\s+as\s+([A-Za-z_$][\w$]*)$/);
            const name = asMatch ? asMatch[1] : t;
            if (name === 'default') hasDefault = true;
            else named.add(name);
        }
    }
    if (/^export\s+default\b/m.test(src)) hasDefault = true;
    return { named, hasDefault };
}

/** 抽取一个模块的所有 import 语句 */
function getImports(rawSrc) {
    const src = normalize(rawSrc);
    const out = [];
    const re = /import\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
    for (const m of [...src.matchAll(re)]) {
        const clause = m[1].trim();
        const spec = m[2];
        const named = [];
        let def = null;
        let namespace = false;

        const braceMatch = clause.match(/\{([^}]*)\}/);
        if (braceMatch) {
            for (const part of braceMatch[1].split(',')) {
                const t = part.trim();
                if (!t) continue;
                named.push(t.split(/\s+as\s+/)[0].trim());
            }
        }
        const beforeBrace = clause.split('{')[0].replace(/,$/, '').trim();
        if (beforeBrace.startsWith('*')) namespace = true;
        else if (beforeBrace && !beforeBrace.startsWith('{')) def = beforeBrace;

        out.push({ spec, named, def, namespace });
    }
    // 副作用导入 import 'x';
    for (const m of src.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) {
        out.push({ spec: m[1], named: [], def: null, namespace: false });
    }
    return out;
}

const files = walk(ROOT);
const exportCache = new Map();
function exportsOf(file) {
    if (!exportCache.has(file)) exportCache.set(file, getExports(readFileSync(file, 'utf8')));
    return exportCache.get(file);
}

const errors = [];
const graph = new Map();

for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    const deps = [];

    for (const imp of getImports(src)) {
        if (!imp.spec.startsWith('.')) continue; // 外部包不校验
        const target = resolve(dirname(file), imp.spec);

        if (!existsSync(target)) {
            errors.push(`${rel}: 导入的文件不存在 -> ${imp.spec}`);
            continue;
        }
        deps.push(relative(ROOT, target));

        const { named, hasDefault } = exportsOf(target);
        for (const n of imp.named) {
            if (!named.has(n)) {
                errors.push(`${rel}: 从 ${imp.spec} 具名导入 "${n}"，但该模块没有导出它`);
            }
        }
        if (imp.def && !hasDefault) {
            errors.push(`${rel}: 从 ${imp.spec} 默认导入 "${imp.def}"，但该模块没有 default 导出`);
        }
    }
    graph.set(rel, deps);
}

// 循环依赖检测
const cycles = [];
const state = new Map();
function dfs(node, stack) {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
        const idx = stack.indexOf(node);
        if (idx !== -1) cycles.push([...stack.slice(idx), node]);
        return;
    }
    state.set(node, 'visiting');
    for (const dep of graph.get(node) || []) dfs(dep, [...stack, node]);
    state.set(node, 'done');
}
for (const node of graph.keys()) dfs(node, []);

console.log(`扫描模块: ${files.length} 个`);
if (errors.length) {
    console.log(`\n❌ 导入错误 ${errors.length} 处：`);
    for (const e of errors) console.log('  ' + e);
} else {
    console.log('✅ 所有 import 均能解析，具名导出全部存在');
}
if (cycles.length) {
    const uniq = [...new Set(cycles.map((c) => c.join(' -> ')))];
    console.log(`\n⚠️  检测到 ${uniq.length} 条循环依赖：`);
    for (const c of uniq.slice(0, 10)) console.log('  ' + c);
} else {
    console.log('✅ 无循环依赖');
}
process.exit(errors.length ? 1 : 0);

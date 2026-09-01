/**
 * 测试执行器
 *
 * 逐个加载作者自带的测试文件，用本地 vitest 兼容层执行，汇总结果。
 * 每个文件在独立的子进程里跑，避免 describe 注册表互相污染。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const TOOLS = new URL('.', import.meta.url).pathname;   // node_modules 在这里，子进程需以此为 cwd
const ROOT = resolve(TOOLS, '..');
const TESTS = join(ROOT, 'tests');

function walk(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (name.endsWith('.test.js')) out.push(p);
    }
    return out;
}

const skip = process.argv.slice(2);
const files = walk(TESTS).sort();

let totalPass = 0;
let totalFail = 0;
const failedFiles = [];
const skipped = [];

for (const file of files) {
    const rel = relative(ROOT, file);
    if (skip.some((s) => rel.includes(s))) {
        skipped.push(rel);
        continue;
    }

    const child = spawnSync(
        process.execPath,
        [
            '--input-type=module',
            '-e',
            `
            import { __runAll } from 'vitest';
            await import(${JSON.stringify(file)});
            const r = await __runAll(${JSON.stringify(rel)});
            console.log('___RESULT___' + JSON.stringify({
                pass: r.pass, fail: r.fail,
                failures: r.failures.map(f => ({ label: f.label, msg: String(f.error && f.error.message).slice(0, 400) }))
            }));
            `,
        ],
        { cwd: ROOT, encoding: 'utf8', timeout: 120000 },
    );

    const marker = (child.stdout || '').split('___RESULT___')[1];
    if (!marker) {
        totalFail++;
        failedFiles.push(rel);
        console.log(`\n💥 ${rel} — 加载失败`);
        const err = (child.stderr || '').trim().split('\n').slice(0, 6).join('\n');
        console.log(err ? '   ' + err.replace(/\n/g, '\n   ') : '   （无输出）');
        continue;
    }

    const r = JSON.parse(marker.trim());
    totalPass += r.pass;
    totalFail += r.fail;
    const icon = r.fail === 0 ? '✅' : '❌';
    console.log(`${icon} ${rel.padEnd(46)} 通过 ${String(r.pass).padStart(3)}  失败 ${r.fail}`);
    if (r.fail > 0) {
        failedFiles.push(rel);
        for (const f of r.failures) {
            console.log(`     ↳ ${f.label}`);
            console.log(`       ${f.msg.split('\n').join('\n       ')}`);
        }
    }
}

console.log('\n' + '='.repeat(64));
console.log(`总计：通过 ${totalPass}，失败 ${totalFail}`);
if (skipped.length) console.log(`跳过：${skipped.join(', ')}`);
if (failedFiles.length) console.log(`失败文件：${failedFiles.join(', ')}`);
process.exit(totalFail === 0 ? 0 : 1);

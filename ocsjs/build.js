/**
 * 标准构建脚本（唯一正确入口）
 *
 * 为什么需要它：2026-10-20 清理时手打了 esbuild 命令，漏掉 --global-name=OCS，
 * 导致 bundle 里没有 window.OCS，footer 的 `const {...} = OCS` 抛
 * "OCS is not defined"，整个用户脚本不执行、面板完全不出现。
 *
 * 必须保留的语义：
 *   globalName: 'OCS'     产出 `var OCS = (()=>{...})()`，footer 依赖它
 *   format: 'iife'        与 global-name 配合，挂到当前作用域
 *   platform: 'browser'   浏览器目标
 *   alias @ocsjs/core     指向源码，不能用 node_modules 里的旧版
 *
 * ⚠️ 绝对不要加 external: ['easy-us']：
 *   userscript 里没有 require，"Dynamic require of easy-us is not supported"，
 *   OCS 同样会未定义。easy-us 必须内联进 bundle。
 *
 * 用法: node build.js
 * （不使用 child_process：esbuild JS API + 字面量 require，避开 shell 注入面）
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dist = path.join(root, 'dist');
const bundle = path.join(dist, '_bundle.js');
const outfile = path.join(dist, 'ocs.ai.user.js');

// 1) 打包 bundle —— 参数语义与旧命令行完全一致
esbuild.buildSync({
	entryPoints: [path.join(root, 'packages/scripts/src/index.ts')],
	bundle: true,
	globalName: 'OCS', // ← 关键：没有它就没有 window.OCS
	format: 'iife',
	platform: 'browser',
	target: 'es2020',
	alias: { '@ocsjs/core': path.join(root, 'packages/core/src/index.ts') },
	outfile: bundle,
	logLevel: 'warning'
});

// 2) 自检 bundle：必须存在全局 OCS 定义
const bundleText = fs.readFileSync(bundle, 'utf8');
if (!/var OCS\s*=\s*\(\(\)\s*=>/.test(bundleText)) {
	throw new Error(
		'❌ bundle 里没有 `var OCS = (() =>` —— globalName: OCS 没生效。\n' +
			'   用户脚本会在 footer 处抛 "OCS is not defined"，面板不会出现。'
	);
}
if (/Dynamic require of "?easy-us"?/.test(bundleText)) {
	throw new Error('❌ bundle 里残留 external easy-us —— 不要 external easy-us');
}
console.log('✓ bundle 自检通过：含全局 OCS 定义');

// 3) 组装 userscript（header + bundle + footer；该脚本被 require 时即执行）
require('./test-browser/build-userscript.js');

// 4) 自检最终产物
const finalText = fs.readFileSync(outfile, 'utf8');
const checks = [
	['全局 OCS 定义', /var OCS\s*=\s*\(\(\)\s*=>/.test(finalText)],
	['footer 引用 OCS', finalText.includes('const { start, definedProjects')],
	['含启动 start({', finalText.includes('start({')],
	['无 external easy-us', !/Dynamic require of "?easy-us"?/.test(finalText)]
];
let bad = 0;
for (const [name, ok] of checks) {
	console.log((ok ? '✓ ' : '✗ ') + name);
	if (!ok) bad++;
}
if (bad) throw new Error('❌ 产物自检失败，不要发布');

// 5) 语法检查（esbuild transform 校验，不落盘）
esbuild.transformSync(finalText, { loader: 'js' });
console.log('✓ 语法检查通过');

// 6) 清理中间产物（与 构建OCS-AI脚本.bat 行为一致）
if (fs.existsSync(bundle)) {
	fs.unlinkSync(bundle);
	console.log('✓ 已清理 dist/_bundle.js');
}

const size = fs.statSync(outfile).size;
console.log('\n构建完成: ' + outfile);
console.log('大小: ' + size + ' bytes (' + (size / 1024).toFixed(1) + ' KB)');

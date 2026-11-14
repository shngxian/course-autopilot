/**
 * 纯观察浏览器 —— 不加载 MUR 扩展，脚本不会运行，不会干扰页面。
 *
 * 用同一个 chrome-profile（保留学习通登录态），但不加载 mur 扩展目录，
 * 所以用户脚本完全不执行。可以安全地观察 DOM 结构、点标签页、看数据。
 *
 * 用法: node observe.js
 * 然后浏览器会开着，用 CDP (9223) 连过去观察。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');

const CHROME = path.resolve(__dirname, '../../ocs-desktop/bin/chrome/chrome/chrome.exe');
const PROFILE = path.resolve(__dirname, 'chrome-profile');
const CDP_PORT = 9223;

(async () => {
	console.log('启动观察用浏览器（不加载 MUR，脚本不会运行）...');
	console.log('CHROME :', CHROME);
	console.log('PROFILE:', PROFILE);

	const ctx = await chromium.launchPersistentContext(PROFILE, {
		executablePath: CHROME,
		headless: false,
		args: [
			`--remote-debugging-port=${CDP_PORT}`,
			'--no-first-run',
			'--no-default-browser-check',
			// 关键：不传 --load-extension，MUR 不加载，用户脚本不运行
			'--disable-extensions-except=',
			'--disable-background-networking',
			'--disable-features=Translate,OptimizationHints'
		],
		viewport: null
	});

	const pages = ctx.pages();
	const page = pages[0] || (await ctx.newPage());
	await page.goto('https://mooc1.chaoxing.com/visit/courses').catch(() => {});

	console.log('=== CDP: http://127.0.0.1:' + CDP_PORT + ' ===');
	console.log('浏览器已启动，脚本未加载。');
	console.log('（保持窗口开着，用 node 脚本通过 CDP 观察）');

	// 一直挂着，直到进程被杀
	await new Promise(() => {});
})();

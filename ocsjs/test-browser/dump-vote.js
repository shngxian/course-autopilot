const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const page = browser.contexts()[0].pages().find((p) => p.url().includes('studentstudy'));
	const fr = page.frames().find((f) => /modules\/zt\/vote/.test(f.url()));
	const code = await fr.evaluate(() => {
		const scripts = Array.from(document.querySelectorAll('script')).map((s) => s.textContent || '').join('\n');
		const j = scripts.indexOf('.click(function');
		if (j < 0) return '(no .click handler)';
		const start = Math.max(0, scripts.lastIndexOf('$', j));
		return scripts.slice(start, start + 1100);
	}).catch((e) => 'ERR ' + e.message.slice(0, 60));
	console.log(code.slice(0, 1300));
	await browser.close();
})().catch((e) => console.log('ERR', e.message.slice(0, 50)));

const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const page = browser.contexts()[0].pages().find((p) => p.url().includes('chapterId=916003684'));
	const v = await page.evaluate(() => {
		const O = (typeof OCS !== 'undefined') ? OCS : null;
		const root = O && O.$elements && O.$elements.root;
		if (!root) return { err: 'no root' };
		const bar = root.querySelector('.extra-menu-bar');
		if (!bar) return { err: 'no extra-menu-bar', root子元素: Array.from(root.children).map((c) => c.tagName + '.' + String(c.className || '').slice(0, 30)).slice(0, 8) };
		return {
			工具栏HTML: bar.innerHTML.replace(/\s+/g, ' ').slice(0, 400),
			工具栏按钮数: bar.querySelectorAll('*').length,
			emoji: ['🏠', '🖥️', '🔎', '⚙️', '📥', '📄'].filter((e) => bar.innerHTML.includes(e))
		};
	}).catch((e) => ({ err: e.message.slice(0, 60) }));
	console.log(JSON.stringify(v, null, 1).slice(0, 900));
	await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const page = browser.contexts()[0].pages().find((p) => p.url().includes('studentstudy'));
	const quizzes = await page.evaluate(() => {
		return Array.from(document.querySelectorAll('[id^="cur"]'))
			.filter((el) => /测验|测试/.test(el.textContent || ''))
			.map((el) => ({
				id: el.id.replace('cur', ''),
				name: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
				unfinish: !!el.querySelector('img[src*="orange"]'), // 橙点=未完成
				cls: el.className.includes('current') ? 'CURRENT' : ''
			}));
	});
	quizzes.forEach((q) => console.log(`${q.unfinish ? '●未完成' : '○已完成'} id=${q.id} ${q.cls} ${q.name}`));
	console.log('总数:', quizzes.length);
	await browser.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });

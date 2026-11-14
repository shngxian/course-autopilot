const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const page = browser.contexts()[0].pages().find((p) => p.url().includes('studentstudy'));
	console.log('全部帧:');
	for (const f of page.frames()) console.log(' ', f.url().slice(0, 100));
	const vf = page.frames().find((f) => /api\/work|vote/i.test(f.url()) && !/index-pc-new/.test(f.url()));
	if (vf) {
		const q = await vf.evaluate(() => {
			const body = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
			const radios = document.querySelectorAll('input[type=radio]').length;
			const btns = Array.from(document.querySelectorAll('button, a.btn, div[onclick], input[type=button], input[type=submit]')).map((b) => (b.textContent || b.value || '').trim()).filter(Boolean).slice(0, 6);
			return { body, radios, btns };
		}).catch((e) => ({ err: e.message.slice(0, 60) }));
		console.log('题面:', JSON.stringify(q, null, 1).slice(0, 900));
	}
	await browser.close();
})().catch((e) => console.log('ERR', e.message.slice(0, 50)));

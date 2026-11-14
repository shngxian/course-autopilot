const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const page = browser.contexts()[0].pages().find((p) => p.url().includes('studentstudy'));
	const st = await page.evaluate(() => {
		const vi = document.querySelector('#voteIframe');
		const vc = document.querySelector('.voteContainer');
		return {
			voteIframe: vi ? { src: (vi.getAttribute('src') || '').slice(0, 110), display: getComputedStyle(vi).display } : '(无)',
			container: vc ? { display: getComputedStyle(vc).display } : '(无容器)'
		};
	}).catch((e) => ({ err: e.message.slice(0, 60) }));
	console.log('顶层弹层:', JSON.stringify(st, null, 1));
	// 若已打开，看问卷题目结构
	const vf = page.frames().find((f) => /vote\/(index|voteDetail)|votetype/.test(f.url()) && !/vote\/index-pc-new/.test(f.url()));
	console.log('问卷题面帧:', vf ? vf.url().slice(0, 100) : '(未开)');
	if (vf) {
		const q = await vf.evaluate(() => {
			const body = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 250);
			const radios = document.querySelectorAll('input[type=radio]').length;
			const checks = document.querySelectorAll('input[type=checkbox]').length;
			const btns = Array.from(document.querySelectorAll('button, a, div[onclick], input[type=button], input[type=submit]')).map((b) => (b.textContent || b.value || '').trim()).filter(Boolean).slice(0, 6);
			return { body, radios, checks, btns };
		}).catch((e) => ({ err: e.message.slice(0, 60) }));
		console.log('题面:', JSON.stringify(q, null, 1).slice(0, 800));
	}
	await browser.close();
})().catch((e) => console.log('ERR', e.message.slice(0, 50)));

const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');
(async () => {
	const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
	const page = browser.contexts()[0].pages().find((p) => p.url().includes('studentstudy'));
	const vf = page.frames().find((f) => /answerQuestionChapter/.test(f.url()));
	if (!vf) { console.log('题面帧不在'); process.exit(0); }
	const q = await vf.evaluate(() => {
		const out = { body: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300) };
		// 找题目分组
		const groups = Array.from(document.querySelectorAll('[class*=question], [class*=Ques], .ti, fieldset, .list')).slice(0, 3);
		out.groupCls = groups.map((g) => g.className.toString().slice(0, 40));
		out.radios = document.querySelectorAll('input[type=radio]').length;
		out.checks = document.querySelectorAll('input[type=checkbox]').length;
		out.labels = document.querySelectorAll('label').length;
		out.btns = Array.from(document.querySelectorAll('button, a, div[onclick], input[type=button], input[type=submit]')).map((b) => (b.textContent || b.value || '').trim()).filter((t) => t && t.length < 10).slice(0, 8);
		// 一道题的完整html示例
		const firstRadio = document.querySelector('input[type=radio]');
		if (firstRadio) {
			let p = firstRadio.parentElement;
			for (let i = 0; i < 3 && p; i++) p = p.parentElement;
			out.sampleHTML = (firstRadio.closest('[class*=question]') || p || firstRadio).outerHTML.replace(/\s+/g, ' ').slice(0, 500);
		}
		return out;
	}).catch((e) => ({ err: e.message.slice(0, 60) }));
	console.log(JSON.stringify(q, null, 1).slice(0, 1500));
	await browser.close();
})().catch((e) => console.log('ERR', e.message.slice(0, 50)));

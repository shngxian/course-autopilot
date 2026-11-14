/**
 * 雨课堂上课监听（配合 一键刷课.bat 使用）
 *
 *   先跑 test-browser/一键刷课.bat（起 serve + 浏览器），然后：
 *     node ykt-class.js [课程名关键词]
 *
 * 职责：
 *   1. 等 serve(18923) 与浏览器(CDP 9223) 就绪（没起就提示，30 秒轮询）
 *   2. 对比 dist 产物 mtime 与 MUR 已注册代码时间，落后就热更新（SW install()）
 *   3. 打开雨课堂，按课程名关键词进课程 → 轮询「正在上课」的课堂 → 点进去
 *   4. 常驻监听：课堂 DOM（选项/提交/倒计时）+ 接口响应 + 答题脚本日志
 *      全部落 ykt-class-report.json，Ctrl+C 停止
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');

const COURSE_KEY = process.argv[2] || ''; // 课程名关键词，如 "大学物理"
const CDP = 'http://127.0.0.1:9223';
const REPORT = path.resolve(__dirname, 'ykt-class-report.json');
const DIST = path.resolve(__dirname, '../dist/ocs.ai.user.js');

const report = { startedAt: new Date().toISOString(), apis: [], doms: [], logs: [] };
const log = (...a) => console.log('[' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + ']', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function save() {
	try {
		fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
	} catch {}
}

async function cdpAlive() {
	try {
		const r = await fetch(CDP + '/json/version');
		return r.ok;
	} catch {
		return false;
	}
}

async function serveAlive() {
	try {
		const r = await fetch('http://127.0.0.1:18923/ocs.ai.user.js');
		return r.ok;
	} catch {
		return false;
	}
}

(async () => {
	// ── 1. 等 serve + 浏览器（一键刷课.bat 负责拉起，这里只等）──
	const t0 = Date.now();
	for (;;) {
		const s = await serveAlive();
		const c = await cdpAlive();
		if (s && c) break;
		if (Date.now() - t0 > 120000) {
			console.error('❌ serve(18923)=' + s + ' 浏览器(CDP9223)=' + c + ' —— 请先运行 test-browser/一键刷课.bat');
			process.exit(1);
		}
		log('等待环境就绪（serve=' + s + ' 浏览器=' + c + '）——没起就先跑 一键刷课.bat');
		await sleep(15000);
	}
	log('serve + 浏览器就绪');

	const browser = await chromium.connectOverCDP(CDP);
	const ctx = browser.contexts()[0];

	// ── 2. MUR 代码热更新（产物比已注册的新才更新）──
	try {
		const sw = ctx.serviceWorkers().find((s) => /oimniccmf|mur/i.test(s.url()));
		if (sw) {
			const distM = fs.existsSync(DIST) ? fs.statSync(DIST).mtimeMs : 0;
			const need = await sw.evaluate(async (dm) => {
				const v = (await chrome.storage.local.get('mur_last_fetch')).mur_last_fetch || 0;
				return v < dm;
			}, distM);
			if (need) {
				await sw.evaluate(() => install());
				log('MUR 已热更新到最新构建');
				await sleep(1500);
			} else log('MUR 代码已是最新');
		} else log('⚠️ 未找到 MUR SW（跳过热更检查）');
	} catch (e) {
		log('⚠️ MUR 热更检查失败: ' + e.message);
	}

	// ── 3. 找/进正在上的课 ──
	const findLessonTab = () => ctx.pages().find((p) => /yuketang\.cn\/lesson\/fullscreen/.test(p.url()));

	let lesson = findLessonTab();
	if (lesson) log('已有课堂页: ' + lesson.url().slice(0, 90));

	while (!lesson) {
		try {
			let page = ctx.pages().find((p) => /yuketang\.cn/.test(p.url()));
			if (!page || !/yuketang\.cn/.test(page.url())) {
				page = await ctx.newPage();
				await page.goto('https://www.yuketang.cn/v2/web/index', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
				await sleep(5000);
			}

			if (!/studentLog/.test(page.url())) {
				// 进课程（按关键词选卡，默认第一张 2026 秋课程）
				const r = await page.evaluate((key) => {
					const cards = Array.from(document.querySelectorAll('section.studentCard, [class*=course-item], .el-card'));
					const hit = key
						? cards.find((c) => (c.innerText || '').includes(key))
						: cards.find((c) => /我听的课|2026秋/.test(c.innerText || '')) || cards[0];
					if (!hit) return 'no-card';
					(hit.querySelector('.el-card__body') || hit).click();
					return 'clicked:' + (hit.innerText || '').replace(/\s+/g, ' ').slice(0, 40);
				}, COURSE_KEY);
				log('进课程: ' + r);
				await sleep(6000);
			}

			// 轮询「正在上课」
			const live = await page.evaluate(() => {
				const cards = Array.from(document.querySelectorAll('section.studentCard'));
				const c = cards.find((x) => (x.innerText || '').includes('正在上课'));
				if (!c) return null;
				const wrap = c.querySelector('.activity__wrap') || c;
				wrap.click();
				return (c.innerText || '').replace(/\s+/g, ' ').slice(0, 60);
			});
			if (live) {
				log('发现正在上课: ' + live + ' → 等课堂页打开');
				for (let i = 0; i < 15 && !(lesson = findLessonTab()); i++) await sleep(1000);
			} else {
				log('暂无「正在上课」，30 秒后再查' + (COURSE_KEY ? '（课程: ' + COURSE_KEY + '）' : ''));
				await sleep(30000);
			}
		} catch (e) {
			log('轮询异常: ' + e.message);
			await sleep(10000);
		}
	}

	// ── 4. 常驻监听课堂页 ──
	lesson.on('dialog', (d) => d.accept().catch(() => {}));
	lesson.on('response', async (res) => {
		try {
			const url = res.url();
			if (!/presentation|problem|lesson|classroom|\/fetch|checkin|answer/i.test(url)) return;
			let body = '';
			try {
				body = (await res.text()).slice(0, 4000);
			} catch {}
			const fields = ['answers', 'answer', 'problem', 'problems', 'body', 'options', 'correct', 'blanks'].filter((k) =>
				body.includes('"' + k + '"')
			);
			const rec = { t: new Date().toISOString(), url: url.replace(/^https?:\/\/[^/]+/, '').slice(0, 140), status: res.status(), fields };
			if (/"answers"|"correct"/.test(body)) rec.sample = body.slice(0, 1200);
			report.apis.push(rec);
			log('[接口] ' + rec.url.slice(0, 80) + ' 字段: ' + (fields.join(',') || '(无)'));
		} catch {}
	});

	const OPTION_SELS = ['[data-option]', '.options-label', 'input[type=radio]', 'input[type=checkbox]'];
	let logCursor = 0;
	setInterval(async () => {
		try {
			if (!findLessonTab()) return; // 课堂页关了就歇着
			// DOM 摘要
			const dom = await lesson.evaluate((sels) => {
				const vis = (el) => el && el.offsetParent !== null;
				const hits = {};
				for (const s of sels) {
					const n = Array.from(document.querySelectorAll(s)).filter(vis).length;
					if (n) hits[s] = n;
				}
				const submit = Array.from(document.querySelectorAll('button,[role=button],[class*=submit]'))
					.filter((e) => vis(e) && /^(提交|提交答案|确定|确认)$/.test((e.innerText || '').trim()))
					.map((e) => (e.innerText || '').trim());
				const timer = Array.from(document.querySelectorAll('[class*="countdown"],[class*="timer"],[class*="remain"]'))
					.filter(vis)
					.map((e) => (e.textContent || '').trim().slice(0, 18))
					.filter(Boolean)
					.slice(0, 3);
				return { t: new Date().toISOString(), url: location.pathname.slice(-14), hits, submit, timer };
			}, OPTION_SELS);
			const interesting = Object.keys(dom.hits).length > 0 || dom.submit.length > 0;
			const prev = report.doms[report.doms.length - 1] || {};
			const strip = (o) => JSON.stringify({ ...o, t: 0 });
			if (interesting && strip(dom) !== strip(prev)) {
				report.doms.push(dom);
				log('[DOM] 选项 ' + JSON.stringify(dom.hits) + ' 提交=' + JSON.stringify(dom.submit) + ' 倒计时=' + JSON.stringify(dom.timer));
			}
			// 答题脚本日志
			const logs = await lesson.evaluate(() => JSON.parse(String(localStorage.getItem('ocs_ykt_lesson_log') || '[]')));
			for (const e of logs) {
				if (e.t <= logCursor) continue;
				logCursor = e.t;
				const d = e.data ? ' | ' + String(e.data).slice(0, 120) : '';
				report.logs.push({ t: new Date(e.t).toISOString(), level: e.level, msg: String(e.msg).slice(0, 100) });
				log('[脚本][' + e.level + '] ' + String(e.msg).slice(0, 50) + d);
			}
		} catch {}
	}, 3000);

	setInterval(save, 20000);
	log('监听已挂上（课堂推题/翻页会自动记录）。停止 = Ctrl+C');
	process.on('SIGINT', () => {
		save();
		process.exit(0);
	});
})().catch((e) => {
	console.error('启动失败:', e && e.message);
	process.exit(1);
});

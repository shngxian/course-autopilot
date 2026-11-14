/**
 * 用户浏览器接管启动器
 *
 * 用用户的"未命名浏览器"profile（安装版 OCS Desktop 的 3877d465...），
 * 带 CDP 调试端口启动，超星/千问登录态保留。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('../../ocs-desktop/packages/app/node_modules/playwright-core');

const CHROME = path.resolve(__dirname, '../../ocs-desktop/bin/chrome/chrome/chrome.exe');
// 项目自包含 profile：优先用项目内的 chrome-profile（登录态已迁入），
// 这样本项目不再依赖已安装的 OCS Desktop 客户端（可安全卸载它）。
// 兜底：项目内 profile 不存在时，回退到旧 OCS Desktop 数据目录（历史兼容）。
const PROJECT_PROFILE = path.resolve(__dirname, 'chrome-profile');
// 用 8.3 短路径绕过 "OCS Desktop" 中的空格（Playwright 传参空格会导致 chrome exit 21）
const LEGACY_PROFILE = 'C:/Users/<你的用户名>/AppData/Roaming/OCSDES~1/userDataDirs/3877d465ef4547be8b9237b224a72ee6';
const PROFILE = fs.existsSync(PROJECT_PROFILE)
	? PROJECT_PROFILE
	: (fs.existsSync(LEGACY_PROFILE) ? LEGACY_PROFILE : PROJECT_PROFILE);
// 注意：--load-extension 路径不能含空格，用本地无空格路径的 MUR（与应用目录里的内容相同）
const EXT = path.resolve(__dirname, 'mur');
const CDP_PORT = 9223;

/**
 * AI 网页管理：按 OCS 全局设置决定「开哪个站点 + 开几个」
 *  - 站点 = aiEndpoint（bridge://qianwen / bridge://coze / bridge://chatglm），非桥接（官方 API）则不需要网页
 *  - 数量 = thread（1~3），1 个标签 = 1 路并发
 * 启动时和运行中（每 30s）都重新读配置，换站点 / 改线程数会自动增减窗口。
 */
// 个人账号配置（coze agentId 等）放本目录 ai.local.json（已 gitignore，不入库）：
//   { "cozeAgentId": "你的agentId" }
let COZE_AGENT_ID = '';
try {
	COZE_AGENT_ID = String(JSON.parse(fs.readFileSync(path.join(__dirname, 'ai.local.json'), 'utf8')).cozeAgentId || '');
} catch {}
const AI_SITES = {
	qianwen: { name: '千问', url: 'https://www.qianwen.com/chat', test: /qianwen\.com|tongyi\.com/ },
	coze: {
		name: '扣子',
		// 必须是带 agentId 的地址：不带会落到默认 agent（编程专家），不是用户自己的。
		// agentId 属个人账号信息，从 ai.local.json 读（见上）
		url: COZE_AGENT_ID
			? 'https://www.coze.cn/new-task?agentId=' + COZE_AGENT_ID + '&scene=new-agent'
			: 'https://www.coze.cn/new-task?scene=new-agent',
		test: /coze\.cn/
	},
	chatglm: { name: '智谱清言', url: 'https://chatglm.cn/', test: /chatglm\.cn/ },
	deepseek: { name: 'DeepSeek', url: 'https://chat.deepseek.com/', test: /deepseek\.com/ }
};

/** 当前目标（由 OCS 配置刷新）：站点 + 数量 */
let AI_TARGET = { site: 'qianwen', count: 3 };

// 环境变量覆盖（调试用）：AI_PAGES 指定数量、AI_SITE 指定站点；QWEN_PAGES 兼容旧名
const _envRaw = process.env.AI_PAGES !== undefined ? process.env.AI_PAGES : process.env.QWEN_PAGES;
const _envCount = Number(_envRaw);
const ENV_COUNT_SET = _envRaw !== undefined && Number.isFinite(_envCount) && _envCount >= 0;
if (ENV_COUNT_SET) AI_TARGET.count = _envCount;
if (process.env.AI_SITE && AI_SITES[process.env.AI_SITE]) AI_TARGET.site = process.env.AI_SITE;

/** 桥接「进行中」阶段：这些状态下绝不能关标签页/刷新，否则答案丢失 */
const BUSY_PHASES = ['start', 'input', 'input-with-images', 'send', 'waiting', 'captcha', 'retry-new-chat'];

/**
 * 关闭标签页（带超时）。
 * page.close() 在页面有 beforeunload / CDP 无响应时会永久 pending，
 * 一旦卡住会让 syncAIPagesBusy 锁再不释放、整个巡检死掉——所以必须竞态超时。
 */
async function closePage(p) {
	await Promise.race([p.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
}

/** 页面属于哪个 AI 站点（不是 AI 页返回 null） */
function aiSiteOf(p) {
	try {
		const url = p.url();
		for (const key of Object.keys(AI_SITES)) {
			if (AI_SITES[key].test.test(url)) return key;
		}
	} catch {}
	return null;
}

/** 千问页是否正在答题（取不到状态时按「忙」处理，保守不关） */
async function isBusyBridgePage(p) {
	try {
		// evaluate 默认超时 30s，页面卡加载时会把收敛流程拖死，这里限 3s
		const state = await Promise.race([
			p.evaluate(() => {
				try {
					const attr = document.documentElement.getAttribute('data-ocs-bridge');
					const phase = attr ? String(JSON.parse(attr).phase || '').toLowerCase() : '';
					// 编辑器里有内容 = 用户正在手动输入，别关
					const ed = document.querySelector('[contenteditable="true"]');
					const typing = !!(ed && (ed.innerText || '').trim().length > 0);
					return { phase, typing };
				} catch {
					return { phase: '', typing: false };
				}
			}),
			new Promise((_, reject) => setTimeout(() => reject(new Error('evaluate timeout')), 3000))
		]);
		return BUSY_PHASES.includes(state.phase) || state.typing;
	} catch {
		return true;
	}
}

/**
 * 等 MUR 中继就绪（relay.js 在 document_start 注入，ping 一下就知道）
 */
async function waitRelay(page, timeout = 4000) {
	try {
		return await Promise.race([
			page.evaluate(
				(t) =>
					new Promise((resolve) => {
						let done = false;
						const onMsg = (ev) => {
							const d = ev.data;
							if (d && d.__mur === 1 && d.type === 'relay-hello' && !done) {
								done = true;
								cleanup();
								resolve(true);
							}
						};
						const cleanup = () => {
							clearTimeout(timer);
							window.removeEventListener('message', onMsg);
						};
						const timer = setTimeout(() => {
							if (!done) {
								cleanup();
								resolve(false);
							}
						}, t);
						window.addEventListener('message', onMsg);
						window.postMessage({ __mur: 1, type: 'relay-ping' }, '*');
					}),
				timeout
			),
			new Promise((r) => setTimeout(() => r(false), timeout + 500))
		]);
	} catch {
		return false;
	}
}

/**
 * 从 MUR 存储读 OCS 全局设置：线程数量 + AI 接入方式
 *
 * 路径：页面 postMessage → relay content script → SW handleOp({t:'sync'})
 *       → chrome.storage.local 全量（键前缀 ocs-ai::）→ 回传
 * 配置是逐项存储的（key = namespaceKey(ns, 字段名)，如 common.settings-thread / common.settings-aiEndpoint）。
 * @returns {thread: number|null, endpoint: string|null}
 */
async function readOcsConfig(page) {
	const out = { thread: null, endpoint: null };
	try {
		if (!(await waitRelay(page))) return out;
		const values = await Promise.race([
			page.evaluate(
				() =>
					new Promise((resolve) => {
						const rid = 'mur_read_' + Math.random().toString(36).slice(2);
						const timer = setTimeout(() => resolve(null), 2500);
						const onMsg = (ev) => {
							const d = ev.data;
							if (!d || d.__mur !== 1 || d.from !== 'relay' || d.rid !== rid) return;
							clearTimeout(timer);
							window.removeEventListener('message', onMsg);
							resolve(d.values || null);
						};
						window.addEventListener('message', onMsg);
						window.postMessage({ __mur: 1, m: { t: 'sync' }, rid }, '*');
					})
			),
			new Promise((r) => setTimeout(() => r(null), 3500))
		]);
		if (!values) return out;

		for (const k of Object.keys(values)) {
			const raw = values[k];
			const preferred = /settings|common/i.test(k);

			// 线程数：逐项存储时键名以 thread 结尾、值是数字
			if (/(^|[.\-_:/])thread$/i.test(k) && typeof raw === 'number') {
				if (out.thread === null || preferred) out.thread = raw;
				continue;
			}
			// AI 接入方式：字符串（bridge://qianwen 等）
			if (/(^|[.\-_:/])aiEndpoint$/i.test(k) && typeof raw === 'string') {
				if (out.endpoint === null || preferred) out.endpoint = raw;
				continue;
			}
			// 兜底：整对象存储（值里带 thread / aiEndpoint 字段）
			let obj = raw;
			if (typeof obj === 'string') {
				try {
					obj = JSON.parse(obj);
				} catch {
					continue;
				}
			}
			if (obj && typeof obj === 'object') {
				if (typeof obj.thread === 'number' && (out.thread === null || preferred)) out.thread = obj.thread;
				if (typeof obj.aiEndpoint === 'string' && (out.endpoint === null || preferred)) out.endpoint = obj.aiEndpoint;
			}
		}
	} catch {}
	return out;
}

/**
 * 千问页数量收敛：多了关（只关空闲页，忙碌的下轮再关），少了补开
 * 目标数每轮先尝试从 OCS 线程数刷新，实现「线程数改了，页面数跟着变」
 */
let syncAIPagesBusy = false;
/**
 * AI 页「站点 + 数量」收敛
 * @param ctx
 * @param probePage 可选：已有页面（如课程页），用它读 OCS 配置，避免先开错站点的探针页
 */
async function syncAIPages(ctx, probePage) {
	if (syncAIPagesBusy) return;
	syncAIPagesBusy = true;
	try {
		const listAI = () => ctx.pages().map((p) => ({ p, site: aiSiteOf(p) })).filter((x) => x.site);
		let aiPages = listAI();

		// 读 OCS 配置：优先用传入页面，其次任意 AI 页，都没有才开探针页
		if (!ENV_COUNT_SET) {
			let probe = probePage || (aiPages.length ? aiPages[0].p : null);
			if (!probe) {
				const probeSite = AI_TARGET.site && AI_SITES[AI_TARGET.site] ? AI_TARGET.site : 'qianwen';
				probe = await ctx.newPage();
				await probe.goto(AI_SITES[probeSite].url, { waitUntil: 'commit', timeout: 20000 }).catch(() => {});
				await new Promise((r) => setTimeout(r, 1500));
				aiPages = listAI();
			}

			const cfg = await readOcsConfig(probe);
			if (cfg.thread !== null) {
				const n = Math.max(0, Math.min(3, Math.round(cfg.thread)));
				if (n !== AI_TARGET.count) {
					log('[AI页] OCS 线程数 = ' + cfg.thread + ' → 目标数量 ' + n);
					AI_TARGET.count = n;
				}
			}
			if (cfg.endpoint) {
				const site = cfg.endpoint.startsWith('bridge://')
					? cfg.endpoint.replace('bridge://', '').split('/')[0]
					: null; // 官方 API 模式：不需要网页
				const nextSite = site && AI_SITES[site] ? site : null;
				if (nextSite !== AI_TARGET.site) {
					log(
						'[AI页] AI 接入方式 = ' + cfg.endpoint + ' → 站点 ' +
							(nextSite ? AI_SITES[nextSite].name : '官方API（不需要网页）')
					);
					AI_TARGET.site = nextSite;
				}
			}
		}

		const targetSite = AI_TARGET.site;
		const targetCount = targetSite ? AI_TARGET.count : 0;

		// 1) 关掉非目标站点的（等空闲，避免丢答案）
		aiPages = listAI();
		for (const item of aiPages) {
			if (item.site === targetSite) continue;
			if (await isBusyBridgePage(item.p)) {
				log('[AI页] ' + AI_SITES[item.site].name + ' 正在答题，等空闲后再关');
				continue;
			}
			await closePage(item.p);
			log(
				'[AI页] 关闭 ' + AI_SITES[item.site].name +
					'（当前使用 ' + (targetSite ? AI_SITES[targetSite].name : '官方API') + '）'
			);
		}

		if (!targetSite) return;

		// 2) 目标站点数量收敛
		const mine = () => ctx.pages().filter((p) => aiSiteOf(p) === targetSite);
		const diff = mine().length - targetCount;

		if (diff > 0) {
			const idle = [];
			for (const p of mine()) {
				if (!(await isBusyBridgePage(p))) idle.push(p);
			}
			let extra = diff;
			for (const p of idle) {
				if (extra <= 0) break;
				await closePage(p);
				extra--;
				log('[AI页] 关闭 1 个多余的 ' + AI_SITES[targetSite].name + '（目标 ' + targetCount + '）');
			}
			if (extra > 0) log('[AI页] 还有 ' + extra + ' 个正在答题，等空闲后再关');
		} else if (diff < 0) {
			// 重新数一次：恢复会话的页面可能还在 about:blank 阶段
			const need = Math.max(0, targetCount - mine().length);
			for (let i = 0; i < need; i++) {
				const p = await ctx.newPage();
				await p.goto(AI_SITES[targetSite].url, { waitUntil: 'commit', timeout: 20000 }).catch(() => {});
				await new Promise((r) => setTimeout(r, 1200));
				log('[AI页] 补开 1 个 ' + AI_SITES[targetSite].name + '（目标 ' + targetCount + '）');
			}
		}
	} catch (e) {
		log('[AI页] 收敛失败: ' + (e && e.message));
	} finally {
		syncAIPagesBusy = false;
	}
}

function log(...a) { console.log('[' + new Date().toLocaleTimeString() + ']', ...a); }

async function ensureAllowUserScripts(ctx) {
	const p = await ctx.newPage();
	await p.goto('chrome://extensions');
	await new Promise(r => setTimeout(r, 2500));
	const extId = await p.evaluate(() => {
		const mgr = document.querySelector('extensions-manager');
		const list = mgr && mgr.shadowRoot && mgr.shadowRoot.querySelector('extensions-item-list');
		const items = list && list.shadowRoot ? Array.from(list.shadowRoot.querySelectorAll('extensions-item')) : [];
		for (const it of items) {
			const name = it.shadowRoot && it.shadowRoot.querySelector('#name') ? it.shadowRoot.querySelector('#name').textContent.trim() : '';
			if (name.includes('MUR')) return it.id;
		}
		return items[0] ? items[0].id : null;
	});
	if (!extId) { log('!! 未找到 MUR 扩展'); await p.close(); return; }
	log('MUR 扩展ID:', extId);
	await p.goto('chrome://extensions/?id=' + extId);
	await new Promise(r => setTimeout(r, 2000));
	const res = await p.evaluate(() => {
		let result = '未找到开关';
		function dig(root, depth) {
			if (!root || depth > 10 || result !== '未找到开关') return;
			for (const el of root.querySelectorAll('cr-toggle')) {
				let holder = el, text = '';
				for (let i = 0; i < 6 && holder; i++) {
					holder = holder.parentElement || (holder.getRootNode && holder.getRootNode().host);
					if (holder) { const t = (holder.textContent || '').trim().substring(0, 50); if (t) { text = t; break; } }
				}
				if (text.includes('用户脚本')) {
					if (!el.checked) { el.click(); result = '已开启'; } else result = '本来就开';
					return;
				}
			}
			for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) dig(el.shadowRoot, depth + 1); }
		}
		dig(document, 0);
		return result;
	}).catch(() => 'eval失败');
	log('允许用户脚本:', res);
	await p.close();
}

(async () => {
	if (!fs.existsSync(CHROME)) throw new Error('Chrome 不存在: ' + CHROME);
	log('启动用户浏览器 (MUR 1.6.0 + CDP)...');
	const ctx = await chromium.launchPersistentContext(PROFILE, {
		headless: false,
		viewport: null,
		executablePath: CHROME,
		ignoreHTTPSErrors: true,
		ignoreDefaultArgs: ['--disable-extensions', '--enable-automation', '--no-sandbox'],
		args: [
			'--window-position=0,0',
			'--window-size=1400,950',
			'--no-first-run',
			'--no-default-browser-check',
			'--remote-debugging-port=' + CDP_PORT,
			'--load-extension=' + EXT.replace(/\\/g, '/'),
			// 禁后台节流：刷课时浏览器窗口可以最小化/被遮挡，答题流程全速运行
			// （视频任务点除外——超星检测页面可见性，最小化会暂停视频，这与节流无关）
			'--disable-background-timer-throttling',
			'--disable-backgrounding-occluded-windows',
			'--disable-renderer-backgrounding',
			'--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion'
		]
	});
	log('浏览器已启动，页面:', ctx.pages().map(p => p.url().substring(0, 50)));
	await new Promise(r => setTimeout(r, 4000));
	await ensureAllowUserScripts(ctx);
	log('=== CDP: http://127.0.0.1:' + CDP_PORT + ' ===');
	startDaemon(ctx);
	// 一键启动：先开学习通课程页（兼作读 OCS 配置的探针）→ 按配置开对应 AI 站点
	try {
		let course = ctx.pages().find((p) => /chaoxing\.com/.test(p.url()));
		if (!course) {
			course = await ctx.newPage();
			await course.goto('https://i.chaoxing.com/', { waitUntil: 'commit', timeout: 30000 }).catch(() => {});
		}
		await syncAIPages(ctx, course);
		await course.bringToFront().catch(() => {});
		const siteName = AI_TARGET.site ? AI_SITES[AI_TARGET.site].name : '官方API（不自动开网页）';
		log('已打开: ' + siteName + '×' + AI_TARGET.count + ' + 学习通课程列表（从里面点任意课程即自动刷课）');
	} catch (e) {
		log('自动开页失败（不影响浏览器使用）: ' + (e && e.message));
	}
	setInterval(() => {}, 60000);
})().catch(e => { console.error('启动失败:', e); process.exit(1); });

/* ── CDP 守护进程：真实点击桥 + 千问页鼠标模拟 ───────────────────────
 * 页面 JS 无法伪造 isTrusted=true（浏览器安全红线），但 CDP Input 派发的事件
 * 与真人鼠标走同一输入管线、天生 isTrusted=true。用户脚本把点击请求写到页面
 * 顶层窗口（top.__cdpClicks，坐标已换算为顶层视口坐标），本守护循环轮询执行。
 * 同时在千问页面上做随机鼠标闲逛，消除"鼠标从不动"的自动化特征。
 * 全部 try/catch 包裹——守护失败不影响浏览器本体。
 */
function startDaemon(ctx) {
	let clickBusy = false;
	// 1) 真实点击桥：每 300ms 轮询所有超星/千问页面的点击请求
	setInterval(async () => {
		if (clickBusy) return;
		clickBusy = true;
		try {
			for (const page of ctx.pages()) {
				const url = page.url();
				if (!/chaoxing\.com|qianwen\.com|coze\.cn|deepseek\.com|chatglm\.cn/.test(url)) continue;
				const reqs = await page.evaluate(() => {
					try {
						window.__cdpDaemon = true;
						const r = window.__cdpClicks || [];
						window.__cdpClicks = [];
						return r;
					} catch { return []; }
				}).catch(() => []);
				// 标签回收：桥接端废弃对话后请求整页刷新（释放对话 DOM 内存）
				if (/qianwen\.com/.test(url)) {
					const recycle = await page.evaluate(() => {
						try {
							const t = window.__recycleTab;
							if (t && !window.__recycling) {
								window.__recycling = true;
								return t;
							}
						} catch {}
						return null;
					}).catch(() => null);
					if (recycle) {
						log('[守护] 回收千问标签页内存（整页刷新到新对话）');
						await page.evaluate(() => { location.href = 'https://www.qianwen.com/chat'; }).catch(() => {});
						await new Promise((r) => setTimeout(r, 8000));
					}
				}
				if (!reqs || !reqs.length) continue;
				for (const req of reqs) {
					try {
						// 中心点 ±2px 抖动，更像真人
						await page.mouse.click(req.x + (Math.random() * 4 - 2), req.y + (Math.random() * 4 - 2));
						await page.evaluate((id) => {
							try {
								window.__cdpClickResults = window.__cdpClickResults || {};
								window.__cdpClickResults[id] = { ok: true };
							} catch {}
						}, req.id).catch(() => {});
						log('[守护] 真实点击 @(' + req.x + ',' + req.y + ')');
					} catch {}
				}
			}
		} catch {}
		clickBusy = false;
	}, 300);

	// 2) 真实文件上传桥：JS 赋 input.files 对某些站点只是"假选择"
	//    （React 收到 change、渲染出缩略图，但浏览器没走真实文件选择，服务端没收到附件）。
	//    必须走 CDP setInputFiles。页面脚本经 window.__cdpUploads 发送 data URL 数组。
	let uploadBusy = false;
	setInterval(async () => {
		if (uploadBusy) return;
		uploadBusy = true;
		try {
			for (const page of ctx.pages()) {
				const url = page.url();
				if (!/qianwen\.com|coze\.cn|deepseek\.com|chatglm\.cn|chaoxing\.com/.test(url)) continue;
				const reqs = await page.evaluate(() => {
					try {
						window.__cdpDaemon = true;
						const r = window.__cdpUploads || [];
						window.__cdpUploads = [];
						return r;
					} catch { return []; }
				}).catch(() => []);
				if (!reqs || !reqs.length) continue;

				for (const req of reqs) {
					const done = (ok) =>
						page
							.evaluate((id) => {
								try {
									window.__cdpUploadResults = window.__cdpUploadResults || {};
									window.__cdpUploadResults[id] = { ok: true };
								} catch {}
							}, req.id)
							.catch(() => {});
					try {
						const files = (req.files || [])
							.map((u, i) => {
								const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(u) || [];
								return { name: `q_${i}.png`, mimeType: m[1] || 'image/png', buffer: Buffer.from(m[2] || '', 'base64') };
							})
							.filter((f) => f.buffer.length);
						if (!files.length) {
							await done(false);
							continue;
						}
						const input = page.locator('input[type="file"]').first();
						await input.setInputFiles(files);
						await done(true);
						log('[守护] 真实文件上传 ' + files.length + ' 张');
					} catch (e) {
						console.log('[守护] 文件上传失败: ' + String(e).slice(0, 80));
						await done(false);
					}
				}
			}
		} catch {}
		uploadBusy = false;
	}, 400);

	// 3) 问卷任务：跨域问卷帧（mobilelearn.chaoxing.com）只有 CDP 能进，
	//    页面脚本经 top.__voteTask 请求本守护进程代劳（读题→千问AI→代填→提交）
	setInterval(async () => {
		try {
			for (const page of ctx.pages()) {
				if (!/studentstudy/.test(page.url())) continue;
				let task = null;
				try { task = await page.evaluate(() => window.__voteTask || null); } catch { continue; }
				if (!task || task.cmd !== 'start' || task.taking || task.done) continue;
				await page.evaluate(() => { window.__voteTask.taking = true; }).catch(() => {});
				log('[守护] 接手问卷任务');
				voteFlow(page).catch(async (e) => {
					log('[守护] 问卷失败: ' + (e && e.message));
					await page.evaluate((m) => { window.__voteTask = { cmd: 'error', error: String(m).slice(0, 120) }; }, (e && e.message) || e).catch(() => {});
				});
			}
		} catch {}
	}, 2000);

	// 4) 千问页内存水位线：对话 DOM 只增不删（图片缩略图+公式渲染），
	//    单标签 JS 堆超 300MB 就整页刷新到新对话——对话废弃时旧 DOM 随导航丢弃。
	//    时序策略：正在答题（data-ocs-bridge 处于进行中阶段）绝不刷新；
	//    题目间隙（done/error/无任务）立即刷新——刷新约 2~3 秒，
	//    排队的问题由 3 秒题间冷却自然延迟，晚几秒到达无影响。
	//    高频巡检（10s）保证空闲窗口一出现就被利用，不会一直被排队问题抢占
	const IDLE_PHASES = ['done', 'error', ''];
	let memBusy = false;
	setInterval(async () => {
		if (memBusy) return;
		memBusy = true;
		try {
			const qws = ctx.pages().filter((p) => /qianwen\.com/.test(p.url()));
			for (const p of qws) {
				const heapMB = await p.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576)).catch(() => -1);
				if (heapMB <= 300) continue;
				// 桥接状态：进行中则本轮不动；空闲（done/error/无状态）立即刷
				let phase = '';
				try {
					const attr = await p.evaluate(() => document.documentElement.getAttribute('data-ocs-bridge') || '');
					phase = attr ? ((JSON.parse(attr).phase || '') + '').toLowerCase() : '';
				} catch {}
				if (BUSY_PHASES.includes(phase)) {
					log('[守护] 千问页堆 ' + heapMB + 'MB 超水位线，正在答题，等题目间隙');
					continue;
				}
				if (!IDLE_PHASES.includes(phase)) continue; // 未知状态不冒险
				log('[守护] 千问页堆 ' + heapMB + 'MB 超水位线，题目间隙刷新释放（排队问题将顺延几秒）');
				await p.evaluate(() => { location.href = 'https://www.qianwen.com/chat'; }).catch(() => {});
				await new Promise((r) => setTimeout(r, 8000));
			}
		} catch {}
		memBusy = false;
	}, 10000);

	// 5) AI 页「站点 + 数量」实时维持：多关（只关空闲页）少补。
	//    覆盖「切换 AI 接入方式」「重复点一键启动」「手动关掉一个」
	//    「浏览器恢复上次会话导致堆积」四种情况。
	//    10 秒一轮：切换设置后最多 10 秒页面就跟着变。
	setInterval(() => {
		syncAIPages(ctx).catch(() => {});
	}, 10000);

	// 2) 千问页鼠标闲逛：随机 20~45 秒一次，随机挑一个千问页划几笔
	setInterval(async () => {
		try {
			const qws = ctx.pages().filter((p) => /qianwen\.com/.test(p.url()));
			if (!qws.length) return;
			const p = qws[Math.floor(Math.random() * qws.length)];
			const baseX = 300 + Math.random() * 500;
			const baseY = 200 + Math.random() * 400;
			const steps = 3 + Math.floor(Math.random() * 3);
			for (let i = 0; i < steps; i++) {
				await p.mouse.move(
					baseX + (Math.random() - 0.5) * 220,
					baseY + (Math.random() - 0.5) * 160,
					{ steps: 4 + Math.floor(Math.random() * 6) }
				);
				await new Promise((r) => setTimeout(r, 120 + Math.random() * 280));
			}
		} catch {}
	}, 25000 + Math.random() * 20000);
}

/* ── 问卷代填：读题→千问AI（走同一桥接协议）→代填→提交 ── */
async function voteFlow(page) {
	// 等问卷题面帧（跨域，Playwright 可进）
	let vf = null;
	for (let i = 0; i < 20 && !vf; i++) {
		await new Promise((r) => setTimeout(r, 1500));
		vf = page.frames().find((f) => /answerQuestionChapter|questionnaire/.test(f.url()));
	}
	if (!vf) throw new Error('未找到问卷题面帧');
	const questions = await vf.evaluate(() => {
		return Array.from(document.querySelectorAll('.question-list')).map((q) => {
			const typeEl = q.querySelector('.topic-type');
			const type = /多选/.test((typeEl && typeEl.textContent) || '') ? 'multiple' : 'single';
			return {
				type,
				title: ((q.querySelector('.topic-txt') || {}).textContent || '').trim(),
				options: Array.from(q.querySelectorAll('li.topic-option-list')).map((li) => (li.textContent || '').replace(/\s+/g, ' ').trim())
			};
		});
	});
	log('[守护] 问卷读题 ' + questions.length + ' 道');
	// 逐题 AI 作答（走学习页的桥接协议，千问标签页会认领）
	const answers = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const letters = q.options.map((_, j) => String.fromCharCode(65 + j));
		const prompt =
			'请解答这道' + (q.type === 'multiple' ? '多选' : '单选') + '题（课程问卷调查，没有标准答案，给出合理选择即可）。\n\n题目：' +
			q.title + '\n' + q.options.map((o, j) => letters[j] + ' ' + o).join('\n') +
			'\n\n只输出答案\n注意：只回答我这个问题，不要多想其他的。最后必须单独一行「最终答案：X」（单选一个字母，多选字母组合如 AB）。';
		const ans = await askAI(page, prompt, 'q' + i);
		const m = ans.match(/最终答案[：:]\s*([A-Za-z]{1,6})/);
		let pick = (m ? m[1] : 'A').toUpperCase().split('');
		pick = pick.filter((L) => L.charCodeAt(0) - 65 < q.options.length);
		if (!pick.length) pick = ['A'];
		answers.push(pick);
		log('[守护] 问卷Q' + (i + 1) + ' → ' + pick.join(''));
	}
	// 代填
	await vf.evaluate((answers) => {
		const lists = Array.from(document.querySelectorAll('.question-list'));
		lists.forEach((q, i) => {
			const picks = answers[i] || ['A'];
			const opts = Array.from(q.querySelectorAll('li.topic-option-list'));
			picks.forEach((L) => {
				const opt = opts[L.charCodeAt(0) - 65];
				if (opt) (opt.querySelector('input') || opt).click();
			});
		});
	}, answers).catch(() => {});
	await new Promise((r) => setTimeout(r, 1200));
	// 提交 + 可能的确认弹层
	await vf.evaluate(() => {
		const b = Array.from(document.querySelectorAll('button, a, div[onclick], input')).find((x) => (x.textContent || x.value || '').trim() === '提交');
		if (b) b.click();
	}).catch(() => {});
	await new Promise((r) => setTimeout(r, 1800));
	await vf.evaluate(() => {
		const b = Array.from(document.querySelectorAll('button, a')).find((x) => /^(确定|确认)$/.test((x.textContent || '').trim()) && x.getBoundingClientRect().width > 0);
		if (b) b.click();
	}).catch(() => {});
	await new Promise((r) => setTimeout(r, 2000));
	// 收尾：隐藏弹层、回报完成
	await page.evaluate(() => {
		try {
			const vc = document.querySelector('.voteContainer');
			if (vc) vc.style.display = 'none';
			window.__voteTask = { cmd: 'done', done: true };
		} catch {}
	}).catch(() => {});
	log('[守护] 问卷已提交');
}

/** 经学习页的 GM 桥接协议向千问提问并等答案 */
async function askAI(page, text, tag) {
	const id = 'vote_' + tag + '_' + Date.now();
	try {
		await page.evaluate(({ id, text }) => {
			const queue = JSON.parse(String(GM_getValue('ai_bridge_queue', '{}')) || '{}');
			queue[id] = { id, text, images: [], site: 'qianwen', timestamp: Date.now() };
			GM_setValue('ai_bridge_queue', JSON.stringify(queue));
			GM_setValue('ai_bridge_knock', String(Date.now()));
		}, { id, text });
	} catch (e) {
		return '';
	}
	for (let i = 0; i < 75; i++) {
		await new Promise((r) => setTimeout(r, 2000));
		const raw = await page.evaluate((id) => String(GM_getValue('ai_bridge_answer_' + id, '')), id).catch(() => '');
		if (raw) {
			await page.evaluate((id) => {
				try {
					GM_deleteValue('ai_bridge_answer_' + id);
					const q = JSON.parse(String(GM_getValue('ai_bridge_queue', '{}')) || '{}');
					delete q[id];
					GM_setValue('ai_bridge_queue', JSON.stringify(q));
				} catch {}
			}, id).catch(() => {});
			try {
				return JSON.parse(raw).answer || '';
			} catch (e) {
				return raw;
			}
		}
	}
	return '';
}

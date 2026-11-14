import { $, h, $message, $ui, Script } from 'easy-us';
import { createDefaultQuestionResolver, defaultAnswerWrapperHandler, SearchInformation } from '@ocsjs/core';
import { CommonProject } from './common';
import { aiWorkAnswerer, getAIConfig, isAIEnabled, optimizationElementWithImage, trustedClick } from '../utils/work';

/**
 * 雨课堂「课堂实时答题」
 *
 * 与超星作业页（整卷批量）不同，课堂题是老师推一道、限时、提交后不可改：
 *  - 题目随课件提前下发，unlockproblem 只是「解锁可答」→ 支持预答题
 *  - 页面上同时只应有一道「当前题」，历史题只在 timeline 里（不可见）
 *  - 一旦答错不可撤销，所以默认「提交前校验已选中项」，空选绝不提交
 *
 * 页面结构没有官方文档，选择器全部按候选 + 结构启发式匹配，
 * 匹配过程写入 localStorage（面板可导出），用于改版后快速定位。
 */

const LOG_KEY = 'ocs_ykt_lesson_log';
const LOG_MAX = 500;

/** 选项候选选择器：2024 版为 .options-label[data-option]，其余为常见变体 */
const OPTION_SELECTOR = '[data-option], .options-label, .option-item, .problem-option, .choice-item';

/** 提交按钮文案 */
const SUBMIT_TEXT = /^(提交|提交答案|确定|确认|交卷|保存|submit)$/i;

/**
 * 课堂页「课堂动态」时间线容器（2026-10-19/22 实测）：
 * 里面会渲染已推题目的缩略预览，同样带 .options-label[data-option] 选项。
 * ⚠️ 不能用 .lesson__cards 排除——那是整个课堂布局的容器（主放映区也在里面），
 * 用它会把真题全部误杀（10-22 实测：整整一题因此没识别）。时间线只认 cards__nav。
 */
const SIDEBAR_SELECTOR = '[class*="cards__nav"]';

/** 题目作答已结束的标志文案（结束后再点提交无效，也别浪费 AI 调用） */
const ENDED_TEXT = /作答已结束|已结束作答|答题已结束/;

function inSidebar(el: Element | null): boolean {
	try {
		return !!el && !!el.closest(SIDEBAR_SELECTOR);
	} catch {
		return false;
	}
}

/** 题面可能全在 PPT 截图里：题干图 = 不在选项内的较大可见图 */
function hasStemImage(el: HTMLElement, opts: HTMLElement[]): boolean {
	const optImgs = new Set<Element>();
	for (const o of opts) for (const im of Array.from(o.querySelectorAll('img'))) optImgs.add(im);
	return Array.from(el.querySelectorAll('img')).some(
		(im) => !optImgs.has(im) && isVisible(im) && (im.naturalWidth >= 200 || im.width >= 200)
	);
}

type PLevel = 'info' | 'warn' | 'error' | 'success';

/** 截断任意数据，避免把大对象写进日志 */
function clip(d: any, max = 600): string {
	try {
		const s = typeof d === 'string' ? d : JSON.stringify(d);
		if (!s) return '';
		return s.length > max ? s.slice(0, max) + '…' : s;
	} catch {
		return String(d);
	}
}

function log(level: PLevel, msg: string, data?: any, max = 600) {
	try {
		const arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
		arr.push({ t: Date.now(), level, msg, data: data === undefined ? undefined : clip(data, max) });
		while (arr.length > LOG_MAX) arr.shift();
		localStorage.setItem(LOG_KEY, JSON.stringify(arr));
	} catch {
		/* 存储不可用时静默 */
	}
	// 控制台只输出短文本：本项目禁止让大对象整段进对话上下文
	console.log('[雨课堂课堂]', msg, data === undefined ? '' : clip(data, 160));
}

function isVisible(el: Element | null): el is HTMLElement {
	if (!el || !(el instanceof HTMLElement) || !el.isConnected) return false;
	const r = el.getBoundingClientRect();
	if (r.width < 2 || r.height < 2) return false;
	const st = getComputedStyle(el);
	return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
}

function textOf(el: Element | null): string {
	if (!el) return '';
	return (el as HTMLElement).innerText || el.textContent || '';
}

/**
 * 取「脱离文档」元素的文本（clone 节点没有布局，innerText 可能为空）
 */
function detachedText(el: Element | null): string {
	if (!el) return '';
	const inner = (el as HTMLElement).innerText;
	if (inner && inner.trim()) return inner;
	return el.textContent || '';
}

/** 收集指定范围内可见的选项元素 */
function collectOptionsIn(scope: ParentNode): HTMLElement[] {
	const out: HTMLElement[] = [];
	for (const el of Array.from(scope.querySelectorAll<HTMLElement>(OPTION_SELECTOR))) {
		if (isVisible(el)) out.push(el);
	}

	// 兜底：没有 class 线索时，用 radio/checkbox 的包裹元素
	if (out.length < 2) {
		for (const input of Array.from(
			scope.querySelectorAll<HTMLElement>('input[type="radio"], input[type="checkbox"]')
		)) {
			if (!isVisible(input)) continue;
			const wrap = (input.closest('label') || input.parentElement) as HTMLElement | null;
			if (wrap && isVisible(wrap)) out.push(wrap);
		}
	}

	// 去重：只保留最外层（避免 label 与内部 span 重复计数）
	const uniq: HTMLElement[] = [];
	for (const el of out) {
		if (uniq.some((u) => u === el || u.contains(el))) continue;
		for (let i = uniq.length - 1; i >= 0; i--) {
			if (el.contains(uniq[i])) uniq.splice(i, 1);
		}
		uniq.push(el);
	}
	return uniq;
}

/** 收集页面上可见的选项元素 */
function collectOptions(): HTMLElement[] {
	return collectOptionsIn(document);
}

/** 判断一个容器是否像「完整题目」（有 >=2 个选项，且选项之外还有题干文字或题干图） */
function isProblemRoot(el: HTMLElement): boolean {
	// 必须用与 collectOptions 相同的判定，否则 radio/label 结构会被漏掉
	const opts = collectOptionsIn(el);
	if (opts.length < 2) return false;
	let rest = el.innerText || '';
	for (const o of opts) {
		const t = textOf(o);
		if (t) rest = rest.replace(t, '');
	}
	if (rest.replace(/\s/g, '').length >= 4) return true;
	// 实测课堂题题面是一张 PPT 截图：去掉选项后文本可能只剩「已完成」徽标，
	// 只要容器里有题干图就认（否则真题永远过不了这道门）
	return hasStemImage(el, opts);
}

/** 找出当前页面上所有「题目容器」，按 DOM 顺序返回 */
function findProblemRoots(): HTMLElement[] {
	const roots: HTMLElement[] = [];
	const seen = new Set<HTMLElement>();

	for (const opt of collectOptions()) {
		// 侧边栏缩略预览不是可答题，整条跳过
		if (inSidebar(opt)) continue;
		let cur: HTMLElement | null = opt.parentElement;
		for (let i = 0; i < 9 && cur; i++) {
			if (isProblemRoot(cur)) {
				if (!seen.has(cur)) {
					seen.add(cur);
					roots.push(cur);
				}
				break;
			}
			cur = cur.parentElement;
		}
	}

	// 去掉互相包含的容器，只留最内层
	return roots.filter((r) => !roots.some((o) => o !== r && r.contains(o)));
}

/** 克隆题干区域（去掉选项/按钮），保留 img 供 AI 提取图片 */
/** 倒计时/计时元素（必须从题干里剔除，否则秒数变化会让题目 key 每秒都变） */
const TIMER_SELECTOR =
	'[class*="countdown"], [class*="timer"], [class*="remain"], [class*="left-time"], [class*="leftTime"], [class*="clock"], [class*="cd-text"], [class*="answer-time"]';

/**
 * 清洗题干里的倒计时文案。
 * 双层防护：buildStemEl 按 class 删元素（只删得有 class 线索的），这里按文本兜底
 * （对付纯 `<span>剩余 12 秒</span>` 这种没 class 的）。
 * 不清的话，秒数每秒变化会让题目 key 每秒都变 → 同一题被反复当新题处理。
 */
function cleanStemText(text: string): string {
	return text
		// 状态徽标不是题面：课堂题容器里常驻「已完成/进行中」等徽标，
		// 不清掉会污染 AI 提示词、还会让 key 随状态切换变化
		.replace(/(已完成|已提交|进行中|已结束|已作答|已抢答)/g, '')
		// 倒计时占位符「--:--」没有数字，上面的规则吃不掉；不解的话
		// 解锁瞬间占位符变真数字会让 key 变化 → 白白发一次 AI
		.replace(/[-—–]+[:：][-—–]*/g, '')
		// 三种前缀统一处理；数字部分是**必选**的（否则"倒计时题"里的"倒计时"会被误删），
		// mm:ss 放前面优先匹配，不然 \d{1,3} 只吃到 "00" 留下 ":45"
		.replace(/(?:剩余|倒计时|还剩)\s*[:：]?\s*(?:\d{1,2}:\d{2}|\d{1,3}\s*(?:秒|s)?)/gi, '')
		.replace(/\d{1,2}:\d{2}/g, '')
		.replace(/\n{2,}/g, '\n')
		.trim();
}

function buildStemEl(root: HTMLElement): HTMLElement {
	const clone = root.cloneNode(true) as HTMLElement;
	const killers = [
		OPTION_SELECTOR,
		TIMER_SELECTOR,
		'label',
		'input',
		'textarea',
		'button',
		'script',
		'style',
		'[class*="submit"]'
	].join(',');
	for (const el of Array.from(clone.querySelectorAll(killers))) {
		el.remove();
	}
	return clone;
}

function isJudgementLike(texts: string[]): boolean {
	const norm = texts.map((t) =>
		t
			.replace(/^[A-Za-z][.、．:：]\s*/, '')
			.replace(/\s+/g, '')
			.trim()
	);
	if (norm.length !== 2) return false;
	const yes = /^(对|正确|是|√|✓|true|t)$/i;
	const no = /^(错|错误|否|×|✗|false|f)$/i;
	return (yes.test(norm[0]) && no.test(norm[1])) || (no.test(norm[0]) && yes.test(norm[1]));
}

/**
 * 判断题型 —— 但雨课堂课堂题的题型**不可信**，只用于日志和填空题识别。
 *
 * 实测（2026-10-26）：
 *   页面上 `MultipleChoice` 这个 class **单选多选都有**，用它判多选会把单选误判成多选
 *   （用户实测：除了第一题真是多选，后面全是单选，却全被标成 multiple）。
 *   页面也没有 input[type=checkbox]、没有 Vue 数据字段、没有 multiple/single 属性。
 *
 * 结论：题型只能交给 AI 自己从图片里判断。
 * 这里返回的 type 仅用于：
 *   ① 判断题（选项就是"对/错"）—— 可靠
 *   ② 填空题（有 textarea/input）—— 可靠
 *   ③ 其余一律给 'single' 当"选择题"占位，真正的答案个数由 AI 决定，
 *      回填时按 AI 给出的字母个数走多选/单选（见 fill()）。
 */
function detectType(
	optionEls: HTMLElement[],
	optionTexts: string[],
	root: HTMLElement
): 'single' | 'multiple' | 'judgement' | 'completion' {
	if (isJudgementLike(optionTexts)) return 'judgement';
	if (root.querySelector('textarea, input[type="text"]')) return 'completion';
	// 选择题（单选/多选不可辨）统一返回 single，实际按 AI 答案字母数决定点击几个
	return 'single';
}

function findSubmitButton(scope: ParentNode): HTMLElement | null {
	const scan = (root: ParentNode) => {
		for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, [class*="submit"], [class*="btn"], a'))) {
			if (!isVisible(el)) continue;
			// 侧边栏缩略预览里的提交状按钮不算（预览也可能带按钮样式的元素）
			if (inSidebar(el)) continue;
			const t = textOf(el).trim();
			if (SUBMIT_TEXT.test(t)) return el;
		}
		return null;
	};
	return scan(scope) || (scope !== document ? scan(document) : null);
}

function isSelected(el: HTMLElement): boolean {
	const input = el.matches('input') ? (el as HTMLInputElement) : el.querySelector('input');
	if (input && (input as HTMLInputElement).checked) return true;
	const cls = typeof el.className === 'string' ? el.className : '';
	if (/(^|\s)(active|selected|checked|is-checked|is-selected)(\s|$)/.test(cls)) return true;
	return el.getAttribute('aria-checked') === 'true';
}

async function clickOption(el: HTMLElement) {
	const target = (el.matches('label') ? el : el.closest('label') || el.querySelector('label') || el) as HTMLElement;
	const ok = await trustedClick(target);
	if (!ok) {
		target.click();
	}
	await $.sleep(180);
}

function hashKey(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return String(h >>> 0);
}

/** 解析时间文本为剩余秒数：支持 "剩余 12 秒" / "12s" / "00:12" / "1:05" */
function parseRemainText(raw: string): number | null {
	const t = raw.trim();
	if (!t || t.length > 20) return null;
	// mm:ss 优先——"剩余 00:12" 里开头的 00 不是秒数
	let m = t.match(/(\d{1,2}):(\d{2})/);
	if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
	m = t.match(/(?:剩余|倒计时|还剩)\s*[:：]?\s*(\d{1,3})\s*(?:秒|s)?/i);
	if (m) return parseInt(m[1], 10);
	m = t.match(/^(\d{1,3})\s*(?:秒|s)$/i);
	if (m) return parseInt(m[1], 10);
	return null;
}

/**
 * 读当前题目的剩余作答秒数（读不到返回 null）
 * 三级线索：先看 class（countdown/timer/remain…，避免题干里"剩余"字样误判），
 * 再看雨课堂课堂题的倒计时容器（实测 2026-10：`.time-box > .timing`，文案「倒计时 00:22」），
 * 最后扫题目容器内的短文本（必须含"剩余/倒计时/还剩"）。
 *
 * ⚠️ 旧代码只扫 countdown/timer/remain 等 class，而雨课堂用的是 `.time-box`/`.timing`，
 *    一个都不匹配 → 每道题都报「未检测到倒计时元素」，倒计时兜底（剩余≤5s 强选）永远不生效。
 */
function readRemainSeconds(root: HTMLElement): number | null {
	const sel = [
		'[class*="countdown"]',
		'[class*="timer"]',
		'[class*="remain"]',
		'[class*="left-time"]',
		'[class*="leftTime"]',
		'[class*="clock"]',
		// 雨课堂课堂题（2026-10 实测）：.time-box 容器 + .timing 文案
		'.time-box',
		'.timing'
	].join(', ');
	for (const scope of [root, document.body]) {
		if (!scope) continue;
		for (const el of Array.from(scope.querySelectorAll<HTMLElement>(sel))) {
			if (!isVisible(el)) continue;
			const v = parseRemainText(textOf(el));
			if (v !== null) return v;
		}
	}
	for (const el of Array.from(root.querySelectorAll<HTMLElement>('span, div, p, i, b'))) {
		const t = textOf(el).trim();
		if (!t || t.length > 16 || !/(剩余|倒计时|还剩)/.test(t)) continue;
		// 排除「剩余电量 50%」「剩余次数 2」这类非倒计时文案
		if (/%|次|题|人/.test(t)) continue;
		const v = parseRemainText(t);
		if (v !== null) return v;
	}
	return null;
}

interface Detected {
	root: HTMLElement;
	stemEl: HTMLElement;
	title: string;
	optionEls: HTMLElement[];
	optionTexts: string[];
	submitBtn: HTMLElement | null;
	type: 'single' | 'multiple' | 'judgement' | 'completion';
	key: string;
}

function detect(): Detected | null {
	const roots = findProblemRoots();
	if (!roots.length) return null;

	// 取最后一个（DOM 顺序最后 = 最新推送的题）
	const root = roots[roots.length - 1];
	const optionEls = collectOptionsIn(root);
	if (optionEls.length < 2) return null;

	// 选项文本（带图片 URL，便于 AI 读到图片题）
	const optionTexts = optionEls.map((el) =>
		detachedText(optimizationElementWithImage(el, true)).trim()
	);

	// 题干从「去掉选项后的克隆」计算：既避开 detached 元素的 innerText 差异，
	// 也不会把提交按钮/选项文字混进题干（实测会污染提示词）
	const stemEl = buildStemEl(root);
	// 题面可能是 PPT 截图（2026-10 实测）：把 img.src 注入成隐藏文本，
	// 题干文本才有图 URL（key 稳定 + AI 端能拿到题面）
	optimizationElementWithImage(stemEl, false);
	let title = cleanStemText(detachedText(stemEl));
	// 纯图题：题面全在图里，去掉状态徽标后文本可能为空——有题干图就放行
	if (title.length < 4 && !hasStemImage(root, optionEls)) return null;

	const submitBtn = findSubmitButton(root);
	const type = detectType(optionEls, optionTexts, root);

	return {
		root,
		stemEl,
		title,
		optionEls,
		optionTexts,
		submitBtn,
		type,
		key: hashKey(title + '|' + optionTexts.join('|'))
	};
}

export function createLessonAnswerScript() {
	return new Script({
		name: '🎯 课堂答题',
		matches: [['雨课堂页面', /.*/]],
		namespace: 'yuketang.lesson.answer',
		configs: {
			notes: {
				defaultValue: $ui.notes([
					'老师上课推题时自动作答；题目解锁前先算好答案（预答题），解锁后立即提交。',
					'⚠️ 课堂题通常限时。网页桥接（千问）单题要 10~40 秒，容易超时；建议在【全局设置】里改用官方 API 模式（2~5 秒）。',
					'⚠️ 课堂题提交后不可修改，请确认答案质量后再开启自动提交。',
					'日志可导出（含首次题目的 DOM 快照），雨课堂改版时用它定位结构变化。'
				]).outerHTML
			},
			enable: {
				label: '自动答题',
				attrs: { type: 'checkbox', title: '检测到课堂题目时自动作答' },
				defaultValue: true
			},
			autoSubmit: {
				label: '自动提交',
				attrs: { type: 'checkbox', title: '填完答案后自动点击提交（提交后不可修改）' },
				defaultValue: true
			},
			preAnswer: {
				label: '预答题',
				attrs: {
					type: 'checkbox',
					title: '题目已显示但还没解锁（无提交按钮）时先算答案，解锁后直接提交'
				},
				defaultValue: true
			},
			interval: {
				label: '检测间隔(ms)',
				defaultValue: 600,
				attrs: { type: 'number', title: '页面轮询间隔，越小越灵敏、CPU 占用越高' }
			}
		},
		async oncomplete() {
			const self = this;

			// 课后回顾页：外层 student-lesson-report + 内层 iframe /m/v2/lesson/student/{id}/overview
			// 实测：题目只是 PPT 截图，没有可交互选项；review 接口的 problem 只有元数据
			// （problemId/cover/score/correct/answered），没有题干/选项/答案。
			// 这里保持静默，避免面板和 600ms 轮询造成干扰。
			if (
				/student-lesson-report/.test(location.href) ||
				/\/m\/v2\/lesson\/student\/[^/]+\/overview/.test(location.href)
			) {
				return;
			}

			// 同一页面只启动一次（SPA 路由切换会重复触发 oncomplete）
			const flag = '__ocs_ykt_lesson_started';
			const w = window as any;
			if (w[flag]) return;
			w[flag] = true;

			// 只在课堂类页面置顶面板，避免在课程列表页抢走「课程学习」面板
			const likelyLesson = /lesson|classroom|presentation|studentLog|studycontent/i.test(location.href);
			if (likelyLesson) CommonProject.scripts.render.methods.pin(this);

			const statusEl = h('div', {
				style: { marginTop: '8px', fontSize: '12px', opacity: '0.85', lineHeight: '1.5' }
			}, '等待课堂题目…');

			const logCountEl = h('span', { style: { opacity: '0.6', fontSize: '11px' } }, '');

			const refreshLogCount = () => {
				try {
					const n = (JSON.parse(localStorage.getItem(LOG_KEY) || '[]') as any[]).length;
					logCountEl.textContent = `日志 ${n} 条`;
				} catch {
					logCountEl.textContent = '';
				}
			};

			const exportBtn = $ui.button('📤 导出日志');
			exportBtn.onclick = () => {
				try {
					const data = localStorage.getItem(LOG_KEY) || '[]';
					const blob = new Blob([data], { type: 'application/json' });
					const a = document.createElement('a');
					a.href = URL.createObjectURL(blob);
					a.download = `ykt-lesson-log-${Date.now()}.json`;
					a.click();
					setTimeout(() => URL.revokeObjectURL(a.href), 3000);
					$message.success('日志已导出');
				} catch (e) {
					$message.error('导出失败：' + String(e));
				}
			};

			const clearBtn = $ui.button('🗑 清空日志');
			clearBtn.onclick = () => {
				localStorage.removeItem(LOG_KEY);
				refreshLogCount();
				$message.info('日志已清空');
			};

			[exportBtn, clearBtn].forEach((b) => {
				b.style.flex = '1';
				b.style.padding = '4px';
				b.style.marginRight = '4px';
			});

			const extra = h('div', { style: { marginTop: '12px' } }, [
				statusEl,
				h('div', { style: { display: 'flex', marginTop: '8px' } }, [exportBtn, clearBtn]),
				h('div', { style: { marginTop: '6px', textAlign: 'right' } }, [logCountEl])
			]);

			const attach = () => {
				const body = self.panel?.body;
				if (body && !body.contains(extra)) body.appendChild(extra);
				refreshLogCount();
			};
			self.on('render', attach);
			attach();

			if (!isAIEnabled()) {
				statusEl.textContent = '⚠️ 当前是题库模式，AI 答题未启用（全局设置 → 答题方式 → AI 模式）';
				$message.warn({ content: '课堂答题需要 AI 模式，请到全局设置切换答题方式', duration: 8 });
			}

			const cfg = self.cfg;
			const aiCfg = getAIConfig();
			if (aiCfg.endpoint.startsWith('bridge://')) {
				log('warn', '当前为网页桥接模式，课堂限时题可能来不及；建议改用官方 API');
			}

			const ctx = {
				processing: false,
				pinned: false,
				done: new Set<string>(),
				preAnswered: new Set<string>(),
				attempts: new Map<string, number>(),
				/** 已被倒计时兜底抢先提交的题（AI 返回后不能再覆盖） */
				aborted: new Set<string>(),
				cache: new Map<string, SearchInformation[]>(),
				/** AI 空答案退避：上次拿不到答案的时间（同题 15s 内不重问） */
				emptyAt: new Map<string, number>(),
				snapshotTaken: false,
				status: (s: string) => {
					statusEl.textContent = s;
				}
			};

			const answerSeparators = ['\n', ',', '，', ';', '；', '、', ' '];

			/** 选项是否只是裸字母（A/B/C/D）——内容全在图上的雨课堂课堂题就是这种形态 */
			const letterOnly = (texts: string[]) => texts.length >= 2 && texts.every((t) => /^[A-Za-z]{1,2}$/.test(t.trim()));

			/**
			 * 雨课堂课堂题：**整道题就是一张 PPT 截图**——题干、选项字母 A/B/C/D、
			 * 选项内容全在同一张图里。
			 *
			 * 这种情况不需要按选项裁剪、也不需要画字母角标（图里本来就有字母），
			 * 直接把这**一张图**发过去就行。判据（任一成立即认为是整题图）：
			 *  1. 选项区域几何上落在某张可见大图范围内（选项覆盖在截图上）
			 *  2. 大图与选项区域纵向、横向都高度重叠（选项紧贴在截图下方）
			 * 选项元素内部自带图片时不算（那是「选项各有配图」的常规题）。
			 */
			const findWholeQuestionShot = (p: Detected): HTMLImageElement | null => {
				if (!letterOnly(p.optionTexts)) return null;
				const rs = p.optionEls.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 2 && r.height > 2);
				if (rs.length < 2) return null;
				const bb = {
					left: Math.min(...rs.map((r) => r.left)),
					right: Math.max(...rs.map((r) => r.right)),
					top: Math.min(...rs.map((r) => r.top)),
					bottom: Math.max(...rs.map((r) => r.bottom))
				};
				const optImgs = new Set<Element>();
				for (const o of p.optionEls) for (const im of Array.from(o.querySelectorAll('img'))) optImgs.add(im);

				// 只考察「够大的题面图」，并把几何关系记下来，最后统一记一条日志（避免每题刷屏）
				let probe: any = null;
				for (const im of Array.from(p.root.querySelectorAll<HTMLImageElement>('img'))) {
					if (optImgs.has(im) || !isVisible(im) || im.naturalWidth < 200) continue;
					const r = im.getBoundingClientRect();
					if (r.width < 100 || r.height < 60) continue;
					const padX = r.width * 0.03;
					const padY = r.height * 0.03;
					const inside =
						bb.left >= r.left - padX &&
						bb.right <= r.right + padX &&
						bb.top >= r.top - padY &&
						bb.bottom <= r.bottom + padY;
					const ovY =
						(Math.min(bb.bottom, r.bottom) - Math.max(bb.top, r.top)) / Math.max(1, bb.bottom - bb.top);
					const ovX =
						(Math.min(bb.right, r.right) - Math.max(bb.left, r.left)) / Math.max(1, bb.right - bb.left);
					const adjacent = ovY >= 0.8 && ovX >= 0.8;
					if (!probe) {
						probe = {
							inside,
							adjacent,
							img: { w: Math.round(r.width), h: Math.round(r.height) },
							optBox: { w: Math.round(bb.right - bb.left), h: Math.round(bb.bottom - bb.top) },
							ovX: Math.round(ovX * 100) / 100,
							ovY: Math.round(ovY * 100) / 100
						};
					}
					if (inside || adjacent) {
						log('info', '判定为整题一张图（只发这张图）', {
							inside,
							adjacent,
							img: { w: Math.round(r.width), h: Math.round(r.height) },
							ovX: Math.round(ovX * 100) / 100,
							ovY: Math.round(ovY * 100) / 100
						});
						return im;
					}
				}
				log('info', probe ? '题面图未覆盖选项，按常规路径发题' : '未找到足够大的题面图，按常规路径发题', probe || {});
				return null;
			};

			/**
			 * 只装这一张整题图的独立元素：提取器只会读到它，
			 * 不会顺带把页面上其它图标/徽标当成题目图片发出去。
			 */
			const buildShotElement = (img: HTMLImageElement): HTMLElement => {
				const box = document.createElement('div');
				const c = document.createElement('img');
				c.src = img.currentSrc || img.src;
				box.appendChild(c);
				return box;
			};

			/**
			 * 与学习通作业/考试同一条答题链路（cx.answerer 的同款逻辑）：
			 *  - 全局设置开了 AI → aiWorkAnswerer（自动提取题干/选项图片）
			 *  - 否则 → 走用户配置的题库 answererWrappers 搜索
			 *
			 * 雨课堂课堂题的形态：**整道题就是一张 PPT 截图**
			 * （题干 + 选项 A/B/C/D + 选项内容全在同一张图里）。
			 * 这时只发这一张图，不裁剪、不画角标——图里本来就有字母。
			 */
			const askAI = async (p: Detected): Promise<SearchInformation[]> => {
				ctx.status(`答题中（${p.type}，${p.optionEls.length} 选项）…`);
				const t0 = Date.now();
				const wholeShot = findWholeQuestionShot(p);

				let infos: SearchInformation[];
				if (isAIEnabled()) {
					if (wholeShot) {
						// 整题一张图：只发这张图。optionStartIndex 传 Infinity
						// → 任何图都不当"选项图"，不画红色字母角标（图里已有字母，再画会误导）
						// omitType: true → 提示词里不提"单选题/多选题"，由 AI 自己判断该答几个字母
						// 注意：buildQuestionPrompt 会自动加「本题的问题是：」前缀，
						// 所以 title 里不要再带这句，否则会出现两次。
						const note = '（题干与全部选项都在这一张图片里，请直接读图作答）';
						infos = await aiWorkAnswerer(
							getAIConfig(),
							{
								// 纯图题 p.title 可能为空（题面全在图里），此时只留说明，别留空标题
								title: p.title ? p.title + note : '请解答下面这张图片里的题目' + note,
								options: p.type === 'completion' ? [] : p.optionTexts,
								type: p.type,
								omitType: true
							},
							[buildShotElement(wholeShot)],
							undefined,
							Infinity
						);
						log('info', 'AI 返回（整题图）', {
							cost: Date.now() - t0,
							answers: infos.map((i) => i.results.map((r) => r.answer)).flat().slice(0, 6),
							type: p.type
						});
					} else {
						// 常规题（选项自带内容/文字选项）：题干 + 选项元素一起发，
						// optionStartIndex=1 让提取器给选项图片画字母角标
						infos = await aiWorkAnswerer(
							getAIConfig(),
							{
								title: p.title,
								options: p.type === 'completion' ? [] : p.optionTexts,
								type: p.type,
								omitType: true
							},
							[p.stemEl, ...p.optionEls],
							undefined,
							1
						);
						log('info', 'AI 返回', {
							cost: Date.now() - t0,
							answers: infos.map((i) => i.results.map((r) => r.answer)).flat().slice(0, 6),
							type: p.type
						});
					}
				} else {
					const wrappers = CommonProject.scripts.settings.cfg.answererWrappers;
					infos = await defaultAnswerWrapperHandler(wrappers, {
						type: p.type as any,
						title: p.title,
						options: p.type === 'completion' ? '' : p.optionTexts.join('\n')
					});
					log('info', '题库返回', {
						cost: Date.now() - t0,
						answers: infos.map((i) => i.results.map((r) => r.answer)).flat().slice(0, 6),
						type: p.type
					});
				}
				return infos;
			};

			/** AI 是否给出了可用答案（空答案不缓存，解锁后还能重问） */
			const hasAnswers = (infos: SearchInformation[]): boolean =>
				infos.some((i) => (i.results || []).some((r) => String(r.answer || '').trim().length > 0));

			/**
			 * 回填答案 —— 点击几个选项，完全由 AI 的答案决定。
			 *
			 * 雨课堂课堂题的题型在页面上**无法可靠判断**：
			 *   · 选项是 `<p data-option="A" class="options-label">A</p>`，没有 input[type=radio/checkbox]
			 *   · `MultipleChoice` 这个 class **单选多选都有**（用户实测：除了第一题真是多选，
			 *     后面全是单选，却全带 MultipleChoice）—— 用它判多选会把单选误判成多选
			 *   · 页面没有 Vue 数据、没有 multiple/single 属性
			 *
			 * 所以题型只能交给 AI：提示词里完全不提题型（omitType），
			 * AI 从图片判断该答几个字母，这里按字母个数决定点几个选项：
			 *   "BE"  → 点 B 和 E
			 *   "B"   → 只点 B
			 */
			const fill = async (p: Detected, infos: SearchInformation[]): Promise<number> => {
				const resolver = createDefaultQuestionResolver({
					answerSeparators
				} as any);

				// 从 AI 原始答案里数出「字母个数」，决定按多选还是单选回填
				const rawAnswers = infos
					.map((i) => (i.results || []).map((r) => String(r.answer || '')))
					.flat()
					.map((s) => s.trim())
					.filter(Boolean);
				// 去掉「最终答案：」之类前缀后，提取纯字母组合
				const letterSets = rawAnswers
					.map((s) => {
						const stripped = s.replace(/^.*?(?:最终答案|答案|结论|结果)\s*[:：]?\s*/, '').trim();
						const m = stripped.match(/^[A-Ha-h]{1,8}$/);
						return m ? m[0].toUpperCase() : '';
					})
					.filter(Boolean);
				// 取字母数最多的那个作为判据
				const maxLetters = letterSets.reduce((mx, s) => Math.max(mx, s.length), 0);
				const effectiveType =
					p.type === 'completion'
						? 'completion'
						: p.type === 'judgement'
						? 'judgement'
						: maxLetters > 1
						? 'multiple' // AI 给了多个字母 → 多选，每个字母都点
						: 'single';

				log('info', '回填方式', {
					aiAnswer: letterSets[0] || rawAnswers[0],
					letters: maxLetters,
					effectiveType
				});

				const handler = async (type: any, answer: any, option: any) => {
					if (!option) return;
					// 填空题：resolver 给的是输入框，点它没用，必须写值并触发事件
					if (type === 'completion') {
						const input = (option.matches?.('textarea, input')
							? option
							: option.querySelector?.('textarea, input')) as HTMLTextAreaElement | HTMLInputElement | null;
						if (input) {
							input.value = String(answer ?? '');
							input.dispatchEvent(new Event('input', { bubbles: true }));
							input.dispatchEvent(new Event('change', { bubbles: true }));
							await $.sleep(120);
						}
						return;
					}
					if (isVisible(option)) await clickOption(option);
				};
				await resolver[effectiveType](infos, p.optionEls, handler as any);
				await $.sleep(250);
				return p.optionEls.filter(isSelected).length;
			};

			const doSubmit = async (p: Detected) => {
				const btn = p.submitBtn;
				if (!btn) return false;
				const selected = p.optionEls.filter(isSelected).length;
				if (selected === 0) {
					log('warn', '未选中任何项，放弃提交');
					$message.warn({ content: '未选中任何项，放弃提交（防止空交）', duration: 5 });
					return false;
				}
				const ok = await trustedClick(btn);
				if (!ok) btn.click();
				log('success', '已点击提交', { selected, btn: textOf(btn).trim() });

				// 二次确认弹层：只在弹层容器内找「确定」，避免误点页面上无关按钮
				await $.sleep(1200);
				const dialog = document.querySelector(
					'[role="dialog"], .el-dialog, [class*="dialog"], [class*="modal"], [class*="popup"]'
				);
				if (dialog) {
					for (const el of Array.from(
						dialog.querySelectorAll<HTMLElement>('button, [class*="btn"], [class*="confirm"]')
					)) {
						if (!isVisible(el)) continue;
						const t = textOf(el).trim();
						if (/^(确定|确认|提交|是)$/.test(t)) {
							el.click();
							log('info', '已点确认弹层', t);
							break;
						}
					}
				}

				// 提交结果只做诊断记录，不重试——重复提交比漏交更危险
				await $.sleep(700);
				const stillVisible = p.root.isConnected && isVisible(p.root);
				if (stillVisible) {
					log('warn', '提交后题目仍在页面', { btnText: textOf(btn).trim() });
				} else {
					log('success', '题目已消失，提交成功');
				}
				return true;
			};

			/** 快速点击：有 CDP 守护进程走真实点击（通常 <200ms），没有就直接 JS 点击（避免 3 秒降级等待） */
			const quickClick = async (el: HTMLElement) => {
				const top: any = window.top;
				if (top && top.__cdpDaemon) {
					const ok = await trustedClick(el);
					if (!ok) el.click();
				} else {
					el.click();
				}
			};

			/**
			 * 倒计时兜底：剩余 ≤5 秒还没拿到答案，随便选一个交掉。
			 * 课堂题超时未交就是 0 分，蒙一个至少还有概率。
			 */
			const emergencySubmit = async (p: Detected, remain: number) => {
				ctx.aborted.add(p.key);
				// 优先第 3 个选项（C），不足 3 个就选最后一个
				const idx = p.optionEls.length >= 3 ? 2 : p.optionEls.length - 1;
				const target = p.optionEls[idx];
				log('warn', `倒计时兜底：剩余 ${remain}s 仍无答案，选第 ${idx + 1} 项提交`, {
					option: target ? textOf(target).slice(0, 40) : '(无)'
				});
				if (target) {
					await quickClick(target);
					await $.sleep(120);
				}
				const btn = p.submitBtn;
				if (!btn) return;
				await quickClick(btn);
				ctx.done.add(p.key);
				ctx.status(`倒计时兜底：已选第 ${idx + 1} 项并提交`);
				await $.sleep(500);
				// 快速点掉可能的二次确认
				const dialog = document.querySelector(
					'[role="dialog"], .el-dialog, [class*="dialog"], [class*="modal"]'
				);
				if (dialog) {
					for (const el of Array.from(dialog.querySelectorAll<HTMLElement>('button, [class*="btn"]'))) {
						if (!isVisible(el)) continue;
						if (/^(确定|确认|提交)$/.test(textOf(el).trim())) {
							el.click();
							break;
						}
					}
				}
				log('success', '倒计时兜底已完成提交');
			};

			const solve = async (p: Detected) => {
				// 作答已结束的题（老师关闭后留在放映区）：跳过，别浪费 AI 也别误点提交
				if (ENDED_TEXT.test(textOf(p.root))) {
					ctx.done.add(p.key);
					log('info', '题目已结束，跳过', { key: p.key });
					return;
				}
				// 题目还没解锁且没开预答题：不浪费 AI 额度
				if (!p.submitBtn && !cfg.preAnswer) return;

				ctx.status(`发现题目（${p.type}）：${p.title.slice(0, 24).replace(/\n/g, ' ')}`);
				log(
					'info',
					'发现题目',
					{
						type: p.type,
						title: p.title,
						options: p.optionTexts,
						hasSubmit: !!p.submitBtn,
						key: p.key
					},
					1200
				);

				// 首次发现题目时记录一次 DOM 快照，改版时用于定位结构
				if (!ctx.snapshotTaken) {
					ctx.snapshotTaken = true;
					log('info', 'DOM快照', p.root.outerHTML, 4000);
					// 顺便探一次倒计时：读不到说明兜底不会生效（可能只是还没渲染，日志里能看出来）
					const r0 = readRemainSeconds(p.root);
					log(
						r0 === null ? 'warn' : 'info',
						r0 === null ? '未检测到倒计时元素（倒计时兜底不可用，可能是刚渲染）' : '倒计时识别正常：剩余 ' + r0 + 's'
					);
				}

				let infos = ctx.cache.get(p.key);
				if (!infos) {
					// 空答案退避：上一次同题 15s 内拿不到答案就不重问（AI 桥接一问就是几十秒）
					const lastEmpty = ctx.emptyAt.get(p.key) || 0;
					if (Date.now() - lastEmpty < 15000) return;
					infos = await askAI(p);
					if (!hasAnswers(infos)) {
						ctx.emptyAt.set(p.key, Date.now());
						ctx.status('AI 没给出可用答案，15 秒后重试…');
						log('warn', 'AI 空答案，稍后重试', { key: p.key });
						return;
					}
					ctx.cache.set(p.key, infos);
				}

				// AI 等待期间可能已被倒计时兜底抢先提交，别再覆盖
				if (ctx.aborted.has(p.key) || ctx.done.has(p.key)) {
					log('info', '题目已被兜底提交，跳过本次回填', { key: p.key });
					return;
				}

				// 没有提交按钮 = 题目尚未解锁：只算答案，等解锁后再填
				if (!p.submitBtn) {
					if (cfg.preAnswer && !ctx.preAnswered.has(p.key)) {
						ctx.preAnswered.add(p.key);
						ctx.status('已预答，等待解锁…');
						log('info', '预答题完成，等待解锁', { key: p.key });
					}
					return;
				}

				const selected = await fill(p, infos);
				log('info', '回填完成', { selected, total: p.optionEls.length });

				if (selected === 0) {
					// 有限重试：AI 解析不出答案时重试也没用，避免 600ms 一次的死循环刷日志
					const n = (ctx.attempts.get(p.key) || 0) + 1;
					ctx.attempts.set(p.key, n);
					if (n >= 3) {
						ctx.done.add(p.key);
						ctx.status('回填失败，已放弃（详见日志）');
						log('error', '回填失败 3 次，放弃该题', { key: p.key });
					} else {
						ctx.status(`回填失败（第 ${n} 次），重试中…`);
					}
					return;
				}

				if (cfg.autoSubmit) {
					await doSubmit(p);
					ctx.done.add(p.key);
					ctx.status(`已提交（选中 ${selected} 项）`);
				} else {
					ctx.done.add(p.key);
					ctx.status('已填好，等你手动提交');
				}
			};

			const tick = async () => {
				if (!cfg.enable || ctx.processing) return;
				let p: Detected | null = null;
				try {
					p = detect();
				} catch (e) {
					log('error', '检测异常：' + String(e));
					return;
				}
				if (!p || ctx.done.has(p.key)) return;
				// 已预答但还没解锁：直接跳过（否则每 600ms 重复记一次「发现题目」，日志会被刷满）
				if (!p.submitBtn && ctx.preAnswered.has(p.key)) return;

				// 一旦真的检测到题目，就把面板置顶（不管当前是什么页面）
				if (!ctx.pinned) {
					ctx.pinned = true;
					try {
						CommonProject.scripts.render.methods.pin(self);
					} catch {}
				}

				ctx.processing = true;
				try {
					await solve(p);
				} catch (e: any) {
					log('error', '答题异常：' + (e && e.message ? e.message : String(e)));
					ctx.status('答题异常，详见日志');
				} finally {
					ctx.processing = false;
				}
			};

			const timer = setInterval(tick, Math.max(200, Number(cfg.interval) || 600));

			// 倒计时兜底：独立定时器（不受 AI 请求阻塞），剩余 ≤5 秒还没交就蒙一个
			let guardBusy = false;
			const guardTimer = setInterval(async () => {
				if (!cfg.enable || !cfg.autoSubmit || guardBusy) return;
				// 便宜预检：全局没有 6 秒内的倒计时就直接跳过。
				// 否则每 800ms 都做一次完整 detect（克隆题目 DOM + innerText），
				// 叠加主轮询和 iframe 双实例会把课堂页拖卡。
				const pre = readRemainSeconds(document.body);
				if (pre === null || pre > 6) return;

				guardBusy = true;
				try {
					const p = detect();
					if (!p || !p.submitBtn) return; // 还没解锁，不用兜底
					if (ctx.done.has(p.key) || ctx.aborted.has(p.key)) return;
					const remain = readRemainSeconds(p.root);
					if (remain === null || remain > 5) return;
					await emergencySubmit(p, remain);
				} catch (e: any) {
					log('error', '兜底异常：' + (e && e.message ? e.message : String(e)));
				} finally {
					guardBusy = false;
				}
			}, 800);

			window.addEventListener('beforeunload', () => {
				clearInterval(timer);
				clearInterval(guardTimer);
			});
			log('info', '课堂答题已启动（倒计时兜底：剩余≤5s 无答案则选 C 提交）', { url: location.href });
		}
	});
}

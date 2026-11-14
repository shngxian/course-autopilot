/**
 * AI 答题器模块
 *
 * 通过 Chat2API（OpenAI 兼容接口）调用 AI 模型获取题目答案。
 * 纯文字题目使用 DeepSeek，含图片题目使用质谱 GLM 多模态模型。
 *
 * 输出格式与 SearchInformation[] 兼容，可直接替换 defaultAnswerWrapperHandler。
 */

import { SearchInformation } from './interface';
import { BRIDGE_QUEUE_KEY, BRIDGE_ANSWER_PREFIX, BRIDGE_QUEUE_STALE, subjectKey } from './bridge-queue';

/* ------------------------------------------------------------------ */
/*  类型定义                                                           */
/* ------------------------------------------------------------------ */

export interface AIConfig {
	/** Chat2API 完整地址，例如 http://127.0.0.1:8080/v1/chat/completions */
	endpoint: string;
	/** 纯文字模型名称 */
	textModel: string;
	/** 多模态（图片）模型名称 */
	imageModel: string;
	/** API Key（可选） */
	apiKey?: string;
	/** 系统提示词 */
	systemPrompt: string;
}

export interface AIQuestion {
	title: string;
	options: string[];
	type: string;
	/** 题干部分的图片数量（elements 按题干在前、选项在后拼接时由提取器回填），
	 *  用于判断题目图片是否带角标图例（题干蓝「题」、选项红字母）；未提供则用通用表述 */
	stemImageCount?: number;
	/**
	 * 不告诉 AI 题型（默认 false）。
	 *
	 * 用于雨课堂课堂题：那里题型在页面上无法可靠判断（单选多选共用同一套 class），
	 * 与其传一个错的题型误导 AI，不如完全不提，让 AI 自己从图片判断该答几个字母。
	 * 设置后提示词里不会出现「单选题/多选题/判断题/填空题」字样，
	 * 也不会强制"选择题必须选字母"这类只适用特定题型的约束。
	 */
	omitType?: boolean;
}

export interface AIAnswer {
	answers: string[];
	type: string;
}

/* ------------------------------------------------------------------ */
/*  默认配置                                                           */
/* ------------------------------------------------------------------ */

export const DEFAULT_AI_CONFIG: AIConfig = {
	endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
	textModel: 'glm-4-flash',
	imageModel: 'glm-4v-flash',
	apiKey: '',
	systemPrompt: `只输出答案`
};

/* ------------------------------------------------------------------ */
/*  图片转 Base64                                                      */
/* ------------------------------------------------------------------ */

/**
 * 将图片 URL 或 HTMLImageElement 转为 Base64 data URL
 *
 * 流程：
 * 1. 创建 Image 对象并设置 crossOrigin 以尝试绕过 CORS
 * 2. 绘制到 Canvas 上导出 dataURL
 * 3. 若跨域失败，返回原始 URL 作为降级
 */
export function imageToBase64(
	src: string,
	timeout = 3000
): Promise<string> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.crossOrigin = 'anonymous';
		const timer = setTimeout(() => {
			img.src = '';
			// 超时降级：直接返回原始 URL
			resolve(src);
		}, timeout);

		img.onload = () => {
			clearTimeout(timer);
			try {
				const canvas = document.createElement('canvas');
				canvas.width = img.naturalWidth;
				canvas.height = img.naturalHeight;
				const ctx = canvas.getContext('2d');
				if (!ctx) {
					resolve(src);
					return;
				}
				ctx.drawImage(img, 0, 0);
				const dataUrl = canvas.toDataURL('image/png');
				resolve(dataUrl);
			} catch {
				// Canvas 导出失败（例如 tainted canvas）
				resolve(src);
			}
		};

		img.onerror = () => {
			clearTimeout(timer);
			// 加载失败，直接返回 URL
			resolve(src);
		};

		img.src = src;
	});
}

/**
 * 从 DOM 元素中提取所有 <img> 并转为 Base64
 * 必须在浏览器中转换（超星等平台图片需要登录态才能访问）
 * 转换失败则返回原始 URL
 */
export async function extractImagesFromElement(
	element: HTMLElement,
	timeout = 5000
): Promise<string[]> {
	const imgs = Array.from(element.querySelectorAll<HTMLImageElement>('img'));
	if (imgs.length === 0) return [];
	return await Promise.all(imgs.map((img) => imageToBase64(img.src, timeout)));
}

export async function extractImagesFromElements(
	elements: (HTMLElement | undefined | null)[],
	timeout = 5000
): Promise<string[]> {
	const { images } = await extractImagesFromElementsWithOptions(elements, Infinity, timeout);
	return images;
}

/**
 * 在图片左侧补一条空白并绘制角标（默认红底白字）。
 * 图片选项传给 AI 时只是一排附件缩略图，图上不带字母，
 * AI 无法把"第几张图"和"选项 A/B/C/D"对应起来（实测踩坑：罗尔定理选择题被答非所问）。
 * 角标画在原图外侧新增的空白条里，不遮挡图片内容；把标识直接画进图片里，
 * 与聊天 UI 的展示方式无关，最稳——千问粘贴多图时还会打乱排列顺序，
 * 角标跟着图片走，是唯一可靠的对应方式。
 * @param label 角标文字（选项传字母；题干传"题"并配蓝色以示区分）
 */
export function drawOptionLabel(base64: string, label: string, badgeColor = '#e53935'): Promise<string> {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			try {
				const w = img.naturalWidth || img.width;
				const h = img.naturalHeight || img.height;
				if (!w || !h) return resolve(base64);
				const canvas = document.createElement('canvas');
				const ctx = canvas.getContext('2d');
				if (!ctx) return resolve(base64);
				// 字号随图高缩放（短图不至于放不下，长图也不过分巨大）
				const fontSize = Math.min(96, Math.max(16, Math.round(h * 0.45)));
				const pad = Math.round(fontSize * 0.35);
				const badgeW = fontSize + pad * 2;
				const badgeH = Math.min(h, Math.round(fontSize * 1.25));
				const stripW = Math.round(badgeW + fontSize * 0.3);
				canvas.width = w + stripW;
				canvas.height = h;
				// 左侧空白条 + 原图右移
				ctx.fillStyle = '#ffffff';
				ctx.fillRect(0, 0, stripW, h);
				ctx.drawImage(img, stripW, 0);
				// 红底白字角标，垂直居中放在空白条内
				const bx = Math.round((stripW - badgeW) / 2);
				const by = Math.round((h - badgeH) / 2);
				ctx.fillStyle = badgeColor;
				ctx.fillRect(bx, by, badgeW, badgeH);
				ctx.fillStyle = '#ffffff';
				ctx.font = `bold ${fontSize}px Arial, sans-serif`;
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText(label, bx + badgeW / 2, by + badgeH / 2 + 1);
				resolve(canvas.toDataURL('image/png'));
			} catch {
				resolve(base64);
			}
		};
		img.onerror = () => resolve(base64);
		img.src = base64;
	});
}

/**
 * 提取图片并给选项图片标注字母。
 * @param elements 题干元素在前、选项元素在后的数组
 * @param optionStartIndex 从第几个元素开始是选项（其图片按 A/B/C/… 逐元素标注；
 *                         同一选项元素内的多张图共用同一字母）
 * @returns images 为按元素顺序拼接的图片数组；stemImageCount 为题干部分的图片数
 *          （供提示词生成"第几张图片是什么"的编号说明）
 */
export async function extractImagesFromElementsWithOptions(
	elements: (HTMLElement | undefined | null)[],
	optionStartIndex: number,
	timeout = 5000
): Promise<{ images: string[]; stemImageCount: number }> {
	const all: string[] = [];
	let stemImageCount = 0;
	let letterIdx = 0;
	// 只有调用方明确了题干/选项划分时才画「题」角标（zhs/icve 的 Infinity 全算题干，不能乱标）
	const labelStems = Number.isFinite(optionStartIndex);
	for (let i = 0; i < elements.length; i++) {
		const el = elements[i];
		if (!el) continue;
		const isOption = i >= optionStartIndex;
		const letter = isOption ? String.fromCharCode(65 + (letterIdx % 26)) : '题';
		const urls = await extractImagesFromElement(el, timeout);
		for (const url of urls) {
			// 只有成功转成 base64 的才能画角标；跨域失败的保持原样（返回的是原 URL）
			if (url.startsWith('data:image/') && (isOption || labelStems)) {
				all.push(await drawOptionLabel(url, letter, isOption ? '#e53935' : '#1e88e5'));
			} else {
				all.push(url);
			}
		}
		if (!isOption) stemImageCount += urls.length;
		if (isOption && urls.length) letterIdx++;
	}
	return { images: all, stemImageCount };
}

/* ------------------------------------------------------------------ */
/*  构建 AI 请求消息                                                   */
/* ------------------------------------------------------------------ */

/**
 * 判断题目是否包含图片（按配置中的关键词或选项文本中是否包含 data: / http 图片链接）
 */
export function hasImageContent(text: string): boolean {
	return /data:image\/[a-z]+;base64|\.(png|jpg|jpeg|gif|webp|bmp|svg)/i.test(text);
}

/**
 * 构建发送给 Chat2API 的请求体
 *
 * 若 base64Images 不为空，使用多模态格式（imageModel），
 * 否则使用纯文本格式（textModel）。
 */
export function buildChatRequest(
	config: AIConfig,
	question: AIQuestion,
	base64Images: string[]
): { model: string; messages: any[]; temperature: number; max_tokens: number } {
	const hasImages = base64Images.length > 0;
	const model = hasImages ? config.imageModel : config.textModel;

	const body = buildQuestionPrompt(config, question, base64Images);

	return { model, ...body };
}

/**
 * 构建提问文本（桥接与 API 模式共用）：
 * - 无论有无图片都带上题型，并强制要求末尾单独一行输出「最终答案：X」
 *   （图片题的题干/选项常是纯图片，innerText 只剩 URL，不带题型 AI 会猜错题目方向）
 * - 清理题目文本中的图片 URL 噪音
 */
export function buildQuestionPrompt(
	config: AIConfig,
	question: AIQuestion,
	base64Images: string[]
): { messages: any[]; temperature: number; max_tokens: number } {
	const hasImages = base64Images.length > 0;
	// omitType：完全不提题型（雨课堂课堂题的题型在页面上无法可靠判断）
	const omitType = question.omitType === true;
	const typeNames: Record<string, string> = {
		single: '单选题', multiple: '多选题', judgement: '判断题', completion: '填空题'
	};
	const typeName = omitType ? undefined : typeNames[question.type];

	// 图片 URL 对 AI 是纯噪音（题干/选项为图片时 innerText 只剩链接）
	const stripUrls = (s: string) => s.replace(/https?:\/\/\S{20,}/g, '[图片]').replace(/\n{2,}\[图片\]/g, '\n[图片]');

	// 结构：题目放最前（LLM 对开头权重最高，放中间会被无视——实测"罗尔定理"题干在提示词里
	// 仍被 AI 声称"没有明确的问题"），说明性文字其次，格式要求最后。
	let textContent = '';
	if (question.title) {
		textContent += '本题的问题是：' + stripUrls(question.title) + '\n\n';
	}
	textContent += typeName ? '请解答这道' + typeName + '。' : '请解答图片中的题目。';
	if (hasImages) {
		const hasChoiceImgs = !!(
			question.options && question.options.length && question.type !== 'completion' &&
			question.stemImageCount !== undefined && base64Images.length > question.stemImageCount
		);
		if (omitType) {
			// 雨课堂：整题就是一张图，不提题型、不提角标（图里本来就有字母）
			textContent += '（题目、选项及其内容都在图片里，请直接读图作答；有几个正确答案就给出几个字母）';
		} else if (question.stemImageCount !== undefined) {
			// cx：图片已带角标（题干蓝「题」、选项红字母），无需"第几张是什么"的位置说明，
			// 千问粘贴多图还会打乱排列顺序，位置说明本来就不可靠——按角标识别即可
			if (hasChoiceImgs) {
				textContent += '（选项内容在图片中，必须依据题干问题和图片选项作答；'
					+ (question.stemImageCount > 0 ? '题干图片带蓝色「题」角标，' : '')
					+ '选项图片的红色字母角标即对应选项字母，纯文字选项已直接列在选项列表中；'
					+ '角标均在图片外侧的空白条上、不遮挡内容；图片排列顺序不保证与题目一致，请按角标识别每张图片）';
			} else {
				textContent += '（题干内容在图片中，必须依据图片题干作答；题干图片带蓝色「题」角标，角标在图片外侧的空白条上、不遮挡内容）';
			}
		} else {
			// zhs/icve 旧调用点：图片不带角标，保持通用表述
			textContent += '（选项内容在图片中，必须依据上面的题干问题和图片选项作答）';
		}
	}
	if (question.options && question.options.length > 0) {
		textContent += '\n' + question.options.map((o, i) => `${String.fromCharCode(65 + i)} ${stripUrls(o)}`).join('\n');
	}
	// 结尾的格式要求：omitType 时不说"单选题/多选题"，改成中性表述
	const formatRule = omitType
		? '\n注意：只回答我这个问题，不要多想其他的。回答可以先简要分析，但最后必须单独一行给出结论，格式必须是「最终答案：X」'
			+ '（X 是选项字母：只有一个正确答案就给一个字母如 B，有多个正确答案就按字母顺序连写如 BE；'
			+ '判断题 X 为 对 或 错；填空题 X 为具体答案）。'
			+ '必须从选项中选字母作答，禁止用数字或文字描述代替选项字母。'
		: '\n注意：只回答我这个问题，不要多想其他的。回答可以先简要分析，但最后必须单独一行给出结论，格式必须是「最终答案：X」'
			+ '（单选题 X 为选项字母 A/B/C/D；多选题为字母组合如 AB；判断题 X 为 对 或 错；填空题 X 为具体答案）。'
			+ (question.type === 'single' || question.type === 'multiple'
				? '选择题即使不确定也必须从选项中选一个字母作答，禁止用数字或文字描述代替选项字母。'
				: '');
	textContent += '\n\n' + (config.systemPrompt || '只输出答案') + formatRule;

	const userContent = textContent;

	let userMessageContent: any;

	if (hasImages) {
			// 多模态请求：直接传入图片 URL
			userMessageContent = [{ type: 'text', text: userContent }];
			for (const imgUrl of base64Images) {
				userMessageContent.push({
					type: 'image_url',
					image_url: { url: imgUrl }
				});
			}
		} else {
		userMessageContent = userContent;
	}

	const messages: any[] = [{ role: 'user', content: userMessageContent }];

	return {
		messages,
		temperature: 0.1,
		max_tokens: 2048
	};
}

/* ------------------------------------------------------------------ */
/*  解析 AI 响应                                                       */
/* ------------------------------------------------------------------ */

/**
 * 从 AI 的原始响应文本中提取答案
 * AI 只输出答案，每行一个答案（多选多行），去除选项字母前缀。
 * 图片题常见长回答（AI 先推理后结论）：从末尾提取"最终结果/答案是 X"。
 */
export function parseAIResponse(raw: string): AIAnswer {
	const text = raw.trim();
	if (!text) return { answers: [], type: '' };

	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
	const answers = lines.map((s) => {
		// 去除"A." "B、" "C)" 等前缀，但保留纯字母
		const cleaned = s.replace(/^[A-Za-z][\).、.．]\s*/, '').replace(/^\d+[\).、.．]\s*/, '');
		return cleaned || s;
	}).filter(Boolean);

	// 1) 显式标记「最终答案：X」（提示词强制要求的格式，最可靠；多行长回答也走这里）
	// ⚠️ 选项字母必须覆盖到 E 甚至更多：雨课堂课堂题实测有 A~E 五选项，
	//    旧正则写死 [A-Da-d]，AI 答 "BE" 时匹配失败 → 整串 "最终答案：BE" 被当成答案
	//    → 回填时一个选项都匹配不上（实测只点到 B、E 漏掉）。
	//    这里放宽到 A-H（足够覆盖 8 选项以内），并允许 1~8 个字母组合（多选）。
	let m = text.match(
		/最终答案\s*[:：]\s*([A-Ha-h]{1,8}(?![A-Za-z0-9])|对|错|正确|错误|\d+(?:\.\d+)?)/
	);
	if (m) return { answers: [m[1]], type: '' };

	const isClean = (s: string) =>
		/^[A-Ha-h]$/.test(s) || /^(对|错|正确|错误)$/.test(s) || /^\d+(?:\.\d+)?$/.test(s);

	// 2) 单条回答且不是干净答案形式时（推理式长回答），从末尾提取最终答案
	if (answers.length === 1 && !isClean(answers[0])) {
		const r = extractFromTail(lines);
		if (r) return r;
	}
	// 3) 多行但每行都不是干净答案（整段推理）→ 同样从末尾提取
	if (answers.length > 1 && !answers.some(isClean)) {
		const r = extractFromTail(lines);
		if (r) return r;
	}

	return { answers, type: '' };
}

/** 从回答末尾窗口提取最终答案（KaTeX 渲染可能把关键词拆散，窗口放宽到后 5 行并拼合） */
function extractFromTail(lines: string[]): AIAnswer | undefined {
	const tail = lines.slice(-5).join(' ');
	// 关键词引导（AI 偶尔用"最终结论"代替要求的"最终答案"——实测踩过）
	// 字母范围同 parseAIResponse：必须覆盖 E 及以后（雨课堂 A~E 五选项实测）
	let m = tail.match(
		/(?:最终结果|最终结论|最终答案|答案|结论|结果|选|故|因此)[^A-Za-z0-9]{0,6}(?:是|为|应该选|：|:)?\s*(?:选项\s*)?([A-Ha-h]{1,8}(?![A-Za-z0-9])|对|错|正确|错误|\d+(?:\.\d+)?)/
	);
	if (m) return { answers: [m[1]], type: '' };
	// "第N个选项" → 选项字母（图片题常见表述）
	const cnNum: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
	m = tail.match(/第\s*([一二三四五六1-6])\s*个?\s*(?:选项|答案)/);
	if (m) {
		const n = cnNum[m[1]] || parseInt(m[1], 10);
		if (n >= 1 && n <= 8) return { answers: [String.fromCharCode(64 + n)], type: '' };
	}
	// "选项 B" / "选项B"独立表述（角标改造后 AI 常这样指代）
	m = tail.match(/选项\s*([A-Ha-h])(?![A-Za-z0-9])/);
	if (m) return { answers: [m[1]], type: '' };
	// 兜底：末尾独立的字母/对错/数字
	const m2 = tail.match(/([A-Ha-h](?![A-Za-z0-9])|对|错|\d+(?:\.\d+)?)(?:\s*[。.．])?\s*$/);
	if (m2) return { answers: [m2[1]], type: '' };
	return undefined;
}

/* ------------------------------------------------------------------ */
/*  跨窗口全局锁：防止多窗口并发请求导致模型账户耗尽                    */
/* ------------------------------------------------------------------ */

/** 获取全局锁（跨浏览器窗口），带冷却机制 */
async function acquireGlobalLock(): Promise<void> {
	while (true) {
		try {
			// 检查冷却时间（上一次请求完成后至少等 60 秒）
			const cooldown = await GM_getValue('ocs_ai_cooldown', 0);
			const elapsed = Date.now() - cooldown;
			if (elapsed < 3000) {
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}
			const current = await GM_getValue('ocs_ai_lock', 0);
			if (!current || (Date.now() - current > 120000)) {
				await GM_setValue('ocs_ai_lock', Date.now());
				await new Promise((r) => setTimeout(r, 150));
				const verify = await GM_getValue('ocs_ai_lock', 0);
				if (verify && Date.now() - verify < 120000) return;
			}
		} catch {}
		await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));
	}
}

/** 释放全局锁 */
function releaseGlobalLock(): void {
	try { GM_setValue('ocs_ai_lock', 0); } catch {}
}

/* ------------------------------------------------------------------ */
/*  桥接并发准入：千问同时最多回答 3 题                                 */
/* ------------------------------------------------------------------ */

const BRIDGE_MAX_CONCURRENCY = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 占一个并发槽位（记录在 GM 存储，带时间戳，超时残留自动清理）。
 *  槽位满 3 个时轮询等待——前面的题答完（或超时释放）后再发新问题 */
async function acquireBridgeSlot(reqId: string): Promise<void> {
	while (true) {
		try {
			// 题与题之间保持小间隔，避免瞬间并发冲击
			const cooldown = Number(GM_getValue('ocs_ai_cooldown', 0)) || 0;
			if (Date.now() - cooldown < 3000) { await sleep(2000); continue; }
			const map = JSON.parse(String(GM_getValue('ai_bridge_inflight', '')) || '{}') || {};
			const now = Date.now();
			for (const k of Object.keys(map)) if (now - map[k] > 180000) delete map[k];
			if (Object.keys(map).length < BRIDGE_MAX_CONCURRENCY) {
				map[reqId] = now;
				GM_setValue('ai_bridge_inflight', JSON.stringify(map));
				await sleep(150);
				const verify = JSON.parse(String(GM_getValue('ai_bridge_inflight', '')) || '{}') || {};
				if (verify[reqId] && Object.keys(verify).length <= BRIDGE_MAX_CONCURRENCY) return;
				// 抢占竞争失败或瞬间超卖：撤回重试
				delete verify[reqId];
				GM_setValue('ai_bridge_inflight', JSON.stringify(verify));
			}
		} catch {}
		await sleep(500 + Math.random() * 500);
	}
}

/** 释放并发槽位 */
function releaseBridgeSlot(reqId: string): void {
	try {
		const map = JSON.parse(String(GM_getValue('ai_bridge_inflight', '')) || '{}') || {};
		delete map[reqId];
		GM_setValue('ai_bridge_inflight', JSON.stringify(map));
	} catch {}
}

/* ------------------------------------------------------------------ */
/*  网页桥接模式：通过 GM 存储与 chatglm.cn 标签页通信                   */
/* ------------------------------------------------------------------ */

async function _doBridgeRequest(
	config: AIConfig,
	question: AIQuestion,
	base64Images: string[],
	site?: string
): Promise<SearchInformation[]> {
	const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);

	// 构建提问文本（与 API 模式共用：带题型 + 强制末尾「最终答案：X」+ 去 URL 噪音）
	const { messages: promptMessages } = buildQuestionPrompt(config, question, base64Images);
	const first = promptMessages[0].content as any;
	// 多模态时 content 是 [{type:'text',...}]，取文字部分
	const text =
		typeof first === 'string' ? first : Array.isArray(first) ? first.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : String(first);

	// ---- 同题去重（2026-10-18）----
	// 同一道题（同题干+同图）在 2 分钟内只问 AI 一次：章节测验/重复运行同一题时，
	// 避免把同一题反复发到 AI 聊天里（实测一题被发 3 次，污染对话且浪费额度）。
	// 键：题目文本 + 图片长度签名（图片题文本相同、图不同，用长度区分）。
	const nkey = text + '||' + base64Images.map((u) => u.length).join(',');
	const CACHE_KEY = 'ai_bridge_answer_cache';
	const toCachedResults = (answers: string[]): SearchInformation[] => [
		{
			name: 'AI网页',
			homepage: '',
			results: answers.map((ans) => ({
				question: question.title || '',
				answer: ans,
				extra_data: { ai: true, bridge: true, cached: true }
			}))
		}
	];
	const readCache = (): string[] | null => {
		try {
			const cache = JSON.parse(String(GM_getValue(CACHE_KEY, '')) || '{}') || {};
			const hit = cache[nkey];
			if (hit && Date.now() - hit.ts < 120000 && Array.isArray(hit.answers) && hit.answers.length) return hit.answers;
		} catch {}
		return null;
	};
	const cachedNow = readCache();
	if (cachedNow) {
		// @ts-ignore 调试日志
		console.log('[AI答题] 命中同题缓存，复用答案（不再重发）:', cachedNow.join('|'));
		return toCachedResults(cachedNow);
	}

	// 在途去重：同一题在"发送中"时，其他调用方不得重复发送，改为复用。
	// 窗口必须覆盖完整周期（发题 90s + AI 等待 120s ≈ 210s），否则 worker 重试、
	// 或多任务点并发时会再次入队，导致同一题在 AI 聊天里出现多次。
	const RECENT_KEY = 'ai_bridge_recent_nkeys';
	const INFLIGHT_WINDOW = 300 * 1000; // 5 分钟，覆盖最坏情况
	const WAIT_ROUNDS = 150; // 最多等 150 秒（与发题端 90s + AI 等待 + 余量对齐）
	let recent: Record<string, number> = {};
	try { recent = JSON.parse(String(GM_getValue(RECENT_KEY, '')) || '{}') || {}; } catch {}
	const inFlightBefore = !!(recent[nkey] && Date.now() - recent[nkey] < INFLIGHT_WINDOW);
	// @ts-ignore 调试日志
	console.log('[AI答题] 开始发题流程, inRecent=', inFlightBefore);

	if (inFlightBefore) {
		// @ts-ignore 调试日志
		console.log('[AI答题] 同题在途，等待其结果（最多' + WAIT_ROUNDS + '秒）');
		for (let i = 0; i < WAIT_ROUNDS; i++) {
			await sleep(1000);
			const c = readCache();
			if (c) {
				// @ts-ignore 调试日志
				console.log('[AI答题] 等待期间命中同题缓存，复用答案（避免并发重复）:', c.join('|'));
				return toCachedResults(c);
			}
		}
		// @ts-ignore 调试日志
		console.log('[AI答题] 在途等待超时，本次自行发送');
	}
	// 记录本次发送，供并发去重（带自己的指纹，便于失败时只清自己）
	const myStamp = Date.now();
	try {
		recent[nkey] = myStamp;
		for (const k in recent) {
			if (!recent[k] || Date.now() - recent[k] > INFLIGHT_WINDOW) delete recent[k];
		}
		GM_setValue(RECENT_KEY, JSON.stringify(recent));
	} catch {}

	// 本题是否已成功拿到答案（成功则保留在途标记直到缓存失效，失败立即清除）
	let gotAnswer = false;

	// 并发准入：千问同时最多回答 3 题，满了等前面的答完（或超时释放）再发
	const answerKey = BRIDGE_ANSWER_PREFIX + id;
	// ⚠️ skey 必须声明在 try 之外：finally 里要用它清理队列项和答案键。
	// 声明在 try 内（const）会因块级作用域在 finally 里抛 ReferenceError，
	// 而外层是 try{}catch{}，异常被静默吞掉 → 队列项/答案键永远不清理。
	const skey = subjectKey(text, base64Images);
	await acquireBridgeSlot(id);
	try {
		// ---- 重写版入队逻辑 ----
		// 主键改为「题目内容指纹」。同一道题（同题干+同图）无论来自哪个任务点、
		// 哪次重试，队列键都相同 —— 这本身就是第一道去重。
		// 不再记录 site：题目由当前打开的 AI 页面认领，不需要指定站点
		const q = { id: skey, text, images: base64Images, timestamp: Date.now() };
		for (let attempt = 0; attempt < 10; attempt++) {
			const queue = JSON.parse(String(GM_getValue(BRIDGE_QUEUE_KEY, '')) || '{}') || {};
			const exist = queue[skey];
			if (exist && Date.now() - exist.timestamp < BRIDGE_QUEUE_STALE) {
				// 同一题已由别人在发 → 不重复入队，直接等它的结果
				// @ts-ignore 调试日志
				console.log('[AI答题] 同题已在队列中，复用其结果（不重复发送）');
				break;
			}
			queue[skey] = q;
			GM_setValue(BRIDGE_QUEUE_KEY, JSON.stringify(queue));
			await sleep(150);
			const after = JSON.parse(String(GM_getValue(BRIDGE_QUEUE_KEY, '')) || '{}') || {};
			if (after[skey] && after[skey].id === q.id) break; // 写入成功
			await sleep(200 + Math.random() * 400);
		}
		// 敲门：唤醒 AI 标签页来认领
		GM_setValue('ai_bridge_knock', String(Date.now()));
		try { GM_setValue('ai_bridge_question', JSON.stringify(q)); } catch {}
		// @ts-ignore 调试日志
		console.log('[AI答题] 已入队:', skey, '站点=', site || '(任意)', '等 AI 页认领...');

		// 等待本题答案（最长 BRIDGE_SEND_TIMEOUT）
		// 注意：桥接侧可能先写入半截答案（流式生成中途回传），解析失败时继续等更完整的版本，
		// 直到超时才报错——避免"部分答案解析不出选项"造成的漏答
		const start = Date.now();
		let lastRaw = '';
		while (Date.now() - start < 90000) {
			await sleep(1000);
			try {
				// 答案可能写在两个键下：本题指纹（AI 页按队列键写答案）或旧版 id。两者都读。
				let raw = GM_getValue(BRIDGE_ANSWER_PREFIX + skey, '');
				if (!raw) raw = GM_getValue(answerKey, '');
				if (raw) {
					const a = JSON.parse(raw);
					if (a.error) {
						// @ts-ignore 调试日志
						console.log('[AI答题] 桥接报错:', a.error);
						return [{ name: 'AI网页', homepage: '', results: [], error: '网页桥接: ' + a.error }];
					}
					const aiAnswer = parseAIResponse(a.answer || '');
					if (!aiAnswer.answers.length) {
						// @ts-ignore 调试日志
						console.log('[AI答题] 答案解析失败(', (a.answer || '').length, '字)，继续等待...');
					}
					if (aiAnswer.answers.length) {
						gotAnswer = true;
						// @ts-ignore 调试日志
						console.log('[AI答题] 得到答案:', aiAnswer.answers.join(' | '), '(回答', (a.answer || '').length, '字)');
						// 写入同题缓存（2 分钟有效），供重复题目直接复用、不再重发
						try {
							const cache = JSON.parse(String(GM_getValue(CACHE_KEY, '')) || '{}') || {};
							cache[nkey] = { answers: aiAnswer.answers, ts: Date.now() };
							for (const k in cache) {
								if (!cache[k] || Date.now() - cache[k].ts > 300000) delete cache[k];
							}
							GM_setValue(CACHE_KEY, JSON.stringify(cache));
						} catch {}
						return [{
							name: 'AI网页',
							homepage: '',
							results: aiAnswer.answers.map((ans) => ({
								question: question.title || '',
								answer: ans,
								extra_data: { ai: true, bridge: true }
							}))
						}];
					}
					lastRaw = a.answer || ''; // 半截答案先存着，超时兜底用
				}
			} catch {}
		}

		if (lastRaw) {
			return [{ name: 'AI网页', homepage: '', results: [], error: '网页桥接: 答案解析失败（回答未给出明确的最终答案）' }];
		}
		return [{ name: 'AI网页', homepage: '', results: [], error: '网页桥接超时（90秒），请确认已打开 AI 聊天页面并保持登录' }];
	} finally {
		// 在途去重标记：只有失败时才立刻清除，让同题可以被重试；
		// 成功时保留到 INFLIGHT_WINDOW（由缓存命中接管），防止 worker 重试导致重复发送。
		if (gotAnswer === false) {
			try {
				const r2 = JSON.parse(String(GM_getValue(RECENT_KEY, '')) || '{}') || {};
				if (r2[nkey] === myStamp) delete r2[nkey];
				GM_setValue(RECENT_KEY, JSON.stringify(r2));
			} catch {}
		}
		// 队列项：认领即删除已由 AI 页负责；这里兜底清理自己的指纹键（防 AI 页未删除）。
		// 注意：不能删除别人的同题项，只删指纹等于自己的。
		try {
			const queue = JSON.parse(String(GM_getValue(BRIDGE_QUEUE_KEY, '')) || '{}') || {};
			if (queue[skey] && queue[skey].id === skey) {
				delete queue[skey];
				GM_setValue(BRIDGE_QUEUE_KEY, JSON.stringify(queue));
			}
		} catch {}
		try { GM_deleteValue(BRIDGE_ANSWER_PREFIX + skey); } catch {}
		try { GM_deleteValue(answerKey); } catch {}
		releaseBridgeSlot(id);
		try { GM_setValue('ocs_ai_cooldown', Date.now()); } catch {}
	}
}

/**
 * AI 答题器主入口
 *
 * 将题目（文本 + 图片）全部放在一次请求中发给 AI，
 * 解析答案，格式化为 SearchInformation[] 返回。
 * 桥接模式：最多 3 题并发（千问上限，发题端槽位准入）；
 * API 模式：全局互斥，同一时间一个请求。
 */
export async function aiAnswerer(
		config: AIConfig,
		question: AIQuestion,
		base64Images: string[] = [],
		signal?: AbortSignal
	): Promise<SearchInformation[]> {
	// 网页桥接模式：通过 GM 存储与 AI 聊天页面上的桥接脚本通信
	// 并发控制在 _doBridgeRequest 内部（3 路槽位 + 题间冷却）
	if (config.endpoint.startsWith('bridge://')) {
		const site = config.endpoint.replace('bridge://', '').split('/')[0];
		return await _doBridgeRequest(config, question, base64Images, site);
	}
		await acquireGlobalLock();
		try {
			return await _doAIRequest(config, question, base64Images, signal);
		} finally {
			releaseGlobalLock();
			// 请求完成后写冷却时间戳，其他窗口需等待冷却
			try { await GM_setValue('ocs_ai_cooldown', Date.now()); } catch {}
		}
	}

async function _doAIRequest(
	config: AIConfig,
	question: AIQuestion,
	base64Images: string[],
	signal?: AbortSignal
): Promise<SearchInformation[]> {
	// 构建请求体，支持模型降级
	const models = [config.textModel];
	if (base64Images.length > 0 && !models.includes(config.imageModel)) models.push(config.imageModel);

	let lastError = '';

	for (const model of models) {
		const body = buildChatRequest({ ...config, textModel: model, imageModel: model }, question, base64Images);
		// 确保 model 字段正确
		(body as any).model = model;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json'
		};

		if (config.apiKey) {
			headers['Authorization'] = `Bearer ${config.apiKey}`;
		}

		let responseText: string;

		try {
			if (typeof GM_xmlhttpRequest !== 'undefined') {
				// 用户脚本环境：用 GM_xmlhttpRequest（不弹跨域警告）
				responseText = await new Promise<string>((resolve, reject) => {
					const t = setTimeout(() => reject(new Error('AI 答题超时')), 90000);
					GM_xmlhttpRequest({
						url: config.endpoint,
						method: 'POST',
						headers,
						data: JSON.stringify(body),
						onload: (r) => {
								clearTimeout(t);
								if (r.status >= 200 && r.status < 300) {
									try {
										const obj = JSON.parse(r.responseText);
										const choice = obj?.choices?.[0];
										let content = choice?.message?.content;
										if (!content && obj?.error) {
											reject(new Error('AI 错误: ' + JSON.stringify(obj.error).substring(0, 300)));
										} else if (!content) {
											content = choice?.message?.reasoning_content || choice?.message?.refusal || '';
										}
										resolve(content || '');
									} catch {
										resolve(r.responseText || '');
									}
								} else {
									let detail = String(r.responseText || r.statusText || '');
									if (detail.length > 500) detail = detail.substring(0, 500) + '...';
									reject(new Error(`HTTP ${r.status}: ${detail}`));
								}
							},
							onerror: (err) => {
								clearTimeout(t);
								reject(new Error('Chat2API 连接失败，请确认 Chat2API 已启动（端口 8080）'));
							},
							ontimeout: () => { clearTimeout(t); reject(new Error('Chat2API 响应超时')); }
					});
				});
			} else {
				// 非用户脚本环境：用 fetch
				const response = await fetch(config.endpoint, {
					method: 'POST',
					headers,
					body: JSON.stringify(body),
					signal
				});
				if (!response.ok) throw new Error(`Chat2API ${response.status}`);
				const data = await response.json();
				responseText = data?.choices?.[0]?.message?.content || '';
			}
		} catch (err: any) {
				lastError = err.message || String(err);
				console.warn('[AI答题] 模型 ' + model + ' 请求失败: ' + lastError + '，尝试下一个...');
				continue;
			}

			if (responseText.trim()) {
				// 解析答案
				const aiAnswer = parseAIResponse(responseText);
				const results = aiAnswer.answers.map((answer) => ({
					question: question.title || '',
					answer,
					extra_data: { ai: true, type: aiAnswer.type }
				}));
				const uniqueResults = results.filter(
					(r, index, self) => index === self.findIndex((s) => s.answer === r.answer)
				);
				return [{
					name: `AI答题(${model})`,
					homepage: '',
					results: uniqueResults,
					response: responseText,
					data: body
				}];
			}

			console.warn('[AI答题] 模型 ' + model + ' 返回空内容，尝试下一个...');
			lastError = model + ' 返回空内容';
		}

		// 所有模型都失败了
		return [{
			name: 'AI答题',
			homepage: '',
			results: [],
			error: '所有模型均失败: ' + lastError
		}];
	}

/**
 * 快捷版：从 DOM 元素直接调用 AI 答题
 *
 * 自动提取元素中的图片并转为 Base64，然后调用 aiAnswerer。
 */
export async function aiAnswererFromElements(
		config: AIConfig,
		question: AIQuestion,
		elements: (HTMLElement | undefined | null)[],
		signal?: AbortSignal
	): Promise<SearchInformation[]> {
		const base64Images = await extractImagesFromElements(elements);
		return aiAnswerer(config, question, base64Images, signal);
	}

/**
 * 等待 Chat2API 就绪
 *
 * 在首次调用 AI 前先探测 /health 端点，最多重试 maxRetries 次，
 * 每次间隔 2 秒。如果就绪返回 true，超时返回 false。
 */
export async function waitForChat2API(
	baseUrl: string,
	maxRetries = 15
): Promise<boolean> {
	const healthUrl = baseUrl.replace(/\/v1\/chat\/completions.*$/, '').replace(/\/+$/, '') + '/health';
	for (let i = 0; i < maxRetries; i++) {
		try {
			if (typeof GM_xmlhttpRequest !== 'undefined') {
				const result = await new Promise<boolean>((resolve) => {
					GM_xmlhttpRequest({
						url: healthUrl,
						method: 'GET',
						responseType: 'json',
						timeout: 3000,
						onload: (r) => resolve(r.status === 200),
						onerror: () => resolve(false),
						ontimeout: () => resolve(false)
					});
				});
				if (result) return true;
			} else {
				const res = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
				if (res.ok) return true;
			}
		} catch {
			// 还没就绪，等待后重试
		}
		await new Promise(r => setTimeout(r, 2000));
	}
	return false;
}

/**
 * 跨域 POST 请求（优先使用 GM_xmlhttpRequest，否则用 fetch）
 */
export function httpPost(url: string, body: any, timeout = 15000): Promise<string> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('请求超时')), timeout);
			if (typeof GM_xmlhttpRequest !== 'undefined') {
				GM_xmlhttpRequest({
					url,
					method: 'POST',
					data: JSON.stringify(body),
					headers: { 'Content-Type': 'application/json' },
					responseType: 'json',
					onload: (resp) => {
						clearTimeout(timer);
						if (resp.status >= 200 && resp.status < 300) {
							resolve(typeof resp.response === 'string' ? resp.response : JSON.stringify(resp.response));
						} else {
							reject(new Error(`HTTP ${resp.status}`));
						}
					},
					onerror: () => { clearTimeout(timer); reject(new Error('网络错误')); },
					ontimeout: () => { clearTimeout(timer); reject(new Error('超时')); }
				});
		} else {
			fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
				.then(r => r.text())
				.then(t => { clearTimeout(timer); resolve(t); })
				.catch(e => { clearTimeout(timer); reject(e); });
		}
	});
}

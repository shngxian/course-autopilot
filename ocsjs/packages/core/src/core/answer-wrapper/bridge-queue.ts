/**
 * AI 网页桥接 —— 队列/认领机制（2026-10-18 重写版）
 *
 * ---------------------------------------------------------------------------
 * 旧设计为什么会导致「同一题在 AI 聊天里出现多次」
 * ---------------------------------------------------------------------------
 * 旧逻辑用「id 认领 + 队列项留给发题端清理」：
 *
 *   1. 发题端写入 queue[id]，最多等 90 秒
 *   2. AI 标签页认领 queue[id] → 写 claimKey → 处理题目
 *   3. finally 里删掉 claimKey，并立刻再扫一次队列
 *   4. 但 queue[id] 要等发题端自己超时才删除 → 步骤 3 又把同一题扫了进来
 *   5. → 同一题被发第 2 次、第 3 次……
 *
 * 另外发题端每次生成新 id（Date.now() + 随机），所以「同题不同 id」时
 * 去重完全失效，重复内容照样一路发到 AI。
 * ---------------------------------------------------------------------------
 *
 * 新设计（三处结构性改动）
 *
 *   A. 主键从 id 改为「内容指纹」(subject fingerprint)
 *      subject = 题目正文 + 图片长度签名，hash 后作为队列键。
 *      同一道题无论来自哪个任务点/哪次重试，都落到同一个键上。
 *
 *   B. 认领即移除（claim-then-delete）
 *      AI 标签页抢到一题就立刻从队列删除它，不再留给发题端。
 *      处理完写答案键 + 同题缓存。即使处理失败也会写 error 答案，
 *      发题端能立刻拿到结果，不会靠超时兜底。
 *
 *   C. 发题端只写队列 + 等答案，不再重复入队
 *      若指纹已在队列中（其他任务点正在发），本次直接复用其结果，
 *      绝不二次入队。
 *
 * 这样同一道题最多只会出现在 AI 聊天里一次。
 */

export const BRIDGE_QUEUE_KEY = 'ai_bridge_queue';
export const BRIDGE_ANSWER_PREFIX = 'ai_bridge_answer_';
/** 发题端等待答案的最长时间（毫秒） */
export const BRIDGE_SEND_TIMEOUT = 120000;
/** 队列项多久未更新视为废弃，允许被重新入队 */
export const BRIDGE_QUEUE_STALE = 120000;

/** 生成题目内容指纹（同题同指纹，与 id 无关） */
export function subjectKey(text: string, images: string[]): string {
	const body = String(text || '').replace(/\s+/g, ' ').trim();
	const img = (images || []).map((u) => String(u || '').length).join(',');
	let h = 0x811c9dc5;
	const s = body + '||' + img;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h * 0x01000193) >>> 0;
	}
	return 's' + h.toString(36);
}

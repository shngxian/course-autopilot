import { QuestionResolver, WorkContext } from './interface';
import { resolveSingle, resolveMultiple, resolveJudgement, resolveCompletion, isJudgementOptions } from './resolvers';

/** 默认答案题目处理器 */
export function createDefaultQuestionResolver<E>(
	ctx: WorkContext<E>
): Record<'single' | 'multiple' | 'completion' | 'judgement', QuestionResolver<E>> {
	return {
		/**
		 * 单选题处理器
		 *
		 * 委托给 resolveSingle 纯函数，将 DOM 元素适配为字符串
		 */
		async single(infos, options, handler) {
			const optionTexts = options.map((o) => o.innerText);

			// 选项具备判断题性质时，直接走判断题处理逻辑
			if (isJudgementOptions(optionTexts.map((o) => o.trim()))) {
				const answerGroups = infos.map((info) => info.results.map((res) => res.answer));
				const result = resolveJudgement(answerGroups, optionTexts);
				if (result.finish && result.option !== undefined) {
					const index = optionTexts.indexOf(result.option);
					// 找不到就跳过，绝不降级到 options[0]（那会永远点第一个选项）
					if (index !== -1) {
						await handler('judgement', result.option, options[index], ctx);
					} else {
						console.warn('[单选题] 判断题选项未匹配到，跳过:', result.option);
					}
				}
				return result;
			}

			const answers = infos.map((info) => info.results.map((res) => res.answer)).flat();

			const result = resolveSingle(answers, optionTexts, ctx.answerSeparators);

			if (result.finish && result.option !== undefined) {
				const index = optionTexts.indexOf(result.option);
				if (index !== -1) {
					await handler('single', result.option, options[index], ctx);
				} else {
					console.warn('[单选题] 选项未匹配到，跳过:', result.option);
				}
			}

			return result;
		},
		/**
		 * 多选题处理器
		 *
		 * 委托给 resolveMultiple 纯函数，将 DOM 元素适配为字符串
		 */
		async multiple(infos, options, handler) {
			const resultAnswers = infos.map((info) => info.results.map((res) => res.answer)).flat();
			const optionTexts = options.map((o) => o.innerText);

			const result = resolveMultiple(resultAnswers, optionTexts, ctx.answerSeparators);

			// @ts-ignore 调试日志
			console.log('[多选题调试] answers=', JSON.stringify(resultAnswers), 'optionTexts=', JSON.stringify(optionTexts.map((t) => t.substring(0, 20))), 'finish=', result.finish, 'indexes=', JSON.stringify(result.indexes));

			// 用 resolver 直接给出的索引，不再用 optionTexts.indexOf 反查：
			// 选项文本可能重复（如两个"以上都对"），或被 removeRedundant 处理后与原始文本不一致，
			// 反查会错位到别的选项 —— 这是"答案给了但选项没点对"的根因。
			if (result.finish && result.indexes && result.indexes.length) {
				for (const idx of result.indexes) {
					if (idx < 0 || idx >= options.length) continue;
					await handler('multiple', optionTexts[idx], options[idx], ctx);
				}
			} else if (result.finish) {
				console.warn('[多选题] finish=true 但没有 indexes，未触发任何点击');
			} else {
				console.warn('[多选题] resolveMultiple 返回 finish=false，未触发任何点击');
			}

			return result;
		},
		/**
		 * 判断题处理器
		 *
		 * 委托给 resolveJudgement 纯函数
		 */
		async judgement(infos, options, handler) {
			const answerGroups = infos.map((info) => info.results.map((res) => res.answer));
			const optionTexts = options.map((o) => o.innerText);

			const result = resolveJudgement(answerGroups, optionTexts);

			if (result.finish && result.option !== undefined) {
				const index = optionTexts.indexOf(result.option);
				// 找不到就跳过，绝不降级到 options[0]
				if (index !== -1) {
					await handler('judgement', result.option, options[index], ctx);
				} else {
					console.warn('[判断题] 选项未匹配到，跳过:', result.option);
				}
			}

			return result;
		},
		/**
		 * 填空题处理器
		 *
		 * 委托给 resolveCompletion 纯函数
		 */
		async completion(infos, options, handler) {
			const answerGroups = infos.map((info) => info.results.map((res) => res.answer));

			const result = resolveCompletion(answerGroups, options.length, ctx.answerSeparators);

			if (result.finish && result.answers) {
				for (let i = 0; i < result.answers.length; i++) {
					await handler('completion', result.answers[i], options[i], ctx);
				}
			}

			return result;
		}
	};
}

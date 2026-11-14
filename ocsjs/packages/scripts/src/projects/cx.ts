/** global Ext videojs getTeacherAjax jobs */

import {
	OCSWorker,
	defaultAnswerWrapperHandler,
	$,
	StringUtils,
	request,
	createDefaultQuestionResolver,
	DefaultWork,
	splitAnswer,
	domSearch,
	domSearchAll,
	SearchInformation
} from '@ocsjs/core';
import { $modal, h, $store, MessageElement, Project, Script, $el, $gm, $$el, $ui, cors, $message } from 'easy-us';

import { CommonProject } from './common';
import { workNotes, volume, playbackRate, dropdownStyle } from '../utils/configs';
import {
	answerWrapperEmptyWarning,
	commonWork,
	optimizationElementWithImage,
	removeRedundantWords,
	simplifyWorkResult,
	isAIEnabled,
	getAIConfig,
	aiWorkAnswerer,
	trustedClick
} from '../utils/work';
import md5 from 'md5';
// @ts-ignore
import Typr from 'typr.js';
import { $console, BackgroundProject } from './background';
import { CommonWorkOptions, playMedia } from '../utils';
import { waitForElement, waitForMedia } from '../utils/study';
// 内置繁体字映射表（20906 条，347KB）。与 cdn.ocsjs.com/resources/font/table.json 同源，
// 内置后章节测验的字体解密不再依赖外网 —— 实测外网不可达会让解密永远完不成、题干全是乱码。
// @ts-ignore
import LOCAL_FONT_MAPPING from '../../../core/src/assets/font-table.json';

// @ts-ignore
let top: Window = globalThis.top;

try {
	/**
	 *
	 *  将繁体字映射载入内存。
	 *  为什么不存 localStorage 和 GM_setValue
	 *  localStorage: 存在被检测风险，谁都能访问
	 *  GM_setValue: 文件太大影响I/O速度
	 */
	// @ts-ignore
	top.typrMapping = top.typrMapping || undefined;

	// @ts-ignore 任务点
	top.jobs = top.jobs || [];

	// @ts-ignore 当前视频
	top.currentMedia = top.currentMedia || undefined;

	// 加 try 是因为跨域面板无法操作
} catch {}

const state = {
	study: {
		videojs: Object.create({}),
		hacked: false,
		answererWrapperUnsetMessage: undefined as MessageElement | undefined,
		playbackRateWarningListenerId: 0
	}
};

type VideoQuizStrategy = 'random' | 'ignore';

type Attachment = {
	/** 只有当 module 为 音视频（并且已经播放完成）时才会有这个属性 */
	isPassed: boolean | undefined;
	/** 是否为任务点（音视频播放完成后此属性不存在） */
	job: boolean | undefined;
	/** 这里注意，如果当前章节测试不是任务点，则没有 jobid 或者未空字符串 */
	jobid?: string;
	property: {
		mid: string;
		/** 任务点id，固定存在 */
		_jobid: string;
		module: 'insertbook' | 'insertdoc' | 'insertflash' | 'work' | 'insertaudio' | 'insertvideo';
		name?: string;
		author?: string;
		bookname?: string;
		publisher?: string;
		title?: string;
	};
};

type Job = {
	mid: string;
	attachment: Attachment;
	func: { (): Promise<void> } | undefined;
};
export const CXProject = Project.create({
	name: '超星学习通',
	domains: [
		'chaoxing.com',
		'edu.cn',
		'org.cn',
		// 学银在线
		'xueyinonline.com',
		/** 其他域名 */
		'hnsyu.net',
		'qutjxjy.cn',
		'ynny.cn',
		'hnvist.cn',
		'fjlecb.cn',
		'gdhkmooc.com',
		'cugbonline.cn',
		'zjelib.cn',
		'cqrspx.cn',
		'neauce.com',
		'zhihui-yun.com',
		'cqie.cn',
		'ccqmxx.com',
		'jxgmxy.com',
		'jnzyjsxy.cn',
		// 超星学习通PPT，2025下半年更新的PTT图书新域名
		'sslibrary.com',
		// 26年新增官方域名
		'xuexi365.com'
	],
	scripts: {
		/**
		 * 创建超星独立脚本防止污染其他脚本环境
		 */
		env: new Script({
			name: '环境准备脚本',
			matches: [['所有页面', /.*/]],
			hideInPanel: true,
			onstart() {
				// 超星播放器的"用户在场检测"：鼠标跨过窗口/iframe 边界会暂停视频
				// （v2026-0901 实测：拦截全部 mouse*/pointer* 的 enter/leave/out/over
				// 后跨越瞬间仍会暂停一次，触发路径在播放器内部，来源不可见）。
				// 双重防护：
				// 1. 捕获阶段拦截边界事件（document_start 注册，早于播放器）
				// 2. 暂停自愈：非用户点击/按键引起的暂停，600ms 后自动恢复播放；
				//    页面不可见（最小化）时不恢复，用户主动暂停不受影响
				if (/\/ananas\/modules\/(video|audio)/.test(location.href)) {
					let lastBoundaryAt = 0;
					let lastTrustedInput = 0;
					for (const ev of [
						'mouseenter', 'mouseleave', 'mouseout', 'mouseover',
						'pointerenter', 'pointerleave', 'pointerout', 'pointerover'
					]) {
						window.addEventListener(ev, (e) => {
							lastBoundaryAt = Date.now();
							e.stopImmediatePropagation();
						}, true);
					}
					document.addEventListener('click', (e) => { if (e.isTrusted) lastTrustedInput = Date.now(); }, true);
					document.addEventListener('keydown', (e) => { if (e.isTrusted) lastTrustedInput = Date.now(); }, true);
					const origPause = HTMLMediaElement.prototype.pause;
					HTMLMediaElement.prototype.pause = function () {
						const media = this;
						const likelyAuto =
							media.currentTime > 1 &&
							document.visibilityState === 'visible' &&
							Date.now() - lastTrustedInput > 1500;
						// 边界跨越后 1 秒内的暂停 = 播放器的"鼠标离开"暂停，直接吞掉
						if (likelyAuto && Date.now() - lastBoundaryAt < 1000) {
							return;
						}
						const result = origPause.call(media);
						// 兜底：其他来源的自动暂停（触发路径在播放器内部，未能完全定位），
						// 600ms 后自动恢复；用户点击/按键引起的暂停不受影响，页面隐藏时不恢复
						if (likelyAuto) {
							setTimeout(() => {
								if (media.paused && !media.ended && document.visibilityState === 'visible') {
									media.play().catch(() => {});
								}
							}, 600);
						}
						return result;
					};
					console.log('[study日志] 播放器鼠标防暂停已启用（边界拦截+自愈）');
				}

				/**
				 * 于 4.9.20 后更新，出现顶层套壳页面跨域 :
				 * top : zjelib.cn <body>
				 * iframe : mooc1.xxx.zjelib.cn/.../mycourse/studentstudy/...  <iframe src=....>
				 * 导致top指向zjelib跨域无法访问，所以这里尝试寻找真正的top窗口对象，只有域名中包含 /mycourse/studentstudy 才是可操作的 top
				 */
				try {
					let _self = self;
					let _try_count = 10;
					while (_self.parent !== undefined && _try_count > 0) {
						if (_self.location.href.includes('/mycourse/studentstudy')) {
							top = _self;
							console.log('[ocsjs] top change to ' + top.location.href);
							break;
						} else {
							_try_count--;
							// @ts-ignore
							_self = _self.parent;
						}
					}
				} catch (e) {
					console.warn('[ocsjs] fail of find top');
					console.warn(e);
					// @ts-ignore
					top = globalThis.top;
				}
			}
		}),
		guide: new Script({
			name: '💡 使用提示',
			matches: [
				['首页', 'https://www.chaoxing.com'],
				['旧版个人首页', 'chaoxing.com/space/index'],
				['新版个人首页', 'chaoxing.com/base'],
				['学习页面', 'chaoxing.com/mycourse'],
				['新版学习页面', 'chaoxing.com/mooc2-ans/mycourse']
			],
			namespace: 'cx.guide',
			configs: {
				notes: {
					defaultValue: `请手动进入视频、作业、考试页面，脚本会自动运行。`
				}
			},
			oncomplete() {
				if (['mycourse/studentstudy'].some((path) => location.href.includes(path))) {
					$message.success('已进入学习页面，请等待自动运行...');
					return;
				}
				$message.info('请手动进入视频、作业、考试页面，脚本会自动运行。');
			}
		}),
		autoLogin: new Script({
			name: '🔑 自动登录',
			hideInPanel: true,
			matches: [
				['学习通登录页', /passport2?\.chaoxing\.com\/(login|pc)/],
				['学习通内嵌登录', /.*\.chaoxing\.com\/.*login/]
			],
			async onstart() {
				// 等待登录表单与 Chrome 密码自动填充（不读取/不存储密码，只负责点登录按钮）
				for (let i = 0; i < 20; i++) {
					await $.sleep(500);
					try {
						const pwd = document.querySelector<HTMLInputElement>('#pwd, input[type=password]');
						const account = document.querySelector<HTMLInputElement>('#phone, #username, input[name=account]');
						if (pwd && account && pwd.value && account.value) {
							const btn =
								document.querySelector<HTMLElement>('#loginbtn') ||
								Array.from(document.querySelectorAll<HTMLElement>('button, a, div[onclick]')).find((b) => (b.textContent || '').trim() === '登录');
							if (btn) {
								console.log('[自动登录] 检测到已填充的账密，点击登录');
								$message.info({ content: '检测到已保存的账号密码，自动登录中...' });
								btn.click();
								return;
							}
						}
					} catch {}
				}
				console.log('[自动登录] 10秒内未见自动填充的账密（未保存密码或需手动/滑块），跳过');
			}
		}),
		study: new Script({
			name: '🖥️ 课程学习',
			namespace: 'cx.new.study',
			matches: [
				['任务点页面', '/knowledge/cards'],
				['阅读任务点', '/readsvr/book/mooc']
				// 旧版浏览器好像不能识别二级 iframe ， 所以不能使用 'work/doHomeWorkNew' 以及其他二级 iframe 来触发路由
			],
			configs: {
				notes: {
					defaultValue: $ui.notes([
						['任务点不是顺序执行，如果某一个任务没有动', '请查看是否有其他任务正在学习，耐心等待即可。'],
						'闯关模式请注意题库如果没完成，需要自己完成才能解锁章节。',
						'请勿凌晨刷课，部分学校课程可能会清空进度。',
						['⚠️目前超星倍速风控严重，如果高倍速', '完成后被清空还原，请调到1-2倍速学习！']
					]).outerHTML
				},
				playbackRate: playbackRate,
				volume: volume,
				videoQuizStrategy: {
					label: '视频内题目',
					tag: 'select',
					options: [
						['random', '随机答题'],
						['ignore', '忽略']
					],
					attrs: {
						title:
							'视频有时在学习过程中会弹出题目，这个好像并不计算在分数内，所以可以忽略，视频可以正常观看，这里提供几个方法处理题目'
					},
					defaultValue: 'random' as VideoQuizStrategy
				},
				mode: {
					label: '跳转模式',
					tag: 'select',
					options: [
						['next', '完成后跳转下一节', '完成小节后，自动点击下一节按钮'],
						['job', '完成后跳转未完成任务点', '如果未找到任务点，则会直接结束脚本运行，目前处于试验阶段。'],
						['manually', '完成后暂停，等待手动跳转', '适用于自己手动运行']
					],
					defaultValue: 'next' as 'next' | 'job' | 'manually'
				},
				autoJumpToUnFinishJob: {
					label: '自动切换未完成章节',
					attrs: { type: 'checkbox', title: '在自动学习前寻找未完成章节并跳转（积分课、智慧课程：推荐关闭）' },
					defaultValue: true
				},
				restudy: {
					label: '复习模式',
					attrs: { title: '已经完成的视频继续学习', type: 'checkbox' },
					defaultValue: false
				},
				forceLearn: {
					label: '强制学习',
					attrs: {
						title: '视频一般分为：非任务点、任务点、和已完成任务点，当遇到“非任务点”时需要开启此选项才会进行学习',
						type: 'checkbox'
					},
					defaultValue: false
				},
				backToFirstWhenFinish: {
					label: '完成全部后重新学习',
					attrs: {
						type: 'checkbox',
						title: '当章节已经学习完成至最后一章时，跳转到第一个章节重新开始学习。'
					},
					defaultValue: false
				},
				showTextareaWhenEdit: {
					label: '编辑时显示自定义编辑框',
					attrs: {
						type: 'checkbox',
						title:
							'超星默认禁止在编辑框中复制粘贴，开启此选项可以在文本框编辑时生成一个自定义编辑框进行编辑，脚本会将内容同步到编辑框中。'
					},
					defaultValue: true
				},
				notifyWhenHasFaceRecognition: {
					label: '出现人脸识别时通知我',
					attrs: {
						type: 'checkbox'
					},
					defaultValue: true
				},
				enables: {
					...dropdownStyle,
					label: '高级设置',
					attrs: { type: 'checkbox' },
					defaultValue: false
				},
				/**
				 *
				 * 开启的任务点
				 *
				 * media : 音视频
				 * ppt : 文档和书籍翻阅
				 * test : 章节测试
				 * read : 阅读
				 * live : 直播课
				 *
				 */
				enableMedia: {
					elementClassName: 'config-details',
					showIf: 'cx.new.study.enables',
					label: '视频/音频自动播放',
					attrs: { type: 'checkbox', title: '开启：音频和视频的自动播放' },
					defaultValue: true
				},
				enablePPT: {
					elementClassName: 'config-details',
					showIf: 'cx.new.study.enables',
					label: 'PPT/书籍自动完成',
					attrs: { type: 'checkbox', title: '开启：PPT/书籍自动翻阅' },
					defaultValue: true
				},
				enableChapterTest: {
					elementClassName: 'config-details',
					showIf: 'cx.new.study.enables',
					label: '章节测试自动答题',
					attrs: { type: 'checkbox', title: '开启：章节测试自动答题' },
					defaultValue: true
				},
				enableHyperlink: {
					elementClassName: 'config-details',
					showIf: 'cx.new.study.enables',
					label: '链接任务自动完成',
					attrs: { type: 'checkbox', title: '开启：链接任务自动完成' },
					defaultValue: true
				}
			},
			onrender({ panel }) {
				if (!CommonProject.scripts.settings.cfg.answererWrappers?.length) {
					answerWrapperEmptyWarning(10);
				}

				// 高倍速警告
				this.offConfigChange(state.study.playbackRateWarningListenerId);
				state.study.playbackRateWarningListenerId =
					this.onConfigChange('playbackRate', (playbackRate) => {
						if (playbackRate > 2) {
							$modal.alert({
								title: '⚠️高倍速警告',
								content: $ui.notes([
									'⚠️高倍速可能导致学习记录清空/回退',
									'⚠️超星后台可以看到学习时长，请谨慎设置',
									'⚠️如已清空/回退，请降低倍速至1-2倍'
								]),
								maskCloseable: false,
								confirmButtonText: '我已知晓风险'
							});
						}
					}) || 0;
			},
			// 这里不使用 oncompelete ，如果某个资源一直在加载中，就会导致 oncomplete 一直无法触发，导致脚本无法运行，所以改为 onactive 只要匹配上就会触发
			async onactive() {
				/** iframe 跨域问题， 必须在 iframe 中执行 ， 所以脱离学习脚本运行。 */
				if (/\/readsvr\/book\/mooc/.test(location.href)) {
					// 26年上半学期新阅读任务点，计时翻页，达到一定时间才能翻下一页，这里等待时间然后执行翻页完成任务。
					if (document.querySelector('#reader')) {
						// @ts-ignore
						require(['reader'], (_reader) => {
							waitForElement('.readerPager').then(() => {
								setTimeout(async () => {
									const jumper = document.querySelector<HTMLSelectElement>('#pagejump');
									if (_reader?.goPage && jumper) {
										// 等待时间
										const timing = parseInt(new URL(location.href).searchParams.get('timing')?.toString() || '60') + 3;
										console.log(timing);
										await $.sleep(timing * 1000);
										/**
											 *  1:书名页
												2:版权页
												3:前言页
												4:目录页
												5:正文275页
												7:封底页
											*/
										jumper.value = '5';
										jumper.dispatchEvent(new Event('change'));
										console.log('已跳转正文页');
										await $.sleep(timing * 1000);
										jumper.value = '7';
										jumper.dispatchEvent(new Event('change'));
										console.log('已跳转封底页');
										await $.sleep(timing * 1000);
										Array.from(document.querySelectorAll<HTMLElement>('.readerPager'))
											.filter((el) => el.style.zIndex === '101')[0]
											.click();
										console.log('阅读完成');
									}
								}, 3000);
							});
						});
					}
					// 普通阅读任务点，id 是 #ReadWeb
					else {
						$console.log('正在完成书籍/PPT...');
						setTimeout(() => {
							// @ts-ignore
							// eslint-disable-next-line no-undef
							readweb.goto(epage);
						}, 5000);
					}
					return;
				}

				// 主要处理
				if (/\/knowledge\/cards/.test(location.href)) {
					const updateMediaState = () => {
						// @ts-ignore
						if (top.currentMedia) {
							// @ts-ignore 倍速设置
							top.currentMedia.playbackRate = parseFloat(this.cfg.playbackRate.toString());
							// @ts-ignore 音量设置
							top.currentMedia.volume = this.cfg.volume;
						}
					};

					this.onConfigChange('playbackRate', updateMediaState);
					this.onConfigChange('volume', updateMediaState);

					await study({
							...this.cfg,
							playbackRate: parseFloat(this.cfg.playbackRate.toString()),
							workOptions: CommonProject.scripts.settings.methods.getWorkOptions() as unknown as CommonWorkOptions
						});
				}
			}
		}),
		work: new Script({
			name: '✍️ 作业考试脚本',
			matches: [
				['作业页面', '/mooc2/work/dowork'],
				['考试整卷预览页面', '/mooc2/exam/preview']
			],
			namespace: 'cx.new.work',
			configs: { notes: workNotes },
			async oncomplete() {
				const isExam = /\/exam\/preview/.test(location.href);
				commonWork(this, {
					workerProvider: (opts) => workOrExam(isExam ? 'exam' : 'work', { ...opts, preview_mode: true }),
					enable_control_panel: true
				});
			}
		}),
		autoRead: new Script({
			name: '🖥️ 自动阅读',
			matches: [
				['阅读页面', '/ztnodedetailcontroller/visitnodedetail'],
				['课程目录', /chaoxing.com\/course\/\d+\.html/],
				['课程目录', /chaoxing.com\/mooc-ans\/course\/\d+\.html/],
				['积分课阅读课程目录', '/mooc-ans/zt/portal']
			],
			namespace: 'cx.new.auto-read',
			configs: {
				notes: {
					defaultValue: $ui.notes(['点击任意章节开始自动阅读', '阅读任务次日才会统计阅读时长']).outerHTML
				},
				restartAfterFinish: {
					label: '无限阅读',
					attrs: { type: 'checkbox', title: '阅读完成最后一章后从头第一章继续阅读' },
					defaultValue: false
				}
			},
			oncomplete() {
				// 置顶
				CommonProject.scripts.render.methods.pin(this);
				$message.info('请手动点击任意章节开始自动阅读');

				// 自动进入章节功能，如果不是阅读页面则自动进入
				if (location.href.includes('/ztnodedetailcontroller/visitnodedetail') === false) {
					startAtFirst();
					return;
				}

				let top = 0;
				const interval = setInterval(() => {
					top += (document.documentElement.scrollHeight - window.innerHeight) / 60;
					window.scrollTo({
						behavior: 'smooth',
						top: top
					});
				}, 1000);

				setTimeout(() => {
					clearInterval(interval);
					// 下一页
					const next = $el('.nodeItem.r i');
					if (next) {
						next.click();
					} else {
						if (this.cfg.restartAfterFinish) {
							setTimeout(() => startAtFirst(), 3000);
							$message.info({ content: '即将重新从头开始阅读', duration: 10 });
							$console.log('即将重新从头开始阅读');
						} else {
							$message.success({ content: '阅读任务已完成', duration: 0 });
							$console.log('未检测到下一页');
						}
					}
				}, (60 + 3) * 1000);

				// 点击第一个章节
				function startAtFirst() {
					const texts = $$el('.course_section .chapterText');
					if (texts.length) {
						texts[0].click();
					}
				}
			}
		}),
		/**
		 * 有时候进入课程会默认在，任务页面，会出现任务为空，部分用户会以为没有章节任务，所以添加此脚本
		 */
		pageRedirect: new Script({
			name: '章节页面自动切换脚本',
			matches: [['课程任务页面', 'pageHeader=0']],
			hideInPanel: true,
			async oncomplete() {
				if (top === window) {
					const a = document.querySelector<HTMLElement>('a[title="章节"]');
					if (a) {
						await $.sleep(1000);
						// 跳转到最新版本的超星
						a.click();
						$message.info({
							content: '已经为您自动切换到章节列表页面，手动进入任意章节即可开始自动学习！'
						});
					}
				}
			}
		}),
		versionRedirect: new Script({
			name: '版本切换脚本',
			matches: [
				['', 'mooc2=0'],
				['', 'mycourse/studentcourse'],
				['', 'work/getAllWork'],
				['', 'work/doHomeWorkNew'],
				['', 'exam/test\\?']
			],
			hideInPanel: true,
			async oncomplete() {
				if (top === window) {
					$message.warn({
						content:
							'OCS网课助手不支持旧版超星, 即将切换到超星新版, 如有其他第三方插件请关闭, 可能有兼容问题导致频繁切换。',
						duration: 0
					});
					// 跳转到最新版本的超星
					await $.sleep(2000);

					// 检测是否有人脸识别
					await waitForFaceRecognition();

					const experience = document.querySelector('.experience') as HTMLElement;
					if (experience) {
						experience.click();
					} else {
						const newUrl = new URL(window.location.href);
						if (window.location.href.includes('mooc-ans/mycourse/studentstudy')) {
							newUrl.pathname = '/mycourse/studentstudy';
						}
						const params = newUrl.searchParams;
						let changed = false;
						if (params.get('mooc2') !== '1') {
							params.set('mooc2', '1');
							changed = true;
						}

						// 兼容考试切换
						if (params.get('newMooc') !== 'true') {
							params.set('newMooc', 'true');
							changed = true;
						}
						if (changed) window.location.replace(newUrl);
					}
				}
			}
		}),
		examRedirect: new Script({
			name: '考试整卷预览脚本',
			matches: [
				['新版考试页面', 'exam-ans/exam/test/reVersionTestStartNew'],
				// 2023/9月 新增
				['新版考试页面2', 'mooc-ans/exam/test/reVersionTestStartNew']
			],
			hideInPanel: true,
			oncomplete() {
				if ($gm.unsafeWindow.document.querySelector('.mark_info')?.textContent?.includes('不允许整卷预览')) {
					$message.warn({
						content: $ui.notes([
							'由于当前考试禁止整卷预览，各题为独立新页面，只能一个个答题',
							'在考完前禁止手动切换题目，否则会导致重复答题！',
							'完成后或者开考前请手动删除搜索结果！',
							'想加快速度请更改通用-全局设置-高级设置-搜题间隔，设置为 1-3 秒即可。'
						]),
						duration: 0
					});
					const isExam = /\/exam\/test/.test(location.href);
					const workOptions = CommonProject.scripts.settings.methods.getWorkOptions();
					commonWork(CXProject.scripts.work, {
						// 因为超星是每个题目一个页面，这里加快开始速度，避免等待，默认5秒，这里加快为默认3秒间隔
						start_delay_seconds: workOptions.period,
						enable_control_panel: true,
						workerProvider: (opts) => workOrExam(isExam ? 'exam' : 'work', { ...opts, preview_mode: false, thread: 1 })
					});
					return;
				}
				$message.info({ content: '即将跳转到整卷预览页面进行考试。' });
				setTimeout(() => $gm.unsafeWindow.topreview(), 3000);
			}
		}),
		rateHack: new Script({
			name: '屏蔽倍速限制',
			hideInPanel: true,
			matches: [['', '/ananas/modules/video/']],
			onstart() {
				rateHack();
			}
		}),
		copyHack: new Script({
			name: '屏蔽复制粘贴限制',
			hideInPanel: true,
			matches: [['所有页面', /.*/]],
			methods() {
				return {
					/** 解除输入框无法复制粘贴 */
					hackEditorPaste() {
						try {
							const instants = $gm.unsafeWindow?.UE?.instants || [];
							for (const key in instants) {
								const ue = instants[key];

								/**
								 * 新建一个文本框给用户编辑，然后同步到超星编辑器，防止http下浏览器无法读取剪贴板
								 */

								// eslint-disable-next-line no-proto
								if (ue?.textarea) {
									ue.body.addEventListener('click', async () => {
										// http 下无法读取剪贴板，通过弹窗让用户输入然后同步到编辑器
										if (CXProject.scripts.study.cfg.showTextareaWhenEdit) {
											const defaultText = h('span', { innerHTML: ue.textarea.value }).textContent;
											$modal.prompt({
												content:
													'请在此文本框进行编辑，防止超星无法复制粘贴。(如需关闭请前往设置: 课程学习-编辑时显示自定义编辑框)',
												width: 800,
												inputDefaultValue: defaultText || '',
												modalInputType: 'textarea',
												onConfirm: (val = '') => {
													ue.setContent(
														val
															.split('\n')
															.map((line) => `<p>${line}</p>`)
															.join('')
													);
												}
											});
										}
									});

									if ($gm.unsafeWindow.editorPaste) {
										ue.removeListener('beforepaste', $gm.unsafeWindow.editorPaste);
									}
									if ($gm.unsafeWindow.myEditor_paste) {
										ue.removeListener('beforepaste', $gm.unsafeWindow.myEditor_paste);
									}
								}
							}
						} catch {}
					}
				};
			},
			oncomplete() {
				const hackInterval = setInterval(() => {
					if (typeof $gm.unsafeWindow.UE !== 'undefined') {
						clearInterval(hackInterval);
						this.methods.hackEditorPaste();
						console.log('已解除输入框无法复制粘贴限制');
					}
				}, 500);
			}
		}),
		studyDispatcher: new Script({
			name: '课程学习调度器',
			matches: [['课程学习页面', '/mycourse/studentstudy']],
			namespace: 'cx.new.study-dispatcher',
			hideInPanel: true,
			async oncomplete() {
				CommonProject.scripts.render.methods.pin(CXProject.scripts.study);

				let chapters = await CXAnalyses.waitForChapterInfos();

				const params = new URLSearchParams(window.location.href);
				const mooc = params.get('mooc2');
				/** 切换新版 */
				if (mooc === null) {
					params.set('mooc2', '1');
					window.location.replace(decodeURIComponent(params.toString()));
					return;
				}

				// 寻找需要运行的任务
				if (CXProject.scripts.study.cfg.autoJumpToUnFinishJob) {
					// 过滤掉已完成的章节
					chapters = chapters.filter((chapter) => chapter.unFinishCount !== 0);

					if (chapters.length === 0) {
						$message.warn({ content: '页面任务点数量为空! 请刷新重试!' });
					} else {
						const params = new URLSearchParams(window.location.href);
						const courseId = params.get('courseId');
						const classId = params.get('clazzid');
						//  进入需要进行的章节，并且当前章节未被选中
						if ($$el(`.posCatalog_active[id="cur${chapters[0].chapterId}"]`).length === 0) {
							$gm.unsafeWindow.getTeacherAjax(courseId, classId, chapters[0].chapterId);
						}
						await $.sleep(1000);
					}
				}

				// 自动滚动
				await $.sleep(1000);
				CXAnalyses.scrollToActiveChapter();
			}
		}),
		cxSecretFontRecognize: new Script({
			name: '繁体字识别',
			hideInPanel: true,
			matches: [
				['题目页面', 'work/doHomeWorkNew'],
				['考试整卷预览', '/mooc2/exam/preview'],
				['作业', '/mooc2/work/dowork']
			],
			async oncomplete() {
				await mappingRecognize();
			}
		}),
		// 积分课提示
		jfkGuide: new Script({
			name: '💡 积分课使用提示',
			matches: [['积分课页面', '/plaza']],
			namespace: 'cx.jfk.guide',
			configs: {
				notes: {
					defaultValue: $ui.notes([
						'积分课请进入课程后，开启复习模式，并且关闭自动下一章',
						'课程完成后请手动切换，如果由脚本进行自动跳转会出现乱跳转的可能。'
					]).outerHTML
				}
			},
			oncomplete(...args) {
				CommonProject.scripts.render.methods.pin(this);
			}
		})
	}
});

function workOrExam(
	type: 'work' | 'exam' = 'work',
	{
		answererWrappers,
		period,
		thread,
		redundanceWordsText,
		answerSeparators,
		preview_mode
	}: CommonWorkOptions & {
		// 整卷预览模式
		preview_mode: boolean;
	}
) {
	$message.info(`开始${type === 'work' ? '作业' : '考试'}`);

	if (preview_mode) {
		CommonProject.scripts.workResults.methods.init({
			questionPositionSyncHandlerType: 'cx'
		});
	}

	// 处理作业和考试题目的方法
	const workOrExamQuestionTitleTransform = (titles: (HTMLElement | undefined)[]) => {
		// 是否为多个小题的题目
		const is_multiple_question = titles.length > 1;
		const optimizationTitle = titles
			.map((el, i) => {
				if (el) {
					const titleCloneEl = el.cloneNode(true) as HTMLElement;
					const childNodes = titleCloneEl.childNodes;
					// 一般多小题题目只有第一个 title 存在题型文本
					if (i === 0) {
						// 删除序号
						childNodes[0]?.remove();
						// 删除题型
						childNodes[0]?.remove();
					}
					// 显示图片链接在题目中
					return optimizationElementWithImage(titleCloneEl, true).innerText;
				}
				return '';
			})
			.join('\n');

		return removeRedundantWords(
			StringUtils.of(optimizationTitle)
				.nowrap(is_multiple_question ? '\n' : ' ')
				.nospace()
				.toString()
				.trim(),
			redundanceWordsText.split('\n')
		);
	};

	// 这里跟章节测试的连线题不一样，章节测试是新版连线题
	/** 新建答题器 */
	const worker = new OCSWorker({
		root: '.questionLi',
		elements: {
			title: (root) =>
				$$el(
					// 非预览模式的样式跟正常的不一样
					!preview_mode
						? ['.splitS-left .mark_name', '.line_wid_half.fl,.line_wid_half.fr'].join(',')
						: [
								':scope > h3',
								':scope > div:not(.stem_answer,.mark_answer)',
								':scope > p',
								'.line_wid_half.fl,.line_wid_half.fr'
						  ].join(','),
					root
				).filter((e) => !!e.textContent?.trim()),
			options: '.answerBg .answer_p, .textDIV, .eidtDiv',
			type: type === 'exam' ? 'input[name^="type"]' : 'input[id^="answertype"]',
			lineAnswerInput: '.line_answer input[name^=answer]',
			lineSelectBox: '.line_answer_ct .selectBox ',
			/** 阅读理解 */
			reading: '.reading_answer',
			/** 完形填空 */
			filling: '.filling_answer'
		},
		thread: thread ?? 1,
		answerSeparators: answerSeparators.split(',').map((s) => s.trim()),
			/** 默认搜题方法构造器 */
			answerer: async (elements, ctx) => {
				if (elements.title) {
					// 处理作业和考试题目
					const title = workOrExamQuestionTitleTransform(elements.title);
					if (title) {
						const typeInput = elements.type[0] as HTMLInputElement;
						const type = (typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined) || 'unknown';
						const optionTexts = ctx.elements.options.map((o) => optimizationElementWithImage(o, true).innerText);

						/**
						 * AI 答题模式：自动提取图片并调用 AI
						 */
						if (isAIEnabled()) {
							const aiConfig = getAIConfig();
							const titleElements = elements.title || [];
							const imageElements = [...titleElements, ...(elements.options || [])];
							await $.sleep((period ?? 3) * 1000);
							return aiWorkAnswerer(
								aiConfig,
								{
									title,
									options: type === 'completion' ? [] : optionTexts,
									type
								},
								imageElements,
								undefined,
								titleElements.length
							);
						}

						await $.sleep((period ?? 3) * 1000);
						return defaultAnswerWrapperHandler(answererWrappers, {
							type,
							title,
							options:
								type === 'completion'
									? ''
									: optionTexts.join('\n')
						});
					} else {
						throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
					}
				} else {
					throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
				}
			},

		work: async (ctx) => {
			const { elements, searchInfos } = ctx;

			// 在非预览模式下会出现多个干扰项 type，这里提取正确的

			const type = getQuestionType(
				parseInt(elements.type.find((t) => t.getAttribute('name')?.match(/type\d+/))?.getAttribute('value') || '-1')
			);

			if (type && (type === 'completion' || type === 'multiple' || type === 'judgement' || type === 'single')) {
				const resolver = createDefaultQuestionResolver(ctx)[type];
				return await resolver(
					searchInfos,
					elements.options.map((option) => optimizationElementWithImage(option)),
						async (type, answer, option) => {
							// 如果存在已经选择的选项
							if (type === 'judgement' || type === 'single' || type === 'multiple') {
								// @ts-ignore 调试日志
								console.log('[回填调试] 进入点击回调', { type, answer, hasOption: !!option, optionTag: option && option.tagName });
								if (option?.parentElement && $$el('[class*="check_answer"]', option.parentElement).length === 0) {
									// 优先 CDP 真实点击（isTrusted=true），无守护进程时降级 JS 点击
									const trusted = await trustedClick(option as HTMLElement);
									// @ts-ignore 调试日志
									console.log('[回填调试] trustedClick=', trusted, trusted ? '' : '→ JS点击兜底');
									if (!trusted) option.click();
									await $.sleep(500);
									// @ts-ignore 调试日志
									console.log('[回填调试] 点击后 check_answer 数', $$el('[class*="check_answer"]', option.parentElement || document).length);
								} else {
									// @ts-ignore 调试日志
									console.log('[回填调试] 跳过点击：', option ? '已有选中' : '无选项元素');
								}
							} else if (type === 'completion' && answer.trim()) {
							const text = option?.querySelector('textarea');
							const textareaFrame = option?.querySelector('iframe');
							if (text) {
								text.value = answer;
							}
							if (textareaFrame?.contentDocument) {
								textareaFrame.contentDocument.body.innerHTML = answer;
							}
							if (option?.parentElement?.parentElement) {
								/** 如果存在保存按钮则点击 */
								$el('[onclick*=saveQuestion]', option?.parentElement?.parentElement)?.click();
								await $.sleep(500);
							}
						}
					}
				);
			}
			// 连线题自定义处理
			else if (type && type === 'line') {
				for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
					let ans = answers;
					if (ans.length === 1) {
						ans = splitAnswer(ans[0]);
					}
					if (
						ans.filter(Boolean).length !== 0 &&
						elements.lineAnswerInput &&
						ans.filter(Boolean).length === elements.lineSelectBox.length
					) {
						//  选择答案
						for (let index = 0; index < elements.lineSelectBox.length; index++) {
							const box = elements.lineSelectBox[index];
							if (ans[index]) {
								$el(`li[data=${ans[index]}] a`, box)?.click();
								await $.sleep(200);
							}
						}

						return { finish: true };
					}
				}

				return { finish: false };
			}
			// 完形填空
			else if (type && type === 'fill') {
				return readerAndFillHandle(searchInfos, elements.filling);
			}
			// 阅读理解
			else if (type && type === 'reader') {
				return readerAndFillHandle(searchInfos, elements.reading);
			}

			return { finish: false };
		},

		/** 完成答题后 */
		async onResultsUpdate(current, _, res) {
			// 非预览模式，直接追加，想要清楚只能手动清空
			if (!preview_mode) {
				if (current.result?.finish) {
					await CommonProject.scripts.workResults.methods.appendResults(
						simplifyWorkResult(res, workOrExamQuestionTitleTransform)
					);
				}
				return;
			}

			CommonProject.scripts.workResults.methods.setResults(simplifyWorkResult(res, workOrExamQuestionTitleTransform));
			CommonProject.scripts.workResults.methods.updateWorkStateByResults(res);
			if (current.result?.finish) {
			}
		}
	});

	if (preview_mode) {
		worker
			.doWork()
			.then(async () => {
				// 整卷预览模式：不自动提交（预览就是看答案用）
				$message.info({ content: '作业/考试完成，请自行检查后保存或提交。', duration: 0 });
				worker.emit('done');
			})
			.catch((err) => {
				console.error(err);
				$message.error('答题程序发生错误 : ' + err.message);
			});
	} else {
		const getNextBtn = () => document.querySelector('[onclick="getTheNextQuestion(1)"]') as HTMLElement;
		let next = getNextBtn();

		(async () => {
			while (next && worker.isClose === false) {
				await worker.doWork({ enable_debug: BackgroundProject.scripts.dev.cfg.enable_answerer_debug });
				$message.info({ content: '已完成，即将下一题', duration: 0 });
				await $.sleep(3000);
				next = getNextBtn();
				next?.click();
				await $.sleep(1000);
			}

			// 所有题目答完后自动保存/提交（2026-10-20 新增）
			// 旧逻辑只弹一句"请自行检查后保存或提交"，什么都不做 —— 作业/考试永远不会自动提交。
			await autoSubmitWorkOrExam(worker);

			worker.emit('done');
			// 搜索完成后才会同步答案与题目的显示，防止题目错乱
			CommonProject.scripts.workResults.cfg.questionPositionSyncHandlerType = 'cx';
		})();
	}

	return worker;
}

/**
 * 作业/考试 自动保存或提交（含校验与重试）
 *
 * 超星作业页的提交入口：
 *   · 保存：`[onclick*=saveQuestion]` 或文本为「暂时保存」的按钮
 *   · 提交：文本为「提交」的按钮 → 弹出确认框 → 点「确定」
 *
 * 流程：逐题检查是否作答 → 全部有答案才提交，否则仅保存（防白卷）→
 *       提交后校验状态，失败重试，重试用尽则告警且不再继续。
 */
async function autoSubmitWorkOrExam(worker: any): Promise<void> {
	// ⚠️ 全局设置 upload 的类型是 WorkUploadType：
	//    'nomove' | 'save' | 'force' | number(10~100 的完成率阈值)
	//    不是 boolean！早期写成 `cfg.upload === true` 会恒为 false，
	//    导致作业/考试永远只保存、从不提交。
	const uploadSetting = CommonProject.scripts.settings.cfg.upload;
	const isNoMove = uploadSetting === 'nomove';
	const isForce = uploadSetting === 'force';

	if (isNoMove) {
		$message.info({ content: '全局设置为「不保存也不提交」，跳过自动提交。', duration: 0 });
		return;
	}

	/** 找当前作业文档（可能在 iframe 里） */
	const findWorkDoc = (): Document | null => {
		const tryDoc = (d: Document | null | undefined): Document | null => {
			if (!d) return null;
			try {
				if (d.querySelector('.TiMu')) return d;
			} catch {}
			return null;
		};
		const own = tryDoc(document);
		if (own) return own;
		try {
			const walk = (win: any, depth: number): Document | null => {
				if (depth > 4 || !win) return null;
				try {
					for (const f of win.document.querySelectorAll('iframe')) {
						try {
							const d = f.contentDocument;
							const hit = tryDoc(d);
							if (hit) return hit;
						} catch {}
					}
					for (let i = 0; i < win.frames.length; i++) {
						const r = walk(win.frames[i], depth + 1);
						if (r) return r;
					}
				} catch {}
				return null;
			};
			return walk(window.top, 0);
		} catch {
			return null;
		}
	};

	await $.sleep(2000);
	const doc = findWorkDoc();
	if (!doc) {
		$message.warn({ content: '未找到作业页面，跳过自动提交。', duration: 0 });
		return;
	}

	/** 统计未作答的题号 */
	const countBlank = (): number[] => {
		const blankNos: number[] = [];
		try {
			const tms = Array.from(doc.querySelectorAll('.TiMu'));
			tms.forEach((tm, i) => {
				if (tm.querySelector('.TiMu')) return; // 组合题容器跳过
				const answered =
					!!tm.querySelector('[class*="check_answer"], input:checked') ||
					Array.from(tm.querySelectorAll('textarea')).some(
						(t) => (((t as HTMLTextAreaElement).value || '') + '').trim().length > 0
					);
				if (!answered) blankNos.push(i + 1);
			});
		} catch {}
		return blankNos;
	};

	/** 找按钮（按文本） */
	const findBtn = (re: RegExp): HTMLElement | null => {
		const nodes = Array.from(doc.querySelectorAll<HTMLElement>('button, a, div[onclick], input[type=button], span')) as HTMLElement[];
		return (
			nodes.find((b) => {
				const txt = ((b.innerText || (b as any).value || '') + '').trim();
				if (!re.test(txt)) return false;
				// 必须可见
				return !!b.offsetParent || b.getClientRects().length > 0;
			}) || null
		);
	};

	const blankNos = countBlank();
	// 提交判定（与章节测验 uploadHandler 的语义保持一致）：
	//   force      → 强制提交
	//   'save'     → 只保存
	//   数字 N     → 答对/查到答案的题占比 ≥ N% 才提交（这里用"无空题"近似）
	// 另外：只要有题没作答，一律降级为仅保存，绝不提交白卷。
	const allAnswered = blankNos.length === 0;
	const willUpload = isForce ? true : allAnswered && uploadSetting !== 'save';

	if (blankNos.length) {
		const preview = blankNos.slice(0, 10).join('、');
		$console.warn(`⚠️ 还有 ${blankNos.length} 道题未作答（第 ${preview}${blankNos.length > 10 ? '…' : ''} 题），改为仅保存不提交`);
		$message.warn({ content: `⚠️ 还有 ${blankNos.length} 道题未作答，改为仅保存不提交`, duration: 8 });
	} else {
		$console.info(`全部题目已作答（共 ${doc.querySelectorAll('.TiMu').length} 题），${willUpload ? '准备提交' : '准备保存'}`);
	}

	const MAX_ATTEMPTS = 3;
	let done = false;

	for (let attempt = 1; attempt <= MAX_ATTEMPTS && !done; attempt++) {
		try {
			if (willUpload) {
				// 提交
				const submitBtn = findBtn(/^提交$|^提\s*交$|提交作业|提交试卷/);
				if (!submitBtn) {
					$console.warn('[作业提交] 找不到提交按钮，尝试保存');
				} else {
					$console.log('[作业提交] 点击提交按钮（第' + attempt + '次）');
					submitBtn.click();
					await $.sleep(2000);
					// 确认弹窗：确定/确认
					const okBtn = findBtn(/^(确定|确认|是)$/);
					if (okBtn) {
						okBtn.click();
						$console.log('[作业提交] 已点击确认');
					}
					await $.sleep(3000);
				}
			} else {
				// 仅保存
				const saveBtn = findBtn(/暂时保存|保存/);
				if (saveBtn) {
					$console.log('[作业保存] 点击保存按钮（第' + attempt + '次）');
					saveBtn.click();
					await $.sleep(2000);
					const okBtn = findBtn(/^(确定|确认|是)$/);
					if (okBtn) okBtn.click();
					await $.sleep(2500);
				} else {
					$console.warn('[作业保存] 找不到保存按钮');
					break;
				}
			}

			// 校验：提交/保存后按钮应消失或置灰，或出现"已完成"类提示
			const stillHasSubmit = !!findBtn(/^提交$|^提\s*交$|提交作业|提交试卷/);
			const pageText = ((doc.body && doc.body.innerText) || '').replace(/\s+/g, '');
			const hasDoneHint = /已提交|已完成|已保存|提交成功|保存成功/.test(pageText);
			done = hasDoneHint || !stillHasSubmit;
			// @ts-ignore 调试日志
			console.log('[作业提交校验] 第' + attempt + '次', { willUpload, done, hasDoneHint, stillHasSubmit });
			if (!done && attempt < MAX_ATTEMPTS) {
				$console.warn('[作业提交校验] 未确认成功，重试…');
				await $.sleep(2000);
			}
		} catch (e: any) {
			$console.warn('[作业提交] 第' + attempt + '次异常:', e && e.message);
			await $.sleep(2000);
		}
	}

	if (done) {
		$message.success({ content: willUpload ? '作业/考试已提交' : '作业/考试已保存', duration: 0 });
	} else {
		const warn = `⚠️ ${willUpload ? '提交' : '保存'}未确认成功（已重试 ${MAX_ATTEMPTS} 次），请手动检查`;
		$console.error(warn);
		// 只用页面内提示，不发系统通知（系统通知是扩展级的，会出现在所有页面上且不自动消失）
		$message.error({ content: warn, duration: 0 });
	}
}

/**
 * 繁体字识别-字典匹配
 * @see 参考 https://bbs.tampermonkey.net.cn/thread-2303-1-1.html
 */
async function mappingRecognize(doc: Document = document) {
	let typrMapping = Object.create({});
	// 优先用内置字库（347KB，20906 条）：不再依赖 cdn.ocsjs.com
	// 实测外网不可达时 loadTyprMapping() 会静默返回 undefined，导致解密永远不完成、
	// 题干一直是密文乱码（曾因此卡住整个章节测验）。
	const LOCAL = LOCAL_FONT_MAPPING;
	if (LOCAL && Object.keys(LOCAL).length > 0) {
		typrMapping = LOCAL;
	} else {
		try {
			// @ts-ignore
			top.typrMapping = top.typrMapping || (await loadTyprMapping());
			// @ts-ignore
			typrMapping = top.typrMapping;
		} catch {
			// 超星考试可能嵌套其他平台中，所以会存在跨域，这里需要处理一下跨域情况，如果是跨域直接在当前页面加载字库
			typrMapping = await loadTyprMapping();
		}
	}

	/** 判断是否有繁体字 */
	const fontFaceEl = Array.from(doc.head.querySelectorAll('style')).find((style) =>
		style.textContent?.includes('font-cxsecret')
	);

	const base64ToUint8Array = (base64: string) => {
		const data = window.atob(base64);
		const buffer = new Uint8Array(data.length);
		for (let i = 0; i < data.length; ++i) {
			buffer[i] = data.charCodeAt(i);
		}
		return buffer;
	};

	const fontMap = typrMapping;
	if (fontFaceEl && Object.keys(fontMap).length > 0) {
		// 解析 font-cxsecret 字体。
		// ⚠️ base64 的结尾引号两种都可能（' 或 "），旧代码只匹配单引号，
		//    遇到双引号时 font 为 undefined → 静默跳过解密 → 题干一直是密文乱码。
		const font =
			fontFaceEl.textContent?.match(/base64,([\w\W]+?)'/)?.[1] ||
			fontFaceEl.textContent?.match(/base64,([\w\W]+?)"/)?.[1] ||
			fontFaceEl.textContent?.match(/base64,([\s\S]*?)\)/)?.[1] ||
			null;

		if (font) {
			$console.log('正在识别繁体字');

			const code = Typr.parse(base64ToUint8Array(font));

			// 匹配解密字体
			const match: any = {};
			for (let i = 19968; i < 40870; i++) {
				// 中文[19968, 40869]
				const Glyph = Typr.U.codeToGlyph(code, i);
				if (!Glyph) continue;
				const path = Typr.U.glyphToPath(code, Glyph);
				const hex = md5(JSON.stringify(path)).slice(24); // 8位即可区分
				match[i.toString()] = fontMap[hex];
			}
			const fonts = CXAnalyses.getSecretFont(doc);
			// 替换加密字体
			fonts.forEach((el, index) => {
				let html = el.innerHTML;
				for (const key in match) {
					const word = String.fromCharCode(parseInt(key));
					const value = String.fromCharCode(match[key]);

					// 如果相同，则不需要替换
					if (word === value) {
						continue;
					}

					while (html.indexOf(word) !== -1) {
						html = html.replace(word, value);
					}
				}

				el.innerHTML = html;
				el.classList.remove('font-cxsecret'); // 移除字体加密
			});

			$console.log('识别繁体字完成。');
		} else {
			$console.log('未检测到繁体字。');
		}
	}
}

async function loadTyprMapping() {
	try {
		$console.log('正在加载繁体字库。');
		return await request('https://cdn.ocsjs.com/resources/font/table.json', {
			type: 'GM_xmlhttpRequest',
			method: 'get',
			responseType: 'json'
		});
	} catch (err) {
		$console.error('载繁体字库加载失败，请刷新页面重试：', String(err));
	}
}

/**
 * cx分析工具
 */
const CXAnalyses = {
	/** 是否处于闯关模式或者解锁模式 */
	isInSpecialMode() {
		return Array.from(top?.document.querySelectorAll('.catalog_points_sa,.catalog_points_er') || []).length !== 0;
	},
	/** 是否为闯关模式，并且当前章节卡在最后一个待完成的任务点 */
	async isStuckInBreakingMode() {
		if (this.isInSpecialMode()) {
			const chapter = top?.document.querySelector<HTMLElement>('.posCatalog_active');
			if (chapter) {
				const id = chapter.getAttribute('id');
				if (id) {
					// 超星好像会重绘组件，导致无法绑定属性到元素中，所以这里使用页面全局变量存储
					const counter = (await $store.getTab('chapter_counter')) || Object.create({});
					let count = Reflect.get(counter, id);
					count = count ? count + 1 : 1;
					Reflect.set(counter, id, count);

					let res = false;
					if (count >= 3) {
						Reflect.set(counter, id, 1);
						res = true;
					}
					await $store.setTab('chapter_counter', counter);
					return res;
				}
			}
		}
		return false;
	},
	/**
	 * 是否处于最后一小节
	 * 当小节为0，返回 true
	 */
	isInFinalTab() {
		// 上方小节任务栏
		const tabs = Array.from<HTMLElement>(top?.document.querySelectorAll('.prev_ul li') || []);
		if (tabs.length === 0) {
			return true;
		}
		return tabs[tabs.length - 1].classList.contains('active');
	},
	/** 是否处于最后一个章节 */
	isInFinalChapter() {
		return Array.from(top?.document.querySelectorAll('.posCatalog_select') || [])
			.pop()
			?.classList.contains('posCatalog_active');
	},
	/** 是否完成全部章节 */
	isFinishedAllChapters() {
		return this.getChapterInfos().every((chapter) => chapter.unFinishCount === 0);
	},
	/** 获取所有章节信息 */
	getChapterInfos() {
		return Array.from(top?.document.querySelectorAll('[onclick^="getTeacherAjax"]') || []).map((el) => ({
			element: el as HTMLElement,
			chapterId: el.getAttribute('onclick')?.match(/\('(.*)','(.*)','(.*)'\)/)?.[3],
			// @ts-ignore
			unFinishCount: parseInt(el.parentElement.querySelector('.jobUnfinishCount')?.value || '0')
		}));
	},
	scrollToActiveChapter() {
		const activeChapter = top?.document.querySelector<HTMLElement>('.posCatalog_active');
		if (activeChapter) {
			activeChapter.scrollIntoView({ behavior: 'smooth', block: 'center' });
		}
	},
	/**
	 * 等待并获取章节信息，直到获取到章节信息为止
	 * - 可设置超时时间（单位秒），默认10秒
	 * - 超时后返回空数组
	 */
	waitForChapterInfos(timeout = 10) {
		return new Promise<any[]>((resolve, reject) => {
			const interval = setInterval(() => {
				const res = this.getChapterInfos();
				if (res.length > 0) {
					clearInterval(interval);
					clearInterval(to);
					resolve(res);
				}
			}, 1000);

			const to = setTimeout(() => {
				clearInterval(interval);
				resolve([]);
			}, timeout * 1000);
		});
	},
	/** 检测页面是否使用字体加密 */
	getSecretFont(doc: Document = document) {
		return Array.from(doc.querySelectorAll('.font-cxsecret')).map((font) => {
			// 这里吧选项按钮和文字分离，如果不分离的话 .font-cxsecret 元素下面还包含选项按钮时，替换时会吧按钮也删除掉导致选项按钮不可用
			const after = font.querySelector('.after');
			return after === null ? font : after;
		}) as HTMLElement[];
	},
	/**
	 * 检测当前章节是否完成
	 */
	isCurrentChapterFinished() {
		const job = top?.document.querySelector('.posCatalog_active');
		if (job) {
			if (job.querySelector('.icon_Completed') !== null) {
				return true;
			}
		}
		return false;
	}
};

/**
 * 屏蔽倍速限制
 */
function rateHack() {
	state.study.hacked = false;
	let dragCount = 0;
	try {
		hack();
		window.document.addEventListener('readystatechange', hack);
		window.addEventListener('load', hack);
	} catch (e) {
		console.error(e);
	}

	function hack() {
		const videojs = $gm.unsafeWindow.videojs;
		const Ext = $gm.unsafeWindow.Ext;

		if (typeof videojs !== 'undefined' && typeof Ext !== 'undefined') {
			if (state.study.hacked) {
				return;
			}
			state.study.hacked = true;

			const _origin = videojs.getPlugin('seekBarControl');
			const plugin = videojs.extend(videojs.getPlugin('plugin'), {
				constructor: function (videoExt: any, data: any) {
					const _sendLog = data.sendLog;
					data.sendLog = (...args: any[]) => {
						if (args[1] === 'drag') {
							dragCount++;
							// 开始播放的时候偶尔会卡顿，导致一直触发 drag 事件（超星的BUG）
							// 这里如果卡顿太多，尝试暂停视频，然后等待视频自动开始。
							if (dragCount > 100) {
								dragCount = 0;
								$el('video')?.pause();
							}
						} else {
							_sendLog.apply(data, args);
						}
					};

					_origin.apply(_origin.prototype, [videoExt, data]);
				}
			});

			videojs.registerPlugin('seekBarControl', plugin);

			// 重写超星视频插件
			Ext.define('ans.VideoJs', {
				override: 'ans.VideoJs',
				constructor: function (data: any) {
					this.addEvents(['seekstart']);
					this.mixins.observable.constructor.call(this, data);
					const vjs = videojs(data.videojs, this.params2VideoOpt(data.params), function () {});
					Ext.fly(data.videojs).on('contextmenu', function (f: any) {
						f.preventDefault();
					});
					Ext.fly(data.videojs).on('keydown', function (f: any) {
						if (f.keyCode === 32 || f.keyCode === 37 || f.keyCode === 39 || f.keyCode === 107) {
							f.preventDefault();
						}
					});

					// 保存清晰度设置
					if (vjs.videoJsResolutionSwitcher) {
						vjs.on('resolutionchange', function () {
							const cr = vjs.currentResolution();
							const re = cr.sources ? cr.sources[0].res : false;
							Ext.setCookie('resolution', re);
						});
					}

					// 保存公网设置
					if (vjs.videoJsPlayLine) {
						vjs.on('playlinechange', function () {
							const cp = vjs.currentPlayline();
							Ext.setCookie('net', cp.net);
						});
					}

					// 下面连着一个倍速限制方法，这里直接不写，实现可以倍速
				}
			});
		}
	}
}

/**
 * cx 任务学习
 */
/**
 * 全局任务闸门（2026-10-18 根治版）
 *
 * 历史缺陷：`searchJob` 在"找到任务点"时就把它 push 进 searchedJobs，
 * 而 `runJobs` 在 `job.func()` 返回后立刻递归搜下一个 —— 只要 func 内部还有
 * 异步（AI 答题 10~40 秒），就会出现：
 *   · 同一任务点被并发触发多次 → 同一题重复发到 AI
 *   · 多个任务点同时读同一份卷子 DOM → 题干串位（出现乱码/串题）
 *   · 答题未完成就推进到下一节 → "没答完就翻页"
 *
 * 根治方式：一个进程内所有任务点执行严格串行。闸门是全局单例，
 * 跨 study() 实例共享，不依赖 DOM 状态，也不依赖页面是否刷新。
 */
const CX_TASK_GATE_KEY = '__cxTaskGate';

type CxTaskGate = {
	/** 当前正在执行的任务点 mid（空 = 空闲） */
	running: string | null;
	/** 串行队列尾（Promise 链） */
	tail: Promise<any>;
	/**
	 * 已完成任务点 mid → 完成时间戳。
	 * 带时效（10 分钟）：避免"刷新页面后重进同一章节"被永久跳过，
	 * 同时足够覆盖同一轮学习内的重复触发。
	 */
	done: Map<string, number>;
};

const CX_TASK_DONE_TTL = 10 * 60 * 1000;

function getTaskGate(): CxTaskGate {
	const g = globalThis as any;
	if (!g[CX_TASK_GATE_KEY]) {
		g[CX_TASK_GATE_KEY] = {
			running: null,
			tail: Promise.resolve(),
			done: new Map<string, number>()
		} as CxTaskGate;
	}
	return g[CX_TASK_GATE_KEY] as CxTaskGate;
}

/**
 * 以串行方式执行一个任务点。
 * 同一 mid 在 TTL 内只执行一次；不同 mid 也排队执行，绝不并发。
 */
function runTaskSerial<T>(mid: string, task: () => Promise<T>): Promise<T | undefined> {
	const gate = getTaskGate();
	const finishedAt = gate.done.get(mid);
	if (finishedAt && Date.now() - finishedAt < CX_TASK_DONE_TTL) {
		// @ts-ignore 调试日志
		console.log('[study日志] 任务点已完成过，跳过:', mid);
		return Promise.resolve(undefined);
	}
	const next = gate.tail
		.catch(() => {})
		.then(async () => {
			gate.running = mid;
			try {
				const r = await task();
				gate.done.set(mid, Date.now());
				// 顺手清理过期项，避免无限增长
				for (const [k, ts] of gate.done) {
					if (Date.now() - ts > CX_TASK_DONE_TTL) gate.done.delete(k);
				}
				return r;
			} finally {
				gate.running = null;
			}
		});
	gate.tail = next.catch(() => {});
	return next;
}

export async function study(
	opts: typeof CXProject.scripts.study.cfg & {
		workOptions: CommonWorkOptions;
	}
) {
	await $.sleep(3000);

	// 重入保护：已有 study() 正在执行任务点时，本次直接退出。
	// 闸门是全局单例（不依赖 window.top，跨域也能用），避免多份 study() 并行读同一份卷子。
	const gate = getTaskGate();
	if (gate.running) {
		console.warn('[study日志] 已有任务点在执行(' + gate.running + ')，跳过本次 study() 重复触发');
		return;
	}

	// 开新一轮刷课前清空桥接队列：上一轮遗留的题（发题端早已超时离开）不会有人认领，
	// 留着只会干扰本轮判断。放在 study() 是因为它就是一键启动刷课的入口；
	// 绝不能放在 AI 桥接页的 onstart —— 那边每次页面加载都跑，会把正在发的题清掉。
	try {
		$gm.unsafeWindow.GM_setValue && $gm.unsafeWindow.GM_setValue('ai_bridge_queue', '{}');
	} catch {}
	try {
		const w: any = window.top as any;
		if (w && w.GM_setValue) w.GM_setValue('ai_bridge_queue', '{}');
	} catch {}

	const searchedJobs: Job[] = [];

	let searching = true;

	let attachmentCount: number = $gm.unsafeWindow.attachments?.length || 0;
	// 2026-09-21：新版学习页（音乐鉴赏等新课程实测）顶层不再定义 window.attachments，
	// 未知时给默认搜索配额——searchJob 靠扫描 iframe 找任务点，配额只影响空搜几次后放弃
	if (!($gm.unsafeWindow as any).attachments) attachmentCount = 5;
	// @ts-ignore 调试日志
	console.log('[study日志] study() 启动', { attachmentCount, mode: CXProject.scripts.study.cfg.mode, url: location.href.substring(0, 80) });

	const wait_timeout = 3 + attachmentCount * 2;

	/** 考虑到网速级慢的同学，所以10秒后如果还没有任务点才停止 */
	setTimeout(() => {
		searching = false;
	}, Math.min(wait_timeout, 10) * 1000);

	/**
	 * 递归运行任务点，一旦有新的任务点被检测到直接开始
	 * 如果10秒内既没有任务点，也暂停了搜索，则当前则没有任务点
	 */
	const runJobs = async () => {
		const job = searchJob(opts, searchedJobs);
		// @ts-ignore 调试日志（发布前可移除）
		console.log('[study日志] searchJob =>', job ? `mid=${job.mid} type=${job.attachment.type} job=${!!job.attachment.job}` : 'null', `已搜=${searchedJobs.length} 剩余配额=${attachmentCount} searching=${searching}`);
		// 如果存在任务点
		if (job && job.func) {
			// 根治：经闸门串行执行。闸门内部保证同一 mid 只跑一次、
			// 且必须等 func() 真正 resolve 后才允许下一个任务点开始。
			await runTaskSerial(job.mid, async () => {
				try {
					await job.func!();
				} catch (e: any) {
					$console.error('未知错误', e);
					// @ts-ignore
					console.error('[study日志] job执行异常:', e && e.message, e);
				}
			});

			await $.sleep(1000);
			await runJobs();
		}
		// 每次 search 一次，就减少一次文件数量
		// 如果不加这个判断，三个任务中，中间的任务不是任务点，则会导致下面的任务全部不执行。
		else if (attachmentCount > 0) {
			attachmentCount--;
			await $.sleep(1000);
			await runJobs();
		}
		// 或者正在搜索
		else if (searching) {
			await $.sleep(1000);
			await runJobs();
		}
	};

	await runJobs();

	// 根治「没答完就翻页」：
	// runJobs 会在配额耗尽/搜索超时时提前返回，但任务点（尤其章节测验）可能仍在执行。
	// 推进下一章前必须等闸门彻底空闲，否则会在答题中途切走页面，
	// 造成"题没答完就点下一页"、以及切页导致的题干错位。
	{
		const g = getTaskGate();
		let guard = 0;
		while (g.running && guard++ < 600) {
			// @ts-ignore 调试日志
			console.log('[study日志] 等待任务点完成再翻页:', g.running);
			await $.sleep(1000);
		}
		await g.tail.catch(() => {});
		if (guard >= 600) {
			$console.warn('[study日志] 等待任务点超时(10分钟)，仍继续后续流程');
		}
	}

	// @ts-ignore
	top._preChapterId = '';

	// 下一章
	const next = async () => {
		if (CXAnalyses.isInFinalTab()) {
			if (await CXAnalyses.isStuckInBreakingMode()) {
				return $modal.alert({
					content:
						'检测到当前课程为闯关模式（有小旗帜图标）, 但是已经重复进入多次，应该是章节测试没有完成，或者其他情况导致，请手动完成章节测试，然后手动点击下一章。'
				});
			}
		}

		if (CXAnalyses.isInFinalChapter()) {
			let content = '';

			if (opts.backToFirstWhenFinish) {
				content = '已经抵达最后一个章节，10秒后返回第一个章节重新开始。';
				setTimeout(() => {
					top?.document.querySelector<HTMLElement>('.posCatalog_name')?.click();
				}, 10 * 1000);

				$message.info({ content, duration: 30 });
			} else {
				if (CXAnalyses.isFinishedAllChapters()) {
					content = '全部任务点已完成！';
				} else {
					content = '已经抵达最后一个章节！但仍然有任务点未完成，请手动切换至未完成的章节。';
				}

				$modal.alert({ content: content });
			}

			CommonProject.scripts.settings.methods.notificationBySetting(content, {
				duration: 0,
				extraTitle: '超星学习通学习脚本'
			});
			return;
		}

		if (CXProject.scripts.study.cfg.mode === 'job') {
			// 检测当前章节是否完成，如果已经完成则下一章
			// 如果没有需要完成的章节，则暂停运行

			if (CXAnalyses.isInFinalTab()) {
				// 找到未完成
				const elements = CXAnalyses.getChapterInfos()
					.filter((el) => el.unFinishCount > 0 || el.element.parentElement?.classList.contains('posCatalog_active'))
					.map((el) => el.element.parentElement as HTMLElement);
				if (elements.length === 0) {
					const content = '全部任务点已完成！';
					$modal.alert({ content: content });
					CommonProject.scripts.settings.methods.notificationBySetting(content, {
						duration: 0,
						extraTitle: '超星学习通学习脚本'
					});
					return;
				}

				let nextChapter = elements[0];
				// 如果当前章节未完成，则跳转到下一个未完成章节
				const currentIndex = elements.findIndex((el) => el.classList.contains('posCatalog_active'));
				if (currentIndex !== -1 && currentIndex + 1 < elements.length) {
					nextChapter = elements[currentIndex + 1];
					CXAnalyses.scrollToActiveChapter();
					setTimeout(() => {
						nextChapter.querySelector<HTMLElement>('.posCatalog_name')?.click();
					}, 1000);
				}
			}
		} else if (CXProject.scripts.study.cfg.mode === 'next') {
			const curCourseId = $el<HTMLInputElement>('#curCourseId', top?.document);
			const curChapterId = $el<HTMLInputElement>('#curChapterId', top?.document);
			const curClazzId = $el<HTMLInputElement>('#curClazzId', top?.document);
			const count = $$el('#prev_tab .prev_ul li', top?.document);

			// 自动下一个小节（点击下一节）
			if (curChapterId && curCourseId && curClazzId) {
				// @ts-ignore
				top._preChapterId = curChapterId.value;
				CXAnalyses.scrollToActiveChapter();
				// 等待跳转动画完成
				await $.sleep(200);

				/**
				 * count, chapterId, courseId, clazzid, knowledgestr, checkType
				 * checkType 就是询问当前章节还有任务点未完成，是否完成，这里直接不传，默认下一章
				 */
				// @ts-ignore
				top?.PCount.next(count.length.toString(), curChapterId.value, curCourseId.value, curClazzId.value, '');
			} else {
				$console.warn('参数错误，无法跳转下一章，请尝试手动切换。');
			}
		} else {
			$console.warn('未知的跳转模式，请联系作者反馈');
		}
	};

	// 2026-09-21 新版学习页适配：章节内按卡片逐个加载（学习目标→视频→章节测验…），
	// 每张卡片的任务点数据（attachments）只在切到该卡片时才加载。
	// 当前卡片任务完成或无任务时，自动点击下一张卡片标签；
	// 新卡片 iframe 重载会重新触发 study()。走到章节最后一张卡片才走原收尾逻辑。
	try {
		const cardTabs = $$el('#prev_tab .prev_ul li', top?.document);
		const activeIdx = cardTabs.findIndex((li) => (li as HTMLElement).classList.contains('active'));
		const nextCard = activeIdx >= 0 ? cardTabs[activeIdx + 1] : undefined;
		if (nextCard) {
			const msg = '当前卡片任务完成，自动切换下一张卡片：' + (nextCard.textContent || '').replace(/\s+/g, '').trim();
			$message.info({ content: msg });
			$console.info(msg);
			// @ts-ignore
			console.log('[study日志] 卡片推进', { activeIdx, total: cardTabs.length });
			// 结论阶段的点击可能被页面繁忙期静默吞掉（实测 6.3 视频播完后点击无效果），
			// 点击后验证 active 是否切换，未切换则重试（最多 3 次：真实点击/JS点击/子元素点击）
			for (let attempt = 1; attempt <= 3; attempt++) {
				await $.sleep(1000);
				if (attempt === 1) {
					if (!(await trustedClick(nextCard as HTMLElement))) (nextCard as HTMLElement).click();
				} else if (attempt === 2) {
					(nextCard as HTMLElement).click();
				} else {
					// 点它的内部元素（span.num / spanText），走不同的事件路径
					const inner = (nextCard as HTMLElement).querySelector('span');
					(inner || nextCard).click();
				}
				await $.sleep(3000);
				const nowTabs = $$el('#prev_tab .prev_ul li', top?.document);
				const nowActive = nowTabs.findIndex((li) => (li as HTMLElement).classList.contains('active'));
				if (nowActive === activeIdx + 1) return; // 已切换
				// @ts-ignore
				console.log('[study日志] 卡片推进未生效，重试', { attempt });
			}
			return;
		}
	} catch (e: any) {
		// @ts-ignore
		console.log('[study日志] 卡片推进失败:', e && e.message);
	}

	// 2026-09-22 章节完成自动进下一章：新版学习页的 PCount.next 不可靠（实测静默无效）。
	// 优先直接调 getTeacherAjax 跳章（函数级调用，实测可靠）；
	// 树节点点击在提交后的页面繁忙期可能静默无效（实测 3.1→3.2 触发了点击但未导航），
	// 故点击只作兜底，且 8 秒未跳转自动重试
	const gotoNextChapter = async (): Promise<boolean> => {
		try {
			const topWin: any = window.top;
			const href = (topWin && topWin.location.href) || '';
			const curId = (href.match(/chapterId=(\d+)/) || [])[1];
			const courseId = (href.match(/courseId=(\d+)/) || [])[1];
			const clazzid = (href.match(/clazzid=(\d+)/) || [])[1];
			if (!curId) return false;
			const walk = (win: any, d: number): HTMLElement | undefined => {
				if (d > 4 || !win) return undefined;
				try {
					const items: HTMLElement[] = Array.from(
						(win.document as Document).querySelectorAll('[id^="cur"]')
					) as HTMLElement[];
					const idx = items.findIndex((el: HTMLElement) => el.id === 'cur' + curId);
					if (idx >= 0 && items[idx + 1]) return items[idx + 1];
					for (let i = 0; i < win.frames.length; i++) {
						const r = walk(win.frames[i], d + 1);
						if (r) return r;
					}
				} catch {}
				return undefined;
			};
			const next = walk(window, 0) || walk(topWin, 0);
			if (next) {
				const msg = '本章任务完成，进入下一节：' + (next.textContent || '').replace(/\s+/g, '').slice(0, 20);
				$message.info({ content: msg });
				$console.info(msg);
				// @ts-ignore
				console.log('[study日志] 章节推进', { curId, next: next.id });
				const nextId = next.id.replace(/^cur/, '');
				if (/^\d+$/.test(nextId) && courseId && clazzid && topWin && typeof topWin.getTeacherAjax === 'function') {
					try {
						topWin.getTeacherAjax(courseId, clazzid, nextId);
					} catch {}
				} else {
					next.click();
				}
				await $.sleep(8000);
				if (((topWin.location.href.match(/chapterId=(\d+)/) || [])[1] || '') !== curId) return true;
				// 未跳转：点击兜底重试
				// @ts-ignore
				console.log('[study日志] 章节推进未生效，重试点击');
				next.click();
				await $.sleep(5000);
				return (((topWin.location.href.match(/chapterId=(\d+)/) || [])[1] || '') !== curId);
			}
		} catch (e: any) {
			// @ts-ignore
			console.log('[study日志] 章节推进失败:', e && e.message);
		}
		return false;
	};

	if (CXProject.scripts.study.cfg.mode !== 'manually') {
		// 优先：自动进下一章（新版学习页 PCount.next 静默无效，实测）
		if (await gotoNextChapter()) return;
		const msg = '页面任务点已完成，即将跳转。';
		$message.success({ content: msg });
		$console.info(msg);
		await $.sleep(5000);
		next();
	} else {
		const msg = '页面任务点已完成，自动跳转已关闭，请手动跳转。';
		$message.warn({ content: msg, duration: 0 });
		$console.warn(msg);
	}
}

function searchIFrame(root: Document) {
	let list = Array.from(root.querySelectorAll('iframe'));
	const result: HTMLIFrameElement[] = [];
	while (list.length) {
		const frame = list.shift();

		try {
			if (frame && frame?.contentWindow?.document) {
				result.push(frame);
				const frames = frame?.contentWindow?.document.querySelectorAll('iframe');
				list = list.concat(Array.from(frames || []));
			}
		} catch (e) {
			// @ts-ignore
			console.log(e.message);
		}
	}
	return result;
}

/**
 * 搜索任务点
 */
function searchJob(
	opts: typeof CXProject.scripts.study.cfg & {
		workOptions: CommonWorkOptions;
	},
	searchedJobs: Job[]
): Job | undefined {
	const knowCardWin = $gm.unsafeWindow;

		const searchJobElement = (root: HTMLIFrameElement) => {
			return domSearch(
				{
					videojs: '#video,#audio',
					chapterTest: '.TiMu',
					read: '#img.imglook',
					pptWithAudio: '.swiper-container',
					hyperlink: '#hyperlink',
					timereader: 'iframe[name="bookifame"][src*="timing"]',
					vote: '#render.ans-cmp-iconVote, #render'
				},
				root.contentWindow!.document
			);
		};

	const search = (root: HTMLIFrameElement): Job | undefined => {
		const win = root.contentWindow;

		const { videojs, read, chapterTest, hyperlink, pptWithAudio, timereader, vote } = searchJobElement(root);

		if (win && (videojs || read || chapterTest || hyperlink || pptWithAudio || timereader || vote)) {
			// 获取任务点数据字符串
			const frame_data_str =
				win.frameElement?.getAttribute('data') ||
				// 带音频的PPT，套了两层iframe
				(win.frameElement as HTMLIFrameElement)?.contentWindow?.parent.frameElement?.getAttribute('data') ||
				'{}';
			const frame_data = JSON.parse(frame_data_str);
			// @ts-ignore 调试日志
			console.log('[study日志] 发现内容帧', { chapterTest: !!chapterTest, videojs: !!videojs, frame_data_str: frame_data_str.substring(0, 90) });
			// 2025-10 版作业 iframe 的 data 属性把 jobid 键改成了 workid（且不带 work- 前缀），兼容新旧两种格式
			const raw_jobid = frame_data.jobid || frame_data._jobid || frame_data.workid;
			if (!raw_jobid) {
				// @ts-ignore
				console.log('[study日志] 无 jobid，跳过该帧');
				return;
			}
			const normalizeJobId = (v: unknown) => String(v).replace(/^work-/, '');
			const target_jobid = normalizeJobId(raw_jobid);

			// 获取任务点数据
			const attachment: Attachment | undefined = (knowCardWin.attachments as any[]).find((attachment) => {
				const attachment_jobid = attachment.jobid || attachment.property._jobid || attachment.property.workid;
				if (!attachment_jobid) {
					return false;
				}
				return normalizeJobId(attachment_jobid) === target_jobid;
			});
			// @ts-ignore 调试日志
			console.log('[study日志] jobid匹配', { target_jobid: String(target_jobid).substring(0, 20), attachment: attachment ? `找到 type=${attachment.type} job=${!!attachment.job}` : '未找到' });

			// 任务点去重
			if (attachment && searchedJobs.find((job) => job.mid === attachment.property.mid) === undefined) {
				const { name, title, bookname, author } = attachment.property;
				const jobName = name || title || (bookname ? bookname + author : undefined) || '未知任务';

				const work_type = attachment.job ? 'job' : attachment.isPassed ? 'finished' : 'not-job';

				let func: { (): Promise<any> } | undefined;

				if (videojs) {
					if (!CXProject.scripts.study.cfg.enableMedia) {
						const msg = `音视频自动学习功能已被关闭（在上方菜单栏，超星学习通-课程学习中开启）。${jobName} 即将跳过`;
						$message.warn({ content: msg, duration: 10 });
						$console.warn(msg);
					} else {
						if (
							// 未完成
							work_type === 'job' ||
							// 重复学习
							(work_type === 'finished' && opts.restudy) ||
							// 强制学习
							(work_type === 'not-job' && opts.forceLearn)
						) {
							func = () => {
								const msg =
									`即将${
										work_type === 'finished' && opts.restudy
											? '重新'
											: work_type === 'not-job' && opts.forceLearn
											? '强制'
											: ''
									}播放 : ` + jobName;
								$message.info({ content: msg });
								$console.log(msg);
								return JobRunner.media(opts, win.document);
							};
						}
					}
				} else if (vote) {
					// 问卷调查任务点（2026-09-22 新增）：问卷题面在跨域帧里（mobilelearn.chaoxing.com），
					// 页面脚本进不去，交给 CDP 守护进程读题→千问AI作答→代填提交
					if (!attachment.isPassed) {
						func = () => JobRunner.vote(win, jobName);
					}
				} else if (chapterTest) {
					// @ts-ignore 调试日志
					console.log('[study日志] 章节测试分支', { jobName, work_type, enableChapterTest: CXProject.scripts.study.cfg.enableChapterTest });
					if (!CXProject.scripts.study.cfg.enableChapterTest) {
						const msg = `章节测试自动答题功能已被关闭（在上方菜单栏，超星学习通-课程学习中开启）。${jobName} 即将跳过`;
						$message.warn({ content: msg, duration: 10 });
						$console.warn(msg);
					} else {
						const status = win.document.querySelector<HTMLElement>('.testTit_status');
						// @ts-ignore 调试日志
						console.log('[study日志] 测验状态', { statusText: status ? status.textContent : null, complete: status ? status.classList.contains('testTit_status_complete') : null });

						// 已完成
						if (status?.classList.contains('testTit_status_complete')) {
							const msg = `章节测试已完成 : ` + jobName;
							$message.success({ content: msg });
							$console.log(msg);
						} else {
							if (
								// 未完成
								work_type === 'job' ||
								// / 强制学习
								(work_type === 'not-job' && CommonProject.scripts.settings.cfg['work-when-no-job'])
							) {
								if (
									opts.workOptions.answererWrappers === undefined ||
									(opts.workOptions.answererWrappers.length === 0 && !opts.workOptions.enableAIAnswerer)
								) {
									answerWrapperEmptyWarning(0);
								} else {
									func = () => {
										// 并发去重已上移到 runJobs 的全局闸门（runTaskSerial）：
										// 同一任务点只会执行一次，且必须答完才轮到下一个。
										// 这里不再做 __cxChapterTask 判断（那只是补丁，闸门才是根治）。
										const msg = `开始答题 : ` + jobName;
										$message.info({ content: msg });
										$console.log(msg);
										return JobRunner.chapter(root, opts.workOptions);
									};
								}
							}
							if (work_type === 'not-job' && CommonProject.scripts.settings.cfg['work-when-no-job'] === false) {
								const msg = `当前作业 ${jobName} 不是任务点，但待完成，如需开启自动答题请前往：通用-全局设置，开启强制答题。`;
								$message.warn({ content: msg });
								$console.warn(msg);
							}
						}
					}
				} else if (read || pptWithAudio || timereader) {
					if (!CXProject.scripts.study.cfg.enablePPT) {
						const msg = `PPT/书籍阅读功能已被关闭（在上方菜单栏，超星学习通-课程学习中开启）。${jobName} 即将跳过`;
						$message.warn({ content: msg, duration: 10 });
						$console.warn(msg);
					} else {
						if (attachment.job) {
							func = () => {
								const msg = `正在学习 : ` + jobName;
								$message.info({ content: msg });
								$console.log(msg);
								if (read) {
									return JobRunner.read(win);
								} else if (timereader) {
									return JobRunner.timereader(timereader as HTMLIFrameElement);
								} else {
									return JobRunner.readPPTWithAudio(win);
								}
							};
						}
					}
				} else if (hyperlink) {
					if (!CXProject.scripts.study.cfg.enableHyperlink) {
						const msg = `链接任务点已被关闭（在上方菜单栏，超星学习通-课程学习中开启）。${jobName} 即将跳过`;
						$message.warn({ content: msg, duration: 10 });
						$console.warn(msg);
					} else {
						if (attachment.job) {
							func = () => {
								const msg = `正在完成链接阅读任务 : ` + jobName;
								$message.info({ content: msg });
								$console.log(msg);
								return JobRunner.hyperlink(hyperlink);
							};
						}
					}
				}

				const job = {
					mid: attachment.property.mid,
					attachment: attachment,
					func: func
				};

				searchedJobs.push(job);

				return job;
			}
		}
	};

	let job;

	for (const iframe of searchIFrame(knowCardWin.document)) {
		job = search(iframe);
		if (job) {
			return job;
		}
	}

	return job;
}

/**
 * 永久固定显示视频进度
 */
export function fixedVideoProgress() {
	if (state.study.videojs) {
		const { bar } = domSearch({ bar: '.vjs-control-bar' }, state.study.videojs as any);
		if (bar) {
			bar.style.opacity = '1';
		}
	}
}

/**
 * 任务点运行器
 */
const JobRunner = {
	/**
	 * 播放视频和音频
	 */
	async media(
		setting: {
			playbackRate: number;
			volume: number;
			videoQuizStrategy: VideoQuizStrategy;
		},
		doc: Document
	) {
		const { playbackRate = 1, volume = 0 } = setting;

		const media = await waitForMedia({ root: doc });

		// @ts-ignore
		const { videojs } = domSearch({ videojs: '#video,#audio' }, doc);

		if (!videojs || !media) {
			$console.error('视频检测不到，请尝试刷新或者手动切换下一章。');
			return;
		}

		state.study.videojs = videojs;
		// @ts-ignore
		top.currentMedia = media;

		// 固定视频进度
		fixedVideoProgress();

		// 随机作答视频内题目
		if (setting.videoQuizStrategy === 'random') {
			const loop = async () => {
				const submitBtn = () => doc.querySelector<HTMLElement>('#videoquiz-submit');
				if (submitBtn()) {
					const list = Array.from(doc.querySelectorAll<HTMLElement>('.ans-videoquiz-opt label'));
					const answer = list[Math.floor(Math.random() * list.length)];
					answer?.click();
					submitBtn()?.click();
					await $.sleep(3000);
					// 隐藏视频内题目元素
					const container = doc.querySelector<HTMLElement>('#video .ans-videoquiz');
					const components = Array.from(doc.querySelectorAll<HTMLElement>('.x-component-default'));
					if (container) {
						container.remove();
					}
					if (components.length) {
						for (const com of components) {
							com.style.display = 'none';
						}
					}
				}
				await $.sleep(3000);
				await loop();
			};
			loop();
		}

		/**
		 * 视频播放
		 */
		return new Promise<void>((resolve, reject) => {
			// 续播状态标记：见下方 seekToResume 与 ended 保险
			let resumeSeekPending = false;
			// 检测视频
			const reloadInterval = setInterval(() => {
				const errorDiv = doc.querySelector<HTMLElement>('.vjs-modal-dialog-content');
				if (
					['视频文件损坏', '网络错误导致视频下载中途失败', '视频因格式不支持', '网络的问题无法加载'].some((s) =>
						errorDiv?.innerText.includes(s)
					)
				) {
					$console.error('检测到视频加载失败，即将跳过视频。');
					$message.error('检测到视频加载失败，即将跳过视频。');
					setTimeout(resolve, 3000);
				}
			}, 3000);

			const playFunction = async () => {
				// 这里先判断，再检测，否则后续添加多个 await 会导致视频启动等待时间过长，导致用户误认为脚本失效
				if (hasFaceRecognition()) await waitForFaceRecognition();
				if (hasNewFaceRecognition()) await waitForNewFaceRecognition();
				if (media.ended === false) {
					await $.sleep(1000);
					media.play();
					media.playbackRate = playbackRate;
				}
			};

			media.addEventListener('pause', playFunction);

			media.addEventListener('ended', () => {
				// 续播保险：若「拉到末尾回弹」未生效、被误判成播放结束，则退回从头播放，绝不误判完成
				if (resumeSeekPending) {
					resumeSeekPending = false;
					try {
						media.currentTime = 0;
						media.play();
					} catch {}
					return;
				}
				media.removeEventListener('pause', playFunction);
				$console.log('视频播放完毕');
				clearInterval(reloadInterval);
				resolve();
			});

			$console.log('视频开始播放');
			media.volume = volume;

			// 续播（2026-10-18 重做）：
			// 原先每次播放都强制 media.currentTime = 0，导致「看了一半退出重进」永远从头开始。
			// 改为：把进度条直接拉到末尾，超星播放器会回弹到「已观看的最远点」——
			//   · 新视频：最远点=0 → 回弹到开头（等价从头播，符合预期）
			//   · 看了一半：最远点=断点 → 回弹到上次位置（正是需要的续播）
			// 若 2 秒内没有回弹（仍停在末尾），说明播放器未拦截，退回从头播放，避免误判完成。
			const seekToResume = () => {
				try {
					const dur = media.duration;
					if (!isFinite(dur) || dur <= 1) return;
					resumeSeekPending = true;
					media.currentTime = Math.max(0, dur - 0.5);
					console.log('[study日志] 续播：进度已拉至末尾，等待回弹', { duration: Math.round(dur) });
					setTimeout(() => {
						try {
							if (resumeSeekPending && media.currentTime >= media.duration - 1) {
								console.warn('[study日志] 续播未回弹，退回从头播放');
								media.currentTime = 0;
							}
						} catch {}
						resumeSeekPending = false;
					}, 2000);
				} catch (e) {
					resumeSeekPending = false;
					console.warn('[study日志] 续播定位异常，按从头播放处理', e);
				}
			};
			if (media.readyState >= 1) {
				seekToResume();
			} else {
				media.addEventListener('loadedmetadata', seekToResume, { once: true });
			}

			// 使用 setTimeout 解决 The play() request was interrupted by a call to pause() 问题
			setTimeout(() => {
				playMedia(() => media.play())
					.then(() => {
						media.playbackRate = playbackRate;
					})
					.catch(reject);
			}, 200);
		});
	},
	/**
	 * 阅读，PPT
	 */
	async read(win: Window & { finishJob?: Function }) {
		const finishJob = win.finishJob;
		if (finishJob) finishJob();
		await $.sleep(3000);
	},
	/**
	 * 问卷调查任务点（2026-09-22 新增）
	 *
	 * 问卷题面加载在顶层弹层的跨域帧里（mobilelearn.chaoxing.com），
	 * 页面脚本受同源策略限制进不去——由 CDP 守护进程（launch-user.js）代劳：
	 * 本方法点开问卷弹层后，经 top.__voteTask 发起请求，守护进程
	 * 读题→千问AI作答（走同一桥接）→代填选项→提交→回报 done。
	 */
	async vote(win: Window, jobName: string) {
		const top: any = win.top;
		const msg = '正在完成问卷任务 : ' + jobName;
		$message.info({ content: msg, duration: 10 });
		$console.log(msg);
		if (!top || !top.__cdpDaemon) {
			throw new Error('问卷自动填写需要 CDP 守护进程（请用 一键刷课.bat 启动浏览器）');
		}
		// 点开问卷弹层（chaoxing 自己的逻辑：往顶层 #voteIframe 装题面并显示容器）
		try {
			(win.document.querySelector('#render') as HTMLElement)?.click();
		} catch {}
		await $.sleep(2000);
		top.__voteTask = { cmd: 'start', ts: Date.now() };
		// @ts-ignore 调试日志
		console.log('[study日志] 问卷任务已移交守护进程');
		const t0 = Date.now();
		while (Date.now() - t0 < 10 * 60 * 1000) {
			await $.sleep(3000);
			const task = top.__voteTask;
			if (task && task.done) {
				$console.log('问卷已完成');
				return;
			}
			if (task && task.error) {
				throw new Error('问卷处理失败: ' + task.error);
			}
		}
		throw new Error('问卷处理超时（10分钟）');
	},
	/**
	 * 时间阅读
	 */
	async timereader(iframe: HTMLIFrameElement) {
		const src = iframe.getAttribute('src')?.toString() || '';
		const timing = src ? parseInt(new URL(src).searchParams.get('timing')?.toString() || '60') : 60;
		$message.info({
			content: `正在学习长时阅读任务，请稍等，不要切换..（预计${(timing + 3) * 3}秒）`,
			duration: (timing + 3) * 3
		});
		// 这里依靠 onactive 第一个跨域处理程序，等待处理后继续即可
		// 一共有三步，第一步等待timing，然后切换正文页，然后是封底页，最后点击一次PPT文档切换界面，即可完成任务
		await $.sleep((timing + 3) * 3 * 1000);
		$message.success('长时阅读任务完成！');
		await $.sleep(5000);
	},
	/**
	 * 章节测验
	 */
		async chapter(
			frame: HTMLIFrameElement,
			{
				answererWrappers,
				period,
				upload,
				thread,
				stopSecondWhenFinish,
				redundanceWordsText,
				answerSeparators,
				enableAIAnswerer
			}: CommonWorkOptions
		) {
			if ((answererWrappers === undefined || answererWrappers.length === 0) && !enableAIAnswerer) {
				return answerWrapperEmptyWarning(0);
			}

		$console.info('开始章节测试');
		// @ts-ignore 调试日志
		console.log('[study日志] JobRunner.chapter 启动, 题目数=', frame.contentWindow && frame.contentWindow.document ? frame.contentWindow.document.querySelectorAll('.TiMu').length : '?');
		const visual_state = CommonProject.scripts.render.cfg.visual;

		const frameWindow = frame.contentWindow;

		// 根治「题干发错/串位」：
		// 章节测验 iframe 重新加载后，题目 DOM 是逐步渲染的（题干、选项、图片先后到达）。
		// 若在渲染中途读取，会拿到残缺题干或与上一题串位的文本（实测出现乱码题）。
		// 这里等到「题目数量与题干文本连续两次采样一致」才继续，确保读的是稳定快照。
		// ⚠️ readSnapshot 必须 try/catch：跨域访问 frameWindow.document 会抛 SecurityError，
		//    冒泡出去会打断整个答题任务。
		{
			const readSnapshot = () => {
				try {
					const doc = frameWindow?.document;
					if (!doc) return { count: -1, sig: '' };
					const nodes = doc.querySelectorAll('.TiMu');
					const texts = Array.from(nodes).map((n) => (n.textContent || '').replace(/\s+/g, ''));
					return { count: nodes.length, sig: texts.join('|') };
				} catch {
					return { count: -1, sig: '' };
				}
			};
			let prev = readSnapshot();
			let stable = 0;
			for (let i = 0; i < 30; i++) {
				await $.sleep(500);
				const cur = readSnapshot();
				if (cur.count > 0 && cur.count === prev.count && cur.sig === prev.sig) {
					stable++;
					if (stable >= 2) break; // 连续两次一致 → 稳定
				} else {
					stable = 0;
				}
				prev = cur;
			}
			// @ts-ignore 调试日志
			console.log('[study日志] 卷面稳定检查完成, 题目数=', prev.count);
		}

		// 根治「题干乱码」：
		// 超星用 font-cxsecret 加密题干。解密函数 mappingRecognize() 原本只在
		// cxSecretFontRecognize 脚本里触发，而它的 matches 只覆盖作业/考试页
		// （work/doHomeWorkNew、/mooc2/work/dowork、/mooc2/exam/preview），
		// **章节测验页不在其中** → 测验 iframe 里的加密字从来没人解密。
		//
		// ⚠️ 这里必须完全隔离失败：跨域访问 frameWindow.document 会抛 SecurityError，
		//    一旦让它冒泡出去，整个 job 会被打断 → 直接翻页（"没答完就下一页"）。
		{
			const safeCount = (): number => {
				try {
					return frameWindow?.document.querySelectorAll('.font-cxsecret').length || 0;
				} catch {
					return -1; // 跨域不可访问
				}
			};
			let remaining = safeCount();
			if (remaining < 0) {
				// 跨域帧：无法在本页解密，跳过（不打断答题）
				// @ts-ignore 调试日志
				console.log('[study日志] 测验帧跨域，跳过字体解密');
			} else if (remaining > 0) {
				try {
					await mappingRecognize(frameWindow!.document);
				} catch (e) {
					$console.warn('[study日志] 章节测验字体解密异常:', e && (e as any).message);
				}
				// @ts-ignore 调试日志
				console.log('[study日志] 检测到加密字体，等待解密:', remaining);
				for (let i = 0; i < 60; i++) {
					await $.sleep(500);
					const left = safeCount();
					if (left <= 0) {
						remaining = Math.max(left, 0);
						break;
					}
					remaining = left;
				}
				if (remaining > 0) {
					$console.warn('[study日志] 字体解密未完成(' + remaining + ' 个)，题干可能仍是乱码');
				} else {
					// @ts-ignore 调试日志
					console.log('[study日志] 字体解密完成');
				}
			}
		}

		const { TiMu } = domSearchAll({ TiMu: '.TiMu' }, frameWindow!.document);

		// 最大化面板
		CORSUtils.panelNormal();
		CommonProject.scripts.workResults.methods.init();
		// 固定显示答题结果面板
		CORSUtils.pinWorkPanel();

		const chapterTestTaskQuestionTitleTransform = (titles: (HTMLElement | undefined)[]) => {
			const removed = removeRedundantWords(
				titles.map((t) => (t ? optimizationElementWithImage(t, true).innerText : '')).join(','),
				redundanceWordsText.split('\n')
			);

			return (
				removed
					.trim()
					/** 超星旧版作业题目冗余数据 */
					.replace(/^\d+[。、.]/, '')
					.replace(/（\d+\.\d+分）/, '')
					.replace(/\(..题, \d+?分\)/, '')
					.replace(/\(..题, \d+\.\d+分\)/, '')
					.replace(/[[(【（](..题|名词解释|完形填空|阅读理解)[\])】）]/, '')
					.trim()
			);
		};

		/** 新建答题器 */
		const worker = new OCSWorker({
			root: TiMu,
			elements: {
				title: [
					(root) => $el('.Zy_TItle .clearfix', root),
					// /** 连线题第一组 */
					(root) => $el('.firstUlList', root),
					// /** 连线题第二组 */
					(root) => $el('.secondUlList', root)
				],
				/**
				 * 兼容各种选项
				 *
				 * ul li .after 单选多选
				 * ul li label:not(.after) 判断题
				 * ul li textarea 填空题
				 */
				options: 'ul li .after,ul li textarea,ul textarea,ul li label:not(.before)',
				type: 'input[id^="answertype"]',
				lineSelectBox: '.thirdUlList .dept_select'
			},
			thread: thread ?? 1,
			answerSeparators: answerSeparators.split(',').map((s) => s.trim()),
			/** 默认搜题方法构造器 */
				answerer: async (elements, ctx) => {
					const title = chapterTestTaskQuestionTitleTransform(elements.title);
					if (title) {
						const typeInput = elements.type[0] as HTMLInputElement;
						const type = (typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined) || 'unknown';
						const optionTexts = ctx.elements.options.map((o) => optimizationElementWithImage(o, true).innerText);

						/**
						 * AI 答题模式
						 */
						if (isAIEnabled()) {
							const aiConfig = getAIConfig();
							// 包含图片的元素：title + options 都提取（选项图片标注字母角标）
							const titleElements = elements.title || [];
							const imageElements = [...titleElements, ...(elements.options || [])];
							await $.sleep((period ?? 3) * 1000);
							return aiWorkAnswerer(
								aiConfig,
								{
									title,
									options: optionTexts,
									type
								},
								imageElements,
								undefined,
								titleElements.length
							);
						}

						await $.sleep((period ?? 3) * 1000);
						return defaultAnswerWrapperHandler(answererWrappers, {
							type,
							title,
							options:
								type === 'completion'
									? ''
									: optionTexts.join('\n')
						});
					} else {
						throw new Error('题目为空，请查看题目是否为空，或者忽略此题');
					}
				},

			work: async (ctx) => {
				const { elements, searchInfos } = ctx;
				const typeInput = elements.type[0] as HTMLInputElement;
				const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

				if (type && (type === 'completion' || type === 'multiple' || type === 'judgement' || type === 'single')) {
					const resolver = createDefaultQuestionResolver(ctx)[type];

					const handler: DefaultWork<any>['handler'] = (type, answer, option, ctx) => {
					// @ts-ignore 调试日志
					console.log('[chapter回填] handler 被调用:', type, String(answer).substring(0, 20), 'option=', option ? option.tagName + '.' + String(option.className || '').substring(0, 20) : 'null', 'text=', option ? (option.innerText || '').replace(/\s+/g, '').substring(0, 15) : '-');
					if (type === 'judgement' || type === 'single' || type === 'multiple') {
						let opt = option as HTMLElement | undefined;
						// 作业 iframe 可能在 AI 等待期间重载，答题前捕获的元素变游离节点（点击无效）。
						// 游离树内可数出题目序号与选项序号 → 到【当前活着的】作业文档同位置取活元素重定位。
						// 注意不能用捕获的 frameWindow（6.3 事故：iframe 整个换掉后它也是死的），必须实时遍历查找
						if (opt && !opt.ownerDocument.contains(opt)) {
							// @ts-ignore 调试日志
							console.log('[chapter回填] 元素已游离（iframe已重载），重定位...');
							const findLive = (win: any, d: number): Document | null => {
								if (d > 4 || !win) return null;
								try {
									for (const f of win.document.querySelectorAll('iframe')) {
										try {
											const doc = f.contentDocument;
											if (doc && doc.querySelector('.TiMu')) return doc;
										} catch {}
									}
									for (let i = 0; i < win.frames.length; i++) {
										const r = findLive(win.frames[i], d + 1);
										if (r) return r;
									}
								} catch {}
								return null;
							};
							const liveDoc = findLive(window.top, 0);
							if (liveDoc) {
								const tm = opt.closest('.TiMu');
								const optIdx = opt.parentElement ? Array.from(opt.parentElement.children).indexOf(opt) : -1;
								let qIdx = -1;
								if (tm && tm.parentElement) {
									qIdx = Array.from(tm.parentElement.children).filter((n) => (n as HTMLElement).classList && (n as HTMLElement).classList.contains('TiMu')).indexOf(tm);
								}
								const liveTms = Array.from(liveDoc.querySelectorAll('.TiMu'));
								const liveTm = qIdx >= 0 ? liveTms[qIdx] : undefined;
								const optCount = opt.parentElement ? opt.parentElement.children.length : -1;
								const liveParent = liveTm
									? Array.from(liveTm.querySelectorAll('ul')).find((ul) => ul.children.length === optCount)
									: undefined;
								if (liveParent && optIdx >= 0) {
									opt = liveParent.children[optIdx] as HTMLElement;
								}
							}
						}
						// 检查是否已经选择
						const checked =
							opt?.parentElement?.querySelector('label input')?.getAttribute('checked') === 'checked' ||
							// 适配2023/9月最新版本
							opt?.parentElement?.getAttribute('aria-checked') === 'true';
						if (checked) {
							// 跳过
						} else {
							// 根治「答案给了但选项没选上」：
							// 选择器 'ul li .after' 取到的是 span（选项文字），选中事件绑在
							// li / label / input 上，点 span 无效。这里统一找到真正可点的元素：
							//   优先 input（radio/checkbox）→ label → li → 最后才是元素本身
							const clickTarget: HTMLElement | null =
								(opt?.querySelector('input[type="radio"], input[type="checkbox"]') as HTMLElement) ||
								(opt?.closest('label') as HTMLElement) ||
								(opt?.closest('li') as HTMLElement) ||
								opt ||
								null;
							if (clickTarget) {
								clickTarget.click();
							} else {
								console.warn('[chapter回填] 找不到可点击的选项元素');
							}
						}
					} else if (type === 'completion' && answer.trim()) {
							const text = option?.parentElement?.querySelector('textarea');
							const textareaFrame = option?.parentElement?.querySelector('iframe');
							if (text) {
								text.value = answer;
							}
							if (textareaFrame?.contentDocument) {
								textareaFrame.contentDocument.body.innerHTML = answer;
							}
							if (option?.parentElement?.parentElement) {
								/** 如果存在保存按钮则点击 */
								$el('[onclick*=saveQuestion]', option.parentElement.parentElement)?.click();
							}
						}
					};

					return await resolver(
						searchInfos,
						elements.options.map((option) => optimizationElementWithImage(option)),
						handler
					);
				}
				// 连线题自定义处理
				else if (type && type === 'line') {
					const select = (el: HTMLElement, opt_val: string) => {
						const selected = el.querySelector(`option[selected]`);
						const opt = el.querySelector(`option[value="${opt_val}"]`);
						selected?.removeAttribute('selected');
						if (opt) {
							opt.setAttribute('selected', '');
						}
					};

					for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
						for (const ans of answers) {
							const splited_ans = splitAnswer(ans);
							if (splited_ans.length !== 0 && elements.lineSelectBox.length === splited_ans.length) {
								//  选择答案
								for (let index = 0; index < elements.lineSelectBox.length; index++) {
									const box = elements.lineSelectBox[index];
									if (splited_ans[index]) {
										select(box, splited_ans[index]);
										const text = box.parentElement?.querySelector('.chosen-single span');
										if (text) text.textContent = splited_ans[index];
										await $.sleep(200);
									}
								}
								return { finish: true };
							}
						}
					}

					return { finish: false };
				}

				return { finish: false };
			},

			/** 完成答题后 */
			async onResultsUpdate(curr, _, res) {
				// @ts-ignore 调试日志：每题的解析/匹配结果
				try {
					console.log('[study日志] 题目结果:', JSON.stringify({
						finish: curr.result ? curr.result.finish : null,
						resolved: curr.resolved,
						error: curr.error ? String(curr.error).substring(0, 80) : null,
						optionCount: (curr.ctx && curr.ctx.elements && curr.ctx.elements.options || []).length,
						optionTexts: (curr.ctx && curr.ctx.elements && curr.ctx.elements.options || []).slice(0, 5).map((o: any) => (o.innerText || '').trim().substring(0, 10))
					}));
				} catch {}
				CommonProject.scripts.workResults.methods.setResults(
					simplifyWorkResult(res, chapterTestTaskQuestionTitleTransform)
				);
				CommonProject.scripts.workResults.methods.updateWorkStateByResults(res);

				// 没有完成时随机作答
				if (curr.result?.finish === false && curr.resolved === true) {
					const options = curr.ctx?.elements?.options || [];

					const typeInput = curr.ctx?.elements?.type[0] as HTMLInputElement | undefined;
					const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

					const commonSetting = CommonProject.scripts.settings.cfg;

					if (
						commonSetting['randomWork-choice'] &&
						(type === 'judgement' || type === 'single' || type === 'multiple')
					) {
						$console.log('正在随机作答');

						const option = options[Math.floor(Math.random() * options.length)];
						// @ts-ignore 随机选择选项
						option?.parentElement?.querySelector('a,label')?.click();
					} else if (commonSetting['randomWork-complete'] && type === 'completion') {
						$console.log('正在随机作答');

						// 随机填写答案
						for (const option of options) {
							const textarea = option?.parentElement?.querySelector('textarea');
							const completeTexts = commonSetting['randomWork-completeTexts-textarea'].split('\n').filter(Boolean);
							const text = completeTexts[Math.floor(Math.random() * completeTexts.length)];
							const textareaFrame = option?.parentElement?.querySelector('iframe');

							if (text) {
								if (textarea) {
									textarea.value = text;
								}
								if (textareaFrame?.contentDocument) {
									textareaFrame.contentDocument.body.innerHTML = text;
								}
							} else {
								$console.error('请设置随机填空的文案');
							}

							await $.sleep(500);
						}
					}
				}
			},
			async onElementSearched(elements) {
				const typeInput = elements.type[0] as HTMLInputElement;
				const type = typeInput ? getQuestionType(parseInt(typeInput.value)) : undefined;

				/** 判断题转换成文字，以便于答题程序判断 */
				if (type === 'judgement') {
					elements.options.forEach((option) => {
						const opt = option?.textContent?.trim() || '';
						if (opt.includes('对') || opt.includes('错')) {
							// 2023/8/5日后超星已修复判断题，将图片修改成文字，如果已经有对错的文本，则不需要再转换
						}
						// 已经转换过（补答会二次进入同一道题），避免重复追加 √/× 变成 "√√"
						else if (opt.includes('√') || opt.includes('×')) {
						}
						// 如果是英语的对错题目，他是一个英文单词 True,False
						else if (opt === 'True') {
							option.textContent = '√';
						} else if (opt === 'False') {
							option.textContent = 'x';
						}
						// 支持香港地区的繁体字
						else if (opt === '對') {
							option.textContent = '√';
						} else if (opt === '錯') {
							option.textContent = 'x';
						} else {
							const ri = option.querySelector('.ri');
							const span = document.createElement('span');
							span.innerText = ri ? '√' : '×';
							option.appendChild(span);
						}
					});
				}
			}
		});

		const results = await worker.doWork();

		/**
		 * 找出卷面上仍然没作答的题。
		 *
		 * 判定（与提交前检查同一套标准）：
		 *   · 选择/判断：有 .check_answer 或 input:checked
		 *   · 填空：textarea 有非空文字
		 * 阅读理解等组合题容器内含子 .TiMu，容器本身跳过，由子题单独统计。
		 */
		const findLiveWorkDoc = (): Document | null => {
			const walk = (win: any, d: number): Document | null => {
				if (d > 4 || !win) return null;
				try {
					for (const f of win.document.querySelectorAll('iframe')) {
						try {
							const doc = f.contentDocument;
							if (doc && doc.querySelector('.TiMu')) return doc;
						} catch {}
					}
					for (let i = 0; i < win.frames.length; i++) {
						const r = walk(win.frames[i], d + 1);
						if (r) return r;
					}
				} catch {}
				return null;
			};
			try {
				return walk(window.top, 0);
			} catch {
				return null;
			}
		};

		/**
		 * 判断一道题是否已作答。
		 *
		 * 三道判据，任一命中即算已答（按可靠度排序）：
		 *   1) 选中项带 check_answer 类 —— 超星选中选项后加的标记（实测单选/多选/判断都有）
		 *   2) 选中项在 li 上带 aria-checked="true" —— 实测同样存在，作为类名变化时的兜底
		 *   3) 填空题的 textarea 有非空文字
		 *
		 * 只查这道题（tm = .TiMu 容器）自己的范围，不会串到别的题。
		 */
		const isAnswered = (tm: HTMLElement): boolean =>
			!!tm.querySelector('[class*="check_answer"], input:checked') ||
			!!tm.querySelector('ul li[aria-checked="true"]') ||
			Array.from(tm.querySelectorAll('textarea')).some(
				(t) => (((t as HTMLTextAreaElement).value || '') + '').trim().length > 0
			);

		const collectBlankQuestions = (): HTMLElement[] => {
			const doc = findLiveWorkDoc();
			if (!doc) return [];
			return (Array.from(doc.querySelectorAll('.TiMu')) as HTMLElement[]).filter((tm) => {
				if (tm.querySelector('.TiMu')) return false; // 组合题容器跳过
				return !isAnswered(tm);
			});
		};

		/**
		 * 补答：对仍然空白的题，重新走一遍**原有的 AI 答题流程**。
		 *
		 * 复用 worker 的答题配置（answerer / work / onElementSearched），
		 * 所以题干提取、AI 桥接、选项点击完全是同一套逻辑，
		 * 只是把 root 换成"还没答的题"。
		 *
		 * ⚠️ 两个必须屏蔽的副作用：
		 *   1) onResultsUpdate 会调 workResults.methods.setResults()，
		 *      而补答 worker 的 results 只含空白题，直接复用会把界面上
		 *      完整的结果列表覆盖成只剩空白题。这里换成空实现。
		 *   2) opts 里除答题逻辑外还有别的字段，用显式挑选而不是全量展开，
		 *      避免把不相关的状态带进新实例。
		 */
		const refillBlankQuestions = async (blank: HTMLElement[]): Promise<number> => {
			if (!blank.length) return 0;
			// @ts-ignore 调试日志
			console.log('[补答] 检测到未作答题目数:', blank.length);
			$console.warn('检测到 ' + blank.length + ' 道题未作答，正在重新作答…');

			const baseOpts = worker.opts as any;
			const refillWorker = new OCSWorker({
				root: blank,
				elements: baseOpts.elements,
				thread: baseOpts.thread,
				answerSeparators: baseOpts.answerSeparators,
				answerer: baseOpts.answerer,
				work: baseOpts.work,
				onElementSearched: baseOpts.onElementSearched,
				// 补答不写答题结果面板，避免把完整列表覆盖成只剩空白题
				onResultsUpdate: undefined
			} as any);
			try {
				await refillWorker.doWork();
			} catch (e: any) {
				$console.warn('[补答] 补答过程出错: ' + (e && e.message));
			}
			// 补答后重新统计还剩多少空白
			const left = collectBlankQuestions().length;
			// @ts-ignore 调试日志
			console.log('[补答] 补答结束，剩余未作答:', left);
			return left;
		};

		// 提交前先补答：有空白题就按原答题流程再答一遍，最多补两轮，避免死循环
		{
			const MAX_REFILL_ROUNDS = 2;
			for (let round = 1; round <= MAX_REFILL_ROUNDS; round++) {
				const blank = collectBlankQuestions();
				if (!blank.length) break;
				const left = await refillBlankQuestions(blank);
				if (left === 0) {
					$console.info('补答完成，所有题目均已作答');
					break;
				}
				if (round === MAX_REFILL_ROUNDS) {
					$console.warn('补答 ' + MAX_REFILL_ROUNDS + ' 轮后仍有 ' + left + ' 道题未作答');
				}
			}
		}

		const msg = `答题完成，将等待 ${stopSecondWhenFinish} 秒后进行保存或提交。`;
		$console.info(msg);
		$message.info({ content: msg, duration: stopSecondWhenFinish });
		await $.sleep(stopSecondWhenFinish * 1000);

		// 处理提交
		await worker.uploadHandler({
			type: upload,
			results,
			async callback(finishedRate, uploadable) {
				/**
				 * 是否提交，**只看卷面真实状态**，不看完成率账本。
				 *
				 * 为什么不能只看 uploadable：它来自 `finishedRate >= 80`，而 finishedRate
				 * 统计的是本次 doWork() 的 results[].result.finish。遇到下面这些情况时
				 * 账本会严重偏低，把"其实已经答完"的卷子误降级成仅保存：
				 *   · 进入时卷面本来就已答完（脚本这次没答，finish 全 false）
				 *   · AI 没被调用（answerMode 不是 ai 且题库为空 → 每题搜不到答案）
				 *   · 补答救回来的题，其结果没并回 results
				 * 用户实测现象就是：题目明明写完了，却一直只保存、提交逻辑不生效。
				 *
				 * 因此这里以卷面为准：
				 *   有题 且 一题不空  → 提交
				 *   有题 且 存在空题  → 仅保存（防白卷）
				 *   找不到卷面        → 沿用账本判断
				 */
				let doUpload = uploadable;
				let blankNos: number[] = [];
				let totalQuestions = 0;
				let checkedCount = -1;
				try {
					const liveDoc = findLiveWorkDoc();
					if (liveDoc) {
						const tms = (Array.from(liveDoc.querySelectorAll('.TiMu')) as HTMLElement[]).filter(
							(tm) => !tm.querySelector('.TiMu') // 组合题容器跳过
						);
						totalQuestions = tms.length;
						checkedCount = liveDoc.querySelectorAll('.check_answer, input:checked').length;
						tms.forEach((tm, i) => {
							if (!isAnswered(tm)) blankNos.push(i + 1);
						});

						if (totalQuestions > 0) {
							if (blankNos.length === 0) {
								// 卷面全部作答 → 提交
								doUpload = true;
							} else {
								// 有空白题 → 绝不提交白卷，降级保存
								doUpload = false;
								const preview = blankNos.slice(0, 10).join('、');
								const warn = `⚠️ 还有 ${blankNos.length} 道题未作答（第 ${preview}${blankNos.length > 10 ? '…' : ''} 题），改为仅保存不提交`;
								$console.warn(warn);
								$message.warn({ content: warn, duration: 8 });
							}
						}
					}
				} catch {}

				// @ts-ignore 调试日志
				console.log('[提交决策]', {
					uploadable,
					finishedRate: Number(finishedRate.toFixed(1)),
					totalQuestions,
					blankCount: blankNos.length,
					blankNos,
					checkedCount,
					doUpload
				});

				const msg = `完成率 ${finishedRate.toFixed(2)}% / 卷面 ${totalQuestions} 题${
					blankNos.length ? '（' + blankNos.length + ' 题空白）' : ''
				} : ${doUpload ? '3秒后将自动提交' : '3秒后将自动保存'} `;
				$console.info(msg);
				$message.success({ content: msg, duration: 3 });

				await $.sleep(3000);

				/**
				 * 提交/保存 + 校验 + 失败重提
				 *
				 * 重试方式和「正常写完提交」完全一样：同一个 frameWindow、
				 * 同样三步（btnBlueSubmit → submitCheckTimes → 关 #workpop），
				 * 不另做一套点击逻辑。
				 */
				const MAX_SUBMIT_ATTEMPTS = 5;

				/**
				 * 判断卷子是否已提交成功 —— **唯一标准：任务点已完成**。
				 *
				 * 实测已完成页面的标记（chapterId=916003761，2026-10-20 勘察）：
				 *   <div class="fr testTit_status testTit_status_complete"><i></i>已完成</div>
				 * 它只出现在承载卷面的那个 iframe 里（top/f0/f0/f0），整个 frame 树仅此一处。
				 *
				 * 因此只认这一个信号：遍历全部 frame，任意一个存在
				 * `.testTit_status.testTit_status_complete` 即为提交成功。
				 *
				 * 不再用其它推测性判据（URL 是否 submit=true、按钮是否消失等），
				 * 那些都会在"提交失败但页面刚好变化"时误判。
				 * 也绝不把「已保存」当成功——那是暂时保存。
				 */
				const isSubmitted = (): boolean => {
					const found = (win: any, depth: number): boolean => {
						if (depth > 6 || !win) return false;
						let doc: Document | null = null;
						try {
							doc = win.document;
						} catch {
							return false;
						}
						if (!doc) return false;
						try {
							// 唯一判据：状态条带 complete 类
							if (doc.querySelector('.testTit_status.testTit_status_complete')) return true;
							const frames = doc.querySelectorAll('iframe');
							for (let i = 0; i < frames.length; i++) {
								let sub: any = null;
								try {
									sub = (frames[i] as HTMLIFrameElement).contentWindow;
								} catch {
									continue;
								}
								if (found(sub, depth + 1)) return true;
							}
						} catch {}
						return false;
					};
					try {
						return found(window.top, 0);
					} catch {
						return false;
					}
				};

				/** 读当前状态条文字，仅用于日志排查（不参与判定） */
				const readStatusText = (): string => {
					let text = '';
					const walk = (win: any, depth: number) => {
						if (depth > 6 || !win || text) return;
						let doc: Document | null = null;
						try {
							doc = win.document;
						} catch {
							return;
						}
						if (!doc) return;
						try {
							const st = doc.querySelector('.testTit_status');
							if (st) {
								text = (st.textContent || '').trim();
								return;
							}
							const frames = doc.querySelectorAll('iframe');
							for (let i = 0; i < frames.length; i++) {
								let sub: any = null;
								try {
									sub = (frames[i] as HTMLIFrameElement).contentWindow;
								} catch {
									continue;
								}
								walk(sub, depth + 1);
								if (text) return;
							}
						} catch {}
					};
					try {
						walk(window.top, 0);
					} catch {}
					return text;
				};

				/**
				 * 保存：只执行一次，绝不重试。
				 *
				 * 原因（实测）：超星 saveWork() 成功后 1 秒会 `window.location.reload()`，
				 * 页面刷新后状态条回到「待完成」，任何"校验是否保存成功"都必然失败。
				 * 若把保存也放进重试循环，会变成：
				 *   保存 → 弹「保存成功」→ 页面刷新 → 判定失败 → 再保存 → 再刷新 …
				 * 表现就是「一直在弹保存成功、提交逻辑不生效」。
				 */
				const doSaveOnce = async () => {
					try {
						// @ts-ignore 禁止弹窗
						frameWindow.alert = () => {};
						// @ts-ignore 暂时保存
						frameWindow.noSubmit();
						$console.info('已执行暂时保存（保存成功后页面会刷新，不重试）');
					} catch (e: any) {
						$console.warn('[保存] 暂时保存异常: ' + (e && e.message));
					}
				};

				/** 执行一次提交 —— 和正常写完提交完全相同的动作 */
				const doSubmitOnce = async () => {
					// @ts-ignore 提交
					frameWindow.btnBlueSubmit();
					await $.sleep(3000);
					/** 确定按钮 */
					// @ts-ignore 确定
					frameWindow.submitCheckTimes();
					// @ts-ignore 2024/4 更新后上方函数无法关闭弹窗，需要手动关闭确定弹窗
					top.$('#workpop').hide();
				};

				if (!doUpload) {
					// ---- 保存路径：一次即止 ----
					await doSaveOnce();
				} else {
					// ---- 提交路径：校验 + 失败重提 ----
					let submitted = false;
					for (let attempt = 1; attempt <= MAX_SUBMIT_ATTEMPTS && !submitted; attempt++) {
						try {
							await doSubmitOnce();

							// 提交后轮询等结果（跳阅卷页 / 状态条刷新需要时间）
							// 最多 15 × 800ms ≈ 12 秒，命中即停。
							for (let i = 0; i < 15 && !submitted; i++) {
								await $.sleep(800);
								submitted = isSubmitted();
							}

							// @ts-ignore 调试日志
							console.log('[提交校验] 第' + attempt + '次', {
								submitted,
								statusText: readStatusText()
							});

							if (!submitted && attempt < MAX_SUBMIT_ATTEMPTS) {
								$console.warn('[提交校验] 第' + attempt + '次未成功，重新提交…');
								await $.sleep(2000);
							}
						} catch (e: any) {
							$console.warn('[提交校验] 第' + attempt + '次提交异常:', e && e.message);
							await $.sleep(2000);
						}
					}

					if (!submitted) {
						const warn =
							'⚠️ 提交未确认成功（已重试 ' + MAX_SUBMIT_ATTEMPTS + ' 次），请手动检查并提交';
						$console.error(warn);
						$message.error({ content: warn, duration: 0 });
					} else {
						// @ts-ignore 调试日志
						console.log('[提交校验] 提交已确认成功');
					}
				}
			}
		});

		// 还原尺寸状态
		if (visual_state === 'minimize' && CommonProject.scripts.render.cfg.visual !== 'minimize') {
			CORSUtils.panelMinimize();
		}

		worker.emit('done');
	},
	/**
	 * 带音频的PPT
	 */
	async readPPTWithAudio(win: Window & { swiperNext?: Function }) {
		// 关闭音视频声音
		win.document.querySelectorAll('audio').forEach((audio) => {
			audio.addEventListener('play', () => {
				audio.muted = true;
			});
		});

		// 阅读PPT
		const len = win.document.querySelectorAll('.swiper-container .swiper-slide').length;
		for (let index = 0; index < len; index++) {
			win.swiperNext?.();
			await $.sleep(1000);
		}
		await $.sleep(3000);
	},
	/**
	 * 链接任务点
	 */
	async hyperlink(a: HTMLElement) {
		// 修改点击事件，防止出现弹窗
		const _click = a.onclick;
		a.onclick = () => false;
		// 点击完成
		a.click();
		// 还原点击事件
		a.onclick = _click;
		await $.sleep(3000);
	}
};

/**
 * cx 题目类型 ：
 * 0 单选题
 * 1 多选题
 * 2 简答题
 * 3 判断题
 * 4 填空题
 * 5 名词解释
 * 6 论述题
 * 7 计算题
 * 8 其他题(大概率是填空题)
 * 9 分录题
 * 10 资料题
 * 11 连线题
 * 14 完形填空
 * 15 阅读理解
 */
function getQuestionType(
	val: number
): 'single' | 'multiple' | 'judgement' | 'completion' | 'line' | 'fill' | 'reader' | undefined {
	return val === 0
		? 'single'
		: val === 1
		? 'multiple'
		: val === 3
		? 'judgement'
		: [2, 4, 5, 6, 7, 8, 9, 10].some((t) => t === val)
		? 'completion'
		: val === 11
		? 'line'
		: val === 14
		? 'fill'
		: val === 15
		? 'reader'
		: undefined;
}

/** 阅读理解和完形填空的共同处理器 */
async function readerAndFillHandle(searchInfos: SearchInformation[], list: HTMLElement[]) {
	for (const answers of searchInfos.map((info) => info.results.map((res) => res.answer))) {
		let ans = answers;

		if (ans.length === 1) {
			ans = splitAnswer(ans[0]);
		}

		if (ans.filter(Boolean).length !== 0 && list.length !== 0) {
			for (let index = 0; index < ans.length; index++) {
				const item = list[index];
				if (item) {
					/** 获取每个小题中的准确答案选项 并点击 */
					$el(`span.saveSingleSelect[data="${ans[index]}"]`, item)?.click();
					await $.sleep(200);
				}
			}

			return { finish: true };
		}
	}

	return { finish: false };
}

function hasFaceRecognition() {
	// 人脸元素有时候 src 属性为空字符串，所以这里需要判断 src 是否为空字符串，如是则人脸识别会出现。
	const faces = $$el<HTMLImageElement>('#fcqrimg', top?.document);
	let active = false;
	for (const face of faces) {
		const src = face.getAttribute('src');
		if (src) {
			active = true;
			break;
		}
	}
	return active;
}

function hasNewFaceRecognition() {
	const faces = $$el<HTMLImageElement>('.chapterVideoFaceMaskDiv', top?.document);
	let active = false;
	for (const face of faces) {
		if (face.style.display !== 'none') {
			active = true;
			break;
		}
	}
	return active;
}

/**
 * 等待新版人脸识别，视频开头会出现的人脸识别
 */
function waitForNewFaceRecognition() {
	let notified = false;

	return new Promise<void>((resolve) => {
		const interval = setInterval(() => {
			// 人脸元素有时候 src 属性为空字符串，所以这里需要判断 src 是否为空字符串，如是则人脸识别会出现。
			const active = hasNewFaceRecognition();
			if (active) {
				if (!notified) {
					notified = true;
					const msg = '检测到人脸识别，请手动进行识别后脚本才会继续运行。';
					if (CXProject.scripts.study.cfg.notifyWhenHasFaceRecognition) {
						CommonProject.scripts.settings.methods.notificationBySetting(msg, { duration: 0 });
					}
					$message.warn({ content: msg, duration: 0 });
					$console.warn(msg);
				}
			} else {
				clearInterval(interval);
				resolve();
			}
		}, 3000);
	});
}
/**
 * 等待人脸识别
 */
function waitForFaceRecognition() {
	let notified = false;

	return new Promise<void>((resolve) => {
		const interval = setInterval(() => {
			// 人脸元素有时候 src 属性为空字符串，所以这里需要判断 src 是否为空字符串，如是则人脸识别会出现。
			const active = hasFaceRecognition();
			if (active) {
				if (!notified) {
					notified = true;
					const msg = '检测到人脸识别，请手动进行识别后脚本才会继续运行。';
					if (CXProject.scripts.study.cfg.notifyWhenHasFaceRecognition) {
						CommonProject.scripts.settings.methods.notificationBySetting(msg, { duration: 0 });
					}
					$message.warn({ content: msg, duration: 0 });
					$console.warn(msg);
				}
			} else {
				clearInterval(interval);
				resolve();
			}
		}, 3000);
	});
}

/**
 * 答题程序位于其他 iframe 中，而 methods.pin 等 是依赖于 setTab 方法的，所以需要重新定义一个顶层函数来调用 pin 方法
 * 跨域调用
 */

const CORSUtils = {
	pinWorkPanel: cors.defineTopFunction(() => {
		CommonProject.scripts.render.methods.pin(CommonProject.scripts.workResults);
	}),
	panelNormal: cors.defineTopFunction(() => {
		CommonProject.scripts.render.methods.normal();
	}),
	panelMinimize: cors.defineTopFunction(() => {
		CommonProject.scripts.render.methods.minimize();
	})
};

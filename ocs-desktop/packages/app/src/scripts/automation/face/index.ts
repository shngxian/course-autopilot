import type { BrowserContext } from 'playwright-core';
import { PlaywrightScript } from '../../script';
import { execSync, spawn } from 'child_process';
import path from 'path';

/**
 * 人脸识别监控脚本
 *
 * 工作流程：
 * 1. 静默监控页面 → OBS 不启动
 * 2. 检测到人脸识别弹窗 → 立即启动 OBS + 虚拟摄像头 + 对应场景
 * 3. 验证过程中 → 根据动作文字切换场景（热键 Ctrl+F1~F6）
 * 4. 人脸识别结束 → 延迟 10 秒后自动关闭 OBS
 *
 * 场景与热键：
 *   Normal    Ctrl+F1  → 正常学习视频（循环）
 *   Blink     Ctrl+F2  → 眨眼视频
 *   Nod       Ctrl+F3  → 点头视频
 *   TurnHead  Ctrl+F4  → 转头视频
 *   OpenMouth Ctrl+F5  → 张嘴视频
 *   Photo     Ctrl+F6  → 静态照片
 */
export const FaceRecognitionMonitorScript = new PlaywrightScript(
	{
		obsPath: {
			label: 'OBS 安装路径',
			value: 'D:\\xinjian2\\OBB ru ping\\obs-studio'
		}
	},
	{
		name: '人脸识别监控',
		async run(page: any, configs: { obsPath: string }) {
			const context = page.context() as BrowserContext;
			const obsExe = path.join(configs.obsPath, 'bin', '64bit', 'obs64.exe');

			// ===== 注入页面检测脚本 =====
			await context.addInitScript(() => {
				/** 检测页面中的人脸识别动作 */
				function detectAction(): string | null {
					const text = document.body?.innerText || '';

					// 检查是否有可见的人脸识别元素
					const hasFace = [
						'#fcqrimg', '.chapterVideoFaceMaskDiv',
						'[class*="faceVerify"]', '[class*="camera"]',
						'[id*="face"]', '[class*="拍照"]',
						'[class*="verify"]', '[class*="capture"]',
						'[class*="live"]', '[class*="detect"]',
						'[class*="face-recognition"]', '[class*="faceDetection"]',
						'[class*="modal"] [class*="face"]'
					].some(sel => {
						try {
							const el = document.querySelector(sel) as HTMLElement;
							return el && el.style.display !== 'none' && el.offsetParent !== null;
						} catch { return false; }
					});

					if (!hasFace) return null;

					// 判断动作
					if (/眨[一眼]|眨眨眼|请眨眼|快速眨眼|眼睛眨|blink/i.test(text)) return 'Blink';
					if (/点[头]|点点头|请点头|做点头|上下点头|nod/i.test(text)) return 'Nod';
					if (/转[头]|转头|请转头|左右转动|摇[头]|向左转|向右转|turn|left|right/i.test(text)) return 'TurnHead';
					if (/张[嘴]|张嘴|请张嘴|张开嘴|mouth/i.test(text)) return 'OpenMouth';
					if (/照片|拍照|拍摄|采集照片|capture.*photo|verify.*photo/i.test(text)) return 'Photo';

					// 摄像头开启但无特定动作要求 → 播正常学习视频（循环）
					return 'Normal';
				}

				let lastAction: string | null = null;
				setInterval(() => {
					const action = detectAction();
					if (action !== lastAction) {
						lastAction = action;
						window.dispatchEvent(new CustomEvent('ocs-face-action', {
							detail: { action, hasFace: !!action, time: Date.now() }
						}));
						console.log('[OCS-Face] ' + (action ? '动作:' + action : '人脸识别已结束'));
					}
				}, 2000);
			});

			console.log('[人脸识别监控] 已启动（静默监控中，OBS 未启动）');

			// ===== 主监控循环 =====
			let obsRunning = false;
			let obsScene = '';
			let stopTimer: ReturnType<typeof setTimeout> | null = null;

			while (true) {
				try {
					const pages = context.pages().filter(p => !p.isClosed());
					if (pages.length === 0) break;

					let detectedAction: string | null = null;
					let hasFace = false;

					for (const p of pages) {
						try {
							const result = await p.evaluate(() => {
								return new Promise<{ action: string | null; hasFace: boolean }>((resolve) => {
									const text = document.body?.innerText || '';
									let action: string | null = null;

									const hasFaceEl = [
										'#fcqrimg', '.chapterVideoFaceMaskDiv',
										'[class*="faceVerify"]', '[class*="camera"]',
										'[id*="face"]', '[class*="拍照"]',
										'[class*="verify"]', '[class*="capture"]',
										'[class*="face-recognition"]'
									].some(sel => {
										try {
											const el = document.querySelector(sel) as HTMLElement;
											return el && el.style.display !== 'none' && el.offsetParent !== null;
										} catch { return false; }
									});

									if (hasFaceEl) {
									if (/眨[一眼]|眨眨眼|请眨眼|快速眨眼|眼睛眨|blink/i.test(text)) action = 'Blink';
											else if (/点[头]|点点头|请点头|做点头|上下点头|nod/i.test(text)) action = 'Nod';
											else if (/转[头]|转头|请转头|左右转动|摇[头]|向左转|向右转|turn|left|right/i.test(text)) action = 'TurnHead';
											else if (/张[嘴]|张嘴|请张嘴|张开嘴|mouth/i.test(text)) action = 'OpenMouth';
											else if (/照片|拍照|拍摄|采集照片|capture.*photo|verify.*photo/i.test(text)) action = 'Photo';
											else action = 'Normal'; // 摄像头开启但无特定动作 → 播学习视频
									}

									const timer = setTimeout(() => resolve({ action, hasFace: hasFaceEl }), 3000);
									const handler = (e: Event) => {
										clearTimeout(timer);
										const detail = (e as CustomEvent).detail;
										resolve({ action: detail?.action || null, hasFace: !!detail?.hasFace });
									};
									window.addEventListener('ocs-face-action', handler, { once: true });
								});
							});

							if (result.hasFace) {
								hasFace = true;
								detectedAction = result.action;
							}
						} catch {}
					}

					// ===== 决策逻辑 =====
					if (hasFace && detectedAction) {
						// 有人脸识别 → 启动/切换 OBS
						if (stopTimer) {
							clearTimeout(stopTimer);
							stopTimer = null;
						}

						if (!obsRunning) {
							startOBS(obsExe, detectedAction);
							obsRunning = true;
							obsScene = detectedAction;
							console.log(`[人脸识别监控] 🎬 OBS 已启动 → 场景: ${detectedAction}`);
						} else if (detectedAction !== obsScene) {
							// OBS 已运行，切换场景（通过热键）
							sendHotkey(detectedAction);
							obsScene = detectedAction;
							console.log(`[人脸识别监控] 🔄 切换场景: ${detectedAction}`);
						}
					} else if (obsRunning && !hasFace) {
						// 人脸识别已结束 → 延迟关闭 OBS
						if (!stopTimer) {
							console.log('[人脸识别监控] 人脸识别结束，10 秒后关闭 OBS...');
							stopTimer = setTimeout(() => {
								stopOBS(obsExe);
								obsRunning = false;
								obsScene = '';
								stopTimer = null;
								console.log('[人脸识别监控] 🛑 OBS 已关闭，继续静默监控');
							}, 10000);
						}
					}

					await sleep(2000);
				} catch (e) {
					console.error('[人脸识别监控] 错误:', e);
					break;
				}
			}

			// 浏览器关闭时清理 OBS
			if (obsRunning) {
				stopOBS(obsExe);
			}
			console.log('[人脸识别监控] 已停止');
		}
	}
);

/** 启动 OBS 并切换到指定场景 */
function startOBS(exePath: string, scene: string) {
	try {
		execSync('tasklist /fi "imagename eq obs64.exe" 2>nul | findstr obs64.exe', { timeout: 2000 });
		// OBS 已在运行，直接用热键切场景
		sendHotkey(scene);
		return;
	} catch {}

	spawn(exePath, ['--startvirtualcam', '--scene', scene, '--minimize-to-tray'], {
		detached: true,
		windowsHide: true,
		stdio: 'ignore'
	}).unref();
}

/** 通过热键切换 OBS 场景 */
function sendHotkey(scene: string) {
	const keyMap: Record<string, string> = {
		'Normal': '^{F1}', 'Blink': '^{F2}', 'Nod': '^{F3}',
		'TurnHead': '^{F4}', 'OpenMouth': '^{F5}', 'Photo': '^{F6}'
	};
	const keys = keyMap[scene];
	if (!keys) return;
	try {
		execSync(`powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')"`, {
			timeout: 5000, stdio: 'pipe'
		});
	} catch {}
}

/** 关闭 OBS */
function stopOBS(exePath: string) {
	try {
		execSync('taskkill /f /im obs64.exe 2>nul', { timeout: 3000 });
	} catch {}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

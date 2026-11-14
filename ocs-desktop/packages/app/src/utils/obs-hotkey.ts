import { execSync } from 'child_process';

/**
 * 通过 PowerShell 发送热键到 OBS
 * 需要在 OBS 场景集合中预先配置好对应的热键
 */
const HOTKEY_KEYS: Record<string, string> = {
	'Normal': '^{F1}',       // Ctrl+F1
	'Blink': '^{F2}',        // Ctrl+F2
	'Nod': '^{F3}',          // Ctrl+F3
	'TurnHead': '^{F4}',     // Ctrl+F4
	'OpenMouth': '^{F5}',    // Ctrl+F5
	'Photo': '^{F6}'         // Ctrl+F6
};

/**
 * 切换到指定 OBS 场景
 * 通过 PowerShell SendKeys 发送全局热键
 */
export function switchOBSScene(sceneName: string): boolean {
	const keyCombo = HOTKEY_KEYS[sceneName];
	if (!keyCombo) {
		console.error(`[OBS热键] 未知场景: ${sceneName}`);
		return false;
	}

	try {
		// PowerShell SendKeys 发送热键
		const psScript = `
			Add-Type -AssemblyName System.Windows.Forms
			[System.Windows.Forms.SendKeys]::SendWait('${keyCombo}')
		`;
		execSync(`powershell -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, {
			timeout: 5000
		});
		console.log(`[OBS热键] 已发送: ${sceneName} (${keyCombo})`);
		return true;
	} catch (e) {
		console.error(`[OBS热键] 发送失败:`, e);
		return false;
	}
}

/**
 * 获取 OBS 场景对应的热键
 */
export function getSceneHotkey(sceneName: string): string {
	return HOTKEY_KEYS[sceneName] || '';
}

/**
 * 所有场景的热键映射
 */
export function getAllHotkeys(): Record<string, string> {
	return { ...HOTKEY_KEYS };
}

/**
 * 构建 OBS 场景的热键配置（用于写入场景集合 JSON）
 */
export function buildSceneHotkeyConfig(sceneName: string, index: number): Record<string, any> {
	// F1-F6 对应 6 个场景
	const fKey = `OBS_KEY_F${index + 1}`;
	return {
		'OBSBasic.SelectScene': [
			{
				key: fKey,
				shift: false,
				ctrl: true,
				alt: false,
				cmd: false
			}
		]
	};
}

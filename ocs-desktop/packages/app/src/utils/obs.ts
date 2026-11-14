import { execSync, spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

let obsProcess: ChildProcess | null = null;

/**
 * 获取 OBS 可执行文件路径
 */
export function getOBSExecutablePath(obsPath: string): string {
	return path.join(obsPath, 'bin', '64bit', 'obs64.exe');
}

/**
 * 检查 OBS 安装路径是否有效
 */
export function isValidOBSPath(obsPath: string): boolean {
	try {
		return fs.existsSync(getOBSExecutablePath(obsPath));
	} catch {
		return false;
	}
}

/**
 * 检查虚拟摄像头驱动是否已注册到系统
 */
export function isVirtualCameraInstalled(): boolean {
	try {
		// 检查注册表中 OBS Virtual Camera 的 CLSID
		const result = execSync(
			'reg query "HKLM\\SOFTWARE\\Classes\\CLSID\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}"',
			{ encoding: 'utf8', timeout: 5000 }
		);
		return result.includes('A3FCE0F5');
	} catch {
		return false;
	}
}

/**
 * 安装 OBS 虚拟摄像头驱动（需要管理员权限）
 * 返回 true 表示安装成功，false 表示失败
 */
export async function installVirtualCamera(obsPath: string): Promise<boolean> {
	try {
		const installScript = path.join(obsPath, 'data', 'obs-plugins', 'win-dshow', 'virtualcam-install.bat');
		if (!fs.existsSync(installScript)) {
			console.error('虚拟摄像头安装脚本不存在:', installScript);
			return false;
		}
		execSync(`"${installScript}"`, { timeout: 30000 });
		return isVirtualCameraInstalled();
	} catch (e) {
		console.error('安装虚拟摄像头失败:', e);
		return false;
	}
}

/**
 * 启动 OBS 虚拟摄像头
 * @param obsPath OBS 安装路径
 * @param sceneName 场景名称（可选，需要在 OBS 中预先创建）
 * @returns 是否成功启动
 */
export function startOBS(obsPath: string, sceneName?: string): boolean {
	try {
		if (!isValidOBSPath(obsPath)) {
			console.error('OBS 路径无效:', obsPath);
			return false;
		}

		// 如果已有 OBS 在运行，先关闭
		stopOBS();

		const exePath = getOBSExecutablePath(obsPath);
		const args = ['--startvirtualcam', '--minimize-to-tray'];

		if (sceneName) {
			args.push('--scene', sceneName);
		}

		console.log('启动 OBS:', exePath, args.join(' '));

		obsProcess = spawn(exePath, args, {
			detached: true,
			windowsHide: true,
			stdio: 'ignore'
		});

		obsProcess.unref();
		return true;
	} catch (e) {
		console.error('启动 OBS 失败:', e);
		return false;
	}
}

/**
 * 停止 OBS
 */
export function stopOBS(): void {
	try {
		execSync('taskkill /f /im obs64.exe 2>nul', { timeout: 5000 });
	} catch {
		// OBS 可能没有运行
	}
	obsProcess = null;
}

/**
 * 检查 OBS 是否正在运行
 */
export function isOBSRunning(): boolean {
	try {
		execSync('tasklist /fi "imagename eq obs64.exe" 2>nul | findstr obs64.exe', { timeout: 3000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * 获取 OBS 版本
 */
export function getOBSVersion(obsPath: string): string | null {
	try {
		const exePath = getOBSExecutablePath(obsPath);
		const version = execSync(`"${exePath}" --version`, { encoding: 'utf8', timeout: 5000 }).trim();
		const match = version.match(/(\d+\.\d+\.\d+)/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}


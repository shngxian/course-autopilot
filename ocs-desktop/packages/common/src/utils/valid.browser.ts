import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { ValidBrowser } from '../interface';
import os from 'os';
import 'electron';

// 获取可用浏览器路径
export function getValidBrowsers(): ValidBrowser[] {
	switch (os.platform()) {
		case 'darwin': {
			return [
				{
					name: '软件内置浏览器-谷歌(Chrome)',
					path: resolveBrowserPath(
						'bin/chrome/chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
					)
				}
			].filter((b) => b.path) as ValidBrowser[];
		}
		case 'win32': {
			return [
				{
					name: '软件内置浏览器-谷歌(Chrome)',
					path: resolveBrowserPath('bin\\chrome\\chrome\\chrome.exe')
				},
				{
					name: '微软浏览器(Microsoft Edge)',
					path: resolveBrowserPath('Microsoft\\Edge\\Application\\msedge.exe')
				},
				{
					name: '谷歌浏览器(Chrome)',
					path: resolveBrowserPath('Google\\Chrome\\Application\\chrome.exe')
				}
			].filter((b) => b.path) as ValidBrowser[];
		}
		default: {
			return [];
		}
	}
}

function resolveBrowserPath(commonPath: string) {
		return [
			join(process.resourcesPath, commonPath),
			...(process.platform === 'win32'
				? [
						// @ts-ignore
						join(process.env.ProgramFiles, commonPath),
						// @ts-ignore
						join(process.env['ProgramFiles(x86)'], commonPath),
						join('C:\\Program Files', commonPath),
						join('C:\\Program Files (x86)', commonPath),
						// 开发模式下从项目根目录查找
						resolve('D:\\wo_de_cheng_xu\\跳人脸刷课\\ocs-desktop\\bin\\chrome\\chrome\\chrome.exe'),
						resolve('bin\\chrome\\chrome\\chrome.exe')
				  ]
				: [])
		].find((p) => existsSync(p));
	}

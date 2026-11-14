@echo off
chcp 65001 >nul
title OCS AI 脚本构建
echo ========================================
echo       OCS 网课助手 - AI 版 构建工具
echo ========================================
echo.

cd /d "%~dp0ocsjs"

echo [1/5] 编译核心包...
cd packages\core
call npx tsc --noEmit false --skipLibCheck >nul 2>&1
echo      核心包编译完成

echo [2/5] 编译脚本包...
cd ..\scripts
call npx tsc --noEmit false --skipLibCheck >nul 2>&1
echo      脚本包编译完成

echo [3/5] 打包脚本...
cd ..\..
call npx esbuild packages/scripts/src/index.ts --bundle --outfile=dist/_bundle.js --global-name=OCS --format=iife --platform=browser --external:easy-us >nul 2>&1
echo      打包完成

echo [4/5] 生成用户脚本...
node -e "
var f=require('fs'),p=require('path');
var b=f.readFileSync('dist/_bundle.js','utf-8');
var s=f.existsSync('packages/scripts/assets/css/style.css')?f.readFileSync('packages/scripts/assets/css/style.css','utf-8'):'';
var m=[
'// ==UserScript==',
'// @name         OCS 网课助手 - AI版',
'// @version      4.15.3-ai',
'// @description  OCS 网课助手 - 支持AI答题·含图片识别',
'// @author       enncy',
'// @namespace    https://enncy.cn',
'// @homepage     https://docs.ocsjs.com',
'// @icon         https://cdn.ocsjs.com/logo.png',
'// @run-at       document-start',
'// @grant        GM_info','// @grant        GM_getTab','// @grant        GM_saveTab','// @grant        GM_setValue','// @grant        GM_getValue',
'// @grant        unsafeWindow','// @grant        GM_listValues','// @grant        GM_deleteValue','// @grant        GM_notification',
'// @grant        GM_xmlhttpRequest','// @grant        GM_getResourceText','// @grant        GM_addValueChangeListener','// @grant        GM_removeValueChangeListener',
'// @match        *://*.chaoxing.com/*','// @match        *://*.edu.cn/*','// @match        *://*.zhihuishu.com/*',
'// @match        *://*.icve.com.cn/*','// @match        *://*.icourse163.org/*','// @match        *://*.yuketang.cn/*',
'// @match        *://*.zjy2.icve.com.cn/*',
'// @connect      localhost','// @connect      127.0.0.1','// @connect      *',
'// ==/UserScript==',''
];
var t=m.join('\n')+'\n'+b+'\n(function(){try{OCS.start({projects:OCS.definedProjects(),renderConfig:{renderScript:OCS.RenderScript,styles:['+(s?'STYLE':'')+'],defaultPanelName:OCS.CommonProject.scripts.guide.namespace,title:\"OCS AI\"},updatePage:\"https://docs.ocsjs.com/docs/update\"})}catch(e){console.error(e)}})();';
if(s) t=t.replace('STYLE',JSON.stringify(s));
f.writeFileSync('dist/ocs.ai.user.js',t,'utf-8');
f.unlinkSync('dist/_bundle.js');
console.log('OK');
" 
echo      用户脚本生成完成

echo [5/5] 清理...
echo      临时文件已清理

echo.
echo ========================================
echo       构建完成！
echo.
echo 用户脚本位置:
echo   D:\wo_de_cheng_xu\跳人脸刷课\ocsjs\dist\ocs.ai.user.js
echo.
echo 安装方法:
echo   1. 打开 Tampermonkey 扩展
echo   2. 点击「添加新脚本」
echo   3. 把 dist\ocs.ai.user.js 的内容全部粘贴进去
echo   4. 保存 (Ctrl+S)
echo.
echo 或者用 OCS 桌面端打开内置浏览器
echo ========================================
pause

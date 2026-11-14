/** 脚本服务：http://127.0.0.1:18923/ocs.ai.user.js（serve.bat 的无引号坑版） */
const http = require('http');
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'dist', 'ocs.ai.user.js');
http.createServer((req, res) => {
	if (req.url.includes('ocs.ai.user.js')) {
		res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
		res.end(fs.readFileSync(file));
		console.log(new Date().toLocaleTimeString(), '已提供脚本');
	} else {
		res.writeHead(404);
		res.end();
	}
}).listen(18923, '127.0.0.1', () => console.log('服务已启动: http://127.0.0.1:18923/ocs.ai.user.js'));
setInterval(() => {}, 60000);

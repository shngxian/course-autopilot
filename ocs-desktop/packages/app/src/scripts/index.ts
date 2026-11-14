import { CXPhoneLoginScript, CXUnitLoginScript } from './automation/wk/cx';
import { ZHSPhoneLoginScript, ZHSUnitLoginScript } from './automation/wk/zhs';
import { ICVELoginScript } from './automation/wk/icve';
import { ZJYLoginScript } from './automation/wk/zjy';
import { NewPageScript } from './automation/common';
import { FaceRecognitionMonitorScript } from './automation/face/index';

export const scripts = [
	CXPhoneLoginScript,
	CXUnitLoginScript,
	ZHSPhoneLoginScript,
	ZHSUnitLoginScript,
	ZJYLoginScript,
	ICVELoginScript,
	NewPageScript,
	FaceRecognitionMonitorScript
];

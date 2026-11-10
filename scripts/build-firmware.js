#!/usr/bin/env node

/**
 * 把 hardware_main.py / device_main.py 内嵌生成 firmware.js（window.FIRMWARE_FILES）。
 *
 * 为什么不用 fetch('/hardware_main.py')：
 * 托管平台的预览代理可能拒绝服务 .py 扩展名（HTTP 403），而 JS 文件必然可加载。
 * 内嵌后注入引擎零网络依赖，dev/publish/file:// 三种场景行为一致。
 *
 * 用法：
 * - npm run build-firmware        手动重建
 * - npm run publish               自动先重建再拷贝
 * - dev 模式无需构建：vite.config.js 的 firmware-embed 插件按请求实时生成
 *
 * ⚠️ 修改 .py 源文件后若直接跑 publish 没问题；若手动拷 firmware.js 记得先重建。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// 需要内嵌的脚本源文件（网页端注入的全部可写内容，与 upload.js 目标白名单对应）
export const FIRMWARE_FILES = ['hardware_main.py', 'device_main.py'];

export function buildFirmware(targetDir = projectRoot) {
  const files = {};
  for (const f of FIRMWARE_FILES) {
    files[f] = readFileSync(join(projectRoot, f), 'utf-8');
  }
  const out = '// 自动生成，请勿手动编辑 — scripts/build-firmware.js\n'
    + '// 来源: ' + FIRMWARE_FILES.join(' / ') + '（修改后重建: npm run build-firmware）\n'
    + 'window.FIRMWARE_FILES = ' + JSON.stringify(files) + ';\n';
  writeFileSync(join(targetDir, 'firmware.js'), out, 'utf-8');
  return files;
}

// 直接运行时执行构建（被 import 时只导出函数）
if (process.argv[1] && /build-firmware\.js$/.test(process.argv[1])) {
  buildFirmware();
  console.log('✅ firmware.js 已生成（内嵌 ' + FIRMWARE_FILES.join(', ') + '）');
}

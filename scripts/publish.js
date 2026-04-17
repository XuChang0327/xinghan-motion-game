#!/usr/bin/env node

/**
 * 跨平台 publish 脚本 - simple-html 模板
 * 功能：将项目文件复制到 .rush/dist 目录
 * 兼容：Windows、macOS、Linux
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 获取当前脚本所在目录的父目录（项目根目录）
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 定义路径
const rushDistDir = join(projectRoot, '.rush', 'dist');

console.log('🚀 开始 publish 流程...\n');

// 步骤 1: 清理并创建 .rush/dist 目录
console.log('🗑️  步骤 1/2: 准备目标目录...');
if (existsSync(rushDistDir)) {
  rmSync(rushDistDir, { recursive: true, force: true });
  console.log('   清理旧的 .rush/dist 目录');
}

mkdirSync(rushDistDir, { recursive: true });
console.log('   创建 .rush/dist 目录');
console.log('✅ 目标目录准备完成\n');

// 步骤 2: 复制项目文件
console.log('📋 步骤 2/2: 复制项目文件...');

// 需要复制的文件和目录列表
const itemsToCopy = ['index.html', 'style.css', 'src'];

let copiedCount = 0;
const errors = [];

for (const item of itemsToCopy) {
  const sourcePath = join(projectRoot, item);
  const targetPath = join(rushDistDir, item);

  if (!existsSync(sourcePath)) {
    console.warn(`⚠️  跳过不存在的文件: ${item}`);
    continue;
  }

  try {
    cpSync(sourcePath, targetPath, {
      recursive: true,
      force: true,
    });
    console.log(`   ✓ ${item}`);
    copiedCount++;
  } catch (error) {
    errors.push({ item, error: error.message });
    console.error(`   ✗ ${item}: ${error.message}`);
  }
}

console.log('');

// 检查结果
if (errors.length > 0) {
  console.error('❌ 部分文件复制失败:');
  errors.forEach(({ item, error }) => {
    console.error(`   - ${item}: ${error}`);
  });
  process.exit(1);
}

if (copiedCount === 0) {
  console.error('❌ 没有文件被复制');
  process.exit(1);
}

console.log(`✅ 成功复制 ${copiedCount} 个文件/目录\n`);
console.log('🎉 Publish 完成！');
console.log(`📁 项目文件已复制到: ${rushDistDir}`);
console.log(`🌐 可以直接访问: .rush/dist/index.html`);

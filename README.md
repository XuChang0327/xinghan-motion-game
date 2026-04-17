# Simple HTML 模板

## 简介

Simple HTML 是一个简单的项目模板，适用于快速创建静态页面和展示页面。

## 技术栈

- **类型**：简单项目
- **技术栈**：原生 HTML + CSS + Vite 5
- **用途**：简单静态页面、展示页面

## 特点

- ✅ 最小依赖（仅 Vite）
- ✅ 快速启动
- ✅ HMR Bridge 已集成（JavaScript 版本）
- ✅ Vite 配置预置

## 使用方法

### 通过 API 使用

```bash
# 从模板创建项目
curl -X POST http://localhost:4000/api/templates/scaffold \
  -H "Content-Type: application/json" \
  -d '{
    "templateId": "simple-html",
    "projectId": "my-simple-page",
    "projectName": "My Simple Page"
  }' | jq
```

### 在代码中使用

```typescript
import { scaffoldFromTemplate } from '@/lib/template-manager';

// 创建 Simple HTML 项目
const result = await scaffoldFromTemplate('simple-html', {
  projectId: 'my-simple-page',
  workspacePath: '/path/to/workspace',
  projectName: 'My Simple Page',
});

if (result.success) {
  console.log('✅ 项目创建成功:', result.projectPath);
} else {
  console.error('❌ 创建失败:', result.message);
}
```

### 在 Claude Code 中使用（自动）

用户只需输入需求，Claude Code 会自动选择合适的模板创建项目：

```
用户："创建一个简单的 Hello World 页面"
→ Claude Code 自动使用 simple-html 模板
```

## 项目结构

```
simple-html/
├── template.json          # 模板元数据（必需）
├── package.json           # 项目依赖配置
├── vite.config.js         # Vite 配置（必须包含 host & allowedHosts）
├── index.html             # HTML 入口
└── src/                   # 源代码目录
    ├── hmr-bridge.js      # HMR Bridge（必需，JavaScript 版本）
    └── ...                # 其他源文件
```

## template.json 配置

```json
{
  "id": "simple-html",
  "name": "Simple HTML + Vite",
  "description": "简单的 HTML 项目，使用 Vite 作为开发服务器",
  "type": "simple",
  "version": "1.0.0",
  "dependencies": {},
  "devDependencies": {
    "vite": "^5.4.2"
  },
  "features": [
    "原生 HTML + CSS",
    "Vite 开发服务器",
    "HMR Bridge",
    "最小依赖",
    "快速启动"
  ],
  "port": 8000,
  "keywords": ["html", "simple", "static"]
}
```

## 开发

### 启动开发服务器

```bash
npm run dev
```

### 构建生产版本

```bash
npm run build
```

## 注意事项

- Vite 配置必须包含 `host: true` 和 `allowedHosts: true` 配置
- HMR Bridge 文件位于 `src/hmr-bridge.js`（JavaScript 版本）
- 这是一个最小化模板，仅包含必要的依赖

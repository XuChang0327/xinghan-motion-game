# 研究发现与技术决策

## 现有项目结构
- 单文件架构：`main.js` 包含所有游戏逻辑（~240KB）
- 共用 Canvas：`#gameCanvas` 750x500
- 游戏选择器：`selectGame()` → `startGame()` 模式
- 键盘统一处理：`gameKeyHandler` / `gameKeyUpHandler`
- 串口数据流：`readLoop()` → `appendLine()`

## 3D 跑酷游戏技术决策

### 1. Three.js 引入方式
- **决策**：通过 pnpm 安装 three 包，在 main.js 中使用全局变量
- 由于 main.js 不是 ES module，需要用 `<script type="importmap">` 或 CDN script
- **最终方案**：使用 CDN `<script src="...three.min.js">` 在 index.html 中加载，通过 `window.THREE` 访问

### 2. 渲染器集成
- 3D 游戏不能使用 2D Canvas，需要独立的 WebGL renderer
- **决策**：在 gameViewport 容器中创建独立的 Three.js renderer DOM 元素
- 启动 runner 游戏时隐藏 2D canvas，显示 Three.js renderer
- 停止游戏时销毁 renderer 并恢复 2D canvas

### 3. 控制系统
- 虚拟摇杆：纯 CSS + JS touch/mouse 事件
- 滑行按钮：右侧固定按钮
- 仅在 runner 游戏激活时显示

### 4. 跑道系统
- 3 条跑道，间距固定
- 跑道段（chunk）循环生成/销毁
- 障碍物随距离递增密度

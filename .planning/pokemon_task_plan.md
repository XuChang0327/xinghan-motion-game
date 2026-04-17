# 宝可梦风格 RPG 游戏 - 任务计划

## 概述
在现有星瀚体感游戏框架中添加一个宝可梦风格的复古像素 RPG 引擎，使用 P2 手柄控制。

## Phase 1: 基础架构 - `in_progress`
- [x] 分析现有游戏框架和串口协议
- [ ] 在 gameInfo 和菜单中注册 pokemon 游戏
- [ ] 在 startGame 中添加 pokemon 分支
- [ ] 在 onSerialDirection/onSerialButton 中添加 pokemon 分发

## Phase 2: 核心引擎 - `pending`
- [ ] 瓷砖地图系统（Tile types: 0=地面, 1=墙壁, 2=草丛, 3=NPC）
- [ ] 碰撞检测（移动前判断目标格子）
- [ ] 网格对齐移动（平滑过渡动画，移动完成前不接受新指令）
- [ ] 相机跟随系统（平滑跟随玩家）

## Phase 3: P2 串口输入 - `pending`
- [ ] 监听 P2|JOY:UP/DOWN/LEFT/RIGHT → 角色移动 1 格
- [ ] 监听 P2|BTN:PRESSED → 对话/确认
- [ ] 移动中锁定输入（防止位置错位）

## Phase 4: 视觉表现 - `pending`
- [ ] 玩家：红色方块（面向不同方向颜色略变）
- [ ] 草丛：绿色带虚线
- [ ] 障碍：灰色
- [ ] NPC：紫色方块
- [ ] 草丛进入时视觉反馈
- [ ] 对话框显示

## Phase 5: 测试地图 - `pending`
- [ ] 20x20 网格地图
- [ ] 包含各种 Tile 类型
- [ ] NPC 对话功能
- [ ] 完整测试

## 技术决策
- 使用现有 Canvas (750x500) 和游戏循环
- P2 手柄控制（JOY 方向 + BTN 确认）
- 16px 或 32px 网格（基于 750x500 canvas，用 32px，可显示约 23x15 格的视口）
- 地图超出屏幕时相机跟随

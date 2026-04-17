# 钓鱼达人游戏 - 任务计划

## Phase 1: 基础架构 [in_progress]
- [x] 更新 gameInfo 和 startGame 路由
- [x] 更新 HTML 菜单描述
- [ ] 创建 startFishing() 函数骨架

## Phase 2: 鱼类数据库 [pending]
- [ ] 50种鱼（Common/Rare/Epic/Legendary/Mythic）
- [ ] 2种彩蛋鱼（0.1%概率）
- [ ] 规格系统（小0.8x/中1.0x/大1.3x）
- [ ] 概率权重和基础拉力值

## Phase 3: 核心玩法 [pending]
- [ ] 等待期：甩竿后3-10秒随机上钩
- [ ] 对抗期：进度条拉力对抗（鱼向外拉 vs 玩家卷线）
- [ ] 胜负判定：进度归零=逃跑，进度满=捕获

## Phase 4: 图鉴系统 [pending]
- [ ] 卡片式UI展示已解锁鱼类
- [ ] 记录最大尺寸、捕获次数
- [ ] 未解锁显示暗影

## Phase 5: 串口集成 [pending]
- [ ] BTN:PRESSED → 甩竿/确认
- [ ] JOY方向 → 菜单导航
- [ ] DEGREE旋转 → 卷线（对抗期主要输入）
- [ ] RAW_JOY y轴 → 辅助卷线

## Phase 6: 视觉效果 [pending]
- [ ] 水面波纹动画
- [ ] 鱼上钩屏幕震动 + "HOOKED!"
- [ ] 钓鱼成功/失败动画
- [ ] 仪表盘式UI（拉力条、速度等）

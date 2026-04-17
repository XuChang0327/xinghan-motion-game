# 第一视角赛车 (FPV Racing) - 任务计划

## Phase 1: 基础架构 [in_progress]
- [ ] 添加游戏菜单入口 (index.html + gameInfo)
- [ ] 创建 startRacing() 函数骨架
- [ ] 实现伪3D赛道渲染引擎（Canvas 2D模拟3D透视）

## Phase 2: 赛道与物理 [pending]
- [ ] 赛道段数据结构（弯道、直道、坡度）
- [ ] 物理系统：摩擦力、空气阻力、加速度、刹车
- [ ] 碰撞检测：护栏碰撞大幅减速
- [ ] 路面类型：正常、草地（减速）

## Phase 3: 驾驶控制 [pending]
- [ ] DEGREE → 方向盘转向（带数据平滑/低通滤波）
- [ ] RAW_JOY y轴 → 油门/刹车/倒车
- [ ] BTN:PRESSED → 氮气加速
- [ ] 键盘备选：方向键/WASD

## Phase 4: 视觉效果 [pending]
- [ ] 驾驶舱视角：仪表盘、引擎盖
- [ ] 速度感：FOV 动态变化
- [ ] 转向倾斜：离心力视觉效果
- [ ] 速度线/模糊效果

## Phase 5: AI车辆与计时 [pending]
- [ ] AI 车辆生成与行驶逻辑
- [ ] 碰撞/超车逻辑
- [ ] 圈速计时系统 (Lap Time)
- [ ] 速度表 (KM/H)

## Phase 6: 串口集成 [pending]
- [ ] handleSerialData 路由到赛车控制
- [ ] onSerialRawJoy → 油门/刹车
- [ ] onSerialDegree → 转向
- [ ] onSerialButton → 氮气

## 技术决策
- 使用 Canvas 2D 伪3D渲染（类似 OutRun/Pole Position 风格）
- 不使用 Three.js（避免额外依赖，项目已有 Vite + 纯 HTML 架构）
- 使用段(segment)投影技术实现3D透视效果
- 数据平滑使用指数移动平均(EMA)滤波器

# 外置陀螺仪体感游戏 - 任务计划

## 需求概要
在现有 ESP32 串口游戏平台中新增一个**陀螺仪体感游戏**，利用外置 ESP32 陀螺仪模块（IMU，如 MPU6050/BMI160）发送姿态数据，通过串口传输到浏览器，实现体感控制的游戏体验。

## 游戏设计：🎯 体感平衡球（Gyro Balance Ball）
- **核心玩法**：通过倾斜陀螺仪控制一个小球在迷宫/平台上滚动，收集星星，避开陷阱
- **操作方式**：
  - 陀螺仪前倾/后仰 → 球前进/后退
  - 陀螺仪左倾/右倾 → 球左移/右移
  - 串口按钮 → 跳跃/确认
- **数据协议**：
  - `GYRO:<pitch>,<roll>,<yaw>` — 陀螺仪三轴姿态角（度）
  - 已有的 `JOY:`, `BTN:`, `RAW_JOY:` 协议可作为备用控制
- **视觉**：俯视视角2D渲染，物理模拟球的惯性和摩擦

## Phase 1: 串口协议扩展 [pending]
- [ ] 在 handleSerialData 中添加 `GYRO:pitch,roll,yaw` 解析
- [ ] 创建 onSerialGyro(pitch, roll, yaw, source) 事件分发函数
- [ ] 添加陀螺仪数据到调试缓冲区

## Phase 2: 游戏注册与UI集成 [pending]
- [ ] 在 gameInfo 中注册 'gyro' 游戏
- [ ] 在 index.html 游戏菜单中添加入口
- [ ] 在 startGame switch 中添加 case
- [ ] 在 stopCurrentGame 中添加清理逻辑

## Phase 3: 游戏核心实现 [pending]
- [ ] 关卡系统（多关卡切换，难度递增）
- [ ] 物理引擎：球的惯性、摩擦、碰撞
- [ ] 迷宫/平台生成（墙壁、陷阱、星星）
- [ ] 陀螺仪 → 重力方向映射
- [ ] Canvas 2D 俯视渲染
- [ ] 粒子效果（收集星星、掉入陷阱）

## Phase 4: 串口手柄控制集成 [pending]
- [ ] 在 onSerialDirection / onSerialRawJoy 中分发给陀螺仪游戏
- [ ] GYRO 数据 → 游戏内重力映射
- [ ] BTN → 跳跃
- [ ] 陀螺仪校准功能（长按按钮校准零点）

## Phase 5: 体验优化 [pending]
- [ ] 分数显示、最高分记录
- [ ] 关卡选择界面
- [ ] 键盘模拟控制（WASD 模拟倾斜）
- [ ] 音效提示（收集、碰撞）用视觉替代
- [ ] 陀螺仪灵敏度调节

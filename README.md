# 星瀚体感游戏网站 (Xinghan Motion Game)

基于 Web Serial API 和 Web Bluetooth API 的体感游戏平台，通过 ESP32 控制器实现体感交互。

## 功能特性

- **串口/蓝牙双模连接** — 支持 USB 串口和 BLE 两种方式连接 ESP32 控制器
- **陀螺仪体感控制** — 摇晃、前后左右倾斜等体感操作
- **电机角度检测** — 实时读取电机累计角度，用于钓鱼等游戏玩法
- **钓鱼游戏** — 基于体感操作的钓鱼游戏，含完整素材和音效

## 技术栈

- **前端**: 原生 HTML/CSS/JS + Three.js
- **构建工具**: Vite
- **硬件通信**: Web Serial API / Web Bluetooth API
- **硬件端**: MicroPython (ESP32)

## 串口通信协议

设备上报：
```
GYRO|摇晃
GYRO|向前倾斜 / 向后倾斜 / 向左倾斜 / 向右倾斜
ANGLE|<degree>
```

主机下发：
```
RESET          — 清零电机累计角
FISH_BITE_START / FISH_BITE / FISH_CAUGHT — 钓鱼游戏状态指令
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 启动开发服务器
pnpm dev
```

浏览器访问 `http://localhost:8000`，点击连接按钮配对 ESP32 控制器即可开始游戏。

> 注意：Web Serial / Web Bluetooth 需要 HTTPS 或 localhost 环境，且需使用 Chrome/Edge 浏览器。

## 硬件端

`hardware_main.py` 为 ESP32 MicroPython 固件程序，负责陀螺仪数据采集和电机角度上报。

## 项目结构

```
├── index.html          # 主页面
├── main.js             # 串口/蓝牙通信与游戏逻辑
├── style.css           # 样式
├── hardware_main.py    # ESP32 硬件端程序
├── assets/             # 游戏素材（图片、音效）
├── vite.config.js      # Vite 配置
└── package.json        # 项目依赖
```

## License

Private - All Rights Reserved
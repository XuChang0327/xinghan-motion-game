# -*- coding: utf-8 -*-
"""
设备端启动器（可选维护件）—— 仅用于固件不会自动引导容器程序的设备。

本机实测：厂商固件系统可自行引导/在设备端手动选择运行容器程序，
因此日常流程不需要本启动器；网页「脚本注入」区已不提供刷入按钮，
本文件仅作为引擎层 launcher 目标的载荷与移植参考保留
（见《网页端代码注入-可移植通用方案.md》§11）。

职责（若确需使用）：
1. 开机读取 /_container 指针，得到网页端指定的容器目录；
2. 读不到或无效时，按 container1..container5 顺序回退，
   找第一个含有 钓鱼达人.py 的容器；
3. exec 该容器内的 钓鱼达人.py，进入正常业务循环；
4. 找不到任何程序时打印 BOOT:NO_PROGRAM，随后停在 REPL 便于诊断。

契约：
- 刷入本文件会覆盖设备根目录 /main.py（原固件入口），属维护操作；
  日常「注入脚本到容器」永远不会覆盖它；
- 容器内程序文件名固定 钓鱼达人.py（须与网页端注入的落盘名一致）；
- 启动横幅 BOOT:RUN:<container> / BOOT:NO_PROGRAM 供网页端在
  注入复位后确认"新程序真的在跑"。

刷入方式（仅维护时）：
- 电脑端：mpremote cp device_main.py :main.py
"""

import os

PICK = "/_container"
FALLBACK = ["container1", "container2", "container3", "container4", "container5"]
PROGRAM = "钓鱼达人.py"


def resolve():
    try:
        with open(PICK) as f:
            d = f.read().strip()
        if d and PROGRAM in os.listdir(d):
            return d
    except OSError:
        pass
    for d in FALLBACK:
        try:
            if PROGRAM in os.listdir(d):
                return d
        except OSError:
            pass
    return None


target = resolve()
if target:
    print("BOOT:RUN:" + target)
    try:
        with open(PICK, "w") as f:
            f.write(target)
    except OSError:
        pass
    exec(open(target + "/" + PROGRAM).read(), {"__name__": "__main__"})
else:
    print("BOOT:NO_PROGRAM")

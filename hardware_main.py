# -*- coding: utf-8 -*-
"""
星瀚控制器统一硬件端程序。

硬件范围收敛为：
- 控制器本体：陀螺仪摇晃用于开始 / 继续游戏
- 控制器本体：陀螺仪前后左右倾斜用于贪吃蛇方向控制
- 一个电机：持续上报累计角度，供软件端按当前游戏解释

串口输出协议与网页端 main.js 对齐：
- GYRO|摇晃
- GYRO|向前倾斜
- GYRO|向后倾斜
- GYRO|向左倾斜
- GYRO|向右倾斜
- ANGLE|<degree>

主机下发指令：
- RESET: 清零电机累计角
- FISH_BITE_START / FISH_BITE / FISH_CAUGHT: 当前保留，状态由软件端处理
"""

import sys
import time

try:
    import select
except ImportError:
    select = None

import r2
from r2_encoder_motor import EncoderMotor


MOTOR_PORT = "A"

# 主循环周期。0.02s = 50Hz，让电机控制挡板时更跟手。
LOOP_INTERVAL_S = 0.02

# 电机角度上报频率。
ANGLE_EVERY_N = 1

# 陀螺仪状态检查频率。角度高频上报时，陀螺仪降到约 16Hz 即可。
GYRO_EVERY_N = 3

# 摇晃事件防抖，避免一次摇晃触发多次开始。
SHAKE_COOLDOWN_S = 0.8

TILT_STATES = ("向前倾斜", "向后倾斜", "向左倾斜", "向右倾斜")


def make_stdin_poller():
    if select is None:
        return None
    try:
        poller = select.poll()
        poller.register(sys.stdin, select.POLLIN)
        return poller
    except Exception:
        return None


def has_host_line(poller):
    if poller is None:
        return False
    try:
        return bool(poller.poll(0))
    except Exception:
        return False


def process_host_line(line, motor):
    if line == "RESET":
        motor.clear_total_rotation()
    elif line == "FISH_BITE_START" or line == "FISH_BITE":
        # 上钩参考角由软件端快照处理，这里不清零，避免破坏相对角计算。
        pass
    elif line == "FISH_CAUGHT":
        pass


def read_attitude_state():
    try:
        return r2.attitude_state()
    except Exception:
        return None


def attitude_name(attitude_state):
    if not attitude_state:
        return None
    try:
        return attitude_state[0]
    except Exception:
        return None


def is_shaking(attitude_state):
    return attitude_name(attitude_state) == "摇晃"


def is_tilt(attitude_state):
    return attitude_name(attitude_state) in TILT_STATES


def main():
    motor = EncoderMotor(MOTOR_PORT)
    motor.clear_total_rotation()

    try:
        r2.matrix_clear()
    except Exception:
        pass

    poller = make_stdin_poller()
    angle_tick = 0
    gyro_tick = 0
    last_shake_at = -999
    last_attitude_name = None

    while True:
        while has_host_line(poller):
            raw = sys.stdin.readline()
            if raw == "":
                break
            process_host_line(raw.strip(), motor)

        angle_tick += 1
        if angle_tick >= ANGLE_EVERY_N:
            angle_tick = 0
            try:
                raw_deg = float(motor.total_rotation())
                print("ANGLE|{:.1f}".format(raw_deg))
            except Exception:
                pass

        gyro_tick += 1
        if gyro_tick >= GYRO_EVERY_N:
            gyro_tick = 0
            state = read_attitude_state()
            name = attitude_name(state)
            now = time.time()
            if is_shaking(state) and now - last_shake_at >= SHAKE_COOLDOWN_S:
                last_shake_at = now
                print("GYRO|摇晃")
                last_attitude_name = name
            elif is_tilt(state) and name != last_attitude_name:
                print("GYRO|{}".format(name))
                last_attitude_name = name
            elif name not in TILT_STATES:
                last_attitude_name = name

        time.sleep(LOOP_INTERVAL_S)


if __name__ == "__main__":
    main()

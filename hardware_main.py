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
- DIAG|<code>（诊断信息，如 MOTOR_ERROR / MOTOR_RECOVERED，软件端可忽略）

主机下发指令：
- RESET: 清零电机累计角
- FISH_BITE_START / FISH_BITE / FISH_CAUGHT: 当前保留，状态由软件端处理

防卡死设计（针对“运行两局后不再向电脑发数据”的故障）：
1. stdin 按字节非阻塞读取并自行拼行，不用 readline()——避免主机
   数据缺换行符时整个主循环永久阻塞；
2. 所有 print 包裹异常保护；
3. 电机调用异常自动计数，连续失败达到阈值后自动重建电机对象
   （应对编码器/I2C 总线在重负载后挂起）；
4. 主循环单圈耗时异常（从驱动死等中返回）时同样触发电机重建；
5. 电机读数失败期间保持低频 DIAG 心跳，让软件端能区分
   “电机坏了”和“整个程序卡死”。
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

# 电机连续失败多少次后尝试重建（约 0.02s * 25 = 0.5s）。
MOTOR_RECOVER_AFTER = 25

# 两次电机重建尝试之间的最小间隔，避免总线异常时高频重试。
MOTOR_RECOVER_INTERVAL_S = 1.0

# 单圈主循环超过该时长视为曾被驱动调用阻塞，触发电机重建。
LOOP_STALL_S = 2.0

TILT_STATES = ("向前倾斜", "向后倾斜", "向左倾斜", "向右倾斜")


def safe_print(text):
    try:
        print(text)
    except Exception:
        pass


def make_stdin_poller():
    if select is None:
        return None
    try:
        poller = select.poll()
        poller.register(sys.stdin, select.POLLIN)
        return poller
    except Exception:
        return None


class HostLineReader:
    """非阻塞读取主机指令并自行拼行。

    不使用 sys.stdin.readline()：poll(0) 只保证“至少有 1 个字节”，
    如果主机发来的行丢了换行符（串口 RX 缓冲溢出丢字节时可能发生），
    readline() 会永久阻塞，整个主循环随之卡死。这里只在 poll 报告
    可读时读 1 个字节，凑成完整行才上抛，凑不成就留在缓冲区等待。
    """

    MAX_LINE_BYTES = 128

    def __init__(self, poller):
        self.poller = poller
        self.buf = ""

    def drain(self):
        lines = []
        while self._readable():
            try:
                ch = sys.stdin.read(1)
            except Exception:
                break
            if not ch:
                break
            if ch == "\n":
                line = self.buf.strip()
                self.buf = ""
                if line:
                    lines.append(line)
                continue
            self.buf += ch
            if len(self.buf) > self.MAX_LINE_BYTES:
                # 一直没有换行符的超长输入按垃圾丢弃，防止缓冲无限增长。
                self.buf = ""
        return lines

    def _readable(self):
        if self.poller is None:
            return False
        try:
            return bool(self.poller.poll(0))
        except Exception:
            return False


class MonitoredMotor:
    """带故障统计与自愈的电机封装。

    电机通过总线（常见为 I2C）通信，长时间重负载后总线可能挂起，
    表现为调用持续抛异常。连续失败达到阈值时重建 EncoderMotor，
    相当于软件层面的重新上电。
    """

    def __init__(self, port):
        self.port = port
        self.failures = 0
        self.recoveries = 0
        self._motor = EncoderMotor(port)
        try:
            self._clear()
        except Exception:
            # 上电时总线即异常不应让程序崩溃，计入失败由自愈流程处理。
            self.failures += 1

    def _clear(self):
        self._motor.clear_total_rotation()

    def read_total_rotation(self):
        try:
            value = float(self._motor.total_rotation())
            self.failures = 0
            return value
        except Exception:
            self.failures += 1
            return None

    def reset(self):
        try:
            self._clear()
            self.failures = 0
        except Exception:
            self.failures += 1

    def maybe_recover(self, now, last_recover_at):
        """连续失败达到阈值时尝试重建电机；返回更新后的 last_recover_at。"""
        if self.failures < MOTOR_RECOVER_AFTER:
            return last_recover_at
        if now - last_recover_at < MOTOR_RECOVER_INTERVAL_S:
            return last_recover_at
        try:
            self._motor = EncoderMotor(self.port)
            self._clear()
            self.failures = 0
            self.recoveries += 1
            safe_print("DIAG|MOTOR_RECOVERED")
        except Exception:
            pass
        return now


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


def process_host_line(line, motor):
    if line == "RESET":
        motor.reset()
    elif line == "FISH_BITE_START" or line == "FISH_BITE":
        # 上钩参考角由软件端快照处理，这里不清零，避免破坏相对角计算。
        pass
    elif line == "FISH_CAUGHT":
        pass


def main():
    motor = MonitoredMotor(MOTOR_PORT)
    host = HostLineReader(make_stdin_poller())

    try:
        r2.matrix_clear()
    except Exception:
        pass

    angle_tick = 0
    gyro_tick = 0
    last_shake_at = -999
    last_attitude_name = None
    last_recover_at = -999
    last_diag_at = -999

    while True:
        loop_started_at = time.time()

        for line in host.drain():
            process_host_line(line, motor)

        angle_tick += 1
        if angle_tick >= ANGLE_EVERY_N:
            angle_tick = 0
            raw_deg = motor.read_total_rotation()
            if raw_deg is not None:
                safe_print("ANGLE|{:.1f}".format(raw_deg))
            elif loop_started_at - last_diag_at >= 1.0:
                last_diag_at = loop_started_at
                safe_print("DIAG|MOTOR_ERROR")

        gyro_tick += 1
        if gyro_tick >= GYRO_EVERY_N:
            gyro_tick = 0
            state = read_attitude_state()
            name = attitude_name(state)
            now = time.time()
            if is_shaking(state) and now - last_shake_at >= SHAKE_COOLDOWN_S:
                last_shake_at = now
                safe_print("GYRO|摇晃")
                last_attitude_name = name
            elif is_tilt(state) and name != last_attitude_name:
                safe_print("GYRO|{}".format(name))
                last_attitude_name = name
            elif name not in TILT_STATES:
                last_attitude_name = name

        now = time.time()
        if now - loop_started_at > LOOP_STALL_S:
            # 单圈耗时异常说明某个驱动调用曾长时间阻塞后返回，
            # 主动标记故障并触发电机重建。
            motor.failures = MOTOR_RECOVER_AFTER
        last_recover_at = motor.maybe_recover(now, last_recover_at)

        spent = time.time() - loop_started_at
        if spent < LOOP_INTERVAL_S:
            time.sleep(LOOP_INTERVAL_S - spent)


if __name__ == "__main__":
    main()

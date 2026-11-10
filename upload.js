// ===== 脚本注入引擎（Web Serial → MicroPython raw REPL / raw paste） =====
// 实现《硬件代码注入技术方案.md》P0 协议：
//   - raw paste 官方流控（探测失败自动回退普通 raw REPL 256B 分组）
//   - 按 \x04 帧分隔符判定成败（禁止子串匹配，红线 1）
//   - CRC32 内容校验（浏览器查表实现，与 ubinascii.crc32 等价）
//   - .tmp → 设备端 CRC/字节数比对 → 清容器旧文件 → rename 原子写入
//     （比对不过容器原样保留、旧程序完好，红线 4）
//   - 设备侧异常原文上屏（E: 帧 / Traceback）
// 端口生命周期由调用方（main.js）管理：引擎只在已打开的端口上收发。
// 经典脚本，暴露 window.FirmwareUploader。
(function () {
  'use strict';

  // ---------- 控制字符（附录 C） ----------
  const CTRL_A = 0x01; // 进入 raw REPL；paste 会话中 = 窗口扩充
  const CTRL_B = 0x02; // 退出 raw，回 friendly
  const CTRL_C = 0x03; // 中断运行中的程序
  const CTRL_D = 0x04; // 结束输入/触发执行；paste 中 = 帧分隔符/停发
  const CTRL_E = 0x05; // raw paste 序列前导

  // ---------- 超时参数（§5.12，语义 = deadline 上限，不是节拍） ----------
  const T_HALT = 2000;         // 单次 Ctrl-C 后等 REPL 提示符
  const T_PROBE = 1000;        // raw paste 探测应答
  const T_WINDOW = 1000;       // 流控窗口读取
  const T_FLOW_ACK = 3000;     // 传输中等单个流控字节
  const T_TRANSFER = 30000;    // 整个传输阶段上限
  const T_COMPILE = 10000;     // EOT 后等编译完成帧
  const T_OUTPUT = 15000;      // 输出帧/异常帧
  const T_EXIT = 1000;         // Ctrl-B 后等 friendly 提示符
  const T_BANNER = 8000;       // soft_reset 后等启动横幅
  const T_SESSION = 60000;     // 整会话硬上限
  const RAW_CHUNK = 256;       // 普通 raw 模式分组大小（mpremote 同参数）
  const RAW_CHUNK_GAP_MS = 10; // 分组间限速间隔

  // ---------- 错误码 → 用户可见文案（§6） ----------
  const ERROR_INFO = {
    NoPortChosen:        { message: '未选择设备，已取消', suggestion: '重试并在弹窗中选择 ESP32 对应的串口' },
    NotInRepl:           { message: '设备未响应 REPL 探测', suggestion: '设备固件既不支持 raw paste 也无法进入 raw REPL，或程序占用串口；请重新插拔 USB 后重试' },
    TransferTimeout:     { message: '传输中断（等待设备流控应答超时）', suggestion: '设备上旧版本未受影响，请重试；反复失败请换线/换口' },
    DeviceError:         { message: '设备侧执行报错', suggestion: '查看下方设备原始报错' },
    ContentMismatch:     { message: 'CRC 校验不一致，数据在传输中损坏', suggestion: '已自动重试仍失败，请换线/换口后重试' },
    BootNotObserved:     { message: '文件已写入并校验通过，但未检测到设备启动横幅', suggestion: '请手动复位设备或重新插拔 USB 观察（仅「启动器维护刷入」会以该码失败；日常容器注入无横幅时按降级成功处理）' },
    DeviceGone:          { message: '设备已断开（拔线或 USB 重枚举）', suggestion: '请重新连接 USB；设备上旧版本文件未受影响' },
    Cancelled:           { message: '已取消', suggestion: '' },
    Timeout:             { message: '会话总时长超限', suggestion: '请重试；反复超时请检查波特率与数据线' },
    FetchFailed:         { message: '读取脚本源码失败', suggestion: '确认站点根目录存在 hardware_main.py / device_main.py' },
    BadTarget:           { message: '非法注入目标', suggestion: '容器仅允许 container1..container5' },
    PortError:           { message: '串口读写异常', suggestion: '请重新插拔设备后重试' },
  };

  // W: 警告帧 → 用户可见文案（回帧契约：非致命，记降级项仍判成功）
  const WARN_TEXT = {
    _container_write_failed: '启动指针 /_container 写入失败：脚本已就位，但未设为默认启动项（设备固件系统自行引导容器时无影响）',
  };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  class LinkError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'LinkError';
      this.code = code;
    }
  }

  // ---------- CRC32（与 ubinascii.crc32 / zlib.crc32 等价，256 项查表） ----------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function crc32hex(bytes) {
    return crc32(bytes).toString(16).padStart(8, '0');
  }

  // ---------- 工具：UTF-8 源码 → base64（btoa 不支持非 ASCII，先转字节） ----------
  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function bytesToText(arr) {
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(arr));
  }

  // 诊断用：把最近收到的原始字节转成可见文本（控制字符转义）
  function decodeTail(arr) {
    return bytesToText(arr).replace(/[\x00-\x1f\x7f]/g,
      (ch) => '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0'));
  }

  // 在字节数组里找 ASCII 子串；matcher 返回 {value, consumed} 或 null
  function textMatcher(str) {
    const target = Array.from(new TextEncoder().encode(str));
    return (buf) => {
      for (let i = 0; i + target.length <= buf.length; i++) {
        let ok = true;
        for (let j = 0; j < target.length; j++) {
          if (buf[i + j] !== target[j]) { ok = false; break; }
        }
        if (ok) return { value: i + target.length, consumed: i + target.length };
      }
      return null;
    };
  }

  const frameEndMatcher = (buf) => {
    const i = buf.indexOf(CTRL_D);
    return i >= 0 ? { value: buf.slice(0, i), consumed: i + 1 } : null;
  };

  // ---------- 传输层：SerialLink ----------
  // 单一 pump 读循环把字节收进 buf；readUntil 按 matcher 消费。
  // 同时维护最近 512 字节 tail 供失败诊断（rawTail 上屏，§6 设计要点）。
  class SerialLink {
    constructor(port) {
      this.port = port;
      this.writer = null;
      this.reader = null;
      this.buf = [];          // 未被协议层消费的字节
      this.tail = [];         // 诊断环形缓冲（最近 512 字节）
      this.waiters = [];
      this.readError = null;
      this.pumpDone = false;
    }

    async start() {
      this.writer = this.port.writable.getWriter();
      this.reader = this.port.readable.getReader();
      this._pump();
    }

    _wake() {
      const w = this.waiters;
      this.waiters = [];
      for (const resolve of w) resolve();
    }

    _pump() {
      (async () => {
        try {
          while (true) {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value && value.length) {
              for (let i = 0; i < value.length; i++) {
                this.buf.push(value[i]);
                this.tail.push(value[i]);
              }
              if (this.tail.length > 512) this.tail.splice(0, this.tail.length - 512);
              // 防御性上限：halt 阶段设备 50Hz 输出可能灌满缓冲
              if (this.buf.length > 16384) this.buf.splice(0, this.buf.length - 2048);
              this._wake();
            }
          }
        } catch (e) {
          this.readError = e;
        } finally {
          this.pumpDone = true;
          this._wake();
        }
      })();
    }

    async write(data) {
      if (this.readError) throw new LinkError('DeviceGone', '设备已断开: ' + this.readError.message);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      try {
        await this.writer.write(bytes);
      } catch (e) {
        throw new LinkError('DeviceGone', '串口写入失败: ' + e.message);
      }
    }

    // 等到 matcher(buf) 命中：消费 matched 字节并返回 value；超时抛 Timeout
    async readUntil(matcher, deadlineMs, label, signal) {
      const deadline = Date.now() + deadlineMs;
      for (;;) {
        if (signal && signal.aborted) throw new LinkError('Cancelled', '已取消');
        if (this.readError) throw new LinkError('DeviceGone', '设备已断开: ' + this.readError.message);
        const r = matcher(this.buf);
        if (r) {
          this.buf.splice(0, r.consumed);
          return r.value;
        }
        if (this.pumpDone) throw new LinkError('DeviceGone', '串口读流已结束');
        const remain = deadline - Date.now();
        if (remain <= 0) throw new LinkError('Timeout', label + ' 超时（' + deadlineMs + 'ms）');
        await new Promise((resolve) => {
          this.waiters.push(resolve);
          setTimeout(resolve, Math.min(remain, 50));
        });
      }
    }

    // 等到任意新字节到达（不消费）；paste 流控窗口耗尽时用
    async waitForAnyByte(deadlineMs, label, signal) {
      return this.readUntil((b) => (b.length ? { value: true, consumed: 0 } : null),
        deadlineMs, label, signal);
    }

    shiftByte() { return this.buf.length ? this.buf.shift() : null; }

    clearBuf() { this.buf.length = 0; }

    rawTail() { return decodeTail(this.tail); }

    // 幂等释放：只解锁、不 close 端口（端口生命周期归调用方）
    async release() {
      try { if (this.reader) await this.reader.cancel(); } catch (e) { /* ignore */ }
      await sleep(0); // 让 pump 循环退出，避免 releaseLock 撞未决 read
      try { if (this.reader) { this.reader.releaseLock(); } } catch (e) { /* ignore */ }
      this.reader = null;
      try { if (this.writer) { this.writer.releaseLock(); } } catch (e) { /* ignore */ }
      this.writer = null;
    }
  }

  // ---------- 协议层：MicroPyProtocol ----------
  class MicroPyProtocol {
    constructor(link, opts) {
      this.link = link;
      this.signal = opts.signal || null;
      this.degraded = [];
    }

    // H：\x03 打断业务主循环，等 friendly REPL 提示符（§5.3-H）
    // 未命中不中止，标 degraded，由 probe 做最终裁决（§5.2）
    async halt() {
      for (let attempt = 0; attempt < 2; attempt++) {
        await this.link.write(new Uint8Array([CTRL_C]));
        try {
          await this.link.readUntil(textMatcher('>>>'), T_HALT, '等待 REPL 提示符', this.signal);
          this.link.clearBuf();
          return;
        } catch (e) {
          if (e.code === 'Cancelled' || e.code === 'DeviceGone') throw e;
        }
      }
      this.degraded.push('HaltNoPrompt');
      this.link.clearBuf();
    }

    // P：\x05 'A' \x01 探测 raw paste（附录 A）
    // R\x01 → paste（含 2B LE 窗口增量）；"ra…" → 消费横幅后按 raw
    // R\x00（paste 无流控）与非 R 应答（定制固件把握手字符当粘贴内容回显）
    // → 统一回退：halt 取消 paste 态 → Ctrl-A 进 raw REPL → 256B 分组（§5.11，实机验证）
    async probePaste() {
      try {
        this.link.clearBuf();
        await this.link.write(new Uint8Array([CTRL_E, 0x41, CTRL_A]));
        const magic = await this.link.readUntil(
          (buf) => (buf.length >= 2 ? { value: [buf[0], buf[1]], consumed: 2 } : null),
          T_PROBE, 'raw paste 探测', this.signal);
        if (magic[0] === 0x52) { // 'R'
          if (magic[1] === 0x01) {
            const win = await this.link.readUntil(
              (buf) => (buf.length >= 2 ? { value: buf[0] | (buf[1] << 8), consumed: 2 } : null),
              T_WINDOW, '读取流控窗口', this.signal);
            this.link.clearBuf();
            return { mode: 'paste', windowInc: win > 0 ? win : 256 };
          }
          // R\x00：raw paste 无流控。此时设备已处于 paste 模式等待内容、
          // 结果帧按 \x04 分隔而非 OK 前缀，本引擎不走该分支——
          // 落到下方 probeRawRepl 回退（halt 的 Ctrl-C 会取消 paste 态）
        }
        if (magic[0] === 0x72 && magic[1] === 0x61) { // "ra"：老固件，\x01 已触发 raw REPL
          try {
            await this.link.readUntil(textMatcher('CTRL-B to exit'), T_PROBE, '消费 raw REPL 横幅', this.signal);
          } catch (e) { /* 横幅不完整也继续 */ }
          this.link.clearBuf();
          return { mode: 'raw' };
        }
        // 其它应答：固件进入了传统 paste 模式并回显了 'A\x01'，
        // 说明不支持 raw-paste 流控 → 走 raw REPL 回退
      } catch (e) {
        if (e.code === 'Cancelled' || e.code === 'DeviceGone') throw e;
        // 探测无应答，同样走 raw REPL 回退
      }
      return await this.probeRawRepl();
    }

    // 降级路径（实测：定制固件只回显握手字符）：
    // Ctrl-C 取消可能停留的传统 paste 模式 → Ctrl-A 进 raw REPL
    // raw REPL 是 MicroPython 标准能力，横幅 "raw REPL; CTRL-B to exit"
    async probeRawRepl() {
      this.degraded.push('NoRawPaste');
      await this.halt();
      this.link.clearBuf();
      await this.link.write(new Uint8Array([CTRL_A]));
      try {
        await this.link.readUntil(textMatcher('raw REPL'), T_PROBE, '等待 raw REPL 横幅', this.signal);
        this.link.clearBuf(); // 丢掉横幅尾部与 '>' 提示符
        return { mode: 'raw' };
      } catch (e) {
        if (e.code === 'Cancelled' || e.code === 'DeviceGone') throw e;
        throw new LinkError('NotInRepl',
          '设备不支持 raw paste，且 Ctrl-A 后未进入 raw REPL');
      }
    }

    // T（paste）：窗口驱动连续发送；\x01 扩窗，\x04 停发（§5.3-T）
    async pasteTransfer(data, windowInc, onProgress) {
      let window = windowInc;
      let offset = 0;
      const deadline = Date.now() + T_TRANSFER;
      let earlyStop = false;
      while (offset < data.length) {
        if (this.signal && this.signal.aborted) throw new LinkError('Cancelled', '已取消');
        if (this.link.readError) throw new LinkError('DeviceGone', '设备已断开');
        if (Date.now() > deadline) throw new LinkError('TransferTimeout', '传输阶段超时');
        let b;
        while ((b = this.link.shiftByte()) !== null) {
          if (b === CTRL_A) window += windowInc;
          else if (b === CTRL_D) { earlyStop = true; break; }
        }
        if (earlyStop) break;
        if (window > 0) {
          const n = Math.min(window, data.length - offset, 4096);
          await this.link.write(data.subarray(offset, offset + n));
          offset += n;
          window -= n;
          onProgress(offset, data.length);
        } else {
          try {
            await this.link.waitForAnyByte(T_FLOW_ACK, '等待流控字节', this.signal);
          } catch (e) {
            if (e.code === 'Timeout') throw new LinkError('TransferTimeout', '设备流控应答超时');
            throw e;
          }
        }
      }
      if (!earlyStop) {
        // E：\x04 = 数据完毕（§5.3-E）。设备提前 \x04 停发时不再补 EOT
        await this.link.write(new Uint8Array([CTRL_D]));
      }
      return { sent: offset, total: data.length, earlyStop };
    }

    // T（raw 回退）：256B/组 + ~10ms 限速（mpremote 同参数，§5.11）
    // 注：10ms 间隔是发送限速，不是"等待设备"；成败判据仍由帧读取的 deadline 承担
    async rawTransfer(data, onProgress) {
      let offset = 0;
      while (offset < data.length) {
        if (this.signal && this.signal.aborted) throw new LinkError('Cancelled', '已取消');
        if (this.link.readError) throw new LinkError('DeviceGone', '设备已断开');
        const n = Math.min(RAW_CHUNK, data.length - offset);
        await this.link.write(data.subarray(offset, offset + n));
        offset += n;
        onProgress(offset, data.length);
        if (offset < data.length) await sleep(RAW_CHUNK_GAP_MS);
      }
      await this.link.write(new Uint8Array([CTRL_D]));
      return { sent: offset, total: data.length, earlyStop: false };
    }

    // R：按 \x04 切帧读执行结果（§5.3-R，红线 1：禁止整段子串匹配）
    // paste: \x04(编译完) <stdout> \x04 <stderr> \x04 >
    // raw:   OK <stdout> \x04 <stderr> \x04 >
    async readExecResult(mode) {
      if (mode === 'paste') {
        await this.link.readUntil(frameEndMatcher, T_COMPILE, '等待编译完成帧', this.signal);
      } else {
        await this.link.readUntil(textMatcher('OK'), T_COMPILE, '等待 OK 应答', this.signal);
      }
      const stdout = await this.link.readUntil(frameEndMatcher, T_OUTPUT, '等待输出帧', this.signal);
      let stderr = [];
      try {
        stderr = await this.link.readUntil(frameEndMatcher, T_OUTPUT, '等待异常帧', this.signal);
      } catch (e) {
        if (e.code === 'Cancelled' || e.code === 'DeviceGone') throw e;
        // 部分固件无异常时不发第三个分隔符，超时按空异常帧处理
      }
      return { stdout: bytesToText(stdout), stderr: bytesToText(stderr) };
    }

    // 帧内容判定：F:<crc>:<size> 成功 / E:<type>:<msg> 设备异常 / W:<警告> 非致命 / Traceback
    parseExecResult(res) {
      // W: 警告帧不改变成败判定，单独收集（回帧契约：记降级项、仍判成功）
      const warnings = (res.stdout.match(/W:([A-Za-z0-9_]+)/g) || []).map((s) => s.slice(2));
      const fMatch = res.stdout.match(/F:([0-9a-fA-F]{8}):(\d+)/);
      if (fMatch) {
        return { kind: 'ok', crc: fMatch[1].toLowerCase(), size: parseInt(fMatch[2], 10), warnings };
      }
      const eMatch = (res.stdout + '\n' + res.stderr).match(/E:([A-Za-z0-9_.]+):([^\r\n]*)/);
      if (eMatch) {
        // code 单独给出：CRCMismatch = 传输损坏（设备未动旧文件），浏览器侧应重试而非判死
        return { kind: 'deviceError', code: eMatch[1], detail: eMatch[1] + ': ' + eMatch[2] };
      }
      const tb = res.stderr.trim() || res.stdout.trim();
      if (tb) return { kind: 'deviceError', detail: tb };
      return { kind: 'protocol', detail: '未识别到 F:/E: 帧（stdout 与 stderr 均为空）' };
    }

    // X + B：退出 raw → soft_reset → 等启动横幅（§5.3-X/B）
    async exitRawAndReboot() {
      await this.link.write(new Uint8Array([CTRL_B]));
      try {
        await this.link.readUntil(textMatcher('>>>'), T_EXIT, '等待 friendly 提示符', this.signal);
      } catch (e) {
        if (e.code === 'Cancelled') throw e;
        // 失败忽略：soft_reset 指令本身仍会发出
      }
      this.link.clearBuf();
      await this.link.write('import machine; machine.soft_reset()\r\n');
      // 横幅三态：BOOT:（启动器在跑）/ MicroPython（复位了但无启动器）/ 无（超时或断口）
      const bannerMatcher = (buf) => {
        const text = bytesToText(buf);
        const iBoot = text.indexOf('BOOT:');
        const iMP = text.indexOf('MicroPython');
        if (iBoot >= 0) return { value: { kind: 'launcher', text }, consumed: buf.length };
        if (iMP >= 0) return { value: { kind: 'repl', text }, consumed: buf.length };
        return null;
      };
      return await this.link.readUntil(bannerMatcher, T_BANNER, '等待设备启动横幅', this.signal);
    }
  }

  // ---------- 设备侧脚本模板（§5.5，D1 base64 内联通道） ----------
  // 占位符集中在此便于审计：__DIR__ / __FN__ / __B64__ / __ECRC__ / __ESIZE__ / __ACTIVATE__
  // 写入顺序红线：.tmp 全量落盘 → 设备端 CRC/字节数与期望值（浏览器预先算好注入
  // 的 ECRC/ESIZE）比对 → 一致才清空容器旧文件并 rename；不一致只删 tmp、容器原样
  // 保留（旧程序完好），回 E:CRCMismatch 帧由浏览器自动重试。任何异常都变 E: 帧。
  // 清空仅对容器目录（D 非空）生效，绝不清根目录（launcher 写 /main.py 时 D 为空）。
  const DEVICE_SCRIPT_TEMPLATE = [
    'import os, ubinascii',
    'D = "__DIR__"',
    'FN = "__FN__"',
    'B64 = """__B64__"""',
    'ECRC = "__ECRC__"',
    'ESIZE = __ESIZE__',
    'base = D + "/" if D else "/"',
    'tmp = base + "." + FN + ".tmp"',
    'dst = base + FN',
    'try:',
    '    if D:',
    '        try:',
    '            os.stat(D)',
    '        except OSError:',
    '            os.mkdir(D)',
    '    out = open(tmp, "wb")',
    '    for i in range(0, len(B64), 4096):',
    '        out.write(ubinascii.a2b_base64(B64[i:i + 4096]))',
    '    out.close()',
    '    f = open(tmp, "rb")',
    '    crc = 0',
    '    size = 0',
    '    while True:',
    '        blk = f.read(256)',
    '        if not blk:',
    '            break',
    '        crc = ubinascii.crc32(blk, crc)',
    '        size += len(blk)',
    '    f.close()',
    // 设备端比对期望值：内容确认无损之前绝不动旧文件（红线 4 的真正落点；
    // 浏览器侧比对发生在旧文件已被动之后，只能作第二道保险）
    '    if "%08x" % (crc & 0xffffffff) != ECRC or size != ESIZE:',
    '        os.remove(tmp)',
    '        print("E:CRCMismatch:got %08x:%d want %s:%d" % (crc & 0xffffffff, size, ECRC, ESIZE))',
    '    else:',
    // 清空容器：删除目录内除本次 tmp 外的所有旧文件（解决残留多文件、只引导首个的问题）
    '        if D:',
    '            for name in os.listdir(D):',
    '                p = D + "/" + name',
    '                if p != tmp:',
    '                    try:',
    '                        os.remove(p)',
    '                    except OSError:',
    '                        pass',
    '        else:',
    '            try:',
    '                os.remove(dst)',
    '            except OSError:',
    '                pass',
    '        os.rename(tmp, dst)',
    '__ACTIVATE__',
    '        print("F:%08x:%d" % (crc & 0xffffffff, size))',
    'except Exception as e:',
    '    try:',
    '        os.remove(tmp)',
    '    except OSError:',
    '        pass',
    '    print("E:" + str(type(e).__name__) + ":" + str(e))',
    '',
  ].join('\n');

  function buildDeviceScript({ dir, filename, b64, activateContainer, ecrc, esize }) {
    // b64 字母表不含引号，三引号内联安全（§5.5）；ECRC/ESIZE 为十六进制/十进制字面量
    // 指针写入非致命：文件已校验并 rename 到位后，/_container 写失败只打 W: 警告，
    // 仍输出 F: 成功帧（厂商固件系统可能不依赖该指针文件）
    const activate = activateContainer
      ? '        try:\n'
        + '            pf = open("/_container", "w")\n'
        + '            pf.write("' + activateContainer + '")\n'
        + '            pf.close()\n'
        + '        except OSError:\n'
        + '            print("W:_container_write_failed")'
      : '';
    return DEVICE_SCRIPT_TEMPLATE
      .replace('__DIR__', dir)
      .replace('__FN__', filename)
      .replace('__B64__', b64)
      .replace('__ECRC__', ecrc)
      .replace('__ESIZE__', String(esize))
      .replace('__ACTIVATE__', activate);
  }

  // ---------- 会话层 ----------
  function fail(code, extra, link, startedAt) {
    const info = ERROR_INFO[code] || { message: code, suggestion: '' };
    return Object.assign({
      ok: false,
      code,
      message: (extra && extra.message) || info.message,
      deviceError: (extra && extra.deviceError) || '',
      rawTail: link ? link.rawTail() : '',
      suggestion: info.suggestion,
      ms: Date.now() - startedAt,
    }, extra && extra.extraFields ? extra.extraFields : {});
  }

  /**
   * 注入主流程。
   * @param {Object} opts
   * @param {SerialPort} opts.port        已打开的串口（生命周期归调用方）
   * @param {{kind:'container',container:string}|{kind:'launcher'}} opts.target
   * @param {string} opts.sourceUrl       脚本源码 URL（/hardware_main.py 或 /device_main.py）
   * @param {string} [opts.filename]      容器内落盘文件名，默认 钓鱼达人.py（允许中文；禁止路径分隔符/引号/控制字符）
   * @param {boolean} [opts.activate]     容器注入后是否写 /_container 激活（§5.7）
   * @param {number} [opts.retries]       CRC 不一致时整会话重试次数，默认 2（§5.11）
   * @param {AbortSignal} [opts.signal]
   * @param {Function} [opts.onEvent]     {phase, sent, total, detail}
   * @returns {Promise<Object>} Result（§5.9）
   */
  async function inject(opts) {
    const startedAt = Date.now();
    const emit = opts.onEvent || (() => {});
    const retries = typeof opts.retries === 'number' ? opts.retries : 2;

    // 目标白名单（§9：禁止任意路径写入；红线 6：日常注入永不碰 /main.py）
    let dir, filename, activateContainer;
    if (opts.target && opts.target.kind === 'launcher') {
      dir = '';
      filename = 'main.py';
      activateContainer = null;
    } else if (opts.target && opts.target.kind === 'container'
      && /^container[1-5]$/.test(opts.target.container)) {
      dir = opts.target.container;
      filename = opts.filename || '钓鱼达人.py';
      activateContainer = opts.activate === false ? null : dir;
      // 文件名安全校验（黑名单制）：拒绝路径分隔符/通配/引号/控制字符与空名、超长名。
      // 非 ASCII（如中文）允许 —— 传输字节透明且经 CRC 校验；源码本身即 UTF-8 中文已实跑验证
      if (!filename || filename.length > 64 || filename === '.' || filename === '..'
        || /[\\/:*?"<>|\x00-\x1f]/.test(filename)) {
        return fail('BadTarget', { message: '非法注入文件名' }, null, startedAt);
      }
    } else {
      return fail('BadTarget', null, null, startedAt);
    }

    // FETCH：获取脚本源码。优先用内嵌副本 sourceText（firmware.js，零网络依赖，
    // 平台代理可能拒发 .py → 403）；无内嵌时回退 fetch（cache-bust 保证最新）
    let source;
    if (typeof opts.sourceText === 'string' && opts.sourceText.trim()) {
      emit({ phase: 'FETCH', detail: '内嵌源码 ' + opts.sourceText.length + ' 字符' });
      source = opts.sourceText;
    } else {
      emit({ phase: 'FETCH', detail: opts.sourceUrl });
      try {
        const resp = await fetch(opts.sourceUrl + '?t=' + Date.now());
        if (!resp.ok) {
          // 带上响应体片段：403/404 到底是谁返回的（vite/平台代理/网关）一眼可辨
          const body = await resp.text().catch(() => '');
          throw new Error('HTTP ' + resp.status
            + (body ? ' — ' + body.replace(/\s+/g, ' ').slice(0, 160) : ''));
        }
        source = await resp.text();
      } catch (e) {
        return fail('FetchFailed', { message: '读取 ' + opts.sourceUrl + ' 失败: ' + e.message }, null, startedAt);
      }
    }
    if (!source || !source.trim()) {
      return fail('FetchFailed', { message: '脚本源码为空' }, null, startedAt);
    }

    const sourceBytes = new TextEncoder().encode(source);
    const expectCrc = crc32hex(sourceBytes);
    const script = buildDeviceScript({
      dir, filename, b64: utf8ToBase64(source), activateContainer,
      ecrc: expectCrc, esize: sourceBytes.length,
    });
    const scriptBytes = new TextEncoder().encode(script);

    const link = new SerialLink(opts.port);
    try {
      await link.start();
    } catch (e) {
      return fail('PortError', { message: '无法接管串口读写流: ' + e.message }, null, startedAt);
    }
    const proto = new MicroPyProtocol(link, opts);

    try {
      emit({ phase: 'HALTING', detail: '打断设备当前程序' });
      await proto.halt();
      emit({ phase: 'PROBING', detail: '探测 raw paste 支持' });
      const cap = await proto.probePaste();
      emit({ phase: 'PROBED', detail: cap.mode === 'paste' ? 'raw paste（窗口 ' + cap.windowInc + '）' : '兼容模式（256B 分组）' });

      let parsed = null;
      let lastFailCode = 'ContentMismatch';
      let lastDetail = '';
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (Date.now() - startedAt > T_SESSION) throw new LinkError('Timeout', '会话总时长超限');
        if (attempt > 0) {
          // 重试前把设备拉回已知状态：退 raw → halt → 重新 probe
          emit({ phase: 'RETRYING', detail: '第 ' + attempt + ' 次重试' });
          try { await link.write(new Uint8Array([CTRL_B])); } catch (e) { /* ignore */ }
          await proto.halt();
          const cap2 = await proto.probePaste();
          cap.mode = cap2.mode;
          cap.windowInc = cap2.windowInc;
        }
        emit({ phase: 'TRANSFERRING', sent: 0, total: scriptBytes.length });
        const onProgress = (sent, total) => emit({ phase: 'TRANSFERRING', sent, total });
        if (cap.mode === 'paste') {
          await proto.pasteTransfer(scriptBytes, cap.windowInc, onProgress);
        } else {
          await proto.rawTransfer(scriptBytes, onProgress);
        }
        emit({ phase: 'COMMITTING', detail: '等待设备写盘并回帧' });
        const exec = await proto.readExecResult(cap.mode);
        parsed = proto.parseExecResult(exec);
        if (parsed.kind === 'ok') {
          emit({ phase: 'VERIFYING', detail: 'CRC 比对' });
          if (parsed.crc === expectCrc && parsed.size === sourceBytes.length) break;
          lastFailCode = 'ContentMismatch';
          lastDetail = '设备 CRC=' + parsed.crc + ' size=' + parsed.size
            + '，期望 CRC=' + expectCrc + ' size=' + sourceBytes.length;
          parsed = null;
          continue;
        }
        if (parsed.kind === 'deviceError') {
          if (parsed.code === 'CRCMismatch') {
            // 设备端比对发现传输损坏：旧文件未被动过（容器原样），重试有意义
            lastFailCode = 'ContentMismatch';
            lastDetail = '设备端 CRC 不符，' + parsed.detail;
            parsed = null;
            continue;
          }
          // 设备侧确定性错误（ENOSPC/权限/语法），重试无意义，立即失败
          return fail('DeviceError', {
            message: '设备报错：' + parsed.detail,
            deviceError: parsed.detail + '\n\n— 设备输出（stdout）—\n' + exec.stdout + '\n— 设备异常（stderr）—\n' + exec.stderr,
          }, link, startedAt);
        }
        lastFailCode = 'ContentMismatch';
        lastDetail = parsed.detail;
        parsed = null;
      }
      if (!parsed) {
        return fail(lastFailCode, { message: ERROR_INFO[lastFailCode].message + '（' + lastDetail + '）' }, link, startedAt);
      }

      // W: 警告帧 → 降级项 + 用户可见 note（非致命，仍判成功；不再被 F: 帧掩盖）
      let warnNote = '';
      if (parsed.warnings && parsed.warnings.length) {
        warnNote = parsed.warnings.map((w) => WARN_TEXT[w] || ('设备警告：' + w)).join('；');
        proto.degraded.push('DeviceWarning:' + parsed.warnings.join(','));
      }

      // REBOOTING：soft_reset 并观察启动横幅（§5.6 "运行" 判据）
      emit({ phase: 'REBOOTING', detail: '软复位设备，等待启动横幅' });
      let banner = null;
      try {
        banner = await proto.exitRawAndReboot();
      } catch (e) {
        if (e.code === 'Cancelled') throw e;
        if (e.code === 'DeviceGone') {
          // 原生 USB（S2/S3 CDC）soft_reset 会重枚举断开端口：写入已校验，降级为成功
          proto.degraded.push('BootNotObserved:port-renegotiated');
          emit({ phase: 'DONE', detail: '已写入并校验；设备复位后 USB 重枚举，请重新连接' });
          return {
            ok: true, target: opts.target, dir, filename, bytes: sourceBytes.length,
            crc32: expectCrc, ms: Date.now() - startedAt, mode: cap.mode,
            banner: null, degraded: proto.degraded,
            note: '文件已写入并通过 CRC 校验；设备复位后端口重枚举，未观察到启动横幅，请重新连接串口'
              + (warnNote ? '；' + warnNote : ''),
          };
        }
        // 端口活着但 8s 无横幅：文件已在设备侧 CRC 校验通过，仅"启动确认"缺失。
        // - 容器注入：设备可能由厂商固件系统静默引导（横幅非标准），降级为成功并提示观察
        // - 启动器刷入：理应出现 BOOT: 横幅，没出现说明未生效，仍按失败处理
        proto.degraded.push('BootNotObserved:timeout');
        if (opts.target.kind === 'container') {
          emit({ phase: 'DONE', detail: '已写入并校验；未检测到标准启动横幅' });
          return {
            ok: true, target: opts.target, dir, filename, bytes: sourceBytes.length,
            crc32: expectCrc, ms: Date.now() - startedAt, mode: cap.mode,
            banner: null, degraded: proto.degraded,
            note: '文件已写入并通过 CRC 校验；' + (T_BANNER / 1000) + 's 内未检测到标准启动横幅，请观察设备是否已运行新程序，必要时手动复位'
              + (warnNote ? '；' + warnNote : ''),
          };
        }
        return fail('BootNotObserved', {
          message: '文件已写入并通过 CRC 校验，但 ' + (T_BANNER / 1000) + 's 内未检测到启动横幅',
          extraFields: { dir, filename, bytes: sourceBytes.length, crc32: expectCrc, mode: cap.mode },
        }, link, startedAt);
      }

      // 横幅分类：launcher = BOOT:*（容器启动器在跑）；repl = 仅 MicroPython 横幅。
      // 设备自带厂商固件系统时，复位后由厂商固件自行引导容器程序，
      // 看不到 BOOT: 属正常，只记降级项不判失败（文件已通过设备侧 CRC 校验）。
      if (banner.kind !== 'launcher') {
        proto.degraded.push('NoLauncherBanner');
      }

      emit({ phase: 'DONE', detail: banner.kind === 'launcher' ? '设备已按启动器运行' : '设备已复位' });
      return {
        ok: true, target: opts.target, dir, filename, bytes: sourceBytes.length,
        crc32: expectCrc, ms: Date.now() - startedAt, mode: cap.mode,
        banner: banner.text.slice(-200), degraded: proto.degraded,
        note: warnNote,
      };
    } catch (e) {
      const code = e.code || (e.name === 'AbortError' ? 'Cancelled' : 'PortError');
      // 尽力恢复：先 Ctrl-C×2 取消可能停留的传统 paste 模式（paste 中 Ctrl-B 只是内容），
      // 再退出 raw REPL 并复位，让旧程序继续跑（旧文件从未被破坏）
      try {
        await link.write(new Uint8Array([CTRL_C, CTRL_C]));
        await link.write(new Uint8Array([CTRL_B]));
        await link.write('import machine; machine.soft_reset()\r\n');
      } catch (e2) { /* 端口已死则放弃 */ }
      return fail(code, { message: e.message }, link, startedAt);
    } finally {
      await link.release();
    }
  }

  window.FirmwareUploader = {
    inject,
    crc32,
    crc32hex,
    // 供测试/诊断
    _internal: { buildDeviceScript, utf8ToBase64, SerialLink, MicroPyProtocol },
  };
})();

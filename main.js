// ===== ESP32 Serial Monitor (Single Controller Support) =====

// Nordic UART Service（与常见 ESP32 BLE 固件一致，可按需改 UUID）
const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Central 写入 → 设备接收
const NUS_TX_CHAR_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 设备 Notify → 浏览器接收

const HARDWARE_RESTORE_KEY = 'xhan-hardware-last-connection';

// 单控制器连接状态：同一控制器可选择 USB 串口或 BLE 二选一连接。
const serialPorts = {
  port1: {
    port: null,
    reader: null,
    writer: null,
    isConnected: false,
    readableStreamClosed: null,
    label: '控制器',
    transport: null,
    bluetoothDevice: null,
    gattServer: null,
    nusRxChar: null,
    nusTxChar: null,
    bleNotifyHandler: null,
    bleLineBuffer: '',
    bleTextDecoder: null,
    gattDisconnectHandler: null,
  },
};

// 向后兼容：保留全局 isConnected（控制器连接即为 true）
let isConnected = false;

// ===== 串口调试缓冲区（全局可见） =====
window._serialDebug = {
  port1: { lastRaw: '', lastParsed: '', lastTime: 0, eventCount: 0 },
  // 事件追踪日志（最近 N 条事件的完整流转记录）
  eventLog: [],
  maxLogSize: 20,
};
// 添加一条追踪日志
function _dbgLog(msg) {
  const log = window._serialDebug.eventLog;
  log.push({ t: Date.now(), msg });
  if (log.length > window._serialDebug.maxLogSize) log.shift();
  // console.log('[SerialTrace]', msg);
}

let autoScroll = true;
let lineCount = 0;

// DOM Elements
const terminal = document.getElementById('terminal');
const connectBtn1 = document.getElementById('connectBtn1');
const bleConnectBtn1 = document.getElementById('bleConnectBtn1');
const statusDot1 = document.getElementById('statusDot1');
const statusText1 = document.getElementById('statusText1');
const portInfo1El = document.getElementById('portInfo1');
const lineCountEl = document.getElementById('lineCount');
const autoScrollBtn = document.getElementById('autoScrollBtn');
const sendInput = document.getElementById('sendInput');
const sendBtn = document.getElementById('sendBtn');
const baudRateSelect = document.getElementById('baudRate');
const browserNotice = document.getElementById('browserNotice');
const bluetoothNotice = document.getElementById('bluetoothNotice');
const iframeNotice = document.getElementById('iframeNotice');
const sendTargetSelect = document.getElementById('sendTarget');
const bleFilterBar = document.getElementById('bleFilterBar');
const bleFilterType = document.getElementById('bleFilterType');
const bleFilterValue = document.getElementById('bleFilterValue');

/**
 * 构造 requestDevice 参数。
 * 注意：很多 ESP 固件不会在 BLE 广播里声明 NUS UUID，此时 filters.services 会在扫描阶段 0 个设备，需用 acceptAllDevices 或仅 namePrefix。
 * 连接成功后仍会 getPrimaryService(NUS) 校验协议。
 */
function buildBleRequestDeviceOptions() {
  const optionalServices = [NUS_SERVICE_UUID];
  const type = (bleFilterType && bleFilterType.value) || 'all';
  const raw = (bleFilterValue && bleFilterValue.value) ? bleFilterValue.value.trim() : '';

  if (type === 'all') {
    return { acceptAllDevices: true, optionalServices };
  }
  if (type === 'nus') {
    return { filters: [{ services: [NUS_SERVICE_UUID] }], optionalServices };
  }
  if (type === 'namePrefixNoSvc') {
    if (!raw) return null;
    return { filters: [{ namePrefix: raw }], optionalServices };
  }
  if (type === 'ybc') {
    return {
      filters: [
        { services: [NUS_SERVICE_UUID], namePrefix: 'ybc' },
        { services: [NUS_SERVICE_UUID], namePrefix: 'YBC' },
      ],
      optionalServices,
    };
  }
  if (type === 'namePrefix') {
    if (!raw) {
      return { filters: [{ services: [NUS_SERVICE_UUID] }], optionalServices };
    }
    return { filters: [{ services: [NUS_SERVICE_UUID], namePrefix: raw }], optionalServices };
  }
  if (type === 'exactName') {
    if (!raw) return null;
    return { filters: [{ services: [NUS_SERVICE_UUID], name: raw }], optionalServices };
  }
  return { acceptAllDevices: true, optionalServices };
}

function syncBleFilterInputs() {
  if (!bleFilterType || !bleFilterValue) return;
  const t = bleFilterType.value;
  const need = t === 'namePrefix' || t === 'exactName' || t === 'namePrefixNoSvc';
  bleFilterValue.disabled = !need;
  bleFilterValue.classList.toggle('is-disabled', !need);
  if (t === 'exactName') {
    bleFilterValue.placeholder = '完整蓝牙显示名称';
  } else if (t === 'namePrefix' || t === 'namePrefixNoSvc') {
    bleFilterValue.placeholder = t === 'namePrefixNoSvc' ? '设备名前缀，如 ESP、UART' : '名称前缀 + 须广播 NUS';
  } else {
    bleFilterValue.placeholder = '输入前缀或完整设备名';
  }
}

function initBleFilterControls() {
  if (!bleFilterType || !bleFilterValue) return;
  const bleSecureWarn = document.getElementById('bleSecureWarn');
  if (bleSecureWarn && window.location.protocol === 'file:') {
    bleSecureWarn.style.display = 'block';
    bleSecureWarn.textContent =
      '检测到 file:// 打开：建议运行 pnpm dev，用 http://localhost 访问，蓝牙/串口在本地页面更稳定。';
  }
  try {
    const st = localStorage.getItem('ble-filter-type');
    const sv = localStorage.getItem('ble-filter-value');
    if (st) bleFilterType.value = st;
    if (sv !== null) bleFilterValue.value = sv;
  } catch (e) { /* ignore */ }
  syncBleFilterInputs();
  bleFilterType.addEventListener('change', () => {
    syncBleFilterInputs();
    try {
      localStorage.setItem('ble-filter-type', bleFilterType.value);
    } catch (e) { /* ignore */ }
  });
  bleFilterValue.addEventListener('input', () => {
    try {
      localStorage.setItem('ble-filter-value', bleFilterValue.value);
    } catch (e) { /* ignore */ }
  });
}

// ===== 环境检测 =====
const isInIframe = window.self !== window.top;

function checkEnvironment() {
  const serialOk = 'serial' in navigator;
  const bleOk = 'bluetooth' in navigator;

  // 检查是否在 iframe 中
  if (isInIframe) {
    iframeNotice.style.display = 'flex';
    if (connectBtn1) connectBtn1.disabled = true;
    if (bleConnectBtn1) bleConnectBtn1.disabled = true;
    if (bleFilterBar) bleFilterBar.style.display = 'none';
    sendInput.disabled = true;
    sendBtn.disabled = true;
    return false;
  }

  if (!serialOk) {
    browserNotice.style.display = 'flex';
    if (connectBtn1) connectBtn1.disabled = true;
  }
  if (!bleOk) {
    if (bluetoothNotice) bluetoothNotice.style.display = 'flex';
    if (bleConnectBtn1) bleConnectBtn1.disabled = true;
    if (bleFilterBar) bleFilterBar.style.display = 'none';
  } else if (bleFilterBar) {
    bleFilterBar.style.display = '';
  }

  return serialOk || bleOk;
}

// 在新窗口中打开当前页面
function openInNewWindow() {
  // 获取当前页面的完整 URL
  const currentUrl = window.location.href;
  window.open(currentUrl, '_blank', 'noopener,noreferrer');
}

// 执行环境检测
const envReady = checkEnvironment();
initBleFilterControls();
restoreHardwareConnection();

// ===== 连接/断开（单控制器支持） =====
function updateGlobalConnected() {
  isConnected = serialPorts.port1.isConnected;
  // 更新发送栏
  sendInput.disabled = !isConnected;
  sendBtn.disabled = !isConnected;
}

function rememberHardwareConnection(data) {
  try {
    localStorage.setItem(HARDWARE_RESTORE_KEY, JSON.stringify({
      ...data,
      savedAt: Date.now(),
    }));
  } catch (e) { /* ignore */ }
}

function getRememberedHardwareConnection() {
  try {
    const raw = localStorage.getItem(HARDWARE_RESTORE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function clearRememberedHardwareConnection() {
  try {
    localStorage.removeItem(HARDWARE_RESTORE_KEY);
  } catch (e) { /* ignore */ }
}

function describeSerialPort(port) {
  if (!port || typeof port.getInfo !== 'function') return '';
  const info = port.getInfo();
  if (info.usbVendorId) {
    return ` USB VID:${info.usbVendorId.toString(16).toUpperCase()} PID:${info.usbProductId?.toString(16).toUpperCase() || '----'}`;
  }
  return '';
}

function rememberSerialConnection(baudRate) {
  rememberHardwareConnection({
    transport: 'serial',
    baudRate,
  });
}

function rememberBleConnection(device) {
  rememberHardwareConnection({
    transport: 'ble',
    deviceId: device && device.id ? device.id : '',
    deviceName: device && device.name ? device.name : '',
  });
}

async function attachSerialPort(portId, port, baudRate, options = {}) {
  const sp = serialPorts[portId];
  sp.port = port;
  sp.baudRate = baudRate;
  await sp.port.open({ baudRate });
  sp.transport = 'serial';
  sp.isConnected = true;

  const portDesc = describeSerialPort(sp.port);
  updateGlobalConnected();
  updatePortUI(portId, portDesc);
  appendLine('system', `[${sp.label}] 已连接（USB）— 波特率: ${baudRate}${portDesc}`, true);
  if (!options.restored) {
    appendLine('system', getPlatformHint(), true);
  }
  rememberSerialConnection(baudRate);
  readLoopForPort(portId);
}

async function restoreSerialConnection(portId, saved) {
  if (!('serial' in navigator) || typeof navigator.serial.getPorts !== 'function') return false;
  const ports = await navigator.serial.getPorts();
  if (!ports.length) return false;

  const baudRate = parseInt(saved && saved.baudRate, 10) || parseInt(baudRateSelect.value, 10);
  await attachSerialPort(portId, ports[0], baudRate, { restored: true });
  appendLine('system', `[${serialPorts[portId].label}] 已自动恢复 USB 连接`, true);
  return true;
}

async function restoreBleConnection(portId, saved) {
  if (!('bluetooth' in navigator) || typeof navigator.bluetooth.getDevices !== 'function') return false;
  const devices = await navigator.bluetooth.getDevices();
  if (!devices.length) return false;

  const device = devices.find(item => saved && saved.deviceId && item.id === saved.deviceId) || devices[0];
  await attachBleDevice(portId, device, { restored: true });
  appendLine('system', `[${serialPorts[portId].label}] 已自动恢复蓝牙连接`, true);
  return true;
}

async function restoreHardwareConnection() {
  if (!envReady) return;
  const saved = getRememberedHardwareConnection();
  if (!saved || serialPorts.port1.isConnected) return;

  try {
    if (saved.transport === 'serial') {
      await restoreSerialConnection('port1', saved);
    } else if (saved.transport === 'ble') {
      await restoreBleConnection('port1', saved);
    }
  } catch (err) {
    console.warn('Hardware restore failed:', err);
    appendLine('system', '上次硬件连接未能自动恢复，请手动连接一次。', true);
  }
}

async function toggleConnection(portId) {
  const sp = serialPorts[portId];
  if (sp.isConnected) {
    await disconnectPort(portId);
  } else {
    await connectPort(portId);
  }
}

async function connectPort(portId) {
  const sp = serialPorts[portId];
  try {
    if (sp.isConnected && sp.transport === 'ble') {
      await disconnectBle(portId, true);
    }

    const port = await navigator.serial.requestPort();
    const baudRate = parseInt(baudRateSelect.value, 10);
    await attachSerialPort(portId, port, baudRate);
  } catch (err) {
    if (err.name === 'NotFoundError') return;
    appendLine('error', `[${sp.label}] 连接失败: ${err.message}`, true);
    console.error(`Serial connect error (${portId}):`, err);
  }
}

async function disconnectPort(portId, silentLog) {
  const sp = serialPorts[portId];
  if (sp.transport !== 'serial') return;
  try {
    sp.isConnected = false;

    if (sp.reader) {
      await sp.reader.cancel();
    }
    if (sp.readableStreamClosed) {
      await sp.readableStreamClosed.catch(() => {});
      sp.readableStreamClosed = null;
    }
    if (sp.port) {
      await sp.port.close();
      sp.port = null;
    }
    sp.reader = null;
    sp.transport = null;
    updateGlobalConnected();
    updatePortUI(portId);
    if (!silentLog) {
      clearRememberedHardwareConnection();
      appendLine('system', `[${sp.label}] USB 已断开`, true);
    }
  } catch (err) {
    sp.reader = null;
    sp.readableStreamClosed = null;
    sp.port = null;
    sp.transport = null;
    updateGlobalConnected();
    updatePortUI(portId);
    appendLine('error', `[${sp.label}] 断开失败: ${err.message}`, true);
    console.error(`Serial disconnect error (${portId}):`, err);
  }
}

function normalizeIncomingTextLine(line) {
  // BLE NUS 有些固件会在文本包尾部带 NUL 或其它不可见控制字符。
  return String(line || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
}

function normalizeSingleControllerSource(source) {
  // 当前框架只保留一个控制器；旧协议里的 P1/P2 前缀统一收敛为同一输入源。
  return 'port1';
}

function dispatchIncomingLine(line, portId) {
  const trimmed = normalizeIncomingTextLine(line);
  if (trimmed.length > 0) {
    handleSerialData(trimmed, portId);
    if (_serialPanelVisible && _serialOutputEnabled) {
      const upper = trimmed.toUpperCase();
      const isHighFreq = upper.includes('RAW_JOY:') || upper.includes('DEGREE:') || upper.includes('MOTOR:') || upper.includes('GYRO:') || upper.includes('ANGLE|');
      if (!isHighFreq) {
        appendLine('received', `[控制器] ${trimmed}`);
      }
    }
  }
}

/** 将文本块按行拆分并交给 handleSerialData / 终端（与 USB 读流、BLE notify 共用） */
function processIncomingTextChunk(buffer, chunk, portId, options = {}) {
  const chunkHasLineBreak = /\r|\n/.test(chunk);
  buffer += chunk;
  const lines = buffer.split(/\r?\n|\r/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    dispatchIncomingLine(line, portId);
  }

  // 一些 BLE NUS 固件每个 notify 就是一条协议消息，不额外附带 \n。
  // USB 串口仍保留按行解析，避免半包数据被提前消费。
  if (options.flushChunkWithoutLineBreak && !chunkHasLineBreak && lines.length === 1 && buffer.trim()) {
    dispatchIncomingLine(buffer, portId);
    buffer = '';
  }
  return buffer;
}

// ===== 数据读取（按端口，USB） =====
async function readLoopForPort(portId) {
  const sp = serialPorts[portId];
  const decoder = new TextDecoderStream();
  sp.readableStreamClosed = sp.port.readable.pipeTo(decoder.writable);
  sp.reader = decoder.readable.getReader();

  let buffer = '';
  sp.lastDataAt = Date.now();

  try {
    while (true) {
      const { value, done } = await sp.reader.read();
      if (done) break;

      sp.lastDataAt = Date.now();
      // 单条消息的解析异常绝不能终止读取循环：一旦退出读取，
      // 硬件端 50Hz 的输出会塞满 USB 缓冲并阻塞其主循环（表现为硬件“卡死”）。
      try {
        buffer = processIncomingTextChunk(buffer, value, portId);
      } catch (err) {
        console.error(`Serial data handler error (${portId}):`, err);
      }
    }
  } catch (err) {
    if (sp.transport === 'serial' && sp.isConnected) {
      appendLine('error', `[${sp.label}] 读取错误: ${err.message}`, true);
    }
  } finally {
    if (sp.reader) {
      sp.reader.releaseLock();
      sp.reader = null;
    }
    // 读循环退出且并非用户主动断开时，清理“假连接”状态并自愈；
    // 否则界面仍显示已连接、游戏继续发指令，硬件端输出无人接收会被堵死。
    if (sp.transport === 'serial' && sp.isConnected) {
      await forceSerialRecovery(portId, 'read-loop-exited');
    }
  }
}

/** 读循环意外退出 / 看门狗超时后的自愈：清理状态并尝试重开同一串口。
 *  重新 open 会重建底层流，通常可解除固件 stdout 被阻塞的状态。 */
async function forceSerialRecovery(portId, reason) {
  const sp = serialPorts[portId];
  if (sp.transport !== 'serial') return;
  appendLine('error', `[${sp.label}] 连接异常（${reason}），正在尝试恢复…`, true);
  sp.isConnected = false;
  try {
    if (sp.reader) {
      try { await sp.reader.cancel(); } catch (_) {}
      sp.reader = null;
    }
    if (sp.readableStreamClosed) {
      await sp.readableStreamClosed.catch(() => {});
      sp.readableStreamClosed = null;
    }
    if (sp.port) {
      try { await sp.port.close(); } catch (_) {}
      try {
        const baudRate = sp.baudRate || parseInt(baudRateSelect.value, 10) || 115200;
        await sp.port.open({ baudRate });
        sp.transport = 'serial';
        sp.isConnected = true;
        updateGlobalConnected();
        updatePortUI(portId, describeSerialPort(sp.port));
        appendLine('system', `[${sp.label}] 已恢复 USB 连接`, true);
        readLoopForPort(portId);
        return;
      } catch (err) {
        console.error(`Serial recovery error (${portId}):`, err);
      }
    }
  } catch (err) {
    console.error(`Serial recovery error (${portId}):`, err);
  }
  sp.readableStreamClosed = null;
  sp.port = null;
  sp.transport = null;
  sp.isConnected = false;
  updateGlobalConnected();
  updatePortUI(portId);
  appendLine('error', `[${sp.label}] 自动恢复失败，请手动重新连接`, true);
}

// ===== 硬件数据流看门狗 =====
// 硬件端正常以 50Hz 上报 ANGLE|；若已连接但连续数秒无任何数据，
// 说明硬件端输出被阻塞（USB 缓冲塞满、电机总线挂起）或读取流僵死。
// 先告警，再主动重置串口连接以解除阻塞。
const SERIAL_STALL_WARN_MS = 3000;
const SERIAL_STALL_RECOVER_MS = 6000;
let _serialStallWarned = false;

setInterval(() => {
  const sp = serialPorts.port1;
  if (!sp || sp.transport !== 'serial' || !sp.isConnected) {
    _serialStallWarned = false;
    return;
  }
  const silent = Date.now() - (sp.lastDataAt || 0);
  if (silent < SERIAL_STALL_WARN_MS) {
    _serialStallWarned = false;
    return;
  }
  if (!_serialStallWarned) {
    _serialStallWarned = true;
    appendLine('error', `[${sp.label}] 已 ${Math.round(silent / 1000)} 秒未收到硬件数据，硬件端可能已阻塞`, true);
  }
  if (silent >= SERIAL_STALL_RECOVER_MS) {
    sp.lastDataAt = Date.now(); // 防止恢复期间重复触发
    forceSerialRecovery('port1', 'data-stall');
  }
}, 1000);

/** USB 或 BLE 统一写出（供终端与游戏内指令） */
async function writeToPort(portId, text) {
  const sp = serialPorts[portId];
  if (!sp.isConnected) throw new Error('未连接');
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  if (sp.transport === 'serial') {
    if (!sp.port || !sp.port.writable) throw new Error('串口不可写');
    const writable = sp.port.writable.getWriter();
    await writable.write(data);
    writable.releaseLock();
  } else if (sp.transport === 'ble') {
    if (!sp.nusRxChar) throw new Error('蓝牙特征未就绪');
    await sp.nusRxChar.writeValue(data);
  } else {
    throw new Error('未知传输方式');
  }
}

async function connectBlePort(portId) {
  const sp = serialPorts[portId];
  if (!('bluetooth' in navigator)) {
    appendLine('error', '当前浏览器不支持 Web Bluetooth', true);
    return;
  }
  try {
    if (sp.isConnected && sp.transport === 'serial') {
      await disconnectPort(portId, true);
    }

    const requestOpts = buildBleRequestDeviceOptions();
    if (!requestOpts) {
      const t = bleFilterType && bleFilterType.value;
      let hint = '请检查蓝牙筛选条件。';
      if (t === 'exactName') hint = '选择「精确名称 + NUS」时请在右侧填写完整蓝牙名称。';
      else if (t === 'namePrefixNoSvc') hint = '选择「仅名称前缀」时请在右侧填写名称前缀以缩小列表。';
      appendLine('error', hint, true);
      return;
    }
    const device = await navigator.bluetooth.requestDevice(requestOpts);

    await attachBleDevice(portId, device);
  } catch (err) {
    if (err.name === 'NotFoundError') return;
    appendLine('error', `[${sp.label}] 蓝牙连接失败: ${err.message}`, true);
    console.error(`BLE connect error (${portId}):`, err);
    await cleanupFailedBleConnection(portId);
  }
}

async function attachBleDevice(portId, device, options = {}) {
  const sp = serialPorts[portId];
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(NUS_SERVICE_UUID);
  const rxChar = await service.getCharacteristic(NUS_RX_CHAR_UUID);
  const txChar = await service.getCharacteristic(NUS_TX_CHAR_UUID);

  sp.bluetoothDevice = device;
  sp.gattServer = server;
  sp.nusRxChar = rxChar;
  sp.nusTxChar = txChar;
  sp.bleLineBuffer = '';
  sp.bleTextDecoder = new TextDecoder();

  const onNotify = (event) => {
    const value = event.target.value;
    if (!value) return;
    const chunk = sp.bleTextDecoder.decode(value, { stream: true });
    sp.bleLineBuffer = processIncomingTextChunk(sp.bleLineBuffer, chunk, portId, {
      flushChunkWithoutLineBreak: true,
    });
  };
  sp.bleNotifyHandler = onNotify;
  txChar.addEventListener('characteristicvaluechanged', onNotify);

  const onGattDisconnected = () => {
    const cur = serialPorts[portId];
    if (cur.transport === 'ble') {
      disconnectBle(portId, true, true).then(() => {
        appendLine('system', `[${serialPorts[portId].label}] 蓝牙连接已丢失`, true);
      });
    }
  };
  sp.gattDisconnectHandler = onGattDisconnected;
  device.addEventListener('gattserverdisconnected', onGattDisconnected);

  await txChar.startNotifications();

  sp.transport = 'ble';
  sp.isConnected = true;

  const name = device.name || 'BLE 设备';
  const portDesc = `BLE · ${name}`;
  updateGlobalConnected();
  updatePortUI(portId, portDesc);
  appendLine('system', `[${sp.label}] 已连接（蓝牙）— ${portDesc}`, true);
  rememberBleConnection(device);
}

/** 连接中途失败或需强制释放 GATT（transport 可能尚未设为 ble） */
async function cleanupFailedBleConnection(portId) {
  const sp = serialPorts[portId];
  try {
    if (sp.nusTxChar && sp.bleNotifyHandler) {
      sp.nusTxChar.removeEventListener('characteristicvaluechanged', sp.bleNotifyHandler);
      await sp.nusTxChar.stopNotifications().catch(() => {});
    }
    if (sp.bluetoothDevice && sp.gattDisconnectHandler) {
      sp.bluetoothDevice.removeEventListener('gattserverdisconnected', sp.gattDisconnectHandler);
    }
    if (sp.bluetoothDevice && sp.bluetoothDevice.gatt.connected) {
      await sp.bluetoothDevice.gatt.disconnect();
    }
  } catch (e) {
    console.error(`BLE cleanup (${portId}):`, e);
  } finally {
    sp.bleNotifyHandler = null;
    sp.nusTxChar = null;
    sp.nusRxChar = null;
    sp.gattServer = null;
    sp.bluetoothDevice = null;
    sp.bleLineBuffer = '';
    sp.bleTextDecoder = null;
    sp.gattDisconnectHandler = null;
    sp.transport = null;
    sp.isConnected = false;
    updateGlobalConnected();
    updatePortUI(portId);
  }
}

/** @param silentLog 为 true 时不输出系统提示（内部清理用） @param skipDisconnect 仅清理状态不调用 gatt.disconnect */
async function disconnectBle(portId, silentLog, skipGattDisconnect) {
  const sp = serialPorts[portId];
  if (sp.transport !== 'ble') return;
  sp.isConnected = false;
  try {
    if (sp.nusTxChar && sp.bleNotifyHandler) {
      sp.nusTxChar.removeEventListener('characteristicvaluechanged', sp.bleNotifyHandler);
      await sp.nusTxChar.stopNotifications().catch(() => {});
    }
    if (!skipGattDisconnect && sp.bluetoothDevice && sp.bluetoothDevice.gatt.connected) {
      await sp.bluetoothDevice.gatt.disconnect();
    }
  } catch (e) {
    console.error(`BLE disconnect (${portId}):`, e);
  } finally {
    if (sp.bluetoothDevice && sp.gattDisconnectHandler) {
      sp.bluetoothDevice.removeEventListener('gattserverdisconnected', sp.gattDisconnectHandler);
    }
    try {
      if (sp.bleTextDecoder) sp.bleTextDecoder.decode();
    } catch (e2) { /* ignore flush */ }
    sp.bleNotifyHandler = null;
    sp.nusTxChar = null;
    sp.nusRxChar = null;
    sp.gattServer = null;
    sp.bluetoothDevice = null;
    sp.bleLineBuffer = '';
    sp.bleTextDecoder = null;
    sp.gattDisconnectHandler = null;
    sp.transport = null;
    sp.reader = null;
    sp.readableStreamClosed = null;
    updateGlobalConnected();
    updatePortUI(portId);
    if (!silentLog) {
      clearRememberedHardwareConnection();
      appendLine('system', `[${sp.label}] 蓝牙已断开`, true);
    }
  }
}

async function toggleBleConnection(portId) {
  const sp = serialPorts[portId];
  if (sp.isConnected && sp.transport === 'ble') {
    await disconnectBle(portId);
  } else {
    await connectBlePort(portId);
  }
}

// ===== 发送数据 =====
async function sendData() {
  const text = sendInput.value.trim();
  if (!text || !isConnected) return;

  // 确定发送目标
  const target = sendTargetSelect ? sendTargetSelect.value : 'port1';
  let targetPorts = [];
  if (target === 'all') {
    targetPorts = ['port1'].filter(id => serialPorts[id].isConnected);
  } else {
    if (serialPorts[target] && serialPorts[target].isConnected) {
      targetPorts = [target];
    }
  }

  if (targetPorts.length === 0) {
    appendLine('error', '目标端口未连接', true);
    return;
  }

  try {
    const newline = document.getElementById('sendNewline').checked ? '\r\n' : '';
    const payload = text + newline;
    for (const portId of targetPorts) {
      await writeToPort(portId, payload);
    }
    const targetLabel = serialPorts[target]?.label || '控制器';
    appendLine('sent', `[→${targetLabel}] ${text}`, true);
    sendInput.value = '';
    sendInput.focus();
  } catch (err) {
    appendLine('error', `发送失败: ${err.message}`, true);
    console.error('Send error:', err);
  }
}

// ===== 终端操作（批量 DOM 更新，避免逐条强制回流）=====
let _appendBuffer = [];
let _appendScheduled = false;
let _welcomeRemoved = false;
const MAX_LINES = 500; // 🔴 大幅降低上限，500 行 = 1500 DOM 节点（已足够查看）
let _serialPanelVisible = true; // 面板是否可见（不可见时跳过所有 DOM 操作）
let _serialOutputEnabled = false; // 🔴 串口终端输出开关：默认关闭，测试时手动打开
let _lastFlushTime = 0;         // 上次 flush 时间戳
const _FLUSH_INTERVAL = 200;    // 至少 200ms flush 一次（5fps 对终端足够了）

function appendLine(type, text, force) {
  // 🔴 核心优化：面板隐藏时彻底跳过
  if (!_serialPanelVisible) return;
  // 输出关闭时：只允许 force=true（用户发送/错误/系统消息）通过
  if (!_serialOutputEnabled && !force) return;

  _appendBuffer.push({ type, text, ts: Date.now() });

  // 限制缓冲区大小（防止短时间内大量消息堆积）
  if (_appendBuffer.length > 100) {
    _appendBuffer = _appendBuffer.slice(-30);
  }

  if (!_appendScheduled) {
    _appendScheduled = true;
    // 使用 setTimeout 而非 rAF，降低 flush 频率，不与游戏帧竞争
    const elapsed = Date.now() - _lastFlushTime;
    const delay = Math.max(0, _FLUSH_INTERVAL - elapsed);
    setTimeout(_flushAppendBuffer, delay);
  }
}

function _flushAppendBuffer() {
  _appendScheduled = false;
  _lastFlushTime = Date.now();
  if (_appendBuffer.length === 0) return;

  // 面板不可见时直接丢弃
  if (!_serialPanelVisible) {
    _appendBuffer.length = 0;
    return;
  }

  // 只保留最近的条目
  if (_appendBuffer.length > 30) {
    _appendBuffer = _appendBuffer.slice(-30);
  }

  // 首次清除欢迎消息
  if (!_welcomeRemoved) {
    const welcome = terminal.querySelector('.welcome-msg');
    if (welcome) { welcome.remove(); }
    _welcomeRemoved = true;
  }

  // 使用 DocumentFragment 批量插入，只触发一次回流
  const frag = document.createDocumentFragment();
  const prefixMap = { sent: '← ', received: '→ ', system: '⚙ ', error: '✖ ' };

  for (const item of _appendBuffer) {
    const line = document.createElement('div');
    line.className = `line ${item.type}`;

    const time = document.createElement('span');
    time.className = 'time';
    const d = new Date(item.ts);
    const h = d.getHours(), m = d.getMinutes(), s = d.getSeconds(), ms = d.getMilliseconds();
    time.textContent = (h < 10 ? '0' : '') + h + ':' +
                       (m < 10 ? '0' : '') + m + ':' +
                       (s < 10 ? '0' : '') + s + '.' +
                       (ms < 100 ? (ms < 10 ? '00' : '0') : '') + ms;

    const data = document.createElement('span');
    data.className = 'data';
    data.textContent = (prefixMap[item.type] || '') + item.text;

    line.appendChild(time);
    line.appendChild(data);
    frag.appendChild(line);
  }

  terminal.appendChild(frag);
  lineCount += _appendBuffer.length;
  _appendBuffer.length = 0;

  // 🔴 优化：批量删除超出上限的节点（用 range 一次性删除，不逐个 removeChild）
  const overflow = terminal.children.length - MAX_LINES;
  if (overflow > 0) {
    const range = document.createRange();
    range.setStartBefore(terminal.firstChild);
    range.setEndAfter(terminal.children[overflow - 1]);
    range.deleteContents();
    lineCount = terminal.children.length;
  }

  lineCountEl.textContent = lineCount + ' 行';

  // 🔴 优化：只在面板可见且开启自动滚动时才触发布局回流
  if (autoScroll && _serialPanelVisible) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function clearTerminal() {
  terminal.innerHTML = '';
  lineCount = 0;
  lineCountEl.textContent = '0 行';
}

// ===== 串口终端输出开关 =====
function toggleSerialOutput() {
  _serialOutputEnabled = !_serialOutputEnabled;
  const btn = document.getElementById('serialOutputToggle');
  if (btn) {
    btn.classList.toggle('active', _serialOutputEnabled);
    btn.title = _serialOutputEnabled ? '串口输出：开 (点击关闭)' : '串口输出：关 (点击打开)';
  }
  // 关闭时清空缓冲区和终端，释放 DOM 节点
  if (!_serialOutputEnabled) {
    _appendBuffer.length = 0;
    clearTerminal();
    appendLine('system', '串口终端输出已关闭 — 游戏运行更流畅');
    // 上面 appendLine 因为开关关了不会执行，手动加一条提示
    const hint = document.createElement('div');
    hint.className = 'line system';
    hint.innerHTML = '<span class="data">⚙ 串口终端输出已关闭 — 游戏运行更流畅</span>';
    terminal.appendChild(hint);
  } else {
    clearTerminal();
    const hint = document.createElement('div');
    hint.className = 'line system';
    hint.innerHTML = '<span class="data">⚙ 串口终端输出已开启 — 可查看串口数据</span>';
    terminal.appendChild(hint);
  }
  // 保存用户偏好
  localStorage.setItem('serial-output-enabled', _serialOutputEnabled ? '1' : '0');
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  autoScrollBtn.classList.toggle('active', autoScroll);
  if (autoScroll) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

// ===== 平台检测 =====
function detectPlatform() {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('mac')) return 'mac';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'unknown';
}

function getPlatformHint() {
  const platform = detectPlatform();
  switch (platform) {
    case 'mac':
      return '当前系统: macOS — 串口名称通常为 /dev/cu.usbmodem* 或 /dev/cu.SLAB_USBtoUART';
    case 'windows':
      return '当前系统: Windows — 串口名称通常为 COM3、COM4 等';
    case 'linux':
      return '当前系统: Linux — 串口名称通常为 /dev/ttyUSB0 或 /dev/ttyACM0';
    default:
      return '请在弹出的对话框中选择 ESP32 对应的串口设备';
  }
}

// ===== UI 更新（单控制器：USB / 蓝牙 独立按钮状态） =====
function updatePortUI(portId, portDesc) {
  const sp = serialPorts[portId];
  const dot = statusDot1;
  const text = statusText1;
  const btn = connectBtn1;
  const bleBtn = bleConnectBtn1;
  const infoEl = portInfo1El;

  const serialActive = sp.transport === 'serial' && sp.isConnected;
  const bleActive = sp.transport === 'ble' && sp.isConnected;

  if (dot) dot.classList.toggle('connected', sp.isConnected);
  if (text) text.textContent = sp.isConnected ? '已连接' : '未连接';

  if (btn) {
    btn.classList.toggle('connected', serialActive);
    const spanEl = btn.querySelector('span');
    if (spanEl) spanEl.textContent = serialActive ? '断开' : '连接';
  }

  if (bleBtn) {
    bleBtn.classList.toggle('connected', bleActive);
    const spanEl = bleBtn.querySelector('span');
    if (spanEl) spanEl.textContent = bleActive ? '断开' : '蓝牙';
  }

  if (infoEl) {
    if (sp.isConnected && portDesc) {
      infoEl.textContent = portDesc;
      infoEl.classList.add('visible');
    } else if (sp.isConnected && !portDesc) {
      if (serialActive) {
        infoEl.textContent = 'USB 已连接';
        infoEl.classList.add('visible');
      } else if (bleActive) {
        infoEl.textContent = '蓝牙已连接';
        infoEl.classList.add('visible');
      } else {
        infoEl.textContent = '';
        infoEl.classList.remove('visible');
      }
    } else {
      infoEl.textContent = '';
      infoEl.classList.remove('visible');
    }
  }

  baudRateSelect.disabled = serialPorts.port1.isConnected;
}

// 初始化自动滚动按钮状态
if (autoScrollBtn) autoScrollBtn.classList.add('active');

// 监听串口断开事件（单控制器，仅 USB）
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (e) => {
    for (const portId of ['port1']) {
      const sp = serialPorts[portId];
      if (sp.transport === 'serial' && sp.port && e.target === sp.port) {
        sp.isConnected = false;
        sp.reader = null;
        sp.port = null;
        sp.transport = null;
        updateGlobalConnected();
        updatePortUI(portId);
        appendLine('system', `[${sp.label}] USB 设备已断开`, true);
      }
    }
  });
}

// ===== 游戏选择与切换 =====
let currentGame = 'none';
let gameAnimationId = null;
let gameState = {};

const gameCanvas = document.getElementById('gameCanvas');
const gameCtx = gameCanvas ? gameCanvas.getContext('2d') : null;
const gamePlaceholder = document.getElementById('gamePlaceholder');
const gameSelectorBtn = document.getElementById('gameSelectorBtn');
const gameSelectorLabel = document.getElementById('gameSelectorLabel');
const gameMenu = document.getElementById('gameMenu');
const gameSubtitle = document.getElementById('gameSubtitle');
const gameTitle = document.getElementById('gameTitle');

// 游戏信息映射
const gameInfo = {
  none: { name: '选择游戏', subtitle: '选择一个游戏开始体验' },
  pong: { name: '🏓 Pong 弹球', subtitle: '摇晃控制器开始 · 转动电机控制左侧挡板' },
  snake: { name: '🐍 贪吃蛇', subtitle: '摇晃控制器开始 · 前后左右倾斜控制方向' },
  dino: { name: '🦖 恐龙跳跃', subtitle: '摇晃控制器开始 · 转动电机跳跃' },
  jump: { name: '🦘 数字测量尺', subtitle: '摇晃控制器开始 · 转动电机测距跳跃' },
  fishing: { name: '🎣 钓鱼达人', subtitle: '摇晃控制器开始 / 继续 · 单电机 ANGLE| 卷线' },
};

function toggleGameMenu() {
  const isOpen = gameMenu.classList.contains('open');
  if (isOpen) {
    closeGameMenu();
  } else {
    gameMenu.classList.add('open');
    gameSelectorBtn.classList.add('active');
  }
}

function closeGameMenu() {
  gameMenu.classList.remove('open');
  gameSelectorBtn.classList.remove('active');
}

// 点击外部关闭菜单
document.addEventListener('click', (e) => {
  if (!e.target.closest('.game-selector-wrapper')) {
    closeGameMenu();
  }
});

function selectGame(gameId) {
  if (!gameInfo[gameId]) {
    gameId = 'none';
  }

  // 停止当前游戏
  stopCurrentGame();

  currentGame = gameId;

  // 更新选中状态
  document.querySelectorAll('.game-menu-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.game === gameId);
  });

  // 更新按钮文字和标题
  gameSelectorLabel.textContent = gameInfo[gameId].name;
  gameSubtitle.textContent = gameInfo[gameId].subtitle;
  gameTitle.textContent = gameId === 'none' ? '游戏交互' : gameInfo[gameId].name;

  // 切换画面
  const runnerContainer = document.getElementById('runnerContainer');
  if (gameId === 'none') {
    gameCanvas.style.display = 'none';
    if (runnerContainer) runnerContainer.style.display = 'none';
    gamePlaceholder.style.display = 'flex';
  } else if (gameId === 'runner') {
    gamePlaceholder.style.display = 'none';
    gameCanvas.style.display = 'none';
    if (runnerContainer) runnerContainer.style.display = 'block';
    startGame(gameId);
  } else {
    gamePlaceholder.style.display = 'none';
    if (runnerContainer) runnerContainer.style.display = 'none';
    gameCanvas.style.display = 'block';
    startGame(gameId);
  }

  closeGameMenu();

  // 记住选择
  localStorage.setItem('selected-game', gameId);
}

function stopCurrentGame() {
  if (gameAnimationId) {
    cancelAnimationFrame(gameAnimationId);
    gameAnimationId = null;
  }
  // 清除贪吃蛇重启监听器
  if (gameState._snakeRestartHandler) {
    document.removeEventListener('keydown', gameState._snakeRestartHandler);
  }
  // 清除跳一跳/坦克专用监听器
  if (gameState._jumpCleanup) {
    gameState._jumpCleanup();
  }
  // 清除坦克全局引用
  window._tankPlayerShoot = null;
  window._tankStartLevel = null;
  // 清除 Pong 全局引用
  window._pongHandleDirection = null;
  window._pongHandleButton = null;
  window._pongHandleRawJoy = null;
  window._pongHandleShake = null;
  window._pongHandleMotorRawDeg = null;
  // 清除贪吃蛇全局引用
  window._snakeHandleShake = null;
  window._snakeHandleDirection = null;
  // 清除恐龙全局引用
  window._dinoHandleShake = null;
  window._dinoHandleMotorRawDeg = null;
  // 清除跳一跳全局引用
  window._jumpHandleShake = null;
  window._jumpHandleMotorRawDeg = null;
  // 清除钓鱼全局引用
  window._fishingHandleDirection = null;
  window._fishingHandleButton = null;
  window._fishingHandleDegree = null;
  window._fishingHandleRawJoy = null;
  window._fishingHandleFishCast = null;
  window._fishingHandleFishReel = null;
  window._fishingHandleFishShake = null;
  window._fishingHandleMotorRawDeg = null;
  window._fishingHandleGyroShake = null;
  // 清除宝可梦全局引用
  window._pokemonHandleDirection = null;
  window._pokemonHandleButton = null;
  // 清除陀螺仪体感游戏全局引用
  window._gyroHandleGyro = null;
  window._gyroHandleDirection = null;
  window._gyroHandleButton = null;
  window._gyroHandleRawJoy = null;
  // 清除跑酷全局引用
  if (window._runnerCleanup) {
    window._runnerCleanup();
    window._runnerCleanup = null;
  }
  // 隐藏 runner 容器
  const rc = document.getElementById('runnerContainer');
  if (rc) rc.style.display = 'none';
  gameState = {};
  // 移除游戏键盘事件
  document.removeEventListener('keydown', gameKeyHandler);
  document.removeEventListener('keyup', gameKeyUpHandler);
}

function startGame(gameId) {
  // 确保 canvas 尺寸正确
  const rect = gameCanvas.getBoundingClientRect();
  gameCanvas.width = 750;
  gameCanvas.height = 500;

  // 添加键盘监听
  document.addEventListener('keydown', gameKeyHandler);
  document.addEventListener('keyup', gameKeyUpHandler);

  switch (gameId) {
    case 'pong': startPong(); break;
    case 'snake': startSnake(); break;
    case 'dino': startDino(); break;
    case 'jump': startJump(); break;
    case 'fishing': startFishing(); break;
  }
}

// 统一键盘处理
function gameKeyHandler(e) {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'w', 's', 'a', 'd'].includes(e.key)) {
    e.preventDefault();
  }
  gameState.keys = gameState.keys || {};
  gameState.keys[e.key] = true;

  // 恐龙跳跃的 space 特殊处理（键盘保留为无硬件调试入口）
  if (currentGame === 'dino' && e.key === ' ') {
    if (gameState.dino && !gameState.started) {
      gameState.started = true;
      return;
    }
    // 重新开始
    if (gameState.dino && gameState.dino.gameOver) {
      startDino();
      return;
    }
    if (gameState.dino && !gameState.dino.jumping) {
      gameState.dino.vy = -15;
      gameState.dino.jumping = true;
    }
  }
}

function gameKeyUpHandler(e) {
  if (gameState.keys) {
    gameState.keys[e.key] = false;
  }
}

// ========== Pong 弹球 ==========
function startPong() {
  const W = gameCanvas.width, H = gameCanvas.height;
  const paddleH = 80, paddleW = 10, ballR = 8;
  const leftX = 30;
  const rightX = W - 30 - paddleW;
  const paddleSpeed = 7;
  const initialBallSpeed = 3.2;
  const maxBallSpeed = 7.5;
  const bounceAccel = 1.02;
  const motorDegPerScreen = 180;
  const motorFollowLerp = 0.72;

  gameState = {
    keys: gameState.keys || {},
    mode: 'menu', // menu | playing
    matchMode: 'single',
    playerY: H / 2 - paddleH / 2,
    rightY: H / 2 - paddleH / 2,
    ballX: W / 2, ballY: H / 2,
    ballVX: initialBallSpeed, ballVY: 2,
    playerLives: 3,
    aiLives: 3,
    result: null,
    p1SerialMove: 0,
    p2SerialMove: 0,
    p1SerialUntil: 0,
    p2SerialUntil: 0,
    p1MotorAnchorDeg: null,
    p1MotorTargetY: null,
    lastMenuSerialAt: 0,
  };

  window._pongHandleDirection = function(dir, source) {
    const s = gameState;
    if (!s || currentGame !== 'pong') return;

    if (s.mode === 'menu') {
      return;
    }

    const move = dir === 'UP' ? -1 : (dir === 'DOWN' ? 1 : 0);
    if (source === 'port1') {
      s.p1SerialMove = move;
      s.p1SerialUntil = performance.now() + 180;
    } else if (source === 'port2') {
      s.p2SerialMove = move;
      s.p2SerialUntil = performance.now() + 180;
    }
  };

  window._pongHandleRawJoy = function(x, y, source) {
    const s = gameState;
    if (!s || currentGame !== 'pong') return;
    if (s.mode === 'menu') {
      return;
    }
    const move = y < 35 ? -1 : (y > 65 ? 1 : 0);
    if (source === 'port1') {
      s.p1SerialMove = move;
      s.p1SerialUntil = performance.now() + 120;
    } else if (source === 'port2') {
      s.p2SerialMove = move;
      s.p2SerialUntil = performance.now() + 120;
    }
  };

  window._pongHandleButton = function(pressed, source) {
    const s = gameState;
    if (!s || currentGame !== 'pong' || !pressed) return;
    // 开始游戏统一由陀螺仪摇晃触发；按钮保留给后续游戏内动作扩展。
  };

  window._pongHandleShake = function(source) {
    const s = gameState;
    if (!s || currentGame !== 'pong' || source !== 'port1') return;
    if (s.mode === 'menu' || s.mode === 'gameover') startMatch();
  };

  window._pongHandleMotorRawDeg = function(rawDeg, source) {
    const s = gameState;
    if (!s || currentGame !== 'pong' || source !== 'port1' || s.mode !== 'playing') return;
    if (s.p1MotorAnchorDeg === null) {
      s.p1MotorAnchorDeg = rawDeg;
    }
    const relDeg = rawDeg - s.p1MotorAnchorDeg;
    const travel = H - paddleH;
    const centerY = travel / 2;
    s.p1MotorTargetY = Math.max(0, Math.min(travel, centerY + (relDeg / motorDegPerScreen) * travel));
  };

  function startMatch() {
    const s = gameState;
    s.mode = 'playing';
    s.matchMode = 'single';
    s.playerLives = 3;
    s.aiLives = 3;
    s.result = null;
    s.playerY = H / 2 - paddleH / 2;
    s.rightY = H / 2 - paddleH / 2;
    s.p1MotorAnchorDeg = null;
    s.p1MotorTargetY = null;
    if (typeof writeToPort === 'function' && serialPorts.port1 && serialPorts.port1.isConnected) {
      writeToPort('port1', 'RESET\n').catch(() => {});
    }
    resetPongBall(s, W, H, Math.random() > 0.5 ? 1 : -1);
  }

  function update() {
    const s = gameState;
    if (s.mode !== 'playing') {
      if (s.keys['Enter'] || s.keys[' ']) startMatch();
      return;
    }

    const now = performance.now();

    // 左挡板：控制器电机为主控，键盘 / 控制器方向保留为调试输入。
    let p1Move = 0;
    if (s.keys['ArrowUp'] || (s.matchMode === 'single' && s.keys['w'])) p1Move -= 1;
    if (s.keys['ArrowDown'] || (s.matchMode === 'single' && s.keys['s'])) p1Move += 1;
    if (now <= s.p1SerialUntil) p1Move += s.p1SerialMove;
    if (s.p1MotorTargetY !== null) {
      s.playerY += (s.p1MotorTargetY - s.playerY) * motorFollowLerp;
    }
    if (p1Move < 0) s.playerY -= paddleSpeed;
    if (p1Move > 0) s.playerY += paddleSpeed;
    s.playerY = Math.max(0, Math.min(H - paddleH, s.playerY));

    // 单人模式右侧由 AI 控制。
    const aiCenter = s.rightY + paddleH / 2;
    if (aiCenter < s.ballY - 15) s.rightY += 3.2;
    if (aiCenter > s.ballY + 15) s.rightY -= 3.2;
    s.rightY = Math.max(0, Math.min(H - paddleH, s.rightY));

    // 球移动
    s.ballX += s.ballVX;
    s.ballY += s.ballVY;

    // 上下反弹
    if (s.ballY - ballR < 0 || s.ballY + ballR > H) {
      s.ballVY = -s.ballVY;
      s.ballY = s.ballY - ballR < 0 ? ballR : H - ballR;
    }

    // 左挡板碰撞
    if (s.ballX - ballR < leftX + paddleW && s.ballY > s.playerY && s.ballY < s.playerY + paddleH && s.ballVX < 0) {
      s.ballVX = -s.ballVX * bounceAccel;
      s.ballX = leftX + paddleW + ballR;
      const offset = (s.ballY - (s.playerY + paddleH / 2)) / (paddleH / 2);
      s.ballVY = offset * 4.5;
    }

    // 右挡板碰撞
    if (s.ballX + ballR > rightX && s.ballY > s.rightY && s.ballY < s.rightY + paddleH && s.ballVX > 0) {
      s.ballVX = -s.ballVX * bounceAccel;
      s.ballX = rightX - ballR;
      const offset = (s.ballY - (s.rightY + paddleH / 2)) / (paddleH / 2);
      s.ballVY = offset * 4.5;
    }

    // 限速
    s.ballVX = Math.max(-maxBallSpeed, Math.min(maxBallSpeed, s.ballVX));
    s.ballVY = Math.max(-maxBallSpeed, Math.min(maxBallSpeed, s.ballVY));

    // 漏球扣心：玩家守左侧，AI 守右侧。
    if (s.ballX < 0) {
      s.playerLives = Math.max(0, s.playerLives - 1);
      if (s.playerLives <= 0) finishMatch('failure');
      else resetPongBall(s, W, H, 1);
    }
    if (s.ballX > W) {
      s.aiLives = Math.max(0, s.aiLives - 1);
      if (s.aiLives <= 0) finishMatch('victory');
      else resetPongBall(s, W, H, -1);
    }
  }

  function resetPongBall(s, W, H, dir) {
    s.ballX = W / 2; s.ballY = H / 2;
    s.ballVX = (dir || (Math.random() > 0.5 ? 1 : -1)) * initialBallSpeed;
    s.ballVY = (Math.random() - 0.5) * 3.2;
  }

  function finishMatch(result) {
    const s = gameState;
    s.mode = 'gameover';
    s.result = result;
    s.ballX = W / 2;
    s.ballY = H / 2;
    s.ballVX = 0;
    s.ballVY = 0;
  }

  function draw() {
    const s = gameState;
    const ctx = gameCtx;
    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, W, H);

    if (s.mode === 'menu') {
      drawPongMenu(ctx, s);
      return;
    }

    // 中线
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);

    // 挡板
    ctx.fillStyle = '#22d3ee';
    ctx.shadowColor = 'rgba(34,211,238,0.4)';
    ctx.shadowBlur = 12;
    ctx.fillRect(leftX, s.playerY, paddleW, paddleH);

    ctx.fillStyle = '#f87171';
    ctx.shadowColor = 'rgba(248,113,113,0.4)';
    ctx.fillRect(rightX, s.rightY, paddleW, paddleH);
    ctx.shadowBlur = 0;

    // 球
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(255,255,255,0.5)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(s.ballX, s.ballY, ballR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 生命值
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#22d3ee';
    ctx.fillText(`玩家 ${drawHearts(s.playerLives)}`, 22, 34);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f87171';
    ctx.fillText(`AI ${drawHearts(s.aiLives)}`, W - 22, 34);

    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('转动电机控制左侧挡板，右侧为 AI', W / 2, H - 18);

    if (s.mode === 'gameover') {
      drawPongResult(ctx, s);
    }
  }

  function drawHearts(count) {
    return '♥'.repeat(count) + '♡'.repeat(3 - count);
  }

  function drawPongResult(ctx, s) {
    const isVictory = s.result === 'victory';
    ctx.fillStyle = 'rgba(0,0,0,0.68)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = isVictory ? '#34d399' : '#f87171';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isVictory ? '游戏胜利' : '游戏失败', W / 2, H / 2 - 24);
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '18px sans-serif';
    ctx.fillText(`玩家 ${drawHearts(s.playerLives)}   AI ${drawHearts(s.aiLives)}`, W / 2, H / 2 + 18);
    ctx.fillStyle = 'rgba(255,255,255,0.46)';
    ctx.font = '15px sans-serif';
    ctx.fillText('摇晃控制器重新开始', W / 2, H / 2 + 58);
  }

  function drawPongMenu(ctx, s) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 50px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Pong 弹球', W / 2, 120);

    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '16px sans-serif';
    ctx.fillText('摇晃控制器以开始游戏', W / 2, 154);

    const options = [
      { title: '开始游戏', desc: '摇晃开始 · 转动电机控制左侧挡板' },
    ];
    for (let i = 0; i < options.length; i++) {
      const boxW = 360;
      const boxH = 70;
      const x = W / 2 - boxW / 2;
      const y = 250;

      ctx.fillStyle = 'rgba(34,211,238,0.14)';
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x, y, boxW, boxH, 14);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#fff';
      ctx.font = 'bold 22px sans-serif';
      ctx.fillText(options[i].title, W / 2, y + 30);
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      ctx.font = '13px sans-serif';
      ctx.fillText(options[i].desc, W / 2, y + 52);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.38)';
    ctx.font = '14px sans-serif';
    ctx.fillText('摇晃控制器以开始游戏', W / 2, H - 34);
  }

  function loop() {
    update();
    draw();
    gameAnimationId = requestAnimationFrame(loop);
  }
  loop();
}

// ========== 贪吃蛇 ==========
function startSnake() {
  const W = gameCanvas.width, H = gameCanvas.height;
  const CELL = 20;
  const COLS = Math.floor(W / CELL);
  const ROWS = Math.floor(H / CELL);
  const SNAKE_INITIAL_SPEED = 220;
  const SNAKE_MIN_SPEED = 90;
  const SNAKE_SPEED_STEP = 8;
  const EDGE_GRACE_MS = 500;

  const startX = Math.floor(COLS / 2);
  const startY = Math.floor(ROWS / 2);

  gameState = {
    keys: gameState.keys || {},
    snake: [{ x: startX, y: startY }, { x: startX - 1, y: startY }, { x: startX - 2, y: startY }],
    dir: { x: 1, y: 0 },
    nextDir: { x: 1, y: 0 },
    food: null,
    score: 0,
    gameOver: false,
    started: false,
    lastMove: 0,
    speed: SNAKE_INITIAL_SPEED,
    edgeGraceUntil: 0,
    edgeGraceDir: null,
  };

  placeSnakeFood();

  window._snakeHandleShake = function(source) {
    if (currentGame !== 'snake' || source !== 'port1') return;
    if (gameState.gameOver) {
      startSnake();
      return;
    }
    if (!gameState.started) {
      gameState.started = true;
      gameState.lastMove = performance.now();
    }
  };

  window._snakeHandleDirection = function(dir, source) {
    if (currentGame !== 'snake' || source !== 'port1') return;
    const s = gameState;
    if (!s || s.gameOver || !s.started) return;

    const dirMap = {
      UP: { x: 0, y: -1 },
      DOWN: { x: 0, y: 1 },
      LEFT: { x: -1, y: 0 },
      RIGHT: { x: 1, y: 0 },
    };
    const next = dirMap[dir];
    if (!next) return;

    // 禁止直接掉头，避免硬件连续姿态事件造成误触。
    if (s.dir.x + next.x === 0 && s.dir.y + next.y === 0) return;
    s.nextDir = next;
  };

  function placeSnakeFood() {
    const s = gameState;
    let pos;
    do {
      pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
    } while (s.snake.some(seg => seg.x === pos.x && seg.y === pos.y));
    s.food = pos;
  }

  function update(timestamp) {
    const s = gameState;
    if (s.gameOver || !s.started) return;

    // 方向输入
    if ((s.keys['ArrowUp'] || s.keys['w']) && s.dir.y === 0) s.nextDir = { x: 0, y: -1 };
    if ((s.keys['ArrowDown'] || s.keys['s']) && s.dir.y === 0) s.nextDir = { x: 0, y: 1 };
    if ((s.keys['ArrowLeft'] || s.keys['a']) && s.dir.x === 0) s.nextDir = { x: -1, y: 0 };
    if ((s.keys['ArrowRight'] || s.keys['d']) && s.dir.x === 0) s.nextDir = { x: 1, y: 0 };

    if (timestamp - s.lastMove < s.speed) return;
    s.lastMove = timestamp;
    s.dir = { ...s.nextDir };

    const head = { x: s.snake[0].x + s.dir.x, y: s.snake[0].y + s.dir.y };

    // 撞到边缘时先给一个短暂转向窗口，超时仍朝边缘移动才失败。
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
      const edgeDir = `${s.dir.x},${s.dir.y}`;
      if (!s.edgeGraceUntil || s.edgeGraceDir !== edgeDir) {
        s.edgeGraceUntil = timestamp + EDGE_GRACE_MS;
        s.edgeGraceDir = edgeDir;
        return;
      }
      if (timestamp >= s.edgeGraceUntil) {
        s.gameOver = true;
      }
      return;
    }
    s.edgeGraceUntil = 0;
    s.edgeGraceDir = null;

    // 撞自己
    if (s.snake.some(seg => seg.x === head.x && seg.y === head.y)) {
      s.gameOver = true;
      return;
    }

    s.snake.unshift(head);

    // 吃食物
    if (s.food && head.x === s.food.x && head.y === s.food.y) {
      s.score += 10;
      const eatenCount = Math.floor(s.score / 10);
      s.speed = Math.max(SNAKE_MIN_SPEED, SNAKE_INITIAL_SPEED - eatenCount * SNAKE_SPEED_STEP);
      placeSnakeFood();
    } else {
      s.snake.pop();
    }
  }

  function draw() {
    const s = gameState;
    const ctx = gameCtx;
    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, W, H);

    // 网格线
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += CELL) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y <= H; y += CELL) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // 蛇身
    s.snake.forEach((seg, i) => {
      const alpha = 1 - (i / s.snake.length) * 0.6;
      if (i === 0) {
        ctx.fillStyle = '#34d399';
        ctx.shadowColor = 'rgba(52,211,153,0.5)';
        ctx.shadowBlur = 8;
      } else {
        ctx.fillStyle = `rgba(52,211,153,${alpha})`;
        ctx.shadowBlur = 0;
      }
      ctx.fillRect(seg.x * CELL + 1, seg.y * CELL + 1, CELL - 2, CELL - 2);
    });
    ctx.shadowBlur = 0;

    // 食物
    if (s.food) {
      ctx.fillStyle = '#fbbf24';
      ctx.shadowColor = 'rgba(251,191,36,0.5)';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(s.food.x * CELL + CELL / 2, s.food.y * CELL + CELL / 2, CELL / 2 - 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // 分数
    ctx.fillStyle = 'rgba(15,23,42,0.78)';
    ctx.fillRect(12, 12, 116, 34);
    ctx.strokeStyle = 'rgba(52,211,153,0.42)';
    ctx.strokeRect(12, 12, 116, 34);
    ctx.fillStyle = '#e5fff5';
    ctx.font = 'bold 20px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`分数: ${s.score}`, 22, 35);

    const edgeGraceRemaining = s.edgeGraceUntil ? Math.max(0, s.edgeGraceUntil - performance.now()) : 0;
    if (s.started && edgeGraceRemaining > 0) {
      const pulse = 0.45 + 0.25 * Math.sin(performance.now() / 80);
      ctx.strokeStyle = `rgba(251,191,36,${pulse})`;
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, W - 6, H - 6);
      ctx.fillStyle = 'rgba(251,191,36,0.92)';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('快转向！撞到边缘会失败', W / 2, 36);
    }

    if (!s.started) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#34d399';
      ctx.font = 'bold 42px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('贪吃蛇', W / 2, H / 2 - 40);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '20px sans-serif';
      ctx.fillText('摇晃控制器开始游戏', W / 2, H / 2 + 8);
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.font = '14px sans-serif';
      ctx.fillText('开始后前后左右倾斜控制方向；键盘调试：方向键 / WASD', W / 2, H / 2 + 40);
      return;
    }

    // Game Over
    if (s.gameOver) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f87171';
      ctx.font = 'bold 36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GAME OVER', W / 2, H / 2 - 10);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '16px sans-serif';
      ctx.fillText(`最终得分: ${s.score}  |  摇晃控制器 / 按 R 重新开始`, W / 2, H / 2 + 25);
    }
  }

  // R 键重新开始
  const originalKeyHandler = gameKeyHandler;
  const snakeRestartHandler = (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !gameState.started && currentGame === 'snake') {
      e.preventDefault();
      gameState.started = true;
      gameState.lastMove = performance.now();
      return;
    }
    if (e.key === 'r' || e.key === 'R') {
      if (gameState.gameOver && currentGame === 'snake') {
        startSnake();
      }
    }
  };
  document.addEventListener('keydown', snakeRestartHandler);
  gameState._snakeRestartHandler = snakeRestartHandler;

  function loop(timestamp) {
    update(timestamp);
    draw();
    gameAnimationId = requestAnimationFrame(loop);
  }
  loop(performance.now());
}

// ========== 恐龙跳跃 ==========
function startDino() {
  if (gameAnimationId) {
    cancelAnimationFrame(gameAnimationId);
    gameAnimationId = null;
  }

  const W = gameCanvas.width, H = gameCanvas.height;
  const GROUND_Y = H - 60;
  const BASE_SPEED = 2.4;
  const MAX_SPEED = 5.8;
  const MIN_OBSTACLE_GAP = 340;
  const RANDOM_OBSTACLE_GAP = 420;
  const DISTANCE_PER_PIXEL_M = 0.02;
  const SPEED_ACCEL_PER_M = 0.014;
  const MOTOR_JUMP_DEG = 28;
  const MOTOR_JUMP_COOLDOWN_MS = 250;
  const MOTOR_MOVE_EPS_DEG = 1.5;
  const MOTOR_REARM_STOP_MS = 220;

  gameState = {
    keys: gameState.keys || {},
    dino: {
      x: 80, y: GROUND_Y, w: 40, h: 44,
      vy: 0, jumping: false, gameOver: false,
    },
    obstacles: [],
    clouds: [],
    distanceM: 0,
    speed: BASE_SPEED,
    frame: 0,
    lastObstacle: 0,
    nextObstacleGap: createObstacleGap(),
    groundOffset: 0,
    started: false,
    dinoMotorAnchorDeg: null,
    dinoLastJumpDeg: null,
    dinoLastMotorJumpAt: 0,
    dinoLastMotorRawDeg: null,
    dinoLastMotorMoveAt: 0,
    dinoMotorJumpArmed: true,
  };

  // 初始化云朵
  for (let i = 0; i < 3; i++) {
    gameState.clouds.push({
      x: Math.random() * W,
      y: 60 + Math.random() * 80,
      w: 40 + Math.random() * 30,
    });
  }

  function createObstacleGap() {
    return MIN_OBSTACLE_GAP + Math.random() * RANDOM_OBSTACLE_GAP;
  }

  function createObstacle() {
    const variants = [
      { type: 'cactus', color: '#34d399', accent: '#10b981' },
      { type: 'rock', color: '#a78bfa', accent: '#7c3aed' },
      { type: 'crystal', color: '#fbbf24', accent: '#f97316' },
    ];
    const variant = variants[Math.floor(Math.random() * variants.length)];
    const h = 28 + Math.random() * 26;
    const w = variant.type === 'rock' ? 28 + Math.random() * 14 : 20 + Math.random() * 12;

    return {
      x: W + 10,
      y: GROUND_Y - h,
      w,
      h,
      ...variant,
    };
  }

  window._dinoHandleShake = function(source) {
    if (currentGame !== 'dino' || source !== 'port1') return;
    const s = gameState;
    if (!s.dino) return;

    if (s.dino.gameOver) {
      startDino();
      return;
    }

    if (!s.started) {
      s.started = true;
    }
  };

  window._dinoHandleMotorRawDeg = function(rawDeg, source) {
    if (currentGame !== 'dino' || source !== 'port1') return;
    const s = gameState;
    if (!s.dino || !s.started || s.dino.gameOver) return;

    if (s.dinoMotorAnchorDeg == null) {
      s.dinoMotorAnchorDeg = rawDeg;
      s.dinoLastJumpDeg = rawDeg;
      s.dinoLastMotorRawDeg = rawDeg;
      return;
    }

    const now = performance.now();
    const rawDelta = Math.abs(rawDeg - s.dinoLastMotorRawDeg);
    s.dinoLastMotorRawDeg = rawDeg;
    if (rawDelta > MOTOR_MOVE_EPS_DEG) {
      s.dinoLastMotorMoveAt = now;
    } else if (!s.dino.jumping && !s.dinoMotorJumpArmed && now - s.dinoLastMotorMoveAt >= MOTOR_REARM_STOP_MS) {
      s.dinoMotorJumpArmed = true;
      s.dinoLastJumpDeg = rawDeg;
    }

    if (!s.dinoMotorJumpArmed) {
      return;
    }

    const jumpDelta = Math.abs(rawDeg - s.dinoLastJumpDeg);
    if (jumpDelta < MOTOR_JUMP_DEG || now - s.dinoLastMotorJumpAt < MOTOR_JUMP_COOLDOWN_MS) {
      return;
    }

    s.dinoLastJumpDeg = rawDeg;
    s.dinoLastMotorJumpAt = now;
    s.dinoMotorJumpArmed = false;
    if (!s.dino.jumping) {
      s.dino.vy = -15;
      s.dino.jumping = true;
    }
  };

  function update() {
    const s = gameState;
    const d = s.dino;
    if (d.gameOver || !s.started) return;

    s.frame++;
    s.distanceM += s.speed * DISTANCE_PER_PIXEL_M;
    s.speed = Math.min(MAX_SPEED, BASE_SPEED + s.distanceM * SPEED_ACCEL_PER_M);

    // 恐龙物理
    d.vy += 0.7; // 重力
    d.y += d.vy;
    if (d.y >= GROUND_Y) {
      d.y = GROUND_Y;
      d.vy = 0;
      d.jumping = false;
    }

    // 地面偏移
    s.groundOffset = (s.groundOffset + s.speed) % 20;

    // 生成障碍
    s.lastObstacle += s.speed;
    if (s.lastObstacle > s.nextObstacleGap) {
      s.obstacles.push(createObstacle());
      s.lastObstacle = 0;
      s.nextObstacleGap = createObstacleGap();
    }

    // 移动障碍
    s.obstacles.forEach(o => o.x -= s.speed);
    s.obstacles = s.obstacles.filter(o => o.x + o.w > -20);

    // 移动云朵
    s.clouds.forEach(c => {
      c.x -= s.speed * 0.3;
      if (c.x + c.w < 0) {
        c.x = W + Math.random() * 100;
        c.y = 60 + Math.random() * 80;
      }
    });

    // 碰撞检测
    const dinoBox = { x: d.x + 6, y: d.y - d.h + 6, w: d.w - 12, h: d.h - 10 };
    for (const o of s.obstacles) {
      const obsBox = { x: o.x, y: o.y, w: o.w, h: o.h };
      if (dinoBox.x < obsBox.x + obsBox.w &&
          dinoBox.x + dinoBox.w > obsBox.x &&
          dinoBox.y < obsBox.y + obsBox.h &&
          dinoBox.y + dinoBox.h > obsBox.y) {
        d.gameOver = true;
      }
    }
  }

  function draw() {
    const s = gameState;
    const d = s.dino;
    const ctx = gameCtx;
    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, W, H);

    // 云朵
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    s.clouds.forEach(c => {
      ctx.beginPath();
      ctx.ellipse(c.x + c.w / 2, c.y, c.w / 2, 10, 0, 0, Math.PI * 2);
      ctx.fill();
    });

    // 地面
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(W, GROUND_Y);
    ctx.stroke();

    // 地面纹理
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let x = -s.groundOffset; x < W; x += 20) {
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y + 4);
      ctx.lineTo(x + 10, GROUND_Y + 4);
      ctx.stroke();
    }

    // 恐龙（简化像素风格）
    ctx.fillStyle = '#22d3ee';
    ctx.shadowColor = 'rgba(34,211,238,0.4)';
    ctx.shadowBlur = 8;

    const dx = d.x, dy = d.y - d.h;
    // 身体
    ctx.fillRect(dx + 8, dy + 4, 24, 28);
    // 头
    ctx.fillRect(dx + 20, dy, 20, 16);
    // 眼睛
    ctx.fillStyle = '#12141c';
    ctx.fillRect(dx + 32, dy + 4, 4, 4);
    ctx.fillStyle = '#22d3ee';
    // 腿（交替动画）
    const legFrame = Math.floor(s.frame / 8) % 2;
    if (d.jumping) {
      ctx.fillRect(dx + 12, dy + 32, 6, 12);
      ctx.fillRect(dx + 22, dy + 32, 6, 12);
    } else {
      if (legFrame === 0) {
        ctx.fillRect(dx + 12, dy + 32, 6, 12);
        ctx.fillRect(dx + 22, dy + 36, 6, 8);
      } else {
        ctx.fillRect(dx + 12, dy + 36, 6, 8);
        ctx.fillRect(dx + 22, dy + 32, 6, 12);
      }
    }
    // 尾巴
    ctx.fillRect(dx, dy + 8, 10, 6);
    ctx.shadowBlur = 0;

    // 障碍物
    ctx.shadowBlur = 6;
    s.obstacles.forEach(o => {
      ctx.fillStyle = o.color;
      ctx.shadowColor = o.color;
      if (o.type === 'rock') {
        ctx.beginPath();
        ctx.roundRect(o.x, o.y + o.h * 0.15, o.w, o.h * 0.85, 8);
        ctx.fill();
        ctx.fillStyle = o.accent;
        ctx.fillRect(o.x + o.w * 0.18, o.y + o.h * 0.38, o.w * 0.28, 5);
      } else if (o.type === 'crystal') {
        ctx.beginPath();
        ctx.moveTo(o.x + o.w / 2, o.y);
        ctx.lineTo(o.x + o.w, o.y + o.h * 0.45);
        ctx.lineTo(o.x + o.w * 0.75, o.y + o.h);
        ctx.lineTo(o.x + o.w * 0.25, o.y + o.h);
        ctx.lineTo(o.x, o.y + o.h * 0.45);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = o.accent;
        ctx.fillRect(o.x + o.w * 0.48, o.y + o.h * 0.18, 4, o.h * 0.62);
      } else {
        ctx.fillRect(o.x, o.y, o.w, o.h);
        ctx.fillStyle = o.accent;
        ctx.fillRect(o.x - 4, o.y + o.h * 0.3, 6, o.h * 0.2);
        ctx.fillRect(o.x + o.w - 2, o.y + o.h * 0.5, 6, o.h * 0.15);
      }
    });
    ctx.shadowBlur = 0;

    // 距离
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = 'bold 20px monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${s.distanceM.toFixed(1)} m`, W - 20, 30);

    if (!s.started) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#22d3ee';
      ctx.font = 'bold 42px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('恐龙跳跃', W / 2, H / 2 - 40);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = '20px sans-serif';
      ctx.fillText('摇晃控制器开始游戏', W / 2, H / 2 + 8);
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.font = '14px sans-serif';
      ctx.fillText('开始后转动电机跳跃 · 空格键可调试', W / 2, H / 2 + 40);
      return;
    }

    // Game Over
    if (d.gameOver) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#f87171';
      ctx.font = 'bold 36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GAME OVER', W / 2, H / 2 - 10);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '16px sans-serif';
      ctx.fillText(`距离: ${s.distanceM.toFixed(1)} m  |  摇晃控制器 / 按空格键重新开始`, W / 2, H / 2 + 25);
    }
  }

  function loop() {
    update();
    draw();
    gameAnimationId = requestAnimationFrame(loop);
  }
  loop();
}

// ========== 跳一跳 ==========
function startJump() {
  const W = gameCanvas.width, H = gameCanvas.height;
  const ctx = gameCtx;
  const GROUND_Y = H - 80;
  const PLATFORM_H = 40;
  const PLAYER_SIZE = 30;
  const GRAVITY = 0.5;
  const WHEEL_DIAMETER_CM = 5.6; // 电机轮子直径 56mm。
  const WHEEL_CIRCUMFERENCE_CM = Math.PI * WHEEL_DIAMETER_CM;
  const PX_PER_CM = 16;
  const JUMP_VY = -12;
  const DISTANCE_OPTIONS_CM = [9, 10, 11, 12, 13, 14, 15, 16];
  const MOTOR_MOVE_EPS_DEG = 1.5;
  const MOTOR_STOP_DELAY_MS = 240;
  const MIN_JUMP_CM = 0.2;

  gameState = {
    keys: gameState.keys || {},
    phase: 'start', // 'start' | 'playing' | 'jumping' | 'landing' | 'falling' | 'gameover'
    score: 0,
    combo: 0,
    bestCombo: 0,
    // 平台数组：每个 { x, y, w, color }
    platforms: [],
    // 玩家
    player: { x: 0, y: 0, vy: 0, vx: 0, squash: 1 },
    // 电机测距
    motorRawDeg: 0,
    motorAnchorDeg: null,
    lastMotorDeg: null,
    lastMotorMoveAt: 0,
    hasMotorMoved: false,
    measuredCm: 0,
    lastJumpGapCm: 0,
    // 相机
    cameraX: 0,
    targetCameraX: 0,
    // 粒子
    particles: [],
    // 动画帧
    frame: 0,
    // 开始界面动画
    startBounce: 0,
  };
  const jumpState = gameState;

  // 初始化第一个平台
  const firstW = 100;
  const firstX = 150;
  gameState.platforms.push({
    x: firstX, y: GROUND_Y, w: firstW,
    color: '#22d3ee',
  });

  // 生成后续平台
  generateNextPlatform();
  generateNextPlatform();

  // 玩家站在第一个平台上
  gameState.player.x = firstX + firstW / 2;
  gameState.player.y = GROUND_Y - PLAYER_SIZE;
  gameState.currentPlatformIndex = 0;

  function generateNextPlatform() {
    const s = gameState;
    const last = s.platforms[s.platforms.length - 1];
    const gapCm = DISTANCE_OPTIONS_CM[Math.floor(Math.random() * DISTANCE_OPTIONS_CM.length)];
    const gap = gapCm * PX_PER_CM;
    const w = 60 + Math.random() * 50;
    const colors = ['#22d3ee', '#34d399', '#a78bfa', '#f472b6', '#fbbf24', '#f87171'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    s.platforms.push({
      x: last.x + last.w + gap,
      y: GROUND_Y,
      w: w,
      gapCm,
      color: color,
    });
  }

  function spawnParticles(x, y, color, count) {
    for (let i = 0; i < count; i++) {
      gameState.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 6,
        vy: -Math.random() * 5 - 2,
        life: 30 + Math.random() * 20,
        maxLife: 50,
        color: color,
        size: 3 + Math.random() * 4,
      });
    }
  }

  function jumpSendHardware(msg) {
    if (typeof writeToPort === 'function' && serialPorts.port1 && serialPorts.port1.isConnected) {
      writeToPort('port1', `${msg}\n`).catch(() => {});
    }
  }

  function motorDegToCm(deg) {
    return Math.abs(deg) / 360 * WHEEL_CIRCUMFERENCE_CM;
  }

  function resetMotorMeasure(rawDeg = gameState.motorRawDeg) {
    const s = gameState;
    s.motorAnchorDeg = rawDeg;
    s.lastMotorDeg = rawDeg;
    s.lastMotorMoveAt = performance.now();
    s.hasMotorMoved = false;
    s.measuredCm = 0;
  }

  function getCurrentTargetPlatform() {
    const s = gameState;
    return s.platforms[s.currentPlatformIndex + 1] || null;
  }

  function getCurrentPlatform() {
    const s = gameState;
    return s.platforms[s.currentPlatformIndex] || null;
  }

  function beginPlaying() {
    const s = gameState;
    s.phase = 'playing';
    s.motorAnchorDeg = null;
    s.lastMotorDeg = null;
    s.lastMotorMoveAt = 0;
    s.hasMotorMoved = false;
    s.measuredCm = 0;
    jumpSendHardware('RESET');
  }

  function restartJumpGame() {
    if (gameAnimationId) {
      cancelAnimationFrame(gameAnimationId);
      gameAnimationId = null;
    }
    if (gameState._jumpCleanup) {
      gameState._jumpCleanup();
    }
    window._jumpHandleShake = null;
    window._jumpHandleMotorRawDeg = null;
    startJump();
  }

  function releaseJump(measuredGapCm = gameState.measuredCm) {
    const s = gameState;
    if (s.phase !== 'playing') return;
    const current = getCurrentPlatform();
    const target = getCurrentTargetPlatform();
    if (!current || !target) return;

    const gapCm = Math.max(0, measuredGapCm);
    if (gapCm < 1) return;
    s.phase = 'jumping';
    s.lastJumpGapCm = gapCm;

    const horizontalPx = current.w / 2 + gapCm * PX_PER_CM + target.w / 2;
    const flightFrames = Math.max(1, (-2 * JUMP_VY) / GRAVITY);
    s.player.vy = JUMP_VY;
    s.player.vx = horizontalPx / flightFrames;
    s.player.squash = 1;
  }

  function updateMotorMeasure(rawDeg) {
    const s = gameState;
    const prevDeg = s.lastMotorDeg;
    s.motorRawDeg = rawDeg;
    if (s.motorAnchorDeg === null) {
      resetMotorMeasure(rawDeg);
      return;
    }
    s.lastMotorDeg = rawDeg;
    s.measuredCm = motorDegToCm(rawDeg - s.motorAnchorDeg);

    if (prevDeg !== null && Math.abs(rawDeg - prevDeg) >= MOTOR_MOVE_EPS_DEG) {
      s.lastMotorMoveAt = performance.now();
      s.hasMotorMoved = true;
    }
  }

  window._jumpHandleShake = function(source) {
    if (currentGame !== 'jump' || source !== 'port1') return;
    if (gameState.phase === 'start') {
      beginPlaying();
    } else if (gameState.phase === 'gameover') {
      restartJumpGame();
    }
  };

  // 键盘 / 鼠标 / 触摸事件
  function jumpKeyDown(e) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (gameState.phase === 'start') {
        beginPlaying();
        return;
      }
      if (gameState.phase === 'gameover') {
        restartJumpGame();
        return;
      }
      const target = getCurrentTargetPlatform();
      if (target) releaseJump(target.gapCm);
    }
  }

  function jumpKeyUp(e) {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
    }
  }

  function jumpMouseDown(e) {
    if (gameState.phase === 'start') {
      beginPlaying();
      return;
    }
    if (gameState.phase === 'gameover') {
      restartJumpGame();
      return;
    }
    const target = getCurrentTargetPlatform();
    if (target) releaseJump(target.gapCm);
  }

  // 替换通用键盘处理，使用游戏专用的
  document.removeEventListener('keydown', gameKeyHandler);
  document.removeEventListener('keyup', gameKeyUpHandler);
  document.addEventListener('keydown', jumpKeyDown);
  document.addEventListener('keyup', jumpKeyUp);
  gameCanvas.addEventListener('mousedown', jumpMouseDown);
  gameCanvas.addEventListener('touchstart', jumpMouseDown);

  // 存储清理函数
  gameState._jumpCleanup = () => {
    document.removeEventListener('keydown', jumpKeyDown);
    document.removeEventListener('keyup', jumpKeyUp);
    gameCanvas.removeEventListener('mousedown', jumpMouseDown);
    gameCanvas.removeEventListener('touchstart', jumpMouseDown);
  };

  window._jumpHandleMotorRawDeg = function(rawDeg, source) {
    if (currentGame !== 'jump' || source !== 'port1') return;
    updateMotorMeasure(rawDeg);
  };

  function update() {
    const s = gameState;
    s.frame++;

    // 开始界面弹跳动画
    if (s.phase === 'start') {
      s.startBounce = Math.sin(s.frame * 0.05) * 8;
      return;
    }

    if (s.phase === 'playing') {
      const target = getCurrentTargetPlatform();
      const ratio = target ? Math.min(s.measuredCm / target.gapCm, 1) : 0;
      s.player.squash = 1 - ratio * 0.25;
      if (s.hasMotorMoved && s.measuredCm >= MIN_JUMP_CM && performance.now() - s.lastMotorMoveAt >= MOTOR_STOP_DELAY_MS) {
        releaseJump(s.measuredCm);
      }
    }

    // 跳跃中
    if (s.phase === 'jumping') {
      s.player.vy += GRAVITY;
      s.player.x += s.player.vx;
      s.player.y += s.player.vy;

      // 旋转效果用 frame 计数

      // 检测是否落到平台上
      if (s.player.vy > 0) {
        for (let i = 0; i < s.platforms.length; i++) {
          const p = s.platforms[i];
          const px = s.player.x;
          const py = s.player.y + PLAYER_SIZE;
          if (py >= p.y && py <= p.y + 15 && px >= p.x && px <= p.x + p.w) {
            // 落地成功
            s.player.y = p.y - PLAYER_SIZE;
            s.player.vy = 0;
            s.player.vx = 0;
            s.player.squash = 0.6;
            s.phase = 'landing';
            s.landingTimer = 8;

            if (i > s.currentPlatformIndex) {
              // 跳到新平台
              const center = p.x + p.w / 2;
              const dist = Math.abs(s.player.x - center);
              const perfectZone = 8;

              if (dist <= perfectZone) {
                // 完美着陆
                s.score += 2;
                s.combo++;
                spawnParticles(s.player.x, s.player.y + PLAYER_SIZE, '#fbbf24', 15);
              } else {
                s.score += 1;
                s.combo = 0;
                spawnParticles(s.player.x, s.player.y + PLAYER_SIZE, p.color, 8);
              }

              s.bestCombo = Math.max(s.bestCombo, s.combo);
              s.currentPlatformIndex = i;

              // 生成新平台
              while (s.platforms.length < i + 4) {
                generateNextPlatform();
              }
            }
            break;
          }
        }

        // 掉落到画面外
        if (s.player.y > GROUND_Y + 200) {
          s.phase = 'gameover';
        }
      }
    }

    // 落地恢复动画
    if (s.phase === 'landing') {
      s.landingTimer--;
      s.player.squash = 0.6 + (1 - 0.6) * (1 - s.landingTimer / 8);
      if (s.landingTimer <= 0) {
        s.player.squash = 1;
        s.phase = 'playing';
        resetMotorMeasure();
      }
    }

    // 相机跟随
    s.targetCameraX = s.player.x - 200;
    s.cameraX += (s.targetCameraX - s.cameraX) * 0.08;

    // 更新粒子
    s.particles.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15;
      p.life--;
    });
    s.particles = s.particles.filter(p => p.life > 0);
  }

  function draw() {
    const s = gameState;
    const p = s.player;

    // 背景
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, W, H);

    // 开始界面
    if (s.phase === 'start') {
      drawStartScreen();
      return;
    }

    ctx.save();
    ctx.translate(-s.cameraX, 0);

    // 背景装饰线条
    ctx.strokeStyle = 'rgba(255,255,255,0.02)';
    ctx.lineWidth = 1;
    for (let x = Math.floor(s.cameraX / 100) * 100; x < s.cameraX + W + 100; x += 100) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // 绘制平台
    s.platforms.forEach((plat, i) => {
      // 平台阴影
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(plat.x + 4, plat.y + 4, plat.w, PLATFORM_H);

      // 平台本体
      ctx.fillStyle = plat.color;
      ctx.shadowColor = plat.color;
      ctx.shadowBlur = i === s.currentPlatformIndex ? 12 : 4;
      ctx.fillRect(plat.x, plat.y, plat.w, PLATFORM_H);
      ctx.shadowBlur = 0;

      // 平台顶部高光
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(plat.x, plat.y, plat.w, 3);

      if (i > 0 && plat.gapCm) {
        const prev = s.platforms[i - 1];
        const lineStart = prev.x + prev.w;
        const lineEnd = plat.x;
        const midX = (lineStart + lineEnd) / 2;
        const lineY = plat.y - 34;
        ctx.strokeStyle = i === s.currentPlatformIndex + 1 ? '#fbbf24' : 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(lineStart, lineY);
        ctx.lineTo(lineEnd, lineY);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(lineStart, lineY - 5);
        ctx.lineTo(lineStart, lineY + 5);
        ctx.moveTo(lineEnd, lineY - 5);
        ctx.lineTo(lineEnd, lineY + 5);
        ctx.stroke();
        ctx.fillStyle = i === s.currentPlatformIndex + 1 ? '#fbbf24' : 'rgba(255,255,255,0.55)';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${plat.gapCm} cm`, midX, lineY - 6);
      }

      // 下一个目标平台标记
      if (i === s.currentPlatformIndex + 1 && s.phase === 'playing') {
        const centerX = plat.x + plat.w / 2;
        const indicatorY = plat.y - 15 + Math.sin(s.frame * 0.08) * 4;
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.beginPath();
        ctx.moveTo(centerX, indicatorY);
        ctx.lineTo(centerX - 5, indicatorY - 8);
        ctx.lineTo(centerX + 5, indicatorY - 8);
        ctx.closePath();
        ctx.fill();
      }
    });

    // 绘制粒子
    s.particles.forEach(part => {
      const alpha = part.life / part.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = part.color;
      ctx.fillRect(part.x - part.size / 2, part.y - part.size / 2, part.size, part.size);
    });
    ctx.globalAlpha = 1;

    // 绘制电机测距进度（玩家下方）
    if (s.phase === 'playing') {
      const target = getCurrentTargetPlatform();
      const targetCm = target ? target.gapCm : 0;
      const ratio = targetCm ? Math.min(s.measuredCm / targetCm, 1) : 0;
      const barW = 68;
      const barH = 6;
      const barX = p.x - barW / 2;
      const barY = p.y + PLAYER_SIZE + 15;

      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);

      // 渐变颜色：绿→黄→红
      let barColor;
      if (ratio < 0.5) barColor = '#34d399';
      else if (ratio < 0.8) barColor = '#fbbf24';
      else barColor = '#f87171';

      ctx.fillStyle = barColor;
      ctx.shadowColor = barColor;
      ctx.shadowBlur = 6;
      ctx.fillRect(barX, barY, barW * ratio, barH);
      ctx.shadowBlur = 0;

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${s.measuredCm.toFixed(1)} / ${targetCm || 0} cm`, p.x, barY + 10);
    }

    // 绘制玩家（方块角色）
    const squashH = PLAYER_SIZE * p.squash;
    const squashW = PLAYER_SIZE * (1 + (1 - p.squash) * 0.5);
    const drawX = p.x - squashW / 2;
    const drawY = p.y + PLAYER_SIZE - squashH;

    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(255,255,255,0.5)';
    ctx.shadowBlur = 10;
    ctx.fillRect(drawX, drawY, squashW, squashH);
    ctx.shadowBlur = 0;

    // 玩家眼睛
    const eyeY = drawY + squashH * 0.3;
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(drawX + squashW * 0.25 - 2, eyeY, 4, 4);
    ctx.fillRect(drawX + squashW * 0.75 - 2, eyeY, 4, 4);

    // 跳跃中旋转指示（小旋风线条）
    if (s.phase === 'jumping') {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 2;
      const rot = s.frame * 0.3;
      for (let i = 0; i < 3; i++) {
        const angle = rot + (i * Math.PI * 2 / 3);
        const r = 20;
        const cx = p.x;
        const cy = p.y + PLAYER_SIZE / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, angle, angle + 0.5);
        ctx.stroke();
      }
    }

    ctx.restore();

    // ===== UI 覆盖层（不受相机影响） =====

    // 分数
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(s.score, 20, 40);

    // Combo 提示
    if (s.combo >= 2) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(`🔥 COMBO x${s.combo}`, 20, 68);
    }

    // Game Over
    if (s.phase === 'gameover') {
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(0, 0, W, H);

      ctx.fillStyle = '#f87171';
      ctx.font = 'bold 42px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('GAME OVER', W / 2, H / 2 - 40);

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '22px sans-serif';
      ctx.fillText(`得分: ${s.score}`, W / 2, H / 2 + 5);

      if (s.bestCombo > 0) {
        ctx.fillStyle = '#fbbf24';
        ctx.font = '16px sans-serif';
        ctx.fillText(`最佳连击: ${s.bestCombo}`, W / 2, H / 2 + 35);
      }

      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.font = '16px sans-serif';
      ctx.fillText('摇晃控制器 / 按空格键 / 点击 重新开始', W / 2, H / 2 + 70);
    }
  }

  function drawStartScreen() {
    const s = gameState;
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(0, 0, W, H);

    // 背景装饰 - 浮动方块
    ctx.globalAlpha = 0.06;
    for (let i = 0; i < 12; i++) {
      const bx = (i * 97 + s.frame * 0.3) % (W + 40) - 20;
      const by = (i * 73 + Math.sin(s.frame * 0.02 + i) * 30) % H;
      const bSize = 15 + (i % 4) * 8;
      ctx.fillStyle = ['#22d3ee', '#34d399', '#a78bfa', '#f472b6'][i % 4];
      ctx.fillRect(bx, by, bSize, bSize);
    }
    ctx.globalAlpha = 1;

    // 标题
    const titleY = H / 2 - 70 + s.startBounce;

    // 小方块角色
    const charSize = 50;
    const charX = W / 2 - charSize / 2;
    const charY = titleY - 100;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(255,255,255,0.6)';
    ctx.shadowBlur = 20;
    ctx.fillRect(charX, charY, charSize, charSize);
    ctx.shadowBlur = 0;

    // 角色眼睛
    ctx.fillStyle = '#0f1117';
    ctx.fillRect(charX + charSize * 0.25 - 3, charY + charSize * 0.35, 6, 6);
    ctx.fillRect(charX + charSize * 0.75 - 3, charY + charSize * 0.35, 6, 6);

    // 小平台在角色下方
    ctx.fillStyle = '#22d3ee';
    ctx.shadowColor = '#22d3ee';
    ctx.shadowBlur = 10;
    ctx.fillRect(W / 2 - 35, charY + charSize + 5, 70, 10);
    ctx.shadowBlur = 0;

    // 游戏名
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('数字测量尺', W / 2, titleY + 10);

    // 副标题
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '18px sans-serif';
    ctx.fillText('转动电机测量厘米距离 · 停止转动后自动跳跃', W / 2, titleY + 50);

    // 操作提示（闪烁）
    const blink = Math.sin(s.frame * 0.06) * 0.3 + 0.5;
    ctx.fillStyle = `rgba(255,255,255,${blink})`;
    ctx.font = '20px sans-serif';
    ctx.fillText('摇晃控制器开始游戏', W / 2, titleY + 110);

    // 操作说明框
    const boxY = titleY + 140;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(W / 2 - 150, boxY, 300, 70);
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.strokeRect(W / 2 - 150, boxY, 300, 70);

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '14px sans-serif';
    ctx.fillText('轮径 56mm：角度 × 周长换算为 cm', W / 2, boxY + 25);
    ctx.fillText('空格/点击可模拟一次精准跳跃', W / 2, boxY + 48);
  }

  function loop() {
    if (currentGame !== 'jump' || gameState !== jumpState) return;
    update();
    draw();
    gameAnimationId = requestAnimationFrame(loop);
  }
  loop();
}

// ========== 串口数据解析器（单控制器 + 兼容玩家ID前缀） ==========
// 硬件输入收敛：控制器本体负责 JOY / RAW_JOY / BTN / GYRO / SHAKE，一个电机负责 DEGREE / ANGLE。
// 解析星瀚固定手柄串口数据协议
// 支持两种数据格式：
//   1. 带玩家前缀: "P1|JOY:UP", "P2|BTN:PRESSED" （兼容旧固件，统一收敛为控制器）
//   2. 无前缀:     "JOY:UP", "BTN:PRESSED"
// portId: 当前保留为 'port1'。
const GYRO_STATE_DIRECTION_MAP = {
  向前倾斜: 'UP',
  向后倾斜: 'DOWN',
  向左倾斜: 'LEFT',
  向右倾斜: 'RIGHT',
};

function gyroStateToDirection(state) {
  return GYRO_STATE_DIRECTION_MAP[String(state || '').trim()] || null;
}

function handleSerialData(data, portId) {
  const msg = normalizeIncomingTextLine(data);
  if (!msg) return;

  // ========== 第一步：解析玩家ID前缀 ==========
  // 数据格式: "P1|JOY:UP" 或 "P2|BTN:PRESSED"
  // 按 | 拆分，第一部分为玩家ID，第二部分为指令
  let source = portId || 'port1'; // 默认使用物理端口ID
  let command = msg;              // 默认整条消息就是指令

  const pipeIndex = msg.indexOf('|');
  if (pipeIndex > 0) {
    const prefix = msg.substring(0, pipeIndex).trim().toUpperCase();
    const payload = msg.substring(pipeIndex + 1).trim();

    // 兼容旧玩家前缀：P1 / P2 都进入同一个控制器输入源。
    if (prefix === 'P1') {
      source = 'port1';
      command = payload;
    } else if (prefix === 'P2') {
      source = 'port1';
      command = payload;
    }
    // 不再对每条消息都记录调试日志（高频消息会产生大量垃圾）
  }
  command = normalizeIncomingTextLine(command);
  source = normalizeSingleControllerSource(source);

  // ========== 第二步：记录原始数据到调试缓冲区 ==========
  const dbg = window._serialDebug[source];
  if (dbg) {
    dbg.lastRaw = msg;        // 记录完整原始数据（含前缀）
    dbg.lastTime = Date.now();
    dbg.eventCount++;
  }

  // ========== 第三步：解析指令部分 ==========
  // 统一转为大写进行协议匹配（设备可能发送大小写混合）
  const upper = command.toUpperCase();

  // JOY 方向事件
  if (upper.startsWith('JOY:')) {
    const dir = upper.substring(4).trim();
    if (['UP', 'DOWN', 'LEFT', 'RIGHT', 'CENTER'].includes(dir)) {
      if (dbg) dbg.lastParsed = `[${source}] JOY → ${dir}`;
      _dbgLog(`JOY: dir=${dir} source=${source} → calling onSerialDirection`);
      onSerialDirection(dir, source);
    } else {
      if (dbg) dbg.lastParsed = `[${source}] JOY → ???(${dir})`;
    }
    return;
  }

  // RAW_JOY 摇杆坐标（高频数据，跳过调试记录）
  if (upper.startsWith('RAW_JOY:')) {
    const parts = command.substring(8).split(',');
    if (parts.length === 2) {
      const x = parseFloat(parts[0]);
      const y = parseFloat(parts[1]);
      if (!isNaN(x) && !isNaN(y)) {
        onSerialRawJoy(x, y, source);
      }
    }
    return;
  }

  // BTN 按键事件
  if (upper.startsWith('BTN:')) {
    const action = upper.substring(4).trim();
    if (action === 'PRESSED') {
      if (dbg) dbg.lastParsed = `[${source}] BTN → PRESSED`;
      _dbgLog(`BTN: PRESSED source=${source} → calling onSerialButton(true)`);
      onSerialButton(true, source);
    } else if (action === 'RELEASED') {
      if (dbg) dbg.lastParsed = `[${source}] BTN → RELEASED`;
      _dbgLog(`BTN: RELEASED source=${source} → calling onSerialButton(false)`);
      onSerialButton(false, source);
    } else {
      if (dbg) dbg.lastParsed = `[${source}] BTN → ???(${action})`;
    }
    return;
  }

  // DEGREE 电机角度（高频数据，跳过调试记录）
  if (upper.startsWith('DEGREE:')) {
    const val = parseFloat(command.substring(7));
    if (!isNaN(val)) {
      onSerialDegree(val, source);
    }
    return;
  }

  // 钓鱼演示 V2 硬件协议（与 software_V2.py 一致）：ANGLE|累计角；也兼容单电机 DEGREE:
  if (upper.startsWith('ANGLE|')) {
    const bar = command.indexOf('|');
    const val = bar >= 0 ? parseFloat(command.substring(bar + 1)) : NaN;
    if (!isNaN(val)) {
      if (currentGame === 'pong' && window._pongHandleMotorRawDeg) {
        window._pongHandleMotorRawDeg(val, source);
      } else if (currentGame === 'dino' && window._dinoHandleMotorRawDeg) {
        window._dinoHandleMotorRawDeg(val, source);
      } else if (currentGame === 'jump' && window._jumpHandleMotorRawDeg) {
        window._jumpHandleMotorRawDeg(val, source);
      } else if (currentGame === 'fishing' && window._fishingHandleMotorRawDeg) {
        window._fishingHandleMotorRawDeg(val, source);
      }
    }
    return;
  }
  if (upper.startsWith('GYRO|')) {
    const bar = command.indexOf('|');
    const rest = bar >= 0 ? command.substring(bar + 1).trim() : '';
    if (rest === '摇晃') {
      if (dbg) dbg.lastParsed = `[${source}] GYRO → 摇晃`;
      onSerialShake(source);
    } else {
      const dir = gyroStateToDirection(rest);
      if (dir) {
        if (dbg) dbg.lastParsed = `[${source}] GYRO → ${rest} / ${dir}`;
        onSerialDirection(dir, source);
      } else if (dbg) {
        dbg.lastParsed = `[${source}] GYRO → ${rest || 'EMPTY'}`;
      }
    }
    return;
  }

  // MOTOR 旋转状态
  if (upper.startsWith('MOTOR:')) {
    const state = upper.substring(6).trim();
    if (state === 'CW' || state === 'CCW') {
      if (dbg) dbg.lastParsed = `[${source}] MOTOR → ${state}`;
      onSerialMotor(state, source);
    }
    return;
  }

  // GYRO 陀螺仪姿态角（高频数据）: GYRO:<pitch>,<roll>,<yaw>
  if (upper.startsWith('GYRO:')) {
    const parts = command.substring(5).split(',');
    if (parts.length >= 2) {
      const pitch = parseFloat(parts[0]);
      const roll  = parseFloat(parts[1]);
      const yaw   = parts.length >= 3 ? parseFloat(parts[2]) : 0;
      if (!isNaN(pitch) && !isNaN(roll)) {
        onSerialGyro(pitch, roll, yaw, source);
      }
    }
    return;
  }

  // FISH 钓鱼专用协议（来自钓鱼竿控制器）
  if (upper.startsWith('FISH:')) {
    const fishCmd = upper.substring(5); // 去掉 "FISH:" 前缀
    if (fishCmd === 'CAST') {
      // 甩杆
      if (dbg) dbg.lastParsed = `[${source}] FISH → CAST`;
      onSerialFishCast(source);
    } else if (fishCmd.startsWith('REEL:')) {
      // 卷线: FISH:REEL:<delta_deg>  (每累计约10度发送一次，带符号)
      const delta = parseInt(command.substring(10), 10); // "FISH:REEL:" = 10 chars
      if (!isNaN(delta)) {
        if (dbg) dbg.lastParsed = `[${source}] FISH → REEL:${delta}`;
        onSerialFishReel(delta, source);
      }
    } else if (fishCmd.startsWith('SHAKE:')) {
      // 逗鱼晃动: FISH:SHAKE:<intensity 0-100>
      const intensity = parseInt(command.substring(11), 10); // "FISH:SHAKE:" = 11 chars
      if (!isNaN(intensity)) {
        if (dbg) dbg.lastParsed = `[${source}] FISH → SHAKE:${intensity}`;
        onSerialFishShake(intensity, source);
      }
    } else {
      if (dbg) dbg.lastParsed = `[${source}] FISH → ???(${fishCmd})`;
    }
    return;
  }

  // 未识别的协议
  if (dbg) dbg.lastParsed = `[${source}] UNKNOWN: ${command.substring(0, 20)}`;
}

// 串口事件分发 - 方向（source: 'port1'）
function onSerialDirection(dir, source) {
  // 分发给当前活跃的游戏
  if (currentGame === 'gomoku') {
    if (gameState.gomoku) {
      gomokuHandleDirection(dir, source);
    } else {
      _dbgLog(`WARN: gomoku active but gameState.gomoku is null! source=${source} dir=${dir}`);
    }
  } else if (currentGame === 'pong') {
    if (window._pongHandleDirection) {
      window._pongHandleDirection(dir, source);
    }
  } else if (currentGame === 'snake') {
    // Snake: 仅 port1 控制
    if (window._snakeHandleDirection) {
      window._snakeHandleDirection(dir, source);
    } else if (source === 'port1') {
      gameState.keys = gameState.keys || {};
      const keyMap = { UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight' };
      if (keyMap[dir]) { gameState.keys[keyMap[dir]] = true; setTimeout(() => { gameState.keys[keyMap[dir]] = false; }, 200); }
    }
  } else if (currentGame === 'tank') {
    if (gameState.tank) {
      tankHandleDirection(dir, source);
    }
  } else if (currentGame === 'fishing') {
    if (window._fishingHandleDirection) {
      window._fishingHandleDirection(dir, source);
    }
  } else if (currentGame === 'pokemon') {
    if (window._pokemonHandleDirection) {
      window._pokemonHandleDirection(dir, source);
    }
  } else if (currentGame === 'gyro') {
    if (window._gyroHandleDirection) {
      window._gyroHandleDirection(dir, source);
    }
  }
}

// 串口事件分发 - 按键（source: 'port1'）
function onSerialButton(pressed, source) {
  if (currentGame === 'gomoku') {
    if (gameState.gomoku) {
      if (pressed) {
        gomokuHandlePlace(source);
      }
    }
  } else if (currentGame === 'tank') {
    if (gameState.tank && pressed) {
      tankHandleButton(source);
    }
  } else if (currentGame === 'jump' && source === 'port1') {
    if (gameState.phase === 'start' || gameState.phase === 'gameover') {
      return;
    }
    if (pressed) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    } else {
      document.dispatchEvent(new KeyboardEvent('keyup', { key: ' ' }));
    }
  } else if (currentGame === 'pong') {
    if (window._pongHandleButton) {
      window._pongHandleButton(pressed, source);
    }
  } else if (currentGame === 'fishing') {
    if (window._fishingHandleButton) {
      window._fishingHandleButton(pressed, source);
    }
  } else if (currentGame === 'pokemon') {
    if (window._pokemonHandleButton && pressed) {
      window._pokemonHandleButton(source);
    }
  } else if (currentGame === 'gyro') {
    if (window._gyroHandleButton) {
      window._gyroHandleButton(pressed, source);
    }
  }
}

// 串口事件分发 - 原始摇杆坐标
function onSerialRawJoy(x, y, source) {
  if (currentGame === 'pong' && window._pongHandleRawJoy) {
    window._pongHandleRawJoy(x, y, source);
  }
  if (currentGame === 'fishing' && window._fishingHandleRawJoy) {
    window._fishingHandleRawJoy(x, y, source);
  }
  if (currentGame === 'gyro' && window._gyroHandleRawJoy) {
    window._gyroHandleRawJoy(x, y, source);
  }
}

// 串口事件分发 - 电机角度
function onSerialDegree(value, source) {
  if (currentGame === 'pong' && window._pongHandleMotorRawDeg) {
    window._pongHandleMotorRawDeg(value, source);
  } else if (currentGame === 'dino' && window._dinoHandleMotorRawDeg) {
    window._dinoHandleMotorRawDeg(value, source);
  } else if (currentGame === 'jump' && window._jumpHandleMotorRawDeg) {
    window._jumpHandleMotorRawDeg(value, source);
  } else if (currentGame === 'fishing' && window._fishingHandleDegree) {
    window._fishingHandleDegree(value, source);
  }
}

// 串口事件分发 - 电机旋转方向
function onSerialMotor(state, source) {
  // CW / CCW 可映射到游戏内旋转动作
}

// 串口事件分发 - 陀螺仪姿态角（GYRO:pitch,roll,yaw）
function onSerialGyro(pitch, roll, yaw, source) {
  if (currentGame === 'gyro' && window._gyroHandleGyro) {
    window._gyroHandleGyro(pitch, roll, yaw, source);
  }
}

// 串口事件分发 - 陀螺仪摇晃（统一开始/继续入口）
function onSerialShake(source) {
  if (source !== 'port1') return;

  if (currentGame === 'pong' && window._pongHandleShake) {
    window._pongHandleShake(source);
  } else if (currentGame === 'snake' && window._snakeHandleShake) {
    window._snakeHandleShake(source);
  } else if (currentGame === 'dino' && window._dinoHandleShake) {
    window._dinoHandleShake(source);
  } else if (currentGame === 'jump' && window._jumpHandleShake) {
    window._jumpHandleShake(source);
  } else if (currentGame === 'fishing' && window._fishingHandleGyroShake) {
    window._fishingHandleGyroShake(source);
  }
}

// 串口事件分发 - 钓鱼甩杆（FISH:CAST）
function onSerialFishCast(source) {
  if (currentGame === 'fishing' && window._fishingHandleFishCast) {
    window._fishingHandleFishCast(source);
  }
}

// 串口事件分发 - 钓鱼卷线（FISH:REEL:<delta_deg>）
function onSerialFishReel(delta, source) {
  if (currentGame === 'fishing' && window._fishingHandleFishReel) {
    window._fishingHandleFishReel(delta, source);
  }
}

// 串口事件分发 - 钓鱼晃动逗鱼（FISH:SHAKE:<intensity>）
function onSerialFishShake(intensity, source) {
  if (currentGame === 'fishing' && window._fishingHandleFishShake) {
    window._fishingHandleFishShake(intensity, source);
  }
}

// ========== 五子棋游戏 ==========
function startGomoku() {
  const W = gameCanvas.width, H = gameCanvas.height;
  const ctx = gameCtx;
  const BOARD_SIZE = 15;
  // 计算棋盘布局：在画布中居中
  const MARGIN_TOP = 50;
  const MARGIN_BOTTOM = 20;
  const MARGIN_LEFT = 160; // 左侧留给信息面板
  const availableH = H - MARGIN_TOP - MARGIN_BOTTOM;
  const CELL_SIZE = Math.floor(availableH / (BOARD_SIZE - 1));
  const BOARD_W = CELL_SIZE * (BOARD_SIZE - 1);
  const BOARD_H = CELL_SIZE * (BOARD_SIZE - 1);
  const OFFSET_X = MARGIN_LEFT + Math.floor((W - MARGIN_LEFT - BOARD_W) / 2);
  const OFFSET_Y = MARGIN_TOP + Math.floor((availableH - BOARD_H) / 2);

  // 初始化游戏状态
  gameState = {
    keys: gameState.keys || {},
    gomoku: {
      board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(0)), // 0=空, 1=黑, 2=白
      // 光标
      cursorX: 7,
      cursorY: 7,
      cursor2X: 7, // 玩家2 光标（PVP模式）
      cursor2Y: 9,
      // 回合: 1=黑(玩家1), 2=白(玩家2/AI)
      currentPlayer: 1,
      // 模式: 'menu' | 'pve' | 'pvp'
      mode: 'menu',
      menuIndex: 0, // 0=PVE, 1=PVP
      // 胜负
      winner: 0, // 0=无, 1=黑赢, 2=白赢, 3=平局
      winLine: [], // 获胜的5个位置
      // 动画
      frame: 0,
      lastMoveX: -1,
      lastMoveY: -1,
      moveHistory: [],
      // 提示信息
      message: '',
      messageTimer: 0,
      // AI 思考中
      aiThinking: false,
      // 串口移动节流
      lastSerialMove: 0,
    },
  };

  // 五子棋键盘处理
  document.removeEventListener('keydown', gameKeyHandler);
  document.removeEventListener('keyup', gameKeyUpHandler);

  function gomokuKeyDown(e) {
    const g = gameState.gomoku;
    if (!g) return;

    if (g.mode === 'menu') {
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        g.menuIndex = (g.menuIndex + 1) % 2;
      }
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        g.menuIndex = (g.menuIndex + 1) % 2;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        g.mode = g.menuIndex === 0 ? 'pve' : 'pvp';
        g.currentPlayer = 1;
        g.message = g.mode === 'pve' ? '人机对战 - 你执黑先行' : '双人对战 - 黑方(手柄/方向键)先行';
        g.messageTimer = 120;
      }
      return;
    }

    // 游戏结束时按R重新开始
    if (g.winner !== 0) {
      if (e.key === 'r' || e.key === 'R') {
        startGomoku();
      }
      return;
    }

    // AI 思考中不允许操作
    if (g.aiThinking) return;

    // PVP 模式 - 玩家2用 WASD + Space
    if (g.mode === 'pvp' && g.currentPlayer === 2) {
      if (e.key === 'w' || e.key === 'W') { e.preventDefault(); g.cursor2Y = Math.max(0, g.cursor2Y - 1); }
      if (e.key === 's' || e.key === 'S') { e.preventDefault(); g.cursor2Y = Math.min(BOARD_SIZE - 1, g.cursor2Y + 1); }
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); g.cursor2X = Math.max(0, g.cursor2X - 1); }
      if (e.key === 'd' || e.key === 'D') { e.preventDefault(); g.cursor2X = Math.min(BOARD_SIZE - 1, g.cursor2X + 1); }
      if (e.key === ' ') {
        e.preventDefault();
        gomokuPlaceStone(g.cursor2X, g.cursor2Y);
      }
      return;
    }

    // 玩家1用方向键
    if (e.key === 'ArrowUp') { e.preventDefault(); g.cursorY = Math.max(0, g.cursorY - 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); g.cursorY = Math.min(BOARD_SIZE - 1, g.cursorY + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); g.cursorX = Math.max(0, g.cursorX - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); g.cursorX = Math.min(BOARD_SIZE - 1, g.cursorX + 1); }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      gomokuPlaceStone(g.cursorX, g.cursorY);
    }
  }

  document.addEventListener('keydown', gomokuKeyDown);

  // 存储清理函数
  gameState._gomokuCleanup = () => {
    document.removeEventListener('keydown', gomokuKeyDown);
  };

  // 覆盖 stopCurrentGame 中的清理
  const origStopCleanup = gameState._jumpCleanup;
  gameState._jumpCleanup = () => {
    if (gameState._gomokuCleanup) gameState._gomokuCleanup();
    if (origStopCleanup) origStopCleanup();
  };

  // 落子逻辑
  function gomokuPlaceStone(x, y) {
    const g = gameState.gomoku;
    if (g.winner !== 0) return;
    if (g.board[y][x] !== 0) {
      g.message = '此处已有棋子！';
      g.messageTimer = 60;
      return;
    }

    g.board[y][x] = g.currentPlayer;
    g.lastMoveX = x;
    g.lastMoveY = y;
    g.moveHistory.push({ x, y, player: g.currentPlayer });

    // 检查胜负
    const winResult = checkWin(x, y, g.currentPlayer);
    if (winResult) {
      g.winner = g.currentPlayer;
      g.winLine = winResult;
      g.message = g.currentPlayer === 1 ? '黑方获胜！' : '白方获胜！';
      g.messageTimer = 999;
      return;
    }

    // 检查平局
    if (g.moveHistory.length >= BOARD_SIZE * BOARD_SIZE) {
      g.winner = 3;
      g.message = '平局！';
      g.messageTimer = 999;
      return;
    }

    // 切换玩家
    g.currentPlayer = g.currentPlayer === 1 ? 2 : 1;

    // PVE 模式下 AI 落子
    if (g.mode === 'pve' && g.currentPlayer === 2 && g.winner === 0) {
      g.aiThinking = true;
      g.message = 'AI 思考中...';
      g.messageTimer = 60;
      setTimeout(() => {
        aiMove();
        g.aiThinking = false;
      }, 300 + Math.random() * 400);
    }
  }

  // 暴露落子函数供串口调用
  window._gomokuPlaceStone = gomokuPlaceStone;

  // 胜负检查
  function checkWin(x, y, player) {
    const g = gameState.gomoku;
    const directions = [
      [1, 0],  // 水平
      [0, 1],  // 垂直
      [1, 1],  // 右斜
      [1, -1], // 左斜
    ];

    for (const [dx, dy] of directions) {
      const line = [{ x, y }];
      // 正方向
      for (let i = 1; i < 5; i++) {
        const nx = x + dx * i, ny = y + dy * i;
        if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
        if (g.board[ny][nx] !== player) break;
        line.push({ x: nx, y: ny });
      }
      // 反方向
      for (let i = 1; i < 5; i++) {
        const nx = x - dx * i, ny = y - dy * i;
        if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) break;
        if (g.board[ny][nx] !== player) break;
        line.push({ x: nx, y: ny });
      }
      if (line.length >= 5) return line;
    }
    return null;
  }

  // ========== AI 算法（权重评估） ==========
  function aiMove() {
    const g = gameState.gomoku;
    const ai = 2; // AI 执白
    const human = 1;
    let bestScore = -Infinity;
    let bestMoves = [];

    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        if (g.board[y][x] !== 0) continue;
        // 只考虑周围有棋子的位置（优化范围）
        if (!hasNeighbor(x, y, 2)) continue;

        const attackScore = evaluatePosition(x, y, ai);
        const defenseScore = evaluatePosition(x, y, human);
        const score = attackScore + defenseScore * 0.9;

        if (score > bestScore) {
          bestScore = score;
          bestMoves = [{ x, y }];
        } else if (score === bestScore) {
          bestMoves.push({ x, y });
        }
      }
    }

    // 如果没有邻居范围内的位置，找任意空位
    if (bestMoves.length === 0) {
      for (let y = 0; y < BOARD_SIZE; y++) {
        for (let x = 0; x < BOARD_SIZE; x++) {
          if (g.board[y][x] === 0) {
            bestMoves.push({ x, y });
            break;
          }
        }
        if (bestMoves.length > 0) break;
      }
    }

    if (bestMoves.length > 0) {
      const move = bestMoves[Math.floor(Math.random() * bestMoves.length)];
      gomokuPlaceStone(move.x, move.y);
    }
  }

  // 检查某位置附近是否有棋子
  function hasNeighbor(x, y, range) {
    const g = gameState.gomoku;
    for (let dy = -range; dy <= range; dy++) {
      for (let dx = -range; dx <= range; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < BOARD_SIZE && ny >= 0 && ny < BOARD_SIZE) {
          if (g.board[ny][nx] !== 0) return true;
        }
      }
    }
    return false;
  }

  // 评估某个位置对某个玩家的价值
  function evaluatePosition(x, y, player) {
    const g = gameState.gomoku;
    const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
    let totalScore = 0;

    for (const [dx, dy] of directions) {
      let count = 1; // 包括落子点本身
      let openEnds = 0;
      let blocked = 0;

      // 正方向
      let pos = 1;
      while (pos < 5) {
        const nx = x + dx * pos, ny = y + dy * pos;
        if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) { blocked++; break; }
        if (g.board[ny][nx] === player) { count++; pos++; }
        else if (g.board[ny][nx] === 0) { openEnds++; break; }
        else { blocked++; break; }
      }
      if (pos >= 5 && blocked === 0 && openEnds === 0) {} // 到边界

      // 反方向
      pos = 1;
      while (pos < 5) {
        const nx = x - dx * pos, ny = y - dy * pos;
        if (nx < 0 || nx >= BOARD_SIZE || ny < 0 || ny >= BOARD_SIZE) { blocked++; break; }
        if (g.board[ny][nx] === player) { count++; pos++; }
        else if (g.board[ny][nx] === 0) { openEnds++; break; }
        else { blocked++; break; }
      }

      // 权重评分
      totalScore += getPatternScore(count, openEnds, blocked);
    }
    return totalScore;
  }

  // 模式评分
  function getPatternScore(count, openEnds, blocked) {
    if (count >= 5) return 100000; // 五连
    if (blocked >= 2) return 0;    // 两端封死

    if (count === 4) {
      if (openEnds === 2) return 50000;  // 活四
      if (openEnds === 1) return 8000;   // 冲四
    }
    if (count === 3) {
      if (openEnds === 2) return 4000;   // 活三
      if (openEnds === 1) return 800;    // 眠三
    }
    if (count === 2) {
      if (openEnds === 2) return 400;    // 活二
      if (openEnds === 1) return 80;     // 眠二
    }
    if (count === 1) {
      if (openEnds === 2) return 20;     // 活一
      if (openEnds === 1) return 5;
    }
    return 0;
  }

  // 绘制函数
  function draw() {
    const g = gameState.gomoku;
    if (!g) return;
    g.frame++;

    // 背景
    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, W, H);

    if (g.mode === 'menu') {
      drawMenu();
      return;
    }

    drawBoard();
    drawStones();
    drawCursor();
    drawUI();

    if (g.winner !== 0) {
      drawWinOverlay();
    }
  }

  // 绘制模式选择菜单
  function drawMenu() {
    const g = gameState.gomoku;
    // 背景装饰
    ctx.globalAlpha = 0.04;
    for (let i = 0; i < 15; i++) {
      for (let j = 0; j < 15; j++) {
        const cx = 100 + i * 28;
        const cy = 60 + j * 28;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx - 4, cy);
        ctx.lineTo(cx + 4, cy);
        ctx.moveTo(cx, cy - 4);
        ctx.lineTo(cx, cy + 4);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // 标题
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 48px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('五 子 棋', W / 2, 130);

    // 副标题
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '16px sans-serif';
    ctx.fillText('Gomoku · 星瀚手柄控制', W / 2, 165);

    // 棋子装饰
    ctx.shadowColor = 'rgba(255,255,255,0.3)';
    ctx.shadowBlur = 15;
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath();
    ctx.arc(W / 2 - 70, 210, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#eee';
    ctx.beginPath();
    ctx.arc(W / 2 + 70, 210, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 模式选项
    const options = [
      { label: '⚔️  人机对战 (PVE)', desc: '控制器/方向键移动 · BTN/回车落子 · AI对手' },
      { label: '👥  双人对战 (PVP)', desc: '玩家1: 控制器/方向键  ·  玩家2: WASD+空格' },
    ];

    const startY = 270;
    options.forEach((opt, i) => {
      const y = startY + i * 80;
      const isSelected = g.menuIndex === i;
      const hoverScale = isSelected ? 1 : 0.95;

      // 选项背景
      const boxW = 380;
      const boxH = 60;
      const boxX = W / 2 - boxW / 2;

      if (isSelected) {
        ctx.fillStyle = 'rgba(34, 211, 238, 0.08)';
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.4)';
        ctx.shadowColor = 'rgba(34, 211, 238, 0.2)';
        ctx.shadowBlur = 10;
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.shadowBlur = 0;
      }

      // 圆角矩形
      const r = 12;
      ctx.beginPath();
      ctx.moveTo(boxX + r, y);
      ctx.lineTo(boxX + boxW - r, y);
      ctx.arcTo(boxX + boxW, y, boxX + boxW, y + r, r);
      ctx.lineTo(boxX + boxW, y + boxH - r);
      ctx.arcTo(boxX + boxW, y + boxH, boxX + boxW - r, y + boxH, r);
      ctx.lineTo(boxX + r, y + boxH);
      ctx.arcTo(boxX, y + boxH, boxX, y + boxH - r, r);
      ctx.lineTo(boxX, y + r);
      ctx.arcTo(boxX, y, boxX + r, y, r);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 选中指示器
      if (isSelected) {
        ctx.fillStyle = '#22d3ee';
        ctx.beginPath();
        ctx.moveTo(boxX + 15, y + boxH / 2 - 6);
        ctx.lineTo(boxX + 23, y + boxH / 2);
        ctx.lineTo(boxX + 15, y + boxH / 2 + 6);
        ctx.fill();
      }

      // 文字
      ctx.fillStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.6)';
      ctx.font = `${isSelected ? 'bold ' : ''}18px sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(opt.label, W / 2, y + 26);

      ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.25)';
      ctx.font = '12px sans-serif';
      ctx.fillText(opt.desc, W / 2, y + 48);
    });

    // 操作提示
    const blink = Math.sin(g.frame * 0.06) * 0.3 + 0.4;
    ctx.fillStyle = `rgba(255,255,255,${blink})`;
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('↑ ↓ 选择模式  ·  回车/空格/BTN 确认', W / 2, 470);

    // 菜单页串口连接状态
    const controllerConnected = serialPorts.port1.isConnected;
    ctx.font = '12px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = controllerConnected ? '#22d3ee' : 'rgba(255,255,255,0.25)';
    ctx.fillText(`控制器: ${controllerConnected ? '已连接' : '未连接'}`, W / 2, H - 30);
  }

  // 绘制棋盘
  function drawBoard() {
    // 棋盘底色
    ctx.fillStyle = '#1a1a2e';
    ctx.shadowColor = 'rgba(26,26,46,0.6)';
    ctx.shadowBlur = 20;
    const pad = CELL_SIZE * 0.6;
    ctx.fillRect(OFFSET_X - pad, OFFSET_Y - pad, BOARD_W + pad * 2, BOARD_H + pad * 2);
    ctx.shadowBlur = 0;

    // 棋盘边框
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 2;
    ctx.strokeRect(OFFSET_X - pad, OFFSET_Y - pad, BOARD_W + pad * 2, BOARD_H + pad * 2);

    // 网格线
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    for (let i = 0; i < BOARD_SIZE; i++) {
      // 横线
      ctx.beginPath();
      ctx.moveTo(OFFSET_X, OFFSET_Y + i * CELL_SIZE);
      ctx.lineTo(OFFSET_X + BOARD_W, OFFSET_Y + i * CELL_SIZE);
      ctx.stroke();
      // 竖线
      ctx.beginPath();
      ctx.moveTo(OFFSET_X + i * CELL_SIZE, OFFSET_Y);
      ctx.lineTo(OFFSET_X + i * CELL_SIZE, OFFSET_Y + BOARD_H);
      ctx.stroke();
    }

    // 星位（天元 + 四角星位）
    const starPoints = [
      [7, 7],
      [3, 3], [3, 11], [11, 3], [11, 11],
    ];
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    for (const [sx, sy] of starPoints) {
      ctx.beginPath();
      ctx.arc(OFFSET_X + sx * CELL_SIZE, OFFSET_Y + sy * CELL_SIZE, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 坐标标注
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    for (let i = 0; i < BOARD_SIZE; i++) {
      // 列号 A-O
      ctx.fillText(String.fromCharCode(65 + i), OFFSET_X + i * CELL_SIZE, OFFSET_Y - pad + 10);
      // 行号 1-15
      ctx.textAlign = 'right';
      ctx.fillText(String(i + 1), OFFSET_X - pad + 14, OFFSET_Y + i * CELL_SIZE + 4);
      ctx.textAlign = 'center';
    }
  }

  // 绘制棋子
  function drawStones() {
    const g = gameState.gomoku;
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        if (g.board[y][x] === 0) continue;
        const cx = OFFSET_X + x * CELL_SIZE;
        const cy = OFFSET_Y + y * CELL_SIZE;
        const r = CELL_SIZE * 0.42;

        if (g.board[y][x] === 1) {
          // 黑子
          const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
          grad.addColorStop(0, '#4a4a5a');
          grad.addColorStop(0.7, '#1a1a2e');
          grad.addColorStop(1, '#0a0a15');
          ctx.fillStyle = grad;
          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 6;
          ctx.shadowOffsetX = 2;
          ctx.shadowOffsetY = 2;
        } else {
          // 白子
          const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
          grad.addColorStop(0, '#ffffff');
          grad.addColorStop(0.7, '#e0e0e8');
          grad.addColorStop(1, '#c0c0d0');
          ctx.fillStyle = grad;
          ctx.shadowColor = 'rgba(0,0,0,0.3)';
          ctx.shadowBlur = 5;
          ctx.shadowOffsetX = 2;
          ctx.shadowOffsetY = 2;
        }

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        // 最后一手标记
        if (x === g.lastMoveX && y === g.lastMoveY) {
          ctx.fillStyle = g.board[y][x] === 1 ? '#22d3ee' : '#f87171';
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 胜利连线高亮
    if (g.winner === 1 || g.winner === 2) {
      const alpha = 0.4 + Math.sin(g.frame * 0.1) * 0.3;
      ctx.strokeStyle = g.winner === 1 ? `rgba(34,211,238,${alpha})` : `rgba(248,113,113,${alpha})`;
      ctx.lineWidth = 4;
      ctx.shadowColor = g.winner === 1 ? 'rgba(34,211,238,0.6)' : 'rgba(248,113,113,0.6)';
      ctx.shadowBlur = 12;

      if (g.winLine.length >= 2) {
        // 排序胜利线
        const sorted = [...g.winLine].sort((a, b) => a.x - b.x || a.y - b.y);
        const first = sorted[0];
        const last = sorted[sorted.length - 1];
        ctx.beginPath();
        ctx.moveTo(OFFSET_X + first.x * CELL_SIZE, OFFSET_Y + first.y * CELL_SIZE);
        ctx.lineTo(OFFSET_X + last.x * CELL_SIZE, OFFSET_Y + last.y * CELL_SIZE);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }
  }

  // 绘制光标
  function drawCursor() {
    const g = gameState.gomoku;
    if (g.winner !== 0) return;

    const blink = Math.sin(g.frame * 0.12) * 0.4 + 0.6;

    // 玩家1光标（当前操作方为玩家1时 或 PVE模式）
    if (g.currentPlayer === 1 || g.mode === 'pve') {
      const cx = OFFSET_X + g.cursorX * CELL_SIZE;
      const cy = OFFSET_Y + g.cursorY * CELL_SIZE;
      const s = CELL_SIZE * 0.45;

      ctx.strokeStyle = `rgba(34, 211, 238, ${g.currentPlayer === 1 ? blink : 0.2})`;
      ctx.lineWidth = 2.5;

      // 四角边框
      const cornerLen = s * 0.4;
      // 左上
      ctx.beginPath();
      ctx.moveTo(cx - s, cy - s + cornerLen);
      ctx.lineTo(cx - s, cy - s);
      ctx.lineTo(cx - s + cornerLen, cy - s);
      ctx.stroke();
      // 右上
      ctx.beginPath();
      ctx.moveTo(cx + s - cornerLen, cy - s);
      ctx.lineTo(cx + s, cy - s);
      ctx.lineTo(cx + s, cy - s + cornerLen);
      ctx.stroke();
      // 左下
      ctx.beginPath();
      ctx.moveTo(cx - s, cy + s - cornerLen);
      ctx.lineTo(cx - s, cy + s);
      ctx.lineTo(cx - s + cornerLen, cy + s);
      ctx.stroke();
      // 右下
      ctx.beginPath();
      ctx.moveTo(cx + s - cornerLen, cy + s);
      ctx.lineTo(cx + s, cy + s);
      ctx.lineTo(cx + s, cy + s - cornerLen);
      ctx.stroke();
    }

    // PVP 模式下玩家2光标
    if (g.mode === 'pvp') {
      const cx2 = OFFSET_X + g.cursor2X * CELL_SIZE;
      const cy2 = OFFSET_Y + g.cursor2Y * CELL_SIZE;
      const s2 = CELL_SIZE * 0.45;

      ctx.strokeStyle = `rgba(248, 113, 113, ${g.currentPlayer === 2 ? blink : 0.2})`;
      ctx.lineWidth = 2.5;

      const cornerLen2 = s2 * 0.4;
      ctx.beginPath();
      ctx.moveTo(cx2 - s2, cy2 - s2 + cornerLen2);
      ctx.lineTo(cx2 - s2, cy2 - s2);
      ctx.lineTo(cx2 - s2 + cornerLen2, cy2 - s2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx2 + s2 - cornerLen2, cy2 - s2);
      ctx.lineTo(cx2 + s2, cy2 - s2);
      ctx.lineTo(cx2 + s2, cy2 - s2 + cornerLen2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx2 - s2, cy2 + s2 - cornerLen2);
      ctx.lineTo(cx2 - s2, cy2 + s2);
      ctx.lineTo(cx2 - s2 + cornerLen2, cy2 + s2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx2 + s2 - cornerLen2, cy2 + s2);
      ctx.lineTo(cx2 + s2, cy2 + s2);
      ctx.lineTo(cx2 + s2, cy2 + s2 - cornerLen2);
      ctx.stroke();
    }
  }

  // 绘制 UI 信息
  function drawUI() {
    const g = gameState.gomoku;

    // 左侧信息面板
    const panelX = 15;
    const panelY = 50;

    // 游戏模式
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(g.mode === 'pve' ? '人机对战' : '双人对战', panelX, panelY);

    // 当前回合
    const turnY = panelY + 35;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText('当前回合', panelX, turnY);

    // 回合棋子指示
    const indicatorY = turnY + 25;
    const indicatorR = 10;
    if (g.currentPlayer === 1) {
      ctx.fillStyle = '#1a1a2e';
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    } else {
      ctx.fillStyle = '#e0e0e8';
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    }
    ctx.beginPath();
    ctx.arc(panelX + indicatorR, indicatorY, indicatorR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = g.currentPlayer === 1 ? '#22d3ee' : '#f472b6';
    ctx.font = '13px sans-serif';
    ctx.fillText(
      g.currentPlayer === 1 ? (g.mode === 'pve' ? '黑 (你)' : '黑 (控制器)') : (g.mode === 'pve' ? '白 (AI)' : '白 (键盘)'),
      panelX + indicatorR * 2 + 8, indicatorY + 4
    );

    // 步数
    const stepsY = indicatorY + 35;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '12px sans-serif';
    ctx.fillText(`第 ${g.moveHistory.length} 手`, panelX, stepsY);

    // 操作提示
    const hintY = H - 70;
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    if (g.mode === 'pve') {
      ctx.fillText('🎮 控制器/方向键: 移动', panelX, hintY);
      ctx.fillText('⏎ BTN/回车: 落子', panelX, hintY + 16);
    } else {
      ctx.fillText('玩家1: 控制器/方向键 + BTN/回车', panelX, hintY);
      ctx.fillText('玩家2: WASD + 空格', panelX, hintY + 16);
    }

    // 消息提示
    if (g.messageTimer > 0) {
      g.messageTimer--;
      const msgAlpha = Math.min(1, g.messageTimer / 30);
      ctx.fillStyle = `rgba(251, 191, 36, ${msgAlpha})`;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(g.message, OFFSET_X + BOARD_W / 2, OFFSET_Y - CELL_SIZE * 0.6 - 8);
    }

    // 调试面板已隐藏（数据仍在 window._serialDebug 中，需要时可在控制台查看）
  }

  // 胜利覆盖层
  function drawWinOverlay() {
    const g = gameState.gomoku;

    // 半透明遮罩
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, W, H);

    // 胜利文字
    ctx.textAlign = 'center';
    if (g.winner === 3) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 36px sans-serif';
      ctx.fillText('平局！', W / 2, H / 2 - 20);
    } else {
      const winColor = g.winner === 1 ? '#22d3ee' : '#f472b6';
      ctx.fillStyle = winColor;
      ctx.shadowColor = winColor;
      ctx.shadowBlur = 20;
      ctx.font = 'bold 42px sans-serif';
      const winText = g.winner === 1 ? '黑方获胜！' : '白方获胜！';
      ctx.fillText(winText, W / 2, H / 2 - 20);
      ctx.shadowBlur = 0;

      if (g.mode === 'pve') {
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '18px sans-serif';
        ctx.fillText(g.winner === 1 ? '恭喜你赢了！' : 'AI 获胜，再接再厉！', W / 2, H / 2 + 15);
      }
    }

    // 重新开始提示
    const blink = Math.sin(gameState.gomoku.frame * 0.06) * 0.3 + 0.4;
    ctx.fillStyle = `rgba(255,255,255,${blink})`;
    ctx.font = '15px sans-serif';
    ctx.fillText('按 R 键重新开始', W / 2, H / 2 + 55);
  }

  // 游戏循环
  function loop() {
    if (gameState.gomoku) {
      draw();
    }
    gameAnimationId = requestAnimationFrame(loop);
  }
  loop();
}

// 五子棋串口方向控制（单控制器输入，键盘仍可作为二号玩家）
// source: 'port1' = 单控制器；玩家2仍通过键盘控制。
function gomokuHandleDirection(dir, source) {
  const g = gameState.gomoku;
  if (!g) { _dbgLog(`gomokuDir: BLOCKED - g is null`); return; }
  if (g.winner !== 0) { _dbgLog(`gomokuDir: BLOCKED - winner=${g.winner}`); return; }
  if (g.aiThinking) { _dbgLog(`gomokuDir: BLOCKED - aiThinking`); return; }

  // CENTER 事件忽略，不消耗节流配额（设备空闲时可能频繁发送 CENTER）
  if (dir === 'CENTER') return;

  const now = Date.now();
  // 为每个端口独立节流（仅对方向移动事件节流）
  if (!g._lastSerialMoveByPort) g._lastSerialMoveByPort = {};
  const lastMove = g._lastSerialMoveByPort[source] || 0;
  if (now - lastMove < 120) { _dbgLog(`gomokuDir: THROTTLED source=${source} elapsed=${now - lastMove}ms`); return; }
  g._lastSerialMoveByPort[source] = now;

  _dbgLog(`gomokuDir: dir=${dir} source=${source} mode=${g.mode}`);

  if (g.mode === 'menu') {
    if (dir === 'UP' || dir === 'DOWN') {
      g.menuIndex = (g.menuIndex + 1) % 2;
      _dbgLog(`gomokuDir: menu → menuIndex=${g.menuIndex}`);
    }
    return;
  }

  // PVE 模式：port1 控制玩家光标
  if (g.mode === 'pve') {
    if (source === 'port1') {
      const oldX = g.cursorX, oldY = g.cursorY;
      if (dir === 'UP') g.cursorY = Math.max(0, g.cursorY - 1);
      if (dir === 'DOWN') g.cursorY = Math.min(14, g.cursorY + 1);
      if (dir === 'LEFT') g.cursorX = Math.max(0, g.cursorX - 1);
      if (dir === 'RIGHT') g.cursorX = Math.min(14, g.cursorX + 1);
      _dbgLog(`gomokuDir: PVE P1 cursor (${oldX},${oldY})→(${g.cursorX},${g.cursorY})`);
    } else {
      _dbgLog(`gomokuDir: PVE source=${source} IGNORED (only port1 in PVE)`);
    }
    return;
  }

  // PVP 模式：控制器控制玩家1(黑)，玩家2(白)使用键盘。
  // 双方可以随时移动自己的光标，不受回合限制
  if (g.mode === 'pvp') {
    if (source === 'port1') {
      const oldX = g.cursorX, oldY = g.cursorY;
      if (dir === 'UP') g.cursorY = Math.max(0, g.cursorY - 1);
      if (dir === 'DOWN') g.cursorY = Math.min(14, g.cursorY + 1);
      if (dir === 'LEFT') g.cursorX = Math.max(0, g.cursorX - 1);
      if (dir === 'RIGHT') g.cursorX = Math.min(14, g.cursorX + 1);
      _dbgLog(`gomokuDir: PVP P1 cursor (${oldX},${oldY})→(${g.cursorX},${g.cursorY})`);
    } else if (source === 'port2') {
      const oldX = g.cursor2X, oldY = g.cursor2Y;
      if (dir === 'UP') g.cursor2Y = Math.max(0, g.cursor2Y - 1);
      if (dir === 'DOWN') g.cursor2Y = Math.min(14, g.cursor2Y + 1);
      if (dir === 'LEFT') g.cursor2X = Math.max(0, g.cursor2X - 1);
      if (dir === 'RIGHT') g.cursor2X = Math.min(14, g.cursor2X + 1);
      _dbgLog(`gomokuDir: PVP P2 cursor2 (${oldX},${oldY})→(${g.cursor2X},${g.cursor2Y})`);
    } else {
      _dbgLog(`gomokuDir: PVP source="${source}" NOT port1 OR port2 - DROPPED!`);
    }
  } else {
    _dbgLog(`gomokuDir: mode="${g.mode}" - no handler!`);
  }
}

// 五子棋串口落子控制（单控制器输入，键盘仍可作为二号玩家）
function gomokuHandlePlace(source) {
  const g = gameState.gomoku;
  if (!g) { _dbgLog(`gomokuPlace: BLOCKED - g is null`); return; }
  if (g.aiThinking) { _dbgLog(`gomokuPlace: BLOCKED - aiThinking`); return; }

  _dbgLog(`gomokuPlace: source=${source} mode=${g.mode} currentPlayer=${g.currentPlayer} winner=${g.winner}`);

  // 菜单模式：任何端口都可以选择
  if (g.mode === 'menu') {
    g.mode = g.menuIndex === 0 ? 'pve' : 'pvp';
    g.currentPlayer = 1;
    if (g.mode === 'pvp') {
      g.message = '双人对战 - 黑方(控制器) vs 白方(键盘)';
    } else {
      g.message = '人机对战 - 你执黑先行';
    }
    g.messageTimer = 120;
    _dbgLog(`gomokuPlace: menu → selected ${g.mode}`);
    return;
  }

  // 游戏结束：任何端口按键重新开始
  if (g.winner !== 0) {
    _dbgLog(`gomokuPlace: winner=${g.winner} → restart`);
    startGomoku();
    return;
  }

  // PVE 模式：port1 落子
  if (g.mode === 'pve') {
    if (source === 'port1') {
      _dbgLog(`gomokuPlace: PVE port1 → placeStone(${g.cursorX},${g.cursorY})`);
      if (window._gomokuPlaceStone) {
        window._gomokuPlaceStone(g.cursorX, g.cursorY);
      }
    } else {
      _dbgLog(`gomokuPlace: PVE source=${source} IGNORED (only port1 in PVE)`);
    }
    return;
  }

  // PVP 模式：严格按端口区分玩家
  // port1 = 玩家1(黑) 只能在自己回合落子
  // port2 = 玩家2(白) 只能在自己回合落子
  if (g.mode === 'pvp') {
    if (source === 'port1' && g.currentPlayer === 1) {
      _dbgLog(`gomokuPlace: PVP port1 turn=1 ✅ → placeStone(${g.cursorX},${g.cursorY})`);
      if (window._gomokuPlaceStone) {
        window._gomokuPlaceStone(g.cursorX, g.cursorY);
      }
    } else if (source === 'port2' && g.currentPlayer === 2) {
      _dbgLog(`gomokuPlace: PVP port2 turn=2 ✅ → placeStone(${g.cursor2X},${g.cursor2Y})`);
      if (window._gomokuPlaceStone) {
        window._gomokuPlaceStone(g.cursor2X, g.cursor2Y);
      }
    } else {
      // 非当前回合的玩家按下按键，给出提示
      _dbgLog(`gomokuPlace: PVP source=${source} currentPlayer=${g.currentPlayer} ❌ NOT YOUR TURN`);
      if ((source === 'port1' && g.currentPlayer === 2) || (source === 'port2' && g.currentPlayer === 1)) {
        g.message = g.currentPlayer === 1 ? '当前是黑方回合' : '当前是白方回合';
        g.messageTimer = 40;
      }
    }
  }
}

// ========== 90坦克大战 (Battle City Clone) ==========
function startTankBattle() {
  const W = gameCanvas.width, H = gameCanvas.height;
  const ctx = gameCtx;

  // ===== 常量 =====
  const TILE_SIZE = 16;        // 每个子块像素（26x26 地图 = 416px）
  const MAP_COLS = 26;         // 地图列数（13格 x 2子块）
  const MAP_ROWS = 26;         // 地图行数（13格 x 2子块）
  const MAP_PX_W = MAP_COLS * TILE_SIZE; // 416
  const MAP_PX_H = MAP_ROWS * TILE_SIZE; // 416
  const OFFSET_X = Math.floor((W - MAP_PX_W) / 2);
  const OFFSET_Y = Math.floor((H - MAP_PX_H) / 2) + 10;
  const TANK_SIZE = TILE_SIZE * 2; // 坦克占 2x2 子块 = 32px

  // Tile 类型
  const T = { EMPTY: 0, BRICK: 1, STEEL: 2, WATER: 3, FOREST: 4, ICE: 5, HOME: 6, HOME_DEAD: 7 };

  // 方向
  const DIR = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3 };
  const DIR_DX = [0, 0, -1, 1];
  const DIR_DY = [-1, 1, 0, 0];

  // 敌人类型
  const ENEMY_TYPES = [
    { name: 'basic',   color: '#aaa', speed: 1, hp: 1, bulletSpeed: 3, score: 100 },
    { name: 'fast',    color: '#88f', speed: 2, hp: 1, bulletSpeed: 3, score: 200 },
    { name: 'power',   color: '#8f8', speed: 1, hp: 1, bulletSpeed: 5, score: 300 },
    { name: 'armor',   color: '#ff8', speed: 1, hp: 4, bulletSpeed: 3, score: 400 },
  ];

  // 玩家升级系统：0=初始, 1=加速弹, 2=连发弹, 3=破钢弹
  const PLAYER_LEVELS = [
    { bulletSpeed: 4, maxBullets: 1, canBreakSteel: false, bulletPower: 1 },
    { bulletSpeed: 6, maxBullets: 1, canBreakSteel: false, bulletPower: 1 },
    { bulletSpeed: 6, maxBullets: 2, canBreakSteel: false, bulletPower: 1 },
    { bulletSpeed: 6, maxBullets: 2, canBreakSteel: true,  bulletPower: 2 },
  ];

  // 道具类型
  const POWERUP_TYPES = ['star', 'grenade', 'clock', 'helmet', 'shovel', 'life'];

  // ===== 经典关卡数据 =====
  // 每关是 13x13 格子，每格子用一个数字表示：0=空, 1=砖, 2=钢, 3=水, 4=草, 5=冰
  // 底部中间两格始终是老鹰基地（自动添加）
  const LEVELS = [
    // 关卡1
    [
      [0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,1,0,1,0,1,0,1,0,1,0,1,0],
      [0,1,0,1,0,1,0,1,0,1,0,1,0],
      [0,1,0,1,0,1,1,1,0,1,0,1,0],
      [0,1,0,1,0,0,0,0,0,1,0,1,0],
      [0,0,0,0,0,1,0,1,0,0,0,0,0],
      [0,0,0,0,0,1,0,1,0,0,0,0,0],
      [0,1,0,1,0,0,0,0,0,1,0,1,0],
      [0,1,0,1,0,1,0,1,0,1,0,1,0],
      [0,1,0,1,0,1,0,1,0,1,0,1,0],
      [0,1,0,1,0,1,0,1,0,1,0,1,0],
      [0,0,0,0,0,0,1,0,0,0,0,0,0],
      [0,0,0,0,0,1,0,1,0,0,0,0,0],
    ],
    // 关卡2
    [
      [0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,2,0,1,1,0,0,0,1,1,0,2,0],
      [0,0,0,1,1,0,0,0,1,1,0,0,0],
      [0,1,0,0,0,0,1,0,0,0,0,1,0],
      [0,1,0,0,2,0,1,0,2,0,0,1,0],
      [0,1,0,0,0,0,0,0,0,0,0,1,0],
      [3,3,0,1,0,0,0,0,0,1,0,3,3],
      [0,0,0,1,0,0,0,0,0,1,0,0,0],
      [0,1,1,1,0,0,1,0,0,1,1,1,0],
      [0,0,0,0,0,0,1,0,0,0,0,0,0],
      [0,1,0,1,0,1,1,1,0,1,0,1,0],
      [0,1,0,0,0,0,1,0,0,0,0,0,0],
      [0,0,0,0,0,1,0,1,0,0,0,0,0],
    ],
    // 关卡3
    [
      [0,0,0,0,0,0,0,0,0,0,0,0,0],
      [1,0,1,0,1,0,2,0,1,0,1,0,1],
      [1,0,1,0,1,0,0,0,1,0,1,0,1],
      [0,0,0,0,0,0,1,0,0,0,0,0,0],
      [0,1,1,0,2,0,1,0,2,0,1,1,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,2,0,1,1,0,1,1,0,2,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,1,1,0,2,0,1,0,2,0,1,1,0],
      [0,0,0,0,0,0,1,0,0,0,0,0,0],
      [1,0,1,0,1,0,0,0,1,0,1,0,1],
      [1,0,1,0,0,0,1,0,0,0,1,0,0],
      [0,0,0,0,0,1,0,1,0,0,0,0,0],
    ],
  ];

  // ===== 地图初始化 =====
  function buildMap(levelIndex) {
    const lvl = LEVELS[levelIndex % LEVELS.length];
    const map = Array.from({ length: MAP_ROWS }, () => Array(MAP_COLS).fill(T.EMPTY));

    // 填充 13x13 → 26x26（每格占 2x2 子块）
    for (let gy = 0; gy < 13; gy++) {
      for (let gx = 0; gx < 13; gx++) {
        const tile = lvl[gy][gx];
        const mx = gx * 2;
        const my = gy * 2;
        map[my][mx] = tile;
        map[my][mx + 1] = tile;
        map[my + 1][mx] = tile;
        map[my + 1][mx + 1] = tile;
      }
    }

    // 老鹰基地（底部中间）- 占 2x2
    map[24][12] = T.HOME;
    map[24][13] = T.HOME;
    map[25][12] = T.HOME;
    map[25][13] = T.HOME;

    // 老鹰基地周围砖墙保护
    // 上方
    map[23][11] = T.BRICK; map[23][12] = T.BRICK; map[23][13] = T.BRICK; map[23][14] = T.BRICK;
    // 两侧
    map[24][11] = T.BRICK; map[25][11] = T.BRICK;
    map[24][14] = T.BRICK; map[25][14] = T.BRICK;

    return map;
  }

  // ===== 游戏状态初始化 =====
  function initState(levelIndex, mode, preserveLives) {
    const map = buildMap(levelIndex);
    const p1Lives = preserveLives ? (gameState.tank ? gameState.tank.players[0].lives : 3) : 3;
    const p2Lives = preserveLives ? (gameState.tank ? gameState.tank.players[1].lives : 3) : 3;
    const p1Level = preserveLives ? (gameState.tank ? gameState.tank.players[0].level : 0) : 0;
    const p2Level = preserveLives ? (gameState.tank ? gameState.tank.players[1].level : 0) : 0;
    const p1Score = preserveLives ? (gameState.tank ? gameState.tank.players[0].score : 0) : 0;
    const p2Score = preserveLives ? (gameState.tank ? gameState.tank.players[1].score : 0) : 0;

    return {
      mode: mode, // 'menu', '1p', '2p'
      levelIndex: levelIndex,
      map: map,
      players: [
        createPlayer(0, 8 * TILE_SIZE, 24 * TILE_SIZE, '#FFD700', p1Lives, p1Level, p1Score), // P1 黄色
        createPlayer(1, 16 * TILE_SIZE, 24 * TILE_SIZE, '#00FF7F', p2Lives, p2Level, p2Score), // P2 绿色
      ],
      enemies: [],
      bullets: [],
      explosions: [],
      powerups: [],
      // 敌人生成
      enemySpawnPoints: [
        { x: 0, y: 0 },
        { x: 12 * TILE_SIZE * 2 / TILE_SIZE / 2 * TILE_SIZE, y: 0 }, // 居中 -> x=12*16=192? no
      ],
      enemiesKilled: 0,
      enemiesTotal: 20,
      enemySpawnTimer: 0,
      enemySpawnInterval: 180, // 3秒一个
      enemySpawnIndex: 0,
      maxEnemiesOnScreen: 4,
      // 红色闪烁坦克索引（每关的第4、11、18个）
      flashEnemyIndices: [3, 10, 17],
      enemySpawnCount: 0,
      // 冻结敌人
      freezeTimer: 0,
      // 铲子保护
      shovelTimer: 0,
      // 游戏状态
      gameOver: false,
      gameOverTimer: 0,
      victory: false,
      victoryTimer: 0,
      // 关卡过场
      stageTransition: true,
      stageTransitionTimer: 120,
      // 帧计数
      frame: 0,
      // 菜单
      menuIndex: 0,
      // 暂停
      paused: false,
      // 串口输入状态
      serialInput: {
        port1: { moving: false, direction: DIR.UP },
        port2: { moving: false, direction: DIR.UP },
      },
    };
  }

  function createPlayer(id, x, y, color, lives, level, score) {
    return {
      id: id,
      x: x, y: y,
      direction: DIR.UP,
      speed: 1.5,
      moving: false,
      color: color,
      lives: lives,
      level: level,
      score: score,
      alive: true,
      respawnTimer: 0,
      shieldTimer: 120, // 出生护盾
      stunTimer: 0,     // 友军误伤定身
      bullets: [],
      shootCooldown: 0,
    };
  }

  function createEnemy(type, x, y, isFlash) {
    const et = ENEMY_TYPES[type];
    return {
      type: type,
      x: x, y: y,
      direction: DIR.DOWN,
      speed: et.speed,
      moving: true,
      color: et.color,
      hp: et.hp,
      maxHp: et.hp,
      bulletSpeed: et.bulletSpeed,
      score: et.score,
      alive: true,
      isFlash: isFlash, // 红色闪烁 = 掉道具
      bullets: [],
      shootCooldown: 60 + Math.random() * 120,
      dirChangeTimer: 60 + Math.random() * 120,
      flashFrame: 0,
    };
  }

  // ===== 离屏地图缓存（性能关键：避免每帧重绘 676 个地砖） =====
  const mapCache = document.createElement('canvas');
  mapCache.width = MAP_PX_W;
  mapCache.height = MAP_PX_H;
  const mapCacheCtx = mapCache.getContext('2d');
  let mapCacheDirty = true; // 地图变化时标记为 dirty

  function renderMapCache(map) {
    mapCacheCtx.clearRect(0, 0, MAP_PX_W, MAP_PX_H);
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        const tile = map[r][c];
        if (tile === T.EMPTY || tile === T.FOREST || tile === T.WATER) continue;
        const px = c * TILE_SIZE;
        const py = r * TILE_SIZE;
        switch (tile) {
          case T.BRICK:
            mapCacheCtx.fillStyle = '#8B4513';
            mapCacheCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
            mapCacheCtx.fillStyle = '#A0522D';
            mapCacheCtx.fillRect(px, py, TILE_SIZE / 2 - 1, TILE_SIZE / 2 - 1);
            mapCacheCtx.fillRect(px + TILE_SIZE / 2, py + TILE_SIZE / 2, TILE_SIZE / 2 - 1, TILE_SIZE / 2 - 1);
            mapCacheCtx.fillStyle = '#5a2d0c';
            mapCacheCtx.fillRect(px, py, TILE_SIZE, 0.5);
            mapCacheCtx.fillRect(px, py, 0.5, TILE_SIZE);
            mapCacheCtx.fillRect(px, py + TILE_SIZE - 0.5, TILE_SIZE, 0.5);
            mapCacheCtx.fillRect(px + TILE_SIZE - 0.5, py, 0.5, TILE_SIZE);
            break;
          case T.STEEL:
            mapCacheCtx.fillStyle = '#C0C0C0';
            mapCacheCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
            mapCacheCtx.fillStyle = '#888';
            mapCacheCtx.fillRect(px + 1, py + 1, TILE_SIZE - 2, TILE_SIZE - 2);
            mapCacheCtx.fillStyle = '#aaa';
            mapCacheCtx.fillRect(px + 2, py + 2, TILE_SIZE / 2 - 2, TILE_SIZE / 2 - 2);
            mapCacheCtx.fillRect(px + TILE_SIZE / 2 + 1, py + TILE_SIZE / 2 + 1, TILE_SIZE / 2 - 3, TILE_SIZE / 2 - 3);
            break;
          case T.ICE:
            mapCacheCtx.fillStyle = '#d0e8f0';
            mapCacheCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
            mapCacheCtx.fillStyle = 'rgba(255,255,255,0.3)';
            mapCacheCtx.fillRect(px + 2, py + 2, 4, 4);
            break;
          case T.HOME:
            mapCacheCtx.fillStyle = '#fff';
            mapCacheCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
            mapCacheCtx.fillStyle = '#e44';
            mapCacheCtx.fillRect(px + 3, py + 3, TILE_SIZE - 6, TILE_SIZE - 6);
            mapCacheCtx.fillStyle = '#fff';
            mapCacheCtx.fillRect(px + 5, py + 5, 3, 3);
            break;
          case T.HOME_DEAD:
            mapCacheCtx.fillStyle = '#333';
            mapCacheCtx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
            mapCacheCtx.fillStyle = '#666';
            mapCacheCtx.fillRect(px + 2, py + TILE_SIZE - 6, TILE_SIZE - 4, 4);
            mapCacheCtx.strokeStyle = '#e44';
            mapCacheCtx.lineWidth = 2;
            mapCacheCtx.beginPath();
            mapCacheCtx.moveTo(px + 3, py + 3);
            mapCacheCtx.lineTo(px + TILE_SIZE - 3, py + TILE_SIZE - 3);
            mapCacheCtx.moveTo(px + TILE_SIZE - 3, py + 3);
            mapCacheCtx.lineTo(px + 3, py + TILE_SIZE - 3);
            mapCacheCtx.stroke();
            break;
        }
      }
    }
    mapCacheDirty = false;
  }

  // ===== 初始化菜单状态 =====
  gameState = {
    keys: gameState.keys || {},
    tank: initState(0, 'menu', false),
  };

  // ===== 键盘处理 =====
  document.removeEventListener('keydown', gameKeyHandler);
  document.removeEventListener('keyup', gameKeyUpHandler);

  const tankKeysDown = {};

  function tankKeyDown(e) {
    const t = gameState.tank;
    if (!t) return;
    tankKeysDown[e.key] = true;

    if (t.mode === 'menu') {
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
        e.preventDefault();
        t.menuIndex = (t.menuIndex + 2) % 3; // 3 options: 1P, 2P, level
      }
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        t.menuIndex = (t.menuIndex + 1) % 3;
      }
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        if (t.menuIndex === 2) {
          t.levelIndex = (t.levelIndex + LEVELS.length - 1) % LEVELS.length;
        }
      }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        if (t.menuIndex === 2) {
          t.levelIndex = (t.levelIndex + 1) % LEVELS.length;
        }
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (t.menuIndex === 0) {
          startLevel('1p', t.levelIndex);
        } else if (t.menuIndex === 1) {
          startLevel('2p', t.levelIndex);
        }
        // menuIndex===2 is level select, no action on enter
      }
      return;
    }

    // 游戏结束后按 R 重新开始
    if (t.gameOver || t.victory) {
      if (e.key === 'r' || e.key === 'R') {
        gameState.tank = initState(0, 'menu', false);
      }
      return;
    }

    // P 暂停
    if (e.key === 'p' || e.key === 'P') {
      t.paused = !t.paused;
      return;
    }

    e.preventDefault();

    // P1 射击
    if (e.key === ' ' || e.key === 'Enter') {
      playerShoot(0);
    }
    // P2 射击 (J键)
    if (e.key === 'j' || e.key === 'J') {
      playerShoot(1);
    }
  }

  function tankKeyUp(e) {
    tankKeysDown[e.key] = false;
  }

  document.addEventListener('keydown', tankKeyDown);
  document.addEventListener('keyup', tankKeyUp);

  gameState._jumpCleanup = () => {
    document.removeEventListener('keydown', tankKeyDown);
    document.removeEventListener('keyup', tankKeyUp);
  };

  // ===== 开始关卡 =====
  function startLevel(mode, levelIndex) {
    const t = gameState.tank;
    const newState = initState(levelIndex, mode, true);
    // 保留得分和生命
    if (t && t.mode !== 'menu') {
      newState.players[0].lives = t.players[0].lives;
      newState.players[0].level = t.players[0].level;
      newState.players[0].score = t.players[0].score;
      newState.players[1].lives = t.players[1].lives;
      newState.players[1].level = t.players[1].level;
      newState.players[1].score = t.players[1].score;
    }
    newState.players[0].alive = newState.players[0].lives > 0;
    newState.players[1].alive = mode === '2p' && newState.players[1].lives > 0;
    gameState.tank = newState;
    mapCacheDirty = true;
  }

  // ===== 射击 =====
  function playerShoot(playerId) {
    const t = gameState.tank;
    if (!t || t.mode === 'menu' || t.paused || t.gameOver || t.victory) return;
    if (playerId === 1 && t.mode !== '2p') return;

    const p = t.players[playerId];
    if (!p.alive || p.stunTimer > 0 || p.respawnTimer > 0) return;

    const lvl = PLAYER_LEVELS[p.level];
    // 计算当前子弹数（使用 for 循环代替 filter，减少 GC）
    let activeBullets = 0;
    for (let i = 0; i < t.bullets.length; i++) {
      if (t.bullets[i].ownerId === playerId && t.bullets[i].ownerType === 'player' && t.bullets[i].alive) activeBullets++;
    }
    if (activeBullets >= lvl.maxBullets) return;
    if (p.shootCooldown > 0) return;

    p.shootCooldown = 8;
    spawnBullet(p.x, p.y, p.direction, lvl.bulletSpeed, lvl.bulletPower, lvl.canBreakSteel, playerId, 'player');
  }

  function enemyShoot(enemy) {
    const t = gameState.tank;
    // 性能优化：用 for 循环替代 filter
    let activeBullets = 0;
    for (let i = 0; i < t.bullets.length; i++) {
      if (t.bullets[i].ownerId === enemy && t.bullets[i].alive) { activeBullets++; break; }
    }
    if (activeBullets >= 1) return;

    spawnBullet(enemy.x, enemy.y, enemy.direction, enemy.bulletSpeed, 1, false, enemy, 'enemy');
  }

  function spawnBullet(x, y, direction, speed, power, canBreakSteel, ownerId, ownerType) {
    const t = gameState.tank;
    const halfTank = TANK_SIZE / 2;
    const bx = x + halfTank + DIR_DX[direction] * halfTank;
    const by = y + halfTank + DIR_DY[direction] * halfTank;

    t.bullets.push({
      x: bx - 3, y: by - 3,
      w: 6, h: 6,
      direction: direction,
      speed: speed,
      power: power,
      canBreakSteel: canBreakSteel,
      ownerId: ownerId,
      ownerType: ownerType,
      alive: true,
    });
  }

  // ===== 碰撞检测辅助 =====
  function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
  }

  // 性能优化：复用 tile 结果数组，避免每帧大量 GC
  const _tileResultPool = [];
  for (let i = 0; i < 16; i++) _tileResultPool.push({ row: 0, col: 0, type: 0 });
  let _tileResultCount = 0;

  function getTilesInRect(x, y, w, h) {
    _tileResultCount = 0;
    const startCol = Math.max(0, Math.floor(x / TILE_SIZE));
    const endCol = Math.min(MAP_COLS - 1, Math.floor((x + w - 1) / TILE_SIZE));
    const startRow = Math.max(0, Math.floor(y / TILE_SIZE));
    const endRow = Math.min(MAP_ROWS - 1, Math.floor((y + h - 1) / TILE_SIZE));
    for (let r = startRow; r <= endRow; r++) {
      for (let c = startCol; c <= endCol; c++) {
        if (_tileResultCount >= _tileResultPool.length) {
          _tileResultPool.push({ row: 0, col: 0, type: 0 });
        }
        const t = _tileResultPool[_tileResultCount];
        t.row = r; t.col = c; t.type = gameState.tank.map[r][c];
        _tileResultCount++;
      }
    }
    return _tileResultCount; // 返回数量，调用方用 _tileResultPool[i] 访问
  }

  function canMoveTo(x, y, entity) {
    const t = gameState.tank;
    // 边界
    if (x < 0 || y < 0 || x + TANK_SIZE > MAP_PX_W || y + TANK_SIZE > MAP_PX_H) return false;

    // 地图碰撞（使用对象池，无 GC）
    const tileCount = getTilesInRect(x, y, TANK_SIZE, TANK_SIZE);
    for (let i = 0; i < tileCount; i++) {
      const tileType = _tileResultPool[i].type;
      if (tileType === T.BRICK || tileType === T.STEEL || tileType === T.WATER || tileType === T.HOME || tileType === T.HOME_DEAD) {
        return false;
      }
    }

    // 与其他坦克碰撞（不创建临时数组）
    for (let i = 0; i < t.players.length; i++) {
      const p = t.players[i];
      if (p === entity || !p.alive || p.respawnTimer > 0) continue;
      if (rectsOverlap(x, y, TANK_SIZE, TANK_SIZE, p.x, p.y, TANK_SIZE, TANK_SIZE)) return false;
    }
    for (let i = 0; i < t.enemies.length; i++) {
      const e = t.enemies[i];
      if (e === entity || !e.alive) continue;
      if (rectsOverlap(x, y, TANK_SIZE, TANK_SIZE, e.x, e.y, TANK_SIZE, TANK_SIZE)) return false;
    }

    return true;
  }

  // ===== 更新逻辑 =====
  function update() {
    const t = gameState.tank;
    if (!t || t.mode === 'menu') return;

    if (t.stageTransition) {
      t.stageTransitionTimer--;
      if (t.stageTransitionTimer <= 0) {
        t.stageTransition = false;
      }
      return;
    }

    if (t.paused) return;

    if (t.gameOver) {
      t.gameOverTimer++;
      return;
    }
    if (t.victory) {
      t.victoryTimer++;
      if (t.victoryTimer > 180) {
        // 下一关
        const nextLevel = t.levelIndex + 1;
        startLevel(t.mode, nextLevel);
      }
      return;
    }

    t.frame++;

    // 更新冻结计时
    if (t.freezeTimer > 0) t.freezeTimer--;
    // 更新铲子保护计时
    if (t.shovelTimer > 0) {
      t.shovelTimer--;
      if (t.shovelTimer === 0) {
        // 恢复基地砖墙
        restoreBaseWalls(T.BRICK);
      }
    }

    // 更新玩家
    updatePlayers();
    // 更新敌人
    updateEnemies();
    // 生成敌人
    spawnEnemy();
    // 更新子弹
    updateBullets();
    // 更新爆炸
    updateExplosions();
    // 更新道具
    updatePowerups();
    // 胜负检查
    checkWinLose();

    // 性能优化：每 60 帧清理一次已死亡的敌人对象（避免数组无限增长）
    if (t.frame % 60 === 0) {
      t.enemies = t.enemies.filter(e => e.alive);
    }
  }

  function updatePlayers() {
    const t = gameState.tank;
    const activeCount = t.mode === '2p' ? 2 : 1;

    for (let i = 0; i < activeCount; i++) {
      const p = t.players[i];

      // 重生计时
      if (p.respawnTimer > 0) {
        p.respawnTimer--;
        if (p.respawnTimer <= 0 && p.lives > 0) {
          // 重生
          p.alive = true;
          p.x = i === 0 ? 8 * TILE_SIZE : 16 * TILE_SIZE;
          p.y = 24 * TILE_SIZE;
          p.direction = DIR.UP;
          p.shieldTimer = 120;
          p.level = 0;
        }
        continue;
      }

      if (!p.alive) continue;

      // 护盾和定身倒计时
      if (p.shieldTimer > 0) p.shieldTimer--;
      if (p.stunTimer > 0) { p.stunTimer--; continue; }
      if (p.shootCooldown > 0) p.shootCooldown--;

      // 键盘输入 → 移动
      let wantMove = false;
      let wantDir = p.direction;

      if (i === 0) {
        // P1: 方向键
        if (tankKeysDown['ArrowUp']) { wantDir = DIR.UP; wantMove = true; }
        else if (tankKeysDown['ArrowDown']) { wantDir = DIR.DOWN; wantMove = true; }
        else if (tankKeysDown['ArrowLeft']) { wantDir = DIR.LEFT; wantMove = true; }
        else if (tankKeysDown['ArrowRight']) { wantDir = DIR.RIGHT; wantMove = true; }

        // 串口输入
        if (!wantMove && t.serialInput.port1.moving) {
          wantDir = t.serialInput.port1.direction;
          wantMove = true;
        }
      } else {
        // P2: WASD
        if (tankKeysDown['w'] || tankKeysDown['W']) { wantDir = DIR.UP; wantMove = true; }
        else if (tankKeysDown['s'] || tankKeysDown['S']) { wantDir = DIR.DOWN; wantMove = true; }
        else if (tankKeysDown['a'] || tankKeysDown['A']) { wantDir = DIR.LEFT; wantMove = true; }
        else if (tankKeysDown['d'] || tankKeysDown['D']) { wantDir = DIR.RIGHT; wantMove = true; }

        // 串口输入
        if (!wantMove && t.serialInput.port2.moving) {
          wantDir = t.serialInput.port2.direction;
          wantMove = true;
        }
      }

      p.direction = wantDir;
      p.moving = wantMove;

      if (wantMove) {
        moveTank(p);
      }
    }
  }

  function moveTank(tank) {
    const dx = DIR_DX[tank.direction];
    const dy = DIR_DY[tank.direction];
    let newX = tank.x + dx * tank.speed;
    let newY = tank.y + dy * tank.speed;

    // 对齐到半格（使转弯更平滑）
    const halfTile = TILE_SIZE / 2;
    if (dx !== 0) {
      // 水平移动时，对齐 Y
      newY = Math.round(newY / halfTile) * halfTile;
    } else {
      // 垂直移动时，对齐 X
      newX = Math.round(newX / halfTile) * halfTile;
    }

    // 冰面滑行（使用对象池）
    const iceCount = getTilesInRect(tank.x, tank.y, TANK_SIZE, TANK_SIZE);
    let onIce = false;
    for (let i = 0; i < iceCount; i++) {
      if (_tileResultPool[i].type === T.ICE) { onIce = true; break; }
    }

    if (canMoveTo(newX, newY, tank)) {
      tank.x = newX;
      tank.y = newY;
    }
  }

  function updateEnemies() {
    const t = gameState.tank;
    if (t.freezeTimer > 0) return; // 冻结

    for (let ei = 0; ei < t.enemies.length; ei++) {
      const e = t.enemies[ei];
      if (!e.alive) continue;
      e.flashFrame++;

      // 射击
      e.shootCooldown--;
      if (e.shootCooldown <= 0) {
        enemyShoot(e);
        e.shootCooldown = 90 + Math.random() * 90;
      }

      // AI 方向切换
      e.dirChangeTimer--;
      if (e.dirChangeTimer <= 0) {
        const rand = Math.random();
        if (rand < 0.3) {
          const homeX = 12 * TILE_SIZE;
          const homeY = 24 * TILE_SIZE;
          if (Math.abs(e.x - homeX) > Math.abs(e.y - homeY)) {
            e.direction = e.x > homeX ? DIR.LEFT : DIR.RIGHT;
          } else {
            e.direction = e.y > homeY ? DIR.UP : DIR.DOWN;
          }
        } else {
          e.direction = Math.floor(Math.random() * 4);
        }
        e.dirChangeTimer = 60 + Math.random() * 120;
      }

      // 移动
      const dx = DIR_DX[e.direction];
      const dy = DIR_DY[e.direction];
      let newX = e.x + dx * e.speed;
      let newY = e.y + dy * e.speed;

      const halfTile = TILE_SIZE / 2;
      if (dx !== 0) newY = Math.round(newY / halfTile) * halfTile;
      else newX = Math.round(newX / halfTile) * halfTile;

      if (canMoveTo(newX, newY, e)) {
        e.x = newX;
        e.y = newY;
      } else {
        e.direction = Math.floor(Math.random() * 4);
        e.dirChangeTimer = 30 + Math.random() * 60;
      }
    }
  }

  function spawnEnemy() {
    const t = gameState.tank;
    if (t.enemySpawnCount >= t.enemiesTotal) return;
    // 性能优化：用 for 循环替代 filter 计数
    let aliveEnemyCount = 0;
    for (let i = 0; i < t.enemies.length; i++) {
      if (t.enemies[i].alive) aliveEnemyCount++;
    }
    if (aliveEnemyCount >= t.maxEnemiesOnScreen) return;

    t.enemySpawnTimer--;
    if (t.enemySpawnTimer > 0) return;
    t.enemySpawnTimer = t.enemySpawnInterval;

    // 出生点：顶部 左、中、右
    const spawnXs = [0, 12 * TILE_SIZE, 24 * TILE_SIZE];
    const spawnX = spawnXs[t.enemySpawnIndex % 3];
    t.enemySpawnIndex++;

    // 检查出生点是否被占用（不创建临时数组）
    let blocked = false;
    for (let pi = 0; pi < t.players.length; pi++) {
      const p = t.players[pi];
      if (p.alive && rectsOverlap(spawnX, 0, TANK_SIZE, TANK_SIZE, p.x, p.y, TANK_SIZE, TANK_SIZE)) {
        blocked = true; break;
      }
    }
    if (!blocked) {
      for (let ei = 0; ei < t.enemies.length; ei++) {
        const e = t.enemies[ei];
        if (e.alive && rectsOverlap(spawnX, 0, TANK_SIZE, TANK_SIZE, e.x, e.y, TANK_SIZE, TANK_SIZE)) {
          blocked = true; break;
        }
      }
    }
    if (blocked) {
      t.enemySpawnTimer = 30; // 短暂延迟重试
      return;
    }

    // 随机敌人类型
    const typeWeights = [0.4, 0.3, 0.2, 0.1]; // 普通多，重装少
    let rand = Math.random();
    let enemyType = 0;
    for (let i = 0; i < typeWeights.length; i++) {
      rand -= typeWeights[i];
      if (rand <= 0) { enemyType = i; break; }
    }

    const isFlash = t.flashEnemyIndices.includes(t.enemySpawnCount);
    const enemy = createEnemy(enemyType, spawnX, 0, isFlash);
    t.enemies.push(enemy);
    t.enemySpawnCount++;
  }

  function updateBullets() {
    const t = gameState.tank;

    // 性能优化：使用索引循环，避免 for-of 迭代器开销
    for (let bi = 0; bi < t.bullets.length; bi++) {
      const b = t.bullets[bi];
      if (!b.alive) continue;

      // 移动
      b.x += DIR_DX[b.direction] * b.speed;
      b.y += DIR_DY[b.direction] * b.speed;

      // 边界检查
      if (b.x < -8 || b.y < -8 || b.x > MAP_PX_W + 8 || b.y > MAP_PX_H + 8) {
        b.alive = false;
        continue;
      }

      // 与地图碰撞（使用对象池）
      const bTileCount = getTilesInRect(b.x, b.y, b.w, b.h);
      for (let ti = 0; ti < bTileCount; ti++) {
        const tile = _tileResultPool[ti];
        if (tile.type === T.BRICK) {
          t.map[tile.row][tile.col] = T.EMPTY;
          mapCacheDirty = true;
          b.alive = false;
          spawnExplosion(tile.col * TILE_SIZE + TILE_SIZE / 2, tile.row * TILE_SIZE + TILE_SIZE / 2, 'small');
        } else if (tile.type === T.STEEL) {
          if (b.canBreakSteel) {
            t.map[tile.row][tile.col] = T.EMPTY;
            mapCacheDirty = true;
          }
          b.alive = false;
          spawnExplosion(tile.col * TILE_SIZE + TILE_SIZE / 2, tile.row * TILE_SIZE + TILE_SIZE / 2, 'small');
        } else if (tile.type === T.HOME) {
          t.map[tile.row][tile.col] = T.HOME_DEAD;
          mapCacheDirty = true;
          b.alive = false;
          spawnExplosion(tile.col * TILE_SIZE + TILE_SIZE / 2, tile.row * TILE_SIZE + TILE_SIZE / 2, 'big');
          t.gameOver = true;
        }
      }
      if (!b.alive) continue;

      // 子弹 vs 子弹（性能优化：只检查后续子弹，避免重复检查）
      for (let oi = bi + 1; oi < t.bullets.length; oi++) {
        const other = t.bullets[oi];
        if (!other.alive) continue;
        if (rectsOverlap(b.x, b.y, b.w, b.h, other.x, other.y, other.w, other.h)) {
          b.alive = false;
          other.alive = false;
          break;
        }
      }
      if (!b.alive) continue;

      // 子弹 vs 坦克
      if (b.ownerType === 'player') {
        // 玩家子弹 → 敌人
        for (const e of t.enemies) {
          if (!e.alive) continue;
          if (rectsOverlap(b.x, b.y, b.w, b.h, e.x, e.y, TANK_SIZE, TANK_SIZE)) {
            b.alive = false;
            e.hp -= b.power;
            if (e.hp <= 0) {
              e.alive = false;
              t.enemiesKilled++;
              // 加分
              const shooter = typeof b.ownerId === 'number' ? t.players[b.ownerId] : null;
              if (shooter) shooter.score += e.score;
              spawnExplosion(e.x + TANK_SIZE / 2, e.y + TANK_SIZE / 2, 'big');
              // 掉道具
              if (e.isFlash) {
                spawnPowerup();
              }
            } else {
              spawnExplosion(b.x + 3, b.y + 3, 'small');
            }
            break;
          }
        }

        // 玩家子弹 → 友方玩家（PVP 误伤 = 定身3秒）
        if (t.mode === '2p' && b.alive) {
          for (const p of t.players) {
            if (!p.alive || p.id === b.ownerId || p.respawnTimer > 0) continue;
            if (rectsOverlap(b.x, b.y, b.w, b.h, p.x, p.y, TANK_SIZE, TANK_SIZE)) {
              b.alive = false;
              if (p.shieldTimer <= 0) {
                p.stunTimer = 180; // 定身3秒
              }
              spawnExplosion(b.x + 3, b.y + 3, 'small');
              break;
            }
          }
        }
      } else {
        // 敌人子弹 → 玩家
        for (const p of t.players) {
          if (!p.alive || p.respawnTimer > 0) continue;
          if (rectsOverlap(b.x, b.y, b.w, b.h, p.x, p.y, TANK_SIZE, TANK_SIZE)) {
            b.alive = false;
            if (p.shieldTimer > 0) {
              // 护盾挡住
              spawnExplosion(b.x + 3, b.y + 3, 'small');
            } else {
              // 玩家被击毁
              p.alive = false;
              p.lives--;
              p.level = 0;
              spawnExplosion(p.x + TANK_SIZE / 2, p.y + TANK_SIZE / 2, 'big');
              if (p.lives > 0) {
                p.respawnTimer = 120; // 2秒后重生
              }
            }
            break;
          }
        }
      }
    }

    // 性能优化：就地压缩数组代替 filter
    let bWrite = 0;
    for (let i = 0; i < t.bullets.length; i++) {
      if (t.bullets[i].alive) t.bullets[bWrite++] = t.bullets[i];
    }
    t.bullets.length = bWrite;
  }

  function spawnExplosion(x, y, size) {
    const t = gameState.tank;
    // 性能优化：限制同屏最大爆炸数为 30
    if (t.explosions.length >= 30) {
      // 替换最旧的爆炸
      const oldest = t.explosions[0];
      oldest.x = x; oldest.y = y; oldest.size = size;
      oldest.frame = 0; oldest.maxFrame = size === 'big' ? 20 : 12;
      return;
    }
    t.explosions.push({
      x: x, y: y,
      size: size,
      frame: 0,
      maxFrame: size === 'big' ? 20 : 12,
    });
  }

  function updateExplosions() {
    const t = gameState.tank;
    // 性能优化：就地移除已完成的爆炸，减少数组创建
    let writeIdx = 0;
    for (let i = 0; i < t.explosions.length; i++) {
      const ex = t.explosions[i];
      ex.frame++;
      if (ex.frame < ex.maxFrame) {
        t.explosions[writeIdx++] = ex;
      }
    }
    t.explosions.length = writeIdx;
  }

  function spawnPowerup() {
    const t = gameState.tank;
    const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
    // 随机位置（避开水和钢墙）
    let px, py;
    for (let attempt = 0; attempt < 50; attempt++) {
      px = Math.floor(Math.random() * (MAP_COLS - 2)) * TILE_SIZE;
      py = Math.floor(Math.random() * (MAP_ROWS - 2)) * TILE_SIZE;
      const col = Math.floor(px / TILE_SIZE);
      const row = Math.floor(py / TILE_SIZE);
      if (row < MAP_ROWS && col < MAP_COLS && t.map[row][col] === T.EMPTY) break;
    }
    t.powerups.push({
      type: type,
      x: px, y: py,
      w: TANK_SIZE, h: TANK_SIZE,
      alive: true,
      timer: 600, // 10秒消失
      flashFrame: 0,
    });
  }

  function updatePowerups() {
    const t = gameState.tank;
    for (const pu of t.powerups) {
      if (!pu.alive) continue;
      pu.timer--;
      pu.flashFrame++;
      if (pu.timer <= 0) { pu.alive = false; continue; }

      // 与玩家碰撞
      const activeCount = t.mode === '2p' ? 2 : 1;
      for (let i = 0; i < activeCount; i++) {
        const p = t.players[i];
        if (!p.alive || p.respawnTimer > 0) continue;
        if (rectsOverlap(p.x, p.y, TANK_SIZE, TANK_SIZE, pu.x, pu.y, pu.w, pu.h)) {
          pu.alive = false;
          applyPowerup(pu.type, p, i);
          break;
        }
      }
    }
    // 性能优化：就地压缩数组
    let puWrite = 0;
    for (let i = 0; i < t.powerups.length; i++) {
      if (t.powerups[i].alive) t.powerups[puWrite++] = t.powerups[i];
    }
    t.powerups.length = puWrite;
  }

  function applyPowerup(type, player, playerId) {
    const t = gameState.tank;
    switch (type) {
      case 'star':
        player.level = Math.min(3, player.level + 1);
        break;
      case 'grenade':
        // 全屏敌人爆炸（性能优化：限制爆炸特效数量）
        let grenadeExplosions = 0;
        for (let i = 0; i < t.enemies.length; i++) {
          const e = t.enemies[i];
          if (e.alive) {
            e.alive = false;
            t.enemiesKilled++;
            player.score += e.score;
            // 最多显示 6 个爆炸特效，避免大量爆炸导致卡顿
            if (grenadeExplosions < 6) {
              spawnExplosion(e.x + TANK_SIZE / 2, e.y + TANK_SIZE / 2, 'big');
              grenadeExplosions++;
            }
          }
        }
        break;
      case 'clock':
        t.freezeTimer = 600; // 10秒
        break;
      case 'helmet':
        player.shieldTimer = 600; // 10秒
        break;
      case 'shovel':
        // 基地围墙变石墙
        restoreBaseWalls(T.STEEL);
        t.shovelTimer = 600; // 10秒后恢复
        break;
      case 'life':
        player.lives++;
        break;
    }
  }

  function restoreBaseWalls(tileType) {
    const t = gameState.tank;
    // 基地围墙位置
    const wallPositions = [
      [23, 11], [23, 12], [23, 13], [23, 14],
      [24, 11], [25, 11],
      [24, 14], [25, 14],
    ];
    for (const [r, c] of wallPositions) {
      if (r < MAP_ROWS && c < MAP_COLS) {
        t.map[r][c] = tileType;
      }
    }
    mapCacheDirty = true;
  }

  function checkWinLose() {
    const t = gameState.tank;
    if (t.gameOver || t.victory) return;

    // 检查老鹰是否被毁
    if (t.map[24][12] === T.HOME_DEAD || t.map[24][13] === T.HOME_DEAD ||
        t.map[25][12] === T.HOME_DEAD || t.map[25][13] === T.HOME_DEAD) {
      t.gameOver = true;
      return;
    }

    // 检查玩家是否全灭
    const activeCount = t.mode === '2p' ? 2 : 1;
    let allDead = true;
    for (let i = 0; i < activeCount; i++) {
      const p = t.players[i];
      if (p.alive || p.lives > 0) { allDead = false; break; }
    }
    if (allDead) {
      t.gameOver = true;
      return;
    }

    // 检查是否胜利（所有敌人消灭）
    if (t.enemiesKilled >= t.enemiesTotal) {
      let anyAlive = false;
      for (let i = 0; i < t.enemies.length; i++) {
        if (t.enemies[i].alive) { anyAlive = true; break; }
      }
      if (!anyAlive) t.victory = true;
    }
  }

  // ===== 绘制 =====
  function draw() {
    const t = gameState.tank;
    if (!t) return;

    // 背景
    ctx.fillStyle = '#12141c';
    ctx.fillRect(0, 0, W, H);

    if (t.mode === 'menu') {
      drawTankMenu();
      return;
    }

    if (t.stageTransition) {
      drawStageTransition();
      return;
    }

    ctx.save();
    ctx.translate(OFFSET_X, OFFSET_Y);

    // 地图底色
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, MAP_PX_W, MAP_PX_H);

    // 绘制地图（底层：空地、冰、水）
    drawMapBottom();
    // 绘制坦克
    drawTanks();
    // 绘制子弹
    drawBullets();
    // 绘制地图（顶层：草丛覆盖坦克）
    drawMapTop();
    // 绘制爆炸
    drawExplosions();
    // 绘制道具
    drawPowerups();

    ctx.restore();

    // HUD
    drawHUD();

    // 暂停
    if (t.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 36px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('PAUSE', W / 2, H / 2);
    }

    // Game Over
    if (t.gameOver) {
      drawGameOver();
    }

    // Victory
    if (t.victory) {
      drawVictory();
    }
  }

  function drawTankMenu() {
    const t = gameState.tank;
    t.frame++; // 菜单状态下 update() 不递增 frame，所以这里递增

    // 背景装饰 - 砖墙纹理
    ctx.globalAlpha = 0.05;
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 14; j++) {
        ctx.fillStyle = '#c45';
        ctx.fillRect(50 + i * 36, 30 + j * 36, 32, 32);
      }
    }
    ctx.globalAlpha = 1;

    // 标题
    ctx.fillStyle = '#e44';
    ctx.font = 'bold 52px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('BATTLE', W / 2, 110);
    ctx.fillStyle = '#fff';
    ctx.fillText('CITY', W / 2, 165);

    // 副标题
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '14px monospace';
    ctx.fillText('90坦克大战 · 星瀚手柄控制', W / 2, 195);

    // 坦克装饰
    ctx.fillStyle = '#FFD700';
    drawMiniTank(W / 2 - 80, 220, DIR.RIGHT, '#FFD700');
    drawMiniTank(W / 2 + 50, 220, DIR.LEFT, '#00FF7F');

    // 菜单选项
    const options = [
      { label: '1 PLAYER', desc: '单人模式 · 方向键/控制器移动 · 空格/BTN射击' },
      { label: '2 PLAYERS', desc: '双人模式 · 玩家1控制器/方向键 · 玩家2 WASD' },
      { label: `STAGE ${t.levelIndex + 1}`, desc: '← → 选择关卡' },
    ];

    const startY = 280;
    options.forEach((opt, i) => {
      const y = startY + i * 58;
      const isSelected = t.menuIndex === i;

      if (isSelected) {
        ctx.fillStyle = 'rgba(255, 68, 68, 0.08)';
        ctx.strokeStyle = 'rgba(255, 68, 68, 0.4)';
        ctx.shadowColor = 'rgba(255, 68, 68, 0.2)';
        ctx.shadowBlur = 10;
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.03)';
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.shadowBlur = 0;
      }

      const boxW = 400;
      const boxH = 46;
      const boxX = W / 2 - boxW / 2;
      const r = 8;
      ctx.beginPath();
      ctx.moveTo(boxX + r, y); ctx.lineTo(boxX + boxW - r, y);
      ctx.arcTo(boxX + boxW, y, boxX + boxW, y + r, r);
      ctx.lineTo(boxX + boxW, y + boxH - r);
      ctx.arcTo(boxX + boxW, y + boxH, boxX + boxW - r, y + boxH, r);
      ctx.lineTo(boxX + r, y + boxH);
      ctx.arcTo(boxX, y + boxH, boxX, y + boxH - r, r);
      ctx.lineTo(boxX, y + r);
      ctx.arcTo(boxX, y, boxX + r, y, r);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (isSelected) {
        // 选中指示器 - 小坦克
        ctx.fillStyle = '#e44';
        const arrowX = boxX + 18;
        const arrowY = y + boxH / 2;
        ctx.beginPath();
        ctx.moveTo(arrowX - 4, arrowY - 5);
        ctx.lineTo(arrowX + 4, arrowY);
        ctx.lineTo(arrowX - 4, arrowY + 5);
        ctx.fill();
      }

      ctx.fillStyle = isSelected ? '#fff' : 'rgba(255,255,255,0.6)';
      ctx.font = `${isSelected ? 'bold ' : ''}16px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(opt.label, W / 2, y + 20);

      ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.2)';
      ctx.font = '11px sans-serif';
      ctx.fillText(opt.desc, W / 2, y + 37);
    });

    // 操作提示
    const blink = Math.sin(t.frame * 0.06) * 0.3 + 0.4;
    ctx.fillStyle = `rgba(255,255,255,${blink})`;
    ctx.font = '13px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('↑ ↓ 选择  ·  ← → 选关  ·  回车/BTN 确认', W / 2, 475);
  }

  function drawMiniTank(x, y, dir, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, 24, 24);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(x + 4, y + 4, 16, 16);
    // 炮管
    ctx.fillStyle = color;
    const cx = x + 12, cy = y + 12;
    if (dir === DIR.UP) ctx.fillRect(cx - 2, y - 6, 4, 12);
    else if (dir === DIR.DOWN) ctx.fillRect(cx - 2, y + 18, 4, 12);
    else if (dir === DIR.LEFT) ctx.fillRect(x - 6, cy - 2, 12, 4);
    else ctx.fillRect(x + 18, cy - 2, 12, 4);
  }

  function drawStageTransition() {
    const t = gameState.tank;
    t.frame++;

    ctx.fillStyle = '#555';
    ctx.fillRect(0, 0, W, H);

    // 幕布效果
    const progress = 1 - t.stageTransitionTimer / 120;
    const curtainH = H / 2 * (1 - Math.abs(progress * 2 - 1));
    ctx.fillStyle = '#555';
    ctx.fillRect(0, 0, W, H / 2 - curtainH);
    ctx.fillRect(0, H / 2 + curtainH, W, H / 2 - curtainH);

    // 关卡文字
    if (progress > 0.3 && progress < 0.9) {
      ctx.fillStyle = '#000';
      ctx.font = 'bold 32px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`STAGE ${t.levelIndex + 1}`, W / 2, H / 2 + 10);
    }
  }

  // 地图绘制 - 底层（使用离屏缓存 + 仅水面动态绘制）
  function drawMapBottom() {
    const t = gameState.tank;
    // 缓存静态地图块（砖墙、钢墙、冰、老鹰等）
    if (mapCacheDirty) {
      renderMapCache(t.map);
    }
    // 一次性绘制所有静态地砖
    ctx.drawImage(mapCache, 0, 0);

    // 仅动态绘制水面（需要动画）
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        if (t.map[r][c] !== T.WATER) continue;
        const px = c * TILE_SIZE;
        const py = r * TILE_SIZE;
        ctx.fillStyle = '#1a3a5c';
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        const wave = Math.sin((t.frame * 0.05 + c * 0.5 + r * 0.3)) * 0.3 + 0.5;
        ctx.fillStyle = `rgba(100,180,255,${(wave * 0.3).toFixed(2)})`;
        ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
      }
    }
  }

  // 地图绘制 - 顶层（草丛覆盖坦克）
  function drawMapTop() {
    const t = gameState.tank;
    for (let r = 0; r < MAP_ROWS; r++) {
      for (let c = 0; c < MAP_COLS; c++) {
        if (t.map[r][c] === T.FOREST) {
          const px = c * TILE_SIZE;
          const py = r * TILE_SIZE;
          ctx.fillStyle = '#228B22';
          ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
          ctx.fillStyle = '#2ca02c';
          ctx.fillRect(px + 2, py + 2, 5, 5);
          ctx.fillRect(px + 8, py + 7, 5, 5);
          ctx.fillRect(px + 3, py + 10, 5, 4);
        }
      }
    }
  }

  function drawTanks() {
    const t = gameState.tank;
    const activeCount = t.mode === '2p' ? 2 : 1;

    // 绘制玩家坦克
    for (let i = 0; i < activeCount; i++) {
      const p = t.players[i];
      if (!p.alive || p.respawnTimer > 0) continue;
      drawTank(p.x, p.y, p.direction, p.color, p.moving, t.frame, p.level);

      // 护盾效果
      if (p.shieldTimer > 0) {
        const alpha = 0.3 + Math.sin(t.frame * 0.3) * 0.2;
        ctx.strokeStyle = `rgba(100, 200, 255, ${alpha})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x + TANK_SIZE / 2, p.y + TANK_SIZE / 2, TANK_SIZE / 2 + 2, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 定身效果
      if (p.stunTimer > 0) {
        ctx.fillStyle = `rgba(255, 255, 0, ${0.3 + Math.sin(t.frame * 0.2) * 0.2})`;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('⚡', p.x + TANK_SIZE / 2, p.y - 4);
      }
    }

    // 绘制敌人坦克（索引循环，跳过已死亡）
    for (let ei = 0; ei < t.enemies.length; ei++) {
      const e = t.enemies[ei];
      if (!e.alive) continue;
      let color = e.color;
      // 红色闪烁
      if (e.isFlash && Math.floor(e.flashFrame / 8) % 2 === 0) {
        color = '#f44';
      }
      // 重型装甲显示受损
      if (e.maxHp > 1) {
        const hpRatio = e.hp / e.maxHp;
        if (hpRatio <= 0.25) color = '#f88';
        else if (hpRatio <= 0.5) color = '#fa8';
        else if (hpRatio <= 0.75) color = '#ff8';
      }
      drawTank(e.x, e.y, e.direction, color, true, t.frame, 0);
    }
  }

  function drawTank(x, y, direction, color, moving, frame, level) {
    const s = TANK_SIZE;
    const hs = s / 2;

    // 履带
    ctx.fillStyle = '#333';
    if (direction === DIR.UP || direction === DIR.DOWN) {
      ctx.fillRect(x, y, 6, s);
      ctx.fillRect(x + s - 6, y, 6, s);
      // 履带纹
      if (moving) {
        const offset = (frame * 2) % 8;
        ctx.fillStyle = '#555';
        for (let i = -1; i < s / 8 + 1; i++) {
          const ly = y + i * 8 + (direction === DIR.UP ? offset : -offset);
          if (ly > y - 2 && ly < y + s - 2) {
            ctx.fillRect(x, ly, 6, 3);
            ctx.fillRect(x + s - 6, ly, 6, 3);
          }
        }
      }
    } else {
      ctx.fillRect(x, y, s, 6);
      ctx.fillRect(x, y + s - 6, s, 6);
      if (moving) {
        const offset = (frame * 2) % 8;
        ctx.fillStyle = '#555';
        for (let i = -1; i < s / 8 + 1; i++) {
          const lx = x + i * 8 + (direction === DIR.LEFT ? offset : -offset);
          if (lx > x - 2 && lx < x + s - 2) {
            ctx.fillRect(lx, y, 3, 6);
            ctx.fillRect(lx, y + s - 6, 3, 6);
          }
        }
      }
    }

    // 车身
    ctx.fillStyle = color;
    ctx.fillRect(x + 6, y + 6, s - 12, s - 12);

    // 车身内部纹理
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x + 8, y + 8, s - 16, s - 16);

    // 等级标记（用简单圆点代替文字渲染，避免每帧创建字符串）
    if (level > 0) {
      ctx.fillStyle = '#fff';
      const dots = Math.min(level, 3);
      const dotStartX = x + hs - (dots - 1) * 3;
      for (let d = 0; d < dots; d++) {
        ctx.fillRect(dotStartX + d * 6 - 1, y + hs - 1, 3, 3);
      }
    }

    // 炮管
    ctx.fillStyle = color;
    const cx = x + hs;
    const cy = y + hs;
    const barrelW = 4;
    const barrelL = hs + 2;
    switch (direction) {
      case DIR.UP:    ctx.fillRect(cx - barrelW / 2, cy - barrelL, barrelW, barrelL); break;
      case DIR.DOWN:  ctx.fillRect(cx - barrelW / 2, cy, barrelW, barrelL); break;
      case DIR.LEFT:  ctx.fillRect(cx - barrelL, cy - barrelW / 2, barrelL, barrelW); break;
      case DIR.RIGHT: ctx.fillRect(cx, cy - barrelW / 2, barrelL, barrelW); break;
    }
  }

  function drawBullets() {
    const t = gameState.tank;
    for (let bi = 0; bi < t.bullets.length; bi++) {
      const b = t.bullets[bi];
      if (!b.alive) continue;
      ctx.fillStyle = b.ownerType === 'player' ? '#fff' : '#f88';
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
  }

  function drawExplosions() {
    const t = gameState.tank;
    for (let exi = 0; exi < t.explosions.length; exi++) {
      const ex = t.explosions[exi];
      const progress = ex.frame / ex.maxFrame;
      const maxR = ex.size === 'big' ? 24 : 12;
      const r = maxR * (progress < 0.5 ? progress * 2 : 2 - progress * 2);
      const alpha = 1 - progress;

      // 用 fillRect 替代 arc（避免 beginPath+fill 的高开销路径操作）
      const size = r * 2;
      ctx.fillStyle = `rgba(255, ${Math.floor(200 * (1 - progress))}, 0, ${alpha.toFixed(2)})`;
      ctx.fillRect(ex.x - r, ex.y - r, size, size);

      if (r > 4) {
        const innerSize = r;
        ctx.fillStyle = `rgba(255, 255, 100, ${(alpha * 0.5).toFixed(2)})`;
        ctx.fillRect(ex.x - r * 0.5, ex.y - r * 0.5, innerSize, innerSize);
      }
    }
  }

  // 道具颜色映射（用简单图形代替 emoji 文字渲染，减少 GPU 开销）
  const POWERUP_COLORS = {
    star: '#FFD700', grenade: '#f44', clock: '#4af',
    helmet: '#8cf', shovel: '#a86', life: '#4f4',
  };
  const POWERUP_LABELS = {
    star: 'S', grenade: 'G', clock: 'T',
    helmet: 'H', shovel: 'V', life: 'L',
  };

  function drawPowerups() {
    const t = gameState.tank;
    for (let pi = 0; pi < t.powerups.length; pi++) {
      const pu = t.powerups[pi];
      if (!pu.alive) continue;
      // 闪烁
      if (Math.floor(pu.flashFrame / 10) % 2 === 0) continue;

      ctx.fillStyle = 'rgba(255, 0, 0, 0.15)';
      ctx.fillRect(pu.x - 2, pu.y - 2, pu.w + 4, pu.h + 4);

      // 道具图标 - 用彩色方块 + 字母代替 emoji
      ctx.fillStyle = POWERUP_COLORS[pu.type] || '#fff';
      ctx.fillRect(pu.x + 4, pu.y + 4, pu.w - 8, pu.h - 8);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 14px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(POWERUP_LABELS[pu.type] || '?', pu.x + pu.w / 2, pu.y + pu.h / 2 + 5);
    }
  }

  function drawHUD() {
    const t = gameState.tank;

    // 左侧 - 敌人剩余
    const hudX = OFFSET_X - 50;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ENEMY', hudX, OFFSET_Y + 12);

    const remaining = t.enemiesTotal - t.enemySpawnCount;
    for (let i = 0; i < remaining; i++) {
      const row = Math.floor(i / 2);
      const col = i % 2;
      ctx.fillStyle = '#e44';
      ctx.fillRect(hudX - 10 + col * 14, OFFSET_Y + 18 + row * 14, 10, 10);
    }

    // 右侧 - 玩家信息
    const rhudX = OFFSET_X + MAP_PX_W + 15;
    const activeCount = t.mode === '2p' ? 2 : 1;

    for (let i = 0; i < activeCount; i++) {
      const p = t.players[i];
      const py = OFFSET_Y + i * 100;

      // 玩家标识
      ctx.fillStyle = p.color;
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(i === 0 ? '1P' : '2P', rhudX, py + 12);

      // 生命
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '10px monospace';
      ctx.fillText(`♥ ${p.lives}`, rhudX, py + 28);

      // 等级
      ctx.fillText(`Lv.${p.level}`, rhudX, py + 42);

      // 分数
      ctx.fillText(`${p.score}`, rhudX, py + 56);
    }

    // 关卡
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`STAGE`, rhudX, OFFSET_Y + MAP_PX_H - 25);
    ctx.font = 'bold 16px monospace';
    ctx.fillText(`${t.levelIndex + 1}`, rhudX + 5, OFFSET_Y + MAP_PX_H - 6);
  }

  function drawGameOver() {
    const t = gameState.tank;
    const progress = Math.min(1, t.gameOverTimer / 90);

    // 从底部滚上来
    const textY = H - (H / 2 + 20) * progress;

    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#e44';
    ctx.font = 'bold 42px monospace';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#e44';
    ctx.shadowBlur = 15;
    ctx.fillText('GAME OVER', W / 2, textY);
    ctx.shadowBlur = 0;

    if (progress >= 1) {
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '14px monospace';
      const blink = Math.sin(t.gameOverTimer * 0.06) * 0.3 + 0.5;
      ctx.fillStyle = `rgba(255,255,255,${blink})`;
      ctx.fillText('按 R 键返回菜单', W / 2, textY + 45);
    }
  }

  function drawVictory() {
    const t = gameState.tank;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = '#4f4';
    ctx.font = 'bold 36px monospace';
    ctx.textAlign = 'center';
    ctx.shadowColor = '#4f4';
    ctx.shadowBlur = 15;
    ctx.fillText('STAGE CLEAR!', W / 2, H / 2 - 10);
    ctx.shadowBlur = 0;

    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '14px monospace';
    ctx.fillText(`进入下一关...`, W / 2, H / 2 + 25);
  }

  // 暴露全局函数供串口调用
  window._tankPlayerShoot = playerShoot;
  window._tankStartLevel = startLevel;

  // ===== 游戏循环 =====
  function loop() {
    if (!gameState.tank) return;
    update();
    draw();
    gameAnimationId = requestAnimationFrame(loop);
  }
  loop();
}

// 坦克大战 - 串口方向控制
function tankHandleDirection(dir, source) {
  const t = gameState.tank;
  if (!t) return;

  const portKey = source === 'port2' ? 'port2' : 'port1';
  const input = t.serialInput[portKey];

  if (t.mode === 'menu') {
    // 菜单操作
    if (dir === 'UP') t.menuIndex = (t.menuIndex + 2) % 3;
    else if (dir === 'DOWN') t.menuIndex = (t.menuIndex + 1) % 3;
    else if (dir === 'LEFT' && t.menuIndex === 2) {
      t.levelIndex = (t.levelIndex + 2) % 3; // LEVELS.length fallback
    } else if (dir === 'RIGHT' && t.menuIndex === 2) {
      t.levelIndex = (t.levelIndex + 1) % 3;
    }
    return;
  }

  // 游戏中方向控制
  const DIR = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3 };
  const dirMap = { UP: DIR.UP, DOWN: DIR.DOWN, LEFT: DIR.LEFT, RIGHT: DIR.RIGHT };

  if (dir === 'CENTER') {
    input.moving = false;
  } else if (dirMap[dir] !== undefined) {
    input.moving = true;
    input.direction = dirMap[dir];
  }
}

// 坦克大战 - 串口按键控制
function tankHandleButton(source) {
  const t = gameState.tank;
  if (!t) return;

  if (t.mode === 'menu') {
    // 菜单确认
    if (window._tankStartLevel) {
      if (t.menuIndex === 0) {
        window._tankStartLevel('1p', t.levelIndex);
      } else if (t.menuIndex === 1) {
        window._tankStartLevel('2p', t.levelIndex);
      }
    }
    return;
  }

  // 游戏结束/胜利后重新开始（不要调用 startTankBattle，否则会创建新的游戏循环！）
  if (t.gameOver || t.victory) {
    // 只重置状态，不重新启动游戏循环
    gameState.tank = null; // 先清空，让 initState 不读取旧值
    gameState.tank = {
      mode: 'menu', levelIndex: 0, menuIndex: 0, frame: 0,
      map: [], players: [{lives:3,level:0,score:0,alive:true},{lives:3,level:0,score:0,alive:true}],
      enemies: [], bullets: [], explosions: [], powerups: [],
      enemiesKilled: 0, enemiesTotal: 20, enemySpawnTimer: 0,
      enemySpawnInterval: 180, enemySpawnIndex: 0, maxEnemiesOnScreen: 4,
      flashEnemyIndices: [3, 10, 17], enemySpawnCount: 0,
      freezeTimer: 0, shovelTimer: 0, gameOver: false, gameOverTimer: 0,
      victory: false, victoryTimer: 0, stageTransition: false,
      stageTransitionTimer: 0, paused: false,
      serialInput: { port1: { moving: false, direction: 0 }, port2: { moving: false, direction: 0 } },
    };
    return;
  }

  // 射击
  const playerId = source === 'port2' ? 1 : 0;
  if (window._tankPlayerShoot) {
    window._tankPlayerShoot(playerId);
  }
}

// ========== 🎣 钓鱼达人（演示 V2 迁移：software_V2.py 流程 + 素材） ==========
const FISHING_V2_BASE = './assets/fishing-v2/';
const FISHING_V2_FISH_TYPES = ['武昌鱼', '白条', '草鱼', '鲤鱼', '麦穗鱼', '黄辣丁'];
const FISHING_V2_FISH_WEIGHTS = {
  武昌鱼: 0.6, 白条: 0.03, 草鱼: 1.8, 鲤鱼: 1.0, 麦穗鱼: 0.01, 黄辣丁: 0.1,
};

function fishingV2LoadImages(names, onDone) {
  const out = {};
  let pending = names.length;
  if (pending === 0) { onDone(out); return; }
  for (const name of names) {
    const im = new Image();
    out[name] = im;
    im.onload = () => { if (--pending === 0) onDone(out); };
    im.onerror = () => { if (--pending === 0) onDone(out); };
    im.src = FISHING_V2_BASE + name + '.png';
  }
}

function fishingV2PlaySfx(baseName) {
  try {
    const a = new Audio(FISHING_V2_BASE + baseName + '.wav');
    a.volume = 0.65;
    a.play().catch(() => {});
  } catch (_) {}
}

function fishingV2SendHardware(msg) {
  const line = msg.endsWith('\n') ? msg : msg + '\n';
  if (typeof writeToPort === 'function') {
    writeToPort('port1', line).catch(() => {});
  }
}

function startFishing() {
  const W = gameCanvas.width;
  const H = gameCanvas.height;
  const ctx = gameCtx;
  const sx = W / 900;
  const sy = H / 600;

  const layout = {
    rodTopX: 414 * sx,
    rodTopY: 395 * sy,
    catX: 450 * sx,
    startY: 700 * sy,
    targetY: 420 * sy,
    baitRegions: [
      { l: 125 * sx, t: 320 * sy, r: 198 * sx, b: 360 * sy },
      { l: 198 * sx, t: 307 * sy, r: 367 * sx, b: 417 * sy },
      { l: 370 * sx, t: 300 * sy, r: 422 * sx, b: 337 * sy },
    ],
    hintPos: { x: 100 * sx, y: 500 * sy },
    cdPos: { x: 800 * sx, y: 500 * sy },
    fishCountBoard: { x: 125 * sx, y: 70 * sy },
    fishWeightBoard: { x: 750 * sx, y: 70 * sy },
    countBoard: { x: 420 * sx, y: 70 * sy },
    castTextLeft: { x: 360 * sx, y: 82 * sy },
    castTextRight: { x: 480 * sx, y: 82 * sy },
    numFish: { x: 170 * sx, y: 73 * sy },
    numKg: { x: 800 * sx, y: 73 * sy },
    rotText: { x: 100 * sx - 10 * sx, y: 500 * sy },
    cdText: { x: 800 * sx, y: 500 * sy - 10 * sy },
    fishCard: { x: 450 * sx, y: 240 * sy },
    dataDash: { x: 450 * sx, y: 240 * sy },
    dashTotalKg: { x: 500 * sx, y: 325 * sy },
    dashAvgKg: { x: 520 * sx, y: 375 * sy },
    startFishBtn: { x: 450 * sx, y: 500 * sy },
  };

  const imgNames = [
    '开始界面', '钓鱼界面', '结算界面蒙层', '数据看板', '次数看板',
    '呆猫走路1', '呆猫走路2', '呆猫钓鱼姿势',
    '开始钓鱼1', '开始钓鱼2', '继续钓鱼1', '继续钓鱼2', '查看数据1', '查看数据2', '回到主页1', '回到主页2',
    '鱼饵', '鱼儿咬钩', '倒计时', '鱼数量', '鱼重量',
    ...FISHING_V2_FISH_TYPES,
  ];

  let imgs = {};
  let assetsReady = false;
  fishingV2LoadImages(imgNames, (loaded) => {
    imgs = loaded;
    assetsReady = true;
  });

  let bgm = null;
  try {
    bgm = new Audio(FISHING_V2_BASE + '背景音乐.mp3');
    bgm.loop = true;
    bgm.volume = 0.45;
  } catch (_) {}

  const maxCasts = 5;
  const state = {
    gameState: 'start',
    viewDataState: 'normal',
    dashboardAt: 0,
    fishCount: 0,
    fishWeight: 0,
    castCount: 0,
    blinkPhase: 0,
    showFirstImage: true,
    walkPhase: 0,
    showWalk1: true,
    catY: layout.startY,
    catMoving: false,
    catScale: 1,
    baitX: 0,
    baitY: 0,
    baitTargetX: 0,
    baitTargetY: 0,
    baitMoving: false,
    baitVisible: false,
    baitSpeed: 3 * ((sx + sy) / 2),
    fishBiting: false,
    fishBiteAt: 0,
    requiredRotations: 0,
    showRotationText: false,
    rotationTextBlink: true,
    rotationBlinkT: 0,
    fishEscapeAt: 0,
    fishEscaped: false,
    motorRawDeg: 0,
    angleRefDeg: 0,
    motorRotations: 0,
    gyroJump: false,
    lastJumpAt: -999,
    currentFishType: null,
    fishBiteSwing: 0,
    lastFrameMs: performance.now(),
    keySimRot: 0,
    splashPlayed: false,
  };

  function pickBaitLanding() {
    const reg = layout.baitRegions[Math.floor(Math.random() * layout.baitRegions.length)];
    const x = reg.l + Math.random() * (reg.r - reg.l);
    const y = reg.t + Math.random() * (reg.b - reg.t);
    return { x, y };
  }

  function resetBaitState() {
    state.baitX = 0;
    state.baitY = 0;
    state.baitMoving = false;
    state.baitVisible = false;
    state.fishBiting = false;
    state.fishBiteAt = 0;
    state.showRotationText = false;
    state.splashPlayed = false;
  }

  function beginFromStartScreen() {
    fishingV2PlaySfx('按钮音效');
    fishingV2PlaySfx('脚步声');
    state.gameState = 'fishing';
    state.catY = layout.startY;
    state.catMoving = true;
    state.showWalk1 = true;
    state.catScale = 1;
    resetBaitState();
    state.motorRawDeg = 0;
    state.angleRefDeg = 0;
    state.motorRotations = 0;
    fishingV2SendHardware('RESET');
  }

  function beginContinueFishing() {
    state.gameState = 'fishing';
    state.catY = layout.targetY;
    state.catMoving = false;
    state.showWalk1 = false;
    state.catScale = 0.5;
    state.baitX = layout.rodTopX;
    state.baitY = layout.rodTopY;
    const land = pickBaitLanding();
    state.baitTargetX = land.x;
    state.baitTargetY = land.y;
    state.baitMoving = true;
    state.baitVisible = true;
    state.castCount += 1;
    state.fishBiting = false;
    state.showRotationText = false;
    state.fishEscaped = false;
    state.splashPlayed = false;
    fishingV2PlaySfx('甩杆声音');
    fishingV2SendHardware('RESET');
  }

  function onResultGyroShakeFromParent() {
    if (state.castCount >= maxCasts) {
      if (state.viewDataState === 'normal') {
        state.viewDataState = 'data_dashboard';
        state.dashboardAt = performance.now() / 1000;
        fishingV2PlaySfx('按钮音效');
      }
      return;
    }
    beginContinueFishing();
  }

  function dashboardWaitDone() {
    return state.dashboardAt > 0 && performance.now() / 1000 - state.dashboardAt >= 3;
  }

  function backToHomeFromDashboard() {
    fishingV2PlaySfx('按钮音效');
    state.gameState = 'start';
    state.viewDataState = 'normal';
    state.dashboardAt = 0;
    state.castCount = 0;
    state.fishCount = 0;
    state.fishWeight = 0;
    state.currentFishType = null;
    resetBaitState();
    state.catY = layout.startY;
    fishingV2SendHardware('RESET');
  }

  function updateMotorFromRaw(rawDeg) {
    state.motorRawDeg = rawDeg;
    const rel = state.motorRawDeg - state.angleRefDeg;
    state.motorRotations = rel / 360;
  }

  function drawScaledCenter(img, x, y, scale) {
    if (!img || !img.complete || !img.naturalWidth) return;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
  }

  function drawRotCenter(img, x, y, scale, deg) {
    if (!img || !img.complete || !img.naturalWidth) return;
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  function drawFishingScene() {
    const bg = imgs['钓鱼界面'];
    if (bg && bg.complete) {
      ctx.drawImage(bg, 0, 0, W, H);
    } else {
      ctx.fillStyle = '#87ceeb';
      ctx.fillRect(0, 0, W, H);
    }

    if (state.catMoving) {
      const cw = state.showWalk1 ? imgs['呆猫走路1'] : imgs['呆猫走路2'];
      drawScaledCenter(cw, layout.catX, state.catY, state.catScale * sy);
    } else {
      drawScaledCenter(imgs['呆猫钓鱼姿势'], layout.catX, state.catY, 0.5 * sy);
      if (state.baitVisible) {
        ctx.save();
        ctx.strokeStyle = '#ff2d2d';
        ctx.lineWidth = Math.max(1.1, 1.15 * ((sx + sy) / 2));
        ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.85)';
        ctx.shadowBlur = 2 * ((sx + sy) / 2);
        ctx.beginPath();
        ctx.moveTo(layout.rodTopX, layout.rodTopY);
        ctx.lineTo(state.baitX, state.baitY);
        ctx.stroke();
        ctx.restore();
        if (state.baitMoving) {
          drawScaledCenter(imgs['鱼饵'], state.baitX, state.baitY, 1 * sy);
        } else {
          ctx.fillStyle = '#ff0000';
          ctx.beginPath();
          ctx.arc(state.baitTargetX, state.baitTargetY, 5 * sx, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    drawScaledCenter(imgs['鱼数量'], layout.fishCountBoard.x, layout.fishCountBoard.y, sy);
    drawScaledCenter(imgs['鱼重量'], layout.fishWeightBoard.x, layout.fishWeightBoard.y, sy);
    drawScaledCenter(imgs['次数看板'], layout.countBoard.x, layout.countBoard.y, sy);

    ctx.fillStyle = 'rgb(54,27,0)';
    ctx.font = `${Math.round(28 * sy)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(state.castCount), layout.castTextLeft.x, layout.castTextLeft.y);
    ctx.fillText(String(maxCasts), layout.castTextRight.x, layout.castTextRight.y);
    ctx.fillText(String(state.fishCount), layout.numFish.x, layout.numFish.y);
    ctx.fillText(`${state.fishWeight.toFixed(2)}kg`, layout.numKg.x, layout.numKg.y);

    if (state.showRotationText) {
      const swingDeg = 18 * Math.sin(state.fishBiteSwing);
      state.fishBiteSwing += 0.12;
      drawRotCenter(imgs['鱼儿咬钩'], layout.hintPos.x, layout.hintPos.y, sy, swingDeg);
      if (state.rotationTextBlink) {
        const rem = Math.max(0, state.requiredRotations - state.motorRotations);
        ctx.fillStyle = '#ff0000';
        ctx.font = `bold ${Math.round(30 * sy)}px sans-serif`;
        ctx.fillText(` ${rem.toFixed(2)}`, layout.rotText.x, layout.rotText.y);
      }
      drawScaledCenter(imgs['倒计时'], layout.cdPos.x, layout.cdPos.y, sy);
      const now = performance.now() / 1000;
      const remS = Math.max(0, state.fishEscapeAt - now);
      ctx.fillStyle = '#ff0000';
      ctx.font = `bold ${Math.round(24 * sy)}px sans-serif`;
      ctx.fillText(`${remS.toFixed(2)}s`, layout.cdText.x, layout.cdText.y);
    }
  }

  function drawDataDashboard() {
    drawScaledCenter(imgs['数据看板'], layout.dataDash.x, layout.dataDash.y, sy);
    const avg = state.fishCount > 0 ? state.fishWeight / state.fishCount : 0;
    ctx.fillStyle = 'rgb(54,27,0)';
    ctx.font = `${Math.round(26 * sy)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(`${state.fishWeight.toFixed(2)}kg`, layout.dashTotalKg.x, layout.dashTotalKg.y);
    ctx.fillText(`${avg.toFixed(2)}kg`, layout.dashAvgKg.x, layout.dashAvgKg.y);
    if (dashboardWaitDone()) {
      const hb = state.showFirstImage ? imgs['回到主页1'] : imgs['回到主页2'];
      drawScaledCenter(hb, layout.startFishBtn.x, layout.startFishBtn.y, sy);
    }
  }

  function drawFrame() {
    if (!assetsReady) {
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#fff';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('加载钓鱼达人素材…', W / 2, H / 2);
      return;
    }

    if (state.gameState === 'start') {
      const sbg = imgs['开始界面'];
      if (sbg && sbg.complete) ctx.drawImage(sbg, 0, 0, W, H);
      else ctx.fillRect(0, 0, W, H);
      const b1 = imgs['开始钓鱼1'];
      const b2 = imgs['开始钓鱼2'];
      if (state.showFirstImage) drawScaledCenter(b1, layout.startFishBtn.x, layout.startFishBtn.y, sy);
      else drawScaledCenter(b2, layout.startFishBtn.x, layout.startFishBtn.y, sy);
    } else if (state.gameState === 'fishing') {
      drawFishingScene();
    } else if (state.gameState === 'result') {
      drawFishingScene();
      const ov = imgs['结算界面蒙层'];
      if (ov && ov.complete) ctx.drawImage(ov, 0, 0, W, H);
      else {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, W, H);
      }
      if (state.viewDataState === 'normal') {
        if (state.castCount >= maxCasts) {
          if (state.showFirstImage) drawScaledCenter(imgs['查看数据1'], layout.startFishBtn.x, layout.startFishBtn.y, sy);
          else drawScaledCenter(imgs['查看数据2'], layout.startFishBtn.x, layout.startFishBtn.y, sy);
        } else {
          if (state.showFirstImage) drawScaledCenter(imgs['继续钓鱼1'], layout.startFishBtn.x, layout.startFishBtn.y, sy);
          else drawScaledCenter(imgs['继续钓鱼2'], layout.startFishBtn.x, layout.startFishBtn.y, sy);
        }
        if (state.currentFishType) {
          const fc = imgs[state.currentFishType];
          drawScaledCenter(fc, layout.fishCard.x, layout.fishCard.y, sy);
        }
      } else {
        drawDataDashboard();
      }
    }

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.font = `${Math.round(12 * sy)}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.fillText('串口：摇晃控制器开始 / 继续 · ANGLE| 或 DEGREE: 卷线 · 空格模拟', 8, H - 8);
  }

  function update(nowMs) {
    const dt = Math.min(50, nowMs - state.lastFrameMs);
    state.lastFrameMs = nowMs;
    const nowSec = nowMs / 1000;

    state.blinkPhase += dt;
    if (state.blinkPhase >= 500) {
      state.blinkPhase = 0;
      state.showFirstImage = !state.showFirstImage;
    }

    if (state.gameState === 'fishing' && state.catMoving) {
      const step = 2 * (dt / (1000 / 60)) * sy;
      state.catY -= step;
      const progress = (layout.startY - state.catY) / (layout.startY - layout.targetY);
      state.catScale = 1 - progress * 0.5;
      state.walkPhase += dt;
      if (state.walkPhase >= 166) {
        state.walkPhase = 0;
        state.showWalk1 = !state.showWalk1;
      }
      if (state.catY <= layout.targetY) {
        state.catY = layout.targetY;
        state.catMoving = false;
        state.showWalk1 = false;
        state.catScale = 0.5;
        state.baitX = layout.rodTopX;
        state.baitY = layout.rodTopY;
        const land = pickBaitLanding();
        state.baitTargetX = land.x;
        state.baitTargetY = land.y;
        state.baitMoving = true;
        state.baitVisible = true;
        state.castCount += 1;
        fishingV2PlaySfx('甩杆声音');
        state.splashPlayed = false;
      }
    }

    if (state.gameState === 'fishing' && state.baitMoving) {
      const dx = state.baitTargetX - state.baitX;
      const dy = state.baitTargetY - state.baitY;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const step = state.baitSpeed * (dt / (1000 / 60));
      if (dist > step) {
        state.baitX += (dx / dist) * step;
        state.baitY += (dy / dist) * step;
      } else {
        state.baitX = state.baitTargetX;
        state.baitY = state.baitTargetY;
        state.baitMoving = false;
        if (!state.splashPlayed) {
          fishingV2PlaySfx('鱼饵落水');
          state.splashPlayed = true;
        }
        if (!state.fishBiting) {
          state.fishBiting = true;
          state.fishBiteAt = nowSec + 4 + Math.random() * 6;
        }
      }
    }

    if (state.gameState === 'fishing' && state.fishBiting && state.fishBiteAt > 0 && nowSec >= state.fishBiteAt) {
      if (!state.showRotationText && !state.fishEscaped) {
        state.requiredRotations = 2 + Math.floor(Math.random() * 4);
        state.showRotationText = true;
        state.rotationTextBlink = true;
        state.rotationBlinkT = 0;
        state.fishEscapeAt = nowSec + 3 + Math.random() * 2;
        state.angleRefDeg = state.motorRawDeg;
        state.motorRotations = 0;
        fishingV2SendHardware('FISH_BITE_START');
        fishingV2PlaySfx('有鱼上钩');
      }
    }

    if (state.showRotationText) {
      state.rotationBlinkT += dt;
      if (state.rotationBlinkT >= 250) {
        state.rotationBlinkT = 0;
        state.rotationTextBlink = !state.rotationTextBlink;
      }
    }

    if (state.gameState === 'fishing' && state.showRotationText && !state.fishEscaped && nowSec >= state.fishEscapeAt) {
      state.fishEscaped = true;
      state.showRotationText = false;
      fishingV2PlaySfx('鱼儿跑掉');
      if (state.castCount < maxCasts) {
        state.fishBiting = false;
        state.fishBiteAt = 0;
        state.fishEscaped = false;
        state.baitX = layout.rodTopX;
        state.baitY = layout.rodTopY;
        const land = pickBaitLanding();
        state.baitTargetX = land.x;
        state.baitTargetY = land.y;
        state.baitMoving = true;
        state.baitVisible = true;
        state.castCount += 1;
        fishingV2PlaySfx('甩杆声音');
        state.splashPlayed = false;
        fishingV2SendHardware('RESET');
      } else {
        state.fishBiting = false;
        state.fishBiteAt = 0;
        state.fishEscaped = false;
        state.gameState = 'result';
        state.viewDataState = 'data_dashboard';
        state.dashboardAt = nowSec;
        state.currentFishType = null;
        fishingV2SendHardware('RESET');
      }
    }

    if (nowSec - state.lastJumpAt > 1 && state.gyroJump) {
      state.gyroJump = false;
      state.lastJumpAt = nowSec;
      if (state.gameState === 'start') {
        beginFromStartScreen();
      } else if (state.gameState === 'result' && state.viewDataState === 'normal') {
        onResultGyroShakeFromParent();
      } else if (state.gameState === 'result' && state.viewDataState === 'data_dashboard' && dashboardWaitDone()) {
        backToHomeFromDashboard();
      }
    }

    if (state.gameState === 'fishing' && !state.catMoving && state.showRotationText) {
      if (state.keySimRot !== 0) {
        state.motorRawDeg += state.keySimRot * 4.5 * (dt / (1000 / 60));
        updateMotorFromRaw(state.motorRawDeg);
      }
      if (state.motorRotations >= state.requiredRotations) {
        state.gameState = 'result';
        state.viewDataState = 'normal';
        state.currentFishType = FISHING_V2_FISH_TYPES[Math.floor(Math.random() * FISHING_V2_FISH_TYPES.length)];
        state.fishCount += 1;
        state.fishWeight += FISHING_V2_FISH_WEIGHTS[state.currentFishType];
        fishingV2PlaySfx('成功音效');
        fishingV2SendHardware('FISH_CAUGHT');
        state.motorRawDeg = 0;
        state.angleRefDeg = 0;
        state.motorRotations = 0;
        resetBaitState();
        state.fishEscaped = false;
        fishingV2SendHardware('RESET');
      }
    }
  }

  gameState.fishing = state;

  window._fishingHandleDirection = function () {};
  window._fishingHandleButton = function (pressed, source) {
    if (source !== 'port1' || !pressed) return;
    if (state.gameState === 'result' && state.viewDataState === 'normal') {
      state.gyroJump = true;
    } else if (state.gameState === 'result' && state.viewDataState === 'data_dashboard' && dashboardWaitDone()) {
      state.gyroJump = true;
    }
  };
  window._fishingHandleDegree = function (value, source) {
    if (source !== 'port1') return;
    updateMotorFromRaw(value);
  };
  window._fishingHandleRawJoy = function () {};
  window._fishingHandleFishCast = function (source) {
    if (source !== 'port1') return;
    state.gyroJump = true;
  };
  window._fishingHandleFishReel = function (delta, source) {
    if (source !== 'port1' || state.gameState !== 'fishing') return;
    if (!state.catMoving && state.showRotationText) {
      state.motorRawDeg += delta;
      updateMotorFromRaw(state.motorRawDeg);
    }
  };
  window._fishingHandleFishShake = function () {};
  window._fishingHandleMotorRawDeg = function (rawDeg, source) {
    if (source !== 'port1') return;
    updateMotorFromRaw(rawDeg);
  };
  window._fishingHandleGyroShake = function (source) {
    if (source !== 'port1') return;
    state.gyroJump = true;
  };

  function onKeyDown(e) {
    if (currentGame !== 'fishing') return;
    const k = e.key;
    if (k === 'a' || k === 'A' || k === 'ArrowLeft') state.keySimRot = -1;
    if (k === 'd' || k === 'D' || k === 'ArrowRight') state.keySimRot = 1;
    if (k === ' ' || k === 'Enter') {
      if (state.gameState === 'result' && state.viewDataState === 'data_dashboard') {
        if (dashboardWaitDone()) backToHomeFromDashboard();
        return;
      }
      state.gyroJump = true;
    }
  }
  function onKeyUp(e) {
    if (currentGame !== 'fishing') return;
    const k = e.key;
    if (k === 'a' || k === 'A' || k === 'ArrowLeft' || k === 'd' || k === 'D' || k === 'ArrowRight') state.keySimRot = 0;
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  gameState._jumpCleanup = function () {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    if (bgm) {
      bgm.pause();
      bgm.currentTime = 0;
    }
  };

  if (gameAnimationId) cancelAnimationFrame(gameAnimationId);

  function loop() {
    gameAnimationId = requestAnimationFrame(loop);
    const t = performance.now();
    update(t);
    ctx.clearRect(0, 0, W, H);
    drawFrame();
  }

  if (bgm) bgm.play().catch(() => {});
  loop();
}

// === 钓鱼游戏串口外部处理函数（兼容现有路由模式） ===
function fishingHandleDirection(dir, source) {
  if (window._fishingHandleDirection) window._fishingHandleDirection(dir, source);
}
function fishingHandleButton(pressed, source) {
  if (window._fishingHandleButton) window._fishingHandleButton(pressed, source);
}
// ========== 🎯 体感平衡球 (Gyro Balance Ball) ==========
function startGyroBalance() {
  const W = gameCanvas.width, H = gameCanvas.height;
  const ctx = gameCtx;

  // ===== 关卡定义 =====
  const LEVELS = [
    {
      name: '新手训练场',
      timeLimit: 60,
      walls: [
        // 外围边框由代码自动生成
        // 内部障碍
        { x: 200, y: 100, w: 20, h: 200 },
        { x: 350, y: 200, w: 200, h: 20 },
        { x: 500, y: 50, w: 20, h: 180 },
        { x: 100, y: 350, w: 250, h: 20 },
        { x: 450, y: 300, w: 20, h: 150 },
      ],
      stars: [
        { x: 120, y: 80 }, { x: 300, y: 150 }, { x: 600, y: 100 },
        { x: 450, y: 400 }, { x: 200, y: 430 },
      ],
      traps: [
        { x: 280, y: 280, r: 20 },
        { x: 550, y: 350, r: 20 },
      ],
      startX: 60, startY: 60,
      goalX: 680, goalY: 440,
    },
    {
      name: '曲折迷宫',
      timeLimit: 90,
      walls: [
        { x: 150, y: 0, w: 20, h: 300 },
        { x: 300, y: 200, w: 20, h: 300 },
        { x: 450, y: 0, w: 20, h: 320 },
        { x: 600, y: 180, w: 20, h: 320 },
        { x: 150, y: 300, w: 100, h: 20 },
        { x: 300, y: 200, w: 100, h: 20 },
        { x: 450, y: 320, w: 120, h: 20 },
        { x: 0, y: 200, w: 100, h: 20 },
      ],
      stars: [
        { x: 80, y: 400 }, { x: 230, y: 100 }, { x: 380, y: 350 },
        { x: 530, y: 100 }, { x: 670, y: 400 }, { x: 380, y: 50 },
      ],
      traps: [
        { x: 230, y: 400, r: 18 },
        { x: 530, y: 250, r: 18 },
        { x: 80, y: 150, r: 16 },
      ],
      startX: 60, startY: 60,
      goalX: 690, goalY: 450,
    },
    {
      name: '星际挑战',
      timeLimit: 120,
      walls: [
        { x: 100, y: 80, w: 20, h: 200 },
        { x: 100, y: 80, w: 200, h: 20 },
        { x: 300, y: 80, w: 20, h: 120 },
        { x: 200, y: 280, w: 200, h: 20 },
        { x: 400, y: 150, w: 20, h: 150 },
        { x: 400, y: 150, w: 150, h: 20 },
        { x: 550, y: 50, w: 20, h: 250 },
        { x: 250, y: 380, w: 20, h: 120 },
        { x: 250, y: 380, w: 200, h: 20 },
        { x: 450, y: 300, w: 200, h: 20 },
        { x: 650, y: 300, w: 20, h: 120 },
        { x: 500, y: 420, w: 170, h: 20 },
        { x: 100, y: 380, w: 100, h: 20 },
        { x: 100, y: 380, w: 20, h: 100 },
      ],
      stars: [
        { x: 60, y: 450 }, { x: 200, y: 180 }, { x: 350, y: 130 },
        { x: 500, y: 250 }, { x: 650, y: 80 }, { x: 350, y: 440 },
        { x: 600, y: 380 }, { x: 150, y: 330 },
      ],
      traps: [
        { x: 200, y: 200, r: 15 },
        { x: 480, y: 240, r: 18 },
        { x: 350, y: 340, r: 16 },
        { x: 620, y: 200, r: 15 },
        { x: 150, y: 440, r: 14 },
      ],
      startX: 50, startY: 50,
      goalX: 690, goalY: 450,
    },
  ];

  // ===== 游戏常量 =====
  const BALL_R = 12;
  const WALL_THICK = 14; // 边框厚度
  const GRAVITY_SCALE = 0.45; // 陀螺仪倾斜 → 加速度系数
  const FRICTION = 0.97;
  const BOUNCE = 0.4;
  const STAR_R = 14;
  const GOAL_R = 22;
  const TRAP_PULSE_SPEED = 0.04;
  const MAX_SPEED = 8;
  const KEYBOARD_ACCEL = 0.6; // 键盘模拟倾斜加速度

  // ===== 游戏状态 =====
  const gs = {
    level: 0,
    phase: 'menu', // 'menu' | 'play' | 'win' | 'dead' | 'allclear'
    ball: { x: 0, y: 0, vx: 0, vy: 0 },
    stars: [],
    starsCollected: 0,
    totalStarsCollected: 0,
    timer: 0,
    startTime: 0,
    // 陀螺仪数据
    gyroPitch: 0, // 前后倾斜
    gyroRoll: 0,  // 左右倾斜
    gyroYaw: 0,
    gyroCalibPitch: 0, // 校准偏移
    gyroCalibRoll: 0,
    calibrating: false,
    calibSamples: [],
    // 键盘模拟
    keyTilt: { x: 0, y: 0 },
    // 粒子系统
    particles: [],
    // 动画
    trailPoints: [],
    goalAngle: 0,
    // UI
    sensitivity: 1.0,
    highScore: parseInt(localStorage.getItem('gyro-highscore') || '0'),
    menuSelection: 0, // 0=开始, 1=关卡选择
    levelSelectIdx: 0,
  };

  gameState = { keys: gameState.keys || {}, gyro: gs };

  // ===== 粒子系统 =====
  function spawnParticles(x, y, color, count, speedMul) {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (1 + Math.random() * 3) * (speedMul || 1);
      gs.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: 0.02 + Math.random() * 0.03,
        r: 2 + Math.random() * 3,
        color,
      });
    }
  }

  function updateParticles() {
    for (let i = gs.particles.length - 1; i >= 0; i--) {
      const p = gs.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= p.decay;
      if (p.life <= 0) gs.particles.splice(i, 1);
    }
  }

  function drawParticles() {
    for (const p of gs.particles) {
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ===== 碰撞检测 =====
  function ballWallCollision(bx, by, bvx, bvy, walls) {
    let nx = bx, ny = by, nvx = bvx, nvy = bvy;

    for (const w of walls) {
      // 找到球心到矩形最近点
      const closestX = Math.max(w.x, Math.min(nx, w.x + w.w));
      const closestY = Math.max(w.y, Math.min(ny, w.y + w.h));
      const dx = nx - closestX;
      const dy = ny - closestY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < BALL_R) {
        // 碰撞！
        if (dist === 0) {
          // 球心在墙内，推出
          nx = closestX + BALL_R;
          ny = closestY + BALL_R;
        } else {
          const overlap = BALL_R - dist;
          const normX = dx / dist;
          const normY = dy / dist;
          nx += normX * overlap;
          ny += normY * overlap;

          // 反弹速度
          const dot = nvx * normX + nvy * normY;
          if (dot < 0) {
            nvx -= (1 + BOUNCE) * dot * normX;
            nvy -= (1 + BOUNCE) * dot * normY;
          }
        }
      }
    }

    return { x: nx, y: ny, vx: nvx, vy: nvy };
  }

  // ===== 关卡数据生成（含边框） =====
  function getLevelWalls(levelIdx) {
    const lv = LEVELS[levelIdx];
    // 生成边框墙壁
    const border = [
      { x: 0, y: 0, w: W, h: WALL_THICK },          // 上
      { x: 0, y: H - WALL_THICK, w: W, h: WALL_THICK }, // 下
      { x: 0, y: 0, w: WALL_THICK, h: H },           // 左
      { x: W - WALL_THICK, y: 0, w: WALL_THICK, h: H }, // 右
    ];
    return [...border, ...lv.walls];
  }

  function initLevel(levelIdx) {
    const lv = LEVELS[levelIdx];
    gs.level = levelIdx;
    gs.ball = { x: lv.startX, y: lv.startY, vx: 0, vy: 0 };
    gs.stars = lv.stars.map(s => ({ ...s, collected: false }));
    gs.starsCollected = 0;
    gs.timer = lv.timeLimit;
    gs.startTime = Date.now();
    gs.particles = [];
    gs.trailPoints = [];
    gs.phase = 'play';
  }

  // ===== 串口事件挂载 =====
  window._gyroHandleGyro = function(pitch, roll, yaw, source) {
    gs.gyroPitch = pitch - gs.gyroCalibPitch;
    gs.gyroRoll  = roll  - gs.gyroCalibRoll;
    gs.gyroYaw   = yaw;
  };

  window._gyroHandleDirection = function(dir, source) {
    // JOY 方向可作为备用控制
    const keyMap = { UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight' };
    if (keyMap[dir]) {
      gameState.keys = gameState.keys || {};
      gameState.keys[keyMap[dir]] = true;
      setTimeout(() => { gameState.keys[keyMap[dir]] = false; }, 200);
    }

    // 菜单导航
    if (gs.phase === 'menu') {
      if (dir === 'UP') gs.menuSelection = Math.max(0, gs.menuSelection - 1);
      if (dir === 'DOWN') gs.menuSelection = Math.min(1, gs.menuSelection + 1);
      if (dir === 'LEFT' && gs.menuSelection === 1) gs.levelSelectIdx = Math.max(0, gs.levelSelectIdx - 1);
      if (dir === 'RIGHT' && gs.menuSelection === 1) gs.levelSelectIdx = Math.min(LEVELS.length - 1, gs.levelSelectIdx + 1);
    }
  };

  window._gyroHandleButton = function(pressed, source) {
    if (!pressed) return;

    if (gs.phase === 'menu') {
      if (gs.menuSelection === 0) {
        initLevel(0);
      } else {
        initLevel(gs.levelSelectIdx);
      }
    } else if (gs.phase === 'play') {
      // 长按校准（用 calibrating 标记简化）
      gs.calibrating = true;
      gs.calibSamples = [];
      setTimeout(() => {
        if (gs.calibrating && gs.calibSamples.length > 5) {
          const avgP = gs.calibSamples.reduce((s, v) => s + v.p, 0) / gs.calibSamples.length;
          const avgR = gs.calibSamples.reduce((s, v) => s + v.r, 0) / gs.calibSamples.length;
          gs.gyroCalibPitch = avgP;
          gs.gyroCalibRoll = avgR;
          spawnParticles(gs.ball.x, gs.ball.y, '#22d3ee', 15, 1.5);
        }
        gs.calibrating = false;
      }, 1000);
    } else if (gs.phase === 'win') {
      if (gs.level < LEVELS.length - 1) {
        initLevel(gs.level + 1);
      } else {
        gs.phase = 'allclear';
      }
    } else if (gs.phase === 'dead' || gs.phase === 'allclear') {
      gs.phase = 'menu';
      gs.menuSelection = 0;
    }
  };

  window._gyroHandleRawJoy = function(x, y, source) {
    // RAW_JOY 也可作为控制（摇杆模拟倾斜）
    // x, y 范围大约 0~4095，中心约 2048
    const nx = (x - 2048) / 2048; // -1 ~ +1
    const ny = (y - 2048) / 2048;
    gs.gyroRoll = nx * 30 * gs.sensitivity;  // 模拟 ±30 度
    gs.gyroPitch = ny * 30 * gs.sensitivity;
  };

  // 收集校准样本
  const origGyroHandler = window._gyroHandleGyro;
  window._gyroHandleGyro = function(pitch, roll, yaw, source) {
    if (gs.calibrating) {
      gs.calibSamples.push({ p: pitch, r: roll });
    }
    gs.gyroPitch = (pitch - gs.gyroCalibPitch) * gs.sensitivity;
    gs.gyroRoll  = (roll  - gs.gyroCalibRoll) * gs.sensitivity;
    gs.gyroYaw   = yaw;
  };

  // ===== 渲染函数 =====
  function drawBackground() {
    // 深色科技感背景
    const grad = ctx.createRadialGradient(W / 2, H / 2, 50, W / 2, H / 2, W * 0.7);
    grad.addColorStop(0, '#1a1d2e');
    grad.addColorStop(1, '#0d0f17');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // 网格线
    ctx.strokeStyle = 'rgba(108, 114, 255, 0.06)';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }

  function drawWalls(walls) {
    for (const w of walls) {
      // 墙壁发光效果
      ctx.shadowColor = 'rgba(108, 114, 255, 0.4)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#3d4266';
      ctx.fillRect(w.x, w.y, w.w, w.h);

      // 内部高光
      ctx.shadowBlur = 0;
      const wallGrad = ctx.createLinearGradient(w.x, w.y, w.x, w.y + w.h);
      wallGrad.addColorStop(0, 'rgba(108, 114, 255, 0.3)');
      wallGrad.addColorStop(1, 'rgba(108, 114, 255, 0.05)');
      ctx.fillStyle = wallGrad;
      ctx.fillRect(w.x + 1, w.y + 1, w.w - 2, w.h - 2);
    }
    ctx.shadowBlur = 0;
  }

  function drawTraps(traps, time) {
    for (const trap of traps) {
      const pulse = Math.sin(time * TRAP_PULSE_SPEED) * 0.3 + 0.7;
      // 外圈
      ctx.beginPath();
      ctx.arc(trap.x, trap.y, trap.r + 4, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(248, 113, 113, ${0.15 * pulse})`;
      ctx.fill();
      // 核心
      ctx.beginPath();
      ctx.arc(trap.x, trap.y, trap.r, 0, Math.PI * 2);
      const trapGrad = ctx.createRadialGradient(trap.x, trap.y, 0, trap.x, trap.y, trap.r);
      trapGrad.addColorStop(0, `rgba(248, 113, 113, ${0.9 * pulse})`);
      trapGrad.addColorStop(1, `rgba(200, 50, 50, ${0.6 * pulse})`);
      ctx.fillStyle = trapGrad;
      ctx.fill();
      // ✕ 标记
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 * pulse})`;
      ctx.lineWidth = 2;
      const s = trap.r * 0.5;
      ctx.beginPath(); ctx.moveTo(trap.x - s, trap.y - s); ctx.lineTo(trap.x + s, trap.y + s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(trap.x + s, trap.y - s); ctx.lineTo(trap.x - s, trap.y + s); ctx.stroke();
    }
  }

  function drawStars(stars, time) {
    for (const star of stars) {
      if (star.collected) continue;
      const bob = Math.sin(time * 0.05 + star.x * 0.1) * 3;
      const sparkle = Math.sin(time * 0.08 + star.y * 0.1) * 0.3 + 0.7;

      ctx.save();
      ctx.translate(star.x, star.y + bob);

      // 光晕
      ctx.shadowColor = `rgba(251, 191, 36, ${sparkle * 0.6})`;
      ctx.shadowBlur = 15;

      // 五角星
      ctx.fillStyle = `rgba(251, 191, 36, ${sparkle})`;
      ctx.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i * 72 - 90) * Math.PI / 180;
        const ax = Math.cos(a) * STAR_R;
        const ay = Math.sin(a) * STAR_R;
        const b = ((i * 72 + 36) - 90) * Math.PI / 180;
        const bx = Math.cos(b) * STAR_R * 0.4;
        const by = Math.sin(b) * STAR_R * 0.4;
        if (i === 0) ctx.moveTo(ax, ay);
        else ctx.lineTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }

  function drawGoal(x, y, time) {
    gs.goalAngle += 0.03;
    const pulse = Math.sin(time * 0.06) * 0.3 + 0.7;

    // 外圈旋转
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(gs.goalAngle);

    ctx.shadowColor = `rgba(52, 211, 153, ${pulse * 0.6})`;
    ctx.shadowBlur = 20;

    // 外环
    ctx.strokeStyle = `rgba(52, 211, 153, ${pulse * 0.7})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * 45) * Math.PI / 180;
      const r1 = GOAL_R - 2;
      const r2 = GOAL_R + 5;
      ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
    }
    ctx.stroke();

    // 内部
    const goalGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, GOAL_R);
    goalGrad.addColorStop(0, `rgba(52, 211, 153, ${0.8 * pulse})`);
    goalGrad.addColorStop(0.7, `rgba(52, 211, 153, ${0.3 * pulse})`);
    goalGrad.addColorStop(1, 'rgba(52, 211, 153, 0)');
    ctx.fillStyle = goalGrad;
    ctx.beginPath();
    ctx.arc(0, 0, GOAL_R, 0, Math.PI * 2);
    ctx.fill();

    // ★ 标记
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', 0, 0);

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function drawBall(x, y, vx, vy) {
    // 拖尾
    gs.trailPoints.unshift({ x, y, t: 1 });
    if (gs.trailPoints.length > 15) gs.trailPoints.pop();
    for (let i = 1; i < gs.trailPoints.length; i++) {
      const tp = gs.trailPoints[i];
      tp.t -= 0.07;
      if (tp.t > 0) {
        ctx.beginPath();
        ctx.arc(tp.x, tp.y, BALL_R * tp.t * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(108, 114, 255, ${tp.t * 0.25})`;
        ctx.fill();
      }
    }

    // 球体
    ctx.shadowColor = 'rgba(108, 114, 255, 0.7)';
    ctx.shadowBlur = 15;
    const ballGrad = ctx.createRadialGradient(x - 3, y - 3, 2, x, y, BALL_R);
    ballGrad.addColorStop(0, '#a5b4fc');
    ballGrad.addColorStop(0.5, '#6c72ff');
    ballGrad.addColorStop(1, '#4338ca');
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(x, y, BALL_R, 0, Math.PI * 2);
    ctx.fill();

    // 高光
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.beginPath();
    ctx.arc(x - 3, y - 4, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // 速度方向指示器
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > 1) {
      const arrowLen = Math.min(speed * 3, 25);
      const ax = x + (vx / speed) * (BALL_R + arrowLen);
      const ay = y + (vy / speed) * (BALL_R + arrowLen);
      ctx.strokeStyle = `rgba(108, 114, 255, ${Math.min(speed / 5, 0.6)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x + (vx / speed) * BALL_R, y + (vy / speed) * BALL_R);
      ctx.lineTo(ax, ay);
      ctx.stroke();
    }
  }

  function drawHUD(time) {
    const lv = LEVELS[gs.level];

    // 顶部信息栏
    ctx.fillStyle = 'rgba(13, 15, 23, 0.7)';
    ctx.fillRect(0, 0, W, 38);

    ctx.font = 'bold 14px sans-serif';
    ctx.textBaseline = 'middle';

    // 关卡名
    ctx.fillStyle = '#6c72ff';
    ctx.textAlign = 'left';
    ctx.fillText(`Lv.${gs.level + 1}  ${lv.name}`, 15, 19);

    // 星星计数
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'center';
    ctx.fillText(`★ ${gs.starsCollected} / ${lv.stars.length}`, W / 2, 19);

    // 计时器
    const elapsed = (Date.now() - gs.startTime) / 1000;
    const remaining = Math.max(0, gs.timer - elapsed);
    const timeColor = remaining < 10 ? '#f87171' : remaining < 20 ? '#fbbf24' : '#34d399';
    ctx.fillStyle = timeColor;
    ctx.textAlign = 'right';
    ctx.fillText(`⏱ ${remaining.toFixed(1)}s`, W - 15, 19);

    // 倾斜指示器（右下角）
    const indX = W - 55;
    const indY = H - 55;
    const indR = 35;
    ctx.strokeStyle = 'rgba(108, 114, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(indX, indY, indR, 0, Math.PI * 2);
    ctx.stroke();
    // 十字线
    ctx.beginPath();
    ctx.moveTo(indX - indR, indY); ctx.lineTo(indX + indR, indY);
    ctx.moveTo(indX, indY - indR); ctx.lineTo(indX, indY + indR);
    ctx.stroke();
    // 倾斜点
    const tiltX = Math.max(-1, Math.min(1, gs.gyroRoll / 30));
    const tiltY = Math.max(-1, Math.min(1, gs.gyroPitch / 30));
    ctx.fillStyle = '#6c72ff';
    ctx.beginPath();
    ctx.arc(indX + tiltX * indR * 0.8, indY + tiltY * indR * 0.8, 5, 0, Math.PI * 2);
    ctx.fill();

    // 校准提示
    if (gs.calibrating) {
      ctx.fillStyle = 'rgba(34, 211, 238, 0.8)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('校准中...保持水平', W / 2, H - 15);
    }

    return remaining;
  }

  function drawMenu(time) {
    drawBackground();

    // 标题
    ctx.fillStyle = '#6c72ff';
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(108, 114, 255, 0.5)';
    ctx.shadowBlur = 20;
    ctx.fillText('🎯 体感平衡球', W / 2, 100);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#8b8fa3';
    ctx.font = '14px sans-serif';
    ctx.fillText('倾斜陀螺仪控制小球 · 收集星星到达终点', W / 2, 145);
    ctx.fillText('支持 GYRO 协议 / 摇杆 / 键盘WASD', W / 2, 168);

    // 菜单选项
    const items = ['🚀 开始游戏', '📋 选择关卡'];
    for (let i = 0; i < items.length; i++) {
      const y = 230 + i * 60;
      const selected = gs.menuSelection === i;
      const hoverPulse = selected ? Math.sin(time * 0.06) * 0.15 + 0.85 : 0.5;

      ctx.fillStyle = selected ? `rgba(108, 114, 255, ${0.15 * hoverPulse + 0.05})` : 'rgba(255,255,255,0.03)';
      ctx.strokeStyle = selected ? `rgba(108, 114, 255, ${hoverPulse})` : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = selected ? 2 : 1;

      // 圆角矩形
      const rx = W / 2 - 120, rw = 240, rh = 44, rr = 10;
      ctx.beginPath();
      ctx.moveTo(rx + rr, y - rh / 2);
      ctx.lineTo(rx + rw - rr, y - rh / 2);
      ctx.quadraticCurveTo(rx + rw, y - rh / 2, rx + rw, y - rh / 2 + rr);
      ctx.lineTo(rx + rw, y + rh / 2 - rr);
      ctx.quadraticCurveTo(rx + rw, y + rh / 2, rx + rw - rr, y + rh / 2);
      ctx.lineTo(rx + rr, y + rh / 2);
      ctx.quadraticCurveTo(rx, y + rh / 2, rx, y + rh / 2 - rr);
      ctx.lineTo(rx, y - rh / 2 + rr);
      ctx.quadraticCurveTo(rx, y - rh / 2, rx + rr, y - rh / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = selected ? '#e4e6ed' : '#8b8fa3';
      ctx.font = selected ? 'bold 16px sans-serif' : '16px sans-serif';
      ctx.fillText(items[i], W / 2, y);
    }

    // 关卡选择（当选中第二项时）
    if (gs.menuSelection === 1) {
      const lsy = 330;
      ctx.fillStyle = '#8b8fa3';
      ctx.font = '13px sans-serif';
      ctx.fillText('← →  选择关卡', W / 2, lsy);

      for (let i = 0; i < LEVELS.length; i++) {
        const lx = W / 2 + (i - gs.levelSelectIdx) * 100;
        const isSel = i === gs.levelSelectIdx;
        ctx.fillStyle = isSel ? '#6c72ff' : '#3d4255';
        ctx.font = isSel ? 'bold 14px sans-serif' : '13px sans-serif';
        ctx.globalAlpha = isSel ? 1 : 0.5;
        ctx.fillText(`Lv.${i + 1}`, lx, lsy + 30);
        ctx.font = '11px sans-serif';
        ctx.fillText(LEVELS[i].name, lx, lsy + 48);
        ctx.globalAlpha = 1;
      }
    }

    // 最高分
    if (gs.highScore > 0) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = '13px sans-serif';
      ctx.fillText(`最高分: ${gs.highScore}`, W / 2, 420);
    }

    // 操作提示
    ctx.fillStyle = '#555';
    ctx.font = '12px sans-serif';
    ctx.fillText('键盘: WASD/方向键控制 · 空格/回车确认 · 串口: GYRO/JOY/BTN', W / 2, H - 30);
  }

  function drawWinScreen(time) {
    drawBackground();

    ctx.fillStyle = '#34d399';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(52, 211, 153, 0.5)';
    ctx.shadowBlur = 15;
    ctx.fillText('🎉 关卡完成！', W / 2, 150);
    ctx.shadowBlur = 0;

    const lv = LEVELS[gs.level];
    ctx.fillStyle = '#e4e6ed';
    ctx.font = '18px sans-serif';
    ctx.fillText(`${lv.name}`, W / 2, 200);

    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`★ ${gs.starsCollected} / ${lv.stars.length}`, W / 2, 240);

    const elapsed = (gs._winTime - gs.startTime) / 1000;
    ctx.fillStyle = '#8b8fa3';
    ctx.font = '16px sans-serif';
    ctx.fillText(`用时: ${elapsed.toFixed(1)}s`, W / 2, 275);

    // 分数计算
    const starScore = gs.starsCollected * 100;
    const timeBonus = Math.max(0, Math.floor((gs.timer - elapsed) * 10));
    const total = starScore + timeBonus;
    ctx.fillStyle = '#6c72ff';
    ctx.font = 'bold 22px sans-serif';
    ctx.fillText(`得分: ${total}`, W / 2, 320);

    if (gs.level < LEVELS.length - 1) {
      ctx.fillStyle = '#34d399';
      ctx.font = '15px sans-serif';
      ctx.fillText('按 空格/BTN 进入下一关', W / 2, 380);
    } else {
      ctx.fillStyle = '#fbbf24';
      ctx.font = '15px sans-serif';
      ctx.fillText('按 空格/BTN 查看总结', W / 2, 380);
    }
  }

  function drawDeadScreen(time) {
    drawBackground();

    const pulse = Math.sin(time * 0.05) * 0.2 + 0.8;
    ctx.fillStyle = `rgba(248, 113, 113, ${pulse})`;
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('💀 失败！', W / 2, 180);

    ctx.fillStyle = '#8b8fa3';
    ctx.font = '16px sans-serif';
    ctx.fillText(gs._deathReason || '掉入陷阱', W / 2, 230);

    ctx.fillStyle = '#e4e6ed';
    ctx.font = '14px sans-serif';
    ctx.fillText('按 空格/BTN 返回菜单', W / 2, 300);
  }

  function drawAllClearScreen(time) {
    drawBackground();

    const rainbow = `hsl(${(time * 2) % 360}, 80%, 65%)`;
    ctx.fillStyle = rainbow;
    ctx.font = 'bold 36px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = rainbow;
    ctx.shadowBlur = 20;
    ctx.fillText('🏆 全部通关！', W / 2, 130);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(`总星星: ${gs.totalStarsCollected}`, W / 2, 200);

    // 计算总分
    const totalScore = gs.totalStarsCollected * 100;
    if (totalScore > gs.highScore) {
      gs.highScore = totalScore;
      localStorage.setItem('gyro-highscore', String(totalScore));
    }
    ctx.fillStyle = '#6c72ff';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText(`总分: ${totalScore}`, W / 2, 245);

    if (totalScore >= gs.highScore) {
      ctx.fillStyle = '#34d399';
      ctx.font = '14px sans-serif';
      ctx.fillText('🎉 新纪录！', W / 2, 280);
    }

    ctx.fillStyle = '#8b8fa3';
    ctx.font = '14px sans-serif';
    ctx.fillText('按 空格/BTN 返回菜单', W / 2, 340);
  }

  // ===== 键盘控制支持 =====
  function handleKeyboard() {
    const keys = gameState.keys || {};
    gs.keyTilt.x = 0;
    gs.keyTilt.y = 0;

    if (keys['ArrowLeft'] || keys['a'] || keys['A']) gs.keyTilt.x = -KEYBOARD_ACCEL;
    if (keys['ArrowRight'] || keys['d'] || keys['D']) gs.keyTilt.x = KEYBOARD_ACCEL;
    if (keys['ArrowUp'] || keys['w'] || keys['W']) gs.keyTilt.y = -KEYBOARD_ACCEL;
    if (keys['ArrowDown'] || keys['s'] || keys['S']) gs.keyTilt.y = KEYBOARD_ACCEL;

    // 菜单控制
    if (gs.phase === 'menu') {
      // 使用 debounce 来处理菜单导航
      if (!gs._menuKeyLock) {
        if (keys['ArrowUp'] || keys['w'] || keys['W']) {
          gs.menuSelection = Math.max(0, gs.menuSelection - 1);
          gs._menuKeyLock = true;
          setTimeout(() => { gs._menuKeyLock = false; }, 200);
        }
        if (keys['ArrowDown'] || keys['s'] || keys['S']) {
          gs.menuSelection = Math.min(1, gs.menuSelection + 1);
          gs._menuKeyLock = true;
          setTimeout(() => { gs._menuKeyLock = false; }, 200);
        }
        if (keys['ArrowLeft'] || keys['a'] || keys['A']) {
          if (gs.menuSelection === 1) gs.levelSelectIdx = Math.max(0, gs.levelSelectIdx - 1);
          gs._menuKeyLock = true;
          setTimeout(() => { gs._menuKeyLock = false; }, 200);
        }
        if (keys['ArrowRight'] || keys['d'] || keys['D']) {
          if (gs.menuSelection === 1) gs.levelSelectIdx = Math.min(LEVELS.length - 1, gs.levelSelectIdx + 1);
          gs._menuKeyLock = true;
          setTimeout(() => { gs._menuKeyLock = false; }, 200);
        }
        if (keys[' '] || keys['Enter']) {
          if (gs.menuSelection === 0) initLevel(0);
          else initLevel(gs.levelSelectIdx);
          gs._menuKeyLock = true;
          setTimeout(() => { gs._menuKeyLock = false; }, 300);
        }
      }
    }

    // 结果界面空格确认
    if (!gs._menuKeyLock) {
      if (keys[' '] || keys['Enter']) {
        if (gs.phase === 'win') {
          gs._menuKeyLock = true;
          setTimeout(() => { gs._menuKeyLock = false; }, 300);
          if (gs.level < LEVELS.length - 1) {
            initLevel(gs.level + 1);
          } else {
            gs.phase = 'allclear';
          }
        } else if (gs.phase === 'dead' || gs.phase === 'allclear') {
          gs._menuKeyLock = true;
          setTimeout(() => { gs._menuKeyLock = false; }, 300);
          gs.phase = 'menu';
          gs.menuSelection = 0;
        }
      }
    }
  }

  // ===== 鼠标/触摸控制 =====
  let _gyroMouseDown = false;
  let _gyroMouseX = 0, _gyroMouseY = 0;

  function onCanvasMouseDown(e) {
    e.preventDefault();
    const rect = gameCanvas.getBoundingClientRect();
    const cx = (e.clientX || e.touches[0].clientX) - rect.left;
    const cy = (e.clientY || e.touches[0].clientY) - rect.top;
    const sx = cx / rect.width * W;
    const sy = cy / rect.height * H;

    _gyroMouseDown = true;
    _gyroMouseX = sx;
    _gyroMouseY = sy;

    // 菜单点击检测
    if (gs.phase === 'menu') {
      // 开始游戏按钮区域
      if (sx > W / 2 - 120 && sx < W / 2 + 120) {
        if (sy > 208 && sy < 252) {
          initLevel(gs.menuSelection === 1 ? gs.levelSelectIdx : 0);
        } else if (sy > 268 && sy < 312) {
          gs.menuSelection = 1;
        }
      }
    } else if (gs.phase === 'win' || gs.phase === 'dead' || gs.phase === 'allclear') {
      // 点击任意位置继续
      if (gs.phase === 'win') {
        if (gs.level < LEVELS.length - 1) initLevel(gs.level + 1);
        else gs.phase = 'allclear';
      } else {
        gs.phase = 'menu';
        gs.menuSelection = 0;
      }
    }
  }

  function onCanvasMouseMove(e) {
    if (!_gyroMouseDown || gs.phase !== 'play') return;
    const rect = gameCanvas.getBoundingClientRect();
    const cx = (e.clientX || (e.touches && e.touches[0].clientX)) - rect.left;
    const cy = (e.clientY || (e.touches && e.touches[0].clientY)) - rect.top;
    _gyroMouseX = cx / rect.width * W;
    _gyroMouseY = cy / rect.height * H;
  }

  function onCanvasMouseUp(e) {
    _gyroMouseDown = false;
  }

  gameCanvas.addEventListener('mousedown', onCanvasMouseDown);
  gameCanvas.addEventListener('mousemove', onCanvasMouseMove);
  gameCanvas.addEventListener('mouseup', onCanvasMouseUp);
  gameCanvas.addEventListener('touchstart', onCanvasMouseDown, { passive: false });
  gameCanvas.addEventListener('touchmove', onCanvasMouseMove, { passive: false });
  gameCanvas.addEventListener('touchend', onCanvasMouseUp);

  // ===== 主游戏循环 =====
  let _frameCount = 0;

  function gameLoop() {
    gameAnimationId = requestAnimationFrame(gameLoop);
    _frameCount++;
    const time = _frameCount;

    handleKeyboard();

    if (gs.phase === 'menu') {
      drawMenu(time);
      return;
    }

    if (gs.phase === 'win') {
      drawWinScreen(time);
      return;
    }

    if (gs.phase === 'dead') {
      drawDeadScreen(time);
      return;
    }

    if (gs.phase === 'allclear') {
      drawAllClearScreen(time);
      return;
    }

    // ===== Play Phase =====
    const lv = LEVELS[gs.level];
    const walls = getLevelWalls(gs.level);

    // 计算重力加速度（来自陀螺仪 + 键盘 + 鼠标拖拽）
    let ax = gs.gyroRoll * GRAVITY_SCALE * 0.1;   // roll → X
    let ay = gs.gyroPitch * GRAVITY_SCALE * 0.1;  // pitch → Y

    // 键盘叠加
    ax += gs.keyTilt.x;
    ay += gs.keyTilt.y;

    // 鼠标/触摸拖拽
    if (_gyroMouseDown && gs.phase === 'play') {
      const dx = _gyroMouseX - gs.ball.x;
      const dy = _gyroMouseY - gs.ball.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 5) {
        ax += (dx / dist) * 0.4;
        ay += (dy / dist) * 0.4;
      }
    }

    // 更新球速度
    gs.ball.vx += ax;
    gs.ball.vy += ay;

    // 摩擦力
    gs.ball.vx *= FRICTION;
    gs.ball.vy *= FRICTION;

    // 限速
    const speed = Math.sqrt(gs.ball.vx * gs.ball.vx + gs.ball.vy * gs.ball.vy);
    if (speed > MAX_SPEED) {
      gs.ball.vx = (gs.ball.vx / speed) * MAX_SPEED;
      gs.ball.vy = (gs.ball.vy / speed) * MAX_SPEED;
    }

    // 移动球
    gs.ball.x += gs.ball.vx;
    gs.ball.y += gs.ball.vy;

    // 碰撞检测
    const col = ballWallCollision(gs.ball.x, gs.ball.y, gs.ball.vx, gs.ball.vy, walls);
    gs.ball.x = col.x;
    gs.ball.y = col.y;
    gs.ball.vx = col.vx;
    gs.ball.vy = col.vy;

    // 边界安全
    gs.ball.x = Math.max(BALL_R, Math.min(W - BALL_R, gs.ball.x));
    gs.ball.y = Math.max(BALL_R, Math.min(H - BALL_R, gs.ball.y));

    // 收集星星
    for (const star of gs.stars) {
      if (star.collected) continue;
      const dx = gs.ball.x - star.x;
      const dy = gs.ball.y - star.y;
      if (dx * dx + dy * dy < (BALL_R + STAR_R) * (BALL_R + STAR_R)) {
        star.collected = true;
        gs.starsCollected++;
        gs.totalStarsCollected++;
        spawnParticles(star.x, star.y, '#fbbf24', 12, 1.2);
      }
    }

    // 陷阱检测
    for (const trap of lv.traps) {
      const dx = gs.ball.x - trap.x;
      const dy = gs.ball.y - trap.y;
      if (dx * dx + dy * dy < (BALL_R + trap.r) * (BALL_R + trap.r)) {
        gs._deathReason = '掉入陷阱！';
        gs.phase = 'dead';
        spawnParticles(gs.ball.x, gs.ball.y, '#f87171', 25, 2);
        return;
      }
    }

    // 到达终点
    const gdx = gs.ball.x - lv.goalX;
    const gdy = gs.ball.y - lv.goalY;
    if (gdx * gdx + gdy * gdy < (BALL_R + GOAL_R) * (BALL_R + GOAL_R)) {
      gs._winTime = Date.now();
      gs.phase = 'win';
      spawnParticles(lv.goalX, lv.goalY, '#34d399', 30, 2);
      return;
    }

    // 超时
    const elapsed = (Date.now() - gs.startTime) / 1000;
    if (elapsed >= gs.timer) {
      gs._deathReason = '时间耗尽！';
      gs.phase = 'dead';
      return;
    }

    // 更新粒子
    updateParticles();

    // ===== 渲染 =====
    drawBackground();
    drawWalls(walls);
    drawTraps(lv.traps, time);
    drawStars(gs.stars, time);
    drawGoal(lv.goalX, lv.goalY, time);
    drawBall(gs.ball.x, gs.ball.y, gs.ball.vx, gs.ball.vy);
    drawParticles();
    drawHUD(time);
  }

  // 清理函数
  gameState._jumpCleanup = function() {
    gameCanvas.removeEventListener('mousedown', onCanvasMouseDown);
    gameCanvas.removeEventListener('mousemove', onCanvasMouseMove);
    gameCanvas.removeEventListener('mouseup', onCanvasMouseUp);
    gameCanvas.removeEventListener('touchstart', onCanvasMouseDown);
    gameCanvas.removeEventListener('touchmove', onCanvasMouseMove);
    gameCanvas.removeEventListener('touchend', onCanvasMouseUp);
    window._gyroHandleGyro = null;
    window._gyroHandleDirection = null;
    window._gyroHandleButton = null;
    window._gyroHandleRawJoy = null;
  };

  // 启动
  gs.phase = 'menu';
  gameLoop();
}

// ========== 即将上线占位 ==========
function drawComingSoon(gameId) {
  const W = gameCanvas.width, H = gameCanvas.height;
  const ctx = gameCtx;
  ctx.fillStyle = '#12141c';
  ctx.fillRect(0, 0, W, H);

  // 图标
  const icon = gameId === 'fishing' ? '🎣' : '📏';
  ctx.font = '64px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(icon, W / 2, H / 2 - 30);

  // 游戏名
  const name = gameId === 'fishing' ? '钓鱼达人' : '数字测量尺';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText(name, W / 2, H / 2 + 20);

  // 即将上线
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.font = '16px sans-serif';
  ctx.fillText('即将上线，敬请期待...', W / 2, H / 2 + 52);
}

// 打开网页时默认显示空白游戏画面，不自动恢复上次的游戏
// 用户手动选择游戏后才会切换

// 暴露游戏函数
window.toggleGameMenu = toggleGameMenu;
window.selectGame = selectGame;

// ========== 宝可梦风格 RPG 游戏 ==========
function startPokemon() {
  const W = gameCanvas.width, H = gameCanvas.height;
  const ctx = gameCtx;

  // ===== 常量 =====
  const TILE = 32;          // 每格像素
  const MAP_W = 20;         // 地图宽度（格）
  const MAP_H = 20;         // 地图高度（格）
  const VIEW_W = Math.floor(W / TILE); // 视口宽度格数 ~23
  const VIEW_H = Math.floor(H / TILE); // 视口高度格数 ~15
  const MOVE_SPEED = 3;     // 移动速度（像素/帧），32/3 ≈ 11帧完成一格

  // Tile 类型
  const T_GROUND = 0;
  const T_WALL = 1;
  const T_GRASS = 2;
  const T_NPC = 3;

  // 方向映射
  const DIR_DOWN = 0, DIR_LEFT = 1, DIR_RIGHT = 2, DIR_UP = 3;
  const DIR_DX = [0, -1, 1, 0];
  const DIR_DY = [1, 0, 0, -1];

  // 方向颜色（玩家面向不同方向时颜色微变）
  const DIR_COLORS = ['#e74c3c', '#c0392b', '#e55039', '#ff6b6b'];
  const DIR_NAMES = ['↓ 下', '← 左', '→ 右', '↑ 上'];

  // Tile 类型扩展
  const T_PORTAL = 4;  // 传送点
  const T_BOSS = 5;    // BOSS NPC

  // NPC 对话内容
  const NPC_DIALOGS = [
    '欢迎来到宝可梦世界！\n在草丛中探索吧！',
    '小心高草丛，\n那里可能藏着野生宝可梦！',
    '往北走有一片大草地，\n听说那里有稀有宝可梦出没。',
    '这条路通向冒险的起点，\n准备好了就出发吧！',
    '训练师，你好！\n记得随时保持警惕！',
    '我在研究这片区域的\n宝可梦分布情况...',
  ];

  // ===== 多地图系统 =====
  // 地图 0: 城镇（无遇敌，有商店NPC、BOSS道馆）
  const MAP_TOWN = [
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,3,0,0,0,0,0,0,1,1,1,1,0,0,0,0,3,0,1],
    [1,0,0,0,0,0,0,0,0,1,5,5,1,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,1,0,0,1,0,0,0,0,0,0,1],
    [1,0,0,0,0,3,0,0,0,0,4,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,3,0,1],
    [1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,1],
    [1,0,3,0,0,0,0,0,0,0,0,0,1,1,1,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,3,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,4,0,0,0,0,0,0,0,0,0,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  ];

  // 地图 1: 森林/草地（高遇敌率）
  const MAP_FOREST = [
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,2,2,0,0,0,2,2,2,0,0,2,2,0,0,0,2,2,2,1],
    [1,2,2,2,0,0,2,0,0,0,0,2,2,2,0,0,2,2,2,1],
    [1,0,2,2,0,0,0,0,0,0,0,0,2,2,0,0,0,2,0,1],
    [1,0,0,0,0,0,0,0,2,2,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,3,0,0,2,2,2,0,0,0,0,1,1,0,0,1],
    [1,1,1,0,0,0,0,2,2,2,2,2,0,0,0,1,0,0,0,1],
    [1,0,0,0,0,0,0,2,2,2,2,2,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,2,2,0,0,0,0,0,0,0,3,0,1],
    [1,0,0,1,1,0,0,0,0,0,0,0,1,1,1,0,0,0,0,1],
    [1,0,0,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,2,0,0,0,0,0,2,2,0,0,0,0,0,0,0,2,2,0,1],
    [1,2,2,0,0,0,2,2,2,2,0,0,0,1,0,2,2,2,0,1],
    [1,0,2,0,0,0,2,2,2,2,0,0,1,1,1,2,2,2,0,1],
    [1,0,0,0,0,0,0,2,2,0,0,0,0,1,0,0,2,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,0,1],
    [1,2,0,1,0,0,0,0,0,0,0,0,0,0,0,2,2,2,0,1],
    [1,2,2,1,0,0,0,0,3,0,0,0,0,0,0,2,2,2,0,1],
    [1,4,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,2,0,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  ];

  // 地图 2: 山洞（高遇敌率，暗色调）
  const MAP_CAVE = [
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,0,0,1,1,0,0,0,0,0,0,0,0,1,1,0,0,0,0,1],
    [1,0,0,0,1,0,0,2,2,0,0,2,0,0,1,0,0,0,0,1],
    [1,4,0,0,0,0,0,2,2,0,0,2,2,0,0,0,0,0,0,1],
    [1,1,0,0,0,0,0,0,0,0,0,0,2,0,0,0,0,1,0,1],
    [1,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,1],
    [1,0,0,1,1,0,0,2,2,2,0,0,0,0,1,1,0,0,0,1],
    [1,0,0,0,0,0,2,2,2,2,2,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,2,2,2,0,0,0,0,0,0,0,3,0,1],
    [1,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,1],
    [1,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,2,0,0,0,0,0,0,0,0,2,0,0,1],
    [1,0,0,0,0,0,2,2,2,0,0,0,0,0,0,2,2,2,0,1],
    [1,0,0,0,0,0,2,2,2,0,0,0,0,1,0,2,2,2,0,1],
    [1,0,0,0,0,0,0,2,0,0,0,0,1,1,0,0,2,0,0,1],
    [1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1],
    [1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  ];

  // 地图集合
  const MAPS = [MAP_TOWN, MAP_FOREST, MAP_CAVE];
  const MAP_NAMES = ['🏘️ 真新镇', '🌲 常磐森林', '🪨 月见山洞'];
  const MAP_THEMES = [
    { ground1: '#6b7b3a', ground2: '#5a6a2d', wallColor: '#7a6a5a', wallLight: '#8a7a6a', wallDark: '#5a4a3a' }, // 城镇
    { ground1: '#3a5a3a', ground2: '#2d4a2d', wallColor: '#5a5a6e', wallLight: '#6a6a7e', wallDark: '#44445a' }, // 森林
    { ground1: '#2a2a35', ground2: '#222230', wallColor: '#4a4a55', wallLight: '#5a5a65', wallDark: '#333340' }, // 山洞
  ];

  // 传送点定义: [fromMap, fromX, fromY] → [toMap, toX, toY]
  const PORTALS = [
    { fromMap: 0, fx: 10, fy: 5,  toMap: 0, tx: 10, ty: 4, label: '道馆内部' }, // 城镇道馆入口
    { fromMap: 0, fx: 9,  fy: 18, toMap: 1, tx: 1,  ty: 18, label: '前往 常磐森林' },  // 城镇→森林
    { fromMap: 1, fx: 1,  fy: 18, toMap: 0, tx: 9,  ty: 17, label: '返回 真新镇' },    // 森林→城镇
    { fromMap: 1, fx: 1,  fy: 1,  toMap: 2, tx: 1,  ty: 3,  label: '前往 月见山洞' },  // 森林→山洞 (左上角)
    { fromMap: 2, fx: 1,  fy: 3,  toMap: 1, tx: 1,  ty: 2,  label: '返回 常磐森林' },  // 山洞→森林
    { fromMap: 2, fx: 18, fy: 18, toMap: 0, tx: 10, ty: 17, label: '返回 真新镇' },    // 山洞→城镇 (右下角)
  ];

  // 各地图遇敌率
  const MAP_ENCOUNTER_RATES = [0, 0.12, 0.18]; // 城镇无遇敌，森林12%，山洞18%

  // BOSS 定义
  const BOSS_NPCS = [
    {
      mapId: 0, x: 10, y: 3, x2: 11, y2: 3, // 两格 BOSS
      name: '馆主小刚',
      dialog: '我是常磐道馆馆主小刚！\n用岩石系宝可梦挑战你！\n准备好了吗？',
      afterDefeatDialog: '你的实力真强...\n这是岩石徽章，送给你！',
      badgeId: 'boulder',
      badgeName: '🪨 岩石徽章',
      pokemon: { id: 95, name: '大岩蛇', emoji: '🪨', type: '岩石', types: ['岩石','地面'], color: '#7a6a5a', colorLight: '#9a8a7a',
        hp: 45, atk: 16, def: 80, spd: 5, catchRate: 0,
        drawSprite: function(ctx, x, y, w, h) {
          // 岩蛇身体 — 多段岩石
          for (let i = 0; i < 4; i++) {
            const segX = x + 4 + i * 6;
            const segY = y + h - 16 - i * 10;
            ctx.fillStyle = i % 2 === 0 ? '#7a6a5a' : '#8a7a6a';
            ctx.fillRect(segX, segY, w - 8 - i * 4, 14);
            ctx.fillStyle = '#5a4a3a';
            ctx.fillRect(segX + 2, segY + 2, 4, 4);
          }
          // 头部
          ctx.fillStyle = '#9a8a7a';
          ctx.fillRect(x + 10, y + 2, w - 20, 18);
          ctx.fillStyle = '#7a6a5a';
          ctx.fillRect(x + 6, y + 6, w - 12, 16);
          // 眼睛
          ctx.fillStyle = '#fff';
          ctx.fillRect(x + 14, y + 8, 8, 6);
          ctx.fillRect(x + w - 22, y + 8, 8, 6);
          ctx.fillStyle = '#2d3436';
          ctx.fillRect(x + 17, y + 9, 4, 4);
          ctx.fillRect(x + w - 19, y + 9, 4, 4);
          // 嘴
          ctx.fillStyle = '#4a3a2a';
          ctx.fillRect(x + 18, y + 18, w - 36, 3);
        }
      },
      level: 12,
      canFlee: false, // 不可逃跑
    }
  ];

  // 徽章收集（持久化）
  let badges = {};

  // 当前地图 ID
  let currentMapId = 0;

  // 获取当前地图数据
  function getCurrentMap() { return MAPS[currentMapId]; }

  // 收集当前地图的 NPC
  function collectNPCs(mapId) {
    const map = MAPS[mapId];
    const result = [];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (map[y][x] === T_NPC) {
          result.push({ x, y, dialog: NPC_DIALOGS[result.length % NPC_DIALOGS.length] });
        }
      }
    }
    // 在城镇添加特殊 NPC 对话
    if (mapId === 0) {
      // 覆写部分 NPC 对话
      if (result.length > 0) result[0].dialog = '这里是真新镇！\n南边出口通往常磐森林。';
      if (result.length > 1) result[1].dialog = '道馆就在镇子中间！\n打败馆主可以获得徽章！';
      if (result.length > 2) result[2].dialog = '听说月见山洞里\n有很多强力宝可梦！';
      if (result.length > 3) result[3].dialog = '记得在草丛里多抓几只\n宝可梦再去挑战道馆！';
    }
    return result;
  }

  let npcs = collectNPCs(currentMapId);

  // ===== 音效系统（Web Audio API 合成） =====
  let _audioCtx = null;
  function getAudioCtx() {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return _audioCtx;
  }
  // 确认/对话 Beep
  function sfxBeep() {
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(880, ac.currentTime);
      osc.frequency.setValueAtTime(1100, ac.currentTime + 0.06);
      gain.gain.setValueAtTime(0.15, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.12);
      osc.connect(gain).connect(ac.destination);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.12);
    } catch (e) { /* audio not available */ }
  }
  // 撞墙 Thump
  function sfxThump() {
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(100, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(40, ac.currentTime + 0.15);
      gain.gain.setValueAtTime(0.2, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.15);
      osc.connect(gain).connect(ac.destination);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.15);
    } catch (e) { /* audio not available */ }
  }
  // 战斗开始 Battle Start Sound（经典上升音阶）
  function sfxBattleStart() {
    try {
      const ac = getAudioCtx();
      const notes = [330, 392, 494, 587, 659, 784];
      notes.forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'square';
        const t = ac.currentTime + i * 0.07;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.12);
      });
    } catch (e) { /* audio not available */ }
  }
  // 草丛沙沙声
  function sfxGrass() {
    try {
      const ac = getAudioCtx();
      const bufferSize = ac.sampleRate * 0.08;
      const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.1;
      const source = ac.createBufferSource();
      source.buffer = buffer;
      const filter = ac.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 3000;
      filter.Q.value = 1;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.08, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.08);
      source.connect(filter).connect(gain).connect(ac.destination);
      source.start();
    } catch (e) { /* audio not available */ }
  }

  // 攻击音效
  function sfxAttack() {
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(80, ac.currentTime + 0.15);
      gain.gain.setValueAtTime(0.15, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.15);
      osc.connect(gain).connect(ac.destination);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.15);
      // 第二层白噪声（打击感）
      const buf = ac.createBuffer(1, ac.sampleRate * 0.05, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.3;
      const ns = ac.createBufferSource();
      ns.buffer = buf;
      const g2 = ac.createGain();
      g2.gain.setValueAtTime(0.12, ac.currentTime);
      g2.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.05);
      ns.connect(g2).connect(ac.destination);
      ns.start(ac.currentTime);
    } catch (e) {}
  }
  // 减益音效
  function sfxDebuff() {
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, ac.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, ac.currentTime + 0.2);
      gain.gain.setValueAtTime(0.1, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.2);
      osc.connect(gain).connect(ac.destination);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.2);
    } catch (e) {}
  }
  // 胜利音效
  function sfxVictory() {
    try {
      const ac = getAudioCtx();
      const notes = [523, 659, 784, 1047, 784, 1047];
      notes.forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'square';
        const t = ac.currentTime + i * 0.1;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.15);
      });
    } catch (e) {}
  }
  // 失败音效
  function sfxLose() {
    try {
      const ac = getAudioCtx();
      const notes = [440, 370, 311, 262];
      notes.forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'triangle';
        const t = ac.currentTime + i * 0.15;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      });
    } catch (e) {}
  }

  // 捕捉音效（精灵球抖动 Tick-Tick-Tick）
  function sfxCatch() {
    try {
      const ac = getAudioCtx();
      [0, 0.3, 0.6].forEach((delay) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        const t = ac.currentTime + delay;
        osc.frequency.setValueAtTime(600, t);
        osc.frequency.setValueAtTime(400, t + 0.05);
        gain.gain.setValueAtTime(0.12, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.12);
      });
    } catch (e) {}
  }
  // 捕捉成功
  function sfxCatchSuccess() {
    try {
      const ac = getAudioCtx();
      const notes = [523, 659, 784, 1047];
      notes.forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'square';
        const t = ac.currentTime + 0.9 + i * 0.12;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.18);
      });
    } catch (e) {}
  }
  // 升级音效
  function sfxLevelUp() {
    try {
      const ac = getAudioCtx();
      const notes = [392, 494, 587, 659, 784, 880, 1047];
      notes.forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'square';
        const t = ac.currentTime + i * 0.08;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.14);
      });
    } catch (e) {}
  }

  // 传送音效（上升再下降的神秘音）
  function sfxPortal() {
    try {
      const ac = getAudioCtx();
      const notes = [262, 330, 392, 523, 660, 523, 392];
      notes.forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        const t = ac.currentTime + i * 0.06;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.1);
      });
    } catch (e) {}
  }

  // BOSS 战开始音效（更紧张的上升音阶）
  function sfxBossStart() {
    try {
      const ac = getAudioCtx();
      const notes = [165, 196, 220, 262, 330, 392, 440, 523, 660, 784];
      notes.forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'square';
        const t = ac.currentTime + i * 0.08;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.14);
      });
    } catch (e) {}
  }

  // 进化音效（华丽的上升序列）
  function sfxEvolve() {
    try {
      const ac = getAudioCtx();
      const notes = [262, 330, 392, 523, 659, 784, 988, 1047, 1319, 1568];
      notes.forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = i < 5 ? 'triangle' : 'square';
        const t = ac.currentTime + i * 0.1;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.18);
      });
    } catch (e) {}
  }

  // 菜单打开音效（经典清脆的"叮"）
  function sfxMenuOpen() {
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1200, ac.currentTime);
      osc.frequency.setValueAtTime(1600, ac.currentTime + 0.04);
      gain.gain.setValueAtTime(0.12, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.1);
      osc.connect(gain).connect(ac.destination);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.1);
    } catch (e) {}
  }

  // 菜单关闭音效
  function sfxMenuClose() {
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1000, ac.currentTime);
      osc.frequency.setValueAtTime(600, ac.currentTime + 0.05);
      gain.gain.setValueAtTime(0.1, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.08);
      osc.connect(gain).connect(ac.destination);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.08);
    } catch (e) {}
  }

  // 菜单光标移动微脉冲
  function sfxMenuCursor() {
    try {
      const ac = getAudioCtx();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(800, ac.currentTime);
      gain.gain.setValueAtTime(0.06, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.04);
      osc.connect(gain).connect(ac.destination);
      osc.start(ac.currentTime);
      osc.stop(ac.currentTime + 0.04);
      // 硬件脉冲（极短促）
      sendMotorFeedback();
    } catch (e) {}
  }

  // 存档音效
  function sfxSave() {
    try {
      const ac = getAudioCtx();
      [523, 659].forEach((freq, i) => {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = 'sine';
        const t = ac.currentTime + i * 0.15;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0.1, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 0.2);
      });
    } catch (e) {}
  }

  // === 硬件震动反馈：向单控制器发送 MOTOR 指令 ===
  // 低血量逆时针慢转
  async function sendMotorLowHP() {
    try {
      const sp = serialPorts.port1;
      if (!sp?.isConnected) return;
      await writeToPort('port1', 'MOTOR:CCW\n');
    } catch (e) {}
  }

  async function sendMotorFeedback() {
    try {
      const sp = serialPorts.port1;
      if (!sp?.isConnected) return;
      await writeToPort('port1', 'MOTOR:CW\n');
    } catch (e) {
      // 未连接或写入失败，静默忽略
    }
  }

  // ===== 游戏状态 =====
  // 游戏模式枚举
  const MODE_EXPLORING = 'EXPLORING';
  const MODE_TRANSITION = 'TRANSITION'; // 切场过渡
  const MODE_BATTLE = 'BATTLE';

  const pkState = {
    // 玩家
    px: 4, py: 4,         // 网格坐标
    dir: DIR_DOWN,         // 面向方向
    moving: false,         // 是否正在移动中
    moveProgress: 0,       // 移动进度 0..TILE
    targetX: 4, targetY: 4,

    // 相机（像素坐标，平滑插值）
    camX: 0, camY: 0,

    // 对话
    dialogActive: false,
    dialogText: '',
    dialogTimer: 0,

    // 草丛动画
    grassAnim: null,  // { x, y, timer }

    // 步数统计
    steps: 0,

    // 输入队列（只保留最后一个方向，移动完成后取出执行）
    pendingDir: null,

    // 帧计数（用于动画）
    frame: 0,

    // === 第二步新增 ===
    gameMode: 'EXPLORING',  // EXPLORING | TRANSITION | BATTLE

    // 遇敌相关
    encounterRate: 0.10,     // 草丛遇敌概率 10%
    transitionTimer: 0,      // 切场动画计时
    transitionDuration: 90,  // 切场动画总帧数（约 1.5 秒）

    // === 第三步：战斗系统 ===
    battleMonsterName: '',
    battleFlashTimer: 0,

    // 战斗子状态
    battlePhase: 'MENU',  // MENU | SKILL_MENU | BAG_MENU | PLAYER_ATTACK | ENEMY_ATTACK | RESULT | FLEE | WIN | LOSE | CATCHING | CATCH_SUCCESS | CATCH_FAIL | LEVEL_UP

    // 四宫格菜单光标 (0=战斗, 1=背包, 2=精灵, 3=逃跑)
    menuCursor: 0,

    // 技能菜单光标
    skillCursor: 0,

    // 玩家数值
    playerHP: 50,
    playerMaxHP: 50,
    playerAtk: 15,
    playerSpeed: 10,
    playerLevel: 5,
    playerDisplayHP: 50,  // 用于血条平滑动画

    // 野怪数值（遇敌时初始化）
    enemyHP: 0,
    enemyMaxHP: 0,
    enemyAtk: 0,
    enemySpeed: 0,
    enemyLevel: 3,
    enemyDisplayHP: 0,

    // 战斗动画
    battleAnimTimer: 0,
    battleAnimDuration: 30,
    battleShakeX: 0,   // 攻击震动偏移
    battleShakeEnemy: 0,
    battleShakePlayer: 0,
    battleDamageText: '',
    battleDamageTimer: 0,

    // 战斗消息
    battleMsg: '',
    battleMsgTimer: 0,
    battleMsgDuration: 90,  // 消息显示帧数

    // 经验值
    playerExp: 0,
    expGained: 0,

    // 技能列表（skillTypeZh 用于属性克制计算）
    skills: [
      { name: '撞击', power: 10, type: 'normal', skillTypeZh: '普通', emoji: '💥' },
      { name: '摇尾巴', power: 0, type: 'debuff', emoji: '🌀' },
      { name: '电击', power: 12, type: 'electric', skillTypeZh: '电', emoji: '⚡' },
      { name: '叫声', power: 0, type: 'debuff_atk', emoji: '📢' },
    ],

    // 属性克制提示
    _lastTypeEffectivenessMsg: '',

    // === 第四步：捕捉 & 经验 & 图鉴 ===
    // 捕捉动画状态
    catchAnimTimer: 0,
    catchAnimPhase: 0,    // 0=投掷 1=抖动1 2=抖动2 3=抖动3 4=结果
    catchSuccess: false,
    catchBallX: 0,
    catchBallY: 0,

    // 升级动画
    levelUpAnimTimer: 0,
    levelUpOldLevel: 0,
    levelUpNewStats: null, // { hp, atk, spd }

    // 背包菜单光标
    bagCursor: 0,

    // 图鉴菜单
    pokedexOpen: false,
    pokedexCursor: 0,
    pokedexScrollOffset: 0,

    // === 第五步：多地图 & 传送 & BOSS & 存档 ===
    // 传送动画
    portalTransition: false,
    portalFadeTimer: 0,
    portalFadeDuration: 60,   // 淡出+淡入总帧数
    portalTarget: null,        // { toMap, tx, ty }

    // BOSS 战斗标记
    isBossBattle: false,
    bossDef: null,             // 当前 BOSS 定义

    // 地图菜单（按 M 查看）
    mapMenuOpen: false,

    // 低血量警报
    lowHPWarningActive: false,
    lowHPWarningTimer: 0,

    // 进化相关
    evolveAnimTimer: 0,
    evolveTriggered: false,
    evolveOldName: '',
    evolveNewName: '',
    _evolvingPokemon: null,
    _evolveNewColor: '',

    // 敌人防御
    enemyDef: 10,

    // === 第七步新增 ===
    // 1996 风格战斗文本流
    battleTextQueue: [],      // 分段文本队列 [{text:'...', delay:0}]
    battleTextCurrent: '',    // 当前显示的文本
    battleTextCharIndex: 0,   // 打字机当前字符位置
    battleTextWaiting: false, // 等待玩家按键
    battleTextDelay: 0,       // 延迟计数器（用于效果延迟）
    battleTextCallback: null, // 文本队列完成后的回调

    // 技能学习对话
    learnSkillPhase: '',      // '' | 'ASK_LEARN' | 'SELECT_REPLACE'
    learnSkillPending: null,  // 待学习的技能 {name, power, type, skillTypeZh, emoji}
    learnSkillCursor: 0,      // 选择要替换的技能光标
    learnSkillPokemonIdx: -1, // 哪只精灵在学技能

    // 属性相克特效
    screenFlashTimer: 0,      // 屏幕闪烁计时
    screenFlashType: '',      // 'super' | 'not_very' | ''

    // PC 电脑存储系统
    pcStorageOpen: false,
    pcStorageCursor: 0,
    pcStorageScrollOffset: 0,

    // === 第八步：1996版全局菜单系统 ===
    globalMenuOpen: false,           // 全局菜单是否打开
    globalMenuCursor: 0,             // 主菜单光标 (0-6)
    globalMenuSubMenu: '',           // 当前子菜单: '' | 'POKEMON' | 'ITEM' | 'SAVE' | 'POKEDEX' | 'PLAYER' | 'OPTION' | 'EXIT'
    globalMenuSubCursor: 0,          // 子菜单光标
    globalMenuSubScrollOffset: 0,    // 子菜单滚动偏移
    globalMenuSaveConfirm: false,    // 保存确认状态
    globalMenuSaveResult: '',        // 保存结果: '' | 'SAVING' | 'SAVED'
    globalMenuSaveTimer: 0,          // 保存动画计时
    globalMenuItemAction: '',        // 物品子操作: '' | 'USE_DROP'
    globalMenuItemActionCursor: 0,   // 使用/丢弃光标
    globalMenuPokemonDetail: -1,     // 精灵详情索引 (-1=不显示)
    globalMenuAnimTimer: 0,          // 菜单动画计时
  };

  // 初始化相机到玩家位置
  pkState.camX = pkState.px * TILE - (VIEW_W * TILE) / 2 + TILE / 2;
  pkState.camY = pkState.py * TILE - (VIEW_H * TILE) / 2 + TILE / 2;

  gameState.pokemon = pkState;

  // ===== 输入处理 =====
  function handleDirection(dir, source) {
    // 只接受单控制器输入（或键盘）
    if (source && source !== 'port1') return;

    // === 全局菜单导航（最高优先级） ===
    if (pkState.globalMenuOpen) {
      handleGlobalMenuDirection(dir);
      return;
    }

    // === PC 存储菜单导航 ===
    if (pkState.pcStorageOpen) {
      if (dir === 'UP') pkState.pcStorageCursor = Math.max(0, pkState.pcStorageCursor - 1);
      else if (dir === 'DOWN') pkState.pcStorageCursor = Math.min(pcStorage.length - 1, pkState.pcStorageCursor + 1);
      sfxBeep();
      return;
    }

    // === 技能学习对话方向 ===
    if (pkState.learnSkillPhase === 'SELECT_REPLACE') {
      const pokemon = myPokemon[pkState.learnSkillPokemonIdx];
      if (pokemon && pokemon.skills) {
        if (dir === 'UP') pkState.learnSkillCursor = Math.max(0, pkState.learnSkillCursor - 1);
        else if (dir === 'DOWN') pkState.learnSkillCursor = Math.min(pokemon.skills.length - 1, pkState.learnSkillCursor + 1);
        sfxBeep();
      }
      return;
    }

    // === 地图菜单：方向键不操作 ===
    if (pkState.mapMenuOpen) return;

    // === 图鉴菜单导航 ===
    if (pkState.pokedexOpen) {
      const totalEntries = POKEDEX.length;
      if (dir === 'UP') pkState.pokedexCursor = Math.max(0, pkState.pokedexCursor - 1);
      else if (dir === 'DOWN') pkState.pokedexCursor = Math.min(totalEntries - 1, pkState.pokedexCursor + 1);
      sfxBeep();
      return;
    }

    // === 战斗模式：菜单导航 ===
    if (pkState.gameMode === MODE_BATTLE) {
      if (pkState.battlePhase === 'MENU') {
        // 四宫格菜单: 0=战斗(左上) 1=背包(右上) 2=精灵(左下) 3=逃跑(右下)
        if (dir === 'UP') pkState.menuCursor = pkState.menuCursor >= 2 ? pkState.menuCursor - 2 : pkState.menuCursor;
        else if (dir === 'DOWN') pkState.menuCursor = pkState.menuCursor < 2 ? pkState.menuCursor + 2 : pkState.menuCursor;
        else if (dir === 'LEFT') pkState.menuCursor = pkState.menuCursor % 2 === 1 ? pkState.menuCursor - 1 : pkState.menuCursor;
        else if (dir === 'RIGHT') pkState.menuCursor = pkState.menuCursor % 2 === 0 ? pkState.menuCursor + 1 : pkState.menuCursor;
        sfxBeep();
      } else if (pkState.battlePhase === 'SKILL_MENU') {
        // 技能列表：上下选择
        if (dir === 'UP') pkState.skillCursor = Math.max(0, pkState.skillCursor - 1);
        else if (dir === 'DOWN') pkState.skillCursor = Math.min(pkState.skills.length - 1, pkState.skillCursor + 1);
        sfxBeep();
      } else if (pkState.battlePhase === 'BAG_MENU') {
        // 背包菜单：上下选择（目前只有精灵球一种道具）
        if (dir === 'UP') pkState.bagCursor = Math.max(0, pkState.bagCursor - 1);
        else if (dir === 'DOWN') pkState.bagCursor = Math.min(0, pkState.bagCursor + 1); // 只有 1 项
        sfxBeep();
      }
      return;
    }

    // === 探索模式 ===
    if (pkState.gameMode !== MODE_EXPLORING) return;
    if (pkState.dialogActive) return;

    const dirMap = { 'UP': DIR_UP, 'DOWN': DIR_DOWN, 'LEFT': DIR_LEFT, 'RIGHT': DIR_RIGHT };
    const d = dirMap[dir];
    if (d === undefined) return;

    if (pkState.moving) {
      pkState.pendingDir = d;
    } else {
      tryMove(d);
    }
  }

  function handleButton(source) {
    // 只接受单控制器输入（或键盘）
    if (source && source !== 'port1') return;

    // === 全局菜单按键（最高优先级） ===
    if (pkState.globalMenuOpen) {
      handleGlobalMenuButton();
      return;
    }

    // === PC 存储菜单 ===
    if (pkState.pcStorageOpen) {
      sfxBeep();
      pkState.pcStorageOpen = false;
      return;
    }

    // === 地图菜单 ===
    if (pkState.mapMenuOpen) {
      sfxBeep();
      pkState.mapMenuOpen = false;
      return;
    }

    // === 图鉴菜单 ===
    if (pkState.pokedexOpen) {
      sfxBeep();
      pkState.pokedexOpen = false;
      return;
    }

    // === 战斗模式 ===
    if (pkState.gameMode === MODE_BATTLE) {
      // 动画播放中不接受输入
      if (pkState.battlePhase === 'PLAYER_ATTACK' || pkState.battlePhase === 'ENEMY_ATTACK') return;
      if (pkState.battlePhase === 'CATCHING') return;

      // === 1996 风格文本流：按键推进 ===
      if (pkState.battlePhase === 'TEXT_FLOW') {
        if (pkState.battleTextWaiting) {
          sfxBeep();
          advanceBattleText();
        } else {
          // 加速打字
          pkState.battleTextCharIndex = pkState.battleTextCurrent.length;
        }
        return;
      }

      // === 技能学习对话按键 ===
      if (pkState.learnSkillPhase === 'ASK_LEARN') {
        sfxBeep();
        // 进入选择替换界面
        pkState.learnSkillPhase = 'SELECT_REPLACE';
        pkState.learnSkillCursor = 0;
        const pokemon = myPokemon[pkState.learnSkillPokemonIdx];
        pkState.battleMsg = `选择要遗忘的招式：\n${pokemon.skills.map((s, i) => `${i === pkState.learnSkillCursor ? '▶' : '  '} ${s.emoji} ${s.name}`).join('\n')}`;
        pkState.battleMsgTimer = 0;
        return;
      }

      if (pkState.learnSkillPhase === 'SELECT_REPLACE') {
        sfxBeep();
        const pokemon = myPokemon[pkState.learnSkillPokemonIdx];
        const skill = pkState.learnSkillPending;
        if (pokemon && pokemon.skills && skill) {
          const oldSkillName = pokemon.skills[pkState.learnSkillCursor].name;
          pokemon.skills[pkState.learnSkillCursor] = skill;
          // 同步玩家技能
          if (pkState.learnSkillPokemonIdx === 0) {
            pkState.skills = pokemon.skills.slice();
          }
          pkState.battleMsg = `1、2、3... 哒哒！\n${pokemon.name} 忘记了 ${oldSkillName}，\n学会了 ${skill.emoji} ${skill.name}！`;
        }
        pkState.learnSkillPhase = '';
        pkState.learnSkillPending = null;
        pkState.battleMsgTimer = 0;
        pkState.battlePhase = 'RESULT';
        return;
      }

      // 捕捉动画中

      // 捕捉成功：按键确认
      if (pkState.battlePhase === 'CATCH_SUCCESS') {
        sfxBeep();
        // 更新图鉴
        if (pokedex[pkState._battleMonster.id]) pokedex[pkState._battleMonster.id].caught = true;
        // 创建精灵数据
        const caughtPokemon = {
          id: pkState._battleMonster.id,
          name: pkState._battleMonster.name,
          emoji: pkState._battleMonster.emoji,
          type: pkState._battleMonster.type,
          types: pkState._battleMonster.types || [pkState._battleMonster.type],
          color: pkState._battleMonster.color,
          colorLight: pkState._battleMonster.colorLight,
          level: pkState.enemyLevel,
          hp: pkState.enemyMaxHP,
          maxHP: pkState.enemyMaxHP,
          atk: pkState.enemyAtk,
          def: pkState.enemyDef || 10,
          spd: pkState.enemySpeed,
          skills: generateSkillsForPokemon(pkState._battleMonster.id, pkState.enemyLevel),
        };
        // PC 存储系统：队伍满6只时自动传送到电脑
        if (myPokemon.length >= MAX_PARTY_SIZE) {
          pcStorage.push(caughtPokemon);
          // 通过文本队列显示传送消息
          enqueueBattleText([
            { text: `由于队伍已满，` },
            { text: `${caughtPokemon.name} 已被传送到\n比尔的电脑中。` },
          ], () => {
            // 获得经验
            pkState.expGained = pkState.enemyLevel * 6 + Math.floor(Math.random() * 8);
            pkState.playerExp += pkState.expGained;
            if (checkLevelUp()) return;
            exitBattle();
          });
          pkState.battlePhase = 'TEXT_FLOW';
          return;
        }
        // 加入队伍
        myPokemon.push(caughtPokemon);
        // 获得经验
        pkState.expGained = pkState.enemyLevel * 6 + Math.floor(Math.random() * 8);
        pkState.playerExp += pkState.expGained;
        // 检查升级
        if (checkLevelUp()) return;
        exitBattle();
        return;
      }

      // 捕捉失败：按键继续战斗
      if (pkState.battlePhase === 'CATCH_FAIL') {
        sfxBeep();
        // 捕捉失败后，敌人攻击
        pkState._pendingEnemyAttack = true;
        pkState.battlePhase = 'RESULT';
        pkState.battleMsg = '精灵球没有效果...\n精灵挣脱了！';
        pkState.battleMsgTimer = 0;
        return;
      }

      // 升级界面：按键确认
      if (pkState.battlePhase === 'LEVEL_UP') {
        sfxBeep();
        exitBattle();
        return;
      }

      // 结果消息：按键继续下一步
      if (pkState.battlePhase === 'RESULT') {
        // 检查胜负
        if (pkState.enemyHP <= 0) {
          pkState.battlePhase = 'WIN';
          pkState.expGained = pkState.enemyLevel * 8 + Math.floor(Math.random() * 10);
          pkState.battleMsg = `野生的 ${pkState.battleMonsterName} 倒下了！\n获得 ${pkState.expGained} 经验值！`;
          pkState.battleMsgTimer = 0;
          sfxVictory();
          return;
        }
        if (pkState.playerHP <= 0) {
          pkState.battlePhase = 'LOSE';
          pkState.battleMsg = '你的精灵倒下了...\n眼前一黑...';
          pkState.battleMsgTimer = 0;
          sfxLose();
          return;
        }
        // 回到菜单
        pkState.battlePhase = 'MENU';
        pkState.menuCursor = 0;
        pkState.battleMsg = '';
        return;
      }

      // 胜利：按键 → 加经验 → 检查升级
      if (pkState.battlePhase === 'WIN') {
        sfxBeep();
        pkState.playerExp += pkState.expGained;
        // 已捕获精灵也获得经验
        const oldLevels = {};
        myPokemon.forEach(p => {
          oldLevels[p.id + '_' + (p.uid || 0)] = p.level || 1;
          p.level = (p.level || 1) + (Math.random() < 0.3 ? 1 : 0);
        });
        // 每次胜利有概率获得精灵球
        if (Math.random() < 0.5) {
          bag.pokeball++;
        }
        // BOSS 战胜利获得技能增强
        if (pkState.isBossBattle && pkState.bossDef) {
          if (pkState.skills.length < 6) {
            const bossType = pkState.bossDef.pokemon.type;
            if (bossType === '岩石') {
              pkState.skills.push({ name: '岩石崩', power: 15, type: 'rock', skillTypeZh: '岩石', emoji: '🪨' });
            }
          }
        }
        // 检查已捕获精灵的新技能学习
        checkPartyNewMoves(oldLevels);
        // 检查升级
        if (checkLevelUp()) return;
        // 检查进化
        checkEvolution();
        exitBattle();
        return;
      }

      // 失败：按键重置位置回到探索（回到城镇起始点）
      if (pkState.battlePhase === 'LOSE') {
        sfxBeep();
        pkState.playerHP = Math.floor(pkState.playerMaxHP * 0.5); // 复活半血
        pkState.playerDisplayHP = pkState.playerHP;
        // 回到城镇起始点
        currentMapId = 0;
        npcs = collectNPCs(0);
        pkState.px = 4;
        pkState.py = 4;
        pkState.camX = pkState.px * TILE - (VIEW_W * TILE) / 2 + TILE / 2;
        pkState.camY = pkState.py * TILE - (VIEW_H * TILE) / 2 + TILE / 2;
        exitBattle();
        return;
      }

      // 逃跑结果
      if (pkState.battlePhase === 'FLEE') {
        sfxBeep();
        exitBattle();
        return;
      }

      // 主菜单确认
      if (pkState.battlePhase === 'MENU') {
        sfxBeep();
        if (pkState.menuCursor === 0) {
          // 战斗 → 打开技能菜单
          pkState.battlePhase = 'SKILL_MENU';
          pkState.skillCursor = 0;
        } else if (pkState.menuCursor === 1) {
          // 背包 → 打开背包菜单
          pkState.battlePhase = 'BAG_MENU';
          pkState.bagCursor = 0;
        } else if (pkState.menuCursor === 2) {
          // 精灵 — 显示已捕获精灵数量
          if (myPokemon.length === 0) {
            pkState.battleMsg = '你还没有捕获任何精灵！';
          } else {
            pkState.battleMsg = `拥有 ${myPokemon.length} 只精灵：\n${myPokemon.map(p => p.emoji + p.name).join(' ')}`;
          }
          pkState.battleMsgTimer = 0;
          pkState.battlePhase = 'RESULT';
        } else if (pkState.menuCursor === 3) {
          // 逃跑
          attemptFlee();
        }
        return;
      }

      // 技能菜单确认
      if (pkState.battlePhase === 'SKILL_MENU') {
        sfxBeep();
        executePlayerAttack(pkState.skills[pkState.skillCursor]);
        return;
      }

      // 背包菜单确认 → 使用精灵球
      if (pkState.battlePhase === 'BAG_MENU') {
        sfxBeep();
        // BOSS 不可捕捉
        if (pkState.isBossBattle) {
          pkState.battleMsg = '无法捕捉训练师的宝可梦！';
          pkState.battleMsgTimer = 0;
          pkState.battlePhase = 'RESULT';
          sfxThump();
          return;
        }
        if (bag.pokeball > 0) {
          bag.pokeball--;
          attemptCatch();
        } else {
          pkState.battleMsg = '没有精灵球了！';
          pkState.battleMsgTimer = 0;
          pkState.battlePhase = 'RESULT';
        }
        return;
      }

      return;
    }

    // 切场过渡中不接受输入
    if (pkState.gameMode === MODE_TRANSITION) return;

    // === 探索模式 ===
    if (pkState.dialogActive) {
      sfxBeep();
      pkState.dialogActive = false;
      pkState.dialogText = '';

      // 对话关闭后触发 BOSS 战
      if (pkState._pendingBossFight) {
        const boss = pkState._pendingBossFight;
        pkState._pendingBossFight = null;
        triggerBossBattle(boss);
      }
      return;
    }

    // 检查面前是否有 NPC 或 BOSS
    const fx = pkState.px + DIR_DX[pkState.dir];
    const fy = pkState.py + DIR_DY[pkState.dir];
    const map = getCurrentMap();
    let interacted = false;
    if (fx >= 0 && fx < MAP_W && fy >= 0 && fy < MAP_H) {
      const tile = map[fy][fx];
      if (tile === T_NPC) {
        const npc = npcs.find(n => n.x === fx && n.y === fy);
        if (npc) {
          sfxBeep();
          pkState.dialogActive = true;
          pkState.dialogText = npc.dialog;
          pkState.dialogTimer = 0;
          interacted = true;
        }
      } else if (tile === T_BOSS) {
        // 查找对应的 BOSS 定义
        const boss = BOSS_NPCS.find(b => b.mapId === currentMapId && ((b.x === fx && b.y === fy) || (b.x2 === fx && b.y2 === fy)));
        if (boss) {
          sfxBeep();
          // 如果已击败过，显示击败后对话
          if (badges[boss.badgeId]) {
            pkState.dialogActive = true;
            pkState.dialogText = boss.afterDefeatDialog;
            pkState.dialogTimer = 0;
          } else {
            // 先显示对话，对话关闭后触发战斗
            pkState.dialogActive = true;
            pkState.dialogText = boss.dialog;
            pkState.dialogTimer = 0;
            pkState._pendingBossFight = boss; // 标记：关闭对话后触发 BOSS 战
          }
          interacted = true;
        }
      }
    }

    // 如果前方没有可交互对象 → 打开全局菜单（1996经典行为）
    if (!interacted && pkState.gameMode === MODE_EXPLORING && !pkState.moving) {
      openGlobalMenu();
    }
  }

  // === 1996版全局菜单系统 ===
  const GLOBAL_MENU_ITEMS = [
    { label: '图鉴', sub: 'POKEDEX', icon: '📖', desc: '查看已发现的精灵' },
    { label: '精灵', sub: 'POKEMON', icon: '🐾', desc: '查看队伍中的精灵' },
    { label: '物品', sub: 'ITEM', icon: '🎒', desc: '查看背包中的物品' },
    { label: '小智', sub: 'PLAYER', icon: '👤', desc: '查看训练师信息' },
    { label: '保存', sub: 'SAVE', icon: '💾', desc: '保存游戏进度' },
    { label: '设置', sub: 'OPTION', icon: '⚙️', desc: '游戏设置选项' },
    { label: '退出', sub: 'EXIT', icon: '✖', desc: '关闭菜单' },
  ];

  function openGlobalMenu() {
    pkState.globalMenuOpen = true;
    pkState.globalMenuCursor = 0;
    pkState.globalMenuSubMenu = '';
    pkState.globalMenuSubCursor = 0;
    pkState.globalMenuSaveConfirm = false;
    pkState.globalMenuSaveResult = '';
    pkState.globalMenuItemAction = '';
    pkState.globalMenuPokemonDetail = -1;
    pkState.globalMenuAnimTimer = 0;
    sfxMenuOpen();
  }

  function closeGlobalMenu() {
    pkState.globalMenuOpen = false;
    pkState.globalMenuSubMenu = '';
    pkState.globalMenuAnimTimer = 0;
    sfxMenuClose();
  }

  function handleGlobalMenuDirection(dir) {
    // === 子菜单方向 ===
    if (pkState.globalMenuSubMenu === 'POKEMON') {
      if (pkState.globalMenuPokemonDetail >= 0) return; // 详情页不处理方向
      const max = myPokemon.length - 1;
      if (dir === 'UP') pkState.globalMenuSubCursor = Math.max(0, pkState.globalMenuSubCursor - 1);
      else if (dir === 'DOWN') pkState.globalMenuSubCursor = Math.min(max, pkState.globalMenuSubCursor + 1);
      sfxMenuCursor();
      return;
    }
    if (pkState.globalMenuSubMenu === 'ITEM') {
      if (pkState.globalMenuItemAction) {
        // 使用/丢弃子操作
        if (dir === 'UP' || dir === 'DOWN') {
          pkState.globalMenuItemActionCursor = pkState.globalMenuItemActionCursor === 0 ? 1 : 0;
          sfxMenuCursor();
        }
        return;
      }
      // 物品列表方向（目前仅精灵球，未来可扩展）
      sfxMenuCursor();
      return;
    }
    if (pkState.globalMenuSubMenu === 'SAVE') {
      if (pkState.globalMenuSaveConfirm && !pkState.globalMenuSaveResult) {
        // 是/否 选择
        if (dir === 'UP' || dir === 'DOWN') {
          pkState.globalMenuSubCursor = pkState.globalMenuSubCursor === 0 ? 1 : 0;
          sfxMenuCursor();
        }
      }
      return;
    }
    if (pkState.globalMenuSubMenu === 'POKEDEX') {
      // 图鉴列表浏览
      const totalEntries = POKEDEX.length;
      if (dir === 'UP') pkState.globalMenuSubCursor = Math.max(0, pkState.globalMenuSubCursor - 1);
      else if (dir === 'DOWN') pkState.globalMenuSubCursor = Math.min(totalEntries - 1, pkState.globalMenuSubCursor + 1);
      sfxMenuCursor();
      return;
    }
    if (pkState.globalMenuSubMenu === 'OPTION') {
      // 设置选项
      sfxMenuCursor();
      return;
    }
    if (pkState.globalMenuSubMenu) return; // 其他子菜单不处理方向

    // === 主菜单方向 ===
    if (dir === 'UP') {
      pkState.globalMenuCursor = Math.max(0, pkState.globalMenuCursor - 1);
      sfxMenuCursor();
    } else if (dir === 'DOWN') {
      pkState.globalMenuCursor = Math.min(GLOBAL_MENU_ITEMS.length - 1, pkState.globalMenuCursor + 1);
      sfxMenuCursor();
    }
  }

  function handleGlobalMenuButton() {
    // === 子菜单按键 ===
    if (pkState.globalMenuSubMenu === 'POKEMON') {
      if (pkState.globalMenuPokemonDetail >= 0) {
        // 详情页 → 返回列表
        pkState.globalMenuPokemonDetail = -1;
        sfxBeep();
        return;
      }
      if (myPokemon.length > 0) {
        // 列表 → 进入详情
        pkState.globalMenuPokemonDetail = pkState.globalMenuSubCursor;
        sfxBeep();
      }
      return;
    }
    if (pkState.globalMenuSubMenu === 'ITEM') {
      if (pkState.globalMenuItemAction === 'USE_DROP') {
        // 使用/丢弃操作
        if (pkState.globalMenuItemActionCursor === 0) {
          // 使用（目前精灵球不能在菜单中使用）
          pkState.dialogActive = true;
          pkState.dialogText = '精灵球不能在这里使用！\n只能在战斗中使用。';
          pkState.dialogTimer = 0;
          pkState.globalMenuItemAction = '';
        } else {
          // 丢弃
          if (bag.pokeball > 0) {
            bag.pokeball--;
            pkState.dialogActive = true;
            pkState.dialogText = '丢掉了1个精灵球。';
            pkState.dialogTimer = 0;
          }
          pkState.globalMenuItemAction = '';
        }
        closeGlobalMenu();
        sfxBeep();
        return;
      }
      // 打开使用/丢弃选项
      pkState.globalMenuItemAction = 'USE_DROP';
      pkState.globalMenuItemActionCursor = 0;
      sfxBeep();
      return;
    }
    if (pkState.globalMenuSubMenu === 'SAVE') {
      if (pkState.globalMenuSaveResult === 'SAVED') {
        // 保存完成 → 返回主菜单
        pkState.globalMenuSubMenu = '';
        pkState.globalMenuSaveResult = '';
        sfxBeep();
        return;
      }
      if (pkState.globalMenuSaveConfirm) {
        if (pkState.globalMenuSubCursor === 0) {
          // 确认保存
          pkState.globalMenuSaveResult = 'SAVING';
          pkState.globalMenuSaveTimer = 0;
          // 实际执行保存
          setTimeout(() => {
            saveGame();
            pkState.globalMenuSaveResult = 'SAVED';
            sfxSave();
          }, 800);
        } else {
          // 取消
          pkState.globalMenuSubMenu = '';
          sfxMenuClose();
        }
        return;
      }
      // 第一次按键 → 弹出确认框
      pkState.globalMenuSaveConfirm = true;
      pkState.globalMenuSubCursor = 0;
      sfxBeep();
      return;
    }
    if (pkState.globalMenuSubMenu === 'POKEDEX') {
      // 图鉴按键 → 关闭回主菜单
      pkState.globalMenuSubMenu = '';
      sfxMenuClose();
      return;
    }
    if (pkState.globalMenuSubMenu === 'PLAYER') {
      pkState.globalMenuSubMenu = '';
      sfxMenuClose();
      return;
    }
    if (pkState.globalMenuSubMenu === 'OPTION') {
      pkState.globalMenuSubMenu = '';
      sfxMenuClose();
      return;
    }

    // === 主菜单确认 ===
    const selected = GLOBAL_MENU_ITEMS[pkState.globalMenuCursor];
    if (!selected) return;

    sfxBeep();

    if (selected.sub === 'EXIT') {
      closeGlobalMenu();
      return;
    }

    // 进入子菜单
    pkState.globalMenuSubMenu = selected.sub;
    pkState.globalMenuSubCursor = 0;
    pkState.globalMenuSubScrollOffset = 0;
    pkState.globalMenuSaveConfirm = false;
    pkState.globalMenuSaveResult = '';
    pkState.globalMenuItemAction = '';
    pkState.globalMenuPokemonDetail = -1;
  }

  // === 退出战斗，回到探索 ===
  function exitBattle() {
    // BOSS 战胜利后获取徽章
    if (pkState.isBossBattle && pkState.bossDef && pkState.enemyHP <= 0) {
      const boss = pkState.bossDef;
      if (!badges[boss.badgeId]) {
        badges[boss.badgeId] = { name: boss.badgeName, time: Date.now() };
        // 显示获得徽章对话
        pkState.gameMode = MODE_EXPLORING;
        pkState.dialogActive = true;
        pkState.dialogText = `恭喜！获得了 ${boss.badgeName}！\n你的实力得到了认可！`;
        pkState.dialogTimer = 0;
        sfxVictory();
        sendMotorFeedback();
      }
    }
    pkState.isBossBattle = false;
    pkState.bossDef = null;
    pkState.gameMode = MODE_EXPLORING;
    pkState.battlePhase = 'MENU';
    pkState.battleMsg = '';
    pkState.pendingDir = null;

    // 自动存档
    saveGame();
  }

  // === 尝试捕捉 ===
  function attemptCatch() {
    const monster = pkState._battleMonster;
    // 公式: Rate = (1 - CurrentHP/MaxHP) * CatchRate
    const hpRatio = pkState.enemyHP / pkState.enemyMaxHP;
    const catchChance = (1 - hpRatio) * (monster.catchRate || 0.5);
    pkState.catchSuccess = Math.random() < Math.max(0.1, Math.min(0.95, catchChance));

    // 开始捕捉动画
    pkState.battlePhase = 'CATCHING';
    pkState.catchAnimTimer = 0;
    pkState.catchAnimPhase = 0;
    // 球的起始位置（从玩家侧投出）
    pkState.catchBallX = 120;
    pkState.catchBallY = 280;
    sfxCatch();
  }

  // === 检查升级 ===
  function checkLevelUp() {
    const expThreshold = pkState.playerLevel * 20;
    if (pkState.playerExp >= expThreshold) {
      pkState.levelUpOldLevel = pkState.playerLevel;
      pkState.playerLevel++;
      const hpGain = 4 + Math.floor(Math.random() * 3);
      const atkGain = 1 + Math.floor(Math.random() * 2);
      const spdGain = Math.random() < 0.5 ? 1 : 0;
      pkState.playerMaxHP += hpGain;
      pkState.playerHP = Math.min(pkState.playerHP + hpGain + 5, pkState.playerMaxHP);
      pkState.playerAtk += atkGain;
      pkState.playerSpeed += spdGain;
      pkState.playerExp -= expThreshold;
      pkState.playerDisplayHP = pkState.playerHP;
      pkState.levelUpNewStats = { hp: hpGain, atk: atkGain, spd: spdGain };
      pkState.levelUpAnimTimer = 0;
      pkState.battlePhase = 'LEVEL_UP';
      pkState.battleMsg = `🎉 等级提升至 Lv.${pkState.playerLevel}！\nHP+${hpGain}  ATK+${atkGain}${spdGain > 0 ? '  SPD+' + spdGain : ''}`;
      pkState.battleMsgTimer = 0;
      sfxLevelUp();
      sendMotorFeedback(); // 硬件震动奖励
      return true;
    }
    return false;
  }

  // === BOSS 战触发 ===
  function triggerBossBattle(boss) {
    pkState.isBossBattle = true;
    pkState.bossDef = boss;
    pkState.battleMonsterName = boss.pokemon.name;
    pkState._battleMonster = boss.pokemon;
    pkState.gameMode = MODE_TRANSITION;
    pkState.transitionTimer = 0;
    pkState.battleFlashTimer = 0;
    pkState.pendingDir = null;

    // BOSS 等级和数值
    pkState.enemyLevel = boss.level;
    pkState.enemyMaxHP = boss.pokemon.hp + boss.level * 4;
    pkState.enemyHP = pkState.enemyMaxHP;
    pkState.enemyDisplayHP = pkState.enemyMaxHP;
    pkState.enemyAtk = (boss.pokemon.atk || 12) + boss.level * 2;
    pkState.enemySpeed = (boss.pokemon.spd || 5) + boss.level;
    pkState._enemyAtkDebuff = 0;

    // 重置战斗状态
    pkState.battlePhase = 'MENU';
    pkState.menuCursor = 0;
    pkState.skillCursor = 0;
    pkState.bagCursor = 0;
    pkState.battleMsg = '';
    pkState.battleMsgTimer = 0;
    pkState.battleAnimTimer = 0;
    pkState.battleShakeEnemy = 0;
    pkState.battleShakePlayer = 0;
    pkState.playerDisplayHP = pkState.playerHP;
    pkState._playerSpdDebuff = 0;

    sfxBossStart();
  }

  // === 传送系统 ===
  function startPortalTransition(portal) {
    pkState.portalTransition = true;
    pkState.portalFadeTimer = 0;
    pkState.portalTarget = { toMap: portal.toMap, tx: portal.tx, ty: portal.ty };
    pkState.gameMode = 'PORTAL_TRANSITION';
    sfxPortal();
  }

  function executePortal() {
    const target = pkState.portalTarget;
    if (!target) return;

    // 切换地图
    currentMapId = target.toMap;
    npcs = collectNPCs(currentMapId);

    // 移动玩家
    pkState.px = target.tx;
    pkState.py = target.ty;
    pkState.targetX = target.tx;
    pkState.targetY = target.ty;

    // 重置相机
    pkState.camX = pkState.px * TILE - (VIEW_W * TILE) / 2 + TILE / 2;
    pkState.camY = pkState.py * TILE - (VIEW_H * TILE) / 2 + TILE / 2;

    pkState.portalTarget = null;

    // 自动存档
    saveGame();
  }

  // === 存档系统 ===
  const SAVE_KEY = 'pokemon_rpg_save_v1';

  function saveGame() {
    try {
      const saveData = {
        mapId: currentMapId,
        px: pkState.px, py: pkState.py,
        dir: pkState.dir,
        playerHP: pkState.playerHP,
        playerMaxHP: pkState.playerMaxHP,
        playerAtk: pkState.playerAtk,
        playerSpeed: pkState.playerSpeed,
        playerLevel: pkState.playerLevel,
        playerExp: pkState.playerExp,
        steps: pkState.steps,
        pokedex: pokedex,
        myPokemon: myPokemon,
        bag: bag,
        badges: badges,
        skills: pkState.skills.map(s => ({ name: s.name, power: s.power, type: s.type, skillTypeZh: s.skillTypeZh, emoji: s.emoji })),
        pcStorage: pcStorage, // PC 电脑存储
        timestamp: Date.now(),
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(saveData));
    } catch (e) {
      console.warn('存档失败:', e);
    }
  }

  function loadGame() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);

      currentMapId = data.mapId || 0;
      npcs = collectNPCs(currentMapId);

      pkState.px = data.px || 4;
      pkState.py = data.py || 4;
      pkState.targetX = pkState.px;
      pkState.targetY = pkState.py;
      pkState.dir = data.dir || DIR_DOWN;
      pkState.playerHP = data.playerHP || 50;
      pkState.playerMaxHP = data.playerMaxHP || 50;
      pkState.playerAtk = data.playerAtk || 15;
      pkState.playerSpeed = data.playerSpeed || 10;
      pkState.playerLevel = data.playerLevel || 5;
      pkState.playerExp = data.playerExp || 0;
      pkState.playerDisplayHP = pkState.playerHP;
      pkState.steps = data.steps || 0;

      // 恢复图鉴
      if (data.pokedex) {
        Object.keys(data.pokedex).forEach(k => { pokedex[k] = data.pokedex[k]; });
      }

      // 恢复已捕获精灵
      if (data.myPokemon) {
        myPokemon.length = 0;
        data.myPokemon.forEach(p => myPokemon.push(p));
      }

      // 恢复背包
      if (data.bag) {
        bag.pokeball = data.bag.pokeball || 5;
      }

      // 恢复徽章
      if (data.badges) {
        badges = data.badges;
      }

      // 恢复技能（完整恢复，包括新获得的技能）
      if (data.skills && data.skills.length > 0) {
        pkState.skills = data.skills;
      }

      // 恢复 PC 电脑存储
      if (data.pcStorage) {
        pcStorage.length = 0;
        data.pcStorage.forEach(p => pcStorage.push(p));
      }

      // 相机
      pkState.camX = pkState.px * TILE - (VIEW_W * TILE) / 2 + TILE / 2;
      pkState.camY = pkState.py * TILE - (VIEW_H * TILE) / 2 + TILE / 2;

      return true;
    } catch (e) {
      console.warn('读档失败:', e);
      return false;
    }
  }

  // === 进化检查（基于 POKEDEX 数据） ===
  // 查找 POKEDEX 中的下一个进化形态（id+1, id+2 等同一进化链）
  function findEvolution(pokemonId) {
    const current = POKEDEX.find(p => p.id === pokemonId);
    if (!current || !current.e) return null; // 没有 e 字段 = 无法进化
    // 下一个进化形态就是 id+1（因为 POKEDEX 按进化链排列）
    const next = POKEDEX.find(p => p.id === pokemonId + 1);
    if (!next) return null;
    return {
      level: current.e,
      nextId: next.id,
      newName: next.n,
      newColor: TYPE_COLORS[next.t[0]] || '#888',
      newColorLight: lightenColor(TYPE_COLORS[next.t[0]] || '#888', 40),
      newTypes: next.t,
      hpBoost: next.s.hp - current.s.hp,
      atkBoost: next.s.at - current.s.at,
      defBoost: next.s.de - current.s.de,
      spdBoost: next.s.sp - current.s.sp,
    };
  }

  function checkEvolution() {
    for (let i = 0; i < myPokemon.length; i++) {
      const p = myPokemon[i];
      if (p.evolved) continue;
      const evo = findEvolution(p.id);
      if (evo && p.level >= evo.level) {
        // 触发进化动画
        pkState.evolveTriggered = true;
        pkState.evolveOldName = p.name;
        pkState.evolveNewName = evo.newName;
        pkState.evolveAnimTimer = 0;
        pkState._evolvingPokemon = p; // 引用，用于进化场景绘制
        pkState._evolveNewColor = evo.newColor;

        // 更新精灵数据
        p.name = evo.newName;
        p.id = evo.nextId;
        p.color = evo.newColor;
        p.colorLight = evo.newColorLight;
        if (p.types) p.types = evo.newTypes;
        p.maxHP += Math.max(0, evo.hpBoost);
        p.hp = p.maxHP;
        p.atk += Math.max(0, evo.atkBoost);
        if (p.def) p.def += Math.max(0, evo.defBoost);
        if (p.spd) p.spd += Math.max(0, evo.spdBoost);
        p.evolved = true;

        sfxEvolve();
        sendMotorFeedback(); // 硬件震动
        return true;
      }
    }
    return false;
  }

  // === 1996 风格战斗文本流队列系统 ===
  function enqueueBattleText(textArray, callback) {
    pkState.battleTextQueue = textArray.slice(); // [{text:'...'}]
    pkState.battleTextCallback = callback || null;
    advanceBattleText();
  }

  function advanceBattleText() {
    if (pkState.battleTextQueue.length === 0) {
      pkState.battlePhase = 'MENU';
      pkState.menuCursor = 0;
      pkState.battleTextCurrent = '';
      pkState.battleTextWaiting = false;
      if (pkState.battleTextCallback) {
        const cb = pkState.battleTextCallback;
        pkState.battleTextCallback = null;
        cb();
      }
      return;
    }
    const next = pkState.battleTextQueue.shift();
    pkState.battleTextCurrent = next.text;
    pkState.battleTextCharIndex = 0;
    pkState.battleTextWaiting = false;
    pkState.battlePhase = 'TEXT_FLOW';
    pkState.battleMsg = next.text; // 兼容现有消息框
    pkState.battleMsgTimer = 0;
  }

  // === 为精灵生成技能列表（基于MOVE_POOL） ===
  function generateSkillsForPokemon(pokemonId, level) {
    const moves = getLearnableMoves(pokemonId, level);
    if (moves.length === 0) {
      // 默认给一个撞击
      return [{ name: '撞击', power: 10, type: 'normal', skillTypeZh: '普通', emoji: '💥' }];
    }
    // 取最后4个（最高等级的技能）
    const selected = moves.slice(-4);
    return selected.map(m => ({ name: m.name, power: m.power, type: m.type, skillTypeZh: m.skillTypeZh, emoji: m.emoji }));
  }

  // === 检查队伍精灵的新技能学习 ===
  function checkPartyNewMoves(oldLevels) {
    for (let i = 0; i < myPokemon.length; i++) {
      const p = myPokemon[i];
      const key = p.id + '_' + (p.uid || 0);
      const oldLv = oldLevels[key] || (p.level - 1);
      const newMoves = checkNewMoves(p.id, oldLv, p.level);
      for (const move of newMoves) {
        const skill = { name: move.name, power: move.power, type: move.type, skillTypeZh: move.skillTypeZh, emoji: move.emoji };
        if (!p.skills) p.skills = [];
        // 检查是否已经有这个技能
        if (p.skills.some(s => s.name === skill.name)) continue;
        if (p.skills.length < 4) {
          // 直接学会
          p.skills.push(skill);
          // 如果是首位精灵，同步到玩家技能
          if (i === 0) {
            if (!pkState.skills.some(s => s.name === skill.name) && pkState.skills.length < 4) {
              pkState.skills.push(skill);
            }
          }
        } else {
          // 技能槽满，需要弹出1996风格替换对话
          pkState.learnSkillPending = skill;
          pkState.learnSkillPokemonIdx = i;
          pkState.learnSkillCursor = 0;
          pkState.learnSkillPhase = 'ASK_LEARN';
          pkState.battleMsg = `${p.name} 想学习 ${skill.name}！\n但是已经学会了4个招式。\n要覆盖一个招式吗？`;
          pkState.battleMsgTimer = 0;
          return; // 一次只处理一个技能学习
        }
      }
    }
  }

  // === 逃跑 ===
  function attemptFlee() {
    // BOSS 战不可逃跑
    if (pkState.isBossBattle) {
      pkState.battleMsg = '面对馆主不能逃跑！';
      pkState.battleMsgTimer = 0;
      pkState.battlePhase = 'RESULT';
      sfxThump();
      return;
    }
    // 逃跑概率: 基础 50% + speed 差距加成
    const fleeChance = 0.5 + (pkState.playerSpeed - pkState.enemySpeed) * 0.05;
    if (Math.random() < Math.max(0.2, Math.min(0.9, fleeChance))) {
      pkState.battlePhase = 'FLEE';
      pkState.battleMsg = '成功逃跑了！';
      pkState.battleMsgTimer = 0;
      sfxBeep();
    } else {
      // 逃跑失败 → 敌人攻击
      pkState.battleMsg = '逃跑失败！';
      pkState.battleMsgTimer = 0;
      pkState.battlePhase = 'RESULT';
      sfxThump();
      // 让敌人在结果确认后自动攻击
      pkState._pendingEnemyAttack = true;
    }
  }

  // === 玩家攻击（含属性克制 + 1996风格延迟扣血 + 屏幕闪烁特效） ===
  function executePlayerAttack(skill) {
    pkState.battlePhase = 'PLAYER_ATTACK';
    pkState.battleAnimTimer = 0;
    pkState._lastTypeEffectivenessMsg = '';

    if (skill.type === 'debuff') {
      pkState._playerSpdDebuff = Math.min(pkState._playerSpdDebuff + 3, 12);
      // 1996风格：先显示使用技能，延迟后显示效果
      pkState.battleMsg = `${skill.emoji} 使用了 ${skill.name}！`;
      pkState.battleDamageText = 'DEF↓';
      pkState._pendingEffectMsg = '降低了对方的防御！';
      sfxDebuff();
    } else if (skill.type === 'debuff_atk') {
      pkState._enemyAtkDebuff = Math.min(pkState._enemyAtkDebuff + 3, 12);
      pkState.battleMsg = `${skill.emoji} 使用了 ${skill.name}！`;
      pkState.battleDamageText = 'ATK↓';
      pkState._pendingEffectMsg = '降低了对方的攻击力！';
      sfxDebuff();
    } else {
      // 伤害技能 — 先显示使用技能文本，延迟后扣血
      const randomFactor = 0.85 + Math.random() * 0.3;
      let baseDamage = (pkState.playerAtk + skill.power) * randomFactor - pkState._enemyAtkDebuff;

      // 属性克制倍率
      const skillTypeMap = { 'normal':'普通', 'fire':'火', 'water':'水', 'grass':'草', 'electric':'电', 'ice':'冰', 'fighting':'格斗', 'poison':'毒', 'ground':'地面', 'flying':'飞行', 'psychic':'超能', 'bug':'虫', 'rock':'岩石', 'ghost':'鬼', 'dragon':'龙', 'steel':'钢', 'fairy':'仙' };
      const atkType = skillTypeMap[skill.type] || skill.skillTypeZh || '普通';
      const defTypes = pkState._battleMonster.types || [pkState._battleMonster.type || '普通'];
      const effectiveness = getTypeEffectiveness(atkType, defTypes);

      baseDamage *= effectiveness;
      const damage = Math.max(1, Math.floor(baseDamage));

      // 1996风格：先显示"使用了XX！"，延迟500ms(~30帧)后扣血
      pkState.battleMsg = `${skill.emoji} 使用了 ${skill.name}！`;
      pkState._pendingDamage = damage;
      pkState._pendingEffectiveness = effectiveness;
      pkState.battleDamageText = '';

      // 克制提示文本（延迟显示）
      let effectMsg = '';
      if (effectiveness >= 2) {
        effectMsg = '⚡ 效果拔群！';
        pkState._lastTypeEffectivenessMsg = 'super';
        // 屏幕闪烁特效（效果拔群）
        pkState.screenFlashTimer = 24; // 黑白反转闪烁2次（每次6帧共24帧）
        pkState.screenFlashType = 'super';
        sendMotorFeedback(); // 硬件震动
      } else if (effectiveness > 0 && effectiveness < 1) {
        effectMsg = '△ 效果不好...';
        pkState._lastTypeEffectivenessMsg = 'not_very';
      } else if (effectiveness === 0) {
        effectMsg = '✕ 没有效果！';
        pkState._lastTypeEffectivenessMsg = 'immune';
      }
      pkState._pendingEffectMsg = effectMsg;

      sfxAttack();
    }

    pkState.battleMsgTimer = 0;
  }

  // === 敌人攻击（含属性克制） ===
  function executeEnemyAttack() {
    pkState.battlePhase = 'ENEMY_ATTACK';
    pkState.battleAnimTimer = 0;

    const randomFactor = 0.85 + Math.random() * 0.3;
    const enemyAtk = Math.max(1, pkState.enemyAtk - pkState._enemyAtkDebuff);
    let baseDamage = enemyAtk * randomFactor - pkState._playerSpdDebuff;

    // 敌方属性克制（敌方主属性 vs 玩家无属性=普通）
    const enemyTypes = pkState._battleMonster.types || [pkState._battleMonster.type || '普通'];
    const effectiveness = getTypeEffectiveness(enemyTypes[0], ['普通']);
    baseDamage *= effectiveness;

    const damage = Math.max(1, Math.floor(baseDamage));
    pkState.playerHP = Math.max(0, pkState.playerHP - damage);

    let effectMsg = '';
    if (effectiveness >= 2) effectMsg = '\n⚡ 效果拔群！';
    else if (effectiveness > 0 && effectiveness < 1) effectMsg = '\n△ 效果不好...';

    const prefix = pkState.isBossBattle ? '' : '野生的 ';
    pkState.battleMsg = `${prefix}${pkState.battleMonsterName} 发动了攻击！\n造成 ${damage} 点伤害！${effectMsg}`;
    pkState.battleDamageText = `-${damage}`;
    pkState.battleMsgTimer = 0;
    sfxAttack();
  }

  function tryMove(dir) {
    pkState.dir = dir;
    const nx = pkState.px + DIR_DX[dir];
    const ny = pkState.py + DIR_DY[dir];
    const map = getCurrentMap();

    // 边界检查
    if (nx < 0 || nx >= MAP_W || ny < 0 || ny >= MAP_H) {
      sfxThump();
      return;
    }

    // 碰撞检查
    const tile = map[ny][nx];
    if (tile === T_WALL || tile === T_NPC || tile === T_BOSS) {
      sfxThump();
      return;
    }

    // 开始移动
    pkState.moving = true;
    pkState.moveProgress = 0;
    pkState.targetX = nx;
    pkState.targetY = ny;
  }

  // 键盘映射
  function keyHandler(e) {
    if (e.repeat) return;
    const kmap = {
      'ArrowUp': 'UP', 'ArrowDown': 'DOWN', 'ArrowLeft': 'LEFT', 'ArrowRight': 'RIGHT',
      'w': 'UP', 's': 'DOWN', 'a': 'LEFT', 'd': 'RIGHT',
      'W': 'UP', 'S': 'DOWN', 'A': 'LEFT', 'D': 'RIGHT',
    };
    if (kmap[e.key]) {
      handleDirection(kmap[e.key], null);
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      handleButton(null);
    }
    if (e.key === 'Escape' || e.key === 'Backspace') {
      // 关闭全局菜单（ESC 优先级最高）
      if (pkState.globalMenuOpen) {
        if (pkState.globalMenuSubMenu) {
          // 子菜单 → 返回主菜单
          if (pkState.globalMenuItemAction) {
            pkState.globalMenuItemAction = '';
            sfxMenuClose();
          } else {
            pkState.globalMenuSubMenu = '';
            sfxMenuClose();
          }
        } else {
          closeGlobalMenu();
        }
        return;
      }
      // 关闭 PC 存储
      if (pkState.pcStorageOpen) {
        pkState.pcStorageOpen = false;
        sfxBeep();
        return;
      }
      // 关闭地图菜单
      if (pkState.mapMenuOpen) {
        pkState.mapMenuOpen = false;
        sfxBeep();
        return;
      }
      // 关闭图鉴
      if (pkState.pokedexOpen) {
        pkState.pokedexOpen = false;
        sfxBeep();
        return;
      }
      // 技能学习取消（放弃学习）
      if (pkState.learnSkillPhase === 'ASK_LEARN' || pkState.learnSkillPhase === 'SELECT_REPLACE') {
        const pokemon = myPokemon[pkState.learnSkillPokemonIdx];
        pkState.battleMsg = `${pokemon ? pokemon.name : ''} 没有学会\n${pkState.learnSkillPending ? pkState.learnSkillPending.name : '新技能'}。`;
        pkState.learnSkillPhase = '';
        pkState.learnSkillPending = null;
        pkState.battlePhase = 'RESULT';
        pkState.battleMsgTimer = 0;
        sfxBeep();
        return;
      }
      // 退出技能菜单 / 背包菜单回主菜单
      if (pkState.gameMode === MODE_BATTLE) {
        if (pkState.battlePhase === 'SKILL_MENU' || pkState.battlePhase === 'BAG_MENU') {
          pkState.battlePhase = 'MENU';
          pkState.menuCursor = 0;
          sfxBeep();
        }
      }
    }
    // P 键打开/关闭图鉴（探索模式）
    if (e.key === 'p' || e.key === 'P') {
      if (pkState.gameMode === MODE_EXPLORING && !pkState.dialogActive && !pkState.moving && !pkState.mapMenuOpen && !pkState.globalMenuOpen) {
        pkState.pokedexOpen = !pkState.pokedexOpen;
        pkState.pokedexCursor = 0;
        sfxBeep();
      }
    }
    // M 键打开/关闭地图信息
    if (e.key === 'm' || e.key === 'M') {
      if (pkState.gameMode === MODE_EXPLORING && !pkState.dialogActive && !pkState.pokedexOpen && !pkState.globalMenuOpen) {
        pkState.mapMenuOpen = !pkState.mapMenuOpen;
        sfxBeep();
      }
    }
    // I 键显示当前地图捕捉进度
    if (e.key === 'i' || e.key === 'I') {
      if (pkState.gameMode === MODE_EXPLORING && !pkState.dialogActive && !pkState.pokedexOpen && !pkState.mapMenuOpen && !pkState.globalMenuOpen) {
        const spawns = SPAWN_TABLES[currentMapId] || [];
        if (spawns.length === 0) {
          pkState.dialogActive = true;
          pkState.dialogText = '这个区域没有野生精灵出没。';
          pkState.dialogTimer = 0;
        } else {
          const caught = spawns.filter(id => pokedex[id] && pokedex[id].caught).length;
          const seen = spawns.filter(id => pokedex[id] && pokedex[id].seen).length;
          const names = spawns.map(id => {
            const p = POKEDEX.find(x => x.id === id);
            const dex = pokedex[id];
            if (dex && dex.seen) return (dex.caught ? '✅' : '👁') + (p ? p.n : '???');
            return '???';
          });
          pkState.dialogActive = true;
          pkState.dialogText = `${MAP_NAMES[currentMapId]} 捕捉进度\n已见:${seen} 已捕:${caught}/${spawns.length}\n${names.join(' ')}`;
          pkState.dialogTimer = 0;
        }
        sfxBeep();
      }
    }
    // C 键打开/关闭 PC 电脑存储
    if (e.key === 'c' || e.key === 'C') {
      if (pkState.gameMode === MODE_EXPLORING && !pkState.dialogActive && !pkState.pokedexOpen && !pkState.mapMenuOpen && !pkState.globalMenuOpen) {
        pkState.pcStorageOpen = !pkState.pcStorageOpen;
        pkState.pcStorageCursor = 0;
        pkState.pcStorageScrollOffset = 0;
        sfxBeep();
      }
    }
    // S 键手动存档
    if (e.key === 'o' || e.key === 'O') {
      if (pkState.gameMode === MODE_EXPLORING && !pkState.dialogActive && !pkState.globalMenuOpen) {
        saveGame();
        sfxSave();
        // 短暂显示存档成功提示
        pkState.dialogActive = true;
        pkState.dialogText = '💾 游戏已保存！\n进度已存入浏览器。';
        pkState.dialogTimer = 0;
      }
    }
  }

  // 注册键盘（游戏框架的 gameKeyHandler 已经注册，但 RPG 需要自己的）
  // 我们通过 window 全局回调让 gameKeyHandler 分发
  // 但 pokemon 比较特殊，需要阻止重复按键，所以额外绑定
  document.addEventListener('keydown', keyHandler);
  // 保存清理函数
  const origCleanup = gameState._jumpCleanup;
  gameState._jumpCleanup = function() {
    document.removeEventListener('keydown', keyHandler);
    if (origCleanup) origCleanup();
  };

  // 暴露给串口分发
  window._pokemonHandleDirection = handleDirection;
  window._pokemonHandleButton = handleButton;

  // ===== 151 全精灵数据库 (POKEDEX) =====
  // 基于初代 151 只，包含 id、名称、属性(t)、基础能力值(s)和进化等级(e)
  const POKEDEX = [
    {id:1,n:"妙蛙种子",t:["草","毒"],s:{hp:45,at:49,de:49,sp:45},e:16},{id:2,n:"妙蛙草",t:["草","毒"],s:{hp:60,at:62,de:63,sp:60},e:32},{id:3,n:"妙蛙花",t:["草","毒"],s:{hp:80,at:82,de:83,sp:80}},
    {id:4,n:"小火龙",t:["火"],s:{hp:39,at:52,de:43,sp:65},e:16},{id:5,n:"火恐龙",t:["火"],s:{hp:58,at:64,de:58,sp:80},e:36},{id:6,n:"喷火龙",t:["火","飞行"],s:{hp:78,at:84,de:78,sp:100}},
    {id:7,n:"杰尼龟",t:["水"],s:{hp:44,at:48,de:65,sp:43},e:16},{id:8,n:"卡咪龟",t:["水"],s:{hp:59,at:63,de:80,sp:58},e:36},{id:9,n:"水箭龟",t:["水"],s:{hp:79,at:83,de:100,sp:78}},
    {id:10,n:"绿毛虫",t:["虫"],s:{hp:45,at:30,de:35,sp:45},e:7},{id:11,n:"铁甲蛹",t:["虫"],s:{hp:50,at:20,de:55,sp:30},e:10},{id:12,n:"巴大蝶",t:["虫","飞行"],s:{hp:60,at:45,de:50,sp:70}},
    {id:13,n:"独角虫",t:["虫","毒"],s:{hp:40,at:35,de:30,sp:50},e:7},{id:14,n:"铁壳蛹",t:["虫","毒"],s:{hp:45,at:25,de:50,sp:35},e:10},{id:15,n:"大针蜂",t:["虫","毒"],s:{hp:65,at:90,de:40,sp:75}},
    {id:16,n:"波波",t:["普通","飞行"],s:{hp:40,at:45,de:40,sp:56},e:18},{id:17,n:"比比鸟",t:["普通","飞行"],s:{hp:63,at:60,de:55,sp:71},e:36},{id:18,n:"大比鸟",t:["普通","飞行"],s:{hp:83,at:80,de:75,sp:101}},
    {id:19,n:"小拉达",t:["普通"],s:{hp:30,at:56,de:35,sp:72},e:20},{id:20,n:"拉达",t:["普通"],s:{hp:55,at:81,de:60,sp:97}},
    {id:21,n:"烈雀",t:["普通","飞行"],s:{hp:40,at:60,de:30,sp:70},e:20},{id:22,n:"大嘴雀",t:["普通","飞行"],s:{hp:65,at:90,de:65,sp:100}},
    {id:23,n:"阿柏蛇",t:["毒"],s:{hp:35,at:60,de:44,sp:55},e:22},{id:24,n:"阿柏怪",t:["毒"],s:{hp:60,at:95,de:69,sp:80}},
    {id:25,n:"皮卡丘",t:["电"],s:{hp:35,at:55,de:40,sp:90},e:0},{id:26,n:"雷丘",t:["电"],s:{hp:60,at:90,de:55,sp:110}},
    {id:27,n:"穿山鼠",t:["地面"],s:{hp:50,at:75,de:85,sp:40},e:22},{id:28,n:"穿山王",t:["地面"],s:{hp:75,at:100,de:110,sp:65}},
    {id:29,n:"尼多兰",t:["毒"],s:{hp:55,at:47,de:52,sp:41},e:16},{id:30,n:"尼多娜",t:["毒"],s:{hp:70,at:62,de:67,sp:56},e:0},{id:31,n:"尼多后",t:["毒","地面"],s:{hp:90,at:92,de:87,sp:76}},
    {id:32,n:"尼多朗",t:["毒"],s:{hp:46,at:57,de:40,sp:50},e:16},{id:33,n:"尼多力诺",t:["毒"],s:{hp:61,at:72,de:57,sp:65},e:0},{id:34,n:"尼多王",t:["毒","地面"],s:{hp:81,at:102,de:77,sp:85}},
    {id:35,n:"皮皮",t:["仙"],s:{hp:70,at:45,de:48,sp:35},e:0},{id:36,n:"皮可西",t:["仙"],s:{hp:95,at:70,de:73,sp:60}},
    {id:37,n:"六尾",t:["火"],s:{hp:38,at:41,de:40,sp:65},e:0},{id:38,n:"九尾",t:["火"],s:{hp:73,at:76,de:75,sp:100}},
    {id:39,n:"胖丁",t:["普通","仙"],s:{hp:115,at:45,de:20,sp:20},e:0},{id:40,n:"胖可丁",t:["普通","仙"],s:{hp:140,at:70,de:45,sp:45}},
    {id:41,n:"超音蝠",t:["毒","飞行"],s:{hp:40,at:45,de:35,sp:55},e:22},{id:42,n:"大嘴蝠",t:["毒","飞行"],s:{hp:75,at:80,de:70,sp:90}},
    {id:43,n:"走路草",t:["草","毒"],s:{hp:45,at:50,de:55,sp:30},e:21},{id:44,n:"臭臭花",t:["草","毒"],s:{hp:60,at:65,de:70,sp:40},e:0},{id:45,n:"霸王花",t:["草","毒"],s:{hp:75,at:80,de:85,sp:50}},
    {id:46,n:"派拉斯",t:["虫","草"],s:{hp:35,at:70,de:55,sp:25},e:24},{id:47,n:"派拉斯特",t:["虫","草"],s:{hp:60,at:95,de:80,sp:30}},
    {id:48,n:"毛球",t:["虫","毒"],s:{hp:60,at:55,de:50,sp:45},e:31},{id:49,n:"摩鲁蛾",t:["虫","毒"],s:{hp:70,at:65,de:60,sp:90}},
    {id:50,n:"地鼠",t:["地面"],s:{hp:10,at:55,de:25,sp:95},e:26},{id:51,n:"三地鼠",t:["地面"],s:{hp:35,at:100,de:50,sp:120}},
    {id:52,n:"喵喵",t:["普通"],s:{hp:40,at:45,de:35,sp:90},e:28},{id:53,n:"猫老大",t:["普通"],s:{hp:65,at:70,de:60,sp:115}},
    {id:54,n:"可达鸭",t:["水"],s:{hp:50,at:52,de:48,sp:55},e:33},{id:55,n:"哥达鸭",t:["水"],s:{hp:80,at:82,de:78,sp:85}},
    {id:56,n:"猴怪",t:["格斗"],s:{hp:40,at:80,de:35,sp:70},e:28},{id:57,n:"火暴猴",t:["格斗"],s:{hp:65,at:105,de:60,sp:95}},
    {id:58,n:"卡蒂狗",t:["火"],s:{hp:55,at:70,de:45,sp:60},e:0},{id:59,n:"风速狗",t:["火"],s:{hp:90,at:110,de:80,sp:95}},
    {id:60,n:"蚊香蝌蚪",t:["水"],s:{hp:40,at:50,de:40,sp:90},e:25},{id:61,n:"蚊香君",t:["水"],s:{hp:65,at:65,de:65,sp:90},e:0},{id:62,n:"蚊香泳士",t:["水","格斗"],s:{hp:90,at:95,de:95,sp:70}},
    {id:63,n:"凯西",t:["超能"],s:{hp:25,at:20,de:15,sp:90},e:16},{id:64,n:"勇基拉",t:["超能"],s:{hp:40,at:35,de:30,sp:105},e:0},{id:65,n:"胡地",t:["超能"],s:{hp:55,at:50,de:45,sp:120}},
    {id:66,n:"腕力",t:["格斗"],s:{hp:70,at:80,de:50,sp:35},e:28},{id:67,n:"豪力",t:["格斗"],s:{hp:80,at:100,de:70,sp:45},e:0},{id:68,n:"怪力",t:["格斗"],s:{hp:90,at:130,de:80,sp:55}},
    {id:69,n:"喇叭芽",t:["草","毒"],s:{hp:50,at:75,de:35,sp:40},e:21},{id:70,n:"口呆花",t:["草","毒"],s:{hp:65,at:90,de:50,sp:55},e:0},{id:71,n:"大食花",t:["草","毒"],s:{hp:80,at:105,de:65,sp:70}},
    {id:72,n:"玛瑙水母",t:["水","毒"],s:{hp:40,at:40,de:35,sp:70},e:30},{id:73,n:"毒刺水母",t:["水","毒"],s:{hp:80,at:70,de:65,sp:100}},
    {id:74,n:"小拳石",t:["岩石","地面"],s:{hp:40,at:80,de:100,sp:20},e:25},{id:75,n:"隆隆石",t:["岩石","地面"],s:{hp:55,at:95,de:115,sp:35},e:0},{id:76,n:"隆隆岩",t:["岩石","地面"],s:{hp:80,at:120,de:130,sp:45}},
    {id:77,n:"小火马",t:["火"],s:{hp:50,at:85,de:55,sp:90},e:40},{id:78,n:"烈焰马",t:["火"],s:{hp:65,at:100,de:70,sp:105}},
    {id:79,n:"呆呆兽",t:["水","超能"],s:{hp:90,at:65,de:65,sp:15},e:37},{id:80,n:"呆壳兽",t:["水","超能"],s:{hp:95,at:75,de:110,sp:30}},
    {id:81,n:"小磁怪",t:["电","钢"],s:{hp:25,at:35,de:70,sp:45},e:30},{id:82,n:"三合一磁怪",t:["电","钢"],s:{hp:50,at:60,de:95,sp:70}},
    {id:83,n:"大葱鸭",t:["普通","飞行"],s:{hp:52,at:90,de:55,sp:60}},
    {id:84,n:"嘟嘟",t:["普通","飞行"],s:{hp:35,at:85,de:45,sp:75},e:31},{id:85,n:"嘟嘟利",t:["普通","飞行"],s:{hp:60,at:110,de:70,sp:110}},
    {id:86,n:"小海狮",t:["水"],s:{hp:65,at:45,de:55,sp:45},e:34},{id:87,n:"白海狮",t:["水","冰"],s:{hp:90,at:70,de:80,sp:70}},
    {id:88,n:"臭泥",t:["毒"],s:{hp:80,at:80,de:50,sp:25},e:38},{id:89,n:"臭臭泥",t:["毒"],s:{hp:105,at:105,de:75,sp:50}},
    {id:90,n:"大舌贝",t:["水"],s:{hp:30,at:65,de:100,sp:40},e:0},{id:91,n:"刺甲贝",t:["水","冰"],s:{hp:50,at:95,de:180,sp:70}},
    {id:92,n:"鬼斯",t:["鬼","毒"],s:{hp:30,at:35,de:30,sp:80},e:25},{id:93,n:"鬼斯通",t:["鬼","毒"],s:{hp:45,at:50,de:45,sp:95},e:0},{id:94,n:"耿鬼",t:["鬼","毒"],s:{hp:60,at:65,de:60,sp:110}},
    {id:95,n:"大岩蛇",t:["岩石","地面"],s:{hp:35,at:45,de:160,sp:70}},
    {id:96,n:"催眠貘",t:["超能"],s:{hp:60,at:48,de:45,sp:42},e:26},{id:97,n:"引梦貘人",t:["超能"],s:{hp:85,at:73,de:70,sp:67}},
    {id:98,n:"大钳蟹",t:["水"],s:{hp:30,at:105,de:90,sp:50},e:28},{id:99,n:"巨钳蟹",t:["水"],s:{hp:55,at:130,de:115,sp:75}},
    {id:100,n:"霹雳电球",t:["电"],s:{hp:40,at:30,de:50,sp:100},e:30},{id:101,n:"顽皮雷弹",t:["电"],s:{hp:60,at:50,de:70,sp:150}},
    {id:102,n:"蛋蛋",t:["草","超能"],s:{hp:60,at:40,de:80,sp:40},e:0},{id:103,n:"椰蛋树",t:["草","超能"],s:{hp:95,at:95,de:85,sp:55}},
    {id:104,n:"卡拉卡拉",t:["地面"],s:{hp:50,at:50,de:95,sp:35},e:28},{id:105,n:"嘎啦嘎啦",t:["地面"],s:{hp:60,at:80,de:110,sp:45}},
    {id:106,n:"飞腿郎",t:["格斗"],s:{hp:50,at:120,de:53,sp:87}},{id:107,n:"快拳郎",t:["格斗"],s:{hp:50,at:105,de:79,sp:76}},
    {id:108,n:"大舌头",t:["普通"],s:{hp:90,at:55,de:75,sp:30}},
    {id:109,n:"瓦斯弹",t:["毒"],s:{hp:40,at:65,de:95,sp:35},e:35},{id:110,n:"双弹瓦斯",t:["毒"],s:{hp:65,at:90,de:120,sp:60}},
    {id:111,n:"独角犀牛",t:["地面","岩石"],s:{hp:80,at:85,de:95,sp:25},e:42},{id:112,n:"钻角犀兽",t:["地面","岩石"],s:{hp:105,at:130,de:120,sp:40}},
    {id:113,n:"吉利蛋",t:["普通"],s:{hp:250,at:5,de:5,sp:50}},
    {id:114,n:"蔓藤怪",t:["草"],s:{hp:65,at:55,de:115,sp:60}},
    {id:115,n:"袋兽",t:["普通"],s:{hp:105,at:95,de:80,sp:90}},
    {id:116,n:"墨海马",t:["水"],s:{hp:30,at:40,de:70,sp:60},e:32},{id:117,n:"海刺龙",t:["水"],s:{hp:55,at:65,de:95,sp:85}},
    {id:118,n:"角金鱼",t:["水"],s:{hp:45,at:67,de:60,sp:63},e:33},{id:119,n:"金鱼王",t:["水"],s:{hp:80,at:92,de:65,sp:68}},
    {id:120,n:"海星星",t:["水"],s:{hp:30,at:45,de:55,sp:85},e:0},{id:121,n:"宝石海星",t:["水","超能"],s:{hp:60,at:75,de:85,sp:115}},
    {id:122,n:"魔墙人偶",t:["超能","仙"],s:{hp:40,at:45,de:65,sp:90}},
    {id:123,n:"飞天螳螂",t:["虫","飞行"],s:{hp:70,at:110,de:80,sp:105}},
    {id:124,n:"迷唇姐",t:["冰","超能"],s:{hp:65,at:50,de:35,sp:95}},
    {id:125,n:"电击兽",t:["电"],s:{hp:65,at:83,de:57,sp:105}},
    {id:126,n:"鸭嘴火兽",t:["火"],s:{hp:65,at:95,de:57,sp:93}},
    {id:127,n:"凯罗斯",t:["虫"],s:{hp:65,at:125,de:100,sp:85}},
    {id:128,n:"肯泰罗",t:["普通"],s:{hp:75,at:100,de:95,sp:110}},
    {id:129,n:"鲤鱼王",t:["水"],s:{hp:20,at:10,de:55,sp:80},e:20},{id:130,n:"暴鲤龙",t:["水","飞行"],s:{hp:95,at:125,de:79,sp:81}},
    {id:131,n:"拉普拉斯",t:["水","冰"],s:{hp:130,at:85,de:80,sp:60}},
    {id:132,n:"百变怪",t:["普通"],s:{hp:48,at:48,de:48,sp:48}},
    {id:133,n:"伊布",t:["普通"],s:{hp:55,at:55,de:50,sp:55},e:0},{id:134,n:"水伊布",t:["水"],s:{hp:130,at:65,de:60,sp:65}},{id:135,n:"雷伊布",t:["电"],s:{hp:65,at:65,de:60,sp:130}},{id:136,n:"火伊布",t:["火"],s:{hp:65,at:130,de:60,sp:65}},
    {id:137,n:"多边兽",t:["普通"],s:{hp:65,at:60,de:70,sp:40}},
    {id:138,n:"菊石兽",t:["岩石","水"],s:{hp:35,at:40,de:100,sp:35},e:40},{id:139,n:"多刺菊石兽",t:["岩石","水"],s:{hp:70,at:60,de:125,sp:55}},
    {id:140,n:"化石盔",t:["岩石","水"],s:{hp:30,at:80,de:90,sp:55},e:40},{id:141,n:"镰刀盔",t:["岩石","水"],s:{hp:60,at:115,de:105,sp:80}},
    {id:142,n:"化石翼龙",t:["岩石","飞行"],s:{hp:80,at:105,de:65,sp:130}},
    {id:143,n:"卡比兽",t:["普通"],s:{hp:160,at:110,de:65,sp:30}},
    {id:144,n:"急冻鸟",t:["冰","飞行"],s:{hp:90,at:85,de:100,sp:85}},
    {id:145,n:"闪电鸟",t:["电","飞行"],s:{hp:90,at:90,de:85,sp:100}},
    {id:146,n:"火焰鸟",t:["火","飞行"],s:{hp:90,at:100,de:90,sp:90}},
    {id:147,n:"迷你龙",t:["龙"],s:{hp:41,at:64,de:45,sp:50},e:30},{id:148,n:"哈克龙",t:["龙"],s:{hp:61,at:84,de:65,sp:70},e:55},{id:149,n:"快龙",t:["龙","飞行"],s:{hp:91,at:134,de:95,sp:80}},
    {id:150,n:"超梦",t:["超能"],s:{hp:106,at:110,de:90,sp:130}},
    {id:151,n:"梦幻",t:["超能"],s:{hp:100,at:100,de:100,sp:100}},
  ];

  // ===== 动态技能池 (MOVE_POOL) =====
  // 精灵可学习的技能数据库（精灵ID → 学习列表）
  const MOVE_POOL = {
    // 妙蛙种子系
    1: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:7,name:'寄生种子',power:0,type:'debuff',skillTypeZh:'草',emoji:'🌱'},{lv:13,name:'藤鞭',power:15,type:'grass',skillTypeZh:'草',emoji:'🌿'}],
    2: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:7,name:'寄生种子',power:0,type:'debuff',skillTypeZh:'草',emoji:'🌱'},{lv:13,name:'藤鞭',power:15,type:'grass',skillTypeZh:'草',emoji:'🌿'},{lv:22,name:'毒粉',power:0,type:'debuff_atk',skillTypeZh:'毒',emoji:'☠️'},{lv:30,name:'飞叶快刀',power:22,type:'grass',skillTypeZh:'草',emoji:'🍃'}],
    3: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:13,name:'藤鞭',power:15,type:'grass',skillTypeZh:'草',emoji:'🌿'},{lv:22,name:'毒粉',power:0,type:'debuff_atk',skillTypeZh:'毒',emoji:'☠️'},{lv:32,name:'飞叶快刀',power:22,type:'grass',skillTypeZh:'草',emoji:'🍃'},{lv:46,name:'日光束',power:35,type:'grass',skillTypeZh:'草',emoji:'☀️'}],
    // 小火龙系
    4: [{lv:1,name:'抓',power:10,type:'normal',skillTypeZh:'普通',emoji:'🖐'},{lv:9,name:'火花',power:12,type:'fire',skillTypeZh:'火',emoji:'🔥'},{lv:15,name:'烟幕',power:0,type:'debuff',skillTypeZh:'普通',emoji:'💨'}],
    5: [{lv:1,name:'抓',power:10,type:'normal',skillTypeZh:'普通',emoji:'🖐'},{lv:9,name:'火花',power:12,type:'fire',skillTypeZh:'火',emoji:'🔥'},{lv:15,name:'烟幕',power:0,type:'debuff',skillTypeZh:'普通',emoji:'💨'},{lv:24,name:'劈斩',power:18,type:'normal',skillTypeZh:'普通',emoji:'⚔️'},{lv:36,name:'火焰拳',power:25,type:'fire',skillTypeZh:'火',emoji:'👊🔥'}],
    6: [{lv:1,name:'抓',power:10,type:'normal',skillTypeZh:'普通',emoji:'🖐'},{lv:9,name:'火花',power:12,type:'fire',skillTypeZh:'火',emoji:'🔥'},{lv:24,name:'劈斩',power:18,type:'normal',skillTypeZh:'普通',emoji:'⚔️'},{lv:36,name:'喷射火焰',power:30,type:'fire',skillTypeZh:'火',emoji:'🔥💨'},{lv:46,name:'大字爆炎',power:40,type:'fire',skillTypeZh:'火',emoji:'🔥🔥'}],
    // 杰尼龟系
    7: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:8,name:'水枪',power:12,type:'water',skillTypeZh:'水',emoji:'💧'},{lv:15,name:'缩入壳中',power:0,type:'debuff',skillTypeZh:'普通',emoji:'🛡'}],
    8: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:8,name:'水枪',power:12,type:'water',skillTypeZh:'水',emoji:'💧'},{lv:15,name:'缩入壳中',power:0,type:'debuff',skillTypeZh:'普通',emoji:'🛡'},{lv:24,name:'水之波动',power:18,type:'water',skillTypeZh:'水',emoji:'🌊'},{lv:36,name:'水炮',power:30,type:'water',skillTypeZh:'水',emoji:'💦'}],
    9: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:8,name:'水枪',power:12,type:'water',skillTypeZh:'水',emoji:'💧'},{lv:24,name:'水之波动',power:18,type:'water',skillTypeZh:'水',emoji:'🌊'},{lv:36,name:'水炮',power:30,type:'water',skillTypeZh:'水',emoji:'💦'},{lv:46,name:'破坏光线',power:45,type:'normal',skillTypeZh:'普通',emoji:'⚡'}],
    // 皮卡丘
    25: [{lv:1,name:'电击',power:12,type:'electric',skillTypeZh:'电',emoji:'⚡'},{lv:9,name:'电磁波',power:0,type:'debuff',skillTypeZh:'电',emoji:'〰️'},{lv:16,name:'电光一闪',power:15,type:'normal',skillTypeZh:'普通',emoji:'✨'},{lv:26,name:'十万伏特',power:28,type:'electric',skillTypeZh:'电',emoji:'⚡⚡'},{lv:33,name:'打雷',power:35,type:'electric',skillTypeZh:'电',emoji:'🌩'}],
    // 波波
    16: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:5,name:'吹飞',power:0,type:'debuff',skillTypeZh:'飞行',emoji:'💨'},{lv:12,name:'电光一闪',power:15,type:'normal',skillTypeZh:'普通',emoji:'✨'},{lv:21,name:'翅膀攻击',power:18,type:'flying',skillTypeZh:'飞行',emoji:'🕊'}],
    // 小拉达
    19: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:7,name:'尾巴摇摇',power:0,type:'debuff',skillTypeZh:'普通',emoji:'🌀'},{lv:14,name:'必杀门牙',power:20,type:'normal',skillTypeZh:'普通',emoji:'🦷'},{lv:23,name:'超级门牙',power:30,type:'normal',skillTypeZh:'普通',emoji:'🦷✨'}],
    // 超音蝠
    41: [{lv:1,name:'吸血',power:8,type:'bug',skillTypeZh:'虫',emoji:'🦇'},{lv:10,name:'超音波',power:0,type:'debuff',skillTypeZh:'普通',emoji:'🔊'},{lv:15,name:'咬咬',power:15,type:'normal',skillTypeZh:'普通',emoji:'😬'},{lv:21,name:'翅膀攻击',power:18,type:'flying',skillTypeZh:'飞行',emoji:'🕊'}],
    // 小拳石
    74: [{lv:1,name:'撞击',power:10,type:'normal',skillTypeZh:'普通',emoji:'💥'},{lv:11,name:'落石',power:15,type:'rock',skillTypeZh:'岩石',emoji:'🪨'},{lv:16,name:'自爆',power:40,type:'normal',skillTypeZh:'普通',emoji:'💣'},{lv:21,name:'岩石崩',power:22,type:'rock',skillTypeZh:'岩石',emoji:'🏔️'}],
    // 鬼斯
    92: [{lv:1,name:'舔舔',power:8,type:'ghost',skillTypeZh:'鬼',emoji:'👅'},{lv:8,name:'催眠术',power:0,type:'debuff',skillTypeZh:'超能',emoji:'💤'},{lv:13,name:'诅咒',power:0,type:'debuff_atk',skillTypeZh:'鬼',emoji:'👻'},{lv:21,name:'影子球',power:22,type:'ghost',skillTypeZh:'鬼',emoji:'🌑'}],
    // 凯西
    63: [{lv:1,name:'瞬间移动',power:0,type:'debuff',skillTypeZh:'超能',emoji:'✨'},{lv:16,name:'念力',power:15,type:'psychic',skillTypeZh:'超能',emoji:'🔮'},{lv:21,name:'幻象光线',power:20,type:'psychic',skillTypeZh:'超能',emoji:'🌈'}],
    // 地鼠
    50: [{lv:1,name:'抓',power:10,type:'normal',skillTypeZh:'普通',emoji:'🖐'},{lv:15,name:'挖洞',power:18,type:'ground',skillTypeZh:'地面',emoji:'⛏'},{lv:19,name:'泥巴炸弹',power:15,type:'ground',skillTypeZh:'地面',emoji:'💩'},{lv:24,name:'地震',power:30,type:'ground',skillTypeZh:'地面',emoji:'🌍'}],
  };

  // 获取精灵在指定等级应该会的所有技能
  function getLearnableMoves(pokemonId, level) {
    const pool = MOVE_POOL[pokemonId];
    if (!pool) return [];
    return pool.filter(m => m.lv <= level);
  }

  // 检查精灵是否有新技能可学
  function checkNewMoves(pokemonId, oldLevel, newLevel) {
    const pool = MOVE_POOL[pokemonId];
    if (!pool) return [];
    return pool.filter(m => m.lv > oldLevel && m.lv <= newLevel);
  }

  // PC 电脑存储系统
  const pcStorage = []; // 存放超过6只的精灵
  const MAX_PARTY_SIZE = 6;

  // ===== 属性克制矩阵 (15种属性) =====
  // 行=攻击方属性, 列=防御方属性, 值: 2=效果拔群, 0.5=效果不好, 0=无效, 1=普通
  const TYPE_LIST = ['普通','火','水','草','电','冰','格斗','毒','地面','飞行','超能','虫','岩石','鬼','龙','钢','仙'];
  const TYPE_CHART = {
    '普通':   {岩石:0.5, 鬼:0, 钢:0.5},
    '火':     {火:0.5, 水:0.5, 草:2, 冰:2, 虫:2, 岩石:0.5, 龙:0.5, 钢:2},
    '水':     {火:2, 水:0.5, 草:0.5, 地面:2, 岩石:2, 龙:0.5},
    '草':     {火:0.5, 水:2, 草:0.5, 毒:0.5, 地面:2, 飞行:0.5, 虫:0.5, 岩石:2, 龙:0.5, 钢:0.5},
    '电':     {水:2, 草:0.5, 电:0.5, 地面:0, 飞行:2, 龙:0.5},
    '冰':     {火:0.5, 水:0.5, 草:2, 冰:0.5, 地面:2, 飞行:2, 龙:2, 钢:0.5},
    '格斗':   {普通:2, 冰:2, 毒:0.5, 飞行:0.5, 超能:0.5, 虫:0.5, 岩石:2, 鬼:0, 钢:2, 仙:0.5},
    '毒':     {草:2, 毒:0.5, 地面:0.5, 岩石:0.5, 鬼:0.5, 钢:0, 仙:2},
    '地面':   {火:2, 草:0.5, 电:2, 毒:2, 飞行:0, 虫:0.5, 岩石:2, 钢:2},
    '飞行':   {草:2, 电:0.5, 格斗:2, 虫:2, 岩石:0.5, 钢:0.5},
    '超能':   {格斗:2, 毒:2, 超能:0.5, 钢:0.5},
    '虫':     {火:0.5, 草:2, 格斗:0.5, 毒:0.5, 飞行:0.5, 超能:2, 鬼:0.5, 钢:0.5, 仙:0.5},
    '岩石':   {火:2, 冰:2, 格斗:0.5, 地面:0.5, 飞行:2, 虫:2, 钢:0.5},
    '鬼':     {普通:0, 超能:2, 鬼:2},
    '龙':     {龙:2, 钢:0.5, 仙:0},
    '钢':     {火:0.5, 水:0.5, 电:0.5, 冰:2, 岩石:2, 钢:0.5, 仙:2},
    '仙':     {火:0.5, 格斗:2, 毒:0.5, 龙:2, 钢:0.5},
  };

  // 计算属性克制倍率（攻击属性 vs 防御方属性数组）
  function getTypeEffectiveness(atkType, defTypes) {
    let multiplier = 1;
    const chart = TYPE_CHART[atkType];
    if (!chart) return 1;
    for (const dt of defTypes) {
      if (chart[dt] !== undefined) multiplier *= chart[dt];
    }
    return multiplier;
  }

  // 属性中文→颜色映射
  const TYPE_COLORS = {
    '普通':'#A8A878','火':'#F08030','水':'#6890F0','草':'#78C850','电':'#F8D030',
    '冰':'#98D8D8','格斗':'#C03028','毒':'#A040A0','地面':'#E0C068','飞行':'#A890F0',
    '超能':'#F85888','虫':'#A8B820','岩石':'#B8A038','鬼':'#705898','龙':'#7038F8',
    '钢':'#B8B8D0','仙':'#EE99AC',
  };
  // 属性 emoji
  const TYPE_EMOJI = {
    '普通':'⚪','火':'🔥','水':'💧','草':'🌿','电':'⚡','冰':'❄️','格斗':'🥊','毒':'☠️',
    '地面':'🏔️','飞行':'🕊️','超能':'🔮','虫':'🐛','岩石':'🪨','鬼':'👻','龙':'🐉','钢':'⚙️','仙':'✨',
  };

  // ===== 区域分布 Spawn Table =====
  // 每个地图对应的可遇到精灵 ID 列表（基于区域生态）
  const SPAWN_TABLES = {
    0: [],  // 城镇无遇敌
    1: [1,4,7,16,19,10,13,43,69,25,39,21,23,29,32],  // 常磐森林: 御三家、波波、小拉达、绿毛虫、独角虫、走路草等
    2: [41,74,50,95,92,35,63,27,88,104,81,46,96,109], // 月见山洞: 超音蝠、小拳石、地鼠、大岩蛇、鬼斯等
  };

  // 根据 POKEDEX id 查找精灵数据
  function getMonsterById(id) {
    return POKEDEX.find(p => p.id === id);
  }

  // 将 POKEDEX 条目转换为战斗用格式（兼容现有代码）
  function pokedexToBattleMonster(entry) {
    return {
      id: entry.id,
      name: entry.n,
      emoji: TYPE_EMOJI[entry.t[0]] || '❓',
      type: entry.t[0],
      types: entry.t,
      color: TYPE_COLORS[entry.t[0]] || '#888',
      colorLight: lightenColor(TYPE_COLORS[entry.t[0]] || '#888', 40),
      hp: entry.s.hp,
      atk: entry.s.at,
      def: entry.s.de,
      spd: entry.s.sp,
      catchRate: entry.s.hp > 100 ? 0.15 : entry.s.hp > 70 ? 0.3 : entry.s.hp > 50 ? 0.45 : 0.55,
      evolveLevel: entry.e || 0,
    };
  }

  // 颜色变亮工具
  function lightenColor(hex, amount) {
    const num = parseInt(hex.slice(1), 16);
    const r = Math.min(255, (num >> 16) + amount);
    const g = Math.min(255, ((num >> 8) & 0x00FF) + amount);
    const b = Math.min(255, (num & 0x0000FF) + amount);
    return `#${(r << 16 | g << 8 | b).toString(16).padStart(6, '0')}`;
  }

  // 生成通用像素精灵绘制函数（基于属性颜色）
  function makeGenericSprite(monster) {
    return function(ctx, x, y, w, h) {
      const c = monster.color;
      const cl = monster.colorLight;
      // 身体
      ctx.fillStyle = c;
      ctx.fillRect(x + 6, y + 12, w - 12, h - 16);
      // 头
      ctx.fillStyle = cl;
      ctx.fillRect(x + 8, y + 2, w - 16, 16);
      // 眼睛
      ctx.fillStyle = '#fff';
      ctx.fillRect(x + 14, y + 6, 6, 5);
      ctx.fillRect(x + w - 20, y + 6, 6, 5);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(x + 16, y + 7, 3, 3);
      ctx.fillRect(x + w - 18, y + 7, 3, 3);
      // 属性装饰（第二属性颜色条纹）
      if (monster.types && monster.types.length > 1) {
        ctx.fillStyle = TYPE_COLORS[monster.types[1]] || '#888';
        ctx.fillRect(x + 8, y + h - 10, w - 16, 4);
      }
      // 嘴
      ctx.fillStyle = '#333';
      ctx.fillRect(x + 18, y + 14, w - 36, 2);
    };
  }

  // 为兼容性保持 WILD_MONSTERS 引用（指向全部可遇到的精灵）
  const WILD_MONSTERS = POKEDEX.map(entry => {
    const m = pokedexToBattleMonster(entry);
    m.drawSprite = makeGenericSprite(m);
    return m;
  });

  // ===== 图鉴 & 已捕获精灵 =====
  const pokedex = {};  // { monsterId: { seen: true, caught: false } }
  const myPokemon = []; // 已捕获的精灵列表 [{ id, name, emoji, type, color, level, hp, maxHP, atk, spd }]

  // 背包 — 精灵球数量
  const bag = { pokeball: 5 };

  // 触发遇敌（使用区域分布表）
  function triggerWildEncounter() {
    // 根据当前地图的 SPAWN_TABLE 选择精灵
    const spawnList = SPAWN_TABLES[currentMapId] || [];
    let monster;
    if (spawnList.length > 0) {
      const randId = spawnList[Math.floor(Math.random() * spawnList.length)];
      monster = WILD_MONSTERS.find(m => m.id === randId) || WILD_MONSTERS[Math.floor(Math.random() * WILD_MONSTERS.length)];
    } else {
      monster = WILD_MONSTERS[Math.floor(Math.random() * WILD_MONSTERS.length)];
    }

    pkState.battleMonsterName = monster.name;
    pkState._battleMonster = monster;
    pkState.gameMode = MODE_TRANSITION;
    pkState.transitionTimer = 0;
    pkState.battleFlashTimer = 0;
    pkState.pendingDir = null;
    pkState._lastTypeEffectivenessMsg = ''; // 清空克制提示

    // 记录图鉴：标记为已见
    if (!pokedex[monster.id]) {
      pokedex[monster.id] = { seen: true, caught: false };
    } else {
      pokedex[monster.id].seen = true;
    }

    // 初始化野怪战斗数值（基于精灵自身属性 + 等级缩放）
    const lvl = Math.max(2, pkState.playerLevel + Math.floor(Math.random() * 3) - 1);
    pkState.enemyLevel = lvl;
    pkState.enemyMaxHP = monster.hp + lvl * 3;
    pkState.enemyHP = pkState.enemyMaxHP;
    pkState.enemyDisplayHP = pkState.enemyMaxHP;
    pkState.enemyAtk = (monster.atk || 10) + lvl * 2;
    pkState.enemySpeed = (monster.spd || 7) + lvl;
    pkState.enemyDef = (monster.def || 10) + lvl;
    pkState._enemyAtkDebuff = 0;

    // 重置战斗状态
    pkState.menuCursor = 0;
    pkState.skillCursor = 0;
    pkState.bagCursor = 0;
    pkState.battleMsg = '';
    pkState.battleMsgTimer = 0;
    pkState.battleAnimTimer = 0;
    pkState.battleShakeEnemy = 0;
    pkState.battleShakePlayer = 0;
    pkState.playerDisplayHP = pkState.playerHP;
    pkState._playerSpdDebuff = 0;

    // 1996风格分段出场文本
    enqueueBattleText([
      { text: `野生的 ${monster.name}` },
      { text: `出现了！` },
    ], () => {
      pkState.battlePhase = 'MENU';
      pkState.menuCursor = 0;
      pkState.battleMsg = '';
    });

    sfxBattleStart();
  }

  // ===== 更新逻辑 =====
  function update() {
    pkState.frame++;

    // === 传送过渡模式 ===
    if (pkState.gameMode === 'PORTAL_TRANSITION') {
      pkState.portalFadeTimer++;
      const half = pkState.portalFadeDuration / 2;
      // 淡出到一半时执行传送
      if (pkState.portalFadeTimer === Math.floor(half)) {
        executePortal();
      }
      // 动画完成
      if (pkState.portalFadeTimer >= pkState.portalFadeDuration) {
        pkState.gameMode = MODE_EXPLORING;
        pkState.portalTransition = false;
      }
      return;
    }

    // === 切场过渡模式 ===
    if (pkState.gameMode === MODE_TRANSITION) {
      pkState.transitionTimer++;
      if (pkState.transitionTimer >= pkState.transitionDuration) {
        pkState.gameMode = MODE_BATTLE;
        pkState.battleFlashTimer = 0;
      }
      return; // 过渡期间冻结一切
    }

    // === 战斗模式 ===
    if (pkState.gameMode === MODE_BATTLE) {
      pkState.battleFlashTimer++;

      // 血条平滑动画
      if (pkState.enemyDisplayHP > pkState.enemyHP) {
        pkState.enemyDisplayHP = Math.max(pkState.enemyHP, pkState.enemyDisplayHP - 0.5);
      }
      if (pkState.playerDisplayHP > pkState.playerHP) {
        pkState.playerDisplayHP = Math.max(pkState.playerHP, pkState.playerDisplayHP - 0.5);
      }

      // 战斗消息计时
      if (pkState.battleMsgTimer < 999) pkState.battleMsgTimer++;

      // 攻击动画计时（1996风格：先显示技能名，延迟后扣血）
      if (pkState.battlePhase === 'PLAYER_ATTACK') {
        pkState.battleAnimTimer++;
        // 延迟扣血：第15帧时实际扣血并显示伤害数字
        if (pkState.battleAnimTimer === 15 && pkState._pendingDamage !== undefined) {
          const damage = pkState._pendingDamage;
          pkState.enemyHP = Math.max(0, pkState.enemyHP - damage);
          pkState.battleDamageText = damage > 0 ? `-${damage}` : '';
          // 追加效果消息
          if (pkState._pendingEffectMsg) {
            pkState.battleMsg += `\n造成 ${damage} 点伤害！`;
          } else {
            pkState.battleMsg += `\n造成 ${damage} 点伤害！`;
          }
          pkState._pendingDamage = undefined;
        }
        // 第22帧时显示克制效果提示
        if (pkState.battleAnimTimer === 22 && pkState._pendingEffectMsg) {
          pkState.battleMsg += `\n${pkState._pendingEffectMsg}`;
          pkState._pendingEffectMsg = null;
        }
        // 非伤害技能也在第15帧显示效果
        if (pkState.battleAnimTimer === 15 && pkState._pendingDamage === undefined && pkState._pendingEffectMsg) {
          pkState.battleMsg += `\n${pkState._pendingEffectMsg}`;
          pkState._pendingEffectMsg = null;
        }
        // 震动效果（前 15 帧）
        if (pkState.battleAnimTimer < 15) {
          pkState.battleShakeEnemy = (Math.random() - 0.5) * 8;
        } else {
          pkState.battleShakeEnemy *= 0.8;
        }
        // 动画结束 → 检查是否击杀，否则转敌人回合
        if (pkState.battleAnimTimer >= pkState.battleAnimDuration) {
          pkState.battleShakeEnemy = 0;
          if (pkState.enemyHP <= 0) {
            pkState.battlePhase = 'RESULT';
          } else {
            setTimeout(() => {
              if (pkState.gameMode === MODE_BATTLE && pkState.battlePhase === 'PLAYER_ATTACK_DONE') {
                executeEnemyAttack();
              }
            }, 400);
            pkState.battlePhase = 'PLAYER_ATTACK_DONE';
          }
        }
      }

      // 等待敌人攻击的过渡
      if (pkState.battlePhase === 'PLAYER_ATTACK_DONE') {
        // 只是等待 setTimeout 触发
      }

      // 敌人攻击动画
      if (pkState.battlePhase === 'ENEMY_ATTACK') {
        pkState.battleAnimTimer++;
        if (pkState.battleAnimTimer < 15) {
          pkState.battleShakePlayer = (Math.random() - 0.5) * 8;
        } else {
          pkState.battleShakePlayer *= 0.8;
        }
        if (pkState.battleAnimTimer >= pkState.battleAnimDuration) {
          pkState.battleShakePlayer = 0;
          pkState.battlePhase = 'RESULT';
        }
      }

      // === 捕捉动画 ===
      if (pkState.battlePhase === 'CATCHING') {
        pkState.catchAnimTimer++;

        // 阶段0: 投掷球（0-30帧）
        if (pkState.catchAnimPhase === 0) {
          if (pkState.catchAnimTimer >= 30) {
            pkState.catchAnimPhase = 1;
            pkState.catchAnimTimer = 0;
          }
        }
        // 阶段1-3: 抖动三次（每次25帧）
        else if (pkState.catchAnimPhase >= 1 && pkState.catchAnimPhase <= 3) {
          if (pkState.catchAnimTimer >= 25) {
            pkState.catchAnimPhase++;
            pkState.catchAnimTimer = 0;
            if (pkState.catchAnimPhase <= 3) sfxThump(); // 抖动音效
          }
        }
        // 阶段4: 结果
        else if (pkState.catchAnimPhase >= 4) {
          if (pkState.catchAnimTimer >= 20) {
            if (pkState.catchSuccess) {
              pkState.battlePhase = 'CATCH_SUCCESS';
              pkState.battleMsg = `成功捕捉到了 ${pkState.battleMonsterName}！`;
              pkState.battleMsgTimer = 0;
              sfxCatchSuccess();
              sendMotorFeedback(); // 硬件震动反馈
            } else {
              pkState.battlePhase = 'CATCH_FAIL';
              pkState.battleMsg = `啊！${pkState.battleMonsterName} 挣脱了！`;
              pkState.battleMsgTimer = 0;
              sfxThump();
            }
          }
        }
      }

      // === 升级动画 ===
      if (pkState.battlePhase === 'LEVEL_UP') {
        pkState.levelUpAnimTimer++;
      }

      // 逃跑失败后的敌人攻击
      if (pkState._pendingEnemyAttack && pkState.battlePhase === 'RESULT' && pkState.battleMsgTimer > 30) {
        pkState._pendingEnemyAttack = false;
        executeEnemyAttack();
      }

      // 屏幕闪烁特效衰减
      if (pkState.screenFlashTimer > 0) {
        pkState.screenFlashTimer--;
      }

      // === 1996 风格文本流处理 ===
      if (pkState.battlePhase === 'TEXT_FLOW') {
        pkState.battleMsgTimer++;
        // 打字机效果
        if (pkState.battleTextCharIndex < pkState.battleTextCurrent.length) {
          pkState.battleTextCharIndex += 1.5; // 每帧1.5个字符
        } else if (!pkState.battleTextWaiting) {
          pkState.battleTextWaiting = true;
        }
      }

      // === 技能学习对话 ===
      if (pkState.learnSkillPhase === 'ASK_LEARN' || pkState.learnSkillPhase === 'SELECT_REPLACE') {
        // 由按键处理驱动，无需自动更新
      }

      return;
    }

    // === 全局菜单动画计时 ===
    if (pkState.globalMenuOpen) {
      pkState.globalMenuAnimTimer++;
      // 保存动画
      if (pkState.globalMenuSaveResult === 'SAVING') {
        pkState.globalMenuSaveTimer++;
      }
      return; // 菜单打开时冻结一切（背景暂停）
    }

    // === 低血量警报 ===
    if (pkState.gameMode === MODE_EXPLORING) {
      const hpRatio = pkState.playerHP / pkState.playerMaxHP;
      if (hpRatio > 0 && hpRatio < 0.2) {
        if (!pkState.lowHPWarningActive) {
          pkState.lowHPWarningActive = true;
          pkState.lowHPWarningTimer = 0;
        }
        pkState.lowHPWarningTimer++;
        // 每 120 帧（~2 秒）发送一次低血量震动
        if (pkState.lowHPWarningTimer % 120 === 0) {
          sendMotorLowHP();
        }
      } else {
        pkState.lowHPWarningActive = false;
      }
    }

    // === 进化动画 ===
    if (pkState.evolveTriggered) {
      pkState.evolveAnimTimer++;
      // 持续发送马达慢转（模拟能量积聚）
      if (pkState.evolveAnimTimer % 30 === 0 && pkState.evolveAnimTimer < 100) {
        sendMotorFeedback();
      }
      if (pkState.evolveAnimTimer >= 150) {
        pkState.evolveTriggered = false;
        pkState._evolvingPokemon = null;
      }
    }

    // === 探索模式 ===
    // 移动过渡
    if (pkState.moving) {
      pkState.moveProgress += MOVE_SPEED;
      if (pkState.moveProgress >= TILE) {
        // 移动完成
        pkState.px = pkState.targetX;
        pkState.py = pkState.targetY;
        pkState.moving = false;
        pkState.moveProgress = 0;
        pkState.steps++;
        const map = getCurrentMap();

        // 检查传送点
        const portal = PORTALS.find(p => p.fromMap === currentMapId && p.fx === pkState.px && p.fy === pkState.py);
        if (portal) {
          startPortalTransition(portal);
          return;
        }

        // 踩到草丛
        if (map[pkState.py][pkState.px] === T_GRASS) {
          pkState.grassAnim = { x: pkState.px, y: pkState.py, timer: 20 };
          sfxGrass();

          // 随机遇敌判定（使用地图遇敌率）
          const encounterRate = MAP_ENCOUNTER_RATES[currentMapId] || 0;
          if (encounterRate > 0 && Math.random() < encounterRate) {
            triggerWildEncounter();
            return; // 直接进入切场，不执行后续
          }
        }

        // 执行缓存的方向
        if (pkState.pendingDir !== null) {
          const pd = pkState.pendingDir;
          pkState.pendingDir = null;
          tryMove(pd);
        }
      }
    }

    // 草丛动画衰减
    if (pkState.grassAnim) {
      pkState.grassAnim.timer--;
      if (pkState.grassAnim.timer <= 0) pkState.grassAnim = null;
    }

    // 对话计时（用于打字机效果）
    if (pkState.dialogActive) {
      pkState.dialogTimer++;
    }

    // 相机平滑跟随
    const targetCamX = pkState.px * TILE - (VIEW_W * TILE) / 2 + TILE / 2;
    const targetCamY = pkState.py * TILE - (VIEW_H * TILE) / 2 + TILE / 2;
    // 移动中考虑过渡偏移
    let playerPixelX = pkState.px * TILE;
    let playerPixelY = pkState.py * TILE;
    if (pkState.moving) {
      const dx = DIR_DX[pkState.dir] * pkState.moveProgress;
      const dy = DIR_DY[pkState.dir] * pkState.moveProgress;
      playerPixelX = pkState.px * TILE + dx;
      playerPixelY = pkState.py * TILE + dy;
    }
    const camTargetX = playerPixelX - (VIEW_W * TILE) / 2 + TILE / 2;
    const camTargetY = playerPixelY - (VIEW_H * TILE) / 2 + TILE / 2;

    // 限制相机范围
    const maxCamX = MAP_W * TILE - W;
    const maxCamY = MAP_H * TILE - H;
    const clampedCamX = Math.max(0, Math.min(maxCamX, camTargetX));
    const clampedCamY = Math.max(0, Math.min(maxCamY, camTargetY));

    // 平滑插值
    pkState.camX += (clampedCamX - pkState.camX) * 0.15;
    pkState.camY += (clampedCamY - pkState.camY) * 0.15;
  }

  // ===== 绘制 =====
  function draw() {
    ctx.clearRect(0, 0, W, H);

    // === 传送过渡动画 ===
    if (pkState.gameMode === 'PORTAL_TRANSITION') {
      const half = pkState.portalFadeDuration / 2;
      const t = pkState.portalFadeTimer;
      let alpha;
      if (t < half) {
        alpha = t / half; // 淡出 0→1
      } else {
        alpha = 1 - (t - half) / half; // 淡入 1→0
      }
      // 先画当前场景
      drawExploringScene();
      // 覆盖黑色遮罩
      ctx.fillStyle = `rgba(0, 0, 0, ${Math.min(1, alpha)})`;
      ctx.fillRect(0, 0, W, H);
      // 在中间显示目的地名称
      if (t >= half * 0.5 && t <= half * 1.5) {
        ctx.globalAlpha = Math.min(1, 1 - Math.abs(t - half) / half);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 22px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(MAP_NAMES[currentMapId] || '???', W / 2, H / 2);
        ctx.globalAlpha = 1;
      }
      return;
    }

    // === 切场动画 ===
    if (pkState.gameMode === MODE_TRANSITION) {
      drawTransition(ctx, W, H);
      return;
    }

    // === 战斗界面 ===
    if (pkState.gameMode === MODE_BATTLE) {
      drawBattle(ctx, W, H);
      return;
    }

    // === 探索场景 ===
    drawExploringScene();
  }

  // 抽取探索场景绘制为独立函数（传送过渡可复用）
  function drawExploringScene() {
    const map = getCurrentMap();
    const theme = MAP_THEMES[currentMapId] || MAP_THEMES[0];
    const offX = -Math.round(pkState.camX);
    const offY = -Math.round(pkState.camY);

    // 计算可见范围
    const startCol = Math.max(0, Math.floor(pkState.camX / TILE));
    const startRow = Math.max(0, Math.floor(pkState.camY / TILE));
    const endCol = Math.min(MAP_W, startCol + VIEW_W + 2);
    const endRow = Math.min(MAP_H, startRow + VIEW_H + 2);

    // --- 绘制地面层 ---
    for (let y = startRow; y < endRow; y++) {
      for (let x = startCol; x < endCol; x++) {
        const sx = x * TILE + offX;
        const sy = y * TILE + offY;
        const tile = map[y][x];

        // 地面底色（棋盘格增加层次，使用地图主题色）
        if ((x + y) % 2 === 0) {
          ctx.fillStyle = theme.ground1;
        } else {
          ctx.fillStyle = theme.ground2;
        }
        ctx.fillRect(sx, sy, TILE, TILE);

        // 根据 tile 类型绘制
        if (tile === T_WALL) {
          // 墙壁 - 使用地图主题色
          ctx.fillStyle = theme.wallColor;
          ctx.fillRect(sx, sy, TILE, TILE);
          ctx.strokeStyle = theme.wallDark;
          ctx.lineWidth = 1;
          ctx.strokeRect(sx + 0.5, sy + 0.5, TILE - 1, TILE - 1);
          ctx.fillStyle = theme.wallLight;
          ctx.fillRect(sx + 2, sy + 2, TILE / 2 - 3, TILE / 2 - 3);
          ctx.fillRect(sx + TILE / 2 + 1, sy + TILE / 2 + 1, TILE / 2 - 3, TILE / 2 - 3);
          ctx.fillStyle = theme.wallDark;
          ctx.fillRect(sx + TILE / 2 + 1, sy + 2, TILE / 2 - 3, TILE / 2 - 3);
          ctx.fillRect(sx + 2, sy + TILE / 2 + 1, TILE / 2 - 3, TILE / 2 - 3);
        } else if (tile === T_PORTAL) {
          // 传送点 — 旋转的蓝色/紫色光圈
          const pulse = Math.sin(pkState.frame * 0.08) * 0.3 + 0.7;
          ctx.fillStyle = `rgba(108, 114, 255, ${pulse * 0.4})`;
          ctx.fillRect(sx, sy, TILE, TILE);
          // 旋转光圈
          ctx.strokeStyle = `rgba(108, 114, 255, ${pulse})`;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx + TILE / 2, sy + TILE / 2, 10 + Math.sin(pkState.frame * 0.1) * 3, 0, Math.PI * 2);
          ctx.stroke();
          // 中心点
          ctx.fillStyle = '#a78bfa';
          ctx.beginPath();
          ctx.arc(sx + TILE / 2, sy + TILE / 2, 4, 0, Math.PI * 2);
          ctx.fill();
          // 传送标识
          ctx.font = '10px monospace';
          ctx.fillStyle = '#c4b5fd';
          ctx.textAlign = 'center';
          // 找到对应传送点标签
          const pLabel = PORTALS.find(p => p.fromMap === currentMapId && p.fx === x && p.fy === y);
          if (pLabel) {
            ctx.fillText('🚪', sx + TILE / 2, sy + TILE - 2);
          }
        } else if (tile === T_BOSS) {
          // BOSS 地面 — 深红色底
          ctx.fillStyle = '#3d1a1a';
          ctx.fillRect(sx, sy, TILE, TILE);
          // 边框
          ctx.strokeStyle = '#8b0000';
          ctx.lineWidth = 1;
          ctx.strokeRect(sx + 1, sy + 1, TILE - 2, TILE - 2);
        } else if (tile === T_GRASS) {
          // 草丛 - 深绿底 + 草叶
          ctx.fillStyle = '#1a6b1a';
          ctx.fillRect(sx, sy, TILE, TILE);

          // 草叶（像素风小三角/线条）
          ctx.strokeStyle = '#2aaa2a';
          ctx.lineWidth = 2;
          // 用规则的草叶代替随机
          const grassPatterns = [
            [6, 24, 6, 10], [12, 26, 14, 8], [20, 24, 22, 12],
            [26, 26, 26, 14], [8, 22, 10, 16], [18, 20, 16, 10],
          ];
          for (const gp of grassPatterns) {
            ctx.beginPath();
            ctx.moveTo(sx + gp[0], sy + gp[1]);
            ctx.lineTo(sx + gp[2], sy + gp[3]);
            ctx.stroke();
          }

          // 草丛动画（刚踩入时晃动）
          if (pkState.grassAnim && pkState.grassAnim.x === x && pkState.grassAnim.y === y) {
            const t = pkState.grassAnim.timer;
            const shake = Math.sin(t * 0.8) * 3;
            ctx.strokeStyle = '#5fff5f';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(sx + 16 + shake, sy + 28);
            ctx.lineTo(sx + 16 + shake * 1.5, sy + 6);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(sx + 10 - shake, sy + 26);
            ctx.lineTo(sx + 8 - shake, sy + 10);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(sx + 22 + shake * 0.5, sy + 28);
            ctx.lineTo(sx + 24 + shake, sy + 8);
            ctx.stroke();
          }

          // 虚线边框
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = '#2a8a2a';
          ctx.lineWidth = 1;
          ctx.strokeRect(sx + 1.5, sy + 1.5, TILE - 3, TILE - 3);
          ctx.setLineDash([]);
        } else if (tile === T_NPC) {
          // NPC 底座
          // 先画地面
          // NPC 身体绘制在上方
        }
      }
    }

    // --- 绘制 NPC ---
    for (const npc of npcs) {
      const sx = npc.x * TILE + offX;
      const sy = npc.y * TILE + offY;

      // 只绘制可见的 NPC
      if (sx + TILE < 0 || sx > W || sy + TILE < 0 || sy > H) continue;

      // NPC 呼吸动画（上下浮动）
      const breathe = Math.sin(pkState.frame * 0.06 + npc.x * 2) * 2;

      // 身体（紫色方块）
      ctx.fillStyle = '#8b5cf6';
      ctx.fillRect(sx + 4, sy + 6 + breathe, TILE - 8, TILE - 10);

      // 头部
      ctx.fillStyle = '#a78bfa';
      ctx.fillRect(sx + 6, sy + 2 + breathe, TILE - 12, 10);

      // 眼睛
      ctx.fillStyle = '#fff';
      ctx.fillRect(sx + 9, sy + 4 + breathe, 4, 4);
      ctx.fillRect(sx + 19, sy + 4 + breathe, 4, 4);
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(sx + 10, sy + 5 + breathe, 2, 2);
      ctx.fillRect(sx + 20, sy + 5 + breathe, 2, 2);

      // 感叹号提示（玩家靠近时）
      const dist = Math.abs(pkState.px - npc.x) + Math.abs(pkState.py - npc.y);
      if (dist <= 2) {
        const bounce = Math.abs(Math.sin(pkState.frame * 0.1)) * 4;
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('!', sx + TILE / 2, sy - 2 - bounce + breathe);
      }
    }

    // --- 绘制 BOSS NPC ---
    for (const boss of BOSS_NPCS) {
      if (boss.mapId !== currentMapId) continue;
      const bx = boss.x * TILE + offX;
      const by = boss.y * TILE + offY;
      if (bx + TILE * 2 < 0 || bx > W || by + TILE < 0 || by > H) continue;

      const breathe = Math.sin(pkState.frame * 0.04) * 2;
      const defeated = !!badges[boss.badgeId];

      // 身体（红色系/灰色如已击败）
      ctx.fillStyle = defeated ? '#666' : '#8b0000';
      ctx.fillRect(bx + 2, by + 4 + breathe, TILE * 2 - 4, TILE - 8);
      // 头
      ctx.fillStyle = defeated ? '#888' : '#b22222';
      ctx.fillRect(bx + 8, by - 2 + breathe, TILE * 2 - 16, 12);
      // 眼睛
      ctx.fillStyle = '#fff';
      ctx.fillRect(bx + 14, by + 2 + breathe, 6, 6);
      ctx.fillRect(bx + TILE * 2 - 20, by + 2 + breathe, 6, 6);
      ctx.fillStyle = defeated ? '#666' : '#ff0';
      ctx.fillRect(bx + 16, by + 3 + breathe, 3, 4);
      ctx.fillRect(bx + TILE * 2 - 18, by + 3 + breathe, 3, 4);
      // 标签
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = defeated ? '#888' : '#fbbf24';
      ctx.textAlign = 'center';
      ctx.fillText(defeated ? '✅ ' + boss.name : '⚔ ' + boss.name, bx + TILE, by - 8 + breathe);

      // 感叹号（未击败时）
      if (!defeated) {
        const dist = Math.abs(pkState.px - boss.x) + Math.abs(pkState.py - boss.y);
        const dist2 = Math.abs(pkState.px - boss.x2) + Math.abs(pkState.py - boss.y2);
        if (dist <= 2 || dist2 <= 2) {
          const bounce = Math.abs(Math.sin(pkState.frame * 0.12)) * 5;
          ctx.fillStyle = '#ff0';
          ctx.font = 'bold 18px monospace';
          ctx.fillText('⚔', bx + TILE, by - 16 - bounce + breathe);
        }
      }
    }

    // --- 绘制玩家 ---
    let playerDrawX = pkState.px * TILE + offX;
    let playerDrawY = pkState.py * TILE + offY;
    if (pkState.moving) {
      playerDrawX += DIR_DX[pkState.dir] * pkState.moveProgress;
      playerDrawY += DIR_DY[pkState.dir] * pkState.moveProgress;
    }

    // 玩家阴影
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(playerDrawX + TILE / 2, playerDrawY + TILE - 3, 10, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // 走路摆动
    const walkBob = pkState.moving ? Math.sin(pkState.moveProgress * 0.3) * 2 : 0;

    // 身体（方向色）
    ctx.fillStyle = DIR_COLORS[pkState.dir];
    ctx.fillRect(playerDrawX + 5, playerDrawY + 8 + walkBob, TILE - 10, TILE - 12);

    // 头部
    ctx.fillStyle = '#ffeaa7';
    ctx.fillRect(playerDrawX + 7, playerDrawY + 2 + walkBob, TILE - 14, 12);

    // 帽子
    ctx.fillStyle = DIR_COLORS[pkState.dir];
    ctx.fillRect(playerDrawX + 5, playerDrawY + 0 + walkBob, TILE - 10, 6);

    // 帽檐
    const brimDir = pkState.dir === DIR_LEFT ? -3 : pkState.dir === DIR_RIGHT ? 3 : 0;
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(playerDrawX + 4 + brimDir, playerDrawY + 4 + walkBob, TILE - 8, 3);

    // 眼睛（根据方向）
    ctx.fillStyle = '#2d3436';
    if (pkState.dir === DIR_DOWN) {
      ctx.fillRect(playerDrawX + 10, playerDrawY + 7 + walkBob, 3, 3);
      ctx.fillRect(playerDrawX + 19, playerDrawY + 7 + walkBob, 3, 3);
    } else if (pkState.dir === DIR_UP) {
      // 背面不画眼睛
    } else if (pkState.dir === DIR_LEFT) {
      ctx.fillRect(playerDrawX + 8, playerDrawY + 7 + walkBob, 3, 3);
    } else {
      ctx.fillRect(playerDrawX + 21, playerDrawY + 7 + walkBob, 3, 3);
    }

    // 在草丛中时，画草丛覆盖在脚部
    if (getCurrentMap()[pkState.py][pkState.px] === T_GRASS && !pkState.moving) {
      const gsx = pkState.px * TILE + offX;
      const gsy = pkState.py * TILE + offY;
      ctx.fillStyle = '#1a6b1a';
      ctx.fillRect(gsx, gsy + TILE - 10, TILE, 10);
      ctx.strokeStyle = '#2aaa2a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(gsx + 6, gsy + TILE);
      ctx.lineTo(gsx + 8, gsy + TILE - 10);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gsx + 16, gsy + TILE);
      ctx.lineTo(gsx + 14, gsy + TILE - 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gsx + 26, gsy + TILE);
      ctx.lineTo(gsx + 24, gsy + TILE - 10);
      ctx.stroke();
    }

    // --- HUD ---
    // 半透明底栏
    ctx.fillStyle = 'rgba(15, 17, 23, 0.75)';
    ctx.fillRect(0, 0, W, 36);

    ctx.font = 'bold 13px monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e4e6ed';
    ctx.fillText(`${MAP_NAMES[currentMapId] || '宝可梦世界'}`, 12, 22);

    ctx.font = '12px monospace';
    ctx.fillStyle = '#8b8fa3';
    ctx.fillText(`Lv.${pkState.playerLevel}`, 160, 22);
    ctx.fillText(`🔴×${bag.pokeball}`, 210, 22);
    ctx.fillText(`图鉴:${Object.values(pokedex).filter(p=>p.caught).length}/151`, 275, 22);
    // 徽章数
    const badgeCount = Object.keys(badges).length;
    if (badgeCount > 0) {
      ctx.fillText(`🏅×${badgeCount}`, 395, 22);
    }

    // 首位精灵状态栏（右上角）
    const statusX = W - 180;
    const statusY = 42;
    ctx.fillStyle = 'rgba(15, 17, 23, 0.7)';
    roundRect(ctx, statusX, statusY, 170, 32, 6);
    ctx.fill();
    // HP 条
    const hpR = pkState.playerHP / pkState.playerMaxHP;
    const barX = statusX + 48;
    const barY = statusY + 10;
    const barW = 100;
    const barH = 10;
    ctx.fillStyle = '#2d2d3d';
    roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.fill();
    let hpCol = hpR > 0.5 ? '#2ecc71' : hpR > 0.2 ? '#f1c40f' : '#e74c3c';
    if (hpR > 0) {
      ctx.fillStyle = hpCol;
      roundRect(ctx, barX, barY, barW * Math.min(1, hpR), barH, 4);
      ctx.fill();
    }
    ctx.font = '10px monospace';
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'left';
    ctx.fillText('HP', statusX + 8, statusY + 20);
    ctx.fillStyle = '#e4e6ed';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.ceil(pkState.playerHP)}/${pkState.playerMaxHP}`, statusX + 165, statusY + 20);

    // 低血量屏幕边缘红色脉冲
    if (pkState.lowHPWarningActive) {
      const pulse = Math.sin(pkState.frame * 0.15) * 0.15 + 0.1;
      ctx.fillStyle = `rgba(231, 76, 60, ${pulse})`;
      ctx.fillRect(0, 0, W, 4);
      ctx.fillRect(0, H - 4, W, 4);
      ctx.fillRect(0, 0, 4, H);
      ctx.fillRect(W - 4, 0, 4, H);
    }

    // 控制器提示
    ctx.fillStyle = '#f472b6';
    ctx.textAlign = 'right';
    ctx.font = '11px monospace';
    ctx.fillText('BTN菜单 P图鉴 M地图 C电脑', W - 12, 22);

    // 小地图
    drawMinimap(ctx, W, H, offX, offY);

    // 进化动画覆层（完整进化场景）
    if (pkState.evolveTriggered) {
      const t = pkState.evolveAnimTimer;
      const dur = 150; // 总帧数（~2.5秒）

      // 黑色背景
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      // 阶段1: 原精灵闪烁（0-60帧）
      if (t < 60) {
        const flash = Math.floor(t / 4) % 2 === 0;
        const pulseSize = 50 + Math.sin(t * 0.15) * 10;
        const cx = W / 2, cy = H / 2 - 20;

        // 闪烁的精灵方块（旧颜色/白色交替）
        if (flash) {
          ctx.fillStyle = '#fff';
        } else {
          ctx.fillStyle = TYPE_COLORS[pkState._evolvingPokemon?.types?.[0]] || '#888';
        }
        ctx.fillRect(cx - pulseSize / 2, cy - pulseSize / 2, pulseSize, pulseSize);

        // 能量粒子
        for (let i = 0; i < 8; i++) {
          const angle = (t * 0.05 + i * Math.PI / 4);
          const radius = 40 + Math.sin(t * 0.1 + i) * 15;
          const px = cx + Math.cos(angle) * radius;
          const py = cy + Math.sin(angle) * radius;
          ctx.fillStyle = `rgba(255, 255, 100, ${0.5 + Math.sin(t * 0.2 + i) * 0.3})`;
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fill();
        }

        // 文字
        ctx.font = 'bold 18px monospace';
        ctx.fillStyle = '#fbbf24';
        ctx.textAlign = 'center';
        ctx.fillText('咦...？', W / 2, H / 2 + 60);
      }
      // 阶段2: 变形发光（60-100帧）
      else if (t < 100) {
        const p2 = (t - 60) / 40;
        const brightness = Math.sin(p2 * Math.PI * 3) * 0.5 + 0.5;

        // 越来越亮的白光
        ctx.fillStyle = `rgba(255, 255, 255, ${0.3 + brightness * 0.5})`;
        ctx.fillRect(0, 0, W, H);

        // 中心大光球
        const glow = ctx.createRadialGradient(W / 2, H / 2 - 20, 0, W / 2, H / 2 - 20, 80 + p2 * 40);
        glow.addColorStop(0, `rgba(255, 255, 200, ${0.8 + brightness * 0.2})`);
        glow.addColorStop(1, 'rgba(255, 255, 200, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, W, H);

        ctx.font = 'bold 20px monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(`${pkState.evolveOldName} 正在进化...`, W / 2, H / 2 + 60);
      }
      // 阶段3: 进化完成展示（100-150帧）
      else {
        const p3 = Math.min(1, (t - 100) / 30);

        // 新精灵方块（新颜色）
        const newColor = pkState._evolveNewColor || '#fbbf24';
        ctx.fillStyle = newColor;
        const size = 60;
        ctx.fillRect(W / 2 - size / 2, H / 2 - 40 - size / 2, size, size);

        // 闪耀星星
        for (let i = 0; i < 12; i++) {
          const angle = (t * 0.03 + i * Math.PI * 2 / 12);
          const r = 50 + i * 5 + Math.sin(t * 0.1) * 10;
          const sx = W / 2 + Math.cos(angle) * r;
          const sy = H / 2 - 40 + Math.sin(angle) * r * 0.6;
          ctx.fillStyle = `rgba(255, 215, 0, ${p3 * (0.5 + Math.sin(t * 0.15 + i) * 0.3)})`;
          ctx.font = '14px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('✨', sx, sy);
        }

        // 恭喜文字
        ctx.globalAlpha = p3;
        ctx.font = 'bold 22px monospace';
        ctx.fillStyle = '#fbbf24';
        ctx.textAlign = 'center';
        ctx.fillText('🎉 恭喜！进化成功！', W / 2, H / 2 + 40);
        ctx.font = 'bold 18px monospace';
        ctx.fillStyle = '#fff';
        ctx.fillText(`${pkState.evolveOldName} → ${pkState.evolveNewName}`, W / 2, H / 2 + 70);
        ctx.globalAlpha = 1;
      }
    }

    // --- 对话框 ---
    if (pkState.dialogActive) {
      drawDialog(ctx, W, H);
    }

    // --- 地图信息菜单 ---
    if (pkState.mapMenuOpen) {
      drawMapMenu(ctx, W, H);
    }

    // --- 图鉴菜单覆层 ---
    if (pkState.pokedexOpen) {
      drawPokedex(ctx, W, H);
    }

    // --- PC 电脑存储覆层 ---
    if (pkState.pcStorageOpen) {
      drawPCStorage(ctx, W, H);
    }

    // --- 全局菜单覆层（1996经典右侧菜单） ---
    if (pkState.globalMenuOpen) {
      drawGlobalMenu(ctx, W, H);
    }
  }

  // ===== 图鉴绘制（支持151只精灵滚动浏览 + 详情） =====
  function drawPokedex(ctx, W, H) {
    // 半透明遮罩
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, W, H);

    // 图鉴面板（左侧列表 + 右侧详情）
    const panelX = 20;
    const panelY = 20;
    const panelW = W - 40;
    const panelH = H - 40;

    ctx.fillStyle = 'rgba(15, 17, 23, 0.95)';
    ctx.strokeStyle = '#e74c3c';
    ctx.lineWidth = 3;
    roundRect(ctx, panelX, panelY, panelW, panelH, 12);
    ctx.fill();
    ctx.stroke();

    // 标题
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#e74c3c';
    ctx.textAlign = 'center';
    ctx.fillText('📖 POKÉDEX 图鉴', W / 2, panelY + 24);

    // 统计
    const seenCount = Object.values(pokedex).filter(p => p.seen).length;
    const caughtCount = Object.values(pokedex).filter(p => p.caught).length;
    ctx.font = '11px monospace';
    ctx.fillStyle = '#8b8fa3';
    ctx.fillText(`已见:${seenCount}/151  已捕:${caughtCount}/151  拥有:${myPokemon.length}只`, W / 2, panelY + 42);

    // 左侧列表区域
    const listX = panelX + 10;
    const listY = panelY + 52;
    const listW = panelW * 0.45;
    const itemH = 28;
    const maxVisible = Math.floor((panelH - 85) / itemH);

    // 滚动偏移
    const scrollOffset = Math.max(0, Math.min(pkState.pokedexCursor - Math.floor(maxVisible / 2), POKEDEX.length - maxVisible));

    for (let vi = 0; vi < maxVisible && vi + scrollOffset < POKEDEX.length; vi++) {
      const i = vi + scrollOffset;
      const entry = POKEDEX[i];
      const dexEntry = pokedex[entry.id];
      const iy = listY + vi * itemH;

      // 选中高亮
      if (pkState.pokedexCursor === i) {
        ctx.fillStyle = 'rgba(108, 114, 255, 0.25)';
        roundRect(ctx, listX, iy, listW, itemH - 2, 4);
        ctx.fill();
        ctx.strokeStyle = '#6c72ff';
        ctx.lineWidth = 1;
        roundRect(ctx, listX, iy, listW, itemH - 2, 4);
        ctx.stroke();
      }

      // 编号
      ctx.font = '10px monospace';
      ctx.fillStyle = '#555';
      ctx.textAlign = 'left';
      ctx.fillText(`#${String(entry.id).padStart(3, '0')}`, listX + 4, iy + 17);

      if (dexEntry && dexEntry.seen) {
        // 属性色圆点
        ctx.fillStyle = TYPE_COLORS[entry.t[0]] || '#888';
        ctx.beginPath();
        ctx.arc(listX + 40, iy + 13, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = '12px monospace';
        ctx.fillStyle = '#e4e6ed';
        ctx.fillText(entry.n, listX + 50, iy + 17);

        // 捕获标记
        if (dexEntry.caught) {
          ctx.fillStyle = '#2ecc71';
          ctx.font = '10px monospace';
          ctx.textAlign = 'right';
          ctx.fillText('✅', listX + listW - 6, iy + 17);
          ctx.textAlign = 'left';
        }
      } else {
        ctx.font = '12px monospace';
        ctx.fillStyle = '#333';
        ctx.fillText('------', listX + 50, iy + 17);
      }
    }

    // 滚动条
    if (POKEDEX.length > maxVisible) {
      const scrollBarH = panelH - 90;
      const thumbH = Math.max(20, scrollBarH * maxVisible / POKEDEX.length);
      const thumbY = listY + (scrollBarH - thumbH) * (scrollOffset / (POKEDEX.length - maxVisible));
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.fillRect(listX + listW - 4, listY, 4, scrollBarH);
      ctx.fillStyle = 'rgba(108, 114, 255, 0.5)';
      roundRect(ctx, listX + listW - 4, thumbY, 4, thumbH, 2);
      ctx.fill();
    }

    // 右侧详情面板
    const detX = listX + listW + 15;
    const detY = listY;
    const detW = panelW - listW - 40;
    const detH = panelH - 85;

    ctx.fillStyle = 'rgba(30, 32, 40, 0.8)';
    roundRect(ctx, detX, detY, detW, detH, 8);
    ctx.fill();

    const selEntry = POKEDEX[pkState.pokedexCursor];
    const selDex = pokedex[selEntry?.id];

    if (selEntry && selDex && selDex.seen) {
      const monster = WILD_MONSTERS.find(m => m.id === selEntry.id);

      // 精灵图标
      if (monster && monster.drawSprite) {
        ctx.save();
        monster.drawSprite(ctx, detX + detW / 2 - 30, detY + 10, 60, 55);
        ctx.restore();
      } else {
        ctx.fillStyle = TYPE_COLORS[selEntry.t[0]] || '#888';
        ctx.fillRect(detX + detW / 2 - 25, detY + 15, 50, 45);
      }

      // 名字
      ctx.font = 'bold 16px monospace';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(`#${selEntry.id} ${selEntry.n}`, detX + detW / 2, detY + 82);

      // 属性标签
      let tagX = detX + detW / 2 - selEntry.t.length * 25;
      for (const t of selEntry.t) {
        ctx.fillStyle = TYPE_COLORS[t] || '#888';
        roundRect(ctx, tagX, detY + 90, 46, 16, 4);
        ctx.fill();
        ctx.font = '10px monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(`${TYPE_EMOJI[t] || ''} ${t}`, tagX + 23, detY + 101);
        tagX += 52;
      }

      // 基础数值条
      const stats = selEntry.s;
      const statNames = ['HP', 'ATK', 'DEF', 'SPD'];
      const statValues = [stats.hp, stats.at, stats.de, stats.sp];
      const statColors = ['#2ecc71', '#e74c3c', '#3498db', '#f39c12'];

      ctx.textAlign = 'left';
      for (let si = 0; si < 4; si++) {
        const sy = detY + 118 + si * 22;
        ctx.font = '10px monospace';
        ctx.fillStyle = '#8b8fa3';
        ctx.fillText(statNames[si], detX + 10, sy + 12);

        // 数值条背景
        const barX = detX + 45;
        const barW = detW - 85;
        ctx.fillStyle = '#1a1a2a';
        roundRect(ctx, barX, sy + 3, barW, 10, 3);
        ctx.fill();

        // 数值条
        const ratio = Math.min(1, statValues[si] / 160);
        ctx.fillStyle = statColors[si];
        if (ratio > 0) {
          roundRect(ctx, barX, sy + 3, barW * ratio, 10, 3);
          ctx.fill();
        }

        // 数值
        ctx.fillStyle = '#e4e6ed';
        ctx.textAlign = 'right';
        ctx.fillText(statValues[si], detX + detW - 10, sy + 12);
        ctx.textAlign = 'left';
      }

      // 进化信息
      const evoLevel = selEntry.e;
      if (evoLevel) {
        const nextEvo = POKEDEX.find(p => p.id === selEntry.id + 1);
        if (nextEvo) {
          ctx.font = '11px monospace';
          ctx.fillStyle = '#a78bfa';
          ctx.textAlign = 'center';
          ctx.fillText(`Lv.${evoLevel} → ${nextEvo.n}`, detX + detW / 2, detY + detH - 40);
        }
      }

      // 捕获状态
      ctx.font = '12px monospace';
      ctx.textAlign = 'center';
      if (selDex.caught) {
        ctx.fillStyle = '#2ecc71';
        ctx.fillText('✅ 已捕获', detX + detW / 2, detY + detH - 18);
      } else {
        ctx.fillStyle = '#f39c12';
        ctx.fillText('👁 已见未捕', detX + detW / 2, detY + detH - 18);
      }
    } else {
      // 未见过
      ctx.font = 'bold 40px monospace';
      ctx.fillStyle = '#333';
      ctx.textAlign = 'center';
      ctx.fillText('?', detX + detW / 2, detY + detH / 2);
      ctx.font = '12px monospace';
      ctx.fillStyle = '#444';
      ctx.fillText(`#${String(selEntry?.id || 0).padStart(3, '0')} ------`, detX + detW / 2, detY + detH / 2 + 25);
    }

    // 底部提示
    ctx.font = '11px monospace';
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    ctx.fillText('↑↓ 浏览  |  按键/P 关闭', W / 2, panelY + panelH - 8);
  }

  // ===== PC 电脑存储绘制 =====
  function drawPCStorage(ctx, W, H) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, W, H);

    const panelW = 400;
    const panelH = 340;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    ctx.fillStyle = 'rgba(15, 17, 23, 0.95)';
    ctx.strokeStyle = '#3498db';
    ctx.lineWidth = 3;
    roundRect(ctx, panelX, panelY, panelW, panelH, 12);
    ctx.fill();
    ctx.stroke();

    // 标题
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#3498db';
    ctx.textAlign = 'center';
    ctx.fillText('💻 比尔的电脑', W / 2, panelY + 26);

    // 统计
    ctx.font = '11px monospace';
    ctx.fillStyle = '#8b8fa3';
    ctx.fillText(`队伍: ${myPokemon.length}/${MAX_PARTY_SIZE}  |  电脑: ${pcStorage.length} 只`, W / 2, panelY + 44);

    if (pcStorage.length === 0) {
      ctx.font = '14px monospace';
      ctx.fillStyle = '#555';
      ctx.textAlign = 'center';
      ctx.fillText('电脑中没有精灵。', W / 2, panelY + panelH / 2);
      ctx.font = '11px monospace';
      ctx.fillText('队伍超过6只时，新捕获的精灵', W / 2, panelY + panelH / 2 + 25);
      ctx.fillText('会自动传送到这里。', W / 2, panelY + panelH / 2 + 42);
    } else {
      const listY = panelY + 54;
      const itemH = 32;
      const maxVisible = Math.floor((panelH - 90) / itemH);
      const scrollOff = Math.max(0, Math.min(pkState.pcStorageCursor - Math.floor(maxVisible / 2), pcStorage.length - maxVisible));

      for (let vi = 0; vi < maxVisible && vi + scrollOff < pcStorage.length; vi++) {
        const idx = vi + scrollOff;
        const p = pcStorage[idx];
        const iy = listY + vi * itemH;

        if (pkState.pcStorageCursor === idx) {
          ctx.fillStyle = 'rgba(52, 152, 219, 0.25)';
          roundRect(ctx, panelX + 10, iy, panelW - 20, itemH - 2, 4);
          ctx.fill();
          ctx.strokeStyle = '#3498db';
          ctx.lineWidth = 1;
          roundRect(ctx, panelX + 10, iy, panelW - 20, itemH - 2, 4);
          ctx.stroke();
        }

        // 属性色点
        const typeColor = TYPE_COLORS[p.types ? p.types[0] : p.type] || '#888';
        ctx.fillStyle = typeColor;
        ctx.beginPath();
        ctx.arc(panelX + 24, iy + 15, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.font = '12px monospace';
        ctx.fillStyle = '#e4e6ed';
        ctx.textAlign = 'left';
        ctx.fillText(`${p.emoji || ''} ${p.name}`, panelX + 36, iy + 19);

        ctx.fillStyle = '#8b8fa3';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`Lv.${p.level}  HP:${p.maxHP}  ATK:${p.atk}`, panelX + panelW - 16, iy + 19);
      }

      // 滚动条
      if (pcStorage.length > maxVisible) {
        const barH = panelH - 90;
        const thumbH = Math.max(15, barH * maxVisible / pcStorage.length);
        const thumbY = listY + (barH - thumbH) * (scrollOff / Math.max(1, pcStorage.length - maxVisible));
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(panelX + panelW - 8, listY, 4, barH);
        ctx.fillStyle = 'rgba(52, 152, 219, 0.5)';
        roundRect(ctx, panelX + panelW - 8, thumbY, 4, thumbH, 2);
        ctx.fill();
      }
    }

    // 底部提示
    ctx.font = '11px monospace';
    ctx.fillStyle = '#555';
    ctx.textAlign = 'center';
    ctx.fillText('↑↓ 浏览  |  C/ESC 关闭', W / 2, panelY + panelH - 10);
  }

  // ===== 1996版全局菜单绘制 =====
  function drawGlobalMenu(ctx, W, H) {
    // 菜单框出现在屏幕右侧，占约 1/3 宽度
    const menuW = Math.min(180, W * 0.33);
    const menuH = GLOBAL_MENU_ITEMS.length * 34 + 24;
    const menuX = W - menuW - 8;
    const menuY = 10;

    // 滑入动画
    const slideProgress = Math.min(1, pkState.globalMenuAnimTimer / 8);
    const animMenuX = menuX + (1 - slideProgress) * menuW;
    const animAlpha = slideProgress;

    ctx.save();
    ctx.globalAlpha = animAlpha;

    // ===== 黑白双线边框（1996经典风格） =====
    // 外框白色
    ctx.fillStyle = '#fff';
    roundRect(ctx, animMenuX - 3, menuY - 3, menuW + 6, menuH + 6, 6);
    ctx.fill();
    // 内框黑色
    ctx.fillStyle = '#000';
    roundRect(ctx, animMenuX - 1, menuY - 1, menuW + 2, menuH + 2, 5);
    ctx.fill();
    // 菜单背景白色
    ctx.fillStyle = '#f8f8f8';
    roundRect(ctx, animMenuX, menuY, menuW, menuH, 4);
    ctx.fill();

    // ===== 子菜单打开时 → 绘制子菜单 =====
    if (pkState.globalMenuSubMenu) {
      drawGlobalSubMenu(ctx, W, H, animMenuX, menuY, menuW, menuH);
      // 主菜单仍然可见（半透明）
      ctx.globalAlpha = 0.5;
    }

    // ===== 菜单项绘制 =====
    for (let i = 0; i < GLOBAL_MENU_ITEMS.length; i++) {
      const item = GLOBAL_MENU_ITEMS[i];
      const itemY = menuY + 12 + i * 34;
      const isSelected = pkState.globalMenuCursor === i && !pkState.globalMenuSubMenu;

      // 选中高亮背景
      if (isSelected) {
        ctx.fillStyle = 'rgba(40, 40, 60, 0.15)';
        roundRect(ctx, animMenuX + 4, itemY - 4, menuW - 8, 30, 3);
        ctx.fill();
      }

      // ▶ 光标三角形（1996 经典黑色三角）
      if (isSelected) {
        ctx.fillStyle = '#1a1a2e';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'left';
        // 像素偏移效果（选中时右移1px）
        ctx.fillText('▶', animMenuX + 8 + 1, itemY + 15);
      }

      // 图标 + 文字
      ctx.font = '14px monospace';
      ctx.fillStyle = isSelected ? '#1a1a2e' : '#555';
      ctx.textAlign = 'left';
      // 像素偏移效果：选中项右移 2px
      const textOffset = isSelected ? 2 : 0;
      ctx.fillText(`${item.icon} ${item.label}`, animMenuX + 26 + textOffset, itemY + 15);
    }

    ctx.globalAlpha = 1;

    // ===== 底部对话框（联动解释功能） =====
    if (!pkState.globalMenuSubMenu) {
      const descItem = GLOBAL_MENU_ITEMS[pkState.globalMenuCursor];
      if (descItem) {
        const descBoxH = 36;
        const descBoxY = H - descBoxH - 10;
        const descBoxX = 20;
        const descBoxW = W - 40;

        // 1996风格双线边框
        ctx.fillStyle = '#fff';
        roundRect(ctx, descBoxX - 2, descBoxY - 2, descBoxW + 4, descBoxH + 4, 5);
        ctx.fill();
        ctx.fillStyle = '#000';
        roundRect(ctx, descBoxX, descBoxY, descBoxW, descBoxH, 4);
        ctx.fill();
        ctx.fillStyle = '#f8f8f8';
        roundRect(ctx, descBoxX + 2, descBoxY + 2, descBoxW - 4, descBoxH - 4, 3);
        ctx.fill();

        ctx.font = '13px monospace';
        ctx.fillStyle = '#1a1a2e';
        ctx.textAlign = 'left';
        ctx.fillText(descItem.desc, descBoxX + 16, descBoxY + descBoxH / 2 + 5);
      }
    }

    ctx.restore();
  }

  // ===== 子菜单绘制分发 =====
  function drawGlobalSubMenu(ctx, W, H, mainMenuX, mainMenuY, mainMenuW, mainMenuH) {
    ctx.globalAlpha = 1;

    switch (pkState.globalMenuSubMenu) {
      case 'POKEMON':
        drawSubMenuPokemon(ctx, W, H);
        break;
      case 'ITEM':
        drawSubMenuItem(ctx, W, H);
        break;
      case 'SAVE':
        drawSubMenuSave(ctx, W, H);
        break;
      case 'POKEDEX':
        drawSubMenuPokedex(ctx, W, H);
        break;
      case 'PLAYER':
        drawSubMenuPlayer(ctx, W, H);
        break;
      case 'OPTION':
        drawSubMenuOption(ctx, W, H);
        break;
    }
  }

  // ===== 精灵子菜单（队伍6只精灵展示） =====
  function drawSubMenuPokemon(ctx, W, H) {
    // 全屏黑色背景
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(500, W - 40);
    const panelH = Math.min(380, H - 40);
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    // 面板背景（1996风格双线边框）
    ctx.fillStyle = '#fff';
    roundRect(ctx, panelX - 3, panelY - 3, panelW + 6, panelH + 6, 8);
    ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    roundRect(ctx, panelX - 1, panelY - 1, panelW + 2, panelH + 2, 7);
    ctx.fill();
    ctx.fillStyle = '#f0f0f0';
    roundRect(ctx, panelX, panelY, panelW, panelH, 6);
    ctx.fill();

    // 标题
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#1a1a2e';
    ctx.textAlign = 'center';
    ctx.fillText('🐾 POKéMON 精灵', W / 2, panelY + 24);

    if (pkState.globalMenuPokemonDetail >= 0 && pkState.globalMenuPokemonDetail < myPokemon.length) {
      // ===== 精灵详情页 =====
      const p = myPokemon[pkState.globalMenuPokemonDetail];
      drawPokemonDetail(ctx, panelX + 10, panelY + 36, panelW - 20, panelH - 60, p);
      // 底部提示
      ctx.font = '11px monospace';
      ctx.fillStyle = '#888';
      ctx.textAlign = 'center';
      ctx.fillText('按键返回列表', W / 2, panelY + panelH - 10);
      return;
    }

    if (myPokemon.length === 0) {
      ctx.font = '14px monospace';
      ctx.fillStyle = '#888';
      ctx.textAlign = 'center';
      ctx.fillText('你还没有捕获任何精灵！', W / 2, panelY + panelH / 2);
    } else {
      // 精灵列表
      const itemH = 50;
      const listY = panelY + 36;

      for (let i = 0; i < Math.min(6, myPokemon.length); i++) {
        const p = myPokemon[i];
        const iy = listY + i * itemH;
        const isSelected = pkState.globalMenuSubCursor === i;

        // 选中高亮
        if (isSelected) {
          ctx.fillStyle = 'rgba(108, 114, 255, 0.15)';
          roundRect(ctx, panelX + 6, iy, panelW - 12, itemH - 4, 4);
          ctx.fill();
          ctx.strokeStyle = '#6c72ff';
          ctx.lineWidth = 1;
          roundRect(ctx, panelX + 6, iy, panelW - 12, itemH - 4, 4);
          ctx.stroke();
        }

        // 光标
        if (isSelected) {
          ctx.fillStyle = '#1a1a2e';
          ctx.font = 'bold 13px monospace';
          ctx.textAlign = 'left';
          ctx.fillText('▶', panelX + 10, iy + 28);
        }

        // 16x16 缩略图像素块
        const thumbX = panelX + 28;
        const thumbY = iy + 8;
        const thumbSize = 32;
        const typeColor = TYPE_COLORS[p.types ? p.types[0] : p.type] || '#888';
        ctx.fillStyle = typeColor;
        ctx.fillRect(thumbX, thumbY, thumbSize, thumbSize);
        // 简易脸部
        ctx.fillStyle = '#fff';
        ctx.fillRect(thumbX + 6, thumbY + 10, 6, 5);
        ctx.fillRect(thumbX + thumbSize - 12, thumbY + 10, 6, 5);
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(thumbX + 8, thumbY + 11, 3, 3);
        ctx.fillRect(thumbX + thumbSize - 10, thumbY + 11, 3, 3);

        // 名字 + 等级
        ctx.font = 'bold 13px monospace';
        ctx.fillStyle = '#1a1a2e';
        ctx.textAlign = 'left';
        ctx.fillText(`${p.emoji || ''} ${p.name}`, thumbX + thumbSize + 10, iy + 18);
        ctx.font = '11px monospace';
        ctx.fillStyle = '#666';
        ctx.fillText(`Lv.${p.level || 1}`, thumbX + thumbSize + 10, iy + 34);

        // HP 条
        const hpBarX = panelX + panelW / 2 + 20;
        const hpBarY = iy + 14;
        const hpBarW = panelW / 2 - 50;
        const hpBarH = 10;
        const hpRatio = Math.max(0, (p.hp || p.maxHP) / (p.maxHP || 1));
        ctx.fillStyle = '#ddd';
        roundRect(ctx, hpBarX, hpBarY, hpBarW, hpBarH, 3);
        ctx.fill();
        ctx.fillStyle = hpRatio > 0.5 ? '#2ecc71' : hpRatio > 0.2 ? '#f1c40f' : '#e74c3c';
        if (hpRatio > 0) {
          roundRect(ctx, hpBarX, hpBarY, hpBarW * hpRatio, hpBarH, 3);
          ctx.fill();
        }
        ctx.font = '9px monospace';
        ctx.fillStyle = '#444';
        ctx.textAlign = 'left';
        ctx.fillText('HP', hpBarX - 18, hpBarY + 8);
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.ceil(p.hp || p.maxHP)}/${p.maxHP}`, hpBarX + hpBarW, hpBarY + 22);
        ctx.textAlign = 'left';

        // 属性标签
        if (p.types) {
          let tagX = hpBarX;
          for (const t of p.types) {
            ctx.fillStyle = TYPE_COLORS[t] || '#888';
            roundRect(ctx, tagX, iy + 32, 32, 12, 3);
            ctx.fill();
            ctx.font = '8px monospace';
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.fillText(t, tagX + 16, iy + 41);
            tagX += 36;
          }
          ctx.textAlign = 'left';
        }
      }
    }

    // 底部提示
    ctx.font = '11px monospace';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'center';
    ctx.fillText('↑↓ 选择  |  按键查看详情  |  ESC 返回', W / 2, panelY + panelH - 10);
  }

  // ===== 精灵详情页 =====
  function drawPokemonDetail(ctx, x, y, w, h, p) {
    // 大尺寸像素图
    const spriteSize = 64;
    const spriteX = x + w / 2 - spriteSize / 2;
    const spriteY = y + 5;
    const typeColor = TYPE_COLORS[p.types ? p.types[0] : p.type] || '#888';
    ctx.fillStyle = typeColor;
    ctx.fillRect(spriteX, spriteY, spriteSize, spriteSize);
    ctx.fillStyle = '#fff';
    ctx.fillRect(spriteX + 14, spriteY + 20, 12, 10);
    ctx.fillRect(spriteX + spriteSize - 26, spriteY + 20, 12, 10);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(spriteX + 18, spriteY + 23, 6, 6);
    ctx.fillRect(spriteX + spriteSize - 22, spriteY + 23, 6, 6);

    // 名字
    ctx.font = 'bold 18px monospace';
    ctx.fillStyle = '#1a1a2e';
    ctx.textAlign = 'center';
    ctx.fillText(`${p.emoji || ''} ${p.name}  Lv.${p.level || 1}`, x + w / 2, spriteY + spriteSize + 20);

    // 属性标签
    if (p.types) {
      let tagX = x + w / 2 - p.types.length * 25;
      for (const t of p.types) {
        ctx.fillStyle = TYPE_COLORS[t] || '#888';
        roundRect(ctx, tagX, spriteY + spriteSize + 28, 46, 16, 4);
        ctx.fill();
        ctx.font = '10px monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(`${TYPE_EMOJI[t] || ''} ${t}`, tagX + 23, spriteY + spriteSize + 39);
        tagX += 52;
      }
    }

    // 能力值
    const statsY = spriteY + spriteSize + 54;
    const statLabels = ['HP', 'ATK', 'DEF', 'SPD'];
    const statValues = [p.maxHP || 0, p.atk || 0, p.def || 0, p.spd || 0];
    const statColors = ['#2ecc71', '#e74c3c', '#3498db', '#f39c12'];

    ctx.textAlign = 'left';
    for (let i = 0; i < 4; i++) {
      const sy = statsY + i * 24;
      ctx.font = '11px monospace';
      ctx.fillStyle = '#666';
      ctx.fillText(statLabels[i], x + 20, sy + 14);

      const barX = x + 60;
      const barW = w - 110;
      ctx.fillStyle = '#ddd';
      roundRect(ctx, barX, sy + 5, barW, 10, 3);
      ctx.fill();
      const ratio = Math.min(1, statValues[i] / 160);
      ctx.fillStyle = statColors[i];
      if (ratio > 0) {
        roundRect(ctx, barX, sy + 5, barW * ratio, 10, 3);
        ctx.fill();
      }
      ctx.fillStyle = '#1a1a2e';
      ctx.textAlign = 'right';
      ctx.fillText(statValues[i], x + w - 10, sy + 14);
      ctx.textAlign = 'left';
    }

    // 技能列表
    const skillsY = statsY + 4 * 24 + 10;
    ctx.font = 'bold 12px monospace';
    ctx.fillStyle = '#1a1a2e';
    ctx.fillText('技能：', x + 20, skillsY);
    if (p.skills && p.skills.length > 0) {
      for (let i = 0; i < p.skills.length; i++) {
        const s = p.skills[i];
        ctx.font = '11px monospace';
        ctx.fillStyle = '#444';
        ctx.fillText(`${s.emoji} ${s.name}`, x + 30 + (i % 2) * (w / 2 - 20), skillsY + 18 + Math.floor(i / 2) * 18);
      }
    }
  }

  // ===== 物品子菜单 =====
  function drawSubMenuItem(ctx, W, H) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.fillRect(0, 0, W, H);

    const panelW = 320;
    const panelH = 240;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    // 面板双线边框
    ctx.fillStyle = '#fff';
    roundRect(ctx, panelX - 3, panelY - 3, panelW + 6, panelH + 6, 8);
    ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    roundRect(ctx, panelX - 1, panelY - 1, panelW + 2, panelH + 2, 7);
    ctx.fill();
    ctx.fillStyle = '#f0f0f0';
    roundRect(ctx, panelX, panelY, panelW, panelH, 6);
    ctx.fill();

    // 标题
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#1a1a2e';
    ctx.textAlign = 'center';
    ctx.fillText('🎒 ITEM 物品', W / 2, panelY + 24);

    // 物品列表
    const listY = panelY + 44;
    const items = [
      { name: '精灵球', icon: '🔴', count: bag.pokeball, desc: '用于捕捉野生宝可梦' },
    ];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const iy = listY + i * 40;
      const isSelected = true; // 只有一个物品

      if (isSelected) {
        ctx.fillStyle = 'rgba(108, 114, 255, 0.12)';
        roundRect(ctx, panelX + 8, iy, panelW - 16, 36, 4);
        ctx.fill();
        ctx.fillStyle = '#1a1a2e';
        ctx.font = 'bold 13px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('▶', panelX + 14, iy + 22);
      }

      ctx.font = '14px monospace';
      ctx.fillStyle = '#1a1a2e';
      ctx.textAlign = 'left';
      ctx.fillText(`${item.icon} ${item.name}`, panelX + 34, iy + 16);
      ctx.font = '11px monospace';
      ctx.fillStyle = '#666';
      ctx.fillText(item.desc, panelX + 34, iy + 32);

      // 数量
      ctx.font = 'bold 14px monospace';
      ctx.fillStyle = item.count > 0 ? '#2ecc71' : '#e74c3c';
      ctx.textAlign = 'right';
      ctx.fillText(`×${item.count}`, panelX + panelW - 20, iy + 22);
      ctx.textAlign = 'left';
    }

    // 使用/丢弃弹窗
    if (pkState.globalMenuItemAction === 'USE_DROP') {
      const popW = 120;
      const popH = 70;
      const popX = panelX + panelW - popW - 20;
      const popY = panelY + 80;

      ctx.fillStyle = '#fff';
      roundRect(ctx, popX - 2, popY - 2, popW + 4, popH + 4, 5);
      ctx.fill();
      ctx.fillStyle = '#1a1a2e';
      roundRect(ctx, popX, popY, popW, popH, 4);
      ctx.fill();
      ctx.fillStyle = '#f0f0f0';
      roundRect(ctx, popX + 2, popY + 2, popW - 4, popH - 4, 3);
      ctx.fill();

      const options = ['使用', '丢弃'];
      for (let i = 0; i < options.length; i++) {
        const oy = popY + 12 + i * 28;
        const isSel = pkState.globalMenuItemActionCursor === i;
        if (isSel) {
          ctx.fillStyle = '#1a1a2e';
          ctx.font = 'bold 13px monospace';
          ctx.textAlign = 'left';
          ctx.fillText('▶', popX + 10, oy + 14);
        }
        ctx.font = '13px monospace';
        ctx.fillStyle = isSel ? '#1a1a2e' : '#888';
        ctx.fillText(options[i], popX + 30, oy + 14);
      }
    }

    // 底部提示
    ctx.font = '11px monospace';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'center';
    ctx.fillText('按键选择  |  ESC 返回', W / 2, panelY + panelH - 12);
  }

  // ===== 保存子菜单（1996经典询问框） =====
  function drawSubMenuSave(ctx, W, H) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(0, 0, W, H);

    const panelW = 300;
    const panelH = 180;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    // 1996风格双线边框
    ctx.fillStyle = '#fff';
    roundRect(ctx, panelX - 3, panelY - 3, panelW + 6, panelH + 6, 8);
    ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    roundRect(ctx, panelX - 1, panelY - 1, panelW + 2, panelH + 2, 7);
    ctx.fill();
    ctx.fillStyle = '#f0f0f0';
    roundRect(ctx, panelX, panelY, panelW, panelH, 6);
    ctx.fill();

    if (pkState.globalMenuSaveResult === 'SAVING') {
      // 保存中动画
      ctx.font = 'bold 16px monospace';
      ctx.fillStyle = '#1a1a2e';
      ctx.textAlign = 'center';
      const dots = '.'.repeat((Math.floor(pkState.globalMenuSaveTimer / 10) % 3) + 1);
      ctx.fillText(`💾 保存中${dots}`, W / 2, panelY + 70);
      ctx.font = '12px monospace';
      ctx.fillStyle = '#888';
      ctx.fillText('请稍候...', W / 2, panelY + 100);
    } else if (pkState.globalMenuSaveResult === 'SAVED') {
      // 保存成功
      ctx.font = 'bold 16px monospace';
      ctx.fillStyle = '#2ecc71';
      ctx.textAlign = 'center';
      ctx.fillText('✅ 保存成功！', W / 2, panelY + 65);
      ctx.font = '12px monospace';
      ctx.fillStyle = '#666';
      ctx.fillText(`${pkState.playerLevel} 级训练师 · ${MAP_NAMES[currentMapId]}`, W / 2, panelY + 90);
      ctx.fillText(`已捕获 ${myPokemon.length} 只精灵`, W / 2, panelY + 110);

      // 按键继续提示
      if (Math.floor(pkState.globalMenuAnimTimer / 15) % 2 === 0) {
        ctx.fillStyle = '#888';
        ctx.fillText('按键继续', W / 2, panelY + 145);
      }
    } else if (pkState.globalMenuSaveConfirm) {
      // 确认对话框
      ctx.font = 'bold 15px monospace';
      ctx.fillStyle = '#1a1a2e';
      ctx.textAlign = 'center';
      ctx.fillText('你想保存游戏吗？', W / 2, panelY + 40);

      // 保存信息预览
      ctx.font = '11px monospace';
      ctx.fillStyle = '#888';
      ctx.fillText(`Lv.${pkState.playerLevel} · ${MAP_NAMES[currentMapId]} · ${myPokemon.length}只精灵`, W / 2, panelY + 65);

      // 是 / 否 选项
      const opts = ['はい (是)', 'いいえ (否)'];
      for (let i = 0; i < 2; i++) {
        const oy = panelY + 90 + i * 30;
        const isSel = pkState.globalMenuSubCursor === i;
        if (isSel) {
          ctx.fillStyle = '#1a1a2e';
          ctx.font = 'bold 14px monospace';
          ctx.textAlign = 'left';
          ctx.fillText('▶', W / 2 - 70, oy + 14);
        }
        ctx.font = '14px monospace';
        ctx.fillStyle = isSel ? '#1a1a2e' : '#aaa';
        ctx.textAlign = 'left';
        ctx.fillText(opts[i], W / 2 - 50, oy + 14);
      }
    } else {
      // 初始状态：提示
      ctx.font = 'bold 16px monospace';
      ctx.fillStyle = '#1a1a2e';
      ctx.textAlign = 'center';
      ctx.fillText('💾 SAVE 保存', W / 2, panelY + 50);
      ctx.font = '13px monospace';
      ctx.fillStyle = '#666';
      ctx.fillText('按下按键保存游戏进度', W / 2, panelY + 80);

      ctx.font = '11px monospace';
      ctx.fillStyle = '#888';
      ctx.fillText(`当前: Lv.${pkState.playerLevel} · ${MAP_NAMES[currentMapId]}`, W / 2, panelY + 110);
      ctx.fillText(`队伍: ${myPokemon.length}只 · 图鉴: ${Object.values(pokedex).filter(p=>p.caught).length}/151`, W / 2, panelY + 130);

      if (Math.floor(pkState.globalMenuAnimTimer / 15) % 2 === 0) {
        ctx.fillStyle = '#888';
        ctx.fillText('按键保存  |  ESC 返回', W / 2, panelY + 160);
      }
    }
  }

  // ===== 图鉴子菜单（独立全屏黑白界面） =====
  function drawSubMenuPokedex(ctx, W, H) {
    // 全屏黑色背景
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const panelX = 10;
    const panelY = 10;
    const panelW = W - 20;
    const panelH = H - 20;

    // 白色边框
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.strokeRect(panelX, panelY, panelW, panelH);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(panelX + 4, panelY + 4, panelW - 8, panelH - 8);

    // 标题
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText('POKéDEX 图鉴', W / 2, panelY + 26);

    // 统计
    const seenCount = Object.values(pokedex).filter(p => p.seen).length;
    const caughtCount = Object.values(pokedex).filter(p => p.caught).length;
    ctx.font = '10px monospace';
    ctx.fillStyle = '#aaa';
    ctx.fillText(`已见:${seenCount}  已捕:${caughtCount}  共:151`, W / 2, panelY + 42);

    // 列表区
    const listY = panelY + 52;
    const itemH = 22;
    const maxVisible = Math.floor((panelH - 80) / itemH);
    const scrollOffset = Math.max(0, Math.min(pkState.globalMenuSubCursor - Math.floor(maxVisible / 2), POKEDEX.length - maxVisible));

    for (let vi = 0; vi < maxVisible && vi + scrollOffset < POKEDEX.length; vi++) {
      const i = vi + scrollOffset;
      const entry = POKEDEX[i];
      const dexEntry = pokedex[entry.id];
      const iy = listY + vi * itemH;
      const isSelected = pkState.globalMenuSubCursor === i;

      if (isSelected) {
        ctx.fillStyle = '#333';
        ctx.fillRect(panelX + 8, iy, panelW - 16, itemH - 2);
      }

      // 编号
      ctx.font = '10px monospace';
      ctx.fillStyle = isSelected ? '#fff' : '#666';
      ctx.textAlign = 'left';
      ctx.fillText(`#${String(entry.id).padStart(3, '0')}`, panelX + 14, iy + 14);

      if (dexEntry && dexEntry.seen) {
        ctx.font = '12px monospace';
        ctx.fillStyle = isSelected ? '#fff' : '#ccc';
        ctx.fillText(entry.n, panelX + 55, iy + 14);

        // 属性
        ctx.fillStyle = '#888';
        ctx.font = '9px monospace';
        ctx.fillText(entry.t.join('/'), panelX + 160, iy + 14);

        if (dexEntry.caught) {
          ctx.fillStyle = '#2ecc71';
          ctx.font = '10px monospace';
          ctx.textAlign = 'right';
          ctx.fillText('●', panelX + panelW - 14, iy + 14);
          ctx.textAlign = 'left';
        }
      } else {
        ctx.font = '12px monospace';
        ctx.fillStyle = '#444';
        ctx.fillText('------', panelX + 55, iy + 14);
      }
    }

    // 底部提示
    ctx.font = '10px monospace';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.fillText('↑↓ 浏览  |  按键/ESC 返回', W / 2, panelY + panelH - 8);
  }

  // ===== 玩家子菜单 =====
  function drawSubMenuPlayer(ctx, W, H) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, W, H);

    const panelW = 320;
    const panelH = 300;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    // 1996风格边框
    ctx.fillStyle = '#fff';
    roundRect(ctx, panelX - 3, panelY - 3, panelW + 6, panelH + 6, 8);
    ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    roundRect(ctx, panelX - 1, panelY - 1, panelW + 2, panelH + 2, 7);
    ctx.fill();
    ctx.fillStyle = '#f0f0f0';
    roundRect(ctx, panelX, panelY, panelW, panelH, 6);
    ctx.fill();

    // 标题
    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#1a1a2e';
    ctx.textAlign = 'center';
    ctx.fillText('👤 TRAINER 训练师', W / 2, panelY + 26);

    // 玩家角色图标
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(W / 2 - 20, panelY + 36, 40, 40);
    ctx.fillStyle = '#ffeaa7';
    ctx.fillRect(W / 2 - 15, panelY + 34, 30, 14);
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(W / 2 - 18, panelY + 32, 36, 8);

    // 信息列
    const infoY = panelY + 88;
    const infoItems = [
      ['名字', '小智'],
      ['等级', `Lv.${pkState.playerLevel}`],
      ['HP', `${Math.ceil(pkState.playerHP)} / ${pkState.playerMaxHP}`],
      ['ATK', `${pkState.playerAtk}`],
      ['SPD', `${pkState.playerSpeed}`],
      ['经验值', `${pkState.playerExp} / ${pkState.playerLevel * 20}`],
      ['步数', `${pkState.steps}`],
      ['位置', MAP_NAMES[currentMapId]],
      ['精灵', `${myPokemon.length} 只 (PC:${pcStorage.length})`],
      ['图鉴', `${Object.values(pokedex).filter(p=>p.caught).length}/151 已捕`],
      ['徽章', `${Object.keys(badges).length} 个`],
    ];

    ctx.textAlign = 'left';
    for (let i = 0; i < infoItems.length; i++) {
      const iy = infoY + i * 18;
      ctx.font = '11px monospace';
      ctx.fillStyle = '#888';
      ctx.fillText(infoItems[i][0], panelX + 30, iy + 12);
      ctx.fillStyle = '#1a1a2e';
      ctx.textAlign = 'right';
      ctx.fillText(infoItems[i][1], panelX + panelW - 30, iy + 12);
      ctx.textAlign = 'left';
    }

    // 底部提示
    ctx.font = '11px monospace';
    ctx.fillStyle = '#888';
    ctx.textAlign = 'center';
    ctx.fillText('按键/ESC 返回', W / 2, panelY + panelH - 12);
  }

  // ===== 设置子菜单 =====
  function drawSubMenuOption(ctx, W, H) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
    ctx.fillRect(0, 0, W, H);

    const panelW = 300;
    const panelH = 180;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    ctx.fillStyle = '#fff';
    roundRect(ctx, panelX - 3, panelY - 3, panelW + 6, panelH + 6, 8);
    ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    roundRect(ctx, panelX - 1, panelY - 1, panelW + 2, panelH + 2, 7);
    ctx.fill();
    ctx.fillStyle = '#f0f0f0';
    roundRect(ctx, panelX, panelY, panelW, panelH, 6);
    ctx.fill();

    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = '#1a1a2e';
    ctx.textAlign = 'center';
    ctx.fillText('⚙️ OPTION 设置', W / 2, panelY + 30);

    ctx.font = '13px monospace';
    ctx.fillStyle = '#666';
    ctx.fillText('文字速度:  ████████ 快', W / 2, panelY + 70);
    ctx.fillText('战斗动画:  开', W / 2, panelY + 95);
    ctx.fillText('音效:      开', W / 2, panelY + 120);

    ctx.font = '11px monospace';
    ctx.fillStyle = '#888';
    ctx.fillText('按键/ESC 返回', W / 2, panelY + panelH - 12);
  }

  // ===== 切场动画 =====
  function drawTransition(ctx, W, H) {
    const t = pkState.transitionTimer;
    const dur = pkState.transitionDuration;
    const progress = t / dur;

    // 阶段1：黑白闪烁 (0~40%)
    if (progress < 0.4) {
      const flashSpeed = 6;
      const flashOn = Math.floor(t / flashSpeed) % 2 === 0;
      ctx.fillStyle = flashOn ? '#fff' : '#000';
      ctx.fillRect(0, 0, W, H);
    }
    // 阶段2：圆形缩进 (40%~100%)
    else {
      const circleProgress = (progress - 0.4) / 0.6;
      // 先画一帧探索画面（已被切场覆盖）
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);

      // 中心圆形逐渐缩小
      const maxRadius = Math.sqrt(W * W + H * H) / 2;
      const radius = maxRadius * (1 - circleProgress);

      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, Math.max(0, radius), 0, Math.PI * 2);
      ctx.clip();

      // 闪烁的白色/原色
      if (circleProgress < 0.5) {
        ctx.fillStyle = Math.floor(t / 4) % 2 === 0 ? '#fff' : '#333';
      } else {
        ctx.fillStyle = '#000';
      }
      ctx.fillRect(0, 0, W, H);
      ctx.restore();

      // 怪物名字渐入（1996风格分行）
      if (circleProgress > 0.6) {
        const alpha = Math.min(1, (circleProgress - 0.6) / 0.4);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 24px monospace';
        ctx.textAlign = 'center';
        if (pkState.isBossBattle) {
          ctx.fillText(`⚔ 馆主小刚`, W / 2, H / 2 - 16);
          if (circleProgress > 0.8) {
            ctx.fillText(`派出了 ${pkState.battleMonsterName}！`, W / 2, H / 2 + 16);
          }
        } else {
          ctx.fillText(`野生的 ${pkState.battleMonsterName}`, W / 2, H / 2 - 16);
          if (circleProgress > 0.8) {
            ctx.fillText(`出现了！`, W / 2, H / 2 + 16);
          }
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  // ===== 战斗界面绘制 =====
  function drawBattle(ctx, W, H) {
    const monster = pkState._battleMonster || { name: '???', emoji: '❓', color: '#888' };
    const isCatching = pkState.battlePhase === 'CATCHING' || pkState.battlePhase === 'CATCH_SUCCESS' || pkState.battlePhase === 'CATCH_FAIL';

    // === 背景：渐变天空 + 地面 ===
    const skyGrad = ctx.createLinearGradient(0, 0, 0, H * 0.55);
    skyGrad.addColorStop(0, '#87CEEB');
    skyGrad.addColorStop(1, '#E0F0FF');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H * 0.55);

    // 地面
    const groundGrad = ctx.createLinearGradient(0, H * 0.5, 0, H);
    groundGrad.addColorStop(0, '#7BB660');
    groundGrad.addColorStop(1, '#5A9040');
    ctx.fillStyle = groundGrad;
    ctx.fillRect(0, H * 0.5, W, H * 0.5);

    // 地面分界线
    ctx.strokeStyle = '#4A8030';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, H * 0.5);
    ctx.lineTo(W, H * 0.5);
    ctx.stroke();

    // === 敌方对战台（右上） ===
    const enemyPlatX = W * 0.6;
    const enemyPlatY = H * 0.28;
    // 椭圆台座
    ctx.fillStyle = '#6B8E50';
    ctx.beginPath();
    ctx.ellipse(enemyPlatX + 50, enemyPlatY + 45, 70, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4A6B30';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 敌方精灵（使用自定义绘制函数）
    const eSx = enemyPlatX + 20 + pkState.battleShakeEnemy;
    const eSy = enemyPlatY - 20;

    // 捕捉中：精灵消失（被球吸入）
    const showEnemy = !(isCatching && pkState.catchAnimPhase >= 1);
    if (showEnemy) {
      if (monster.drawSprite) {
        monster.drawSprite(ctx, eSx, eSy, 60, 55);
      } else {
        // 后备：简单色块
        ctx.fillStyle = monster.color;
        ctx.fillRect(eSx, eSy, 60, 55);
        ctx.fillStyle = '#fff';
        ctx.fillRect(eSx + 12, eSy + 15, 12, 10);
        ctx.fillRect(eSx + 36, eSy + 15, 12, 10);
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(eSx + 16, eSy + 18, 6, 6);
        ctx.fillRect(eSx + 40, eSy + 18, 6, 6);
      }
      // HP 为 0 时闪烁
      if (pkState.enemyHP <= 0 && Math.floor(pkState.battleFlashTimer / 6) % 2 === 0) {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#fff';
        ctx.fillRect(eSx, eSy, 60, 55);
        ctx.globalAlpha = 1;
      }
    }

    // === 捕捉动画：精灵球 ===
    if (isCatching || pkState.battlePhase === 'CATCH_SUCCESS') {
      const ballTargetX = enemyPlatX + 40;
      const ballTargetY = enemyPlatY + 10;

      let ballX, ballY, ballSize = 18;
      if (pkState.battlePhase === 'CATCHING' && pkState.catchAnimPhase === 0) {
        // 投掷阶段：球从左下飞到右上
        const t = pkState.catchAnimTimer / 30;
        ballX = 120 + (ballTargetX - 120) * t;
        ballY = 300 + (ballTargetY - 300) * t - Math.sin(t * Math.PI) * 60;
      } else {
        // 抖动阶段
        ballX = ballTargetX;
        ballY = ballTargetY;
        if (pkState.battlePhase === 'CATCHING' && pkState.catchAnimPhase >= 1 && pkState.catchAnimPhase <= 3) {
          const shakeAmount = Math.sin(pkState.catchAnimTimer * 0.6) * 6;
          ballX += shakeAmount;
        }
      }

      if (ballX !== undefined) {
        // 画精灵球
        // 上半红
        ctx.fillStyle = '#e74c3c';
        ctx.beginPath();
        ctx.arc(ballX, ballY, ballSize, Math.PI, 0);
        ctx.fill();
        // 下半白
        ctx.fillStyle = '#ecf0f1';
        ctx.beginPath();
        ctx.arc(ballX, ballY, ballSize, 0, Math.PI);
        ctx.fill();
        // 中间线
        ctx.fillStyle = '#2d3436';
        ctx.fillRect(ballX - ballSize, ballY - 2, ballSize * 2, 4);
        // 中心按钮
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(ballX, ballY, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#2d3436';
        ctx.lineWidth = 2;
        ctx.stroke();

        // 捕捉成功：星星特效
        if (pkState.battlePhase === 'CATCH_SUCCESS') {
          for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2 + pkState.battleFlashTimer * 0.05;
            const dist = 25 + Math.sin(pkState.battleFlashTimer * 0.1 + i) * 8;
            const sx = ballX + Math.cos(angle) * dist;
            const sy = ballY + Math.sin(angle) * dist;
            ctx.fillStyle = '#fbbf24';
            ctx.font = '12px monospace';
            ctx.textAlign = 'center';
            ctx.fillText('✦', sx, sy);
          }
        }
      }
    }

    // 伤害数字（浮动）
    if (pkState.battlePhase === 'PLAYER_ATTACK' && pkState.battleAnimTimer < 25) {
      const dmgY = eSy - 10 - pkState.battleAnimTimer * 0.5;
      ctx.font = 'bold 18px monospace';
      ctx.fillStyle = '#ff4444';
      ctx.textAlign = 'center';
      const alpha = Math.max(0, 1 - pkState.battleAnimTimer / 25);
      ctx.globalAlpha = alpha;
      ctx.fillText(pkState.battleDamageText, eSx + 30, dmgY);
      ctx.globalAlpha = 1;
    }

    // === 敌方信息框（左上） ===
    drawInfoBox(ctx, 20, 20, 220, 65, pkState.battleMonsterName, pkState.enemyLevel,
      pkState.enemyDisplayHP, pkState.enemyMaxHP, monster.color);

    // === 玩家对战台（左下） ===
    const playerPlatX = W * 0.12;
    const playerPlatY = H * 0.55;
    ctx.fillStyle = '#6B8E50';
    ctx.beginPath();
    ctx.ellipse(playerPlatX + 50, playerPlatY + 45, 70, 18, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4A6B30';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 玩家精灵背影（红色系）
    const pSx = playerPlatX + 15 + pkState.battleShakePlayer;
    const pSy = playerPlatY - 25;
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(pSx, pSy, 65, 60);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(pSx + 5, pSy + 5, 18, 18);
    // 帽子
    ctx.fillStyle = '#c0392b';
    ctx.fillRect(pSx + 5, pSy - 5, 55, 12);
    ctx.fillRect(pSx + 0, pSy + 3, 65, 5);
    // HP 为 0 时闪烁
    if (pkState.playerHP <= 0 && Math.floor(pkState.battleFlashTimer / 6) % 2 === 0) {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#fff';
      ctx.fillRect(pSx, pSy, 65, 60);
      ctx.globalAlpha = 1;
    }
    // 敌人攻击伤害数字
    if (pkState.battlePhase === 'ENEMY_ATTACK' && pkState.battleAnimTimer < 25) {
      const dmgY = pSy - 10 - pkState.battleAnimTimer * 0.5;
      ctx.font = 'bold 18px monospace';
      ctx.fillStyle = '#ff4444';
      ctx.textAlign = 'center';
      const alpha = Math.max(0, 1 - pkState.battleAnimTimer / 25);
      ctx.globalAlpha = alpha;
      ctx.fillText(pkState.battleDamageText, pSx + 32, dmgY);
      ctx.globalAlpha = 1;
    }

    // === 玩家信息框（右侧中部） ===
    drawInfoBox(ctx, W - 240, H * 0.42, 220, 65, '小智', pkState.playerLevel,
      pkState.playerDisplayHP, pkState.playerMaxHP, '#e74c3c');

    // === 经验条（玩家信息框下方） ===
    const expBarX = W - 240 + 35;
    const expBarY = H * 0.42 + 68;
    const expBarW = 220 - 50;
    const expBarH = 6;
    ctx.fillStyle = '#2d2d3d';
    roundRect(ctx, expBarX, expBarY, expBarW, expBarH, 3);
    ctx.fill();
    const expRatio = pkState.playerExp / (pkState.playerLevel * 20);
    if (expRatio > 0) {
      ctx.fillStyle = '#3498db';
      roundRect(ctx, expBarX, expBarY, expBarW * Math.min(1, expRatio), expBarH, 3);
      ctx.fill();
    }
    ctx.font = '9px monospace';
    ctx.fillStyle = '#8b8fa3';
    ctx.textAlign = 'left';
    ctx.fillText('EXP', W - 240 + 12, expBarY + 5);

    // === 升级特效 ===
    if (pkState.battlePhase === 'LEVEL_UP') {
      // 全屏金色光效
      const alpha = Math.min(0.3, Math.sin(pkState.levelUpAnimTimer * 0.08) * 0.2 + 0.15);
      ctx.fillStyle = `rgba(251, 191, 36, ${alpha})`;
      ctx.fillRect(0, 0, W, H);

      // 上升星星粒子
      for (let i = 0; i < 8; i++) {
        const starX = W * 0.2 + (i * W * 0.08);
        const starY = H - (pkState.levelUpAnimTimer * 2 + i * 30) % H;
        ctx.fillStyle = '#fbbf24';
        ctx.font = '16px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('★', starX, starY);
      }
    }

    // === 属性克制特效复刻（1996风格屏幕闪烁） ===
    if (pkState.screenFlashTimer > 0) {
      // 效果拔群：整个Canvas黑白反转闪烁2次
      const flashOn = Math.floor(pkState.screenFlashTimer / 6) % 2 === 0;
      if (pkState.screenFlashType === 'super') {
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = flashOn ? '#fff' : '#000';
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    // 无效提示
    if (pkState._lastTypeEffectivenessMsg === 'immune' && pkState.battlePhase === 'PLAYER_ATTACK') {
      ctx.font = 'bold 20px monospace';
      ctx.fillStyle = '#888';
      ctx.textAlign = 'center';
      ctx.fillText('✕ 没有效果！', W / 2, H * 0.25);
    }

    // === 敌方属性标签 ===
    if (monster.types && monster.types.length > 0) {
      let tx = 24;
      for (const t of monster.types) {
        ctx.fillStyle = TYPE_COLORS[t] || '#888';
        roundRect(ctx, tx, 90, 40, 14, 3);
        ctx.fill();
        ctx.font = '9px monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(t, tx + 20, 100);
        tx += 44;
      }
    }

    // === 底部操作区 ===
    const boxY = H * 0.75;
    const boxH = H - boxY - 10;

    // 消息框（左侧）
    const msgBoxW = W * 0.55;
    ctx.fillStyle = 'rgba(15, 17, 23, 0.92)';
    ctx.strokeStyle = '#4a4e69';
    ctx.lineWidth = 3;
    roundRect(ctx, 10, boxY, msgBoxW, boxH, 10);
    ctx.fill();
    ctx.stroke();

    // 消息文本（1996风格打字机效果）
    ctx.font = '14px monospace';
    ctx.fillStyle = '#e4e6ed';
    ctx.textAlign = 'left';
    if (pkState.battlePhase === 'TEXT_FLOW' && pkState.battleTextCurrent) {
      // 打字机效果：逐字显示
      const visibleText = pkState.battleTextCurrent.substring(0, Math.floor(pkState.battleTextCharIndex));
      const lines = visibleText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], 28, boxY + 24 + i * 20);
      }
      // 等待按键提示
      if (pkState.battleTextWaiting && Math.floor(pkState.battleFlashTimer / 15) % 2 === 0) {
        ctx.fillStyle = '#6c72ff';
        ctx.font = '12px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('▼', 28 + msgBoxW - 30, boxY + boxH - 10);
      }
    } else if (pkState.learnSkillPhase === 'SELECT_REPLACE') {
      // 技能替换选择菜单
      const pokemon = myPokemon[pkState.learnSkillPokemonIdx];
      if (pokemon && pokemon.skills) {
        ctx.fillText(`选择要遗忘的招式：`, 28, boxY + 20);
        for (let i = 0; i < pokemon.skills.length; i++) {
          const s = pokemon.skills[i];
          const prefix = i === pkState.learnSkillCursor ? '▶ ' : '   ';
          ctx.fillStyle = i === pkState.learnSkillCursor ? '#fff' : '#8b8fa3';
          ctx.fillText(`${prefix}${s.emoji} ${s.name}`, 28, boxY + 38 + i * 18);
        }
        ctx.fillStyle = '#fbbf24';
        ctx.font = '10px monospace';
        ctx.fillText(`新技能: ${pkState.learnSkillPending?.emoji || ''} ${pkState.learnSkillPending?.name || ''}`, 28, boxY + boxH - 8);
      }
    } else if (pkState.battleMsg) {
      const lines = pkState.battleMsg.split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], 28, boxY + 24 + i * 20);
      }
    } else {
      ctx.fillText(pkState.isBossBattle ? '⚔ 馆主对战！要怎么做？' : '要怎么做？', 28, boxY + 30);
    }

    // 精灵球数量提示（底栏左下角）
    ctx.font = '11px monospace';
    ctx.fillStyle = '#8b8fa3';
    ctx.textAlign = 'left';
    ctx.fillText(`🔴×${bag.pokeball}`, 16, boxY + boxH - 6);

    // === 右侧菜单区 ===
    const menuX = msgBoxW + 25;
    const menuW = W - menuX - 10;

    if (pkState.battlePhase === 'MENU') {
      drawMainMenu(ctx, menuX, boxY, menuW, boxH);
    } else if (pkState.battlePhase === 'SKILL_MENU') {
      drawSkillMenu(ctx, menuX, boxY, menuW, boxH);
    } else if (pkState.battlePhase === 'BAG_MENU') {
      drawBagMenu(ctx, menuX, boxY, menuW, boxH);
    } else {
      // 动画/结果时显示空菜单或提示
      ctx.fillStyle = 'rgba(15, 17, 23, 0.92)';
      ctx.strokeStyle = '#4a4e69';
      ctx.lineWidth = 3;
      roundRect(ctx, menuX, boxY, menuW, boxH, 10);
      ctx.fill();
      ctx.stroke();

      const showContinue = ['WIN', 'LOSE', 'FLEE', 'RESULT', 'CATCH_SUCCESS', 'CATCH_FAIL', 'LEVEL_UP'].includes(pkState.battlePhase);
      if (showContinue) {
        // 闪烁的继续提示
        if (Math.floor(pkState.battleFlashTimer / 15) % 2 === 0) {
          ctx.font = '13px monospace';
          ctx.fillStyle = '#8b8fa3';
          ctx.textAlign = 'center';
          ctx.fillText('▶ 按键继续', menuX + menuW / 2, boxY + boxH / 2 + 5);
        }
      }
    }
  }

  // === 信息框（名字+等级+血条） ===
  function drawInfoBox(ctx, x, y, w, h, name, level, currentHP, maxHP, color) {
    // 背景
    ctx.fillStyle = 'rgba(15, 17, 23, 0.88)';
    ctx.strokeStyle = '#4a4e69';
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 8);
    ctx.fill();
    ctx.stroke();

    // 名字
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = '#e4e6ed';
    ctx.textAlign = 'left';
    ctx.fillText(name, x + 12, y + 20);

    // 等级
    ctx.font = '12px monospace';
    ctx.fillStyle = '#8b8fa3';
    ctx.textAlign = 'right';
    ctx.fillText(`Lv.${level}`, x + w - 12, y + 20);

    // HP 标签
    ctx.font = 'bold 11px monospace';
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'left';
    ctx.fillText('HP', x + 12, y + 42);

    // HP 血条背景
    const barX = x + 35;
    const barY = y + 33;
    const barW = w - 50;
    const barH = 12;
    ctx.fillStyle = '#2d2d3d';
    roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.fill();

    // HP 血条
    const hpRatio = Math.max(0, currentHP / maxHP);
    let hpColor;
    if (hpRatio > 0.5) hpColor = '#2ecc71';
    else if (hpRatio > 0.2) hpColor = '#f1c40f';
    else hpColor = '#e74c3c';

    if (hpRatio > 0) {
      ctx.fillStyle = hpColor;
      roundRect(ctx, barX, barY, barW * hpRatio, barH, 4);
      ctx.fill();
    }

    // HP 数值
    ctx.font = '10px monospace';
    ctx.fillStyle = '#e4e6ed';
    ctx.textAlign = 'right';
    ctx.fillText(`${Math.ceil(currentHP)}/${maxHP}`, x + w - 12, y + 58);
  }

  // === 四宫格主菜单 ===
  function drawMainMenu(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(15, 17, 23, 0.92)';
    ctx.strokeStyle = '#4a4e69';
    ctx.lineWidth = 3;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();

    const labels = ['⚔️ 战斗', '🎒 背包', '🐾 精灵', '🏃 逃跑'];
    const halfW = w / 2;
    const halfH = h / 2;

    for (let i = 0; i < 4; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const bx = x + col * halfW + 8;
      const by = y + row * halfH + 6;
      const bw = halfW - 16;
      const bh = halfH - 12;

      // 选中高亮
      if (pkState.menuCursor === i) {
        ctx.fillStyle = 'rgba(108, 114, 255, 0.3)';
        roundRect(ctx, bx, by, bw, bh, 6);
        ctx.fill();
        ctx.strokeStyle = '#6c72ff';
        ctx.lineWidth = 2;
        roundRect(ctx, bx, by, bw, bh, 6);
        ctx.stroke();

        // 选择箭头
        ctx.fillStyle = '#6c72ff';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('▶', bx + 4, by + bh / 2 + 5);
      }

      // 标签
      ctx.font = 'bold 14px monospace';
      ctx.fillStyle = pkState.menuCursor === i ? '#fff' : '#8b8fa3';
      ctx.textAlign = 'center';
      ctx.fillText(labels[i], bx + bw / 2 + 6, by + bh / 2 + 5);
    }
  }

  // === 技能选择菜单 ===
  function drawSkillMenu(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(15, 17, 23, 0.92)';
    ctx.strokeStyle = '#4a4e69';
    ctx.lineWidth = 3;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();

    // 标题
    ctx.font = 'bold 12px monospace';
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'left';
    ctx.fillText('选择技能：', x + 12, y + 18);

    const skillH = (h - 28) / pkState.skills.length;

    for (let i = 0; i < pkState.skills.length; i++) {
      const skill = pkState.skills[i];
      const sy = y + 24 + i * skillH;

      // 选中高亮
      if (pkState.skillCursor === i) {
        ctx.fillStyle = 'rgba(108, 114, 255, 0.3)';
        roundRect(ctx, x + 6, sy, w - 12, skillH - 4, 4);
        ctx.fill();

        ctx.fillStyle = '#6c72ff';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'left';
        ctx.fillText('▶', x + 10, sy + skillH / 2 + 1);
      }

      // 技能名
      ctx.font = '13px monospace';
      ctx.fillStyle = pkState.skillCursor === i ? '#fff' : '#a0a3b5';
      ctx.textAlign = 'left';
      ctx.fillText(`${skill.emoji} ${skill.name}`, x + 26, sy + skillH / 2 + 1);

      // 属性标签 + 威力（增强显示）
      const typeZh = skill.skillTypeZh || (skill.type === 'debuff' || skill.type === 'debuff_atk' ? '效果' : '普通');
      const tc = TYPE_COLORS[typeZh] || '#666';
      ctx.fillStyle = tc;
      roundRect(ctx, x + w - 82, sy + skillH / 2 - 8, 32, 14, 3);
      ctx.fill();
      ctx.font = '8px monospace';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(typeZh, x + w - 66, sy + skillH / 2 + 2);

      if (skill.power > 0) {
        ctx.font = '10px monospace';
        ctx.fillStyle = '#8b8fa3';
        ctx.textAlign = 'right';
        ctx.fillText(`P${skill.power}`, x + w - 10, sy + skillH / 2 + 1);
      } else {
        ctx.font = '10px monospace';
        ctx.fillStyle = '#666';
        ctx.textAlign = 'right';
        ctx.fillText('--', x + w - 10, sy + skillH / 2 + 1);
      }
    }
  }

  // === 背包菜单 ===
  function drawBagMenu(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(15, 17, 23, 0.92)';
    ctx.strokeStyle = '#4a4e69';
    ctx.lineWidth = 3;
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.stroke();

    // 标题
    ctx.font = 'bold 12px monospace';
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'left';
    ctx.fillText('🎒 背包', x + 12, y + 18);

    // 精灵球选项
    const itemY = y + 30;
    const itemH = h - 40;

    // 选中高亮
    if (pkState.bagCursor === 0) {
      ctx.fillStyle = 'rgba(108, 114, 255, 0.3)';
      roundRect(ctx, x + 6, itemY, w - 12, itemH - 4, 4);
      ctx.fill();
      ctx.fillStyle = '#6c72ff';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('▶', x + 10, itemY + itemH / 2);
    }

    // 精灵球图标和数量
    ctx.font = '14px monospace';
    ctx.fillStyle = bag.pokeball > 0 ? '#fff' : '#666';
    ctx.textAlign = 'left';
    ctx.fillText(`🔴 精灵球`, x + 26, itemY + itemH / 2 - 4);
    ctx.font = '12px monospace';
    ctx.fillStyle = bag.pokeball > 0 ? '#2ecc71' : '#e74c3c';
    ctx.fillText(`× ${bag.pokeball}`, x + 26, itemY + itemH / 2 + 14);

    // 底部提示
    ctx.font = '10px monospace';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.fillText('ESC 返回', x + w / 2, y + h - 6);
  }

  // === 圆角矩形辅助 ===
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ===== 小地图 =====
  function drawMinimap(ctx, W, H) {
    const map = getCurrentMap();
    const mmSize = 3; // 每格小地图像素
    const mmW = MAP_W * mmSize;
    const mmH = MAP_H * mmSize;
    const mmX = W - mmW - 10;
    const mmY = H - mmH - 10;

    // 背景
    ctx.fillStyle = 'rgba(15, 17, 23, 0.8)';
    ctx.fillRect(mmX - 2, mmY - 2, mmW + 4, mmH + 4);
    ctx.strokeStyle = '#3d4255';
    ctx.lineWidth = 1;
    ctx.strokeRect(mmX - 2, mmY - 2, mmW + 4, mmH + 4);

    const theme = MAP_THEMES[currentMapId] || MAP_THEMES[0];
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const t = map[y][x];
        if (t === T_WALL) ctx.fillStyle = theme.wallColor;
        else if (t === T_GRASS) ctx.fillStyle = '#1a6b1a';
        else if (t === T_NPC) ctx.fillStyle = '#8b5cf6';
        else if (t === T_PORTAL) ctx.fillStyle = '#6c72ff';
        else if (t === T_BOSS) ctx.fillStyle = '#8b0000';
        else ctx.fillStyle = theme.ground2;
        ctx.fillRect(mmX + x * mmSize, mmY + y * mmSize, mmSize, mmSize);
      }
    }

    // 玩家位置
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(mmX + pkState.px * mmSize - 1, mmY + pkState.py * mmSize - 1, mmSize + 2, mmSize + 2);
  }

  // ===== 地图信息菜单 =====
  function drawMapMenu(ctx, W, H) {
    // 半透明遮罩
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(0, 0, W, H);

    const panelW = 360;
    const panelH = 280;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    ctx.fillStyle = 'rgba(15, 17, 23, 0.95)';
    ctx.strokeStyle = '#6c72ff';
    ctx.lineWidth = 3;
    roundRect(ctx, panelX, panelY, panelW, panelH, 12);
    ctx.fill();
    ctx.stroke();

    // 标题
    ctx.font = 'bold 18px monospace';
    ctx.fillStyle = '#6c72ff';
    ctx.textAlign = 'center';
    ctx.fillText('🗺 地图信息', W / 2, panelY + 30);

    // 当前地图
    ctx.font = 'bold 14px monospace';
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'left';
    ctx.fillText(`当前位置: ${MAP_NAMES[currentMapId]}`, panelX + 20, panelY + 60);

    // 地图列表
    const mapListY = panelY + 80;
    for (let i = 0; i < MAP_NAMES.length; i++) {
      const ly = mapListY + i * 36;
      const isCurrent = i === currentMapId;

      if (isCurrent) {
        ctx.fillStyle = 'rgba(108, 114, 255, 0.2)';
        roundRect(ctx, panelX + 15, ly, panelW - 30, 30, 6);
        ctx.fill();
      }

      ctx.font = '13px monospace';
      ctx.fillStyle = isCurrent ? '#fff' : '#8b8fa3';
      ctx.textAlign = 'left';
      ctx.fillText(`${isCurrent ? '▶ ' : '  '}${MAP_NAMES[i]}`, panelX + 25, ly + 20);

      // 遇敌率
      ctx.fillStyle = '#666';
      ctx.textAlign = 'right';
      const rate = MAP_ENCOUNTER_RATES[i];
      ctx.fillText(rate === 0 ? '安全区' : `遇敌率 ${Math.round(rate * 100)}%`, panelX + panelW - 25, ly + 20);
    }

    // 徽章信息
    const badgeY = mapListY + MAP_NAMES.length * 36 + 10;
    ctx.font = 'bold 13px monospace';
    ctx.fillStyle = '#fbbf24';
    ctx.textAlign = 'left';
    ctx.fillText('获得的徽章:', panelX + 20, badgeY + 5);

    const badgeKeys = Object.keys(badges);
    if (badgeKeys.length === 0) {
      ctx.font = '12px monospace';
      ctx.fillStyle = '#666';
      ctx.fillText('  还没有获得任何徽章', panelX + 20, badgeY + 25);
    } else {
      badgeKeys.forEach((key, i) => {
        ctx.font = '12px monospace';
        ctx.fillStyle = '#2ecc71';
        ctx.fillText(`  ${badges[key].name}`, panelX + 20, badgeY + 25 + i * 18);
      });
    }

    // 底部提示
    ctx.font = '11px monospace';
    ctx.fillStyle = '#666';
    ctx.textAlign = 'center';
    ctx.fillText('按 M 关闭  |  按 O 存档  |  按 P 图鉴', W / 2, panelY + panelH - 12);
  }

  // ===== 对话框 =====
  function drawDialog(ctx, W, H) {
    const boxH = 100;
    const boxY = H - boxH - 20;
    const boxX = 40;
    const boxW = W - 80;

    // 框体
    ctx.fillStyle = 'rgba(15, 17, 23, 0.92)';
    ctx.strokeStyle = '#6c72ff';
    ctx.lineWidth = 2;
    // 圆角矩形
    const r = 12;
    ctx.beginPath();
    ctx.moveTo(boxX + r, boxY);
    ctx.lineTo(boxX + boxW - r, boxY);
    ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + r);
    ctx.lineTo(boxX + boxW, boxY + boxH - r);
    ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - r, boxY + boxH);
    ctx.lineTo(boxX + r, boxY + boxH);
    ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - r);
    ctx.lineTo(boxX, boxY + r);
    ctx.quadraticCurveTo(boxX, boxY, boxX + r, boxY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 打字机效果文本
    const fullText = pkState.dialogText;
    const visibleChars = Math.min(fullText.length, Math.floor(pkState.dialogTimer * 1.5));
    const displayText = fullText.substring(0, visibleChars);

    ctx.font = '15px monospace';
    ctx.fillStyle = '#e4e6ed';
    ctx.textAlign = 'left';

    // 多行文本
    const lines = displayText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], boxX + 20, boxY + 30 + i * 24);
    }

    // 闪烁的继续提示
    if (visibleChars >= fullText.length) {
      if (Math.floor(pkState.frame / 20) % 2 === 0) {
        ctx.fillStyle = '#6c72ff';
        ctx.font = '12px monospace';
        ctx.textAlign = 'right';
        ctx.fillText('▼ 按键继续', boxX + boxW - 20, boxY + boxH - 14);
      }
    }

    // NPC 头像
    ctx.fillStyle = '#8b5cf6';
    ctx.fillRect(boxX + 16, boxY + 8, 16, 16);
    ctx.fillStyle = '#a78bfa';
    ctx.fillRect(boxX + 18, boxY + 6, 12, 8);
    ctx.fillStyle = '#fff';
    ctx.fillRect(boxX + 19, boxY + 8, 3, 3);
    ctx.fillRect(boxX + 26, boxY + 8, 3, 3);
  }

  // ===== 游戏启动：读取存档 =====
  const hasLocalSave = loadGame();
  if (hasLocalSave) {
    console.log('[Pokemon] 已从存档恢复进度');
  }

  // ===== 游戏主循环 =====
  function loop() {
    update();
    draw();
    gameAnimationId = requestAnimationFrame(loop);
  }
  loop();
}

// ===== 串口面板显示/隐藏 =====
const appLayout = document.getElementById('appLayout');

function toggleSerialPanel() {
  appLayout.classList.toggle('serial-hidden');

  // 🔴 同步更新面板可见状态标记
  const hidden = appLayout.classList.contains('serial-hidden');
  _serialPanelVisible = !hidden;

  // 面板隐藏时清空缓冲区，避免重新显示时一次性刷出大量内容
  if (hidden) {
    _appendBuffer.length = 0;
  }

  // 记住用户偏好
  localStorage.setItem('serial-panel-hidden', hidden ? '1' : '0');
}

// 读取上次的面板状态
(function restoreSerialPanelState() {
  const saved = localStorage.getItem('serial-panel-hidden');
  if (saved === '1') {
    appLayout.classList.add('serial-hidden');
    _serialPanelVisible = false; // 🔴 启动时就正确设置
  }
})();

// 读取串口输出开关状态（默认关闭）
(function restoreSerialOutputState() {
  const saved = localStorage.getItem('serial-output-enabled');
  _serialOutputEnabled = saved === '1'; // 默认 false（关闭）
  const btn = document.getElementById('serialOutputToggle');
  if (btn) {
    btn.classList.toggle('active', _serialOutputEnabled);
    btn.title = _serialOutputEnabled ? '串口输出：开 (点击关闭)' : '串口输出：关 (点击打开)';
  }
})();

// ========== 3D 极速跑酷 ==========
function startRunner() {
  if (typeof THREE === 'undefined') {
    console.error('Three.js not loaded');
    return;
  }

  // === DOM references ===
  const container = document.getElementById('runnerCanvas');
  const runnerContainer = document.getElementById('runnerContainer');
  const hudDistance = document.getElementById('runnerDistance');
  const hudCoins = document.getElementById('runnerCoins');
  const joystickEl = document.getElementById('runnerJoystick');
  const knobEl = document.getElementById('runnerJoystickKnob');
  const slideBtn = document.getElementById('runnerSlideBtn');
  const gameOverEl = document.getElementById('runnerGameOver');
  const finalScoreEl = document.getElementById('runnerFinalScore');
  const restartBtn = document.getElementById('runnerRestartBtn');

  // Clear previous renderer if any
  while (container.firstChild) container.removeChild(container.firstChild);
  gameOverEl.style.display = 'none';

  // === Constants ===
  const LANE_WIDTH = 2.5;
  const LANES = [-LANE_WIDTH, 0, LANE_WIDTH]; // left, center, right
  const TRACK_SEGMENT_LENGTH = 20;
  const TRACK_SEGMENTS_COUNT = 8;
  const OBSTACLE_START_Z = -40;
  const COIN_START_Z = -40;
  const BASE_SPEED = 12;
  const MAX_SPEED = 30;
  const ACCEL_RATE = 0.3; // speed increase per 100m
  const JUMP_VELOCITY = 12;
  const GRAVITY = 30;
  const SLIDE_DURATION = 1.0;
  const PLAYER_HEIGHT = 1.6;
  const PLAYER_SLIDE_HEIGHT = 0.5;

  // === Scene Setup ===
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a2e);
  scene.fog = new THREE.Fog(0x1a1a2e, 30, 80);

  const rect = runnerContainer.getBoundingClientRect();
  const W = rect.width || 750;
  const H = rect.height || 500;
  const camera = new THREE.PerspectiveCamera(65, W / H, 0.1, 150);
  camera.position.set(0, 5, 8);
  camera.lookAt(0, 1.5, -10);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(W, H);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  // === Lighting ===
  const ambientLight = new THREE.AmbientLight(0x404060, 1.2);
  scene.add(ambientLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
  dirLight.position.set(5, 15, 10);
  dirLight.castShadow = true;
  dirLight.shadow.camera.left = -15;
  dirLight.shadow.camera.right = 15;
  dirLight.shadow.camera.top = 15;
  dirLight.shadow.camera.bottom = -15;
  dirLight.shadow.camera.far = 60;
  dirLight.shadow.mapSize.width = 1024;
  dirLight.shadow.mapSize.height = 1024;
  scene.add(dirLight);

  // Hemisphere light for nice ambient
  const hemiLight = new THREE.HemisphereLight(0x6688cc, 0x223344, 0.6);
  scene.add(hemiLight);

  // === Track (ground) ===
  const trackMaterial = new THREE.MeshStandardMaterial({ color: 0x2d2d3d, roughness: 0.8, metalness: 0.1 });
  const laneDividerMat = new THREE.MeshStandardMaterial({ color: 0x4a4a6a, roughness: 0.5 });
  const trackSegments = [];

  function createTrackSegment(zPos) {
    const group = new THREE.Group();

    // Main ground
    const groundGeom = new THREE.BoxGeometry(LANE_WIDTH * 3 + 2, 0.2, TRACK_SEGMENT_LENGTH);
    const ground = new THREE.Mesh(groundGeom, trackMaterial);
    ground.position.y = -0.1;
    ground.receiveShadow = true;
    group.add(ground);

    // Lane dividers (white dashed lines)
    for (let i = -1; i <= 1; i += 2) {
      const x = i * LANE_WIDTH / 2;
      for (let dz = -TRACK_SEGMENT_LENGTH / 2 + 1; dz < TRACK_SEGMENT_LENGTH / 2; dz += 2.5) {
        const divGeom = new THREE.BoxGeometry(0.08, 0.22, 1.2);
        const div = new THREE.Mesh(divGeom, laneDividerMat);
        div.position.set(x, 0.01, dz);
        group.add(div);
      }
    }

    // Side walls (subtle)
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a3a5a, roughness: 0.9 });
    for (let side = -1; side <= 1; side += 2) {
      const wallGeom = new THREE.BoxGeometry(0.3, 0.6, TRACK_SEGMENT_LENGTH);
      const wall = new THREE.Mesh(wallGeom, wallMat);
      wall.position.set(side * (LANE_WIDTH * 1.5 + 1.15), 0.2, 0);
      group.add(wall);
    }

    group.position.z = zPos;
    scene.add(group);
    trackSegments.push(group);
    return group;
  }

  // Initial track segments
  for (let i = 0; i < TRACK_SEGMENTS_COUNT; i++) {
    createTrackSegment(-i * TRACK_SEGMENT_LENGTH);
  }

  // === Player ===
  const playerGroup = new THREE.Group();

  // Body (torso)
  const bodyGeom = new THREE.BoxGeometry(0.6, 0.9, 0.4);
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x4fc3f7 });
  const body = new THREE.Mesh(bodyGeom, bodyMat);
  body.position.y = 0.85;
  body.castShadow = true;
  playerGroup.add(body);

  // Head
  const headGeom = new THREE.SphereGeometry(0.25, 12, 8);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffcc88 });
  const head = new THREE.Mesh(headGeom, headMat);
  head.position.y = 1.55;
  head.castShadow = true;
  playerGroup.add(head);

  // Legs
  const legGeom = new THREE.BoxGeometry(0.22, 0.5, 0.25);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x1a237e });
  const leftLeg = new THREE.Mesh(legGeom, legMat);
  leftLeg.position.set(-0.18, 0.25, 0);
  leftLeg.castShadow = true;
  playerGroup.add(leftLeg);
  const rightLeg = new THREE.Mesh(legGeom, legMat);
  rightLeg.position.set(0.18, 0.25, 0);
  rightLeg.castShadow = true;
  playerGroup.add(rightLeg);

  // Arms
  const armGeom = new THREE.BoxGeometry(0.18, 0.55, 0.2);
  const armMat = new THREE.MeshStandardMaterial({ color: 0x4fc3f7 });
  const leftArm = new THREE.Mesh(armGeom, armMat);
  leftArm.position.set(-0.45, 0.85, 0);
  leftArm.castShadow = true;
  playerGroup.add(leftArm);
  const rightArm = new THREE.Mesh(armGeom, armMat);
  rightArm.position.set(0.45, 0.85, 0);
  rightArm.castShadow = true;
  playerGroup.add(rightArm);

  playerGroup.position.set(0, 0, 0);
  scene.add(playerGroup);

  // === Player State ===
  let currentLane = 1; // 0=left, 1=center, 2=right
  let targetX = LANES[currentLane];
  let playerY = 0;
  let velocityY = 0;
  let isJumping = false;
  let isSliding = false;
  let slideTimer = 0;
  let distance = 0;
  let coins = 0;
  let speed = BASE_SPEED;
  let gameOver = false;
  let running = true;

  // Leg animation
  let legAnimTime = 0;

  // === Obstacles ===
  const obstacles = [];
  const obstacleMaterials = {
    fence: new THREE.MeshStandardMaterial({ color: 0xff3333, roughness: 0.6 }),
    bar: new THREE.MeshStandardMaterial({ color: 0xff5500, roughness: 0.4, metalness: 0.3 }),
    train: new THREE.MeshStandardMaterial({ color: 0xcc2222, roughness: 0.5 }),
    trainRoof: new THREE.MeshStandardMaterial({ color: 0x991111, roughness: 0.5 }),
  };

  function createObstacle(type, lane, z) {
    const group = new THREE.Group();
    let hitbox = { w: 1.5, h: 1.6, d: 0.8 }; // default

    if (type === 'fence') {
      // Low fence - must jump over
      const fenceGeom = new THREE.BoxGeometry(1.8, 0.8, 0.2);
      const fence = new THREE.Mesh(fenceGeom, obstacleMaterials.fence);
      fence.position.y = 0.4;
      fence.castShadow = true;
      group.add(fence);
      // Posts
      const postGeom = new THREE.BoxGeometry(0.12, 0.9, 0.12);
      const lp = new THREE.Mesh(postGeom, obstacleMaterials.fence);
      lp.position.set(-0.8, 0.45, 0);
      group.add(lp);
      const rp = new THREE.Mesh(postGeom, obstacleMaterials.fence);
      rp.position.set(0.8, 0.45, 0);
      group.add(rp);
      hitbox = { w: 1.8, h: 0.9, d: 0.3 };
    } else if (type === 'bar') {
      // High bar - must slide under
      const barGeom = new THREE.CylinderGeometry(0.06, 0.06, 2, 8);
      const bar = new THREE.Mesh(barGeom, obstacleMaterials.bar);
      bar.rotation.z = Math.PI / 2;
      bar.position.y = 1.1;
      bar.castShadow = true;
      group.add(bar);
      // Support poles
      const poleGeom = new THREE.CylinderGeometry(0.08, 0.08, 1.1, 8);
      const lPole = new THREE.Mesh(poleGeom, obstacleMaterials.bar);
      lPole.position.set(-1, 0.55, 0);
      group.add(lPole);
      const rPole = new THREE.Mesh(poleGeom, obstacleMaterials.bar);
      rPole.position.set(1, 0.55, 0);
      group.add(rPole);
      hitbox = { w: 2, hMin: 0.7, hMax: 1.3, d: 0.3 };
    } else if (type === 'train') {
      // Subway car - blocks entire lane, must dodge
      const trainBody = new THREE.BoxGeometry(1.8, 2.2, 3);
      const train = new THREE.Mesh(trainBody, obstacleMaterials.train);
      train.position.y = 1.1;
      train.castShadow = true;
      group.add(train);
      // Roof
      const roofGeom = new THREE.BoxGeometry(1.9, 0.15, 3.1);
      const roof = new THREE.Mesh(roofGeom, obstacleMaterials.trainRoof);
      roof.position.y = 2.25;
      group.add(roof);
      // Windows
      const windowMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, emissive: 0x224466, roughness: 0.2, metalness: 0.5 });
      for (let wz = -1; wz <= 1; wz++) {
        const winGeom = new THREE.BoxGeometry(0.02, 0.5, 0.6);
        const win = new THREE.Mesh(winGeom, windowMat);
        win.position.set(0.91, 1.3, wz * 0.9);
        group.add(win);
        const win2 = new THREE.Mesh(winGeom, windowMat);
        win2.position.set(-0.91, 1.3, wz * 0.9);
        group.add(win2);
      }
      hitbox = { w: 1.8, h: 2.3, d: 3 };
    }

    group.position.set(LANES[lane], 0, z);
    group.userData = { type, lane, hitbox };
    scene.add(group);
    obstacles.push(group);
    return group;
  }

  // === Coins ===
  const coinObjects = [];
  const coinMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd700,
    emissive: 0xcc8800,
    emissiveIntensity: 0.4,
    roughness: 0.3,
    metalness: 0.8,
  });

  function createCoin(lane, z) {
    const coinGeom = new THREE.CylinderGeometry(0.3, 0.3, 0.08, 16);
    const coin = new THREE.Mesh(coinGeom, coinMaterial);
    coin.position.set(LANES[lane], 1.0, z);
    coin.rotation.x = Math.PI / 2;
    coin.castShadow = true;
    coin.userData = { lane, collected: false };
    scene.add(coin);
    coinObjects.push(coin);
    return coin;
  }

  // === Spawn System ===
  let lastObstacleZ = OBSTACLE_START_Z;
  let lastCoinZ = COIN_START_Z;

  function spawnObstacles() {
    const spawnDistance = Math.max(8, 14 - distance * 0.01);
    while (lastObstacleZ > distance * -1 - 80) {
      const lane = Math.floor(Math.random() * 3);
      const types = ['fence', 'bar', 'train'];
      const type = types[Math.floor(Math.random() * types.length)];
      createObstacle(type, lane, lastObstacleZ);
      lastObstacleZ -= spawnDistance + Math.random() * 5;
    }
  }

  function spawnCoins() {
    while (lastCoinZ > distance * -1 - 80) {
      const lane = Math.floor(Math.random() * 3);
      // Spawn a line of 3-5 coins
      const count = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        createCoin(lane, lastCoinZ - i * 1.5);
      }
      lastCoinZ -= 12 + Math.random() * 8;
    }
  }

  // Initial spawn
  spawnObstacles();
  spawnCoins();

  // === Joystick Control ===
  let joystickActive = false;
  let joystickStartX = 0;
  let joystickStartY = 0;
  let joystickDeltaX = 0;
  let joystickDeltaY = 0;
  let laneSwitchCooldown = 0;

  function onJoystickStart(e) {
    if (gameOver) return;
    e.preventDefault();
    joystickActive = true;
    const pos = e.touches ? e.touches[0] : e;
    joystickStartX = pos.clientX;
    joystickStartY = pos.clientY;
    joystickDeltaX = 0;
    joystickDeltaY = 0;
  }

  function onJoystickMove(e) {
    if (!joystickActive || gameOver) return;
    e.preventDefault();
    const pos = e.touches ? e.touches[0] : e;
    const maxDist = 35;
    let dx = pos.clientX - joystickStartX;
    let dy = pos.clientY - joystickStartY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxDist) {
      dx = dx / dist * maxDist;
      dy = dy / dist * maxDist;
    }
    joystickDeltaX = dx;
    joystickDeltaY = dy;
    knobEl.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';

    // Lane switch on strong horizontal swipe
    if (laneSwitchCooldown <= 0) {
      if (dx > 20 && currentLane < 2) {
        currentLane++;
        targetX = LANES[currentLane];
        laneSwitchCooldown = 0.25;
      } else if (dx < -20 && currentLane > 0) {
        currentLane--;
        targetX = LANES[currentLane];
        laneSwitchCooldown = 0.25;
      }
    }

    // Jump on upward swipe
    if (dy < -25 && !isJumping && !isSliding) {
      velocityY = JUMP_VELOCITY;
      isJumping = true;
    }
  }

  function onJoystickEnd(e) {
    if (e) e.preventDefault();
    joystickActive = false;
    joystickDeltaX = 0;
    joystickDeltaY = 0;
    knobEl.style.transform = 'translate(0px, 0px)';
  }

  joystickEl.addEventListener('mousedown', onJoystickStart);
  joystickEl.addEventListener('touchstart', onJoystickStart, { passive: false });
  document.addEventListener('mousemove', onJoystickMove);
  document.addEventListener('touchmove', onJoystickMove, { passive: false });
  document.addEventListener('mouseup', onJoystickEnd);
  document.addEventListener('touchend', onJoystickEnd);

  // === Slide Button ===
  function onSlide() {
    if (gameOver || isSliding || isJumping) return;
    isSliding = true;
    slideTimer = SLIDE_DURATION;
  }
  slideBtn.addEventListener('mousedown', onSlide);
  slideBtn.addEventListener('touchstart', function(e) { e.preventDefault(); onSlide(); }, { passive: false });

  // === Restart ===
  function onRestart() {
    // Reset everything
    distance = 0;
    coins = 0;
    speed = BASE_SPEED;
    currentLane = 1;
    targetX = LANES[1];
    playerY = 0;
    velocityY = 0;
    isJumping = false;
    isSliding = false;
    slideTimer = 0;
    gameOver = false;

    // Remove obstacles
    obstacles.forEach(o => scene.remove(o));
    obstacles.length = 0;
    // Remove coins
    coinObjects.forEach(c => scene.remove(c));
    coinObjects.length = 0;

    // Reset spawn
    lastObstacleZ = OBSTACLE_START_Z;
    lastCoinZ = COIN_START_Z;
    spawnObstacles();
    spawnCoins();

    // Reset track
    trackSegments.forEach(s => scene.remove(s));
    trackSegments.length = 0;
    for (let i = 0; i < TRACK_SEGMENTS_COUNT; i++) {
      createTrackSegment(-i * TRACK_SEGMENT_LENGTH);
    }

    playerGroup.position.set(0, 0, 0);
    playerGroup.scale.set(1, 1, 1);

    gameOverEl.style.display = 'none';
    hudDistance.textContent = '距离: 0m';
    hudCoins.textContent = '金币: 0';
  }
  restartBtn.addEventListener('click', onRestart);

  // === Keyboard Controls ===
  const keys = {};
  let kbLaneCooldown = 0;

  function onKeyDown(e) {
    if (gameOver) {
      if (e.key === ' ' || e.key === 'Enter') onRestart();
      return;
    }
    keys[e.key.toLowerCase()] = true;

    if ((e.key === 'a' || e.key === 'ArrowLeft') && currentLane > 0 && kbLaneCooldown <= 0) {
      currentLane--;
      targetX = LANES[currentLane];
      kbLaneCooldown = 0.2;
    }
    if ((e.key === 'd' || e.key === 'ArrowRight') && currentLane < 2 && kbLaneCooldown <= 0) {
      currentLane++;
      targetX = LANES[currentLane];
      kbLaneCooldown = 0.2;
    }
    if ((e.key === 'w' || e.key === 'ArrowUp' || e.key === ' ') && !isJumping && !isSliding) {
      velocityY = JUMP_VELOCITY;
      isJumping = true;
    }
    if ((e.key === 's' || e.key === 'ArrowDown') && !isSliding && !isJumping) {
      isSliding = true;
      slideTimer = SLIDE_DURATION;
    }
  }

  function onKeyUp(e) {
    keys[e.key.toLowerCase()] = false;
  }

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  // === Collision Detection ===
  function checkCollisions() {
    const px = playerGroup.position.x;
    const py = playerY;
    const pz = playerGroup.position.z;

    // Player hitbox (simplified)
    const pH = isSliding ? PLAYER_SLIDE_HEIGHT : PLAYER_HEIGHT;
    const pMinX = px - 0.3;
    const pMaxX = px + 0.3;
    const pMinY = py;
    const pMaxY = py + pH;
    const pMinZ = pz - 0.2;
    const pMaxZ = pz + 0.2;

    for (let i = obstacles.length - 1; i >= 0; i--) {
      const obs = obstacles[i];
      const hb = obs.userData.hitbox;
      const ox = obs.position.x;
      const oz = obs.position.z;

      if (obs.userData.type === 'bar') {
        // Bar: only collision if player is tall (not sliding)
        const oMinX = ox - hb.w / 2;
        const oMaxX = ox + hb.w / 2;
        const oMinZ = oz - hb.d / 2;
        const oMaxZ = oz + hb.d / 2;

        if (pMaxX > oMinX && pMinX < oMaxX && pMaxZ > oMinZ && pMinZ < oMaxZ) {
          // Player overlaps bar horizontally
          if (pMaxY > hb.hMin && pMinY < hb.hMax) {
            // Hit! (only if not sliding under)
            return true;
          }
        }
      } else {
        // Fence / Train: standard AABB
        const oMinX = ox - hb.w / 2;
        const oMaxX = ox + hb.w / 2;
        const oMinY = 0;
        const oMaxY = hb.h;
        const oMinZ = oz - hb.d / 2;
        const oMaxZ = oz + hb.d / 2;

        if (pMaxX > oMinX && pMinX < oMaxX &&
            pMaxY > oMinY && pMinY < oMaxY &&
            pMaxZ > oMinZ && pMinZ < oMaxZ) {
          return true;
        }
      }
    }
    return false;
  }

  // === Coin Collection ===
  function checkCoinCollection() {
    const px = playerGroup.position.x;
    const pz = playerGroup.position.z;

    for (let i = coinObjects.length - 1; i >= 0; i--) {
      const coin = coinObjects[i];
      if (coin.userData.collected) continue;
      const dx = px - coin.position.x;
      const dz = pz - coin.position.z;
      if (Math.abs(dx) < 0.8 && Math.abs(dz) < 0.8) {
        coin.userData.collected = true;
        scene.remove(coin);
        coinObjects.splice(i, 1);
        coins++;
      }
    }
  }

  // === Game Over ===
  function triggerGameOver() {
    gameOver = true;
    finalScoreEl.textContent = '距离: ' + Math.floor(distance) + 'm · 金币: ' + coins;
    gameOverEl.style.display = 'flex';
  }

  // === Main Loop ===
  let lastTime = performance.now();

  function gameLoop(time) {
    if (!running) return;
    gameAnimationId = requestAnimationFrame(gameLoop);

    const dt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    if (gameOver) {
      renderer.render(scene, camera);
      return;
    }

    // === Update Speed ===
    speed = Math.min(MAX_SPEED, BASE_SPEED + distance * ACCEL_RATE / 100);

    // === Move Player Forward (actually move world backward) ===
    const moveZ = speed * dt;
    distance += moveZ;

    // Move all world objects toward the player
    trackSegments.forEach(seg => { seg.position.z += moveZ; });
    obstacles.forEach(obs => { obs.position.z += moveZ; });
    coinObjects.forEach(c => { c.position.z += moveZ; });

    // === Recycle Track Segments ===
    if (trackSegments.length > 0 && trackSegments[0].position.z > TRACK_SEGMENT_LENGTH) {
      const old = trackSegments.shift();
      scene.remove(old);
      const lastZ = trackSegments[trackSegments.length - 1].position.z;
      createTrackSegment(lastZ - TRACK_SEGMENT_LENGTH);
    }

    // === Spawn New Obstacles & Coins ===
    // Adjust spawn positions based on distance
    const worldFrontZ = -60;
    if (obstacles.length === 0 || obstacles[obstacles.length - 1].position.z > -40) {
      const spawnDist = Math.max(8, 14 - distance * 0.008);
      const lane = Math.floor(Math.random() * 3);
      const types = ['fence', 'bar', 'train'];
      const type = types[Math.floor(Math.random() * types.length)];
      const lastOZ = obstacles.length > 0 ? obstacles[obstacles.length - 1].position.z : -40;
      createObstacle(type, lane, lastOZ - spawnDist - Math.random() * 5);
    }

    if (coinObjects.length < 15) {
      const lane = Math.floor(Math.random() * 3);
      const lastCZ = coinObjects.length > 0 ? coinObjects[coinObjects.length - 1].position.z : -40;
      const count = 3 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        createCoin(lane, lastCZ - 15 - i * 1.5);
      }
    }

    // === Clean Up Far Objects ===
    for (let i = obstacles.length - 1; i >= 0; i--) {
      if (obstacles[i].position.z > 15) {
        scene.remove(obstacles[i]);
        obstacles.splice(i, 1);
      }
    }
    for (let i = coinObjects.length - 1; i >= 0; i--) {
      if (coinObjects[i].position.z > 15) {
        scene.remove(coinObjects[i]);
        coinObjects.splice(i, 1);
      }
    }

    // === Player Lateral Movement (smooth) ===
    playerGroup.position.x += (targetX - playerGroup.position.x) * Math.min(1, dt * 12);

    // === Jump Physics ===
    if (isJumping) {
      velocityY -= GRAVITY * dt;
      playerY += velocityY * dt;
      if (playerY <= 0) {
        playerY = 0;
        velocityY = 0;
        isJumping = false;
      }
    }
    playerGroup.position.y = playerY;

    // === Slide ===
    if (isSliding) {
      slideTimer -= dt;
      // Squash the player model
      playerGroup.scale.y = 0.35;
      playerGroup.position.y = playerY;
      if (slideTimer <= 0) {
        isSliding = false;
        playerGroup.scale.y = 1;
      }
    }

    // === Leg Animation ===
    if (!isJumping && !isSliding) {
      legAnimTime += dt * speed * 0.8;
      leftLeg.rotation.x = Math.sin(legAnimTime) * 0.5;
      rightLeg.rotation.x = Math.sin(legAnimTime + Math.PI) * 0.5;
      leftArm.rotation.x = Math.sin(legAnimTime + Math.PI) * 0.4;
      rightArm.rotation.x = Math.sin(legAnimTime) * 0.4;
    } else {
      leftLeg.rotation.x = 0;
      rightLeg.rotation.x = 0;
      leftArm.rotation.x = 0;
      rightArm.rotation.x = 0;
    }

    // === Rotate Coins ===
    coinObjects.forEach(c => {
      c.rotation.y += dt * 3;
    });

    // === Cooldowns ===
    if (laneSwitchCooldown > 0) laneSwitchCooldown -= dt;
    if (kbLaneCooldown > 0) kbLaneCooldown -= dt;

    // === Collision Check ===
    if (checkCollisions()) {
      triggerGameOver();
    }

    // === Coin Collection ===
    checkCoinCollection();

    // === Camera Follow (third-person chase) ===
    const camTargetX = playerGroup.position.x * 0.6;
    const camTargetY = 4 + playerY * 0.3;
    camera.position.x += (camTargetX - camera.position.x) * dt * 5;
    camera.position.y += (camTargetY - camera.position.y) * dt * 4;
    camera.lookAt(playerGroup.position.x * 0.3, 1.5, playerGroup.position.z - 15);

    // === Update DirectionalLight position to follow player ===
    dirLight.position.x = playerGroup.position.x + 5;
    dirLight.target.position.x = playerGroup.position.x;
    dirLight.target.updateMatrixWorld();

    // === Update HUD ===
    hudDistance.textContent = '距离: ' + Math.floor(distance) + 'm';
    hudCoins.textContent = '金币: ' + coins;

    // === Render ===
    renderer.render(scene, camera);
  }

  gameAnimationId = requestAnimationFrame(gameLoop);

  // === Resize Handler ===
  function onResize() {
    const r = runnerContainer.getBoundingClientRect();
    const w = r.width || 750;
    const h = r.height || 500;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', onResize);

  // === Cleanup Function ===
  window._runnerCleanup = function() {
    running = false;
    if (gameAnimationId) {
      cancelAnimationFrame(gameAnimationId);
      gameAnimationId = null;
    }

    // Remove event listeners
    joystickEl.removeEventListener('mousedown', onJoystickStart);
    joystickEl.removeEventListener('touchstart', onJoystickStart);
    document.removeEventListener('mousemove', onJoystickMove);
    document.removeEventListener('touchmove', onJoystickMove);
    document.removeEventListener('mouseup', onJoystickEnd);
    document.removeEventListener('touchend', onJoystickEnd);
    slideBtn.removeEventListener('mousedown', onSlide);
    restartBtn.removeEventListener('click', onRestart);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('resize', onResize);

    // Dispose Three.js resources
    renderer.dispose();
    while (container.firstChild) container.removeChild(container.firstChild);

    // Clear arrays
    obstacles.length = 0;
    coinObjects.length = 0;
    trackSegments.length = 0;
  };
}

// 全局暴露函数（供 HTML onclick 调用）
window.toggleConnection = toggleConnection;
window.sendData = sendData;
window.clearTerminal = clearTerminal;
window.toggleAutoScroll = toggleAutoScroll;
window.toggleSerialOutput = toggleSerialOutput;
window.openInNewWindow = openInNewWindow;
window.toggleSerialPanel = toggleSerialPanel;
window.toggleBleConnection = toggleBleConnection;
window.serialPorts = serialPorts;

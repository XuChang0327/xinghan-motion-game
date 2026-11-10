import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// dev 模式下按请求实时生成 /firmware.js：内嵌 firmware 源码（.py），
// 改了 hardware_main.py / device_main.py 刷新页面即生效，无需手动构建。
// 生产（publish）用 scripts/build-firmware.js 生成静态 firmware.js。
const FIRMWARE_FILES = ['hardware_main.py', 'device_main.py'];

function firmwareEmbedPlugin() {
  return {
    name: 'firmware-embed',
    configureServer(server) {
      server.middlewares.use('/firmware.js', (req, res) => {
        try {
          const files = {};
          for (const f of FIRMWARE_FILES) {
            files[f] = readFileSync(resolve(server.config.root, f), 'utf-8');
          }
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end('// dev 实时生成（vite firmware-embed 插件）\nwindow.FIRMWARE_FILES = '
            + JSON.stringify(files) + ';\n');
        } catch (e) {
          res.statusCode = 500;
          res.end('// firmware-embed 生成失败: ' + e.message + '\nwindow.FIRMWARE_FILES = {};\n');
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [firmwareEmbedPlugin()],
  server: {
    host: true, // 必需：允许外部访问
    allowedHosts: true, // 必需：跳过 Host Header 检查
    port: 8000,
  },
});

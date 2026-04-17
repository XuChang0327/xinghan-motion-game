// HMR Bridge - 监控 Vite 热更新状态
if (window.parent !== window && import.meta.hot) {
  console.log('[HMR Bridge] ✅ 已启用');

  import.meta.hot.on('vite:beforeUpdate', () => {
    window.parent.postMessage(
      {
        type: 'vite:hmr-update',
        timestamp: Date.now(),
      },
      '*'
    );
  });
}

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('continuumNative', {
  isDesktopApp: true,
  platform: process.platform,
  version: '1.2.0',
});

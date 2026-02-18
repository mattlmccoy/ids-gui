const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serialPicker', {
  onPortList: (handler) => {
    ipcRenderer.removeAllListeners('serial-port-list');
    ipcRenderer.on('serial-port-list', (_evt, ports) => handler(ports));
  },
  selectPort: (portId) => ipcRenderer.send('serial-port-select', { portId }),
  cancel: () => ipcRenderer.send('serial-port-cancel')
});

contextBridge.exposeInMainWorld('inkDataAPI', {
  loadDefault: () => ipcRenderer.invoke('ink-data-load-default'),
  saveDefault: (payload) => ipcRenderer.invoke('ink-data-save-default', payload),
  importJson: () => ipcRenderer.invoke('ink-data-import-json'),
  exportJson: (payload) => ipcRenderer.invoke('ink-data-export-json', payload)
});

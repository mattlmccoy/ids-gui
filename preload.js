const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serialPicker', {
  onPortList: (handler) => {
    ipcRenderer.removeAllListeners('serial-port-list');
    ipcRenderer.on('serial-port-list', (_evt, ports) => handler(ports));
  },
  selectPort: (portId) => ipcRenderer.send('serial-port-select', { portId }),
  cancel: () => ipcRenderer.send('serial-port-cancel')
});

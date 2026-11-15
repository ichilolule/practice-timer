'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Expose only timer operations; the page never receives filesystem or Node access.
contextBridge.exposeInMainWorld('practiceDesktop', {
  loadState: () => ipcRenderer.sendSync('desktop:load'),
  saveState: value => ipcRenderer.sendSync('desktop:save', value),
  publish: state => ipcRenderer.send('desktop:state', state),
  onCommand: callback => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('desktop:command', listener);
    return () => ipcRenderer.removeListener('desktop:command', listener);
  },
  finishQuit: ok => ipcRenderer.send('desktop:quit-result', ok),
  settings: () => ipcRenderer.invoke('desktop:settings'),
  sounds: () => ipcRenderer.invoke('desktop:sounds'),
  playSound: (id, volume) => ipcRenderer.invoke('desktop:play-sound', id, volume),
  setShortcuts: value => ipcRenderer.invoke('desktop:shortcuts', value),
  recordShortcut: active => ipcRenderer.send('desktop:shortcut-recording', active),
  notify: (phase, minutes, overtime) => ipcRenderer.send('desktop:notify', phase, minutes, overtime),
  exportJSON: value => ipcRenderer.invoke('desktop:export', value),
  pickBackup: () => ipcRenderer.invoke('desktop:backup-pick'),
  readBackupTargets: () => ipcRenderer.invoke('desktop:backup-targets'),
  writeBackupTargets: value => ipcRenderer.invoke('desktop:backup-remember', value),
  readBackup: id => ipcRenderer.invoke('desktop:backup-read', id),
  writeBackup: (id, value, expected) => ipcRenderer.invoke('desktop:backup-write', id, value, expected),
});

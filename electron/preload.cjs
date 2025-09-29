
const { contextBridge, ipcRenderer } = require('electron');

const api = {
  runSundayPrep: (payload) => ipcRenderer.invoke('run-sunday-prep', payload),
  testProPresenter: (payload) => ipcRenderer.invoke('pp-test', payload),
  pcoSaveAndTest: (payload) => ipcRenderer.invoke('pco-save-and-test', payload),
  pcoTest: () => ipcRenderer.invoke('pco-test'),
  pcoGetNextPlan: () => ipcRenderer.invoke('pco-next-plan'),
  ppMatch: (payload) => ipcRenderer.invoke('pp-match', payload),
  ppSyncPlaylist: (payload) => ipcRenderer.invoke('pp-sync-playlist', payload),
  ppFindLibraryRoot: () => ipcRenderer.invoke('pp-find-library-root'),
  ppIndexPresentations: (payload) => ipcRenderer.invoke('pp-index-presentations', payload),
  ppWriteOperatorNotesFile: (payload) => ipcRenderer.invoke('pp-write-operator-notes-file', payload),
  ppIndexPresentationsUuid: (payload) => ipcRenderer.invoke('pp-index-presentations-uuid', payload),
  ppRunPresentationSync: (payload) => ipcRenderer.invoke('pp-run-presentation-sync', payload),
  ppIsRunning: () => ipcRenderer.invoke('pp-is-running'),
  appBootComplete: () => ipcRenderer.invoke('app-boot-complete'),
  onLog: (cb) => {
    const listener = (_e, line) => cb(line);
    ipcRenderer.on('log', listener);
    return () => ipcRenderer.removeListener('log', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);

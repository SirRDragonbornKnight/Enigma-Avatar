// Bridges the avatar's hit-test to the Electron main process: the renderer calls
// window.avatarIPC.setInteractive(true) when the cursor is over the model, so
// main can let the click land on the avatar — and pass clicks THROUGH to the
// desktop everywhere else.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("avatarIPC", {
  setInteractive: (over) => ipcRenderer.send("avatar:interactive", !!over),
  quit: () => ipcRenderer.send("avatar:quit"),
  // Open a native file dialog and import the chosen model into models/ (also
  // handles .unitypackage via import_unitypackage.py). Resolves to {id,label,url},
  // null (cancelled), or {error}. See main.js.
  importModel: () => ipcRenderer.invoke("avatar:importModel"),
  importProp: () => ipcRenderer.invoke("avatar:importProp"),
  saveProfiles: (json) => ipcRenderer.invoke("avatar:saveProfiles", json),
});

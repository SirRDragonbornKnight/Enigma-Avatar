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
  // Capture the overlay canvas (avatar in isolation) to a PNG for inspection.
  capture: (opts) => ipcRenderer.invoke("avatar:capture", opts || {}),
  // Move the overlay to a given monitor (index into the display list).
  setDisplay: (i) => ipcRenderer.send("avatar:setDisplay", i),
  // Drag-hop variant: move to a monitor WITHOUT recentering (used while dragging across an edge).
  setDisplayDrag: (i) => ipcRenderer.send("avatar:setDisplayDrag", i),
  // List monitors for the "Move to monitor" menu: { current, displays:[{index,label,primary,…}] }.
  getDisplays: () => ipcRenderer.invoke("avatar:getDisplays"),
  // Fire when the overlay hops monitors (hotkey/menu/layout change) so the menu re-ticks.
  onDisplayChanged: (cb) => ipcRenderer.on("avatar:displayChanged", (_e, info) => cb(info)),
  // Fire after a monitor move so the renderer can recenter the avatar (keeps it on-screen).
  onCenter: (cb) => ipcRenderer.on("avatar:center", () => cb()),
});

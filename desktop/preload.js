// Gives Roost's page the one native thing it can't do in a browser: a folder picker (for the phone
// sync folder). Nothing else from Node or Electron is exposed.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("roostDesktop", {
  pickFolder: (title, defaultPath) => ipcRenderer.invoke("roost:pick-folder", { title: String(title || ""), defaultPath: String(defaultPath || "") }),
});

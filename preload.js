// 预加载脚本：在 contextIsolation 下向渲染进程暴露最小化 API。
// 目前只有一个能力：把导出的 HTML 交给主进程打印成 PDF。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pdfApi", {
  exportPdf: (payload) => ipcRenderer.invoke("export-pdf", payload),
});

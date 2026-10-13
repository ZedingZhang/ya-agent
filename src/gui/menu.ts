import { Menu, type MenuItemConstructorOptions } from "electron";
import type { Language } from "./controller";

function applicationMenuTemplate(language: Language): MenuItemConstructorOptions[] {
  const label = (english: string, chinese: string): string => language === "zh-CN" ? chinese : english;
  return [
    {
      label: "Ya",
      submenu: [
        { role: "about", label: label("About Ya", "关于 Ya") },
        { type: "separator" },
        { role: "services", label: label("Services", "服务") },
        { type: "separator" },
        { role: "hide", label: label("Hide Ya", "隐藏 Ya") },
        { role: "hideOthers", label: label("Hide Others", "隐藏其他应用") },
        { role: "unhide", label: label("Show All", "全部显示") },
        { type: "separator" },
        { role: "quit", label: label("Quit Ya", "退出 Ya") },
      ],
    },
    {
      label: label("File", "文件"),
      submenu: [{ role: "close", label: label("Close Window", "关闭窗口") }],
    },
    {
      label: label("Edit", "编辑"),
      submenu: [
        { role: "undo", label: label("Undo", "撤销") },
        { role: "redo", label: label("Redo", "重做") },
        { type: "separator" },
        { role: "cut", label: label("Cut", "剪切") },
        { role: "copy", label: label("Copy", "复制") },
        { role: "paste", label: label("Paste", "粘贴") },
        { role: "pasteAndMatchStyle", label: label("Paste and Match Style", "粘贴并匹配样式") },
        { role: "delete", label: label("Delete", "删除") },
        { role: "selectAll", label: label("Select All", "全选") },
      ],
    },
    {
      label: label("View", "视图"),
      submenu: [
        { role: "reload", label: label("Reload", "重新载入") },
        { role: "forceReload", label: label("Force Reload", "强制重新载入") },
        { role: "toggleDevTools", label: label("Toggle Developer Tools", "切换开发者工具") },
        { type: "separator" },
        { role: "resetZoom", label: label("Actual Size", "实际大小") },
        { role: "zoomIn", label: label("Zoom In", "放大") },
        { role: "zoomOut", label: label("Zoom Out", "缩小") },
        { type: "separator" },
        { role: "togglefullscreen", label: label("Toggle Full Screen", "切换全屏") },
      ],
    },
    {
      role: "windowMenu",
      label: label("Window", "窗口"),
      submenu: [
        { role: "minimize", label: label("Minimize", "最小化") },
        { role: "zoom", label: label("Zoom", "缩放") },
        { type: "separator" },
        { role: "front", label: label("Bring All to Front", "前置全部窗口") },
      ],
    },
  ];
}

export function installApplicationMenu(language: Language): void {
  Menu.setApplicationMenu(process.platform === "darwin" ? Menu.buildFromTemplate(applicationMenuTemplate(language)) : null);
}

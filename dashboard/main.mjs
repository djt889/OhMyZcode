#!/usr/bin/env node
/**
 * OMZ dashboard 的 Electron 包装——**可选路径**（DESIGN §1.5 结论 4 / §3.3 dashboard profile / §13.5 I5）。
 *
 * 设计取舍：Electron 是可选依赖，本文件用动态 import('electron') 探测。
 * 不可用时不崩、不退出，而是打印「Electron 不可用，请改用浏览器访问 <url>」并继续以纯 HTTP 模式
 * 提供服务——这就是 §15.3-5 故障隔离在展示层的落点：GUI 壳失效只降级为浏览器访问，不影响调度，
 * 也不影响 core profile 的 /omz-status 回退。
 *
 * BrowserWindow 安全配置（I5）：contextIsolation / 关 nodeIntegration / sandbox / webSecurity 全开。
 * **没有 preload、也没有任何 IPC 通道**：renderer 不需要主进程数据——页面由 loopback HTTP 服务提供，
 * token 走地址栏 query，全部数据由 renderer 自己经 `/api/*` GET 取得。因此 CSP、token、CORS 白名单与纯浏览器
 * 模式完全一致，不存在「Electron 里更宽松」的第二套规则；这个壳就是个只能访问本服务的浏览器窗口。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, parseArgs, bannerLines } from './server.mjs';

/** 探测 Electron。返回 { ok, mod|error }；任何失败都只是「可用性为 false」，不是异常。 */
export async function probeElectron() {
  try {
    const mod = await import('electron');
    // 以 CLI 方式（node main.mjs）加载 electron 包时，默认导出是可执行文件路径字符串而非 API 对象。
    const api = mod?.default ?? mod;
    if (!api || typeof api !== 'object' || !api.app || !api.BrowserWindow) {
      return { ok: false, error: '未在 Electron 运行时中（import("electron") 未返回 app/BrowserWindow）' };
    }
    return { ok: true, mod: api };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * BrowserWindow 选项。刻意**不设 preload**：
 * `sandbox: true` 下 Electron 把 preload 当普通脚本（非 ESM 上下文）加载，ESM preload 仅在 unsandboxed 下可用
 * （官方文档：“Sandboxed preload scripts can't use ESM imports”）。此前这里挂着一个 `preload.mjs`，
 * 两个配置互相排斥，而 renderer 侧对它暴露的 `omzDashboard.getBootInfo()` **零引用**——那是死代码，
 * 却被 I5 清单当成"已有的安全防护"。与其把它改成 CJS 留着，不如删掉：没有 preload 就没有
 * contextBridge 面，也就没有可被误用的 IPC 入口。将来若真需要主进程数据，再引入 `preload.cjs`
 * 并在 I5 清单里同步登记暴露面。
 */
export function windowOptions() {
  return {
    width: 1180,
    height: 800,
    backgroundColor: '#0d1117',
    title: 'OMZ 状态面板（只读）',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,   // 保持开启：即便无 preload，也不让页面脚本碰到 Electron 内部上下文
      nodeIntegration: false,   // renderer 里没有 require/process
      sandbox: true,            // renderer 进程受 OS 沙箱约束
      webSecurity: true,        // 同源策略与 CSP 生效
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: false
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const handle = createServer({ projectRoot: args.projectRoot, dbPath: args.dbPath, port: args.port });
  await handle.listen();
  const url = handle.urlOf('/');
  for (const l of bannerLines(handle, path.resolve(args.projectRoot))) process.stderr.write(l + '\n');

  const shutdown = () => {
    process.stderr.write('[omz-dashboard] 正在优雅关闭…\n');
    handle.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const probe = await probeElectron();
  if (!probe.ok) {
    process.stderr.write(`[omz-dashboard] Electron 不可用，请改用浏览器访问 ${url}\n`);
    process.stderr.write(`[omz-dashboard] 原因: ${probe.error}\n`);
    process.stderr.write('[omz-dashboard] 已以纯 HTTP 模式继续运行（功能等价，仅少一个 GUI 壳）。\n');
    return; // 不退出：server 句柄保持事件循环存活
  }

  const { app, BrowserWindow } = probe.mod;

  await app.whenReady();
  // URL 已含 token（urlOf 拼 ?token=），renderer 从 location.search 取——无需 preload 交接启动信息。
  const win = new BrowserWindow(windowOptions());
  // 只允许加载本服务的 loopback URL；任何外部导航/新窗口一律拒绝。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(`http://127.0.0.1:${handle.port}/`)) e.preventDefault();
  });
  await win.loadURL(url);

  app.on('window-all-closed', () => {
    handle.close().then(() => app.quit());
  });
}

// 与 server.mjs 同因：new URL(import.meta.url).pathname 是 percent-encoded，
// 含空格/非 ASCII 的安装目录下会让 isMain 恒为 false（CLI 静默不启动）。用 fileURLToPath。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[omz-dashboard] main 启动失败: ${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
}

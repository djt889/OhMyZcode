---
name: omz-status
description: "OMZ 状态看板：渲染 .omz/ 的波次×任务×状态（40 行上限，超出聚合）"
---

# OMZ 状态看板

以下内联执行块在命令展开时直接渲染当前项目 `.omz/` 状态（以文件为准，B8）。渲染器优先取插件内 `tools/render-status.mjs`；找不到时退化为内嵌的最小渲染逻辑（BOM 容错 + 40 行截断同样生效）。

```!
node -e "const fs=require('fs'),path=require('path');const root=path.resolve(process.cwd(),'.omz');function readJson(p){try{return JSON.parse(fs.readFileSync(p,'utf8').replace(/^﻿/,''))}catch(e){return null}}function ls(p){try{return fs.readdirSync(p,{withFileTypes:true})}catch(e){return[]}}const lines=[];const b=readJson(path.join(root,'boulder.json'));if(b)lines.push('[boulder] active_goal='+(b.active_goal||'-')+' active_plan='+(b.active_plan||'-')+' team='+(b.active_team||'-')+' status='+(b.status||'-'));for(const e of ls(path.join(root,'goal'))){if(!e.isFile()||!e.name.endsWith('.json'))continue;const g=readJson(path.join(root,'goal',e.name));if(!g){lines.push('[goal] '+e.name+' [corrupt]');continue}const sc=Array.isArray(g.binary_success_criteria)?g.binary_success_criteria:[];const d=sc.filter(s=>s.status==='done').length;lines.push('[goal] '+e.name+' SC '+d+'/'+sc.length+' '+(g.outcome||'').slice(0,60))}for(const t of ls(path.join(root,'runtime'))){if(!t.isDirectory())continue;lines.push('[team] '+t.name);const rows=[];for(const f of ls(path.join(root,'runtime',t.name,'tasks'))){if(!f.isFile()||!f.name.endsWith('.json'))continue;const tk=readJson(path.join(root,'runtime',t.name,'tasks',f.name));if(!tk){rows.push('  ? | '+f.name+' | corrupt | [corrupt]');continue}rows.push('  '+(tk.wave||'?')+' | '+(tk.id||f.name)+' | '+(tk.status||'?')+' | '+(tk.title||'').slice(0,34))}rows.sort();lines.push('  wave | task | status | title',...rows)}for(const e of ls(path.join(root,'plans'))){if(e.isFile()&&e.name.endsWith('.md'))lines.push('[plan] '+e.name)}if(lines.length===0)lines.push('(omz: 无状态——.omz/ 为空或不存在)');const MAX=40;if(lines.length<=MAX){console.log(lines.join('\n'))}else{console.log(lines.slice(0,MAX-1).join('\n'));console.log('…(聚合省略 '+(lines.length-MAX+1)+' 行;总量 '+lines.length+')')}"
```

若上面块因插件目录路径差异等原因失败，主 agent 可手动执行 `node <插件目录>/tools/render-status.mjs` 兜底。**两路输出不保证逐字一致**：上面的内联块是兜底最小实现，goal 行字段顺序、任务排序等细节可能与 `tools/render-status.mjs` 略有差异；**以 render-status.mjs 的输出为准**。

## 阅读规则（写给主 agent）

- 此表是**唯一事实源**的投影：波次推进只看这里的 status，不看后台通知（B8）。
- `[corrupt]` 行 = JSON 损坏或 BOM 污染（B4）：立即修复该文件，不要让带毒状态继续传播。
- 表为空但你确信有活跃工作：先查 `.omz/boulder.json` 的 `active_goal`——它是跨会话找回 goal 的**唯一权威指针**（B18）。goal 文件名可能是真实 sessionId，也可能是 `/ulw` 第零步的回退形态 `<ISO 时间戳>-<git HEAD 短哈希>`；两种都正常，**不要按当前 sessionId 反推文件名**（你拿不到 sessionId）。

import { launch, makeRunner } from "./cdp.mjs";
import { readFileSync } from "node:fs";
const b = await launch({headless:true, width:1300, height:1000});
const {send,evalJs,waitFor} = makeRunner(b.cdp);
const errs=[];
try{
  await send("Page.enable"); await send("Runtime.enable");
  b.cdp.on(m=>{ if(m.method==="Runtime.exceptionThrown") errs.push("EXC "+(m.params?.exceptionDetails?.exception?.description||m.params?.exceptionDetails?.text)); });
  await send("Page.navigate",{url:"http://127.0.0.1:4173/"});
  await waitFor("document.querySelector('#status-text')?.textContent.includes('就绪')", 40000, "库就绪");
  let ok = 0, bad = [];
  for (let id = 1; id <= 17; id++) {
    const wav = readFileSync(new URL(`../data/sounds/${id}.wav`, import.meta.url)).toString("base64");
    await evalJs(`(async()=>{
      const bin = atob(${JSON.stringify(wav)});
      const u8 = new Uint8Array(bin.length);
      for (let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
      const dt = new DataTransfer();
      dt.items.add(new File([u8], "${id}.wav", {type:"audio/wav"}));
      document.querySelector("#dropzone").dispatchEvent(new DragEvent("drop",{bubbles:true, dataTransfer:dt}));
      return true;
    })()`);
    await waitFor(`document.querySelector('#result-meta')?.textContent?.includes('${id}.wav')`, 15000, "结果"+id);
    const r = await evalJs(`(async()=>{
      const t = document.querySelector('.best-title').textContent;
      const c = document.querySelector('.verdict').textContent;
      const n = document.querySelectorAll('.codex-in-result .item').length;
      const imgs = [...document.querySelectorAll('.codex-in-result .item-img')];
      await new Promise(r=>setTimeout(r,250));
      const loaded = imgs.filter(i=>i.naturalWidth>0).length;
      return JSON.stringify({t,c,n,total:imgs.length,loaded});
    })()`);
    const o = JSON.parse(r);
    const hit = o.t.includes(`拾取音效 ${String(id).padStart(2,"0")}`);
    const thumbOk = o.total === 0 || o.loaded === o.total;
    if (hit && o.c === "高度匹配" && thumbOk) ok++; else bad.push({id, ...o, hit, thumbOk});
  }
  console.log(`自识别 17 段：${ok}/17 通过`);
  if (bad.length) console.log("失败项：", JSON.stringify(bad, null, 1));
  console.log("errors:", errs.length?errs:"none");
} finally { await b.close(); }


import {readFileSync, writeFileSync} from "node:fs";
function readWav(p){
  const b=readFileSync(p); let off=12, fmt=null, data=null;
  while(off+8<=b.length){ const id=b.toString("ascii",off,off+4); const sz=b.readUInt32LE(off+4); const body=off+8;
    if(id==="fmt ") fmt={ch:b.readUInt16LE(body+2), sr:b.readUInt32LE(body+4), bits:b.readUInt16LE(body+14)};
    if(id==="data") data=b.subarray(body, body+sz);
    off=body+sz+(sz%2);
  }
  return {fmt, data};
}
const src=readWav("data/sounds/1.wav");
const sr=src.fmt.sr, ch=src.fmt.ch, bps=src.fmt.bits/8;
const silentSec=1.2;
const silent=Buffer.alloc(Math.round(silentSec*sr)*ch*bps);
const seg2=readWav("data/sounds/3.wav").data;
const out=Buffer.concat([silent, src.data, silent, seg2, silent, silent]);
const frames=out.length/(ch*bps);
const hdr=Buffer.alloc(44);
hdr.write("RIFF",0,"ascii"); hdr.writeUInt32LE(36+out.length,4); hdr.write("WAVE",8,"ascii");
hdr.write("fmt ",12,"ascii"); hdr.writeUInt32LE(16,16); hdr.writeUInt16LE(1,20); hdr.writeUInt16LE(ch,22);
hdr.writeUInt32LE(sr,24); hdr.writeUInt32LE(sr*ch*bps,28); hdr.writeUInt16LE(ch*bps,32); hdr.writeUInt16LE(src.fmt.bits,34);
hdr.write("data",36,"ascii"); hdr.writeUInt32LE(out.length,40);
writeFileSync(new URL("./fake-mic.wav", import.meta.url), Buffer.concat([hdr,out]));
console.log("wrote fake-mic.wav", (frames/sr).toFixed(2)+"s,", (hdr.length+out.length)+" bytes");

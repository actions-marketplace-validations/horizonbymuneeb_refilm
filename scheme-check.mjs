import { chromium } from "playwright";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
const ROOT="/home/ubuntu/work/refilm/docs", ORIGIN="http://127.0.0.1:8901";
const walk=(d,o=[])=>{for(const e of readdirSync(d,{withFileTypes:true})){const p=join(d,e.name);if(e.isDirectory())walk(p,o);else if(e.name.endsWith(".html"))o.push(p);}return o;};
const pages=walk(ROOT).sort();
const b=await chromium.launch();
let bad=0, checked=0;

for (const scheme of ["dark","light"]) {
  for (const vp of [{n:"desk",width:1440,height:980},{n:"mob",width:390,height:844}]) {
    for (const pg of pages) {
      const rel=relative(ROOT,pg).replace(/\\/g,"/");
      const ctx=await b.newContext({viewport:{width:vp.width,height:vp.height},colorScheme:scheme});
      const p=await ctx.newPage();
      const errs=[];
      p.on("console",m=>{if(m.type()==="error")errs.push(m.text());});
      p.on("pageerror",e=>errs.push(String(e)));
      await p.goto(`${ORIGIN}/${rel}`,{waitUntil:"load"});
      await p.waitForTimeout(80);
      const r=await p.evaluate(()=>{
        const parse=s=>{
          if(!s||s==="transparent") return {r:0,g:0,b:0,a:0};
          const n=(s.match(/[\d.]+/g)||[]).map(Number);
          if(!n.length) return {r:0,g:0,b:0,a:0};
          return {r:n[0]||0,g:n[1]||0,b:n[2]||0,a:n.length>3?n[3]:1};
        };
        const over=(fg,bg)=>({r:fg.r*fg.a+bg.r*(1-fg.a),g:fg.g*fg.a+bg.g*(1-fg.a),b:fg.b*fg.a+bg.b*(1-fg.a),a:1});
        const lum=c=>{const f=v=>{v/=255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);};
        const ratio=(a,b)=>{const x=lum(a),y=lum(b);const[hi,lo]=x>y?[x,y]:[y,x];return (hi+0.05)/(lo+0.05);};
        // walk up compositing every background layer to an opaque colour
        const bgOf=el=>{
          const layers=[];
          for(let n=el;n&&n.nodeType===1;n=n.parentElement){
            const c=parse(getComputedStyle(n).backgroundColor);
            if(c.a>0)layers.push(c);
            if(c.a===1)break;
          }
          let base={r:255,g:255,b:255,a:1};
          for(let i=layers.length-1;i>=0;i--) base=over(layers[i],base);
          return base;
        };
        const low=[];
        let pairsOut=0;
        const sels=["main p","main li","main h1","main h2","main h3","main td","main figcaption",".sidebar a",".sidebar__label",".footer span",".footer a",".topbar__nav a",".topbar__name",".eyebrow",".muted",".st--pass",".st--fail",".res",".tag",".cmdindex .desc em",".type",".dflt",".flag",".release__date"];
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            const cs=getComputedStyle(el);
            if(cs.display==="none"||cs.visibility==="hidden"||parseFloat(cs.opacity)===0) continue;
            const rc=el.getBoundingClientRect();
            if(rc.width===0||rc.height===0) continue;
            if(!el.textContent.trim()) continue;
            const bg=bgOf(el);
            const cr=ratio(parse(cs.color),bg);
            pairsOut++;
            if (cr < 4.5) { low.push(`${sel}=${cr.toFixed(2)}`); break; }
          }
        }
        return { ovf: document.documentElement.scrollWidth-innerWidth, low, pairs: pairsOut };
      });
      const probs=[];
      if (r.ovf!==0) probs.push(`ovf ${r.ovf}`);
      if (errs.length) probs.push(`err ${errs[0]}`);
      checked += r.pairs;
      if (r.low.length) probs.push(`lowContrast ${r.low.join(" ")}`);
      if (probs.length) { bad++; console.log(`${scheme} ${vp.n} ${rel}: ${probs.join(" | ")}`); }
      await ctx.close();
    }
  }
}
await b.close();
console.log(bad===0?`clean: ${pages.length} pages x 2 viewports x 2 schemes, ${checked} text/background pairs >= 4.5:1`:`${bad} problem(s)`);

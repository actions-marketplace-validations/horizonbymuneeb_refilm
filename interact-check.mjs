import { chromium } from "playwright";
const ORIGIN="http://127.0.0.1:8901";
const b=await chromium.launch();

// 1. mobile nav: closed -> open -> link click navigates -> Esc closes
{
  const ctx=await b.newContext({viewport:{width:390,height:844}});
  const p=await ctx.newPage();
  await p.goto(`${ORIGIN}/site/commands/verify.html`,{waitUntil:"load"});
  const closed=await p.evaluate(()=>({h:Math.round(document.querySelector(".sidebar").getBoundingClientRect().height),aria:document.querySelector("[data-nav-toggle]").getAttribute("aria-expanded"),label:document.querySelector("[data-nav-toggle]").textContent.trim()}));
  await p.click("[data-nav-toggle]");
  await p.waitForTimeout(220);
  const open=await p.evaluate(()=>({h:Math.round(document.querySelector(".sidebar").getBoundingClientRect().height),aria:document.querySelector("[data-nav-toggle]").getAttribute("aria-expanded"),ovf:document.documentElement.scrollWidth-innerWidth}));
  // a nav link must be clickable while open
  await p.click('.sidebar a[href$="commands/record.html"]');
  await p.waitForLoadState("load");
  const navTo=p.url().split("/").pop();
  const afterNav=await p.evaluate(()=>({h:Math.round(document.querySelector(".sidebar").getBoundingClientRect().height),aria:document.querySelector("[data-nav-toggle]").getAttribute("aria-expanded")}));
  // Esc closes
  await p.click("[data-nav-toggle]");
  await p.waitForTimeout(200);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(220);
  const esc=await p.evaluate(()=>({h:Math.round(document.querySelector(".sidebar").getBoundingClientRect().height),aria:document.querySelector("[data-nav-toggle]").getAttribute("aria-expanded")}));
  console.log(`MOBILE NAV closed=${JSON.stringify(closed)} open=${JSON.stringify(open)} navTo=${navTo} afterNav=${JSON.stringify(afterNav)} afterEsc=${JSON.stringify(esc)}`);
  await ctx.close();
}

// 2. skip link is the first tab stop and actually moves focus into main
{
  const ctx=await b.newContext({viewport:{width:1440,height:980}});
  const p=await ctx.newPage();
  await p.goto(`${ORIGIN}/site/workflow.html`,{waitUntil:"load"});
  await p.keyboard.press("Tab");
  const first=await p.evaluate(()=>{const a=document.activeElement;const r=a.getBoundingClientRect();return {t:a.textContent.trim(),top:Math.round(r.top),visible:r.top>=0};});
  await p.keyboard.press("Enter");
  await p.waitForTimeout(120);
  const after=await p.evaluate(()=>({hash:location.hash, active:document.activeElement.tagName, activeId:document.activeElement.id}));
  console.log(`SKIP firstTab=${JSON.stringify(first)} afterEnter=${JSON.stringify(after)}`);
  await ctx.close();
}

// 3. focus ring visible on every interactive kind
{
  const ctx=await b.newContext({viewport:{width:1440,height:980}});
  const p=await ctx.newPage();
  await p.goto(`${ORIGIN}/site/getting-started.html`,{waitUntil:"load"});
  const rings=[];
  for (const sel of [".topbar__brand",".topbar__nav a",".sidebar a","main a","pre.cmd"]) {
    const ok=await p.evaluate(s=>{
      const el=document.querySelector(s); if(!el) return "missing";
      el.focus();
      const cs=getComputedStyle(el);
      return `${cs.outlineWidth}/${cs.outlineStyle}`;
    },sel);
    rings.push(`${sel}:${ok}`);
  }
  console.log("FOCUS RINGS " + rings.join(" "));
  await ctx.close();
}

// 4. copy button: appears on hover, copies the command without the "$"
{
  const ctx=await b.newContext({viewport:{width:1440,height:980},permissions:["clipboard-read","clipboard-write"]});
  const p=await ctx.newPage();
  await p.goto(`${ORIGIN}/site/getting-started.html`,{waitUntil:"load"});
  const n=await p.locator("pre.cmd").count();
  await p.locator("pre.cmd").first().hover();
  const op=await p.locator(".copy__btn").first().evaluate(e=>getComputedStyle(e).opacity);
  await p.locator(".copy__btn").first().click();
  await p.waitForTimeout(150);
  const label=await p.locator(".copy__btn").first().textContent();
  const clip=await p.evaluate(()=>navigator.clipboard.readText());
  const ovf=await p.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  console.log(`COPY blocks=${n} hoverOpacity=${op} label=${label} clip="${clip.replace(/\n/g," | ")}" ovf=${ovf}`);
  await ctx.close();
}

// 5. code blocks scroll inside themselves rather than widening the page
{
  const ctx=await b.newContext({viewport:{width:390,height:844}});
  const p=await ctx.newPage();
  await p.goto(`${ORIGIN}/site/commands/record.html`,{waitUntil:"load"});
  const r=await p.evaluate(()=>{
    const pres=Array.from(document.querySelectorAll("pre"));
    const scrollers=pres.filter(x=>x.scrollWidth>x.clientWidth);
    return {total:pres.length, scrolling:scrollers.length, ovf:document.documentElement.scrollWidth-innerWidth,
      sample: scrollers[0]? {sw:scrollers[0].scrollWidth, cw:scrollers[0].clientWidth, ox:getComputedStyle(scrollers[0]).overflowX}:null};
  });
  console.log(`CODE on mobile ${JSON.stringify(r)}`);
  await ctx.close();
}
await b.close();

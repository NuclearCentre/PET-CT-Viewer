/**
 * PetCtViewer.jsx  —  Phase 2 update
 *
 * Changes from Phase 1:
 *  1. PET series rendering with Hot Iron colormap (13 DICOM-standard palettes)
 *  2. CT W/L (blue) → CT viewports only | PET W/L (green) → PET viewports only
 *  3. SUV threshold sliders on every PET-CT viewport
 *  4. Mouse combo bindings:
 *       Middle wheel          → scroll slices (always active)
 *       Middle + Right held   → draw straight line
 *       Middle + Left  held   → draw circular ROI
 *       Right  + Left  held   → move drawn annotations
 *  5. These combos work IN ADDITION TO toolbar annotation buttons
 *
 * Architecture:
 *  This file is the self-contained prototype (canvas simulation).
 *  When integrating with real Cornerstone3D:
 *    - Replace ViewerBox canvas rendering with the CS3D ViewerBox from
 *      src/components/ViewerBox.jsx
 *    - Replace App state/layout with ViewportGrid from
 *      src/components/ViewportGrid.jsx
 *    - Call initCornerstone() from src/cornerstone-init.js at app start
 *
 * ⚠️ REMINDER: Replace PIXEL_TO_MM with real DICOM PixelSpacing (0028,0030)
 * ⚠️ REMINDER: Replace sampleHU() with storedPixel × RescaleSlope + RescaleIntercept
 * ⚠️ REMINDER: Replace sampleSUV() with real SUV calculation from dicomMetadata.js
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { getColor, getCssGradient, PALETTES, CT_PALETTES, PET_PALETTES } from "./utils/colourPalettes.js";
import ViewportGrid from "./components/ViewportGrid.jsx";

// ─── Constants ────────────────────────────────────────────────────────────────
const PIXEL_TO_MM = 0.5; // ⚠️ replace with real PixelSpacing

const CT_PRESETS = [
  { label:"Brain",       ww:80,   wc:40   },
  { label:"Subdural",    ww:200,  wc:75   },
  { label:"Lungs",       ww:1500, wc:-600 },
  { label:"Mediastinum", ww:350,  wc:50   },
  { label:"Liver",       ww:150,  wc:30   },
  { label:"Abdomen",     ww:400,  wc:50   },
  { label:"Bone",        ww:2000, wc:450  },
  { label:"Sinuses",     ww:3000, wc:500  },
];
const PET_PRESETS = [
  { label:"Standard",    ww:10000,wc:5000 },
  { label:"High uptake", ww:5000, wc:2500 },
  { label:"Low uptake",  ww:20000,wc:10000},
];

const TOOL_GROUPS = [
  { id:"roi", label:"ROI", icon:"⬭", tools:[
    { id:"circle",   label:"Round",      icon:"○" },
    { id:"oval",     label:"Oval",       icon:"⬭" },
    { id:"square",   label:"Square",     icon:"□" },
    { id:"rect",     label:"Rectangle",  icon:"▭" },
    { id:"freehand", label:"Freehand",   icon:"✏" },
  ]},
  { id:"length", label:"Length", icon:"╱", tools:[
    { id:"line",          label:"Straight Line", icon:"╱" },
    { id:"bezier",        label:"Curved Line",   icon:"∿" },
    { id:"line_freehand", label:"Freehand Line", icon:"〜" },
  ]},
];
const ALL_TOOLS  = TOOL_GROUPS.flatMap(g => g.tools);
const LENGTH_IDS = new Set(["line","bezier","line_freehand"]);
function findGroup(id){ return TOOL_GROUPS.find(g => g.tools.some(t => t.id===id)); }

// ─── Colour helpers (delegates to colourPalettes.js) ─────────────────────────
function scaleToCss(id){ return getCssGradient(id); }
function scaleColor(id, t){ return getColor(id, t); }

// ─── Simulated image rendering (replace with CS3D in integration) ─────────────
function sampleHU(ctx, x, y, wc, ww){
  try{const d=ctx.getImageData(Math.round(x),Math.round(y),1,1).data;return Math.round(wc-ww/2+((d[0]+d[1]+d[2])/3/255)*ww);}catch{return 0;}
}
function inPoly(x,y,pts){
  let inside=false;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++){
    const xi=pts[i].x,yi=pts[i].y,xj=pts[j].x,yj=pts[j].y;
    if(((yi>y)!==(yj>y))&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;
  }
  return inside;
}
function sampleROI(ctx,pts,wc,ww){
  if(!pts||pts.length<3)return{mean:0,min:0,max:0,area:"0.0"};
  const xs=pts.map(p=>p.x),ys=pts.map(p=>p.y);
  const x0=Math.max(0,Math.floor(Math.min(...xs))),x1=Math.ceil(Math.max(...xs));
  const y0=Math.max(0,Math.floor(Math.min(...ys))),y1=Math.ceil(Math.max(...ys));
  const vals=[];
  for(let py=y0;py<=y1;py+=2)for(let px=x0;px<=x1;px+=2)
    if(inPoly(px,py,pts))vals.push(sampleHU(ctx,px,py,wc,ww));
  if(!vals.length)return{mean:0,min:0,max:0,area:"0.0"};
  const mean=Math.round(vals.reduce((a,b)=>a+b,0)/vals.length);
  let area=0;
  for(let i=0,j=pts.length-1;i<pts.length;j=i++)area+=(pts[j].x+pts[i].x)*(pts[j].y-pts[i].y);
  return{mean,min:Math.min(...vals),max:Math.max(...vals),area:(Math.abs(area/2)*PIXEL_TO_MM*PIXEL_TO_MM).toFixed(1)};
}

function drawImage(canvas, wc, ww, label, color, paletteId, modality) {
  const ctx=canvas.getContext("2d"),w=canvas.width,h=canvas.height;
  if(!ctx||!w||!h)return;
  ctx.fillStyle="#000";ctx.fillRect(0,0,w,h);
  const cx=w/2,cy=h/2,rx=w*.38,ry=h*.42;
  const lo=wc-ww/2,hi=wc+ww/2;
  const C=v=>{const[r,g,b]=scaleColor(paletteId,Math.max(0,Math.min(1,(v-lo)/(hi-lo))));return"rgb("+r+","+g+","+b+")";};
  const CA=(v,a)=>{const[r,g,b]=scaleColor(paletteId,Math.max(0,Math.min(1,(v-lo)/(hi-lo))));return"rgba("+r+","+g+","+b+","+a+")";};

  // For PET: simulate hot-uptake pattern
  if(modality==='PET'){
    // Background body outline
    const g2=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(rx,ry));
    const bgV=modality==='PET'?500:120;
    g2.addColorStop(0,C(bgV*.8));g2.addColorStop(.7,C(bgV*.4));g2.addColorStop(1,CA(bgV*.2,0));
    ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.fillStyle=g2;ctx.fill();
    // Hot spots (high uptake lesions)
    const spots=[{x:cx-rx*.15,y:cy-ry*.1,r:rx*.1,v:8000},{x:cx+rx*.2,y:cy+ry*.15,r:rx*.07,v:6000}];
    spots.forEach(s=>{
      const sg=ctx.createRadialGradient(s.x,s.y,0,s.x,s.y,s.r*2);
      sg.addColorStop(0,C(s.v));sg.addColorStop(1,CA(s.v*.1,0));
      ctx.beginPath();ctx.arc(s.x,s.y,s.r*2,0,Math.PI*2);ctx.fillStyle=sg;ctx.fill();
    });
    // Bladder (very high uptake)
    const bg2=ctx.createRadialGradient(cx,cy+ry*.55,0,cx,cy+ry*.55,rx*.12);
    bg2.addColorStop(0,C(9500));bg2.addColorStop(1,CA(9500*.1,0));
    ctx.beginPath();ctx.ellipse(cx,cy+ry*.55,rx*.09,ry*.13,0,0,Math.PI*2);ctx.fillStyle=bg2;ctx.fill();
  } else {
    // CT body rendering
    const g=ctx.createRadialGradient(cx,cy,0,cx,cy,Math.max(rx,ry));
    g.addColorStop(0,C(180));g.addColorStop(.5,C(153));g.addColorStop(1,CA(120,0));
    ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.fillStyle=g;ctx.fill();
    ctx.beginPath();ctx.ellipse(cx,cy+ry*.55,rx*.08,ry*.12,0,0,Math.PI*2);ctx.fillStyle=C(230);ctx.fill();
    [-1,1].forEach(s=>{ctx.beginPath();ctx.ellipse(cx+s*rx*.28,cy-ry*.05,rx*.2,ry*.28,s*.15,0,Math.PI*2);ctx.fillStyle=C(30);ctx.fill();});
    ctx.beginPath();ctx.arc(cx-rx*.06,cy-ry*.1,rx*.045,0,Math.PI*2);ctx.fillStyle=C(160);ctx.fill();
  }

  // Label
  ctx.font="bold "+Math.round(w*.055)+"px monospace";ctx.fillStyle=color;ctx.globalAlpha=.9;
  ctx.fillText(label,10,Math.round(h*.065));ctx.globalAlpha=1;
  // W/L
  const t="W:"+ww+" L:"+wc;ctx.font=Math.round(w*.038)+"px monospace";ctx.fillStyle="#666";
  ctx.fillText(t,w-ctx.measureText(t).width-28,h-10);
  // Crosshair
  const cr=Math.min(w,h)*.12;ctx.strokeStyle="rgba(0,229,255,.25)";ctx.lineWidth=.8;
  ctx.beginPath();ctx.moveTo(cx-cr,cy);ctx.lineTo(cx+cr,cy);ctx.moveTo(cx,cy-cr);ctx.lineTo(cx,cy+cr);ctx.stroke();
}

function drawStrip(canvas, paletteId, frac){
  const c=canvas;if(!c)return;
  c.width=c.offsetWidth||22;c.height=c.offsetHeight||200;
  const ctx=c.getContext("2d"),{width:w,height:h}=c;
  if(!ctx||!w||!h)return;
  for(let y=0;y<h;y++){const[r,g,b]=scaleColor(paletteId,1-y/(h-1));ctx.fillStyle="rgb("+r+","+g+","+b+")";ctx.fillRect(0,y,w,1);}
  const my=Math.round((1-frac)*(h-1));
  ctx.fillStyle="#00e5ff";ctx.shadowColor="#00e5ff";ctx.shadowBlur=4;ctx.fillRect(0,Math.max(0,my-1),w,2);ctx.shadowBlur=0;
}

// ─── ScalePicker ──────────────────────────────────────────────────────────────
function ScalePicker({paletteId, palettes, onSelect}){
  const[open,setOpen]=useState(false);const t=useRef();
  const enter=()=>{clearTimeout(t.current);setOpen(true);};
  const leave=()=>{t.current=setTimeout(()=>setOpen(false),150);};
  useEffect(()=>()=>clearTimeout(t.current),[]);
  const groups=_groupPalettes(palettes);
  return(
    <div onMouseEnter={enter} onMouseLeave={leave} onDoubleClick={e=>e.stopPropagation()}
      style={{position:"absolute",bottom:0,left:0,right:0,zIndex:30,textAlign:"center"}}>
      <div style={{fontSize:7,color:"#aaa",background:"rgba(0,0,0,.8)",borderTop:"1px solid #333",userSelect:"none",padding:"2px 0"}}>▲map</div>
      {open&&<div style={{position:"absolute",bottom:"100%",right:"100%",marginRight:2,background:"rgba(12,12,12,.97)",
        border:"1px solid #444",borderRadius:4,overflow:"hidden",boxShadow:"-4px 4px 20px rgba(0,0,0,.9)",whiteSpace:"nowrap",minWidth:160}}>
        {groups.map(grp=>(
          <div key={grp.label}>
            <div style={{fontSize:9,color:"#555",padding:"4px 8px 2px",borderBottom:"1px solid #1e1e1e",textTransform:"uppercase",letterSpacing:1}}>{grp.label}</div>
            {grp.palettes.map(p=>{const a=p.id===paletteId;return(
              <div key={p.id} onMouseDown={e=>{e.preventDefault();e.stopPropagation();onSelect(p.id);setOpen(false);}}
                style={{display:"flex",alignItems:"center",gap:7,padding:"4px 8px",cursor:"pointer",
                  background:a?"rgba(255,255,255,.07)":"transparent",borderLeft:a?"2px solid #00e5ff":"2px solid transparent"}}
                onMouseEnter={e=>{if(!a)e.currentTarget.style.background="#1a1a1a";}}
                onMouseLeave={e=>{if(!a)e.currentTarget.style.background="transparent";}}>
                <div style={{width:10,height:32,flexShrink:0,borderRadius:1,background:scaleToCss(p.id),border:"1px solid #333"}}/>
                <span style={{fontSize:10,color:a?"#fff":"#ccc"}}>{p.label}</span>
              </div>);})}
          </div>
        ))}
      </div>}
    </div>);
}
function _groupPalettes(palettes){
  const map={};palettes.forEach(p=>{if(!map[p.group])map[p.group]=[];map[p.group].push(p);});
  const labels={ct:"CT",pet_dicom:"DICOM PET",fmri:"DICOM fMRI",custom:"Custom"};
  return Object.entries(map).map(([g,ps])=>({label:labels[g]||g,palettes:ps}));
}

// ─── Strip ────────────────────────────────────────────────────────────────────
function Strip({wc,ww,paletteId,palettes,onWL,onScale}){
  const ref=useRef(),drag=useRef(false),ly=useRef(0),st=useRef({wc,ww,onWL});
  useEffect(()=>{st.current={wc,ww,onWL};});
  const frac=Math.max(0,Math.min(1,(wc+2000)/6000));
  useEffect(()=>{if(ref.current)drawStrip(ref.current,paletteId,frac);},[paletteId,frac]);
  useEffect(()=>{
    const c=ref.current;if(!c)return;
    const ro=new ResizeObserver(()=>drawStrip(c,paletteId,frac));
    ro.observe(c);return()=>ro.disconnect();
  },[]);
  const cl=(v,a,b)=>Math.max(a,Math.min(b,v));
  const mv=useCallback(e=>{if(!drag.current)return;const dy=e.clientY-ly.current;ly.current=e.clientY;
    const{wc:w,ww:h,onWL:cb}=st.current;cb(cl(w-dy*4,-2000,4000),cl(h+Math.abs(dy)*2,1,4000));},[]);
  const up=useCallback(()=>{drag.current=false;window.removeEventListener("mousemove",mv);window.removeEventListener("mouseup",up);},[mv]);
  const dn=useCallback(e=>{e.preventDefault();e.stopPropagation();drag.current=true;ly.current=e.clientY;
    window.addEventListener("mousemove",mv);window.addEventListener("mouseup",up);},[mv,up]);
  const wh=useCallback(e=>{e.preventDefault();e.stopPropagation();const{wc:w,ww:h,onWL:cb}=st.current;cb(cl(w+(e.deltaY>0?-20:20),-2000,4000),h);},[]);
  return(
    <div style={{width:22,minWidth:22,alignSelf:"stretch",position:"relative",borderLeft:"1px solid #333",cursor:"ns-resize",userSelect:"none",touchAction:"none"}}
      onMouseDown={dn} onWheel={wh}>
      <canvas ref={ref} style={{display:"block",width:"100%",height:"100%"}}/>
      <ScalePicker paletteId={paletteId} palettes={palettes} onSelect={onScale}/>
    </div>);
}

// ─── PresetBar ────────────────────────────────────────────────────────────────
function PresetBar({color,active,onSelect,presets}){
  const[open,setOpen]=useState(false);const t=useRef();
  const enter=()=>{clearTimeout(t.current);setOpen(true);};
  const leave=()=>{t.current=setTimeout(()=>setOpen(false),150);};
  useEffect(()=>()=>clearTimeout(t.current),[]);
  return(
    <div onMouseEnter={enter} onMouseLeave={leave} onDoubleClick={e=>e.stopPropagation()}
      style={{position:"absolute",bottom:6,left:8,zIndex:60,userSelect:"none"}}>
      {open&&<div style={{position:"absolute",bottom:"100%",left:0,marginBottom:4,
        background:"rgba(12,12,12,.97)",border:"1px solid "+color+"55",borderRadius:3,
        overflow:"hidden",boxShadow:"0 -4px 18px rgba(0,0,0,.85)",whiteSpace:"nowrap"}}>
        {presets.map(p=>{const a=p.label===active;return(
          <div key={p.label} onMouseDown={e=>{e.preventDefault();e.stopPropagation();onSelect(p);setOpen(false);}}
            style={{display:"flex",alignItems:"center",padding:"4px 10px",cursor:"pointer",
              background:a?color+"28":"transparent",borderLeft:a?"2px solid "+color:"2px solid transparent"}}
            onMouseEnter={e=>{if(!a)e.currentTarget.style.background="#222";}}
            onMouseLeave={e=>{if(!a)e.currentTarget.style.background="transparent";}}>
            <span style={{fontSize:11,color:"#fff",minWidth:110}}>{p.label}</span>
            <span style={{fontSize:10,color:"#aaa",minWidth:60}}>WW {p.ww}</span>
            <span style={{fontSize:10,color:"#aaa"}}>WC {p.wc}</span>
          </div>);})}
      </div>}
      <span style={{fontSize:9,color:active?color:"#555",cursor:"default"}}>{active?"⬡ "+active:"⬡ Presets"}</span>
    </div>);
}

// ─── ToolPicker ───────────────────────────────────────────────────────────────
function ToolPicker({activeTool,onSelect}){
  const[open,setOpen]=useState(false);const[hov,setHov]=useState(null);const t=useRef();
  const enter=()=>{clearTimeout(t.current);setOpen(true);};
  const leave=()=>{t.current=setTimeout(()=>{setOpen(false);setHov(null);},160);};
  useEffect(()=>()=>clearTimeout(t.current),[]);
  const ag=activeTool?findGroup(activeTool):null;
  return(
    <div onMouseEnter={enter} onMouseLeave={leave} onDoubleClick={e=>e.stopPropagation()}
      style={{position:"absolute",top:6,right:28,zIndex:55,userSelect:"none"}}>
      <span style={{fontSize:9,color:ag?"#00e5ff":"#555",background:"rgba(0,0,0,.6)",padding:"2px 5px",borderRadius:2,cursor:"default"}}>
        {ag?ag.icon+" "+ag.label:"⊕ Tools"}
      </span>
      {open&&<div style={{position:"absolute",top:"100%",right:0,marginTop:3,background:"rgba(12,12,12,.97)",
        border:"1px solid #555",borderRadius:3,boxShadow:"4px 4px 16px rgba(0,0,0,.85)",whiteSpace:"nowrap",overflow:"visible"}}>
        <div onMouseEnter={()=>setHov(null)} onMouseDown={e=>{e.preventDefault();e.stopPropagation();onSelect(null);setOpen(false);setHov(null);}}
          style={{display:"flex",alignItems:"center",gap:8,padding:"4px 10px",cursor:"pointer",
            background:!activeTool?"rgba(255,255,255,.08)":"transparent",borderLeft:!activeTool?"2px solid #aaa":"2px solid transparent"}}>
          <span style={{fontSize:12,width:16,textAlign:"center",color:"#fff"}}>↖</span>
          <span style={{fontSize:11,color:"#fff"}}>Normal Cursor</span>
        </div>
        {TOOL_GROUPS.map(grp=>{const isA=ag?.id===grp.id,isH=hov===grp.id;return(
          <div key={grp.id} style={{position:"relative"}} onMouseEnter={()=>setHov(grp.id)}>
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"4px 10px",cursor:"pointer",
              background:isA?"rgba(0,229,255,.1)":isH?"#1e1e1e":"transparent",borderLeft:isA?"2px solid #00e5ff":"2px solid transparent"}}>
              <span style={{fontSize:13,width:16,textAlign:"center",color:isA?"#00e5ff":"#ccc"}}>{grp.icon}</span>
              <span style={{fontSize:11,color:isA?"#00e5ff":"#fff",fontWeight:isA?"bold":"normal",flex:1}}>{grp.label}</span>
              <span style={{fontSize:9,color:"#555",marginLeft:6}}>▶</span>
            </div>
            {isH&&<div style={{position:"absolute",top:0,right:"100%",marginRight:2,background:"rgba(12,12,12,.97)",
              border:"1px solid #555",borderRadius:3,boxShadow:"-4px 4px 16px rgba(0,0,0,.85)",whiteSpace:"nowrap",overflow:"hidden"}}>
              {grp.tools.map(tool=>{const isAt=tool.id===activeTool;return(
                <div key={tool.id} onMouseDown={e=>{e.preventDefault();e.stopPropagation();onSelect(isAt?null:tool.id);setOpen(false);setHov(null);}}
                  style={{display:"flex",alignItems:"center",gap:8,padding:"4px 12px",cursor:"pointer",
                    background:isAt?"rgba(0,229,255,.12)":"transparent",borderLeft:isAt?"2px solid #00e5ff":"2px solid transparent"}}
                  onMouseEnter={e=>{if(!isAt)e.currentTarget.style.background="#1e1e1e";}}
                  onMouseLeave={e=>{if(!isAt)e.currentTarget.style.background="transparent";}}>
                  <span style={{fontSize:13,width:16,textAlign:"center",color:isAt?"#00e5ff":"#ccc"}}>{tool.icon}</span>
                  <span style={{fontSize:11,color:isAt?"#00e5ff":"#fff",fontWeight:isAt?"bold":"normal"}}>{tool.label}</span>
                </div>);})}
            </div>}
          </div>);})}
      </div>}
    </div>);
}

// ─── SUV threshold bar (PET viewports) ────────────────────────────────────────
function SUVBar({suvMin,suvMax,onSUV}){
  const[lMin,setLMin]=useState(suvMin);const[lMax,setLMax]=useState(suvMax);
  useEffect(()=>{setLMin(suvMin);setLMax(suvMax);},[suvMin,suvMax]);
  return(
    <div style={{position:"absolute",bottom:0,left:0,right:22,background:"rgba(0,0,0,.8)",
      borderTop:"1px solid #1a1a1a",padding:"3px 6px",display:"flex",alignItems:"center",gap:5,userSelect:"none"}}>
      <span style={{fontSize:9,color:"#ffcc66",minWidth:26}}>SUV</span>
      <span style={{fontSize:9,color:"#777",minWidth:18}}>min</span>
      <input type="range" min={0} max={20} step={0.1} value={lMin}
        onChange={e=>setLMin(+e.target.value)} onMouseUp={()=>onSUV?.({min:lMin,max:lMax})}
        style={{flex:1,accentColor:"#ffcc66",height:3}}/>
      <span style={{fontSize:9,color:"#ffcc66",minWidth:24}}>{lMin.toFixed(1)}</span>
      <span style={{fontSize:9,color:"#777",minWidth:20}}>max</span>
      <input type="range" min={0} max={30} step={0.5} value={lMax}
        onChange={e=>setLMax(+e.target.value)} onMouseUp={()=>onSUV?.({min:lMin,max:lMax})}
        style={{flex:1,accentColor:"#ffcc66",height:3}}/>
      <span style={{fontSize:9,color:"#ffcc66",minWidth:24}}>{lMax.toFixed(1)}</span>
    </div>);
}

// ─── Annotation geometry helpers (unchanged from Phase 1) ─────────────────────
function ellipsePts(cx,cy,rx,ry,n=64){return Array.from({length:n},(_,i)=>{const a=i/n*Math.PI*2;return{x:cx+Math.cos(a)*rx,y:cy+Math.sin(a)*ry};});}
function nearestOnBoundary(px,py,pts){if(!pts||!pts.length)return{x:px,y:py};let best={x:pts[0].x,y:pts[0].y},bd=Infinity;for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length],dx=b.x-a.x,dy=b.y-a.y,l2=dx*dx+dy*dy;const tt=l2?Math.max(0,Math.min(1,((px-a.x)*dx+(py-a.y)*dy)/l2)):0;const nx=a.x+tt*dx,ny=a.y+tt*dy,d=(px-nx)**2+(py-ny)**2;if(d<bd){bd=d;best={x:nx,y:ny};}}return best;}
function anchorOf(ann,lcx,lcy){if(!ann||!isFinite(ann.x1))return{x:lcx,y:lcy};if(ann.type==="line"||ann.type==="bezier")return(ann.x1-lcx)**2+(ann.y1-lcy)**2<=(ann.x2-lcx)**2+(ann.y2-lcy)**2?{x:ann.x1,y:ann.y1}:{x:ann.x2,y:ann.y2};if(ann.type==="line_freehand"&&ann.pts?.length){const s=ann.pts[0],e=ann.pts[ann.pts.length-1];return(s.x-lcx)**2+(s.y-lcy)**2<=(e.x-lcx)**2+(e.y-lcy)**2?s:e;}if(ann.pts?.length>1)return nearestOnBoundary(lcx,lcy,ann.pts);return{x:(ann.x1+ann.x2)/2,y:(ann.y1+ann.y2)/2};}
function edgeOf(lx,ly,lw,lh,ax,ay){if(!isFinite(lx)||!isFinite(ly)||!isFinite(ax)||!isFinite(ay))return{x:ax||0,y:ay||0};const cx=lx+lw/2,cy=ly+lh/2,dx=ax-cx,dy=ay-cy;if(!dx&&!dy)return{x:cx,y:cy};const s=Math.min(lw>0&&dx?(lw/2)/Math.abs(dx):Infinity,lh>0&&dy?(lh/2)/Math.abs(dy):Infinity);if(!isFinite(s))return{x:cx,y:cy};return{x:cx+dx*s,y:cy+dy*s};}
function computeAnn(ann,canvasRef,wc,ww){if(!ann||typeof ann.x1!=="number"||typeof ann.x2!=="number")return{...ann,vl:["Invalid"]};try{let pts=ann.pts;if(ann.type==="oval")pts=ellipsePts((ann.x1+ann.x2)/2,(ann.y1+ann.y2)/2,Math.abs(ann.x2-ann.x1)/2,Math.abs(ann.y2-ann.y1)/2);if(ann.type==="circle"){const r=Math.hypot(ann.x2-ann.x1,ann.y2-ann.y1)/2;pts=ellipsePts((ann.x1+ann.x2)/2,(ann.y1+ann.y2)/2,r,r);}if(ann.type==="square"||ann.type==="rect")pts=[{x:Math.min(ann.x1,ann.x2),y:Math.min(ann.y1,ann.y2)},{x:Math.max(ann.x1,ann.x2),y:Math.min(ann.y1,ann.y2)},{x:Math.max(ann.x1,ann.x2),y:Math.max(ann.y1,ann.y2)},{x:Math.min(ann.x1,ann.x2),y:Math.max(ann.y1,ann.y2)}];let vl=[];if(LENGTH_IDS.has(ann.type)){let len=0;if(ann.type==="line")len=Math.hypot(ann.x2-ann.x1,ann.y2-ann.y1);else if(ann.type==="bezier"){const p1x=ann.cp1x!==undefined?ann.cp1x:ann.x1+(ann.x2-ann.x1)/3;const p1y=ann.cp1y!==undefined?ann.cp1y:ann.y1+(ann.y2-ann.y1)/3;const p2x=ann.cp2x!==undefined?ann.cp2x:ann.x1+(ann.x2-ann.x1)*2/3;const p2y=ann.cp2y!==undefined?ann.cp2y:ann.y1+(ann.y2-ann.y1)*2/3;let bpx=ann.x1,bpy=ann.y1;for(let i=1;i<=50;i++){const t=i/50,mt=1-t,mt2=mt*mt,mt3=mt2*mt,t2=t*t,t3=t2*t;const nx=mt3*ann.x1+3*mt2*t*p1x+3*mt*t2*p2x+t3*ann.x2;const ny=mt3*ann.y1+3*mt2*t*p1y+3*mt*t2*p2y+t3*ann.y2;len+=Math.hypot(nx-bpx,ny-bpy);bpx=nx;bpy=ny;}}else if(ann.type==="line_freehand"&&ann.pts)for(let i=1;i<ann.pts.length;i++)len+=Math.hypot(ann.pts[i].x-ann.pts[i-1].x,ann.pts[i].y-ann.pts[i-1].y);vl=["Length: "+(len*PIXEL_TO_MM).toFixed(1)+" mm"];}else{const ctx=canvasRef?.current?.getContext("2d");const hu=(ctx&&pts?.length>2)?sampleROI(ctx,pts,wc,ww):{mean:0,min:0,max:0,area:"0.0"};vl=["Mean: "+hu.mean+" HU","Min: "+hu.min+" HU","Max: "+hu.max+" HU","Area: "+hu.area+" mm²"];}return{...ann,pts,vl};}catch(e){return{...ann,vl:["Error"]};}}
let _uid=0;
function buildAnn(type,p1,p2,pts,canvasRef,wc,ww,extra={}){try{const id=++_uid,x1=p1.x,y1=p1.y,x2=p2.x,y2=p2.y;let poly=null;if(type==="oval")poly=ellipsePts((x1+x2)/2,(y1+y2)/2,Math.abs(x2-x1)/2,Math.abs(y2-y1)/2);if(type==="circle"){const r=Math.hypot(x2-x1,y2-y1)/2;poly=ellipsePts((x1+x2)/2,(y1+y2)/2,r,r);}if(type==="square"||type==="rect")poly=[{x:Math.min(x1,x2),y:Math.min(y1,y2)},{x:Math.max(x1,x2),y:Math.min(y1,y2)},{x:Math.max(x1,x2),y:Math.max(y1,y2)},{x:Math.min(x1,x2),y:Math.max(y1,y2)}];if(type==="freehand")poly=pts;if(type==="line_freehand")poly=pts;const ann={id,type,x1,y1,x2,y2,pts:poly,vl:[],labelX:(x1+x2)/2+10,labelY:(y1+y2)/2-20,...extra};return computeAnn(ann,canvasRef,wc,ww);}catch(e){return null;}}
const HW=7;
function getHandles(ann){if(ann.type==="line")return[{id:"p1",x:ann.x1,y:ann.y1,cur:"crosshair"},{id:"p2",x:ann.x2,y:ann.y2,cur:"crosshair"}];if(ann.type==="bezier"){const c1x=typeof ann.cp1x==="number"?ann.cp1x:ann.x1+(ann.x2-ann.x1)/3;const c1y=typeof ann.cp1y==="number"?ann.cp1y:ann.y1+(ann.y2-ann.y1)/3;const c2x=typeof ann.cp2x==="number"?ann.cp2x:ann.x1+(ann.x2-ann.x1)*2/3;const c2y=typeof ann.cp2y==="number"?ann.cp2y:ann.y1+(ann.y2-ann.y1)*2/3;return[{id:"p1",x:ann.x1,y:ann.y1,cur:"crosshair"},{id:"p2",x:ann.x2,y:ann.y2,cur:"crosshair"},{id:"cp1",x:c1x,y:c1y,cur:"move"},{id:"cp2",x:c2x,y:c2y,cur:"move"}];}if(ann.type==="freehand"||ann.type==="line_freehand")return[];const lx=Math.min(ann.x1,ann.x2),rx=Math.max(ann.x1,ann.x2),ty=Math.min(ann.y1,ann.y2),by=Math.max(ann.y1,ann.y2),mx=(lx+rx)/2,my=(ty+by)/2;if(ann.type==="oval")return[{id:"tc",x:mx,y:ty,cur:"n-resize"},{id:"bc",x:mx,y:by,cur:"s-resize"},{id:"lc",x:lx,y:my,cur:"w-resize"},{id:"rc",x:rx,y:my,cur:"e-resize"}];if(ann.type==="circle"){const r=Math.hypot(rx-lx,by-ty)/2;return[{id:"tc",x:mx,y:my-r,cur:"n-resize"},{id:"bc",x:mx,y:my+r,cur:"s-resize"},{id:"lc",x:mx-r,y:my,cur:"w-resize"},{id:"rc",x:mx+r,y:my,cur:"e-resize"}];}return[{id:"tl",x:lx,y:ty,cur:"nw-resize"},{id:"tr",x:rx,y:ty,cur:"ne-resize"},{id:"br",x:rx,y:by,cur:"se-resize"},{id:"bl",x:lx,y:by,cur:"sw-resize"},{id:"tc",x:mx,y:ty,cur:"n-resize"},{id:"bc",x:mx,y:by,cur:"s-resize"},{id:"lc",x:lx,y:my,cur:"w-resize"},{id:"rc",x:rx,y:my,cur:"e-resize"}];}
function applyHandle(ann,hid,dx,dy){let{x1,y1,x2,y2}=ann;if(ann.type==="bezier"){if(hid==="p1")return{...ann,x1:x1+dx,y1:y1+dy};if(hid==="p2")return{...ann,x2:x2+dx,y2:y2+dy};if(hid==="cp1"){const c1x=typeof ann.cp1x==="number"?ann.cp1x:x1+(x2-x1)/3;const c1y=typeof ann.cp1y==="number"?ann.cp1y:y1+(y2-y1)/3;return{...ann,cp1x:c1x+dx,cp1y:c1y+dy};}if(hid==="cp2"){const c2x=typeof ann.cp2x==="number"?ann.cp2x:x1+(x2-x1)*2/3;const c2y=typeof ann.cp2y==="number"?ann.cp2y:y1+(y2-y1)*2/3;return{...ann,cp2x:c2x+dx,cp2y:c2y+dy};}}if(ann.type==="line"){if(hid==="p1")return{...ann,x1:x1+dx,y1:y1+dy};if(hid==="p2")return{...ann,x2:x2+dx,y2:y2+dy};}if(hid==="tc")y1+=dy;else if(hid==="bc")y2+=dy;else if(hid==="lc")x1+=dx;else if(hid==="rc")x2+=dx;else if(hid==="tl"){x1+=dx;y1+=dy;}else if(hid==="tr"){x2+=dx;y1+=dy;}else if(hid==="br"){x2+=dx;y2+=dy;}else if(hid==="bl"){x1+=dx;y2+=dy;}if(Math.abs(x2-x1)<10){x1=ann.x1;x2=ann.x2;}if(Math.abs(y2-y1)<10){y1=ann.y1;y2=ann.y2;}return{...ann,x1,y1,x2,y2};}

// ─── Shape renderer ───────────────────────────────────────────────────────────
function renderShape(ann){
  if(!ann)return null;
  const S="#ffff00",sw=1.5;
  const x1=ann.x1,y1=ann.y1,x2=ann.x2,y2=ann.y2;
  if(ann.type==="line")return(<g><line x1={x1} y1={y1} x2={x2} y2={y2} stroke={S} strokeWidth={sw}/><circle cx={x1} cy={y1} r={3} fill={S}/><circle cx={x2} cy={y2} r={3} fill={S}/></g>);
  if(ann.type==="bezier"){const cp1x=typeof ann.cp1x==="number"?ann.cp1x:x1+(x2-x1)/3;const cp1y=typeof ann.cp1y==="number"?ann.cp1y:y1+(y2-y1)/3;const cp2x=typeof ann.cp2x==="number"?ann.cp2x:x1+(x2-x1)*2/3;const cp2y=typeof ann.cp2y==="number"?ann.cp2y:y1+(y2-y1)*2/3;const d="M"+x1+","+y1+" C"+cp1x+","+cp1y+" "+cp2x+","+cp2y+" "+x2+","+y2;return(<g><path d={d} stroke={S} strokeWidth={sw} fill="none"/><circle cx={x1} cy={y1} r={3} fill={S}/><circle cx={x2} cy={y2} r={3} fill={S}/></g>);}
  if(ann.type==="line_freehand"&&ann.pts?.length>1)return<path d={"M"+ann.pts.map(p=>p.x+","+p.y).join("L")} stroke={S} strokeWidth={sw} fill="none"/>;
  if(ann.type==="oval")return<ellipse cx={(x1+x2)/2} cy={(y1+y2)/2} rx={Math.abs(x2-x1)/2} ry={Math.abs(y2-y1)/2} stroke={S} strokeWidth={sw} fill="none"/>;
  if(ann.type==="circle")return<circle cx={(x1+x2)/2} cy={(y1+y2)/2} r={Math.hypot(x2-x1,y2-y1)/2} stroke={S} strokeWidth={sw} fill="none"/>;
  if(ann.type==="square"||ann.type==="rect")return<rect x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)} stroke={S} strokeWidth={sw} fill="none"/>;
  if(ann.type==="freehand"&&ann.pts?.length>1)return<path d={"M"+ann.pts.map(p=>p.x+","+p.y).join("L")+"Z"} stroke={S} strokeWidth={sw} fill="rgba(255,255,0,.06)"/>;
  return null;
}

// ─── AnnLabel ─────────────────────────────────────────────────────────────────
function AnnLabel({ann,onDelete}){
  const safeN=n=>isFinite(n)?n:10;
  const[pos,setPos]=useState({x:safeN(ann.labelX),y:safeN(ann.labelY)});
  const[sz,setSz]=useState({w:90,h:20});
  const box=useRef(),drag=useRef(false),pr=useRef(pos);
  useEffect(()=>{pr.current=pos;},[pos]);
  useEffect(()=>{if(!box.current)return;const ro=new ResizeObserver(()=>{if(box.current)setSz({w:box.current.offsetWidth,h:box.current.offsetHeight});});ro.observe(box.current);return()=>ro.disconnect();},[]);
  const dn=useCallback(e=>{e.stopPropagation();e.preventDefault();drag.current=true;const sc={x:e.clientX,y:e.clientY},sp={...pr.current};const mv=ev=>{if(!drag.current)return;let nx=sp.x+(ev.clientX-sc.x),ny=sp.y+(ev.clientY-sc.y);if(!isFinite(nx)||!isFinite(ny))return;const parent=box.current&&box.current.offsetParent;if(parent){const pw=parent.offsetWidth,ph=parent.offsetHeight,bw=box.current.offsetWidth||sz.w,bh=box.current.offsetHeight||sz.h;nx=Math.max(0,Math.min(nx,pw-bw));ny=Math.max(0,Math.min(ny,ph-bh));}setPos({x:nx,y:ny});};const up=()=>{drag.current=false;window.removeEventListener("mousemove",mv);window.removeEventListener("mouseup",up);};window.addEventListener("mousemove",mv);window.addEventListener("mouseup",up);},[sz]);
  const lcx=pos.x+sz.w/2,lcy=pos.y+sz.h/2;
  const anch=anchorOf(ann,lcx,lcy),edge=edgeOf(pos.x,pos.y,sz.w,sz.h,anch.x,anch.y);
  const safe=n=>(isFinite(n)?n:0);
  return(<>
    <svg style={{position:"absolute",inset:0,width:"100%",height:"100%",pointerEvents:"none",overflow:"visible",zIndex:51}}>
      <line x1={safe(anch.x)} y1={safe(anch.y)} x2={safe(edge.x)} y2={safe(edge.y)} stroke="#00e5ff" strokeWidth={1} strokeDasharray="3 4" opacity={.6}/>
      <circle cx={safe(anch.x)} cy={safe(anch.y)} r={2.5} fill="#00e5ff" opacity={.8}/>
    </svg>
    <div ref={box} onMouseDown={dn} onDoubleClick={e=>e.stopPropagation()}
      style={{position:"absolute",left:pos.x,top:pos.y,background:"rgba(0,0,0,.88)",border:"1px solid #00e5ff66",
        borderRadius:3,padding:"3px 7px",cursor:"move",userSelect:"none",zIndex:52,minWidth:90,pointerEvents:"auto"}}>
      {(ann.vl||[]).map((l,i)=><div key={i} style={{fontSize:10,color:"#fff",whiteSpace:"nowrap",lineHeight:"1.5"}}>{l}</div>)}
      <div onMouseDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();onDelete(ann.id);}}
        style={{fontSize:9,color:"#ff5555",cursor:"pointer",marginTop:2,textAlign:"right"}}>✕ delete</div>
    </div>
  </>);
}

// ─── ShapeLayer ───────────────────────────────────────────────────────────────
function ShapeLayer({anns,canvasRef,wc,ww,onUpdate,drawing,toolActive}){
  const svgRef=useRef(),ds=useRef(null);
  const gp=useCallback(e=>{const r=svgRef.current?.getBoundingClientRect();return r?{x:e.clientX-r.left,y:e.clientY-r.top}:{x:0,y:0};},[]);
  const md=useCallback((e,id,mode,hid)=>{
    if(drawing)return;e.stopPropagation();e.preventDefault();
    const ann=anns.find(a=>a.id===id);if(!ann)return;
    const pt=gp(e);ds.current={id,mode,hid,sx:pt.x,sy:pt.y,a:{...ann,pts:ann.pts?[...ann.pts]:null}};
    const mv=ev=>{const d=ds.current;if(!d)return;const p=gp(ev),dx=p.x-d.sx,dy=p.y-d.sy;
      let u=d.mode==="move"?{...d.a,x1:d.a.x1+dx,y1:d.a.y1+dy,x2:d.a.x2+dx,y2:d.a.y2+dy,
        cx:d.a.cx!=null?d.a.cx+dx:undefined,cy:d.a.cy!=null?d.a.cy+dy:undefined,
        pts:d.a.pts?d.a.pts.map(p=>({x:p.x+dx,y:p.y+dy})):null}:applyHandle(d.a,d.hid,dx,dy);
      onUpdate(computeAnn(u,canvasRef,wc,ww));};
    const mu=()=>{ds.current=null;window.removeEventListener("mousemove",mv);window.removeEventListener("mouseup",mu);};
    window.addEventListener("mousemove",mv);window.addEventListener("mouseup",mu);},[anns,canvasRef,wc,ww,onUpdate,drawing,gp]);
  return(
    <svg ref={svgRef} style={{position:"absolute",inset:0,width:"100%",height:"100%",overflow:"visible",pointerEvents:(toolActive||drawing)?"none":"all",zIndex:42}}>
      {anns.map(ann=>{
        const handles=getHandles(ann);
        const x1=ann.x1,y1=ann.y1,x2=ann.x2,y2=ann.y2;
        const fpts=ann.pts,fhd=fpts?("M"+fpts.map(p=>p.x+","+p.y).join("L")):null;
        return(
          <g key={ann.id} style={{cursor:"move"}}>
            {ann.type==="line"&&<line x1={x1} y1={y1} x2={x2} y2={y2} stroke="rgba(0,0,0,.01)" strokeWidth={14} style={{pointerEvents:"stroke"}} onMouseDown={e=>md(e,ann.id,"move",null)}/>}
            {ann.type==="bezier"&&<path d={"M"+x1+","+y1+" C"+(typeof ann.cp1x==="number"?ann.cp1x:x1+(x2-x1)/3)+","+(typeof ann.cp1y==="number"?ann.cp1y:y1+(y2-y1)/3)+" "+(typeof ann.cp2x==="number"?ann.cp2x:x1+(x2-x1)*2/3)+","+(typeof ann.cp2y==="number"?ann.cp2y:y1+(y2-y1)*2/3)+" "+x2+","+y2} stroke="rgba(0,0,0,.01)" strokeWidth={14} fill="none" style={{pointerEvents:"stroke"}} onMouseDown={e=>md(e,ann.id,"move",null)}/>}
            {ann.type==="line_freehand"&&fhd&&<path d={fhd} stroke="rgba(0,0,0,.01)" strokeWidth={14} fill="none" style={{pointerEvents:"stroke"}} onMouseDown={e=>md(e,ann.id,"move",null)}/>}
            {ann.type==="oval"&&<ellipse cx={(x1+x2)/2} cy={(y1+y2)/2} rx={Math.abs(x2-x1)/2} ry={Math.abs(y2-y1)/2} stroke="rgba(0,0,0,.01)" strokeWidth={12} fill="rgba(0,0,0,.01)" style={{pointerEvents:"all"}} onMouseDown={e=>md(e,ann.id,"move",null)}/>}
            {ann.type==="circle"&&<circle cx={(x1+x2)/2} cy={(y1+y2)/2} r={Math.hypot(x2-x1,y2-y1)/2} stroke="rgba(0,0,0,.01)" strokeWidth={12} fill="rgba(0,0,0,.01)" style={{pointerEvents:"all"}} onMouseDown={e=>md(e,ann.id,"move",null)}/>}
            {(ann.type==="square"||ann.type==="rect")&&<rect x={Math.min(x1,x2)} y={Math.min(y1,y2)} width={Math.abs(x2-x1)} height={Math.abs(y2-y1)} stroke="rgba(0,0,0,.01)" strokeWidth={12} fill="rgba(0,0,0,.01)" style={{pointerEvents:"all"}} onMouseDown={e=>md(e,ann.id,"move",null)}/>}
            {ann.type==="freehand"&&fhd&&<path d={fhd+"Z"} stroke="rgba(0,0,0,.01)" strokeWidth={12} fill="rgba(0,0,0,.01)" style={{pointerEvents:"all"}} onMouseDown={e=>md(e,ann.id,"move",null)}/>}
            {renderShape(ann)}
            {handles.map(h=><rect key={h.id} x={h.x-HW/2} y={h.y-HW/2} width={HW} height={HW} rx={1.5} fill="#111" stroke="#00e5ff" strokeWidth={1} cursor={h.cur} onMouseDown={e=>md(e,ann.id,"handle",h.id)} style={{pointerEvents:"all"}}/>)}
          </g>);
      })}
    </svg>);
}

// ─── ViewerBox ────────────────────────────────────────────────────────────────
/**
 * Mouse combo binding tracker.
 * Watches which physical buttons are pressed and activates the combo tool.
 *
 * Button codes: 0 = left, 1 = middle, 2 = right
 *
 * Combos:
 *   Middle(1) + Right(2)  → draw straight line  (tool: "line")
 *   Middle(1) + Left(0)   → draw circular ROI   (tool: "circle")
 *   Right(2)  + Left(0)   → move annotations    (special: activates move mode)
 */
function useComboButtons(onCombo, onRelease) {
  const pressed = useRef(new Set());
  const active  = useRef(null);

  const down = useCallback((e) => {
    pressed.current.add(e.button);
    const btns = pressed.current;
    let next = null;
    if (btns.has(1) && btns.has(2)) next = "line";
    else if (btns.has(1) && btns.has(0)) next = "circle";
    else if (btns.has(2) && btns.has(0)) next = "__move__";
    if (next && next !== active.current) {
      active.current = next;
      onCombo(next);
    }
  }, [onCombo]);

  const up = useCallback((e) => {
    pressed.current.delete(e.button);
    // Release if neither button of the active combo is still held
    const btns = pressed.current;
    const stillActive =
      (active.current === "line"     && btns.has(1) && btns.has(2)) ||
      (active.current === "circle"   && btns.has(1) && btns.has(0)) ||
      (active.current === "__move__" && btns.has(2) && btns.has(0));
    if (!stillActive && active.current) {
      const prev = active.current;
      active.current = null;
      onRelease(prev);
    }
  }, [onRelease]);

  const leave = useCallback(() => {
    if (pressed.current.size > 0) {
      pressed.current.clear();
      if (active.current) { onRelease(active.current); active.current = null; }
    }
  }, [onRelease]);

  return { down, up, leave };
}

function ViewerBox({
  viewId, label, color, modality="CT", isExpanded, isHidden,
  onDoubleClick, wc, ww, onWL, suvMin=0, suvMax=10, onSUV,
}) {
  const cvs=useRef(null),ovl=useRef(null);
  const dp=useRef({wc,ww,label,color,paletteId:modality==="PET"?"hot_iron":"gray"});
  useEffect(()=>{dp.current={...dp.current,wc,ww,label,color};});
  const[preset,setPreset]=useState(null);
  const[paletteId,setPaletteId]=useState(modality==="PET"?"hot_iron":"gray");
  const[tool,setTool]=useState(null);
  const[anns,setAnns]=useState([]);
  const drawing=useRef(false),sp=useRef(null),fhp=useRef([]),bzp=useRef({x1:0,y1:0});
  const[preview,setPrev]=useState(null);
  const[isd,setIsd]=useState(false);
  // Combo state: when a combo activates, it overrides the toolbar tool temporarily
  const[comboTool,setComboTool]=useState(null);
  const[comboMove,setComboMove]=useState(false);

  const palettes = modality==="PET" ? PET_PALETTES : CT_PALETTES;
  const presets  = modality==="PET" ? PET_PRESETS  : CT_PRESETS;
  const activeTool = comboTool || tool; // combo takes precedence

  const redraw=useCallback(()=>{
    const c=cvs.current;if(!c||!c.width||!c.height)return;
    const{wc:w,ww:h,label:l,color:col}=dp.current;
    drawImage(c,w,h,l,col,paletteId,modality);
  },[paletteId,modality]);
  useEffect(()=>redraw(),[wc,ww,label,color,paletteId]);
  useEffect(()=>{
    const c=cvs.current;if(!c)return;
    const ro=new ResizeObserver(()=>{c.width=c.offsetWidth||200;c.height=c.offsetHeight||200;redraw();});
    ro.observe(c);setTimeout(()=>{c.width=c.offsetWidth||200;c.height=c.offsetHeight||200;redraw();},50);
    return()=>ro.disconnect();
  },[]);
  useEffect(()=>{if(!isHidden)setTimeout(()=>{const c=cvs.current;if(!c)return;c.width=c.offsetWidth||200;c.height=c.offsetHeight||200;redraw();},50);},[isHidden]);

  // ── Combo button handlers ────────────────────────────────────────────────
  const onCombo = useCallback((comboId) => {
    if(comboId==="__move__"){ setComboMove(true); setComboTool(null); }
    else { setComboTool(comboId); setComboMove(false); }
  },[]);
  const onComboRelease = useCallback((comboId) => {
    setComboTool(null); setComboMove(false);
  },[]);
  const combo = useComboButtons(onCombo, onComboRelease);

  // ── Mouse scroll → slice scroll (simulated in prototype) ────────────────
  const onWheel = useCallback((e) => {
    // In real CS3D integration, StackScrollMouseWheelTool handles this automatically.
    // In simulation: shift W/L level slightly as a visual feedback.
    e.preventDefault();
    const{wc:w,ww:h,onWL:cb}=dp.current;
    // (real: scroll slices; prototype: visual only)
  },[]);

  const gp=useCallback(e=>{const r=ovl.current?.getBoundingClientRect();return r?{x:e.clientX-r.left,y:e.clientY-r.top}:{x:0,y:0};},[]);
  const CD=12;

  // ── Drawing handlers (toolbar tool OR combo tool) ────────────────────────
  const onDown=useCallback(e=>{
    // Pass to combo tracker first (tracks all button presses)
    combo.down(e);
    // Only draw with left button (button 0) when a draw tool is active
    const effectiveTool = comboTool || tool;
    if(!effectiveTool || e.button!==0)return;
    // Don't draw in move mode
    if(comboMove)return;
    e.stopPropagation();const pt=gp(e);
    if(effectiveTool==="bezier"){drawing.current=true;setIsd(true);bzp.current={x1:pt.x,y1:pt.y,x2:pt.x,y2:pt.y};return;}
    drawing.current=true;setIsd(true);sp.current=pt;
    if(effectiveTool==="freehand"||effectiveTool==="line_freehand")fhp.current=[pt];
  },[tool,comboTool,comboMove,gp,combo]);

  const onMove=useCallback(e=>{
    if(!drawing.current)return;
    const effectiveTool=comboTool||tool;if(!effectiveTool)return;
    const pt=gp(e);
    if(effectiveTool==="bezier"){const b=bzp.current;const dx=pt.x-b.x1,dy=pt.y-b.y1;setPrev({type:"bezier",x1:b.x1,y1:b.y1,x2:pt.x,y2:pt.y,cp1x:b.x1+dx/3-dy*0.3,cp1y:b.y1+dy/3+dx*0.3,cp2x:b.x1+dx*2/3+dy*0.3,cp2y:b.y1+dy*2/3-dx*0.3});return;}
    if(effectiveTool==="freehand"||effectiveTool==="line_freehand"){fhp.current.push(pt);setPrev({type:effectiveTool,pts:[...fhp.current]});}
    else setPrev({type:effectiveTool,x1:sp.current.x,y1:sp.current.y,x2:pt.x,y2:pt.y});
  },[tool,comboTool,gp]);

  const onUp=useCallback(e=>{
    combo.up(e);
    if(!drawing.current)return;
    const effectiveTool=comboTool||tool;if(!effectiveTool)return;
    const pt=gp(e);
    drawing.current=false;setIsd(false);setPrev(null);
    if(effectiveTool==="bezier"){const b=bzp.current,dx=pt.x-b.x1,dy=pt.y-b.y1,d=Math.hypot(dx,dy);if(d<5)return;const a=buildAnn("bezier",{x:b.x1,y:b.y1},{x:pt.x,y:pt.y},null,cvs,wc,ww,{cp1x:b.x1+dx/3-dy*0.3,cp1y:b.y1+dy/3+dx*0.3,cp2x:b.x1+dx*2/3+dy*0.3,cp2y:b.y1+dy*2/3-dx*0.3});if(a)setAnns(prev=>[...prev,a]);return;}
    if(effectiveTool==="freehand"){const s=fhp.current[0],d=Math.hypot(pt.x-s.x,pt.y-s.y);if(d>CD&&fhp.current.length<5)return;const a=buildAnn("freehand",s,pt,[...fhp.current],cvs,wc,ww);if(a)setAnns(prev=>[...prev,a]);fhp.current=[];}
    else if(effectiveTool==="line_freehand"){if(fhp.current.length<2)return;const pts=[...fhp.current],s=pts[0],ep=pts[pts.length-1];const a=buildAnn("line_freehand",s,ep,pts,cvs,wc,ww);if(a)setAnns(prev=>[...prev,a]);fhp.current=[];}
    else{const d=Math.hypot(pt.x-sp.current.x,pt.y-sp.current.y);if(d<5)return;const a=buildAnn(effectiveTool,sp.current,pt,null,cvs,wc,ww);if(a)setAnns(prev=>[...prev,a]);}
  },[tool,comboTool,gp,wc,ww,combo]);

  const onClick=useCallback(e=>{
    const effectiveTool=comboTool||tool;
    if((effectiveTool!=="freehand"&&effectiveTool!=="line_freehand")||!drawing.current)return;
    const pt=gp(e),s=fhp.current[0];if(!s)return;
    if(Math.hypot(pt.x-s.x,pt.y-s.y)<=CD&&fhp.current.length>=3){drawing.current=false;setIsd(false);setPrev(null);const a=buildAnn("freehand",s,pt,[...fhp.current],cvs,wc,ww);if(a)setAnns(prev=>[...prev,a]);fhp.current=[];}
  },[tool,comboTool,gp,wc,ww]);

  const delAnn=useCallback(id=>setAnns(prev=>prev.filter(a=>a.id!==id)),[]);
  const updAnn=useCallback(u=>setAnns(prev=>prev.map(a=>a.id===u.id?u:a)),[]);

  if(isHidden)return null;

  const hasCombo = !!comboTool || comboMove;
  const cursorStyle = comboMove?"grab":(activeTool?"crosshair":"default");

  return(
    <div onDoubleClick={onDoubleClick}
      style={{position:"absolute",inset:0,overflow:"hidden",background:"#0a0a0a",
        border:"1.5px solid "+(isExpanded?color:"#252525"),borderRadius:3,
        display:"flex",flexDirection:"row",cursor:cursorStyle}}>
      <canvas ref={cvs} style={{flex:"1 1 0",minWidth:0,minHeight:0,display:"block"}}/>
      <div ref={ovl}
        onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onClick={onClick}
        onMouseLeave={combo.leave}
        onWheel={onWheel}
        onContextMenu={e=>e.preventDefault()}
        style={{position:"absolute",left:0,top:0,right:22,bottom:modality==="PET"?28:0,zIndex:35,
          pointerEvents:"all",cursor:cursorStyle}}/>
      {/* annotation preview + shapes */}
      <div style={{position:"absolute",inset:0,right:22,pointerEvents:"none",zIndex:40,overflow:"hidden"}}>
        {preview&&<svg style={{position:"absolute",inset:0,width:"100%",height:"100%",overflow:"visible",pointerEvents:"none"}}>{renderShape(preview)}</svg>}
        <ShapeLayer anns={anns} canvasRef={cvs} wc={wc} ww={ww} onUpdate={updAnn} drawing={isd} toolActive={!!activeTool||comboMove}/>
      </div>
      <div style={{position:"absolute",inset:0,right:22,pointerEvents:"none",zIndex:52,overflow:"hidden"}}>
        {anns.map(a=><AnnLabel key={a.id} ann={a} onDelete={delAnn}/>)}
      </div>
      {/* SUV bar — PET only */}
      {modality==="PET"&&<SUVBar suvMin={suvMin} suvMax={suvMax} onSUV={onSUV}/>}
      {/* Combo hint */}
      <div style={{position:"absolute",top:modality==="PET"?22:6,left:8,pointerEvents:"none",zIndex:45}}>
        {comboTool&&<span style={{fontSize:8,color:"#ffff00",background:"rgba(0,0,0,.7)",padding:"1px 4px",borderRadius:2}}>
          combo: {comboTool==="line"?"straight line":"circle ROI"}
        </span>}
        {comboMove&&<span style={{fontSize:8,color:"#ff9100",background:"rgba(0,0,0,.7)",padding:"1px 4px",borderRadius:2}}>
          move mode
        </span>}
      </div>
      <Strip wc={wc} ww={ww} paletteId={paletteId} palettes={palettes} onWL={(c,w)=>onWL(c,w)} onScale={setPaletteId}/>
      <ToolPicker activeTool={tool} onSelect={setTool}/>
      <PresetBar color={color} active={preset} presets={presets} onSelect={p=>{setPreset(p.label);onWL(p.wc,p.ww);}}/>
    </div>);
}

// ─── Main App — wired to Cornerstone3D + Orthanc ─────────────────────────────
/**
 * W/L SEPARATION RULE (never change):
 *   ctWL  (blue)  → CT viewports ONLY  (top row)
 *   petWL (green) → PET-CT viewports ONLY (bottom row)
 *   suvThreshold  → all PET-CT viewports simultaneously
 */

const STUDY_UID = "1.3.12.2.1107.5.1.4.60070.30000026012804495395400000013";
const DEF_CT_WL  = { wc:40,   ww:400   };
const DEF_PET_WL = { wc:5000, ww:10000 };
const DEF_SUV    = { min:0,   max:10   };

// ── Sync dropdown component ───────────────────────────────────────────────────
function SyncPanel({ sync, onSync, ctWL, setCTWL, petWL, setPETWL, suv, setSUV, onReset }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();

  // Close on outside click
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const anySynced = sync.scroll || sync.zoom || sync.pan;

  const Tog = ({ id, label, icon, color }) => {
    const on = sync[id];
    return (
      <div
        onMouseDown={e => { e.preventDefault(); onSync(id, !on); }}
        style={{
          display:'flex', alignItems:'center', gap:6, padding:'5px 10px',
          cursor:'pointer', borderRadius:3,
          background: on ? `${color}18` : 'transparent',
          border: `1px solid ${on ? color : '#2a2a2a'}`,
          userSelect:'none',
        }}
      >
        <span style={{fontSize:13}}>{icon}</span>
        <span style={{fontSize:10, color: on ? color : '#666', minWidth:40}}>{label}</span>
        <span style={{
          fontSize:8, padding:'1px 5px', borderRadius:8,
          background: on ? color : '#222', color: on ? '#000' : '#555',
          fontWeight:'bold',
        }}>{on ? 'ON' : 'OFF'}</span>
      </div>
    );
  };

  return (
    <div ref={ref} style={{position:'relative', marginLeft:'auto'}}>
      {/* Sync button */}
      <button
        onMouseDown={e => { e.preventDefault(); setOpen(p => !p); }}
        style={{
          background: anySynced ? 'rgba(0,229,255,.1)' : 'transparent',
          border: `1px solid ${anySynced ? '#00e5ff' : '#333'}`,
          color: anySynced ? '#00e5ff' : '#666',
          fontSize:10, padding:'4px 10px', cursor:'pointer', borderRadius:3,
          display:'flex', alignItems:'center', gap:6,
        }}
      >
        <span style={{fontSize:13}}>⇄</span>
        <span>SYNC</span>
        {anySynced && (
          <span style={{fontSize:8, color:'#00e5ff', opacity:.7}}>
            {[sync.scroll&&'scroll', sync.zoom&&'zoom', sync.pan&&'pan'].filter(Boolean).join('+')}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position:'absolute', top:'100%', right:0, marginTop:4,
          background:'#0d0d0d', border:'1px solid #333', borderRadius:4,
          boxShadow:'0 8px 32px rgba(0,0,0,.9)',
          padding:'10px', zIndex:200, minWidth:280,
        }}
          onDoubleClick={e => e.stopPropagation()}
        >
          {/* Sync toggles */}
          <div style={{fontSize:9, color:'#555', marginBottom:6, letterSpacing:1, textTransform:'uppercase'}}>
            Sync across all 6 viewports (MIP excluded)
          </div>
          <div style={{display:'flex', gap:6, marginBottom:10}}>
            <Tog id="scroll" label="Scroll"  icon="⇕" color="#00e5ff" />
            <Tog id="zoom"   label="Zoom"    icon="⊕" color="#88c4ff" />
            <Tog id="pan"    label="Pan"     icon="✥" color="#88dd88" />
          </div>

          <div style={{borderTop:'1px solid #1e1e1e', marginBottom:10}}/>

          {/* CT W/L — blue */}
          <div style={{marginBottom:8}}>
            <div style={{fontSize:9, color:'#88c4ff', marginBottom:4}}>CT Window / Level</div>
            <div style={{display:'flex', alignItems:'center', gap:6}}>
              <span style={{fontSize:9, color:'#555', minWidth:22}}>WW</span>
              <input type="range" min={1} max={4000} value={ctWL.ww}
                onChange={e => setCTWL(p => ({...p, ww:+e.target.value}))}
                style={{flex:1, accentColor:'#88c4ff'}}/>
              <span style={{fontSize:9, color:'#88c4ff', minWidth:36}}>{ctWL.ww}</span>
            </div>
            <div style={{display:'flex', alignItems:'center', gap:6}}>
              <span style={{fontSize:9, color:'#555', minWidth:22}}>WC</span>
              <input type="range" min={-1000} max={2000} value={ctWL.wc}
                onChange={e => setCTWL(p => ({...p, wc:+e.target.value}))}
                style={{flex:1, accentColor:'#88c4ff'}}/>
              <span style={{fontSize:9, color:'#88c4ff', minWidth:36}}>{ctWL.wc}</span>
            </div>
          </div>

          {/* PET W/L — green */}
          <div style={{marginBottom:8}}>
            <div style={{fontSize:9, color:'#88dd88', marginBottom:4}}>PET Window / Level</div>
            <div style={{display:'flex', alignItems:'center', gap:6}}>
              <span style={{fontSize:9, color:'#555', minWidth:22}}>WW</span>
              <input type="range" min={1} max={30000} value={petWL.ww}
                onChange={e => setPETWL(p => ({...p, ww:+e.target.value}))}
                style={{flex:1, accentColor:'#88dd88'}}/>
              <span style={{fontSize:9, color:'#88dd88', minWidth:46}}>{petWL.ww}</span>
            </div>
            <div style={{display:'flex', alignItems:'center', gap:6}}>
              <span style={{fontSize:9, color:'#555', minWidth:22}}>WC</span>
              <input type="range" min={0} max={15000} value={petWL.wc}
                onChange={e => setPETWL(p => ({...p, wc:+e.target.value}))}
                style={{flex:1, accentColor:'#88dd88'}}/>
              <span style={{fontSize:9, color:'#88dd88', minWidth:46}}>{petWL.wc}</span>
            </div>
          </div>

          {/* SUV threshold — amber */}
          <div style={{marginBottom:10}}>
            <div style={{fontSize:9, color:'#ffcc66', marginBottom:4}}>SUV Threshold (all PET-CT)</div>
            <div style={{display:'flex', alignItems:'center', gap:6}}>
              <span style={{fontSize:9, color:'#555', minWidth:22}}>min</span>
              <input type="range" min={0} max={20} step={0.1} value={suv.min}
                onChange={e => setSUV(p => ({...p, min:+e.target.value}))}
                style={{flex:1, accentColor:'#ffcc66'}}/>
              <span style={{fontSize:9, color:'#ffcc66', minWidth:30}}>{suv.min.toFixed(1)}</span>
            </div>
            <div style={{display:'flex', alignItems:'center', gap:6}}>
              <span style={{fontSize:9, color:'#555', minWidth:22}}>max</span>
              <input type="range" min={0} max={30} step={0.5} value={suv.max}
                onChange={e => setSUV(p => ({...p, max:+e.target.value}))}
                style={{flex:1, accentColor:'#ffcc66'}}/>
              <span style={{fontSize:9, color:'#ffcc66', minWidth:30}}>{suv.max.toFixed(1)}</span>
            </div>
          </div>

          <div style={{borderTop:'1px solid #1e1e1e', paddingTop:8}}>
            <button
              onMouseDown={e => { e.preventDefault(); onReset(); }}
              style={{
                background:'transparent', border:'1px solid #333', color:'#666',
                fontSize:9, padding:'3px 12px', cursor:'pointer', borderRadius:2, width:'100%',
              }}
            >
              Reset all W/L to defaults
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App(){
  const [exp,        setExp]        = useState(null);
  const [ctWL,       setCTWL]       = useState(DEF_CT_WL);
  const [petWL,      setPETWL]      = useState(DEF_PET_WL);
  const [suv,        setSUV]        = useState(DEF_SUV);
  const [petOpacity, setPetOpacity] = useState(0.6);
  const [activeToolCT,  setActiveToolCT]  = useState(null);
  const [activeToolPET, setActiveToolPET] = useState(null);
  // Sync state — scroll ON by default, zoom/pan OFF
  const [sync, setSync] = useState({ scroll: true, zoom: false, pan: false });

  const onSync  = (key, val) => setSync(p => ({ ...p, [key]: val }));
  const resetAll = () => { setCTWL(DEF_CT_WL); setPETWL(DEF_PET_WL); setSUV(DEF_SUV); };

  return (
    <div style={{background:"#050505",height:"100vh",display:"flex",flexDirection:"column",
      fontFamily:"monospace",color:"#ccc",overflow:"hidden"}}>

      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div style={{background:"#0d0d0d",borderBottom:"1px solid #1a1a1a",padding:"5px 14px",
        display:"flex",alignItems:"center",gap:12,flexShrink:0}}>

        <span style={{fontSize:12,fontWeight:"bold",color:"#88c4ff",letterSpacing:2}}>
          PET-CT VIEWER
        </span>
        <span style={{fontSize:9,color:"#333",borderLeft:"1px solid #222",paddingLeft:10}}>
          Phase 2
        </span>

        {/* Quick W/L display — read only, editing in Sync panel */}
        <div style={{display:"flex",alignItems:"center",gap:8,marginLeft:12}}>
          <span style={{fontSize:9,color:"#555"}}>CT:</span>
          <span style={{fontSize:9,color:"#88c4ff"}}>W{ctWL.ww}/L{ctWL.wc}</span>
          <span style={{fontSize:9,color:"#555",marginLeft:6}}>PET:</span>
          <span style={{fontSize:9,color:"#88dd88"}}>W{petWL.ww}/L{petWL.wc}</span>
          <span style={{fontSize:9,color:"#555",marginLeft:6}}>SUV:</span>
          <span style={{fontSize:9,color:"#ffcc66"}}>{suv.min.toFixed(1)}–{suv.max.toFixed(1)}</span>
        </div>

        {/* Mouse hint */}
        <div style={{display:"flex",gap:10,marginLeft:12}}>
          <span style={{fontSize:9,color:"#444"}}>
            <span style={{color:"#666"}}>L</span>=Pan
          </span>
          <span style={{fontSize:9,color:"#444"}}>
            <span style={{color:"#666"}}>R</span>=Zoom
          </span>
          <span style={{fontSize:9,color:"#444"}}>
            <span style={{color:"#666"}}>⊕</span>=Scroll
          </span>
          <span style={{fontSize:9,color:"#333"}}>|</span>
          <span style={{fontSize:9,color:"#444"}}>
            <span style={{color:"#ffcc66"}}>M+R</span>=Line
          </span>
          <span style={{fontSize:9,color:"#444"}}>
            <span style={{color:"#ffcc66"}}>M+L</span>=ROI
          </span>
          <span style={{fontSize:9,color:"#444"}}>
            <span style={{color:"#ffcc66"}}>R+L</span>=Move
          </span>
        </div>

        {/* Sync button — rightmost, contains all sliders */}
        <SyncPanel
          sync={sync} onSync={onSync}
          ctWL={ctWL} setCTWL={setCTWL}
          petWL={petWL} setPETWL={setPETWL}
          suv={suv} setSUV={setSUV}
          onReset={resetAll}
        />
      </div>

      {/* ── ViewportGrid ─────────────────────────────────────────────────── */}
      <div style={{flex:1,minHeight:0,display:'flex',flexDirection:'column',overflow:'hidden'}}>
        <ViewportGrid
          studyUID={STUDY_UID}
          ctWL={ctWL}          petWL={petWL}
          onCTWL={setCTWL}     onPETWL={setPETWL}
          suvThreshold={suv}   onSUV={setSUV}
          petOpacity={petOpacity} onOpacity={setPetOpacity}
          activeToolCT={activeToolCT}
          activeToolPET={activeToolPET}
          expandedId={exp}     onExpand={setExp}
          syncScroll={sync.scroll}
          syncZoom={sync.zoom}
          syncPan={sync.pan}
        />
      </div>

      {/* ── Status bar ───────────────────────────────────────────────────── */}
      <div style={{background:"#0d0d0d",borderTop:"1px solid #141414",padding:"3px 14px",
        display:"flex",gap:14,fontSize:9,color:"#444",flexShrink:0}}>
        <span style={{color:"#88c4ff"}}>CT W{ctWL.ww}/L{ctWL.wc}</span>
        <span style={{color:"#333"}}>|</span>
        <span style={{color:"#88dd88"}}>PET W{petWL.ww}/L{petWL.wc}</span>
        <span style={{color:"#333"}}>|</span>
        <span style={{color:"#ffcc66"}}>SUV {suv.min.toFixed(1)}–{suv.max.toFixed(1)}</span>
        <span style={{color:"#333"}}>|</span>
        <span style={{color: sync.scroll?'#00e5ff':'#333'}}>scroll{sync.scroll?' ⇄':''}</span>
        <span style={{color: sync.zoom?'#88c4ff':'#333'}}>zoom{sync.zoom?' ⇄':''}</span>
        <span style={{color: sync.pan?'#88dd88':'#333'}}>pan{sync.pan?' ⇄':''}</span>
        <span style={{marginLeft:"auto",color:"#333"}}>Double-click to expand</span>
      </div>
    </div>
  );
}


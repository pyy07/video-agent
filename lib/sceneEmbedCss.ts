/** iframe 嵌入：contain 等比适配，不放大裁剪；编码端不再二次缩放 */

export const SCENE_EMBED_STYLE_ID = "video-agent-scene-embed";
export const SCENE_EMBED_SCRIPT_ID = "video-agent-embed-script";

export type SceneEmbedFit = "contain";

export function buildSceneEmbedCss(logicalWidth: number, logicalHeight: number): string {
  return `
html, body {
  width: 100% !important;
  height: 100% !important;
  min-height: 0 !important;
  max-height: 100% !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  background: #000 !important;
}
body {
  display: block !important;
  position: relative !important;
}
#video-agent-embed-wrap {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: #000;
}
#video-agent-embed-outer {
  overflow: hidden;
  flex-shrink: 0;
  position: relative;
}
.video-canvas {
  width: ${logicalWidth}px !important;
  height: ${logicalHeight}px !important;
  max-width: none !important;
  aspect-ratio: auto !important;
  margin: 0 !important;
  transform-origin: top left !important;
  border: none !important;
  box-shadow: none !important;
}
`;
}

export function buildSceneEmbedScript(logicalWidth: number, logicalHeight: number): string {
  return `(function(){
var LW=${logicalWidth},LH=${logicalHeight};
var canvas=document.querySelector(".video-canvas");
if(!canvas)return;
var wrap=document.getElementById("video-agent-embed-wrap");
var outer=document.getElementById("video-agent-embed-outer");
if(!wrap){
  wrap=document.createElement("div");
  wrap.id="video-agent-embed-wrap";
  document.body.appendChild(wrap);
}
if(!outer){
  outer=document.createElement("div");
  outer.id="video-agent-embed-outer";
  wrap.appendChild(outer);
}
if(canvas.parentNode!==outer){outer.appendChild(canvas);}
function supportsZoom(){
  try{
    var t=document.createElement("div");
    t.style.zoom="1";
    return t.style.zoom==="1";
  }catch(e){return false;}
}
var useZoom=supportsZoom();
function fit(){
  var w=wrap.clientWidth,h=wrap.clientHeight;
  if(w<2||h<2){requestAnimationFrame(fit);return;}
  var s=Math.min(w/LW,h/LH);
  outer.style.width=Math.round(LW*s)+"px";
  outer.style.height=Math.round(LH*s)+"px";
  canvas.style.width=LW+"px";
  canvas.style.height=LH+"px";
  canvas.style.transformOrigin="top left";
  if(useZoom){
    canvas.style.zoom=s;
    canvas.style.transform="none";
  }else{
    canvas.style.zoom="";
    canvas.style.transform="scale("+s+")";
  }
}
if(typeof ResizeObserver!=="undefined"){
  new ResizeObserver(fit).observe(wrap);
}else{
  window.addEventListener("resize",fit);
}
fit();
})();`;
}

export function injectSceneEmbedCss(
  html: string,
  logicalWidth = 1280,
  logicalHeight = 720,
): string {
  if (html.includes(`id="${SCENE_EMBED_STYLE_ID}"`)) return html;
  const styleTag = `<style id="${SCENE_EMBED_STYLE_ID}">${buildSceneEmbedCss(logicalWidth, logicalHeight)}</style>`;
  const scriptTag = `<script id="${SCENE_EMBED_SCRIPT_ID}">${buildSceneEmbedScript(logicalWidth, logicalHeight)}</script>`;
  let result = html;
  if (/<\/head>/i.test(result)) {
    result = result.replace(/<\/head>/i, `${styleTag}\n</head>`);
  } else {
    result = `${styleTag}${result}`;
  }
  if (/<\/body>/i.test(result)) {
    result = result.replace(/<\/body>/i, `${scriptTag}\n</body>`);
  } else {
    result = `${result}${scriptTag}`;
  }
  return result;
}

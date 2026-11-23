export const ACCENTS=[['Neutral','#52525b'],['Blue','#2563eb'],['Green','#15803d'],['Purple','#7c3aed'],['Rose','#be185d'],['Orange','#c2410c']];
export const safeAccent=value=>/^#[a-f0-9]{6}$/i.test(value||'')?value:'#52525b';
export function applyAccent(value,element=document.documentElement){const color=safeAccent(value),rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)),luma=rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);element.style.setProperty('--accent',color);element.style.setProperty('--accent-rgb',rgb.join(','));element.style.setProperty('--on-accent',luma>.179?'#111111':'#ffffff');}

export function resolveTheme(preference,browserDark,native=globalThis.StudioNative){
 if(preference==='dark'||preference==='light')return preference;
 try{if(typeof native?.isSystemDark==='function')return native.isSystemDark()?'dark':'light'}catch{}
 return browserDark?'dark':'light';
}

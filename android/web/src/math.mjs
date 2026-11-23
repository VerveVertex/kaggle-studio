// Normalize model-produced TeX delimiters outside Markdown code; persisted text is untouched.
export function normalizeMath(source){
 const parts=String(source||'').split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`+[^`\n]*`+)/g);
 return parts.map((part,i)=>i%2?part:part
  .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/g,(_,math)=>'\n\n$$\n'+math.trim()+'\n$$\n\n')
  .replace(/(?<!\\)\\\(([^\n]*?)(?<!\\)\\\)/g,(_,math)=>'$'+math+'$')).join('');
}

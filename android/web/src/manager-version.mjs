// Notebook reuse and configurable context require the corrected manager.
export function managerNeedsRepair(build,minimum='0.3.0'){
 const parse=value=>{const m=/^(\d+)\.(\d+)\.(\d+)(?:-preview\.(\d+))?$/.exec(value||'');return m?[+m[1],+m[2],+m[3],m[4]===undefined?Infinity:+m[4]]:null};
 const current=parse(build),required=parse(minimum);if(!current||!required)return false;
 for(let i=0;i<4;i++){if(current[i]<required[i])return true;if(current[i]>required[i])return false}return false;
}

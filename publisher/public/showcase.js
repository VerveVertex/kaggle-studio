(()=>{
 const tabs=[...document.querySelectorAll('[data-mode]')];
 function select(tab,focus=false){for(const node of tabs){const active=node===tab;node.setAttribute('aria-selected',String(active));node.tabIndex=active?0:-1;document.getElementById('panel-'+node.dataset.mode).hidden=!active}if(focus)tab.focus()}
 for(const tab of tabs){tab.addEventListener('click',()=>select(tab));tab.addEventListener('keydown',e=>{const index=tabs.indexOf(tab);let next;if(e.key==='ArrowRight')next=(index+1)%tabs.length;if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;if(e.key==='Home')next=0;if(e.key==='End')next=tabs.length-1;if(next!==undefined){e.preventDefault();select(tabs[next],true)}})}
})();

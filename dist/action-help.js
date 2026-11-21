// Hold an action for one second to read its explanation without activating it.
export function installActionHelp() {
 let timer,press,blocked,tip,described;
 const control=target=>target?.closest?.('button,a');
 const helpFor=button=>button?.nextElementSibling?.matches('.action-help')?button.nextElementSibling:null;
 const cancel=()=>{clearTimeout(timer);timer=null;press=null;};
 const hide=()=>{tip?.remove();tip=null;if(described){const {button,previous}=described;if(previous===null)button.removeAttribute('aria-describedby');else button.setAttribute('aria-describedby',previous);described=null;}};
 function show(button) {
  const help=helpFor(button);if(!help||!button.isConnected)return;
  hide();tip=document.createElement('div');tip.id='held-action-help';tip.className='action-hold-tooltip';tip.role='tooltip';tip.textContent=help.textContent;document.body.append(tip);
  described={button,previous:button.getAttribute('aria-describedby')};button.setAttribute('aria-describedby',[described.previous,tip.id].filter(Boolean).join(' '));
  const rect=button.getBoundingClientRect(),box=tip.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(rect.left,innerWidth-box.width-8))+'px';tip.style.top=Math.max(8,rect.bottom+8+box.height<=innerHeight?rect.bottom+8:rect.top-box.height-8)+'px';
 }
 document.addEventListener('pointerdown',event=>{
  cancel();hide();blocked=null;
  const button=control(event.target);if(event.button!==0||!helpFor(button)||button.disabled)return;
  press={button,id:event.pointerId,x:event.clientX,y:event.clientY};
  timer=setTimeout(()=>{if(!press)return;blocked=button;show(button);},1000);
 },true);
 document.addEventListener('pointermove',event=>{if(press&&event.pointerId===press.id&&Math.hypot(event.clientX-press.x,event.clientY-press.y)>10){cancel();hide();}},true);
 document.addEventListener('pointerout',event=>{if(press&&!press.button.contains(event.relatedTarget)){cancel();}},true);
 document.addEventListener('pointerup',cancel,true);
 document.addEventListener('pointercancel',()=>{cancel();hide();},true);
 document.addEventListener('click',event=>{if(blocked&&control(event.target)===blocked){event.preventDefault();event.stopImmediatePropagation();blocked=null;}},true);
 document.addEventListener('contextmenu',event=>{if(helpFor(control(event.target)))event.preventDefault();},true);
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){cancel();hide();}else if(event.key==='F1'&&helpFor(control(event.target))){event.preventDefault();show(control(event.target));}},true);
 document.addEventListener('scroll',()=>{cancel();hide();},true);
 window.addEventListener('blur',()=>{cancel();hide();});
 window.addEventListener('resize',hide);
}

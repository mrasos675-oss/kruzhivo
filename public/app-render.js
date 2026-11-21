import { upgradeLinks } from '/portal-router.js';

// Keep unchanged navigation attached while live results refresh in the main area.
export function renderApp(root, html) {
 const template=document.createElement('template');template.innerHTML=html;upgradeLinks(template.content);
 const oldShell=root.firstElementChild,newShell=template.content.firstElementChild;
 if(oldShell?.classList.contains('shell')&&newShell?.classList.contains('shell')){
  const oldSidebar=oldShell.querySelector(':scope > .sidebar'),newSidebar=newShell.querySelector(':scope > .sidebar');
  const oldMain=oldShell.querySelector(':scope > .main'),newMain=newShell.querySelector(':scope > .main');
  if(oldSidebar&&newSidebar&&oldMain&&newMain){
   oldShell.className=newShell.className;
   if(oldSidebar.outerHTML!==newSidebar.outerHTML){
    const oldAvatar=oldSidebar.querySelector('img.sidebar-avatar'),newAvatar=newSidebar.querySelector('img.sidebar-avatar');
    if(oldAvatar&&newAvatar&&oldAvatar.getAttribute('src')===newAvatar.getAttribute('src'))newAvatar.replaceWith(oldAvatar);
    oldSidebar.replaceWith(newSidebar);
   }
   oldMain.replaceWith(newMain);return;
  }
 }
 root.replaceChildren(template.content);
}

// An active analysis updates its content only; navigation and main stay attached.
export function renderAnalysis(root, html) {
 const template=document.createElement('template');template.innerHTML=html;upgradeLinks(template.content);
 const current=root.querySelector('.content'),next=template.content.querySelector('.content');
 if(current&&next)current.replaceChildren(...next.childNodes);
 const crumbs=root.querySelector('.breadcrumbs'),nextCrumbs=template.content.querySelector('.breadcrumbs');
 if(crumbs&&nextCrumbs&&crumbs.innerHTML!==nextCrumbs.innerHTML)crumbs.replaceChildren(...nextCrumbs.childNodes);
}

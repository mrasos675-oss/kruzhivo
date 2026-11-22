import { moscowTime } from '../shared/report-format.mjs';
import { wordReport } from './word-layout.mjs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fail, xmlEscape, zipFiles } from './files.mjs';

const hash=s=>createHash('sha256').update(s).digest('hex');
const now=()=>new Date().toISOString();
const text=(s,max=10000)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw fail('Заполните текст допустимой длины.',400);return s.trim();};
const find=(db,id)=>{const c=(db.expertCases||[]).find(c=>c.id===id);if(!c)throw fail('Экспертиза не найдена.',404);return c;};
function findActive(db,id){
 const c=find(db,id);
 if(c.archivedAt)throw fail('Архивное дело доступно только для просмотра.',409);
 return c;
}
const role=(c,actor)=>c.ownerId===actor?'official':c.expertId===actor?'expert':null;
const authorize=(c,actor,wanted)=>{const r=role(c,actor);if(!r||wanted&&r!==wanted)throw fail('Экспертиза недоступна этому пользователю.',403);return r;};
function status(c){return !c.expertId||c.queued&&!c.startedAt?'waiting':c.conclusions.at(-1)?.status==='confirmed'?'confirmed':'reviewing';}
function view(c,actor){const result=structuredClone(c);delete result.ownerId;delete result.expertId;delete result.invitationHash;delete result.invitationExpiresAt;result.role=role(c,actor);result.status=status(c);return result;}
const draft=number=>({number,revision:0,status:'draft',text:'',createdAt:now()});

export function createExpertReview(store,actor,{trainingReader=false}={}) {
  async function ready(){if(store.ensure)await store.ensure();}
  const change=async fn=>{await ready();return store.change(fn);};
  const read=async()=>(await store.ensure?.())??store.read();
  return {
    async list(){return (await read()).expertCases?.filter(c=>role(c,actor)&&!c.archivedAt).map(c=>({id:c.id,name:c.document.name,kind:c.document.kind||null,level:c.document.level||null,territory:c.document.territory||null,confirmedAt:c.conclusions.filter(d=>d.status==='confirmed').at(-1)?.confirmedAt||null,version:c.document.number,runNumber:c.run.number||null,runId:c.run.id,role:role(c,actor),isDemo:c.run.mode==='demo'||!!c.document.sample,createdAt:c.createdAt,requestedBy:c.requestedBy||'',expertName:c.expertProfile?.name||'',status:status(c),messages:c.messages.length}))||[];},
    async history(){
      return ((await read()).expertCases||[]).flatMap(c=>{
        if(!c.trainingArchive||!c.archivedAt)return [];
        if(!role(c,actor))return trainingReader&&c.legacyHistoryNotice?
          [{name:'Учебное дело из старого кабинета',archivedAt:c.archivedAt,unlinked:true}]:[];
        return [{id:c.id,name:c.document.name,kind:c.document.kind||null,version:c.document.number,archivedAt:c.archivedAt}];
      }).sort((a,b)=>b.archivedAt.localeCompare(a.archivedAt));
    },
    async get(id){
      const c=find(await read(),id);authorize(c,actor);
      return view(c,actor);
    },
    async create(doc,version,run,options={}){
      if(run.findings.some(f=>!['confirmed','modified','rejected'].includes(f.decision?.status)||!(f.decision.revision>0||f.decision.savedAt)))throw fail('Сначала сохраните решение по каждому замечанию.',409);
      if(run.status!=='completed')throw fail('Сначала завершите проверку ИИ.',409);
      if(options.expertId===actor)throw fail('Нельзя пригласить себя.',409);
      const comment=options.comment?text(options.comment,3000):'';
      const token=randomBytes(32).toString('base64url');
      return change(db=>{
        db.expertCases ||= [];
        const existing=db.expertCases.find(c=>!c.archivedAt&&c.ownerId===actor&&c.run.id===run.id&&(c.expertId||null)===(options.expertId||null));
        if(existing)return {id:existing.id,existing:true,assigned:!!existing.expertId};
        if(db.expertCases.filter(c=>!c.archivedAt).length>=20)throw fail('Лимит демки — 20 активных экспертных дел.',413);
        const c={id:randomUUID(),requestedBy:db.profile?.fullName||options.requestedBy||'',ownerId:actor,expertId:options.expertId||null,invitationHash:options.expertId?null:hash(token),invitationExpiresAt:options.expertId?null:Date.now()+7*86400000,createdAt:now(),document:{name:doc.name,kind:doc.kind||null,level:doc.level||null,territory:doc.territory||null,number:version.number,text:version.text,hash:version.hash,sample:!!doc.sample},run:{id:run.id,number:run.number,mode:run.mode,model:run.model,findings:structuredClone(run.findings),sources:structuredClone(run.sources),coverage:structuredClone(run.coverage),limitations:structuredClone(run.limitations)},expertProfile:options.profile?{...structuredClone(options.profile),verification:'declared-not-verified',authentication:'password-account'}:null,requestComment:comment,...(options.queued?{queued:true}:{}),messages:[],conclusions:options.expertId?[draft(1)]:[]};
        db.expertCases.push(c);return options.expertId?{id:c.id,assigned:true}:{id:c.id,token};
      });
    },
    async archiveEmptyDemoDuplicates(){return change(db=>{
      const own=(db.expertCases||[]).filter(c=>c.ownerId===actor&&!c.archivedAt&&(c.run.mode==='demo'||c.document.sample)),groups=new Map();let archived=0;
      for(const c of own){const key=c.run.id+'|'+c.expertId;const list=groups.get(key)||[];list.push(c);groups.set(key,list);}
      for(const list of groups.values()){list.sort((a,b)=>Number(b.conclusions.some(d=>d.status==='confirmed'||d.text)||b.messages.length)-Number(a.conclusions.some(d=>d.status==='confirmed'||d.text)||a.messages.length));for(const c of list.slice(1)){if(c.messages.length||c.conclusions.some(d=>d.text||d.status==='confirmed'))continue;c.archivedAt=now();archived++;}}
      return {archived};
    });},
    async accept(id,token,profile){
      const name=text(profile?.name,200),registryNumber=text(profile?.registryNumber,200);
      return change(db=>{const c=findActive(db,id);if(c.ownerId===actor)throw fail('Откройте приглашение в отдельном браузере эксперта.',409);
        if(c.expertId||c.invitationExpiresAt<Date.now()||typeof token!=='string'||!/^[\w-]{43}$/.test(token)||hash(token)!==c.invitationHash)throw fail('Приглашение недействительно или уже использовано.',403);
        c.expertId=actor;c.expertProfile={name,registryNumber,verification:'declared-not-verified',...(profile.accountId?{accountId:profile.accountId,username:profile.username,authentication:'password-account'}:{})};c.invitationHash=null;c.invitationExpiresAt=null;c.acceptedAt=now();c.conclusions.push(draft(1));return {id};});
    },
    async assign(id,expertId,profile){return change(db=>{const c=findActive(db,id);authorize(c,actor,'official');if(c.expertId||expertId===actor)throw fail('Нельзя назначить этого эксперта.',409);c.expertId=expertId;c.expertProfile={...structuredClone(profile),verification:'declared-not-verified',authentication:'password-account'};c.invitationHash=null;c.invitationExpiresAt=null;c.acceptedAt=now();c.conclusions.push(draft(1));return {id};});},
    async invite(id){const token=randomBytes(32).toString('base64url');return change(db=>{const c=findActive(db,id);authorize(c,actor,'official');if(c.expertId)throw fail('Эксперт уже принял приглашение.',409);c.invitationHash=hash(token);c.invitationExpiresAt=Date.now()+7*86400000;return {id,token};});},
    async start(id){
      return change(db=>{
        const c=findActive(db,id);authorize(c,actor,'expert');
        if(!c.queued)throw fail('Дело не находится в общей очереди.',409);
        c.startedAt ||= now();
        return {ok:true};
      });
    },
    async message(id,value){const body=text(value,3000);return change(db=>{const c=findActive(db,id),r=authorize(c,actor);if(c.messages.length>=100)throw fail('Лимит переписки достигнут.',413);c.messages.push({id:randomUUID(),role:r,author:r==='expert'?c.expertProfile.name:'Госслужащий',text:body,at:now()});return {ok:true};});},
    async newDraft(id){return change(db=>{const c=findActive(db,id);authorize(c,actor,'expert');if(c.conclusions.at(-1)?.status!=='confirmed')throw fail('Сначала подтвердите текущую версию.',409);if(c.conclusions.length>=40)throw fail('Лимит демки — 40 версий заключения.',413);c.conclusions.push(draft(c.conclusions.length+1));return {ok:true};});},
    async save(id,value,revision,includeSnapshot=false){const body=text(value,15000);return change(db=>{const c=findActive(db,id);authorize(c,actor,'expert');if(c.queued&&!c.startedAt)throw fail('Нажмите «Взять в работу».',409);const d=c.conclusions.at(-1);if(d?.status!=='draft')throw fail('Подтверждённая версия закрыта для изменений.',409);if(d.revision!==revision)throw fail('Черновик изменён в другой вкладке. Обновите страницу.',409);d.text=body;d.revision++;d.savedAt=now();return includeSnapshot?{ok:true,revision:d.revision,history:{runId:c.run.id,conclusion:structuredClone(d)}}:{ok:true,revision:d.revision};});},
    async sign(id,revision,includeSnapshot=false,currentText=undefined){return change(db=>{const c=findActive(db,id);authorize(c,actor,'expert');if(c.queued&&!c.startedAt)throw fail('Нажмите «Взять в работу».',409);const d=c.conclusions.at(-1);if(d?.status!=='draft'||d.revision!==revision)throw fail('Версия уже подтверждена или изменена. Обновите страницу.',409);if(currentText!==undefined)d.text=text(currentText,15000);else text(d.text,15000);d.status='confirmed';d.confirmedAt=now();d.confirmation={method:'in-app-confirmation',expert:structuredClone(c.expertProfile),actorFingerprint:hash(actor),documentHash:c.document.hash,textHash:hash(d.text),runId:c.run.id};d.revision++;return includeSnapshot?{ok:true,history:{runId:c.run.id,conclusion:structuredClone(d)}}:{ok:true};});},
  };
}

export function expertDocx(c,number){
  const d=c.conclusions.find(x=>x.number===number&&x.status==='confirmed');if(!d)throw fail('Подтверждённое заключение не найдено.',404);
  const rows=['Заключение эксперта',c.document.name+' · версия документа '+c.document.number,'Версия заключения '+d.number,d.text,'Подтверждено в системе: '+moscowTime(d.confirmedAt),'Эксперт: '+d.confirmation.expert.name,'Заявленные реквизиты: '+d.confirmation.expert.registryNumber,'Аккредитация и личность автоматически не проверены. Подтверждение внутри системы; файл не содержит квалифицированной электронной подписи.',...(c.run.mode==='demo'?['Демонстрационный документ.']:[]),'SHA-256 документа: '+d.confirmation.documentHash,'SHA-256 заключения: '+d.confirmation.textHash];
  return zipFiles(wordReport(rows,{title:'Заключение независимого эксперта',skip:3,metadata:[['Документ',c.document.name],['Версия документа',String(c.document.number)],['Версия заключения',String(d.number)],['Автор-госслужащий',c.requestedBy||'Не указан'],['Эксперт',d.confirmation.expert.name],['Дата подтверждения',moscowTime(d.confirmedAt)]]}));
}




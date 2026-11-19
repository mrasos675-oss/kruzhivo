import { fail } from './files.mjs';
const text=(v,max,required=false)=>{if(v==null&&!required)return '';if(typeof v!=='string'||v.length>max||required&&!v.trim())throw fail('Проверьте обязательные поля и длину текста.',400);return v.trim();};
export function validateProfile(b,previous={}){
 const p={revision:(previous.revision||0)+1,fullName:text(b.fullName,200,true),organization:text(b.organization,250,true),department:text(b.department,200,true),position:text(b.position,200,true),field:text(b.field,150),experience:text(b.experience,50),goals:text(b.goals,1500),registryNumber:text(b.registryNumber,200),avatar:previous.avatar||'',updatedAt:new Date().toISOString()};
 if(b.removeAvatar===true)p.avatar='';
 if(b.avatar){
  if(typeof b.avatar!=='string'||b.avatar.length>180000)throw fail('Фото слишком большое. Выберите изображение до 5 МБ.',400);
  const m=b.avatar.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);if(!m)throw fail('Используйте JPEG, PNG или WebP.',400);
  const bytes=Buffer.from(m[2],'base64');const valid=m[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:m[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
  if(!valid)throw fail('Не удалось распознать изображение.',400);p.avatar=b.avatar;
 }
 return p;
}

export function demoProfileFor(account){
 if(!['demo-official-v1','demo-expert-v1','local-demo'].includes(account?.id))return null;
 const expert=account.role==='expert';return {revision:1,fullName:expert?'Петров Алексей Сергеевич':'Иванов Иван Иванович',organization:expert?'Независимая экспертная практика':'Администрация учебного города',department:expert?'Антикоррупционная экспертиза':'Правовое управление',position:expert?'Независимый эксперт':'Главный специалист',avatar:expert?'/demo-expert.svg':'/demo-official.svg',isDemo:true,updatedAt:new Date().toISOString()};
}

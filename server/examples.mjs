import { id, now } from './store.mjs';
import { fail } from './files.mjs';
export function manualExample(b, account) {
 if(account && account.role !== 'expert') throw fail('Добавлять ручные примеры может эксперт.',403);
 const string=(value,max,label)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw fail(label+': заполните поле (до '+max+' символов).',400);return value.trim();};
 const e = { id: id(), title: string(b.problem, 3000, 'Проблема'), quote: '', explanation: string(b.problem, 3000, 'Проблема'), proposal: string(b.proposal, 10000, 'Способ исправления'), criterion: string(b.criterion, 3000, 'Критерий проверки'), applicability: 'Требует проверки специалистом', sourceIds: [], origin: 'Ручной пример', author: account?.displayName || 'Специалист', createdAt: now(), active: true, verified: false };
 return e;
}

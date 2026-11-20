import { createHash } from 'node:crypto';
import { CATALOG } from './catalog.mjs';
import { POLICY_VERSION, PROMPTS, METHOD_GUIDANCE, METHOD_REFERENCES, FACTOR_CHECKS } from './ai-policy.mjs';
import { QUALITY_CASES } from '../shared/quality-cases.mjs';
import { MATERIAL_LIBRARY } from './materials.mjs';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const ROLES = [
  { id: 'analyst', title: 'Аналитик', receives: 'Полный документ, 12 факторов, методика, проверенные источники и допустимые примеры.', returns: 'Находки с цитатами и основаниями, охват 12 факторов, ограничения.' },
  { id: 'reviewer', title: 'Проверяющий', receives: 'Полный документ, все находки Аналитика, методика и проверенные источники.', returns: 'Возражения, цитаты и итог по каждой находке: выдержала проверку, оспорена либо недостаточно данных.' },
  { id: 'editor', title: 'Редактор', receives: 'Текст документа, методика, источники и замечания, которые не были оспорены.', returns: 'Проект правки или объяснение, каких сведений для неё не хватает. Правки при недостатке оснований ограничены уточнением формулировки.' },
];

export function policySnapshot(connection) {
  const data = { version: POLICY_VERSION, catalogId: CATALOG.id, catalog: CATALOG, catalogApproved: CATALOG.approved, methodology: METHOD_GUIDANCE, references: METHOD_REFERENCES, factorChecks: FACTOR_CHECKS, prompts: PROMPTS, roles: ROLES, materials: MATERIAL_LIBRARY, parameters: { connection, maxTokens: connection.maxTokens, jsonMode: connection.jsonMode } };
  return structuredClone({ ...data, fingerprint: digest(data) });
}

export function methodology() {
  return structuredClone({ version: POLICY_VERSION, prompts: PROMPTS, roles: ROLES, methodology: METHOD_GUIDANCE, references: METHOD_REFERENCES, factorChecks: FACTOR_CHECKS, materials: MATERIAL_LIBRARY, qualityCases: QUALITY_CASES, catalog: CATALOG, catalogApproved: CATALOG.approved });
}

// A manifest records the actual input objects; it never contains an API key.
export function stageInput(stage, payload) {
  return { stage, payload: structuredClone(payload), documentHash: createHash('sha256').update(payload.document).digest('hex'), documentCharacters: payload.document.length, sourceIds: payload.sources.map(s => s.id), sourcesHash: digest(payload.sources), exampleIds: (payload.examples || []).map(e => e.id), examplesHash: digest(payload.examples || []), findingIds: (payload.findings || []).map(f => f.id), methodologyVersion: payload.methodologicalContext.version, capturedAt: new Date().toISOString() };
}

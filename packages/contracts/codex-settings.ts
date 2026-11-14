import { AppError, record, text } from './validation.js';

// The existing codex_settings wire field also carries Claude and Kiro turn settings.
const effortLabels = { none:'None', minimal:'Minimal', low:'Light', medium:'Medium', high:'High', xhigh:'Extra High', max:'Max' } as const;
export type ReasoningEffort = string;
export function effortLabel(id:string) {
  return Object.hasOwn(effortLabels,id) ? effortLabels[id as keyof typeof effortLabels] : id;
}
export function isLegacyCodexSetting(settings:CodexSettings) {
  return (!settings.model || ['gpt-6.1-sol','gpt-6-astra'].includes(settings.model)) &&
    !!settings.effort && ['low','medium','high','xhigh'].includes(settings.effort);
}
export interface CodexSettings { model?: string; effort?: ReasoningEffort }
export interface AgentModel {
  id: string;
  label: string;
  efforts: ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  isDefault?: boolean;
}

export function supportsModelSettings(models: AgentModel[], settings: CodexSettings) {
  const model = models.find(item => settings.model ? item.id === settings.model : item.isDefault);
  return !!model && (!settings.effort || model.efforts.includes(settings.effort));
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && !/[\s\x00-\x1f\x7f]/.test(value);
}

function modelId(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\s\x00-\x1f\x7f]/.test(value))
    throw new AppError(400,'invalid_codex_settings');
  return value;
}

export function parseCodexSettings(value: unknown): CodexSettings {
  const {model,effort} = record(value,['model','effort']);
  if ((model === undefined && effort === undefined) || (effort !== undefined && !isReasoningEffort(effort)))
    throw new AppError(400,'invalid_codex_settings');
  return { ...(model === undefined ? {} : {model:modelId(model)}), ...(effort === undefined ? {} : {effort}) };
}

export function parseModelCatalog(value: unknown): AgentModel[] {
  if (!Array.isArray(value) || value.length > 256) throw new AppError(400,'invalid_model_catalog');
  const seen = new Set<string>();
  return value.map(entry => {
    const row = record(entry,['id','label','efforts','defaultEffort','isDefault']);
    const id = modelId(row.id), label = text(row.label,256);
    if (seen.has(id) || !Array.isArray(row.efforts) || row.efforts.length > 32 || !row.efforts.every(isReasoningEffort))
      throw new AppError(400,'invalid_model_catalog');
    seen.add(id);
    const efforts = [...new Set(row.efforts)];
    if (row.defaultEffort !== undefined && (!isReasoningEffort(row.defaultEffort) || !efforts.includes(row.defaultEffort)))
      throw new AppError(400,'invalid_model_catalog');
    return {id,label,efforts,...(row.defaultEffort ? {defaultEffort:row.defaultEffort} : {}),...(row.isDefault === true ? {isDefault:true} : {})};
  });
}

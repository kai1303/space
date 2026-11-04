import { defaultPairedConnectors, parseCapabilities, record, text, uuid, type PairedConnector } from '@space/contracts';

/** Operator-owned descriptors only; runners cannot choose their own capabilities. */
export function configuredAgentConnectors(raw?: string): PairedConnector[] {
  if (!raw?.trim()) return [...defaultPairedConnectors];
  try {
    if (raw.length > 65_536) throw new Error();
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries) || entries.length > 100 - defaultPairedConnectors.length) throw new Error();
    const cloud = entries.map(value => {
      const entry = record(value, ['id', 'definition_id', 'name', 'capabilities']);
      const id = text(entry.id, 80);
      if (!/^[a-z][a-z0-9._-]*$/.test(id)) throw new Error();
      const capabilities = parseCapabilities(entry.capabilities);
      if (!capabilities.skills.length) throw new Error();
      return { id, definition_id: uuid(entry.definition_id), name: text(entry.name, 100), capabilities };
    });
    const connectors = [...defaultPairedConnectors, ...cloud];
    if (new Set(connectors.map(entry => entry.id)).size !== connectors.length || new Set(connectors.map(entry => entry.definition_id)).size !== connectors.length) throw new Error();
    return connectors;
  } catch {
    throw new Error('Invalid SPACE_CLOUD_CONNECTORS: use a JSON array of unique connector descriptors with id, definition_id, name and capabilities');
  }
}

import { SignJWT } from 'jose';
import type { AssetPreview } from '@space/contracts';

type OfficeFile = Extract<AssetPreview, { kind: 'office' }>;

export type OfficeSettings = { url: string; secret: string };

export function officeSettings(env = process.env): OfficeSettings | undefined {
  const url = env.ONLYOFFICE_URL, secret = env.ONLYOFFICE_JWT_SECRET;
  if (!url && !secret) return;
  if (!url || !secret || Buffer.byteLength(secret) < 32) throw new Error('onlyoffice_configuration');
  const endpoint = new URL(url);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('onlyoffice_configuration');
  return { url: endpoint.href, secret };
}

export async function officeSession(settings: OfficeSettings, id: string, title: string, fileType: OfficeFile['fileType'], url: string) {
  const types = { docx: 'word', odt: 'word', xlsx: 'cell', ods: 'cell', pptx: 'slide', odp: 'slide' } as const;
  const config = {
    documentType: types[fileType],
    document: { key: id, title, fileType, url, permissions: { edit: false, review: false, comment: false, fillForms: false } },
    editorConfig: { mode: 'view', customization: { anonymous: { request: false } }, coEditing: { mode: 'strict', change: false } },
    width: '100%', height: '100%',
  };
  const token = await new SignJWT(config).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').sign(Buffer.from(settings.secret));
  return { documentServerUrl: settings.url, config: { ...config, token } };
}

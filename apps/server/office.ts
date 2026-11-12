import { jwtVerify, SignJWT } from 'jose';
import { fileTypeFromBuffer } from 'file-type';
import { AppError, MAX_ASSET_BYTES, type AssetPreview } from '@space/contracts';

type OfficeFile = Extract<AssetPreview, { kind: 'office' }>;
export type OfficeSettings = { url: string; secret: string; callbackBase?: string; internalUrl?: string };
export const OFFICE_CALLBACK = '/v1/office/callback';
export const OFFICE_CONTENT = '/v1/office/files/:assetId/:revision';

function endpoint(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('onlyoffice_configuration');
  return url.href;
}

export function officeSettings(env = process.env): OfficeSettings | undefined {
  const url = env.ONLYOFFICE_URL, secret = env.ONLYOFFICE_JWT_SECRET;
  if (!url && !secret) return;
  if (!url || !secret || Buffer.byteLength(secret) < 32) throw new Error('onlyoffice_configuration');
  return { url: endpoint(url), secret, callbackBase: env.ONLYOFFICE_CALLBACK_BASE && endpoint(env.ONLYOFFICE_CALLBACK_BASE),
    internalUrl: env.ONLYOFFICE_INTERNAL_URL && endpoint(env.ONLYOFFICE_INTERNAL_URL) };
}

export function officeContentUrl(settings: OfficeSettings, id: string, revision: number) {
  if (!settings.callbackBase) throw new AppError(503, 'office_editing_unavailable');
  return new URL(`/v1/office/files/${id}/${revision}`, settings.callbackBase).href;
}

type SessionOptions = { revision: number; epoch: number; edit: boolean; actor: string; name: string; dark: boolean; selectionAgent?: boolean };
export async function officeSession(settings: OfficeSettings, id: string, title: string, fileType: OfficeFile['fileType'], url: string, options: SessionOptions) {
  const { revision, edit, actor, name, dark } = options;
  const types = { docx: 'word', odt: 'word', xlsx: 'cell', ods: 'cell', pptx: 'slide', odp: 'slide' } as const;
  const editKey = [id, 'edit', revision, ...(options.epoch ? [options.epoch] : [])].join('.');
  const key = edit ? editKey : revision ? `${id}.view.${revision}` : id;
  const selectionAgent = edit && types[fileType] === 'word' && options.selectionAgent;
  const config = {
    documentType: types[fileType],
    document: { key, title, fileType, url, permissions: { edit, review: false, comment: false, fillForms: false, chat: false } },
    editorConfig: {
      mode: edit ? 'edit' : 'view', user: { id: actor, name },
      ...(edit ? { callbackUrl: new URL(OFFICE_CALLBACK, settings.callbackBase).href } : {}),
      ...(selectionAgent ? { plugins: {
        // Docs 10 ships these optional plugins. Space enables only its selection
        // helper in an agent session, including disabling the plugin marketplace.
        disable: [
          '07FD8DFA-DFE0-4089-AL24-0730933CC80A', '38E022EA-AD92-45FC-B22B-49DF39746DB4',
          '440EBF13-9B19-4BD8-8621-05200E58140B', '7327FC95-16DA-41D9-9AF2-0E7F449F6800',
          'BE5CBF95-C0AD-4842-B157-AC40FEDD9441', 'BE5CBF95-C0AD-4842-B157-AC40FEDD9840',
          'BE5CBF95-C0AD-4842-B157-AC40FEDD9841', 'BFC5D5C6-89DE-4168-9565-ABD8D1E48711',
          'D71C2EF0-F15B-47C7-80E9-86D671F9C595', 'F30BDD79-23A0-4B05-8DE3-2AB77D03A1B4',
          'AA2EA9B6-9EC2-415F-9762-634EE8D9A95E',
        ].map(guid => `asc.{${guid}}`),
        autostart: ['asc.{B29E4FC2-C178-4B2A-80A6-026D01A3FD98}'],
        pluginsData: [new URL('/sdkjs-plugins/space-agent/config.json', settings.url).href],
      } } : {}),
      customization: { anonymous: { request: false }, plugins: Boolean(selectionAgent), compactHeader: true, compactToolbar: true,
        toolbarHideFileName: true, hideRightMenu: true, uiTheme: dark ? 'theme-dark' : 'theme-light', forcesave: false },
      coEditing: { mode: edit ? 'fast' : 'strict', change: false },
    },
    width: '100%', height: '100%',
  };
  const token = await new SignJWT(config).setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('5m').sign(Buffer.from(settings.secret));
  return { documentServerUrl: settings.url, config: { ...config, token } };
}

// Docs 10 signs outbound requests separately from the editor configuration handed to browsers.
export async function officeRequest(settings: OfficeSettings, header: string | undefined, operation: 'callback' | 'download') {
  try {
    if (!header?.startsWith('Bearer ')) throw new Error();
    const { payload } = await jwtVerify(header.slice(7), Buffer.from(settings.secret), { algorithms: ['HS256'] });
    if (payload.operation !== operation || !payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) throw new Error();
    return payload.payload as Record<string, unknown>;
  } catch { throw new AppError(401, 'invalid_office_request'); }
}

export async function readOfficeResult(settings: OfficeSettings, source: unknown, fileType: OfficeFile['fileType'] | 'png') {
  if (typeof source !== 'string' || !URL.canParse(source)) throw new AppError(400, 'invalid_office_result');
  const url = new URL(source);
  if (url.origin !== new URL(settings.url).origin || url.username || url.password || !url.pathname.startsWith('/cache/files/'))
    throw new AppError(400, 'invalid_office_result');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new AppError(502, 'office_download_failed');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > (fileType === 'png' ? 2 * 1024 * 1024 : MAX_ASSET_BYTES)) throw new AppError(413, 'office_file_too_large');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  if ((await fileTypeFromBuffer(bytes))?.ext !== fileType) throw new AppError(422, 'office_format_changed');
  return bytes;
}

export async function renderOfficeThumbnail(settings: OfficeSettings, key: string, fileType: OfficeFile['fileType'], source: string) {
  const url = settings.internalUrl ?? settings.url;
  const params = { key, filetype: fileType, outputtype: 'png', url: source, async: false,
    thumbnail: { aspect: 1, first: true, width: 640, height: 720 } };
  const token = await new SignJWT(params).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('2m').sign(Buffer.from(settings.secret));
  const response = await fetch(new URL('/converter', url), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ ...params, token }) });
  if (!response.ok) throw new AppError(503, 'office_thumbnail_unavailable');
  const result = await response.json();
  if (result.endConvert !== true) throw new AppError(415, 'preview_unavailable');
  return readOfficeResult({ ...settings, url }, result.fileUrl, 'png');
}

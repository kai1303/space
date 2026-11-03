export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'invalid_object');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) throw new AppError(400, 'unknown_field');
  return object;
}
export function text(value: unknown, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new AppError(400, 'invalid_text');
  return value;
}
export function uuid(value: unknown): string {
  const id = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new AppError(400, 'invalid_id');
  return id.toLowerCase();
}

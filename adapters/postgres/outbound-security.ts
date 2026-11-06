import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual, hkdfSync } from 'node:crypto';
import { AppError } from '@space/contracts';
export interface OutboundClaims {
  owner: string;
  installation: string;
  execution: string;
  exp: number;
  aud: string;
}
export class OutboundSecurity {
  private encryption: Buffer;
  private signing: Buffer;
  constructor(key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('OUTBOUND_MCP_KEY must contain 32 random bytes encoded as hex');
    const derive = (purpose: string) =>
      Buffer.from(hkdfSync('sha256', Buffer.from(key, 'hex'), 'space-outbound', purpose, 32));
    this.encryption = derive('credentials');
    this.signing = derive('capabilities');
  }
  encrypt(secret: string, binding: string) {
    const iv = randomBytes(12),
      c = createCipheriv('aes-256-gcm', this.encryption, iv);
    c.setAAD(Buffer.from(binding));
    return Buffer.concat([iv, c.update(secret), c.final(), c.getAuthTag()]).toString('base64url');
  }
  decrypt(value: string, binding: string) {
    try {
      const data = Buffer.from(value, 'base64url'),
        c = createDecipheriv('aes-256-gcm', this.encryption, data.subarray(0, 12));
      c.setAAD(Buffer.from(binding));
      c.setAuthTag(data.subarray(-16));
      return Buffer.concat([c.update(data.subarray(12, -16)), c.final()]).toString();
    } catch {
      throw new AppError(503, 'outbound_credentials_unavailable');
    }
  }
  sign(claims: OutboundClaims) {
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${body}.${createHmac('sha256', this.signing).update(body).digest('base64url')}`;
  }
  verify(token: string, audience: string): OutboundClaims {
    try {
      if (token.length > 4096) throw 0;
      const parts = token.split('.');
      if (parts.length !== 2) throw 0;
      const expected = createHmac('sha256', this.signing).update(parts[0]!).digest(),
        actual = Buffer.from(parts[1]!, 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw 0;
      const claims = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
      if (
        claims.aud !== audience ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp <= Date.now() ||
        claims.exp > Date.now() + 300000 ||
        !['owner', 'installation', 'execution'].every((k) => typeof claims[k] === 'string')
      )
        throw 0;
      return claims;
    } catch {
      throw new AppError(401, 'unauthorized');
    }
  }
}

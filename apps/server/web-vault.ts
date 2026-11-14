import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Namespace } from 'socket.io';
import { AppError, webVaultCommand, uuid, webVaultResult } from '@space/contracts';
import type { AgentConnectionStore } from '@space/postgres/agent-connections';

export function registerWebVault(app: FastifyInstance, agents: Namespace, store: AgentConnectionStore) {
  const waiting = new Set<string>();
  app.get('/v1/me/vault/macs', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    return (await store.vaultMacs(r.actorId)).map(({id, name, online}) => ({id, name, online}));
  });
  app.post<{Params: {id: string}}>('/v1/me/vault/macs/:id/request', async (r, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = uuid(r.params.id), actor = r.actorId;
    const command = webVaultCommand(r.body);
    if (waiting.has(actor) || waiting.size >= 128) throw new AppError(429, 'vault_busy');
    waiting.add(actor);
    try {
      const [mac] = await store.vaultMacs(actor, id);
      if (!mac) throw new AppError(404, 'vault_mac_not_found');
      if (!mac.online || !mac.connection) throw new AppError(409, 'vault_mac_offline');
      const timeout = command.action === 'manage' || command.action === 'prepare-linear' || command.action === 'prepare-item' ? 12000 : 65000;
      let responses: unknown[];
      try {
        responses = await agents.to('vault:' + mac.connection).timeout(timeout).emitWithAck('vault.request', {
          ...command, actor, installation: id, id: randomUUID(), expires: Date.now() + timeout,
        });
      } catch { throw new AppError(408, 'vault_request_expired'); }
      if (responses.length !== 1) throw new AppError(409, 'vault_mac_offline');
      const [current] = await store.vaultMacs(actor, id);
      if (!current?.online || current.connection !== mac.connection) throw new AppError(409, 'vault_connection_changed');
      try { return webVaultResult(responses[0], command.action); }
      catch { throw new AppError(502, 'invalid_vault_response'); }
    } finally { waiting.delete(actor); }
  });
}

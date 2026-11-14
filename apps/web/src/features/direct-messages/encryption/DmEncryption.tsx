import { EncryptedAttachments } from './EncryptedAttachments.js';
import type { EncryptedFile } from './file-crypto.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@space/ui/primitives';
import { RichContent } from '@space/ui/rich-text';
import type { ChatMessage, DirectMessageSummary, DmEncryption, RichDocument } from '@space/contracts';
import { request } from '../../../shared/api/request.js';
import { subscribeUpdates } from '../../../shared/realtime/live-updates.js';
import { deviceState, type DeviceState } from './device-storage.js';
import { DM_DRAFT_KEY_AVAILABLE } from './draft-crypto.js';

const noDevices: DmEncryption['devices'] = [];

export function useDmEncryption(dm: DirectMessageSummary | undefined, actor: string) {
  const channel = dm?.id,
    scope = actor + '/' + channel;
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    remote: DmEncryption;
    local?: DeviceState;
    stale?: boolean;
  }>();
  const [failure, setFailure] = useState(''),
    [busy, setBusy] = useState(false),
    generation = useRef(0);
  const path = '/channels/' + channel + '/encryption';
  const refresh = useCallback(async () => {
    if (!channel) return;
    const epoch = ++generation.current;
    try {
      const [remote, saved] = await Promise.all([
        request<DmEncryption>(path, undefined, undefined, 'POST', undefined, actor),
        deviceState(actor, channel),
      ]);
      if (typeof remote.enabled !== 'boolean' || !Array.isArray(remote.devices))
        throw Error('Cannot verify conversation encryption.');
      let local = saved;
      const device = saved && remote.devices.find(d =>
        d.user_id === actor && d.id === saved.identity.id && d.public_key === saved.identity.publicKey);
      // Recover older registrations and an enrollment whose acknowledgement was lost.
      if (saved && device && epoch === generation.current && saved.linked !== !device.revoked) {
        const { authorizeDevice } = await import('./crypto.js');
        const linked = !device.revoked && device.authorization ===
          await authorizeDevice(saved.recovery, channel, actor, device.id, device.public_key);
        local = await deviceState(actor, channel, old => {
          if (!old) throw Error('Local device no longer available.');
          if (old.identity.id !== device.id || old.recovery !== saved.recovery || epoch !== generation.current)
            return old;
          return { ...old, linked };
        });
        if (local?.linked && epoch === generation.current)
          window.dispatchEvent(new CustomEvent(DM_DRAFT_KEY_AVAILABLE, { detail: { viewer: actor, channel } }));
      }
      if (epoch === generation.current) {
        setSnapshot({ scope, remote, local });
        setFailure('');
      }
    } catch (e) {
      if (epoch === generation.current) {
        setFailure(e instanceof Error ? e.message : 'Encryption status unavailable.');
        setSnapshot((previous) => (previous?.scope === scope ? { ...previous, stale: true } : undefined));
      }
    }
  }, [actor, channel, path, scope]);
  useEffect(() => {
    if (!channel) return;
    const stop = subscribeUpdates('channel', channel, refresh);
    return () => {
      generation.current++;
      stop();
    };
  }, [channel, refresh]);
  const state = snapshot?.scope === scope ? snapshot : undefined;
  const enabled = !!dm?.encrypted_since || !!state?.remote.enabled || !!state?.local?.trust;
  const devices = state?.remote.devices ?? noDevices,
    local = state?.local;
  const live = devices.filter((d) => !d.revoked);
  const verified =
    !!local?.trust &&
    live.length === local.trust.devices?.length &&
    live.every(
      (d) =>
        local.trust!.devices.includes(d.id) &&
        local.trust!.owners[d.id] === d.user_id &&
        local.trust!.keys[d.id] === d.public_key,
    );
  const enrolled =
    !!local &&
    devices.some(
      (d) =>
        d.id === local.identity.id &&
        d.user_id === actor &&
        d.public_key === local.identity.publicKey &&
        !d.revoked,
    );
  const participants = dm?.participants ?? [];
  const complete =
    participants.length > 0 &&
    participants.every((p) => devices.some((d) => d.user_id === p.id && !d.revoked));
  async function change(operation: 'enroll' | 'enable' | 'verify' | 'revoke', value?: string) {
    if (!channel || !dm || !state || state.stale) return;
    setBusy(true);
    setFailure('');
    try {
      const crypto = await import('./crypto.js');
      if (operation === 'enroll') {
        const previous = await deviceState(actor, channel);
        const own = devices.filter((d) => d.user_id === actor);
        const recovery = value?.trim() || previous?.recovery || (!own.length ? crypto.recoveryCode() : '');
        if (!/^[a-f0-9]{64}$/.test(recovery)) throw Error('Enter the 64-character device linking code.');
        const identity =
          previous && !own.some((d) => d.id === previous.identity.id && d.revoked)
            ? previous.identity
            : await crypto.makeIdentity();
        const candidate = await deviceState(actor, channel, (old) =>
          old && old.identity.id !== previous?.identity.id
            ? old
            : { identity, recovery, linked: false, trust: previous?.trust },
        );
        await request(
          path + '/enroll',
          {
            id: candidate!.identity.id,
            public_key: candidate!.identity.publicKey,
            authorization: await crypto.authorizeDevice(
              candidate!.recovery,
              channel,
              actor,
              candidate!.identity.id,
              candidate!.identity.publicKey,
            ),
            recovery: await crypto.enrollmentProof(candidate!.recovery),
          },
          undefined,
          'POST',
          undefined,
          actor,
        );
      } else if (operation === 'revoke') {
        await request(path + '/revoke', { id: value }, undefined, 'POST', undefined, actor);
      } else {
        if (!enrolled || !complete || !local) throw Error('Both participants need a registered device.');
        const trust = await crypto.trustRoster(channel, devices, local.trust);
        if (
          trust.code !== value ||
          trust.code !==
            (await crypto.verifiedRosterCode(
              channel,
              actor,
              participants.map((p) => p.id),
              local,
              devices,
            ))
        )
          throw Error('Device list changed. Compare the new verification code.');
        if (operation === 'enable')
          await request(
            path + '/enable',
            { recipients: devices.filter((d) => !d.revoked).map((d) => d.id) },
            undefined,
            'POST',
            undefined,
            actor,
          );
        await deviceState(actor, channel, (old) => {
          if (!old || old.identity.id !== local.identity.id)
            throw Error('Local device changed. Verify it again.');
          return { ...old, linked: true, trust };
        });
      }
      await refresh();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'Encryption setup failed.');
    } finally {
      setBusy(false);
    }
  }
  async function encrypt(document: RichDocument, id: string, files: EncryptedFile[] = []) {
    if (!state?.remote.enabled || state.stale || !local?.trust || !enrolled || !complete)
      throw Error('Open conversation details to verify your devices.');
    return (await import('./crypto.js')).seal(
      local.identity,
      local.trust,
      devices,
      channel!,
      actor,
      id,
      document,
      files,
    );
  }
  return {
    enabled,
    draftKeyReady: enrolled && !!local?.linked && !state?.stale,
    devices,
    local,
    enrolled,
    verified,
    complete,
    busy,
    failure,
    loading: !!dm && (!state || !!state.stale),
    change,
    refresh,
    encrypt,
  };
}
type Controls = ReturnType<typeof useDmEncryption>;
export function EncryptionSettings({
  dm,
  actor,
  control,
}: {
  dm: DirectMessageSummary;
  actor: string;
  control: Controls;
}) {
  const { local, devices, enrolled, complete, busy, failure, enabled } = control;
  const [secret, setSecret] = useState(''),
    [show, setShow] = useState(false),
    [verified, setVerified] = useState('');
  const [code, setCode] = useState(''),
    [codeError, setCodeError] = useState('');
  useEffect(() => {
    let live = true;
    setCodeError('');
    if (!complete || !local || !enrolled) setCode('');
    if (complete && local && enrolled)
      void import('./crypto.js')
        .then((c) =>
          c.verifiedRosterCode(
            dm.id,
            actor,
            dm.participants.map((p) => p.id),
            local,
            devices,
          ),
        )
        .then((v) => {
          if (live) setCode(v);
        })
        .catch(() => {
          if (live) {
            setCode('');
            setCodeError('Unable to verify device keys.');
          }
        });
    return () => {
      live = false;
    };
  }, [complete, devices, dm.id, dm.participants, actor, enrolled, local]);
  const own = devices.filter((d) => d.user_id === actor);
  return (
    <section className="dm-encryption-settings">
      <h3>End-to-end encryption</h3>
      {failure && (
        <p role="alert">
          {failure}{' '}
          <Button size="sm" onClick={control.refresh}>
            Refresh
          </Button>
        </p>
      )}
      {control.loading ? (
        <p>Checking encryption status…</p>
      ) : (
        <>
          {!enrolled && (
            <>
              {own.length > 0 && (
                <label>
                  Device linking code
                  <input
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </label>
              )}
              <Button disabled={busy} onClick={() => void control.change('enroll', secret)}>
                Register this device
              </Button>
            </>
          )}
          {enrolled && (
            <>
              <p>This device is registered for this DM.</p>
              <Button size="sm" onClick={() => setShow(!show)}>
                {show ? 'Hide' : 'Show'} device linking code
              </Button>
              {show && (
                <>
                  <p>
                    Keep this code private. Use it on your other devices to receive future messages in this
                    DM.
                  </p>
                  <code>{local?.recovery}</code>
                </>
              )}
            </>
          )}
          {own
            .filter((d) => !d.revoked)
            .map((d) => (
              <p key={d.id}>
                {d.id === local?.identity.id ? 'This device' : 'Device'} · {d.id.slice(0, 8)}{' '}
                <Button size="sm" disabled={busy} onClick={() => void control.change('revoke', d.id)}>
                  Revoke
                </Button>
              </p>
            ))}
          {enrolled && !complete && (
            <p>Ask the other participant to register a device in this conversation.</p>
          )}
          {enrolled && complete && (
            <>
              <p>
                Compare this code with the other participant on a trusted call or in person. It covers all
                registered devices in this DM.
              </p>
              {codeError && <p role="alert">{codeError}</p>}
              <code>{code.match(/.{1,8}/g)?.join(' ')}</code>
              {(!enabled || local?.trust?.code !== code) && (
                <>
                  <label>
                    <input
                      type="checkbox"
                      disabled={!code || busy}
                      checked={!!code && verified === code}
                      onChange={(e) => setVerified(e.target.checked ? code : '')}
                    />{' '}
                    The codes match
                  </label>
                  <Button
                    disabled={busy || !code || code !== verified}
                    onClick={() => void control.change(enabled ? 'verify' : 'enable', code)}
                  >
                    {enabled ? 'Trust these devices' : 'Enable encrypted messages'}
                  </Button>
                </>
              )}
              {enabled && code && local?.trust?.code === code && (
                <p>Verified devices. New messages are end-to-end encrypted.</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
export function EncryptedBody({
  message,
  control,
  viewer,
}: {
  message: ChatMessage;
  control: Controls;
  viewer: string;
}) {
  const [opened, setOpened] = useState<{
    message: ChatMessage;
    local: DeviceState;
    doc: RichDocument;
    files: EncryptedFile[];
  }>();
  const { local, devices } = control;
  useEffect(() => {
    let live = true;
    if (local?.trust && message.encrypted && message.client_message_id)
      void import('./crypto.js')
        .then((c) =>
          c.unsealContent(
            local.identity,
            local.trust!,
            devices,
            message.channel_id,
            message.author.id,
            message.client_message_id!,
            message.encrypted!,
          ),
        )
        .then(({ document, files }) => {
          if (live) setOpened({ message, local, doc: document, files });
        })
        .catch(() => {
          if (live) setOpened(undefined);
        });
    return () => {
      live = false;
    };
  }, [local, devices, message]);
  return opened &&
    opened.message === message &&
    opened.local.identity.id === local?.identity.id &&
    opened.local.trust?.code === local?.trust?.code ? (
    <>
      <RichContent document={opened.doc} viewerId={viewer} />
      <EncryptedAttachments files={opened.files} actor={viewer} />
    </>
  ) : (
    <em>Encrypted message · verify or link this device to read it.</em>
  );
}

// Queries and decrypted results live only in this dialog. History requests contain pagination cursors.
export function EncryptedSearch({
  channel,
  actor,
  control,
  onClose,
  onOpen,
}: {
  channel: string;
  actor: string;
  control: Controls;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<{ id: string; text: string }[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [finished, setFinished] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const older = useRef<string | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  async function search(next: boolean) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError('');
    if (!next) {
      older.current = undefined;
      setResults([]);
    }
    try {
      const needle = query.trim().toLocaleLowerCase();
      if (!needle) return;
      const page = await request<import('@space/contracts').MessagePage>(
        `/channels/${channel}/messages?limit=50${older.current ? '&before=' + encodeURIComponent(older.current) : ''}`,
        undefined,
        undefined,
        'POST',
        controller.signal,
        actor,
      );
      const batch: { id: string; text: string }[] = [];
      for (const m of page.messages) {
        if (controller.signal.aborted) return;
        if (m.deleted_at) continue;
        let body = m.text;
        if (m.encrypted) {
          if (!control.local?.trust || !m.client_message_id) continue;
          try {
            const { document: doc, files } = await (
              await import('./crypto.js')
            ).unsealContent(
              control.local.identity,
              control.local.trust,
              control.devices,
              channel,
              m.author.id,
              m.client_message_id,
              m.encrypted,
            );
            body = doc.ops
              .map((op) => op.insert)
              .join('')
              .trim();
            if (!body.toLocaleLowerCase().includes(needle))
              body = files.find((file) => file.name.toLocaleLowerCase().includes(needle))?.name ?? body;
          } catch {
            continue;
          }
        }
        if (body.toLocaleLowerCase().includes(needle)) batch.push({ id: m.id, text: body });
      }
      if (controller.signal.aborted) return;
      older.current = page.has_older ? (page.older_cursor ?? undefined) : undefined;
      setResults((prior) => [...(next ? prior : []), ...batch.reverse()].slice(0, 100));
      setFinished(true);
    } catch {
      if (!controller.signal.aborted) setError('Could not search this conversation.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <Dialog open title="Search this conversation on this device" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void search(false);
        }}
      >
        <label>
          Search messages
          <input
            autoFocus
            type="search"
            maxLength={500}
            value={query}
            onChange={(e) => {
              abort.current?.abort();
              setQuery(e.target.value);
              older.current = undefined;
              setBusy(false);
              setResults([]);
              setFinished(false);
            }}
          />
        </label>
        <Button disabled={busy || !query.trim()} type="submit">
          Search
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">Searching…</p>}
      {finished && !busy && !results.length && <p>No matches in the messages searched.</p>}
      <ul>
        {results.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => onOpen(m.id)}>
              {m.text.slice(0, 240)}
            </button>
          </li>
        ))}
      </ul>
      {older.current && results.length < 100 && (
        <Button disabled={busy} onClick={() => void search(true)}>
          Search older messages
        </Button>
      )}
    </Dialog>
  );
}

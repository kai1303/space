import { fileTransfers } from './file-transfers.js';
import { memo, useEffect, useState } from 'react';
import { Button, Dialog } from '@space/ui/primitives';
import { sessionFetch } from '../../../shared/api/session-fetch.js';
import { decryptFile, type EncryptedFile } from './file-crypto.js';

const read = fileTransfers();
function readFile(file: EncryptedFile, actor: string, signal: AbortSignal) {
  return read(signal, async () => {
    const response = await sessionFetch('/v1/assets/' + file.id + '/encrypted-content', {
      credentials: 'same-origin',
      signal,
      headers: { 'X-Expected-Actor': actor },
    });
    const length = response.headers.get('content-length');
    if (
      !response.ok ||
      (length !== null && !response.headers.has('content-encoding') && Number(length) !== file.size)
    )
      throw Error('Could not load encrypted file.');
    return decryptFile(await response.arrayBuffer(), file);
  });
}

function EncryptedAttachment({ file, actor }: { file: EncryptedFile; actor: string }) {
  const [attempt, setAttempt] = useState(0),
    [preview, setPreview] = useState(false);
  const [opened, setOpened] = useState<{ file: EncryptedFile; url: string }>(),
    [error, setError] = useState('');
  // Render only raster images in the application origin.
  const image = /^(image\/(png|jpeg|gif|webp|avif))$/.test(file.type);
  useEffect(() => {
    if (!image && !attempt) return;
    const controller = new AbortController();
    let url: string | undefined;
    setError('');
    void readFile(file, actor, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(image ? blob : blob.slice(0, blob.size, 'application/octet-stream'));
        setOpened({ file, url });
        if (!image) {
          const download = document.createElement('a');
          download.href = url;
          download.download = file.name;
          download.click();
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not decrypt this file. Retry to load it again.');
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, actor, attempt, image]);
  const url = opened?.file === file ? opened.url : undefined;
  return (
    <div className="dm-encrypted-file">
      {image && url && (
        <button
          type="button"
          className="dm-encrypted-image"
          aria-label={'Preview ' + file.name}
          onClick={() => setPreview(true)}
        >
          <img src={url} alt={file.description || file.name} />
        </button>
      )}
      <strong>{file.name}</strong>
      <span>{file.size.toLocaleString()} bytes</span>
      {file.description && <p>{file.description}</p>}
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </Button>
        </>
      ) : url ? (
        <a href={url} download={file.name}>
          Download {file.name}
        </a>
      ) : image || attempt ? (
        <span role="status">Decrypting…</span>
      ) : (
        <Button size="sm" onClick={() => setAttempt((value) => value + 1)}>
          Download {file.name}
        </Button>
      )}
      {preview && url && (
        <Dialog open title={file.name} onClose={() => setPreview(false)}>
          <img className="dm-encrypted-full-image" src={url} alt={file.description || file.name} />
          <a href={url} download={file.name}>
            Download {file.name}
          </a>
        </Dialog>
      )}
    </div>
  );
}
export const EncryptedAttachments = memo(
  function EncryptedAttachments({ files, actor }: { files: EncryptedFile[]; actor: string }) {
    return files.length ? (
      <div className="dm-encrypted-files">
        {files.map((file) => (
          <EncryptedAttachment key={file.id} file={file} actor={actor} />
        ))}
      </div>
    ) : null;
  },
  (a, b) => a.actor === b.actor && JSON.stringify(a.files) === JSON.stringify(b.files),
);

# Encrypted direct messages

In a DM, open **More conversation actions → Conversation details → End-to-end encryption**. Each participant registers a device and compares the complete verification code with the other participant over a trusted channel. One enables encryption and the other selects **Trust these devices**. The change applies to new messages and their file attachments. Existing messages keep their original protection. Enabling encryption requires resolving any pending scheduled messages first.

Devices are registered per account and conversation. To add another browser, use the private device linking code from an enrolled device or a saved copy. Both participants must verify the changed device list before sending again. New devices can read messages encrypted to them after enrollment. The linking code authorizes enrollment, and cannot recover historical messages or a deleted private key. Save it before removing the last device. Revocation stops future delivery to a device. It cannot erase copies that device already received.

## Message and key handling

The client generates a device identity using OpenPGP.js with version 6 Curve25519 keys and signs and encrypts the complete rich-text document for every active device. The signature covers the conversation, author, client message ID, sender device and recipient list. The security code covers the conversation and the ordered user, device and public-key fingerprint tuples. Each participant's own devices also carry a key authorization authenticated by their per-DM linking secret. The server stores a hashed enrollment verifier and the public device directory.

The private key is passphrase-protected. IndexedDB holds it with a randomly generated passphrase wrapped by a non-extractable Web Crypto key. The signed-in client must be trusted: code running in the application's origin can use the locally available keys. OpenPGP does not provide Signal-style forward secrecy or post-compromise recovery for these long-lived device keys. A previously authorized recipient can retain the plaintext.

The outbox persists ciphertext and the original message ID before sending. Both the REST and socket paths check the conversation mode and current active devices, and existing idempotency rules apply to retries. The database stores a generic message label with the encrypted envelope. The same envelope is available through authorized history and realtime replay. Space sees routing, timing, message sizes and device membership. Deletion and retention remove the envelope from the message and stored replay payloads.

## Files and images

Use **+ → Upload from computer**, paste a file, or drop it on the verified DM composer. A message can contain up to five files of up to 25 MiB each, with or without a caption. Each upload gets a fresh AES-256-GCM key and a random 96-bit IV. The browser uploads the ciphertext as a generic binary file. The signed, encrypted message carries its key, IV, authentication tag, filename, media type, and optional description. The message also signs the ordered storage IDs and the client checks them against the outer envelope. The API atomically binds completed uploads to one message and validates the sender, conversation, devices, and upload ownership on send. Existing expiry, deletion, and retention handle stored ciphertext.

Space can see the file count, sizes, timing, and routing. File keys and original metadata stay inside the encrypted message. Devices download ciphertext through an authorized endpoint, authenticate and decrypt it locally, and render raster image previews from short-lived blob URLs. Other files can be saved with their original name. No thumbnail is uploaded or produced on the server. Local conversation search includes filenames. Open encrypted attachments in the message where they were shared.

## Features in this release

- One-to-one and self DMs support encrypted rich text. Search from inside the encrypted conversation decrypts history on the device in pages of 50. Workspace search excludes encrypted messages. Notification and inbox previews use a generic label.
- Scheduled sends and thread replies are disabled for new encrypted messages. Server-side agents do not receive decrypted content. Calls have their own media path and are outside the message-encryption feature.
- Workspace channels, old DM history, and agent sessions continue to use their existing storage. Encrypted history transfer, encrypted backups and native keychain integration are future work.

Apply database migrations 107 and 108 and update the API and clients together. An older client cannot send plaintext to an encrypted DM or display its encrypted contents.

The browser test in `tests/e2e/encrypted-dms.test.ts` exercises registration, fingerprint verification, encrypted send over Socket.IO, offline recipient replay, local search, file downloads and image previews with two authenticated browser profiles and SeaweedFS. The direct-message integration suite covers authorization, retry identity, plaintext rejection and deletion. The web crypto and outbox suites cover message authenticity, device-set changes and lost acknowledgments.

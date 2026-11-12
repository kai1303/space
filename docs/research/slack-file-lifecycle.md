# How Slack uploads, opens, and updates a file

Inspected on November 12, 2026. The live desktop web comparison used the same 1766 × 1856 PNG in a Slack self-DM and in Space’s `#hi`. Upload and event-handling details below come from static analysis of Slack’s shipped web client unless identified as live observations.

## From the composer to the message

The composer can display an image as soon as it has the selected browser File. Its pending-image component creates an object URL, reads orientation and dimensions, and releases the URL on unmount. Clicking a pending image opens a draft-file viewer with the pending file ID, image dimensions, orientation, other previewable draft images, and channel/thread context. Pending attachments can be removed. The gallery associates them with a pending ID and later with a persisted file ID. An image appearing in the draft therefore tells the sender that they chose the right file. It cannot confirm delivery to the conversation.

The upload queue separates requesting an upload URL, transferring bytes, finalizing the share with file IDs and message context, and resolving processing. Finalization can carry a channel, thread timestamp, message blocks and client message ID. One completion path matches the active share’s client message ID. Another matches the active file ID and refreshes that file. The client distinguishes processing timeouts from policy errors such as disabled uploads. The public API describes the same separation between byte transfer and completing a share, and documents scanning before a file becomes available. The capture did not establish exactly when every Slack client enables Send during a slow upload. [Slack’s file upload documentation](https://docs.slack.dev/messaging/working-with-files/)

Space already stages the selected files, reports transfer progress, and supports cancel and retry. Its upload helper completes each asset before returning its ID. We observed the channel Send button disabled while the three example files were uploading. This distinction matters when comparing upload progress, message acknowledgement, and preview readiness.

## From the message to the media viewer

| Measured in live Slack | Result |
| --- | --- |
| Single image in the conversation | The filename appeared above the linked image. A 685 × 720 thumbnail occupied 336 × 353 CSS pixels. |
| Open | Clicking the image opened a dialog named **Media viewer** on the selected file. In a 1512 × 778 viewport, its bounds were 1456 × 722 with 28 px insets. The header identified the sender, time and filename. |
| First paint after the image loaded | The image element decoded the full 1766 × 1856 PNG. Its transformed on-screen bounds were 687 × 722. |
| Zoom | A single click on **Zoom in** changed the slider from 0 to 0.07 and the displayed bounds to 883 × 928. Slider values here are internal control readings, not percentages. |
| Controls | A 52 px toolbar sat along the bottom. Rotate and zoom were on the left. Download, ALT description, thread, open in new window and more actions were on the right. Close returned focus to the image link in the conversation. |

The click handler passes the selected file and conversation context to a media viewer. Opening can fetch missing file information. The shared viewer also has optional previous/next and filmstrip inputs. The self-DM observation contained a single image, so it does not establish the navigation scope of every Slack gallery. The viewer has separate implementations for images, PDF, documents and other formats. Slack also documents pan and zoom for images. [Slack’s image viewer overview](https://slack.com/blog/productivity/in-case-you-missed-it-new-emoji-improved-search-and-more)

On the same PNG, Space’s thumbnail was 228 × 240 and its higher-resolution display rendition was 1142 × 1200. The current gallery can select the display rendition for a high-density screen. Space’s open viewer also uses that rendition. The original is available from Download original. Space’s viewer opens the selected attachment, supports zoom buttons and has a filmstrip for a multi-file message. Its header, toolbar placement, image source and zoom interaction differ from Slack’s.

## Changes while a preview is open

On the uploaded PNG, Slack’s **More actions → Edit file details** opened a second dialog over the media viewer. It offered **File name** and **Description**. Closing that dialog returned to the media viewer. No binary replacement action appeared in the PNG’s menu or edit dialog.

The shipped client submits title and alternative text against the existing file ID. Its event-log recovery code can coalesce repeated file-change events for an ID. A separate fetch-and-upsert operation refreshes a file by ID, and the shared viewer selects the current file record by ID. These pieces support updating metadata while retaining the identity of the open file. In a subsequent live test, the user posted launch-sky.webp in their Slack self-DM. Two Brave tabs opened the same file under the same account. The observer zoomed to slider value 0.2 (image width 1954 CSS pixels). The second tab renamed it to launch-sky-renamed.webp. At the first observation, about 0.4 seconds after the save click, only the editing tab showed the new name. By the next observation, about 13 seconds after the click, the still-open observer showed the new visible title, group label and image alt text. Its slider remained at 0.2 and its image width remained 1954 CSS pixels, without reloading or reopening. These are observation bounds, not a latency measurement. This run exercised a metadata rename across two tabs; it did not exercise pan, replacement of image bytes, or a saved Office revision. Slack documents the file-change event and directs consumers to fetch file information. [Slack file_change event](https://docs.slack.dev/reference/events/file_change/)

Space’s Office editor is a separate case. Editors can co-edit the working copy. The server persists a version when the editing session finishes. The read-only Office preview requests a session for its current asset and mode, and its displayed version comes from that session. The image/document card reads preview metadata when mounted for an asset ID. Neither read path shown here subscribes to a newly saved Office revision. Generating a current thumbnail on the next request does not refresh an already-mounted card by itself.

## Evidence

REA 6.8.0 analyzed 16 extracted module factories from previously captured public Slack web bundles. Evidence ID `ev_2a96fcfb4610685f0098295d0ca872ad86cc3171a5bbaaca2674076783c9a884`. The local evidence directory is `~/.codex-artifacts/slack-file-lifecycle-20261112/`. Its manifest records the parent bundle, source offsets and SHA-256 of each extracted factory.

The relevant modules are `ymL1` (draft and pending file gallery), `rZFM` (upload queue), `ekOe` and `hMRD` (message gallery and click), `a2rD` (ensure file exists and open viewer), `lr8G` (zoom interaction), `gxDu`, `B7Ot` and `sdq1` (viewer and file selection), `2oVU` (edit details), `DWz6` (edit/refetch/upsert), and `f2a4` (event-log coalescing). The captured build and today’s live workspace may have different feature flags.

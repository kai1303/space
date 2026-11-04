# Home direct messages

Match the inspected Slack behavior: Home sidebar DM selection keeps Home and its sidebar visible, uses the existing ChannelRoom, and displays avatars/presence. The rail DMs button keeps its inbox. Self-DMs use a personal-notes placeholder and existing notes/files introduction.

Implement selected Home DM metadata in the existing workspace view. Revalidate selected-DM access through channel events with abort/generation cleanup. Preserve drafts and close behavior. Record Home/inbox context in navigation history and restore Home's last conversation. No polling, new permissions, backend routes, or second messaging implementation.

Verify Home/inbox navigation, drafts/history, self placeholder, metadata revocation and late-response cleanup with scoped tests, then check the live UI without sending messages.

## Verified

Home sidebar DMs render in the shared ChannelRoom with avatar/presence, Home selection and notes placeholder. Navigation history distinguishes Home from the inbox, and requested channel navigation updates Home restoration state. Selected DM metadata revalidates via channel events, with cleanup on channel/workspace revocation. Home remains mounted across workspace transitions.

79 affected web tests and 21 sidebar/UI tests passed; web production build passed. Live browser confirmed Home sidebar retention and the self-DM placeholder. No messages sent. Screenshot: local visualizations `spacebot-slack-fix/self-dm-comparison/fixed/home-self-dm.jpg`.

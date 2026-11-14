# Slack Directories

Observed in the signed-in web client on November 14, 2026, at 1512 × 834.
The Home shortcut opens People. The same header and tab strip stay visible across People, Channels, External and Invitations.

- People has a search field, an invite action, a dismissible introduction, title and location filters, additional account filters and sorting. Square profile portraits sit above names and presence dots. Selecting a card opens the profile alongside the directory.
- Channels has search and create actions, a separate dismissible introduction, membership and channel type filters, workspace and organization filters, sorting and bordered rows. Rows show membership, member count and description.
- External introduces Slack Connect and offers external channels and direct messages. Invitations shows a centered tracking illustration and explanatory text when empty.

Space uses its workspace membership, guest, channel, profile and invitation APIs. It uses time zone from the profile, scopes directory queries to the current workspace, and offers deterministic default and alphabetical sorting. External invites guests into selected workspace channels. Invitations tracks the email invitations and invite links the current user is authorized to manage. Slack's directory illustrations are stored locally in the web app.

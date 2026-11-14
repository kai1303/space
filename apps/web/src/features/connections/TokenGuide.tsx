const linear = {
  provider: 'Linear',
  steps: [
    'In Linear, open Settings → Account → Security & Access and create a personal API key.',
    'Choose the teams the key can access. Select Read if your agent only needs to look up issues.',
  ],
  docs: 'https://linear.app/docs/api-and-webhooks',
};
const github = {
  provider: 'GitHub',
  steps: [
    'In GitHub, open Settings → Developer settings → Personal access tokens → Fine-grained tokens. Generate a new token.',
    'Choose the repository owner, repositories, and permissions. For reading pull requests, give Pull requests read access.',
  ],
  docs: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
};
const postman = {
  provider: 'Postman',
  steps: [
    'In Postman, open Settings → Account settings → API keys.',
    'Select Generate API Key, give the key a name, and copy it.',
  ],
  docs: 'https://learning.postman.com/docs/reference/postman-api/authentication',
};
const guides = new Map([
  ['https://mcp.linear.app', linear],
  ['https://api.githubcopilot.com', github],
  ['https://mcp.postman.com', postman],
  ['https://mcp.eu.postman.com', postman],
]);

export function TokenGuide({ endpoint, expanded, local }: { endpoint: string; expanded: boolean; local?: boolean }) {
  let guide;
  try {
    const address = new URL(endpoint);
    if (!address.username && !address.password) guide = guides.get(address.origin);
  } catch { /* A manually entered endpoint may still be incomplete. */ }
  return <details className="space-token-guide" open={expanded || undefined}>
    <summary>{guide ? `How to get a ${guide.provider} token` : 'How to get a bearer token'}</summary>
    <ol>
      {(guide?.steps ?? [
        'Check the MCP provider’s setup documentation for bearer token support and where to create an access token.',
        'Choose the permissions your agent needs and copy the token.',
      ]).map(step => <li key={step}>{step}</li>)}
      {local ? <>
        <li>Select <strong>Save token on this Mac</strong>, unlock Vault, and paste the token into the native prompt.</li>
        <li>In your private browser chat, ask your agent to use the connection. Review the tool and its arguments before allowing a call.</li>
      </> : <><li>Paste the token value into the field below, without the word <code>Bearer</code>, then select <strong>Save connection</strong>.</li>
      <li>Select <strong>Test connection</strong> to find tools, then <strong>Agent access</strong> to choose which tools your agent can use.</li></>}
    </ol>
    {guide && <a href={guide.docs} target="_blank" rel="noopener noreferrer">{guide.provider} token documentation</a>}
  </details>;
}

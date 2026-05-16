/**
 * Static MCP registry snapshot — hand-curated entries representing the top
 * MCP servers from github.com/mcp as of 2026-05-16. The page renders this
 * list directly; a live fetch against the directory is intentionally NOT
 * done in v0.4 (would require a TOS review + the directory has no
 * documented machine API yet). Refresh by hand when github.com/mcp
 * publishes a stable export.
 *
 * The Install button is a no-op for v0.4 — operators paste a URL into
 * `~/.stavr/bricks/manifest.yaml` to add a brick. Real install flow ships
 * in v0.6+ with the OAuth 2.1 + Resource Indicators work (ADR-035 phase 1).
 */

export type McpCategory =
  | 'dev'
  | 'database'
  | 'browser'
  | 'productivity'
  | 'game'
  | 'design'
  | 'monitoring'
  | 'cloud'
  | 'comms';

export interface MCPServerEntry {
  id: string;
  name: string;
  author: string;
  description: string;
  /** Star count snapshot from github.com/mcp (rough — used for sort only). */
  popularity: number;
  category: McpCategory;
  install_url: string;
  /** Emoji glyph used as the card icon. */
  logo_emoji?: string;
  /** When true, the page renders a small "auth needed" badge. */
  needs_auth?: boolean;
}

export const MCP_REGISTRY: MCPServerEntry[] = [
  { id: 'github',       name: 'GitHub',       author: 'github',        category: 'dev',          popularity: 29821, logo_emoji: '🐙', install_url: 'https://github.com/github/github-mcp-server',          needs_auth: true,  description: 'PRs, issues, repo browse and search via the GitHub REST + GraphQL APIs.' },
  { id: 'gitlab',       name: 'GitLab',       author: 'gitlab-org',    category: 'dev',          popularity: 8120,  logo_emoji: '🦊', install_url: 'https://github.com/gitlab-org/gitlab-mcp-server',      needs_auth: true,  description: 'Equivalent to the GitHub server but for self-hosted + SaaS GitLab.' },
  { id: 'filesystem',   name: 'Filesystem',   author: 'modelcontextprotocol', category: 'dev',    popularity: 22117, logo_emoji: '📁', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem', description: 'Read/write local files. The canonical reference server.' },
  { id: 'git',          name: 'Git',          author: 'modelcontextprotocol', category: 'dev',    popularity: 15402, logo_emoji: '🌿', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git', description: 'Branch ops, commits, diff/show. Local repo only.' },
  { id: 'postgres',     name: 'Postgres',     author: 'modelcontextprotocol', category: 'database', popularity: 13280, logo_emoji: '🐘', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/postgres', needs_auth: true, description: 'Read-only SQL access to a Postgres database via a connection string.' },
  { id: 'sqlite',       name: 'SQLite',       author: 'modelcontextprotocol', category: 'database', popularity: 9011,  logo_emoji: '🪶', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite', description: 'Query a local SQLite file.' },
  { id: 'puppeteer',    name: 'Puppeteer',    author: 'modelcontextprotocol', category: 'browser', popularity: 11530, logo_emoji: '🎭', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer', description: 'Headless browser automation — navigate, click, evaluate, screenshot.' },
  { id: 'playwright',   name: 'Playwright',   author: 'microsoft',     category: 'browser',      popularity: 14790, logo_emoji: '🎬', install_url: 'https://github.com/microsoft/playwright-mcp', description: 'Microsoft Playwright as an MCP server with multi-browser support.' },
  { id: 'unity',        name: 'Unity',        author: 'CoplayDev',     category: 'game',         popularity: 9587,  logo_emoji: '🎮', install_url: 'https://github.com/CoplayDev/unity-mcp', description: 'Control the Unity Editor from MCP clients.' },
  { id: 'unreal',       name: 'Unreal',       author: 'epicgames',     category: 'game',         popularity: 4112,  logo_emoji: '🎯', install_url: 'https://github.com/epicgames/unreal-mcp', description: 'Inspect and script the Unreal Editor.' },
  { id: 'blender',      name: 'Blender',      author: 'ahujasid',      category: 'design',       popularity: 8842,  logo_emoji: '🧊', install_url: 'https://github.com/ahujasid/blender-mcp', description: 'Drive Blender from an LLM — scene ops, objects, render.' },
  { id: 'figma',        name: 'Figma',        author: 'GLips',         category: 'design',       popularity: 7510,  logo_emoji: '🎨', install_url: 'https://github.com/GLips/Figma-Context-MCP', needs_auth: true, description: 'Read Figma frames + components for LLM-driven design tasks.' },
  { id: 'slack',        name: 'Slack',        author: 'modelcontextprotocol', category: 'comms',  popularity: 12340, logo_emoji: '💬', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/slack', needs_auth: true, description: 'Channels, messages, search across a Slack workspace.' },
  { id: 'gmail',        name: 'Gmail',        author: 'GongRzhe',      category: 'productivity', popularity: 8930,  logo_emoji: '📧', install_url: 'https://github.com/GongRzhe/Gmail-MCP-Server',          needs_auth: true,  description: 'Read + draft Gmail messages from the LLM.' },
  { id: 'gcal',         name: 'Google Calendar', author: 'GongRzhe',   category: 'productivity', popularity: 6402,  logo_emoji: '📅', install_url: 'https://github.com/GongRzhe/Calendar-MCP-Server',       needs_auth: true,  description: 'Read + create Google Calendar events.' },
  { id: 'gdrive',       name: 'Google Drive', author: 'modelcontextprotocol', category: 'productivity', popularity: 7211, logo_emoji: '🗂️', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/gdrive', needs_auth: true, description: 'List, search, read files in Google Drive.' },
  { id: 'notion',       name: 'Notion',       author: 'makenotion',    category: 'productivity', popularity: 9450,  logo_emoji: '📝', install_url: 'https://github.com/makenotion/notion-mcp-server',       needs_auth: true,  description: 'Pages, databases, comments in Notion.' },
  { id: 'linear',       name: 'Linear',       author: 'tacticlaunch',  category: 'productivity', popularity: 6182,  logo_emoji: '📐', install_url: 'https://github.com/tacticlaunch/mcp-linear',           needs_auth: true,  description: 'Create + list + comment on Linear issues.' },
  { id: 'jira',         name: 'Jira',         author: 'sooperset',     category: 'productivity', popularity: 5510,  logo_emoji: '🟦', install_url: 'https://github.com/sooperset/mcp-atlassian',          needs_auth: true,  description: 'Jira + Confluence via Atlassian REST APIs.' },
  { id: 'docker',       name: 'Docker',       author: 'docker',        category: 'dev',          popularity: 10210, logo_emoji: '🐳', install_url: 'https://github.com/docker/mcp-servers', description: 'Containers, images, compose, registries.' },
  { id: 'k8s',          name: 'Kubernetes',   author: 'Flux159',       category: 'cloud',        popularity: 6991,  logo_emoji: '☸️', install_url: 'https://github.com/Flux159/mcp-server-kubernetes', needs_auth: true, description: 'kubectl-style ops against the current kubeconfig.' },
  { id: 'aws',          name: 'AWS',          author: 'awslabs',       category: 'cloud',        popularity: 9341,  logo_emoji: '☁️', install_url: 'https://github.com/awslabs/mcp', needs_auth: true, description: 'S3, Lambda, CloudWatch, IAM read tools.' },
  { id: 'gcp',          name: 'Google Cloud', author: 'GoogleCloudPlatform', category: 'cloud',   popularity: 4880,  logo_emoji: '🌥️', install_url: 'https://github.com/GoogleCloudPlatform/gcp-mcp', needs_auth: true, description: 'Compute, GCS, BigQuery via gcloud auth.' },
  { id: 'azure',        name: 'Azure',        author: 'microsoft',     category: 'cloud',        popularity: 4012,  logo_emoji: '🟦', install_url: 'https://github.com/microsoft/mcp', needs_auth: true, description: 'Azure resource group + storage + compute.' },
  { id: 'sentry',       name: 'Sentry',       author: 'getsentry',     category: 'monitoring',   popularity: 3990,  logo_emoji: '🛰️', install_url: 'https://github.com/getsentry/sentry-mcp', needs_auth: true, description: 'Issues, releases, events from Sentry.' },
  { id: 'grafana',      name: 'Grafana',      author: 'grafana',       category: 'monitoring',   popularity: 4441,  logo_emoji: '📊', install_url: 'https://github.com/grafana/mcp-grafana', needs_auth: true, description: 'Query datasources + dashboards through Grafana.' },
  { id: 'prometheus',   name: 'Prometheus',   author: 'pab1it0',       category: 'monitoring',   popularity: 3210,  logo_emoji: '🔥', install_url: 'https://github.com/pab1it0/prometheus-mcp-server', needs_auth: false, description: 'PromQL queries against a Prometheus server.' },
  { id: 'datadog',      name: 'Datadog',      author: 'GeLi2001',      category: 'monitoring',   popularity: 2870,  logo_emoji: '🐕', install_url: 'https://github.com/GeLi2001/datadog-mcp-server', needs_auth: true, description: 'Datadog metrics, monitors, dashboards.' },
  { id: 'fetch',        name: 'Fetch',        author: 'modelcontextprotocol', category: 'dev',    popularity: 18811, logo_emoji: '🌐', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch', description: 'HTTP GET + html-to-markdown for web fetch.' },
  { id: 'time',         name: 'Time',         author: 'modelcontextprotocol', category: 'dev',    popularity: 6730,  logo_emoji: '⏱️', install_url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time', description: 'Time zone + current-time tools.' },
];

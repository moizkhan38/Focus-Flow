import { useState, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Plug, CheckCircle2, AlertCircle, Loader2, Trash2, ExternalLink,
  ShieldAlert, Github, Layers, MessageSquare, RefreshCw, Sparkles,
  ChevronDown, HelpCircle, Copy, Check,
} from 'lucide-react';
import { useIntegrations, useSlackStatus } from '../hooks/useIntegrations';
import { useNotifications } from '../hooks/useNotifications';
import { apiJson } from '../lib/api.js';

// Integrations settings (Phase 2, step 2.7).
// Each organization connects its OWN Jira + GitHub here. Tokens are write-only:
// they are sent to the backend, encrypted at rest, and never returned — so the
// inputs stay empty and connected state shows only non-secret metadata.

const cardVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
};

// ─── Setup guide (collapsible) ───────────────────────────────────────────────
// Each integration needs credentials fetched from a third-party console, and
// the steps are easy to get subtly wrong (which token, which scope, which URL).
// Collapsed by default so a connected org isn't nagged; one click when needed.

/** Inline literal — a value to copy, a menu path, or a URL. */
function Lit({ children }) {
  return (
    <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] text-heading dark:bg-white/10">
      {children}
    </code>
  );
}

function SetupGuide({ title = 'How do I get these details?', children }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mb-4 overflow-hidden rounded-lg border border-default">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-white/5"
      >
        <HelpCircle className="h-4 w-4 shrink-0 text-blue-500" />
        <span className="text-sm font-medium text-heading">{title}</span>
        <ChevronDown
          className={`ml-auto h-4 w-4 shrink-0 text-subtle transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-default px-3 py-3">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Numbered steps. Each child is one <li>. */
function Steps({ children }) {
  return (
    <ol className="list-decimal space-y-2 pl-5 text-xs leading-relaxed text-muted marker:text-subtle">
      {children}
    </ol>
  );
}

// ─── Slack app manifest ──────────────────────────────────────────────────────
// Slack has no API that creates a bot in someone's workspace on their behalf —
// installation requires a human admin to approve the scopes, by design. A
// manifest is the closest thing: one document describing the app, so Slack
// pre-fills the scopes, the slash command and both Request URLs. That removes
// the parts of setup people actually get wrong; the user is left with
// "Create", "Install", and pasting two values.

const SLACK_BOT_SCOPES = ['chat:write', 'users:read', 'users:read.email', 'commands'];

function buildSlackManifest(botUrl) {
  const base = (botUrl || 'https://your-bot-url').replace(/\/+$/, '');
  return JSON.stringify(
    {
      display_information: {
        name: 'Focus Flow',
        description: 'Collects daily standups and surfaces them on your Focus Flow dashboard.',
        background_color: '#0f0b59',
      },
      features: {
        bot_user: { display_name: 'Focus Flow', always_online: true },
        slash_commands: [
          {
            command: '/standup',
            url: `${base}/slack/command`,
            description: 'Submit your daily standup',
            should_escape: false,
          },
        ],
      },
      oauth_config: { scopes: { bot: SLACK_BOT_SCOPES } },
      settings: {
        interactivity: { is_enabled: true, request_url: `${base}/slack/events` },
        org_deploy_enabled: false,
        socket_mode_enabled: false,
        token_rotation_enabled: false,
      },
    },
    null,
    2
  );
}

function ManifestBlock({ botUrl }) {
  const [copied, setCopied] = useState(false);
  const manifest = buildSlackManifest(botUrl);
  // Anything that isn't a public https URL cannot be reached by Slack.
  const usable = !!botUrl && /^https:\/\//i.test(botUrl) && !/localhost|127\.0\.0\.1/i.test(botUrl);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(manifest);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-default p-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold text-heading">App manifest</span>
        <button
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1 rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white transition-colors hover:bg-blue-700"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy manifest'}
        </button>
      </div>

      {!usable && (
        <p className="mb-2 text-[11px] leading-relaxed text-amber-600">
          The bot URL below is a placeholder because this deployment has no public bot address
          configured yet. Replace <Lit>your-bot-url</Lit> with the real one before creating the app,
          or Slack will reject the Request URLs.
        </p>
      )}

      <pre className="max-h-56 overflow-auto rounded-md bg-gray-900 p-2.5 text-[10px] leading-relaxed text-gray-100">
        {manifest}
      </pre>
    </div>
  );
}

/** Callout for the mistake people actually make with this integration. */
function Gotcha({ children }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
      <p className="text-[11px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

export default function Settings() {
  const { jira, github, gemini, isAdmin, isLoading, mutate } = useIntegrations();
  const { slack, isLoading: slackLoading, mutate: refreshSlack } = useSlackStatus();

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-heading flex items-center gap-2">
          <Plug className="w-6 h-6 text-blue-600" />
          Integrations
        </h1>
        <p className="text-muted mt-1">
          Connect your organization's Jira and GitHub. Credentials are encrypted and
          scoped to this organization only. The Slack standup bot is configured on the
          server — its status is shown below.
        </p>
      </div>

      {!isAdmin && !isLoading && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
          <ShieldAlert className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-heading">Admin access required</p>
            <p className="text-sm text-muted">
              You can see connection status, but only an organization admin can change
              these integrations. Ask an org admin to connect or update them.
            </p>
          </div>
        </div>
      )}

      <motion.div
        className="space-y-6"
        initial="hidden"
        animate="show"
        variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08 } } }}
      >
        <motion.div variants={cardVariants}>
          <JiraCard status={jira} isAdmin={isAdmin} isLoading={isLoading} onChange={mutate} />
        </motion.div>
        <motion.div variants={cardVariants}>
          <GithubCard status={github} isAdmin={isAdmin} isLoading={isLoading} onChange={mutate} />
        </motion.div>
        <motion.div variants={cardVariants}>
          <SlackCard status={slack} isAdmin={isAdmin} isLoading={slackLoading} onRefresh={refreshSlack} />
        </motion.div>
        <motion.div variants={cardVariants}>
          <GeminiCard status={gemini} isAdmin={isAdmin} isLoading={isLoading} onChange={mutate} />
        </motion.div>
      </motion.div>
    </div>
  );
}

// ─── Shared card chrome ──────────────────────────────────────────────────────

function IntegrationCard({ icon: Icon, title, subtitle, status, isLoading, children }) {
  return (
    <div className="bg-card-theme border border-default rounded-xl p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-blue-50">
            <Icon className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="font-semibold text-heading">{title}</h2>
            <p className="text-sm text-muted">{subtitle}</p>
          </div>
        </div>
        <StatusBadge connected={status?.connected} isLoading={isLoading} />
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ connected, isLoading }) {
  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-subtle shrink-0">
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Checking...
      </span>
    );
  }
  return connected ? (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 shrink-0">
      <CheckCircle2 className="w-3.5 h-3.5" />
      Connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-subtle shrink-0">
      Not connected
    </span>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-heading mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-faint mt-1">{hint}</span>}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-default bg-transparent px-3 py-2 text-sm text-heading ' +
  'placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:opacity-50';

function CardActions({ isAdmin, connected, busy, onConnect, onTest, onDisconnect, connectLabel }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <button
        onClick={onConnect}
        disabled={!isAdmin || busy === 'connect'}
        className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy === 'connect' && <Loader2 className="w-4 h-4 animate-spin" />}
        {connectLabel}
      </button>

      {connected && (
        <>
          <button
            onClick={onTest}
            disabled={!isAdmin || busy === 'test'}
            className="inline-flex items-center gap-2 rounded-lg border border-default px-3.5 py-2 text-sm font-medium text-heading hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'test' && <Loader2 className="w-4 h-4 animate-spin" />}
            Test connection
          </button>
          <button
            onClick={onDisconnect}
            disabled={!isAdmin || busy === 'disconnect'}
            className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3.5 py-2 text-sm font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'disconnect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Disconnect
          </button>
        </>
      )}
    </div>
  );
}

function CardError({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
      <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
      <p className="text-sm text-red-600 break-words">{message}</p>
    </div>
  );
}

// Turn a backend error into something a human can act on. Jira/GitHub messages
// (bad credentials, wrong domain) are the user's own feedback and pass through.
function friendlyError(err) {
  if (err?.code === 'ORG_ADMIN_REQUIRED') return 'Only an organization admin can change integrations.';
  return err?.message || 'Something went wrong';
}

// ─── Jira ────────────────────────────────────────────────────────────────────

function JiraCard({ status, isAdmin, isLoading, onChange }) {
  const { notify } = useNotifications();
  const [domain, setDomain] = useState('');
  const [email, setEmail] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const connected = status?.connected;

  const handleConnect = async () => {
    setError('');
    setBusy('connect');
    try {
      await apiJson('/api/integrations/jira', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: domain.trim(), email: email.trim(), apiToken: apiToken.trim() }),
      });
      setDomain(''); setEmail(''); setApiToken('');
      await onChange();
      notify.success('Jira connected', 'Your organization is now linked to Jira.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setError('');
    setBusy('test');
    try {
      await apiJson('/api/integrations/jira/test', { method: 'POST' });
      notify.success('Jira connection OK', 'Stored credentials authenticated successfully.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Jira? Sprint boards, dashboards and syncing will stop working until you reconnect.')) return;
    setError('');
    setBusy('disconnect');
    try {
      await apiJson('/api/integrations/jira', { method: 'DELETE' });
      await onChange();
      notify.success('Jira disconnected', 'Credentials removed from this organization.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <IntegrationCard
      icon={Layers}
      title="Jira"
      subtitle="Create projects, sync epics and stories, track sprints."
      status={status}
      isLoading={isLoading}
    >
      {connected && (
        <p className="mb-4 text-sm text-muted">
          Connected as <span className="font-medium text-heading">{status.email}</span> on{' '}
          <span className="font-medium text-heading">{status.domain}</span>
        </p>
      )}

      <SetupGuide>
        <Steps>
          <li>
            Open your Jira site and look at the browser address bar. Your <strong>domain</strong> is
            the whole host, e.g. <Lit>acme.atlassian.net</Lit> — no <Lit>https://</Lit> and no
            trailing path.
          </li>
          <li>
            Go to <Lit>id.atlassian.com</Lit> → <Lit>Security</Lit> →{' '}
            <Lit>Create and manage API tokens</Lit>.
          </li>
          <li>
            Click <Lit>Create API token</Lit>, give it a label such as <Lit>Focus Flow</Lit>, and
            copy the value.
          </li>
          <li>
            The <strong>email</strong> is the Atlassian account you just created the token under —
            not a team alias.
          </li>
          <li>Paste all three below and press Connect Jira.</li>
        </Steps>
        <Gotcha>
          The token is shown <strong>once</strong> — if you close the dialog you must create a new
          one. Also, the account needs permission to create projects, because syncing builds the
          Jira project, board and sprints for you.
        </Gotcha>
      </SetupGuide>

      <div className="space-y-3 mb-4">
        <Field label="Jira domain" hint="Your Atlassian site, e.g. acme.atlassian.net">
          <input
            className={inputCls}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder={connected ? status.domain : 'acme.atlassian.net'}
            disabled={!isAdmin || !!busy}
          />
        </Field>

        <Field label="Atlassian account email">
          <input
            className={inputCls}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={connected ? status.email : 'you@company.com'}
            disabled={!isAdmin || !!busy}
          />
        </Field>

        <Field
          label="API token"
          hint={connected ? 'Stored securely — enter a new token only to replace it.' : 'Create one at id.atlassian.com → Security → API tokens.'}
        >
          <input
            className={inputCls}
            type="password"
            value={apiToken}
            onChange={(e) => setApiToken(e.target.value)}
            placeholder={connected ? '••••••••••••' : 'Paste your Jira API token'}
            disabled={!isAdmin || !!busy}
            autoComplete="off"
          />
        </Field>

        <a
          href="https://id.atlassian.com/manage-profile/security/api-tokens"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          Get a Jira API token <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="space-y-3">
        <CardError message={error} />
        <CardActions
          isAdmin={isAdmin}
          connected={connected}
          busy={busy}
          onConnect={handleConnect}
          onTest={handleTest}
          onDisconnect={handleDisconnect}
          connectLabel={connected ? 'Update credentials' : 'Connect Jira'}
        />
      </div>
    </IntegrationCard>
  );
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

function GithubCard({ status, isAdmin, isLoading, onChange }) {
  const { notify } = useNotifications();
  const [token, setToken] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const connected = status?.connected;

  // Show the saved organization once it loads, without stomping on typing.
  useEffect(() => {
    if (status?.owner) setOwner(status.owner);
  }, [status?.owner]);

  const handleConnect = async () => {
    setError('');
    setBusy('connect');
    try {
      await apiJson('/api/integrations/github', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), owner: owner.trim() }),
      });
      setToken('');
      await onChange();
      notify.success(
        'GitHub connected',
        owner.trim()
          ? `Project repositories will be created under ${owner.trim()}.`
          : 'Developer analysis can now read your repositories.'
      );
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setError('');
    setBusy('test');
    try {
      await apiJson('/api/integrations/github/test', { method: 'POST' });
      notify.success('GitHub connection OK', 'Stored token authenticated successfully.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect GitHub? Developer analysis and the daily refresh will stop working until you reconnect.')) return;
    setError('');
    setBusy('disconnect');
    try {
      await apiJson('/api/integrations/github', { method: 'DELETE' });
      await onChange();
      notify.success('GitHub disconnected', 'Token removed from this organization.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <IntegrationCard
      icon={Github}
      title="GitHub"
      subtitle="Analyze commit history to detect expertise and experience."
      status={status}
      isLoading={isLoading}
    >
      {connected && (
        <p className="mb-4 text-sm text-muted">
          Connected as <span className="font-medium text-heading">{status.login || 'unknown user'}</span>
          {status.tokenSuffix && (
            <> · token ending <span className="font-mono text-heading">…{status.tokenSuffix}</span></>
          )}
        </p>
      )}

      <SetupGuide>
        <Steps>
          <li>
            On GitHub, open <Lit>Settings</Lit> → <Lit>Developer settings</Lit> →{' '}
            <Lit>Personal access tokens</Lit>.
          </li>
          <li>
            Choose <Lit>Tokens (classic)</Lit> → <Lit>Generate new token</Lit>, or a fine-grained
            token if you prefer to scope it to specific repositories.
          </li>
          <li>
            Tick <Lit>repo</Lit> — the single scope that covers everything here: reading commit
            history, creating a private repository per project, and adding collaborators. No other
            scope is needed, including for organization-owned repositories.
          </li>
          <li>Set an expiry you're comfortable with, generate, and copy the token.</li>
          <li>
            Paste it below. If your team's code lives under a GitHub organization, put its name in
            the second field.
          </li>
        </Steps>
        <Gotcha>
          <strong>Tokens expire.</strong> When one does, every GitHub call returns 401 and developer
          analysis stops silently — press <Lit>Test</Lit> above to check. Generate a fresh token and
          paste it here to replace it.
        </Gotcha>
        <Gotcha>
          Creating a project creates a <strong>private</strong> repository named after it and invites
          the project's team with <strong>push</strong> access. Team members receive a GitHub
          invitation they must accept before they can push. Only developers already on your
          Developers page can be invited — an arbitrary GitHub username cannot be given access to
          your code through this app.
          {' '}For an organization-owned repository, the token owner must be allowed to create
          repositories in that organization, and if the org restricts personal access tokens you
          must approve this one under the organization's token policy.
        </Gotcha>
      </SetupGuide>

      <div className="space-y-3 mb-4">
        <Field
          label="Personal access token"
          hint={connected ? 'Stored securely — enter a new token only to replace it.' : 'Needs read access to the repositories you want analyzed (repo scope).'}
        >
          <input
            className={inputCls}
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={connected ? '••••••••••••' : 'Paste your GitHub personal access token'}
            disabled={!isAdmin || !!busy}
            autoComplete="off"
          />
        </Field>

        <Field
          label="GitHub organization (optional)"
          hint="Where a new project's repository is created. Leave blank to use the token owner's own account."
        >
          <input
            className={inputCls}
            type="text"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="my-company"
            disabled={!isAdmin || !!busy}
            autoComplete="off"
          />
        </Field>

        <a
          href="https://github.com/settings/tokens"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          Create a GitHub token <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="space-y-3">
        <CardError message={error} />
        <CardActions
          isAdmin={isAdmin}
          connected={connected}
          busy={busy}
          onConnect={handleConnect}
          onTest={handleTest}
          onDisconnect={handleDisconnect}
          connectLabel={connected ? 'Update token' : 'Connect GitHub'}
        />
      </div>
    </IntegrationCard>
  );
}

// ─── Slack / Standup bot ─────────────────────────────────────────────────────
//
// Read-only by design. Unlike Jira and GitHub, a Slack workspace cannot be
// connected by pasting a token — it must *install* the app via OAuth, and the
// install has to prove which org it belongs to. That is Phase 4; today the bot
// is bound to one workspace and one org through its own env (decision D6).
// Rather than render a form that cannot work, this card reports actual state.

// ─── Gemini (optional per-org key) ───────────────────────────────────────────
//
// Unlike Jira/GitHub/Slack this integration is OPTIONAL. Per decision D5 the
// Gemini key is platform-owned — AI generation is the product — so an org that
// connects nothing still generates epics using the platform key. Connecting a
// key here only overrides that for this organization, which is useful when the
// shared key hits its free-tier quota.

function GeminiCard({ status, isAdmin, isLoading, onChange }) {
  const { notify } = useNotifications();
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const connected = status?.connected;

  const handleConnect = async () => {
    setError('');
    setBusy('connect');
    try {
      await apiJson('/api/integrations/gemini', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      setApiKey('');
      await onChange();
      notify.success('Gemini key saved', 'This organization now generates using its own key.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setError('');
    setBusy('test');
    try {
      const r = await apiJson('/api/integrations/gemini/test', { method: 'POST' });
      if (r.ok) notify.success('Gemini key OK', 'Google accepted the stored key.');
      else setError(r.error || 'Google rejected the stored key.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Remove this key? Generation continues using the Focus Flow platform key.')) return;
    setError('');
    setBusy('disconnect');
    try {
      await apiJson('/api/integrations/gemini', { method: 'DELETE' });
      await onChange();
      notify.success('Gemini key removed', 'Back to the platform key.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <IntegrationCard
      icon={Sparkles}
      title="Gemini AI"
      subtitle="Powers epic, story and test-case generation."
      status={{ connected }}
      isLoading={isLoading}
    >
      <p className="mb-4 text-sm text-muted">
        {connected ? (
          <>
            Using this organization's own key
            {status.keySuffix && (
              <> · ending <span className="font-mono text-heading">…{status.keySuffix}</span></>
            )}
          </>
        ) : (
          <>Using the Focus Flow platform key. Optional — connect your own only if you want
          generation billed to your Google account or need higher quota.</>
        )}
      </p>

      <SetupGuide title="How do I get a Gemini API key?">
        <Steps>
          <li>
            Go to <Lit>aistudio.google.com/app/apikey</Lit> and sign in with a Google account.
          </li>
          <li>
            Click <Lit>Create API key</Lit> and either pick an existing Google Cloud project or let
            it create one.
          </li>
          <li>Copy the key and paste it below.</li>
          <li>
            Recommended: open that project in the Google Cloud console and{' '}
            <strong>enable billing</strong>. Without it you are on the free tier.
          </li>
        </Steps>
        <Gotcha>
          You do not need this at all — generation already works using the Focus Flow platform key.
          Connect your own only if you want usage billed to your Google account, or if you are
          hitting quota. Newly created projects often start with a free-tier limit of{' '}
          <Lit>0</Lit> requests per day, which returns HTTP <Lit>429</Lit> until billing is enabled.
        </Gotcha>
      </SetupGuide>

      <div className="space-y-3 mb-4">
        <Field
          label="Google AI Studio API key"
          hint={connected ? 'Stored securely — enter a new key only to replace it.' : 'Optional. Create one at aistudio.google.com → Get API key.'}
        >
          <input
            className={inputCls}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connected ? '••••••••••••' : 'Paste your Gemini API key'}
            disabled={!isAdmin || !!busy}
            autoComplete="off"
          />
        </Field>

        <a
          href="https://aistudio.google.com/app/apikey"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          Get a Gemini API key <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="space-y-3">
        <CardError message={error} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleConnect}
            disabled={!isAdmin || !!busy || !apiKey.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'connect' && <Loader2 className="w-4 h-4 animate-spin" />}
            {connected ? 'Update key' : 'Use my own key'}
          </button>

          {connected && (
            <>
              <button
                onClick={handleTest}
                disabled={!isAdmin || !!busy}
                className="inline-flex items-center gap-2 rounded-lg border border-default px-3.5 py-2 text-sm font-medium text-heading hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'test' && <Loader2 className="w-4 h-4 animate-spin" />}
                Test key
              </button>
              <button
                onClick={handleDisconnect}
                disabled={!isAdmin || !!busy}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3.5 py-2 text-sm font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
              >
                {busy === 'disconnect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Use platform key
              </button>
            </>
          )}
        </div>
      </div>
    </IntegrationCard>
  );
}

function SlackCard({ status, isAdmin, isLoading, onRefresh }) {
  const { notify } = useNotifications();
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [analyzerUrl, setAnalyzerUrl] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const stored = !!status?.credentialsStored;

  const handleConnect = async () => {
    setError('');
    setBusy('connect');
    try {
      const r = await apiJson('/api/integrations/slack', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          botToken: botToken.trim(),
          signingSecret: signingSecret.trim(),
          analyzerUrl: analyzerUrl.trim(),
        }),
      });
      setBotToken(''); setSigningSecret(''); setAnalyzerUrl('');
      await onRefresh();
      notify.success(
        'Slack connected',
        r.teamName ? `Workspace "${r.teamName}" saved.` : 'Credentials saved.'
      );
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    setError('');
    setBusy('test');
    try {
      const r = await apiJson('/api/integrations/slack/test', { method: 'POST' });
      if (r.ok) notify.success('Slack connection OK', r.teamName ? `Authenticated to "${r.teamName}".` : 'Token is valid.');
      else setError(r.error || 'Slack rejected the stored token.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Slack? The standup bot falls back to its own env vars, and stops working if it has none.')) return;
    setError('');
    setBusy('disconnect');
    try {
      await apiJson('/api/integrations/slack', { method: 'DELETE' });
      await onRefresh();
      notify.success('Slack disconnected', 'Credentials removed from this organization.');
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <IntegrationCard
      icon={MessageSquare}
      title="Slack — Standup Bot"
      subtitle="Collects daily standups via /standup and surfaces them on the dashboard."
      status={{ connected: stored }}
      isLoading={isLoading}
    >
      {isLoading && (
        <p className="text-sm text-muted flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking the bot…
        </p>
      )}

      {!isLoading && status && !status.reachable && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-heading">Bot not running</p>
            <p className="text-xs text-muted">
              The standup service is unreachable, so standup history won't load. It's an
              optional service — the rest of Focus Flow works without it.
            </p>
          </div>
        </div>
      )}

      {!isLoading && status && status.reachable && !status.authorized && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3">
          <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-heading">Bot rejected the connection</p>
            <p className="text-xs text-muted">
              INTERNAL_API_KEY doesn't match between the backend and the bot.
            </p>
          </div>
        </div>
      )}

      {/* Only the workspace name. The per-dependency checks, org binding, standup
          counts and credential-source notice were removed as clutter — the
          failure banners above still surface anything actually broken. */}
      {stored && (
        <p className="mb-4 text-sm text-muted">
          Connected to <span className="font-medium text-heading">{status.teamName || 'your workspace'}</span>
        </p>
      )}

      <SetupGuide title="How do I set up the Slack bot?">
        <p className="mb-2 text-[11px] leading-relaxed text-muted">
          Slack has no API that can create a bot in your workspace for us — installing an app
          always needs a workspace admin to approve its permissions. The manifest below is the
          next best thing: it pre-fills the permissions, the <Lit>/standup</Lit> command and both
          Request URLs, so you only have to click Create and Install.
        </p>
        <Steps>
          <li>Copy the manifest below.</li>
          <li>
            Go to <Lit>api.slack.com/apps</Lit> → <Lit>Create New App</Lit> →{' '}
            <strong>From an app manifest</strong>. Pick your workspace, paste the manifest, and
            confirm.
          </li>
          <li>
            Click <Lit>Install to Workspace</Lit> and approve the permissions.
          </li>
          <li>
            On <Lit>OAuth &amp; Permissions</Lit>, copy the <strong>Bot User OAuth Token</strong>{' '}
            (it starts with <Lit>xoxb-</Lit>). On <Lit>Basic Information</Lit>, copy the{' '}
            <strong>Signing Secret</strong>.
          </li>
          <li>Paste both below and press Connect Slack.</li>
          <li>
            Test it: type <Lit>/standup</Lit> in any Slack channel — the entry appears on your
            dashboard.
          </li>
        </Steps>

        <ManifestBlock botUrl={status?.botUrl} />

        <Gotcha>
          Slack verifies both Request URLs when the app is created, so the standup bot must already
          be deployed and publicly reachable or the manifest is rejected. The manifest sets the four
          permissions the bot genuinely needs — <Lit>chat:write</Lit>, <Lit>users:read</Lit>,{' '}
          <Lit>users:read.email</Lit>, <Lit>commands</Lit> — and nothing more.
        </Gotcha>
      </SetupGuide>

      <div className="space-y-3 mb-4">
        <Field
          label="Bot User OAuth Token"
          hint={stored ? 'Stored securely — enter a new token only to replace it.' : 'OAuth & Permissions → Bot User OAuth Token. Starts with xoxb-.'}
        >
          <input
            className={inputCls}
            type="password"
            value={botToken}
            onChange={(e) => setBotToken(e.target.value)}
            placeholder={stored ? '••••••••••••' : 'xoxb-…'}
            disabled={!isAdmin || !!busy}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Signing secret"
          hint="Basic Information → App Credentials → Signing Secret. Used to verify requests genuinely come from Slack."
        >
          <input
            className={inputCls}
            type="password"
            value={signingSecret}
            onChange={(e) => setSigningSecret(e.target.value)}
            placeholder={stored ? '••••••••••••' : 'Paste your signing secret'}
            disabled={!isAdmin || !!busy}
            autoComplete="off"
          />
        </Field>

        <Field
          label="Standup analyzer URL"
          hint={
            status?.analyzerConfigured
              ? `Currently forwarding to ${status.analyzerHost}. Re-enter the full URL to change it.`
              : 'Optional webhook each standup is forwarded to after analysis.'
          }
        >
          <input
            className={inputCls}
            type="url"
            value={analyzerUrl}
            onChange={(e) => setAnalyzerUrl(e.target.value)}
            // Only the host is shown back, never the full URL: for most webhook
            // providers the path is itself the secret.
            placeholder={
              status?.analyzerConfigured
                ? `saved — ${status.analyzerHost}`
                : 'https://example.com/analyze (optional)'
            }
            disabled={!isAdmin || !!busy}
          />
        </Field>

        <a
          href="https://api.slack.com/apps"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
        >
          Open Slack app settings <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="space-y-3 pt-1">
        <CardError message={error} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleConnect}
            disabled={!isAdmin || !!busy || !botToken.trim() || !signingSecret.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy === 'connect' && <Loader2 className="w-4 h-4 animate-spin" />}
            {stored ? 'Update credentials' : 'Connect Slack'}
          </button>

          {stored && (
            <>
              <button
                onClick={handleTest}
                disabled={!isAdmin || !!busy}
                className="inline-flex items-center gap-2 rounded-lg border border-default px-3.5 py-2 text-sm font-medium text-heading hover:bg-gray-50 disabled:opacity-50"
              >
                {busy === 'test' && <Loader2 className="w-4 h-4 animate-spin" />}
                Test connection
              </button>
              <button
                onClick={handleDisconnect}
                disabled={!isAdmin || !!busy}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3.5 py-2 text-sm font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
              >
                {busy === 'disconnect' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Disconnect
              </button>
            </>
          )}

          <button
            onClick={onRefresh}
            disabled={isLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-default px-3.5 py-2 text-sm font-medium text-heading hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            Re-check
          </button>
        </div>
      </div>
    </IntegrationCard>
  );
}

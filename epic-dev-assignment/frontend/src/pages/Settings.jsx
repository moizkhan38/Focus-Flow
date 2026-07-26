import { useState } from 'react';
import { motion } from 'framer-motion';
import {
  Plug, CheckCircle2, AlertCircle, Loader2, Trash2, ExternalLink,
  ShieldAlert, Github, Layers, MessageSquare, RefreshCw, XCircle, Info,
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

export default function Settings() {
  const { jira, github, isAdmin, isLoading, mutate } = useIntegrations();
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
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const connected = status?.connected;

  const handleConnect = async () => {
    setError('');
    setBusy('connect');
    try {
      await apiJson('/api/integrations/github', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      setToken('');
      await onChange();
      notify.success('GitHub connected', 'Developer analysis can now read your repositories.');
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

function CheckRow({ ok, label, detail }) {
  return (
    <div className="flex items-start gap-2">
      {ok
        ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
        : <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />}
      <div className="min-w-0">
        <p className="text-sm text-heading">{label}</p>
        {detail && <p className="text-xs text-faint break-words">{detail}</p>}
      </div>
    </div>
  );
}

function SlackCard({ status, isAdmin, isLoading, onRefresh }) {
  const { notify } = useNotifications();
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [analyzerUrl, setAnalyzerUrl] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  const cfg = status?.configured;
  const lastAt = status?.lastStandupAt ? new Date(status.lastStandupAt) : null;
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

      {!isLoading && status?.reachable && status?.authorized && (
        <>
          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            <CheckRow ok={cfg?.slack} label="Slack token" detail={status.workspace ? `Workspace: ${status.workspace}` : 'SLACK_BOT_TOKEN not set'} />
            <CheckRow ok={cfg?.signingSecret} label="Signing secret" detail={cfg?.signingSecret ? 'Requests are verified' : 'SLACK_SIGNING_SECRET not set'} />
            <CheckRow ok={cfg?.gemini} label="Gemini key" detail={cfg?.gemini ? 'Standup analysis enabled' : 'GEMINI_API_KEY not set'} />
            <CheckRow ok={cfg?.jira} label="Jira (bot's own)" detail={status.jiraProjectKey ? `Default project: ${status.jiraProjectKey}` : 'JIRA_URL / JIRA_API_TOKEN not set'} />
          </div>

          {/* The single most consequential setting: if the bot is bound to a
              different org, its standups never appear for this one. */}
          <div
            className={`mb-4 flex items-start gap-2 rounded-lg border p-3 ${
              status.boundToThisOrg
                ? 'border-emerald-500/30 bg-emerald-500/10'
                : 'border-amber-500/30 bg-amber-500/10'
            }`}
          >
            {status.boundToThisOrg
              ? <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
              : <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <p className="text-sm font-medium text-heading">
                {status.boundToThisOrg
                  ? 'Bound to this organization'
                  : status.boundOrgId
                    ? 'Bound to a different organization'
                    : 'No organization binding'}
              </p>
              <p className="text-xs text-muted break-words">
                {status.boundToThisOrg
                  ? 'Standups submitted in Slack appear on this org\'s dashboard.'
                  : status.boundOrgId
                    ? `The bot writes standups to ${status.boundOrgId}, not here. Set STANDUP_ORG_ID to this org to change that.`
                    : 'STANDUP_ORG_ID is empty, so standups are not attached to any organization.'}
              </p>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
            <span>{status.standupCount} standup{status.standupCount === 1 ? '' : 's'} recorded</span>
            {lastAt && <span>Last: {lastAt.toLocaleString()}</span>}
            {status.reminder && <span>Daily reminder: {status.reminder}</span>}
          </div>
        </>
      )}

      {stored && (
        <p className="mb-4 text-sm text-muted">
          Connected to <span className="font-medium text-heading">{status.teamName || 'your workspace'}</span>
          {status.tokenSuffix && (
            <> · token ending <span className="font-mono text-heading">…{status.tokenSuffix}</span></>
          )}
        </p>
      )}

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
          hint="Optional webhook each standup is forwarded to after analysis."
        >
          <input
            className={inputCls}
            type="url"
            value={analyzerUrl}
            onChange={(e) => setAnalyzerUrl(e.target.value)}
            placeholder={status?.analyzerUrl || 'https://example.com/analyze (optional)'}
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

      {/* Saved credentials only take effect once the bot fetches them. Say so,
          rather than letting "Connected" imply standups are flowing. */}
      {stored && status?.reachable && status?.credentialSource === 'env' && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-xs text-muted">
            Saved here, but the bot is still using its own environment variables. It
            re-checks about once a minute — use Re-check below, or restart the bot.
          </p>
        </div>
      )}

      <div className="flex items-start gap-2 rounded-lg border border-default p-3">
        <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
        <p className="text-xs text-muted">
          Create the Slack app in your own workspace first, then paste its credentials
          here. Point the <span className="font-mono">/standup</span> command at{' '}
          <span className="font-mono">/slack/command</span> and Interactivity at{' '}
          <span className="font-mono">/slack/events</span> on the bot's public URL.
        </p>
      </div>

      <div className="space-y-3 pt-3">
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

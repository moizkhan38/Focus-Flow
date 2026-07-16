import { useState } from 'react';
import {
  Plug, CheckCircle2, AlertCircle, Loader2, Trash2, ExternalLink,
  ShieldAlert, Github, Layers,
} from 'lucide-react';
import { useIntegrations } from '../hooks/useIntegrations';
import { useNotifications } from '../hooks/useNotifications';
import { apiJson } from '../lib/api.js';

// Integrations settings (Phase 2, step 2.7).
// Each organization connects its OWN Jira + GitHub here. Tokens are write-only:
// they are sent to the backend, encrypted at rest, and never returned — so the
// inputs stay empty and connected state shows only non-secret metadata.

export default function Settings() {
  const { jira, github, isAdmin, isLoading, mutate } = useIntegrations();

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-heading flex items-center gap-2">
          <Plug className="w-6 h-6 text-blue-600" />
          Integrations
        </h1>
        <p className="text-muted mt-1">
          Connect your organization's Jira and GitHub. Credentials are encrypted and
          scoped to this organization only.
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

      <div className="space-y-6">
        <JiraCard status={jira} isAdmin={isAdmin} isLoading={isLoading} onChange={mutate} />
        <GithubCard status={github} isAdmin={isAdmin} isLoading={isLoading} onChange={mutate} />
      </div>
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

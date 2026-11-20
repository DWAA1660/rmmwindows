import { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  Check,
  Copy,
  Download,
  Monitor,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import type { RequestFn, User } from '../types';
import { formatBytes, formatTimestamp } from '../uiUtils';
import { JoinRequests, type JoinRequest } from '../JoinRequests';
import { EmptyState } from './UiPrimitives';
import type { ConfirmDialogState } from './ConfirmDialog';

export function AgentInstaller({ request }: { request: RequestFn }) {
  const [manifest, setManifest] = useState<{
    version: string;
    runtime: string;
    sizeBytes: number;
    sha256: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    request<{ version: string; runtime: string; sizeBytes: number; sha256: string }>(
      '/agent-download',
    )
      .then((value) => {
        if (active) setManifest(value);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [request]);

  const command = `$ProgressPreference = 'SilentlyContinue'\n[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12\n$installer = Join-Path $env:TEMP 'Install-LibraryRmm.ps1'\nInvoke-WebRequest -UseBasicParsing '${window.location.origin}/install.ps1' -OutFile $installer\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer\nif ($LASTEXITCODE -ne 0) { throw "Library RMM install failed with exit code $LASTEXITCODE" }`;

  return (
    <section className="panel agent-installer">
      <div className="panel-heading">
        <div>
          <h2>Install Windows agent</h2>
          <p>Run in an elevated PowerShell window or via your deployment tool as SYSTEM.</p>
        </div>
        <Download size={18} className="muted-icon" />
      </div>

      <div className="agent-installer-body">
        <div className="agent-download-actions">
          <a
            className={`button primary ${!manifest ? 'download-unavailable' : ''}`}
            href="/install.ps1"
            download
            aria-disabled={!manifest}
            onClick={(event) => {
              if (!manifest) event.preventDefault();
            }}
          >
            <Download size={15} /> Download install.ps1
          </a>
          <a
            className={`button secondary ${!manifest ? 'download-unavailable' : ''}`}
            href="/downloads/library-rmm-agent-win-x64.zip"
            download
            aria-disabled={!manifest}
            onClick={(event) => {
              if (!manifest) event.preventDefault();
            }}
          >
            <ArrowDownToLine size={15} /> Download agent ZIP
          </a>
          <span className="muted tabular">
            {manifest
              ? `v${manifest.version} · Windows x64 · ${formatBytes(manifest.sizeBytes)}`
              : error || 'Checking package availability…'}
          </span>
        </div>

        <div className="agent-command-heading">
          <strong>PowerShell install command</strong>
          <button
            type="button"
            className="button small secondary"
            disabled={!manifest}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(command);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2500);
              } catch {
                setError('Clipboard unavailable. Select and copy the command below.');
              }
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}{' '}
            {copied ? 'Copied' : 'Copy command'}
          </button>
        </div>
        <pre className="agent-install-command">
          <code>{command}</code>
        </pre>

        <p className="installer-note">
          The installer verifies the SHA-256 package checksum and installs the agent without
          requiring a reboot. New endpoints request approval above; re-running on an existing
          endpoint updates the agent while keeping its identity.
        </p>

        {manifest && (
          <details className="agent-package-integrity">
            <summary>Package SHA-256 checksum</summary>
            <code className="mono">{manifest.sha256}</code>
            <a
              className="text-button"
              href="/downloads/library-rmm-agent-win-x64.zip.sha256"
              download
            >
              Download .sha256
            </a>
          </details>
        )}
        {manifest && error && (
          <p role="alert" className="danger-text">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export function EnrollmentView({
  joinRequests,
  tokens,
  user,
  request,
  refresh,
  onConfirm,
  onCreateToken,
}: {
  joinRequests: JoinRequest[];
  tokens: Record<string, unknown>[];
  user: User;
  request: RequestFn;
  refresh: () => Promise<void>;
  onConfirm: (dialog: ConfirmDialogState) => void;
  onCreateToken: () => void;
}) {
  return (
    <div className="view-stack">
      <div className="enrollment-steps">
        <section className="panel step-card">
          <div className="step-head">
            <span className="step-number">01</span>
            <Download size={18} />
          </div>
          <h2>Install the agent</h2>
          <p>Run the elevated PowerShell install command below. No enrollment token is required.</p>
        </section>
        <section className="panel step-card">
          <div className="step-head">
            <span className="step-number">02</span>
            <ShieldCheck size={18} />
          </div>
          <h2>Approve enrollment</h2>
          <p>Computers check in under Waiting for approval. Verify the hostname and IP first.</p>
        </section>
        <section className="panel step-card">
          <div className="step-head">
            <span className="step-number">03</span>
            <Monitor size={18} />
          </div>
          <h2>Manage endpoint</h2>
          <p>The agent connects outbound over HTTPS, reports inventory, and joins your fleet.</p>
        </section>
      </div>

      <JoinRequests
        requests={joinRequests}
        request={request}
        canDecide={user.role !== 'viewer'}
        onChanged={() => void refresh()}
        onConfirm={onConfirm}
      />

      <AgentInstaller request={request} />

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Enrollment tokens (optional)</h2>
            <p>
              Use tokens only for unattended rollouts that skip approval (pass{' '}
              <code>-EnrollmentToken</code> to the installer). Secrets are displayed once.
            </p>
          </div>
          {user.role !== 'viewer' && (
            <button
              type="button"
              className="button secondary small"
              onClick={onCreateToken}
            >
              <Plus size={14} /> Create token
            </button>
          )}
        </div>
        {tokens.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Uses</th>
                  <th>Expires</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token, i) => (
                  <tr key={String(token.id || i)}>
                    <td>
                      <strong>{String(token.label || 'Enrollment token')}</strong>
                    </td>
                    <td className="tabular">
                      {String(token.uses ?? token.usedCount ?? 0)} / {String(token.maxUses ?? '—')}
                    </td>
                    <td className="tabular">{formatTimestamp(String(token.expiresAt || ''))}</td>
                    <td className="tabular">{formatTimestamp(String(token.createdAt || ''))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={ShieldCheck}
            title="No enrollment tokens"
            description="Tokens are optional. Standard installations appear in Waiting for approval above."
          />
        )}
      </section>

      <div className="info-note">
        <ShieldCheck size={16} />
        <p>
          Packages are served directly from this server (<code>{window.location.origin}</code>). No
          credentials or secrets are embedded in public download URLs.
        </p>
      </div>
    </div>
  );
}

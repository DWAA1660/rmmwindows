import { useEffect, useState } from "react";
import { ArrowRight, Folder, LockKeyhole, Pencil, Plus, Trash2 } from "lucide-react";
import "./EndpointGroups.css";

export type EndpointGroup = {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
  autoUpdate?: boolean;
  endpointCount: number;
  onlineCount: number;
};
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

export function EndpointGroups({
  groups,
  current,
  onChange,
  members,
  onSelect,
  request,
  refresh,
  onError,
  readOnly,
  onAdd,
}: {
  groups: EndpointGroup[];
  current: string;
  onChange: (id: string) => void;
  members: { id: string; groupId?: string; online?: boolean }[];
  onSelect: (ids: string[]) => void;
  request: Request;
  refresh: () => Promise<void>;
  onError: (e: unknown) => void;
  readOnly: boolean;
  onAdd: () => void;
}) {
  const [editing, setEditing] = useState<EndpointGroup | null | undefined>(),
    [name, setName] = useState(""),
    [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState<EndpointGroup | null>(null),
    [deleteDestination, setDeleteDestination] = useState("new-endpoints");
  const group = groups.find((item) => item.id === current);
  const ids = members
    .filter((endpoint) => current === "all" || endpoint.groupId === current)
    .map((endpoint) => endpoint.id);
  const defaultId =
    groups.find((item) => item.isDefault)?.id || "new-endpoints";
  const deletingGroup = deleting
    ? groups.find((item) => item.id === deleting.id) || deleting
    : null;
  const targetName =
    groups.find((item) => item.id === deleteDestination)?.name ||
    "New endpoints";
  useEffect(() => {
    if (readOnly) {
      setEditing(undefined);
      setDeleting(null);
    }
  }, [readOnly]);
  const work = async (fn: () => Promise<void>) => {
    if (busy || readOnly) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      onError(failure);
    } finally {
      setBusy(false);
    }
  };
  const edit = (value: EndpointGroup | null) => {
    setDeleting(null);
    setError("");
    setMessage("");
    setEditing(value);
    setName(value?.name || "");
    setDescription(value?.description || "");
  };
  const choose = (id: string) => {
    setDeleting(null);
    setEditing(undefined);
    setError("");
    onChange(id);
  };
  const startDelete = (value: EndpointGroup) => {
    if (value.isDefault || readOnly) return;
    setEditing(undefined);
    setError("");
    setMessage("");
    setDeleting(value);
    setDeleteDestination(defaultId);
  };

  const online = members.filter(
    (endpoint) => endpoint.online && (current === "all" || endpoint.groupId === current),
  ).length;
  return (
    <div className="endpoint-groups">
      <div className="group-strip">
        <div className="group-tabs" role="group" aria-label="Endpoint groups">
          <button
            className={current === "all" ? "active" : ""}
            aria-pressed={current === "all"}
            disabled={busy}
            onClick={() => choose("all")}
          >
            <strong>All endpoints</strong>
            <span>{members.length}</span>
          </button>
          {groups.map((item) => (
            <button
              key={item.id}
              className={current === item.id ? "active" : ""}
              aria-pressed={current === item.id}
              disabled={busy}
              title={`${item.endpointCount} computers · ${item.onlineCount} online${item.autoUpdate === false ? " · automatic agent updates off" : ""}`}
              onClick={() => choose(item.id)}
            >
              <strong>{item.name}</strong>
              <span>{item.endpointCount}</span>
              {item.autoUpdate === false && <em>updates off</em>}
            </button>
          ))}
        </div>
        {!readOnly && (
          <button
            className="button small secondary group-create"
            disabled={busy}
            onClick={() => edit(null)}
          >
            <Plus size={14} />
            New group
          </button>
        )}
      </div>
      <div className="group-selected-heading">
        <div>
          <span className="group-heading-icon">
            <Folder size={18} />
          </span>
          <div>
            <h3>{group?.name || "All endpoints"}</h3>
            <p>
              {ids.length} computer{ids.length === 1 ? "" : "s"} · {online} online
              {group?.description ? ` · ${group.description}` : ""}
              {group?.isDefault ? " · New agents join here after approval" : ""}
            </p>
          </div>
        </div>
        <div className="group-management">
          {group && (
            <label
              className="group-auto-update"
              title={
                group.autoUpdate !== false
                  ? "Agents in this group install new versions on their own when idle."
                  : "Off: agents in this group never update on their own. Use this for restore-protected computers, and update them with Update agent while they are unfrozen. Agents older than 0.1.9 still update on their own until they get 0.1.9."
              }
            >
              <input
                type="checkbox"
                role="switch"
                checked={group.autoUpdate !== false}
                disabled={busy || readOnly}
                onChange={(event) => {
                  const autoUpdate = event.target.checked;
                  void work(async () => {
                    await request(`/groups/${group.id}/auto-update`, "PUT", { autoUpdate });
                    await refresh();
                    setMessage(
                      autoUpdate
                        ? `Automatic agent updates are on for ${group.name}.`
                        : `Automatic agent updates are off for ${group.name}. Use Update agent on a computer to update it manually.`,
                    );
                  });
                }}
              />
              <span>Automatic agent updates</span>
            </label>
          )}
          {group?.isDefault && !readOnly && (
            <button className="button small secondary" onClick={onAdd}>
              <Plus size={13} />
              Install / approve endpoints
            </button>
          )}
          {group?.isDefault ? (
            <span className="group-protected">
              <LockKeyhole size={12} />
              Default group · protected
            </span>
          ) : group && !readOnly ? (
            <>
              <button
                className="button small secondary"
                disabled={busy}
                onClick={() => edit(group)}
              >
                <Pencil size={13} />
                Edit group
              </button>
              <button
                className="button small group-delete-trigger"
                disabled={busy}
                onClick={() => startDelete(group)}
              >
                <Trash2 size={13} />
                Delete group
              </button>
            </>
          ) : null}
        </div>
      </div>
      {group?.autoUpdate === false && (
        <p className="group-note">
          Automatic agent updates are off: agents in this group never update on their own. Use this for restore-protected
          computers, and update them with Update agent while they are unfrozen. Agents older than 0.1.9 still update on
          their own until they get 0.1.9.
        </p>
      )}
      {error && (
        <p className="group-feedback group-feedback-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="group-feedback group-feedback-success" role="status">
          {message}
        </p>
      )}
      {deletingGroup && !readOnly && (
        <form
          className="group-delete-confirm"
          onSubmit={(event) => {
            event.preventDefault();
            void work(async () => {
              await request(`/groups/${deletingGroup.id}`, "DELETE", {
                moveToGroupId: deleteDestination,
              });
              const deletedName = deletingGroup.name;
              setDeleting(null);
              onChange(deleteDestination);
              onSelect([]);
              await refresh();
              setMessage(
                `Group “${deletedName}” deleted. Its computers are in “${targetName}”; computers, jobs, and history were preserved.`,
              );
            });
          }}
          aria-label={`Confirm deletion of ${deletingGroup.name}`}
        >
          <div className="group-delete-heading">
            <span>
              <Trash2 size={19} />
            </span>
            <div>
              <h3>Delete “{deletingGroup.name}”?</h3>
              <p>
                This removes the group. It does not delete, revoke, uninstall,
                or reboot any computer.
              </p>
            </div>
          </div>
          <div className="group-delete-impact">
            <strong>
              {deletingGroup.endpointCount} computer
              {deletingGroup.endpointCount === 1 ? "" : "s"}
            </strong>
            <ArrowRight size={16} />
            <span>
              All current members will move to the group below. Their existing
              jobs and history remain available.
            </span>
          </div>
          <label>
            Move computers to
            <select
              autoFocus
              required
              value={deleteDestination}
              disabled={busy}
              onChange={(event) => setDeleteDestination(event.target.value)}
            >
              {groups
                .filter((item) => item.id !== deletingGroup.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.isDefault ? " (default)" : ""}
                  </option>
                ))}
            </select>
          </label>
          <div className="group-delete-footer">
            <span>
              Destination: <strong>{targetName}</strong>
            </span>
            <div>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button danger"
                disabled={
                  busy ||
                  deleteDestination === deletingGroup.id ||
                  !groups.some((item) => item.id === deleteDestination)
                }
              >
                <Trash2 size={14} />
                {busy ? "Deleting group…" : "Delete group & move computers"}
              </button>
            </div>
          </div>
        </form>
      )}
      {editing !== undefined && !readOnly && (
        <form
          className="group-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void work(async () => {
              const result = await request<EndpointGroup>(
                editing ? `/groups/${editing.id}` : "/groups",
                editing ? "PATCH" : "POST",
                { name, description },
              );
              setEditing(undefined);
              await refresh();
              onChange(result.id);
              setMessage("Group saved.");
            });
          }}
        >
          <h3>{editing ? "Edit group" : "Create group"}</h3>
          <label>
            Group name
            <input
              required
              maxLength={100}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Cody public computers"
            />
          </label>
          <label>
            Description
            <input
              maxLength={1000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div>
            <button className="button primary" disabled={busy}>
              Save group
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={() => setEditing(undefined)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

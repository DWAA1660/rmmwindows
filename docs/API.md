# API contract v1

All paths begin `/api`. JSON, UTC ISO timestamps. Operator routes require an HttpOnly session; state-changing routes require same-origin validation and CSRF header as implemented by server. Agent routes require `Authorization: Bearer <agentToken>` and are isolated from operator sessions.

## Agent protocol (owned by server + agent)

- `POST /agent/enroll`: `{ enrollmentToken, deviceId, hostname }` -> `{endpointId,agentToken}`. Persist token in protected ProgramData; never log.
- `POST /agent/checkin`: `{bootId, inventory}` -> `{endpointId,serverTime}`. `inventory` may be omitted for heartbeat. Canonical inventory below.
- `POST /agent/jobs/claim`: `{}` -> `{job:null}` or `{job:{id,kind,payload,dispatchToken,timeoutSeconds}}`. Atomically consumes a queued job, never redelivered.
- `POST /agent/jobs/:id/start`: `{dispatchToken}` -> `{mayExecute:true}` only for first valid start. Subsequent starts -> `{mayExecute:false}`. Must receive true before executing.
- `PUT /agent/jobs/:id/output/:sequence`: `{stream:"stdout"|"stderr"|"system",text}`. Contiguous sequence integer starting at 0 across all streams, max 65536 UTF-8 bytes per chunk. Exact duplicate succeeds, mismatched duplicate/gap rejected. Preserve all accepted output. Agent retries upload, never execution.
- `POST /agent/jobs/:id/complete`: `{status:"succeeded"|"failed"|"interrupted",exitCode,summary}`. Idempotent matching completion; conflicting completion rejected.

Inventory `{hostname,osName,osVersion,architecture,domain,domainJoined,ipv4:[],loggedOnUser,bootTime,cpuPercent,memoryTotalBytes,memoryUsedBytes,agentVersion,disks:[{name,label,totalBytes,freeBytes}],software:[{name,version,publisher,installDate}]}`. Metrics may be null when unavailable. `bootId` is Windows last boot UTC timestamp.

PowerShell payload `{script}`. Reboot payload `{delaySeconds:30,reason}` with delay >=30 seconds. Inventory payload `{}`. Storage payload `{path:"C:\\"}` lists direct child file/folder sizes read-only with errors, bounded recursive traversal; emits structured JSON as stdout. No file deletion or arbitrary remote file content route.

## Operator protocol (owned by server + web)

- `GET /health`, `GET /auth/me`, `POST /auth/login {username,password}`, `POST /auth/logout`.
- `GET /overview` -> totals/stats; `GET /endpoints` -> array; `GET /endpoints/:id` -> endpoint incl inventory; `PATCH /endpoints/:id {displayName,tags}`; `POST /endpoints/:id/revoke`.
- `POST /enrollment-tokens {label,maxUses,expiresInHours}` -> token shown once. `GET /enrollment-tokens` lists metadata.
- `GET /jobs?endpointId=` -> array; `POST /jobs {endpointIds:[],kind,payload,timeoutSeconds?,idempotencyKey?}` -> `{jobs:[]}`; `GET /jobs/:id`; `GET /jobs/:id/output?after=-1&limit=200` -> `{chunks:[{sequence,stream,text}],nextCursor,hasMore}`; `GET /jobs/:id/download` text attachment. `POST /jobs/:id/cancel` only queued jobs can cancel.
- `GET /scripts` array; `POST /scripts {name,description,body}`; `PUT /scripts/:id {name,description,body}`; `DELETE /scripts/:id`.
- `GET /schedules` array; `POST /schedules {name,scriptId,endpointIds,intervalMinutes,startsAt?,enabled}`; `PATCH /schedules/:id {enabled}`; `DELETE /schedules/:id`. No catch-up replay after downtime, occurrence unique in server ledger.
- `GET /audit?limit=100`; `GET /settings` -> version/update capability etc; `POST /settings/update` requests app image pull/restart, admin-only; `GET /settings/update` -> helper status.

Operator response entities have string UUID `id`. Endpoint includes `displayName,hostname,lastSeen,online,inventory,tags,revoked`. Job includes `id,endpointId,kind,payload,status,createdAt,startedAt,completedAt,summary,exitCode`. Script includes `id,name,description,body,updatedAt`. Schedule includes `id,name,scriptId,endpointIds,intervalMinutes,nextRunAt,enabled`. Errors `{error:string}` with HTTP status. `GET /auth/me` -> `{user:{username,role:"admin"},csrfToken}` or 401.

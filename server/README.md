# Mneme Sync Server

Optional sync server for claude-mneme, enabling memory synchronization across multiple machines.

## Quick Start

```bash
# Start the server
node server/mneme-server.mjs

# Server runs on port 3847 by default
# Data stored in ~/.mneme-server/projects/
```

## Configuration

Create `~/.mneme-server/config.json`:

```json
{
  "port": 3847,
  "dataDir": "~/.mneme-server",
  "apiKeys": [],
  "lockTTLMinutes": 30
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `port` | `3847` | Port to listen on |
| `dataDir` | `~/.mneme-server` | Where to store project data |
| `apiKeys` | `[]` | API keys for authentication (empty = no auth) |
| `lockTTLMinutes` | `30` | Lock expiration time |

## Authentication

To require API key authentication, add keys to the config:

```json
{
  "apiKeys": ["your-secret-key-1", "your-secret-key-2"]
}
```

Clients must include the key in requests:
```
Authorization: Bearer your-secret-key-1
```

## API Endpoints

### Health Check

```
GET /
GET /health
```

Returns server status and whether auth is required.

### Lock Management

```
POST   /projects/:id/lock           # Acquire lock
DELETE /projects/:id/lock           # Release lock
GET    /projects/:id/lock           # Check lock status
POST   /projects/:id/lock/heartbeat # Extend lock TTL
```

All lock operations require `X-Client-Id` header.

**Acquire lock response:**
```json
{
  "success": true,
  "lock": {
    "clientId": "machine-uuid",
    "acquiredAt": "2025-02-04T15:00:00Z",
    "expiresAt": "2025-02-04T15:30:00Z"
  }
}
```

**Lock conflict (409):**
```json
{
  "error": "Lock held by another client",
  "lock": { "clientId": "other-machine", ... }
}
```

### File Operations

```
GET /projects/:id/files             # List files with mtimes
GET /projects/:id/files/:name       # Download file
PUT /projects/:id/files/:name       # Upload file (requires lock)
```

**Files that can be synced:**
- `log.jsonl` - Activity log
- `summary.json` - Structured summary
- `summary.md` - Markdown summary
- `remembered.json` - Persistent memories
- `entities.json` - Entity index

**List files response:**
```json
{
  "files": [
    { "name": "summary.json", "size": 1234, "mtime": "2025-02-04T15:00:00Z" },
    { "name": "remembered.json", "size": 567, "mtime": "2025-02-04T14:30:00Z" }
  ]
}
```

## Sync Flow

### Pull (Session Start)

1. Check server health
2. Acquire lock (or fail gracefully if locked by another)
3. List server files with mtimes
4. Download files newer than local versions
5. Start heartbeat to keep lock alive

### Push (Session End)

1. Stop heartbeat
2. Upload files newer than server versions
3. Release lock

### Graceful Fallback

If the server is unreachable or the project is locked by another machine:
- Log a warning
- Continue with local memory only
- No data loss

## Running as a Service

### systemd (Linux)

Create `/etc/systemd/system/mneme-server.service`:

```ini
[Unit]
Description=Mneme Sync Server
After=network.target

[Service]
Type=simple
User=your-username
ExecStart=/usr/bin/node /path/to/server/mneme-server.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable mneme-server
sudo systemctl start mneme-server
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server/mneme-server.mjs .
EXPOSE 3847
CMD ["node", "mneme-server.mjs"]
```

```bash
docker run -d -p 3847:3847 -v ~/.mneme-server:/root/.mneme-server mneme-server
```

## Security Considerations

- **Network**: Only expose on trusted networks or use VPN/SSH tunnel
- **Auth**: Enable API keys for any non-localhost deployment
- **Firewall**: Restrict access to known IPs if possible
- **TLS**: Put behind a reverse proxy (nginx, caddy) for HTTPS

## Troubleshooting

### Server won't start

Check if port is already in use:
```bash
lsof -i :3847
```

### Lock stuck

Locks auto-expire after `lockTTLMinutes`. To force release:
```bash
rm ~/.mneme-server/projects/<project-name>/.lock.json
```

### Client can't connect

1. Verify server is running: `curl http://localhost:3847/health`
2. Check firewall rules
3. Verify API key if auth is enabled

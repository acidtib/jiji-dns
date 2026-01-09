# jiji-dns

A lightweight DNS server for [jiji](https://github.com/acidtib/jiji). Uses Corrosion subscriptions
for real time container updates and serves DNS queries for the `.jiji` domain.

## Features

- **Real time updates**: Subscribes to Corrosion's streaming API for instant DNS updates when
  containers are deployed or removed
- **In memory cache**: No file I/O for DNS lookups
- **Health aware**: Only returns healthy containers in DNS responses
- **Auto reconnect**: Automatically reconnects to Corrosion on connection loss
- **Multi instance support**: Supports instance specific DNS names for multi server deployments

## DNS Resolution

jiji-dns resolves service names in the following format:

| Pattern                               | Example                 | Description                                        |
| ------------------------------------- | ----------------------- | -------------------------------------------------- |
| `{project}-{service}.jiji`            | `casa-api.jiji`         | Resolves to all healthy containers for the service |
| `{project}-{service}-{instance}.jiji` | `casa-api-primary.jiji` | Resolves to a specific instance                    |

Non `.jiji` queries are forwarded to the system resolver (`/etc/resolv.conf`).

```
┌─────────────────────────────────────────────────────────────┐
│                      jiji-dns Server                        │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────────────────────┐ │
│  │ DNS Server      │    │ Corrosion Subscriber            │ │
│  │ (UDP port 53)   │    │                                 │ │
│  │                 │    │ - HTTP streaming connection     │ │
│  │ Query: *.jiji   │<───│ - NDJSON change events          │ │
│  │ → lookup cache  │    │ - Auto-reconnect on disconnect  │ │
│  │                 │    │                                 │ │
│  │ Query: other    │    └─────────────────────────────────┘ │
│  │ → forward to    │                   │                    │
│  │   /etc/resolv   │                   v                    │
│  └─────────────────┘    ┌─────────────────────────────────┐ │
│           │             │ In-Memory DNS Cache             │ │
│           │             │                                 │ │
│           └────────────>│ Map<hostname, DnsRecord[]>      │ │
│                         │ - casa-api.jiji → [10.210.1.5]  │ │
│                         │ - casa-db.jiji → [10.210.2.3]   │ │
│                         └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Installation

### Build from source

```bash
# Clone the repository
git clone https://github.com/acidtib/jiji-dns.git
cd jiji-dns

# Build for current platform
deno task build

# Build for Linux x64
deno task build:linux-x64

# Build for Linux arm64
deno task build:linux-arm64
```

The compiled binary will be in `build/jiji-dns`.

### Deploy with Jiji

jiji-dns is automatically installed when you run `jiji network init`. The binary is placed at
`/opt/jiji/dns/jiji-dns` and managed by systemd.

## Configuration

jiji-dns is configured via environment variables:

| Variable             | Required | Default                 | Description                                  |
| -------------------- | -------- | ----------------------- | -------------------------------------------- |
| `LISTEN_ADDR`        | Yes      | -                       | Address to listen on (e.g., `10.210.1.1:53`) |
| `SERVICE_DOMAIN`     | No       | `jiji`                  | Domain suffix for service discovery          |
| `CORROSION_API`      | No       | `http://127.0.0.1:9220` | Corrosion API endpoint                       |
| `DNS_TTL`            | No       | `60`                    | TTL for DNS responses in seconds             |
| `RECONNECT_INTERVAL` | No       | `5000`                  | Reconnect interval in milliseconds           |

## Usage

### Run directly

```bash
LISTEN_ADDR=10.210.1.1:53 ./jiji-dns
```

### Systemd service

When deployed via Jiji, the service runs as `jiji-dns.service`:

```bash
# Check status
systemctl status jiji-dns

# View logs
journalctl -u jiji-dns -f

# Restart
systemctl restart jiji-dns
```

### Example output

```
     _ _ _ _         _
    (_|_|_|_)   __  | |_ __  ___
    | | | | |  / _` | | '_ \/ __|
    | | | | | | (_| | | | | \__ \
   _/ |_|_|_|  \__,_|_|_| |_|___/
  |__/

Configuration:
  Listen address: 10.210.1.1:53
  Service domain: jiji
  Corrosion API:  http://127.0.0.1:9220
  TTL:            60s

Starting Corrosion subscriber...
Starting DNS server...
[READY] Initial sync complete: 5 records, 3 hostnames
[UPSERT] casa-api -> 10.210.1.5 (container: abc123def456)
[DELETE] casa-web (container: xyz789abc123)
```

## Development

```bash
# Run tests
deno task test

# Run all checks (format, lint, test)
deno task check

# Run in development mode with watch
deno task dev

# Format code
deno task fmt

# Lint code
deno task lint
```

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Start Commands

```bash
# Run with watch mode (development)
deno task dev

# Run tests
deno task test

# Run all checks (format, lint, test)
deno task check

# Format code
deno task fmt

# Lint code
deno task lint

# Build compiled binary (outputs to build/jiji-dns)
deno task build

# Build for Linux x64
deno task build:linux-x64

# Build for Linux arm64
deno task build:linux-arm64
```

## Required Environment Variable

The `LISTEN_ADDR` environment variable is required to run:

```bash
LISTEN_ADDR=10.210.1.1:53 deno task run
```

## Architecture Overview

jiji-dns is a lightweight DNS server that provides service discovery for [jiji](https://github.com/acidtib/jiji) deployments. It subscribes to Corrosion's real-time streaming API and maintains an in-memory DNS cache.

### Component Flow

```
Corrosion DB ─HTTP Stream─► CorrosionSubscriber ─► DnsCache ◄── DnsServer ◄── UDP Queries
                           (NDJSON events)        (in-memory)   (port 53)
```

### Key Components

**`src/corrosion_subscriber.ts`** - Maintains HTTP streaming connection to Corrosion's `/v1/subscriptions` endpoint. Parses NDJSON messages and emits events:
- `onUpsert(record)` - Container added or health status changed
- `onDelete(containerId)` - Container removed
- `onReady()` - Initial sync complete
- Auto-reconnects with exponential backoff on connection loss

**`src/dns_cache.ts`** - In-memory cache indexed by hostname and container ID.
- Generates hostnames: `{project}-{service}` and `{project}-{service}-{instanceId}`
- Newest-container-wins logic per service/server combination
- Only healthy containers returned in DNS lookups

**`src/dns_server.ts`** - UDP DNS server implementing RFC 1035.
- Routes `*.{serviceDomain}` queries to cache
- Forwards other queries to system resolvers from `/etc/resolv.conf`
- Falls back to 8.8.8.8 and 1.1.1.1 if no resolvers found

**`src/dns_protocol.ts`** - DNS packet parsing and building.
- `parseDnsQuery()` - Parses UDP packets, extracts domain and query type
- `buildDnsResponse()` - Constructs A record responses
- Handles label compression (RFC 1035)

**`src/types.ts`** - All TypeScript interfaces and the `parseConfig()` function for environment variable parsing.

### DNS Resolution Patterns

| Pattern | Example | Description |
|---------|---------|-------------|
| `{project}-{service}.{domain}` | `casa-api.jiji` | All healthy containers for service |
| `{project}-{service}-{instance}.{domain}` | `casa-api-primary.jiji` | Specific instance |

### Corrosion Subscription Protocol

The subscription query joins `containers` and `services` tables, filtering for healthy containers:

```sql
SELECT c.id, c.service, c.server_id, c.ip, c.health_status, c.started_at, c.instance_id, s.project
FROM containers c
JOIN services s ON c.service = s.name
WHERE c.health_status = 'healthy'
```

Messages are NDJSON with these types:
- `{"columns": [...]}` - Column names (first message)
- `{"row": [index, [values...]]}` - Initial data rows
- `{"change": {"Insert"|"Update"|"Delete": {...}}}` - Real-time updates
- `{"eoq": {...}}` - End of initial query

## Relationship to jiji

jiji-dns is a standalone service that reads from the Corrosion database that jiji manages. It runs at the host level (not containerized) to avoid circular dependencies with DNS resolution.

- **jiji** writes container registrations to Corrosion
- **jiji-dns** subscribes to changes and serves DNS queries
- Deployed via `jiji network init` to `/opt/jiji/dns/jiji-dns`
- Managed by systemd as `jiji-dns.service`

# ChordV

A private workspace for a small collection of connected applications. It brings together a native client, a management interface, application services, and shared tooling.

The project is maintained for personal use. Interfaces and workflows may change as the system evolves.

## Workspace

| Path | Purpose |
| --- | --- |
| `apps/desktop` | Native client and platform integrations |
| `apps/admin` | Management interface |
| `apps/api` | Application services and persistence |
| `apps/agent` | Lightweight background service |
| `apps/node-agent` | Earlier service implementation, retained for compatibility |
| `packages/shared` | Shared types and utilities |

The workspace uses TypeScript, React, Tauri, Rust, and Go. Application data is stored in PostgreSQL. JavaScript packages are managed with pnpm and Turborepo.

## Local development

Use Node.js with pnpm 9.15.3. The release baseline is recorded in [`.nvmrc`](.nvmrc). Native client development also requires Rust and the relevant platform SDKs: Xcode Command Line Tools on macOS, or MSVC C++ Build Tools and WebView2 on Windows.

Install workspace dependencies from the repository root:

```bash
pnpm install --frozen-lockfile
```

Start the local management interface and API:

```bash
bash ./start.sh
```

Open `http://127.0.0.1:5174`. The interface forwards API requests to the local service, which uses port `3000` by default. An optional argument changes the interface port:

```bash
bash ./start.sh 5180
```

The launcher uses the active Node.js installation and prepares local dependencies as needed. Without an explicit database connection, it expects a local development database; Windows Git Bash can prepare a project-local PostgreSQL instance. Other systems require an available PostgreSQL installation. The managed local database may be initialized or migrated during startup.

To preview the native client against the local API, run this in a separate terminal:

```bash
VITE_API_BASE_URL=http://127.0.0.1:3000 bash ./start-app.sh
```

This builds and opens a native debug application. Run it in a macOS terminal or Windows Git Bash with native Windows tools. Use `bash ./start-app.sh --check` to check prerequisites, or `--build-only` to build without opening a window.

For client development with hot reload:

```bash
VITE_API_BASE_URL=http://127.0.0.1:3000 pnpm dev:mac
```

For a browser-only view:

```bash
VITE_API_BASE_URL=http://127.0.0.1:3000 pnpm dev:desktop
```

## Configuration

Keep environment-specific settings in local configuration or the deployment environment. Service addresses, credentials, signing material, and operational data should remain outside tracked documentation.

`DATABASE_URL` selects the database. `CHORDV_API_PORT` and `CHORDV_ADMIN_PORT` select the local service and interface ports. `VITE_API_BASE_URL` selects the client's API endpoint; the native preview also respects an explicit `CHORDV_API_BASE_URL` override. Set the intended endpoint explicitly when switching environments.

## Checks and builds

Run the workspace checks or build from the repository root:

```bash
pnpm check
pnpm build
```

The workspace build compiles application code. Native packaging uses separate platform tooling. macOS and Windows are the primary desktop targets; Android has a separate build path. Platform coverage varies by component.

Client versions are recorded in [`apps/desktop/config/platform-versions.json`](apps/desktop/config/platform-versions.json). The service release version is recorded separately in [`SYSTEM_VERSION`](SYSTEM_VERSION).

## Access

This repository and its associated materials are intended for private use. Access to the source does not grant permission to redistribute it.

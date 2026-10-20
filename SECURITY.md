# Security

Fluxlink runs entirely on your machine. It does not modify Fluxer’s installation and
ships no telemetry, credentials, or default Broadcast Box host.

## Local attack surface

- The launcher starts Fluxer with `--remote-debugging-port`, bound to localhost. Any
  local process that can reach that port can control the Fluxer renderer.
- The plugin store API binds to `127.0.0.1` and can write plugin code that runs with
  full page access inside Fluxer.
- Do not run the loader or expose either port on a shared or untrusted machine.
- Change the ports with `--port` / `--api-port` or `FLUXER_DEBUG_PORT` /
  `FLUXER_BB_API_PORT`.

## Reporting

Do not open a public issue for a vulnerability that could let another process or
website control Fluxer, steal a stream key, or execute plugin code. Use GitHub’s
**private security advisory** feature on the repository instead.

Never paste stream keys, Fluxer tokens, private Broadcast Box URLs, or personal
information into an issue. Redact them from logs and screenshots first.

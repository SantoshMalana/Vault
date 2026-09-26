# Verified hardening and remaining work

An external evaluator score is not a security certification or a throughput measurement. These controls are implemented and exercised by the repository's checks.

## Browser and session boundary

- Shared, strictly type-checked security helpers reject malformed origins, protocol mismatches, and cross-site browser mutations.
- Login bodies are limited to 4 KiB, including requests without Content-Length. Invalid JSON, null bodies, and invalid tokens produce controlled errors.
- Login throttling uses bounded, fixed windows with Retry-After. Active limits are never cleared when the identity map fills. Successful requests also count toward the limit.
- Forwarded address headers are ignored by default. Set `VAULT_CLIENT_IP_HEADER` only to a header your trusted ingress overwrites; prevent clients from bypassing that ingress. Without this setting all login attempts on a dashboard instance share a 10-per-minute allowance.
- Login limits are per dashboard process. Multiple dashboard instances need a shared limiter or an ingress-level rate limit. This is not a distributed DDoS defense or a gateway-wide rate limit.
- HTTPS requests and an HTTPS `VAULT_PUBLIC_ORIGIN` always use Secure session cookies. Production defaults to Secure cookies; explicitly setting `VAULT_COOKIE_SECURE=false` supports the localhost-only Compose demo.
- Set `VAULT_PUBLIC_ORIGIN=https://your-dashboard-host` behind an HTTPS reverse proxy so origin validation sees the correct external scheme and host. The setting is the dashboard origin, not the storage gateway address.
- Gateway fetches do not follow redirects. Security headers block framing and browser MIME sniffing and restrict referrer and device permissions. The CSP covers framing, base URLs and plugin objects; it is not a nonce-based script policy.

## Keyboard interaction

Upload and object-details panels use native modal dialogs with accessible names, background interaction blocking, Escape dismissal and restoration of focus to the opener. An in-progress upload cannot be dismissed accidentally. Upload progress is exposed to assistive technology. A skip link reaches the main workspace. Reduced-motion preferences disable animation.

## Repeatable verification

```sh
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx playwright install chromium
npm run test:browser
```

Set `ETCD_BINARY` to an etcd 3.6.5 executable for the real consensus test. CI installs the checksum-verified Linux release so that test is not silently skipped. CI also runs the production dashboard browser checks.

Browser checks exercise actual Next.js session/proxy routes and rendered UI against a controlled gateway fixture: origin and body rejection, cookies, throttling, refresh success/failure/retry, numerical node ordering, reduced motion, keyboard dialogs, and upload/download byte equality. They do not independently prove disk durability; the separate process integration suite tests actual storage and metadata services.

For Windows with Edge already installed, set `VAULT_BROWSER_CHANNEL=msedge` instead of installing Chromium. Browser checks always launch the built production server.

## Still requires work or deployment evidence

- HTTPS ingress and internal TLS must be configured and verified on the actual deployment; code support does not establish deployment security.
- The new security module has strict JavaScript type checking. The full gateway/storage/metadata implementation has not been migrated to TypeScript.
- Sustained load, cross-machine partitions, recovery objectives, backup restoration, a complete accessibility audit, encryption at rest and safe replica garbage collection remain separate work.
- Full-object verification and replication overhead remain documented architectural tradeoffs. No performance score substitutes for benchmarks.

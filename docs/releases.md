# Releases

The three images built from this repo are published to GHCR when `main` is
merged into `prod`:

| Image | Built from | Used by |
|---|---|---|
| `ghcr.io/ju-li/automata-mcp-web` | `apps/web/Dockerfile` | `docker-compose.yml`, Railway |
| `ghcr.io/ju-li/automata-mcp-telegram-bridge` | `apps/telegram-bridge/Dockerfile` | `docker-compose.yml`, Railway |
| `ghcr.io/ju-li/automata-mcp-aio` | `docker/aio/Dockerfile` | [single container](self-hosting.md#single-container) |

The all-in-one image builds the web app and the bridge from the same commit as
the other two, on top of Evolution's pinned image, so one version names the same
code in all three.

The hosted-only cloud service (`apps/cloud/Dockerfile`) is neither published nor
built by these workflows, so the release check does not catch a broken cloud
Dockerfile; the hosted deployment builds it from source (see
[Plans and billing](billing.md)).

Every image is `linux/amd64`. A release reaches its tags in two steps:

| Tags | Moved by | When |
|---|---|---|
| `X.Y.Z`, `beta`, `sha-<commit>` | `release.yml` | on merge into `prod`; the GitHub Release is a **prerelease** |
| `X.Y`, `X`, `latest` | `promote.yml` | run by hand after testing; marks the GitHub Release latest |

So `:1`, which every install pins, gets a release only after it has been tested
as `:beta` (or `:X.Y.Z`). **Point a service or a template at the major tag
(`:1`), not `:latest`.** The web service migrates its schema at boot and
migrations only go forward, so a major release reaching a deployment on its next
restart is not something to opt into by accident. For the same reason a
deployment that ran a beta cannot simply go back to the previous image: test a
beta on a deployment whose database you can restore, or that you are willing to
fix forward.

The version is `"version"` in the root `package.json`, always three-part. Three
directory listings repeat it — `server.json` (official MCP Registry),
`lhm.plugin.json` (LobeHub Marketplace) and `.cursor-plugin/plugin.json`
(cursor.directory) — so set all four with one command rather than by hand. To cut a release:

1. On `main`, through an ordinary PR, run `pnpm release:version X.Y.Z` and
   commit the four files it changes.
2. Open a PR from `main` into `prod`. The `release-check` workflow refuses it
   unless the version is `X.Y.Z`, is not already released, is above the latest
   release, and matches in all four files, and unless `lhm.plugin.json` lists
   exactly the tools in `apps/web/server/mcp/tools/`. It also builds all three
   images to prove they still build.
3. Merge it with **Create a merge commit** — never squash, or `prod` stops being
   an ancestor of `main` and every later release PR shows old commits again.
   The `release` workflow then pushes all three images as `X.Y.Z` and `beta`,
   and only after that creates the `vX.Y.Z` git tag and a GitHub prerelease, so
   a tag always means its images exist.
4. Test the beta: deploy `:X.Y.Z` (or `:beta`) somewhere first — the hosted
   deployment is the usual place — and watch it.
5. Promote it: run the `promote` workflow from the Actions tab, or

   ```bash
   gh workflow run promote.yml -f version=X.Y.Z
   ```

   It refuses a version with no GitHub Release or one below the version already
   promoted (migrations only go forward), then points `X.Y`, `X` and `latest` at
   the `X.Y.Z` images — a retag, not a rebuild, so the digest is the one tested
   — marks the GitHub Release latest, and last publishes `server.json` to the
   official MCP Registry. If only that last step fails, the promotion stands and
   re-running the workflow for the same version is safe.

   Two releases can wait as betas; `beta` follows the newest, and promoting
   the newer one alone is fine. Promoting the older one first, then the newer,
   works too.
6. Once the promoted web image is deployed, update the LobeHub listing by hand (its
   CLI logs in through a browser, so no workflow can):

   ```bash
   npx -y @lobehub/market-cli plugin update --dir "$PWD"
   ```

   Run `npx -y @lobehub/market-cli login` first if it says the session expired.

## Directory listings

| Directory | File | Published by |
|---|---|---|
| [Official MCP Registry](https://registry.modelcontextprotocol.io) (`app.getautomata/automata`) | `server.json` | `promote.yml`, every promotion |
| [LobeHub Marketplace](https://lobehub.com/mcp) (`ju-li-automata-mcp`) | `lhm.plugin.json` | by hand, step 6 above |
| [Docker MCP Catalog](https://hub.docker.com/mcp) | `servers/automata/` in `docker/mcp-registry` | a PR there; carries no version |
| [cursor.directory](https://cursor.directory) | `mcp.json`, `.cursor-plugin/plugin.json` | read from this repository; version set by `release:version` |

**When a tool is added, renamed or removed,** the release check fails until
`lhm.plugin.json` lists it. Deploy first, then regenerate from the live server
card (the JSON Schemas exist only at runtime) and commit the result:

```bash
pnpm listings:tools https://mcp.getautomata.app/.well-known/mcp/server-card.json
```

The Docker catalog's `tools.json` is a separate snapshot in that repository and
needs a follow-up PR there; nothing checks it.

One-time setup on GitHub, which no workflow can do for you:

- Add the repository secret `MCP_REGISTRY_DNS_KEY`: the hex Ed25519 private
  key whose public key is in the `v=MCPv1; k=ed25519; p=…` TXT record on the
  apex of `getautomata.app`. Derive it from the `key.pem` used to create that
  record:

  ```bash
  openssl pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n'
  ```

  Keep the TXT record in place for as long as releases publish; removing it
  makes the `mcp-registry` job fail. Rotating the key means a new TXT record and
  a new secret together.

- Create the `prod` branch from `main`, and protect it: require a pull request
  and the `release-check` checks: `version` and the three `build (…)` matrix
  checks, one per image — GitHub names each matrix leg separately, so a bare
  `build` never matches.
- After the first release, open each package under the repository's
  **Packages** and set its visibility to **Public**. GHCR creates packages
  private, and Railway — or anyone deploying a template or running the
  all-in-one image — cannot pull a private image without credentials.
  `automata-mcp-aio` appears only after the first release that includes it, and
  needs the same step then.

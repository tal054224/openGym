# CI-built homelab images

Every push to `homelab` runs the frontend, API and MCP tests, then publishes all four
images to GitHub Container Registry (GHCR), linked to this GitHub repository:

- `ghcr.io/tal054224/opengym-api`
- `ghcr.io/tal054224/opengym-web`
- `ghcr.io/tal054224/opengym-mcp`
- `ghcr.io/tal054224/opengym-caddy`

Images support `linux/amd64` and `linux/arm64`. Each build uses the full commit SHA
as its tag; no `latest` tag is published by the homelab workflow. Build caches speed
up subsequent runs. Publishing uses GitHub Actions' built-in `GITHUB_TOKEN`; no
extra CI secret is needed. The workflow never connects to or deploys on your server.

## Get a tested build

Open the repository's **Actions > homelab** page and select a successful run.
Download its `homelab-images-<commit SHA>` artifact and extract `.env.images` into
your deployment directory. The same four digest-pinned references appear in the run
summary. Wait for the entire image job to succeed so all services use one tested commit.

With GitHub CLI on the server, downloading the artifact is also possible:

```sh
gh run download <successful-run-id> --repo tal054224/openGym \
  --name homelab-images-<full-commit-sha> --dir .
```

The server needs Docker Compose 2.24 or newer for the `!reset` override. Keep your
existing `.env`, data, secrets, certificates, media and Caddy configuration files.
It only needs the two Compose files and those deployment files, not source code or Node.

## Pull and update

Run these commands on your server, from the deployment directory:

```sh
docker compose --env-file .env --env-file .env.images \
  -f docker-compose.homelab.yml -f docker-compose.homelab.images.yml pull

docker compose --env-file .env --env-file .env.images \
  -f docker-compose.homelab.yml -f docker-compose.homelab.images.yml \
  up -d --no-build
```

The override removes every local build directive, including both Caddy services.
Data volumes and existing network/security settings are unchanged. Back up your data
before updating. To select an older build, restore that successful run's `.env.images`
and run the same commands; application data migrations may still require a backup restore.

## Registry access

New GHCR packages may be private. For anonymous pulls, change each package's visibility
to **Public** in GitHub's package settings, only if that is appropriate for your fork.
Otherwise authenticate Docker on the server to `ghcr.io` with a GitHub token that has
`read:packages`, using `docker login ghcr.io --username YOUR_GITHUB_USER`. Enter the
token directly at Docker's password prompt; never put it in Git or `.env.images`.

GitHub Actions artifact access requires repository access even when images are public.
The public run summary's digest references can also be used to prepare `.env.images`.
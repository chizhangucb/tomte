# The heartbeat's host, as an image (#327): Node, `gh` and this repo, whose
# command is one pass of the sender. Render's blueprint (`render.yaml` at the
# root) builds it and runs it on a schedule; any other provider that runs a
# container on a schedule runs this same image, and one that runs no container
# runs the same command with the same token, checkout and check, which is all
# README's "what any host needs" asks of a host.
#
# Nothing builds this in CI -- a container build is minutes of a runner to
# prove a deploy nobody is waiting on -- so the build proves what it can about
# itself as it goes, and `factory/heartbeat/recipe.test.ts` holds it to that.
FROM node:22-bookworm-slim

# `gh` is what every read and every wake goes through, and it is the one thing
# an official Node image does not already carry. From the release tarball
# rather than an apt repository: one version, pinned here and moved by hand,
# and no third-party source left in the image for a later build to pick a
# different version out of. The archive is checked against the checksums file
# of the same release before anything in it is run, so a build that fetched
# something else fails here rather than running it against every target.
# `ca-certificates` is `gh`'s own need, for the HTTPS it makes every call over.
ARG GH_VERSION=2.63.2
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    arch="$(dpkg --print-architecture)"; \
    cd /tmp; \
    curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt"; \
    sha256sum --ignore-missing --check "gh_${GH_VERSION}_checksums.txt"; \
    tar -xzf "gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    install "gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf "gh_${GH_VERSION}_linux_${arch}.tar.gz" "gh_${GH_VERSION}_checksums.txt" "gh_${GH_VERSION}_linux_${arch}"

# The one thing this build can tell a maintainer for free. A `gh` that did not
# install, or one built for another architecture, fails the build here instead
# of on the first pass against the first real target.
RUN gh --version

WORKDIR /tomte

# The repo as merged, which is the only state of it a host may sweep from. No
# install step: the sender runs on bare `node --experimental-strip-types` with
# nothing from `package.json`, which `send.test.ts` pins, so the image holds no
# dependency tree to go stale between deploys.
COPY . /tomte

# The command, which is the one interface every host crosses. In exec form, so
# the cron job's signals reach the sender rather than a shell, and with no
# token in the image: `GH_TOKEN` and `FACTORY_HEARTBEAT_PING_URL` come from the
# host's environment, which on Render is the `tomte-heartbeat` environment
# group the blueprint names.
CMD ["node", "--experimental-strip-types", "factory/heartbeat/send.ts"]

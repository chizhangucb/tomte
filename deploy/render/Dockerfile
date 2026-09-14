# The heartbeat's host, as an image (#327): Node, `gh` and this repo, whose
# command is one pass of the sender. Render's blueprint (`render.yaml` at the
# root) builds it and runs it on a schedule; any other provider that runs a
# container on a schedule runs the same image, and a provider that runs no
# container runs the same command against the same four things, which README's
# "what any host needs" lists.
#
# Nothing builds this in CI -- a container build is minutes of a runner to
# prove a deploy nobody is waiting on -- so the build proves what it can about
# itself as it goes, and `factory/heartbeat/render.test.ts` holds it to that.
FROM node:22-bookworm-slim

# `gh` is what every read and every wake goes through, and it is the one thing
# an official Node image does not already carry. From the release tarball
# rather than an apt repository: one pinned version, one signature-checked
# archive, and no third-party source left in the image for a later build to
# pick a different version out of. `ca-certificates` is `gh`'s own need, for
# the HTTPS it makes every call over.
ARG GH_VERSION=2.63.2
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    arch="$(dpkg --print-architecture)"; \
    curl -fsSL -o /tmp/gh.tar.gz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz"; \
    tar -xzf /tmp/gh.tar.gz -C /tmp; \
    install "/tmp/gh_${GH_VERSION}_linux_${arch}/bin/gh" /usr/local/bin/gh; \
    rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_${arch}"

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

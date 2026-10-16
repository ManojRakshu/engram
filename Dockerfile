# Engram demo: FalkorDB + Engram dashboard in one container.
# The graph snapshot (deploy/dump.rdb) is baked in, so the demo is complete on cold start.
FROM node:24-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npx tsc -p . && npm prune --omit=dev
# Source of the demo repo, so context packs can inline function bodies.
ARG CLICK_SHA=2247b35ea1c47c727d7a06e51fa280e12a863ff6
ARG NX_SHA=6da4704cbf32ba6f50f6d9c46cc0a071e3a87985
RUN for r in "click https://github.com/pallets/click.git $CLICK_SHA" "networkx https://github.com/networkx/networkx.git $NX_SHA"; do \
      set -- $r; mkdir -p /targets/$1 && cd /targets/$1 && git init -q && git remote add origin $2 && \
      git fetch -q --depth 1 origin $3 && git checkout -q FETCH_HEAD && rm -rf .git; \
    done

FROM falkordb/falkordb:v4.22.1
ENV BROWSER=0 NODE_ENV=production FALKORDB_URL=falkor://localhost:6379 \
    ENGRAM_REPOS="pallets-click=/targets/click,networkx-networkx=/targets/networkx,bench-pallets-click-cc-cold=/targets/click,bench-pallets-click-cc-warm=/targets/click,bench-networkx-networkx-cc-cold=/targets/networkx,bench-networkx-networkx-cc-warm=/targets/networkx"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /targets /targets
COPY package.json ./
COPY web ./web
COPY bench/results ./bench/results
COPY deploy/dump.rdb /var/lib/falkordb/data/dump.rdb
COPY deploy/start.sh /start.sh
EXPOSE 8787
ENTRYPOINT ["/bin/sh", "/start.sh"]

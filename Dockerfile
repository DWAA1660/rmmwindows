FROM mcr.microsoft.com/dotnet/sdk:10.0 AS agent-build
WORKDIR /build/agent
COPY agent/LibraryRmm.Agent.csproj ./
RUN dotnet restore --runtime win-x64
COPY agent/ ./
RUN dotnet publish --configuration Release --runtime win-x64 --self-contained true --no-restore -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true --output /publish

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS companion-build
WORKDIR /build/companion
COPY companion/ ./
COPY agent/SupportProtocol.cs agent/SupportSelfTests.cs /build/agent/
RUN dotnet publish LibraryRmm.Support.csproj --configuration Release --runtime win-x64 --self-contained true -p:EnableWindowsTargeting=true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true --output /publish

FROM node:24-bookworm-slim AS agent-package
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*
COPY --from=agent-build /publish /package/agent
COPY --from=companion-build /publish /package/agent/companion
COPY installer/Install-Agent.ps1 installer/Uninstall-Agent.ps1 installer/README.md /package/
COPY installer/package-agent.mjs /build/package-agent.mjs
COPY agent/LibraryRmm.Agent.csproj /build/agent.csproj
RUN node /build/package-agent.mjs /package /output /build/agent.csproj

FROM node:24-bookworm-slim AS web-build
WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ARG APP_VERSION=development
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 APP_VERSION=$APP_VERSION
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server/ ./
COPY --chown=node:node installer/Bootstrap-Agent.ps1 /app/installer/Bootstrap-Agent.ps1
RUN npm test
COPY --from=web-build --chown=node:node /build/web/dist /app/web/dist
COPY --from=agent-package --chown=node:node /output /app/downloads
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/index.mjs"]

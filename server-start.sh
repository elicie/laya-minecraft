#!/usr/bin/env bash
set -euo pipefail
cd /home/elicie/Dev/minecraft
if [[ "${ACCEPT_MINECRAFT_EULA:-}" != "true" ]]; then
  echo 'Minecraft EULA agreement required: https://www.minecraft.net/eula'
  echo 'After agreeing: ACCEPT_MINECRAFT_EULA=true ./server-start.sh'
  exit 1
fi
mkdir -p server-data
if docker container inspect minecraft-laya-server >/dev/null 2>&1; then
  docker start minecraft-laya-server
  exit 0
fi
docker run -d --name minecraft-laya-server --restart unless-stopped \
  -p 127.0.0.1:25565:25565 -p 100.82.139.118:25565:25565 \
  -v "$PWD/server-data:/data" \
  -e EULA=TRUE -e VERSION=1.21.1 -e TYPE=VANILLA -e MEMORY="${MC_MEMORY:-4G}" \
  -e ONLINE_MODE=FALSE -e ENFORCE_SECURE_PROFILE=FALSE \
  -e DIFFICULTY=normal -e MODE=survival -e VIEW_DISTANCE=8 \
  -e MAX_PLAYERS="${MC_MAX_PLAYERS:-16}" -e SIMULATION_DISTANCE=6 \
  -e SPAWN_PROTECTION=0 -e MOTD='Laya Minecraft Lab' \
  itzg/minecraft-server:java21

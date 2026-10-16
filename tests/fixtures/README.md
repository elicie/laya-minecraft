`protocol-767-recipes.bin.gz` contains the uncompressed payload of the vanilla
1.21.1 `declare_recipes` packet (without its packet ID), gzip compressed for
storage. It was captured on 2026-10-09 by a read-only `LayaProtoProbe` connection
to the disposable `minecraft-laya-validation` server at `127.0.0.1:25566`.
No administrative commands or world mutations were used for this capture.

The payload is 108,270 bytes and contains 1,290 vanilla recipes. It reproduces
the incorrect serializer ID table shipped in `minecraft-data` 3.117.0. The
compatibility regression test requires the public corrected decoder to consume
every byte, preserve all recipes, and decode every vanilla recipe serializer.

Sources:

- [Prismarine packet schema](https://github.com/PrismarineJS/minecraft-data/blob/master/data/pc/1.21.1/proto.yml)
- [Public customPackets API](https://github.com/PrismarineJS/node-minecraft-protocol/blob/master/docs/API.md)
- [Vanilla 1.21.1 RecipeSerializer source](https://github.com/extremeheat/extracted_minecraft_data/blob/client1.21.1/client/net/minecraft/world/item/crafting/RecipeSerializer.java)

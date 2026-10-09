# Project scope

- Keep Mineflayer and other third-party libraries unchanged. Do not edit their
  files, install dependency source patches, or monkey-patch their runtime methods.
- Implement behavior, planning, state handling and compatibility in this
  project's own code using the libraries' public APIs.
- The user's objective is to strengthen our bot code and Laya. Treat Mineflayer
  as the existing Minecraft interface.
- Keep source-code improvements distinct from model training. Saving gameplay
  logs or corrections does not automatically train Laya; report what was actually
  trained and evaluated.
- Never run administrative test fixtures against the user's survival world.
  Use the disposable `minecraft-laya-validation` server on port 25566.

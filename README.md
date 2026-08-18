<br>

<div align = center>

# Unreal CommandHelper

Unreal Engine project launcher and toolbox for Windows. Launch projects, run common workflows, and schedule batch jobs.

[![Badge Website]][Website]   

<br>


<!---------------------------------------------------------------------------->

[Website]: https://donate.stripe.com/aFadR2gGB5dd8FYc3K5wI00


<!---------------------------------[ Badges ]---------------------------------->

[Badge Website]: https://img.shields.io/badge/Buy_me_a_Cofee-8A2BE2?style=for-the-badge

</div>



## Features

| Feature | Description |
|---------|-------------|
| [**Launcher**](docs/LAUNCHER.md) | Browse installed Unreal Engine versions, manage projects (`.uproject`), run pinned jobs |
| [**ToolBox**](docs/TOOLBOX.md) | Shader Booster, Regenerate Project, Batch Commit, UMap Helper, Plugin Helper, UProject Helper, Movie Render Queue |
| [**Scheduler**](docs/SCHEDULER.md) | Create named batch jobs (sequences of tools) and run them in order |
| [**Links**](docs/LINKS.md) | Quick links and resources |

## Installation

1. Go to the [Releases](https://github.com/Ciji-Games/Unreal_CommandHelper/releases) page
2. Download the latest `.msi` installer (or `-setup.exe` if available)
3. Run the installer

## Screenshots

| Launcher | Shader Booster |
|----------|----------------|
| ![Launcher](public/assets/launcher.png) | ![Shader Booster](public/assets/shaderbooster.png) |
| Batch Job | Map Helper |
| ![Batch Job](public/assets/batchJob.png) | ![Map Helper](public/assets/MapHelper.png) |

## Requirements

- **Windows 11** (64-bit)

No other prerequisites. The app runs standalone on Windows 11 (WebView2 is pre-installed).

> [!NOTE]
> **Optional** (for specific features):
> - **Unreal Engine** — Launcher, Regenerate, Cook, Package, Build Lighting, UMap, Plugin build
> - **Git** — Batch Commit
> - **Git LFS** — Batch Commit (large files)

## Build from Source

**Prerequisites**: Node.js (LTS), Rust, npm

```bash
git clone https://github.com/Ciji-Games/Unreal_CommandHelper.git
cd Unreal_CommandHelper
npm install
npm run tauri build
```

Build output: `Build/release/bundle/msi/` (or `target/release/bundle/` depending on `CARGO_TARGET_DIR`).

## In-app updates

The Windows application checks GitHub Releases when it starts and can download and install a signed update through the Tauri updater. If updater metadata or signing is unavailable, the existing release-page action remains available as a manual fallback.

### Release signing setup

Maintainers must create a Tauri updater key pair outside this repository:

```powershell
npx tauri signer generate -w "$env:USERPROFILE\.tauri\ue-launcher.key"
```

The private key is encoded text, so a value ending in `==` is normal Base64 padding. Do not remove it or otherwise edit the key. `TAURI_SIGNING_PRIVATE_KEY` must contain the complete contents of the private-key file, including all encoded key data, but not shell quotes, a variable name, or a `-----BEGIN`/`-----END` label. Keep the private key out of source control.

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be exactly the password entered during key generation. Preserve capitalization and symbols, but do not copy accidental leading/trailing spaces, newlines, or quotation marks. The public key in `src-tauri/tauri.conf.json`, the private-key file, and this password are one signing pair; values from different generations will not work together.

Before changing GitHub secrets, test the same pair locally. This PowerShell example reads the key file and prompts for the password without printing either value:

```powershell
$keyPath = "$env:USERPROFILE\.tauri\ue-launcher.key"
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw $keyPath
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = Read-Host "Signing password"

npx tauri build --bundles nsis

Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY
Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

A matching key and password pass the signing stage and produce a signed NSIS setup executable. `Wrong password for that key` confirms that the password is wrong for that private key, or that the key contents were copied incorrectly. Do not print either environment variable or add diagnostic output to the release workflow.

Compare the generated `.pub` file with the `pubkey` value in `src-tauri/tauri.conf.json`; they must be the public key from the same generation. If the original password cannot be recovered, generate a new pair, replace the configured `pubkey`, and replace both GitHub secrets together. Existing installations may need one manual update from the release page after changing the public key because they still trust the old key.

After local validation, add or replace these repository secrets under **Settings → Secrets and variables → Actions**:

- `TAURI_SIGNING_PRIVATE_KEY` — the complete private key file contents
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password used when generating the key

The release workflow publishes `latest.json`, a signed NSIS `-setup.exe`, and the MSI installer under the existing `app-vX.Y.Z` release tag. The first release after enabling updates must be published only after the public key and both GitHub secrets are configured.

## License

Polyform Noncommercial 1.0.0 — use allowed for non-commercial purposes only. See [LICENSE](LICENSE) for details.
> [!NOTE]
> This license apply to the launcher, not whatever Unreal Engine project you launch with it. I do not allow the commercial use of the launcher app.

## Disclaimer

> [!NOTE]
> This app was **vibe coded**: it was thoroughly tested but the point is to improve my quality of life as an Unreal Engine developer, not to create an absolute state-of-the-art commercial application.
>
> - This app **doesn't modify anything** on your computer, so it's safe to use.
> - We recommend using proper **version control** when launching the various tools available to prevent any issues.

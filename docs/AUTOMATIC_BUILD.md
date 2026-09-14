# Automatic Build

The Automatic Build tab automates GitHub repository synchronization, Unreal Engine project packaging (`BuildCookRun`), zip archiving, and build retention cleanup.

![Automatic Build](../public/assets/AutoBuild.png)

## 1. Linking Your GitHub Account

1. In the **Automatic Build** tab, click **Connect GitHub**.
2. A device code is generated. Click **Copy Code** and **Open GitHub Verification** (or navigate to [github.com/login/device](https://github.com/login/device)).
3. Paste the code into GitHub and click **Continue** to authorize.
4. Once authorized, the app connects automatically and securely stores credentials.

## 2. Troubleshooting Missing Repositories

If a desired personal or organization repository is not listed in the profile repository dropdown:

1. Click the **Configure GitHub App** gear icon next to your connected account (or visit the [UE Launcher Login App](https://github.com/apps/ue-launcheur-login)).
2. Under **Repository access**, select the account/organization and choose **All repositories** or grant access to the specific repository.
3. Save changes in GitHub. The repository list refreshes automatically.

## 3. Pipeline Stages & Requirements

Each build profile runs through a sequential pipeline. Ensure the prerequisites for each stage are met:

| Stage | Name | Requirements |
|:---:|------|--------------|
| **1** | **Clone** | • GitHub account connected<br>• Target local directory specified<br>• GitHub repository and build branch selected |
| **2** | **Repo Sync** | • Repository cloned to local path<br>• Local checkout aligned to target branch<br>• Clean working directory & index (no uncommitted changes)<br>• Unreal `.gitignore` rules in place (`Binaries/`, `DerivedDataCache/`, `Intermediate/`)<br>• **Git LFS** installed in `PATH` (if repository uses LFS) |
| **3** | **Package** | • Unreal Editor / IDE closed (no running `UnrealEditor.exe` locking files)<br>• Valid `.uproject` file located in checkout<br>• Matching Unreal Engine version installed and detected (or assigned in profile)<br>• Target platform and build configuration selected |
| **4** | **Zip** | • *(Optional)* Enabled via schedule settings<br>• Successful packaging stage output |
| **5** | **Cleanup** | • *(Optional)* Enabled via retention settings<br>• Retains the configured number of recent builds and deletes older artifacts |

## 4. Scheduling & Automation

Click **Schedule Settings** in the top bar to:
- Set automatic polling intervals (e.g., every 15, 30, or 60 minutes).
- Enable automated packaging on detected remote commits.
- Configure zip archiving and maximum retained build count.

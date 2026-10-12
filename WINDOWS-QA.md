# Current Soul Next Windows test candidate

This is a local source snapshot for native Windows testing. It has not been uploaded or tested on Windows. Source SHA and file hashes are in WINDOWS-SOURCE-MANIFEST.json. Runtime profiles and credentials are excluded. The current app source is copied unchanged; only the CI workflow is restricted to Windows.

Prerequisites: native Windows x64, Node.js 24, Git and native build tools required by npm dependencies. Extract into a disposable test folder. The existing native gate creates separate installation and profile folders, runs its own NSIS uninstall and retains its test data.

If testing outside GitHub Actions, initialize a local Git repository first so the resource manifest can be built:

```powershell
git init
git add .
git -c user.name=SoulQA -c user.email=soul-qa@localhost commit -m "test(desktop-next): snapshot current preview for Windows QA"
cd desktop-next
npm ci
npm run typecheck
npm run dist:win
npm run verify:experts
npm run verify:resources
npm run verify:tasks
npm run verify:workflows
npm run verify:integrations
npm run verify:updates
npm run verify:win
npm run verify:upgrade
```

On GitHub Actions the existing workflow runs the same checks on Windows Server 2022. This remains distinct from normal-user Windows 10/11 interactive install, endpoint security/trust and real IM account testing. The current workflow and package scripts remain reviewable before dispatch.

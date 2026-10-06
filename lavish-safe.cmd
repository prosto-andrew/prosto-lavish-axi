@echo off
setlocal
rem lavish-safe.cmd - launcher for the locally hardened lavish-axi build (Windows).
rem Capabilities are removed in this tree's SOURCE; this launcher makes sure the
rem thing that runs is that tree and not a freshly downloaded upstream package.

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "ENTRY=%ROOT%\dist\cli.mjs"

if not exist "%ROOT%\package.json" (
  echo lavish-safe: not a lavish-axi checkout: %ROOT% 1>&2
  exit /b 1
)
findstr /C:"\"version\": \"0.1.82\"" "%ROOT%\package.json" >nul || (
  echo lavish-safe: this checkout is not version 0.1.82 - it was never audited. 1>&2
  exit /b 1
)
if not exist "%ENTRY%" (
  echo lavish-safe: dist\cli.mjs is missing - run "npx --yes pnpm@11.1.1 install --frozen-lockfile" in %ROOT% once to build it. 1>&2
  exit /b 1
)

findstr /C:"LAVISH-HARDENED" "%ENTRY%" >nul || (
  echo lavish-safe: dist\cli.mjs has no hardening markers - rebuilt from unpatched sources. 1>&2
  exit /b 1
)
for %%H in (a.kunchenguid.com api.ht-ml.app cdn.jsdelivr.net) do (
  findstr /C:"%%H" "%ENTRY%" >nul && (
    echo lavish-safe: dist\cli.mjs still references %%H - hardening not in this build. Refusing to run. 1>&2
    exit /b 1
  )
)

rem Defence in depth: the source ignores these, but keep the environment hostile too.
set "LAVISH_AXI_TELEMETRY=0"
set "LAVISH_AXI_HOST=127.0.0.1"
set "LAVISH_AXI_UMAMI_WEBSITE_ID="
set "LAVISH_AXI_UMAMI_HOST="
set "LAVISH_AXI_HTML_APP_TOKEN="

node "%ENTRY%" %*
exit /b %ERRORLEVEL%

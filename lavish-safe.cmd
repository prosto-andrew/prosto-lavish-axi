@echo off
setlocal
rem lavish-safe.cmd - launcher for the locally hardened lavish-axi build (Windows).
rem Capabilities are removed in this tree's SOURCE; this launcher makes sure the
rem thing that runs is that tree. Before every start it runs verify-hardening.mjs -
rem the same checks you run by hand - and refuses to start when any of them fails.
rem
rem No %ROOT% inside a parenthesized block: a ")" in the path, as in
rem "Program Files (x86)", would close the block early.

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

if not exist "%ROOT%\verify-hardening.mjs" goto not_checkout

rem The verifier's report goes to stderr: stdout carries only the CLI's response.
node "%ROOT%\verify-hardening.mjs" --quiet 1>&2
if errorlevel 1 goto refuse

rem Defence in depth: the source ignores these, but keep the environment hostile too.
set "LAVISH_AXI_TELEMETRY=0"
set "LAVISH_AXI_HOST=127.0.0.1"
set "LAVISH_AXI_UMAMI_WEBSITE_ID="
set "LAVISH_AXI_UMAMI_HOST="
set "LAVISH_AXI_HTML_APP_TOKEN="

node "%ROOT%\dist\cli.mjs" %*
exit /b %ERRORLEVEL%

:not_checkout
>&2 echo lavish-safe: not a hardened lavish-axi checkout: "%ROOT%"
exit /b 1

:refuse
>&2 echo lavish-safe: refusing to start: the checks above failed. In "%ROOT%" run "npx --yes pnpm@11.1.1 install --frozen-lockfile", then "node verify-hardening.mjs".
exit /b 1

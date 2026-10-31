# Установка hardened lavish на Windows (приложение Claude Code)

Ставится **hardened-сборка** lavish-axi 0.1.93 из вашего форка —
копия, из исходников которой удалены телеметрия, публикация на сторонний хост, привязка
к Tailscale/LAN, установка постоянных хуков и загрузка ассетов с CDN. Стоковый пакет из
npm ставить нельзя ни при каких условиях.

Требуется **Node.js 22 или новее** и git. Проверить: `node -v`, `git --version`.
Если ноды нет — поставить LTS с nodejs.org и открыть терминал заново. Отдельно ставить
pnpm не нужно: шаг 2 запускает ровно ту версию, что записана в `package.json`, через `npx`.

Все команды ниже — для PowerShell.

---

## Шаг 1. Клонировать форк

Папку выбираете сами — инструкция нигде не предполагает конкретный путь. Задайте её один
раз в переменной (пример ниже — только пример):

```powershell
$LavishDir = "$env:USERPROFILE\lavish-hardened"   # любой путь, где вам удобно

git clone https://github.com/prosto-andrew/prosto-lavish-axi.git $LavishDir
cd $LavishDir
```

Надёжнее путь без пробелов и кириллицы: если имя пользователя Windows кириллическое,
возьмите что-нибудь вроде `D:\tools\lavish`. Отдельные инструменты сборки Node до сих
пор спотыкаются о такие пути.

Все следующие команды выполняются **из этой папки**.

Убедиться, что клонировалось то самое — в шапке `README.md` должен быть блок
«Hardened fork»:

```powershell
Get-Content README.md -TotalCount 3
git log --oneline -1
```

## Шаг 2. Собрать

```powershell
npx --yes pnpm@11.1.1 install --frozen-lockfile
```

Одна команда: ставит зависимости строго по закоммиченному `pnpm-lock.yaml` и затем сама
запускает сборку (скрипт `prepare`). Около минуты, ~380 пакетов. Папки `node_modules\` и
`dist\` в git не хранятся и создаются здесь же.

Почему pnpm, а не `npm install`:

- **одинаковые зависимости на всех машинах.** `--frozen-lockfile` ставит ровно то дерево,
  которое записано в lock-файле и прогнано в CI. Если lock-файл не совпадает с
  `package.json`, установка падает, а не подбирает версии заново;
- **защиты из `pnpm-workspace.yaml` действуют только в pnpm:** версии моложе 7 дней не
  ставятся, понижение доверия к публикации запрещено, install-скрипты разрешены только
  esbuild. `npm install` всего этого не знает.

`npm install` не используйте: без lock-файла он каждый раз подбирает версии заново по
диапазонам `^`, поэтому на двух машинах деревья расходятся. Верификатор, а с ним и
лаунчер, отказываются работать с деревом, которое ставил или переписывал npm (его выдают
`package-lock.json` или `node_modules\.package-lock.json`). Если так вышло — удалите
`node_modules`, `dist` и `package-lock.json` и повторите команду pnpm выше.

## Шаг 3. Проверить, что сборка действительно hardened

```powershell
node verify-hardening.mjs
```

Ожидается:

```
All 31 checks passed. This build is hardened.
```

Проверки читают и исходники, и собранные `dist\cli.mjs` / `dist\server.mjs`: что телеметрия
отключена без возможности включения, что публикация удалена, что сервер только на loopback
(без `--also-listen` и без поиска по сетевым интерфейсам), что не запускаются внешние
программы вроде `herdr`, и что в бандле нет ни одного внешнего адреса (`a.kunchenguid.com`,
`api.ht-ml.app`, `cdn.jsdelivr.net`). А ещё — что `dist` свежее всех исходников, что
`node_modules` поставлен через pnpm, что сервер запускается из той же сборки `dist`, что и CLI,
и что страница ревью ничего не загружает с других адресов.

**Если хоть одна проверка упала — дальше не идти.** Сообщение скажет, что именно не так.

## Шаг 4. Установить скилл

Из папки форка:

```powershell
mkdir "$env:USERPROFILE\.claude\skills\lavish" -Force
Copy-Item skills\lavish\SKILL.md "$env:USERPROFILE\.claude\skills\lavish\SKILL.md" -Force
```

Итог: `%USERPROFILE%\.claude\skills\lavish\SKILL.md`

## Шаг 5. Положить лаунчер в PATH

В PATH добавляется **сама папка форка**, а не копии файлов: оба лаунчера резолвят пути
относительно себя. `lavish-safe.cmd` — для cmd и PowerShell, `lavish-safe` — для Git Bash.
Перед каждым запуском лаунчер прогоняет `node verify-hardening.mjs --quiet` (около 0,3 с)
и отказывается работать, если хоть одна проверка не прошла — например, после `git pull`
без пересборки. Сообщение назовёт команду, которая это исправит.
Из папки форка:

```powershell
$dir = (Get-Location).Path
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
$raw = $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
if (($raw -split ";") -notcontains $dir) {
  $new = if ([string]::IsNullOrEmpty($raw)) { $dir } else { $raw.TrimEnd(";") + ";" + $dir }
  $key.SetValue("Path", $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
}
$key.Close()
# Удаление несуществующей переменной ничего не меняет, но сообщает Windows,
# что переменные среды изменились (WM_SETTINGCHANGE)
[Environment]::SetEnvironmentVariable("LAVISH_PATH_REFRESH", $null, "User")
```

Команда читает и пишет значение `Path` в реестре как есть: ссылки вида `%USERPROFILE%`
остаются ссылками, а тип значения — `REG_EXPAND_SZ`. Повторный запуск не добавит папку
второй раз. Привычная пара `GetEnvironmentVariable` / `SetEnvironmentVariable` для этого
не годится: первая раскрывает ссылки, вторая записывает результат с типом `REG_SZ`.

Закрыть все терминалы и перезапустить Claude Desktop: приложение со старым `PATH` не
найдёт `lavish-safe`. В новом терминале проверить:

```powershell
lavish-safe --version    # => 0.1.93
```

Если вы позже перенесёте папку форка, уберите старый путь из пользовательской переменной
`Path` (Параметры → «Изменение переменных среды для вашей учётной записи») и повторите
этот шаг из нового места.

## Шаг 6. Убрать стоковый скилл

Самый вероятный источник проблем: старый SKILL.md прямым текстом велит агенту выполнить
`npx -y lavish-axi` — то есть скачать нехардненный пакет. Шаг 4 перезаписывает файл по
тому же пути, но проверьте остальные скиллы и плагины:

```powershell
$plugins = "$env:USERPROFILE\.claude\plugins"
$roots = @("$env:USERPROFILE\.claude\skills", $plugins)
# Маркетплейсы из локальной папки: Claude Code читает их плагины прямо оттуда
$known = "$plugins\known_marketplaces.json"
if (Test-Path -LiteralPath $known) {
  $json = Get-Content -LiteralPath $known -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach ($s in $json.PSObject.Properties.Value.source) {
    if ($s.source -eq "directory") { $roots += $s.path }
    elseif ($s.source -eq "file") {
      $dir = [IO.Path]::GetDirectoryName($s.path)
      if ([IO.Path]::GetFileName($dir) -eq ".claude-plugin") { $roots += [IO.Path]::GetDirectoryName($dir) }
    }
  }
}
# Папки-ссылки (junction, симлинк) — отдельными корнями: -Recurse в них не заходит
$roots += Get-ChildItem -LiteralPath $roots -Recurse -Directory -Attributes ReparsePoint `
  -ErrorAction SilentlyContinue | ForEach-Object FullName
Get-ChildItem -LiteralPath $roots -Recurse -File -ErrorAction SilentlyContinue |
  Select-String -SimpleMatch "npx -y lavish-axi" -List |
  Where-Object { -not (Select-String -LiteralPath $_.Path -SimpleMatch "lavish-safe" -Quiet) } |
  Select-Object Path
```

Команда должна вывести **пусто**. Если что-то нашлось — удалите или отключите этот
скилл/плагин. Установленный на шаге 4 hardened-скилл тоже содержит эту строку — в
запрете, — поэтому файлы, где упомянут `lavish-safe`, команда пропускает.

Кроме `skills` и `plugins` команда проверяет маркетплейсы, добавленные из локальной папки
(`/plugin marketplace add <папка>` или путь к `marketplace.json` в её `.claude-plugin`):
плагины из такого маркетплейса Claude Code читает прямо из этой папки, а не из копии в
`plugins`. Список таких папок команда берёт из `plugins\known_marketplaces.json`.

Windows PowerShell 5.1 с `-Recurse` не заходит в папки-ссылки, поэтому команда сначала
находит их и проверяет каждую как отдельную папку. В рекомендуемом режиме так ставит
скиллы `npx skills add`: в `skills` появляется junction на папку в
`%USERPROFILE%\.agents\skills`. Ссылку внутри папки, в которую уже ведёт ссылка, команда
не проверяет.

## Шаг 7. Запретить npx на уровне агента

В `%USERPROFILE%\.claude\settings.json`. Если файл уже есть — дописать строки в
существующий массив `deny`, не перезаписывая его целиком. Правила этого шага из прежней
версии инструкции (с `:*` на конце) замените новыми.

```json
{
  "permissions": {
    "deny": [
      "Bash(npx lavish-axi*)",
      "Bash(npx -y lavish-axi*)",
      "Bash(npx --yes lavish-axi*)",
      "Bash(lavish-axi*)",
      "Bash(npm install -g lavish-axi*)",
      "PowerShell(npx lavish-axi*)",
      "PowerShell(npx -y lavish-axi*)",
      "PowerShell(npx --yes lavish-axi*)",
      "PowerShell(lavish-axi*)",
      "PowerShell(npm install -g lavish-axi*)"
    ]
  }
}
```

Перед `*` нет пробела намеренно: правило `Bash(npx -y lavish-axi *)` — и равное ему
`Bash(npx -y lavish-axi:*)` — требует пробел после имени пакета и пропускает
`npx -y lavish-axi@latest`.

Правила `PowerShell(...)` нужны, потому что на Windows у Claude Code два инструмента для
команд, а правило `Bash(...)` действует только на Bash. Если установлен Git Bash, одни
Bash-правила молча выключают инструмент PowerShell на всю сессию; если Git Bash нет,
PowerShell — единственная оболочка, и Bash-правила его не касаются. С обоими наборами
запрет действует в обоих инструментах, а PowerShell остаётся доступен.

Это политика, а не песочница: она отсекает очевидные вызовы, но главная защита — правило
в SKILL.md и то, что сам локальный бинарник обезврежен.

## Шаг 8. Проверить в бою

Попросите Claude Code показать что-нибудь визуальное — например «покажи план работ
артефактом». Агент должен вызвать `lavish-safe`, а не `npx`. Ручная проверка запретов:

```powershell
lavish-safe share test.html    # => `share` is removed in this hardened build...
lavish-safe setup hooks        # => `setup` is removed in this hardened build...
```

---

## Обслуживание

- **Обновление форка** — из папки форка:

  ```powershell
  git pull
  npx --yes pnpm@11.1.1 install --frozen-lockfile
  node verify-hardening.mjs
  if ($LASTEXITCODE -eq 0) {
    Copy-Item skills\lavish\SKILL.md "$env:USERPROFILE\.claude\skills\lavish\SKILL.md" -Force
  }
  ```

  Последняя команда обновляет скилл из шага 4: без неё агент так и работает по скиллу
  прежней версии. Скилл копируется, только если проверка прошла, — PowerShell не
  останавливает вставленный блок на упавшей команде, поэтому условие записано явно.

  Между `git pull` и пересборкой `lavish-safe` откажется запускаться — это намеренно: иначе
  работала бы прежняя сборка, хотя в папке уже новый код.

- **Не запускайте `npm update`, `pnpm update`, `npm audit fix`** (тем более `--force`).
  Они меняют версии зависимостей в обход lock-файла, и сборка перестаёт быть той, что
  проверена. Зависимости форка обновляются только коммитом нового `pnpm-lock.yaml`.
- **Предупреждения при установке.**
  - `npm audit` / `pnpm audit` сообщают об уязвимости низкой важности в `katex` — его
    подтягивает `mermaid` (KaTeX рисует формулы в подписях диаграмм). Исправление есть
    только в несовместимой ветке katex, а `npm audit fix --force` предлагает откатить
    mermaid до 10.8.0 — это ломает whiteboard. Риск принят осознанно: уязвимость
    срабатывает лишь вместе с уже существующим prototype pollution на странице.
- Переход на новую версию lavish-axi = слияние оригинала в форк и новый аудит
  (`node verify-hardening.mjs`), см. `hardening/SETUP.md`.
- Держать что-либо запущенным не нужно: сервер гасится сам через 30 минут простоя и после
  закрытия последней сессии.

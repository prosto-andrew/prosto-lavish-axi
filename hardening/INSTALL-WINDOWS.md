# Установка hardened lavish на Windows (приложение Claude Code)

Ставится **hardened-сборка** lavish-axi 0.1.82 из вашего форка —
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

`npm install` тоже соберёт рабочую сборку, но без lock-файла он каждый раз подбирает
версии заново по диапазонам `^`, поэтому на двух машинах деревья могут разойтись. Если
всё же пришлось так поставить — появившийся `package-lock.json` не коммитьте (он
игнорируется git намеренно, у форка один lock-файл — `pnpm-lock.yaml`).

## Шаг 3. Проверить, что сборка действительно hardened

```powershell
node verify-hardening.mjs
```

Ожидается:

```
All 23 checks passed. This build is hardened.
```

Проверки читают и исходники, и собранные `dist\cli.mjs` / `dist\server.mjs`: что телеметрия
отключена без возможности включения, что публикация удалена, что сервер только на loopback
(без `--also-listen` и без поиска по сетевым интерфейсам), что не запускаются внешние
программы вроде `herdr`, и что в бандле нет ни одного внешнего адреса (`a.kunchenguid.com`,
`api.ht-ml.app`, `cdn.jsdelivr.net`).

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
Из папки форка:

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";" + (Get-Location).Path,
  "User"
)
```

Закрыть терминал, открыть заново, проверить:

```powershell
lavish-safe --version    # => 0.1.82
```

Если вы позже перенесёте папку форка, уберите старый путь из пользовательской переменной
`Path` (Параметры → «Изменение переменных среды для вашей учётной записи») и повторите
этот шаг из нового места.

## Шаг 6. Убрать стоковый скилл

Самый вероятный источник проблем: старый SKILL.md прямым текстом велит агенту выполнить
`npx -y lavish-axi` — то есть скачать нехардненный пакет. Шаг 4 перезаписывает файл по
тому же пути, но проверьте остальные скиллы и плагины:

```powershell
Get-ChildItem "$env:USERPROFILE\.claude\skills", "$env:USERPROFILE\.claude\plugins" `
  -Recurse -File -ErrorAction SilentlyContinue |
  Select-String -SimpleMatch "npx -y lavish-axi" -List | Select-Object Path
```

Команда должна вывести **пусто**. Если что-то нашлось — удалите или отключите этот
скилл/плагин.

## Шаг 7. Запретить npx на уровне агента

В `%USERPROFILE%\.claude\settings.json`. Если файл уже есть — дописать строки в
существующий массив `deny`, не перезаписывая его целиком.

```json
{
  "permissions": {
    "deny": [
      "Bash(npx lavish-axi:*)",
      "Bash(npx -y lavish-axi:*)",
      "Bash(npx --yes lavish-axi:*)",
      "Bash(lavish-axi:*)",
      "Bash(npm install -g lavish-axi:*)"
    ]
  }
}
```

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
  ```

- **Не запускайте `npm update`, `pnpm update`, `npm audit fix`** (тем более `--force`).
  Они меняют версии зависимостей в обход lock-файла, и сборка перестаёт быть той, что
  проверена. Зависимости форка обновляются только коммитом нового `pnpm-lock.yaml`.
- **Предупреждения при установке.**
  - `npm audit` / `pnpm audit` сообщают об уязвимости низкой важности в `katex` — его
    подтягивает `mermaid` (KaTeX рисует формулы в подписях диаграмм). Исправление есть
    только в несовместимой ветке katex, а `npm audit fix --force` предлагает откатить
    mermaid до 10.8.0 — это ломает whiteboard. Риск принят осознанно: уязвимость
    срабатывает лишь вместе с уже существующим prototype pollution на странице.
  - Если ставили через `npm install`, он может написать, что пропустил postinstall-скрипт
    esbuild. Это безвредно: бинарник esbuild приходит отдельным платформенным пакетом,
    сборка проходит. pnpm этот скрипт запускает (он разрешён в `pnpm-workspace.yaml`).
- Переход на новую версию lavish-axi = слияние оригинала в форк и новый аудит
  (`node verify-hardening.mjs`), см. `hardening/SETUP.md`.
- Держать что-либо запущенным не нужно: сервер гасится сам через 30 минут простоя и после
  закрытия последней сессии.

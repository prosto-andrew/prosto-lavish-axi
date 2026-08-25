# Установка hardened lavish на Windows (приложение Claude Code)

Ставится **hardened-сборка** lavish-axi 0.1.62 из вашего форка —
копия, из исходников которой удалены телеметрия, публикация на сторонний хост, привязка
к Tailscale/LAN, установка постоянных хуков и загрузка ассетов с CDN. Стоковый пакет из
npm ставить нельзя ни при каких условиях.

Требуется **Node.js 22 или новее** и git. Проверить: `node -v`, `git --version`.
Если ноды нет — поставить LTS с nodejs.org и открыть терминал заново.

---

## Шаг 1. Клонировать форк

В путь без пробелов и кириллицы:

```powershell
git clone https://github.com/prosto-andrew/prosto-lavish-axi.git C:\lavish-hardened
cd C:\lavish-hardened
```

Убедиться, что клонировалось то самое — в шапке `README.md` должен быть блок
«Hardened fork»:

```powershell
Get-Content README.md -TotalCount 3
git log --oneline -1
```

## Шаг 2. Собрать

Одна команда: скрипт `prepare` внутри пакета сам запускает esbuild.

```powershell
npm install
```

Около минуты, ~400 пакетов, ~260 МБ. Папки `node_modules\` и `dist\` в git не хранятся
и создаются здесь же.

## Шаг 3. Проверить, что сборка действительно hardened

```powershell
node verify-hardening.mjs
```

Ожидается:

```
All 10 checks passed. This build is hardened.
```

Десять проверок читают и исходники, и собранный `dist\cli.mjs`: что телеметрия отключена
без возможности включения, что публикация удалена, что сервер только на loopback, и что в
бандле нет ни одного внешнего адреса (`a.kunchenguid.com`, `api.ht-ml.app`,
`cdn.jsdelivr.net`).

**Если хоть одна проверка упала — дальше не идти.** Сообщение скажет, что именно не так.

## Шаг 4. Положить лаунчер в PATH

В PATH добавляется **сама папка**, а не копии файлов: оба лаунчера резолвят пути
относительно себя. `lavish-safe.cmd` — для cmd и PowerShell, `lavish-safe` — для Git Bash.

```powershell
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\lavish-hardened",
  "User"
)
```

Закрыть терминал, открыть заново, проверить:

```powershell
lavish-safe --version    # => 0.1.62
```

## Шаг 5. Установить скилл

```powershell
mkdir "$env:USERPROFILE\.claude\skills\lavish" -Force
Copy-Item "C:\lavish-hardened\skills\lavish\SKILL.md" `
          "$env:USERPROFILE\.claude\skills\lavish\SKILL.md" -Force
```

Итог: `C:\Users\<вы>\.claude\skills\lavish\SKILL.md`

## Шаг 6. Убрать стоковый скилл

Самый вероятный источник проблем: старый SKILL.md прямым текстом велит агенту выполнить
`npx -y lavish-axi` — то есть скачать нехардненный пакет. Шаг 5 перезаписывает файл по
тому же пути, но проверьте плагины.

```powershell
dir "$env:USERPROFILE\.claude\skills"
dir "$env:USERPROFILE\.claude\plugins" -ErrorAction SilentlyContinue
```

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

- **Не запускайте `npm update`.** Он поднимет версии, и сборка перестанет быть той, что вы
  проверили. Лаунчер это заметит и откажется стартовать.
- После любого `npm install` или `git pull` прогоняйте `node verify-hardening.mjs` заново.
- Чтобы обе машины получили ровно одинаковые зависимости — закоммитьте в форк
  `package-lock.json`, который создастся после первой установки (репозиторий идёт с
  `pnpm-lock.yaml`, а мы ставим через npm, поэтому без своего lock-файла версии
  подбираются заново по диапазонам `^`).
- Переход на новую версию lavish-axi = новый аудит. Скрипт `hardening/harden_lavish.py`
  намеренно откажется работать с любой версией кроме 0.1.62.
- Держать что-либо запущенным не нужно: сервер гасится сам через 30 минут простоя и после
  закрытия последней сессии.

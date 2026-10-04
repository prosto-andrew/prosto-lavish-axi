# Установка hardened lavish в WSL

Ставится **hardened-сборка** lavish-axi 0.1.82 из вашего форка —
копия, из исходников которой удалены телеметрия, публикация на сторонний хост, привязка
к Tailscale/LAN, установка постоянных хуков и загрузка ассетов с CDN. Стоковый пакет из
npm ставить нельзя ни при каких условиях.

Требуется **Node.js 22+ внутри WSL** — именно линуксовый, а не Windows-овый через
`/mnt/c`. Проверить:

```bash
node -v          # v22.x или новее
which node       # /usr/bin/node или ~/.nvm/... — НЕ /mnt/c/...
```

Если ноды нет:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Шаг 1. Клонировать форк

**В `~`, а не в `/mnt/c` или `/mnt/d`.** На примонтированных дисках Windows
`npm install` работает в разы медленнее и спотыкается о права и симлинки.

```bash
git clone https://github.com/prosto-andrew/prosto-lavish-axi.git ~/lavish-hardened
cd ~/lavish-hardened
```

Убедиться, что клонировалось то самое — в шапке `README.md` должен быть блок
«Hardened fork»:

```bash
head -3 README.md
git log --oneline -1
```

## Шаг 2. Собрать

Одна команда: скрипт `prepare` внутри пакета сам запускает esbuild.

```bash
npm install
```

Около минуты, ~400 пакетов, ~260 МБ. Папки `node_modules/` и `dist/` в git не хранятся
и создаются здесь же.

## Шаг 3. Проверить, что сборка действительно hardened

```bash
node verify-hardening.mjs
```

Ожидается:

```
All 22 checks passed. This build is hardened.
```

Проверки читают и исходники, и собранные `dist/cli.mjs` / `dist/server.mjs`: что телеметрия
отключена без возможности включения, что публикация удалена, что сервер только на loopback
(без `--also-listen` и без поиска по сетевым интерфейсам), что не запускаются внешние
программы вроде `herdr`, и что в бандле нет ни одного внешнего адреса (`a.kunchenguid.com`,
`api.ht-ml.app`, `cdn.jsdelivr.net`).

**Если хоть одна проверка упала — дальше не идти.** Сообщение скажет, что именно не так.

## Шаг 4. Положить лаунчер в PATH

Лаунчер резолвит собственный реальный путь, поэтому корректно работает через симлинк.

```bash
chmod +x ~/lavish-hardened/lavish-safe
mkdir -p ~/.local/bin
ln -sf ~/lavish-hardened/lavish-safe ~/.local/bin/lavish-safe

# если ~/.local/bin ещё не в PATH:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

lavish-safe --version    # => 0.1.82
```

## Шаг 5. Установить скилл

```bash
mkdir -p ~/.claude/skills/lavish
cp ~/lavish-hardened/skills/lavish/SKILL.md ~/.claude/skills/lavish/SKILL.md
```

## Шаг 6. Убрать стоковый скилл

Самый вероятный источник проблем: старый SKILL.md прямым текстом велит агенту выполнить
`npx -y lavish-axi` — то есть скачать нехардненный пакет.

```bash
grep -rl "npx -y lavish-axi" ~/.claude/ 2>/dev/null
```

Команда должна вывести **пусто**. Если что-то нашлось — удалите или отключите этот
скилл/плагин.

## Шаг 7. Запретить npx на уровне агента

В `~/.claude/settings.json`. Если файл уже есть — дописать строки в существующий массив
`deny`, не перезаписывая его целиком.

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

Попросите Claude Code показать что-нибудь визуальное. Агент должен вызвать `lavish-safe`,
а не `npx`. Ручная проверка запретов:

```bash
lavish-safe share test.html    # => `share` is removed in this hardened build...
lavish-safe setup hooks        # => `setup` is removed in this hardened build...
```

Сессия открывается на `http://127.0.0.1:4387/...`. Из WSL это обычно само открывается в
Windows-браузере; если нет — скопируйте URL вручную, WSL2 пробрасывает localhost.

---

## Обслуживание

- **Не запускайте `npm update`.** Он поднимет версии, и сборка перестанет быть той, что вы
  проверили. Лаунчер это заметит и откажется стартовать.
- После любого `npm install` или `git pull` прогоняйте `node verify-hardening.mjs` заново.
- Чтобы обе машины получили ровно одинаковые зависимости — закоммитьте в форк
  `package-lock.json`, который создастся после первой установки (репозиторий идёт с
  `pnpm-lock.yaml`, а мы ставим через npm, поэтому без своего lock-файла версии
  подбираются заново по диапазонам `^`).
- Переход на новую версию lavish-axi = слияние оригинала в форк и новый аудит
  (`node verify-hardening.mjs`), см. `hardening/SETUP.md`. Скрипт `hardening/harden_lavish.py`
  исторический: он патчит только 0.1.62 и с другими версиями работать откажется.
- Держать что-либо запущенным не нужно: сервер гасится сам через 30 минут простоя и после
  закрытия последней сессии.

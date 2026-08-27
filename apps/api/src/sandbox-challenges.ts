import {
  checkerContract,
  linuxCoreRuntime,
  type ChallengeCheckerContract,
} from './checker-contract.js';

export type SandboxDifficulty = 'Easy' | 'Medium' | 'Hard';

export interface SandboxChallenge {
  id: string;
  title: string;
  description: string;
  category: string;
  difficulty: SandboxDifficulty;
  hint: string;
  successMessage: string;
  setupScript: string;
  checkScript: string;
  /** Trusted declarative Runtime Contract V1. Legacy challenges fall back to checkScript. */
  runtime?: ChallengeCheckerContract['runtime'];
  checks?: ChallengeCheckerContract['checks'];
  /** Executed only by integrity tests; never sent to the browser. */
  referenceSolution: string;
}

type SandboxChallengeDefinition = Omit<SandboxChallenge, 'referenceSolution'>;

export type PublicSandboxChallenge = Pick<
  SandboxChallenge,
  'id' | 'title' | 'description' | 'category' | 'difficulty' | 'hint'
>;

const baseChallengeDefinitions: readonly SandboxChallengeDefinition[] = [
  {
    id: 'build-castle',
    title: 'Постройте башню замка',
    description: 'Создайте вложенный каталог /workspace/castle/tower.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'mkdir -p /workspace/castle/tower',
    successMessage: 'Башня построена.',
    setupScript: 'mkdir -p /workspace',
    checkScript: '[ -d /workspace/castle/tower ]',
  },
  {
    id: 'name-robot',
    title: 'Дайте роботу имя',
    description: 'Запишите строку BEEP-42 в /workspace/robot.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: "echo 'BEEP-42' > /workspace/robot.txt",
    successMessage: 'Робот представился: BEEP-42.',
    setupScript: 'mkdir -p /workspace',
    checkScript: '[ "$(cat /workspace/robot.txt 2>/dev/null)" = "BEEP-42" ]',
  },
  {
    id: 'launch-rocket',
    title: 'Отправьте ракету на старт',
    description: 'Переместите /workspace/hangar/rocket.txt в /workspace/launchpad/.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'mv /workspace/hangar/rocket.txt /workspace/launchpad/',
    successMessage: 'Ракета на стартовой площадке.',
    setupScript: `mkdir -p /workspace/hangar /workspace/launchpad; printf 'ready\n' > /workspace/hangar/rocket.txt`,
    checkScript: '[ ! -e /workspace/hangar/rocket.txt ] && grep -qx ready /workspace/launchpad/rocket.txt',
  },
  {
    id: 'copy-map',
    title: 'Скопируйте карту путешественнику',
    description: 'Скопируйте /workspace/map.txt в /workspace/traveler/map.txt.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'mkdir -p /workspace/traveler && cp /workspace/map.txt /workspace/traveler/map.txt',
    successMessage: 'Карта лежит в рюкзаке путешественника.',
    setupScript: "printf 'north -> east\\n' > /workspace/map.txt",
    checkScript: '[ -f /workspace/traveler/map.txt ] && cmp -s /workspace/map.txt /workspace/traveler/map.txt',
  },
  {
    id: 'remove-crumbs',
    title: 'Уберите крошки',
    description: 'Удалите /workspace/crumbs.txt, не удаляя /workspace/cake.txt.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'rm /workspace/crumbs.txt',
    successMessage: 'Крошки убраны, торт цел.',
    setupScript: "printf 'mess\\n' > /workspace/crumbs.txt; printf 'cake\\n' > /workspace/cake.txt",
    checkScript: '[ ! -e /workspace/crumbs.txt ] && grep -qx cake /workspace/cake.txt',
  },
  {
    id: 'feed-dragon',
    title: 'Накормите дракона',
    description: 'Добавьте строку pizza в конец /workspace/dragon-menu.txt, сохранив строку apples.',
    category: 'Bash', difficulty: 'Easy',
    hint: "echo 'pizza' >> /workspace/dragon-menu.txt",
    successMessage: 'Дракон сыт и спокоен.',
    setupScript: "printf 'apples\\n' > /workspace/dragon-menu.txt",
    checkScript: 'diff -u <(printf "apples\\npizza\\n") /workspace/dragon-menu.txt',
  },
  {
    id: 'make-playlist',
    title: 'Соберите плейлист',
    description: 'Объедините /workspace/song-a.txt и song-b.txt в /workspace/playlist.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: 'cat /workspace/song-a.txt /workspace/song-b.txt > /workspace/playlist.txt',
    successMessage: 'Плейлист собран в правильном порядке.',
    setupScript: "printf 'lofi\\n' > /workspace/song-a.txt; printf 'synthwave\\n' > /workspace/song-b.txt",
    checkScript: 'diff -u <(printf "lofi\\nsynthwave\\n") /workspace/playlist.txt',
  },
  {
    id: 'count-stars',
    title: 'Посчитайте звёзды',
    description: 'Посчитайте строки в /workspace/stars.txt и сохраните число в /workspace/answer.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: 'wc -l < /workspace/stars.txt > /workspace/answer.txt',
    successMessage: 'Все пять звёзд посчитаны.',
    setupScript: "printf '%s\\n' Sirius Vega Sun Polaris Altair > /workspace/stars.txt",
    checkScript: '[ "$(tr -d "[:space:]" < /workspace/answer.txt 2>/dev/null)" = "5" ]',
  },
  {
    id: 'find-unicorn',
    title: 'Найдите единорога',
    description: 'Найдите строку с unicorn в /workspace/zoo.txt и запишите её в /workspace/found.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: 'grep unicorn /workspace/zoo.txt > /workspace/found.txt',
    successMessage: 'Единорог найден.',
    setupScript: "printf '%s\\n' penguin capybara unicorn otter > /workspace/zoo.txt",
    checkScript: '[ "$(cat /workspace/found.txt 2>/dev/null)" = "unicorn" ]',
  },
  {
    id: 'shout-message',
    title: 'Сделайте сообщение громким',
    description: 'Преобразуйте текст /workspace/whisper.txt в верхний регистр и сохраните в /workspace/shout.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: "tr 'a-z' 'A-Z' < /workspace/whisper.txt > /workspace/shout.txt",
    successMessage: 'Теперь сообщение слышно всем.',
    setupScript: "printf 'hello linux\\n' > /workspace/whisper.txt",
    checkScript: '[ "$(cat /workspace/shout.txt 2>/dev/null)" = "HELLO LINUX" ]',
  },
  {
    id: 'last-cookie',
    title: 'Заберите последнее печенье',
    description: 'Сохраните последнюю строку /workspace/cookies.txt в /workspace/last.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: 'tail -n 1 /workspace/cookies.txt > /workspace/last.txt',
    successMessage: 'Последнее печенье — chocolate.',
    setupScript: "printf '%s\\n' vanilla coconut chocolate > /workspace/cookies.txt",
    checkScript: '[ "$(cat /workspace/last.txt 2>/dev/null)" = "chocolate" ]',
  },
  {
    id: 'first-three-planets',
    title: 'Выберите первые три планеты',
    description: 'Сохраните первые три строки /workspace/planets.txt в /workspace/first.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: 'head -n 3 /workspace/planets.txt > /workspace/first.txt',
    successMessage: 'Первые три планеты выбраны.',
    setupScript: "printf '%s\\n' Mercury Venus Earth Mars Jupiter > /workspace/planets.txt",
    checkScript: 'diff -u <(printf "Mercury\\nVenus\\nEarth\\n") /workspace/first.txt',
  },
  {
    id: 'csv-names',
    title: 'Достаньте имена игроков',
    description: 'Из первого столбца /workspace/players.csv запишите имена в /workspace/names.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: "cut -d',' -f1 /workspace/players.csv > /workspace/names.txt",
    successMessage: 'Имена извлечены из таблицы.',
    setupScript: "printf '%s\\n' 'alex,120' 'sam,95' 'max,88' > /workspace/players.csv",
    checkScript: 'diff -u <(printf "alex\\nsam\\nmax\\n") /workspace/names.txt',
  },
  {
    id: 'unique-colors',
    title: 'Оставьте уникальные цвета',
    description: 'Отсортируйте цвета из /workspace/colors.txt без повторов в /workspace/unique.txt.',
    category: 'Bash', difficulty: 'Easy',
    hint: 'sort -u /workspace/colors.txt > /workspace/unique.txt',
    successMessage: 'Повторы исчезли.',
    setupScript: "printf '%s\\n' red blue red green blue > /workspace/colors.txt",
    checkScript: 'diff -u <(printf "blue\\ngreen\\nred\\n") /workspace/unique.txt',
  },
  {
    id: 'create-planets',
    title: 'Создайте три планеты',
    description: 'Создайте пустые файлы earth.txt, mars.txt и venus.txt в /workspace.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'touch /workspace/earth.txt /workspace/mars.txt /workspace/venus.txt',
    successMessage: 'Мини-солнечная система готова.',
    setupScript: 'mkdir -p /workspace',
    checkScript: '[ -f /workspace/earth.txt ] && [ ! -s /workspace/earth.txt ] && [ -f /workspace/mars.txt ] && [ ! -s /workspace/mars.txt ] && [ -f /workspace/venus.txt ] && [ ! -s /workspace/venus.txt ]',
  },
  {
    id: 'executable-spell',
    title: 'Оживите заклинание',
    description: 'Сделайте /workspace/spell.sh исполняемым для всех, установив права 755.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'chmod 755 /workspace/spell.sh',
    successMessage: 'Заклинание теперь можно запустить.',
    setupScript: "printf '#!/bin/sh\\necho magic\\n' > /workspace/spell.sh; chmod 644 /workspace/spell.sh",
    checkScript: '[ "$(stat -c %a /workspace/spell.sh)" = "755" ]',
  },
  {
    id: 'readonly-scroll',
    title: 'Защитите древний свиток',
    description: 'Установите для /workspace/scroll.txt права только на чтение для всех: 444.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'chmod 444 /workspace/scroll.txt',
    successMessage: 'Свиток защищён от случайной записи.',
    setupScript: "printf 'ancient wisdom\\n' > /workspace/scroll.txt; chmod 644 /workspace/scroll.txt",
    checkScript: '[ "$(stat -c %a /workspace/scroll.txt)" = "444" ]',
  },
  {
    id: 'portal-shortcut',
    title: 'Откройте короткий портал',
    description: 'Создайте символическую ссылку /workspace/portal на каталог /workspace/worlds/mars.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'ln -s /workspace/worlds/mars /workspace/portal',
    successMessage: 'Портал ведёт прямо на Марс.',
    setupScript: 'mkdir -p /workspace/worlds/mars',
    checkScript: '[ -L /workspace/portal ] && [ "$(readlink -f /workspace/portal)" = "/workspace/worlds/mars" ]',
  },
  {
    id: 'replace-moon',
    title: 'Замените Луну на Марс',
    description: 'В /workspace/sky.txt замените слово moon на mars и сохраните результат в том же файле.',
    category: 'Bash', difficulty: 'Easy',
    hint: "sed -i 's/moon/mars/' /workspace/sky.txt",
    successMessage: 'Теперь в небе Марс.',
    setupScript: "printf 'sun moon stars\\n' > /workspace/sky.txt",
    checkScript: '[ "$(cat /workspace/sky.txt)" = "sun mars stars" ]',
  },
  {
    id: 'backup-note',
    title: 'Сделайте запасную заметку',
    description: 'Создайте точную копию /workspace/note.txt с именем /workspace/note.txt.bak.',
    category: 'Linux', difficulty: 'Easy',
    hint: 'cp /workspace/note.txt /workspace/note.txt.bak',
    successMessage: 'Резервная заметка создана.',
    setupScript: "printf 'remember the command\\n' > /workspace/note.txt",
    checkScript: '[ -f /workspace/note.txt.bak ] && cmp -s /workspace/note.txt /workspace/note.txt.bak',
  },
  {
    id: 'hello-terminal',
    title: 'Поздоровайтесь с терминалом',
    description: 'Создайте файл /workspace/hello.txt со строкой «Привет, терминал!».',
    category: 'Linux',
    difficulty: 'Easy',
    hint: "Готовая команда: printf 'Привет, терминал!\\n' > /workspace/hello.txt",
    successMessage: 'Терминал получил приветствие. Отличное начало!',
    setupScript: 'mkdir -p /workspace',
    checkScript: '[ "$(cat /workspace/hello.txt 2>/dev/null)" = "Привет, терминал!" ]',
  },
  {
    id: 'cat-house',
    title: 'Постройте домик для кота',
    description: 'Создайте каталог /workspace/cat-house и пустой файл meow.txt внутри него.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'mkdir -p /workspace/cat-house && touch /workspace/cat-house/meow.txt',
    successMessage: 'Домик готов, кот доволен.',
    setupScript: 'mkdir -p /workspace',
    checkScript: '[ -d /workspace/cat-house ] && [ -f /workspace/cat-house/meow.txt ] && [ ! -s /workspace/cat-house/meow.txt ]',
  },
  {
    id: 'copy-treasure',
    title: 'Положите сокровище в рюкзак',
    description: 'Скопируйте /workspace/chest/treasure.txt в каталог /workspace/backpack, сохранив имя файла.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'cp /workspace/chest/treasure.txt /workspace/backpack/',
    successMessage: 'Сокровище теперь в рюкзаке.',
    setupScript: `
      mkdir -p /workspace/chest /workspace/backpack
      printf 'golden command\n' > /workspace/chest/treasure.txt
    `,
    checkScript: `
      [ -f /workspace/backpack/treasure.txt ] &&
      cmp -s /workspace/chest/treasure.txt /workspace/backpack/treasure.txt
    `,
  },
  {
    id: 'rename-duck',
    title: 'Переименуйте утку',
    description: 'Переименуйте /workspace/duck.tmp в /workspace/duck.txt.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'mv /workspace/duck.tmp /workspace/duck.txt',
    successMessage: 'Утка получила правильное расширение.',
    setupScript: "printf 'quack\\n' > /workspace/duck.tmp",
    checkScript: '[ ! -e /workspace/duck.tmp ] && grep -qx quack /workspace/duck.txt',
  },
  {
    id: 'first-story-line',
    title: 'Сохраните первую строку сказки',
    description: 'Запишите первую строку файла /workspace/story.txt в /workspace/answer.txt.',
    category: 'Bash',
    difficulty: 'Easy',
    hint: 'head -n 1 /workspace/story.txt > /workspace/answer.txt',
    successMessage: 'Первая строка сохранена.',
    setupScript: `
      printf '%s\n' 'Жил-был маленький пингвин.' 'Он изучал Linux.' 'И всё у него получилось.' > /workspace/story.txt
    `,
    checkScript: '[ "$(cat /workspace/answer.txt 2>/dev/null)" = "Жил-был маленький пингвин." ]',
  },
  {
    id: 'banana-count',
    title: 'Посчитайте бананы',
    description: 'Посчитайте строки banana в /workspace/fruits.txt и сохраните число в /workspace/answer.txt.',
    category: 'Bash',
    difficulty: 'Easy',
    hint: "grep -c '^banana$' /workspace/fruits.txt > /workspace/answer.txt",
    successMessage: 'Все бананы посчитаны.',
    setupScript: `
      printf '%s\n' apple banana banana orange banana > /workspace/fruits.txt
    `,
    checkScript: '[ "$(tr -d "[:space:]" < /workspace/answer.txt 2>/dev/null)" = "3" ]',
  },
  {
    id: 'sort-pets',
    title: 'Расставьте питомцев по алфавиту',
    description: 'Отсортируйте строки /workspace/pets.txt и сохраните результат в /workspace/sorted.txt.',
    category: 'Bash',
    difficulty: 'Easy',
    hint: 'sort /workspace/pets.txt > /workspace/sorted.txt',
    successMessage: 'Питомцы построились по алфавиту.',
    setupScript: "printf '%s\\n' dog cat hamster > /workspace/pets.txt",
    checkScript: `
      [ -f /workspace/sorted.txt ] &&
      diff -u <(printf '%s\n' cat dog hamster) /workspace/sorted.txt
    `,
  },
  {
    id: 'hidden-gem',
    title: 'Спрячьте драгоценный камень',
    description: 'Создайте пустой скрытый файл /workspace/.gem.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'touch /workspace/.gem',
    successMessage: 'Камень надёжно спрятан.',
    setupScript: 'mkdir -p /workspace',
    checkScript: '[ -f /workspace/.gem ] && [ ! -s /workspace/.gem ]',
  },
  {
    id: 'delete-junk',
    title: 'Выбросьте мусор',
    description: 'Удалите файл /workspace/junk.txt. Остальные файлы не трогайте.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'rm /workspace/junk.txt',
    successMessage: 'Рабочее место снова чистое.',
    setupScript: `
      printf 'delete me\n' > /workspace/junk.txt
      printf 'keep me\n' > /workspace/important.txt
    `,
    checkScript: '[ ! -e /workspace/junk.txt ] && grep -qx "keep me" /workspace/important.txt',
  },
  {
    id: 'rainbow-files',
    title: 'Соберите радугу',
    description: 'Объедините red.txt и blue.txt в /workspace/rainbow.txt именно в таком порядке.',
    category: 'Bash',
    difficulty: 'Easy',
    hint: 'cat /workspace/red.txt /workspace/blue.txt > /workspace/rainbow.txt',
    successMessage: 'Текстовая радуга собрана.',
    setupScript: `
      printf 'red\n' > /workspace/red.txt
      printf 'blue\n' > /workspace/blue.txt
    `,
    checkScript: `
      [ -f /workspace/rainbow.txt ] &&
      diff -u <(printf 'red\nblue\n') /workspace/rainbow.txt
    `,
  },
  {
    id: 'directory-mode',
    title: 'Каталог приложения',
    description: 'Создайте каталог /workspace/app и установите для него права 750.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'Понадобятся mkdir и chmod.',
    successMessage: 'Каталог существует, тип и права проверены.',
    setupScript: 'mkdir -p /workspace',
    checkScript: '[ -d /workspace/app ] && [ "$(stat -c %a /workspace/app)" = "750" ]',
  },
  {
    id: 'move-largest-file',
    title: 'Найдите крупный файл',
    description: 'Найдите файл больше 5 МБ в /workspace/data и переместите его в /workspace/archive, сохранив имя.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'find умеет фильтровать файлы по размеру.',
    successMessage: 'Крупный файл найден и перемещён правильно.',
    setupScript: `
      mkdir -p /workspace/data/nested /workspace/archive
      truncate -s 32K /workspace/data/access.log
      truncate -s 256K /workspace/data/nested/cache.bin
      truncate -s 8M /workspace/data/nested/database.dump
    `,
    checkScript: `
      [ ! -e /workspace/data/nested/database.dump ] &&
      [ -f /workspace/archive/database.dump ] &&
      [ "$(stat -c %s /workspace/archive/database.dump)" -eq 8388608 ]
    `,
  },
  {
    id: 'secure-secret',
    title: 'Закройте доступ к секрету',
    description: 'Оставьте владельцу файла /workspace/secret.env права чтения и записи, а у остальных уберите все права.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'Нужный числовой режим состоит из 6, 0 и 0.',
    successMessage: 'Файл защищён режимом 600.',
    setupScript: `
      printf 'API_KEY=demo-only-secret\n' > /workspace/secret.env
      chmod 0644 /workspace/secret.env
    `,
    checkScript: '[ -f /workspace/secret.env ] && [ "$(stat -c %a /workspace/secret.env)" = "600" ]',
  },
  {
    id: 'log-investigation',
    title: 'Расследуйте ошибку в логе',
    description: 'Найдите IP-адрес клиента, получившего HTTP 503 в /workspace/access.log, и запишите только этот IP в /workspace/answer.txt.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'Отфильтруйте строку по коду ответа 503.',
    successMessage: 'Нужный IP извлечён из журнала.',
    setupScript: `
      printf '%s\n' \\
        '198.51.100.7 - GET /health 200 12ms' \\
        '203.0.113.42 - POST /api/jobs 503 3012ms' \\
        '192.0.2.19 - GET /docs 304 3ms' \\
        > /workspace/access.log
    `,
    checkScript: '[ "$(tr -d "[:space:]" < /workspace/answer.txt 2>/dev/null)" = "203.0.113.42" ]',
  },
  {
    id: 'archive-logs',
    title: 'Упакуйте журналы',
    description: 'Создайте gzip-архив /workspace/logs.tar.gz, содержащий оба файла из каталога /workspace/logs.',
    category: 'Bash',
    difficulty: 'Easy',
    hint: 'У tar есть флаги для создания архива и gzip-сжатия.',
    successMessage: 'Архив читается и содержит оба журнала.',
    setupScript: `
      mkdir -p /workspace/logs
      printf 'service started\n' > /workspace/logs/app.log
      printf 'no errors\n' > /workspace/logs/error.log
    `,
    checkScript: `
      [ -f /workspace/logs.tar.gz ] &&
      tar -tzf /workspace/logs.tar.gz | grep -q 'app.log$' &&
      tar -tzf /workspace/logs.tar.gz | grep -q 'error.log$'
    `,
  },
  {
    id: 'release-symlink',
    title: 'Переключите конфигурацию',
    description: 'Создайте символическую ссылку /workspace/current.conf на файл /workspace/versions/app-v2.conf.',
    category: 'Linux',
    difficulty: 'Easy',
    hint: 'Используйте ln в режиме создания symbolic link.',
    successMessage: 'Ссылка указывает на версию v2.',
    setupScript: `
      mkdir -p /workspace/versions
      printf 'release=v1\n' > /workspace/versions/app-v1.conf
      printf 'release=v2\n' > /workspace/versions/app-v2.conf
    `,
    checkScript: `
      [ -L /workspace/current.conf ] &&
      [ "$(readlink -f /workspace/current.conf)" = "/workspace/versions/app-v2.conf" ]
    `,
  },
  {
    id: 'production-config',
    title: 'Исправьте production-конфиг',
    description: 'В /workspace/app.conf замените debug=true на debug=false. Остальные строки должны сохраниться.',
    category: 'Bash',
    difficulty: 'Easy',
    hint: 'Подойдёт sed или любой текстовый редактор.',
    successMessage: 'Отладка выключена, конфигурация не повреждена.',
    setupScript: `
      printf 'name=clirace\ndebug=true\nworkers=4\n' > /workspace/app.conf
    `,
    checkScript: `
      grep -qx 'name=clirace' /workspace/app.conf &&
      grep -qx 'debug=false' /workspace/app.conf &&
      grep -qx 'workers=4' /workspace/app.conf &&
      [ "$(wc -l < /workspace/app.conf)" -eq 3 ]
    `,
  },
  {
    id: 'stop-worker',
    title: 'Остановите зависший процесс',
    description: 'Остановите процесс sleep, PID которого записан в /workspace/worker.pid. PID-файл оставьте на месте.',
    category: 'Linux',
    difficulty: 'Medium',
    hint: 'Прочитайте PID из файла и отправьте процессу сигнал.',
    successMessage: 'Процесс остановлен.',
    setupScript: `
      sleep 900 </dev/null >/dev/null 2>&1 &
      echo $! > /workspace/worker.pid
    `,
    checkScript: `
      [ -s /workspace/worker.pid ] &&
      pid="$(cat /workspace/worker.pid)" &&
      { [ ! -r "/proc/$pid/stat" ] || [ "$(awk '{print $3}' "/proc/$pid/stat")" = Z ]; }
    `,
  },
  {
    id: 'restore-git-file',
    title: 'Отмените изменение в Git',
    description: 'В репозитории /workspace/repo восстановите README.md до состояния последнего коммита. Файл notes.txt удалять нельзя.',
    category: 'Git',
    difficulty: 'Medium',
    hint: 'Git умеет восстанавливать отдельный файл из индекса.',
    successMessage: 'README восстановлен, несвязанный файл сохранён.',
    setupScript: `
      mkdir -p /workspace/repo
      cd /workspace/repo
      git init -q
      printf '# CLIRace\nStable documentation.\n' > README.md
      git add README.md
      git -c user.name=CLIRace -c user.email=lab@clirace.local commit -qm initial
      printf '# BROKEN\nDo not keep this line.\n' > README.md
      printf 'important local notes\n' > notes.txt
    `,
    checkScript: `
      cd /workspace/repo &&
      git diff --quiet -- README.md &&
      [ -f notes.txt ] &&
      grep -qx 'important local notes' notes.txt
    `,
  },
  {
    id: 'filter-json',
    title: 'Отфильтруйте JSON',
    description: 'Из /workspace/services.json извлеките имена только включённых сервисов и запишите их в /workspace/enabled.txt, по одному имени на строку.',
    category: 'Bash',
    difficulty: 'Medium',
    hint: 'jq может выбрать элементы массива по булевому полю.',
    successMessage: 'Список включённых сервисов сформирован правильно.',
    setupScript: `
      printf '%s\n' '[{"name":"api","enabled":true},{"name":"worker","enabled":false},{"name":"web","enabled":true}]' > /workspace/services.json
    `,
    checkScript: `
      [ -f /workspace/enabled.txt ] &&
      diff -u <(printf 'api\nweb\n') <(sed '/^[[:space:]]*$/d' /workspace/enabled.txt | sort)
    `,
  },
  {
    id: 'local-http',
    title: 'Проверьте локальный сервис',
    description: 'Получите http://127.0.0.1:8081/status.txt и сохраните тело ответа в /workspace/response.txt.',
    category: 'Networking',
    difficulty: 'Medium',
    hint: 'Используйте curl -fsS URL -o FILE. Сервис слушает только внутри этой песочницы.',
    successMessage: 'Ответ локального HTTP-сервиса сохранён.',
    setupScript: `
      mkdir -p /workspace/www
      printf 'CLIRace service: ready\n' > /workspace/www/status.txt
      python3 -m http.server 8081 --bind 127.0.0.1 --directory /workspace/www </dev/null >/tmp/http-server.log 2>&1 &
      echo $! > /workspace/http-server.pid
      for attempt in $(seq 1 30); do
        curl -fsS http://127.0.0.1:8081/status.txt >/dev/null 2>&1 && break
        sleep 0.1
      done
      curl -fsS http://127.0.0.1:8081/status.txt >/dev/null
    `,
    checkScript: `
      [ -f /workspace/response.txt ] &&
      [ "$(cat /workspace/response.txt)" = "CLIRace service: ready" ]
    `,
  },
  {
    id: 'rename-backups',
    title: 'Верните имена резервным копиям',
    description: 'В /workspace/backups переименуйте все файлы *.conf.bak в *.conf, убрав только суффикс .bak.',
    category: 'Bash',
    difficulty: 'Medium',
    hint: 'Используйте цикл и удаление суффикса у имени переменной.',
    successMessage: 'Все конфигурации переименованы без потерь.',
    setupScript: `
      mkdir -p /workspace/backups
      printf 'port=80\n' > /workspace/backups/web.conf.bak
      printf 'workers=4\n' > /workspace/backups/api.conf.bak
      printf 'maxmemory=128mb\n' > /workspace/backups/redis.conf.bak
    `,
    checkScript: `
      [ ! -e /workspace/backups/web.conf.bak ] &&
      [ ! -e /workspace/backups/api.conf.bak ] &&
      [ ! -e /workspace/backups/redis.conf.bak ] &&
      grep -qx 'port=80' /workspace/backups/web.conf &&
      grep -qx 'workers=4' /workspace/backups/api.conf &&
      grep -qx 'maxmemory=128mb' /workspace/backups/redis.conf
    `,
  },
];

const baseReferenceSolutions: Readonly<Record<string, string>> = {
  'hello-terminal': "printf 'Привет, терминал!\\n' > /workspace/hello.txt",
  'directory-mode': 'mkdir -p /workspace/app && chmod 750 /workspace/app',
  'move-largest-file': 'find /workspace/data -type f -size +5M -exec mv {} /workspace/archive/ \\;',
  'secure-secret': 'chmod 600 /workspace/secret.env',
  'log-investigation': "awk '$5 == 503 { print $1 }' /workspace/access.log > /workspace/answer.txt",
  'archive-logs': 'tar -czf /workspace/logs.tar.gz -C /workspace/logs .',
  'release-symlink': 'ln -s /workspace/versions/app-v2.conf /workspace/current.conf',
  'production-config': "sed -i 's/debug=true/debug=false/' /workspace/app.conf",
  'stop-worker': 'kill "$(cat /workspace/worker.pid)" && sleep 0.1',
  'restore-git-file': 'cd /workspace/repo && git restore README.md',
  'filter-json': "jq -r '.[] | select(.enabled) | .name' /workspace/services.json > /workspace/enabled.txt",
  'local-http': 'curl -fsS http://127.0.0.1:8081/status.txt -o /workspace/response.txt',
  'rename-backups': "for file in /workspace/backups/*.conf.bak; do mv \"$file\" \"${file%.bak}\"; done",
};

const checkerContractsById: Readonly<Record<string, ChallengeCheckerContract>> = {
  'build-castle': checkerContract(linuxCoreRuntime, [
    { id: 'tower-directory', type: 'file_exists', path: '/workspace/castle/tower', kind: 'directory', failureHint: 'Создайте каталог /workspace/castle/tower.' },
  ]),
  'name-robot': checkerContract(linuxCoreRuntime, [
    { id: 'robot-file', type: 'file_exists', path: '/workspace/robot.txt', kind: 'file', failureHint: 'Создайте файл robot.txt.' },
    { id: 'robot-name', type: 'file_contains', path: '/workspace/robot.txt', expected: 'BEEP-42', failureHint: 'В файле должна быть строка BEEP-42.' },
  ]),
  'launch-rocket': checkerContract(linuxCoreRuntime, [
    { id: 'rocket-left-hangar', type: 'file_not_exists', path: '/workspace/hangar/rocket.txt', failureHint: 'Уберите rocket.txt из ангара.' },
    { id: 'rocket-on-launchpad', type: 'file_contains', path: '/workspace/launchpad/rocket.txt', expected: 'ready', failureHint: 'Переместите готовую ракету на launchpad.' },
  ]),
  'remove-crumbs': checkerContract(linuxCoreRuntime, [
    { id: 'crumbs-removed', type: 'file_not_exists', path: '/workspace/crumbs.txt', failureHint: 'Удалите crumbs.txt.' },
    { id: 'cake-preserved', type: 'file_contains', path: '/workspace/cake.txt', expected: 'cake', failureHint: 'Файл cake.txt должен остаться на месте.' },
  ]),
  'executable-spell': checkerContract(linuxCoreRuntime, [
    { id: 'spell-present', type: 'file_exists', path: '/workspace/spell.sh', kind: 'file' },
    { id: 'spell-mode', type: 'permission_equals', path: '/workspace/spell.sh', mode: '0755', failureHint: 'Установите права 755.' },
  ]),
  'readonly-scroll': checkerContract(linuxCoreRuntime, [
    { id: 'scroll-present', type: 'file_exists', path: '/workspace/scroll.txt', kind: 'file' },
    { id: 'scroll-mode', type: 'permission_equals', path: '/workspace/scroll.txt', mode: '0444', failureHint: 'Установите права 444.' },
  ]),
  'portal-shortcut': checkerContract(linuxCoreRuntime, [
    { id: 'portal-target', type: 'symlink_points_to', path: '/workspace/portal', target: '/workspace/worlds/mars', failureHint: 'Создайте символическую ссылку portal на каталог mars.' },
  ]),
  'hello-terminal': checkerContract(linuxCoreRuntime, [
    { id: 'hello-file', type: 'file_exists', path: '/workspace/hello.txt', kind: 'file' },
    { id: 'hello-text', type: 'file_contains', path: '/workspace/hello.txt', expected: 'Привет, терминал!', failureHint: 'Запишите приветствие в hello.txt.' },
  ]),
  'delete-junk': checkerContract(linuxCoreRuntime, [
    { id: 'junk-removed', type: 'file_not_exists', path: '/workspace/junk.txt', failureHint: 'Удалите только junk.txt.' },
    { id: 'important-preserved', type: 'file_contains', path: '/workspace/important.txt', expected: 'keep me', failureHint: 'Файл important.txt должен сохраниться.' },
  ]),
  'directory-mode': checkerContract(linuxCoreRuntime, [
    { id: 'app-directory', type: 'file_exists', path: '/workspace/app', kind: 'directory', failureHint: 'Создайте каталог /workspace/app.' },
    { id: 'app-directory-mode', type: 'permission_equals', path: '/workspace/app', mode: '0750', failureHint: 'Установите каталогу права 750.' },
  ]),
  'secure-secret': checkerContract(linuxCoreRuntime, [
    { id: 'secret-present', type: 'file_exists', path: '/workspace/secret.env', kind: 'file' },
    { id: 'secret-mode', type: 'permission_equals', path: '/workspace/secret.env', mode: '0600', failureHint: 'Оставьте доступ только владельцу: режим 600.' },
    { id: 'secret-owner', type: 'owner_equals', path: '/workspace/secret.env', user: 'root' },
  ]),
  'release-symlink': checkerContract(linuxCoreRuntime, [
    { id: 'release-target', type: 'symlink_points_to', path: '/workspace/current.conf', target: '/workspace/versions/app-v2.conf', failureHint: 'current.conf должна быть символической ссылкой на app-v2.conf.' },
  ]),
  'stop-worker': checkerContract(linuxCoreRuntime, [
    { id: 'worker-pid-preserved', type: 'file_exists', path: '/workspace/worker.pid', kind: 'file', failureHint: 'Не удаляйте worker.pid.' },
    { id: 'worker-stopped', type: 'process_not_running', process: 'sleep', failureHint: 'Процесс sleep всё ещё работает.' },
  ]),
  'local-http': checkerContract(linuxCoreRuntime, [
    { id: 'local-service-listening', type: 'port_listening', protocol: 'tcp', port: 8081, bindAddress: '127.0.0.1', failureHint: 'Локальный сервис должен оставаться запущенным.' },
    { id: 'response-file', type: 'file_contains', path: '/workspace/response.txt', expected: 'CLIRace service: ready', failureHint: 'Сохраните тело ответа в response.txt.' },
  ]),
};

const baseChallenges: readonly SandboxChallenge[] = baseChallengeDefinitions.map((challenge) => ({
  ...challenge,
  ...(checkerContractsById[challenge.id] ?? {}),
  referenceSolution: baseReferenceSolutions[challenge.id] ?? challenge.hint,
}));

const interviewChallenges: readonly SandboxChallenge[] = INTERVIEW_100
  .filter((task) => task.sandbox)
  .map((task) => ({
    id: task.slug,
    title: task.title,
    description: task.description,
    category: INTERVIEW_TOPIC_LABELS[task.topic],
    difficulty: task.difficulty,
    hint: task.sandbox!.hint,
    successMessage: task.explanation,
    setupScript: task.sandbox!.setupScript,
    checkScript: task.sandbox!.checkScript,
    referenceSolution: task.solution,
  }));

const challenges: readonly SandboxChallenge[] = [...baseChallenges, ...interviewChallenges];

export function pickSandboxChallenge(excludeId?: string): SandboxChallenge {
  const candidates = excludeId
    ? challenges.filter((challenge) => challenge.id !== excludeId)
    : challenges;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? challenges[0]!;
}

export function getSandboxChallenge(id: string): SandboxChallenge | undefined {
  return challenges.find((challenge) => challenge.id === id);
}

export function toPublicChallenge(challenge: SandboxChallenge): PublicSandboxChallenge {
  const { id, title, description, category, difficulty, hint } = challenge;
  return { id, title, description, category, difficulty, hint };
}

export function listSandboxChallenges(): readonly SandboxChallenge[] {
  return challenges;
}
import { INTERVIEW_100, INTERVIEW_TOPIC_LABELS } from './interview-data.js';

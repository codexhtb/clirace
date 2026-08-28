import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const lesson = (slug, title, concept, intro, action, command, wrongCommands, checkQuestion, checkAnswer, checkWrong, note, existing) => ({
  slug, title, concept, intro, action, command, wrongCommands, checkQuestion, checkAnswer, checkWrong, note, existing,
});

const modules = [
  {
    slug: 'terminal-basics', title: 'Linux и терминал', category: 'bash',
    description: 'Разберитесь, где выполняются команды, как читать приглашение shell и безопасно получать справку.',
    required: 'packages-audit-bash-runtime', optional: ['packages-verify-coreutils-toolkit', 'packages-confirm-curl-client'],
    lessons: [
      lesson('linux-shell', 'Linux, терминал и shell', 'terminal_model', 'Терминал показывает интерфейс, shell разбирает введённую строку, а Linux запускает найденную программу. Это разные слои одной рабочей сессии.', 'Выведите имя текущего shell-процесса.', 'ps -p $$ -o comm=', ['echo $HOME', 'uname -r', 'pwd'], 'Что обозначает `$$` в интерактивном shell?', 'PID текущего shell', ['UID текущего пользователя', 'код завершения прошлой команды', 'номер фоновой задачи'], 'Shell подставляет `$$` своим PID до запуска команды.'),
      lesson('prompt-command', 'Приглашение и запуск команды', 'command_invocation', 'Строка приглашения сообщает, что shell готов. Вводить нужно только команду после символа приглашения, а не имя пользователя и путь из prompt.', 'Напечатайте короткое сообщение без копирования prompt.', "printf '%s\n' 'Привет, Linux'", ['clirace@sandbox:/workspace$', 'prompt Привет, Linux', 'run Привет, Linux'], 'Какую часть строки `user@host:/workspace$ pwd` вводит пользователь?', '`pwd`', ['всю строку целиком', '`user@host`', 'символ `$` и `pwd`'], 'Prompt не является частью команды; shell получает только текст после приглашения.'),
      lesson('help-manuals', 'Справка без угадывания', 'command_help', 'У большинства утилит есть краткая справка `--help`; подробные руководства доступны через `man`, если страницы установлены в окружении.', 'Откройте краткую справку утилиты `ls`.', 'ls --help', ['help ls --all', 'ls /help', 'man --run ls'], 'Что безопаснее сделать перед использованием незнакомого флага?', 'Проверить `command --help` или руководство', ['Сразу выполнить команду от root', 'Подобрать флаг случайно', 'Скопировать prompt целиком'], 'Справка показывает синтаксис именно установленной версии команды.'),
      lesson('exit-status', 'Код завершения команды', 'exit_status', 'Каждая программа возвращает целый код: ноль обычно означает успех, ненулевое значение — ошибку или отдельное состояние.', 'Выполните успешную команду и сразу покажите её код.', 'true; echo $?', ['true; echo $$', 'true; echo $!', 'true; echo $#'], 'Почему код нужно читать сразу после интересующей команды?', 'Следующая команда перезапишет значение `$?`', ['Код хранится только в файле', 'Shell удаляет программу через минуту', 'Код доступен только root'], 'Переменная `$?` относится к последней завершившейся команде.', 'bash-exit-status'),
    ],
  },
  {
    slug: 'filesystem-navigation', title: 'Навигация по файловой системе', category: 'filesystem',
    description: 'Научитесь различать абсолютные и относительные пути, менять каталог и проверять своё местоположение.',
    required: 'filesystem-create-cache-layout', optional: ['filesystem-build-release-tree', 'filesystem-stage-application-config'],
    lessons: [
      lesson('tree-root', 'Единое дерево от корня', 'filesystem_tree', 'В Linux все пути входят в одно дерево с корнем `/`. Каталоги вроде `/etc`, `/var` и `/home` имеют разные назначения, но принадлежат одному пространству имён.', 'Покажите содержимое корневого каталога.', 'ls /', ['ls root', 'cd --list /', 'tree --root-only'], 'Какой символ обозначает корень файловой системы?', '`/`', ['`~`', '`.`', '`..`'], 'Начальный `/` делает путь абсолютным и независимым от текущего каталога.', 'filesystem-absolute-path'),
      lesson('where-am-i', 'Текущий рабочий каталог', 'working_directory', 'Относительные пути вычисляются от текущего рабочего каталога процесса. Команда `pwd` позволяет не гадать, где вы находитесь.', 'Покажите полный путь текущего каталога.', 'pwd', ['cwd', 'where', 'path --current'], 'Что изменяет команда `cd /workspace`?', 'Текущий каталог shell', ['Домашний каталог в `/etc/passwd`', 'Имя пользователя', 'Права каталога'], '`cd` — встроенная команда shell, поэтому она меняет состояние текущей сессии.'),
      lesson('relative-paths', 'Относительные пути', 'relative_paths', 'Точка `.` означает текущий каталог, две точки `..` — родительский. Путь без начального `/` считается относительным.', 'Перейдите в каталог `logs` внутри родителя текущего каталога.', 'cd ../logs', ['cd /../logs', 'pwd ../logs', 'ls --cd ../logs'], 'Как интерпретируется путь `./report.txt`?', 'Файл `report.txt` в текущем каталоге', ['Файл в корне системы', 'Файл в домашнем каталоге', 'Каталог уровнем выше'], '`./` явно фиксирует начало относительного пути в текущем каталоге.'),
      lesson('home-shortcuts', 'Домашний каталог и `~`', 'home_directory', 'Shell раскрывает `~` в домашний каталог текущего пользователя. Переменная `$HOME` хранит тот же базовый путь для программ.', 'Перейдите в домашний каталог независимо от текущего пути.', 'cd ~', ['cd /home', 'cd .home', 'home --enter'], 'Чем полезен путь `~/notes.txt`?', 'Он указывает на файл в домашнем каталоге текущего пользователя', ['Он всегда означает `/root/notes.txt`', 'Он создаёт временный файл', 'Он ищет файл во всех каталогах'], 'Раскрытие `~` выполняет shell до запуска команды.'),
    ],
  },
  {
    slug: 'files-directories', title: 'Файлы и каталоги', category: 'filesystem',
    description: 'Создавайте, копируйте, перемещайте и удаляйте данные с проверяемым результатом.',
    required: 'filesystem-backup-service-manifest', optional: ['filesystem-clean-temporary-artifacts', 'filesystem-restore-config-from-template'],
    lessons: [
      lesson('create', 'Создание файлов и каталогов', 'create_paths', '`mkdir -p` создаёт цепочку каталогов, а `touch` создаёт пустой файл или обновляет его время изменения.', 'Создайте каталог `/workspace/demo/logs` вместе с родителями.', 'mkdir -p /workspace/demo/logs', ['touch -p /workspace/demo/logs', 'mkdir /workspace/demo/logs/..', 'newdir --parents /workspace/demo/logs'], 'Что делает `touch existing.txt` с существующим файлом?', 'Обновляет временные метки, не стирая содержимое', ['Удаляет содержимое файла', 'Превращает файл в каталог', 'Делает файл исполняемым'], 'Флаг `-p` делает создание вложенной структуры идемпотентным.'),
      lesson('copy', 'Копирование данных', 'copy_paths', '`cp` создаёт отдельную копию файла. Для каталога обычно требуется рекурсивный режим `-r`, а перед перезаписью важно проверить путь назначения.', 'Скопируйте `app.conf` в `app.conf.bak`.', 'cp app.conf app.conf.bak', ['mv app.conf app.conf.bak', 'ln app.conf app.conf.bak', 'cat app.conf.bak app.conf'], 'Чем копия отличается от символической ссылки?', 'Копия хранит независимые данные', ['Копия всегда следует за оригиналом', 'Копия не занимает место', 'Копия доступна только root'], 'После `cp` изменения одного обычного файла не меняют второй.'),
      lesson('move-rename', 'Перемещение и переименование', 'move_paths', 'Команда `mv` меняет имя или расположение объекта. В пределах одной файловой системы это обычно не копирование всех байтов, а смена записи каталога.', 'Переименуйте `draft.txt` в `report.txt`.', 'mv draft.txt report.txt', ['cp draft.txt report.txt', 'rename --copy draft.txt report.txt', 'touch report.txt draft.txt'], 'Что нужно проверить перед `mv file target/`?', 'Что `target/` — ожидаемый каталог назначения', ['Что файл исполняемый', 'Что включён сетевой интерфейс', 'Что shell запущен от root'], '`mv` может перезаписать существующее назначение, поэтому путь нужно читать внимательно.'),
      lesson('remove', 'Удаление без сюрпризов', 'remove_paths', '`rm` удаляет имена файлов без корзины. Рекурсивное удаление каталогов требует особенно точного пути и предварительной проверки.', 'Удалите пустой каталог `old-cache`.', 'rmdir old-cache', ['rm -rf /', 'del old-cache', 'unlink --recursive old-cache'], 'Какая команда показывает размер файловой системы, а не размер одного файла?', '`df -h`', ['`cat -h`', '`pwd -s`', '`chmod -h`'], 'Для пустого каталога `rmdir` безопаснее: он откажется удалять непустую структуру.', 'storage-free-filesystems'),
    ],
  },
  {
    slug: 'viewing-files', title: 'Просмотр содержимого файлов', category: 'filesystem',
    description: 'Выбирайте подходящий способ чтения маленьких файлов, начала, конца и растущих журналов.',
    required: 'text-collect-error-lines', optional: ['text-extract-failing-client-ip', 'text-enabled-services-from-csv'],
    lessons: [
      lesson('cat-small', '`cat` для коротких файлов', 'cat_files', '`cat` последовательно пишет содержимое файлов в stdout. Он удобен для небольших конфигов, но длинный лог лучше читать порциями.', 'Выведите короткий файл `version.txt`.', 'cat version.txt', ['open version.txt', 'read --all version.txt', 'echo < version.txt'], 'Куда `cat file.txt` отправляет содержимое по умолчанию?', 'В стандартный вывод', ['В стандартный ввод', 'В журнал ядра', 'В переменную PATH'], '`cat` не изменяет файл, если его вывод не перенаправлен.'),
      lesson('head-tail', 'Начало и конец файла', 'head_tail', '`head` показывает начало, `tail` — конец. Параметр `-n` задаёт точное число строк и помогает ограничить вывод.', 'Покажите последние 20 строк `app.log`.', 'tail -n 20 app.log', ['head -n 20 app.log', 'cat -n 20 app.log', 'last app.log 20'], 'Что выведет `head -n 1 hosts.txt`?', 'Первую строку файла', ['Последнюю строку файла', 'Первый байт файла', 'Имя файла без содержимого'], '`tail -n 20` читает конец файла и не ждёт новых строк без `-f`.'),
      lesson('follow-log', 'Наблюдение за растущим логом', 'follow_files', 'Режим `tail -f` продолжает ждать новые записи. Его останавливают `Ctrl+C`, не завершая сам сервис, который пишет журнал.', 'Начните наблюдать новые строки `worker.log`.', 'tail -f worker.log', ['head -f worker.log', 'cat --wait worker.log', 'watch worker.log --tail'], 'Как завершить интерактивный `tail -f`?', 'Нажать `Ctrl+C`', ['Удалить файл журнала', 'Закрыть сетевой порт', 'Выполнить `chmod 000`'], '`Ctrl+C` отправляет foreground-команде сигнал прерывания.', 'logs-follow-unit'),
      lesson('file-type', 'Тип и метаданные файла', 'file_metadata', '`file` определяет тип по содержимому, а `stat` показывает размер, владельца, права и временные метки.', 'Покажите подробные метаданные `report.txt`.', 'stat report.txt', ['meta report.txt', 'ls --content report.txt', 'type -a report.txt'], 'Когда полезна команда `file archive.bin`?', 'Когда нужно определить формат по содержимому', ['Когда нужно переименовать файл', 'Когда нужно изменить владельца', 'Когда нужно завершить процесс'], '`stat` отвечает о метаданных, а `file` — о предполагаемом формате данных.'),
    ],
  },
  {
    slug: 'search', title: 'Поиск файлов и текста', category: 'filesystem',
    description: 'Ищите объекты через `find`, строки через `grep` и избегайте шумных или слишком широких запросов.',
    required: 'text-find-debug-configs', optional: ['text-list-large-cache-files', 'text-find-exposed-secrets'],
    lessons: [
      lesson('find-name', 'Поиск по имени', 'find_name', '`find` обходит дерево от указанной точки. Условия `-type` и `-name` сужают результат до нужных объектов.', 'Найдите обычные файлы `*.conf` внутри `/workspace`.', "find /workspace -type f -name '*.conf'", ["grep '*.conf' /workspace", "ls -name '*.conf' /workspace", "find '*.conf' -in /workspace"], 'Зачем шаблон `*.conf` заключают в кавычки?', 'Чтобы шаблон обработал `find`, а не текущий shell', ['Чтобы сделать файлы скрытыми', 'Чтобы искать только каталоги', 'Чтобы включить права root'], 'Точка поиска идёт перед условиями, а кавычки защищают glob от раннего раскрытия.'),
      lesson('grep-text', 'Поиск строк через `grep`', 'grep_text', '`grep` печатает строки, совпавшие с шаблоном. Флаг `-n` добавляет номера строк, а `-i` отключает учёт регистра.', 'Найдите слово `error` без учёта регистра в `app.log`.', 'grep -i error app.log', ['find error app.log', 'cat -i error app.log', 'grep app.log error --file'], 'Что добавляет `grep -n`?', 'Номера совпавших строк', ['Число файлов в каталоге', 'Имена пользователей', 'Сетевые номера портов'], '`grep` читает файл и пишет совпавшие строки, не меняя источник.'),
      lesson('recursive-grep', 'Рекурсивный поиск текста', 'grep_recursive', '`grep -r` проходит файлы под каталогом. Полезно ограничивать расширения через `--include`, чтобы не читать лишнее.', 'Найдите `timeout` только в файлах `.conf` дерева `config`.', "grep -r --include='*.conf' timeout config", ['grep timeout config/*.bin', 'find config timeout --text', 'cat -r timeout config'], 'Почему широкий `grep -r /` — плохая первая проверка?', 'Он создаёт много шума и читает лишние пути', ['Он всегда удаляет совпадения', 'Он меняет владельцев файлов', 'Он отключает сеть'], 'Начинайте поиск с самого узкого каталога и подходящего типа файлов.'),
      lesson('quiet-count', 'Код результата и подсчёт', 'grep_result', '`grep -q` не печатает строки, а сообщает наличие совпадения кодом завершения. `grep -c` считает совпавшие строки.', 'Проверьте наличие `READY` в `state.txt` без вывода строки.', 'grep -q READY state.txt', ['grep -c READY state.txt', 'cat -q READY state.txt', 'test READY in state.txt'], 'Какая команда показывает ошибки текущей загрузки systemd-журнала?', '`journalctl -b -p err`', ['`grep -q boot /etc/passwd`', '`tail -f /dev/null`', '`ps -p err`'], '`grep -q` удобен в условиях shell: ноль означает, что совпадение найдено.', 'logs-current-boot-errors'),
    ],
  },
  {
    slug: 'permissions', title: 'Права доступа', category: 'permissions',
    description: 'Читайте `rwx`, меняйте режимы осознанно и учитывайте разные правила для файлов и каталогов.',
    required: 'permissions-lock-private-key', optional: ['permissions-enable-deploy-script', 'permissions-remove-world-write-config'],
    lessons: [
      lesson('read-mode', 'Как читать `rwx`', 'read_permissions', 'Три тройки прав относятся к владельцу, группе и остальным. В каждой тройке `r`, `w`, `x` означают чтение, запись и выполнение.', 'Покажите права и владельца `deploy.sh` в длинном формате.', 'ls -l deploy.sh', ['ls -a deploy.sh', 'chmod -l deploy.sh', 'stat --run deploy.sh'], 'Какой режим соответствует `rwxr-x---`?', '`750`', ['`777`', '`640`', '`705`'], 'Первая тройка описывает владельца, вторая — группу, третья — остальных.', 'permissions-mode-750'),
      lesson('chmod-symbolic', 'Символьный `chmod`', 'chmod_symbolic', 'Символьная запись точно указывает аудиторию: `u` — владелец, `g` — группа, `o` — остальные, `a` — все.', 'Добавьте владельцу право выполнения `script.sh`, не меняя остальные биты.', 'chmod u+x script.sh', ['chmod 777 script.sh', 'chown u+x script.sh', 'chmod g-x script.sh'], 'Что делает оператор `-` в `chmod o-w file`?', 'Снимает указанное право', ['Добавляет указанное право', 'Меняет владельца', 'Удаляет файл'], '`chmod u+x` меняет только execute-бит владельца и сохраняет прочие права.'),
      lesson('directory-mode', 'Права каталога', 'directory_permissions', 'Для каталога `r` позволяет видеть имена, `w` — менять записи, а `x` — проходить по пути и обращаться к известным именам.', 'Разрешите владельцу полный доступ, группе чтение и проход, остальным ничего.', 'chmod 750 shared', ['chmod 640 shared', 'chmod 705 shared', 'chown 750 shared'], 'Что означает `x` у каталога?', 'Возможность проходить по каталогу к объектам', ['Запуск всех файлов внутри', 'Автоматическое чтение файлов', 'Удаление каталога без проверки'], 'У каталога режим без `x` может показывать имена, но блокировать доступ к объектам.', 'permissions-directory-execute'),
      lesson('safe-secrets', 'Безопасные права секретов', 'secret_permissions', 'Приватные ключи и токены обычно должны быть доступны только владельцу. Широкие права могут привести к отказу клиента или утечке.', 'Закройте приватный ключ для группы и остальных.', 'chmod 600 id_ed25519', ['chmod 644 id_ed25519', 'chmod 777 id_ed25519', 'chown 600 id_ed25519'], 'Почему SSH отвергает приватный ключ с широкими правами?', 'Другие пользователи могут прочитать секрет', ['Ключ становится каталогом', 'Сервер меняет TCP-порт', 'Shell теряет переменную HOME'], 'Режим `600` оставляет владельцу чтение и запись, остальным — ничего.', 'ssh-key-permissions'),
    ],
  },
  {
    slug: 'users-groups', title: 'Пользователи и группы', category: 'users_groups',
    description: 'Поймите UID, GID, группы процесса и связь идентичности с доступом к данным.',
    required: 'users-create-operations-group', optional: ['users-create-deploy-account', 'users-add-deploy-to-releases'],
    lessons: [
      lesson('identity', 'UID, GID и текущая идентичность', 'identity', 'Ядро проверяет числовые UID и GID. Имена удобны человеку и сопоставляются с идентификаторами через системные базы.', 'Покажите пользователя, UID, основной GID и группы текущей сессии.', 'id', ['who --uid-all-now', 'groups --pid $$ --long', 'userctl status self'], 'Что показывает команда `id` без аргументов?', 'Идентичность текущего пользователя и его группы', ['Только имя ядра', 'Только домашний каталог', 'Список сетевых портов'], '`id` собирает основные сведения, которые участвуют в проверке доступа.', 'users-effective-groups'),
      lesson('whoami', 'Имя пользователя и сессии', 'current_user', '`whoami` выводит эффективное имя пользователя процесса. `who` показывает вошедшие сессии и отвечает на другой вопрос.', 'Покажите эффективное имя пользователя одной строкой.', 'whoami', ['who am all', 'id --kernel', 'user --current-name'], 'Чем `whoami` отличается от `who`?', '`whoami` показывает текущую эффективную идентичность', ['`whoami` меняет пользователя', '`whoami` показывает права файла', '`whoami` завершает чужие сессии'], 'Эффективная идентичность важна именно для проверки прав текущего процесса.'),
      lesson('ownership', 'Владелец и группа файла', 'ownership', 'У inode есть владелец и группа. Команда `chown` меняет эти поля, а `chmod` меняет набор прав — это разные операции.', 'Назначьте файлу `report.txt` владельца `clirace` и группу `ops`.', 'chown clirace:ops report.txt', ['chmod clirace:ops report.txt', 'chgrp clirace:ops report.txt', 'id clirace:ops report.txt'], 'Какая команда меняет только группу файла?', '`chgrp ops report.txt`', ['`chmod ops report.txt`', '`groups report.txt ops`', '`mv report.txt ops`'], '`chown user:group` меняет владельца и группу в одной операции.'),
      lesson('group-access', 'Дополнительные группы', 'supplementary_groups', 'Процесс наследует набор дополнительных групп при входе. Добавление пользователя в группу обычно влияет на новые сессии, а не на уже запущенный shell.', 'Покажите группы пользователя `clirace`.', 'id clirace', ['chmod clirace', 'ps --groups clirace', 'ls -g /home/clirace'], 'Когда новая группа обычно появляется в процессах пользователя?', 'После новой сессии или явного обновления группы', ['После переименования любого файла', 'После `pwd`', 'После очистки DNS-кэша'], 'Группы — часть credentials процесса; старый shell не всегда получает изменения автоматически.'),
    ],
  },
  {
    slug: 'processes', title: 'Процессы и сигналы', category: 'processes',
    description: 'Наблюдайте процессы, находите PID, различайте foreground/background и завершайте работу корректным сигналом.',
    required: 'process-stop-stalled-worker', optional: ['process-start-idle-worker', 'process-stop-log-follower'],
    lessons: [
      lesson('ps', 'Снимок процессов через `ps`', 'process_listing', '`ps` показывает снимок процессов. Формат `ps aux` удобен для обзора, а точный `-p PID` — для проверки одного процесса.', 'Покажите процесс текущего shell по его PID.', 'ps -p $$', ['ps --name shell-current', 'pid $$ --show', 'jobs -p all-system'], 'Что означает состояние `Z` в `ps`?', 'Процесс завершён, но родитель ещё не забрал его статус', ['Процесс активно использует CPU', 'Процесс слушает TCP-порт', 'Процесс не имеет владельца'], '`ps -p $$` ограничивает снимок процессом текущего shell.', 'processes-zombie-state'),
      lesson('pgrep', 'Поиск PID по имени', 'process_pid', '`pgrep` ищет процессы по имени и возвращает PID. Перед отправкой сигнала полезно дополнительно проверить найденную команду.', 'Найдите PID процессов с точным именем `nginx`.', 'pgrep -x nginx', ['grep nginx /proc', 'ps --kill nginx', 'pidof --create nginx'], 'Какая команда находит PID nginx по имени?', '`pgrep nginx`', ['`grep nginx`', '`jobs nginx`', '`kill -l nginx`'], 'Флаг `-x` исключает частичные совпадения с похожими именами.', 'processes-find-pid'),
      lesson('signals', 'Сигналы и корректная остановка', 'process_signals', '`kill PID` по умолчанию отправляет SIGTERM. Это просьба завершиться корректно; SIGKILL стоит оставлять для процесса, который не реагирует.', 'Попросите процесс 4242 корректно завершиться.', 'kill 4242', ['kill -9 4242', 'rm /proc/4242', 'stop --delete 4242'], 'Какой сигнал отправляет обычный `kill PID`?', '`SIGTERM`', ['`SIGKILL`', '`SIGHUP`', '`SIGSTOP`'], 'SIGTERM даёт приложению шанс закрыть файлы и сохранить состояние.', 'signals-graceful-stop'),
      lesson('background', 'Foreground и background', 'background_jobs', 'Символ `&` запускает pipeline в фоне текущего shell. `jobs` показывает такие задания, а `fg` возвращает выбранное на передний план.', 'Запустите `sleep 30` как фоновую задачу.', 'sleep 30 &', ['sleep --daemon 30', 'bg sleep 30 now', 'jobs sleep 30'], 'Что показывает `jobs`?', 'Фоновые задания текущего shell', ['Все процессы системы', 'Только systemd units', 'Все открытые файлы'], 'Job ID принадлежит shell и не заменяет системный PID.'),
    ],
  },
  {
    slug: 'streams', title: 'stdin, stdout и stderr', category: 'pipes_redirection',
    description: 'Разделяйте вход, обычный вывод и ошибки, чтобы команды можно было безопасно соединять и автоматизировать.',
    required: 'shell-capture-command-streams', optional: ['shell-append-deployment-audit', 'shell-merge-config-fragments'],
    lessons: [
      lesson('three-streams', 'Три стандартных потока', 'standard_streams', 'Процесс обычно получает stdin с дескриптором 0, пишет обычный результат в stdout 1, а диагностику — в stderr 2.', 'Запишите обычный вывод `echo ok` в `result.txt`.', 'echo ok > result.txt', ['echo ok 2> result.txt', 'result.txt < echo ok', 'echo ok |< result.txt'], 'Какой номер файлового дескриптора у stderr?', '`2`', ['`0`', '`1`', '`3`'], 'Оператор `>` без номера перенаправляет stdout, то есть дескриптор 1.'),
      lesson('input', 'Стандартный ввод', 'standard_input', 'Оператор `<` подключает файл к stdin команды. Программа читает данные так, будто они пришли с клавиатуры или предыдущего этапа.', 'Передайте `names.txt` на stdin команды `sort`.', 'sort < names.txt', ['sort > names.txt', 'names.txt |< sort', 'sort 2> names.txt'], 'Изменяет ли `sort < names.txt` исходный файл?', 'Нет, результат идёт в stdout', ['Да, файл всегда сортируется на месте', 'Да, файл удаляется после чтения', 'Да, права файла меняются'], 'Перенаправление ввода не означает перезапись источника.'),
      lesson('stderr', 'Ошибки отдельно от результата', 'standard_error', 'Раздельные потоки позволяют сохранить данные и диагностику в разные файлы. Запись `2>` относится только к stderr.', 'Сохраните ошибки команды `ls /missing` в `errors.log`.', 'ls /missing 2> errors.log', ['ls /missing > errors.log', 'ls /missing < errors.log', 'ls /missing 3> errors.log'], 'Почему stderr отделён от stdout?', 'Чтобы диагностику можно было обрабатывать независимо от данных', ['Чтобы ошибки всегда скрывались', 'Чтобы команды работали только от root', 'Чтобы stdout нельзя было перенаправить'], 'Дескриптор 2 можно направить отдельно, не загрязняя полезный вывод.'),
      lesson('append', 'Перезапись и добавление', 'append_output', '`>` создаёт или обнуляет файл перед записью, а `>>` добавляет данные в конец. Выбор оператора определяет сохранность старого содержимого.', 'Добавьте строку `done` в конец `audit.log`.', 'echo done >> audit.log', ['echo done > audit.log', 'echo done < audit.log', 'echo done 2< audit.log'], 'Что останется после `echo one > note; echo two >> note`?', 'Две строки: `one`, затем `two`', ['Только строка `two`', 'Только строка `one`', 'Пустой файл'], '`>>` сохраняет прежнее содержимое и продолжает запись в конце.', 'redirection-append-output'),
    ],
  },
  {
    slug: 'pipes-redirection', title: 'Pipelines и перенаправления', category: 'pipes_redirection',
    description: 'Соединяйте небольшие команды, считайте результаты и контролируйте ошибки pipeline.',
    required: 'shell-build-unique-user-pipeline', optional: ['shell-sum-worker-durations', 'shell-extract-service-column'],
    lessons: [
      lesson('pipe', 'Как работает pipe', 'pipeline', 'Оператор `|` подключает stdout левой команды к stdin правой. stderr левой команды остаётся отдельным, если его явно не перенаправить.', 'Посчитайте строки с `ERROR` в `app.log`.', 'grep ERROR app.log | wc -l', ['grep ERROR app.log > wc -l', 'wc -l | grep ERROR app.log', 'grep ERROR app.log && wc -l'], 'Что получает `wc -l` в этом pipeline?', 'Только строки, выбранные `grep`', ['Имя файла `app.log`', 'stderr команды `grep`', 'Все файлы каталога'], 'Pipe передаёт поток байтов, а не имя временного файла.', 'pipes-filter-errors'),
      lesson('pipeline-order', 'Порядок этапов', 'pipeline_order', 'Каждый этап должен принимать формат предыдущего. Сначала выбирают данные, затем преобразуют, сортируют и считают.', 'Получите отсортированный список уникальных пользователей из `users.txt`.', 'sort users.txt | uniq', ['uniq users.txt | sort -r | rm', 'sort > uniq users.txt', 'users.txt | sort | uniq'], 'Почему перед обычным `uniq` часто ставят `sort`?', '`uniq` удаляет только соседние повторения', ['`uniq` принимает только числа', '`sort` открывает права доступа', '`uniq` работает только с каталогами'], 'Правильный порядок делает одинаковые строки соседними до дедупликации.'),
      lesson('tee', 'Вывод на экран и в файл', 'tee_output', '`tee` копирует stdin одновременно в stdout и файл. Это удобно, когда результат нужен следующей команде и в артефакте.', 'Покажите `report.txt` и одновременно сохраните копию в `copy.txt`.', 'cat report.txt | tee copy.txt', ['cat report.txt > tee copy.txt', 'tee report.txt < copy.txt', 'cat copy.txt | mv report.txt'], 'Что делает `tee -a file`?', 'Добавляет вход в конец файла и продолжает вывод', ['Удаляет файл после чтения', 'Печатает только stderr', 'Меняет владельца файла'], '`tee` не прерывает pipeline: копия потока продолжает идти в stdout.'),
      lesson('pipe-status', 'Ошибки внутри pipeline', 'pipeline_status', 'Без `pipefail` код pipeline обычно равен коду последней команды. В Bash `set -o pipefail` позволяет заметить ошибку любого этапа.', 'Включите обнаружение ошибок всех этапов pipeline.', 'set -o pipefail', ['set -o ignorefail', 'pipe --strict', 'export PIPE=fail'], 'Что меняет `pipefail`?', 'Pipeline становится ненулевым, если значимый этап завершился ошибкой', ['stderr автоматически удаляется', 'Все команды запускаются от root', 'Вывод всегда записывается в файл'], '`pipefail` делает автоматизацию честнее: ранняя ошибка не маскируется успешным `wc`.'),
    ],
  },
  {
    slug: 'text-processing', title: 'Обработка текста', category: 'bash',
    description: 'Применяйте `cut`, `sort`, `uniq`, `tr`, `sed` и `awk` к локальным данным без ручного копирования.',
    required: 'text-normalize-alert-message', optional: ['text-unique-login-users', 'text-replace-deprecated-endpoint'],
    lessons: [
      lesson('cut', 'Выбор полей через `cut`', 'cut_fields', '`cut` извлекает поля из строк с простым разделителем. Для CSV без кавычек достаточно `-d` и `-f`.', 'Покажите второе поле строк `users.csv`, разделённых запятой.', "cut -d',' -f2 users.csv", ['cut -f,2 users.csv', 'awk -d, 2 users.csv', 'grep --column 2 users.csv'], 'Когда `cut -d,` недостаточно для CSV?', 'Когда поля могут содержать запятые в кавычках', ['Когда файл заканчивается новой строкой', 'Когда есть только две колонки', 'Когда данные находятся в `/workspace`'], '`cut` не является полноценным CSV-парсером и не понимает кавычки.'),
      lesson('sort-uniq', 'Сортировка и уникальные значения', 'sort_unique', '`sort` упорядочивает строки, `uniq -c` считает соседние повторы. Вместе они дают компактную частотную таблицу.', 'Посчитайте частоту каждой строки в `status.txt`.', 'sort status.txt | uniq -c', ['uniq -c status.txt | rm', 'sort -c status.txt > uniq', 'count status.txt --unique'], 'Что проверяет `sort -n`?', 'Сортирует значения как числа', ['Сортирует только имена файлов', 'Добавляет номера строк', 'Удаляет отрицательные числа'], 'Числовой режим избегает лексикографического порядка вроде 10 перед 2.'),
      lesson('tr', 'Замена отдельных символов', 'translate_chars', '`tr` читает stdin и заменяет или удаляет символы. Он подходит для регистра и простых наборов, но не редактирует файл на месте.', 'Преобразуйте ввод `hello` в верхний регистр.', "printf 'hello\n' | tr '[:lower:]' '[:upper:]'", ["tr hello --upper", "printf 'hello' > tr upper", "sed --uppercase hello"], 'С чем работает `tr`?', 'С потоком на stdin', ['Только с именем каталога', 'Только с PID процесса', 'Только с сетевым интерфейсом'], '`tr` удобно помещать между другими этапами pipeline.'),
      lesson('awk', 'Поля и условия в `awk`', 'awk_fields', '`awk` разбивает строку на поля и применяет правило. Переменные `$1`, `$2` означают поля текущей строки, а не shell-параметры внутри одинарных кавычек.', 'Покажите первый столбец `services.txt`.', "awk '{print $1}' services.txt", ["awk '$0=1' services.txt", 'cut --awk 1 services.txt', 'grep $1 services.txt'], 'Что обозначает `$0` в программе `awk`?', 'Всю текущую строку', ['Код завершения shell', 'Имя текущего пользователя', 'Первый аргумент Bash'], 'Одинарные кавычки защищают `$1` от подстановки shell.'),
    ],
  },
  {
    slug: 'shell-fundamentals', title: 'Основы shell', category: 'bash',
    description: 'Используйте кавычки, подстановки, последовательности и условия так, чтобы команды оставались предсказуемыми.',
    required: 'shell-write-service-config-heredoc', optional: ['shell-assemble-release-notes', 'shell-create-markers-from-service-list'],
    lessons: [
      lesson('quotes', 'Одинарные и двойные кавычки', 'shell_quoting', 'Одинарные кавычки сохраняют текст буквально. Двойные сохраняют пробелы, но разрешают подстановку переменных и команд.', 'Напечатайте буквальный текст `$HOME` без подстановки.', "printf '%s\n' '$HOME'", ["printf '%s\n' \"$HOME\"", 'echo $HOME', 'printenv HOME'], 'Что произойдёт с `$USER` внутри двойных кавычек?', 'Shell подставит значение переменной', ['Текст останется буквальным', 'Переменная будет удалена', 'Запустится команда USER'], 'Кавычки управляют тем, какие преобразования shell выполняет до запуска программы.'),
      lesson('command-substitution', 'Подстановка результата команды', 'command_substitution', 'Конструкция `$(command)` запускает команду и подставляет её stdout. Вложенная форма читается лучше старых обратных кавычек.', 'Сохраните текущий каталог в переменную `HERE`.', 'HERE=$(pwd)', ['HERE=$pwd', 'pwd > $HERE', 'set HERE pwd --run'], 'Что попадает в `$(pwd)`?', 'Стандартный вывод команды `pwd` без завершающих переводов строк', ['Идентификатор процесса, который выполнил команду `pwd`', 'Диагностический поток stderr от команды `pwd`', 'Числовой код завершения выполненной команды `pwd`'], 'Подстановка превращает вывод команды в часть другой shell-строки.'),
      lesson('and-or', 'Условные связки `&&` и `||`', 'conditional_lists', '`cmd1 && cmd2` запускает вторую команду только после успеха первой. `cmd1 || cmd2` запускает вторую после неуспеха.', 'Создайте маркер только если тест каталога прошёл.', 'test -d /workspace && touch ready', ['test -d /workspace || touch ready', 'test -d /workspace | touch ready', 'touch ready && test -f /missing'], 'Чем `&&` отличается от `;`?', '`&&` учитывает код успеха предыдущей команды', ['`&&` запускает команды параллельно', '`&&` перенаправляет stderr', '`&&` создаёт переменную'], 'Связки позволяют строить короткие, явно обусловленные действия.'),
      lesson('scripts-cron', 'Скрипт и расписание', 'script_schedule', 'Скрипт — текстовый файл команд с интерпретатором в shebang. Cron использует отдельное окружение, поэтому пути в заданиях лучше задавать явно.', 'Запустите локальный Bash-скрипт `check.sh` через интерпретатор.', 'bash check.sh', ['./check.sh --without-permission', 'cron check.sh now', 'source /bin/bash check.sh'], 'Какая cron-запись запускает скрипт в 02:30 по будням?', '`30 2 * * 1-5 /opt/backup.sh`', ['`2 30 * * 1-5 /opt/backup.sh`', '`30 2 1-5 * * /opt/backup.sh`', '`weekday 02:30 /opt/backup.sh`'], 'Явный `bash check.sh` не требует execute-бита у самого файла.', 'cron-weekday-backup'),
    ],
  },
  {
    slug: 'environment-path', title: 'Окружение и PATH', category: 'environment',
    description: 'Различайте shell-переменные и environment, находите исполняемые файлы и делайте изменения локальными.',
    required: 'shell-export-selected-environment', optional: ['shell-build-safe-runtime-env', 'packages-record-git-availability'],
    lessons: [
      lesson('variables', 'Shell-переменные', 'shell_variables', 'Присваивание `NAME=value` не содержит пробелов вокруг `=`. Такая переменная принадлежит текущему shell и не обязана быть видна дочерним процессам.', 'Создайте shell-переменную `MODE` со значением `test`.', 'MODE=test', ['MODE = test', 'set MODE == test', 'variable MODE:test'], 'Как безопасно вывести значение переменной `MODE`?', '`printf "%s\n" "$MODE"`', ['`run MODE`', '`cat $MODE/file`', '`MODE --print-all`'], 'Двойные кавычки сохраняют значение одним аргументом даже при пробелах.'),
      lesson('export', 'Переменные окружения', 'environment_variables', '`export` помечает переменную для передачи будущим дочерним процессам. Уже запущенные процессы не получают изменение задним числом.', 'Передайте `MODE=prod` будущим дочерним командам shell.', 'export MODE=prod', ['MODE prod --global', 'env --save MODE prod', 'setenv MODE:prod file'], 'Какая запись задаёт MODE только одной запускаемой команде?', '`MODE=prod ./app`', ['`export MODE=prod`', '`MODE = prod; ./app`', '`./app > MODE=prod`'], 'Префикс `NAME=value command` создаёт локальное окружение только для этой команды.', 'environment-temporary-variable'),
      lesson('path', 'Как shell ищет команды', 'path_lookup', 'Переменная `PATH` содержит список каталогов через двоеточие. Shell ищет исполняемый файл слева направо и не ищет текущий каталог автоматически.', 'Покажите путь, по которому будет запущена команда `bash`.', 'command -v bash', ['find PATH bash --first', 'which --install bash', 'echo bash > PATH'], 'Почему `./tool` может работать, а `tool` — нет?', 'Текущий каталог отсутствует в PATH', ['Файл обязательно принадлежит root', 'Shell не поддерживает скрипты', 'Имя файла слишком короткое'], '`command -v` — встроенный переносимый способ проверить разрешение имени команды.'),
      lesson('safe-path', 'Безопасное изменение PATH', 'path_safety', 'Новый каталог добавляют к существующему PATH, а не заменяют его целиком. Пустые и недоверенные каталоги в начале PATH повышают риск запуска не той программы.', 'Добавьте `$HOME/bin` в конец текущего PATH.', 'export PATH="$PATH:$HOME/bin"', ['export PATH="$HOME/bin"', 'PATH=/tmp:::$PATH', 'chmod +x PATH HOME/bin'], 'Почему опасно ставить общий writable-каталог первым в PATH?', 'Там могут подменить исполняемый файл', ['PATH перестанет содержать двоеточия', 'Все процессы станут zombie', 'Каталог автоматически удалится'], 'Сохранение `$PATH` оставляет доступными базовые системные команды.'),
    ],
  },
  {
    slug: 'links', title: 'Жёсткие и символические ссылки', category: 'filesystem',
    description: 'Понимайте, что именно связывает `ln`, как распознать битую ссылку и безопасно переключать current-release.',
    required: 'filesystem-switch-current-release', optional: ['filesystem-repair-config-symlink', 'filesystem-link-shared-runtime-config'],
    lessons: [
      lesson('symlink', 'Символическая ссылка', 'symbolic_links', 'Символическая ссылка хранит текстовый путь к цели. Она может пересекать файловые системы и становиться битой, если цель исчезла.', 'Создайте ссылку `current` на каталог `releases/v2`.', 'ln -s releases/v2 current', ['ln releases/v2 current --copy', 'cp -s releases/v2 current', 'link current > releases/v2'], 'Что случится со ссылкой после удаления цели?', 'Ссылка останется, но станет битой', ['Ссылка превратится в копию', 'Цель восстановится автоматически', 'Ссылка станет каталогом root'], '`ln -s TARGET LINK` записывает путь TARGET внутрь нового symlink.', 'filesystem-symlink-behavior'),
      lesson('readlink', 'Проверка назначения ссылки', 'readlink', '`ls -l` показывает стрелку, а `readlink` печатает сохранённую цель. `readlink -f` пытается разрешить всю цепочку в абсолютный путь.', 'Покажите сохранённую цель ссылки `current`.', 'readlink current', ['cat --link current', 'stat --target-only current', 'pwd current --resolve-link'], 'Что означает ненулевой код `readlink` для обычного файла?', 'Аргумент не является символической ссылкой', ['Файл обязательно пуст', 'Файл принадлежит другой группе', 'На диске закончились inode'], '`readlink` проверяет сам объект ссылки, не меняя его.'),
      lesson('hard-link', 'Жёсткая ссылка', 'hard_links', 'Жёсткие ссылки — разные имена одного inode. Обычно их нельзя создавать для каталогов и нельзя переносить через границу файловой системы.', 'Создайте жёсткую ссылку `config.copy` на файл `config`.', 'ln config config.copy', ['ln -s config config.copy', 'cp --link-text config config.copy', 'mv config config.copy'], 'Что произойдёт с данными после удаления одного имени жёсткой ссылки?', 'Данные останутся доступны через другое имя', ['Данные немедленно исчезнут', 'Второе имя станет symlink', 'Файл переместится в `/lost+found`'], 'Содержимое живёт, пока на inode остаётся хотя бы одна жёсткая ссылка.'),
      lesson('atomic-switch', 'Атомарное переключение ссылки', 'atomic_symlink', 'Для release-схемы новую ссылку готовят отдельно и затем переименовывают на `current`. Это уменьшает окно, когда потребитель видит промежуточное состояние.', 'Замените symlink `current` ссылкой на `releases/v3` одной командой GNU ln.', 'ln -sfn releases/v3 current', ['cp -r releases/v3 current', 'rm -rf releases/v3 current', 'chmod current releases/v3'], 'Зачем сначала проверять `readlink current`?', 'Чтобы подтвердить ожидаемую цель до изменения', ['Чтобы добавить execute-бит', 'Чтобы перезапустить сеть', 'Чтобы освободить PID'], '`-sfn` заменяет саму ссылку, не копируя каталог релиза.'),
    ],
  },
  {
    slug: 'networking', title: 'Основы сети', category: 'networking',
    description: 'Различайте адрес и порт, проверяйте listeners и тестируйте только локальные endpoints без внешнего Интернета.',
    required: 'networking-verify-local-http-and-save-body', optional: ['networking-start-local-tcp-service', 'networking-fetch-local-status-endpoint'],
    lessons: [
      lesson('addresses', 'IP-адрес и loopback', 'ip_addresses', 'Адрес `127.0.0.1` относится к loopback и доступен только внутри текущего network namespace. `0.0.0.0` в bind означает все локальные интерфейсы.', 'Покажите IPv4-адреса интерфейсов.', 'ip -4 addr show', ['ss -4 addr show', 'route --ip-list', 'curl -4 interfaces'], 'Что означает bind на `127.0.0.1`?', 'Сервис принимает локальные подключения', ['Сервис доступен со всех интерфейсов', 'Сервис отключает TCP', 'Сервис использует только DNS'], 'Команда `ip` читает сетевое состояние и не требует внешнего доступа.'),
      lesson('ports', 'Порты и listeners', 'tcp_listening', 'IP выбирает хост или интерфейс, порт — конкретный сервис. Listener должен быть запущен и привязан к ожидаемому адресу и протоколу.', 'Покажите слушающие TCP-сокеты и процессы.', 'ss -ltnp', ['ps -ltnp', 'ip --listen tcp process', 'curl --ports all'], 'Какая команда показывает listening TCP sockets?', '`ss -ltnp`', ['`df -h`', '`grep TCP /etc/passwd`', '`chmod 8080`'], '`ss -ltnp` объединяет состояние TCP, адреса, порты и сведения о процессах.', 'networking-listen-sockets'),
      lesson('local-http', 'Проверка локального HTTP', 'local_http', 'Для лабораторной достаточно запросить локальный endpoint через `curl`. Код ответа и тело проверяют отдельно, не полагаясь на внешний Интернет.', 'Получите заголовки и тело локального status endpoint.', 'curl -i http://127.0.0.1:8081/status.txt', ['curl -o http://127.0.0.1:8081/status.txt', 'ping http://127.0.0.1:8081', 'ss http://status.txt --get'], 'Что означает `Connection refused` при доступном хосте?', 'На адресе и порту никто не слушает или соединение отклонено', ['DNS всегда сломан', 'HTTP вернул код 404', 'Файл обязательно отсутствует'], '`-i` показывает HTTP-заголовки вместе с телом и помогает видеть код ответа.', 'networking-connection-refused'),
      lesson('diagnosis', 'Порядок сетевой диагностики', 'network_diagnosis', 'Проверяйте последовательно: имя, адрес, маршрут, listener и протокол приложения. Так одна гипотеза не смешивается с другой.', 'Проверьте разрешение имени `localhost` через системную базу.', 'getent hosts localhost', ['grep localhost /proc/ports', 'curl dns://localhost', 'ip resolve --file localhost'], 'Если IP работает, а имя — нет, что проверить первым?', 'Разрешение имени через hosts или DNS', ['Права execute у каталога', 'Свободные inode', 'Версию Bash'], '`getent` использует настроенный системный порядок разрешения имён.', 'troubleshooting-dns-order'),
    ],
  },
  {
    slug: 'packages', title: 'Пакеты и инструменты', category: 'packages',
    description: 'Проверяйте наличие утилит и сведения о пакетах; реальные лаборатории остаются offline и не требуют установки из сети.',
    required: 'packages-audit-findutils', optional: ['packages-audit-grep-runtime', 'packages-audit-archive-toolchain'],
    lessons: [
      lesson('command-exists', 'Проверка наличия команды', 'command_presence', '`command -v` сообщает, сможет ли shell разрешить имя команды. Это надёжнее попытки угадать путь вроде `/usr/bin/tool`.', 'Проверьте, доступна ли команда `curl`.', 'command -v curl', ['find / -install curl', 'apt run curl --check', 'which --download curl'], 'Как интерпретировать успешный код `command -v curl`?', 'Shell нашёл команду по своим правилам', ['Пакет только что обновлён из сети', 'curl уже подключился к серверу', 'Команда запущена от root'], '`command -v` ничего не устанавливает и подходит для offline-проверки.'),
      lesson('package-owner', 'Какой пакет поставил файл', 'package_ownership', 'На Debian/Ubuntu `dpkg -S` ищет пакет-владельца установленного пути, а `dpkg -L` перечисляет файлы установленного пакета.', 'Найдите пакет-владелец файла `/bin/ls`.', 'dpkg -S /bin/ls', ['apt install /bin/ls', 'dpkg -L /bin/ls --owner', 'ls --package /bin/ls'], 'Что ожидает `dpkg -L coreutils`?', 'Имя установленного пакета', ['PID процесса', 'URL репозитория', 'Имя systemd unit'], 'Запрос локальной базе пакетов не требует сетевого доступа.'),
      lesson('package-info', 'Информация об установленном пакете', 'package_info', '`dpkg-query -W` показывает статус и версию пакета из локальной базы. Это безопасная диагностическая проверка.', 'Покажите статус и версию пакета `bash`.', 'dpkg-query -W bash', ['bash --apt-install', 'dpkg -S bash --version-file', 'apt network-status bash'], 'Что означает статус `ii` в `dpkg -l`?', 'Пакет выбран и установлен', ['Пакет только доступен в сети', 'Пакет заблокировал порт', 'Пакет является каталогом'], '`dpkg-query` не обновляет индекс и не меняет систему.'),
      lesson('apt-index', 'Индекс репозитория и установка', 'apt_package_index', '`apt update` обновляет локальный индекс доступных версий, а `apt install` меняет систему. В CLIRace labs установка из Интернета не требуется.', 'Покажите сведения о пакете из локального apt-кэша.', 'apt-cache policy bash', ['apt install bash --internet', 'dpkg --delete bash', 'curl packages/bash | sh'], 'Что сделать после добавления нового apt-источника перед поиском пакета?', 'Обновить индекс через `apt update`', ['Удалить `/bin/bash`', 'Перезаписать PATH', 'Остановить loopback'], '`apt-cache policy` читает имеющийся индекс, не устанавливая пакет.', 'packages-refresh-index'),
    ],
  },
  {
    slug: 'troubleshooting', title: 'Системная диагностика', category: 'troubleshooting',
    description: 'Собирайте факты от симптома к причине, проверяйте ресурсы, процессы, логи и конфигурацию без случайных исправлений.',
    required: 'troubleshooting-identify-failed-services', optional: ['troubleshooting-stop-worker-clear-lock', 'troubleshooting-repair-current-release'],
    lessons: [
      lesson('symptom', 'Начните с воспроизводимого симптома', 'diagnostic_symptom', 'Зафиксируйте точную команду, время, код и текст ошибки. Сначала подтвердите симптом, затем меняйте только одну гипотезу за шаг.', 'Выполните локальный запрос и сохраните подробную ошибку curl.', 'curl -v http://127.0.0.1:8081/status.txt', ['curl -s http://127.0.0.1:8081/status.txt', 'rm -rf /var/log', 'chmod -R 777 /workspace'], 'Какие первые проверки разумны для недоступного сервиса?', 'Статус процесса и свежие логи', ['Переустановка всей ОС', 'Удаление всех конфигов', 'Случайная смена прав'], 'Флаг `-v` показывает этап соединения и отделяет transport-проблему от HTTP-ответа.', 'troubleshooting-service-first-checks'),
      lesson('resources', 'Диск, inode и память', 'resource_checks', 'Ресурсные ошибки проверяют измерениями: `df -h` для блоков, `df -i` для inode, `free -h` для памяти. Свободные байты не гарантируют свободные inode.', 'Покажите использование inode смонтированных файловых систем.', 'df -i', ['du -i --memory', 'free --inodes', 'stat / --network'], 'Почему файл не создаётся при свободном месте по `df -h`?', 'Могли закончиться inode', ['Shell потерял prompt', 'TCP-порт занят', 'PATH содержит `/usr/bin`'], '`df -i` проверяет отдельный конечный ресурс — количество файловых записей.', 'storage-inodes-full'),
      lesson('service-state', 'Состояние сервиса и журнал', 'service_state', 'На системе с systemd сначала смотрят `systemctl status`, затем узкий журнал unit. В sandbox systemd может отсутствовать, поэтому labs используют обычные процессы.', 'Покажите состояние `nginx.service` без pager.', 'systemctl --no-pager status nginx.service', ['service --delete nginx', 'journalctl --install nginx', 'ps --enable nginx.service'], 'Как включить unit и сразу запустить его на systemd-хосте?', '`systemctl enable --now unit.service`', ['`systemctl start --disable unit.service`', '`journalctl -f unit.service`', '`chmod +x unit.service`'], '`status` объединяет состояние unit и последние диагностические строки.', 'systemd-enable-versus-start'),
      lesson('evidence-fix', 'Проверьте гипотезу и исправление', 'verify_fix', 'Перед исправлением сохраните evidence, затем внесите минимальное изменение и повторите исходную проверку. Успех — исчезновение симптома, а не отсутствие сообщения в терминале.', 'Покажите последние 30 записей systemd unit `api.service`.', 'journalctl -u api.service -n 30 --no-pager', ['systemctl erase api.service logs', 'cat -u api.service -n 30', 'ps --journal api.service'], 'Как посмотреть состояние nginx вместе с последними сообщениями?', '`systemctl status nginx.service`', ['`systemctl delete nginx.service`', '`journalctl --clear nginx`', '`chmod status nginx.service`'], 'Узкий журнал сохраняет контекст и уменьшает шум при проверке гипотезы.', 'systemd-view-status'),
    ],
  },
];

// Additional modules are appended below to keep this authoring source reviewable.

const existingQuestionSlugs = new Set(modules.flatMap((module) => module.lessons.map((entry) => entry.existing).filter(Boolean)));

const answerIds = ['a', 'b', 'c', 'd'];
const normalizeOptions = (seed, values) => {
  const offset = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
};

function question(slug, category, concept, prompt, correct, wrong, explanation, difficulty = 'easy') {
  const options = normalizeOptions(slug, [correct, ...wrong]);
  const correctId = answerIds[options.indexOf(correct)];
  return {
    slug, category, concept, difficulty, type: 'single_choice', question: prompt,
    answers: options.map((text, index) => ({ id: answerIds[index], text })),
    correctAnswerIds: [correctId], explanation,
    answerExplanations: Object.fromEntries(options.map((text, index) => [answerIds[index], text === correct
      ? explanation
      : `Вариант «${text}» не выполняет требуемое действие в описанном контексте.`])),
    enabled: true, version: 1,
  };
}

function buildQuestionBank() {
  const questions = [];
  for (const module of modules) {
    module.lessons.forEach((entry, lessonIndex) => {
      entry.commandSlug = `zto-${module.slug}-${entry.slug}-command`;
      questions.push(question(entry.commandSlug, module.category, entry.concept,
        `Урок «${entry.title}»: ${entry.action} Какую команду нужно выполнить?`, entry.command, entry.wrongCommands,
        `${entry.note} Ожидаемый результат: ${entry.action.toLocaleLowerCase('ru-RU')}`));
      entry.checkSlug = entry.existing ?? `zto-${module.slug}-${entry.slug}-concept`;
      if (!entry.existing) questions.push(question(entry.checkSlug, module.category, entry.concept,
        entry.checkQuestion, entry.checkAnswer, entry.checkWrong, `${entry.note} ${entry.checkAnswer} — корректный вывод для этой ситуации.`));
      if (lessonIndex < 3) {
        entry.checkpointSlug = `zto-${module.slug}-checkpoint-${lessonIndex + 1}`;
        questions.push(question(entry.checkpointSlug, module.category, `${entry.concept}_checkpoint`,
          `Контрольная ситуация модуля «${module.title}»: ${entry.action} Какой вариант применим?`, entry.command, entry.wrongCommands,
          `${entry.note} В этой контрольной ситуации подходит команда: ${entry.command}.`, module.category === 'troubleshooting' ? 'medium' : 'easy'));
      }
    });
  }
  return questions;
}

function theoryContent(entry) {
  return [
    { type: 'heading', text: entry.title },
    { type: 'paragraph', text: entry.intro },
    { type: 'code', language: 'bash', code: entry.command },
    { type: 'bullets', items: [`Задача: ${entry.action}`, `Результат: ${entry.note}`] },
    { type: 'note', tone: 'note', text: `Попробуйте сначала прочитать команду слева направо: ${entry.note}` },
  ];
}

function buildModule(module, order) {
  const items = [];
  module.lessons.forEach((entry, index) => {
    items.push({
      id: `zto-${module.slug}-${entry.slug}-lesson`, slug: entry.slug, title: entry.title, type: 'theory',
      order: index * 2 + 1, category: module.category, concept: entry.concept, version: 1,
      content: theoryContent(entry), completion: { explicitContinue: true },
    });
    items.push({
      id: `zto-${module.slug}-${entry.slug}-quiz`, slug: `${entry.slug}-quiz`, title: `Проверьте себя: ${entry.title}`,
      type: 'knowledge_check', order: index * 2 + 2, category: module.category, concept: entry.concept, version: 1,
      questionSlugs: [entry.commandSlug, entry.checkSlug], completion: { passThreshold: 50 },
    });
  });
  items.push({
    id: `zto-${module.slug}-optional-practice`, slug: 'optional-practice', title: 'Ещё две быстрые задачи', type: 'practice',
    order: 9, category: module.category, concept: `${module.slug.replaceAll('-', '_')}_optional`, version: 1,
    challengeSlugs: module.optional, completion: { requireAll: true, optional: true },
  });
  items.push({
    id: `zto-${module.slug}-required-lab`, slug: 'required-lab', title: 'Практический checkpoint в shell', type: 'shell_lab',
    order: 10, category: module.category, concept: `${module.slug.replaceAll('-', '_')}_practice`, version: 1,
    challengeSlugs: [module.required], completion: { requireAll: true },
  });
  items.push({
    id: `zto-${module.slug}-checkpoint`, slug: 'checkpoint', title: `Checkpoint: ${module.title}`, type: 'checkpoint',
    order: 11, category: module.category, concept: `${module.slug.replaceAll('-', '_')}_checkpoint`, version: 1,
    questionSlugs: module.lessons.slice(0, 3).map((entry) => entry.checkpointSlug), completion: { passThreshold: 67 },
  });
  return {
    slug: module.slug, title: module.title, description: module.description, order,
    prerequisites: order === 1 ? [] : [modules[order - 2].slug], estimatedMinutes: 35, version: 1,
    completion: { allItemsRequired: true }, items,
  };
}

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
async function emit(relative, value) {
  const target = resolve(root, relative);
  const output = json(value);
  if (checkOnly) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== output) throw new Error(`Generated content is stale: ${relative}`);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, output, 'utf8');
}

const questions = buildQuestionBank();
const questionReferences = modules.flatMap((module) => module.lessons.flatMap((entry) => [entry.commandSlug, entry.checkSlug]).concat(module.lessons.slice(0, 3).map((entry) => entry.checkpointSlug)));
if (modules.length !== 17) throw new Error(`Expected 17 modules, received ${modules.length}`);
if (modules.some((module) => module.lessons.length !== 4)) throw new Error('Each module must contain exactly four short lessons.');
if (questions.length !== 162 || existingQuestionSlugs.size !== 25 || questionReferences.length !== 187 || new Set(questionReferences).size !== 187) {
  throw new Error(`Unexpected question totals: generated=${questions.length}, reused=${existingQuestionSlugs.size}, refs=${questionReferences.length}`);
}

const filenames = modules.map((module, index) => `${String(index + 1).padStart(2, '0')}-${module.slug}.json`);
await emit('content/linux-core/zero-to-operator.json', questions);
await emit('content/learning-paths/linux-zero-to-operator/course.json', {
  slug: 'linux-zero-to-operator', title: 'Linux с нуля: Zero to Operator',
  description: 'Главный курс CLIRace для новичка: 68 коротких уроков, понятные проверки и настоящая практика в безопасном Linux shell — от первой команды до диагностики сервиса.',
  version: 1, enabled: true, order: 0, estimatedMinutes: 595, level: 'beginner', canonicalChallengeLibrary: 2,
  prerequisites: [], modules: filenames,
});
for (let index = 0; index < modules.length; index += 1) {
  await emit(`content/learning-paths/linux-zero-to-operator/modules/${filenames[index]}`, buildModule(modules[index], index + 1));
}

console.log(JSON.stringify({ ok: true, mode: checkOnly ? 'check' : 'write', modules: modules.length, lessons: modules.length * 4,
  generatedQuestions: questions.length, reusedQuestions: existingQuestionSlugs.size, totalQuestions: questionReferences.length,
  requiredPractice: modules.length, optionalPractice: modules.length * 2 }, null, 2));

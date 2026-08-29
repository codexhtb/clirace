import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');

const L = (slug, title, concept, intro, action, command, wrong, checkQuestion, checkAnswer, checkWrong, note, existing) => ({
  slug, title, concept, intro, action, command, wrong, checkQuestion, checkAnswer, checkWrong, note, existing,
});

const modules = [
  {
    slug: 'system-inspection', title: 'System Inspection', category: 'processes',
    description: 'Собирайте краткий паспорт Linux-системы: identity, версия, uptime, CPU, память, load и процессы.',
    required: 'packages-verify-procps-process-tools',
    optional: ['packages-verify-coreutils-toolkit', 'process-reconcile-runtime-state', 'troubleshooting-audit-required-toolchain'],
    lessons: [
      L('identity', 'Паспорт системы и identity', 'system_identity', 'Оператор сначала фиксирует hostname, kernel, время и эффективную identity. Эти данные задают контекст для любой дальнейшей диагностики.', 'Соберите hostname, версию kernel и текущую identity одной последовательностью.', 'hostname; uname -sr; whoami; id', ['hostname --fix', 'cat /etc/shadow', 'sudo uname -r'], 'Почему одного `whoami` недостаточно для проверки доступа?', '`id` дополнительно показывает UID, основной GID и группы', ['`whoami` уже показывает свободную память', '`id` меняет пользователя', '`whoami` показывает все capabilities'], '`id` раскрывает группы, которые часто объясняют доступ к файлам и каталогам.', 'users-effective-groups'),
      L('uptime-load', 'Uptime и load без паники', 'system_load', 'Load average показывает число выполняемых и ожидающих CPU или непрерываемый I/O задач за интервалы 1, 5 и 15 минут. Его сравнивают с числом CPU и другими evidence.', 'Покажите uptime и load average.', 'uptime', ['load --now', 'ps --uptime-only', 'free --load'], 'Load 4 всегда означает аварию?', 'Нет, его нужно сопоставить с CPU count, I/O и динамикой', ['Да, любое значение выше 1 аварийно', 'Нет, load относится только к памяти', 'Да, load всегда равен числу процессов'], 'Одно число load без CPU count и временной динамики не доказывает проблему.'),
      L('cpu-memory', 'CPU и память', 'cpu_memory_inspection', '`lscpu` описывает процессоры, а `free -h` суммирует память. Поле available обычно полезнее, чем буквальное free: Linux использует RAM под cache.', 'Покажите число CPU и доступную память.', "printf 'CPU='; nproc; free -h", ['df -h; free --disk', 'ps --memory-device', 'cat /proc/loadavg --free'], 'Почему маленькое значение `free` не обязательно означает нехватку RAM?', 'Часть памяти занята освобождаемым cache, поэтому смотрят available', ['Kernel запрещает освобождать cache', 'free показывает только swap', 'RAM измеряется через df'], '`free -h` отделяет available memory от буквально неиспользуемых страниц.'),
      L('proc-overview', '`/proc` и обзор процессов', 'proc_runtime', '`/proc` — виртуальная filesystem с runtime-данными kernel и процессов. Файлы `/proc/cpuinfo`, `/proc/meminfo` и каталоги `/proc/PID` не являются обычным архивом на диске.', 'Покажите краткий список процессов и первые строки `/proc/meminfo`.', "ps -eo pid,ppid,state,comm --sort=pid | head; head -n 5 /proc/meminfo", ['find /proc -delete', 'cat /proc --recursive', 'ps --write-kernel'], 'Что означает состояние `Z` в `ps`?', 'Процесс завершён, но родитель ещё не забрал его status', ['Процесс использует весь CPU', 'Процесс остановлен firewall', 'Процесс всегда работает в background'], '`ps` и `/proc` дают разные представления одного runtime-состояния.', 'processes-zombie-state'),
    ],
  },
  {
    slug: 'storage-disk-usage', title: 'Storage и Disk Usage', category: 'storage',
    description: 'Исследуйте заполнение filesystem от общего capacity до конкретных каталогов и файлов, не выходя за workspace.',
    required: 'text-list-large-cache-files',
    optional: ['filesystem-clean-temporary-artifacts', 'filesystem-clean-build-preserve-source', 'text-select-latest-successful-backup'],
    lessons: [
      L('capacity', 'Сначала filesystem capacity', 'filesystem_capacity', '`df` отвечает о смонтированных filesystem, а не о размере отдельного каталога. Начните с `df -h`, чтобы найти заполненный mount point.', 'Покажите занятое и свободное место всех filesystem.', 'df -h', ['du -h /', 'free -h --disk', 'stat --mounts'], 'Какая команда первой показывает заполненный mounted filesystem?', '`df -h`', ['`du -sh .`', '`ls -lh`', '`free -h`'], '`df -h` измеряет capacity на уровне filesystem.', 'storage-free-filesystems'),
      L('directory-size', 'От mount point к каталогу', 'directory_size', '`du` суммирует реально занятое место по дереву. Ограничивайте глубину и сортируйте human-readable размеры через `sort -h`.', 'Найдите крупнейшие каталоги первого уровня в `/workspace`.', 'du -h --max-depth=1 /workspace | sort -h', ['df -h /workspace/* | sort', 'ls -h --capacity /workspace', 'free -h /workspace'], 'Почему `du -sh /workspace` недостаточно для поиска причины?', 'Он даёт только итог и не показывает вклад подкаталогов', ['Он удаляет большие файлы', 'Он измеряет только inode', 'Он требует сети'], 'Переход от общего размера к подкаталогам локализует источник заполнения.'),
      L('large-files', 'Крупные файлы и безопасная выборка', 'large_file_search', '`find` с `-type f` и `-size` находит кандидатов, но удалять их автоматически опасно. Сначала выведите размер, путь и назначение.', 'Покажите файлы крупнее 10 MiB внутри workspace.', "find /workspace -type f -size +10M -printf '%s %p\n' | sort -n", ['find / -delete -size +10M', 'du --remove-large /workspace', 'rm -rf /workspace/*'], 'Что делать после обнаружения крупного файла?', 'Проверить назначение и только затем принять точечное решение', ['Сразу удалить все результаты find', 'Запустить chmod 777', 'Перезапустить kernel'], 'Размер — evidence, но не доказательство, что данные ненужны.'),
      L('verify-cleanup', 'Cleanup и повторная проверка', 'disk_cleanup_verify', 'Исправление disk pressure должно сохранять нужные artifacts. После точечного cleanup повторите исходные `du` и `df`, чтобы проверить эффект.', 'Сравните размер workspace до и после выбранного действия.', 'du -sh /workspace; df -h /workspace', ['rm -rf /workspace; df', 'mkfs /workspace', 'mount --cleanup /workspace'], 'Почему после удаления файла место может освободиться не сразу?', 'Удалённый файл может оставаться открытым процессом', ['df обновляется только после reboot', 'Права файла блокируют df', 'Shell хранит копию в PATH'], 'Минимальное изменение и повторное измерение замыкают diagnostic loop.', 'storage-inodes-full'),
    ],
  },
  {
    slug: 'metadata-archives', title: 'Files, Metadata и Archives', category: 'filesystem',
    description: 'Читайте метаданные и уверенно создавайте, проверяйте и распаковывайте tar-архивы внутри workspace.',
    required: 'packages-audit-archive-toolchain',
    optional: ['filesystem-backup-service-manifest', 'filesystem-organize-service-logs', 'filesystem-rehome-database-backup'],
    lessons: [
      L('stat-file', '`stat`, `file` и timestamps', 'metadata_inspection', '`stat` показывает mode, owner, size и timestamps; `file` определяет формат по содержимому. Это разные вопросы к одному path.', 'Покажите metadata и предполагаемый тип `artifact.bin`.', 'stat artifact.bin; file artifact.bin', ['cat --metadata artifact.bin', 'ls --format-content artifact.bin', 'chmod --inspect artifact.bin'], 'Как отличить тип содержимого от расширения имени?', 'Использовать `file`, который анализирует сигнатуру содержимого', ['Использовать только basename', 'Поменять mode через chmod', 'Прочитать PATH'], '`stat` описывает inode metadata, а `file` — вероятный формат.'),
      L('archive-compression', 'Archive и compression — не одно и то же', 'archive_compression', '`tar` объединяет множество paths в один stream; gzip сжимает поток. Суффикс `.tar.gz` отражает два отдельных действия.', 'Создайте gzip-сжатый архив каталога `logs`.', 'tar -czf logs.tar.gz logs/', ['gzip -r logs/ > logs.tar', 'tar -xf logs.tar.gz logs/', 'zip --tar logs/'], 'Что добавляет флаг `-z` к созданию tar?', 'Пропускает tar-stream через gzip', ['Удаляет исходники', 'Шифрует архив', 'Меняет владельца файлов'], 'Архивация сохраняет структуру, compression уменьшает представление данных.'),
      L('inspect-extract', 'Проверьте архив до распаковки', 'archive_inspection', 'Перед extraction посмотрите список через `tar -tf`. Распаковывайте в заранее выбранный каталог, чтобы не смешивать файлы с текущей рабочей областью.', 'Просмотрите архив и распакуйте его в `/workspace/restore`.', 'tar -tf logs.tar.gz; mkdir -p /workspace/restore; tar -xzf logs.tar.gz -C /workspace/restore', ['tar -xzf logs.tar.gz -C /', 'cat logs.tar.gz > /workspace/restore', 'rm logs.tar.gz --extract'], 'Зачем выполнять `tar -tf` до extraction?', 'Чтобы увидеть paths и оценить ожидаемое размещение', ['Чтобы изменить compression', 'Чтобы запустить файлы внутри', 'Чтобы выдать всем mode 777'], 'Предварительный список защищает от неожиданной структуры архива.'),
      L('preserve-verify', 'Проверка backup artifact', 'archive_verification', 'Архив считается полезным только после проверки списка и test extraction. Не удаляйте исходники лишь потому, что команда создания завершилась с code 0.', 'Проверьте, что архив читается, не распаковывая его поверх данных.', 'tar -tzf logs.tar.gz >/dev/null && echo archive-ok', ['rm -rf logs && echo archive-ok', 'chmod 777 logs.tar.gz', 'tar -czf logs.tar.gz logs.tar.gz'], 'Что произойдёт с symlink, если удалить его target?', 'Ссылка сохранится, но станет broken', ['Ссылка автоматически получит копию файла', 'Kernel запретит удаление target', 'Ссылка превратится в каталог'], 'Проверка artifact и понимание ссылок уменьшают риск ложного backup.', 'filesystem-symlink-behavior'),
    ],
  },
  {
    slug: 'shell-control', title: 'Shell Control и Exit Logic', category: 'bash',
    description: 'Управляйте последовательностью команд через exit status, условные связки, grouping и command substitution.',
    required: 'shell-capture-command-streams',
    optional: ['shell-append-deployment-audit', 'shell-merge-config-fragments', 'shell-write-service-config-heredoc'],
    lessons: [
      L('exit-code', 'Exit status как контракт', 'exit_status_contract', 'Automation принимает решения по exit code. Ноль означает успех по соглашению, а ненулевые значения требуют интерпретации конкретной команды.', 'Запустите проверку и сразу сохраните её exit code.', 'test -f /workspace/app.conf; status=$?; echo "$status"', ['test -f /workspace/app.conf; echo $$', 'echo $?; test -f /workspace/app.conf', 'status=test -f app.conf'], 'Как сразу после команды вывести её status?', '`echo $?`', ['`echo $$`', '`echo $!`', '`echo $#`'], 'Следующая команда перезаписывает `$?`, поэтому значение читают сразу.', 'bash-exit-status'),
      L('and-or', '`&&` и `||` в сценариях', 'conditional_lists', '`A && B` запускает B только после успеха A; `A || B` — только после неуспеха A. Это управление потоком, а не текстовые синонимы AND/OR.', 'Напечатайте `ready` только если config существует.', 'test -f app.conf && echo ready', ['test -f app.conf || echo ready', 'test -f app.conf; false; echo ready', 'echo ready && test -f app.conf'], 'Запустится ли правая команда после exit code 1 через `&&`?', 'Нет, shell пропустит её', ['Да, всегда', 'Только от root', 'Только в subshell'], 'Условные списки опираются на status команды слева.'),
      L('sequence-group', 'Последовательность и grouping', 'shell_grouping', '`;` разделяет команды без условия. Скобки `( ... )` выполняют группу в subshell, а `{ ...; }` — в текущем shell.', 'Измените каталог только внутри subshell и проверьте исходный `pwd`.', '(cd /tmp && pwd); pwd', ['cd /tmp && pwd && pwd', '{ cd /tmp }; pwd', 'pwd --subshell /tmp'], 'Почему `cd` внутри `( ... )` не меняет каталог родительского shell?', 'Группа выполняется в отдельном subshell process', ['`cd` запрещён в скобках', '`pwd` возвращает каталог обратно', 'Kernel отменяет команду'], 'Subshell изолирует изменения shell state.'),
      L('substitution', 'Command substitution без потери кавычек', 'command_substitution', '`$(command)` подставляет stdout команды. Результат обычно заключают в двойные кавычки, чтобы пробелы не превратились в новые аргументы.', 'Сохраните текущий timestamp в переменную и выведите его.', 'stamp="$(date -u +%FT%TZ)"; printf "%s\n" "$stamp"', ['stamp=$(date -u) unquoted words', 'stamp=$? date', 'date > $stamp'], 'Почему `"$(command)"` безопаснее без кавычек?', 'Кавычки сохраняют результат одним аргументом', ['Кавычки запускают command от root', 'Они меняют exit code на 0', 'Они включают network'], 'Command substitution переносит stdout, но кавычки управляют последующим word splitting.'),
    ],
  },
  {
    slug: 'job-control', title: 'Job Control и Long-running Processes', category: 'processes',
    description: 'Различайте terminal job и process, управляйте foreground/background и выбирайте корректные сигналы.',
    required: 'process-start-worker-write-marker',
    optional: ['process-start-idle-worker', 'process-stop-worker-preserve-evidence', 'process-clean-stale-pid-after-stop'],
    lessons: [
      L('foreground-background', 'Foreground, background и `&`', 'foreground_background', 'Foreground job владеет terminal input. Суффикс `&` запускает pipeline в background текущего shell и сразу возвращает prompt.', 'Запустите короткий sleep в background и покажите его PID.', 'sleep 30 & echo $!', ['sleep 30; echo $!', 'sleep --daemon 30', 'bg sleep 30 --pid'], 'Что хранит `$!` после background-запуска?', 'PID последнего background pipeline', ['Exit code последней команды', 'PID текущего shell', 'Номер текущего пользователя'], '`&` меняет terminal scheduling, но не превращает процесс в system service.'),
      L('jobs-fg-bg', '`jobs`, `fg` и `bg`', 'job_table', 'Shell ведёт собственную job table. `jobs -l` связывает job number и PID; `fg` возвращает job на foreground, `bg` продолжает остановленную job в background.', 'Покажите jobs текущего shell вместе с PID.', 'jobs -l', ['ps --jobs-only', 'fg --list-all', 'jobs /proc'], 'Почему jobs из другого SSH-сеанса не видны?', 'Job table принадлежит конкретному shell', ['Jobs хранятся только в DNS', 'Другой сеанс всегда root', 'PID существуют только в prompt'], 'Job control — состояние shell, process table — состояние kernel.'),
      L('signals', 'INT, TERM и KILL', 'signal_choice', '`Ctrl+C` обычно отправляет INT foreground job. Для управляемой остановки сначала используют TERM; KILL оставляют для процесса, который не реагирует.', 'Отправьте процессу из `worker.pid` сигнал TERM.', 'kill -TERM "$(cat worker.pid)"', ['kill -KILL 1', 'rm worker.pid', 'chmod 000 worker.pid'], 'Какой сигнал `kill PID` отправляет по умолчанию?', 'TERM', ['KILL', 'STOP', 'HUP всегда'], 'TERM даёт процессу шанс очистить ресурсы и записать состояние.', 'signals-graceful-stop'),
      L('lifetime-nohup', 'Lifetime процесса и `nohup`', 'process_lifetime', 'Background job всё ещё связан с shell lifecycle. `nohup` игнорирует HUP и перенаправляет output, но не даёт supervision, restart policy или readiness.', 'Запустите worker с `nohup` и явным логом.', 'nohup ./worker.sh >worker.log 2>&1 & echo $!', ['nohup ./worker.sh &> /dev/null; disown all evidence', 'systemctl start worker.sh', 'sudo daemonize ./worker.sh'], 'Чего `nohup` не обеспечивает?', 'Автоматического restart и контроля readiness', ['Игнорирования HUP', 'Background-запуска с `&`', 'Перенаправления output'], 'Для production service нужен supervisor; в sandbox изучается только process lifetime.'),
    ],
  },
  {
    slug: 'bash-scripting', title: 'Bash Scripting Basics', category: 'bash',
    description: 'Пишите короткие предсказуемые Bash-скрипты с аргументами, условиями, циклами, functions и аккуратными кавычками.',
    required: 'shell-create-markers-from-service-list',
    optional: ['shell-build-unique-user-pipeline', 'shell-sum-worker-durations', 'shell-build-safe-runtime-env'],
    lessons: [
      L('script-contract', 'Shebang, аргументы и exit codes', 'script_contract', 'Shebang выбирает interpreter. Проверяйте `$#`, читайте `$1` в кавычках и возвращайте ненулевой code при неверном использовании.', 'Создайте проверку обязательного первого аргумента.', 'if [ "$#" -lt 1 ]; then echo "usage: $0 DIR" >&2; exit 2; fi', ['if $1 empty then exit', 'test $# > 1', 'sudo require-args'], 'Что содержит `$@` в двойных кавычках?', 'Все positional arguments с сохранением их границ', ['Только первый аргумент', 'Exit codes всех команд', 'Все environment variables'], 'Явный contract делает ошибку вызова отличимой от ошибки обработки.'),
      L('variables-quoting', 'Variables и quoting', 'bash_quoting', 'Незакавыченная переменная проходит word splitting и glob expansion. Для paths и пользовательских arguments почти всегда используйте `"$value"`.', 'Безопасно проверьте, является ли argument каталогом.', 'dir=${1:-}; [ -n "$dir" ] && [ -d "$dir" ]', ['[ -d $1 ] always-safe', 'dir=$1/*', 'test directory $@'], 'Как передать MODE только одной запускаемой команде?', '`MODE=check command`', ['`export MODE=check` обязательно навсегда', '`command --PATH MODE`', '`MODE == check`'], 'Локальное присваивание перед command не меняет environment текущего shell.', 'environment-temporary-variable'),
      L('if-test', '`if`, `test` и проверяемые ветви', 'bash_conditions', '`[` — команда `test`, поэтому пробелы обязательны. Условие `if` оценивает exit status команды, а не требует специального boolean типа.', 'Выведите сообщение, если report существует и непуст.', 'if [ -s report.txt ]; then echo ready; else echo missing; fi', ['if [-s report.txt] echo ready', 'if report.txt size then ready', 'test -s report.txt && exit always'], 'Что проверяет `-s file`?', 'Файл существует и имеет размер больше нуля', ['Файл является symlink', 'Файл доступен по сети', 'Файл принадлежит shell'], 'Condition можно тестировать отдельно как обычную command.'),
      L('loops-functions', 'Loops и маленькие functions', 'bash_loops_functions', 'Function скрывает повторяемое действие, а `for item in "$@"` безопасно обходит аргументы. Сценарий должен создавать проверяемый final state.', 'Создайте ready-marker для каждого переданного service.', 'for service in "$@"; do printf "ready\n" > "${service}.ready"; done', ['for service in $*; touch $service.ready', 'while true; rm -rf *', 'xargs sudo service start'], 'Почему `"$@"` предпочтительнее `$*`?', 'Он сохраняет каждый argument отдельным значением', ['Он сортирует аргументы', 'Он включает strict mode', 'Он запускает loop параллельно'], 'Checker оценивает итоговые marker files, а не единственный текст скрипта.'),
    ],
  },
  {
    slug: 'shared-access', title: 'Permissions и Shared Access', category: 'permissions',
    description: 'Настраивайте совместную работу через groups, umask и directory semantics вместо небезопасного chmod 777.',
    required: 'users-secure-shared-release-team',
    optional: ['permissions-team-runbook-scripts', 'permissions-traverse-config-directory', 'users-repair-worker-membership'],
    lessons: [
      L('umask', '`umask` как политика создания', 'umask_policy', '`umask` убирает права из базового mode новых объектов. Он не изменяет существующие paths и не является окончательной ACL policy.', 'Покажите текущий umask и временно установите групповой 002.', 'umask; umask 0002', ['chmod 0002 /workspace', 'umask 0777', 'chown umask:group .'], 'Как новый umask влияет на уже существующий файл?', 'Никак, он применяется только при последующем создании', ['Немедленно меняет mode всех файлов', 'Меняет owner', 'Удаляет ACL'], '`umask 0002` обычно сохраняет group write для новых team artifacts.'),
      L('directory-access', 'Read, write и execute у каталога', 'directory_access', 'Для каталога read перечисляет имена, write меняет entries, execute разрешает traversal. Рабочая group должна получать только необходимые комбинации.', 'Покажите numeric mode и owner общего каталога.', "stat -c '%a %U %G' /workspace/shared", ['cat /workspace/shared --permissions', 'ls --chmod shared', 'id --directory shared'], 'Что означает execute для каталога?', 'Возможность проходить к entries по известному имени', ['Возможность запустить сам каталог', 'Автоматическую запись во все файлы', 'Сетевой доступ'], 'Без execute пользователь не сможет открыть child path даже при известном имени.', 'permissions-directory-execute'),
      L('setgid-sticky', 'setgid directory и sticky bit', 'special_directory_modes', 'setgid на каталоге наследует group для новых entries. Sticky bit ограничивает удаление чужих entries в общем writable-каталоге.', 'Установите setgid и group-write для командного каталога.', 'chmod 2770 /workspace/shared', ['chmod 777 /workspace/shared', 'chmod u+s /workspace/shared', 'chown -R root:root /workspace/shared'], 'Какой эффект даёт ведущая цифра 2 для каталога?', 'Новые entries наследуют group каталога', ['Все файлы становятся SUID', 'Каталог очищается при logout', 'Запрещается traversal'], 'setgid решает наследование group без world-write.'),
      L('shared-workflow', 'Shared access без `777`', 'shared_access_workflow', 'Правильный workflow: определить identities, создать group, назначить group ownership, выбрать mode и проверить доступ от нужных users.', 'Покажите owner/group/mode и membership текущего пользователя.', "stat -c '%U:%G %a' /workspace/shared; id", ['chmod -R 777 /workspace/shared', 'kill -9 users', 'sudo chown nobody /'], 'Какие права задаёт mode 750?', 'Owner rwx, group r-x, others ---', ['Всем rwx', 'Owner rw-, group r--, others ---', 'Owner r-x, group rwx, others ---'], 'Mode и membership проверяются вместе; один chmod не создаёт модель доступа.', 'permissions-mode-750'),
    ],
  },
  {
    slug: 'logs-incidents', title: 'Logs и Incident Investigation', category: 'logs',
    description: 'Сужайте deterministic logs по времени, severity, request и повторяемости, сохраняя evidence и итоговый report.',
    required: 'text-compose-incident-summary',
    optional: ['text-collect-error-lines', 'text-summarize-response-statuses', 'text-count-failed-logins'],
    lessons: [
      L('scope-tail', 'Начните с узкого временного окна', 'log_scope', 'Не читайте весь log сверху. Сначала выберите нужный файл, последние строки и момент симптома через `tail`, timestamps и request ID.', 'Покажите последние 50 строк application log.', 'tail -n 50 /workspace/logs/app.log', ['cat /workspace/logs/* forever', 'rm /workspace/logs/app.log', 'journalctl --all-hosts'], 'Почему tail полезнее полного cat при свежем incident?', 'Он быстро ограничивает вывод последними событиями', ['Он исправляет ошибки', 'Он удаляет старые строки', 'Он меняет timestamps'], 'Узкое окно снижает шум до появления первой гипотезы.'),
      L('grep-context', 'Поиск с номером и context', 'grep_context', '`grep -n` добавляет номер строки, `-i` игнорирует case, `-C` показывает соседний context. Ищите стабильный marker, а не случайный фрагмент.', 'Найдите ERROR с двумя строками context.', 'grep -n -C 2 "ERROR" /workspace/logs/app.log', ['grep --fix ERROR app.log', 'sed -i /ERROR/d app.log', 'tail --delete-errors app.log'], 'Что добавляет `grep -C 2`?', 'По две строки до и после совпадения', ['Два повторных запуска', 'Case-insensitive режим', 'Удаление дублей'], 'Context связывает error с предшествующим request и последующим outcome.'),
      L('aggregate', 'Считайте повторяемость, а не впечатления', 'log_aggregation', 'Поля можно извлечь через `awk`, затем `sort | uniq -c | sort -nr`. Это показывает доминирующую ошибку вместо ручного просмотра.', 'Посчитайте HTTP status из второго поля log.', "awk '{print $2}' /workspace/logs/access.log | sort | uniq -c | sort -nr", ['grep status | wc all', 'sort -u | rm duplicates', 'awk --network status'], 'Что проверяет pipeline `grep ERROR app.log | wc -l`?', 'Количество строк, содержащих ERROR', ['Количество байтов stderr', 'Число процессов grep', 'Количество уникальных причин'], 'Счётчик строк полезен, но для причин нужны дополнительные fields.', 'pipes-filter-errors'),
      L('evidence-report', 'Evidence и incident summary', 'incident_summary', 'Хороший summary содержит scope, наблюдаемый symptom, ключевые records и проверяемый вывод. Не переписывайте весь log и не меняйте source fixtures.', 'Сохраните строки ERROR в отдельный evidence file.', 'grep -n "ERROR" /workspace/logs/app.log > /workspace/error-evidence.txt', ['grep -n ERROR app.log > app.log', 'rm app.log after grep', 'chmod 777 /workspace/logs'], 'Почему evidence пишут в новый файл?', 'Чтобы сохранить исходный log и воспроизводимый набор фактов', ['Чтобы изменить exit code grep', 'Чтобы включить DNS', 'Чтобы обойти permissions'], 'Отдельный artifact можно проверить, передать и повторно построить.'),
    ],
  },
  {
    slug: 'networking-ii', title: 'Networking II', category: 'networking',
    description: 'Связывайте interfaces, addresses, routes, TCP/UDP sockets и bind-address с доступностью локального сервиса.',
    required: 'networking-bind-service-all-interfaces',
    optional: ['networking-keep-admin-port-loopback-only', 'networking-serve-tcp-and-udp-same-port', 'networking-complete-service-port-map'],
    lessons: [
      L('interfaces', 'Interfaces и addresses', 'network_interfaces', '`ip -brief addr` показывает interfaces и addresses компактно. Prefix длина описывает network boundary, но не гарантирует route или listener.', 'Покажите interfaces и IPv4 addresses.', 'ip -brief -4 addr', ['ifconfig --internet', 'ip route --processes', 'ss --addresses-only'], 'Что означает address с prefix `/24`?', 'Первые 24 бита задают network prefix', ['Порт 24 открыт', 'Есть 24 interfaces', 'Address доступен из Internet'], 'Address и prefix описывают local configuration, не внешний reachability.'),
      L('routes', 'Routing table и default route', 'routing_table', '`ip route` показывает, куда kernel отправит packets. Default route используется, когда нет более специфичного match.', 'Покажите текущую routing table.', 'ip route', ['route --dns-only', 'ss --routes', 'ip addr --default-process'], 'Что означает default route?', 'Маршрут для destinations без более специфичного правила', ['Address каждого listener', 'DNS server', 'Все localhost connections'], 'Сначала выбирается наиболее специфичный route.'),
      L('sockets', 'TCP, UDP и listener', 'socket_listener', 'Socket связывает protocol, local address и port. TCP LISTEN ожидает connections; UDP не имеет аналогичного connection state.', 'Покажите TCP/UDP listeners и связанные processes.', 'ss -lntup', ['ps --ports', 'ip route --listeners', 'netstat --kill-all'], 'Как показать listening TCP sockets и processes?', '`ss -lntp`', ['`ip addr -p`', '`ps -tcp`', '`curl -l`'], '`ss` связывает transport state с local endpoint и, при доступе, process.', 'networking-listen-sockets'),
      L('bind-address', 'Loopback против всех interfaces', 'bind_address', '`127.0.0.1:8080` доступен только через loopback. `0.0.0.0:8080` означает listener на всех IPv4 interfaces, но firewall и routes всё ещё имеют значение.', 'Сравните listeners конкретного порта.', "ss -lntp 'sport = :8080'", ['curl 0.0.0.0 --publish', 'ip addr --open 8080', 'chmod 8080 /proc/net'], 'Почему service на 127.0.0.1 может быть недоступен снаружи?', 'Он bind только к loopback interface', ['HTTP запрещает remote clients', 'Port меньше 9000', 'Процесс не имеет home directory'], 'Bind address определяет local interfaces, принимающие traffic.'),
    ],
  },
  {
    slug: 'http-local-services', title: 'HTTP и Local Services', category: 'networking',
    description: 'Разбирайте локальный HTTP request/response, status, headers и transport errors без внешнего Интернета.',
    required: 'networking-verify-local-http-and-save-body',
    optional: ['networking-fetch-local-status-endpoint', 'networking-publish-local-health-response', 'troubleshooting-probe-http-secure-response'],
    lessons: [
      L('request-response', 'HTTP request и response', 'http_exchange', 'HTTP работает поверх transport connection: client отправляет method, path и headers, server возвращает status, headers и body.', 'Получите локальный status endpoint с headers.', 'curl -i http://127.0.0.1:8081/status.txt', ['curl google.com', 'ss --http-body 8081', 'wget --mount status.txt'], 'Что означает status 200?', 'Server успешно обработал request по HTTP semantics', ['TCP port обязательно доступен извне', 'Body всегда непустой', 'Service запущен от root'], 'HTTP success не доказывает внешний reachability или корректность всего приложения.'),
      L('head-headers', 'Methods и headers', 'http_headers', '`curl -I` запрашивает headers через HEAD, если server поддерживает method. Заголовки описывают content, caching и другие response properties.', 'Покажите только response headers локального сервиса.', 'curl -I http://127.0.0.1:8081/status.txt', ['curl -B headers localhost', 'head http://127.0.0.1:8081', 'cat /proc/http/headers'], 'Чем HEAD обычно отличается от GET?', 'Server возвращает headers без response body', ['HEAD открывает UDP socket', 'GET не имеет status code', 'HEAD требует Internet'], 'Метод выбирается client и обрабатывается server.'),
      L('verbose', '`curl -v` разделяет transport и HTTP', 'http_diagnostics', 'Verbose output показывает resolution, connect, request и response. Это помогает отличить connection refused от HTTP 404 или 500.', 'Выполните подробный локальный probe.', 'curl -v http://127.0.0.1:8081/status.txt', ['curl -v https://github.com', 'chmod -v 8081', 'ping --http localhost'], 'Что вероятно при `Connection refused`?', 'На endpoint нет принимающего TCP listener или соединение отклонено', ['HTTP вернул 404', 'DNS всегда сломан', 'Файл body пуст'], 'Transport failure происходит до получения HTTP status.', 'networking-connection-refused'),
      L('save-verify', 'Сохраните body и проверьте результат', 'http_body_artifact', 'Флаг `-o` сохраняет body, а `--fail` делает HTTP errors ненулевым exit status. Проверяйте и command status, и artifact.', 'Сохраните body только после успешного local response.', 'curl --fail --silent http://127.0.0.1:8081/status.txt -o /workspace/response.txt', ['curl -o http://127.0.0.1:8081/status.txt', 'curl google.com > response.txt', 'echo 200 > response.txt'], 'Зачем использовать `--fail` в automation?', 'Чтобы HTTP error status приводил к ненулевому exit code', ['Чтобы открыть port', 'Чтобы отключить TLS', 'Чтобы создать DNS record'], 'Artifact должен происходить из настоящего response, а не быть подставлен вручную.'),
    ],
  },
  {
    slug: 'dns-resolution', title: 'DNS и Name Resolution', category: 'networking',
    description: 'Понимайте hostname resolution через hosts и resolver configuration, не полагаясь на Internet DNS.',
    required: 'packages-verify-iproute2-networking',
    optional: ['networking-start-port-from-config', 'networking-record-listener-readiness', 'packages-confirm-curl-client'],
    lessons: [
      L('names-addresses', 'Имя — не address', 'dns_name_address', 'Hostname должен быть преобразован в address до connection. Успешный connection по IP при ошибке по имени локализует проблему в resolution path.', 'Покажите hostname и его локальное resolution через NSS.', 'hostname; getent hosts "$(hostname)"', ['dig google.com', 'ping github.com', 'ip route --hostname'], 'Что проверить первым, если IP работает, а имя нет?', 'Name resolution: hosts, resolver config и DNS response', ['Filesystem capacity', 'Mode executable файла', 'CPU count'], 'Работающий IP отделяет transport route от name resolution.', 'troubleshooting-dns-order'),
      L('hosts', '`/etc/hosts` как локальный источник', 'hosts_file', '`/etc/hosts` задаёт статические name-to-address mappings. Порядок источников определяет `/etc/nsswitch.conf`; файл не является DNS server.', 'Найдите localhost через системный NSS API.', 'getent hosts localhost', ['curl google.com', 'cat /etc/hosts > /etc/resolv.conf', 'dns add localhost'], 'Почему `getent hosts` полезнее прямого grep hosts?', 'Он использует настроенный NSS resolution path', ['Он меняет DNS record', 'Он всегда обращается в Internet', 'Он открывает listener'], '`getent` проверяет поведение приложений, а не только один файл.'),
      L('resolver-config', 'Resolver configuration', 'resolver_configuration', '`/etc/resolv.conf` обычно задаёт nameserver и search domains для DNS resolver. В container он может управляться runtime и не должен переписываться учебной lab.', 'Без изменений покажите resolver configuration.', 'sed -n "1,20p" /etc/resolv.conf', ['echo 8.8.8.8 > /etc/resolv.conf', 'curl github.com/resolv.conf', 'chmod 777 /etc/resolv.conf'], 'Почему lab не переписывает resolv.conf?', 'Это runtime-managed system configuration, а sandbox изолирован от Internet', ['Файл не существует в Linux', 'DNS использует только ports', 'sed всегда изменяет файл'], 'Operator сначала читает effective config и избегает недетерминированного внешнего DNS.'),
      L('resolution-workflow', 'Resolution troubleshooting workflow', 'dns_workflow', 'Проверяйте точное имя, `getent`, hosts/NSS config, затем route и listener. Не смешивайте DNS failure с HTTP status.', 'Сравните resolution имени и локальный route state.', 'getent hosts localhost; ip route', ['curl google.com || chmod 777 /etc/hosts', 'rm /etc/resolv.conf', 'kill -9 all dns'], 'Получите ли вы HTTP 404 при полном DNS failure?', 'Нет, request не дойдёт до HTTP server', ['Да, DNS всегда возвращает 404', 'Да, если port занят', 'Только при root user'], 'Resolution предшествует transport connection и HTTP exchange.'),
    ],
  },
  {
    slug: 'process-port-troubleshooting', title: 'Process, Port и Service Troubleshooting', category: 'networking',
    description: 'Коррелируйте PID, process, socket и port, освобождая конфликт минимальным изменением и проверяя результат.',
    required: 'networking-free-conflicting-tcp-port',
    optional: ['process-stop-port-owner', 'networking-remove-conflict-pid-file', 'networking-recover-metrics-after-conflict'],
    lessons: [
      L('port-evidence', 'Начните с socket evidence', 'port_evidence', 'Ошибка address already in use означает конфликт bind. Сначала найдите точный listener через `ss`, не останавливайте случайные процессы.', 'Найдите listener TCP/8080.', "ss -lntp 'sport = :8080'", ['kill -9 $(pgrep -f .)', 'rm -rf /tmp', 'chmod 777 /proc/net'], 'Какой вопрос отвечает `ss -lntp`?', 'Какой TCP endpoint слушает и какой process с ним связан', ['Какой файл самый большой', 'Какая group владеет каталогом', 'Какой DNS TTL'], 'Socket evidence связывает symptom с конкретным owner.'),
      L('pid-process', 'От PID к command и parent', 'pid_correlation', 'После получения PID изучите command, parent, state и start time. Одинаковое имя не гарантирует одинаковую роль процесса.', 'Покажите PID, PPID, state и command выбранного процесса.', 'ps -p "$PID" -o pid,ppid,state,lstart,cmd', ['cat "$PID"', 'ps --port "$PID"', 'kill "$PID" --inspect'], 'Как найти PID nginx по имени?', '`pgrep nginx`', ['`grep nginx /etc/passwd`', '`ss nginx`', '`id nginx`'], '`pgrep` ищет process name, но результат всё равно нужно сопоставить с socket и command.', 'processes-find-pid'),
      L('graceful-change', 'Минимальная остановка', 'graceful_port_recovery', 'Если owner действительно stale, отправьте TERM и дождитесь освобождения port. KILL применяют только после evidence, timeout и отсутствия реакции.', 'Корректно остановите PID и дождитесь его завершения.', 'kill -TERM "$PID"; while kill -0 "$PID" 2>/dev/null; do sleep 0.1; done', ['kill -KILL "$PID"; rm -f worker.pid', 'rm -f "/proc/$PID/status"; echo stopped', 'pkill -9 -f worker; ss -lntp'], 'Почему TERM предпочтительнее KILL?', 'Процесс может очистить ресурсы и корректно завершиться', ['TERM всегда быстрее', 'KILL не существует', 'TERM меняет owner'], 'Минимальное изменение сохраняет больше evidence и меньше collateral damage.'),
      L('verify-listener', 'Проверьте port и ожидаемый service', 'listener_verification', 'Свободный port ещё не означает восстановление. Запустите ожидаемый listener, проверьте bind address и выполните protocol-level probe.', 'Проверьте listener и локальный HTTP response после восстановления.', "ss -lntp 'sport = :8080'; curl --fail http://127.0.0.1:8080/status", ['echo fixed > status', 'ss --delete-port 8080', 'curl google.com'], 'Какие две проверки подтверждают восстановление?', 'Ожидаемый listener и успешный protocol-level probe', ['Только отсутствие старого PID', 'Только новый log file', 'Только exit code kill'], 'VERIFY повторяет пользовательский путь, а не только внутренний процессный state.'),
    ],
  },
  {
    slug: 'system-troubleshooting', title: 'System Troubleshooting', category: 'troubleshooting',
    description: 'Работайте по циклу observe, evidence, hypothesis, minimal change, verify и избегайте случайных разрушительных исправлений.',
    required: 'troubleshooting-identify-failed-services',
    optional: ['troubleshooting-restore-production-config', 'troubleshooting-preserve-worker-stop-debug', 'troubleshooting-clean-partial-deploy'],
    lessons: [
      L('observe', 'OBSERVE: зафиксируйте symptom', 'observe_symptom', 'Запишите точную command, time, exit code и error text. Не меняйте систему, пока symptom не воспроизводится и scope не понятен.', 'Выполните probe и сохраните stdout/stderr с code.', 'curl -v http://127.0.0.1:8081/status >probe.out 2>probe.err; echo $? >probe.code', ['chmod -R 777 /workspace', 'kill -9 -1', 'rm -rf /tmp/*'], 'Какие первые проверки логичны для недоступного web-service?', 'Process state и свежие локальные logs', ['Переустановка OS', 'Удаление config', 'Смена всех permissions'], 'Воспроизводимый symptom создаёт baseline для последующего VERIFY.', 'troubleshooting-service-first-checks'),
      L('evidence-hypothesis', 'COLLECT и HYPOTHESIZE', 'evidence_hypothesis', 'Соберите только релевантные facts: process, socket, config, permissions, logs. Гипотеза должна предсказывать наблюдение, которое можно проверить.', 'Соберите компактный evidence bundle без изменений.', "ps -eo pid,state,cmd >evidence.ps; ss -lntup >evidence.ss; stat app.conf >evidence.stat", ['ps -ef >evidence.ps; kill -9 -1; rm evidence.ps', 'ss -lntup >evidence.ss; chmod 777 app.conf; rm evidence.ss', 'stat app.conf >evidence.stat; mv app.conf app.conf.broken'], 'Чем гипотеза отличается от догадки?', 'Она проверяема и предсказывает конкретное evidence', ['Она требует root', 'Она всегда верна', 'Она не использует logs'], 'Несколько небольших artifacts лучше бесконтрольного полного dump.'),
      L('minimal-change', 'CHANGE: исправляйте одну причину', 'minimal_change', 'Выберите изменение, напрямую связанное с подтверждённой причиной. Избегайте recursive chmod, массового kill и удаления данных без inventory.', 'Исправьте только world-write bit у config, сохранив остальные права.', 'chmod o-w app.conf', ['chmod -R 777 /workspace', 'chown -R root:root /workspace', 'rm app.conf'], 'Почему `chmod -R 777` — плохой troubleshooting shortcut?', 'Он скрывает root cause и создаёт широкую уязвимость', ['Он слишком медленно выводит logs', 'Он работает только с DNS', 'Он запрещает запись owner'], 'Минимальное изменение проще проверить и откатить.'),
      L('verify-document', 'VERIFY и короткая запись результата', 'verify_document', 'Повторите исходный probe, сравните evidence и запишите: symptom, cause, change, verification. Отсутствие error text само по себе не равно success.', 'Повторите probe и зафиксируйте итоговый code.', 'curl --fail http://127.0.0.1:8081/status -o response.txt; printf "exit=%s\n" "$?" >verification.txt', ['echo fixed > verification.txt', 'rm probe.err response.txt', 'curl google.com'], 'Что является сильным подтверждением исправления?', 'Исходный пользовательский probe проходит и ожидаемый state проверен', ['Команда исправления ничего не напечатала', 'Process получил новый PID', 'Файл стал world-writable'], 'VERIFY должен проверять исходный symptom и отсутствие опасного побочного эффекта.'),
    ],
  },
  {
    slug: 'operator-capstone', title: 'Operator Capstone', category: 'troubleshooting',
    description: 'Решайте составные incidents по symptoms: deployment, disk pressure, shared access, local service и log investigation.',
    required: 'troubleshooting-recover-oncall-runtime',
    optional: ['troubleshooting-reconcile-release-v6', 'troubleshooting-harden-exposed-deploy', 'troubleshooting-repair-analyst-access', 'troubleshooting-recover-api-endpoint'],
    lessons: [
      L('broken-deployment', 'Capstone: broken deployment', 'capstone_deployment', 'Symptom: новый release не отвечает. Проверьте `current` symlink, config permissions и listener; исправляйте только подтверждённые причины.', 'Соберите evidence о release link, config и TCP/8080.', "readlink -f current; stat -c '%a %U:%G' app.conf; ss -lntp 'sport = :8080'", ['ln -s random current; chmod -R 777 .; pkill -9 -f app', 'rm -f current app.conf; touch deployment-fixed; ss -lntp', 'chmod -R 777 releases; kill -9 -1; echo healthy'], 'Почему capstone не указывает конкретную command исправления?', 'Нужно сначала диагностировать фактическую комбинацию причин', ['Command отсутствует в Linux', 'Checker проверяет точный текст команды', 'Исправление всегда требует sudo'], 'Составной incident оценивает конечное состояние через canonical checker.'),
      L('disk-access', 'Capstone: disk pressure и deploy access', 'capstone_disk_access', 'Symptom: workspace заполнен, а deploy user не может обновить artifacts. Сохраните нужное, очистите только disposable data и восстановите group model без 777.', 'Снимите размеры и access metadata перед изменением.', "du -h --max-depth=2 /workspace | sort -h; stat -c '%a %U:%G' /workspace/releases", ['rm -rf /workspace/*', 'chmod -R 777 /workspace', 'chown -R nobody /workspace'], 'Какой mode обычно нужен приватному SSH key?', '`600`, чтобы читать и изменять key мог только owner', ['`777` для любого процесса', '`755`, чтобы key был executable', '`644`, чтобы key читали все'], 'Capacity и access — разные причины; обе требуют отдельного evidence.', 'ssh-key-permissions'),
      L('service-logs', 'Capstone: local service и logs', 'capstone_service_logs', 'Symptom: health endpoint недоступен, а в нескольких logs повторяются failures. Свяжите listener owner, request и error records, затем сформируйте summary.', 'Соберите socket и log evidence в отдельный каталог.', "mkdir -p evidence; ss -lntp >evidence/sockets.txt; grep -R -n 'ERROR' logs >evidence/errors.txt", ['kill -9 $(pgrep -f app); rm -rf logs; echo recovered', 'rm -rf evidence logs; mkdir logs; printf healthy >logs/app.log', 'curl https://example.com >evidence/remote.txt; pkill -9 -f app'], 'Как отличить port conflict от HTTP 500?', 'При conflict connection не достигает ожидаемого server, а 500 является HTTP response', ['Оба всегда DNS errors', '500 означает свободный port', 'Conflict возвращает HTTP 404'], 'Transport и application evidence нельзя смешивать в одну гипотезу.'),
      L('operator-report', 'Capstone: итоговый operator report', 'capstone_report', 'Финальный report коротко фиксирует scope, evidence, root cause, change и verification. Он не должен содержать secrets или неподтверждённые выводы.', 'Создайте структуру отчёта без копирования секретов.', "printf '%s\n' 'SCOPE:' 'EVIDENCE:' 'ROOT CAUSE:' 'CHANGE:' 'VERIFY:' > operator-report.txt", ['cat secrets.env > operator-report.txt', 'echo fixed > operator-report.txt', 'rm -rf evidence'], 'Какой признак отличает хороший operator report?', 'Каждый вывод связан с сохранённым evidence и проверкой', ['Он максимально длинный', 'Он содержит все environment variables', 'Он скрывает выполненное изменение'], 'Capstone завершается проверяемым final state и воспроизводимой записью решения.'),
    ],
  },
];

const answers = ['a', 'b', 'c', 'd'];
const reused = new Set(modules.flatMap((module) => module.lessons.map((entry) => entry.existing).filter(Boolean)));

function rotate(seed, values) {
  const offset = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0) % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function question(slug, category, concept, prompt, correct, wrong, explanation, difficulty = 'medium') {
  const options = rotate(slug, [correct, ...wrong]);
  return {
    slug, category, concept, difficulty, type: 'scenario', question: prompt,
    answers: options.map((text, index) => ({ id: answers[index], text })),
    correctAnswerIds: [answers[options.indexOf(correct)]], explanation,
    answerExplanations: Object.fromEntries(options.map((text, index) => [answers[index], text === correct
      ? explanation
      : `Вариант «${text}» не подтверждает нужное состояние или создаёт лишний риск в этом сценарии.`])),
    enabled: true, version: 1,
  };
}

function buildQuestions() {
  const output = [];
  for (const module of modules) module.lessons.forEach((entry, index) => {
    entry.commandSlug = `operator-${module.slug}-${entry.slug}-action`;
    output.push(question(entry.commandSlug, module.category, entry.concept,
      `Operator-сценарий «${entry.title}»: ${entry.action} Какое действие подходит?`, entry.command, entry.wrong,
      `${entry.note} Поэтому безопасный следующий шаг: ${entry.command}.`));
    entry.checkSlug = entry.existing ?? `operator-${module.slug}-${entry.slug}-concept`;
    if (!entry.existing) output.push(question(entry.checkSlug, module.category, entry.concept,
      entry.checkQuestion, entry.checkAnswer, entry.checkWrong, `${entry.note} ${entry.checkAnswer}.`));
    if (index < 3) {
      entry.checkpointSlug = `operator-${module.slug}-checkpoint-${index + 1}`;
      output.push(question(entry.checkpointSlug, module.category, `${entry.concept}_checkpoint`,
        `Checkpoint «${module.title}»: ${entry.action} Какой вариант лучше всего сохраняет evidence и приводит к проверяемому результату?`,
        entry.command, entry.wrong, `${entry.note} Команда соответствует минимальному проверяемому действию.`,
        module.slug === 'operator-capstone' ? 'hard' : 'medium'));
    }
  });
  return output;
}

function buildModule(module, index) {
  const items = [];
  module.lessons.forEach((entry, lessonIndex) => {
    items.push({
      id: `operator-${module.slug}-${entry.slug}-lesson`, slug: entry.slug, title: entry.title, type: 'theory',
      order: lessonIndex * 2 + 1, category: module.category, concept: entry.concept, version: 1,
      content: [
        { type: 'heading', text: entry.title },
        { type: 'paragraph', text: entry.intro },
        { type: 'code', language: 'bash', code: entry.command },
        { type: 'bullets', items: [`Цель: ${entry.action}`, `Проверка: ${entry.note}`] },
        { type: 'note', tone: entry.wrong.some((value) => /777|kill -9|rm -rf|google|github/iu.test(value)) ? 'warning' : 'note', text: entry.note },
      ],
      completion: { explicitContinue: true },
    });
    items.push({
      id: `operator-${module.slug}-${entry.slug}-quiz`, slug: `${entry.slug}-quiz`, title: `Operator check: ${entry.title}`,
      type: 'knowledge_check', order: lessonIndex * 2 + 2, category: module.category, concept: entry.concept, version: 1,
      questionSlugs: [entry.commandSlug, entry.checkSlug], completion: { passThreshold: 50 },
    });
  });
  items.push({
    id: `operator-${module.slug}-optional-practice`, slug: 'optional-practice', title: module.slug === 'operator-capstone' ? 'Дополнительные capstone incidents' : 'Дополнительная Operator Practice',
    type: 'practice', order: 9, category: module.category, concept: `${module.slug.replaceAll('-', '_')}_optional`, version: 1,
    challengeSlugs: module.optional, completion: { requireAll: true, optional: true },
  });
  items.push({
    id: `operator-${module.slug}-required-lab`, slug: 'required-lab', title: module.slug === 'operator-capstone' ? 'Финальный Operator incident' : 'Обязательный Operator checkpoint',
    type: 'shell_lab', order: 10, category: module.category, concept: `${module.slug.replaceAll('-', '_')}_practice`, version: 1,
    challengeSlugs: [module.required], completion: { requireAll: true },
  });
  items.push({
    id: `operator-${module.slug}-checkpoint`, slug: 'checkpoint', title: `Checkpoint: ${module.title}`, type: 'checkpoint',
    order: 11, category: module.category, concept: `${module.slug.replaceAll('-', '_')}_checkpoint`, version: 1,
    questionSlugs: module.lessons.slice(0, 3).map((entry) => entry.checkpointSlug), completion: { passThreshold: 67 },
  });
  return {
    slug: module.slug, title: module.title, description: module.description, order: index,
    prerequisites: index === 1 ? [] : [modules[index - 2].slug], estimatedMinutes: index === 14 ? 55 : 40,
    version: 1, completion: { allItemsRequired: true }, items,
  };
}

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
async function emit(relative, value) {
  const target = resolve(root, relative);
  const output = json(value);
  if (checkOnly) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== output) throw new Error(`Generated content is stale: ${relative}`);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output, 'utf8');
  }
}

const questions = buildQuestions();
const questionRefs = modules.flatMap((module) => module.lessons.flatMap((entry) => [entry.commandSlug, entry.checkSlug])
  .concat(module.lessons.slice(0, 3).map((entry) => entry.checkpointSlug)));
const challengeRefs = modules.flatMap((module) => [module.required, ...module.optional]);
if (modules.length !== 14 || modules.some((module) => module.lessons.length !== 4)) throw new Error('Linux Operator requires 14 modules with four lessons each.');
if (questions.length !== 137 || reused.size !== 17 || questionRefs.length !== 154 || new Set(questionRefs).size !== 154) {
  throw new Error(`Unexpected Linux Operator question totals: generated=${questions.length}, reused=${reused.size}, refs=${questionRefs.length}, unique=${new Set(questionRefs).size}.`);
}
if (challengeRefs.length !== 57 || new Set(challengeRefs).size !== 57) throw new Error('Linux Operator requires 57 unique canonical challenge references.');

const filenames = modules.map((module, index) => `${String(index + 1).padStart(2, '0')}-${module.slug}.json`);
await emit('content/linux-core/linux-operator.json', questions);
await emit('content/learning-paths/linux-operator/course.json', {
  slug: 'linux-operator', title: 'Linux Operator',
  description: 'Научитесь исследовать Linux-систему, работать с процессами, диском, shell, сетевыми состояниями и разбирать типовые неисправности.',
  version: 1, enabled: true, order: 1, estimatedMinutes: 575, level: 'intermediate', canonicalChallengeLibrary: 2,
  prerequisites: ['linux-zero-to-operator'], modules: filenames,
});
for (let index = 0; index < modules.length; index += 1) {
  await emit(`content/learning-paths/linux-operator/modules/${filenames[index]}`, buildModule(modules[index], index + 1));
}

console.log(JSON.stringify({
  ok: true, mode: checkOnly ? 'check' : 'write', modules: 14, lessons: 56,
  generatedQuestions: questions.length, reusedQuestions: reused.size, totalQuestions: questionRefs.length,
  requiredPractice: 14, optionalPractice: 43, uniqueCanonicalChallenges: new Set(challengeRefs).size, newChallenges: 0,
}, null, 2));
